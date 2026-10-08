/**
 * One read-side answer to "will this task run?"
 *
 * The atomic claim remains the authority. This module owns the task-local
 * predicates that claim re-proves under its write transaction, then layers
 * fleet observations on top for people and agents reading the queue. A
 * diagnosis can go stale; it can never grant a lease.
 */

import { isAlive } from "./runner.js";
import { updateAdmissionPaused, UPDATE_PAUSED } from "./desktop-update-gate.js";
import { approvalOf, type ExecutionProfile } from "./scope.js";
import { plannerSourceProblemOf } from "./planner-source.js";
import { authPauseOf, authWaitOf, providerName, signInReason } from "./provider-auth.js";
import { REVIEW_TOKENS, resultStatusOf, reviewFactsOf } from "./workspace-ui.js";
import { replacedWords } from "./task-status.js";
import { failedAttemptSentence, latestFinishedAttempt } from "./needs-you.js";
import { buildReviewOf } from "./review-switch.js";
import { BUILT_IN, parseCapabilityKey, type ChatSnapshot, type ReviewRequestOrigin, type ReviewRetryState, type Store, type TaskState } from "./store.js";

export const DEFAULT_MAX_OPEN_DECISIONS = 5;

export type TaskReadinessBlocker =
  | { code: "unknown-task"; message: string }
  | { code: "state"; state: TaskState; message: string }
  | { code: "hold"; ownerKind: string; until: string | null; message: string }
  | { code: "dependency"; blockerId: string; blockerState: TaskState; message: string };

export type DispatchAction =
  | "open-result"
  | "retry-task"
  | "place-task"
  | "write-scope"
  | "select-agent"
  | "approve-scope"
  | "answer-decision"
  | "unhold"
  | "inspect-hold"
  | "repair-dependency"
  | "repair-capability"
  | "start-worker"
  /** v50: ask for the bounded explicit review retry (`task review <run>`
   * or the console's Retry review). */
  | "retry-review"
  /** v52: resume the exact stopped attempt (`task resume <id> --run <n>`
   * or the console's Resume). */
  | "resume-run";

export type DispatchDiagnosisCode =
  | "updating"
  | "complete"
  | "needs-verification"
  | "proof-refuted"
  | "review-pending"
  | "reviewing"
  | "review-failed"
  /** v50: every root review attempt ended without a review; nothing retries. */
  | "review-exhausted"
  | "cancelled"
  | "failed"
  | "running"
  | "vanished-run"
  | "retry-scheduled"
  | "waiting-decision"
  | "waiting-incident"
  | "held"
  /** v52: an operator stopped one exact attempt; only resuming it lifts the pause. */
  | "stopped"
  | "waiting-dependency"
  | "terminal-dependency"
  | "needs-project"
  | "needs-scope"
  | "needs-agent-profile"
  | "needs-approval"
  | "missing-requirement"
  | "no-worker-registered"
  | "no-worker-online"
  | "worker-at-capacity"
  | "provider-quota"
  /** The provider's sign-in stopped working; its dispatch is paused. */
  | "signed-out"
  | "planning-ready"
  | "planner-source"
  | "scouting-ready"
  | "ready";

export type DispatchDiagnosis = {
  /** The four-state Never Stuck contract. */
  condition: "running" | "retrying" | "waiting" | "terminal";
  code: DispatchDiagnosisCode;
  summary: string;
  detail: string;
  action: DispatchAction | null;
  /** When the machine already knows the next automatic wake. */
  nextAt: string | null;
  /** The phase an eventual claim would dispatch. */
  role: "builder" | "planner" | "scout" | null;
  blockerTaskId: string | null;
  /** v50: the finished build's bounded review-retry status — null until a
   * review was ever asked for, and on every task that is not done. */
  review: ReviewDispatchView | null;
};

/** The typed review-retry facts a dispatch reader gets (v50): the source
 * build, the projection's state word, how many root attempts ran and how
 * many explicit retries remain, and the latest attempt's recorded reason. */
export type ReviewDispatchView = {
  sourceRun: number;
  state: ReviewRetryState["state"];
  /** The attempt running, queued, or most recently ended (1..cap); null before any. */
  attempt: number | null;
  cap: number;
  retriesUsed: number;
  retriesRemaining: number;
  /** The most recently ended root attempt's run id and stored reason. */
  latestRun: number | null;
  latestReason: string | null;
  interrupted: boolean;
  /** The open ask, when one is queued: who asked and how it was produced
   * (explicit-only retries: a retry is always an operator's ask; an
   * automatic producer queues attempt 1 only). */
  queued: { requestedBy: string; origin: ReviewRequestOrigin } | null;
};

/**
 * Task state, active holds, and unfinished dependencies in the exact order
 * acquireIfReady checks them. The claim path calls this while holding its
 * write transaction; read surfaces call it only as a snapshot.
 */
export function taskReadinessBlocker(store: Store, taskRef: number, now: Date): TaskReadinessBlocker | null {
  const db = store.handle;
  const stamp = now.toISOString();
  const task = db
    .prepare(
      `SELECT task.id, task.state FROM task
       JOIN task_ref ON task_ref.external_id = task.id AND task_ref.backend = ?
       WHERE task_ref.id = ?`,
    )
    .get(BUILT_IN, taskRef);
  if (task === undefined) return { code: "unknown-task", message: "no such task" };
  const state = String(task["state"]) as TaskState;
  if (state !== "queued") return { code: "state", state, message: `state is ${state}, not queued` };

  const hold = db
    .prepare(
      `SELECT owner_kind, until, reason FROM hold
       WHERE task_ref = ? AND (until IS NULL OR until > ?)
       ORDER BY held_at, id LIMIT 1`,
    )
    .get(taskRef, stamp);
  if (hold !== undefined) {
    return {
      code: "hold",
      ownerKind: String(hold["owner_kind"]),
      until: hold["until"] === null || hold["until"] === undefined ? null : String(hold["until"]),
      message: `held: ${String(hold["reason"])}`,
    };
  }

  const blocker = db
    .prepare(
      `SELECT blocker.id, blocker.state FROM task_edge
       JOIN task AS blocker ON blocker.id = task_edge.blocker
       WHERE task_edge.blocked = ? AND blocker.state <> 'done'
       ORDER BY blocker.id LIMIT 1`,
    )
    .get(String(task["id"]));
  if (blocker !== undefined) {
    const blockerId = String(blocker["id"]);
    return {
      code: "dependency",
      blockerId,
      blockerState: String(blocker["state"]) as TaskState,
      message: `waiting on ${blockerId}`,
    };
  }
  return null;
}

/** The exact live approval predicate used by both the scheduler survey and
 * the atomic claim. Mode-backed approvals count only while their signer and
 * mode still stand. */
// Recovery reads this same live predicate; a completed run does not grandfather
// a revoked signer or mode, and this query never creates dispatch authority.
export function scopeApprovedForDispatch(store: Store, taskRef: number, now: Date): boolean {
  const row = store.handle
    .prepare(
      `SELECT 1 AS hit FROM task_scope
       JOIN task_ref ON task_ref.id = ? AND task_scope.task_id = task_ref.external_id
       WHERE task_scope.approved_digest = task_scope.digest AND task_scope.approved_at IS NOT NULL
         AND (COALESCE(task_scope.approval_basis, 'password') <> 'mode'
           OR EXISTS (SELECT 1 FROM operating_mode om
                      JOIN approver signer ON signer.name = om.signed_by
                     WHERE om.repo = task_ref.repo AND om.revoked_at IS NULL
                       AND om.absolute_expiry > ? AND om.digest = task_scope.mode_digest
                       AND signer.revoked_at IS NULL AND signer.role = 'approver'))`,
    )
    .get(taskRef, now.toISOString());
  return row !== undefined;
}

/** The phase the ordinary dispatch loop would choose before it resolves an
 * agent. */
export function dispatchRoleFor(store: Store, taskRef: number, now: Date): "builder" | "planner" | "scout" {
  const ref = store.refForId(taskRef);
  const approved = scopeApprovedForDispatch(store, taskRef, now);
  if (ref?.plan === "requested" && !approved) return "planner";
  if (ref?.deliverable === "report" && approved) return "scout";
  return "builder";
}

/** The first requirement this task fails, in words, or null. */
export function missingCapability(store: Store, taskRef: number, dispatchRepo: string | null, now: Date): string | null {
  const db = store.handle;
  const row = db.prepare("SELECT repo, capability_requirements FROM task_ref WHERE id = ?").get(taskRef);
  if (row === undefined) return "no such task reference";
  let keys: string[];
  try {
    keys = JSON.parse(String(row["capability_requirements"] ?? "[]")) as string[];
  } catch {
    keys = [];
  }
  if (keys.length === 0) return null;
  const repo = row["repo"] === null || row["repo"] === undefined ? dispatchRepo : String(row["repo"]);
  if (repo === null) return `requires ${keys[0]} but is placed in no repository`;
  const stamp = now.toISOString();
  for (const key of keys) {
    const parsed = parseCapabilityKey(key);
    if (parsed === null) return `requirement \`${key}\` is not a capability key`;
    const found = db.prepare("SELECT status, expires_at FROM capability WHERE repo = ? AND kind = ? AND name = ?").get(repo, parsed.kind, parsed.name);
    if (found === undefined) return `needs ${key} — unrecorded for ${repo}`;
    if (String(found["status"]) !== "verified") return `needs ${key} — not verified`;
    const expires = found["expires_at"];
    if (expires !== null && String(expires) <= stamp) return `needs ${key} — verification expired`;
  }
  return null;
}

function answer(
  code: DispatchDiagnosisCode,
  condition: DispatchDiagnosis["condition"],
  summary: string,
  detail: string,
  options: Partial<Pick<DispatchDiagnosis, "action" | "nextAt" | "role" | "blockerTaskId" | "review">> = {},
): DispatchDiagnosis {
  return {
    condition,
    code,
    summary,
    detail,
    action: options.action ?? null,
    nextAt: options.nextAt ?? null,
    role: options.role ?? null,
    blockerTaskId: options.blockerTaskId ?? null,
    review: options.review ?? null,
  };
}

/** The review projection, shaped for readers (v50). */
function reviewViewOf(sourceRun: number, retry: ReviewRetryState): ReviewDispatchView {
  const current = retry.live ?? (retry.state === "queued" ? null : retry.latest);
  return {
    sourceRun,
    state: retry.state,
    attempt: retry.state === "queued" ? retry.nextAttempt : current?.attempt ?? null,
    cap: retry.cap,
    retriesUsed: retry.retriesUsed,
    retriesRemaining: retry.retriesRemaining,
    latestRun: retry.latest?.runId ?? null,
    latestReason: retry.latest?.reason ?? null,
    interrupted: retry.latest !== null && (retry.latest.outcome === "interrupted" || retry.latest.reason === "interrupted"),
    queued: retry.openRequest === null ? null : { requestedBy: retry.openRequest.requestedBy, origin: retry.openRequest.origin },
  };
}

function approvedProfile(scope: ReturnType<Store["getScope"]>): ExecutionProfile | null {
  if (scope === null || scope.approvalKind === "chain") return null;
  return scope.approvedProfile ?? scope.profile ?? null;
}

/** The read-side lifecycle answer. Project access limits dependency detail, never the readiness gate. */
export function diagnoseTaskDispatch(store: Store, taskId: string, now: Date, readableRepos: readonly string[] | null = null): DispatchDiagnosis | null {
  const task = store.getTask(taskId);
  const ref = store.lookupRef(taskId);
  if (task === null || ref === null) return null;

  if (task.state === "done") {
    const runs = store.runsFor(ref.id);
    const result = runs.find(run => (run.role === "builder" || run.role === "scout") && (run.outcome === "built" || run.outcome === "no-change") && run.finishedAt !== null);
    if (result?.role === "scout") return answer("complete", "terminal", "Report ready", "The research report is ready to review.", { action: "open-result" });
    const proof = result === undefined ? null : store.proofVerdictFor(result.id);
    const accepted = result !== undefined && store.proofAcceptance(result.id) !== null;
    // THE REVIEW STATUS (v50): read from the bounded retry projection — the
    // open request and the NEWEST root attempt in ordinal order — so a
    // queued retry is never hidden behind an older failed run, and every
    // answer below names the attempt count and the one explicit next act.
    const retry = result === undefined ? null : store.reviewRetryStateOf(result.id);
    const review = result === undefined || retry === null || retry.state === "unrequested" ? null : reviewViewOf(result.id, retry);
    // The words are the workspace's shared projection (package 1, review
    // fixes): the same label and detail the Work rows, task page, focused
    // chat, receipt, and review cockpit render for this exact result —
    // a review in flight included. The codes stay the contract.
    const reviewFacts = reviewFactsOf(retry, runner => {
      const reviewer = store.getRunner(runner)?.runner;
      return reviewer !== undefined && isAlive(reviewer, now);
    }, result !== undefined && buildReviewOf(store, result.id)?.state === "pending");
    // A no-change conclusion owes no proof beyond its handoff and sealed
    // diff (the task page's own "attested floor"); with both on record it
    // is complete, not verification-needed.
    const noChangeRecord =
      result === undefined || result.outcome !== "no-change"
        ? undefined
        : (() => { const kinds = new Set(store.artifactsFor(result.id).map(one => one.kind)); return kinds.has("handoff") && kinds.has("terminal-diff"); })();
    const status = resultStatusOf(
      result === undefined
        ? null
        : { runId: result.id, role: result.role, outcome: result.outcome, verdict: proof?.verdict ?? null, reasons: proof?.reasons ?? [], accepted, review: reviewFacts, ...(noChangeRecord === undefined ? {} : { recordComplete: noChangeRecord }) },
      result === undefined ? null : store.publicationForRun(result.id),
    );
    if (REVIEW_TOKENS.has(status.token) && retry !== null && review !== null) {
      const code = status.token as "reviewing" | "review-pending" | "review-failed" | "review-exhausted";
      return answer(code, code === "reviewing" ? "running" : "waiting", status.label, status.detail, { action: retry.state === "retryable" ? "retry-review" : "open-result", review });
    }
    if (!accepted && proof?.verdict === "refuted") return answer("proof-refuted", "waiting", status.label, `${status.detail} Review the evidence to correct it, or record an explicit acceptance.`, { action: "open-result", review });
    if (!accepted && proof?.verdict === "short") return answer("needs-verification", "waiting", status.label, `${status.detail} Open the result for the exact criteria still needing verification.`, { action: "open-result", review });
    if (!accepted && proof === null && noChangeRecord !== true) return answer("needs-verification", "waiting", status.label, status.detail, { action: "open-result", review });
    return answer(
      "complete",
      "terminal",
      status.label,
      review?.state === "succeeded" && review.attempt !== null && review.attempt > 1
        ? `${status.detail} Its independent review succeeded on attempt ${review.attempt} of ${review.cap}.`
        : status.detail,
      { action: "open-result", review },
    );
  }
  if (task.state === "cancelled") {
    // Replaced, never "Cancelled": a successor carries the work on.
    const successor = store.replacementOf(taskId);
    return successor === null ? answer("cancelled", "terminal", "Cancelled", "Nothing else will run for this task.")
      : answer("cancelled", "terminal", replacedWords(successor), `${replacedWords(successor)}. Nothing else will run for this task.`);
  }
  if (task.state === "failed") {
    // The family's latest finished attempt's own recorded reason, or that none was recorded: never "review its incident".
    const family = store.taskFamilyOf(taskId, ref.repo === null ? [] : [ref.repo], ref.repo === null);
    const runs = family === null || family.problem !== null ? store.runsFor(ref.id) : family.versions.flatMap(version => store.runsFor(version.refId));
    return answer("failed", "terminal", "Needs a retry", failedAttemptSentence(latestFinishedAttempt(runs)?.reason), { action: "retry-task" });
  }
  if (store.hasLiveClaim(ref.id, now)) return answer("running", "running", "Running now", "A worker owns the current live claim.");
  if (task.state === "running") return answer("vanished-run", "waiting", "Build vanished", "The task says running, but no current claim owns it; reconcile it before retrying.", { action: "retry-task" });
  if (updateAdmissionPaused(store.raw())) return answer("updating", "waiting", "Waiting for app update", UPDATE_PAUSED);

  const local = taskReadinessBlocker(store, ref.id, now);
  if (local?.code === "hold") {
    if (local.ownerKind === "backoff") {
      // Run 2085: an attempt that stopped before its handoff says so plainly.
      const last = store.runsFor(ref.id).find(one => one.role === "builder" && one.finishedAt !== null);
      const when = local.until === null ? "" : ` The next attempt is eligible at ${local.until}.`;
      if (last?.reason === "no-handoff") return answer("retry-scheduled", "retrying", "Retry scheduled", `The agent stopped before handing off; its work was kept and it is being resumed.${when}`, { nextAt: local.until });
      return answer("retry-scheduled", "retrying", "Retry scheduled", local.until === null ? "The failed attempt is backing off before retrying." : `The next attempt is eligible at ${local.until}.`, { nextAt: local.until });
    }
    if (local.ownerKind === "decision") return answer("waiting-decision", "waiting", "Waiting on your answer", "An agent parked a question; answering it resumes the task.", { action: "answer-decision" });
    if (local.ownerKind === "incident") return answer("waiting-incident", "waiting", "Needs a retry", "An unresolved incident holds the next attempt.", { action: "retry-task" });
    if (local.ownerKind === "stop") return answer("stopped", "waiting", "Paused", `${local.message.replace(/^held:\s*/, "")}. The attempt's work is preserved; resuming that exact attempt lifts this pause.`, { action: "resume-run" });
    return answer("held", "waiting", "On hold", local.message.replace(/^held:\s*/, ""), { action: local.ownerKind === "operator" ? "unhold" : "inspect-hold" });
  }
  if (local?.code === "dependency") {
    const terminal = local.blockerState === "failed" || local.blockerState === "cancelled";
    const blockerRepo = readableRepos === null ? null : store.lookupRef(local.blockerId)?.repo;
    const hidden = readableRepos !== null && (blockerRepo == null || !readableRepos.includes(blockerRepo));
    const blocker = hidden ? "A task in another project" : local.blockerId;
    const blockerTaskId = hidden ? null : local.blockerId;
    return terminal
      ? answer("terminal-dependency", "waiting", "A required task did not finish", `${blocker} ${local.blockerState === "cancelled" ? "was cancelled" : "failed"} before it finished.`, { action: "repair-dependency", blockerTaskId })
      : answer("waiting-dependency", "waiting", "Waiting for another task", `${blocker} must finish before this task can start.`, { blockerTaskId });
  }

  const role = dispatchRoleFor(store, ref.id, now);
  const scope = store.getScope(taskId);
  if (ref.repo === null) return answer("needs-project", "waiting", "Needs a project", "Place this task in a repository before a worker can claim it.", { action: "place-task", role });
  if (role !== "planner") {
    if (scope === null) return answer("needs-scope", "waiting", "Needs a scope", "Write the success contract or ask the planner to draft it.", { action: "write-scope", role });
    if (scope.profileState === "unresolved") return answer("needs-agent-profile", "waiting", "Needs an agent profile", scope.unresolvedReason ?? "Choose an available provider and model.", { action: "select-agent", role });
    if (!scopeApprovedForDispatch(store, ref.id, now) || !approvalOf(scope).approved) {
      return answer("needs-approval", "waiting", "Needs your approval", "Review and sign the current scope before a worker can claim it.", { action: "approve-scope", role });
    }
  }

  const gap = missingCapability(store, ref.id, ref.repo, now);
  if (gap !== null) return answer("missing-requirement", "waiting", "Missing a requirement", gap, { action: "repair-capability", role });

  const all = store.listRunners().filter(one => one.retiredAt === null);
  const bound = all.filter(one => one.repos.includes(ref.repo as string));
  const eligible = ref.assignedRunner === null ? bound : bound.filter(one => one.name === ref.assignedRunner);
  if (eligible.length === 0) {
    const detail = ref.assignedRunner === null
      ? all.length === 0
        ? "This project has not been connected to a builder yet."
        : "Your connected builders do not include this project yet."
      : `This task is assigned to ${ref.assignedRunner}, but that builder is not connected to this project.`;
    return answer("no-worker-registered", "waiting", "Builder not connected", detail, { action: "start-worker", role });
  }
  const alive = eligible.filter(one => isAlive(one, now));
  if (alive.length === 0) {
    return answer(
      "no-worker-online",
      "waiting",
      "Builder disconnected",
      `${eligible.length === 1 ? "The builder for this project has" : "All builders for this project have"} stopped checking in. This task starts automatically when ${eligible.length === 1 ? "it reconnects" : "one reconnects"}.`,
      { action: "start-worker", role },
    );
  }
  const available = alive.filter(one => store.liveClaimCount(one.name, now) < one.capacity);
  if (available.length === 0) return answer("worker-at-capacity", "retrying", "Waiting for worker capacity", "Every eligible worker is busy; this task starts when a slot is released.", { role });

  const profile = approvedProfile(scope);
  if (profile !== null) {
    const exhausted = available.map(one => store.readQuotaState(one.name, profile.provider, profile.model, now)).filter(one => one?.state === "exhausted");
    if (exhausted.length === available.length) {
      const resets = exhausted.map(one => one?.resetAt ?? null).filter((one): one is string => one !== null).sort();
      const nextAt = resets[0] ?? null;
      return answer("provider-quota", "retrying", "Provider quota exhausted", nextAt === null ? "The provider has not supplied a reset time; this needs operator attention." : `The next recorded reset is ${nextAt}.`, { action: nextAt === null ? "select-agent" : null, nextAt, role });
    }
  }

  // The sign-in pause: the task's provider stopped working; nothing it would
  // run starts until someone signs in (or a run or check on it works again).
  const provider = profile?.provider ?? (role === "planner" ? ref.planProvider : null) ?? null;
  const signedOut = authWaitOf(store, ref.id) ?? (provider === null ? null : authPauseOf(store, provider));
  if (signedOut !== null) {
    return answer("signed-out", "waiting", signInReason(signedOut), `This task starts again on its own once ${providerName(signedOut.provider)} works.`, { role });
  }

  const openDecisions = store.countUnanswered();
  if (openDecisions >= DEFAULT_MAX_OPEN_DECISIONS && (role === "planner" || ref.parkRate > 0)) {
    return answer("waiting-decision", "waiting", "Decision queue is full", `${openDecisions} decisions already wait; answer some before this task may add another.`, { action: "answer-decision", role });
  }
  if (role === "planner") {
    // The filed request's own gate (contract handoff, task 1): a request
    // the planner could not be given whole is refused before spend, and
    // this is where the task page says so.
    const sourceProblem = plannerSourceProblemOf(store, taskId);
    if (sourceProblem !== null) return answer("planner-source", "waiting", "The filed request cannot be planned as filed", sourceProblem, { action: "write-scope", role });
    return answer("planning-ready", "retrying", "Planner ready", "An eligible worker can draft the scope on the next pass.", { role });
  }
  if (role === "scout") return answer("scouting-ready", "retrying", "Scout ready", "An eligible worker can produce the report on the next pass.", { role });
  return answer("ready", "retrying", "Ready to run", "An eligible worker has capacity and every dispatch gate currently passes.", { role });
}

export function diagnosisIsDispatchable(diagnosis: DispatchDiagnosis | null): boolean {
  return diagnosis?.code === "ready" || diagnosis?.code === "planning-ready" || diagnosis?.code === "scouting-ready";
}

/** Attach the same lifecycle answer to the bounded fleet snapshot used by
 * both direct chat and the long-running mate. */
export function withDispatchDiagnoses(store: Store, snapshot: ChatSnapshot, now: Date): ChatSnapshot {
  return {
    ...snapshot,
    tasks: snapshot.tasks.map(one => ({ ...one, dispatch: diagnoseTaskDispatch(store, one.id, now) })),
  };
}
