/**
 * Attack: a filter driver whose name a pattern doesn't see (Codex review of e48e9d8d). Git accepts `[filter ""]` and
 * selects it for the attribute `filter=`, and accepts names with any character (U+2028, dots, spaces); a name pattern
 * of `.+` let `filter..clean` and friends through the config check, and the plane's own `add` ran the command. The
 * check is now structural (section, any subsection, variable). git-lfs's own filters, exactly as `git lfs install
 * --local` writes them, keep working.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../../src/exec.js";
import { checkoutGit, commandSetting, refusal, teardownGit } from "../../src/teardown-git.js";

let root: string, repo: string, marker: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { env, stdio: "pipe", encoding: "utf8" });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-filternames-")));
  repo = join(root, "checkout"); marker = join(root, "ran");
  execFileSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "one");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A filter section named `name` (written as git's own config file syntax), and attributes selecting it. */
const plantNamed = (name: string, attribute: string) => {
  writeFileSync(join(repo, ".git", "config"), `${execFileSync("cat", [join(repo, ".git", "config")], { encoding: "utf8" })}[filter "${name}"]\n\tclean = "sh -c 'touch ${marker}; cat'"\n\tsmudge = "sh -c 'touch ${marker}; cat'"\n`);
  writeFileSync(join(repo, ".gitattributes"), `* filter=${attribute}\n`);
  writeFileSync(join(repo, "a.txt"), "two\n");
};
const NAMES: [label: string, name: string, attribute: string][] = [
  ["the empty name", "", ""],
  ["a name with U+2028", "x y", "x y"],
];

describe("attack: a filter with an empty or odd name", () => {
  for (const [label, name, attribute] of NAMES) {
    test(`control, ${label}: git runs it`, () => {
      plantNamed(name, attribute);
      git("add", "-A");
      expect(existsSync(marker)).toBe(true);
    });

    test(`${label}: the plane's build git and teardown refuse, nothing runs`, async () => {
      plantNamed(name, attribute);
      const built = await checkoutGit(run)("git", ["add", "-A"], { cwd: repo, timeoutMs: 60_000 });
      expect(refusal(built), built.stderr).toContain("filter.");
      const torn = await teardownGit()(repo, ["status", "--porcelain"]);
      expect(refusal(torn), torn.stderr).toContain("filter.");
      expect(existsSync(marker)).toBe(false);
    });
  }

  const listing = (key: string, value: string) => `local\0${key}\n${value}\0`;
  test.each([
    "filter..clean", "filter..smudge", "filter..process", "FILTER. .CLEAN", "filter.a.b.clean", "filter. .process",
    "diff..textconv", "diff..command", "diff.x.y.textconv", "merge..driver", "trailer..command", "trailer..cmd", "credential..helper",
    "credential.https://x.y.helper", "submodule..update", "gpg..program", "gpg.ssh.defaultKeyCommand", "remote..uploadpack", "remote..receivepack", "remote..vcs",
    "include.path", "includeIf..path", "includeif.gitdir:/a.b/.path", "pager.anything", "difftool..cmd", "mergetool..cmd", "interactive.diffFilter",
    "lfs..standalonetransferagent", "lfs.extension..clean", "lfs.customtransfer..path",
  ])("%s is refused, whatever its subsection", key => {
    expect(commandSetting(listing(key, "sh -c x"))).toBe(key.toLowerCase());
  });
});

describe("git-lfs as `git lfs install --local` writes it keeps working", () => {
  const LOCAL_LFS: [string, string][] = [
    ["filter.lfs.clean", "git-lfs clean -- %f"], ["filter.lfs.smudge", "git-lfs smudge -- %f"], ["filter.lfs.process", "git-lfs filter-process"], ["filter.lfs.required", "true"],
  ];
  test("exact values in the repository's own config are not refused, by the build's git or teardown", async () => {
    for (const [key, value] of LOCAL_LFS) git("config", key, value);
    const listed = git("config", "--list", "--show-scope", "-z");
    expect(commandSetting(listed, { lfsChecked: true })).toBeNull();
    // Only beside a checked .lfsconfig: a caller that doesn't refuse git-lfs extensions gets no exemption.
    expect(commandSetting(listed)).toBe("filter.lfs.clean");
    const head = await checkoutGit(run)("git", ["rev-parse", "HEAD"], { cwd: repo, timeoutMs: 60_000 });
    expect(head.code, head.stderr).toBe(0);
    const status = await teardownGit()(repo, ["status", "--porcelain"]);
    expect(status.code, status.stderr).toBe(0);
  });

  test.each([
    ["filter.lfs.clean", "git-lfs clean -- %f; touch x"], ["filter.lfs.smudge", "git-lfs smudge %f"], ["filter.lfs.process", "git-lfs filter-process "],
    ["filter.LFS.clean", "git-lfs clean -- %f"], ["filter.lfs2.clean", "git-lfs clean -- %f"],
  ])("a near miss (%s = %s) is still refused", (key, value) => {
    expect(commandSetting(`local\0${key}\n${value}\0`, { lfsChecked: true })).toBe(key.toLowerCase());
  });
});

describe("the git-lfs exemption stands only beside a checked .lfsconfig", () => {
  test("teardown refuses a .lfsconfig naming a git-lfs extension, in the folder and in a removal's target", async () => {
    for (const [key, value] of [["filter.lfs.clean", "git-lfs clean -- %f"], ["filter.lfs.smudge", "git-lfs smudge -- %f"], ["filter.lfs.process", "git-lfs filter-process"]]) git("config", key, value);
    const target = join(root, "target");
    git("worktree", "add", "-q", "--detach", target);
    writeFileSync(join(target, ".lfsconfig"), `[lfs "extension.evil"]\n\tclean = sh -c 'touch ${marker}'\n`);
    const removed = await teardownGit()(repo, ["worktree", "remove", "--force", target]);
    expect(refusal(removed), removed.stderr).toContain(".lfsconfig");
    expect(existsSync(target)).toBe(true);
    writeFileSync(join(repo, ".lfsconfig"), `[lfs "extension.evil"]\n\tclean = sh -c 'touch ${marker}'\n`);
    expect(refusal(await teardownGit()(repo, ["status", "--porcelain"]))).toContain(".lfsconfig");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("the classifier fails closed", () => {
  test.each(["constructor.x", "__proto__.x", "tostring.y", "hasownproperty.clean", "filter.__proto__.x", "valueof", "__proto__"])("%s is read as a plain key, never a crash", key => {
    expect(() => commandSetting(`local\0${key}\nv\0`, { lfsChecked: true })).not.toThrow();
    // Not a section the plane knows: refused (deny by default), as a value, never a throw.
    expect(commandSetting(`local\0${key}\nv\0`, { lfsChecked: true })).toBe(key.toLowerCase());
  });
  test("a listing it can't read names a setting (a refusal), never nothing", () => {
    expect(commandSetting(undefined as unknown as string)).not.toBeNull();
  });
});
