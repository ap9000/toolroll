/** Read-only work context shared by console, CLI, and agent adapters.
 * State, decisions, approval, process custody and proof still belong to
 * their existing owners. Action hints are navigation/proposal guidance,
 * never credentials or permission to bypass an owning operation. */
import { resultCheckLevel } from "./result-follow-ups.js";
import { diagnoseTaskDispatch, type DispatchAction } from "./dispatch.js";
import { isAlive } from "./runner.js";
import type { Store } from "./store.js";
import { taskControlOf } from "./task-control.js";
import { buildReviewOf } from "./review-switch.js";
import { reviewFactsOf, workStatusOf, type DisplayStatus, type WorkFacts, type WorkStatus } from "./workspace-ui.js";

export type WorkPrincipal = "operator" | "coordinator";
export type WorkTarget = { taskId: string; runId: number | null; decisionId: number | null };
export type WorkAction = {
  /** `confirm-stopped`: an approver confirms a finished build stopped (behind the password);
   * `sign-in`: the agent's sign-in, in Settings. */
  code: DispatchAction | "inspect-task" | "inspect-run" | "inspect-stop" | "inspect-decisions" | "reconcile-run" | "open-pr" | "confirm-stopped" | "sign-in";
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
const READ_ACTIONS = new Set<WorkAction["code"]>(["open-result", "open-pr", "inspect-task", "inspect-run", "inspect-stop", "inspect-decisions"]);

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
    dispatch: diagnoseTaskDispatch(store, taskId, now, access.dependencyRepos ?? null), liveRunId: live?.id ?? null,
    unfinishedRunId: runs.find(one => one.outcome === null && one.role !== "reviewer")?.id ?? null,
    control: taskControlOf(store, ref.id, now), openDecision: openWorkDecisionOf(store, ref.id, now),
    result: result === null ? null : {
      runId: result.id, role: result.role, outcome: result.outcome,
      verdict: proof?.verdict ?? null, reasons: proof?.reasons ?? [], accepted: store.proofAcceptance(result.id) !== null,
      checkLevel: resultCheckLevel(store, result.id, now),
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
