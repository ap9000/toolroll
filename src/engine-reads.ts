/**
 * The engine API's reads (solo-workbench plan v2, A0; contracts/engine-api.ts): a task's step cards and a result's
 * diff, file by file. Pure reads over the store and the sealed evidence: nothing here decides who may see what — the
 * route table and the handlers (server/engine-api.ts) admit the caller and the task before any of these runs, and
 * each read is given only what that admission resolved.
 *
 * Cheap on purpose: the step cards read the task's one assignment snapshot, its own work status and its runs (one
 * task's facts, never the whole Work projection or the task page); the diff reads the sealed patch and parses only the
 * file asked for, so the 2 MB result document is never built for a terminal.
 */
import { agentSaidOf, planProblemsOf, type Run, type Store, type TaskFamily } from "./store.js";
import { codexOfflineDependencySuggestion, failedAttemptSentence, latestFinishedAttempt, stopSuggestionOf } from "./needs-you.js";
import { pendingAgentChangeOf, planSourceOf, retryPinsOf } from "./local-owner-acts.js";
import { assignmentOf, owedAcceptance, personCompletionRefusal, type AssignmentSnapshot } from "./assignment.js";
import { assignmentCardOf } from "./assignment-ui.js";
import { behindMainOf, landedNowOf, upToDateNote } from "./merge-checklist.js";
import { publishesThroughPullRequests } from "./local-landing.js";
import { liveQuickCommand } from "./check-levels.js";
import { assignmentStageOf, stageOfCode } from "./task-status.js";
import { taskRoad, type RoadChecks } from "./first-run.js";
import { stepRowsOf, type StepRowFacts } from "./workspace-ui.js";
import { approvalOf } from "./scope.js";
import { approvalSummaryOf, summaryContextOf } from "./approval-summary.js";
import { taskWorkSummaryOf, type WorkSummaryAccess } from "./work-summary.js";
import { structuredHandoffView, terminalDiffView } from "./result-evidence-readers.js";
import { parseReviewDiff, proofBundleView } from "./server/render-results.js";
import { parseReport } from "./scout-report.js";
import { revisionSourceOf } from "./result-review.js";
import { DIFF_CONTEXT_MAX, ENGINE_API_VERSION, type AgentsRead, type ResultDiff, type ResultDiffContext, type ResultDiffFile, type StepCard, type StepCards, type TaskResult } from "./contracts/engine-api.js";
import { agentSetupOf, detectionLines, NO_AGENT_YET, npmRegistryOf, type AgentDetection } from "./agent-detect.js";
import { readVerifiedArtifact, reportShotsOf, scanPatchForSecrets } from "./evidence.js";
import { fastCompletionProblem } from "./fast-start.js";
import { cleanLiveText, HIDDEN_LINE } from "./live-records.js";
import { keyShaped } from "./flexible-conversation.js";
import { viewedGitSync } from "./teardown-git.js";
import { wasInterrupted } from "./run-ending.js";
import { agentChoicesFor, routeOfTask } from "./agentconfig.js";

/** A run that is the task's delivered result (task-views.ts runIsTaskResult): a finished build or investigation. */
export const isResultRun = (run: Pick<Run, "role" | "finishedAt">): boolean => run.finishedAt !== null && (run.role === "builder" || run.role === "scout");

/** Any builder or scout run a live terminal can open on (finished, failed, or still running). */
export const isTakeOverRun = (run: Pick<Run, "role">): boolean => run.role === "builder" || run.role === "scout";

const VALID_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A recorded full git commit SHA (SHA-1 or SHA-256), or null. */
export const validSha = (value: string | null | undefined): string | null =>
  value !== null && value !== undefined && VALID_SHA.test(value) ? value : null;

/** The commit Toolroll opens a build terminal on: the build's own saved commit when it made one, else the base commit it started from. */
export const takeOverRevisionOf = (run: Pick<Run, "headRevision" | "baseRevision">): string | null =>
  validSha(run.headRevision) ?? validSha(run.baseRevision);

/** Approvals no person gave at the moment of approval (a check rule's own yes). */
const AUTOMATIC = new Set(["auto-check", "auto-green"]);

type StepRead = { store: Store; family: TaskFamily; now: Date; access: WorkSummaryAccess; evidenceRoot: string;
  /** Who is reading (their completion is what `review.accept.needs` speaks of); null: nobody in particular. */
  viewer?: string | null;
  /** Compute `agentChoices` (the model picker asks with `?choices=1`); every other read leaves it null — it is the
   * costly part of the read and only the picker needs it. */
  withChoices?: boolean };

/** One task's step cards: the task page's road and rows (taskRoad, stepRowsOf) over the facts they read, each with
 * the agent, time and cost of the runs behind it. */
export function stepCardsOf({ store, family, now, access, evidenceRoot, viewer = null, withChoices = false }: StepRead): StepCards {
  const current = family.current, root = family.root;
  const ref = store.lookupRef(current.id);
  const scope = store.getScope(current.id);
  const runs = ref === null ? [] : store.runsFor(ref.id);
  const assignment = assignmentOf(store, current.id, now, access, evidenceRoot);
  // The task's own work status (one task's facts, not the whole Work projection), as the task page reads it.
  const item = taskWorkSummaryOf(store, current.id, now, access);
  const live = runs.find(run => run.finishedAt === null) ?? null;
  const planning = live?.role === "planner";
  const card = assignment === null || item === null ? null : assignmentCardOf(assignment, { workStatus: item.status, planning });
  const approval = approvalOf(scope);
  const approved = approval.approved;
  const report = ref?.deliverable === "report";
  const plannerRuns = runs.filter(run => run.role === "planner");
  // "Just code": no plan was asked for or written and the person's yes came with the task, so the chain has no Plan
  // and no Approval step (a client leaves those cards out).
  const justCode = plannerRuns.length === 0 && (ref?.plan ?? null) === null && approved;
  const journey = current.state === "cancelled" || item === null ? null : (() => {
    const read = assignment !== null ? assignmentStageOf(assignment, { token: item.status.token, views: item.status.views }, planning) : stageOfCode(item.status.token, { planning });
    const checks: RoadChecks = card?.status.check ?? null;
    return taskRoad(read, approved, current.state === "done", { checks, report });
  })();
  const facts: StepRowFacts = {
    journey,
    scout: report,
    status: card === null ? null : { status: { headline: card.status.headline }, attempts: card.attempts },
    approved: scope !== null && approved && scope.approvedBy !== null && scope.approvedAt !== null
      ? { by: scope.approvedBy, at: scope.approvedAt, automatic: AUTOMATIC.has(String(scope.approvalBasis ?? "")), rule: null } : null,
    approve: null,
    plan: plannerRuns.length === 0 && ref?.plan == null ? null
      : { lead: null, by: plannerRuns[0]?.provider ?? null, at: plannerRuns.find(run => run.finishedAt !== null)?.finishedAt ?? null, planning },
    result: assignment?.receipt == null ? null : { selected: assignment.receipt },
    thread: runs.filter(isResultRun).map(run => ({ kind: "result", at: run.finishedAt! })),
  };
  const rows = stepRowsOf(facts);
  const builds = runs.filter(run => run.role === "builder" || run.role === "scout" || run.role === "repair");
  const reviews = runs.filter(run => run.role === "reviewer");
  // The Plan card's attempts are the planning attempts (root planner runs), never their correction children.
  const behind: Record<StepCard["key"], Run[]> = { plan: plannerRuns.filter(run => run.parentRun === null), approve: [], build: builds, checks: [], review: reviews, ready: [] };
  // The waiting approval's terms: the one summary every surface shows (approval-summary.ts), its key what a yes pins.
  const terms = scope === null || approved ? null : (() => {
    const summary = approvalSummaryOf(scope, summaryContextOf(store, current.id, scope, now));
    return { key: summary.key, revision: summary.revision,
      rows: [...summary.revisionChanges, ...summary.decisions, ...(summary.why === null ? [] : [{ label: "Why model", words: summary.why }]), ...summary.differs].map(one => ({ label: one.label, words: one.words, lines: "lines" in one ? [...(one.lines ?? [])] : [] })),
      warnings: summary.warnings.map(one => one.words), usualLabel: summary.usualLabel, usual: summary.usual.map(one => ({ label: one.label, words: one.words })) };
  })();
  const cards: StepCard[] | null = current.state === "cancelled" ? cancelledCards(builds, current.updatedAt ?? null) : rows === null ? null : rows.map(row => ({
    key: row.key, label: row.label, state: row.state, mark: row.mark, sentence: row.sentence, at: row.at, needsYou: row.needsYou,
    inChain: !(justCode && (row.key === "plan" || row.key === "approve")),
    ...runFacts(behind[row.key]),
    ...(row.key === "approve" && terms !== null ? { terms } : {}),
  }));
  // The automatic review, where one ran: its own card after Checks (a chain's Review step reads the same way).
  if (cards !== null && reviews.length > 0) {
    const latest = reviews[0]!;
    const state: StepCard["state"] = latest.finishedAt === null ? "current" : latest.outcome === "failed" || latest.outcome === "refused" ? "stuck" : "done";
    const at = cards.findIndex(one => one.key === "ready");
    cards.splice(at === -1 ? cards.length : at, 0, {
      key: "review", label: "Review", state, mark: state === "current" ? "live" : state === "stuck" ? "stuck" : "done",
      sentence: state === "current" ? "Reviewing now" : state === "stuck" ? "The review didn't finish" : "Reviewed",
      at: latest.finishedAt, needsYou: false, inChain: true, ...runFacts(reviews),
    });
  }
  return {
    version: ENGINE_API_VERSION,
    task: { id: current.id, root: root.id, title: root.title, state: current.state, project: current.repo },
    chain: justCode ? "just-code" : "plan-first",
    // A cancelled task's own word (the stage's is "Stopped"): it ended because a person cancelled it.
    headline: current.state === "cancelled" ? "Cancelled" : card?.status.headline ?? null,
    liveRun: live?.id ?? null,
    // The newest run of this task, live or finished: what a cancel names as the build it showed (store.cancelTask).
    latestRun: runs.reduce<number | null>((max, run) => max === null || run.id > max ? run.id : max, null),
    // The agent each step of THIS task runs (its approved, proposed or recommended route); null when it has no exact route.
    models: (() => {
      const routed = routeOfTask(store, current.id, ref, now);
      return routed?.kind === "route" ? routed.route.legs.map(leg => ({ phase: leg.phase, provider: leg.provider, model: leg.model, chosen: leg.chosen })) : null;
    })(),
    cards,
    // The result this task's page offers Accept and Send back on (chat-decide.ts resultFresh reads the same facts).
    review: assignment !== null && assignment.state === "ready-to-check" && assignment.receipt !== null && assignment.receipt.taskId === current.id
      ? { run: assignment.receipt.runId, receipt: assignment.receipt.digest, source: revisionSourceOf(scope?.digest ?? null),
        accept: acceptFactsOf(store, assignment, viewer, evidenceRoot) } : null,
    // The build Open build shell would open (the result waiting, else the newest build), and why it can't be, in the
    // words the start refuses with (server/terminals.ts takeOverOf): asked before anything is confirmed.
    shell: shellOf(store, family,
      assignment !== null && assignment.state === "ready-to-check" && assignment.receipt !== null && assignment.receipt.taskId === current.id
        ? assignment.receipt.runId : builds[0]?.id ?? null),
    failure: current.state === "failed" ? failureOf(store, ref?.id ?? null, current.repo, builds) : null,
    waiting: (() => {
      const waiting = waitingOf(store, current.id, now);
      if (waiting === null) return null;
      // What the agent said on its way out of the attempt that failed (a build, or a plan attempt), while it waits to try
      // again (the Steps tab shows it).
      const last = waiting.attempt === "plan" ? latestFinishedPlanner(plannerRuns) : latestFinishedAttempt(builds);
      return { ...waiting, agentSaid: last !== null && last.outcome === "failed" ? agentSaidOf(store, last.id) : null };
    })(),
    // A hold matters only while the task could still run: a cancelled or finished task has nothing to resume.
    held: current.state === "cancelled" || current.state === "done" ? null : heldOf(store, ref?.id ?? null, builds, now),
    retry: current.state === "failed" ? (() => { const pins = retryPinsOf(store, current.id); return pins === null ? null : { run: pins.run, digest: pins.digest }; })() : null,
    planStopped: planStoppedOf(store, current.id, ref?.id ?? null, plannerRuns),
    plan: planAskOf(store, current.id, current.state, ref, scope, live !== null, now),
    planQueued: planQueuedOf(store, current.state, ref, scope, live !== null, now),
    approval: scope !== null && approved && scope.approvedBy !== null
      ? { by: scope.approvedBy, you: viewer !== null && scope.approvedBy === viewer, automatic: AUTOMATIC.has(String(scope.approvalBasis ?? "")) } : null,
    // A model pick (POST /t/<task>/route): the digest it binds to, the configured choices it may name, and one waiting.
    scopeDigest: scope?.digest ?? null,
    agentChoices: scope === null || !withChoices ? null : agentChoicesOf(store, current.id, ref, now),
    pendingAgentChange: ref === null ? null : pendingAgentChangeOf(store, ref.id),
    // Its landing history, when its work is already on its branch (display only).
    landing: assignment === null ? null : landedNowOf(store, assignment),
    // The approved check, when it holds the result back without a failure headline saying so: failed (a Complete task's
    // check that ran again), out of date (its command changed) or unreadable. A terminal marks only a failure as one.
    ...(card?.status.check === "failed" || card?.status.check === "stale" || card?.status.check === "unreadable" ? { check: card.status.check } : {}),
    ...(() => { const offer = runChecksOfferOf(store, assignment, card?.status.check ?? null); return offer === null ? {} : { runChecks: offer }; })(),
    // An accepted result behind main (stranger 17): Send back brings it up to date, so a terminal's r offers it too.
    ...(() => { const offer = assignment === null || assignment.receipt?.taskId !== current.id ? null : behindMainOfferOf(store, assignment, scope?.digest ?? null); return offer === null ? {} : { behindMain: offer }; })(),
    room: `task:${encodeURIComponent(root.id)}`,
  };
}

/** What Run checks again posts (POST /r/<run>/checks `level`, the task page's own Run checks): the current result's build
 * and the level the project has a command for, when its check failed, is out of date, can't be read or didn't run.
 * Display only: who may run them is the console's to decide at the post (server/tasks.ts runFollowUp), exactly as for
 * the page. Null otherwise; nothing is read unless the check holds the result back. */
function runChecksOfferOf(store: Store, assignment: AssignmentSnapshot | null, check: string | null): NonNullable<StepCards["runChecks"]> | null {
  if (check !== "failed" && check !== "stale" && check !== "unreadable" && check !== "not-run") return null;
  const receipt = assignment?.receipt ?? null;
  if (receipt === null || receipt.head === null || receipt.completionKind === "research-report" || assignment!.repo === null || store.isDemo()) return null;
  const level = store.liveVerifyCommand(assignment!.repo) !== null ? "full" as const : liveQuickCommand(store, assignment!.repo) !== null ? "quick" as const : null;
  return level === null ? null : { run: receipt.runId, level };
}

/** What Send back posts for an accepted result behind its project's main (StepCards.behindMain): only in a project
 * without pull requests, not landed, and not after a catch-up that conflicted with main as it is now (then sending it
 * back can't help). Display only: the post proves everything again. Null otherwise. */
function behindMainOfferOf(store: Store, assignment: AssignmentSnapshot, scopeDigest: string | null): NonNullable<StepCards["behindMain"]> | null {
  const receipt = assignment.receipt;
  if (assignment.state !== "complete" || receipt === null || receipt.head === null || receipt.completionKind === "research-report" || assignment.repo === null || store.isDemo()) return null;
  if (publishesThroughPullRequests(store, assignment.repo) || landedNowOf(store, assignment) !== null) return null;
  const standing = behindMainOf(store, assignment, undefined);
  if (standing === null || standing.main === null || standing.behind === null || standing.behind === 0 || standing.conflict !== null) return null;
  return { run: receipt.runId, receipt: receipt.digest, source: revisionSourceOf(scopeDigest), main: standing.main, behind: standing.behind, note: upToDateNote(standing.main) };
}

/** The words Open build shell is refused with when its build has nothing to open on, as the start itself says them
 * (server/terminals.ts takeOverOf, which re-proves every one of them when a terminal is asked for). */
export const SHELL_NO_RESULT = "This build has no saved result yet. Wait for it to finish (or stop it), then open the build shell.";
export const SHELL_NO_COMMIT = "This build has no saved commit to open a terminal on.";

/** Open build shell's build (`run`) and why it can't be opened (null: it can be, as far as the saved facts say). */
function shellOf(store: Store, family: TaskFamily, runId: number | null): StepCards["shell"] {
  if (runId === null) return null;
  const run = resultRunsOf(store, family).find(one => one.id === runId)
    ?? takeOverRunsOf(store, family).find(one => one.id === runId)
    ?? null;
  if (run === null) return { run: runId, why: SHELL_NO_RESULT };
  if (takeOverRevisionOf(run) === null) return { run: runId, why: SHELL_NO_COMMIT };
  return { run: runId, why: null };
}

/** A failed task's latest finished build attempt in one plain line, how many attempts in a row failed (newest first,
 * stopping at the first that didn't), and its suggestion (needs-you.ts, the words the task page says). */
function failureOf(store: Store, taskRef: number | null, repo: string | null, builds: readonly Run[]): NonNullable<StepCards["failure"]> {
  const last = latestFinishedAttempt(builds);
  // The engine's own count (claim.ts addStrike): failures since the last success or the last person's Retry, which
  // clears them (store.requeueTask resetStrikes). The words "N consecutive failures" mean exactly that.
  const failedInARow = taskRef === null ? 0
    : Number(store.handle.prepare("SELECT strikes FROM task_ref WHERE id = ?").get(taskRef)?.["strikes"] ?? 0);
  const agentSaid = last === null ? null : agentSaidOf(store, last.id);
  const codexHint = last === null || last.provider !== "codex" ? null : codexOfflineDependencySuggestion({
    provider: last.provider,
    agentSaid,
    hasSetup: repo !== null && store.liveWorktreeSetup(repo) !== null,
  });
  return { line: failedAttemptSentence(last?.reason), failedInARow, suggestion: last === null ? null : (codexHint ?? stopSuggestionOf(last.reason)),
    agentSaid };
}

/** A cancelled task's history: its builds as they ran, then Cancelled, the end (no road goes on from there). */
function cancelledCards(builds: readonly Run[], at: string | null): StepCard[] {
  const out: StepCard[] = [];
  const latest = builds[0] ?? null;
  if (latest !== null) {
    const failed = latest.outcome === "failed" || latest.outcome === "refused" || wasInterrupted(latest);
    out.push({ key: "build", label: "Build", state: failed ? "stuck" : "done", mark: failed ? "stuck" : "done",
      sentence: failed ? failedAttemptSentence(latest.reason).replace(/[.\s]+$/, "") : "The build finished", at: latest.finishedAt,
      needsYou: false, inChain: true, ...runFacts(builds) });
  }
  out.push({ key: "ready", label: "Cancelled", state: "skipped", mark: "skipped", sentence: "Cancelled: nothing else will run for this task.",
    at, needsYou: false, inChain: true, ...runFacts([]) });
  return out;
}

/** A person's hold on a queued task (the operator's own: "Hold the next attempt", the terminal's Stop retrying): what
 * Resume releases (POST /t/<task>/unhold with `hold`, proved where it is released), its reason, and the last build's
 * failure in a short line. Null when no such hold stands. */
function heldOf(store: Store, taskRef: number | null, builds: readonly Run[], now: Date): StepCards["held"] {
  if (taskRef === null) return null;
  const hold = store.activeHolds(taskRef, now).find(one => one.ownerKind === "operator") ?? null;
  if (hold === null) return null;
  const last = latestFinishedAttempt(builds);
  return { id: hold.id, reason: hold.reason,
    lastFailure: last !== null && last.outcome === "failed" ? failedAttemptSentence(last.reason).replace(/[.\s]+$/, "") : null };
}

/** When a waiting task tries again, why its last attempt stopped, and whether that attempt was a build or a plan
 * (contracts/engine-api.ts waitingSchema). */
type Waiting = { retryAt: string | null; lastFailure: string | null; attempt: "build" | "plan" };

/** A queued task waiting to start again: when the next try is due (its backoff hold's end; null: when a builder is
 * free) and the last build's failure in one short line. Null unless the task is queued and its last build failed or a
 * backoff holds it. */
export function waitingOf(store: Store, taskId: string, now: Date): Waiting | null {
  return waitingForTasks(store, [taskId], now).get(taskId) ?? null;
}

/**
 * waitingOf for many tasks at once (the Work rows read): one statement whatever the number of rows, never a few per
 * row. Tasks with nothing to wait on are absent.
 */
export function waitingForTasks(store: Store, taskIds: readonly string[], now: Date): Map<string, Waiting> {
  const out = new Map<string, Waiting>();
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return out;
  const at = now.toISOString();
  // One statement: the queued built-in tasks among them, each with its earliest-held active backoff (activeHolds' order)
  // and its latest finished build attempt (ended means a finish time or an outcome: latestFinishedAttempt).
  const rows = store.handle.prepare(`SELECT task.id AS task,
      EXISTS (SELECT 1 FROM hold WHERE hold.task_ref = task_ref.id AND hold.owner_kind = 'backoff' AND (hold.until IS NULL OR hold.until > ?)) AS held,
      (SELECT hold.until FROM hold WHERE hold.task_ref = task_ref.id AND hold.owner_kind = 'backoff' AND (hold.until IS NULL OR hold.until > ?) ORDER BY hold.held_at, hold.id LIMIT 1) AS until,
      (SELECT run.outcome FROM run WHERE run.task_ref = task_ref.id AND run.role IN ('builder', 'scout', 'repair', 'planner') AND NOT (run.role = 'planner' AND run.parent_run IS NOT NULL) AND (run.finished_at IS NOT NULL OR run.outcome IS NOT NULL) ORDER BY run.id DESC LIMIT 1) AS outcome,
      (SELECT run.reason FROM run WHERE run.task_ref = task_ref.id AND run.role IN ('builder', 'scout', 'repair', 'planner') AND NOT (run.role = 'planner' AND run.parent_run IS NOT NULL) AND (run.finished_at IS NOT NULL OR run.outcome IS NOT NULL) ORDER BY run.id DESC LIMIT 1) AS reason,
      (SELECT run.role FROM run WHERE run.task_ref = task_ref.id AND run.role IN ('builder', 'scout', 'repair', 'planner') AND NOT (run.role = 'planner' AND run.parent_run IS NOT NULL) AND (run.finished_at IS NOT NULL OR run.outcome IS NOT NULL) ORDER BY run.id DESC LIMIT 1) AS role
    FROM task JOIN task_ref ON task_ref.backend = 'built-in' AND task_ref.external_id = task.id
    WHERE task.state = 'queued' AND task.id IN (${ids.map(() => "?").join(", ")})
      -- A person's hold (Stop retrying, a pause, a question, an incident) means it isn't waiting to try again.
      AND NOT EXISTS (SELECT 1 FROM hold WHERE hold.task_ref = task_ref.id AND hold.owner_kind <> 'backoff' AND (hold.until IS NULL OR hold.until > ?))`).all(at, at, ...ids, at);
  for (const row of rows) {
    const failed = row["outcome"] === "failed";
    const held = Number(row["held"]) === 1;
    if (!failed && !held) continue;
    out.set(String(row["task"]), {
      retryAt: held && row["until"] != null ? String(row["until"]) : null,
      lastFailure: failed ? failedAttemptSentence(row["reason"] == null ? null : String(row["reason"])).replace(/[.\s]+$/, "") : null,
      // The latest attempt that ended was a planning turn (the planner's own backoff): the plan is tried again, not a build.
      attempt: row["role"] === "planner" ? "plan" : "build",
    });
  }
  return out;
}

/** Who ran a step's latest run, when its runs started and ended, and their recorded cost together. Runs are newest first. */
function runFacts(runs: readonly Run[]): Pick<StepCard, "agent" | "startedAt" | "latestStartedAt" | "finishedAt" | "costUsd" | "runs"> {
  const latest = runs[0] ?? null;
  const costs = runs.map(run => run.costUsd).filter((one): one is number => typeof one === "number" && Number.isFinite(one));
  return {
    agent: latest === null ? null : { provider: latest.provider, model: latest.modelReported ?? latest.model ?? null },
    startedAt: runs.at(-1)?.startedAt ?? null,
    latestStartedAt: latest?.startedAt ?? null,
    finishedAt: latest?.finishedAt ?? null,
    costUsd: costs.length === 0 ? null : Math.round(costs.reduce((sum, one) => sum + one, 0) * 1e6) / 1e6,
    runs: runs.map(run => run.id),
  };
}

// ---- the result's diff, file by file -------------------------------------------------------------------------------

/** The family's result runs, newest first: every run the Result tab can pick. */
export function resultRunsOf(store: Store, family: TaskFamily): Run[] {
  return family.versions.flatMap(version => store.runsFor(version.refId)).filter(isResultRun).sort((a, b) => b.id - a.id);
}

/** Every builder or scout run in the family that a live terminal can open on, newest first. */
export function takeOverRunsOf(store: Store, family: TaskFamily): Run[] {
  return family.versions.flatMap(version => store.runsFor(version.refId)).filter(isTakeOverRun).sort((a, b) => b.id - a.id);
}

/** The patch cut at each file's `diff --git` line: each file's own text, in the patch's order. */
export function patchFiles(text: string): string[] {
  // Each part without the newline that ends it (that newline belongs to the boundary, not to a last empty line).
  return text.replace(/\r\n/g, "\n").split(/^(?=diff --git )/m).filter(part => part.startsWith("diff --git ")).map(part => part.replace(/\n$/, ""));
}

type DiffSource = { ok: true; patch: string; truncated: boolean; stat: ReturnType<typeof terminalDiffView> } | { ok: false; problem: string };

function diffSourceOf(store: Store, evidenceRoot: string, run: Run): DiffSource {
  const view = terminalDiffView(store.artifactsFor(run.id), evidenceRoot);
  if (view === null) return { ok: false, problem: "This result recorded no changes." };
  if (view.patch === null) return { ok: false, problem: "This result's changes weren't saved." };
  if ("problem" in view.patch) return { ok: false, problem: `This result's changes can't be shown: ${view.patch.problem}.` };
  return { ok: true, patch: view.patch.text, truncated: view.patch.truncated, stat: view };
}

/** A result's changed files with their counts, from its sealed patch (counted from the patch itself, so the list and the
 * hunks read the same bytes), and the saved stat's totals where it verified. */
export function resultDiffOf(store: Store, evidenceRoot: string, taskId: string, run: Run | null): ResultDiff {
  const empty = (problem: string): ResultDiff => ({ version: ENGINE_API_VERSION, task: taskId, run: run?.id ?? null, totals: null, files: [], patchTruncated: false, problem });
  if (run === null) return empty("No result yet.");
  const source = diffSourceOf(store, evidenceRoot, run);
  if (!source.ok) return empty(source.problem);
  const files = patchFiles(source.patch).map((text, index) => {
    const parsed = parseReviewDiff(text).files[0];
    let additions = 0, deletions = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    const binary = /^(?:Binary files .* differ|GIT binary patch)$/m.test(text);
    return { file: index, path: parsed?.path ?? "changed file", oldPath: parsed?.oldPath ?? null, additions, deletions, binary, hunks: parsed?.hunks.length ?? 0 };
  });
  const stat = source.stat?.stat;
  const totals = stat == null || "problem" in stat ? null
    : { files: stat.fileCount, additions: stat.additions, deletions: stat.deletions, binary: stat.binaryCount, filesTruncated: stat.filesTruncated };
  return { version: ENGINE_API_VERSION, task: taskId, run: run.id, totals, files, patchTruncated: source.truncated, problem: null };
}

/** One file's hunks from a result's sealed patch, or null when the result or the file isn't there. */
export function resultDiffFileOf(store: Store, evidenceRoot: string, taskId: string, run: Run, file: number): ResultDiffFile | null {
  const source = diffSourceOf(store, evidenceRoot, run);
  if (!source.ok) return null;
  const text = patchFiles(source.patch)[file];
  if (text === undefined) return null;
  const parsed = parseReviewDiff(text);
  const one = parsed.files[0];
  if (one === undefined) return null;
  return { version: ENGINE_API_VERSION, task: taskId, run: run.id, file: { file, path: one.path, oldPath: one.oldPath, meta: one.meta, hunks: one.hunks, lineCount: patchLineCount(one.hunks) }, linesTruncated: parsed.linesTruncated };
}

/** What accepting a waiting result means for `viewer`, read the way the completion reads it (assignment.ts
 * acknowledgeCurrent, acceptAndCompleteAsOperator; result-page's personCompletionRefusal): words only, never permission. */
function acceptFactsOf(store: Store, assignment: AssignmentSnapshot, viewer: string | null, evidenceRoot: string): NonNullable<StepCards["review"]>["accept"] {
  const receipt = assignment.receipt!;
  const blockers = assignment.readiness?.blockers ?? [];
  // Cheap first (wire budgets): only a project that protects something can need a second person, and only then are the
  // result's changed files read (protectedResultProblem answers null at once for a project without rules, so this is
  // the same answer as personCompletionRefusal's, without reading every build's file list for nothing).
  const rules = assignment.repo === null ? null : store.approvalRules(assignment.repo);
  const guarded = rules !== null && (rules.protectProject || rules.protectedPaths.length > 0);
  return {
    owed: owedAcceptance(receipt, blockers),
    blockers: blockers.map(one => one.message),
    needs: guarded ? personCompletionRefusal(store, receipt.taskId, receipt.runId, viewer, evidenceRoot) : fastCompletionProblem(store, receipt.taskId, receipt.runId, viewer),
  };
}

/** The largest file a context read loads (its head blob), and the longest line it sends. */
const CONTEXT_FILE_BYTES = 2 * 1024 * 1024;
const CONTEXT_LINE_CHARS = 2_000;
/**
 * Whether a file holds key material a context read never shows, anywhere in it (conservative: a false alarm only
 * hides context): a PEM private key, a PuTTY private key, an AWS secret key assignment (any value), or a private JWK
 * ("d" alongside "kty", "crv" or "n": a JWK is often spread over many lines, so this looks at the whole file).
 */
function keyMaterialIn(content: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content) || /PuTTY-User-Key-File-\d+:/.test(content)) return true;
  if (/\b(?:aws_secret_access_key|SecretAccessKey)\b["']?\s*[=:]/i.test(content)) return true;
  return /"d"\s*:\s*"[^"]{8,}"/.test(content) && /"(?:kty|crv|n)"\s*:/.test(content);
}

/**
 * Lines `from`..`from + count - 1` of one file of a result as its build left it, to show context its hunks hide
 * (T2's context expand). The file is the patch's own file `file` (the same sealed bytes the hunks read), read at the
 * run's recorded head commit from the project's repository as Toolroll records them (`repo`, `run.headRevision`), never
 * from anything a checkout says: the head must be the one the saved stat names, and the read goes through the hardened
 * view (viewedGitSync: no config, hooks, filters or network the checkout chose). At most DIFF_CONTEXT_MAX lines, from a
 * file of at most CONTEXT_FILE_BYTES that is text; a line that looks like a key is replaced as the saved diff does.
 * null when the result or the file isn't there.
 */
export function resultDiffContextOf(store: Store, evidenceRoot: string, taskId: string, run: Run, file: number, from: number, count: number,
  repo: string | null): ResultDiffContext | null {
  const source = diffSourceOf(store, evidenceRoot, run);
  if (!source.ok) return null;
  const text = patchFiles(source.patch)[file];
  if (text === undefined) return null;
  const one = parseReviewDiff(text).files[0];
  if (one === undefined) return null;
  const answer = (lines: ResultDiffContext["lines"], lineCount: number | null, problem: string | null): ResultDiffContext =>
    ({ version: ENGINE_API_VERSION, task: taskId, run: run.id, file, from, lines, lineCount, problem });
  const unread = "The rest of this file can't be read here. Press w to see it in the browser.";
  if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(count) || count < 1 || count > DIFF_CONTEXT_MAX) return answer([], null, unread);
  if (/^deleted file mode /m.test(text) || /^\+\+\+ \/dev\/null$/m.test(text)) return answer([], 0, "This file was removed by the change.");
  const stat = source.stat?.stat;
  const head = run.headRevision;
  if (repo === null || head === null || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head) || stat == null || "problem" in stat || stat.head !== head) return answer([], null, unread);
  // Which file: the one git itself listed as changed for this run (the saved stat, its names NUL-delimited from git),
  // matched exactly by the patch file's name. Text inside the patch never chooses another file to read.
  const path = stat.files.map(changed => changed.path).find(changed => changed === one.path) ?? null;
  if (path === null || path === "" || path.startsWith("/") || path.split("/").some(part => part === ".." || part === "." || part === "")
    || /[\u0000-\u001f\u007f]/.test(path)) return answer([], null, unread);
  let bytes: Buffer;
  try {
    const listed = viewedGitSync(repo, ["--no-replace-objects", "--literal-pathspecs", "ls-tree", "-z", "-l", "--full-tree", head, "--", path],
      { timeoutMs: 10_000, maxBuffer: 64 * 1024, binding: { repo } });
    if (listed.status !== 0) return answer([], null, unread);
    const entry = listed.stdout.split("\0").map(row => /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t(.+)$/s.exec(row)).find(match => match !== null && match[5] === path);
    if (entry == null) return answer([], 0, "This file isn't in the result's commit.");
    const [, mode, kind, oid, sized] = entry as unknown as [string, string, string, string, string];
    if (kind !== "blob" || (mode !== "100644" && mode !== "100755") || sized === "-") return answer([], null, "This file isn't text.");
    const size = Number(sized);
    if (size > CONTEXT_FILE_BYTES) return answer([], null, "This file is too large to show here. Press w to see it in the browser.");
    const read = viewedGitSync(repo, ["--no-replace-objects", "cat-file", "blob", oid], { timeoutMs: 10_000, maxBuffer: size + 1024, binding: { repo }, buffer: true });
    if (read.status !== 0 || read.stdout.length !== size) return answer([], null, unread);
    bytes = read.stdout;
  } catch {
    return answer([], null, unread);
  }
  let content: string;
  try {
    if (bytes.includes(0)) throw new Error("binary");
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return answer([], null, "This file isn't text.");
  }
  // A private key can span lines, and any window could start or end inside one: a file holding key material anywhere
  // shows none of its hidden lines here (not only the lines asked for).
  if (keyMaterialIn(content)) return answer([], null, "This file holds what looks like a private key or secret, so its hidden lines aren't shown here.");
  const all = content.split("\n");
  if (all.at(-1) === "") all.pop();
  const lineCount = all.length;
  const whole = all.slice(from - 1, from - 1 + count).map(line => line.replace(/\r$/, ""));
  // The saved diff's rule for keys (evidence.ts), on each line WHOLE (before any cut, so a key across the cut is found):
  // checked as lines the change adds, each hit replaced by its marker; only then is a long line shortened.
  const hits = new Map(scanPatchForSecrets(["diff --git a/f b/f", `@@ -0,0 +1,${whole.length} @@`, ...whole.map(line => `+${line}`)].join("\n")).map(hit => [hit.line - 3, hit.name] as const));
  const lines = whole.map((line, index) => {
    const name = hits.get(index);
    return { newLine: from + index, text: name === undefined ? line.slice(0, CONTEXT_LINE_CHARS) : `[redacted: ${name} detected on this line]` };
  });
  return answer(lines, lineCount, null);
}

/** `GET /t/<task>/result[?run=<id>]`: the task's human-readable verified deliverable (scout report, builder handoff, and verified screenshots). */
export function taskResultOf(store: Store, evidenceRoot: string, family: TaskFamily, run: Run | null): TaskResult {
  const ref = store.lookupRef(family.current.id);
  const deliverable: "code" | "report" = ref?.deliverable === "report" || run?.role === "scout" ? "report" : "code";
  if (run === null) {
    return {
      version: ENGINE_API_VERSION,
      task: family.root.id,
      deliverable,
      run: null,
      role: null,
      outcome: null,
      verdict: null,
      summary: null,
      report: null,
      handoff: null,
      screenshots: [],
    };
  }
  const artifacts = store.artifactsFor(run.id);
  const reportArtifact = [...artifacts].reverse().find(one => one.kind === "report");
  let report: TaskResult["report"] = null;
  if (reportArtifact !== undefined) {
    let read: ReturnType<typeof readVerifiedArtifact>;
    try {
      read = readVerifiedArtifact(evidenceRoot, reportArtifact);
    } catch {
      read = { ok: false, problem: "the report file could not be read" };
    }
    if (!read.ok) {
      report = { ok: false, problem: read.problem };
    } else {
      const parsed = parseReport(read.content.toString("utf8"), { stored: true });
      if (!parsed.ok) {
        report = {
          ok: false,
          problem: reportArtifact.truncated
            ? "the report was shortened at storage and cannot be read; the missing part was never captured"
            : "the stored report is not a report this console can read",
        };
      } else {
        const shots = reportShotsOf(artifacts, evidenceRoot, run.id, parsed.report.images).map(shot => ({
          file: shot.file,
          caption: shot.caption,
          url: shot.url,
          artifactUrl: shot.artifactId === null ? null : `/r/${run.id}/evidence/${shot.artifactId}`,
          problem: shot.problem,
        }));
        report = {
          ok: true,
          title: parsed.report.title,
          summary: parsed.report.summary,
          document: parsed.report.report,
          truncated: reportArtifact.truncated,
          items: parsed.report.items,
          followUps: parsed.report.followUps,
          shots,
        };
      }
    }
  }
  const handoffView = structuredHandoffView(artifacts, evidenceRoot);
  const handoff: TaskResult["handoff"] = handoffView === null ? null : {
    conclusion: handoffView.conclusion,
    changes: handoffView.changes,
    verification: handoffView.verification,
    followUps: handoffView.followUps,
    decisions: handoffView.report.decisions,
    assumptions: handoffView.report.assumptions,
    notDone: handoffView.report.notDone,
    risks: handoffView.report.risks,
  };
  const proof = proofBundleView(store, run, artifacts, evidenceRoot);
  const screenshots = (proof?.screenshots ?? [])
    .filter(one => one.problem === null)
    .map(one => ({
      caption: one.caption,
      path: one.path,
      url: `/r/${run.id}/evidence/${one.artifactId}`,
    }));
  const verdictRow = store.proofVerdictFor(run.id);
  const summary = (report !== null && report.ok ? report.summary : null) ?? handoff?.conclusion ?? null;
  return {
    version: ENGINE_API_VERSION,
    task: family.root.id,
    deliverable,
    run: run.id,
    role: run.role,
    outcome: run.outcome,
    verdict: verdictRow?.verdict ?? null,
    summary,
    report,
    handoff,
    screenshots,
  };
}

/** An agent's setup as the agents read says it: Toolroll's own commands (agent-detect.ts AGENT_SETUP). */
export function setupOf(id: string, home: string | null = null): AgentsRead["agents"][number]["setup"] {
  const setup = agentSetupOf(id);
  if (setup === null) return { install: null, canInstall: false, signIn: null, canSignIn: false, key: null, check: null, note: null, registry: null, registryUnsure: false };
  const pkg = setup.installRun?.binary === "npm" ? setup.installRun.args[2] ?? null : null;
  const registry = pkg === null || home === null ? { url: null, unsure: false } : npmRegistryOf(home, pkg);
  return { install: setup.install, canInstall: setup.installRun !== null, signIn: setup.signIn, canSignIn: setup.signInRun !== null, key: setup.key, check: setup.check, note: setup.note,
    registry: registry.url, registryUnsure: registry.unsure };
}

/** `GET /engine/agents`: the last detection of this computer's agents (agent-detect.ts) as the contract says it; null
 * (not looked for yet) reads as no agents and the "looking" line. */
export function agentsReadOf(detection: AgentDetection | null, view: "full" | "summary" = "full", home: string | null = null,
  /** Claude's note as this person's own live status for threads (their sign-in, the switch), in place of the setup's. */
  claudeNote: string | null = null): AgentsRead {
  const agents = (detection?.agents ?? []).map(one => {
    const setup = setupOf(one.id, home);
    return { id: one.id, name: one.name, state: one.state, how: one.how, signIn: one.signIn, ready: one.ready, next: one.next, setup: one.id === "claude" && claudeNote !== null ? { ...setup, note: claudeNote } : setup };
  });
  const first = detection?.firstTask ?? null;
  const firstTask = first === null ? null : { id: first, name: agents.find(one => one.id === first)?.name ?? first };
  // Summary (a person who isn't an instance operator, server/welcome.ts agentInventoryOf): who the first task goes to,
  // never which agents this computer has.
  if (view === "summary") {
    const lines = firstTask !== null ? [`Your first task goes to ${firstTask.name}.`] : detection === null ? detectionLines(null) : [NO_AGENT_YET];
    return { version: ENGINE_API_VERSION, checkedAt: detection?.checkedAt ?? null, agents: [], firstTask, lines };
  }
  return { version: ENGINE_API_VERSION, checkedAt: detection?.checkedAt ?? null, agents, firstTask, lines: detectionLines(detection) };
}

// ---- Plan failures (the stranger test, round 10) --------------------------------------------------------------------

/** The incidents only a planning turn opens (claim.ts sealPlanFailure): Plan again resolves them, never Retry. */
export const PLANNER_INCIDENTS: Readonly<Record<string, "plan" | "question" | "stalled">> = Object.freeze({
  "malformed-plan": "plan", "malformed-decision": "question", "plan-attempts-exhausted": "stalled",
});

/** The newest planning attempt that ended (a finish time or an outcome), or null: a root planner run, never its
 * correction child (claim.ts sealPlanFailure keeps the attempt's reason and what the agent said on the root). */
function latestFinishedPlanner(planners: readonly Run[]): Run | null {
  let latest: Run | null = null;
  for (const run of planners) if (run.parentRun === null && (run.finishedAt !== null || (run.outcome ?? null) !== null) && (latest === null || run.id > latest.id)) latest = run;
  return latest;
}

/** The line a stopped plan reads as: what stopped it, in plain words (needs-you.ts), never the attempt's own message. */
export function planStoppedLine(kind: "plan" | "question" | "stalled", strikes: number, reason: string | null): string {
  if (kind === "plan") return "The plan didn't pass its checks.";
  if (kind === "question") return "The planner's question didn't pass its checks.";
  const why = failedAttemptSentence(reason).replace(/[.\s]+$/, "").replace(/^./, first => first.toLowerCase());
  return `Planning stopped after ${Math.max(strikes, 1)} failed attempts in a row: ${why}.`;
}

/**
 * A plan that stopped and waits for Plan again (contracts/engine-api.ts stepCardsSchema.planStopped): this version's open
 * incident from a planning turn, what stopped it in plain words, why the plan was refused and what the agent said
 * (cleaned: planProblemsOf, agentSaidOf), and what Plan again binds to (the incident and the planning source the screen
 * read; null when it can't be asked as it stands). Read facts only: Plan again proves every one of them again.
 */
function planStoppedOf(store: Store, taskId: string, taskRef: number | null, planners: readonly Run[]): StepCards["planStopped"] {
  if (taskRef === null) return null;
  const row = store.handle.prepare(`SELECT incident.id, incident.kind, incident.run FROM incident JOIN run ON run.id = incident.run
      WHERE run.task_ref = ? AND run.role = 'planner' AND incident.resolved_at IS NULL ORDER BY incident.id DESC LIMIT 1`).get(taskRef);
  if (row === undefined) return null;
  const kind = PLANNER_INCIDENTS[String(row["kind"])];
  if (kind === undefined) return null;
  const run = Number(row["run"]);
  const reason = planners.find(one => one.id === run)?.reason ?? null;
  const strikes = Number(store.handle.prepare("SELECT plan_strikes FROM task_ref WHERE id = ?").get(taskRef)?.["plan_strikes"] ?? 0);
  const source = planSourceOf(store, taskId);
  const plan = store.handle.prepare("SELECT plan FROM task_ref WHERE id = ?").get(taskRef)?.["plan"];
  return {
    incident: Number(row["id"]), kind, line: planStoppedLine(kind, strikes, reason),
    problems: planProblemsOf(store, run), agentSaid: agentSaidOf(store, run),
    again: source !== null && plan === "requested" ? { source } : null,
  };
}

/**
 * What asking for a plan binds to (stepCardsSchema.plan), under the task page's own "plan first" rule
 * (render-tasks.ts canPlan): no plan asked for yet, no approved scope, nothing running, queued, and not a coordinator's
 * filing. Null otherwise. The request proves it all again.
 */
function planAskOf(store: Store, taskId: string, state: string, ref: { id: number; plan: string | null } | null,
  scope: ReturnType<Store["getScope"]>, live: boolean, now: Date): StepCards["plan"] {
  if (ref === null || ref.plan !== null || state !== "queued" || live || store.hasLiveClaim(ref.id, now)) return null;
  if (scope !== null && approvalOf(scope).approved) return null;
  if (store.coordinatorProvenanceOf(taskId) !== null) return null;
  const source = planSourceOf(store, taskId);
  return source === null ? null : { source };
}

/** planStoppedOf for one task as its page reads it (server/task-views.ts): the same facts the steps carry. */
export function planStoppedFor(store: Store, taskId: string): StepCards["planStopped"] {
  const ref = store.lookupRef(taskId);
  return ref === null ? null : planStoppedOf(store, taskId, ref.id, store.runsFor(ref.id).filter(run => run.role === "planner"));
}

/** A file's length at the result when its own patch says it: an added file (one hunk from nothing, `-0,0 +1,N`) is N
 * lines; a deleted one (`-1,N +0,0`) is none. Null for every other file (only a context read at the result knows). */
export function patchLineCount(hunks: readonly { header: string }[]): number | null {
  if (hunks.length !== 1) return null;
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunks[0]!.header);
  if (header === null) return null;
  const [oldStart, oldCount, newStart, newCount] = [header[1], header[2] ?? "1", header[3], header[4] ?? "1"].map(Number) as [number, number, number, number];
  if (oldStart === 0 && oldCount === 0) return newStart === 1 || newCount === 0 ? newCount : null;
  if (newStart === 0 && newCount === 0) return 0;
  return null;
}

/**
 * A planner's own backoff as a page reads it (server/task-views.ts): the latest root planning attempt's failure in one
 * line and what its agent said (cleaned: agentSaidOf), while Toolroll waits to plan again. Null unless the task waits
 * on a planning attempt. Words for the person's own page only: never sent outside Toolroll.
 */
export function planBackoffFor(store: Store, taskId: string, now: Date): { line: string; agentSaid: string[] | null } | null {
  const waiting = waitingOf(store, taskId, now);
  if (waiting === null || waiting.attempt !== "plan") return null;
  const ref = store.lookupRef(taskId);
  if (ref === null) return null;
  const last = latestFinishedPlanner(store.runsFor(ref.id).filter(run => run.role === "planner"));
  return {
    line: waiting.lastFailure === null ? "Toolroll tries the plan again soon." : `Last plan attempt failed · ${waiting.lastFailure}. Toolroll tries the plan again soon.`,
    agentSaid: last !== null && last.outcome === "failed" ? agentSaidOf(store, last.id) : null,
  };
}

/**
 * A plan asked for that waits to start (stepCardsSchema.planQueued): queued, the plan requested, no approved scope, nothing
 * running and no hold of any kind. Dispatch starts its planner on its own (operate.ts: a requested plan is the one spend
 * on a task with no approved scope), so a person can stop it before it starts; a task filed with no plan asked for and
 * no approval reads false (nothing would start). Read facts only: the hold proves its own.
 */
function planQueuedOf(store: Store, state: string, ref: { id: number; plan: string | null } | null, scope: ReturnType<Store["getScope"]>, live: boolean, now: Date): boolean {
  if (ref === null || ref.plan !== "requested" || state !== "queued" || live || store.hasLiveClaim(ref.id, now)) return false;
  if (scope !== null && approvalOf(scope).approved) return false;
  return store.activeHolds(ref.id, now).length === 0;
}

/** The agents a model pick may name for this task, by role: the configured, selectable choices the route edit proves again
 * (agentconfig.ts agentChoicesFor over the task's own route). */
function agentChoicesOf(store: Store, taskId: string, ref: ReturnType<Store["lookupRef"]>, now: Date): NonNullable<StepCards["agentChoices"]> {
  const routed = routeOfTask(store, taskId, ref, now);
  const choices = agentChoicesFor(store, ref?.repo ?? null, routed?.kind === "route" ? routed.route : null);
  const pairs = (phase: "plan" | "build") => choices[phase].filter(one => one.selectable).map(one => ({ provider: one.provider, model: one.model }));
  return { plan: pairs("plan"), build: pairs("build") };
}

// ---- a Flexible thread's changes, file by file ---------------------------------------------------------------------

/** What a thread's changes read gave (flexible-import.ts readFlexibleChanges): its patch, nothing committed yet, or why
 * it couldn't be read, in words. */
export type ThreadChanges = { ok: true; patch: string; truncated: boolean } | { ok: true; none: true } | { ok: false; message: string };

/** A thread's patch as shown: every line cleaned (controls, escapes, bidi out) and anything that looks like a key hidden,
 * as the live view hides one: a changed or context line (inside a private key block every line), a hunk header's
 * function context (git copies a line of the file there; the header keeps only its numbers), and any other metadata
 * line. A file's own header lines (`diff --git`, `---`, `+++`) are read by position, never mistaken for a hunk's
 * `---`/`+++` lines. */
function shownPatch(text: string): string {
  let inKey = false, inHunk = false;
  return text.replace(/\r\n/g, "\n").split("\n").map(line => {
    // A file's own header names its paths: one that looks like a key is replaced by a marker, the line kept whole.
    if (line.startsWith("diff --git ")) {
      inHunk = false; inKey = false;
      return keyShaped(line) ? `diff --git a/${HIDDEN_NAME} b/${HIDDEN_NAME}` : cleanLiveText(line);
    }
    const named = inHunk ? null : /^(---|\+\+\+) (.*)$/.exec(line);
    if (named !== null) return keyShaped(named[2]!) ? `${named[1]} ${named[1] === "---" ? "a" : "b"}/${HIDDEN_NAME}` : cleanLiveText(line);
    const hunk = /^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(.*)$/.exec(line);
    if (hunk !== null) {
      inHunk = true;
      const context = hunk[2]!;
      return PRIVATE_KEY_MARK.test(context) || PRIVATE_KEY_MARK.test(cleanLiveText(context)) || keyShaped(context) ? hunk[1]! : cleanLiveText(line);
    }
    const marker = inHunk && /^[-+ ]/.test(line) ? line[0]! : "";
    const body = marker === "" ? line : line.slice(1);
    const seen = cleanLiveText(body);
    if (marker !== "" && (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(body) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(seen))) inKey = true;
    const hide = (marker !== "" && inKey) || keyShaped(body);
    if (marker !== "" && (/-----END [A-Z ]*PRIVATE KEY-----/.test(body) || /-----END [A-Z ]*PRIVATE KEY-----/.test(seen))) inKey = false;
    return hide ? `${marker}${HIDDEN_LINE}` : `${marker}${seen}`;
  }).join("\n");
}

/** A private key block's first or last line. */
const PRIVATE_KEY_MARK = /-----(?:BEGIN|END) [A-Z ]*PRIVATE KEY-----/;
/** Said in place of a file name that looks like a key. */
const HIDDEN_NAME = "[a name was hidden]";

/** A thread's changed files with their counts (`task` is the thread's id; `run` the number of its latest turn, which
 * the file reads name back), from its committed work against the commit it started from. `edited`: the agent's records
 * here show it edited files (said when nothing is committed). */
export function threadDiffOf(thread: string, turn: number, changes: ThreadChanges, seen: { edited?: boolean } = {}): ResultDiff {
  const empty = (problem: string): ResultDiff => ({ version: ENGINE_API_VERSION, task: thread, run: turn, totals: null, files: [], patchTruncated: false, problem });
  if (!changes.ok) return empty(`This thread's changes can't be read: ${cleanLiveText(changes.message)}`);
  // The agent edited files but committed none of it (everyday 9, B2): said as what to do. Ship takes commits; Save as
  // branch commits what the agent left once its agent has stopped (stranger 17).
  if ("none" in changes && seen.edited === true) return empty("The agent has uncommitted edits. Ask it to commit them, or end the thread and save it as a branch: that saves them too.");
  if ("none" in changes) return empty("No committed changes yet. Ask the agent to commit its work: Ship sends committed work only.");
  const files = patchFiles(changes.patch).map((text, index) => {
    const parsed = parseReviewDiff(text).files[0];
    let additions = 0, deletions = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    const binary = /^(?:Binary files .* differ|GIT binary patch)$/m.test(text);
    const shownPath = (path: string): string => keyShaped(path) ? HIDDEN_NAME : cleanLiveText(path);
    return { file: index, path: shownPath(parsed?.path ?? "changed file"), oldPath: parsed?.oldPath == null ? null : shownPath(parsed.oldPath), additions, deletions, binary,
      hunks: parsed?.hunks.length ?? 0 };
  });
  if (files.length === 0) return empty("No committed changes yet. Ask the agent to commit its work: Ship sends committed work only.");
  return { version: ENGINE_API_VERSION, task: thread, run: turn, totals: null, files, patchTruncated: changes.truncated, problem: null };
}

/** One file's hunks of a thread's changes, cleaned and with key-shaped lines hidden; null when there is no such file. */
export function threadDiffFileOf(thread: string, turn: number, changes: ThreadChanges, file: number): ResultDiffFile | null {
  if (!changes.ok || "none" in changes) return null;
  const text = patchFiles(changes.patch)[file];
  if (text === undefined) return null;
  const parsed = parseReviewDiff(shownPatch(text));
  const one = parsed.files[0];
  if (one === undefined) return null;
  return { version: ENGINE_API_VERSION, task: thread, run: turn,
    file: { file, path: keyShaped(one.path) ? HIDDEN_NAME : cleanLiveText(one.path), oldPath: one.oldPath === null ? null : keyShaped(one.oldPath) ? HIDDEN_NAME : cleanLiveText(one.oldPath),
      meta: one.meta.map(cleanLiveText), hunks: one.hunks.map(hunk => ({ ...hunk, header: cleanLiveText(hunk.header) })),
      lineCount: patchLineCount(one.hunks) },
    linesTruncated: parsed.linesTruncated };
}
