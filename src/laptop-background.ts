/**
 * Keeping Toolroll running in the background on a laptop (easy-start plan D): `toolroll background on|off|show`,
 * `toolroll stop`, and the `laptop` part of `toolroll status`.
 *
 * The login item itself is laptop-service.ts's definition (com.toolroll.up / toolroll-up.service). This module is
 * the handoff around it:
 *
 * - **on** writes and validates the unit without loading it, stops the foreground `up` this invoker owns (if one runs
 *   for this database) by SIGTERM to its controller and waits until that controller's whole process record is proved
 *   gone by start identity and the port is free, then loads the unit and proves the console live within 30 s. Any
 *   failure boots the unit out, removes it (or puts back the one that was there), starts the foreground `up` again if
 *   it was stopped, and says what failed. An identical unit already loaded is left alone.
 * - **off** stops and removes only our own label.
 * - **stop**: with the service loaded, the supervisor stops it (it comes back at login); otherwise the controller of
 *   the proven console, found through its signed process record, gets SIGTERM — never the console child, which the
 *   controller would only start again.
 *
 * Every outside effect goes through LaptopSeams: tests give a temporary HOME, a scripted launchctl/systemctl, and their
 * own child processes. Without a supervisor seam, a test run (VITEST) refuses to reach the real launchctl or systemctl.
 * Other services (the desktop app's com.toolroll.browser, a watch on this database) are reported, never touched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { proveLiveConsole, type AttachProof } from "./console-instance.js";
import { writeFileDurably, type SupervisorRunner } from "./daemon.js";
import { compareInstalled, detectOtherServices, laptopServiceDefinition, LAPTOP_LABEL_DARWIN, LAPTOP_LABEL_LINUX, type LaptopConflict, type LaptopServiceDefinition } from "./laptop-service.js";
import { packageVersion } from "./monitoring.js";
import { underAgent } from "./prompt.js";
import { processGone, readRunnerProcessRecord, realProcessProbe, recordedHolderProvedGone, recordStandsFor, runnerProcessFile, type ProcessProbe } from "./runner-process.js";
import type { Runner } from "./runner.js";
import { laptopPortOf, type Store } from "./store.js";

/** Everything outside this process that the background handoff touches. Tests replace all of it. */
export type LaptopSeams = {
  platform?: NodeJS.Platform;
  home?: string;
  /** launchctl, systemctl, plutil and systemd-analyze. */
  supervisor?: SupervisorRunner;
  /** The absolute Node binary and package `dist` folder the unit pins (default: this process's). */
  node?: string;
  dist?: string;
  pathEnv?: string;
  /** A person at a terminal (stdin and stdout a TTY, no --json, not under a coding agent): only they may confirm. */
  terminal?: boolean;
  /** Run by a coding agent (prompt.ts underAgent): a login item is a person's own choice, so `on` refuses. */
  agent?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  /** Prove this database's console live (default: proveLiveConsole at this package's version). */
  proveConsole?: (databaseFile: string, store: Store) => Promise<AttachProof>;
  probe?: ProcessProbe;
  /** A process's parent, or null when it can't be read. */
  parentOf?: (pid: number) => number | null;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  portFree?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  host?: string;
  healthTimeoutMs?: number;
  exitTimeoutMs?: number;
  /** The foreground `up` this invoker started (the terminal UI's child): its controller's pid, and how to start it again. */
  foreground?: { controllerPid: number; restart: () => Promise<void> };
};

export type BackgroundState = "on" | "off" | "other-service";

type Resolved = Required<Omit<LaptopSeams, "foreground" | "node" | "dist" | "pathEnv">> & Pick<LaptopSeams, "foreground" | "pathEnv"> & { node: string; dist: string };

function resolveSeams(seams: LaptopSeams): Resolved {
  return {
    platform: seams.platform ?? process.platform,
    home: seams.home ?? homedir(),
    supervisor: seams.supervisor ?? realSupervisor,
    node: seams.node ?? process.execPath,
    dist: seams.dist ?? dirname(fileURLToPath(import.meta.url)),
    ...(seams.pathEnv === undefined ? {} : { pathEnv: seams.pathEnv }),
    terminal: seams.terminal ?? false,
    agent: seams.agent ?? underAgent(process.env),
    confirm: seams.confirm ?? (async () => false),
    proveConsole: seams.proveConsole ?? ((databaseFile, store) => proveLiveConsole(databaseFile, store, packageVersion())),
    probe: seams.probe ?? realProcessProbe,
    parentOf: seams.parentOf ?? parentPid,
    signal: seams.signal ?? ((pid, signal) => { process.kill(pid, signal); }),
    portFree: seams.portFree ?? portIsFree,
    sleep: seams.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    host: seams.host ?? hostname(),
    healthTimeoutMs: seams.healthTimeoutMs ?? 30_000,
    // A drain is bounded by `up`'s own forced stop (stop-grace 30 s + 20 s); a margin past it.
    exitTimeoutMs: seams.exitTimeoutMs ?? 75_000,
    ...(seams.foreground === undefined ? {} : { foreground: seams.foreground }),
  };
}

const realSupervisor: SupervisorRunner = async (file, args, options) => {
  // Tests never reach this machine's real launchd or systemd: they pass their own supervisor.
  if (process.env["VITEST"] !== undefined) throw Error(`a test reached the real ${file}: pass LaptopSeams.supervisor`);
  return (await import("./exec.js")).run(file, args, options);
};

function parentPid(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 1 || process.platform === "win32") return null;
  try {
    const raw = execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 });
    const parent = Number(raw.trim());
    return Number.isSafeInteger(parent) && parent > 0 ? parent : null;
  } catch { return null; }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** `toolroll up`'s port when none is named. */
const DEFAULT_PORT = 4180;

const uid = (): number => (typeof process.getuid === "function" ? process.getuid() : 501);

function labelOf(platform: "darwin" | "linux"): string {
  return platform === "darwin" ? LAPTOP_LABEL_DARWIN : LAPTOP_LABEL_LINUX;
}
function unitPath(platform: "darwin" | "linux", home: string): string {
  return platform === "darwin" ? join(home, "Library", "LaunchAgents", `${LAPTOP_LABEL_DARWIN}.plist`) : join(home, ".config", "systemd", "user", `${LAPTOP_LABEL_LINUX}.service`);
}
function readUnit(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}
function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

// ---- the supervisor, for our own label only ------------------------------------------------------------------------

/** Whether our label is loaded (launchd) or active (systemd) now. */
async function serviceLoaded(s: Resolved, platform: "darwin" | "linux"): Promise<boolean> {
  if (platform === "darwin") return (await s.supervisor("launchctl", ["print", `gui/${uid()}/${LAPTOP_LABEL_DARWIN}`])).code === 0;
  const answer = await s.supervisor("systemctl", ["--user", "is-active", `${LAPTOP_LABEL_LINUX}.service`]);
  return ["active", "activating", "reloading", "deactivating"].includes(answer.stdout.trim());
}

/** The written unit, checked by the platform's own validator, never loaded. Null when it passes. */
async function validateUnit(s: Resolved, platform: "darwin" | "linux", path: string): Promise<string | null> {
  if (platform === "darwin") {
    const checked = await s.supervisor("plutil", ["-lint", path]);
    return checked.code === 0 ? null : `plutil refused the login item: ${firstLine(checked.stdout) || firstLine(checked.stderr) || `exit ${checked.code}`}`;
  }
  const checked = await s.supervisor("systemd-analyze", ["verify", "--user", path]);
  // Not every Linux has systemd-analyze; systemctl itself still parses the unit when it loads it.
  if (checked.notFound) return null;
  return checked.code === 0 ? null : `systemd-analyze refused the unit: ${firstLine(checked.stderr) || firstLine(checked.stdout) || `exit ${checked.code}`}`;
}

/** Load and start our unit. Null on success. */
async function startService(s: Resolved, platform: "darwin" | "linux", path: string): Promise<string | null> {
  if (platform === "darwin") {
    const service = `gui/${uid()}/${LAPTOP_LABEL_DARWIN}`;
    // `background off` disabled the label; loading it again is the person's explicit yes.
    const enabled = await s.supervisor("launchctl", ["enable", service]);
    if (enabled.code !== 0) return `launchctl could not enable ${LAPTOP_LABEL_DARWIN}: ${firstLine(enabled.stderr) || `exit ${enabled.code}`}`;
    const loaded = await s.supervisor("launchctl", ["bootstrap", `gui/${uid()}`, path]);
    return loaded.code === 0 ? null : `launchctl could not load ${LAPTOP_LABEL_DARWIN}: ${firstLine(loaded.stderr) || `exit ${loaded.code}`}`;
  }
  const reload = await s.supervisor("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) return `systemctl daemon-reload failed: ${firstLine(reload.stderr) || `exit ${reload.code}`}`;
  const enabled = await s.supervisor("systemctl", ["--user", "enable", "--now", `${LAPTOP_LABEL_LINUX}.service`]);
  return enabled.code === 0 ? null : `systemctl could not start ${LAPTOP_LABEL_LINUX}: ${firstLine(enabled.stderr) || `exit ${enabled.code}`}`;
}

/**
 * Stop our unit. `until: "login"` (toolroll stop) leaves it to start again at the next login; `"removed"` (off,
 * rollback) also disables it. Resolves once the supervisor no longer has it running. Null on success.
 */
async function stopService(s: Resolved, platform: "darwin" | "linux", path: string, until: "login" | "removed"): Promise<string | null> {
  if (platform === "darwin") {
    const service = `gui/${uid()}/${LAPTOP_LABEL_DARWIN}`;
    if (until === "removed") {
      const disabled = await s.supervisor("launchctl", ["disable", service]);
      if (disabled.code !== 0) return `launchctl could not disable ${LAPTOP_LABEL_DARWIN}: ${firstLine(disabled.stderr) || `exit ${disabled.code}`}`;
    }
    const out = await s.supervisor("launchctl", ["bootout", service]);
    if (out.code !== 0) await s.supervisor("launchctl", ["unload", path]);
    // launchctl can return before the label leaves the domain; wait for the observable boundary.
    for (const deadline = Date.now() + s.exitTimeoutMs; ;) {
      if ((await s.supervisor("launchctl", ["print", service])).code !== 0) return null;
      if (Date.now() >= deadline) return `launchctl did not stop ${LAPTOP_LABEL_DARWIN}; it is still loaded`;
      await s.sleep(100);
    }
  }
  const unit = `${LAPTOP_LABEL_LINUX}.service`;
  const stopped = await s.supervisor("systemctl", until === "removed" ? ["--user", "disable", "--now", unit] : ["--user", "stop", unit]);
  if (stopped.code !== 0) return `systemctl could not stop ${LAPTOP_LABEL_LINUX}: ${firstLine(stopped.stderr) || `exit ${stopped.code}`}`;
  return null;
}

// ---- the controller of the running console -------------------------------------------------------------------------

export type ControllerProof = {
  /** The `up` process that started the console: the one to stop. */
  pid: number;
  started: string;
  consolePid: number;
  port: number;
  url: string;
  runner: string;
  /** The registration whose signed record names both, captured now: the exit proof uses exactly it. */
  holder: { runner: Runner; credentialHash: string };
};

/**
 * The controller of this database's live console, proved from the plane's own records: a live runner on this host
 * whose signed process record names the proven console (pid and start time) and exactly one live `up` process, that
 * `up` still the process the record names (same start time), and the console's parent that `up`. Anything else —
 * no record, a reused pid, a console whose parent is someone else — proves nothing and is refused.
 */
export function findController(store: Store, databaseFile: string, console_: { pid: number; port: number; url: string }, s: Pick<Resolved, "probe" | "parentOf" | "host">): ControllerProof | { why: string } {
  let why = "no Toolroll process record names the running console";
  for (const runner of store.listRunners()) {
    if (runner.retiredAt !== null || runner.host !== s.host) continue;
    const holder = store.getRunner(runner.name);
    if (holder === null) continue;
    let file: string;
    try { file = runnerProcessFile(databaseFile, runner.name); } catch { continue; }
    const record = readRunnerProcessRecord(file);
    if (recordStandsFor(record, holder, s.host) !== null || record === null) continue;
    const consoleEntry = record.processes.find(one => one.role === "console" && one.pid === console_.pid);
    if (consoleEntry === undefined) continue;
    if (s.probe.start(console_.pid) !== consoleEntry.started) return { why: `process ${console_.pid} is not the console its record names (it started at another time)` };
    const ups = record.processes.filter(one => one.role === "up" && !processGone(one, s.probe));
    if (ups.length !== 1) { why = ups.length === 0 ? "the process that started the console is no longer running" : "the console's record names more than one running `up`"; continue; }
    const up = ups[0]!;
    if (s.probe.start(up.pid) !== up.started) return { why: `process ${up.pid} is not the \`up\` its record names (the id was reused)` };
    if (s.parentOf(console_.pid) !== up.pid) return { why: `the console (process ${console_.pid}) was not started by process ${up.pid}` };
    return { pid: up.pid, started: up.started, consolePid: console_.pid, port: console_.port, url: console_.url, runner: runner.name, holder };
  }
  return { why };
}

/**
 * SIGTERM to the controller (its full drain), re-checking its start time at the moment of the signal, then wait until
 * every process in its signed record is proved gone by start identity. Never signals the console child.
 */
async function drainController(databaseFile: string, controller: ControllerProof, s: Resolved): Promise<string | null> {
  if (s.probe.start(controller.pid) !== controller.started) return `process ${controller.pid} is no longer the \`up\` that was found; nothing was stopped`;
  try { s.signal(controller.pid, "SIGTERM"); } catch (error) { return `could not signal process ${controller.pid}: ${(error as Error).message}`; }
  const file = runnerProcessFile(databaseFile, controller.runner);
  let last = "";
  for (const deadline = Date.now() + s.exitTimeoutMs; ;) {
    const proof = recordedHolderProvedGone(file, controller.holder, s.host, s.probe);
    if (proof.gone) return null;
    last = proof.why;
    if (Date.now() >= deadline) return `Toolroll (process ${controller.pid}) did not finish stopping: ${last}`;
    await s.sleep(250);
  }
}

async function waitPortFree(port: number, s: Resolved): Promise<boolean> {
  for (const deadline = Date.now() + s.exitTimeoutMs; ;) {
    if (await s.portFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await s.sleep(250);
  }
}

async function awaitHealthy(databaseFile: string, store: Store, s: Resolved): Promise<AttachProof> {
  let proof: AttachProof = { ok: false, state: "none", message: "no console is running" };
  for (const deadline = Date.now() + s.healthTimeoutMs; ;) {
    proof = await s.proveConsole(databaseFile, store);
    if (proof.ok || Date.now() >= deadline) return proof;
    await s.sleep(500);
  }
}

// ---- show ------------------------------------------------------------------------------------------------------------

export type BackgroundShow = {
  platform: NodeJS.Platform;
  label: string | null;
  unit: string | null;
  installed: "same" | "different" | "absent";
  loaded: boolean;
  running: { url: string; pid: number } | null;
  conflicts: LaptopConflict[];
  port: number;
};

function definitionFor(s: Resolved, platform: "darwin" | "linux", databaseFile: string, port: number): LaptopServiceDefinition | { error: string } {
  return laptopServiceDefinition({ platform, home: s.home, node: s.node, dist: s.dist, db: databaseFile, port, ...(s.pathEnv === undefined ? {} : { pathEnv: s.pathEnv }) });
}

export async function backgroundShow(store: Store, databaseFile: string, requestedPort: number | null, seams: LaptopSeams = {}): Promise<{ ok: true; show: BackgroundShow } | { ok: false; reason: string; message: string }> {
  const s = resolveSeams(seams);
  const platform = s.platform;
  const live = await s.proveConsole(databaseFile, store);
  const running = live.ok ? { url: live.url, pid: live.pid } : null;
  const port = requestedPort ?? (live.ok ? live.port : laptopPortOf(store) ?? DEFAULT_PORT);
  if (platform !== "darwin" && platform !== "linux") return { ok: true, show: { platform, label: null, unit: null, installed: "absent", loaded: false, running, conflicts: [], port } };
  const definition = definitionFor(s, platform, databaseFile, port);
  if ("error" in definition) return { ok: false, reason: "unsupported", message: definition.error };
  const conflicts = detectOtherServices({ platform, home: s.home, db: databaseFile });
  if (!Array.isArray(conflicts)) return { ok: false, reason: "unreadable", message: conflicts.error };
  return { ok: true, show: { platform, label: definition.label, unit: definition.path, installed: compareInstalled(readUnit(definition.path), definition), loaded: await serviceLoaded(s, platform), running, conflicts, port } };
}

// ---- on ----------------------------------------------------------------------------------------------------------------

export type BackgroundOn =
  | { ok: true; action: "unchanged" | "installed" | "replaced"; label: string; unit: string; url: string; pid: number; stoppedForeground: boolean }
  | { ok: false; reason: string; message: string; rolledBack?: string[] };

/** `requestedPort`: --port, else the running console's, else the port this laptop install saved, else `up`'s default. */
export async function backgroundOn(store: Store, databaseFile: string, requestedPort: number | null, seams: LaptopSeams = {}): Promise<BackgroundOn> {
  const s = resolveSeams(seams);
  const platform = s.platform;
  if (platform !== "darwin" && platform !== "linux") return { ok: false, reason: "unsupported", message: `there is no background service for ${platform}; keep \`toolroll up\` running yourself` };
  // A login item runs at every login: something a person sets up, never a coding agent on their behalf.
  if (s.agent) return { ok: false, reason: "agent", message: "a coding agent can't set Toolroll to start at login; run `toolroll background on` yourself at a terminal" };
  const first = await s.proveConsole(databaseFile, store);
  const port = requestedPort ?? (first.ok ? first.port : laptopPortOf(store) ?? DEFAULT_PORT);
  const definition = definitionFor(s, platform, databaseFile, port);
  if ("error" in definition) return { ok: false, reason: "unsupported", message: definition.error };
  if (!existsSync(definition.command[1]!)) return { ok: false, reason: "unsupported", message: `${definition.command[1]} does not exist: run \`toolroll background on\` from an installed Toolroll` };

  const before = readUnit(definition.path);
  const installed = compareInstalled(before, definition);
  const wasLoaded = await serviceLoaded(s, platform);
  if (installed === "same" && wasLoaded) {
    const live = first.ok ? first : await s.proveConsole(databaseFile, store);
    if (live.ok) return { ok: true, action: "unchanged", label: definition.label, unit: definition.path, url: live.url, pid: live.pid, stoppedForeground: false };
  }

  // 1. Other services on this database (or the desktop app's console) are a person's call, at a terminal.
  const conflicts = detectOtherServices({ platform, home: s.home, db: databaseFile });
  if (!Array.isArray(conflicts)) return { ok: false, reason: "unreadable", message: conflicts.error };
  if (conflicts.length > 0) {
    const reasons = conflicts.map(one => one.reason).join("; ");
    if (!s.terminal) return { ok: false, reason: "conflict", message: `${reasons}. Running both could start two Toolrolls; run \`toolroll background on\` at a terminal to confirm` };
    if (!(await s.confirm(`${reasons}. Keep Toolroll running in the background anyway?`))) return { ok: false, reason: "declined", message: "Nothing was changed." };
  }

  // 2. What runs now: our service under another definition (replaced), the foreground `up` this invoker owns, or
  // nothing. A console that runs elsewhere is not ours to stop.
  const live = await s.proveConsole(databaseFile, store);
  if (!live.ok && live.state === "refused") return { ok: false, reason: "console-unproven", message: live.message };
  let foreground: ControllerProof | null = null;
  let controller: ControllerProof | null = null;
  if (live.ok) {
    const found = findController(store, databaseFile, live, s);
    if ("why" in found) return { ok: false, reason: "console-unproven", message: `Toolroll is running (${live.url}), but ${found.why}. Nothing was changed` };
    controller = found;
    if (!wasLoaded) {
      if (s.foreground === undefined || s.foreground.controllerPid !== found.pid) {
        return { ok: false, reason: "running-elsewhere", message: `Toolroll is already running in another terminal (${live.url}, process ${found.pid}). Stop it with \`toolroll stop\`, then run \`toolroll background on\`` };
      }
      foreground = found;
    }
  }

  // 3. The unit, written and validated, not loaded.
  const rollback: string[] = [];
  const restoreUnit = (): void => {
    try {
      if (before === null) rmSync(definition.path, { force: true });
      else writeFileDurably(definition.path, before, 0o644);
    } catch { rollback.push(`could not put ${definition.path} back`); }
  };
  try {
    mkdirSync(dirname(definition.path), { recursive: true });
    mkdirSync(dirname(definition.logPath), { recursive: true });
    if (installed !== "same") writeFileDurably(definition.path, definition.text, 0o644);
  } catch (error) {
    restoreUnit();
    return { ok: false, reason: "write", message: `could not write ${definition.path}: ${(error as Error).message}` };
  }
  /** 7. Undo everything this call did, in reverse, and say what failed. */
  const fail = async (message: string, reason: string, loaded = false): Promise<BackgroundOn> => {
    if (loaded || (await serviceLoaded(s, platform))) {
      const out = await stopService(s, platform, definition.path, "removed");
      if (out !== null) rollback.push(out);
    }
    restoreUnit();
    if (wasLoaded) await restartPrevious(s, platform, definition.path, before, rollback);
    if (foreground !== null && s.foreground !== undefined) {
      try { await s.foreground.restart(); rollback.push("started Toolroll in this terminal again"); }
      catch (error) { rollback.push(`could not start Toolroll in this terminal again: ${(error as Error).message}`); }
    }
    return { ok: false, reason, message: `${message}. The background service was removed`, rolledBack: rollback };
  };
  const invalid = await validateUnit(s, platform, definition.path);
  if (invalid !== null) { restoreUnit(); return { ok: false, reason: "invalid-unit", message: `${invalid}. Nothing was changed` }; }

  // 4. Hand over: the old definition's service is stopped through the supervisor, the foreground `up` by SIGTERM to its
  // controller; either way, every process its record names is proved gone and the port is free before anything loads.
  if (wasLoaded) {
    const stopped = await stopService(s, platform, definition.path, "login");
    if (stopped !== null) { restoreUnit(); return { ok: false, reason: "supervisor", message: `${stopped}. Nothing was changed` }; }
  }
  if (controller !== null) {
    const drained = wasLoaded ? await waitControllerGone(databaseFile, controller, s) : await drainController(databaseFile, controller, s);
    if (drained !== null) {
      restoreUnit();
      if (wasLoaded) await restartPrevious(s, platform, definition.path, before, rollback);
      return { ok: false, reason: "still-running", message: drained, ...(rollback.length === 0 ? {} : { rolledBack: rollback }) };
    }
  }
  const handoffPort = controller?.port ?? port;
  if (!(await waitPortFree(handoffPort, s)) || (handoffPort !== port && !(await waitPortFree(port, s)))) {
    return fail(`port ${port} is still taken after Toolroll stopped`, "port-busy");
  }

  // 5. Load it, and 6. prove the console it starts.
  const started = await startService(s, platform, definition.path);
  if (started !== null) return fail(started, "supervisor");
  const healthy = await awaitHealthy(databaseFile, store, s);
  if (!healthy.ok) return fail(`the background service did not answer within ${Math.round(s.healthTimeoutMs / 1000)} s (${healthy.message})`, "unhealthy", true);
  return { ok: true, action: installed === "absent" ? "installed" : wasLoaded ? "replaced" : "installed", label: definition.label, unit: definition.path, url: healthy.url, pid: healthy.pid, stoppedForeground: foreground !== null };

}

/** The previous service, put back as it was: its unit is restored by the caller; this loads it again. */
async function restartPrevious(s: Resolved, platform: "darwin" | "linux", path: string, before: string | null, rollback: string[]): Promise<void> {
  if (before === null) return;
  const again = await startService(s, platform, path);
  rollback.push(again === null ? "started the previous background service again" : `could not start the previous background service again: ${again}`);
}

/** The supervisor stopped it: wait for the record's proof, without signalling anything ourselves. */
async function waitControllerGone(databaseFile: string, controller: ControllerProof, s: Resolved): Promise<string | null> {
  const file = runnerProcessFile(databaseFile, controller.runner);
  for (const deadline = Date.now() + s.exitTimeoutMs; ;) {
    const proof = recordedHolderProvedGone(file, controller.holder, s.host, s.probe);
    if (proof.gone) return null;
    if (Date.now() >= deadline) return `Toolroll (process ${controller.pid}) did not finish stopping: ${proof.why}`;
    await s.sleep(250);
  }
}

// ---- off ---------------------------------------------------------------------------------------------------------------

export type BackgroundOff = { ok: true; action: "removed" | "already-off"; label: string; unit: string } | { ok: false; reason: string; message: string };

export async function backgroundOff(store: Store, databaseFile: string, seams: LaptopSeams = {}): Promise<BackgroundOff> {
  const s = resolveSeams(seams);
  const platform = s.platform;
  if (platform !== "darwin" && platform !== "linux") return { ok: false, reason: "unsupported", message: `there is no background service for ${platform}` };
  const label = labelOf(platform), path = unitPath(platform, s.home);
  const present = existsSync(path);
  const loaded = await serviceLoaded(s, platform);
  if (!present && !loaded) return { ok: true, action: "already-off", label, unit: path };
  let controller: ControllerProof | null = null;
  if (loaded) {
    const live = await s.proveConsole(databaseFile, store);
    if (live.ok) { const found = findController(store, databaseFile, live, s); if (!("why" in found)) controller = found; }
    const stopped = await stopService(s, platform, path, "removed");
    if (stopped !== null) return { ok: false, reason: "supervisor", message: stopped };
    if (controller !== null) {
      const gone = await waitControllerGone(databaseFile, controller, s);
      if (gone !== null) return { ok: false, reason: "still-running", message: gone };
    }
  }
  try { rmSync(path, { force: true }); } catch (error) { return { ok: false, reason: "write", message: `could not remove ${path}: ${(error as Error).message}` }; }
  if (platform === "linux") await s.supervisor("systemctl", ["--user", "daemon-reload"]);
  return { ok: true, action: "removed", label, unit: path };
}

// ---- stop --------------------------------------------------------------------------------------------------------------

export type LaptopStop =
  | { ok: true; action: "service-stopped" | "stopped" | "not-running"; pid: number | null; startsAtLogin: boolean }
  | { ok: false; reason: string; message: string };

export async function laptopStop(store: Store, databaseFile: string, seams: LaptopSeams = {}): Promise<LaptopStop> {
  const s = resolveSeams(seams);
  const platform = s.platform;
  const live = await s.proveConsole(databaseFile, store);
  if (!live.ok && live.state === "refused") return { ok: false, reason: "console-unproven", message: live.message };
  const found = live.ok ? findController(store, databaseFile, live, s) : null;
  // Our service, loaded: the supervisor stops it (SIGTERM reaches the controller, which drains). It starts at login.
  if ((platform === "darwin" || platform === "linux") && existsSync(unitPath(platform, s.home)) && await serviceLoaded(s, platform)) {
    const stopped = await stopService(s, platform, unitPath(platform, s.home), "login");
    if (stopped !== null) return { ok: false, reason: "supervisor", message: stopped };
    if (found !== null && !("why" in found)) {
      const gone = await waitControllerGone(databaseFile, found, s);
      if (gone !== null) return { ok: false, reason: "still-running", message: gone };
    }
    return { ok: true, action: "service-stopped", pid: found !== null && !("why" in found) ? found.pid : null, startsAtLogin: true };
  }
  if (!live.ok) return { ok: true, action: "not-running", pid: null, startsAtLogin: false };
  if (found === null || "why" in found) return { ok: false, reason: "console-unproven", message: `Toolroll is running (${live.url}), but ${found?.why ?? "its controller can't be found"}. Nothing was stopped` };
  const drained = await drainController(databaseFile, found, s);
  if (drained !== null) return { ok: false, reason: "still-running", message: drained };
  return { ok: true, action: "stopped", pid: found.pid, startsAtLogin: false };
}

// ---- status ------------------------------------------------------------------------------------------------------------

export type LaptopStatus = { running: boolean; url: string | null; pid: number | null; background: BackgroundState };

/**
 * The `laptop` key of `toolroll status`: whether this database's console is proven live (its address and the console
 * process), and whether a background service runs it — ours ("on"), another service on this database or the desktop
 * app's ("other-service"), or none ("off"). Reads files only; never asks the supervisor.
 */
export async function laptopStatus(store: Store, databaseFile: string, seams: LaptopSeams = {}): Promise<LaptopStatus> {
  const s = resolveSeams(seams);
  let live: AttachProof;
  try { live = await s.proveConsole(databaseFile, store); } catch { live = { ok: false, state: "none", message: "" }; }
  let background: BackgroundState = "off";
  if (s.platform === "darwin" || s.platform === "linux") {
    if (existsSync(unitPath(s.platform, s.home))) background = "on";
    else {
      const others = detectOtherServices({ platform: s.platform, home: s.home, db: databaseFile });
      if (!Array.isArray(others) || others.length > 0) background = "other-service";
    }
  }
  return { running: live.ok, url: live.ok ? live.url : null, pid: live.ok ? live.pid : null, background };
}

// ---- easy start: starting the installed service again ------------------------------------------------------------------

/** Whether Toolroll's own login item is installed here (its unit file exists). Reads one path; asks no supervisor. */
export function backgroundInstalled(seams: LaptopSeams = {}): boolean {
  const s = resolveSeams(seams);
  return (s.platform === "darwin" || s.platform === "linux") && existsSync(unitPath(s.platform, s.home));
}

/**
 * Bare `toolroll` and `toolroll open` with the background service installed but this database's console not running
 * (stopped with `toolroll stop`, or not yet started at this login): start it through its supervisor — never a second
 * `up` beside it — and prove the console it runs live. Our own label only.
 */
export async function startInstalledService(store: Store, databaseFile: string, seams: LaptopSeams = {}): Promise<AttachProof> {
  const s = resolveSeams(seams);
  const platform = s.platform;
  if ((platform !== "darwin" && platform !== "linux") || !existsSync(unitPath(platform, s.home))) return { ok: false, state: "none", message: "the background service isn't installed" };
  const already = await s.proveConsole(databaseFile, store);
  if (already.ok || already.state === "refused") return already;
  if (!(await serviceLoaded(s, platform))) {
    const started = await startService(s, platform, unitPath(platform, s.home));
    if (started !== null) return { ok: false, state: "refused", message: started };
  } else if (platform === "darwin") {
    // Loaded but not answering (between restarts): ask launchd to run it now.
    await s.supervisor("launchctl", ["kickstart", `gui/${uid()}/${LAPTOP_LABEL_DARWIN}`]);
  }
  const healthy = await awaitHealthy(databaseFile, store, s);
  return healthy.ok ? healthy : { ok: false, state: "refused", message: `the background service did not answer within ${Math.round(s.healthTimeoutMs / 1000)} s (${healthy.message})` };
}
