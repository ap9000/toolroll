/**
 * Live terminals over the console (docs/plans/live-terminal.md): the Live page, its state, start/close/remove, and the
 * WebSocket a page attaches with.
 *
 * A terminal is shell-equivalent on this computer, so every road is the coding workspace's: a browser sign-in of an
 * installation-wide operator (codingActorAllowed), a project the coding workspace admits, and a fresh password to
 * start one. The socket is not a route-table row (an upgrade never reaches the request handler); it re-checks
 * everything the console's request path checks, and more, BEFORE the upgrade is accepted:
 *
 *   host allowlisted → HTTPS or a private path (this computer, the tailnet) → Origin exactly this page's own origin →
 *   no token or Authorization → cookie session, re-proved against the database → operator of the same generation →
 *   the terminal is theirs and its project still admitted → a viewer slot free.
 *
 * While open, the same proof runs before every input frame, before output once it is a second old, every 5 s, and at
 * once on every database change (the live bus); a failure closes the socket with 4401.
 */
import { randomBytes } from "node:crypto";
import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { readForm, CONSOLE_FORMS } from "../contracts/console-api.js";
import { html, htmlString } from "../html.js";
import { loadPtySpawn, MAX_FRAME_BYTES, TerminalHost, MAX_VIEWERS, parseTerminalFrame, TERMINAL_PROGRAMS, TerminalError, type TerminalProgram, type TerminalSummary, type TerminalViewer } from "../live-terminal.js";
import type { LiveBus } from "../live-bus.js";
import { logEvent } from "../log.js";
import { projectName, rowVisible } from "../project.js";
import { transportOf, type Transport } from "../public-access.js";
import type { Store } from "../store.js";
import type { ServeOptions } from "./http.js";
import type { HandlerContext } from "./handler-context.js";
import { handlersOf } from "./handler-registry.js";
import { respond } from "./http.js";
import { rereadBrowser } from "./live.js";
import type { ServerRuntime } from "./runtime.js";
import type { Who } from "./session.js";

const TERMINAL_ID = /^\/term\/([a-f0-9]{32})(?:\/(socket|close|remove))?$/;
/** A viewer this far behind is dropped; its page reconnects and replays the scrollback. */
const BEHIND_BYTES = 4 * 1024 * 1024;
/** Typed input per socket: a burst of this many bytes, refilled at this many a second. */
const INPUT_BURST = 256 * 1024;
const INPUT_PER_SECOND = 256 * 1024;
const REPROVE_MS = 1_000;
const SWEEP_MS = 5_000;

export type TerminalDeps = {
  host: TerminalHost | null;
  /** Why there is no host (no pty library on this install), in words. */
  problem: string | null;
  bus: LiveBus;
  allowedHost: (host: string | undefined) => boolean;
  /** serve.ts's: the source a loopback proxy forwarded for (`fwd:<hop>`), else the peer. */
  forwardedSourceOf: (request: IncomingMessage) => string;
  publicOrigin: URL | null;
  /** The console's server: its upgrade event is answered here. */
  server: Server;
};

/** The console's terminal host: on a machine that runs agents, when this install has a pty library; else why not. */
export function terminalHostFor(store: Store, options: Pick<ServeOptions, "terminalHost" | "localRunner">): { host: TerminalHost | null; problem: string | null } {
  if (options.terminalHost !== undefined) return { host: options.terminalHost, problem: options.terminalHost === null ? "Terminals are off on this console." : null };
  const database = store.isDemo() ? null : store.databaseFile();
  if (options.localRunner === undefined || database === null || database === "") return { host: null, problem: "Terminals run on the computer that runs your agents. Open Toolroll there." };
  const spawn = loadPtySpawn();
  if (spawn === null) return { host: null, problem: "This install has no terminal support (the optional @lydell/node-pty package didn't load). Reinstall Toolroll to add it." };
  return { host: new TerminalHost({ spawn, worktreeRoot: join(dirname(database), "live-worktrees") }), problem: null };
}

type Operator = Who & { via: "cookie" };

export function createTerminalHandlers(runtime: ServerRuntime, deps: TerminalDeps) {
  const { store, codingActorAllowed, codingProjectAllowed, liveCeiling } = runtime;
  const transportOfRequest = (request: IncomingMessage): Transport => transportOf({ peer: request.socket.remoteAddress, joinSource: deps.forwardedSourceOf(request),
    forwardedProto: request.headers["x-forwarded-proto"], forwarded: request.headers["forwarded"] });
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });

  /** An operator signed in with a browser, of the generation they signed in with; else null. */
  const operatorOf = (who: Who | null): Operator | null =>
    who?.via === "cookie" && who.role === "approver" && !store.isDemo() && codingActorAllowed({ name: who.name, generation: who.session.generation }) ? who : null;
  /** The project a terminal works in is one the coding workspace admits for this person, now. */
  const projectAllowed = (name: string, repo: string): boolean =>
    rowVisible(liveCeiling(), repo) && store.accountCanAccess(name, repo) && codingProjectAllowed(repo);
  const owned = (who: Operator, terminal: TerminalSummary | null): terminal is TerminalSummary =>
    terminal !== null && terminal.owner === who.name && terminal.generation === who.session.generation;
  const record = (event: string, who: string, terminal: { id: string; repo: string; program: TerminalProgram }) =>
    logEvent("info", `terminal.${event}`, { actor: who, terminal: terminal.id, repo: terminal.repo, program: terminal.program });

  const json = (ctx: HandlerContext, status: number, value: unknown) => respond(ctx.response, status, "application/json", JSON.stringify(value));
  const refusal = (ctx: HandlerContext): string | null => {
    if (operatorOf(ctx.who) === null) return "Terminals are for installation-wide operators signed in with a browser.";
    if (deps.host === null) return deps.problem ?? "Terminals aren't available on this install.";
    return null;
  };

  /** The Live page: its own small document and bundle. */
  async function page(ctx: HandlerContext): Promise<void> {
    const { who, url, response, request } = ctx;
    if (operatorOf(who) === null) return respond(response, 403, "text/plain; charset=utf-8", "Terminals are for installation-wide operators signed in with a browser.");
    const id = TERMINAL_ID.exec(url.pathname)?.[1] ?? "";
    const nonce = randomBytes(16).toString("base64");
    const host = request.headers.host ?? "";
    const document = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><meta name="theme-color" content="#0C0E12"><meta name="apple-mobile-web-app-capable" content="yes"><title>Live — Toolroll</title><link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/assets/terminal.css"></head><body><div id="so-term"></div><div id="so-term-boot" hidden data-csrf="${(who as Operator).session.csrf}" data-session="${id}"></div><script type="module" src="/assets/terminal.js" nonce="${nonce}"></script></body></html>`;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      // The socket is this page's own host: named outright, since older WebKit doesn't read 'self' as ws:/wss:.
      "Content-Security-Policy": `default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; manifest-src 'self'; script-src 'nonce-${nonce}'; connect-src 'self' ws://${host} wss://${host}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
    response.end(htmlString(document));
  }

  async function state(ctx: HandlerContext): Promise<void> {
    const who = operatorOf(ctx.who);
    if (who === null) return json(ctx, 403, { error: "operator" });
    const sessions = deps.host === null ? [] : deps.host.list(who.name).filter(one => owned(who, one) && projectAllowed(who.name, one.repo));
    return json(ctx, 200, {
      available: deps.host !== null, problem: deps.host === null ? deps.problem ?? "Terminals aren't available on this install." : null,
      programs: TERMINAL_PROGRAMS,
      projects: runtime.consoleProjects().filter(repo => projectAllowed(who.name, repo)).map(path => ({ path, name: projectName(path) })),
      sessions: sessions.map(one => ({ id: one.id, repo: one.repo, project: projectName(one.repo), program: one.program, branch: one.branch, startedAt: one.startedAt, endedAt: one.endedAt, exit: one.exit, cleanup: one.cleanup })),
    });
  }

  async function start(ctx: HandlerContext): Promise<void> {
    const refused = refusal(ctx);
    if (refused !== null) return json(ctx, 403, { ok: false, error: refused });
    const who = ctx.who as Operator;
    const body = readForm(ctx.posted, CONSOLE_FORMS.term);
    if ([...new Set(body.keys())].some(key => body.sent.getAll(key).length !== 1)) return json(ctx, 400, { ok: false, error: "Submit one value for each field." });
    const repo = body.get("repo") ?? "", program = body.get("program") ?? "";
    if (!(TERMINAL_PROGRAMS as readonly string[]).includes(program)) return json(ctx, 400, { ok: false, error: "Choose Claude Code, Codex or a shell." });
    if (!runtime.consoleProjects().includes(repo) || !projectAllowed(who.name, repo)) return json(ctx, 403, { ok: false, error: "Choose a project available to your account." });
    // The organisation's policy decides whether this provider may run in a person's own session.
    if (program !== "shell") {
      const stopped = store.sessionPolicyRefusal(program, null, "live terminals");
      if (stopped !== null) return json(ctx, 403, { ok: false, error: stopped });
    }
    if (!runtime.authenticateApprover(who, body.get("password") ?? "").ok) return json(ctx, 403, { ok: false, error: "Enter your Toolroll password to start a terminal." });
    try {
      const terminal = await deps.host!.start({ name: who.name, generation: who.session.generation }, repo, program as TerminalProgram);
      // Access is checked again after the asynchronous start: a revoked operator's terminal is closed at once.
      if (operatorOf(runtime.identify(ctx.request, false)) === null) { void deps.host!.close(terminal.id); return json(ctx, 403, { ok: false, error: "Your access changed. Sign in again." }); }
      record("start", who.name, terminal);
      return json(ctx, 200, { ok: true, id: terminal.id });
    } catch (error) {
      return json(ctx, 409, { ok: false, error: error instanceof TerminalError ? error.message : "The terminal didn't start." });
    }
  }

  const act = (verb: "close" | "remove") => async (ctx: HandlerContext): Promise<void> => {
    const refused = refusal(ctx);
    if (refused !== null) return json(ctx, 403, { ok: false, error: refused });
    const who = ctx.who as Operator;
    const terminal = deps.host!.get(TERMINAL_ID.exec(ctx.url.pathname)?.[1] ?? "");
    if (!owned(who, terminal) || !projectAllowed(who.name, terminal.repo)) return json(ctx, 404, { ok: false, error: "No such terminal." });
    try {
      if (verb === "close") await deps.host!.close(terminal.id);
      else await deps.host!.remove(terminal.id);
      record(verb, who.name, terminal);
      return json(ctx, 200, { ok: true });
    } catch (error) {
      return json(ctx, 409, { ok: false, error: error instanceof TerminalError ? error.message : `The terminal couldn't be ${verb === "close" ? "closed" : "removed"}.` });
    }
  };

  /** A plain GET of the socket address: it only answers an upgrade. */
  async function socketWithoutUpgrade(ctx: HandlerContext): Promise<void> {
    ctx.response.setHeader("Upgrade", "websocket");
    return respond(ctx.response, 426, "text/plain; charset=utf-8", "This address answers a WebSocket upgrade only.");
  }

  // ---- the socket ------------------------------------------------------------------------------------------------

  const reprovers = new Set<() => void>();
  const unsubscribe = deps.bus.subscribe(() => { for (const reprove of [...reprovers]) reprove(); });
  const sweep = setInterval(() => { for (const reprove of [...reprovers]) reprove(); }, SWEEP_MS);
  sweep.unref?.();

  /** Answer a refused upgrade in plain HTTP and drop the connection. */
  const refuseUpgrade = (socket: Duplex, status: number, words: string): void => {
    const body = `${words}\n`;
    try {
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`);
    } catch { /* already gone */ }
    socket.destroy();
  };

  /** True when this request was an upgrade for a terminal (answered or refused here); false leaves it to others. */
  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://placeholder"); } catch { return false; }
    const match = TERMINAL_ID.exec(url.pathname);
    if (match === null || match[2] !== "socket") return false;
    socket.on("error", () => socket.destroy());
    const id = match[1]!;
    if (request.method !== "GET") { refuseUpgrade(socket, 405, "Only GET upgrades."); return true; }
    if (url.search !== "") { refuseUpgrade(socket, 400, "This address takes no query; credentials never travel in URLs."); return true; }
    const host = request.headers.host;
    if (!deps.allowedHost(host)) { refuseUpgrade(socket, 421, "This console doesn't answer at that address."); return true; }
    const transport = transportOfRequest(request);
    if (!transport.https && !transport.privatePath) { refuseUpgrade(socket, 403, "Open the console over HTTPS to use a terminal from here."); return true; }
    // Exactly the origin of a page served at this host, over this transport (the public https origin for its host).
    const expected = deps.publicOrigin !== null && host === deps.publicOrigin.host ? deps.publicOrigin.origin : `${transport.https ? "https" : "http"}://${host}`;
    if (request.headers.origin !== expected) { refuseUpgrade(socket, 403, "A terminal opens only from this console's own page."); return true; }
    if (request.headers.authorization !== undefined) { refuseUpgrade(socket, 403, "Terminals open with a browser sign-in only."); return true; }
    const who = operatorOf(runtime.identify(request, true));
    if (who === null || rereadBrowser(runtime, request, who) === null) { refuseUpgrade(socket, 401, "Sign in as an installation-wide operator."); return true; }
    const terminal = deps.host?.get(id) ?? null;
    if (!owned(who, terminal) || !projectAllowed(who.name, terminal.repo)) { refuseUpgrade(socket, 404, "No such terminal."); return true; }
    if (deps.host!.viewerCount(id) >= MAX_VIEWERS) { refuseUpgrade(socket, 429, `This terminal is open in ${MAX_VIEWERS} places already.`); return true; }
    wss.handleUpgrade(request, socket, head, ws => attach(ws, request, who, terminal));
    return true;
  }

  function attach(ws: WebSocket, request: IncomingMessage, who: Operator, terminal: TerminalSummary): void {
    const host = deps.host!;
    sockets.add(ws);
    let provedAt = 0, closed = false, detach: (() => void) | null = null;
    let budget = INPUT_BURST, filledAt = Date.now();
    const shut = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      detach?.();
      reprovers.delete(reprove);
      try { ws.close(code, reason); } catch { ws.terminate(); }
      // A peer that never answers the close is dropped outright.
      setTimeout(() => ws.terminate(), 2_000).unref?.();
    };
    const prove = (): boolean => {
      const again = rereadBrowser(runtime, request, who);
      const ok = again !== null && operatorOf(again) !== null && owned(who, host.get(terminal.id)) && projectAllowed(who.name, terminal.repo);
      if (ok) provedAt = Date.now();
      return ok;
    };
    const reprove = () => { if (!closed && !prove()) shut(4401, "signed out"); };
    const stillProved = (): boolean => Date.now() - provedAt < REPROVE_MS || prove();
    const viewer: TerminalViewer = {
      output(data) {
        if (closed) return;
        if (!stillProved()) return shut(4401, "signed out");
        if (ws.bufferedAmount > BEHIND_BYTES) return shut(4008, "fell behind");
        ws.send(data, { binary: true });
      },
      control(message) {
        if (closed) return;
        if (!stillProved()) return shut(4401, "signed out");
        ws.send(JSON.stringify(message));
      },
    };
    ws.on("message", (data, isBinary) => {
      if (closed) return;
      if (isBinary) return shut(1003, "text frames only");
      if (!prove()) return shut(4401, "signed out");
      const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
      const frame = parseTerminalFrame(text);
      if (frame === null) return shut(1003, "not a terminal frame");
      if (frame.t === "resize") return host.resize(terminal.id, frame.cols, frame.rows);
      const now = Date.now();
      budget = Math.min(INPUT_BURST, budget + ((now - filledAt) / 1000) * INPUT_PER_SECOND);
      filledAt = now;
      const size = Buffer.byteLength(frame.d);
      if (size > budget) return shut(1008, "typing faster than a terminal reads");
      budget -= size;
      host.input(terminal.id, frame.d);
    });
    ws.on("close", () => { closed = true; detach?.(); reprovers.delete(reprove); sockets.delete(ws); });
    ws.on("error", () => shut(1011, "socket error"));
    if (!prove()) return shut(4401, "signed out");
    try { detach = host.attach(terminal.id, viewer); }
    catch (error) { return shut(error instanceof TerminalError && /open in/.test(error.message) ? 4429 : 4404, "unavailable"); }
    reprovers.add(reprove);
    record("attach", who.name, terminal);
  }

  deps.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!upgrade(request, socket, head)) socket.destroy();
  });

  return {
    registrations: handlersOf("tasks", {
      "term.page": page,
      "term.session": async (ctx: HandlerContext) => page(ctx),
      "term.state": state,
      "term.start": start,
      "term.close": act("close"),
      "term.remove": act("remove"),
      "term.socket": socketWithoutUpgrade,
    }),
    upgrade,
    /** Shutdown: no more attaches, every socket dropped, every program ended (bounded by the host's grace). */
    async close(): Promise<void> {
      unsubscribe();
      clearInterval(sweep);
      for (const ws of sockets) ws.terminate();
      sockets.clear();
      wss.close();
      await deps.host?.stop();
    },
  };
}
