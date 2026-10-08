/**
 * Safe task stop and resume (v52): the ONE domain API every surface — the
 * CLI, the authenticated console, the focused chat — speaks, and the fences
 * every execution road consults.
 *
 * The contract, in the operator's words: a stop names one exact active
 * attempt. The first answer is "stop requested", never "stopped" — the
 * request is durable before any process is signalled, and the attempt is
 * SETTLED only once all owned runs ended and retained process witnesses
 * establish exit. A dead worker can leave live subprocesses; recovery
 * keeps that stop pending. Other tasks keep running. The task stays
 * paused across restarts under a hold this stop owns, beside — never over —
 * any hold that already stood. Resume names the same exact attempt, refuses
 * until it is quiescent, lifts only that hold, approves nothing, and lets
 * the next pass re-prove the signed scope, take a fresh claim, and inherit
 * the preserved draft with fresh proof.
 *
 * Nothing here is a second engine: the stop rides the existing run, claim,
 * hold, recovery, and invocation-gateway machinery. This
 * module only names the door and the fence.
 */

import { ownedProcessCount, runOwnerTag, terminateOwnedProcesses } from "./exec.js";
import { diagnoseTaskDispatch, type DispatchDiagnosis } from "./dispatch.js";
import type { Run, RunStop, Store } from "./store.js";

/** How often a running attempt re-reads its stop row while a child runs.
 * A stop is observed within this bound even when the console that filed
 * it lives in another process on the same database. */
export const STOP_WATCH_MS = 1_500;

/**
 * The stop fence, as a predicate: an operator stop applies to the run (its
 * own, or an owning ancestor's), or the caller's own watch-level stop says
 * so. Every road that used to ask `shouldStop?.()` asks this instead.
 */
export function stopRequestedFor(store: Store, runId: number, also?: () => boolean): boolean {
  if (also?.() === true) return true;
  return store.applicableStopFor(runId) !== null;
}

/** The words a road records when a stop wins: who asked, and where the
 * work stays. */
export function stopWords(store: Store, runId: number, worktree: string | null, fallback: string): string {
  const stop = store.applicableStopFor(runId);
  if (stop === null) return fallback;
  const where = worktree === null ? "its evidence is on record" : `the work is preserved in ${worktree}`;
  return `stopped by ${stop.requestedBy} (run #${stop.run}) — ${where}`;
}

/**
 * End every live child THIS process holds for one attempt and its owned
 * descendants — the exact-attempt handle, never a pid read from durable
 * state. Returns how many process groups were signalled.
 */
export function terminateStoppedAttempt(store: Store, runId: number): number {
  let terminated = 0;
  for (const owned of store.ownedRunsOf(runId)) terminated += terminateOwnedProcesses(runOwnerTag(store, owned));
  return terminated;
}

/** Whether this process still tracks a live child for the attempt or any
 * run it owns — the in-process half of "quiescent". */
export function attemptHasLiveChildren(store: Store, runId: number): boolean {
  return store.ownedRunsOf(runId).some(owned => ownedProcessCount(runOwnerTag(store, owned)) > 0);
}

/**
 * Run a child-bearing step under the stop watch: while `body` runs, the
 * run's stop row is re-read every `intervalMs`; the moment a stop applies
 * the run's owned children are killed through their handles and the
 * caller's `onStop` fires once. The body's own settlement then observes
 * the stop through `stopRequestedFor` and seals the attempt as
 * interrupted — this watch never writes an outcome itself.
 */
export async function underStopWatch<T>(
  store: Store,
  runId: number,
  body: () => Promise<T>,
  options: { intervalMs?: number; onStop?: () => void } = {},
): Promise<T> {
  let fired = false;
  const look = (): void => {
    let applies = false;
    try {
      applies = store.applicableStopFor(runId) !== null;
    } catch {
      // A read that cannot reach the database proves nothing; the next
      // beat asks again, and settlement asks one last time.
      return;
    }
    if (!applies) return;
    terminateStoppedAttempt(store, runId);
    // A later asynchronous step may have spawned since the previous beat.
    // Keep stopping children; only the notification is one-shot.
    if (fired) return;
    fired = true;
    try {
      options.onStop?.();
    } catch {
      // The watch's job is the kill; a listener's throw is its own.
    }
  };
  look();
  const timer = setInterval(look, options.intervalMs ?? STOP_WATCH_MS);
  timer.unref?.();
  try {
    return await body();
  } finally {
    clearInterval(timer);
  }
}

// ---- the operator doors ----------------------------------------------------

export type StopRequest = {
  taskId: string;
  runId: number;
  by: string;
  via: "cli" | "web" | "telegram" | "slack" | "discord" | "teams";
  /** A composing confirmation transaction runs this effect only after it commits. */
  deferSignal?: ((signal: () => void) => void) | undefined;
};

export type StopOutcome =
  | { ok: true; stop: RunStop; repeated: boolean; terminated: number; taskId: string }
  | { ok: false; reason: "no-task" | "no-run" | "wrong-task" | "finished" | "not-live" | "publication"; detail: string };

/**
 * The shared stop door. Records the durable request first (one fenced
 * transaction: exact run, still open, this task's current claim, no
 * admitted publication), THEN signals every child this
 * process holds for the attempt. A worker in another process observes the
 * same row through its stop watch within STOP_WATCH_MS.
 */
export function requestTaskStop(store: Store, request: StopRequest, now: Date): StopOutcome {
  const ref = store.lookupRef(request.taskId);
  if (ref === null || store.getTask(request.taskId) === null) {
    return { ok: false, reason: "no-task", detail: `no task \`${request.taskId}\`` };
  }
  const asked = store.requestRunStop({ runId: request.runId, taskRef: ref.id, by: request.by, via: request.via }, now);
  if (!asked.ok) return asked;
  let terminated = 0;
  const signal = (): void => {
    terminated = terminateStoppedAttempt(store, request.runId);
  };
  if (request.deferSignal) request.deferSignal(signal);
  else signal();
  return { ok: true, stop: asked.stop, repeated: asked.repeated, terminated, taskId: request.taskId };
}

export type ResumeRequest = {
  taskId: string;
  runId: number;
  by: string;
  via: "cli" | "web";
  /** The workspace occupancy probe (the worktree pool's `inUse`): a
   * checkout some process still holds is not quiescent, whatever the
   * rows say — the concrete gate names the pid. */
  occupied?: (worktree: string) => { held: boolean; by?: number | string | undefined };
};

export type ResumeOutcome =
  | { ok: true; stop: RunStop; taskId: string; gate: DispatchDiagnosis | null }
  | { ok: false; reason: "no-task" | "no-stop" | "wrong-task" | "stopping" | "already-resumed" | "superseded" | "busy" | "review" | "occupied"; detail: string };

/**
 * The shared resume door. Refuses in words until the exact stopped attempt
 * is quiescent — settled, every owned run ended, no live claim, its
 * workspace not held by any process this machine can still see — then
 * lifts exactly this stop's hold. `gate` reports what still keeps the
 * next pass from starting work (an approval that must be signed again, a
 * worker that is offline), so a resume that cannot yet start is never
 * mistaken for one that did. A stopped review is refused here and pointed
 * at the explicit bounded review-retry door.
 */
export function resumeTaskStop(store: Store, request: ResumeRequest, now: Date): ResumeOutcome {
  const ref = store.lookupRef(request.taskId);
  if (ref === null || store.getTask(request.taskId) === null) {
    return { ok: false, reason: "no-task", detail: `no task \`${request.taskId}\`` };
  }
  const run = store.getRun(request.runId);
  if (run !== null && run.worktree !== null && request.occupied !== undefined) {
    const held = request.occupied(run.worktree);
    if (held.held) {
      return { ok: false, reason: "occupied", detail: `run #${request.runId}'s workspace ${run.worktree} is still held by process ${String(held.by ?? "?")} — nothing resumes until it is gone` };
    }
  }
  if (attemptHasLiveChildren(store, request.runId)) {
    return { ok: false, reason: "stopping", detail: `run #${request.runId} still has a live process this worker is stopping` };
  }
  const resumed = store.resumeRunStop({ runId: request.runId, taskRef: ref.id, by: request.by, via: request.via }, now);
  if (!resumed.ok) return resumed;
  const gate = diagnoseTaskDispatch(store, request.taskId, now);
  return { ok: true, stop: resumed.stop, taskId: request.taskId, gate: gate === null || gate.condition === "running" ? null : gate };
}

// ---- the projection ---------------------------------------------------------

/**
 * What a surface shows for one task (v52) — the SAME projection on the
 * task page, the focused chat, `task show`, and the status fragment, so no
 * two surfaces can disagree about which exact run a control names:
 *
 *   stop      — an attempt is live; the control names its run.
 *   stopping  — a stop is recorded and not yet settled.
 *   paused    — a settled stop stands on the task's newest attempt.
 *   review-stopped — a review attempt was stopped; "Review again" is the
 *               explicit bounded retry door.
 *   none      — nothing to control.
 */
export type TaskControlView =
  | { kind: "none" }
  | { kind: "stop"; run: number; role: Run["role"] }
  | { kind: "stopping"; run: number; role: Run["role"]; stop: RunStop; unsettledRun: boolean; detail?: string | null }
  | { kind: "paused"; run: number; role: Run["role"]; stop: RunStop; outcome: Run["outcome"]; committed: boolean; worktree: string | null }
  | { kind: "review-stopped"; run: number; sourceRun: number | null; stop: RunStop };

/** The head of a lease group: a run whose parent (if any) ran under a
 * different lease — a builder, a planner, a scout, a recovered-draft
 * successor, a warm park resume; never a repair turn or a correction. */
function isAttemptRoot(store: Store, run: Run): boolean {
  if (run.role === "reviewer") return run.reviewAttempt !== null && run.reviewAttempt !== undefined;
  if (run.parentRun === null) return true;
  return store.getRun(run.parentRun)?.leaseId !== run.leaseId;
}

export function taskControlOf(store: Store, taskRef: number, now: Date): TaskControlView {
  const runs = store.runsFor(taskRef);
  const holding = store.currentLiveLease(taskRef, now);
  const live =
    runs.find(run => run.outcome === null && run.role !== "reviewer" && holding !== null && run.leaseId === holding && isAttemptRoot(store, run)) ??
    runs.find(run => run.outcome === null && run.role === "reviewer" && isAttemptRoot(store, run)) ??
    null;
  if (live !== null) {
    const stop = store.stopOf(live.id);
    if (stop !== null && stop.settledAt === null) return { kind: "stopping", run: stop.run, role: live.role, stop, unsettledRun: true };
    if (stop === null) return { kind: "stop", run: live.id, role: live.role };
  }
  // A stop recorded but unsettled on a run that already ended is still
  // "stopping" — visibly needing attention, never silently paused.
  const pending = store.stopsForTask(taskRef).find(stop => stop.settledAt === null) ?? null;
  if (pending !== null) {
    const run = store.getRun(pending.run);
    return { kind: "stopping", run: pending.run, role: run?.role ?? "builder", stop: pending, unsettledRun: run?.outcome === null, detail: store.stopQuiescenceProblem(pending.run) };
  }
  const newest = runs.find(run => run.role !== "reviewer" && isAttemptRoot(store, run)) ?? null;
  if (newest !== null) {
    const stop = store.stopOf(newest.id);
    if (stop !== null && stop.settledAt !== null && stop.resumedAt === null) {
      return { kind: "paused", run: newest.id, role: newest.role, stop, outcome: newest.outcome, committed: newest.committed === true, worktree: newest.worktree };
    }
  }
  const newestReview = runs.find(run => run.role === "reviewer" && isAttemptRoot(store, run)) ?? null;
  if (newestReview !== null) {
    const stop = store.stopOf(newestReview.id);
    if (stop !== null && stop.settledAt !== null && stop.resumedAt === null) {
      return { kind: "review-stopped", run: newestReview.id, sourceRun: newestReview.parentRun, stop };
    }
  }
  return { kind: "none" };
}
