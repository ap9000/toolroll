/**
 * A build's setup and check commands run in its fence (arc 2, invoke.ts fencedCommands): they can't read Toolroll's
 * state, and under a workspace approval they write only the checkout, their own temp folder and the project's caches,
 * which their package managers are pointed at.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { linuxFenceAvailable, macosFenceAvailable } from "./agent-fence.js";
import { run } from "./exec.js";
import { fencedCheckoutCommands, fencedCommands } from "./invoke.js";
import { register } from "./runner.js";
import { openStore, type Store } from "./store.js";
import { WorktreePool } from "./worktree.js";
import { outsideTempDir } from "../test/short-temp.js";

const FENCED = macosFenceAvailable() || linuxFenceAvailable();
const T0 = new Date("2026-10-22T08:00:00.000Z");
let dir: string;
let state: string;
let repo: string;
let store: Store;
let pool: WorktreePool;

beforeEach(async () => {
  // Outside /tmp, as homes and checkouts are: a Linux command's /tmp is its own, so a world there would be out of sight.
  dir = outsideTempDir(".so-fenced-commands-");
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

  test("a self-hosted check's own database folder is writable", async () => {
    const { runId, worktree } = await build();
    const db = outsideTempDir(".so-check-db-");
    try {
      const result = await fencedCommands(store, runId, "workspace", run)("/bin/sh", ["-c", `touch "$(dirname "$TOOLROLL_DB")/orders.db" && echo db-ok`], { cwd: worktree, env: { TOOLROLL_DB: join(db, "orders.db") } });
      expect(result.stdout.trim(), result.stderr).toBe("db-ok");
    } finally { rmSync(db, { recursive: true, force: true }); }
  });

  test("a follow-up check's own checkout of the commit runs in the same fence", async () => {
    await build();
    const checkout = join(dir, "check-checkout");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", checkout, "main"]);
    const outside = join(dir, "outside.txt");
    const result = await fencedCheckoutCommands(store, repo, realpathSync(checkout), run)("/bin/sh", ["-c", probe(realpathSync(checkout), outside)], { cwd: checkout });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual(["state-refused", "outside-refused", "worktree-ok", "temp-ok", "cache-ok"]);
  });
});

describe.skipIf(!FENCED)("a project's checks in a checkout that links the shared install", () => {
  test("read the dependencies their checkout links, and no other copy", async () => {
    const { worktree } = await build();
    const KEY = "0123456789abcdef01234567", OTHER = "fedcba9876543210fedcba98";
    for (const key of [KEY, OTHER]) {
      const pkg = join(state, "deps", key, "node_modules", "pkg");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pkg", main: "index.js" }));
      writeFileSync(join(pkg, "index.js"), `module.exports = ${JSON.stringify(key)};\n`);
      writeFileSync(join(state, "deps", key, "ready.json"), JSON.stringify({ version: 1, repo, key, lock: "lock", node: "node", setup: "setup-1", tree: null, createdAt: "2026-10-12T00:00:00.000Z" }));
    }
    const shared = join(state, "deps", KEY, "node_modules");
    mkdirSync(join(worktree, "node_modules"));
    writeFileSync(join(worktree, "node_modules", ".toolroll-shared"), `${shared}\n`);
    symlinkSync(join(shared, "pkg"), join(worktree, "node_modules", "pkg"), "dir");
    store.stampWorktreeSetup(worktree, "setup-1");
    const result = await fencedCheckoutCommands(store, repo, worktree, run)("/bin/sh", ["-c", [
      `${JSON.stringify(process.execPath)} -e 'console.log(require("pkg"))'`,
      `cat ${JSON.stringify(join(state, "deps", OTHER, "node_modules", "pkg", "index.js"))} >/dev/null 2>&1 || echo other-refused`,
      // A bundler finds node_modules by listing the copy's folder (esbuild did, in the 0.9.68 release check).
      `ls ${JSON.stringify(join(state, "deps", KEY))}`,
      `cat ${JSON.stringify(join(state, "deps", KEY, "ready.json"))} >/dev/null 2>&1 || echo note-refused`,
      `ls ${JSON.stringify(join(state, "deps", OTHER))} >/dev/null 2>&1 || echo other-list-refused`,
    ].join("\n")], { cwd: worktree });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual([KEY, "other-refused", "node_modules", "ready.json", "note-refused", "other-list-refused"]);
  });
});

describe("commands where nothing can confine them", () => {
  test("don't run unless an instance operator allowed unconfined agents", async () => {
    const { runId, worktree } = await build();
    const nowhere = () => false;
    const refused = await fencedCommands(store, runId, "workspace", run, nowhere)("/bin/sh", ["-c", "echo ran"], { cwd: worktree });
    expect(refused).toMatchObject({ code: 1, stdout: "" });
    expect(refused.stderr).toMatch(/can't confine the build's commands/);
    store.setUnfencedAgentsAllowed(true, "alex", T0);
    expect((await fencedCommands(store, runId, "workspace", run, nowhere)("/bin/sh", ["-c", "echo ran"], { cwd: worktree })).stdout.trim()).toBe("ran");
  });
});
