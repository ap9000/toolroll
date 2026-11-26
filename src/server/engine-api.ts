/**
 * The engine API's handlers (solo-workbench plan v2, A0; contracts/engine-api.ts): the reads a terminal client and the
 * web share, and the one-time link redemption that gives a terminal client the local owner's session.
 *
 * Every read is a route row of its own (route-table.ts), admitted exactly as the page it mirrors before its handler
 * runs: a LiveSession window as the Live grid's own reads (/agents/live/<run>, the same code below), step cards and a
 * result's diff as the task page. A handler re-proves only what can change after admission (the task still in view,
 * the run still this person's to see), and reads nothing for a caller it refuses.
 *
 * A LiveSession is a run or a Flexible thread: the same window and cursor. While interactive agent threads are off
 * (flexible-available.ts, read at each request) the roads that start or answer refuse (not available) before anything is
 * looked up; a person's reads of their own past threads still answer (the list says threads are off). This console
 * opens no thread host for an install that never made a thread. With them on: a thread is its owner's only (the session re-read, the thread's creator, its project still
 * theirs, before the read and again after it), and an answer goes only through F2d's decide and send with the person's
 * own session (flexible-session.ts answerFlexibleRequest), naming the card digest they were shown. A new thread is a
 * person's yes to its terms card (flexible-start.ts), named by the card's key and proved as an approval's yes is; its
 * agent's network and storage come from this console's launcher (flexible-launcher.ts).
 */
import { inRehearsal } from "../rehearsal.js";
import { homedir } from "node:os";
import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { boardRunOf } from "../agent-board.js";
import { checkEngineResponse, DIFF_CONTEXT_MAX, ENGINE_API_VERSION, ENGINE_RESPONSES, engineContractDigest, linkRedemptionRequestSchema, type EngineResponseName, type LinkRedemption, type LiveSessionWindow, type LiveThreads } from "../contracts/engine-api.js";
import { CONSOLE_FORMS, readForm } from "../contracts/console-api.js";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { flexibleAvailable } from "../flexible-available.js";
import { laptopShipProblem } from "../flexible-laptop.js";
import { threadsStatusNote, tidyFlexibleSignIns } from "../flexible-sign-in.js";
import { FLEXIBLE_UNAVAILABLE } from "../flexible.js";
import { saveFlexibleBranch } from "../flexible-save.js";
import { admitFlexibleThreadOwner, answerFlexibleRequest, cancelFlexibleThreadShip, closeFlexibleSessions, closeFlexibleThread, continueFlexibleThread, flexibleThreadShipTerms, latestFlexibleShip, sendBackFlexibleThread, shipFlexibleThread, tidyEndedFlexibleThreads, flexibleThreadChangeOf, flexibleThreadEdited, flexibleThreadLiveOf, flexibleThreadsOf, FLEXIBLE_WAIT_MS, flexibleThreadsExist, flexibleWorkOpen, openFlexibleSessions,
  recoverFlexibleHolders, startFlexibleThread, settleFlexibleStops, tickFlexibleSessions, waitFlexibleThreadChange, flexibleThreadChanges, flexibleThreadTipOf, type FlexibleChoice, type FlexibleSessions } from "../flexible-session.js";
import { createFlexibleLauncher, type FlexibleLauncher } from "../flexible-launcher.js";
import { FLEXIBLE_NEXT_WORDS, flexibleReadiness, flexibleStartCard } from "../flexible-start.js";
import { summaryLines, type ApprovalSummary } from "../approval-summary.js";
import { termsOfLines } from "../fast-terms.js";
import { localActNow } from "../local-owner.js";
import { authenticateApprover, type AuthMethod } from "../scope.js";
import { defaultChainOf, installModeNow } from "../install-mode.js";
import { packageVersion } from "../monitoring.js";
import { readChildWindow, type ChildWindow } from "../live-children-read.js";
import { readMainWindow, type MainWindow } from "../live-main-read.js";
import { runLiveCommands, type Run } from "../store.js";
import { agentsReadOf, resultDiffContextOf, resultDiffFileOf, resultDiffOf, resultRunsOf, stepCardsOf, taskResultOf, threadDiffFileOf, threadDiffOf, type ThreadChanges } from "../engine-reads.js";
import { leadChatOf } from "../engine-chat.js";
import { remoteAllows } from "../operate-remote.js";
import { verifyApproverStanding } from "../principal.js";
import { admitRemoteTerminalRequest, isRemoteTerminalRequest, sendTerminalConnectionRefusal } from "../terminal-connection.js";
import { leadNameOf } from "../lead-identity.js";
import { NOT_STARTED_SESSION } from "./render-chat.js";
import type { EdgeContext, HandlerContext } from "./handler-context.js";
import { handlersOf } from "./handler-registry.js";
import type { PlanContractView, RevisionView } from "./render-tasks.js";
import { matchTaskPath, respond } from "./http.js";
import { rereadBrowser } from "./live.js";
import { admitLink, saveLinkSession, spendLink } from "./link-redemption.js";
import { agentInventoryOf } from "./welcome.js";
import type { ServerRuntime } from "./runtime.js";
import { SESSION_COOKIE, sessionWithinLifetime, type Who } from "./session.js";

type JsonResponse = Parameters<typeof respond>[0];
const json = (response: JsonResponse, status: number, value: unknown): void => respond(response, status, "application/json", JSON.stringify(value));
/** Sent checked against its contract (reported, never refused). */
const sendChecked = (response: JsonResponse, status: number, name: EngineResponseName, value: unknown): void => json(response, status, checkEngineResponse(name, value));
const refusal = (response: JsonResponse, status: number, error: string): void => sendChecked(response, status, "refusal", { error });

/** What one live read of a run comes to: refused (not found, the same answer for unseen and gone), off this computer,
 * or the window read. */
export type RunLiveRead = { ok: false } | { ok: true; run: Run; window: MainWindow | ChildWindow | null };

/**
 * One window of a run's live output, admitted as the Live grid's reads are (pages.ts agentsLiveRead calls this too): the
 * saved browser session still held (not just the cookie) and the run in view from its current row, before the read and
 * again after it, before a byte is sent; only this computer's runs have a file to read.
 */
export function readRunLive(runtime: Pick<ServerRuntime, "identify" | "sessions" | "store" | "taskRepoOf" | "runVisible" | "options" | "evidenceRoot"> & { clock?: () => Date },
  request: IncomingMessage, who: Who, runId: number, file: "main" | "sub", cursor: string | null, key: Buffer): RunLiveRead {
  const { store, options } = runtime;
  const clock = runtime.clock ?? (() => new Date());
  const allowed = (): boolean => {
    if (who.via === "cookie") {
      if (rereadBrowser(runtime, request, who) === null) return false;
      const run = store.getRun(runId);
      const repo = run === null ? null : runtime.taskRepoOf(run.taskRef);
      return run !== null && repo !== null && runtime.runVisible(run) && store.accountCanAccess(who.name, repo);
    }
    if (who.via === "bearer" && who.principal !== undefined && isRemoteTerminalRequest(request)) {
      if (!admitRemoteTerminalRequest(request, store, who.principal, clock).ok) return false;
      const run = store.getRun(runId);
      const repo = run === null ? null : runtime.taskRepoOf(run.taskRef);
      return run !== null && repo !== null && runtime.runVisible(run) && remoteAllows(store, who.principal, repo);
    }
    return false;
  };
  if (!allowed()) return { ok: false };
  const local = () => options.localRunner !== undefined && store.getRun(runId)?.runner === options.localRunner;
  if (!local()) return allowed() ? { ok: true, run: store.getRun(runId)!, window: null } : { ok: false };
  const read = { key, commands: runLiveCommands(store, runId) };
  const window = file === "sub" ? readChildWindow(runtime.evidenceRoot, runId, cursor, read) : readMainWindow(runtime.evidenceRoot, runId, cursor, read);
  // Re-proved after the read: a narrowed account, revoked token, or a run gone from view gets nothing it read.
  if (!allowed() || !local()) return { ok: false };
  return { ok: true, run: store.getRun(runId)!, window };
}

/** A live read's query: `file` (main or sub) and an optional `cursor`, nothing else; null when it asks for more. */
export function liveQueryOf(url: URL): { file: "main" | "sub"; cursor: string | null } | null {
  const file = url.searchParams.get("file") ?? "main";
  if ((file !== "main" && file !== "sub") || [...url.searchParams.keys()].some(key => key !== "file" && key !== "cursor")
    || url.searchParams.getAll("file").length > 1 || url.searchParams.getAll("cursor").length > 1) return null;
  return { file, cursor: url.searchParams.get("cursor") };
}

export function createEngineHandlers(runtime: ServerRuntime) {
  const { store, clock, evidenceRoot } = runtime;
  /** This console's key for LiveSession cursors: random, in memory only (a restart makes old cursors start over). */
  const cursorKey = randomBytes(32);

  /** The contract's digest, computed once per start (it changes only with the code). */
  let contract: string | null = null;
  /** GET /engine/hello: the handshake a client makes first: this build, the API version and the contract's digest. */
  async function hello(ctx: HandlerContext): Promise<void> {
    const { url, response } = ctx;
    if ([...url.searchParams.keys()].length > 0) return refusal(response, 400, "request");
    contract ??= engineContractDigest();
    const mode = installModeNow(store).mode;
    return sendChecked(response, 200, "hello", { version: ENGINE_API_VERSION, toolroll: packageVersion(), contract, responses: Object.keys(ENGINE_RESPONSES), mode, defaultChain: defaultChainOf(mode) });
  }

  /** GET /engine/agents: the coding agents on this computer, as the console's last detection saw them (its background
   * checks look; this read never starts a process), and who the first task goes to. Browser sessions only, like Live. */
  async function agents(ctx: HandlerContext): Promise<void> {
    const { url, who, response } = ctx;
    if (who.via !== "cookie") return refusal(response, 403, "session");
    if ([...url.searchParams.keys()].length > 0) return refusal(response, 400, "request");
    // The inventory policy /welcome shares (welcome.ts agentInventoryOf): each agent for an instance operator, who the
    // first task goes to for anyone else's session.
    const view = agentInventoryOf(who, store);
    return sendChecked(response, 200, "agents", agentsReadOf(runtime.localAgents, view === "full" ? "full" : "summary", view === "full" ? process.env["HOME"] ?? homedir() : null, threadsStatusNote(store, who.name)));
  }

  /** POST /engine/agents/check (the Agents screen's Check again): this computer's agent CLIs asked again through the same
   * bounded, non-spending status checks as Settings → Lead's Check now (at most every few seconds, waited for at most
   * 8 s), then the same answer as GET /engine/agents. A form post with the session's form token, so no link or prefetch
   * sets it off; a browser or terminal session only. */
  async function agentsCheck(ctx: HandlerContext): Promise<void> {
    const { who, response } = ctx;
    if (who.via !== "cookie") return refusal(response, 403, "session");
    if (Date.now() - runtime.leadRecheckedAt > 4_000) {
      runtime.leadRecheckedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([runtime.checkLocalAgents(true), new Promise<void>(done => { timer = setTimeout(done, 8_000); timer.unref?.(); })]).finally(() => clearTimeout(timer));
    }
    const view = agentInventoryOf(who, store);
    return sendChecked(response, 200, "agents", agentsReadOf(runtime.localAgents, view === "full" ? "full" : "summary", view === "full" ? process.env["HOME"] ?? homedir() : null, threadsStatusNote(store, who.name)));
  }

  /** GET /agents/live/run/<id>: a run's LiveSession window (browser sessions or admitted terminal-remote API tokens). */
  async function liveRun(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response } = ctx;
    const remote = who.via === "bearer" && who.principal !== undefined && isRemoteTerminalRequest(request);
    if (who.via !== "cookie" && !remote) return refusal(response, 403, "session");
    const query = liveQueryOf(url);
    if (query === null) return refusal(response, 400, "request");
    const runId = Number(url.pathname.slice("/agents/live/run/".length));
    const read = readRunLive(runtime, request, who, runId, query.file, query.cursor, cursorKey);
    if (!read.ok) {
      if (remote && who.via === "bearer" && who.principal !== undefined) {
        const check = admitRemoteTerminalRequest(request, store, who.principal, clock);
        if (!check.ok) return sendTerminalConnectionRefusal(request, response, check.status, check.error);
      }
      return refusal(response, 404, "run");
    }
    const ref = store.refForId(read.run.taskRef);
    const body: LiveSessionWindow = {
      version: ENGINE_API_VERSION,
      session: { kind: "run", id: read.run.id, task: ref !== null && ref.backend === "built-in" ? ref.externalId : null },
      // A repair is its build's own activity: its room is the build's (live.ts agent rooms).
      room: `agent:${boardRunOf(store, read.run.id)}`,
      live: read.run.finishedAt === null,
      file: query.file,
      window: read.window === null ? { ok: false, reason: "off" } : read.window.ok
        ? { ok: true, records: read.window.records, cursor: read.window.cursor, restarted: read.window.restarted, earlier: read.window.earlier,
          quarantined: read.window.quarantined, skipped: read.window.skipped, more: read.window.more }
        : { ok: false, reason: read.window.reason },
    };
    return sendChecked(response, 200, "liveSessionWindow", body);
  }

  /** This console's Flexible threads (flexible-session.ts): opened the first time interactive agent threads are on, or
   * at start when something of a thread may still run (so it can be stopped), and never while neither holds. Opened, the
   * holders a crashed console left behind are recovered once (launches, then answers), and the console's upkeep tick
   * expires answers past their deadlines and, with threads turned off, stops every thread this host holds (`upkeep`). */
  let flexible: FlexibleSessions | null = null;
  /** This console's launcher for a thread's network and storage (flexible-launcher.ts), made with the host. Its proxies
   * close with their launches, and all of them when the console stops (`close`, below). */
  let launcher: FlexibleLauncher | null = null;
  const openHost = (): FlexibleSessions | null => {
    // A rehearsal never opens the copy's threads: opening recovers their holders and stops their launches.
    if (inRehearsal()) return null;
    if (flexible !== null) return flexible;
    const opened = openFlexibleSessions(store);
    if (!opened.ok) return null;
    flexible = opened.sessions;
    void recoverFlexibleHolders(store, opened.sessions).catch(() => { /* the next start tries again */ });
    const made = createFlexibleLauncher(store);
    launcher = "prepare" in made ? made : null;
    return flexible;
  };
  if (flexibleAvailable(store) || flexibleWorkOpen(store)) openHost();
  /** The host for a road that starts or answers: null (the road refuses, before anything is looked up) while interactive
   * agent threads are off, read now. */
  const threadsOn = (): FlexibleSessions | null => flexibleAvailable(store) ? openHost() : null;
  /** The host for a person's read of their own threads, whatever the switch says: null only while no thread was ever
   * made here (nothing to read, and no host opened for it). */
  const threadsRead = (): FlexibleSessions | null => flexible ?? (flexibleAvailable(store) || flexibleThreadsExist(store) ? openHost() : null);
  /** Threads turned off are being stopped (one pass at a time). */
  let stopping = false;
  /** People's retired sign-ins are being tidied (one pass at a time). */
  let tidying = false;
  /** Ended threads' copies are being tidied (one pass at a time). */
  let tidyingEnded = false;
  /** A thread `who` owns, ready, in a project still theirs, read again from their saved session: its project, or null. */
  const ownedThread = (request: IncomingMessage, who: Who & { via: "cookie" }, sessions: FlexibleSessions, thread: string): string | null => {
    if (rereadBrowser(runtime, request, who) === null) return null;
    const admitted = admitFlexibleThreadOwner(store, sessions, { thread, viewer: { name: who.name }, canAccess: repo => store.accountCanAccess(who.name, repo) });
    return admitted.ok ? admitted.repo : null;
  };
  /** An act's answer as data (`{ outcome, words }`): a thread's acts are a terminal's or an API client's, never a page's. */
  const acted = (response: JsonResponse, status: number, outcome: "done" | "refused", words: string, next?: string): void => json(response, status, next === undefined ? { outcome, words } : { outcome, words, next });
  /** An act's answer that carries the exact command its words name (`command`): a terminal shows it whole, on its own line,
   * to copy (everyday-9 C2). Only commands Toolroll wrote itself, from its own records; none when none could be written. */
  const actedWithCommand = (response: JsonResponse, status: number, outcome: "done" | "refused", words: string, command: string | null): void =>
    json(response, status, command === null ? { outcome, words } : { outcome, words, command });

  /** GET /agents/live/thread/<id>[?file=&cursor=&known=]: a Flexible thread's LiveSession window and its facts, its
   * owner's only; `known` (the facts' version the client holds) leaves unchanged facts out. A read: answered while
   * interactive agent threads are off too (flexible-available.ts), under the same owner checks. */
  async function liveThread(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response } = ctx;
    if (who.via !== "cookie") return refusal(response, 403, "session");
    const flexible = threadsRead();
    if (flexible === null) return refusal(response, 404, "thread");
    const known = url.searchParams.get("known"), wait = url.searchParams.get("wait");
    const plain = new URL(url.href);
    plain.searchParams.delete("known");
    plain.searchParams.delete("wait");
    const query = url.searchParams.getAll("known").length > 1 || (known !== null && !/^[0-9a-f]{16}$/.test(known))
      || url.searchParams.getAll("wait").length > 1 || (wait !== null && (wait !== "1" || known === null || !url.searchParams.has("cursor"))) ? null : liveQueryOf(plain);
    if (query === null) return refusal(response, 400, "request");
    const id = url.pathname.slice("/agents/live/thread/".length);
    // Admitted before the read and again after it: someone else's thread, or one gone from view, gets nothing read.
    if (ownedThread(request, who, flexible, id) === null) return refusal(response, 404, "thread");
    // `wait=1` (a client holding the facts' version and a cursor): when nothing it shows moved, the read waits for the
    // thread's next change on this host (or FLEXIBLE_WAIT_MS, or the client going away), then reads again under the same
    // checks. The change count is taken before the first read, so a change in between wakes it at once.
    const since = flexibleThreadChangeOf(flexible, { thread: id });
    let read = flexibleThreadLiveOf(store, flexible, { thread: id, viewer: { name: who.name }, file: query.file, cursor: query.cursor });
    if (!read.ok || ownedThread(request, who, flexible, id) === null) return refusal(response, 404, "thread");
    if (wait === "1" && since.ok && read.facts.version === known && read.window.ok && read.window.records.length === 0 && !read.window.restarted && !read.window.more) {
      const waited = waitFlexibleThreadChange(flexible, { thread: id, since: since.change, ms: FLEXIBLE_WAIT_MS, abandoned: stop => { response.once("close", stop); } });
      if ("then" in waited) await waited;
      if (response.destroyed || response.writableEnded) return;
      if (ownedThread(request, who, flexible, id) === null) return refusal(response, 404, "thread");
      read = flexibleThreadLiveOf(store, flexible, { thread: id, viewer: { name: who.name }, file: query.file, cursor: query.cursor });
      if (!read.ok || ownedThread(request, who, flexible, id) === null) return refusal(response, 404, "thread");
    }
    const body: LiveSessionWindow = { version: ENGINE_API_VERSION, session: { kind: "thread", id, task: null }, room: `thread:${id}`, live: read.live, file: query.file, window: read.window,
      ...(known === read.facts.version ? {} : { thread: read.facts }) };
    return sendChecked(response, 200, "liveSessionWindow", body);
  }

  /** The last read of each thread's changes, by the commit it read: a file read of the same commit reuses it. */
  const changesRead = new Map<string, { tip: string | null; changes: ThreadChanges }>();
  async function threadChanges(id: string): Promise<ThreadChanges> {
    const tip = flexibleThreadTipOf(store, id);
    const held = changesRead.get(id);
    if (held !== undefined && tip !== null && held.tip === tip) return held.changes;
    const read = await flexibleThreadChanges(store, { thread: id });
    if (changesRead.size >= 32) changesRead.delete(changesRead.keys().next().value!);
    // Only a read that names the commit it read is kept for the next file read of that same commit.
    if (read.tip !== null && read.tip === tip) changesRead.set(id, { tip: read.tip, changes: read.changes });
    return read.changes;
  }

  /** GET /agents/live/thread/<id>/diff[?file=<n>]: what a thread changed since it started (its committed work against the
   * commit it started from, read in a quarantine: flexible-import.ts readFlexibleChanges), as a result's changes are
   * shown: its files, or one file's hunks. Cleaned, key-shaped lines hidden. Its owner's only, admitted before and after
   * the read; a read, answered while interactive agent threads are off too. */
  async function liveThreadDiff(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response } = ctx;
    if (who.via !== "cookie") return refusal(response, 403, "session");
    const params = url.searchParams, fileParam = params.get("file");
    if ([...params.keys()].some(key => key !== "file") || params.getAll("file").length > 1 || (fileParam !== null && !/^(0|[1-9][0-9]{0,5})$/.test(fileParam))) return refusal(response, 400, "request");
    const flexible = threadsRead();
    if (flexible === null) return refusal(response, 404, "thread");
    const id = url.pathname.slice("/agents/live/thread/".length, -"/diff".length);
    if (ownedThread(request, who, flexible, id) === null) return refusal(response, 404, "thread");
    const changes = await threadChanges(id);
    const turn = Number(store.handle.prepare("SELECT max(seq) AS seq FROM thread_turn WHERE thread = ? AND status <> 'withdrawn'").get(id)?.["seq"] ?? 0);
    if (ownedThread(request, who, flexible, id) === null) return refusal(response, 404, "thread");
    if (fileParam === null) return sendChecked(response, 200, "resultDiff", threadDiffOf(id, turn, changes, { edited: flexibleThreadEdited(flexible, { thread: id }) }));
    const one = threadDiffFileOf(id, turn, changes, Number(fileParam));
    return one === null ? refusal(response, 404, "file") : sendChecked(response, 200, "resultDiffFile", one);
  }

  /** GET /agents/live/threads: the person's own Flexible threads, as the work list shows them, and whether interactive
   * agent threads are on (`on`): a read, answered while they are off too (with the threads already made). */
  async function liveThreads(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response } = ctx;
    if (who.via !== "cookie") return refusal(response, 403, "session");
    if ([...url.searchParams.keys()].length > 0) return refusal(response, 400, "request");
    if (rereadBrowser(runtime, request, who) === null) return refusal(response, 403, "session");
    const on = flexibleAvailable(store);
    const flexible = threadsRead();
    if (flexible === null) return sendChecked(response, 200, "liveThreads", { version: ENGINE_API_VERSION, on, threads: [] } satisfies LiveThreads);
    const read = flexibleThreadsOf(store, flexible, { owner: who.name });
    if (!read.ok) return refusal(response, 404, "thread");
    const body: LiveThreads = { version: ENGINE_API_VERSION, on, threads: read.threads.filter(one => store.accountCanAccess(who.name, one.repo))
      .map(one => ({ id: one.id, title: one.title, project: one.project, level: one.level, live: one.live, waiting: one.waiting, costUsd: one.turn?.costUsd ?? null,
        turn: one.turn?.status ?? null, ended: one.ended !== undefined, stopPending: one.stopPending, ship: one.ship?.state ?? null, turnSeq: one.turn?.seq ?? null,
        shipSeq: one.ship?.seq ?? null })) };
    return sendChecked(response, 200, "liveThreads", body);
  }

  /** POST /agents/live/thread/<id>/answer: the thread's owner answers one request of its agent, naming the request, the
   * card digest they were shown, and their choice; decided and sent only through F2d with their own session. Refused
   * while interactive agent threads are off. */
  async function threadAnswer(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, posted } = ctx;
    const flexible = threadsOn();
    if (flexible === null) return acted(response, 404, "refused", FLEXIBLE_UNAVAILABLE);
    if (who.via !== "cookie") return acted(response, 403, "refused", "Only a person signed in here can answer an agent.");
    const id = url.pathname.slice("/agents/live/thread/".length, -"/answer".length);
    if (ownedThread(request, who, flexible, id) === null) return acted(response, 404, "refused", "There's no such thread.");
    const body = readForm(posted, CONSOLE_FORMS.threadAnswer);
    const decision = body.get("decision"), question = body.get("question"), answer = body.get("answer");
    const choice: FlexibleChoice | null = decision === "accept" || decision === "decline" ? { decision } : question !== null && answer !== null && decision === null ? { question, answer } : null;
    if (choice === null) return acted(response, 400, "refused", "That answer isn't one Toolroll can read. Nothing was sent.");
    // This very session, bound to the decision: its saved authority (the session row, the account's standing at the
    // session's generation, the thread's project) is read again inside F2d's decision and its final attempt.
    // The saved row as it stands now, compared whole with the one admitted here: the same row (its id hash), account,
    // generation and role, the same immutable bindings (authority, local-mode generation, key epoch and key hash,
    // creation), still held in memory, within its lifetime (an expired row that wasn't deleted yet refuses), and the
    // account's standing and the thread's project unchanged.
    const held = sessionHeld(who, flexible, id);
    if (held === null) return acted(response, 403, "refused", "Only a person signed in here can answer an agent.");
    const done = await answerFlexibleRequest(store, flexible, { thread: id, request: body.get("request") ?? "", shownDigest: body.get("card") ?? "",
      by: { kind: "person", name: who.name, generation: who.session.generation }, choice, held });
    return done.ok ? acted(response, 200, "done", "Sent to the agent.") : acted(response, 409, "refused", done.message);
  }

  /**
   * POST /agents/live/thread: a new thread in a project of the person's. Starting one is a person's yes to exact terms
   * (flexible-start.ts): posted without `terms`, it answers the terms card (`{ outcome: "thread-terms", key, terms }`)
   * and starts nothing; posted with the card's key, the card is made again now and the thread starts only if its key is
   * exactly the one posted (anything that moved in between is a stale card, refused). The yes is proved as an approval's
   * is (scope.ts authenticateApprover: a password typed now, or, where the existing rules let it stand in, the person's
   * own session in a solo or Passwordless install, or the local owner's own act at this computer); the thread's first
   * launch is held to the network the card showed. Refused while interactive agent threads are off. Claude Code only for
   * now: a thread asked for with any other agent is refused ("Codex threads come later").
   */
  async function threadStart(ctx: HandlerContext): Promise<void> {
    const { who, request, response, posted } = ctx;
    const flexible = threadsOn();
    if (flexible === null) return acted(response, 404, "refused", FLEXIBLE_UNAVAILABLE, store.isInstanceOperator(who.name) ? "turn-on" : "ask-operator");
    if (who.via !== "cookie" || rereadBrowser(runtime, request, who) === null) return acted(response, 403, "refused", "Only a person signed in here can start a thread.");
    if (launcher === null) return acted(response, 409, "refused", "This console can't give a thread its network, so no thread was started.");
    const body = readForm(posted, CONSOLE_FORMS.threadStart);
    const agent = body.get("agent");
    if (agent !== null && agent !== "claude") return acted(response, 409, "refused", FLEXIBLE_CLAUDE_ONLY);
    const repo = body.get("repo") ?? "", message = body.get("message") ?? "";
    if (!store.accountCanAccess(who.name, repo)) return acted(response, 403, "refused", "That project is outside your access.");
    const by = { name: who.name, generation: who.session.generation };
    // What's still missing, in order (on → your own sign-in → the project's terms), named so the terminal can open it.
    const next = flexibleReadiness(store, by, repo);
    if (next !== null) return acted(response, 409, "refused", FLEXIBLE_NEXT_WORDS[next], next);
    const made = flexibleStartCard(store, { repo, by, model: body.get("model"), message });
    if (!made.ok) return acted(response, 409, "refused", made.message);
    const card = made.card;
    const shown = body.get("terms");
    if (shown === null || shown === "") {
      const rows = [...card.summary.decisions, ...card.summary.differs].map(row => ({ label: row.label, words: row.words, lines: row.lines ?? [] }));
      return json(response, 200, { outcome: "thread-terms", key: card.summary.key, terms: rows, notes: card.summary.warnings.map(note => note.words), lines: summaryLines(card.summary) });
    }
    if (shown !== card.summary.key) return acted(response, 409, "refused", "The terms changed since they were shown. Read them again before starting. Nothing was started.");
    const proved = authenticateApprover(store, who.name, body.get("password") ?? "", repo);
    if (!proved.ok || !START_PROOFS.has(proved.method)) return acted(response, 403, "refused", "Starting a thread needs your password here. Nothing was started.");
    // The local owner's own act, exactly this one, still standing (re-read now).
    if (proved.method === "local-owner" && localActNow(store, "start-thread") === null) return acted(response, 403, "refused", "Starting a thread needs your password here. Nothing was started.");
    const started = await startFlexibleThread(store, flexible, { repo, by, digest: card.digest, message, model: card.model, billing: card.billing, startKey: card.summary.key, launcher,
      freshProof: FRESH_PROOFS.has(proved.method), expectNetwork: card.network });
    if (!started.ok) return acted(response, 409, "refused", started.message);
    // The thread itself, so the terminal selects it (the same thread again for a replayed start).
    return json(response, 200, { outcome: "done", words: started.replayed ? "This thread already started." : "The thread started.", thread: started.thread });
  }

  /** The task an address names, in view as its page would be (the route admitted its project already). */
  function familyAt(url: URL, verb: string) {
    const task = matchTaskPath(url.pathname, `/${verb}$`);
    const family = task === null ? null : runtime.familyOf(task.taskId);
    return family === null || family.problem !== null ? null : family;
  }

  /** GET /t/<task>/steps: the task's step cards. */
  async function taskSteps(ctx: HandlerContext): Promise<void> {
    const { url, request, response, who } = ctx;
    // One query key is known: `choices=1` (the model picker's read); anything else is refused as before.
    const keys = [...url.searchParams.keys()];
    const withChoices = url.searchParams.get("choices") === "1";
    if (keys.some(key => key !== "choices") || keys.length > 1 || (keys.length === 1 && !withChoices)) return refusal(response, 400, "request");
    const family = familyAt(url, "steps");
    if (family === null) return refusal(response, 404, "task");
    const payload = stepCardsOf({ store, family, now: clock(), access: runtime.workAccess(), evidenceRoot, viewer: who.name, withChoices });
    if (who.via === "bearer" && who.principal !== undefined && isRemoteTerminalRequest(request)) {
      const after = admitRemoteTerminalRequest(request, store, who.principal, clock);
      if (!after.ok) return sendTerminalConnectionRefusal(request, response, after.status, after.error);
      if (familyAt(url, "steps") === null) return refusal(response, 404, "task");
    }
    return sendChecked(response, 200, "stepCards", payload);
  }

  /** GET /t/<task>/approval: the approval waiting on the task's current version, as its page's approval form carries it
   * (contracts/engine-api.ts approvalCardSchema). A terminal client's session presenting its own key only: this read
   * mints, so a cookie alone (a browser, another port) is never enough; browser sessions use the task page. The page's
   * own assembly (taskViewData) decides whether a yes can be taken at all; nothing is minted for a yes this session
   * couldn't give here (it needs a password: the browser asks), and a card read again holds the same nonce
   * (heldApprovalNonce), so reads never grow the shared pool. */
  async function taskApproval(ctx: HandlerContext): Promise<void> {
    const { url, response, who, request } = ctx;
    if (who.via !== "cookie") return refusal(response, 403, "session");
    if (!runtime.browserKeys.terminalKeyed(who, request)) return refusal(response, 403, "key");
    const paramKeys = [...url.searchParams.keys()];
    const allowStepUp = paramKeys.length === 1 && paramKeys[0] === "stepup" && url.searchParams.get("stepup") === "1";
    if (paramKeys.length > 0 && !allowStepUp) return refusal(response, 400, "request");
    const family = familyAt(url, "approval");
    if (family === null) return refusal(response, 404, "task");
    const taskId = family.current.id;
    const none = (problem: string) => sendChecked(response, 200, "approvalCard", { version: ENGINE_API_VERSION, task: taskId, key: null, digest: null, nonce: null, terms: [], problem });
    const waits = (view: NonNullable<ReturnType<typeof runtime.taskViewData>>) => view.nonce !== "" && view.approvalDigest != null && view.approvalSummary != null;
    // Read without minting (the page's own conditions say whether a yes can be taken); only a yes this session can give
    // here gets a nonce, the one held for this person, task and digest if there is one. Clients with native password
    // step-up UI (the Mac app) pass ?stepup=1 to still receive terms, digest, and a single-use nonce while POST /approve
    // enforces the exact password/freshness/seal rules unchanged.
    const view = runtime.taskViewData(taskId, who, null, { mintNonce: false });
    if (view === null) return refusal(response, 404, "task");
    if (!waits(view)) return none(NOTHING_TO_APPROVE);
    if (view.approvalLocal?.eligible !== true) {
      if (!allowStepUp) {
        return none(`${view.approvalLocal?.eligible === false ? `${view.approvalLocal.message} ` : "This approval needs your password. "}${APPROVE_IN_BROWSER}`);
      }
      const passwordSet = runtime.store.accountOf(who.name)?.passwordSet === true;
      const problem = !passwordSet
        ? "Set a password to approve this."
        : view.approvalFresh !== null
          ? null
          : "Enter your password to approve.";
      return sendChecked(response, 200, "approvalCard", {
        version: ENGINE_API_VERSION,
        task: taskId,
        key: view.approvalSummary!.key,
        digest: view.approvalDigest,
        nonce: runtime.heldApprovalNonce(who.name, taskId, view.approvalDigest!),
        terms: approvalTermsOf(view.approvalSummary!, view.planContract ?? null, view.revision ?? null),
        problem,
      });
    }
    return sendChecked(response, 200, "approvalCard", { version: ENGINE_API_VERSION, task: taskId, key: view.approvalSummary!.key, digest: view.approvalDigest,
      nonce: runtime.heldApprovalNonce(who.name, taskId, view.approvalDigest!), terms: approvalTermsOf(view.approvalSummary!, view.planContract ?? null, view.revision ?? null), problem: null });
  }

  /** GET /t/<task>/diff[?run=<id>[&file=<n>[&from=<line>&count=<n>]]]: the result's files, one file's hunks (which needs
   * the run it is of), or at most DIFF_CONTEXT_MAX lines of that file around them (which need the file). */
  async function taskDiff(ctx: HandlerContext): Promise<void> {
    const { url, request, response, who } = ctx;
    const params = url.searchParams, runParam = params.get("run"), fileParam = params.get("file"), fromParam = params.get("from"), countParam = params.get("count");
    if ([...params.keys()].some(key => key !== "run" && key !== "file" && key !== "from" && key !== "count")
      || ["run", "file", "from", "count"].some(key => params.getAll(key).length > 1)
      || (runParam !== null && !/^[1-9][0-9]{0,14}$/.test(runParam)) || (fileParam !== null && !/^(0|[1-9][0-9]{0,5})$/.test(fileParam))
      || (fileParam !== null && runParam === null)
      || (fromParam === null) !== (countParam === null) || (fromParam !== null && fileParam === null)
      || (fromParam !== null && !/^[1-9][0-9]{0,6}$/.test(fromParam)) || (countParam !== null && (!/^[1-9][0-9]{0,2}$/.test(countParam) || Number(countParam) > DIFF_CONTEXT_MAX))) {
      return refusal(response, 400, "request");
    }
    const family = familyAt(url, "diff");
    if (family === null) return refusal(response, 404, "task");
    // Only the family's own results, each still in view from its current row.
    const results = resultRunsOf(store, family).filter(run => runtime.runVisible(run));
    const run = runParam === null ? results[0] ?? null : results.find(one => one.id === Number(runParam)) ?? null;
    if (runParam !== null && run === null) return refusal(response, 404, "run");
    const remoteRecheck = (): boolean => {
      if (!(who.via === "bearer" && who.principal !== undefined && isRemoteTerminalRequest(request))) return true;
      const after = admitRemoteTerminalRequest(request, store, who.principal, clock);
      if (!after.ok) { sendTerminalConnectionRefusal(request, response, after.status, after.error); return false; }
      if (familyAt(url, "diff") === null) { refusal(response, 404, "task"); return false; }
      return true;
    };
    if (fileParam === null) {
      const payload = resultDiffOf(store, evidenceRoot, family.root.id, run);
      return remoteRecheck() ? sendChecked(response, 200, "resultDiff", payload) : undefined;
    }
    if (fromParam !== null && countParam !== null) {
      // The project's repository as Toolroll records it for this run (never a path the checkout names).
      const context = resultDiffContextOf(store, evidenceRoot, family.root.id, run!, Number(fileParam), Number(fromParam), Number(countParam), runtime.taskRepoOf(run!.taskRef));
      if (!remoteRecheck()) return;
      return context === null ? refusal(response, 404, "file") : sendChecked(response, 200, "resultDiffContext", context);
    }
    const one = resultDiffFileOf(store, evidenceRoot, family.root.id, run!, Number(fileParam));
    if (!remoteRecheck()) return;
    return one === null ? refusal(response, 404, "file") : sendChecked(response, 200, "resultDiffFile", one);
  }

  /** GET /t/<task>/result[?run=<id>]: the task's verified human-readable result (scout report, builder handoff, and screenshots). */
  async function taskResult(ctx: HandlerContext): Promise<void> {
    const { url, request, response, who } = ctx;
    const params = url.searchParams, runParam = params.get("run");
    if ([...params.keys()].some(key => key !== "run")
      || params.getAll("run").length > 1
      || (runParam !== null && !/^[1-9][0-9]{0,14}$/.test(runParam))) {
      return refusal(response, 400, "request");
    }
    const family = familyAt(url, "result");
    if (family === null) return refusal(response, 404, "task");
    const results = resultRunsOf(store, family).filter(run => runtime.runVisible(run));
    const run = runParam === null ? results[0] ?? null : results.find(one => one.id === Number(runParam)) ?? null;
    if (runParam !== null && run === null) return refusal(response, 404, "run");
    const payload = taskResultOf(store, evidenceRoot, family, run);
    if (who.via === "bearer" && who.principal !== undefined && isRemoteTerminalRequest(request)) {
      const after = admitRemoteTerminalRequest(request, store, who.principal, clock);
      if (!after.ok) return sendTerminalConnectionRefusal(request, response, after.status, after.error);
      if (familyAt(url, "result") === null) return refusal(response, 404, "task");
    }
    return sendChecked(response, 200, "taskResult", payload);
  }

  /**
   * POST /login/once: the local owner's one-time link, redeemed for a terminal client. The same link the console's
   * socket mints (`toolroll open`'s link verb), the same map and the same local-owner session as GET /login/once/<code>,
   * answered as JSON with the cookie, the form token and the mutation key for that client's memory.
   *
   * - One time: the code is spent the moment it is presented, before any other check, whatever happens next, by either
   *   road; a used or expired code is refused (410). A stolen used link is worthless.
   * - Never a browser's: a request with an Origin or any Sec-Fetch header is refused, and the request must be a JSON POST
   *   carrying `x-toolroll-client: terminal` — headers a cross-origin page can't send without a CORS preflight, which
   *   this console never answers. The code rides in the body, never a URL.
   * - Local owner only, from this computer only, at the console's own loopback address only: never over a forwarded,
   *   remote or tailnet road. Local mode is read again in the same transaction the session is saved in, at the link's
   *   generations.
   * - Always keyed: the session gets a mutation key bound to this console start even where a browser gets none (a
   *   tailnet machine, an --allow-host install), and every change it makes must present it (mutation-key.ts keyed).
   * - No-store, no referrer; nothing here logs the code, the cookie or the key (the ledger notes the sign-in only).
   */
  async function redeemLink(ctx: EdgeContext): Promise<void> {
    const { request, response } = ctx;
    response.setHeader("Pragma", "no-cache");
    const raw = await bodyOf(request, 1024);
    let code: string | null = null;
    if (raw !== null) { try { const read = linkRedemptionRequestSchema.safeParse(JSON.parse(raw)); code = read.success ? read.data.code : null; } catch { code = null; } }
    // The one admission both link roads share (link-redemption.ts), the spend first, whatever happens next.
    const held = spendLink(runtime, code);
    const refused = (status: number, error: string, why?: string): void => {
      if (why !== undefined && held !== undefined) runtime.recordSignIn(held.account, "sign-in refused", "one-time link (terminal)", why);
      return refusal(response, status, error);
    };
    // Never a browser's: these come before the shared admission, and the link is already spent.
    const headers = request.headers;
    if (headers.origin !== undefined || Object.keys(headers).some(name => name.startsWith("sec-fetch-"))) return refused(403, "browser", "opened by a browser page");
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(String(headers["content-type"] ?? "")) || headers["x-toolroll-client"] !== "terminal") return refused(400, "request");
    if (code === null) return refused(400, "request");
    const admitted = admitLink(runtime, request, held, "terminal");
    if (!admitted.ok) return refusal(response, admitted.refusal.status, admitted.refusal.why);
    const fields: { keyEpoch: string | null; keyHash: string | null } = { keyEpoch: null, keyHash: null };
    // Its key, always (a tailnet machine's included, where a browser gets none): the cookie alone, which any server on
    // another port of this computer receives, never acts for it. Only at this console's own loopback address.
    const key = runtime.browserKeys.issueForClient(fields, request);
    if (key === null) return refused(403, "host", "not this console's own address");
    const id = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
    if (!saveLinkSession(runtime, request, admitted.held, "terminal", { id, csrf, keys: fields })) return refusal(response, 410, "used");
    const body: LinkRedemption = { version: ENGINE_API_VERSION, account: admitted.held.account, cookie: { name: SESSION_COOKIE, value: id }, csrf, key, epoch: runtime.keyEpoch,
      passwordSet: runtime.store.accountOf(admitted.held.account)?.passwordSet === true };
    return sendChecked(response, 200, "linkRedemption", body);
  }

  // ---- threads for everyday use (threads-everyday S4/S5), kept after the reviewed handlers above ----

  /** This very session, as a check run again later (inside a decision's or an admission's own transaction): the saved row
   * as it stands then, compared whole with the one admitted now: the same row (its id hash), account, generation and
   * role, the same immutable bindings (authority, local-mode generation, key epoch and key hash, creation), still held
   * in memory, within its lifetime (an expired row that wasn't deleted yet refuses), and the account's standing and the
   * thread's project unchanged. Null when the session isn't saved here at all. */
  const sessionHeld = (who: Who & { via: "cookie" }, flexible: FlexibleSessions, id: string): (() => boolean) | null => {
    const sessionHash = runtime.sessions.hashOf(who.session);
    const admitted = sessionHash === null ? null : store.webSession(sessionHash);
    if (admitted === null || admitted.account !== who.name) return null;
    return (): boolean => {
      const saved = store.webSession(admitted.idHash), account = store.accountOf(who.name);
      return saved !== null && saved.idHash === admitted.idHash && saved.account === admitted.account && saved.generation === admitted.generation && saved.role === admitted.role
        && saved.authority === admitted.authority && saved.localGeneration === admitted.localGeneration && saved.keyEpoch === admitted.keyEpoch && saved.keyHash === admitted.keyHash
        && saved.createdAt === admitted.createdAt && sessionWithinLifetime(saved, Date.now()) && runtime.sessions.holds(who.session)
        && account !== null && account.revokedAt === null && account.generation === saved.generation && account.generation === who.session.generation && account.role === saved.role
        && admitFlexibleThreadOwner(store, flexible, { thread: id, viewer: { name: who.name }, canAccess: repo => store.accountCanAccess(who.name, repo) }).ok;
    };
  };
  /**
   * POST /agents/live/thread/<id>/turn: Reply. The thread's owner sends its agent their next message (`message`), named
   * by `key` (32 hex, the client's: the same key again never takes a second turn). Proved as a start is (a password typed
   * now, or where the rules let it stand in, the person's own session on a solo or Passwordless install, or the local
   * owner's own act `reply-thread`); their session is re-read inside the admission's own transaction. Refused while
   * interactive agent threads are off.
   */
  async function threadTurn(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, posted } = ctx;
    const flexible = threadsOn();
    if (flexible === null) return acted(response, 404, "refused", FLEXIBLE_UNAVAILABLE);
    if (who.via !== "cookie" || rereadBrowser(runtime, request, who) === null) return acted(response, 403, "refused", "Only a person signed in here can reply to a thread.");
    const id = url.pathname.slice("/agents/live/thread/".length, -"/turn".length);
    const repo = ownedThread(request, who, flexible, id);
    if (repo === null) return acted(response, 404, "refused", "There's no such thread.");
    if (launcher === null) return acted(response, 409, "refused", "This console can't give a thread its network, so nothing was sent.");
    const body = readForm(posted, CONSOLE_FORMS.threadTurn);
    const message = body.get("message") ?? "", key = body.get("key") ?? "";
    if (message.trim() === "" || !/^[0-9a-f]{32}$/.test(key)) return acted(response, 400, "refused", "That reply isn't one Toolroll can read. Nothing was sent.");
    const proved = authenticateApprover(store, who.name, body.get("password") ?? "", repo);
    if (!proved.ok || !START_PROOFS.has(proved.method)) return acted(response, 403, "refused", "Replying here needs your password. Nothing was sent.");
    if (proved.method === "local-owner" && localActNow(store, "reply-thread") === null) return acted(response, 403, "refused", "Replying here needs your password. Nothing was sent.");
    const held = sessionHeld(who, flexible, id);
    if (held === null) return acted(response, 403, "refused", "Only a person signed in here can reply to a thread.");
    const sent = await continueFlexibleThread(store, flexible, { thread: id, by: { name: who.name, generation: who.session.generation }, message, key, freshProof: FRESH_PROOFS.has(proved.method),
      held, launcher });
    if (!sent.ok) return acted(response, 409, "refused", sent.message);
    // A resend after an attempt that never reached the agent says so, with why that one ended.
    const again = sent.resent === undefined ? "" : `Your earlier send (turn ${sent.resent.seq}) never reached the agent${sent.resent.detail === null ? "" : ` (${sent.resent.detail.slice(0, 200)})`}, so it was sent again. `;
    return json(response, 200, { outcome: "done", words: again + (sent.replayed ? "That reply was already sent." : `Sent. Turn ${sent.seq} started; the agent has the conversation so far.`),
      turn: sent.turn });
  }

  /**
   * POST /agents/live/thread/<id>/stop and /end: the thread's owner stops its agent's turn (the thread stays open) or
   * ends the thread (final; its work can still be shipped). Each only narrows: their own session (re-read), no
   * password, and a local owner's own act (`stop-thread`, `end-thread`). Answered while interactive agent threads are
   * off too: turning them off never stops anyone stopping or ending a thread.
   */
  const threadClose = (act: "stop" | "end") => async (ctx: HandlerContext): Promise<void> => {
    const { url, who, request, response } = ctx;
    const flexible = threadsRead();
    if (flexible === null) return acted(response, 404, "refused", "There's no such thread.");
    if (who.via !== "cookie" || rereadBrowser(runtime, request, who) === null) return acted(response, 403, "refused", "Only a person signed in here can do that.");
    const id = url.pathname.slice("/agents/live/thread/".length, -`/${act}`.length);
    if (ownedThread(request, who, flexible, id) === null) return acted(response, 404, "refused", "There's no such thread.");
    if (who.authority === "local-owner" && localActNow(store, act === "end" ? "end-thread" : "stop-thread") === null) return acted(response, 403, "refused", "Sign in with your password to do this.");
    const held = sessionHeld(who, flexible, id);
    if (held === null || !held()) return acted(response, 403, "refused", "Only a person signed in here can do that.");
    const done = await closeFlexibleThread(store, flexible, { thread: id, by: { name: who.name, generation: who.session.generation }, act });
    if (!done.ok) return acted(response, 409, "refused", done.message);
    const words = act === "end"
      ? done.already ? "This thread had already ended." : done.stopPending ? "Ended. Stopping its agent…" : "Ended. You can still ship its work."
      : done.stopPending ? "Stopping its agent…" : "Stopped. Reply to go on.";
    return acted(response, 200, "done", words);
  };

  /**
   * POST /agents/live/thread/<id>/ship: Ship. Posted without `terms` it answers the exact terms a Ship would sign now
   * (`{ outcome: "ship-terms", key, digest, lines, laptop, command }`) and does nothing. Posted with the terms' key and
   * digest it presses, only on the laptop road (the owner's D1): this computer's local owner, in their live session, with
   * the exact act `ship-thread`, on an install where nobody has a password (flexible-laptop.ts, read again at every step
   * that acts on it). Anywhere else Ship takes a password typed now, which this road never takes: it answers the command
   * that does (`toolroll thread ship <id> --key <key>`, a hidden password prompt). The press's own contract is
   * flexible-ship.ts shipFlexible, unchanged. Its terms and press never check the switch (arming does, inside).
   */
  async function threadShip(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, posted } = ctx;
    const flexible = threadsRead();
    if (flexible === null) return acted(response, 404, "refused", "There's no such thread.");
    if (who.via !== "cookie" || rereadBrowser(runtime, request, who) === null) return acted(response, 403, "refused", "Only a person signed in here can ship a thread's work.");
    const id = url.pathname.slice("/agents/live/thread/".length, -"/ship".length);
    if (ownedThread(request, who, flexible, id) === null) return acted(response, 404, "refused", "There's no such thread.");
    const by = { name: who.name, generation: who.session.generation };
    const shown = await flexibleThreadShipTerms(store, { thread: id, by });
    // A project that can't take a Ship: its words offer Save as branch, whose command goes with them.
    if (!shown.ok) return actedWithCommand(response, 409, "refused", shown.message, shown.reason === "no-check" || shown.reason === "no-publishing" ? `toolroll thread save ${id.slice(0, 8)}` : null);
    const laptop = who.authority === "local-owner" && who.session.localGeneration !== null
      && laptopShipProblem(store, { owner: who.name, localGeneration: who.session.localGeneration }) === null;
    const command = `toolroll thread ship ${id} --key ${shown.summary.key}`;
    const body = readForm(posted, CONSOLE_FORMS.threadShip);
    const key = body.get("terms") ?? "";
    if (key === "") return json(response, 200, { outcome: "ship-terms", key: shown.summary.key, digest: shown.digest, lines: summaryLines(shown.summary), laptop, ...(laptop ? {} : { command }) });
    if (!laptop) return acted(response, 403, "refused", `Shipping needs your password typed now. Run \`${command}\` in a terminal. Nothing was shipped.`);
    if (localActNow(store, "ship-thread") === null) return acted(response, 403, "refused", "Shipping from here needs your own act at this computer. Nothing was shipped.");
    const held = sessionHeld(who, flexible, id);
    if (held === null || !held()) return acted(response, 403, "refused", "Only a person signed in here can ship a thread's work.");
    // The session goes with the proof: asked again inside the consent's own transaction, after the lock, the agent's
    // stop and the reads of the thread's branch (a session that ended meanwhile consents to nothing).
    const shipped = await shipFlexibleThread(store, flexible, { thread: id, by, proof: { kind: "local-owner", held }, shownDigest: body.get("digest") ?? "", shownKey: key, now: new Date() });
    if (!shipped.ok) return acted(response, 409, "refused", shipped.message);
    const commit = latestFlexibleShip(store, id)?.candidate.slice(0, 12) ?? "";
    return acted(response, 200, "done", `Shipping: checks run on commit ${commit}; Toolroll merges it once they pass.`);
  }

  /** POST /agents/live/thread/<id>/ship/cancel: the owner stops the thread's armed Ship for good (it only narrows). */
  async function threadShipCancel(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response } = ctx;
    const flexible = threadsRead();
    if (flexible === null) return acted(response, 404, "refused", "There's no such thread.");
    if (who.via !== "cookie" || rereadBrowser(runtime, request, who) === null) return acted(response, 403, "refused", "Only a person signed in here can do that.");
    const id = url.pathname.slice("/agents/live/thread/".length, -"/ship/cancel".length);
    if (ownedThread(request, who, flexible, id) === null) return acted(response, 404, "refused", "There's no such thread.");
    if (who.authority === "local-owner" && localActNow(store, "cancel-ship") === null) return acted(response, 403, "refused", "Sign in with your password to do this.");
    const done = cancelFlexibleThreadShip(store, { thread: id, by: { name: who.name, generation: who.session.generation }, now: new Date() });
    return done.ok ? acted(response, 200, "done", "Ship stopped for good. Nothing more is merged from it.") : acted(response, 409, "refused", done.message);
  }

  /** POST /agents/live/thread/<id>/ship/send-back: the owner ends the armed Ship and its `feedback` becomes the thread's
   * next reply, proved as a reply is. */
  async function threadShipSendBack(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, posted } = ctx;
    const flexible = threadsOn();
    if (flexible === null) return acted(response, 404, "refused", FLEXIBLE_UNAVAILABLE);
    if (who.via !== "cookie" || rereadBrowser(runtime, request, who) === null) return acted(response, 403, "refused", "Only a person signed in here can do that.");
    const id = url.pathname.slice("/agents/live/thread/".length, -"/ship/send-back".length);
    const repo = ownedThread(request, who, flexible, id);
    if (repo === null) return acted(response, 404, "refused", "There's no such thread.");
    const body = readForm(posted, CONSOLE_FORMS.threadSendBack);
    const feedback = body.get("feedback") ?? "", key = body.get("key") ?? "";
    if (feedback.trim() === "" || !/^[0-9a-f]{32}$/.test(key)) return acted(response, 400, "refused", "That note isn't one Toolroll can read. Nothing was sent.");
    const proved = authenticateApprover(store, who.name, body.get("password") ?? "", repo);
    if (!proved.ok || !START_PROOFS.has(proved.method)) return acted(response, 403, "refused", "Sending back here needs your password. Nothing was sent.");
    if (proved.method === "local-owner" && localActNow(store, "reply-thread") === null) return acted(response, 403, "refused", "Sending back here needs your password. Nothing was sent.");
    const held = sessionHeld(who, flexible, id);
    if (held === null) return acted(response, 403, "refused", "Only a person signed in here can do that.");
    const sent = await sendBackFlexibleThread(store, flexible, { thread: id, by: { name: who.name, generation: who.session.generation }, feedback, key, freshProof: FRESH_PROOFS.has(proved.method),
      held, launcher, now: new Date() });
    if (!sent.ok) return acted(response, 409, "refused", sent.message);
    return acted(response, 200, "done", `Sent back. Turn ${sent.seq} started; the agent has the conversation so far.`);
  }

  /**
   * POST /agents/live/thread/<id>/save: Save as branch (everyday 9, B1). The thread's owner puts its committed work into
   * the project's own repository as `toolroll/code-<id>` through the controlled import (flexible-save.ts), with no pull
   * request, task or merge; the words say the exact `git merge` that puts it on their branch. Their own session
   * (re-read, and asked again inside the save's own transaction) and a local owner's own act `save-thread`; no password:
   * it grants nothing. Answered while interactive agent threads are off too, and after End.
   */
  async function threadSave(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response } = ctx;
    const flexible = threadsRead();
    if (flexible === null) return acted(response, 404, "refused", "There's no such thread.");
    if (who.via !== "cookie" || rereadBrowser(runtime, request, who) === null) return acted(response, 403, "refused", "Only a person signed in here can save a thread's work.");
    const id = url.pathname.slice("/agents/live/thread/".length, -"/save".length);
    if (ownedThread(request, who, flexible, id) === null) return acted(response, 404, "refused", "There's no such thread.");
    if (who.authority === "local-owner" && localActNow(store, "save-thread") === null) return acted(response, 403, "refused", "Sign in with your password to do this.");
    const held = sessionHeld(who, flexible, id);
    if (held === null || !held()) return acted(response, 403, "refused", "Only a person signed in here can save a thread's work.");
    const saved = await saveFlexibleBranch(store, { thread: id, by: { name: who.name, generation: who.session.generation }, now: new Date(), prove: held });
    if (!saved.ok) return acted(response, 409, "refused", saved.message);
    return actedWithCommand(response, 200, "done", `${saved.already ? `Already saved as ${saved.branch}.` : `Saved as ${saved.branch} (commit ${saved.candidate.slice(0, 12)}).`} ${saved.next}`, saved.command);
  }

  /** GET /engine/chat[?project=]: the person's central Lead conversation as structured data (never HTML), admitted as
   * `/chat` is (or for an admitted `terminal-remote` approver API token) and re-proved before and after reading. */
  async function leadChat(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, now } = ctx;
    const remote = who.via === "bearer" && who.principal !== undefined && isRemoteTerminalRequest(request);
    if (who.via !== "cookie" && !remote) return refusal(response, 403, "session");
    const keys = [...url.searchParams.keys()];
    const projectValues = url.searchParams.getAll("project");
    if (keys.some(k => k !== "project") || projectValues.length > 1) return refusal(response, 400, "request");
    const proveCaller = (): boolean => {
      if (who.via === "cookie") return rereadBrowser(runtime, request, who) !== null;
      return who.principal !== undefined && admitRemoteTerminalRequest(request, store, who.principal, clock).ok;
    };
    if (!proveCaller()) return refusal(response, 403, "session");
    let chatProject: string | null = null;
    if (projectValues.length === 1 && projectValues[0] !== "") {
      const wanted = projectValues[0]!;
      if (!runtime.visible(wanted) || !runtime.managedRepos().includes(wanted)) return refusal(response, 404, "project");
      chatProject = wanted;
    }
    const room = chatProject === null ? "chat" : `chat?project=${encodeURIComponent(chatProject)}`;
    const leadName = leadNameOf(store, who.name);
    const enabled = runtime.chatEnablement();
    const resolvePrincipal = () => {
      if (who.via === "cookie") return who.role === "approver" ? runtime.leadPrincipal(who) : null;
      if (who.principal === undefined) return null;
      const account = store.accountOf(who.name);
      if (account === null || account.role !== "approver") return null;
      const allowedRepos = runtime.managedRepos().filter(repo => remoteAllows(store, who.principal!, repo));
      const verified = verifyApproverStanding(store, who.name, who.generation, allowedRepos);
      return verified.ok ? verified.who : null;
    };
    const principal = resolvePrincipal();
    if (!enabled.ok || principal === null) {
      const problem = !enabled.ok ? enabled.why : "Sign in as an approver to chat with the Lead.";
      return sendChecked(response, 200, "leadChat", {
        version: ENGINE_API_VERSION,
        room,
        session: null,
        leadName,
        canSend: false,
        problem,
        project: chatProject,
        busy: false,
        pendingProposals: 0,
        queued: [],
        messages: [],
      });
    }
    const found = store.activeLeadSession(who.name, enabled.credentialKey);
    const notStarted = enabled.billing === "subscription" && (found === null || found.ceilingDigest !== principal.ceilingDigest);
    const ceilingStale = !notStarted && found !== null && found.ceilingDigest !== principal.ceilingDigest;
    const session = notStarted
      ? NOT_STARTED_SESSION
      : found !== null && !ceilingStale && found.approverGeneration === principal.generation
        ? found.id
        : null;
    const canSend = !remote && session !== null;
    const rows = runtime.leadConversationRows(who, principal, null, now, chatProject);
    // Re-proved after reading: a revoked session/token or changed standing receives nothing read.
    if (!proveCaller() || resolvePrincipal() === null) {
      if (remote && who.via === "bearer" && who.principal !== undefined) {
        const check = admitRemoteTerminalRequest(request, store, who.principal, clock);
        if (!check.ok) return sendTerminalConnectionRefusal(request, response, check.status, check.error);
      }
      return refusal(response, 403, "session");
    }
    const problem = remote
      ? "Remote Lead chat is read-only here — press w to open Lead in the browser."
      : ceilingStale
        ? "Project access changed. Start a new conversation in the browser to continue."
        : !canSend
          ? "Start a Lead conversation in the browser first."
          : notStarted ? null : rows.failure ?? null;
    return sendChecked(response, 200, "leadChat", leadChatOf({
      room,
      session,
      leadName,
      canSend,
      problem,
      project: chatProject,
      messages: rows.messages,
      proposals: rows.proposals,
      decisions: rows.decisions,
      pending: rows.pending,
      ask: rows.ask,
      staleAsk: rows.staleAsk,
      asks: rows.asks,
      queue: rows.queue,
    }));
  }

  return {
    /** The console's upkeep tick (serve.ts, every five seconds): a thread's answers past their deadlines are settled, and
     * every stop not yet verified is tried again (settleFlexibleStops): with interactive agent threads turned off (read
     * now), every thread and launch of this host's. Nothing without a host. */
    upkeep: (): void => {
      // People's Claude sign-ins for threads: retired generations' secrets deleted, expired saves and sign-ins whose
      // account changed retired (flexible-sign-in.ts). Whatever the switch says, and with or without a host.
      if (!tidying) {
        tidying = true;
        void (async () => {
          const file = store.databaseFile();
          if (file === null || file === "" || file === ":memory:") return;
          await tidyFlexibleSignIns(store, dirname(realpathSync(file)), { now: new Date() });
        })().catch(() => { /* the next tick tries again */ }).finally(() => { tidying = false; });
      }
      const host = flexible;
      if (host === null) return;
      try { tickFlexibleSessions(store, host); } catch { /* the next tick tries again */ }
      // Ended threads' working copies, a week after they ended (unless a Ship is open): one pass at a time.
      if (!tidyingEnded) {
        tidyingEnded = true;
        void tidyEndedFlexibleThreads(store, { now: new Date() }).catch(() => { /* the next tick tries again */ }).finally(() => { tidyingEnded = false; });
      }
      if (stopping) return;
      stopping = true;
      void settleFlexibleStops(store, host).catch(() => { /* the next tick tries again */ }).finally(() => { stopping = false; });
    },
    /** Shutdown: every thread here stopped, its answers revoked and its relay closed, then every proxy the launcher still
     * holds. Nothing while off. */
    close: async (): Promise<void> => {
      // The launcher's proxies close whatever the threads' shutdown does (it may throw).
      const host = flexible, made = launcher;
      try { if (host !== null) await closeFlexibleSessions(store, host); } finally { await made?.close(); }
    },
    registrations: [
      ...handlersOf("pages", { "engine.hello": hello, "engine.agents": agents, "engine.agents-check": agentsCheck, "engine.chat": leadChat, "agents.live.run": liveRun, "agents.live.thread": liveThread, "agents.live.thread.diff": liveThreadDiff, "agents.live.threads": liveThreads,
        "agents.live.thread.answer": threadAnswer, "agents.live.thread.start": threadStart, "agents.live.thread.turn": threadTurn, "agents.live.thread.stop": threadClose("stop"), "agents.live.thread.end": threadClose("end"), "agents.live.thread.ship": threadShip, "agents.live.thread.ship-cancel": threadShipCancel, "agents.live.thread.ship-send-back": threadShipSendBack, "agents.live.thread.save": threadSave }),
      ...handlersOf("tasks", { "task.steps": taskSteps, "task.approval": taskApproval, "task.diff": taskDiff, "task.result": taskResult }),
      ...handlersOf("people", {}, { "edge.login-link-json": redeemLink }),
    ],
  };
}

/** Said when a thread is asked for with an agent other than Claude Code. */
export const FLEXIBLE_CLAUDE_ONLY = "Interactive agent threads run Claude Code only for now. Codex threads come later. Nothing was started.";
/** The proofs a thread start takes: an approval's own (never a token's, a lead's or a remembered CLI login). */
const START_PROOFS: ReadonlySet<AuthMethod> = new Set<AuthMethod>(["password-now", "sso-now", "fresh-password", "fresh-sso", "session", "local-owner"]);
/** The ones that are a fresh proof (a start above the terms' password-free level needs one): never a session standing in. */
const FRESH_PROOFS: ReadonlySet<AuthMethod> = new Set<AuthMethod>(["password-now", "sso-now", "fresh-password", "fresh-sso", "local-owner"]);

/** A small request body, or null when it is larger than `cap` bytes (the rest is drained, never kept). */
function bodyOf(request: IncomingMessage, cap: number): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) { over = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

/** Said when a task has no approval this person could give right now (approved already, still planning, or closed). */
export const NOTHING_TO_APPROVE = "Nothing on this task is waiting for your approval.";
/** Where an approval that needs a password is given: the task page, which asks for it. */
export const APPROVE_IN_BROWSER = "Press w to open it in your browser.";

/** The approval card's terms: the summary whose key the form's digest binds (summaryLines, read as Build's offer reads its
 * terms), then what the plan changed from the terms before it (the task page's amendment, said before the yes), then the
 * notes a revision was sent back with (the page's revision card). */
export function approvalTermsOf(summary: ApprovalSummary, contract: PlanContractView | null, revision: RevisionView | null): { label: string; words: string }[] {
  const terms = termsOfLines(summaryLines(summary));
  if (contract !== null && "problem" in contract) terms.push({ label: "Plan record", words: contract.problem });
  else if (contract !== null && (contract.filed || contract.revision === true) && contract.changes.length > 0) {
    const count = `${contract.changes.length} change${contract.changes.length === 1 ? "" : "s"}`;
    terms.push({ label: "Plan changes", words: [contract.revision === true ? `The plan makes ${count} from your notes:` : `The plan makes ${count} to what you filed:`,
      ...contract.changeWords, ...(contract.amendment === null ? [] : [`Why: ${contract.amendment}`])].join("\n") });
  }
  if (revision !== null && "problem" in revision) terms.push({ label: "Sent back", words: revision.problem });
  else if (revision !== null && revision.comments.length > 0) {
    terms.push({ label: "Sent back", words: revision.comments.map(one => `${one.path === null ? "" : `${one.path}${one.line === null ? "" : `:${one.line}`} — `}${one.note} (${one.author})`).join("\n") });
  }
  return terms;
}
