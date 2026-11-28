/**
 * `toolroll update` when Toolroll's own launchd service runs another build than the `toolroll` command (the
 * 2026-11-28 incident: com.standing-orders.browser ran a staged 0.9.116 for eight days while the command moved to
 * 0.9.127). The update adopts the service by its label and the database it serves, whichever build it names, then
 * stops it, points it at the new verified runtime and restarts it; a foreground `toolroll up` that is not that service
 * still refuses. The drift is said in the update preview, `toolroll status` and the console. launchctl, ps and node are
 * scripted and every file lives in a temporary HOME: nothing reaches this Mac's launchd.
 */
import { expect, test } from "vitest";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { launchdPlist } from "./daemon.js";
import { unitFlag } from "./laptop-service.js";
import { runOperate } from "./operate.js";
import { setUpdateChecks } from "./releases.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore } from "./store.js";
import { mixedRuntimeWords } from "./release.js";
import { commandRuntime, consoleDriftWords, machineSystem, pointUnitAt, serviceDrift, unitRuntimes, type MachineSeams } from "./toolroll-update.js";
import { runUpdateCommand } from "./toolroll-update-cli.js";
import { updatesHtml } from "./toolroll-update-ui.js";
import { PACKAGE_VERSION } from "./version.js";
import { htmlString } from "./html.js";
import { withFormToken } from "./server/request-context.js";
import { fixture, provenance, scriptedLaunchctl, SERVICE_PID, RESTARTED_SERVICE_PID } from "../test/toolroll-update-kit.js";

const LABEL = "com.standing-orders.browser";

/** A Toolroll runtime folder holding `version` (its package.json beside dist), as deploy-browser stages one. */
function runtimeAt(root: string, name: string, version: string): string {
  const dist = join(root, "staged-upgrades", name, "runtime", "node_modules", "toolroll", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "..", "package.json"), JSON.stringify({ name: "toolroll", version }));
  writeFileSync(join(dist, "bin.js"), `// ${version}`);
  return dist;
}

/** Toolroll's browser service as deploy-browser writes it: controller-service.js and cli.js from `dist`, `--db` naming `db`. */
function servicePlist(home: string, dist: string, db: string, label = LABEL): string {
  const unit = join(home, "Library", "LaunchAgents", `${label}.plist`);
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, launchdPlist({ label, command: [process.execPath, join(dist, "controller-service.js"), process.execPath, join(dist, "cli.js"), "up", "--db", db, "--runner", "studio", "--repo", "/work/app"],
    workingDirectory: dirname(dist), pathEnv: "/usr/bin:/bin", logPath: join(home, "service.log") }));
  return unit;
}

/** A live watch lease, as the service's `toolroll up` holds one; `released` drops it, as its shutdown does. */
function watchLease(databaseFile: string, now: Date) {
  const db = new DatabaseSync(databaseFile);
  try { db.prepare("INSERT INTO watch_lease(runner,repo,owner,generation,started_at,expires_at,heartbeat_at) VALUES('studio','/work/app','up-1',1,?,?,?)").run(now.toISOString(), new Date(now.getTime() + 3_600_000).toISOString(), now.toISOString()); } finally { db.close(); }
  return () => { const d = new DatabaseSync(databaseFile); try { d.exec("DELETE FROM watch_lease"); } finally { d.close(); } };
}

/** The darwin machine over a temporary HOME: scripted launchctl (its bootout ends the service's `up`, releasing its
 * lease), ps reporting the runtime the plist names, and `node bin.js --version` reading the staged bin. */
function darwinWorld(f: ReturnType<typeof fixture>, home: string, onBootout: () => void) {
  const launchctl = scriptedLaunchctl();
  let running = true;
  const run = (async (file: string, args: readonly string[]) => {
    const answered = await launchctl.run(file, args);
    if (args[0] === "bootout") { running = false; onBootout(); }
    if (args[0] === "bootstrap") running = true;
    return answered;
  }) as unknown as NonNullable<MachineSeams["run"]>;
  const unit = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const seams: MachineSeams = {
    platform: "darwin", run, sleep: async () => {},
    alive: pid => running && (pid === SERVICE_PID || pid === RESTARTED_SERVICE_PID),
    exec: (command, args) => command === "/bin/ps" ? { status: 0, stdout: `${unitRuntimes(readFileSync(unit, "utf8"))[0] ?? ""}/controller-service.js\n`, stderr: "" }
      : { status: 0, stdout: `${readFileSync(String(args[0]), "utf8").replace("// ", "")}\n`, stderr: "" },
  };
  return { launchctl, machine: machineSystem(home, {}, seams) };
}

test("a service that drifted to an older build is adopted by its label and database: stopped, pointed at the new runtime, restarted", async () => {
  const f = fixture();
  try {
    const home = join(f.root, "home");
    const stale = runtimeAt(f.root, "browser-c623253-old", "0.5.0");
    const unit = servicePlist(home, stale, f.databaseFile);
    // The service's `up` holds a live watch lease; it lets go when launchd stops the service.
    const release = watchLease(f.databaseFile, f.system.now());
    const { launchctl, machine } = darwinWorld(f, home, release);
    expect(machine.serviceUnit(f.current, f.databaseFile)).toBe(unit);
    const outcome = await f.start({
      serviceUnit: machine.serviceUnit, watchUnits: machine.watchUnits, servicePids: machine.servicePids, serviceLoaded: machine.serviceLoaded,
      stopService: machine.stopService, restartService: machine.restartService, processAlive: machine.processAlive, healthy: machine.healthy,
    });
    expect(outcome.phase, outcome.message).toBe("complete");
    const to = outcome.journal!.to.dist, text = readFileSync(unit, "utf8");
    // Both entries now run the verified runtime; nothing names the stale one; the database and the rest are as they were.
    expect(unitRuntimes(text)).toEqual([to]);
    expect(text).toContain(`<string>${to}/controller-service.js</string>`);
    expect(text).toContain(`<string>${to}/cli.js</string>`);
    expect(text).not.toContain(stale);
    expect(unitFlag(text, "darwin", "--db")).toBe(f.databaseFile);
    expect(outcome.journal!.switched!.unit!.path).toBe(unit);
    expect(launchctl.state.log.filter(verb => verb !== "print")).toEqual(["disable", "bootout", "enable", "bootstrap", "kickstart"]);
    expect(f.links.map(link => readFileSync(link, "utf8"))).toEqual(["// 0.7.0", "// 0.7.0"]);
  } finally { f.close(); }
});

test("a foreground toolroll up that is not our labelled service for this database still refuses", async () => {
  const f = fixture();
  try {
    const home = join(f.root, "home");
    const stale = runtimeAt(f.root, "browser-old", "0.5.0");
    // Our label serving another database, and a label that isn't ours serving this one: neither is adopted.
    servicePlist(home, stale, join(f.root, "elsewhere", "orders.db"));
    servicePlist(home, stale, f.databaseFile, "com.example.browser");
    // The Toolroll app's service on this database runs the app's own runtime, which updates as a whole app.
    servicePlist(home, "/Applications/Toolroll.app/Contents/Resources/app/dist", f.databaseFile, "com.toolroll.browser");
    watchLease(f.databaseFile, f.system.now());
    const { launchctl, machine } = darwinWorld(f, home, () => {});
    expect(machine.serviceUnit(f.current, f.databaseFile)).toBeNull();
    const outcome = await f.start({ serviceUnit: machine.serviceUnit, servicePids: machine.servicePids, stopService: machine.stopService, restartService: machine.restartService });
    expect(outcome.phase).toBe("refused");
    expect(outcome.message).toContain("toolroll up is running for /work/app (studio). Stop it first; an update replaces the version it runs. Nothing was changed.");
    expect(launchctl.state.log).toEqual([]);
    expect(f.calls).not.toContain("stop");
  } finally { f.close(); }
});

test("the update preview says the service drifted, and with the command already current --yes brings the service to it", async () => {
  const f = fixture();
  try {
    const home = join(f.root, "home");
    const stale = runtimeAt(f.root, "browser-old", "0.5.0");
    const unit = servicePlist(home, stale, f.databaseFile);
    const machine = machineSystem(home, {}, { platform: "darwin" });
    // The command's own release, verified again as an update is.
    const system = { ...f.system, serviceUnit: machine.serviceUnit, attestations: async () => provenance({ version: "0.6.0" }) };
    const say = async (args: string[], latest: string, current = f.current) => {
      const lines: string[] = [];
      const code = await runUpdateCommand(args, line => lines.push(line), { system, current, method: { kind: "npm", updateCommand: "" }, latest: async () => ({ version: latest }), databaseFile: f.databaseFile });
      return { code, lines };
    };
    // A newer release: the preview says the service is behind, and that the update moves both.
    expect((await say([], "0.7.0")).lines).toEqual(expect.arrayContaining(["Update Toolroll 0.6.0 → 0.7.0.", "Your Toolroll service runs 0.5.0, but `toolroll` is 0.6.0. This update moves both to 0.7.0."]));
    // The command is current: not "current", but the drift and what --yes does.
    const preview = await say([], "0.6.0");
    expect(preview.code).toBe(0);
    expect(preview.lines[0]).toBe("Your Toolroll service runs 0.5.0, but `toolroll` is 0.6.0.");
    expect(preview.lines[1]).toContain("Add --yes to bring them together");
    expect(f.calls).toEqual([]);
    const done = await say(["--yes"], "0.6.0");
    expect(done.code, done.lines.join("\n")).toBe(0);
    const text = readFileSync(unit, "utf8");
    expect(text).not.toContain(stale);
    expect(unitRuntimes(text)[0]).toContain(join(f.stateDir, "staged-upgrades", "release-0.6.0-"));
    expect(f.calls).toEqual(expect.arrayContaining(["install", "rehearse", "stop", "restart", "health"]));
    // The command now runs that runtime too, so nothing drifts: the preview says current.
    expect(f.links.map(link => readFileSync(link, "utf8"))).toEqual(["// 0.7.0", "// 0.7.0"]);
    expect((await say([], "0.6.0", { version: "0.6.0", dist: unitRuntimes(text)[0]! })).lines).toEqual(["Toolroll 0.6.0 is current."]);
  } finally { f.close(); }
});

test("toolroll status says when the service runs another build than the command, with the command that fixes it", async () => {
  const f = fixture();
  try {
    const home = join(f.root, "home");
    const status = async () => {
      const lines: string[] = [];
      const supervisor = async () => ({ code: 1, stdout: "", stderr: "", timedOut: false });
      await runOperate("status", ["--json"], line => lines.push(line), { databaseFile: f.databaseFile, now: new Date("2026-11-28T10:00:00Z"), releaseIo: { fetch: async () => { throw Error("offline"); } },
        laptopSeams: { platform: "darwin", home, dist: f.oldDist, supervisor, agent: false, proveConsole: async () => ({ ok: false, state: "none", message: "" }) } } as never);
      return JSON.parse(lines.join("\n")) as { runtimeDrift?: { service: string; cli: string; words: string; fix: string } };
    };
    expect((await status()).runtimeDrift).toBeUndefined();
    servicePlist(home, runtimeAt(f.root, "browser-old", "0.9.116"), f.databaseFile);
    expect((await status()).runtimeDrift).toEqual(expect.objectContaining({ service: "0.9.116", cli: PACKAGE_VERSION, fix: "toolroll update --yes",
      words: `Your Toolroll service runs 0.9.116, but \`toolroll\` is ${PACKAGE_VERSION}. Run \`toolroll update --yes\` to bring them together.` }));
  } finally { f.close(); }
});

test("the console, which runs as the service, says when the toolroll command on PATH runs another build", () => {
  const f = fixture();
  try {
    const service = { version: "0.9.116", dist: runtimeAt(f.root, "browser-old", "0.9.116") };
    const newer = join(f.root, "global", "lib", "node_modules", "toolroll");
    writeFileSync(join(newer, "package.json"), JSON.stringify({ name: "toolroll", version: "0.9.127" }));
    const bin = join(f.root, "path-bin"); mkdirSync(bin);
    symlinkSync(join(f.oldDist, "bin.js"), join(bin, "toolroll"));
    const command = commandRuntime(`/nowhere:${bin}`);
    expect(command).toEqual({ dist: f.oldDist, version: "0.9.127" });
    const words = consoleDriftWords(service, command);
    expect(words).toBe("Your Toolroll service runs 0.9.116, but `toolroll` is 0.9.127. Run `toolroll update --yes` to bring them together.");
    expect(consoleDriftWords({ version: "0.9.127", dist: f.oldDist }, command)).toBeNull();
    const page = htmlString(withFormToken("x", () => updatesHtml({ current: "0.9.116", latest: { version: "0.9.116" }, method: { kind: "managed", updateCommand: "toolroll update" }, journal: null, running: false, whatsNew: null, rollbackTo: null, csrf: "x", drift: words }, {})));
    expect(page).toContain("data-runtime-drift");
    expect(page).toContain(`<code class="k-mono">toolroll update --yes</code>`);
  } finally { f.close(); }
});

test("Settings → Updates says the service and the command on PATH run different builds, with the command", async () => {
  const f = fixture();
  const store = openStore(f.databaseFile);
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("alex");
  const configDir = join(f.root, "config"); mkdirSync(configDir); setUpdateChecks(configDir, false);
  const stale = runtimeAt(f.root, "browser-old", "0.9.116");
  let command: { dist: string; version: string | null } = { dist: f.oldDist, version: "0.9.127" };
  const server = createDecisionServer({ store, evidenceRoot: join(f.root, "evidence"), configDir, updates: {
    latest: async () => ({ version: "0.9.127" }), method: { kind: "managed", updateCommand: "toolroll update" }, current: "0.9.116", dist: stale, launch: async () => {}, command: () => command,
  } });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const page = await (await fetch(`${base}/settings/updates`, { headers: { cookie } })).text();
    expect(page).toContain("data-runtime-drift");
    expect(page).toContain("Your Toolroll service runs 0.9.116, but <code class=\"k-mono\">toolroll</code> is 0.9.127.");
    command = { dist: stale, version: "0.9.116" };
    expect(await (await fetch(`${base}/settings/updates`, { headers: { cookie } })).text()).not.toContain("data-runtime-drift");
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    store.close(); f.close();
  }
}, 30_000);

test("a unit is pointed at the new runtime in one pass: every runtime its command names, nothing else", () => {
  const text = `<key>ProgramArguments</key><array><string>/n</string><string>/s/a/dist/controller-service.js</string><string>/s/a/dist/cli.js</string><string>--db</string><string>/s/orders.db</string></array><key>StandardOutPath</key><string>/s/a/service.log</string>`;
  expect(unitRuntimes(text)).toEqual(["/s/a/dist"]);
  expect(pointUnitAt(text, "/g/dist", "/r/$&/dist")).toBe(text.split("/s/a/dist").join("/r/$&/dist"));
  expect(serviceDrift(null, { version: "1.0.0", dist: "/r" })).toBeNull();
});

test("the release preflight's mixed-runtime stop names the command that fixes it, and says when the command is newer", () => {
  const OLD = "/state/staged-upgrades/browser-old/runtime/node_modules/toolroll/dist", NEW = "/opt/homebrew/lib/node_modules/toolroll/dist";
  const words = mixedRuntimeWords({ services: [OLD], clis: [{ name: "toolroll", runtime: NEW }, { name: "standing-orders", runtime: NEW }], versions: { [OLD]: "0.9.116", [NEW]: "0.9.127" } });
  expect(words).toContain(`service ${OLD} (0.9.116); toolroll ${NEW} (0.9.127)`);
  expect(words).toContain("`toolroll` is 0.9.127, newer than the 0.9.116 your service runs.");
  expect(words).toContain("Run `toolroll update --yes` to bring them to one verified build, then release again.");
  // An adapter too old to say versions still gets the command.
  expect(mixedRuntimeWords({ services: [OLD], clis: [{ name: "toolroll", runtime: NEW }] })).toContain("toolroll update --yes");
});
