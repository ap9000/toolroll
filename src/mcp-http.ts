/**
 * The MCP gateway over streamable HTTP, served at /mcp by the console (serve.ts). Stateless: one JSON-RPC message per
 * POST, answered with one JSON body (a notification gets 202 and no body); there is no session and no event stream.
 * The modern revision carries its version in `_meta` as on stdio; a handshake-era client may initialize, and because
 * nothing is kept between requests its tools work without the stdio lifecycle.
 *
 * Every POST signs in again. The caller is a coordinator credential (the coordinator registry, exactly as on stdio) or
 * a person's own API token `so_…` (mcp-person.ts: their role, project grants and token scope). A password
 * (`name:password`) and cookies sign in nothing here, a request carrying a browser Origin is refused, and the console's
 * Host check runs before this route. A revoked or expired token answers 401 on its next request.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { PACKAGE_VERSION } from "./version.js";
import type { Store } from "./store.js";
import { parseApiToken, secretMatches, tokenLive, tokenProjects } from "./api-tokens.js";
import { oauthProjects, oauthTokenAllowed, RESOURCE_PATH } from "./mcp-oauth.js";
import { authenticateCoordinator } from "./coordinator.js";
import {
  LEGACY, MAX_REQUEST, META_CAPABILITIES, META_SERVER, META_VERSION, MODERN, TOOLS, UNSUPPORTED_VERSION,
  callCoordinatorTool, capabilitiesShape, readMessage, shapeResult, toolsPayload, type CallOutcome, type Json,
} from "./mcp-core.js";
import { callPersonTool, personTools, type Person, type RunOperateAs } from "./mcp-person.js";
import { limitWords, SOURCE_BUDGET_DEFAULTS, SourceAdmission, type Admission } from "./request-budget.js";

export type McpHttpOptions = {
  store: Store;
  clock: () => Date;
  /** The enrolled projects: a coordinator's list_repos answers allowlist ∩ enrolled. */
  enrolled: () => readonly string[] | null;
  evidenceRoot?: string;
  /** The console's own sign-in for an `so_` bearer: the address's tries, expiry, revocation, a removed account. */
  signedIn: (request: IncomingMessage) => boolean;
  /** Where an MCP client finds how to sign in (mcp-oauth.ts), named on a 401; null when this address offers none. */
  resourceMetadata?: (request: IncomingMessage) => string | null;
  /** Runs a person's command on the server (operate.ts); resolved from operate.ts when not injected. */
  runAs?: RunOperateAs;
  /** A person token's request budget (request-budget.ts), charged once per request before its body is read. */
  admit?: (person: Person) => Admission;
  requestBudgetClock?: () => number;
};

type Caller = { kind: "coordinator"; token: string; cid: string } | { kind: "person"; person: Person };

/** The most decisions a coordinator credential is remembered to have read (propose_answer needs one). */
const READ_DECISIONS_KEPT = 200;

export function createMcpHttp(options: McpHttpOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { store } = options;
  const coordinatorBudget = new SourceAdmission({ perMinute: SOURCE_BUDGET_DEFAULTS.coordinator, ...(options.requestBudgetClock === undefined ? {} : { clock: options.requestBudgetClock }) });
  /** Stdio remembers per connection which decisions a coordinator read; stateless HTTP remembers it per credential. */
  const readDecisions = new Map<string, Set<number>>();

  const send = (response: ServerResponse, status: number, body: Json | null, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { "cache-control": "no-store", "x-content-type-options": "nosniff", ...(body === null ? {} : { "content-type": "application/json" }), ...headers });
    response.end(body === null ? undefined : JSON.stringify(body));
  };
  const refuse = (response: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void =>
    send(response, status, { jsonrpc: "2.0", id: null, error: { code: -32000, message } }, headers);

  /** Who signed this request, from the live rows — nothing is cached, so revocation and grant changes apply at once. */
  const callerOf = (request: IncomingMessage): Caller | null => {
    const presented = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (presented === undefined || presented.includes(":")) return null;
    if (presented.startsWith("so_")) {
      if (!options.signedIn(request)) return null;
      const parsed = parseApiToken(presented);
      const kept = parsed === null ? null : store.apiTokenSecret(parsed.id);
      // The secret is checked here too, so this door never rests on how signedIn reads the request.
      if (parsed === null || kept === null || !secretMatches(parsed.secret, kept.secretHash)) return null;
      if (!tokenLive(kept.row, options.clock().getTime())) return null;
      const account = store.accountOf(kept.row.account);
      if (account === null || account.revokedAt !== null) return null;
      // An MCP sign-in's token: only while its access is fresh, and only in the projects the person chose (mcp-oauth.ts).
      if (!oauthTokenAllowed(store, kept.row.id, RESOURCE_PATH, options.clock())) return null;
      const granted = oauthProjects(store, kept.row.id);
      const projects = tokenProjects(tokenProjects(account.projects, kept.row.projects), granted);
      return {
        kind: "person",
        person: {
          principal: { kind: "person", account: kept.row.account, generation: account.generation, scope: kept.row.access, tokenId: kept.row.id, projects },
          role: account.role,
          tokenName: kept.row.name,
        },
      };
    }
    const auth = authenticateCoordinator(store, presented);
    return auth.ok ? { kind: "coordinator", token: presented, cid: auth.who.cid } : null;
  };

  /** Loaded on first use: operate.ts imports serve.ts, which serves this gateway. */
  const runAs = async (): Promise<RunOperateAs> => options.runAs ?? (await import("./operate.js")).runOperateAs;

  /** The body, or null the moment it passes MAX_REQUEST: reading stops there and nothing more is buffered. */
  const readBody = (request: IncomingMessage): Promise<string | null> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= MAX_REQUEST) return void chunks.push(chunk);
      request.off("data", onData);
      request.pause();
      chunks.length = 0;
      resolve(null);
    };
    request.on("data", onData);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

  /** 413, then the connection goes: the rest of an oversized body is never read. */
  const tooLarge = (request: IncomingMessage, response: ServerResponse): void => {
    response.once("finish", () => request.destroy());
    refuse(response, 413, "request over 256 KiB", { connection: "close" });
  };

  const call = async (caller: Caller, params: Record<string, unknown>): Promise<CallOutcome> => {
    if (caller.kind === "person") {
      return callPersonTool(caller.person, store, await runAs(), params);
    }
    let read = readDecisions.get(caller.cid);
    if (read === undefined) readDecisions.set(caller.cid, read = new Set());
    const outcome = callCoordinatorTool({ store, token: caller.token, enrolled: options.enrolled(), clock: options.clock, readDecisions: read, ...(options.evidenceRoot === undefined ? {} : { evidenceRoot: options.evidenceRoot }) }, params);
    for (const id of read) if (read.size > READ_DECISIONS_KEPT) read.delete(id);
    return outcome;
  };

  return async (request, response) => {
    if (request.method !== "POST") return refuse(response, 405, "the MCP gateway takes POST only — one JSON-RPC message per request", { allow: "POST" });
    // A browser page must never drive the gateway with whatever it can reach: agents send no Origin.
    if (request.headers.origin !== undefined) return refuse(response, 403, "browser requests are refused — connect an MCP client with your API token");
    const caller = callerOf(request);
    if (caller === null) {
      const metadata = options.resourceMetadata?.(request) ?? null;
      return refuse(response, 401, "sign in with your API token (Authorization: Bearer so_…) or a coordinator credential — passwords and cookies are not accepted here",
        { "www-authenticate": `Bearer realm="toolroll-mcp"${metadata === null ? "" : `, resource_metadata="${metadata}"`}` });
    }
    // Count every authenticated request once, including notifications. Coordinator proposal limits still apply
    // separately inside tool transactions; this admission also bounds their reads and malformed requests.
    {
      const admitted = caller.kind === "person" ? options.admit?.(caller.person) ?? { ok: true as const } : coordinatorBudget.admit(caller.cid);
      if (!admitted.ok && admitted.status === 503) return refuse(response, 503, "request limits could not be checked; nothing ran — try again shortly");
      if (!admitted.ok) {
        request.resume();
        return send(response, 429, { jsonrpc: "2.0", id: null, error: { code: -32000, message: limitWords(admitted.limit, admitted.retryAfter), data: { limit: admitted.limit, retryAfter: admitted.retryAfter } } }, { "retry-after": String(admitted.retryAfter) });
      }
    }
    if (!/^application\/json\s*(;|$)/i.test(request.headers["content-type"] ?? "")) return refuse(response, 415, "send the JSON-RPC message as application/json");
    if (Number(request.headers["content-length"] ?? 0) > MAX_REQUEST) return tooLarge(request, response);
    const text = await readBody(request);
    if (text === null) return tooLarge(request, response);

    const message = readMessage(text);
    if (!message.ok) return send(response, 400, { jsonrpc: "2.0", id: message.id, error: { code: message.code, message: message.message } });
    const { id, method, params, meta } = message;
    const error = (code: number, text: string, data?: Json): void =>
      send(response, 200, { jsonrpc: "2.0", id, error: { code, message: text, ...(data === undefined ? {} : { data }) } });
    const answer = (era: "modern" | "legacy", result: Record<string, Json>, cacheable: boolean): void =>
      send(response, 200, { jsonrpc: "2.0", id, result: shapeResult(era, result, cacheable) });

    if (!store.schemaCurrent()) return error(-32000, "the database schema moved underneath this server — try again after it restarts");
    // Notifications (initialized, cancelled) need nothing from a stateless server: accepted, never answered.
    if (method.startsWith("notifications/")) return send(response, 202, null);

    const header = request.headers["mcp-protocol-version"];
    const declared = typeof meta[META_VERSION] === "string" ? (meta[META_VERSION] as string) : typeof header === "string" ? header : null;
    if (method !== "initialize" && declared !== null && declared !== MODERN && declared !== LEGACY) {
      return error(UNSUPPORTED_VERSION, `unsupported protocol version \`${declared}\``, { supported: [MODERN, LEGACY], requested: declared });
    }
    const tools = () => caller.kind === "person" ? personTools(caller.person) : TOOLS;

    if (method === "initialize") {
      // The handshake era negotiates only itself; nothing is kept, so no session id is issued.
      return answer("legacy", { protocolVersion: LEGACY, capabilities: { tools: {} }, serverInfo: { name: "toolroll", version: PACKAGE_VERSION } }, false);
    }
    const era: "modern" | "legacy" = declared === MODERN ? "modern" : "legacy";
    if (era === "modern" && !capabilitiesShape(meta[META_CAPABILITIES])) return error(-32600, `a ${MODERN} request carries _meta["${META_CAPABILITIES}"]`);
    if (method === "server/discover") {
      if (era !== "modern") return error(-32600, `server/discover requires _meta["${META_VERSION}"] = "${MODERN}" and _meta["${META_CAPABILITIES}"]`);
      return answer("modern", { protocolVersion: MODERN, supportedVersions: [MODERN, LEGACY], capabilities: { tools: {} }, _meta: { [META_SERVER]: { name: "toolroll", version: PACKAGE_VERSION } }, ...toolsPayload(tools()) }, true);
    }
    if (method === "ping") return era === "modern" ? error(-32601, "ping is not part of the modern revision") : answer("legacy", {}, false);
    if (method === "tools/list") return answer(era, toolsPayload(tools()), true);
    if (method === "tools/call") {
      const outcome = await call(caller, params);
      return outcome.kind === "result" ? answer(era, outcome.result, false) : error(outcome.code, outcome.message);
    }
    return error(-32601, `unknown method \`${method}\``);
  };
}
