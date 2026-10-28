/**
 * Attack: steer the plane's own git writes into another repository through the checkout's git pointers (Codex review
 * of e48e9d8d). A checkout's `.git` file, its worktree folder's `commondir` and `gitdir` are all agent-written; git
 * follows them, and its ref store reads `commondir` again as it goes. An agent pointing them at another repository's
 * worktree, or its `.git`, would have the plane's `add` and `commit` write that repository's index and refs. The plane
 * now binds a checkout to one repository (teardown-git.ts boundDirs): its pointers must name each other back, as real
 * paths, under a real `.git` folder — the project's own when the caller has its record — proven before git runs and
 * again after. Also here: the views live in the fenced views folder and are cleaned up whatever happens, a removal
 * without --force judges the target by its own settings, and reftable, prune and a config write behave as documented.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../../src/exec.js";
import { gitViewsRoot } from "../../src/git-views.js";
import { checkoutGit, refusal, teardownGit } from "../../src/teardown-git.js";
import type { Runner } from "../../src/worktree.js";

let root: string, a: string, aLinked: string, b: string, bLinked: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (at: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", at, ...args], { env, stdio: "pipe", encoding: "utf8" });
const repository = (path: string, format: "files" | "reftable" = "files") => {
  execFileSync("git", ["init", "-q", "-b", "main", `--ref-format=${format}`, path], { env });
  writeFileSync(join(path, "a.txt"), "one\n");
  git(path, "add", "a.txt");
  git(path, "commit", "-qm", "one");
  return path;
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-gitbind-")));
  a = repository(join(root, "a")); b = repository(join(root, "b"));
  aLinked = join(root, "a-task"); bLinked = join(root, "b-task");
  git(a, "worktree", "add", "-q", "-b", "task", aLinked);
  git(b, "worktree", "add", "-q", "-b", "task", bLinked);
  writeFileSync(join(aLinked, "a.txt"), "agent's work\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const views = () => { try { return readdirSync(gitViewsRoot(realpathSync(homedir()))); } catch { return []; } };
const bState = () => [git(b, "rev-parse", "task"), readFileSync(join(b, ".git", "worktrees", "b-task", "index")).toString("base64")];
const build = (binding = {}) => checkoutGit(run, "build", binding);
const attempt = async (binding = {}) => {
  const results = [];
  for (const args of [["add", "-A"], ["commit", "--no-verify", "-m", "x"]]) results.push(await build(binding)("git", args, { cwd: aLinked, timeoutMs: 60_000 }));
  return results;
};

describe("attack: the checkout's git pointers steer the plane's writes elsewhere", () => {
  test("control: plain git follows a redirected .git into the other repository", () => {
    const before = bState();
    writeFileSync(join(aLinked, ".git"), `gitdir: ${join(b, ".git", "worktrees", "b-task")}\n`);
    git(aLinked, "add", "-A");
    expect(bState()[1]).not.toBe(before[1]);
  });

  test.each([
    ["the .git file names another repository's worktree", () => writeFileSync(join(aLinked, ".git"), `gitdir: ${join(b, ".git", "worktrees", "b-task")}\n`)],
    ["the .git file names another repository's .git", () => writeFileSync(join(aLinked, ".git"), `gitdir: ${join(b, ".git")}\n`)],
    ["the worktree folder's commondir names another repository", () => writeFileSync(join(a, ".git", "worktrees", "a-task", "commondir"), `${join(b, ".git")}\n`)],
    ["the worktree folder is a link to another repository's", () => {
      rmSync(join(a, ".git", "worktrees", "a-task"), { recursive: true });
      symlinkSync(join(b, ".git", "worktrees", "b-task"), join(a, ".git", "worktrees", "a-task"));
    }],
    ["the .git is a link", () => { rmSync(join(aLinked, ".git")); symlinkSync(join(b, ".git"), join(aLinked, ".git")); }],
  ])("%s: refused, the other repository untouched", async (_name, redirect) => {
    const before = bState();
    redirect();
    for (const result of await attempt()) expect(refusal(result), result.stderr).not.toBeNull();
    expect(bState()).toEqual(before);
  });

  test("a checkout of another repository than the project's record is refused", async () => {
    const before = bState();
    for (const result of await attempt({ repo: b })) expect(refusal(result), result.stderr).toContain("another repository than the project's");
    expect(bState()).toEqual(before);
    // Its own project's record: the work lands.
    const [added, made] = await attempt({ repo: a });
    expect(added!.code, added!.stderr).toBe(0);
    expect(made!.code, made!.stderr).toBe(0);
    expect(git(a, "show", "task:a.txt")).toBe("agent's work\n");
  });

  test("commondir rewritten while git runs: the command is reported refused, never as done", async () => {
    let planted = false;
    const inner: Runner = async (file, args, options) => {
      const result = await run(file, args, options);
      if (!planted && args.includes("config") && args.includes("--show-scope")) {
        planted = true;
        writeFileSync(join(a, ".git", "worktrees", "a-task", "commondir"), `${join(b, ".git")}\n`);
      }
      return result;
    };
    const result = await checkoutGit(inner, "build", { repo: a })("git", ["add", "-A"], { cwd: aLinked, timeoutMs: 60_000 });
    expect(planted).toBe(true);
    expect(refusal(result), result.stderr).toContain("changed while git ran");
  });
});

describe("the views themselves", () => {
  test("are made in the fenced views folder and removed after success, failure and refusal", async () => {
    const before = new Set(views());
    let during: string[] = [];
    const inner: Runner = async (file, args, options) => {
      if (!args.includes("config")) during = views().filter(one => !before.has(one));
      return run(file, args, options);
    };
    expect((await checkoutGit(inner)("git", ["status", "--porcelain"], { cwd: aLinked })).code).toBe(0);
    expect(during.length).toBeGreaterThan(0);
    expect((await checkoutGit(run)("git", ["rev-parse", "--verify", "no-such-ref"], { cwd: aLinked })).code).not.toBe(0);
    git(a, "config", "core.pager", "less");
    expect(refusal(await checkoutGit(run)("git", ["status"], { cwd: aLinked }))).not.toBeNull();
    expect(refusal(await teardownGit()(a, ["status"]))).not.toBeNull();
    git(a, "config", "--unset", "core.pager");
    expect((await teardownGit()(a, ["worktree", "list"])).code).toBe(0);
    expect(views().filter(one => !before.has(one))).toEqual([]);
  });
});

describe("removal without --force", () => {
  test("judges the target by its own settings: new files its own config shows keep it", async () => {
    git(a, "config", "extensions.worktreeConfig", "true");
    // The folder it is removed from hides untracked files; the target itself doesn't.
    git(a, "config", "--worktree", "status.showUntrackedFiles", "no");
    git(aLinked, "checkout", "--", "a.txt");
    writeFileSync(join(aLinked, "new-work.ts"), "export const work = 1;\n");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: aLinked, env, encoding: "utf8" })).toContain("new-work.ts");
    expect(execFileSync("git", ["-c", "status.showUntrackedFiles=no", "status", "--porcelain"], { cwd: aLinked, env, encoding: "utf8" })).toBe("");
    const removed = await teardownGit()(a, ["worktree", "remove", aLinked]);
    expect(removed.code).not.toBe(0);
    expect(readFileSync(join(aLinked, "new-work.ts"), "utf8")).toBe("export const work = 1;\n");
    // A clean one is removed.
    rmSync(join(aLinked, "new-work.ts"));
    const clean = await teardownGit()(a, ["worktree", "remove", aLinked]);
    expect(clean.code, clean.stderr).toBe(0);
    expect(existsSync(aLinked)).toBe(false);
  });
});

describe("writes through a view, as documented", () => {
  test("reftable: a commit and a branch deletion land in the repository", async () => {
    const r = repository(join(root, "rt"), "reftable");
    const rLinked = join(root, "rt-task");
    git(r, "worktree", "add", "-q", "-b", "task", rLinked);
    writeFileSync(join(rLinked, "b.txt"), "new\n");
    for (const args of [["add", "-A"], ["commit", "--no-verify", "-m", "rt"]]) {
      const result = await checkoutGit(run, "build", { repo: r })("git", args, { cwd: rLinked, timeoutMs: 60_000 });
      expect(result.code, result.stderr).toBe(0);
    }
    expect(git(r, "show", "task:b.txt")).toBe("new\n");
    git(r, "branch", "spare");
    expect((await teardownGit()(r, ["branch", "-D", "spare"])).code).toBe(0);
    expect(git(r, "branch", "--list", "spare")).toBe("");
    git(r, "fsck", "--no-progress");
  });

  test("prune: a worktree whose folder is gone is pruned from the repository", async () => {
    rmSync(bLinked, { recursive: true, force: true });
    const pruned = await teardownGit()(b, ["worktree", "prune"]);
    expect(pruned.code, pruned.stderr).toBe(0);
    expect(existsSync(join(b, ".git", "worktrees", "b-task"))).toBe(false);
  });

  test("a config write stays in the view: branch -D leaves the branch's own section behind", async () => {
    git(a, "branch", "configured");
    git(a, "config", "branch.configured.description", "kept");
    const removed = await teardownGit()(a, ["branch", "-D", "configured"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(git(a, "branch", "--list", "configured")).toBe("");
    expect(git(a, "config", "branch.configured.description").trim()).toBe("kept");
  });
});
