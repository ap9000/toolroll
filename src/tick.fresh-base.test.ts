/**
 * Fresh base, end to end against real git: a task whose branch has no commits
 * of its own starts its next attempt from current main; one with commits is
 * never moved, and `task show` says how far behind main it is. Only the agent
 * is a stub.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import type { Runner } from "./builder.js";
import { OK, T0, AGENT_SAID, registerRunner, concludeDone } from "../test/tick-kit.js";

describe("fresh base, against real git", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  let agentHeads: string[] = [];

  const git = async (args: string[], cwd = repo) => (await exec("git", args, { cwd })).stdout.trim();
  const agent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    agentHeads.push(await git(["rev-parse", "HEAD"], cwd));
    await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
    await concludeDone(cwd, args);
    return { ...OK, stdout: AGENT_SAID };
  };
  const brokenAgent: Runner = async (_file, _args, options) => {
    agentHeads.push(await git(["rev-parse", "HEAD"], options?.cwd ?? ""));
    return { ...OK, code: 1, stdout: JSON.stringify({ type: "system", subtype: "init" }), stderr: "the model refused" };
  };
  const run = (argv: string[], runner: Runner = agent, now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: runner });
  };
  const payload = () => JSON.parse(lines.join("\n"));
  const commitOnMain = async (name: string) => {
    await writeFile(join(repo, name), `${name}\n`);
    await git(["add", name]);
    await git(["commit", "-qm", name]);
    return git(["rev-parse", "main"]);
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-fresh-tick-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    agentHeads = [];
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await commitOnMain("README.md");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const queueApproved = async (id: string) => {
    const runnerToken = registerRunner(db, "builder-1", repo);
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    for (const phase of ["build", "plan", "review"]) {
      await run(["config", "set", phase, "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    }
    await run(["task", "add", "the work", "--id", id, "--repo", repo]);
    await run(["task", "scope", id, "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"]);
    await run(["task", "approve", id, "--json"]);
    await run(["task", "approve", id, "--yes", "--digest", payload().scope.digest as string, "--as", "alex", "--token", approverToken]);
    return runnerToken;
  };
  const tick = (runnerToken: string, runner: Runner, now: Date) =>
    run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"], runner, now);

  test("c1: a task with no commits of its own starts its next attempt from current main", async () => {
    const runnerToken = await queueApproved("t-1");
    const old = await git(["rev-parse", "main"]);
    await tick(runnerToken, brokenAgent, T0);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "failed" }]);

    // Main moves while the task waits for its retry.
    await commitOnMain("release-0.9.61.md");
    const main = await commitOnMain("release-notes.md");

    await tick(runnerToken, agent, new Date(T0.getTime() + 5 * 60_000));
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "built", committed: true }]);
    expect(agentHeads).toEqual([old, main]);
    // The task's commit sits directly on current main and carries only the task's own change.
    expect(await git(["rev-parse", "toolroll/t-1^"])).toBe(main);
    expect(await git(["diff", "--name-only", main, "toolroll/t-1"])).toBe("guard.ts");

    const store = openStore(db);
    try {
      const ref = store.refFor("built-in", "t-1").id;
      const [built] = store.runsFor(ref);
      expect(built).toMatchObject({ outcome: "built", baseRevision: main });
      expect(store.firstBuilderBase(ref, "toolroll/t-1")).toBe(main);
      expect(store.notesForRun(built!.id).map(one => one.note).join("\n")).toContain(`Started from current main (${main.slice(0, 8)})`);
    } finally { store.close(); }

    await run(["task", "show", "t-1", "--json"]);
    expect(payload().base).toMatchObject({ base: main, main: "main", behind: 0 });
    await run(["task", "show", "t-1"]);
    expect(lines.join("\n")).toContain(`base: ${main.slice(0, 8)} · Up to date with main`);
  });

  test("c2/c3: a task with its own commits is never moved, and task show names its base and how far behind main it is", async () => {
    const runnerToken = await queueApproved("t-2");
    const old = await git(["rev-parse", "main"]);
    await tick(runnerToken, agent, T0);
    expect(payload().dispatched).toMatchObject([{ id: "t-2", outcome: "built" }]);
    const head = await git(["rev-parse", "toolroll/t-2"]);
    await commitOnMain("release-0.9.61.md");
    await commitOnMain("release-notes.md");

    await run(["task", "show", "t-2", "--json"]);
    expect(payload().base).toMatchObject({ base: old, branch: "toolroll/t-2", main: "main", behind: 2, words: `Base ${old.slice(0, 8)} · Behind main by 2 commits` });
    await run(["task", "show", "t-2"]);
    expect(lines.join("\n")).toContain(`base: ${old.slice(0, 8)} · Behind main by 2 commits`);
    expect(await git(["rev-parse", "toolroll/t-2"])).toBe(head);
  });
});
