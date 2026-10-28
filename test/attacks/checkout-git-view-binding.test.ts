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
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../../src/exec.js";
import { gitViewsRoot } from "../../src/git-views.js";
import { onGitIncident, type GitIncident } from "../../src/git-incident.js";
import { checkoutGit, hardenedGit, refusal, teardownGit } from "../../src/teardown-git.js";
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

  test("control: with GIT_COMMON_DIR set, git's ref store still follows GIT_DIR's commondir (git 2.50.1)", () => {
    // Why GIT_DIR is the plane's own too: a view of the common folder alone doesn't pin where refs are written.
    execFileSync("git", ["-C", b, "fetch", "-q", a, "main:from-a"], { env });
    git(b, "update-ref", "refs/heads/task", "from-a");
    const view = realpathSync(mkdtempSync(join(tmpdir(), "so-gitbind-view-")));
    for (const name of readdirSync(join(a, ".git"))) if (name !== "config") symlinkSync(join(a, ".git", name), join(view, name));
    writeFileSync(join(view, "config"), readFileSync(join(a, ".git", "config")));
    writeFileSync(join(a, ".git", "worktrees", "a-task", "commondir"), `${join(b, ".git")}\n`);
    const before = git(b, "rev-parse", "task");
    const at = { ...env, GIT_DIR: join(a, ".git", "worktrees", "a-task"), GIT_COMMON_DIR: view, GIT_WORK_TREE: aLinked };
    execFileSync("git", ["add", "-A"], { cwd: aLinked, env: at });
    execFileSync("git", ["commit", "-qm", "x"], { cwd: aLinked, env: at });
    expect(git(b, "rev-parse", "task")).not.toBe(before);
    rmSync(view, { recursive: true, force: true });
  });

  test("commondir rewritten while git runs: git never follows it; the work lands in its own repository, and the tamper is an incident", async () => {
    const heard: GitIncident[] = [];
    const stop = onGitIncident(incident => heard.push(incident));
    try {
      const before = bState();
      let planted = false;
      const inner: Runner = async (file, args, options) => {
        const result = await run(file, args, options);
        if (!planted && args.includes("config") && args.includes("--show-scope")) {
          planted = true;
          writeFileSync(join(a, ".git", "worktrees", "a-task", "commondir"), `${join(b, ".git")}\n`);
        }
        return result;
      };
      const head = git(a, "rev-parse", "task");
      await checkoutGit(run, "build", { repo: a })("git", ["add", "-A"], { cwd: aLinked, timeoutMs: 60_000 });
      const result = await checkoutGit(inner, "build", { repo: a })("git", ["commit", "--no-verify", "-m", "x"], { cwd: aLinked, timeoutMs: 60_000 });
      expect(planted).toBe(true);
      expect(refusal(result), result.stderr).toContain("changed while git ran");
      expect(bState()).toEqual(before);
      expect(git(a, "rev-parse", "task")).not.toBe(head);
      expect(heard).toHaveLength(1);
    } finally { stop(); }
  });

  test("a folder of the repository swapped for a link while git runs: an incident, recorded and told; nothing run where the swap leads", async () => {
    // B shares A's first commit (so git can write through the swap), as a clone would.
    execFileSync("git", ["-C", b, "fetch", "-q", a, "main:from-a"], { env });
    git(b, "update-ref", "refs/heads/task", "from-a");
    const bLog = () => { try { return readFileSync(join(b, ".git", "logs", "refs", "heads", "task"), "utf8"); } catch { return ""; } };
    const heard: GitIncident[] = [];
    const stop = onGitIncident(incident => heard.push(incident));
    try {
      await checkoutGit(run, "build", { repo: a })("git", ["add", "-A"], { cwd: aLinked, timeoutMs: 60_000 });
      let swapped = false;
      const inner: Runner = async (file, args, options) => {
        const result = await run(file, args, options);
        if (!swapped && args.includes("config") && args.includes("--show-scope")) {
          swapped = true;
          renameSync(join(a, ".git", "refs"), join(root, "a-refs"));
          symlinkSync(join(b, ".git", "refs"), join(a, ".git", "refs"));
        }
        return result;
      };
      const logBefore = bLog();
      const result = await checkoutGit(inner, "build", { repo: a })("git", ["commit", "--no-verify", "-m", "through the swap"], { cwd: aLinked, timeoutMs: 60_000 });
      expect(swapped).toBe(true);
      expect(refusal(result), result.stderr).toContain("changed while git ran");
      expect(heard).toHaveLength(1);
      expect(heard[0]!.swapped).toEqual([{ path: join(realpathSync(a), ".git", "refs"), leadsTo: realpathSync(join(b, ".git", "refs")) }]);
      const record = readFileSync(join(realpathSync(homedir()), ".toolroll", "git-incidents.jsonl"), "utf8").trim().split("\n").at(-1)!;
      expect(JSON.parse(record)).toMatchObject({ checkout: realpathSync(aLinked), swapped: heard[0]!.swapped });
      // The plane ran nothing in B on the swap's say: B's log has no entry of its own.
      expect(bLog()).toBe(logBefore);
    } finally { stop(); }
  });
});

describe("the worktree's own files git rewrites go back to it", () => {
  test("a merge in a detached checkout moves its HEAD; a conflicted one can be aborted", async () => {
    const scratch = join(root, "scratch");
    git(a, "worktree", "add", "-q", "--detach", scratch, "main");
    const side = join(root, "side");
    git(a, "worktree", "add", "-q", "-b", "side", side, "main");
    writeFileSync(join(side, "s.txt"), "side\n");
    git(side, "add", "s.txt");
    git(side, "commit", "-qm", "side");
    const merged = await hardenedGit(run)("git", ["-C", scratch, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "--no-edit", "side"], { timeoutMs: 60_000 });
    expect(merged.code, merged.stderr).toBe(0);
    expect(git(scratch, "log", "-1", "--format=%s")).toContain("Merge branch 'side'");
    expect(git(scratch, "rev-parse", "HEAD^2").trim()).toBe(git(a, "rev-parse", "side").trim());
    // A conflict leaves the merge's state in the checkout's own folder; the abort clears it there.
    writeFileSync(join(side, "a.txt"), "side's\n"); git(side, "commit", "-qam", "side a");
    writeFileSync(join(scratch, "a.txt"), "scratch's\n"); git(scratch, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "scratch a");
    const conflicted = await hardenedGit(run)("git", ["-C", scratch, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "--no-edit", "side"], { timeoutMs: 60_000 });
    expect(conflicted.code).not.toBe(0);
    expect(existsSync(join(a, ".git", "worktrees", "scratch", "MERGE_HEAD"))).toBe(true);
    const aborted = await hardenedGit(run)("git", ["-C", scratch, "merge", "--abort"], { timeoutMs: 60_000 });
    expect(aborted.code, aborted.stderr).toBe(0);
    expect(existsSync(join(a, ".git", "worktrees", "scratch", "MERGE_HEAD"))).toBe(false);
    expect(git(scratch, "status", "--porcelain")).toBe("");
  });

  test("the worktree's own state goes back, each file through a fresh one no link can redirect", async () => {
    const admin = join(a, ".git", "worktrees", "a-task");
    const outside = join(root, "outside");
    writeFileSync(outside, "untouched\n");
    // The temporary name the plane once used, planted as a link: the walk refuses while it is there, and it is never
    // followed.
    for (const name of ["HEAD", "ORIG_HEAD"]) symlinkSync(outside, join(admin, `.${name}.toolroll-${process.pid}`));
    expect(refusal(await checkoutGit(run, "build", { repo: a })("git", ["checkout", "-q", "--detach", "main"], { cwd: aLinked, timeoutMs: 60_000 }))).toContain("link");
    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
    for (const name of ["HEAD", "ORIG_HEAD"]) rmSync(join(admin, `.${name}.toolroll-${process.pid}`));
    rmSync(join(admin, "COMMIT_EDITMSG"), { force: true });
    const detached = await checkoutGit(run, "build", { repo: a })("git", ["checkout", "-q", "--detach", "main"], { cwd: aLinked, timeoutMs: 60_000 });
    expect(detached.code, detached.stderr).toBe(0);
    expect(readFileSync(join(admin, "HEAD"), "utf8").trim()).toBe(git(a, "rev-parse", "main").trim());
    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
    const made = await checkoutGit(run, "build", { repo: a })("git", ["commit", "--no-verify", "-qam", "detached"], { cwd: aLinked, timeoutMs: 60_000 });
    expect(made.code, made.stderr).toBe(0);
    expect(git(aLinked, "log", "-1", "--format=%s").trim()).toBe("detached");
    // The commit's message file persists in the worktree's own folder, as git leaves it.
    expect(readFileSync(join(admin, "COMMIT_EDITMSG"), "utf8")).toContain("detached");
    expect(readdirSync(admin).filter(name => name.startsWith(".toolroll-"))).toEqual([]);
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

describe("every layout the product supports binds (Codex review of a0fa135d)", () => {
  test("the project recorded as its main checkout binds its main checkout, a linked worktree, and one added from a linked worktree", async () => {
    const fromLinked = join(root, "from-linked");
    git(aLinked, "worktree", "add", "-q", "-b", "nested", fromLinked);
    writeFileSync(join(fromLinked, "n.txt"), "nested\n");
    for (const checkout of [a, aLinked, fromLinked]) {
      const status = await checkoutGit(run, "build", { repo: a })("git", ["status", "--porcelain"], { cwd: checkout, timeoutMs: 60_000 });
      expect(status.code, `${checkout}: ${status.stderr}`).toBe(0);
    }
    for (const args of [["add", "-A"], ["commit", "--no-verify", "-m", "nested"]]) {
      const result = await checkoutGit(run, "build", { repo: a })("git", args, { cwd: fromLinked, timeoutMs: 60_000 });
      expect(result.code, result.stderr).toBe(0);
    }
    expect(git(a, "show", "nested:n.txt")).toBe("nested\n");
  });

  test("the anchor is the record's own .git folder: a record that isn't a main checkout, or whose .git was redirected, refuses", async () => {
    // A record naming a linked worktree: its .git is a pointer file, never an anchor (fail closed, not unbound).
    expect(refusal(await checkoutGit(run, "build", { repo: aLinked })("git", ["status"], { cwd: aLinked }))).toContain("project's record");
    expect(refusal(await checkoutGit(run, "build", { repo: join(root, "missing") })("git", ["status"], { cwd: aLinked }))).toContain("project's record");
    // The recorded main checkout's .git redirected to another repository (a link, then a pointer file).
    const before = bState();
    renameSync(join(a, ".git"), join(root, "a-git"));
    symlinkSync(join(b, ".git"), join(a, ".git"));
    expect(refusal(await checkoutGit(run, "build", { repo: a })("git", ["add", "-A"], { cwd: bLinked }))).toContain("project's record");
    rmSync(join(a, ".git"));
    writeFileSync(join(a, ".git"), `gitdir: ${join(b, ".git")}\n`);
    expect(refusal(await checkoutGit(run, "build", { repo: a })("git", ["add", "-A"], { cwd: bLinked }))).toContain("project's record");
    expect(bState()).toEqual(before);
  });
});

describe("attack: links deeper inside the repository (Codex review of a0fa135d)", () => {
  const head = () => readFileSync(join(b, ".git", "refs", "heads", "task"), "utf8");
  test.each([
    ["a branch file linked to another repository's", () => { rmSync(join(a, ".git", "refs", "heads", "task")); symlinkSync(join(b, ".git", "refs", "heads", "task"), join(a, ".git", "refs", "heads", "task")); }],
    ["a ref log linked to another repository's", () => { rmSync(join(a, ".git", "logs", "refs", "heads", "task")); symlinkSync(join(b, ".git", "logs", "refs", "heads", "task"), join(a, ".git", "logs", "refs", "heads", "task")); }],
    ["a ref log hard-linked to another repository's", () => { rmSync(join(a, ".git", "logs", "refs", "heads", "task")); execFileSync("ln", [join(b, ".git", "logs", "refs", "heads", "task"), join(a, ".git", "logs", "refs", "heads", "task")]); }],
    ["a loose-object folder linked elsewhere", () => { const objects = join(a, ".git", "objects"); const one = readdirSync(objects).find(name => /^[0-9a-f]{2}$/.test(name))!; renameSync(join(objects, one), join(root, "moved")); symlinkSync(join(root, "moved"), join(objects, one)); }],
    ["the worktree's own logs linked elsewhere", () => { const logs = join(a, ".git", "worktrees", "a-task", "logs"); rmSync(logs, { recursive: true, force: true }); symlinkSync(join(b, ".git", "logs"), logs); }],
  ])("%s: refused before git runs, the other repository untouched", async (_name, plant) => {
    const before = [head(), readFileSync(join(b, ".git", "logs", "refs", "heads", "task"), "utf8")];
    plant();
    for (const result of await attempt({ repo: a })) expect(refusal(result), result.stderr).toContain("link");
    expect([head(), readFileSync(join(b, ".git", "logs", "refs", "heads", "task"), "utf8")]).toEqual(before);
  });

  test("a folder deeper in refs swapped for a link while git runs: an incident", async () => {
    const heard: GitIncident[] = [];
    const stop = onGitIncident(incident => heard.push(incident));
    try {
      await checkoutGit(run, "build", { repo: a })("git", ["add", "-A"], { cwd: aLinked, timeoutMs: 60_000 });
      let swapped = false;
      const inner: Runner = async (file, args, options) => {
        const result = await run(file, args, options);
        if (!swapped && args.includes("config") && args.includes("--show-scope")) {
          swapped = true;
          const heads = join(a, ".git", "refs", "heads");
          renameSync(heads, join(root, "a-heads"));
          symlinkSync(join(b, ".git", "refs", "heads"), heads);
        }
        return result;
      };
      const result = await checkoutGit(inner, "build", { repo: a })("git", ["commit", "--no-verify", "-m", "x"], { cwd: aLinked, timeoutMs: 60_000 });
      expect(refusal(result), result.stderr).toContain("changed while git ran");
      expect(heard.map(one => one.swapped.map(entry => entry.path))).toEqual([[join(realpathSync(a), ".git", "refs", "heads")]]);
    } finally { stop(); }
  });
});

describe("the walk fails closed (security scan of the round-2 walk)", () => {
  const ln = (from: string, to: string) => execFileSync("ln", [from, to]);
  test.each([
    ["a refs folder that can't be listed", () => { const dir = join(a, ".git", "refs", "heads", "locked"); execFileSync("mkdir", ["-p", dir]); execFileSync("chmod", ["000", dir]); }],
    ["a branch file hard-linked to another repository's", () => { rmSync(join(a, ".git", "refs", "heads", "task")); ln(join(b, ".git", "refs", "heads", "task"), join(a, ".git", "refs", "heads", "task")); }],
    ["packed-refs hard-linked to another repository's", () => { git(b, "pack-refs", "--all"); git(a, "pack-refs", "--all"); rmSync(join(a, ".git", "packed-refs")); ln(join(b, ".git", "packed-refs"), join(a, ".git", "packed-refs")); }],
    ["the worktree's ORIG_HEAD hard-linked elsewhere", () => { writeFileSync(join(b, "orig"), "x\n"); rmSync(join(a, ".git", "worktrees", "a-task", "ORIG_HEAD"), { force: true }); ln(join(b, "orig"), join(a, ".git", "worktrees", "a-task", "ORIG_HEAD")); }],
    ["rr-cache linked elsewhere", () => symlinkSync(join(b, ".git"), join(a, ".git", "rr-cache"))],
    ["a module's folder linked elsewhere", () => { execFileSync("mkdir", ["-p", join(a, ".git", "modules")]); symlinkSync(join(b, ".git"), join(a, ".git", "modules", "lib")); }],
    // The objects exemption is by place: a folder named objects anywhere else is walked like the rest.
    ["a link inside refs/heads/objects/", () => { execFileSync("mkdir", ["-p", join(a, ".git", "refs", "heads", "objects")]); symlinkSync(join(b, ".git", "refs", "heads", "task"), join(a, ".git", "refs", "heads", "objects", "x")); }],
    ["a hard link inside logs/objects/", () => { execFileSync("mkdir", ["-p", join(a, ".git", "logs", "objects")]); ln(join(b, ".git", "logs", "HEAD"), join(a, ".git", "logs", "objects", "x")); }],
    // A forged store: a folder named objects under modules/x/refs/, with a planted HEAD beside it, is no store.
    ["a hard link in a forged modules/x/refs/objects", () => {
      const forged = join(a, ".git", "modules", "x", "refs");
      execFileSync("mkdir", ["-p", join(forged, "objects", "ab")]);
      writeFileSync(join(forged, "HEAD"), "ref: refs/heads/main\n"); writeFileSync(join(a, ".git", "modules", "x", "HEAD"), "ref: refs/heads/main\n");
      ln(join(b, ".git", "logs", "HEAD"), join(forged, "objects", "ab", "x"));
    }],
    // The object store itself: its fan-out folders' entries and pack/ are scanned for links.
    ["a link inside a loose-object folder", () => { const objects = join(a, ".git", "objects"); const one = readdirSync(objects).find(name => /^[0-9a-f]{2}$/.test(name))!; symlinkSync(join(root, "elsewhere"), join(objects, one, "f".repeat(38))); }],
    ["a link inside objects/pack", () => { execFileSync("mkdir", ["-p", join(a, ".git", "objects", "pack")]); symlinkSync(join(root, "elsewhere"), join(a, ".git", "objects", "pack", "pack-x.pack")); }],
  ])("%s: refused before git runs", async (_name, plant) => {
    plant();
    try {
      for (const result of await attempt({ repo: a })) expect(refusal(result), result.stderr).toContain("link");
    } finally { try { execFileSync("chmod", ["-R", "755", join(a, ".git", "refs")]); } catch { /* not changed */ } }
  });

  test("a genuine submodule git directory's objects may be hard-linked", async () => {
    const lib = join(a, ".git", "modules", "lib");
    execFileSync("git", ["init", "-q", "--bare", lib], { env });
    execFileSync("mkdir", ["-p", join(lib, "objects", "ab")]);
    writeFileSync(join(root, "blob"), "x\n");
    ln(join(root, "blob"), join(lib, "objects", "ab", "c".repeat(38)));
    const result = await checkoutGit(run, "build", { repo: a })("git", ["status", "--porcelain"], { cwd: aLinked, timeoutMs: 60_000 });
    expect(result.code, result.stderr).toBe(0);
  });

  test("objects hard-linked by `clone --local` are legitimate: the plane commits there, and the shared object files are never written", async () => {
    const clone = join(root, "clone");
    execFileSync("git", ["clone", "-q", "--local", a, clone], { env });
    const shared = execFileSync("find", [join(clone, ".git", "objects"), "-type", "f", "-links", "+1"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    expect(shared.length).toBeGreaterThan(0);
    const before = shared.map(path => readFileSync(path).toString("base64"));
    writeFileSync(join(clone, "c.txt"), "clone\n");
    for (const args of [["add", "-A"], ["commit", "--no-verify", "-m", "in a local clone"]]) {
      const result = await checkoutGit(run, "build", { repo: clone })("git", args, { cwd: clone, timeoutMs: 60_000 });
      expect(result.code, result.stderr).toBe(0);
    }
    expect(shared.map(path => readFileSync(path).toString("base64"))).toEqual(before);
  });
});

describe("what git writes in the plane's GIT_DIR persists (Codex review of a0fa135d)", () => {
  const admin = () => join(a, ".git", "worktrees", "a-task");
  const build = (args: string[], cwd = aLinked) => checkoutGit(run, "build", { repo: a })("git", args, { cwd, timeoutMs: 60_000 });
  test("the product's own commands: commit's message and HEAD's log, reset --keep's ORIG_HEAD, in a linked worktree and the main checkout", async () => {
    expect((await build(["add", "-A"])).code).toBe(0);
    expect((await build(["commit", "--no-verify", "-m", "kept"])).code).toBe(0);
    expect(readFileSync(join(admin(), "COMMIT_EDITMSG"), "utf8")).toContain("kept");
    expect(readFileSync(join(admin(), "logs", "HEAD"), "utf8")).toContain("kept");
    const moved = await build(["reset", "--keep", "main"]);
    expect(moved.code, moved.stderr).toBe(0);
    expect(readFileSync(join(admin(), "ORIG_HEAD"), "utf8").trim()).toBe(git(a, "rev-parse", "task@{1}").trim());
    // The main checkout's own (its folder is the common one).
    writeFileSync(join(a, "m.txt"), "main\n");
    expect((await build(["add", "-A"], a)).code).toBe(0);
    expect((await build(["commit", "--no-verify", "-m", "on main"], a)).code).toBe(0);
    expect(readFileSync(join(a, ".git", "COMMIT_EDITMSG"), "utf8")).toContain("on main");
    expect(readFileSync(join(a, ".git", "logs", "HEAD"), "utf8")).toContain("on main");
  });

  test("a cherry-pick's stop is kept; state the plane can't keep (a sequencer) is said, not silently lost", async () => {
    writeFileSync(join(a, "a.txt"), "main's\n"); git(a, "commit", "-qam", "main a");
    writeFileSync(join(a, "z.txt"), "z\n"); git(a, "add", "z.txt"); git(a, "commit", "-qm", "main z");
    writeFileSync(join(aLinked, "a.txt"), "task's\n"); git(aLinked, "commit", "-qam", "task a");
    // One commit stopping on a conflict: its state files are the worktree's, kept.
    const one = await build(["-c", "user.name=t", "-c", "user.email=t@t", "cherry-pick", "main~1"]);
    expect(one.code).not.toBe(0);
    expect(refusal(one)).toBeNull();
    expect(existsSync(join(admin(), "CHERRY_PICK_HEAD"))).toBe(true);
    git(aLinked, "cherry-pick", "--abort");
    // A range stops with a sequencer folder (no product road runs one): refused as state Toolroll can't keep.
    const range = await build(["-c", "user.name=t", "-c", "user.email=t@t", "cherry-pick", "main~1", "main"]);
    expect(refusal(range), range.stderr).toContain("can't keep");
  });

});

describe("one plane git command at a time on a checkout (Codex review of a0fa135d)", () => {
  test("two concurrent writes on the same checkout run one after the other; another checkout isn't held up", async () => {
    const spans: { at: string; start: number; end: number }[] = [];
    const slow: Runner = async (file, args, options) => {
      if (args.includes("config")) return run(file, args, options);
      const start = performance.now();
      await new Promise(done => setTimeout(done, 300));
      const result = await run(file, args, options);
      spans.push({ at: String(options?.cwd), start, end: performance.now() });
      return result;
    };
    const write = (cwd: string, args: string[]) => checkoutGit(slow, "build", { repo: a })("git", args, { cwd, timeoutMs: 60_000 });
    const [one, two, other] = await Promise.all([
      write(aLinked, ["checkout", "-q", "--detach", "main"]), write(aLinked, ["checkout", "-q", "task"]), write(a, ["status", "--porcelain"]),
    ]);
    for (const result of [one, two, other]) expect(result.code, result.stderr).toBe(0);
    const same = spans.filter(span => span.at === aLinked).sort((x, y) => x.start - y.start);
    expect(same).toHaveLength(2);
    expect(same[1]!.start).toBeGreaterThanOrEqual(same[0]!.end);
    const elsewhere = spans.find(span => span.at === a)!;
    expect(elsewhere.start).toBeLessThan(same[0]!.end);
    // The later command's HEAD is the one left.
    expect(readFileSync(join(a, ".git", "worktrees", "a-task", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/task");
  });

  test("teardown holds the lock too, and a nested view of the same checkout doesn't wait on itself", async () => {
    const status = await teardownGit()(aLinked, ["status", "--porcelain"]);
    expect(status.code, status.stderr).toBe(0);
  });
});

describe("carry-back is anchored (security scan of the carry-back)", () => {
  test("the worktree's folder replaced by a look-alike after git ran: nothing is written into it, an incident is recorded", async () => {
    const heard: GitIncident[] = [];
    const stop = onGitIncident(incident => heard.push(incident));
    const admin = join(a, ".git", "worktrees", "a-task");
    try {
      const before = readFileSync(join(admin, "HEAD"), "utf8");
      const inner: Runner = async (file, args, options) => {
        const result = await run(file, args, options);
        if (args.includes("checkout")) {
          // A real folder, not a link: same files, another inode.
          renameSync(admin, join(root, "moved-admin"));
          execFileSync("cp", ["-R", join(root, "moved-admin"), admin]);
        }
        return result;
      };
      const result = await checkoutGit(inner, "build", { repo: a })("git", ["checkout", "-q", "--detach", "main"], { cwd: aLinked, timeoutMs: 60_000 });
      expect(refusal(result), result.stderr).toContain("changed while git ran");
      expect(readFileSync(join(admin, "HEAD"), "utf8")).toBe(before);
      expect(readFileSync(join(root, "moved-admin", "HEAD"), "utf8")).toBe(before);
      expect(heard).toHaveLength(1);
      expect(heard[0]!.swapped[0]!.path).toBe(realpathSync(admin));
    } finally { stop(); }
  });
});
