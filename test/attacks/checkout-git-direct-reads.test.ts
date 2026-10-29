/**
 * Attack (eval-harness review 1, finding 7): the plane's direct git reads of a project repository (project knowledge
 * and learning, the task base, release coverage, prepared evidence, the grant's check-ignore, the revision base's
 * merge-base) read the repository's config with its includes, and a build that adds an include naming a FIFO it holds
 * open hangs the plane in synchronous git. Every one now runs through a frozen read view on every git version: the
 * include is refused before git runs, every call is bounded, and the answer errs toward "no answer".
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../../src/exec.js";
import { checkoutGitSync, lazyFetchSafeGit } from "../../src/teardown-git.js";
import { readGit } from "../../src/task-base.js";
import { gitIsAncestor } from "../../src/release-coverage.js";
import { readPreparedEvidence } from "../../src/prepared-evidence.js";

let repo: string, head: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { env, stdio: "pipe", encoding: "utf8" }).trim();

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "so-direct-reads-")));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A"); git("commit", "-qm", "one");
  head = git("rev-parse", "HEAD");
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("an include naming a FIFO", () => {
  beforeEach(() => {
    const fifo = join(repo, "hang.fifo");
    execFileSync("mkfifo", [fifo]);
    git("config", "include.path", fifo);
  });

  test("attack: every direct read ends without reading it, and gives no answer", async () => {
    const started = Date.now();
    expect(() => checkoutGitSync(repo, ["rev-parse", "HEAD"], { timeoutMs: 5_000 })).toThrow(/includes another file/);
    expect(readGit(repo, ["rev-parse", "HEAD"])).toBeNull();
    expect(gitIsAncestor(repo, head, head.replace(/.$/, head.endsWith("0") ? "1" : "0"))).toBeNull();
    expect(() => readPreparedEvidence(repo, head, true)).toThrow();
    const ran = await lazyFetchSafeGit(run)("git", ["merge-base", "--is-ancestor", head, head], { cwd: repo });
    expect(ran.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});

test("a plain repository still reads through the views", async () => {
  expect(readGit(repo, ["rev-parse", "HEAD"])).toBe(head);
  expect(checkoutGitSync(repo, ["rev-parse", "HEAD"]).trim()).toBe(head);
  expect((await lazyFetchSafeGit(run)("git", ["merge-base", "--is-ancestor", head, head], { cwd: repo })).code).toBe(0);
});
