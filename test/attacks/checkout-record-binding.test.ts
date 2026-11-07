/**
 * Attack (code map plan, slice H): readers of a project's repository trusted the checkout's own pointers. A `.git` file or
 * a `commondir` planted in the project sent knowledge, learning, a page's identity read and release ancestry to another
 * repository; a crew's context read a working tree the agent had already dirtied; two raw git calls read a config whose
 * include names a FIFO. Each is now bound to the project's record, reads committed blobs, or goes through a frozen view.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { probeDesktopProject } from "../../src/desktop-access.js";
import { learningIdentity } from "../../src/project-learning.js";
import { asReadOnlyRequest } from "../../src/read-only-request.js";
import { gitIsAncestor } from "../../src/release-coverage.js";
import { repositoryContextRead } from "../../src/repository-context.js";
import { checkoutTop } from "../../src/teardown-git.js";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { env, stdio: "pipe", encoding: "utf8" }).trim();
let root: string, project: string, other: string, head: string, otherHead: string;
const seed = (dir: string, text: string) => {
  mkdirSync(dir); git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "notes.md"), text);
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "seed");
  return git(dir, "rev-parse", "HEAD");
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-binding-")));
  project = join(root, "project"); other = join(root, "other");
  head = seed(project, "the project's own words\n"); otherHead = seed(other, "another repository's words\n");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A project's `.git` turned into a pointer at another repository's worktree: what a build that can reach it plants. */
function pointAtOther(): void {
  git(other, "worktree", "add", "-q", "-b", "side", join(root, "side"));
  rmSync(join(project, ".git"), { recursive: true, force: true });
  writeFileSync(join(project, ".git"), `gitdir: ${join(other, ".git", "worktrees", "side")}\n`);
}
const plantCommondir = () => writeFileSync(join(project, ".git", "commondir"), `${join(other, ".git")}\n`);

describe("a redirected .git is refused", () => {
  const cases: [string, () => void][] = [["a .git pointer", pointAtOther], ["a commondir", plantCommondir]];
  test.each(cases)("attack: %s, on a page visit's identity read", (_name, plant) => {
    plant();
    expect(() => asReadOnlyRequest(() => learningIdentity(project))).toThrow();
  });
  test.each(cases)("attack: %s, on learning's own read", (_name, plant) => {
    plant();
    expect(() => learningIdentity(project)).toThrow();
  });
  test.each(cases)("attack: %s, on release ancestry", (_name, plant) => {
    plant();
    expect(gitIsAncestor(project, otherHead, otherHead.replace(/.$/, c => (c === "0" ? "1" : "0")))).toBeNull();
  });
  test.each(cases)("attack: %s, on repository context", (_name, plant) => {
    plant();
    const read = repositoryContextRead({ repo: project, project, query: "words", audience: "lead" });
    expect(read.checkout).toBeNull();
    expect(JSON.stringify(read)).not.toContain("another repository");
  });
  test("a crew worktree of another repository can't claim to be the project's", () => {
    git(other, "worktree", "add", "-q", "-b", "stray", join(root, "stray"));
    const stray = join(root, "stray");
    const read = repositoryContextRead({ repo: stray, project, baseRevision: otherHead, query: "words", audience: "crew" });
    expect(read.checkout).toBeNull();
  });
  test("the project's own checkout and a worktree of it still read", () => {
    expect(asReadOnlyRequest(() => learningIdentity(project))).toBe(learningIdentity(project));
    git(project, "worktree", "add", "-q", "-b", "task", join(root, "task"));
    const read = repositoryContextRead({ repo: join(root, "task"), project, baseRevision: head, query: "words", audience: "crew" });
    expect(read.checkout?.head).toBe(head);
  });
});

describe("crew context reads the task base", () => {
  test("attack: a dirty tracked file never appears; an agent's symlink and replace ref change nothing", () => {
    writeFileSync(join(project, "notes.md"), "DIRTY agent text about words\n");
    const dirty = repositoryContextRead({ repo: project, project, baseRevision: head, query: "words", audience: "crew" });
    expect(dirty.checkout?.source).toBe("base-commit");
    expect(JSON.stringify(dirty.excerpts)).not.toContain("DIRTY");
    expect(dirty.excerpts.some(e => e.text.includes("the project's own words"))).toBe(true);

    rmSync(join(project, "notes.md"));
    writeFileSync(join(root, "secret.md"), "outside words\n");
    symlinkSync(join(root, "secret.md"), join(project, "notes.md"));
    const blob = git(project, "rev-parse", `${head}:notes.md`);
    const planted = execFileSync("git", ["-C", project, "hash-object", "-w", "--stdin"], { env, input: "REPLACED words\n", encoding: "utf8" }).trim();
    git(project, "update-ref", `refs/replace/${blob}`, planted);
    const swapped = JSON.stringify(repositoryContextRead({ repo: project, project, baseRevision: head, query: "words", audience: "crew" }).excerpts);
    expect(swapped).toContain("the project's own words");
    expect(swapped).not.toContain("outside");
    expect(swapped).not.toContain("REPLACED");
  });
  test("a tracked symlink at the base is omitted, not followed", () => {
    symlinkSync("notes.md", join(project, "link.md"));
    git(project, "add", "-A"); git(project, "commit", "-qm", "link");
    const base = git(project, "rev-parse", "HEAD");
    const read = repositoryContextRead({ repo: project, project, baseRevision: base, query: "words", audience: "crew" });
    expect(read.excerpts.map(e => e.file)).not.toContain("link.md");
    expect(read.omissions.files).toBe(1);
  });
  test("the lead still reads its project's working tree", () => {
    writeFileSync(join(project, "notes.md"), "fresh words\n");
    const read = repositoryContextRead({ repo: project, project, query: "words", audience: "lead" });
    expect(read.checkout?.source).toBe("working-tree");
    expect(JSON.stringify(read.excerpts)).toContain("fresh words");
  });
});

describe.skipIf(process.platform === "win32")("an include naming a FIFO", () => {
  beforeEach(() => {
    execFileSync("mkfifo", [join(project, "hang.fifo")]);
    git(project, "config", "include.path", join(project, "hang.fifo"));
  });
  test("attack: the desktop probe ends with no access claimed", () => {
    const started = Date.now();
    expect(probeDesktopProject(project).state).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
  test("attack: easy-start's folder discovery ends with no checkout", () => {
    const started = Date.now();
    mkdirSync(join(project, "deep"));
    expect(checkoutTop(join(project, "deep"))).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

test("discovery finds a checkout from a folder inside it, and nothing outside one", () => {
  mkdirSync(join(project, "a", "b"), { recursive: true });
  expect(checkoutTop(join(project, "a", "b"))).toBe(project);
  expect(checkoutTop(root)).toBeNull();
  expect(checkoutTop(join(root, "missing"))).toBeNull();
});
