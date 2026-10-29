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

// ---------------------------------------------------------------------------------------------- Codex review round 2

import { chmodSync, unlinkSync } from "node:fs";
import { trustedWorktreeBinding } from "../../src/agent-fence.js";
import { branchHead } from "../../src/coding-handoff.js";
import { setLazyFetchSupportedForTest, viewedGitSync } from "../../src/teardown-git.js";

describe.skipIf(process.platform === "win32")("review 2 #6: dispatch's binding and the coding handoff's branch read never hang", () => {
  test("attack: an include naming a FIFO in the shared config holds neither up", () => {
    const active = join(repo, "..", `${repo.split("/").at(-1)}-active`);
    git("worktree", "add", "-q", "-b", "active", active);
    try {
      execFileSync("mkfifo", [join(repo, "hang.fifo")]);
      git("config", "include.path", join(repo, "hang.fifo"));
      const started = Date.now();
      // The binding reads the registry as files: no git, so nothing the config names is opened.
      expect(trustedWorktreeBinding(repo, active)).toMatchObject({ main: repo });
      // The branch read goes through the frozen, bounded view, which refuses the include: no answer, never a hang.
      expect(() => branchHead(repo, "active")).toThrow(/could not be inspected/);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally { rmSync(active, { recursive: true, force: true }); }
  }, 30_000);

  test("attack: the candidate's .git pointer swapped for a FIFO fails the binding at once", () => {
    const active = join(repo, "..", `${repo.split("/").at(-1)}-active2`);
    git("worktree", "add", "-q", "-b", "active2", active);
    try {
      unlinkSync(join(active, ".git"));
      execFileSync("mkfifo", [join(active, ".git")]);
      const started = Date.now();
      expect(() => trustedWorktreeBinding(repo, active)).toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally { rmSync(active, { recursive: true, force: true }); }
  }, 30_000);

  test("a plain repository: the branch read answers", () => {
    expect(branchHead(repo, "main")).toBe(head);
    expect(branchHead(repo, "no-such-branch")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("review 2 follow-up: --no-lazy-fetch is asked of the git a view runs", () => {
  test("a fixed git without the flag is never handed it because PATH's git has it", () => {
    setLazyFetchSupportedForTest(null);
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "so-old-git-")));
    try {
      const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      // As git 2.41.0 answers: no such option.
      writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--no-lazy-fetch" ] && { echo "unknown option: --no-lazy-fetch" >&2; exit 129; }; done\nexec ${real} "$@"\n`);
      chmodSync(join(bin, "git"), 0o755);
      expect(viewedGitSync(repo, ["rev-parse", "HEAD"], { git: join(bin, "git") }).status).toBe(0);
      expect(viewedGitSync(repo, ["rev-parse", "HEAD"], {}).status).toBe(0);
    } finally { rmSync(bin, { recursive: true, force: true }); setLazyFetchSupportedForTest(null); }
  });
});
