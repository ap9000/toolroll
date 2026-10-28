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
import { checkoutGitSync } from "../../src/teardown-git.js";

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
  };
  for (const [name, plant] of Object.entries(plants)) {
    test(`${name}: refused before git reads, and nothing runs`, () => {
      plant();
      expect(() => checkoutGitSync(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toThrow();
      expect(() => checkoutGitSync(repo, ["diff", "--name-only", "HEAD"])).toThrow();
      expect(existsSync(marker)).toBe(false);
    });
  }
  test("a plain checkout reads", () => {
    expect(checkoutGitSync(repo, ["status", "--porcelain=v1"])).toContain("a.txt");
    expect(checkoutGitSync(repo, ["rev-parse", "--verify", "HEAD^{commit}"]).trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
