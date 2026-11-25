/**
 * Attack: make Direct Chat's git in the project's own repository run a program, or fetch from somewhere else. That
 * repository is shared with every build, which can write its config: a clean filter behind a .gitattributes, an
 * include bringing a filter in from a file nobody read, or a URL rewrite pointing the chat's import fetch at another
 * repository. Direct Chat used to copy teardown's flags onto plain `git` runs, which overrode hooks and fsmonitor but
 * left includes, filters and URL rewrites effective. Guard: every git in the project's repository runs through the
 * plane's hardened checkout git (direct-chat-git.ts runHardenedMainGit / runHardenedMainGitAsync over teardown-git.ts
 * viewedGitSync and checkoutGit): a view whose config is read once and refused when it includes a file or names a
 * command or a rewrite, bound to the project's record.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cloneIsolatedRepo, cloneIsolatedRepoAsync, fetchTrustedSnapshotIntoMainRepo, runHardenedMainGit, runHardenedMainGitAsync, type TrustedCloneBinding } from "../../src/direct-chat-git.js";

let dir: string;
let repo: string;
let markers: string;
let stateRoot: string;

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
const git = (cwd: string, args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

function planted(name: string): string {
  const path = join(dir, `${name}.sh`);
  writeFileSync(path, `#!/bin/sh\ncat\necho ran > '${join(markers, name)}'\n`);
  chmodSync(path, 0o755);
  return path;
}

function chatClone(name: string): TrustedCloneBinding {
  const clonePath = join(stateRoot, "direct-chat", "clones", name);
  const gitDir = join(stateRoot, "direct-chat", "gitdirs", name);
  const made = cloneIsolatedRepo({ stateRoot, repo, clonePath, gitDir, branch: `chat/${name}` });
  return { stateRoot, clonePath, gitDir: made.gitDir, configSha256: made.configSha256 };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-dc-main-git-")));
  markers = join(dir, "markers");
  mkdirSync(markers);
  stateRoot = join(dir, "state");
  repo = join(dir, "project");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "app.txt"), "one\n");
  git(repo, ["add", "app.txt"]);
  git(repo, ["commit", "-m", "initial"]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("attack: the project's own git config running a program during Direct Chat", () => {
  test("a clean filter behind .gitattributes never runs on status, diff or ls-files; each is refused", async () => {
    git(repo, ["config", "filter.evil.clean", planted("clean")]);
    writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(repo, "app.txt"), "two\n");
    for (const args of [["status", "--porcelain"], ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"], ["ls-files", "--others", "--exclude-standard"]]) {
      expect(() => runHardenedMainGit(args, repo), args.join(" ")).toThrow(/filter\.evil\.clean/);
    }
    await expect(runHardenedMainGitAsync(["status", "--porcelain"], repo)).rejects.toThrow(/filter\.evil\.clean/);
    expect(readdirSync(markers)).toEqual([]);
  });

  test("an include bringing a filter in from another file is refused before git reads it", async () => {
    const included = join(dir, "included.gitconfig");
    writeFileSync(included, `[filter "evil"]\n\tclean = ${planted("included-clean")}\n`);
    git(repo, ["config", "include.path", included]);
    writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(repo, "app.txt"), "two\n");
    expect(() => runHardenedMainGit(["status", "--porcelain"], repo)).toThrow(/includes another file/);
    await expect(runHardenedMainGitAsync(["rev-parse", "HEAD"], repo)).rejects.toThrow(/includes another file/);
    // Opening a chat (its clone starts from the project's HEAD) is refused too, before anything is cloned.
    await expect(cloneIsolatedRepoAsync({ stateRoot, repo, clonePath: join(stateRoot, "direct-chat", "clones", "c1"), gitDir: join(stateRoot, "direct-chat", "gitdirs", "c1"), branch: "chat/c1" }))
      .rejects.toThrow(/includes another file/);
    expect(existsSync(join(stateRoot, "direct-chat", "clones", "c1"))).toBe(false);
    expect(readdirSync(markers)).toEqual([]);
  });

  test("a URL rewrite can't point the chat's import fetch at another repository", () => {
    const binding = chatClone("c2");
    writeFileSync(join(binding.clonePath, "app.txt"), "from the chat\n");
    git(binding.clonePath, ["--git-dir", binding.gitDir, "--work-tree", binding.clonePath, "commit", "-am", "chat work"]);
    const candidate = git(binding.clonePath, ["--git-dir", binding.gitDir, "rev-parse", "HEAD"]);
    // Elsewhere: a repository with a commit of the attacker's under the same ref name.
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    git(elsewhere, ["init", "-b", "main"]);
    writeFileSync(join(elsewhere, "evil.txt"), "evil\n");
    git(elsewhere, ["add", "evil.txt"]);
    git(elsewhere, ["commit", "-m", "evil"]);
    git(repo, ["config", `url.${elsewhere}/.git.insteadOf`, realpathSync(binding.gitDir)]);
    expect(() => fetchTrustedSnapshotIntoMainRepo({ binding, repo, candidateSha: candidate, targetRef: "refs/heads/chat-import" })).toThrow(/url\./);
    expect(() => git(repo, ["rev-parse", "--verify", "refs/heads/chat-import"])).toThrow();
  });

  test("with a clean config the chat's import still lands, and only as the named ref", () => {
    const binding = chatClone("c3");
    writeFileSync(join(binding.clonePath, "app.txt"), "from the chat\n");
    git(binding.clonePath, ["--git-dir", binding.gitDir, "--work-tree", binding.clonePath, "commit", "-am", "chat work"]);
    const candidate = git(binding.clonePath, ["--git-dir", binding.gitDir, "rev-parse", "HEAD"]);
    fetchTrustedSnapshotIntoMainRepo({ binding, repo, candidateSha: candidate, targetRef: "refs/heads/chat-import" });
    expect(git(repo, ["rev-parse", "refs/heads/chat-import"])).toBe(candidate);
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    runHardenedMainGit(["branch", "-D", "chat-import"], repo, { write: true });
    expect(() => git(repo, ["rev-parse", "--verify", "refs/heads/chat-import"])).toThrow();
    // A write that could touch HEAD, the index or an editor is never run as a synchronous write.
    expect(() => runHardenedMainGit(["checkout", "main"], repo, { write: true })).toThrow(/can't run as a synchronous write/);
    expect(() => runHardenedMainGit(["branch", "--edit-description"], repo, { write: true })).toThrow(/can't run as a synchronous write/);
  });
});
