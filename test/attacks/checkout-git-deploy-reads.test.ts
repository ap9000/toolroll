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

// @ts-expect-error plain ESM script without declarations
import { writtenPathsProblem as scriptPaths } from "../../scripts/deploy-git.mjs";
import { extractCommit, writtenPathsProblem } from "../../src/commit-extract.js";

describe("security scan: a hostile tree never writes outside, through a link, or over itself", () => {
  /** A commit whose tree is exactly `entries` (mode, path, content), made from the index, never a checkout. */
  const crafted = (entries: [string, string, string][]): { repo: string; head: string } => {
    const repo = join(root, `crafted-${Math.random().toString(36).slice(2)}`);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
    for (const [mode, path, content] of entries) {
      const id = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { env, input: content, encoding: "utf8" }).trim();
      git(repo, "update-index", "--add", "--cacheinfo", `${mode},${id},${path}`);
    }
    const tree = git(repo, "write-tree").trim();
    return { repo, head: execFileSync("git", ["-C", repo, "commit-tree", tree, "-m", "crafted"], { env, encoding: "utf8" }).trim() };
  };

  test.each([
    ["a symlink, then a file through it", [["120000", "a", root], ["100644", "b/x", "x\n"]]],
    ["a symlink to outside on its own", [["120000", "link", "/etc/passwd"], ["100644", "ok.txt", "x\n"]]],
    ["two paths one file on macOS (case)", [["100644", "Readme.txt", "1\n"], ["100644", "readme.txt", "2\n"]]],
    ["two paths one file (Unicode normalization)", [["100644", "café.txt", "1\n"], ["100644", "café.txt", "2\n"]]],
    ["a .git folder", [["100644", "sub/.git/config", "[core]\n"], ["100644", "ok.txt", "x\n"]]],
    ["a submodule", [["160000", "mod", ""], ["100644", "ok.txt", "x\n"]]],
  ] as [string, [string, string, string][]][])("attack: %s is refused, nothing written outside", (_name, entries) => {
    let made: { repo: string; head: string };
    try {
      // A submodule entry needs a commit id, not a blob: point it at any commit.
      made = crafted(entries.filter(one => one[0] !== "160000"));
      if (entries.some(one => one[0] === "160000")) {
        git(made.repo, "update-index", "--add", "--cacheinfo", `160000,${made.head},mod`);
        made = { repo: made.repo, head: execFileSync("git", ["-C", made.repo, "commit-tree", git(made.repo, "write-tree").trim(), "-m", "sub"], { env, encoding: "utf8" }).trim() };
      }
    } catch { return; } // git itself wouldn't build it on this file system: nothing to extract
    // git folded two names into one (macOS precomposes Unicode): no hostile tree to extract; the path rules below cover it.
    if (git(made.repo, "ls-tree", "-r", "--name-only", made.head).trim().split("\n").length < entries.length) return;
    const dest = realpathSync(mkdtempSync(join(root, "out-")));
    expect(() => extractTree(["-C", made.repo], made.head, dest, plain)).toThrow();
    const release = realpathSync(mkdtempSync(join(root, "rel-")));
    expect(extractCommit(join(made.repo, ".git"), made.head, release)).toMatchObject({ ok: false });
    expect(existsSync(join(root, "x"))).toBe(false);
  });

  test.each([
    [["a", "a/b"], "both a file and a folder"], [["A/b", "a"], "both a file and a folder"], [["x", "x"], "twice"], [["X.txt", "x.txt"], "same file"],
    [["a/.GIT/x"], ".git"], [["../x"], "plain"], [["/x"], "plain"], [["a//b"], "plain"], [["ok/fine.txt", "other.txt"], null],
  ] as [string[], string | null][])("the path rules, the same in the deployment script and the release's extraction: %j", (paths, problem) => {
    const ours = writtenPathsProblem(paths), script = scriptPaths(paths);
    if (problem === null) { expect(ours).toBeNull(); expect(script).toBeNull(); }
    else { expect(ours).toContain(problem); expect(script).toBe(ours); }
  });
});

test("security scan: attack: a tree with a link `a` and a folder `a` never writes through the link", () => {
  const repo = join(root, "linked");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  const outside = realpathSync(mkdtempSync(join(root, "outside-")));
  const blob = (text: string) => execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { env, input: text, encoding: "utf8" }).trim();
  const mktree = (lines: string) => execFileSync("git", ["-C", repo, "mktree", "--missing"], { env, input: lines, encoding: "utf8" }).trim();
  const sub = mktree(`100644 blob ${blob("planted\n")}\tx\n`);
  let top: string;
  try { top = mktree(`120000 blob ${blob(outside)}\ta\n040000 tree ${sub}\ta\n`); } catch { return; }
  const head = execFileSync("git", ["-C", repo, "commit-tree", top, "-m", "hostile"], { env, encoding: "utf8" }).trim();
  const dest = realpathSync(mkdtempSync(join(root, "out-")));
  expect(() => extractTree(["-C", repo], head, dest, plain)).toThrow();
  expect(extractCommit(join(repo, ".git"), head, realpathSync(mkdtempSync(join(root, "rel-"))))).toMatchObject({ ok: false });
  expect(existsSync(join(outside, "x"))).toBe(false);
});
