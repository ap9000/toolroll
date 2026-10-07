import { statSync } from 'node:fs';
/**
 * `toolroll mcp` — the MCP stdio adapter (MCP gateway spec v6). What a
 * call means lives in the transport-free core (mcp-core.ts); this file owns
 * the stdio transport, era pinning and the connection's lifecycle.
 *
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
import { authenticateCoordinator } from "./coordinator.js";
import {
  LEGACY, META_CAPABILITIES, META_SERVER, META_VERSION, MODERN, TOOLS, UNSUPPORTED_VERSION,
  callCoordinatorTool, capabilitiesShape, readMessage, shapeResult, toolsPayload, type Json,
} from "./mcp-core.js";

export { LEGACY, META_CAPABILITIES, META_SERVER, META_VERSION, MODERN, UNSUPPORTED_VERSION } from "./mcp-core.js";

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
    io.write(JSON.stringify({ jsonrpc: "2.0", id, result: shapeResult(era, result, cacheable) }));
  };

  const callTool = (id: Json, era: "modern" | "legacy", params: Record<string, unknown>): void => {
    // A restore or rollback puts a different file at the database's path: this server's connection still reads and
    // writes the one it replaced, so it answers nothing more and exits (the agent starts it again on the new one).
    if (database !== null && !sameFile(database)) {
      error(id, -32000, "the database was replaced underneath this server (a Toolroll restore or rollback) — restart it");
      io.exit(0);
      return;
    }
    // A moved schema or a credential that no longer stands refuses in words and the server exits clean.
    const outcome = callCoordinatorTool({ store, token, enrolled, clock, readDecisions, ...(evidenceRoot === undefined ? {} : { evidenceRoot }) }, params);
    if (outcome.kind === "result") return respond(id, era, outcome.result, false);
    error(id, outcome.code, outcome.message);
    if (outcome.fatal) io.exit(0);
  };

  io.onLine(line => {
    if (line.trim() === "") return;
    const read = readMessage(line);
    if (!read.ok) {
      error(read.id, read.code, read.message);
      return;
    }
    const { id, method, params, meta } = read;

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
        ...toolsPayload(TOOLS),
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
      respond(id, era, toolsPayload(TOOLS), true);
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
