/**
 * `toolroll up` as the service runs it — controller-service → `up` → its console and worker, real built processes —
 * signs off cleanly however it is stopped (the 2026-10-29 deploy): a stop to the supervisor is forwarded and waited
 * for; the supervisor's death makes `up` stop itself; and an `up` killed outright leaves a record by which the next
 * start proves it gone and takes the name over at once, while a second live `up` is still refused.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { shortTempDir } from "../test/short-temp.js";
import { listProcesses } from "../scripts/deploy-stop.mjs";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const PORT = 46000 + (process.pid % 1000);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

let base: string, repo: string, db: string, env: NodeJS.ProcessEnv;
const started: ChildProcess[] = [];
beforeEach(() => {
  base = realpathSync(shortTempDir("so-signoff-"));
  repo = join(base, "project");
  db = join(base, "orders.db");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo, env: gitEnv });
  // No real model CLI is reachable from the worker.
  const stubs = join(base, "stubs");
  mkdirSync(stubs);
  for (const name of ["claude", "codex", "gemini", "opencode"]) { writeFileSync(join(stubs, name), "#!/bin/sh\nexit 1\n"); chmodSync(join(stubs, name), 0o755); }
  env = { ...process.env, PATH: `${stubs}:${process.env["PATH"] ?? ""}` };
});
afterEach(() => {
  // Everything this test started, whatever happened: every process naming its folder.
  for (const pid of mine()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const child of started.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  rmSync(base, { recursive: true, force: true });
});

/** The processes of this test's service: its supervisor, `up`s on its database, and their role children. */
function tree(): { supervisor: number[]; up: number[]; roles: number[] } {
  const rows = listProcesses(spawnSync) ?? [];
  const up = rows.filter(row => row.command.includes(`${dist}/cli.js up --db ${db}`) && !row.command.includes("controller-service.js")).map(row => row.pid);
  return {
    supervisor: rows.filter(row => row.command.includes(`${dist}/controller-service.js`) && row.command.includes(db)).map(row => row.pid),
    up, roles: rows.filter(row => up.includes(row.ppid) && row.command.includes("up-role-child.js")).map(row => row.pid),
  };
}
const mine = (): number[] => (listProcesses(spawnSync) ?? []).filter(row => row.command.includes(base) || (row.command.includes("up-role-child.js") && tree().up.includes(row.ppid))).map(row => row.pid);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(what: string, probe: () => T | null | undefined | false, ms = 30_000): Promise<T> {
  for (const deadline = Date.now() + ms; ;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw Error(`timed out waiting for ${what}\n${output.join("")}`);
    await sleep(100);
  }
}
const output: string[] = [];
const upArgs = (port: number, extra: string[] = []) => [join(dist, "cli.js"), "up", "--db", db, "--repo", repo, "--port", String(port), "--stop-grace", "1000", "--runner", "signoff", ...extra];
/** The service as launchd runs it: controller-service supervising `up`. Ready once both roles run. */
async function service(): Promise<{ supervisor: number; up: number; roles: number[] }> {
  output.length = 0;
  const child = spawn(process.execPath, [join(dist, "controller-service.js"), process.execPath, ...upArgs(PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
  started.push(child);
  child.stdout!.on("data", chunk => output.push(String(chunk)));
  child.stderr!.on("data", chunk => output.push(String(chunk)));
  const ready = await until("both roles", () => { const t = tree(); return t.up.length === 1 && t.roles.length === 2 && output.join("").includes("toolroll onboard") ? t : null; });
  return { supervisor: child.pid!, up: ready.up[0]!, roles: ready.roles };
}
const runner = () => {
  const handle = new DatabaseSync(db, { readOnly: true });
  try { return handle.prepare("SELECT heartbeat_at, retired_at FROM runner WHERE name = 'signoff'").get() as { heartbeat_at: string; retired_at: string | null }; }
  finally { handle.close(); }
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("up signs off however it is stopped", () => {
  test("SIGTERM to the supervisor: forwarded and waited for; `up` and both roles exit and the runner is retired", async () => {
    const s = await service();
    process.kill(s.supervisor, "SIGTERM");
    await until("the whole tree to exit", () => ![s.supervisor, s.up, ...s.roles].some(alive));
    expect(runner().retired_at).not.toBeNull();
  }, 90_000);

  test("the supervisor killed outright: `up` sees it gone, stops itself, retires its runner and leaves no orphan", async () => {
    const s = await service();
    process.kill(s.supervisor, "SIGKILL");
    await until("`up` and its roles to exit", () => ![s.up, ...s.roles].some(alive));
    expect(output.join("")).toContain("the process that started Toolroll is gone; stopping");
    expect(runner().retired_at).not.toBeNull();
  }, 90_000);

  test("everything killed outright: the next start proves the holder gone and takes over at once; a live holder is still refused", async () => {
    const s = await service();
    // Two live `up`s stay impossible: the holder's record shows its processes running.
    const second = spawnSync(process.execPath, upArgs(PORT + 1), { env, encoding: "utf8", timeout: 60_000 });
    expect(second.status).not.toBe(0);
    expect(`${second.stdout}${second.stderr}`).toMatch(/looks alive/);
    for (const pid of [s.supervisor, s.up, ...s.roles]) process.kill(pid, "SIGKILL");
    await until("the tree to be gone", () => ![s.supervisor, s.up, ...s.roles].some(alive));
    expect(runner().retired_at).toBeNull();
    // Within the heartbeat window (3 min) a fresh start would have been refused; the record proves the holder gone.
    const again = spawnSync(process.execPath, upArgs(PORT, ["--for", "3000"]), { env, encoding: "utf8", timeout: 60_000 });
    expect(`${again.stdout}${again.stderr}`).toContain("signed off the previous signoff: its processes had already exited");
    expect(again.status).toBe(0);
    const signedOff = readSignOff();
    expect(signedOff).toMatch(new RegExp(`^signoff: process ${s.up} \\(up\\), .* proved gone$`));
    for (const pid of s.roles) expect(signedOff).toContain(`${pid} (`);
    expect(tree().up).toEqual([]);
  }, 120_000);
});

/** The ledgered sign-off, as recorded: it names the killed `up` and both roles. */
function readSignOff(): string {
  const handle = new DatabaseSync(db, { readOnly: true });
  try { return String(handle.prepare("SELECT detail FROM action_ledger WHERE action = 'worker signed off'").get()?.["detail"]); }
  finally { handle.close(); }
}
