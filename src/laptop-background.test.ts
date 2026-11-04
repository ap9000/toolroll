/**
 * The background service handoff (easy-start D) over scripted seams: a temporary HOME, a scripted launchctl/systemctl,
 * fake process ids with a scripted identity probe, and a scripted console proof. Nothing here reaches this machine's
 * launchd or systemd, or any real process; laptop-background.slow.test.ts runs real `up --laptop` children.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundOff, backgroundOn, backgroundShow, laptopStop, type LaptopSeams } from "./laptop-background.js";
import { laptopServiceDefinition } from "./laptop-service.js";
import { register } from "./runner.js";
import { credentialDigest, runnerProcessFile, sealRunnerProcessRecord, writeRunnerProcessRecord } from "./runner-process.js";
import { backgroundAsked, openStore, recordBackgroundAsked, type Store } from "./store.js";
import { runOperate } from "./operate.js";
import type { AttachProof } from "./console-instance.js";
import { fakePid } from "../test/fake-pid.js";
import { scriptedSupervisor as scripted } from "../test/laptop-supervisor.js";

const T = new Date("2026-11-03T10:00:00.000Z");
const HOST = "laptop-test-host";
const PORT = 45000 + (process.pid % 2000);
const UP = fakePid(1), CONSOLE = fakePid(2), WORKER = fakePid(3), OTHER = fakePid(4);
const STARTED = "2026-11-03T09:00:00.000Z";
const uid = typeof process.getuid === "function" ? process.getuid() : 501;

let base: string, home: string, db: string, dist: string, store: Store;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "so-bg-")));
  home = join(base, "home");
  mkdirSync(home);
  mkdirSync(join(base, "state"));
  db = join(base, "state", "orders.db");
  dist = join(base, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "bin.js"), "// toolroll\n");
  store = openStore(db);
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

/** Fake processes: which are alive, and when each started. */
function processes() {
  const live = new Map<number, string>();
  const signals: { pid: number; signal: string }[] = [];
  return {
    live, signals,
    probe: { exists: (pid: number) => (live.has(pid) ? "present" as const : "absent" as const), start: (pid: number) => live.get(pid) ?? null },
    // The controller drains on SIGTERM: it and its role children exit.
    signal: (pid: number, signal: NodeJS.Signals) => { signals.push({ pid, signal }); if (pid === UP && signal === "SIGTERM") { live.delete(UP); live.delete(CONSOLE); live.delete(WORKER); } },
  };
}

const proof = (pid = CONSOLE): AttachProof => ({ ok: true, url: `http://127.0.0.1:${PORT}`, port: PORT, pid, build: "test" });
const none: AttachProof = { ok: false, state: "none", message: "no console is running" };

/** A registered runner on this host, and its signed record naming an `up`, its console and worker. */
function controllerRecord(): void {
  register(store, { name: "laptop", host: HOST, now: T });
  const holder = store.getRunner("laptop")!;
  const record = { v: 1 as const, runner: "laptop", host: HOST, registeredAt: holder.runner.registeredAt, credential: credentialDigest(holder.credentialHash),
    processes: [{ pid: UP, role: "up" as const, started: STARTED }, { pid: CONSOLE, role: "console" as const, started: STARTED }, { pid: WORKER, role: "worker" as const, started: STARTED }] };
  writeRunnerProcessRecord(runnerProcessFile(db, "laptop"), sealRunnerProcessRecord(record, holder.credentialHash));
}

function seamsWith(extra: Partial<LaptopSeams> & { console?: () => AttachProof }): LaptopSeams {
  const { console: consoleOf, ...rest } = extra;
  return {
    platform: "darwin", home, node: process.execPath, dist, pathEnv: "/usr/bin:/bin", host: HOST, agent: false,
    portFree: async () => true, sleep: async () => {}, healthTimeoutMs: 50, exitTimeoutMs: 200,
    parentOf: pid => (pid === CONSOLE ? UP : null),
    proveConsole: async () => (consoleOf ?? (() => none))(),
    ...rest,
  };
}
const unitPath = () => join(home, "Library", "LaunchAgents", "com.toolroll.up.plist");
const definition = () => {
  const made = laptopServiceDefinition({ platform: "darwin", home, node: process.execPath, dist, db, port: PORT, pathEnv: "/usr/bin:/bin" });
  if ("error" in made) throw Error(made.error);
  return made;
};
const writeOther = (label: string, text = "<plist/>") => {
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", `${label}.plist`), text);
};

describe("toolroll background show", () => {
  test("says whether our login item is absent, the same, or different, whether it is loaded, and what else runs here", async () => {
    const supervisor = scripted();
    const show = async () => {
      const shown = await backgroundShow(store, db, PORT, seamsWith({ supervisor: supervisor.run }));
      if (!shown.ok) throw Error(shown.message);
      return shown.show;
    };
    expect(await show()).toMatchObject({ installed: "absent", loaded: false, running: null, conflicts: [], label: "com.toolroll.up" });
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(unitPath(), "<plist>older</plist>");
    expect((await show()).installed).toBe("different");
    writeFileSync(unitPath(), definition().text);
    supervisor.state.loaded = true;
    expect(await show()).toMatchObject({ installed: "same", loaded: true });
    // The desktop app's service is reported, never touched.
    writeOther("com.toolroll.browser");
    expect((await show()).conflicts.map(one => one.label)).toEqual(["com.toolroll.browser"]);
    expect(supervisor.state.log.every(line => line === `launchctl print gui/${uid}/com.toolroll.up`)).toBe(true);
  });
});

describe("toolroll background on", () => {
  test("installs, validates before loading, loads, and proves the console; the same unit loaded again is a no-op", async () => {
    let started = false;
    const supervisor = scripted({ onLoad: () => { started = true; } });
    const seams = seamsWith({ supervisor: supervisor.run, console: () => (started ? proof() : none) });
    const on = await backgroundOn(store, db, PORT, seams);
    expect(on).toMatchObject({ ok: true, action: "installed", label: "com.toolroll.up", url: `http://127.0.0.1:${PORT}`, stoppedForeground: false });
    expect(readFileSync(unitPath(), "utf8")).toBe(definition().text);
    expect(supervisor.state.log).toEqual([
      `launchctl print gui/${uid}/com.toolroll.up`,
      `plutil -lint ${unitPath()}`,
      `launchctl enable gui/${uid}/com.toolroll.up`,
      `launchctl bootstrap gui/${uid} ${unitPath()}`,
    ]);
    supervisor.state.log.length = 0;
    expect(await backgroundOn(store, db, PORT, seams)).toMatchObject({ ok: true, action: "unchanged" });
    expect(supervisor.state.log).toEqual([`launchctl print gui/${uid}/com.toolroll.up`]);
  });

  test("another service on this database is refused without a terminal, and asked about at one", async () => {
    writeOther("com.toolroll.browser", "<plist>the app</plist>");
    const supervisor = scripted({ onLoad: () => {} });
    const refused = await backgroundOn(store, db, PORT, seamsWith({ supervisor: supervisor.run }));
    expect(refused).toMatchObject({ ok: false, reason: "conflict" });
    expect(existsSync(unitPath())).toBe(false);
    expect(supervisor.state.log.some(line => /bootstrap|bootout|disable/.test(line))).toBe(false);
    const asked: string[] = [];
    const declined = await backgroundOn(store, db, PORT, seamsWith({ supervisor: supervisor.run, terminal: true, confirm: async question => { asked.push(question); return false; } }));
    expect(declined).toMatchObject({ ok: false, reason: "declined" });
    expect(asked[0]).toContain("com.toolroll.browser");
    expect(existsSync(unitPath())).toBe(false);
    // The app's own service is never changed, whatever the answer.
    expect(readFileSync(join(home, "Library", "LaunchAgents", "com.toolroll.browser.plist"), "utf8")).toBe("<plist>the app</plist>");
  });

  test("a coding agent can't set it up: nothing is written or loaded", async () => {
    const supervisor = scripted();
    expect(await backgroundOn(store, db, PORT, seamsWith({ supervisor: supervisor.run, agent: true }))).toMatchObject({ ok: false, reason: "agent" });
    expect(existsSync(unitPath())).toBe(false);
    expect(supervisor.state.log).toEqual([]);
  });

  test("a unit the validator refuses is removed and never loaded", async () => {
    const supervisor = scripted({ plutil: false });
    const on = await backgroundOn(store, db, PORT, seamsWith({ supervisor: supervisor.run }));
    expect(on).toMatchObject({ ok: false, reason: "invalid-unit" });
    expect(existsSync(unitPath())).toBe(false);
    expect(supervisor.state.log.some(line => line.includes("bootstrap"))).toBe(false);
  });

  test("a console running in another terminal is not ours to stop", async () => {
    controllerRecord();
    const fake = processes();
    for (const pid of [UP, CONSOLE, WORKER]) fake.live.set(pid, STARTED);
    const supervisor = scripted();
    const on = await backgroundOn(store, db, PORT, seamsWith({ supervisor: supervisor.run, probe: fake.probe, signal: fake.signal, console: () => proof() }));
    expect(on).toMatchObject({ ok: false, reason: "running-elsewhere" });
    expect(on.ok ? "" : on.message).toContain("toolroll stop");
    expect(fake.signals).toEqual([]);
    expect(existsSync(unitPath())).toBe(false);
  });

  test("a service that never answers is booted out and removed, and the foreground `up` it replaced starts again", async () => {
    controllerRecord();
    const fake = processes();
    for (const pid of [UP, CONSOLE, WORKER]) fake.live.set(pid, STARTED);
    const supervisor = scripted();
    let restarted = 0;
    const on = await backgroundOn(store, db, PORT, seamsWith({
      supervisor: supervisor.run, probe: fake.probe, signal: fake.signal,
      console: () => (fake.live.has(CONSOLE) ? proof() : none),
      foreground: { controllerPid: UP, restart: async () => { restarted += 1; } },
    }));
    expect(on).toMatchObject({ ok: false, reason: "unhealthy" });
    expect(on.ok ? [] : on.rolledBack).toContain("started Toolroll in this terminal again");
    // The controller drained (SIGTERM to it alone), the unit came and went, and the foreground `up` is back.
    expect(fake.signals).toEqual([{ pid: UP, signal: "SIGTERM" }]);
    expect(restarted).toBe(1);
    expect(existsSync(unitPath())).toBe(false);
    expect(supervisor.state.loaded).toBe(false);
    expect(supervisor.state.log.filter(line => !line.startsWith("launchctl print"))).toEqual([
      `plutil -lint ${unitPath()}`,
      `launchctl enable gui/${uid}/com.toolroll.up`,
      `launchctl bootstrap gui/${uid} ${unitPath()}`,
      `launchctl disable gui/${uid}/com.toolroll.up`,
      `launchctl bootout gui/${uid}/com.toolroll.up`,
    ]);
  });

  test("on Linux: a systemd user unit, enabled with --now", async () => {
    let started = false;
    const supervisor = scripted({ onLoad: () => { started = true; } });
    const on = await backgroundOn(store, db, PORT, seamsWith({ platform: "linux", supervisor: supervisor.run, console: () => (started ? proof() : none) }));
    expect(on).toMatchObject({ ok: true, action: "installed", label: "toolroll-up" });
    const path = join(home, ".config", "systemd", "user", "toolroll-up.service");
    expect(readFileSync(path, "utf8")).toContain("ExecStart=");
    expect(supervisor.state.log).toEqual([
      "systemctl --user is-active toolroll-up.service",
      `systemd-analyze verify --user ${path}`,
      "systemctl --user daemon-reload",
      "systemctl --user enable --now toolroll-up.service",
    ]);
  });
});

describe("toolroll background off", () => {
  test("stops and removes only our own label; the app's service and a watch stay as they were", async () => {
    writeOther("com.toolroll.browser", "<plist>the app</plist>");
    writeOther("com.toolroll.watch.project", `<plist><key>ProgramArguments</key><array><string>--db</string><string>${db}</string></array></plist>`);
    writeFileSync(unitPath(), definition().text);
    const supervisor = scripted({ loaded: true });
    const off = await backgroundOff(store, db, seamsWith({ supervisor: supervisor.run }));
    expect(off).toMatchObject({ ok: true, action: "removed" });
    expect(existsSync(unitPath())).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.toolroll.browser.plist"))).toBe(true);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.toolroll.watch.project.plist"))).toBe(true);
    for (const line of supervisor.state.log) expect(line.endsWith("/com.toolroll.up"), line).toBe(true);
    expect(supervisor.state.log).toContain(`launchctl disable gui/${uid}/com.toolroll.up`);
    expect(await backgroundOff(store, db, seamsWith({ supervisor: supervisor.run }))).toMatchObject({ ok: true, action: "already-off" });
  });
});

describe("toolroll stop", () => {
  test("with the service loaded: the supervisor stops it, and it comes back at login", async () => {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(unitPath(), definition().text);
    const supervisor = scripted({ loaded: true });
    const lines: string[] = [];
    const code = await runOperate("stop", [], line => lines.push(line), { databaseFile: db, laptopSeams: seamsWith({ supervisor: supervisor.run }) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toBe("Toolroll stopped. It starts again when you log in — run `toolroll background off` to stop that.");
    // Booted out, not disabled: the login item stays.
    expect(supervisor.state.log).toContain(`launchctl bootout gui/${uid}/com.toolroll.up`);
    expect(supervisor.state.log.some(line => line.includes("disable"))).toBe(false);
    expect(existsSync(unitPath())).toBe(true);
  });

  test("without a service: SIGTERM to the controller its signed record names, never to the console, then its exit is proved", async () => {
    controllerRecord();
    const fake = processes();
    for (const pid of [UP, CONSOLE, WORKER]) fake.live.set(pid, STARTED);
    const stopped = await laptopStop(store, db, seamsWith({ supervisor: scripted().run, probe: fake.probe, signal: fake.signal, console: () => (fake.live.has(CONSOLE) ? proof() : none) }));
    expect(stopped).toEqual({ ok: true, action: "stopped", pid: UP, startsAtLogin: false });
    expect(fake.signals).toEqual([{ pid: UP, signal: "SIGTERM" }]);
  });

  test("a record whose `up` pid now belongs to another process is refused; nothing is signalled", async () => {
    controllerRecord();
    const fake = processes();
    fake.live.set(CONSOLE, STARTED);
    fake.live.set(WORKER, STARTED);
    // The id the record names is held by a process that started at another time: a reused pid.
    fake.live.set(UP, "2026-11-03T09:30:00.000Z");
    const stopped = await laptopStop(store, db, seamsWith({ supervisor: scripted().run, probe: fake.probe, signal: fake.signal, console: () => proof() }));
    expect(stopped).toMatchObject({ ok: false, reason: "console-unproven" });
    expect(fake.signals).toEqual([]);
  });

  test("a console whose parent is not the recorded controller is refused; nothing is signalled", async () => {
    controllerRecord();
    const fake = processes();
    for (const pid of [UP, CONSOLE, WORKER]) fake.live.set(pid, STARTED);
    const stopped = await laptopStop(store, db, seamsWith({ supervisor: scripted().run, probe: fake.probe, signal: fake.signal, parentOf: () => OTHER, console: () => proof() }));
    expect(stopped).toMatchObject({ ok: false, reason: "console-unproven" });
    expect(stopped.ok ? "" : stopped.message).toContain(`was not started by process ${UP}`);
    expect(fake.signals).toEqual([]);
  });

  test("a record not sealed with the runner's credential proves nothing", async () => {
    controllerRecord();
    const holder = store.getRunner("laptop")!;
    const forged = { v: 1 as const, runner: "laptop", host: HOST, registeredAt: holder.runner.registeredAt, credential: credentialDigest(holder.credentialHash),
      processes: [{ pid: OTHER, role: "up" as const, started: STARTED }, { pid: CONSOLE, role: "console" as const, started: STARTED }] };
    writeRunnerProcessRecord(runnerProcessFile(db, "laptop"), sealRunnerProcessRecord(forged, "not-the-credential"));
    const fake = processes();
    for (const pid of [OTHER, CONSOLE]) fake.live.set(pid, STARTED);
    const stopped = await laptopStop(store, db, seamsWith({ supervisor: scripted().run, probe: fake.probe, signal: fake.signal, parentOf: () => OTHER, console: () => proof() }));
    expect(stopped).toMatchObject({ ok: false, reason: "console-unproven" });
    expect(fake.signals).toEqual([]);
  });
});

describe("the ask-once fact and the status key", () => {
  test("background-asked is recorded once; the first answer stands", () => {
    expect(backgroundAsked(store)).toBeNull();
    expect(recordBackgroundAsked(store, "no", T)).toBe(true);
    expect(recordBackgroundAsked(store, "yes", new Date(T.getTime() + 1000))).toBe(false);
    expect(backgroundAsked(store)).toEqual({ answer: "no", at: T.toISOString() });
  });

  test("status --json says whether this computer's console runs, and whether a background service runs it", async () => {
    const status = async (seams: LaptopSeams) => {
      const lines: string[] = [];
      store.close();
      try { await runOperate("status", ["--json"], line => lines.push(line), { databaseFile: db, now: T, releaseIo: { fetch: async () => { throw Error("offline"); } }, laptopSeams: seams } as never); }
      finally { store = openStore(db); }
      return (JSON.parse(lines.join("\n")) as { laptop: unknown }).laptop;
    };
    expect(await status(seamsWith({}))).toEqual({ running: false, url: null, pid: null, background: "off" });
    writeOther("com.toolroll.browser");
    expect(await status(seamsWith({ console: () => proof() }))).toEqual({ running: true, url: `http://127.0.0.1:${PORT}`, pid: CONSOLE, background: "other-service" });
    writeFileSync(unitPath(), definition().text);
    expect(await status(seamsWith({}))).toMatchObject({ background: "on" });
  });
});
