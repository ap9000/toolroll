/**
 * Safe task stop and resume (v52): the store's exact-run stop, the fenced
 * interruption seal, both orders of stop versus success, stale and
 * replayed actions against a successor, resume's quiescence gate and
 * hold precision, and the restart settlements — every one deterministic,
 * against real transactions.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as childProcess from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { acquire, interruptIfStopped, release, finalize } from "./claim.js";
import { disposeBuildOutcome } from "./dispose.js";
import { requestTaskStop, resumeTaskStop, taskControlOf, stopRequestedFor } from "./task-control.js";
import { diagnoseTaskDispatch } from "./dispatch.js";
import { taskReadinessBlocker } from "./dispatch.js";
import { workIndexPage } from "./work-index.js";
import { repairStaleStatuses } from "./lead-status.js";
import { fakePid } from "../test/fake-pid.js";

const T0 = new Date("2026-09-12T08:00:00.000Z");
vi.mock("node:child_process", { spy: true });
const later = (ms: number) => new Date(T0.getTime() + ms);
const REPO = resolve("/repo/stop");
const tok = (name: string) => `tok-${name}`;

const presented = (
  s: Pick<Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  const authority = s.routeAuthorityFor(taskRef, role) ?? s.routeAuthorityFor(taskRef, role, { provider: "claude", model: null });
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

function approveScopeFor(store: Store, taskId: string): string {
  for (const phase of ["plan", "build", "review"]) {
    if (store.phaseConfig("installation", phase) === null) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  }
  const added = addApprover(store, "alex", T0);
  const token = added.ok ? added.token : (approverTokens.get(store) as string);
  approverTokens.set(store, token);
  propose(store, { taskId, goal: "the work", now: T0 });
  const scope = store.getScope(taskId);
  if (scope === null) throw new Error("propose filed nothing");
  const approved = approve(store, taskId, "alex", T0, scope.digest, token);
  if (!approved.ok) throw new Error(`the fixture approval was refused: ${approved.reason}`);
  return token;
}
const approverTokens = new WeakMap<Store, string>();

/** A leased, running builder attempt on a placed, approved task. */
function runningAttempt(store: Store, taskId: string, lease = `lease-${taskId}`): { taskRef: number; leaseId: string; runId: number; worktree: string } {
  store.createTask({ id: taskId, title: `work ${taskId}` }, T0);
  const taskRef = store.refFor("built-in", taskId).id;
  store.placeTask(taskRef, REPO);
  approveScopeFor(store, taskId);
  const claimed = acquire(store, taskRef, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: () => lease });
  if (!claimed.ok) throw new Error(`claim refused: ${claimed.reason}`);
  const worktree = `/pool/${taskId}`;
  const runId = store.startRun({ taskRef, leaseId: lease, runner: "runner-a", branch: `standing-orders/${taskId}`, worktree, now: T0, ...presented(store, taskRef, "builder") });
  return { taskRef, leaseId: lease, runId, worktree };
}

const disposeContext = (store: Store, a: { taskRef: number; leaseId: string; runId: number; worktree: string }, taskId: string, now: Date) => ({
  store,
  policy: "tick" as const,
  leaseId: a.leaseId,
  runId: a.runId,
  taskId,
  taskRef: a.taskRef,
  runner: "runner-a",
  repo: REPO,
  branch: `standing-orders/${taskId}`,
  origin: "ours" as const,
  provider: "claude",
  model: "sonnet",
  worktreePath: a.worktree,
  clock: () => now,
});

describe("safe task stop and resume (v52)", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    for (const name of ["runner-a", "runner-b"]) {
      register(store, { name, host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => tok(name) });
    }
  });
  afterEach(() => store.close());

  test.each([false, true])("quiescence trusts recorded process and group exits while approver settlement keeps its group probe (group=%s)", group => {
    const a = runningAttempt(store, "t-exit-reused"), pid = fakePid(1);
    store.recordRunProcess(a.runId, pid, T0, group);
    const before = store.raw().prepare("SELECT * FROM run_process WHERE run=?").get(a.runId)!;
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const ps = vi.mocked(childProcess.execFileSync).mockReturnValue("Sat Sep 12 08:00:00 2026\n");
    try {
      expect(store.recordRunProcessExits(a.runId, later(100), { pid, group })).toBe(1);
      const ended = store.raw().prepare("SELECT * FROM run_process WHERE run=?").get(a.runId);
      expect(ended).toEqual({ ...before, exited_at: later(100).toISOString() });
      // An unrelated service takes the same number while the builder continues.
      kill.mockReturnValue(true);
      store.finishRun(a.runId, { outcome: "built", now: later(1000) });
      expect(store.stopQuiescenceFact(a.runId)).toBeNull();
      const settled = store.settleRunWitnessesByApprover({ runId: a.runId, by: "alex", why: "The check ended." }, later(2000));
      if (group) {
        expect(settled).toMatchObject({ ok: false, reason: "alive" });
      } else {
        expect(store.stopQuiescenceProblem(a.runId)).toBeNull();
        expect(settled).toMatchObject({ ok: true, repeated: true });
      }
      expect(store.recordRunProcessExits(a.runId, later(2000))).toBe(0);
      expect(store.raw().prepare("SELECT * FROM run_process WHERE run=?").get(a.runId)).toEqual(ended);
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally { kill.mockRestore(); ps.mockReset(); }
  });

  test("an exited group whose PGID is reused before run end does not block quiescence", () => {
    const a = runningAttempt(store, "t-group-exit-before-finish"), pid = fakePid(2);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const ps = vi.mocked(childProcess.execFileSync).mockClear().mockReturnValue("Sat Sep 12 08:10:00 2026\n");
    try {
      store.recordRunProcess(a.runId, pid, T0, true);
      expect(store.recordRunProcessExits(a.runId, later(1000))).toBe(1);
      expect(kill).toHaveBeenCalledWith(-pid, 0);
      const ended = store.raw().prepare("SELECT * FROM run_process WHERE run=?").get(a.runId);
      // The original group was proven gone before this unrelated group was
      // born. Its birth still predates run end, so birth lookup cannot help.
      kill.mockReturnValue(true);
      store.finishRun(a.runId, { outcome: "built", now: later(11 * 60_000) });
      kill.mockClear();
      expect(store.stopQuiescenceFact(a.runId)).toBeNull();
      expect(kill).not.toHaveBeenCalled();
      expect(ps).not.toHaveBeenCalled();
      expect(store.raw().prepare("SELECT * FROM run_process WHERE run=?").get(a.runId)).toEqual(ended);
    } finally { kill.mockRestore(); ps.mockReset(); Object.defineProperty(process, "platform", platform); }
  });

  test("a PID reused after its recorded exit but before run end cannot delay automatic settlement", () => {
    const a = runningAttempt(store, "t-exit-before-finish"), pid = fakePid(2);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const ps = vi.mocked(childProcess.execFileSync).mockClear().mockReturnValue("Sat Sep 12 08:10:00 2026\n");
    try {
      store.recordRunProcess(a.runId, pid, T0, false);
      store.recordRunProcessExits(a.runId, later(1000));
      const unknown = store.reserveRunProcess(a.runId, later(2000));
      kill.mockClear().mockReturnValue(true);
      store.finishRun(a.runId, { outcome: "built", now: later(11 * 60_000) });
      expect(store.raw().prepare("SELECT exited_at FROM run_process WHERE id=?").get(unknown)?.exited_at).toBe(later(11 * 60_000).toISOString());
      expect(store.stopQuiescenceFact(a.runId)).toBeNull();
      expect(store.settleRunWitnessesByApprover({ runId: a.runId, by: "alex", why: "Check ended." }, later(12 * 60_000))).toMatchObject({ ok: true });
      expect(kill).not.toHaveBeenCalled();
      expect(ps).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); ps.mockReset(); Object.defineProperty(process, "platform", platform); }
  });

  test.each(["live", "orphan-group", "EPERM", "EIO"])("exit recording retains %s custody", state => {
    // These are POSIX group semantics even when this fixture runs on Windows.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const a = runningAttempt(store, "t-exit-unknown");
    store.recordRunProcess(a.runId, fakePid(1), T0, true);
    const before = store.raw().prepare("SELECT * FROM run_process WHERE run=?").all(a.runId);
    const kill = vi.spyOn(process, "kill").mockImplementation(target => {
      if (state === "live" || (state === "orphan-group" && target < 0)) return true;
      throw Object.assign(new Error(state), { code: state === "orphan-group" ? "ESRCH" : state });
    });
    try {
      expect(store.recordRunProcessExits(a.runId, later(100))).toBe(0);
      store.finishRun(a.runId, { outcome: "built", now: later(1000) });
      expect(store.stopQuiescenceFact(a.runId)?.kind).toBe("alive");
      expect(store.raw().prepare("SELECT * FROM run_process WHERE run=?").all(a.runId)).toEqual(before);
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally { kill.mockRestore(); Object.defineProperty(process, "platform", platform); }
  });

  test("exit recording retains incomplete, foreign, future and unproven native witnesses", () => {
    const a = runningAttempt(store, "t-exit-scope");
    store.reserveRunProcess(a.runId, T0);
    for (const [host, observed, backend, container] of [
      ["different-host", T0.toISOString(), null, null],
      [hostname(), later(2000).toISOString(), null, null],
      [hostname(), T0.toISOString(), "unknown-native", "owned-object"],
      [hostname(), T0.toISOString(), "unknown-native", null],
    ]) store.raw().prepare(`INSERT INTO run_process(run,pid,host,process_group,observed_at,containment,container) VALUES(?,${fakePid(1)},?,0,?,?,?)`)
      .run(a.runId, host!, observed!, backend!, container!);
    const before = store.raw().prepare("SELECT * FROM run_process WHERE run=?").all(a.runId);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    try {
      expect(store.recordRunProcessExits(a.runId, later(100))).toBe(0);
      expect(store.raw().prepare("SELECT * FROM run_process WHERE run=?").all(a.runId)).toEqual(before);
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });

  test.each([false, true])("quiescence dismisses only proven reuse across successful and EPERM probes without changing retained rows (group=%s)", group => {
    const a = runningAttempt(store, "t-reused");
    store.finishRun(a.runId, { outcome: "failed", reason: "interrupted", now: later(1_000) });
    store.raw().prepare("INSERT INTO run_process(run,pid,host,process_group,observed_at) VALUES(?,?,?,?,?)")
      .run(a.runId, fakePid(3), hostname(), group ? 1 : 0, T0.toISOString());
    const rows = () => store.raw().prepare("SELECT * FROM run_process WHERE run = ?").all(a.runId);
    const before = rows();
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const kill = vi.spyOn(process, "kill").mockImplementation(target => {
      if (target < 0) throw Object.assign(new Error("no group"), { code: "ESRCH" });
      return true;
    });
    const ps = vi.mocked(childProcess.execFileSync).mockReturnValue("Mon Sep 14 14:33:43 2026\n");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-15T00:00:00.000Z"));
    try {
      expect(store.stopQuiescenceProblem(a.runId)).toBeNull();
      ps.mockReturnValue("");
      expect(store.stopQuiescenceProblem(a.runId)).toContain("may still be running");
      ps.mockReturnValue("Sat Sep 12 08:00:00 2026\n");
      expect(store.stopQuiescenceProblem(a.runId)).toContain("may still be running");
      ps.mockReturnValue("Mon Sep 14 14:33:43 2026\n");
      if (group) {
        kill.mockReturnValue(true);
        expect(store.stopQuiescenceProblem(a.runId)).toBeNull();
      }
      kill.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
      expect(store.stopQuiescenceProblem(a.runId)).toBeNull();
      ps.mockImplementation(() => { throw Object.assign(new Error("birth denied"), { code: "EPERM" }); });
      expect(store.stopQuiescenceProblem(a.runId)).toContain("may still be running");
      expect(rows()).toEqual(before);
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally {
      kill.mockRestore(); ps.mockReset(); clock.mockRestore();
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  test("a fresh file is born at the current schema with the run_stop table and a hold that admits the stop owner", () => {
    expect(SCHEMA_VERSION).toBe(119);
    expect(Number(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"])).toBe(SCHEMA_VERSION);
    expect(store.raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_stop'").get()).toBeDefined();
    const ddl = String(store.raw().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hold'").get()?.["sql"]);
    expect(ddl).toContain("'revision','stop'");
  });

  test("c1: a stop names one exact live run, records who asked and when, is idempotent, and refuses stale targets in words", () => {
    const a = runningAttempt(store, "t-a");
    const b = runningAttempt(store, "t-b");
    // Wrong task: the run is b's, the request names a.
    expect(requestTaskStop(store, { taskId: "t-a", runId: b.runId, by: "alex", via: "web" }, T0)).toMatchObject({ ok: false, reason: "wrong-task" });
    // No such run.
    expect(requestTaskStop(store, { taskId: "t-a", runId: 999, by: "alex", via: "web" }, T0)).toMatchObject({ ok: false, reason: "no-run" });
    // The exact live run: recorded, with provenance, before anything else.
    const asked = requestTaskStop(store, { taskId: "t-a", runId: a.runId, by: "alex", via: "web" }, later(1_000));
    expect(asked).toMatchObject({ ok: true, repeated: false, terminated: 0 });
    if (!asked.ok) throw new Error("unreachable");
    expect(asked.stop).toMatchObject({ run: a.runId, requestedBy: "alex", requestedVia: "web", requestedAt: later(1_000).toISOString(), settledAt: null, settlement: null, resumedAt: null });
    // Idempotent: the same run again is the same request — same row, same time.
    const again = requestTaskStop(store, { taskId: "t-a", runId: a.runId, by: "someone-else", via: "cli" }, later(5_000));
    expect(again).toMatchObject({ ok: true, repeated: true });
    if (again.ok) expect(again.stop).toEqual(asked.stop);
    // The other task's attempt is untouched: no stop, no hold, still live.
    expect(store.stopOf(b.runId)).toBeNull();
    expect(store.activeHolds(b.taskRef, T0)).toEqual([]);
    expect(taskControlOf(store, b.taskRef, T0)).toMatchObject({ kind: "stop", run: b.runId });
    // The stopped task reads as stopping — never "stopped" — until settlement.
    expect(taskControlOf(store, a.taskRef, T0)).toMatchObject({ kind: "stopping", run: a.runId, unsettledRun: true });
    expect(store.activeHolds(a.taskRef, T0)).toMatchObject([{ ownerKind: "stop", ownerId: String(a.runId) }]);
  });

  test("c1: a finished attempt refuses a stop and its earlier completion is never rewritten; a superseded lease is not the live attempt", () => {
    const a = runningAttempt(store, "t-done");
    const done = disposeBuildOutcome(disposeContext(store, a, "t-done", later(1_000)), { ok: true, committed: true, branch: "standing-orders/t-done", summary: "done" });
    expect(done).toMatchObject({ kind: "built" });
    expect(store.getTask("t-done")?.state).toBe("done");
    const late = requestTaskStop(store, { taskId: "t-done", runId: a.runId, by: "alex", via: "web" }, later(2_000));
    expect(late).toMatchObject({ ok: false, reason: "finished" });
    expect(store.getTask("t-done")?.state).toBe("done");
    expect(store.getRun(a.runId)?.outcome).toBe("built");
    expect(store.stopOf(a.runId)).toBeNull();

    // A run whose lease the world moved past is not the attempt holding the task now.
    const b = runningAttempt(store, "t-stale");
    reapLease(store, b.leaseId);
    const stale = requestTaskStop(store, { taskId: "t-stale", runId: b.runId, by: "alex", via: "web" }, later(3_000));
    expect(stale).toMatchObject({ ok: false, reason: "not-live" });
  });

  test("c2: only the stopped attempt and the descendants sharing its lease inherit the stop; a successor under a fresh claim does not", () => {
    const a = runningAttempt(store, "t-own");
    const repair = store.admitRepair({ taskRef: a.taskRef, leaseId: a.leaseId, runner: "runner-a", branch: "standing-orders/t-own", worktree: a.worktree, provider: "claude", model: "sonnet", parentRun: a.runId, ...(presented(store, a.taskRef, "repair") as { route: import("./phase-routing.js").RouteStamp }), now: T0 });
    if (!repair.ok) throw new Error(repair.problem);
    expect(store.ownedRunsOf(a.runId)).toEqual([a.runId, repair.runId]);
    expect(requestTaskStop(store, { taskId: "t-own", runId: a.runId, by: "alex", via: "cli" }, later(1_000)).ok).toBe(true);
    expect(store.applicableStopFor(repair.runId)?.run).toBe(a.runId);
    expect(stopRequestedFor(store, repair.runId)).toBe(true);
    // The seal ends both rows and settles the one stop; the claim is released as interrupted.
    const sealed = finalize(store, a.leaseId, { kind: "interrupted", runId: a.runId, taskId: "t-own", stopRun: a.runId, now: later(2_000) });
    expect(sealed).toMatchObject({ ok: true, fenced: false });
    expect(store.getRun(a.runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.getRun(repair.runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.stopOf(a.runId)).toMatchObject({ settledAt: later(2_000).toISOString(), settlement: "interrupted" });
    expect(store.raw().prepare("SELECT released_by FROM claim WHERE lease_id = ?").get(a.leaseId)?.["released_by"]).toBe("interrupted");
    expect(store.getTask("t-own")?.state).toBe("queued");
    expect(store.refForId(a.taskRef)?.strikes).toBe(0);
    // No writes after settlement: a late release from the dead lease is fenced, and a late completion too.
    expect(release(store, a.leaseId, later(3_000))).toMatchObject({ ok: false, reason: "fenced" });
    expect(finalize(store, a.leaseId, { kind: "complete", state: "done", now: later(3_000) })).toMatchObject({ ok: false, reason: "fenced" });
    expect(store.getTask("t-own")?.state).toBe("queued");
    // Until the exact attempt is resumed, nothing inherits its draft — not even the recovered-draft road.
    const early = store.admitRecoveredBuilder({ taskRef: a.taskRef, leaseId: "lease-early", runner: "runner-b", branch: "standing-orders/t-own", worktree: a.worktree, provider: "claude", model: "sonnet", recoveredFrom: a.runId, ...(presented(store, a.taskRef, "builder") as { route: import("./phase-routing.js").RouteStamp }), now: later(3_500) });
    expect(early).toMatchObject({ ok: false });
    if (!early.ok) expect(early.problem).toContain("has not been resumed");
    // A successor admitted under a FRESH claim, after the resume, inherits nothing of the stop.
    expect(resumeTaskStop(store, { taskId: "t-own", runId: a.runId, by: "alex", via: "cli" }, later(3_800))).toMatchObject({ ok: true });
    const next = acquire(store, a.taskRef, "runner-b", { token: tok("runner-b"), now: later(4_000), newLeaseId: () => "lease-next" });
    if (!next.ok) throw new Error(`successor claim refused: ${next.reason}`);
    // The recovered-draft road itself: the successor names the interrupted attempt as its parent and runs under its own lease.
    const admitted = store.admitRecoveredBuilder({ taskRef: a.taskRef, leaseId: "lease-next", runner: "runner-b", branch: "standing-orders/t-own", worktree: a.worktree, provider: "claude", model: "sonnet", recoveredFrom: a.runId, ...(presented(store, a.taskRef, "builder") as { route: import("./phase-routing.js").RouteStamp }), now: later(4_000) });
    if (!admitted.ok) throw new Error(admitted.problem);
    expect(store.getRun(admitted.runId)?.parentRun).toBe(a.runId);
    expect(store.applicableStopFor(admitted.runId)).toBeNull();
    expect(stopRequestedFor(store, admitted.runId)).toBe(false);
  });

  test("c3: a stop that lands before terminal settlement beats a late build success — no done, no publication, no strike; the commit is kept as an artifact", () => {
    const a = runningAttempt(store, "t-race");
    store.recordOutcomeFacts(a.runId, { headRevision: "abc123", handoff: "built it" });
    expect(requestTaskStop(store, { taskId: "t-race", runId: a.runId, by: "alex", via: "web" }, later(1_000)).ok).toBe(true);
    const disposition = disposeBuildOutcome(disposeContext(store, a, "t-race", later(2_000)), { ok: true, committed: true, branch: "standing-orders/t-race", summary: "late success" });
    expect(disposition).toMatchObject({ kind: "stopped", stopRun: a.runId });
    expect(store.getTask("t-race")?.state).toBe("queued");
    expect(store.getRun(a.runId)).toMatchObject({ outcome: "failed", reason: "interrupted", committed: true, headRevision: "abc123" });
    expect(store.publicationForRun(a.runId)).toBeNull();
    expect(store.refForId(a.taskRef)?.strikes).toBe(0);
    expect(store.activeHolds(a.taskRef, T0).map(one => one.ownerKind)).toEqual(["stop"]);
    expect(diagnoseTaskDispatch(store, "t-race", later(3_000))).toMatchObject({ code: "stopped", action: "resume-run" });
    expect(taskControlOf(store, a.taskRef, later(3_000))).toMatchObject({ kind: "paused", run: a.runId, committed: true });
  });

  test("c3: a stop before settlement also beats a park, a failure (no strike, no backoff), and plan ingestion", () => {
    const parked = runningAttempt(store, "t-park");
    expect(requestTaskStop(store, { taskId: "t-park", runId: parked.runId, by: "alex", via: "web" }, later(1_000)).ok).toBe(true);
    const failed = finalize(store, parked.leaseId, { kind: "failure", runId: parked.runId, taskId: "t-park", failureClass: "retryable-infra", message: "killed", worktree: parked.worktree, now: later(2_000) });
    expect(failed).toMatchObject({ ok: false, reason: "stopped" });
    expect(store.refForId(parked.taskRef)?.strikes).toBe(0);
    expect(store.activeHolds(parked.taskRef, T0).map(one => one.ownerKind)).toEqual(["stop"]);
    expect(store.getRun(parked.runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });

    // Planner: the draft is not ingested; the task stays where it was, no scope proposal lands.
    store.createTask({ id: "t-plan", title: "plan me" }, T0);
    const planRef = store.refFor("built-in", "t-plan").id;
    store.placeTask(planRef, REPO);
    const claimed = acquire(store, planRef, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: () => "lease-plan", role: "planner" });
    if (!claimed.ok) throw new Error(`planner claim refused: ${claimed.reason}`);
    const planRun = store.startRun({ taskRef: planRef, leaseId: "lease-plan", runner: "runner-a", role: "planner", branch: "standing-orders-plan/t-plan", worktree: "/pool/t-plan", now: T0, ...presented(store, planRef, "planner") });
    expect(requestTaskStop(store, { taskId: "t-plan", runId: planRun, by: "alex", via: "cli" }, later(1_000))).toMatchObject({ ok: true });
    const plan = {
      goal: "do the thing",
      outOfScope: "nothing else",
      touches: ["src/a.ts"],
      acceptance: [{ id: "c1", statement: "It works.", how: null, evidence: ["manual-review" as const] }],
      plan: "## Approach\nDo the thing.",
    };
    const sealed = finalize(store, "lease-plan", { kind: "plan", runId: planRun, taskId: "t-plan", plan, artifact: null, now: later(2_000) });
    expect(sealed).toMatchObject({ ok: false, reason: "stopped" });
    expect(store.getScope("t-plan")).toBeNull();
    expect(store.getRun(planRun)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.stopOf(planRun)?.settlement).toBe("interrupted");
    expect(store.refForId(planRef)?.planStrikes).toBe(0);
  });

  test("c3: the fence is transactional — a stop after the completion transaction finds the attempt finished, a stop before it wins", () => {
    const first = runningAttempt(store, "t-order-1");
    const built = store.transact(() => {
      // Inside the completion's own transaction nothing can interleave; the
      // fence sees no stop and completes.
      const seal = interruptIfStopped(store, { leaseId: first.leaseId, runId: first.runId, taskId: "t-order-1", now: later(1_000) });
      expect(seal).toBeNull();
      return finalize(store, first.leaseId, { kind: "complete", state: "done", now: later(1_000) });
    });
    expect(built).toMatchObject({ ok: true, arm: "completed" });
    store.finishRun(first.runId, { outcome: "built", committed: true, now: later(1_000) });
    expect(requestTaskStop(store, { taskId: "t-order-1", runId: first.runId, by: "alex", via: "web" }, later(2_000))).toMatchObject({ ok: false, reason: "finished" });

    const second = runningAttempt(store, "t-order-2");
    expect(requestTaskStop(store, { taskId: "t-order-2", runId: second.runId, by: "alex", via: "web" }, later(1_000)).ok).toBe(true);
    const seal = store.transact(() => interruptIfStopped(store, { leaseId: second.leaseId, runId: second.runId, taskId: "t-order-2", now: later(2_000) }));
    expect(seal).toMatchObject({ ok: true, stopRun: second.runId });
    expect(finalize(store, second.leaseId, { kind: "complete", state: "done", now: later(3_000) })).toMatchObject({ ok: false, reason: "fenced" });
    expect(store.getTask("t-order-2")?.state).toBe("queued");
  });

  test("c4: a restart settles a pending stop as recovered and keeps the task paused with its evidence — no strike, no automatic retry", () => {
    const a = runningAttempt(store, "t-crash");
    store.recordOutcomeFacts(a.runId, { headRevision: "deadbeef" });
    expect(requestTaskStop(store, { taskId: "t-crash", runId: a.runId, by: "alex", via: "web" }, later(1_000)).ok).toBe(true);
    // The worker died before it could seal: the run is open, the stop unsettled.
    expect(taskControlOf(store, a.taskRef, later(2_000))).toMatchObject({ kind: "stopping", unsettledRun: true });
    // Dead-runner recovery (what reconcile runs on restart) settles it.
    const recovered = store.recoverRunnerWork("runner-a", later(3_000));
    expect(recovered.runs).toContain(a.runId);
    expect(store.getRun(a.runId)).toMatchObject({ outcome: "failed", reason: "interrupted", headRevision: "deadbeef" });
    expect(store.stopOf(a.runId)).toMatchObject({ settlement: "recovered", settledAt: later(3_000).toISOString() });
    expect(store.getTask("t-crash")?.state).toBe("queued");
    expect(store.refForId(a.taskRef)?.strikes).toBe(0);
    // The stop's hold keeps the requeued task out of the ready set.
    expect(store.activeHolds(a.taskRef, later(3_000)).map(one => one.ownerKind)).toEqual(["stop"]);
    expect(taskReadinessBlocker(store, a.taskRef, later(3_000))).toMatchObject({ code: "hold", ownerKind: "stop" });
    // Once the dead runner's lease is reaped the scheduler's answer is the pause, not a retry.
    reapLease(store, a.leaseId);
    expect(diagnoseTaskDispatch(store, "t-crash", later(3_000))).toMatchObject({ code: "stopped" });
    expect(taskControlOf(store, a.taskRef, later(3_000))).toMatchObject({ kind: "paused", run: a.runId });
  });

  test("c4: a dead incarnation's recovery settles the stop the same way", () => {
    const a = runningAttempt(store, "t-inc");
    store.raw().prepare("UPDATE claim SET incarnation = 'inc-1' WHERE lease_id = ?").run(a.leaseId);
    expect(requestTaskStop(store, { taskId: "t-inc", runId: a.runId, by: "alex", via: "cli" }, later(1_000)).ok).toBe(true);
    expect(store.recoverIncarnation("runner-a", "inc-1", later(2_000))).toBeGreaterThan(0);
    expect(store.stopOf(a.runId)).toMatchObject({ settlement: "recovered" });
    expect(store.getRun(a.runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.activeHolds(a.taskRef, later(2_000)).map(one => one.ownerKind)).toEqual(["stop"]);
  });

  test("c5: resume refuses until quiescent, then clears only the stop's hold and keeps every other hold and the signed scope", () => {
    const a = runningAttempt(store, "t-resume");
    const scopeBefore = store.getScope("t-resume");
    // Holds that stood beside the stop: an operator pause and a decision-style owned hold.
    store.hold(a.taskRef, "operator pause", null, T0);
    store.holdOwned({ taskRef: a.taskRef, ownerKind: "backoff", ownerId: `x:${a.taskRef}`, reason: "unrelated", until: null }, T0);
    expect(requestTaskStop(store, { taskId: "t-resume", runId: a.runId, by: "alex", via: "web" }, later(1_000)).ok).toBe(true);
    // Not yet: the stop is unsettled and the run open.
    expect(resumeTaskStop(store, { taskId: "t-resume", runId: a.runId, by: "alex", via: "web" }, later(2_000))).toMatchObject({ ok: false, reason: "stopping" });
    finalize(store, a.leaseId, { kind: "interrupted", runId: a.runId, taskId: "t-resume", stopRun: a.runId, now: later(3_000) });
    // The workspace still held by a live process is a concrete gate.
    expect(resumeTaskStop(store, { taskId: "t-resume", runId: a.runId, by: "alex", via: "web", occupied: () => ({ held: true, by: fakePid(1) }) }, later(4_000))).toMatchObject({ ok: false, reason: "occupied" });
    // Quiescent: resumed, exactly this stop's hold lifted, nothing else touched.
    const resumed = resumeTaskStop(store, { taskId: "t-resume", runId: a.runId, by: "alex", via: "web", occupied: () => ({ held: false }) }, later(5_000));
    expect(resumed).toMatchObject({ ok: true });
    if (!resumed.ok) throw new Error("unreachable");
    expect(resumed.stop).toMatchObject({ resumedAt: later(5_000).toISOString(), resumedBy: "alex", resumedVia: "web" });
    expect(store.activeHolds(a.taskRef, later(5_000)).map(one => `${one.ownerKind}:${one.ownerId}`).sort()).toEqual([`backoff:x:${a.taskRef}`, `operator:${a.taskRef}`]);
    expect(store.getScope("t-resume")).toEqual(scopeBefore);
    expect(resumed.gate).toMatchObject({ code: "held" });
    // Replayed: the same resume again is refused, and nothing changes.
    expect(resumeTaskStop(store, { taskId: "t-resume", runId: a.runId, by: "alex", via: "web" }, later(6_000))).toMatchObject({ ok: false, reason: "already-resumed" });
    expect(taskControlOf(store, a.taskRef, later(6_000))).toMatchObject({ kind: "none" });
  });

  test("c5: a stale resume names a stopped attempt that a later attempt superseded, and is refused; a live claim refuses too", () => {
    const a = runningAttempt(store, "t-super");
    expect(requestTaskStop(store, { taskId: "t-super", runId: a.runId, by: "alex", via: "web" }, later(1_000)).ok).toBe(true);
    finalize(store, a.leaseId, { kind: "interrupted", runId: a.runId, taskId: "t-super", stopRun: a.runId, now: later(2_000) });
    store.releaseOwnedHold("stop", String(a.runId));
    const next = acquire(store, a.taskRef, "runner-b", { token: tok("runner-b"), now: later(3_000), newLeaseId: () => "lease-2" });
    if (!next.ok) throw new Error(next.reason);
    // The successor is live: a resume of the old attempt is refused as superseded-or-busy, never applied to the new one.
    const successor = store.startRun({ taskRef: a.taskRef, leaseId: "lease-2", runner: "runner-b", branch: "standing-orders/t-super", worktree: a.worktree, now: later(3_000), ...presented(store, a.taskRef, "builder") });
    const stale = resumeTaskStop(store, { taskId: "t-super", runId: a.runId, by: "alex", via: "web" }, later(4_000));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(["superseded", "busy"]).toContain(stale.reason);
    expect(store.stopOf(successor)).toBeNull();
    expect(store.getRun(successor)?.outcome).toBeNull();
    // A stale stop naming the OLD run does not stop the successor either.
    expect(requestTaskStop(store, { taskId: "t-super", runId: a.runId, by: "alex", via: "web" }, later(5_000))).toMatchObject({ ok: true, repeated: true });
    expect(store.applicableStopFor(successor)).toBeNull();
  });

  test("c5: a stopped review is refused by resume and pointed at the bounded explicit retry door", () => {
    const a = runningAttempt(store, "t-review");
    disposeBuildOutcome(disposeContext(store, a, "t-review", later(1_000)), { ok: true, committed: true, branch: "standing-orders/t-review", summary: "done" });
    const reviewer = store.raw()
      .prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, parent_run, review_attempt, started_at) VALUES (?, 'review-lease', 'runner-a', 'reviewer', 'claude', ?, 1, ?)")
      .run(a.taskRef, a.runId, later(2_000).toISOString());
    const reviewRun = Number(reviewer.lastInsertRowid);
    const asked = requestTaskStop(store, { taskId: "t-review", runId: reviewRun, by: "alex", via: "web" }, later(3_000));
    expect(asked).toMatchObject({ ok: true });
    // A stopped review places no queue hold — its retry is explicit.
    expect(store.activeHolds(a.taskRef, later(3_000))).toEqual([]);
    store.finishRun(reviewRun, { outcome: "failed", reason: "interrupted", now: later(4_000), stopSettlement: "interrupted" });
    expect(resumeTaskStop(store, { taskId: "t-review", runId: reviewRun, by: "alex", via: "web" }, later(5_000))).toMatchObject({ ok: false, reason: "review" });
    expect(taskControlOf(store, a.taskRef, later(5_000))).toMatchObject({ kind: "review-stopped", run: reviewRun, sourceRun: a.runId });
  });

  test("a run that reaches its own ending first settles a recorded stop as `finished`, keeping its real outcome visible", () => {
    const a = runningAttempt(store, "t-fin");
    expect(requestTaskStop(store, { taskId: "t-fin", runId: a.runId, by: "alex", via: "web" }, later(1_000)).ok).toBe(true);
    // A road that finishes the run without the fence (none in the product; the store's own guarantee).
    store.finishRun(a.runId, { outcome: "refused", reason: "fenced", now: later(2_000) });
    expect(store.stopOf(a.runId)).toMatchObject({ settlement: "finished" });
  });

});

/** Expire a lease the way the reaper would: the world moved past it. */
function reapLease(store: Store, leaseId: string): void {
  store.raw().prepare("UPDATE claim SET released_at = ?, released_by = 'reaped' WHERE lease_id = ?").run(T0.toISOString(), leaseId);
}

describe("a finished run's processes settle by themselves", () => {
  let store: Store;
  const access = { principal: "operator" as const, repos: [REPO] };
  beforeEach(() => {
    store = openStore(":memory:");
    register(store, { name: "runner-a", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => tok("runner-a") });
  });
  afterEach(() => store.close());

  /** A built result whose recorded process was still alive when its run finished. */
  function finishedWithLiveProcess(taskId: string): number {
    store.createTask({ id: taskId, title: `work ${taskId}` }, T0);
    const taskRef = store.refFor("built-in", taskId).id;
    store.placeTask(taskRef, REPO);
    approveScopeFor(store, taskId);
    const runId = store.startRun({ taskRef, leaseId: `l-${taskId}`, runner: "runner-a", branch: `standing-orders/${taskId}`, worktree: `/pool/${taskId}`, now: T0, ...presented(store, taskRef) });
    store.stampRun(runId, { scopeDigest: store.getScope(taskId)!.digest, baseRevision: "1".repeat(40) });
    store.recordOutcomeFacts(runId, { headRevision: "a".repeat(40), handoff: "Done." });
    store.recordRunProcess(runId, fakePid(1), T0, true);
    store.finishRun(runId, { outcome: "built", committed: true, now: later(1_000) });
    store.setTaskState(taskId, "done", later(1_000));
    return runId;
  }
  const item = (taskId: string) => workIndexPage(store, later(5_000), access).items.find(one => one.rootId === taskId)!;

  test("once its process is gone the reconcile records the exit and the task leaves Needs you", () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const runId = finishedWithLiveProcess("t-outlived");
      expect(item("t-outlived").status.label).toBe("Waiting");
      expect(item("t-outlived").status.detail).toBe("Waiting for build #1 to stop. Nothing is needed from you.");
      // Still alive: nothing is recorded.
      expect(store.recordFinishedRunExits(later(2_000))).toBe(0);
      kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
      expect(store.recordFinishedRunExits(later(3_000))).toBe(1);
      // Settled: the exited witness is compacted into the run's summary (v114), which keeps when it exited.
      expect(store.raw().prepare("SELECT COUNT(*) AS n FROM run_process WHERE run = ?").get(runId)?.["n"]).toBe(0);
      expect(store.raw().prepare("SELECT witnesses, last_exited_at FROM run_process_summary WHERE run = ?").get(runId)).toMatchObject({ witnesses: 1, last_exited_at: later(3_000).toISOString() });
      expect(store.stopQuiescenceProblem(runId)).toBeNull();
      expect(item("t-outlived").status.label).toBe("Ready for review");
      expect(store.recordFinishedRunExits(later(4_000))).toBe(0);
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally { kill.mockRestore(); }
  });

  test("a run that can't be proven yet is passed over; newer runs behind it still settle", () => {
    const alive = fakePid(1);
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (Math.abs(pid) === alive) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }) as typeof process.kill);
    try {
      const stuck = finishedWithLiveProcess("t-still-alive");
      const newer = ["t-gone-1", "t-gone-2", "t-gone-3"].map(id => {
        const runId = finishedWithLiveProcess(id);
        store.raw().prepare("UPDATE run_process SET pid = ? WHERE run = ?").run(fakePid(100 + runId), runId);
        return runId;
      });
      // One run a batch: the unprovable oldest must not hold the rest back.
      expect(store.recordFinishedRunExits(later(2_000), 1)).toBe(3);
      for (const runId of newer) expect(store.stopQuiescenceProblem(runId)).toBeNull();
      expect(store.raw().prepare("SELECT exited_at FROM run_process WHERE run = ?").get(stuck)?.["exited_at"]).toBeNull();
      expect(item("t-still-alive").status.label).toBe("Waiting");
      for (const id of ["t-gone-1", "t-gone-2", "t-gone-3"]) expect(item(id).status.label).toBe("Ready for review");
    } finally { kill.mockRestore(); }
  });

  test("the repair on start clears what an older build left open", () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      for (const id of ["t-old-1", "t-old-2", "t-old-3"]) finishedWithLiveProcess(id);
      expect(["t-old-1", "t-old-2", "t-old-3"].map(id => item(id).status.label)).toEqual(["Waiting", "Waiting", "Waiting"]);
      // The upgrade happens after those processes are long gone.
      kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
      expect(repairStaleStatuses(store, later(2_000))).toEqual({ exitsRecorded: 3, readyForReview: 3 });
      expect(["t-old-1", "t-old-2", "t-old-3"].map(id => item(id).status.label)).toEqual(["Ready for review", "Ready for review", "Ready for review"]);
      expect(repairStaleStatuses(store, later(3_000))).toEqual({ exitsRecorded: 0, readyForReview: 3 });
    } finally { kill.mockRestore(); }
  });

  test("a pid now held by a process born after the run finished settles, as deploy's check already says; an older one stays", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const ps = vi.mocked(childProcess.execFileSync).mockReturnValue("Sat Sep 12 07:59:00 2026\n");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-15T00:00:00.000Z"));
    try {
      const runId = finishedWithLiveProcess("t-reused-pid");
      // Born before the run finished: it may be the run's own process.
      expect(store.recordFinishedRunExits(later(2_000))).toBe(0);
      expect(store.stopQuiescenceProblem(runId)).toContain("may still be running");
      expect(item("t-reused-pid").status.label).toBe("Waiting");
      // Born after: the pid was reused, so the run's process is gone.
      ps.mockReturnValue("Mon Sep 14 14:33:43 2026\n");
      expect(store.stopQuiescenceProblem(runId)).toBeNull();
      expect(store.recordFinishedRunExits(later(3_000))).toBe(1);
      expect(item("t-reused-pid").status.label).toBe("Ready for review");
    } finally {
      kill.mockRestore(); ps.mockReset(); clock.mockRestore();
      Object.defineProperty(process, "platform", platform);
    }
  });
});
