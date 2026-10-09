/** Everyday console pages: home, inbox, board, work, projects, fleet and the queue. */
import { type Html,html,type HtmlValue,htmlString,joinHtml,postForm,replaceMarkup } from "../html.js";
import { type AssignmentSnapshot } from "../assignment.js";
import { type BoardCard } from "../board.js";
import { type BrowserLimits,type BrowserProjectRow,type BrowserProjectsView,type BrowserTasksView,browserWorkActionHref } from "../browser-workspace.js";
import { CHECK_LEVEL_WORDS,type CheckLevel } from "../check-levels.js";
import { type DispatchDiagnosis } from "../dispatch.js";
import { type FirstRunStep } from "../first-run.js";
import { type Gap } from "../gaps.js";
import { limitsHtml } from "../limits-ui.js";
import { type Ask,ASK_LABEL,ASKS } from "../needs-you.js";
import { type ListOutcome } from "../onboard.js";
import { type parseBaseTreeSnapshot } from "../peek.js";
import { projectName } from "../project.js";
import { type CriterionMatrixRow } from "../proof.js";
import { type QualityMode } from "../quality.js";
import { type Runner,isAlive as runnerAlive } from "../runner.js";
import { type Scope,type UnattendedPermissionMode } from "../scope.js";
import { type Decision,type Incident,type RepairChainRow,type Run,type Store,type Task,type TaskState,type WorktreeRow } from "../store.js";
import { runCostWords,spendLine,tally } from "../summary.js";
import { type WorkIndexGroup,type WorkIndexItem,type WorkIndexPage } from "../work-index.js";
import { WORK_VIEWS,type WorkFacts,type WorkStatus,type WorkView } from "../workspace-ui.js";
import { createHash } from "node:crypto";
import { closeSync,constants as fsConstants,lstatSync,openSync,readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildsViews,CHEVRON_ICON,type Chrome,consoleSpend,FOLDER_PATHS,GRIP_HANDLE,isOverdue,projectChip,relativeAge,safePrUrl,screen,type Screen,sentenceCase,strokeIcon,TO_FRONT_ICON,when,whenTime } from "./chrome.js";
import { reviewHref,taskHref } from "./http.js";
import { criterionMatrixSummary,incidentWords,PHASE_WORDS,phaseWords } from "./render-results.js";
import { acceptanceCeremonyHtml,agentsCeremonyHtml,consentClosedHtml,type ConsentDoor,consentDoorOf,decisionAnswerCard,decisionAnswerScript,decisionOptionForms,dispatchHeadline,executionPlanHtml,permissionModeChoices,planContractHtml,type PlanContractView,profileWords,type RouteView,runtimeDetailsHtml,statusLineHtml,workDiagnosticsHtml } from "./render-tasks.js";

export const TASK_STATES: readonly TaskState[] = ["queued", "running", "done", "failed", "cancelled"];

/**
 * The inbox (v3): only things stalling progress without a person, one card
 * per underlying stall, each with its verb inline or one step away. No
 * auto-refresh — approval links lead to the step-up screen, and a page
 * that might hold typed input never re-renders itself.
 */
export type InboxTab = "needs-you" | "ready" | "running" | "all";
export const INBOX_TABS: readonly { id: InboxTab; label: string }[] = [
  { id: "needs-you", label: "Needs you" }, { id: "ready", label: "Ready" }, { id: "running", label: "Running" }, { id: "all", label: "All" },
];
export function parseInboxTab(raw: string | null): InboxTab | undefined {
  return INBOX_TABS.some(one => one.id === raw) ? raw as InboxTab : undefined;
}
/** What each tab holds, as a short fingerprint: a tab is unread when its
 * fingerprint differs from the one this browser saw there last. */
export function inboxFingerprints(data: Pick<Parameters<typeof inboxPage>[1], "decisions" | "approvals" | "requeueables" | "cancelledBlockers" | "gaps" | "needsVerification" | "ready" | "running">): Record<InboxTab, string> {
  const print = (keys: string[]) => createHash("sha256").update([...keys].sort().join("\n")).digest("hex").slice(0, 8);
  const needs = [...data.decisions.map(one => `d${one.id}`), ...data.approvals.map(one => `a${one.taskId}@${one.proposedAt}`), ...data.requeueables.map(one => `q${one.taskId}:${one.strikes}`),
    ...data.cancelledBlockers.map(one => `c${one.blockerId}`), ...data.gaps.map(one => `g${one.key}`)];
  const ready = [...data.needsVerification.map(one => `v${one.taskId}`), ...(data.ready ?? []).map(one => `r${one.taskId}`)];
  const running = (data.running ?? []).map(one => `u${one.taskId}`);
  return { "needs-you": print(needs), ready: print(ready), running: print(running), all: print([...needs, ...ready, ...running]) };
}

export function inboxPage(chrome: Chrome, data: {
  csrf: string;
  revision: number;
  /** No project open in scoped mode: every admitted project at once,
   * chips on every row, links only — acting means opening the project. */
  rollup: boolean;
  /** A project is OPEN: only then do decisions answer on the card. The
   * legacy unscoped projectless inbox stays links-only too (commit-1
   * review, finding 4) — the partial belongs to a chosen project. */
  interactive: boolean;
  decisions: (Decision & { taskId: string; repo?: string | null })[];
  approvals: { taskId: string; title: string; goal: string; proposedAt: string; repo?: string | null; /** v48 authority repair: the closed consent door's title, or null when a yes could bind. */ closed?: string | null }[];
  requeueables: { taskId: string; title: string; state: TaskState; strikes: number; incidentCount: number; repo?: string | null }[];
  cancelledBlockers: { blockerId: string; dependentCount: number; exampleDependent: string; repo?: string | null; blockerRepo?: string | null }[];
  gaps: Gap[];
  /** A completed task whose proof is short or refuted and not yet accepted
   * (Priority 2) — reads "needs verification" here too, never silently
   * "done" just because the inbox does not otherwise look at finished work. */
  needsVerification: { taskId: string; title: string; verdict: "short" | "refuted"; repo?: string | null; matrix?: CriterionMatrixRow[]; repairChain?: RepairChainRow | null }[];
  /** The first-run steps; null once the installation has had its first Ready result. */
  wizard: FirstRunStep[] | null;
  /** Whether any worker is answering right now — said at the top when none is. */
  worker: { answering: number; registered: number; lastHeard: string | null };
  now: Date;
  /** Console v2: the tab shown, results ready to review, work running now,
   * and the tabs holding something this browser hasn't seen (dots on a phone). */
  tab?: InboxTab;
  ready?: { taskId: string; title: string; detail: string; repo: string | null }[];
  running?: { taskId: string; title: string; detail: string; repo: string | null }[];
  unread?: readonly InboxTab[];
}): Screen {
  /** The row's project, worn openly in the roll-up — null is UNPLACED,
   * said as such, never a silent missing chip (finding 13). */
  const chip = (repo: string | null | undefined): Html | null =>
    !data.rollup ? null : repo === null || repo === undefined
      ? html` <span class="badge">Unplaced</span>`
      : html` <span class="badge">${projectName(repo)}</span>`;
  const empty =
    data.decisions.length + data.approvals.length + data.requeueables.length +
    data.cancelledBlockers.length + data.gaps.length + data.needsVerification.length === 0;

  // The roll-up inbox keeps its links-only contract — acting means opening
  // the project. A SELECTED project's inbox answers reversible options on
  // the card itself (portfolio arc §2).
  const decisions =
    data.decisions.length === 0
      ? null
      : html`<h2>Answer a question</h2><p class="hint">an agent stopped mid-build to ask — nothing proceeds until you answer</p>${joinHtml(
          data.decisions.map(decision =>
            data.interactive && !data.rollup
              ? decisionAnswerCard(decision, data.csrf, data.now, false)
              : html`<a class="decide-card" href="/d/${decision.id}"><p class="q">${decision.question}</p><span class="mono meta">${decision.taskId}</span>${chip(decision.repo)}${isOverdue(decision, data.now) ? html` <span class="badge badge-overdue">Overdue</span>` : null}</a>`,
          ),
          "\n",
        )}`;

  const approvals =
    data.approvals.length === 0
      ? null
      : html`<h2>Approve a scope</h2><p class="hint">scopes waiting for your approval — each binds to the exact wording you sign</p>${joinHtml(
          data.approvals.map(
            one =>
              html`<a class="decide-card" href="${taskHref(one.taskId)}"><p class="q">${one.title}</p><span class="meta">${one.goal.length > 120 ? one.goal.slice(0, 120) + "…" : one.goal}</span><br><span class="mono meta">${one.taskId}</span>${chip(one.repo)} <span class="right meta">${one.closed == null ? html`review &amp; approve →` : html`needs attention: ${one.closed.toLowerCase()} →`}</span></a>`,
          ),
          "\n",
        )}`;

  const requeueables =
    data.requeueables.length === 0
      ? null
      : html`<h2>Retry stalled work</h2><p class="hint">failed builds waiting for a person — retry clears the incidents and requeues</p>${joinHtml(
          data.requeueables.map(
            one =>
              html`<p class="row"><a href="${taskHref(one.taskId)}">${one.taskId}</a> ${one.title}${chip(one.repo)}${one.incidentCount > 0 ? html` <span class="badge badge-failed">${one.incidentCount} incident${one.incidentCount > 1 ? "s" : ""}</span>` : null}${one.strikes > 0 ? html` <span class="meta">${one.strikes} failed attempt${one.strikes > 1 ? "s" : ""}</span>` : null}${
                data.rollup
                  ? html`<span class="right meta">open its project to retry →</span></p>`
                  : html`<span class="right">${postForm(`${taskHref(one.taskId)}/requeue`, html`<button type="submit">Retry</button>`, { attrs: { class: "inline" }, returnTo: "inbox" })}</span></p>`
              }`,
          ),
          "\n",
        )}`;

  const needsVerification =
    data.needsVerification.length === 0
      ? null
      : html`<h2>Needs review</h2><p class="hint">finished, but the evidence needs your attention before accepting</p>${joinHtml(
          data.needsVerification.map(
            one =>
              html`<p class="row"><a href="${taskHref(one.taskId)}">${one.taskId}</a> ${one.title}${chip(one.repo)} <span class="badge badge-failed">${one.verdict === "refuted" ? "conflicting evidence" : "missing evidence"}</span>${criterionMatrixSummary(one.matrix ?? [])}${one.repairChain == null ? null : html` <span class="meta">— repair ${one.repairChain.outcome === "drafted" ? "drafted, awaiting approval" : one.repairChain.outcome}</span>`}</p>`,
          ),
          "\n",
        )}`;

  const cancelled =
    data.cancelledBlockers.length === 0
      ? null
      : html`<h2>Choose how waiting tasks continue</h2><p class="hint">these tasks were waiting for work that was cancelled — open one and choose what happens next</p>${joinHtml(
          data.cancelledBlockers.map(
            one =>
              html`<p class="row"><a href="${taskHref(one.exampleDependent)}">${one.exampleDependent}</a>${chip(one.repo)} <span class="meta">${one.dependentCount > 1 ? `one of ${one.dependentCount} tasks waiting` : "waiting"} for cancelled task ${one.blockerId}${data.rollup && one.repo !== one.blockerRepo ? html` · across projects${one.repo === null || one.repo === undefined ? null : html` — waits in ${projectName(one.repo)}`}` : null}</span></p>`,
          ),
          "\n",
        )}`;

  const gaps =
    data.gaps.length === 0
      ? null
      : html`<h2>Supply a requirement</h2><p class="hint">approved work is ready except for these — fill one and its tasks start</p>${joinHtml(
          data.gaps.map(
            gap =>
              html`<p class="row"><a href="/caps">${gap.key}</a> <span class="meta">frees ${gap.unblocks.length} task${gap.unblocks.length > 1 ? "s" : ""}</span><span class="right meta">how to fix →</span></p>`,
          ),
          "\n",
        )}`;

  // The first-run steps, until the first Ready result: each is done or
  // shows the one action that does it.
  const wizard =
    data.wizard === null
      ? null
      : html`<div class="card" data-first-run><p><strong>Get to your first result</strong></p>${joinHtml(
          data.wizard.map(
            step =>
              html`<p class="row" data-step="${step.key}"><span class="mono" aria-hidden="true">${step.done ? "✓" : "○"}</span> <strong>${step.title}</strong>${
                step.checking ? html` <span class="meta">checking…</span>` : step.action === null ? html` <span class="meta">done</span>`
                : step.action.kind === "link" ? html` <a href="${step.action.href}">${step.action.label}</a>`
                : html` <code>${step.action.command}</code>`
              }</p>`,
          ),
          "\n",
        )}</div>`;

  const noWorker =
    data.worker.answering > 0
      ? null
      : html`<div class="card builder-notice" data-builder-status="${data.worker.registered === 0 ? "not-connected" : "disconnected"}">${
          data.worker.registered === 0
            ? html`<strong>No builder is connected yet.</strong> Toolroll is open, but no machine is connected to do project work. On the machine where the project lives, open that folder and run <span class="mono">toolroll up</span>. Keep Toolroll running; approved work starts automatically.`
            : html`<strong>Builder disconnected.</strong> ${data.worker.registered} builder${data.worker.registered === 1 ? " is" : "s are"} configured, last checked in ${data.worker.lastHeard === null ? "never" : whenTime(data.worker.lastHeard)}. Reopen Toolroll on that machine. Queued work starts automatically when a builder reconnects.`
        }</div>`;

  // Console v2: Needs you · Ready · Running · All, as real links (Back and
  // bookmarks work). Each section belongs to one tab; All shows every one.
  const tab = data.tab ?? "all";
  const shows = (one: Exclude<InboxTab, "all">): boolean => tab === "all" || tab === one;
  const listRows = (rows: { taskId: string; title: string; detail: string; repo: string | null }[]): Html =>
    joinHtml(rows.map(one => html`<p class="row"><a href="${taskHref(one.taskId)}">${one.title}</a>${chip(one.repo)} <span class="meta">${one.detail}</span></p>`), "\n");
  const ready = (data.ready ?? []).length === 0 ? null : html`<h2>Ready to review</h2>${listRows(data.ready ?? [])}`;
  const running = (data.running ?? []).length === 0 ? null : html`<h2>Running now</h2>${listRows(data.running ?? [])}`;
  const asks = { decide: data.decisions.length + data.approvals.length, unblock: data.requeueables.length + data.cancelledBlockers.length + data.gaps.length };
  const counts: Record<InboxTab, number> & typeof asks = { ...asks,
    "needs-you": asks.decide + asks.unblock,
    ready: data.needsVerification.length + (data.ready ?? []).length,
    running: (data.running ?? []).length,
    all: 0,
  };
  counts.all = counts["needs-you"] + counts.ready + counts.running;
  // Each ask is a small heading with its count over its sections (their own headings one step down).
  const askGroup = (ask: Ask, count: number, sections: HtmlValue[]): Html | null => count === 0 ? null
    : html`<section class="inbox-ask" data-ask="${ask}"><h2>${ASK_LABEL[ask]} <span class="count">${count}</span></h2>${replaceMarkup(joinHtml(sections), /<(\/?)h2>/g, (_match, slash) => slash === "/" ? html`</h3>` : html`<h3>`)}</section>`;
  const tabs = data.tab === undefined ? null : html`<nav class="inbox-tabs" aria-label="Inbox views">${INBOX_TABS.map(one =>
    html`<a href="/inbox?tab=${one.id}"${one.id === tab ? html` aria-current="page"` : null} data-inbox-tab="${one.id}">${one.label}<span class="inbox-tab-count${one.id === "needs-you" && counts[one.id] > 0 ? " inbox-tab-count--needs" : ""}">${counts[one.id]}</span>${one.id !== tab && (data.unread ?? []).includes(one.id) ? html`<span class="inbox-unread" aria-label="new"></span>` : null}</a>`)}</nav>`;
  const tabEmpty = data.tab !== undefined && tab !== "all" && counts[tab] === 0
    ? html`<div class="card"><p class="meta">${tab === "needs-you" ? "Nothing needs you." : tab === "ready" ? "No results are waiting for review." : "Nothing is running."}</p></div>` : null;
  return screen("inbox", joinHtml([
    html`<h1>Inbox</h1>`,
    html`<p class="meta">Everything that waits on you — empty means the fleet is working</p>`,
    tabs,
    noWorker,
    wizard,
    empty || !shows("needs-you") ? null : html`<p><a class="new-task" style="display:inline-block" href="/next">clear the queue → one thing at a time</a></p>`,
    empty && data.wizard === null && shows("needs-you") && counts.all === 0 ? html`<div class="card"><p><strong>Nothing needs you.</strong></p><p class="meta">The queue is either working or waiting on its own timers. <a href="/board">Watch the board</a> or <a href="/activity">read the activity report</a>.</p></div>` : tabEmpty,
    // What waits on a person, grouped by what it asks: Decide, then Review, then Unblock.
    shows("needs-you") ? askGroup("decide", counts.decide, [approvals, decisions]) : null,
    shows("ready") ? askGroup("review", counts.ready, [needsVerification, ready]) : null,
    shows("needs-you") ? askGroup("unblock", counts.unblock, [requeueables, cancelled, gaps]) : null,
    shows("running") ? running : null,
    data.rollup
      ? html`<p class="meta">Requirement gaps are checked one project at a time — open a project to see and fill its gaps · <a href="/projects">open a project</a></p>`
      : null,
    // Quick capture: the shortest path from "I want this done" to the
    // approve card — title and goal here, the yes on the next screen. The
    // one-shot form posts to the same guarded handler as the full page.
    data.rollup ? null : html`<h2>Capture new work</h2>`,
    data.rollup ? null : postForm("/tasks/add", joinHtml([
      html`<label>What should get done<input type="text" name="title" placeholder="task title" maxlength="200"></label>`,
      html`<label>What success looks like <span class="meta">(becomes the scope you approve on the next screen)</span><textarea name="goal" rows="2"></textarea></label>`,
      html`<button type="submit">Queue it → approve its scope next</button>`,
    ], "\n"), { attrs: { class: "card" }, projectRevision: data.revision }),
  ], "\n"), {
    chrome,
    // The inline-answer enhancement rides only where its forms render; it
    // touches one card and nothing else, so quick-capture input survives.
    ...(data.interactive && !data.rollup && data.decisions.length > 0
      ? { functional: { script: decisionAnswerScript(), fetches: true } }
      : {}),
  });
}

/** System: the machinery — workers, background service, workspaces. */
export function systemPage(chrome: Chrome, data: {
  agents: {
    phase: "plan" | "build" | "repair" | "review";
    provider?: string;
    model?: string | null;
    source?: "pinned" | "flag" | "project" | "installation" | "default";
    problem?: string;
    setBy: string | null;
  }[];
  building: { taskId: string; runner: string; claimedAt: string; expiresAt: string; model: string | null }[];
  runners: Runner[];
  worktrees: WorktreeRow[];
  episode: { id: number; startedAt: string; endedAt: string | null; ticks: number; built: number; broke: number } | null;
  outboxPending: number;
  externalWork?: { remoteRepo: string; blocked: string | null; openEpisode: string | null }[];
  now: Date;
}): Screen {
  const nowMs = data.now.getTime();
  const runnerCards = data.runners
    .filter(one => one.retiredAt === null)
    .map(one => {
      const age = nowMs - new Date(one.heartbeatAt).getTime();
      const dot = age < 5 * 60_000 ? "dot-ok" : age < 60 * 60_000 ? "dot-warn" : "dot-off";
      const said = age < 5 * 60_000 ? "alive" : age < 60 * 60_000 ? `quiet ${Math.round(age / 60_000)}m` : "not heard from";
      const busy = data.building.filter(claim => claim.runner === one.name).length;
      return html`<div class="stat-card"><span class="k"><span class="dot ${dot}"></span>${one.name}</span><span class="v">builder · ${said} · ${busy}/${one.capacity} building</span></div>`;
    });
  const worktreeCards = data.worktrees.map(tree => {
    const leased = tree.leasedAt !== null && tree.releasedAt === null;
    const dot = leased ? "dot-ok" : tree.verified ? "dot-off" : "dot-warn";
    const state = leased ? "building" : tree.verified ? "free" : "needs review";
    const name = tree.path.split("/").pop() ?? tree.path;
    return html`<div class="stat-card"><span class="k"><span class="dot ${dot}${leased ? " pulse" : ""}"></span><span class="mono">${name}</span></span><span class="v">workspace · ${tree.branch} · ${state}</span></div>`;
  });
  const watchCard =
    data.episode === null
      ? null
      : html`<div class="stat-card"><span class="k"><span class="dot ${data.episode.endedAt === null ? "dot-ok pulse" : "dot-off"}"></span>Toolroll</span><span class="v">${
          data.episode.endedAt === null
            ? html`running since ${whenTime(data.episode.startedAt)}`
            : html`last run: ${data.episode.built} built, ${data.episode.broke} broke · ended ${whenTime(data.episode.endedAt)}`
        }</span></div>`;
  const cards = [...runnerCards, watchCard, ...worktreeCards].filter((one): one is Html => one !== null);
  const PHASE_SAID: Record<string, string> = {
    plan: "planning sessions ask questions and draft the plan you approve",
    build: "builds do the work, unattended, inside the approved scope",
    repair: "repair turns mend a malformed handoff in the same session",
  };
  const agentLines = joinHtml(data.agents
    .map(one => {
      if (one.problem !== undefined) {
        return html`<p class="row"><span class="mono">${one.phase}</span> <span class="badge badge-failed">Misconfigured</span> <span class="meta">${one.problem}</span></p>`;
      }
      const who =
        one.source === "project"
          ? html`chosen for this project${one.setBy === null ? null : html` by ${one.setBy}`}`
          : one.source === "installation"
            ? html`set for the whole installation${one.setBy === null ? null : html` by ${one.setBy}`}`
            : html`the default — nothing configured`;
      const dollars = one.provider === "claude" ? null : html` · <span title="this provider reports tokens, not dollars — its runs land as unmeasured spend">no dollar costs</span>`;
      return html`<p class="row"><span class="mono">${one.phase}</span> <strong>${one.provider ?? ""}</strong>${one.model === null || one.model === undefined ? html` <span class="meta">(its default model)</span>` : html` · <span class="mono">${one.model}</span>`}<span class="right meta">${who}${dollars}</span></p><p class="meta" style="margin-top:0">${PHASE_SAID[one.phase] ?? ""}</p>`;
    }), "\n");
  const agentsCard =
    html`<h2>Agents</h2><p class="meta">Which AI provider runs each phase — changed from the terminal with your credentials (<code>toolroll config</code>), never by a browser click</p><div class="card">${agentLines}<p class="meta">Repair always stays on the provider that built — only its model can differ. A schedule's task filed under an approval moved from a routine is pinned to the agents approved then.</p></div>`;

  return screen("system", joinHtml([
    html`<h1>System</h1>`,
    html`<p class="hint">builders execute tasks in isolated temporary copies of each project</p>`,
    agentsCard,
    cards.length === 0
      ? html`<p class="meta">No builder is connected yet. On the machine where the project lives, open that folder and run <code>toolroll up</code>.</p>`
      : html`<div class="cards">${cards}</div>`,
    data.outboxPending > 0 ? html`<p class="meta">Notifications: ${data.outboxPending} pending delivery</p>` : null,
    (data.externalWork ?? []).length === 0
      ? null
      : html`<h2>External work</h2>${joinHtml(
          (data.externalWork ?? []).map(
            one =>
              html`<p class="row"><span class="mono">${one.remoteRepo}</span> ${
                one.blocked !== null
                  ? html`<span class="badge badge-failed">Dispatch blocked</span> <span class="meta">the tracker connection needs repair — \`toolroll sync\` says why</span>`
                  : one.openEpisode !== null
                    ? html`<span class="badge badge-failed">Sync failing</span> <span class="meta">${one.openEpisode}</span>`
                    : html`<span class="meta">syncing normally</span>`
              }</p>`,
          ),
          "\n",
        )}`,
  ], "\n"), { chrome, refreshSeconds: data.building.length > 0 ? 10 : 60 });
}

/**
 * The board: the pipeline as lanes, position as meaning — attention, then
 * queued, then waiting, then building, then recently done. Read-only by
 * construction (every card is a link, no forms, no nonces), which is what
 * makes it safe to re-render itself while somebody watches.
 */
export function boardBody(
  data: {
    cards: BoardCard[];
    done: ReturnType<Store["listCompletedWorkScoped"]>;
    saturated: boolean;
    now: Date;
    /** The rolled-up view: every project inside the ceiling at once. */
    all: boolean;
    project: string | null;
    delta: { agoMinutes: number; built: number; failed: number; questions: number } | null;
  },
  ciRed: (pr: number) => boolean,
): Html {
  const chip = (repo: string | null): Html | null =>
    !data.all || repo === null ? null : html`<span class="badge">${projectName(repo)}</span>`;
  const CAP = 30;
  const age = (iso: string): string => {
    const minutes = Math.max(1, Math.round((data.now.getTime() - new Date(iso).getTime()) / 60_000));
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / (24 * 60))}d`;
  };

  const lane = (
    key: "attention" | "queued" | "waiting" | "building",
    title: string,
    hint: string,
    renderOne: (card: BoardCard, index: number) => Html,
  ): Html => {
    const cards = data.cards.filter(card => card.lane === key);
    // The longest-stalled card leads the board: attention sorts by how
    // long it has waited, everything else stays newest-first — except the
    // queued lane, which reads in DISPATCH order: moved-up work first,
    // exactly as the next free worker will pick it.
    if (key === "attention") {
      cards.sort((a, b) =>
        (a.stalledSince ?? "9999").localeCompare(b.stalledSince ?? "9999"),
      );
    }
    if (key === "queued") {
      // Group: the shared queue first, then reserved columns by worker;
      // dispatch order (rank) within each — never a cross-column rank race.
      cards.sort((a, b) => {
        const ka = a.assignedRunner ?? "";
        const kb = b.assignedRunner ?? "";
        if (ka !== kb) return ka.localeCompare(kb);
        return b.priority - a.priority;
      });
    }
    const shown = cards.slice(0, CAP);
    const more = cards.length - shown.length;
    // A lane is a section that can fold (board pass): open when it holds
    // cards, folded when empty, so a phone reads the counts first and a
    // desktop column never spends its height on "nothing here".
    return html`<details class="lane lane-${key}"${shown.length === 0 ? null : html` open`}><summary><h2>${title} <span class="lane-count">${cards.length}${data.saturated ? "+" : ""}</span></h2></summary><p class="hint">${hint}</p>${shown.length === 0 ? html`<p class="meta lane-empty">nothing here</p>` : shown.map((card, index) => renderOne(card, index))}${more > 0 ? html`<a class="lane-more" href="/tasks">+${more} more in the task list</a>` : null}</details>`;
  };

  // The card's facts: mono key–value pairs under the title (board pass) —
  // task, worker, runtime — the same grammar on every lane, so the eye
  // learns one card. Chips carry the words (project, reservation).
  const facts = (rows: [string, string][]): Html | null =>
    rows.length === 0
      ? null
      : html`<span class="facts">${rows.map(([k, v]) => html`<span class="fact"><span class="k">${k}</span><span class="v">${v}</span></span>`)}</span>`;
  const chips = (parts: (Html | null)[]): Html | null => {
    const kept = parts.filter((one): one is Html => one !== null);
    return kept.length === 0 ? null : html`<span class="chips">${joinHtml(kept, " ")}</span>`;
  };

  const plain = (card: BoardCard): Html =>
    html`<a class="lane-card" href="${card.href}"><span class="id">${card.taskId}</span><span class="t">${card.title}</span><span class="why">${card.reason}</span>${facts([
      ...(card.stalledSince === null ? [] : [["waiting", age(card.stalledSince)] as [string, string]]),
    ])}${chips([
      chip(card.repo),
    ])}</a>`;

  // The queued lane: ranks compare only within a COLUMN (queue-columns
  // review, finding 14), so the badge is per column head — the shared
  // queue's front card says "next up"; a reserved column's front card
  // says whose turn it is. No cross-column comparison is claimed.
  const queuedHeads = (() => {
    const heads = new Map<string, string>();
    for (const card of data.cards.filter(one => one.lane === "queued")) {
      const key = `${card.assignedRunner ?? ""}|${card.repo ?? ""}`;
      if (!heads.has(key)) heads.set(key, card.taskId);
    }
    return heads;
  })();
  const queuedCard = (card: BoardCard): Html =>
    html`<a class="lane-card" href="${card.href}"><span class="id">${card.taskId}</span><span class="t">${card.title}</span><span class="why">${card.reason}</span>${facts([
      ["worker", card.assignedRunner === null ? "any free worker" : card.assignedRunner],
    ])}${chips([
      queuedHeads.get(`${card.assignedRunner ?? ""}|${card.repo ?? ""}`) === card.taskId
        ? html`<span class="badge">${card.assignedRunner === null ? "next up" : `next for ${card.assignedRunner}`}</span>`
        : null,
      card.assignedRunner === null ? null : html`<span class="badge">Reserved</span>`,
      chip(card.repo),
    ])}</a>`;

  const building = (card: BoardCard): Html => {
    const claim = card.claim;
    if (claim === null) return plain(card);
    const minutes = Math.max(1, Math.round((data.now.getTime() - new Date(claim.claimedAt).getTime()) / 60_000));
    const workspace = claim.worktree === null ? null : (claim.worktree.split("/").pop() ?? claim.worktree);
    // Chip copy: unknown phases show nothing rather than raw tokens.
    const phase = claim.phase === null ? undefined : PHASE_WORDS[claim.phase];
    // The live strip is the run's own phase and clock — never a percent:
    // a build has no honest progress figure, only a stage and an elapsed.
    const live = claim.model === null ? "preparing workspace" : (phase ?? "the agent is working");
    return html`<a class="lane-card building" href="${card.href}"><span class="id">${card.taskId}</span><span class="t"><span class="dot dot-ok pulse"></span>${card.title}</span><span class="live-line"><span class="stage">${live}</span><span class="clock">${minutes}m</span></span>${facts([
      ["worker", claim.runner],
      ...(claim.model === null
        ? []
        : [["model", `${claim.provider !== null && claim.provider !== "claude" ? `${claim.provider} · ` : ""}${claim.model}`] as [string, string]]),
      ...(claim.branch === null ? [] : [["branch", `${claim.branch}${workspace === null ? "" : ` · ${workspace}`}`] as [string, string]]),
    ])}${chips([
      card.attempt === null ? null : html`<span class="badge">Attempt ${card.attempt}</span>`,
      chip(card.repo),
    ])}</a>`;
  };

  const doneCards =
    data.done.length === 0
      ? html`<p class="meta lane-empty">nothing finished yet</p>`
      : data.done.map(row => {
          const pr =
            row.prNumber === null
              ? null
              : html`<span class="badge badge-open">PR #${row.prNumber}</span>${ciRed(row.prNumber) ? html` <span class="badge badge-failed">CI failing</span>` : null}`;
          return html`<a class="lane-card" href="${taskHref(row.taskId)}"><span class="id">${row.taskId}</span><span class="t">${row.title}</span>${row.handoff === null ? null : html`<span class="why">${row.handoff.length > 120 ? row.handoff.slice(0, 120) + "…" : row.handoff}</span>`}${facts([
            ...(row.ranMinutes === null ? [] : [["ran", `${row.ranMinutes}m`] as [string, string]]),
            ["usage", runCostWords({ authMode: row.authMode, costUsd: row.costUsd, tokensIn: null, tokensOut: null })],
          ])}${chips([
            html`<span class="badge badge-done">${row.outcome === "no-change" ? "No change" : "Built"}</span>`,
            pr,
            data.all && row.repo !== null ? html`<span class="badge">${projectName(row.repo)}</span>` : null,
          ])}</a>`;
        });

  const toggle =
    data.project === null && !data.all
      ? null
      : html`<p class="meta board-scope">${
          data.all
            ? html`${data.project === null
                ? html`<strong>All projects</strong>`
                : html`<a href="/board">${projectName(data.project)}</a> · <strong>all projects</strong>`} — every project this server serves, each card wearing its project`
            : html`<strong>${projectName(data.project as string)}</strong> · <a href="/board?scope=all">all projects</a>`
        }</p>`;

  const ago = (minutes: number): string =>
    minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / (24 * 60))}d`;
  const deltaLine =
    data.delta === null
      ? null
      : html`<p class="meta"><strong>Since you last looked</strong> (${ago(data.delta.agoMinutes)} ago): ${joinHtml(
          [
            data.delta.built > 0 ? html`<span class="good">${data.delta.built} built</span>` : null,
            data.delta.failed > 0 ? html`<span class="bad">${data.delta.failed} failed</span>` : null,
            data.delta.questions > 0
              ? html`${data.delta.questions} question${data.delta.questions > 1 ? "s" : ""} — <a href="/next">answer →</a>`
              : null,
          ].filter((one): one is Html => one !== null),
          html` · `,
        )}</p>`;

  return joinHtml([
    html`<h1>Board</h1>`,
    data.all ? null : html`<p class="meta board-view"><strong>State</strong> · <a href="/board?view=order">order →</a> <span class="meta">drag to reorder, or to reserve a task for one worker</span></p>`,
    deltaLine,
    toggle,
    html`<div class="board">`,
    lane("attention", "needs you", "these wait for a person", plain),
    lane("queued", "queued", "starts when a worker is free", queuedCard),
    lane("waiting", "waiting", "paused until a time, another task, or a requirement is ready", plain),
    lane("building", "building", "one agent per card, in its own workspace", building),
    html`<details class="lane lane-done"${data.done.length === 0 ? null : html` open`}><summary><h2><a href="/done">done recently</a></h2></summary><p class="hint">the most recent — the full list is under done</p>${doneCards}</details>`,
    html`</div>`,
  ], "\n");
}

/** Completed work: one row per done task, its final run and PR attached. */
export function donePage(
  chrome: Chrome,
  rows: ReturnType<Store["listCompletedWorkScoped"]>,
  ciRed: (pr: number) => boolean,
): Screen {
  const list =
    rows.length === 0
      ? html`<p class="meta">No finished tasks yet.</p>`
      : joinHtml(rows.map(row => {
          const pr =
            row.prNumber === null
              ? row.publicationState === null
                ? null
                : html` <span class="badge">${sentenceCase(row.publicationState)}</span>`
              : html` <a href="${row.prUrl ?? "#"}" class="badge badge-open">PR #${row.prNumber}</a>${ciRed(row.prNumber) ? html` <span class="badge badge-failed">CI failing</span>` : null}`;
          const needsVerification =
            (row.proofVerdict === "short" || row.proofVerdict === "refuted") && !row.proofAccepted
              ? html` <span class="badge badge-failed">${row.proofVerdict === "refuted" ? "conflicting evidence" : "missing evidence"}</span>`
              : null;
          return html`<div class="card"><p><a href="${taskHref(row.taskId)}"><strong>${row.title}</strong></a>${row.outcome === "no-change" ? html` <span class="badge">No change needed</span>` : null}${pr}${needsVerification}${criterionMatrixSummary(row.proofMatrix)}</p>${row.handoff === null ? null : html`<p class="meta">${row.handoff.length > 200 ? row.handoff.slice(0, 200) + "…" : row.handoff}</p>`}<p class="meta mono">${row.taskId} · ${whenTime(row.completedAt)}${row.ranMinutes === null ? null : html` · ran ${row.ranMinutes}m`}${row.provider === null ? null : html` · ${runCostWords({ authMode: row.authMode, costUsd: row.costUsd, tokensIn: null, tokensOut: null })}`} · <a href="${reviewHref(row.taskId)}">review →</a></p></div>`;
        }), "\n");
  return screen("done", joinHtml([
    html`<h1>Done</h1>`,
    buildsViews("done"),
    html`<p class="hint">completed work in order of completion — each with its final build, the agent's conclusion, usage, and its pull request; <a href="/review">review</a> opens the same saved work and its checks</p>`,
    list,
  ], "\n"), { chrome });
}

export function homePage(chrome: Chrome, data: {
  csrf: string;
  taskCount: number;
  repo: string | null;
  building: { taskId: string; runner: string; claimedAt: string; expiresAt: string; model: string | null }[];
  runners: Runner[];
  worktrees: WorktreeRow[];
  episode: { id: number; startedAt: string; endedAt: string | null; ticks: number; built: number; broke: number } | null;
  summary: ReturnType<typeof tally<Run & { taskId: string }>>;
  decisions: (Decision & { taskId: string })[];
  incidents: (Incident & { taskId: string })[];
  stranded: { id: string; blockedBy: string[] }[];
  gaps: Gap[] | null;
  outboxPending: number;
  settings: boolean;
  now: Date;
}): Screen {
  const { summary } = data;
  // The night's harvest is the page's reason to exist — strong figures in a
  // sentence, colored by what they mean, never a metric-card grid.
  const ledger =
    html`<p class="ledger"><span class="good"><b>${summary.built.length}</b> built</span> · <span${summary.failed.length > 0 ? html` class="bad"` : null}><b>${summary.failed.length}</b> failed</span> · <b>${summary.refused.length}</b> refused${summary.cutDown.length > 0 ? html` · <span class="bad"><b>${summary.cutDown.length}</b> cut down mid-flight</span>` : null}</p>`;

  const decide =
    data.decisions.length === 0
      ? html`<p class="meta">Nothing waits on you. No questions came up.</p>`
      : joinHtml(data.decisions.map(
          decision =>
            html`<a class="decide-card" href="/d/${decision.id}"><p class="q">${decision.question}</p><span class="mono meta">${decision.taskId}</span>${isOverdue(decision, data.now) ? html` <span class="badge badge-overdue">Overdue</span>` : null}</a>`,
        ), "\n");

  const incidents =
    data.incidents.length === 0
      ? null
      : html`<h2>Incidents</h2><p class="hint">builds that stopped and need a person — resolve here, or open the task to retry it</p>${joinHtml(
          data.incidents.map(
            one =>
              html`<p class="row"><a href="${taskHref(one.taskId)}">${one.taskId}</a> — ${incidentWords(one.kind)}<span class="right">${postForm(`/i/${one.id}/resolve`, html`<button type="submit">Resolve</button>`, { attrs: { class: "inline" } })}</span></p>`,
          ),
          "\n",
        )}`;

  const stranded =
    data.stranded.length === 0
      ? null
      : html`<h2>Tasks waiting on failed work</h2><p class="hint">open a task and choose whether to try the failed work again, wait for something else, or continue without it</p>${joinHtml(
          data.stranded.map(
            one =>
              html`<p class="row"><a href="${taskHref(one.id)}">${one.id}</a> waits on ${joinHtml(one.blockedBy.map(blocker => html`<a href="${taskHref(blocker)}">${blocker}</a>`), ", ")} <span class="right meta">choose what happens →</span></p>`,
          ),
          "\n",
        )}`;

  const gaps =
    data.gaps === null || data.gaps.length === 0
      ? null
      : html`<h2>Missing requirements</h2><p class="hint">tools or credentials builds need — checked before any money is spent</p>${joinHtml(
          data.gaps.map(gap => html`<p class="row"><a href="/caps">${gap.key}</a> — ${gap.state}<span class="right meta">how to fix →</span></p>`),
          "\n",
        )}`;

  // Live at the fidelity the moment deserves: fast while something builds,
  // gentle when the page is just a briefing. GET-only, so refresh is safe.
  const refresh = data.building.length > 0 ? 10 : 60;

  // BUILDING RIGHT NOW: each live claim as a pulsing card — the one moment
  // an operator actually watches this page, so it re-renders itself.
  const building =
    data.building.length === 0
      ? null
      : html`<h2>Building now</h2><p class="hint">live builds — this page refreshes itself every 10 seconds while anything runs</p><div class="cards">${data.building.map(
          claim =>
            html`<a class="stat-card" href="${taskHref(claim.taskId)}" style="text-decoration:none"><span class="k"><span class="dot dot-ok pulse"></span>${claim.taskId}</span><span class="v">${claim.runner} · ${Math.max(1, Math.round((data.now.getTime() - new Date(claim.claimedAt).getTime()) / 60_000))}m elapsed${claim.model === null ? null : html` · ${claim.model}`}</span></a>`,
        )}</div>`;

  // THE FLEET: runners by heartbeat age, worktrees by lease state, the watch.
  const nowMs = data.now.getTime();
  const runnerCards = data.runners
    .filter(one => one.retiredAt === null)
    .map(one => {
      const age = nowMs - new Date(one.heartbeatAt).getTime();
      const dot = age < 5 * 60_000 ? "dot-ok" : age < 60 * 60_000 ? "dot-warn" : "dot-off";
      const said = age < 5 * 60_000 ? "alive" : age < 60 * 60_000 ? `quiet ${Math.round(age / 60_000)}m` : "not heard from";
      const busy = data.building.filter(claim => claim.runner === one.name).length;
      return html`<div class="stat-card"><span class="k"><span class="dot ${dot}"></span>${one.name}</span><span class="v">builder · ${said} · ${busy}/${one.capacity} building</span></div>`;
    });
  const worktreeCards = data.worktrees.map(tree => {
    const leased = tree.leasedAt !== null && tree.releasedAt === null;
    const dot = leased ? "dot-ok" : tree.verified ? "dot-off" : "dot-warn";
    const state = leased ? "building" : tree.verified ? "free" : "needs review";
    const name = tree.path.split("/").pop() ?? tree.path;
    return html`<div class="stat-card"><span class="k"><span class="dot ${dot}${leased ? " pulse" : ""}"></span><span class="mono">${name}</span></span><span class="v">workspace · ${tree.branch} · ${state}</span></div>`;
  });
  const watchCard =
    data.episode === null
      ? null
      : html`<div class="stat-card"><span class="k"><span class="dot ${data.episode.endedAt === null ? "dot-ok pulse" : "dot-off"}"></span>Toolroll</span><span class="v">${
          data.episode.endedAt === null
            ? html`running since ${whenTime(data.episode.startedAt)}`
            : html`last window: ${data.episode.built} built, ${data.episode.broke} broke · ended ${whenTime(data.episode.endedAt)}`
        }</span></div>`;
  const fleetCards = [...runnerCards, watchCard, ...worktreeCards].filter((one): one is Html => one !== null);
  const fleet =
    fleetCards.length === 0
      ? html`<h2>System status</h2><p class="hint">No builder is connected yet. On the machine where the project lives, open that folder and run <code>toolroll up</code>.</p>`
      : html`<h2>System status</h2><p class="hint">builders execute tasks in isolated temporary copies of each project</p><div class="cards">${fleetCards}</div>`;

  const startHere =
    data.taskCount === 0
      ? joinHtml([
          html`<div class="card">`,
          html`<p><strong>Nothing is queued yet — here is the whole loop:</strong></p>`,
          html`<p>1. <a href="/tasks">Add a task</a> — plain words for work you want done${data.repo === null ? null : html` in <span class="mono">${data.repo}</span>`}.</p>`,
          html`<p>2. Open it and write its scope — the goal, and what it must not become. Approve exactly that.</p>`,
          html`<p>3. Keep Toolroll running on the builder machine. Approved tasks build unattended, each on its own branch.</p>`,
          html`<p class="meta">When an agent is unsure it stops and asks — those questions land here, under “waiting on you”.</p>`,
          html`</div>`,
        ], "\n")
      : null;

  return screen("activity", joinHtml([
    html`<h1>Activity</h1>`,
    buildsViews("activity"),
    data.repo === null
      ? null
      : html`<p class="meta"><strong>${projectName(data.repo)}</strong> — the last 24 hours, honestly labeled: a rolling window, whatever your hours are</p>`,
    startHere,
    ledger,
    html`<p class="meta">Spend: ${consoleSpend(summary)}</p>`,
    data.outboxPending > 0 ? html`<p class="meta">Notifications: ${data.outboxPending} pending delivery</p>` : null,
    building,
    html`<h2>Needs your decision</h2><p class="hint">an agent stopped mid-build to ask — nothing proceeds until you answer</p>`,
    decide,
    incidents,
    stranded,
    gaps,
    fleet,
  ], "\n"), { chrome, refreshSeconds: refresh });
}

export type TaskComposerPrefill = { title: string; goal: string; not: string; touches: string; acceptance: string; values?: URLSearchParams };

/** The one front door for new work. The common path is one prompt and one
 * button; the detailed contract remains available in-place for templates,
 * experts, and the rare task that should skip repository-aware planning. */
/** Where new work goes when no project is open: a choice from the projects
 * this person already has, never a typed path; a new project is one link
 * away. Same-named checkouts show their parent folder to tell them apart. */
export function projectPickerHtml(projects: { path: string; name: string }[], chosen: string): Html {
  if (projects.length === 0) {
    return html`<label class="task-repo">Project folder <span class="meta">— no project is open, so the task must say where it belongs</span><input type="text" name="repo" value="${chosen}" required placeholder="/path/to/repository"></label><p class="meta task-repo-add">No projects yet. <a href="/projects?return=%2Ftasks%2Fnew">Add a project</a> to pick it here next time.</p>`;
  }
  const counts = new Map<string, number>();
  for (const one of projects) counts.set(one.name, (counts.get(one.name) ?? 0) + 1);
  const label = (one: { path: string; name: string }): string => {
    if ((counts.get(one.name) ?? 0) < 2) return one.name;
    const parent = one.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? one.path;
    return `${one.name} (${parent})`;
  };
  const selected = projects.some(one => one.path === chosen) ? chosen : projects[0]!.path;
  return html`<label class="task-repo">Project<select name="repo" required>${projects.map(one => html`<option value="${one.path}" title="${one.path}"${one.path === selected ? html` selected` : null}>${label(one)}</option>`)}</select></label><p class="meta task-repo-add"><a href="/projects?return=%2Ftasks%2Fnew">Add a project</a></p>`;
}

export function taskComposerHtml(data: {
  project: string | null;
  projectRevision?: number;
  prefill?: TaskComposerPrefill | null;
  candidates?: { id: string; title: string }[];
  permissionDefault: UnattendedPermissionMode;
  qualityDefault: QualityMode;
  /** Projects this person may place work in, most recently opened first. */
  projects?: { path: string; name: string }[];
}): Html {
  const prefill = data.prefill ?? null;
  const values = prefill?.values;
  const after = values?.get("after") ?? "";
  const candidates = data.candidates ?? (after === "" ? [] : [{ id: after, title: after }]);
  const projectLabel = data.project === null ? "repository required" : projectName(data.project);
  const showPicker = data.project === null || (data.projects !== undefined && data.projects.length > 1);
  const quality = values?.get("quality-mode") ?? data.qualityDefault;
  return postForm("/tasks/add", joinHtml([
    prefill === null || values !== undefined
      ? null
      : html`<p class="meta" style="margin:.35rem .75rem .15rem">pre-filled from a template. Change anything; it still waits for your approval.</p>`,
    html`<label class="task-prompt"><span class="visually-hidden">What should get done?</span><textarea name="title" rows="4" maxlength="200" required autofocus placeholder="Describe the outcome you want. The planner will inspect the repository and work out the implementation details.">${prefill === null ? "" : prefill.title}</textarea></label>`,
    // The project is always a visible, changeable choice when the page knows
    // the person's projects; the open project is simply preselected.
    showPicker ? projectPickerHtml(data.projects ?? [], values?.get("repo") ?? data.project ?? "") : null,
    html`<div class="task-composer-footer">`,
    html`<div class="task-context">${showPicker || data.project === null ? null : html`<span class="task-context-chip" title="${data.project}">${projectLabel}</span>`}<span class="task-context-chip">planner inspects first</span></div>`,
    html`<label class="task-quality"><span class="visually-hidden">quality mode</span><select name="quality-mode" aria-label="quality mode"><option value="default"${quality === "default" ? html` selected` : null}>Default quality</option><option value="strict"${quality === "strict" ? html` selected` : null}>Strict / release</option></select></label>`,
    html`<button type="submit" class="task-submit">${prefill === null ? "Plan task" : "Continue"} →</button>`,
    html`</div>`,
    html`<details class="task-options"${prefill === null ? null : html` open`}>`,
    html`<summary><span>Edit details</span><small>optional · defaults are remembered</small></summary>`,
    html`<div class="task-options-grid">`,
    html`<label class="wide">Goal <span class="meta">— provide upfront for automatic approval of an unchanged plan</span><textarea name="goal" rows="3" placeholder="What success looks like">${prefill === null ? "" : prefill.goal}</textarea></label>`,
    html`<label class="wide">Acceptance <span class="meta">— required with a goal; one per line: <code>statement | evidence,kinds | how</code></span><textarea name="acceptance" rows="3" placeholder="Requests over the limit return 429 | check">${prefill === null ? "" : prefill.acceptance}</textarea></label>`,
    html`<label>Not this <span class="meta">— optional boundary</span><input type="text" name="not" value="${prefill === null ? "" : prefill.not}"></label>`,
    html`<label>Likely touches <span class="meta">— paths, comma-separated</span><input type="text" name="touches" value="${prefill === null ? "" : prefill.touches}"></label>`,
    html`<label class="wide task-check"><input type="checkbox" name="plan-first" value="1"${values === undefined || values.get("plan-first") === "1" ? html` checked` : null}><span><strong>Let the planner inspect first</strong><small class="meta">Recommended. It drafts the goal, acceptance criteria, and implementation approach, and asks only when a missing answer materially changes the work.</small></span></label>`,
    html`<label class="wide task-check"><input type="checkbox" name="scout" value="1"${values?.get("scout") === "1" ? html` checked` : null}><span><strong>Research only</strong><small class="meta">Deliver a read-only report instead of changing the repository.</small></span></label>`,
    html`<label>Task id <span class="meta">— optional</span><input type="text" name="id" value="${values?.get("id") ?? ""}" placeholder="made from the request"></label>`,
    candidates.length === 0
      ? null
      : html`<label>Starts after <span class="meta">— optional</span><select name="after"><option value="">right away</option>${candidates.map(one => html`<option value="${one.id}"${one.id === after ? html` selected` : null}>${one.id} — ${one.title}</option>`)}</select></label>`,
    html`<fieldset class="permission-field"><legend>Agent permissions</legend>${permissionModeChoices("permission-mode", values?.get("permission-mode") === "bypassPermissions" ? "bypassPermissions" : values?.get("permission-mode") === "auto" ? "auto" : data.permissionDefault)}<p class="meta permission-note">Inherited from Settings. You can still change it on the proposed scope before approval.</p></fieldset>`,
    html`</div>`,
    html`</details>`,
  ], "\n"), {
    attrs: { class: "card task-composer" },
    projectRevision: data.projectRevision === undefined && values?.get("projectRevision") == null ? null : String(data.projectRevision ?? values?.get("projectRevision") ?? ""),
    hidden: { "planning-policy": "choice" },
  });
}

export type WorkRow = WorkFacts & { assignment?: AssignmentSnapshot | null; assignmentProblem?: boolean; executionId?: string; familyNotice?: string | null; status: WorkStatus; resultRunId: number | null };

export const TASK_GROUP_LABEL: Readonly<Record<WorkIndexGroup, string>> = { ...ASK_LABEL, building: 'Building', rest: 'Recent' };

export function workPage(
  chrome: Chrome,
  data: { view: WorkView; projectFilter?: string; work: WorkIndexPage; previous: boolean; multiProject: boolean; now: Date; limits?: BrowserLimits | null },
): Screen {
  const href = (view: WorkView, cursor?: string): string => {
    const query = new URLSearchParams();
    if (data.projectFilter !== undefined) query.set('project', data.projectFilter);
    if (view !== 'all') query.set('view', view);
    if (cursor !== undefined) query.set('cursor', cursor);
    return `/work${query.size ? `?${query}` : ''}`;
  };
  const tabs = html`<nav class="work-views" aria-label="Task views">${WORK_VIEWS.map(one =>
    html`<a href="${href(one.key)}"${one.key === data.view ? html` class="active" aria-current="page"` : null}>${one.label}<span class="count">${data.work.totals[one.key]}</span></a>`
  )}</nav>`;
  const rowHtml = (row: WorkIndexItem): Html => {
    const target = row.primaryAction?.target;
    const actionHref = row.primaryAction?.code === 'open-result' && target?.runId != null
      ? `/review?result=${encodeURIComponent(target.taskId)}&run=${target.runId}`
      : browserWorkActionHref(row);
    const action = actionHref === null || row.primaryAction === null ? null : html`<a class="work-action" data-primary-action href="${actionHref}">${row.primaryAction.label} →</a>`;
    const project = data.multiProject || row.repo === null ? html`<span class="project-label">${row.repo === null ? 'Unplaced' : projectName(row.repo)}</span>` : null;
    return html`<article class="work-row" data-task="${row.rootId}" data-work-status="${row.status.token}" data-work-views="${row.status.views.join(' ')}"><div class="work-row-main"><a class="work-title" href="${taskHref(row.rootId)}">${row.title}</a><p class="work-meta">${project}<span>${relativeAge(row.updatedAt, data.now)}</span></p></div><div class="work-row-status">${statusLineHtml(row.status)}${action}${row.familyProblem === null ? null : html`<p class="problem">${row.familyProblem}</p>`}${row.status.views.includes('needs-you') && !['write-scope', 'approve-scope'].includes(row.primaryAction?.code ?? '') && row.status.detail !== row.status.label && row.status.detail !== row.familyProblem ? html`<p class="work-detail">${row.status.detail}</p>` : null}${workDiagnosticsHtml(row.status.diagnostics)}</div></article>`;
  };
  const current = WORK_VIEWS.find(one => one.key === data.view)!;
  const list = data.work.items.length === 0
    ? html`<div class="work-empty" data-work-empty="${data.view}"><p>${data.previous ? 'There are no more tasks on this page.' : current.empty}</p>${data.view === 'all' && !data.previous ? html`<p><a class="button-link" href="${chrome.chat === true ? '/chat' : '/tasks/new'}">${chrome.chat === true ? 'Start in chat' : 'Add a task'}</a></p>` : html`<a href="${href('all')}">See all tasks →</a>`}</div>`
    : html`<div class="work-list">${data.work.items.map(rowHtml)}</div>`;
  const pages = !data.previous && data.work.nextCursor === null ? null : html`<nav class="row work-pagination" aria-label="Task pages">${data.previous ? html`<a class="button-link" href="${href(data.view)}">First page</a>` : null}${data.work.nextCursor === null ? null : html`<a class="button-link" rel="next" href="${href(data.view, data.work.nextCursor)}">Next page</a>`}</nav>`;
  const tools = html`<details class="work-tools"><summary>Work tools${CHEVRON_ICON}</summary><nav class="work-tools-menu">${[['/inbox', 'Inbox'], ['/board', 'Board'], ['/board?view=order', 'Order'], ['/tasks', 'Task list'], ['/recipes', 'Recipes'], ...(chrome.projectScoped ? [] : [['/workbench', 'Portfolio']]), ['/ledger', 'Action ledger']]
      .map(([path, label]) => html`<a href="${path}">${label}</a>`)}</nav></details>`;
  const toolLinks = [['/inbox', 'Inbox'], ['/board', 'Board'], ['/board?view=order', 'Order'], ['/tasks', 'Task list'], ['/recipes', 'Recipes'], ...(chrome.projectScoped ? [] : [['/workbench', 'Portfolio']])];
  const view: BrowserTasksView = {
    kind: 'tasks',
    tabs: WORK_VIEWS.map(one => ({ label: one.label, href: href(one.key), count: data.work.totals[one.key], active: one.key === data.view })),
    needsYou: data.work.totals['needs-you'],
    groups: data.view !== 'all' && data.view !== 'needs-you' ? null
      : ([...ASKS, ...(data.view === 'all' ? ['building', 'rest'] as const : [])] as WorkIndexGroup[])
        .map(key => ({ key, label: TASK_GROUP_LABEL[key], count: data.work.groups[key] })).filter(one => one.count > 0),
    rows: data.work.items.map(row => {
      const target = row.primaryAction?.target;
      const actionHref = row.primaryAction?.code === 'open-result' && target?.runId != null
        ? `/review?result=${encodeURIComponent(target.taskId)}&run=${target.runId}`
        : browserWorkActionHref(row);
      const needsYouDetail = (row.status.views.includes('needs-you') || row.status.label === 'Failed') && !['write-scope', 'approve-scope'].includes(row.primaryAction?.code ?? '') && row.status.label !== 'Ready for review' && row.status.detail !== row.status.label && row.status.detail !== row.familyProblem;
      return {
        id: row.rootId, title: row.title, href: taskHref(row.rootId),
        project: data.multiProject || row.repo === null ? (row.repo === null ? 'Unplaced' : projectName(row.repo)) : null,
        age: relativeAge(row.updatedAt, data.now),
        status: { label: row.status.label, tone: row.status.tone, token: row.status.token },
        ask: row.ask, chip: row.chip, group: row.ask ?? (row.status.rank === 1 ? 'building' : 'rest'),
        action: actionHref === null || row.primaryAction === null ? null : { label: row.primaryAction.label, href: actionHref },
        detail: needsYouDetail ? row.status.detail : (row as { progress?: string }).progress ?? null,
        problem: row.familyProblem,
        notes: (row.status.diagnostics ?? []).map(one => `${one.label} · ${one.detail}`),
      };
    }),
    empty: data.work.items.length > 0 ? null : {
      text: data.previous ? 'There are no more tasks on this page.' : current.empty,
      action: data.view === 'all' && !data.previous ? { label: chrome.chat === true ? 'Start in chat' : 'Add a task', href: chrome.chat === true ? '/chat' : '/tasks/new' } : { label: 'See all tasks', href: href('all') },
    },
    pages: { first: data.previous ? href(data.view) : null, next: data.work.nextCursor === null ? null : href(data.view, data.work.nextCursor) },
    tools: toolLinks.map(([path, label]) => ({ label: label!, href: path! })),
    newTask: { label: 'New task', href: '/tasks/new' },
    limits: data.limits ?? null,
  };
  return screen('work', html`<div class="work-head"><h1>Tasks</h1>${tools}</div>${limitsHtml(data.limits ?? null)}${tabs}${list}${pages}`, { chrome, workspace: { view } });
}

export function tasksPage(
  chrome: Chrome,
  tasks: Task[],
  state: TaskState | null,
  problem: string | null,
  repo: string | null = null,
  prefill: TaskComposerPrefill | null = null,
  permissionDefault: UnattendedPermissionMode = "auto",
  qualityDefault: QualityMode = "default",
  replaced: ReadonlyMap<string, string> = new Map(),
): Screen {
  const filters = joinHtml(TASK_STATES.map(
    one => (one === state ? html`<strong>${one}</strong>` : html`<a href="/tasks?state=${one}">${one}</a>`),
  ), " · ");
  const rows =
    tasks.length === 0
      ? html`<p class="meta">${
          state === null
            ? "The queue is empty — add the first task below. It builds once you approve its scope."
            : `Nothing is ${state}.`
        }</p>`
      : joinHtml(tasks.map(
          task =>
            html`<a class="row" href="${taskHref(task.id)}"><span class="mono">${task.id}</span> ${task.title} <span class="right badge badge-${task.state}">${task.state === "cancelled" && replaced.has(task.id) ? `replaced by ${replaced.get(task.id)}` : task.state}</span></a>`,
        ), "\n");
  return screen("tasks", joinHtml([
    html`<h1>Tasks</h1>`,
    html`<p class="meta">Work you want done${repo === null ? null : html` in <strong>${projectName(repo)}</strong>`} — a task builds unattended only after its scope is approved; open one to write or approve its scope</p>`,
    repo === null ? null : html`<p class="meta path-words"><span class="mono">${repo}</span></p>`,
    problem === null ? null : html`<div class="problem">${problem}</div>`,
    html`<p class="meta">Filter: <a href="/tasks">all</a> · ${filters}</p>`,
    rows,
    html`<h2>Add a task</h2>`,
    taskComposerHtml({ project: repo, prefill, permissionDefault, qualityDefault }),
  ], "\n"), { chrome });
}


export function browsePage(chrome: Chrome, data: {
  at: string;
  root: string;
  roots: string[];
  parent: string | null;
  entries: { name: string; path: string; git: boolean }[];
  /** Unused: postForm adds the request's CSRF field. Kept for callers. */
  csrf: string;
}): Screen {
  const crumb = data.at === data.root ? projectName(data.root) : `${projectName(data.root)}${data.at.slice(data.root.length)}`;
  const openForm = (path: string): Html =>
    postForm("/projects/open", html`<button type="submit">Open</button>`, { attrs: { class: "inline" }, hidden: { path } });
  return screen("projects", joinHtml([
    html`<h1>Choose a folder</h1>`,
    html`<p class="meta">git repositories float to the top and can be opened; anything else can be entered — only folders under ${
      data.roots.length === 1 ? html`<span class="mono">${projectName(data.root)}</span>` : "the configured roots"
    } are visible here</p>`,
    data.roots.length > 1
      ? html`<p class="meta">Roots: ${joinHtml(data.roots.map(one => html`<a href="/projects/browse?at=${encodeURIComponent(one)}" class="mono">${projectName(one)}</a>`), " · ")}</p>`
      : null,
    html`<p class="mono meta">${crumb}</p>`,
    data.parent === null
      ? null
      : html`<p class="row"><a href="/projects/browse?at=${encodeURIComponent(data.parent)}">← up one level</a></p>`,
    data.entries.length === 0
      ? html`<p class="meta">No folders here</p>`
      : joinHtml(data.entries.map(
          one =>
            html`<p class="row"><a href="/projects/browse?at=${encodeURIComponent(one.path)}"><strong>${one.name}</strong></a>${one.git ? html` <span class="badge badge-done">git</span>` : null}<span class="right">${one.git ? openForm(one.path) : html`<a class="meta" href="/projects/browse?at=${encodeURIComponent(one.path)}">enter →</a>`}</span></p>`,
        ), "\n"),
    html`<p class="meta"><a href="/projects">← back to projects</a></p>`,
  ], "\n"), { chrome });
}


/** The compact completed row shared by both halves of the control room. */
export type WorkbenchDone = { taskId: string; title: string; outcome: string | null; repo: string | null };

/**
 * The control-room rail (attended A1): every state that matters while a
 * person supervises, ordered by intervention cost. The project chip is
 * deliberately repeated on every row — a title is not a workspace, and
 * switching context must never depend on remembering which repo is open.
 */
export function workbenchRail(data: {
  attention: BoardCard[];
  building: BoardCard[];
  waiting: BoardCard[];
  queued: BoardCard[];
  done: WorkbenchDone[];
  selected: string | null;
  saturated: boolean;
}): Html {
  const workspace = (repo: string | null): Html =>
    html`<span class="badge">${repo === null ? "Unplaced" : projectName(repo)}</span>`;
  const row = (card: BoardCard, reason: HtmlValue): Html =>
    html`<a class="wb-row${card.taskId === data.selected ? " wb-selected" : ""}" href="/workbench?t=${encodeURIComponent(card.taskId)}"${card.taskId === data.selected ? html` aria-current="true"` : null}><span class="wb-title">${card.title}</span><span class="wb-meta"><span class="mono meta">${card.taskId}</span>${workspace(card.repo)}</span><span class="wb-reason">${reason}</span></a>`;
  const group = (title: HtmlValue, cards: BoardCard[], empty: string, render: (card: BoardCard) => Html): Html =>
    html`<section class="wb-group"><h2>${title} <span class="lane-count">${cards.length}</span></h2>${cards.length === 0 ? html`<p class="meta">${empty}</p>` : joinHtml(cards.slice(0, 100).map(render), "\n")}</section>`;
  const parts: Html[] = [];
  parts.push(
    html`<div class="wb-rail-head"><div><span class="eyebrow">portfolio</span><h2>All projects</h2></div><a href="/projects">manage →</a></div>`,
  );
  parts.push(group("needs you", data.attention, "Nothing needs your input.", card => row(card, card.reason)));
  parts.push(group("in progress", data.building, "No agent is working right now.", card => {
    const claim = card.claim;
    const phase = claim?.phase == null ? "working" : phaseWords(claim.phase);
    return row(
      card,
      html`${phase}${claim?.provider ? html` · ${claim.provider}` : null}${claim?.claimedAt ? html` · <time data-elapsed-since="${claim.claimedAt}"></time>` : null}`,
    );
  }));
  parts.push(group(html`blocked & waiting`, data.waiting, "Nothing is blocked or paused.", card => row(card, card.reason)));
  parts.push(group("up next", data.queued, "The ready queue is empty.", card => row(
    card,
    html`${card.reason}${card.assignedRunner === null ? null : html` · reserved for ${card.assignedRunner}`}`,
  )));
  if (data.done.length > 0) {
    parts.push(html`<section class="wb-group"><h2>Just finished <span class="lane-count">${data.done.length}</span></h2>`);
    parts.push(
      joinHtml(data.done.map(
        one =>
          html`<a class="wb-row${one.taskId === data.selected ? " wb-selected" : ""}" href="/workbench?t=${encodeURIComponent(one.taskId)}"><span class="wb-title">${one.title}</span><span class="wb-meta"><span class="mono meta">${one.taskId}</span>${workspace(one.repo)} <span class="badge badge-${one.outcome === "built" || one.outcome === "no-change" ? "done" : "failed"}">${sentenceCase(one.outcome ?? "?")}</span></span></a>`,
      ), "\n"),
    );
    parts.push(html`</section>`);
  }
  if (data.saturated) parts.push(html`<p class="meta">More exists — this rail is capped; the <a href="/board?scope=all">board</a> holds the rest</p>`);
  return joinHtml(parts, "\n");
}

/**
 * The portfolio overview (arc slice 1a): what waits on you, what the last
 * 24 hours of run starts amounted to, what is running, and the terminal-run
 * ledger — all of it across every admitted project, a project chip on every
 * row. The caller has already applied admission and per-row visibility.
 */
export function portfolioOverview(data: {
  attention: BoardCard[];
  building: BoardCard[];
  waiting: BoardCard[];
  queued: BoardCard[];
  done: WorkbenchDone[];
  saturated: boolean;
  decisions: (Decision & { taskId: string; repo?: string | null })[];
  approvals: { taskId: string; title: string; goal: string; proposedAt: string; repo?: string | null; /** v48 authority repair: the closed consent door's title, or null when a yes could bind. */ closed?: string | null }[];
  requeueables: { taskId: string; title: string; state: TaskState; strikes: number; incidentCount: number; repo?: string | null }[];
  cancelledBlockers: { blockerId: string; dependentCount: number; exampleDependent: string; repo?: string | null; blockerRepo?: string | null }[];
  gaps: Gap[];
  gapsProject: string | null;
  runs24: (Run & { taskId: string })[];
  live: { taskId: string; runner: string; claimedAt: string; expiresAt: string; model: string | null; repo: string | null }[];
  ledger: {
    runId: number; taskId: string; title: string; repo: string | null; outcome: string; role: string;
    provider: string | null; model: string | null; startedAt: string; ranMinutes: number | null;
    costUsd: number | null; authMode: "subscription" | "api-key" | null; prNumber: number | null; prUrl: string | null;
  }[];
  /** "" when there is no session token: then no form renders. postForm adds the field itself. */
  csrf: string;
  now: Date;
}): Html {
  type Pulse = { repo: string | null; attention: number; building: number; waiting: number; queued: number; done: number };
  const pulses = new Map<string, Pulse>();
  const pulseFor = (repo: string | null): Pulse => {
    const key = repo ?? "";
    const existing = pulses.get(key);
    if (existing !== undefined) return existing;
    const made = { repo, attention: 0, building: 0, waiting: 0, queued: 0, done: 0 };
    pulses.set(key, made);
    return made;
  };
  for (const card of [...data.attention, ...data.building, ...data.waiting, ...data.queued]) {
    pulseFor(card.repo)[card.lane] += 1;
  }
  for (const one of data.done) pulseFor(one.repo).done += 1;
  const pulseRows = [...pulses.values()].sort((a, b) =>
    b.attention - a.attention || b.building - a.building || b.waiting - a.waiting ||
    (a.repo === null ? 1 : b.repo === null ? -1 : projectName(a.repo).localeCompare(projectName(b.repo))),
  );
  const workspace = (repo: string | null): string => repo === null ? "Unplaced work" : projectName(repo);
  // A workspace card (board pass): the repo's name and one status word,
  // its four counts, a bar of the same counts in proportion, and — for a
  // real repo, with a session token — the one tap to its own board. The
  // status word is the loudest true thing: needs you beats building beats
  // waiting beats queued; a repo with nothing in flight is idle.
  const statusOf = (one: (typeof pulseRows)[number]): { word: string; cls: string } =>
    one.attention > 0
      ? { word: "needs you", cls: "badge-open" }
      : one.building > 0
        ? { word: "building", cls: "badge-running" }
        : one.waiting > 0
          ? { word: "waiting", cls: "" }
          : one.queued > 0
            ? { word: "queued", cls: "" }
            : { word: "idle", cls: "" };
  const workspaceRows = joinHtml(pulseRows.map(one => {
    const status = statusOf(one);
    const total = one.attention + one.building + one.waiting + one.queued;
    const seg = (cls: string, count: number): Html | null =>
      count === 0 ? null : html`<span class="seg ${cls}" style="flex-grow:${count}"></span>`;
    const boardForm =
      one.repo === null || data.csrf === ""
        ? null
        : postForm("/projects/open", html`<button type="submit">Board →</button>`, { attrs: { class: "inline" }, returnTo: "/board", hidden: { path: one.repo } });
    const setUpForm =
      one.repo === null || data.csrf === ""
        ? null
        : postForm("/projects/open", html`<button>Set up →</button>`, { attrs: { class: "inline" }, returnTo: "/control", hidden: { path: one.repo } });
    return html`<div class="workspace-card${one.attention > 0 ? " hot" : ""}"><div class="workspace-head"><span class="workspace-name">${workspace(one.repo)}</span><span class="badge ${status.cls}">${sentenceCase(status.word)}</span>${boardForm}${setUpForm}</div><div class="workspace-stats"><span class="pulse-stat${one.attention > 0 ? " hot" : ""}"><b>${one.attention}</b> need you</span><span class="pulse-stat"><b>${one.building}</b> live</span><span class="pulse-stat"><b>${one.waiting}</b> waiting</span><span class="pulse-stat"><b>${one.queued}</b> next</span></div><div class="workspace-bar${total === 0 ? " empty" : ""}" aria-hidden="true">${seg("attention", one.attention)}${seg("building", one.building)}${seg("waiting", one.waiting)}${seg("queued", one.queued)}</div></div>`;
  }), "\n");

  // ---- waits on you: everything a person must resolve, across projects ----
  const waitCount =
    data.decisions.length + data.approvals.length + data.requeueables.length +
    data.cancelledBlockers.length + data.gaps.length;
  const decisionCards = joinHtml(data.decisions.map(one => decisionAnswerCard(one, data.csrf, data.now, true)), "\n");
  const approvalCards = joinHtml(data.approvals.map(
    one =>
      html`<a class="decide-card" href="${taskHref(one.taskId)}"><p class="q">${one.title}</p><span class="meta">${one.goal.length > 120 ? one.goal.slice(0, 120) + "…" : one.goal}</span><br><span class="mono meta">${one.taskId}</span>${projectChip(one.repo)} <span class="right meta">review and sign →</span></a>`,
  ), "\n");
  const requeueRows = joinHtml(data.requeueables.map(
    one =>
      html`<p class="row"><a href="${taskHref(one.taskId)}">${one.taskId}</a> ${one.title}${projectChip(one.repo)}${one.incidentCount > 0 ? html` <span class="badge badge-failed">${one.incidentCount} incident${one.incidentCount > 1 ? "s" : ""}</span>` : null}${one.strikes > 0 ? html` <span class="meta">${one.strikes} failed attempt${one.strikes > 1 ? "s" : ""}</span>` : null}<span class="right meta">open the task to retry →</span></p>`,
  ), "\n");
  const cancelledRows = joinHtml(data.cancelledBlockers.map(
    one =>
      html`<p class="row"><a href="${taskHref(one.exampleDependent)}">${one.exampleDependent}</a>${projectChip(one.repo)} <span class="meta">${one.dependentCount > 1 ? `one of ${one.dependentCount} tasks waiting` : "waiting"} for cancelled task ${one.blockerId}</span><span class="right meta">choose what happens →</span></p>`,
  ), "\n");
  const gapRows = joinHtml(data.gaps.map(
    gap =>
      html`<p class="row"><a href="/caps">${gap.key}</a>${data.gapsProject === null ? null : projectChip(data.gapsProject)} <span class="meta">frees ${gap.unblocks.length} task${gap.unblocks.length > 1 ? "s" : ""}</span><span class="right meta">how to fix →</span></p>`,
  ), "\n");

  // ---- the last 24 hours: runs STARTED in the window, outcomes exhaustive ----
  const groups: [string, number][] = [
    ["built", data.runs24.filter(one => one.outcome === "built").length],
    ["no change", data.runs24.filter(one => one.outcome === "no-change").length],
    ["failed", data.runs24.filter(one => one.outcome === "failed").length],
    ["refused", data.runs24.filter(one => one.outcome === "refused").length],
    ["parked", data.runs24.filter(one => one.outcome === "parked").length],
    ["interrupted", data.runs24.filter(one => one.outcome === "interrupted").length],
    ["unfinished", data.runs24.filter(one => one.outcome === null).length],
  ];
  const outcomeWords = groups.filter(([, count]) => count > 0).map(([word, count]) => `${count} ${word}`).join(" · ");
  const summary = tally(data.runs24);

  // ---- running: current live claims, project chips on ----
  const liveRows = joinHtml(data.live.map(
    one =>
      html`<p class="row"><a href="${taskHref(one.taskId)}">${one.taskId}</a>${projectChip(one.repo)} <span class="badge badge-running">Running</span> <span class="mono meta">${one.runner}${one.model === null ? null : html` · ${one.model}`} · <time data-elapsed-since="${one.claimedAt}"></time></span></p>`,
  ), "\n");

  // ---- the ledger: terminal runs started in the window, one chip each ----
  const chipClass = (outcome: string): string =>
    outcome === "built" || outcome === "no-change" ? "badge-done" : outcome === "failed" ? "badge-failed" : "";
  const prLink = (one: (typeof data.ledger)[number]): Html | null => {
    if (one.prNumber === null) return null;
    // The URL-sink rule (audit IV-11): only a verified github pull
    // URL earns an anchor; a corrupted row renders as text.
    const safe = safePrUrl(one.prUrl);
    return safe === null ? html` · PR #${one.prNumber}` : html` · <a href="${safe}">PR #${one.prNumber}</a>`;
  };
  const ledgerRows = joinHtml(data.ledger.map(
    one =>
      html`<p class="row"><a href="/r/${one.runId}">${one.title}</a>${projectChip(one.repo)} <span class="badge ${chipClass(one.outcome)}">${sentenceCase(one.outcome)}</span> ${one.role === "scout" ? html`<a class="badge" href="${taskHref(one.taskId)}#report">Report</a> ` : null}<span class="mono meta">${one.provider === null ? "" : one.provider}${one.model === null ? null : html` · ${one.model}`}${one.ranMinutes === null ? null : html` · ${one.ranMinutes}m`} · ${runCostWords({ authMode: one.authMode, costUsd: one.costUsd, tokensIn: null, tokensOut: null })}${prLink(one)}</span></p>`,
  ), "\n");

  return joinHtml([
    html`<div class="control-room-head"><div><h1>Portfolio</h1><p class="meta">Every project and live build in one place</p></div><div class="actions"><a class="badge" href="/tasks/new">+ New task</a><a class="badge" href="/board?scope=all">Full board →</a></div></div>`,
    data.saturated ? html`<div class="problem">This overview reached its 200-task display cap; the task list holds the rest.</div>` : null,
    html`<h2>Waits on you</h2>`,
    waitCount === 0
      ? html`<div class="answered"><strong>Nothing needs you.</strong> <span class="meta">You can leave this open; live state updates in the rail.</span></div>`
      : joinHtml([
          data.decisions.length === 0 ? null : decisionCards,
          data.approvals.length === 0 ? null : approvalCards,
          data.requeueables.length === 0 ? null : requeueRows,
          data.cancelledBlockers.length === 0 ? null : cancelledRows,
          data.gaps.length === 0 ? null : gapRows,
          html`<p class="meta"><a href="/next">clear the queue → one thing at a time</a></p>`,
        ].filter((part): part is Html => part !== null), "\n"),
    data.gapsProject === null
      ? html`<p class="meta">Requirement gaps are checked one project at a time — open a project to see and fill its gaps · <a href="/projects">open a project</a></p>`
      : null,
    html`<h2>Project pulse</h2>`,
    html`<p class="hint">one row per repository</p>`,
    pulseRows.length === 0
      ? html`<div class="card"><p><strong>No active work yet.</strong></p><p class="meta">Queue a task and its progress will show here across every workspace.</p></div>`
      : html`<div class="workspace-pulse">${workspaceRows}</div>`,
    html`<h2>The last 24 hours</h2>`,
    html`<p class="hint">runs started in the last 24 hours</p>`,
    data.runs24.length === 0
      ? html`<p class="meta">No runs started in the window</p>`
      : html`<p class="row"><span class="meta">runs started</span> <span class="mono">${data.runs24.length}</span></p><p class="row"><span class="meta">outcomes</span> <span class="mono">${outcomeWords}</span></p><p class="row"><span class="meta">spend</span> <span class="mono">${spendLine(summary)}</span></p>${
          // Tokens stand on their own: invocations that reported usage —
          // independent of whether cost was measured (spec §2; spendLine's
          // mixed branch omits them).
          summary.tokens > 0
            ? html`<p class="row"><span class="meta">tokens</span> <span class="mono">${summary.tokens.toLocaleString()}</span></p>`
            : null
        }`,
    html`<h2>Running</h2>`,
    data.live.length === 0 ? html`<p class="meta">No agent is working right now</p>` : liveRows,
    html`<h2>Terminal runs started in the last 24 hours</h2>`,
    data.ledger.length === 0 ? html`<p class="meta">None yet</p>` : ledgerRows,
  ], "\n");
}

export type OnboardCardState =
  | { enabled: false; why: string }
  | { enabled: true; roots: readonly string[]; record: [string, { nameWithOwner: string; rootIndex: number; target: string; diskUsageKib: number | null; large: boolean; mintedAt: number }] | null };

export type ProjectPeek = { waiting: number; queued: number; running: number; doneRecently: number };

/**
 * owner/name from a git remote URL — FULLY ANCHORED https/ssh github.com
 * forms only (ghlist review, finding 2): a foreign host carrying
 * "github.com" in its path, or a non-github host, must never read as a
 * GitHub identity. Everything else is null.
 */
export function githubIdentityOf(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const https = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https !== null) return `${https[1]}/${https[2]}`;
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (ssh !== null) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

/**
 * The `origin` remote's url from a repository's OWN .git/config. BOUNDED
 * I/O by construction (ghlist review, finding 1): the final component may
 * not be a symlink (O_NOFOLLOW + lstat), must be a REGULAR file under a
 * size cap, and at most 64 KiB are ever read — a sparse monster or a fifo
 * planted as a "config" reads as null, never as a hang. Parsed LINE BY
 * LINE with real section tracking (finding 2): a `[remote "origin"]`
 * embedded inside some other value never opens the section. null when
 * unreadable or origin-less; a worktree-style `.git` FILE (gitdir pointer)
 * reads null too, which is honest — its identity lives elsewhere. The
 * answer is ADVISORY metadata for offering a button: the /projects/open
 * road re-proves path, ceiling, and git-ness before anything mutates, and
 * a config that lies about its origin can only mislabel a repository the
 * operator was already allowed to open.
 */
export function originUrlOf(repoPath: string): string | null {
  const file = join(repoPath, ".git", "config");
  let fd: number | null = null;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const config = buffer.toString("utf8", 0, read);
    let inOrigin = false;
    for (const line of config.split("\n")) {
      if (/^\s*\[/.test(line)) {
        inOrigin = /^\s*\[remote "origin"\]\s*$/.test(line);
        continue;
      }
      if (!inOrigin) continue;
      const url = /^\s*url\s*=\s*(.+)$/.exec(line)?.[1];
      if (url !== undefined) return url.trim();
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** The GitHub listing page: the account's repositories with ONE honest
 * action each. Names, descriptions, and paths are gh/filesystem DATA —
 * escaped at the sink like everything else. */
export function githubReposPage(
  chrome: Chrome,
  data: {
    listed: ListOutcome;
    local: Map<string, string>;
    registered: Set<string>;
    /** Unused: postForm adds the request's CSRF field. Kept for callers. */
    csrf: string;
    cloneReady: boolean;
    openProject: string | null;
  },
): Screen {
  const openForm = (path: string, label: string): Html =>
    postForm("/projects/open", html`<button type="submit">${label}</button>`, { attrs: { class: "inline" }, hidden: { path } });
  const cloneForm = (nameWithOwner: string): Html =>
    postForm("/projects/onboard-preview", html`<button type="submit">Clone here →</button>`, { attrs: { class: "inline" }, hidden: { repo: nameWithOwner, root: "0" } });
  const rows =
    !data.listed.ok
      ? html`<p class="meta">${data.listed.message}</p>`
      : data.listed.repos.length === 0
        ? html`<p class="meta">The signed-in GitHub account has no repositories to list</p>`
        : joinHtml(data.listed.repos.map(repo => {
            const localPath = data.local.get(repo.nameWithOwner.toLowerCase()) ?? null;
            const action =
              localPath !== null && data.openProject === localPath
                ? html`<span class="badge badge-done">Open now</span>`
                : localPath !== null
                  ? openForm(localPath, data.registered.has(localPath) ? "open →" : "add + open →")
                  : data.cloneReady
                    ? cloneForm(repo.nameWithOwner)
                    : html`<span class="meta">choose a projects folder first</span>`;
            return joinHtml([
              html`<div class="card project-card">`,
              html`<div class="row"><strong>${repo.nameWithOwner}</strong>${repo.isPrivate ? html` <span class="badge">Private</span>` : null}`,
              html`<span class="right">${action}</span></div>`,
              localPath === null
                ? html`<p class="meta">Not on this machine yet${/^\d{4}-\d{2}-\d{2}T/.test(repo.updatedAt) ? html` · pushed ${whenTime(repo.updatedAt)}` : null}</p>`
                : html`<p class="meta mono" style="overflow-wrap:anywhere;margin:.2rem 0">${localPath}</p>`,
              repo.description === "" ? null : html`<p class="meta">${repo.description}</p>`,
              html`</div>`,
            ], "\n");
          }), "\n");
  return screen("projects", joinHtml([
    html`<h1>Your GitHub repositories</h1>`,
    html`<p class="meta">Repositories available to the GitHub account signed in on this machine — open one you already have, or clone a new one after a quick preview.</p>`,
    rows,
    html`<p class="row" style="margin-top:.6rem"><a class="badge" href="/projects">← back to projects</a></p>`,
  ], "\n"), { chrome });
}

export function projectsPage(
  chrome: Chrome,
  recent: { path: string; name: string; lastOpenedAt: string }[],
  candidates: string[],
  open: string | null,
  problem: string | null,
  _unscopedMode: boolean,
  browsable = false,
  onboard: OnboardCardState | null = null,
  peeks: Record<string, ProjectPeek | null> = {},
  returnTo = "/",
  pullRequestsOn?: (path: string) => boolean,
  checkLevelOf?: (path: string) => CheckLevel,
): Screen {
  // The onboarding card (repo onboarding, findings 1-39): preview first,
  // then a password-confirmed clone into a configured root. Disabled
  // states explain themselves in words (finding 28/39).
  const onboardCard =
    onboard === null
      ? null
      : !onboard.enabled
        ? html`<p class="meta">${onboard.why}</p>`
        : joinHtml([
            html`<details class="project-add-more"${onboard.record === null ? null : html` open`}><summary>${onboard.record === null ? 'Paste a GitHub link' : 'Review repository'}</summary>`,
            html`<p class="meta">Paste a GitHub repository — you will preview it before anything is downloaded. It goes into your saved projects folder and the builder connects automatically. Large-file (LFS) objects are not downloaded.</p>`,
            onboard.record === null
              ? postForm("/projects/onboard-preview", joinHtml([
                  html`<label>Repository <input type="text" name="repo" placeholder="owner/name or https://github.com/owner/name"></label>`,
                  onboard.roots.length > 1
                    ? html`<label>Into <select name="root">${onboard.roots.map((one, index) => html`<option value="${index}">${one}</option>`)}</select></label>`
                    : html`<input type="hidden" name="root" value="0"><p class="meta">Into ${onboard.roots[0] ?? ""}</p>`,
                  html`<button type="submit">Preview</button>`,
                ], "\n"), { attrs: { class: "card" } })
              : joinHtml([
                  html`<div class="card">`,
                  html`<p><strong>${onboard.record[1].nameWithOwner}</strong> <span class="meta">${
                    onboard.record[1].diskUsageKib === null ? "size unknown" : `${Math.max(1, Math.round(onboard.record[1].diskUsageKib / 1024))} MiB`
                  } — will land at ${onboard.record[1].target}</span></p>`,
                  postForm("/projects/onboard-confirm", joinHtml([
                    onboard.record[1].large
                      ? html`<label class="row"><input type="checkbox" name="big-ok" value="1"> this is a large repository (or its size is unknown) — clone it anyway</label>`
                      : null,
                    html`<label>Your password, typed again <input type="password" name="token" autocomplete="current-password"></label>`,
                    html`<div class="sticky-actions"><button type="submit">Clone and open</button></div>`,
                  ], "\n"), { hidden: { nonce: onboard.record[0] } }),
                  html`</div>`,
                ], "\n"),
            html`</details>`,
          ], "\n");
  // Opening a project is a POST (the session's scope changes); a card's
  // name and counts are the same form, returning to the screen that count
  // names — so every number on this page is a road, not a fact to admire.
  const openForm = (path: string, label: string, destination = returnTo, className?: string): Html =>
    postForm(
      "/projects/open",
      html`<button type="submit"${className === undefined ? null : html` class="${className}"`}${className === "button-link" ? html` style="min-height:44px"` : null}>${label}</button>`,
      { attrs: { class: "inline" }, returnTo: destination, hidden: { path } },
    );

  // A project switcher CARD (v30 UI): the name and path, an at-a-glance
  // peek — what waits on a person, what is queued or running, what built
  // in the last day — and the open action. A vertical stack that reads on
  // a phone, not a dense row.
  const peekChips = (path: string, peek: ProjectPeek | null): Html => {
    if (peek === null) return html`<span class="meta">not scanned</span>`;
    const isOpen = open !== null && open === path;
    const chip = (text: string, href: string, cls: string): Html =>
      isOpen ? html`<a class="badge ${cls}" href="${href}">${text}</a>` : openForm(path, text, href, `badge ${cls}`);
    const bits: Html[] = [];
    if (peek.waiting > 0) bits.push(chip(`${peek.waiting} waiting on you`, "/", "badge-open"));
    if (peek.running > 0) bits.push(chip(`${peek.running} running`, "/runs", "badge-parked"));
    if (peek.queued > 0) bits.push(chip(`${peek.queued} queued`, "/board?view=order", "badge-queued"));
    if (peek.doneRecently > 0) bits.push(chip(`${peek.doneRecently} built today`, "/done", "badge-parked"));
    return bits.length === 0 ? html`<span class="meta">quiet — nothing queued or waiting</span>` : joinHtml(bits, " ");
  };
  const projectCard = (one: { path: string; name: string; note: string; peek: ProjectPeek | null }): Html =>
    joinHtml([
      html`<div class="card project-card">`,
      html`<div class="row">${
        open !== null && open === one.path
          ? html`<a class="project-name" href="${returnTo}"><strong>${one.name}</strong></a>`
          : openForm(one.path, one.name, returnTo, "project-name")
      }`,
      html`<span class="right">${
        open !== null && open === one.path ? html`<span class="badge badge-done">Open now</span>` : openForm(one.path, "Open", returnTo, "button-link")
      }</span></div>`,
      html`<p class="meta mono" style="overflow-wrap:anywhere;margin:.2rem 0">${one.path}</p>`,
      html`<p class="row" style="gap:.35rem;flex-wrap:wrap">${peekChips(one.path, one.peek)}</p>`,
      html`<p class="meta row" style="justify-content:space-between;margin-bottom:0"><span>${one.note}</span><a href="/settings/knowledge?repo=${encodeURIComponent(one.path)}" style="display:inline-flex;align-items:center;min-height:44px">Knowledge</a></p>`,
      html`</div>`,
    ], "\n");
  const cards = (items: { path: string; name: string; note: string }[]): Html =>
    joinHtml(items.map(one => projectCard({ ...one, peek: peeks[one.path] ?? null })), "\n");

  const recentItems = recent.map(one => ({ path: one.path, name: one.name, note: `last opened ${when(one.lastOpenedAt)}` }));
  const candidateItems = candidates.map(path => ({ path, name: projectName(path), note: "seen in the queue" }));
  // The rebuilt page's rows (shadcn/ui): the same projects, peeks and roads.
  const home = homedir();
  const rowOf = (path: string, name: string, openedAt: string | null): BrowserProjectRow => {
    const peek = peeks[path] ?? null;
    return {
      name, path, shortPath: path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path, open: open !== null && open === path, openedAt,
      knowledgeHref: `/settings/knowledge?repo=${encodeURIComponent(path)}`,
      ...(pullRequestsOn === undefined ? {} : { pullRequests: { href: `/settings/pull-requests?repo=${encodeURIComponent(path)}`, on: pullRequestsOn(path) } }),
      ...(checkLevelOf === undefined ? {} : { checks: { href: `/settings/checks?repo=${encodeURIComponent(path)}`, level: CHECK_LEVEL_WORDS[checkLevelOf(path)] } }),
      peek: peek === null ? null : [
        ...(peek.waiting > 0 ? [{ label: `${peek.waiting} waiting on you`, href: "/", tone: "attention" as const }] : []),
        ...(peek.running > 0 ? [{ label: `${peek.running} running`, href: "/runs", tone: "neutral" as const }] : []),
        ...(peek.queued > 0 ? [{ label: `${peek.queued} queued`, href: "/board?view=order", tone: "neutral" as const }] : []),
        ...(peek.doneRecently > 0 ? [{ label: `${peek.doneRecently} built today`, href: "/done", tone: "neutral" as const }] : []),
      ],
    };
  };

  // The two ways to ADD a project are the page's large, primary actions:
  // browse this machine, or choose a GitHub repository. Manual path entry
  // stays available as the clearly secondary expert road.
  const addAction = (href: string, paths: Html, title: string, detail: string): Html =>
    html`<a class="project-add-action" href="${href}"><span class="project-add-icon">${strokeIcon(paths)}</span><span class="project-add-copy"><strong>${title}</strong><small>${detail}</small></span><span class="project-add-arrow" aria-hidden="true">→</span></a>`;
  const addForms = joinHtml([
    browsable || onboard !== null && !onboard.enabled && onboard.why.includes('--project-root')
      ? null
      : html`<p class="meta">Choose a projects folder once with <code>toolroll up --project-root &lt;dir&gt;</code>. Toolroll remembers it after that.</p>`,
    onboardCard === null ? null : html`<div style="margin-top:.5rem">${onboardCard}</div>`,
    html`<details class="project-add-more"><summary>Enter an exact path instead</summary>`,
    html`${postForm("/projects/open", joinHtml([
      html`<label>Path on this server<input type="text" name="path" placeholder="/Users/you/code/your-repo"></label>`,
      html`<button type="submit">Open project</button>`,
    ], "\n"), { attrs: { class: "card" }, returnTo })}</details>`,
  ], "\n");
  const addCard = joinHtml([
    html`<div class="card project-add-card">`,
    html`<h2 class="project-add-title">Add a project</h2>`,
    html`<div class="project-add-actions">`,
    browsable
      ? addAction("/projects/browse", FOLDER_PATHS, "Choose a local folder", "Browse the project folders on this machine")
      : null,
    onboard === null
      ? null
      : addAction(
          "/projects/github",
          html`<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><path d="M18 9a9 9 0 0 1-9 9"/>`,
          "Add from GitHub",
          "Choose from repositories available to your GitHub login",
        ),
    html`</div>`,
    addForms,
    html`</div>`,
  ], "\n");

  // Arriving from New task with no project open: say what this step is for.
  const choosing = returnTo.startsWith("/tasks/new");
  return screen("projects", joinHtml([
    choosing ? html`<h1>New task</h1><p class="meta">Choose the project it belongs to.</p>` : html`<h1>Projects</h1>`,
    choosing ? null : html`<p class="meta">Add a folder or GitHub repository once. Its tasks and chat stay here.</p>`,
    problem === null ? null : html`<div class="problem">${problem}</div>`,
    recentItems.length === 0 && candidateItems.length === 0
      ? html`<div class="card"><p><strong>Nothing to open yet.</strong></p><p class="meta">Add one below — opening it registers it here for next time.</p></div>`
      : null,
    recentItems.length > 0 ? html`<h2>Recent</h2>${cards(recentItems)}` : null,
    candidateItems.length > 0 ? html`<h2>Available</h2>${cards(candidateItems)}` : null,
    addCard,
  ], "\n"), { chrome, workspace: { view: {
    kind: "projects", choosing, problem, returnTo,
    recent: recent.map(one => rowOf(one.path, one.name, one.lastOpenedAt)),
    available: candidates.map(path => rowOf(path, projectName(path), null)),
    add: { browse: browsable ? "/projects/browse" : null, github: onboard === null ? null : "/projects/github", html: htmlString(addForms) },
  } satisfies BrowserProjectsView } });
}

/** The no-script "move to the front" sentinel: the form cannot name the
 * front of a partition, so the handler resolves it (slice 1b, fix 1). */
export const QUEUE_FRONT = "__TOP__";

export type QueueCardTask = ReturnType<Store["queueScoped"]>[number] & { dispatch?: DispatchDiagnosis | null };

export function queueCard(one: QueueCardTask, revision: number, queueRevision: number, workers: { name: string; retired: boolean }[], column: string): Html {
  // Presentation over queueScoped()'s shape only: state, scope, blockers,
  // and the reservation owner. Money is not in this query and is not
  // invented here — it stays on the task page, labeled.
  const state = one.taken
    ? html`<span class="badge">Being taken — keeps its claim</span>`
    : column === "anyone"
      ? html`<span class="badge">Queued</span>`
      : html`<span class="badge">Reserved for ${column}</span>`;
  const chips =
    html` ${state}${one.dispatch === null || one.dispatch === undefined ? null : html` <a class="badge" href="${taskHref(one.id)}" title="${one.dispatch.summary}">${dispatchHeadline(one.dispatch)}</a>`}`;
  const options = { attrs: { class: "inline" }, projectRevision: revision };
  const controls = one.taken
    ? null
    : html`${postForm("/queue/move", html`<button type="submit" class="icon-button" aria-label="move to the front">${TO_FRONT_ICON}</button>`, { ...options, hidden: { queueRevision, task: one.id, column, before: QUEUE_FRONT } })}${postForm(
        "/queue/move",
        html`<select name="column" aria-label="reserve for"><option value="anyone"${column === "anyone" ? html` selected` : null}>anyone</option>${workers.filter(worker => !worker.retired).map(worker => html`<option value="${worker.name}"${column === worker.name ? html` selected` : null}>${worker.name}</option>`)}</select><button type="submit">Move</button>`,
        { ...options, hidden: { queueRevision, task: one.id } },
      )}`;
  return html`<div class="card queue-card" data-task="${one.id}" data-taken="${one.taken ? "1" : "0"}"${one.dispatch === null || one.dispatch === undefined ? null : html` data-dispatch-status="${one.dispatch.code}"`}><p class="row">${one.taken ? null : GRIP_HANDLE}<a href="${taskHref(one.id)}">${one.title}</a>${chips}</p><p class="row meta"><span class="mono">${one.id}</span> ${controls}</p></div>`;
}

/** The queue columns fragment — shared queue first, then each worker. */
export function queueBody(
  tasks: QueueCardTask[],
  workers: { name: string; retired: boolean; note: string | null; capacity: number; building: number }[],
  revision: number,
  queueRevision: number,
): Html {
  const columnOf = (runner: string | null) => tasks.filter(one => one.assignedRunner === runner);
  const projectChips = (rows: typeof tasks): Html => {
    const repos = [...new Set(rows.map(one => one.repo).filter((one): one is string => one !== null))];
    return joinHtml(repos.map(repo => html`<span class="badge">${repo.split("/").pop() ?? repo}</span>`), " ");
  };
  const shared = columnOf(null);
  const allWorkersBusy = workers.filter(one => !one.retired).length > 0 && workers.filter(one => !one.retired).every(one => columnOf(one.name).length > 0);
  const column = (title: string, key: string, head: Html, rows: typeof tasks, empty: string): Html =>
    html`<section class="lane queue-column" data-column="${key}"><h2>${title}</h2>${head}<p class="meta">${projectChips(rows)}</p>${
      rows.length === 0
        ? html`<p class="meta lane-empty">${empty}</p>`
        : joinHtml(rows.map((one, index) =>
            index === 0 && key === "anyone" && allWorkersBusy && !one.taken
              ? replaceMarkup(
                  replaceMarkup(queueCard(one, revision, queueRevision, workers, key), /<\/p>\n/, () => html`</p>`),
                  /<p class="row meta">/,
                  () => html`<p class="meta">Every worker has reserved work — this waits until a column empties</p><p class="row meta">`,
                )
              : queueCard(one, revision, queueRevision, workers, key),
          ), "\n")
    }</section>`;
  const noteForm = (worker: { name: string; retired: boolean; note: string | null; capacity: number; building: number }): Html =>
    worker.retired
      ? html`<p class="meta">This worker is retired — drag these elsewhere, or register the name again</p>`
      : html`<p class="meta mono">${worker.building} building in this project · unattended capacity ${worker.capacity}</p>${postForm(
          "/queue/note",
          html`<input type="text" name="note" value="${worker.note ?? ""}" data-initial="${worker.note ?? ""}" placeholder="what this worker is working through" aria-label="column note" maxlength="200"><button type="submit">Save</button>`,
          { attrs: { class: "row" }, projectRevision: revision, hidden: { runner: worker.name } },
        )}<p class="meta">Takes from the shared queue when this column is empty</p>`;
  return html`<div class="lanes" data-queue-revision="${queueRevision}">${column("shared queue", "anyone", html`<p class="meta">Workers take from here when their column is empty — top card first</p>`, shared, "nothing waiting — every task is reserved or running")}${joinHtml(
    workers.map(worker => column(worker.name + (worker.retired ? " (retired)" : ""), worker.name, noteForm(worker), columnOf(worker.name), "nothing queued — this worker will take from the shared queue")),
    "\n",
  )}</div>`;
}

/**
 * The fleet screen — one lane per runner, and the work in front of it.
 * Building claims pin to the top of their worker's lane (live — never
 * draggable); queued reservations sit below it (draggable to another
 * worker, re-reserving them). Every card wears its project chip, which is
 * the whole point: which agent is on which project is the page's answer.
 * Form-free like the board, except the per-worker note, so the lane stack
 * can re-render itself while somebody watches.
 */
export function fleetBody(
  queued: ReturnType<Store["fleetQueue"]>,
  building: ReturnType<Store["liveClaims"]>,
  runners: Runner[],
  queueRevision: number,
  visibleRepo: (repo: string | null) => boolean,
): Html {
  const chip = (repo: string | null): Html | null =>
    repo === null ? null : html` <span class="badge">${projectName(repo)}</span>`;
  const queuedCardOf = (one: ReturnType<Store["fleetQueue"]>[number]): Html =>
    html`<div class="lane-card queue-card" data-task="${one.id}" data-taken="${one.taken ? "1" : "0"}"><p class="row">${one.taken ? null : GRIP_HANDLE}<a href="${taskHref(one.id)}">${one.title}</a></p><p class="row meta"><span class="mono">${one.id}</span>${chip(one.repo)}${one.approved ? null : html` <span class="badge">Unapproved scope</span>`}${one.blockers > 0 ? html` <span class="badge">Waits for ${one.blockers}</span>` : null}${one.taken ? html` <span class="badge">Being taken</span>` : null}</p></div>`;
  const lanes = runners.map(runner => {
    const own = queued.filter(one => one.assignedRunner === runner.name && visibleRepo(one.repo));
    const live = building.filter(one => one.runner === runner.name);
    const retired = runner.retiredAt !== null;
    const head =
      retired
        ? html`<p class="meta">This worker is retired — drag these elsewhere, or register the name again</p>`
        : html`${postForm(
            "/queue/note",
            html`<input type="text" name="note" class="runner-note" value="${runner.queueNote ?? ""}" data-initial="${runner.queueNote ?? ""}" placeholder="what this worker is working through" aria-label="column note" maxlength="200">`,
            { attrs: { class: "row" }, hidden: { from: "fleet", runner: runner.name } },
          )}<p class="meta">${runnerAlive(runner, new Date()) ? "alive" : "quiet"} · ${live.length}/${runner.capacity} building</p>`;
    const buildingCards = joinHtml(live.map(
      claim =>
        html`<div class="lane-card" data-taken="1"><p class="row"><span class="dot dot-ok pulse"></span> ${claim.taskId}</p><p class="row meta">building${chip(claim.repo ?? null)}${claim.model === null ? null : html` · ${claim.model}`} · ${Math.max(1, Math.round((Date.now() - new Date(claim.claimedAt).getTime()) / 60_000))}m</p></div>`,
    ), "\n");
    const queuedCards = joinHtml(own.map(queuedCardOf), "\n");
    const empty =
      live.length === 0 && own.length === 0
        ? html`<p class="meta lane-empty">${retired ? "nothing left" : "idle — will take from the shared queue"}</p>`
        : null;
    return html`<section class="lane queue-column${live.length > 0 ? " lane-live" : ""}" data-column="${runner.name}"><h2>${runner.name}${retired ? " (retired)" : ""}</h2>${head}${buildingCards}${queuedCards}${empty}</section>`;
  });
  // The shared queue: anything reserved for nobody.
  const shared = queued.filter(one => one.assignedRunner === null && visibleRepo(one.repo));
  const sharedCards = joinHtml(shared.map(queuedCardOf), "\n");
  const sharedLane =
    html`<section class="lane queue-column" data-column="anyone"><h2>Shared queue</h2><p class="meta">Any free worker takes from here, top first</p>${sharedCards}${shared.length === 0 ? html`<p class="meta lane-empty">nothing waiting — every task is reserved or running</p>` : null}</section>`;
  return html`<div class="lanes" data-queue-revision="${queueRevision}">${sharedLane}${joinHtml(lanes, "\n")}</div>`;
}

/** Identical drag mechanics to the queue — the pointer events land on the worker's column. */
export function fleetScript(): string {
  return (
    `(function(){var region=document.getElementById("fleet-region");if(!region)return;` +
    `var stamp=document.getElementById("fleet-region-stamp");var dragging=null;` +
    `function dirty(){if(region.contains(document.activeElement)&&document.activeElement!==document.body)return true;` +
    `var inputs=region.querySelectorAll("input[type=text]");for(var i=0;i<inputs.length;i++){` +
    `if(inputs[i].value!==(inputs[i].getAttribute("data-initial")||""))return true;}` +
    `return false;}` +
    `function paused(){return dragging!==null||dirty();}` +
    `var wait=12000;var last=Date.now();var busy=false;` +
    `function tell(){if(!stamp)return;if(paused()){stamp.textContent="paused while you edit";return;}` +
    `stamp.textContent="updated "+Math.round((Date.now()-last)/1000)+"s ago";}setInterval(tell,1000);` +
    `function cycle(){if(document.hidden||busy||paused()){setTimeout(cycle,wait);return;}busy=true;` +
    `fetch("/fleet?fragment=1",{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return null;}` +
    `return r.ok?r.text():null;})` +
    `.then(function(t){if(t&&!paused()){region.innerHTML=t;last=Date.now();}})` +
    `.catch(function(){})` +
    `.then(function(){busy=false;tell();setTimeout(cycle,wait);});}setTimeout(cycle,wait);` +
    `region.addEventListener("pointerdown",function(e){var handle=e.target.closest(".queue-handle");if(!handle)return;` +
    `var card=handle.closest(".queue-card");if(!card||card.getAttribute("data-taken")==="1")return;` +
    `e.preventDefault();dragging={task:card.getAttribute("data-task"),card:card};card.style.opacity="0.5";});` +
    `region.addEventListener("pointermove",function(e){if(!dragging)return;e.preventDefault();` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over)return;` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");` +
    `region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `if(target&&target!==dragging.card){target.style.outline="2px solid currentColor";}` +
    `else if(lane){lane.style.outline="2px dashed currentColor";}});` +
    `region.addEventListener("pointerup",function(e){if(!dragging)return;var drag=dragging;dragging=null;` +
    `drag.card.style.opacity="";region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over){tell();return;}` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");if(!lane){tell();return;}` +
    `var column=lane.getAttribute("data-column");var before=target&&target!==drag.card?target.getAttribute("data-task"):"";` +
    `if(target&&target.getAttribute("data-taken")==="1"){before="";}` +
    `var wrap=region.querySelector("[data-queue-revision]");` +
    `var fields={respond:"fragment",csrf:(region.querySelector("input[name=csrf]")||{value:""}).value,` +
    `queueRevision:wrap?wrap.getAttribute("data-queue-revision"):"",task:drag.task,column:column,before:before};` +
    `var post=new URLSearchParams();Object.keys(fields).forEach(function(k){post.append(k,fields[k]);});` +
    `fetch("/queue/move",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:post.toString(),redirect:"manual"})` +
    `.then(function(r){return r.ok?fetch("/fleet?fragment=1",{cache:"no-store"}).then(function(f){return f.ok?f.text():null;}):null;})` +
    `.then(function(t){if(t&&!paused()){region.innerHTML=t;last=Date.now();}else if(t===null){location.href="/fleet";}})` +
    `.catch(function(){})` +
    `.then(function(){tell();});});` +
    `})();`
  );
}

/** The /queue page's one nonce'd script: delegated pointer-event drag (it
 * survives every fragment swap — finding 17) plus a poller that re-checks
 * focus, dirty inputs, and an in-flight drag AT SWAP TIME, never only
 * before the fetch. Select dirtiness compares against data-initial
 * (finding 18); missing that, a select counts clean.
 */
export function queueScript(): string {
  return (
    `(function(){var region=document.getElementById("queue-region");if(!region)return;` +
    `var stamp=document.getElementById("queue-region-stamp");var dragging=null;var ghost=null;` +
    `function dirty(){if(region.contains(document.activeElement)&&document.activeElement!==document.body)return true;` +
    `var inputs=region.querySelectorAll("input[type=text]");for(var i=0;i<inputs.length;i++){` +
    `if(inputs[i].value!==(inputs[i].getAttribute("data-initial")||""))return true;}` +
    `var selects=region.querySelectorAll("select");for(var j=0;j<selects.length;j++){` +
    `var base=selects[j].getAttribute("data-initial");if(base!==null&&selects[j].value!==base)return true;}` +
    `return false;}` +
    `function paused(){return dragging!==null||dirty();}` +
    // the poller: pause is re-checked at SWAP time
    `var wait=15000;var last=Date.now();var busy=false;` +
    `function tell(){if(!stamp)return;if(paused()){stamp.textContent="paused while you edit";return;}` +
    `stamp.textContent="updated "+Math.round((Date.now()-last)/1000)+"s ago";}setInterval(tell,1000);` +
    `function cycle(){if(document.hidden||busy||paused()){setTimeout(cycle,wait);return;}busy=true;` +
    `fetch("/queue?fragment=1",{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return null;}` +
    `return r.ok?r.text():null;})` +
    `.then(function(t){if(t&&!paused()){region.innerHTML=t;last=Date.now();}})` +
    `.catch(function(){})` +
    `.then(function(){busy=false;tell();setTimeout(cycle,wait);});}setTimeout(cycle,wait);` +
    // the drag: delegated from the stable region element
    `region.addEventListener("pointerdown",function(e){var handle=e.target.closest(".queue-handle");if(!handle)return;` +
    `var card=handle.closest(".queue-card");if(!card||card.getAttribute("data-taken")==="1")return;` +
    `e.preventDefault();dragging={task:card.getAttribute("data-task"),card:card};card.style.opacity="0.5";});` +
    `region.addEventListener("pointermove",function(e){if(!dragging)return;e.preventDefault();` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over)return;` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");` +
    `region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `if(target&&target!==dragging.card){target.style.outline="2px solid currentColor";}` +
    `else if(lane){lane.style.outline="2px dashed currentColor";}});` +
    `region.addEventListener("pointerup",function(e){if(!dragging)return;var drag=dragging;dragging=null;` +
    `drag.card.style.opacity="";region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over){tell();return;}` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");if(!lane){tell();return;}` +
    `var column=lane.getAttribute("data-column");var before=target&&target!==drag.card?target.getAttribute("data-task"):"";` +
    `if(target&&target.getAttribute("data-taken")==="1"){before="";}` +
    `var wrap=region.querySelector("[data-queue-revision]");` +
    `var fields={respond:"fragment",csrf:(region.querySelector("input[name=csrf]")||{value:""}).value,projectRevision:(region.querySelector("input[name=projectRevision]")||{value:""}).value,` +
    `queueRevision:wrap?wrap.getAttribute("data-queue-revision"):"",task:drag.task,column:column,before:before};` +
    `var post=new URLSearchParams();Object.keys(fields).forEach(function(k){if(fields[k]!==""||k==="respond")post.append(k,fields[k]);});` +
    // A refused move (slice 1b, fix 2): the handler's typed text/plain 409
    // lands on the card as a problem row — textContent, never markup. Only
    // an authenticated plain-text 409 is inlined; an HTML refusal (the
    // stale-project page), a login bounce, or anything unexpected navigates.
    `function problem(task,text){var card=region.querySelector('.queue-card[data-task="'+task.replace(/["\\\\]/g,"")+'"]');if(!card)return false;` +
    `var old=card.querySelector(".queue-problem");if(old)old.remove();` +
    `var row=document.createElement("p");row.className="problem queue-problem";row.setAttribute("role","alert");row.textContent=text;card.appendChild(row);return true;}` +
    `fetch("/queue/move",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:post.toString(),redirect:"manual"})` +
    `.then(function(r){if(r.ok)return fetch("/queue?fragment=1",{redirect:"manual",cache:"no-store"}).then(function(f){` +
    `if(f.type==="opaqueredirect"||f.status===401||f.status===403){location.href="/login";return false;}return f.ok?f.text():null;});` +
    `if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return false;}` +
    `var kind=(r.headers&&r.headers.get?r.headers.get("content-type"):"")||"";` +
    `if(r.status===409&&kind.indexOf("text/plain")===0){return r.text().then(function(text){return problem(drag.task,text)?false:null;});}` +
    `return null;})` +
    `.then(function(t){if(t===false)return;if(t&&!paused()){region.innerHTML=t;last=Date.now();}else if(t===null){location.href="/board?view=order";}})` +
    `.catch(function(){})` +
    `.then(function(){tell();});});` +
    `})();`
  );
}

export function newTaskPage(
  chrome: Chrome,
  project: string | null,
  projectRevision: number,
  problem: string | null,
  candidates: { id: string; title: string }[] = [],
  permissionDefault: UnattendedPermissionMode = "auto",
  qualityDefault: QualityMode = "default",
  projects: { path: string; name: string }[] = [],
): Screen {
  return screen("New task", joinHtml([
    html`<section class="task-intake">`,
    html`<div class="task-intake-hero"><h1>What should get done?</h1></div>`,
    html`<p class="meta">Work you do often? <a href="/recipes">Use a saved recipe</a> or <a href="/recipes/new">create one</a>.</p>`,
    problem === null ? null : html`<div class="problem">${problem}</div>`,
    taskComposerHtml({
      project,
      projectRevision,
      candidates,
      permissionDefault,
      qualityDefault,
      projects,
    }),
    html`<p class="meta task-agent-note">Nothing builds until you approve the plan. <a href="/chat">Or start in chat.</a></p>`,
    html`</section>`,
  ], "\n"), { chrome });
}

/**
 * The triage flow: everything waiting on a person, one card at a time.
 * Full context ON the card, the act inline, and every act lands back here
 * — clearing the queue is taps, not navigation. Read state travels in the
 * URL (the bounded skip cursor), never in the session: two tabs cannot
 * fight, and a shared link shows the same queue.
 */
export function nextPage(chrome: Chrome, data: {
  item:
    | { key: string; kind: "decision"; decision: Decision & { taskId: string } }
    | { key: string; kind: "approval"; approval: { taskId: string; title: string; goal: string; digest: string; proposedAt: string } }
    | { key: string; kind: "requeue"; stalled: { taskId: string; title: string; strikes: number; incidentCount: number } }
    | { key: string; kind: "gap"; gap: Gap }
    | null;
  scope: Scope | null;
  planDocument: string | null;
  planContract?: PlanContractView | null;
  approvalDigest: string | null;
  /** v34: said inside the ceremony when the yes buys a report, not a branch. */
  deliverable?: "branch" | "report";
  /** v48: the agents the yes freezes — the one block every ceremony shows. */
  route: RouteView | null;
  csrf: string;
  nonce: string;
  remaining: number;
  skipped: string[];
  now: Date;
}): Screen {
  const { item } = data;
  if (item === null) {
    const held = data.skipped.length;
    return screen("next", joinHtml([
      html`<h1>All clear</h1>`,
      held > 0
        ? html`<p>Nothing left except the ${held} you set aside. <a href="/next">Look at those again</a>, or come back later.</p>`
        : html`<p>Nothing needs you. The machine is either working or waiting on its own clocks.</p>`,
      html`<p class="meta"><a href="/board">the board</a> shows what is moving · <a href="/inbox">the inbox</a> lists everything at once</p>`,
    ], "\n"), { chrome });
  }

  const skipHref = `/next?skip=${encodeURIComponent([...data.skipped, item.key].join(","))}`;
  const header =
    html`<p class="meta next-pager"><span>${data.remaining === 1 ? "the last thing waiting on you" : `1 of ${data.remaining} waiting on you`}</span><a class="skip" href="${skipHref}">not now — next →</a></p>`;

  let card: Html;
  if (item.kind === "decision") {
    const { decision } = item;
    card =
      html`<h1>${decision.taskId} <span class="meta">asked ${whenTime(decision.createdAt)}</span></h1><div class="recap">${decision.recap}</div><div class="question">${decision.question}</div>${decisionOptionForms(decision, "next")}`;
  } else if (item.kind === "approval" && !consentDoorOf(data.scope, data.route).open) {
    const door = consentDoorOf(data.scope, data.route) as ConsentDoor & { open: false };
    card =
      html`<h1>${item.approval.taskId}</h1><p>${item.approval.title}</p>${consentClosedHtml(item.approval.taskId, door, "next")}<p class="meta"><a href="${taskHref(item.approval.taskId)}">open the full task</a></p>`;
  } else if (item.kind === "approval") {
    const scope = data.scope;
    card =
      html`<h1>${item.approval.taskId}</h1><p>${item.approval.title}</p>${
        data.planDocument === null
          ? null
          : html`<div class="card"><p><strong>The plan</strong> <span class="meta">drafted by a planning session</span></p>${executionPlanHtml(data.planDocument, true)}${planContractHtml(data.planContract ?? null, "ceremony")}</div>`
      }${postForm(
        `${taskHref(item.approval.taskId)}/approve`,
        html`<p><strong>Approve exactly this:</strong></p>${
          data.deliverable === "report" ? html`<p class="meta"><span class="badge">Scout</span> a read-only session investigates this goal and delivers a report — no branch, nothing changes in the repository</p>` : null
        }${scope === null || scope.profileState !== "unresolved" ? null : profileWords(scope)}<p class="meta">Goal</p><p class="recap" style="margin-top:0">${scope?.goal ?? item.approval.goal}</p><p class="meta">Not this</p><p class="recap" style="margin-top:0">${scope?.outOfScope == null ? html`<em>no exclusions</em>` : scope.outOfScope}</p><p class="meta">Touches · ${scope === null || scope.touches.length === 0 ? "anything" : joinHtml(scope.touches, ", ")}</p>${
          scope === null ? null : acceptanceCeremonyHtml(scope.acceptance)
        }${
          // The AGENTS the yes freezes (v48): the same concise block the task
          // page and chat sign under, before the password — runtime limits one
          // tap away, never in the way.
          agentsCeremonyHtml(data.route)
        }${scope === null ? null : runtimeDetailsHtml(scope)}<label>Your password, typed again — a signed-in session alone cannot agree to work<input type="password" name="token" autocomplete="current-password"></label><div class="sticky-actions"><button type="submit">Approve this scope</button></div>`,
        { attrs: { class: "card approve-form" }, returnTo: "next", hidden: { nonce: data.nonce, digest: data.approvalDigest ?? item.approval.digest } },
      )}<p class="meta"><a href="${taskHref(item.approval.taskId)}">open the full task</a> to edit the scope first</p>`;
  } else if (item.kind === "requeue") {
    card =
      html`<h1>${item.stalled.taskId}</h1><p>${item.stalled.title}</p><p class="meta">Stopped — ${item.stalled.incidentCount} incident(s)${item.stalled.strikes > 0 ? html` after ${item.stalled.strikes} attempt(s)` : null}</p>${postForm(
        `${taskHref(item.stalled.taskId)}/requeue`,
        html`<p class="meta">Requeue resolves the incidents, clears the failed attempts, and puts it back in line</p><button type="submit">Retry this work</button>`,
        { attrs: { class: "card" }, returnTo: "next" },
      )}<p class="meta"><a href="${taskHref(item.stalled.taskId)}">open the full task</a> to read the runs first</p>`;
  } else {
    const { gap } = item;
    card =
      html`<h1>Supply ${gap.key}</h1><p class="meta">${gap.state}</p><p>Filling this starts ${gap.unblocks.length} task(s): ${joinHtml(gap.unblocks.map(one => html`<span class="mono">${one}</span>`), ", ")}</p><div class="card"><p class="meta">Prove it filled from the terminal:</p><pre class="recap">${gap.verify}</pre></div>`;
  }

  return screen("next", joinHtml([header, card], "\n"), { chrome });
}

  export type PeekAdmission = {
    run: Run;
    /** The run's checkout, PROVEN non-null by the guards: a reviewer run
     * (v29, artifact-only) is refused before admission ever forms. */
    worktree: string;
    epoch: string;
    entries: ReturnType<typeof parseBaseTreeSnapshot>;
  };
