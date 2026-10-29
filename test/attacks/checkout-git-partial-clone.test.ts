/**
 * Attack: a protected read of a partial clone fetches what it lacks from the clone's remote. Git 2.45 and newer take
 * `--no-lazy-fetch`; on an older git (the floor is 2.41) Toolroll leaves the flag out and instead refuses any
 * repository whose config makes lazy fetching possible (extensions.partialClone, remote.<name>.promisor,
 * remote.<name>.partialCloneFilter), judged from the view's frozen config, with `protocol.allow=never` still on every
 * read. This runs against the installed git as it is (the CI git lanes run it on the floor and on 2.47), and with the
 * old-git path forced, so every lane proves both paths.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../../src/exec.js";
import {
  checkoutGit, checkoutGitSync, lazyFetchSafeGit, lazyFetchSetting, lazyFetchSupported, noLazyFetch, PARTIAL_CLONE_REFUSAL, readFlags,
  refusal, setLazyFetchSupportedForTest, viewedGitSync,
} from "../../src/teardown-git.js";
import { gitIsAncestor } from "../../src/release-coverage.js";
import { readGit } from "../../src/task-base.js";
import type { Runner } from "../../src/worktree.js";

let root: string, source: string, plain: string, partial: string, missing: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (at: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", at, ...args], { env, stdio: "pipe", encoding: "utf8" });
const installed = (): [number, number] => {
  const [, major, minor] = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }))!;
  return [Number(major), Number(minor)];
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-partial-")));
  source = join(root, "source"); plain = join(root, "plain"); partial = join(root, "partial");
  for (const repo of [source, plain]) {
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
    writeFileSync(join(repo, "a.txt"), "one\n");
    writeFileSync(join(repo, "big.txt"), "a blob the partial clone leaves behind\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "one");
  }
  git(source, "config", "uploadpack.allowFilter", "true");
  // A real partial clone: blobs stay at the source until something asks for them.
  execFileSync("git", ["-c", "protocol.file.allow=always", "clone", "-q", "--no-local", "--no-checkout", "--filter=blob:none", `file://${source}`, partial], { env, stdio: "pipe" });
  missing = git(source, "rev-parse", "HEAD:big.txt").trim();
});
afterEach(() => { setLazyFetchSupportedForTest(null); rmSync(root, { recursive: true, force: true }); });

describe("the installed git", () => {
  test("the probe matches git's version: --no-lazy-fetch from 2.45", () => {
    const [major, minor] = installed();
    expect(lazyFetchSupported()).toBe(major > 2 || (major === 2 && minor >= 45));
  });
  test("every read keeps protocol.allow=never, and carries --no-lazy-fetch exactly when git has it", () => {
    expect(readFlags().join(" ")).toContain("protocol.allow=never");
    expect(readFlags().includes("--no-lazy-fetch")).toBe(lazyFetchSupported());
    expect(noLazyFetch()).toEqual(lazyFetchSupported() ? ["--no-lazy-fetch"] : []);
  });
  test("attack: a protected read of a blob the partial clone lacks never fetches it", async () => {
    // New git reads with --no-lazy-fetch and fails on the missing blob; old git refuses the partial clone outright.
    expect(() => checkoutGitSync(partial, ["cat-file", "-p", missing])).toThrow(lazyFetchSupported() ? /cat-file/ : PARTIAL_CLONE_REFUSAL);
    const viaRunner = await checkoutGit(run, "read")("git", ["cat-file", "-p", missing], { cwd: partial, timeoutMs: 30_000 });
    expect(viaRunner.code).not.toBe(0);
    if (!lazyFetchSupported()) expect(refusal(viaRunner)).toBe(PARTIAL_CLONE_REFUSAL);
    // Still missing: nothing was fetched.
    expect(() => execFileSync("git", ["-C", partial, "-c", "protocol.allow=never", "cat-file", "-e", missing], { env: { ...env, GIT_NO_LAZY_FETCH: "1" }, stdio: "pipe" })).toThrow();
  });
  test("a plain repository reads", () => {
    expect(checkoutGitSync(plain, ["rev-parse", "--verify", "HEAD^{commit}"]).trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("a git without --no-lazy-fetch (forced, on every lane)", () => {
  beforeEach(() => { setLazyFetchSupportedForTest(false); });

  test("reads leave the flag out and keep protocol.allow=never", () => {
    expect(readFlags()).not.toContain("--no-lazy-fetch");
    expect(readFlags().join(" ")).toContain("protocol.allow=never");
    expect(noLazyFetch()).toEqual([]);
  });
  test("a normal repository reads fine, even when a caller asks for --no-lazy-fetch", async () => {
    expect(checkoutGitSync(plain, ["--no-lazy-fetch", "status", "--porcelain=v1"])).toBe("");
    const listed = await checkoutGit(run, "read")("git", ["--no-lazy-fetch", "ls-tree", "--name-only", "HEAD"], { cwd: plain, timeoutMs: 30_000 });
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("big.txt");
    // The direct reads go through the same frozen view, and answer as before.
    const head = git(plain, "rev-parse", "HEAD").trim();
    expect(readGit(plain, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitIsAncestor(plain, head, head)).toBe(true);
    expect(viewedGitSync(plain, ["merge-base", "--is-ancestor", head, "0".repeat(40)], {}).status).not.toBe(0);
    expect((await lazyFetchSafeGit(run)("git", ["rev-parse", "HEAD"], { cwd: plain, timeoutMs: 30_000 })).stdout.trim()).toBe(head);
  });
  test("attack: a partial clone is refused for protected reads, in plain words", async () => {
    expect(() => checkoutGitSync(partial, ["rev-parse", "HEAD"])).toThrow("this project is a partial clone; protected reads need git 2.45 or newer");
    for (const mode of ["read", "build"] as const) {
      const result = await checkoutGit(run, mode)("git", ["rev-parse", "HEAD"], { cwd: partial, timeoutMs: 30_000 });
      expect(refusal(result)).toBe(PARTIAL_CLONE_REFUSAL);
    }
    expect(refusal(await lazyFetchSafeGit(run)("git", ["rev-parse", "HEAD"], { cwd: partial, timeoutMs: 30_000 }))).toBe(PARTIAL_CLONE_REFUSAL);
    expect(readGit(partial, ["rev-parse", "HEAD"])).toBeNull();
  });
  // Each setting that makes git fetch lazily (or reach a transport), planted in an ordinary repository: refused from the
  // frozen view's own listing, by the plain-words partial-clone refusal or the classifier that refuses includes, protocol
  // policy and foreign-VCS helpers on every git.
  const plants: Record<string, [(repo: string) => void, string | RegExp]> = {
    "extensions.partialClone": [repo => { git(repo, "config", "core.repositoryformatversion", "1"); git(repo, "config", "extensions.partialClone", "origin"); }, PARTIAL_CLONE_REFUSAL],
    "remote.<name>.promisor": [repo => git(repo, "config", "remote.origin.promisor", "true"), PARTIAL_CLONE_REFUSAL],
    "remote.<name>.promisor, as a bare key": [repo => appendFileSync(join(repo, ".git", "config"), `[remote "origin"]\n\turl = /nowhere\n\tpromisor\n`), PARTIAL_CLONE_REFUSAL],
    "remote.<name>.partialCloneFilter": [repo => git(repo, "config", "remote.origin.partialclonefilter", "blob:none"), PARTIAL_CLONE_REFUSAL],
    "a remote name with dots": [repo => git(repo, "config", "remote.a.b.c.promisor", "yes"), PARTIAL_CLONE_REFUSAL],
    "an included file setting extensions.partialClone": [repo => {
      writeFileSync(join(root, "partial.inc"), "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tpartialClone = origin\n[remote \"origin\"]\n\tpromisor = true\n");
      git(repo, "config", "include.path", join(root, "partial.inc"));
    }, /includes another file/],
    "an includeIf'd file setting remote.<name>.promisor": [repo => {
      writeFileSync(join(root, "promisor.inc"), "[remote \"origin\"]\n\tpromisor = true\n");
      git(repo, "config", `includeIf.gitdir:${repo}/.git.path`, join(root, "promisor.inc"));
    }, /includes another file/],
    "protocol.ext.allow=always": [repo => git(repo, "config", "protocol.ext.allow", "always"), /protocol\.ext\.allow, which can run a command/],
    "protocol.file.allow=always": [repo => git(repo, "config", "protocol.file.allow", "always"), /protocol\.file\.allow, which can run a command/],
    "remote.<name>.vcs": [repo => git(repo, "config", "remote.origin.vcs", "evil"), /remote\.origin\.vcs, which can run a command/],
  };
  for (const [name, [plant, words]] of Object.entries(plants)) {
    test(`attack: ${name} is refused, by the view and by every direct read`, async () => {
      plant(plain);
      expect(() => checkoutGitSync(plain, ["rev-parse", "HEAD"])).toThrow(words);
      expect(() => viewedGitSync(plain, ["merge-base", "--is-ancestor", "HEAD", "HEAD"], {})).toThrow(words);
      for (const runner of [checkoutGit(run, "read"), lazyFetchSafeGit(run)]) {
        const result = await runner("git", ["rev-parse", "HEAD"], { cwd: plain, timeoutMs: 30_000 });
        expect(result.code).toBe(128);
        expect(refusal(result)).toMatch(words);
      }
      expect(readGit(plain, ["rev-parse", "HEAD"])).toBeNull();
      expect(gitIsAncestor(plain, "1".repeat(40), "2".repeat(40))).toBeNull();
    });
  }
  test("attack: partial-clone settings swapped in between the inspection and the run are never read", async () => {
    // The partial clone with its promisor settings taken out, so the inspection passes; the agent puts them back the
    // moment the config has been listed. Git then runs on the view's frozen copy: no promisor, so nothing is fetched.
    const config = join(partial, ".git", "config");
    const original = readFileSync(config, "utf8");
    for (const key of ["remote.origin.promisor", "remote.origin.partialclonefilter", "extensions.partialClone"]) {
      try { git(partial, "config", "--unset-all", key); } catch { /* this git's clone didn't set it */ }
    }
    expect(lazyFetchSetting(git(partial, "config", "--list", "--show-scope", "-z"))).toBeNull();
    let swapped = false, ranWith: string | null = null;
    const racing: Runner = async (file, args, options) => {
      // The config the read itself runs with: the view's frozen copy.
      if (args.includes("cat-file")) ranWith = readFileSync(join(String(options?.env?.["GIT_COMMON_DIR"]), "config"), "utf8");
      const result = await run(file, args, options);
      if (args.includes("config") && args.includes("--list")) { writeFileSync(config, original); swapped = true; }
      return result;
    };
    const read = await checkoutGit(racing, "read")("git", ["cat-file", "-p", missing], { cwd: partial, timeoutMs: 30_000 });
    expect(swapped).toBe(true);
    expect(readFileSync(config, "utf8")).toMatch(/promisor/);
    expect(ranWith).not.toBeNull();
    expect(ranWith).not.toMatch(/promisor|partialclone/i);
    expect(read.code).not.toBe(0);
    expect(() => execFileSync("git", ["-C", partial, "-c", "protocol.allow=never", "cat-file", "-e", missing], { env: { ...env, GIT_NO_LAZY_FETCH: "1" }, stdio: "pipe" })).toThrow();
    // And the next read sees them, and refuses.
    expect(refusal(await checkoutGit(run, "read")("git", ["rev-parse", "HEAD"], { cwd: partial, timeoutMs: 30_000 }))).toBe(PARTIAL_CLONE_REFUSAL);
  });
  test("a promisor set plainly false is not a partial clone", () => {
    git(plain, "config", "remote.origin.promisor", "false");
    expect(checkoutGitSync(plain, ["rev-parse", "--verify", "HEAD^{commit}"]).trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("lazyFetchSetting reads only the repository's own scopes", () => {
  const listing = (...entries: [string, string][]) => entries.map(([scope, entry]) => `${scope}\0${entry}\0`).join("");
  test.each([
    [listing(["local", "extensions.partialclone\norigin"]), "extensions.partialclone"],
    [listing(["worktree", "remote.origin.promisor\ntrue"]), "remote.origin.promisor"],
    [listing(["local", "remote.origin.promisor"]), "remote.origin.promisor"],
    [listing(["local", "remote.origin.partialclonefilter\nblob:none"]), "remote.origin.partialclonefilter"],
    [listing(["local", "remote.origin.vcs\nevil"]), "remote.origin.vcs"],
    [listing(["local", "remote.origin.promisor\nfalse"]), null],
    [listing(["global", "remote.origin.promisor\ntrue"]), null],
    [listing(["local", "remote.origin.url\n/x"], ["local", "core.bare\nfalse"]), null],
  ])("%j → %s", (text, expected) => { expect(lazyFetchSetting(text)).toBe(expected); });
});
