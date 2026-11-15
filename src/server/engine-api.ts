/**
 * The engine API's handlers (solo-workbench plan v2, A0; contracts/engine-api.ts): the reads a terminal client and the
 * web share, and the one-time link redemption that gives a terminal client the local owner's session.
 *
 * Every read is a route row of its own (route-table.ts), admitted exactly as the page it mirrors before its handler
 * runs: a LiveSession window as the Live grid's own reads (/agents/live/<run>, the same code below), step cards and a
 * result's diff as the task page. A handler re-proves only what can change after admission (the task still in view,
 * the run still this person's to see), and reads nothing for a caller it refuses.
 *
 * A LiveSession is a run today and a Flexible thread later: the same window, cursor and live room. The thread road is
 * declared now and refuses (not available) until Flexible ships; its admission (the thread's owner, its terms, its
 * project) goes where the marked refusal is, then it reads through the same window reader.
 */
import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { boardRunOf } from "../agent-board.js";
import { checkEngineResponse, ENGINE_API_VERSION, ENGINE_RESPONSES, engineContractDigest, linkRedemptionRequestSchema, type EngineResponseName, type LinkRedemption, type LiveSessionWindow } from "../contracts/engine-api.js";
import { FLEXIBLE_AVAILABLE } from "../flexible-available.js";
import { defaultChainOf, installModeNow } from "../install-mode.js";
import { packageVersion } from "../monitoring.js";
import { readChildWindow, type ChildWindow } from "../live-children-read.js";
import { readMainWindow, type MainWindow } from "../live-main-read.js";
import { runLiveCommands, type Run } from "../store.js";
import { resultDiffFileOf, resultDiffOf, resultRunsOf, stepCardsOf } from "../engine-reads.js";
import type { EdgeContext, HandlerContext } from "./handler-context.js";
import { handlersOf } from "./handler-registry.js";
import { matchTaskPath, respond } from "./http.js";
import { rereadBrowser } from "./live.js";
import { admitLink, saveLinkSession, spendLink } from "./link-redemption.js";
import type { ServerRuntime } from "./runtime.js";
import { SESSION_COOKIE, type Who } from "./session.js";

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

  /** GET /agents/live/thread/<id>: a Flexible thread's LiveSession window. Refused, before anything is looked up, while
   * Flexible isn't available (flexible-available.ts). */
  async function liveThread(ctx: HandlerContext): Promise<void> {
    const { who, response } = ctx;
    if (who.via !== "cookie") return refusal(response, 403, "session");
    if (!FLEXIBLE_AVAILABLE) return refusal(response, 404, "not-available");
    // F2c: admit the thread here (its owner is this session's account at its generation, its terms current, its project
    // in view; proved again after the read, as readRunLive does), then read its window through the same reader.
    return refusal(response, 404, "not-available");
  }

  /** The task an address names, in view as its page would be (the route admitted its project already). */
  function familyAt(url: URL, verb: string) {
    const task = matchTaskPath(url.pathname, `/${verb}$`);
    const family = task === null ? null : runtime.familyOf(task.taskId);
    return family === null || family.problem !== null ? null : family;
  }

  /** GET /t/<task>/steps: the task's step cards. */
  async function taskSteps(ctx: HandlerContext): Promise<void> {
    const { url, response } = ctx;
    if ([...url.searchParams.keys()].length > 0) return refusal(response, 400, "request");
    const family = familyAt(url, "steps");
    if (family === null) return refusal(response, 404, "task");
    return sendChecked(response, 200, "stepCards", stepCardsOf({ store, family, now: clock(), access: runtime.workAccess(), evidenceRoot }));
  }

  /** GET /t/<task>/diff[?run=<id>[&file=<n>]]: the result's files, or one file's hunks (which needs the run it is of). */
  async function taskDiff(ctx: HandlerContext): Promise<void> {
    const { url, response } = ctx;
    const params = url.searchParams, runParam = params.get("run"), fileParam = params.get("file");
    if ([...params.keys()].some(key => key !== "run" && key !== "file") || params.getAll("run").length > 1 || params.getAll("file").length > 1
      || (runParam !== null && !/^[1-9][0-9]{0,14}$/.test(runParam)) || (fileParam !== null && !/^(0|[1-9][0-9]{0,5})$/.test(fileParam))
      || (fileParam !== null && runParam === null)) return refusal(response, 400, "request");
    const family = familyAt(url, "diff");
    if (family === null) return refusal(response, 404, "task");
    // Only the family's own results, each still in view from its current row.
    const results = resultRunsOf(store, family).filter(run => runtime.runVisible(run));
    const run = runParam === null ? results[0] ?? null : results.find(one => one.id === Number(runParam)) ?? null;
    if (runParam !== null && run === null) return refusal(response, 404, "run");
    if (fileParam === null) return sendChecked(response, 200, "resultDiff", resultDiffOf(store, evidenceRoot, family.root.id, run));
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
    registrations: [
      ...handlersOf("pages", { "engine.hello": hello, "agents.live.run": liveRun, "agents.live.thread": liveThread }),
      ...handlersOf("tasks", { "task.steps": taskSteps, "task.diff": taskDiff }),
      ...handlersOf("people", {}, { "edge.login-link-json": redeemLink }),
    ],
  };
}

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
