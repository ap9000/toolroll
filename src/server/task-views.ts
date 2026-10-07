import { assignmentPresentationOf,historicalAssessmentReason } from '../assignment-presentation.js';
import { assignmentStatusOf,assignmentWithEvidence } from '../assignment-ui.js';
import { assignmentOf,type AssignmentSnapshot } from '../assignment.js';
import { knowledgeContextHtml } from "../knowledge-ui.js";
import { failedAttemptSentence,failingCheckSuggestion,GENERAL_SUGGESTION,isInternalErrorReason,latestFinishedAttempt,missedRequirementLine,missedRequirementSuggestion,NO_REASON_RECORDED,stopSuggestionOf,type FailureExplanation } from '../needs-you.js';
import { planAutoPending } from "../plan-auto.js";
import { readKnowledgeSnapshot } from "../project-knowledge.js";
import { learningView } from "../project-learning.js";
import { readSkillsSnapshot,skillTestResult } from "../project-skills.js";
import { newestPullRequestOf,publishingOf,pullRequestBlocker } from '../pull-request-flow.js';
import { structuredHandoffView,terminalDiffView } from "../result-evidence-readers.js";
import { resultCheckLevel } from '../result-follow-ups.js';
import { skillsSnapshotHtml,skillTestFeedbackHtml } from "../skills-ui.js";
import type { TaskFamily } from "../store.js";
import { runActivityOf } from "../task-activity.js";
import { taskFingerprint } from "../task-live.js";
import { pullRequestFactOf } from '../task-status.js';
import { openWorkDecisionOf } from "../work-summary.js";
import { learningHtml } from "../workspace-ui.js";

import { randomBytes } from "node:crypto";
import { type ServerResponse } from "node:http";
import { agentChoicesFor,INSTALLATION_SCOPE,routeOfTask } from "../agentconfig.js";
import { rulesSummary } from "../approval-rules-ui.js";
import { nonceHashOf } from "../contest.js";
import { hasForbiddenControls } from "../decision.js";
import { diagnoseTaskDispatch } from "../dispatch.js";
import { readVerifiedArtifact,readVerifiedReport } from "../evidence.js";
import { computeGaps } from "../gaps.js";
import { modeTermsFromJson } from "../modes.js";
import { projectRoute } from "../phase-routing.js";
import { milestonesOf,parseExecutionPlanDocument } from "../plan.js";
import { contractChangesOf,decodePlanContractRecord,describeContractChanges } from "../planner-source.js";
import {
projectName
} from "../project.js";
import {
isRevisionFeedback
} from "../result-review.js";
import { buildReviewOf } from "../review-switch.js";
import { isAlive as runnerAlive } from "../runner.js";
import {
approvalOf,
type Scope
} from "../scope.js";
import { approvalFormDigest,attendedWatchWords,chatResultHref,completionReceiptView,consentDoorOf,decisionsFor,diffFileAnchor,escape,evidenceLinksFor,followUpsFor,oneLineOf,orderChangedFiles,parseReviewDiff,proofBundleView,publicationFactsOf,receiptStatusOf,refuse,resumeCeremonyPage,resumeDigestOf,reviewHref,screen,taskBody,taskChatHref,taskHref,taskPage,withinSignedTouches,type Chrome,type CompletionReceiptView,type MilestoneProgressView,type PlanContractView,type PlanRevisionLedgerView,type ProjectPeek,type ResultDetail,type RevisionDocView,type RevisionView,type RouteView,type Screen,type ServeOptions,type TaskChatFocus,type TaskPullRequest,type Who,type WorkRow } from "./shared.js";
import { budgetHoldWords,budgetLabel,monthOf } from "../spend.js";
import type { PlanRevision,TaskRef } from "../store.js";
import {
type Run,
type Store,
type Task,
type TaskState
} from "../store.js";
import { taskControlOf } from "../task-control.js";
import {
lastErrorLineOf,missedRequirementOf,
workStatusOf,
type ReviewFacts,
type WorkFacts
} from "../workspace-ui.js";
/** Shared task/result views, moved with their captured state. Lazy access preserves initialization order. */
export interface TaskViewsRuntime {
  store: Store;
  projectCounts: (now: Date) => import("../work-index.js").WorkProjectCounts[];
  admissionList: () => string[] | null;
  visible: (repo: string | null) => boolean;
  familyOf: (taskId: string) => TaskFamily | null;
  clock: () => Date;
  reviewFactsFor: (runId: number) => ReviewFacts | null;
  evidenceRoot: string;
  workAccess: () => { principal: "operator"; repos: string[] | null; includeUnplaced: boolean; viewer: string | null; };
  mintApprovalNonce: (name: string, taskId: string, digest: string) => string;
  restricted: () => boolean;
  options: ServeOptions;
  sendScreen: (response: ServerResponse, status: number, s: Screen) => void;
  chromeFor: (project: string | null, active: Chrome["active"], listPane?: string, scope?: Chrome["scope"]) => Chrome;
  unscopedMode: boolean;
  dockedConversation: (who: Who, focusTask: TaskChatFocus | null, chatProject: string | null, now: Date, back: string, resultRunId?: number | null) => import("../browser-workspace.js").BrowserConversation | null;
  liveRefreshSeconds: () => number;
}
export function createTaskViews(runtime: TaskViewsRuntime) {

  /** The first task's way to Ready shows until the first Ready result, and stays on the installation's first task. */
  function guided(rootId: string, now: Date): boolean {
    if (runtime.store.isDemo()) return false;
    if (runtime.store.firstSuccessAt(now) === null) return true;
    const first = runtime.store.handle.prepare("SELECT id FROM task ORDER BY created_at, rowid LIMIT 1").get();
    return first !== undefined && String(first["id"]) === rootId;
  }
  function projectFamilyPeek(repo: string, now: Date): ProjectPeek {
    const row = runtime.projectCounts(now).find(one => one.repo === repo);
    return { waiting: row?.totals['needs-you'] ?? 0, running: row?.totals.running ?? 0,
      queued: row?.queued ?? 0, doneRecently: row?.doneRecently ?? 0 };
  }
  function familiesInView(project: string | null, options: Parameters<Store["taskFamiliesAdmitted"]>[2] = {}): TaskFamily[] {
    return runtime.store.taskFamiliesAdmitted(project === null ? runtime.admissionList() : runtime.visible(project) ? [project] : [], runtime.visible(null), options);
  }
  function familyTasksInView(project: string | null, state?: TaskState, limit = 200): (Task & { repo: string | null })[] {
    return familiesInView(project, { ...(state === undefined ? {} : { states: [state] }), limit })
      .map(family => ({ ...family.current, id: family.root.id, title: family.root.title }));
  }
  function revisionDestination(child: string, back: string): string {
    const root = runtime.familyOf(child)?.root.id ?? child;
    if (!back.startsWith("/chat?")) return `${taskHref(root)}?version=${encodeURIComponent(child)}`;
    const conversation = new URL(back, 'http://localhost').searchParams.get('conversation');
    return `${taskChatHref(root)}&revision=${encodeURIComponent(child)}${conversation ? '&conversation=' + encodeURIComponent(conversation) : ''}`;
  }
  function earlierLiveVersions(family: TaskFamily, now: Date): string[] {
    const ids = family.versions.filter(one => one.id !== family.current.id).map(one => one.id);
    if (ids.length === 0) return [];
    return runtime.store.taskActivityCandidates(family.root.repo === null ? [] : [family.root.repo], family.root.repo === null, now, ids)
      .filter(task => workRowOf(task, now).status.views.includes("running")).map(task => task.id);
  }
  function familyHistory(family: TaskFamily): string {
    const warning = family.problem === null ? "" : `<p class="problem" data-history-problem>${escape(family.problem)}</p>`;
    const otherActive = new Set([...family.otherActive.map(one => one.id), ...earlierLiveVersions(family, runtime.clock())]).size;
    const active = otherActive === 0 ? "" : `<p class="problem" data-other-active>${otherActive} earlier version${otherActive === 1 ? " is" : "s are"} still waiting or running. Review History.</p>`;
    if (family.versions.length < 2) return warning;
    const versions = family.versions.map((version, index) => {
      const label = index === 0 ? "Original" : `Revision ${index}`;
      const status = workRowOf(version, runtime.clock()).status;
      const runs = runtime.store.runsFor(version.refId).filter(runIsTaskResult);
      const href = `${taskHref(family.root.id)}?version=${encodeURIComponent(version.id)}`;
      return `<li data-history-version="${escape(version.id)}"><a href="${href}">${label}</a>${version.id === family.current.id ? " · Current" : ""} · ${escape(status.label)}` +
        runs.map(run => `<a href="${escape(run.outcome === "built" || run.outcome === "no-change" ? chatResultHref(family.root.id, run.id) : `/r/${run.id}`)}">Build #${run.id}${run.outcome === "built" ? "" : ` · ${escape(run.outcome === "no-change" ? "No changes" : run.outcome === "failed" ? "Failed" : run.outcome ?? "Unfinished")}`}</a>`).join("") + `</li>`;
    });
    return warning + active + `<details class="task-history" data-root-task="${escape(family.root.id)}"><summary>History</summary><ol>${versions.join("")}</ol></details>`;
  }

  /** Keep detailed receipt diagnostics; shared assignment reads own readiness. */
  function freshAssignment(assignment: AssignmentSnapshot | null, receipt: CompletionReceiptView | null): AssignmentSnapshot | null {
    if (assignment === null) return null;
    const value = assignmentWithEvidence(assignment, receipt === null ? null : receiptStatusOf(receipt), receipt?.runId ?? null);
    return receipt === null ? value : { ...value, attention: [...new Set([...value.attention, ...receipt.facts.evidenceProblems, ...receipt.caveats.filter(reason => !historicalAssessmentReason(reason))])] };
  }

  /**
   * One Work row's facts (workspace package 1), from the records the task
   * page already reads: the dispatch diagnosis, the latest finished
   * builder/scout run with its machine verdict and any acceptance, the
   * run's publication, and the live claim. The words come from the pure
   * projection so this row, the task page, the focused chat, and the
   * review cockpit cannot disagree about the same run.
   */
  function workRowOf(task: Task & { repo: string | null; family?: TaskFamily }, now: Date, receipt?: CompletionReceiptView | null): WorkRow {
    const ref = runtime.store.lookupRef(task.id);
    const runs = ref === null ? [] : runtime.store.runsFor(ref.id);
    const latest = runs.find(runIsTaskResult) ?? null;
    const verdict = latest === null ? null : runtime.store.proofVerdictFor(latest.id);
    const live = runs.find(one => runIsLive(one)) ?? null;
    const facts: WorkFacts = {
      id: task.id,
      title: task.title,
      repo: task.repo,
      state: task.state,
      updatedAt: task.updatedAt,
      dispatch: diagnoseTaskDispatch(runtime.store, task.id, now),
      result:
        task.state !== "done"
          ? null
          : latest === null
            ? null
            : {
                runId: latest.id,
                role: latest.role,
                outcome: latest.outcome,
                verdict: verdict?.verdict ?? null,
                reasons: verdict?.reasons ?? [],
                accepted: runtime.store.proofAcceptance(latest.id) !== null,
                checkLevel: resultCheckLevel(runtime.store, latest.id, now),
                review: runtime.reviewFactsFor(latest.id),
                ...(latest.outcome !== "no-change"
                  ? {}
                  : { recordComplete: (() => { const kinds = new Set(runtime.store.artifactsFor(latest.id).map(one => one.kind)); return kinds.has("handoff") && kinds.has("terminal-diff"); })() }),
              },
      publication: latest === null ? null : publicationFactsOf(runtime.store.publicationForRun(latest.id)),
      liveRunId: live === null ? null : live.id,
      openDecision: ref === null ? null : openWorkDecisionOf(runtime.store, ref.id, now),
      unfinishedRunId: runs.find(one => one.outcome === null && one.role !== "reviewer")?.id ?? null,
      control: ref === null ? { kind: "none" } : taskControlOf(runtime.store, ref.id, now),
    };
    // Read the same evidence-health projection as the receipt, including
    // damaged files discovered after a stored verdict was written.
    const result = receipt === undefined && task.state === "done" && latest !== null && (latest.outcome === "built" || latest.outcome === "no-change")
      ? completionReceiptView(runtime.store, latest, runtime.store.artifactsFor(latest.id), runtime.evidenceRoot, runtime.reviewFactsFor(latest.id)) : receipt;
    const status = workStatusOf(facts, result == null ? undefined : receiptStatusOf(result));
    const earlierLive = task.family === undefined ? [] : earlierLiveVersions(task.family, now);
    if (earlierLive.length > 0 && !status.views.includes("running")) status.views = [...status.views, "running"];
    const otherActive = new Set([...(task.family?.otherActive.map(one => one.id) ?? []), ...earlierLive]).size;
    const recordedAssignment = task.family === undefined ? null : assignmentOf(runtime.store, task.id, now, runtime.workAccess(), runtime.evidenceRoot);
    const assignment = freshAssignment(recordedAssignment, result ?? null);
    const assignmentStatus = assignment === null ? status : assignmentStatusOf(assignment, status);
    if (status.views.includes("running") && !assignmentStatus.views.includes("running")) assignmentStatus.views = [...assignmentStatus.views, "running"];
    return { ...facts, executionId: task.id, id: task.family?.root.id ?? task.id, title: task.family?.root.title ?? task.title,
      familyNotice: task.family?.problem ?? (otherActive ? `${otherActive} earlier version${otherActive === 1 ? " is" : "s are"} still waiting or running. Open History.` : null),
      status: assignment === null ? status : { ...assignmentStatus, diagnostics: assignmentPresentationOf(assignment, { workStatus: status, diagnostics: [...(status.diagnostics ?? []), ...(status.tone === "problem" && status.detail !== assignment.detail ? [status] : [])] }).diagnostics }, assignment, assignmentProblem: status.tone === "problem", resultRunId: latest === null ? null : latest.id };
  }

  /** The compact task list for the master pane, the current row marked. */
  function taskListPane(project: string | null, currentId: string | null): string {
    const rows = familyTasksInView(project, undefined, 100);
    if (currentId !== null && !rows.some(one => one.id === currentId)) {
      const family = runtime.familyOf(currentId);
      if (family !== null && (project === null || family.root.repo === null || family.root.repo === project)) rows.push({ ...family.current, id: family.root.id, title: family.root.title });
    }
    const items = rows
      .map(
        task =>
          `<a class="item${task.id === currentId ? " current" : ""}" href="${taskHref(task.id)}">` +
          `<span class="t">${escape(task.title)}</span></a>`,
      )
      .join("\n");
    return `<h2>Tasks</h2>\n${items === "" ? `<p class="meta">None yet</p>` : items}`;
  }

  /**
   * The one liveness fact (round-4 findings 14/15): a run is being built
   * right now iff its outcome is null AND its lease is the task's current
   * live claim \u2014 maximum generation, unreleased, strictly unexpired. Every
   * "running" label, poller, and watch link derives from this; nothing
   * ever infers liveness from a null outcome alone.
   */
  function runIsLive(run: Pick<Run, "outcome" | "leaseId" | "taskRef">): boolean {
    return run.outcome === null && runtime.store.currentLiveLease(run.taskRef, runtime.clock()) === run.leaseId;
  }

  /** Planner, reviewer, and structured-output correction bookkeeping can
   * finish around a build but are never the task's delivered result. */
  const runIsTaskResult = (run: Pick<Run, "role" | "finishedAt">): boolean =>
    run.finishedAt !== null && (run.role === "builder" || run.role === "scout");

  /** The task screen, shared by the GET and by every refusal that re-renders it. */
  /**
   * What a revision task's approval must restate (M6.8): the exact comment
   * batch, read back through the verified artifact path. A brief that no
   * longer verifies is a named problem on the screen — approving against
   * bytes nobody can prove is not approving anything.
   */
  function revisionViewOf(ref: ReturnType<Store["lookupRef"]>): RevisionView | null {
    if (ref === null || ref.revisionBriefArtifact === null) return null;
    const artifact = runtime.store.getArtifact(ref.revisionBriefArtifact);
    if (artifact === null) return { problem: "the revision brief is missing from this build's records" };
    const read = readVerifiedArtifact(runtime.evidenceRoot, artifact);
    if (!read.ok) return { problem: `the revision brief no longer verifies — ${read.problem}` };
    try {
      const parsed = JSON.parse(read.content.toString("utf8")) as {
        sourceTask?: unknown;
        sourceRun?: unknown;
        kind?: unknown;
        comments?: { path?: unknown; line?: unknown; note?: unknown; author?: unknown }[];
      };
      return {
        sourceTask: String(parsed.sourceTask ?? "?"),
        sourceRun: Number(parsed.sourceRun ?? 0),
        kind: parsed.kind === "ci-repair" ? "ci-repair" : parsed.kind === "criterion-repair" ? "criterion-repair" : "annotations",
        lineage: runtime.store.revisionLineageOf(ref.externalId, runtime.clock()),
        comments: (parsed.comments ?? []).slice(0, 100).map(one => ({
          path: one.path === null || one.path === undefined ? null : String(one.path),
          line: one.line === null || one.line === undefined ? null : Number(one.line),
          note: String(one.note ?? ""),
          author: String(one.author ?? "?"),
        })),
      };
    } catch {
      return { problem: "the revision brief did not parse" };
    }
  }

  /** The task view's facts, shared by the full screen and the workbench
   * pane (attended A1): one assembly, one authorization story. */
  function taskViewData(taskId: string, who: Who, problem: string | null, render: { mintNonce?: boolean } = {}): Parameters<typeof taskBody>[0] | null {
    const found = runtime.store.getTask(taskId);
    if (found === null) return null;
    const ref = runtime.store.lookupRef(taskId);
    if (ref !== null && !runtime.visible(ref.repo)) return null;
    const now = runtime.clock();
    const scope = runtime.store.getScope(taskId);
    const revision = revisionViewOf(ref);
    // A broken revision brief blocks the whole approval surface (audit
    // IV-3): no nonce is minted over a batch nobody can verify.
    const revisionBroken = revision !== null && "problem" in revision;
    // A tournament task's yes covers BOTH documents (finding 31): where
    // race terms are filed, the digest being shown — and bound by the
    // nonce — is the joint fingerprint, never the scope's alone.
    const raceTerms = ref === null ? null : runtime.store.activeTournamentTerms(ref.id);
    const planView = ref === null ? null : planViewOf(ref.id);
    const approvalDigest =
      scope === null ? null : approvalFormDigest(scope.digest, raceTerms?.raceDigest ?? null, planView?.sha256 ?? null);
    // The nonce is minted at render, per viewer, bound to the digest being
    // shown — the browser approval flow starts here and nowhere else.
    // …and only through an OPEN consent door (v48): an unreadable route,
    // a route that cannot run, or a pre-routing row whose approval lapsed
    // gets recovery copy, never a nonce.
    const routeView = routeViewOf(taskId, ref, scope, now, who);
    // A read-only refresh (package 2) reads the same facts WITHOUT minting:
    // a five-second poll must never churn the bounded nonce store, and a
    // fragment carries no password form to bind a nonce to.
    const nonce =
      who.via === "cookie" && scope !== null && approvalDigest !== null && !approvalOf(scope).approved && !revisionBroken && ref?.plan !== "requested" && consentDoorOf(scope, routeView).open
        ? render.mintNonce === false ? "unminted" : runtime.mintApprovalNonce(who.name, taskId, approvalDigest)
        : "";
    const runs = ref === null ? [] : runtime.store.runsFor(ref.id);
    const completion = (() => {
      // v40 fix: a reviewer run finishes AFTER the build it reviews and
      // carries no proof verdict of its own — without this filter, its
      // "no-change" outcome would hijack the task's own completion card
      // the instant a review lands, showing "proof missing" for a proof
      // that is right there on the builder's run.
      const latest = runs.find(runIsTaskResult);
      if (latest === undefined) return null;
      const artifacts = runtime.store.artifactsFor(latest.id);
      const verdict = runtime.store.proofVerdictFor(latest.id);
      const review = runtime.reviewFactsFor(latest.id);
      return {
        runId: latest.id,
        outcome: latest.outcome,
        hasTerminalDiff: artifacts.some(one => one.kind === "terminal-diff"),
        hasHandoff: artifacts.some(one => one.kind === "handoff"),
        // The closed machine-authored verdict (Priority 2), computed once
        // at completion by adjudicate() and never re-inferred here — null
        // only for a run that predates the proof system.
        proofVerdict: verdict?.verdict ?? null,
        machineVerdict: verdict?.machineVerdict ?? null,
        proofReasons: verdict?.reasons ?? [],
        proofMatrix: verdict?.matrix ?? [],
        proofMatrixLinks: evidenceLinksFor(artifacts),
        proofAccepted: runtime.store.proofAcceptance(latest.id) !== null,
        qualityMode: latest.qualityMode ?? "default",
        // Either direction: the ORIGINAL task's page finds the chain by
        // its own latest run (the one that triggered a draft); a DRAFT
        // task's page finds the SAME chain by being named as the draft.
        repairChain: runtime.store.repairChainFor(latest.id) ?? runtime.store.repairChainForDraft(taskId),
        // v50: the bounded review-retry history of this exact result —
        // the same projection the CLI and dispatch diagnosis read.
        reviewRetry: runtime.store.reviewRetryStateOf(latest.id),
        // The same review facts every other surface projects for this run.
        review,
        receipt:
          latest.outcome === "built" || latest.outcome === "no-change"
            ? completionReceiptView(runtime.store, latest, artifacts, runtime.evidenceRoot, review)
            : null,
      };
    })();
    // Adaptive execution plans (v44): the plan-revision ledger and live
    // milestone projection, both null for a task with no plan at all.
    // taskChatFocus below reads the SAME two calls, so the task page and
    // focused chat always render identical facts (c2).
    const planRevisions = ref === null ? null : revisionLedgerOf(ref.id);
    const milestoneProgress = ref === null ? null : progressOf(ref.id, planRevisions?.current?.document ?? null);
    const family = runtime.familyOf(taskId);
    const recordedAssignment = family?.current.id !== taskId ? null : assignmentOf(runtime.store, taskId, now, runtime.workAccess(), runtime.evidenceRoot);
    const assignment = freshAssignment(recordedAssignment, completion?.receipt ?? null);
    const progressRun = runs.find(one => runIsLive(one))?.id ?? completion?.runId ?? null;
    return {
        guide: guided(family?.root.id ?? taskId, now),
        assignment,
        checkProgress: progressRun === null ? null : runtime.store.checkProgress(progressRun),
        task: found,
        status: workRowOf({ ...found, repo: ref?.repo ?? null }, now, completion?.receipt).status,
        dispatch: diagnoseTaskDispatch(runtime.store, taskId, now),
        // v52: the exact-run control — the same projection the focused
        // chat and `task show` read.
        control: ref === null ? { kind: "none" as const } : taskControlOf(runtime.store, ref.id, now),
        canRetryReview: who.via === "cookie" && who.role === "approver",
        strikes: ref?.strikes ?? 0,
        filer: runtime.store.taskFiler(taskId),
        // v105: a waiting task whose monthly budget is used up says so.
        budgetHold: (() => {
          if (ref === null || found.state !== "queued") return null;
          // Only work billed to an API key waits on a budget (its approved agent's, or Claude's by default).
          const base = runtime.store.approvedChainOf(taskId)?.[0];
          const hold = runtime.store.budgetGate(now)({ ...runtime.store.budgetSubject(ref.id),
            agents: base !== undefined ? [{ provider: base.profile.provider, billing: base.authMode }] : runtime.store.agentsFor([runtime.store.getScope(taskId)?.approvedProfile?.provider ?? "claude"]) });
          if (hold.over === null) return null;
          return hold.why === "unpriced" ? `${budgetHoldWords(hold, monthOf(now).name)}; this waits until then`
            : `${budgetLabel(hold.over)} monthly budget is used up, so this waits until next month or a higher budget`;
        })(),
        // Sprint 8: a waiting task the organisation policy stops says which rule, or that it runs lowered.
        policyHold: (() => {
          if (ref === null || found.state !== "queued") return null;
          const base = runtime.store.approvedChainOf(taskId)?.[0]?.profile ?? runtime.store.getScope(taskId)?.approvedProfile ?? null;
          if (base === null) return null;
          const verdict = runtime.store.runPolicy(base);
          return !verdict.ok ? `${verdict.message.replace(/ An instance operator can change it in Settings → Policy\.$/, "")} It waits until the policy allows it.` : verdict.lowered;
        })(),
        approvalRules: (() => {
          const repo = ref?.repo ?? null;
          if (repo === null) return null;
          const rules = runtime.store.approvalRules(repo);
          if (!rules.notRequester && !rules.protectProject && rules.protectedPaths.length === 0) return null;
          const gate = runtime.store.approvalGate(taskId, "\u0000nobody", "person");
          return { words: rulesSummary(rules), votes: runtime.store.approvalVotes(taskId).map(one => one.approver), needsTwo: gate.verdict === "vote" || (gate.verdict === "seal" && gate.protectedWork) };
        })(),
        plan: ref?.plan ?? null,
        planAuto: planAutoPending(runtime.store, taskId, now),
        planDocument: planView?.document ?? null,
        planSha: planView?.sha256 ?? null,
        planContract: ref === null || planView === null ? null : planContractViewOf(ref.id, scope),
        deliverable: ref?.deliverable ?? "branch",
        report: ref === null ? null : readVerifiedReport(runtime.store, runtime.evidenceRoot, ref.id),
        revision,
        planRevisions,
        milestoneProgress,
        // v40: the fallback for a task page with no completed run yet (a
        // freshly drafted, unapproved repair) — completion's own branches
        // cover every case once a run exists.
        repairChain: completion !== null ? null : runtime.store.repairChainForDraft(taskId),
        repo: ref?.repo ?? null,
        filedVia: runtime.store.filedViaOf(taskId),
        coordinator: (() => {
          const who = runtime.store.coordinatorProvenanceOf(taskId);
          if (who === null) return null;
          // RELATIVE age (round-2 finding 5): "12m ago" reads at a glance;
          // an absolute stamp makes the operator do arithmetic.
          const ago =
            who.filedAt === null
              ? null
              : (() => {
                  const minutes = Math.max(0, Math.round((now.getTime() - new Date(who.filedAt).getTime()) / 60_000));
                  if (minutes < 60) return `${minutes}m ago`;
                  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
                  return `${Math.round(minutes / (60 * 24))}d ago`;
                })();
          return { label: who.label, filedAgo: ago };
        })(),
        holds: ref === null ? [] : runtime.store.activeHolds(ref.id, now),
        contest: (() => {
          if (ref === null) return null;
          const open = runtime.store.contestNeedingOperator(ref.id);
          return open === null ? null : { id: open.id, state: open.state, agents: runtime.store.contestants(open.id).length, kind: open.kind };
        })(),
        claimed: ref === null ? false : runtime.store.hasLiveClaim(ref.id, now),
        // The chain, both directions of trust: blockers outside the ceiling
        // are named but wear no state and no link (same redaction the board
        // applies to blockerState).
        waitsFor: runtime.store.blockers(taskId).map(blockerId => {
          const blockerRef = runtime.store.lookupRef(blockerId);
          const admitted = blockerRef !== null && runtime.visible(blockerRef.repo);
          const blocker = admitted ? runtime.store.getTask(blockerId) : null;
          return { id: !admitted && runtime.restricted() ? "restricted task" : blockerId, title: blocker === null ? null : blocker.title, state: blocker === null ? null : blocker.state, admitted };
        }),
        // Candidates a "wait for" or replacement select may offer: this
        // TASK's own project, even when the sidebar is in all-project mode.
        // That keeps repair complete without ever mixing unrelated projects.
        waitCandidates: (() => {
          if (who.via !== "cookie") return [];
          const candidateRepo = ref?.repo ?? who.session.project;
          return candidateRepo === null
            ? []
            : runtime.store
                .listTasksScoped(candidateRepo, undefined, 100, null)
                .filter(one => one.id !== taskId && (one.state === "queued" || one.state === "running") && runtime.visible(one.repo))
                .map(one => ({ id: one.id, title: one.title }));
        })(),
        // The one liveness fact, computed here where the store is: the run
        // whose lease is the task's CURRENT claim — not merely the first
        // unfinished run (round-4 finding, A1).
        liveRunId: (() => {
          if (ref === null) return null;
          const found = runtime.store.runsFor(ref.id).find(one => runIsLive(one));
          return found === undefined ? null : found.id;
        })(),
        worker: (() => {
          const runners = runtime.store.listRunners().filter(one => one.retiredAt === null);
          const eligible = ref?.repo === null || ref?.repo === undefined
            ? []
            : runners.filter(one => one.repos.includes(ref.repo as string));
          const answering = eligible.filter(one => runnerAlive(one, now));
          return {
            answering: answering.length,
            registered: eligible.length,
            totalRegistered: runtime.restricted() ? eligible.length : runners.length,
            lastHeard: eligible.map(one => one.heartbeatAt).sort().at(-1) ?? null,
          };
        })(),
        gaps:
          ref?.repo === null || ref?.repo === undefined
            ? []
            : computeGaps(runtime.store, ref.repo, now).filter(one =>
                one.unblocks.includes(taskId) || one.alsoBlocks.includes(taskId),
              ),
        peekable: runtime.options.localRunner !== undefined,
        position: runtime.store.queuePosition(taskId),
        mirror: runtime.store.mirrorByTask(taskId),
        scope,
        raceTerms,
        approvalDigest,
        // The phase route (v47): one projection for the card, the ceremony,
        // and the focused chat, with the readiness this task's runners report.
        route: routeView,
        canEditRoute: who.role === "approver",
        spendDefaults: runtime.store.getSpendDefaults(),
        permissionDefault: runtime.store.permissionDefault().mode,
        permissionMode: ref?.permissionMode ?? null,
        qualityDefault: runtime.store.qualityDefault().mode,
        qualityMode: ref?.qualityMode ?? null,
        publication: (() => {
          // The latest publication across this task's runs, with its
          // OBSERVED CI state (audit SD-5): the reviewer learns PR and CI
          // here instead of spelunking run pages.
          if (ref === null) return null;
          for (const one of runtime.store.runsFor(ref.id)) {
            const found = runtime.store.publicationForRun(one.id);
            if (found !== null) return found;
          }
          return null;
        })(),
        runs,
        completion,
        decisions: ref === null ? [] : runtime.store.decisionsForTask(ref.id),
        incidents: ref === null ? [] : runtime.store.incidentsForTask(ref.id),
        coordinatorProposals: (() => {
          if (ref === null || ref.repo === null || who.role !== "approver") return null;
          runtime.store.sweepCoordinatorProposals(now);
          const rows = runtime.store.listCoordinatorProposals({ repos: [ref.repo], taskId });
          return { rows, decisions: decisionsFor(runtime.store, rows), now };
        })(),
        steering: ref === null ? [] : runtime.store.listSteerNotes(ref.id),
        // "publishes as" reads ONLY publicationGrantFor(repo) — the grant
        // the publisher would act under — never listGrants(), which is
        // dispatch authority (slice 1c).
        grant: ref === null || ref.repo === null ? null : runtime.store.publicationGrantFor(ref.repo),
        csrf: who.via === "cookie" ? who.session.csrf : "",
        nonce,
        problem,
        attended: (() => {
          if (runtime.restricted() || runtime.options.attended === undefined || ref === null || who.via !== "cookie" || runtime.store.isDemo()) return null;
          const open = runtime.store.openAuthorizationFor(ref.id);
          if (open !== null) {
            const spent = runtime.store.authorizationSpendMicrousd(open.id);
            const turnsUsed =
              open.attemptRun === null ? 0 : runtime.store.sessionTurnsOf(open.attemptRun).length;
            const state = attendedWatchWords(open.lastBeatAt, now, open.absoluteExpiry);
            return {
              canMint: false,
              open: {
                id: open.id,
                state,
                expiresAt: open.absoluteExpiry,
                turnsUsed,
                cap: open.maxSessionTurns,
                spentMicrousd: spent,
                budgetMicrousd: open.budgetMicrousd,
                running: open.attemptRun !== null,
              },
            };
          }
          const canMint =
            scope !== null &&
            !approvalOf(scope).approved &&
            scope.profileState === "resolved" &&
            (scope.profile?.provider ?? "") === "claude" &&
            ref.repo !== null &&
            runtime.store.activeTournamentTerms(ref.id) === null &&
            runtime.store.getTask(taskId)?.state === "queued";
          if (!canMint) return { canMint, open: null };
          const pinnedModel = scope?.profile?.provider === "claude" ? scope.profile.model : "";
          const configured = ["plan", "build", "repair", "review"]
            .map(phase => runtime.store.phaseConfig(INSTALLATION_SCOPE, phase))
            .filter((row): row is NonNullable<typeof row> => row !== null && row.provider === "claude" && row.model !== null)
            .map(row => row.model as string);
          const models = [...new Set([pinnedModel, ...configured])].filter(model => model !== "");
          const liveMode = ref.repo === null ? null : runtime.store.activeMode(ref.repo, now);
          const modeTerms = liveMode === null ? null : modeTermsFromJson(liveMode.termsJson);
          return {
            canMint,
            mint: {
              models,
              pinnedModel,
              posture: modeTerms?.permissionDefault === "escalated" ? ("bypassPermissions" as const) : ("auto" as const),
              quick: modeTerms?.quickMint === true && liveMode !== null && liveMode.signedBy === who.name,
            },
            open: null,
          };
        })(),
        now,
      };
  }

  /** The Agents view (v47): the task's route from the ONE resolver dispatch
   * uses — sealed, proposed, live, a proven pre-routing profile, or
   * unreadable — projected with the readiness its runners have reported,
   * and the edit posture an approver's controls need. The scope digest
   * rides along so every change form can CAS against exactly what was
   * rendered (an empty value means "I saw no scope"). */
  function routeViewOf(taskId: string, ref: TaskRef | null, scope: Scope | null, now: Date, who: Who): RouteView | null {
    if (ref === null) return null;
    const routed = routeOfTask(runtime.store, taskId, ref, now);
    if (routed === null) return null;
    const live = runtime.store.hasLiveClaim(ref.id, now);
    const raced = runtime.store.activeTournamentTerms(ref.id) !== null;
    const shared = {
      riskLevel: ref.riskLevel ?? scope?.riskLevel ?? "routine",
      overrides: ref.routeOverrides ?? [],
      editable: who.role === "approver" && !live && !raced,
      editableWhy: who.role !== "approver" ? "your login can watch — choosing agents is an approver's act" : live ? "this task is running — its agents cannot change under a live claim" : raced ? "tournament terms are on file — its lanes decide the agents" : null,
      replanOnPlanChange: ref.plan === "drafted" && scope !== null && !approvalOf(scope).approved,
      digest: scope?.digest ?? null,
      choices: agentChoicesFor(runtime.store, ref.repo, routed.kind === "route" ? routed.route : null),
    } as const;
    if (routed.kind === "route") {
      return { kind: "route", source: routed.source, projection: projectRoute(routed.route, runtime.store.readinessLookupFor(ref.repo, ref.assignedRunner, now)), legacy: null, problem: null, ...shared };
    }
    if (routed.kind === "legacy") {
      return { kind: "legacy", source: null, projection: null, legacy: { provider: routed.profile.provider, model: routed.profile.model, repairModel: routed.profile.repairModel === "inherit" ? routed.profile.model : routed.profile.repairModel, approved: routed.approved }, problem: null, ...shared };
    }
    return { kind: "unreadable", source: null, projection: null, legacy: null, problem: routed.problem, ...shared };
  }

  /** Resolve a task-scoped chat lens without trusting its query string.
   * Only an admitted task becomes model context or visible page copy. */
  function taskChatFocus(taskId: string | null, now: Date, who?: Who, options: { mintNonce?: boolean } = {}): TaskChatFocus | null {
    if (taskId === null || taskId.length === 0 || taskId.length > 64 || hasForbiddenControls(taskId)) return null;
    const family = runtime.familyOf(taskId);
    if (family === null) return null;
    taskId = family.current.id;
    const task = family.current;
    const ref = runtime.store.lookupRef(taskId)!;
    const scope = runtime.store.getScope(taskId);
    // The focused chat is a lens over the task page's own assembled facts.
    // Reusing that projection keeps approval nonces, joint race digests,
    // revision verification, decisions, and result evidence on one source
    // of truth instead of growing a chat-only lifecycle.
    const view = who === undefined || family.problem !== null ? null : taskViewData(taskId, who, null, options);
    const runs = view?.runs ?? runtime.store.runsFor(ref.id);
    const latest = runs.find(runIsTaskResult) ?? null;
    const approval = approvalOf(scope);
    const live = runs.find(one => runIsLive(one)) ?? null;
    const planRevisions = view?.planRevisions ?? revisionLedgerOf(ref.id);
    return {
      id: family.root.id,
      executionId: task.id,
      family,
      guide: guided(family.root.id, now),
      history: familyHistory(family),
      title: family.root.title,
      state: task.state,
      status: view?.status ?? workRowOf({ ...task, repo: ref.repo }, now).status,
      assignment: view?.assignment ?? assignmentOf(runtime.store, task.id, now, runtime.workAccess(), runtime.evidenceRoot),
      project: ref.repo === null ? null : projectName(ref.repo),
      now,
      dispatch: diagnoseTaskDispatch(runtime.store, taskId, now),
      scope: scope === null ? "none" : approval.approved ? "approved" : "needs approval",
      plan: ref.plan,
      // Adaptive execution plans (v44): the identical ledger/progress
      // projection the task page renders (c2) — reused from `view` when
      // available, computed fresh only when this call has no `who`.
      planRevisions,
      milestoneProgress: view?.milestoneProgress ?? progressOf(ref.id, planRevisions?.current?.document ?? null),
      // What a failed task missed, said as the task page says it.
      failure: task.state === "failed" ? failureOf(family.versions.flatMap(version => runtime.store.runsFor(version.refId)), view?.assignment ?? assignmentOf(runtime.store, task.id, now, runtime.workAccess(), runtime.evidenceRoot)) : null,
      claimed: view?.claimed ?? runtime.store.hasLiveClaim(ref.id, now),
      liveRun: live === null ? null : { id: live.id, runner: live.runner, startedAt: live.startedAt, phase: live.phase },
      checkProgress: view?.checkProgress ?? (live === null && latest === null ? null : runtime.store.checkProgress((live ?? latest)!.id)),
      control: view?.control ?? taskControlOf(runtime.store, ref.id, now),
      route: view?.route ?? null,
      approval:
        view === null || who?.role !== "approver" || scope === null || approval.approved
          ? null
          : {
              scope,
              nonce: view.nonce,
              digest: view.approvalDigest ?? scope.digest,
              planDocument: view.planDocument,
              planContract: view.planContract ?? null,
              deliverable: view.deliverable ?? "branch",
              raceTerms: view.raceTerms ?? null,
              revision: view.revision ?? null,
              coordinator: view.coordinator ?? null,
              repairChain: view.repairChain ?? null,
            },
      decisions: (view?.decisions ?? runtime.store.decisionsForTask(ref.id))
        .filter(one => one.state === "open" || one.state === "expired")
        .map(one => ({ ...one, taskId: task.id, repo: ref.repo })),
      publication: view?.publication ?? null,
      result:
        view?.completion?.receipt !== undefined && view.completion.receipt !== null
          ? view.completion.receipt
          : latest === null || (latest.outcome !== "built" && latest.outcome !== "no-change")
          ? null
          : completionReceiptView(runtime.store, latest, runtime.store.artifactsFor(latest.id), runtime.evidenceRoot, runtime.reviewFactsFor(latest.id)),
    };
  }

  /** The newest pull request any version of this task opened through Complete; else, for a result completed
   * without one, the offer to open it (an approver's browser session only). */
  /** Where "Complete and open a pull request" would open one for this result, or null when it isn't offered. */
  function pullRequestTargetOf(runId: number): string | null {
    const run = runtime.store.getRun(runId);
    const publishing = publishingOf(runtime.store, run === null ? null : runtime.store.refById(run.taskRef)?.repo ?? null);
    if (!publishing.on || publishing.legacy || runtime.store.publicationForRun(runId) !== null || pullRequestBlocker(runtime.store, runId) !== null) return null;
    return `${publishing.githubRepo} into ${publishing.base}`;
  }

  function taskPullRequestOf(taskId: string, who: Who): TaskPullRequest | null {
    const family = runtime.familyOf(taskId);
    const rootId = family?.root.id ?? taskId;
    const repo = runtime.store.lookupRef(taskId)?.repo ?? null;
    const publishing = publishingOf(runtime.store, repo);
    const target = publishing.on ? publishing.base : null;
    const view = newestPullRequestOf(runtime.store, family === null ? [taskId] : family.versions.map(one => one.id));
    if (view !== null) {
      const publication = runtime.store.publicationForRun(view.runId);
      const fact = publication === null ? null : { ...pullRequestFactOf({ ...publication, merged: view.state === "merged" })!,
        note: view.state === "merged" ? `${view.detail}${view.mergeCommit === null ? "" : ` Merge commit ${view.mergeCommit.slice(0, 12)}.`}` : null };
      return { taskId: rootId, view: { ...view, canMerge: view.canMerge && who.role === "approver" && who.via === "cookie" }, offer: null, target, fact };
    }
    if (!publishing.on || who.via !== "cookie" || who.role !== "approver") return null;
    const assignment = assignmentOf(runtime.store, taskId, runtime.clock(), runtime.workAccess(), runtime.evidenceRoot);
    const receipt = assignment?.receipt ?? null;
    if (assignment?.state !== "complete" || receipt === null || runtime.store.publicationForRun(receipt.runId) !== null || pullRequestBlocker(runtime.store, receipt.runId) !== null) return null;
    return { taskId: rootId, view: null, offer: { taskId: receipt.taskId, runId: receipt.runId, digest: receipt.digest }, target };
  }

  /** What went wrong with the latest finished attempt (whatever its outcome, never an older failure). */
  function failureOf(runs: readonly Run[], assignment: AssignmentSnapshot | null, readLog = true): FailureExplanation {
    const last = latestFinishedAttempt(runs);
    if (last === null) return { kind: "reason", line: NO_REASON_RECORDED, evidence: null, suggestion: GENERAL_SUGGESTION, link: null };
    const full = runtime.store.getRun(last.id);
    return full === null ? { kind: "reason", line: failedAttemptSentence(last.reason), evidence: null, suggestion: stopSuggestionOf(last.reason), link: null }
      : explainAttempt(full, assignment?.receipt?.runId === last.id ? assignment.receipt : null, readLog);
  }

  /** One finished attempt's failure in plain words: a failing check's last error line (linked to that line in its
   * saved log), else the first signed requirement it missed with the evidence line behind it, else its recorded reason
   * in plain words (or that none was recorded). Each comes with one suggestion of what to change, and a link to the
   * attempt's own result page, where its changes, checks and failure are; machine output reads as an internal error,
   * its detail behind a link to that line of the attempt's record. `readLog` false (a list's rows) reads no saved
   * check log: the requirement or the reason, from the database alone. */
  function explainAttempt(run: Run, receipt: AssignmentSnapshot["receipt"] | null, readLog = true): FailureExplanation {
    const taskId = runtime.store.externalIdFor(run.taskRef) ?? "";
    const page = `${reviewHref(taskId)}&run=${run.id}`;
    const see = taskId === "" ? null : { label: `See build #${run.id}`, href: page };
    const artifacts = runtime.store.artifactsFor(run.id);
    const logArtifact = !readLog ? null : receipt?.checks.status === "failed" && receipt.checks.logArtifactId !== null
      ? artifacts.find(one => one.id === receipt.checks.logArtifactId) ?? null
      : [...artifacts].reverse().find(one => one.kind === "check-log") ?? null;
    if (logArtifact !== null) {
      let read: ReturnType<typeof readVerifiedArtifact> | null = null;
      try { read = readVerifiedArtifact(runtime.evidenceRoot, logArtifact); } catch { read = null; }
      const text = read !== null && read.ok ? read.content.toString("utf8") : null;
      const exit = text === null ? null : /^\(exit (-?[0-9]+)\)$/m.exec(text);
      const failedCheck = receipt?.checks.status === "failed" || (exit !== null && exit !== undefined && Number(exit[1]) !== 0);
      const found = text !== null && failedCheck ? lastErrorLineOf(text) : null;
      if (found !== null) {
        const line = oneLineOf(found.text, 140);
        return { kind: "check", line: `The check failed: ${line}`, evidence: null, suggestion: failingCheckSuggestion(line),
          link: taskId === "" ? null : { label: `Check output, line ${found.line}`, href: `${page}&tab=checks#check-log-L${found.line}` } };
      }
    }
    const verdict = runtime.store.proofVerdictFor(run.id);
    const missed = verdict === null ? null : missedRequirementOf(verdict.matrix);
    if (missed !== null) {
      return { kind: "requirement", line: missedRequirementLine(missed.statement), evidence: missed.evidence === null ? null : oneLineOf(missed.evidence, 240),
        suggestion: missedRequirementSuggestion(missed.statement), link: see };
    }
    const internal = isInternalErrorReason(run.reason);
    return { kind: "reason", line: failedAttemptSentence(run.reason), evidence: null, suggestion: stopSuggestionOf(run.reason),
      link: internal ? { label: "The recorded error", href: `/r/${run.id}?record=1#run-reason-detail` } : see };
  }

  /** Run checks in place on a result's commit: an approver's browser session, outside the demo, when the project has a
   * check and none is waiting or running on it. Comes back to `returnTo`. */
  function runChecksHere(runId: number | null, who: Who, returnTo: string): { action: string; level: "quick" | "full"; returnTo: string } | null {
    if (runId === null || who.via !== "cookie" || who.role !== "approver" || runtime.store.isDemo()) return null;
    const run = runtime.store.getRun(runId);
    const followUps = run === null ? null : followUpsFor(runtime.store, runtime.evidenceRoot, run, runtime.clock());
    if (followUps === null || !(followUps.quick || followUps.full) || followUps.checks.some(one => one.state === "waiting" || one.state === "running")) return null;
    return { action: `/r/${runId}/checks`, level: followUps.full ? "full" : "quick", returnTo };
  }

  function taskScreen(
    response: ServerResponse,
    who: Who,
    taskId: string,
    problem: string | null,
    status: number,
    scopeDraft?: URLSearchParams,
    cancelDraft?: string,
    editPlan = false,
  ): void {
    const admittedFamily = runtime.familyOf(taskId);
    if (admittedFamily?.problem != null) return runtime.sendScreen(response, status, screen(admittedFamily.root.title,
      `<h1>${escape(admittedFamily.root.title)}</h1><p>${escape(admittedFamily.current.state)}</p><p class="problem" data-history-problem>${escape(admittedFamily.problem)}</p>`, { chrome: runtime.chromeFor(admittedFamily.root.repo, "tasks") }));
    const data = taskViewData(taskId, who, problem);
    if (data === null) return refuse(response, who, 404, "no such task", "/tasks");
    const family = runtime.familyOf(taskId);
    const presentedData = { ...data, rootId: family?.root.id ?? taskId, rootTitle: family?.root.title ?? data.task.title,
      history: family === null || data.assignment != null ? "" : familyHistory(family),
      versionLabel: family !== null && family.current.id !== taskId ? `Viewing ${family.versions.findIndex(one => one.id === taskId) === 0 ? "Original" : `Revision ${family.versions.findIndex(one => one.id === taskId)}`} · ${family.current.state === "running" ? "A newer revision is running" : "A newer revision is current"}` : null };
    if (scopeDraft !== undefined) presentedData.scopeDraft = scopeDraft;
    if (cancelDraft !== undefined) presentedData.cancelDraft = cancelDraft;
    if (editPlan) presentedData.editPlan = true;
    (presentedData as { pullRequest?: TaskPullRequest | null }).pullRequest = taskPullRequestOf(taskId, who);
    // The thread reads the whole family: the original, its revisions, and every attempt across them.
    if (family !== null && family.problem === null) {
      presentedData.family = { root: { id: family.root.id, title: family.root.title, createdAt: family.root.createdAt, goal: runtime.store.getScope(family.root.id)?.goal ?? null },
        versions: family.versions.map(one => ({ id: one.id, title: one.title, state: one.state })),
        runs: family.versions.flatMap(version => version.id === data.task.id ? data.runs.map(run => ({ ...run, taskId: version.id })) : runtime.store.runsFor(version.refId).map(run => ({ ...run, taskId: version.id }))) };
    }
    // What went wrong reads the family's latest finished attempt, as the Tasks row does.
    presentedData.failure = failureOf(presentedData.family?.runs ?? data.runs, data.assignment ?? null);
    presentedData.runChecks = runChecksHere(data.assignment?.receipt?.runId ?? null, who, taskHref(taskId));
    const liveRun = data.liveRunId == null ? undefined : data.runs.find(one => one.id === data.liveRunId);
    if (liveRun !== undefined) presentedData.activity = runActivityOf(runtime.store, liveRun, runtime.clock());
    presentedData.demo = runtime.store.isDemo();
    const paneProject = runtime.restricted() ? runtime.store.lookupRef(taskId)?.repo ?? null : who.via === "cookie" ? who.session.project : null;
    const page = taskPage(
      paneProject === null && !runtime.unscopedMode
        ? runtime.chromeFor(paneProject, "tasks")
        : runtime.chromeFor(paneProject, "tasks", taskListPane(paneProject, family?.root.id ?? taskId)),
      presentedData,
    );
    // The task's own conversation, docked beside the page (v77).
    const focus = taskChatFocus(family?.root.id ?? taskId, runtime.clock(), who, { mintNonce: false });
    const docked = focus === null ? null : runtime.dockedConversation(who, focus, null, runtime.clock(), taskHref(focus.id));
    // The conversation is the page's own thread here, so the page drops its Ask tab;
    // only an approver is offered a road to message the agent.
    const taskView = page.workspace?.view?.kind === "task" ? { ...page.workspace.view, ...(docked === null ? {} : { tabs: [] }), ...(who.role === "approver" ? {} : { chatHref: null }),
      // A signed-in page hears the moment the task changes, and who else has it open.
      ...(who.via === "cookie" ? { live: { href: `${taskHref(family?.root.id ?? taskId)}/live`, at: (() => { try { return taskFingerprint(runtime.store, family?.root.id ?? taskId, runtime.clock()); } catch { return null; } })() } } : {}) } : page.workspace?.view;
    if (docked !== null) page.workspace = { ...page.workspace, ...(taskView === undefined ? {} : { view: taskView }), conversation: docked, pageHtml: page.body };
    else if (taskView !== undefined && page.workspace !== undefined) page.workspace = { ...page.workspace, view: taskView };
    page.refreshSeconds = runtime.liveRefreshSeconds();
    return runtime.sendScreen(response, status, page);
  }

  /** Shared by task controls and chat proposals; both callers authorize the task first. */
  function armTaskResume(response: ServerResponse, who: Who, taskId: string, named: string, returnTo: "chat" | "task", now: Date): void {
    // The resume ceremony's first half (v52): minted by THIS POST, never
    // a GET. The nonce is bound to the exact run, this approver, and a
    // digest of the facts the confirmation restates — the run, its
    // settlement, and the scope's current approval — so a page read
    // before the approval changed cannot resume under the new terms.
    if (who.via !== "cookie") return refuse(response, who, 403, "resuming a task is a browser session's act");
    if (who.role !== "approver") return taskScreen(response, who, taskId, "your login can watch — resuming an attempt is an approver's act", 403);
    if (runtime.store.isDemo()) return taskScreen(response, who, taskId, "the demo authorizes nothing", 403);
    const ref = runtime.store.lookupRef(taskId);
    if (ref === null) return taskScreen(response, who, taskId, "That task is not available.", 404);
    if (!/^[0-9]{1,15}$/.test(named)) return taskScreen(response, who, taskId, "which attempt? the resume names the exact stopped run", 400);
    const runId = Number(named);
    const stop = runtime.store.stopOf(runId);
    const run = runtime.store.getRun(runId);
    if (stop === null || run === null || stop.taskRef !== ref.id) return taskScreen(response, who, taskId, `run #${runId} is not a stopped attempt of this task`, 409);
    if (run.role === "reviewer") return taskScreen(response, who, taskId, `run #${runId} is a historical review run — nothing reruns it; open the saved result instead`, 409);
    if (stop.resumedAt !== null) return taskScreen(response, who, taskId, `run #${runId} was already resumed by ${escape(stop.resumedBy ?? "?")}`, 409);
    const control = taskControlOf(runtime.store, ref.id, now);
    if (control.kind !== "paused" || control.run !== runId) {
      return taskScreen(response, who, taskId, control.kind === "stopping" ? `run #${runId} is still stopping — its processes are not yet established gone` : `run #${runId} is no longer the attempt a resume can name — reload and decide against the current state`, 409);
    }
    const digest = resumeDigestOf(taskId, runId, stop.settledAt ?? "", runtime.store.getScope(taskId));
    const nonceValue = randomBytes(18).toString("base64url");
    const minted = runtime.store.mintCeremonyNonce(
      { hash: nonceHashOf(nonceValue), approver: who.name, subject: "run-resume", subjectId: runId, digest, ttlMs: 15 * 60_000 },
      now,
    );
    if (!minted.ok) return taskScreen(response, who, taskId, "too many unfinished confirmations are open — finish or let them expire", 429);
    const gate = diagnoseTaskDispatch(runtime.store, taskId, now);
    return runtime.sendScreen(response, 200, resumeCeremonyPage(runtime.chromeFor(who.session.project, "tasks"), {
      taskId, taskTitle: runtime.store.getTask(taskId)?.title ?? taskId, control, nonceValue, csrf: who.session.csrf,
      returnTo,
      gate: gate !== null && gate.code === "stopped" ? null : gate,
      approved: (() => { const scope = runtime.store.getScope(taskId); return scope !== null && approvalOf(scope).approved; })(),
    }));
  }

  /** The newest plan document for a task, verified before a byte renders.
   * Its hash is also the plan revision the approval form was minted for. */
  function planViewOf(taskRef: number): { document: string; sha256: string; run: number } | null {
    const artifact = runtime.store.latestPlanArtifact(taskRef);
    if (artifact === null) return null;
    try {
      const verified = readVerifiedArtifact(runtime.evidenceRoot, artifact);
      return verified.ok ? { document: verified.content.toString("utf8"), sha256: artifact.sha256, run: artifact.run } : null;
    } catch {
      return null;
    }
  }

  /**
   * The plan-contract record of the newest drafted plan (contract handoff,
   * task 1): what the planner was filed, what it proposed, its explicit
   * amendment, and every mechanical change between the two — verified
   * before a byte renders, and marked `current` only while the proposed
   * terms are still exactly the scope row (an operator's later edit turns
   * the record into history, never a claim about the row).
   */
  function planContractViewOf(taskRef: number, scope: Scope | null): PlanContractView | null {
    const artifact = runtime.store.latestPlanContractArtifact(taskRef);
    if (artifact === null) return null;
    try {
      const verified = readVerifiedArtifact(runtime.evidenceRoot, artifact);
      if (!verified.ok) return { run: artifact.run, problem: `the contract record no longer verifies — ${verified.problem}` };
      const record = decodePlanContractRecord(verified.content);
      if (record === null) return { run: artifact.run, problem: "the contract record is not the JSON it was sealed as" };
      return {
        run: artifact.run,
        sourceDigest: record.sourceDigest,
        filed: record.filed !== null,
        amendment: record.amendment,
        changes: record.changes,
        changeWords: describeContractChanges(record.changes),
        current: scope !== null && contractChangesOf(record.proposed, scope).length === 0,
        revision: runtime.store.revisionSourceOf(taskRef) !== null,
      };
    } catch {
      return { run: artifact.run, problem: "the contract record could not be read" };
    }
  }

  function revisionDocOf(row: PlanRevision): RevisionDocView | null {
    const artifact = runtime.store.getArtifact(row.artifact);
    if (artifact === null) return null;
    try {
      const verified = readVerifiedArtifact(runtime.evidenceRoot, artifact);
      if (!verified.ok) return null;
      return {
        id: row.id,
        revision: row.revision,
        status: row.status,
        reason: row.reason,
        evidenceLink: row.evidenceLink,
        author: row.author,
        kind: row.kind,
        authorityKind: row.authorityKind,
        changedFields: row.changedFields,
        document: verified.content.toString("utf8"),
        sha256: artifact.sha256,
        createdAt: row.createdAt,
        resolvedAt: row.resolvedAt,
        resolvedBy: row.resolvedBy,
      };
    } catch {
      return null;
    }
  }

  /**
   * The adaptive-plan ledger for one task: the revision currently in force,
   * any revision still 'blocked' awaiting an operator's accept or reject,
   * and the full immutable history. A task with no `plan_revision` rows at
   * all — every task filed before this feature, or one whose first
   * revision is still 'blocked' — reads `current` as a read-only
   * projection off the existing planner artifact (`planViewOf`), never
   * written back as a row: c1's "older builds with no checkpoints remain
   * readable."
   */
  function revisionLedgerOf(taskRef: number): PlanRevisionLedgerView {
    const history = runtime.store.listPlanRevisions(taskRef).map(revisionDocOf).filter((view): view is RevisionDocView => view !== null);
    const currentRow = runtime.store.currentPlanRevision(taskRef);
    const latestRow = runtime.store.latestPlanRevision(taskRef);
    const pending = latestRow !== null && latestRow.status === "blocked" ? revisionDocOf(latestRow) : null;
    let current = currentRow === null ? null : revisionDocOf(currentRow);
    if (current === null) {
      const legacy = planViewOf(taskRef);
      current =
        legacy === null
          ? null
          : {
              id: null,
              revision: 1,
              status: "applied",
              reason: "the plan the operator approved",
              evidenceLink: null,
              author: "planner",
              kind: "initial",
              authorityKind: "plan-only",
              changedFields: [],
              document: legacy.document,
              sha256: legacy.sha256,
              createdAt: "",
              resolvedAt: null,
              resolvedBy: null,
            };
    }
    return { current, pending, history };
  }

  /** The live milestone projection for a task: every milestone in the
   * CURRENT revision's document, in order, each carrying the newest
   * checkpoint's state for its exact id — a checkpoint filed against an
   * older, differently-worded revision simply has no matching ids, so its
   * milestones fall back to "pending" rather than showing stale progress
   * under a plan that no longer says that. */
  function progressOf(taskRef: number, currentDocument: string | null): MilestoneProgressView[] | null {
    if (currentDocument === null) return null;
    const parsed = parseExecutionPlanDocument(currentDocument);
    if (!parsed.ok) return null;
    const milestones = milestonesOf(parsed.document);
    const checkpoint = runtime.store.latestCheckpointForTask(taskRef);
    const byId = new Map((checkpoint?.snapshot.milestones ?? []).map(entry => [entry.id, entry]));
    return milestones.map(milestone => {
      const entry = byId.get(milestone.id);
      return { id: milestone.id, description: milestone.description, state: entry?.state ?? "pending", note: entry?.note ?? null };
    });
  }

  /**
   * The review cockpit's projection of ONE completed task (Priority 5):
   * approved intent from the scope and plan already on file, the result
   * run's sealed artifacts through the same verified readers the run page
   * uses, the stored verdict and matrix, the contest and publication
   * rows. Nothing here is a new record: a manual completion (no run), a
   * legacy result (no proof verdict), and a broken artifact each read as
   * exactly what they are. Only the selected result is enriched — the
   * queue rows carry the done list's own facts and nothing more.
   */
  /**
   * The result detail (workspace package 3): every verified record one
   * finished run's result presentation reads, assembled once for the run
   * page, the review cockpit, and the chat's result view. Read-only.
   */
  function resultDetailOf(run: Run, who: Who, now: Date): ResultDetail {
    const taskId = runtime.store.externalIdFor(run.taskRef) ?? "?";
    const scope = runtime.store.getScope(taskId);
    const artifacts = runtime.store.artifactsFor(run.id);
    const terminal = terminalDiffView(artifacts, runtime.evidenceRoot);
    const proof = proofBundleView(runtime.store, run, artifacts, runtime.evidenceRoot);
    const handoff = structuredHandoffView(artifacts, runtime.evidenceRoot);
    const review = runtime.reviewFactsFor(run.id);
    const receipt = completionReceiptView(runtime.store, run, artifacts, runtime.evidenceRoot, review);
    // File anchors come from the PARSED sealed patch — a stat path with no
    // hunk in the patch gets no anchor, never a dangling one.
    const patch = terminal?.patch ?? null;
    const patchOk = patch !== null && !("problem" in patch);
    const parsedPaths = patchOk ? parseReviewDiff(patch.text).files.filter(one => one.hunks.length > 0).map(one => one.path) : [];
    const fileAnchors = new Map(parsedPaths.map(path => [path, diffFileAnchor(path)] as const));
    const statFiles = terminal?.stat !== null && terminal?.stat !== undefined && !("problem" in terminal.stat) ? terminal.stat.files : [];
    const cited = new Set<string>();
    for (const criterion of proof?.matrix ?? []) for (const answer of criterion.answered) if (answer.kind === "changed-path") cited.add(answer.ref);
    const touches = scope?.touches ?? [];
    const files = orderChangedFiles(
      statFiles.map(file => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        renamedFrom: file.renamedFrom ?? null,
        anchor: fileAnchors.get(file.path) ?? null,
        outsideTouches: touches.length > 0 && !withinSignedTouches(file.path, touches),
        cited: cited.has(file.path),
      })),
      cited.size > 0,
    );
    const publication = runtime.store.publicationForRun(run.id);
    let learning = "", skillTest = false;
    const learningRepo = runtime.store.refForId(run.taskRef)?.repo;
    if (learningRepo && runtime.visible(learningRepo)) {
      try { learning = learningHtml(learningView(runtime.store, runtime.evidenceRoot, learningRepo, who.name), who.via === "cookie" ? who.session.csrf : "", who.role === "approver", run.id); }
      catch { /* Learning failures remain available in Settings; the result is independent. */ }
      try { const test=skillTestResult(runtime.store,run.id,who.name);if(test){skillTest=true;learning=skillTestFeedbackHtml(test,who.via==='cookie'?who.session.csrf:'',who.role==='approver')+learning;} }
      catch { learning='<p role="alert">The saved skill test could not be verified.</p>'+learning; }
      try { learning = skillsSnapshotHtml(readSkillsSnapshot(runtime.store,run.id)) + knowledgeContextHtml(readKnowledgeSnapshot(runtime.store,run.id)) + learning; }
      catch { learning = '<p class="problem" role="alert">The context saved for this run could not be verified.</p>' + learning; }
    }
    return {
      learning,
      skillTest,
      taskId,
      rootId: runtime.familyOf(taskId)?.root.id ?? taskId,
      history: (() => { const family = runtime.familyOf(taskId); return family === null ? "" : familyHistory(family); })(),
      run,
      receipt,
      assignment: (() => {
        const value = assignmentOf(runtime.store, taskId, now, runtime.workAccess(), runtime.evidenceRoot);
        return value?.receipt?.runId === run.id && value.activeTaskId === taskId ? freshAssignment(value, receipt) : null;
      })(),
      handoff,
      proof,
      terminal,
      publication,
      pullRequestTo: pullRequestTargetOf(run.id),
      publishing: pullRequestTargetOf(run.id) !== null ? "pull-request" : publishingOf(runtime.store, runtime.store.refById(run.taskRef)?.repo ?? null).on ? "other" : "off",
      ciFailing: publication !== null && publication.prNumber !== null && runtime.store.hasOpenCiEpisode(publication.githubRepo, publication.prNumber),
      files,
      outsideTouches: files.filter(one => one.outsideTouches).map(one => one.path),
      fileAnchors,
      comments: runtime.store.liveDiffComments(run.id).filter(isRevisionFeedback),
      pastComments: runtime.store.allDiffComments(run.id).filter(one => one.reviewerRun === null && (one.consumedBy !== null || one.supersededBy !== null)),
      reviewerFindings: runtime.store.allDiffComments(run.id).filter(one => one.reviewerRun !== null),
      automaticReview: buildReviewOf(runtime.store, run.id),
      revisions: runtime.store.revisionsFromRun(run.id).flatMap(one => {
        const child = runtime.store.getTask(one.id);
        if (child === null || !runtime.visible(runtime.store.lookupRef(one.id)?.repo ?? null)) return [];
        // The same projection the Work list and the child's own page wear.
        const status = workRowOf({ ...child, repo: runtime.store.lookupRef(one.id)?.repo ?? null }, now).status;
        return [{ id: one.id, title: one.title, state: one.state, approved: approvalOf(runtime.store.getScope(one.id)).approved, standing: status.label, tone: status.tone }];
      }),
      sourceDigest: scope?.digest ?? null,
      followUps: followUpsFor(runtime.store, runtime.evidenceRoot, run, now),
      route: runtime.store.runRoute(run.id),
      // Editor links (arc 6): the deployment capability, THIS machine's
      // runner owning the run, the session's own device-side yes, and a
      // checkout to open — or nothing renders.
      editor:
        runtime.options.editorLinks !== undefined && runtime.options.localRunner !== undefined && run.runner === runtime.options.localRunner && who.via === "cookie" && who.session.editorLinks === true && run.worktree !== null
          ? { worktree: run.worktree }
          : null,
      signedCriteria: scope?.acceptance.length ?? 0,
      canAnnotate: who.via === "cookie" && patchOk && patch.text.trim() !== "",
    };
  }
  return { guided, projectFamilyPeek, familiesInView, familyTasksInView, revisionDestination, earlierLiveVersions, familyHistory, freshAssignment, workRowOf, taskListPane, runIsLive, runIsTaskResult, revisionViewOf, taskViewData, routeViewOf, taskChatFocus, pullRequestTargetOf, taskPullRequestOf, failureOf, explainAttempt, runChecksHere, taskScreen, armTaskResume, planViewOf, planContractViewOf, revisionDocOf, revisionLedgerOf, progressOf, resultDetailOf };
}
