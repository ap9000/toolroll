/**
 * Attack: a page read runs a program planted in an agent's checkout (quiet GETs, docs/plans/get-side-effects.md). The
 * code page's GET reads a coding session's checkout with git (its changes, and the review-task preview). Git runs a
 * program named by the checkout's own config: core.fsmonitor on `status`, a clean filter on a changed file, an include
 * that pulls in either. checkoutGitSync refuses such a checkout before git reads it; a plain checkout still reads.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkoutGitSync, PAGE_READ_FLAGS, TEARDOWN_FLAGS } from "../../src/teardown-git.js";

let root: string, repo: string, marker: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-gitsync-")));
  repo = join(root, "checkout"); marker = join(root, "ran");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("-c", "user.email=a@b", "-c", "user.name=a", "add", "a.txt");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "one");
  writeFileSync(join(repo, "a.txt"), "two\n");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("attack: a checkout's git config runs a program when a page reads it", () => {
  const plants: Record<string, () => void> = {
    "core.fsmonitor": () => git("config", "core.fsmonitor", `touch ${marker}`),
    "a clean filter": () => { git("config", "filter.x.clean", `sh -c 'touch ${marker}; cat'`); writeFileSync(join(repo, ".gitattributes"), "*.txt filter=x\n"); },
    "an include of a file naming one": () => { writeFileSync(join(root, "extra"), `[core]\n\tfsmonitor = touch ${marker}\n`); git("config", "include.path", join(root, "extra")); },
    "core.pager": () => git("config", "core.pager", `touch ${marker}`),
    "an external diff": () => git("config", "diff.external", `touch ${marker}`),
    "an attributes file naming a filter": () => { git("config", "filter.y.clean", `sh -c 'touch ${marker}; cat'`); writeFileSync(join(root, "attrs"), "*.txt filter=y\n"); git("config", "core.attributesFile", join(root, "attrs")); },
  };
  for (const [name, plant] of Object.entries(plants)) {
    test(`${name}: refused before git reads, and nothing runs`, () => {
      plant();
      expect(() => checkoutGitSync(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toThrow();
      expect(() => checkoutGitSync(repo, ["diff", "--name-only", "HEAD"])).toThrow();
      expect(existsSync(marker)).toBe(false);
    });
  }
  // A config changed after it was inspected (an agent racing the read): the flags every page read carries still hold,
  // whatever the config says by the time git reads it.
  test("planted after the inspection: the page-read flags alone keep fsmonitor, filters and the pager from running", () => {
    for (const plant of Object.values(plants)) plant();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    for (const args of [["status", "--porcelain=v1"], ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "HEAD"], ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]]) {
      execFileSync("git", [...TEARDOWN_FLAGS, ...PAGE_READ_FLAGS, ...args], { cwd: repo, env, stdio: "pipe" });
    }
    expect(existsSync(marker)).toBe(false);
  });
  test("a plain checkout reads", () => {
    expect(checkoutGitSync(repo, ["status", "--porcelain=v1"])).toContain("a.txt");
    expect(checkoutGitSync(repo, ["rev-parse", "--verify", "HEAD^{commit}"]).trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
