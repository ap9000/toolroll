/**
 * The MCP gateway's transport-free core (MCP gateway spec v6): protocol
 * constants and limits, message reading, the coordinator tool registry and
 * its per-call authorization. The stdio adapter (mcp.ts) and the HTTP adapter
 * (mcp-http.ts) each own their transport and lifecycle; neither re-implements
 * what a call means.
 *
 * Protocol errors are JSON-RPC errors; tool-level refusals are successful
 * `tools/call` results with `isError: true`.
 */
import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import { repositoryContextRead } from './repository-context.js';
import { ASSIGNMENT_TOOLS, assignmentForCoordinator } from "./assignment-adapters.js";
import { parseContract, toModelSchema } from "./contracts/contract.js";
import { GATEWAY_TOOL_INPUTS, GATEWAY_TOOL_OUTPUTS, type GatewayToolInput, type GatewayToolName } from "./contracts/gateway-tools.js";
import { reportToolOutput } from "./contracts/lead-tools.js";

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
import { ISO_STAMP_RULE, decisionOver, decisionsOver, labelRepos, queueOver, recapOver } from "./lead-tools.js";
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
export const MAX_REQUEST = 256 * 1024;
export const MAX_DEPTH = 32;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function depthOf(value: unknown): number {
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
export type ToolContext = {
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

export type Answer = { ok: true; body: Json } | { ok: false; message: string };
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
export const TOOLS: Tool[] = (Object.keys(GATEWAY_TOOL_INPUTS) as GatewayToolName[]).map(<N extends GatewayToolName>(name: N): Tool => {
  const handler = HANDLERS[name] as Handler<N>;
  return { name, description: handler.description, inputSchema: toModelSchema(GATEWAY_TOOL_INPUTS[name]) as Json, handle: (ctx, args) => handler.handle(ctx, args as GatewayToolInput<N>) };
});

/** The tools/list payload for a registry. No outputSchema: MCP output schemas describe structuredContent, and these
 * tools return text content only (round-2 finding 1). */
export const toolsPayload = (tools: readonly { name: string; description: string; inputSchema: Json }[]): { tools: Json } => ({
  tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
});

/** A modern result is schema-complete; a cacheable one (tools/list, discover) carries `ttlMs: 0` and the narrowest scope. */
export function shapeResult(era: "modern" | "legacy", result: Record<string, Json>, cacheable: boolean): Record<string, Json> {
  return era === "modern" ? { ...result, resultType: "complete", ...(cacheable ? { ttlMs: 0, cacheScope: "private" } : {}) } : result;
}

/** One JSON-RPC message, read and checked before any method applies. */
export type ReadMessage =
  | { ok: true; hasId: boolean; id: Json; method: string; params: Record<string, unknown>; meta: Record<string, unknown> }
  | { ok: false; id: Json; code: number; message: string };

/** Read one message's text: size, JSON, no batching, depth, `jsonrpc`, and the id rules. A notification is the message
 * that carries NO id — the method name never decides (round-3 finding 3). MCP RequestId is a string or an INTEGER
 * (round-2 finding 2): floats, null, and object shapes refuse wherever an id appears. */
export function readMessage(text: string): ReadMessage {
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST) return { ok: false, id: null, code: -32600, message: "request over 256 KiB" };
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return { ok: false, id: null, code: -32700, message: "parse error" };
  }
  // Batching left MCP in 2025-06-18 — neither pinned era accepts it.
  if (Array.isArray(message)) return { ok: false, id: null, code: -32600, message: "JSON-RPC batching is not part of MCP — send one request per line" };
  if (message === null || typeof message !== "object" || depthOf(message) > MAX_DEPTH) return { ok: false, id: null, code: -32600, message: "invalid request" };
  const request = message as Record<string, unknown>;
  if (request["jsonrpc"] !== "2.0") return { ok: false, id: null, code: -32600, message: 'jsonrpc must be "2.0"' };
  const hasId = "id" in request;
  const rawId = request["id"];
  if (hasId && (rawId === null || (typeof rawId !== "string" && !(typeof rawId === "number" && Number.isInteger(rawId))))) {
    return { ok: false, id: null, code: -32600, message: "id must be a string or an integer" };
  }
  const method = typeof request["method"] === "string" ? request["method"] : "";
  if (method.startsWith("notifications/")) {
    if (hasId) return { ok: false, id: rawId as Json, code: -32600, message: "a notification carries no id" };
  } else if (!hasId) {
    return { ok: false, id: null, code: -32600, message: "a request carries an id — a string or an integer" };
  }
  const params = (request["params"] ?? {}) as Record<string, unknown>;
  const meta = (params["_meta"] ?? {}) as Record<string, unknown>;
  return { ok: true, hasId, id: (rawId ?? null) as Json, method, params, meta };
}

/** ClientCapabilities is an OBJECT shape (round-3 finding 5): an array is not a capabilities declaration. */
export const capabilitiesShape = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);

/** What a tools/call came to: a JSON-RPC error (`fatal` = the stdio server must exit after it) or a tool result. */
export type CallOutcome =
  | { kind: "error"; code: number; message: string; fatal: boolean }
  | { kind: "result"; result: Record<string, Json> };

/** The `arguments` of a call: only an ABSENT value defaults to empty (round-3 finding 2), and the root is an object
 * BEFORE any schema applies (round-2 finding 2): 42 or false never passes an empty schema. */
export function callArguments(params: Record<string, unknown>): Record<string, unknown> | null {
  const raw = params["arguments"] === undefined ? {} : params["arguments"];
  return typeof raw !== "object" || raw === null || Array.isArray(raw) ? null : raw as Record<string, unknown>;
}

/** A handler's answer as a tools/call result: a refusal is `isError`, never a protocol error. */
export function answerResult(answered: Answer): Record<string, Json> {
  return answered.ok ? { content: [{ type: "text", text: JSON.stringify(answered.body) }] } : { content: [{ type: "text", text: answered.message }], isError: true };
}

/**
 * One coordinator tools/call. ONE snapshot per call (review finding 3): the version check, the credential re-read, and
 * every data read share a transaction, so a concurrent migration cannot slip between them; filing's own BEGIN IMMEDIATE
 * reenters this one. tools/list visibility is presentation — authorization happens HERE, on every call, against the
 * live credential row.
 */
export function callCoordinatorTool(
  call: Omit<ToolContext, "who" | "now"> & { clock: () => Date },
  params: Record<string, unknown>,
): CallOutcome {
  const { store, token, clock, ...rest } = call;
  return store.transact((): CallOutcome => {
    if (!store.schemaCurrent()) return { kind: "error", code: -32000, message: "the database schema moved underneath this server — restart it", fatal: true };
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const tool = TOOLS.find(one => one.name === name);
    if (tool === undefined) return { kind: "error", code: -32602, message: `no tool \`${name}\``, fatal: false };
    const session = authenticateCoordinator(store, token);
    if (!session.ok) return { kind: "error", code: -32000, message: "this credential no longer stands — the server exits", fatal: true };
    const rawArgs = callArguments(params);
    if (rawArgs === null) return { kind: "error", code: -32602, message: "arguments must be an object", fatal: false };
    // The call is read by the schema tools/list advertised (review finding 2): unknown fields, bad types, bad enums,
    // and bound violations are protocol errors (InvalidParams) naming each path, never tool refusals.
    const read = parseContract<Record<string, unknown>>(GATEWAY_TOOL_INPUTS[tool.name] as never, rawArgs);
    if (!read.ok) return { kind: "error", code: -32602, message: read.issues.map(one => one.line).join("; "), fatal: false };
    const answered = tool.handle({ store, token, who: session.who, now: clock(), ...rest }, read.value);
    // Checked against its output schema before delivery; a disagreement is reported, never refused.
    if (answered.ok) reportToolOutput("gateway", tool.name, GATEWAY_TOOL_OUTPUTS[tool.name], answered.body);
    return { kind: "result", result: answerResult(answered) };
  });
}
