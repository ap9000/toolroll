/**
 * A build that vanished: its process died with its runner, so no one settled it (docs/plans/plain-toolroll.md P2.1).
 *
 * Every recovery road (a dead runner, a takeover, a superseded watch) ends here, in its own transaction. The vanished
 * attempt is charged one strike, once, whoever recovers it: `vanished_charge` is keyed by the run, so a second recoverer
 * or a later pass charges nothing, and restarting can no longer evade MAX_STRIKES.
 *
 * Toolroll retries by itself only inside an episode (`retry_episode`: the automatic retries and reserved spend since the
 * last person act), at most RETRY_LIMIT retries and RETRY_SPEND_TIMES the plan's budget, each claim reserving its whole
 * budget against that ceiling. A vanished attempt's spend is unknown, so its reservation is never given back. A plan
 * with no budget bounds nothing and gets no automatic retry. A prepared candidate runs a machine check and no agent, so
 * it spends nothing and needs no budget; it still counts its attempts.
 *
 * Stop, hold, archive and approval standing are re-read here, and each keeps the retry from dispatching: the task stays
 * in the queue where that gate holds it, as a person's stop always has, reserving nothing, until a person acts. A
 * process not yet proven stopped holds the task until it is (retryVanishedWhenStopped, every sweep): the retry never
 * starts beside the old attempt.
 */
import { authorityStandsSql } from "./approval-authority.js";
import { stopFactOf, type Store } from "./store.js";
import { refArchived } from "./task-archive.js";

/** The automatic-retry limits, in one place. */
export const RETRY_LIMIT = 3;
export const RETRY_SPEND_TIMES = 2;
/** claim.ts MAX_STRIKES (store.ts loads this file, so the claim road isn't imported here; a test pins them equal). */
export const VANISHED_MAX_STRIKES = 3;

/** What recovery did with a task: back in the queue, waiting for its old process to be proven stopped, stopped for a
 * person, or nothing at all (not a task of ours to move). */
export type VanishedAnswer = "queued" | "waiting" | "stopped" | "none";
export type RetryStop = "no-budget" | "attempts" | "spend";

/** The newest attempt that spends: repair children ride their parent's attempt, and a reviewer has no task claim. */
function attemptOf(store: Store, taskRef: number): { id: number; outcome: string | null; reason: string | null } | null {
  const row = store.handle.prepare("SELECT id, role, outcome, reason FROM run WHERE task_ref = ? AND role IN ('builder', 'scout', 'planner') ORDER BY id DESC LIMIT 1").get(taskRef);
  // A planner spends no approved budget and has its own strikes: it goes back to the queue as it always has.
  if (row === undefined || String(row["role"]) === "planner") return null;
  return { id: Number(row["id"]), outcome: row["outcome"] === null ? null : String(row["outcome"]), reason: row["reason"] === null ? null : String(row["reason"]) };
}

/** Whether any run of this task still has a process no record proves stopped. */
function processUnsettled(store: Store, taskRef: number): boolean {
  for (const run of store.runsFor(taskRef)) {
    const fact = stopFactOf(store, run.id);
    if (fact !== null && fact.kind !== "open") return true;
  }
  return false;
}

/** dispatch.ts scopeApprovedForDispatch, read here because store.ts loads this file. */
function approvalStands(store: Store, taskRef: number, now: Date): boolean {
  const stamp = now.toISOString();
  return store.handle.prepare(`SELECT 1 AS hit FROM task_scope JOIN task_ref ON task_ref.id = ? AND task_scope.task_id = task_ref.external_id
    WHERE task_scope.approved_digest = task_scope.digest AND task_scope.approved_at IS NOT NULL AND ${authorityStandsSql("task_scope", "task_ref.repo", "?")}`).get(taskRef, stamp, stamp, stamp, stamp) !== undefined;
}

function requeue(store: Store, taskId: string, now: Date): boolean {
  return Number(store.handle.prepare("UPDATE task SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'running'").run(now.toISOString(), taskId).changes) > 0;
}

function episodeOf(store: Store, taskRef: number): { retries: number; reservedMicrousd: number } | null {
  const row = store.handle.prepare("SELECT retries, reserved_microusd FROM retry_episode WHERE task_ref = ?").get(taskRef);
  return row === undefined ? null : { retries: Number(row["retries"]), reservedMicrousd: Number(row["reserved_microusd"]) };
}

function stopFor(store: Store, input: { taskRef: number; taskId: string; run: number; why: RetryStop; now: Date; reservedMicrousd: number; retries: number }): "stopped" {
  const stamp = input.now.toISOString();
  store.handle.prepare(`INSERT INTO retry_episode (task_ref, retries, reserved_microusd, stopped, stopped_run, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (task_ref) DO UPDATE SET stopped = excluded.stopped, stopped_run = excluded.stopped_run, reserved_microusd = excluded.reserved_microusd, updated_at = excluded.updated_at`)
    .run(input.taskRef, input.retries, input.reservedMicrousd, input.why, input.run, stamp, stamp);
  store.handle.prepare("UPDATE task SET state = 'failed', updated_at = ? WHERE id = ? AND state IN ('running', 'queued')").run(stamp, input.taskId);
  store.enqueueNotification({
    source: { run: input.run },
    dedupeKey: `vanished:${input.run}`,
    kind: "build-failed",
    pushClass: "attention",
    link: `/r/${input.run}`,
    subject: `${input.taskId}: ${vanishedStopSentence({ why: input.why, run: input.run })}`,
    body: "Open the task to retry it or change the plan.",
  }, input.now);
  return "stopped";
}

/** The custody wait's hold: nothing starts beside a process no record proves stopped, and it never lapses by itself. */
const waitHold = (taskRef: number): string => `vanished:${taskRef}`;

/**
 * The one recovery decision, once per run. The caller has proved the runner gone; this re-reads everything else. A
 * task a tick claimed never left `queued`, so releasing its lease alone would dispatch it again: what stops a retry here
 * is the state or hold this writes, in this transaction. Safe to call again: the run is charged once, decided once.
 */
export function settleVanished(store: Store, taskRef: number, now: Date): VanishedAnswer {
  return store.transact(() => {
    if (store.currentLiveLease(taskRef, now) !== null) return "none";
    const ref = store.refForId(taskRef);
    if (ref === null || ref.backend !== "built-in") return "none";
    const taskId = ref.externalId;
    const task = store.getTask(taskId);
    if (task === null) return "none";
    const attempt = attemptOf(store, taskRef);
    // No attempt, or one a real outcome already settled: nothing vanished here, and recovery only unsticks the task.
    if (attempt === null || (attempt.outcome !== null && attempt.reason !== "interrupted")) return requeue(store, taskId, now) ? "queued" : "none";
    // Still open: its recoverer closes it and comes back here, in the same transaction. Nothing is decided on a run that
    // may not be over.
    if (attempt.outcome === null) return requeue(store, taskId, now) ? "queued" : "none";
    // A person's stop isn't a vanish: nothing is charged, and its hold keeps the task where the stop always has.
    if (store.handle.prepare("SELECT 1 AS hit FROM run_stop WHERE run = ?").get(attempt.id) !== undefined) return requeue(store, taskId, now) ? "queued" : "none";
    const stamp = now.toISOString();
    const charged = store.handle.prepare("INSERT INTO vanished_charge (run, task_ref, charged_at) VALUES (?, ?, ?) ON CONFLICT (run) DO NOTHING").run(attempt.id, taskRef, stamp);
    const strikes = Number(charged.changes) > 0 ? store.addStrike(taskRef) : Number(store.handle.prepare("SELECT strikes FROM task_ref WHERE id = ?").get(taskRef)?.["strikes"] ?? 0);
    if (store.handle.prepare("SELECT settled_at FROM vanished_charge WHERE run = ?").get(attempt.id)?.["settled_at"] != null) return "none";
    const settled = (): void => {
      store.handle.prepare("UPDATE vanished_charge SET settled_at = ? WHERE run = ?").run(stamp, attempt.id);
      store.releaseOwnedHold("backoff", waitHold(taskRef));
    };
    if (task.state !== "queued" && task.state !== "running") { settled(); return "none"; }
    // Blocked by something a person holds: back to the queue, where that gate keeps it. Nothing is reserved, because
    // nothing starts until that person acts.
    const held = store.handle.prepare("SELECT 1 AS hit FROM hold WHERE task_ref = ? AND owner_kind <> 'backoff' AND (until IS NULL OR until > ?) LIMIT 1").get(taskRef, stamp);
    if (held !== undefined || refArchived(store, taskRef) || !approvalStands(store, taskRef, now)) { settled(); return requeue(store, taskId, now) || task.state === "queued" ? "queued" : "none"; }
    if (processUnsettled(store, taskRef)) {
      requeue(store, taskId, now);
      store.holdOwned({ taskRef, ownerKind: "backoff", ownerId: waitHold(taskRef), reason: `Waiting: Toolroll is making sure build #${attempt.id} stopped.`, until: null }, now);
      return "waiting";
    }
    const scope = store.getScope(taskId);
    const budget = scope?.budgetMicrousd ?? null;
    const prepared = (scope?.candidate ?? null) !== null;
    const episode = episodeOf(store, taskRef) ?? { retries: 0, reservedMicrousd: budget ?? 0 };
    const stop = (why: RetryStop): "stopped" => { settled(); return stopFor(store, { taskRef, taskId, run: attempt.id, why, now, reservedMicrousd: episode.reservedMicrousd, retries: episode.retries }); };
    if (budget === null && !prepared) return stop("no-budget");
    if (strikes >= VANISHED_MAX_STRIKES || episode.retries >= RETRY_LIMIT) return stop("attempts");
    const reserved = episode.reservedMicrousd + (budget ?? 0);
    if (budget !== null && reserved > budget * RETRY_SPEND_TIMES) return stop("spend");
    store.handle.prepare(`INSERT INTO retry_episode (task_ref, retries, reserved_microusd, started_at, updated_at) VALUES (?, 1, ?, ?, ?)
      ON CONFLICT (task_ref) DO UPDATE SET retries = retries + 1, reserved_microusd = excluded.reserved_microusd, stopped = NULL, stopped_run = NULL, updated_at = excluded.updated_at`)
      .run(taskRef, reserved, stamp, stamp);
    settled();
    requeue(store, taskId, now);
    return "queued";
  });
}

/** Each sweep: a charged run whose old process wasn't yet proven stopped gets its decision now. */
export function retryVanishedWhenStopped(store: Store, now: Date): number {
  const waiting = store.handle.prepare("SELECT DISTINCT task_ref FROM vanished_charge WHERE settled_at IS NULL").all();
  let moved = 0;
  for (const row of waiting) {
    const answer = settleVanished(store, Number(row["task_ref"]), now);
    if (answer === "queued" || answer === "stopped") moved++;
  }
  if (moved > 0) store.bumpWake();
  return moved;
}

/** A person acted, so a new episode starts. The strikes are theirs to clear on their own road. */
export function clearRetryEpisode(store: Store, taskRef: number): void {
  store.handle.prepare("DELETE FROM retry_episode WHERE task_ref = ?").run(taskRef);
}

/** Why Toolroll stopped retrying this task, or null: it reads as a need until a person acts. */
export function vanishedStopOf(store: Store, taskRef: number): { why: RetryStop; run: number } | null {
  const row = store.handle.prepare("SELECT stopped, stopped_run FROM retry_episode WHERE task_ref = ? AND stopped IS NOT NULL").get(taskRef);
  return row === undefined ? null : { why: String(row["stopped"]) as RetryStop, run: Number(row["stopped_run"]) };
}

/** The need's words: the first stop on a plan with no budget, or a limit reached. */
export function vanishedStopSentence(stop: { why: RetryStop; run: number | null }): string {
  const build = stop.run === null ? "This build" : `Build #${stop.run}`;
  return stop.why === "no-budget" ? `${build} stopped unexpectedly. Retry it.` : `${build} keeps stopping. Retry, or change the plan.`;
}
