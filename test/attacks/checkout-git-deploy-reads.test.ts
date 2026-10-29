/**
 * Attack (eval-harness review 1, finding 5, security scan): the deployment script's git reads of the project's Git
 * directory or the build's checkout (scripts/deploy-git.mjs) fetch a missing object through a transport the repository
 * re-allows. Every run pins every transport off on the command line (which outranks the repository's own
 * `protocol.<name>.allow`); git 2.45+ also takes --no-lazy-fetch; an older git refuses a repository whose config could
 * make a lazy fetch possible. Runs on the installed git (the CI floor lane is 2.41.0 exactly) and with the old road forced.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
// @ts-expect-error plain ESM script without declarations
import { lazyFetchKey, safeGitArgs, PINNED_PROTOCOLS, TRANSPORTS } from "../../scripts/deploy-git.mjs";

let root: string, source: string, partial: string, missing: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const plain = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
const git = (at: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", at, ...args], { env, stdio: "pipe", encoding: "utf8" });
const holds = (id: string) => spawnSync("git", ["-C", partial, ...PINNED_PROTOCOLS, "cat-file", "-e", id], { env: plain, stdio: "pipe" }).status === 0;
const installedHasFlag = () => spawnSync("git", ["--no-lazy-fetch", "version"], { env: plain, stdio: "pipe" }).status === 0;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-deploy-git-")));
  source = join(root, "source"); partial = join(root, "partial");
  execFileSync("git", ["init", "-q", "-b", "main", source], { env });
  writeFileSync(join(source, "big.txt"), "a blob the partial clone leaves behind\n");
  git(source, "add", "-A"); git(source, "commit", "-qm", "one");
  git(source, "config", "uploadpack.allowFilter", "true");
  execFileSync("git", ["-c", "protocol.file.allow=always", "clone", "-q", "--no-local", "--no-checkout", "--filter=blob:none", `file://${source}`, partial], { env, stdio: "pipe" });
  missing = git(source, "rev-parse", "HEAD:big.txt").trim();
  // The build re-allows the clone's transport in the repository's own config.
  git(partial, "config", "protocol.file.allow", "always");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("the deployment script's git reads", () => {
  for (const road of ["installed", "forced old"] as const) {
    test(`attack (${road} git): a read of a blob the partial clone lacks never fetches it, whatever the repository allows`, () => {
      const supported = road === "installed" ? installedHasFlag() : false;
      let args: string[] | null = null;
      try { args = safeGitArgs(["-C", partial], plain, supported); } catch (error) { expect(String(error)).toMatch(/protocol\.file\.allow|partialclone|promisor/); }
      if (road === "forced old") expect(args).toBeNull();
      if (args !== null) expect(spawnSync("git", [...args, "cat-file", "-p", missing], { env: plain, stdio: "pipe" }).status).not.toBe(0);
      expect(holds(missing)).toBe(false);
    });
  }

  test("every transport is pinned off by name on the command line", () => {
    for (const name of TRANSPORTS) expect(PINNED_PROTOCOLS).toContain(`protocol.${name}.allow=never`);
    expect(PINNED_PROTOCOLS).toContain("protocol.allow=never");
  });

  test.each([
    ["include.path", "x"], ["includeif.gitdir:/x.path", "y"], ["protocol.file.allow", "always"], ["protocol.allow", "always"], ["extensions.partialclone", "origin"],
    ["remote.origin.promisor", "true"], ["remote.origin.partialclonefilter", "blob:none"], ["remote.origin.vcs", "x"],
  ])("an old git refuses a repository whose config sets %s", (key, value) => {
    expect(lazyFetchKey(`local\0${key}\n${value}\0`)).toBe(key);
  });

  test("a plain repository's config passes, and a promisor set plainly false is none", () => {
    expect(lazyFetchKey("local\0core.bare\nfalse\0local\0remote.origin.url\nhttps://x\0local\0remote.origin.promisor\nfalse\0")).toBeNull();
    expect(lazyFetchKey(undefined)).not.toBeNull();
    expect(safeGitArgs(["-C", source], plain, false)).toEqual(expect.arrayContaining(PINNED_PROTOCOLS));
  });
});

// @ts-expect-error plain ESM script without declarations
import { blobAt, extractTree, trackedChanges } from "../../scripts/deploy-git.mjs";
import { existsSync, readFileSync as readText } from "node:fs";

describe("security scan: the deployment script reads a commit with no filter, attribute or textconv", () => {
  test("attack: a filter, textconv and diff program the repository names never run, and the bytes are the stored ones", () => {
    const repo = join(root, "filtered"), marker = join(root, "ran");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
    writeFileSync(join(repo, "a.txt"), "stored\n");
    writeFileSync(join(repo, "link"), "");
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "one");
    const head = git(repo, "rev-parse", "HEAD").trim();
    // The build plants programs in the repository's config and asks for them from every attributes source.
    const touch = `sh -c 'touch ${marker}; cat'`;
    for (const [key, value] of [["filter.evil.smudge", touch], ["filter.evil.clean", touch], ["filter.evil.process", `sh -c 'touch ${marker}'`], ["diff.evil.textconv", touch], ["diff.external", touch]]) git(repo, "config", key, value);
    writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=evil diff=evil\n");
    writeFileSync(join(repo, ".gitattributes"), "* filter=evil diff=evil\n");
    const dest = realpathSync(mkdtempSync(join(root, "out-")));
    expect(extractTree(["-C", repo], head, dest, plain)).toBe(2);
    expect(readText(join(dest, "a.txt"), "utf8")).toBe("stored\n");
    expect(blobAt(["-C", repo], head, "a.txt", plain)!.toString()).toBe("stored\n");
    expect(blobAt(["-C", repo], head, "missing.txt", plain)).toBeNull();
    // Dirty a tracked file's stat so status would run the clean filter; the check hashes it itself.
    writeFileSync(join(repo, "a.txt"), "stored\n");
    expect(trackedChanges(repo, head, plain)).toEqual([]);
    writeFileSync(join(repo, "a.txt"), "changed\n");
    expect(trackedChanges(repo, head, plain)).toEqual(["a.txt"]);
    expect(existsSync(marker)).toBe(false);
  });
});
