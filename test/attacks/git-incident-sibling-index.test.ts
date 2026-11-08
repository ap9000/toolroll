/**
 * Another checkout's index and the git-incident check (teardown-git.ts pinned). Claude Code's security-guidance plugin
 * hard-links the index of the checkout a session runs in to a temporary copy, for seconds at a time, to diff against
 * it. The walk after git ran counted any second hard link as a swap, so a release gate on a repository's main checkout
 * stopped as "the checkout's repository changed while git ran", naming a sibling checkout's index, whenever a session
 * was active in that sibling (Nov 2026: four gates in a row, and sibling-index incidents since October). Git never
 * writes another checkout's index, nor any index in place, so a second name there is no longer counted. It must still
 * be no link, and everything else keeps the rule: this checkout's own index, the other files of a sibling's folder, and
 * a file named `index` anywhere else.
 */
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { run } from "../../src/exec.js";
import { onGitIncident, type GitIncident } from "../../src/git-incident.js";
import { refusal, teardownGit } from "../../src/teardown-git.js";
import type { Runner } from "../../src/worktree.js";

let root: string, main: string, task: string, other: string, heard: GitIncident[], stop: () => void;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (at: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", at, ...args], { env, stdio: "pipe", encoding: "utf8" });
const admin = (id: string) => join(main, ".git", "worktrees", id);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-sibidx-")));
  // Its own HOME: the views folder and the incident record are this test's, never the person's.
  vi.stubEnv("HOME", join(root, "home"));
  mkdirSync(join(root, "home"));
  main = join(root, "main");
  execFileSync("git", ["init", "-q", "-b", "main", main], { env });
  writeFileSync(join(main, "a.txt"), "one\n");
  git(main, "add", "a.txt");
  git(main, "commit", "-qm", "one");
  task = join(root, "task"); other = join(root, "other");
  git(main, "worktree", "add", "-q", "-b", "task", task);
  git(main, "worktree", "add", "-q", "-b", "other", other);
  // The sibling as it was when the gates stopped: a release branch made, committed and pushed there, then left.
  git(other, "checkout", "-q", "-B", "release", "HEAD");
  git(other, "commit", "-q", "--allow-empty", "-m", "release");
  git(other, "checkout", "-q", "other");
  heard = [];
  stop = onGitIncident(incident => heard.push(incident));
});
afterEach(() => { stop(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

/** Teardown git whose run does `meanwhile` right after git runs the command `when` names (before the walk after it). */
const during = (when: string, meanwhile: () => void): ReturnType<typeof teardownGit> => {
  const inner: Runner = async (file, args, options) => {
    const result = await run(file, args, options);
    if (args.includes(when)) meanwhile();
    return result;
  };
  return teardownGit(inner);
};
/** What the plugin does: a second name for an index, in a folder of its own. */
const copyOf = (index: string) => { const copy = join(root, `copy-${Math.random().toString(16).slice(2)}`); linkSync(index, copy); return copy; };
const GATE = ["symbolic-ref", "--quiet", "--short", "HEAD"];

describe("another checkout's index with a second hard link is not an incident", () => {
  test.each([
    ["the main checkout's gate, a linked sibling's index", () => main, () => join(admin("other"), "index")],
    ["a linked checkout, another linked sibling's index", () => task, () => join(admin("other"), "index")],
    ["a linked checkout, the main checkout's index", () => task, () => join(main, ".git", "index")],
  ])("%s, linked while git runs: the result stands and nothing is told", async (_name, checkout, index) => {
    const result = await during("symbolic-ref", () => { copyOf(index()); })(checkout(), GATE);
    expect(refusal(result), result.stderr).toBeNull();
    expect(result.code).toBe(0);
    expect(heard).toEqual([]);
  });

  test("linked before the command and still linked after it: it runs, and nothing is told", async () => {
    copyOf(join(admin("other"), "index"));
    const result = await teardownGit()(main, GATE);
    expect(refusal(result), result.stderr).toBeNull();
    expect(heard).toEqual([]);
  });

  test("a write through the view (a fast-forward of main) with a sibling's index linked: done, the sibling's index untouched", async () => {
    git(task, "commit", "-q", "--allow-empty", "-m", "ahead");
    const index = join(admin("other"), "index");
    const copy = copyOf(index);
    const result = await teardownGit()(main, ["merge", "--ff-only", "--quiet", "task"]);
    expect(refusal(result), result.stderr).toBeNull();
    expect(git(main, "rev-parse", "main")).toBe(git(main, "rev-parse", "task"));
    expect(statSync(copy).ino).toBe(statSync(index).ino);
    expect(heard).toEqual([]);
  });
});

describe("attack: everything but another checkout's index keeps the rule", () => {
  test.each([
    // A link, not a second name: refused wherever the index is.
    ["a sibling's index swapped for a link", () => { const index = join(admin("other"), "index"); renameSync(index, join(root, "moved")); symlinkSync(join(root, "moved"), index); }],
    ["a sibling's logs folder swapped for a link", () => { const logs = join(admin("other"), "logs"); renameSync(logs, join(root, "moved-logs")); symlinkSync(join(root, "moved-logs"), logs); }],
    // Files git writes in place, in the sibling's folder: a second name still counts.
    ["a sibling's HEAD log hard-linked elsewhere", () => { copyOf(join(admin("other"), "logs", "HEAD")); }],
    ["a sibling's ORIG_HEAD hard-linked elsewhere", () => { copyOf(join(admin("other"), "ORIG_HEAD")); }],
    // The exemption is by place: a file named index anywhere else is walked like the rest.
    ["a hard-linked file named index under refs/heads", () => { writeFileSync(join(root, "x"), "x\n"); linkSync(join(root, "x"), join(main, ".git", "refs", "heads", "index")); }],
    ["a hard-linked file named index deeper in a sibling's folder", () => { writeFileSync(join(root, "x"), "x\n"); linkSync(join(root, "x"), join(admin("other"), "logs", "index")); }],
    // The common folder: a folder swapped for a link.
    ["the common refs/heads swapped for a link", () => { const heads = join(main, ".git", "refs", "heads"); renameSync(heads, join(root, "moved-heads")); symlinkSync(join(root, "moved-heads"), heads); }],
  ])("%s while git runs: an incident, and the command refused", async (_name, plant) => {
    const result = await during("symbolic-ref", plant)(main, GATE);
    expect(refusal(result), result.stderr).toContain("changed while git ran");
    expect(heard.length).toBe(1);
  });

  test.each([
    ["the main checkout's own index, from the main checkout", () => main, () => join(main, ".git", "index")],
    ["a linked checkout's own index", () => task, () => join(admin("task"), "index")],
  ])("%s hard-linked: refused before git runs, as before", async (_name, checkout, index) => {
    copyOf(index());
    const result = await teardownGit()(checkout(), GATE);
    expect(refusal(result), result.stderr).toContain("link");
    expect(heard).toEqual([]);
  });
});
