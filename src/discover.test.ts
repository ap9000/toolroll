import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRepo, discover, type Runner } from "./discover.js";
import { NOT_FOUND_CODE, TIMEOUT_CODE, run, type ExecResult } from "./exec.js";

const ok = (stdout: string): ExecResult => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  notFound: false,
});

const fail = (code: number, stderr: string): ExecResult => ({
  code,
  stdout: "",
  stderr,
  timedOut: false,
  notFound: false,
});

const timedOut = (): ExecResult => ({
  code: TIMEOUT_CODE,
  stdout: "",
  stderr: "",
  timedOut: true,
  notFound: false,
});

/**
 * Dispatches on the git subcommand. The two branch reads are told apart by the
 * format string, since the fallback exists precisely to avoid the costly one.
 */
const fakeGit = (responses: Record<string, ExecResult>, calls: string[] = []): Runner => {
  return async (_file, args) => {
    const subcommand = args.find(argument => !argument.startsWith("-")) ?? "";
    const key =
      subcommand === "for-each-ref" && !args.some(argument => argument.includes("upstream:track"))
        ? "for-each-ref:cheap"
        : subcommand;
    calls.push(key);
    return responses[key] ?? ok("");
  };
};

const WORKTREES = ["worktree /repo", "HEAD abc123", "branch refs/heads/main", ""].join("\n");
const BRANCHES = [
  "main\t\t2026-08-10T09:00:00+00:00",
  "feature/onboarding\t[ahead 4]\t2026-08-09T22:00:00+00:00",
].join("\n");
const BRANCHES_WITHOUT_TRACK = [
  "main\t\t2026-08-10T09:00:00+00:00",
  "feature/onboarding\t\t2026-08-09T22:00:00+00:00",
].join("\n");

describe("inspectRepo", () => {
  test("does not read the working tree unless asked", async () => {
    // `git status` is O(working tree) where every other read is O(refs), and it
    // was measured at over two minutes on a real repo. It is not free by default.
    const calls: string[] = [];
    const runner = fakeGit({ worktree: ok(WORKTREES), "symbolic-ref": ok("main\n") }, calls);

    const snapshot = await inspectRepo("/repo", { runner });

    expect(calls).not.toContain("status");
    expect(snapshot.dirtyFiles).toBeNull();
  });

  test("falls back to a cheaper branch read when ahead/behind is too slow", async () => {
    // %(upstream:track) walks history per branch: 22s cold on a 304MB repo.
    // Losing ahead/behind beats losing the branch list.
    const calls: string[] = [];
    const runner = fakeGit(
      {
        worktree: ok(WORKTREES),
        "for-each-ref": timedOut(),
        "for-each-ref:cheap": ok(BRANCHES_WITHOUT_TRACK),
        "symbolic-ref": ok("main\n"),
      },
      calls,
    );

    const snapshot = await inspectRepo("/repo", { runner });

    expect(calls).toContain("for-each-ref:cheap");
    expect(snapshot.branches.map(branch => branch.name)).toEqual(["main", "feature/onboarding"]);
    expect(snapshot.branches[0]?.track).toEqual({ ahead: 0, behind: 0, gone: false });
    // the zeroed track is absence of data, not evidence of being in sync
    expect(snapshot.hasTracking).toBe(false);
    // what was withheld is stated, never silently dropped
    expect(snapshot.problems.join(" ")).toContain("ahead/behind");
  });

  // A repo with no remote is ordinary, and symbolic-ref exits non-zero on a detached HEAD: facts, not problems.
  test.each([
    ["a missing origin", { remote: fail(2, "error: No such remote 'origin'") }, { remoteUrl: null }],
    ["a detached HEAD", { "symbolic-ref": fail(1, "") }, { head: null }],
  ] as const)("treats %s as a fact, not a problem", async (_name, responses, expected) => {
    const runner = fakeGit({ worktree: ok(WORKTREES), "symbolic-ref": ok("main\n"), ...responses });
    const snapshot = await inspectRepo("/repo", { runner });
    expect(snapshot).toMatchObject(expected);
    expect(snapshot.problems).toEqual([]);
  });

  test("names what it could not read instead of swallowing it", async () => {
    const runner = fakeGit({
      worktree: fail(128, "fatal: not a git repository\n"),
      "for-each-ref": ok(BRANCHES),
      "symbolic-ref": ok("main\n"),
    });

    const snapshot = await inspectRepo("/repo", { runner });

    expect(snapshot.problems).toHaveLength(1);
    expect(snapshot.problems[0]).toContain("not a git repository");
    // the rest of the snapshot still arrives
    expect(snapshot.branches).toHaveLength(2);
  });

  test("reports a missing git binary once, not once per command", async () => {
    const missing: ExecResult = {
      code: NOT_FOUND_CODE,
      stdout: "",
      stderr: "",
      timedOut: false,
      notFound: true,
    };
    const runner: Runner = async () => missing;

    const snapshot = await inspectRepo("/repo", { runner });

    expect(snapshot.problems).toEqual(["git is not installed"]);
  });

});

describe("discover", () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "standing-orders-discover-"));
    await mkdir(join(base, "alpha", ".git"), { recursive: true });
    await mkdir(join(base, "beta", ".git"), { recursive: true });
    await writeFile(join(base, "readme.md"), "not a repo\n");
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("returns one snapshot per repo, ordered by path", async () => {
    const runner = fakeGit({ worktree: ok(WORKTREES), "symbolic-ref": ok("main\n") });

    const snapshots = await discover([base], { runner });

    expect(snapshots.map(snapshot => snapshot.name)).toEqual(["alpha", "beta"]);
  });
});

describe("inspectRepo against a real repository", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "standing-orders-real-"));
    const identity = ["-c", "user.email=test@example.com", "-c", "user.name=Test"];
    await run("git", ["init", "-b", "main", repo]);
    await writeFile(join(repo, "file.txt"), "hello\n");
    await run("git", [...identity, "add", "."], { cwd: repo });
    await run("git", [...identity, "commit", "-m", "initial"], { cwd: repo });
    await writeFile(join(repo, "dirty.txt"), "uncommitted\n");
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("reads branch, worktree, and dirty state from git itself", async () => {
    // The fakes prove assembly; only a real repo proves the flags are right.
    const snapshot = await inspectRepo(repo, { dirty: true });

    expect(snapshot.problems).toEqual([]);
    expect(snapshot.head).toBe("main");
    expect(snapshot.branches.map(branch => branch.name)).toEqual(["main"]);
    expect(snapshot.worktrees).toHaveLength(1);
    expect(snapshot.dirtyFiles).toBe(1);
    expect(snapshot.remoteUrl).toBeNull();
  });
});
