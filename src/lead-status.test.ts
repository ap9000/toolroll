import { HEADLINES } from "./task-status.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationStatus, renderInstallationStatus, renderTaskWait, taskWaitSnapshot } from "./lead-status.js";
import { runOperate } from "./operate.js";
import { BUILT_IN, openStore, type Store } from "./store.js";

const NOW = new Date("2026-09-28T18:00:00.000Z");
const LATER = new Date("2026-09-28T18:05:00.000Z");

describe("lead status commands", () => {
  let dir: string;
  let db: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "standing-orders-lead-status-"));
    db = join(dir, "orders.db");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const create = (store: Store, id: string, state: "queued" | "running" | "done" | "failed" = "queued"): number => {
    store.createTask({ id, title: id }, NOW);
    if (state !== "queued") expect(store.setTaskState(id, state, NOW)).toEqual({ ok: true });
    return store.refFor(BUILT_IN, id).id;
  };

  const run = (store: Store, taskRef: number, options: {
    lease?: string;
    phase?: string;
    outcome?: "built" | "failed" | null;
    quality?: "default" | "strict";
    finished?: boolean;
  } = {}): number => {
    const outcome = options.outcome ?? null;
    const finished = options.finished ?? outcome !== null;
    return Number(store.handle.prepare(`INSERT INTO run
      (task_ref, lease_id, runner, branch, worktree, role, quality_mode, phase, outcome, reason, started_at, finished_at)
      VALUES (?, ?, 'worker-1', 'standing-orders/test', '/tmp/status-test', 'builder', ?, ?, ?, ?, ?, ?)`)
      .run(taskRef, options.lease ?? `lease-${taskRef}`, options.quality ?? "default", options.phase ?? null,
        outcome, outcome === "failed" ? "agent-failed" : null, NOW.toISOString(), finished ? LATER.toISOString() : null).lastInsertRowid);
  };

  const draft = (store: Store, id: string, approved: boolean): void => {
    store.handle.prepare("UPDATE task_ref SET plan = 'drafted' WHERE backend = ? AND external_id = ?").run(BUILT_IN, id);
    store.handle.prepare(`INSERT INTO task_scope
      (task_id, goal, proposed_at, digest, profile_state, approved_at, approved_by, approved_digest)
      VALUES (?, 'Update the labels', ?, 'current-scope', 'resolved', ?, ?, ?)`)
      .run(id, NOW.toISOString(), approved ? NOW.toISOString() : null, approved ? "alex" : null, approved ? "current-scope" : null);
  };

  test("status gives one deprecation warning for both legacy webhooks, without their secrets", async () => {
    const lines: string[] = [];
    const options = { databaseFile: db, clock: () => NOW, releaseIo: { fetch: async () => { throw Error("offline"); } } };
    await runOperate("status", [], line => lines.push(line), options);
    expect(lines.join("\n")).not.toContain("Legacy webhooks");
    for (const service of ["slack", "discord"]) await writeFile(join(dir, `${service}-webhook`), `https://fixture.example/${service}-secret`);
    lines.length = 0;
    await runOperate("status", [], line => lines.push(line), options);
    expect(lines.join("\n").split("\n").filter(line => line.includes("Legacy webhooks"))).toEqual(["Legacy webhooks are deprecated. Connect Slack or Discord in Chat settings."]);
    expect(lines.join("\n")).not.toContain("fixture.example");
    lines.length = 0;
    await runOperate("status", ["--json"], line => lines.push(line), options);
    expect(JSON.parse(lines.join("\n")).legacyWebhookWarning).toBe("Legacy webhooks are deprecated. Connect Slack or Discord in Chat settings.");
  });

  test("task wait returns 0 after the attempt it observed becomes ready", async () => {
    const seed = openStore(db);
    const ref = create(seed, "ready-after-wait", "running");
    draft(seed, "ready-after-wait", true);
    const runId = run(seed, ref, { phase: "verifying-proof" });
    seed.close();

    const lines: string[] = [];
    let settled = false;
    const code = await runOperate("task", ["wait", "ready-after-wait", "--timeout", "1"], line => lines.push(line), {
      databaseFile: db,
      waitSleep: async () => {
        if (settled) return;
        settled = true;
        const update = openStore(db);
        update.recordRunCheck(runId, { status: "passed", exitCode: 0, suites: [{ name: "Tests", status: "passed", exitCode: 0 }] });
        update.handle.prepare("UPDATE run SET outcome = 'built', committed = 1, reason = 'built', finished_at = ? WHERE id = ?").run(LATER.toISOString(), runId);
        expect(update.setTaskState("ready-after-wait", "done", LATER)).toEqual({ ok: true });
        update.close();
      },
    });

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`Ready | run #${runId} | checks passed (exit 0) | next: Open result`);
  });

  test("task wait follows a retry that lands between polls and reports the retry's own outcome", async () => {
    const seed = openStore(db);
    const ref = create(seed, "retried-while-waiting", "running");
    const firstRun = run(seed, ref, { phase: "agent-running" });
    seed.close();

    let retryRun = 0;
    let settled = false;
    const lines: string[] = [];
    const code = await runOperate("task", ["wait", "retried-while-waiting", "--timeout", "1", "--json"], line => lines.push(line), {
      databaseFile: db,
      waitSleep: async () => {
        if (settled) return;
        settled = true;
        const update = openStore(db);
        update.handle.prepare("UPDATE run SET outcome = 'failed', reason = 'agent-failed', finished_at = ? WHERE id = ?").run(LATER.toISOString(), firstRun);
        retryRun = run(update, ref, { outcome: "built" });
        update.recordRunCheck(retryRun, { status: "passed", exitCode: 0, suites: [{ name: "Tests", status: "passed", exitCode: 0 }] });
        expect(update.setTaskState("retried-while-waiting", "done", LATER)).toEqual({ ok: true });
        update.close();
      },
    });

    expect(code).toBe(0);
    expect(retryRun).toBeGreaterThan(firstRun);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, outcome: "Ready", run: retryRun, replacedRun: firstRun, check: { status: "passed" } });

    const reader = openStore(db);
    try {
      const snapshot = taskWaitSnapshot(reader, "retried-while-waiting", LATER, firstRun);
      expect(snapshot).not.toBeNull();
      expect(renderTaskWait(snapshot!)).toBe(`Ready | run #${retryRun}, a retry that replaced run #${firstRun} | checks passed (exit 0) | next: Open result`);
    } finally {
      reader.close();
    }
  });

  test("task wait reports a failed retry as failed even when the task has moved on", async () => {
    const seed = openStore(db);
    const ref = create(seed, "retry-failed", "running");
    const firstRun = run(seed, ref, { outcome: "built" });
    const retryRun = run(seed, ref, { outcome: "failed" });
    seed.close();

    const reader = openStore(db);
    try {
      const snapshot = taskWaitSnapshot(reader, "retry-failed", LATER, firstRun);
      expect(snapshot).toMatchObject({ outcome: "Failed", run: retryRun, replacedRun: firstRun, exitCode: 1, terminal: true });
      const same = taskWaitSnapshot(reader, "retry-failed", LATER, retryRun);
      expect(same).toMatchObject({ outcome: "Failed", run: retryRun, replacedRun: null, exitCode: 1 });
    } finally {
      reader.close();
    }
  });

  test("task wait returns 1 for failure and when a person is needed", async () => {
    const seed = openStore(db);
    const failedRef = create(seed, "failed-task", "failed");
    const failedRun = run(seed, failedRef, { outcome: "failed" });
    seed.recordRunCheck(failedRun, { status: "failed", exitCode: 1, suites: [{ name: "Tests", status: "failed", exitCode: 1 }] });
    create(seed, "needs-scope");
    seed.close();

    const failed: string[] = [];
    expect(await runOperate("task", ["wait", "failed-task"], line => failed.push(line), { databaseFile: db, now: NOW })).toBe(1);
    expect(failed).toEqual([`Failed | run #${failedRun} | checks failed (exit 1) | next: Inspect failure`]);

    const needsPerson: string[] = [];
    expect(await runOperate("task", ["wait", "needs-scope"], line => needsPerson.push(line), { databaseFile: db, now: NOW })).toBe(1);
    expect(needsPerson).toEqual(["Needs a person | no run | checks unknown | next: Add scope"]);
  });

  test("task wait keeps a failed check visible while a ready result still exits 0", async () => {
    const seed = openStore(db);
    const ref = create(seed, "ready-with-failed-check");
    const runId = run(seed, ref, { outcome: "built", quality: "strict" });
    seed.recordRunCheck(runId, {
      status: "failed",
      exitCode: 1,
      suites: [{ name: "Tests", status: "failed", exitCode: 1 }],
    });
    expect(seed.setTaskState("ready-with-failed-check", "done", LATER)).toEqual({ ok: true });
    seed.close();

    const lines: string[] = [];
    expect(await runOperate("task", ["wait", "ready-with-failed-check"], line => lines.push(line), { databaseFile: db, now: NOW })).toBe(0);
    expect(lines).toEqual([`Ready | run #${runId} | checks failed (exit 1) | next: Open result`]);
  });

  test("task wait returns 2 with one status line on timeout", async () => {
    const seed = openStore(db);
    const ref = create(seed, "still-running", "running");
    const runId = run(seed, ref, { phase: "agent-running" });
    seed.close();

    const lines: string[] = [];
    expect(await runOperate("task", ["wait", "still-running", "--timeout", "0"], line => lines.push(line), { databaseFile: db, now: NOW })).toBe(2);
    expect(lines).toEqual([`Timed out | run #${runId} | checks unknown | next: Wait — agent working`]);
  });

  test("approved drafted plans wait for a worker; unapproved or changed plans still need review", () => {
    const store = openStore(":memory:");
    try {
      for (const id of ["approved", "unapproved", "changed", "incomplete"]) {
        create(store, id);
        draft(store, id, id !== "unapproved");
      }
      store.handle.prepare("UPDATE task_scope SET digest = 'new-scope' WHERE task_id = 'changed'").run();
      store.handle.prepare("UPDATE task_scope SET approved_at = NULL WHERE task_id = 'incomplete'").run();
      const status = installationStatus(store, NOW);
      expect(status.queued).toMatchObject({ count: 4 });
      expect(status.queued.tasks).toContainEqual({ task: "approved", reason: "ready for a worker" });
      expect(taskWaitSnapshot(store, "approved", NOW)).toMatchObject({ outcome: "Queued", next: "Wait for a worker", terminal: false });
      for (const id of ["unapproved", "changed", "incomplete"]) {
        expect(status.queued.tasks).toContainEqual({ task: id, reason: "needs plan review" });
        expect(taskWaitSnapshot(store, id, NOW)).toMatchObject({ outcome: "Needs a person", next: "Approve plan", terminal: true });
      }
    } finally { store.close(); }
  });

  test("live attempts appear only under Building, including those beyond the display limit", () => {
    const store = openStore(":memory:");
    try {
      for (let i = 0; i < 10; i++) {
        const id = `building-${i}`;
        const ref = create(store, id); // Dispatch can leave the task row queued.
        if (i % 2 === 0) draft(store, id, true);
        const runId = run(store, ref, { phase: "agent-running" });
        store.handle.prepare(`INSERT INTO claim
          (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at)
          VALUES (?, ?, 1, 'worker-1', ?, ?, ?)`)
          .run(`lease-${ref}`, ref, NOW.toISOString(), LATER.toISOString(), NOW.toISOString());
        expect(taskWaitSnapshot(store, id, NOW)).toMatchObject({ outcome: "Running", run: runId, terminal: false });
      }
      const status = installationStatus(store, NOW);
      expect(status.running).toMatchObject({ count: 10 });
      expect(status.running.tasks).toHaveLength(8);
      expect(status.queued).toEqual({ count: 0, reasons: [], tasks: [] });
      expect(renderInstallationStatus(status)).toContain("Queued: none");

      // Current scope changes cannot send wait back to approval mid-attempt.
      store.handle.prepare("UPDATE task_scope SET digest = 'edited-after-admission' WHERE task_id = 'building-0'").run();
      expect(taskWaitSnapshot(store, "building-0", NOW)).toMatchObject({ outcome: "Running", terminal: false });
      // A real operator hold still needs attention.
      store.hold(store.refFor(BUILT_IN, "building-0").id, "Pause this work", null, NOW);
      expect(taskWaitSnapshot(store, "building-0", NOW)).toMatchObject({ outcome: "Needs a person", next: "Remove hold" });
      // Released/expired claims are not Building and must not disappear from status.
      store.handle.prepare("UPDATE claim SET released_at = ? WHERE task_ref = ?").run(NOW.toISOString(), store.refFor(BUILT_IN, "building-1").id);
      store.handle.prepare("UPDATE claim SET expires_at = ? WHERE task_ref = ?").run(NOW.toISOString(), store.refFor(BUILT_IN, "building-2").id);
      const after = installationStatus(store, NOW);
      expect(after.running.count).toBe(8);
      expect(after.queued.count).toBe(2);
      expect(after.queued.tasks.map(one => one.task)).toEqual(["building-1", "building-2"]);
    } finally { store.close(); }
  });

  test("check summaries live in run_check, first write wins, and only Strict runs are release checks", async () => {
    const seed = openStore(db);
    const columns = (seed.handle.prepare("SELECT name FROM pragma_table_info('run')").all() as { name: string }[]).map(one => one.name);
    expect(columns.filter(name => name.startsWith("check_"))).toEqual([]);

    const ref = create(seed, "ordinary-build", "done");
    const ordinary = run(seed, ref, { outcome: "built" });
    seed.recordRunCheck(ordinary, { status: "passed", exitCode: 0, suites: [] });
    seed.recordRunCheck(ordinary, { status: "failed", exitCode: 1, suites: [] });
    expect(seed.runCheckFor(ordinary)).toEqual({ status: "passed", exitCode: 0, suites: [] });
    expect(seed.handle.prepare("SELECT release FROM run_check WHERE run = ?").get(ordinary)).toEqual({ release: 0 });
    expect(seed.runCheckFor(ordinary + 1)).toBeNull();
    expect(() => seed.recordRunCheck(ordinary, { status: "passed", exitCode: -1, suites: [] })).toThrow("non-negative");
    seed.close();

    const lines: string[] = [];
    expect(await runOperate("status", [], line => lines.push(line), { databaseFile: db, now: NOW })).toBe(0);
    expect(lines.join("\n").split("\n")).toContain("Release check: none recorded");
  });

  test("status includes running phases, queued reasons, review results, the release suites and plan windows", async () => {
    const seed = openStore(db);
    const runningRef = create(seed, "running-check", "running");
    const runningRun = run(seed, runningRef, { lease: "lease-live", phase: "verifying-proof" });
    seed.handle.prepare(`INSERT INTO claim
      (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at)
      VALUES ('lease-live', ?, 1, 'worker-1', ?, ?, ?)`)
      .run(runningRef, NOW.toISOString(), new Date(NOW.getTime() + 60 * 60_000).toISOString(), NOW.toISOString());

    create(seed, "needs-scope");
    const heldRef = create(seed, "held-task");
    seed.hold(heldRef, "Waiting for the operator", null, NOW);

    const readyRef = create(seed, "ready-result");
    const releaseRun = run(seed, readyRef, { outcome: "built", quality: "strict" });
    seed.recordRunCheck(releaseRun, {
      status: "passed",
      exitCode: 0,
      suites: [
        { name: "Typecheck", status: "passed", exitCode: 0 },
        { name: "Tests", status: "passed", exitCode: 0 },
      ],
    });
    expect(seed.setTaskState("ready-result", "done", LATER)).toEqual({ ok: true });
    seed.recordProviderLimits({
      provider: "codex",
      plan: "team",
      windows: [{ window: "five_hour", usedPercent: 42, windowMinutes: 300, resetsAt: null, reached: false }],
    }, NOW);
    seed.close();

    const jsonLines: string[] = [];
    expect(await runOperate("status", ["--json"], line => jsonLines.push(line), { databaseFile: db, now: NOW })).toBe(0);
    const body = JSON.parse(jsonLines.join("\n")) as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.running).toMatchObject({ count: 1, phases: [{ phase: "running checks", count: 1 }] });
    expect(body.running.tasks).toEqual([{ task: "running-check", run: runningRun, phase: "running checks" }]);
    expect(body.queued).toMatchObject({ count: 2 });
    expect(body.queued.tasks).toEqual(expect.arrayContaining([
      { task: "needs-scope", reason: "needs a scope" },
      { task: "held-task", reason: "on hold" },
    ]));
    expect(body.queued.reasons).toEqual(expect.arrayContaining([
      { reason: "needs a scope", count: 1 },
      { reason: "on hold", count: 1 },
    ]));
    // A result with no approved scope or commit is not Ready for review: the
    // count reads the same projection as the Tasks list, which says Needs you.
    expect(body.waitingForReview).toEqual({ count: 0, results: [] });
    expect(body.tasks.find((one: { task: string }) => one.task === "ready-result")?.headline).toBe("Needs you");
    expect(body.releaseCheck).toMatchObject({ task: "ready-result", run: releaseRun, check: { status: "passed", exitCode: 0 } });
    expect(body.releaseCheck.check.suites).toEqual([
      { name: "Typecheck", status: "passed", exitCode: 0 },
      { name: "Tests", status: "passed", exitCode: 0 },
    ]);
    expect(body.planWindows).toMatchObject([{ provider: "codex", plan: "team", window: "five_hour", usedPercent: 42 }]);

    const textLines: string[] = [];
    expect(await runOperate("status", [], line => textLines.push(line), { databaseFile: db, now: NOW })).toBe(0);
    const report = textLines.join("\n").split("\n");
    // Each task's one shared headline leads (task-status.ts); the bounded aggregate follows.
    expect(report[0]).toBe("Tasks:");
    const taskLines = report.slice(1, 1 + body.tasks.length);
    expect(taskLines.length).toBeGreaterThan(0);
    for (const line of taskLines) expect(HEADLINES.some(headline => line.startsWith(`  ${headline}`)), line).toBe(true);
    expect(report.length - taskLines.length - 1).toBeLessThanOrEqual(12);
    expect(report).toEqual(expect.arrayContaining([
      `Building: 1 — running-check (#${runningRun}, running checks)`,
      "Ready for review: none",
      `Release check: ready-result #${releaseRun} — passed (exit 0)`,
      "  Suites: Typecheck passed (exit 0); Tests passed (exit 0)",
      "Plan windows: codex team — 5-hour 42%",
    ]));
    expect(report.find(line => line.startsWith("Queued: 2 —"))).toContain("held-task (on hold)");
    expect(report.find(line => line.startsWith("Queued: 2 —"))).toContain("needs-scope (needs a scope)");
  });

  test("a ready task with no saved result run is named without a run number", () => {
    const store = openStore(":memory:");
    try {
      const status = installationStatus(store, NOW);
      const lines = renderInstallationStatus({ ...status, waitingForReview: { count: 2, results: [
        { task: "no-result", run: null, check: { status: "unknown", exitCode: null, suites: [] } },
        { task: "with-result", run: 41, check: { status: "passed", exitCode: 0, suites: [] } },
      ] } });
      expect(lines).toContain("Ready for review: 2 — no-result, with-result (#41)");
      expect(lines.join("\n")).not.toContain("#0");
    } finally { store.close(); }
  });
});
