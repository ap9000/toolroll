/**
 * Orphans Toolroll left running: the storage sweep stops a parent-1 process running from a let-go checkout (born
 * before it was let go) or from a test temp root whose suite is gone, with what it started, each in the ledger. Never
 * a live run's checkout, a process somebody started since, one with a live parent, one at a terminal, the service,
 * a reused pid, or anything outside Toolroll's folders. Real processes and real signals; the process listing is given
 * (this sandbox may refuse `ps`), built from what the processes report about themselves.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { run } from "./exec.js";
import { WorktreePool } from "./worktree.js";
import { locateProcesses, orphanTargets, sweepOrphans, sweepRoots, type Located, type SweepRoot } from "./orphan-sweep.js";
import { protectedProcesses, type ProcessRow } from "./run-closeout.js";
import { OWNER_FILE } from "./test-temp.js";

const DAY = 86_400_000;
let dir: string, store: Store, repo: string, pool: WorktreePool, temps: string;
const spawned: number[] = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-orphans-"));
  temps = join(dir, "tmp");
  mkdirSync(temps);
  repo = join(dir, "repo");
  mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  register(store, { name: "builder-1", host: "test", now: new Date() });
  const git = (args: string[]) => run("git", args, { cwd: repo });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "first"]);
  pool = new WorktreePool(store, { root: join(dir, "worktrees") });
});
afterEach(() => {
  for (const pid of spawned.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (done: () => boolean, ms = 30_000) => { const end = Date.now() + ms; while (!done() && Date.now() < end) await new Promise(next => setTimeout(next, 25)); return done(); };
const row = (pid: number, bornAt: number, more: Partial<ProcessRow> = {}): ProcessRow => ({ pid, ppid: 1, pgid: pid, bornAt, name: "node", terminal: false, ...more });
const sleeper = (cwd: string) => { const child = spawn("sleep", ["300"], { cwd, detached: true, stdio: "ignore" }); spawned.push(child.pid!); return child.pid!; };

/** A task whose run used a checkout; `live`: its run is still going and the checkout leased. */
async function checkout(id: string, at: Date, live = false): Promise<string> {
  store.createTask({ id, title: id }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, repo);
  const leased = await pool.lease({ repo, branch: `toolroll/${id}`, base: "main", runner: "builder-1", taskRef: ref, now: at });
  if (!leased.ok) throw new Error(leased.message);
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: leased.worktree.path,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: at });
  if (!live) {
    store.finishRun(runId, { outcome: "built", now: at });
    expect((await pool.release(leased.worktree.path, at)).ok).toBe(true);
  }
  return leased.worktree.path;
}

test("which processes go: orphans born in a let-go checkout or running a temp root's program, and what they started — nothing else", () => {
  const released = Date.now() - 60_000;
  const roots: SweepRoot[] = [{ path: "/state/worktrees/site/build-1", kind: "checkout", bornBefore: released }, { path: "/tmp/so-e2e-x", kind: "test temp" }];
  const census = [
    row(10, released - 5_000),                           // a preview server the run started: goes
    row(11, released - 4_000, { ppid: 10, pgid: 10 }),   // what it started: goes with it
    row(12, released + 60_000),                          // started in that checkout after the run let it go: stays
    row(13, released - 5_000),                           // an orphan elsewhere: stays
    row(14, released - 5_000, { terminal: true }),       // at a terminal: stays
    row(15, released - 5_000, { ppid: 400 }),            // a live parent (a person's shell, the lead's deploy): stays
    row(16, released - 5_000),                           // a browser a killed journey left, its program in a temp root: goes
    row(17, released - 5_000),                           // the folder's name only starts the same: stays
    row(400, released - 9_000, { ppid: 1, terminal: true }),
  ];
  const located = new Map<number, Located>([
    [10, { cwd: "/state/worktrees/site/build-1", exe: "/usr/local/bin/node" }], [11, { cwd: "/state/worktrees/site/build-1/dist" }],
    [12, { cwd: "/state/worktrees/site/build-1" }], [13, { cwd: "/Users/someone/project" }], [14, { cwd: "/state/worktrees/site/build-1" }],
    [15, { cwd: "/state/worktrees/site/build-1" }], [16, { cwd: "/", exe: "/tmp/so-e2e-x/chrome/Chromium" }], [17, { cwd: "/state/worktrees/site/build-10" }],
  ]);
  const guard = { pids: new Set<number>([1]), groups: new Set<number>() };
  expect(orphanTargets(census, located, roots, guard).map(one => [one.row.pid, one.orphan]).sort()).toEqual([[10, 10], [11, 10], [16, 16]]);
  // The live service and its group never go, even from inside.
  const service = protectedProcesses([...census, row(process.pid, released - 9_000, { ppid: 1, pgid: 10 })], process.pid);
  expect(orphanTargets(census, located, roots, service).map(one => one.row.pid)).toEqual([16]);
});

test("the roots: let-go checkouts with no live run, and temp roots whose suite is gone or untouched for a day", async () => {
  const at = new Date(Date.now() - 60_000);
  const done = await checkout("done", at);
  const live = await checkout("live", at, true);
  const owned = (name: string, owner: { pid: number; startedAt: number } | null, touched = new Date()) => {
    const path = join(temps, name);
    mkdirSync(path);
    if (owner !== null) writeFileSync(join(path, OWNER_FILE), JSON.stringify({ pid: owner.pid, startedAt: new Date(owner.startedAt).toISOString() }));
    utimesSync(path, touched, touched);
    if (owner !== null) utimesSync(join(path, OWNER_FILE), touched, touched);
    return path;
  };
  const running = owned("so-e2e-tmp-running", { pid: 4242, startedAt: Date.now() - 5_000 });
  const gone = owned("so-e2e-tmp-gone", { pid: 4343, startedAt: Date.now() - 5_000 });
  const fresh = owned("so-route-cli-fresh", null);
  const stale = owned("so-route-cli-stale", null, new Date(Date.now() - 2 * DAY));
  owned("not-ours", null, new Date(Date.now() - 2 * DAY));
  const census = [row(4242, Date.now() - 5_000)];
  const roots = sweepRoots(store, pool, census, [temps], new Date());
  expect(roots.map(one => one.path).sort()).toEqual([done, gone, stale].sort());
  expect(roots.find(one => one.path === done)).toMatchObject({ kind: "checkout", bornBefore: expect.any(Number), taskId: "done" });
  expect(roots.map(one => one.path)).not.toContain(live);
  expect(roots.map(one => one.path)).not.toContain(running);
  expect(roots.map(one => one.path)).not.toContain(fresh);
});

test("a preview server left in a finished task's checkout is stopped and logged; one in a live run's checkout and one elsewhere stay", async () => {
  const at = new Date(Date.now() - 60_000);
  const done = await checkout("site", at);
  const live = await checkout("still-building", at, true);
  const elsewhere = mkdtempSync(join(dir, "elsewhere-"));
  const server = sleeper(done);
  const building = sleeper(live);
  const unrelated = sleeper(elsewhere);
  const born = at.getTime() - 1_000;
  const census = () => [server, building, unrelated].filter(alive).map(pid => row(pid, born, { name: "sleep" }));
  const locate = (pids: readonly number[]) => new Map(pids.flatMap(pid => {
    const cwd = pid === server ? done : pid === building ? live : pid === unrelated ? elsewhere : null;
    return cwd === null ? [] : [[pid, { cwd }] as const];
  }));
  const swept = await sweepOrphans(store, () => new Date(), { pool, tempRoots: [temps], census, locate, graceMs: 2_000 });
  expect(swept.failed).toEqual([]);
  expect(swept.stopped.map(one => one.pid)).toEqual([server]);
  expect(await until(() => !alive(server))).toBe(true);
  expect(alive(building)).toBe(true);
  expect(alive(unrelated)).toBe(true);
  const logged = store.actionLedger({ repos: null }).filter(one => one.action === "orphan process stopped");
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ taskId: "site", outcome: "stopped", detail: expect.stringMatching(new RegExp(`^sleep \\(${server}\\) running \\d+ min from checkout .+; its parent had gone$`)) });
});

test("a reused pid is never signalled: the second look right before the signal must find the same process", async () => {
  const at = new Date(Date.now() - 60_000);
  const done = await checkout("reused", at);
  const victim = sleeper(done);
  let looks = 0;
  const census = () => { looks++; return [row(victim, looks === 1 ? at.getTime() - 1_000 : at.getTime() - 30_000, { name: "sleep" })]; };
  const sent: number[] = [];
  const swept = await sweepOrphans(store, () => new Date(), { pool, tempRoots: [], census, locate: pids => new Map(pids.map(pid => [pid, { cwd: done }])), signal: pid => { sent.push(pid); } });
  expect(looks).toBe(2);
  expect(sent).toEqual([]);
  expect(swept.stopped).toEqual([]);
  expect(alive(victim)).toBe(true);
});

test("nothing is stopped when where processes run can't be read", async () => {
  const at = new Date(Date.now() - 60_000);
  const done = await checkout("unreadable", at);
  const server = sleeper(done);
  const sent: number[] = [];
  const swept = await sweepOrphans(store, () => new Date(), { pool, tempRoots: [], census: () => [row(server, at.getTime() - 1_000)], locate: () => { throw new Error("lsof could not list working folders"); }, signal: pid => { sent.push(pid); } });
  expect(swept).toEqual({ stopped: [], failed: ["working folders couldn't be read: lsof could not list working folders"] });
  expect(sent).toEqual([]);
  expect(alive(server)).toBe(true);
});

test("the OS says where a process runs from (its working folder), without its arguments", async () => {
  const where = mkdtempSync(join(dir, "cwd-"));
  const pid = sleeper(where);
  expect(await until(() => locateProcesses([pid]).get(pid)?.cwd !== undefined)).toBe(true);
  expect(realpathSync(locateProcesses([pid]).get(pid)!.cwd!)).toBe(realpathSync(where));
});
