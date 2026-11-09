/** Everyday console pages: home, inbox, board, work, projects, fleet and the queue. */
import { archivedWords, tidyGroups, TIDY_DEFAULT_DAYS, type TidyItem } from "../tidy.js";
import { stepUpForm } from "../settings-kit.js";
import { type Html, html, type HtmlValue, joinHtml, postForm, replaceMarkup, reauth } from "../html.js";
import { type AssignmentSnapshot } from "../assignment.js";
import { type BoardCard } from "../board.js";
import { type BrowserLimits,type BrowserTasksView,browserWorkActionHref } from "../browser-workspace.js";
import { type DispatchDiagnosis } from "../dispatch.js";
import { type FirstRunStep } from "../first-run.js";
import { type Gap } from "../gaps.js";
import { limitsHtml } from "../limits-ui.js";
import { type Ask,ASK_LABEL,ASKS,START_BUILDER_COMMAND } from "../needs-you.js";
import { type parseBaseTreeSnapshot } from "../peek.js";
import { projectName } from "../project.js";
import { type CriterionMatrixRow } from "../proof.js";
import { type Runner,isAlive as runnerAlive } from "../runner.js";
import { agentModelName,modelName } from "../model-names.js";
import { type Decision,type Incident,type RepairChainRow,type Run,type Store,type Task,type TaskState,type WorktreeRow } from "../store.js";
import { runCostWords,spendLine,tally } from "../summary.js";
import { type WorkIndexGroup,type WorkIndexItem,type WorkIndexPage } from "../work-index.js";
import { HEADLINES, type Headline } from "../task-status.js";
import { chipOfHeadline, type ChipTone } from "../design/kit.js";
import { WORK_VIEWS,type WorkFacts,type WorkStatus,type WorkView } from "../workspace-ui.js";
import { tasksHref } from "./retired-routes.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildsViews,CHEVRON_ICON,type Chrome,consoleSpend,GRIP_HANDLE,isOverdue,projectChip,relativeAge,safePrUrl,screen,type Screen,sentenceCase,TO_FRONT_ICON,when,whenTime } from "./chrome.js";
import { reviewHref,taskHref } from "./http.js";
import { criterionMatrixSummary,incidentWords,PHASE_WORDS,phaseWords } from "./render-results.js";
import { decisionAnswerCard,decisionAnswerScript,dispatchHeadline,statusLineHtml,workDiagnosticsHtml } from "./render-tasks.js";

export const TASK_STATES: readonly TaskState[] = ["queued", "running", "done", "failed", "cancelled"];

/**
 * The inbox (v3): only things stalling progress without a person, one card
 * per underlying stall, each with its verb inline or one step away. No
 * auto-refresh — approval links lead to the step-up screen, and a page
 * that might hold typed input never re-renders itself.
 */


/** Start a builder: the one command, as text to select (/start-builder, where every "Connect a builder" leads, and
 * the Agents page). `project`: the open project's name, when the viewer may see it; `connected`: whether a builder
 * that may build there is checking in (null: say nothing); `managed`: whether this person can start one themselves
 * (registering a builder takes an instance operator), else who to ask. */
export function startBuilderHtml(data: { heading: "h1" | "h2"; project: string | null; connected: boolean | null; managed: boolean }): Html {
  const where = data.project === null ? null : html` to <strong>${data.project}</strong>`;
  const state = data.connected === null ? null
    : data.connected ? html`<p>A builder is connected${where}. Approved tasks there start on their own.</p>`
    : html`<p><strong>No builder is connected</strong>${where}. Tasks wait until one is.</p>`;
  const title = data.heading === "h1" ? html`<h1 id="builder-heading">Start a builder</h1>` : html`<h2 id="builder-heading">Start a builder</h2>`;
  return html`<section id="builder" aria-labelledby="builder-heading">${title}<div class="card">${state}<p>On the computer where ${data.project ?? "the project"} lives, open the project's folder in a terminal and run:</p><p><code class="start-builder-command" style="user-select:all">${START_BUILDER_COMMAND}</code></p>${
    data.managed
      ? html`<p class="meta">Keep it running. Approved tasks start on their own. The console alone (<code>toolroll serve</code>) doesn't build.</p>`
      : html`<p class="meta">Starting a builder takes someone who manages this Toolroll. Ask them to run it there; your tasks start on their own once it connects.</p>`
  }</div></section>`;
}

/**
 * A build's stage as one of three steps — set up, writing, checking and
 * committing — read from the machine's own phase, never a percent. The
 * steps only move forward: evidence and proof checks run both before and
 * after the commit (builder.ts), so everything after the agent's turn is
 * one step, and the stage words say which part. Null for runs that are not
 * builds (planning, review, investigation): those have no honest steps.
 */
export const BUILD_STEPS = ["setting up", "writing", "checking and committing"] as const;
export function buildStepOf(claim: NonNullable<BoardCard["claim"]>): number | null {
  if (claim.role === "planner" || claim.role === "reviewer" || claim.role === "scout") return null;
  if (claim.model === null) return 0;
  if (claim.phase === null || claim.phase === "agent-running") return 1;
  return 2;
}

/** A clock that ticks in the page (boardTickScript) from the server's own start time; the text is the no-script answer. */
function tickingClock(startedIso: string, now: Date): Html {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(startedIso).getTime()) / 60_000));
  return html`<time class="clock" datetime="${startedIso}" data-tick>${minutes}m</time>`;
}

/**
 * The workers a board's strip may show: not retired, bound to at least one
 * project the server's ceiling admits (never a runner serving only projects
 * this server must not speak about), and — on a one-project board — bound to
 * that project.
 */
export function boardWorkers(runners: readonly Runner[], scope: { all: boolean; project: string | null; visible: (repo: string) => boolean }): Runner[] {
  return runners.filter(runner =>
    runner.retiredAt === null &&
    runner.repos.some(repo => scope.visible(repo)) &&
    (scope.all || scope.project === null || runner.repos.includes(scope.project)));
}

/**
 * The worker strip across the top of the board: every worker this board's
 * work can go to, what it is building here, and its stage and clock. Only
 * builds the board already shows are named — a worker busy in a project
 * this reader cannot see reads "no build on this board", never "free".
 */
function workerStrip(runners: readonly Runner[], cards: readonly BoardCard[], now: Date): Html {
  if (runners.length === 0) return html`<p class="meta crew-empty">No builders yet — work waits in the queue until one joins.</p>`;
  const tiles = runners.map(runner => {
    const builds = cards
      .filter(card => card.lane === "building" && card.claim !== null && card.claim.runner === runner.name)
      .sort((a, b) => (a.claim as NonNullable<BoardCard["claim"]>).claimedAt.localeCompare((b.claim as NonNullable<BoardCard["claim"]>).claimedAt));
    const online = runnerAlive(runner, now);
    const state = !online ? "offline" : builds.length > 0 ? "busy" : "idle";
    const dot = state === "busy" ? html`<span class="dot dot-ok pulse"></span>` : html`<span class="dot dot-off"></span>`;
    const jobs = builds.length > 0
      ? builds.map(card => {
          const claim = card.claim as NonNullable<BoardCard["claim"]>;
          const words = claim.model === null ? "preparing workspace" : claim.phase === null ? "the agent is working" : phaseWords(claim.phase);
          return html`<a class="worker-job" href="${card.href}"><span class="t">${card.title}</span><span class="sub"><span>${words}</span>${tickingClock(claim.claimedAt, now)}</span></a>`;
        })
      : html`<p class="worker-job idle">${online ? "no build on this board" : html`offline since ${whenTime(runner.heartbeatAt)}`}</p>`;
    return html`<div class="worker worker-${state}" data-flash="${runner.name}" data-flash-value="${builds.map(card => card.taskId).join(" ")}"><div class="worker-head">${dot}<span class="name">${runner.name}</span><span class="kind">${runner.agents.join(" · ")}</span>${runner.capacity > 1 ? html`<span class="slots">${builds.length}/${runner.capacity}</span>` : null}</div>${jobs}</div>`;
  });
  return html`<section class="crew" aria-label="Workers">${tiles}</section>`;
}

/**
 * The board: the pipeline as lanes, position as meaning — attention, then
 * queued, then waiting, then building, then recently done — under a strip
 * of the workers doing it. Read-only by construction (every card is a link,
 * no forms, no nonces), which is what makes it safe to re-render itself
 * while somebody watches; a card that changes lane slides there
 * (regionScript's animate swap, keyed by data-vt).
 */
export function boardBody(
  data: {
    cards: BoardCard[];
    /** The workers this board's work can go to (retired ones left out). */
    workers: readonly Runner[];
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

  // A lane's head is a status chip in its own tone (after ReUI's badge with a dot): amber only for the lane that
  // waits on a person, blue for building, green for done, neutral otherwise. The word carries the state.
  const LANE_CHIP = { attention: "chip-needs", building: "chip-live", done: "chip-done", queued: "", waiting: "" } as const;
  const laneChip = (key: keyof typeof LANE_CHIP, title: Html | string): Html =>
    html`<span class="chip ${LANE_CHIP[key]}"><span class="chip-dot" aria-hidden="true"></span>${title}</span>`;

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
    return html`<details class="lane lane-${key}"${shown.length === 0 ? null : html` open`}><summary><h2>${laneChip(key === "attention" && cards.length === 0 ? "queued" : key, title)} <span class="lane-count">${cards.length}${data.saturated ? "+" : ""}</span></h2></summary><p class="hint">${hint}</p>${shown.length === 0 ? html`<p class="meta lane-empty">nothing here</p>` : shown.map((card, index) => renderOne(card, index))}${more > 0 ? html`<a class="lane-more" href="/tasks">+${more} more in Tasks</a>` : null}</details>`;
  };

  // The card's facts: mono key–value pairs under the title (board pass) —
  // task, worker, runtime — the same grammar on every lane, so the eye
  // learns one card. Chips carry the words (project, reservation).
  // A value is mono only when a machine said it (a worker, model or branch name, a clock); words stay Geist.
  const facts = (rows: ([string, string] | [string, string, "mono"])[]): Html | null =>
    rows.length === 0
      ? null
      : html`<span class="facts">${rows.map(([k, v, mono]) => html`<span class="fact"><span class="k">${k}</span><span class="${mono === undefined ? "v" : "v mono"}">${v}</span></span>`)}</span>`;
  const chips = (parts: (Html | null)[]): Html | null => {
    const kept = parts.filter((one): one is Html => one !== null);
    return kept.length === 0 ? null : html`<span class="chips">${joinHtml(kept, " ")}</span>`;
  };

  const plain = (card: BoardCard): Html =>
    html`<a class="lane-card" href="${card.href}" data-vt="${card.taskId}"><span class="t">${card.title}</span><span class="why">${card.reason}</span><span class="id">${card.taskId}</span>${facts([
      ...(card.stalledSince === null ? [] : [["waiting", age(card.stalledSince), "mono"] as [string, string, "mono"]]),
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
    html`<a class="lane-card" href="${card.href}" data-vt="${card.taskId}"><span class="t">${card.title}</span><span class="why">${card.reason}</span><span class="id">${card.taskId}</span>${facts([
      card.assignedRunner === null ? ["builder", "any free builder"] : ["builder", card.assignedRunner, "mono"],
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
    const workspace = claim.worktree === null ? null : (claim.worktree.split("/").pop() ?? claim.worktree);
    // Chip copy: unknown phases show nothing rather than raw tokens.
    const phase = claim.phase === null ? undefined : PHASE_WORDS[claim.phase];
    // The live strip is the run's own phase and clock — never a percent:
    // a build has no honest progress figure, only a stage and an elapsed.
    const live = claim.model === null ? "preparing workspace" : (phase ?? "the agent is working");
    // The steps: where the build is among set up → writing → checking →
    // committing, from its phase — a stage, never a percent.
    const step = buildStepOf(claim);
    const steps = step === null
      ? null
      : html`<span class="steps" role="img" aria-label="${`step ${step + 1} of ${BUILD_STEPS.length}: ${BUILD_STEPS[step]}`}">${BUILD_STEPS.map((_, index) => html`<i class="${index < step ? "on" : index === step ? "now" : ""}"></i>`)}</span>`;
    // Who, which model and which branch, as one muted line: words in Geist, the model and branch in mono.
    const model = claim.model === null ? null : claim.provider === null ? modelName(null, claim.model) : agentModelName(claim.provider, claim.model);
    const branch = claim.branch === null ? null : `${claim.branch}${workspace === null ? "" : ` · ${workspace}`}`;
    const who = joinHtml([
      html`<span>${claim.runner}</span>`,
      model === null ? null : html`<span>${model}</span>`,
      branch === null ? null : html`<span class="mono">${branch}</span>`,
    ].filter((one): one is Html => one !== null), html`<span aria-hidden="true"> · </span>`);
    return html`<a class="lane-card building" href="${card.href}" data-vt="${card.taskId}"><span class="t"><span class="dot dot-ok pulse"></span>${card.title}</span>${steps}<span class="live-line"><span class="stage">${live}</span>${tickingClock(claim.claimedAt, data.now)}</span><span class="id">${card.taskId}</span><span class="who">${who}</span>${chips([
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
          return html`<a class="lane-card" href="${taskHref(row.taskId)}" data-vt="${row.taskId}"><span class="t">${row.title}</span>${row.handoff === null ? null : html`<span class="why">${row.handoff.length > 120 ? row.handoff.slice(0, 120) + "…" : row.handoff}</span>`}<span class="id">${row.taskId}</span>${facts([
            ...(row.ranMinutes === null ? [] : [["ran", `${row.ranMinutes}m`, "mono"] as [string, string, "mono"]]),
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
                : html`<a href="/tasks?view=board">${projectName(data.project)}</a> · <strong>all projects</strong>`} — every project this server serves, each card wearing its project`
            : html`<strong>${projectName(data.project as string)}</strong> · <a href="/tasks?view=board&scope=all">all projects</a>`
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
              ? html`${data.delta.questions} question${data.delta.questions > 1 ? "s" : ""} — <a href="/">answer →</a>`
              : null,
          ].filter((one): one is Html => one !== null),
          html` · `,
        )}</p>`;

  return joinHtml([
    html`<h1>Board</h1>`,
    data.all ? null : html`<p class="meta board-view"><strong>State</strong> · <a href="/tasks?view=order">order →</a> <span class="meta">drag to reorder, or to keep a task for one builder</span></p>`,
    deltaLine,
    toggle,
    workerStrip(data.workers, data.cards, data.now),
    html`<div class="board" data-now="${String(data.now.getTime())}">`,
    lane("attention", "Needs you", "These wait for a person.", plain),
    lane("queued", "Queued", "Starts when a builder is free.", queuedCard),
    lane("waiting", "Waiting", "Paused until a time, another task, or a requirement is ready.", plain),
    lane("building", "Building", "One agent per card, in its own workspace.", building),
    html`<details class="lane lane-done"${data.done.length === 0 ? null : html` open`}><summary><h2>${laneChip("done", html`<a href="/tasks?view=done">Done recently</a>`)}</h2></summary><p class="hint">The most recent. The full list is under Done.</p>${doneCards}</details>`,
    html`</div>`,
  ], "\n");
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
            html`<a class="stat-card" href="${taskHref(claim.taskId)}" style="text-decoration:none"><span class="k"><span class="dot dot-ok pulse"></span>${claim.taskId}</span><span class="v">${claim.runner} · ${Math.max(1, Math.round((data.now.getTime() - new Date(claim.claimedAt).getTime()) / 60_000))}m elapsed${claim.model === null ? null : html` · ${modelName(null, claim.model)}`}</span></a>`,
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
          html`<p>1. <a href="/tasks/new">Add a task</a> — plain words for work you want done${data.repo === null ? null : html` in <span class="mono">${data.repo}</span>`}.</p>`,
          html`<p>2. Open it and write its plan — the goal, and what it must not become. Approve exactly that.</p>`,
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

export type WorkRow = WorkFacts & { assignment?: AssignmentSnapshot | null; assignmentProblem?: boolean; executionId?: string; familyNotice?: string | null; status: WorkStatus; resultRunId: number | null };

export const TASK_GROUP_LABEL: Readonly<Record<WorkIndexGroup, string>> = { ...ASK_LABEL, building: 'Building', rest: 'Recent' };

/** A list row's chip (src/design/KIT.md): a waiting row names its ask ("Plan", "Result") in the ask tone, or says
 * Needs you; every other row wears its headline in the tone of the status it belongs to. */
export function workRowChip(row: Pick<WorkIndexItem, 'ask' | 'chip' | 'status' | 'archived'>): { word: string; tone: ChipTone } {
  if (row.archived !== undefined) return { word: 'Archived', tone: '' };
  if (row.ask !== null) return row.chip === null ? { word: 'Needs you', tone: 'needs' } : { word: row.chip, tone: 'ask' };
  const label = row.status.label;
  if ((HEADLINES as readonly string[]).includes(label)) { const chip = chipOfHeadline(label as Headline); return { word: chip.word, tone: chip.tone }; }
  const tone = row.status.tone;
  return { word: label, tone: tone === 'live' ? 'live' : tone === 'done' ? 'done' : tone === 'problem' ? 'failed' : '' };
}

/** Where a row's one action goes: a result opens on its task's Result tab (the review page is the task page now). */
function workActionHref(row: WorkIndexItem): string | null {
  const target = row.primaryAction?.target;
  if (row.primaryAction?.code === 'open-result' && target?.runId != null) return `${taskHref(target.taskId)}?tab=result&run=${target.runId}`;
  return browserWorkActionHref(row);
}

/** The board's four columns: what needs you, what will start on its own, what runs, what finished. */
export type WorkBoard = { needs: WorkIndexPage; queued: WorkIndexPage; running: WorkIndexPage; finished: WorkIndexPage };

export function workPage(
  chrome: Chrome,
  data: { view: WorkView; projectFilter?: string; work: WorkIndexPage; previous: boolean; multiProject: boolean; now: Date; limits?: BrowserLimits | null; state?: TaskState | null;
    /** An approver in a browser session: rows offer Put away (or Restore, archived), and the page offers Put away old tasks. */
    canPutAway?: boolean;
    /** The project this list shows (null: every project in view) and whether All was asked for by name (`all=1`). */
    lens?: string | null; all?: boolean;
    /** The Board view's columns, read from the same index as the list; absent for the List view. */
    board?: WorkBoard | null },
): Screen {
  const layout = data.board != null ? 'board' as const : 'list' as const;
  // The project and the stored-state filter ride every link; a change of filter starts on page one.
  const query = (over: { view?: WorkView; cursor?: string; state?: TaskState | null; layout?: 'list' | 'board'; project?: string | null | 'all' } = {}): string => {
    const project = over.project === undefined ? (data.projectFilter ?? (data.all === true ? 'all' : null)) : over.project;
    const board = (over.layout ?? layout) === 'board';
    const state = over.state === undefined ? data.state ?? null : over.state;
    // Tasks' own address (docs/plans/plain-toolroll.md P1.4): Board is a view; every project is scope=all.
    return tasksHref({ scope: project === 'all' ? 'all' : null, project: project === 'all' ? null : project, view: board ? 'board' : over.view ?? data.view,
      state: board ? null : state, cursor: over.cursor ?? null });
  };
  const href = (view: WorkView, cursor?: string, state: TaskState | null = data.state ?? null): string => query({ view, ...(cursor === undefined ? {} : { cursor }), state });
  // Put away (or Restore, in Archived): one quiet act per row, never on a task with work going on.
  const tidyAct = (row: WorkIndexItem): { action: string; label: 'Archive' | 'Restore' } | null =>
    data.canPutAway !== true ? null : row.archived !== undefined ? { action: `${taskHref(row.rootId)}/restore`, label: 'Restore' }
      : row.liveRunId !== null || row.unfinishedRunId !== null || row.status.views.includes('running') ? null : { action: `${taskHref(row.rootId)}/archive`, label: 'Archive' };
  const returnTo = href(data.view, undefined);
  const current = WORK_VIEWS.find(one => one.key === data.view)!;
  const filtered = (data.state ?? null) !== null;
  const projectOf = (row: WorkIndexItem): string | null => data.multiProject || row.repo === null ? (row.repo === null ? 'Unplaced' : projectName(row.repo)) : null;
  // The status filters, as addresses, each with its count; Archived sits at the foot of Finished, not in the track.
  const tabs = WORK_VIEWS.filter(one => one.key !== 'archived').map(one => ({ key: one.key, label: one.label, href: href(one.key), count: data.work.totals[one.key], active: one.key === data.view }));
  // The project filter: All and each project in view, when there is more than one.
  const known = chrome.projects ?? [];
  const lens = data.lens === undefined ? chrome.project : data.lens;
  const projects = known.length < 2 ? null : [
    { key: '', label: 'All', href: query({ project: 'all' }), active: lens === null },
    ...known.map(one => ({ key: one.path, label: one.name, href: query({ project: one.path }), active: lens === one.path })),
  ];
  const rowOf = (row: WorkIndexItem): BrowserTasksView['rows'][number] => {
    const act = tidyAct(row);
    const tidy = act === null ? null : { action: act.action, label: act.label, returnTo };
    const chip = workRowChip(row);
    if (row.archived !== undefined) return {
      id: row.rootId, title: row.title, href: taskHref(row.rootId), project: projectOf(row), age: relativeAge(row.archived.at, data.now),
      status: { label: 'Archived', tone: 'muted' as const, token: 'archived' }, chip: null, word: chip,
      ask: null, group: 'rest' as const, rank: 4, action: null, detail: archivedWords(row.archived), problem: null, notes: [], tidy,
    };
    const actionHref = workActionHref(row);
    const needsYouDetail = (row.status.views.includes('needs-you') || row.status.label === 'Failed') && !['write-scope', 'approve-scope'].includes(row.primaryAction?.code ?? '') && row.status.label !== 'Ready for review' && row.status.detail !== row.status.label && row.status.detail !== row.familyProblem;
    return {
      id: row.rootId, title: row.title, href: taskHref(row.rootId), project: projectOf(row), age: relativeAge(row.updatedAt, data.now),
      status: { label: row.status.label, tone: row.status.tone, token: row.status.token }, chip: row.chip, word: chip,
      ask: row.ask, group: row.ask ?? (row.status.rank === 1 ? 'building' : 'rest'), rank: row.status.rank,
      // One quiet action, on a row that waits on you; every other row is its own link.
      action: actionHref === null || row.primaryAction === null || row.ask === null ? null : { label: row.primaryAction.label, href: actionHref },
      detail: needsYouDetail ? row.status.detail : (row as { progress?: string }).progress ?? (row.ask === null && row.status.detail !== row.status.label ? row.status.detail : null),
      problem: row.familyProblem,
      notes: (row.status.diagnostics ?? []).map(one => `${one.label} · ${one.detail}`),
      tidy,
    };
  };
  const rows = data.work.items.map(rowOf);
  const board = data.board == null ? null : ([
    ['needs', 'Needs you', data.board.needs, 'needs-you', 'Nothing needs you.'],
    ['queued', 'Queued', data.board.queued, 'queued', 'Nothing queued.'],
    ['running', 'Running', data.board.running, 'running', 'Nothing running.'],
    ['finished', 'Finished', data.board.finished, 'completed', 'Nothing has finished yet.'],
  ] as const).map(([key, label, page, view, empty]) => ({ key, label, count: page.totals[view], href: query({ view, layout: 'list' }), empty, rows: page.items.map(rowOf) }));
  const putAwayLink = data.canPutAway === true && data.view !== 'archived' ? { label: 'Archive old tasks', href: '/tasks/archive' } : null;
  const toolLinks = [['/tasks?view=order', 'Order the queue'], ['/recipes', 'Recipes'], ...(chrome.projectScoped ? [] : [['/tasks?scope=all', 'Every project']]), ['/ledger', 'Audit log']];
  const newTaskHref = lens === null ? '/tasks/new' : `/tasks/new?project=${encodeURIComponent(lens)}`;
  const emptyNow = data.work.items.length > 0 ? null : filtered && !data.previous ? { text: `No tasks are ${data.state} in this view.`, action: { label: 'Show every state', href: href(data.view, undefined, null) } } : {
    text: data.previous ? 'There are no more tasks on this page.' : current.empty,
    action: data.view === 'all' && !data.previous ? { label: chrome.chat === true ? 'Start in chat' : 'Add a task', href: chrome.chat === true ? '/chat' : newTaskHref } : data.view === 'all' ? null : { label: 'Show all tasks', href: href('all') },
  };
  const view: BrowserTasksView = {
    kind: 'tasks',
    layout,
    tabs,
    projects,
    layouts: { list: query({ layout: 'list' }), board: query({ layout: 'board', view: 'all' }) },
    scope: lens === null ? 'across all your projects' : `in ${known.find(one => one.path === lens)?.name ?? projectName(lens)}`,
    needsYou: data.work.totals['needs-you'],
    groups: data.view !== 'all' && data.view !== 'needs-you' ? null
      : ([...ASKS, ...(data.view === 'all' ? ['building', 'rest'] as const : [])] as WorkIndexGroup[])
        .map(key => ({ key, label: TASK_GROUP_LABEL[key], count: data.work.groups[key] })).filter(one => one.count > 0),
    rows,
    board,
    archived: data.view === 'completed' || data.view === 'archived' ? { label: 'Archived', href: href('archived'), count: data.work.totals.archived, active: data.view === 'archived' } : null,
    empty: emptyNow,
    pages: { first: data.previous ? href(data.view) : null, next: data.work.nextCursor === null ? null : href(data.view, data.work.nextCursor) },
    tools: toolLinks.map(([path, label]) => ({ label: label!, href: path! })),
    newTask: { label: 'New task', href: newTaskHref },
    putAway: putAwayLink,
    limits: data.limits ?? null,
    states: [{ label: 'Any state', href: href(data.view, undefined, null), active: (data.state ?? null) === null },
      ...TASK_STATES.map(one => ({ label: one.charAt(0).toUpperCase() + one.slice(1), href: href(data.view, undefined, one), active: data.state === one }))],
  };
  // The page without the workspace (and its first paint) keeps the older rows the server tests read; the workspace
  // replaces it with the kit view above.
  const legacyTabs = html`<nav class="work-views" aria-label="Task views">${WORK_VIEWS.map(one =>
    html`<a href="${href(one.key)}"${one.key === data.view ? html` class="active" aria-current="page"` : null}>${one.label}<span class="count">${data.work.totals[one.key]}</span></a>`
  )}</nav>`;
  const rowHtml = (row: WorkIndexItem): Html => {
    if (row.archived !== undefined) {
      const act = tidyAct(row);
      const project = data.multiProject || row.repo === null ? html`<span class="project-label">${row.repo === null ? 'Unplaced' : projectName(row.repo)}</span>` : null;
      return html`<article class="work-row" data-task="${row.rootId}" data-work-status="archived" data-work-views="archived"><div class="work-row-main"><a class="work-title" href="${taskHref(row.rootId)}">${row.title}</a><p class="work-meta">${project}<span>${relativeAge(row.archived.at, data.now)}</span><span class="mono">${row.rootId}</span></p><p class="work-detail" data-archived-by>${archivedWords(row.archived)}</p></div><div class="work-row-status">${act === null ? null : postForm(act.action, html`<button type="submit" class="secondary">${act.label}</button>`, { hidden: { return: returnTo }, attrs: { class: 'inline', 'data-tidy-act': 'restore' } })}</div></article>`;
    }
    const target = row.primaryAction?.target;
    const actionHref = row.primaryAction?.code === 'open-result' && target?.runId != null
      ? `/review?result=${encodeURIComponent(target.taskId)}&run=${target.runId}`
      : browserWorkActionHref(row);
    const action = actionHref === null || row.primaryAction === null ? null : html`<a class="work-action" data-primary-action href="${actionHref}">${row.primaryAction.label} →</a>`;
    const project = data.multiProject || row.repo === null ? html`<span class="project-label">${row.repo === null ? 'Unplaced' : projectName(row.repo)}</span>` : null;
    const act = tidyAct(row);
    const putAway = act === null ? null : postForm(act.action, html`<button type="submit" class="quiet">${act.label}</button>`, { hidden: { return: returnTo }, attrs: { class: 'inline', 'data-tidy-act': 'put-away' } });
    return html`<article class="work-row" data-task="${row.rootId}" data-work-status="${row.status.token}" data-work-views="${row.status.views.join(' ')}"><div class="work-row-main"><a class="work-title" href="${taskHref(row.rootId)}">${row.title}</a><p class="work-meta">${project}<span>${relativeAge(row.updatedAt, data.now)}</span><span class="mono">${row.rootId}</span></p></div><div class="work-row-status">${statusLineHtml(row.status)}${action}${putAway}${row.familyProblem === null ? null : html`<p class="problem">${row.familyProblem}</p>`}${row.status.views.includes('needs-you') && !['write-scope', 'approve-scope'].includes(row.primaryAction?.code ?? '') && row.status.detail !== row.status.label && row.status.detail !== row.familyProblem ? html`<p class="work-detail">${row.status.detail}</p>` : null}${workDiagnosticsHtml(row.status.diagnostics)}</div></article>`;
  };
  // The state filter, as real links (the old task list's), so a page without the React view can still change it.
  const stateLinks = html`<nav class="work-states" aria-label="Task state"><span class="meta">State:</span> ${joinHtml([html`<a href="${href(data.view, undefined, null)}"${filtered ? null : html` aria-current="page"`}>Any</a>`,
    ...TASK_STATES.map(one => html`<a href="${href(data.view, undefined, one)}"${data.state === one ? html` aria-current="page"` : null}>${one}</a>`)], html` · `)}</nav>`;
  const list = data.work.items.length === 0 && filtered && !data.previous
    ? html`<div class="work-empty" data-work-empty="${data.view}"><p>No tasks are ${data.state} in this view.</p><a href="${href(data.view, undefined, null)}">Show every state →</a></div>`
    : data.work.items.length === 0
    ? html`<div class="work-empty" data-work-empty="${data.view}"><p>${data.previous ? 'There are no more tasks on this page.' : current.empty}</p>${data.view === 'all' && !data.previous ? html`<p><a class="button-link" href="${chrome.chat === true ? '/chat' : '/tasks/new'}">${chrome.chat === true ? 'Start in chat' : 'Add a task'}</a></p>` : html`<a href="${href('all')}">See all tasks →</a>`}</div>`
    : html`<div class="work-list">${data.work.items.map(rowHtml)}</div>`;
  const pages = !data.previous && data.work.nextCursor === null ? null : html`<nav class="row work-pagination" aria-label="Task pages">${data.previous ? html`<a class="button-link" href="${href(data.view)}">First page</a>` : null}${data.work.nextCursor === null ? null : html`<a class="button-link" rel="next" href="${href(data.view, data.work.nextCursor)}">Next page</a>`}</nav>`;
  const tools = html`<details class="work-tools"><summary>Work tools${CHEVRON_ICON}</summary><nav class="work-tools-menu">${[['/', 'Home'], ['/tasks?view=board', 'Board'], ['/tasks?view=order', 'Order'], ['/recipes', 'Recipes'], ...(chrome.projectScoped ? [] : [['/tasks?scope=all', 'Every project']]), ['/ledger', 'Audit log']]
      .map(([path, label]) => html`<a href="${path}">${label}</a>`)}</nav></details>`;
  return screen('work', html`<div class="work-head"><h1>Tasks</h1>${putAwayLink === null ? null : html`<a class="button-link" href="${putAwayLink.href}" data-put-away-old>${putAwayLink.label}</a>`}${tools}</div>${limitsHtml(data.limits ?? null)}${legacyTabs}${stateLinks}${list}${pages}`, { chrome, workspace: { view } });
}


/** The compact completed row shared by both halves of the control room. */
export type WorkbenchDone = { taskId: string; title: string; outcome: string | null; repo: string | null };



export type OnboardCardState =
  | { enabled: false; why: string }
  | { enabled: true; roots: readonly string[]; /** Easy-start: the local owner's own session (no password to type; the prover's local-owner branch proves the clone). */ localOwner?: boolean; record: [string, { nameWithOwner: string; rootIndex: number; target: string; diskUsageKib: number | null; large: boolean; mintedAt: number }] | null };

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

/** The no-script "move to the front" sentinel: the form cannot name the
 * front of a partition, so the handler resolves it (slice 1b, fix 1). */
export const QUEUE_FRONT = "__TOP__";

export type QueueCardTask = ReturnType<Store["queueScoped"]>[number] & { dispatch?: DispatchDiagnosis | null };

export function queueCard(one: QueueCardTask, revision: number, queueRevision: number, workers: { name: string; retired: boolean }[], column: string): Html {
  // Presentation over queueScoped()'s shape only: state, scope, blockers,
  // and the reservation owner. Money is not in this query and is not
  // invented here — it stays on the task page, labeled.
  const state = one.taken
    ? html`<span class="badge">Starting — a builder has it</span>`
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
                  () => html`<p class="meta">Every builder has work kept for it — this waits until a column empties</p><p class="row meta">`,
                )
              : queueCard(one, revision, queueRevision, workers, key),
          ), "\n")
    }</section>`;
  const noteForm = (worker: { name: string; retired: boolean; note: string | null; capacity: number; building: number }): Html =>
    worker.retired
      ? html`<p class="meta">This builder is retired — drag these elsewhere, or register the name again</p>`
      : html`<p class="meta mono">${worker.building} building in this project · unattended capacity ${worker.capacity}</p>${postForm(
          "/queue/note",
          html`<input type="text" name="note" value="${worker.note ?? ""}" data-initial="${worker.note ?? ""}" placeholder="what this worker is working through" aria-label="column note" maxlength="200"><button type="submit">Save</button>`,
          { attrs: { class: "row" }, projectRevision: revision, hidden: { runner: worker.name } },
        )}<p class="meta">Takes from the shared queue when this column is empty</p>`;
  return html`<div class="lanes" data-queue-revision="${queueRevision}">${column("shared queue", "anyone", html`<p class="meta">Workers take from here when their column is empty — top card first</p>`, shared, "nothing waiting — every task is reserved or running")}${joinHtml(
    workers.map(worker => column(worker.name + (worker.retired ? " (retired)" : ""), worker.name, noteForm(worker), columnOf(worker.name), "nothing queued — this builder takes from the shared queue")),
    "\n",
  )}</div>`;
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
    `fetch("/tasks?view=order&fragment=1",{redirect:"manual",cache:"no-store"})` +
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
    `fetch("/queue/move",{method:"POST",headers:(window.soKeyHeaders||function(h){return h})({"Content-Type":"application/x-www-form-urlencoded"}),body:post.toString(),redirect:"manual"})` +
    `.then(function(r){if(r.ok)return fetch("/tasks?view=order&fragment=1",{redirect:"manual",cache:"no-store"}).then(function(f){` +
    `if(f.type==="opaqueredirect"||f.status===401||f.status===403){location.href="/login";return false;}return f.ok?f.text():null;});` +
    `if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return false;}` +
    `var kind=(r.headers&&r.headers.get?r.headers.get("content-type"):"")||"";` +
    `if(r.status===409&&kind.indexOf("text/plain")===0){return r.text().then(function(text){return problem(drag.task,text)?false:null;});}` +
    `return null;})` +
    `.then(function(t){if(t===false)return;if(t&&!paused()){region.innerHTML=t;last=Date.now();}else if(t===null){location.href="/tasks?view=order";}})` +
    `.catch(function(){})` +
    `.then(function(){tell();});});` +
    `})();`
  );
}

  export type PeekAdmission = {
    run: Run;
    /** The run's checkout, PROVEN non-null by the guards: a reviewer run
     * (v29, artifact-only) is refused before admission ever forms. */
    worktree: string;
    epoch: string;
    entries: ReturnType<typeof parseBaseTreeSnapshot>;
  };

/** Put away old tasks (docs/plans/task-tidy.md): exactly what would be put away, grouped, each with why, every one
 * ticked; one step-up puts away the ticked ones, bound to this preview's digest. The CLI twin is named beside it. */
export function putAwayPage(chrome: Chrome, data: { items: readonly TidyItem[]; days: number; digest: string; now: Date; problem: string | null; releasesSkipped: string | null }): Screen {
  const groups = tidyGroups(data.items, data.days);
  const count = data.items.length;
  const crumbs = html`<nav class="kit-crumbs" aria-label="Breadcrumb"><ol><li><a href="/tasks">Tasks</a></li><li><span aria-current="page">Archive old tasks</span></li></ol></nav>`;
  const daysForm = html`<form method="get" action="/tasks/archive" class="put-away-days"><label>Also finished tasks untouched for <input type="number" name="days" min="1" max="365" value="${String(data.days)}" inputmode="numeric"> days</label><button type="submit" class="secondary">Update list</button></form>`;
  const list = joinHtml(groups.map(group => html`<fieldset class="put-away-group" data-tidy-group="${group.rule}"><legend>${group.label}<span class="count">${String(group.items.length)}</span></legend><ul>${group.items.map(item =>
    html`<li><label class="put-away-item" data-tidy-task="${item.taskId}"><input type="checkbox" name="task" value="${item.taskId}" checked><span class="put-away-title">${item.title}</span><span class="put-away-why">${item.reason}</span><span class="put-away-id">${item.taskId}${item.repo === null ? "" : ` · ${projectName(item.repo)}`}${item.members.length > 1 ? ` · ${item.members.length} versions` : ""}</span></label></li>`)}</ul></fieldset>`));
  const body = count === 0
    ? html`<p class="kit-state">Nothing to archive right now.</p><p><a href="/tasks?view=archived">See archived tasks →</a></p>`
    : stepUpForm({ proof: "tasks-put-away", action: "/work/put-away", id: "put-away", hidden: { digest: data.digest, days: data.days },
      body: html`${list}`, save: { label: "Archive selected", idle: `${count} ${count === 1 ? "task" : "tasks"} selected` }, confirm: `Archive the selected tasks. You can restore any of them from Archived.` });
  return screen("Archive old tasks", html`<div class="put-away">${crumbs}<h1>Archive old tasks</h1>\
<p class="kit-state">${count === 0 ? "Old releases, routine runs and fixed CI notices are archived automatically." : `${count} ${count === 1 ? "task" : "tasks"} can be archived. They leave every list and keep their history.`}</p>\
${data.problem ? html`<p class="kit-problem" role="alert">${data.problem}</p>` : ""}${data.releasesSkipped === null ? "" : html`<p class="kit-hint">Release tasks were left out: ${data.releasesSkipped}.</p>`}${daysForm}${body}</div>`, { chrome });
}
