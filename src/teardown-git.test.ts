/**
 * Teardown's config scan: which settings in the repository's own config (local or worktree scope, includes off) make
 * teardown refuse to run git there, and that system or global settings never do.
 */
import { describe, expect, test } from "vitest";
import { commandSetting, refusal, REFUSED_CODE } from "./teardown-git.js";

const listing = (...entries: [scope: string, key: string, value: string][]) => entries.map(([scope, key, value]) => `${scope}\0${key}\n${value}\0`).join("");

describe("command-running settings refuse teardown", () => {
  test.each([
    ["core.fsmonitor", "/tmp/planted"], ["core.sshCommand", "touch /tmp/x"], ["core.gitProxy", "proxy"], ["core.askPass", "ask"],
    ["credential.helper", "store"], ["credential.https://example.com.helper", "x"], ["filter.lfs.smudge", "git-lfs smudge %f"],
    ["filter.x.process", "x"], ["diff.external", "x"], ["diff.x.textconv", "x"], ["merge.x.driver", "x"], ["core.pager", "less"],
    ["include.path", "/tmp/more"], ["includeIf.gitdir:/x/.path", "/tmp/more"], ["remote.origin.uploadpack", "x"], ["uploadpack.packObjectsHook", "x"],
  ])("%s in local config", (key, value) => {
    expect(commandSetting(listing(["local", "core.bare", "false"], ["local", key, value]))).toBe(key.toLowerCase());
    expect(commandSetting(listing(["worktree", key, value]))).toBe(key.toLowerCase());
  });

  test("ordinary settings, a boolean fsmonitor, a hooks path (overridden on every command) and other scopes don't", () => {
    expect(commandSetting(listing(["local", "core.bare", "false"], ["local", "core.hooksPath", ".husky"], ["local", "remote.origin.url", "git@x:y"],
      ["local", "core.fsmonitor", "true"], ["worktree", "core.fsmonitor", "false"], ["local", "filter.lfs.required", "true"],
      ["system", "credential.helper", "osxkeychain"], ["global", "core.pager", "less"], ["unknown", "credential.helper", "osxkeychain"], ["command", "core.fsmonitor", "/x"]))).toBeNull();
    expect(commandSetting("")).toBeNull();
  });

  test("a refusal reads as one, and an ordinary git failure doesn't", () => {
    expect(refusal({ code: REFUSED_CODE, stdout: "", stderr: "Toolroll won't run git here: it sets x\n", timedOut: false, notFound: false })).toBe("it sets x");
    expect(refusal({ code: REFUSED_CODE, stdout: "", stderr: "fatal: not a git repository\n", timedOut: false, notFound: false })).toBeNull();
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.js";
import { carriedSettings, checkoutGit, teardownGit, TEARDOWN_FLAGS } from "./teardown-git.js";
import { WorktreePool } from "./worktree.js";
import { openStore } from "./store.js";

test.each(["GPG.SSH.defaultKeyCommand", "FiLtEr.X.ClEaN", "IncludeIf.gitdir:X.PATH", "submodule.x.update"])("refuses mixed-case %s", key => {
  expect(commandSetting(listing(["local", key, "!command"]))).toBe(key.toLowerCase());
});

test("removal scans the target config immediately and refuses its command", async () => {
  const calls: { cwd: string | undefined; args: readonly string[] }[] = [];
  const git = teardownGit(async (_file, args, options) => {
    calls.push({ cwd: options?.cwd, args });
    return { code: 0, stdout: options?.cwd === "/target" ? listing(["worktree", "gpg.ssh.defaultKeyCommand", "planted"]) : "", stderr: "", timedOut: false, notFound: false };
  });
  expect(refusal(await git("/repo", ["worktree", "remove", "--force", "/target"]))).toContain("gpg.ssh.defaultkeycommand");
  expect(calls.map(call => call.cwd)).toEqual(["/repo", "/target"]);
  expect(calls.every(call => call.args.includes("--no-includes"))).toBe(true);
});

test("status and removal refuse an initialized staged gitlink without executing its clean filter", async () => {
  const root = mkdtempSync(join(tmpdir(), "teardown-nested-"));
  const repo = join(root, "repo"), nested = join(repo, "nested"), marker = join(root, "ran");
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  try {
    mkdirSync(nested, { recursive: true });
    for (const cwd of [repo, nested]) { sh(cwd, "init", "-q"); sh(cwd, "commit", "--allow-empty", "-qm", "initial"); }
    writeFileSync(join(nested, ".gitattributes"), "payload filter=x\n");
    writeFileSync(join(nested, "payload"), "before\n");
    sh(nested, "add", "."); sh(nested, "commit", "-qm", "payload");
    sh(repo, "update-index", "--add", "--cacheinfo", `160000,${sh(nested, "rev-parse", "HEAD")},nested`);
    sh(nested, "config", "filter.x.clean", `echo ran > '${marker}'; cat`);
    writeFileSync(join(nested, "payload"), "after!\n");
    sh(repo, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const store = openStore(":memory:");
    try { expect(await new WorktreePool(store, { root }).inspect(repo)).toBe("unreadable"); } finally { store.close(); }
    const git = teardownGit();
    expect(refusal(await git(repo, ["status", "--porcelain"]))).toContain("nested repository");
    expect(refusal(await git(repo, ["worktree", "remove", "--force", repo]))).toContain("nested repository");
    expect(existsSync(marker)).toBe(false);
    rmSync(nested, { recursive: true });
    expect(refusal(await git(repo, ["status", "--porcelain"]))).toContain("gitlink");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inspection always has non-recursing flags and the hardened environment", async () => {
  const git = teardownGit(async (_file, args, options) => {
    expect(options?.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
    if (!args.includes("config")) expect(args.slice(0, TEARDOWN_FLAGS.length)).toEqual(TEARDOWN_FLAGS);
    if (args.includes("status") || args.includes("diff")) expect(args).toContain("--ignore-submodules=all");
    return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
  });
  await git("/nonexistent-fixture", ["status", "--porcelain"]);
  await git("/nonexistent-fixture", ["diff", "--", "file"]);
});

test("removal from the shared repository refuses the target worktree's fsmonitor command", async () => {
  const root = mkdtempSync(join(tmpdir(), "teardown-target-"));
  const target = join(root, "checkout"), repo = join(root, "repo"), marker = join(root, "ran");
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  try {
    mkdirSync(repo);
    sh(repo, "init", "-q"); sh(repo, "commit", "--allow-empty", "-qm", "initial");
    sh(repo, "worktree", "add", "-qb", "disposable", target);
    sh(repo, "config", "extensions.worktreeConfig", "true");
    const script = join(root, "monitor");
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    sh(target, "config", "--worktree", "core.fsmonitor", script);
    expect(refusal(await teardownGit()(repo, ["worktree", "remove", "--force", target]))).toContain("core.fsmonitor");
    expect(existsSync(target)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("the plane's git on a build's checkout (checkoutGit)", () => {
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "so-checkout-git-"));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
    writeFileSync(join(dir, "a.txt"), "a\n");
    return { dir, env };
  };

  test("a filter a build planted in the checkout's config never runs: the add is refused", async () => {
    const { dir, env } = repo();
    const marker = join(dir, "..", `${dir.split("/").pop()}-ran`);
    execFileSync("git", ["config", "filter.evil.clean", `touch ${marker}; cat`], { cwd: dir });
    writeFileSync(join(dir, ".gitattributes"), "* filter=evil\n");
    const added = await checkoutGit()("git", ["add", "-A"], { cwd: dir, env });
    expect(refusal(added)).toMatch(/filter\.evil\.clean/);
    expect(existsSync(marker)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a hook a build planted never runs, and an ordinary checkout commits", async () => {
    const { dir, env } = repo();
    const marker = join(dir, "hook-ran");
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const git = checkoutGit();
    expect((await git("git", ["add", "-A"], { cwd: dir, env })).code).toBe(0);
    expect((await git("git", ["commit", "-q", "-m", "x"], { cwd: dir, env })).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

test("checkoutGit's status never enters a submodule whose config would run a command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "so-checkout-sub-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const inner = join(dir, "inner");
  mkdirSync(inner);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: inner, env });
  writeFileSync(join(inner, "f"), "x\n");
  execFileSync("git", ["add", "f"], { cwd: inner, env });
  execFileSync("git", ["commit", "-q", "-m", "x"], { cwd: inner, env });
  const outer = join(dir, "outer");
  mkdirSync(outer);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: outer, env });
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub"], { cwd: outer, env });
  const marker = join(dir, "ran");
  execFileSync("git", ["config", "core.fsmonitor", `touch ${marker}; true`], { cwd: join(outer, "sub") });
  writeFileSync(join(outer, "sub", "f"), "changed\n");
  const status = await checkoutGit()("git", ["status", "--porcelain"], { cwd: outer, env });
  expect(status.code).toBe(0);
  expect(existsSync(marker)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("a global filter that would run the checkout's own file never runs: global config contributes values only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "so-checkout-global-"));
  const global = join(dir, "global.gitconfig");
  writeFileSync(global, "[filter \"fmt\"]\n\tclean = ./tools/filter.sh\n");
  const repoDir = join(dir, "r");
  mkdirSync(join(repoDir, "tools"), { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, env });
  const marker = join(dir, "ran");
  writeFileSync(join(repoDir, "tools", "filter.sh"), `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
  writeFileSync(join(repoDir, ".gitattributes"), "* filter=fmt\n");
  writeFileSync(join(repoDir, "a.txt"), "a\n");
  const added = await checkoutGit()("git", ["add", "-A"], { cwd: repoDir, env });
  expect(added.code).toBe(0);
  expect(existsSync(marker)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("the operator's config carries values only: identity, line endings, a standard git-lfs install", () => {
  const listing = [
    ["global", "user.name\nAlex"], ["global", "user.email\na@b"], ["system", "core.autocrlf\ninput"],
    ["global", "filter.lfs.clean\ngit-lfs clean -- %f"], ["global", "filter.lfs.process\ngit-lfs filter-process"],
    ["global", "filter.fmt.clean\nsh filter.sh"], ["global", "filter.lfs.smudge\n/checkout/git-lfs smudge -- %f"],
    ["global", "gpg.ssh.defaultkeycommand\nsh key.sh"], ["global", "diff.x.textconv\nvim -S x.vim"], ["local", "user.name\nBuild"],
  ].map(([scope, entry]) => `${scope}\0${entry}\0`).join("");
  expect(carriedSettings(listing)).toEqual(["-c", "user.name=Alex", "-c", "user.email=a@b", "-c", "core.autocrlf=input",
    "-c", "filter.lfs.clean=git-lfs clean -- %f", "-c", "filter.lfs.process=git-lfs filter-process"]);
});

test("a global include (a config file, not a command) never blocks the plane's git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "so-checkout-include-"));
  const global = join(dir, "global.gitconfig");
  mkdirSync(join(dir, "git"));
  writeFileSync(join(dir, "git", "common.inc"), "[core]\n\tautocrlf = false\n");
  writeFileSync(global, "[include]\n\tpath = git/common.inc\n");
  const repoDir = join(dir, "r");
  mkdirSync(repoDir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, env });
  writeFileSync(join(repoDir, "a.txt"), "a\n");
  expect((await checkoutGit()("git", ["add", "-A"], { cwd: repoDir, env })).code).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("a command an include brings into global config never runs either", async () => {
  const dir = mkdtempSync(join(tmpdir(), "so-checkout-included-"));
  const global = join(dir, "global.gitconfig");
  writeFileSync(join(dir, "more.inc"), "[filter \"fmt\"]\n\tclean = sh filter.sh\n");
  writeFileSync(global, "[include]\n\tpath = more.inc\n");
  const repoDir = join(dir, "r");
  mkdirSync(repoDir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, env });
  const marker = join(dir, "ran");
  writeFileSync(join(repoDir, "filter.sh"), `touch ${marker}\ncat\n`);
  writeFileSync(join(repoDir, ".gitattributes"), "* filter=fmt\n");
  expect((await checkoutGit()("git", ["add", "-A"], { cwd: repoDir, env })).code).toBe(0);
  expect(existsSync(marker)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("a checkout's own include is refused before git follows it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "so-checkout-own-include-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "include.path", "/dev/zero"], { cwd: dir });
  const seen: string[][] = [];
  const result = await checkoutGit(async (file, args, options) => { seen.push([...args]); return run(file, args, options); })("git", ["status"], { cwd: dir });
  expect(refusal(result)).toMatch(/includes another file/);
  expect(seen).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test.each(["gitdir:/x", "gitdir: x\ngitdir: y", "gitdir:  /x", "not a pointer"])("a .git file git wouldn't read exactly so is refused (%j)", async pointer => {
  const dir = mkdtempSync(join(tmpdir(), "so-checkout-pointer-"));
  writeFileSync(join(dir, ".git"), `${pointer}\n`);
  const seen: string[][] = [];
  const result = await checkoutGit(async (file, args, options) => { seen.push([...args]); return run(file, args, options); })("git", ["status"], { cwd: dir });
  expect(refusal(result)).toMatch(/includes another file|couldn't be read/);
  expect(seen).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test.each(['[include]\n\tpath = /dev/zero', '[Include]\n path=/dev/zero', '[includeIf "gitdir:/"]\n\tpath = /dev/zero', '[core]\n\tbare = false\n[include]path = /dev/zero'])("an include in any spelling git reads is refused before git runs (%#)", async config => {
  const dir = mkdtempSync(join(tmpdir(), "so-checkout-spell-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n${config}\n`);
  const seen: string[][] = [];
  const result = await checkoutGit(async (file, args, options) => { seen.push([...args]); return run(file, args, options); })("git", ["status"], { cwd: dir });
  expect(refusal(result)).toMatch(/includes another file/);
  expect(seen).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("a git-lfs extension in the checkout's config or its .lfsconfig is refused before git runs", async () => {
  for (const where of ["config", "lfsconfig"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "so-checkout-lfs-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    if (where === "config") execFileSync("git", ["config", "lfs.extension.evil.clean", "sh payload.sh"], { cwd: dir });
    else writeFileSync(join(dir, ".lfsconfig"), "[lfs \"extension.evil\"]\n\tclean = sh payload.sh\n");
    const result = await checkoutGit()("git", ["add", "-A"], { cwd: dir });
    expect(refusal(result), where).toMatch(/lfs/);
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  ["lfs.customtransfer.evil.path", "sh", true], ["lfs.standalonetransferagent", "evil", true], ["lfs.https://x.standalonetransferagent", "evil", true],
  ["lfs.extension.evil.clean", "sh p.sh", true], ["lfs.url", "https://lfs.example.com", false], ["lfs.fetchinclude", "assets/*", false],
])("the checkout's own %s is refused only when it could name a program", async (key, value, refusedOne) => {
  const dir = mkdtempSync(join(tmpdir(), "so-checkout-lfskeys-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", key, value], { cwd: dir });
  const result = await checkoutGit()("git", ["status", "--porcelain"], { cwd: dir });
  expect(refusal(result) !== null).toBe(refusedOne);
  rmSync(dir, { recursive: true, force: true });
});
