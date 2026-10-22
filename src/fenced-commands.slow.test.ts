/**
 * A build's setup and check commands run in its fence (arc 2, invoke.ts fencedCommands): they can't read Toolroll's
 * state, and under a workspace approval they write only the checkout, their own temp folder and the project's caches,
 * which their package managers are pointed at.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { linuxFenceAvailable, macosFenceAvailable } from "./agent-fence.js";
import { run } from "./exec.js";
import { fencedCommands } from "./invoke.js";
import { register } from "./runner.js";
import { openStore, type Store } from "./store.js";
import { WorktreePool } from "./worktree.js";

const FENCED = macosFenceAvailable() || linuxFenceAvailable();
const T0 = new Date("2026-10-22T08:00:00.000Z");
let dir: string;
let state: string;
let repo: string;
let store: Store;
let pool: WorktreePool;

beforeEach(async () => {
  // Outside /tmp, as homes and checkouts are: a Linux command's /tmp is its own, so a world there would be out of sight.
  dir = realpathSync(mkdtempSync(join(homedir(), ".so-fenced-commands-")));
  state = join(dir, "toolroll");
  mkdirSync(state);
  writeFileSync(join(state, "up-login.txt"), "secret\n");
  repo = join(dir, "repo");
  mkdirSync(repo);
  store = openStore(join(state, "orders.db"));
  register(store, { name: "builder-1", host: "test", now: T0 });
  const git = (args: string[]) => run("git", args, { cwd: repo });
  await git(["init", "-q", "-b", "main"]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"]);
  pool = new WorktreePool(store, { root: join(state, "worktrees") });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

async function build(): Promise<{ runId: number; worktree: string }> {
  store.createTask({ id: "t", title: "t" }, T0);
  const ref = store.refFor("built-in", "t").id;
  store.placeTask(ref, repo);
  const leased = await pool.lease({ repo, branch: "toolroll/t", base: "main", runner: "builder-1", taskRef: ref, now: T0 });
  if (!leased.ok) throw new Error(leased.message);
  const runId = store.startRun({ taskRef: ref, leaseId: "l-t", runner: "builder-1", branch: "toolroll/t", worktree: leased.worktree.path,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: T0 });
  return { runId, worktree: realpathSync(leased.worktree.path) };
}

const probe = (worktree: string, outside: string) => [
  `cat ${join(state, "up-login.txt")} >/dev/null 2>&1 || echo state-refused`,
  `echo x >> ${outside} 2>/dev/null || echo outside-refused`,
  `echo y > ${worktree}/made.txt && echo worktree-ok`,
  `touch "$TMPDIR/t" && echo temp-ok`,
  `mkdir -p "$npm_config_cache" && touch "$npm_config_cache/x" && echo cache-ok`,
].join("\n");

describe.skipIf(!FENCED)("a build's setup and check commands", () => {
  test("workspace: no state, nothing outside its workspace; checkout, temp and caches work", async () => {
    const { runId, worktree } = await build();
    const outside = join(dir, "outside.txt");
    const result = await fencedCommands(store, runId, "workspace", run)("/bin/sh", ["-c", probe(worktree, outside)], { cwd: worktree });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual(["state-refused", "outside-refused", "worktree-ok", "temp-ok", "cache-ok"]);
    expect(existsSync(outside)).toBe(false);
    expect(readFileSync(join(worktree, "made.txt"), "utf8")).toBe("y\n");
  });

  test("anywhere: still no state; its writes go where they always did", async () => {
    const { runId, worktree } = await build();
    const outside = join(dir, "outside.txt");
    const result = await fencedCommands(store, runId, "anywhere", run)("/bin/sh", ["-c", [
      `cat ${join(state, "up-login.txt")} >/dev/null 2>&1 || echo state-refused`,
      `echo x >> ${outside} && echo outside-ok`,
    ].join("\n")], { cwd: worktree });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual(["state-refused", "outside-ok"]);
  });
});
