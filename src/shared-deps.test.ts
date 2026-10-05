import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Runner } from "./builder.js";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { addApprover, approve, propose } from "./scope.js";
import { installsOnly, linkedKey, lockDigest, readyCopy, sharedCopies, sharedUse, unusedShared, removeShared, SHARED_GRACE_MS, SHARED_UNUSED_MS, linkInto, promoteInstall, pruneUnusedShared } from "./shared-deps.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-08-11T22:00:00.000Z");
const REPO = "/code/thing";
const tok = (name: string) => `tok-${name}`;

const gitIn = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x",
} }).trim();

/** A real checkout with an npm lockfile, as a lease would hand over. */
function checkout(root: string, name: string, lock = '{"lockfileVersion":3,"packages":{"node_modules/left-pad":{"version":"1.3.0"}}}\n'): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  gitIn(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.evidence/\n");
  writeFileSync(join(dir, "package.json"), '{"name":"thing","dependencies":{"left-pad":"1.3.0"}}\n');
  writeFileSync(join(dir, "package-lock.json"), lock);
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** What `npm ci` leaves: the packages and npm's own record of the tree it installed from this lockfile. */
function fakeInstall(dir: string): void {
  mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(dir, "node_modules", ".package-lock.json"), readFileSync(join(dir, "package-lock.json")));
}

function filesUnder(dir: string): number {
  let count = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) count += name.isDirectory() ? filesUnder(join(dir, name.name)) : 1;
  return count;
}

describe("which setups and lockfiles can share", () => {
  test("only a plain npm install command shares; anything else keeps its own effects", () => {
    expect(installsOnly("npm ci")).toBe(true);
    expect(installsOnly("  npm ci --prefer-offline --no-audit ")).toBe(true);
    expect(installsOnly("npm install --omit=dev")).toBe(true);
    expect(installsOnly("npm ci && npm run build")).toBe(false);
    expect(installsOnly("pnpm install")).toBe(false);
    expect(installsOnly("npm ci; rm -rf /")).toBe(false);
  });

  test("a lockfile that links local folders never shares (its links would point into the shared folder)", () => {
    const root = mkdtempSync(join(tmpdir(), "deps-lock-"));
    const plain = checkout(root, "plain");
    expect(lockDigest(plain)).toMatch(/^[0-9a-f]{64}$/);
    const linked = checkout(root, "linked", '{"packages":{"node_modules/mine":{"resolved":"packages/mine","link":true}}}\n');
    expect(lockDigest(linked)).toBeNull();
    rmSync(join(plain, "package-lock.json"));
    expect(lockDigest(plain)).toBeNull();
  });
});

describe("shared dependencies through the builder", () => {
  let state: string;
  let store: Store;
  let approverToken: string;
  const refs = new Map<string, number>();

  beforeEach(() => {
    state = realpathSync(mkdtempSync(join(tmpdir(), "deps-state-")));
    store = openStore(join(state, "orders.db"));
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    approverToken = added.token;
    register(store, { name: "builder-1", host: "h", capacity: 9, repos: [REPO], now: T0, newToken: () => tok("builder-1") });
    store.setWorktreeSetup({ repo: REPO, command: "npm ci", timeoutMs: 60_000, approvedBy: "alex" }, T0);
    store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, T0);
  });
  afterEach(() => {
    store.close();
    // The shared copy is read-only on disk; make it removable.
    execFileSync("chmod", ["-R", "u+w", state]);
    rmSync(state, { recursive: true, force: true });
  });

  /** One task, its leased checkout and an open run, the way the dispatcher hands them to build(). */
  const leaseTask = (id: string, worktree: string) => {
    store.createTask({ id, title: id }, T0);
    const taskRef = store.refFor("built-in", id).id;
    refs.set(id, taskRef);
    store.placeTask(taskRef, REPO);
    store.saveWorktree({ path: worktree, repo: REPO, branch: `feat/${id}`, runner: "builder-1", taskRef, createdAt: T0.toISOString(), leasedAt: T0.toISOString(), releasedAt: null, verified: true });
    propose(store, { taskId: id, goal: "add a guard", now: T0 });
    approve(store, id, "alex", T0, store.getScope(id)!.digest, approverToken);
    acquire(store, taskRef, "builder-1", { token: tok("builder-1"), now: T0, ttlMs: 60 * 60_000, newLeaseId: () => `lease-${id}` });
    const authority = store.routeAuthorityFor(taskRef, "builder", null) ?? store.routeAuthorityFor(taskRef, "builder", null, { provider: "claude", model: null });
    const route = authority === null || !authority.ok ? {} : { route: authority.stamp };
    return { taskId: id, taskRef, runner: "builder-1", worktree, leaseId: `lease-${id}`, branch: `feat/${id}`, now: T0, evidenceRoot: join(state, "evidence"),
      runId: store.startRun({ taskRef, leaseId: `lease-${id}`, runner: "builder-1", branch: `feat/${id}`, worktree, now: T0, ...route }) };
  };

  const fakeGit = (branch: string): Runner => async (_file, args) => {
    if (args.includes("rev-parse")) return { ...OK, stdout: `${branch}\n` };
    if (args.includes("symbolic-ref")) return args.includes("refs/remotes/origin/HEAD") ? { ...OK, code: 1 } : { ...OK, stdout: "main\n" };
    return args.includes("status") ? { ...OK, stdout: " M src/index.ts\n" } : { ...OK };
  };

  /** An agent that concludes, after doing `work` in its checkout. */
  const agentDoing = (work: (cwd: string, prompt: string) => void): Runner => async (_file, args, options) => {
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    work(options!.cwd!, prompt);
    const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)![0];
    writeFileSync(join(options!.cwd!, done), JSON.stringify({ version: 1, status: "completed", conclusion: "Added the guard." }));
    return { ...OK, stdout: JSON.stringify({ result: "Added the guard." }) };
  };

  test("c1: the first checkout's install becomes the shared copy and a new checkout links it instead of installing", async () => {
    const deps = join(state, "deps");
    const first = checkout(state, "first");
    const second = checkout(state, "second");
    const setups: string[] = [];
    const setup: Runner = async (_file, args, options) => { setups.push(options!.cwd!); expect(args.at(-1)).toBe("npm ci"); fakeInstall(options!.cwd!); return OK; };
    const seen: boolean[] = [];
    const verify: Runner = async (_file, _args, options) => { seen.push(existsSync(join(options!.cwd!, "node_modules", "left-pad", "index.js"))); return { ...OK, stdout: "passed" }; };

    const one = leaseTask("t-1", first);
    expect(await build(store, { ...one, agent: agentDoing(() => {}), git: fakeGit("feat/t-1"), setup, verify })).toMatchObject({ ok: true, committed: true });
    expect(setups).toEqual([first]);
    const key = linkedKey(first, deps);
    expect(key).not.toBeNull();
    expect(lstatSync(join(first, "node_modules", "left-pad")).isSymbolicLink()).toBe(true);
    expect(readyCopy(deps, key!)).toBe(join(deps, key!, "node_modules"));

    let prompt = "";
    const two = leaseTask("t-2", second);
    expect(await build(store, { ...two, agent: agentDoing((_cwd, said) => { prompt = said; }), git: fakeGit("feat/t-2"), setup, verify })).toMatchObject({ ok: true, committed: true });
    // No second install: the new checkout links the same copy, and holds none of its files.
    expect(setups).toEqual([first]);
    expect(linkedKey(second, deps)).toBe(key);
    expect(seen).toEqual([true, true]);
    expect(prompt).toContain("node_modules here links a shared, read-only install");
    // The link is no work of anybody's: Git doesn't see it, so no commit can take it.
    expect(gitIn(second, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(store.getWorktree(second)?.setupDigest).toBe(store.liveWorktreeSetup(REPO)!.digest);
    expect(sharedUse(deps, [{ path: first, repo: REPO }, { path: second, repo: REPO }])).toMatchObject([{ key, checkouts: [first, second].sort() }]);
  });

  test("c2: a task that changes the lockfile gets its own install and the shared copy is never altered", async () => {
    const deps = join(state, "deps");
    const first = checkout(state, "first");
    const setups: string[] = [];
    const setup: Runner = async (_file, _args, options) => { setups.push(options!.cwd!); fakeInstall(options!.cwd!); return OK; };
    await build(store, { ...leaseTask("t-1", first), agent: agentDoing(() => {}), git: fakeGit("feat/t-1"), setup, verify: async () => OK });
    const key = linkedKey(first, deps)!;
    const shared = join(deps, key, "node_modules");
    const before = readFileSync(join(shared, ".package-lock.json"), "utf8");

    const changer = checkout(state, "changer");
    let blocked = false;
    let ownAtCheck = false;
    const agent = agentDoing(cwd => {
      // Writing through the link is refused: the shared copy is read-only to the build.
      try { writeFileSync(join(cwd, "node_modules", "left-pad", "index.js"), "mutated"); } catch { blocked = true; }
      writeFileSync(join(cwd, "package-lock.json"), '{"lockfileVersion":3,"packages":{"node_modules/left-pad":{"version":"1.3.1"}}}\n');
    });
    const verify: Runner = async (_file, _args, options) => {
      ownAtCheck = !lstatSync(join(options!.cwd!, "node_modules", "left-pad")).isSymbolicLink() && readFileSync(join(options!.cwd!, "node_modules", ".package-lock.json"), "utf8").includes("1.3.1");
      return { ...OK, stdout: "passed" };
    };
    const req = leaseTask("t-2", changer);
    expect(await build(store, { ...req, agent, git: fakeGit("feat/t-2"), setup, verify })).toMatchObject({ ok: true, committed: true });
    expect(blocked).toBe(true);
    // The setup ran a second time, in the changed checkout only, before its check.
    expect(setups).toEqual([first, changer]);
    expect(ownAtCheck).toBe(true);
    expect(linkedKey(changer, deps)).toBeNull();
    // The shared copy is exactly as it was made, still linked by the first checkout, and still offered.
    expect(readFileSync(join(shared, ".package-lock.json"), "utf8")).toBe(before);
    expect(readFileSync(join(shared, "left-pad", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(readyCopy(deps, key)).toBe(shared);
    expect(sharedCopies(deps)).toHaveLength(1);
  });

  test("a shared copy changed after it was made is retired: never linked again, while a checkout using it keeps working", () => {
    const deps = join(state, "deps");
    const first = checkout(state, "first");
    fakeInstall(first);
    const facts = { root: deps, repo: REPO, worktree: first, key: "a".repeat(24), lock: lockDigest(first)!, node: "v22 darwin arm64", setupDigest: "s", now: T0 };
    expect(promoteInstall(facts)).toBe("link");
    const shared = join(deps, facts.key, "node_modules");
    execFileSync("chmod", ["-R", "u+w", shared]);
    writeFileSync(join(shared, ".package-lock.json"), "something installed through the link");
    expect(readyCopy(deps, facts.key)).toBeNull();
    expect(existsSync(join(first, "node_modules", "left-pad", "index.js"))).toBe(true);
    expect(sharedCopies(deps)[0]).toMatchObject({ key: facts.key, retired: true });
  });

  test("storage clean removes a copy no checkout uses, once nothing has linked it for the grace period", () => {
    const deps = join(state, "deps");
    const first = checkout(state, "first");
    fakeInstall(first);
    const key = "b".repeat(24);
    promoteInstall({ root: deps, repo: REPO, worktree: first, key, lock: lockDigest(first)!, node: "v22", setupDigest: "s", now: T0 });
    const later = new Date(Date.now() + SHARED_GRACE_MS + 60_000);
    expect(unusedShared(deps, [{ path: first, repo: REPO }], later).copies).toEqual([]);
    rmSync(first, { recursive: true, force: true });
    expect(unusedShared(deps, [{ path: first, repo: REPO }], new Date()).copies).toEqual([]);
    const gone = unusedShared(deps, [{ path: first, repo: REPO }], later).copies;
    expect(gone.map(one => one.key)).toEqual([key]);
    expect(removeShared(gone[0]!.dir)).toBe(true);
    expect(sharedCopies(deps)).toEqual([]);
  });

  test("the daily sweep removes a copy only once no checkout has used it for a week, and marks installs for Spotlight", () => {
    const deps = join(state, "deps");
    const first = checkout(state, "first");
    fakeInstall(first);
    const key = "d".repeat(24);
    expect(promoteInstall({ root: deps, repo: REPO, worktree: first, key, lock: lockDigest(first)!, node: "v22", setupDigest: "s", now: T0 })).toBe("link");
    expect(existsSync(join(deps, ".metadata_never_index"))).toBe(true);
    expect(existsSync(join(first, "node_modules", ".metadata_never_index"))).toBe(true);
    const rows = [{ path: first, repo: REPO }];
    const weekLater = new Date(Date.now() + SHARED_UNUSED_MS + 60_000);
    // Still linked by a checkout: stays however old.
    expect(pruneUnusedShared(deps, () => rows, weekLater)).toEqual({ removed: [], failed: [] });
    rmSync(first, { recursive: true, force: true });
    // Nobody uses it, but it was linked within the week: stays.
    expect(pruneUnusedShared(deps, () => rows, new Date(Date.now() + SHARED_UNUSED_MS - 60_000))).toEqual({ removed: [], failed: [] });
    // A checkout picks it up between the look and the removal: stays.
    let looks = 0;
    const second = checkout(state, "second");
    expect(linkInto(second, join(deps, key, "node_modules"))).toBe("link");
    expect(pruneUnusedShared(deps, () => (++looks === 1 ? [] : [{ path: second, repo: REPO }]), weekLater).removed).toEqual([]);
    expect(sharedCopies(deps).map(one => one.key)).toEqual([key]);
    // A week after its last use with nobody on it: goes.
    rmSync(second, { recursive: true, force: true });
    const done = pruneUnusedShared(deps, () => [], new Date(Date.now() + SHARED_UNUSED_MS + 60_000));
    expect(done.removed.map(one => one.key)).toEqual([key]);
    expect(sharedCopies(deps)).toEqual([]);
  });

  test("a checkout that can't link falls back: a new checkout gets nothing linked over an existing node_modules", () => {
    const deps = join(state, "deps");
    const first = checkout(state, "first");
    fakeInstall(first);
    promoteInstall({ root: deps, repo: REPO, worktree: first, key: "c".repeat(24), lock: lockDigest(first)!, node: "v22", setupDigest: "s", now: T0 });
    const own = checkout(state, "own");
    fakeInstall(own);
    expect(linkInto(own, join(deps, "c".repeat(24), "node_modules"))).toBeNull();
    expect(lstatSync(join(own, "node_modules")).isDirectory()).toBe(true);
    expect(filesUnder(join(own, "node_modules"))).toBe(2);
  });
});
