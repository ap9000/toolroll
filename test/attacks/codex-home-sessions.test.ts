/**
 * Attack: from a Codex or OpenRouter build, read or rewrite another session, or rewrite the operator's Codex sign-in.
 * A build's CODEX_HOME used to link the operator's whole `sessions/` tree and `auth.json`, and inside the OS fence it
 * was granted both, read and written: any build could read every other Codex session (the operator's own, other
 * tasks') and plant a sign-in the operator's next Codex session would use. Guard: the launch's own home holds a copy
 * of the sign-in and only its task's sessions (provider-home.ts isolatedCodexHome), kept between that task's launches
 * in a folder of Toolroll's own that every launch is denied (agent-fence.ts codexSessionsFolder), copied out after the
 * run only as plain files proven to be inside the launch's own folder.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { agentFence, codexSessionsFolder, homeWriteDenies, type FenceGrants } from "../../src/agent-fence.js";
import { isolatedCodexHome, type CodexHome } from "../../src/provider-home.js";
import { lines, needs, osFence, underSandbox, useScratch } from "./harness.js";

const homes: CodexHome[] = [];
afterEach(() => { for (const one of homes.splice(0)) one.cleanup(); });

function world(dir: string) {
  const home = join(dir, "home");
  const codex = join(home, ".codex");
  const runs = join(dir, "runs");
  const state = join(dir, "state");
  const database = join(state, "orders.db");
  mkdirSync(join(codex, "sessions", "2026", "11", "25"), { recursive: true });
  mkdirSync(runs);
  mkdirSync(state);
  writeFileSync(database, "");
  writeFileSync(join(codex, "auth.json"), '{"operator":"sign-in"}');
  writeFileSync(join(codex, "sessions", "2026", "11", "25", "rollout-operator.jsonl"), "operator-session-secret\n");
  const otherTask = codexSessionsFolder(database, "task-other")!;
  mkdirSync(join(otherTask, "2026"), { recursive: true });
  writeFileSync(join(otherTask, "2026", "rollout-other.jsonl"), "other-task-session-secret\n");
  const ownTask = codexSessionsFolder(database, "task-own")!;
  mkdirSync(join(ownTask, "2026"), { recursive: true });
  writeFileSync(join(ownTask, "2026", "rollout-own.jsonl"), "own-earlier-session\n");
  const run = isolatedCodexHome(codex, runs, { signIn: true, sessions: ownTask });
  homes.push(run);
  return { home, codex, runs, database, otherTask, ownTask, run };
}

describe("attack: a Codex build reaching other sessions or the operator's sign-in", () => {
  const scratch = useScratch("codexhome");

  test("the run's home holds copies only: no link leads to the operator's sign-in or sessions", () => {
    const { codex, run } = world(scratch());
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      const held = lstatSync(path);
      expect(held.isSymbolicLink(), path).toBe(false);
      return held.isDirectory() ? walk(path) : [path];
    });
    expect(walk(run.dir).map(path => path.slice(run.dir.length + 1)).sort()).toEqual(["auth.json", "sessions/2026/rollout-own.jsonl"]);
    writeFileSync(join(run.dir, "auth.json"), '{"planted":"by the run"}');
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe('{"operator":"sign-in"}');
  });

  test("inside the OS fence: its own sessions only; another task's, the operator's sessions and sign-in are never written or read", ctx => {
    needs(ctx, osFence());
    const dir = scratch();
    const { home, codex, runs, database, otherTask, ownTask, run } = world(dir);
    const runFolders = { root: realpathSync(runs), own: null, alsoOwn: [realpathSync(run.dir)] };
    const fence = agentFence({ databaseFile: database, worktree: null, home, runFolders });
    const grants: FenceGrants = { readOnly: [], readable: [], lookup: [], runFolders, homeNames: [codex], writeDenies: homeWriteDenies(home, null, "codex") };
    const result = underSandbox([
      `cat "${run.dir}/sessions/2026/rollout-own.jsonl"`,
      `touch "${run.dir}/sessions/rollout-new.jsonl" && echo own-written`,
      `cat "${otherTask}/2026/rollout-other.jsonl" 2>/dev/null || echo other-task-read-refused`,
      `touch "${otherTask}/2026/planted.jsonl" 2>/dev/null || echo other-task-write-refused`,
      `cat "${ownTask}/2026/rollout-own.jsonl" 2>/dev/null || echo kept-folder-read-refused`,
      `cat "${codex}/sessions/2026/11/25/rollout-operator.jsonl" 2>/dev/null || echo operator-session-read-refused`,
      `touch "${codex}/sessions/2026/11/25/planted.jsonl" 2>/dev/null || echo operator-session-write-refused`,
      `printf x >> "${codex}/auth.json" 2>/dev/null || echo operator-sign-in-write-refused`,
    ].join("\n"), fence, grants, { cwd: dir });
    expect(lines(result), result.stderr).toEqual([
      "own-earlier-session", "own-written", "other-task-read-refused", "other-task-write-refused", "kept-folder-read-refused",
      "operator-session-read-refused", "operator-session-write-refused", "operator-sign-in-write-refused",
    ]);
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe('{"operator":"sign-in"}');
  });

  test("links the run plants in its sessions are never followed when they are kept for its task", () => {
    const { codex, otherTask, ownTask, run } = world(scratch());
    const sessions = join(run.dir, "sessions");
    writeFileSync(join(sessions, "rollout-real.jsonl"), "kept\n");
    symlinkSync(join(codex, "auth.json"), join(sessions, "rollout-auth.jsonl"));
    symlinkSync(join(otherTask, "2026"), join(sessions, "2027"));
    symlinkSync(join(codex, "sessions"), join(sessions, "operator"));
    run.keep();
    const kept = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return lstatSync(path).isDirectory() ? kept(path).map(one => `${name}/${one}`) : [name];
    });
    expect(kept(ownTask).sort()).toEqual(["2026/rollout-own.jsonl", "rollout-real.jsonl"]);
    for (const path of kept(ownTask)) {
      expect(lstatSync(join(ownTask, path)).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(ownTask, path), "utf8")).not.toMatch(/operator|other-task/);
    }
  });
});
