/**
 * Attack (eval-harness review 1, finding 5; review 2, findings 2 and 3): the deployment script's git reads of the
 * project's Git directory or the build's checkout (scripts/deploy-git.mjs) fetch a missing object through a transport
 * the repository re-allows, or trust git's listing of a tree a build corrupted. Git never reads the repository's own
 * config there (a view with a config the script writes), so nothing it says — or starts saying mid-read — can reach a
 * transport; and every object, the commit and each tree included, is hashed against its id. Runs on the installed git
 * (the CI floor lane is 2.41.0 exactly) and on an emulated 2.41.0 (no --no-lazy-fetch, GIT_NO_LAZY_FETCH ignored).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
// @ts-expect-error plain ESM script without declarations
import { gitExecutable, lazyFetchFlagSupported, normalizedTreePath as scriptNormalized, objectsOf, parseTree as scriptParseTree, PINNED_PROTOCOLS, TRANSPORTS, repositoryView } from "../../scripts/deploy-git.mjs";
import { normalizedTreePath, parseTree } from "../../src/commit-extract.js";
import { agentFence, NO_GRANTS } from "../../src/agent-fence.js";
import { gitViewsRoot } from "../../src/git-views.js";
import { codexSandbox, needs, osFence, q, underCodex, underSandbox } from "./harness.js";

let root: string, source: string, partial: string, missing: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const plain = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
const git = (at: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", at, ...args], { env, stdio: "pipe", encoding: "utf8" });
const holds = (id: string) => spawnSync("git", ["-C", partial, ...PINNED_PROTOCOLS, "cat-file", "-e", id], { env: plain, stdio: "pipe" }).status === 0;

/**
 * A folder holding a `git` that acts as git 2.41.0 does on this road (no --no-lazy-fetch; GIT_NO_LAZY_FETCH ignored),
 * a `git-remote-custom` transport helper that only leaves a mark, and — the race — just before any `cat-file` runs,
 * the repository's config gains a promisor remote on that helper with `protocol.custom.allow=always`.
 */
function oldGitRacing(repoConfig: string, marker: string): string {
  const bin = join(root, "old-git-bin");
  mkdirSync(bin, { recursive: true });
  const real = gitExecutable(plain);
  writeFileSync(join(bin, "git"), `#!/bin/sh
[ "$1" = "--no-lazy-fetch" ] && { echo "unknown option: --no-lazy-fetch" >&2; exit 129; }
unset GIT_NO_LAZY_FETCH
case " $* " in *" cat-file "*)
  ${real} config --file '${repoConfig}' core.repositoryformatversion 1
  ${real} config --file '${repoConfig}' extensions.partialClone origin
  ${real} config --file '${repoConfig}' remote.origin.promisor true
  ${real} config --file '${repoConfig}' remote.origin.url custom::anything
  ${real} config --file '${repoConfig}' protocol.custom.allow always ;;
esac
exec ${real} "$@"
`);
  writeFileSync(join(bin, "git-remote-custom"), `#!/bin/sh
touch '${marker}'
exit 1
`);
  chmodSync(join(bin, "git"), 0o755); chmodSync(join(bin, "git-remote-custom"), 0o755);
  return bin;
}

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
  test("attack: a deployment view is in the build-denied folder, never shared temporary storage", () => {
    const fence = agentFence({ databaseFile: null, worktree: source, home: homedir() });
    const view = repositoryView(["-C", source], gitExecutable(plain));
    try {
      expect(fence).toContain(realpathSync(gitViewsRoot(homedir())));
      expect(view.dir.startsWith(realpathSync(gitViewsRoot(homedir())) + "/")).toBe(true);
    } finally { view.dispose(); }
  });

  test.for(["OS", "Codex"])("native %s: a surviving build cannot rewrite a deployment view", (kind, ctx) => {
    needs(ctx, kind === "OS" ? osFence() : codexSandbox());
    const fence = agentFence({ databaseFile: null, worktree: source, home: homedir() });
    const view = repositoryView(["-C", source], gitExecutable(plain));
    try {
      const config = join(view.dir, "config"), before = readFileSync(config, "utf8");
      const script = `printf '\\n[protocol "custom"]\\n\\tallow = always\\n' >> ${q(config)} 2>/dev/null && echo written || echo denied\necho own > own.txt && cat own.txt`;
      const ran = kind === "OS" ? underSandbox(script, fence, NO_GRANTS, { cwd: source })
        : underCodex(script, fence, true, NO_GRANTS, { cwd: source, codexHome: join(root, "codex-home") });
      expect(ran.stdout.trim().split("\n"), ran.stderr).toEqual(["denied", "own"]);
      expect(readFileSync(config, "utf8")).toBe(before);
    } finally { view.dispose(); }
  });

  test("attack (installed git): a read of a blob the partial clone lacks never fetches it, whatever the repository allows", () => {
    expect(() => objectsOf(["-C", partial], [missing], plain)).toThrow(/missing or unreadable|failed/);
    expect(holds(missing)).toBe(false);
  });

  test("attack (review 2 #3, emulated 2.41.0): config that turns lazy fetching on through any transport helper mid-read never reaches git", () => {
    // A plain repository by the time anything could look; the race adds the promisor remote and the custom helper.
    for (const key of ["extensions.partialClone", "remote.origin.promisor", "remote.origin.partialclonefilter", "protocol.file.allow"]) spawnSync("git", ["-C", partial, "config", "--unset-all", key], { env });
    const marker = join(root, "helper-ran");
    const bin = oldGitRacing(join(partial, ".git", "config"), marker);
    const old = { ...plain, PATH: `${bin}:${plain.PATH}` };
    expect(lazyFetchFlagSupported(gitExecutable(old))).toBe(false);
    expect(() => objectsOf(["-C", partial], [missing], old)).toThrow();
    // The race happened (the repository now names the helper), and the helper still never ran.
    expect(readFileSync(join(partial, ".git", "config"), "utf8")).toContain("custom::anything");
    expect(spawnSync("ls", [marker]).status).not.toBe(0);
    expect(holds(missing)).toBe(false);
  });

  test("every transport is pinned off by name on the command line", () => {
    for (const name of TRANSPORTS) expect(PINNED_PROTOCOLS).toContain(`protocol.${name}.allow=never`);
    expect(PINNED_PROTOCOLS).toContain("protocol.allow=never");
  });

  test("review 2 follow-up: --no-lazy-fetch is asked of each git executable, never PATH's first one for all", () => {
    const bin = oldGitRacing(join(partial, ".git", "config"), join(root, "unused"));
    const installed = gitExecutable(plain);
    expect(gitExecutable({ PATH: `${bin}:${plain.PATH}` })).toBe(realpathSync(join(bin, "git")));
    expect(lazyFetchFlagSupported(realpathSync(join(bin, "git")))).toBe(false);
    expect(lazyFetchFlagSupported(installed)).toBe(spawnSync(installed, ["--no-lazy-fetch", "version"], { stdio: "pipe" }).status === 0);
  });
});

describe("review 2 #2: the deployment script's reader is commit-extract.ts's, held equal", () => {
  test.each([
    ["a/b.txt"], ["../x"], ["/x"], ["a//b"], ["."], ["a\\b"], ["ok"], ["x\u0001"], [""],
  ])("normalizedTreePath %j", path => { expect(scriptNormalized(path)).toBe(normalizedTreePath(path)); });

  test("parseTree, well-formed and malformed", () => {
    const id = Buffer.alloc(20, 7);
    const good = Buffer.concat([Buffer.from("100644 a.txt\0"), id, Buffer.from("40000 dir\0"), id]);
    for (const bytes of [good, good.subarray(0, good.length - 1), Buffer.from("100644 a.txt"), Buffer.alloc(0)]) expect(scriptParseTree(bytes, 20)).toEqual(parseTree(bytes, 20));
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

describe("review 2 #2: a tree a build corrupted never substitutes files under the approved commit's id", () => {
  /** A repository whose commit names a.txt = "good", and a stored blob "evil" no tree names. */
  const made = () => {
    const repo = join(root, "corrupt");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
    mkdirSync(join(repo, "dir"));
    writeFileSync(join(repo, "a.txt"), "good\n");
    writeFileSync(join(repo, "dir", "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "one");
    const head = git(repo, "rev-parse", "HEAD").trim(), tree = git(repo, "rev-parse", "HEAD^{tree}").trim();
    const evil = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { env, input: "evil\n", encoding: "utf8" }).trim();
    return { repo, head, tree, evil };
  };
  /** Replace loose object `id` with other contents under the same name: what a build that writes .git can do. */
  const overwrite = (repo: string, id: string, type: string, body: Buffer) => {
    const path = join(repo, ".git", "objects", id.slice(0, 2), id.slice(2));
    unlinkSync(path);
    writeFileSync(path, deflateSync(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])));
  };

  test("the unchanged commit extracts the same files, bytes and modes as the release's own extraction", () => {
    const { repo, head } = made();
    const ours = realpathSync(mkdtempSync(join(root, "script-"))), release = realpathSync(mkdtempSync(join(root, "release-")));
    expect(extractTree(["-C", repo], head, ours, plain)).toBe(2);
    expect(extractCommit(join(repo, ".git"), head, release)).toEqual({ ok: true, files: 2 });
    for (const path of ["a.txt", "dir/run.sh"]) {
      expect(readFileSync(join(ours, path))).toEqual(readFileSync(join(release, path)));
      expect(statOf(join(ours, path))).toBe(statOf(join(release, path)));
    }
    expect(extractTree(["--git-dir", join(repo, ".git")], head, realpathSync(mkdtempSync(join(root, "gd-"))), plain)).toBe(2);
  });

  test("attack: a folder's tree rewritten to name another stored blob refuses, as the release's extraction does", () => {
    const { repo, head, evil } = made();
    const sub = git(repo, "rev-parse", "HEAD:dir").trim();
    // The substituted tree: dir/run.sh now names "evil" (a real, valid blob). git checks the hash of the root tree it is
    // asked about, but not of the trees under it: its own listing believes the substitution.
    overwrite(repo, sub, "tree", Buffer.concat([Buffer.from("100755 run.sh\0"), Buffer.from(evil, "hex")]));
    expect(git(repo, "ls-tree", "-r", head)).toContain(`${evil}\tdir/run.sh`);
    const dest = realpathSync(mkdtempSync(join(root, "out-")));
    expect(() => extractTree(["-C", repo], head, dest, plain)).toThrow(/doesn't hash to its id/);
    expect(() => blobAt(["-C", repo], head, "dir/run.sh", plain)).toThrow(/doesn't hash to its id/);
    expect(() => trackedChanges(repo, head, plain)).toThrow(/doesn't hash to its id/);
    expect(spawnSync("ls", [join(dest, "dir")]).status).not.toBe(0);
    expect(extractCommit(join(repo, ".git"), head, realpathSync(mkdtempSync(join(root, "rel-"))))).toMatchObject({ ok: false, message: expect.stringContaining("doesn't hash to its id") });
  });

  test("attack: the commit rewritten to name another tree refuses", () => {
    const { repo, head, evil } = made();
    const other = execFileSync("git", ["-C", repo, "mktree"], { env, input: `100644 blob ${evil}\ta.txt\n`, encoding: "utf8" }).trim();
    const body = readFileSync(join(repo, ".git", "objects", head.slice(0, 2), head.slice(2)));
    const text = git(repo, "cat-file", "commit", head).replace(/^tree [0-9a-f]{40}/, `tree ${other}`);
    expect(body.length).toBeGreaterThan(0);
    overwrite(repo, head, "commit", Buffer.from(text));
    expect(() => extractTree(["-C", repo], head, realpathSync(mkdtempSync(join(root, "out-"))), plain)).toThrow(/doesn't hash to its id/);
  });
});

import { statSync } from "node:fs";
const statOf = (path: string) => statSync(path).mode & 0o777;
