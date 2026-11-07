/**
 * Attack: a fenced build agent starting a build of its own (plain-toolroll.md P2.4). `task new` is a person's act at a
 * terminal; from inside the fence it reaches neither the plane's database nor a filing, whether it calls the CLI plainly,
 * with --json, or drives it through a terminal of its own (script(1) makes a PTY: a prompt there is no person). Run under
 * the real `sandbox-exec` and `codex sandbox`, with a positive control: the same command outside the fence reaches the
 * refusal in the command itself, so the fence is what stopped the inside one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { openStore, type Store } from "../../src/store.js";
import { addApprover } from "../../src/scope.js";
import { codexSandbox, needs, plane, q, seatbelt, underCodex, underSandbox, useScratch } from "./harness.js";

const scratch = useScratch("fast-start");
const BIN = resolve(import.meta.dirname, "../../dist/bin.js");

function world() {
  const at = plane(scratch(), "fast-marker");
  rmSync(at.databaseFile, { force: true });
  const store: Store = openStore(at.databaseFile);
  addApprover(store, "owner", new Date());
  store.close();
  const tasks = (): number => { const read = openStore(at.databaseFile); try { return Number(read.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"]); } finally { read.close(); } };
  const cli = `${q(process.execPath)} ${q(BIN)} task new 'Fix the typo' --repo ${q(at.main)} --db ${q(at.databaseFile)}`;
  return { at, tasks, attempts: [cli, `${cli} --json`, `/usr/bin/script -q /dev/null ${cli}`, `printf 'y\\n' | /usr/bin/script -q /dev/null ${cli}`] };
}

describe("attack: a fenced agent files and approves its own task", () => {
  test("outside the fence the command itself refuses a script (the positive control)", ctx => {
    if (!existsSync(BIN)) ctx.skip();
    const { at, tasks } = world();
    const ran = spawnSync(process.execPath, [BIN, "task", "new", "Fix the typo", "--repo", at.main, "--db", at.databaseFile, "--json"], { encoding: "utf8", env: { ...process.env, HOME: at.home, XDG_CONFIG_HOME: join(at.home, ".config") } });
    expect(ran.status).not.toBe(0);
    expect(ran.stdout).toContain("person-only");
    expect(tasks()).toBe(0);
  }, 60_000);

  test("under sandbox-exec: every shape, a PTY included, files nothing", ctx => {
    needs(ctx, seatbelt());
    if (!existsSync(BIN)) ctx.skip();
    const { at, tasks, attempts } = world();
    const { fence, grants } = at.launch("claude");
    for (const attempt of attempts) {
      const ran = underSandbox(attempt, fence, grants, { cwd: at.active });
      expect(ran.status, attempt).not.toBe(0);
      expect(ran.stdout, attempt).not.toContain("Building");
      expect(tasks(), attempt).toBe(0);
    }
    // The barrier itself: the plane's database can't be written from in here.
    expect(underSandbox(`echo x >> ${q(at.databaseFile)}`, fence, grants, { cwd: at.active }).status).not.toBe(0);
  }, 120_000);

  test("under codex sandbox: every shape, a PTY included, files nothing", ctx => {
    needs(ctx, codexSandbox());
    if (!existsSync(BIN)) ctx.skip();
    const { at, tasks, attempts } = world();
    const { fence, grants } = at.launch("codex");
    for (const attempt of attempts) {
      const ran = underCodex(attempt, fence, false, grants, { cwd: at.active, codexHome: join(at.home, ".codex") });
      expect(ran.stdout, attempt).not.toContain("Building");
      expect(tasks(), attempt).toBe(0);
    }
  }, 120_000);
});
