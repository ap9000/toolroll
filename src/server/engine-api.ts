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
import { homedir } from "node:os";
import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { boardRunOf } from "../agent-board.js";
import { checkEngineResponse, DIFF_CONTEXT_MAX, ENGINE_API_VERSION, ENGINE_RESPONSES, engineContractDigest, linkRedemptionRequestSchema, type EngineResponseName, type LinkRedemption, type LiveSessionWindow, type LiveThreads } from "../contracts/engine-api.js";
import { CONSOLE_FORMS, readForm } from "../contracts/console-api.js";
import { flexibleAvailable } from "../flexible-available.js";
import { FLEXIBLE_UNAVAILABLE } from "../flexible.js";
import { admitFlexibleThreadOwner, answerFlexibleRequest, closeFlexibleSessions, flexibleThreadChangeOf, flexibleThreadLiveOf, flexibleThreadsOf, FLEXIBLE_WAIT_MS, flexibleThreadsExist, flexibleWorkOpen, openFlexibleSessions,
  recoverFlexibleHolders, startFlexibleThread, settleFlexibleStops, tickFlexibleSessions, waitFlexibleThreadChange, type FlexibleChoice, type FlexibleSessions } from "../flexible-session.js";
import { createFlexibleLauncher, type FlexibleLauncher } from "../flexible-launcher.js";
import { flexibleStartCard } from "../flexible-start.js";
import { summaryLines, type ApprovalSummary } from "../approval-summary.js";
import { termsOfLines } from "../fast-terms.js";
import { localActNow } from "../local-owner.js";
import { authenticateApprover, type AuthMethod } from "../scope.js";
import { defaultChainOf, installModeNow } from "../install-mode.js";
import { packageVersion } from "../monitoring.js";
import { readChildWindow, type ChildWindow } from "../live-children-read.js";
import { readMainWindow, type MainWindow } from "../live-main-read.js";
import { runLiveCommands, type Run } from "../store.js";
import { agentsReadOf, resultDiffContextOf, resultDiffFileOf, resultDiffOf, resultRunsOf, stepCardsOf } from "../engine-reads.js";
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
export function readRunLive(runtime: Pick<ServerRuntime, "identify" | "sessions" | "store" | "taskRepoOf" | "runVisible" | "options" | "evidenceRoot">,
  request: IncomingMessage, who: Who & { via: "cookie" }, runId: number, file: "main" | "sub", cursor: string | null, key: Buffer): RunLiveRead {
  const { store, options } = runtime;
  const allowed = (): boolean => {
    if (rereadBrowser(runtime, request, who) === null) return false;
    const run = store.getRun(runId);
    const repo = run === null ? null : runtime.taskRepoOf(run.taskRef);
    return run !== null && repo !== null && runtime.runVisible(run) && store.accountCanAccess(who.name, repo);
  };
  if (!allowed()) return { ok: false };
  const local = () => options.localRunner !== undefined && store.getRun(runId)?.runner === options.localRunner;
  if (!local()) return allowed() ? { ok: true, run: store.getRun(runId)!, window: null } : { ok: false };
  const read = { key, commands: runLiveCommands(store, runId) };
  const window = file === "sub" ? readChildWindow(runtime.evidenceRoot, runId, cursor, read) : readMainWindow(runtime.evidenceRoot, runId, cursor, read);
  // Re-proved after the read: a narrowed account or a run gone from view gets nothing it read.
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
    return sendChecked(response, 200, "agents", agentsReadOf(runtime.localAgents, view === "full" ? "full" : "summary", view === "full" ? process.env["HOME"] ?? homedir() : null));
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
    return sendChecked(response, 200, "agents", agentsReadOf(runtime.localAgents, view === "full" ? "full" : "summary", view === "full" ? process.env["HOME"] ?? homedir() : null));
  }

  /** GET /agents/live/run/<id>: a run's LiveSession window (browser sessions only, like the Live grid). */
  async function liveRun(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response } = ctx;
    if (who.via !== "cookie") return refusal(response, 403, "session");
    const query = liveQueryOf(url);
    if (query === null) return refusal(response, 400, "request");
    const runId = Number(url.pathname.slice("/agents/live/run/".length));
    const read = readRunLive(runtime, request, who, runId, query.file, query.cursor, cursorKey);
    if (!read.ok) return refusal(response, 404, "run");
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
  /** A thread `who` owns, ready, in a project still theirs, read again from their saved session: its project, or null. */
  const ownedThread = (request: IncomingMessage, who: Who & { via: "cookie" }, sessions: FlexibleSessions, thread: string): string | null => {
    if (rereadBrowser(runtime, request, who) === null) return null;
    const admitted = admitFlexibleThreadOwner(store, sessions, { thread, viewer: { name: who.name }, canAccess: repo => store.accountCanAccess(who.name, repo) });
    return admitted.ok ? admitted.repo : null;
  };
  /** An act's answer as data (`{ outcome, words }`): a thread's acts are a terminal's or an API client's, never a page's. */
  const acted = (response: JsonResponse, status: number, outcome: "done" | "refused", words: string): void => json(response, status, { outcome, words });

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
      .map(one => ({ id: one.id, title: one.title, project: one.project, level: one.level, live: one.live, waiting: one.waiting, costUsd: one.turn?.costUsd ?? null })) };
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
    const sessionHash = runtime.sessions.hashOf(who.session);
    const admitted = sessionHash === null ? null : store.webSession(sessionHash);
    if (admitted === null || admitted.account !== who.name) return acted(response, 403, "refused", "Only a person signed in here can answer an agent.");
    const held = (): boolean => {
      const saved = store.webSession(admitted.idHash), account = store.accountOf(who.name);
      return saved !== null && saved.idHash === admitted.idHash && saved.account === admitted.account && saved.generation === admitted.generation && saved.role === admitted.role
        && saved.authority === admitted.authority && saved.localGeneration === admitted.localGeneration && saved.keyEpoch === admitted.keyEpoch && saved.keyHash === admitted.keyHash
        && saved.createdAt === admitted.createdAt && sessionWithinLifetime(saved, Date.now()) && runtime.sessions.holds(who.session)
        && account !== null && account.revokedAt === null && account.generation === saved.generation && account.generation === who.session.generation && account.role === saved.role
        && admitFlexibleThreadOwner(store, flexible, { thread: id, viewer: { name: who.name }, canAccess: repo => store.accountCanAccess(who.name, repo) }).ok;
    };
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
    if (flexible === null) return acted(response, 404, "refused", FLEXIBLE_UNAVAILABLE);
    if (who.via !== "cookie" || rereadBrowser(runtime, request, who) === null) return acted(response, 403, "refused", "Only a person signed in here can start a thread.");
    if (launcher === null) return acted(response, 409, "refused", "This console can't give a thread its network, so no thread was started.");
    const body = readForm(posted, CONSOLE_FORMS.threadStart);
    const agent = body.get("agent");
    if (agent !== null && agent !== "claude") return acted(response, 409, "refused", FLEXIBLE_CLAUDE_ONLY);
    const repo = body.get("repo") ?? "", message = body.get("message") ?? "";
    if (!store.accountCanAccess(who.name, repo)) return acted(response, 403, "refused", "That project is outside your access.");
    const by = { name: who.name, generation: who.session.generation };
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
    return acted(response, 200, "done", started.replayed ? "This thread already started." : "The thread started.");
  }

  /** The task an address names, in view as its page would be (the route admitted its project already). */
  function familyAt(url: URL, verb: string) {
    const task = matchTaskPath(url.pathname, `/${verb}$`);
    const family = task === null ? null : runtime.familyOf(task.taskId);
    return family === null || family.problem !== null ? null : family;
  }

  /** GET /t/<task>/steps: the task's step cards. */
  async function taskSteps(ctx: HandlerContext): Promise<void> {
    const { url, response, who } = ctx;
    if ([...url.searchParams.keys()].length > 0) return refusal(response, 400, "request");
    const family = familyAt(url, "steps");
    if (family === null) return refusal(response, 404, "task");
    return sendChecked(response, 200, "stepCards", stepCardsOf({ store, family, now: clock(), access: runtime.workAccess(), evidenceRoot, viewer: who.name }));
  }

  /** GET /t/<task>/approval: the approval waiting on the task's current version, as its page's approval form carries it
   * (contracts/engine-api.ts approvalCardSchema). A browser or terminal session only. The page's own assembly
   * (taskViewData) decides whether a yes can be taken at all and mints the nonce exactly as the page does when it
   * renders; nothing is minted for a yes this session couldn't give here (it needs a password: the browser asks). */
  async function taskApproval(ctx: HandlerContext): Promise<void> {
    const { url, response, who } = ctx;
    if (who.via !== "cookie") return refusal(response, 403, "session");
    if ([...url.searchParams.keys()].length > 0) return refusal(response, 400, "request");
    const family = familyAt(url, "approval");
    if (family === null) return refusal(response, 404, "task");
    const taskId = family.current.id;
    const none = (problem: string) => sendChecked(response, 200, "approvalCard", { version: ENGINE_API_VERSION, task: taskId, digest: null, nonce: null, terms: [], problem });
    const waits = (view: NonNullable<ReturnType<typeof runtime.taskViewData>>) => view.nonce !== "" && view.approvalDigest != null && view.approvalSummary != null;
    // Read first without minting: only a yes this session can give here gets a nonce.
    const peek = runtime.taskViewData(taskId, who, null, { mintNonce: false });
    if (peek === null) return refusal(response, 404, "task");
    if (!waits(peek)) return none(NOTHING_TO_APPROVE);
    if (peek.approvalLocal?.eligible !== true) return none(`${peek.approvalLocal?.eligible === false ? `${peek.approvalLocal.message} ` : "This approval needs your password. "}${APPROVE_IN_BROWSER}`);
    const view = runtime.taskViewData(taskId, who, null);
    if (view === null) return refusal(response, 404, "task");
    if (!waits(view) || view.approvalLocal?.eligible !== true) return none(NOTHING_TO_APPROVE);
    return sendChecked(response, 200, "approvalCard", { version: ENGINE_API_VERSION, task: taskId, digest: view.approvalDigest, nonce: view.nonce,
      terms: approvalTermsOf(view.approvalSummary!, view.planContract ?? null, view.revision ?? null), problem: null });
  }

  /** GET /t/<task>/diff[?run=<id>[&file=<n>[&from=<line>&count=<n>]]]: the result's files, one file's hunks (which needs
   * the run it is of), or at most DIFF_CONTEXT_MAX lines of that file around them (which need the file). */
  async function taskDiff(ctx: HandlerContext): Promise<void> {
    const { url, response } = ctx;
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
    if (fileParam === null) return sendChecked(response, 200, "resultDiff", resultDiffOf(store, evidenceRoot, family.root.id, run));
    if (fromParam !== null && countParam !== null) {
      // The project's repository as Toolroll records it for this run (never a path the checkout names).
      const context = resultDiffContextOf(store, evidenceRoot, family.root.id, run!, Number(fileParam), Number(fromParam), Number(countParam), runtime.taskRepoOf(run!.taskRef));
      return context === null ? refusal(response, 404, "file") : sendChecked(response, 200, "resultDiffContext", context);
    }
    const one = resultDiffFileOf(store, evidenceRoot, family.root.id, run!, Number(fileParam));
    return one === null ? refusal(response, 404, "file") : sendChecked(response, 200, "resultDiffFile", one);
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
    const body: LinkRedemption = { version: ENGINE_API_VERSION, account: admitted.held.account, cookie: { name: SESSION_COOKIE, value: id }, csrf, key, epoch: runtime.keyEpoch };
    return sendChecked(response, 200, "linkRedemption", body);
  }

  return {
    /** The console's upkeep tick (serve.ts, every five seconds): a thread's answers past their deadlines are settled, and
     * every stop not yet verified is tried again (settleFlexibleStops): with interactive agent threads turned off (read
     * now), every thread and launch of this host's. Nothing without a host. */
    upkeep: (): void => {
      const host = flexible;
      if (host === null) return;
      try { tickFlexibleSessions(store, host); } catch { /* the next tick tries again */ }
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
      ...handlersOf("pages", { "engine.hello": hello, "engine.agents": agents, "engine.agents-check": agentsCheck, "agents.live.run": liveRun, "agents.live.thread": liveThread, "agents.live.threads": liveThreads,
        "agents.live.thread.answer": threadAnswer, "agents.live.thread.start": threadStart }),
      ...handlersOf("tasks", { "task.steps": taskSteps, "task.approval": taskApproval, "task.diff": taskDiff }),
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
