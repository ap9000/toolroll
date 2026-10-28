/**
 * Attack: a repository's own config that makes the plane's git run a program without naming one in a key the
 * classifier knew (Codex review of a0fa135d). `alias.remote-<x>` plus a `url.<x>.insteadOf` rewrite turns a local
 * fetch into `<x>::…`, and git runs the alias as the remote helper, whatever the teardown flags say. The classifier now
 * refuses aliases, URL rewrites, a repository's own protocol policy and every other key git's documentation says names,
 * picks or writes through a program (the audit table below), and every write takes `protocol.allow=never` (the nightly
 * check's local fetch allows `file` by name).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commandSetting, refusal, teardownGit, TEARDOWN_FLAGS, WRITE_VIEW_FLAGS } from "../../src/teardown-git.js";

let root: string, repo: string, source: string, marker: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { env, stdio: "pipe", encoding: "utf8" });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-gitaudit-")));
  repo = join(root, "project"); source = join(root, "source.git"); marker = join(root, "ran");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "one");
  execFileSync("git", ["clone", "-q", "--bare", repo, source], { env });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The helper road: a fetch from `source` rewritten to `evil::`, whose remote helper is an alias. */
const plantHelper = () => {
  git("config", "alias.remote-evil", `!touch ${marker}; false`);
  git("config", `url.evil::x.insteadOf`, source);
};
const fetch = ["-c", "protocol.file.allow=always", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", () => source, "+refs/heads/main:refs/toolroll/nightly"] as const;
const fetchArgs = () => fetch.map(one => typeof one === "function" ? one() : one);

describe("attack: a remote helper chosen by the repository's own config", () => {
  test("control: under the old flags alone, git runs the helper", () => {
    plantHelper();
    try { execFileSync("git", [...TEARDOWN_FLAGS, "-c", "worktree.useRelativePaths=false", ...fetchArgs()], { cwd: repo, env, stdio: "pipe" }); } catch { /* the helper fails on purpose */ }
    expect(existsSync(marker)).toBe(true);
  });

  test("teardown's fetch is refused; nothing runs", async () => {
    plantHelper();
    const fetched = await teardownGit()(repo, fetchArgs());
    expect(refusal(fetched), fetched.stderr).toMatch(/alias\.remote-evil|url\.evil::x\.insteadof/);
    expect(existsSync(marker)).toBe(false);
  });

  test("the write flags alone (the belt): no transport but the one allowed by name", () => {
    plantHelper();
    expect(() => execFileSync("git", [...TEARDOWN_FLAGS, ...WRITE_VIEW_FLAGS, ...fetchArgs()], { cwd: repo, env, stdio: "pipe" })).toThrow(/not allowed/);
    expect(existsSync(marker)).toBe(false);
    // The nightly check's own fetch, unrewritten, still works under the same flags.
    git("config", "--unset", `url.evil::x.insteadOf`);
    execFileSync("git", [...TEARDOWN_FLAGS, ...WRITE_VIEW_FLAGS, ...fetchArgs()], { cwd: repo, env, stdio: "pipe" });
    expect(git("rev-parse", "refs/toolroll/nightly").trim()).toBe(git("rev-parse", "main").trim());
  });
});

describe("the config audit (git-config(1), git 2.50.1)", () => {
  const listing = (key: string, value: string) => `local\0${key}\n${value}\0`;
  test.each([
    // Program, shell or editor.
    ["core.sshCommand", "x"], ["core.editor", "x"], ["core.askPass", "x"], ["core.pager", "x"], ["core.gitProxy", "x"], ["core.alternateRefsCommand", "x"],
    ["core.fsmonitor", "./watch"], ["sequence.editor", "x"], ["uploadpack.packObjectsHook", "x"], ["gc.recentObjectsHook", "x"],
    ["credential.helper", "x"], ["credential.https://h.helper", "x"], ["diff.external", "x"], ["diff.x.textconv", "x"], ["diff.x.command", "x"],
    ["merge.x.driver", "x"], ["difftool.x.cmd", "x"], ["difftool.prompt", "false"], ["mergetool.x.cmd", "x"], ["gpg.program", "x"], ["gpg.ssh.program", "x"],
    ["gpg.ssh.defaultKeyCommand", "x"], ["pager.log", "x"], ["man.viewer", "x"], ["man.x.cmd", "x"], ["web.browser", "x"], ["browser.x.cmd", "x"],
    ["instaweb.httpd", "x"], ["sendemail.smtpServer", "/bin/x"], ["sendemail.toCmd", "x"], ["interactive.diffFilter", "x"], ["trailer.x.command", "x"],
    ["submodule.x.update", "!x"], ["filter.x.clean", "x"],
    // Picks a transport or helper, or the protocol policy.
    ["alias.remote-evil", "!x"], ["alias.st", "status"], ["url.evil::x.insteadOf", "/src"], ["url.x.pushInsteadOf", "/src"], ["remote.origin.vcs", "evil"],
    ["remote.origin.url", "evil::/src"], ["remote.origin.pushurl", "ext::sh -c x"], ["remote.origin.uploadpack", "x"], ["remote.origin.receivepack", "x"],
    ["protocol.allow", "always"], ["protocol.ext.allow", "always"], ["protocol.evil.allow", "always"],
    // Writes a file as the plane, or brings in config nobody read.
    ["trace2.normalTarget", "/tmp/x"], ["trace2.eventTarget", "af_unix:/tmp/x"], ["include.path", "/tmp/x"], ["includeIf.onbranch:main.path", "/tmp/x"],
    ["lfs.standalonetransferagent", "x"], ["lfs.customtransfer.x.path", "x"], ["lfs.extension.x.clean", "x"],
    // Deny by default: config-based hooks (git 2.36+), archive filters, any section or variable not audited.
    ["hook.pre-commit.command", "x"], ["hook.x.event", "pre-commit"], ["tar.tgz.command", "gzip"], ["tar.tar.xz.command", "x"], ["mytool.setting", "x"],
    ["git-town.main-branch", "main"], ["core.unauditedNewKey", "x"], ["remote.origin.unauditedKey", "x"], ["diff.x.unauditedKey", "x"], ["merge.x.unknown", "x"],
    ["credential.username", "me"], ["gpg.format", "ssh"], ["filter.x.required", "maybe"],
    // A scheme git has no transport of its own for runs git-remote-<scheme>.
    ["remote.origin.url", "evil://host/repo"], ["remote.origin.pushurl", "hg://host/repo"], ["remote.origin.url", "persistent-https://h/r"],
  ])("%s = %s is refused", (key, value) => {
    expect(commandSetting(listing(key, value), { lfsChecked: true })).toBe(key.toLowerCase());
  });

  test.each([
    // Overridden on every command by TEARDOWN_FLAGS (core.hooksPath=/dev/null, core.fsmonitor=false as a boolean).
    ["core.hooksPath", ".husky"], ["core.fsmonitor", "true"],
    // Name no program.
    ["receive.denyCurrentBranch", "updateInstead"], ["transfer.fsckObjects", "true"], ["fetch.prune", "true"], ["http.proxy", "http://proxy:3128"],
    ["http.https://h.extraHeader", "X: y"], ["gc.auto", "0"], ["maintenance.auto", "false"], ["ssh.variant", "ssh"], ["remote.origin.url", "git@github.com:o/r.git"],
    ["remote.origin.url", "https://github.com/o/r.git"], ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], ["user.signingKey", "key::ssh-ed25519 AAAA"],
    ["core.autocrlf", "input"], ["branch.main.remote", "origin"], ["lfs.url", "https://h/lfs"], ["filter.x.required", "true"],
    ["remote.origin.url", "ssh://git@h/o/r.git"], ["remote.origin.url", "git://h/r"], ["remote.origin.url", "file:///srv/r.git"], ["remote.origin.url", "/srv/r.git"],
    ["remote.origin.url", "../sibling"], ["remote.origin.url", "host:path/r.git"], ["submodule.lib.url", "https://h/lib"], ["gc.reflogExpire", "never"],
  ])("%s = %s is allowed", (key, value) => {
    expect(commandSetting(listing(key, value), { lfsChecked: true })).toBeNull();
  });
});

describe("operator configs seen in practice still pass", () => {
  const scopes = (at: string) => execFileSync("git", ["config", "--list", "--show-scope", "-z", "--local"], { cwd: at, env, encoding: "utf8" });
  test("this repository's own config", () => {
    const own = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    const listing = execFileSync("git", ["config", "--file", join(own, "config"), "--list", "-z"], { env, encoding: "utf8" }).split("\0").filter(Boolean).map(entry => `local\0${entry}\0`).join("");
    expect(commandSetting(listing, { lfsChecked: true })).toBeNull();
  });
  test("a git-lfs local install, a typical remote and branch setup, worktree config, a hooks path", () => {
    for (const [key, value] of [["filter.lfs.clean", "git-lfs clean -- %f"], ["filter.lfs.smudge", "git-lfs smudge -- %f"], ["filter.lfs.process", "git-lfs filter-process"],
      ["filter.lfs.required", "true"], ["lfs.repositoryformatversion", "0"], ["remote.origin.url", "git@github.com:o/r.git"], ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ["branch.main.remote", "origin"], ["branch.main.merge", "refs/heads/main"], ["branch.main.vscode-merge-base", "origin/main"], ["user.name", "Op"], ["user.email", "op@h"],
      ["extensions.worktreeConfig", "true"], ["core.hooksPath", ".husky"], ["pull.rebase", "false"], ["init.defaultBranch", "main"]]) git("config", key!, value!);
    expect(commandSetting(scopes(repo), { lfsChecked: true })).toBeNull();
  });
});
