/**
 * The daily storage sweep: one worker takes each day, every part runs whatever another did, a failure brings the next
 * sweep forward, and what it did is saved for `toolroll storage` and Settings → Storage. The worker's own pass runs it
 * without anyone running a command; the unit tests keep it off unless a test turns it on.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { htmlString } from "./html.js";
import { withFormToken } from "./server/request-context.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { run } from "./exec.js";
import { runOperate } from "./operate.js";
import { WorktreePool } from "./worktree.js";
import { storageHtml } from "./storage-ui.js";
import type { CheckoutPlan } from "./checkout-cleanup.js";
import { COMPLETION_ACTION } from "./result-completion.js";
import type { Located } from "./orphan-sweep.js";
import type { ProcessRow } from "./run-closeout.js";
import { linkInto, sharedCopies } from "./shared-deps.js";
import { runtimesInUse } from "./staged-runtimes.js";
import { lastSweep, nextSweepAt, RETRY_MS, saveSweep, sweepDetails, executeSweep as sweepStorage, sweepWords, SWEEP_EVERY_MS, type SweepDeps, type SweepPart, type SweepRecord } from "./storage-sweep.js";
import { sweepStorage as childSweep, liveUse } from "./storage-sweep.js";
import { sweepObservations } from "../test/sweep-observations.js";
import { storageSweepSupervisor, type SweepCompletion } from "./storage-sweep-process.js";
import { idleStorageSweep, type SweepSchedule } from "./storage-sweep-schedule.js";
import { registerRunner } from "../test/tick-kit.js";

// The direct seam is only for small deterministic unit tests. Production always uses the child. Only the service
// (a caller with an owner) claims a sweep.
const service = {};
const dailyStorageSweep = (store: Store, deps: SweepDeps, now: () => Date) => new Promise<SweepRecord | null>((resolve, reject) => {
  let launched = false;
  idleStorageSweep(store, { owner: service, ...deps }, now, {
    running: false, stop() {},
    start(_request, complete) {
      launched = true;
      void sweepStorage(store, deps, now).then(record => { complete({ ok: true, record }); resolve(record); }, reject);
      return true;
    },
  });
  if (!launched) resolve(null);
});

const DAY = 86_400_000;
let dir: string, file: string, store: Store, temp: string;
const before = process.env["TOOLROLL_STORAGE_SWEEP"];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-sweep-"));
  file = join(dir, "orders.db");
  temp = join(dir, "tmp");
  mkdirSync(temp);
  store = openStore(file);
  // On for these tests: they sweep only their own folders.
  delete process.env["TOOLROLL_STORAGE_SWEEP"];
});
const spawned: number[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const pid of spawned.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  if (before === undefined) delete process.env["TOOLROLL_STORAGE_SWEEP"]; else process.env["TOOLROLL_STORAGE_SWEEP"] = before;
  try { store.close(); } catch { /* closed by the test */ }
  rmSync(dir, { recursive: true, force: true });
});

/** Leftover test folders: `stale` untouched for two days, one fresh, one not a test's. */
function leftovers(stale: number): string[] {
  const old = new Date(Date.now() - 2 * DAY);
  const made: string[] = [];
  for (let at = 0; at < stale; at++) {
    const path = join(temp, `so-route-cli-${at}`);
    mkdirSync(path);
    writeFileSync(join(path, "db.sqlite"), "x");
    utimesSync(join(path, "db.sqlite"), old, old);
    utimesSync(path, old, old);
    made.push(path);
  }
  mkdirSync(join(temp, "no-wt-fresh"));
  mkdirSync(join(temp, "someone-elses"));
  utimesSync(join(temp, "someone-elses"), old, old);
  return made;
}

const deps = (more: Partial<SweepDeps> = {}): SweepDeps => ({ databaseFile: file, pool: null, tempRoots: [temp], census: () => [], locate: () => new Map(), inUse: () => [], scripts: () => [], ...more });

test("once a day, one worker takes the sweep; it removes stale test temp folders by itself and saves what it did", async () => {
  const stale = leftovers(3);
  const t0 = new Date();
  const first = await dailyStorageSweep(store, deps(), () => t0);
  expect(first).not.toBeNull();
  expect(first!.parts.find(one => one.kind === "test temp")).toMatchObject({ count: 3, failed: 0 });
  for (const path of stale) expect(existsSync(path)).toBe(false);
  expect(readdirSync(temp).sort()).toEqual(["no-wt-fresh", "someone-elses"]);
  // The same day: nobody's to take.
  expect(await dailyStorageSweep(store, deps(), () => new Date(t0.getTime() + DAY - 1))).toBeNull();
  expect(nextSweepAt(store)).toBe(new Date(t0.getTime() + SWEEP_EVERY_MS).toISOString());
  // Saved, and in the ledger.
  expect(lastSweep(store)).toMatchObject({ at: t0.toISOString(), source: "automatic", actor: "worker" });
  expect(sweepWords(lastSweep(store)!.parts)).toBe("Removed 3 test temp folders.");
  expect(store.actionLedger({ repos: null }).find(one => one.action === "storage sweep")).toMatchObject({ outcome: "removed", source: "policy", detail: "Removed 3 test temp folders." });
  // The next day it runs again; nothing due is said so (the fresh folder was touched that day).
  const nextDay = new Date(t0.getTime() + DAY);
  utimesSync(join(temp, "no-wt-fresh"), nextDay, nextDay);
  const next = await dailyStorageSweep(store, deps(), () => nextDay);
  expect(sweepWords(next!.parts)).toBe("Nothing was due.");
});

test("two workers on the same database: exactly one sweeps the day", async () => {
  leftovers(1);
  const other = openStore(file);
  try {
    const at = new Date();
    const both = await Promise.all([dailyStorageSweep(store, deps(), () => at), dailyStorageSweep(other, deps(), () => at)]);
    expect(both.filter(one => one !== null)).toHaveLength(1);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM storage_sweep").get()!["n"]).toBe(1);
  } finally { other.close(); }
});

test("turned off, the worker never sweeps", async () => {
  const stale = leftovers(1);
  process.env["TOOLROLL_STORAGE_SWEEP"] = "off";
  expect(await dailyStorageSweep(store, deps(), () => new Date())).toBeNull();
  expect(existsSync(stale[0]!)).toBe(true);
  expect(nextSweepAt(store)).toBeNull();
});

test("a part that fails is said, the others still run, and the next sweep comes an hour later", async () => {
  const stale = leftovers(1);
  const at = new Date();
  const swept = await dailyStorageSweep(store, deps({ census: () => { throw new Error("ps refused"); } }), () => at);
  expect(swept!.parts.find(one => one.kind === "orphans")).toMatchObject({ count: 0, problem: "the process list couldn't be read" });
  expect(existsSync(stale[0]!)).toBe(false);
  expect(sweepWords(swept!.parts)).toBe("Removed 1 test temp folder. Couldn't check processes.");
  expect(store.actionLedger({ repos: null }).find(one => one.action === "storage sweep")).toMatchObject({ outcome: "partial" });
  expect(await dailyStorageSweep(store, deps(), () => new Date(at.getTime() + RETRY_MS - 1))).toBeNull();
  expect(await dailyStorageSweep(store, deps(), () => new Date(at.getTime() + RETRY_MS))).not.toBeNull();
});

test("extra staged runtimes are swept; with no runtime in use, every runtime stays and the sweep says why", async () => {
  const staged = join(dir, "staged-upgrades");
  for (const [name, age] of [["browser-0", 12], ["browser-a", 9], ["browser-b", 5], ["browser-c", 1]] as const) {
    mkdirSync(join(staged, name, "runtime"), { recursive: true });
    const when = new Date(Date.now() - age * DAY).toISOString();
    writeFileSync(join(staged, name, "deployment.json"), JSON.stringify({ phase: "deployed", deployedAt: when }));
  }
  const refused = await sweepStorage(store, deps(), () => new Date());
  expect(refused.parts.find(one => one.kind === "runtimes")).toMatchObject({ count: 0, problem: "kept every staged runtime: no staged runtime is in use, so which one runs now is unknown" });
  const swept = await sweepStorage(store, deps({ inUse: () => [join(staged, "browser-b", "runtime", "dist", "cli.js")] }), () => new Date());
  // browser-b runs, browser-a was before it, browser-c is the newest.
  expect(swept.parts.find(one => one.kind === "runtimes")).toMatchObject({ count: 1, failed: 0, items: [join(realpathSync(staged), "browser-0")] });
  expect(readdirSync(staged).sort()).toEqual(["browser-a", "browser-b", "browser-c"]);
});

test("a one-shot reconcile neither claims nor loses the sweep; the service's own pass sweeps it, and toolroll storage shows what, when and why", async () => {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"], ["commit", "-q", "--allow-empty", "-m", "first"]]) await run("git", args, { cwd: repo });
  store.close();
  const token = registerRunner(file, "builder-1", repo, new Date());
  const stale = leftovers(2);
  let done = false;
  const options = { databaseFile: file, evidenceRoot: join(dir, "evidence"), tempRoots: [temp], shouldStop: () => done };
  let lines: string[] = [];
  const cli = async (command: string, argv: string[]) => { lines = []; const code = await runOperate(command, argv, line => { lines.push(line); }, options); return { code, out: lines.join("\n") }; };
  const empty = await cli("storage", []);
  expect(empty.out).toContain("Not swept yet.");
  expect(empty.out).toContain("Automatic sweep: waiting: no Toolroll service running.");
  // Wait for the supervisor to hand its result over (the record is saved inside that same callback), however long the
  // child takes on a busy machine.
  const supervisor = storageSweepSupervisor(file);
  const start = supervisor.start.bind(supervisor);
  let finished!: (result: SweepCompletion) => void;
  const completion = new Promise<SweepCompletion>(resolve => { finished = resolve; });
  const launch = vi.spyOn(supervisor, "start").mockImplementation((request, complete, owner) =>
    start(request, result => { try { complete(result); } finally { finished(result); done = true; } }, owner));
  cleanups.push(() => launch.mockRestore());
  // A one-shot reconcile exits before a child would finish: it leaves the sweep, unclaimed, to the service.
  const pass = await cli("reconcile", ["--repo", repo, "--pool", join(dir, "worktrees"), "--json"]);
  expect(pass.code).toBe(0);
  expect(JSON.parse(pass.out).storageSweep).toBeNull();
  expect(launch).not.toHaveBeenCalled();
  store = openStore(file);
  expect(store.serviceCursor("storage-sweep")).toBe(0);
  expect(lastSweep(store)).toBeNull();
  store.close();
  for (const path of stale) expect(existsSync(path)).toBe(true);
  // The long-lived service's pass claims it and saves what it did; its stop fence lands once the sweep is saved.
  const watch = await cli("watch", ["--runner", "builder-1", "--token", token, "--repo", repo, "--pool", join(dir, "worktrees"),
    "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "25", "--json"]);
  expect(watch.code, watch.out).toBe(0);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(await completion).toMatchObject({ ok: true });
  store = openStore(file);
  expect(lastSweep(store)?.parts.find(one => one.kind === "test temp")).toMatchObject({ count: 2 });
  store.close();
  for (const path of stale) expect(existsSync(path)).toBe(false);
  const shown = await cli("storage", []);
  expect(shown.out).toMatch(/Last swept .+ automatically: Removed 2 test temp folders\./);
  // The service has stopped, so the next sweep says what it waits for.
  expect(shown.out).toContain("Automatic sweep: waiting: no Toolroll service running.");
  expect(shown.out).toContain(`  ${stale[0]}`);
  const json = JSON.parse((await cli("storage", ["--json"])).out) as { sweep: { last: { source: string; parts: SweepPart[] }; schedule: SweepSchedule } };
  expect(json.sweep.last.source).toBe("automatic");
  expect(json.sweep.last.parts.map(one => one.kind)).toEqual(["test temp", "orphans", "checkouts", "runtimes", "dependencies"]);
  expect(json.sweep.schedule).toMatchObject({ state: "no-service", busy: null });
  expect(Date.parse(json.sweep.schedule.nextAt!)).toBeGreaterThan(Date.now());
  // A later one-shot pass doesn't sweep again either.
  const again = JSON.parse((await cli("reconcile", ["--repo", repo, "--pool", join(dir, "worktrees"), "--json"])).out) as { storageSweep: unknown };
  expect(again.storageSweep).toBeNull();
  expect(launch).toHaveBeenCalledTimes(1);
  store = openStore(file);
});

/** Deploys' stages, `[name, age in days]`, each finished. */
function stages(...made: [string, number][]): string {
  const staged = join(dir, "staged-upgrades");
  for (const [name, age] of made) {
    mkdirSync(join(staged, name, "runtime", "dist"), { recursive: true });
    writeFileSync(join(staged, name, "deployment.json"), JSON.stringify({ phase: "deployed", deployedAt: new Date(Date.now() - age * DAY).toISOString() }));
  }
  return staged;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleeper = (cwd: string) => { const child = spawn("sleep", ["300"], { cwd, detached: true, stdio: "ignore" }); spawned.push(child.pid!); return child.pid!; };

/**
 * Oct 10 and Oct 12: the daily sweep ran while builds ran, and they ended (interrupted) the moment it finished. A run
 * here uses one of each thing the sweep removes: a stale-looking test temp folder its process works in, which links a
 * shared dependency install unused for a week; an extra staged runtime its process runs from; and its checkout, with a
 * leftover server in it. While the run is open nothing of it goes and nothing stops; once only its lease stands, the
 * checkout and the server stay; once that is let go too, the next sweep removes and stops all of it.
 */
test("a production child sweep while a build runs leaves everything the build uses; the next sweep after it ends removes it", async () => {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"], ["commit", "-q", "--allow-empty", "-m", "first"]]) await run("git", args, { cwd: repo });
  register(store, { name: "builder-1", host: "test", now: new Date() });
  const pool = new WorktreePool(store, { root: join(dir, "worktrees") });
  const old = new Date(Date.now() - 2 * DAY);
  // The build: its task, its leased checkout, its open run and its lease.
  store.createTask({ id: "live", title: "live" }, old);
  const ref = store.refFor("built-in", "live").id;
  store.placeTask(ref, repo);
  const leased = await pool.lease({ repo, branch: "toolroll/live", base: "main", runner: "builder-1", taskRef: ref, now: old });
  if (!leased.ok) throw new Error(leased.message);
  const checkout = leased.worktree.path;
  const runId = store.startRun({ taskRef: ref, leaseId: "l-live", runner: "builder-1", branch: "toolroll/live", worktree: checkout,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: old });
  store.handle.prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES ('l-live', ?, 1, 'builder-1', ?, ?, ?)")
    .run(ref, old.toISOString(), new Date(Date.now() + DAY).toISOString(), old.toISOString());
  // A shared install nobody linked for a week, linked from the folder the build's process works in.
  const depsDir = join(dir, "deps", "a".repeat(24));
  mkdirSync(join(depsDir, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(depsDir, "ready.json"), JSON.stringify({ version: 1, repo, key: "a".repeat(24), lock: "x", node: "v22", setup: "s", tree: null, createdAt: old.toISOString() }));
  const work = join(temp, "so-build-work");
  mkdirSync(work);
  expect(linkInto(work, join(depsDir, "node_modules"))).toBe("link");
  const weekAgo = new Date(Date.now() - 8 * DAY);
  utimesSync(join(depsDir, "ready.json"), weekAgo, weekAgo);
  for (const one of [join(work, "node_modules"), work]) utimesSync(one, old, old);
  // Stages: browser-b runs the service, browser-a was before it, browser-c is newest: browser-0 is extra.
  const staged = stages(["browser-0", 12], ["browser-a", 9], ["browser-b", 5], ["browser-c", 1]);
  const extraStage = join(realpathSync(staged), "browser-0");
  // The build's own process (witnessed) works in the temp folder and runs the extra stage's node; a server it left
  // running in its checkout has lost its parent.
  const build = sleeper(work);
  store.recordRunProcess(runId, build, new Date());
  const server = sleeper(checkout);
  const census = (): ProcessRow[] => [
    { pid: build, ppid: process.pid, pgid: build, bornAt: Date.now() - 60_000, name: "node", terminal: false },
    { pid: server, ppid: 1, pgid: server, bornAt: Date.now() - 60_000, name: "node", terminal: false },
  ].filter(one => alive(one.pid));
  const where = new Map<number, Located>([[build, { cwd: work, exe: join(extraStage, "runtime", "node") }], [server, { cwd: checkout }]]);
  const counts = (record: { parts: SweepPart[] }) => Object.fromEntries(record.parts.map(one => [one.kind, one.count]));
  const observations = sweepObservations(dir);
  cleanups.push(observations.restore);
  const home = join(dir, "synthetic-home");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync(join(staged, "browser-b", "runtime", "dist", "cli.js"), join(home, ".local", "bin", "toolroll"));
  const sweep = () => {
    observations.write(census().map(row => ({ ...row, ...where.get(row.pid) })), { home });
    // No in-process hooks cross this call: the child opens its own Store and WorktreePool.
    return childSweep(store, { databaseFile: file, pool, tempRoots: [temp], actor: "test-operator" }, () => new Date());
  };

  const during = await sweep();
  expect(counts(during)).toEqual({ "test temp": 0, orphans: 0, checkouts: 0, runtimes: 0, dependencies: 0 });
  expect(during.parts.filter(one => one.failed > 0 || one.problem !== undefined)).toEqual([]);
  expect([work, depsDir, extraStage, checkout].map(existsSync)).toEqual([true, true, true, true]);
  expect([alive(build), alive(server)]).toEqual([true, true]);
  expect(store.getRun(runId)!.outcome).toBeNull();

  // The run ends and its task is complete; its lease still stands.
  store.finishRun(runId, { outcome: "built", now: new Date() });
  process.kill(build, "SIGTERM");
  await expect.poll(() => alive(build)).toBe(false);
  expect((await pool.release(checkout, new Date())).ok).toBe(true);
  store.setTaskState("live", "done", new Date());
  store.recordAction({ at: new Date().toISOString(), actor: "operator:alex", repo, taskId: "live", runId, action: COMPLETION_ACTION, outcome: "a".repeat(64), source: "work" });
  const leaseOnly = await sweep();
  expect(counts(leaseOnly)).toEqual({ "test temp": 1, orphans: 0, checkouts: 0, runtimes: 1, dependencies: 1 });
  expect([work, depsDir, extraStage, checkout].map(existsSync)).toEqual([false, false, false, true]);
  expect(alive(server)).toBe(true);

  // The lease is let go: the next sweep stops the server and removes the checkout.
  store.handle.prepare("UPDATE claim SET released_at = ?, released_by = 'released' WHERE lease_id = 'l-live'").run(new Date().toISOString());
  const after = await sweep();
  expect(counts(after)).toMatchObject({ orphans: 1, checkouts: 1 });
  expect(existsSync(checkout)).toBe(false);
  expect(alive(server)).toBe(false);
  expect(sharedCopies(join(dir, "deps"))).toEqual([]);
  expect(lastSweep(store)).toMatchObject({ actor: "test-operator", parts: after.parts });
}, 30_000);

test("with a build running and its processes unreadable, nothing goes; with nothing running, the sweep is as before", async () => {
  const stale = leftovers(1);
  store.createTask({ id: "live", title: "live" }, new Date());
  const runId = store.startRun({ taskRef: store.refFor("built-in", "live").id, leaseId: "l-live", runner: "builder-1", branch: "toolroll/live", worktree: join(dir, "nowhere"),
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: new Date() });
  store.recordRunProcess(runId, process.pid, new Date());
  const blind = deps({ census: () => { throw new Error("ps refused"); } });
  expect((await sweepStorage(store, blind, () => new Date())).parts.find(one => one.kind === "test temp")).toMatchObject({ count: 0 });
  expect(existsSync(stale[0]!)).toBe(true);
  store.finishRun(runId, { outcome: "built", now: new Date() });
  expect((await sweepStorage(store, blind, () => new Date())).parts.find(one => one.kind === "test temp")).toMatchObject({ count: 1 });
  expect(existsSync(stale[0]!)).toBe(false);
});

test("live-use checks see newly started children, missing checkout rows and unreadable live working folders", () => {
  store.createTask({ id: "live", title: "live" }, new Date());
  const worktree = join(dir, "unregistered-checkout"), resource = join(temp, "so-late-child");
  const runId = store.startRun({ taskRef: store.refFor("built-in", "live").id, leaseId: "l-live", runner: "builder-1", branch: "toolroll/live", worktree,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: new Date() });
  store.recordRunProcess(runId, process.pid, new Date());
  const rows: ProcessRow[] = [{ pid: process.pid, ppid: 1, pgid: process.pid, bornAt: Date.now(), name: "node", terminal: false }];
  const locations = new Map<number, Located>([[process.pid, { cwd: dir }]]);
  const guard = liveUse(store, deps({ census: () => rows, locate: () => locations }), () => new Date());
  expect(guard(worktree)).toBe(true);
  expect(guard(resource)).toBe(false);
  // The witness PID is unchanged; a cached process tree would miss this child on the post-rename check.
  rows.push({ pid: 1_234_567, ppid: process.pid, pgid: process.pid, bornAt: Date.now(), name: "node", terminal: false });
  locations.set(1_234_567, { cwd: resource });
  expect(guard(resource)).toBe(true);
  locations.delete(process.pid);
  expect(guard(join(dir, "otherwise-unused"))).toBe(true);
});

test("the runtime the CLI links point to stays, on PATH or not; another extra runtime still goes", async () => {
  const staged = stages(["browser-cli", 20], ["browser-0", 12], ["browser-a", 9], ["browser-b", 5], ["browser-c", 1]);
  const home = join(dir, "home");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync(join(staged, "browser-cli", "runtime", "dist", "cli.js"), join(home, ".local", "bin", "toolroll"));
  // The worker's PATH (launchd's) doesn't have the link folder on it.
  const swept = await sweepStorage(store, deps({ inUse: () => runtimesInUse([join(staged, "browser-b", "runtime", "dist", "cli.js")], home, "/usr/bin:/bin") }), () => new Date());
  expect(swept.parts.find(one => one.kind === "runtimes")).toMatchObject({ count: 1, failed: 0, items: [join(realpathSync(staged), "browser-0")] });
  expect(readdirSync(staged).sort()).toEqual(["browser-a", "browser-b", "browser-c", "browser-cli"]);
});

const plan = (more: Partial<CheckoutPlan> = {}): CheckoutPlan => ({ at: new Date().toISOString(), cleanup: "finished", manual: true, go: [], stay: [], count: 0, totalBytes: 0, freeBytes: 0, waitingReview: 0, withChanges: 0, ...more });
const part = (kind: SweepPart["kind"], count: number, more: Partial<SweepPart> = {}): SweepPart => ({ kind, count, bytes: 0, failed: 0, items: [], ...more });

test("Settings → Storage says when the last sweep ran and what it did, then why the next waits; its paths sit behind Details", () => {
  const view = (last: Parameters<typeof storageHtml>[0]["sweep"]) => htmlString(withFormToken("c".repeat(64), () => storageHtml({ plan: plan(), csrf: "c".repeat(64), ...(last === undefined ? {} : { sweep: last }) }, {})));
  const schedule = (state: SweepSchedule["state"], more: Partial<SweepSchedule> = {}): SweepSchedule => ({ state, lastAt: null, nextAt: null, busy: null, ...more });
  const never = view({ last: null, off: false, schedule: schedule("no-service") });
  expect(never).toContain("<p>Not swept yet.</p>");
  expect(never).toContain('<p class="meta" data-sweep-state="no-service">Automatic sweep: waiting: no Toolroll service running.</p>');
  expect(never).not.toContain("idle");
  expect(view({ last: null, off: true, schedule: schedule("off") })).toContain("Automatic sweep: off.");
  expect(view({ last: null, off: false, schedule: schedule("busy", { busy: "run" }) })).toContain("Automatic sweep: due, waiting: work is running.");
  const at = "2026-10-04T03:12:00.000Z";
  const recent = view({ last: { at, source: "automatic", actor: "worker", parts: [part("test temp", 1)] }, off: false, schedule: schedule("recent", { lastAt: at, nextAt: "2026-10-05T03:12:00.000Z" }) });
  expect(recent).toMatch(/Swept <time datetime="2026-10-04T03:12:00.000Z">[^<]+<\/time>\. Removed 1 test temp folder\.<\/p><p class="meta" data-sweep-state="recent">Automatic sweep: swept recently, next due Oct \d+, \d+:12 [AP]M\.<\/p>/);
  const normal = view({ last: { at, source: "automatic", actor: "worker", parts: [part("test temp", 104_990, { items: ["/tmp/so-route-cli-1"] }), part("orphans", 1, { items: ["node (4123), 4 days, in /state/worktrees/site/build-1"] }), part("checkouts", 2, { bytes: 600 * 1024 ** 2 })] } });
  expect(normal).toContain(`<time datetime="${at}">`);
  expect(normal).toContain("Removed 104,990 test temp folders and 2 finished checkouts, about 600 MB. Stopped 1 leftover process.");
  expect(normal).toContain("<summary>Details</summary>");
  expect(normal).toContain("node (4123), 4 days, in /state/worktrees/site/build-1");
  expect(normal).not.toContain('class="problem"');
  const nothing = view({ last: { at, source: "automatic", actor: "worker", parts: [part("test temp", 0)] } });
  expect(nothing).toContain("Nothing was due.");
  expect(nothing).not.toContain("<summary>Details</summary>");
  const failed = view({ last: { at, source: "automatic", actor: "worker", parts: [part("test temp", 3, { failed: 2 }), part("orphans", 0, { problem: "working folders couldn't be read: lsof could not list working folders" })] } });
  expect(failed).toContain('<p class="problem">');
  expect(failed).toContain("Removed 3 test temp folders. 2 couldn&#39;t be removed. Couldn&#39;t check processes.");
  expect(failed).toContain("Leftover processes: working folders couldn&#39;t be read");
  const manual = view({ last: { at, source: "manual", actor: "alex", parts: [part("checkouts", 1)] } });
  expect(manual).toContain("Cleaned up by alex");
  expect(view(undefined)).not.toContain("data-last-sweep");
});

test("the details list what each part did, cut short with a count, and what's left for later", () => {
  const items = Array.from({ length: 20 }, (_, at) => `/tmp/so-${at}`);
  expect(sweepDetails([part("test temp", 25, { items, more: true })])).toEqual(["More test temp folders are left for the next sweep.", ...items, "… and 5 more test temp folders"]);
  saveSweep(store, { at: new Date().toISOString(), source: "manual", actor: "alex", parts: [part("checkouts", 0)] });
  expect(lastSweep(store, "automatic")).toBeNull();
  expect(lastSweep(store)).toMatchObject({ source: "manual", actor: "alex" });
});
