/**
 * Attack: a filter driver, an fsmonitor, an include and hooks planted in the repository between the plane's config
 * inspection and its own write (follow-up to the security review of 0.9.75). The builder stages and commits a build's
 * work with checkoutGit "build", and teardown checks out, inspects and removes checkouts with teardownGit; both used
 * to inspect the checkout's config and then run git, which read the config and the common directory's
 * info/attributes again. A process of the agent's that outlived its turn (containment is observational on macOS,
 * src/containment.ts) or a sibling build sharing the repository could plant in that window, and git would run its
 * command on the host. Every write now runs against a view of the repository whose config and info are the copies
 * that were inspected, while its refs, objects and logs are the repository's own: the plant is never read, and the
 * commit, the checkout and the removal still land.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../../src/exec.js";
import { checkoutGit, hardenedGit, refusal, teardownGit } from "../../src/teardown-git.js";
import type { Runner } from "../../src/worktree.js";

let root: string, main: string, linked: string, marker: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
/** The operator's identity, where a real one keeps it (~/.gitconfig): the plane's git carries it (carriedSettings). This
 * file's home is a fresh empty one (test/setup-state.ts), and git off macOS can't guess an identity from the host. */
writeFileSync(join(homedir(), ".gitconfig"), "[user]\n\tname = t\n\temail = t@t\n");
/** The test's own git: hooks off, so its setup and cleanup never fire what it plants. */
const git = (at: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", at, ...args], { env, stdio: "pipe", encoding: "utf8" });
const common = () => join(main, ".git");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-gitwrite-")));
  main = join(root, "main"); linked = join(root, "linked"); marker = join(root, "ran");
  execFileSync("git", ["init", "-q", "-b", "main", main], { env });
  writeFileSync(join(main, "a.txt"), "one\n");
  git(main, "add", "a.txt");
  git(main, "commit", "-qm", "one");
  git(main, "branch", "packed");
  // Refs packed, so a write that rewrites packed-refs is exercised too.
  git(main, "pack-refs", "--all");
  git(main, "worktree", "add", "-q", "-b", "task", linked);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The plant: every command-running road git reads from the repository as it starts. */
const plant = () => {
  const cmd = `sh -c 'touch ${marker}; cat'`;
  git(main, "config", "filter.evil.clean", cmd);
  git(main, "config", "filter.evil.smudge", cmd);
  git(main, "config", "filter.evil.process", `sh -c 'touch ${marker}'`);
  git(main, "config", "filter.evil.required", "true");
  git(main, "config", "core.fsmonitor", `sh -c 'touch ${marker}'`);
  const included = join(root, "included.config");
  writeFileSync(included, `[filter "inc"]\n\tclean = "${cmd}"\n\tsmudge = "${cmd}"\n[core]\n\tfsmonitor = "sh -c 'touch ${marker}'"\n`);
  git(main, "config", "include.path", included);
  mkdirSync(join(common(), "info"), { recursive: true });
  writeFileSync(join(common(), "info", "attributes"), "* filter=evil\n*.txt filter=inc\n");
  const hooks = join(root, "hooks");
  mkdirSync(hooks, { recursive: true });
  mkdirSync(join(common(), "hooks"), { recursive: true });
  for (const hook of ["pre-commit", "post-commit", "post-checkout", "post-index-change", "reference-transaction", "pre-auto-gc"]) {
    for (const folder of [hooks, join(common(), "hooks")]) { writeFileSync(join(folder, hook), `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(join(folder, hook), 0o755); }
  }
  git(main, "config", "core.hooksPath", hooks);
};
/** The same filter, in a linked worktree's config.worktree (worktreeConfig on when inspected). */
const plantWorktreeConfig = () => {
  writeFileSync(join(common(), "worktrees", "linked", "config.worktree"), `[filter "evil"]\n\tclean = "sh -c 'touch ${marker}; cat'"\n\tsmudge = "sh -c 'touch ${marker}; cat'"\n[core]\n\tfsmonitor = "sh -c 'touch ${marker}'"\n`);
  mkdirSync(join(common(), "info"), { recursive: true });
  writeFileSync(join(common(), "info", "attributes"), "* filter=evil\n");
};
const unplant = () => {
  for (const key of ["filter.evil.clean", "filter.evil.smudge", "filter.evil.process", "filter.evil.required", "core.fsmonitor", "include.path", "core.hooksPath"]) {
    try { git(main, "config", "--unset-all", key); } catch { /* not set */ }
  }
  rmSync(join(common(), "info", "attributes"), { force: true });
  rmSync(join(common(), "hooks"), { recursive: true, force: true });
  rmSync(join(common(), "worktrees", "linked", "config.worktree"), { force: true });
};

/** A runner that plants the moment `when` says the inspection is over, once per armed command. */
function racing(when: (args: readonly string[]) => boolean, how: () => void) {
  const state = { armed: false, planted: 0 };
  const inner: Runner = async (file, args, options) => {
    const result = await run(file, args, options);
    if (state.armed && file === "git" && when(args)) { state.armed = false; how(); state.planted++; }
    return result;
  };
  return { inner, state };
}
const inspected = (args: readonly string[]) => args.includes("config") && args.includes("--show-scope");

describe("attack: a command planted between the inspection and the plane's own write", () => {
  test("control: the plant runs its command under the old hardening (live config and info/attributes)", () => {
    writeFileSync(join(linked, "a.txt"), "two\n");
    plant();
    try { execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "add", "-A"], { cwd: linked, env, stdio: "pipe" }); } catch { /* the planted process driver speaks no protocol */ }
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    unplant();
    git(main, "config", "extensions.worktreeConfig", "true");
    plantWorktreeConfig();
    writeFileSync(join(linked, "a.txt"), "three\n");
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "add", "-A"], { cwd: linked, env, stdio: "pipe" });
    expect(existsSync(marker)).toBe(true);
  });

  for (const [name, at, how, before] of [
    ["a plain checkout", () => main, plant, () => {}],
    ["a linked worktree", () => linked, plant, () => {}],
    ["a linked worktree's config.worktree", () => linked, plantWorktreeConfig, () => git(main, "config", "extensions.worktreeConfig", "true")],
  ] as const) {
    test(`${name}, build (checkoutGit): add, commit, unstage and reset run nothing planted, and the commit lands`, async () => {
      before();
      const { inner, state } = racing(inspected, how);
      const build = checkoutGit(inner);
      const step = async (args: string[]) => {
        state.armed = true;
        const result = await build("git", args, { cwd: at(), timeoutMs: 60_000 });
        expect(state.planted > 0 && !state.armed, "the plant happened after the inspection").toBe(true);
        unplant();
        expect(existsSync(marker), `${name}: git ${args.join(" ")}`).toBe(false);
        expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(0);
        return result;
      };
      const branch = at() === main ? "main" : "task";
      const before_ = git(main, "rev-parse", branch).trim();
      writeFileSync(join(at(), "a.txt"), "two\n");
      writeFileSync(join(at(), "b.txt"), "new\n");
      mkdirSync(join(at(), "evidence"), { recursive: true });
      writeFileSync(join(at(), "evidence", "shot.png"), "png\n");
      await step(["add", "-A", "--", "."]);
      await step(["rm", "--cached", "--quiet", "--", ":(literal)evidence/shot.png"]);
      expect((await step(["--no-optional-locks", "diff", "--cached", "--name-only", "--no-renames", "-z"])).stdout.split("\0").filter(Boolean).sort()).toEqual(["a.txt", "b.txt"]);
      await step(["commit", "--no-verify", "-m", "build"]);
      // The commit is the repository's own: its branch moved, with its reflog, and the packed branch is intact.
      const after = git(main, "rev-parse", branch).trim();
      expect(after).not.toBe(before_);
      expect(git(main, "show", `${after}:a.txt`)).toBe("two\n");
      expect(git(main, "log", "-g", "--format=%gs", "-1", branch)).toContain("build");
      expect(git(main, "rev-parse", "packed").trim()).toBe(before_);
      // A reset of the tree (smudge on checkout) through the view.
      writeFileSync(join(at(), "a.txt"), "scribbled\n");
      await step(["--no-optional-locks", "read-tree", "-u", "--reset", after]);
      expect(readFileSync(join(at(), "a.txt"), "utf8")).toBe("two\n");
      git(main, "fsck", "--no-progress");
      expect(existsSync(marker)).toBe(false);
    });
  }

  test("teardown (teardownGit): checkout, status, ref deletion and removal run nothing planted, and still do their work", async () => {
    // After the last inspection (the target's index preflight, or the config scan where there is none).
    let armedPreflight = false;
    const { inner, state } = racing(args => args.includes("ls-files") || (inspected(args) && !armedPreflight), plant);
    const teardown = teardownGit(inner);
    const step = async (cwd: string, args: string[], preflight: boolean) => {
      armedPreflight = preflight;
      state.armed = true;
      const result = await teardown(cwd, args);
      expect(state.planted > 0 && !state.armed, "the plant happened after the inspection").toBe(true);
      unplant();
      expect(existsSync(marker), `teardown git ${args.join(" ")}`).toBe(false);
      expect(refusal(result), `${args.join(" ")}`).toBeNull();
      expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      return result;
    };
    writeFileSync(join(linked, "a.txt"), "scribbled\n");
    await step(linked, ["status", "--porcelain"], true);
    await step(linked, ["checkout", "--", "."], true);
    expect(readFileSync(join(linked, "a.txt"), "utf8")).toBe("one\n");
    // The main worktree is named as itself, never as the view.
    const listed = await step(main, ["worktree", "list", "--porcelain"], false);
    expect(listed.stdout).toContain(`worktree ${main}\n`);
    expect(listed.stdout).toContain(`worktree ${linked}\n`);
    await step(main, ["worktree", "remove", "--force", linked], true);
    expect(existsSync(linked)).toBe(false);
    // Deleting a packed branch rewrites packed-refs: through the view, in the repository's own file.
    await step(main, ["branch", "-D", "task"], false);
    await step(main, ["update-ref", "-d", "refs/heads/packed"], false);
    expect(git(main, "branch", "--list").trim()).toBe("* main");
    expect(readFileSync(join(common(), "packed-refs"), "utf8")).not.toContain("refs/heads/packed");
    git(main, "fsck", "--no-progress");
    expect(existsSync(marker)).toBe(false);
  });

  test("`git -C <repo>` callers (follow-up checks, batch checks, flow steps): worktree add, merge and remove run nothing planted", async () => {
    // A build's commit, with attributes naming the filter, checked out in a scratch worktree of the project's repository.
    writeFileSync(join(linked, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(linked, "c.txt"), "three\n");
    git(linked, "add", "-A");
    git(linked, "commit", "-qm", "build");
    const head = git(linked, "rev-parse", "HEAD").trim();
    const side = join(root, "side");
    git(main, "worktree", "add", "-q", "-b", "side", side, "packed");
    writeFileSync(join(side, "d.txt"), "side\n");
    git(side, "add", "d.txt");
    git(side, "commit", "-qm", "side");
    const { inner, state } = racing(inspected, plant);
    const scratch = join(root, "scratch");
    const step = async (args: string[]) => {
      state.armed = true;
      const result = await hardenedGit(inner)("git", args, { timeoutMs: 60_000 });
      expect(state.planted > 0 && !state.armed, "the plant happened after the inspection").toBe(true);
      unplant();
      expect(existsSync(marker), `git ${args.join(" ")}`).toBe(false);
      expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(0);
    };
    await step(["-C", main, "worktree", "add", "--detach", scratch, head]);
    expect(readFileSync(join(scratch, "c.txt"), "utf8")).toBe("three\n");
    await step(["-C", scratch, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "--no-edit", "-m", "batch", "side"]);
    expect(readFileSync(join(scratch, "d.txt"), "utf8")).toBe("side\n");
    await step(["-C", main, "worktree", "remove", "--force", scratch]);
    expect(existsSync(scratch)).toBe(false);
    // Planted before the inspection: refused outright.
    plant();
    const refused = await hardenedGit(run)("git", ["-C", main, "worktree", "add", "--detach", scratch, head], { timeoutMs: 60_000 });
    expect(refusal(refused)).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
  });
});
