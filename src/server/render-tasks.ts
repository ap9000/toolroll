/** Task pages: approval, agents, plans, controls, decisions and the task body. */
import { type Html,html,htmlString,joinHtml,postForm,replaceMarkup } from "../html.js";
import { type RunActivity } from "../activity-line.js";
import { type AgentChoice } from "../agentconfig.js";
import { gateWords } from "../approval-policy.js";
import { type AssignmentCard,assignmentCardOf,assignmentStatusOf,assignmentSummaryHtml } from "../assignment-ui.js";
import { type AssignmentSnapshot } from "../assignment.js";
import { holdOwnerWords } from "../board.js";
import { type BrowserTaskDetailGroup,type BrowserTaskFact,type BrowserTaskSection,type BrowserTaskThreadItem,type BrowserTaskView } from "../browser-workspace.js";
import { permissionPlainWords } from "../chat-decide.js";
import { CHAT_TASK_ACTIONS } from "../chat-task-actions.js";
import { type FormView } from "../contracts/console-api.js";
import { type DispatchDiagnosis } from "../dispatch.js";
import { type ReportView } from "../evidence.js";
import { firstTaskJourney } from "../first-run.js";
import { starterForWork } from "../flow-starters.js";
import { type Gap } from "../gaps.js";
import { readAuthModeStrict } from "../keys.js";
import { failedAttemptSentence,type FailureExplanation,retryNoteOf } from "../needs-you.js";
import { agentsSummary,chosenWords,makesNoPlan,type PhaseRoute,postureWords,projectRoute,PHASES as ROUTE_PHASES,type RouteOverride,type RouteProjection,TASK_SIZES } from "../phase-routing.js";
import { type MilestoneState,parseExecutionPlanDocument } from "../plan.js";
import { type ContractChange } from "../planner-source.js";
import { projectName } from "../project.js";
import { type CriterionMatrixRow,dispatchStatusToken,manualReviewOnly,plainReasonWords,type ProofVerdict,reviewConflict } from "../proof.js";
import { providerName } from "../provider-auth.js";
import { type Phase,PROVIDER_IDS } from "../provider.js";
import { type QualityMode,qualityModeTitle } from "../quality.js";
import { type TerminalDiffView } from "../result-evidence-readers.js";
import { evidenceShortenedWords } from "../result-review.js";
import { type AcceptanceCriterion,acceptanceToLines,approvalOf,chainFromJson,type Scope,scopeAuthorityOf,type UnattendedPermissionMode } from "../scope.js";
import { type Artifact,type CheckProgress,type CoordinatorProposal,type Decision,type ExternalMirror,type Hold,type Incident,type PlanRevisionKind,type PlanRevisionStatus,type Publication,type PublicationGrant,type RepairChainRow,type ReviewRetryState,type RevisionLineage,type Run,type SteerNote,type Store,type Task } from "../store.js";
import { runCostWords } from "../summary.js";
import { type TaskControlView } from "../task-control.js";
import { assignmentStageOf,demoChecksOf,stageOfCode,stageOfDispatch,STATUS_MORE,taskStatusOf } from "../task-status.js";
import { buildProgressOf,dispatchActionLabel,type DisplayStatus,earlierAttemptsWords,type PublicationFacts,receiptPublicationWords,resultStatusOf,REVIEW_TOKENS,type ReviewFacts,type WorkStatus,workStatusOf } from "../workspace-ui.js";
import { createHash } from "node:crypto";
import { type Chrome,isOverdue,oneLineOf,projectChip,regionScript,safePrUrl,screen,type Screen,SENSITIVE_INPUT,sentenceCase,shortDigest,transcriptScript,whenTime } from "./chrome.js";
import { reviewHref,taskChatHref,taskHref } from "./http.js";
import { coordinatorProposalsSection } from "./render-chat.js";
import { completionReceiptCard,type CompletionReceiptView,criterionMatrixHtml,type EvidenceLinkMap,evidenceWords,homePhaseWords,incidentWords,needsCheck,pullRequestCardHtml,reasonWords,receiptStatusOf,repairChainHtml,reportItemsHtml,reviewRetryPanel,runNoun,runOutcomeBadge,semanticCoverageHtml,type TaskPullRequest,terminalDiffCard,verificationExplanation,verificationRecovered } from "./render-results.js";
import { type Who } from "./session.js";

/** What the task and approval views show about a drafted plan's contract
 * (contract handoff, task 1). A problem is a named problem, never a blank. */
export type PlanContractView =
  | { run: number; problem: string }
  | {
      run: number;
      sourceDigest: string;
      /** Whether a scope was filed before planning (false: legacy road). */
      filed: boolean;
      amendment: string | null;
      changes: ContractChange[];
      changeWords: string[];
      /** The proposed terms are still exactly the scope row. */
      current: boolean;
      /** A revision: the terms before planning were copied from the previous version, not filed by a person. */
      revision?: boolean;
    };

export function contractChangeHtml(change: ContractChange): Html {
  const tag = html`<span class="contract-change-kind contract-change-${change.kind}">${change.kind}</span>`;
  switch (change.field) {
    case "goal":
      return html`<li>${tag} <strong>goal</strong><div class="contract-before">was: ${change.before}</div><div class="contract-after">now: ${change.after}</div></li>`;
    case "outOfScope":
      return html`<li>${tag} <strong>not this</strong>${change.before === null ? "" : html`<div class="contract-before">was: ${change.before}</div>`}${change.after === null ? html`<div class="contract-after">now: <em>no exclusions</em></div>` : html`<div class="contract-after">now: ${change.after}</div>`}</li>`;
    case "touches":
      return html`<li>${tag} <strong>touches</strong> <span class="mono">${change.path}</span></li>`;
    case "acceptance": {
      const criterion = (one: { statement: string; evidence: readonly string[]; how: string | null } | null): Html | "" =>
        one === null ? "" : html`${one.statement} <span class="meta">[requires: ${one.evidence.join(", ")}]</span>${one.how === null ? "" : html`<div class="meta">how: ${one.how}</div>`}`;
      return html`<li>${tag} <strong>criterion <code>${change.id}</code></strong>${change.kind === "changed" ? html` <span class="meta">(${change.moved.join(", ")})</span>` : ""}${
        change.before === null ? "" : html`<div class="contract-before">${change.kind === "removed" ? "removed: " : "was: "}${criterion(change.before)}</div>`}${
        change.after === null ? "" : html`<div class="contract-after">${change.kind === "added" ? "added: " : "now: "}${criterion(change.after)}</div>`}</li>`;
    }
  }
}

/**
 * The contract panel (contract handoff, task 1): whether the drafted plan
 * reproduced the filed goal, exclusions, touches, and rubric exactly, or
 * proposes an amendment — every addition, change, and removal listed, the
 * planner's stated reason beside them, and the plain consequence that
 * approving binds the AMENDED terms. "full" is the task page's card;
 * "ceremony" is the restatement inside the approval form and /next.
 */
export function planContractHtml(view: PlanContractView | null, mode: "full" | "ceremony"): Html {
  if (view === null) {
    return mode === "full" ? html`` : html`<p class="meta contract-note">no contract record for this draft — compare the scope above against what you filed before signing</p>`;
  }
  if ("problem" in view) {
    return html`<div class="contract-panel contract-problem"><p class="approval-label">filed contract</p><p class="meta">${view.problem} · <a href="/r/${view.run}">run ${view.run}</a></p></div>`;
  }
  const stale = view.current ? "" : html`<p class="meta">The scope was edited after this draft landed — the record below describes the draft as the planner proposed it</p>`;
  if (!view.filed) {
    return mode === "full"
      ? html`<div class="contract-panel contract-drafted"><p class="approval-label">filed contract</p><p class="meta">No scope was filed before planning — the planner drafted this contract from the title and the repository; review every term as new</p>${stale}</div>`
      : html`<p class="meta contract-note">no scope was filed before planning — every term above is the planner's proposal</p>`;
  }
  if (view.revision === true) {
    // A send-back: the terms were copied from the previous version, and the planner updated them with the notes.
    if (view.changes.length === 0) {
      return html`<div class="contract-panel contract-preserved"><p class="approval-label">updated plan</p><p><strong>Same terms as before</strong> <span class="meta">your notes fit the previous plan · <a href="/r/${view.run}">run ${view.run}</a></span></p>${stale}</div>`;
    }
    return joinHtml([
      html`<div class="contract-panel contract-amended"${mode === "full" ? html` id="contract-amendment"` : ""}><p class="approval-label">updated plan</p>`,
      html`<p><strong>${view.changes.length} change${view.changes.length === 1 ? "" : "s"} from your notes</strong> <span class="meta">— approving accepts the updated terms ${mode === "full" ? "in the scope" : "above"} · <a href="/r/${view.run}">run ${view.run}</a></span></p>`,
      view.amendment === null ? "" : html`<p class="recap contract-reason"><strong>Why:</strong> ${view.amendment}</p>`,
      html`<ul class="recap contract-changes">${view.changes.map(contractChangeHtml)}</ul>`,
      stale,
      html`</div>`,
    ]);
  }
  if (view.changes.length === 0) {
    return html`<div class="contract-panel contract-preserved"><p class="approval-label">filed contract</p><p><strong>Preserved exactly</strong> <span class="meta">the plan reproduces the filed goal, exclusions, touches, and acceptance criteria — approving binds the terms you filed · <a href="/r/${view.run}">run ${view.run}</a></span></p>${stale}</div>`;
  }
  return joinHtml([
    html`<div class="contract-panel contract-amended"${mode === "full" ? html` id="contract-amendment"` : ""}><p class="approval-label">filed contract · amendment proposed</p>`,
    html`<p><strong>${view.changes.length} change${view.changes.length === 1 ? "" : "s"} to what you filed</strong> <span class="meta">— approving binds the AMENDED terms shown ${mode === "full" ? "in the scope" : "above"}, not the ones you filed · <a href="/r/${view.run}">run ${view.run}</a></span></p>`,
    view.amendment === null
      ? html`<p class="meta">The planner stated no reason for the amendment</p>`
      : html`<p class="recap contract-reason"><strong>Why:</strong> ${view.amendment}</p>`,
    html`<ul class="recap contract-changes">${view.changes.map(contractChangeHtml)}</ul>`,
    stale,
    html`</div>`,
  ]);
}

/** The exact path limits, one per line (UI polish 2026-09-13): a long
 * comma run was the least readable term on a phone. Every path, verbatim. */
export function approvalPathsHtml(touches: readonly string[]): Html {
  if (touches.length === 0) return html`<p>anything</p>`;
  return html`<ul class="approval-paths">${touches.map(one => html`<li><span class="mono">${one}</span></li>`)}</ul>`;
}

/** The rubric, restated above the seal (v39) — the same claim the digest
 * line already makes ("approval binds to this exact wording") extended to
 * the acceptance terms: an id in Geist Mono (a machine fact the proof must
 * answer by), a statement in Geist, the signed evidence kinds after
 * it. `how` never renders here — it is advisory, never signed. Empty
 * renders nothing: a grandfathered scope's ceremony is unchanged. */
export function acceptanceCeremonyHtml(criteria: readonly AcceptanceCriterion[]): Html {
  if (criteria.length === 0) return html``;
  return html`<p class="meta">Acceptance</p><ul class="recap acceptance-rubric">${criteria.map(
    c => html`<li><code>${c.id}</code> ${c.statement} <span class="meta">[requires: ${c.evidence.join(", ")}]</span></li>`,
  )}</ul>`;
}
/** "claude" + "opus" → "Claude Opus"; "claude-opus-5-5" → "Claude Opus 5.5"; anything else keeps its exact id. */
export function agentNameWords(provider: string, model: string | null): string {
  const name = providerName(provider);
  if (model === null || model === "" || model === "default") return name;
  const bare = model.startsWith(`${provider}-`) ? model.slice(provider.length + 1) : model;
  const title = (word: string): string => `${word[0]!.toUpperCase()}${word.slice(1)}`;
  if (/^[a-z]+$/.test(bare)) return `${name} ${title(bare)}`;
  const versioned = /^([a-z]+)-(\d+(?:-\d+)*)$/.exec(bare);
  if (versioned !== null) return `${name} ${title(versioned[1]!)} ${versioned[2]!.replace(/-/g, ".")}`;
  return `${name} ${model}`;
}

/** The permission a sealed profile grants, in two or three words. */
export function permissionWordsOf(profile: Scope["profile"] | null | undefined): string | null {
  if (profile === null || profile === undefined) return null;
  return profile.provider === "claude"
    ? profile.permissionArgv === "bypassPermissions" ? "Full access" : "Auto permissions"
    : profile.provider === "gemini"
      ? profile.approvalArgv === "yolo" ? "Full access" : "Auto permissions"
      : profile.sandboxMode === "danger-full-access" ? "Full access" : "Workspace sandbox";
}

/** One plain sentence for a revision (approval critique, Oct 2):
 * "Fixes what build #9 missed: <criterion>." The notes, paths and lineage
 * stay in the Details fold. */
export function revisionSentence(revision: Extract<RevisionView, { sourceRun: number }>, acceptance: readonly AcceptanceCriterion[]): string {
  const build = `build #${revision.sourceRun}`;
  if (revision.kind === "ci-repair") return `Fixes the checks that failed in ${build}.`;
  const clean = (text: string): string => oneLineOf(text, 280).replace(/[.\s]+$/, "");
  if (revision.kind === "criterion-repair") {
    const ids = revision.comments.flatMap(one => (/Unmet: ([^.]+)\./.exec(one.note)?.[1] ?? "").split(",").map(id => id.trim()).filter(id => id !== ""));
    const missed = ids.map(id => acceptance.find(one => one.id === id)?.statement ?? null).filter((one): one is string => one !== null);
    if (missed.length > 0) return `Fixes what ${build} missed: ${missed.map(clean).join("; ")}.`;
  }
  const notes = revision.comments.map(one => clean(one.note)).filter(one => one !== "");
  return notes.length === 0 ? `Revises ${build}.` : `Fixes what ${build} missed: ${notes.join("; ")}.`;
}

/** A planner's amendment, said plainly and kept in view: approving binds
 * the amended terms, so this is never folded away. */
export function approvalAmendmentHtml(view: PlanContractView | null | undefined): Html {
  if (view === null || view === undefined || "problem" in view || !view.filed && view.revision !== true || view.changes.length === 0) return html``;
  const line = (change: ContractChange): Html => {
    switch (change.field) {
      case "goal": return html`Goal was: ${change.before}`;
      case "outOfScope": return change.after === null ? html`No longer rules anything out` : change.before === null ? html`Now rules out: ${change.after}` : html`Won't touch was: ${change.before}`;
      case "touches": return html`${change.kind === "added" ? "Adds the path" : "Drops the path"} <span class="mono">${change.path}</span>`;
      case "acceptance": return change.kind === "added" ? html`Adds a check: ${change.after?.statement ?? ""}` : change.kind === "removed" ? html`Drops a check: ${change.before?.statement ?? ""}` : html`Rewords a check: ${change.after?.statement ?? ""}`;
    }
  };
  const count = `${view.changes.length} change${view.changes.length === 1 ? "" : "s"}`;
  return joinHtml([
    html`<div class="approval-amendment" id="contract-amendment">`,
    html`<p><strong>${view.revision === true ? `The plan makes ${count} from your notes` : `The plan makes ${count} to what you filed`}</strong></p>`,
    html`<ul>${view.changes.map(one => html`<li>${line(one)}</li>`)}</ul>`,
    view.amendment === null ? "" : html`<p class="meta">Why: ${view.amendment}</p>`,
    html`</div>`,
  ]);
}

/** Whether a fragment renders nothing. */
const isEmptyHtml = (fragment: Html): boolean => htmlString(fragment) === "";
/** A fragment's markup for a JSON field of the browser workspace ("" when absent). */
const fragmentString = (fragment: Html | ""): string => fragment === "" ? "" : htmlString(fragment);

/**
 * The approval sheet (approval critique, Oct 2): the plan open, in plain
 * rows — Goal, Changes, Won't touch, Done when — one line of who builds,
 * one Approve & start beside the password, and every remaining signed
 * term (lineage, routing, runtime limits, the seal) in one Details fold.
 * Presentation only: the same hidden fields, nonce, digest and password
 * post to the same route, and the task page and chat card share it.
 */
export function approvalSheetHtml(input: {
  surface: "task" | "chat";
  action: string;
  csrf: string;
  nonce: string;
  digest: string;
  returnTo: string | null;
  scope: Scope;
  planDocument: string | null;
  planContract: PlanContractView | null | undefined;
  revision: Extract<RevisionView, { sourceRun: number }> | null;
  revisionSourceHref: string;
  /** A machine-drafted repair: the build it repairs. */
  repairChain: RepairChainRow | null;
  route: RouteView | null | undefined;
  coordinator: { label: string; filedAgo: string | null } | null;
  deliverable: "branch" | "report";
  editHref: string;
  notNowHref: string;
  sticky: boolean;
  /** Earlier versions of this task still queued or running, and how many of them are running. */
  earlier: { active: number; running: number };
  /** The in-place editor (task page): the scope route, a draft the server
   * refused (with why), whether it opens on arrival, and the plan's steps editor. */
  edit: { action: string; draft: URLSearchParams | null; problem: string | null; open: boolean; stepsHref: string | null } | null;
}): Html {
  const { scope, route } = input;
  // A machine-drafted repair appends its brief to the signed goal; the row
  // shows the goal and one sentence says what the repair fixes. The whole
  // signed goal stays in Details.
  const repairText = / — (repair exactly the unmet criteria named below; a comment cannot widen the scope\. Unmet: ([^.]+)\.|Collect only the missing observations for ([^.]+)\. .*|Diagnose the saved failed project check and repair within the original scope\. .*)$/s.exec(scope.goal);
  const goalShown = repairText === null ? scope.goal : scope.goal.slice(0, repairText.index);
  const statementsOf = (ids: string): string => ids.split(",").map(id => id.trim()).map(id => scope.acceptance.find(one => one.id === id)?.statement ?? id).map(one => one.replace(/[.\s]+$/, "")).join("; ");
  const repairBuild = input.revision?.sourceRun ?? input.repairChain?.sourceRun ?? null;
  const builtBy = repairBuild === null ? "the last build" : `build #${repairBuild}`;
  const sentence = input.revision !== null && (repairText === null || input.revision.comments.length > 0) ? revisionSentence(input.revision, scope.acceptance)
    : repairText === null ? null
    : repairText[2] !== undefined ? `Fixes what ${builtBy} missed: ${statementsOf(repairText[2])}.`
    : repairText[3] !== undefined ? `Collects the evidence ${builtBy} was missing for: ${statementsOf(repairText[3])}. The saved code stays the same.`
    : `Fixes the checks that failed in ${builtBy}.`;
  const plan = input.planDocument === null ? null : parseExecutionPlanDocument(input.planDocument);
  const milestones = plan !== null && plan.ok ? plan.document.milestones : [];
  const permission = permissionWordsOf(scope.profile);
  const money = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;
  const row = (label: string, body: Html): Html => html`<div class="approval-row"><dt>${label}</dt><dd>${body}</dd></div>`;
  const changes = joinHtml([
    milestones.length > 0 ? html`<ol class="approval-steps">${milestones.map(one => html`<li>${one}</li>`)}</ol>` : "",
    scope.touches.length > 0
      ? html`<p>Only in these paths:</p>${approvalPathsHtml(scope.touches)}`
      : html`<p${milestones.length > 0 ? html` class="meta"` : ""}>Any file in the project.</p>`,
  ]);
  const doneWhen = scope.acceptance.length === 0
    ? html`<p>You decide when you review the result.</p>`
    : html`<ul class="approval-done">${scope.acceptance.map(one => html`<li>${one.statement}</li>`)}</ul>`;
  // Who builds, in one line: the builder and planner by name, the cap, and full access when granted.
  const legs = route?.projection?.legs ?? [];
  const legOf = (phase: Phase) => legs.find(one => one.phase === phase);
  const who: string[] = [];
  const builder = legOf("build");
  if (builder !== undefined) who.push(`Builder ${agentNameWords(builder.provider, builder.model)}`);
  else if (route?.legacy != null) who.push(`Builder ${agentNameWords(route.legacy.provider, route.legacy.model)}`);
  else if (scope.profile != null) who.push(`Builder ${agentNameWords(scope.profile.provider, scope.profile.model)}`);
  const planner = legOf("plan");
  // A small change makes no plan: no planner is named (a person's chosen planner still is).
  const sized = route?.projection?.size ?? null;
  const unplanned = route?.projection != null && makesNoPlan(sized, route.projection.risk) && planner?.chosen === "recommended";
  if (planner !== undefined && !unplanned) who.push(`Planner ${agentNameWords(planner.provider, planner.model)}`);
  // What the yes allows, in plain words, right above it: the agent's
  // permissions, the per-attempt limit, and an earlier version still running.
  const allowing: string[] = [];
  const allowed = permissionPlainWords(scope.profile);
  if (allowed !== null) allowing.push(allowed);
  allowing.push(scope.budgetMicrousd === null ? "no attempt limit" : `up to ${money(scope.budgetMicrousd)} per attempt`);
  const earlier = earlierVersionsWords(input.earlier.active, input.earlier.running);
  if (earlier !== null) allowing.push(earlier);
  const yoursToCheck = scope.acceptance.filter(one => one.evidence.includes("manual-review")).map(one => one.statement.trim().replace(/[.\s]+$/, ""));
  const consent = joinHtml([
    allowing.length === 0 ? "" : html`<p class="approval-allowing" data-approval-allowing>You’re allowing: ${allowing.join(" · ")}</p>`,
    yoursToCheck.length === 0 ? "" : html`<p class="approval-you-check" data-approval-you-check>You’ll check: ${yoursToCheck.join("; ")}</p>`,
  ]);
  const after = input.deliverable === "report"
    ? html`An agent investigates without changing the repository. You'll hear when its report is ready.`
    : html`An agent starts in its own branch. You'll hear when it's ready to review.`;
  const submit = html`Approve & start`;

  // Everything else the digest binds, one tap away.
  const detail = (title: string, body: Html, attrs: Html = html``): Html => isEmptyHtml(body) ? html`` : html`<section class="approval-detail"${attrs}><h3>${title}</h3>${body}</section>`;
  const revisionDetail = input.revision === null ? "" : detail("Earlier build", joinHtml([
    html`<div class="revision-card" data-revision-feedback>`,
    html`<p><a href="${input.revisionSourceHref}"${input.surface === "chat" ? html` data-revision-source` : ""}>${input.surface === "chat" ? html`Original result: build #${input.revision.sourceRun} →` : html`build #${input.revision.sourceRun}`}</a></p>`,
    input.revision.comments.length === 0 ? "" : html`<ul>${input.revision.comments.map(one => html`<li>${one.path === null ? "" : html`<span class="mono">${one.path}${one.line === null ? "" : `:${one.line}`}</span> · `}${one.note} <span class="meta">— ${one.author}</span></li>`)}</ul>`,
    revisionLineageHtml(input.revision.lineage),
    html`</div>`,
  ]));
  const contract = input.planContract;
  const amendment = approvalAmendmentHtml(contract);
  const contractDetail = input.planDocument === null || !isEmptyHtml(amendment) ? html``
    : contract === null || contract === undefined ? html`<p class="meta">No record compares this plan with what was filed. Check the rows above against your request.</p>`
    : "problem" in contract ? html`<p class="meta">${contract.problem} · <a href="/r/${contract.run}">run ${contract.run}</a></p>`
    : !contract.filed && contract.revision !== true ? html`<p class="meta">Nothing was filed before planning, so every term is the planner's proposal.</p>`
    : html`<p class="meta">${contract.revision === true ? "Same terms as the previous version." : "The plan keeps exactly what you filed."} <a href="/r/${contract.run}">Planning run ${contract.run}</a></p>`;
  const criteriaDetail = scope.acceptance.length === 0 ? html``
    : html`<ul class="approval-signed-criteria">${scope.acceptance.map(one => html`<li><code>${one.id}</code> ${one.statement} <span class="meta">shown by ${one.evidence.map(kind => EVIDENCE_PLAIN[kind] ?? kind).join(", ")}</span></li>`)}</ul>`;
  const projection = route?.projection ?? null;
  const agentsDetail = route === null || route === undefined ? html``
    : projection === null
      ? route.legacy === null ? html`` : html`<p>${agentsSummaryWords(route)}</p>`
      : joinHtml([
        html`<p>${projection.summary}</p>`,
        html`<p class="meta">Uses ${projection.postureWords}.</p>`,
        projection.demands.length === 0 ? "" : html`<ul class="meta">${projection.demands.map(one => html`<li>${one}</li>`)}</ul>`,
        html`<dl class="approval-roles">${projection.legs.map(leg =>
          html`<div><dt>${ROLE_NOUN[leg.phase]}</dt><dd><span class="mono">${leg.provider} · ${leg.model}</span> <span class="meta">${chosenWords(leg)}</span><ul>${leg.reasons.map(reason => html`<li>${reason}</li>`)}${leg.problem === null ? "" : html`<li><strong>${leg.problem}</strong></li>`}</ul></dd></div>`)}</dl>`,
        html`<p class="meta">These exact agents are part of what you approve. Changing any of them asks for a fresh approval.</p>`,
      ]);
  const limits = joinHtml([
    profileWords(scope),
    html`<p class="meta">Checks level: ${qualityModeTitle(scope.qualityMode ?? "default")}${permission === null ? "" : ` · ${permission}`}</p>`,
    scope.budgetMicrousd === null ? "" : html`<p class="meta">Each build attempt has a ${money(scope.budgetMicrousd)} agent-reported usage cap. On a subscription this limits work; it is not an API charge.</p>`,
  ]);
  const details = joinHtml([
    html`<details class="approval-details"><summary>Plan details</summary>`,
    revisionDetail,
    repairText === null ? "" : detail("Signed goal", html`<p>${scope.goal}</p>`),
    detail("Plan record", contractDetail),
    detail("Signed criteria", criteriaDetail),
    detail("Why these agents", agentsDetail, html` id="${input.surface === "task" ? "approval-agents" : "chat-approval-agents"}"`),
    detail("Runtime limits", limits),
    scope.candidate ? detail("Saved commit", html`<p><code class="approval-commit">${scope.candidate}</code></p>`) : "",
    detail("Seal", html`<p class="meta">Approval binds to this exact wording. <span class="seal mono">signs ${shortDigest(scope.digest)}</span></p>`),
    html`</details>`,
  ]);
  const passwordNote = input.surface === "task" ? "approval-password-note" : "chat-approval-password-note";

  // Edit plan, in place (task page): the rows become fields and save
  // through the scope's own route. The fields belong to a form after this
  // one (forms never nest), so Approve never carries them.
  const edit = input.edit;
  const draft = edit?.draft ?? null;
  const editForm = "plan-editor-form";
  // Each field opens tall enough for what it holds (up to ten lines).
  const field = (name: string, value: string, rows: number, label: string, hint = ""): Html =>
    html`<label class="approval-field"><span class="approval-field-label">${label}</span>${hint === "" ? "" : html`<span class="approval-field-hint">${hint}</span>`}<textarea name="${name}" rows="${Math.min(10, Math.max(rows, value.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 80)), 0)))}" form="${editForm}">${value}</textarea></label>`;
  // Done when, one line per requirement in the signed order; the server
  // matches them back by position (the digest guard keeps that order).
  const requirement = (name: string, value: string, label: string, placeholder = ""): Html =>
    html`<li><input type="text" name="${name}" value="${value}" aria-label="${label}"${placeholder === "" ? "" : html` placeholder="${placeholder}"`} form="${editForm}"></li>`;
  const requirements = draft?.getAll("requirement") ?? scope.acceptance.map(one => one.statement);
  const added = draft?.get("requirement-new") ?? "";
  const editor = edit === null ? null : joinHtml([
    html`<details class="approval-edit" id="plan-editor"${draft === null && !edit.open ? "" : html` open`}>`,
    html`<summary class="approval-link"><span class="approval-edit-open">Edit plan</span><span class="approval-edit-close">Cancel</span></summary>`,
    html`<div class="approval-editor">`,
    edit.problem === null ? "" : html`<p class="problem" role="alert">${edit.problem}</p>`,
    field("goal", draft?.get("goal") ?? goalShown, 3, "Goal"),
    field("touches", draft?.get("touches") ?? scope.touches.join("\n"), 2, "Changes", "Only in these paths, one per line. Leave empty for any file."),
    field("not", draft?.get("not") ?? scope.outOfScope ?? "", 2, "Won’t touch"),
    html`<fieldset class="approval-field"><legend class="approval-field-label">Done when</legend>`,
    html`<span class="approval-field-hint">Clear a line to drop it.</span><ul class="approval-requirements">`,
    requirements.map((one, index) => requirement("requirement", one, `Requirement ${index + 1}`)),
    requirement("requirement-new", added, "Add a requirement", "Add a requirement"),
    html`</ul></fieldset>`,
    html`<div class="approval-edit-act"><button type="submit" form="${editForm}">Save plan</button>`,
    // A plan with written steps keeps its own editor for them.
    edit.stepsHref === null ? "" : html`<a class="approval-link" href="${edit.stepsHref}">Edit steps</a>`, html`</div>`,
    html`</div></details>`,
  ]);
  const keptMode = permissionModeOfProfile(scope.profile);
  const editorForm = edit === null ? "" : postForm(edit.action, null, {
    attrs: { id: editForm, class: "approval-editor-form" },
    hidden: {
      // A refused save keeps the version its draft was edited from, so a
      // plan that changed meanwhile is never silently overwritten.
      sawDigest: draft?.get("sawDigest") ?? scope.digest,
      // The terms the editor doesn't show ride along unchanged: a repair's
      // brief after its goal (it stays in Details), permissions, checks, cap.
      "goal-brief": repairText === null ? null : repairText[0],
      "permission-mode": keptMode,
      "quality-mode": scope.qualityMode ?? "default",
      // The cap rides in exact millionths ("none" keeps no limit).
      "budget-microusd": scope.budgetMicrousd === null ? "none" : String(scope.budgetMicrousd),
    },
  });

  return joinHtml([
    postForm(input.action, joinHtml([
      html`<input type="text" name="username" autocomplete="username" class="visually-hidden" tabindex="-1" aria-hidden="true">`,
      html`<h2 class="approval-sheet-title">${input.deliverable === "report" ? "The investigation" : "The plan"}</h2>`,
      sentence === null ? "" : html`<p class="approval-revision">${sentence}</p>`,
      input.coordinator === null ? "" : html`<p class="approval-note">An agent filed this: <span class="mono">${input.coordinator.label}</span>${input.coordinator.filedAgo === null ? "" : html`, ${input.coordinator.filedAgo}`}. Nothing runs until you approve, and approving runs its request.</p>`,
      input.deliverable === "report" ? html`<p class="approval-note">Read-only: it reports back and changes nothing in the repository.</p>` : "",
      html`<dl class="approval-rows">`,
      row("Goal", html`<p class="approval-goal">${goalShown}</p>`),
      row("Changes", changes),
      row("Won’t touch", html`<p>${scope.outOfScope === null ? "Nothing is ruled out." : scope.outOfScope}</p>`),
      row("Done when", doneWhen),
      html`</dl>`,
      amendment,
      // The size, said once and plainly beside who builds: "Small change: fast model, no plan".
      projection === null ? "" : sizeLineHtml(projection),
      who.length === 0 ? "" : html`<p class="approval-who">${who.join(" · ")}</p>`,
      consent,
      html`<div class="approval-act" id="${input.surface === "task" ? "approval-confirm" : "chat-approval-confirm"}">`,
      html`<label class="approval-password"><span class="visually-hidden">Your password</span><input type="password" name="token" autocomplete="current-password" placeholder="Your password" aria-describedby="${passwordNote}"></label>`,
      html`<p class="approval-password-note" id="${passwordNote}">Your password signs this approval.</p>`,
      html`<button type="submit" data-primary-action>${submit}</button></div>`,
      html`<p class="approval-after">${after}</p>`,
      html`<div class="approval-secondary">${editor ?? html`<a class="approval-link" href="${input.editHref}">Edit plan</a>`}<a class="approval-link" href="${input.notNowHref}">Not now</a></div>`,
      details,
    ]), {
      attrs: { class: "approve-form approval-sheet", id: input.surface === "task" ? "approve" : null, "data-sticky": input.sticky },
      hidden: { nonce: input.nonce, digest: input.digest },
      returnTo: input.returnTo,
    }),
    editorForm,
  ]);
}
/** Earlier versions of a task still in flight, in plain words: queued
 * while they only wait, running once one has started; null when none. */
export function earlierVersionsWords(active: number, running: number): string | null {
  if (active <= 0) return null;
  const still = running >= active ? "running" : running <= 0 ? "queued" : "queued or running";
  return active === 1 ? `an earlier version is still ${still}` : `${active} earlier versions are still ${still}`;
}

/** An in-place plan edit that would change the agent's permissions: thrown to roll the save back. */
export class PermissionsWouldChange extends Error {}

/** Evidence kinds in plain words, for the signed criteria in Details. */
export const EVIDENCE_PLAIN: Record<string, string> = { check: "the project check", screenshot: "screenshots", "changed-path": "changed files", "manual-review": "your own check" };

/** The permission choice a sealed profile carries, as the scope form names it. */
export function permissionModeOfProfile(profile: Scope["profile"] | null | undefined): UnattendedPermissionMode | null {
  if (profile === null || profile === undefined) return null;
  return profile.provider === "claude"
    ? profile.permissionArgv === "bypassPermissions" ? "bypassPermissions" : "auto"
    : profile.provider === "gemini"
      ? profile.approvalArgv === "yolo" ? "bypassPermissions" : "auto"
      : profile.sandboxMode === "danger-full-access" ? "bypassPermissions" : "auto";
}

/** Done when, from the in-place editor: each line keeps its requirement's
 * id by position, and its evidence and guidance while its words stand; a
 * rewritten one is yours to check, like an added one; an emptied one is
 * dropped. */
export function requirementsFromEditor(body: FormView<"requirement" | "requirement-new">, current: readonly AcceptanceCriterion[]): unknown[] {
  const used = new Set(current.map(one => one.id));
  let next = 1;
  while (used.has(`c${next}`)) next++;
  const plain = (raw: string): string => raw.replace(/\s+/g, " ").trim();
  const kept = body.getAll("requirement").slice(0, current.length).flatMap((raw, index) => {
    const statement = plain(raw);
    const criterion = current[index]!;
    if (statement === "") return [];
    return statement === plain(criterion.statement)
      ? [{ id: criterion.id, statement: criterion.statement, evidence: [...criterion.evidence], how: criterion.how }]
      : [{ id: criterion.id, statement, evidence: ["manual-review" as const], how: null }];
  });
  const added = plain(body.get("requirement-new") ?? "");
  return added === "" ? kept : [...kept, { id: `c${next}`, statement: added, evidence: ["manual-review"], how: null }];
}

/**
 * THE CONSENT DOOR (v48): whether a yes can be given on this scope right
 * now — one answer for the task page, the focused chat, and /next, so no
 * surface mints a nonce or shows a password the others would refuse.
 * Closed when the scope cannot say exactly what would run: an unresolved
 * profile, a routed row whose route cannot be read, a route with a stated
 * problem, or a pre-routing row whose old approval no longer stands (its
 * profile alone can no longer be agreed to — re-filing routes it). An
 * approved legacy row never reaches here: its old yes is grandfathered.
 * Every closed answer carries the words and the one road that opens it.
 */
export type ConsentDoor = { open: true } | { open: false; title: string; why: string; road: "scope" | "agents" };

export function consentDoorOf(scope: Scope | null, route: RouteView | null | undefined): ConsentDoor {
  if (scope === null) return { open: false, title: "There is no scope to approve yet", why: "write the scope first", road: "scope" };
  if (scope.profileState === "unresolved") {
    return { open: false, title: "The agent setup isn’t ready yet", why: scope.unresolvedReason ?? "the scope cannot say exactly what would run", road: "scope" };
  }
  // THE SAME STRICT PROJECTION THE SEAL USES (v48 integrity): before any
  // nonce, password field, or approve action renders, the stored scope
  // must prove exactly — exact-key profile, chain, and route; safe and
  // timer-safe numbers; a well-formed auth mode on every chain entry;
  // build/repair parity; the profile as the chain's entry zero; the
  // digest re-derived complete. What the seal would refuse, no surface
  // offers.
  const authority = scopeAuthorityOf(scope, { authMode: provider => readAuthModeStrict(provider) });
  if (!authority.ok) {
    if (authority.reason === "auth-mode") {
      return { open: false, title: "The provider’s auth mode can’t be read", why: `${authority.problem} — restate it, then approve`, road: "agents" };
    }
    if (authority.reason === "unrouted") {
      return { open: false, title: "This scope predates agent routing", why: "its approval no longer stands, and an approval now must name exactly which agent plans, builds, and revises — re-file the scope (edit and save it) to route it under today’s agents, then approve it", road: "scope" };
    }
    return { open: false, title: "The agents on file can’t be read", why: `${authority.problem} — re-file the scope (edit and save it) so it is routed again under today’s agents`, road: "scope" };
  }
  if (route === null || route === undefined) return { open: true };
  if (route.kind === "unreadable") {
    return { open: false, title: "The agents on file can’t be read", why: `${route.problem} — re-file the scope (edit and save it) so it is routed again under today’s agents`, road: "scope" };
  }
  if (route.kind === "legacy") {
    return { open: false, title: "This scope predates agent routing", why: "its approval no longer stands, and an approval now must name exactly which agent plans, builds, and revises — re-file the scope (edit and save it) to route it under today’s agents, then approve it", road: "scope" };
  }
  if (route.projection !== null && route.projection.problems.length > 0) {
    return { open: false, title: "The agents on file can’t run", why: `${route.projection.problems.join("; ")} — change the agents, then approve`, road: "agents" };
  }
  return { open: true };
}

/** The closed door, rendered: no nonce, no password, no approve button —
 * the reason and the one act that opens it. */
export function consentClosedHtml(taskId: string, door: ConsentDoor & { open: false }, surface: "task" | "chat" | "next"): Html {
  const href = `${taskHref(taskId)}#${door.road === "agents" ? "agents" : "scope"}`;
  const act = door.road === "agents" ? "Change the agents →" : "Edit and re-file the scope →";
  if (surface === "chat") {
    return html`<section class="card chat-action-card consent-closed" id="task-chat-action"><span class="eyebrow">approval needs attention</span><h2>${door.title}</h2><p class="meta">${door.why}</p><a class="button-link" href="${href}">${act}</a></section>`;
  }
  if (surface === "next") {
    return html`<div class="card approve-form consent-closed"><p><strong>${door.title}: approval is closed.</strong></p><p class="meta">${door.why}</p><p class="ceremony-road"><a class="button-link" href="${href}">${act}</a></p></div>`;
  }
  return html`<div class="card approve-form consent-closed" id="approve"><p><strong>This task is waiting on you: ${door.title.toLowerCase()}.</strong></p><p class="meta">${door.why}</p><p class="ceremony-road"><a class="button-link" href="${href}">${act.toLowerCase()}</a></p></div>`;
}

export function profileWords(scope: Pick<Scope, "profile" | "profileState" | "unresolvedReason" | "digestVersion">): Html {
  if (scope.profileState === "unresolved") {
    return html`<p class="meta"><strong>Filed but unapprovable</strong> — ${scope.unresolvedReason ?? "the scope cannot say exactly what would run"}. Restate the scope to fix it.</p>`;
  }
  const profile = scope.profile ?? null;
  if (profile === null) {
    return (scope.digestVersion ?? 1) < 2
      ? html`<p class="meta">Approved before routing was bound — pinned at upgrade to the configuration of that day</p>`
      : html``;
  }
  const repair = profile.repairModel === "inherit" ? "same model" : profile.repairModel;
  const base =
    profile.provider === "claude"
      ? html`<p class="meta">Runs on <span class="mono">claude · ${profile.model}</span> — ${
          profile.permissionArgv === "bypassPermissions"
            ? "FULL permissions; claude runs with --dangerously-skip-permissions and nothing asks"
            : profile.permissionArgv === "auto"
              ? "safe unattended permissions; routine project commands and edits proceed, risky acts stop"
              : "legacy acceptEdits; edits proceed, commands that ask are denied unattended"
        }, stops after ${profile.maxTurns} turns, ${Math.round(profile.timeoutSeconds / 60)} min ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}; repairs on ${repair}, ${profile.repairMaxTurns} turns / ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`
      : profile.provider === "gemini"
        ? html`<p class="meta">Runs on <span class="mono">gemini · ${profile.model}</span> — ${profile.approvalArgv === "yolo" ? "Full access via --approval-mode yolo; every tool auto-approved" : "Auto via --approval-mode auto_edit; edits auto-approved, other tools refused"}, no turn limit (${Math.round(profile.timeoutSeconds / 60)} min ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}), spend reported in tokens only; repairs on ${repair}, ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`
        : html`<p class="meta">Runs on <span class="mono">${profile.provider} · ${profile.model}</span> — ${profile.sandboxMode === "danger-full-access" ? "FULL permissions via --dangerously-bypass-approvals-and-sandbox; nothing asks" : "workspace-write sandbox"}, no turn limit (${Math.round(profile.timeoutSeconds / 60)} min ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}); repairs on ${repair}, ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`;
  return base;
}
/** The Agents view every console surface renders (v47): the SAME
 * projection the CLI prints — who plans, builds, and revises,
 * whether each was recommended, overridden, or pinned, its reasons, and
 * the readiness the task's runners have reported (ready / unavailable /
 * unknown — an unknown is said, never upgraded). Readiness is volatile and
 * never part of what an approval signs, so the ceremony shows the agents
 * and their reasons only. */
export type RouteView = {
  kind: "route" | "legacy" | "unreadable";
  source: "approved" | "proposed" | "live" | null;
  projection: RouteProjection | null;
  /** A proven pre-routing row: its approved agent profile, nothing more. */
  legacy: { provider: string; model: string; repairModel: string; approved: boolean } | null;
  /** A routed row whose agents cannot be read — fail closed, in words. */
  problem: string | null;
  overrides: RouteOverride[];
  /** An approver may edit: a live claim or a viewer session refuses. */
  editable: boolean;
  editableWhy: string | null;
  /** A planner change after a draft landed asks for a real re-plan. */
  replanOnPlanChange: boolean;
  /** The scope digest the change forms CAS against; null = no scope yet. */
  digest: string | null;
  /** v48: the configured, role-valid agents an approver may choose from —
   * every option an exact pair the operator named once in configuration.
   * The form offers these and nothing else. */
  choices: Record<Phase, AgentChoice[]>;
};

export const ROLE_NOUN: Record<RouteProjection["legs"][number]["phase"], string> = { plan: "Planner", build: "Builder", repair: "Repair", review: "Reviewer" };

export function agentsStandingWords(view: RouteView): string {
  return view.kind === "legacy"
    ? view.legacy?.approved === true ? "approved earlier" : "not approved"
    : view.kind === "unreadable"
      ? "cannot be read"
      : view.source === "approved"
        ? "approved"
        : view.source === "proposed"
          ? "awaiting approval"
          : "recommended";
}

/** The size line an approval leads its agents with — "Small change: fast
 * model, no plan" — and, quietly, why it was sized so. */
export function sizeLineHtml(projection: RouteProjection): Html {
  if (projection.sizeWords === null) return html``;
  return html`<p class="agents-size"><strong>${projection.sizeWords}.</strong>${projection.sizeReason === null ? "" : html` <span class="meta">${projection.sizeReason}</span>`}</p>`;
}

/** What a size does, for a proposal card. */
export function sizeConsequence(size: string, risky: boolean): string {
  if (size === "small" && !risky) return "Small change: fast model, no plan";
  if (size === "large" || risky) return `${size === "large" ? "Large" : "Risky"} change: strongest agents plan and build`;
  return "Medium change: everyday agents";
}

/** The one plain-English line: who does what. */
export function agentsSummaryWords(view: RouteView): string {
  if (view.projection !== null) return view.projection.summary;
  if (view.legacy !== null) return `${view.legacy.provider} · ${view.legacy.model} builds and repairs (repair model ${view.legacy.repairModel}); the planner and reviewer come from configuration at run time`;
  return view.problem ?? "the agents cannot be read";
}

/** A risk badge only when there is something to say: a risky change, or an
 * older route sealed at elevated or high risk. */
export function riskBadgeHtml(projection: RouteProjection): Html {
  return projection.riskTitle === "Routine" ? html`` : html`<span class="badge">${sentenceCase(projection.riskTitle)}</span>`;
}

/** Neutral metadata badges: risk (when not routine), posture, and standing. */
export function agentsBadgesHtml(view: RouteView): Html {
  const p = view.projection;
  return html`${p === null ? "" : riskBadgeHtml(p)}${
    p === null ? "" : html`<span class="badge">${sentenceCase(p.postureWords)}</span>`}<span class="badge">${sentenceCase(agentsStandingWords(view))}</span>`;
}

/** Volatile availability, per provider on the route — shown beside the
 * agents, never inside the approval's terms. */
export function agentsAvailabilityHtml(projection: RouteProjection): Html {
  const seen = new Map<string, RouteProjection["legs"][number]>();
  for (const leg of projection.legs) if (!seen.has(leg.provider)) seen.set(leg.provider, leg);
  const items = [...seen.values()].map(leg => {
    const state = leg.readiness === "ready" ? "ready" : leg.readiness === "unavailable" ? "unavailable" : "not yet checked";
    const detail = leg.readiness === "unavailable" && leg.readinessReason !== null ? ` (${leg.readinessReason})` : "";
    return html`<li class="agents-availability-${leg.readiness}"><span class="mono">${leg.provider}</span> ${state}${detail}${leg.readinessRunner === null ? "" : html` <span class="meta">— ${leg.readinessRunner}${leg.observedAt === null ? "" : html`, ${whenTime(leg.observedAt)}`}</span>`}</li>`;
  });
  return html`<p class="meta agents-availability-label">Availability right now</p><ul class="agents-availability">${items}</ul>`;
}

/** The closed details: one row per role, with the reasons. */
export function agentsWhyHtml(projection: RouteProjection, summaryLabel = "Why these agents"): Html {
  return joinHtml([
    html`<details class="agents-why"><summary>${summaryLabel}</summary>`,
    projection.demands.length === 0 ? "" : html`<ul class="agents-demands">${projection.demands.map(one => html`<li>${one}</li>`)}</ul>`,
    html`<dl class="agents-roles">`,
    projection.legs.map(leg => {
      const chosen = chosenWords(leg);
      return joinHtml([
        html`<dt>${ROLE_NOUN[leg.phase]}</dt>`,
        html`<dd><span class="mono">${leg.provider} · ${leg.model}</span> <span class="badge">${sentenceCase(chosen)}</span>`,
        html`<ul class="agents-reasons">${leg.reasons.map(reason => html`<li>${reason}</li>`)}${leg.problem === null ? "" : html`<li><strong>${leg.problem}</strong></li>`}</ul></dd>`,
      ]);
    }),
    html`</dl></details>`,
  ]);
}

/** The ceremony's agents block: what the yes agrees to — the agents and
 * their reasons. Availability is volatile and deliberately absent here. */
export function agentsCeremonyHtml(view: RouteView | null | undefined): Html {
  if (view === null || view === undefined) return html``;
  if (view.projection === null) {
    // A proven pre-routing approval: its sealed profile is the whole
    // agents term, said in the same place with the same label.
    if (view.legacy !== null) {
      return html`<div class="agents-ceremony"><p class="approval-label">agents</p><p class="agents-summary">${agentsSummaryWords(view)}</p></div>`;
    }
    return html``;
  }
  return joinHtml([
    html`<div class="agents-ceremony"><p class="approval-label">agents</p>`,
    sizeLineHtml(view.projection),
    html`<p class="agents-summary">${view.projection.summary}</p>`,
    html`<div class="agents-badges">${riskBadgeHtml(view.projection)}<span class="badge">${sentenceCase(view.projection.postureWords)}</span></div>`,
    agentsWhyHtml(view.projection),
    html`<p class="meta">These exact agents are part of what you approve; changing any of them asks for a fresh approval.</p></div>`,
  ]);
}

/** The runtime limits the sealed profile binds — permissions, turn and
 * time bounds, repairs — restated on the ceremony as
 * a CLOSED disclosure (v48): a term the yes covers, one tap away, never a
 * wall of switches between the reader and the password. An unresolved
 * profile still speaks in the open: that is a refusal, not a detail. */
export function runtimeDetailsHtml(scope: Pick<Scope, "profile" | "profileState" | "unresolvedReason" | "digestVersion">): Html {
  if (scope.profileState === "unresolved") return profileWords(scope);
  const words = profileWords(scope);
  if (isEmptyHtml(words)) return html``;
  return html`<details class="agents-runtime"><summary>Runtime limits</summary>${words}</details>`;
}

/** The task page's Agents card: the summary, availability, closed reasons,
 * and — for an approver — closed change controls. Every change re-files
 * the scope; an approval given under the earlier agents needs renewing. */
export function agentsCardHtml(taskId: string, view: RouteView | null | undefined, canEdit: boolean): Html {
  if (view === null || view === undefined) return html``;
  const p = view.projection;
  const sawDigest = view.digest ?? "";
  const route = `${taskHref(taskId)}/route`;
  const overrides =
    view.overrides.length === 0
      ? ""
      : html`<ul class="agents-overrides">${view.overrides.map(
          one => joinHtml([
            html`<li><span>${ROLE_NOUN[one.phase]} → <span class="mono">${one.provider} · ${one.model}</span> <span class="meta">by ${one.by} ${whenTime(one.at)}</span></span>`,
            canEdit && view.editable
              ? postForm(route, html`<button type="submit" class="secondary" aria-label="clear the ${ROLE_NOUN[one.phase].toLowerCase()} choice">Clear</button>`, { attrs: { class: "agents-clear" }, hidden: { sawDigest, "clear-phase": one.phase } })
              : "",
            html`</li>`,
          ]),
        )}</ul>`;
  // The controls (v48): a size choice that says what each size does, and
  // — per role — ONLY the configured, role-valid agents the operator may
  // pick from. Nothing is typed free-hand, no command line is quoted; the
  // reasons above already say why the current agents were chosen.
  const roleForms = ROUTE_PHASES.filter(phase => phase !== "review").map(phase => {
    // Selectable choices are the role's own configured agents; a current
    // agent the configuration no longer names is DISPLAY-ONLY — said
    // beside the control, never an option the form could re-pick.
    const options = view.choices[phase].filter(one => one.selectable);
    const stale = view.choices[phase].find(one => one.current && !one.selectable) ?? null;
    const staleNote = stale === null ? "" : html`<p class="meta agents-stale">Runs today on <span class="mono">${`${stale.provider} · ${stale.model}`}</span>, which is no longer in your configuration — pick a configured agent to replace it.</p>`;
    if (options.length === 0) {
      return html`<div class="agents-role-row"><span class="agents-role-name">${ROLE_NOUN[phase]}</span><p class="meta">No configured agent can take this role for this task.</p>${staleNote}</div>`;
    }
    return html`${postForm(route, joinHtml([
      html`<label>${ROLE_NOUN[phase]}<select name="agent" aria-label="${ROLE_NOUN[phase].toLowerCase()} agent">`,
      options.map(one => html`<option value="${`${one.provider}|${one.model}`}"${one.current ? html` selected` : ""}>${`${one.provider} · ${one.model}`}${one.current ? " — current" : ""}</option>`),
      html`</select></label><button type="submit" class="secondary">Use</button>`,
    ]), { attrs: { class: "agents-form", "aria-label": `choose the ${ROLE_NOUN[phase].toLowerCase()}` }, hidden: { sawDigest, phase } })}${staleNote}`;
  });
  const change = !canEdit
    ? ""
    : !view.editable
      ? html`<p class="meta">${view.editableWhy ?? "the agents cannot change right now"}</p>`
      : joinHtml([
        html`<details class="agents-change"><summary>Change agents</summary>`,
        postForm(route, joinHtml([
          html`<label>Size<select name="size" aria-label="task size">${TASK_SIZES.map(one => html`<option value="${one}"${one === (p?.size?.size ?? "medium") ? html` selected` : ""}>${sizeConsequence(one, false)}</option>`)}</select></label>`,
          // The hidden "no" says the form showed the box: unticked means not risky; a request without either keeps the flag.
          html`<input type="hidden" name="risky" value="no"><label class="agents-risky"><input type="checkbox" name="risky" value="yes"${p?.size?.risky === true ? html` checked` : ""}> Risky</label>`,
          html`<button type="submit" class="secondary">Set size</button>`,
        ]), { attrs: { class: "agents-form-risk" }, hidden: { sawDigest } }),
        html`<div class="agents-role-forms">${roleForms}</div>`,
        html`<p class="meta">Only agents you have configured are offered; each choice is recorded as you. ${view.replanOnPlanChange ? "Changing the planner asks for a new plan — the drafted one is not relabeled. " : ""}An approval given under the earlier agents needs renewing.</p>`,
        overrides,
        html`</details>`,
      ]);
  return joinHtml([
    html`<section class="card agents-card" id="agents" aria-label="agents">`,
    html`<div class="agents-head"><h3>Agents</h3><div class="agents-badges">${agentsBadgesHtml(view)}</div></div>`,
    html`<p class="agents-summary">${agentsSummaryWords(view)}</p>`,
    p === null
      ? view.kind === "unreadable"
        ? html`<p class="agents-halted">Nothing runs for this task until its scope is filed again and approved.</p>`
        : ""
      : joinHtml([
        p.halted ? html`<p class="agents-halted">Paused: a provider these agents need is reported unavailable. Nothing else is used in its place — choose another agent below, or restore the provider and report readiness again.</p>` : "",
        p.problems.length === 0 ? "" : html`<ul class="agents-problems">${p.problems.map(one => html`<li>${one}</li>`)}</ul>`,
        agentsAvailabilityHtml(p),
        agentsWhyHtml(p),
      ]),
    canEdit || overrides === "" ? change : overrides,
    html`</section>`,
  ]);
}

/** The chat's always-visible strip: the summary and a way to the details. */
export function agentsStripHtml(view: RouteView | null, taskId: string): Html {
  if (view === null) return html``;
  // A broken setup is not secondary detail: keep its failure visible.
  if (view.kind === "unreadable") return html`<p class="task-chat-agents">${agentsSummaryWords(view)} <a href="${taskHref(taskId)}#agents">Review agent setup</a></p>`;
  return html`<details class="task-chat-agents"><summary>Agent setup</summary><p>${agentsSummaryWords(view)}</p><a href="${taskHref(taskId)}#agents">View agents</a></details>`;
}
/** A ceremony nonce as stored: the sha256 hex of the value the form carried. */
export function nonceHashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The approve POST's refusal, in words a person can act on. */
export function approveRefusalWords(reason: string): string {
  if (reason === "requester" || reason === "person-required") return gateWords({ verdict: "refuse", reason });
  if (reason === "unrouted") return "not approved: this scope predates agent routing and its old approval no longer stands — edit and re-file the scope so it is routed under today’s agents, then approve it";
  if (reason === "profile-unresolved") return "not approved: the scope cannot name an exact agent for every role — fix the agent setup and re-file it";
  return `not approved: ${reason}`;
}

/** The browser's one-click approval binds not only the signed scope but the
 * exact advisory plan revision shown beside it. The scope digest remains the
 * durable authority; this composite makes a stale open tab fail when somebody
 * edits the plan before approval. The empty middle slot keeps the bytes of
 * forms already open (it once held other terms, always empty here). */
export function approvalFormDigest(scopeDigest: string, planSha: string | null): string {
  if (planSha === null) return scopeDigest;
  return createHash("sha256")
    .update("standing-orders/browser-approval/v1\0", "utf8")
    .update(scopeDigest, "utf8")
    .update("\0", "utf8")
    .update("", "utf8")
    .update("\0", "utf8")
    .update(planSha ?? "", "utf8")
    .digest("hex");
}

/** The one task-level road from a truthful dispatch diagnosis to its nearest
 * existing repair. This is navigation, never authority: every destination
 * still owns its original confirmation, password, CSRF, and transactional
 * checks. Keeping the map here also means the focused chat and task overview
 * cannot send a person to different fixes for the same gate. */
export function taskRecoveryHref(taskId: string, diagnosis: DispatchDiagnosis | null): string | null {
  if (diagnosis?.action === null || diagnosis?.action === undefined) return null;
  const task = taskHref(taskId);
  switch (diagnosis.action) {
    case "start-worker":
    case "repair-dependency":
      return `${task}#run-status`;
    case "retry-task":
    case "unhold":
    case "write-scope":
      return `${task}#task-actions`;
    case "select-agent":
      return `${task}#scope`;
    case "approve-scope":
      return `${task}#approve`;
    case "answer-decision":
      return `${task}#decisions`;
    case "inspect-hold":
      return `${task}#holds`;
    case "repair-capability":
      return "/caps";
    case "place-task":
      return "/projects";
    case "open-result":
      return task;
    case "retry-review":
      return `${task}#run-status`;
    case "resume-run":
      return `${task}#task-control`;
  }
}

/** The resume ceremony's digest (v52): the exact run, its settlement, and
 * the scope approval as it stands — a nonce minted over one set of facts
 * cannot confirm a resume under another. */
export function resumeDigestOf(taskId: string, runId: number, settledAt: string, scope: Scope | null): string {
  return createHash("sha256")
    .update(JSON.stringify([taskId, runId, settledAt, scope?.digest ?? null, scope?.approvedDigest ?? null, scope?.approvedAt ?? null, scope?.approvedBy ?? null]))
    .digest("hex");
}

export const stopWhen = (iso: string): string => iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");

/**
 * The exact-run control (v52): ONE component on the task page, the
 * focused chat, and the status fragment, so every surface names the same
 * run and shows the same state. Stop is one guarded post naming the run;
 * Stopping… is a disabled control with who asked and when; Resume opens
 * the password ceremony; a stopped review points at Review again. Forms
 * carry the CSRF token and the exact run id, nothing else.
 */
/** Presentation only: the same projected words and action on all task
 * surfaces. Approval keeps its action on the exact-terms disclosure. */
export function taskStatusCard(status: DisplayStatus & { diagnostics?: WorkStatus["diagnostics"] }, taskId: string, dispatch: DispatchDiagnosis | null, runId: number | null, approvalAction = false): Html {
  const task = taskHref(taskId);
  const recovery = status.token === "waiting-decision" ? `${task}#task-questions` : status.token === "stopping" || status.token === "stopped"
    ? `${task}#task-control`
    : taskRecoveryHref(taskId, dispatch);
  const href = status.action?.kind === "open-task"
    ? recovery ?? `${task}#scope`
    : statusActionHref(status, taskId, runId, null);
  return joinHtml([
    html`<section class="card task-journey" aria-label="task progress" data-work-status="${status.token}" data-task-status>`,
    html`<h2>${status.label}</h2>`,
    !approvalAction && status.action !== null && href !== null ? html`<a class="button-link task-journey-action" href="${href}" data-primary-action>${status.action.label}</a>` : "",
    html`<details class="task-status-reason"><summary>Status details</summary><p class="meta">${status.detail}</p>${workDiagnosticsHtml(status.diagnostics)}</details></section>`,
  ]);
}

export function checkProgressHtml(progress: CheckProgress | null, id = "check-progress"): Html {
  if (progress === null) return html`<p id="${id}" class="check-progress mono" data-check-progress hidden></p>`;
  const state = !progress.final ? "live" : Object.values(progress.suites).some(one => one.state === "failed") ? "failed"
    : Object.values(progress.suites).every(one => one.state === "passed") ? "passed" : "unknown";
  return html`<p id="${id}" class="check-progress mono" data-check-progress data-final="${state}" role="status" aria-live="polite">${progress.line}</p>`;
}

export function taskControlDetailsHtml(control: TaskControlView, taskId: string, csrf: string, surface: "task" | "chat", inert = false, stopElsewhere = false): Html {
  const card = taskControlHtml(control, taskId, csrf, surface, inert, stopElsewhere);
  return control.kind === "paused" || control.kind === "review-stopped" || control.kind === "stopping"
    ? html`<details id="task-control-details"><summary>${control.kind === "paused" ? "Preserved work and resume" : "Stop details"}</summary>${card}</details>` : card;
}

/** `stopElsewhere`: the Building card already carries this exact run's Stop, so the control card keeps only its details.
 * `csrf` is only a guard now: an empty one (a read-only surface) renders no forms; postForm writes the field. */
export function taskControlHtml(control: TaskControlView, taskId: string, csrf: string, surface: "task" | "chat", inert = false, stopElsewhere = false): Html {
  if (control.kind === "none") return html``;
  const guarded = csrf !== "" && !inert;
  const runForm = (path: string, className: string, button: Html): Html =>
    postForm(`${taskHref(taskId)}/${path}`, button, { attrs: { class: className }, returnTo: surface, hidden: { run: control.run } });
  const role = (word: TaskControlView & { kind: "stop" | "stopping" | "paused" }): string =>
    word.role === "planner" ? "plan attempt" : word.role === "scout" ? "scouting attempt" : word.role === "reviewer" ? "review" : "build";
  if (control.kind === "stop" && surface === "chat") {
    return joinHtml([
      html`<section class="card task-control" id="task-control" data-task-control="stop" data-control-run="${control.run}"><details class="chat-stop-confirm"><summary>Stop task</summary>`,
      html`<p>${taskId} · ${role(control)} #${control.run}</p><p>${CHAT_TASK_ACTIONS.stop.detail}</p>`,
      guarded ? runForm("stop", "task-stop-form", html`<button type="submit" class="danger">Stop task</button>`) : "",
      html`</details></section>`,
    ]);
  }
  if (control.kind === "stop") {
    return joinHtml([
      html`<section class="card task-control" id="task-control" data-task-control="stop" data-control-run="${control.run}" aria-label="stop this attempt">`,
      html`<div class="task-control-copy"><details><summary>Stop details · ${role(control)} #${control.run}</summary><p class="meta">Stopping ends only this attempt's own processes. Its branch, uncommitted work, evidence, and decisions stay preserved; other tasks keep running.</p></details></div>`,
      stopElsewhere ? "" : guarded
        ? runForm("stop", "inline task-control-form task-stop-form", html`<button type="submit" class="danger task-control-button">Stop</button>`)
        : html`<button type="button" class="danger task-control-button" disabled>Stop</button>`,
      html`</section>`,
    ]);
  }
  if (control.kind === "stopping") {
    return joinHtml([
      html`<section class="card task-control" id="task-control" data-task-control="stopping" data-control-run="${control.run}" aria-label="stopping this attempt" aria-busy="true">`,
      html`<div class="task-control-copy"><span class="eyebrow">stop requested</span><strong><span class="live-dot" aria-hidden="true"></span>Stopping ${role(control)} #${control.run}…</strong>`,
      html`<span class="meta">Asked by <span class="mono">${control.stop.requestedBy}</span> at ${stopWhen(control.stop.requestedAt)}. ${control.unsettledRun ? "Its own processes are being ended; this reads Paused once they are established gone." : control.detail ?? "The run ended; a recovery pass still needs to establish that its processes exited."}</span></div>`,
      html`<button type="button" class="task-control-button" disabled aria-disabled="true">Stopping…</button>`,
      html`</section>`,
    ]);
  }
  if (control.kind === "paused") {
    const settled = control.stop.settledAt === null ? "" : ` · settled ${stopWhen(control.stop.settledAt)} (${control.stop.settlement ?? "?"})`;
    const kept = control.stop.settlement === "finished"
      ? html`The attempt reached its own ending (${control.outcome ?? "?"}) before the stop took effect; that outcome stands.`
      : html`${control.committed ? "Its commit is on the branch as a reviewable artifact; a" : "A"}ny uncommitted work is preserved${control.worktree === null ? "" : html` in <span class="mono">${control.worktree}</span>`}. Resuming takes a fresh claim, re-proves the signed scope, and requires fresh proof — nothing is approved by resuming.`;
    return joinHtml([
      html`<section class="card task-control" id="task-control" data-task-control="paused" data-control-run="${control.run}" aria-label="paused attempt">`,
      html`<div class="task-control-copy"><span class="eyebrow">paused</span><strong>${role(control)} #${control.run} was stopped by <span class="mono">${control.stop.requestedBy}</span></strong>`,
      html`<span class="meta">Asked ${stopWhen(control.stop.requestedAt)}${settled}. ${kept}</span></div>`,
      guarded
        ? runForm("resume-arm", "inline task-control-form task-resume-form", html`<button type="submit" class="task-control-button primary">Resume</button>`)
        : html`<button type="button" class="task-control-button" disabled>Resume</button>`,
      html`</section>`,
    ]);
  }
  return html`<details class="card task-control" id="task-control" data-task-control="review-stopped"><summary>Previous assessment stopped</summary><p>Run #${control.run} was stopped by ${control.stop.requestedBy}. The saved result is unchanged.</p></details>`;
}

/** The resume confirmation (v52): the exact run restated, what resuming
 * does and does not do, the gate that would still keep work from
 * starting, and the password typed again. */
export function resumeCeremonyPage(chrome: Chrome, data: {
  taskId: string;
  taskTitle: string;
  control: TaskControlView & { kind: "paused" };
  nonceValue: string;
  /** Unused: postForm writes the CSRF field (kept for the caller). */
  csrf: string;
  returnTo: "task" | "chat";
  gate: DispatchDiagnosis | null;
  approved: boolean;
}): Screen {
  const back = html`<p class="meta"><a href="${data.returnTo === "chat" ? taskChatHref(data.taskId) : taskHref(data.taskId)}">Keep paused</a></p>`;
  const control = data.control;
  return screen("resume", joinHtml([
    html`<h1>Resume task?</h1><p class="resume-target"><strong>${data.taskTitle}</strong> · ${data.taskId} · Run #${control.run}</p>`,
    html`<div class="card resume-ceremony">`,
    html`<p class="row">Lifts this stop’s hold. Other holds stay in place.</p>`,
    html`<p class="row">Continues saved work${control.committed ? " and its commit" : ""} under the current approved scope. The next attempt needs fresh evidence; the earlier handoff cannot count as a new result.</p>`,
    html`<p class="row">Resuming grants no new approval or publishing permission. Scope, budget, agents, verification, and review limits still apply.</p>`,
    html`<details><summary>Stop record and saved work</summary><p>Run #${control.run} was stopped by <span class="mono">${control.stop.requestedBy}</span> at ${stopWhen(control.stop.requestedAt)}${control.stop.settledAt === null ? "" : ` and settled ${stopWhen(control.stop.settledAt)} (${control.stop.settlement ?? "?"})`}.</p>${control.worktree === null ? "" : html`<p class="mono">${control.worktree}</p>`}</details>`,
    data.approved ? "" : html`<p class="row problem-words"><strong>The scope is not approved as it stands</strong> — resuming lifts the pause, but no worker spends until the scope is approved again</p>`,
    data.gate === null ? "" : html`<p class="row"><strong>Before work starts:</strong> ${data.gate.summary} — ${data.gate.detail}</p>`,
    html`</div>`,
    postForm(`${taskHref(data.taskId)}/resume`, joinHtml([
      html`<label>Confirm with your password<input type="password" name="token" autocomplete="current-password"></label>`,
      html`<button type="submit">Resume task</button>`,
    ], "\n"), { attrs: { class: "card resume-form" }, returnTo: data.returnTo, hidden: { nonce: data.nonceValue, run: control.run } }),
    back,
  ], "\n"), { chrome });
}

export function taskViewSwitch(taskId: string, active: "overview" | "ask"): Html {
  return joinHtml([
    html`<nav class="task-view-switch" aria-label="task view">`,
    html`<a href="${taskHref(taskId)}"${active === "overview" ? html` class="active" aria-current="page"` : ""}>Overview</a>`,
    html`<a href="${taskChatHref(taskId)}"${active === "ask" ? html` class="active" aria-current="page"` : ""}>Ask</a>`,
    html`</nav>`,
  ]);
}
export function publicationFactsOf(publication: Publication | null): PublicationFacts {
  return publication === null
    ? null
    : { state: publication.state, prNumber: publication.prNumber, prUrl: publication.prUrl, remoteState: publication.remoteState, lastCheckState: publication.lastCheckState };
}

/** Where a status's next act lives, for a row that links out. */
export function statusActionHref(status: DisplayStatus, taskId: string, runId: number | null, prUrl: string | null, repo?: string | null): string | null {
  if (status.action === null) return null;
  switch (status.action.kind) {
    case "open-result": return runId === null ? taskHref(taskId) : `/r/${runId}`;
    case "open-review": return repo === undefined ? reviewHref(taskId) : reviewHref(taskId, runId);
    case "open-run": return runId === null ? taskHref(taskId) : `/r/${runId}`;
    case "open-pr": return safePrUrl(prUrl) ?? (repo === undefined ? reviewHref(taskId) : reviewHref(taskId, runId));
    case "open-task":
    default: return taskHref(taskId);
  }
}

/** The one status line every surface renders: a dot in the tone, the
 * label, and the `data-work-status` token tests and CSS key off. */
/** A not-yet-finished task's shared headline from its dispatch diagnosis (task-status.ts). */
export function dispatchHeadline(d: DispatchDiagnosis): string {
  const read = stageOfDispatch(d);
  return taskStatusOf({ stage: read.stage, ...(read.need === undefined ? {} : { need: read.need }) }).headline;
}

export function statusLineHtml(status: DisplayStatus, extra: Html | "" = ""): Html {
  return html`<span class="status-line" data-work-status="${status.token}" data-tone="${status.tone}"><i class="status-dot" aria-hidden="true"></i><span class="status-label">${status.label}</span>${extra}</span>`;
}

export function workDiagnosticsHtml(diagnostics: WorkStatus["diagnostics"]): Html {
  return joinHtml((diagnostics ?? []).map(one => html`<p class="work-detail" data-work-diagnostic="${one.token}"><strong>${one.label}</strong> · ${one.detail}</p>`));
}

/**
 * The decision card everywhere a person may ANSWER (portfolio, the
 * selected-project inbox; the task page joins in slice 3): a reversible
 * option answers with one tap on the card, labeled with its own words —
 * never a letter; an irreversible option is a LINK to the decision page,
 * where the server-side confirm=yes guard lives. The roll-up inbox keeps
 * its links-only cards and never renders this partial. The recommended
 * option wears a neutral badge — recommendation is not urgency, and magenta
 * stays on the card's outline.
 */
export function decisionAnswerCard(
  decision: Decision & { taskId: string; repo?: string | null },
  csrf: string,
  now: Date,
  chip: boolean,
  returnTo: string | null = null,
): Html {
  const detailsHref = `/d/${decision.id}${returnTo === null ? "" : `?return=${encodeURIComponent(returnTo)}`}`;
  const options = decision.options
    .map(option => {
      const recommended = option.id === decision.recommendation
        ? html` <span class="badge">Recommended</span>`
        : "";
      if (!option.reversible) {
        return html`<p class="decide-option"><a href="${detailsHref}">${option.label}</a> <span class="badge badge-overdue">Irreversible</span>${recommended} <span class="meta">${option.consequence}</span></p>`;
      }
      return postForm(`/d/${decision.id}/answer`, html`<button type="submit">${option.label}</button>${recommended} <span class="meta">${option.consequence} · reversible</span>`, {
        attrs: { class: "decide-option decide-inline" },
        returnTo,
        hidden: { choice: option.id },
      });
    });
  return joinHtml([
    html`<div class="decide-card" data-decision-id="${decision.id}">`,
    html`<p class="q">${decision.question}</p>`,
    html`<details class="decision-context"><summary>Context</summary><p class="meta">${decision.recap}</p><span class="meta mono">${decision.taskId}</span></details>`,
    html`<p class="meta">${chip ? projectChip(decision.repo) : ""}`,
    html`${isOverdue(decision, now) ? html` <span class="badge badge-overdue">Overdue</span>` : ""}`,
    html` <a href="${detailsHref}">View details →</a></p>`,
    html`<div class="decide-options">${joinHtml(options, "\n")}</div></div>`,
  ]);
}

/**
 * The inline-answer enhancement (portfolio arc §2): submits a reversible
 * option's form as the urlencoded POST the forms-only gate expects, follows
 * the redirect, and — because an answered decision leaves the open list —
 * replaces ONLY that card with the answered receipt parsed from the
 * decision page's own rendering, or removes the card. Anything unexpected
 * (auth, a page that is not the decision's) navigates instead of inserting.
 * Nothing else on the page is touched: typed input elsewhere survives.
 */
export function decisionAnswerScript(): string {
  return (
    `document.addEventListener("submit",function(e){` +
    `var f=e.target;if(!f||!f.classList||!f.classList.contains("decide-inline"))return;` +
    `e.preventDefault();` +
    `var card=f.closest("[data-decision-id]");` +
    `var page=f.action.replace(/\\/answer$/,"");` +
    `fetch(f.action,{method:"POST",credentials:"same-origin",` +
    `headers:{"content-type":"application/x-www-form-urlencoded"},` +
    `body:new URLSearchParams(new FormData(f)).toString()})` +
    `.then(function(r){return r.text().then(function(t){return{r:r,t:t}})})` +
    `.then(function(x){` +
    `var landed="";try{landed=new URL(x.r.url).pathname}catch(err){}` +
    `if(!x.r.ok||landed!==new URL(page,location.href).pathname){location.href=page;return}` +
    `var doc=new DOMParser().parseFromString(x.t,"text/html");` +
    `var receipt=doc.querySelector(".answered");` +
    `if(!card){location.href=page;return}` +
    `if(receipt){card.replaceChildren(document.importNode(receipt,true))}else{card.remove()}` +
    `},function(){location.href=page})});`
  );
}

/** A plan is stored as inert Markdown for portability into the builder
 * brief, but the console renders its known structure as a useful control
 * surface. Historical free-form plans keep their safe plain-text fallback. */
export const MILESTONE_STATE_WORDS: Record<MilestoneState, string> = {
  pending: "Pending",
  current: "In progress",
  completed: "Completed",
  blocked: "Blocked",
};

export function milestoneStateWord(state: MilestoneState): string {
  return MILESTONE_STATE_WORDS[state] ?? "Pending";
}

/** Adaptive execution plans (v44): the live milestone projection a running
 * (or finished) build has reported. A shared render used by BOTH the task
 * page and the focused chat's live region (c2) — labeled clearly as an
 * agent's own report, since a milestone claim is never completion proof
 * (Priority 2's proof contract is the only thing that adjudicates "done"). */
export function milestoneProgressHtml(milestones: MilestoneProgressView[] | null | undefined): Html {
  if (milestones === null || milestones === undefined || milestones.length === 0) return html``;
  const completed = milestones.filter(one => one.state === "completed").length;
  return joinHtml([
    html`<section class="card milestone-progress"><div class="milestone-progress-head"><div><span class="eyebrow">live execution</span><h2>Build progress</h2></div>`,
    html`<span class="milestone-progress-count">${completed} of ${milestones.length} complete</span></div><ul class="milestone-list">`,
    joinHtml(milestones.map(
      one => html`<li class="milestone milestone-${one.state}"><span class="milestone-badge">${milestoneStateWord(one.state)}</span> ${one.description}${one.note === null ? "" : html` <span class="meta">— ${one.note}</span>`}</li>`,
    ), "\n"),
    html`</ul><p class="meta milestone-progress-note">Live checkpoints from the agent.</p></section>`,
  ]);
}

/** Adaptive execution plans (v44): the current plan revision's own reason
 * and evidence, any revision still awaiting an operator's accept/reject,
 * and the immutable history. A shared render used by BOTH the task page
 * and the focused chat's live region (c2), reading a document already
 * verified before a byte reached this function (c5). `csrf` is only a
 * guard now: an empty one renders no forms; postForm writes the field. */
export function planRevisionLedgerHtml(ledger: PlanRevisionLedgerView | null | undefined, taskId: string, csrf: string): Html {
  // Nothing to show yet unless a plan has actually been revised: a task
  // still on its synthetic revision-1 projection, with no pending proposal
  // and no persisted history, is exactly what the plan card already shows.
  if (ledger === null || ledger === undefined || ledger.current === null || (ledger.pending === null && ledger.history.length === 0)) return html``;
  const current = ledger.current;
  const changedAuthority = (field: string): string => {
    if (field === "scopeDigest" || field === "signed-scope") return "the work you approved";
    if (field === "deliverable" || field === "publication-authority") return "what the task may deliver";
    return field.replace(/[-_]+/g, " ");
  };
  const pendingRevision = ledger.pending;
  const pending =
    pendingRevision === null
      ? ""
      : joinHtml([
        html`<div class="plan-revision-pending"><span class="eyebrow">decision needed</span><h3>The agent recommends a plan change</h3>`,
        html`<p>${pendingRevision.reason}</p>`,
        html`<p class="meta">Revision ${pendingRevision.revision}${pendingRevision.authorityKind === "authority-change" ? ` changes ${pendingRevision.changedFields.map(changedAuthority).join(" and ")} from what you approved, so work is paused until you decide.` : " only changes the route, not the approved outcome."}${
          pendingRevision.evidenceLink === null ? "" : ` Evidence: ${pendingRevision.evidenceLink}.`}</p>`,
        executionPlanHtml(pendingRevision.document, true),
        csrf === "" || pendingRevision.id === null
          ? ""
          : joinHtml([
            postForm(`${taskHref(taskId)}/accept-revision`, joinHtml([
              pendingRevision.authorityKind === "authority-change"
                ? html`<input type="password" name="token" placeholder="approval password" required autocomplete="current-password">`
                : "",
              html`<button type="submit">${pendingRevision.authorityKind === "authority-change" ? html`Approve changes &amp; continue` : html`Use revised plan &amp; continue`}</button>`,
            ]), { attrs: { class: "inline" }, hidden: { "revision-id": pendingRevision.id } }),
            postForm(`${taskHref(taskId)}/reject-revision`, html`<button type="submit" class="quiet">Keep current plan</button>`, { attrs: { class: "inline" }, hidden: { "revision-id": pendingRevision.id } }),
          ]),
        html`</div>`,
      ]);
  const history =
    ledger.history.length <= 1
      ? ""
      : joinHtml([
        html`<details class="plan-revision-history"><summary>Revision history (${ledger.history.length})</summary>`,
        joinHtml(ledger.history.map(
          one => html`<p class="row"><span class="mono">rev ${one.revision}</span> <span class="badge">${sentenceCase(one.status)}</span> <span class="meta">${one.author} · ${whenTime(one.createdAt)}</span> — ${one.reason}</p>`,
        ), "\n"),
        html`</details>`,
      ]);
  return joinHtml([
    html`<div class="card plan-revision"><span class="eyebrow">plan updated</span><h2>Using plan revision ${current.revision}</h2>`,
    html`<p class="meta">${current.reason}${current.evidenceLink === null ? "" : ` · evidence: ${current.evidenceLink}`}</p>`,
    pending,
    history,
    html`</div>`,
  ]);
}

export function executionPlanHtml(document: string, compact = false): Html {
  const parsed = parseExecutionPlanDocument(document);
  if (!parsed.ok) return html`<pre class="recap plan-doc">${document}</pre>`;
  const plan = parsed.document;
  const items = (values: string[], ordered = false): Html =>
    ordered ? html`<ol>${values.map(value => html`<li>${value}</li>`)}</ol>` : html`<ul>${values.map(value => html`<li>${value}</li>`)}</ul>`;
  return joinHtml([
    html`<div class="execution-plan${compact ? " execution-plan-compact" : ""}">`,
    html`<div class="execution-approach"><span class="approval-label">approach</span><p>${plan.approach}</p></div>`,
    html`<div class="execution-milestones"><span class="approval-label">milestones</span>${items(plan.milestones, true)}</div>`,
    html`<div class="execution-support"><div><span class="approval-label">dependencies</span>${items(plan.dependencies)}</div>`,
    html`<div><span class="approval-label">risks &amp; mitigations</span>${items(plan.risks)}</div></div>`,
    html`<div class="execution-proof"><span class="approval-label">proof of done</span>${items(plan.proof)}</div>`,
    html`</div>`,
  ]);
}
/** One plan revision, its document verified before a byte renders — the
 * same verify-then-read discipline as `planViewOf`, just carrying the
 * ledger row's own facts alongside the text. `id: null` marks the
 * read-only revision-1 projection for a task with no `plan_revision` rows
 * yet (c1). */
export type RevisionDocView = {
  id: number | null;
  revision: number;
  status: PlanRevisionStatus;
  reason: string;
  evidenceLink: string | null;
  author: string;
  kind: PlanRevisionKind;
  authorityKind: "plan-only" | "authority-change";
  changedFields: string[];
  document: string;
  sha256: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
};

export type PlanRevisionLedgerView = { current: RevisionDocView | null; pending: RevisionDocView | null; history: RevisionDocView[] };

export type MilestoneProgressView = { id: string; description: string; state: MilestoneState; note: string | null };

/** The revision batch a task's approval screen restates, or the named reason it cannot. */
export type RevisionView =
  | {
      sourceTask: string;
      sourceRun: number;
      /** What kind of brief this is — annotations, a CI repair, a criterion repair. */
      kind: "annotations" | "ci-repair" | "criterion-repair";
      comments: { path: string | null; line: number | null; note: string; author: string }[];
      /** The lineage and ACTUAL terms (contract handoff task 2), read from
       * the child's own rows — the same projection chat and the approval
       * card restate. */
      lineage: RevisionLineage | null;
    }
  | { problem: string };

/**
 * A revision's lineage and ACTUAL terms, in the same words on the task
 * page, the approval card, and chat (contract handoff task 2): which
 * source and build it revises, the ancestry to its root, the terms the
 * child really carries (read from its own scope — never restated from the
 * brief), what is re-resolved for THIS approval, what never inherits, and
 * — when the task continues a repair chain — the attempts used against
 * the signed cap.
 */
export function revisionLineageWords(lineage: RevisionLineage): string[] {
  const words: string[] = [];
  if (lineage.problem !== undefined) words.push(`lineage verification gap: ${lineage.problem}; no automatic repair allowance can be inferred`);
  const chain = lineage.ancestors.length > 1 ? ` · lineage ${lineage.ancestors.join(" → ")}` : "";
  words.push(`revises ${lineage.sourceTask}${lineage.sourceRun === null ? "" : ` (build #${lineage.sourceRun})`}${chain}`);
  if (!lineage.sourceHadScope) {
    words.push("the source had no scope — nothing was inherited; the placeholder rubric waits for a real one");
  } else if (lineage.terms !== null) {
    const terms = lineage.terms;
    words.push(
      `inherited terms, as they stand now: ${qualityModeTitle(terms.qualityMode)} quality · ` +
        `${terms.permissionMode === "bypassPermissions" ? "full access" : "auto permissions"} · ` +
        `${terms.budgetMicrousd === null ? "no attempt cap" : `$${(terms.budgetMicrousd / 1_000_000).toFixed(2)} attempt cap`} · ` +
        `${terms.exclusions ? "its exclusions" : "no exclusions"} · ${terms.touches === 0 ? "any path" : `${terms.touches} path limit${terms.touches === 1 ? "" : "s"}`} · ` +
        `${terms.criteria} criteri${terms.criteria === 1 ? "on" : "a"}${terms.routeOverrides === 0 ? "" : ` · ${terms.routeOverrides} agent override${terms.routeOverrides === 1 ? "" : "s"}`}`,
    );
  }
  words.push("re-resolved for this approval: the agents route — a yes on the source never covers it");
  words.push("never inherited: the source's approval, publication and merge grants");
  if (lineage.repair !== null) {
    const repair = lineage.repair;
    words.push(
      `repair chain rooted at ${repair.rootTask}: ${repair.attemptsUsed} attempt${repair.attemptsUsed === 1 ? "" : "s"} used` +
        `${repair.cap === null ? " — each further attempt needs your yes" : ` of ${repair.cap} automatic · ${repair.remaining} remaining`}` +
        `${repair.thisAttempt === null ? "" : ` · this is attempt ${repair.thisAttempt}`}${repair.via === null ? "" : ` · continued through ${repair.via}`}`,
    );
  }
  return words;
}

export function revisionLineageHtml(lineage: RevisionLineage | null): Html {
  if (lineage === null) return html``;
  return html`<ul class="meta revision-lineage">${revisionLineageWords(lineage).map(one => html`<li>${one}</li>`)}</ul>`;
}

export function taskBodyParts(data: {
  /** Until the first Ready result: show the task's way there (onboarding). */
  guide?: boolean;
  /** What the last attempt missed and what to change, shown when the task failed. */
  failure?: FailureExplanation | null;
  /** Run checks in place, for a status row that offers it. */
  runChecks?: { action: string; level: "quick" | "full"; returnTo: string } | null;
  /** The demo database: no check runs here, and the Checks row says so. */
  demo?: boolean;
  assignment?: AssignmentSnapshot | null;
  checkProgress?: CheckProgress | null;
  rootId?: string;
  rootTitle?: string;
  /** Markup the caller rendered (the version history). */
  history?: Html;
  versionLabel?: string | null;
  status?: DisplayStatus;
  task: Task;
  /** Shared read-side lifecycle answer; the atomic claim still re-proves it. */
  dispatch?: DispatchDiagnosis | null;
  /** v52: the exact-run Stop / Stopping / Resume control. */
  control?: TaskControlView;
  strikes: number;
  /** v102: who filed it, and the project's approval rules as they bear on this task (null: none apply). */
  filer?: { name: string | null; kind: string } | null;
  budgetHold?: string | null;
  policyHold?: string | null;
  approvalRules?: { words: string; votes: string[]; needsTwo: boolean } | null;
  plan: "requested" | "drafted" | null;
  planDocument: string | null;
  planAuto?: boolean;
  /** Hash of the verified plan artifact currently shown. */
  planSha?: string | null;
  /** The drafted plan's contract record (contract handoff, task 1). */
  planContract?: PlanContractView | null;
  /** Adaptive execution plans (v44): the revision ledger and live milestone
   * projection — null for a task with no plan at all. */
  planRevisions?: PlanRevisionLedgerView | null;
  milestoneProgress?: MilestoneProgressView[] | null;
  /** v34: what this task delivers, and the scout's report when one exists. */
  deliverable?: "branch" | "report";
  report?: ReportView | null;
  revision?: RevisionView | null;
  /** v40: this task's own place in a bounded repair chain — computed
   * independent of `completion` (a freshly drafted, unapproved repair has
   * no run yet, so it must not wait for one to say so). `completion`'s own
   * branches render it too, once a run exists; this is the fallback for
   * the moment before that, so "awaiting approval" is never invisible. */
  repairChain?: RepairChainRow | null;
  publication?: Publication | null;
  repo: string | null;
  /** Immutable filing provenance (v12) — the approver sees which door
   * filed this (console, cli, intake, template:<name>) at the yes. */
  filedVia?: string | null;
  /** Coordinator provenance when an agent filed this; null otherwise. */
  coordinator?: { label: string; filedAgo: string | null } | null;
  holds: Hold[];
  claimed: boolean;
  /** What this task waits for — blockers outside this console's ceiling
   * are named but carry no state and no link. */
  waitsFor?: { id: string; title: string | null; state: string | null; admitted: boolean }[];
  /** Open tasks a "wait for" select may offer (this console's view only). */
  waitCandidates?: { id: string; title: string }[];
  /** The run whose lease is the CURRENT live claim — computed by the data
   * layer; the renderer never guesses liveness from a null outcome. */
  liveRunId?: number | null;
  /** What the agent did last on that live run, and when (task-activity.ts). */
  activity?: RunActivity | null;
  /** Workers that are both alive and authorized for this task's project. */
  worker?: { answering: number; registered: number; totalRegistered: number; lastHeard: string | null };
  /** Unmet capabilities that keep this exact task out of dispatch. */
  gaps?: Gap[];
  /** Whether this serve asserted its runner — the live file view exists. */
  peekable?: boolean;
  /** Where the task stands in its own column, from the data layer. */
  position?: { position: number; total: number; column: string | null } | null;
  /** The tracker item this task stands for, when it is external work. */
  mirror?: ExternalMirror | null;
  scope: Scope | null;
  /** What the approval nonce/digest bind: scope digest, or the joint fingerprint. */
  approvalDigest?: string | null;
  spendDefaults?: { buildPerRunMicrousd: number | null } | null;
  /** Installation starting value for a task that has no profile yet. */
  permissionDefault?: UnattendedPermissionMode;
  /** Durable choice for this task, when one was explicitly made. */
  permissionMode?: UnattendedPermissionMode | null;
  /** Installation starting value and this task's explicit evidence depth. */
  qualityDefault?: QualityMode;
  qualityMode?: QualityMode | null;
  /** The phase route (v47) and whether this session may edit it. */
  route?: RouteView | null;
  canEditRoute?: boolean;
  runs: Run[];
  /** Proof produced by the newest finished attempt. The two booleans are
   * machine facts about immutable, hash-addressed artifacts — never inferred
   * from the agent's prose. `proofVerdict` is the closed machine-authored
   * verdict (Priority 2), computed once at completion and never re-derived
   * here — null only for a run that predates the proof system. */
  completion?: {
    runId: number;
    outcome: string | null;
    hasTerminalDiff: boolean;
    hasHandoff: boolean;
    proofVerdict: ProofVerdict | null;
    /** v40: the verdict BEFORE an independent reviewer's judgements were
     * folded in — null when no review has folded (every run before this
     * migration, and every run no review has touched). */
    machineVerdict: ProofVerdict | null;
    proofReasons: string[];
    proofMatrix: CriterionMatrixRow[];
    proofMatrixLinks: EvidenceLinkMap;
    proofAccepted: boolean;
    /** v51: the run's signed quality mode — the policy semantic coverage is
     * read under (default: review optional; strict: review required). */
    qualityMode?: "default" | "strict";
    /** v40: this run's own place in a bounded repair chain, if any. */
    repairChain: RepairChainRow | null;
    /** v50: every root review attempt of this result and what the
     * allowance still admits; null when no review was ever asked for. */
    reviewRetry?: ReviewRetryState | null;
    /** The same review, as the shared projection reads it (review fixes). */
    review?: ReviewFacts | null;
    /** Priority 2's concise, shared result package. */
    receipt: CompletionReceiptView | null;
  } | null;
  /** v50: whether this session may ask for a review retry (an approver's
   * browser session — the same standing `task review` demands). */
  canRetryReview?: boolean;
  decisions: Decision[];
  incidents: Incident[];
  /** Pending coordinator proposals on this task (mate arc v3), with the decisions their answer cards name. */
  coordinatorProposals?: { rows: CoordinatorProposal[]; decisions: Map<number, Decision>; now: Date } | null;
  /** Operator steering notes (arc 1), delivery state included. */
  steering?: SteerNote[];
  /** The publication grant the publisher would act under — from
   * publicationGrantFor(repo) only; null when none, or no project. */
  grant?: PublicationGrant | null;
  /** The pull request opened through Complete (its state, link, CI and merge), or the offer to open one for a
   * result already marked complete; null when neither applies. */
  pullRequest?: TaskPullRequest | null;
  /** The task's whole family (the original and its revisions) and every attempt across it, for the thread. */
  family?: { root: { id: string; title: string; createdAt: string; goal?: string | null }; versions: { id: string; title: string; state: string }[]; runs: (Run & { taskId: string })[] } | null;
  /** Degraded composition (slice 1c). "sensitive": the page carries a
   * password ceremony, so no live poller runs, the attempt panel is a
   * static line, and open decisions render link-only — decided by the page
   * wrapper from the rendered body itself. "pane": the body is embedded in
   * the workbench's selected-task pane, which carries no run pollers, so
   * only the attempt panel degrades. */
  degraded?: "sensitive" | "pane";
  csrf: string;
  nonce: string;
  scopeDraft?: URLSearchParams;
  /** Arrived to edit the plan (?edit=plan): the approval sheet opens its editor. */
  editPlan?: boolean;
  cancelDraft?: string;
  problem: string | null;
  now: Date;
}): { html: Html; view: BrowserTaskView } {
  const { task, scope } = data;
  const stopControlsActive = data.control !== undefined && ["stopping", "paused", "review-stopped"].includes(data.control.kind);
  // The result's shared status (workspace package 1): the same projection
  // the Work row, the focused chat, and the review cockpit render for this
  // run, so a done task with failed or missing proof never wears a bare
  // "done" badge here while another surface says otherwise.
  // The receipt re-verified the stored bytes (repair 2026-09-14), so the
  // box wears the receipt's own status whenever a receipt exists — the
  // two never disagree on one page about damaged evidence.
  const resultStatus =
    task.state !== "done"
      ? null
      : data.completion?.receipt !== null && data.completion?.receipt !== undefined
      ? receiptStatusOf(data.completion.receipt)
      : resultStatusOf(
          data.completion === null || data.completion === undefined
            ? null
            : {
                runId: data.completion.runId,
                role: data.runs.find(one => one.id === data.completion?.runId)?.role ?? null,
                outcome: data.completion.outcome,
                verdict: data.completion.proofVerdict,
                reasons: data.completion.proofReasons,
                accepted: data.completion.proofAccepted,
                recordComplete: data.completion.hasHandoff && data.completion.hasTerminalDiff,
                review: data.completion.review ?? null,
              },
          publicationFactsOf(data.publication ?? null),
        );
  const status = data.status ?? workStatusOf({ id: task.id, title: task.title, repo: data.repo, state: task.state, updatedAt: task.updatedAt, dispatch: data.dispatch ?? null, result: null, publication: null, liveRunId: data.liveRunId ?? null, control: data.control ?? { kind: "none" } }, resultStatus ?? undefined);
  // A review in flight leads the status box too (review fixes, finding
  // 4): the box keeps its recorded-verdict sentence as history under the
  // review's own words, and reads neutral rather than ok/problem while the
  // machine is still deciding.
  const inReview = resultStatus !== null && REVIEW_TOKENS.has(resultStatus.token);
  const act = (verb: string, label: string, hidden: Record<string, string> = {}): Html =>
    postForm(`${taskHref(task.id)}/${verb}`, html`<button type="submit">${label}</button>`, { attrs: { class: "inline" }, hidden });

  // The active attempt panel (slice 1c): the run whose lease is the task's
  // CURRENT claim, named by its one unambiguous identity — build number and
  // worker (runsFor mixes roles newest-first, so an "attempt N" ordinal is
  // undefined and not used). The live peek and transcript embed here,
  // polled from the RUN's own authenticated fragments; a serve that never
  // asserted its runner says so in the same words the run page uses; a
  // page carrying a password ceremony degrades to the static line.
  const liveRunId = data.liveRunId ?? null;
  const liveRun = liveRunId === null ? undefined : data.runs.find(one => one.id === liveRunId);
  const liveHistoryRunId = data.control?.kind === "stop" && data.control.role === "reviewer" && data.completion?.review?.reviewerAlive === true ? data.control.run : liveRunId;
  const degraded = data.degraded === "sensitive";
  const attemptPanel = ((): Html | "" => {
    if (liveRunId === null || liveRun === undefined) return "";
    const minutes = Math.max(0, Math.round((data.now.getTime() - new Date(liveRun.startedAt).getTime()) / 60_000));
    const head = html`<p><strong>Build #${liveRun.id} · ${liveRun.runner} · running <time data-elapsed-since="${liveRun.startedAt}">${minutes}m</time></strong></p>`;
    const door = html`<p class="row"><a href="/r/${liveRun.id}">full build view →</a></p>`;
    if (data.degraded !== undefined) {
      return html`<div class="card attempt-live" data-live-run="${liveRun.id}">${head}<p class="meta">${data.degraded === "sensitive" ? "This page carries a password ceremony, so the live view stays on the build page" : "The live view is on the build page"}</p>${door}</div>`;
    }
    // With the live file view off there is nothing live to show here: no panel (the build's own page says why).
    if (data.peekable !== true) return "";
    const peek = html`<p class="meta">What is changing right now</p><div id="run-peek"><p class="meta">Watching… the first look lands within 15 seconds</p></div><p class="meta" id="run-peek-stamp"></p>`;
    const transcript =
      liveRun.provider !== "claude"
          ? html`<p class="meta">The live transcript needs the claude harness for now — this build runs on ${liveRun.provider}</p>`
          : html`<p class="meta">What the agent is saying · display only — this is not evidence, and the machine running the agent could alter it</p><pre id="live-transcript" class="mono" style="max-height:18rem;overflow:auto;white-space:pre-wrap"></pre><p class="meta" id="live-transcript-state"></p>`;
    return html`<div class="card attempt-live" data-live-run="${liveRun.id}">${head}${peek}${transcript}${door}</div>`;
  })();

  // One truthful answer to the first question on a queued task: "will this
  // run?" The badge alone cannot distinguish approval, dependency,
  // capability, and worker gates. This card does, in priority order, and
  // gives the nearest concrete repair rather than making the operator infer
  // it from the rest of the page.
  const dispatchStatus = ((): Html => {
    // data-work-status is the shared projection's token (package 1) —
    // the same one the Work row, chat, and cockpit carry for this task.
    const workToken = resultStatus?.token ?? data.dispatch?.code ?? "unknown";
    // A diagnosis under Task options: the exact technical reason, one tap
    // away from the shared headline (task-status.ts). Red only when that
    // headline is Failed.
    const headline = status.label;
    const box = (kind: "ok" | "problem", title: string, detail: Html | string, code?: string, controls: Html | "" = ""): Html =>
      html`<div class="${kind === "problem" && !inReview && headline === "Failed" ? "problem" : "answered"} dispatch-status" id="run-status" data-dispatch-status="${code ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}" data-work-status="${workToken}"><div class="dispatch-copy"><strong>${inReview ? "Recorded checks" : title}</strong><span class="meta">${detail}</span></div>${controls}</div>`;

    if (task.state !== "done") {
      const diagnosis = data.dispatch ?? null;
      if (diagnosis === null) return box("problem", "Dispatch unknown", "Refresh this task before relying on its scheduler state.", "unknown");
      if (diagnosis.code === "running" && liveRun !== undefined) {
        return box("ok", diagnosis.summary, html`Worker <span class="mono">${liveRun.runner}</span> owns <a href="/r/${liveRun.id}">build #${liveRun.id}</a>.`, diagnosis.code);
      }
      const blocker = diagnosis.blockerTaskId === null
        ? null
        : (data.waitsFor ?? []).find(one => one.id === diagnosis.blockerTaskId);
      const action = ((): Html | "" => {
        switch (diagnosis.action) {
          case "start-worker": return "";
          case "write-scope": return html` <a href="#scope">Write the success contract</a> or use <strong>plan first</strong>.`;
          case "select-agent": return html` <a href="#scope">Choose an available provider and model</a>.`;
          case "approve-scope": return html` <a href="#approve">Review and sign the exact scope</a>.`;
          case "answer-decision": return html` <a href="#decisions">Answer the waiting question</a>.`;
          case "unhold": return html` Use <strong>Remove hold</strong> when it can continue.`;
          // The reason is the detail itself; Retry is the status card's own act, said once.
          case "retry-task": return "";
          case "repair-capability": return html` <a href="/caps">Repair the requirement</a>.`;
          case "repair-dependency":
            return blocker?.admitted === true
              ? html` <a href="${taskHref(blocker.id)}">Review that task</a>.`
              : "";
          default: return "";
        }
      })();
      const repairControls = ((): Html | "" => {
        if (diagnosis.action !== "repair-dependency" || blocker == null || data.csrf === "") return "";
        const endpoint = `${taskHref(task.id)}/repair-dependency`;
        const repairForm = (className: string, operation: string, body: Html): Html =>
          postForm(endpoint, body, { attrs: { class: className }, hidden: { blocker: blocker.id, operation } });
        const retry = blocker.admitted && blocker.state === "failed"
          ? repairForm("dependency-repair-retry", "retry", html`<button type="submit">Try that task again</button>`)
          : "";
        const unlink = repairForm("dependency-repair-unlink", "unlink", html`<button type="submit" class="quiet">Continue without it</button>`);
        const standing = new Set((data.waitsFor ?? []).map(one => one.id));
        const replacements = (data.waitCandidates ?? []).filter(one => !standing.has(one.id));
        const replace = replacements.length === 0
          ? ""
          : repairForm("dependency-repair-replace", "replace", html`<label class="dependency-repair-label">Choose another task that must finish first<select name="replacement" aria-label="another task that must finish first">${replacements.map(one => html`<option value="${one.id}">${one.title}</option>`)}</select></label><button type="submit" class="quiet">Wait for selected task</button>`);
        return html`<div class="dependency-repair-actions" aria-label="ways to continue this task"><p class="meta dependency-repair-help">Choose another task that must finish first, or let this task continue without it.</p>${retry}${replace}${unlink}</div>`;
      })();
      const recoveryControl = ((): Html | "" => {
        if (stopControlsActive || diagnosis.action === null || diagnosis.action === "repair-dependency") return "";
        if (diagnosis.action === "start-worker") {
          const firstConnection = diagnosis.code === "no-worker-registered";
          return joinHtml([
            html`<details class="dispatch-recovery" open><summary>${dispatchActionLabel(diagnosis)}</summary><div class="dispatch-recovery-body">`,
            firstConnection
              ? html`<p>Toolroll is open, but this project has not been connected to a builder yet.</p><p>On the machine where the project lives, open that folder and run:</p>`
              : html`<p>Toolroll is open, but this project's builder stopped checking in. Reopen Toolroll on the machine where the project lives.</p><p>If you normally start it from a terminal, open the project folder and run:</p>`,
            html`<code class="dispatch-recovery-command">toolroll up</code>`,
            firstConnection
              ? html`<p class="meta">This is the normal start command: it opens the app, connects the project, and starts its builder. Keep Toolroll running; approved tasks begin automatically.</p>`
              : html`<p class="meta">This task resumes automatically when the builder reconnects. You do not need to file or approve it again.</p>`,
            html`<p><a href="/system">See connection status →</a></p></div></details>`,
          ]);
        }
        // Never a link to this page's own acts: Retry sits on the status card and below.
        const href = diagnosis.action === "retry-task" ? null : taskRecoveryHref(task.id, diagnosis);
        return href === null ? "" : html`<a class="button-link dispatch-action-link" href="${href}">${dispatchActionLabel(diagnosis)}</a>`;
      })();
      const positive = diagnosis.code === "running" || diagnosis.code === "ready" || diagnosis.code === "planning-ready" || diagnosis.code === "scouting-ready";
      const status = diagnosis.code === "ready" ? "ready-to-run" : diagnosis.code;
      const repairingDependency = diagnosis.action === "repair-dependency" && blocker !== null;
      const dependencyDetail =
        blocker?.admitted === true
          ? html`This task was waiting for <strong>${blocker.title ?? blocker.id}</strong>, but that task was ${blocker.state ?? "stopped"}.${action}`
          : "This task is waiting for other work that did not finish.";
      return box(
        positive ? "ok" : "problem",
        repairingDependency ? "Choose what happens next" : diagnosis.summary,
        repairingDependency ? dependencyDetail : html`${diagnosis.detail}${action}`,
        status,
        repairControls || recoveryControl,
      );
    }
    if (task.state === "done") {
      const proof = data.completion ?? null;
      if (proof === null || resultStatus === null) {
        return box("problem", "Marked done without a build record", "The task is done, but no finished attempt is recorded, so there is nothing to verify.", "no-build-record");
      }
      if (data.assignment?.receipt?.runId === proof.runId) {
        const accepted = data.assignment.receipt.proofAcceptance;
        return joinHtml([
          html`<details class="dispatch-proof-details"><summary>Previous assessment</summary><div class="dispatch-proof-body">`,
          html`<p class="meta">Saved assessment history. Current task status and checks are shown above.</p>`,
          accepted === null ? "" : html`<p class="meta">Accepted with an exception by ${accepted.approver}. Check results are unchanged.${accepted.note === null ? "" : ` ${accepted.note}`}</p>`,
          proof.proofReasons.length === 0 ? "" : html`<ul>${[...new Set(proof.proofReasons.map(plainReasonWords))].map(reason => html`<li>${reason}</li>`)}</ul>`,
          criterionMatrixHtml(proof.proofMatrix, { compact: true, runId: proof.runId, links: proof.proofMatrixLinks, verdict: proof.proofVerdict }),
          semanticCoverageHtml(proof.proofMatrix, proof.qualityMode ?? "default"), html`</div></details>`,
        ]);
      }
      // v50: the independent review's own card — attempt counts, what is
      // running or queued, the latest failure in words, and the ONE
      // explicit act (Retry review) exactly when the allowance admits it.
      const reviewCard = reviewRetryPanel(task.id, proof.runId, proof.reviewRetry ?? null, {
        csrf: data.csrf,
        canAct: data.canRetryReview === true,
        returnTo: null,
      });
      const withReview = (...parts: Array<Html | "">): Html => joinHtml([reviewCard, ...parts]);
      // A no-change conclusion never owes a proof — there is no diff to
      // check acceptance criteria or a changed-path claim against — so it
      // keeps reading on the two presence facts alone, exactly as before
      // the proof system existed (the "attested floor" this preserves).
      if (proof.outcome === "no-change") {
        const missing = [proof.hasHandoff ? null : "agent handoff", proof.hasTerminalDiff ? null : "terminal diff"]
          .filter((one): one is string => one !== null);
        return withReview(missing.length > 0
          ? box(
              "problem",
              resultStatus.label,
              html`<a href="/r/${proof.runId}">Build #${proof.runId}</a> concluded no change was needed, but its ${missing.join(" and ")} is missing.`,
              resultStatus.token,
            )
          : box(
              "ok",
              resultStatus.label,
              html`<a href="/r/${proof.runId}">Build #${proof.runId}</a> concluded no change was needed; its handoff and machine-captured diff are on record.`,
              resultStatus.token,
            ));
      }
      // A built run's verdict is the machine's own — computed once at
      // completion by adjudicate() (Priority 2), never re-derived here.
      // Acceptance changes the CLASS (problem → ok) and the words, never
      // the underlying token: the surfaces still agree on what happened.
      const accepted = proof.proofAccepted;
      const humanReview = manualReviewOnly({ verdict: proof.proofVerdict ?? "", reasons: proof.proofReasons, matrix: proof.proofMatrix });
      // Accepting contradictory or incomplete evidence is an explicit,
      // recorded exception—not the ordinary magenta approval ceremony.
      const acceptForm =
        accepted || data.csrf === ""
          ? ""
          : html`<details class="proof-exception"><summary>${humanReview ? "Accept result" : "Accept with exception"}</summary>${
            postForm(`${taskHref(task.id)}/accept-proof`, html`<input type="text" name="note" maxlength="500" placeholder="${humanReview ? "What did you verify?" : "Why is this safe to accept?"}" aria-label="${humanReview ? "review note" : "exception reason"}" required><button type="submit">${humanReview ? "Accept result" : "Accept with exception"}</button>`, {
              attrs: { class: "proof-exception-form" },
              hidden: { run: proof.runId },
            })}</details>`;
      // v40: the machine's own pre-fold verdict, restated when a review
      // moved it — "the machine attested it; reviewer:codex contradicted
      // c2" — never pretending the machine always disagreed.
      const machineNote =
        !reviewConflict(proof.proofMatrix, proof.machineVerdict, proof.proofVerdict)
          ? ""
          : html`<p class="meta">An independent review found conflicting evidence.</p>`;
      const chainHtml = repairChainHtml(proof.repairChain);
      // v51: semantic coverage sits beside the matrix, never inside the
      // verdict word — what the independent reviewer settled, under the
      // signed policy, with every context gap named.
      const coverageHtml = semanticCoverageHtml(proof.proofMatrix, proof.qualityMode ?? "default");
      const proofDetails =
        proof.proofMatrix.length === 0 && machineNote === "" && isEmptyHtml(chainHtml)
          ? ""
          : html`<details class="dispatch-proof-details"><summary>${proof.proofMatrix.length === 0 ? "Verification details" : `${proof.proofMatrix.length} requirement${proof.proofMatrix.length === 1 ? "" : "s"}`} · View details</summary><div class="dispatch-proof-body">${criterionMatrixHtml(proof.proofMatrix, { compact: true, runId: proof.runId, links: proof.proofMatrixLinks, verdict: proof.proofVerdict })}${coverageHtml}${machineNote}${chainHtml}</div></details>`;
      // The publication fact is separate from the evidence fact: a PR or
      // an observed merge is named from its record; nothing is "deployed".
      const publicationWords =
        (data.publication === null || data.publication === undefined ? "" : ` ${receiptPublicationWords(publicationFactsOf(data.publication))}`) +
        // Shortened records say so here too (repair 2026-09-14).
        (proof.receipt === null ? "" : ` ${evidenceShortenedWords(proof.receipt.facts.evidenceHealth)}`).replace(/ $/, "");
      // Damaged evidence (repair 2026-09-14): the box wears the receipt's
      // own problem words — never "ok" with a verdict that predates the damage.
      if (resultStatus.token === "evidence-damaged") {
        return withReview(
          box("problem", resultStatus.label, html`<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished. ${resultStatus.detail}${publicationWords}`, "evidence-damaged"),
          html`<div class="proof-review-actions"><a class="button-link" href="/r/${proof.runId}">Review the evidence problems</a></div>`,
          proofDetails,
        );
      }
      if (proof.proofVerdict === "verified" && !accepted) {
        const recovered = verificationRecovered(proof.proofReasons);
        return withReview(box(
          "ok",
          resultStatus.label,
          recovered
            ? html`<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished. <span data-automatic-recovery="succeeded">Toolroll ran the approved setup automatically, then the project check passed.</span>${publicationWords}`
            : html`<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished as ${proof.outcome ?? "terminal"}, and the repository's approved verification command passed against it.${publicationWords}`,
          dispatchStatusToken("verified"),
        ), proofDetails);
      }
      if (proof.proofVerdict === "attested" && !accepted) {
        return withReview(box("ok", resultStatus.label, html`<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished as ${proof.outcome ?? "terminal"}. No independent project check ran: the checks listed are the agent's own report, and each item below is labeled by source.${publicationWords}`, dispatchStatusToken("attested")), proofDetails);
      }
      // A refuted, short, or absent verdict — and an accepted one, which
      // stays visibly an exception: the words never say checks passed.
      const machineToken = proof.proofVerdict === "refuted" ? dispatchStatusToken("refuted") : dispatchStatusToken("short");
      return withReview(
        box(
          accepted ? "ok" : "problem",
          resultStatus.label,
          html`<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished. ${verificationExplanation(proof.proofVerdict, proof.proofReasons)}${accepted ? html` An approver accepted it by hand; that acceptance leaves the machine's verdict above unchanged.` : ""}${publicationWords}`,
          machineToken,
        ),
        html`<div class="proof-review-actions"><a class="button-link" href="${reviewHref(task.id)}">${accepted ? "Review the recorded exception" : resultStatus.action?.label ?? "Review evidence"}</a>${acceptForm}</div>`,
        proofDetails,
      );
    }
    return box("problem", "Dispatch unknown", "Refresh this task before relying on its scheduler state.", "unknown");
  })();
  // Operator steering (arc 1): notes for the agent, each wearing exactly
  // where it stands — waiting, attached, proven delivered, or superseded.
  const steering = data.steering ?? [];
  const steerState = (one: SteerNote): string =>
    one.authorshipState !== "verified"
      ? "recorded before steering required a credential — never delivered"
      : one.supersededAt !== null
      ? "the task ended before this landed"
      : one.deliveredAt !== null
        ? `reached build #${one.attachedRun}`
        : one.attachedRun !== null
          ? `attached to build #${one.attachedRun} — delivery not yet proven`
          : "waiting for the next attempt";
  const steerRows = steering.length === 0 ? "" : joinHtml(steering.map(
    one => html`<p class="row"><span class="meta">${one.author} · ${whenTime(one.createdAt)} · ${steerState(one)}</span> ${one.note}</p>`,
  ), "\n");
  const steerForm =
    data.csrf === "" || task.state === "done" || task.state === "cancelled"
      ? ""
      : joinHtml([
        postForm(`${taskHref(task.id)}/steer`, html`<input type="text" name="note" placeholder="guidance for the next attempt" aria-label="steering note" style="width:100%;max-width:28rem"><button type="submit">Steer</button>`, { attrs: { class: "row" } }),
        html`<p class="meta">Lands when the next attempt starts — a running agent is not interrupted, and a note cannot widen the approved scope</p>`,
      ]);
  const steeringCard =
    steerRows === "" && steerForm === "" ? "" : html`<h2>Steering</h2>${steerRows}${steerForm}`;

  const holds =
    data.holds.length === 0
      ? ""
      : joinHtml([
        html`<h2>Holds</h2>`,
        joinHtml(data.holds.map(
          hold => html`<p class="row">${holdOwnerWords(hold.ownerKind)} — ${hold.reason}${hold.until === null ? "" : html` <span class="meta">until ${whenTime(hold.until)}</span>`}</p>`,
        ), "\n"),
        html`<p class="meta">Only your hold can be lifted here — waits caused by questions, incidents, or retry delays clear on their own</p>`,
      ]);

  const approval = approvalOf(scope);
  // A refused save from the sheet's in-place editor reopens that editor with
  // its draft; the full scope form below stays as it was.
  const inlineScopeDraft = data.scopeDraft?.has("requirement-new") === true;
  const scopeDraft = inlineScopeDraft ? undefined : data.scopeDraft;
  const scopeCard =
    scope === null
      ? html`<p class="meta">No scope proposed — nothing builds this until one is approved</p>`
      : joinHtml([
          html`<div class="card">`,
          html`<p><strong>Goal</strong></p><p class="recap">${scope.goal}</p>`,
          scope.outOfScope === null ? "" : html`<p><strong>Not this</strong></p><p class="recap">${scope.outOfScope}</p>`,
          scope.touches.length === 0 ? "" : html`<p class="scope-paths"><strong>Touches</strong> ${scope.touches.join(", ")}</p>`,
          html`<p><strong>Quality</strong> ${qualityModeTitle(scope.qualityMode ?? "default")}</p>`,
          acceptanceCeremonyHtml(scope.acceptance),
          approval.approved
            ? html`<p class="meta scope-seal">Approved by ${approval.by} · ${whenTime(approval.at)} · <span class="seal">signs ${shortDigest(scope.digest)}</span><span class="so-sr-only"> — approval binds to this exact wording</span></p>`
            : html`<p class="meta"><span class="seal">signs ${shortDigest(scope.digest)}</span> — approval binds to this exact wording</p><p class="meta">Not approved${approval.reason === "changed" ? " — approved once, then rewritten" : ""}</p>`,
          html`</div>`,
        ], "\n");

  // The scout's report (mate arc §10): title, summary, the document inert,
  // and each follow-up as a filing the operator makes with one tap. A
  // report that exists but cannot be verified is a named problem, never a
  // blank — the same rule as the revision brief.
  const reportCard =
    data.report === null || data.report === undefined
      ? data.deliverable === "report"
        ? html`<div class="card"><p><strong>Scout task</strong> <span class="meta">delivers a report, never a branch — a read-only session investigates the goal and its report appears here when it finishes</span></p></div>`
        : ""
      : !data.report.ok
        ? html`<div class="card"><p><strong>The report</strong></p><p class="meta">${data.report.problem} · <a href="/r/${data.report.run}">run ${data.report.run}</a></p></div>`
        : joinHtml([
            html`<div class="card report">`,
            html`<p><strong>${data.report.report.title}</strong> <span class="meta">the scout's report · <a href="/r/${data.report.run}">run ${data.report.run}</a></span></p>`,
            html`<p class="report-summary">${data.report.report.summary}</p>`,
            reportItemsHtml(data.report.report.items, data.report.shots, data.report.run),
            html`<pre class="recap plan-doc">${data.report.report.report}</pre>`,
            ...(data.report.report.followUps.length === 0
              ? []
              : [
                  html`<p><strong>Follow-ups the scout proposes</strong> <span class="meta">each files as a task in this repository; its scope still needs your approval</span></p>`,
                  ...data.report.report.followUps.map(
                    (one, index) => joinHtml([
                      html`<div class="follow-up"><p><strong>${one.title}</strong></p><p class="meta">${one.goal}</p>`,
                      data.csrf === "" || data.repo === null
                        ? html`<p class="meta">${data.repo === null ? "this task has no repository — file it by hand" : ""}</p>`
                        : postForm(`${taskHref(task.id)}/follow-up`, html`<button type="submit">File this follow-up</button>`, { attrs: { class: "inline" }, hidden: { index } }),
                      html`</div>`,
                    ]),
                  ),
                ]),
            html`</div>`,
          ], "\n");
  // The plan a planner drafted, when one exists: rendered inert above the
  // approval it proposes. The scope stays the contract; this is the road.
  // Adaptive execution plans (v44): once approved, the CURRENT revision's
  // text displays here — the same document the builder actually reads —
  // rather than the original artifact frozen at approval time; the edit
  // form and its staleness guard stay bound to that original artifact,
  // since editing is a pre-approval act this ledger does not touch.
  const currentRevisionForDisplay = data.planRevisions?.current ?? null;
  const displayedPlanDocument =
    currentRevisionForDisplay !== null && currentRevisionForDisplay.revision > 1
      ? currentRevisionForDisplay.document
      : data.planDocument;
  const displayedPlan = displayedPlanDocument === null ? null : parseExecutionPlanDocument(displayedPlanDocument);
  const planMilestoneCount = displayedPlan !== null && displayedPlan.ok ? displayedPlan.document.milestones.length : null;
  const planStanding =
    currentRevisionForDisplay !== null && currentRevisionForDisplay.revision > 1
      ? `approved · revision ${currentRevisionForDisplay.revision}`
      : approval.approved
        ? "approved"
        : "review before starting";
  // While the approval sheet is open it states any amendment; the plan
  // card does not repeat it (one #contract-amendment on the page).
  const sheetStatesContract = scope !== null && !approval.approved && data.plan === "drafted" && data.dispatch?.action !== "repair-dependency" &&
    !(data.revision != null && "problem" in data.revision) && scope.profileState !== "unresolved" && consentDoorOf(scope, data.route).open;
  const planCard =
    data.planDocument === null
      ? data.plan === "requested"
        ? data.revision != null && !("problem" in data.revision)
          ? html`<div class="card planner-status"><span class="planner-orb" aria-hidden="true"></span><p><strong>Updating the plan</strong><span class="meta">Adding your notes to the plan. You approve any change before it builds.</span></p></div>`
          : html`<div class="card planner-status"><span class="planner-orb" aria-hidden="true"></span><p><strong>Planning requested</strong><span class="meta">${data.planAuto ? "Automatic approval is enabled for a verified plan that preserves your filed contract. Amendments and unanswered questions still pause." : "The agent is inspecting the repository and drafting the goal, acceptance criteria, and approach. It will ask only if a missing answer changes the work."}</span></p></div>`
        : ""
      : joinHtml([
        approval.approved ? html`<details class="card planner-plan planner-plan-collapsed"><summary class="execution-plan-head">` : html`<section class="card planner-plan"><div class="execution-plan-head">`,
        html`<div><span class="eyebrow">execution plan</span><h2>${approval.approved ? `${planMilestoneCount ?? "Full"} step${planMilestoneCount === 1 ? "" : "s"} · open to review` : "How the agent will tackle this"}</h2>`,
        approval.approved ? html`<p class="meta">The agent can adapt this route when evidence changes; your approved outcome stays fixed.</p>` : "",
        html`</div><span class="plan-lock">${planStanding}</span>${approval.approved ? html`</summary><div class="planner-plan-body">` : html`</div>`}`,
        executionPlanHtml(displayedPlanDocument ?? data.planDocument),
        approval.approved || sheetStatesContract ? "" : planContractHtml(data.planContract ?? null, "full"),
        data.csrf === "" || data.planSha == null || approval.approved
          ? ""
          : html`<details class="plan-editor" id="plan-edit"><summary>Edit plan</summary>${postForm(`${taskHref(task.id)}/plan-edit`, joinHtml([
            html`<label>Plan details <span class="meta">Keep the five headings. Approval locks this version for the build.</span>`,
            html`<textarea name="plan-document" rows="14">${data.planDocument}</textarea></label>`,
            html`<button type="submit">Save plan</button>`,
          ]), { hidden: { "saw-plan": data.planSha } })}</details>`,
        approval.approved ? html`</div></details>` : html`</section>`,
      ]);

  const progressCard = milestoneProgressHtml(data.milestoneProgress);
  const revisionLedgerCard = planRevisionLedgerHtml(data.planRevisions, task.id, data.csrf);

  // The revision batch (M6.8), restated on the SAME screen as the approval
  // it belongs to: the approver sees exactly the comments the brief carries.
  // A brief that cannot be verified is a named problem, never a blank.
  const revisionCard =
    data.revision === null || data.revision === undefined
      ? ""
      : "problem" in data.revision
        ? html`<div class="card"><p><strong>Revision brief</strong></p><p class="meta">${data.revision.problem}</p></div>`
        : joinHtml([
            html`<div class="revision-card" data-revision-feedback>`,
            html`<p><strong>${data.revision.kind === "ci-repair" ? "CI repair" : data.revision.kind === "criterion-repair" ? "Criterion repair" : "Revision feedback"}</strong> <span class="meta">from <a href="/r/${data.revision.sourceRun}">build #${data.revision.sourceRun}</a></span></p>`,
            ...data.revision.comments.map(
              one => html`<p class="row"><span class="meta">${one.author}</span> ${one.path === null ? "" : html`<span class="mono">${one.path}${one.line === null ? "" : `:${one.line}`}</span> `}${one.note}</p>`,
            ),
            revisionLineageHtml(data.revision.lineage),
            html`</div>`,
          ], "\n");

  // The approval form restates every field the digest binds — an operator
  // approves what is on this form, not what is elsewhere on the page — and
  // requires the token typed again. The session got you here; only the
  // token agrees. The sheet shows the plan open in plain rows with one
  // Approve & start; the rest of the signed terms sit in its Details fold.
  // An unapprovable scope gets the problem and the edit road instead of a
  // password it cannot use.
  const consentDoor = consentDoorOf(scope, data.route);
  const revisionInApproval = scope !== null && !approval.approved && data.plan !== "requested" &&
    scope.profileState !== "unresolved" && consentDoor.open && data.dispatch?.action !== "repair-dependency" &&
    (data.revision == null || !("problem" in data.revision));
  const approveForm =
    scope === null || approval.approved || data.plan === "requested"
      ? ""
      : data.revision !== null && data.revision !== undefined && "problem" in data.revision
        ? html`<div class="card approve-form" id="approve"><p><strong>This task is waiting on you: approval is blocked.</strong></p><p class="meta">${data.revision.problem} — a revision approves only against a brief that verifies</p></div>`
        : scope.profileState === "unresolved"
          ? html`<div class="card approve-form" id="approve"><p><strong>This task is waiting on you: its scope cannot be approved yet.</strong></p>${profileWords(scope)}<p class="ceremony-road"><a class="button-link" href="#scope">Edit the scope to fix it →</a></p></div>`
        : !consentDoor.open
          ? consentClosedHtml(task.id, consentDoor, "task")
        : approvalSheetHtml({
          surface: "task",
          action: `${taskHref(task.id)}/approve`,
          csrf: data.csrf,
          nonce: data.nonce,
          digest: data.approvalDigest ?? scope.digest,
          returnTo: null,
          scope,
          planDocument: data.plan === "drafted" ? data.planDocument : null,
          planContract: data.plan === "drafted" ? data.planContract ?? null : null,
          revision: data.revision == null || "problem" in data.revision ? null : data.revision,
          revisionSourceHref: data.revision == null || "problem" in data.revision ? "" : `/r/${data.revision.sourceRun}`,
          repairChain: data.repairChain ?? null,
          route: data.route,
          coordinator: data.coordinator ?? null,
          deliverable: data.deliverable ?? "branch",
          editHref: data.csrf !== "" && data.planSha != null && data.planDocument !== null ? "#plan-edit" : "#scope",
          notNowHref: "/work",
          sticky: data.dispatch?.action === "approve-scope",
          earlier: { active: data.assignment?.earlierActive ?? 0, running: data.assignment?.earlierRunning ?? 0 },
          edit: data.csrf === "" ? null
            : { action: `${taskHref(task.id)}/scope`, draft: inlineScopeDraft ? data.scopeDraft ?? null : null, problem: inlineScopeDraft ? data.problem : null,
              open: data.editPlan === true, stepsHref: data.planSha != null && data.planDocument !== null ? "#plan-edit" : null },
        });

  const scopeForm = joinHtml([
    html`<details${scope === null || scopeDraft !== undefined ? html` open` : ""}><summary>${scope === null ? "Write the scope" : "Edit the scope"}${
      approval.approved ? " (editing voids the approval)" : ""
    }</summary>`,
    postForm(`${taskHref(task.id)}/scope`, joinHtml([
    "",
    scopeDraft === undefined || data.problem === null ? "" : html`<div class="problem" role="alert" id="scope-error">${data.problem}</div>`,
    html`<label>Goal<textarea name="goal" rows="3"${scopeDraft === undefined ? "" : html` autofocus aria-describedby="scope-error"`}>${scopeDraft?.get("goal") ?? scope?.goal ?? ""}</textarea></label>`,
    html`<label>Not this<textarea name="not" rows="2">${scopeDraft?.get("not") ?? scope?.outOfScope ?? ""}</textarea></label>`,
    html`<label>Touches <span class="meta">(one per line)</span><textarea name="touches" rows="2">${
      scopeDraft?.get("touches") ?? (scope?.touches ?? []).join("\n")
    }</textarea></label>`,
    html`<label>Acceptance <span class="meta">(required — one criterion per line: <code>statement | evidence,kinds | how</code>; evidence kinds are check, screenshot, changed-path, manual-review; id is optional and auto-numbered)</span><textarea name="acceptance" rows="3" placeholder="The button opens the settings panel | screenshot">${
      scopeDraft?.get("acceptance") ?? acceptanceToLines(scope?.acceptance ?? []).join("\n")
    }</textarea></label>`,
    ((): Html => {
      const defaults = data.spendDefaults ?? null;
      const budgetPrefill =
        scope?.budgetMicrousd != null
          ? (scope.budgetMicrousd / 1_000_000).toFixed(2)
          : defaults?.buildPerRunMicrousd != null
            ? (defaults.buildPerRunMicrousd / 1_000_000).toFixed(2)
            : "";
      return html`<label>Agent-reported usage cap <span class="meta">(optional — leave blank for uncapped subscription work)</span><input type="number" name="budget-usd" step="0.01" min="0.01" value="${scopeDraft?.get("budget-usd") ?? budgetPrefill}" placeholder="no cap"></label><p class="meta">Claude expresses this limiter in API-equivalent dollars even on a membership. It does not switch the run to API billing.</p>`;
    })(),
    ((): Html => {
      const profileMode: UnattendedPermissionMode | null =
        scope?.profile?.provider === "claude"
          ? scope.profile.permissionArgv === "bypassPermissions" ? "bypassPermissions" : "auto"
          : scope?.profile?.provider === "gemini"
            ? scope.profile.approvalArgv === "yolo" ? "bypassPermissions" : "auto"
            : scope?.profile?.provider === "codex" || scope?.profile?.provider === "openrouter"
              ? scope.profile.sandboxMode === "danger-full-access" ? "bypassPermissions" : "auto"
              : null;
      const selected: UnattendedPermissionMode = scopeDraft?.get("permission-mode") === "bypassPermissions" ? "bypassPermissions" : scopeDraft?.get("permission-mode") === "auto" ? "auto" : data.permissionMode ?? profileMode ?? data.permissionDefault ?? "auto";
      return html`<fieldset class="permission-field"><legend>Agent permissions</legend>${permissionModeChoices("permission-mode", selected)}<p class="meta permission-note">This task’s choice is sealed into its scope. Full access prevents permission prompts or sandbox limits from pausing supported unattended agents.</p></fieldset>`;
    })(),
    ((): Html => {
      const selected: QualityMode = scopeDraft?.get("quality-mode") === "strict" ? "strict" : scopeDraft?.get("quality-mode") === "default" ? "default" : scope?.qualityMode ?? data.qualityMode ?? data.qualityDefault ?? "default";
      return html`<fieldset class="permission-field"><legend>Quality</legend>${qualityModeChoices("quality-mode", selected)}<p class="meta permission-note">This choice is signed into the scope. Inspect the saved work and actual check results when it is ready. Publication and deployment need their own authorization.</p></fieldset>`;
    })(),
    html`<button type="submit">Save scope</button>`,
    "",
    ], "\n"), { attrs: { class: "scope-editor" }, hidden: { sawDigest: scopeDraft?.get("sawDigest") ?? scope?.digest ?? "" } }),
    html`</details>`,
  ], "\n");
  // 41_237 → "41k": token counts read at a glance; exactness lives on the run page.
  const compactCount = (count: number): string =>
    count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);

  // The attempt ledger (M5.5): every attempt with its provider, duration,
  // tokens, and dollars — or the honest word "unmeasured" — so a retry
  // storm reads as the spike it is instead of hiding inside a total.
  const minutesOf = (run: Run): string | null => {
    if (run.finishedAt === null) return null;
    const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
    return ms >= 0 ? `${Math.max(1, Math.round(ms / 60_000))}m` : null;
  };
  const tokensOf = (run: Run): string | null =>
    run.tokensIn === null && run.tokensOut === null
      ? null
      : `${run.tokensIn === null ? "?" : compactCount(run.tokensIn)}/${run.tokensOut === null ? "?" : compactCount(run.tokensOut)} tok`;
  // Ledger rows (slice 1c): the same row grammar as the portfolio's terminal
  // ledger — identity, outcome chip, one mono meta run of provider · model ·
  // duration · tokens · measured-or-unmeasured cost.
  const runRows = joinHtml(
        data.runs
          .map(run => {
            const bits = [
              run.provider,
              run.model,
              minutesOf(run),
              tokensOf(run),
              runCostWords(run, run.id === liveRunId),
              run.parentRun !== null ? `↳ of #${run.parentRun}` : null,
            ].filter((bit): bit is string => bit !== null);
            return html`<p class="row"><a href="/r/${run.id}" class="mono">#${run.id}</a> ${runOutcomeBadge(run, run.id === liveHistoryRunId)}${
              run.reason === null ? "" : html` <span class="meta">${reasonWords(run.reason)}</span>`} <span class="meta mono">${bits.join(" · ")}</span><span class="right meta mono">${whenTime(run.startedAt)}</span></p>`;
          }), "\n");
  const runs = data.runs.length === 0 ? "" : html`<h2>Attempts</h2>${runRows}`;

  // ---- the right rail (slice 1c) ------------------------------------------
  // Dollars stated per attempt set, measured or unmeasured in words — a
  // missing figure is never summed as $0.
  const spendWords = (rows: Run[]): string => {
    if (rows.length === 0) return "no attempt yet";
    const measured = rows.filter(one => one.costUsd !== null);
    const dollars = measured.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
    const subscription = measured.filter(one => one.authMode === "subscription");
    const subscriptionEquivalent = subscription.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
    const metered = measured.filter(one => one.authMode !== "subscription");
    const meteredDollars = metered.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
    // Tokens count only where an attempt reported them; a null report is
    // said, never summed as zero (commit-3 review, finding 2).
    const reported = rows.filter(one => one.tokensIn !== null || one.tokensOut !== null);
    const tokens = reported.reduce((sum, one) => sum + (one.tokensIn ?? 0) + (one.tokensOut ?? 0), 0);
    const tokenWords =
      reported.length === 0
        ? "tokens unreported"
        : reported.length < rows.length
          ? `${compactCount(tokens)} tokens from ${reported.length}/${rows.length} attempts`
          : `${compactCount(tokens)} tokens`;
    if (subscription.length > 0) {
      return [
        ...(metered.length > 0 ? [`$${meteredDollars.toFixed(2)} API-key usage`] : []),
        `$${subscriptionEquivalent.toFixed(2)} API-price equivalent from subscription usage (not an API charge)`,
        tokenWords,
        ...(measured.length < rows.length ? [`${rows.length - measured.length} attempt(s) unmeasured`] : []),
      ].join(" · ");
    }
    if (measured.length === rows.length) return `$${dollars.toFixed(2)} · ${tokenWords} · measured`;
    if (measured.length === 0) {
      return reported.length > 0
        ? `unmeasured — ${tokenWords}, no dollar figure reported`
        : rows.some(one => one.id === liveRunId)
          ? "unmeasured so far — the figure lands when the attempt finishes"
          : "not reported";
    }
    return `$${dollars.toFixed(2)} measured across ${measured.length}/${rows.length} attempts — ${rows.length - measured.length} unmeasured · ${tokenWords}`;
  };
  const thisAttempt = liveRun ?? data.runs[0];
  const prop = (key: string, value: Html | string): Html =>
    html`<p class="row"><span class="meta">${key}</span> <span class="mono">${value}</span></p>`;
  const economics = joinHtml([
    prop("this attempt", thisAttempt === undefined ? "no attempt yet" : spendWords([thisAttempt])),
    prop("task total", spendWords(data.runs)),
  ]);
  // "publishes as": push, open-PR, and merge are INDEPENDENT fields on the
  // grant — each phrased on its own; absent means exactly that.
  const publishesAs = (() => {
    const grant = data.grant ?? null;
    if (data.repo === null) return "no project — no publication grant can apply";
    if (grant === null) return "branch only — publishing is not set up";
    if (grant.publishOn === "complete") {
      return `pull requests to ${grant.githubRepo} into ${grant.base} when completed · ${grant.mergeWhenGreen === true ? "merges when checks pass" : "a person merges"} (${grant.mergeMethod ?? "squash"})`;
    }
    return [
      grant.capabilities.includes("push-branch") ? `may push ${grant.headPrefix}* to ${grant.githubRepo}` : "cannot push",
      grant.capabilities.includes("open-pr") ? `may open a PR against ${grant.base}${grant.draft ? " (draft)" : ""}` : null,
      grant.merge === true ? `may merge${grant.mergeMethod == null ? "" : ` (${grant.mergeMethod})`}` : "cannot merge",
    ].filter((part): part is string => part !== null).join(" · ");
  })();
  const publishesRow = prop("publishes as", publishesAs);
  // The property list (task page pass): worker and attempt, queue place,
  // the scope's standing with its seal, publication, spend — the key
  // facts a reader scans before anything else, in one row grammar.
  const workerRow =
    liveRun !== undefined
      ? prop("worker", html`${liveRun.runner} · <a href="/r/${liveRun.id}">build #${liveRun.id}</a> running`)
      : data.runs[0] !== undefined
        ? prop("last attempt", html`<a href="/r/${data.runs[0].id}">${runNoun(data.runs[0])} #${data.runs[0].id}</a> · ${data.runs[0].role === "planner" && data.runs[0].reason === "plan-drafted" ? "planned" : data.runs[0].reason === "interrupted" ? "interrupted" : data.runs[0].id === liveHistoryRunId ? "running" : data.runs[0].outcome ?? "never finished"} · ${data.runs[0].runner}`)
        : "";
  const queueRow =
    data.position !== null && data.position !== undefined && task.state === "queued"
      ? prop("queue", html`${data.position.position} of ${data.position.total}${data.position.column === null ? " in the shared queue" : html` in ${data.position.column}'s queue`} · <a href="/board?view=order">reorder</a>`)
      : "";
  const scopeRow =
    scope === null
      ? prop("scope", "none yet")
      : approval.approved
        ? prop("approved scope", html`<span class="seal">signs ${shortDigest(scope.digest)}</span> · ${qualityModeTitle(scope.qualityMode ?? "default")} · approved by ${approval.by} · ${whenTime(approval.at)}`)
        : prop("scope", approval.reason === "changed" ? "rewritten since its approval — needs a new yes" : "not approved");
  const strikesRow = data.strikes > 0 ? prop("strikes", `${data.strikes} failed attempt(s)`) : "";
  const propsCard = html`<div class="card props">${workerRow}${queueRow}${scopeRow}${publishesRow}${economics}${strikesRow}</div>`;
  // The same facts for the rebuilt page, row for row.
  const facts: BrowserTaskFact[] = [];
  const lastRun = data.runs[0];
  if (liveRun !== undefined) facts.push({ label: "Worker", parts: [`${liveRun.runner} · `, { label: `build #${liveRun.id}`, href: `/r/${liveRun.id}` }, " running"] });
  else if (lastRun !== undefined) facts.push({ label: "Last attempt", parts: [{ label: `${runNoun(lastRun)} #${lastRun.id}`, href: `/r/${lastRun.id}` },
    ` · ${lastRun.role === "planner" && lastRun.reason === "plan-drafted" ? "planned" : lastRun.reason === "interrupted" ? "interrupted" : lastRun.id === liveHistoryRunId ? "running" : lastRun.outcome ?? "never finished"} · ${lastRun.runner}`] });
  if (data.position !== null && data.position !== undefined && task.state === "queued") {
    facts.push({ label: "Queue", parts: [`${data.position.position} of ${data.position.total}${data.position.column === null ? " in the shared queue" : ` in ${data.position.column}'s queue`} · `, { label: "Reorder", href: "/board?view=order" }] });
  }
  facts.push(scope === null ? { label: "Scope", parts: ["none yet"] }
    : approval.approved ? { label: "Approved scope", parts: [{ seal: `signs ${scope.digest.length <= 12 ? scope.digest : `${scope.digest.slice(0, 12)}…`}` }, ` · ${qualityModeTitle(scope.qualityMode ?? "default")} · approved by ${approval.by}`, ...(approval.at === null ? [] : [" · ", { at: approval.at }])] }
    : { label: "Scope", parts: [approval.reason === "changed" ? "rewritten since its approval — needs a new yes" : "not approved"] });
  facts.push({ label: "Publishes as", parts: [publishesAs] });
  // v102: who asked for it, and what the project's approval rules need.
  if (data.filer != null) facts.push({ label: "Filed by", parts: [data.filer.name === null ? "automation" : data.filer.kind === "coordinator" ? `${data.filer.name}, through a coordinator` : data.filer.name] });
  if (data.approvalRules != null) {
    const votes = data.approvalRules.votes;
    facts.push({ label: "Approval rules", parts: [data.approvalRules.needsTwo && !approval.approved
      ? (votes.length === 0 ? "needs two approvers" : `approved by ${votes.join(", ")} · needs one more`)
      : data.approvalRules.words] });
  }
  // v103: everything an auditor asks about this task, printable or as JSON.
  facts.push({ label: "Audit", parts: [{ label: "Evidence pack", href: `${taskHref(task.id)}/evidence` }] });
  if (data.budgetHold != null) facts.push({ label: "Budget", parts: [`${data.budgetHold} · `, { label: "Spend", href: "/spend" }] });
  if (data.policyHold != null) facts.push({ label: "Policy", parts: [`${data.policyHold} · `, { label: "Policy", href: "/settings/policy" }] });
  // The pull-request card already says this once, with its action.
  if (data.publication !== null && data.publication !== undefined && data.pullRequest?.view == null) {
    const prHref = safePrUrl(data.publication.prUrl), pr = `PR #${data.publication.prNumber ?? "?"}`;
    facts.push({ label: "Published", parts: [prHref === null ? pr : { label: pr, href: prHref },
      ` · ${data.publication.state}${data.publication.remoteState !== null ? ` · ${data.publication.remoteState.toLowerCase()} on GitHub` : ""}${data.publication.lastCheckState !== null ? ` · CI ${data.publication.lastCheckState} at last observation` : " · no checks observed"}`] });
  }
  facts.push({ label: "This attempt", parts: [thisAttempt === undefined ? "no attempt yet" : spendWords([thisAttempt])] });
  facts.push({ label: "Task total", parts: [spendWords(data.runs)] });
  if (data.strikes > 0) facts.push({ label: "Strikes", parts: [`${data.strikes} failed attempt(s)`] });
  // Open decisions as the shared partial — answerable inline when the
  // page is not sensitive; link-only cards otherwise.
  const openDecisions = data.decisions.filter(one => one.state === "open" || one.state === "expired");
  const decisionRail =
    openDecisions.length === 0
      ? ""
      : html`<p id="task-questions"><strong>Questions</strong></p>${joinHtml(
        openDecisions
          .map(decision =>
            degraded
              ? html`<div class="decide-card" data-decision-id="${decision.id}"><p class="q">${decision.question}</p><p class="meta">${oneLineOf(decision.recap, 160)}</p><p class="meta"><a href="/d/${decision.id}">the full question →</a></p></div>`
              : decisionAnswerCard({ ...decision, taskId: task.id, repo: data.repo }, data.csrf, data.now, false),
          ), "\n")}`;
  const rail = joinHtml([decisionRail, propsCard].filter(part => part !== ""), "\n");

  // Spend by provider, from the same rows — dollars only where a provider
  // measured them, and the unmeasured said in words, never summed as $0.
  const spendCard = ((): Html | "" => {
    if (data.runs.length === 0) return "";
    const byProvider = new Map<string, { runs: number; tokensIn: number; tokensOut: number; costUsd: number; measured: number }>();
    for (const run of data.runs) {
      const entry = byProvider.get(run.provider) ?? { runs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, measured: 0 };
      entry.runs += 1;
      entry.tokensIn += run.tokensIn ?? 0;
      entry.tokensOut += run.tokensOut ?? 0;
      if (run.costUsd !== null) {
        entry.costUsd += run.costUsd;
        entry.measured += 1;
      }
      byProvider.set(run.provider, entry);
    }
    const lines = [...byProvider.entries()].map(([provider, spend]) => {
      const providerRuns = data.runs.filter(run => run.provider === provider);
      const subscriptionRuns = providerRuns.filter(run => run.authMode === "subscription" && run.costUsd !== null);
      const subscriptionEquivalent = subscriptionRuns.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
      const meteredRuns = providerRuns.filter(run => run.authMode !== "subscription" && run.costUsd !== null);
      const meteredCost = meteredRuns.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
      const dollars = subscriptionRuns.length > 0
        ? [
            ...(meteredRuns.length > 0 ? [`$${meteredCost.toFixed(2)} API-key usage`] : []),
            `$${subscriptionEquivalent.toFixed(2)} subscription API-price equivalent — not an API charge`,
            ...(spend.measured < spend.runs ? [`${spend.runs - spend.measured} unmeasured`] : []),
          ].join(" · ")
        : spend.measured === spend.runs
          ? `$${spend.costUsd.toFixed(2)}`
          : spend.measured === 0
            ? "dollar cost unmeasured"
            : `$${spend.costUsd.toFixed(2)} across ${spend.measured}/${spend.runs} measured`;
      return html`<p class="row"><span class="mono">${provider}</span> <span class="meta">${spend.runs} attempt(s) · ${compactCount(spend.tokensIn)} in / ${compactCount(spend.tokensOut)} out · ${dollars}</span></p>`;
    });
    return joinHtml(lines, "\n");
  })();

  const decisions =
    data.decisions.length === 0
      ? ""
      : html`<h2>Decisions</h2>${joinHtml(data.decisions.map(
          decision => html`<p class="row"><a href="/d/${decision.id}">${decision.question}</a> <span class="meta">${decision.state}${isOverdue(decision, data.now) ? " · overdue" : ""}</span></p>`,
        ), "\n")}`;

  const incidents =
    data.incidents.length === 0
      ? ""
      : html`<h2>Incidents</h2>${joinHtml(data.incidents.map(one =>
          one.resolvedAt === null
            ? html`<p class="row">${incidentWords(one.kind)} ${postForm(`/i/${one.id}/resolve`, html`<button type="submit">Resolve</button>`, { attrs: { class: "inline" } })}</p>`
            : html`<p class="row meta">${incidentWords(one.kind)} — resolved by ${one.resolvedBy ?? "?"}</p>`,
        ), "\n")}`;

  const stalled =
    task.state === "failed" || data.incidents.some(one => one.resolvedAt === null);
  const dependencyChoiceNeeded = data.dispatch?.action === "repair-dependency";

  // The chain: what this task waits for, editable in place. Blockers
  // outside this console's view are named without state or link — the same
  // redaction the board applies. Adding and removing are ordinary
  // re-proved POSTs; the loop refusal comes back as the problem banner.
  const waitsFor = data.waitsFor ?? [];
  const candidates = (data.waitCandidates ?? []).filter(one => !waitsFor.some(existing => existing.id === one.id));
  const waitRows = waitsFor.length === 0 ? "" : joinHtml(waitsFor.map(
    one => html`<p class="row">${
      one.admitted ? html`<a href="${taskHref(one.id)}" class="mono">${one.id}</a>` : html`<span class="mono">${one.id}</span>`
    }${one.state === null ? "" : html` <span class="badge badge-${one.state}">${sentenceCase(one.state)}</span>`}${
      postForm(`${taskHref(task.id)}/unblock`, html`<button type="submit">Don't wait for this</button>`, { attrs: { class: "inline" }, hidden: { on: one.id } })}</p>`,
  ), "\n");
  const waitAdd =
    data.csrf === "" || candidates.length === 0
      ? ""
      : postForm(`${taskHref(task.id)}/block`, html`<select name="on" aria-label="task to wait for">${
          candidates.map(one => html`<option value="${one.id}">${one.id} — ${one.title}</option>`)
        }</select><button type="submit">Wait for this task</button><span class="meta"> — this task starts only after it finishes</span>`, { attrs: { class: "row" } });
  const waitsForCard =
    waitRows === "" && waitAdd === ""
      ? ""
      : html`<h2>Waits for</h2>${waitRows === "" ? html`<p class="meta">Nothing — it starts when a worker is free</p>` : waitRows}${waitAdd}`;

  // The acts bar (task page pass): every verb in one row under the title,
  // the one that resolves this task's state first and primary — retry on a
  // stalled task, build-next in the queue, plan-first with no scope. The
  // hold's reason sits beside its button; cancel stays armed at the foot,
  // far from the primary. A live claim is never disturbed by an operator
  // hold (the hold governs the NEXT start), and requeue refuses while a
  // claim is live — so the words say exactly when each becomes real.
  const canPlan = data.plan === null && !approval.approved && !data.claimed && task.state === "queued" && (data.coordinator === null || data.coordinator === undefined);
  // A failed task's status card carries Retry itself (the same requeue); here it would be a second ink act.
  const cardRetries = task.state === "failed" && data.assignment != null && data.csrf !== "";
  const primaryAct =
    stopControlsActive || cardRetries ? null : stalled && !data.claimed
      ? { html: act("requeue", "Retry, keeping the branch and workspace"), why: "Resolves the incidents, clears the failed attempts and queues the task again. The branch and workspace are kept.", whyClass: "retry" }
      : canPlan
        ? { html: act("plan", "plan first"), why: "plan first sends an agent to read the repository, ask you questions, and propose a scope — nothing builds until you approve it", whyClass: "plan" }
        : data.plan === "requested"
          ? null
        : task.state === "queued" && !data.claimed && (data.position?.position ?? 1) > 1
          ? { html: act("next", "build this next"), why: "moves it to the front of its queue — the next free worker looks here first; approval is still required", whyClass: "next" }
          : null;
  const holdAct = postForm(`${taskHref(task.id)}/hold`,
    html`<input type="text" name="reason" class="inline" placeholder="reason (optional)" aria-label="hold reason"><button type="submit">Hold the next attempt</button>`,
    { attrs: { class: "inline act-hold" } });
  const canHold = task.state === "queued" || task.state === "running" || task.state === "failed";
  const actsBar = joinHtml([
    html`<span id="task-actions"></span><div class="acts-bar">`,
    // While a ceremony leads the page, no other act competes as primary.
    primaryAct === null ? "" : approveForm === "" ? html`<span class="primary">${primaryAct.html}</span>` : primaryAct.html,
    task.state === "queued" && (data.position?.position ?? 2) === 1 && task.priority > 0
      ? act("next", "back to filing order", { undo: "1" })
      : "",
    // A task with no scope is already unable to start. Showing a hold next
    // to "plan first" adds a second, unnecessary decision at the exact
    // moment the page should have one obvious action.
    stopControlsActive || canPlan || !canHold ? "" : holdAct,
    data.holds.some(hold => hold.ownerKind === "operator") ? act("unhold", "Remove hold") : "",
    html`</div>`,
    primaryAct === null ? "" : html`<p class="meta acts-why acts-why-${primaryAct.whyClass}">${primaryAct.why}</p>`,
    data.claimed && !stopControlsActive
      ? html`<p class="meta acts-why">a worker is building this right now — <em>Hold the next attempt</em> stops the one after it; cancel waits for the current build to finish${
          stalled ? "; retry becomes available after this attempt finishes" : ""
        }</p>`
      : "",
  ], "\n");
  // Cancel gets the same ceremony as an irreversible answer: armed behind
  // one deliberate tap, styled as the destructive act it is.
  const cancelForm =
    task.state === "queued" || task.state === "running" || task.state === "failed"
      ? postForm(`${taskHref(task.id)}/cancel`, joinHtml([
          data.coordinator == null ? "" : html`<label>Reason for cancellation<textarea name="reason" rows="3" maxlength="500" required>${data.cancelDraft ?? ""}</textarea></label>`,
          html`<button type="submit" class="danger">Confirm cancellation</button>`,
        ]))
      : "";
  const cancelAct = cancelForm === "" ? "" : html`<details class="arm-danger"${data.cancelDraft === undefined ? "" : html` open`}><summary>Cancel task</summary>${cancelForm}</details>`;
  // Long sections fold, each with its count in the header: what needs
  // reading stays open; a ledger or a form folds until asked. The rebuilt
  // page receives the same bodies, so its folds carry the same forms.
  const sectionParts: BrowserTaskSection[] = [];
  const section = (title: string, body: Html | "", open: boolean, count?: number, id = title.replace(/\s+/g, "-")): Html | "" => {
    if (body === "" || isEmptyHtml(body)) return "";
    const heading = sentenceCase(title);
    // The section's own heading moves into its summary.
    const once = (fragment: Html, words: string): Html => replaceMarkup(fragment, new RegExp(htmlString(html`<h2>${words}</h2>`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), () => html``);
    const inner = once(once(body, title), heading);
    sectionParts.push({ id, title: heading, html: htmlString(inner), open, count: count ?? null });
    return html`<details class="section" id="${id}"${open ? html` open` : ""}><summary><h2>${heading}${count === undefined ? "" : html` <span class="lane-count">${count}</span>`}</h2></summary>${inner}</details>`;
  };

  const receiptLeads = data.assignment == null && task.state === "done" && data.completion?.receipt != null;
  // Exact identity stays available in Task options; failures stay in the
  // status and property rail, and approval provenance stays in the ceremony.
  const identity = html`<p class="meta task-identity">Task ID <span class="mono">${task.id}</span>${
      data.rootTitle !== undefined && data.rootTitle !== task.title ? ` · Execution: ${task.title}` : ""}${
      data.repo === null ? "" : ` · ${projectName(data.repo)}`}${
        data.coordinator !== null && data.coordinator !== undefined
          ? html` · filed by <span class="mono">${data.coordinator.label}</span>${data.coordinator.filedAgo === null ? "" : ` ${data.coordinator.filedAgo}`}`
          : data.filedVia === null || data.filedVia === undefined
            ? ""
            : ` · filed via ${data.filedVia}`
      }${data.deliverable === "report" ? html` · <span class="badge">Scout</span>` : ""}</p>`;
  // A pull request that can be merged (or opened) owns the one primary action; the result stays in its section.
  const pullRequestActs = data.csrf !== "" && (data.pullRequest?.view?.canMerge === true || (data.pullRequest?.view == null && data.pullRequest?.offer != null));
  const pullRequestFact = data.pullRequest?.fact != null && data.pullRequest.view?.runId === data.assignment?.receipt?.runId ? data.pullRequest.fact : undefined;
  const assignmentOptions = data.assignment == null ? null : { workStatus: status, hideAction: (approveForm !== "" && data.dispatch?.action === "approve-scope") || pullRequestActs, problem: status.tone === "problem",
    planning: data.dispatch?.code === "running" && data.dispatch.role === "planner", ...(pullRequestFact === undefined ? {} : { pullRequest: pullRequestFact }),
    diagnostics: [...((status as WorkStatus).diagnostics ?? []), ...(status.tone === "problem" && status.detail !== data.assignment.detail ? [status] : [])] };
  // Say it once: a pull request that couldn't open, or merged, is the status
  // card's own row (its reason or merge commit under Details), not a second card.
  const pullRequestCard = data.pullRequest == null || (pullRequestFact !== undefined && (data.pullRequest.view?.state === "failed" || data.pullRequest.view?.state === "merged")) ? "" : pullRequestCardHtml(data.pullRequest, data.csrf);
  // The result takes over from the task status as soon as it is ready.
  const statusHtml = html`${data.assignment != null && assignmentOptions !== null ? assignmentSummaryHtml(data.assignment, assignmentOptions) : receiptLeads ? completionReceiptCard(data.completion!.receipt!, task.id, "task", status) : taskStatusCard(status, task.id, data.dispatch ?? null, liveRunId, approveForm !== "" && data.dispatch?.action === "approve-scope")}${checkProgressHtml(data.checkProgress ?? null)}`;
  // The exact-run control (v52), directly under the scheduler's answer:
  // the one place a person stops or resumes THIS attempt.
  const controlHtml = taskControlDetailsHtml(data.control ?? { kind: "none" }, task.id, data.csrf, "task");
  const previousResult = data.completion?.receipt == null || receiptLeads ? null : {
    title: data.assignment != null && task.state === "done" ? "Result" : "Previous result",
    html: (completionReceiptCard(data.completion.receipt, task.id, "task", data.assignment == null ? receiptStatusOf(data.completion.receipt) : assignmentStatusOf(data.assignment), data.assignment ?? null, data.assignment == null)),
  };
  // External work wears its tracker on the page: the link, the last
  // observed state, and — when the tracker closed it and has been seen
  // open again — the authenticated reopen act. Done + closed is display
  // only: completed here stays completed.
  const mirrorCard = ((): Html | "" => {
    const mirror = data.mirror ?? null;
    if (mirror === null) return "";
    const link =
      mirror.backend === "github-issues"
        ? html`<a href="https://github.com/${mirror.remoteRepo}/issues/${mirror.remoteId}">${mirror.remoteRepo}#${mirror.remoteId}</a>`
        : html`<span class="mono">${mirror.remoteRepo}#${mirror.remoteId}</span>`;
    const state =
      task.state === "done" && mirror.remoteState !== "open"
        ? "completed here; closed on the tracker"
        : mirror.remoteState === "open"
          ? mirror.dispatchOk
            ? "open on the tracker"
            : "seen open again — reopen below to resume"
          : mirror.remoteState === "closed"
            ? "closed on the tracker"
            : "gone from the tracker";
    const reopenable =
      mirror.remoteState === "open" && !mirror.dispatchOk && mirror.closeGeneration !== null &&
      mirror.syncGeneration > mirror.closeGeneration && ["cancelled", "failed", "queued"].includes(task.state) && data.csrf !== "";
    return joinHtml([
      html`<div class="card"><p><strong>External work</strong> <span class="meta">${link} · ${state}</span></p>`,
      reopenable
        ? postForm(`${taskHref(task.id)}/reopen`, html`<input type="password" name="token" placeholder="your password" aria-label="your password" autocomplete="current-password"><button type="submit">Reopen — the approved scope stands</button>`, { attrs: { class: "row" } })
        : "",
      html`</div>`,
    ]);
  })();
  const problemHtml = data.problem === null || data.scopeDraft !== undefined ? "" : html`<div class="problem">${data.problem}</div>`;
  // The board sent them here saying "needs you" — the page must open by
  // saying WHY and pointing at the act, not read as a fact sheet
  // (operator finding: clicking a needs-you card landed with no context).
  const needsScopeCard =
    scope === null && data.plan === null && task.state === "queued" && data.dispatch?.code !== "needs-scope" && data.dispatch?.code !== "waiting-dependency" && !dependencyChoiceNeeded
      ? data.coordinator !== null && data.coordinator !== undefined
        // The quarantine speaks here too (round-2 finding 5): the planner
        // is as fenced as the builder on a coordinator filing, so "plan
        // first" would recommend a road that refuses.
        ? html`<div class="card"><p><strong>This task is waiting on you: an agent filed it, and it has no scope.</strong></p><p class="meta">Filed by <span class="mono">${data.coordinator.label}</span> — nothing plans, claims, or runs until you write a scope below and sign it. Your signature runs their request.</p></div>`
        : html`<div class="card task-scope-needed"><p><strong>No approved scope yet</strong></p><p class="meta"><strong>Plan first</strong> drafts it from the repository, or <a href="#scope">write it yourself</a>.</p></div>`
      : "";
  const approvalHtml = dependencyChoiceNeeded || approveForm === "" ? "" : data.dispatch?.action === "approve-scope"
    ? html`<section class="task-plan-review" aria-label="Approve the plan">${approveForm}</section>`
    : html`<details class="task-secondary-approval"><summary>Updated approval terms</summary>${approveForm}</details>`;
  const optionsHtml = html`${identity}${dispatchStatus}${dependencyChoiceNeeded ? "" : actsBar}`;
  const optionsOpen = data.assignment?.primaryAction?.code === "unhold" || data.assignment?.primaryAction?.code === "retry-task";
  const body = joinHtml([
    // The title is bare; the receipt or shared task status leads once.
    html`<div class="task-title-row"><h1 class="task-main-title">${data.rootTitle ?? task.title}</h1>${data.csrf === "" ? "" : taskViewSwitch(data.rootId ?? task.id, "overview")}</div>`,
    data.versionLabel == null ? "" : html`<p class="meta">${data.versionLabel} · <a href="${taskHref(data.rootId ?? task.id)}">Current work</a></p>`,
    (data.history ?? ""),
    statusHtml,
    controlHtml,
    previousResult === null ? "" : html`<details class="task-previous-result"><summary>${previousResult.title}</summary>${previousResult.html}</details>`,
    progressCard,
    revisionLedgerCard,
    planCard,
    mirrorCard,
    problemHtml,
    needsScopeCard,
    approvalHtml,
    html`<details class="task-status-details" id="task-diagnostics"${optionsOpen ? html` open` : ""}><summary>Task options</summary>${optionsHtml}</details>`,
    // Evidence-first (M5.5): what needs you, then what happened — decisions
    // and incidents above the attempt ledger and spend, the mechanics
    // (scope, holds, acts) after. Only trustworthy facts moved up. The rail
    // (slice 1c) rides beside the main column on wide screens and above it
    // on narrow ones.
    html`<div class="task-layout"><div class="task-main">`,
    attemptPanel,
    data.coordinatorProposals == null || data.coordinatorProposals.rows.length === 0
      ? ""
      : section(
          "proposals",
          // Confirm and dismiss come back to this task.
          html`<h2>Proposed by coordinators</h2>${coordinatorProposalsSection(
            data.coordinatorProposals.rows,
            data.coordinatorProposals.decisions,
            data.coordinatorProposals.now,
            false,
            taskHref(data.task.id),
          )}`,
          true,
          data.coordinatorProposals.rows.length,
        ),
    section("decisions", decisions, true, data.decisions.length),
    section("incidents", incidents, true, data.incidents.length),
    data.publication === null || data.publication === undefined
      ? ""
      : html`<p class="row"><span class="meta">published</span> ${
        safePrUrl(data.publication.prUrl) === null ? html`<span class="mono">PR #${data.publication.prNumber ?? "?"}</span>` : html`<a href="${safePrUrl(data.publication.prUrl) as string}" class="mono">PR #${data.publication.prNumber ?? "?"}</a>`
        } <span class="meta">${data.publication.state}${
          data.publication.remoteState !== null ? ` · ${data.publication.remoteState.toLowerCase()} on GitHub` : ""
        }${
          data.publication.lastCheckState !== null
            ? ` · CI ${data.publication.lastCheckState} at last observation`
            : " · no checks observed"
        }</span></p>`,
    section("report", reportCard, true),
    data.assignment == null ? section("attempts", runs, true, data.runs.length) : section("Build activity", data.runs.length === 0 ? "" : runRows, false, data.runs.length, "attempts"),
    section("usage", spendCard, false),
    section("steering", steeringCard, (data.steering ?? []).length > 0, (data.steering ?? []).length),
    section(
      "scope",
      // The recipe road rides with the scope it reuses (UI polish
      // 2026-09-13), off the title-to-action path.
      joinHtml([html`<h2>Scope</h2>`, scopeCard, data.repo !== null && data.scope !== null ? html`<p class="meta"><a href="/recipes/from-task?task=${encodeURIComponent(task.id)}">Reuse this scope as a recipe →</a></p>` : "", agentsCardHtml(task.id, data.route, data.canEditRoute === true), revisionInApproval ? "" : revisionCard, data.completion != null ? "" : repairChainHtml(data.repairChain ?? null), scopeForm], "\n"),
      scopeDraft !== undefined || (data.plan !== "requested" && approveForm === "" && !(scope === null && canPlan)),
    ),
    dependencyChoiceNeeded ? "" : section("waits for", waitsForCard, (data.waitsFor ?? []).length > 0, (data.waitsFor ?? []).length),
    section("holds", holds, true, data.holds.length),
    cancelAct,
    html`</div><aside class="task-rail">${rail}</aside></div>`,
  ], "\n");
  // Console v2: one thread in time order (the plan, the agent's notes and
  // results, its questions, the person's replies) and the metadata grouped
  // for a Details panel. Every form below keeps its own route and fields.
  const familyRuns = data.family?.runs ?? data.runs.map(run => ({ ...run, taskId: task.id }));
  const versionLabelOf = (taskId: string): string => {
    const index = data.family?.versions.findIndex(one => one.id === taskId) ?? -1;
    return index <= 0 ? "" : ` · revision ${index}`;
  };
  const thread: BrowserTaskThreadItem[] = [];
  const filedBy = data.filer?.name ?? data.coordinator?.label ?? null;
  const rootFiled = data.family?.root.createdAt ?? task.createdAt;
  thread.push({ key: "filed", at: rootFiled, kind: "filed", who: "person", author: filedBy ?? "", title: "Filed the task",
    text: (() => { const goal = data.family?.root.goal ?? scope?.goal ?? null; return goal === null ? null : oneLineOf(goal, 280); })(), link: null, html: "", more: null });
  const newestBuilt = familyRuns.filter(run => run.outcome === "built" && run.role !== "planner" && run.role !== "reviewer").sort((a, b) => b.id - a.id)[0];
  // Failed: the card says what went wrong in one line, and its one act is Retry itself (the same requeue), never a link to
  // this page; someone who can't retry here (a viewer, a live claim) gets no act at all.
  const statusCard = data.assignment != null && assignmentOptions !== null ? assignmentCardOf(data.assignment, assignmentOptions) : null;
  // A live build says which step it is on, or which step it is stuck on and why.
  const building = statusCard?.status.headline === "Building" && liveRun !== undefined && liveRun.role !== "planner" && liveRun.role !== "reviewer";
  // While a build runs, the attempts that stopped before it fold into one quiet line under its Building card. Only
  // there: with any other card (or none) they stay in the thread, never vanish.
  const earlierStopped = !building ? []
    : familyRuns.filter(run => run.id < liveRun.id && (run.role === "builder" || run.role === "scout") && run.outcome !== "built" && run.outcome !== "no-change" && run.id !== liveHistoryRunId);
  const foldedAttempts = new Set(earlierStopped.map(run => run.id));
  for (const run of familyRuns) {
    if (foldedAttempts.has(run.id)) continue;
    const live = run.id === liveHistoryRunId || (run.outcome === null && run.id === liveRunId);
    const noun = runNoun(run);
    const href = { label: `${noun[0]!.toUpperCase()}${noun.slice(1)} #${run.id}`, href: `/r/${run.id}` };
    const revision = versionLabelOf(run.taskId);
    if (run.role === "planner") {
      thread.push({ key: `run-${run.id}`, at: run.finishedAt ?? run.startedAt, kind: "plan", who: "agent", author: run.runner,
        title: live ? "Planning" : run.reason === "plan-drafted" ? "Drafted a plan" : `Planning ended · ${run.outcome === null ? "never finished" : run.reason === null ? run.outcome : reasonWords(run.reason)}`,
        text: null, link: href, html: "", more: null });
      continue;
    }
    if (live) {
      thread.push({ key: `run-${run.id}`, at: run.startedAt, kind: "progress", who: "agent", author: run.runner,
        title: `${run.role === "reviewer" ? "Reviewing" : run.role === "scout" ? "Investigating" : "Building"}${revision}`,
        text: `${homePhaseWords(run)}.`, link: href, html: "", more: null });
      continue;
    }
    const title = run.role === "reviewer" ? "Reviewed the result"
      : run.outcome === "built" ? (run.role === "scout" ? "Report ready" : "Result ready")
      : run.outcome === "no-change" ? "Finished with no change"
      : run.outcome === "parked" ? "Stopped to ask"
      : run.outcome === null ? "Attempt never finished"
      : `${noun[0]!.toUpperCase()}${noun.slice(1)} ${run.outcome}`;
    thread.push({ key: `run-${run.id}`, at: run.finishedAt ?? run.startedAt, kind: "result", who: "agent", author: run.runner,
      title: `${title}${revision}`, text: run.handoff === null ? (run.outcome === "failed" ? failedAttemptSentence(run.reason) : run.reason === null || run.outcome === "built" ? null : reasonWords(run.reason)) : oneLineOf(run.handoff, 600),
      link: href, html: "",
      more: previousResult !== null && run.id === newestBuilt?.id && run.taskId === task.id ? { summary: STATUS_MORE, html: htmlString(previousResult.html) } : null });
  }
  // What the agent is working through now, and how its plan changed.
  const liveAt = liveRun?.startedAt ?? task.updatedAt;
  if (planCard !== "") thread.push({ key: "plan", at: familyRuns.filter(run => run.role === "planner").map(run => run.finishedAt ?? run.startedAt).sort().at(-1) ?? task.updatedAt,
    kind: "plan", who: "agent", author: "", title: "The plan", text: null, link: null, html: htmlString(planCard), more: null });
  if (!isEmptyHtml(progressCard)) thread.push({ key: "progress", at: liveAt, kind: "progress", who: "agent", author: "", title: "Progress", text: null, link: null, html: htmlString(progressCard), more: null });
  if (!isEmptyHtml(revisionLedgerCard)) thread.push({ key: "plan-revisions", at: liveAt, kind: "progress", who: "agent", author: "", title: "Plan changes", text: null, link: null, html: htmlString(revisionLedgerCard), more: null });
  // The change a person asked for: the revision's own brief.
  if (data.revision != null && !("problem" in data.revision)) {
    const feedback = data.revision;
    thread.push({ key: "revision", at: task.createdAt, kind: "reply", who: "person", author: feedback.comments[0]?.author ?? "You",
      title: feedback.kind === "ci-repair" ? "Asked for a CI repair" : feedback.kind === "criterion-repair" ? "Asked for a repair" : "Asked for changes",
      text: feedback.comments.map(one => `${one.path === null ? "" : `${one.path}${one.line === null ? "" : `:${one.line}`} — `}${one.note.trim()}`).filter(one => one !== "").join("\n") || null,
      link: { label: `From build #${feedback.sourceRun}`, href: `/r/${feedback.sourceRun}` }, html: "", more: null });
  }
  for (const decision of data.decisions) {
    if (decision.state === "open" || decision.state === "expired") continue;
    thread.push({ key: `question-${decision.id}`, at: decision.createdAt, kind: "question", who: "agent", author: "", title: "Asked",
      text: decision.question, link: { label: "Question", href: `/d/${decision.id}` }, html: "", more: null });
    if (decision.answeredAt !== null) {
      const chosen = decision.options.find(one => one.id === decision.choice)?.label ?? decision.choice;
      thread.push({ key: `answer-${decision.id}`, at: decision.answeredAt, kind: "reply", who: "person", author: decision.answeredBy ?? "You", title: "Answered",
        text: [chosen, decision.note].filter((one): one is string => one !== null && one !== "").join(" — ") || null, link: null, html: "", more: null });
    }
  }
  // Open questions keep their answer card (and its #task-questions anchor).
  if (decisionRail !== "") thread.push({ key: "questions", at: openDecisions.map(one => one.createdAt).sort()[0] ?? task.updatedAt, kind: "question", who: "agent", author: "",
    title: openDecisions.length === 1 ? "Asked you a question" : `Asked you ${openDecisions.length} questions`, text: null, link: null, html: htmlString(decisionRail), more: null });
  for (const note of data.steering ?? []) {
    thread.push({ key: `steer-${note.id}`, at: note.createdAt, kind: "reply", who: "person", author: note.author, title: "Note to the agent", text: note.note, link: null, html: "", more: null });
  }
  thread.sort((a, b) => a.at === b.at ? 0 : a.at < b.at ? -1 : 1);

  // The Details panel: the same facts, grouped and said once.
  const lastRunForAgent = liveRun ?? familyRuns.filter(run => run.role !== "reviewer").sort((a, b) => b.id - a.id)[0];
  const work: BrowserTaskFact[] = [];
  work.push({ label: "Status", parts: [data.assignment != null && assignmentOptions !== null ? assignmentCardOf(data.assignment, assignmentOptions).status.headline : status.label] });
  if (data.repo !== null) work.push({ label: "Project", parts: [projectName(data.repo)] });
  work.push({ label: "Agent", parts: [lastRunForAgent !== undefined ? `${lastRunForAgent.provider}${lastRunForAgent.model === null ? "" : ` · ${lastRunForAgent.model}`} on ${lastRunForAgent.runner}`
    : data.route?.legacy != null ? `${data.route.legacy.provider} · ${data.route.legacy.model}` : "The project's default"] });
  if (scope !== null) work.push({ label: "Checks level", parts: [qualityModeTitle(scope.qualityMode ?? "default")] });
  for (const label of ["Worker", "Last attempt", "Queue", "Budget", "Policy", "Strikes"]) {
    const fact = facts.find(one => one.label === label);
    if (fact !== undefined) work.push(fact);
  }
  const links: BrowserTaskFact[] = [];
  if (data.family != null && data.family.root.id !== task.id) links.push({ label: "Parent", parts: [{ label: data.family.root.title, href: `${taskHref(data.family.root.id)}?version=${encodeURIComponent(data.family.root.id)}` }] });
  const blockers = data.waitsFor ?? [];
  if (blockers.length > 0) links.push({ label: "Blocked by", parts: blockers.flatMap((one, index) => [...(index === 0 ? [] : [", "]), one.admitted ? { label: one.title ?? one.id, href: taskHref(one.id) } : one.id]) });
  const laterVersions = (data.family?.versions ?? []).filter((one, index, all) => index > all.findIndex(version => version.id === task.id) && all.findIndex(version => version.id === task.id) >= 0);
  if (laterVersions.length > 0) links.push({ label: "Follow-ups", parts: laterVersions.flatMap((one, index) => [...(index === 0 ? [] : [", "]), { label: one.title, href: `${taskHref(data.family!.root.id)}?version=${encodeURIComponent(one.id)}` }]) });
  const published = facts.find(one => one.label === "Published");
  if (published !== undefined) links.push({ ...published, label: "Pull request" });
  else if (data.pullRequest?.view != null) {
    const pr = data.pullRequest.view;
    const prHref = safePrUrl(pr.prUrl);
    links.push({ label: "Pull request", parts: [prHref === null ? `#${pr.prNumber ?? "?"}` : { label: `#${pr.prNumber ?? "?"}`, href: prHref }, ` · ${pr.label}`] });
  }
  const review: BrowserTaskFact[] = [];
  const approvedScope = facts.find(one => one.label === "Approved scope" || one.label === "Scope");
  if (approvedScope !== undefined) review.push({ ...approvedScope, label: approvedScope.label === "Approved scope" ? "Approvals" : "Scope" });
  review.push({ label: "Who reviews", parts: [facts.find(one => one.label === "Approval rules")?.parts[0] as string | undefined ?? "Any approver in this project"] });
  review.push({ label: "Publishes as", parts: [publishesAs] });
  const about: BrowserTaskFact[] = [];
  const filedFact = facts.find(one => one.label === "Filed by");
  about.push(filedFact ?? { label: "Filed by", parts: [filedBy ?? (data.filedVia == null ? "Not recorded" : `via ${data.filedVia}`)] });
  about.push({ label: "Filed", parts: [{ at: rootFiled }] });
  about.push({ label: "Updated", parts: [{ at: task.updatedAt }] });
  for (const label of ["Audit", "This attempt", "Task total"]) {
    const fact = facts.find(one => one.label === label);
    if (fact !== undefined) about.push({ ...fact, label: label === "Audit" ? "Audit" : label === "This attempt" ? "Usage, this attempt" : "Usage, all attempts" });
  }
  const details: BrowserTaskDetailGroup[] = [
    { title: "Work", facts: work }, { title: "Links", facts: links }, { title: "Review", facts: review }, { title: "About", facts: about },
  ];

  // The rebuilt page (shadcn/ui): the same parts in a calmer order — what
  // needs a person, then facts, then folds; the mechanics under Manage.
  const MANAGE = new Set(["steering", "waits-for", "holds"]);
  const finished = task.state === "done" || task.state === "cancelled";
  const failedCard = statusCard?.status.headline === "Failed";
  // A link to this very page, with no section to open, goes nowhere: a card never offers one.
  const bareSelfLink = (href: string): boolean => {
    if (href.includes("#")) return false;
    const [path, query = ""] = href.split("?");
    const version = new URLSearchParams(query).get("version");
    return [data.assignment?.rootId, data.rootId, task.id].some(id => id != null && path === `/t/${encodeURIComponent(id)}`) && (version === null || version === task.id);
  };
  // Build again, in place, names its form after the card's own act.
  const rebuild = data.csrf !== "" && data.assignment?.primaryAction?.code === "retry-task" && data.assignment.need != null && "key" in data.assignment.need && data.assignment.need.key === "rebuild"
    ? { action: `${taskHref(data.assignment.rootId)}/requeue` } : null;
  const retry = failedCard && task.state === "failed" && !data.claimed && !stopControlsActive && data.csrf !== ""
    ? { action: `${taskHref(task.id)}/requeue`, ...(data.failure == null ? {} : { note: retryNoteOf(data.failure.suggestion) }) } : null;
  // Run checks happens in place: a status row's Run checks posts here and comes back; with nothing to run, the row offers nothing.
  const runChecks = data.runChecks ?? null;
  // A row's link to a result in Chat opens that result's own page instead: Chat would only lead back here.
  const resultPageOf = (href: string | null): string | null => {
    const chat = href === null ? null : /^\/chat\?task=([A-Za-z0-9._~%-]{1,200})&result=([0-9]{1,15})(?:&tab=(changes|checks))?(#[A-Za-z0-9_-]{1,80})?$/.exec(href);
    return chat === null ? href : `/review?result=${chat[1]}&run=${chat[2]}${chat[3] === undefined ? "" : `&tab=${chat[3]}`}${chat[4] ?? ""}`;
  };
  const inPlaceChecks = (card: AssignmentCard): AssignmentCard => {
    const status = data.demo === true ? demoChecksOf(card.status) : card.status;
    return { ...card, status: { ...status, details: status.details.map(one =>
      one.action?.href?.endsWith("#follow-ups") === true ? { ...one, action: runChecks === null ? null : { label: one.action.label, href: runChecks.action } }
        : { ...one, href: resultPageOf(one.href), action: one.action === null ? null : { ...one.action, href: resultPageOf(one.action.href) } }) } };
  };
  const steps = building ? buildProgressOf(data.milestoneProgress ?? null) : null;
  const progress = steps === null ? null : { line: steps.line,
    stuck: steps.stuck === null ? null : { ...steps.stuck, action: data.csrf === "" ? null : { label: "Send the agent a note", href: "#steering" } } };
  // The Building card carries Stop for the build it describes (the same form), in place of a second card below it.
  const stop = building && data.control?.kind === "stop" && data.control.run === liveRun!.id && data.csrf !== ""
    ? { action: `${taskHref(task.id)}/stop`, run: data.control.run } : null;
  // The Building card keeps its way to the build's own record (/r/<id>), whatever act it shows.
  const record = building ? { label: `Build #${liveRun!.id} record`, href: `/r/${liveRun!.id}` } : null;
  const earlier = earlierStopped.length === 0 ? null : {
    summary: earlierAttemptsWords(earlierStopped.length),
    attempts: [...earlierStopped].sort((a, b) => a.id - b.id).map(run => ({ label: `${runNoun(run)[0]!.toUpperCase()}${runNoun(run).slice(1)} #${run.id}`, href: `/r/${run.id}`,
      text: run.outcome === null ? "Never finished." : run.outcome === "failed" ? failedAttemptSentence(run.reason) : run.reason === null ? null : (words => `${words.charAt(0).toUpperCase()}${words.slice(1)}.`)(reasonWords(run.reason)) })),
  };
  const view: BrowserTaskView = {
    kind: "task",
    id: task.id,
    title: data.rootTitle ?? task.title,
    project: data.repo === null ? null : projectName(data.repo),
    scout: data.deliverable === "report",
    tabs: data.csrf === "" ? [] : [
      { label: "Overview", href: taskHref(data.rootId ?? task.id), active: true },
      { label: "Ask", href: taskChatHref(data.rootId ?? task.id), active: false },
    ],
    version: data.versionLabel == null ? null : { label: data.versionLabel, current: { label: "Current work", href: taskHref(data.rootId ?? task.id) } },
    status: statusCard === null ? null : inPlaceChecks(failedCard ? { ...statusCard, action: null, status: { ...statusCard.status, sentence: data.failure?.line ?? statusCard.status.sentence } }
      : progress !== null || record !== null ? { ...statusCard, action: statusCard.action?.href === record?.href ? null : statusCard.action, status: { ...statusCard.status, sentence: progress?.line ?? statusCard.status.sentence } }
      : statusCard.action !== null && rebuild === null && bareSelfLink(statusCard.action.href) ? { ...statusCard, action: null } : statusCard),
    statusHtml: htmlString(statusHtml),
    failure: failedCard && data.failure != null ? { line: data.failure.line, evidence: data.failure.evidence, suggestion: data.failure.suggestion, link: data.failure.link } : null,
    retry,
    runChecks,
    progress,
    // One quiet line under the step: what the agent did last, and when.
    activity: liveRun === undefined ? null : data.activity ?? null,
    stop,
    record,
    earlier,
    approval: fragmentString(approvalHtml),
    confirmStopped: data.csrf !== "" && data.assignment?.primaryAction?.code === "confirm-stopped" && data.assignment.primaryAction.target.runId !== null
      ? { action: `${taskHref(data.assignment.rootId)}/confirm-stopped`, run: data.assignment.primaryAction.target.runId, checked: needsCheck(data.assignment) } : null,
    rebuild,
    // The plan, progress and plan changes are thread entries now; the rest still needs a person here.
    lead: [
      { key: "history", html: data.history === undefined ? "" : htmlString(data.history) }, { key: "control", html: htmlString(stop === null ? controlHtml : taskControlDetailsHtml(data.control!, task.id, data.csrf, "task", false, true)) }, { key: "problem", html: fragmentString(problemHtml) },
      { key: "pull-request", html: fragmentString(pullRequestCard) },
      { key: "needs-scope", html: fragmentString(needsScopeCard) },
      { key: "mirror", html: fragmentString(mirrorCard) }, { key: "attempt", html: fragmentString(attemptPanel) },
    ].filter(one => one.html !== ""),
    // Open questions are answered in the thread.
    questions: "",
    facts,
    sections: [
      ...(previousResult === null || thread.some(one => one.more !== null) ? [] : [{ id: "result", title: previousResult.title, html: htmlString(previousResult.html), open: false, count: null }]),
      // Questions are in the thread; the scope and the ledgers fold here until asked.
      ...sectionParts.filter(one => !MANAGE.has(one.id) && one.id !== "decisions").map(one => one.id === "scope" && scopeDraft === undefined && (finished || approval.approved) ? { ...one, open: false } : one),
    ],
    manage: [
      ...sectionParts.filter(one => MANAGE.has(one.id)),
      { id: "task-diagnostics", title: "Task options", html: htmlString(optionsHtml), open: optionsOpen, count: null },
    ],
    cancel: cancelForm === "" ? null : { html: htmlString(cancelForm), open: data.cancelDraft !== undefined },
    journey: data.guide !== true || task.state === "cancelled" || data.status === undefined ? null : (() => {
      const planning = data.plan === "requested" && approveForm === "";
      const read = data.assignment != null ? assignmentStageOf(data.assignment, { token: data.status.token }, planning) : stageOfCode(data.status.token, { planning });
      return firstTaskJourney(read, scope !== null && approvalOf(scope).approved, task.state === "done");
    })(),
    // "Do this every time…": the starter flow that does this kind of work on its own, one yes away.
    thread,
    details,
    chatHref: data.csrf === "" ? null : taskChatHref(data.rootId ?? task.id),
    everyTime: data.repo === null || data.csrf === "" ? null : (() => {
      const starter = starterForWork(`${task.title}\n${scope?.goal ?? ""}`);
      return { href: `/settings/flows?repo=${encodeURIComponent(data.repo)}&starter=${starter.id}#starter-${starter.id}`, starter: starter.name };
    })(),
  };
  return { html: body, view };
}

export function taskBody(data: Parameters<typeof taskBodyParts>[0]): Html {
  return taskBodyParts(data).html;
}

export function taskPage(chrome: Chrome, data: Parameters<typeof taskBody>[0]): Screen {
  // The sensitive-page composition guard (slice 1c): this page may carry a
  // password ceremony. sendScreen() would keep a functional script on such
  // a page — so the decision is made HERE, from the rendered body itself:
  // when the body (or the chrome's list pane) shows a password input, the
  // page re-renders degraded — no poller, static attempt line, link-only
  // decisions — and ships no functional script at all.
  const first = taskBodyParts(data);
  const sensitive =
    SENSITIVE_INPUT.test(htmlString(first.html)) || (chrome.listPane !== undefined && SENSITIVE_INPUT.test(htmlString(chrome.listPane)));
  if (sensitive) {
    const degraded = taskBodyParts({ ...data, degraded: "sensitive" });
    return screen(`task \u00b7 ${data.task.id}`, degraded.html, { chrome, workspace: { view: degraded.view } });
  }
  const liveRunId = data.liveRunId ?? null;
  const liveRun = liveRunId === null ? undefined : data.runs.find(one => one.id === liveRunId);
  const script =
    (liveRun === undefined ? "" : regionScript("check-progress", "check", `/r/${liveRun.id}`)) +
    (liveRun !== undefined && data.peekable === true ? regionScript("run-peek", "peek", `/r/${liveRun.id}`) : "") +
    (liveRun !== undefined && data.peekable === true && liveRun.provider === "claude" ? transcriptScript(`/r/${liveRun.id}`) : "") +
    (data.csrf !== "" && data.decisions.some(one => one.state === "open" || one.state === "expired") ? decisionAnswerScript() : "");
  return screen(`task \u00b7 ${data.task.id}`, first.html, {
    chrome,
    workspace: { view: first.view },
    ...(script === "" ? {} : { functional: { script, fetches: true } }),
  });
}

/** One accessible two-choice control everywhere permissions are selected.
 * The words describe behavior; the raw flag stays secondary detail. */
export function permissionModeChoices(name: string, selected: UnattendedPermissionMode): Html {
  const choice = (value: UnattendedPermissionMode, title: string, detail: string): Html =>
    html`<label class="permission-choice"><input type="radio" name="${name}" value="${value}"${value === selected ? html` checked` : ""}><span><strong>${title}</strong><small>${detail}</small></span></label>`;
  return joinHtml([
    html`<div class="permission-toggle" role="radiogroup" aria-label="agent permissions">`,
    choice("auto", "Auto", "Asks before risky actions."),
    choice("bypassPermissions", "Full access", "Never asks and can change files anywhere on this computer. Trusted repositories only."),
    html`</div>`,
  ]);
}

/** Quality selects the configured agent route; permissions remain separate. */
export function qualityModeChoices(name: string, selected: QualityMode): Html {
  const choice = (value: QualityMode, title: string, detail: string): Html =>
    html`<label class="permission-choice"><input type="radio" name="${name}" value="${value}"${value === selected ? html` checked` : ""}><span><strong>${title}</strong><small>${detail}</small></span></label>`;
  return joinHtml([
    html`<div class="permission-toggle" role="radiogroup" aria-label="quality mode">`,
    choice("default", "Default", "Everyday agents and the repository check."),
    choice("strict", "Strict / release", "Strongest agents. Release approval stays separate."),
    html`</div>`,
  ]);
}

/**
 * A decision's answer forms — one source of truth for the decision screen
 * and the triage flow. The consequence reads BEFORE the button that buys
 * it; irreversible options arm behind one deliberate tap AND the server
 * independently requires the confirm field. `returnTo` is allow-listed by
 * the answer handler, never an arbitrary URL. `csrf` is unused (postForm
 * writes the field); kept for callers.
 */
export function decisionOptionForms(decision: Decision, returnTo: string | null): Html {
  return joinHtml(decision.options
    .map(option => {
      const recommended = option.id === decision.recommendation;
      const inner = postForm(`/d/${decision.id}/answer`, joinHtml([
        "",
        recommended ? html`<p class="meta" style="margin:0 0 .375rem"><span class="badge">Recommended</span></p>` : "",
        html`<p class="consequence">${option.consequence}</p>`,
        html`<button type="submit">${option.label}${option.reversible ? "" : html` <span class="badge badge-overdue">Irreversible</span>`}</button>`,
        html`<input type="text" name="note" placeholder="optional note — travels with this answer" aria-label="optional note">`,
        "",
      ], "\n"), {
        attrs: { class: `option${recommended ? " recommended" : ""}` },
        returnTo,
        hidden: { choice: option.id, confirm: option.reversible ? null : "yes" },
      });
      return option.reversible
        ? inner
        : html`<details class="arm-danger"><summary>${option.label} — irreversible, tap to arm</summary>${inner}</details>`;
    }), "\n");
}

export function decisionPage(
  chrome: Chrome,
  decision: Decision,
  taskId: string,
  artifacts: Artifact[],
  who: Who,
  now: Date,
  returnTo: string | null = null,
): Screen {
  const options = decisionOptionForms(decision, returnTo);

  const answered =
    decision.state === "answered"
      ? html`<div class="answered">Answered: <strong>${decision.choice ?? ""}</strong> by ${decision.answeredBy ?? ""}${decision.note === null ? "" : ` — ${decision.note}`}</div>`
      : "";

  const evidence =
    artifacts.length === 0
      ? ""
      : joinHtml([
        html`<div class="evidence"><strong>Evidence</strong>`,
        joinHtml(artifacts.map(
          artifact => html`<a href="/d/${decision.id}/evidence/${artifact.id}">${evidenceWords(artifact.kind)}${artifact.truncated ? " (truncated)" : ""} · ${artifact.bytesStored} bytes</a>`,
        ), "\n"),
        html`</div>`,
      ]);

  return screen(`decide · ${taskId}`, joinHtml([
    html`<h1>${taskId} <span class="badge badge-${decision.state}">${decision.state}</span>${
      isOverdue(decision, now) ? html` <span class="badge badge-overdue">Overdue</span>` : ""
    }${decision.deadline === null ? "" : html` <span class="meta">deadline ${decision.deadline}</span>`}</h1>`,
    html`<div class="recap">${decision.recap}</div>`,
    html`<div class="question">${decision.question}</div>`,
    decision.state === "answered" ? answered : options,
    evidence,
    html`<p class="meta"><a href="${returnTo === null ? "/" : returnTo}">← ${returnTo === null ? "everything waiting" : "back to the task chat"}</a></p>`,
  ], "\n"), { chrome });
}
export function taskOf(store: Store, decision: Decision): string {
  const run = store.getRun(decision.run);
  return run === null ? "?" : store.externalIdFor(run.taskRef) ?? "?";
}

