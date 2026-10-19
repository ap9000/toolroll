/**
 * A lease's git runs in Toolroll's own process, outside every fence, in a shared repository any build can write to
 * (docs/plans/acp-adapter.md, v6 review): nothing the repository itself holds may run there — not a hook a build
 * planted, not a command its config names. The user's own git setup still applies.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { WorktreePool } from "./worktree.js";

const T0 = new Date("2026-10-19T12:00:00.000Z");
let dir: string;
let repo: string;
let store: Store;
let pool: WorktreePool;

const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "ignore" });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-hooks-")));
  repo = join(dir, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  store = openStore(":memory:");
  register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => "tok" });
  pool = new WorktreePool(store, { root: join(dir, "pool") });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("a hook a build planted in the shared repository never runs when a checkout is leased", async () => {
  const marker = join(dir, "hook-ran");
  for (const hook of ["post-checkout", "reference-transaction"]) {
    writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(repo, ".git", "hooks", hook), 0o755);
  }
  const leased = await pool.lease({ repo, branch: "toolroll/t-1", base: "main", runner: "builder-1", now: T0 });
  if (!leased.ok) throw new Error(JSON.stringify(leased));
  expect(existsSync(marker)).toBe(false);
});

test("a repository config that names a command refuses the lease, and runs nothing", async () => {
  const marker = join(dir, "filter-ran");
  git("config", "filter.evil.smudge", `sh -c 'touch ${marker}; cat'`);
  writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n");
  git("add", ".gitattributes");
  git("commit", "-q", "-m", "attrs");
  const leased = await pool.lease({ repo, branch: "toolroll/t-2", base: "main", runner: "builder-1", now: T0 });
  expect(leased).toMatchObject({ ok: false, message: expect.stringContaining("filter.evil.smudge") });
  expect(existsSync(marker)).toBe(false);
});
