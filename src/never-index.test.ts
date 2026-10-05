/**
 * Spotlight leaves Toolroll's churn alone: the checkouts folder and each project's folder in it hold
 * `.metadata_never_index`, never a checkout itself (a build's `git add -A` would commit it). A marker that can't be
 * written is only that.
 */
import { afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import { run } from "./exec.js";
import { WorktreePool } from "./worktree.js";
import { markNeverIndex, NEVER_INDEX } from "./never-index.js";

let dir = "";
afterEach(() => { if (dir !== "") rmSync(dir, { recursive: true, force: true }); });

test("a new checkout's pool and project folders are marked; the checkout itself stays clean", async () => {
  dir = mkdtempSync(join(tmpdir(), "so-never-index-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) await run("git", args, { cwd: repo });
  writeFileSync(join(repo, "README.md"), "hi\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-qm", "first"], { cwd: repo });
  const store = openStore(join(dir, "orders.db"));
  try {
    register(store, { name: "builder-1", host: "test", now: new Date() });
    const pool = new WorktreePool(store, { root: join(dir, "worktrees") });
    const leased = await pool.lease({ repo, branch: "toolroll/marked", base: "main", runner: "builder-1", now: new Date() });
    if (!leased.ok) throw new Error(leased.message);
    expect(existsSync(join(dir, "worktrees", NEVER_INDEX))).toBe(true);
    expect(existsSync(join(dirname(leased.worktree.path), NEVER_INDEX))).toBe(true);
    expect(existsSync(join(leased.worktree.path, NEVER_INDEX))).toBe(false);
    expect((await run("git", ["status", "--porcelain"], { cwd: leased.worktree.path })).stdout).not.toContain(NEVER_INDEX);
  } finally { store.close(); }
});

test("a marker that can't be written is only reported", () => {
  expect(markNeverIndex(join(tmpdir(), "so-never-index-missing", "nowhere"))).toBe(false);
});
