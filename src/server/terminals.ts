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
 *
 * Solo-workbench T4 (take over): a local owner's session — the terminal workbench's, or the laptop owner's browser —
 * is an operator here only while the install is solo and its local sign-in still stands (local mode on at the session's
 * generation, its owner and account unchanged, its saved session held), read again at every proof above. It reaches
 * only terminals a local owner's session of the same local generation started, never a full session's. Its start is the
 * route table's `take-over` act, proved by the local owner's own prover (scope.ts); right before the program starts,
 * solo and the local sign-in are read again. A take-over names a task and a build, never a project or a folder: the
 * project and the commit come from Toolroll's own record of that build.
 */
import { randomBytes } from "node:crypto";
import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { KEY_PROTOCOL, TERMINAL_EPOCH } from "./mutation-key.js";
import { WebSocketServer, type WebSocket } from "ws";
import { readForm, CONSOLE_FORMS } from "../contracts/console-api.js";
import { html, htmlString } from "../html.js";
import { openTerminalLedger } from "../terminal-catalog.js";
import { loadPtySpawn, MAX_FRAME_BYTES, TerminalHost, MAX_VIEWERS, parseTerminalFrame, TERMINAL_PROGRAMS, TerminalError, type TerminalProgram, type TerminalSummary, type TerminalViewer } from "../live-terminal.js";
import type { LiveBus } from "../live-bus.js";
import { logEvent } from "../log.js";
import { sessionStandsIn, soloNow } from "../install-mode.js";
import { localOwnerStandsNow } from "../local-owner.js";
import { SHELL_NO_COMMIT, SHELL_NO_RESULT, takeOverRevisionOf, takeOverRunsOf } from "../engine-reads.js";
import { failedAttemptSentence } from "../needs-you.js";
import { checkEngineResponse, type EngineResponseName } from "../contracts/engine-api.js";
import { projectName, rowVisible } from "../project.js";
import { transportOf, type Transport } from "../public-access.js";
import { agentSaidOf, type Run, type Store, type TaskFamily } from "../store.js";
import { agentSetupOf } from "../agent-detect.js";
import { excludedFolders, launchPath, resolveLaunch, statusEnvironment, type StatusTrust } from "../status-probe.js";
import { boundedAcl } from "../trusted-path.js";
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
  /** The environment an agent's own sign-in or install is resolved and started from (default this process's). */
  agentEnv?: () => NodeJS.ProcessEnv;
};

/** The console's terminal host: on a machine that runs agents, when this install has a pty library; else why not. */
export function terminalHostFor(store: Store, options: Pick<ServeOptions, "terminalHost" | "localRunner">): { host: TerminalHost | null; problem: string | null } {
  if (options.terminalHost !== undefined) return { host: options.terminalHost, problem: options.terminalHost === null ? "Terminals are off on this console." : null };
  const database = store.isDemo() ? null : store.databaseFile();
  if (options.localRunner === undefined || database === null || database === "") return { host: null, problem: "Terminals run on the computer that runs your agents. Open Toolroll there." };
  const spawn = loadPtySpawn();
  if (spawn === null) return { host: null, problem: "This install has no terminal support (the optional @lydell/node-pty package didn't load). Reinstall Toolroll to add it." };
  const ledger = openTerminalLedger(store.raw());
  // A take-over's PATH leaves out every folder a build may write: the projects Toolroll knows and its own state folder
  // (build worktrees, live copies, evidence); the console's own projects are added once its runtime exists
  // (createTerminalHandlers).
  const buildWritable = () => [dirname(database), ...store.knownRepos()];
  return { host: new TerminalHost({ spawn, worktreeRoot: join(dirname(database), "live-worktrees"), buildWritable, ...(ledger === null ? {} : { ledger }) }), problem: null };
}

type Operator = Who & { via: "cookie" };

export function createTerminalHandlers(runtime: ServerRuntime, deps: TerminalDeps) {
  const { store, codingActorAllowed, codingProjectAllowed, liveCeiling } = runtime;
  const transportOfRequest = (request: IncomingMessage): Transport => transportOf({ peer: request.socket.remoteAddress, joinSource: deps.forwardedSourceOf(request),
    forwardedProto: request.headers["x-forwarded-proto"], forwarded: request.headers["forwarded"] });
  const sockets = new Set<WebSocket>();
  // Easy-start C2: a page offers `toolroll` and, on a protected loopback install, `toolroll.key.<key>`; only `toolroll` is
  // ever selected, so the key is never echoed.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(KEY_PROTOCOL) ? KEY_PROTOCOL : false });

  /** A local owner's session that still stands now (local mode on at its generation, its owner and account unchanged,
   * its saved session held) on an install that is solo now; both read at every call. */
  const localOwnerNow = (who: Operator): boolean => {
    const hash = runtime.sessions.hashOf(who.session);
    return who.session.localGeneration !== null && hash !== null && soloNow(store)
      && localOwnerStandsNow(store, { account: who.name, localGeneration: who.session.localGeneration, accountGeneration: who.session.generation,
        transport: "browser", act: "take-over", sessionHash: hash, request: null });
  };
  /** An operator signed in with a browser, of the generation they signed in with; else null. Easy-start C1 kept a local
   * owner's session out entirely; T4 admits one only while the install is solo and its local sign-in stands. */
  const operatorOf = (who: Who | null): Operator | null => {
    if (who?.via !== "cookie" || who.role !== "approver" || store.isDemo() || !codingActorAllowed({ name: who.name, generation: who.session.generation })) return null;
    if (who.authority === "full") return who;
    return who.authority === "local-owner" && localOwnerNow(who) ? who : null;
  };
  /** The project a terminal works in is one the coding workspace admits for this person, now. */
  const projectAllowed = (name: string, repo: string): boolean =>
    rowVisible(liveCeiling(), repo) && store.accountCanAccess(name, repo) && codingProjectAllowed(repo);
  /** The terminal is this session's kind of owner's: the same account and generation, and the same local generation (a
   * full session's terminal has none), so a local owner and a full session never reach each other's. */
  const owned = (who: Operator, terminal: TerminalSummary | null): terminal is TerminalSummary =>
    terminal !== null && terminal.owner === who.name && terminal.generation === who.session.generation
    && terminal.localGeneration === (who.authority === "full" ? null : who.session.localGeneration);
  /** A terminal this person may reach now: theirs, and its project still admitted (an agent's own sign-in or install
   * has no project: being theirs is the whole rule). */
  const reachable = (who: Operator, terminal: TerminalSummary | null, request: IncomingMessage): terminal is TerminalSummary =>
    owned(who, terminal) && (terminal.agent !== null ? workbenchNow(request, who) : projectAllowed(who.name, terminal.repo));
  /**
   * An agent's own sign-in or install is the terminal workbench's alone (the person at this computer in their own
   * terminal): the session the workbench redeemed (its key epoch `terminal:<this console start>`, written only by the
   * terminal link's redemption, mutation-key.ts issueForClient), a local owner's, on a solo install, over a direct
   * loopback request with no proxy header. Every fact is the server's own; no header a client sends decides it. Read at
   * the start, right before the spawn, at the socket's upgrade and at every re-proof.
   */
  /** The terminal workbench's own session, on this console start: its cached copy AND its saved row carry this start's
   * terminal epoch (the saved row read now, so a session another process re-keyed or ended stops here too). */
  const workbenchNow = (request: IncomingMessage, who: Who | null): boolean => {
    if (who?.via !== "cookie" || who.authority !== "local-owner") return false;
    const epoch = `${TERMINAL_EPOCH}${runtime.keyEpoch}`;
    if (who.session.keyEpoch !== epoch) return false;
    const hash = runtime.sessions.hashOf(who.session);
    if (hash === null || store.webSession(hash)?.keyEpoch !== epoch) return false;
    return soloNow(store) && runtime.fromThisComputer(request) && operatorOf(who) !== null;
  };
  const record = (event: string, who: string, terminal: { id: string; repo: string; program: TerminalProgram }) =>
    logEvent("info", `terminal.${event}`, { actor: who, terminal: terminal.id, repo: terminal.repo, program: terminal.program });

  const json = (ctx: HandlerContext, status: number, value: unknown) => respond(ctx.response, status, "application/json", JSON.stringify(value));
  /** The answers a terminal client reads (engine-api.ts termState, termStarted, refusal), checked as they are sent. */
  const checked = (ctx: HandlerContext, status: number, name: EngineResponseName, value: unknown) => json(ctx, status, checkEngineResponse(name, value));
  /** Said to anything but the terminal workbench's own session asking for an agent's sign-in or install pane. */
  const WORKBENCH_ONLY = "Sign in to agents from your own terminal: run toolroll there";
  /** Said to a local owner's session on an install that isn't solo (or whose local sign-in lapsed). */
  const LOCAL_TEAM = "Taking over works while you're the only person using this Toolroll. Set a password (run `toolroll password set`) and sign in with it.";
  const refusal = (ctx: HandlerContext): string | null => {
    if (operatorOf(ctx.who) === null) return ctx.who?.via === "cookie" && ctx.who.authority === "local-owner" ? LOCAL_TEAM : "Terminals are for installation-wide operators signed in with a browser.";
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
    const document = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><meta name="theme-color" content="#0C0E12"><meta name="apple-mobile-web-app-capable" content="yes"><title>Terminals — Toolroll</title><link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/assets/terminal.css"></head><body><div id="so-term"></div><div id="so-term-boot" hidden data-csrf="${(who as Operator).session.csrf}" data-session="${id}" data-passwordless="${sessionStandsIn(store) || (who as Operator).authority === "local-owner" ? "1" : ""}"></div><script type="module" src="/assets/terminal.js" nonce="${nonce}"></script></body></html>`;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      // The socket is this page's own host: named outright, since older WebKit doesn't read 'self' as ws:/wss:.
      "Content-Security-Policy": `default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; manifest-src 'self'; script-src 'nonce-${nonce}'; connect-src 'self' ws://${host} wss://${host}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
    response.end(htmlString(document));
  }

  async function state(ctx: HandlerContext): Promise<void> {
    const who = operatorOf(ctx.who);
    if (who === null) return checked(ctx, 403, "refusal", { error: "operator" });
    const sessions = deps.host === null ? [] : deps.host.list(who.name).filter(one => one.agent === null && owned(who, one) && projectAllowed(who.name, one.repo));
    return checked(ctx, 200, "termState", {
      available: deps.host !== null, problem: deps.host === null ? deps.problem ?? "Terminals aren't available on this install." : null,
      programs: [...TERMINAL_PROGRAMS],
      projects: runtime.consoleProjects().filter(repo => projectAllowed(who.name, repo)).map(path => ({ path, name: projectName(path) })),
      sessions: sessions.map(one => ({ id: one.id, repo: one.repo, project: projectName(one.repo), program: one.program, branch: one.branch, startedAt: one.startedAt, endedAt: one.endedAt,
        exit: one.exit, cleanup: one.cleanup, task: one.task, run: one.run })),
    });
  }

  /**
   * A take-over's build (T4): any builder/scout run of this task still in view, with the commit Toolroll recorded for
   * it (its saved head commit, or the base commit it started from if it failed or is still running), and the project
   * Toolroll records for its task. Read from the store only; the caller named only the task and the build.
   */
  const takeOverOf = (taskId: string, runId: number): { repo: string; revision: string; run: Run; family: TaskFamily } | string => {
    const family = runtime.familyOf(taskId);
    if (family === null || family.problem !== null) return "No such task.";
    const run = takeOverRunsOf(store, family).filter(one => runtime.runVisible(one)).find(one => one.id === runId) ?? null;
    if (run === null) return SHELL_NO_RESULT;
    const revision = takeOverRevisionOf(run);
    if (revision === null) return SHELL_NO_COMMIT;
    const repo = runtime.taskRepoOf(run.taskRef);
    if (repo === null) return "This build's project isn't known here.";
    return { repo, revision, run, family };
  };

  /** Plain task context for an interactive agent (`claude` / `codex`) opened on a task build. */
  const takeOverPromptOf = (family: TaskFamily, run: Run): string => {
    const lines = [`Task: ${family.root.title}`];
    const goal = store.getScope(family.current.id)?.goal?.trim() ?? "";
    if (goal !== "" && goal !== family.root.title.trim()) lines.push(`Goal: ${goal.slice(0, 400)}`);
    if (run.finishedAt === null) {
      lines.push("Status: background build is still running; you are on an isolated copy of its commit.");
    } else if (run.outcome === "failed" || run.outcome === "refused") {
      lines.push(`Last build failed: ${failedAttemptSentence(run.reason)}`);
      const said = agentSaidOf(store, run.id);
      if (said !== null && said.length > 0) lines.push(`Last output:\n${said.slice(-4).join("\n")}`);
    } else if (run.headRevision !== null) {
      lines.push("Status: inspecting saved build changes on an isolated copy of its commit.");
    }
    lines.push("Help inspect what happened and take it from here.");
    return lines.join("\n").slice(0, 1200);
  };

  async function start(ctx: HandlerContext): Promise<void> {
    const answer = (status: number, value: { ok: true; id: string } | { ok: false; error: string }) => checked(ctx, status, "termStarted", value);
    const refused = refusal(ctx);
    if (refused !== null) return answer(403, { ok: false, error: refused });
    const who = ctx.who as Operator;
    const body = readForm(ctx.posted, CONSOLE_FORMS.term);
    if ([...new Set(body.keys())].some(key => body.sent.getAll(key).length !== 1)) return answer(400, { ok: false, error: "Submit one value for each field." });
    const program = body.get("program") ?? "";
    if (!(TERMINAL_PROGRAMS as readonly string[]).includes(program)) return answer(400, { ok: false, error: "Choose Claude Code, Codex or a shell." });
    // A take-over names its task and build, and nothing else: no project, no folder. Either both, or neither.
    const taskField = body.get("task"), runField = body.get("run");
    if ((taskField === null) !== (runField === null)) return answer(400, { ok: false, error: "Name the task and its build." });
    let from: { revision: string; task: string; run: number; prompt?: string } | null = null, repo: string;
    if (taskField !== null && runField !== null) {
      if (body.get("repo") !== null || !/^[1-9][0-9]{0,14}$/.test(runField) || taskField === "" || taskField.length > 200) return answer(400, { ok: false, error: "Name the task and its build." });
      const found = takeOverOf(taskField, Number(runField));
      if (typeof found === "string") return answer(404, { ok: false, error: found });
      from = {
        revision: found.revision,
        task: taskField,
        run: Number(runField),
        ...(program === "shell" ? {} : { prompt: takeOverPromptOf(found.family, found.run) }),
      };
      repo = found.repo;
    } else repo = body.get("repo") ?? "";
    if (!runtime.consoleProjects().includes(repo) || !projectAllowed(who.name, repo)) return answer(403, { ok: false, error: "Choose a project available to your account." });
    // The organisation's policy decides whether this provider may run in a person's own session.
    if (program !== "shell") {
      const stopped = store.sessionPolicyRefusal(program, null, "live terminals");
      if (stopped !== null) return answer(403, { ok: false, error: stopped });
    }
    const proved = runtime.authenticateApprover(who, body.get("password") ?? "");
    if (!proved.ok) return answer(403, { ok: false, error: "Enter your Toolroll password to start a terminal." });
    // A local owner's start is proved only by its own prover (never a typed password or Passwordless), and a full
    // session's never by that one.
    if ((proved.method === "local-owner") !== (who.authority !== "full")) return answer(403, { ok: false, error: "Your access changed. Sign in again." });
    // The same session, still an operator of the same generation, and the project still theirs: asked right before the
    // program starts (after the slow worktree work) and again once it has. A start the session alone proved (solo or
    // Passwordless, install-mode.ts) also needs the session to stand in still: a person who joined, or Passwordless
    // turned off, during the preparation refuses it.
    const stillAllowed = (): string | null => {
      const again = rereadBrowser(runtime, ctx.request, who);
      if (again === null || operatorOf(again) === null) return "Your access changed. Sign in again.";
      if (proved.method === "session" && !sessionStandsIn(store)) return "This install's sign-in rules changed. Enter your Toolroll password to start a terminal.";
      // A local owner's (operatorOf above read solo and the local sign-in again): its own proof, still standing.
      if (proved.method === "local-owner" && (again.authority !== "local-owner" || again.session.localGeneration !== who.session.localGeneration)) return "Your access changed. Sign in again.";
      if (!projectAllowed(who.name, repo) || !runtime.consoleProjects().includes(repo)) return "That project is no longer available to your account.";
      // A take-over's build: still a result of the task, in view, at the same commit, in the same project.
      if (from !== null) {
        const now = takeOverOf(from.task, from.run);
        if (typeof now === "string" || now.repo !== repo || now.revision !== from.revision) return "This build changed. Look again.";
      }
      return null;
    };
    try {
      const owner = { name: who.name, generation: who.session.generation, localGeneration: who.authority === "full" ? null : who.session.localGeneration };
      const terminal = await deps.host!.start(owner, repo, program as TerminalProgram, undefined, stillAllowed, from);
      const after = stillAllowed();
      if (after !== null) {
        // Nothing of it stays: the program is swept, then its worktree removed (a sweep that can't prove itself keeps it).
        await deps.host!.close(terminal.id);
        await deps.host!.remove(terminal.id).catch(() => {});
        return answer(403, { ok: false, error: after });
      }
      record("start", who.name, terminal);
      return answer(200, { ok: true, id: terminal.id });
    } catch (error) {
      return answer(409, { ok: false, error: error instanceof TerminalError ? error.message : "The terminal didn't start." });
    }
  }

  /**
   * POST /term/agent/sign-in, /term/agent/install (the Agents screen): an agent's OWN sign-in (or install) for the
   * person at this computer, in a pane. Admitted as a terminal is (an installation-wide operator's browser session, or
   * a local owner's on a solo install, proved by its own `agent-sign-in` / `agent-install` act; never a token, a chat
   * or another computer: the route takes cookies only and the socket re-proves all of it). What runs is Toolroll's own:
   * the agent's command from AGENT_SETUP (never text from the request beyond the agent's id), started by the real path
   * of a trusted install found on PATH exactly as the sign-in checks find it (status-probe.ts resolveStatusBinary: an
   * untrusted first match runs nothing, a later one is never tried), with an environment built from nothing (the
   * person's real HOME, so the agent keeps its own login; trusted PATH folders; no Toolroll credential, no token), from
   * a fresh empty folder outside every project. An install runs only when the form carries exactly the command shown
   * (`confirm`). When the program ends, this computer's agents are looked for again.
   */
  const agentStart = (kind: "sign-in" | "install") => async (ctx: HandlerContext): Promise<void> => {
    const answer = (status: number, value: { ok: true; id: string } | { ok: false; error: string }) => checked(ctx, status, "termStarted", value);
    const refused = refusal(ctx);
    if (refused !== null) return answer(403, { ok: false, error: refused });
    const who = ctx.who as Operator;
    if (!workbenchNow(ctx.request, who)) return answer(403, { ok: false, error: WORKBENCH_ONLY });
    const body = readForm(ctx.posted, CONSOLE_FORMS.termAgent);
    if ([...new Set(body.keys())].some(key => body.sent.getAll(key).length !== 1)) return answer(400, { ok: false, error: "Submit one value for each field." });
    const agentId = body.get("agent") ?? "";
    const setup = agentSetupOf(agentId);
    if (setup === null) return answer(400, { ok: false, error: "Choose an agent Toolroll supports." });
    const run = kind === "sign-in" ? setup.signInRun : setup.installRun;
    const shown = kind === "sign-in" ? setup.signIn : setup.install;
    if (run === null || shown === null) return answer(409, { ok: false, error: kind === "sign-in" ? "This agent signs in another way: its screen says how." : "Toolroll doesn't run this agent's installer: run the command shown in your own terminal." });
    // Downloading software is the person's act: their yes is to exactly the command they were shown.
    if (kind === "install" && body.get("confirm") !== shown) return answer(409, { ok: false, error: "Confirm the exact install command first." });
    // The organisation's policy on running Claude Code or Codex in a person's own session holds for their sign-in too.
    if (agentId === "claude" || agentId === "codex") {
      const stopped = store.sessionPolicyRefusal(agentId, null, "live terminals");
      if (stopped !== null) return answer(403, { ok: false, error: stopped });
    }
    const proved = runtime.authenticateApprover(who, body.get("password") ?? "");
    if (!proved.ok) return answer(403, { ok: false, error: "Enter your Toolroll password to start a terminal." });
    if ((proved.method === "local-owner") !== (who.authority !== "full")) return answer(403, { ok: false, error: "Your access changed. Sign in again." });
    // The program: a trusted install's real path, found as the sign-in checks find it, with their exclusions (every
    // project, worktree and Toolroll's own folder, from Toolroll's records now).
    const source = (deps.agentEnv ?? (() => process.env))();
    const untrusted = await excludedFolders({ store });
    if (untrusted === null) return answer(409, { ok: false, error: "Toolroll couldn't read its own records, so it won't start a program." });
    const trust: StatusTrust = { path: source["PATH"] ?? "", uid: process.getuid?.(), untrusted, acl: boundedAcl(Date.now() + 3_000) };
    const program = run.binary;
    // The program, and for a launcher script its interpreter, each a trusted install: the interpreter's real path runs
    // with the script's (status-probe.ts resolveLaunch), never the script by itself.
    const found = resolveLaunch(program, trust);
    if (!found.ok) return answer(409, { ok: false, error: found.missing ? `\`${program}\` isn't installed on this computer.` : `Toolroll won't run \`${program}\`: ${found.why}.` });
    const env = { ...statusEnvironment(source, trust), PATH: launchPath(found, trust) };
    const stillAllowed = (): string | null => {
      const again = rereadBrowser(runtime, ctx.request, who);
      if (again === null || operatorOf(again) === null) return "Your access changed. Sign in again.";
      if (proved.method === "session" && !sessionStandsIn(store)) return "This install's sign-in rules changed. Enter your Toolroll password to start a terminal.";
      if (proved.method === "local-owner" && (again.authority !== "local-owner" || again.session.localGeneration !== who.session.localGeneration)) return "Your access changed. Sign in again.";
      if (!workbenchNow(ctx.request, again)) return WORKBENCH_ONLY;
      // The program is the one checked: asked again right before it starts, with fresh ACL answers.
      const now = resolveLaunch(program, { ...trust, acl: boundedAcl(Date.now() + 3_000) });
      if (!now.ok || now.real !== found.real || now.file !== found.file) return `\`${program}\` changed while it was being checked. Try again.`;
      return null;
    };
    try {
      const owner = { name: who.name, generation: who.session.generation, localGeneration: who.authority === "full" ? null : who.session.localGeneration };
      const terminal = await deps.host!.startCommand(owner, { id: agentId, kind }, { file: found.file, args: [...found.args, ...run.args] }, env, undefined, stillAllowed,
        () => { void runtime.checkLocalAgents(true); });
      record(`agent-${kind}`, who.name, terminal);
      return answer(200, { ok: true, id: terminal.id });
    } catch (error) {
      return answer(409, { ok: false, error: error instanceof TerminalError ? error.message : "The terminal didn't start." });
    }
  };

  const act = (verb: "close" | "remove") => async (ctx: HandlerContext): Promise<void> => {
    const refused = refusal(ctx);
    if (refused !== null) return json(ctx, 403, { ok: false, error: refused });
    const who = ctx.who as Operator;
    const terminal = deps.host!.get(TERMINAL_ID.exec(ctx.url.pathname)?.[1] ?? "");
    if (!reachable(who, terminal, ctx.request)) return json(ctx, 404, { ok: false, error: "No such terminal." });
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
    // Read without touching: a session ended elsewhere is never written back by being seen (round 2, finding 1).
    const who = operatorOf(runtime.identify(request, false));
    if (who === null || rereadBrowser(runtime, request, who) === null) { refuseUpgrade(socket, 401, "Sign in as an installation-wide operator."); return true; }
    // Easy-start C2: typing into a terminal is a mutation: on a protected loopback install the socket offers the session's
    // key (its protocol list), which a cookie holder on another port can't read.
    const keyed = runtime.browserKeys.check(who, request, null);
    if (keyed !== null) { refuseUpgrade(socket, keyed.status, keyed.message); return true; }
    const terminal = deps.host?.get(id) ?? null;
    if (!reachable(who, terminal, request)) { refuseUpgrade(socket, 404, "No such terminal."); return true; }
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
      const ok = again !== null && operatorOf(again) !== null && reachable(again as Operator, host.get(terminal.id), request);
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
      // T4 review: the host pauses the program while this socket is backed up, and closes it plainly (the same 4008
      // a client says as "Too much output") when it can't be kept whole.
      backlog: () => closed ? 0 : ws.bufferedAmount,
      overflow: () => shut(4008, "fell behind"),
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
      // The program isn't reading: nothing more is queued for it until it does (round 2, finding 5).
      if (!host.input(terminal.id, frame.d)) ws.send(JSON.stringify({ t: "input-full" }));
    });
    ws.on("close", () => { closed = true; detach?.(); reprovers.delete(reprove); sockets.delete(ws); });
    ws.on("error", () => shut(1011, "socket error"));
    if (!prove()) return shut(4401, "signed out");
    try { detach = host.attach(terminal.id, viewer); }
    catch (error) { return shut(error instanceof TerminalError && /open in/.test(error.message) ? 4429 : 4404, "unavailable"); }
    reprovers.add(reprove);
    record("attach", who.name, terminal);
  }

  // The console's projects are build-writable too: kept out of a take-over's PATH (live-terminal.ts trustedPath).
  // (A stand-in host in a test may not have it.)
  deps.host?.alsoBuildWritable?.(runtime.consoleProjects);
  deps.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!upgrade(request, socket, head)) socket.destroy();
  });

  return {
    registrations: handlersOf("tasks", {
      "term.page": page,
      "term.session": async (ctx: HandlerContext) => page(ctx),
      "term.state": state,
      "term.start": start,
      "term.agent-sign-in": agentStart("sign-in"),
      "term.agent-install": agentStart("install"),
      "term.close": act("close"),
      "term.remove": act("remove"),
      "term.socket": socketWithoutUpgrade,
    }),
    upgrade,
    /** Shutdown: no more attaches, every socket dropped, every program ended (bounded by the host's grace). The problem,
     * when a terminal's processes couldn't be proved stopped. */
    async close(): Promise<Error | null> {
      unsubscribe();
      clearInterval(sweep);
      for (const ws of sockets) ws.terminate();
      sockets.clear();
      wss.close();
      const stopped = await deps.host?.stop();
      if (stopped !== undefined && !stopped.clean) {
        logEvent("error", "terminal.shutdown-uncertain", {});
        // Reported, never thrown: the server still closes, and its close callback carries this (serve.ts).
        return new Error("A live terminal's processes could not be proved stopped. Check for them before replacing Toolroll.");
      }
      return null;
    },
  };
}
