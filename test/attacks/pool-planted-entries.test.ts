/**
 * Attack: plant something in the worktrees root (a symlink, a folder, a dangling or looping link) so a checkout the
 * plane makes later lands where the build can reach it, or so the build's sandbox policy (Codex Full above all, which
 * writes anywhere else) breaks or lets the planted entry through. Guard: WorktreePool.lease inspects every name on the
 * way into the pool and refuses a link before writing anything or running git; codexPool denies every entry it can't
 * resolve and leaves the pool's folders read-only, so a build can't plant there at all.
 */
import { mkdirSync, readdirSync, symlinkSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { codexPool } from "../../src/agent-fence.js";
import { register } from "../../src/runner.js";
import { openStore, type Store } from "../../src/store.js";
import { WorktreePool, worktreePath } from "../../src/worktree.js";
import { codexSandbox, git, lines, marker, needs, plane, q, seatbelt, underCodex, underSeatbelt, useScratch, write } from "./harness.js";

const T0 = new Date("2026-10-13T08:00:00.000Z");

describe("attack: a symlink, folder or dangling/looping link planted in the worktrees root to capture a later checkout", () => {
  const scratch = useScratch("planted");
  let store: Store | null = null;
  afterEach(() => { store?.close(); store = null; });
  const leasePool = (root: string) => {
    store = openStore(":memory:");
    register(store, { name: "builder-1", host: "test", now: T0 });
    return new WorktreePool(store, { root });
  };

  test.each(["project link", "target link", "dangling link", "looping link", "root link"])("plane: a planted %s is refused before anything is written or git runs", async kind => {
    const at = plane(scratch(), marker("planted"));
    const stash = join(at.active, "stash");
    mkdirSync(stash);
    const root = join(at.dir, "pool-2");
    mkdirSync(root);
    const target = worktreePath(root, at.main, "feat/a");
    const project = join(root, "app");
    if (kind === "target link") mkdirSync(project);
    const poisoned = kind === "target link" ? target : kind === "root link" ? join(at.dir, "pool-link") : project;
    symlinkSync(kind === "dangling link" ? join(at.dir, "absent") : kind === "looping link" ? poisoned : stash, poisoned);
    const pool = leasePool(kind === "root link" ? poisoned : root);
    const result = await pool.lease({ repo: at.main, branch: "feat/a", runner: "builder-1", now: T0 });
    expect(result).toMatchObject({ ok: false, reason: "git" });
    expect(readdirSync(stash)).toEqual([]);
    expect(store!.getWorktree(target)).toBeNull();
    expect(git(at.main, "branch", "--list", "feat/a")).toBe("");
  });

  test("plane: a folder planted where the next checkout goes is never adopted; a clean pool leases a real checkout", async () => {
    const at = plane(scratch(), marker("planted-folder"));
    const root = join(at.dir, "pool-2");
    const target = worktreePath(root, at.main, "feat/a");
    // A non-empty folder with a pointer of the build's choosing: git refuses to add a checkout over it.
    write(join(target, ".git"), `gitdir: ${join(at.home, ".ssh")}\n`);
    write(join(target, "planted.txt"), "planted");
    const pool = leasePool(root);
    expect(await pool.lease({ repo: at.main, branch: "feat/a", base: "main", runner: "builder-1", now: T0 })).toMatchObject({ ok: false, reason: "git" });
    expect(store!.getWorktree(target)).toBeNull();
    expect(git(at.main, "branch", "--list", "feat/a")).toBe("");
    expect(git(at.main, "worktree", "list", "--porcelain")).not.toContain(target);
    // Legitimate: a clean name in the same pool leases a genuine linked checkout of the project.
    const leased = await pool.lease({ repo: at.main, branch: "feat/b", base: "main", runner: "builder-1", now: T0 });
    expect(leased.ok, JSON.stringify(leased)).toBe(true);
    const clean = worktreePath(root, at.main, "feat/b");
    expect(git(clean, "rev-parse", "--show-toplevel")).toBe(clean);
    expect(git(at.main, "worktree", "list", "--porcelain")).toContain(`worktree ${clean}`);
  });

  test("policy: Codex denies dangling, looping, aliased and planted entries; the own checkout keeps its write", () => {
    const at = plane(scratch(), marker("planted-policy"));
    const { grants } = at.launch("codex");
    const planted = {
      dangling: join(at.pool, "dangling"), looping: join(at.pool, "looping"), stash: join(at.pool, "stash-link"), folder: join(at.pool, "folder"),
    };
    symlinkSync(join(at.dir, "missing"), planted.dangling);
    symlinkSync(planted.looping, planted.looping);
    mkdirSync(join(at.active, "stash"));
    symlinkSync(join(at.active, "stash"), planted.stash);
    mkdirSync(planted.folder);
    const policy = codexPool(grants.pool!);
    expect(policy.deny).toEqual(expect.arrayContaining([planted.dangling, planted.looping, planted.folder, join(at.pool, "other")]));
    // A link to the own checkout resolves to it: never denied (that would break the launch), never written through.
    expect(policy.deny).not.toContain(at.active);
    expect(policy.read).toEqual([at.pool, join(at.pool, "app")]);
    expect(policy.write).toEqual([at.active]);
  });

  const plant = (pool: string, active: string) => [
    `mkdir -p stash`,
    `ln -s ${q(join(active, "stash"))} ${q(join(pool, "new-project"))} 2>/dev/null && echo link-planted || echo link-refused`,
    `ln -s ${q(join(active, "stash"))} ${q(join(pool, "app", "new-task"))} 2>/dev/null && echo task-link-planted || echo task-link-refused`,
    `mkdir ${q(join(pool, "new-folder"))} 2>/dev/null && echo folder-planted || echo folder-refused`,
    `ln -s ${q(join(pool, "absent"))} ${q(join(pool, "dangling"))} 2>/dev/null && echo dangling-planted || echo dangling-refused`,
    `ln -s ${q(join(pool, "loop"))} ${q(join(pool, "loop"))} 2>/dev/null && echo loop-planted || echo loop-refused`,
    "echo mine > stash/mine && cat stash/mine",
  ].join("\n");
  const REFUSED = ["link-refused", "task-link-refused", "folder-refused", "dangling-refused", "loop-refused", "mine"];
  const nothingPlanted = (pool: string) => {
    for (const name of ["new-project", join("app", "new-task"), "new-folder", "dangling", "loop"]) {
      expect(existsSync(join(pool, name)) || (() => { try { return lstatSync(join(pool, name)).isSymbolicLink(); } catch { return false; } })(), name).toBe(false);
    }
  };

  test("native Codex Full and Auto: the build can plant nothing in the pool; its own checkout stays writable", ctx => {
    needs(ctx, codexSandbox());
    const at = plane(scratch(), marker("planted-codex"));
    for (const fullAccess of [true, false]) {
      const { fence, grants } = at.launch("codex");
      const result = underCodex(plant(at.pool, at.active), fence, fullAccess, grants, { cwd: at.active, codexHome: join(at.dir, "codex-home") });
      expect(lines(result), result.stderr).toEqual(REFUSED);
      nothingPlanted(at.pool);
    }
  });

  test("native Seatbelt: the build can plant nothing in the pool; its own checkout stays writable", ctx => {
    needs(ctx, seatbelt());
    const at = plane(scratch(), marker("planted-seatbelt"));
    const { fence, grants } = at.launch("claude");
    const result = underSeatbelt(plant(at.pool, at.active), fence, grants, { cwd: at.active });
    expect(lines(result), result.stderr).toEqual(REFUSED);
    nothingPlanted(at.pool);
  });
});
