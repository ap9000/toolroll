/**
 * The M1 acceptance test, the watch loop: zero tokens idle, one episode per
 * night, and a successor that recovers a crashed worker.
 *
 * End to end against real git: the store on disk, the claim and its fence,
 * the worktree pool running actual git, the builder's gates and the commit.
 * Only the agent is a stub — it writes a real file into the real worktree it
 * was given and answers in the CLI's output envelope.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import { acquire } from "./claim.js";
import { WorktreePool } from "./worktree.js";
import type { Runner } from "./builder.js";
import { createSweepSupervisor, storageSweepSupervisor } from "./storage-sweep-process.js";
import { hangingSweep } from "../test/sweep-process.js";
import { sweepSchedule } from "./storage-sweep-schedule.js";
import { lastSweep } from "./storage-sweep.js";
import { saveProjectConcurrency } from "./project-concurrency.js";
import { presented, OK, T0, AGENT_SAID, registerRunner, concludeDone, proveChangedPath } from "../test/tick-kit.js";

describe("watch — the loop, zero tokens idle", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const agent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    await writeFile(join(cwd, `made-${Math.random().toString(36).slice(2, 8)}.ts`), "export {};\n");
    await concludeDone(cwd, args);
    return { ...OK, stdout: AGENT_SAID };
  };

  const run = (argv: string[], runner: Runner = agent, shouldStop?: () => boolean) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      agentRunner: runner,
      ...(shouldStop === undefined ? {} : { shouldStop }),
    });
  };

  /** A watch's stop fence that lands the moment every named task is done:
   * the test waits for the event, never for a fixed window a loaded machine
   * can outrun. The watch's own `--for` stays only as a safety cap. */
  const untilDone = (...ids: string[]) => {
    let observer: ReturnType<typeof openStore> | null = null;
    return {
      stop: () => {
        observer ??= openStore(db);
        return ids.every(id => observer!.getTask(id)?.state === "done");
      },
      close: () => observer?.close(),
    };
  };

  const payload = () => {
    const opens = lines.map((line, index) => ({ line, index })).filter(one => one.line.startsWith("{"));
    const from = opens[opens.length - 1]?.index ?? 0;
    return JSON.parse(lines.slice(from).join("\n"));
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-watch-")));
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

  const setup = async () => {
    // The watch loop runs on the real clock, so the registration heartbeat
    // does too — a T0 heartbeat would look long dead to the reaper.
    const runnerToken = registerRunner(db, "builder-1", repo, new Date());
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    return { runnerToken, approverToken };
  };

  const approved = async (id: string, approverToken: string, acceptance = "It is fixed and verified.|manual-review") => {
    await run(["task", "add", "the work", "--id", id, "--repo", repo]);
    await run(["task", "scope", id, "--goal", "add a guard on the payout path", "--acceptance", acceptance]);
    await run(["task", "approve", id, "--json"]);
    const digest = payload().scope.digest as string;
    await run(["task", "approve", id, "--yes", "--digest", digest, "--as", "alex", "--token", approverToken]);
  };

  test("one watch drains a dependency chain without waiting for the next interval", async () => {
    const { runnerToken, approverToken } = await setup();
    await approved("t-1", approverToken);
    await approved("t-2", approverToken);
    await run(["task", "block", "t-2", "--on", "t-1"]);

    // Intervals far past the test's life: only the wake sequence and the
    // work-conserving drain can get t-2 built after t-1 frees it. The watch
    // stops when both are done, however long a loaded machine takes.
    const both = untilDone("t-1", "t-2");
    const code = await run([
      "watch", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool,
      "--for", "60000", "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "3600000",
      "--json",
    ], agent, both.stop).finally(both.close);

    expect(code).toBe(EXIT.ok);
    // Under --json, stdout is EXACTLY one envelope — progress narration
    // belongs to stderr, and one stray write() line beside the envelope is
    // the regression this guards (round-4 finding 12). The backward-scan in
    // payload() would mask it, so parse the whole capture strictly.
    expect(() => JSON.parse(lines.join("\n"))).not.toThrow();
    await run(["task", "show", "t-1", "--json"]);
    expect(payload().task.state).toBe("done");
    await run(["task", "show", "t-2", "--json"]);
    expect(payload().task.state).toBe("done");
  });

  test("reconciliation recovers an unrelated abandoned run while a live provider is still busy", async () => {
    const { runnerToken, approverToken } = await setup();
    await approved("t-live", approverToken);
    await approved("t-orphan", approverToken);
    // One build at a time: t-orphan is the abandoned worker's, not a second lane's.
    saveProjectConcurrency(db, realpathSync(repo), 1);
    let spawns = 0;
    let recoveredDuringBuild = false;
    const busyAgent: Runner = async (_file, args, options) => {
      spawns++;
      const oldToken = registerRunner(db, "abandoned-worker", repo, new Date());
      const observer = openStore(db);
      try {
        const ref = observer.refFor("built-in", "t-orphan").id;
        const now = new Date();
        expect(acquire(observer, ref, "abandoned-worker", { token: oldToken, now, newLeaseId: () => "orphan-lease" }).ok).toBe(true);
        const orphan = observer.startRun({ taskRef: ref, runner: "abandoned-worker", leaseId: "orphan-lease", branch: "standing-orders/t-orphan", worktree: join(pool, "orphan"), now, ...presented(observer, ref, "builder") });
        observer.touchRunner("abandoned-worker", new Date(Date.now() - 10 * 60_000));
        // A bound for a broken recovery, not a timing window: maintenance runs every 25 ms.
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && observer.getRun(orphan)?.outcome === null) await new Promise(resolve => setTimeout(resolve, 10));
        expect(observer.getRun(orphan)).toMatchObject({ outcome: "failed", reason: "interrupted" });
        expect(observer.getTask("t-orphan")?.state).toBe("queued");
        const liveRef = observer.refFor("built-in", "t-live").id;
        expect(observer.runsFor(liveRef), JSON.stringify(observer.getTask("t-live"))).toEqual(expect.arrayContaining([expect.objectContaining({ runner: "builder-1", outcome: null })]));
        recoveredDuringBuild = true;
      } finally {
        observer.close();
      }
      await writeFile(join(options!.cwd!, "guard.ts"), "export const guarded = true;\n");
      await concludeDone(options!.cwd!, args, "completed", "Built while maintenance recovered another task.");
      return { ...OK, stdout: JSON.stringify({ result: "built" }) };
    };
    // The watch stops when t-live is built (an event), not after a fixed window a loaded machine can outrun before the
    // agent even starts; --for is only the hang guard.
    const live = untilDone("t-live");
    const code = await run(["watch", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool,
      "--for", "60000", "--max", "1", "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "25", "--json"], busyAgent, live.stop)
      .finally(live.close);
    expect(code, lines.join("\n")).toBe(EXIT.ok);
    expect(recoveredDuringBuild).toBe(true);
    expect(spawns).toBe(1);
    expect(() => JSON.parse(lines.join("\n"))).not.toThrow();
  });

  test("a bounded watch reports no Toolroll service and leaves the automatic sweep unclaimed", async () => {
    const { runnerToken } = await setup();
    const observer = openStore(db);
    const supervisor = storageSweepSupervisor(db);
    const launch = vi.spyOn(supervisor, "start");
    let checked = false;
    const opened = vi.spyOn(Object.getPrototypeOf(observer), "openedPublications").mockImplementation(() => {
      expect(observer.handle.prepare("SELECT 1 FROM watch_lease WHERE expires_at > ?").get(new Date().toISOString())).toBeDefined();
      expect(sweepSchedule(observer, new Date(), {}).state).toBe("no-service");
      checked = true;
      return [];
    });
    const off = process.env.TOOLROLL_STORAGE_SWEEP;
    delete process.env.TOOLROLL_STORAGE_SWEEP;
    try {
      const code = await run(["watch", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool,
        "--for", "60000", "--json"], agent, () => checked);
      expect(code, lines.join("\n")).toBe(EXIT.ok);
      expect(checked).toBe(true);
      expect(launch).not.toHaveBeenCalled();
      expect(observer.serviceCursor("storage-sweep")).toBe(0);
      expect(lastSweep(observer)).toBeNull();
    } finally {
      launch.mockRestore(); opened.mockRestore(); observer.close();
      if (off === undefined) delete process.env.TOOLROLL_STORAGE_SWEEP; else process.env.TOOLROLL_STORAGE_SWEEP = off;
    }
  });

  test("a hung sweep leaves later reconciliation and CI follow-ups running, and watch stop kills it without waiting", async () => {
    const { runnerToken } = await setup();
    const fake = hangingSweep();
    const hanging = createSweepSupervisor(fake);
    const supervisor = storageSweepSupervisor(db);
    const start = vi.spyOn(supervisor, "start").mockImplementation(hanging.start);
    const busy = vi.spyOn(supervisor, "running", "get").mockImplementation(() => hanging.running);
    const stop = vi.spyOn(supervisor, "stop").mockImplementation(hanging.stop);
    let passes = 0, followups = 0;
    const adopt = WorktreePool.prototype.adopt;
    const adoption = vi.spyOn(WorktreePool.prototype, "adopt").mockImplementation(async function (...args) {
      passes++;
      return adopt.apply(this, args);
    });
    const observer = openStore(db);
    const opened = vi.spyOn(Object.getPrototypeOf(observer), "openedPublications").mockImplementation(() => { followups++; return []; });
    const off = process.env.TOOLROLL_STORAGE_SWEEP;
    delete process.env.TOOLROLL_STORAGE_SWEEP;
    try {
      const code = await run(["watch", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool,
        "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "25", "--json"], agent,
        () => passes >= 3 && followups >= 2);
      expect(code, lines.join("\n")).toBe(EXIT.ok);
      expect(passes).toBeGreaterThanOrEqual(3);
      expect(followups).toBeGreaterThanOrEqual(2);
      expect(fake.launch).toHaveBeenCalledTimes(1);
      expect(fake.signal.mock.calls.map(call => call[1])).toEqual(["SIGKILL"]);
      // The child has never emitted close. Shutdown must already have returned.
      expect(hanging.running).toBe(true);
      expect(lastSweep(observer)!.parts.every(one => one.problem?.includes("stopped"))).toBe(true);
    } finally {
      hanging.stop(); fake.child.emit("close", null);
      start.mockRestore(); busy.mockRestore(); stop.mockRestore(); adoption.mockRestore(); opened.mockRestore(); observer.close();
      if (off === undefined) delete process.env.TOOLROLL_STORAGE_SWEEP; else process.env.TOOLROLL_STORAGE_SWEEP = off;
    }
  });

  test.each([true, false])("failed startup reconciliation pauses dispatch and reports recovery=%s truthfully", async recover => {
    const { runnerToken, approverToken } = await setup();
    await approved("t-paused", approverToken);
    let passes = 0;
    let recovered = false;
    let spawns = 0;
    const original = WorktreePool.prototype.adopt;
    const adoption = vi.spyOn(WorktreePool.prototype, "adopt").mockImplementation(async function (...args) {
      passes++;
      if (!recover || passes === 1) throw new Error("simulated unavailable recovery store");
      const result = await original.apply(this, args);
      recovered = result.ok;
      return result;
    });
    try {
      // Stops on the outcome, not a window: the build once recovery succeeds,
      // or a few failed passes when it never does.
      const built = untilDone("t-paused");
      const code = await run(["watch", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool,
        "--for", "60000", "--max", "1", "--reconcile-every", "25", "--json"], async (...args) => {
        expect(recovered).toBe(true);
        spawns++;
        return agent(...args);
      }, () => recover ? built.stop() : passes >= 3).finally(built.close);
      expect(code, lines.join("\n")).toBe(recover ? EXIT.ok : EXIT.failed);
      expect(spawns).toBe(recover ? 1 : 0);
      expect(passes).toBeGreaterThan(1);
      const report = JSON.parse(lines.join("\n"));
      if (!recover) expect(report).toMatchObject({ reason: "reconciliation-failed", ticks: 0 });
    } finally { adoption.mockRestore(); }
  });

  test("legacy queued reviews retire without agent calls, verdict changes or retry loops", async () => {
    const { runnerToken, approverToken } = await setup();
    await approved("t-reviewed", approverToken);
    const tickArgs = ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"];
    expect(await run(tickArgs)).toBe(EXIT.ok);
    await run(["task", "show", "t-reviewed", "--json"]);
    const source = payload().runs.find((one: { role: string }) => one.role === "builder");
    const saved = openStore(db);
    const originalProof = saved.proofVerdictFor(source.id);
    const originalRun = saved.getRun(source.id);
    const asked = saved.requestReview(source.id, "alex", T0);
    expect(asked.ok).toBe(true);
    if (!asked.ok) throw new Error(asked.reason);
    saved.close();
    let calls = 0;
    const unexpectedAgent: Runner = async () => { calls++; throw new Error("no model review may start"); };
    expect(await run(["tick", "--runner", "builder-1", "--token", "invalid", "--repo", repo, "--pool", pool, "--json"], unexpectedAgent)).toBe(EXIT.refused);
    let check = openStore(db);
    expect(check.openReviewRequests().map(one => one.id)).toContain(asked.id);
    check.close();
    await run(tickArgs, unexpectedAgent);
    await run(tickArgs, unexpectedAgent);
    expect(calls).toBe(0);
    check = openStore(db);
    expect(check.openReviewRequests()).toEqual([]);
    expect(check.raw().prepare("SELECT consumed_reason FROM review_request WHERE id = ?").get(asked.id)).toMatchObject({ consumed_reason: "model-review-retired" });
    expect(check.proofVerdictFor(source.id)).toEqual(originalProof);
    expect(check.getRun(source.id)).toEqual(originalRun);
    expect(check.runsFor(source.taskRef).filter(one => one.role === "reviewer")).toEqual([]);
    check.close();
    expect(await run(["task", "review", String(source.id), "--as", "alex", "--token", approverToken, "--json"])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "model-review-retired" });
  });

  test("a watch is an episode, and the brief can bound itself to exactly one night", async () => {
    const { runnerToken, approverToken } = await setup();
    await approved("t-1", approverToken);

    const built = untilDone("t-1");
    await run([
      "watch", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool,
      "--for", "60000", "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "3600000",
      "--json",
    ], agent, built.stop).finally(built.close);

    const store = openStore(db);

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const episode = store.latestWatchEpisode(realpathSync(repo));
    store.close();
    expect(episode).not.toBeNull();
    expect(episode?.endedAt).not.toBeNull();
    expect(episode?.runner).toBe("builder-1");
    expect(episode?.built).toBeGreaterThanOrEqual(1);

    // The brief, bounded to that night — its runs, its window, said so.
    const code = await run(["brief", "--latest-watch", "--local", "--repo", repo, "--json"]);
    expect(code).toBe(EXIT.ok);
    expect(payload().episode).toMatchObject({ id: episode?.id, runner: "builder-1" });
    expect(payload().since).toBe(episode?.startedAt);
    expect(payload().tally.built.length).toBeGreaterThanOrEqual(1);
  });

  test("watch + watch is a loud refusal; the lease names the holder", async () => {
    const { runnerToken } = await setup();
    const store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    store.acquireWatchLease("builder-1", realpathSync(repo), "someone-else", 60_000, new Date());
    store.close();

    const code = await run([
      "watch", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool,
      "--for", "300", "--json",
    ]);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "watch-busy" });
  });

  test("Never Stuck certification: a successor recovers a crashed worker, proves one result, and never duplicates it", async () => {
    const { runnerToken, approverToken } = await setup();
    const criterion = "The recovered task commits the requested guard file.";
    await approved("t-1", approverToken, `${criterion}|changed-path`);

    // The predecessor: an expired watch lease and a claim it never released,
    // its task stranded mid-flight — the crash liveness cannot see, because
    // the runner name will be back and heartbeating immediately.
    const store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const ref = store.refFor("built-in", "t-1").id;
    const past = new Date(Date.now() - 10 * 60_000);
    store.acquireWatchLease("builder-1", realpathSync(repo), "inc-dead", 1_000, past);
    acquire(store, ref, "builder-1", {
      token: runnerToken, now: past, ttlMs: 60 * 60_000, newLeaseId: () => "lease-dead", incarnation: "inc-dead",
    });
    store.setTaskState("t-1", "running", past);
    store.startRun({
      taskRef: ref, leaseId: "lease-dead", runner: "builder-1", branch: "standing-orders/t-1",
      worktree: join(pool, "x"), now: past,
      ...presented(store, ref, "builder"),
    });
    store.close();

    const recoveryAgent: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
      await concludeDone(cwd, args, "completed", "Recovered the interrupted task and added the guard.");
      await proveChangedPath(cwd, args, criterion, "guard.ts");
      return { ...OK, stdout: JSON.stringify({ result: "Recovered the interrupted task and added the guard." }) };
    };
    const recovered = untilDone("t-1");
    const code = await run([
      "watch", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool,
      "--for", "60000", "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "3600000",
      "--json",
    ], recoveryAgent, recovered.stop).finally(recovered.close);

    expect(code).toBe(EXIT.ok);
    // The dead incarnation's claim was recovered, and the task then built.
    const after = openStore(db);
    try {
      const claim = after.handle.prepare("SELECT released_by FROM claim WHERE lease_id = 'lease-dead'").get();
      expect(String(claim?.["released_by"])).toBe("recovered");
      expect(after.getTask("t-1")?.state).toBe("done");
      const interrupted = after.handle
        .prepare("SELECT COUNT(*) AS n FROM run WHERE reason = 'interrupted'")
        .get();
      expect(Number(interrupted?.["n"])).toBe(1);
      const runs = after.runsFor(ref);
      expect(runs).toHaveLength(2);
      expect(runs.map(one => one.outcome).sort()).toEqual(["built", "failed"]);
      const built = runs.find(one => one.outcome === "built");
      expect(built).toBeDefined();
      expect(after.proofVerdictFor(built?.id ?? -1)?.verdict).toBe("attested");
      expect(after.artifactsFor(built?.id ?? -1).map(one => one.kind)).toEqual(expect.arrayContaining(["handoff", "terminal-diff", "diff-stat", "proof"]));
      const claims = after.handle.prepare("SELECT lease_id, released_at, released_by FROM claim WHERE task_ref = ? ORDER BY lease_generation").all(ref);
      expect(claims).toHaveLength(2);
      expect(claims.every(one => one["released_at"] !== null)).toBe(true);
      expect(claims.filter(one => one["released_by"] === "completed")).toHaveLength(1);
    } finally {
      after.close();
    }

    // A later pass converges: the accepted result cannot be built again.
    const second = await run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"], recoveryAgent);
    expect(second).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });
  });
});
