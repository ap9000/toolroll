/**
 * Attack (eval-harness review 1, finding 5): the verified object reader and the approved-commit extraction (commit-
 * extract.ts) fetch a missing object from a partial clone's remote. They take `--no-lazy-fetch` where git has it; on an
 * older git (2.41.0 ignores GIT_NO_LAZY_FETCH) every command runs through a frozen view of the repository, which refuses
 * a partial clone from the config git then runs with, and every run refuses every transport. This runs on the installed
 * git as it is (the CI floor lane is git 2.41.0 exactly) and with the old-git path forced, so each lane proves both.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { extractCommit, readVerifiedCommit, verifiedBlobs } from "../../src/commit-extract.js";
import { lazyFetchSupported, setLazyFetchSupportedForTest } from "../../src/teardown-git.js";

let root: string, source: string, partial: string, missing: string, head: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (at: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", at, ...args], { env, stdio: "pipe", encoding: "utf8" });
/** Whether the partial clone holds the blob, asked with every transport refused (so the asking fetches nothing). */
const holds = (id: string) => { try { execFileSync("git", ["-C", partial, "-c", "protocol.allow=never", "cat-file", "-e", id], { env: { ...env, GIT_NO_LAZY_FETCH: "1" }, stdio: "pipe" }); return true; } catch { return false; } };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-verified-reader-")));
  source = join(root, "source"); partial = join(root, "partial");
  execFileSync("git", ["init", "-q", "-b", "main", source], { env });
  writeFileSync(join(source, "a.txt"), "one\n");
  writeFileSync(join(source, "big.txt"), "a blob the partial clone leaves behind\n");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "one");
  git(source, "config", "uploadpack.allowFilter", "true");
  // A real partial clone, checked out (a checkout's .git, as Toolroll records projects): blobs stay at the source.
  execFileSync("git", ["-c", "protocol.file.allow=always", "clone", "-q", "--no-local", "--no-checkout", "--filter=blob:none", `file://${source}`, partial], { env, stdio: "pipe" });
  missing = git(source, "rev-parse", "HEAD:big.txt").trim();
  head = git(source, "rev-parse", "HEAD").trim();
});
afterEach(() => { setLazyFetchSupportedForTest(null); rmSync(root, { recursive: true, force: true }); });

for (const road of ["the installed git", "a git without --no-lazy-fetch (forced)"] as const) {
  describe(road, () => {
    beforeEach(() => { if (road !== "the installed git") setLazyFetchSupportedForTest(false); });

    test("attack: reading a blob the partial clone lacks never fetches it", () => {
      expect(holds(missing)).toBe(false);
      const read = verifiedBlobs(join(partial, ".git"), git(source, "rev-parse", "HEAD^{tree}").trim(), ["big.txt"]);
      expect(read.ok).toBe(false);
      expect(holds(missing)).toBe(false);
    });

    test("attack: extracting a commit whose blob the partial clone lacks never fetches it", () => {
      const dest = realpathSync(mkdtempSync(join(root, "out-")));
      expect(extractCommit(join(partial, ".git"), head, dest)).toMatchObject({ ok: false });
      expect(holds(missing)).toBe(false);
    });

    test("a plain repository still reads", () => {
      expect(readVerifiedCommit(join(source, ".git"), head)).toMatchObject({ ok: true });
      const dest = realpathSync(mkdtempSync(join(root, "out-")));
      expect(extractCommit(join(source, ".git"), head, dest)).toEqual({ ok: true, files: 2 });
    });
  });
}

describe("on a git without --no-lazy-fetch", () => {
  beforeEach(() => { setLazyFetchSupportedForTest(false); });
  test("the partial clone is refused from the view's own config, before any object is read", () => {
    expect(readVerifiedCommit(join(partial, ".git"), head)).toMatchObject({ ok: false, message: expect.stringContaining("partial clone") });
  });
  test("attack: an include the config check never followed is refused, not run with", () => {
    writeFileSync(join(root, "extra.config"), "[extensions]\n\tpartialClone = origin\n");
    git(source, "config", "include.path", join(root, "extra.config"));
    expect(readVerifiedCommit(join(source, ".git"), head)).toMatchObject({ ok: false, message: expect.stringContaining("includes") });
  });
  test("the probe is what the installed git says, never assumed", () => {
    setLazyFetchSupportedForTest(null);
    const [, major, minor] = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }))!.map(Number);
    expect(lazyFetchSupported()).toBe(major! > 2 || (major === 2 && minor! >= 45));
  });
});
