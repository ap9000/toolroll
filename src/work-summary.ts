/** Read-only work context shared by console, CLI, and agent adapters.
 * State, decisions, approval, process custody and proof still belong to
 * their existing owners. Action hints are navigation/proposal guidance,
 * never credentials or permission to bypass an owning operation. */
import { heldFindingCount } from "./findings.js";
import { machineChecked } from "./machine-check.js";
import { FOLLOW_UP_LOG, FOLLOW_UP_RECEIPT, resultCheckLevel } from "./result-follow-ups.js";
import { COMPLETER_ACTOR, COMPLETION_ACTION } from "./result-completion.js";
import { approvalOf } from "./scope.js";
import { projectCheckSet } from "./check-levels.js";
import { diagnoseTaskDispatch, type DispatchAction } from "./dispatch.js";
import { isAlive } from "./runner.js";
import { refArchived, stopFactOf, type Store } from "./store.js";
import { taskControlOf } from "./task-control.js";
import { buildReviewOf } from "./review-switch.js";
import { reviewFactsOf, workStatusOf, type DisplayStatus, type WorkFacts, type WorkStatus } from "./workspace-ui.js";

export type WorkPrincipal = "operator" | "coordinator";
export type WorkTarget = { taskId: string; runId: number | null; decisionId: number | null };
export type WorkAction = {
  /** `recheck-stopped`: Toolroll looks again whether a finished build stopped (nobody vouches for it);
   * `sign-in`: the agent's sign-in, in Settings; `answer-agent`: Reply to a running agent's question on the Agents board. */
  code: DispatchAction | "inspect-task" | "inspect-findings" | "inspect-run" | "inspect-stop" | "inspect-decisions" | "reconcile-run" | "open-pr" | "recheck-stopped" | "sign-in" | "answer-agent";
  label: string;
  target: WorkTarget;
  access: "read" | "operator-control" | "proposal-only" | "operator-handoff";
  /** Never interpret a hint as permission to retry a mutation blindly. */
  retry: "read-again" | "refresh-before-acting" | "reconcile-before-retry";
};
export type WorkSummary = {
  taskId: string;
  state: WorkFacts["state"];
  resultRunId: number | null;
  liveRunId: number | null;
  status: WorkStatus;
  primaryAction: WorkAction | null;
  nextActions: WorkAction[];
  diagnostics: NonNullable<WorkStatus["diagnostics"]>;
  /** A stored verdict is not a new audit of files on disk. The console
   * supplies its existing receipt projection when it has re-read them. */
  evidence: "recorded" | "receipt-checked";
};

/** Call only after admitting the task's project. Keep the question's
 * exact run and id; never substitute a family's newest attempt. Expiry
 * is attention metadata in the decision owner, so overdue stays open.
 * Finishing a result does not answer its questions: only the normal
 * decision operation settles them, including on earlier family versions. */
export function openWorkDecisionOf(store: Store, taskRef: number, now: Date): Exclude<WorkFacts["openDecision"], undefined> {
  const decision = store.decisionsForTask(taskRef).find(one => one.state !== "answered" && one.answeredAt === null);
  return decision === undefined ? null : {
    id: decision.id, runId: decision.run, question: decision.question,
    overdue: decision.state === "expired" || (decision.deadline !== null && Date.parse(decision.deadline) <= now.getTime()),
  };
}

/** One exact answer target across task and family projections. This is
 * still only a proposal for a coordinator, never approval authority. */
export function workDecisionAction(taskId: string, decision: NonNullable<WorkFacts["openDecision"]>, principal: WorkPrincipal): WorkAction {
  return { code: "answer-decision", label: "Answer question", target: { taskId, runId: decision.runId, decisionId: decision.id },
    access: principal === "operator" ? "operator-control" : "proposal-only", retry: "refresh-before-acting" };
}

const PROPOSABLE = new Set<WorkAction["code"]>(["answer-decision", "write-scope", "unhold"]);
const READ_ACTIONS = new Set<WorkAction["code"]>(["open-result", "open-pr", "inspect-task", "inspect-findings", "inspect-run", "inspect-stop", "inspect-decisions"]);

/** Pure counterpart for callers already holding the same facts. */
export function workSummaryOf(facts: WorkFacts, principal: WorkPrincipal, resultDisplay?: DisplayStatus): WorkSummary {
  const status = workStatusOf(facts, resultDisplay);
  const target: WorkTarget = { taskId: facts.id, runId: null, decisionId: null };
  const make = (code: WorkAction["code"], label: string, exact: Partial<WorkTarget> = {}): WorkAction => ({
    code, label, target: { ...target, ...exact },
    access: READ_ACTIONS.has(code) ? "read" : principal === "operator" ? "operator-control" : PROPOSABLE.has(code) ? "proposal-only" : "operator-handoff",
    retry: code === "reconcile-run" ? "reconcile-before-retry" : READ_ACTIONS.has(code) ? "read-again" : "refresh-before-acting",
  });
  const question = (facts.state === "queued" || facts.state === "running" || facts.state === "done") ? facts.openDecision ?? null : null;
  const questionAction = question === null ? null : workDecisionAction(facts.id, question, principal);
  let primary: WorkAction | null = null;
  if (status.action !== null) {
    if (facts.control?.kind === "stopping") primary = make("inspect-stop", status.action.label, { runId: facts.control.run });
    else if (facts.control?.kind === "paused") primary = make("resume-run", status.action.label, { runId: facts.control.run });
    else if (status.token === "waiting-decision" && questionAction !== null) primary = questionAction;
    else if (status.token === "finding-held") primary = make("inspect-findings", status.action.label);
    else if (facts.dispatch?.code === "vanished-run") primary = make("reconcile-run", "Check the unfinished attempt", { runId: facts.unfinishedRunId ?? null });
    else if (status.action.kind === "open-result" || status.action.kind === "open-review") primary = make("open-result", status.action.label, { runId: facts.result?.runId ?? null });
    else if (status.action.kind === "open-pr") primary = make("open-pr", status.action.label, { runId: facts.result?.runId ?? null });
    else if (status.action.kind === "open-run") primary = make("inspect-run", status.action.label, { runId: facts.liveRunId ?? facts.result?.runId ?? null });
    // A full decision queue can block a task that asked no question of
    // its own. Do not invent a decision target on that task.
    else if (facts.dispatch?.action === "answer-decision") primary = make("inspect-decisions", "Review open questions");
    else primary = make(facts.dispatch?.action ?? "inspect-task", status.action.label);
  }
  const nextActions = primary === null ? [] : [primary];
  if (questionAction !== null && primary?.code !== "answer-decision") nextActions.push(questionAction);
  const diagnostics = [...(status.diagnostics ?? [])];
  if (facts.dispatch !== null && facts.dispatch.code !== status.token && !diagnostics.some(one => one.token === facts.dispatch?.code)) {
    diagnostics.push({ token: facts.dispatch.code, label: facts.dispatch.summary, detail: facts.dispatch.detail, tone: "attention" });
  }
  return {
    taskId: facts.id, state: facts.state, resultRunId: facts.result?.runId ?? null, liveRunId: facts.liveRunId,
    status, primaryAction: primary, nextActions, diagnostics, evidence: resultDisplay === undefined ? "recorded" : "receipt-checked",
  };
}

export type WorkSummaryAccess = (
  /** `viewer`: the person reading, whose own lead's claim (lead-voice.ts) a task reads as "<name> is on it". */
  | { principal: "operator"; repos: readonly string[] | null; includeUnplaced?: boolean; viewer?: string | null }
  | { principal: "coordinator"; repos: readonly string[] }
) & {
  /** Remote task reads also restrict dependency details; omitted preserves existing local output. */
  dependencyRepos?: readonly string[] | null;
};

/** Admission precedes reading question/proof bodies. Missing and foreign
 * tasks share the same result. The caller must authenticate/revalidate
 * its principal; this allowlist is not a credential. */
export function taskWorkSummaryOf(store: Store, taskId: string, now: Date, access: WorkSummaryAccess): WorkSummary | null {
  const ref = store.lookupRef(taskId);
  if (ref === null || (ref.repo === null
    ? access.principal !== "operator" || access.includeUnplaced !== true
    : access.repos !== null && !access.repos.includes(ref.repo))) return null;
  const task = store.getTask(taskId);
  if (task === null) return null;
  const runs = store.runsFor(ref.id);
  const result = runs.find(one => one.finishedAt !== null && (one.role === "builder" || one.role === "scout")) ?? null;
  const proof = result === null ? null : store.proofVerdictFor(result.id);
  const lease = store.currentLiveLease(ref.id, now);
  const live = runs.find(one => one.outcome === null && lease !== null && one.leaseId === lease) ?? null;
  const publication = result === null ? null : store.publicationForRun(result.id);
  const facts: WorkFacts = {
    id: task.id, title: task.title, repo: ref.repo, state: task.state, updatedAt: task.updatedAt,
    ...(task.state === "done" && completionStands(store, task.id, now) ? { completed: true } : {}),
    ...(machineChecked(store, task.id) ? { machine: true } : {}),
    dispatch: diagnoseTaskDispatch(store, taskId, now, access.dependencyRepos ?? null), liveRunId: live?.id ?? null,
    unfinishedRunId: runs.find(one => one.outcome === null && one.role !== "reviewer")?.id ?? null,
    control: taskControlOf(store, ref.id, now), openDecision: openWorkDecisionOf(store, ref.id, now), heldFindings: heldFindingCount(store, taskId),
    result: result === null ? null : {
      runId: result.id, role: result.role, outcome: result.outcome,
      verdict: proof?.verdict ?? null, reasons: proof?.reasons ?? [], accepted: store.proofAcceptance(result.id) !== null,
      checkLevel: resultCheckLevel(store, result.id, now),
      ...(ref.repo == null ? {} : { checkSet: projectCheckSet(store, ref.repo) }),
      review: reviewFactsOf(store.reviewRetryStateOf(result.id), name => {
        const runner = store.getRunner(name)?.runner;
        return runner !== undefined && isAlive(runner, now);
      }, buildReviewOf(store, result.id)?.state === "pending"),
      ...(result.outcome !== "no-change" ? {} : { recordComplete: (() => {
        const kinds = new Set(store.artifactsFor(result.id).map(one => one.kind));
        return kinds.has("handoff") && kinds.has("terminal-diff");
      })() }),
    },
    publication: publication === null ? null : {
      state: publication.state, prNumber: publication.prNumber, prUrl: publication.prUrl,
      remoteState: publication.remoteState, lastCheckState: publication.lastCheckState,
    },
  };
  return workSummaryOf(facts, access.principal);
}

/**
 * Whether `taskId`'s family is complete now, read as the Work list reads it (work-index.ts `ready` and `checked`), so
 * this raw reading never says Ready or Needs you about work the list and the task page call Complete (everyday-9 C1,
 * review round 1). The task is its family's current, finished version with a valid result, under approved terms whose
 * digest is the result's, with no earlier version active, no unfinished run, live lease, hold, stop or unsettled
 * custody; and a completer recorded the completion of that result after every change and saved file of the family (a
 * follow-up check's own log and receipt aside: a check run later is a separate fact) and after its latest verdict and
 * acceptance. Questions, held findings and a stop under way keep their precedence in workStatusOf. Grants nothing.
 */
export function completionStands(store: Store, taskId: string, now: Date): boolean {
  try {
    const family = store.taskFamilyOf(taskId, null, true);
    if (family === null || family.problem !== null || family.current.id !== taskId || family.current.state !== "done") return false;
    const current = family.current;
    const runs = store.runsFor(current.refId);
    const result = runs.find(run => run.finishedAt !== null && (run.role === "builder" || run.role === "scout"));
    if (result === undefined || result.finishedAt === null) return false;
    const valid = result.role === "scout" ? result.outcome === "built"
      : (result.outcome === "built" || result.outcome === "no-change") && /^[0-9a-f]{40}$/.test(result.headRevision ?? "");
    if (!valid) return false;
    const scope = store.getScope(current.id);
    if (scope === null || scope.termsProblem != null || !approvalOf(scope).approved || scope.digest !== result.scopeDigest) return false;
    const busy = (refId: number) => store.currentLiveLease(refId, now) !== null || store.runsFor(refId).some(run => run.outcome === null && run.role !== "reviewer");
    if (family.versions.some(version => version.id !== current.id && ((version.state === "queued" && !refArchived(store, version.refId)) || version.state === "running" || busy(version.refId)))) return false;
    if (busy(current.refId) || store.activeHolds(current.refId, now).length > 0 || store.applicableStopFor(result.id) !== null) return false;
    const custody = stopFactOf(store, result.id);
    if (custody !== null && custody.kind !== "open") return false;
    const ids = JSON.stringify(family.versions.map(version => version.id));
    const one = (sql: string, ...values: (string | number)[]) => store.handle.prepare(sql).get(...values);
    const updated = String(one("SELECT MAX(updated_at) AS v FROM task WHERE id IN (SELECT value FROM json_each(?))", ids)?.["v"] ?? "");
    const changed = Number(one(`SELECT MAX(id) AS v FROM action_ledger WHERE task_id IN (SELECT value FROM json_each(?))
      AND action IN ('task state changed','scope approved','task placed','run started','run finished')`, ids)?.["v"] ?? 0);
    const saved = String(one(`SELECT MAX(ar.created_at) AS v FROM artifact ar JOIN run r ON r.id = ar.run JOIN task_ref tr ON tr.id = r.task_ref
      WHERE tr.backend = 'built-in' AND tr.external_id IN (SELECT value FROM json_each(?))
        AND NOT (ar.kind = 'structured-output' AND ar.capture IN (?, ?))`, ids, FOLLOW_UP_LOG, FOLLOW_UP_RECEIPT)?.["v"] ?? "");
    const after = [updated, result.finishedAt, scope.approvedAt ?? "", scope.proposedAt ?? ""];
    const rows = store.handle.prepare(`SELECT id, at, actor FROM action_ledger WHERE task_id = ? AND run_id = ? AND action = ? AND source = 'work'
      AND repo IS ? AND length(outcome) = 64 AND outcome NOT GLOB '*[^a-f0-9]*' ORDER BY id DESC`).all(family.root.id, result.id, COMPLETION_ACTION, current.repo);
    return rows.some(row => {
      const at = String(row["at"]);
      if (!COMPLETER_ACTOR.test(String(row["actor"])) || Number(row["id"]) < changed || at < saved || after.some(one => at < one)) return false;
      return one("SELECT 1 AS hit FROM proof_verdict WHERE run = ? AND decided_at > ?", result.id, at) === undefined
        && one("SELECT 1 AS hit FROM proof_acceptance WHERE run = ? AND accepted_at > ?", result.id, at) === undefined;
    });
  } catch { return false; }
}
