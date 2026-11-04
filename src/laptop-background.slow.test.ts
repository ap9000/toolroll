/**
 * The background handoff and `toolroll stop` over real `toolroll up --laptop` processes (the built package, as
 * up-signoff.slow.test.ts runs it), each with its own temporary HOME, database and port. The supervisor is scripted:
 * where launchd would start the login item, the script starts the same `up` command as a child of this test. Nothing
 * reaches this machine's launchd or systemd, and the only processes signalled are this test's own children.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { backgroundOn, laptopStop, type LaptopSeams } from "./laptop-background.js";
import { proveLiveConsole, type AttachProof } from "./console-instance.js";
import { packageVersion } from "./monitoring.js";
import { openStore } from "./store.js";
import { shortTempDir } from "../test/short-temp.js";
import { scriptedSupervisor } from "../test/laptop-supervisor.js";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const PORT = 47000 + (process.pid % 1000);
const platform = process.platform === "linux" ? "linux" : "darwin";

let base: string, home: string, db: string, env: NodeJS.ProcessEnv;
const children: ChildProcess[] = [];
const output: string[] = [];
beforeEach(() => {
  base = realpathSync(shortTempDir("so-bgs-"));
  home = join(base, "home");
  mkdirSync(home);
  mkdirSync(join(base, "s"));
  db = join(base, "s", "orders.db");
  // No real model CLI is reachable from the worker.
  const stubs = join(base, "stubs");
  mkdirSync(stubs);
  for (const name of ["claude", "codex", "gemini", "opencode"]) { writeFileSync(join(stubs, name), "#!/bin/sh\nexit 1\n"); chmodSync(join(stubs, name), 0o755); }
  env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: `${stubs}:${process.env["PATH"] ?? ""}` };
  output.length = 0;
});
afterEach(async () => {
  // Only this test's own children, by the handle it spawned them with.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited(child, 20_000).catch(() => child.kill("SIGKILL")); }
  }
  rmSync(base, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function exited(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`process ${child.pid} did not exit`)), ms);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
/** `toolroll up --laptop` as the login item runs it, as this test's own child. */
function startUp(): ChildProcess {
  const child = spawn(process.execPath, [join(dist, "bin.js"), "up", "--laptop", "--no-open", "--db", db, "--port", String(PORT), "--stop-grace", "1000"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", chunk => output.push(String(chunk)));
  child.stderr!.on("data", chunk => output.push(String(chunk)));
  children.push(child);
  return child;
}
async function prove(): Promise<AttachProof> {
  if (!existsSync(db)) return { ok: false, state: "none", message: "no database yet" };
  const store = openStore(db);
  try { return await proveLiveConsole(db, store, packageVersion()); } finally { store.close(); }
}
async function live(ms = 60_000): Promise<Extract<AttachProof, { ok: true }>> {
  // Not while a start is still creating or migrating the database: the handoff names the address once it serves.
  for (const deadline = Date.now() + ms; !output.join("").includes(`127.0.0.1:${PORT}`);) {
    if (Date.now() > deadline) throw Error(`no handoff\n${output.join("")}`);
    await sleep(200);
  }
  for (const deadline = Date.now() + ms; ;) {
    const proof = await prove();
    if (proof.ok) return proof;
    if (Date.now() > deadline) throw Error(`no live console: ${proof.message}\n${output.join("")}`);
    await sleep(200);
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const runners = () => {
  const handle = new DatabaseSync(db, { readOnly: true });
  try { return handle.prepare("SELECT name, retired_at FROM runner").all() as { name: string; retired_at: string | null }[]; } finally { handle.close(); }
};

/** Real processes, the scripted supervisor, and a signal seam that records every signal (then sends it). */
function seams(extra: Partial<LaptopSeams> = {}): LaptopSeams & { signals: { pid: number; signal: string }[] } {
  const signals: { pid: number; signal: string }[] = [];
  return { platform, home, dist, pathEnv: env["PATH"]!, agent: false, signal: (pid, signal) => { signals.push({ pid, signal }); process.kill(pid, signal); }, signals, ...extra };
}

describe("toolroll stop and background on, over real processes", () => {
  test("stop with no service: SIGTERM reaches the controller only; it drains, retires its worker, and its console goes with it", async () => {
    const up = startUp();
    const proof = await live();
    expect(proof.pid).not.toBe(up.pid);
    const s = seams({ supervisor: scriptedSupervisor().run });
    const store = openStore(db);
    try {
      expect(await laptopStop(store, db, s)).toEqual({ ok: true, action: "stopped", pid: up.pid, startsAtLogin: false });
    } finally { store.close(); }
    // The console child was never signalled: the controller stopped it.
    expect(s.signals).toEqual([{ pid: up.pid!, signal: "SIGTERM" }]);
    await exited(up, 30_000);
    expect(alive(proof.pid)).toBe(false);
    expect(runners().every(one => one.retired_at !== null)).toBe(true);
    expect((await prove()).ok).toBe(false);
  }, 120_000);

  test("on: the foreground `up` hands over to the service, which answers as this database's console", async () => {
    const foreground = startUp();
    const before = await live();
    let service: ChildProcess | null = null;
    const supervisor = scriptedSupervisor({ onLoad: () => { service = startUp(); } });
    const s = seams({ supervisor: supervisor.run, foreground: { controllerPid: foreground.pid!, restart: async () => { startUp(); } } });
    const store = openStore(db);
    let on;
    try { on = await backgroundOn(store, db, PORT, s); } finally { store.close(); }
    expect(on, output.join("")).toMatchObject({ ok: true, action: "installed", stoppedForeground: true, url: `http://127.0.0.1:${PORT}` });
    expect(s.signals).toEqual([{ pid: foreground.pid!, signal: "SIGTERM" }]);
    expect(foreground.exitCode ?? foreground.signalCode).not.toBeNull();
    expect(alive(before.pid)).toBe(false);
    expect(service).not.toBeNull();
    const after = await live();
    expect(after.pid).not.toBe(before.pid);
  }, 180_000);

  test("on: a service that never answers is removed and the foreground `up` starts again", async () => {
    const foreground = startUp();
    const before = await live();
    const supervisor = scriptedSupervisor();
    let restarted: ChildProcess | null = null;
    const s = seams({ supervisor: supervisor.run, healthTimeoutMs: 3_000, foreground: { controllerPid: foreground.pid!, restart: async () => { restarted = startUp(); } } });
    const store = openStore(db);
    let on;
    try { on = await backgroundOn(store, db, PORT, s); } finally { store.close(); }
    expect(on).toMatchObject({ ok: false, reason: "unhealthy" });
    expect(on!.ok ? [] : on!.rolledBack).toContain("started Toolroll in this terminal again");
    expect(existsSync(platform === "darwin" ? join(home, "Library", "LaunchAgents", "com.toolroll.up.plist") : join(home, ".config", "systemd", "user", "toolroll-up.service"))).toBe(false);
    expect(supervisor.state.loaded).toBe(false);
    await exited(foreground, 30_000);
    expect(restarted).not.toBeNull();
    // The foreground `up` is back: a new console on the same database and port.
    const again = await live();
    expect(again.pid).not.toBe(before.pid);
  }, 180_000);
});
