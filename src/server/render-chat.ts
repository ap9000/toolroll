/** The conversation: chat and lead pages, proposal cards and the task chat. */
import { assignmentSummaryHtml } from "../assignment-ui.js";
import { type AssignmentSnapshot } from "../assignment.js";
import { type BrowserActionCard } from "../browser-workspace.js";
import { CHAT_ACTIONS,sharedActionNeedsReview,sharedActionPayload,sharedActionReviewPath } from "../chat-actions.js";
import { CHAT_CONTINUITY_SCRIPT } from "../chat-continuity.js";
import { CHAT_CONTROLS,chatControlHref,isChatControl } from "../chat-controls.js";
import { chatActivityDetailsHtml,chatWorkingHtml,completedWorkHtml } from "../chat-polish.js";
import { CHAT_TASK_ACTIONS,isChatTaskAction } from "../chat-task-actions.js";
import { isCheckLevel } from "../check-levels.js";
import { type ChatDraft,isSubscriptionChatProvider } from "../converse.js";
import { type DispatchDiagnosis } from "../dispatch.js";
import { firstTaskJourney,START_COMMAND } from "../first-run.js";
import { FLOW_HREF } from "../flow-engine.js";
import { PROPOSAL_WAIT_REASON,proposalActGate } from "../mate-doors.js";
import { type MateLiveStep } from "../mate-progress.js";
import { MATE_MESSAGE_MAX_CHARS } from "../mate.js";
import { type FailureExplanation } from "../needs-you.js";
import { projectName } from "../project.js";
import { replyHtmlInline,shapeReply } from "../reply-shape.js";
import { RESULT_REVIEW_SCRIPT } from "../result-review.js";
import { type Scope } from "../scope.js";
import { type ChatConfig,type ChatProviderId,type ChatSnapshot,type ChatTurn,type CheckProgress,type CoordinatorProposal,type Decision,type DirectChatProviderId,MATE_ASK_OTHER,type MateAsk,type MateMessage,type MateProposal,type MateSession,type MateTurn,type Publication,type RepairChainRow,type Store,type SubscriptionChatProviderId,type TaskFamily,type TaskState } from "../store.js";
import { type TaskControlView } from "../task-control.js";
import { assignmentStageOf,stageOfCode } from "../task-status.js";
import { type TeamChatProviderResolver } from "../team-chat-authorization.js";
import { type TeamSnapshot } from "../team-contract.js";
import { buildProgressOf,type DisplayStatus } from "../workspace-ui.js";
import { html,htmlString,isHtml,joinHtml,postForm,replaceMarkup,type Html,type HtmlValue } from "../html.js";
import { requestContext,withFormToken } from "./request-context.js";
import { createHash,randomBytes } from "node:crypto";
import { chatMoney,type Chrome,oneLineOf,relativeAge,safePrUrl,screen,type Screen,sentenceCase,strokeIcon } from "./chrome.js";
import { chatResultHref,projectChatHref,taskChatHref,taskHref } from "./http.js";
import { type ProjectPeek } from "./render-pages.js";
import { completionReceiptCard,type CompletionReceiptView } from "./render-results.js";
import { type LeadFormFacts } from "./render-settings.js";
import { agentsAvailabilityHtml,agentsBadgesHtml,agentsStripHtml,agentsSummaryWords,agentsWhyHtml,approvalSheetHtml,checkProgressHtml,consentClosedHtml,consentDoorOf,decisionAnswerCard,dispatchHeadline,milestoneProgressHtml,type MilestoneProgressView,type PlanContractView,planRevisionLedgerHtml,type PlanRevisionLedgerView,profileWords,type RevisionView,type RouteView,sizeConsequence,taskControlDetailsHtml,taskStatusCard,taskViewSwitch } from "./render-tasks.js";

/** The installation fact that the lead was turned on by default, once (its value: the provider). */
export const LEAD_BY_DEFAULT_FACT = "lead-on-by-default";
/** The installation fact that the phone card was put away. */
export const PHONE_CARD_FACT = "phone-card-dismissed";

export type ChatProjectPulse = {
  id: string;
  label: string;
  path: string;
  peek: ProjectPeek | null;
};

/** A task attached by the server to one chat turn. The thread remains the
 * unified conversation; this is a focused lens, not a second chat silo. */
export type TaskChatFocus = {
  executionId: string;
  /** A failed task: what its latest attempt missed and what to change (the task page's own words). */
  failure?: FailureExplanation | null;
  /** Until this installation's first Ready result, the task shows where it stands on Plan → You approve → Build → Checks → Ready. */
  guide?: boolean;
  family: TaskFamily;
  history: Html;
  status: DisplayStatus;
  assignment: AssignmentSnapshot | null;
  id: string;
  title: string;
  state: TaskState;
  project: string | null;
  now: Date;
  dispatch: DispatchDiagnosis | null;
  scope: "none" | "needs approval" | "approved";
  plan: "requested" | "drafted" | null;
  /** Adaptive execution plans (v44): the identical ledger/progress
   * projection the task page renders (c2). */
  planRevisions: PlanRevisionLedgerView | null;
  milestoneProgress: MilestoneProgressView[] | null;
  claimed: boolean;
  liveRun: { id: number; runner: string; startedAt: string; phase: string | null } | null;
  checkProgress: CheckProgress | null;
  /** v52: the exact-run control — the task page's own projection. */
  control: TaskControlView;
  /** The phase route (v47): the task page's exact projection, so chat and
   * page can never disagree about which agent runs which phase. */
  route: RouteView | null;
  /** Approval uses the task page's exact nonce and joint digest. */
  approval: {
    scope: Scope;
    nonce: string;
    digest: string;
    planDocument: string | null;
    /** The drafted plan's contract record (contract handoff, task 1): the
     * same panel the task page and /next show inside the ceremony. */
    planContract: PlanContractView | null;
    deliverable: "branch" | "report";
    revision: RevisionView | null;
    coordinator: { label: string; filedAgo: string | null } | null;
    /** The repair chain row when this task is a machine-drafted repair. */
    repairChain: RepairChainRow | null;
  } | null;
  decisions: (Decision & { taskId: string; repo: string | null })[];
  publication: Publication | null;
  /** The same compact, evidence-backed receipt shown on the task page.
   * Chat is a lens over durable workflow state, never a second copy. */
  result: CompletionReceiptView | null;
};
/** The task composer's modes (console v2), as the words the lead reads for that one turn. */
export type TaskComposerMode = "build" | "plan" | "answer";
export const TASK_COMPOSER_MODES: Record<TaskComposerMode, string> = {
  build: "The operator chose Build: if they ask for a change to the result, read it with get_result and propose a revision of this task with propose_review (operation revise) for them to confirm. Nothing builds until they confirm the card.",
  plan: "The operator chose Plan only: answer with a short plan for what they ask. Do not propose a revision, a new task or any other action this turn.",
  answer: "The operator chose Just answer: answer from what you can read. Do not propose any action this turn.",
};

export function taskChatContext(focus: TaskChatFocus): Html {
  return html`<aside class="task-chat-context" aria-label="current task"><div class="task-chat-context-head"><span class="eyebrow">current task</span></div><h2>${focus.title}</h2><p class="meta mono">${focus.id}${focus.project === null ? "" : html` · ${focus.project}`}</p>${
    // The agents in chat (v47): the same summary the task page and CLI
    // print — who does what — with the reasons one tap away, so a
    // conversation never hides which agent runs.
    focus.route === null
      ? ""
      : html`<div class="task-chat-agents-aside"><span class="eyebrow">agents</span><p class="agents-summary">${agentsSummaryWords(focus.route)}</p><div class="agents-badges">${agentsBadgesHtml(focus.route)}</div>${
        focus.route.projection === null ? "" : html`${agentsAvailabilityHtml(focus.route.projection)}${agentsWhyHtml(focus.route.projection)}`}<p class="meta"><a href="${taskHref(focus.id)}#agents">Change agents on the task →</a></p></div>`}<div class="task-chat-overview-actions"><a class="task-chat-overview-link" href="${taskHref(focus.id)}">Open full overview →</a></div></aside>`;
}

export function taskChatApproval(focus: TaskChatFocus, csrf: string): Html {
  const approval = focus.approval;
  if (focus.plan === "requested") {
    // The task status already names planning. No second status card.
    return html``;
  }
  if (approval === null) return html``;
  const scope = approval.scope;
  const returnTo = taskChatHref(focus.id);
  if (approval.revision !== null && "problem" in approval.revision) {
    return html`<section class="card chat-action-card" id="task-chat-action"><span class="eyebrow">approval needs attention</span><h2>The revision brief can’t be verified</h2><p class="meta">${approval.revision.problem}</p><a class="button-link" href="${taskHref(focus.id)}#approve">Fix this on the task →</a></section>`;
  }
  const door = consentDoorOf(scope, focus.route);
  if (!door.open) return consentClosedHtml(focus.id, door, "chat");
  if (approval.nonce === "") {
    return html`<section class="card chat-action-card" id="task-chat-action"><span class="eyebrow">approval needs attention</span><h2>The agent setup isn’t ready yet</h2>${profileWords(scope)}<a class="button-link" href="${taskHref(focus.id)}#scope">Fix the agent setup →</a></section>`;
  }
  // The same sheet as the task page (approval critique, Oct 2): the plan
  // open in plain rows, one Approve & start, the rest in Details.
  return html`<section class="card chat-action-card chat-plan" id="task-chat-action" data-approval="${approval.digest}">${
    approvalSheetHtml({
      surface: "chat",
      action: `${taskHref(focus.executionId)}/approve`,
      csrf,
      nonce: approval.nonce,
      digest: approval.digest,
      returnTo,
      scope,
      planDocument: approval.planDocument,
      planContract: approval.planDocument === null ? null : approval.planContract,
      revision: approval.revision,
      revisionSourceHref: approval.revision === null ? "" : chatResultHref(focus.id, approval.revision.sourceRun),
      repairChain: approval.repairChain,
      route: focus.route,
      coordinator: approval.coordinator,
      deliverable: approval.deliverable,
      // Edit plan opens the task page's sheet with its fields open for editing.
      editHref: `${taskHref(focus.id)}?edit=plan#plan-editor`,
      notNowHref: "/chat",
      sticky: false,
      earlier: { active: focus.assignment?.earlierActive ?? 0, running: focus.assignment?.earlierRunning ?? 0 },
      edit: null,
    })}</section>`;
}

/** The chat's status sentence, worded as the task page words it: what a failed attempt missed, or which step a live
 * build is on (and the step it is stuck on). Undefined keeps the shared status sentence. */
export function chatStatusSentence(focus: TaskChatFocus): string | undefined {
  if (focus.state === "failed" && focus.failure != null) return [focus.failure.line, focus.failure.evidence].filter(Boolean).join(" ");
  const steps = focus.liveRun === null ? null : buildProgressOf(focus.milestoneProgress);
  return steps === null ? undefined : steps.line;
}

/** One live, server-derived journey from request to proof. The fragment is
 * safe to refresh independently, so an in-progress message is never lost. */
export function taskChatLiveRegion(focus: TaskChatFocus, csrf: string, fragment = false, inert = false, approvalHref = taskChatHref(focus.id) + "#task-chat-action"): Html {
  const receiptLeads = focus.state === "done" && focus.result !== null;
  const approvalContent = (inert && focus.approval !== null && focus.plan !== "requested"
      ? html`<section class="card chat-action-card"><span class="eyebrow">approval ready</span><h2>Finish the current chat response first</h2><p class="meta">The secure approval step appears here as soon as this response lands.</p></section>`
      : fragment && focus.approval !== null && focus.plan !== "requested"
        ? html`<section class="card chat-action-card chat-refresh-action"><a class="button-link" href="${approvalHref}" data-primary-action>Approve plan</a></section>`
        : taskChatApproval(focus, csrf));
  const approvalCard = focus.approval !== null && focus.dispatch?.action !== "approve-scope"
    ? html`<details class="task-secondary-approval"><summary>Updated approval terms</summary>${approvalContent}</details>` : approvalContent;
  const polling = !inert && ((focus.approval === null || focus.plan === "requested") && focus.state !== "done" && focus.state !== "cancelled" || focus.control.kind === "stopping" || focus.control.kind === "stop");
  const status = focus.assignment !== null
    ? html`${assignmentSummaryHtml(focus.assignment, { workStatus: focus.status, hideAction: focus.approval !== null && focus.dispatch?.action === "approve-scope", sentence: chatStatusSentence(focus), ...(receiptLeads ? { resultHref: chatResultHref(focus.id, focus.result!.runId) } : {}) })}${receiptLeads ? completionReceiptCard(focus.result!, focus.id, "chat", focus.status, focus.assignment, false) : ""}`
    : receiptLeads ? completionReceiptCard(focus.result!, focus.id, "chat", focus.status) : taskStatusCard(focus.status, focus.id, focus.dispatch, focus.liveRun?.id ?? null, focus.approval !== null && focus.dispatch?.action === "approve-scope");
  const publication = focus.publication;
  const prUrl = publication === null ? null : safePrUrl(publication.prUrl);
  return html`<section id="task-chat-live" aria-live="polite" data-task="${focus.id}" data-execution="${focus.executionId}" data-source="/chat/task-status?task=${encodeURIComponent(focus.id)}" data-poll="${polling ? "1" : "0"}" data-approval="${focus.approval?.digest ?? ""}" data-plan="${focus.plan ?? ""}">${
    focus.guide === true && focus.state !== "cancelled" ? firstTaskJourneyHtml(focus) : ""}<div class="task-live-summary">${status}${
    checkProgressHtml(focus.checkProgress)}${
    // The exact-run control (v52): the SAME component the task page
    // renders, refreshed with the live region — typed input in the
    // composer is untouched because only this region is replaced.
    taskControlDetailsHtml(focus.control, focus.executionId, csrf, "chat", inert)}${
    // The compact agents strip (v47): always visible, phones included,
    // where the desktop context panel is hidden.
    agentsStripHtml(focus.route, focus.executionId)}</div>${
    milestoneProgressHtml(focus.milestoneProgress)}${
    planRevisionLedgerHtml(focus.planRevisions, focus.executionId, csrf)}${
    approvalCard}${focus.history}${
    focus.decisions.length === 0
      ? ""
      : html`<section class="chat-decisions"><div class="chat-section-head"><h2>Needs your answer</h2></div>${focus.decisions.map(one => focus.approval !== null || inert
        ? html`<div class="decide-card"><p class="q">${one.question}</p><p class="meta">${oneLineOf(one.recap, 160)}</p><a href="/d/${one.id}?return=${encodeURIComponent(taskChatHref(focus.id))}">Review and answer →</a></div>`
        : decisionAnswerCard(one, csrf, focus.now, false, taskChatHref(focus.id)))}</section>`}${
    focus.result === null || receiptLeads ? "" : html`<details class="task-previous-result"><summary>Previous result</summary>${completionReceiptCard(focus.result, focus.id, "chat")}</details>`}${
    publication === null ? "" : html`<p class="chat-publication meta">Published as ${prUrl === null ? html`<span class="mono">PR #${publication.prNumber ?? "?"}</span>` : html`<a href="${prUrl}">PR #${publication.prNumber ?? "?"}</a>`} · ${publication.state}${publication.lastCheckState === null ? "" : html` · CI ${publication.lastCheckState}`}</p>`}</section>`;
}

/** The first task's way to Ready, filled in as it moves (onboarding): the same stage every surface reads. */
export function firstTaskJourneyHtml(focus: TaskChatFocus): Html {
  const planning = focus.plan === "requested" && focus.approval === null;
  const read = focus.assignment !== null ? assignmentStageOf(focus.assignment, { token: focus.status.token }, planning) : stageOfCode(focus.status.token, { planning });
  const steps = firstTaskJourney(read, focus.scope === "approved", focus.state === "done");
  const current = steps.find(one => one.state === "current" || one.state === "stuck");
  return html`<ol class="first-task-journey" aria-label="Where this task is${current === undefined ? ": Ready" : `: ${current.label}`}" data-first-task-journey>${
    steps.map(one => html`<li data-step="${one.key}" data-state="${one.state}"${one.state === "current" || one.state === "stuck" ? html` aria-current="step"` : ""}><span class="first-task-journey-mark" aria-hidden="true"></span><span>${one.label}</span></li>`)}</ol>`;
}

export function taskChatHeading(focus: TaskChatFocus): Html {
  return html`<div class="chat-head task-chat-head"><div><p class="meta chat-task-back"><a href="${taskHref(focus.id)}">← task overview</a></p><div class="task-chat-title-line"><div><h1>${focus.title}</h1></div>${taskViewSwitch(focus.id, "ask")}</div></div></div>`;
}

export function chatWorkspace(content: Html, projects: readonly ChatProjectPulse[], inert: boolean, focus: TaskChatFocus | null, resultPanel: Html | null = null): Html {
  if (focus === null) return html`<div class="chat-workspace">${chatProjectRail(projects, inert)}<section class="chat-main">${content}</section></div>`;
  // The result detail (package 3) is the ONE auxiliary panel when open:
  // it takes the context panel's place beside the conversation on a wide
  // screen and becomes the dedicated view, with Back to chat, when the
  // screen has no room for both (CSS decides; the markup is the same).
  if (resultPanel !== null) {
    return html`<div class="chat-workspace task-chat-workspace result-open" data-chat-result-open><section class="chat-main">${content}</section><aside class="chat-result t-panel-slide" data-open="true" aria-label="result">${resultPanel}</aside></div>`;
  }
  return html`<div class="chat-workspace task-chat-workspace">${taskChatContext(focus)}<section class="chat-main">${content}</section></div>`;
}

/** The folded overview's one-line summary (UI polish 2026-09-13): the
 * two counts a phone reader scans before deciding to open it. */
export function chatOverviewSummaryHtml(projects: readonly ChatProjectPulse[], attention?: { count: number; saturated: boolean }): Html {
  const total = (key: keyof ProjectPeek): number => projects.reduce((sum, one) => sum + (one.peek?.[key] ?? 0), 0);
  const needsYou = attention?.count ?? total("waiting");
  const running = total("running");
  return html`<summary>Project overview<span class="meta">${needsYou > 0 ? html`<span class="hot">${needsYou}${attention?.saturated ? "+" : ""} need${needsYou === 1 ? "s" : ""} you</span>` : "nothing waiting"} · ${running} building</span></summary>`;
}

/** A live, server-derived portfolio card. It is deliberately independent
 * of the model's prose: the numbers and links always reflect the current
 * control plane, while chat remains the place to ask what they mean. */
export type AssignmentChatSnapshot = ChatSnapshot & { assignmentStates?: Record<string, { state: AssignmentSnapshot['state']; label: string; detail: string }>; attentionCount?: { count: number; saturated: boolean } };

export function chatFleetOverview(
  snapshot: AssignmentChatSnapshot | null,
  projects: readonly ChatProjectPulse[],
  interactive: boolean,
): Html {
  if (snapshot === null) {
    return html`<section class="card chat-overview"><h2>Project summary unavailable</h2><p class="meta">Reload to try again. You can still use chat.</p></section>`;
  }
  const total = (key: keyof ProjectPeek): number => projects.reduce((sum, one) => sum + (one.peek?.[key] ?? 0), 0);
  const needsYou = snapshot.attentionCount?.count ?? total("waiting");
  const running = total("running");
  const queued = total("queued");
  const done = total("doneRecently");
  const projectOf = (index: number): string => projects[index]?.label ?? `r${index + 1}`;
  const rows: Html[] = [];
  for (const decision of snapshot.decisions.slice(0, 2)) {
    rows.push(
      html`<a class="chat-overview-item decision" href="/d/${decision.id}"><span class="chat-overview-icon">${strokeIcon(html`<path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4"/><path d="M12 18h.01"/><circle cx="12" cy="12" r="9"/>`)}</span><span class="chat-overview-copy"><strong>${decision.question}</strong><span>${projectOf(decision.repoIndex)} · ${decision.taskId} · decision #${decision.id}</span></span><span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  for (const task of snapshot.tasks
    .filter(one => one.dispatch?.condition === "waiting" && one.state !== "done")
    .slice(0, Math.max(0, 3 - rows.length))) {
    const dispatch = task.dispatch as DispatchDiagnosis;
    rows.push(
      html`<a class="chat-overview-item decision" href="${taskHref(task.rootId ?? task.id)}" data-dispatch-status="${dispatch.code}"><span class="chat-overview-icon">${strokeIcon(html`<path d="M12 8v4"/><path d="M12 16h.01"/><circle cx="12" cy="12" r="9"/>`)}</span><span class="chat-overview-copy"><strong>${task.title}</strong><span>${projectOf(task.repoIndex)} · ${task.id} · ${dispatchHeadline(dispatch)}</span></span><span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  for (const task of snapshot.tasks.filter(one => one.state === "failed").slice(0, Math.max(0, 3 - rows.length))) {
    rows.push(
      html`<a class="chat-overview-item failed" href="${taskHref(task.rootId ?? task.id)}"><span class="chat-overview-icon">${strokeIcon(html`<path d="M12 9v4"/><path d="M12 17h.01"/><path d="m10.3 2.9-8.6 15A2 2 0 0 0 3.4 21h17.2a2 2 0 0 0 1.7-3.1l-8.6-15a2 2 0 0 0-3.4 0z"/>`)}</span><span class="chat-overview-copy"><strong>${task.title}</strong><span>${projectOf(task.repoIndex)} · ${task.id} · failed</span></span><span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  // Current assignments own attention. The saved assessment is history,
  // never a second queue after the lead marked the result complete.
  for (const task of snapshot.tasks
    .filter(one => one.state === "done" && ["ready-to-check", "needs-decision"].includes(snapshot.assignmentStates?.[one.id]?.state ?? ""))
    .slice(0, Math.max(0, 3 - rows.length))) {
    rows.push(
      html`<a class="chat-overview-item failed" href="${taskHref(task.rootId ?? task.id)}"><span class="chat-overview-icon">${strokeIcon(html`<path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/>`)}</span><span class="chat-overview-copy"><strong>${task.title}</strong><span>${projectOf(task.repoIndex)} · ${snapshot.assignmentStates![task.id]!.label} · ${snapshot.assignmentStates![task.id]!.detail}</span></span><span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  for (const task of snapshot.tasks.filter(one => one.state === "running").slice(0, Math.max(0, 4 - rows.length))) {
    rows.push(
      html`<a class="chat-overview-item running" href="${taskHref(task.rootId ?? task.id)}"><span class="chat-overview-icon">${strokeIcon(html`<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`)}</span><span class="chat-overview-copy"><strong>${task.title}</strong><span>${projectOf(task.repoIndex)} · ${task.id} · building now</span></span><span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  const saturated = snapshot.tasksSaturated || snapshot.decisionsSaturated || snapshot.incidentsSaturated;
  const briefing = "Brief me on what needs my attention, what is building, and the highest-leverage next action across every project.";
  return html`<section class="card chat-overview" aria-label="live portfolio overview" data-card-kind="fleet-overview"><div class="chat-overview-head"><h2>${projects.length} project${projects.length === 1 ? "" : "s"}</h2>${
    interactive
      ? postForm("/chat", html`<button type="submit" name="message" value="${briefing}" class="quiet">Brief me</button>`, { attrs: { class: "inline" } })
      : html`<a href="/board?scope=all" class="chat-overview-link">open board</a>`}</div><div class="chat-overview-stats"><a href="/work?view=needs-you" class="chat-overview-stat attention"><b>${needsYou}${snapshot.attentionCount?.saturated ? "+" : ""}</b><span>need you</span></a><a href="/board?scope=all" class="chat-overview-stat live"><b>${running}</b><span>building</span></a><a href="/board?scope=all&amp;view=order" class="chat-overview-stat"><b>${queued}</b><span>queued</span></a><a href="/work" class="chat-overview-stat"><b>${done}</b><span>finished today</span></a></div>${
    rows.length === 0 ? html`<p class="chat-overview-clear">${needsYou === 0 && running === 0 ? html`<span class="dot dot-ok"></span>No tasks are waiting and no builds are running.` : html`<a href="/work">Open Tasks to inspect current work.</a>`}</p>` : html`<div class="chat-overview-items">${rows}</div>`}${
    completedWorkHtml(snapshot, projects.map(project => project.label), snapshot.assignmentStates)}${
    saturated ? html`<p class="meta chat-overview-note">Some items aren’t shown. Open Work to see more.</p>` : ""}</section>`;
}

/**
 * The mate's project rail: one bounded pulse per admitted project, plus
 * two roads that preserve the plane's contracts. "ask" sends the stable
 * rN alias the model already sees; "board" uses the existing POST switch
 * instead of smuggling a project change through a GET parameter.
 */
export function chatProjectRail(projects: readonly ChatProjectPulse[], inert: boolean): Html {
  const statusOf = (peek: ProjectPeek | null): string =>
    peek === null
      ? "unavailable"
      : peek.waiting > 0
        ? "needs you"
        : peek.running > 0
          ? "building"
          : peek.queued > 0
            ? "queued"
            : "quiet";
  const rows = projects.map(one => {
    const peek = one.peek;
    const ask = `Give me a concise status for ${one.id} (${one.label}) and recommend the next reversible action.`;
    return html`<div class="chat-project-card"><div class="chat-project-name"><span class="mono">${one.id}</span><strong>${one.label}</strong><span class="badge">${sentenceCase(statusOf(peek))}</span></div>${
      peek === null
        ? html`<p class="meta">Pulse unavailable</p>`
        : html`<div class="chat-project-stats"><span${peek.waiting > 0 ? html` class="hot"` : ""}><b>${peek.waiting}</b> need you</span><span><b>${peek.running}</b> live</span><span><b>${peek.queued}</b> queued</span><span><b>${peek.doneRecently}</b> done today</span></div>`}<div class="chat-project-actions">${
      inert
        ? ""
        : postForm("/chat", html`<button type="submit" name="message" value="${ask}" class="quiet" aria-label="ask about ${one.label}">Ask</button>`, { attrs: { class: "inline" } })}${
      postForm("/projects/open", html`<button type="submit" class="quiet" aria-label="open ${one.label} board">Board</button>`, { attrs: { class: "inline" }, hidden: { path: one.path, return: "/board" } })}</div></div>`;
  });
  return html`<aside class="chat-projects" id="chat-project-panel" aria-label="projects in this conversation"><div class="chat-projects-head"><h2>Projects</h2><span class="badge">${projects.length}</span><button type="button" class="chat-project-close quiet" aria-label="close projects">×</button></div><div class="chat-project-list">${rows}</div></aside>`;
}

/** Spend-authorized one-click questions: ordinary /chat posts, not a new door. */
export function matePromptStarters(focus: TaskChatFocus | null = null): Html {
  const prompts = focus === null
    ? [
        ["brief me", "Brief me on what needs my attention, what is building, and the highest-leverage next action across every project."],
        ["decisions", "Walk me through the open decisions, their options, and what you recommend I inspect first."],
        ["new task", "Help me define a new task. Ask only about choices that materially change the result; otherwise use your judgment and sensible reversible defaults."],
      ] as const
    : [
        ["What’s happening", "Read this task and explain its current status, what is blocking it, and what should happen next."],
        ["Review results", "Review the evidence recorded for this task and tell me what is proven and what is still unverified."],
        ["Adjust the plan", "Read this task and propose a tighter scope if that would improve the outcome. Explain why before I confirm anything."],
      ] as const;
  return html`<div class="chat-prompts" aria-label="suggested questions">${prompts.map(([label, message]) =>
    postForm("/chat", html`<button type="submit" name="message" value="${message}" class="quiet">${label}</button>`, { attrs: { class: "inline" }, hidden: { task: focus?.id } }),
  )}</div>`;
}

export function chatHeading(copy: string, projectCount: number, showProjectToggle = true): Html {
  return html`<div class="chat-head"><div><h1>Chat</h1>${copy === "" ? "" : html`<p class="meta">${copy}</p>`}</div><div class="chat-head-actions">${
    showProjectToggle
      ? html`<button type="button" class="chat-project-toggle quiet" aria-controls="chat-project-panel" aria-expanded="false" title="show or hide projects">${strokeIcon(html`<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>`)}<span>projects</span><span class="badge">${projectCount}</span></button>`
      : ""}</div></div>`;
}

/** A deliberately small rich-text grammar for model copy. The reply is shaped first (the lead's voice, enforced:
 * no headers, at most three bold anchors, labelled links, no internal ids unless `asked` wanted them); input is
 * escaped before tags are introduced: bullets, numbered steps, bold, inline code and labelled http(s) links are
 * presentation only—never executable HTML. */
export function renderChatText(raw: string, asked?: string): Html {
  const inline = replyHtmlInline;
  const text = shapeReply(raw, { appOrigin: requestContext.getStore()?.appOrigins ?? null, ...(asked === undefined ? {} : { asked }) });
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Html[] = [];
  let paragraph: string[] = [];
  type List = { tag: "ul" | "ol"; items: Html[] };
  let list = null as List | null;
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(html`<p>${joinHtml(paragraph.map(line => inline(line)), html`<br>`)}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (list === null) return;
    out.push(list.tag === "ul" ? html`<ul>${list.items}</ul>` : html`<ol>${list.items}</ol>`);
    list = null;
  };
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*(\d{1,9})[.)]\s+(.+)$/.exec(line);
    if (bullet !== null || numbered !== null) {
      flushParagraph();
      const wanted = bullet !== null ? "ul" : "ol";
      if ((list as List | null)?.tag !== wanted) { closeList(); list = { tag: wanted, items: [] }; }
      // Model replies often separate steps with blank lines. Each remains
      // its stated number even when that blank line starts another <ol>.
      list!.items.push(html`<li${numbered === null ? "" : html` value="${Number(numbered[1])}"`}>${inline(bullet?.[1] ?? numbered?.[2] ?? "")}</li>`);
    } else if (line.trim() === "") {
      flushParagraph(); closeList();
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  flushParagraph(); closeList();
  return html`<div class="chat-copy">${out}</div>`;
}

export function chatActivity(activity: string | null): Html {
  return chatActivityDetailsHtml(activity);
}

export const CHAT_UI_SCRIPT =
  `(function(){var workspace=document.querySelector(".chat-workspace"),projectPanel=document.getElementById("chat-project-panel"),projectToggle=document.querySelector(".chat-project-toggle"),projectClose=document.querySelector(".chat-project-close");` +
  `var fleet=document.querySelector(".chat-fleet-context");if(fleet&&!document.querySelector(".chat-empty")){var desktop=window.matchMedia("(min-width: 761px)");fleet.open=desktop.matches;desktop.addEventListener("change",function(){fleet.open=desktop.matches;});}` +
  `if(workspace&&projectPanel&&projectToggle){var wide=window.matchMedia("(min-width: 1200px)");var saved="";try{saved=localStorage.getItem("standing-orders:chat-projects")||"";}catch(e){}` +
  `var background=[];function restoreBackground(){background.forEach(function(n){n.inert=false;});background=[];}` +
  `function apply(open){var was=workspace.classList.contains("projects-open");restoreBackground();workspace.classList.toggle("projects-open",open);workspace.classList.toggle("projects-hidden",!open);projectToggle.setAttribute("aria-expanded",String(open));` +
  `if(open&&!wide.matches){projectPanel.setAttribute("role","dialog");projectPanel.setAttribute("aria-modal","true");projectPanel.setAttribute("aria-label","Projects");` +
  `document.querySelectorAll(".side,.mobile-top,.tabbar,.chat-main,.task-chat-context,.task-chat-agents").forEach(function(n){if(!n.contains(projectPanel)&&!n.inert){n.inert=true;background.push(n);}});if(projectClose)projectClose.focus();}` +
  `else{projectPanel.removeAttribute("role");projectPanel.removeAttribute("aria-modal");projectPanel.removeAttribute("aria-label");if(was&&!open)projectToggle.focus();}}` +
  `projectPanel.addEventListener("keydown",function(ev){if(ev.key!=="Tab"||wide.matches)return;var nodes=Array.from(projectPanel.querySelectorAll("a[href],button,input,select,textarea,summary,[tabindex='0']")).filter(function(n){return !n.disabled&&n.getClientRects().length;});var first=nodes[0],last=nodes[nodes.length-1];if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus();}else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus();}});` +
  `function preferred(){return wide.matches&&saved==="open";}apply(preferred());` +
  `projectToggle.addEventListener("click",function(){var next=!workspace.classList.contains("projects-open");apply(next);if(wide.matches){saved=next?"open":"closed";try{localStorage.setItem("standing-orders:chat-projects",saved);}catch(e){}}});` +
  `if(projectClose)projectClose.addEventListener("click",function(){apply(false);projectToggle.focus();});` +
  `document.addEventListener("click",function(ev){if(wide.matches||!workspace.classList.contains("projects-open"))return;var target=ev.target;if(target instanceof Node&&!projectPanel.contains(target)&&!projectToggle.contains(target))apply(false);});` +
  `wide.addEventListener("change",function(){apply(preferred());});document.addEventListener("keydown",function(ev){if(ev.key==="Escape"&&workspace.classList.contains("projects-open")){apply(false);projectToggle.focus();}});}` +
  `var taskLive=document.querySelector(".composer[data-chat-session]")?null:document.getElementById("task-chat-live");` +
  `function taskEditing(){return taskLive.contains(document.activeElement)||taskLive.querySelector("details[open]")||Array.from(taskLive.querySelectorAll("input:not([type=hidden]),textarea,select")).some(function(el){return el.tagName==="SELECT"?Array.from(el.options).some(function(o){return o.selected!==o.defaultSelected;}):el.type==="checkbox"||el.type==="radio"?el.checked!==el.defaultChecked:el.value!==el.defaultValue;});}` +
  `function refreshTask(){if(!taskLive||taskLive.getAttribute("data-poll")!=="1")return;` +
  `if(document.hidden||taskEditing()){setTimeout(refreshTask,5000);return;}var source=taskLive.getAttribute("data-source");if(!source)return;` +
  `fetch(source,{cache:"no-store",signal:AbortSignal.timeout(10000)}).then(function(r){if(r.status===401||r.status===403||r.redirected){location.href="/login";return null;}if(!r.ok)throw new Error("connection");return r.text();})` +
  `.then(function(html){if(html===null||!taskLive)return;var parsed=new DOMParser().parseFromString(html,"text/html"),next=parsed.getElementById("task-chat-live");if(!next)throw new Error("response");if(taskEditing()){setTimeout(refreshTask,5000);return;}taskLive.replaceWith(next);taskLive=next;` +
  `if(taskLive.getAttribute("data-poll")==="1")setTimeout(refreshTask,5000);}).catch(function(){setTimeout(refreshTask,10000);});}` +
  `if(taskLive&&taskLive.getAttribute("data-poll")==="1")setTimeout(refreshTask,5000);` +
  `var box=document.querySelector(".composer textarea");if(box){` +
  `function size(){box.style.height="auto";box.style.height=Math.min(box.scrollHeight,208)+"px";}size();box.addEventListener("input",size);` +
  `box.addEventListener("keydown",function(ev){if(ev.isComposing||ev.key!=="Enter"||ev.shiftKey||!window.matchMedia("(min-width: 761px)").matches)return;ev.preventDefault();if(box.value.trim()!=="")box.form.requestSubmit();});}})();`;

/** Provider, model, and limits under ONE disclosure (UI polish
 * 2026-09-13): the facts stay one tap away on every chat surface, and a
 * membership never shows a dollar figure as if it were a charge. */
export function chatLimitsHtml(facts: {
  provider: string; model: string; turnsToday: number; dailyTurns: number; subscription: boolean;
  weekly: { spent: number; ceiling: number } | null;
}): Html {
  const rows: Html[] = [
    html`<span class="mono">${facts.provider} · ${facts.model}</span>`,
    html`<span>${facts.turnsToday} / ${facts.dailyTurns} turns today</span>`,
  ];
  if (facts.subscription) rows.push(html`<span>membership login · no dollar ceiling</span>`);
  else if (facts.weekly !== null) rows.push(html`<span>this week ${chatMoney(facts.weekly.spent)} of ${chatMoney(facts.weekly.ceiling)}</span>`);
  return html`<details class="chat-limits"><summary>Model &amp; limits<span class="meta">${facts.subscription ? "membership" : facts.provider}</span></summary><div class="chat-budget">${rows}</div></details>`;
}

export function chatPage(chrome: Chrome, data: {
  enabled: { ok: true } & Record<string, unknown> | { ok: false; why: string };
  pending: ChatTurn | null;
  latched: ChatTurn[];
  chat: { candidates: Map<string, { key: string; draft: ChatDraft; repoPath: string }>; lastTurn: { id: number; reply: string | null; staticError: string | null; proposalsDiscarded: boolean } | null } | null;
  recent: ChatTurn[];
  turnsToday: number;
  weeklySpent: number;
  projects: ChatProjectPulse[];
  fleetSnapshot: AssignmentChatSnapshot | null;
  catchUp?: Html;
  /** Optional task lens into the same unified conversation. */
  focusTask: TaskChatFocus | null;
  canManage: boolean;
  config: import("../store.js").ChatConfig | null;
  /** Where each provider's key comes from — never the key itself. */
  keyFacts: { provider: string; state: "environment" | "stored" | "none"; tail: string | null }[];
  /** OpenRouter's live catalog when the key is present and reachable. */
  openrouterModels: string[] | null;
  /** Claude and Codex models from the saved live catalog, labelled with prices. */
  liveModels?: { value: string; label: string }[];
  csrf: string;
  problem: string | null;
  /** The card that mints a mate session (mate arc §5), approvers only. */
  mateMint?: Html;
  /** Pending coordinator proposals as cards (mate arc v3), approvers only. */
  coordinatorProposals?: Html;
  /** The task's result detail (package 3), when the URL opened one. */
  resultPanel?: Html | null;
  /** Opened from "Chat settings": show them expanded. */
  settingsOpen?: boolean;
  /** Chat's first run is on the page: it already says what to do while there is no lead. */
  firstRunShown?: boolean;
}): Screen {
  const formFacts: LeadFormFacts = { keyFacts: data.keyFacts, openrouterModels: data.openrouterModels, ...(data.liveModels === undefined ? {} : { liveModels: data.liveModels }), csrf: data.csrf,
    returnTo: data.focusTask === null ? "/chat" : taskChatHref(data.focusTask.id) };
  const parts: HtmlValue[] = [
    data.focusTask === null
      ? chatHeading("", data.projects.length, data.enabled.ok)
      : taskChatHeading(data.focusTask),
    data.focusTask === null ? (data.catchUp ?? "") : taskChatLiveRegion(data.focusTask, data.csrf, false, data.pending !== null),
  ];
  if (data.problem !== null) parts.push(html`<div class="problem">${data.problem}</div>`);
  if (!data.enabled.ok) {
    const code = (data.enabled as { code?: string }).code;
    // The sandbox shows no conversation at all: chat evidence is a real
    // subscription-backed plane, never a seeded transcript (v48 authority repair).
    // With no lead yet, the first run says what happens next (it turns on with the signed-in agent, or shows the one
    // command to run); otherwise one line, and its settings live in Settings → Lead (onboarding).
    const settingsLink = data.canManage ? html` <a href="/settings/lead">Settings → Lead</a>` : "";
    if (!(code === "unconfigured" && data.firstRunShown === true)) parts.push(
      code === "demo"
        ? html`<div class="card" id="latest"><p><strong>Chat isn’t available in demo mode</strong></p><p class="meta">Demo data never contacts an external model. Start Toolroll with a real project to use chat: <code>${START_COMMAND}</code> in your repository.</p></div>`
        : code === "unconfigured"
          ? html`<div class="card" id="latest" data-lead-off><p><strong>The lead is off.</strong></p><p class="meta">${data.canManage ? html`Turn it on in${settingsLink}.` : "An approver can turn it on."}</p></div>`
          : code === "unpriced" || code === "no-key"
            ? html`<div class="card" id="latest"><p><strong>The lead can’t run yet.</strong></p><p class="meta">${data.enabled.why}${data.canManage ? html` ·${settingsLink}` : ""}</p></div>`
            : html`<div class="card" id="latest"><p><strong>Chat is off.</strong></p><p class="meta">${data.enabled.why}</p></div>`,
    );
    return screen("chat", chatWorkspace(joinHtml(parts, "\n"), data.projects, true, data.focusTask, data.resultPanel ?? null), { chrome, functional: { script: CHAT_UI_SCRIPT + (data.focusTask === null ? "" : RESULT_REVIEW_SCRIPT), fetches: data.focusTask !== null } });
  }
  const config = (data.enabled as unknown as { config: { provider: ChatProviderId; model: string; dailyTurns: number; weeklyCeilingMicrousd: number } }).config;
  const subscription = isSubscriptionChatProvider(config.provider);
  // The saved catch-up owns orientation. Keep the older overview only as
  // a fallback; provider and spend terms remain available before consent.
  if (!data.canManage) {
    parts.push(html`<div class="card chat-readonly"><strong>Read-only view</strong><p class="meta">An approver can start the unified conversation and confirm its proposed actions. You can still open every live card and project board here.</p></div>`);
  }
  if (data.canManage && data.mateMint !== undefined) parts.push(data.mateMint);
  if (data.canManage && data.coordinatorProposals !== undefined) parts.push(data.coordinatorProposals);
  parts.push(
    data.focusTask === null && !data.catchUp ? html`<details class="chat-fleet-context">${chatOverviewSummaryHtml(data.projects, data.fleetSnapshot?.attentionCount)}${chatFleetOverview(data.fleetSnapshot, data.projects, false)}</details>` : "",
    chatLimitsHtml({ provider: config.provider, model: config.model, turnsToday: data.turnsToday, dailyTurns: config.dailyTurns, subscription, weekly: subscription ? null : { spent: data.weeklySpent, ceiling: config.weeklyCeilingMicrousd } }),
  );
  for (const turn of data.latched) {
    parts.push(
      html`<div class="problem"><strong>Chat is paused.</strong> An earlier reply stopped before its cost was known; it may have cost up to ${chatMoney(turn.reservedMicrousd)}. <a href="/chat/ack/${turn.id}">Confirm that cost</a> to turn chat back on.</div>`,
    );
  }
  if (data.pending !== null) {
    parts.push(chatWorkingHtml({details:`Turn #${data.pending.id}${subscription ? " · subscription" : ` · up to ${chatMoney(data.pending.reservedMicrousd)} reserved`}`}));
    parts.push(html`<p class="meta"><a href="/chat">refresh now</a></p>`);
    return screen("chat", chatWorkspace(joinHtml(parts, "\n"), data.projects, true, data.focusTask, data.resultPanel ?? null), { chrome, functional: { script: CHAT_UI_SCRIPT + (data.focusTask === null ? "" : RESULT_REVIEW_SCRIPT), fetches: data.focusTask !== null }, refreshSeconds: 3 });
  }
  const last = data.chat?.lastTurn ?? null;
  if (last !== null) {
    if (last.staticError !== null) {
      parts.push(html`<div class="card" id="latest"><p class="meta">${last.staticError}</p></div>`);
    } else if (last.reply !== null) {
      parts.push(html`<div class="card" id="latest">${renderChatText(last.reply)}${
        last.proposalsDiscarded ? html`<p class="meta">A draft block in this answer was malformed and was discarded whole</p>` : ""}</div>`);
    }
  }
  const candidates = data.chat === null ? [] : [...data.chat.candidates.values()];
  for (const one of candidates) {
    const draft = one.draft;
    parts.push(
      html`<div class="card"><p><strong>${draft.title}</strong> <span class="badge">Draft ${draft.kind}</span></p><p class="meta">Drafted by the model from fleet context — nothing is filed; drafts do not survive a restart</p><p style="white-space:pre-wrap">${draft.goal}</p>${
        draft.outOfScope === null ? "" : html`<p class="meta">Not: ${draft.outOfScope}</p>`}${
        draft.touches.length > 0 ? html`<p class="meta">Touches: ${draft.touches.join(", ")}</p>` : ""}<p class="meta">Repo: <span class="mono">${projectName(one.repoPath)}</span></p>${
        postForm(`/chat/file/${one.key}`, html`<input type="password" name="token" placeholder="your password" autocomplete="current-password"><button type="submit">File unapproved</button>`, { attrs: { class: "inline" } })}</div>`,
    );
  }
  if (!subscription && data.canManage && data.focusTask === null) {
    parts.push(
      html`<h2>Ask</h2>`,
      postForm("/chat", joinHtml([
        html`<label>Message<textarea name="message" rows="3" maxlength="2000"></textarea></label>`,
        html`<label>Your password <span class="meta">(every message — chat spends)</span><input type="password" name="token" autocomplete="current-password"></label>`,
        html`<button type="submit">Ask</button>`,
      ], "\n"), { attrs: { class: "card" } }),
    );
  }
  if (data.canManage) {
    parts.push(
      html`<p class="meta" id="chat-settings"><a href="/settings/lead">Lead settings</a> · provider, model and limits</p>`,
    );
  }
  if (data.recent.length > 0) {
    parts.push(html`<details class="chat-turn-history"><summary>Conversation activity <span class="meta">${data.recent.length} recent turns</span></summary>\n${joinHtml(data.recent.map(turn =>
      html`<p class="row"><span class="mono">#${turn.id}</span> ${turn.state}${turn.failureReason === null ? "" : html` · ${turn.failureReason}`} <span class="right meta">${turn.tokensIn ?? "–"} in / ${turn.tokensOut ?? "–"} out · ${subscription ? "membership" : `${chatMoney(turn.settledMicrousd ?? turn.reservedMicrousd)}${turn.settledMicrousd === null ? " reserved" : ""}`}</span></p>`), "\n")}\n</details>`);
  }
  return screen("chat", chatWorkspace(joinHtml(parts, "\n"), data.projects, true, data.focusTask, data.resultPanel ?? null), { chrome, functional: { script: CHAT_UI_SCRIPT + (data.focusTask === null ? "" : RESULT_REVIEW_SCRIPT), fetches: data.focusTask !== null } });
}

export function chatAckPage(chrome: Chrome, turn: ChatTurn, nonce: string): Screen {
  return screen("chat", joinHtml([
    html`<h1>Unknown spend</h1>`,
    html`<div class="card">`,
    html`<p>Turn <span class="mono">#${turn.id}</span> on <span class="mono">${turn.provider} · ${turn.model}</span> may have started before it failed (${turn.failureReason ?? "crashed"}), and its cost could not be measured.</p>`,
    html`<p><strong>Acknowledging charges the reserved worst case, ${chatMoney(turn.reservedMicrousd)}, to the ledger and re-enables chat on this credential.</strong></p>`,
    html`<p class="meta">Check the provider's own usage dashboard if you want the exact figure first; the ledger keeps whichever is known.</p>`,
    postForm(`/chat/ack/${turn.id}`, joinHtml([
      html`<label>Your password<input type="password" name="token" autocomplete="current-password"></label>`,
      html`<button type="submit">Accept the charge — re-enable chat</button>`,
    ], "\n"), { hidden: { nonce } }),
    html`</div>`,
  ], "\n"), { chrome });
}

/** The card that starts a conversation: the one password ceremony (mate arc §1). */
export function mateMintCard(
  enabled: { billing: "metered" | "subscription"; config: { provider: ChatProviderId; weeklyCeilingMicrousd: number } },
  returnTo = "/chat",
): Html {
  const subscription = enabled.billing === "subscription";
  return html`<div class="card mate-mint" id="latest">\n<p><strong>Start a conversation</strong></p>\n${postForm("/chat/mate/mint", joinHtml([
    html`<div class="mate-terms">`,
    subscription
      ? html`<span class="meta">Uses your ${enabled.config.provider === "codex-subscription" ? "Codex" : "Anthropic"} membership · no dollar limit · daily turn limits apply</span>`
      : html`<label>Spend up to <span class="inline-field">$<input type="text" name="ceiling-usd" inputmode="decimal" value="5" style="width:5rem"></span> <span class="meta">(weekly chat ceiling ${chatMoney(enabled.config.weeklyCeilingMicrousd)} still applies)</span></label>`,
    html`</div>`,
    html`<label class="arm"><input type="checkbox" name="follow" value="yes"> Let the lead follow crew updates</label>`,
    html`<button type="submit">Start chat</button>`,
  ], "\n"), { returnTo })}\n</div>`;
}

/** The decisions the cards on a page name, for the answer card's consequences and the builder's recommendation. */
export function decisionsFor(store: Store, proposals: readonly { kind: string; payload: Record<string, unknown> }[]): Map<number, Decision> {
  const out = new Map<number, Decision>();
  for (const one of proposals) {
    if (one.kind !== "answer" || typeof one.payload["decision"] !== "number") continue;
    const decision = store.getDecision(one.payload["decision"]);
    if (decision !== null) out.set(decision.id, decision);
  }
  return out;
}

export type ProposalCardView = {
  id: number;
  kind: MateProposal["kind"];
  payload: Record<string, unknown>;
  state: string;
  outcome: Record<string, unknown> | null;
  /** Who proposed: the mate, or a coordinator by name. */
  by: { mate: true } | { mate: false; name: string; ago: string };
  /** Where confirm/dismiss post: `/chat/proposal` for the mate's, `/proposals` for a coordinator's. */
  actionBase: string;
};

/**
 * A proposal card: what, then confirm/dismiss, or the door's answer. An
 * `answer` card shows the question, every option WITH its consequence,
 * the builder's recommendation beside the proposer's pick, and — for an
 * irreversible option — the explicit confirmation field the decision
 * page itself uses (ruling 12).
 */
export function proposalCard(view: ProposalCardView, inert: boolean, decision: Decision | null, returnTo: string | null = null): Html {
  return proposalCardParts(view, inert, decision, returnTo).html;
}

/** The card's HTML and, for the chat's confirm-in-place cards, the same
 * card as data: the body is the HTML's own, the act is the same door. */
export function proposalCardParts(view: ProposalCardView, inert: boolean, decision: Decision | null, returnTo: string | null = null): { html: Html; card: BrowserActionCard } {
  const payload = view.payload;
  const text = (key: string): string => (typeof payload[key] === "string" ? (payload[key] as string) : "");
  const task = text("task");
  const repoId = text("repoId");
  const presentations: Record<MateProposal["kind"], { label: string; action: string; icon: Html }> = {
    task: { label: payload["report"] === true ? "Scout investigation" : "New task", action: "file task", icon: html`<path d="M12 5v14"/><path d="M5 12h14"/>` },
    next: { label: "Queue priority", action: "move to front", icon: html`<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>` },
    reserve: { label: "Worker assignment", action: payload["worker"] === null ? "release" : "reserve", icon: html`<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>` },
    hold: { label: "Pause work", action: "hold", icon: html`<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>` },
    unhold: { label: "Resume work", action: "release hold", icon: html`<path d="m7 4 13 8-13 8z"/>` },
    steer: { label: "Guidance for next attempt", action: "add guidance", icon: html`<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>` },
    scope: { label: "Scope revision", action: "save scope", icon: html`<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>` },
    answer: { label: "Decision answer", action: "confirm answer", icon: html`<path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4"/><path d="M12 18h.01"/><circle cx="12" cy="12" r="9"/>` },
    cancel: { label: "Cancel task", action: "open task", icon: html`<path d="m15 9-6 6"/><path d="m9 9 6 6"/><circle cx="12" cy="12" r="9"/>` },
    repair: {
      label: "Task is waiting",
      action: text("operation") === "retry" ? "try again" : text("operation") === "replace" ? "wait for another task" : "continue without it",
      icon: html`<path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-3-3z"/>`,
    },
    agents: { label: "Agents change", action: "change agents", icon: html`<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="m4.9 4.9 2.2 2.2"/><path d="m16.9 16.9 2.2 2.2"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="m4.9 19.1 2.2-2.2"/><path d="m16.9 7.1 2.2-2.2"/>` },
    review: { label: text("operation") === "revise" ? "Changes to make" : "Note for later", action: text("operation") === "revise" ? "Request changes" : "Save for later", icon: html`<path d="M4 5h16v12H8l-4 3z"/>` },
    control: { label: "Open control", action: "Open", icon: html`<path d="M5 12h14m-6-6 6 6-6 6"/>` },
    action: { label: text("title") || "Review action", action: sharedActionPayload(payload) ? CHAT_ACTIONS[sharedActionPayload(payload)!.operation].label : "Unavailable", icon: html`<path d="M5 12h14m-6-6 6 6-6 6"/>` },
    task_action: { label: payload["operation"] === "stop" ? "Stop task?" : payload["operation"] === "resume" ? "Resume task?" : "Task update", action: isChatTaskAction(payload["operation"]) ? CHAT_TASK_ACTIONS[payload["operation"]].label : "Unavailable", icon: html`<path d="M5 12h14m-6-6 6 6-6 6"/>` },
  };
  const presentation = presentations[view.kind];
  const facts = (...rows: [string, HtmlValue][]): Html => {
    const visible = rows.filter(([, value]) => value !== "" && !(isHtml(value) && htmlString(value) === ""));
    return visible.length === 0 ? html`` : html`<dl class="proposal-facts">${visible.map(([key, value]) => html`<div><dt>${key}</dt><dd>${value}</dd></div>`)}</dl>`;
  };
  const mono = (value: string): Html => html`<span class="mono">${value}</span>`;
  const monoLines = (value: unknown): Html | "" => Array.isArray(value) ? joinHtml((value as string[]).map(mono), html`<br>`) : "";
  let what: Html;
  if (view.kind === "task") {
    const planning = text("planning") || "auto";
    const planningWords = payload["report"] === true
      ? "not needed — this is an investigation"
      : planning === "required"
        ? "inspect the project and draft a plan first"
        : planning === "skip"
          ? "start from this proposed scope"
          : "inspect first when the work needs repository context";
    what = html`<h3>${text("title")}</h3><p class="proposal-summary">${text("goal")}</p>${
      facts(
        ["project", mono(repoId)],
        ["deliverable", payload["report"] === true ? "report only" : "branch"],
        ["planning", planningWords],
        ["checks", isCheckLevel(payload["checks"]) ? { quick: "Quick checks", full: "Full checks", off: "Off — built, not checked" }[payload["checks"]] : ""],
        ["out of scope", text("not")],
        ["may touch", monoLines(payload["touches"])],
      )}`;
  } else if (view.kind === "action") {
    const action=sharedActionPayload(payload);
    what=action===null?html`<p>This action is unavailable.</p>`:(sharedActionNeedsReview(action)?html``:html`${action.terms.map(term=>html`<p style="white-space:pre-wrap;overflow-wrap:anywhere">${term}</p>`)}`);
  } else if (view.kind === "task_action") {
    const operation = payload["operation"];
    what = html`<h3>${text("taskTitle") || task}</h3>${
      operation === "stop" || operation === "resume" ? html`<p class="meta">${task} · Run #${String(payload["run"] ?? "?")}</p>` : ""}<p>${isChatTaskAction(operation) ? CHAT_TASK_ACTIONS[operation].detail : "Action unavailable."}</p>${
      text("dependency") === "" ? "" : html`<p>${text("dependencyTitle")}</p>`}`;
  } else if (view.kind === "control") {
    const control = payload["control"];
    const label = isChatControl(control) ? CHAT_CONTROLS[control].label : "Control unavailable";
    // Navigation does not wait for approval. Give it a destination and one
    // link, not a proposal header that falsely reads as unfinished work.
    if (isChatControl(control) && view.state === "pending" && !inert) {
      const title = text("taskTitle");
      const href = chatControlHref(control, task, payload["run"], payload["project"]);
      return {
        html: html`<article class="card proposal proposal-control" data-card-kind="control">${
          title === "" ? "" : html`<div class="proposal-body"><h3>${title}</h3></div>`}<footer class="proposal-actions"><a class="button-link" href="${href}" aria-label="${title === "" ? label : `${label}: ${title}`}">${label}</a></footer></article>`,
        card: { id: view.id, kind: view.kind, label: title === "" ? label : title, state: "pending", body: "", said: null, links: [], primary: { kind: "link", label, href }, dismissable: false, note: null },
      };
    }
    what = html`<h3>${label}</h3>${text("taskTitle") === "" ? "" : html`<p>${text("taskTitle")}</p>`}`;
  } else if (view.kind === "review") {
    const snapshot = payload["snapshot"] as import("../chat-review.js").ReviewSnapshot | undefined;
    const ids = Array.isArray(payload["notes"]) ? payload["notes"] as number[] : [];
    const selected = snapshot?.notes.filter(one => ids.includes(one.id)) ?? [];
    const notes = [...selected, ...(text("note") === "" ? [] : [{ note: text("note"), path: text("path") || null, line: typeof payload["line"] === "number" ? payload["line"] : null }])];
    what = html`<h3>${text("taskTitle") || task}</h3><ul class="proposal-review-notes">${
      notes.map(one => html`<li>${one.path === null ? "" : html`<span class="mono">${one.path}${one.line === null ? "" : html`:${one.line}`}</span> · `}${one.note}</li>`)}</ul>${
      text("operation") === "revise" ? html`<p class="meta">Updates this task. Your approval settings apply.</p>` : html`<p class="meta">No work starts.</p>`}`;
  } else if (view.kind === "next") {
    what = html`<h3>Move <a href="${taskHref(task)}">${task}</a> to the front</h3>${facts(["current position", html`${String(payload["position"] ?? "?")} of ${String(payload["of"] ?? "?")}`], ["project", mono(repoId)])}`;
  } else if (view.kind === "reserve") {
    what = html`<h3>${payload["worker"] === null ? "Release" : "Reserve"} <a href="${taskHref(task)}">${task}</a></h3>${facts(["destination", payload["worker"] === null ? "shared queue" : text("worker")], ["project", mono(repoId)])}`;
  } else if (view.kind === "hold") {
    what = html`<h3>Hold <a href="${taskHref(task)}">${task}</a></h3><p class="proposal-summary">${text("reason")}</p>${facts(["project", mono(repoId)])}`;
  } else if (view.kind === "unhold") {
    what = html`<h3>Release <a href="${taskHref(task)}">${task}</a> from its hold</h3>${facts(["project", mono(repoId)])}`;
  } else if (view.kind === "steer") {
    const taskTitle = text("taskTitle") || task;
    what = html`<h3>Guide <a href="${taskHref(task)}">${taskTitle}</a>'s next attempt</h3><p class="proposal-summary">${text("note")}</p>${
      facts(["when", "next attempt"], ["project", mono(repoId)])}<p class="meta proposal-disclosure">This guides the next attempt without changing the task’s scope. It does not interrupt work already running.</p>`;
  } else if (view.kind === "agents") {
    // The agents card (v48): exactly what changes, in the same words the
    // task page uses — the role, the exact agent, the size — and the
    // consequence for the standing approval.
    const taskTitle = text("taskTitle") || task;
    const role = text("role");
    const clear = payload["clear"] === true;
    const agentWords = text("provider") === "" ? "" : `${text("provider")} · ${text("model")}`;
    const size = text("size");
    const sizeLine = size === "" ? "" : `${size}${payload["risky"] === true ? ", risky" : ""} change`;
    const taskLink = html`<a href="${taskHref(task)}">${taskTitle}</a>`;
    const heading = role !== "" && !clear
      ? html`Run ${taskLink}'s ${role} on ${mono(agentWords)}`
      : role !== "" && clear
        ? html`Let the recommended ${role} stand for ${taskLink}`
        : size !== ""
          ? html`Treat ${taskLink} as a ${sizeLine}`
          : html`Change the agents for ${taskLink}`;
    what = html`<h3>${heading}</h3>${
      text("why") === "" ? "" : html`<p class="proposal-summary">${text("why")}</p>`}${
      facts(
        ["agents now", text("before")],
        ["size", size === "" ? "" : sizeConsequence(size, payload["risky"] === true)],
        ["role", role === "" ? "" : html`${role} → ${clear ? "the recommendation" : mono(agentWords)}`],
        ["project", mono(repoId)],
      )}<p class="meta proposal-disclosure">Recorded under your name when you confirm. ${text("approval") === "approved" ? "The current approval no longer covers the task afterwards — approve it again on the task." : "The next approval seals these agents."}</p>`;
  } else if (view.kind === "scope") {
    what = html`<h3>Rewrite <a href="${taskHref(task)}">${task}</a></h3><p class="proposal-summary">${text("goal")}</p>${
      // One path per line (UI polish 2026-09-13): a comma run broke mid-token on a phone.
      facts(["out of scope", text("not")], ["may touch", monoLines(payload["touches"])], ["project", mono(repoId)])}`;
  } else if (view.kind === "repair") {
    const blocker = text("blocker");
    const operation = text("operation");
    const replacement = text("replacement");
    const taskTitle = text("taskTitle") || task;
    const blockerTitle = text("blockerTitle") || blocker;
    const replacementTitle = text("replacementTitle") || replacement;
    const taskLink = html`<a href="${taskHref(task)}">${taskTitle}</a>`;
    const blockerLink = html`<a href="${taskHref(blocker)}">${blockerTitle}</a>`;
    const replacementLink = replacement === "" ? "" : html`<a href="${taskHref(replacement)}">${replacementTitle}</a>`;
    const heading =
      operation === "retry"
        ? html`Try ${blockerLink} again`
        : operation === "replace"
          ? html`Have ${taskLink} wait for different work`
          : html`Let ${taskLink} continue without ${blockerLink}`;
    const consequence =
      operation === "retry"
        ? `${taskTitle} will keep waiting while ${blockerTitle} gets another attempt.`
        : operation === "replace"
          ? `${taskTitle} will wait for ${replacementTitle} instead.`
          : `${taskTitle} may be ready to run once it no longer waits for ${blockerTitle}.`;
    what = html`<h3>${heading}</h3><p class="proposal-summary">${consequence}</p>${
      facts(
        ["task that is waiting", taskLink],
        ["work it needed", html`${blockerLink} · ${text("sawBlockerState")}`],
        ["wait for instead", replacementLink],
        ["project", mono(repoId)],
      )}`;
  } else if (view.kind === "answer") {
    const decisionId = typeof payload["decision"] === "number" ? payload["decision"] : 0;
    const pick = text("option");
    const options =
      decision === null
        ? html`<p class="meta">The decision is gone</p>`
        : html`<ul class="answer-options">${decision.options.map(one =>
            html`<li${one.id === pick ? html` class="picked"` : ""}><strong>${one.label}</strong>${one.reversible ? "" : html` <span class="badge">Irreversible</span>`}${
              one.id === decision.recommendation ? html` <span class="meta">— the builder recommends this</span>` : ""}${
              one.id === pick ? html` <span class="meta">— proposed</span>` : ""}<p class="meta">${one.consequence}</p></li>`)}</ul>`;
    what = html`<h3>Answer <a href="/d/${decisionId}">decision #${decisionId}</a> on <a href="${taskHref(task)}">${task}</a></h3>${
      decision === null ? "" : html`<p class="proposal-summary">${decision.question}</p>`}${
      options}<div class="proposal-rationale"><span class="eyebrow">proposed answer</span><strong>${text("optionLabel")}</strong><p>${text("rationale")}</p></div><p class="meta proposal-disclosure">${payload["readConsequences"] === true ? `${view.by.mate ? "The mate" : "The coordinator"} read every consequence but not the builder's recommendation` : `${view.by.mate ? "The mate" : "The coordinator"} did not read the consequences`}. You see both here${decision !== null && decision.state !== "open" ? " · this decision is no longer open" : ""}.</p>`;
  } else {
    what = html`<h3>Cancel <a href="${taskHref(task)}">${task}</a></h3><p class="proposal-summary">${text("reason")}</p>${facts(["project", mono(repoId)])}`;
  }
  const outcome = view.outcome as { said?: unknown; taskId?: unknown; href?: unknown } | null;
  const said = outcome !== null && typeof outcome.said === "string" ? outcome.said : null;
  const flowHref = view.state === "confirmed" && outcome !== null && typeof outcome.href === "string" && FLOW_HREF.test(outcome.href) ? outcome.href : null;
  const irreversible = view.kind === "answer" && payload["reversible"] === false;
  const provenance = view.by.mate ? "mate" : html`${view.by.name} · ${view.by.ago}`;
  const dismissForm = (button: Html): Html => postForm(`${view.actionBase}/${view.id}/dismiss`, button, { attrs: { class: "inline" }, returnTo });
  let acts: Html;
  if (view.state === "pending" && !inert) {
    acts =
      view.kind === "action" && sharedActionPayload(payload)!==null && sharedActionNeedsReview(sharedActionPayload(payload)!)
        ? html`<a class="button-link" href="${sharedActionReviewPath(view.id)}">Review action</a>${dismissForm(html`<button class="quiet">Dismiss</button>`)}`
        : view.kind === "control"
        ? (isChatControl(payload["control"]) ? html`<a class="button-link" href="${chatControlHref(payload["control"], task, payload["run"], payload["project"])}">${CHAT_CONTROLS[payload["control"]].label}</a>` : html`<p>Control unavailable.</p>`)
        : view.kind === "cancel"
        ? html`<p class="meta">Cancelling is armed on the task itself — <a href="${taskHref(task)}">open ${task}</a></p>${dismissForm(html`<button type="submit" class="quiet">Dismiss</button>`)}`
        : html`<div class="acts">${
          postForm(`${view.actionBase}/${view.id}/confirm`, html`${irreversible ? html`<label class="arm"><input type="checkbox" name="confirm" value="yes"> I understand this cannot be undone</label>` : ""}<button type="submit">${presentation.action}</button>`, { attrs: { class: "inline" }, returnTo })}${
          dismissForm(html`<button type="submit" class="quiet">Dismiss</button>`)}</div>`;
  } else if (view.state === "pending") {
    acts = html`<p class="meta proposal-wait">${PROPOSAL_WAIT_REASON}</p>`;
  } else if (view.state === "confirmed") {
    const filed = outcome !== null && typeof outcome.taskId === "string" ? outcome.taskId : null;
    acts = html`<p class="done">${said ?? "confirmed"}${
      (view.kind === "scope" || view.kind === "agents" || (view.kind === "review" && text("operation") === "revise")) && filed !== null
        ? html` — <a href="${taskChatHref(filed)}#task-chat-action">review & start in chat</a>`
        : ""}${
      flowHref === null ? "" : html` — <a href="${flowHref}">open the flow</a>`}</p>${
      // The created task, by its recorded id (package 2): one clear road
      // into its lens — the same conversation, focused — and the overview.
      filed !== null && view.kind === "task"
        ? html`<p class="proposal-filed"><a class="button-link" href="${taskChatHref(filed)}" data-filed-task="${filed}">Open task <span class="mono">${filed}</span> →</a> <a href="${taskHref(filed)}">overview</a></p>`
        : ""}`;
  } else if (view.state === "refused") {
    acts = html`<p class="refused">${said ?? "refused"}</p>`;
  } else {
    acts = html`<p class="meta">${view.state}</p>`;
  }
  const stateClass = view.state === "confirmed" ? "badge-done" : view.state === "refused" ? "badge-failed" : "";
  const cardHtml = html`<article class="card proposal proposal-${view.kind} ${view.state}" data-card-kind="${view.kind}"><header class="proposal-head"><span class="proposal-icon">${strokeIcon(presentation.icon)}</span><span><strong>${presentation.label}</strong><small>proposed by ${provenance}</small></span><span class="badge ${stateClass}">${sentenceCase(view.state)}</span></header><div class="proposal-body">${what}</div><footer class="proposal-actions">${acts}</footer></article>`;
  // The same card as data (chat cards): one act, in the door's own words.
  const filedTask = outcome !== null && typeof outcome.taskId === "string" ? outcome.taskId : null;
  const reviewAction = view.kind === "action" ? sharedActionPayload(payload) : null;
  const sentence = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);
  const pending = view.state === "pending" && !inert;
  const primary: BrowserActionCard["primary"] = !pending ? null
    : reviewAction !== null && sharedActionNeedsReview(reviewAction) ? { kind: "link", label: "Review action", href: sharedActionReviewPath(view.id) }
    : view.kind === "control" ? (isChatControl(payload["control"]) ? { kind: "link", label: CHAT_CONTROLS[payload["control"]].label, href: chatControlHref(payload["control"], task, payload["run"], payload["project"]) } : null)
    : view.kind === "cancel" ? { kind: "link", label: "Open task", href: taskHref(task) }
    : { kind: "confirm", label: sentence(presentation.action), irreversible, native: view.kind === "task_action" && payload["operation"] === "resume" };
  const card: BrowserActionCard = {
    id: view.id, kind: view.kind, label: presentation.label, state: view.state as BrowserActionCard["state"], body: htmlString(what),
    said: view.state === "confirmed" || view.state === "refused" ? said : null,
    links: view.state !== "confirmed" ? [] : [
      ...(filedTask === null ? [] : [{ label: view.kind === "task" ? "Open the new task" : "Open the task", href: taskHref(filedTask) }]),
      ...(flowHref === null ? [] : [{ label: "Open the flow", href: flowHref }]),
    ],
    primary,
    dismissable: pending && view.kind !== "control",
    note: view.state === "pending" && inert ? PROPOSAL_WAIT_REASON
      : pending && view.kind === "cancel" ? "Cancelling is confirmed on the task itself."
      : view.state === "dismissed" ? "Dismissed." : view.state === "expired" ? "Expired — this conversation moved on." : null,
  };
  return { html: cardHtml, card };
}

export function mateProposalCard(proposal: MateProposal, inert: boolean, decision: Decision | null, returnTo: string | null = null): Html {
  return mateProposalCardParts(proposal, inert, decision, returnTo).html;
}
export function mateProposalCardParts(proposal: MateProposal, inert: boolean, decision: Decision | null, returnTo: string | null = null): { html: Html; card: BrowserActionCard } {
  return proposalCardParts({ id: proposal.id, kind: proposal.kind, payload: proposal.payload, state: proposal.state, outcome: proposal.outcome, by: { mate: true }, actionBase: "/chat/proposal" }, inert, decision, returnTo);
}

/** Review and inline team cards share the same server-decided controls and reasons. The team API renders these
 * outside a console request, so the session's own `csrf` is given to the forms here. */
export function teamProposalCardParts(store: Store, actor: { name: string; generation: number }, proposal: MateProposal, snapshot: TeamSnapshot, csrf: string, decision: Decision | null, now: Date, provider: TeamChatProviderResolver): { html: Html; card: BrowserActionCard } {
  const gate = proposalActGate(store, actor, proposal.thread, now, provider);
  const reason = !gate.ok ? gate.said : null;
  const back = '/chat?conversation=' + encodeURIComponent(snapshot.selected!.id);
  const parts = withFormToken(csrf, () => mateProposalCardParts(proposal, reason !== null, decision, back));
  if (reason !== null && reason !== PROPOSAL_WAIT_REASON && proposal.state === 'pending') {
    parts.html = replaceMarkup(parts.html, new RegExp(htmlString(html`${PROPOSAL_WAIT_REASON}`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), () => html`${reason}`);
    parts.card = { ...parts.card, note: reason };
  }
  return parts;
}

export function coordinatorProposalCard(proposal: CoordinatorProposal, now: Date, decision: Decision | null, returnTo: string | null = null): Html {
  return proposalCard(
    { id: proposal.id, kind: proposal.kind, payload: proposal.payload, state: proposal.state, outcome: proposal.outcome, by: { mate: false, name: proposal.name, ago: relativeAge(proposal.createdAt, now) }, actionBase: "/proposals" },
    false,
    decision,
    returnTo,
  );
}

/** The section shared by /chat (both modes) and the task page: pending coordinator proposals as cards. */
export function coordinatorProposalsSection(proposals: readonly CoordinatorProposal[], decisions: Map<number, Decision>, now: Date, heading = true, returnTo: string | null = null): Html {
  if (proposals.length === 0) return html``;
  return html`${heading ? html`<h2>Proposed by coordinators <span class="meta">${proposals.length}</span></h2>` : ""}<div class="coordinator-proposals">${
    proposals.map(one => coordinatorProposalCard(one, now, decisions.get(typeof one.payload["decision"] === "number" ? one.payload["decision"] : -1) ?? null, returnTo))}</div>`;
}

/** The lead thread a change in reachable projects closed (mate arc ruling 9): its saved words and card outcomes, never continued. */
export type ReplacedThread = { messages: MateMessage[]; proposals: MateProposal[]; decisions: Map<number, Decision> };
export const REPLACED_THREAD_DIVIDER = "New conversation — the projects I can reach changed";

/** The replaced thread as the React conversation renders it: words and card outcomes, no buttons. */
export function replacedBrowserMessages(previous: ReplacedThread): import("../browser-workspace.js").BrowserMessage[] {
  return mateBrowserMessages({ ...previous, pending: null, ask: null, asks: new Map() }, null).map(message => ({
    ...message, cardsHtml: "",
    cards: (message.cards ?? []).map(card => ({ ...card, primary: null, dismissable: false })),
  }));
}

/** The replaced thread for the server-rendered page: read only, then the divider. */
export function replacedThreadHtml(previous: ReplacedThread | null | undefined): Html {
  if (previous == null) return html``;
  return html`<section class="thread chat-previous" aria-label="Earlier conversation" data-previous-thread>${
    previous.messages.map(one => one.role === "operator"
      ? html`<div class="msg op" data-previous-message="${one.id}"><p style="white-space:pre-wrap">${one.text}</p></div>`
      : html`<div class="msg mate" data-previous-message="${one.id}">${renderChatText(one.text)}</div>`)}<p class="chat-previous-divider" role="separator" data-thread-divider>${REPLACED_THREAD_DIVIDER}</p></section>`;
}

export type MateThreadRows = {
  /** The lead thread a change in reachable projects replaced; shown only. */
  previous?: ReplacedThread | null;
  messages: MateMessage[];
  proposals: MateProposal[];
  /** The decisions the answer cards name. */
  decisions: Map<number, Decision>;
  coordinatorProposals: CoordinatorProposal[];
  pending: MateTurn | null;
  recent: MateTurn[];
  /** Optional task lens into the same unified thread. */
  focusTask: TaskChatFocus | null;
  /** The lead's open question to this reader, drawn as buttons under its reply. */
  ask?: MateAsk | null;
  /** Every question the lead asked in these messages, by turn: answered ones show their words without buttons. */
  asks?: Map<number, MateAsk>;
};

/** The lead's question as buttons: each option sends itself as the next message (the same POST as a typed one);
 * "Something else" moves to the composer. Nothing shows while a reply is running. */
export function mateAskHtml(ask: MateAsk, target: { task: string | null; project: string | null }, composer: string, open = true): Html {
  if (!open) return html`<div class="so-owner-ask" data-ask="${ask.turn}"><p class="so-owner-ask-question"><strong>${ask.question}</strong></p></div>`;
  const hidden = target.task !== null ? { task: target.task } : target.project !== null ? { project: target.project } : {};
  return html`<div class="so-owner-ask" data-ask="${ask.turn}"><p class="so-owner-ask-question"><strong>${ask.question}</strong></p><div class="so-owner-ask-options" role="group" aria-label="Answer options">${
    ask.options.map(option => postForm("/chat", html`<button type="submit" name="message" value="${option}" class="so-suggestion quiet">${option}</button>`, { attrs: { class: "inline" }, hidden }))}<label for="${composer}" class="so-suggestion so-owner-ask-other">${MATE_ASK_OTHER}</label></div></div>`;
}

/** The thread's messages as the React conversation renders them, each
 * with the proposal cards its turn produced; `back` is where a card's
 * confirm or dismiss returns. */
export function mateBrowserMessages(rows: Pick<MateThreadRows, "messages" | "proposals" | "decisions" | "pending" | "ask" | "asks">, back: string | null, target: { task: string | null; project: string | null } = { task: null, project: null }): import("../browser-workspace.js").BrowserMessage[] {
  const open = rows.pending === null ? rows.ask?.turn ?? null : null;
  const asked = (turn: number | null): Html | "" => {
    const ask = turn === null ? undefined : rows.asks?.get(turn);
    return ask === undefined ? "" : mateAskHtml(ask, target, target.task === null ? "lead-message" : "task-message", ask.turn === open);
  };
  // The owner's message each reply answers: when it asked for ids, the reply keeps them.
  const askedBy = new Map<number, string>();
  rows.messages.reduce<string | undefined>((last, message) => { if (message.role === 'operator') return message.text; if (last !== undefined) askedBy.set(message.id, last); return last; }, undefined);
  return rows.messages.map(message => ({
    id: message.id, role: message.role, text: message.text,
    html: htmlString(message.role === 'operator' ? html`<p>${message.text}</p>` : html`${renderChatText(message.text, askedBy.get(message.id))}${asked(message.turn)}`),
    activity: message.activity, createdAt: message.createdAt,
    ...(() => {
      // Under the lead's message only, as the server-rendered thread does: the person's message shares the turn.
      const parts = message.turn === null || message.role === 'operator' ? [] : rows.proposals.filter(one => one.turn === message.turn)
        .map(one => mateProposalCardParts(one, rows.pending !== null, rows.decisions.get(typeof one.payload['decision'] === 'number' ? one.payload['decision'] : -1) ?? null, back));
      return { cardsHtml: htmlString(joinHtml(parts.map(one => one.html))), cards: parts.map(one => one.card) };
    })(),
  }));
}

/** The version of the DISPLAYED conversation (package 2): every fact a
 * thread or task fragment renders — message identities, card states and
 * outcomes, the live turn and its step count, the last turn's state, the
 * decisions the cards name, and the task lens's own facts — and nothing
 * that merely ticks: no relative age, no freshly minted nonce, no csrf.
 * Equal versions mean equal fragments; the poll fetches nothing else. */
export function mateChatVersion(rows: MateThreadRows): string {
  const focus = rows.focusTask;
  const facts = [
    rows.messages.map(one => [one.id, one.role, one.turn]),
    rows.previous == null ? null : rows.previous.messages.map(one => one.id),
    rows.proposals.map(one => [one.id, one.state, one.outcome === null ? null : JSON.stringify(one.outcome)]),
    rows.coordinatorProposals.map(one => [one.id, one.state, one.outcome === null ? null : JSON.stringify(one.outcome)]),
    [...rows.decisions.values()].map(one => [one.id, one.state, one.choice ?? null]),
    rows.pending === null ? null : [rows.pending.id, rows.pending.steps],
    rows.ask?.turn ?? null,
    rows.recent[0] === undefined ? null : [rows.recent[0].id, rows.recent[0].state, rows.recent[0].failureReason],
    focus === null
      ? null
      : [
          focus.id, focus.executionId, htmlString(focus.history), focus.title, focus.state, focus.scope, focus.plan, focus.claimed,
          focus.approval === null ? null : [focus.approval.digest, focus.approval.nonce === "" ? "closed" : "open", focus.approval.revision !== null && "problem" in focus.approval.revision ? focus.approval.revision.problem : null],
          focus.liveRun === null ? null : [focus.liveRun.id, focus.liveRun.phase, focus.liveRun.runner],
          focus.control,
          focus.dispatch === null ? null : [focus.dispatch.code, focus.dispatch.summary, focus.dispatch.detail],
          focus.decisions.map(one => [one.id, one.state]),
          focus.result === null ? null : [focus.result.runId, focus.result.outcome, focus.result.verdict],
          focus.publication === null ? null : [focus.publication.id, focus.publication.state, focus.publication.lastCheckState],
          focus.milestoneProgress === null ? null : focus.milestoneProgress.map(one => [one.id, one.state, one.note]),
          focus.planRevisions === null ? null : [focus.planRevisions.current?.sha256 ?? null, focus.planRevisions.current?.status ?? null, focus.planRevisions.pending?.sha256 ?? null, focus.planRevisions.pending?.status ?? null, focus.planRevisions.history.length],
          focus.route === null ? null : [focus.route.kind, focus.route.digest, focus.route.editable, focus.route.problem],
        ],
  ];
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 16);
}

/** The thread region — the one safe region the live refresh reconciles
 * (package 2): coordinator cards, the operator/assistant messages with
 * their cards, the reply-in-progress card, and the starters that follow a
 * populated thread. Every child carries a stable `data-key` so the page
 * keeps an unchanged node (its open disclosures, its focus) and replaces
 * only what the server rendered differently. The composer is never here. */
export function mateThreadHtml(data: MateThreadRows & { csrf: string; now: Date; problem: string | null; chatProject?: string | null }): Html {
  const returnTo = data.focusTask === null ? "/chat" : taskChatHref(data.focusTask.id);
  const parts: Html[] = [];
  if (data.problem !== null) parts.push(html`<div class="problem" data-key="said">${data.problem}</div>`);
  const byTurn = new Map<number, MateProposal[]>();
  for (const one of data.proposals) {
    const list = byTurn.get(one.turn) ?? [];
    list.push(one);
    byTurn.set(one.turn, list);
  }
  const inert = data.pending !== null;
  const lastMessage = data.messages.at(-1);
  const latestReply = data.pending === null && lastMessage?.role === "assistant" ? lastMessage.id : null;
  if (data.coordinatorProposals.length > 0) parts.push(html`<div data-key="coordinators" data-chat-list>${coordinatorProposalsSection(data.coordinatorProposals, data.decisions, data.now, true, data.focusTask === null ? null : returnTo)}</div>`);
  const thread: Html[] = [];
  if (data.messages.length === 0) {
    thread.push(
      html`<div class="chat-empty" data-key="empty"><strong>${data.focusTask === null ? "What do you want to get done?" : "What do you want to understand or change?"}</strong><p class="meta">${data.focusTask === null ? "Describe a task or ask about your projects." : "Ask about progress, review results, or adjust the plan."}</p></div>`,
    );
  }
  let asked: string | undefined;
  for (const message of data.messages) {
    if (message.role === "operator") {
      asked = message.text;
      thread.push(html`<div class="msg op" data-message-role="operator" data-key="m${message.id}"><p style="white-space:pre-wrap">${message.text}</p></div>`);
      continue;
    }
    const cards = message.turn === null ? [] : (byTurn.get(message.turn) ?? []);
    const ask = message.turn === null ? undefined : data.asks?.get(message.turn);
    thread.push(
      html`<div class="msg mate" data-message-role="assistant" data-key="m${message.id}"${message.id === latestReply ? html` id="latest"` : ""}>${
        renderChatText(message.text, asked)}${
        ask === undefined ? "" : mateAskHtml(ask, { task: data.focusTask?.id ?? null, project: data.chatProject ?? null }, "chat-message", data.pending === null && data.ask?.turn === ask.turn)}${
        cards.map(one => mateProposalCard(one, inert, data.decisions.get(typeof one.payload["decision"] === "number" ? one.payload["decision"] : -1) ?? null, data.focusTask === null ? null : returnTo))}<div class="chat-message-foot">${chatActivity(message.activity)}<time datetime="${message.createdAt}">${relativeAge(message.createdAt, data.now)}</time></div></div>`,
    );
  }
  parts.push(html`<div class="thread" data-key="thread" data-chat-list>\n${joinHtml(thread, "\n")}\n</div>`);
  if (data.pending !== null) {
    const subscription = data.pending.reservedMicrousd === 0;
    parts.push(chatWorkingHtml({keyed:true,
      details:`Turn #${data.pending.id} · ${data.pending.steps} step${data.pending.steps === 1 ? "" : "s"}${subscription ? " · subscription" : ` · up to ${chatMoney(data.pending.reservedMicrousd)} reserved`}`,
      stopForm: postForm("/chat/mate/stop", html`<button type="submit" class="quiet" aria-label="Stop chat response">Stop</button>`, { attrs: { class: "inline" }, returnTo, hidden: { turn: data.pending.id } }),
    }));
  }
  // Suggestions help start a conversation; repeating them after every
  // response competes with the actual result and its available actions.
  return html`<div id="chat-thread" data-chat-region="thread">${joinHtml(parts, "\n")}</div>`;
}

/** What follows the composer (package 2): the starters of an EMPTY thread
 * sit under the box; once the first message lands they move above it. */
export function mateAfterComposerHtml(data: { messages: MateMessage[]; pending: MateTurn | null; focusTask: TaskChatFocus | null }): Html {
  return html`<div id="chat-after-composer" data-chat-region="after">${data.messages.length === 0 && data.pending === null ? matePromptStarters(data.focusTask) : ""}</div>`;
}

export function matePage(chrome: Chrome, data: MateThreadRows & {
  session: MateSession;
  /** A project's own thread (v77); null for the lead conversation or a task. */
  chatProject?: string | null;
  follow?: { enabled: boolean; detail: string };
  resultRunId?: number | null;
  latched: ChatTurn[];
  config: import("../store.js").ChatConfig;
  turnsToday: number;
  weeklySpent: number;
  projects: ChatProjectPulse[];
  fleetSnapshot: AssignmentChatSnapshot | null;
  catchUp?: Html;
  csrf: string;
  problem: string | null;
  now: Date;
  /** The task's result detail (package 3), when the URL opened one. */
  resultPanel?: Html | null;
}): Screen {
  const subscription = isSubscriptionChatProvider(data.config.provider);
  const chatProject = data.focusTask === null ? data.chatProject ?? null : null;
  const returnTo = data.focusTask !== null ? taskChatHref(data.focusTask.id) : chatProject !== null ? projectChatHref(chatProject) : "/chat";
  const controlsHtml = joinHtml([
    html`<details class="lead-follow"><summary>Automatic crew updates${data.follow?.enabled ? ' · On' : ''}</summary><p class="meta">${data.follow?.detail ?? 'Automatic crew updates are off.'}</p>${
      postForm("/chat/mate/follow", html`${data.follow?.enabled ? '' : html`<p>The lead responds when results or decisions arrive. Uses this conversation’s ${subscription ? 'membership usage, with no dollar maximum' : 'remaining spend allowance'} and daily turn limit. Existing task approvals still apply.</p>`}<button type="submit" class="quiet">${data.follow?.enabled ? 'Pause updates' : 'Enable updates'}</button>`, { returnTo, hidden: { enabled: data.follow?.enabled ? 'no' : 'yes' } })}</details>`,
    html`<details class="chat-limits chat-session-details"><summary>Conversation details<span class="meta">${subscription ? "membership" : data.config.provider}</span></summary>\n${joinHtml([
      html`<div class="chat-budget"><span class="mono">${data.config.provider} · ${data.config.model}</span><span>${data.turnsToday} / ${data.config.dailyTurns} turns today</span>${
        subscription
          ? html`<span>membership login · no dollar ceiling</span>`
          : html`<span>this conversation: ${chatMoney(data.session.spentMicrousd)} of ${chatMoney(data.session.ceilingMicrousd)}</span><span>this week ${chatMoney(data.weeklySpent)} of ${chatMoney(data.config.weeklyCeilingMicrousd)}</span>`}</div>`,
      html`<p class="meta">Started ${data.session.mintedAt.slice(0, 16).replace("T", " ")}Z. It stays open until you end it; only bounded recent context is sent to the model.</p>`,
      postForm("/chat/mate/end", html`<button type="submit" class="quiet">End the conversation and forget the thread</button>`, { attrs: { class: "inline" }, returnTo }),
      data.recent.length === 0
        ? ""
        : html`<p class="meta">Recent turns: ${joinHtml(data.recent
            .map(turn => html`<span class="mono">#${turn.id}</span> ${turn.state}${turn.failureReason === null ? "" : html` · ${turn.failureReason}`} · ${subscription ? "membership" : chatMoney(turn.settledMicrousd ?? turn.reservedMicrousd)}`), " · ")}</p>`,
      html`<p class="meta"><a href="/settings/lead">Lead settings</a> · provider, model and limits</p>`,
    ], "\n")}\n</details>`,
  ], "\n");
  const conversation: HtmlValue[] = [
    data.focusTask === null
      ? chatHeading("", data.projects.length)
      : taskChatHeading(data.focusTask),
    data.focusTask === null ? (data.catchUp ?? "") : taskChatLiveRegion(data.focusTask, data.csrf, false, data.pending !== null),
    // The DB catch-up replaces the older, duplicate portfolio summary.
    data.focusTask === null && !data.catchUp ? html`<details class="chat-fleet-context">${chatOverviewSummaryHtml(data.projects, data.fleetSnapshot?.attentionCount)}${chatFleetOverview(data.fleetSnapshot, data.projects, data.pending === null)}</details>` : "",
  ];
  if (data.problem !== null) conversation.push(html`<div class="problem">${data.problem}</div>`);
  for (const turn of data.latched) {
    conversation.push(
      html`<div class="problem"><strong>Chat is paused.</strong> An earlier reply stopped before its cost was known; it may have cost up to ${chatMoney(turn.reservedMicrousd)}. <a href="/chat/ack/${turn.id}">Confirm that cost</a> to turn chat back on.</div>`,
    );
  }
  const lastMessage = data.messages.at(-1);
  const latestReply = data.pending === null && lastMessage?.role === "assistant" ? lastMessage.id : null;
  conversation.push(replacedThreadHtml(data.previous));
  conversation.push(mateThreadHtml({ ...data, problem: null, chatProject }));
  conversation.push(
    // The New update action (package 2): hidden until a live update lands
    // while the reader is above the latest message; a real button, so the
    // keyboard reaches it. Only this act moves the reader.
    html`<div class="chat-new-update-holder"><button type="button" class="chat-new-update" id="chat-new-update" hidden>New update ↓</button></div>`,
    postForm("/chat", joinHtml([
      html`<label>Message<textarea id="chat-message" name="message" rows="1" maxlength="${MATE_MESSAGE_MAX_CHARS}" placeholder="${data.focusTask !== null ? "Ask about this task…" : chatProject !== null ? `Ask about ${projectName(chatProject)}…` : "Describe what you want done…"}"></textarea></label>`,
      html`<button type="submit" aria-label="${data.pending === null ? "send message" : "wait for the current reply before sending"}"${data.pending === null ? "" : html` disabled`}>Send</button>`,
    ], "\n"), {
      attrs: { class: "card composer", id: latestReply === null && data.pending === null ? "latest" : "chat-composer", "aria-label": "message the mate", "data-chat-session": data.session.id, "data-chat-task": data.focusTask?.id ?? "", "data-chat-user": data.session.approver, "data-chat-busy": data.pending === null ? "0" : "1", "data-chat-version": mateChatVersion(data), "data-chat-approval": data.focusTask?.approval?.digest ?? "" },
      hidden: { request: randomBytes(16).toString("hex"), "request-session": data.session.id, task: data.focusTask?.id, project: chatProject, result: data.resultRunId },
    }),
    // Concise pass (2026-09-13): the status line speaks only when there is
    // a state to report — a reply in progress here, the connection from
    // the continuity script — and the composer carries no second intro.
    html`<p class="meta composer-hint" id="chat-connection" role="status" aria-live="polite">${data.pending === null ? "" : "Reply in progress. You can draft your next message or come back later."}</p>`,
    // The explicit reconnection (package 2): shown only once the session
    // or sign-in changed under this page; it reloads on the reader's act.
    html`<p class="meta composer-hint" id="chat-reconnect" hidden><button type="button" class="quiet">Reconnect</button></p>`,
    mateAfterComposerHtml(data),
    controlsHtml,

  );
  return screen(
    "chat",
    chatWorkspace(joinHtml(conversation, "\n"), data.projects, false, data.focusTask, data.resultPanel ?? null),
    { chrome, functional: { script: CHAT_CONTINUITY_SCRIPT + CHAT_UI_SCRIPT + (data.focusTask === null ? "" : RESULT_REVIEW_SCRIPT), fetches: true },
      workspace: {
        conversation: {
          sessionId: data.session.id, user: data.session.approver, version: mateChatVersion(data),
          messages: mateBrowserMessages(data, data.focusTask === null && chatProject === null ? null : returnTo, { task: data.focusTask?.id ?? null, project: chatProject }),
          pendingTurnId: data.pending?.id ?? null, requestId: randomBytes(16).toString('hex'), maxChars: MATE_MESSAGE_MAX_CHARS,
          taskId: data.focusTask?.id ?? null, resultRunId: data.resultRunId ?? null, project: chatProject,
          ...(data.previous == null ? {} : { previous: { messages: replacedBrowserMessages(data.previous) } }),
        },
        focus: data.focusTask === null ? null : { id: data.focusTask.id, title: data.focusTask.title,
          html: htmlString(taskChatLiveRegion(data.focusTask, data.csrf, requestContext.getStore()?.workspaceRead === true, data.pending !== null)) },
        result: data.resultPanel && data.resultRunId != null ? { runId: data.resultRunId, html: htmlString(data.resultPanel) } : null,
        catchUpHtml: html`${data.focusTask === null ? data.catchUp ?? '' : ''}${
          coordinatorProposalsSection(data.coordinatorProposals, data.decisions, data.now, true, data.focusTask === null ? null : returnTo)}${
          data.latched.map(turn => html`<p class="problem">Chat is paused because usage is unconfirmed. <a href="/chat/ack/${turn.id}">Inspect turn #${turn.id}</a>.</p>`)}`,
        controlsHtml,
        notices: data.problem === null ? [] : [data.problem], pageHtml: null,
      },
    },
  );
}
  /** Live replies (chat streaming): per thread, the turn being answered —
   * each step's tools in plain words and its text as it is written. Memory
   * only and display only; the saved turn stays the record. */
  export type LiveTurn = { steps: MateLiveStep[]; done: boolean; ok: boolean; listeners: Set<() => void>; expiry?: NodeJS.Timeout };

  export type ChatEnablement =
    | { ok: true; billing: "metered"; config: ChatConfig & { provider: DirectChatProviderId }; key: string; keySource: "environment" | "stored"; price: import("../converse.js").ModelPrice; credentialKey: string }
    | { ok: true; billing: "subscription"; config: ChatConfig & { provider: SubscriptionChatProviderId }; key: null; keySource: null; price: null; credentialKey: string }
    | { ok: false; code: "demo" | "unscoped" | "roots" | "unresolved" | "empty" | "unconfigured" | "unpriced" | "no-key"; why: string };
