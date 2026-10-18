/**
 * Parallel builds on one project, from the service's own builder loop
 * (`watch`, which `up` runs once per project), against real git. Only the
 * agent is a stub: it stands where `claude` would, in the checkout it was
 * given, and answers in the CLI's output envelope.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import type { Runner } from "./builder.js";
import { maySlotTake, ProjectPasses, PROJECT_CONCURRENCY_DEFAULT, projectConcurrency, saveProjectConcurrency, savedProjectConcurrency, type SlotFacts } from "./project-concurrency.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const AGENT_SAID = JSON.stringify({ result: "Added the guard." });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The agent's half of the terminal handoff protocol. */
const concludeDone = async (cwd: string, args: readonly string[]): Promise<void> => {
  const prompt = args[args.indexOf("-p") + 1] ?? "";
  const name = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
  if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), JSON.stringify({ version: 1, status: "completed", conclusion: "Added the guard." }));
};

describe("the fair-share rule", () => {
  const facts = (over: Partial<SlotFacts>): SlotFacts => ({
    repo: "/a", capacity: 3, running: new Map(), limitOf: () => 2, waiting: new Set(), yieldingSince: null, passes: new ProjectPasses(), ...over,
  });

  test("a project builds up to its own number, never past the worker's capacity", () => {
    expect(maySlotTake(facts({ running: new Map([["/a", 1]]) }))).toEqual({ take: true });
    expect(maySlotTake(facts({ running: new Map([["/a", 2]]) }))).toMatchObject({ take: false, why: "limit" });
    expect(maySlotTake(facts({ capacity: 2, limitOf: () => 5, running: new Map([["/a", 2]]) }))).toMatchObject({ take: false, why: "limit" });
    expect(maySlotTake(facts({ running: new Map([["/a", 1], ["/b", 2]]) }))).toMatchObject({ take: false, why: "capacity" });
  });

  test("a busy project leaves a free slot to a waiting one building fewer, until that one has had a pass", () => {
    const passes = new ProjectPasses();
    const busy = { running: new Map([["/a", 1]]), waiting: new Set(["/a", "/b"]), passes };
    expect(maySlotTake(facts(busy))).toEqual({ take: false, why: "fair-share", to: "/b" });
    // A project building nothing never yields: everyone's first build comes first.
    expect(maySlotTake(facts({ ...busy, repo: "/b" }))).toEqual({ take: true });
    // Equal shares do not yield to each other.
    expect(maySlotTake(facts({ ...busy, running: new Map([["/a", 1], ["/b", 1]]) }))).toEqual({ take: true });
    // /b had its pass and still could not start (a missing tool, say): /a stops waiting for it.
    const since = passes.stamp();
    passes.passed("/b");
    expect(maySlotTake(facts({ ...busy, yieldingSince: since }))).toEqual({ take: true });
  });

  test("the setting is saved per project, defaults to two, and a damaged file reads as the default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "so-concurrency-"));
    try {
      const db = join(dir, "orders.db");
      expect(projectConcurrency(db, "/a")).toBe(PROJECT_CONCURRENCY_DEFAULT);
      expect(saveProjectConcurrency(db, "/a", 3)).toEqual({ before: 2, after: 3 });
      expect(projectConcurrency(db, "/a")).toBe(3);
      expect(projectConcurrency(db, "/b")).toBe(2);
      await writeFile(join(dir, "project-concurrency.json"), "{not json");
      expect(savedProjectConcurrency(db).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parallel builds from the service's builder", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const run = (argv: string[], agent: Runner, shouldStop?: () => boolean) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, agentRunner: agent, ...(shouldStop === undefined ? {} : { shouldStop }) });
  };
  const payload = () => {
    const opens = lines.map((line, index) => ({ line, index })).filter(one => one.line.startsWith("{"));
    return JSON.parse(lines.slice(opens[opens.length - 1]?.index ?? 0).join("\n"));
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "so-parallel-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const idle: Runner = async () => ({ ...OK, stdout: AGENT_SAID });

  /** A worker of the given capacity bound to the repo, an approver, and approved tasks. */
  const setup = async (capacity: number, tasks: string[]) => {
    const store = openStore(db);
    const runnerToken = (() => {
      try {
        return register(store, { name: "builder-1", host: "test", capacity, repos: [repo], now: new Date() }).token;
      } finally {
        store.close();
      }
    })();
    await run(["approver", "add", "alex", "--json"], idle);
    const approverToken = payload().token as string;
    for (const phase of ["build", "plan", "review"]) {
      await run(["config", "set", phase, "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"], idle);
    }
    for (const id of tasks) {
      await run(["task", "add", "the work", "--id", id, "--repo", repo], idle);
      await run(["task", "scope", id, "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"], idle);
      await run(["task", "approve", id, "--json"], idle);
      const digest = payload().scope.digest as string;
      await run(["task", "approve", id, "--yes", "--digest", digest, "--as", "alex", "--token", approverToken], idle);
    }
    return { runnerToken, approverToken };
  };

  /** The watch stops the moment every named task is done (or on its own signal): the
   * test waits for that event, and `--for` is only a safety cap a loaded machine never meets. */
  const watch = async (runnerToken: string, forMs: number, agent: Runner, done: string[] = []) => {
    let observer: ReturnType<typeof openStore> | null = null;
    const stop = done.length === 0 ? undefined : () => {
      observer ??= openStore(db);
      return done.every(id => observer!.getTask(id)?.state === "done");
    };
    try {
      return await run(["watch", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool,
        "--for", String(forMs), "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "3600000", "--json"], agent, stop);
    } finally {
      observer?.close();
    }
  };

  /** Holds each build open until `together` have started, or until no other build has
   * started for a short grace after the latest one (every lane the watch would open
   * starts in the same first pass), and records the most at once. */
  const overlapping = (together: number, holdMs: number) => {
    const seen = { active: 0, peak: 0, started: 0, checkouts: new Set<string>() };
    const agent: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      seen.checkouts.add(cwd);
      seen.active++;
      seen.started++;
      seen.peak = Math.max(seen.peak, seen.active);
      let lastStarted = seen.started;
      let quietSince = Date.now();
      while (seen.started < together && Date.now() - quietSince < 2_000) {
        await sleep(20);
        if (seen.started !== lastStarted) { lastStarted = seen.started; quietSince = Date.now(); }
      }
      await sleep(holdMs);
      await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
      await concludeDone(cwd, args);
      seen.active--;
      return { ...OK, stdout: AGENT_SAID };
    };
    return { seen, agent };
  };

  const stateOf = async (id: string) => {
    await run(["task", "show", id, "--json"], idle);
    return payload().task.state as string;
  };

  test("two tasks of one project build at once, each in its own checkout, under the default setting", async () => {
    const { runnerToken } = await setup(3, ["t-1", "t-2"]);
    const { seen, agent } = overlapping(2, 300);

    expect(await watch(runnerToken, 60_000, agent, ["t-1", "t-2"]), lines.join("\n")).toBe(EXIT.ok);

    expect(seen.peak).toBe(2);
    expect(seen.checkouts.size).toBe(2);
    expect(await stateOf("t-1")).toBe("done");
    expect(await stateOf("t-2")).toBe("done");
  });

  test("the worker's capacity still caps the total, whatever the project's number", async () => {
    const { runnerToken, approverToken } = await setup(2, ["t-1", "t-2", "t-3"]);
    expect(await run(["project", "concurrency", "3", "--repo", repo, "--as", "alex", "--token", approverToken, "--json"], idle)).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ ok: true, before: 2, concurrency: 3, workerCapacity: 2 });
    // The change is the approver's, in the ledger as before → after.
    const store = openStore(db);
    try {
      expect(store.handle.prepare("SELECT actor, detail FROM action_ledger WHERE action = 'builds at once'").get()).toMatchObject({ actor: "alex", detail: "2 → 3" });
    } finally {
      store.close();
    }
    // Three would start together if anything let them; hold the first two long enough to see.
    const { seen, agent } = overlapping(3, 0);

    expect(await watch(runnerToken, 60_000, agent, ["t-1", "t-2", "t-3"]), lines.join("\n")).toBe(EXIT.ok);

    expect(seen.peak).toBe(2);
    expect(seen.started).toBe(3);
    for (const id of ["t-1", "t-2", "t-3"]) expect(await stateOf(id)).toBe("done");

    // Status shows the project's running builds against its limit.
    await run(["status", "--json"], idle);
    expect(payload().projects).toEqual([expect.objectContaining({ repo, running: 0, limit: 2 })]);
  });

  test("a project set to one builds one at a time", async () => {
    const { runnerToken, approverToken } = await setup(3, ["t-1", "t-2"]);
    expect(await run(["project", "concurrency", "1", "--repo", repo, "--as", "alex", "--token", approverToken, "--json"], idle)).toBe(EXIT.ok);
    const { seen, agent } = overlapping(2, 0);

    expect(await watch(runnerToken, 60_000, agent, ["t-1", "t-2"]), lines.join("\n")).toBe(EXIT.ok);

    expect(seen.peak).toBe(1);
    expect(await stateOf("t-1")).toBe("done");
    expect(await stateOf("t-2")).toBe("done");
  });

  test("changing the number is an approver's act", async () => {
    await setup(2, ["t-1"]);
    expect(await run(["project", "concurrency", "3", "--repo", repo, "--as", "alex", "--token", "wrong", "--json"], idle)).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "refused" });
    expect(await run(["project", "concurrency", "--repo", repo, "--json"], idle)).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ concurrency: 2 });
    expect(await run(["project", "concurrency", "0", "--repo", repo, "--as", "alex", "--token", "x", "--json"], idle)).toBe(EXIT.usage);
  });

  test("stopping the service mid-run saves the work, hands the task back with no strike, and the next start resumes it", async () => {
    const { runnerToken } = await setup(2, ["t-stop"]);
    let first = true;
    const stoppedMidRun: Runner = async (_file, _args, options) => {
      const cwd = options?.cwd ?? "";
      // Half the work, then the service is told to stop (as Ctrl-C or a
      // service manager would), and the agent's process ends before handing off.
      await writeFile(join(cwd, "half.ts"), "export const half = true;\n");
      first = false;
      process.emit("SIGINT");
      return { ...OK, code: 143, stdout: JSON.stringify({ type: "system", subtype: "init" }) };
    };

    expect(await watch(runnerToken, 20_000, stoppedMidRun), lines.join("\n")).toBe(EXIT.ok);
    expect(first).toBe(false);

    const store = openStore(db);
    let worktree = "";
    try {
      const ref = store.refFor("built-in", "t-stop").id;
      const [attempt] = store.runsFor(ref);
      expect(attempt).toMatchObject({ outcome: "failed", reason: "interrupted" });
      worktree = attempt!.worktree ?? "";
      // Its work is still in its checkout, and saved as a patch beside its evidence.
      expect(readFileSync(join(worktree, "half.ts"), "utf8")).toContain("half");
      const patch = join(base, "evidence", String(attempt!.id), "service-stop-work.patch");
      expect(existsSync(patch)).toBe(true);
      expect(readFileSync(patch, "utf8")).toContain("half.ts");
      // It says so, in plain words.
      const said = store.handle.prepare("SELECT handoff FROM run WHERE id = ?").get(attempt!.id);
      expect(String(said?.["handoff"])).toMatch(/^Toolroll stopped while this task was building\. Its work is kept in .* and saved as .*; the task is back in the queue and resumes from it when the builder runs again\.$/);
      // Handed back, not failed: queued, no strike, no hold.
      expect(store.getTask("t-stop")?.state).toBe("queued");
      expect(store.handle.prepare("SELECT strikes FROM task_ref WHERE id = ?").get(ref)).toMatchObject({ strikes: 0 });
      expect(store.handle.prepare("SELECT COUNT(*) AS n FROM hold WHERE task_ref = ? AND (until IS NULL OR until > ?)").get(ref, new Date().toISOString())).toMatchObject({ n: 0 });
      expect(store.handle.prepare("SELECT COUNT(*) AS n FROM claim WHERE task_ref = ? AND released_at IS NULL").get(ref)).toMatchObject({ n: 0 });
    } finally {
      store.close();
    }

    // The service starts again: the task resumes in the same checkout, from the kept work.
    let resumedFrom: string | null = null;
    const resumes: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      resumedFrom = existsSync(join(cwd, "half.ts")) ? cwd : null;
      await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
      await concludeDone(cwd, args);
      return { ...OK, stdout: AGENT_SAID };
    };
    expect(await watch(runnerToken, 60_000, resumes, ["t-stop"]), lines.join("\n")).toBe(EXIT.ok);
    expect(resumedFrom).toBe(worktree);
    expect(await stateOf("t-stop")).toBe("done");
    const after = openStore(db);
    try {
      const ref = after.refFor("built-in", "t-stop").id;
      const runs = after.runsFor(ref).sort((a, b) => a.id - b.id);
      expect(runs.map(one => one.outcome)).toEqual(["failed", "built"]);
      const committed = await git(["show", "--stat", "--format=", `refs/heads/${runs[1]!.branch}`]);
      expect(committed.stdout).toContain("half.ts");
    } finally {
      after.close();
    }
  }, 40_000);
});
