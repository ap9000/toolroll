/**
 * A build's checkout as the worktree pool hands one over: a real linked worktree of a real repository, with the
 * pool's record naming that repository. A fenced launch trusts only that record and the repository's own worktree
 * registry for its Git exemptions (trustedWorktreeBinding), so a plain folder or a stand-alone clone is refused as a
 * changed Git pointer. Tests that launch through the gateway with a database file use this instead.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../src/store.js";

const IDENTITY = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };

export function fixtureGit(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository with one commit at `repo`, unless one is already there. */
export function fixtureRepository(repo: string): string {
  if (!existsSync(join(repo, ".git"))) {
    mkdirSync(repo, { recursive: true });
    fixtureGit(repo, "init", "-q", "-b", "main");
    fixtureGit(repo, "commit", "--allow-empty", "-qm", "fixture");
  }
  return repo;
}

/** Adds `worktree` (absent or empty) as a linked checkout of `repo` on a new branch and, given a store, records it. */
export function boundCheckout(store: Store | null, repo: string, worktree: string, branch = "task"): string {
  fixtureRepository(repo);
  fixtureGit(repo, "worktree", "add", "-q", "-b", branch, worktree);
  store?.saveWorktree({ path: worktree, repo, branch, runner: null, taskRef: null, createdAt: new Date(0).toISOString(), leasedAt: null, releasedAt: null, verified: true });
  return worktree;
}
