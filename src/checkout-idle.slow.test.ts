/**
 * Idle cleanup (checkout-cleanup.ts): a task folder whose whole task has been idle past the limit goes even with its
 * result waiting for review or its task unfinished, only when nothing is lost, and every act a person has left still
 * works afterwards. Real git; only the agent is a stub.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkoutPlan, cleanCheckouts } from "./checkout-cleanup.js";
import { run as exec } from "./exec.js";
import { runOperate } from "./operate.js";
import { register } from "./runner.js";
import { createDecisionServer } from "./serve.js";
import { executeSweep, liveUse, sweepWords } from "./storage-sweep.js";
import { checkoutIdle, openStore, setCheckoutIdle, type Store } from "./store.js";
import { WorktreePool } from "./worktree.js";
import type { Runner } from "./builder.js";
import { AGENT_SAID, OK, concludeDone, registerRunner } from "../test/tick-kit.js";

const DAY = 86_400_000;
// Near the real clock: a few of the store's own records stamp it, and every look here is ahead of them.
const T0 = new Date(Date.now() - 60_000);
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const ROUTE = { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } as const;

describe("what goes and what stays", () => {
  let dir: string, repo: string, store: Store, pool: WorktreePool;
  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const headOf = async (cwd = repo) => (await git(["rev-parse", "HEAD"], cwd)).stdout.trim();

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-idle-")));
    repo = join(dir, "repo");
    mkdirSync(repo);
    store = openStore(join(dir, "orders.db"));
    register(store, { name: "builder-1", host: "test", now: T0 });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
    pool = new WorktreePool(store, { root: join(dir, "worktrees") });
  });
  afterEach(() => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

  /** A task whose build committed on its branch and left a let-go folder, its result waiting for review ("ready") or the task queued. */
  async function task(id: string, finish: "ready" | "queued", options: { revisionOf?: string } = {}): Promise<{ path: string; ref: number; run: number; head: string }> {
    store.createTask({ id, title: id }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo);
    if (options.revisionOf !== undefined) store.handle.prepare("UPDATE task_ref SET revision_of = ? WHERE id = ?").run(options.revisionOf, ref);
    const branch = `toolroll/${id}`;
    const leased = await pool.lease({ repo, branch, base: "main", runner: "builder-1", taskRef: ref, now: T0 });
    if (!leased.ok) throw new Error(leased.message);
    const path = leased.worktree.path;
    const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch, worktree: path, route: ROUTE, now: T0 });
    writeFileSync(join(path, `${id}.txt`), `${id}\n`);
    await git(["add", `${id}.txt`], path);
    await git(["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", id], path);
    const head = await headOf(path);
    store.handle.prepare("UPDATE run SET head_revision = ? WHERE id = ?").run(head, run);
    store.finishRun(run, { outcome: "built", now: T0 });
    expect((await pool.release(path, T0)).ok).toBe(true);
    if (finish === "ready") store.setTaskState(id, "done", T0);
    return { path, ref, run, head };
  }
  const sweep = (days: number, spare?: (path: string) => boolean) => cleanCheckouts(store, pool, () => at(days), { manual: false, actor: "worker", idle: { occupied: () => false }, ...(spare === undefined ? {} : { spare }) });
  const stayWhy = async (days: number, path: string) => (await checkoutPlan(store, pool, at(days), { manual: true })).stay.find(one => one.path === path)?.why;

  test("a clean folder past the limit goes, recent ones stay, and its branch and ledger entry remain", async () => {
    const review = await task("review", "ready");
    const unfinished = await task("unfinished", "queued");

    expect((await sweep(13)).removed).toEqual([]);
    expect(await stayWhy(13, review.path)).toBe("waiting for review");

    const plan = await checkoutPlan(store, pool, at(15), { manual: true });
    expect(plan).toMatchObject({ idle: "14d", idleCount: 2 });
    expect(plan.go).toEqual([]);
    expect(plan.stay.map(one => one.why)).toEqual(["idle", "idle"]);

    const done = await sweep(15);
    expect(done.removed.map(one => one.path).sort()).toEqual([review.path, unfinished.path].sort());
    expect(existsSync(review.path)).toBe(false);
    expect(store.getWorktree(review.path)).toBeNull();
    expect((await git(["rev-parse", "toolroll/review"])).stdout.trim()).toBe(review.head);
    const ledger = store.actionLedger({ repos: null }).filter(one => one.action === "checkout removed");
    expect(ledger.map(one => one.taskId).sort()).toEqual(["review", "unfinished"]);
    expect(ledger[0]!.detail).toContain(`idle since ${T0.toISOString().slice(0, 10)}`);
  });

  test("anyone acting on the task, or on any version of it, starts the clock again; Toolroll's own bookkeeping doesn't", async () => {
    const noted = await task("noted", "ready");
    const parent = await task("parent", "ready");
    const child = await task("child", "ready", { revisionOf: "parent" });
    const watched = await task("watched", "ready");

    store.addRunNote(noted.run, "alex", "Look at this later", at(10));
    store.recordAction({ at: at(10).toISOString(), actor: "alex", repo, taskId: "child", runId: null, action: "lead steer", outcome: "ok", source: "work" });
    store.recordAction({ at: at(10).toISOString(), actor: "follow:x", repo, taskId: "watched", runId: null, action: "assignment status observed", outcome: "ok", source: "work" });

    const first = await sweep(15);
    expect(first.removed.map(one => one.path)).toEqual([watched.path]);
    for (const one of [noted, parent, child]) expect(existsSync(one.path)).toBe(true);
    expect((await sweep(25)).removed.map(one => one.path).sort()).toEqual([noted.path, parent.path, child.path].sort());
  });

  test("uncommitted work never goes: the folder stays and is listed for a person", async () => {
    const dirty = await task("dirty", "ready");
    const edited = await task("edited", "queued");
    const own = await task("own-files", "ready");
    writeFileSync(join(dirty.path, "half-done.ts"), "// a person's work\n");
    writeFileSync(join(edited.path, "README.md"), "changed\n");
    writeFileSync(join(own.path, "STANDING-ORDERS-PROGRESS-0123456789abcdef.json"), "{}\n");

    const plan = await checkoutPlan(store, pool, at(15), { manual: true });
    expect(plan.withChanges).toBe(2);
    expect(plan.stay.filter(one => one.why === "has changes").map(one => one.path).sort()).toEqual([dirty.path, edited.path].sort());
    const done = await sweep(15);
    expect(done.removed.map(one => one.path)).toEqual([own.path]);
    expect(done.kept.map(one => one.why).sort()).toEqual(["has changes", "has changes"]);
    expect(existsSync(join(dirty.path, "half-done.ts"))).toBe(true);
  });

  test("a commit that would lose its only holder keeps the folder", async () => {
    // Moved off its branch: the commit it stands on is on no branch.
    const detached = await task("detached", "ready");
    await git(["checkout", "-q", "--detach"], detached.path);
    await git(["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "only here"], detached.path);
    // Its result's commit left the branch: only this worktree's reflog holds it.
    const rewound = await task("rewound", "ready");
    await git(["reset", "-q", "--hard", "HEAD~1"], rewound.path);
    // A ref only this worktree has.
    const own = await task("own-ref", "ready");
    await git(["update-ref", "refs/worktree/kept", "HEAD"], own.path);
    // On its branch, but the record says another one: a later lease wouldn't make this folder.
    const elsewhere = await task("elsewhere", "ready");
    await git(["checkout", "-q", "-b", "side"], elsewhere.path);

    const done = await sweep(15);
    expect(done.removed).toEqual([]);
    expect(Object.fromEntries(done.kept.map(one => [one.path, one.why]))).toEqual({
      [detached.path]: "has commits", [rewound.path]: "has commits", [own.path]: "has commits", [elsewhere.path]: "not on its branch",
    });
    for (const one of [detached, rewound, own, elsewhere]) expect(existsSync(one.path)).toBe(true);
  });

  test("a live lease, an open run, a held folder or a run starting during the sweep keeps it", async () => {
    const claimed = await task("claimed", "queued");
    const running = await task("running", "queued");
    const leased = await task("leased", "ready");
    const racing = await task("racing", "ready");
    const expired = await task("expired-claim", "queued");
    const claim = (ref: number, id: string, expires: Date) => store.handle.prepare(`INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at)
      VALUES (?, ?, 1, 'builder-1', ?, ?, ?)`).run(id, ref, T0.toISOString(), expires.toISOString(), T0.toISOString());
    claim(claimed.ref, "live", at(16));
    // A lease never released is open, even past its time: the reconciler decides what became of it, not this.
    claim(expired.ref, "stale", at(1));
    const open = store.startRun({ taskRef: running.ref, leaseId: "l-open", runner: "builder-1", branch: "toolroll/running", worktree: running.path, route: ROUTE, now: T0 });
    store.saveWorktree({ ...store.getWorktree(leased.path)!, runner: "builder-1", releasedAt: null });

    let looks = 0;
    const done = await sweep(15, path => {
      if (path === racing.path && ++looks === 2) store.startRun({ taskRef: racing.ref, leaseId: "l-race", runner: "builder-1", branch: "toolroll/racing", worktree: racing.path, route: ROUTE, now: T0 });
      return false;
    });
    expect(looks).toBe(2);
    expect(done.removed).toEqual([]);
    for (const one of [claimed, running, leased, racing, expired]) expect(existsSync(one.path)).toBe(true);
    expect(store.getRun(open)?.outcome).toBeNull();
  });

  test("the live-work guard is asked at the moment of removal: a process in the folder keeps it", async () => {
    const one = await task("used", "ready");
    store.close();
    store = openStore(join(dir, "orders.db"));
    pool = new WorktreePool(store, { root: join(dir, "worktrees") });
    // Held by a process that isn't this one.
    writeFileSync(join(one.path, ".standing-orders-lease"), `${process.ppid} other process unknown ${(await import("node:os")).hostname()}\n`);
    const spare = liveUse(store, { databaseFile: join(dir, "orders.db"), pool, tempRoots: [], census: () => [], locate: () => new Map() }, () => at(15));
    expect(spare(one.path)).toBe(true);
    expect((await sweep(15, spare)).removed).toEqual([]);
    expect(existsSync(one.path)).toBe(true);
  });

  test("a process working in the folder keeps it, however idle its task: the sweep asks the OS, and a look it can't make keeps it too", async () => {
    const one = await task("shell", "ready");
    const other = await task("unreadable", "ready");
    const shell = spawn("sleep", ["60"], { cwd: one.path, stdio: "ignore" });
    try {
      const deps = (cwds?: (paths: readonly string[]) => Map<string, number[]>) => ({ databaseFile: join(dir, "orders.db"), pool, tempRoots: [], census: () => [], locate: () => new Map(), inUse: () => [], scripts: () => [], ...(cwds === undefined ? {} : { cwds }) });
      const blind = await executeSweep(store, deps(() => { throw new Error("no process list"); }), () => at(15));
      expect(blind.parts.find(part => part.kind === "checkouts")).toMatchObject({ count: 0 });
      const looked = await executeSweep(store, deps(), () => at(15));
      expect(looked.parts.find(part => part.kind === "checkouts")).toMatchObject({ count: 1, items: [other.path] });
      expect(existsSync(one.path)).toBe(true);
    } finally { shell.kill("SIGKILL"); }
  });

  test("the service's own pass never takes an idle folder: only the sweep's child does", async () => {
    const one = await task("one", "ready");
    expect((await cleanCheckouts(store, pool, () => at(40), { manual: false, actor: "worker", repo })).removed).toEqual([]);
    expect(existsSync(one.path)).toBe(true);
  });

  test("the setting: never, automatic cleanup off and a clean-up by hand all leave it; 7 and 30 move the limit", async () => {
    const one = await task("one", "ready");
    expect(checkoutIdle(store)).toBe("14d");

    setCheckoutIdle(store, "never", "alex", at(1));
    expect(await stayWhy(40, one.path)).toBe("waiting for review");
    expect((await sweep(40)).removed).toEqual([]);
    expect(store.actionLedger({ repos: null }).find(row => row.action === "idle cleanup changed")).toMatchObject({ actor: "alex", source: "policy", detail: "after 14 days idle → never for being idle" });

    setCheckoutIdle(store, "14d", "alex", at(1));
    store.setCheckoutCleanup("never", "alex", at(1));
    expect(await stayWhy(40, one.path)).toBe("waiting for review");
    expect((await sweep(40)).removed).toEqual([]);
    store.setCheckoutCleanup("finished", "alex", at(1));

    expect((await cleanCheckouts(store, pool, () => at(40), { manual: true, actor: "alex" })).removed).toEqual([]);
    expect(existsSync(one.path)).toBe(true);

    setCheckoutIdle(store, "30d", "alex", at(1));
    expect((await sweep(20)).removed).toEqual([]);
    setCheckoutIdle(store, "7d", "alex", at(1));
    expect((await sweep(20)).removed.map(row => row.path)).toEqual([one.path]);
  });

  test("release gates, external tasks and folders no task names are never idle", async () => {
    const gate = await task("release-1", "queued");
    store.handle.prepare("INSERT INTO task_scope (task_id, goal, out_of_scope, touches, proposed_at, digest, candidate) VALUES ('release-1', 'g', '[]', '[]', ?, 'd', ?)").run(T0.toISOString(), gate.head);
    const external = await task("ext", "ready");
    store.handle.prepare("UPDATE task_ref SET backend = 'linear' WHERE id = ?").run(external.ref);
    const orphan = await task("orphan", "ready");
    store.saveWorktree({ ...store.getWorktree(orphan.path)!, taskRef: null, branch: "unknown" });

    expect((await sweep(40)).removed).toEqual([]);
    for (const one of [gate, external, orphan]) expect(existsSync(one.path)).toBe(true);
  });

  test("folders that aren't what the record says are refused: a link out of the pool, a .git file naming another repository", async () => {
    const linked = await task("linked", "ready");
    const moved = join(dir, "outside");
    renameSync(linked.path, moved);
    symlinkSync(moved, linked.path);
    const foreign = await task("foreign", "ready");
    // The folder claims to be a checkout of another repository, whose branches a build could write.
    const other = join(dir, "other");
    mkdirSync(other);
    await git(["init", "-q", "-b", "main"], other);
    await git(["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "x"], other);
    await git(["branch", "toolroll/foreign"], other);
    await git(["worktree", "add", "-q", join(dir, "other-tree"), "toolroll/foreign"], other);
    writeFileSync(join(foreign.path, ".git"), `gitdir: ${join(other, ".git", "worktrees", "other-tree")}\n`);

    const done = await sweep(15);
    expect(done.removed).toEqual([]);
    expect(existsSync(join(moved, "linked.txt"))).toBe(true);
    expect(existsSync(join(foreign.path, "foreign.txt"))).toBe(true);
    expect(await pool.proveRecreatable(store.getWorktree(linked.path)!, [])).toBe("unreadable");
    expect(await pool.proveRecreatable(store.getWorktree(foreign.path)!, [])).toBe("unreadable");
  });

  test("the sweep takes them in its child's pass, says so, and comes back for what its cap left", async () => {
    const all = [];
    for (let at_ = 0; at_ < 21; at_++) all.push(await task(`t${at_}`, "ready"));
    const deps = { databaseFile: join(dir, "orders.db"), pool, tempRoots: [], census: () => [], locate: () => new Map(), inUse: () => [], scripts: () => [], cwds: () => new Map() };
    const first = await executeSweep(store, deps, () => at(15));
    const part = first.parts.find(one => one.kind === "checkouts")!;
    expect(part).toMatchObject({ count: 20, more: true });
    expect(sweepWords(first.parts)).toContain("20 task folders");
    const second = await executeSweep(store, deps, () => at(15));
    expect(second.parts.find(one => one.kind === "checkouts")).toMatchObject({ count: 1 });
    expect(all.filter(one => existsSync(one.path))).toEqual([]);
  });
});

/** Every act a person has left, against real git after the folder went: only the agent is a stub. */
describe("after an idle folder is removed, every act still works", () => {
  let base: string, repo: string, db: string, pool: string, lines: string[] = [], seen: string[] = [];
  const day = (days: number) => new Date(T0.getTime() + days * DAY);
  const git = async (args: string[], cwd = repo) => (await exec("git", args, { cwd })).stdout.trim();
  const building: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    seen.push(cwd);
    await writeFile(join(cwd, "guard.ts"), `export const guarded = ${seen.length};\n`);
    await concludeDone(cwd, args);
    return { ...OK, stdout: AGENT_SAID };
  };
  const broken: Runner = async (_file, _args, options) => {
    seen.push(options?.cwd ?? "");
    return { ...OK, code: 1, stdout: JSON.stringify({ type: "system", subtype: "init" }), stderr: "the model refused" };
  };
  /** Parks without touching a file: a clean folder with a decision waiting on a person. */
  const parking: Runner = async (_file, args, options) => {
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const mailbox = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)![0];
    await writeFile(join(options?.cwd ?? "", mailbox), JSON.stringify({ urgency: "blocking", recap: "The guard can fail open or closed.", question: "Open or closed?",
      options: [{ id: "open", label: "Open", consequence: "Bad payouts slip.", reversible: true }, { id: "closed", label: "Closed", consequence: "Payouts pause.", reversible: true }], recommendation: "closed" }));
    return { ...OK, stdout: JSON.stringify({ result: "parked" }) };
  };
  const run = (argv: string[], now: Date = T0, runner: Runner = building) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: runner });
  };
  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "so-idle-acts-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "worktrees");
    seen = [];
    mkdirSync(repo);
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const approved = async (id: string) => {
    const runner = registerRunner(db, "builder-1", repo);
    await run(["approver", "add", "alex", "--json"]);
    const approver = payload().token as string;
    for (const phase of ["build", "plan", "review"]) await run(["config", "set", phase, "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approver, "--json"]);
    await run(["task", "add", "the work", "--id", id, "--repo", repo]);
    await run(["task", "scope", id, "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"]);
    await run(["task", "approve", id, "--json"]);
    await run(["task", "approve", id, "--yes", "--digest", payload().scope.digest as string, "--as", "alex", "--token", approver]);
    return { runner, approver };
  };
  const tick = (token: string, now: Date, agent: Runner = building) => run(["tick", "--runner", "builder-1", "--token", token, "--repo", repo, "--pool", pool, "--json"], now, agent);
  /** The automatic pass, as the sweep runs it. */
  const sweepAt = async (now: Date): Promise<string[]> => {
    const store = openStore(db);
    try {
      const done = await cleanCheckouts(store, new WorktreePool(store, { root: pool }), () => now, { manual: false, actor: "worker", idle: { occupied: () => false } });
      return done.removed.map(one => one.path);
    } finally { store.close(); }
  };
  const folderOf = (id: string): string => {
    const store = openStore(db);
    try { return store.runsFor(store.refFor("built-in", id).id).at(-1)!.worktree!; } finally { store.close(); }
  };

  test("the result page, Run checks' commit and Accept, on a result waiting for review", async () => {
    const { runner, approver } = await approved("t-1");
    await tick(runner, T0);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "built", committed: true }]);
    const folder = folderOf("t-1");
    const head = await git(["rev-parse", "toolroll/t-1"]);

    expect(await sweepAt(day(15))).toEqual([folder]);
    expect(existsSync(folder)).toBe(false);

    // The result page reads saved evidence: its diff is all there, and nothing links to the folder that went.
    const store = openStore(db);
    const server = createDecisionServer({ store, evidenceRoot: join(dirname(db), "evidence"), repo, poolRoot: pool, localRunner: "builder-1", editorLinks: "vscode" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const cookie = (await fetch(`${url}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: approver }), redirect: "manual" }))
        .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      const run_ = store.runsFor(store.refFor("built-in", "t-1").id).at(-1)!.id;
      const page = await fetch(`${url}/r/${run_}`, { headers: { cookie } });
      expect(page.status).toBe(200);
      const text = await page.text();
      expect(text).toContain("guard.ts");
      expect(text).not.toContain(folder);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
    }

    // Run checks starts a fresh folder from the result's commit: it needs that commit, which its branch holds.
    expect(await git(["cat-file", "-t", head])).toBe("commit");

    expect(await run(["task", "complete", "t-1", "--as", "alex", "--token", approver], day(16))).toBe(0);
    expect(lines.join("\n")).toContain("Complete");
  });

  test("Send back: the revision starts from the result's commit, in its own new folder", async () => {
    const { runner, approver } = await approved("t-1");
    await tick(runner, T0);
    const folder = folderOf("t-1");
    const head = await git(["rev-parse", "toolroll/t-1"]);
    expect(await sweepAt(day(15))).toEqual([folder]);

    await run(["task", "revise", "t-1", "--feedback", "Also cover refunds.", "--as", "alex", "--token", approver, "--json"], day(16));
    const child = payload().result.id as string;
    // Its first run starts from the result, whose folder went: a new folder, at exactly the result's commit.
    let started: string | null = null;
    const planning: Runner = async (file, args, options) => { started = await git(["rev-parse", "HEAD"], options?.cwd ?? ""); seen.push(options?.cwd ?? ""); return building(file, args, options); };
    await tick(runner, day(16), planning);
    expect(payload().dispatched).toMatchObject([{ id: child }]);
    expect(started).toBe(head);
    expect(seen.at(-1)).not.toBe(folder);
  });

  test("Retry: a failed task's next attempt makes the folder again from its branch", async () => {
    const { runner, approver } = await approved("t-1");
    await tick(runner, T0, broken);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "failed" }]);
    const folder = folderOf("t-1");
    expect(await sweepAt(day(15))).toEqual([folder]);

    await run(["task", "requeue", "t-1", "--as", "alex", "--token", approver], day(16));
    await tick(runner, day(16));
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "built", committed: true }]);
    expect(seen.at(-1)).toBe(folder);
    expect(existsSync(folder)).toBe(true);
  });

  test("Resume: a parked task's answer starts the next attempt in a new folder at the same place", async () => {
    const { runner, approver } = await approved("t-1");
    await tick(runner, T0, parking);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "parked" }]);
    const folder = folderOf("t-1");
    expect(await sweepAt(day(15))).toEqual([folder]);

    await run(["decide", "1", "--choose", "closed", "--as", "alex", "--token", approver], day(16));
    await tick(runner, day(16));
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "built", committed: true }]);
    expect(seen.at(-1)).toBe(folder);
    expect(existsSync(join(folder, "guard.ts"))).toBe(true);
  });

  test("Hold: lifting a hold puts the task back, and its next attempt makes the folder", async () => {
    const { runner, approver } = await approved("t-1");
    await tick(runner, T0, broken);
    const folder = folderOf("t-1");
    await run(["task", "hold", "t-1", "--reason", "waiting on legal", "--as", "alex", "--token", approver], day(1));
    expect(await sweepAt(day(16))).toEqual([folder]);
    await run(["task", "unhold", "t-1", "--as", "alex", "--token", approver], day(17));
    await run(["task", "requeue", "t-1", "--as", "alex", "--token", approver], day(17));
    await tick(runner, day(17));
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "built", committed: true }]);
    expect(seen.at(-1)).toBe(folder);
  });

  test("toolroll storage says what idle cleanup would free, lists uncommitted work, and the setting takes an operator", async () => {
    const { runner, approver } = await approved("t-1");
    await tick(runner, T0);
    const folder = folderOf("t-1");
    await run(["storage", "--json"], day(15));
    expect(payload().checkouts).toMatchObject({ idle: "14d", idleCount: 1 });
    expect(payload().checkouts.idleBytes).toBeGreaterThan(0);
    await run(["storage"], day(15));
    expect(lines.join("\n")).toContain("the next sweep frees about");

    writeFileSync(join(folder, "notes.txt"), "keep\n");
    await run(["storage", "--json"], day(15));
    expect(payload().checkouts).toMatchObject({ idleCount: 0, uncommitted: [{ path: folder, taskId: "t-1" }] });
    await run(["storage"], day(15));
    expect(lines.join("\n")).toContain("uncommitted changes and stays until you decide");

    expect(await run(["storage", "cleanup", "idle", "45", "--as", "alex", "--token", approver], day(15))).not.toBe(0);
    expect(await run(["storage", "cleanup", "idle", "30", "--as", "alex", "--token", "wrong"], day(15))).not.toBe(0);
    expect(await run(["storage", "cleanup", "idle", "30", "--as", "alex", "--token", approver, "--json"], day(15))).toBe(0);
    expect(payload()).toMatchObject({ idle: "30d" });
    await run(["storage", "cleanup", "--json"], day(15));
    expect(payload()).toMatchObject({ cleanup: "finished", idle: "30d" });
  });
});
