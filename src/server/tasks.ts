import type { Registration } from './handler-registry.js';
/** tasks handlers, moved without changing their route bodies. */
import { createHash,randomBytes,randomUUID } from "node:crypto";
import { lstatSync,realpathSync } from "node:fs";
import { type IncomingMessage,type ServerResponse } from "node:http";
import { withActor } from "../actor.js";
import { gateWords } from "../approval-policy.js";
import { acceptAndCompleteAsOperator,assignmentOf,checkAssignmentAsOperator } from '../assignment.js';
import { attentionCardForUnverifiedDone,classify } from "../board.js";
import { codingHandoffPreview,createCodingHandoff } from '../coding-handoff.js';
import { codingShippingHtml } from '../coding-shipping-ui.js';
import { codingWorkspaceHtml,codingWorkspaceScript } from '../coding-ui.js';
import { CodingActionError } from '../coding-workspace.js';
import { abandonContest,buildPickView,computePickPlan,finalizeContestPick,nonceHashOf,pickTupleDigest,planComparison,planTournament } from "../contest.js";
import { checkResponse,CONSOLE_FORMS,readForm,type FormFieldOf,type FormView } from "../contracts/console-api.js";
import { hasForbiddenControls,validateNote } from "../decision.js";
import { diagnoseTaskDispatch } from "../dispatch.js";
import { evidencePack,evidencePackHtml } from "../evidence-pack.js";
import { readVerifiedArtifact,readVerifiedReport,writeEvidenceFile } from "../evidence.js";
import { computeGaps } from "../gaps.js";
import { limitsView } from "../limits-ui.js";
import { readLiveWindow } from "../live.js";
import { modeTermsFromJson } from "../modes.js";
import { latestFinishedAttempt,retryNoteOf } from '../needs-you.js';
import { REMOTE_MESSAGES } from "../operate-remote.js";
import { aggregateNewNames,observeWorktree,parseBaseTreeSnapshot,PEEK_LIMITS } from "../peek.js";
import { isRiskLevel,isTaskSize,PHASES as ROUTE_PHASES,type RiskLevel,type RouteOverride } from "../phase-routing.js";
import { applyModeToNewFiling,authorizePlanUnderMode } from "../plan-auto.js";
import { milestonesOf,parseExecutionPlanDocument } from "../plan.js";
import { levelOfProfile } from "../policy.js";
import {
authorizedProject,
canonicalProject,
projectName,
rowVisible
} from "../project.js";
import { fileRoutineProposal,fileTaskProposal } from "../proposal.js";
import { isProviderId,validateSpec,type ProviderId } from "../provider.js";
import { completeAndOpenPullRequest,mergeAsPerson } from '../pull-request-flow.js';
import { isQualityMode,type QualityMode } from "../quality.js";
import { createResultRevision,requestResultChanges } from "../result-actions.js";
import { structuredHandoffView,terminalDiffView,type TerminalDiffView } from "../result-evidence-readers.js";
import { fileAddTestsTask,requestFollowUpChecks } from '../result-follow-ups.js';
import {
commentSourceKey,
isRevisionFeedback,
parseResultTab,
resultReturnTarget
} from "../result-review.js";
import { approveRoutine,fireRoutine,refreshRoutineAgents,routineAgentsState } from "../routine.js";
import { isAlive as runnerAlive } from "../runner.js";
import {
acceptanceLinesToInput,
acceptanceToLines,
approvalOf,
approve as approveScope,
attendedDigestOf,
attendedTermsJson,
canonicalProfileJson,
hasFreshIdentitySignIn,
modeFilingCoverage,PLACEHOLDER_RUBRIC,
profileDigestOf,
profileFromJson,
proposeGuarded,
type AttendedTerms,
type UnattendedPermissionMode
} from "../scope.js";
import { teammateNames as teammateNamesOf } from "../spend.js";
import {
verifiedAuthor,
type Artifact,
type Run,
type Store,
type TaskState
} from "../store.js";
import { runCostWords } from "../summary.js";
import { composerSchedule } from "../task-composer.js";
import { requestTaskStop,resumeTaskStop } from "../task-control.js";
import { templateByName } from "../templates.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { WorkIndexCursorError,workIndexPage,type WorkIndexItem,type WorkIndexPage } from "../work-index.js";
import {
buildProgressOf,
parseWorkView
} from "../workspace-ui.js";
import type { HandlerContext } from './handler-context.js';
import type { ServerRuntime } from './runtime.js';
import { ACCEPT_ANYWAY_NEEDS_REASON,approvalFormDigest,approveRefusalWords,attendedWatchWords,boardBody,chatReturnWithSaid,checkProgressHtml,consentDoorOf,contestCeremonyPage,contestPage,decisionPage,donePage,editorFileHref,escape,inboxFingerprints,inboxPage,matchTaskPath,newTaskPage,nextPage,oneLineOf,parseInboxTab,PermissionsWouldChange,proofBundleView,QUEUE_FRONT,QUEUE_VIEW,queueBody,queueScript,rankReviewQueue,redirect,refuse,regionScript,requestContext,requirementsFromEditor,respond,RESULT_REFUSALS,resumeDigestOf,REVIEW_QUEUE_CAP,reviewCockpitPage,reviewHref,reviewPriorityOf,routineScreenPage,routinesPage,runFactsFragment,runOutcomeBadge,runPage,RUNS_PAGE,runsPage,safeChatReturn,safeReturn,SAFETY,screen,TASK_STATES,taskChatHref,taskHref,taskOf,tasksPage,transcriptScript,whenTime,withRefusal,workPage,type CompletedWorkRow,type InboxTab,type PeekAdmission,type RankedReviewRow,type ReviewCockpitView,type Who } from "./shared.js";
export function createTasksHandlers(runtime: ServerRuntime) {
  const { store, peekSay, peekCache, PEEK_CACHE_TTL_MS, peekInFlight, PEEK_GLOBAL_INFLIGHT, peekBySession, PEEK_SESSION_INFLIGHT, clock, peekName, PEEK_FRAGMENT_BYTES, peekEvict, evidenceRoot, sendScreen, chromeFor, visible, consumeApprovalNonce, authenticateApprover, allowedHost, options, mintApprovalNonce, taskScreen, unscopedMode, admissionList, planViewOf, revisionViewOf, runIsTaskResult, matePrincipal, familyOf, armTaskResume, runIsLive, revisionLedgerOf, resultDetailOf, reviewFactsFor, taskRepoOf, runVisible, restricted, codingActorAllowed, codingProjectAllowed, managedRepos, routeViewOf, workAccess, firstRunStepsNow, revisionDocOf, failureOf, dockedConversation, planContractViewOf, familiesInView, explainAttempt, taskChatFocus, familyTasksInView, taskRooms, identify, liveCeiling, projectOf, ceiling, bustBadge, revisionDestination } = runtime;

  async function get(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, now, project, chosenProject, posted, route } = ctx;


    if (url.pathname === '/code' || url.pathname.startsWith('/code/')) {
      if (who.via !== 'cookie' || !codingActorAllowed({ name: who.name, generation: who.session.generation })) return refuse(response, who, 403, 'Coding sessions require installation-wide operator access. You can manage project tasks in Work.', '/work');
      const actor = { name: who.name, generation: who.session.generation };
      const match = /^\/code\/([a-f0-9]{32})(?:\/(state|changes|ship))?$/.exec(url.pathname);
      try {
        const selected = match && runtime.coding ? runtime.coding.get(match[1]!, actor) : null;
        if (selected && !codingProjectAllowed(selected.repo)) return refuse(response, who, 403, 'That project is outside your access.', '/projects');
        if (match?.[2] === 'ship' && selected) {
          const preview = codingHandoffPreview(store, { sessionId: selected.id, actor: who.name });
          return sendScreen(response, 200, screen('Review for shipping', codingShippingHtml(preview, who.session.csrf), { chrome: chromeFor(selected.repo, 'code') }));
        }
        if (match?.[2]) {
          if (!selected || !runtime.coding) throw Error('The coding session is unavailable.');
          if (match[2] === 'state' && url.searchParams.get('revision') === String(runtime.coding.revision(selected.id, actor))) return respond(response, 200, 'application/json', JSON.stringify({ unchanged: true }));
          const result = match[2] === 'changes' ? await runtime.coding.changes(selected.id, actor) : runtime.coding.snapshot(selected.id, actor);
          if (!codingActorAllowed(actor) || !codingProjectAllowed(selected.repo)) return respond(response, 403, 'application/json', JSON.stringify({ ok: false, error: 'Your access changed. Sign in again.' }));
          return respond(response, 200, 'application/json', JSON.stringify(result));
        }
        if (url.pathname !== '/code' && !match) return refuse(response, who, 404, 'Coding session not found.', '/code');
        const requestedProject = url.searchParams.get('project');
        if (requestedProject !== null && (!visible(requestedProject) || ![...managedRepos(), ...store.listProjects().map(p => p.path)].includes(requestedProject))) return refuse(response, who, 403, 'That project is outside your access.', '/projects');
        const codeProject = selected?.repo ?? requestedProject ?? project;
        const chrome = chromeFor(codeProject, 'code');
        const content = codingWorkspaceHtml({ owner: who.name, projects: chrome.projects ?? [], sessions: runtime.coding?.list(actor).filter(s => codingProjectAllowed(s.repo)) ?? [], selected: selected && runtime.coding ? runtime.coding.snapshot(selected.id, actor) : null, csrf: who.session.csrf, project: codeProject, available: runtime.coding !== null, ...(runtime.codingProblem ? { error: runtime.codingProblem } : {}) });
        return sendScreen(response, 200, screen('Code', content, { chrome, functional: { script: codingWorkspaceScript(), fetches: true } }));
      } catch (error) {
        if (!codingActorAllowed(actor)) return match?.[2] && match[2] !== 'ship'
          ? respond(response, 403, 'application/json', JSON.stringify({ ok: false, error: 'Your access changed. Sign in again.' }))
          : refuse(response, who, 403, 'Your access changed. Sign in again.', '/work');
        const message = error instanceof Error ? error.message : 'The coding workspace is unavailable.';
        if (match?.[2] === 'ship') return sendScreen(response, 409, screen('Review for shipping', `<h1>Prepare this result</h1><p>${escape(message)}</p><a href="/code/${match[1]}">Back to coding</a>`, { chrome: chromeFor(project, 'code') }));
        if (match?.[2]) return respond(response, 409, 'application/json', JSON.stringify({ ok: false, error: message }));
        return sendScreen(response, 404, screen('Coding session unavailable', `<h1>Session unavailable</h1><p>${escape(message)}</p><a href="/code">Open coding workspace</a>`, { chrome: chromeFor(project, 'code') }));
      }
    }

    if (url.pathname === "/inbox") {
      // With no project open in scoped mode this is the ROLL-UP inbox:
      // admission binds inside the bounded queries, every row's repo is
      // re-proved here, and rows render as links only (Codex roll-up
      // review, findings 6–8). Gaps stay per-project — they are derived
      // against one repo's capabilities and roll up dishonestly.
      const rollup = project === null && !unscopedMode;
      const admission = rollup ? admissionList() : null;
      const cancelled = store
        .listCancelledBlockersScoped(project, 10, admission)
        .filter(one => visible(one.repo) && visible(one.blockerRepo));
      const inboxData = {
          csrf: who.via === "cookie" ? who.session.csrf : "",
          revision: who.via === "cookie" ? who.session.projectRevision : 0,
          rollup,
          interactive: project !== null,
          decisions: store.listDecisionsScoped(project).filter(one => visible(one.repo)).slice(0, 10),
          // Each waiting scope wears its consent door (v48 authority repair): a scope whose
          // approval is closed — unreadable route, a route that cannot run,
          // a pre-routing row whose approval lapsed — reads as needing
          // attention, never as something to approve.
          approvals: store.scopesAwaitingApproval(project, 10, admission).filter(one => visible(one.repo)).map(one => {
            const ref = store.lookupRef(one.taskId);
            const scope = store.getScope(one.taskId);
            const door = consentDoorOf(scope, routeViewOf(one.taskId, ref, scope, now, who));
            return { ...one, closed: door.open ? null : door.title };
          }),
          requeueables: store.listRequeueablesScoped(project, now, 10, admission).filter(one => visible(one.repo)),
          needsVerification: store
            .listCompletedWorkScoped(project, 10, admission)
            .filter(one => visible(one.repo) && (one.proofVerdict === "short" || one.proofVerdict === "refuted") && !one.proofAccepted &&
              assignmentOf(store, one.taskId, now, workAccess(), evidenceRoot) === null)
            .map(one => ({
              taskId: one.taskId,
              title: one.title,
              verdict: one.proofVerdict as "short" | "refuted",
              repo: one.repo,
              matrix: one.proofMatrix,
              repairChain: one.runId === null ? null : store.repairChainFor(one.runId),
            })),
          cancelledBlockers: cancelled,
          gaps: project === null ? [] : computeGaps(store, project, now).filter(gap => gap.unblocks.length > 0).slice(0, 10),
          wizard: firstRunStepsNow(now),
          worker: (() => {
            // The one fact the inbox must never hide (install review): with
            // no worker answering, nothing here will ever build, and every
            // approval below is a promise nobody is there to keep.
            const runners = store.listRunners().filter(one => one.retiredAt === null && (!restricted() || one.repos.some(visible)));
            const answering = runners.filter(one => runnerAlive(one, now));
            const lastHeard = runners.map(one => one.heartbeatAt).sort().at(-1) ?? null;
            return { answering: answering.length, registered: runners.length, lastHeard };
          })(),
          now,
          // Console v2: results ready to review and work running now, from the same admitted work index.
          ...(() => {
            const row = (one: WorkIndexItem) => ({ taskId: one.rootId, title: one.title, detail: one.status.detail, repo: one.repo });
            const needsYou = workIndexPage(store, now, workAccess(), { view: "needs-you", limit: 40, project });
            const runningNow = workIndexPage(store, now, workAccess(), { view: "running", limit: 40, project });
            return { ready: needsYou.items.filter(one => one.assignmentState === "ready-to-check").map(row), running: runningNow.items.map(row) };
          })(),
      };
      // Which tabs hold something new since this browser last looked (the dots on a phone).
      const tab = parseInboxTab(url.searchParams.get("tab")) ?? "all";
      const prints = inboxFingerprints(inboxData);
      const seenWords = /(?:^|;\s*)so-inbox-seen=([0-9a-f]{8}(?:\.[0-9a-f]{8}){3})(?:;|$)/.exec(request.headers.cookie ?? "")?.[1]?.split(".") ?? null;
      const order = ["needs-you", "ready", "running", "all"] as const;
      const seen = Object.fromEntries(order.map((one, index) => [one, seenWords?.[index] ?? ""])) as Record<InboxTab, string>;
      const unread = order.filter(one => seenWords !== null && seen[one] !== prints[one]);
      for (const one of order) if (tab === "all" || one === tab) seen[one] = prints[one];
      response.setHeader("Set-Cookie", `so-inbox-seen=${order.map(one => seen[one] || prints[one]).join(".")}; SameSite=Lax; Path=/; Max-Age=31536000`);
      return sendScreen(response, 200, inboxPage(chromeFor(project, "inbox"), { ...inboxData, tab, unread }));
    }

    if (url.pathname === "/work") {
      // The Work destination (workspace package 1): every task in view as
      // one row wearing the shared status projection, with All, Needs you,
      // Running, and Completed as shortcuts over the same rows — never a
      // persisted state. With no project open in scoped mode this rolls
      // up like the inbox: admission binds the query and every row's repo
      // is re-proved here.
      const view = parseWorkView(url.searchParams.get("view"));
      const rollup = project === null && !unscopedMode;
      let work: WorkIndexPage;
      try {
        work = workIndexPage(store, now, workAccess(), { view, limit: 40, cursor: url.searchParams.get('cursor'), project });
        const facts = requestContext.getStore();
        if (facts !== undefined) {
          // These counts cover the exact admitted project lens, including
          // unplaced tasks where permitted. Crew excludes unplaced rows.
          if (project === null) facts.workCounts = work.projects;
          const admitted = workAccess().repos;
          const crewLens = project !== null || admitted !== null && JSON.stringify([...admitted].sort()) === JSON.stringify(managedRepos().sort()) && !work.projects.some(one => one.repo === null);
          if (view === 'all' && !url.searchParams.has('cursor') && crewLens) facts.workCrew = { project, page: work };
        }
      } catch (error) {
        if (error instanceof WorkIndexCursorError) return refuse(response, who, 400, 'This task page has expired. Open the first page.', '/work');
        throw error;
      }
      // A failed row says what its latest attempt missed, as its task page does (a stop reason already reads so), from
      // the database alone: a row reads no check log. A live build's row says which step it is on, or the step it is
      // stuck on, from that live attempt's own progress only, never a stopped attempt's; the step's words come from its
      // current plan (one saved file, for live rows only), and without it the row names the step by number.
      work = { ...work, items: work.items.map((item): WorkIndexItem & { progress?: string } => {
        if (item.liveRunId !== null) {
          const ref = store.lookupRef(item.activeTaskId);
          const recorded = ref === null ? null : store.latestCheckpointForRun(item.liveRunId);
          if (ref === null || recorded === null || recorded.taskRef !== ref.id) return item;
          const plan = store.currentPlanRevision(ref.id);
          const parsed = plan === null ? null : (() => { const doc = revisionDocOf(plan); return doc === null ? null : parseExecutionPlanDocument(doc.document); })();
          const words = new Map(parsed?.ok === true ? milestonesOf(parsed.document).map(one => [one.id, one.description] as const) : []);
          const steps = buildProgressOf(recorded.snapshot.milestones.map(one => ({ description: words.get(one.id) ?? null, state: one.state, note: one.note ?? null })));
          return steps === null ? item : { ...item, progress: steps.line };
        }
        if (item.state !== "failed") return item;
        const family = familyOf(item.activeTaskId);
        if (family === null || family.problem !== null) return item;
        const failure = failureOf(family.versions.flatMap(version => store.runsFor(version.refId)), null, false);
        return failure.kind === "reason" ? item : { ...item, status: { ...item.status, detail: failure.line } };
      }) };
      const page = workPage(chromeFor(project, "work", undefined, rollup ? "all" : undefined), {
        view,
        ...(url.searchParams.has('project') && project !== null ? { projectFilter: project } : {}),
        work,
        previous: url.searchParams.has('cursor'),
        multiProject: new Set(work.items.map(task => task.repo ?? "")).size > 1,
        now,
        // v105: subscription windows and monthly budgets, for whoever runs the installation.
        limits: store.isInstanceOperator(who.name)
          ? limitsView(store.providerLimits(), store.budgets().length === 0 ? [] : store.monthSpendCached(now).budgets, { project: projectName, teammate: id => teammateNamesOf(store.handle).get(id) ?? `Teammate ${id}` }, now)
          : null,
      });
      // One project's Tasks dock that project's own conversation (v77).
      const projectThread = url.searchParams.has('project') && project !== null && managedRepos().includes(project) ? project : null;
      const docked = projectThread === null ? null : dockedConversation(who, null, projectThread, now, `/work?project=${encodeURIComponent(projectThread)}`);
      if (docked !== null) page.workspace = { ...page.workspace, conversation: docked, pageHtml: page.body };
      // Without a docked chat the list reads itself: 10 s while any of its tasks is building, else 30 s.
      page.refreshSeconds = work.totals.running > 0 ? 10 : 30;
      return sendScreen(response, 200, page);
    }

    if (url.pathname === "/next") {
      // Triage: everything waiting on a person, one at a time, hardest-
      // blocked first — oldest question, then plans and scopes to approve,
      // then stalled work to retry, then requirement gaps. `skip` is a
      // bounded, session-free cursor of keys the operator set aside; every
      // act 303s back here, which is what makes it a flow and not a list.
      const skipped = new Set(
        (url.searchParams.get("skip") ?? "").split(",").filter(one => /^[darg]:[A-Za-z0-9._:-]{1,80}$/.test(one)).slice(0, 20),
      );
      const decisions = store.listDecisionsScoped(project).filter(one => one.state !== "answered");
      const approvals = store.scopesAwaitingApproval(project, 20);
      const requeueables = store.listRequeueablesScoped(project, now, 20);
      const gaps = project === null ? [] : computeGaps(store, project, now).filter(gap => gap.unblocks.length > 0);
      type Item =
        | { key: string; kind: "decision"; decision: (typeof decisions)[number] }
        | { key: string; kind: "approval"; approval: (typeof approvals)[number] }
        | { key: string; kind: "requeue"; stalled: (typeof requeueables)[number] }
        | { key: string; kind: "gap"; gap: (typeof gaps)[number] };
      const queue: Item[] = [
        ...decisions.map(decision => ({ key: `d:${decision.id}`, kind: "decision" as const, decision })),
        ...approvals.map(approval => ({ key: `a:${approval.taskId}`, kind: "approval" as const, approval })),
        ...requeueables.map(stalled => ({ key: `r:${stalled.taskId}`, kind: "requeue" as const, stalled })),
        ...gaps.map(gap => ({ key: `g:${gap.key.replace(/[^A-Za-z0-9._:-]/g, "_")}`, kind: "gap" as const, gap })),
      ];
      const remaining = queue.filter(one => !skipped.has(one.key));
      const item = remaining[0] ?? null;
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      if (item !== null && item.kind === "approval") {
        // The card restates the digest-bound terms, so the nonce may be
        // minted here — same rule as the task screen, same binding.
        const ref = store.lookupRef(item.approval.taskId);
        const scope = store.getScope(item.approval.taskId);
        const planView = ref !== null && ref.plan === "drafted" ? planViewOf(ref.id) : null;
        const raceTerms = ref === null ? null : store.activeTournamentTerms(ref.id);
        const approvalDigest = approvalFormDigest(item.approval.digest, raceTerms?.raceDigest ?? null, planView?.sha256 ?? null);
        // The same agents block the task page and chat sign under (v48),
        // and the same consent door: closed, it mints no nonce.
        const route = routeViewOf(item.approval.taskId, ref, scope, now, who);
        const nonce = who.via === "cookie" && consentDoorOf(scope, route).open ? mintApprovalNonce(who.name, item.approval.taskId, approvalDigest) : "";
        return sendScreen(response, 200, nextPage(chromeFor(project, "inbox"), {
          item, scope,
          planDocument: planView?.document ?? null,
          planContract: ref === null || planView === null ? null : planContractViewOf(ref.id, scope),
          approvalDigest,
          raceTerms,
          deliverable: ref?.deliverable ?? "branch",
          route,
          csrf, nonce, remaining: remaining.length, skipped: [...skipped], now,
        }));
      }
      return sendScreen(response, 200, nextPage(chromeFor(project, "inbox"), {
        item, scope: null, planDocument: null, planContract: null, csrf, nonce: "",
        approvalDigest: null, raceTerms: null, route: null,
        remaining: remaining.length, skipped: [...skipped], now,
      }));
    }

    if (url.pathname === "/board") {
      // scope=all is the rolled-up view: every project this server was
      // allowed to serve, on one board. The ceiling still rules row by row
      // (rowVisible, the same predicate as every list) — a repo outside
      // the server's configuration never renders a card, whatever the
      // database holds. Unplaced work (repo NULL) appears: it dispatches
      // anywhere, so every board honestly owns it.
      const all = url.searchParams.get("scope") === "all";
      // Roll-up admission happens BEFORE the query limit (Codex round 2,
      // finding 11) — and root ceilings enumerate too, through the STORED
      // repos that pass the ceiling (attended review, finding 3); the
      // per-row visible() re-check below stays either way.
      const admission = all ? admissionList() : null;
      const snapshot = store.boardScoped(all ? null : project, now, 200, admission);
      const admitted = all
        ? snapshot.tasks.filter(facts => facts.repo === null || visible(facts.repo))
        : snapshot.tasks;
      const done = all
        ? snapshot.done.filter(row => row.repo === null || visible(row.repo))
        : snapshot.done;
      // A blocker may live in a repo this server must not speak about —
      // redact its state before the pure classifier composes a sentence
      // from it (Codex round 2, finding 12). The dependency's NAME stays:
      // the edge belongs to the visible task; the other project's live
      // status does not.
      const cards = admitted.map(facts =>
        classify(
          facts.blockerRepo !== null && !visible(facts.blockerRepo)
            ? { ...facts, blockerState: null }
            : facts,
          now,
        ),
      );
      // "Since you last looked": what concluded between this session's
      // previous full board read and now. Fragment polls never move the
      // anchor — an open tab is not a person looking.
      let delta: { agoMinutes: number; built: number; failed: number; questions: number } | null = null;
      if (who.via === "cookie" && url.searchParams.get("fragment") !== "1") {
        const prev = who.session.sawBoardAt;
        if (prev !== null && now.getTime() - prev > 5 * 60_000) {
          const sinceIso = new Date(prev).toISOString();
          const runs = store.runsSinceScoped(sinceIso, all ? null : project).filter(one => all ? one.taskId !== "" : true);
          delta = {
            agoMinutes: Math.round((now.getTime() - prev) / 60_000),
            built: runs.filter(one => one.outcome === "built" || one.outcome === "no-change").length,
            failed: runs.filter(one => one.outcome === "failed").length,
            questions: store.listDecisionsScoped(all ? null : project).filter(one => one.createdAt >= sinceIso && one.state !== "answered").length,
          };
          if (delta.built === 0 && delta.failed === 0 && delta.questions === 0) delta = null;
        }
        who.session.sawBoardAt = now.getTime();
      }
      const buildingCount = cards.filter(card => card.lane === "building").length;
      // A completed task whose proof is short or refuted and not yet
      // accepted (Priority 2) reads "needs verification", not done — the
      // board's once-and-only-once rule holds because this split is the
      // ONE place a done row becomes either lane; the done-lane render
      // below never sees the rows filtered out here.
      const unverifiedDone = done.filter(
        row => (row.proofVerdict === "short" || row.proofVerdict === "refuted") && !row.proofAccepted,
      );
      const verifiedDone = done.filter(row => !unverifiedDone.includes(row));
      const unverifiedCards = unverifiedDone.map(row => {
        // v40: the SAME chip gains one more word when a repair chain
        // exists for this row's own run — never a second card.
        const chain = row.runId === null ? null : store.repairChainFor(row.runId);
        const repairChain =
          chain === null
            ? null
            : {
                attempt: chain.attempt,
                outcome: chain.outcome,
                approved: chain.draftTask !== null && (store.getScope(chain.draftTask)?.approvedAt ?? null) !== null,
              };
        return attentionCardForUnverifiedDone({
          taskId: row.taskId,
          title: row.title,
          repo: row.repo,
          completedAt: row.completedAt,
          proofVerdict: row.proofVerdict as "short" | "refuted",
          proofMatrix: row.proofMatrix,
          repairChain,
        });
      });
      // Instances belong to their track row, not the main lanes — the board
      // is for one-off work; tracks are the heartbeat. The one exception is
      // attention: anything needing a person surfaces, wearing its routine.
      const laneCards = [...cards.filter(card => card.routineName === null || card.lane === "attention"), ...unverifiedCards];
      const tracks = store
        .routineTracks(all ? null : project, now, admission)
        .filter(track => visible(track.routine.repo));
      const body = boardBody(
        { cards: laneCards, tracks, done: verifiedDone, saturated: snapshot.saturated, now, all, project, delta },
        pr => store.ciFailureObserved(pr),
      );
      if (url.searchParams.get("fragment") === "1") {
        // The live region alone — the in-page swapper's diet. Same auth,
        // same ceiling, no shell, no scripts (finding 2).
        return respond(response, 200, "text/html; charset=utf-8", body);
      }
      if (url.searchParams.get("view") === "order") {
        // The board's ORDER view (operator request): the same screen, flipped
        // to dispatch order with the queue's drag handles. Reordering and
        // reserving are scheduling, not authority, so this is the one view
        // where a drag does anything; the state view stays a view.
        const csrf = who.via === "cookie" ? who.session.csrf : "";
        const revision = who.via === "cookie" ? who.session.projectRevision : 0;
        const region = queueRegionFor(project, csrf, revision, now);
        return sendScreen(
          response,
          200,
          screen("board", [
            `<h1>Board</h1>`,
            `<p class="meta board-view"><a href="/board">state</a> \u00b7 <strong>order</strong> <span class="meta">\u2014 drag to reorder, or onto a worker to reserve; the state view is where cards move on their own</span></p>`,
            `<div id="queue-region">${region}</div>`,
            `<p class="meta" id="queue-region-stamp"></p>`,
          ].join("\n"), { chrome: chromeFor(project, "board"), functional: { script: queueScript(), fetches: true } }),
        );
      }
      const regionBody = `<div id="board-region">${body}</div><p class="meta" id="board-region-stamp"></p>`;
      return sendScreen(
        response,
        200,
        screen("board", regionBody, {
          chrome: chromeFor(project, "board", undefined, all ? "board-all" : undefined),
          functional: { script: regionScript("board-region", "1", buildingCount > 0 ? 10 : 30), fetches: true },
        }),
      );
    }

    if (url.pathname === "/review") {
      // The review cockpit (Priority 5): every visible COMPLETED task,
      // ranked by review priority, with one selected result projected
      // from the records the task, run, and done pages already read —
      // scope, plan, run, artifacts, verdict, contest, publication. The
      // ranking is a labeled presentation aid: it never rewrites the
      // stored verdict, and the sealed patch downloads exactly as stored.
      // Admission binds BEFORE the SQL limit (the done page's own rule),
      // and every row is re-proved against the ceiling before ranking.
      const resultRow = (row: CompletedWorkRow) => {
        const assignment = assignmentOf(store, row.taskId, now, workAccess(), evidenceRoot);
        return { ...row, proofReasons: row.runId === null ? [] : store.proofVerdictFor(row.runId)?.reasons ?? [], ciFailing: ciFailingFor(row.runId, row.prNumber),
          assignment: assignment?.activeTaskId === row.taskId && (assignment.receipt?.runId ?? null) === row.runId ? assignment : null };
      };
      const rows = familiesInView(project, { states: ["done"], limit: REVIEW_QUEUE_CAP }).flatMap(family => {
          const row = completedRowFor(family.current.id, project);
          return row === null ? [] : [{ ...resultRow(row), title: family.root.title }];
        });
      const ranked = rankReviewQueue(rows);
      const wanted = url.searchParams.get("result");
      const wantedId =
        wanted === null || wanted.length === 0 || wanted.length > 64 || hasForbiddenControls(wanted) ? null : wanted;
      const inQueue = wantedId === null ? null : ranked.find(one => one.taskId === wantedId) ?? null;
      // A stable deep link outlives the queue window (v2 review, comment
      // 1): a completion older than the newest REVIEW_QUEUE_CAP resolves
      // directly — re-proved as done, in this project, and inside the
      // ceiling — so an old receipt never reads as unfinished or foreign.
      // The ranked queue itself stays bounded and says so.
      const beyond = wantedId === null || inQueue !== null ? null : completedRowFor(wantedId, project);
      const beyondRow = beyond === null ? null : resultRow(beyond);
      const completedChoice = inQueue ?? (beyondRow === null ? null : { ...beyondRow, priority: reviewPriorityOf(beyondRow) });
      const expectedRun = url.searchParams.get("run");
      const namedRun = expectedRun !== null && /^[1-9]\d*$/.test(expectedRun) ? Number(expectedRun) : null;
      // A build that failed (or stopped) has its own result page too: the run named, or a failed task's latest attempt.
      const attempt = wantedId === null || (completedChoice !== null && (namedRun === null || completedChoice.runId === namedRun)) ? null : attemptRowFor(wantedId, namedRun, project);
      const attemptRow = attempt === null ? null : resultRow(attempt);
      const chosen = attemptRow !== null ? { ...attemptRow, priority: reviewPriorityOf(attemptRow) } : completedChoice;
      const selectedRow = wantedId === null ? ranked[0] ?? null : chosen;
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      // An exact link to a result this person can't see (or that never existed) reads the same either way.
      if (expectedRun !== null && wantedId !== null && chosen === null) return refuse(response, who, 404, "No such result in your projects.", "/work");
      if (expectedRun !== null && (!/^[1-9]\d*$/.test(expectedRun) || selectedRow?.runId !== Number(expectedRun))) {
        return sendScreen(response, 409, screen("Result changed", '<h1>Result changed</h1><p>This acceptance link no longer matches the current result. Review the current task before accepting.</p><p class="refusal-back"><a class="button-link" href="/review">Review results</a></p>', { chrome: chromeFor(project, "runs") }));
      }
      const selected = selectedRow === null ? null : reviewCockpitViewOf(selectedRow, who, now);
      // A build that delivered nothing reads Failed here, and so does a failed task's delivered result: what went wrong
      // is the card and Retry the ink act. That result may still be accepted, but only in outline, as Accept anyway, with
      // a reason.
      const delivered = selected?.run?.outcome === "built" || selected?.run?.outcome === "no-change";
      const failedTask = selected === null ? null : store.getTask(selected.taskId);
      if (selected !== null && attemptRow !== null && selected.run !== null && (!delivered || failedTask?.state === "failed")) {
        const attemptRun = store.getRun(selected.run.id);
        const runs = attemptRun === null ? [] : store.runsFor(attemptRun.taskRef);
        const latest = latestFinishedAttempt(runs);
        // Retry from here only when the task failed, nothing holds it, and this is its latest attempt or a result it delivered.
        const retry = failedTask?.state === "failed" && (latest?.id === selected.run.id || delivered) && csrf !== "" && who.role === "approver" && store.currentLiveLease(attemptRun!.taskRef, now) === null
          ? { action: `${taskHref(selected.taskId)}/requeue` } : null;
        // Accept anyway: the same acceptance this task's latest result takes, never for an older one or one already accepted.
        const family = delivered ? familyOf(selected.taskId) : null;
        const acceptAnyway = delivered && csrf !== "" && who.role === "approver" && family?.current.id === selected.taskId && family.problem === null &&
          runs.find(runIsTaskResult)?.id === selected.run.id && store.proofAcceptance(selected.run.id) === null
          ? { action: `${taskHref(selected.taskId)}/accept-proof`, run: selected.run.id } : null;
        if (attemptRun !== null) {
          // A delivered result didn't fail itself: the task's failure is its latest attempt's.
          const failure = delivered ? failureOf(runs, null) : explainAttempt(attemptRun, null);
          selected.failure = { ...failure, retry: retry === null ? null : { ...retry, note: retryNoteOf(failure.suggestion) }, ...(acceptAnyway === null ? {} : { acceptAnyway }) };
        }
      }
      const reviewPage = reviewCockpitPage(chromeFor(wantedId === null ? project : chosenProject, "runs"), {
          queue: ranked,
          queueCap: REVIEW_QUEUE_CAP,
          selected,
          beyondQueue: beyond !== null && attemptRow === null,
          // A deep link to a result this console cannot show — not done,
          // not admitted, or never existed — says so in one sentence and
          // shows the top of the queue; the three cases read identically.
          missing: wantedId !== null && chosen === null ? wantedId : null,
          csrf,
          canRetryReview: who.via === "cookie" && who.role === "approver",
          noted: url.searchParams.get("noted") !== null,
          refusal: Object.hasOwn(RESULT_REFUSALS, url.searchParams.get("refused") ?? "") ? RESULT_REFUSALS[url.searchParams.get("refused")!]! : null,
          tab: parseResultTab(url.searchParams.get("tab")),
          user: who.name,
          now,
        });
      // The result's task conversation, docked beside it (v77); messages
      // sent here carry the result being viewed.
      const reviewFocus = selected === null ? null : taskChatFocus(selected.taskId, now, who, { mintNonce: false });
      const reviewDocked = reviewFocus === null || selected === null ? null
        : dockedConversation(who, reviewFocus, null, now, reviewHref(selected.taskId), selected.run !== null && reviewFocus.family.versions.some(one => one.refId === store.getRun(selected.run!.id)?.taskRef) ? selected.run.id : null);
      if (reviewDocked !== null) reviewPage.workspace = { ...reviewPage.workspace, conversation: reviewDocked, pageHtml: reviewPage.body };
      return sendScreen(response, 200, reviewPage);
    }

    if (url.pathname === "/done") {
      return sendScreen(
        response,
        200,
        donePage(chromeFor(project, "runs"), store.listCompletedWorkScoped(project, 50), pr => store.ciFailureObserved(pr)),
      );
    }

    if (url.pathname === "/tasks") {
      const wanted = url.searchParams.get("state");
      if (wanted !== null && !TASK_STATES.includes(wanted as TaskState)) {
        return refuse(response, who, 400, "no such state", "/tasks");
      }
      // ?template=<name> pre-fills the add form from the shipped library —
      // a pre-filled form and nothing more; the submission path is the
      // same guarded handler either way.
      const fromTemplate = url.searchParams.get("template");
      const picked = fromTemplate === null ? null : templateByName(fromTemplate);
      const prefill =
        picked !== null && picked.kind === "task"
          ? {
              title: picked.title, goal: picked.goal, not: picked.outOfScope ?? "", touches: picked.touches.join(", "),
              acceptance: acceptanceToLines(picked.acceptance).join("\n"),
            }
          : null;
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      return sendScreen(
        response,
        200,
        tasksPage(
          chromeFor(project, "tasks"),
          familyTasksInView(project, wanted === null ? undefined : (wanted as TaskState)).slice(0, 200),
          wanted as TaskState | null,
          csrf,
          null,
          project,
          prefill,
          store.permissionDefault().mode,
          store.qualityDefault().mode,
          store.replacements(),
        ),
      );
    }

    if (url.pathname === "/queue") {
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      const revision = who.via === "cookie" ? who.session.projectRevision : 0;
      // Column headers read one thing beyond the queue snapshot: live claims
      // in THIS project, per worker (the capacity is global; attended claims
      // may exceed it), so the header names both and never a ratio.
      if (url.searchParams.get("fragment") === "1") {
        return respond(response, 200, "text/html; charset=utf-8", queueRegionFor(project, csrf, revision, clock()));
      }
      // The queue is the board's order view (reduction pass §1): the URL
      // keeps answering, as a redirect, so nothing anyone bookmarked 404s.
      return redirect(response, QUEUE_VIEW);
    }

    if (url.pathname === "/tasks/new") {
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      const revision = who.via === "cookie" ? who.session.projectRevision : 0;
      const chainable = store
        .listTasksScoped(project, undefined, 100, null)
        .filter(one => one.state !== "done" && one.state !== "cancelled" && visible(one.repo))
        .map(one => ({ id: one.id, title: one.title }));
      const chrome = chromeFor(project, "tasks");
      return sendScreen(response, 200, newTaskPage(chrome, project, csrf, revision, null, chainable, store.permissionDefault().mode, store.qualityDefault().mode, chrome.projects ?? []));
    }

    const taskLive = matchTaskPath(url.pathname, "/live$");
    if (taskLive !== null) {
      // The live task page: a nudge the moment the task changes, and who else
      // has it open. Hints only — the page reads the task the usual way.
      if (who.via !== "cookie") return respond(response, 403, "application/json", JSON.stringify({ error: "session" }));
      const family = familyOf(taskLive.taskId);
      if (family === null || family.problem !== null) return respond(response, 404, "application/json", JSON.stringify({ error: "task" }));
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no" });
      const name = who.name, repo = family.root.repo;
      taskRooms.join(family.root.id, {
        name, response,
        // Rechecked while open, from the cookie and the account (never a request's context): a sign-out or a narrowed account stops it.
        valid: () => { const again = identify(request, false); return again !== null && again.name === name && rowVisible(liveCeiling(), repo) && store.accountCanAccess(name, repo); },
      });
      request.once("close", () => { if (!response.writableEnded) response.end(); });
      return;
    }
    const task = matchTaskPath(url.pathname, "");
    if (task !== null) {
      const family = familyOf(task.taskId);
      if (family === null) return refuse(response, who, 404, "no such task", "/tasks");
      const version = url.searchParams.get("version");
      if (version !== null && !family.versions.some(one => one.id === version)) return refuse(response, who, 404, "That version is not available for this task.", taskHref(family.root.id));
      // A version's own address lands on its family's page, still asking for the plan editor when it did (Chat's Edit plan).
      if (task.taskId !== family.root.id) return redirect(response, `${taskHref(family.root.id)}?version=${encodeURIComponent(task.taskId)}${url.searchParams.get("edit") === "plan" ? "&edit=plan" : ""}`);
      return taskScreen(response, who, version ?? family.current.id, null, 200, undefined, undefined, url.searchParams.get("edit") === "plan");
    }

    // v103: a task's evidence pack, as a printable page or JSON (the whole family, sealed ledger entries included).
    const evidence = matchTaskPath(url.pathname, "/evidence$");
    if (evidence !== null) {
      const access = workAccess();
      const family = store.taskFamilyOf(evidence.taskId, access.repos, access.includeUnplaced);
      if (family === null || !visible(family.root.repo)) return refuse(response, who, 404, "no such task", "/tasks");
      if (evidence.taskId !== family.root.id) return redirect(response, `${taskHref(family.root.id)}/evidence${url.search}`);
      const pack = evidencePack(store, family.root.id, access, who.name, now, evidenceRoot);
      if (pack === null) return refuse(response, who, 404, "no such task", "/tasks");
      if (url.searchParams.get("format") === "json") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="evidence-${family.root.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json"`,
          "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return void response.end(JSON.stringify(checkResponse("evidencePack", pack), null, 2));
      }
      return sendScreen(response, 200, screen(`Evidence pack · ${family.root.id}`, evidencePackHtml(pack), { chrome: chromeFor(family.root.repo, "tasks") }));
    }

    if (url.pathname === "/runs") {
      const raw = url.searchParams.get("before");
      let before: number | null = null;
      if (raw !== null) {
        if (!/^[1-9][0-9]{0,14}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
          return refuse(response, who, 400, "that cursor is not a page", "/runs");
        }
        before = Number(raw);
      }
      const rows = store.listRunsBefore(before, RUNS_PAGE, project);
      const verdicts = store.proofVerdictsFor(rows.map(one => one.id));
      const accepted = new Set(rows.filter(one => store.proofAcceptance(one.id) !== null).map(one => one.id));
      return sendScreen(response, 200, runsPage(chromeFor(project, "runs"), rows, liveRunIds(rows), rows.length === RUNS_PAGE ? rows[rows.length - 1]?.id ?? null : null, verdicts, accepted));
    }

    const run = /^\/r\/([0-9]{1,15})$/.exec(url.pathname);
    if (run !== null) {
      const found = store.getRun(Number(run[1]));
      if (found === null || !runVisible(found)) {
        return refuse(response, who, 404, "no such run", "/runs");
      }
      const taskId = store.externalIdFor(found.taskRef) ?? "?";
      const running = runIsLive(found);
      if (url.searchParams.get("fragment") === "check") {
        response.setHeader("cache-control", "no-store");
        return respond(response, 200, "text/html; charset=utf-8", checkProgressHtml(store.checkProgress(found.id)));
      }
      if (url.searchParams.get("fragment") === "facts") {
        // The facts region alone — same auth and ceiling as the page; a
        // finished or no-longer-live run says so rather than growing forms
        // (finding 5; round-4 finding 15).
        return respond(response, 200, "text/html; charset=utf-8", runFactsFragment(found, taskId, running, store.runRoute(found.id)));
      }
      if (url.searchParams.get("fragment") === "peek") {
        // The live peek: cookie sessions only (v2 §3), never stored, never
        // cached by anything downstream.
        if (who.via !== "cookie") return respond(response, 403, "text/plain; charset=utf-8", "the live peek is a browser session's view");
        const peeked = await peekFragment(
          found.id,
          who.session.csrf,
          options.editorLinks !== undefined && found.runner === options.localRunner && who.session.editorLinks === true,
        );
        response.setHeader("cache-control", "no-store");
        if (peeked.retryAfter !== undefined) response.setHeader("retry-after", String(peeked.retryAfter));
        return respond(response, peeked.status, "text/html; charset=utf-8", peeked.body);
      }
      if (url.searchParams.get("fragment") === "transcript") {
        // The live transcript window (arc 1): raw sanitized TEXT as JSON —
        // the sink is textContent, never innerHTML. Guards, enumerated:
        // cookie session; run visible (proved above); this machine's
        // runner asserted; byte offsets validated; the file read through
        // its own descriptor with the exact numeric-id name. Display
        // state, not evidence — and never cached.
        response.setHeader("cache-control", "no-store");
        if (who.via !== "cookie") return respond(response, 403, "application/json", JSON.stringify({ error: "session" }));
        if (options.localRunner === undefined) {
          return respond(response, 200, "application/json", JSON.stringify({ error: "off" }));
        }
        const fromRaw = url.searchParams.get("from") ?? "0";
        const from = /^[0-9]{1,15}$/.test(fromRaw) ? Number(fromRaw) : Number.NaN;
        if (!Number.isSafeInteger(from) || from < 0) {
          return respond(response, 400, "application/json", JSON.stringify({ error: "offset" }));
        }
        const live = runIsLive(found);
        // The final drain: a finished run's tail — including a torn last
        // line — may be read until the sweep removes the file.
        const window = readLiveWindow(evidenceRoot, found.id, from, !live);
        if (!window.ok) {
          if (window.reason === "replaced") {
            return respond(response, 409, "application/json", JSON.stringify({ error: "replaced" }));
          }
          // Missing or unreadable: nothing to show. Final only when the
          // run can never write again.
          return respond(response, 200, "application/json", JSON.stringify({ text: "", nextOffset: from, final: !live }));
        }
        // Re-proof after the read (peek discipline): the run row still says
        // what admission said, or nothing is shown.
        const again = store.getRun(found.id);
        if (again === null || !runVisible(again)) {
          return respond(response, 200, "application/json", JSON.stringify({ text: "", nextOffset: from, final: true }));
        }
        return respond(
          response,
          200,
          "application/json",
          JSON.stringify({ text: window.text, nextOffset: window.nextOffset, final: !live && window.eof }),
        );
      }
      // One result page (2026-10-02): a builder's finished result opens on
      // its task's result page, titled with the task. The raw run record
      // waits there under Details, and here with ?record=1.
      if (url.searchParams.get("record") === null && !running && found.role === "builder" && (found.outcome === "built" || found.outcome === "no-change") &&
          completedRowFor(taskId, null)?.runId === found.id) {
        const tab = parseResultTab(url.searchParams.get("tab"));
        return redirect(response, `${reviewHref(taskId, found.id)}${tab === "summary" ? "" : `&tab=${tab}`}`);
      }
      // A build that failed or stopped opens on its own result page too: its changes, its checks and what went wrong.
      if (url.searchParams.get("record") === null && !running && (found.role === "builder" || found.role === "scout") && attemptRowFor(taskId, found.id, null) !== null) {
        const tab = parseResultTab(url.searchParams.get("tab"));
        return redirect(response, `${reviewHref(taskId, found.id)}${tab === "summary" ? "" : `&tab=${tab}`}`);
      }
      // Pollers exist only for a LIVE run — an orphaned null-outcome run
      // would otherwise be refetched forever (finding 15). The nonce is
      // sendScreen's business now.
      const artifacts = store.artifactsFor(found.id);
      return sendScreen(
        response,
        200,
        runPage(
          chromeFor(project, "runs", runListPane(project, found.id)),
          found,
          taskId,
          artifacts,
          terminalDiffView(artifacts, evidenceRoot),
          store.notesForRun(found.id),
          who.via === "cookie" ? who.session.csrf : "",
          store.liveDiffComments(found.id).filter(isRevisionFeedback),
          (() => {
            const publication = store.publicationForRun(found.id);
            return publication !== null && publication.prNumber !== null && store.hasOpenCiEpisode(publication.githubRepo, publication.prNumber)
              ? { pr: publication.prNumber }
              : null;
          })(),
          !running
            ? undefined
            : regionScript("run-facts", "facts", 10) +
              (options.localRunner === undefined ? "" : regionScript("run-peek", "peek", 15)) +
              (options.localRunner === undefined ? "" : transcriptScript()),
          options.localRunner !== undefined,
          running,
          // Editor links (arc 6): three statements align or nothing renders —
          // the deployment capability, THIS machine's runner owning the run,
          // and the session's own device-side yes.
          options.editorLinks !== undefined &&
          options.localRunner !== undefined &&
          found.runner === options.localRunner &&
          who.via === "cookie" &&
          who.session.editorLinks === true &&
          // A reviewer run (v29) never had a checkout — no files to open.
          found.worktree !== null
            ? { worktree: found.worktree }
            : null,
          options.editorLinks !== undefined &&
          options.localRunner !== undefined &&
          found.runner === options.localRunner &&
          who.via === "cookie"
            ? { on: who.session.editorLinks === true }
            : null,
          url.searchParams.get("noted") !== null,
          (() => {
            const held = store.heldSessionOf(found.id);
            if (held === null) return null;
            const authorization = store.readAuthorization(held.authorizationId);
            return {
              turns: store.sessionTurnsOf(found.id),
              open: held.endedAt === null && held.state === "open",
              state:
                authorization === null
                  ? "session record"
                  : attendedWatchWords(authorization.lastBeatAt, now, authorization.absoluteExpiry),
              cap: authorization?.maxSessionTurns ?? 0,
            };
          })(),
          options.attended !== undefined &&
          who.via === "cookie" &&
          !store.isDemo() &&
          (found.outcome === "built" || found.outcome === "no-change") &&
          store.openAuthorizationFor(found.taskRef) === null
            ? { taskId }
            : null,
          structuredHandoffView(artifacts, evidenceRoot),
          proofBundleView(store, found, artifacts, evidenceRoot),
          store.runRoute(found.id),
          store.publicationForRun(found.id),
          reviewFactsFor(found.id),
          // The shared result presentation (package 3) for a finished result.
          !running && (found.outcome === "built" || found.outcome === "no-change")
            ? { detail: resultDetailOf(found, who, now), tab: parseResultTab(url.searchParams.get("tab")), user: who.name, requestToken: randomBytes(16).toString("hex") }
            : null,
          store.getScope(taskId)?.digest ?? null,
        ),
      );
    }

    const runArtifact = /^\/r\/([0-9]{1,15})\/evidence\/([0-9]{1,15})$/.exec(url.pathname);
    if (runArtifact !== null) {
      return runEvidence(response, Number(runArtifact[1]), Number(runArtifact[2]));
    }

    const contestPath = /^\/contest\/([0-9]{1,15})$/.exec(url.pathname);
    if (contestPath !== null) {
      return contestScreen(response, who, Number(contestPath[1]), null, 200);
    }

    if (url.pathname === "/routines") {
      // The ceiling row by row, exactly as everywhere: a routine placed in
      // a repo this server may not serve does not exist here.
      const tracks = store
        .routineTracks(project, now)
        .filter(track => visible(track.routine.repo));
      // ?template=<name> pre-fills the filing form from the shipped
      // library — a pre-filled form, same guarded submission path.
      const fromTemplate = url.searchParams.get("template");
      const picked = fromTemplate === null ? null : templateByName(fromTemplate);
      return sendScreen(response, 200, routinesPage(chromeFor(project, "routines"), tracks, {
        csrf: who.via === "cookie" ? who.session.csrf : "",
        revision: who.via === "cookie" ? who.session.projectRevision : 0,
        problem: null,
        prefill:
          picked !== null && picked.kind === "routine"
            ? {
                name: picked.routineName,
                goal: picked.goal,
                not: picked.outOfScope ?? "",
                touches: picked.touches.join(", "),
                schedule: picked.schedule,
                acceptance: acceptanceToLines(picked.acceptance).join("\n"),
              }
            : null,
      }));
    }

    const routineScreen = /^\/routines\/([0-9]{1,15})$/.exec(url.pathname);
    if (routineScreen !== null) {
      const routine = store.getRoutine(Number(routineScreen[1]));
      if (routine === null || !visible(routine.repo)) {
        return refuse(response, who, 404, "no such routine", "/routines");
      }
      return routinePage(response, who, routine.id, null, 200);
    }

    const one = /^\/d\/([0-9]{1,15})$/.exec(url.pathname);
    if (one !== null) {
      const decision = store.getDecision(Number(one[1]));
      if (decision === null) return refuse(response, who, 404, "no such decision");
      const run = store.getRun(decision.run);
      if (run !== null && !visible(taskRepoOf(run.taskRef))) {
        return refuse(response, who, 404, "no such decision");
      }
      const taskId = taskOf(store, decision);
      const decisionReturn = url.searchParams.get("return");
      const back = decisionReturn === null ? null : safeChatReturn(decisionReturn);
      return sendScreen(response, 200, decisionPage(chromeFor(project, "none"), decision, taskId, store.evidenceFor(decision.id), who, now, back));
    }

    const artifact = /^\/d\/([0-9]{1,15})\/evidence\/([0-9]{1,15})$/.exec(url.pathname);
    if (artifact !== null) {
      return decisionEvidence(response, Number(artifact[1]), Number(artifact[2]));
    }
    return refuse(response, who!, 404, "There's no page at this address.", "/chat");
  }

  async function post(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, now, project, chosenProject, posted, route } = ctx;

    // The attended beat answers BEFORE the shared mutation guard (v28): it
    // carries no parameters, so there is no csrf token to check — its OWN
    // guard is complete and STRICTER for the browsers this console
    // supports: cookie session, form content-type (form() enforced it),
    // and `Sec-Fetch-Site: same-origin`, which cross-site POSTs cannot
    // send and same-origin fetch always does. Renewal-only: an attacker
    // who somehow posted could only keep the operator's OWN sessions from
    // lapsing — no mint, no spend, no read.
    if (url.pathname === "/session/attended-beats") {
      return attendedBeats(who, request, response, clock());
    }
    if (url.pathname === '/code' || url.pathname.startsWith('/code/')) {
      const body = readForm(posted, CONSOLE_FORMS.code);
      const wantsJson = request.headers.accept?.includes('application/json') === true;
      const fail = (status: number, message: string, delivery: 'rejected' | 'pending' | 'unknown' = 'rejected', sessionId?: string): void => wantsJson
        ? respond(response, status, 'application/json', JSON.stringify({ ok: false, error: message, delivery, ...(sessionId ? { sessionId } : {}) }))
        : refuse(response, who, status, message, '/code');
      if (who.via !== 'cookie' || !codingActorAllowed({ name: who.name, generation: who.session.generation }) || store.isDemo()) return fail(403, 'Coding sessions require installation-wide operator access. You can manage project tasks in Work.');
      if (!runtime.coding) return fail(409, runtime.codingProblem || 'Open Toolroll on the machine with your installed coding agent.');
      if ([...new Set(body.keys())].some(key => body.sent.getAll(key).length !== 1)) return fail(400, 'Submit one value for each field.');
      const actor = { name: who.name, generation: who.session.generation };
      const permitted = (repo: string): boolean => visible(repo) && codingProjectAllowed(repo);
      // Sprint 8: a coding session is Codex taking turns: the organisation policy decides whether it may (provider,
      // model, and a ceiling Codex can't run under), when it starts and on every action that makes it take another turn.
      const turnAction = /^\/code\/[a-f0-9]{32}\/(send|resume|recover|continue|answer)$/.test(url.pathname);
      if (url.pathname === '/code/start' || turnAction) {
        const stopped = store.sessionPolicyRefusal('codex', url.pathname === '/code/start' ? body.get('model')?.trim() || null : null, 'coding sessions');
        if (stopped !== null) return fail(403, stopped);
      }
      try {
        let id: string;
        if (url.pathname === '/code/start') {
          const repo = body.get('repo') ?? '';
          if (!permitted(repo)) return fail(403, 'Choose a project available to your account.');
          if (!authenticateApprover(who, body.get('password') ?? '').ok) return fail(403, 'Enter your Toolroll password to authorize this coding session.');
          const session = await runtime.coding.start(actor, { repo, title: body.get('title') ?? '', model: body.get('model')?.trim() || null, prompt: body.get('prompt') ?? '', requestId: body.get('requestId') ?? '' });
          id = session.id;
        } else {
          const match = /^\/code\/([a-f0-9]{32})\/(send|stop|resume|recover|continue|ship|answer)$/.exec(url.pathname);
          if (!match) return fail(404, 'Coding action not found.');
          id = match[1]!;
          const session = runtime.coding.get(id, actor);
          if (!permitted(session.repo)) return fail(403, 'That project is outside your access.');
          if (match[2] === 'ship') {
            const made = createCodingHandoff(store, { sessionId: id, actor: who.name, repo: session.repo, base: body.get('base') ?? '', candidate: body.get('candidate') ?? '', title: body.get('title') ?? '', goal: body.get('goal') ?? '', acceptance: (body.get('acceptance') ?? '').split('\n').map(line => line.trim()).filter(Boolean).map((statement, index) => ({ id: `c${index + 1}`, statement, evidence: ['check', 'changed-path', ...(body.get('visual') === 'yes' ? ['screenshot'] : [])] })) });
            return wantsJson ? respond(response, 200, 'application/json', JSON.stringify({ ok: true, taskId: made.taskId })) : redirect(response, `/t/${encodeURIComponent(made.taskId)}`);
          }
          if (match[2] === 'send') await runtime.coding.send(id, actor, body.get('prompt') ?? '', body.get('requestId') ?? '');
          else if (match[2] === 'stop') await runtime.coding.stop(id, actor);
          else if (match[2] === 'resume') await runtime.coding.resume(id, actor);
          else if (match[2] === 'recover') await runtime.coding.recover(id, actor);
          else if (match[2] === 'continue') await runtime.coding.continueSaved(id, actor);
          else {
            const token = body.get('requestId') ?? '';
            const pending = runtime.coding.snapshot(id, actor).requests.find(r => r.id === token);
            if (!pending) return fail(409, 'This request is no longer waiting for an answer.');
            const decision = body.get('decision');
            if (decision !== 'accept' && decision !== 'decline' && decision !== 'cancel') return fail(400, 'Choose an explicit decision for this request.');
            if (pending.kind !== 'questions' && decision === 'accept' && !authenticateApprover(who, body.get('password') ?? '').ok) return fail(403, 'Enter your password to approve this additional access.');
            const answers: unknown = body.has('answers') ? JSON.parse(body.get('answers')!) : Object.fromEntries(pending.questions.map(q => [q.id, { answers: [body.get(`question:${q.id}`) ?? ''] }]));
            runtime.coding.answer(id, actor, token, decision, answers);
          }
        }
        // Authorization is checked again after asynchronous startup/transport work.
        if (!codingActorAllowed(actor)) return fail(403, 'Your access changed. Sign in again.', 'unknown', id);
        return wantsJson ? respond(response, 200, 'application/json', JSON.stringify({ ok: true, id })) : redirect(response, `/code/${id}`);
      } catch (error) {
        if (!codingActorAllowed(actor)) return fail(403, 'Your access changed. Sign in again.', error instanceof CodingActionError ? error.delivery : 'rejected', error instanceof CodingActionError ? error.sessionId : undefined);
        const message = error instanceof Error ? error.message : 'The coding action could not finish. Your draft is preserved.';
        const ship = /^\/code\/([a-f0-9]{32})\/ship$/.exec(url.pathname);
        if (ship && !wantsJson) {
          try { const preview = codingHandoffPreview(store, { sessionId: ship[1]!, actor: who.name }); return sendScreen(response, 409, screen('Review for shipping', codingShippingHtml(preview, who.session.csrf, body.sent, message), { chrome: chromeFor(preview.repo, 'code') })); } catch {}
        }
        return fail(409, message, error instanceof CodingActionError ? error.delivery : 'rejected', error instanceof CodingActionError ? error.sessionId : undefined);
      }
    }

    if (url.pathname === "/tasks/add") {
      const body = readForm(posted, CONSOLE_FORMS.tasksAdd);
      const project = projectOf(who, request);
      if (project === undefined) {
        return refuse(response, who, 403, "that project is outside what this server was configured to show");
      }
      // Stale-tab guard: a form rendered under one open project must not
      // create into a different one switched-to since (finding 6).
      if (who.via === "cookie") {
        const seen = body.get("projectRevision");
        if (seen !== null && seen !== String(who.session.projectRevision)) {
          return refuse(response, who, 409, "the open project changed since this form was rendered — reload and try again", "/tasks");
        }
      }
      const id = (body.get("id") ?? "").trim();
      const title = body.get("title") ?? "";
      // The EFFECTIVE placement (repo onboarding, findings 15/35): the
      // trimmed, nonempty posted repo, else the open project — an empty
      // input falls through correctly. In root mode the effective path is
      // proved by authorizedProject EXACTLY as typed-then-canonicalized,
      // and [canonical] is the admitted list — a fresh clone under a root
      // must be able to receive its first task without waiting to appear
      // in any table.
      const repoGiven = (body.get("repo") ?? "").trim();
      const effective = repoGiven !== "" ? repoGiven : (project ?? "");
      if (restricted() && !visible(effective === "" ? null : effective)) return refuse(response, who, 403, "That project is outside your access.", "/projects");
      // A scoped console refuses an EMPTY placement server-side (verification
      // finding 1): the form's `required` is a courtesy, not the guard — a
      // direct POST with no project open must not mint an unplaced task
      // under a ceiling. Unscoped mode keeps its historic unplaced filings.
      if (!unscopedMode && effective === "") {
        const csrf = who.via === "cookie" ? who.session.csrf : "";
        return sendScreen(
          response,
          400,
          tasksPage(chromeFor(project, "tasks"), familyTasksInView(project).slice(0, 200), null, csrf, "name a repository — no project is open, so the task must say where it belongs", project, null, store.permissionDefault().mode, store.qualityDefault().mode, store.replacements()),
        );
      }
      let repo = effective;
      let admitted: string[] | null = unscopedMode ? null : admissionList() ?? [];
      const rootMode = !unscopedMode && ceiling.roots.length > 0;
      if (rootMode && effective !== "") {
        const canonical = (await authorizedProject(liveCeiling(), effective)) ? canonicalProject(effective) : null;
        if (canonical === null || canonical === undefined) {
          const csrf = who.via === "cookie" ? who.session.csrf : "";
          return sendScreen(
            response,
            403,
            tasksPage(chromeFor(project, "tasks"), familyTasksInView(project).slice(0, 200), null, csrf, `${effective} is outside what this server was configured to show`, project, null, store.permissionDefault().mode, store.qualityDefault().mode, store.replacements()),
          );
        }
        repo = canonical;
        admitted = [canonical];
      }
      const goal = body.get("goal") ?? "";
      const notThis = body.get("not") ?? "";
      const touchesGiven = (body.get("touches") ?? "")
        .split(/[\n,]/)
        .map(one => one.trim())
        .filter(one => one !== "");
      const scout = body.get("scout") === "1";
      const permissionMode = body.get("permission-mode");
      if (permissionMode !== null && permissionMode !== "auto" && permissionMode !== "bypassPermissions") {
        return refuse(response, who, 400, "permissions must be Auto or Full access", "/tasks/new");
      }
      const qualityMode = body.get("quality-mode");
      if (qualityMode !== null && !isQualityMode(qualityMode)) {
        return refuse(response, who, 400, "quality must be Default or Strict / release", "/tasks/new");
      }
      // One filing door for every surface (Codex adoption review, finding 7).
      const after = (body.get("after") ?? "").trim();
      let chainProblem: string | null = null;
      const made = store.transact(() => {
        const filed = fileTaskProposal(
          store,
          {
            ...(id === "" ? {} : { id }),
            title,
            ...(repo === "" ? {} : { repo }),
            ...(goal === "" ? {} : { goal, acceptance: acceptanceLinesToInput((body.get("acceptance") ?? "").split("\n")) }),
            outOfScope: notThis === "" ? null : notThis,
            touches: touchesGiven,
            ...(permissionMode === null ? {} : { permissionMode }),
            ...(qualityMode === null ? {} : { qualityMode }),
            ...(scout ? { deliverable: "report" as const } : {}),
            planning:
              scout
                ? "skip"
                : body.get("planning-policy") === "choice"
                  ? body.get("plan-first") === "1" ? "required" : "skip"
                  : "auto",
            filedVia: "console", filedBy: { name: who.name, kind: "person" as const },
            ...(admitted === null ? {} : { admittedRepos: admitted }),
          },
          now,
        );
        if (filed.ok && after !== "") {
          const afterRef = store.lookupRef(after);
          const chained = store.getTask(after) !== null && afterRef !== null && visible(afterRef.repo)
            ? store.addEdge(filed.id, after) : { ok: false as const, reason: "that task does not exist here" };
          if (!chained.ok) chainProblem = chained.reason;
        }
        // Missing dependencies leave a reviewable, inert task. They must
        // never be silently dropped before automatic approval starts work.
        if (filed.ok && chainProblem === null && who.via === "cookie") applyModeToNewFiling(store, filed.id, who.name, now);
        return filed;
      });
      if (!made.ok) {
        const csrf = who.via === "cookie" ? who.session.csrf : "";
        return sendScreen(
          response,
          made.reason === "backlog-full" ? 429 : 400,
          tasksPage(chromeFor(project, "tasks"), familyTasksInView(project).slice(0, 200), null, csrf, made.message, project, { title, goal, not: notThis, touches: body.get("touches") ?? "", acceptance: body.get("acceptance") ?? "", values: body.sent }, store.permissionDefault().mode, store.qualityDefault().mode, store.replacements()),
        );
      }
      const actionContext = requestContext.getStore();
      if (actionContext !== undefined) actionContext.createdTask = made.id;
      // A proved root-mode placement joins the project table (finding 15):
      // the new task's home is openable and admissible from now on.
      if (rootMode && repo !== "") store.upsertProject(repo, projectName(repo), now);
      if (chainProblem !== null) return taskScreen(response, who, made.id, `the task was created, but could not be made to wait for ${after} — ${chainProblem}`, 200);
      return redirect(response, taskHref(made.id));
    }

    if (url.pathname === "/queue/move" || url.pathname === "/queue/note") {
      const body = readForm(posted, CONSOLE_FORMS.queue);
      const project = projectOf(who, request);
      if (project === undefined) {
        return refuse(response, who, 403, "that project is outside what this server was configured to show");
      }
      // The note is a global runner label, not project-scoped work: the
      // fleet screen (project-less) posts it too, so the null-project gate
      // applies only to moves, which the task-level check below re-proves.
      if (url.pathname === "/queue/note") {
        const worker = (body.get("runner") ?? "").trim();
        const note = (body.get("note") ?? "").trim();
        if (note.length > 200 || hasForbiddenControls(note)) {
          return refuse(response, who, 400, "that note will not render, so it will not store", QUEUE_VIEW);
        }
        const set = store.setRunnerQueueNote(worker, note === "" ? null : note);
        if (!set.ok) return refuse(response, who, 404, "no such worker", QUEUE_VIEW);
        return redirect(response, body.get("from") === "fleet" ? "/fleet" : QUEUE_VIEW);
      }
      if (who.via === "cookie") {
        const seen = body.get("projectRevision");
        if (seen !== null && seen !== String(who.session.projectRevision)) {
          return refuse(response, who, 409, "the open project changed since this form was rendered — reload and try again", QUEUE_VIEW);
        }
      }
      // A drag posts in place (fetch) when it can; the page re-renders its
      // own fragment on success. A plain form still works with no script.
      const inPlace = body.get("respond") === "fragment";
      const fromFleet = who.via === "cookie" && body.get("projectRevision") === null;
      const respondMove = (status: number, message: string): void => {
        if (!inPlace) return status === 409 ? refuse(response, who, 409, message, QUEUE_VIEW) : redirect(response, QUEUE_VIEW);
        respond(response, status, "text/plain; charset=utf-8", message);
      };
      const moveReason = (reason: string): string =>
        reason === "stale"
          ? "the queue moved underneath you — it just reloaded"
          : reason === "claimed" || reason === "contest-open"
            ? "that task is being taken right now — it keeps its claim"
            : reason === "worker-retired"
              ? "that worker is retired — drag its work elsewhere, or register the name again"
              : reason === "no-such-worker"
                ? "no such worker"
                : "that task is not in this queue any more";
      const taskId = (body.get("task") ?? "").trim();
      const columnGiven = (body.get("column") ?? "").trim();
      const toRunner = columnGiven === "" || columnGiven === "anyone" ? null : columnGiven;
      const beforeGiven = (body.get("before") ?? "").trim();
      const revisionGiven = Number(body.get("queueRevision") ?? "");
      // The queue's own screen enforces the open project; the fleet screen
      // is cross-project, so the ceiling is the only wall it needs.
      const belongs = (id: string): boolean => {
        const ref = store.lookupRef(id);
        return ref !== null && visible(ref.repo) && (fromFleet || project === null || ref.repo === null || ref.repo === project);
      };
      if (!belongs(taskId) || (beforeGiven !== "" && beforeGiven !== QUEUE_FRONT && !belongs(beforeGiven))) {
        return respondMove(404, "that task is not in this queue");
      }
      // The no-script "move to the front" button cannot name the front: the
      // front of a task's partition is decided by the store's exact repo AND
      // assignment, and the page's snapshot is bounded — so the sentinel is
      // resolved HERE, against a fresh snapshot, into a real task id (slice
      // 1b, fix 1). It is honored only within the task's own column; a
      // cross-column front is not provable from a bounded snapshot.
      let beforeTaskId: string | null = beforeGiven === "" ? null : beforeGiven;
      if (beforeGiven === QUEUE_FRONT) {
        const ref = store.lookupRef(taskId);
        if (ref === null) return respondMove(404, "that task is not in this queue");
        if (ref.assignedRunner !== toRunner) {
          return respondMove(409, "move to the front works inside a task's own column — drag it across to reserve it elsewhere");
        }
        const now = clock();
        const snapshot = store.queueScoped(ref.repo, now);
        const self = snapshot.find(one => one.id === taskId);
        // A claim or a contest can land after the form rendered WITHOUT
        // bumping queueRevision, so the snapshot — not the form — decides
        // whether the card is still free. A taken or vanished card is the
        // typed refusal, never a silent no-op that would skip moveTask()'s
        // own claimed/contest recheck.
        if (self === undefined) return respondMove(409, moveReason("unknown-task"));
        if (self.taken) return respondMove(409, moveReason("claimed"));
        const partition = snapshot.filter(
          one => one.repo === ref.repo && one.assignedRunner === ref.assignedRunner && !one.taken,
        );
        const front = partition[0];
        if (front === undefined) return respondMove(409, moveReason("unknown-task"));
        if (front.id === taskId) {
          // Already the front: a no-op, but only against the revision the
          // form was rendered with — this branch never reaches moveTask()'s
          // CAS, so the check is made here.
          if (!Number.isSafeInteger(revisionGiven) || revisionGiven !== store.queueRevision()) {
            return respondMove(409, moveReason("stale"));
          }
          return respondMove(200, "already at the front");
        }
        beforeTaskId = front.id;
      }
      const moved = store.moveTask(
        {
          taskId,
          toRunner,
          beforeTaskId,
          ...(Number.isSafeInteger(revisionGiven) ? { queueRevision: revisionGiven } : {}),
        },
        clock(),
      );
      if (!moved.ok) {
        return respondMove(409, moveReason(moved.reason));
      }
      return respondMove(200, "moved");
    }

    const answer = /^\/d\/([0-9]{1,15})\/answer$/.exec(url.pathname);
    if (answer !== null) {
      const body = readForm(posted, CONSOLE_FORMS.decisionAnswer);
      const id = Number(answer[1]);
      const requestedReturn = body.get("return");
      const decisionBack = requestedReturn === "next"
        ? "/next"
        : requestedReturn === null
          ? `/d/${id}`
          : safeChatReturn(requestedReturn);
      const decision = store.getDecision(id);
      if (decision === null) return refuse(response, who, 404, "no such decision");
      const answeringRun = store.getRun(decision.run);
      if (answeringRun !== null && !visible(taskRepoOf(answeringRun.taskRef))) {
        return refuse(response, who, 404, "no such decision");
      }
      const choice = body.get("choice") ?? "";
      const chosen = decision.options.find(option => option.id === choice);
      // Irreversible options never ride one accidental tap: the form arms
      // them behind an explicit confirmation field, and the server checks —
      // the client rendering is convenience, this is the rule.
      if (chosen !== undefined && !chosen.reversible && body.get("confirm") !== "yes") {
        return refuse(response, who, 400, "an irreversible choice must be confirmed", requestedReturn === null ? `/d/${id}` : `/d/${id}?return=${encodeURIComponent(decisionBack)}`);
      }
      const note = body.get("note");
      const answered = store.answerDecision(
        {
          id,
          choice,
          by: who.name,
          via: "web",
          ...(note === null || note === "" ? {} : { note }),
        },
        now,
      );
      if (!answered.ok) {
        const status = answered.reason === "bad-option" || answered.reason === "bad-note" ? 400 : 409;
        const why = answered.reason === "already-answered" ? "already answered — somebody got there first" : answered.reason;
        return refuse(response, who, status, why, requestedReturn === null ? `/d/${id}` : decisionBack);
      }
      return redirect(response, decisionBack);
    }

    const contestAct = /^\/contest\/([0-9]{1,15})\/(arm|pick|abandon)$/.exec(url.pathname);
    if (contestAct !== null) {
      if (who.via !== "cookie") return refuse(response, who, 403, REMOTE_MESSAGES["step-up"]);
      const body = readForm(posted, CONSOLE_FORMS.contest);
      const contestId = Number(contestAct[1]);
      const verb = contestAct[2] as "arm" | "pick" | "abandon";
      const data = contestData(contestId);
      if (data === null) return refuse(response, who, 404, "no such tournament", "/board");
      const { view } = data;

      if (verb === "arm") {
        // The ceremony's nonce is minted by THIS POST, never by a GET
        // (round-3 finding 30): a prefetched or crawled page must not mint
        // anything. The response is the ceremony form itself, carrying the
        // nonce value; its hash lives in a durable row bound to the exact
        // tuple digest being restated.
        const abandoning = body.get("act") === "abandon";
        if (abandoning) {
          if (!["pick-wait", "exhausted", "interrupted", "decision-wait"].includes(view.contest.state)) {
            return contestScreen(response, who, contestId, "this tournament is not in a state an operator can abandon", 409);
          }
          const digest = pickTupleDigest(view, { abandon: true }, { grant: null, head: null });
          const nonceValue = randomBytes(18).toString("base64url");
          const minted = store.mintCeremonyNonce(
            { hash: nonceHashOf(nonceValue), approver: who.name, subject: "contest-abandon", subjectId: contestId, digest, ttlMs: 15 * 60_000 },
            now,
          );
          if (!minted.ok) return contestScreen(response, who, contestId, "too many unfinished confirmations are open — finish or let them expire", 429);
          return sendScreen(response, 200, contestCeremonyPage(chromeFor(who.via === "cookie" ? who.session.project : null, "tasks"), {
            kind: "abandon", contestKind: view.contest.kind, contestId, taskId: data.taskId, taskTitle: data.taskTitle,
            agents: view.agents.length, totalMicrousd: data.totalMicrousd, anyUnknown: data.anyUnknown,
            nonceValue, csrf: who.via === "cookie" ? who.session.csrf : "",
          }));
        }
        if (view.contest.state !== "pick-wait") {
          return contestScreen(response, who, contestId, "this tournament is not waiting for a pick", 409);
        }
        const choice = Number(body.get("choice") ?? "");
        const plan = computePickPlan(store, view, choice, data.repo, data.refOrigin);
        if (!plan.ok) return contestScreen(response, who, contestId, plan.message, 409);
        const nonceValue = randomBytes(18).toString("base64url");
        const minted = store.mintCeremonyNonce(
          { hash: nonceHashOf(nonceValue), approver: who.name, subject: "contest-pick", subjectId: contestId, digest: plan.digest, ttlMs: 15 * 60_000 },
          now,
        );
        if (!minted.ok) return contestScreen(response, who, contestId, "too many unfinished confirmations are open — finish or let them expire", 429);
        return sendScreen(response, 200, contestCeremonyPage(chromeFor(who.via === "cookie" ? who.session.project : null, "tasks"), {
          kind: "pick", contestKind: view.contest.kind, contestId, taskId: data.taskId, taskTitle: data.taskTitle,
          agents: view.agents.length, totalMicrousd: data.totalMicrousd, anyUnknown: data.anyUnknown,
          chosen: plan.chosen,
          publication: plan.publishable && plan.grant !== null && plan.chosen.run.branch !== null ? { githubRepo: plan.grant.githubRepo, branch: plan.chosen.run.branch, draft: plan.grant.draft } : null,
          nonceValue, csrf: who.via === "cookie" ? who.session.csrf : "",
        }));
      }

      // pick and abandon: the password, typed again, plus the nonce the arm
      // POST minted. The store consumes the nonce conditionally inside the
      // same transaction that moves the tournament — replay finds it gone.
      const token = body.get("token") ?? "";
      if (!authenticateApprover(who, token).ok) {
        return contestScreen(response, who, contestId, "that decision takes your password, typed again", 403);
      }
      const nonceValue = body.get("nonce") ?? "";
      if (nonceValue === "") return contestScreen(response, who, contestId, "that confirmation form was incomplete — start again", 400);

      if (verb === "pick") {
        const choice = Number(body.get("choice") ?? "");
        const picked = finalizeContestPick(store, {
          contestId, contestantId: choice, approver: who.name, nonceValue,
          evidenceRoot, repo: data.repo, taskId: data.taskId, refOrigin: data.refOrigin,
        }, now);
        if (!picked.ok) return contestScreen(response, who, contestId, picked.message, 409);
        return redirect(response, `/contest/${contestId}`);
      }

      const gone = abandonContest(store, { contestId, approver: who.name, nonceValue, evidenceRoot, taskId: data.taskId }, now);
      if (!gone.ok) return contestScreen(response, who, contestId, gone.message, 409);
      return redirect(response, `/contest/${contestId}`);
    }

    const attendAct = matchTaskPath(url.pathname, "/(attend-preview|attend|attend-revoke)$");
    if (attendAct !== null) {
      return attendMutation(response, who, attendAct.taskId, attendAct.verb, readForm(posted, CONSOLE_FORMS.attend), now);
    }

    const act = matchTaskPath(url.pathname, "/(hold|unhold|requeue|cancel|scope|approve|plan|plan-edit|block|unblock|repair-dependency|next|reopen|steer|follow-up|accept-proof|accept-revision|reject-revision|route|retry-review|complete|merge|confirm-stopped|stop|resume-arm|resume)$");
    if (act !== null && act.verb === "confirm-stopped") {
      const body = readForm(posted, CONSOLE_FORMS.confirmStopped);
      // Confirming a finished build stopped is an approver's act behind the password, typed again — the same
      // record as `toolroll run settle`, refused while anything of the run may still be running.
      const back = taskHref(act.taskId);
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "Only an approver can confirm a build stopped.", back);
      const ref = store.lookupRef(act.taskId);
      if (ref === null || !visible(ref.repo)) return refuse(response, who, 404, "no such task", "/tasks");
      const named = (body.get("run") ?? "").trim();
      const run = /^[0-9]{1,15}$/.test(named) ? store.getRun(Number(named)) : null;
      const runTask = run === null ? null : store.externalIdFor(run.taskRef);
      if (run === null || runTask === null || familyOf(runTask)?.root.id !== (familyOf(act.taskId)?.root.id ?? act.taskId)) {
        return taskScreen(response, who, act.taskId, "That build isn't part of this task.", 409);
      }
      if (!authenticateApprover(who, body.get("token") ?? "", ref.repo).ok || !store.accountCanAccess(who.name, ref.repo)) {
        return taskScreen(response, who, act.taskId, "That password didn't match. Nothing changed.", 403);
      }
      // When Toolroll can't check at all, the approver also says they checked: never a one-click confirmation.
      if (store.stopQuiescenceFact(run.id)?.kind === "unknown" && body.get("checked") !== "yes") {
        return taskScreen(response, who, act.taskId, `Make sure nothing from build #${run.id} is running, then tick the box to confirm.`, 409);
      }
      const settled = store.settleRunWitnessesByApprover({ runId: run.id, by: who.name, why: "Confirmed in the console that nothing from this build is running." }, now);
      if (!settled.ok) {
        return taskScreen(response, who, act.taskId, settled.reason === "alive" || settled.reason === "still-running"
          ? `Something from build #${run.id} may still be running, so it can't be confirmed stopped yet.` : `Build #${run.id} can't be confirmed stopped.`, 409);
      }
      bustBadge();
      const to = resultReturnTarget(body.get("return"), run.id);
      return redirect(response, body.get("return") ? to : back);
    }
    if (act !== null && act.verb === "merge") {
      const body = readForm(posted, CONSOLE_FORMS.merge);
      // Merging is a person's act behind their password, typed again: a browser session, an approver, the exact
      // result's pull request. The flow re-reads GitHub before merging and records who merged in the ledger.
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "Only an approver can merge.");
      if (store.isDemo()) return taskScreen(response, who, act.taskId, "The demo merges nothing.", 403);
      const ref = store.lookupRef(act.taskId);
      if (ref === null || !visible(ref.repo)) return refuse(response, who, 404, "no such task", "/tasks");
      const named = (body.get("run") ?? "").trim();
      const run = /^[0-9]{1,15}$/.test(named) ? store.getRun(Number(named)) : null;
      const runTask = run === null ? null : store.externalIdFor(run.taskRef);
      if (run === null || runTask === null || familyOf(runTask)?.root.id !== (familyOf(act.taskId)?.root.id ?? act.taskId)) {
        return taskScreen(response, who, act.taskId, "That pull request isn't part of this task.", 409);
      }
      const merged = await mergeAsPerson(store, { runId: run.id, name: who.name, password: body.get("token") ?? "", ...(body.get("anyway") === "1" ? { anyway: true } : {}), ...(options.publishExec === undefined ? {} : { exec: options.publishExec }), clock });
      if (!merged.ok) return taskScreen(response, who, act.taskId, merged.message, merged.reason === "password" ? 403 : 409);
      return redirect(response, `${taskHref(act.taskId)}#merge`);
    }
    if (act !== null) {
      return taskMutation(response, who, act.taskId, act.verb, posted, now);
    }

    if (url.pathname === "/routines/add") {
      const body = readForm(posted, CONSOLE_FORMS.routinesAdd);
      // A standing order files into the OPEN project — never a typed path,
      // so the ceiling question never even arises — and lands on its own
      // screen where the approval step-up already lives: filing is cheap,
      // the yes is the ceremony.
      const project = projectOf(who, request);
      if (project === undefined || project === null) {
        return refuse(response, who, 403, "open a project first — a standing order lives somewhere specific");
      }
      if (who.via === "cookie") {
        const seen = body.get("projectRevision");
        if (seen !== null && seen !== String(who.session.projectRevision)) {
          return refuse(response, who, 409, "the open project changed since this form was rendered — reload and try again", "/routines");
        }
      }
      const name = (body.get("name") ?? "").trim();
      const ceilingGiven = (body.get("ceiling") ?? "").trim();
      // Root mode proves the CURRENT project exactly (repo onboarding,
      // finding 24): canonicalize, authorize, and pass [canonical] as the
      // admitted list — the same discipline as task filing, so a routine
      // can land in a fresh clone too.
      const routineRootMode = !unscopedMode && ceiling.roots.length > 0;
      let routineRepo = project;
      let routineAdmitted: string[] | null = unscopedMode ? null : admissionList() ?? [];
      if (routineRootMode) {
        const canonical = (await authorizedProject(liveCeiling(), project)) ? canonicalProject(project) : null;
        if (canonical === null || canonical === undefined) {
          return refuse(response, who, 403, "the open project is outside what this server was configured to show", "/routines");
        }
        routineRepo = canonical;
        routineAdmitted = [canonical];
      }
      // One filing door for every surface (Codex adoption review, finding
      // 7): the service validates, canonicalizes, digests, and stamps
      // provenance; the admission list makes the ceiling explicit even
      // though `project` was already proved inside it.
      const scheduled = body.has("repeat") ? composerSchedule(body.sent) : { ok: true as const, schedule: (body.get("schedule") ?? "").trim() };
      if (!scheduled.ok || scheduled.schedule === null) {
        return sendScreen(response, 400, routinesPage(chromeFor(project, "routines"), store.routineTracks(project, now).filter(track => visible(track.routine.repo)), {
          csrf: who.via === "cookie" ? who.session.csrf : "", revision: who.via === "cookie" ? who.session.projectRevision : 0,
          problem: scheduled.ok ? "Choose a recurring schedule." : scheduled.message, values: body.sent,
        }));
      }
      const created = fileRoutineProposal(
        store,
        {
          name,
          repo: routineRepo,
          goal: (body.get("goal") ?? "").trim(),
          outOfScope: (body.get("not") ?? "").trim() || null,
          touches: (body.get("touches") ?? "").split(/[\n,]/).map(one => one.trim()).filter(one => one !== ""),
          acceptance: acceptanceLinesToInput((body.get("acceptance") ?? "").split("\n")),
          requirements: [],
          schedule: scheduled.schedule,
          costCeilingUsd: ceilingGiven === "" ? null : Number(ceilingGiven),
          filedVia: "console", createdBy: who.name,
          ...(routineAdmitted === null ? {} : { admittedRepos: routineAdmitted }),
        },
        now,
      );
      if (created.ok && routineRootMode) store.upsertProject(routineRepo, projectName(routineRepo), now);
      if (!created.ok) {
        const tracks = store.routineTracks(project, now).filter(track => visible(track.routine.repo));
        return sendScreen(response, created.reason === "duplicate" ? 409 : 400, routinesPage(chromeFor(project, "routines"), tracks, {
          csrf: who.via === "cookie" ? who.session.csrf : "",
          revision: who.via === "cookie" ? who.session.projectRevision : 0,
          problem: created.message, values: body.sent,
        }));
      }
      return redirect(response, `/routines/${created.id}`);
    }

    const routineAct = /^\/routines\/([0-9]{1,15})\/(approve|refresh|pause|resume|run-now)$/.exec(url.pathname);
    if (routineAct !== null) {
      return routineMutation(response, who, Number(routineAct[1]), routineAct[2] as string, readForm(posted, CONSOLE_FORMS.routine), now);
    }

    const runNote = /^\/r\/([0-9]{1,15})\/note$/.exec(url.pathname);
    if (runNote !== null) {
      const body = readForm(posted, CONSOLE_FORMS.runNote);
      // An operator's verdict beside the machine's record (M6): immutable,
      // bounded by the same validator as decision notes, ceiling-checked
      // like every run resource. Ordinary authenticated mutation — no
      // nonce, because nothing here approves anything.
      const id = Number(runNote[1]);
      const found = store.getRun(id);
      if (found === null || !visible(taskRepoOf(found.taskRef))) {
        return refuse(response, who, 404, "no such run");
      }
      const note = validateNote(body.get("note") ?? "");
      if (!note.ok) return refuse(response, who, 400, note.problem);
      store.addRunNote(id, who.name, note.note, now);
      return redirect(response, `/r/${id}`);
    }

    const diffComment = /^\/r\/([0-9]{1,15})\/comment$/.exec(url.pathname);
    if (diffComment !== null) {
      const body = readForm(posted, CONSOLE_FORMS.diffComment);
      // A review comment on the IMMUTABLE terminal diff (M6.8): bound to
      // the exact artifact and its hash. Ordinary authenticated mutation —
      // the nonce belongs to the approval screen that later restates the
      // batch, never to the comment box.
      const id = Number(diffComment[1]);
      const found = store.getRun(id);
      if (found === null || !visible(taskRepoOf(found.taskRef))) {
        return refuse(response, who, 404, "no such run");
      }
      // Where the reader came from (package 3): the cockpit's deep link,
      // the chat's result view, or the run page — validated to those exact
      // shapes. A refusal sends them back THERE, where the browser has kept
      // their draft, so a failed submission is recoverable in place.
      const returnTo = resultReturnTarget(body.get("return"), id);
      const selectedTab = parseResultTab(body.get("tab"));
      const back = selectedTab === "summary" ? returnTo : `${returnTo}${returnTo.includes("?") ? "&" : "?"}tab=${selectedTab}`;
      if (body.get("intent") === "revise") {
        const result = requestResultChanges(store, evidenceRoot, {
          run: id, batch: body.get("batch"), source: body.get("source"), actor: who.name,
          repos: admissionList(), includeUnplaced: visible(null), allowMode: who.via === "cookie",
          note: body.get("note") ?? "", path: body.get("path") ?? "", line: body.get("line") ?? "", request: body.get("request"),
        }, now);
        if (!result.ok) {
          const request = body.get("request") ?? "";
          const retryBack = /^[a-f0-9]{32}$/.test(request) ? `${back}${back.includes("?") ? "&" : "?"}conflict=${request}#request-changes` : back;
          return refuse(response, who, result.status, result.message, retryBack);
        }
        return redirect(response, revisionDestination(result.id, returnTo));
      }
      const terminal = store.artifactsFor(id).find(one => one.kind === "terminal-diff");
      if (terminal === undefined) {
        return refuse(response, who, 400, "this run has no terminal diff to comment on", back);
      }
      // The bytes must VERIFY before words attach to them (audit IV-10):
      // "a comment on the exact reviewed bytes" is a lie if the bytes are
      // gone or no longer hash to their record.
      const proven = readVerifiedArtifact(evidenceRoot, terminal);
      if (!proven.ok) {
        return refuse(response, who, 409, `the terminal diff no longer verifies (${proven.problem}) — nothing to comment on`, back);
      }
      const note = validateNote(body.get("note") ?? "");
      if (!note.ok) return refuse(response, who, 400, note.problem, back);
      const rawPath = (body.get("path") ?? "").trim();
      if (rawPath.length > 300 || hasForbiddenControls(rawPath)) {
        return refuse(response, who, 400, "Enter a file path of up to 300 characters, without control characters.", back);
      }
      const rawLine = (body.get("line") ?? "").trim();
      const line = rawLine === "" ? null : Number(rawLine);
      if (line !== null && (!Number.isInteger(line) || line < 1 || line > 1_000_000)) {
        return refuse(response, who, 400, "Enter a whole line number from 1 to 1,000,000, or leave it blank.", back);
      }
      // The form's own request token (package 3) is the dedupe key: a
      // replayed or double submission finds its note already recorded and
      // lands on the same receipt instead of a second note. The token is
      // bound to the account, so nobody else's replay can consume it.
      const request = body.get("request");
      const sourceKey = commentSourceKey(who.name, request);
      const path = rawPath === "" ? null : rawPath;
      const inserted = store.addDiffComment(
        { artifactId: terminal.id, runId: id, path, line, note: note.note, author: who.name, ...(sourceKey === undefined ? {} : { sourceKey }) },
        now,
      );
      if (inserted === null && sourceKey !== undefined) {
        // The token was used before (repair 2026-09-14, finding 1). A
        // request identity is IMMUTABLE: it names exactly one note on
        // exactly one result. The unchanged retry — same run, same file,
        // line and words — lands on its original receipt; any other reuse
        // is refused, and the refusal's way back carries `conflict=<token>`
        // so the browser mints a fresh identity for the words it still
        // holds. Nothing typed is lost either way.
        const earlier = store.diffCommentBySourceKey(sourceKey);
        const conflictBack = `${back}${back.includes("?") ? "&" : "?"}conflict=${request as string}#request-changes`;
        if (earlier === null || earlier.run !== id) {
          return refuse(response, who, 409, `this note's request identity was already used on another result (build #${earlier === null ? "?" : earlier.run}) — go back; your words are kept, and the form will carry a new identity`, conflictBack);
        }
        if (earlier.path !== path || earlier.line !== line || earlier.note !== note.note) {
          return refuse(response, who, 409, `this request identity already recorded a different note on this result (${earlier.path === null ? "no file" : `${earlier.path}${earlier.line === null ? "" : `:${earlier.line}`}`}: "${oneLineOf(earlier.note, 80)}") — go back; your edited words are kept as a new note, and the form will carry a new identity`, conflictBack);
        }
      }
      // Land back AT the request-changes form with the note field ready —
      // writing five notes in a row must cost five keystrokes of
      // navigation, not five scrolls (arc 6, finding 5/6). The receipt
      // names the request token, so the browser clears exactly the draft
      // that landed and no other.
      const receipt = sourceKey === undefined ? "1" : (request as string);
      return redirect(response, `${back}${back.includes("?") ? "&" : "?"}noted=${receipt}#request-changes`);
    }

    if (url.pathname === "/session/editor-links") {
      const body = readForm(posted, CONSOLE_FORMS.editorLinks);
      // The session half of the editor-link activation (arc 6, finding 1):
      // only the person at the browser can say "this device holds the
      // worktrees". Per-session, dies with the session, grants nothing —
      // it only lets already-authorized pages RENDER vscode links.
      if (who.via !== "cookie") return refuse(response, who, 403, "editor links are a browser session's choice");
      if (options.editorLinks === undefined) return refuse(response, who, 404, "editor links are not enabled on this server");
      who.session.editorLinks = body.get("on") === "1";
      const back = body.get("return") ?? "/";
      return redirect(response, /^\/[a-z0-9/_-]*$/i.test(back) ? back : "/");
    }

    const turnAct = /^\/r\/([0-9]{1,15})\/turn$/.exec(url.pathname);
    if (turnAct !== null) {
      const body = readForm(posted, CONSOLE_FORMS.turn);
      // The operator's turn (Phase 2E, v2 S1g): cookie-only — a watching
      // person, never a bearer machine — and every hard gate (custody,
      // lease, cap, budget, open decision, single flight) re-proves
      // ATOMICALLY inside the recording transaction. Words here only map
      // the refusal tokens to sentences.
      if (who.via !== "cookie") return refuse(response, who, 403, "turns are a browser session's act");
      const id = Number(turnAct[1]);
      const found = store.getRun(id);
      if (found === null || !visible(taskRepoOf(found.taskRef))) {
        return refuse(response, who, 404, "no such run");
      }
      const text = (body.get("text") ?? "").trim();
      if (text === "" || text.length > 500) {
        return refuse(response, who, 400, "a turn is 1 to 500 characters", `/r/${id}`);
      }
      const coordinator = options.attended?.coordinator;
      if (coordinator === undefined) return refuse(response, who, 409, "this console is not holding the session", `/r/${id}`);
      const injected = coordinator.injectOperatorTurn(id, who.name, text);
      if (!injected.ok) {
        const words: Record<string, string> = {
          "no-held-session": "the session is not held here anymore",
          fenced: "the session is winding down — nothing more reaches it",
          "turn-open": "the agent is still working on the last message — wait for it to settle",
          "turn-cap": "the session's message cap is reached — authorize a new session for more",
          "budget-exhausted": "the session's budget is spent",
          "decision-open": "answer the waiting question first — it is on this page",
          "write-failed": "the message could not reach the agent — it was not charged",
        };
        return refuse(response, who, 409, words[injected.reason] ?? injected.reason, `/r/${id}`);
      }
      return redirect(response, `/r/${id}`);
    }

    const revise = /^\/r\/([0-9]{1,15})\/revise$/.exec(url.pathname);
    if (revise !== null) {
      const body = readForm(posted, CONSOLE_FORMS.revise);
      // Seal the live comment batch into ONE unapproved revision task with
      // an immutable brief (M6.8). Deterministic — no model reads anything
      // here — and every revision takes its own approval: comments can
      // semantically widen work, and no path check can prove they did not.
      const id = Number(revise[1]);
      const found = store.getRun(id);
      if (found === null || !visible(taskRepoOf(found.taskRef))) {
        return refuse(response, who, 404, "no such run");
      }
      const back = resultReturnTarget(body.get("return"), id);
      const result = createResultRevision(store, evidenceRoot, {
        run: id, batch: body.get("batch"), source: body.get("source"), actor: who.name,
        repos: admissionList(), includeUnplaced: visible(null), allowMode: who.via === "cookie",
      }, now);
      if (!result.ok) return refuse(response, who, result.status, result.message, back);
      return redirect(response, revisionDestination(result.id, back));
    }

    // Follow-ups on a result: Run checks on its exact commit (a worker runs the
    // approved command once and seals the log), or file a task to add tests.
    const followUp = /^\/r\/([0-9]{1,15})\/(checks|add-tests)$/.exec(url.pathname);
    if (followUp !== null) {
      const body = readForm(posted, CONSOLE_FORMS.followUp);
      const id = Number(followUp[1]);
      const found = store.getRun(id);
      if (found === null || !visible(taskRepoOf(found.taskRef))) return refuse(response, who, 404, "no such run");
      // The task page that offered Run checks in place is a return target too: this run's own task, or its family's root.
      const runTask = store.externalIdFor(found.taskRef);
      const back = resultReturnTarget(body.get("return"), id, runTask === null ? [] : [runTask, familyOf(runTask)?.root.id ?? runTask]);
      if (who.via !== "cookie") return refuse(response, who, 403, "Sign in with a browser session to do this.", back);
      if (followUp[2] === "checks") {
        if (who.role !== "approver") return refuse(response, who, 403, "An approver runs checks.", back);
        if (store.isDemo()) return refuse(response, who, 403, "The demo runs no checks.", back);
        const level = body.get("level") === "full" ? "full" as const : "quick" as const;
        const asked = requestFollowUpChecks(store, { runId: id, level, actor: who.name }, now);
        if (!asked.ok) return refuse(response, who, 409, asked.message, back);
        // Back where it was asked: the task page's status row says the checks are running; a result page shows them under #follow-ups.
        return redirect(response, back.startsWith("/t/") ? back : `${back.split("#")[0]}#follow-ups`);
      }
      const filed = fileAddTestsTask(store, evidenceRoot, { runId: id, actor: who.name, filedVia: "console", ...(admissionList() === null ? {} : { admittedRepos: admissionList()! }) }, now);
      if (!filed.ok) return refuse(response, who, 409, filed.message, back);
      return redirect(response, taskHref(filed.id));
    }

    const draftRepair = /^\/r\/([0-9]{1,15})\/draft-repair$/.exec(url.pathname);
    if (draftRepair !== null) {
      // CI repair, suggestion-first (M8.18): a red episode never spawns an
      // agent by itself — it EARNS a button, and the button creates one
      // unapproved task through the same revision machinery as review
      // comments. Deterministic id = one draft per task/PR, ever.
      const id = Number(draftRepair[1]);
      const found = store.getRun(id);
      if (found === null || !visible(taskRepoOf(found.taskRef))) {
        return refuse(response, who, 404, "no such run");
      }
      const publication = store.publicationForRun(id);
      if (publication === null || publication.prNumber === null) {
        return refuse(response, who, 400, "this run published no pull request", `/r/${id}`);
      }
      if (!store.hasOpenCiEpisode(publication.githubRepo, publication.prNumber)) {
        return refuse(response, who, 400, "no failing CI is observed on this PR right now", `/r/${id}`);
      }
      const sourceTaskId = store.externalIdFor(found.taskRef) ?? "?";
      const sourceScope = store.getScope(sourceTaskId);
      // The observed episode, not the click: the brief binds the head the
      // failure was SEEN on and when (audit C-2) — a PR that advanced since
      // is a different failure, and the click time is not an observation.
      const episode = store.latestOpenCiEpisode(publication.githubRepo, publication.prNumber as number);
      // Suffixes survive truncation (audit C-7): the prefix gives way, the
      // identity-bearing tail never does.
      const suffix = `-ci-${publication.prNumber}`;
      const draftId = `${sourceTaskId.slice(0, 64 - suffix.length)}${suffix}`;
      const brief = {
        schema: 1 as const,
        kind: "ci-repair" as const,
        sourceTask: sourceTaskId,
        sourceRun: id,
        sourceScopeDigest: sourceScope?.digest ?? null,
        head: found.headRevision,
        pr: publication.prNumber,
        prUrl: publication.prUrl,
        publishedHeadSha: publication.headSha,
        observedFailingHead: episode?.headSha ?? null,
        observedAt: episode?.createdAt ?? null,
      };
      const briefBytes = Buffer.from(JSON.stringify(brief, null, 2), "utf8");
      const briefName = `ci-repair-brief-${randomBytes(6).toString("hex")}.json`;
      const key = writeEvidenceFile(evidenceRoot, id, briefName, briefBytes);
      // The SAME revision boundary the annotation road and the criterion
      // repair use (contract handoff task 2): the inherited terms come from
      // the source rows inside the seal; the scope read above only names
      // the digest this draft was composed against.
      const sealed = store.sealRevision(
        {
          source: { task: sourceTaskId, run: id, scopeDigest: sourceScope?.digest ?? null },
          brief: { evidenceRoot, key, sha256: createHash("sha256").update(briefBytes).digest("hex"), bytes: briefBytes.length, capture: "machine-authored ci-repair brief (exit 0)" },
          child: {
            id: draftId,
            title: `repair ${sourceTaskId}: CI failing on PR #${publication.prNumber}`,
            repair:
              `repair the failing CI on PR #${publication.prNumber} (failing head ${(episode?.headSha ?? publication.headSha).slice(0, 12)}). ` +
              `Read the failing checks on GitHub before approving; this draft carries no log content.`,
          },
          commentIds: null,
          requestedBy: who.name,
        },
        now,
      );
      if (!sealed.ok) {
        return refuse(
          response,
          who,
          sealed.reason === "duplicate" ? 409 : sealed.reason === "stale-source" || sealed.reason === "comments-taken" ? 409 : 400,
          sealed.reason === "duplicate" ? `already drafted as ${draftId}` : `could not draft: ${sealed.detail}`,
          `/r/${id}`,
        );
      }
      // The merge blocker rides the SAME breath as the draft (merge grant,
      // findings 3/12/13): while this repair exists, the source PR merges
      // NOTHING — sticky until the operator's unblock act or the PR closes.
      store.createMergeBlocker(publication.id, sealed.id, now);
      return redirect(response, taskHref(sealed.id));
    }

    const resolve = /^\/i\/([0-9]{1,15})\/resolve$/.exec(url.pathname);
    if (resolve !== null) {
      const body = readForm(posted, CONSOLE_FORMS.resolveIncident);
      const id = Number(resolve[1]);
      // The ceiling applies to incident mutation exactly as to every other
      // resource (v3 review, finding 3): resolve incident → run → task, and
      // an incident outside this server's scope does not exist here. The
      // task id is captured BEFORE resolving — afterwards the incident is
      // no longer open and could not be found again.
      const openRow = store.openIncidents().find(one => one.id === id);
      const incidentRun = openRow === undefined ? null : store.getRun(openRow.run);
      if (openRow !== undefined && incidentRun !== null && !visible(taskRepoOf(incidentRun.taskRef))) {
        return refuse(response, who, 404, "no such incident");
      }
      const resolved = store.resolveIncident(id, who.name, now);
      if (!resolved) return refuse(response, who, 409, "already resolved, or never open");
      const back = body.get("return") === "inbox" ? "/inbox" : openRow === undefined ? "/" : taskHref(openRow.taskId);
      return redirect(response, back);
    }
    return refuse(response, who!, 404, "There's no page at this address.", "/chat");
  }


  /** The compact recent-runs list for the master pane. */
  function runListPane(project: string | null, currentId: number | null): string {
    const rows = store.listRunsBefore(null, 50, project);
    const live = liveRunIds(rows);
    const items = rows
      .map(
        run =>
          `<a class="item${run.id === currentId ? " current" : ""}" href="/r/${run.id}">` +
          `<span class="t">#${run.id} \u00b7 ${escape(run.taskId)}</span>` +
          `<span class="m">${runOutcomeBadge(run, live.has(run.id))}` +
          `<span class="mono">${whenTime(run.startedAt)}</span></span></a>`,
      )
      .join("\n");
    return `<h2>Builds</h2>\n${items === "" ? `<p class="meta">None yet</p>` : items}`;
  }

  async function peekFragment(runId: number, sessionKey: string, editorMode = false): Promise<{ status: number; body: string; retryAfter?: number }> {
    const guarded = peekGuards(runId);
    if (!guarded.ok) return { status: 200, body: peekSay(guarded.message, guarded.final === true) };
    const { run, worktree, epoch, entries } = guarded.admit;
    // The cache and the in-flight coalescer both vary by LINK MODE (arc 6,
    // finding 3): a linked fragment rendered for one session must never be
    // served to a session that has not activated links on its device.
    const key = `${runId}:${run.baseRevision}:${epoch}:${editorMode ? "links" : "plain"}`;
    const cached = peekCache.get(key);
    if (cached !== undefined && Date.now() - cached.at <= PEEK_CACHE_TTL_MS) {
      return { status: 200, body: cached.fragment };
    }
    if (cached !== undefined) {
      peekCache.delete(key);
      runtime.peekCacheBytes -= Buffer.byteLength(cached.fragment);
    }
    // Coalesce per run; bound per session and globally (finding 10).
    const flightKey = `${runId}:${editorMode ? "links" : "plain"}`;
    const inFlight = peekInFlight.get(flightKey);
    if (inFlight !== undefined) return { status: 200, body: await inFlight };
    if (peekInFlight.size >= PEEK_GLOBAL_INFLIGHT) return { status: 429, body: peekSay("the live view is busy — it retries by itself"), retryAfter: 10 };
    if ((peekBySession.get(sessionKey) ?? 0) >= PEEK_SESSION_INFLIGHT) {
      return { status: 429, body: peekSay("too many live views from this session"), retryAfter: 10 };
    }
    peekBySession.set(sessionKey, (peekBySession.get(sessionKey) ?? 0) + 1);
    const work = (async (): Promise<string> => {
      const seen = await observeWorktree(worktree, entries.entries, PEEK_LIMITS);
      // The fence, proved AGAIN after the walk (findings 16/28): the same
      // run still open, the same claim, the SAME epoch — or the whole
      // observation is discarded, never rendered, never cached.
      const after = peekGuards(runId);
      if (!after.ok || after.admit.epoch !== epoch) {
        return peekSay("the checkout changed hands mid-look — nothing is shown");
      }
      if (!seen.ok) return peekSay(seen.reason);
      const stamp = clock().toISOString().slice(11, 19);
      const parts: string[] = [
        `<p class="meta">Best-effort look at ${escape(stamp)} UTC — files can change mid-read</p>`,
      ];
      const changed = seen.rows.filter(one => one.kind === "changed");
      const deleted = seen.rows.filter(one => one.kind === "deleted");
      const unchecked = seen.rows.filter(one => one.kind === "unchecked");
      const fresh = aggregateNewNames(seen.newPaths);
      if (changed.length === 0 && deleted.length === 0 && fresh.total === 0) {
        parts.push(`<p class="row">nothing has changed against the starting point yet</p>`);
      }
      // A name is linked ONLY when sanitize provably changed nothing (arc 6,
      // finding 3): a masked or normalized label must never carry an href
      // that discloses what the mask hid. Collapsed labels never link.
      const linkedName = (path: string): string => {
        const shown = peekName(path);
        if (!editorMode || shown !== escape(path)) return shown;
        const href = editorFileHref(worktree, path);
        return href === null ? shown : `<a href="${escape(href)}">${shown}</a>`;
      };
      const line = (row: { path: string; detail: string }, mark: string): string =>
        `<p class="row mono">${mark} ${linkedName(row.path)} <span class="meta">${escape(row.detail)}</span></p>`;
      for (const row of changed) parts.push(line(row, "~"));
      for (const row of deleted) parts.push(line(row, "−"));
      if (fresh.total > 0) {
        parts.push(`<p class="meta">New files · ${fresh.total}</p>`);
        for (const row of fresh.rows) {
          parts.push(
            row.collapsed
              ? `<p class="row mono">+ ${peekName(row.label)} <span class="meta">collapsed names — ${row.count} files</span></p>`
              : `<p class="row mono">+ ${peekName(row.label)}</p>`,
          );
        }
        if (fresh.renderedFiles < fresh.total) {
          parts.push(`<p class="meta">…and ${fresh.total - fresh.renderedFiles} more (${fresh.total} new files total)</p>`);
        }
      }
      if (unchecked.length > 0) {
        parts.push(`<p class="meta">Not verified this look — absence above does not mean unchanged:</p>`);
        for (const row of unchecked) parts.push(line(row, "?"));
      }
      if (seen.partial !== null) parts.push(`<p class="meta">${escape(seen.partial)}</p>`);
      let fragment = parts.join("\n");
      if (Buffer.byteLength(fragment) > PEEK_FRAGMENT_BYTES) {
        // The byte cap is enforced AFTER escaping (finding 32): an oversize
        // rendering is replaced whole by its exact counts.
        fragment =
          `<p class="meta">Best-effort look at ${escape(stamp)} UTC</p>` +
          `<p class="row">${changed.length} changed · ${deleted.length} deleted · ${fresh.total} new · ${unchecked.length} unverified — too much to render live; the final diff will hold the detail</p>`;
      }
      peekCache.set(key, { fragment, at: Date.now() });
      runtime.peekCacheBytes += Buffer.byteLength(fragment);
      peekEvict();
      return fragment;
    })();
    peekInFlight.set(flightKey, work);
    try {
      return { status: 200, body: await work };
    } finally {
      peekInFlight.delete(flightKey);
      const left = (peekBySession.get(sessionKey) ?? 1) - 1;
      if (left <= 0) peekBySession.delete(sessionKey);
      else peekBySession.set(sessionKey, left);
    }
  }

  function contestScreen(
    response: ServerResponse,
    who: Who,
    contestId: number,
    problem: string | null,
    status: number,
  ): void {
    const data = contestData(contestId);
    if (data === null) return refuse(response, who, 404, "no such tournament", "/board");
    const paneProject = who.via === "cookie" ? who.session.project : null;
    const diffs = new Map<number, TerminalDiffView | null>();
    for (const agent of data.view.agents) {
      if (agent.run !== null) diffs.set(agent.contestant.id, terminalDiffView(store.artifactsFor(agent.run.id), evidenceRoot));
    }
    return sendScreen(
      response,
      status,
      contestPage(chromeFor(paneProject, "tasks"), {
        ...data,
        diffs,
        csrf: who.via === "cookie" ? who.session.csrf : "",
        problem,
      }),
    );
  }

  /**
   * Routine verbs. The ceiling check is independent of authorizeMutation
   * (Codex round 2, finding 7): the routine's repository is resolved
   * server-side and proved against this server's configuration before any
   * verb runs, whatever the request named.
   */
  function routineMutation(
    response: ServerResponse,
    who: Who,
    routineId: number,
    verb: string,
    body: FormView<FormFieldOf<"routine">>,
    now: Date,
  ): void {
    const routine = store.getRoutine(routineId);
    if (routine === null || !visible(routine.repo)) {
      return refuse(response, who, 404, "no such routine", "/routines");
    }

    switch (verb) {
      case "approve": {
        if (who.via !== "cookie") return refuse(response, who, 403, REMOTE_MESSAGES["step-up"]);
        // Step-up, identical to a scope's: the session got you here; only
        // the password agrees. The digest names what was seen.
        const digest = body.get("digest") ?? "";
        const token = body.get("token") ?? "";
        const nonce = body.get("nonce") ?? "";
        if (!consumeApprovalNonce(nonce, who.name, `routine:${routine.id}`, digest)) {
          return routinePage(response, who, routineId, "that approval form is stale — read it again", 409);
        }
        if (token === "" && !hasFreshIdentitySignIn(who.name)) {
          return routinePage(response, who, routineId, "approval requires your password, typed again", 400);
        }
        const approved = approveRoutine(store, routineId, who.name, now, digest, token);
        if (!approved.ok) {
          const status = approved.reason === "changed" ? 409 : 403;
          const words =
            approved.reason === "profile-unresolved"
              ? "not approved: the routine cannot name an exact agent for every role — configure the project's agents, then file the standing order again"
              : approved.reason === "requester"
                ? "You made this standing order, and this project needs someone else to approve it."
                : `not approved: ${approved.reason}`;
          return routinePage(response, who, routineId, words, status);
        }
        return redirect(response, `/routines/${routineId}`);
      }
      case "refresh": {
        // THE RECOVERY ROAD (v48): re-resolve the agents from today's
        // configuration and file them as the order's working agents. This
        // approves nothing — the page then shows the exact agents and asks
        // for the password again.
        const refreshed = refreshRoutineAgents(store, routineId, now);
        if (!refreshed.ok) {
          return routinePage(response, who, routineId, `agents not refreshed: ${refreshed.problem}`, 409);
        }
        return redirect(response, `/routines/${routineId}`);
      }
      case "pause":
      case "resume": {
        store.setRoutinePaused(routineId, verb === "pause", now);
        return redirect(response, `/routines/${routineId}`);
      }
      case "run-now": {
        if (who.via !== "cookie") return refuse(response, who, 403, REMOTE_MESSAGES["step-up"]);
        // Step-up (Codex Phase C review, M3): run-now is spend outside the
        // approved schedule, so a session alone cannot ask for it — the
        // password is typed again, like an approval.
        const token = body.get("token") ?? "";
        if (token === "" && !hasFreshIdentitySignIn(who.name)) {
          return routinePage(response, who, routineId, "run now requires your password, typed again", 400);
        }
        const authenticated = authenticateApprover(who, token);
        if (!authenticated.ok) {
          return routinePage(response, who, routineId, "that is not your password", 403);
        }
        const outcome = fireRoutine(store, routineId, now, { manual: true });
        if (!outcome.ok) {
          return routinePage(response, who, routineId, `not fired: ${outcome.detail ?? outcome.reason}`, 409);
        }
        return redirect(response, `/routines/${routineId}`);
      }
      default:
        return refuse(response, who, 404, "That action isn't available here.", `/routines/${routineId}`);
    }
  }

  // ---- mutations -----------------------------------------------------------

  /** v28: the console-scoped liveness beat — see the route note in
   * handlePost. Supersedes v2 S2f's per-page id binding, reversed
   * KNOWINGLY: with parallel sessions one foregrounded tab per session is
   * impossible, and page-binding was attention theater over what was
   * always renewal-of-use. Approver-bound; never extends cookies, never
   * touches absolute expiry, never mints. */
  function attendedBeats(who: Who, request: IncomingMessage, response: ServerResponse, now: Date): void {
    if (who.via !== "cookie") return refuse(response, who, 403, "watching is a browser session's act");
    // Round-2 finding 2's named miss: renewal is an approver's act — a
    // viewer's open tab keeps nothing alive.
    if (who.role !== "approver") return refuse(response, who, 403, "your login can watch, not keep sessions alive");
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return refuse(response, who, 403, "the beat only answers this console's own pages");
    }
    // Belt with the braces: a PRESENT Origin/Referer must also name this
    // server — the same allowlist the shared guard applies.
    const namedOrigin =
      typeof request.headers.origin === "string" && request.headers.origin !== "null"
        ? request.headers.origin
        : typeof request.headers.referer === "string"
          ? request.headers.referer
          : null;
    if (namedOrigin !== null && !allowedHost(namedOrigin.replace(/^https?:[/][/]/, "").split("/")[0])) {
      return refuse(response, who, 403, "origin not allowed");
    }
    const attendedRunner = options.attended?.runner;
    let beaten = 0;
    if (attendedRunner !== undefined) {
      for (const open of store.openAuthorizationsOf(attendedRunner)) {
        if (open.approver !== who.name) continue;
        if (Date.parse(open.absoluteExpiry) <= now.getTime()) continue;
        // Only terms SIGNED for console-wide renewal are renewed here
        // (round-1 finding 2): a legacy page-bound signature never
        // silently acquires the wider mode — it simply lapses.
        try {
          const signedMode = (JSON.parse(open.termsJson) as { attentionMode?: unknown }).attentionMode;
          if (signedMode !== "console-visible") continue;
        } catch {
          continue;
        }
        const beatRef = store.refForId(open.taskRef);
        if (beatRef === null || !visible(beatRef.repo)) continue;
        store.beatAuthorization(open.id, now);
        if (open.attemptRun !== null) options.attended?.coordinator?.poke(open.attemptRun);
        beaten++;
      }
    }
    return respond(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, beaten }));
  }

  async function attendMutation(
    response: ServerResponse,
    who: Who,
    taskId: string,
    verb: string,
    body: FormView<FormFieldOf<"attend">>,
    now: Date,
  ): Promise<void> {
    const ref = store.lookupRef(taskId);
    if (ref === null || store.getTask(taskId) === null || !visible(ref.repo)) {
      return refuse(response, who, 404, "no such task", "/tasks");
    }
    if (who.via !== "cookie") return refuse(response, who, 403, "watching is a browser session's act");
    if (store.isDemo()) return refuse(response, who, 403, "the demo authorizes nothing");

    if (verb === "attend-revoke") {
      const open = store.openAuthorizationFor(ref.id);
      if (open === null) return refuse(response, who, 409, "nothing to revoke", taskHref(taskId));
      store.closeAuthorization(open.id, "revoked", now);
      if (open.attemptRun !== null) options.attended?.coordinator?.poke(open.attemptRun);
      return redirect(response, taskHref(taskId));
    }

    const parentGiven = body.get("parent");
    const followupGiven = body.get("followup");
    const inputs = {
      minutes: Number(body.get("minutes") ?? "60"),
      turns: Number(body.get("turns") ?? "20"),
      budgetMicrousd: Number(body.get("budget") ?? String(store.getScope(taskId)?.budgetMicrousd ?? 2_000_000)),
      ...(body.get("expiry") === null ? {} : { expiry: body.get("expiry") as string }),
      ...(parentGiven === null || parentGiven === "" ? {} : { parent: Number(parentGiven) }),
      ...(followupGiven === null ? {} : { followup: followupGiven }),
      ...(body.get("model") === null ? {} : { model: body.get("model") as string }),
      ...(body.get("posture") === null ? {} : { posture: body.get("posture") as string }),
    };
    if (store.openAuthorizationFor(ref.id) !== null) {
      return refuse(response, who, 409, "an authorization is already open — revoke it first", taskHref(taskId));
    }
    const live = await liveAttendedTerms(taskId, inputs, now);
    if (!live.ok) return refuse(response, who, 409, live.problem, taskHref(taskId));
    // Sprint 8: an attended session runs at exactly what the person signs, so the organisation policy refuses it
    // outright (a provider, a model, or a posture above the permission ceiling) before anyone signs.
    {
      const pinned = profileFromJson(live.terms.profileJson);
      const refused = pinned === null ? null : store.attendedPolicyRefusal(pinned);
      if (refused !== null) return refuse(response, who, 403, refused, taskHref(taskId));
    }
    const digest = attendedDigestOf(live.terms);

    if (verb === "attend-preview") {
      const nonce = mintApprovalNonce(who.name, `attend-${taskId}`, digest);
      return attendConfirmScreen(response, who, live.terms, inputs, digest, nonce, who.session.csrf);
    }

    // attend: the yes. The nonce proves THIS form; the digest re-derived
    // from live state proves the world held between reading and signing.
    const nonce = body.get("nonce") ?? "";
    if (!consumeApprovalNonce(nonce, who.name, `attend-${taskId}`, body.get("digest") ?? "")) {
      return refuse(response, who, 409, "that form is stale — read it again", taskHref(taskId));
    }
    if (digest !== (body.get("digest") ?? "")) {
      return refuse(response, who, 409, "the world moved while you were reading (scope, model, or head) — read it again", taskHref(taskId));
    }
    const token = body.get("token") ?? "";
    let basis: { kind: "mode"; digest: string } | undefined;
    if (token === "" && !hasFreshIdentitySignIn(who.name)) {
      // Quick mint (C2/M4): no password typed — valid ONLY when a live
      // mode with quickMint was signed by THIS session's person. The mint
      // transaction re-proves it; this pre-check only shapes the refusal.
      const mode = ref.repo === null ? null : store.activeMode(ref.repo, now);
      const modeTerms = mode === null ? null : modeTermsFromJson(mode.termsJson);
      if (mode === null || modeTerms === null || !modeTerms.quickMint || mode.signedBy !== who.name) {
        return refuse(response, who, 403, "authorizing takes your password, typed again", taskHref(taskId));
      }
      basis = { kind: "mode", digest: mode.digest };
    } else if (!authenticateApprover(who, token).ok) {
      return refuse(response, who, 403, "authorizing takes your password, typed again", taskHref(taskId));
    }
    const minted = store.mintAttendedAuthorization({
      id: randomUUID(),
      taskRef: ref.id,
      approver: who.name,
      runner: live.terms.runner,
      runnerGeneration: live.terms.runnerGeneration,
      compositeDigest: digest,
      termsJson: attendedTermsJson(live.terms),
      maxSessionTurns: live.terms.maxSessionTurns,
      budgetMicrousd: live.terms.budgetMicrousd,
      ...(live.terms.parentRun == null ? {} : { parentRun: live.terms.parentRun }),
      ...(live.terms.followup == null ? {} : { followup: live.terms.followup }),
      absoluteExpiry: live.terms.absoluteExpiry,
      ...(basis === undefined ? {} : { basis }),
      now,
    });
    if (!minted.ok) {
      return refuse(
        response,
        who,
        minted.reason === "authorization-open" ? 409 : 403,
        minted.reason === "mode-ended"
          ? "the mode that covered quick minting has ended — your password, typed again, still works"
          : minted.reason === "approval-rules"
            ? "this project's approval rules need someone else's approval (or two people's) — a watched run can't stand in for it"
            : "an authorization is already open — revoke it first",
        taskHref(taskId),
      );
    }
    // The first beat is the mint itself: the person is visibly here.
    store.beatAuthorization(minted.authorization.id, now);
    return redirect(response, taskHref(taskId));
  }

  function taskMutation(
    response: ServerResponse,
    who: Who,
    taskId: string,
    verb: string,
    posted: URLSearchParams,
    now: Date,
  ): void {
    const ref = store.lookupRef(taskId);
    if (ref === null || store.getTask(taskId) === null) {
      return refuse(response, who, 404, "no such task", "/tasks");
    }
    if (!visible(ref.repo)) {
      return refuse(response, who, 404, "no such task", "/tasks");
    }

    switch (verb) {
      case "steer": {
        const body = readForm(posted, CONSOLE_FORMS.taskSteer);
        // Steering is a browser session's act, explicitly (arc 1 v2 §3):
        // identify() accepts bearer credentials generically, and those are
        // for machines — a person watching steers, cookie + CSRF only.
        if (who.via !== "cookie") {
          return refuse(response, who, 403, "steering is a browser session's act");
        }
        // The session IS the verified principal here — cookie + CSRF proved it.
        const filed = store.fileSteerNote(taskId, verifiedAuthor(who.name), body.get("note") ?? "", now);
        if (!filed.ok) {
          const said =
            filed.reason === "contest-open"
              ? "agents are racing on this task — steering waits until the tournament settles"
              : filed.reason === "task-finished"
                ? "this task is finished — a note has no next attempt to reach"
                : filed.reason === "invalid-note"
                  ? (filed.problem ?? "that note will not store")
                  : "no such task";
          return taskScreen(response, who, taskId, said, 400);
        }
        return redirect(response, taskHref(taskId));
      }
      case "hold": {
        const body = readForm(posted, CONSOLE_FORMS.taskHold);
        const reason = (body.get("reason") ?? "").trim() || "held from the console";
        if (reason.length > 200 || hasForbiddenControls(reason)) {
          return taskScreen(response, who, taskId, "that reason will not render, so it will not store", 400);
        }
        // Operator-owned only, always: the form supplies a reason, never an
        // owner. Decision, incident, and backoff holds are not reachable
        // from here, whatever a request claims.
        store.hold(ref.id, reason, null, now);
        return redirect(response, taskHref(taskId));
      }
      case "block": {
        const body = readForm(posted, CONSOLE_FORMS.taskBlock);
        // Chains are scheduling, not authority (chains-and-next review,
        // finding 2): the edge decides WHEN the ready set admits the task;
        // approval still decides WHAT may build. Both ends are re-proved
        // here — existence, ceiling, and the tournament guard — and the
        // cycle refusal comes from the store's own closure check.
        const on = (body.get("on") ?? "").trim();
        const blocker = on === "" ? null : store.getTask(on);
        const blockerRef = on === "" ? null : store.lookupRef(on);
        if (blocker === null || blockerRef === null || !visible(blockerRef.repo)) {
          return taskScreen(response, who, taskId, "that task to wait for does not exist here", 404);
        }
        if (store.openContestFor(ref.id) !== null) {
          return taskScreen(response, who, taskId, "a tournament is running on this task — let it finish, then pick or abandon it", 409);
        }
        const added = store.addEdge(taskId, on);
        if (!added.ok) {
          return taskScreen(response, who, taskId, `could not make ${taskId} wait for ${on} — ${added.reason}`, 409);
        }
        return redirect(response, taskHref(taskId));
      }
      case "unblock": {
        const body = readForm(posted, CONSOLE_FORMS.taskBlock);
        const on = (body.get("on") ?? "").trim();
        if (store.openContestFor(ref.id) !== null) {
          return taskScreen(response, who, taskId, "a tournament is running on this task — let it finish, then pick or abandon it", 409);
        }
        const removed = store.removeEdge(taskId, on);
        if (!removed.ok) {
          return taskScreen(response, who, taskId, `${taskId} was not waiting on ${on}`, 409);
        }
        return redirect(response, taskHref(taskId));
      }
      case "repair-dependency": {
        const body = readForm(posted, CONSOLE_FORMS.taskRepairDependency);
        const blocker = (body.get("blocker") ?? "").trim();
        const operation = (body.get("operation") ?? "").trim();
        const blockerTask = blocker === "" || !store.blockers(taskId).includes(blocker) ? null : store.getTask(blocker);
        if (blockerTask === null || (blockerTask.state !== "failed" && blockerTask.state !== "cancelled")) {
          return taskScreen(response, who, taskId, "what this task waits for changed — refresh the page and choose again", 409);
        }
        if (store.openContestFor(ref.id) !== null) {
          return taskScreen(response, who, taskId, "a tournament is running on this task — let it finish before changing its dependencies", 409);
        }
        if (operation === "retry") {
          const blockerRef = store.lookupRef(blocker);
          if (blockerTask.state !== "failed" || blockerRef === null || !visible(blockerRef.repo)) {
            return taskScreen(response, who, taskId, "that failed task cannot be tried again here — wait for a different task or continue without it", 409);
          }
          const retried = store.requeueTask(blocker, who.name, now);
          if (!retried.ok) return taskScreen(response, who, taskId, `that task could not be queued again — ${retried.reason}`, 409);
          return redirect(response, taskHref(taskId));
        }
        if (operation === "unlink") {
          const removed = store.removeEdge(taskId, blocker);
          if (!removed.ok) return taskScreen(response, who, taskId, "what this task waits for changed — refresh the page and choose again", 409);
          return redirect(response, taskHref(taskId));
        }
        if (operation === "replace") {
          const replacement = (body.get("replacement") ?? "").trim();
          const replacementTask = replacement === "" ? null : store.getTask(replacement);
          const replacementRef = replacement === "" ? null : store.lookupRef(replacement);
          if (
            replacementTask === null ||
            replacementRef === null ||
            !visible(replacementRef.repo) ||
            (replacementTask.state !== "queued" && replacementTask.state !== "running")
          ) {
            return taskScreen(response, who, taskId, "choose another unfinished task from a project you can manage", 409);
          }
          const replaced = store.replaceEdge(taskId, blocker, replacement);
          if (!replaced.ok) return taskScreen(response, who, taskId, `this task could not wait for the selected work — ${replaced.reason}`, 409);
          return redirect(response, taskHref(taskId));
        }
        return taskScreen(response, who, taskId, "choose whether to try that task again, wait for a different task, or continue without it", 400);
      }
      case "next": {
        const body = readForm(posted, CONSOLE_FORMS.taskNext);
        if (body.get("undo") !== null) {
          const cleared = store.clearTaskPriority(taskId);
          if (!cleared.ok) return taskScreen(response, who, taskId, "this task could not be put back in filing order", 409);
          return redirect(response, taskHref(taskId));
        }
        const moved = store.moveTaskNext(taskId, now);
        if (!moved.ok) {
          const said =
            moved.reason === "not-queued"
              ? "only queued work can move up — this task is not waiting in the queue"
              : moved.reason === "claimed"
                ? "this task is being built right now — it needs no place in line"
                : moved.reason === "contest-open"
                  ? "a tournament is running on this task — let it finish, then pick or abandon it"
                  : "the queue rank could not be raised";
          return taskScreen(response, who, taskId, said, 409);
        }
        return redirect(response, taskHref(taskId));
      }
      case "reopen": {
        const body = readForm(posted, CONSOLE_FORMS.taskReopen);
        // Authenticated like every approving act: the session alone may
        // read; resuming external work takes the password, typed again.
        const token = (body.get("token") ?? "").trim();
        const authenticated = token !== "" ? authenticateApprover(who, token) : null;
        if (authenticated === null || !authenticated.ok) {
          return taskScreen(response, who, taskId, "reopening takes your password, typed again", 403);
        }
        const reopened = store.reopenMirror(taskId, who.name, now);
        if (!reopened.ok) {
          const said: Record<string, string> = {
            "unknown-task": "this task is not external work",
            "not-latched": "the tracker never closed this — there is nothing to reopen",
            "not-seen-open": "the tracker has not been seen open again since the close — reopen it there first; the next sync notices",
            claimed: "this task is being built right now",
            "contest-open": "a tournament is open on this task — decide it first",
            held: "a hold stands — lift it first",
            "question-open": "an unanswered question stands — answer or close it first",
            "incident-open": "an unresolved incident stands — resolve it first",
            "bad-state": "this task is not in a state reopen can take",
          };
          return taskScreen(response, who, taskId, said[reopened.reason] ?? "the task could not be reopened", 409);
        }
        return redirect(response, taskHref(taskId));
      }
      case "unhold": {
        store.unhold(ref.id);
        return redirect(response, taskHref(taskId));
      }
      case "requeue": {
        const body = readForm(posted, CONSOLE_FORMS.taskRequeue);
        // Retry may carry a note for the next attempt: the same steering note, checked before anything changes.
        const note = (body.get("note") ?? "").trim();
        if (note !== "" && who.via !== "cookie") return refuse(response, who, 403, "steering is a browser session's act");
        if (note !== "" && !validateNote(note).ok) return taskScreen(response, who, taskId, "that note will not store, so nothing was retried", 400);
        const requeued = store.requeueTask(taskId, who.name, now);
        if (!requeued.ok) {
          return taskScreen(response, who, taskId, `not requeued: ${requeued.reason}`, 409);
        }
        if (note !== "") {
          const filed = store.fileSteerNote(taskId, verifiedAuthor(who.name), note, now);
          if (!filed.ok) return taskScreen(response, who, taskId, "Retried. The note wasn't saved; add it under Steering.", 409);
        }
        // Allow-listed return only — never an arbitrary URL from the form.
        return redirect(response, body.get("return") === "inbox" ? "/inbox" : body.get("return") === "next" ? "/next" : taskHref(taskId));
      }
      case "follow-up": {
        const body = readForm(posted, CONSOLE_FORMS.taskFollowUp);
        // A scout's proposed follow-up, filed by the operator's tap (mate
        // arc §10): the ONE filing door, this task's repository, the scope
        // text stamped as the scout's — mode coverage never seals it.
        const indexRaw = body.get("index") ?? "";
        if (!/^[0-9]{1,2}$/.test(indexRaw)) return taskScreen(response, who, taskId, "which follow-up?", 400);
        const view = readVerifiedReport(store, evidenceRoot, ref.id);
        if (view === null || !view.ok) return taskScreen(response, who, taskId, "this task has no report to file from", 409);
        const followUp = view.report.followUps[Number(indexRaw)];
        if (followUp === undefined) return taskScreen(response, who, taskId, "the report proposes no such follow-up", 409);
        if (ref.repo === null) return taskScreen(response, who, taskId, "this task has no repository — file the follow-up by hand", 409);
        if (!visible(ref.repo)) return taskScreen(response, who, taskId, "that repository is outside what this server shows", 403);
        // Idempotent by construction (v4 review, finding 10): the filing's
        // id is derived from the source task, the report's run, and the
        // follow-up's place — a retried POST lands on the task the first
        // one filed instead of minting a twin.
        const followUpId = `${taskId.slice(0, 40)}-r${view.run}-f${Number(indexRaw) + 1}`;
        if (store.getTask(followUpId) !== null) return redirect(response, taskHref(followUpId));
        const filed = fileTaskProposal(
          store,
          {
            id: followUpId,
            title: followUp.title,
            repo: ref.repo,
            goal: followUp.goal,
            // v39: the scout's report format does not yet draft a rubric
            // per follow-up — a placeholder names the operator's own
            // review as the outstanding work, the same posture a
            // coordinator's bare intent takes.
            acceptance: PLACEHOLDER_RUBRIC,
            filedVia: "console", filedBy: { name: who.name, kind: "person" as const },
            proposedVia: "scout",
            ...(unscopedMode ? {} : { admittedRepos: admissionList() ?? [] }),
          },
          now,
        );
        if (!filed.ok) {
          if (filed.reason === "duplicate") return redirect(response, taskHref(followUpId));
          return taskScreen(response, who, taskId, `not filed: ${filed.message}`, filed.reason === "backlog-full" ? 429 : 400);
        }
        return redirect(response, taskHref(filed.id));
      }
      case "plan": {
        // The operator's explicit ask, refused transactionally when the
        // moment has passed — approved scope, live claim, or a plan
        // already under way (Codex planning review's requestPlan guard).
        const asked = store.requestPlan(ref.id, now);
        if (!asked.ok) {
          return taskScreen(response, who, taskId, `not planned: ${asked.reason}`, 409);
        }
        if (who.via === "cookie") authorizePlanUnderMode(store, taskId, who.name, now);
        return redirect(response, taskHref(taskId));
      }
      case "plan-edit": {
        const body = readForm(posted, CONSOLE_FORMS.taskPlanEdit);
        if (who.via !== "cookie") {
          return refuse(response, who, 403, "editing a plan is a browser session's act");
        }
        const scope = store.getScope(taskId);
        const current = planViewOf(ref.id);
        if (ref.plan !== "drafted" || scope === null || current === null) {
          return taskScreen(response, who, taskId, "there is no editable plan on this task", 409);
        }
        if (approvalOf(scope).approved) {
          return taskScreen(response, who, taskId, "this plan is already approved and locked — file a revision instead", 409);
        }
        if (store.hasLiveClaim(ref.id, now)) {
          return taskScreen(response, who, taskId, "this task is running — its plan cannot change underneath the agent", 409);
        }
        if ((body.get("saw-plan") ?? "") !== current.sha256) {
          return taskScreen(response, who, taskId, "the plan changed while this editor was open — read the latest version and try again", 409);
        }
        const document = (body.get("plan-document") ?? "").replace(/\r\n?/g, "\n").trim();
        const parsed = parseExecutionPlanDocument(document);
        if (!parsed.ok) {
          return taskScreen(response, who, taskId, `plan not saved: ${parsed.problems.map(one => one.message).join("; ")}`, 400);
        }
        const proof = parsed.document.proof.join("\n");
        const missing = scope.acceptance.filter(criterion => {
          const id = criterion.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return !new RegExp(`(^|[^A-Za-z0-9_-])${id}([^A-Za-z0-9_-]|$)`).test(proof);
        });
        if (missing.length > 0) {
          return taskScreen(response, who, taskId, `plan not saved: Proof must name ${missing.map(one => one.id).join(", ")}`, 400);
        }
        if (document === current.document.trim()) return redirect(response, taskHref(taskId));
        const content = Buffer.from(`${document}\n`, "utf8");
        if (content.length > TEXT_LIMITS.planDocumentBytes) {
          return taskScreen(response, who, taskId, `plan not saved: it is over ${TEXT_LIMITS.planDocumentBytes} bytes`, 400);
        }
        try {
          const name = `plan-edit-${randomUUID().replace(/-/g, "")}.md`;
          const key = writeEvidenceFile(evidenceRoot, current.run, name, content);
          store.saveArtifact({
            run: current.run,
            kind: "plan",
            key,
            bytesOriginal: content.length,
            bytesStored: content.length,
            truncated: false,
            sha256: createHash("sha256").update(content).digest("hex"),
            capture: `operator edit by ${who.name} (verified session)`,
          }, now);
        } catch {
          return taskScreen(response, who, taskId, "the plan could not be saved safely — nothing changed", 500);
        }
        return redirect(response, taskHref(taskId));
      }
      case "accept-revision":
      case "reject-revision": {
        const body = readForm(posted, CONSOLE_FORMS.taskRevision);
        // Adaptive execution plans (v44): resolving a revision the builder
        // filed while its authority snapshot no longer matched the run it
        // started under — the ONLY road a 'blocked' plan_revision reaches,
        // since a plan-only proposal auto-applies without ever pausing here.
        if (who.via !== "cookie") {
          return refuse(response, who, 403, "resolving a plan revision is a browser session's act");
        }
        const revisionId = Number(body.get("revision-id") ?? "");
        const revision = Number.isFinite(revisionId) ? store.getPlanRevision(revisionId) : null;
        if (revision === null || revision.taskRef !== ref.id || revision.status !== "blocked") {
          return taskScreen(response, who, taskId, "that plan revision is no longer waiting on a decision — refresh and try again", 409);
        }
        const outcome = verb === "accept-revision" ? "applied" : "rejected";
        if (outcome === "applied") {
          // Accepting a revision that changed signed scope or publication
          // authority takes the password ceremony again — the same act
          // that would be required to approve that authority from scratch.
          const token = (body.get("token") ?? "").trim();
          if (!authenticateApprover(who, token).ok) {
            return taskScreen(response, who, taskId, "accepting this revision takes your password, typed again", 403);
          }
        }
        const resolved = store.resolvePlanRevision(revision.id, outcome, who.name, now);
        if (!resolved) {
          return taskScreen(response, who, taskId, "that plan revision is no longer waiting on a decision — refresh and try again", 409);
        }
        store.releaseOwnedHold("revision", String(revision.id));
        return redirect(response, taskHref(taskId));
      }
      case "cancel": {
        const body = readForm(posted, CONSOLE_FORMS.taskCancel);
        const reason = body.get("reason") ?? undefined;
        const cancelled = withActor({ account: who.name, lead: false }, () => store.cancelTask(taskId, now, reason));
        if (!cancelled.ok) {
          if (cancelled.reason === "reason-required" || cancelled.reason === "bad-reason") {
            return taskScreen(response, who, taskId,
              cancelled.reason === "reason-required"
                ? "Enter a reason for cancelling this coordinator filing."
                : "Use at most 500 plain characters, without hidden or control characters.",
              400, undefined, reason ?? "");
          }
          return taskScreen(response, who, taskId, `not cancelled: ${cancelled.reason}`, 409);
        }
        return redirect(response, taskHref(taskId));
      }
      case "route": {
        const body = readForm(posted, CONSOLE_FORMS.taskRoute);
        // THE AGENTS EDIT (v47): an approver's session declares the risk,
        // overrides one role to an exact agent, or clears an override — ONE
        // authenticated transaction in the store that CAS-checks the scope
        // digest the form rendered (empty = "I saw no scope"), records the
        // change under this name, reconciles the planner pin, re-files the
        // scope so a sealed route goes visibly stale, and re-requests a
        // drafted plan when the planner changed. The viewer gate above
        // already refused a watcher; a live claim or a tournament refuses
        // inside the transaction.
        const riskGiven = body.get("risk");
        const sizeGiven = body.get("size");
        const riskyGiven = body.getAll("risky");
        const phaseGiven = body.get("phase");
        const clearGiven = body.get("clear-phase");
        // The agent arrives as the form's `provider|model` choice (v48) or,
        // for older clients, as separate fields — either way it must be one
        // of the CONFIGURED, role-valid choices right now: the form offers
        // nothing else, and the server believes nothing else.
        const agentGiven = (body.get("agent") ?? "").trim();
        const providerGiven = agentGiven === "" ? body.get("provider") : agentGiven.slice(0, agentGiven.indexOf("|") === -1 ? agentGiven.length : agentGiven.indexOf("|"));
        const modelGiven = agentGiven === "" ? (body.get("model") ?? "").trim() : agentGiven.indexOf("|") === -1 ? "" : agentGiven.slice(agentGiven.indexOf("|") + 1).trim();
        const sawDigest = body.get("sawDigest");
        if (riskGiven !== null && !isRiskLevel(riskGiven)) return taskScreen(response, who, taskId, "risk is routine, elevated, or high", 400);
        const phase = phaseGiven ?? clearGiven;
        if (phase !== null && !(ROUTE_PHASES as readonly string[]).includes(phase)) return taskScreen(response, who, taskId, "the role is planner, builder, or revision", 400);
        if (sizeGiven !== null && !isTaskSize(sizeGiven)) return taskScreen(response, who, taskId, "size is small, medium, or large", 400);
        if (riskyGiven.some(one => one !== "yes" && one !== "no")) return taskScreen(response, who, taskId, "risky is yes or no", 400);
        // A size keeps the task's risky flag unless the form says otherwise; marking risky keeps the size.
        const sizeEdit = sizeGiven === null && riskyGiven.length === 0 ? undefined : {
          size: sizeGiven !== null && isTaskSize(sizeGiven) ? sizeGiven : ref.sizing?.size ?? "medium",
          risky: riskyGiven.includes("yes") ? true : riskyGiven.includes("no") ? false : ref.sizing?.risky ?? false,
        };
        if (riskGiven === null && phase === null && sizeEdit === undefined) return taskScreen(response, who, taskId, "nothing to change about the agents", 400);
        if (phaseGiven !== null) {
          if (providerGiven === null || !isProviderId(providerGiven)) return taskScreen(response, who, taskId, "provider is claude, codex, openrouter, or gemini", 400);
          if (modelGiven === "") return taskScreen(response, who, taskId, "name the exact model id — approvals bind exact agents", 400);
          const valid = validateSpec({ provider: providerGiven, model: modelGiven });
          if (!valid.ok) return taskScreen(response, who, taskId, `agents not changed: ${valid.problem}`, 400);
          if (phaseGiven === "review" && providerGiven === "gemini") return taskScreen(response, who, taskId, "gemini cannot review yet — choose claude or codex", 400);
        }
        // The configured-choice proof lives INSIDE the edit transaction
        // (`configured`): the pair is held to the role's choices under the
        // configuration standing at that instant, and a stale choice
        // mutates nothing.
        const edited = store.editTaskRoute(
          ref.id,
          {
            by: who.name,
            authenticate: () => {
              const account = store.accountOf(who.name);
              return account !== null && account.revokedAt === null && account.role === "approver" ? { ok: true } : { ok: false, reason: "your login is no longer an approver" };
            },
            ...(riskGiven === null ? {} : { risk: riskGiven as RiskLevel }),
            // A person's size replaces the classifier's; the risky flag rides with it.
            ...(sizeEdit === undefined ? {} : { size: sizeEdit }),
            ...(phase === null
              ? {}
              : { override: phaseGiven !== null ? { phase: phase as RouteOverride["phase"], provider: providerGiven as ProviderId, model: modelGiven } : { phase: phase as RouteOverride["phase"], clear: true as const } }),
            ...(sawDigest === null ? {} : { expectDigest: sawDigest === "" ? null : sawDigest }),
            configured: true,
          },
          now,
        );
        if (!edited.ok) {
          return taskScreen(response, who, taskId, edited.reason === "not-configured" ? `agents not changed: ${edited.detail}` : edited.detail, edited.reason === "unauthenticated" ? 403 : edited.reason === "nothing" || edited.reason === "not-configured" ? 400 : 409);
        }
        // v102: changing how a task runs is authoring it — the requester rule then refuses this person too.
        const routed = store.getScope(taskId);
        if (routed !== null) store.recordScopeAuthor(taskId, routed.digest, who.name, now);
        const toChat = body.get("return") === "chat";
        const back = toChat ? taskChatHref(taskId) : taskHref(taskId);
        const said = [
          ...(edited.staled ? ["agents changed — the earlier approval no longer covers this task; approve it again"] : []),
          ...(edited.replanned ? ["the planner changed after a draft landed — a new plan was requested"] : []),
        ];
        const target = said.length === 0 ? back : chatReturnWithSaid(back, said.join("; "));
        return redirect(response, toChat ? target : `${target}#agents`);
      }
      case "scope": {
        const body = readForm(posted, CONSOLE_FORMS.taskScope);
        const sawDigest = body.get("sawDigest");
        const permissionGiven = body.get("permission-mode");
        if (permissionGiven !== null && permissionGiven !== "" && permissionGiven !== "auto" && permissionGiven !== "bypassPermissions") {
          return taskScreen(response, who, taskId, "permissions must be Auto or Full access", 400);
        }
        const permissionMode: UnattendedPermissionMode =
          permissionGiven === "bypassPermissions"
            ? "bypassPermissions"
            : permissionGiven === "auto"
              ? "auto"
              : ref.permissionMode ?? store.permissionDefault().mode;
        const qualityGiven = body.get("quality-mode");
        if (qualityGiven !== null && qualityGiven !== "" && !isQualityMode(qualityGiven)) {
          return taskScreen(response, who, taskId, "quality must be Default or Strict / release", 400);
        }
        const qualityMode: QualityMode =
          qualityGiven === "strict"
            ? "strict"
            : qualityGiven === "default"
              ? "default"
              : ref.qualityMode ?? store.qualityDefault().mode;
        // The optional per-attempt dollar cap (v15) rides the same form.
        const budgetGiven = (body.get("budget-usd") ?? "").trim();
        const budgetUsd = budgetGiven === "" ? null : Number(budgetGiven);
        if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
          return taskScreen(response, who, taskId, "the dollar cap is a positive amount", 400);
        }
        // The approval sheet's in-place editor carries the cap it was shown
        // exactly, in millionths, and "none" for no limit (never a default).
        const exactBudgetGiven = body.get("budget-microusd");
        const exactBudget = exactBudgetGiven === null ? undefined : exactBudgetGiven === "none" ? null : /^[1-9][0-9]{0,14}$/.test(exactBudgetGiven) ? Number(exactBudgetGiven) : NaN;
        if (Number.isNaN(exactBudget)) return taskScreen(response, who, taskId, "the dollar cap is a positive amount", 400);
        const inPlace = body.has("requirement-new");
        // The tournament controls (operator request): a count of 2–4 files
        // race terms BESIDE the scope — validated and priced BEFORE anything
        // saves, so a bad tournament never half-lands on a good scope.
        const raceCountGiven = (body.get("race-count") ?? "").trim();
        // The comparison lanes (slice B): any filled row files a comparison
        // INSTEAD of a tournament — planned and refused BEFORE the save,
        // filed INSIDE the same transaction (round-6 finding 5 discipline).
        const comparisonLanes = [1, 2, 3, 4]
          .map(lane => ({
            provider: (body.get(`compare-provider-${lane}`) ?? "").trim(),
            model: (body.get(`compare-model-${lane}`) ?? "").trim(),
            permissionMode,
          }))
          .filter(lane => lane.provider !== "" || lane.model !== "");
        let plannedComparison: ReturnType<typeof planComparison> | null = null;
        if (comparisonLanes.length > 0) {
          if (raceCountGiven !== "") {
            return taskScreen(response, who, taskId, "a tournament and a comparison are different ceremonies — file one or the other", 400);
          }
          if (store.mirrorByTask(taskId) !== null) {
            return taskScreen(response, who, taskId, "external work compares in a follow-up release — file the comparison on a local task", 409);
          }
          plannedComparison = planComparison({ agents: comparisonLanes });
          if (!plannedComparison.ok) {
            return taskScreen(response, who, taskId, `comparison not filed: ${plannedComparison.message}`, 400);
          }
        }
        let plannedRace: { agents: { provider: string; model: string; repairModel: string }[]; perAgentBudgetMicrousd: number; overrunReserveMicrousd: number; totalBudgetMicrousd: number; priceVersion: number; publicationPolicy: string; raceDigest: string } | null = null;
        if (raceCountGiven !== "") {
          const count = Number(raceCountGiven);
          const model = body.get("race-model") ?? "";
          if (!Number.isInteger(count) || count < 2 || count > 4) {
            return taskScreen(response, who, taskId, "a tournament races 2 to 4 agents", 400);
          }
          const perUsd = Number((body.get("race-per-usd") ?? "").trim());
          const totalUsd = Number((body.get("race-total-usd") ?? "").trim());
          const planned = planTournament({
            agents: Array.from({ length: count }, () => ({ provider: "claude", model, permissionMode })),
            perAgentBudgetUsd: perUsd,
            totalBudgetUsd: totalUsd,
          });
          if (!planned.ok) {
            return taskScreen(response, who, taskId, `tournament not filed: ${planned.message}`, 400);
          }
          plannedRace = planned.plan;
        }
        // Refusals that must hold ATOMICALLY with the save (round-6 finding
        // 5): a race request refused AFTER proposeGuarded would still have
        // rewritten the scope — so proposal, the attended exclusion, and
        // race-term filing share one transaction, and every refusal inside
        // it rolls the whole act back.
        if (plannedRace !== null && store.mirrorByTask(taskId) !== null) {
          return taskScreen(response, who, taskId, "external work races in a follow-up release — file the tournament on a local task", 409);
        }
        let saved: { ok: true } | { ok: false; status: number; message: string };
        try { saved = store.transact(():
          | { ok: true }
          | { ok: false; status: number; message: string } => {
          if ((plannedRace !== null || plannedComparison !== null) && store.openAuthorizationFor(ref.id) !== null) {
            return { ok: false, status: 409, message: "an attended authorization is open on this task — revoke it before filing a tournament or comparison" };
          }
          // C1/M3: the signer's own credentialed filing auto-approves —
          // coverage is asked INSIDE this transaction, the escalated
          // default and budget ride the filing, and the seal commits
          // atomically with it. Plain scopes only: a tournament or
          // comparison keeps its own human ceremony.
          // COOKIE ONLY (C1's channel table; surfaces round 1, finding 1):
          // bearer credentials are for machines, and a machine road must
          // never spend the signer's mode.
          const coverage =
            who.via === "cookie" && plannedRace === null && plannedComparison === null
              ? modeFilingCoverage(store, ref.repo, who.name, now)
              : null;
          const before = store.getScope(taskId);
          const proposed = proposeGuarded(store, {
            taskId, author: who.name,
            goal: body.has("goal-brief") ? `${(body.get("goal") ?? "").trim()}${body.get("goal-brief")}` : body.get("goal") ?? "",
            outOfScope: body.get("not") ?? null,
            touches: (body.get("touches") ?? "").split(/[\n,]/),
            // The approval sheet's in-place editor sends Done when line by line.
            acceptance: inPlace
              ? requirementsFromEditor(body, before?.acceptance ?? [])
              : acceptanceLinesToInput((body.get("acceptance") ?? "").split("\n")),
            permissionMode,
            qualityMode,
            ...(exactBudget !== undefined
              ? exactBudget === null ? {} : { budgetMicrousd: exactBudget }
              : budgetUsd !== null
              ? { budgetMicrousd: Math.round(budgetUsd * 1_000_000) }
              : coverage?.defaultBudgetMicrousd != null
                ? { budgetMicrousd: coverage.defaultBudgetMicrousd }
                : {}),
            ...(coverage?.escalated === true ? { posture: "escalated" as const } : {}),
            sawDigest: sawDigest === null || sawDigest === "" ? null : sawDigest,
            taskRef: ref.id,
            now,
          });
          if (!proposed.ok) {
            return {
              ok: false,
              status: proposed.reason === "changed" || proposed.reason === "claimed" ? 409 : 400,
              message: proposed.message ?? (proposed.reason === "acceptance-required" ? "Not saved: add at least one requirement under Done when." : `scope not saved: ${proposed.reason}`),
            };
          }
          // Editing the plan in place never changes what the agent may do:
          // a save that would (a legacy setting, a newer policy or mode)
          // rolls back whole.
          if (inPlace && before?.profile != null && proposed.scope.profile != null && levelOfProfile(before.profile) !== levelOfProfile(proposed.scope.profile)) {
            throw new PermissionsWouldChange();
          }
          if (coverage !== null && ref.plan === "requested") {
            authorizePlanUnderMode(store, taskId, who.name, now);
          } else if (coverage !== null) {
            const filedScope = store.getScope(taskId);
            if (filedScope?.profileState === "resolved") {
              const sealedUnderMode = store.sealScopeApproval(taskId, who.name, now, {}, { kind: "mode", modeDigest: coverage.digest });
              // The quarantine speaks at the caller (review finding 7).
              if (!sealedUnderMode) {
                return { ok: false, status: 200, message: "scope saved — coordinator-filed: mode coverage cannot admit it; sign the scope" };
              }
            }
          }
          if (plannedComparison !== null && plannedComparison.ok) {
            store.fileTournamentTerms(
              {
                taskRef: ref.id,
                kind: "comparison",
                raceDigest: plannedComparison.plan.comparisonDigest,
                agents: plannedComparison.plan.agents,
                perAgentBudgetMicrousd: 0,
                overrunReserveMicrousd: 0,
                totalBudgetMicrousd: 0,
                priceVersion: 0,
                publicationPolicy: plannedComparison.plan.publicationPolicy,
              },
              now,
            );
            return { ok: true };
          }
          if (plannedRace === null) {
            // Switching back to "one agent" withdraws a standing race OR
            // comparison — the deactivated row survives as history, and
            // the approval card returns to the scope alone.
            store.retractTournamentTerms(ref.id);
            return { ok: true };
          }
          store.fileTournamentTerms(
            {
              taskRef: ref.id,
              raceDigest: plannedRace.raceDigest,
              agents: plannedRace.agents,
              perAgentBudgetMicrousd: plannedRace.perAgentBudgetMicrousd,
              overrunReserveMicrousd: plannedRace.overrunReserveMicrousd,
              totalBudgetMicrousd: plannedRace.totalBudgetMicrousd,
              priceVersion: plannedRace.priceVersion,
              publicationPolicy: plannedRace.publicationPolicy,
            },
            now,
          );
          return { ok: true };
        }); } catch (error) {
          if (!(error instanceof PermissionsWouldChange)) throw error;
          saved = { ok: false, status: 409, message: "Not saved: this would change what the agent may do. Change permissions in Details, under edit the scope." };
        }
        if (!saved.ok) {
          // Refused because the plan moved on: the draft comes back with the version now on file, so saving it
          // again (having read the reason) can succeed instead of being refused the same way.
          const draft = new URLSearchParams(body.sent);
          if (saved.status === 409) draft.set("sawDigest", store.getScope(taskId)?.digest ?? "");
          return taskScreen(response, who, taskId, saved.message, saved.status, draft);
        }
        return redirect(response, taskHref(taskId));
      }
      case "approve": {
        if (who.via !== "cookie") return refuse(response, who, 403, REMOTE_MESSAGES["step-up"]);
        const body = readForm(posted, CONSOLE_FORMS.taskApprove);
        const requestedReturn = body.get("return");
        const approvalBack = requestedReturn === "next"
          ? "/next"
          : requestedReturn === null
            ? taskHref(taskId)
            : safeChatReturn(requestedReturn);
        const approvalProblem = (message: string, status: number): void => {
          if (requestedReturn !== null && requestedReturn !== "next") {
            return redirect(response, chatReturnWithSaid(approvalBack, message));
          }
          return taskScreen(response, who, taskId, message, status);
        };
        const approvingRef = store.lookupRef(taskId);
        if (approvingRef?.plan === "requested") {
          return approvalProblem(
            "approval is blocked while planning is in progress — review the drafted plan first",
            409,
          );
        }
        // Step-up: the session got you here; only the token agrees. The
        // digest names what was seen; the nonce proves this exact form was
        // rendered to this approver and is spent either way.
        const digest = body.get("digest") ?? "";
        const token = body.get("token") ?? "";
        const nonce = body.get("nonce") ?? "";
        if (!consumeApprovalNonce(nonce, who.name, taskId, digest)) {
          return approvalProblem("that approval form is stale — read it again", 409);
        }
        if (token === "" && !hasFreshIdentitySignIn(who.name)) {
          return approvalProblem("approval requires your password, typed again", 400);
        }
        const scopeRow = store.getScope(taskId);
        if (scopeRow === null) return approvalProblem("this task has no scope to approve", 409);
        const raceTerms = store.activeTournamentTerms(ref.id);
        const planView = planViewOf(ref.id);
        const expectedDigest = approvalFormDigest(scopeRow.digest, raceTerms?.raceDigest ?? null, planView?.sha256 ?? null);
        if (digest !== expectedDigest) {
          return approvalProblem("the scope or plan changed while this form was open — read the latest version and approve again", 409);
        }
        // A revision approves ONLY against a brief that still verifies
        // (Codex M5-M8 audit, IV-3): the batch the screen restated must be
        // provably the batch on disk at the moment of the yes — a brief
        // deleted or corrupted between render and click blocks the
        // approval instead of silently approving comment-free work.
        if (approvingRef !== null && approvingRef.revisionBriefArtifact !== null) {
          const view = revisionViewOf(approvingRef);
          if (view !== null && "problem" in view) {
            return approvalProblem(`approval is blocked: ${view.problem}`, 409);
          }
        }
        // A tournament task's yes covers BOTH documents (finding 31): the
        // form bound the joint fingerprint, and the scope and race terms
        // approve together, in one transaction, or not at all.
        if (raceTerms !== null) {
          const both = store.transact(() => {
            const scopeApproved = approveScope(store, taskId, who.name, now, scopeRow.digest, token);
            if (!scopeApproved.ok) return scopeApproved;
            if (!store.approveTournamentTerms(raceTerms.id, who.name, raceTerms.raceDigest, now)) {
              throw new Error("the race terms changed while you were reading — nothing was approved");
            }
            return scopeApproved;
          });
          if (!both.ok) {
            if (both.reason === "second-approver") return approvalProblem(gateWords({ verdict: "vote", have: both.have, need: 2, already: both.already }), 200);
            if (both.reason === "policy") return approvalProblem(both.message, 403);
            const status = both.reason === "changed" || both.reason === "unrouted" ? 409 : 403;
            return approvalProblem(approveRefusalWords(both.reason), status);
          }
          return redirect(response, approvalBack);
        }
        const approved = approveScope(store, taskId, who.name, now, scopeRow.digest, token);
        if (!approved.ok) {
          // v102: a first yes on protected work is recorded, not refused — the page says who else is needed.
          if (approved.reason === "second-approver") return approvalProblem(gateWords({ verdict: "vote", have: approved.have, need: 2, already: approved.already }), 200);
          if (approved.reason === "policy") return approvalProblem(approved.message, 403);
          const status = approved.reason === "changed" || approved.reason === "unrouted" ? 409 : 403;
          return approvalProblem(approveRefusalWords(approved.reason), status);
        }
        return redirect(response, approvalBack);
      }
      case "accept-proof": {
        const body = readForm(posted, CONSOLE_FORMS.taskAcceptProof);
        // Accepting is a person's act, like approving a scope (Priority
        // 2): a cookie session only, never a bearer credential.
        if (who.via !== "cookie") {
          return refuse(response, who, 403, "accepting a proof is a browser session's act");
        }
        // v40 fix: a reviewer run is never the attempt whose proof is
        // being accepted.
        const latest = store.runsFor(ref.id).find(runIsTaskResult);
        if (latest === undefined) {
          return taskScreen(response, who, taskId, "this task has no finished attempt to accept", 404);
        }
        const family = store.taskFamilyOf(taskId, admissionList(), false);
        if (Number(body.get("run")) !== latest.id || family?.current.id !== taskId || family.problem !== null) {
          return taskScreen(response, who, taskId, "This result changed. Review the current result before accepting.", 409);
        }
        const rawNote = (body.get("note") ?? "").trim();
        let note: string | null = null;
        if (rawNote !== "") {
          const validated = validateNote(rawNote);
          if (!validated.ok) {
            return taskScreen(response, who, taskId, validated.problem, 400);
          }
          note = validated.note;
        }
        // A failed task's result is accepted only anyway, on purpose: with a reason.
        if (note === null && store.getTask(taskId)?.state === "failed") {
          // Posted from the result page: back there, where the reason field is, with the refusal said on it.
          const back = body.get("return") === null ? null : safeReturn(body.get("return"));
          if (back !== null && back.startsWith("/review?")) return redirect(response, withRefusal(back, "reason"));
          return taskScreen(response, who, taskId, ACCEPT_ANYWAY_NEEDS_REASON, 400);
        }
        store.acceptProof(latest.id, verifiedAuthor(who.name), note, now);
        return redirect(response, body.get("return") === null ? taskHref(taskId) : safeReturn(body.get("return")));
      }
      case "complete": {
        const body = readForm(posted, CONSOLE_FORMS.taskComplete);
        if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "Only an approver can mark a result complete.");
        const principal = matePrincipal(who);
        if (principal === null) return refuse(response, who, 403, "Your access changed. Sign in again.");
        const digest = body.get("receipt") ?? "";
        const namedRun = body.get("run") ?? "";
        const current = assignmentOf(store, taskId, now, { principal: "operator", repos: principal.repos }, evidenceRoot);
        if (current === null || current.receipt?.taskId !== taskId || !/^[0-9]{1,15}$/.test(namedRun) || current.receipt.runId !== Number(namedRun)) {
          return taskScreen(response, who, taskId, "This result changed. Open the current result before marking it complete.", 409);
        }
        if (body.get("accept") === "1") {
          // Accept and finish: the person's acceptance and the completion of what it accepted, in one request
          // and one transaction. The receipt named is the one read, before accepting.
          const rawNote = (body.get("note") ?? "").trim();
          let note: string | null = null;
          if (rawNote !== "") {
            const validated = validateNote(rawNote);
            if (!validated.ok) return taskScreen(response, who, taskId, validated.problem, 400);
            note = validated.note;
          }
          const publish = body.get("publish") === "1";
          const finished = acceptAndCompleteAsOperator(store, taskId, { runId: Number(namedRun), receiptDigest: digest, note }, principal, now, evidenceRoot,
            publish ? accepted => completeAndOpenPullRequest(store, { taskId, digest: accepted, runId: Number(namedRun), who: principal, root: evidenceRoot }, now) : undefined);
          if (!finished.ok) return taskScreen(response, who, taskId, finished.message, finished.reason === "needs-reason" ? 400 : 409);
          return redirect(response, publish ? `${taskHref(familyOf(taskId)?.root.id ?? taskId)}#merge` : body.get("return") === null ? reviewHref(taskId, Number(namedRun)) : safeReturn(body.get("return")));
        }
        if (body.get("publish") === "1") {
          // "Complete and open a pull request": the same exact-receipt completion, plus the owed PR for this
          // exact commit in one transaction. The watch process pushes and opens it; the task shows its progress.
          const opened = completeAndOpenPullRequest(store, { taskId, digest, runId: Number(namedRun), who: principal, root: evidenceRoot }, now);
          if (!opened.ok) return taskScreen(response, who, taskId, opened.message, 409);
          return redirect(response, `${taskHref(familyOf(taskId)?.root.id ?? taskId)}#merge`);
        }
        const completed = checkAssignmentAsOperator(store, taskId, digest, principal, now, evidenceRoot);
        if (!completed.ok) return taskScreen(response, who, taskId, completed.message, 409);
        return redirect(response, reviewHref(taskId, Number(namedRun)));
      }
      case "retry-review": {
        return taskScreen(response, who, taskId, "Separate agent reviews have retired. Open the saved result to mark it complete or request a revision.", 410);
      }
      case "stop": {
        const body = readForm(posted, CONSOLE_FORMS.taskStop);
        // The exact-run stop (v52): a browser session's act, an approver's
        // act, naming ONE run. The store's transaction proves the run is
        // this task's current live attempt and records who asked before
        // any process is signalled; the answer is "stopping", never
        // "stopped". A repeated post is the same request; a stale one (a
        // finished run, a successor) is refused in words.
        if (who.via !== "cookie") return refuse(response, who, 403, "stopping a task is a browser session's act");
        if (who.role !== "approver") return taskScreen(response, who, taskId, "your login can watch — stopping an attempt is an approver's act", 403);
        if (store.isDemo()) return taskScreen(response, who, taskId, "the demo authorizes nothing", 403);
        const named = (body.get("run") ?? "").trim();
        if (!/^[0-9]{1,15}$/.test(named)) return taskScreen(response, who, taskId, "which attempt? the stop names one exact run", 400);
        const asked = requestTaskStop(store, { taskId, runId: Number(named), by: verifiedAuthor(who.name), via: "web", held: options.attended?.coordinator }, now);
        if (!asked.ok) {
          const words: Record<string, string> = {
            "no-run": `there is no run #${escape(named)}`,
            "wrong-task": `run #${escape(named)} is not one of this task's attempts`,
            finished: `run #${escape(named)} already ended before the stop — nothing rewrites a finished attempt; reload to see the current state`,
            "not-live": `run #${escape(named)} is not the attempt holding this task now — reload and decide against the current attempt`,
            tournament: "this run is a racing lane — stop the tournament through its own pick or abandon controls",
            publication: `run #${escape(named)} already admitted its publication — an external request in flight is not recalled by a stop`,
          };
          return taskScreen(response, who, taskId, words[asked.reason] ?? asked.detail, 409);
        }
        const back = body.get("return") ?? "";
        return redirect(response, back === "chat" ? `${taskChatHref(taskId)}#task-control` : `${taskHref(taskId)}#task-control`);
      }
      case "resume-arm": {
        const body = readForm(posted, CONSOLE_FORMS.taskResume);
        return armTaskResume(response, who, taskId, (body.get("run") ?? "").trim(), body.get("return") === "chat" ? "chat" : "task", now);
      }
      case "resume": {
        const body = readForm(posted, CONSOLE_FORMS.taskResume);
        // The resume itself (v52): password typed again + the durable nonce
        // consumed INSIDE the store's resume transaction against the digest
        // re-derived from live state. A replay finds the nonce spent; a
        // changed approval finds the digest moved; a successor attempt finds
        // the run superseded — each refuses without starting work; a submitted nonce remains one-shot.
        if (who.via !== "cookie") return refuse(response, who, 403, "resuming a task is a browser session's act");
        if (who.role !== "approver") return taskScreen(response, who, taskId, "your login can watch — resuming an attempt is an approver's act", 403);
        if (store.isDemo()) return taskScreen(response, who, taskId, "the demo authorizes nothing", 403);
        const named = (body.get("run") ?? "").trim();
        if (!/^[0-9]{1,15}$/.test(named)) return taskScreen(response, who, taskId, "which attempt? the resume names the exact stopped run", 400);
        const runId = Number(named);
        const token = body.get("token") ?? "";
        if (!authenticateApprover(who, token).ok) {
          return taskScreen(response, who, taskId, "resuming takes your password, typed again", 403);
        }
        const nonceValue = body.get("nonce") ?? "";
        if (nonceValue === "") return taskScreen(response, who, taskId, "that confirmation form was incomplete — start again", 400);
        const resumed = store.transact(() => {
          const stop = store.stopOf(runId);
          if (stop === null || stop.taskRef !== ref.id) return { ok: false as const, reason: "no-stop" as const, detail: `run #${runId} is not a stopped attempt of this task` };
          const digest = resumeDigestOf(taskId, runId, stop.settledAt ?? "", store.getScope(taskId));
          if (!store.consumeCeremonyNonce(nonceHashOf(nonceValue), who.name, "run-resume", runId, digest, now)) {
            return { ok: false as const, reason: "stale" as const, detail: "that confirmation is stale, already used, or the approval changed since you read it — start again from the task" };
          }
          return resumeTaskStop(store, { taskId, runId, by: verifiedAuthor(who.name), via: "web" }, now);
        });
        if (!resumed.ok) {
          const words: Record<string, string> = {
            stale: resumed.detail,
            "no-stop": resumed.detail,
            stopping: `not yet — ${resumed.detail}`,
            occupied: `not yet — ${resumed.detail}`,
            "already-resumed": resumed.detail,
            superseded: resumed.detail,
            busy: resumed.detail,
            review: `run #${runId} is a review — use Review again, which keeps its bounded attempts`,
          };
          return taskScreen(response, who, taskId, words[resumed.reason] ?? resumed.detail, 409);
        }
        const back = body.get("return") ?? "";
        return redirect(response, back === "chat" ? `${taskChatHref(taskId)}#task-control` : `${taskHref(taskId)}#task-control`);
      }
      default:
        return refuse(response, who, 404, "That action isn't available here.", taskHref(taskId));
    }
  }

  /** The queue as a region: dispatch order per column, drag handles and
   * all — the /queue page's body, and the board's "order" view (the one
   * place dragging exists, because reordering and reserving are scheduling,
   * never authority). */
  function queueRegionFor(project: string | null, csrf: string, revision: number, now: Date): string {
    const tasks = store.queueScoped(project, now).map(one => ({
      ...one,
      dispatch: diagnoseTaskDispatch(store, one.id, now),
    }));
    const owned = new Set(tasks.map(one => one.assignedRunner).filter((one): one is string => one !== null));
    const building = new Map<string, number>();
    for (const claim of store.liveClaims(project, now)) {
      building.set(claim.runner, (building.get(claim.runner) ?? 0) + 1);
    }
    const workers = store
      .listRunners()
      .filter(one => one.retiredAt === null || owned.has(one.name))
      .map(one => ({
        name: one.name,
        retired: one.retiredAt !== null,
        note: one.queueNote ?? null,
        capacity: one.capacity,
        building: building.get(one.name) ?? 0,
      }));
    return queueBody(tasks, workers, csrf, revision, store.queueRevision());
  }


  /** An OBSERVED CI failure on a completed row's PR — the open episode the
   * watcher recorded for exactly that repository and number; never a guess
   * from quiet. One indexed publication read per row that has a PR. */
  function ciFailingFor(runId: number | null, prNumber: number | null): boolean {
    if (runId === null || prNumber === null) return false;
    const publication = store.publicationForRun(runId);
    return publication !== null && publication.prNumber === prNumber && store.hasOpenCiEpisode(publication.githubRepo, prNumber);
  }

  /**
   * One completed row by task id, for a `?result=` deep link the bounded
   * queue could not show — the done list's own predicate, re-proved per
   * read: the task is done, sits in this project (or in none), and its
   * repository passes the ceiling; the result run is the newest finished
   * built/no-change builder or scout attempt. Anything else is
   * null, and null reads exactly like a task that never existed.
   */
  function completedRowFor(taskId: string, project: string | null): CompletedWorkRow | null {
    const family = familyOf(taskId);
    if (family === null) return null;
    const task = store.getTask(taskId);
    const ref = store.lookupRef(taskId);
    if (task === null || ref === null || task.state !== "done") return null;
    if (!(project === null || ref.repo === null || ref.repo === project) || !visible(ref.repo)) return null;
    const run =
      store.runsFor(ref.id).find(
        one =>
          (one.outcome === "built" || one.outcome === "no-change") &&
          one.finishedAt !== null &&
          (one.role === "builder" || one.role === "scout"),
      ) ?? null;
    return resultRowOf(task, ref.repo, family.problem, run);
  }

  /**
   * A build attempt that didn't deliver a result (failed, refused, stopped,
   * never finished) still has a result page: its changes, its checks and what
   * went wrong. The row for one: the run named by `runId` when it is an ended
   * builder or scout attempt of this task that isn't a delivered result, or a
   * failed task's latest attempt; with no run named, that latest attempt. The
   * same admission as a completed row: in this project (or none) and inside
   * the ceiling. Null otherwise, which reads like a task that never existed.
   */
  function attemptRowFor(taskId: string, runId: number | null, project: string | null): CompletedWorkRow | null {
    const family = familyOf(taskId);
    const task = store.getTask(taskId);
    const ref = store.lookupRef(taskId);
    if (family === null || task === null || ref === null) return null;
    if (!(project === null || ref.repo === null || ref.repo === project) || !visible(ref.repo)) return null;
    const attempts = store.runsFor(ref.id).filter(one => (one.role === "builder" || one.role === "scout") && (one.finishedAt !== null || one.outcome !== null));
    const latest = task.state === "failed" ? latestFinishedAttempt(attempts) : null;
    const run = runId !== null ? attempts.find(one => one.id === runId) ?? null : latest;
    // A delivered result has its completed row; a failed task's latest attempt is what failed, whatever it ended as.
    if (run === null || runIsLive(run) || ((run.outcome === "built" || run.outcome === "no-change") && run.id !== latest?.id)) return null;
    return resultRowOf(task, ref.repo, family.problem, run);
  }

  function resultRowOf(task: NonNullable<ReturnType<Store["getTask"]>>, repo: string | null, historyProblem: string | null, run: Run | null): CompletedWorkRow {
    const ref = { repo };
    const family = { problem: historyProblem };
    const publication = run === null ? null : store.publicationForRun(run.id);
    const verdict = run === null ? null : store.proofVerdictFor(run.id);
    return {
      taskId: task.id,
      title: task.title,
      repo: ref.repo,
      completedAt: task.updatedAt,
      historyProblem: family.problem,
      outcome: run?.outcome ?? null,
      handoff: run?.handoff ?? null,
      costUsd: run?.costUsd ?? null,
      provider: run?.provider ?? null,
      authMode: run?.authMode === "subscription" || run?.authMode === "api-key" ? run.authMode : null,
      ranMinutes:
        run === null || run.finishedAt === null
          ? null
          : Math.max(1, Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 60_000)),
      prNumber: publication?.prNumber ?? null,
      prUrl: publication?.prUrl ?? null,
      publicationState: publication?.state ?? null,
      runId: run?.id ?? null,
      proofVerdict: verdict?.verdict ?? null,
      proofMatrix: verdict?.matrix ?? [],
      proofAccepted: run !== null && store.proofAcceptance(run.id) !== null,
    };
  }

  function reviewCockpitViewOf(row: RankedReviewRow, who: Who, now: Date): ReviewCockpitView {
    const ref = store.lookupRef(row.taskId);
    const scope = store.getScope(row.taskId);
    // The result run, read once: the contest road and the shared result
    // detail below both hang off this one record.
    const run = row.runId === null ? null : store.getRun(row.runId);
    const intent: ReviewCockpitView["intent"] =
      scope === null
        ? null
        : {
            goal: scope.goal,
            outOfScope: scope.outOfScope,
            touches: scope.touches,
            acceptance: scope.acceptance,
            approval: approvalOf(scope),
            approvedBy: scope.approvedBy,
          };
    const plan = (() => {
      if (ref === null) return null;
      const current = revisionLedgerOf(ref.id).current;
      if (current === null) return null;
      const parsed = parseExecutionPlanDocument(current.document);
      return {
        revision: current.revision,
        sha256: current.sha256,
        approach: parsed.ok ? oneLineOf(parsed.document.approach, 600) : null,
      };
    })();
    const contestOf = (): ReviewCockpitView["contest"] => {
      // Either road to a tournament: the result run was one of its
      // contestants, or the task still owes an operator a comparison.
      const viaRun = run?.contestant === null || run?.contestant === undefined ? null : store.getContestant(run.contestant);
      const contest = viaRun === null ? (ref === null ? null : store.contestNeedingOperator(ref.id)) : store.getContest(viaRun.contest);
      return contest === null ? null : { id: contest.id, state: contest.state, kind: contest.kind, agents: store.contestants(contest.id).length };
    };
    const base = {
      taskId: row.taskId,
      title: row.title,
      repo: row.repo,
      completedAt: row.completedAt,
      historyProblem: row.historyProblem ?? null,
      priority: row.priority,
      assignment: row.assignment ?? null,
      intent,
      plan,
      contest: contestOf(),
      ...(store.isDemo() ? { demo: true } : {}),
    };
    if (run === null) {
      return { ...base, run: null, detail: null, reviewRetry: null, review: null, notes: [] };
    }
    const detail = resultDetailOf(run, who, now);
    return {
      ...base,
      run: {
        id: run.id,
        role: run.role,
        outcome: run.outcome,
        runner: run.runner,
        provider: run.provider,
        model: run.model,
        finishedAt: run.finishedAt,
        branch: run.branch,
        headRevision: run.headRevision,
        ranMinutes: row.ranMinutes,
        cost: runCostWords(run, false),
        summary: detail.handoff?.conclusion ?? run.handoff,
      },
      detail,
      reviewRetry: store.reviewRetryStateOf(run.id),
      review: reviewFactsFor(run.id),
      notes: store.notesForRun(run.id),
    };
  }

  // ---- evidence ------------------------------------------------------------

  function decisionEvidence(response: ServerResponse, decisionId: number, artifactId: number): void {
    // The ceiling applies to decision evidence exactly as to run evidence
    // (v2 review, finding 2): a decision whose task belongs to a repo this
    // server may not serve does not exist here, and neither do its bytes.
    const decision = store.getDecision(decisionId);
    const decisionRun = decision === null ? null : store.getRun(decision.run);
    if (decisionRun !== null && !visible(taskRepoOf(decisionRun.taskRef))) {
      return respond(response, 404, "text/plain; charset=utf-8", "no such evidence");
    }
    // Only through the decision's own relation — an artifact id from another
    // run simply is not in this list, whatever the URL claims.
    const linked = store.evidenceFor(decisionId).find(one => one.id === artifactId);
    if (linked === undefined) {
      return respond(response, 404, "text/plain; charset=utf-8", "no such evidence");
    }
    return sendArtifact(response, linked);
  }

  function runEvidence(response: ServerResponse, runId: number, artifactId: number): void {
    const run = store.getRun(runId);
    if (run === null || !runVisible(run)) {
      return respond(response, 404, "text/plain; charset=utf-8", "no such run");
    }
    // Membership is the lookup's own predicate — there is no way to check
    // the run and fetch the artifact as two separate acts here.
    const linked = store.artifactForRun(runId, artifactId);
    if (linked === null) {
      return respond(response, 404, "text/plain; charset=utf-8", "no such evidence");
    }
    return sendArtifact(response, linked);
  }

  function sendArtifact(response: ServerResponse, linked: Artifact): void {
    const read = readVerifiedArtifact(evidenceRoot, linked);
    if (!read.ok) {
      return respond(response, 410, "text/plain; charset=utf-8", "the evidence no longer matches its record");
    }
    // A validated screenshot is the one evidence kind meant to render
    // inline (thumbnails, full-image links) — every other kind stays a
    // downloaded text record, exactly as before.
    if (linked.kind === "screenshot") {
      const imageType = linked.key.endsWith(".png") ? "image/png" : linked.key.endsWith(".jpg") ? "image/jpeg" : null;
      if (imageType !== null) {
        response.writeHead(200, { ...SAFETY, "Content-Type": imageType, "Cache-Control": "private, max-age=31536000, immutable" });
        response.end(read.content);
        return;
      }
    }
    response.writeHead(200, {
      ...SAFETY,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="evidence-${linked.id}.txt"`,
    });
    response.end(read.content);
  }

  /** The routine screen: the standing order restated, its verbs, its ledger. */
  function routinePage(
    response: ServerResponse,
    who: Who,
    routineId: number,
    problem: string | null,
    status: number,
  ): void {
    const routine = store.getRoutine(routineId);
    if (routine === null || !visible(routine.repo)) {
      return refuse(response, who, 404, "no such routine", "/routines");
    }
    // Same rule as scope approval: the nonce exists only where the exact
    // terms are restated, bound to who saw which digest of which order —
    // and only where a yes could bind them (v48): an order whose agents
    // are unresolved, unreadable, or never frozen gets the recovery road,
    // never a password field.
    const nonce =
      who.via === "cookie" && routineAgentsState(routine).approvable
        ? mintApprovalNonce(who.name, `routine:${routine.id}`, routine.digest)
        : "";
    const paneProject = restricted() ? routine.repo : who.via === "cookie" ? who.session.project : null;
    return sendScreen(
      response,
      status,
      routineScreenPage(chromeFor(paneProject, "routines"), {
        routine,
        fires: store.routineFires(routine.id, 14),
        spend: store.routineSpend(routine.id, new Date(clock().getTime() - 7 * 24 * 60 * 60_000).toISOString()),
        blocker: store.routineBlocker(routine.id, clock()),
        csrf: who.via === "cookie" ? who.session.csrf : "",
        nonce,
        problem,
        now: clock(),
      }),
    );
  }

  /** The full guard list (v3 §4) — run on every request, hit or miss. */
  function peekGuards(runId: number): { ok: true; admit: PeekAdmission & { entries: NonNullable<PeekAdmission["entries"]> } } | { ok: false; message: string; final?: boolean } {
    if (options.localRunner === undefined || options.poolRoot === undefined) {
      return { ok: false, message: "live peek is off — start serve with --runner <name> naming this machine's runner", final: true };
    }
    const run = store.getRun(runId);
    if (run === null || !runVisible(run)) return { ok: false, message: "no such build", final: true };
    if (run.outcome !== null) return { ok: false, message: "this build has finished — the final diff below is the record", final: true };
    // The reviewer role (v29): artifact-only, honestly — there is no
    // checkout anywhere to watch, and there never was.
    if (run.worktree === null) {
      return { ok: false, message: "this run reviewed the sealed diff — no workspace existed to watch", final: true };
    }
    if (run.baseRevision === null) return { ok: false, message: "the build has not settled its starting point yet" };
    // The run's lease must be the task's CURRENT live lease — max generation,
    // unreleased, strictly unexpired. liveClaimByLease proves only that the
    // lease exists; a superseded lease would still pass it (round-4
    // finding 15), and superseded is forever, so the poller may stop.
    if (store.currentLiveLease(run.taskRef, clock()) !== run.leaseId) {
      return { ok: false, message: "the build is not actively running right now", final: true };
    }
    const row = store.getWorktree(run.worktree);
    if (row === null || row.taskRef !== run.taskRef) return { ok: false, message: "the checkout is not where the record says" };
    if (row.runner !== options.localRunner) {
      return { ok: false, message: "this build runs on another machine — open the console there to watch it", final: true };
    }
    // Adoption-path rows can carry no epoch (round-3 finding 37): no fence,
    // no peek — never a guess.
    if (row.leaseEpoch === null || row.leaseEpoch === undefined) {
      return { ok: false, message: "this checkout was set up before live watching existed — the next fresh build can be watched", final: true };
    }
    try {
      const real = realpathSync(run.worktree);
      const pool = realpathSync(options.poolRoot);
      if (real !== run.worktree || !(real === pool || real.startsWith(`${pool}/`)) || !lstatSync(run.worktree).isDirectory()) {
        return { ok: false, message: "the checkout is not inside this machine's pool" };
      }
    } catch {
      return { ok: false, message: "the checkout could not be found on this machine" };
    }
    // The snapshot: exactly one successful, untruncated base-tree artifact
    // whose envelope binds THIS run and THIS base (round-3 finding 42).
    const artifact = store.artifactsFor(runId).find(one => one.kind === "base-tree");
    if (artifact === undefined) return { ok: false, message: "no base snapshot was captured for this build" };
    if (artifact.captureStatus !== "ok" || artifact.truncated) {
      return { ok: false, message: "the base snapshot did not capture cleanly — this build cannot be watched live" };
    }
    const read = readVerifiedArtifact(evidenceRoot, artifact);
    if (!read.ok) return { ok: false, message: "the base snapshot no longer verifies" };
    const snapshot = parseBaseTreeSnapshot(read.content.toString("utf8"));
    if (snapshot === null || snapshot.run !== runId || snapshot.base !== run.baseRevision) {
      return { ok: false, message: "the base snapshot does not match this build" };
    }
    return { ok: true, admit: { run, worktree: run.worktree, epoch: row.leaseEpoch, entries: snapshot } };
  }

  /**
   * The tournament's comparison data: the pick view plus everything the
   * page states — the task behind it, per-agent question counts, and the
   * money totals. The ceiling is proved here, on the server-resolved repo,
   * whatever the request named.
   */
  function contestData(contestId: number): {
    view: NonNullable<ReturnType<typeof buildPickView>>;
    taskId: string;
    taskTitle: string;
    repo: string | null;
    refOrigin: string;
    questions: Map<number, number>;
    liveRuns: Set<number>;
    totalMicrousd: number;
    anyUnknown: boolean;
    rollups: Map<number, { costMicrousd: number; tokensIn: number; tokensOut: number; measuredRuns: number; totalRuns: number }>;
  } | null {
    const view = buildPickView(store, evidenceRoot, contestId);
    if (view === null) return null;
    const ref = store.refForId(view.contest.taskRef);
    if (ref === null || (ref.repo !== null && !visible(ref.repo))) return null;
    const found = store.getTask(ref.externalId);
    if (found === null) return null;
    // Question counts follow run lineage: every run belonging to the agent,
    // not just its final one — a parked question is part of its story.
    const byRun = new Map<number, number>();
    for (const one of store.runsFor(view.contest.taskRef)) {
      if (one.contestant !== null) byRun.set(one.id, one.contestant);
    }
    const questions = new Map<number, number>();
    for (const decision of store.decisionsForTask(view.contest.taskRef)) {
      const owner = byRun.get(decision.run);
      if (owner !== undefined) questions.set(owner, (questions.get(owner) ?? 0) + 1);
    }
    return {
      rollups: new Map(view.agents.map(agent => [agent.contestant.id, store.contestantSpendRollup(agent.contestant.id)])),
      view,
      taskId: ref.externalId,
      taskTitle: found.title,
      repo: ref.repo,
      refOrigin: ref.origin,
      questions,
      // An interrupted tournament's agents are STOPPED, not "still
      // working" — their run records stay unfinished, so the card must
      // prove liveness the same way every other surface does (round-4
      // finding 16).
      liveRuns: liveRunIds(view.agents.flatMap(agent => (agent.run === null ? [] : [agent.run]))),
      totalMicrousd: view.agents.reduce((sum, agent) => sum + agent.contestant.accountedMicrousd, 0),
      anyUnknown: view.agents.some(agent => agent.contestant.unknownSpend),
    };
  }

  /**
   * Assemble the LIVE rendered terms of one watched attempt, or say in
   * words why there are none (Phase 2E, ruling 12). Everything here is
   * re-read at confirm time — the digest is the proof the world held.
   */
  async function liveAttendedTerms(
    taskId: string,
    inputs: { minutes: number; turns: number; budgetMicrousd: number; expiry?: string; parent?: number; followup?: string; model?: string; posture?: string },
    now: Date,
  ): Promise<{ ok: true; terms: AttendedTerms } | { ok: false; problem: string }> {
    if (options.attended === undefined) return { ok: false, problem: "this console cannot hold a session — start it with `toolroll up`" };
    const ref = store.lookupRef(taskId);
    if (ref === null) return { ok: false, problem: "no such task" };
    const scope = store.getScope(taskId);
    if (scope === null) return { ok: false, problem: "file a scope first — the terms come from it" };
    // CONTINUATION (A4): the parent attempt and the follow-up enter the
    // SIGNED terms; the head is the parent's accepted commit per outcome;
    // a moving publication blocks; failed parents are refused outright for
    // now (a dirty preserved tree cannot promise a clean continuation) —
    // stated, not hidden.
    let continuation: { parentRun: number; followup: string; head: string } | null = null;
    if (inputs.parent !== undefined) {
      const parent = store.getRun(inputs.parent);
      if (parent === null || parent.taskRef !== ref.id) return { ok: false, problem: "no such finished attempt on this task" };
      const followup = (inputs.followup ?? "").trim();
      if (followup === "" || followup.length > 2000) {
        return { ok: false, problem: "say what to do next — 1 to 2000 characters" };
      }
      if (parent.outcome !== "built" && parent.outcome !== "no-change") {
        return { ok: false, problem: "only a built or no-change attempt can be continued — for a failed one, file a follow-up task" };
      }
      const accepted = parent.outcome === "built" ? parent.headRevision : parent.baseRevision;
      if (accepted === null) return { ok: false, problem: "the attempt's accepted head was never recorded — file a follow-up task" };
      const blocked = store.continuationBlockOf(parent.id);
      if (blocked !== null) return { ok: false, problem: blocked };
      continuation = { parentRun: parent.id, followup, head: accepted };
    } else if (approvalOf(scope).approved) {
      return { ok: false, problem: "the scope is approved — it already dispatches unattended" };
    }
    let pinned = scope.profileState === "resolved" ? (scope.profile ?? null) : null;
    if (pinned === null) {
      return { ok: false, problem: "the scope cannot say exactly what runs — name a model (task scope --model, or config set build)" };
    }
    if (pinned.provider !== "claude") {
      return { ok: false, problem: `${pinned.provider} cannot hold a watched session yet — this road is claude-only for now` };
    }
    // THE MINT PICKER (P1/C7): a chosen model or posture rebuilds the
    // WHOLE ClaudeProfile — the digest signs the profile that actually
    // runs, never a partial edit. Absent choices keep the scope's pin.
    const chosenModel = (inputs.model ?? "").trim();
    const chosenPosture =
      inputs.posture === "bypassPermissions"
        ? ("bypassPermissions" as const)
        : inputs.posture === "auto"
          ? ("auto" as const)
          : inputs.posture === "acceptEdits"
            ? ("acceptEdits" as const)
            : null;
    if (chosenModel !== "" || chosenPosture !== null) {
      pinned = {
        ...pinned,
        ...(chosenModel === "" ? {} : { model: chosenModel }),
        ...(chosenPosture === null ? {} : { permissionArgv: chosenPosture }),
      };
    }
    if (store.activeTournamentTerms(ref.id) !== null) {
      return { ok: false, problem: "this task races a tournament — one attempt cannot authorize N racers" };
    }
    const repo = ref.repo;
    if (repo === null) return { ok: false, problem: "place the task in a repository first — the terms pin the exact head" };
    const head = continuation !== null ? continuation.head : await options.attended.headOf(repo);
    if (head === null) return { ok: false, problem: `the head of ${repo} cannot be read right now` };
    const minutes = Math.max(5, Math.min(240, Math.floor(inputs.minutes) || 60));
    const turns = Math.max(1, Math.min(100, Math.floor(inputs.turns) || 20));
    const budget = Math.max(100_000, Math.min(50_000_000, Math.floor(inputs.budgetMicrousd) || 2_000_000));
    return {
      ok: true,
      terms: {
        taskId,
        attentionMode: "console-visible",
        scopeDigest: scope.digest,
        profileDigest: profileDigestOf(pinned),
        profileJson: canonicalProfileJson(pinned),
        repo,
        runner: options.attended.runner,
        runnerGeneration: 0,
        head,
        maxSessionTurns: turns,
        budgetMicrousd: budget,
        turnTimeoutSeconds: pinned.timeoutSeconds,
        ...(continuation === null ? {} : { parentRun: continuation.parentRun, followup: continuation.followup }),
        // The expiry is FIXED at preview and carried through the confirm —
        // a timestamp recomputed at signing time would change the digest
        // every millisecond and make the proof unmatchable. The confirm's
        // bound check keeps a stale form honest.
        absoluteExpiry:
          inputs.expiry !== undefined &&
          Date.parse(inputs.expiry) > now.getTime() &&
          Date.parse(inputs.expiry) <= now.getTime() + 241 * 60_000
            ? inputs.expiry
            : new Date(now.getTime() + minutes * 60_000).toISOString(),
      },
    };
  }

  /** The signed form, rendered from EXACT terms — what you read is what the password signs. */
  function attendConfirmScreen(
    response: ServerResponse,
    who: Who,
    terms: AttendedTerms,
    inputs: { minutes: number; turns: number; budgetMicrousd: number; model?: string; posture?: string },
    digest: string,
    nonce: string,
    csrf: string,
  ): void {
    const scope = store.getScope(terms.taskId);
    // Quick mint (M4): the mode signature substitutes for the password —
    // the confirm screen still shows EVERY term; only the credential line
    // changes. The mint transaction re-proves the mode either way.
    const quickRef = store.lookupRef(terms.taskId);
    const quickMode = quickRef?.repo == null ? null : store.activeMode(quickRef.repo, clock());
    const quickTerms = quickMode === null ? null : modeTermsFromJson(quickMode.termsJson);
    const quick = quickTerms?.quickMint === true && quickMode !== null && quickMode.signedBy === who.name;
    const body =
      `<h1>Run ${escape(terms.taskId)} once, while you watch</h1>` +
      `<form method="post" action="${taskHref(terms.taskId)}/attend" class="card approve-form">` +
      `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
      `<input type="hidden" name="nonce" value="${escape(nonce)}">` +
      `<input type="hidden" name="digest" value="${escape(digest)}">` +
      `<input type="hidden" name="minutes" value="${inputs.minutes}">` +
      `<input type="hidden" name="turns" value="${inputs.turns}">` +
      `<input type="hidden" name="budget" value="${inputs.budgetMicrousd}">` +
      `<input type="hidden" name="expiry" value="${escape(terms.absoluteExpiry)}">` +
      (inputs.model === undefined ? "" : `<input type="hidden" name="model" value="${escape(inputs.model)}">`) +
      (inputs.posture === undefined ? "" : `<input type="hidden" name="posture" value="${escape(inputs.posture)}">`) +
      (terms.parentRun == null ? "" : `<input type="hidden" name="parent" value="${terms.parentRun}">`) +
      (terms.followup == null ? "" : `<input type="hidden" name="followup" value="${escape(terms.followup)}">`) +
      `<p><strong>Your password signs exactly this:</strong></p>` +
      `<p class="meta">Goal</p><p class="recap" style="margin-top:0">${escape(scope?.goal ?? "")}</p>` +
      `<p class="meta">Not this</p><p class="recap" style="margin-top:0">${scope?.outOfScope == null ? "<em>no exclusions</em>" : escape(scope.outOfScope)}</p>` +
      `<p class="meta">Touches · ${scope === null || scope.touches.length === 0 ? "anything" : scope.touches.map(one => escape(one)).join(", ")}</p>` +
      (() => {
        const profile = (JSON.parse(terms.profileJson) as { profile?: { model?: string; permissionArgv?: string } }).profile;
        const posture =
          profile?.permissionArgv === "bypassPermissions"
            ? "FULL permissions — claude runs with --dangerously-skip-permissions; nothing asks"
            : profile?.permissionArgv === "auto"
              ? "safe unattended permissions — routine project commands and edits proceed; risky acts stop"
              : "legacy acceptEdits — edits proceed, commands that ask are denied unattended";
        return `<p class="meta">Runs on</p><p class="recap" style="margin-top:0">claude · ${escape(String(profile?.model ?? ""))} — ${posture}</p>`;
      })() +
      (terms.parentRun == null
        ? ""
        : `<p class="meta">Continues</p><p class="recap" style="margin-top:0">attempt <a href="/r/${terms.parentRun}" class="mono">#${terms.parentRun}</a>, from exactly where it finished</p>` +
          `<p class="meta">The follow-up — this is the instruction</p><p class="recap" style="margin-top:0">${escape(terms.followup ?? "")}</p>`) +
      `<p class="meta">Repository · head</p><p class="recap mono" style="margin-top:0">${escape(terms.repo)} @ ${escape(terms.head.slice(0, 12))}</p>` +
      `<p class="meta">Worker</p><p class="recap" style="margin-top:0">${escape(terms.runner)} (this machine)</p>` +
      `<p class="meta">Spending</p><p class="recap" style="margin-top:0">up to about $${(terms.budgetMicrousd / 1_000_000).toFixed(2)} — the agent stops as soon as its total crosses this; the final step may run a little past it</p>` +
      `<p class="meta">Conversation</p><p class="recap" style="margin-top:0">at most ${terms.maxSessionTurns} messages to the agent, this whole session; each may work up to ${Math.round(terms.turnTimeoutSeconds / 60)} minutes — one that runs past that ends the whole session. If it needs a repair, the repair uses the same session, model, and clock.</p>` +
      `<p class="meta">While you watch — a signed term</p><p class="recap" style="margin-top:0">your console being open is what keeps it running — any page of it, this one included; close the console and the session winds down within a minute. Everything ends by ${whenTime(terms.absoluteExpiry)} regardless. One attempt; it never converts into unattended work.</p>` +
      (quick
        ? `<p class="meta">Your signed mode covers this mint — no password; the mode is re-proved as you confirm, and the session is stamped with its signature</p>`
        : `<label>Your password, typed again — a signed-in session alone cannot authorize work<input type="password" name="token" autocomplete="current-password"></label>`) +
      `<div class="sticky-actions"><button type="submit">Run it while I watch</button></div>` +
      `</form>` +
      `<p class="meta"><a href="${taskHref(terms.taskId)}">back to the task</a></p>`;
    // The chrome binds to the AUTHORITY repository (surfaces round 1,
    // finding 5): the banner on this screen is the mode that would cover
    // a quick mint here, never the session's open-project filter.
    return sendScreen(response, 200, screen(`attend \u00b7 ${terms.taskId}`, body, { chrome: chromeFor(terms.repo, "tasks") }));
  }

  /** The live subset of a bounded run page \u2014 one indexed lookup per row. */
  function liveRunIds(rows: readonly (Pick<Run, "id" | "outcome" | "leaseId" | "taskRef">)[]): Set<number> {
    const live = new Set<number>();
    for (const run of rows) if (runIsLive(run)) live.add(run.id);
    return live;
  }
  const registrations: Registration[] = [
    { id: "code.page", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "inbox", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "work", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "next", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "board", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "review", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "done", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "tasks", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "queue", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "tasks.new", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "task.live", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "task.page", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "task.evidence", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "runs", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "run.page", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "run.evidence", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "contest.page", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "routines", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "routine.page", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "decision.page", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "decision.evidence", domain: "tasks", stage: "console", method: "GET", handle: get },
    { id: "session.attended-beats", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "code.act", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "tasks.add", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "queue.move", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "queue.note", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "decision.answer", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "contest.act.arm", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "contest.act.pick", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "contest.act.abandon", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.attend.attend-preview", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.attend.attend", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.attend.attend-revoke", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.hold", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.unhold", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.requeue", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.cancel", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.scope", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.approve", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.plan", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.plan-edit", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.next", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.reopen", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.steer", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.accept-proof", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.accept-revision", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.reject-revision", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.route", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.retry-review", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.complete", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.merge", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.confirm-stopped", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.stop", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.resume-arm", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.act.resume", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "task.instance-act", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "routines.add", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "routine.act.approve", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "routine.act.refresh", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "routine.act.pause", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "routine.act.resume", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "routine.act.run-now", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "run.act", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "session.editor-links", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "run.turn", domain: "tasks", stage: "console", method: "POST", handle: post },
    { id: "incident.resolve", domain: "tasks", stage: "console", method: "POST", handle: post },
  ];
  return { registrations, get, post, runListPane, peekFragment, contestScreen, routineMutation, attendedBeats, attendMutation, taskMutation, queueRegionFor, ciFailingFor, completedRowFor, attemptRowFor, resultRowOf, reviewCockpitViewOf, decisionEvidence, runEvidence, sendArtifact, routinePage, peekGuards, contestData, liveAttendedTerms, attendConfirmScreen, liveRunIds };
}
