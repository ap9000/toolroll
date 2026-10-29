/**
 * `toolroll up` as two processes (docs/plans/isolated-checks.md, stage 1), over the real machinery: a real bind, real
 * git, real child processes. The console answers while the worker is frozen; a killed worker is started again and its
 * predecessor's claims are recovered exactly as after an `up` crash — only once its lease has lapsed, never two at once;
 * a stop drains the worker before the console closes.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runOperate, runUpRole } from "./operate.js";
import { buildIdentity, memoryChannel, type RoleToParent } from "./up-processes.js";
import { register } from "./runner.js";
import { PACKAGE_VERSION } from "./version.js";
import { openStore } from "./store.js";
import { readInstance } from "./console-instance.js";
import { shortTempDir } from "../test/short-temp.js";
import { addRepos, updateRepos } from "./repos.js";

const PORT = 44000 + (process.pid % 2000);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

let base: string;
let repo: string;
let db: string;
let lines: string[];
const savedPath = process.env["PATH"];

beforeEach(() => {
  base = shortTempDir("so-split-");
  repo = join(base, "project");
  db = join(base, "orders.db");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv });
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: repo, env: gitEnv });
  execFileSync("git", ["commit", "-qm", "first"], { cwd: repo, env: gitEnv });
  // Belt and braces: whatever the worker might dispatch, no real model CLI is reachable from it.
  const stubs = join(base, "stubs");
  mkdirSync(stubs);
  for (const name of ["claude", "codex", "gemini", "opencode"]) {
    writeFileSync(join(stubs, name), "#!/bin/sh\necho 'not a real provider' >&2\nexit 1\n");
    chmodSync(join(stubs, name), 0o755);
  }
  process.env["PATH"] = `${stubs}:${savedPath ?? ""}`;
  lines = [];
});
afterEach(() => {
  process.env["PATH"] = savedPath;
  rmSync(base, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(what: string, probe: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${lines.join("\n")}`);
    await sleep(50);
  }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** This process's role children, by the one argument each carries (and nothing else on its command line). */
function roles(): { console?: { pid: number; command: string }; worker?: { pid: number; command: string } } {
  const found: Record<string, { pid: number; command: string }> = {};
  for (const line of execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null || Number(match[2]) !== process.pid || !match[3]!.includes("up-role-child")) continue;
    const role = match[3]!.trim().split(/\s+/).at(-1)!;
    found[role] = { pid: Number(match[1]), command: match[3]! };
  }
  return found;
}
const liveLease = () => {
  const store = openStore(db);
  try { return store.handle.prepare("SELECT owner, generation, expires_at FROM watch_lease WHERE expires_at > ?").get(new Date().toISOString()) as { owner: string; generation: number; expires_at: string } | undefined; }
  finally { store.close(); }
};
const startUp = (port: number, extra: string[] = []) => {
  let finished = false;
  // No terminal: the handoff and every role's log line come to `lines` (with --json they would go to stderr).
  const running = runOperate("up", ["--repo", repo, "--port", String(port), "--stop-grace", "2000", ...extra], line => lines.push(line),
    { databaseFile: db, upSeams: { terminal: false, openBrowser: () => {} } })
    .finally(() => { finished = true; });
  return { running, finished: () => finished };
};
/** Ready: the handoff is out. What it started: its console's address and its runner. */
async function started(up: { finished: () => boolean }, port: number): Promise<{ url: string; runner: string }> {
  await until("the handoff", () => lines.some(line => line.includes("toolroll onboard")) || up.finished());
  expect(up.finished(), lines.join("\n")).toBe(false);
  const store = openStore(db);
  try { return { url: `http://127.0.0.1:${port}/`, runner: store.listRunners().find(one => one.retiredAt === null)!.name }; }
  finally { store.close(); }
}

describe("toolroll up as two processes", () => {
  test("console and worker are each their own ready process; a frozen worker never holds a console response; a stop drains both", async () => {
    const up = startUp(PORT, ["--project-root", base]);
    try {
      const envelope = await started(up, PORT);
      // Each role's lines say whose they are.
      expect(lines.some(line => line.startsWith("[worker] watch: containment"))).toBe(true);
      const found = roles();
      expect(found.console?.pid).toBeGreaterThan(0);
      expect(found.worker?.pid).toBeGreaterThan(0);
      expect(new Set([found.console!.pid, found.worker!.pid, process.pid]).size).toBe(3);
      // Readiness means each one's part is real: the worker holds its project's lease, the console is the attach record.
      expect(liveLease()?.owner).toMatch(/^toolroll-service:/);
      const store = openStore(db);
      try { expect(readInstance(store)?.pid ?? found.console!.pid).toBe(found.console!.pid); } finally { store.close(); }
      // The runner token travels only over the private channel: each command line is the entry and its role, nothing more.
      for (const [role, one] of Object.entries(found)) expect(one.command.trim().endsWith(`up-role-child.ts ${role}`), one.command).toBe(true);
      for (const one of Object.values(found)) expect(one.command).not.toMatch(/--token|tok-|--runner/);

      // The longest synchronous task there is: the worker's whole process stopped. The console still answers at once.
      process.kill(found.worker!.pid, "SIGSTOP");
      try {
        for (let i = 0; i < 5; i++) {
          const started = performance.now();
          const answer = await fetch(new URL("/healthz", envelope.url), { signal: AbortSignal.timeout(2_000) });
          expect(answer.status).toBe(200);
          expect(performance.now() - started).toBeLessThan(1_000);
        }
      } finally { process.kill(found.worker!.pid, "SIGCONT"); }

      // A project added while it runs: the worker binds and builds it, and the console (another process) serves it.
      const second = join(base, "second");
      mkdirSync(second);
      execFileSync("git", ["init", "-q"], { cwd: second, env: gitEnv });
      const [account = "", password = ""] = readFileSync(join(base, "up-login.txt"), "utf8").trim().split(" ");
      const cookie = ((await fetch(new URL("/login", envelope.url), { method: "POST", body: new URLSearchParams({ name: account, token: password }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
      const tools = async () => (await fetch(new URL(`/settings/tools?repo=${encodeURIComponent(second)}`, envelope.url), { headers: { cookie } })).status;
      expect(await tools()).toBe(403);
      expect(await updateRepos(join(base, "repos.json"), current => addRepos(current, [second]))).toMatchObject({ ok: true });
      for (const deadline = Date.now() + 20_000; await tools() !== 200;) {
        if (Date.now() > deadline) throw new Error(`the console never served the added project\n${lines.join("\n")}`);
        await sleep(100);
      }

      // A stop: the worker drains and lets its lease go, the builder retires, then the console closes. Nothing is left.
      process.emit("SIGTERM");
      expect(await up.running, lines.join("\n")).toBe(0);
      for (const one of Object.values(found)) await until(`${one.pid} to exit`, () => !alive(one.pid), 10_000);
      expect(liveLease()).toBeUndefined();
      const after = openStore(db);
      try {
        expect(after.getRunner(envelope.runner)?.runner.retiredAt).not.toBeNull();
        expect(readInstance(after)).toBeNull();
      } finally { after.close(); }
    } finally {
      if (!up.finished()) process.emit("SIGTERM");
      await up.running;
    }
  }, 90_000);

  test("a killed worker starts again and recovers its predecessor's claims only after its lease lapses: never two holders", async () => {
    const up = startUp(PORT + 1);
    try {
      const envelope = await started(up, PORT + 1);
      const first = roles().worker!;
      const before = await until("the first worker's lease", () => liveLease());

      // What the dying worker was building: a claim under its incarnation, its task running.
      const store = openStore(db);
      const now = new Date();
      store.createTask({ id: "crashed", title: "the work the crash interrupted" }, now);
      const ref = store.refFor("built-in", "crashed").id;
      store.placeTask(ref, (store.getRunner(envelope.runner)!.runner.repos)[0]!);
      store.handle.prepare("UPDATE task SET state = 'running' WHERE id = 'crashed'").run();
      store.handle.prepare(`INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at, incarnation)
        VALUES ('lease-crashed', ?, 1, ?, ?, ?, ?, NULL, ?)`).run(ref, envelope.runner, now.toISOString(), new Date(now.getTime() + 15 * 60_000).toISOString(), now.toISOString(), before.owner);
      store.close();

      process.kill(first.pid, "SIGKILL");
      const second = await until("a new worker", () => { const next = roles().worker; return next !== undefined && next.pid !== first.pid ? next : null; });
      await until("the new worker to wait for the lease", () => lines.some(line => line.includes("still held by the previous worker")));
      // While the dead worker's lease stands, the new one holds nothing and takes nothing back.
      await sleep(1_500);
      expect(liveLease()).toMatchObject({ owner: before.owner, generation: before.generation });
      const held = openStore(db);
      try { expect(held.handle.prepare("SELECT released_at FROM claim WHERE lease_id = 'lease-crashed'").get()).toEqual({ released_at: null }); } finally { held.close(); }

      // Its lease lapses (as 90 s would): the new worker takes it over and recovers the incarnation in the same step.
      const lapse = openStore(db);
      try { lapse.handle.prepare("UPDATE watch_lease SET expires_at = ? WHERE owner = ?").run(new Date(Date.now() - 1_000).toISOString(), before.owner); } finally { lapse.close(); }
      const taken = await until("the takeover", () => { const lease = liveLease(); return lease !== undefined && lease.owner !== before.owner ? lease : null; });
      expect(taken.generation).toBe(before.generation + 1);
      const after = openStore(db);
      try {
        expect(after.handle.prepare("SELECT released_by FROM claim WHERE lease_id = 'lease-crashed'").get()).toEqual({ released_by: "recovered" });
        expect(after.getTask("crashed")?.state).toBe("queued");
        // One live claim at most per task, ever: the recovered one is gone and nothing else holds it.
        expect(after.handle.prepare("SELECT COUNT(*) AS n FROM claim WHERE task_ref = ? AND released_at IS NULL").get(ref)).toEqual({ n: 0 });
        expect(after.getRunner(envelope.runner)?.runner.retiredAt).toBeNull();
      } finally { after.close(); }
      await until("the recovery to be said", () => lines.some(line => line.includes("Recovered 1 claim(s) from the previous watch")));
      expect(alive(second.pid)).toBe(true);

      process.emit("SIGTERM");
      expect(await up.running, lines.join("\n")).toBe(0);
    } finally {
      if (!up.finished()) process.emit("SIGTERM");
      await up.running;
    }
  }, 90_000);

  test("codex round 1 #2: a project removed during a build, then a worker crash: the replacement recovers it before new work", async () => {
    // The state a worker leaves when it dies while a removed project's watch is still draining: the project is still
    // bound to the runner (it is let go only once its watch stops), its watch lease names the dead incarnation, a
    // reaper already released the claim but its run is open and its task `running`, and the console's list (so the
    // replacement's start) no longer names it.
    const kept = realpathSync(repo);
    mkdirSync(join(base, "removed"));
    const removed = realpathSync(join(base, "removed"));
    execFileSync("git", ["init", "-q"], { cwd: removed, env: gitEnv });
    writeFileSync(join(removed, "README.md"), "removed\n");
    execFileSync("git", ["add", "."], { cwd: removed, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "first"], { cwd: removed, env: gitEnv });
    const registryPath = join(base, "repos.json");
    expect(await updateRepos(registryPath, current => addRepos(current, [kept]))).toMatchObject({ ok: true });
    const now = new Date();
    const lapsed = new Date(now.getTime() - 1_000).toISOString();
    const store = openStore(db);
    register(store, { name: "mac", host: "test", capacity: 2, repos: [kept, removed], now, newToken: () => "tok" });
    for (const [where, owner] of [[kept, "dead-kept"], [removed, "dead-removed"]] as const) {
      store.handle.prepare("INSERT INTO watch_lease (runner, repo, owner, generation, started_at, expires_at, heartbeat_at) VALUES ('mac', ?, ?, 1, ?, ?, ?)").run(where, owner, now.toISOString(), lapsed, now.toISOString());
    }
    store.createTask({ id: "stranded", title: "the build the crash interrupted" }, now);
    const ref = store.refFor("built-in", "stranded").id;
    store.placeTask(ref, removed);
    store.handle.prepare("UPDATE task SET state = 'running' WHERE id = 'stranded'").run();
    store.handle.prepare(`INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at, released_by, incarnation)
      VALUES ('lease-stranded', ?, 1, 'mac', ?, ?, ?, ?, 'reaped', 'dead-removed')`).run(ref, now.toISOString(), lapsed, now.toISOString(), lapsed);
    const runId = Number(store.handle.prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, branch, worktree, started_at) VALUES (?, 'lease-stranded', 'mac', 'builder', 'claude', 'b', ?, ?)")
      .run(ref, join(base, "pool", "stranded"), now.toISOString()).lastInsertRowid);
    store.close();

    const channel = memoryChannel("worker");
    const said: RoleToParent[] = [];
    channel.parent.onMessage(message => { said.push(message); if (message.type === "log") lines.push(message.line); });
    const start = { type: "start" as const, role: "worker" as const, databaseFile: db, containment: null, build: buildIdentity(PACKAGE_VERSION, fileURLToPath(new URL("./operate.ts", import.meta.url))),
      config: { runner: "mac", token: "tok", repos: [kept], pinnedRepos: [kept], projectRoots: [], registryPath, pool: join(base, "pool"), forMs: null, publicUrl: null,
        stopGraceMs: 1_000, verbose: false, terminal: false, leaseWaitMs: 5_000 } };
    const running = runUpRole(start, channel.port);
    try {
      await until("the replacement worker to be ready", () => said.some(one => one.type === "ready") || said.find(one => one.type === "failed" || one.type === "fatal"));
      expect(said.filter(one => one.type === "failed" || one.type === "fatal"), lines.join("\n")).toEqual([]);
      const after = openStore(db);
      try {
        // Recovered before the worker said it was ready: the run ends interrupted and the task is queued again.
        expect(after.getTask("stranded")?.state).toBe("queued");
        expect(after.handle.prepare("SELECT outcome, reason FROM run WHERE id = ?").get(runId)).toEqual({ outcome: "failed", reason: "interrupted" });
      } finally { after.close(); }
      // … and only then is the removed project let go of.
      await until("the removed project to be let go", () => { const s2 = openStore(db); try { return !s2.getRunner("mac")!.runner.repos.includes(removed); } finally { s2.close(); } });
      const last = openStore(db);
      try { expect(last.getRunner("mac")!.runner.repos).toEqual([kept]); } finally { last.close(); }
    } finally {
      channel.parent.stop(false);
      expect(await running, lines.join("\n")).toBe(0);
    }
  }, 60_000);

  test("codex round 1 #2: a removed project whose predecessor's lease can't be taken over stays bound, and the worker stops", async () => {
    const kept = realpathSync(repo);
    mkdirSync(join(base, "removed"));
    const removed = realpathSync(join(base, "removed"));
    const registryPath = join(base, "repos.json");
    expect(await updateRepos(registryPath, current => addRepos(current, [kept]))).toMatchObject({ ok: true });
    const now = new Date();
    const store = openStore(db);
    register(store, { name: "mac", host: "test", capacity: 2, repos: [kept, removed], now, newToken: () => "tok" });
    // Still renewing as far as the store can tell: never handed over inside the wait.
    store.handle.prepare("INSERT INTO watch_lease (runner, repo, owner, generation, started_at, expires_at, heartbeat_at) VALUES ('mac', ?, 'dead-removed', 1, ?, ?, ?)")
      .run(removed, now.toISOString(), new Date(now.getTime() + 600_000).toISOString(), now.toISOString());
    store.close();
    const channel = memoryChannel("worker");
    const said: RoleToParent[] = [];
    channel.parent.onMessage(message => { said.push(message); if (message.type === "log") lines.push(message.line); });
    const start = { type: "start" as const, role: "worker" as const, databaseFile: db, containment: null, build: buildIdentity(PACKAGE_VERSION, fileURLToPath(new URL("./operate.ts", import.meta.url))),
      config: { runner: "mac", token: "tok", repos: [kept], pinnedRepos: [kept], projectRoots: [], registryPath, pool: join(base, "pool"), forMs: null, publicUrl: null,
        stopGraceMs: 1_000, verbose: false, terminal: false, leaseWaitMs: 1_500 } };
    const code = await runUpRole(start, channel.port);
    expect(code).not.toBe(0);
    expect(said.some(one => one.type === "ready")).toBe(false);
    expect(said.find(one => one.type === "fatal")).toMatchObject({ detail: expect.stringContaining("another watch holds") });
    const after = openStore(db);
    try { expect(after.getRunner("mac")!.runner.repos).toContain(removed); } finally { after.close(); }
  }, 60_000);

  test("a role child takes its start only from `up`'s channel, refuses a console start carrying a token, and refuses another build", async () => {
    const entry = fileURLToPath(new URL("./up-role-child.ts", import.meta.url));
    const tsx = import.meta.resolve("tsx");
    const child = (role: string, start: unknown) => new Promise<{ code: number | null; messages: unknown[] }>(resolve => {
      const messages: unknown[] = [];
      const one = fork(entry, [role], { execArgv: ["--import", tsx], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      one.on("message", message => messages.push(message));
      one.on("exit", code => resolve({ code, messages }));
      one.send(start);
    });
    const consoleConfig = { host: "127.0.0.1", port: PORT + 2, allowedHosts: null, publicUrl: null, localRunner: "w", poolRoot: base, repos: [], projectRoots: [], registryPath: join(base, "repos.json"), editor: false };
    // A console never holds the runner token: a start that hands it one is not a start at all.
    expect(await child("console", { type: "start", role: "console", databaseFile: db, containment: null, build: "x", config: { ...consoleConfig, token: "secret" } })).toMatchObject({ code: 2, messages: [] });
    // The role on the command line and the one started must agree.
    expect(await child("worker", { type: "start", role: "console", databaseFile: db, containment: null, build: "x", config: consoleConfig })).toMatchObject({ code: 2 });
    // Another build's start is refused before the role opens a port or touches work.
    const refused = await child("console", { type: "start", role: "console", databaseFile: db, containment: null, build: "0.0.0+someone-else", config: consoleConfig });
    expect(refused.code).toBe(3);
    expect(refused.messages).toEqual([expect.objectContaining({ type: "failed", reason: "start", detail: expect.stringContaining("different build") })]);
  }, 60_000);
});
