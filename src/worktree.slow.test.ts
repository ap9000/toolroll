import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, symlinkSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { MARKER, WorktreePool, worktreePath, type Runner } from "./worktree.js";
import { HANDOFF_PREFIX, MAILBOX_SUFFIX } from "./evidence.js";
import { run } from "./exec.js";
import { fakePid } from "../test/fake-pid.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-08-11T22:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("worktreePath", () => {
  test("is stable for the same repository and branch", () => {
    expect(worktreePath("/pool", "/code/thing", "feat/a")).toBe(worktreePath("/pool", "/code/thing", "feat/a"));
  });

  test("does not let a branch name escape the pool root", () => {
    // `feat/../../etc` would otherwise write outside the pool entirely.
    const path = worktreePath("/pool", "/code/thing", "../../etc/passwd");

    expect(path.replace(/\\/g, "/")).toContain("/pool/");
    expect(path).not.toContain("..");
  });

  // Sharing a directory would land one task's work in another's checkout.
  test.each([
    ["two repositories with the same branch", ["/code/alpha", "main"], ["/code/beta", "main"]],
    ["same-named repositories in different places", ["/x/api", "main"], ["/y/api", "main"]],
    ["branches that flatten to the same name", ["/code/thing", "feat/a"], ["/code/thing", "feat-a"]],
  ] as const)("keeps %s apart", (_label, [repoA, branchA], [repoB, branchB]) => {
    expect(worktreePath("/pool", repoA, branchA)).not.toBe(worktreePath("/pool", repoB, branchB));
  });
});

describe("the pool, against a stubbed git", () => {
  let store: Store;
  let root: string;
  const calls: string[][] = [];
  // Teardown's git runs against a view of the checkout's repository (teardown-git.ts gitView), made from what is on
  // disk and bound to one repository (boundDirs): the stub's checkouts are linked worktrees of a stand-in repository
  // (a main checkout whose .git holds an empty config), the one the orphan survey asks.
  let common: string;
  let thing: string;
  let made = 0;
  const checkout = (path: string) => {
    mkdirSync(path, { recursive: true });
    const admin = join(common, "worktrees", `stub-${made++}`);
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "gitdir"), `${realpathSync(path)}/.git\n`);
    writeFileSync(join(admin, "commondir"), "../..\n");
    writeFileSync(join(path, ".git"), `gitdir: ${admin}\n`);
  };

  const pool = (replies: (args: readonly string[]) => Partial<typeof OK> = () => ({})) => {
    const runner: Runner = async (_file, args) => {
      calls.push([...args]);
      const reply = { ...OK, ...replies(args) };
      // The stub stands in for git in the one way that matters to the pool:
      // a successful `worktree add` leaves a directory behind. Without it the
      // lease has nowhere to write its in-use marker.
      if (args[0] === "worktree" && args[1] === "add" && reply.code === 0) {
        const target = args[args.length - 2] as string;
        checkout(target);
      }
      return reply;
    };
    return new WorktreePool(store, { root, runner });
  };

  beforeEach(() => {
    store = openStore(":memory:");
    // Real path up front: adoption compares real paths, and a fabricated
    // candidate under a symlinked root would never match itself.
    root = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-stub-")));
    calls.length = 0;
    thing = join(realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-stub-repo-"))), "thing");
    common = join(thing, ".git");
    mkdirSync(common, { recursive: true });
    writeFileSync(join(common, "config"), "");
    // A worktree can only be leased to a runner the control plane knows.
    for (const name of ["builder-1", "builder-2"]) {
      register(store, { name, host: "test", now: T0 });
    }
  });

  afterEach(() => store.close());

  test.each(["project", "target", "root", "dangling", "loop"])("refuses a symlinked %s before creating any lease files or invoking git", async kind => {
    const stash = join(root, "stash");
    mkdirSync(stash);
    const target = worktreePath(root, "/code/thing", "feat/a");
    const project = join(root, "thing");
    if (kind === "target") mkdirSync(project);
    const poisoned = kind === "target" ? target : kind === "root" ? join(root, "pool-link") : project;
    symlinkSync(kind === "dangling" ? join(root, "absent") : kind === "loop" ? poisoned : stash, poisoned);
    const subject = kind === "root" ? new WorktreePool(store, { root: poisoned, runner: async () => { throw new Error("git must not run"); } }) : pool();
    const result = await subject.lease({ repo: "/code/thing", branch: "feat/a", runner: "builder-1", now: T0 });
    expect(result).toMatchObject({ ok: false, reason: "git" });
    expect(calls).toEqual([]);
    expect(readdirSync(stash)).toEqual([]);
    expect(store.getWorktree(target)).toBeNull();
  });

  test("will not give work to a runner nobody registered", async () => {
    // Such a lease could never be heartbeated or recovered — it would be a
    // checkout that never comes back. The database enforces it too; this is
    // what turns a foreign key error into a sentence somebody can act on.
    const result = await pool().lease({
      repo: "/code/thing",
      branch: "feat/a",
      runner: "never-registered",
      now: T0,
    });

    expect(result).toMatchObject({ ok: false, reason: "unknown-runner" });
    if (!result.ok) expect(result.message).toContain("register it");
  });

  test("refuses a worktree somebody else holds, and says who", async () => {
    const first = pool();
    await first.lease({ repo: "/code/thing", branch: "feat/a", runner: "builder-1", now: T0 });

    const second = await first.lease({
      repo: "/code/thing",
      branch: "feat/a",
      runner: "builder-2",
      now: later(1_000),
    });

    expect(second).toMatchObject({ ok: false, reason: "held" });
    if (!second.ok) expect(second.message).toContain("builder-1");
  });

  test("lets the same runner take its own lease again", async () => {
    // A retried dispatch must not be refused by its own previous attempt.
    const it = pool();
    await it.lease({ repo: "/code/thing", branch: "feat/a", runner: "builder-1", now: T0 });

    const again = await it.lease({
      repo: "/code/thing",
      branch: "feat/a",
      runner: "builder-1",
      now: later(1_000),
    });

    expect(again.ok).toBe(true);
    if (again.ok) expect(again.created).toBe(false);
  });

  test("reports git's own failure rather than pretending it worked", async () => {
    const result = await pool(args =>
      args[0] === "worktree" && args[1] === "add"
        ? { code: 128, stderr: "fatal: invalid reference: feat/a" }
        : {},
    ).lease({ repo: "/code/thing", branch: "feat/a", runner: "builder-1", now: T0 });

    expect(result).toMatchObject({ ok: false, reason: "git" });
    if (!result.ok) expect(result.message).toContain("invalid reference");
  });

  test("counts untracked files as work, not as a clean tree", async () => {
    // A pool that recycles a directory because status looked clean under the
    // operator's ignore rules will delete something they wanted.
    const it = pool(args => (args.includes("status") ? { stdout: "?? notes.md\n" } : {}));
    await it.lease({ repo: "/code/thing", branch: "feat/a", runner: "builder-1", now: T0 });

    const released = await it.release(
      worktreePath(root, "/code/thing", "feat/a"),
      later(1_000),
    );

    expect(released).toMatchObject({ ok: false, reason: "dirty" });
  });

  test("keeps a dirty worktree rather than cleaning it", async () => {
    // `git reset --hard` leaves untracked files behind and destroys work that
    // might have been repairable.
    const it = pool(args => (args.includes("status") ? { stdout: " M src/index.ts\n" } : {}));
    await it.lease({ repo: "/code/thing", branch: "feat/a", runner: "builder-1", now: T0 });
    await it.release(worktreePath(root, "/code/thing", "feat/a"), later(1_000));

    expect(calls.some(args => args.includes("reset") || args.includes("clean"))).toBe(false);
  });

  test("treats an uninspectable tree as unverified, not as clean", async () => {
    const it = pool(args => (args.includes("status") ? { code: 128, stderr: "not a git repo" } : {}));
    await it.lease({ repo: "/code/thing", branch: "feat/a", runner: "builder-1", now: T0 });

    const path = worktreePath(root, "/code/thing", "feat/a");
    await it.release(path, later(1_000));

    expect(store.getWorktree(path)?.verified).toBe(false);
  });

  test("checks a worktree recovered from a dead runner before reusing it", async () => {
    const path = worktreePath(root, "/code/thing", "feat/a");
    checkout(path);
    store.saveWorktree({
      path,
      repo: "/code/thing",
      branch: "feat/a",
      runner: null,
      taskRef: null,
      createdAt: T0.toISOString(),
      leasedAt: T0.toISOString(),
      releasedAt: later(1_000).toISOString(),
      verified: false,
    });

    const refused = await pool(args =>
      args.includes("status") ? { stdout: "?? half-finished.ts\n" } : {},
    ).lease({ repo: "/code/thing", branch: "feat/a", runner: "builder-2", now: later(2_000) });

    expect(refused).toMatchObject({ ok: false, reason: "dirty" });
    if (!refused.ok) expect(refused.message).toContain("previous run");
  });

  test("reuses a recovered worktree once it checks out clean", async () => {
    const path = worktreePath(root, "/code/thing", "feat/a");
    checkout(path);
    store.saveWorktree({
      path,
      repo: "/code/thing",
      branch: "feat/a",
      runner: null,
      taskRef: null,
      createdAt: T0.toISOString(),
      leasedAt: T0.toISOString(),
      releasedAt: later(1_000).toISOString(),
      verified: false,
    });

    const taken = await pool().lease({
      repo: "/code/thing",
      branch: "feat/a",
      runner: "builder-2",
      now: later(2_000),
    });

    expect(taken.ok).toBe(true);
    expect(store.getWorktree(path)?.verified).toBe(true);
  });

  test("names worktrees git knows about that the pool does not", async () => {
    const it = pool(args =>
      args.includes("list")
        ? { stdout: `worktree ${thing}\nworktree /elsewhere/stray\n` }
        : {},
    );

    const found = await it.orphans(thing);

    // Somebody else's worktree is named, not adopted, and the repo itself is
    // not mistaken for one of ours.
    expect(found).toEqual({ ok: true, untracked: ["/elsewhere/stray"], missing: [] });
  });

  test("names its own worktrees that are no longer on disk", async () => {
    store.saveWorktree({
      path: "/pool/thing/gone",
      repo: thing,
      branch: "gone",
      runner: null,
      taskRef: null,
      createdAt: T0.toISOString(),
      leasedAt: null,
      releasedAt: null,
      verified: false,
    });

    const found = await pool(args =>
      args.includes("list") ? { stdout: `worktree ${thing}\n` } : {},
    ).orphans(thing);

    expect(found).toMatchObject({ ok: true, missing: ["/pool/thing/gone"] });
  });

  test("a failed listing is an error, not an empty answer", async () => {
    // The difference is everything downstream: empty means every stored row
    // is missing and may be forgotten; failed means nothing is knowable.
    store.saveWorktree({
      path: "/pool/thing/real",
      repo: "/code/thing",
      branch: "real",
      runner: null,
      taskRef: null,
      createdAt: T0.toISOString(),
      leasedAt: null,
      releasedAt: null,
      verified: true,
    });
    const broken = pool(args =>
      args.includes("list") ? { code: 128, stderr: "fatal: not a git repository" } : {},
    );

    expect(await broken.orphans("/code/thing")).toMatchObject({ ok: false });

    const adopted = await broken.adopt("/code/thing", T0);
    expect(adopted).toMatchObject({ ok: false });
    // And the row a working listing would have confirmed is still there.
    expect(store.getWorktree("/pool/thing/real")).not.toBeNull();
  });

  test("an orphan survey cannot overwrite a lease recorded before adoption commits", async () => {
    const it = pool();
    const path = worktreePath(root, "/code/thing", "feat/race");
    it.orphans = async () => {
      const found = { ok: true as const, untracked: [path], missing: [] };
      expect(await it.lease({ repo: "/code/thing", branch: "feat/race", runner: "builder-1", now: T0 })).toMatchObject({ ok: true });
      return found;
    };
    expect(await it.adopt("/code/thing", later(1_000))).toEqual({ ok: true, adopted: [], forgotten: [] });
    expect(store.getWorktree(path)).toMatchObject({ runner: "builder-1", branch: "feat/race", releasedAt: null, verified: true });
  });

  test("a stale listing cannot forget an owned or newly created checkout", async () => {
    const it = pool();
    const owned = await it.lease({ repo: "/code/thing", branch: "feat/owned", runner: "builder-1", now: T0 });
    const released = await it.lease({ repo: "/code/thing", branch: "feat/released", runner: "builder-2", now: T0 });
    expect(owned.ok && released.ok).toBe(true);
    if (!owned.ok || !released.ok) return;
    const gone = join(root, "gone");
    store.saveWorktree({ ...released.worktree, path: gone, runner: null, releasedAt: T0.toISOString() });
    store.saveWorktree({ ...released.worktree, runner: null, releasedAt: T0.toISOString() });
    // A missing owned path is still custody; recovery settles its owner first.
    rmSync(owned.worktree.path, { recursive: true });
    it.orphans = async () => ({ ok: true, untracked: [], missing: [owned.worktree.path, released.worktree.path, gone] });
    expect(await it.adopt("/code/thing", later(1_000))).toEqual({ ok: true, adopted: [], forgotten: [gone] });
    expect(store.getWorktree(owned.worktree.path)).not.toBeNull();
    expect(store.getWorktree(released.worktree.path)).not.toBeNull();
  });

  test("adopts only what lives under its own root", async () => {
    // The operator's hand-made worktree is named by orphans() and left alone;
    // only a directory inside the pool becomes the pool's responsibility.
    const crashed = join(root, "thing", "crashed");
    const it = pool(args =>
      args.includes("list")
        ? { stdout: `worktree ${thing}\nworktree ${crashed}\nworktree /home/alex/mine\n` }
        : {},
    );

    const adopted = await it.adopt(thing, T0);

    expect(adopted).toMatchObject({ ok: true, adopted: [crashed] });
    expect(store.getWorktree(crashed)).toMatchObject({ verified: false, releasedAt: T0.toISOString() });
    expect(store.getWorktree("/home/alex/mine")).toBeNull();
  });
});

describe("the pool, against real git", () => {
  let base: string;
  let repo: string;
  let store: Store;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "standing-orders-pool-"));
    repo = join(base, "repo");
    await mkdir(repo, { recursive: true });
    store = openStore(":memory:");
    register(store, { name: "builder-1", host: "test", now: T0 });

    const git = (args: string[]) => run("git", args, { cwd: repo });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
  });

  afterEach(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });

  test("really creates a working copy, and really sees work left in it", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });

    const leased = await pool.lease({
      repo,
      branch: "feat/real",
      base: "main",
      runner: "builder-1",
      now: T0,
    });

    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    expect(existsSync(join(leased.worktree.path, "README.md"))).toBe(true);

    // Clean on release…
    expect((await pool.release(leased.worktree.path, later(1_000))).ok).toBe(true);

    // …and dirty once something untracked is dropped in.
    await writeFile(join(leased.worktree.path, "scratch.txt"), "work in progress\n");
    const dirty = await pool.release(leased.worktree.path, later(2_000));

    expect(dirty).toMatchObject({ ok: false, reason: "dirty" });
    expect(existsSync(join(leased.worktree.path, "scratch.txt"))).toBe(true);
  });

  test("a task's own leftover is kept as a patch and the tree reset for the retry; another task's, or a lease without reclaim, still refuses", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const evidence = join(base, "evidence");
    store.createTask({ id: "t-own", title: "the task whose leftover this is" }, T0);
    store.createTask({ id: "t-other", title: "another task" }, T0);
    const own = store.refFor("built-in", "t-own").id;
    const other = store.refFor("built-in", "t-other").id;
    const first = await pool.lease({ repo, branch: "feat/again", base: "main", runner: "builder-1", taskRef: own, now: T0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await writeFile(join(first.worktree.path, "README.md"), "hello\nchanged by a dying attempt\n");
    await writeFile(join(first.worktree.path, "new-file.ts"), "export const x = 1;\n");
    expect(await pool.release(first.worktree.path, later(1_000))).toMatchObject({ ok: false, reason: "dirty" });

    // Without reclaim, or for another task: kept for a person, as before.
    expect(await pool.lease({ repo, branch: "feat/again", runner: "builder-1", taskRef: own, now: later(2_000) })).toMatchObject({ ok: false, reason: "dirty" });
    expect(await pool.lease({ repo, branch: "feat/again", runner: "builder-1", taskRef: other, now: later(2_000), reclaim: { evidenceRoot: evidence } })).toMatchObject({ ok: false, reason: "dirty" });

    const again = await pool.lease({ repo, branch: "feat/again", runner: "builder-1", taskRef: own, now: later(3_000), reclaim: { evidenceRoot: evidence } });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.reclaimed).toBeDefined();
    const patch = await import("node:fs/promises").then(fs => fs.readFile(again.reclaimed as string, "utf8"));
    expect(patch).toContain("changed by a dying attempt");
    expect(patch).toContain("export const x = 1;");
    // The tree is back at HEAD and clean; the lease note is still ours.
    expect(await import("node:fs/promises").then(fs => fs.readFile(join(again.worktree.path, "README.md"), "utf8"))).toBe("hello\n");
    expect(existsSync(join(again.worktree.path, "new-file.ts"))).toBe(false);
    expect(existsSync(join(again.worktree.path, ".standing-orders-lease"))).toBe(true);
    expect((await pool.release(again.worktree.path, later(4_000))).ok).toBe(true);
  });

  test("a completed interrupted draft stays in place for a freshly fenced retry", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const evidence = join(base, "evidence");
    store.createTask({ id: "t-resume", title: "recover completed work" }, T0);
    const ref = store.refFor("built-in", "t-resume").id;
    const first = await pool.lease({
      repo,
      branch: "feat/resume",
      base: "main",
      runner: "builder-1",
      taskRef: ref,
      now: T0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const runId = store.startRun({
      taskRef: ref,
      leaseId: "dead-lease",
      runner: "builder-1",
      branch: "feat/resume",
      worktree: first.worktree.path,
      ...bareLegacy("build", "claude", null), now: T0,
    });
    await writeFile(join(first.worktree.path, "README.md"), "hello\ncompleted draft\n");
    await writeFile(join(first.worktree.path, "new-file.ts"), "export const recovered = true;\n");
    await writeFile(
      join(first.worktree.path, "STANDING-ORDERS-DONE-0123456789abcdef.json"),
      JSON.stringify({ version: 2, status: "completed", conclusion: "The draft is ready.", changes: [], verification: [], followUps: [] }),
    );
    store.finishRun(runId, { outcome: "failed", reason: "interrupted", now: later(1_000) });
    expect(await pool.release(first.worktree.path, later(2_000))).toMatchObject({ ok: false, reason: "dirty" });

    const resumed = await pool.lease({
      repo,
      branch: "feat/resume",
      runner: "builder-1",
      taskRef: ref,
      now: later(3_000),
      reclaim: { evidenceRoot: evidence },
    });
    expect(resumed).toMatchObject({ ok: true, resumedFromRun: runId, recoveryKind: "completed" });
    if (!resumed.ok) return;
    expect(resumed.reclaimed).toBeDefined();
    expect(await import("node:fs/promises").then(fs => fs.readFile(join(resumed.worktree.path, "README.md"), "utf8"))).toContain("completed draft");
    expect(existsSync(join(resumed.worktree.path, "new-file.ts"))).toBe(true);
    expect(existsSync(join(resumed.worktree.path, "STANDING-ORDERS-DONE-0123456789abcdef.json"))).toBe(true);

    // The fresh attempt quarantines the old nonce, then an infrastructure
    // failure must still preserve the inherited draft for attempt three.
    await rm(join(resumed.worktree.path, "STANDING-ORDERS-DONE-0123456789abcdef.json"));
    // The recovered draft's lineage rides its own admission (atomic
    // authority closure): the interrupted attempt in this very worktree.
    const recovered = store.admitRecoveredBuilder({
      taskRef: ref,
      leaseId: "review-lease",
      runner: "builder-1",
      branch: "feat/resume",
      worktree: resumed.worktree.path,
      provider: "claude",
      recoveredFrom: runId,
      ...bareLegacy("build", "claude", null), now: later(3_100),
    });
    if (!recovered.ok) throw new Error(recovered.problem);
    const reviewRun = recovered.runId;
    await writeFile(join(resumed.worktree.path, "review-note.ts"), "export const reviewed = true;\n");
    store.finishRun(reviewRun, { outcome: "failed", reason: "provider-init", now: later(3_200) });
    expect(await pool.release(resumed.worktree.path, later(3_300))).toMatchObject({ ok: false, reason: "dirty" });

    const third = await pool.lease({
      repo,
      branch: "feat/resume",
      runner: "builder-1",
      taskRef: ref,
      now: later(4_000),
      reclaim: { evidenceRoot: evidence },
    });
    expect(third).toMatchObject({ ok: true, resumedFromRun: runId, recoveryKind: "partial" });
    if (!third.ok) return;
    expect(existsSync(join(third.worktree.path, "new-file.ts"))).toBe(true);
    expect(existsSync(join(third.worktree.path, "review-note.ts"))).toBe(true);
  });

  test("an open partial draft left by a vanished runner is preserved for continuation, not erased", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const evidence = join(base, "evidence");
    store.createTask({ id: "t-partial", title: "continue partial work" }, T0);
    const ref = store.refFor("built-in", "t-partial").id;
    const first = await pool.lease({ repo, branch: "feat/partial", base: "main", runner: "builder-1", taskRef: ref, now: T0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const runId = store.startRun({ taskRef: ref, leaseId: "partial-lease", runner: "builder-1", branch: "feat/partial", worktree: first.worktree.path, ...bareLegacy("build", "claude", null), now: T0 });
    await writeFile(join(first.worktree.path, "partial.ts"), "export const halfDone = true;\n");
    expect(await pool.release(first.worktree.path, later(2_000))).toMatchObject({ ok: false, reason: "dirty" });

    const resumed = await pool.lease({ repo, branch: "feat/partial", runner: "builder-1", taskRef: ref, now: later(3_000), reclaim: { evidenceRoot: evidence } });
    expect(resumed).toMatchObject({ ok: true, resumedFromRun: runId, recoveryKind: "partial" });
    if (!resumed.ok) return;
    expect(existsSync(join(resumed.worktree.path, "partial.ts"))).toBe(true);
  });

  test("work left by an attempt that stopped before its handoff is saved to evidence and never reset (run 2085)", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const evidence = join(base, "evidence");
    store.createTask({ id: "t-handoff", title: "keep unhanded work" }, T0);
    const ref = store.refFor("built-in", "t-handoff").id;
    const first = await pool.lease({ repo, branch: "feat/handoff", base: "main", runner: "builder-1", taskRef: ref, now: T0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const runId = store.startRun({ taskRef: ref, leaseId: "gone-lease", runner: "builder-1", branch: "feat/handoff", worktree: first.worktree.path, ...bareLegacy("build", "claude", null), now: T0 });
    await writeFile(join(first.worktree.path, "README.md"), "hello\nrenamed eighty-five files\n");
    await writeFile(join(first.worktree.path, "renamed.ts"), "export const toolroll = true;\n");
    store.finishRun(runId, { outcome: "failed", reason: "no-handoff", now: later(1_000) });
    expect(await pool.release(first.worktree.path, later(2_000))).toMatchObject({ ok: false, reason: "dirty" });

    const retry = await pool.lease({ repo, branch: "feat/handoff", runner: "builder-1", taskRef: ref, now: later(3_000), reclaim: { evidenceRoot: evidence } });
    expect(retry).toMatchObject({ ok: true, resumedFromRun: runId, recoveryKind: "partial" });
    if (!retry.ok) return;
    // Saved first: tracked diff and the untracked file, in the evidence folder.
    const patch = await import("node:fs/promises").then(fs => fs.readFile(retry.reclaimed as string, "utf8"));
    expect(retry.reclaimed).toContain(evidence);
    expect(patch).toContain("renamed eighty-five files");
    expect(patch).toContain("export const toolroll = true;");
    // And never reset: the retry continues from the same work.
    expect(await import("node:fs/promises").then(fs => fs.readFile(join(retry.worktree.path, "README.md"), "utf8"))).toContain("renamed eighty-five files");
    expect(existsSync(join(retry.worktree.path, "renamed.ts"))).toBe(true);
  });

  /** Attempt one stops before its handoff; attempt two inherits its work and ends as `ending` says. */
  const unhandedThenRetried = async (id: string, ending: (retryRun: number, path: string) => Promise<void> | void) => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const evidence = join(base, "evidence");
    store.createTask({ id, title: "keep unhanded work until it breaks" }, T0);
    const ref = store.refFor("built-in", id).id;
    const branch = `feat/${id}`;
    const first = await pool.lease({ repo, branch, base: "main", runner: "builder-1", taskRef: ref, now: T0 });
    if (!first.ok) throw new Error(first.message);
    const unhanded = store.startRun({ taskRef: ref, leaseId: `${id}-1`, runner: "builder-1", branch, worktree: first.worktree.path, ...bareLegacy("build", "claude", null), now: T0 });
    await writeFile(join(first.worktree.path, "renamed.ts"), "export const toolroll = true;\n");
    store.finishRun(unhanded, { outcome: "failed", reason: "no-handoff", now: later(1_000) });
    await pool.release(first.worktree.path, later(2_000));
    const second = await pool.lease({ repo, branch, runner: "builder-1", taskRef: ref, now: later(3_000), reclaim: { evidenceRoot: evidence } });
    expect(second).toMatchObject({ ok: true, resumedFromRun: unhanded, recoveryKind: "partial" });
    if (!second.ok) throw new Error(second.message);
    const recovered = store.admitRecoveredBuilder({
      taskRef: ref, leaseId: `${id}-2`, runner: "builder-1", branch, worktree: second.worktree.path, provider: "claude",
      recoveredFrom: unhanded, ...bareLegacy("build", "claude", null), now: later(3_100),
    });
    if (!recovered.ok) throw new Error(recovered.problem);
    await writeFile(join(second.worktree.path, "half-broken.ts"), "export const broken = \n");
    await ending(recovered.runId, second.worktree.path);
    await pool.release(second.worktree.path, later(4_000));
    const third = await pool.lease({ repo, branch, runner: "builder-1", taskRef: ref, now: later(5_000), reclaim: { evidenceRoot: evidence } });
    if (!third.ok) throw new Error(third.message);
    return { unhanded, third };
  };

  test("unhanded work is kept only until a later attempt fails some other way; then the saved tree is reset", async () => {
    const { third } = await unhandedThenRetried("t-broke", retryRun => {
      store.finishRun(retryRun, { outcome: "failed", reason: "agent", now: later(3_500) });
    });
    expect(third.resumedFromRun).toBeUndefined();
    expect(third.recoveryKind).toBeUndefined();
    // Saved before the reset: both attempts' work is in the leftover patch.
    const patch = await import("node:fs/promises").then(fs => fs.readFile(third.reclaimed as string, "utf8"));
    expect(patch).toContain("export const toolroll = true;");
    expect(patch).toContain("export const broken =");
    expect(existsSync(join(third.worktree.path, "renamed.ts"))).toBe(false);
    expect(existsSync(join(third.worktree.path, "half-broken.ts"))).toBe(false);
  });

  test("a later attempt that also stopped before its handoff, or lost its sign-in, keeps the unhanded work", async () => {
    for (const reason of ["no-handoff", "auth-expired"]) {
      let retried = 0;
      const { unhanded, third } = await unhandedThenRetried(`t-${reason}`, retryRun => {
        retried = retryRun;
        store.finishRun(retryRun, { outcome: "failed", reason, now: later(3_500) });
      });
      // The newest unhanded attempt is the draft; a lost sign-in leaves the first one's.
      expect(third).toMatchObject({ resumedFromRun: reason === "no-handoff" ? retried : unhanded, recoveryKind: "partial" });
      expect(existsSync(join(third.worktree.path, "renamed.ts"))).toBe(true);
    }
  });

  test("a resumed turn that fails inside an attempt that then stops before its handoff keeps the work", async () => {
    let retried = 0;
    const { third } = await unhandedThenRetried("t-turn", (retryRun, path) => {
      retried = retryRun;
      const taskRef = store.getRun(retryRun)!.taskRef;
      // The turn mends the attempt under its own live claim.
      store.raw().prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES ('t-turn-2', ?, 1, 'builder-1', ?, ?, ?)")
        .run(taskRef, later(3_000).toISOString(), later(60_000).toISOString(), later(3_000).toISOString());
      const turn = store.admitRepair({ taskRef, leaseId: "t-turn-2", runner: "builder-1", branch: "feat/t-turn", worktree: path,
        provider: "claude", parentRun: retryRun, ...bareLegacy("repair", "claude", null), now: later(3_200) });
      if (!turn.ok) throw new Error(turn.problem);
      store.finishRun(turn.runId, { outcome: "failed", reason: "timeout", now: later(3_300) });
      store.finishRun(retryRun, { outcome: "failed", reason: "no-handoff", now: later(3_500) });
    });
    expect(third).toMatchObject({ resumedFromRun: retried, recoveryKind: "partial" });
    expect(existsSync(join(third.worktree.path, "half-broken.ts"))).toBe(true);
  });

  test("provider occupancy replaces the console pid and is fenced to the live lease", async () => {
    const provider = fakePid(1);
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const leased = await pool.lease({ repo, branch: "feat/provider", base: "main", runner: "builder-1", now: T0 });
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;

    expect(pool.markProviderOccupancy(leased.worktree.path, "someone-else", provider)).toBe(false);
    expect(pool.markProviderOccupancy(leased.worktree.path, "builder-1", provider, "old-epoch")).toBe(false);
    expect(() => pool.recordProviderOccupancy(leased.worktree.path, "builder-1", provider, "old-epoch")).toThrow("custody could not be recorded");
    expect(pool.markProviderOccupancy(leased.worktree.path, "builder-1", provider)).toBe(true);
    const marker = await import("node:fs/promises").then(fs => fs.readFile(join(leased.worktree.path, ".standing-orders-lease"), "utf8"));
    // The note also carries this host's boot identity (v53) when it is known.
    expect(marker).toMatch(new RegExp(`^${provider} builder-1 group ([0-9a-f-]{36}|unknown) \\S+\\n$`));
    expect(pool.markProviderOccupancy(leased.worktree.path, "builder-1", 0)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("an orphaned process group keeps its checkout occupied after the recorded leader exits", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const leased = await pool.lease({ repo, branch: "feat/group", base: "main", runner: "builder-1", now: T0 });
    if (!leased.ok) throw new Error("fixture lease failed");
    const leader = spawn(process.execPath, ["-e", `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}).unref()`], { detached: true, stdio: "ignore" });
    const pid = leader.pid!;
    try {
      expect(pool.markProviderOccupancy(leased.worktree.path, "builder-1", pid)).toBe(true);
      await once(leader, "exit");
      expect(() => process.kill(pid, 0)).toThrow();
      expect(pool.inUse(leased.worktree.path)).toEqual({ held: true, by: pid });
      process.kill(-pid, "SIGKILL");
      await expect.poll(() => pool.inUse(leased.worktree.path).held).toBe(false);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
  });

  test("a released checkout is re-inspected even when its old row said clean", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const evidence = join(base, "evidence");
    store.createTask({ id: "t-late", title: "recover a late write" }, T0);
    const ref = store.refFor("built-in", "t-late").id;
    const first = await pool.lease({ repo, branch: "feat/late", base: "main", runner: "builder-1", taskRef: ref, now: T0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const runId = store.startRun({ taskRef: ref, leaseId: "late-lease", runner: "builder-1", branch: "feat/late", worktree: first.worktree.path, ...bareLegacy("build", "claude", null), now: T0 });
    expect(await pool.release(first.worktree.path, later(1_000))).toMatchObject({ ok: true });
    expect(store.getWorktree(first.worktree.path)?.verified).toBe(true);

    // The provider's last write lands after the controller's clean release.
    await writeFile(join(first.worktree.path, "late.ts"), "export const arrivedLate = true;\n");
    const resumed = await pool.lease({ repo, branch: "feat/late", runner: "builder-1", taskRef: ref, now: later(2_000), reclaim: { evidenceRoot: evidence } });
    expect(resumed).toMatchObject({ ok: true, resumedFromRun: runId, recoveryKind: "partial" });
    if (!resumed.ok) return;
    expect(existsSync(join(resumed.worktree.path, "late.ts"))).toBe(true);
  });

  test("storage retention removes finished, clean checkouts let go long enough ago, and nothing else", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const DAY = 86_400_000;
    // Build output the project ignores isn't work.
    await writeFile(join(repo, ".gitignore"), "dist/\n");
    await run("git", ["add", ".gitignore"], { cwd: repo });
    await run("git", ["commit", "-qm", "ignore build output"], { cwd: repo });
    const make = async (branch: string) => {
      const leased = await pool.lease({ repo, branch, base: "main", runner: "builder-1", now: T0 });
      if (!leased.ok) throw new Error(leased.message);
      return leased.worktree.path;
    };
    const old = await make("standing-orders/done-task");
    const recent = await make("standing-orders/recent-task");
    const dirty = await make("standing-orders/dirty-task");
    const unfinished = await make("standing-orders/failed-task");
    const detached = await make("standing-orders/detached-task");
    const leased = await make("standing-orders/running-task");
    // Commits a detached HEAD moved on to are on no branch: they exist only in that checkout.
    await run("git", ["checkout", "-q", "--detach"], { cwd: detached });
    await writeFile(join(detached, "late.txt"), "committed after detaching\n");
    await run("git", ["add", "late.txt"], { cwd: detached });
    await run("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "detached work"], { cwd: detached });
    for (const path of [old, dirty, unfinished, detached]) expect((await pool.release(path, T0)).ok).toBe(true);
    expect((await pool.release(recent, later(2 * DAY))).ok).toBe(true);
    await writeFile(join(dirty, "notes.txt"), "keep me\n");
    await mkdir(join(old, "dist"), { recursive: true });
    await writeFile(join(old, "dist", "out.js"), "built\n");
    // A progress note Toolroll itself left behind isn't a person's work; beside a person's file it doesn't change the answer.
    await writeFile(join(old, "STANDING-ORDERS-PROGRESS-0123456789abcdef.json"), "{}\n");
    await writeFile(join(dirty, "STANDING-ORDERS-PROGRESS-fedcba9876543210.json"), "{}\n");

    const at = later(2 * DAY + 1);
    const pruned = await pool.prune(store.listWorktrees(), row => row.branch !== "standing-orders/failed-task" && at.getTime() - Date.parse(row.releasedAt!) >= 2 * DAY);
    expect(pruned.removed.map(row => row.path)).toEqual([old]);
    expect(pruned.kept.sort((a, b) => a.path.localeCompare(b.path))).toEqual([{ path: detached, why: "has commits" }, { path: dirty, why: "has changes" }].sort((a, b) => a.path.localeCompare(b.path)));
    expect(existsSync(old)).toBe(false);
    expect(store.getWorktree(old)).toBeNull();
    for (const path of [recent, dirty, unfinished, detached, leased]) {
      expect(existsSync(path)).toBe(true);
      expect(store.getWorktree(path)).not.toBeNull();
    }
    // The branch, and so its commits, stays. A lease that starts a branch from `base` still refuses an existing one;
    // one that may reuse it (a plan) checks it out as it stands.
    expect((await run("git", ["branch", "--list", "standing-orders/done-task"], { cwd: repo })).stdout).toContain("done-task");
    expect(await pool.lease({ repo, branch: "standing-orders/done-task", base: "main", runner: "builder-1", now: later(3 * DAY) })).toMatchObject({ ok: false, reason: "git" });
    expect(await pool.lease({ repo, branch: "standing-orders/done-task", base: "main", reuseBranch: true, runner: "builder-1", now: later(3 * DAY) })).toMatchObject({ ok: true, created: true });
  });

  test("a lease that arrives while a checkout is being removed waits; it never gets a directory that's going", async () => {
    let lateLease: Promise<unknown> | null = null;
    const slow: typeof run = async (file, args, options) => {
      if (args.includes("remove") && lateLease === null) {
        lateLease = pool.lease({ repo, branch: "standing-orders/slow", base: "main", reuseBranch: true, runner: "builder-1", now: later(5 * 86_400_000) });
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return run(file, args, options);
    };
    const pool = new WorktreePool(store, { root: join(base, "pool"), runner: slow });
    const made = await pool.lease({ repo, branch: "standing-orders/slow", base: "main", runner: "builder-1", now: T0 });
    if (!made.ok) throw new Error(made.message);
    expect((await pool.release(made.worktree.path, T0)).ok).toBe(true);
    expect((await pool.prune(store.listWorktrees(), () => true)).removed).toHaveLength(1);
    expect(await lateLease).toMatchObject({ ok: false, reason: "in-use" });
    expect(store.getWorktree(made.worktree.path)).toBeNull();
  });

  test("a lease in another process cannot win between the final database read and checkout removal", async () => {
    store.close();
    const database = join(base, "race.db");
    store = openStore(database);
    register(store, { name: "builder-1", host: "test", now: T0 });
    const root = join(base, "pool"), branch = "toolroll/cross-process";
    const pool = new WorktreePool(store, { root });
    const made = await pool.lease({ repo, branch, base: "main", runner: "builder-1", now: T0 });
    if (!made.ok) throw Error(made.message);
    await pool.release(made.worktree.path, T0);
    let lease: unknown;
    const pruned = await pool.prune(store.listWorktrees(), (_row, fresh) => {
      if (fresh) {
        const script = `
          import { openStoreNoMigrate } from ${JSON.stringify(new URL("../dist/store.js", import.meta.url).href)};
          import { WorktreePool } from ${JSON.stringify(new URL("../dist/worktree.js", import.meta.url).href)};
          const opened = openStoreNoMigrate(process.argv[1]);
          if (!opened.ok) throw Error('database refused');
          const pool = new WorktreePool(opened.store, {root: process.argv[2]});
          try { console.log(JSON.stringify(await pool.lease({repo: process.argv[3], branch: process.argv[4], runner: 'builder-1', now: new Date()}))); }
          finally { opened.store.close(); }
        `;
        lease = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, database, root, repo, branch], { encoding: "utf8" }));
      }
      return true;
    });
    expect(lease).toMatchObject({ ok: false, reason: "in-use" });
    expect(pruned.removed).toHaveLength(1);
    expect(existsSync(made.worktree.path)).toBe(false);
    expect(existsSync(`${made.worktree.path}.occupancy`)).toBe(false);
    expect(await pool.lease({ repo, branch, reuseBranch: true, runner: "builder-1", now: later(1_000) })).toMatchObject({ ok: true });
  });

  test.each(["discard", "discardChanges", "prune"])("%s uses only hardened Git and never runs planted hooks", async method => {
    const ordinary = new WorktreePool(store, { root: join(base, "pool") });
    const made = await ordinary.lease({ repo, branch: "toolroll/disposable", base: "main", runner: "builder-1", now: T0 });
    if (!made.ok) throw new Error(made.message);
    await ordinary.release(made.worktree.path, T0);
    const marker = join(base, "hook-ran");
    for (const hook of ["post-checkout", "reference-transaction"]) writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    let calls = 0;
    const hardened = new WorktreePool(store, { root: join(base, "pool"), runner: (file, args, options) => {
      calls++;
      expect(options?.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
      expect(args.includes("--no-includes") || args.includes("core.hooksPath=/dev/null")).toBe(true);
      return run(file, args, options);
    } });
    if (method === "prune") expect((await hardened.prune(store.listWorktrees(), () => true)).removed).toHaveLength(1);
    else if (method === "discard") expect((await hardened.discard(made.worktree.path, T0)).ok).toBe(true);
    else expect((await hardened.discardChanges(made.worktree.path)).ok).toBe(true);
    expect(calls).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(made.worktree.path)).toBe(false);
  });

  test("a checkout edited after its clean check is never removed: not before the final check, nor between it and git's removal", async () => {
    let edit: ((path: string) => void) | null = null;
    const editing: typeof run = async (file, args, options) => {
      if (edit !== null && args.includes("worktree") && args.includes("remove")) { edit(String(args.at(-1))); edit = null; }
      return run(file, args, options);
    };
    const pool = new WorktreePool(store, { root: join(base, "pool"), runner: editing });
    const made = await pool.lease({ repo, branch: "toolroll/late-edit", base: "main", runner: "builder-1", now: T0 });
    if (!made.ok) throw new Error(made.message);
    const path = made.worktree.path;
    expect((await pool.release(path, T0)).ok).toBe(true);

    // Untracked work dropped in after the first inspection, while the caller is asked again.
    const first = await pool.prune(store.listWorktrees(), (_row, fresh) => { if (fresh) writeFileSync(join(path, "notes.md"), "mine\n"); return true; });
    expect(first).toEqual({ removed: [], kept: [{ path, why: "has changes" }] });
    expect(readFileSync(join(path, "notes.md"), "utf8")).toBe("mine\n");
    rmSync(join(path, "notes.md"));

    // A tracked edit after the final inspection, right before git removes it: git refuses, and it all stays.
    edit = at => writeFileSync(join(at, "README.md"), "edited\n");
    const second = await pool.prune(store.listWorktrees(), () => true);
    expect(second).toEqual({ removed: [], kept: [{ path, why: "has changes" }] });
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("edited\n");
    expect(store.getWorktree(path)).not.toBeNull();

    // Clean again, Toolroll's own leftovers (a handoff, the lease note) don't hold it.
    writeFileSync(join(path, "README.md"), "hello\n");
    writeFileSync(join(path, `${HANDOFF_PREFIX}0123456789abcdef${MAILBOX_SUFFIX}`), "{}\n");
    writeFileSync(join(path, MARKER), `${process.pid} builder-1\n`);
    expect((await pool.prune(store.listWorktrees(), () => true)).removed.map(row => row.path)).toEqual([path]);
    expect(existsSync(path)).toBe(false);
    expect(store.getWorktree(path)).toBeNull();
  });
});

describe("fresh base: an untouched checkout starts from current main", () => {
  let base: string;
  let repo: string;
  let store: Store;
  let ref: number;
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commitOnMain = (name: string) => { writeFileSync(join(repo, name), `${name}\n`); git(["add", name]); git(["commit", "-qm", name]); return git(["rev-parse", "main"]); };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-fresh-")));
    repo = join(base, "repo");
    mkdirSync(repo);
    store = openStore(":memory:");
    register(store, { name: "builder-1", host: "test", now: T0 });
    store.createTask({ id: "t-fresh", title: "follow-up filed before the release merged" }, T0);
    ref = store.refFor("built-in", "t-fresh").id;
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    commitOnMain("README.md");
  });

  afterEach(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  /** One finished attempt on the branch, so the branch has a recorded base, then the checkout handed back. */
  const firstAttempt = async (pool: WorktreePool, branch: string) => {
    const first = await pool.lease({ repo, branch, base: "main", runner: "builder-1", taskRef: ref, now: T0 });
    if (!first.ok) throw new Error(first.message);
    const run = store.startRun({ taskRef: ref, leaseId: "l-1", runner: "builder-1", branch, worktree: first.worktree.path, ...bareLegacy("build"), now: T0 });
    store.stampRun(run, { baseRevision: git(["rev-parse", "HEAD"], first.worktree.path) });
    store.finishRun(run, { outcome: "failed", reason: "unknown", now: T0 });
    expect((await pool.release(first.worktree.path, later(1_000))).ok).toBe(true);
    return first.worktree.path;
  };

  test("a branch with no commits of its own moves, with its checkout, to the newer main; the whole-task base follows it", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const old = git(["rev-parse", "main"]);
    const path = await firstAttempt(pool, "toolroll/t-fresh");
    commitOnMain("release-0.9.61.md");
    const main = commitOnMain("release-notes.md");

    const again = await pool.lease({ repo, branch: "toolroll/t-fresh", runner: "builder-1", taskRef: ref, now: later(2_000),
      freshBase: { main: "main", recordedBase: store.recordedBranchBase(ref, "toolroll/t-fresh") } });

    expect(again).toMatchObject({ ok: true, base: { head: main, main, behind: 0, moved: { from: old, behind: 2 }, kept: null } });
    expect(git(["rev-parse", "HEAD"], path)).toBe(main);
    expect(git(["rev-parse", "refs/heads/toolroll/t-fresh"])).toBe(main);
    expect(existsSync(join(path, "release-notes.md"))).toBe(true);
    expect(store.latestBranchBaseMove(ref, "toolroll/t-fresh")).toMatchObject({ from: old, to: main });
    // Until the next attempt records its base nothing older pins the branch; then that base is the whole-task origin.
    expect(store.firstBuilderBase(ref, "toolroll/t-fresh")).toBeNull();
    const next = store.startRun({ taskRef: ref, leaseId: "l-2", runner: "builder-1", branch: "toolroll/t-fresh", worktree: path, ...bareLegacy("build"), now: later(3_000) });
    store.stampRun(next, { baseRevision: main });
    expect(store.firstBuilderBase(ref, "toolroll/t-fresh")).toBe(main);
    expect(store.recordedBranchBase(ref, "toolroll/t-fresh")).toBe(main);
  });

  test("a branch with its own commit is never moved, and says how far behind main it is", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const path = await firstAttempt(pool, "toolroll/t-fresh");
    writeFileSync(join(path, "work.ts"), "export const work = 1;\n");
    git(["add", "work.ts"], path);
    git(["commit", "-qm", "the task's own work"], path);
    const head = git(["rev-parse", "HEAD"], path);
    const main = commitOnMain("release-0.9.61.md");

    const again = await pool.lease({ repo, branch: "toolroll/t-fresh", runner: "builder-1", taskRef: ref, now: later(2_000),
      freshBase: { main: "main", recordedBase: store.recordedBranchBase(ref, "toolroll/t-fresh") } });

    expect(again).toMatchObject({ ok: true, base: { head, main, behind: 1, moved: null, kept: "has commits" } });
    expect(git(["rev-parse", "HEAD"], path)).toBe(head);
    expect(git(["rev-parse", "refs/heads/toolroll/t-fresh"])).toBe(head);
    expect(store.latestBranchBaseMove(ref, "toolroll/t-fresh")).toBeNull();
  });

  test("a commit main already has still counts as the task's own once a base was recorded", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const path = await firstAttempt(pool, "toolroll/t-fresh");
    writeFileSync(join(path, "work.ts"), "export const work = 1;\n");
    git(["add", "work.ts"], path);
    git(["commit", "-qm", "the task's own work"], path);
    const head = git(["rev-parse", "HEAD"], path);
    git(["merge", "-q", "--ff-only", "toolroll/t-fresh"]);
    commitOnMain("release-0.9.61.md");

    const again = await pool.lease({ repo, branch: "toolroll/t-fresh", runner: "builder-1", taskRef: ref, now: later(2_000),
      freshBase: { main: "main", recordedBase: store.recordedBranchBase(ref, "toolroll/t-fresh") } });

    expect(again).toMatchObject({ ok: true, base: { head, behind: 1, kept: "has commits" } });
    expect(git(["rev-parse", "HEAD"], path)).toBe(head);
  });

  test("a checkout with changes is never moved and keeps every byte", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const path = await firstAttempt(pool, "toolroll/t-fresh");
    const head = git(["rev-parse", "HEAD"], path);
    // A recovered draft: the task's own leftover the next attempt inherits in place.
    writeFileSync(join(path, "README.md"), "README.md\nhalf an edit\n");
    writeFileSync(join(path, "draft.ts"), "export const draft = 1;\n");
    const main = commitOnMain("release-0.9.61.md");

    // Without reclaim a dirty checkout already refuses the lease.
    const held = await pool.lease({ repo, branch: "toolroll/t-fresh", runner: "builder-1", taskRef: ref, now: later(2_000),
      freshBase: { main: "main", recordedBase: store.recordedBranchBase(ref, "toolroll/t-fresh") } });
    expect(held).toMatchObject({ ok: false, reason: "dirty" });

    // A recovered draft is kept in place under a fresh lease; the same check inside it never moves the tree.
    const freshen = (pool as unknown as { freshen: (...args: unknown[]) => Promise<unknown> }).freshen.bind(pool);
    const standing = await freshen(repo, path, "toolroll/t-fresh", ref, { main: "main", recordedBase: head }, later(3_000));

    expect(standing).toMatchObject({ ok: true, standing: { head, main, behind: 1, moved: null, kept: "has changes" } });
    expect(git(["rev-parse", "HEAD"], path)).toBe(head);
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("README.md\nhalf an edit\n");
    expect(readFileSync(join(path, "draft.ts"), "utf8")).toBe("export const draft = 1;\n");
    expect(store.latestBranchBaseMove(ref, "toolroll/t-fresh")).toBeNull();
  });

  test("a branch nothing recorded a base for moves only when main already has its HEAD", async () => {
    const pool = new WorktreePool(store, { root: join(base, "pool") });
    const first = await pool.lease({ repo, branch: "toolroll-plan/t-fresh", base: "main", runner: "builder-1", taskRef: ref, now: T0 });
    if (!first.ok) throw new Error(first.message);
    expect((await pool.release(first.worktree.path, later(1_000))).ok).toBe(true);
    const main = commitOnMain("release-0.9.61.md");

    const again = await pool.lease({ repo, branch: "toolroll-plan/t-fresh", runner: "builder-1", taskRef: ref, now: later(2_000), freshBase: { main: "main", recordedBase: null } });

    expect(again).toMatchObject({ ok: true, base: { head: main, behind: 0, moved: { behind: 1 } } });
  });
});
