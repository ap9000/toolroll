import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import { repositoryContextRead } from './repository-context.js';
import { ASSIGNMENT_TOOLS, assignmentForCoordinator } from "./assignment-adapters.js";
import { parseContract, toModelSchema } from "./contracts/contract.js";
import { GATEWAY_TOOL_INPUTS, GATEWAY_TOOL_OUTPUTS, type GatewayToolInput, type GatewayToolName } from "./contracts/gateway-tools.js";
import { reportToolOutput } from "./contracts/lead-tools.js";
/**
 * `toolroll mcp` — the MCP stdio server (MCP gateway spec v6).
 *
 * Zero-dep JSON-RPC 2.0 over stdio, newline-delimited; stdout carries
 * protocol bytes ONLY (logs go to stderr); clean EOF is clean shutdown.
 * Two pinned protocol revisions:
 *
 *   - modern `2026-07-28`: stateless; every request carries its version in
 *     `_meta`; `server/discover` describes the server; successful results
 *     are schema-complete (`resultType: "complete"`, and tools/list +
 *     discover carry `ttlMs: 0` with the narrowest `cacheScope`).
 *   - legacy `2025-11-25`: the initialize era — a client asking for an
 *     unsupported version is answered WITH this one (negotiation, not
 *     refusal); `notifications/initialized` is received and ignored. The
 *     eras never cross: initialize never counter-offers the modern one.
 *
 * No JSON-RPC batching in either era (arrays reject). A cancellation is a
 * notification: the server stops work on that id and suppresses its
 * response entirely. Limits: request ≤ 256 KiB, JSON depth ≤ 32.
 *
 * EVERY tool call authenticates the coordinator credential; the schema
 * version is re-read per call (a concurrent migration refuses in words
 * and the server exits). Protocol errors are JSON-RPC errors; tool-level
 * refusals are successful `tools/call` results with `isError: true`.
 */

import { PACKAGE_VERSION } from "./version.js";
import type { Store } from "./store.js";
import {
  authenticateCoordinator,
  fileCoordinatorProposal,
  statusFor,
  listTasksFor,
  taskDetailFor,
  type VerifiedCoordinator,
} from "./coordinator.js";
import { ISO_STAMP_RULE, decisionOver, decisionsOver, labelRepos, queueOver, recapOver } from "./mate-tools.js";
import { proposeAsCoordinator } from "./coordinator-proposals.js";
import type { CoordinatorProposalKind } from "./store.js";

export const MODERN = "2026-07-28";
export const LEGACY = "2025-11-25";
/** The modern revision namespaces its per-request metadata. */
export const META_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_SERVER = "io.modelcontextprotocol/serverInfo";
export const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
/** The revision's own error code for an unsupported protocol version. */
export const UNSUPPORTED_VERSION = -32022;
const MAX_REQUEST = 256 * 1024;
const MAX_DEPTH = 32;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function depthOf(value: unknown): number {
  // The byte cap bounds the work list. Neither nesting nor array width
  // becomes a JavaScript call stack or a spread argument list.
  const pending = [{ value, depth: 0 }];
  let maximum = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_DEPTH) return current.depth;
    maximum = Math.max(maximum, current.depth);
    if (current.value !== null && typeof current.value === "object") {
      const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
      for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return maximum;
}

/** One handler per tool; its input is GATEWAY_TOOL_INPUTS[name]
 * (src/contracts/gateway-tools.ts) — THE source for parsing and inputSchema.
 * Output is built field-by-field; spreading a database row into a result is
 * forbidden in this module (arch-tested). */
type ToolContext = {
  store: Store;
  who: VerifiedCoordinator;
  /** The installation's enrolled repos (repos.json), when the launcher
   * knows them — list_repos answers allowlist ∩ enrolled. null = the
   * launcher could not read the registry; the allowlist alone answers. */
  enrolled: readonly string[] | null;
  /** The raw credential, per-SERVER closure state — never module state:
   * two serveMcp instances in one process must not cross credentials
   * (implementation review, finding 5). Filing re-authenticates with it
   * inside its own transaction. */
  token: string;
  now: Date;
  /** Decisions this connection read with get_decision — propose_answer needs one. */
  readDecisions: Set<number>;
  /** Where evidence lives, when the launcher knows — get_task reads a scout's report from here. */
  evidenceRoot?: string;
};

type Answer = { ok: true; body: Json } | { ok: false; message: string };
type Handler<N extends GatewayToolName> = { description: string; handle: (ctx: ToolContext, args: GatewayToolInput<N>) => Answer };
type Tool = { name: GatewayToolName; description: string; inputSchema: Json; handle: (ctx: ToolContext, args: Record<string, unknown>) => Answer };

const CONTRACT_GUIDE = [
  "Toolroll MCP contract.",
  "You hold a coordinator credential: you may read inside your repo allowlist, file proposals, and record assignment ownership and receipt checks. Ownership and receipt checks grant no execution or approval authority.",
  "A filed proposal is an ordinary unapproved task: it is quarantined from planning, claiming, and running until the operator signs its scope in a password ceremony that shows them who asked. Modes never auto-admit coordinator filings.",
  "file_proposal requires an idempotency_key (8-64 printable chars, unique per request): replaying the same key+request returns the original task; the same key with a different request refuses. deliverable 'report' files a scout task: a read-only investigation whose only output is a report on the task page, never a branch.",
  "You are rate-limited per hour and capped on outstanding unapproved filings. Refusals say the limit and the road in words.",
  "recap, list_decisions, get_decision, and queue are the plane's own read queries (shared with the operator's mate). get_decision shows each option's consequence, never the builder's recommendation.",
  "propose_next, propose_reserve, propose_hold, propose_unhold, propose_scope, propose_cancel, and propose_answer write a PROPOSAL row and nothing else: an approver confirms it on the console or the CLI, and a stale one refuses there. Proposals share your hourly filing rate and hold at most 20 pending per credential; they expire after seven days.",
  "Approve, steer, answer, pick, mint, configure, merge: those verbs do not exist on this surface, by construction.",
  "Claim one assignment, then follow list_assignment_updates with a saved cursor; inspect get_assignment when a current result or decision needs attention. claim_assignment records its lead; acknowledge_assignment records that lead's check of an exact ready receipt. Neither operation grants authority, accepts proof, answers decisions, approves work, publishes, or deploys.",
].join("\n");

/** An assignment tool: the adapter reads its call with the same schema `toolroll assignment` does. */
const assignmentHandler = (operation: (typeof ASSIGNMENT_TOOLS)[number]["operation"]) => (ctx: ToolContext, args: Record<string, unknown>): Answer => {
  const result = assignmentForCoordinator(ctx.store, ctx.token, operation, args, ctx.now, ctx.evidenceRoot);
  return result.ok ? { ok: true as const, body: result.body as unknown as Json } : { ok: false as const, message: `${result.reason}: ${result.message}` };
};
const assignmentTool = (name: GatewayToolName) => {
  const spec = ASSIGNMENT_TOOLS.find(one => one.name === name)!;
  return { description: spec.description, handle: assignmentHandler(spec.operation) };
};

/** A propose_* tool: it writes one proposal row through the coordinator door. */
const proposeTool = (kind: CoordinatorProposalKind, description: string) => ({
  description,
  handle: (ctx: ToolContext, args: Record<string, unknown>): Answer => {
    const outcome = proposeAsCoordinator(ctx.store, ctx.token, kind, args, ctx.now, { readDecisions: ctx.readDecisions });
    if (!outcome.ok) return { ok: false, message: outcome.message };
    return { ok: true, body: { proposal: outcome.id, kind: outcome.kind, awaiting: outcome.awaiting } };
  },
});

const HANDLERS: { [N in GatewayToolName]: Handler<N> } = {
  get_project_context: {
    description: 'Read bounded source excerpts or advisory static import impact in an admitted project. Falls back to text search without an index.',
    handle: (ctx, args) => {
      const repo = args.repo;
      if (!ctx.who.repos.includes(repo) || ctx.enrolled !== null && !ctx.enrolled.includes(repo)) return { ok: false, message: 'That project is outside your access.' };
      return { ok: true, body: repositoryContextRead({ repo, query: args.query, mode: args.mode === 'impact' ? 'impact' : 'search', audience: 'lead',
        ...(ctx.evidenceRoot === undefined ? {} : { cacheRoot: join(dirname(ctx.evidenceRoot), 'repository-context') }) }) as unknown as Json };
    },
  },
  get_assignment: assignmentTool("get_assignment"),
  list_assignment_updates: assignmentTool("list_assignment_updates"),
  claim_assignment: assignmentTool("claim_assignment"),
  acknowledge_assignment: assignmentTool("acknowledge_assignment"),
  get_assignment_brief: assignmentTool("get_assignment_brief"),
  get_assignment_inbox: assignmentTool("get_assignment_inbox"),
  acknowledge_assignment_delivery: assignmentTool("acknowledge_assignment_delivery"),
  status: {
    description: "The plane's liveness facts over your repo allowlist: what waits on the operator, what runs, what finished in the last 24h.",
    handle: ctx => ({ ok: true, body: statusFor(ctx.store, ctx.who, ctx.now) as unknown as Json }),
  },
  list_tasks: {
    description: "Tasks in your repo allowlist. Filter by state and repo; cursor-paginated, stable order.",
    handle: (ctx, args) => {
      const filter: { state?: string; repo?: string; cursor?: number; limit?: number } = {};
      if (args.state !== undefined) filter.state = args.state;
      if (args.repo !== undefined) filter.repo = args.repo;
      if (args.cursor !== undefined) filter.cursor = args.cursor;
      if (args.limit !== undefined) filter.limit = args.limit;
      return { ok: true, body: listTasksFor(ctx.store, ctx.who, filter, ctx.now) as unknown as Json };
    },
  },
  get_task: {
    description: "One task's deliverable (branch or report), scope standing, filer provenance, attempt ledger, and — for a finished scout — the report's title, summary, and follow-ups. A ref outside your allowlist answers not-found.",
    handle: (ctx, args) => {
      const detail = taskDetailFor(ctx.store, ctx.who, args.ref, ctx.evidenceRoot, ctx.now);
      if (detail === null) return { ok: false, message: `not-found: no task \`${args.ref}\` in your repositories` };
      return { ok: true, body: detail as unknown as Json };
    },
  },
  list_repos: {
    description: "The repositories your credential may see and file into, with their operating-mode standing.",
    handle: ctx => {
      // FAIL CLOSED when the project registry cannot be read (round-2
      // finding 4): answering the full allowlist would claim enrollment
      // nobody proved.
      if (ctx.enrolled === null) {
        return { ok: false, message: "the project registry could not be read — the enrolled set is unknown, so nothing lists" };
      }
      return {
      ok: true,
      body: {
        repos: ctx.who.repos
          .filter(repo => ctx.enrolled !== null && ctx.enrolled.includes(repo))
          .map(repo => {
            const mode = ctx.store.activeMode(repo, ctx.now);
            return { repo, mode: mode === null ? "no operating mode — every act is a ceremony" : `mode ${mode.name} signed until ${mode.absoluteExpiry}` };
          }),
      },
      };
    },
  },
  recap: {
    description: "How things stand per repository in your allowlist, counts and ids: what waits on the operator (decisions, incidents, scopes awaiting approval), what runs, what is queued, finished, failed. Pass `since` (an ISO timestamp) to count only decisions, incidents, and attempts newer than it, to the hour; queued work and scopes awaiting approval always count.",
    handle: (ctx, args) => {
      const since = args.since;
      if (since !== undefined && (!ISO_STAMP_RULE.test(since) || Number.isNaN(Date.parse(since)))) {
        return { ok: false, message: "since is an ISO timestamp like 2026-09-02T12:00:00Z" };
      }
      return { ok: true, body: labelRepos(recapOver(ctx.store, ctx.who.repos, ctx.now, since ?? null), index => ctx.who.repos[index] ?? "") as unknown as Json };
    },
  },
  list_decisions: {
    description: "Open decisions in your allowlist: id, task, question, options (id, label, reversible), age in hours. Never consequences or recommendations; the operator answers them.",
    handle: ctx => ({ ok: true, body: labelRepos(decisionsOver(ctx.store, ctx.who.repos, ctx.now), index => ctx.who.repos[index] ?? "") as unknown as Json }),
  },
  queue: {
    description: "One repository's queue by column — the shared column, then each worker's reserved column — each in dispatch order.",
    handle: (ctx, args) => {
      const repo = args.repo;
      if (!ctx.who.repos.includes(repo)) return { ok: false, message: "not-found: that repository is not in your allowlist" };
      // The installation-wide revision stays home (slice-2 review, finding
      // 12): a coordinator cannot move queues, and the counter would tell it
      // about repos it may not see.
      const { queueRevision: _revision, ...columns } = queueOver(ctx.store, repo, ctx.now);
      return { ok: true, body: { repo, ...columns } as unknown as Json };
    },
  },
  get_decision: {
    description: "One open decision in your allowlist in full: question, options with id, label, reversible, and consequence. Never the builder's recommendation.",
    handle: (ctx, args) => {
      const found = decisionOver(ctx.store, ctx.who.repos, args.decision, ctx.now);
      if (found === null) return { ok: false, message: "not-found: no such decision in your repositories" };
      ctx.readDecisions.add(args.decision);
      return { ok: true, body: labelRepos(found, index => ctx.who.repos[index] ?? "") as unknown as Json };
    },
  },
  propose_next: proposeTool("next", "Propose moving a queued task to the front of its column. An approver confirms; a queue that moved meanwhile refuses."),
  propose_reserve: proposeTool("reserve", "Propose reserving a queued task for one worker, or releasing it to the shared queue with worker null."),
  propose_hold: proposeTool("hold", "Propose holding a task's next attempt, with a reason. A running attempt is never interrupted."),
  propose_unhold: proposeTool("unhold", "Propose lifting the operator's own hold on a task."),
  propose_scope: proposeTool("scope", "Propose rewriting a task's scope. An approver confirms the rewrite, then approves it with a password — a scope you wrote never seals under a mode."),
  propose_cancel: proposeTool("cancel", "Propose cancelling a task, with a reason. The approver arms and confirms it on the task itself."),
  propose_answer: proposeTool("answer", "Propose an answer to an open decision you read with get_decision, with a rationale. The approver confirms where every consequence and the builder's recommendation are shown; an irreversible option needs their explicit confirmation."),
  get_contract: {
    description: "This surface's contract: what a coordinator may do, the proposal lifecycle, and the admission promise.",
    handle: () => ({ ok: true, body: { contract: CONTRACT_GUIDE } }),
  },
  file_proposal: {
    description: "File a task proposal into one of your repositories. It stays quarantined until the operator signs its scope.",
    handle: (ctx, args) => {
      // The token, not the pre-verified identity: filing re-authenticates
      // INSIDE its own transaction (the session's `who` is a courtesy).
      const outcome = fileCoordinatorProposal(
        ctx.store,
        ctx.token,
        { repo: args.repo, title: args.title, ...(args.intent === undefined ? {} : { intent: args.intent }), ...(args.deliverable === undefined ? {} : { deliverable: args.deliverable }), idempotencyKey: args.idempotency_key },
        ctx.now,
      );
      if (!outcome.ok) return { ok: false, message: outcome.message };
      return {
        ok: true,
        body: {
          ref: outcome.id,
          replayed: outcome.replayed,
          admission: "quarantined until the operator signs its scope — the ceremony shows them your name",
        },
      };
    },
  },
};

/** The gateway's tools in tools/list order, each inputSchema derived from its contract. */
const TOOLS: Tool[] = (Object.keys(GATEWAY_TOOL_INPUTS) as GatewayToolName[]).map(<N extends GatewayToolName>(name: N): Tool => {
  const handler = HANDLERS[name] as Handler<N>;
  return { name, description: handler.description, inputSchema: toModelSchema(GATEWAY_TOOL_INPUTS[name]) as Json, handle: (ctx, args) => handler.handle(ctx, args as GatewayToolInput<N>) };
});

export type McpIo = {
  onLine: (handler: (line: string) => void) => void;
  onEof: (handler: () => void) => void;
  write: (line: string) => void;
  log: (line: string) => void;
  exit: (code: number) => void;
};

export type McpOutcome =
  | { ok: true }
  | { ok: false; reason: "unauthenticated" | "revoked" | "schema"; message: string };

type FileIdentity = { path: string; dev: number; ino: number };
function fileIdentity(path: string | null): FileIdentity | null {
  if (path === null) return null;
  try { const at = statSync(path); return { path, dev: at.dev, ino: at.ino }; } catch { return null; }
}
/** Still the same file at the same path: not moved aside, deleted, or replaced by a rename. */
function sameFile(was: FileIdentity): boolean {
  const now = fileIdentity(was.path);
  return now !== null && now.dev === was.dev && now.ino === was.ino;
}

/** Serve until EOF. The store is already open through the non-migrating
 * door; the token was startup-verified by the caller (and dies here again
 * if it does not hold). */
export function serveMcp(
  store: Store,
  token: string,
  io: McpIo,
  clock: () => Date = () => new Date(),
  enrolled: readonly string[] | null = null,
  evidenceRoot?: string,
): McpOutcome {
  /** Per connection: which decisions this credential read in full (v3). */
  const readDecisions = new Set<number>();
  /** The database file this server opened, by identity (null in memory). */
  const database = fileIdentity(store.databaseFile());
  const auth = authenticateCoordinator(store, token);
  if (!auth.ok) {
    return {
      ok: false,
      reason: auth.reason === "revoked" || auth.reason === "expired" ? "revoked" : "unauthenticated",
      message:
        auth.reason === "revoked" ? "this coordinator credential was revoked — mint a new one"
          : auth.reason === "expired" ? "this coordinator credential expired — mint a new one"
          : "no live coordinator credential matches this token",
    };
  }
  // Cancellation semantics on a SERIAL server (round-2 finding 2, stated
  // rather than pretended): every request completes before the next line
  // is read, so no cancellation can arrive while its target is genuinely
  // in flight — and the revision permits ignoring cancellations for
  // completed requests. The registry exists so any future asynchronous
  // tool inherits correct suppression, and so a pre-cancelled FUTURE id
  // can never be blacklisted (the in-flight check).
  const cancelled = new Set<string>();
  const inFlight = new Set<string>();
  // Legacy lifecycle state (review finding 2): initialize must come first
  // in the handshake era; the modern era is stateless by design.
  let initializeSeen = false;
  let legacyReady = false;
  // Stdio pins ONE era per connection (round-2 finding 2): the first
  // era-classified request decides, and the other era's metadata refuses.
  let pinnedEra: "modern" | "legacy" | null = null;

  const error = (id: Json, code: number, message: string): void =>
    io.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));

  const respond = (id: Json, era: "modern" | "legacy", result: Record<string, Json>, cacheable: boolean): void => {
    if (id !== null && cancelled.has(JSON.stringify(id))) return; // suppressed entirely
    const complete: Record<string, Json> =
      era === "modern"
        ? { ...result, resultType: "complete", ...(cacheable ? { ttlMs: 0, cacheScope: "private" } : {}) }
        : result;
    io.write(JSON.stringify({ jsonrpc: "2.0", id, result: complete }));
  };

  const toolsPayload = (): Json => ({
    // No outputSchema: MCP output schemas describe structuredContent, and
    // these tools return text content only (round-2 finding 1).
    tools: TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  });

  const callTool = (id: Json, era: "modern" | "legacy", params: Record<string, unknown>): void => {
    // A restore or rollback puts a different file at the database's path: this server's connection still reads and
    // writes the one it replaced, so it answers nothing more and exits (the agent starts it again on the new one).
    if (database !== null && !sameFile(database)) {
      error(id, -32000, "the database was replaced underneath this server (a Toolroll restore or rollback) — restart it");
      io.exit(0);
      return;
    }
    // ONE snapshot per call (review finding 3): the version check, the
    // credential re-read, and every data read share a transaction, so a
    // concurrent migration cannot slip between them; filing's own
    // BEGIN IMMEDIATE reenters this one. A moved schema refuses in words
    // and the server exits clean.
    store.transact(() => {
    if (!store.schemaCurrent()) {
      error(id, -32000, "the database schema moved underneath this server — restart it");
      io.exit(0);
      return;
    }
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const tool = TOOLS.find(one => one.name === name);
    if (tool === undefined) {
      error(id, -32602, `no tool \`${name}\``);
      return;
    }
    // tools/list visibility is presentation — authorization happens HERE,
    // on every call, against the live credential row.
    const session = authenticateCoordinator(store, token);
    if (!session.ok) {
      error(id, -32000, "this credential no longer stands — the server exits");
      io.exit(0);
      return;
    }
    // Only an ABSENT `arguments` defaults to empty (round-3 finding 2): an
    // explicit null is not the optional-object shape MCP defines.
    const rawArgs = params["arguments"] === undefined ? {} : params["arguments"];
    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
      // The root of `arguments` is an object BEFORE any schema applies
      // (round-2 finding 2): 42 or false never passes an empty schema.
      error(id, -32602, "arguments must be an object");
      return;
    }
    // The call is read by the schema tools/list advertised (review finding
    // 2): unknown fields, bad types, bad enums, and bound violations are
    // protocol errors (InvalidParams) naming each path, never tool refusals.
    const read = parseContract<Record<string, unknown>>(GATEWAY_TOOL_INPUTS[tool.name] as never, rawArgs);
    if (!read.ok) {
      error(id, -32602, read.issues.map(one => one.line).join("; "));
      return;
    }
    const answered = tool.handle({ store, who: session.who, token, enrolled, now: clock(), readDecisions, ...(evidenceRoot === undefined ? {} : { evidenceRoot }) }, read.value);
    if (!answered.ok) {
      respond(id, era, { content: [{ type: "text", text: answered.message }], isError: true }, false);
      return;
    }
    // Checked against its output schema before delivery; a disagreement is reported, never refused.
    reportToolOutput("gateway", tool.name, GATEWAY_TOOL_OUTPUTS[tool.name], answered.body);
    respond(id, era, { content: [{ type: "text", text: JSON.stringify(answered.body) }] }, false);
    });
  };

  io.onLine(line => {
    if (line.trim() === "") return;
    if (Buffer.byteLength(line, "utf8") > MAX_REQUEST) {
      error(null, -32600, "request over 256 KiB");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      error(null, -32700, "parse error");
      return;
    }
    if (Array.isArray(message)) {
      // Batching left MCP in 2025-06-18 — neither pinned era accepts it.
      error(null, -32600, "JSON-RPC batching is not part of MCP — send one request per line");
      return;
    }
    if (message === null || typeof message !== "object" || depthOf(message) > MAX_DEPTH) {
      error(null, -32600, "invalid request");
      return;
    }
    const request = message as Record<string, unknown>;
    if (request["jsonrpc"] !== "2.0") {
      error(null, -32600, 'jsonrpc must be "2.0"');
      return;
    }
    // A notification is the message that carries NO id — the method name
    // never decides (round-3 finding 3): notifications/initialized WITH an
    // id is a malformed message, not a quiet notification. MCP RequestId is
    // a string or an INTEGER (round-2 finding 2): floats, null, and object
    // shapes refuse wherever an id appears.
    const hasId = "id" in request;
    const rawId = request["id"];
    if (hasId && (rawId === null || (typeof rawId !== "string" && !(typeof rawId === "number" && Number.isInteger(rawId))))) {
      error(null, -32600, "id must be a string or an integer");
      return;
    }
    const method = typeof request["method"] === "string" ? request["method"] : "";
    if (method.startsWith("notifications/")) {
      if (hasId) {
        error(rawId as Json, -32600, "a notification carries no id");
        return;
      }
    } else if (!hasId) {
      error(null, -32600, "a request carries an id — a string or an integer");
      return;
    }
    const id = (rawId ?? null) as Json;
    const params = (request["params"] ?? {}) as Record<string, unknown>;
    const meta = (params["_meta"] ?? {}) as Record<string, unknown>;

    // Every method — lifecycle included — refuses on a moved schema
    // (review finding 3): a server that answers discover from one world
    // and tools from another is lying to somebody.
    if (!store.schemaCurrent()) {
      error(id, -32000, "the database schema moved underneath this server — restart it");
      io.exit(0);
      return;
    }

    if (method === "notifications/cancelled") {
      // Cancellation touches IN-FLIGHT work only (review finding 2): an id
      // never seen, already answered, or yet to arrive is not cancellable —
      // pre-cancelling the future would let a peer suppress request ids
      // forever.
      const target = params["requestId"];
      if (target !== undefined && inFlight.has(JSON.stringify(target as Json))) {
        cancelled.add(JSON.stringify(target as Json));
      }
      return; // a notification — no reply of any kind
    }
    if (method === "notifications/initialized") {
      // Only a handshake that actually happened completes (round-2 f2).
      if (initializeSeen) legacyReady = true;
      return;
    }
    if (method.startsWith("notifications/")) return; // unknown notification: silence, never an error

    // An unsupported protocol version refuses -32022 with the revision's
    // OWN shape for EVERY request — server/discover included (round-3
    // finding 4): the ask precedes any per-method branch.
    const declared = typeof meta[META_VERSION] === "string" ? (meta[META_VERSION] as string) : null;
    if (declared !== null && declared !== MODERN && declared !== LEGACY) {
      io.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: UNSUPPORTED_VERSION,
            message: `unsupported protocol version \`${declared}\``,
            data: { supported: [MODERN, LEGACY], requested: declared },
          },
        }),
      );
      return;
    }
    // ClientCapabilities is an OBJECT shape (round-3 finding 5): an array
    // is not a capabilities declaration.
    const capabilitiesShape = (value: unknown): boolean =>
      typeof value === "object" && value !== null && !Array.isArray(value);

    if (method === "initialize") {
      if (pinnedEra === "modern") {
        error(id, -32600, "this connection speaks the modern era — initialize belongs to the handshake era");
        return;
      }
      pinnedEra = "legacy";
      initializeSeen = true;
      // The handshake era can only negotiate ITSELF: an unsupported ask is
      // answered WITH the legacy version, never the modern one.
      respond(id, "legacy", {
        protocolVersion: LEGACY,
        capabilities: { tools: {} },
        serverInfo: { name: "toolroll", version: PACKAGE_VERSION },
      }, false);
      return;
    }
    if (method === "server/discover") {
      if (pinnedEra === "legacy") {
        error(id, -32600, "this connection speaks the handshake era — server/discover belongs to the modern one");
        return;
      }
      if (declared !== MODERN || !capabilitiesShape(meta[META_CAPABILITIES])) {
        // The modern era's requests carry BOTH namespaced keys (round-2
        // finding 1) — a bare discover is not a modern request.
        error(id, -32600, `server/discover requires _meta["${META_VERSION}"] = "${MODERN}" and _meta["${META_CAPABILITIES}"]`);
        return;
      }
      pinnedEra = "modern";
      respond(id, "modern", {
        protocolVersion: MODERN,
        supportedVersions: [MODERN, LEGACY],
        capabilities: { tools: {} },
        _meta: { [META_SERVER]: { name: "toolroll", version: PACKAGE_VERSION } },
        ...(toolsPayload() as Record<string, Json>),
      }, true);
      return;
    }

    // Era classification precedes every remaining method — ping and unknown
    // methods included (round-3 finding 1): a refused modern ping still pins
    // the modern era, and a cross-era unknown method refuses on the pin
    // instead of slipping past it.
    const era: "modern" | "legacy" = declared === MODERN ? "modern" : "legacy";
    if (era === "modern" && !capabilitiesShape(meta[META_CAPABILITIES])) {
      error(id, -32600, `a ${MODERN} request carries _meta["${META_CAPABILITIES}"]`);
      return;
    }
    if (pinnedEra !== null && era !== pinnedEra) {
      error(id, -32600, `this connection is pinned to the ${pinnedEra} era`);
      return;
    }
    pinnedEra = era;

    if (method === "ping") {
      // ping left the protocol in 2026-07-28 — only the handshake era has it.
      if (era === "modern") {
        error(id, -32601, "ping is not part of the modern revision");
        return;
      }
      respond(id, "legacy", {}, false);
      return;
    }

    // The handshake era operates only after its lifecycle completed; the
    // modern era is stateless and needs no handshake.
    if (era === "legacy" && !legacyReady && (method === "tools/list" || method === "tools/call")) {
      error(id, -32002, "not initialized — the handshake era requires initialize and notifications/initialized first");
      return;
    }
    if (method === "tools/list") {
      respond(id, era, toolsPayload() as Record<string, Json>, true);
      return;
    }
    if (method === "tools/call") {
      const key = JSON.stringify(id);
      inFlight.add(key);
      try {
        callTool(id, era, params);
      } finally {
        inFlight.delete(key);
        cancelled.delete(key);
      }
      return;
    }
    error(id, -32601, `unknown method \`${method}\``);
  });

  io.onEof(() => io.exit(0));
  return { ok: true };
}
