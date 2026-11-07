import { projectOutcomes } from '../project-outcomes.js';
import { steerControlsFor } from "../steer-controls.js";
import { canReveal, cdCommandOf, localCheckoutOf } from "../checkout-proof.js";
import { instanceHttpAnswer } from "../console-instance.js";
import { handlersOf } from './handler-registry.js';
import { html, joinHtml, postForm, type Html, reauth } from "../html.js";
import * as kit from "./kit.js";
/** pages handlers, moved without changing their route bodies. */
import { createHmac,randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { type ServerResponse } from "node:http";
import { homedir,hostname } from "node:os";
import { basename,dirname,join,resolve } from "node:path";
import { buildersFor } from "../dispatch.js";
import { listFolder,localOrigins } from "../folder-look.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { parseApiToken,tokenLive } from "../api-tokens.js";
import { classify } from "../board.js";
import { serveBrowserAsset } from '../browser-shell.js';
import { projectCheckLevel } from '../check-levels.js';
import { checkResponse,CONSOLE_FORMS,readForm } from "../contracts/console-api.js";
import { hasForbiddenControls } from "../decision.js";
import { exportDay,ledgerExportChunks } from "../evidence-pack.js";
import { run as execRun } from "../exec.js";
import { computeGaps } from "../gaps.js";
import { LEDGER_CSV_HEADER,ledgerCsvRows } from "../ledger-csv.js";
import { ledgerBody } from "../ledger-view.js";
import { agentRowOf, agentsListOf, agentFactsFor, sealedDiffOf } from "../agents-board.js";
import { computersOf, phasesOf, systemOf } from "./agents-computers.js";
import { agentsLiveOf } from "../agents-live.js";
import { readChildWindow } from "../live-children-read.js";
import { leadFiledLinks } from "./agents-live-filed.js";
import { readMainWindow } from "../live-main-read.js";
import { runLiveCommands } from "../store.js";
import type { BrowserAgentDetail,BrowserAgentsView } from "../browser-workspace.js";
import { prometheusMetrics } from "../metrics.js";
import { readMonitoring } from "../monitoring-settings.js";
import { targetOf } from "../monitoring.js";
import { cloneGithubRepo,isLargeRepo,listGithubRepos,parseGithubRepo,previewGithubRepo } from "../onboard.js";
import { admitProject,releaseProject } from "../project-admission.js";
import {
authorizedProject,
canonicalProject,
isGitRepo,
projectName,
sameRepo
} from "../project.js";
import { publishingOf } from '../pull-request-flow.js';
import { register as registerRunner } from "../runner.js";
import { healthWords } from "../server-telemetry.js";
import { tally } from "../summary.js";
import type { EdgeContext,HandlerContext } from './handler-context.js';
import { serveInstallAsset } from "./pages-assets.js";
import { healthz } from "./remote-hooks.js";
import { slowRequestLines, SLOW_REQUEST_MS } from "../latency-timeline.js";
import type { ServerRuntime } from './runtime.js';
import { leadsStillAdmitted, leadTilesFor } from './agents-live-lead.js';
import { refuse, regionScript, relativeAge as relativeAgeOf, screen, settingsRows, WORKSPACE_STYLE, workToolRows, type NavRow } from "./chrome.js";
import { redirect,respond,safeReturn,SAFETY,taskHref } from "./http.js";
import { assignmentOf } from "../assignment.js";
import { assignmentTaskStatusOf } from "../assignment-presentation.js";
import { githubIdentityOf,homePage,startBuilderHtml } from "./render-pages.js";
import { retiredRedirect } from "./retired-routes.js";
import { codeMapStatus, openMap } from "../code-map-read.js";
import { requestRefresh } from "../code-map-store.js";
import { codeMapReport } from "../code-map-report.js";
import { codeMapPage, codeMapReportBlock } from "./render-code-map.js";
import { FLAKY_WINDOW_DAYS, flakyList, flakyShow } from "../flaky.js";
import { flakyPage, flakyRowPage } from "./render-flaky.js";
import { browsePage,githubReposPage,projectHref,projectPage,projectsPage,unknownProject,type ProblemAt,type ProjectPageTask } from "./render-projects.js";
import { notFound as kitNotFound } from "./kit.js";
import { type ProjectPeek } from "./render-pages.js";
import { type ProjectOutcomes } from "../project-outcomes.js";
import { CHECK_LEVEL_WORDS } from "../check-levels.js";
import { capsPage } from "./render-settings.js";
import { consentDoorOf,decisionAnswerScript,taskBody } from "./render-tasks.js";
import { type Who } from "./session.js";
import { rereadBrowser } from "./live.js";
import { homeView } from "./home.js";
import { workIndexPage } from "../work-index.js";
export function createPagesHandlers(runtime: ServerRuntime) {
  const { identities, clock, lastChecks, store, visible, consoleProjects, restricted, ceiling, options, projectFamilyPeek, sendScreen, chromeFor, unscopedMode, admissionList, taskRepoOf, taskViewData, runVisible, evidenceRoot, workAccess, identify, liveCeiling, sessions, deletedRepos, authenticateApprover, authenticateCredential, projectOf, lookupSession, firstRunStepsNow } = runtime;

  // The filesystem browser (operator request): pick a project folder by
  // looking, not typing. CONFINED to exactly what opening allows —
  // explicit --repo mode has an enumerable list and gets no browser at
  // all; --project-root mode browses its roots; unscoped mode (trust-
  // everything, named as such) browses from the home directory.
  // Directory NAMES only, never file contents; symlinks are resolved
  // and re-checked so a link cannot walk out of the fence.
  async function projectsBrowse(ctx: HandlerContext): Promise<void> {
    const { url, who, response } = ctx;
    if (who.via !== "cookie") return refuse(response, who, 403, "browsing feeds a browser session's act");
    const browseRoots =
      ceiling.roots.length > 0 ? [...ceiling.roots] : unscopedMode ? [identities.hot(homedir())] : [];
    if (browseRoots.length === 0) {
      return refuse(response, who, 404, "this server was configured with an explicit repo list — the openable projects are all on the projects page", "/projects");
    }
    const asked = url.searchParams.get("at") ?? browseRoots[0] as string;
    const within = (path: string) => browseRoots.some(root => path === root || path.startsWith(`${root}/`));
    // Spelled outside every root: refused before anything is read. Inside, the look resolves links and checks again.
    if (!within(resolve(asked))) {
      return refuse(response, who, 403, "that path is outside what this server may browse", "/projects/browse");
    }
    // Read off the console's thread (folder-look.ts): a folder that doesn't answer never freezes the console.
    const looked = await listFolder(asked, browseRoots, { ...(options.folderLook === undefined ? {} : { runner: options.folderLook }), ...(options.folderLookMs === undefined ? {} : { deadlineMs: options.folderLookMs }) });
    if (!looked.ok) {
      return looked.why === "no-answer"
        ? refuse(response, who, 503, "This folder didn't answer. It may be on a drive that's disconnected, or waiting on macOS. Try again in a moment.", "/projects")
        : refuse(response, who, 404, "that directory cannot be read", "/projects/browse");
    }
    const canonical = looked.value.at;
    if (canonical === null || !within(canonical)) {
      return refuse(response, who, 403, "that path is outside what this server may browse", "/projects/browse");
    }
    // The look kept only folders inside a root; checked here again, as before.
    const entries = looked.value.entries
      .filter(one => within(one.path))
      .sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name))
      .slice(0, 200);
    const root = browseRoots.find(one => canonical === one || canonical.startsWith(`${one}/`)) as string;
    const parent = canonical === root ? null : canonical.slice(0, canonical.lastIndexOf("/")) || root;
    const registered = new Set(store.listProjects().filter(one => visible(one.path)).map(one => one.path));
    return sendScreen(
      response,
      200,
      browsePage(chromeFor(who.session.project, "projects"), {
        at: canonical,
        root,
        roots: browseRoots,
        parent,
        entries,
        registered,
      }),
    );
  }

  // The signed-in gh account's repositories, OFFERED instead of typed
  // (operator request): read-only listing through the same hardened gh
  // runner onboarding uses, every identity re-parsed strictly, and each
  // row carries exactly ONE honest action — open (already a project
  // here), add (a clone under a root this server may serve, never yet
  // opened), or the EXISTING preview-and-password clone ceremony.
  // Approver only: a viewer has no business enumerating private
  // repository names.
  async function projectsGithub(ctx: HandlerContext): Promise<void> {
    const { who, response } = ctx;
    if (store.isDemo()) return refuse(response, who, 403, "the sandbox never talks to GitHub");
    // The last listing (docs/plans/get-side-effects.md): List repositories posts; opening the page asks GitHub nothing.
    const listed = lastChecks.known<Awaited<ReturnType<typeof listGithubRepos>>>("github-repos")?.value ?? null;
    // What this machine already has, matched by the clone's own recorded
    // origin — registered projects first, then the immediate children of
    // the configured roots. Identities are compared case-insensitively
    // (GitHub's rule); the FIRST match wins.
    const localByIdentity = new Map<string, string>();
    const registered = new Set<string>();
    for (const project of store.listProjects()) if (visible(project.path)) registered.add(project.path);
    // Roots are walked ONLY when there are listed repos to match against
    // (finding 1), at most 400 folders a root. Every read runs off the
    // console's thread (folder-look.ts): a folder that doesn't answer
    // leaves its copies unmatched and the page says so.
    const roots = listed !== null && listed.ok && listed.repos.length > 0 ? [...ceiling.roots] : [];
    let localUnanswered = false;
    if (registered.size > 0 || roots.length > 0) {
      const looked = await localOrigins([...registered], roots, { ...(options.folderLook === undefined ? {} : { runner: options.folderLook }), ...(options.folderLookMs === undefined ? {} : { deadlineMs: options.folderLookMs }) });
      if (looked.ok) {
        const children = looked.value.found.filter(one => roots.some(root => one.path.startsWith(`${root}/`)));
        for (const one of [...looked.value.registered.filter(row => registered.has(row.path)), ...children]) {
          const identity = githubIdentityOf(one.url ?? "");
          if (identity !== null && !localByIdentity.has(identity.toLowerCase())) localByIdentity.set(identity.toLowerCase(), one.path);
        }
      } else {
        localUnanswered = looked.why === "no-answer";
      }
    }
    return sendScreen(
      response,
      200,
      githubReposPage(chromeFor(who.via === "cookie" ? who.session.project : null, "projects"), {
        listed,
        local: localByIdentity,
        registered,
        cloneReady: ceiling.roots.length > 0,
        openProject: who.via === "cookie" ? who.session.project ?? null : null,
        localUnanswered,
        now: clock(),
      }),
    );
  }

  // List repositories / Refresh list: ask the GitHub CLI signed in on this machine, then show the page.
  async function projectsGithubList(ctx: HandlerContext): Promise<void> {
    const { who, response } = ctx;
    if (store.isDemo()) return refuse(response, who, 403, "the sandbox never talks to GitHub");
    await lastChecks.run("github-repos", () => (options.ghList ?? listGithubRepos)());
    return redirect(response, "/projects/github");
  }
  async function projectsIndex(ctx: HandlerContext): Promise<void> {
    const { url, who, response } = ctx;
    return void projectsScreen(response, who, url.searchParams.get("said"), 200, safeReturn(url.searchParams.get("return")), "said");
  }

  // Home (UI revamp wave B): what needs this person, four counts that agree with the Tasks filters, and the lead's box.
  // A token or a restricted session keeps landing on Tasks; a first run with nothing filed yet keeps its checklist in the chat.
  async function homeRedirect(ctx: HandlerContext): Promise<void> {
    const { who, response, now, project } = ctx;
    if (who.via !== "cookie" || restricted()) return redirect(response, "/tasks");
    if (firstRunStepsNow(now) !== null && !store.hasAnyWork()) return redirect(response, "/chat");
    // One scope for the page and the chrome around it: the project its address names (proved by the router), else all.
    const chrome = chromeFor(project, "none");
    const projects = chrome.projects ?? [];
    const closedDoor = (taskId: string) => {
      const scope = store.getScope(taskId);
      const door = consentDoorOf(scope, runtime.routeViewOf(taskId, store.lookupRef(taskId), scope, now, who));
      return door.open ? null : door;
    };
    const view = { ...homeView({ store, now, access: workAccess(), evidenceRoot, project, projects, chat: chrome.chat === true, canAnswer: who.role === "approver", closedDoor }),
      // Until the first result: the welcome's three steps stay one link away.
      setup: firstRunStepsNow(now) !== null ? "/welcome" : null };
    return sendScreen(response, 200, screen("Home", html`<div data-kit-page><h1>Home</h1><p>${view.say}</p><p><a href="/tasks">Tasks</a></p></div>`, { chrome, workspace: { view } }));
  }

  // Search (UI revamp wave B): the ⌘K menu's "See all results". The places come from the page; the tasks here are the
  // most recent ones in view (live and archived), matched on their title and id. Reads only.
  async function searchPage(ctx: HandlerContext): Promise<void> {
    const { url, response, now } = ctx;
    const q = (url.searchParams.get("q") ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 200);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const access = workAccess();
    const live = workIndexPage(store, now, access, { view: "all", limit: 100, root: evidenceRoot });
    const archived = workIndexPage(store, now, access, { view: "archived", limit: 40, root: evidenceRoot });
    const multi = new Set(live.items.map(one => one.repo ?? "")).size > 1;
    const tasks = words.length === 0 ? [] : [...live.items, ...archived.items]
      .filter(one => words.every(word => `${one.title} ${one.rootId}`.toLowerCase().includes(word)))
      .slice(0, 60)
      .map(one => {
        const waits = one.status.views.includes("needs-you");
        const tone = one.archived !== undefined ? "" as const : waits ? "needs" as const
          : ({ attention: "needs", ready: "needs", live: "live", done: "done", problem: "failed", muted: "", neutral: "" } as const)[one.status.tone];
        return { id: one.rootId, title: one.title, href: taskHref(one.rootId), project: multi || one.repo === null ? (one.repo === null ? "Unplaced" : projectName(one.repo)) : null,
          age: relativeAgeOf(one.archived?.at ?? one.updatedAt, now), chip: { word: one.archived !== undefined ? "Archived" : waits ? "Needs you" : one.status.label, tone }, archived: one.archived !== undefined };
      });
    const view = { kind: "search" as const, q, tasks, truncated: live.nextCursor !== null || archived.nextCursor !== null };
    return sendScreen(response, 200, screen("Search", html`<div data-kit-page><h1>Search</h1><form action="/search"><input type="search" name="q" value="${q}" aria-label="Search"></form></div>`, { chrome: chromeFor(null, "none"), workspace: { view } }));
  }

  // The board's old name; bookmarks keep working. A GET-only alias, so a
  // plain 302 — never the shared 303 helper, which belongs to POST landings.
  async function morningAlias(ctx: HandlerContext): Promise<void> {
    const { response } = ctx;
    response.writeHead(302, { ...SAFETY, Location: "/" });
    response.end();
    return;
  }


  async function ledgerPage(ctx: HandlerContext): Promise<void> {
    const { url, who, response, now } = ctx;
    const admitted = admissionList();
    const projects = admitted ?? consoleProjects();
    const chosen = url.searchParams.get("project") ?? "";
    if (chosen !== "" && !projects.includes(chosen)) return refuse(response, who, 403, "That project is outside your access.", "/ledger");
    const before = url.searchParams.get("before");
    if (before !== null && (!/^[1-9][0-9]{0,14}$/.test(before) || !Number.isSafeInteger(Number(before)))) return refuse(response, who, 400, "Invalid ledger cursor.", "/ledger");
    // Events that belong to no project (sign-ins, accounts, installation policy) are an instance operator's to read.
    const query = { repos: chosen === "" ? admitted : [chosen], instance: chosen === "" && store.isInstanceOperator(who.name),
      actor: (url.searchParams.get("actor") ?? "").slice(0, 200), outcome: (url.searchParams.get("outcome") ?? "").slice(0, 100),
      source: url.searchParams.get("source") ?? "", taskId: (url.searchParams.get("task") ?? "").slice(0, 200) };
    if (url.searchParams.get("format") === "csv") {
      const generation = store.accountOf(who.name)?.generation;
      // Descending immutable IDs pin the export at its first read; later
      // arrivals cannot duplicate or extend it. Yield between bounded pages
      // and honor backpressure/disconnects, so exports cannot fill memory.
      const first = store.actionLedger({ ...query, limit: 100 });
      async function* chunks() {
        yield LEDGER_CSV_HEADER;
        let page = first;
        while (page.length > 0) {
          const current = store.accountOf(who.name);
          if (current === null || current.revokedAt !== null || current.generation !== generation ||
              page.some(row => !visible(row.repo))) throw new Error("Ledger access changed during export");
          yield ledgerCsvRows(page);
          const cursor = page.at(-1)!.id;
          await yieldEventLoop();
          const next = store.actionLedger({ ...query, before: cursor, limit: 100 });
          // Pages only ever move to older entries; one that doesn't is the end.
          page = next.length > 0 && next[0]!.id < cursor ? next : [];
        }
      }
      response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="standing-orders-actions.csv"', "cache-control": "no-store", "x-content-type-options": "nosniff" });
      try { await pipeline(Readable.from(chunks()), response); }
      catch { response.destroy(); }
      return;
    }
    // v103: the chain is sealed and checked before it's shown; an operator sees the checkpoint to copy off the machine.
    const report = store.ledgerChain();
    const operator = who.via === "cookie" && store.isInstanceOperator(who.name);
    const latest = store.ledgerCheckpoints(1)[0] ?? null;
    const chainView = { ok: report.ok, entries: report.entries, through: report.through, head: report.head, unsealed: report.unsealed, problem: report.problem, checkedAt: report.checkedAt,
      latest: operator && latest !== null ? latest : null, csrf: operator ? who.session.csrf : null, today: now.toISOString().slice(0, 10) };
    const rows = store.actionLedger({ ...query, ...(before === null ? {} : { before: Number(before) }), limit: 51 });
    if (url.searchParams.get("format") === "json") return respond(response, 200, "application/json; charset=utf-8", JSON.stringify(checkResponse("ledgerPage", { chain: { ok: report.ok, entries: report.entries, through: report.through, head: report.head, problem: report.problem }, entries: rows.slice(0, 50), nextBefore: rows.length > 50 ? rows[49]!.id : null })));
    return sendScreen(response, 200, screen("Audit log", ledgerBody(rows, projects, url.searchParams, chainView), { chrome: chromeFor(chosen === "" ? null : chosen, "ledger", undefined, chosen === "" ? "all" : "project") }));
  }

  // The activity summary lives on Home now (UI revamp wave B); the old address keeps answering, as a GET alias.
  async function activityPage(ctx: HandlerContext): Promise<void> {
    const { response } = ctx;
    response.writeHead(302, { ...SAFETY, Location: "/" });
    response.end();
    return;
  }

  // A GET-only alias, a plain 302 (like morningAlias): an old address lands on the part of Agents that took it over.
  const aliasTo = (location: string) => async (ctx: HandlerContext): Promise<void> => {
    ctx.response.writeHead(302, { ...SAFETY, Location: location });
    ctx.response.end();
  };
  // System became part of Agents (UI revamp wave B): the model per phase and the computers that build.
  const systemScreen = aliasTo("/agents#models");
  // Terminals live on their own page (/term, its own bundle); the Agents area's address for them leads there.
  const agentsTerminals = aliasTo("/term");

  // Peek became the Agents board: one place to check on every running agent (agents-board.ts).
  async function peekPage(ctx: HandlerContext): Promise<void> {
    return redirect(ctx.response, "/agents");
  }

  /** What the board says after a Reply or a steer, in fixed words (never text from the address). */
  const AGENT_SAID: Record<string, { tone: "info" | "error"; text: string }> = {
    replied: { tone: "info", text: "Reply sent. The agent reads it at its next check." },
    steered: { tone: "info", text: "Note sent. It shows in the conversation with whether the agent has read it." },
    "steer-ended": { tone: "error", text: "That attempt ended before your note, so nothing was sent. Your note is kept below." },
    "steered-next": { tone: "info", text: "Note sent. The task's next attempt reads it before starting." },
    "steer-next-finished": { tone: "error", text: "This task is finished, so there's no next attempt to send it to. Your note is kept below." },
    "steer-invalid": { tone: "error", text: "That note will not store. Your note is still in the box." },
    "steer-stale": { tone: "error", text: "That form was already used. Your note is still in the box — send it again." },
    "reply-closed": { tone: "error", text: "That question was already answered." },
    "reply-stale": { tone: "error", text: "This attempt ended before your reply, so nothing was sent." },
    "reply-invalid": { tone: "error", text: "Write a reply of up to 1,500 characters." },
    "steer-no-notes": { tone: "error", text: "This agent takes no notes right now, so nothing was sent. Stop it to change its course." },
    stopping: { tone: "info", text: "Stopping. The work so far is kept." },
    pausing: { tone: "info", text: "Pausing. It stops at the end of its current step." },
    "pausing-with-note": { tone: "info", text: "Pausing. Your note goes to it as soon as it stops." },
    "pause-note-stale": { tone: "error", text: "That form was already used, so your note was not sent. It is still in the box — send it again." },
    resuming: { tone: "info", text: "Resuming. It carries on where it stopped." },
    revealed: { tone: "info", text: "Shown in Finder." },
    "reveal-refused": { tone: "error", text: "That checkout couldn't be shown: it isn't this attempt's running checkout on this computer any more." },
    "reveal-mac-only": { tone: "error", text: "Show in Finder works on a Mac. Copy the command instead." },
    "reveal-failed": { tone: "error", text: "Finder didn't show it. The path is above; copy the command instead." },
  };

  /**
   * The opened agent's head (docs/plans/one-page-task-and-agent.md): its task's status in the task page's own words and
   * that status's one action as a link to the task page tab holding its form, and where this run opens there — a
   * result (the shared predicate: a finished builder or scout run) on the Result tab at this run, a plan on the Plan
   * tab, anything else on its record.
   */
  function agentTaskHeadOf(taskId: string, runId: number, live: boolean, access: ReturnType<typeof workAccess>, now: Date): Pick<BrowserAgentDetail, "task" | "open"> {
    const family = store.taskFamilyOf(taskId, access.repos, access.includeUnplaced);
    const root = family?.root.id ?? taskId;
    const versionOf = (id: string): string => family !== null && id !== family.current.id ? `version=${encodeURIComponent(id)}&` : "";
    const run = store.getRun(runId);
    const open = live || run === null ? null
      : run.finishedAt !== null && (run.role === "builder" || run.role === "scout") ? { label: run.role === "scout" ? "Report" : "Result", href: `${taskHref(root)}?${versionOf(taskId)}tab=result&run=${runId}` }
      : run.role === "planner" ? { label: "Plan", href: `${taskHref(root)}?${versionOf(taskId)}tab=plan` }
      : { label: "Record", href: `/r/${runId}?record=1` };
    let task: BrowserAgentDetail["task"] = null;
    try {
      const assignment = family === null ? null : assignmentOf(store, family.current.id, now, access, evidenceRoot);
      if (assignment !== null) {
        const words = assignmentTaskStatusOf(assignment);
        const wants = words.primaryAction?.href ?? "";
        // A result to review is on the Result tab; everything else the task page heads with (the approval, a retry…).
        const href = /^\/review\?result=|[?&]result=/.test(wants) ? `${taskHref(root)}?tab=result` : taskHref(root);
        task = { headline: words.headline, sentence: words.sentence, tone: words.tone, action: { label: words.primaryAction?.label ?? "Open task", href } };
      }
    } catch { task = null; }
    return { task, open };
  }

  /** After a retire: fixed words naming a computer the store knows as retired (never text from the address). */
  function retiredSaid(name: string | null): NonNullable<BrowserAgentsView["computerSaid"]> | null {
    if (name === null) return null;
    const known = store.listRunners().find(one => one.name === name && one.retiredAt !== null);
    return known === undefined ? null : { tone: "info", text: `${known.name} is retired. It takes no more work; tasks reserved for it wait until you move them.` };
  }

  // The Agents board (one place to check on running agents): rows by state, and the opened agent's live view.
  async function agentsPage(ctx: HandlerContext): Promise<void> {
    const { url, who, response, project } = ctx;
    const now = clock();
    const access = workAccess();
    const asked = url.searchParams.get("run");
    // The Live grid only watches (docs/plans/agents-view.md §3): it branches off before an opened agent is built, so
    // viewing it never marks a run seen, takes a watch or offers a composer — a reload of ?view=live&run=… included.
    const watching = url.searchParams.get("view") === "live";
    // Live is a browser session's only, like its reads (no token sees the grid).
    if (watching && who.via !== "cookie") return respond(response, 403, "text/plain; charset=utf-8", "The Live view is for a signed-in browser.");
    let selected: BrowserAgentDetail | null = null;
    if (!watching && asked !== null && /^[1-9][0-9]{0,9}$/.test(asked)) {
      const run = store.getRun(Number(asked));
      const facts = run === null || !runVisible(run) ? null : agentFactsFor(store, run.id, access, who.name);
      if (facts !== null) {
        // Opening a finished agent is viewing it: the shell says so with a keyed POST /agents/seen (easy-start N1: a page
        // load never writes), which leaves this person's unread Done.
        const live = facts.outcome === null;
        const composer = live ? steerControlsFor(store, facts.taskId, facts.runId, now, who.role === "approver") : null;
        const sealed = live ? null : sealedDiffOf(store, evidenceRoot, facts.runId);
        // A reply's own word first; otherwise the note that the agent asked past the questions cap.
        const said = AGENT_SAID[url.searchParams.get("said") ?? ""] ?? (facts.questionNote === null ? null : { tone: "info" as const, text: facts.questionNote });
        selected = {
          ...agentRowOf(store, facts, now, evidenceRoot), live,
          question: live && facts.question !== null ? { ...facts.question, action: `${taskHref(facts.taskId)}/reply` } : null,
          // The conversation's window: its notes answer anywhere; its transcript only from the machine that runs it (the window says so).
          transcript: `/r/${facts.runId}?fragment=transcript&shape=records`,
          // The live look at its checkout needs this machine's runner — the one running it — and pool, as the run page's does.
          peek: live && options.localRunner !== undefined && run!.runner === options.localRunner && options.poolRoot !== undefined ? `/r/${facts.runId}?fragment=peek` : null,
          files: (sealed?.files ?? []).slice(0, 30).map(one => ({ path: one.path, added: one.additions, removed: one.deletions })),
          filesMore: Math.max(0, (sealed?.fileCount ?? 0) - 30),
          // A note goes only to an attempt that reads notes (steer-controls.ts); the composer says what it takes.
          steer: composer?.steer ?? null,
          controls: composer?.controls ?? null,
          checkout: (() => {
            if (!live || who.role !== "approver" || store.isDemo()) return null;
            const proof = localCheckoutOf(store, facts.runId, { runner: options.localRunner, poolRoot: options.poolRoot }, now);
            // Show in Finder only where it can work (a Mac); elsewhere the path and the command stand alone.
            return proof.ok ? { path: proof.path, cd: cdCommandOf(proof.path), reveal: canReveal(options.revealPath !== undefined) ? `/r/${facts.runId}/reveal` : null } : null;
          })(),
          canAct: who.role === "approver" && !store.isDemo(),
          taskHref: taskHref(facts.taskId),
          // The run's own address: a finished result opens on its result page, anything else on its record.
          resultHref: live ? null : `/r/${facts.runId}`,
          ...agentTaskHeadOf(facts.taskId, facts.runId, live, access, now),
          room: `agent:${facts.runId}`, said,
        };
      }
    }
    // The Live grid is drawn in the browser from its own read-only reads (agents-live-view.tsx): no board facts here.
    if (watching) {
      const view: BrowserAgentsView = { kind: "agents", groups: [], selected: null, lanes: null, empty: null, live: true };
      return sendScreen(response, 200, screen("Agents", html`<h1>Agents</h1><p class="meta">Live needs JavaScript.</p>`, { chrome: chromeFor(project, "runs"), workspace: { view } }));
    }
    const groups = agentsListOf(store, now, access, who.name, evidenceRoot);
    // The installation's parts (what /fleet and /system showed) are for a person with access to all of it, as those
    // pages were; a project-limited person sees their own agents only.
    const installation = !restricted();
    const windowAsked = url.searchParams.get("window");
    const view: BrowserAgentsView = { kind: "agents", groups, selected, lanes: null,
      empty: groups.length === 0 ? "No agents in the last day. They show here the moment one starts." : null,
      window: windowAsked === "30m" || windowAsked === "2h" ? windowAsked : "24h",
      ...(selected !== null || !installation ? {} : {
        computers: computersOf(store, now, visible, who.via === "cookie" && who.role === "approver" && !store.isDemo()),
        phases: phasesOf(store, project),
        system: systemOf(store, project, one => project === null || one.repo === project || identities.hot(one.repo) === identities.hot(project), visible),
        computerSaid: retiredSaid(url.searchParams.get("retired")),
      }),
      terminals: who.via === "cookie" && who.role === "approver" && !store.isDemo() && store.isInstanceOperator(who.name) };
    const fallback = joinHtml([
      html`<h1>Agents</h1>`,
      groups.length === 0 ? html`<p class="meta">${view.empty ?? ""}</p>` : joinHtml(groups.map(group => joinHtml([
        html`<h2>${group.label}</h2>`,
        ...group.rows.map(row => html`<p class="row"><a href="${row.href}"><strong>${row.title}</strong></a> <span class="meta">${[row.label, row.line].filter(Boolean).join(" \u00b7 ")}</span></p>`),
      ], "\n")), "\n"),
    ], "\n");
    // The list reads itself while something builds, as /system did (forms being edited are kept); an opened agent
    // follows its own room instead.
    const refreshSeconds = selected !== null ? undefined : store.liveClaims(null, now).length > 0 ? 10 : installation ? 60 : undefined;
    return sendScreen(response, 200, screen("Agents", fallback, { chrome: chromeFor(project, "runs"), workspace: { view }, ...(refreshSeconds === undefined ? {} : { refreshSeconds }) }));
  }

  // Fleet became the computers on Agents (UI revamp wave B): register, retire, reserved work and notes are there.
  const fleetPage = aliasTo("/agents#computers");

  async function ledgerExport(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, now } = ctx;
    const from = exportDay(url.searchParams.get("from")), last = exportDay(url.searchParams.get("to"));
    if (from === null || last === null) return refuse(response, who, 400, "Choose a start and end day.", "/ledger");
    const to = new Date(Date.parse(last) + 86_400_000).toISOString();
    if (to <= from || Date.parse(to) - Date.parse(from) > 366 * 86_400_000) return refuse(response, who, 400, "Choose a range of a year or less, ending on or after its start.", "/ledger");
    const access = workAccess();
    store.recordAction({ at: now.toISOString(), actor: who.name, repo: null, taskId: null, runId: null, action: "ledger exported", outcome: "exported", source: "access",
      detail: `${from.slice(0, 10)} to ${last.slice(0, 10)}` });
    // A piece at a time (a page of entries, or one pack), yielding between them, and stopping if the reader's access
    // changes: their account, and the session or API token they came with (read without writing anything).
    const generation = store.accountOf(who.name)?.generation;
    const tokenId = who.via === "bearer" && who.token !== undefined ? parseApiToken(/^Bearer (so_\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "")?.id ?? null : null;
    const stillLive = () => {
      const current = store.accountOf(who.name);
      if (current === null || current.revokedAt !== null || current.generation !== generation) return false;
      if (who.via === "cookie") return identify(request, false)?.name === who.name;
      if (tokenId === null) return true;
      const token = store.apiTokenSecret(tokenId)?.row;
      return token !== undefined && tokenLive(token, Date.now());
    };
    // The whole walk it starts from is shared by exports in the same minute; a reader who stops reading for a minute is let go.
    const pieces = ledgerExportChunks(store, { from, to }, { repos: access.repos, instance: store.isInstanceOperator(who.name) }, access, who.name, now, evidenceRoot);
    async function* chunks() {
      for (const piece of pieces) {
        if (!stillLive()) throw new Error("Ledger access changed during export");
        yield piece;
        await yieldEventLoop();
      }
    }
    response.setTimeout(60_000, () => response.destroy());
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="standing-orders-audit-${from.slice(0, 10)}-to-${last.slice(0, 10)}.json"`,
      "cache-control": "no-store", "x-content-type-options": "nosniff" });
    try { await pipeline(Readable.from(chunks()), response); }
    catch { response.destroy(); }
    return;
  }

  async function menuPage(ctx: HandlerContext): Promise<void> {
    const { response, project } = ctx;
    // The phone's overflow drawer as an honest page: every destination
    // the tab bar does not carry, one tap away, no JavaScript — grouped
    // under the same workflows/admin headings as the rail's accordion,
    // with settings last, outside both.
    const chrome = chromeFor(project, "menu");
    const section = (label: string, rows: NavRow[]): Html =>
      html`<h2 class="menu-group-label">${label}</h2><div class="menu-list">${joinHtml(rows.map(row => html`<a class="menu-row" href="${row.href}"><strong>${row.label}</strong><span class="meta">${row.hint}</span></a>`), "\n")}</div>`;
    return sendScreen(response, 200, screen("Workspace tools", joinHtml([
      section("Work tools", workToolRows(chrome.projectScoped, chrome.chat, chrome.code)),
      section("Settings", settingsRows(chrome.projectScoped, chrome.settings)),
    ], "\n"), { chrome }));
  }

  async function capsScreen(ctx: HandlerContext): Promise<void> {
    const { response, now, project } = ctx;
    if (project === null) {
      return sendScreen(response, 200, capsPage(chromeFor(project, "caps"), null, [], ""));
    }
    return sendScreen(
      response,
      200,
      capsPage(chromeFor(project, "caps"), store.listCapabilities(project), computeGaps(store, project, now), project, now),
    );
  }

  async function health(ctx: HandlerContext): Promise<void> {
    const { request, response } = ctx;
    const health = store.telemetry.snapshot();
    // Beside /healthz, for an instance operator: where the slowest recent console answers spent their time (route ids
    // and milestones only).
    const slow = slowRequestLines(store);
    return request.headers.accept?.includes('application/json')
      ? respond(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ...health, slowRequests: slow }))
      : respond(response, 200, 'text/plain; charset=utf-8', `${healthWords(health)}\n${slow.length === 0 ? "" : `\nSlow console requests (over ${SLOW_REQUEST_MS} ms), newest first:\n${slow.join("\n")}\n`}`);
  }

  // v104: Prometheus metrics, for an instance operator (a scraper sends one's API token).
  async function metrics(ctx: HandlerContext): Promise<void> {
    const { response, now } = ctx;
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    const set = options.configDir === undefined ? null : readMonitoring(options.configDir);
    const destinations = new Map<string, string>([
      ...(set?.webhook ? [["webhook", targetOf(set.webhook.url)] as [string, string]] : []),
      ...(set?.folder ? [["folder", targetOf(set.folder.path)] as [string, string]] : []),
      ...(set?.traces ? [["traces", targetOf(set.traces.endpoint)] as [string, string]] : []),
    ]);
    return void response.end(prometheusMetrics(store, now, admissionList(), destinations));
  }

  async function ledgerCheckpoint(ctx: HandlerContext): Promise<void> {
    const { who, response, now } = ctx;
    const made = store.ledgerCheckpoint(who.name, now);
    if (made !== null && "problem" in made) return refuse(response, who, 409, `No checkpoint was made: the chain doesn't verify (${made.problem}).`, "/ledger");
    return redirect(response, made === null ? "/ledger" : `/ledger?checkpoint=${made.through}`);
  }

  async function projectsSelect(ctx: HandlerContext): Promise<void> {
    const { who, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.projectsSelect);
    // Session-only project switching (E2): reads the registry, writes
    // ONLY session.project — the durable upsert lives in /projects/open,
    // which stays an approver's act. This is the one project verb a
    // viewer may use.
    if (who.via !== "cookie") {
      return refuse(response, who, 403, "selecting a project is a browser session's act");
    }
    const askedPath = (body.get("path") ?? "").trim();
    // Resolved off the console's thread (project-identity.ts): a folder that doesn't answer is said, never waited on.
    const decidedOn = identities.generation();
    const picked = askedPath === "" ? null : await identities.resolveNow(askedPath);
    if (picked === "no-answer") return refuse(response, who, 503, "That project's folder didn't answer. It may be on a drive that's disconnected, or waiting on macOS. Try again in a moment.");
    const canonicalPick = picked;
    if ((askedPath !== "" && canonicalPick === null) || (canonicalPick !== null && (!visible(canonicalPick) || !(await authorizedProject(liveCeiling(), canonicalPick))))) {
      return refuse(response, who, 403, "that project is outside this console's reach");
    }
    // An identity that changed during the awaits above undoes what they proved.
    if (identities.generation() !== decidedOn) return refuse(response, who, 409, "a project folder changed while this was being checked — try again");
    who.session.project = canonicalPick;
    who.session.projectRevision += 1;
    sessions.persist(who.session);
    return redirect(response, safeReturn(body.get("return")));
  }

  async function projectsRemove(ctx: HandlerContext): Promise<void> {
    const { who, response, posted, now } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.projectsRemove);
    // The reversible remove: off every list and the builder; tasks, results and settings stay. Deleting is
    // Settings → Project → Delete project. The same admission code as `repos remove` (project-admission.ts).
    const repo = body.get("repo") ?? "";
    if (!consoleProjects().includes(repo)) return refuse(response, who, 403, "That project is outside your access.", "/settings/project");
    const released = await releaseProject(store, { registryFile: options.registryPath ?? null, path: repo, actor: { label: who.name, origin: "console" }, now });
    if (!released.ok) return redirect(response, `/settings/project?repo=${encodeURIComponent(repo)}&problem=${encodeURIComponent(`${projectName(repo)} wasn't removed: ${released.message}`)}`);
    deletedRepos.add(repo);
    if (who.via === "cookie" && who.session.project === repo) { who.session.project = null; who.session.projectRevision += 1; sessions.persist(who.session); }
    return redirect(response, `/settings/project?said=${encodeURIComponent(`Removed ${projectName(repo)}. Its tasks and results stay saved.`)}`);
  }

  async function projectsOpen(ctx: HandlerContext): Promise<void> {
    const { who, response, posted, now } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.projectsOpen);
    // Sessions only: a bearer caller names its project per request and has
    // no session to mutate — refusing here keeps that boundary legible.
    if (who.via !== "cookie") {
      return refuse(response, who, 403, "opening a project is a browser session's act");
    }
    const asked = (body.get("path") ?? "").trim();
    const decidedOn = identities.generation();
    const resolved = asked === "" ? null : await identities.resolveNow(asked);
    if (resolved === "no-answer") {
      return void projectsScreen(response, who, "that folder didn't answer — it may be on a drive that's disconnected, or waiting on macOS; try again in a moment", 503, safeReturn(body.get("return")), "open");
    }
    const canonical = resolved;
    if (canonical === null) {
      return void projectsScreen(response, who, "that path does not exist on this server", 400, safeReturn(body.get("return")), "open");
    }
    // Authorization is the ceiling, then the path must actually be a git
    // repository — validation with direct argv and a bound, never a shell.
    // Both checks apply even to configured repos: naming a directory in
    // config authorizes it; only being a repository makes it openable.
    if (!(await authorizedProject(liveCeiling(), canonical))) {
      return void projectsScreen(response, who, "that path is outside what this server was configured to serve", 403, safeReturn(body.get("return")), "open");
    }
    if (!(await isGitRepo(canonical))) {
      return void projectsScreen(response, who, "that path is not a git repository", 400, safeReturn(body.get("return")), "open");
    }
    // An account limited to listed projects never widens its own list.
    if (!visible(canonical)) {
      return void projectsScreen(response, who, "That project is outside your access.", 403, safeReturn(body.get("return")), "open");
    }
    // An identity that changed during the awaits above undoes what they proved.
    if (identities.generation() !== decidedOn) return void projectsScreen(response, who, "a project folder changed while this was being checked — try again", 409, safeReturn(body.get("return")), "open");
    // Opening an allowed repository admits it the same way `repos add` does
    // (project-admission.ts). A co-located `up` notices the durable list and
    // connects its builder; there is no separate restart or binding step.
    // The admission asks again, inside its registry lock and its transaction, about the repo it proves.
    const stillAllowed = (repo: string): boolean => identities.generation() === decidedOn && visible(repo);
    const admitted = await admitProject(store, { registryFile: options.registryPath ?? null, path: canonical, actor: { label: who.name, origin: "console" }, now, stillAllowed, resolveFolder: identities.resolveNow });
    if (!admitted.ok) {
      return void projectsScreen(response, who, admitted.reason === "not-git" ? "that path is not a git repository" : `that project is valid, but it could not be added — ${admitted.message}`, admitted.reason === "moved" ? 409 : 400, safeReturn(body.get("return")), "open");
    }
    // And once more before the session follows it.
    if (!stillAllowed(admitted.repo)) return void projectsScreen(response, who, "a project folder changed while this was being checked — try again", 409, safeReturn(body.get("return")), "open");
    deletedRepos.delete(admitted.repo);
    who.session.project = admitted.repo;
    who.session.projectRevision++;
    // The switcher (board pass) opens a project from any screen and
    // returns there — a same-site path only, never an off-site road.
    return redirect(response, safeReturn(body.get("return")));
  }

  // Runner lifecycle, brought in from the terminal behind the same
  // password step-up the console uses for every other credential-grade
  // act. Register mints a token that is shown ONCE and stored only as a
  // hash — the page that shows it renders no self-refreshing script, so
  // the token is never re-rendered.
  async function fleetRegister(ctx: HandlerContext): Promise<void> {
    const { who, request, response, posted, now } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.runnerRegister);
    if (who.via !== "cookie") return refuse(response, who, 403, "runner registration is a browser surface");
    const token = body.get("token") ?? "";
    // A worker credential is minted here: a credential act, a password typed now even with Passwordless on.
    if (!authenticateCredential(who, token).ok) {
      return refuse(response, who, 403, "registering a worker takes your password, typed again", "/agents#computers");
    }
    const name = (body.get("name") ?? "").trim();
    if (name === "" || name.length > 60 || /[\r\n\t]/.test(name) || hasForbiddenControls(name)) {
      return refuse(response, who, 400, "a worker's name is one short line, no control characters", "/agents#computers");
    }
    const capacity = Number((body.get("capacity") ?? "1").trim() || "1");
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64) {
      return refuse(response, who, 400, "capacity is a whole number of tasks, 1 to 64", "/agents#computers");
    }
    const { token: minted } = registerRunner(store, { name, host: hostname(), capacity, now });
    // A kit reading page (UI revamp wave B), back to the computers on Agents. The token is text to select: a Copy
    // button would need a script, and this page carries none.
    const tokenScreen = screen(
      "fleet",
      html`<div data-kit-page>${kit.phoneHeader("Computer registered", { back: "/agents#computers" })}${kit.doc(
        kit.docHeader({ title: `${name} is registered`, back: ["/agents#computers", "Agents"], same: true, meta: html`Takes up to ${capacity} ${capacity === 1 ? "task" : "tasks"} at a time` }),
        kit.slots({
          status: html`<h2>Its token, shown once</h2>`,
          text: "Only a hash is kept, so copy it now.",
          acts: html`<code class="k-code" data-runner-token>${minted}</code>`,
          terms: "Keep it beside the computer, in a file only you can read (0600) or a secrets manager. If it's lost, register the name again; its old claims are taken back.",
        }),
        kit.acts(kit.btn("Back to Agents", { href: "/agents#computers" })),
      )}</div>`,
      // A one-time secret on screen: no script of any kind rides along.
      { chrome: chromeFor(projectOf(who, request) ?? null, "fleet"), forceSensitive: true },
    );
    return sendScreen(response, 200, tokenScreen);
  }

  async function fleetRetire(ctx: HandlerContext): Promise<void> {
    const { who, response, posted, now } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.runnerRetire);
    if (who.via !== "cookie") return refuse(response, who, 403, "runner retirement is a browser surface");
    const token = body.get("token") ?? "";
    if (!authenticateApprover(who, token).ok) {
      return refuse(response, who, 403, "retiring a worker takes your password, typed again", "/agents#computers");
    }
    const name = (body.get("name") ?? "").trim();
    const retired = store.retireRunner(name, now);
    if (!retired) return refuse(response, who, 404, `no worker \`${name}\``, "/agents#computers");
    // Agents says it in fixed words, naming the computer only once the store knows it as retired (retiredSaid).
    return redirect(response, `/agents?retired=${encodeURIComponent(name)}#computers`);
  }

  async function onboardPreview(ctx: HandlerContext): Promise<void> {
    const { who, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.onboard);
    // Repo onboarding (findings 1-39): bearer and demo refuse BEFORE any
    // gh call; the console flow exists only on root-configured serves.
    if (who.via !== "cookie") return refuse(response, who, 403, "adding repositories is a browser session's act");
    if (store.isDemo()) return refuse(response, who, 403, "the sandbox never clones");
    if (process.platform === "win32") return refuse(response, who, 403, "adding from GitHub is not supported on Windows yet");
    if (ceiling.roots.length === 0) return projectsScreen(response, who, "naming where repositories live takes --project-root", 400, "/", "link");
    const shape = parseGithubRepo(body.get("repo") ?? "");
    if (!shape.ok) return projectsScreen(response, who, shape.problem, 400, "/", "link");
    // Roots by INDEX (finding 13) — a posted path is never accepted.
    const rootIndex = Number(body.get("root") ?? "0");
    const rootRaw = Number.isInteger(rootIndex) ? ceiling.roots[rootIndex] : undefined;
    if (rootRaw === undefined) return projectsScreen(response, who, "pick one of the configured roots", 400, "/", "link");
    const root = await identities.resolveNow(rootRaw);
    if (root === null || root === "no-answer") return projectsScreen(response, who, "that projects root does not resolve right now", 400, "/", "link");
    const previewed = await (options.ghPreview ?? previewGithubRepo)(shape.owner, shape.name);
    if (!previewed.ok) return projectsScreen(response, who, previewed.message, 400, "/", "link");
    const reparsed = parseGithubRepo(previewed.preview.nameWithOwner);
    if (!reparsed.ok) return projectsScreen(response, who, "GitHub named a repository shape this console refuses", 400, "/", "link");
    // The hook boundary is NORMALIZED like the real preview would be
    // (verification finding 2): a size that is not a nonnegative finite
    // number is unknown, and unknown is LARGE.
    const diskUsageKib =
      typeof previewed.preview.diskUsageKib === "number" && Number.isFinite(previewed.preview.diskUsageKib) && previewed.preview.diskUsageKib >= 0
        ? previewed.preview.diskUsageKib
        : null;
    const target = join(root, reparsed.name);
    if (dirname(target) !== root) return projectsScreen(response, who, "the target escaped its root — refused", 400, "/", "link");
    // The session-held record (finding 14): swept at mint, capped 3.
    const session = who.session;
    session.onboard ??= new Map();
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, record] of session.onboard) if (record.mintedAt < cutoff) session.onboard.delete(key);
    if (session.onboard.size >= 3) return projectsScreen(response, who, "three previews are already waiting — confirm or let one expire", 400, "/", "link");
    const nonce = randomBytes(16).toString("hex");
    session.onboard.set(nonce, {
      nameWithOwner: previewed.preview.nameWithOwner,
      rootIndex,
      target,
      diskUsageKib,
      large: isLargeRepo({ ...previewed.preview, diskUsageKib }),
      mintedAt: Date.now(),
    });
    return projectsScreen(response, who, null, 200, "/", "link");
  }

  async function onboardConfirm(ctx: HandlerContext): Promise<void> {
    const { who, request, response, posted, now } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.onboard);
    // Repo onboarding (findings 1-39): bearer and demo refuse BEFORE any
    // gh call; the console flow exists only on root-configured serves.
    if (who.via !== "cookie") return refuse(response, who, 403, "adding repositories is a browser session's act");
    if (store.isDemo()) return refuse(response, who, 403, "the sandbox never clones");
    if (process.platform === "win32") return refuse(response, who, 403, "adding from GitHub is not supported on Windows yet");
    if (ceiling.roots.length === 0) return projectsScreen(response, who, "naming where repositories live takes --project-root", 400, "/", "clone");

    // CONFIRM: password, then session liveness AGAIN via lookupSession
    // (finding 22/33) — the record is consumed from the RETURNED live
    // session, synchronously, before the first await. A full session types
    // its password (or Passwordless stands in); a laptop's local owner has
    // none: inside this row's add-project admission the prover's local-owner
    // branch proves it (scope.ts proveAccountNow), whatever the field holds.
    const password = body.get("token") ?? "";
    if (!authenticateApprover(who, password).ok) {
      return projectsScreen(response, who, "cloning takes your password, typed again", 403, "/", "clone");
    }
    const cookieId = /(?:^|;\s*)standing-orders_session=([0-9a-f]{64})/.exec(request.headers.cookie ?? "")?.[1];
    const live = cookieId === undefined ? null : lookupSession(cookieId, false);
    if (live === null) return refuse(response, who, 403, "this session ended while the form was open — sign in again");
    const nonce = body.get("nonce") ?? "";
    const record = live.onboard?.get(nonce);
    if (record === undefined || record.mintedAt < Date.now() - 10 * 60_000) {
      live.onboard?.delete(nonce);
      return projectsScreen(response, who, "that preview expired or was already used — preview again", 400, "/", "clone");
    }
    live.onboard?.delete(nonce); // consumed BEFORE the first await
    // Identities as this confirmation found them: the admission below re-checks against them (project-identity.ts).
    const decidedOn = identities.generation();
    if (record.large && body.get("big-ok") !== "1") {
      return projectsScreen(response, who, "that repository is large (or its size is unknown) — tick the box to clone it anyway", 400, "/", "clone");
    }
    const rootRaw = ceiling.roots[record.rootIndex];
    if (rootRaw === undefined) return projectsScreen(response, who, "the configured roots changed — preview again", 400, "/", "clone");
    const root = await identities.resolveNow(rootRaw);
    if (root === null || root === "no-answer") return projectsScreen(response, who, "that projects root does not resolve right now", 400, "/", "clone");
    if (dirname(record.target) !== root) return projectsScreen(response, who, "the configured roots changed — preview again", 400, "/", "clone");

    const cloned = await (options.ghClone ?? cloneGithubRepo)(record.nameWithOwner, root, async (cwd: string) => {
      const answer = await execRun("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 15_000 });
      return { code: answer.code, stdout: answer.stdout };
    });
    if (!cloned.ok) return projectsScreen(response, who, cloned.message, 400, "/", "clone");
    // The clone answer is BOUND to the record's exact target (verification
    // finding 2): whatever produced it — the real primitive or a test
    // hook — an answer naming any other path never enrolls or opens.
    if (cloned.target !== record.target) {
      return projectsScreen(response, who, "the clone answered with a different path than the preview promised — refused; nothing was enrolled", 400, "/", "clone");
    }
    // authorizedProject AFTER the repository exists (finding 20).
    const clonedAt = await identities.resolveNow(cloned.target);
    const admitted = typeof clonedAt === "string" && clonedAt !== "no-answer" && (await authorizedProject(liveCeiling(), clonedAt)) ? clonedAt : null;
    if (admitted === null) {
      return projectsScreen(response, who, `the clone landed at ${cloned.target} but did not prove under the ceiling — it was left in place; enroll it by hand`, 400, "/", "clone");
    }
    const stillAllowed = (repo: string): boolean => identities.generation() === decidedOn && visible(repo);
    const joined = await admitProject(store, { registryFile: options.registryPath ?? null, path: admitted, actor: { label: who.name, origin: "console" }, now, stillAllowed, resolveFolder: identities.resolveNow });
    if (!joined.ok) {
      return projectsScreen(response, who, `${cloned.target} is cloned but not added — ${joined.message}`, joined.reason === "moved" ? 409 : 400, "/", "clone");
    }
    if (!stillAllowed(joined.repo)) return projectsScreen(response, who, `${cloned.target} is cloned but wasn't opened — a project folder changed while it was being checked; try again`, 409, "/", "clone");
    deletedRepos.delete(admitted);
    who.session.project = admitted;
    who.session.projectRevision += 1;
    return projectsScreen(
      response,
      who,
      options.upConsole === true
        ? `${projectName(admitted)} is ready — the builder is connecting automatically`
        : `${admitted} is ready and open`,
      200,
      "/",
      "said",
    );
  }


  /**
   * The opener: every project inside the ceiling, most recently opened
   * first, plus repos the queue has seen — shown only when the ceiling
   * admits them — and an open-by-path field validated server-side. A
   * registry row never confers access; this page only offers what the
   * server was configured to allow.
   */
  /** The projects this person may open: the registered ones they can see, most recently opened first, then the
   * configured ones the queue has seen. A registry row never confers access. */
  function visibleProjects(): { recent: { path: string; name: string; lastOpenedAt: string }[]; candidates: string[] } {
    const recent = store.listProjects().filter(one => visible(one.path));
    const recentPaths = new Set(recent.map(one => one.path));
    const candidates = new Set<string>();
    for (const path of consoleProjects()) {
      const canonical = identities.hot(path);
      if (!recentPaths.has(canonical) && visible(canonical)) candidates.add(canonical);
    }
    return { recent, candidates: [...candidates] };
  }
  /** A cheap peek per project: one small set of COUNTs, scoped to the exact repo. */
  function peekOf(path: string, now: Date): ProjectPeek | null {
    try {
      return projectFamilyPeek(path, now);
    } catch {
      return null;
    }
  }

  async function projectsScreen(
    response: ServerResponse,
    who: Who,
    problem: string | null,
    status: number,
    returnTo = "/",
    problemAt: ProblemAt = null,
  ): Promise<void> {
    const now = clock();
    const { recent, candidates } = visibleProjects();
    const open = who.via === "cookie" ? who.session.project : null;
    // Onboarding availability (findings 2/28/32/39): a cookie session on a
    // root-configured, non-demo, POSIX serve gets the live card; everybody
    // else gets the card DISABLED with the reason in words.
    const onboardState =
      restricted() || who.via !== "cookie"
        ? { enabled: false as const, why: "An instance operator adds projects." }
        : store.isDemo()
          ? { enabled: false as const, why: "the sandbox never clones — this is demo data" }
          : process.platform === "win32"
            ? { enabled: false as const, why: "adding from GitHub is not supported on Windows yet" }
            : ceiling.roots.length === 0
              ? {
                  enabled: false as const,
                  why: options.upConsole === true
                    ? "Choose a projects folder once: toolroll up --project-root <dir>"
                    : "choose which folder this server may use with --project-root <dir>",
                }
              : { enabled: true as const, roots: ceiling.roots, localOwner: who.authority !== "full", record: [...(who.session.onboard?.entries() ?? [])][0] ?? null };
    const peeks: Record<string, ProjectPeek | null> = {};
    for (const one of recent) peeks[one.path] = peekOf(one.path, now);
    for (const path of candidates) peeks[path] = peekOf(path, now);
    return sendScreen(
      response,
      status,
      projectsPage(chromeFor(open, "projects"), {
        recent, candidates, open, problem, problemAt, onboard: onboardState, peeks, returnTo,
        browsable: !restricted() && (ceiling.roots.length > 0 || unscopedMode),
      }),
    );
  }

  /** One project's reading page (/projects/<name>). A GET only reads (docs/plans/get-side-effects.md): it never
   * switches the session's project; its Open project button posts to /projects/select, which proves it again. The
   * name is found among the projects this person may open (projectsSelect's rule: visible here and inside the
   * ceiling); a name it can't see answers exactly like one that doesn't exist. */
  async function projectFound(ctx: HandlerContext, page: string): Promise<{ name: string; path: string; openedAt: string | null; ambiguous: boolean } | null> {
    const { url, who, response } = ctx;
    let name = "";
    const tail = page === "" ? "" : `/${page}`;
    try { name = decodeURIComponent(url.pathname.slice("/projects/".length, url.pathname.length - tail.length)); } catch { name = ""; }
    const { recent, candidates } = visibleProjects();
    const known = [...recent.map(one => ({ path: one.path, name: one.name, openedAt: one.lastOpenedAt as string | null })), ...candidates.map(path => ({ path, name: projectName(path), openedAt: null as string | null }))];
    const named = known.filter(one => one.name === name);
    const askedPath = url.searchParams.get("path");
    const found = askedPath !== null ? named.find(one => one.path === askedPath) ?? null : named.length === 1 ? named[0]! : null;
    const open = who.via === "cookie" ? who.session.project : null;
    if (found === null || !(await authorizedProject(liveCeiling(), found.path))) {
      const words = unknownProject(name === "" ? "by that name" : name);
      await sendScreen(response, 404, screen("Not found", kitNotFound(url.pathname, words), { chrome: chromeFor(open, "projects") }));
      return null;
    }
    return { ...found, ambiguous: named.length > 1 };
  }
  /** A project's flaky tests list and one row's history. Reads only; found exactly as the project's page is. */
  async function projectFlakyHandler(ctx: HandlerContext): Promise<void> {
    const { url, who, response, now } = ctx;
    const found = await projectFound(ctx, "flaky");
    if (found === null) return;
    const open = who.via === "cookie" ? who.session.project : null;
    const chrome = chromeFor(open, "projects");
    const back = projectHref(found.name, found.path, found.ambiguous);
    const selfHref = projectHref(found.name, found.path, found.ambiguous, "flaky");
    const key = url.searchParams.get("row");
    if (key !== null) {
      const shown = flakyShow(store, found.path, key, now);
      if (shown === null) return sendScreen(response, 404, screen("Not found", kitNotFound(url.pathname, { title: "Nothing is recorded for that test in this project." }), { chrome }));
      return sendScreen(response, 200, flakyRowPage(chrome, { name: found.name, repo: found.path, back: selfHref, row: shown.row, history: shown.history, now }));
    }
    const days = Number(url.searchParams.get("days") ?? FLAKY_WINDOW_DAYS);
    return sendScreen(response, 200, flakyPage(chrome, { name: found.name, repo: found.path, back, selfHref, list: flakyList(store, found.path, now, days), now }));
  }
  async function projectPageHandler(ctx: HandlerContext): Promise<void> {
    const { who, response, now } = ctx;
    const found = await projectFound(ctx, "");
    if (found === null) return;
    const open = who.via === "cookie" ? who.session.project : null;
    const path = found.path;
    // The tasks that wait on this person or run, from the board's own classification, scoped to this one project.
    const snapshot = store.boardScoped(path, now, 200, null);
    const cards = snapshot.tasks
      .filter(facts => facts.repo === path)
      .map(facts => classify(facts.blockerRepo !== null && !visible(facts.blockerRepo) ? { ...facts, blockerState: null } : facts, now))
      .filter(card => card.lane === "attention" || card.lane === "building");
    const tasks: ProjectPageTask[] = cards.slice(0, 5).map(card => ({ href: card.href, title: card.title, reason: card.reason, needs: card.lane === "attention", since: card.stalledSince }));
    const cookie = who.via === "cookie";
    let activity: { report: ProjectOutcomes | null } | null = null;
    if (store.accountCanAccess(who.name, path)) {
      try { activity = { report: projectOutcomes(store, path, now, { principal: 'operator', repos: [path] }) }; }
      catch { activity = { report: null }; }
    }
    return sendScreen(response, 200, projectPage(chromeFor(open, "projects"), {
      name: found.name, path, selfHref: projectHref(found.name, path, found.ambiguous), open: open === path, openedAt: found.openedAt,
      peek: peekOf(path, now), tasks, moreTasks: Math.max(0, cards.length - tasks.length),
      checks: cookie ? { href: `/settings/checks?repo=${encodeURIComponent(path)}`, level: CHECK_LEVEL_WORDS[projectCheckLevel(store, path).level] } : null,
      pullRequests: cookie ? { href: `/settings/pull-requests?repo=${encodeURIComponent(path)}`, on: publishingOf(store, path).on } : null,
      knowledgeHref: `/settings/knowledge?repo=${encodeURIComponent(path)}`,
      flakyHref: projectHref(found.name, path, found.ambiguous, "flaky"),
      settingsHref: restricted() ? null : `/settings/project?repo=${encodeURIComponent(path)}`,
      activity, now,
    }));
  }
  /** The named project's code map address, for this account; null when it isn't one they can see. */
  async function mapProject(ctx: HandlerContext, suffix: string): Promise<{ name: string; path: string; base: string; selfHref: string } | null> {
    let name = "";
    try { name = decodeURIComponent(ctx.url.pathname.slice("/projects/".length, -suffix.length)); } catch { return null; }
    const { recent, candidates } = visibleProjects();
    const named = [...recent.map(one => ({ path: one.path, name: one.name })), ...candidates.map(path => ({ path, name: projectName(path) }))].filter(one => one.name === name);
    const asked = ctx.url.searchParams.get("path") ?? ctx.posted.get("repo");
    const found = asked !== null ? named.find(one => one.path === asked) ?? null : named.length === 1 ? named[0]! : null;
    if (found === null || !(await authorizedProject(liveCeiling(), found.path))) return null;
    return { name: found.name, path: found.path, base: `/projects/${encodeURIComponent(found.name)}/map`, selfHref: projectHref(found.name, found.path, named.length > 1) };
  }
  async function codeMapHandler(ctx: HandlerContext): Promise<void> {
    const { url, who, response, now } = ctx;
    const open = who.via === "cookie" ? who.session.project : null;
    const found = await mapProject(ctx, "/map");
    if (found === null) return sendScreen(response, 404, screen("Not found", kitNotFound(url.pathname, unknownProject("by that name")), { chrome: chromeFor(open, "projects") }));
    const asked = url.searchParams.get("v");
    const pinned = asked !== null && /^[1-9][0-9]{0,14}$/.test(asked) ? Number(asked) : undefined;
    const status = codeMapStatus(store, found.path, now, iso => new Date(iso).toISOString().slice(11, 16));
    const opened = status.state === "off" || status.state === "not-available" ? null : openMap(store, found.path, pinned);
    const held = opened !== null && opened.ok ? opened : null;
    const repoed = opened !== null && !opened.ok && pinned !== undefined ? openMap(store, found.path) : null;
    const map = held ?? (repoed !== null && repoed.ok ? repoed : null);
    const canRefresh = who.via === "cookie" && who.authority !== "local-owner" && store.accountOf(who.name)?.role === "approver" && store.accountCanAccess(who.name, found.path);
    return sendScreen(response, 200, codeMapPage(chromeFor(open, "projects"), {
      name: found.name, repo: found.path, base: found.base, selfHref: found.selfHref, status, map: map?.map ?? null, versionId: map?.version.id ?? null, remoteUrl: store.projectRemote(found.path),
      q: url.searchParams.get("q"), area: url.searchParams.get("area"), file: url.searchParams.get("file"), canRefresh, now, report: codeMapReportBlock(codeMapReport(store, found.path, now)),
      said: url.searchParams.get("said"), problem: repoed !== null ? "The map changed. Showing the current one." : url.searchParams.get("problem"),
    }));
  }
  async function codeMapRefreshHandler(ctx: HandlerContext): Promise<void> {
    const { response, who, now } = ctx;
    const found = await mapProject(ctx, "/map/refresh");
    if (found === null || !store.accountCanAccess(who.name, found.path)) return refuse(response, who, 403, "That project is outside your access.", "/projects");
    const said = requestRefresh(store, found.path, who.name, now);
    return redirect(response, `${found.base}?said=${encodeURIComponent(said === "queued" ? "Queued. Main is checked on the next pass." : "Already queued.")}`);
  }
  async function instanceEdge(ctx: EdgeContext): Promise<void> {
    const { request, response, url } = ctx;
    const secret = options.instanceSecret?.() ?? null;
    if (secret === null) return respond(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "not-up" }));
    // Bound to what THIS console saw as the receiving end of this very connection — never the Host header.
    const answer = instanceHttpAnswer(secret, url.searchParams.getAll("c").length === 1 ? url.searchParams.get("c") : null, { address: request.socket.localAddress, port: request.socket.localPort });
    response.setHeader("Cache-Control", "no-store");
    return respond(response, answer.status, "application/json; charset=utf-8", answer.body);
  }

  async function healthzEdge(ctx: EdgeContext): Promise<void> {
    const { response, method } = ctx;
    return healthz(store, response, method === 'HEAD', options.draining?.() === true);
  }

  async function browserAsset(ctx: EdgeContext): Promise<void> {
    const { request, response, url } = ctx;
    serveBrowserAsset(request, response, url.pathname);
  }

  async function workspaceStyle(ctx: EdgeContext): Promise<void> {
    const { request, response, url } = ctx;
    // Only the current build's hash is served; any other hash is no asset.
    if (url.pathname !== WORKSPACE_STYLE.path) return respond(response, 404, 'text/plain; charset=utf-8', 'No such address.');
    return WORKSPACE_STYLE.serve(request, response);
  }

  async function installAsset(ctx: EdgeContext): Promise<void> {
    const { response, url } = ctx;
    serveInstallAsset(response, url.pathname, respond);
  }

  async function fontAsset(ctx: EdgeContext): Promise<void> {
    const { response, url } = ctx;
    serveInstallAsset(response, url.pathname, respond);
  }

  async function desktopHealth(ctx: EdgeContext): Promise<void> {
    const { response, url } = ctx;
    const identity = options.desktopIdentity;
    if (identity === undefined) return respond(response, 404, 'text/plain; charset=utf-8', 'No such address.');
    const challenge = url.searchParams.get("challenge") ?? "";
    if (!/^[a-f0-9]{64}$/.test(challenge) || !/^[a-f0-9]{64}$/.test(identity)) return respond(response, 400, "application/json", JSON.stringify({ error: "invalid challenge" }));
    response.setHeader("cache-control", "no-store");
    return respond(response, 200, "application/json", JSON.stringify({ proof: createHmac("sha256", Buffer.from(identity, "hex")).update(challenge).digest("hex") }));
  }

  // The Live grid (docs/plans/agents-view.md §3), kept after every other handler.
  /** The Live grid's tiles (JSON, read-only): every role's running agents and those that just ended, that this viewer
   * may see — the console's ceiling and the account's own access, proved per run, on every request. */
  async function agentsLive(ctx: HandlerContext): Promise<void> {
    const { who, request, response } = ctx;
    response.setHeader("cache-control", "no-store");
    // A browser session only (the route says so too): live output is never a token's to read.
    if (who.via !== "cookie") return respond(response, 403, "application/json", JSON.stringify({ error: "session" }));
    const browser = who as typeof who & { via: "cookie" };
    const canSee = (run: { taskRef: number }) => { const repo = taskRepoOf(run.taskRef); return repo !== null && visible(repo) && store.accountCanAccess(who.name, repo); };
    const tiles = agentsLiveOf(store, clock(), { canSee, localRunner: options.localRunner });
    // The viewer's own lead turns, admitted as their chat is, from the session as it is saved now.
    const current = rereadBrowser(runtime, request, browser);
    const leads = current === null ? [] : leadTilesFor(runtime, current);
    // Re-proved right before delivery: the session still held, each tile's run still in view from its current row, and
    // each lead turn still admitted, from the session as it is saved now.
    const again = current === null ? null : rereadBrowser(runtime, request, browser);
    if (again === null) return respond(response, 401, "application/json", JSON.stringify({ error: "session" }));
    const shown = tiles.filter(tile => { const run = store.getRun(tile.runId); return run !== null && canSee(run); });
    // Work the viewer's own lead filed nests under it (docs/plans/lead-dispatched-tiles.md): proved from the store now,
    // for the tiles already shown, and only ever for their owner.
    const filed = again.role === "approver" ? leadFiledLinks(store, again.name, shown.map(tile => tile.runId)) : new Map();
    return respond(response, 200, "application/json", JSON.stringify({ tiles: shown.map(tile => ({ ...tile, filedBy: filed.get(tile.runId) ?? null })), leads: leadsStillAdmitted(runtime, again, leads) }));
  }

  /** This console's key for the Live grid's read cursors: random, in memory only (never where a build can reach), so a
   * restart makes old cursors start over visibly. A cursor is state, never permission. */
  const liveCursorKey = randomBytes(32);

  /** One window of a run's live output for the Live grid (JSON, read-only): its own records or its subagents'. Access
   * is proved before the read (ceiling, account, this computer's run) and again after it, before a byte is sent. */
  async function agentsLiveRead(ctx: HandlerContext): Promise<void> {
    const { url, who, response } = ctx;
    response.setHeader("cache-control", "no-store");
    // A browser session only (the route says so too): live output is never a token's to read.
    if (who.via !== "cookie") return respond(response, 403, "application/json", JSON.stringify({ error: "session" }));
    const runId = Number(url.pathname.slice("/agents/live/".length));
    const file = url.searchParams.get("file");
    const cursor = url.searchParams.get("cursor");
    if ((file !== "main" && file !== "sub") || [...url.searchParams.keys()].some(key => key !== "file" && key !== "cursor")) {
      return respond(response, 400, "application/json", JSON.stringify({ error: "request" }));
    }
    const browser = who as typeof who & { via: "cookie" };
    // The saved session still held (not just the cookie), and the run still in view from its current row.
    const allowed = (): boolean => {
      if (rereadBrowser(runtime, ctx.request, browser) === null) return false;
      const run = store.getRun(runId);
      const repo = run === null ? null : taskRepoOf(run.taskRef);
      return run !== null && repo !== null && runVisible(run) && store.accountCanAccess(who.name, repo);
    };
    if (!allowed()) return respond(response, 404, "application/json", JSON.stringify({ error: "run" }));
    if (options.localRunner === undefined || store.getRun(runId)?.runner !== options.localRunner) {
      return allowed() ? respond(response, 200, "application/json", JSON.stringify({ error: "off" })) : respond(response, 404, "application/json", JSON.stringify({ error: "run" }));
    }
    const read = { key: liveCursorKey, commands: runLiveCommands(store, runId) };
    const window = file === "sub" ? readChildWindow(evidenceRoot, runId, cursor, read) : readMainWindow(evidenceRoot, runId, cursor, read);
    // Re-proved after the read: a narrowed account or a run gone from view gets nothing it read.
    if (!allowed() || store.getRun(runId)?.runner !== options.localRunner) return respond(response, 404, "application/json", JSON.stringify({ error: "run" }));
    return respond(response, 200, "application/json", JSON.stringify(window.ok ? window : { error: window.reason }));
  }

  /** Start a builder (Settings revamp S4): the command, and whether a builder that may build the open project is
   * checking in, as dispatch decides. Read-only; a project-limited person sees only a project they may see. */
  async function startBuilderPage(ctx: HandlerContext): Promise<void> {
    const { response, now, project, url, who } = ctx;
    // ?task=<id>: that task's own saved project (a builder there, as dispatch decides for it), never the open one; the
    // session's selection is left alone. Unknown, unplaced or not visible to this person: 404, the same answer.
    const taskId = url.searchParams.get("task");
    const ref = taskId === null ? null : store.lookupRef(taskId.slice(0, 200));
    if (taskId !== null && (ref === null || ref.repo === null || !visible(ref.repo))) return refuse(response, who, 404, "That task is not available.", "/tasks");
    const shown = ref !== null ? ref.repo : project !== null && visible(project) ? project : null;
    const connected = shown === null ? null : buildersFor(store, shown, now, ref?.assignedRunner ?? null).alive.length > 0;
    return sendScreen(response, 200, screen("Start a builder", startBuilderHtml({
      heading: "h1", project: shown === null ? null : basename(shown), connected, managed: !restricted(),
    }), { chrome: chromeFor(project, "none") }));
  }

  const registrations = handlersOf("pages", {
    "projects.browse": projectsBrowse,
    "projects.github": projectsGithub,
    "projects.github-list": projectsGithubList,
    "projects.page": projectsIndex,
    "projects.project": projectPageHandler,
    "projects.map": codeMapHandler,
    "projects.map-refresh": codeMapRefreshHandler,
    "projects.flaky": projectFlakyHandler,
    "home": homeRedirect,
    "search": searchPage,
    "morning": morningAlias,
    "workbench": async ctx => retiredRedirect("workbench", ctx.url, ctx.response),
    "ledger": ledgerPage,
    "activity": activityPage,
    "system": systemScreen,
    "start-builder": startBuilderPage,
    "peek": peekPage,
    "agents": agentsPage,
    "agents.live": agentsLive,
    "agents.live.read": agentsLiveRead,
    "agents.terminals": agentsTerminals,
    "fleet": fleetPage,
    "ledger.export": ledgerExport,
    "menu": menuPage,
    "caps": capsScreen,
    "health": health,
    "metrics": metrics,
    "ledger.checkpoint": ledgerCheckpoint,
    "projects.select": projectsSelect,
    "projects.remove": projectsRemove,
    "projects.open": projectsOpen,
    "fleet.register": fleetRegister,
    "fleet.retire": fleetRetire,
    "projects.onboard-preview": onboardPreview,
    "projects.onboard-confirm": onboardConfirm,
  }, {
    "edge.healthz": healthzEdge,
    "edge.instance": instanceEdge,
    "edge.browser-asset": browserAsset,
    "edge.workspace-style": workspaceStyle,
    "edge.install-asset": installAsset,
    "edge.font": fontAsset,
    "edge.desktop-health": desktopHealth,
  });
  return { registrations, projectsScreen };
}
