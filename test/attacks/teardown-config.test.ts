/**
 * Attack: plant a command in the shared repository a build can write to, and wait for Toolroll's own teardown to run
 * it: hooks (.git/hooks or a core.hooksPath folder), core.fsmonitor, filter.<x>.clean/smudge/process, core.pager,
 * diff.external, core.sshCommand, or an include (include.path, includeIf.<cond>.path) bringing one in from a file
 * nobody read; in the project's config, the checkout's own config.worktree, or a nested repository inside the
 * checkout. Guard: teardownGit (src/teardown-git.ts), the one way landed cleanup, WorktreePool.prune/discard and
 * checkout cleanup run git: hooks off on every command, and a command-running key, an include or a nested repository
 * refuses the command before it runs.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openStore } from "../../src/store.js";
import { register } from "../../src/runner.js";
import { refusal, teardownGit } from "../../src/teardown-git.js";
import { WorktreePool } from "../../src/worktree.js";
import { git, GIT_ENV, marker, q, repository, useScratch, write } from "./harness.js";

/** A shell script that leaves `ran` behind when anything runs it (and passes stdin through, as a filter would). */
function planted(path: string, ran: string): string {
  write(path, `#!/bin/sh\ntouch ${q(ran)}\ncat\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Plain git, as a build's attack would see it run by anything unhardened; never throws. */
const plain = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });

describe("attack: commands planted in git config, hooks and nested repositories during teardown", () => {
  const scratch = useScratch("teardown");
  const setup = () => {
    const dir = scratch();
    const ran = join(dir, marker("ran"));
    const repo = repository(join(dir, "repo"), { "README.md": "fixture\n", ".gitattributes": "* filter=x\n" });
    const target = join(dir, "pool", "task");
    git(repo, "worktree", "add", "-qb", "task", target);
    // A same-size edit: git has to read the content (through a clean filter) to know it changed.
    write(join(target, "README.md"), "edited!\n");
    const script = planted(join(dir, "planted.sh"), ran);
    const included = write(join(dir, "included.config"), `[core]\n\tfsmonitor = ${script}\n[filter "x"]\n\tclean = ${script}\n`);
    return { dir, ran, repo, target, script, included };
  };
  type Setup = ReturnType<typeof setup>;

  const KEYS: [key: string, value: (at: Setup) => string][] = [
    ["core.fsmonitor", at => at.script],
    ["filter.x.clean", at => at.script],
    ["filter.x.smudge", at => at.script],
    ["filter.x.process", at => at.script],
    ["core.pager", at => `touch ${q(at.ran)}`],
    ["diff.external", at => at.script],
    ["core.sshCommand", at => `touch ${q(at.ran)}`],
    ["include.path", at => at.included],
    ["includeIf.gitdir:/.path", at => at.included],
  ];

  /** Every teardown step a cleanup takes on the checkout must be refused, run nothing and leave it in place. */
  const expectRefused = async (at: Setup, key: string) => {
    const teardown = teardownGit();
    for (const [cwd, args] of [
      [at.target, ["status", "--porcelain"]], [at.target, ["diff", "--stat"]],
      [at.repo, ["worktree", "remove", "--force", at.target]],
    ] as const) {
      const why = refusal(await teardown(cwd, args));
      expect(why, args.join(" ")).toContain(key.toLowerCase());
      expect(existsSync(at.ran), args.join(" ")).toBe(false);
    }
    expect(existsSync(join(at.target, "README.md"))).toBe(true);
  };

  test("the planted fixture is live: plain git runs an fsmonitor, a clean filter and an included command", () => {
    for (const [key, value] of [["core.fsmonitor", "script"], ["filter.x.clean", "script"], ["include.path", "included"]] as const) {
      const at = setup();
      git(at.repo, "config", key, at[value]);
      plain(at.target, "status", "--porcelain");
      expect(existsSync(at.ran), key).toBe(true);
      rmSync(at.dir, { recursive: true, force: true });
      mkdirSync(at.dir);
    }
  });

  test.each(KEYS)("%s in the project's config: status, diff, remove and branch -D are refused, nothing runs", async (key, value) => {
    const at = setup();
    git(at.repo, "config", key, value(at));
    await expectRefused(at, key);
    expect(refusal(await teardownGit()(at.repo, ["branch", "-D", "task"]))).toContain(key.toLowerCase());
    expect(git(at.repo, "branch", "--list", "task")).not.toBe("");
    expect(existsSync(at.ran)).toBe(false);
  });

  test.each(KEYS)("%s in the checkout's own config.worktree: removal from the project is refused, nothing runs", async (key, value) => {
    const at = setup();
    git(at.repo, "config", "extensions.worktreeConfig", "true");
    git(at.target, "config", "--worktree", key, value(at));
    await expectRefused(at, key);
  });

  test("planted hooks in .git/hooks and a core.hooksPath folder never run; the legitimate teardown still finishes", async () => {
    const at = setup();
    git(at.target, "checkout", "--", "README.md");
    const hooks = ["post-checkout", "reference-transaction", "pre-auto-gc", "post-index-change", "pre-commit", "post-commit", "post-rewrite"];
    const folder = join(at.dir, "planted-hooks");
    for (const hook of hooks) { planted(join(at.repo, ".git", "hooks", hook), at.ran); planted(join(folder, hook), at.ran); }
    // core.hooksPath isn't refused: TEARDOWN_FLAGS override it with /dev/null on every command.
    git(at.repo, "config", "core.hooksPath", folder);
    // Live as planted: plain git runs them.
    plain(at.repo, "update-ref", "refs/probe/live", "HEAD");
    expect(existsSync(at.ran)).toBe(true);
    rmSync(at.ran);
    git(at.repo, "-c", "core.hooksPath=/dev/null", "update-ref", "-d", "refs/probe/live");

    const teardown = teardownGit();
    const status = await teardown(at.target, ["status", "--porcelain"]);
    expect(status.code, status.stderr).toBe(0);
    const removed = await teardown(at.repo, ["worktree", "remove", "--force", at.target]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(at.target)).toBe(false);
    const branch = await teardown(at.repo, ["branch", "-D", "task"]);
    expect(branch.code, branch.stderr).toBe(0);
    expect(git(at.repo, "branch", "--list", "task")).toBe("");
    expect(existsSync(at.ran)).toBe(false);
  });

  test.each(["untracked", "gitfile", "bare"] as const)("a nested %s repository whose own config sets a clean filter and an fsmonitor is refused", async kind => {
    const at = setup();
    const nested = join(at.target, "vendor", "nested");
    const configure = (gitDir: string) => {
      git(at.dir, "--git-dir", gitDir, "config", "filter.x.clean", at.script);
      git(at.dir, "--git-dir", gitDir, "config", "core.fsmonitor", at.script);
    };
    if (kind === "untracked") { repository(nested, { "payload": "before\n", ".gitattributes": "* filter=x\n" }); configure(join(nested, ".git")); write(join(nested, "payload"), "after!\n"); }
    if (kind === "gitfile") {
      // .git as a pointer file to a gitdir outside the checkout.
      const outside = join(at.dir, "outside.git");
      git(at.dir, "init", "-q", "--bare", outside);
      write(join(nested, ".git"), `gitdir: ${outside}\n`);
      git(at.dir, "--git-dir", outside, "config", "core.bare", "false");
      configure(outside);
    }
    if (kind === "bare") { git(at.dir, "init", "-q", "--bare", nested); configure(nested); }
    const teardown = teardownGit();
    expect(refusal(await teardown(at.target, ["status", "--porcelain"]))).toContain("nested repository");
    expect(refusal(await teardown(at.repo, ["worktree", "remove", "--force", at.target]))).toContain("nested repository");
    expect(existsSync(at.ran)).toBe(false);
    expect(existsSync(nested)).toBe(true);
  });

  test("a staged gitlink to a nested repository with a planted clean filter is refused, with or without the repository", async () => {
    const at = setup();
    const nested = repository(join(at.target, "nested"), { "payload": "before\n", ".gitattributes": "payload filter=x\n" });
    git(at.target, "update-index", "--add", "--cacheinfo", `160000,${git(nested, "rev-parse", "HEAD")},nested`);
    git(nested, "config", "filter.x.clean", at.script);
    write(join(nested, "payload"), "after!\n");
    const teardown = teardownGit();
    expect(refusal(await teardown(at.target, ["status", "--porcelain"]))).toContain("nested repository");
    expect(refusal(await teardown(at.repo, ["worktree", "remove", "--force", at.target]))).toContain("nested repository");
    // The repository gone, the index entry alone still refuses.
    rmSync(nested, { recursive: true });
    expect(refusal(await teardown(at.target, ["status", "--porcelain"]))).toContain("gitlink");
    expect(refusal(await teardown(at.repo, ["worktree", "remove", "--force", at.target]))).toContain("gitlink");
    expect(existsSync(at.ran)).toBe(false);
    expect(existsSync(at.target)).toBe(true);
  });

  test("legitimate: ordinary config and a boolean fsmonitor let status, removal and branch -D run", async () => {
    const at = setup();
    git(at.target, "checkout", "--", "README.md");
    git(at.repo, "config", "user.name", "Someone");
    git(at.repo, "config", "core.fsmonitor", "false");
    git(at.repo, "config", "remote.origin.url", "git@example.invalid:app.git");
    git(at.repo, "config", "filter.x.required", "false");
    const teardown = teardownGit();
    const status = await teardown(at.target, ["status", "--porcelain"]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toBe("");
    const removed = await teardown(at.repo, ["worktree", "remove", "--force", at.target]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(at.target)).toBe(false);
    const branch = await teardown(at.repo, ["branch", "-D", "task"]);
    expect(branch.code, branch.stderr).toBe(0);
    expect(git(at.repo, "branch", "--list", "task")).toBe("");
  });

  test("end to end: WorktreePool.prune keeps a checkout while the project's config sets an fsmonitor, then removes it", async () => {
    const at = setup();
    const store = openStore(":memory:");
    try {
      const now = new Date("2026-10-13T00:00:00.000Z");
      register(store, { name: "builder-1", host: "test", now });
      const pool = new WorktreePool(store, { root: join(at.dir, "leased") });
      const made = await pool.lease({ repo: at.repo, branch: "toolroll/disposable", base: "main", runner: "builder-1", now });
      if (!made.ok) throw new Error(made.message);
      await pool.release(made.worktree.path, now);
      git(at.repo, "config", "core.fsmonitor", at.script);
      const kept = await pool.prune(store.listWorktrees(), () => true);
      expect(kept.removed).toEqual([]);
      expect(kept.kept.map(one => one.path)).toEqual([made.worktree.path]);
      expect(existsSync(made.worktree.path)).toBe(true);
      expect(existsSync(at.ran)).toBe(false);
      // Taken out, the same prune removes it, still running nothing.
      git(at.repo, "config", "--unset", "core.fsmonitor");
      expect((await pool.prune(store.listWorktrees(), () => true)).removed).toHaveLength(1);
      expect(existsSync(made.worktree.path)).toBe(false);
      expect(existsSync(at.ran)).toBe(false);
    } finally { store.close(); }
  });
});
