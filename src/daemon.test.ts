/**
 * The daemon manager: unit generation asserted byte-for-byte where it
 * matters, supervisor calls scripted — no test touches the machine's real
 * launchd or systemd. The lifecycle contract (OS containment and login
 * recovery plan): restart after clean exit and crash, idempotent start,
 * real reload of a changed definition, explicit stop disables, and status
 * that tells a loaded definition from a working controller.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitFreshHeartbeat,
  daemonLaunchCommand,
  daemonStatus,
  definitionDigest,
  installDaemon,
  installLaunchdService,
  installReplacingLegacy,
  installedLegacyDaemon,
  labelFor,
  legacyLabelFor,
  planDaemon,
  planDesktopService,
  runtimeProblems,
  stopLaunchdService,
  uninstallDaemon,
  type DaemonPlan,
} from "./daemon.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import { fakePid } from "../test/fake-pid.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const uid = typeof process.getuid === "function" ? process.getuid() : 501;
const servicePid = fakePid(1);

function scripted(answers: Record<string, { code?: number; stdout?: string }> = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const run = async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] });
    const key = `${file} ${args.join(" ")}`;
    const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    return { ...OK, ...(match?.[1] ?? {}) };
  };
  return { run, calls };
}

const loadedDigest = (unit: string) => `STANDING_ORDERS_SERVICE_DIGEST => ${/<key>STANDING_ORDERS_SERVICE_DIGEST<\/key>\s*<string>([a-f0-9]{64})/.exec(unit)?.[1]}\n`;

const portablePath = (path: string): string => path.replaceAll("\\", "/");

/** POSIX mode bits are not an access-control assertion on Windows. */
function expectPrivateMode(path: string): void {
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
}

describe("the daemon plan", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-daemon-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (platform: NodeJS.Platform = "darwin", watchFlags: readonly string[] = ["--tick-every", "60000"]): DaemonPlan => {
    const made = planDaemon({
      platform,
      bin: process.execPath,
      binArgs: [],
      runner: "builder-1",
      repo: "/Users/alex/code/thing",
      configDir: dir,
      watchFlags,
      home: dir,
      pathEnv: "/Users/alex/.local/bin:/usr/local/bin:/usr/bin:/bin",
    });
    if ("error" in made) throw new Error(made.error);
    return made;
  };

  test("labels are one per repo, and never collide on punctuation", () => {
    expect(labelFor("/Users/alex/code/thing")).toBe("com.toolroll.watch.users-alex-code-thing");
    expect(labelFor("/Users/alex/code thing!")).not.toContain(" ");
    expect(labelFor("/a")).not.toBe(labelFor("/b"));
  });

  test("the launchd unit runs watch with a token file — never the token — and is kept alive after ANY exit", () => {
    const made = plan("darwin");

    expect(portablePath(made.unitPath)).toContain("Library/LaunchAgents");
    expect(made.unitContent).toContain("<string>watch</string>");
    expect(made.unitContent).toContain("<key>WorkingDirectory</key>");
    expect(made.unitContent).toContain("<string>/Users/alex/code/thing</string>");
    expect(made.unitContent).toContain("<string>--token-file</string>");
    expect(made.unitContent).toContain("<key>EnvironmentVariables</key>");
    expect(made.unitContent).toContain("/Users/alex/.local/bin:/usr/local/bin:/usr/bin:/bin");
    expect(made.unitContent).toContain(join(dir, "runner-token"));
    expect(made.unitContent).not.toContain("--token<");
    // Always-on: an unexpected clean exit is relaunched like a crash. Only
    // an explicit bootout/disable keeps it down.
    expect(made.unitContent).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(made.unitContent).not.toContain("<key>SuccessfulExit</key>");
    expect(made.unitContent).not.toContain("<key>Crashed</key>");
    expect(made.unitContent).toContain("<key>ThrottleInterval</key>");
    expect(made.unitContent).toContain("<key>ExitTimeOut</key>");
  });

  test("the containment policy rides the baked watch flags like any other", () => {
    const made = plan("darwin", ["--containment", "required"]);
    expect(made.unitContent).toContain("<string>--containment</string>\n    <string>required</string>");
  });

  test("the service pins the current Node runtime instead of relying on env node", () => {
    expect(daemonLaunchCommand({
      execPath: "/Users/alex/.nvm/versions/node/v22/bin/node",
      entry: "/opt/standing-orders/dist/bin.js",
    })).toEqual({
      bin: "/Users/alex/.nvm/versions/node/v22/bin/node",
      binArgs: ["/opt/standing-orders/dist/bin.js"],
    });
    expect(daemonLaunchCommand({
      execPath: "/usr/local/bin/node",
      explicitBin: "/opt/standing-orders/dist/bin.js",
    })).toEqual({
      bin: "/usr/local/bin/node",
      binArgs: ["/opt/standing-orders/dist/bin.js"],
    });
    expect(daemonLaunchCommand({
      execPath: "/usr/local/bin/node",
      explicitBin: "/opt/standing-orders/native-wrapper",
    })).toEqual({ bin: "/opt/standing-orders/native-wrapper", binArgs: [] });
  });

  test("the systemd unit restarts always and appends to its log", () => {
    const made = plan("linux");

    expect(portablePath(made.unitPath)).toContain(".config/systemd/user");
    expect(made.unitContent).toContain("Restart=always");
    expect(made.unitContent).not.toContain("Restart=on-failure");
    expect(made.unitContent).toContain("WorkingDirectory=/Users/alex/code/thing");
    expect(made.unitContent).toContain("Environment=PATH=/Users/alex/.local/bin:/usr/local/bin:/usr/bin:/bin");
    expect(made.unitContent).toContain("--token-file");
    expect(made.unitContent).toContain(`append:${made.logPath}`);
  });

  test("an unsupported platform refuses with instructions, not a broken unit", () => {
    const made = planDaemon({
      platform: "freebsd",
      bin: "x",
      binArgs: [],
      runner: "r",
      repo: "/r",
      configDir: dir,
      watchFlags: [],
    });
    expect("error" in made).toBe(true);
  });

  test("a fresh install writes the token 0600 and the unit, enables the label, bootstraps, and kickstarts without -k", async () => {
    const made = plan("darwin");
    const script = scripted({ "launchctl print": { code: 113 }, launchctl: { code: 0 } });

    const installed = await installDaemon(made, "secret-token", script.run);

    expect(installed).toMatchObject({ ok: true, changed: true, action: "bootstrapped" });
    expectPrivateMode(made.tokenFile);
    expect(readFileSync(made.tokenFile, "utf8").trim()).toBe("secret-token");
    expect(readFileSync(made.unitPath, "utf8")).toContain("watch");
    expect(script.calls.map(call => call.args[0])).toEqual(["print", "enable", "bootstrap", "kickstart"]);
    expect(script.calls[3]?.args).toEqual(["kickstart", `gui/${uid}/${made.label}`]);
  });

  test("a healthy running service under an unchanged definition is started idempotently — never booted out or restarted", async () => {
    const made = plan("darwin");
    const first = scripted({ "launchctl print": { code: 113 }, launchctl: { code: 0 } });
    await installDaemon(made, "secret-token", first.run);

    const again = scripted({ "launchctl print": { code: 0, stdout: `state = running\n\tpid = ${servicePid}\n` + loadedDigest(made.unitContent) }, launchctl: { code: 0 } });
    const installed = await installDaemon(made, "secret-token", again.run);

    expect(installed).toMatchObject({ ok: true, changed: false, action: "started" });
    expect(again.calls.map(call => call.args[0])).toEqual(["print", "kickstart"]);
    expect(again.calls[1]?.args).not.toContain("-k");
  });

  test("a CHANGED definition really reloads: bootout, wait for the label to vanish, enable, bootstrap", async () => {
    const made = plan("darwin");
    const first = scripted({ "launchctl print": { code: 113 }, launchctl: { code: 0 } });
    await installDaemon(made, "secret-token", first.run);

    const changed = plan("darwin", ["--tick-every", "30000"]);
    const calls: string[] = [];
    let prints = 0;
    const run = async (_file: string, args: readonly string[]) => {
      calls.push(args[0] as string);
      if (args[0] === "print") {
        prints += 1;
        // Loaded at first; gone only on the third look after the bootout.
        return { ...OK, code: prints === 1 || prints < 4 ? 0 : 113 };
      }
      return OK;
    };

    expect(await installDaemon(changed, "secret-token", run)).toMatchObject({ ok: true, changed: true, action: "reloaded" });
    expect(calls).toEqual(["print", "bootout", "print", "print", "print", "enable", "bootstrap", "kickstart"]);
    expect(readFileSync(changed.unitPath, "utf8")).toContain("30000");
  });

  test("a failed reload cannot make the new disk file masquerade as the loaded generation on retry", async () => {
    const old = plan("darwin");
    const next = plan("darwin", ["--tick-every", "30000"]);
    await installDaemon(old, "t", scripted({ "launchctl print": { code: 113 } }).run);
    const refused = scripted({ "launchctl print": { code: 0, stdout: loadedDigest(old.unitContent) }, "launchctl bootout": { code: 5 } });
    expect(await installLaunchdService(next, refused.run)).toMatchObject({ ok: false });
    expect(readFileSync(next.unitPath, "utf8")).toBe(next.unitContent);
    let loaded = true;
    const calls: string[] = [];
    const retried = await installLaunchdService(next, async (_file, args) => {
      calls.push(args[0]!);
      if (args[0] === "print") return { ...OK, code: loaded ? 0 : 113, stdout: loadedDigest(old.unitContent) };
      if (args[0] === "bootout") loaded = false;
      return OK;
    });
    expect(retried).toMatchObject({ ok: true, changed: true, action: "reloaded" });
    expect(calls).toContain("bootout");
  });

  test("failed explicit disable is reported and does not remove the installed unit", async () => {
    const made = plan("darwin");
    await installDaemon(made, "t", scripted({ "launchctl print": { code: 113 } }).run);
    const script = scripted({ "launchctl disable": { code: 5 } });
    expect(await stopLaunchdService(made, script.run)).toMatchObject({ ok: false });
    await expect(uninstallDaemon(made, script.run)).rejects.toThrow(/disable/);
    expect(readFileSync(made.unitPath, "utf8")).toBe(made.unitContent);
  });

  test("modern launchctl failing falls back to the legacy verb", async () => {
    const made = plan("darwin");
    const script = scripted({
      "launchctl print": { code: 113 },
      "launchctl bootstrap": { code: 1 },
      "launchctl load": { code: 0 },
    });

    const installed = await installDaemon(made, "secret-token", script.run);

    expect(installed).toMatchObject({ ok: true });
    expect(script.calls.map(call => call.args[0])).toEqual(["print", "enable", "bootstrap", "load"]);
  });

  test("a loaded plist is not reported as started when kickstart fails", async () => {
    const made = plan("darwin");
    const script = scripted({
      "launchctl print": { code: 113 },
      "launchctl bootstrap": { code: 0 },
      "launchctl kickstart": { code: 5 },
    });

    const installed = await installDaemon(made, "secret-token", script.run);

    expect(installed).toMatchObject({ ok: false });
    if (installed.ok) throw new Error("expected a refusal");
    expect(installed.message).toContain("could not start");
  });

  test("status reads launchd's answer into running / loaded / disabled / not-installed", async () => {
    const made = plan("darwin");

    const running = scripted({ "launchctl print gui": { code: 0, stdout: `state = running\n\tpid = ${servicePid}\n` } });
    expect(await daemonStatus(made, running.run)).toMatchObject({ state: "running", pid: servicePid, problems: [] });

    const loaded = scripted({ "launchctl print gui": { code: 0, stdout: "state = waiting\n" } });
    expect(await daemonStatus(made, loaded.run)).toMatchObject({ state: "loaded", pid: null });

    const disabled = scripted({ "launchctl print gui": { code: 113 }, "launchctl print-disabled": { code: 0, stdout: `disabled services = {\n\t"${made.label}" => disabled\n\t"com.other" => enabled\n}\n` } });
    expect(await daemonStatus(made, disabled.run)).toMatchObject({ state: "disabled" });

    const missing = scripted({ "launchctl print gui": { code: 113 }, "launchctl print-disabled": { code: 0, stdout: `disabled services = {\n\t"com.other" => disabled\n}\n` } });
    expect(await daemonStatus(made, missing.run)).toMatchObject({ state: "not-installed" });
  });

  test("status names a missing runtime or entry, and a stale installed definition", async () => {
    const made = planDaemon({
      platform: "darwin",
      bin: join(dir, "no-such-node"),
      binArgs: [join(dir, "no-such-entry.js")],
      runner: "builder-1",
      repo: "/Users/alex/code/thing",
      configDir: dir,
      watchFlags: [],
      home: dir,
      pathEnv: "/usr/bin",
    });
    if ("error" in made) throw new Error(made.error);
    expect(runtimeProblems(made)).toEqual([
      expect.stringContaining("runtime"),
      expect.stringContaining("entry"),
    ]);
    // A previously installed unit that no longer matches this build's is stale.
    const loaded = scripted({ "launchctl print gui": { code: 0, stdout: `state = running\n\tpid = ${servicePid}\n` + loadedDigest(made.unitContent) } });
    const fresh = await daemonStatus(made, loaded.run);
    expect(fresh).toMatchObject({ state: "running", installedDigest: null, stale: false });
    expect(fresh.problems).toHaveLength(2);

    const script = scripted({ "launchctl print": { code: 113 }, launchctl: { code: 0 } });
    await installDaemon(made, "t", script.run);
    expect((await daemonStatus(made, loaded.run))).toMatchObject({ installedDigest: definitionDigest(made.unitContent), stale: false });
    const oldGeneration = scripted({ "launchctl print gui": { code: 0, stdout: `state = running\n\tpid = ${servicePid}\n` } });
    expect((await daemonStatus(made, oldGeneration.run))).toMatchObject({ state: "running", stale: true });
    const wrongGeneration = scripted({ "launchctl print gui": { code: 0, stdout: `state = running\n\tpid = ${servicePid}\nSTANDING_ORDERS_SERVICE_DIGEST => ` + "0".repeat(64) } });
    expect((await daemonStatus(made, wrongGeneration.run))).toMatchObject({ state: "running", stale: true });
    writeFileSync(made.unitPath, made.unitContent.replace("watch", "watch-old"));
    expect((await daemonStatus(made, loaded.run))).toMatchObject({ stale: true });
  });

  test("explicit stop boots the service out AND disables it; uninstall also removes the unit", async () => {
    const made = plan("darwin");
    const script = scripted({ "launchctl print": { code: 113 }, launchctl: { code: 0 } });
    await installDaemon(made, "secret-token", script.run);
    script.calls.length = 0;

    const stopped = await stopLaunchdService(made, script.run);
    expect(stopped).toMatchObject({ ok: true, wasLoaded: true });
    expect(script.calls.map(call => call.args.slice(0, 2).join(" "))).toEqual([`disable gui/${uid}/${made.label}`, `bootout gui/${uid}/${made.label}`, `print gui/${uid}/${made.label}`]);

    script.calls.length = 0;
    const removed = await uninstallDaemon(made, script.run);
    expect(removed).toMatchObject({ ok: true, existed: true });
    expect(script.calls.map(call => call.args[0])).toEqual(["disable", "bootout", "print"]);
    expect(() => statSync(made.unitPath)).toThrow();
    // The token file survives — it is the database's neighbor, not the unit's.
    expectPrivateMode(made.tokenFile);
  });

  test("a watch installed under the label from before the rename is found, stopped and uninstalled", async () => {
    const args = { platform: "darwin" as const, bin: process.execPath, binArgs: [], runner: "builder-1", repo: "/Users/alex/code/thing", configDir: dir, watchFlags: [], home: dir, pathEnv: "/usr/bin" };
    expect(labelFor(args.repo)).toBe("com.toolroll.watch.users-alex-code-thing");
    expect(installedLegacyDaemon(args)).toBeNull();
    // What an install before the rename left on disk.
    const old = planDaemon({ ...args, label: legacyLabelFor(args.repo) });
    if ("error" in old) throw new Error(old.error);
    const setup = scripted({ "launchctl print": { code: 113 }, launchctl: { code: 0 } });
    await installDaemon(old, "t", setup.run);

    const found = installedLegacyDaemon(args);
    expect(found).toMatchObject({ label: "com.standing-orders.watch.users-alex-code-thing", unitPath: old.unitPath });
    const script = scripted({ "launchctl print": { code: 113 }, launchctl: { code: 0 } });
    expect(await uninstallDaemon(found!, script.run)).toMatchObject({ ok: true, existed: true });
    expect(script.calls.map(call => call.args.slice(0, 2).join(" "))).toEqual([`disable gui/${uid}/${old.label}`, `bootout gui/${uid}/${old.label}`, `print gui/${uid}/${old.label}`]);
    expect(installedLegacyDaemon(args)).toBeNull();
  });

  test("replacing the watch from before the rename installs the new job first; a failed install leaves the legacy watch running", async () => {
    const args = { platform: "darwin" as const, bin: process.execPath, binArgs: [], runner: "builder-1", repo: "/Users/alex/code/thing", configDir: dir, watchFlags: [], home: dir, pathEnv: "/usr/bin" };
    const old = planDaemon({ ...args, label: legacyLabelFor(args.repo) });
    const next = planDaemon(args);
    if ("error" in old || "error" in next) throw new Error("plan failed");
    await installDaemon(old, "t", scripted({ "launchctl print": { code: 113 }, launchctl: { code: 0 } }).run);
    const legacy = installedLegacyDaemon(args)!;
    const touchesLegacy = (calls: { args: string[] }[]) => calls.some(call => call.args.some(arg => arg.includes(old.label)));

    // launchd refuses the new unit: the legacy job is neither stopped nor removed.
    const refused = scripted({ "launchctl print": { code: 113 }, "launchctl bootstrap": { code: 5 }, "launchctl load": { code: 1 }, launchctl: { code: 0 } });
    expect(await installReplacingLegacy(next, "t", legacy, refused.run)).toMatchObject({ ok: false });
    expect(touchesLegacy(refused.calls)).toBe(false);
    expect(installedLegacyDaemon(args)).not.toBeNull();

    // The new job installs: only then is the legacy one stopped and removed, and the new one started again.
    const accepted = scripted({ "launchctl print": { code: 113 }, launchctl: { code: 0 } });
    expect(await installReplacingLegacy(next, "t", legacy, accepted.run)).toMatchObject({ ok: true });
    const steps = accepted.calls.map(call => call.args.slice(0, 2).join(" "));
    const firstStart = steps.indexOf(`kickstart gui/${uid}/${next.label}`);
    expect(firstStart).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(`bootout gui/${uid}/${old.label}`)).toBeGreaterThan(firstStart);
    expect(steps.lastIndexOf(`kickstart gui/${uid}/${next.label}`)).toBeGreaterThan(steps.indexOf(`bootout gui/${uid}/${old.label}`));
    expect(installedLegacyDaemon(args)).toBeNull();
  });

  test("a loaded job reporting the service digest under either name is the current generation", async () => {
    const made = plan("darwin");
    const digest = /<key>TOOLROLL_SERVICE_DIGEST<\/key>\s*<string>([a-f0-9]{64})/.exec(made.unitContent)?.[1];
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(made.unitContent).toContain(`<key>STANDING_ORDERS_SERVICE_DIGEST</key>\n    <string>${digest}</string>`);
    for (const name of ["TOOLROLL", "STANDING_ORDERS"]) {
      const loaded = scripted({ "launchctl print gui": { code: 0, stdout: `state = running\n\tpid = ${servicePid}\n${name}_SERVICE_DIGEST => ${digest}\n` } });
      expect(await daemonStatus(made, loaded.run)).toMatchObject({ state: "running", stale: false });
    }
  });

  test("the desktop service shares the launchd contract: same generator, KeepAlive=true, private log, pinned runtime", () => {
    const desktop = planDesktopService({ node: "/opt/node/bin/node", helper: "/Applications/Standing Orders.app/Contents/Resources/dist/desktop-host.js", stateDir: dir, label: "com.standing-orders.desktop", home: dir, pathEnv: "/opt/node/bin:/usr/bin" });
    expect(desktop.unitContent).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(desktop.unitContent).toContain("<string>serve</string>");
    expect(desktop.unitContent).toContain("<key>AssociatedBundleIdentifiers</key>\n  <array><string>com.standing-orders.desktop</string></array>");
    expect(desktop.unitContent).toContain("<string>--state</string>");
    expect(desktop.unitContent).toContain(`<string>${dir}</string>`);
    expect(desktop.logPath).toBe(join(dir, "service.log"));
    expect(desktop.bin).toBe("/opt/node/bin/node");
    expect(desktop.entry).toContain("desktop-host.js");
    expect(portablePath(desktop.unitPath)).toContain("Library/LaunchAgents/com.standing-orders.desktop.plist");
    // The CLI daemon's plist is the same document shape.
    const cli = plan("darwin");
    expect(cli.unitContent).not.toContain("AssociatedBundleIdentifiers");
    for (const key of ["RunAtLoad", "KeepAlive", "ThrottleInterval", "ExitTimeOut", "StandardOutPath"]) {
      expect(desktop.unitContent).toContain(`<key>${key}</key>`);
      expect(cli.unitContent).toContain(`<key>${key}</key>`);
    }
  });

  test("preview service attribution is separate from release and included in the reload digest", () => {
    const args = { node:process.execPath,helper:"/x/desktop-host.js",stateDir:dir,label:"preview",home:dir };
    const production = planDesktopService(args);
    const preview = planDesktopService({...args,associatedBundleId:"com.standing-orders.desktop.development"});
    expect(preview.unitContent).toContain("<string>com.standing-orders.desktop.development</string>");
    expect(loadedDigest(preview.unitContent)).not.toBe(loadedDigest(production.unitContent));
    expect(() => planDesktopService({...args,associatedBundleId:'invalid</string>'})).toThrow(/bundle identifier/);
  });

  test("the shared launchd road is the desktop's start: idempotent on a running unchanged definition", async () => {
    const desktop = planDesktopService({ node: process.execPath, helper: "/x/desktop-host.js", stateDir: dir, label: "com.standing-orders.desktop.preview.abc", home: dir, pathEnv: "/usr/bin" });
    const first = scripted({ "launchctl print": { code: 113 }, launchctl: { code: 0 } });
    expect(await installLaunchdService(desktop, first.run)).toMatchObject({ ok: true, action: "bootstrapped" });
    const again = scripted({ "launchctl print": { code: 0, stdout: `pid = ${servicePid}\n` + loadedDigest(desktop.unitContent) }, launchctl: { code: 0 } });
    expect(await installLaunchdService(desktop, again.run)).toMatchObject({ ok: true, action: "started", changed: false });
    expect(again.calls.map(call => call.args[0])).toEqual(["print", "kickstart"]);
  });

  test("the fresh-heartbeat verification refuses a stale row and accepts only a newer live beat", async () => {
    const store = openStore(":memory:");
    try {
      const t0 = new Date(Date.now() - 60_000);
      register(store, { name: "builder-1", host: "h", capacity: 1, repos: ["/r"], now: t0 });
      const before = store.getRunner("builder-1")!.runner.heartbeatAt;
      const beats: number[] = [];
      const sleep = async (): Promise<void> => { beats.push(1); if (beats.length === 2) store.touchRunner("builder-1", new Date()); };
      // The stale beat from before the start never passes on its own…
      expect(await awaitFreshHeartbeat(store, "builder-1", before, 50, async () => { await new Promise(resolve => setTimeout(resolve, 20)); })).toEqual({ ok: false });
      // …a fresh one does.
      const fresh = await awaitFreshHeartbeat(store, "builder-1", before, 5_000, sleep);
      expect(fresh.ok).toBe(true);
      expect(beats.length).toBe(2);
      // A running service left alone passes on the beat it already has, as long as it is live.
      expect((await awaitFreshHeartbeat(store, "builder-1", null, 50)).ok).toBe(true);
      // An unknown runner never passes.
      expect(await awaitFreshHeartbeat(store, "nobody", null, 50, async () => {})).toEqual({ ok: false });
    } finally {
      store.close();
    }
  });
});

describe("the daemon on linux", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "standing-orders-daemon-linux-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (watchFlags: readonly string[] = []): DaemonPlan => {
    const made = planDaemon({ platform: "linux", bin: process.execPath, binArgs: [], runner: "builder-1", repo: "/home/alex/thing", configDir: dir, watchFlags, home: dir, pathEnv: "/usr/bin" });
    if ("error" in made) throw new Error(made.error);
    return made;
  };

  test("install reloads units and enables --now; an active service under a CHANGED definition is restarted, an unchanged one left alone", async () => {
    const made = plan();
    const first = scripted({ "systemctl --user is-active": { code: 3, stdout: "inactive\n" }, systemctl: { code: 0 } });
    expect(await installDaemon(made, "t", first.run)).toMatchObject({ ok: true, action: "started" });
    expect(first.calls.map(call => call.args[1])).toEqual(["daemon-reload", "is-active", "enable"]);
    expect(first.calls[2]?.args).toEqual(["--user", "enable", "--now", made.label]);

    const same = scripted({ "systemctl --user is-active": { code: 0, stdout: "active\n" }, systemctl: { code: 0 } });
    expect(await installDaemon(made, "t", same.run)).toMatchObject({ ok: true, action: "running", changed: false });
    expect(same.calls.map(call => call.args[1])).toEqual(["daemon-reload", "is-active", "enable"]);

    const changed = plan(["--tick-every", "5000"]);
    const reload = scripted({ "systemctl --user is-active": { code: 0, stdout: "active\n" }, systemctl: { code: 0 } });
    expect(await installDaemon(changed, "t", reload.run)).toMatchObject({ ok: true, action: "reloaded", changed: true });
    expect(reload.calls.map(call => call.args[1])).toEqual(["daemon-reload", "is-active", "restart", "enable"]);
  });

  test("status distinguishes disabled from loaded-but-inactive and not-installed", async () => {
    const made = plan();
    const disabled = scripted({ "systemctl --user is-active": { code: 3, stdout: "inactive\n" }, "systemctl --user is-enabled": { code: 1, stdout: "disabled\n" } });
    expect(await daemonStatus(made, disabled.run)).toMatchObject({ state: "disabled" });
    const loaded = scripted({ "systemctl --user is-active": { code: 3, stdout: "inactive\n" }, "systemctl --user is-enabled": { code: 0, stdout: "enabled\n" } });
    expect(await daemonStatus(made, loaded.run)).toMatchObject({ state: "loaded" });
    const missing = scripted({ "systemctl --user is-active": { code: 4, stdout: "inactive\n" }, "systemctl --user is-enabled": { code: 1, stdout: "" } });
    expect(await daemonStatus(made, missing.run)).toMatchObject({ state: "not-installed" });
    const running = scripted({ "systemctl --user is-active": { code: 0, stdout: "active\n" }, "systemctl --user show": { code: 0, stdout: `MainPID=${servicePid}\n` } });
    expect(await daemonStatus(made, running.run)).toMatchObject({ state: "running", pid: servicePid });
  });
});

describe("the daemon on windows", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-daemon-win-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (watchFlags: readonly string[] = []): DaemonPlan => {
    const made = planDaemon({
      platform: "win32",
      bin: "C:\\Users\\alex\\AppData\\Roaming\\npm\\standing-orders.cmd",
      binArgs: [],
      runner: "builder-1",
      repo: "C:\\code\\thing",
      configDir: dir,
      watchFlags,
      home: dir,
      pathEnv: "C:\\Users\\alex\\AppData\\Roaming\\npm;C:\\Windows\\System32",
    });
    if ("error" in made) throw new Error(made.error);
    return made;
  };

  test("the scheduled task restarts on failure, loops after a clean exit, logs, and never carries the token", () => {
    const made = plan();

    expect(made.unitContent).toContain("<LogonTrigger>");
    expect(made.unitContent).toContain("<RestartOnFailure>");
    expect(made.unitContent).toContain("StartWhenAvailable");
    // One instance at a time: the scheduler's own watch-busy.
    expect(made.unitContent).toContain("IgnoreNew");
    // The action funnels output into the shared log file via cmd, inside a
    // restart loop: Task Scheduler alone would leave a clean exit down.
    expect(made.unitContent).toContain("cmd.exe");
    expect(made.unitContent).toContain("for /L %i in (1,0,2) do (");
    expect(made.unitContent).toContain("timeout /t 15 /nobreak");
    expect(made.unitContent).toContain("PATH=C:\\Users\\alex\\AppData\\Roaming\\npm;C:\\Windows\\System32;%PATH%");
    expect(made.unitContent).toContain("--token-file");
    expect(made.unitContent).not.toContain("--token ");
    // No wall-clock kill: watch is supposed to run forever.
    expect(made.unitContent).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  });

  test("install creates the task from its XML and starts it now; a running task is left alone unless its definition changed", async () => {
    const made = plan();
    const script = scripted({ "schtasks /Query": { code: 1 }, schtasks: { code: 0 } });

    const installed = await installDaemon(made, "secret-token", script.run);

    expect(installed).toMatchObject({ ok: true, action: "started" });
    expect(readFileSync(made.tokenFile, "utf8").trim()).toBe("secret-token");
    expect(script.calls.map(call => call.args[0])).toEqual(["/Create", "/Query", "/Run"]);
    expect(script.calls[0]?.args).toContain("/XML");
    expect(script.calls[0]?.args).toContain("/F");

    const same = scripted({ "schtasks /Query": { code: 0, stdout: "Status:  Running\n" }, schtasks: { code: 0 } });
    expect(await installDaemon(made, "secret-token", same.run)).toMatchObject({ ok: true, action: "running", changed: false });
    expect(same.calls.map(call => call.args[0])).toEqual(["/Create", "/Query"]);

    const changed = plan(["--tick-every", "5000"]);
    const reload = scripted({ "schtasks /Query": { code: 0, stdout: "Status:  Running\n" }, schtasks: { code: 0 } });
    expect(await installDaemon(changed, "secret-token", reload.run)).toMatchObject({ ok: true, action: "reloaded", changed: true });
    expect(reload.calls.map(call => call.args[0])).toEqual(["/Create", "/Query", "/End", "/Run"]);
  });

  test("status reads the scheduler's answer; a missing task is not-installed", async () => {
    const made = plan();

    const running = scripted({ "schtasks /Query": { code: 0, stdout: "TaskName: x\nStatus:  Running\n" } });
    expect(await daemonStatus(made, running.run)).toMatchObject({ state: "running" });

    const idle = scripted({ "schtasks /Query": { code: 0, stdout: "Status:  Ready\n" } });
    expect(await daemonStatus(made, idle.run)).toMatchObject({ state: "loaded" });

    const disabled = scripted({ "schtasks /Query": { code: 0, stdout: "Status:  Disabled\n" } });
    expect(await daemonStatus(made, disabled.run)).toMatchObject({ state: "disabled" });

    const missing = scripted({ "schtasks /Query": { code: 1 } });
    expect(await daemonStatus(made, missing.run)).toMatchObject({ state: "not-installed" });
  });

  test("uninstall ends the task and deletes it", async () => {
    const made = plan();
    const script = scripted({ "schtasks /Query": { code: 1 }, schtasks: { code: 0 } });
    await installDaemon(made, "secret-token", script.run);
    script.calls.length = 0;

    await uninstallDaemon(made, script.run);

    expect(script.calls.map(call => call.args[0])).toEqual(["/End", "/Delete"]);
  });
});
