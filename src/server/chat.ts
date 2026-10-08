import type { Registration } from './handler-registry.js';
/** chat handlers, moved without changing their route bodies. */
import { randomBytes } from "node:crypto";
import { chmodSync,rmSync as rmFileSync,writeFileSync as writeFsFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { assignmentCatchUp } from '../assignment-brief.js';
import { assignmentOf,checkAssignmentAsOperator } from '../assignment.js';
import { browserWorkActionHref,type BrowserCatchUpItem,type BrowserFirstRun,type BrowserHome,type BrowserHomeCount,type BrowserPhoneCard } from '../browser-workspace.js';
import { CHAT_ACTIONS,mintSharedActionReview,sharedActionPayload,sharedActionReviewPath } from '../chat-actions.js';
import { CONSOLE_FORMS,readForm } from "../contracts/console-api.js";
import { hiddenFields } from "../control-ui.js";
import {
buildDataDocument,
composeRequest,
isSubscriptionChatProvider,
parseAssistantEnvelope,
performChatRequest,
plausibleChatKey,
priceOf,
settleForPrice,
TURN_WALL_CLOCK_MS,
worstCaseForPrice
} from "../converse.js";
import { DEMO_CHAT_SCRIPT,demoChatHtml,demoThreadHtml,type DemoResultView } from "../demo-chat.js";
import type { DemoExchange } from "../demo.js";
import { withDispatchDiagnoses } from "../dispatch.js";
import { readVerifiedArtifact,scanForSecrets } from "../evidence.js";
import { run as execRun } from "../exec.js";
import { findFirstTasks,firstTaskSuggestions,HOW_IT_WORKS,SANDBOX_COMMAND,type FirstTaskSuggestion } from "../first-run.js";
import { leadBriefHtml } from '../lead-context.js';
import { configureLeadFollow,leadFollowStatus } from '../lead-follow.js';
import { leadActivity } from "../lead-voice.js";
import { limitsView } from "../limits-ui.js";
import { confirmCoordinatorProposal,confirmMateProposal,dismissCoordinatorProposal,dismissMateProposal } from "../mate-doors.js";
import type { MateProgress } from "../mate-progress.js";
import { MATE_MESSAGE_MAX_CHARS,runMateTurn } from "../mate.js";
import { livePin,modelOptions } from "../model-catalog.js";
import { verifyApproverByPassword,verifyApproverStanding,type VerifiedApprover } from "../principal.js";
import {
projectName
} from "../project.js";
import { fileTaskProposal } from "../proposal.js";
import { providerName } from "../provider-auth.js";
import { validModelId } from "../provider.js";
import { loadOrCreateVapidKeys,validatePushEndpoint } from "../push.js";
import {
parseResultTab,
RESULT_REVIEW_SCRIPT
} from "../result-review.js";
import type { DirectChatProviderId } from "../store.js";
import {
type Store
} from "../store.js";
import { runActivityOf } from "../task-activity.js";
import { teamWorkspaceHtml } from '../team-ui.js';
import { loadBotToken,redactToken } from "../telegram.js";
import { WORK_INDEX_MAX_LIMIT,workIndexPage,type WorkIndexItem } from "../work-index.js";
import type { HandlerContext } from './handler-context.js';
import type { ServerRuntime } from './runtime.js';
import { chatAckPage,chatPage,chatResultHref,chatReturnWithLatest,chatReturnWithSaid,completionForm,coordinatorProposalsSection,decisionsFor,escape,homePhaseWords,mateAfterComposerHtml,mateChatVersion,mateMintCard,matePage,mateThreadHtml,oneLineUa,owedAcceptanceOf,PHONE_CARD_FACT,projectChatHref,redirect,refuse,requestContext,respond,resultPanelHtml,safeChatReturn,safeReturn,screen,TASK_COMPOSER_MODES,taskChatHref,taskChatLiveRegion,taskHref,teamProposalCardParts,type AssignmentChatSnapshot,type ChatCandidate,type ChatEnablement,type LiveTurn,type ProjectPeek,type Screen,type Session,type TaskComposerMode,type Who } from "./shared.js";
export function createChatHandlers(runtime: ServerRuntime) {
  const { firstRunStepsNow, managedRepos, leadWords, store, options, phoneSetup, visible, liveTurns, mateSaid, evidenceRoot, clock, sessions, CHAT_CANDIDATE_TTL_MS, chatFetcher, CHAT_CANDIDATES_PER_APPROVER, chatCeilingDigest, workAccess, familyOf, firstTasks, matePrincipal, taskChatFocus, chatScopeOf, chatStreams, mateConversationRows, demoLeadHere, sendScreen, chromeFor, teamBrowserReply, team, teamChatProvider, runVisible, runIsLive, resultDetailOf, pullRequestTargetOf, chatEnablement, startMateConversation, projectFamilyPeek, needsYouBadge, liveRefreshSeconds, chatKeyFor, chatCatalog, providerHome, mintApprovalNonce, checkLocalAgents, agentSignInCommand, bustBadge, authenticateApprover, revisionDestination, armTaskResume, consumeApprovalNonce } = runtime;

  async function get(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, now, project, chosenProject, posted, route } = ctx;


    if (url.pathname === "/chat/stream") {
      // The live reply (chat streaming): server-sent snapshots of the turn
      // answering in this person's thread for the same task or project the
      // send names. A refresh hint and a preview only — the finished
      // message is read the usual way. No turn running: one closing event.
      if (who.via !== "cookie" || who.role !== "approver") return respond(response, 403, "application/json", JSON.stringify({ error: "session" }));
      const principal = matePrincipal(who);
      if (principal === null) return respond(response, 403, "application/json", JSON.stringify({ error: "standing" }));
      const requestedTask = url.searchParams.get("task");
      const focusTask = requestedTask === null || requestedTask === "" ? null : taskChatFocus(requestedTask, now, who, { mintNonce: false });
      if (requestedTask !== null && requestedTask !== "" && focusTask === null) return respond(response, 404, "application/json", JSON.stringify({ error: "task" }));
      const chatProject = focusTask !== null ? null : chatProjectOf(url.searchParams.getAll("project").filter(one => one !== ""));
      if (chatProject === undefined) return respond(response, 404, "application/json", JSON.stringify({ error: "project" }));
      const thread = store.liveMateThreadFor(who.name, chatScopeOf(focusTask, chatProject));
      const live = thread === null ? undefined : liveTurns.get(thread.id);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no" });
      const snapshot = (): string => `event: turn\ndata: ${JSON.stringify({ steps: live?.steps ?? [], done: live === undefined || live.done, ok: live?.ok ?? false })}\n\n`;
      if (live === undefined || live.done) { response.end(snapshot()); return; }
      chatStreams.add(response);
      let queued: NodeJS.Timeout | null = null;
      const heartbeat = setInterval(() => { response.write(": keep-alive\n\n"); }, 15_000);
      heartbeat.unref();
      const close = (): void => {
        clearInterval(heartbeat);
        if (queued !== null) clearTimeout(queued);
        live.listeners.delete(listener);
        chatStreams.delete(response);
        if (!response.writableEnded) response.end();
      };
      // At most one snapshot every 80 ms; the last one always goes out.
      const flush = (): void => {
        queued = null;
        if (response.writableEnded) return;
        response.write(snapshot());
        if (live.done) close();
      };
      const listener = (): void => {
        if (live.done) { if (queued !== null) clearTimeout(queued); flush(); return; }
        if (queued === null) queued = setTimeout(flush, 80);
      };
      live.listeners.add(listener);
      response.write(snapshot());
      request.once("close", close);
      response.once("close", close);
      return;
    }

    if (url.pathname === "/chat/mate/status") {
      // The read-only refresh (package 2): the same JSON status as before —
      // session binding, the send receipt, the live turn — plus a version
      // of the DISPLAYED facts and, only when the caller's version differs,
      // the server-rendered thread / task fragments the page swaps into
      // its safe regions. No-store, cookie-and-approver only, the same
      // admission and ceiling checks as the page; nothing here writes.
      if (who.via !== "cookie" || who.role !== "approver") return respond(response, 403, "application/json", JSON.stringify({ error: "session" }));
      const session = store.activeMateSession(who.name);
      const principal = matePrincipal(who);
      if (session === null || principal === null || session.ceilingDigest !== principal.ceilingDigest || session.approverGeneration !== principal.generation) {
        return respond(response, 200, "application/json", JSON.stringify({ session: null }));
      }
      store.sweepStaleMateTurns(now);
      const request = url.searchParams.get("request") ?? "";
      const receipt = /^[a-f0-9]{32}$/.test(request) ? store.mateRequestReceipt(session.id, request) : null;
      const requestedTask = url.searchParams.get("task");
      const focusTask = requestedTask === null || requestedTask === "" ? null : taskChatFocus(requestedTask, now, who, { mintNonce: false });
      if (requestedTask !== null && requestedTask !== "" && focusTask === null) {
        // The lens's task is gone or no longer admitted: the page keeps its
        // draft and says so; it never falls back to the unified thread.
        return respond(response, 200, "application/json", JSON.stringify({ session: session.id, task: requestedTask, unavailable: true, received: receipt !== null }));
      }
      const chatProject = focusTask !== null ? null : chatProjectOf(url.searchParams.getAll("project").filter(one => one !== ""));
      if (chatProject === undefined) return respond(response, 200, "application/json", JSON.stringify({ session: session.id, unavailable: true, received: receipt !== null }));
      const rows = mateConversationRows(who, principal, focusTask, now, chatProject);
      const version = mateChatVersion({ ...rows, focusTask });
      const known = url.searchParams.get("version") ?? "";
      const csrf = who.session.csrf;
      const fragments = known === version
        ? null
        : {
            thread: mateThreadHtml({ ...rows, focusTask, csrf, now, problem: takeMateNote(csrf, session.id), chatProject }),
            after: mateAfterComposerHtml({ messages: rows.messages, pending: rows.pending, focusTask, csrf }),
            live: focusTask === null ? null : taskChatLiveRegion(focusTask, csrf, true, rows.pending !== null),
          };
      return respond(response, 200, "application/json", JSON.stringify({
        session: session.id,
        task: focusTask?.id ?? "",
        version,
        pending: rows.pending !== null,
        received: receipt !== null,
        approval: focusTask?.approval?.digest ?? "",
        ...(fragments === null ? {} : { fragments }),
      }));
    }

    // `toolroll demo`: Chat is the scripted lead, never a model.
    if (url.pathname === "/chat/demo/live") {
      const lead = demoLeadHere();
      if (lead === null || who.via !== "cookie") return respond(response, 404, "application/json", JSON.stringify({ ok: false }));
      const exchanges = lead.exchanges();
      return respond(response, 200, "application/json", JSON.stringify({
        version: lead.version(), working: exchanges.some(one => one.state === "working"),
        html: demoThreadHtml(exchanges, who.session.csrf, demoResultView),
      }));
    }
    if (url.pathname === "/chat" && demoLeadHere() !== null && who.via === "cookie" &&
      !["task", "result", "project", "conversation", "team", "proposal"].some(name => url.searchParams.has(name))) {
      const lead = demoLeadHere()!;
      const said = url.searchParams.get("said")?.slice(0, 300) ?? null;
      return sendScreen(response, 200, screen("Chat", demoChatHtml({ exchanges: lead.exchanges(), csrf: who.session.csrf, version: lead.version(), problem: said, resultOf: demoResultView }), {
        chrome: chromeFor(null, "chat", undefined, "all"),
        functional: { script: DEMO_CHAT_SCRIPT, fetches: true },
      }));
    }
    if (url.pathname === "/chat") {
      // Cookie sessions only (Codex v3 review, change 7): drafts live in
      // THIS session's memory; a bearer caller has nowhere to keep them.
      if (who.via !== "cookie") return refuse(response, who, 403, "chat is a browser surface — it keeps your drafts in the session");
      if (url.searchParams.get('private') !== '1' && !url.searchParams.has('task') && !url.searchParams.has('result') && !url.searchParams.has('project')) {
        const reply = teamBrowserReply(await team.execute({ name: who.name, generation: who.session.generation }, {
          operation: url.searchParams.has('conversation') ? 'show' : 'list',
          args: { ...(url.searchParams.has('conversation') ? { conversationId: url.searchParams.get('conversation') } : {}),
            ...(url.searchParams.has('lead') ? { leadId: url.searchParams.get('lead') } : {}) },
        }), { name: who.name, generation: who.session.generation }, who.session.csrf);
        if (!reply.ok || !reply.snapshot) return refuse(response, who, 403, reply.message, '/chat?private=1');
        if (url.searchParams.has('proposal')) {
          const id = Number(url.searchParams.get('proposal')), selected = reply.snapshot.selected;
          const proposal = Number.isSafeInteger(id) && id > 0 ? store.getMateProposal(id) : null;
          if (!selected || !proposal || proposal.thread !== selected.threadId) return refuse(response, who, 404, 'This proposal is unavailable.', '/chat');
          const back = '/chat?conversation=' + encodeURIComponent(selected.id);
          const decision = proposal.kind === 'answer' && typeof proposal.payload['decision'] === 'number' ? store.getDecision(proposal.payload['decision']) : null;
          const card = teamProposalCardParts(store, { name: who.name, generation: who.session.generation }, proposal, reply.snapshot, who.session.csrf, decision, clock(), teamChatProvider).html;
          return sendScreen(response, 200, screen('Review action', `<p><a href="${escape(back)}">Back to conversation</a></p>` + card, { chrome: chromeFor(null, 'chat', undefined, 'all') }));
        }
        if (reply.snapshot.leads.length > 0 || url.searchParams.has('conversation') || url.searchParams.get('team') === '1') {
          const said = url.searchParams.get('said')?.slice(0, 1_000);
          return sendScreen(response, 200, screen('Chat', (said ? `<p role="alert">${escape(said)}</p>` : '') + teamWorkspaceHtml(reply.snapshot), {
            chrome: chromeFor(null, 'chat', undefined, 'all'), workspace: { team: reply.snapshot, ...(said ? { notices: [said] } : {}) },
          }));
        }
      }
      store.sweepStaleChatTurns(now);
      store.sweepStaleMateTurns(now);
      store.sweepCoordinatorProposals(now);
      sweepChatDrafts(Date.now());
      const requestedTask = url.searchParams.get("task");
      const focusTask = taskChatFocus(requestedTask, now, who, { mintNonce: !requestContext.getStore()?.workspaceRead });
      // A project's own thread (v77): /chat?project=<path>. A task lens wins.
      const chatProject = focusTask !== null ? null : chatProjectOf(url.searchParams.getAll("project"));
      if (chatProject === undefined) return refuse(response, who, 404, "That project is not available in this workspace.", "/chat");
      if (focusTask !== null && requestedTask !== focusTask.id) {
        url.searchParams.set("task", focusTask.id);
        return redirect(response, `/chat?${url.searchParams.toString()}`);
      }
      // A seal receipt names the exact child it returned. Reopening an old
      // receipt must not present a newer revision's approval as its answer.
      const requestedRevision = url.searchParams.get("revision");
      if (requestedRevision !== null) {
        if (focusTask === null || !focusTask.family.versions.some(one => one.id === requestedRevision) || url.searchParams.has("result")) {
          return refuse(response, who, 404, "That revision is not available for this task.", "/work");
        }
        if (requestedRevision !== focusTask.executionId) return redirect(response, `${taskHref(focusTask.id)}?version=${encodeURIComponent(requestedRevision)}`);
      }
      // The result detail (package 3): `?result=<run>` names one finished
      // build OF THIS TASK; anything else — another task's run, a live or
      // failed attempt, a number that is no run — says so and shows the
      // conversation alone. The task lens is never inferred from the run.
      const requestedResult = url.searchParams.get("result");
      const resultRun = (() => {
        if (focusTask === null || requestedResult === null || !/^[0-9]{1,15}$/.test(requestedResult)) return null;
        const found = store.getRun(Number(requestedResult));
        if (found === null || !runVisible(found) || !focusTask.family.versions.some(one => one.refId === found.taskRef)) return null;
        if (runIsLive(found) || (found.outcome !== "built" && found.outcome !== "no-change")) return null;
        return found;
      })();
      const roomId = url.searchParams.get('conversation');
      const resultLink = (href: string) => roomId ? href + '&conversation=' + encodeURIComponent(roomId) : href;
      // Accept and finish is here: the one act that accepts the person's own checks and finishes the task.
      const finishes = resultRun !== null && who.role === 'approver' && focusTask?.assignment?.state === 'ready-to-check' && focusTask.assignment.receipt?.runId === resultRun.id;
      const resultPanel =
        resultRun === null
          ? null
          : resultPanelHtml(resultDetailOf(resultRun, who, now), {
              place: "chat",
              tab: parseResultTab(url.searchParams.get("tab")),
              csrf: who.session.csrf,
              user: who.name,
              noted: url.searchParams.get("noted") !== null,
              requestToken: randomBytes(16).toString("hex"),
              hrefFor: one => resultLink(chatResultHref(focusTask?.id ?? "", resultRun.id, one)),
              returnTo: resultLink(chatResultHref(focusTask?.id ?? "", resultRun.id)),
              back: { href: roomId ? "/chat?conversation=" + encodeURIComponent(roomId) : taskChatHref(focusTask?.id ?? ""), label: "Back to chat" },
              finishes,
            }) + (finishes && focusTask?.assignment?.receipt != null
              ? completionForm(focusTask.assignment.receipt.taskId, resultRun.id, focusTask.assignment.receipt.digest, who.session.csrf, pullRequestTargetOf(resultRun.id), owedAcceptanceOf(focusTask.assignment.receipt)) : '');
      const focusProblem = requestedTask !== null && focusTask === null
        ? "That task is not available in this workspace."
        : requestedResult !== null && focusTask !== null && resultRun === null
          ? "That result is not available for this task. The conversation is shown without it."
          : null;
      if (roomId) {
        const shared = await team.execute({ name: who.name, generation: who.session.generation }, { operation: 'show', args: { conversationId: roomId } });
        if (!shared.ok || !shared.snapshot?.selected) return refuse(response, who, 404, shared.message, '/chat');
        if (focusTask && !shared.snapshot.selected.projects.includes(store.lookupRef(focusTask.executionId)?.repo ?? '')) return refuse(response, who, 404, 'This task is outside the conversation’s projects.', '/chat?conversation=' + encodeURIComponent(roomId));
        return sendScreen(response, 200, screen('Chat', teamWorkspaceHtml(shared.snapshot) + (resultPanel ?? ''), {
          chrome: chromeFor(null, 'chat', undefined, 'all'), functional: { script: RESULT_REVIEW_SCRIPT, fetches: true },
          workspace: { team: shared.snapshot,
            focus: focusTask ? { id: focusTask.id, title: focusTask.title, html: taskChatLiveRegion(focusTask, who.session.csrf, true, false, taskHref(focusTask.executionId) + "#approve") } : null,
            result: resultPanel && resultRun ? { runId: resultRun.id, html: resultPanel } : null,
            notices: focusProblem ? [focusProblem] : [],
          },
        }));
      }
      // Pending cards, and the recently answered ones so the door's words are read (last 30).
      const repos = managedRepos();
      const allCoordinatorRows = who.role === "approver" ? store.listCoordinatorProposals({ repos, states: ["pending", "confirmed", "refused"], limit: 30 }) : [];
      const coordinatorRows = focusTask === null
        ? allCoordinatorRows
        : allCoordinatorRows.filter(one => focusTask.family.versions.some(version => version.id === one.payload["task"]));
      const enabled = chatEnablement();
      const pending = store.liveChatTurnFor(who.name);
      const latched = enabled.ok ? store.latchedChatTurns(enabled.credentialKey) : [];
      // The mate (mate arc §5): while a mate session is live, /chat IS the
      // thread — the same rows the CLI reads. Without one, fleet chat as
      // before, plus the card that mints a session.
      let mateSession = enabled.ok && who.role === "approver" ? store.activeMateSession(who.name) : null;
      const principal = enabled.ok && who.role === "approver" ? matePrincipal(who) : null;
      // Chat opens ready to talk (2026-09-23): an approver in good standing
      // needs no second password to start their own conversation. The one
      // exception to "a GET writes nothing": the strict same-site session
      // cookie keeps other sites out, and starting spends nothing. Actions
      // the lead proposes still go through their own confirmation cards.
      // Membership chat only: it spends no dollars. Direct-API chat keeps a
      // one-tap Start with its visible spending limit (no password).
      const settingsView = url.searchParams.get("settings") === "1";
      if (!settingsView && enabled.ok && enabled.billing === "subscription" && principal !== null && (mateSession === null || mateSession.ceilingDigest !== principal.ceilingDigest) && !requestContext.getStore()?.workspaceRead) {
        startMateConversation(who, principal, enabled, 0, false, now);
        mateSession = store.activeMateSession(who.name);
      }
      // A session under another ceiling is not continuable from here; a GET
      // writes nothing (slice-2 review, finding 7) — the mint card below
      // starts a new conversation, and minting ends the old session.
      const ceilingStale = enabled.ok && mateSession !== null && principal !== null && mateSession.ceilingDigest !== principal.ceilingDigest;
      const catchUp = leadBriefHtml(assignmentCatchUp(store, now, { principal: "operator", repos }, { limit: 6 }, evidenceRoot));
      const chatProjects = repos.map((repo, index) => {
        let peek: ProjectPeek | null = null;
        try {
          peek = projectFamilyPeek(repo, now);
        } catch {
          // The project rail is orientation, like chrome's project peek: a
          // failed count must not make the conversation itself disappear.
        }
        return { id: `r${index + 1}`, label: projectName(repo), path: repo, peek };
      });
      let fleetSnapshot: AssignmentChatSnapshot | null = null;
      if (repos.length > 0) {
        try {
          fleetSnapshot = store.chatSnapshot(repos, now);
          const summaries = workIndexPage(store, now, { principal: 'operator', repos, includeUnplaced: false, viewer: who.name }, { limit: 100 }).items;
          fleetSnapshot.assignmentStates = Object.fromEntries(summaries.flatMap(value =>
            [value.rootId, value.activeTaskId].map(id => [id, { state: value.assignmentState, label: value.status.label, detail: value.status.detail }])));
          fleetSnapshot.attentionCount = needsYouBadge(null);
        } catch {
          // The project rail already degrades each pulse independently.
          // A failed briefing query must not make the conversation vanish.
        }
      }
      // The first run belongs to the lead conversation, for someone who can act on it.
      const firstRun = focusTask === null && who.role === "approver" ? chatFirstRun(now, chatProject) : undefined;
      const phone = focusTask === null && who.via === "cookie" ? phoneCard(who, now) : undefined;
      // Console v2: the landing's live view (who is working, four counts, Catch up in tabs).
      const home = focusTask === null && chatProject === null && !roomId ? chatHomeOf(who, repos, now) : null;
      const withFirstRun = (shown: Screen): Screen => firstRun === undefined && phone === undefined && home === null ? shown
        : { ...shown, ...(home === null ? {} : { refreshSeconds: liveRefreshSeconds() }),
          workspace: { ...shown.workspace, ...(firstRun === undefined ? {} : { firstRun }), ...(phone === undefined ? {} : { phone }), ...(home === null ? {} : { home }) } };
      if (enabled.ok && mateSession !== null && principal !== null && !ceilingStale) {
        {
          const said = takeMateNote(who.session.csrf, mateSession.id);
          return sendScreen(
            response,
            200,
            withFirstRun(matePage(chromeFor(null, "chat", undefined, "all"), {
              session: mateSession,
              ...mateConversationRows(who, principal, focusTask, now, chatProject),
              chatProject,
              latched,
              config: enabled.config,
              turnsToday: store.chatTurnsToday(who.name, now),
              weeklySpent: store.chatWeeklySpendMicrousd(enabled.credentialKey, now),
              projects: chatProjects,
              fleetSnapshot,
              catchUp,
              follow: leadFollowStatus(store, who.name),
              focusTask,
              csrf: who.session.csrf,
              problem: url.searchParams.get("said") ?? focusProblem ?? said,
              now,
              resultPanel,
              resultRunId: resultRun?.id ?? null,
            })),
          );
        }
      }
      return sendScreen(
        response,
        200,
        withFirstRun(chatPage(chromeFor(null, "chat", undefined, "all"), {
          settingsOpen: settingsView,
          firstRunShown: firstRun !== undefined,
          enabled,
          pending,
          latched,
          chat: who.session.chat ?? null,
          recent: store.recentChatTurns(who.name, 10),
          turnsToday: store.chatTurnsToday(who.name, now),
          weeklySpent: enabled.ok ? store.chatWeeklySpendMicrousd(enabled.credentialKey, now) : 0,
          projects: chatProjects,
          fleetSnapshot,
          catchUp,
          focusTask,
          canManage: who.role === "approver",
          config: store.getChatConfig(),
          keyFacts: (["anthropic-api", "openrouter-api"] as const).map(one => {
            const found = chatKeyFor(one);
            return {
              provider: one,
              state: found === null ? "none" : found.source,
              tail: found === null || found.source === "environment" ? null : redactToken(found.key),
            };
          }),
          openrouterModels: (await chatCatalog())?.map(one => one.id) ?? null,
          liveModels: [...modelOptions(store, "claude", now, providerHome), ...modelOptions(store, "codex", now, providerHome)],
          csrf: who.session.csrf,
          problem:
            url.searchParams.get("said") ??
            focusProblem ??
            (ceilingStale ? "Project access changed. Your tasks and results are saved. Start a conversation with the current projects to continue." : null) ??
            takeMateNote(who.session.csrf, null),
          resultPanel,
          ...(enabled.ok && who.role === "approver" ? { mateMint: mateMintCard(who.session.csrf, enabled, focusTask === null ? "/chat" : taskChatHref(focusTask.id)) } : {}),
          ...(who.role === "approver" ? { coordinatorProposals: coordinatorProposalsSection(coordinatorRows, decisionsFor(store, coordinatorRows), who.session.csrf, now, true, focusTask === null ? null : taskChatHref(focusTask.id)) } : {}),
        })),
      );
    }

    const chatAck = /^\/chat\/ack\/([0-9]{1,15})$/.exec(url.pathname);
    if (chatAck !== null) {
      if (who.via !== "cookie") return refuse(response, who, 403, "acknowledgement is a browser ceremony");
      const turn = store.getChatTurn(Number(chatAck[1]));
      if (turn === null || !turn.unknownSpend || turn.acknowledgedAt !== null) {
        return refuse(response, who, 404, "no acknowledgement is waiting there", "/chat");
      }
      // The one nonce in chat — this screen restates exact financial terms
      // and re-enables spend, which is precisely what nonces are for.
      const nonce = mintApprovalNonce(who.name, `chat-ack-${turn.id}`, String(turn.reservedMicrousd));
      return sendScreen(response, 200, chatAckPage(chromeFor(project, "chat"), turn, nonce, who.session.csrf));
    }

    const sharedReview = /^\/chat\/action\/([0-9]{1,15})$/.exec(url.pathname);
    if (sharedReview !== null) {
      if(who.via!=='cookie'||who.role!=='approver')return refuse(response,who,403,'Sign in to review this action.','/projects');
      const reviewProposal = store.getMateProposal(Number(sharedReview[1]));
      const sharedConversation = reviewProposal ? store.handle.prepare('SELECT id FROM team_conversation WHERE thread=?').get(reviewProposal.thread) : null;
      let principal: VerifiedApprover | null = null;
      if (sharedConversation) {
        try {
          const access = team.domain.access({ name: who.name, generation: who.session.generation }, String(sharedConversation['id']), 'contributor');
          const checked = verifyApproverStanding(store, who.name, who.session.generation, access.conversation.projects);
          principal = checked.ok ? checked.who : null;
        } catch { return refuse(response, who, 404, 'This proposal is unavailable.', '/chat'); }
      } else principal = matePrincipal(who);
      if(principal===null)return refuse(response,who,403,'Your access changed. Sign in again.','/chat');
      try {
        const id=Number(sharedReview[1]),saved=store.getMateProposal(id),savedAction=saved?.kind==='action'?sharedActionPayload(saved.payload):null;
        if(saved&&savedAction&&saved.state!=='pending'&&(sharedConversation!==null||store.getMateThread(saved.thread)?.approver===principal.name)&&principal.repos.includes(savedAction.repo)&&store.accountCanAccess(principal.name,savedAction.repo)) {
          const task = typeof saved.outcome?.['taskId']==='string' ? saved.outcome['taskId'] : typeof savedAction.request['task']==='string' ? savedAction.request['task'] : null;
          const destination = task ? taskHref(task) : `/settings/${savedAction.operation.startsWith('skill_')?'skills':'knowledge'}?repo=${encodeURIComponent(savedAction.repo)}`;
          const said = typeof saved.outcome?.['said']==='string' ? saved.outcome['said'] : saved.state==='dismissed'?'Action dismissed.':saved.state==='expired'?'This proposal expired. Ask for a fresh proposal.':'This action has no completed outcome yet.';
          return sendScreen(response,200,screen('Action outcome',`<h1>${escape(savedAction.title)}</h1><p>${escape(said)}</p><a class="button-link" href="${escape(destination)}">${task?'Open task':'Open project settings'}</a>`,{chrome:chromeFor(savedAction.repo,'chat')}));
        }
        const review=mintSharedActionReview(store,principal,id,evidenceRoot,clock()),action=review.payload;
        const terms=action.terms.map(term=>`<p style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(term)}</p>`).join('');
        const evidenceLink=action.operation==='result_accept'?`<a href="/r/${Number(action.request['run'])}">Inspect this result</a>`:'';
        const content=`<section class="shared-action"><h1>${escape(action.title)}</h1>${evidenceLink}${terms}<form method="post" action="/chat/proposal/${id}/confirm">${hiddenFields({csrf:who.session.csrf,nonce:review.nonce,return:'/chat'})}<label class="arm"><input type="checkbox" name="confirm" value="yes" required>I confirm this exact action</label>${CHAT_ACTIONS[action.operation].password?'<label>Your password<input type="password" name="token" autocomplete="current-password" required></label>':''}<button>${escape(CHAT_ACTIONS[action.operation].label)}</button></form></section>`;
        return sendScreen(response,200,screen('Review action',content,{chrome:chromeFor(action.repo,'chat')}));
      }catch(error){return refuse(response,who,409,error instanceof Error?error.message:'This action could not be reviewed.','/chat');}
    }

    if (url.pathname === "/push/key") {
      // Session-gated: the key is not secret, but strangers get nothing.
      if (who.via !== "cookie") return respond(response, 403, "application/json", JSON.stringify({ error: "session" }));
      const keys = loadOrCreateVapidKeys(dirname(options.telegramTokenFile ?? "."));
      response.setHeader("cache-control", "no-store");
      return respond(response, 200, "application/json", JSON.stringify({ key: keys.publicKey }));
    }

    // While no agent is signed in, Chat asks this computer again on its own (onboarding): a fresh, non-spending sign-in
    // check at most every few seconds, and the lead turns on as soon as one is found.
    if (url.pathname === "/lead/status") {
      if (who.via !== "cookie") return respond(response, 403, "application/json", JSON.stringify({ error: "sign in" }));
      if (Date.now() - runtime.leadRecheckedAt > 4_000) {
        runtime.leadRecheckedAt = Date.now();
        await Promise.race([checkLocalAgents(true), new Promise(done => setTimeout(done, 8_000).unref?.())]);
      }
      response.setHeader("cache-control", "no-store");
      return respond(response, 200, "application/json", JSON.stringify({ lead: store.getChatConfig() === null ? "off" : "on", agent: runtime.localSignIn?.signedIn ?? null, command: agentSignInCommand() }));
    }
    if (url.pathname === "/chat/task-status") {
      if (who.via !== "cookie") return respond(response, 403, "text/plain; charset=utf-8", "sign in to see this task");
      const focus = taskChatFocus(url.searchParams.get("task"), now, who, { mintNonce: false });
      if (focus === null) return respond(response, 404, "text/plain; charset=utf-8", "this task is not available in this workspace");
      response.setHeader("cache-control", "no-store");
      return respond(response, 200, "text/html; charset=utf-8", taskChatLiveRegion(focus, who.session.csrf, true));
    }
    return refuse(response, who!, 404, "There's no page at this address.", "/chat");
  }

  async function post(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, now, project, chosenProject, posted, route } = ctx;

    // The scripted demo lead's acts: ask, approve, change a plan, complete or send back a result.
    const demoAct = /^\/chat\/demo\/(?:ask|([0-9]{1,9})\/(approve|change|revise|complete))$/.exec(url.pathname);
    if (demoAct !== null) {
      const body = readForm(posted, CONSOLE_FORMS.demo);
      const lead = demoLeadHere();
      if (lead === null || who.via !== "cookie") return refuse(response, who, 404, "There's no page at this address.", "/chat");
      if (who.role !== "approver") return redirect(response, `/chat?said=${encodeURIComponent("Your login can watch. Approving and completing is an approver's act.")}`);
      const now = clock();
      if (demoAct[1] === undefined) {
        const message = (body.get("message") ?? "").trim();
        if (message === "") return redirect(response, `/chat?said=${encodeURIComponent("Type a request first.")}`);
        const asked = lead.ask(message, now);
        return redirect(response, `/chat#demo-${asked.id}`);
      }
      const id = Number(demoAct[1]);
      const note = body.get("note") ?? "";
      const done = demoAct[2] === "approve" ? lead.approve(id, now)
        : demoAct[2] === "change" ? lead.change(id, note, now)
        : demoAct[2] === "revise" ? lead.requestChanges(id, note, now)
        : lead.complete(id, now, (taskId, runId) => {
          const principal = matePrincipal(who);
          if (principal === null) return { ok: false, message: "Your access changed. Sign in again." };
          const current = assignmentOf(store, taskId, now, { principal: "operator", repos: principal.repos }, evidenceRoot);
          if (current?.receipt?.runId !== runId) return { ok: false, message: "This result changed. Reload before marking it complete." };
          const completed = checkAssignmentAsOperator(store, taskId, current.receipt.digest, principal, now, evidenceRoot);
          return completed.ok ? { ok: true } : { ok: false, message: completed.message };
        });
      bustBadge();
      if (!done.ok) return redirect(response, `/chat?said=${encodeURIComponent(done.message)}`);
      const latest = lead.exchanges().at(-1);
      return redirect(response, demoAct[2] === "change" || demoAct[2] === "revise" ? `/chat#demo-${latest?.id ?? id}` : `/chat#demo-${id}-work`);
    }

    if (url.pathname === "/push/subscribe") {
      const body = readForm(posted, CONSOLE_FORMS.pushSubscribe);
      // Enrolling a durable notification sink is a CEREMONY (arc 3 finding
      // 6): browser session + CSRF + the password typed again; bearer
      // identities are machines and are refused outright.
      if (who.via !== "cookie") return refuse(response, who, 403, "push enrollment is a browser session's act");
      if (store.isDemo()) return refuse(response, who, 403, "the sandbox never pushes");
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(who, password).ok) {
        return redirect(response, `/settings?said=${encodeURIComponent("enrolling this device takes your password, typed again")}`);
      }
      const endpoint = body.get("endpoint") ?? "";
      const p256dh = body.get("p256dh") ?? "";
      const auth = body.get("auth") ?? "";
      const checked = validatePushEndpoint(endpoint);
      if (!checked.ok) return redirect(response, `/settings?said=${encodeURIComponent(checked.problem)}`);
      const p256dhBytes = Buffer.from(p256dh, "base64url");
      const authBytes = Buffer.from(auth, "base64url");
      if (p256dhBytes.length !== 65 || p256dhBytes[0] !== 4 || authBytes.length !== 16) {
        return redirect(response, `/settings?said=${encodeURIComponent("that subscription's keys are not the shape a browser mints")}`);
      }
      const keys = loadOrCreateVapidKeys(dirname(options.telegramTokenFile ?? "."));
      const generation = store.approverGeneration(who.name) ?? 1;
      const enrolled = store.enrollPushSubscription(
        {
          endpoint,
          p256dh,
          auth,
          approver: who.name,
          approverGeneration: generation,
          uaWords: oneLineUa(request.headers["user-agent"]),
          vapidFingerprint: keys.fingerprint,
        },
        clock(),
      );
      if (!enrolled.ok) {
        return redirect(response, `/settings?said=${encodeURIComponent(enrolled.reason === "approver-cap" ? "five devices per person — remove one first" : "twenty devices per installation — remove one first")}`);
      }
      return redirect(response, `/settings?said=${encodeURIComponent("this device now gets a buzz when the plane needs a person")}`);
    }

    if (url.pathname === "/push/remove") {
      const body = readForm(posted, CONSOLE_FORMS.pushRemove);
      if (who.via !== "cookie") return refuse(response, who, 403, "push removal is a browser session's act");
      const id = Number(body.get("id") ?? "");
      const mine = store.listPushSubscriptions(who.name).find(one => one.id === id && one.retiredAt === null);
      if (mine === undefined) return redirect(response, `/settings?said=${encodeURIComponent("that device is not yours to remove, or it is already gone")}`);
      store.retirePushSubscription(mine.id, `removed by ${who.name}`, clock());
      return redirect(response, `/settings?said=${encodeURIComponent("removed — that device stops receiving pushes")}`);
    }

    if (url.pathname === "/onboarding/phone/dismiss") {
      const body = readForm(posted, CONSOLE_FORMS.phoneDismiss);
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "An approver puts this away.", "/chat");
      store.recordInstallationFact(PHONE_CARD_FACT, who.name, now);
      return body.get("quiet") === "1" ? respond(response, 204, "text/plain; charset=utf-8", "") : redirect(response, "/chat");
    }
    if (url.pathname === "/chat/config") {
      const body = readForm(posted, CONSOLE_FORMS.chatConfig);
      // The console's own door into `config set chat` (operator request:
      // chat lives mainly in the web UI). Same ceremony weight as the CLI
      // verb: the password typed again authenticates the approver, the
      // write is audited under their name, and the KEY still never
      // touches a form or this database — environment only.
      if (who.via !== "cookie") return refuse(response, who, 403, "chat setup is a browser surface");
      const back = body.get("return") === "/settings/lead" ? "/settings/lead" : safeChatReturn(body.get("return"));
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(who, password).ok) {
        return redirect(response, chatReturnWithSaid(back, "configuring chat spend takes your password, typed again"));
      }
      if (body.get("off") === "1") {
        store.clearChatConfig();
        return redirect(response, chatReturnWithSaid(back, "chat is off — its settings were removed"));
      }
      const forget = body.get("forget-key") ?? "";
      if (forget === "anthropic-api" || forget === "openrouter-api") {
        forgetChatKey(forget);
        return redirect(response, chatReturnWithSaid(back, "the stored key file is gone (an environment variable, if set, still applies)"));
      }
      const provider = body.get("provider") ?? "";
      const requestedModel = (body.get("model") ?? "").trim();
      const weeklyText = (body.get("weekly-usd") ?? "").trim();
      const weekly = Number(weeklyText);
      const daily = (body.get("daily-turns") ?? "").trim() === "" ? 50 : Number(body.get("daily-turns"));
      if (provider !== "anthropic-api" && provider !== "openrouter-api" && provider !== "claude-subscription" && provider !== "codex-subscription") {
        return redirect(response, chatReturnWithSaid(back, "pick a chat provider"));
      }
      const subscription = isSubscriptionChatProvider(provider);
      const model = requestedModel === "" && subscription ? "default" : requestedModel;
      if (!validModelId(model)) {
        return redirect(response, chatReturnWithSaid(back, "the model id must be 1–128 letters, digits, dots, slashes, colons, underscores, or dashes"));
      }
      // The key, when pasted, is stored FIRST (0600 file, Telegram-token
      // precedent) so the catalog fetch below can already use it. It never
      // touches the database and is never echoed back.
      const pastedKey = (body.get("key") ?? "").trim();
      if (pastedKey !== "") {
        if (subscription) return redirect(response, chatReturnWithSaid(back, "subscription chat uses the CLI's cached login — do not paste an API key"));
        const stored = storeChatKey(provider as DirectChatProviderId, pastedKey);
        if (!stored.ok) return redirect(response, chatReturnWithSaid(back, stored.message));
      }
      // The pin: anthropic models come from the compiled table; openrouter
      // models come from OpenRouter's OWN catalog, priced by the authority
      // that will bill them. No price found anywhere = refused, not guessed.
      // Live list prices (Settings → Models) come first; the compiled table
      // is the fallback when the catalog has never been fetched.
      let pin = subscription ? { inMicrousd: 0, outMicrousd: 0 } : livePin(store, provider, model) ?? priceOf(model);
      if (provider === "openrouter-api") {
        const catalog = await chatCatalog();
        const hit = catalog?.find(one => one.id === model);
        if (hit !== undefined) pin = hit.price;
      }
      if (!subscription && pin === null) {
        return redirect(response, chatReturnWithSaid(back, provider === "openrouter-api" ? "that model is not in OpenRouter's catalog (or the catalog is unreachable) — chat cannot reserve spend it cannot bound" : "that model has no pinned price — chat cannot reserve spend it cannot bound"));
      }
      if (!subscription && (!Number.isFinite(weekly) || weekly <= 0)) {
        return redirect(response, chatReturnWithSaid(back, "the weekly ceiling is a positive dollar amount — chat without one is unbounded, not configured"));
      }
      if (!Number.isInteger(daily) || daily <= 0 || daily > 1_000) {
        return redirect(response, chatReturnWithSaid(back, "daily turns is a whole number between 1 and 1000"));
      }
      store.setChatConfig(
        {
          provider,
          model,
          dailyTurns: daily,
          weeklyCeilingMicrousd: subscription ? 0 : Math.round(weekly * 1_000_000),
          priceInMicrousd: pin!.inMicrousd,
          priceOutMicrousd: pin!.outMicrousd,
        },
        who.name,
        now,
      );
      return redirect(response, back);
    }

    // ---- the mate (mate arc §5) ------------------------------------------
    if (url.pathname === "/chat/mate/mint") {
      const body = readForm(posted, CONSOLE_FORMS.mateMint);
      if (who.via !== "cookie") return refuse(response, who, 403, "the mate is a browser surface");
      const back = safeChatReturn(body.get("return"));
      const enabled = chatEnablement();
      if (!enabled.ok) return redirect(response, chatReturnWithSaid(back, enabled.why));
      // The one password ceremony of a conversation (§1): it restates the
      // terms — this spend ceiling, over these projects — and mints the
      // session every later turn debits without asking again.
      const ceilingText = (body.get("ceiling-usd") ?? "").trim();
      const ceilingUsd = enabled.billing === "subscription" ? 0 : Number(ceilingText);
      if (enabled.billing === "metered" && (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0 || ceilingUsd > 1_000)) {
        return redirect(response, chatReturnWithSaid(back, "the session ceiling is a dollar amount between 0 and 1000"));
      }
      // The signed-in session is the authority (an approver in good
      // standing); a typed password, when sent, is still checked.
      const token = body.get("token") ?? "";
      const verified = token === "" ? verifyApproverStanding(store, who.name, who.session.generation, managedRepos()) : verifyApproverByPassword(store, who.name, token, managedRepos());
      if (!verified.ok) return redirect(response, chatReturnWithSaid(back, token === "" ? "Your access changed. Sign in again to start chat." : "That password did not match."));
      startMateConversation(who, verified.who, enabled, ceilingUsd, body.get("follow") === "yes", now);
      return redirect(response, back);
    }
    if (url.pathname === "/chat/mate/follow") {
      const body = readForm(posted, CONSOLE_FORMS.mateFollow);
      if (who.via !== "cookie") return refuse(response, who, 403, "Open the conversation to change automatic updates.");
      const principal = matePrincipal(who), session = store.activeMateSession(who.name), thread = store.liveMateThreadFor(who.name);
      if (!principal || !session || !thread || !configureLeadFollow(store, principal, session, thread, body.get("enabled") === "yes", now)) return refuse(response, who, 409, "Conversation access changed. Start chat again.", "/chat");
      return redirect(response, safeChatReturn(body.get("return")));
    }
    if (url.pathname === "/chat/mate/end") {
      const body = readForm(posted, CONSOLE_FORMS.mateEnd);
      if (who.via !== "cookie") return refuse(response, who, 403, "the mate is a browser surface");
      const back = safeChatReturn(body.get("return"));
      // Ending spend and forgetting the thread takes no password: any
      // approver may revoke (§1), and the thread is theirs to drop (ruling 11).
      store.failLiveMateTurnsFor(who.name, "ended", now);
      store.endMateSessionsFor(who.name, who.name, now);
      store.closeMateThreadsFor(who.name, now);
      mateSaid.delete(who.session.csrf);
      return redirect(response, back);
    }
    if (url.pathname === "/chat/mate/stop") {
      const body = readForm(posted, CONSOLE_FORMS.mateStop);
      if (who.via !== "cookie") return refuse(response, who, 403, "the mate is a browser surface");
      const back = safeChatReturn(body.get("return"));
      const wanted = Number(body.get("turn") ?? "");
      const live = store.liveMateTurnFor(who.name);
      if (!Number.isInteger(wanted) || live === null || live.id !== wanted) {
        noteMate(who.session.csrf, null, "that turn has already finished");
        return redirect(response, chatReturnWithLatest(back));
      }
      // A stopped direct-API turn is conservatively charged its reserved
      // worst case: dispatch may already have happened. Membership turns
      // reserve zero. The conversation itself stays live.
      store.failLiveMateTurnsFor(who.name, "stopped", now);
      noteMate(who.session.csrf, live.id, "stopped — the conversation is still open");
      return redirect(response, chatReturnWithLatest(back));
    }
    const mateProposal = /^\/chat\/proposal\/([0-9]{1,15})\/(confirm|dismiss)$/.exec(url.pathname);
    if (mateProposal !== null) {
      const body = readForm(posted, CONSOLE_FORMS.mateProposal);
      if (who.via !== "cookie") return refuse(response, who, 403, "the mate is a browser surface");
      const back = safeChatReturn(body.get("return"));
      const id = Number(mateProposal[1]);
      const proposalRow=store.getMateProposal(id);
      const shared=proposalRow&&store.handle.prepare('SELECT id FROM team_conversation WHERE thread=?').get(proposalRow.thread);
      const proposalTaskHref = (taskId: string) => taskChatHref(taskId) + (shared ? '&conversation=' + encodeURIComponent(String(shared['id'])) : '');
      let principal:VerifiedApprover|null=null;
      if(shared){
        try { const access=team.domain.access({name:who.name,generation:who.session.generation},String(shared['id']),'contributor');
          const proof=verifyApproverStanding(store,who.name,who.session.generation,access.conversation.projects); principal=proof.ok?proof.who:null;
        } catch { return refuse(response,who,404,'This proposal is unavailable.',back); }
      } else principal=matePrincipal(who);
      // Confirm in place (chat cards): the same door and checks, answered in
      // JSON so the conversation stays where it is; the card's refreshed
      // state carries the result. The secure review screen stays a form.
      const cardJson = String(request.headers["accept"] ?? "").includes("application/json") && !body.has("nonce");
      const cardAnswer = (status: number, ok: boolean, said: string, taskId: string | null = null): void =>
        respond(response, status, "application/json", JSON.stringify({ ok, said, taskId }));
      if (principal === null) return cardJson ? cardAnswer(403, false, "Your approver standing changed. Sign in again.") : refuse(response, who, 403, "your approver standing changed — sign in again", back);
      if (mateProposal[2] === "dismiss") {
        const dismissed = dismissMateProposal(store, principal, id, now);
        if (cardJson) return cardAnswer(dismissed ? 200 : 409, dismissed, dismissed ? "Dismissed." : "That card was already acted on.");
        if (!dismissed) noteMate(who.session.csrf, null, "that proposal was already acted on");
        return redirect(response, chatReturnWithLatest(back));
      }
      const outcome = confirmMateProposal(store, principal, id, now, { chatProvider: teamChatProvider, confirm: body.get("confirm") === "yes", via: "web", evidenceRoot, ...(body.has("nonce") ? {actionReview:{nonce:body.get("nonce")??"",password:body.get("token")??""}} : {}) });
      if (cardJson) {
        if (!outcome.ok) return cardAnswer(outcome.reason === "standing" ? 403 : outcome.reason === "not-yours" ? 404 : 409, false, outcome.said);
        return cardAnswer(200, true, outcome.said, outcome.taskId);
      }
      if (!outcome.ok && (outcome.reason === "not-yours" || outcome.reason === "standing")) {
        return refuse(response, who, outcome.reason === "standing" ? 403 : 404, outcome.said, back);
      }
      if (outcome.kind === "action" && body.has("nonce")) {
        if (!outcome.ok && outcome.reason === "needs-confirm") return refuse(response,who,409,outcome.said,sharedActionReviewPath(id));
        return redirect(response,sharedActionReviewPath(id));
      }
      if (!outcome.ok && shared) return redirect(response, chatReturnWithSaid(back, outcome.said));
      if (!outcome.ok && outcome.reason === "needs-confirm") noteMate(who.session.csrf, null, outcome.said);
      // A confirmed task proposal leads to the task it actually created
      // (package 2): the lens over this same conversation, whose journey
      // and plan are the next step. The id is the door's recorded
      // outcome, never a title or the assistant's prose; a refused,
      // replayed, or unavailable confirmation returns as before, with
      // the card carrying the door's words.
      if (outcome.ok && outcome.kind === "task" && outcome.taskId !== null && taskChatFocus(outcome.taskId, now, who, { mintNonce: false }) !== null) {
        return redirect(response, `${proposalTaskHref(outcome.taskId)}#task-chat-live`);
      }
      if (outcome.ok && outcome.kind === "review" && outcome.taskId !== null) {
        const proposal = store.getMateProposal(id)!;
        // A revision confirmed here returns to its receipt: the newest
        // reply, whose confirmed card names the revision and links to the
        // plan. Landing at the top left that message under the phone's
        // fixed composer (build #1604 feedback).
        return redirect(response, proposal.payload["operation"] === "revise"
          ? chatReturnWithLatest(revisionDestination(outcome.taskId, proposalTaskHref(outcome.taskId)))
          : `${proposalTaskHref(outcome.taskId)}&result=${Number(proposal.payload["run"])}#request-changes`);
      }
      if (outcome.ok && outcome.kind === "task_action" && outcome.taskId !== null) {
        const proposal = store.getMateProposal(id)!;
        if (proposal.payload["operation"] === "resume") {
          return armTaskResume(response, who, outcome.taskId, String(proposal.payload["run"]), "chat", now);
        }
        return redirect(response, `${proposalTaskHref(outcome.taskId)}#task-chat-live`);
      }
      return redirect(response, chatReturnWithLatest(back));
    }
    // Coordinator proposals (mate arc v3): confirmed by any approver whose
    // ceiling admits the repo; the card lives on /chat and on the task.
    const coordinatorProposal = /^\/proposals\/([0-9]{1,15})\/(confirm|dismiss)$/.exec(url.pathname);
    if (coordinatorProposal !== null) {
      const body = readForm(posted, CONSOLE_FORMS.coordinatorProposal);
      if (who.via !== "cookie") return refuse(response, who, 403, "proposals are confirmed from the browser or the CLI");
      const principal = matePrincipal(who);
      if (principal === null) return refuse(response, who, 403, "your approver standing changed — sign in again", "/chat");
      const id = Number(coordinatorProposal[1]);
      store.sweepCoordinatorProposals(now);
      const back = body.get("return") === null ? "/chat" : safeReturn(body.get("return"));
      if (coordinatorProposal[2] === "dismiss") {
        dismissCoordinatorProposal(store, principal, id, now);
        return redirect(response, back);
      }
      const outcome = confirmCoordinatorProposal(store, principal, id, now, { confirm: body.get("confirm") === "yes", via: "web" });
      if (!outcome.ok && (outcome.reason === "not-yours" || outcome.reason === "standing")) {
        return refuse(response, who, outcome.reason === "standing" ? 403 : 404, outcome.said, back);
      }
      return redirect(response, outcome.ok || outcome.reason !== "needs-confirm" ? back : `${back}${back.includes("?") ? "&" : "?"}said=${encodeURIComponent(outcome.said)}`);
    }

    if (url.pathname === "/chat") {
      const body = readForm(posted, CONSOLE_FORMS.chat);
      if (who.via !== "cookie") return refuse(response, who, 403, "chat is a browser surface");
      const requestedTask = body.get("task");
      const focusTask = taskChatFocus(requestedTask, now, who);
      const chatProject = focusTask !== null ? null : chatProjectOf(body.getAll("project"));
      // The enhanced send (package 2): the SAME endpoint, fields, request
      // receipt key, and session binding as the native form — only the
      // answer differs. A fetch that asks for JSON gets the refusal's
      // words or an acceptance instead of a redirect; nothing is retried,
      // cleared, or authorized here that the native POST would not.
      const wantsJson = String(request.headers["accept"] ?? "").includes("application/json");
      if (requestedTask !== null && focusTask === null) {
        return wantsJson
          ? respond(response, 404, "application/json", JSON.stringify({ ok: false, said: "That task is not available in this workspace.", session: null }))
          : redirect(response, chatReturnWithSaid("/chat", "That task is not available in this workspace."));
      }
      if (chatProject === undefined) {
        return wantsJson
          ? respond(response, 404, "application/json", JSON.stringify({ ok: false, said: "That project is not available in this workspace.", session: null }))
          : redirect(response, chatReturnWithSaid("/chat", "That project is not available in this workspace."));
      }
      const back = focusTask !== null ? taskChatHref(focusTask.id) : chatProject !== null ? projectChatHref(chatProject) : "/chat";
      const said = (status: number, words: string, session: number | null = null): void =>
        wantsJson ? respond(response, status, "application/json", JSON.stringify({ ok: false, said: words, session })) : redirect(response, chatReturnWithSaid(back, words));
      const resultValue = body.get("result");
      const viewedRun = resultValue === null ? null : /^[0-9]{1,15}$/.test(resultValue) ? store.getRun(Number(resultValue)) : null;
      if (resultValue !== null && (body.getAll("result").length !== 1 || viewedRun === null || focusTask === null || !runVisible(viewedRun) || !focusTask.family.versions.some(one => one.refId === viewedRun.taskRef))) {
        return said(409, "That result is no longer available for this task. Review the task before sending.");
      }
      const resultContext = viewedRun === null ? "" : ` The operator is viewing result #${viewedRun.id} from execution ${store.externalIdFor(viewedRun.taskRef)}. Use get_result for that exact execution and run when responding to feedback; do not substitute another result.`;
      // The task composer's mode (console v2): fixed words for this turn only.
      // It steers what the lead proposes and grants nothing: every action
      // still arrives as a card the person confirms under its own rules.
      const modeValue = body.get("mode");
      if (modeValue !== null && (focusTask === null || body.getAll("mode").length !== 1 || !Object.hasOwn(TASK_COMPOSER_MODES, modeValue))) {
        return said(400, "Choose Build, Plan only or Just answer, then send again. Your draft is saved.");
      }
      const modeContext = modeValue === null ? "" : ` ${TASK_COMPOSER_MODES[modeValue as TaskComposerMode]}`;
      const enabled = chatEnablement();
      if (!enabled.ok) return said(409, enabled.why);
      // A live mate session: the message is a mate turn — no password, the
      // session's ceremony already covered it (§1); the engine refuses on
      // its own terms and the thread shows why.
      const mateSession = who.role === "approver" ? store.activeMateSession(who.name) : null;
      if (mateSession !== null) {
        const requestId = body.get("request");
        if (requestId !== null && (body.getAll("request").length !== 1 || body.getAll("request-session").length !== 1 || body.get("request-session") !== String(mateSession.id))) {
          return said(409, "This conversation changed. Reload it before sending your message.");
        }
        const principal = matePrincipal(who);
        if (principal === null) return wantsJson ? said(403, "your approver standing changed — sign in again") : refuse(response, who, 403, "your approver standing changed — sign in again", back);
        const message = (body.get("message") ?? "").trim();
        if (message === "" || message.length > MATE_MESSAGE_MAX_CHARS) {
          return said(400, `a message is 1 to ${MATE_MESSAGE_MAX_CHARS} characters`, mateSession.id);
        }
        const opened = store.openMateThread(who.name, principal.ceilingDigest, now, chatScopeOf(focusTask, chatProject));
        const onProgress = beginLiveTurn(opened.thread.id);
        void runMateTurn({ store, who: principal, session: mateSession, thread: opened.thread, config: enabled.config, key: enabled.key, message, onProgress, channel: "console", ...(requestId === null ? {} : { requestId }), ...(focusTask === null && chatProject !== null ? { context: `Current project: ${projectName(chatProject)} (${chatProject}). Keep this conversation about that project unless the operator explicitly asks to broaden it; use it as the repo for project tools.` } : {}), ...(focusTask === null ? {} : { context: `Current task: ${focusTask.id}. Read it with get_task before answering or proposing changes. Read its currentExecution next and bind new actions to that exact execution. Never replace the target of a prior proposal with a newer revision. Keep this turn about that task unless the operator explicitly asks to broaden it.${resultContext}${modeContext}` }), fetcher: chatFetcher, ...(options.subscriptionChatRunner === undefined ? {} : { subscriptionRunner: options.subscriptionChatRunner }), clock, evidenceRoot })
          .then(outcome => {
            // A turn that saved its outcome in the thread (one stopped at its deadline) is said there, once.
            if (!outcome.ok && !("saved" in outcome && outcome.saved === true)) noteMate(who.session.csrf, "turn" in outcome ? outcome.turn : null, outcome.message);
            endLiveTurn(opened.thread.id, outcome.ok);
          })
          .catch(() => { noteMate(who.session.csrf, null, "the turn failed unexpectedly"); endLiveTurn(opened.thread.id, false); });
        // Accepted for the engine, not received: the receipt is written by
        // the turn's own admission, and the status poll is where the page
        // learns of it — the same road as after a native send.
        if (wantsJson) return respond(response, 202, "application/json", JSON.stringify({ ok: true, session: mateSession.id, task: focusTask?.id ?? "", ...(chatProject === null ? {} : { project: chatProject }), request: requestId }));
        return redirect(response, chatReturnWithLatest(back));
      }
      if (wantsJson) return said(409, "This conversation ended. Reload to continue.");
      if (focusTask !== null) {
        return redirect(response, chatReturnWithSaid(back, "Start the conversation first, then ask about this task without another password prompt."));
      }
      if (enabled.billing === "subscription") {
        return redirect(response, `/chat?said=${encodeURIComponent("start the conversation first — the one password ceremony opens the subscription-backed session")}`);
      }
      // The password, typed again, on EVERY message (v2 ruling 2): chat is
      // spend, and a seven-day cookie is not a spend credential.
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(who, password).ok) {
        return redirect(response, `/chat?said=${encodeURIComponent("chat spends — your password, typed again, with every message")}`);
      }
      const message = (body.get("message") ?? "").trim();
      if (message === "" || message.length > 2_000) {
        return redirect(response, `/chat?said=${encodeURIComponent("a message is 1 to 2000 characters")}`);
      }
      // Secrets refuse BEFORE any row or request exists — nothing stored,
      // nothing sent (v3 brief; scanForSecrets is the same high-confidence
      // set the evidence path trusts).
      if (scanForSecrets(message).length > 0) {
        return redirect(response, `/chat?said=${encodeURIComponent("that looks like a credential — chat never forwards or stores those")}`);
      }
      store.sweepStaleChatTurns(now);
      const turnRepos = managedRepos();
      const snapshot = withDispatchDiagnoses(store, store.chatSnapshot(turnRepos, now), now);
      const { document } = buildDataDocument(snapshot);
      // The WHOLE outbound body is scanned — a token in a task title
      // refuses the turn exactly like one typed in the box (v2 ruling 4).
      const composed = composeRequest({
        provider: enabled.config.provider,
        model: enabled.config.model,
        key: "",
        dataDocument: document,
        userMessage: message,
      });
      if (scanForSecrets(composed.body).length > 0) {
        return redirect(response, `/chat?said=${encodeURIComponent("fleet context contains something credential-shaped — chat refuses to send it; find and remove it first")}`);
      }
      // Sprint 8: the organisation policy allows this chat's provider and model, or the turn doesn't start.
      const disallowed = store.agentPolicyRefusal(enabled.config.provider, enabled.config.model);
      if (disallowed !== null) return redirect(response, `/chat?said=${encodeURIComponent(disallowed)}`);
      const reserved = worstCaseForPrice(enabled.price, Buffer.byteLength(composed.body, "utf8"));
      const opened = store.openChatTurn(
        {
          approver: who.name,
          credentialKey: enabled.credentialKey,
          provider: enabled.config.provider,
          model: enabled.config.model,
          reservedMicrousd: reserved,
          dailyTurns: enabled.config.dailyTurns,
          weeklyCeilingMicrousd: enabled.config.weeklyCeilingMicrousd,
          deadlineMs: TURN_WALL_CLOCK_MS + 10_000,
        },
        now,
      );
      if (!opened.ok) {
        const said =
          opened.reason === "latched"
            ? "a turn with unknown cost blocks this credential — acknowledge it below first"
            : opened.reason === "concurrent"
              ? "one turn at a time — this one is still running"
              : opened.reason === "daily-cap"
                ? "the daily turn cap is reached"
                : opened.reason === "monthly-budget"
                  ? "a monthly budget this counts toward holds it: used up, or its cost can't be priced yet (the Spend page says which)"
                  : "the weekly spend ceiling would be exceeded";
        return redirect(response, `/chat?said=${encodeURIComponent(said)}`);
      }
      void runChatTurn(opened.id, who.session, enabled, message, document, turnRepos);
      return redirect(response, "/chat#latest");
    }

    const chatFile = /^\/chat\/file\/([0-9a-f]{32})$/.exec(url.pathname);
    if (chatFile !== null) {
      const body = readForm(posted, CONSOLE_FORMS.chatFile);
      if (who.via !== "cookie") return refuse(response, who, 403, "chat is a browser surface");
      const key = chatFile[1] as string;
      const chat = who.session.chat;
      const candidate = chat?.candidates.get(key);
      // The filing act creates durable rows from model text: password again.
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(who, password).ok) {
        return redirect(response, `/chat?said=${encodeURIComponent("filing a draft takes your password, typed again")}`);
      }
      if (chat === undefined || candidate === undefined) {
        return refuse(response, who, 404, "that draft is gone — drafts live in the session and do not survive restarts", "/chat");
      }
      // Single-use CAS with no await between check and claim (v2 new 3).
      if (candidate.state !== "pending") return refuse(response, who, 409, "that draft is already being filed", "/chat");
      candidate.state = "filing";
      const enabled = chatEnablement();
      if (!enabled.ok || candidate.approver !== who.name || candidate.ceilingDigest !== chatCeilingDigest()) {
        candidate.state = "pending";
        return refuse(response, who, 409, "the world changed since this draft was made — it cannot be filed", "/chat");
      }
      // Re-validated at the act: the door runs every field check again, and
      // the fields are scanned for secrets before they become durable.
      const acceptanceFields = candidate.draft.acceptance.flatMap(c => [c.statement, ...(c.how === null ? [] : [c.how])]);
      const fields = [candidate.draft.title, candidate.draft.goal, candidate.draft.outOfScope ?? "", ...candidate.draft.touches, ...acceptanceFields];
      if (scanForSecrets(fields.join("\n")).length > 0) {
        chat.candidates.delete(key);
        return refuse(response, who, 400, "that draft contains something credential-shaped — discarded", "/chat");
      }
      const filedVia = `chat:${enabled.config.provider}`;
      const made = fileTaskProposal(
        store,
        {
          title: candidate.draft.title,
          repo: candidate.repoPath,
          goal: candidate.draft.goal,
          outOfScope: candidate.draft.outOfScope,
          touches: candidate.draft.touches,
          acceptance: candidate.draft.acceptance,
          filedVia, filedBy: { name: who.name, kind: "person" as const },
          admittedRepos: managedRepos(),
        },
        now,
      );
      if (!made.ok) {
        candidate.state = "pending";
        return refuse(response, who, 400, `the door refused it: ${made.message}`, "/chat");
      }
      chat.candidates.delete(key);
      return redirect(response, taskHref(made.id));
    }

    const chatAckPost = /^\/chat\/ack\/([0-9]{1,15})$/.exec(url.pathname);
    if (chatAckPost !== null) {
      const body = readForm(posted, CONSOLE_FORMS.chatAck);
      if (who.via !== "cookie") return refuse(response, who, 403, "acknowledgement is a browser ceremony");
      const turn = store.getChatTurn(Number(chatAckPost[1]));
      if (turn === null) return refuse(response, who, 404, "no such turn", "/chat");
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(who, password).ok) {
        return refuse(response, who, 403, "acknowledging unknown spend takes your password", "/chat");
      }
      const nonce = body.get("nonce") ?? "";
      if (!consumeApprovalNonce(nonce, who.name, `chat-ack-${turn.id}`, String(turn.reservedMicrousd))) {
        return refuse(response, who, 409, "this screen expired — reopen it and read the terms again", "/chat");
      }
      if (!store.acknowledgeChatTurn(turn.id, who.name, now)) {
        return refuse(response, who, 409, "already acknowledged", "/chat");
      }
      return redirect(response, "/chat");
    }
    return refuse(response, who!, 404, "There's no page at this address.", "/chat");
  }

  /** Chat's first run: the steps, first tasks until the first task exists, and the sandbox while no agent is signed in. */
  function chatFirstRun(now: Date, project: string | null): BrowserFirstRun | undefined {
    const steps = firstRunStepsNow(now);
    if (steps === null) return undefined;
    const taskFiled = steps.find(one => one.key === "task")?.done ?? true;
    const repo = project ?? managedRepos()[0] ?? null;
    const agent = steps.find(one => one.key === "agent");
    const lead = leadWords();
    return {
      steps,
      suggestions: taskFiled || repo === null ? [] : firstTasksFor(repo),
      sandbox: agent !== undefined && !agent.done && !agent.checking ? SANDBOX_COMMAND : null,
      intro: HOW_IT_WORKS,
      lead: lead === null ? null : { words: `The lead uses ${lead}`, href: "/settings/lead" },
      // With no lead yet and no agent signed in, the page asks this computer again on its own.
      recheck: store.getChatConfig() === null && agent !== undefined && !agent.done ? "/lead/status" : null,
    };
  }
  /** After the first Ready result, once (onboarding): the phone, by a chat app or the console over Tailscale. */
  /** Chat's one-line pointer to the phone setup: after the first Ready result, until put away or Telegram is paired. */
  function phoneCard(who: Who & { via: "cookie" }, now: Date): BrowserPhoneCard | undefined {
    if (who.role !== "approver" || store.isDemo() || store.firstSuccessAt(now) === null || store.installationFact(PHONE_CARD_FACT) !== null) return undefined;
    const botId = options.telegramTokenFile === undefined ? null : loadBotToken(process.env, options.telegramTokenFile)?.botId ?? null;
    if (botId !== null && store.liveTelegramBindings(botId).length > 0) return undefined;
    return phoneSetup(who);
  }
  /** The project a chat request names: exactly one, visible to this person
   * and one of this console's projects; undefined when refused. */
  function chatProjectOf(values: string[]): string | null | undefined {
    if (values.length === 0) return null;
    const wanted = values[0] ?? "";
    return values.length === 1 && visible(wanted) && managedRepos().includes(wanted) ? wanted : undefined;
  }
  function beginLiveTurn(thread: number): (event: MateProgress) => void {
    const previous = liveTurns.get(thread);
    if (previous?.expiry) clearTimeout(previous.expiry);
    const live: LiveTurn = { steps: [], done: false, ok: false, listeners: previous?.listeners ?? new Set() };
    liveTurns.set(thread, live);
    const current = () => live.steps.at(-1) ?? (live.steps.push({ tools: [], toolCalls: [], text: "" }), live.steps.at(-1)!);
    return event => {
      if (live.done) return;
      if (event.kind === "step") live.steps.push({ tools: [], toolCalls: [], text: "" });
      else if (event.kind === "tool") {
        current().tools.push(event.label);
        current().toolCalls.push({ id: event.id, label: event.label, state: "running" });
      } else if (event.kind === "tool-result") {
        for (const step of live.steps) {
          const index = step.toolCalls.findIndex(tool => tool.id === event.id);
          if (index !== -1) {
            step.toolCalls[index] = { ...step.toolCalls[index]!, ...event.outcome };
            break;
          }
        }
      } else if (event.kind === "text") current().text = event.text;
      for (const listener of live.listeners) listener();
    };
  }
  function endLiveTurn(thread: number, ok: boolean): void {
    const live = liveTurns.get(thread);
    if (live === undefined || live.done) return;
    live.done = true;
    live.ok = ok;
    for (const listener of live.listeners) listener();
    live.expiry = setTimeout(() => { if (liveTurns.get(thread) === live) liveTurns.delete(thread); }, 60_000);
    live.expiry.unref();
  }
  function noteMate(csrf: string, turn: number | null, message: string): void {
    if (mateSaid.size >= 500) {
      const oldest = mateSaid.keys().next().value;
      if (oldest !== undefined) mateSaid.delete(oldest);
    }
    mateSaid.set(csrf, { turn, message });
  }
  function takeMateNote(csrf: string, liveSession: number | null): string | null {
    const noted = mateSaid.get(csrf);
    if (noted === undefined) return null;
    mateSaid.delete(csrf);
    if (noted.turn === null) return noted.message;
    const turn = store.getMateTurn(noted.turn);
    return turn !== null && turn.session === liveSession ? noted.message : null;
  }
  /** A finished demo exchange's result, read back from the evidence its run actually stored. */
  function demoResultView(exchange: DemoExchange): DemoResultView | null {
    if (exchange.runId === null || exchange.taskId === null) return null;
    const artifacts = store.artifactsFor(exchange.runId);
    const text = (kind: string): string | null => {
      const artifact = artifacts.find(one => one.kind === kind);
      if (artifact === undefined) return null;
      const read = readVerifiedArtifact(evidenceRoot, artifact);
      return read.ok ? read.content.toString("utf8") : null;
    };
    const shot = artifacts.find(one => one.kind === "screenshot");
    const stat = (() => { try { return JSON.parse(text("diff-stat") ?? "null") as { additions: number; deletions: number; fileCount: number } | null; } catch { return null; } })();
    const assignment = assignmentOf(store, exchange.taskId, clock(), { principal: "operator", repos: managedRepos() }, evidenceRoot);
    const log = text("check-log");
    return {
      diff: text("terminal-diff"),
      checkLog: log === null ? null : log.slice(log.indexOf("$ ") === -1 ? 0 : log.indexOf("$ ")),
      checks: { status: assignment?.receipt?.checks.status ?? "unavailable", detail: assignment?.receipt?.checks.detail ?? "Saved checks are unavailable." },
      screenshot: shot === undefined ? null : { href: `/r/${exchange.runId}/evidence/${shot.id}`, caption: exchange.plan.screenshot.caption },
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      files: stat?.fileCount ?? 0,
      taskHref: taskHref(exchange.taskId),
    };
  }

  function storeChatKey(provider: DirectChatProviderId, key: string): { ok: true } | { ok: false; message: string } {
    if (options.configDir === undefined) {
      return { ok: false, message: "this server has no config directory — export the key in the serve environment instead" };
    }
    if (!plausibleChatKey(provider, key)) {
      return { ok: false, message: "that does not look like an API key (expected sk-…) — nothing was stored" };
    }
    const file = join(options.configDir, `chat-key-${provider}`);
    writeFsFileSync(file, `${key.trim()}\n`, { mode: 0o600 });
    // writeFileSync applies the mode only on creation; assert it regardless.
    chmodSync(file, 0o600);
    runtime.catalogCache = null; // a new key may see a different catalog
    return { ok: true };
  }

  function forgetChatKey(provider: DirectChatProviderId): void {
    if (options.configDir === undefined) return;
    try {
      rmFileSync(join(options.configDir, `chat-key-${provider}`));
    } catch {
      // never stored — nothing to forget
    }
    runtime.catalogCache = null;
  }

  /** Session-memory hygiene: drafts age out; a filed or dead session frees
   * its bytes; the per-approver cap spans ALL that approver's sessions. */
  function sweepChatDrafts(nowMs: number): void {
    for (const session of sessions.values()) {
      if (session.chat === undefined) continue;
      for (const [key, candidate] of session.chat.candidates) {
        if (nowMs - candidate.createdAt > CHAT_CANDIDATE_TTL_MS) session.chat.candidates.delete(key);
      }
    }
  }

  /** The one network call a turn makes, run detached from the request that
   * opened it. Every failure maps to the closed enum BEFORE anything can
   * log it; a turn that may have started but has no usable usage LATCHES
   * (unknown spend blocks the credential until acknowledged).  */
  async function runChatTurn(
    turnId: number,
    session: Session,
    enabled: Extract<ChatEnablement, { ok: true; billing: "metered" }>,
    userMessage: string,
    dataDocument: string,
    turnRepos: readonly string[],
  ): Promise<void> {
    const started = store.startChatTurn(turnId, new Date());
    if (!started.ok) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_WALL_CLOCK_MS);
    let result: Awaited<ReturnType<typeof performChatRequest>>;
    try {
      result = await performChatRequest(
        {
          provider: enabled.config.provider,
          model: enabled.config.model,
          key: enabled.key,
          dataDocument,
          userMessage,
          signal: controller.signal,
        },
        chatFetcher,
      );
    } catch {
      result = { ok: false, problem: "network" };
    } finally {
      clearTimeout(timer);
    }
    const finish = (outcome: Parameters<Store["finalizeChatTurn"]>[2]): boolean =>
      store.finalizeChatTurn(turnId, started.generation, outcome, new Date());
    const tell = (reply: string | null, staticError: string | null, proposalsDiscarded = false): void => {
      const chat = session.chat ?? { candidates: new Map(), lastTurn: null };
      chat.lastTurn = { id: turnId, reply, staticError, proposalsDiscarded };
      session.chat = chat;
    };
    if (!result.ok) {
      if (result.problem.startsWith("status-")) {
        // The provider ANSWERED with an error: nothing billed.
        finish({ state: "failed", failureReason: "provider-error", settledMicrousd: 0 });
        tell(null, "The chat provider turned the request down. Nothing was kept or charged. Try again in a minute.");
      } else if (result.problem === "timeout") {
        finish({ state: "failed", failureReason: "timeout", settledMicrousd: null, unknownSpend: true });
        tell(null, "The reply took too long and was stopped, and its cost isn't known yet, so chat is paused. Confirm the cost on this page to turn chat back on.");
      } else if (result.problem === "network") {
        finish({ state: "failed", failureReason: "provider-error", settledMicrousd: null, unknownSpend: true });
        tell(null, "The chat provider stopped responding partway through, and the cost isn't known, so chat is paused. Confirm the cost on this page to turn chat back on.");
      } else {
        // 200 with an unusable wrapper: billed, amount unproven.
        finish({ state: "failed", failureReason: "malformed-reply", settledMicrousd: null, unknownSpend: true });
        tell(null, "The chat provider sent back an answer that couldn't be read, and its cost isn't known, so chat is paused. Confirm the cost on this page to turn chat back on.");
      }
      return;
    }
    // The pinned math, or the provider's own reported charge when that is
    // HIGHER — the ledger never undercounts what actually left the wallet.
    const pinnedSettle = settleForPrice(enabled.price, result.answer.tokensIn, result.answer.tokensOut);
    const settled = Math.max(pinnedSettle, result.answer.reportedCostMicrousd ?? 0);
    const envelope = parseAssistantEnvelope(result.answer.text);
    if (!envelope.ok) {
      finish({
        state: "failed",
        failureReason: "malformed-reply",
        tokensIn: result.answer.tokensIn,
        tokensOut: result.answer.tokensOut,
        settledMicrousd: settled,
      });
      tell(null, "the model's answer was malformed and was discarded");
      return;
    }
    const chat = session.chat ?? { candidates: new Map<string, ChatCandidate>(), lastTurn: null };
    session.chat = chat;
    let kept = 0;
    for (const draft of envelope.envelope.proposals) {
      const repoIndex = Number(draft.repoId.slice(1)) - 1;
      const repoPath = turnRepos[repoIndex];
      if (repoPath === undefined) continue;
      while (approverCandidateCount(session.name) >= CHAT_CANDIDATES_PER_APPROVER) evictOldestCandidate(session.name);
      const key = randomBytes(16).toString("hex");
      chat.candidates.set(key, {
        key,
        draft,
        repoPath,
        provider: enabled.config.provider,
        approver: session.name,
        ceilingDigest: chatCeilingDigest(turnRepos),
        createdAt: Date.now(),
        state: "pending",
      });
      kept++;
    }
    finish({
      state: "answered",
      tokensIn: result.answer.tokensIn,
      tokensOut: result.answer.tokensOut,
      settledMicrousd: settled,
      replyBytes: Buffer.byteLength(envelope.envelope.reply, "utf8"),
      candidateCount: kept,
    });
    tell(envelope.envelope.reply, null, envelope.proposalsDiscarded);
  }

  /** The Chat landing's live view: each agent at work now with its task and
   * phase, four counts, plan-window use (never dollars: subscriptions don't
   * bill per run) and Catch up's items, each tagged with its tab. Reads only. */
  function chatHomeOf(who: Who, repos: readonly string[], now: Date): BrowserHome {
    const access = workAccess();
    const admitted = (repo: string | null) => repo === null ? visible(null) : repos.includes(repo);
    const agents = store.liveRuns(now).filter(run => admitted(run.repo)).map(run => {
      const root = familyOf(run.taskId)?.root ?? null;
      return { runId: run.id, taskId: root?.id ?? run.taskId, title: root?.title ?? run.title, href: taskHref(root?.id ?? run.taskId),
        agent: `${providerName(run.provider)} on ${run.runner}`, phase: homePhaseWords(run), project: run.repo === null ? null : projectName(run.repo), since: run.startedAt,
        activity: runActivityOf(store, run, now) };
    });
    const all = workIndexPage(store, now, access, { view: "all", limit: WORK_INDEX_MAX_LIMIT });
    const needs = workIndexPage(store, now, access, { view: "needs-you", limit: WORK_INDEX_MAX_LIMIT });
    const done = workIndexPage(store, now, access, { view: "completed", limit: WORK_INDEX_MAX_LIMIT });
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const counts: BrowserHomeCount[] = [
      { key: "working", label: "Working now", value: agents.length, href: "/work?view=running" },
      // Each by its shared headline, as the Tasks list words it: a result whose checks failed waits on you, it isn't ready.
      { key: "waiting", label: "Waiting on you", value: needs.items.filter(one => one.status.label !== "Ready for review").length, href: "/work?view=needs-you" },
      { key: "ready", label: "Ready to review", value: needs.items.filter(one => one.status.label === "Ready for review").length, href: "/work?view=needs-you" },
      { key: "done", label: "Done this week", value: done.items.filter(one => (one.completion?.at ?? one.updatedAt) >= weekAgo).length, href: "/work?view=completed" },
    ];
    const tabOf = (one: WorkIndexItem): BrowserCatchUpItem["tab"] => one.assignmentState === "ready-to-check" ? one.status.label === "Ready for review" ? "ready" : "needs-you"
      : one.assignmentState === "needs-decision" ? "needs-you" : one.assignmentState === "working" || one.assignmentState === "checking" ? "running" : "finished";
    const catchUp = all.items.filter(one => tabOf(one) !== "finished" || one.updatedAt >= weekAgo).slice(0, 40).map(one => ({
      id: one.rootId, title: one.title, href: taskHref(one.rootId), project: one.repo === null ? null : projectName(one.repo), tab: tabOf(one),
      label: one.status.label, tone: one.status.tone, detail: one.status.detail, at: one.updatedAt,
      action: (() => {
        const href = one.status.label === "Needs you" && one.primaryAction !== null ? browserWorkActionHref(one) : null;
        return href === null ? null : { label: one.primaryAction!.label, href };
      })(),
    }));
    const windows = who.via === "cookie" && store.isInstanceOperator(who.name) ? limitsView(store.providerLimits(), [], { project: projectName, teammate: id => `Teammate ${id}` }, now) : null;
    // One line: what this person's lead is doing now and when it last acted.
    const activity = leadActivity(store, who.name);
    const leadTask = activity?.taskId == null ? null : store.lookupRef(activity.taskId);
    const lead = activity === null ? null : { name: activity.name, doing: activity.doing, at: activity.at,
      href: leadTask == null || !admitted(leadTask.repo) ? null : taskHref(familyOf(activity.taskId!)?.root.id ?? activity.taskId!) };
    return {
      agents, counts, catchUp, allHref: "/work", ...(lead === null ? {} : { lead }),
      planUse: (windows?.tiles ?? []).map(one => ({ name: one.name, window: one.window, percent: one.percent, detail: one.detail, tone: one.tone })),
    };
  }
  function firstTasksFor(repo: string): FirstTaskSuggestion[] {
    const at = Date.now();
    let entry = firstTasks.get(repo);
    if (entry === undefined || (entry.until <= at && !entry.reading)) {
      const reading = { until: at + 10 * 60_000, found: entry?.found ?? null, reading: true };
      firstTasks.set(repo, reading);
      entry = reading;
      void findFirstTasks(repo, options.firstTaskRunner ?? execRun)
        .then(found => { reading.found = found; }, () => {})
        .finally(() => { reading.reading = false; });
    }
    return entry.found ?? firstTaskSuggestions({ issues: [], todos: [] });
  }

  function approverCandidateCount(approver: string): number {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.chat === undefined) continue;
      for (const candidate of session.chat.candidates.values()) {
        if (candidate.approver === approver) count++;
      }
    }
    return count;
  }

  function evictOldestCandidate(approver: string): void {
    let oldest: { session: Session; key: string; at: number } | null = null;
    for (const session of sessions.values()) {
      if (session.chat === undefined) continue;
      for (const candidate of session.chat.candidates.values()) {
        if (candidate.approver !== approver) continue;
        if (oldest === null || candidate.createdAt < oldest.at) {
          oldest = { session, key: candidate.key, at: candidate.createdAt };
        }
      }
    }
    if (oldest !== null) oldest.session.chat?.candidates.delete(oldest.key);
  }
  const registrations: Registration[] = [
    { id: "chat.stream", domain: "chat", stage: "console", method: "GET", handle: get },
    { id: "chat.mate-status", domain: "chat", stage: "console", method: "GET", handle: get },
    { id: "chat.demo-live", domain: "chat", stage: "console", method: "GET", handle: get },
    { id: "chat.page", domain: "chat", stage: "console", method: "GET", handle: get },
    { id: "chat.ack", domain: "chat", stage: "console", method: "GET", handle: get },
    { id: "chat.action", domain: "chat", stage: "console", method: "GET", handle: get },
    { id: "push.key", domain: "chat", stage: "console", method: "GET", handle: get },
    { id: "lead.status", domain: "chat", stage: "console", method: "GET", handle: get },
    { id: "chat.task-status", domain: "chat", stage: "console", method: "GET", handle: get },
    { id: "chat.demo", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "push.subscribe", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "push.remove", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "onboarding.phone-dismiss", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "chat.config", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "chat.mate-mint", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "chat.mate-follow", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "chat.mate-end", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "chat.mate-stop", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "chat.proposal", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "coordinator.proposal", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "chat.send", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "chat.file", domain: "chat", stage: "console", method: "POST", handle: post },
    { id: "chat.ack-send", domain: "chat", stage: "console", method: "POST", handle: post },
  ];
  return { registrations, get, post, chatFirstRun, phoneCard, chatProjectOf, beginLiveTurn, endLiveTurn, noteMate, takeMateNote, demoResultView, storeChatKey, forgetChatKey, sweepChatDrafts, runChatTurn, chatHomeOf, firstTasksFor, approverCandidateCount, evictOldestCandidate };
}
