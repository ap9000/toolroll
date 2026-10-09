import { handlersOf } from './handler-registry.js';
import { html, joinHtml, postForm, type Html } from "../html.js";
/** pages handlers, moved without changing their route bodies. */
import { createHmac,randomBytes } from "node:crypto";
import { existsSync,opendirSync,readdirSync,realpathSync } from "node:fs";
import { type ServerResponse } from "node:http";
import { homedir,hostname } from "node:os";
import { dirname,join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { INSTALLATION_SCOPE,resolvePhaseAgent } from "../agentconfig.js";
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
import { readLiveWindow } from "../live.js";
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
import type { ServerRuntime } from './runtime.js';
import { projectChip,refuse,regionScript,relativeAge,screen,settingsRows,transcriptScript,WORKSPACE_STYLE,workToolRows,type NavRow } from "./chrome.js";
import { redirect,respond,safeReturn,SAFETY,taskHref } from "./http.js";
import { browsePage,fleetBody,fleetScript,githubIdentityOf,githubReposPage,homePage,originUrlOf,portfolioOverview,projectsPage,systemPage,workbenchRail } from "./render-pages.js";
import { capsPage } from "./render-settings.js";
import { decisionAnswerScript,taskBody } from "./render-tasks.js";
import { type Who } from "./session.js";
export function createPagesHandlers(runtime: ServerRuntime) {
  const { clock, store, visible, consoleProjects, restricted, ceiling, options, projectFamilyPeek, sendScreen, chromeFor, unscopedMode, admissionList, taskRepoOf, taskViewData, runVisible, evidenceRoot, workAccess, identify, liveCeiling, sessions, deletedRepos, authenticateApprover, projectOf, lookupSession } = runtime;

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
      ceiling.roots.length > 0 ? [...ceiling.roots] : unscopedMode ? [realpathSync(homedir())] : [];
    if (browseRoots.length === 0) {
      return refuse(response, who, 404, "this server was configured with an explicit repo list — the openable projects are all on the projects page", "/projects");
    }
    const asked = url.searchParams.get("at") ?? browseRoots[0] as string;
    const canonical = canonicalProject(asked);
    const inside =
      canonical !== null &&
      browseRoots.some(root => canonical === root || canonical.startsWith(`${root}/`));
    if (canonical === null || !inside) {
      return refuse(response, who, 403, "that path is outside what this server may browse", "/projects/browse");
    }
    let entries: { name: string; path: string; git: boolean }[] = [];
    try {
      entries = readdirSync(canonical, { withFileTypes: true })
        .filter(one => one.isDirectory() || one.isSymbolicLink())
        .filter(one => !one.name.startsWith(".") && one.name !== "node_modules")
        .slice(0, 400)
        .map(one => {
          const path = join(canonical, one.name);
          // Resolve NOW so a symlink pointing outside the fence renders
          // as nothing rather than as a door.
          const resolved = canonicalProject(path);
          if (resolved === null || !browseRoots.some(root => resolved === root || resolved.startsWith(`${root}/`))) {
            return null;
          }
          return { name: one.name, path: resolved, git: existsSync(join(resolved, ".git")) };
        })
        .filter((one): one is { name: string; path: string; git: boolean } => one !== null)
        .sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name))
        .slice(0, 200);
    } catch {
      return refuse(response, who, 404, "that directory cannot be read", "/projects/browse");
    }
    const root = browseRoots.find(one => canonical === one || canonical.startsWith(`${one}/`)) as string;
    const parent = canonical === root ? null : canonical.slice(0, canonical.lastIndexOf("/")) || root;
    const csrf = who.session.csrf;
    return sendScreen(
      response,
      200,
      browsePage(chromeFor(who.session.project, "projects"), {
        at: canonical,
        root,
        roots: browseRoots,
        parent,
        entries,
        csrf,
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
    const listed = await (options.ghList ?? listGithubRepos)();
    // What this machine already has, matched by the clone's own recorded
    // origin — registered projects first, then the immediate children of
    // the configured roots. Identities are compared case-insensitively
    // (GitHub's rule); the FIRST match wins.
    const localByIdentity = new Map<string, string>();
    const registered = new Set<string>();
    for (const project of store.listProjects()) {
      if (!visible(project.path)) continue;
      registered.add(project.path);
      const identity = githubIdentityOf(originUrlOf(project.path) ?? "");
      if (identity !== null && !localByIdentity.has(identity.toLowerCase())) {
        localByIdentity.set(identity.toLowerCase(), project.path);
      }
    }
    // Roots are walked ONLY when there are listed repos to match against
    // (finding 1), through an iterator that stops at 400 entries — a
    // directory with a million children costs 400 stats, not a scan.
    if (listed.ok && listed.repos.length > 0) {
      for (const root of ceiling.roots) {
        const children: string[] = [];
        try {
          const dir = opendirSync(root);
          try {
            for (let seen = 0; seen < 400; seen++) {
              const entry = dir.readSync();
              if (entry === null) break;
              if (entry.isDirectory()) children.push(join(root, entry.name));
            }
          } finally {
            dir.closeSync();
          }
        } catch {
          // an unreadable root offers nothing
        }
        for (const child of children) {
          if (!existsSync(join(child, ".git"))) continue;
          const identity = githubIdentityOf(originUrlOf(child) ?? "");
          if (identity !== null && !localByIdentity.has(identity.toLowerCase())) {
            localByIdentity.set(identity.toLowerCase(), child);
          }
        }
      }
    }
    return sendScreen(
      response,
      200,
      githubReposPage(chromeFor(who.via === "cookie" ? who.session.project : null, "projects"), {
        listed,
        local: localByIdentity,
        registered,
        csrf: who.via === "cookie" ? who.session.csrf : "",
        cloneReady: ceiling.roots.length > 0,
        openProject: who.via === "cookie" ? who.session.project ?? null : null,
      }),
    );
  }

  async function projectsIndex(ctx: HandlerContext): Promise<void> {
    const { url, who, response } = ctx;
    return void projectsScreen(response, who, url.searchParams.get("said"), 200, safeReturn(url.searchParams.get("return")));
  }

  async function homeRedirect(ctx: HandlerContext): Promise<void> {
    const { who, response } = ctx;
    return redirect(response, who.via === "cookie" && !restricted() ? "/chat" : "/work");
  }

  // The board's old name; bookmarks keep working. A GET-only alias, so a
  // plain 302 — never the shared 303 helper, which belongs to POST landings.
  async function morningAlias(ctx: HandlerContext): Promise<void> {
    const { response } = ctx;
    response.writeHead(302, { ...SAFETY, Location: "/activity" });
    response.end();
    return;
  }

  async function workbench(ctx: HandlerContext): Promise<void> {
    const { url, who, response, now, project } = ctx;
    // The fleet under one gaze (attended A1): the rail rolls up the whole
    // ceiling regardless of the open project — watching is cross-project
    // by nature; acting happens on task screens that re-prove everything.
    const admission = admissionList();
    const snapshot = store.boardScoped(null, now, 200, admission);
    const rows = snapshot.tasks.filter(facts => facts.repo === null || visible(facts.repo));
    const cards = rows.map(facts =>
      classify(facts.blockerRepo !== null && !visible(facts.blockerRepo) ? { ...facts, blockerState: null } : facts, now),
    );
    const attention = cards.filter(card => card.lane === "attention").slice(0, 100);
    const building = cards.filter(card => card.lane === "building");
    const waiting = cards.filter(card => card.lane === "waiting");
    const queued = cards.filter(card => card.lane === "queued");
    const done = snapshot.done
      .filter(one => one.repo === null || visible(one.repo))
      .slice(0, 5)
      .map(one => ({ taskId: one.taskId, title: one.title, outcome: one.outcome, repo: one.repo }));
    const selected = url.searchParams.get("t");
    const rail = workbenchRail({ attention, building, waiting, queued, done, selected, saturated: snapshot.saturated });
    if (url.searchParams.get("fragment") === "rail") {
      // The rail alone: same auth, same ceiling, no shell, no scripts.
      return respond(response, 200, "text/html; charset=utf-8", rail);
    }
    // The portfolio overview (arc slice 1a). All-scope hygiene throughout:
    // admission binds inside every bounded SQL read, and every unlimited
    // feed's rows pass visible() BEFORE they render or tally — a hidden
    // project must not leak into a row, a count, or a dollar.
    const sinceIso = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const decisions = store
      .listDecisionsScoped(null)
      .filter(one => visible(one.repo ?? null))
      .slice(0, 10);
    const approvals = store.scopesAwaitingApproval(null, 10, admission).filter(one => visible(one.repo ?? null));
    const requeueables = store.listRequeueablesScoped(null, now, 10, admission).filter(one => visible(one.repo ?? null));
    const cancelledBlockers = store
      .listCancelledBlockersScoped(null, 10, admission)
      .filter(one => visible(one.repo ?? null) && visible(one.blockerRepo ?? null));
    const runs24 = store.runsSinceScoped(sinceIso, null).filter(run => visible(taskRepoOf(run.taskRef)));
    const live = store.liveClaims(null, now).filter(one => visible(one.repo));
    const ledger = store
      .portfolioLedgerScoped(null, sinceIso, 30, admission)
      .filter(row => visible(row.repo));
    // Gaps stay project-relative (the roll-up inbox's rule): computed for
    // the OPEN project only — there is no scope-safe road to another
    // project's /caps.
    const gaps = project === null ? [] : computeGaps(store, project, now).filter(gap => gap.unblocks.length > 0).slice(0, 10);
    const csrf = who.via === "cookie" ? who.session.csrf : "";
    let detail = html`${portfolioOverview({
      attention, building, waiting, queued, done, saturated: snapshot.saturated,
      decisions, approvals, requeueables, cancelledBlockers, gaps,
      gapsProject: project, runs24, live, ledger, csrf, now,
    })}<div class="workbench-mobile-rail">${rail}</div>`;
    if (selected !== null) {
      const view = taskViewData(selected, who, null);
      detail = view === null
        ? html`<p class="workbench-mobile-back"><a href="/workbench">← all work</a></p><div class="card"><p class="meta">No such task — it may have been outside this console's view</p></div>`
        : html`<p class="workbench-mobile-back"><a href="/workbench">← all work</a></p>${taskBody({ ...view, degraded: "pane" })}`;
    }
    return sendScreen(
      response,
      200,
      screen("portfolio", detail, {
        chrome: chromeFor(
          project,
          "workbench",
          html`<div id="wb-rail">${rail}</div><p class="meta" id="wb-rail-stamp"></p>`,
          "all",
        ),
        functional: {
          // The decision enhancement rides ONLY the overview: a selected
          // task's pane may carry a password ceremony, and sensitive
          // pages gain no new scripts (commit-1 review, finding 1).
          script:
            regionScript("wb-rail", "rail") +
            (selected === null && decisions.length > 0 ? decisionAnswerScript() : ""),
          fetches: true,
        },
      }),
    );
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
    return sendScreen(response, 200, screen("Action ledger", ledgerBody(rows, projects, url.searchParams, chainView), { chrome: chromeFor(chosen === "" ? null : chosen, "ledger", undefined, chosen === "" ? "all" : "project") }));
  }

  async function activityPage(ctx: HandlerContext): Promise<void> {
    const { who, response, now, project } = ctx;
    const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    return sendScreen(
      response,
      200,
      homePage(chromeFor(project, "runs"), {
        csrf: who.via === "cookie" ? who.session.csrf : "",
        taskCount: store.listTasksScoped(project, undefined, 1, null).length,
        repo: project,
        summary: tally(store.runsSinceScoped(since, project)),
        decisions: store.listDecisionsScoped(project),
        incidents: store.openIncidents(project),
        stranded: store.strandedTasks(project),
        gaps: project === null ? null : computeGaps(store, project, now),
        // Rows that want a person, plus task updates the live pairing failed to send (never quiet progress).
        outboxPending: store.pendingForAttention().length,
        settings: options.telegramTokenFile !== undefined,
        building: store.liveClaims(project, now),
        runners: store.listRunners(),
        worktrees: store
          .listWorktrees()
          .filter(one => project === null || sameRepo(one.repo, project)),
        episode: project === null ? null : store.latestWatchEpisode(project),
        now,
      }),
    );
  }

  async function systemScreen(ctx: HandlerContext): Promise<void> {
    const { response, now, project } = ctx;
    const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    void since;
    return sendScreen(
      response,
      200,
      systemPage(chromeFor(project, "system"), {
        agents: (["plan", "build", "repair", "review"] as const).map(phase => {
          const answer = resolvePhaseAgent(store, phase, project, {});
          const row =
            (project === null ? null : store.phaseConfig(project, phase)) ??
            store.phaseConfig(INSTALLATION_SCOPE, phase);
          return {
            phase,
            ...(answer.ok
              ? { provider: answer.spec.provider, model: answer.spec.model, source: answer.source }
              : { problem: answer.problem }),
            setBy: row?.updatedBy ?? null,
          };
        }),
        building: store.liveClaims(project, now),
        runners: store.listRunners(),
        worktrees: store.listWorktrees().filter(one => project === null || sameRepo(one.repo, project)),
        episode: project === null ? null : store.latestWatchEpisode(project),
        outboxPending: store.pendingForAttention().length,
        // External work at a glance (arc 3 finding 24): every dispatch
        // grant with its blocked state, plus any open sync episode — the
        // page a sync-failed push deep-links to now shows the fact.
        externalWork: store
          .listGrants()
          .filter(one => one.dispatch === true && one.remoteRepo != null && visible(one.repo))
          .map(one => ({
            remoteRepo: String(one.remoteRepo),
            blocked: one.dispatchBlocked ?? null,
            openEpisode:
              store
                .listNotifications("all")
                .find(n => n.kind === "sync-failed" && n.resolvedAt === null && n.dedupeKey.startsWith(`sync:${one.remoteRepo}:`))?.subject ?? null,
          })),
        now,
      }),
    );
  }

  // The multiplexer in the console (peek): one pane per live run the
  // ceiling admits, each fed by the run page's own transcript poller
  // (the byte-offset JSON protocol — text into textContent, never
  // markup). The pane SET is re-checked on a slow cadence; when it
  // changes the page reloads rather than swapping pollers mid-flight.
  async function peekPage(ctx: HandlerContext): Promise<void> {
    const { url, response, project } = ctx;
    const live = store.liveRuns(clock()).filter(run => runVisible(run));
    if (url.searchParams.get("fragment") === "1") {
      return respond(response, 200, "application/json", JSON.stringify({ runs: live.map(run => run.id) }));
    }
    const now = clock();
    const panes = live.map(run => {
      const window = options.localRunner === undefined ? null : readLiveWindow(evidenceRoot, run.id, 0);
      const tail = window !== null && window.ok ? window.text.split("\n").filter(one => one !== "").slice(-40).join("\n") : "";
      const stage = run.phase !== null ? run.phase.replace(/-/g, " ") : run.providerStartedAt === null ? "preparing workspace" : "the agent is working";
      return joinHtml([
        html`<section class="card peek-pane" data-run="${run.id}">`,
        html`<p class="row"><a href="/r/${run.id}" class="mono">#${run.id}</a> <a href="${taskHref(run.taskId)}"><strong>${run.title}</strong></a>${projectChip(run.repo)} <span class="right meta mono">${run.runner} \u00b7 ${run.role} \u00b7 ${stage} \u00b7 ${relativeAge(run.startedAt, now)}</span></p>`,
        options.localRunner === undefined
          ? html`<p class="meta">The transcript is readable on the machine that runs the worker \u2014 start the console there with <code>toolroll up</code></p>`
          : html`<pre class="recap plan-doc live-pane" id="live-transcript-${run.id}" data-initial-offset="0">${tail}</pre><p class="meta" id="live-transcript-${run.id}-state"></p>`,
        html`</section>`,
      ], "\n");
    });
    const script =
      (options.localRunner === undefined ? "" : live.map(run => transcriptScript(`/r/${run.id}`, `live-transcript-${run.id}`)).join("")) +
      `(function(){var seen=${JSON.stringify(live.map(run => run.id))};function check(){if(document.hidden){setTimeout(check,12000);return;}` +
      `fetch("/peek?fragment=1",{redirect:"manual",cache:"no-store"}).then(function(r){return r.ok?r.json():null;})` +
      `.then(function(d){if(d&&Array.isArray(d.runs)&&JSON.stringify(d.runs)!==JSON.stringify(seen)){location.reload();return;}setTimeout(check,12000);})` +
      `.catch(function(){setTimeout(check,12000);});}setTimeout(check,12000);})();`;
    return sendScreen(
      response,
      200,
      screen(
        "peek",
        joinHtml([
          html`<h1>Peek</h1>`,
          panes.length === 0
            ? html`<p class="meta">No agent is working right now \u2014 this page follows them the moment one starts</p>`
            : joinHtml(panes, "\n"),
        ], "\n"),
        { chrome: chromeFor(project, "runs"), functional: { script, fetches: true } },
      ),
    );
  }

  async function fleetPage(ctx: HandlerContext): Promise<void> {
    const { url, who, response, project } = ctx;
    // Cross-project by design: which agent is on which project is the
    // question, so this screen is a survey — reads are still filtered
    // through the ceiling before a card renders. No project needed.
    const queued = store.fleetQueue(clock());
    const building = store.liveClaims(null, clock());
    const owned = new Set(queued.map(one => one.assignedRunner).filter((one): one is string => one !== null));
    const runners = store.listRunners().filter(one => one.retiredAt === null || owned.has(one.name));
    const body = fleetBody(queued, building, runners, store.queueRevision(), visible);
    if (url.searchParams.get("fragment") === "1") {
      return respond(response, 200, "text/html; charset=utf-8", body);
    }
    const said = url.searchParams.get("said");
    const fleetScreen = screen(
      "fleet",
      joinHtml([
        html`<h1>Fleet</h1>`,
        html`<p class="hint">one lane per worker — drag a queued card onto another worker to re-reserve it</p>`,
        ...(said === null ? [] : [html`<p class="meta">${said}</p>`]),
        html`<div id="fleet-region">${body}</div>`,
        html`<p class="meta" id="fleet-region-stamp"></p>`,
        html`<h2>Register a worker</h2>`,
        postForm("/fleet/runner/register", html`<label>Name<input type="text" name="name" placeholder="builder-2" maxlength="60" required></label><label>Capacity<input type="text" name="capacity" inputmode="numeric" value="1" aria-label="capacity"></label><label>Your password, typed again<input type="password" name="token" autocomplete="current-password" required></label><button type="submit">Register — its token is shown once</button>`, { attrs: { class: "card" } }),
        html`<details class="arm-danger"><summary>Retire a worker</summary>${postForm("/fleet/runner/retire", html`<label>Which worker<input type="text" name="name" placeholder="builder-1" required></label><label>Your password, typed again<input type="password" name="token" autocomplete="current-password" required></label><button type="submit" class="danger">Retire it</button>`, { attrs: { class: "card" } })}</details>`,
      ], "\n"),
      // The password fields make this screen sensitive: sendScreen strips
      // the chrome additions and keeps the reorder poller — the named
      // functional exception (it never reads the fields).
      { chrome: chromeFor(project, "fleet", undefined, "all"), functional: { script: fleetScript(), fetches: true } },
    );
    return sendScreen(response, 200, fleetScreen);
  }

  // v103: every ledger entry in a date range, sealed, with an evidence pack for each task it names.
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
    return request.headers.accept?.includes('application/json')
      ? respond(response, 200, 'application/json; charset=utf-8', JSON.stringify(health))
      : respond(response, 200, 'text/plain; charset=utf-8', `${healthWords(health)}\n`);
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
    const canonicalPick = askedPath === "" ? null : canonicalProject(askedPath);
    if ((askedPath !== "" && canonicalPick === null) || (canonicalPick !== null && (!visible(canonicalPick) || !(await authorizedProject(liveCeiling(), canonicalPick))))) {
      return refuse(response, who, 403, "that project is outside this console's reach");
    }
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
    const canonical = asked === "" ? null : canonicalProject(asked);
    if (canonical === null) {
      return void projectsScreen(response, who, "that path does not exist on this server", 400, safeReturn(body.get("return")));
    }
    // Authorization is the ceiling, then the path must actually be a git
    // repository — validation with direct argv and a bound, never a shell.
    // Both checks apply even to configured repos: naming a directory in
    // config authorizes it; only being a repository makes it openable.
    if (!(await authorizedProject(liveCeiling(), canonical))) {
      return void projectsScreen(response, who, "that path is outside what this server was configured to serve", 403, safeReturn(body.get("return")));
    }
    if (!(await isGitRepo(canonical))) {
      return void projectsScreen(response, who, "that path is not a git repository", 400, safeReturn(body.get("return")));
    }
    // An account limited to listed projects never widens its own list.
    if (!visible(canonical)) {
      return void projectsScreen(response, who, "That project is outside your access.", 403, safeReturn(body.get("return")));
    }
    // Opening an allowed repository admits it the same way `repos add` does
    // (project-admission.ts). A co-located `up` notices the durable list and
    // connects its builder; there is no separate restart or binding step.
    const admitted = await admitProject(store, { registryFile: options.registryPath ?? null, path: canonical, actor: { label: who.name, origin: "console" }, now });
    if (!admitted.ok) {
      return void projectsScreen(response, who, admitted.reason === "not-git" ? "that path is not a git repository" : `that project is valid, but it could not be added — ${admitted.message}`, 400, safeReturn(body.get("return")));
    }
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
    if (!authenticateApprover(who, token).ok) {
      return refuse(response, who, 403, "registering a worker takes your password, typed again", "/fleet");
    }
    const name = (body.get("name") ?? "").trim();
    if (name === "" || name.length > 60 || /[\r\n\t]/.test(name) || hasForbiddenControls(name)) {
      return refuse(response, who, 400, "a worker's name is one short line, no control characters", "/fleet");
    }
    const capacity = Number((body.get("capacity") ?? "1").trim() || "1");
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64) {
      return refuse(response, who, 400, "capacity is a whole number of tasks, 1 to 64", "/fleet");
    }
    const { token: minted } = registerRunner(store, { name, host: hostname(), capacity, now });
    const tokenScreen = screen(
      "fleet",
      joinHtml([
        html`<h1>${name} is registered</h1>`,
        html`<div class="card">`,
        html`<p>Its token, shown once. Only a hash is kept, so copy it now.</p>`,
        html`<p class="mono secret-value">${minted}</p>`,
        html`<p class="meta">Keep it beside the worker, in a file only you can read (0600) or a secrets manager. If it's lost, register the name again; its old claims are taken back.</p>`,
        html`</div>`,
        html`<p class="meta"><a href="/fleet">Back to Fleet</a></p>`,
      ], "\n"),
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
      return refuse(response, who, 403, "retiring a worker takes your password, typed again", "/fleet");
    }
    const name = (body.get("name") ?? "").trim();
    const retired = store.retireRunner(name, now);
    if (!retired) return refuse(response, who, 404, `no worker \`${name}\``, "/fleet");
    return redirect(response, `/fleet?said=${encodeURIComponent(`${name} is retired — its queued work is still here, drag it elsewhere`)}`);
  }

  async function onboardPreview(ctx: HandlerContext): Promise<void> {
    const { who, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.onboard);
    // Repo onboarding (findings 1-39): bearer and demo refuse BEFORE any
    // gh call; the console flow exists only on root-configured serves.
    if (who.via !== "cookie") return refuse(response, who, 403, "adding repositories is a browser session's act");
    if (store.isDemo()) return refuse(response, who, 403, "the sandbox never clones");
    if (process.platform === "win32") return refuse(response, who, 403, "adding from GitHub is not supported on Windows yet");
    if (ceiling.roots.length === 0) return projectsScreen(response, who, "naming where repositories live takes --project-root", 400);
    const shape = parseGithubRepo(body.get("repo") ?? "");
    if (!shape.ok) return projectsScreen(response, who, shape.problem, 400);
    // Roots by INDEX (finding 13) — a posted path is never accepted.
    const rootIndex = Number(body.get("root") ?? "0");
    const rootRaw = Number.isInteger(rootIndex) ? ceiling.roots[rootIndex] : undefined;
    if (rootRaw === undefined) return projectsScreen(response, who, "pick one of the configured roots", 400);
    let root: string;
    try {
      root = realpathSync(rootRaw);
    } catch {
      return projectsScreen(response, who, "that projects root does not resolve right now", 400);
    }
    const previewed = await (options.ghPreview ?? previewGithubRepo)(shape.owner, shape.name);
    if (!previewed.ok) return projectsScreen(response, who, previewed.message, 400);
    const reparsed = parseGithubRepo(previewed.preview.nameWithOwner);
    if (!reparsed.ok) return projectsScreen(response, who, "GitHub named a repository shape this console refuses", 400);
    // The hook boundary is NORMALIZED like the real preview would be
    // (verification finding 2): a size that is not a nonnegative finite
    // number is unknown, and unknown is LARGE.
    const diskUsageKib =
      typeof previewed.preview.diskUsageKib === "number" && Number.isFinite(previewed.preview.diskUsageKib) && previewed.preview.diskUsageKib >= 0
        ? previewed.preview.diskUsageKib
        : null;
    const target = join(root, reparsed.name);
    if (dirname(target) !== root) return projectsScreen(response, who, "the target escaped its root — refused", 400);
    // The session-held record (finding 14): swept at mint, capped 3.
    const session = who.session;
    session.onboard ??= new Map();
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, record] of session.onboard) if (record.mintedAt < cutoff) session.onboard.delete(key);
    if (session.onboard.size >= 3) return projectsScreen(response, who, "three previews are already waiting — confirm or let one expire", 400);
    const nonce = randomBytes(16).toString("hex");
    session.onboard.set(nonce, {
      nameWithOwner: previewed.preview.nameWithOwner,
      rootIndex,
      target,
      diskUsageKib,
      large: isLargeRepo({ ...previewed.preview, diskUsageKib }),
      mintedAt: Date.now(),
    });
    return projectsScreen(response, who, null, 200);
  }

  async function onboardConfirm(ctx: HandlerContext): Promise<void> {
    const { who, request, response, posted, now } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.onboard);
    // Repo onboarding (findings 1-39): bearer and demo refuse BEFORE any
    // gh call; the console flow exists only on root-configured serves.
    if (who.via !== "cookie") return refuse(response, who, 403, "adding repositories is a browser session's act");
    if (store.isDemo()) return refuse(response, who, 403, "the sandbox never clones");
    if (process.platform === "win32") return refuse(response, who, 403, "adding from GitHub is not supported on Windows yet");
    if (ceiling.roots.length === 0) return projectsScreen(response, who, "naming where repositories live takes --project-root", 400);

    // CONFIRM: password, then session liveness AGAIN via lookupSession
    // (finding 22/33) — the record is consumed from the RETURNED live
    // session, synchronously, before the first await.
    const password = body.get("token") ?? "";
    if (password === "" || !authenticateApprover(who, password).ok) {
      return projectsScreen(response, who, "cloning takes your password, typed again", 403);
    }
    const cookieId = /(?:^|;\s*)standing-orders_session=([0-9a-f]{64})/.exec(request.headers.cookie ?? "")?.[1];
    const live = cookieId === undefined ? null : lookupSession(cookieId, false);
    if (live === null) return refuse(response, who, 403, "this session ended while the form was open — sign in again");
    const nonce = body.get("nonce") ?? "";
    const record = live.onboard?.get(nonce);
    if (record === undefined || record.mintedAt < Date.now() - 10 * 60_000) {
      live.onboard?.delete(nonce);
      return projectsScreen(response, who, "that preview expired or was already used — preview again", 400);
    }
    live.onboard?.delete(nonce); // consumed BEFORE the first await
    if (record.large && body.get("big-ok") !== "1") {
      return projectsScreen(response, who, "that repository is large (or its size is unknown) — tick the box to clone it anyway", 400);
    }
    const rootRaw = ceiling.roots[record.rootIndex];
    if (rootRaw === undefined) return projectsScreen(response, who, "the configured roots changed — preview again", 400);
    let root: string;
    try {
      root = realpathSync(rootRaw);
    } catch {
      return projectsScreen(response, who, "that projects root does not resolve right now", 400);
    }
    if (dirname(record.target) !== root) return projectsScreen(response, who, "the configured roots changed — preview again", 400);

    const cloned = await (options.ghClone ?? cloneGithubRepo)(record.nameWithOwner, root, async (cwd: string) => {
      const answer = await execRun("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 15_000 });
      return { code: answer.code, stdout: answer.stdout };
    });
    if (!cloned.ok) return projectsScreen(response, who, cloned.message, 400);
    // The clone answer is BOUND to the record's exact target (verification
    // finding 2): whatever produced it — the real primitive or a test
    // hook — an answer naming any other path never enrolls or opens.
    if (cloned.target !== record.target) {
      return projectsScreen(response, who, "the clone answered with a different path than the preview promised — refused; nothing was enrolled", 400);
    }
    // authorizedProject AFTER the repository exists (finding 20).
    const proved = await authorizedProject(liveCeiling(), cloned.target);
    const admitted = proved ? (canonicalProject(cloned.target) ?? cloned.target) : null;
    if (admitted === null) {
      return projectsScreen(response, who, `the clone landed at ${cloned.target} but did not prove under the ceiling — it was left in place; enroll it by hand`, 400);
    }
    const joined = await admitProject(store, { registryFile: options.registryPath ?? null, path: admitted, actor: { label: who.name, origin: "console" }, now });
    if (!joined.ok) {
      return projectsScreen(response, who, `${cloned.target} is cloned but not added — ${joined.message}`, 400);
    }
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
    );
  }


  /**
   * The opener: every project inside the ceiling, most recently opened
   * first, plus repos the queue has seen — shown only when the ceiling
   * admits them — and an open-by-path field validated server-side. A
   * registry row never confers access; this page only offers what the
   * server was configured to allow.
   */
  async function projectsScreen(
    response: ServerResponse,
    who: Who,
    problem: string | null,
    status: number,
    returnTo = "/",
  ): Promise<void> {
    const now = clock();
    const recent = store.listProjects().filter(one => visible(one.path));
    const recentPaths = new Set(recent.map(one => one.path));
    const candidates = new Set<string>();
    for (const path of consoleProjects()) {
      const canonical = canonicalProject(path) ?? path;
      if (!recentPaths.has(canonical) && visible(canonical)) candidates.add(canonical);
    }
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
              : { enabled: true as const, roots: ceiling.roots, record: [...(who.session.onboard?.entries() ?? [])][0] ?? null };
    // A cheap peek per project for the switcher cards — one small set of
    // COUNTs each, scoped to the exact repo.
    const peekOf = (path: string) => {
      try {
        return projectFamilyPeek(path, now);
      } catch {
        return null;
      }
    };
    const peeks: Record<string, { waiting: number; queued: number; running: number; doneRecently: number } | null> = {};
    for (const one of recent) peeks[one.path] = peekOf(one.path);
    for (const path of candidates) peeks[path] = peekOf(path);
    return sendScreen(
      response,
      status,
      projectsPage(chromeFor(open, "projects"), recent, [...candidates], open, problem, !restricted() && unscopedMode, !restricted() && (ceiling.roots.length > 0 || unscopedMode), onboardState, peeks, returnTo, who.via === "cookie" ? (path: string) => publishingOf(store, path).on : undefined,
        who.via === "cookie" ? (path: string) => projectCheckLevel(store, path).level : undefined),
    );
  }
  async function healthzEdge(ctx: EdgeContext): Promise<void> {
    const { response, method } = ctx;
    return healthz(store, response, method === 'HEAD');
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

  const registrations = handlersOf("pages", {
    "projects.browse": projectsBrowse,
    "projects.github": projectsGithub,
    "projects.page": projectsIndex,
    "home": homeRedirect,
    "morning": morningAlias,
    "workbench": workbench,
    "ledger": ledgerPage,
    "activity": activityPage,
    "system": systemScreen,
    "peek": peekPage,
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
    "edge.browser-asset": browserAsset,
    "edge.workspace-style": workspaceStyle,
    "edge.install-asset": installAsset,
    "edge.font": fontAsset,
    "edge.desktop-health": desktopHealth,
  });
  return { registrations, projectsScreen };
}
