/**
 * Flexible threads, slice F2b (the Flexible plan v2 §2 and §8, D8, Codex round 2 items 8 and 10): the sign-in relay. A
 * thread's agent never holds a model credential: it signs in to a loopback relay of its thread's, outside the fence,
 * with a per-launch relay token, and the relay forwards each allowed call to the model service with Toolroll's own
 * credential and charges it to the thread's current turn.
 *
 * The rules this module keeps:
 * - Starting the relay checks the interactive agent threads' switch (flexible-available.ts flexibleAvailable: off
 *   unless a person turned them on) first, and each model call checks it again inside its own reservation transaction:
 *   turned off, nothing more is sent.
 * - Where a call may go is data (flexible-relay-upstreams.ts), never a setting or an argument: a fixed origin
 *   (https://api.anthropic.com for Claude), exactly the routes listed (POST /v1/messages and /v1/messages/count_tokens),
 *   and never anywhere a redirect points (a redirect is refused, not followed).
 * - Authentication is the launch's relay token (flexible-launch.ts flexible_relay_grant), checked on every call by its
 *   SHA-256 digest, compared in constant time, from the database: it counts only while its own launch is live and the
 *   grant unrevoked, so a stop from any Toolroll process, or custody left unresolved (settleLaunch revokes first), ends
 *   it at once. A relay serves exactly one thread: another thread's token is refused.
 * - No caller-chosen credential: the agent's token header is consumed, never forwarded, and a call carrying any other
 *   header that selects or carries a credential or overrides the service's behaviour (x-api-key beside the token,
 *   authorization, cookie, any anthropic-* but the version and the listed betas) is refused. Only the listed headers
 *   pass. The upstream credential is the thread's owner's own Claude sign-in (their `claude setup-token` output, saved
 *   by them: flexible-sign-in.ts), read from its own address at each call, never anyone else's and never an
 *   installation-wide one (there is none), and is never echoed: every answer, error, record and log line passes through
 *   the redactor. Each call is bound to the generation of the sign-in it used: the dispatch invariant
 *   (flexible-sign-in.ts signInStandsAt) is checked again inside its reservation transaction and the generation is
 *   recorded on its reservation and its record. Claude refusing the sign-in (401, or 403 authentication_error) refuses
 *   that generation from then on, and the agent gets Toolroll's own words, never Claude's body, and its turn ends.
 * - Limits: the models listed (the turn's own, or the helper model), `max_tokens` and the body's size capped, a few calls
 *   at once per thread, and no field that would have the service reach the network for the agent (server tools, MCP
 *   connectors): the thread's network is its proxy's, and the relay doesn't widen it.
 * - Every call is bound to the thread's CURRENT running turn (F2e flexible-turns.ts), owned by the thread's starter, run
 *   by the token's own launch's holder, on the billing the credential is (a plan's setup-token for a plan turn, a key for a keyed one): between
 *   turns the token authorizes nothing, and a call still running when its turn ends, or its token is revoked, is cut.
 * - Usage is counted by the relay itself from the service's answer (its streamed usage events included), never what the
 *   agent reports, and charged to that turn in the same transaction that records the call (thread_relay_call, v166).
 *   When the answer's usage can't be read whole (cut off, unreadable), the call's cost is unknown (F2e's unknown-cost
 *   hold), never what was read alone.
 *
 * Reachable from inside the thread's fence only through the sandbox runtime's second relay port (the slot a build's
 * tool broker uses; threads have none): on a Mac the agent reaches 127.0.0.1:<relay port>, which the Seatbelt profile
 * admits beside the run proxy; on Linux the runtime relays it into the launch's own network at 127.0.0.1:1080. No other
 * loopback port opens (test/attacks/flexible-relay-fence.slow.test.ts proves both against the real fence, and that the
 * run proxy forwards no pseudo-host to loopback).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { flexibleAvailable } from "./flexible-available.js";
import { FLEXIBLE_UNAVAILABLE } from "./flexible.js";
import { issueRelayGrant, revokeRelayGrant } from "./flexible-launch.js";
import { onRelayCancel } from "./flexible-relay-cancel.js";
import { FLEXIBLE_RELAY_UPSTREAMS, type RelayUpstream } from "./flexible-relay-upstreams.js";
import { interruptTurnAndStop } from "./flexible-authority-end.js";
import { chargeFlexibleTurn, flexibleTurn, type FlexibleCostBasis, type FlexibleTurnRow } from "./flexible-turns.js";
import { signInEpochOf, signInForTurn, signInHoldsFor, signInRefusedBy, signInRefusedWords, signInStandsAt, type DispatchSignIn } from "./flexible-sign-in.js";
import type { Store } from "./store.js";

// ---- what the thread start uses ----------------------------------------------------------------------------------------

/** Where a launch's agent signs in: the relay's own address (outside the fence) and this launch's relay token. `revoke`
 * ends exactly this token, at once. */
export type FlexibleRelayEndpoint = { url: string; token: string; revoke: () => void };
/** The relay as the thread start uses it: where it listens (the port the thread's fence admits as its second relay),
 * and a grant for one launch of the thread. */
export type FlexibleRelay = { url: string; port: number; issue: (grant: { thread: string; turn: string; launch: string }) => FlexibleRelayEndpoint };
/** A running relay: one thread's, until closed. */
export type FlexibleRelayServer = FlexibleRelay & { thread: string; inFlight: () => number; close: () => Promise<void> };
export type FlexibleRelayRefusal = { ok: false; reason: "not-available" | "invalid-request" | "thread-unknown" | "no-state-folder"; message: string };

const START_WORDS = Object.freeze({
  "not-available": FLEXIBLE_UNAVAILABLE,
  "invalid-request": "That isn't a thread Toolroll can start a sign-in relay for. Nothing was started.",
  "thread-unknown": "There's no such thread, or it isn't ready.",
  "no-state-folder": "Toolroll's state folder can't be found, so its sign-in relay can't start.",
} as const);
const refuse = (reason: keyof typeof START_WORDS): FlexibleRelayRefusal => ({ ok: false, reason, message: START_WORDS[reason] });

/** The port the sandbox runtime relays a launch's second port to inside its own network on Linux (sandbox-runtime's
 * SOCKS listener: invoke.ts names the tool broker there too). A Mac's Seatbelt admits the relay's own port instead. */
export const LINUX_SECOND_RELAY_PORT = 1080;
/** The address the agent inside the thread's fence reaches the relay at. */
export function relayUrlInside(port: number, platform: NodeJS.Platform = process.platform): string {
  return platform === "linux" ? `http://127.0.0.1:${LINUX_SECOND_RELAY_PORT}` : `http://127.0.0.1:${port}`;
}

// ---- refusals the agent reads -----------------------------------------------------------------------------------------

type CallReason = "threads-off" | "unsettled" | "check-failed" | "credential-header" | "header" | "beta" | "route" | "too-many" | "no-turn" | "billing-mismatch" | "no-sign-in" | "sign-in-refused" | "body-too-large" | "body" | "model" | "max-tokens" | "server-tool" | "server-fetch";
/** Every refusal the agent reads, exactly as sent. A refusal that should end the agent's turn is Toolroll's own 403
 * permission_error with words that say what to do: the real Claude Code shows a 403 once and stops, while it retries a
 * 401 or a 5xx silently (src/flexible-relay-client.slow.test.ts records each of these against it). */
export const RELAY_CALL_ANSWERS: Readonly<Record<CallReason, { status: number; type: string; message: string }>> = Object.freeze({
  "threads-off": { status: 403, type: "permission_error", message: "Interactive agent threads were turned off in Toolroll, so nothing was sent to the model." },
  unsettled: { status: 403, type: "permission_error", message: "Toolroll couldn't record an earlier model call in this turn yet, so it sent nothing more. Send your message again in a moment." },
  "check-failed": { status: 403, type: "permission_error", message: "Toolroll couldn't check whether this thread may still use Claude, so nothing was sent. Send your message again; if this keeps happening, restart Toolroll." },
  "credential-header": { status: 400, type: "invalid_request_error", message: "Toolroll's sign-in relay chooses the credential itself: a call can't carry its own key, sign-in or service override." },
  header: { status: 400, type: "invalid_request_error", message: "A request header isn't in a form Toolroll's sign-in relay accepts." },
  beta: { status: 400, type: "invalid_request_error", message: "That anthropic-beta feature isn't one Toolroll's sign-in relay allows." },
  route: { status: 404, type: "not_found_error", message: "Toolroll's sign-in relay only forwards messages and token counts." },
  "too-many": { status: 429, type: "rate_limit_error", message: "This thread has too many model calls running at once. Try again when one finishes." },
  "no-turn": { status: 409, type: "invalid_request_error", message: "This thread has no turn running, so nothing was sent to the model." },
  "billing-mismatch": { status: 403, type: "permission_error", message: "This turn was admitted for a different kind of Claude sign-in than the one saved, so nothing was sent." },
  "no-sign-in": { status: 403, type: "permission_error", message: "The person who started this thread has no Claude sign-in for threads that counts now (none saved, removed, or their account changed), so nothing was sent. Save one in Settings → General, or with `toolroll config set flexible-sign-in`." },
  "sign-in-refused": { status: 403, type: "permission_error", message: "Claude didn't accept this Claude sign-in for threads earlier, so nothing was sent. Save a new one in Settings → General, or with `toolroll config set flexible-sign-in`." },
  "body-too-large": { status: 413, type: "request_too_large", message: "That request is larger than Toolroll's sign-in relay forwards." },
  body: { status: 400, type: "invalid_request_error", message: "That request isn't JSON Toolroll's sign-in relay can read." },
  model: { status: 400, type: "invalid_request_error", message: "That model isn't one this turn may use." },
  "max-tokens": { status: 400, type: "invalid_request_error", message: "max_tokens is missing or larger than Toolroll's sign-in relay allows." },
  "server-tool": { status: 400, type: "invalid_request_error", message: "Server tools and connectors would reach the network outside this thread's proxy, so Toolroll's sign-in relay doesn't forward them." },
  "server-fetch": { status: 400, type: "invalid_request_error", message: "That request asks the model service to fetch something itself (a URL or a stored file), outside this thread's proxy, so Toolroll's sign-in relay doesn't forward it. Send the content inline." },
});
/** Refusals of Toolroll's own after which a turn can't go on: each ends its turn and stops its agent (settle). */
const TURN_ENDING_REFUSALS: ReadonlySet<CallReason> = new Set<CallReason>(["no-sign-in", "sign-in-refused", "billing-mismatch", "threads-off"]);
const UNAUTHORIZED = "This relay token isn't authorized (it was never issued, its launch ended, or its thread was stopped).";
const errorBody = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });

// ---- credentials, tokens and redaction -------------------------------------------------------------------------------

/** Anything shaped like an Anthropic credential, and the exact credential in hand: replaced before any text leaves. */
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{6,}/g;
const REDACTED = "[redacted]";
function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  return out.replace(KEY_SHAPE, REDACTED);
}
/**
 * The pieces of a credential that count as it: every 8 characters in a row of its secret part (after the public
 * `sk-ant-xxxNN-` prefix every such key starts with). Why 8: the secret part is random base64url, so 8 of its characters
 * in a row are 48 bits that ordinary text matches by chance about once in 2^47 places, while any fragment worth having
 * (enough to narrow a guess) is at least that long; and since every check here sees a whole unit (a header value, an
 * error body, one stream event, a whole answer), a fragment can't hide by straddling two writes.
 */
const FRAGMENT = 8;
function fragmentsOf(secret: string): string[] {
  const body = secret.replace(/^sk-ant-[a-z]{2,8}\d{0,3}-/, "");
  const out: string[] = [];
  for (let at = 0; at + FRAGMENT <= body.length; at++) out.push(body.slice(at, at + FRAGMENT));
  return out;
}
/** Text with its JSON escapes decoded (\u-escaped and slash-escaped spellings read as plain). */
const unescaped = (text: string): string => text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\\//g, "/");
/** Whether text about to leave carries a credential, anything shaped like one, or a piece of one (fragmentsOf), in any
 * JSON spelling. */
function leaks(text: string, secrets: readonly string[]): boolean {
  for (const form of [text, unescaped(text)]) {
    if (redact(form, secrets) !== form) return true;
    if (secrets.some(secret => fragmentsOf(secret).some(piece => form.includes(piece)))) return true;
  }
  return false;
}
/** Every string inside a parsed JSON value, redacted. */
function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map(one => redactDeep(one, secrets));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, one]) => [redact(key, secrets), redactDeep(one, secrets)]));
  return value;
}
/** An answer header's value: as it is, or withheld whole when it carries any of a credential. */
const redactHeader = (value: string | string[], secrets: readonly string[]): string | string[] =>
  Array.isArray(value) ? value.map(one => leaks(one, secrets) ? REDACTED : one) : leaks(value, secrets) ? REDACTED : value;
/** JSON text with every string in it redacted and written again, or null when it isn't JSON; null too when what would
 * leave still carries any of a credential. */
function sanitizedJson(text: string, secrets: readonly string[]): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return null; }
  const out = JSON.stringify(redactDeep(parsed, secrets));
  return leaks(out, secrets) ? null : out;
}
/** One stream event as it may leave: unchanged when it carries nothing of a credential; else its data written again
 * from its parsed JSON with every string redacted; withheld (dropped) when even that would carry any of one. */
function sanitizeEvent(event: string, secrets: readonly string[]): string {
  if (!leaks(event, secrets)) return event;
  const lines = event.split(/\r?\n/);
  const name = lines.find(line => line.startsWith("event:"));
  const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
  const clean = data === "" ? null : sanitizedJson(data, secrets);
  return clean === null ? "" : `${name === undefined ? "" : `${redact(name, secrets)}\n`}data: ${clean}\n\n`;
}
/** A whole answer as it may leave: unchanged when it carries nothing of a credential; else written again with every
 * string redacted; null (withheld) when neither is clean. */
function sanitizeWhole(text: string, secrets: readonly string[]): string | null {
  if (!leaks(text, secrets)) return text;
  return sanitizedJson(text, secrets);
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const RELAY_TOKEN = /^tr-relay-[0-9a-f]{48}$/;
type Grant = { digest: string; thread: string; launch: string; holder: string };
/** The live grant a token is, by its digest (constant-time compared): unrevoked, and its own launch live. */
function grantOf(store: Store, token: string): Grant | null {
  if (!RELAY_TOKEN.test(token)) return null;
  const digest = sha256(token);
  const row = store.handle.prepare(`SELECT g.token_digest AS digest, g.thread AS thread, g.launch AS launch, l.holder AS holder FROM flexible_relay_grant g
    JOIN flexible_thread_launch l ON l.id = g.launch AND l.thread = g.thread WHERE g.token_digest = ? AND g.revoked_at IS NULL AND l.state = 'live'`).get(digest);
  if (row === undefined) return null;
  const stored = Buffer.from(String(row["digest"]), "hex"), given = Buffer.from(digest, "hex");
  if (stored.length !== given.length || !timingSafeEqual(stored, given)) return null;
  return { digest, thread: String(row["thread"]), launch: String(row["launch"]), holder: String(row["holder"]) };
}
const grantStillLive = (store: Store, digest: string): boolean => store.handle.prepare(`SELECT 1 AS ok FROM flexible_relay_grant g JOIN flexible_thread_launch l ON l.id = g.launch AND l.thread = g.thread
  WHERE g.token_digest = ? AND g.revoked_at IS NULL AND l.state = 'live'`).get(digest) !== undefined;

/** Whether a call may still spend, from the record: its token unrevoked, its launch live, its turn this thread's and
 * running, and the sign-in it was sent with still standing (signInHoldsFor: its person still has an active sign-in at the
 * turn's account generation, an active approver; removed, reset or revoked ends it). A read that fails is no. */
function authorizedNow(store: Store, digest: string, turn: string, person: string, epoch: number): boolean {
  try {
    return store.handle.prepare(`SELECT 1 AS ok FROM flexible_relay_grant g JOIN flexible_thread_launch l ON l.id = g.launch AND l.thread = g.thread
      JOIN thread_turn t ON t.id = ? AND t.thread = g.thread AND t.status = 'running' WHERE g.token_digest = ? AND g.revoked_at IS NULL AND l.state = 'live'`).get(turn, digest) !== undefined
      && signInHoldsFor(store, { turn, person, epoch });
  } catch { return false; }
}
const SSE_EVENT_LIMIT = 1024 * 1024;

/** The thread's running turn the token's launch may spend for: exactly one running, on this agent, held by the launch's
 * own holder, and owned by the person who started the thread (whose sign-in alone it may use). */
function currentTurn(store: Store, thread: string, grant: Grant, provider: string): FlexibleTurnRow | null {
  const rows = store.handle.prepare("SELECT id FROM thread_turn WHERE thread = ? AND status = 'running'").all(thread);
  if (rows.length !== 1) return null;
  const turn = flexibleTurn(store, String(rows[0]!["id"]));
  const starter = store.handle.prepare("SELECT created_by FROM flexible_thread WHERE id = ?").get(thread)?.["created_by"];
  return turn !== null && turn.status === "running" && turn.provider === provider && turn.holder === grant.holder && typeof starter === "string" && turn.owner === starter ? turn : null;
}

// ---- usage, read from the answer --------------------------------------------------------------------------------------

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Meter = { feed: (text: string) => void; finish: () => { complete: boolean; usage: Usage };
  /** Whether the answer's terminal event has been read (a stream's message_stop). */
  stopped: () => boolean };
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const PARSE_LIMIT = 16 * 1024 * 1024;

/** Anthropic's Messages answers: a streamed one's message_start and message_delta usage (the largest seen of each
 * figure, as they are running totals) and its message_stop; a whole one's `usage`; a token count's `input_tokens`
 * (which costs nothing). Complete only when the answer was read to its end without an error event AND every required
 * counter was there as a whole non-negative number: input and output tokens in message_start's usage and output tokens
 * in a message_delta's (streamed), or input and output tokens in `usage` (whole). A counter that is there but isn't one,
 * or a missing one, makes the call's cost unknown, never zero. */
function anthropicMeter(route: "messages" | "count-tokens", streamed: boolean): Meter {
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let broken = false, started = false, stopped = false, errored = false, buffer = "";
  let startUsage = false, deltaUsage = false;
  /** Whether `raw` is a usage object carrying each of `required` as a whole non-negative number. */
  const has = (raw: unknown, required: readonly string[]): boolean => raw !== null && typeof raw === "object" && !Array.isArray(raw)
    && required.every(key => count((raw as Record<string, unknown>)[key]) !== null);
  let read: { complete: boolean; usage: Usage } | null = null;
  const take = (raw: unknown) => {
    if (raw === null || typeof raw !== "object") return;
    const u = raw as Record<string, unknown>;
    const max = (key: keyof Usage, value: unknown) => { const n = count(value); if (n !== null) usage[key] = Math.max(usage[key], n); else if (value !== undefined && value !== null) broken = true; };
    max("input", u["input_tokens"]); max("output", u["output_tokens"]); max("cacheRead", u["cache_read_input_tokens"]); max("cacheWrite", u["cache_creation_input_tokens"]);
  };
  const event = (block: string) => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (data === "") return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { broken = true; return; }
    if (parsed["type"] === "message_start") {
      started = true;
      const raw = (parsed["message"] as Record<string, unknown> | undefined)?.["usage"];
      if (has(raw, ["input_tokens", "output_tokens"])) startUsage = true;
      take(raw);
    } else if (parsed["type"] === "message_delta") {
      if (has(parsed["usage"], ["output_tokens"])) deltaUsage = true;
      take(parsed["usage"]);
    }
    else if (parsed["type"] === "message_stop") stopped = true;
    else if (parsed["type"] === "error") errored = true;
  };
  return {
    stopped: () => stopped,
    feed(text) {
      if (broken) return;
      buffer += text;
      if (!streamed) { if (buffer.length > PARSE_LIMIT) { broken = true; buffer = ""; } return; }
      for (let at = buffer.search(/\r?\n\r?\n/); at >= 0; at = buffer.search(/\r?\n\r?\n/)) {
        const end = buffer.slice(at).match(/^\r?\n\r?\n/)![0].length;
        event(buffer.slice(0, at));
        buffer = buffer.slice(at + end);
      }
      if (buffer.length > 1024 * 1024) { broken = true; buffer = ""; }
    },
    finish() {
      // Read once: what the answer said is fixed when it ends.
      read ??= (() => {
        if (streamed) {
          if (!broken && buffer.trim() !== "") event(buffer);
          return { complete: !broken && started && startUsage && deltaUsage && stopped && !errored, usage };
        }
        if (broken) return { complete: false, usage };
        try {
          const parsed = JSON.parse(buffer) as Record<string, unknown>;
          if (route === "count-tokens") return { complete: count(parsed["input_tokens"]) !== null, usage };
          take(parsed["usage"]);
          return { complete: !broken && parsed["type"] === "message" && has(parsed["usage"], ["input_tokens", "output_tokens"]), usage };
        } catch { return { complete: false, usage }; }
      })();
      return read;
    },
  };
}
const USAGE_READERS: Readonly<Record<RelayUpstream["usage"], (route: "messages" | "count-tokens", streamed: boolean) => Meter>> = Object.freeze({ "anthropic-messages": anthropicMeter });

// ---- the body: one reading, inline content only ----------------------------------------------------------------------

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 64;
/**
 * Why a JSON text can't be read one way only, or null: a key repeated in one object (parsers disagree on which wins), a
 * reserved key (`__proto__`, `constructor`, `prototype`), nesting past 64, or a top level that isn't an object. A
 * scanner over the text itself, so it sees what JSON.parse would hide; malformed text is JSON.parse's to refuse.
 */
function jsonShapeProblem(text: string): string | null {
  type Frame = { object: boolean; keys: Set<string>; expectKey: boolean };
  const stack: Frame[] = [];
  let at = 0, top = true;
  const skipSpace = () => { while (at < text.length && /[\s]/.test(text[at]!)) at++; };
  skipSpace();
  if (text[at] !== "{") return "the request isn't one JSON object";
  while (at < text.length) {
    const c = text[at]!;
    if (c === "{" || c === "[") {
      if (!top && stack.length === 0) return "more than one JSON value";
      top = false;
      if (stack.length >= MAX_DEPTH) return "the request is nested too deeply";
      stack.push({ object: c === "{", keys: new Set(), expectKey: c === "{" });
      at++;
    } else if (c === "}" || c === "]") {
      stack.pop();
      at++;
    } else if (c === '"') {
      const start = at++;
      while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
      at++;
      const frame = stack.at(-1);
      if (frame?.object === true && frame.expectKey) {
        let key: string;
        try { key = JSON.parse(text.slice(start, at)) as string; } catch { return null; }
        if (RESERVED_KEYS.has(key)) return `the reserved key ${key}`;
        if (frame.keys.has(key)) return `the key ${key.slice(0, 40)} is repeated`;
        frame.keys.add(key);
        frame.expectKey = false;
      }
    } else if (c === ",") {
      const frame = stack.at(-1);
      if (frame?.object === true) frame.expectKey = true;
      at++;
    } else {
      if (stack.length === 0 && !/\s/.test(c)) return "more than one JSON value";
      at++;
    }
  }
  return null;
}

/**
 * Where a call would have the service fetch something itself, or null: every content block in `system`, each message's
 * `content`, a tool result's `content` and a document's inline `content` must be a listed block type, and any `source`
 * it has a listed (inline) type for that block. An allowlist: anything unknown refuses.
 */
function serverFetchIn(body: Record<string, unknown>, allowed: Readonly<Record<string, readonly string[]>>): string | null {
  const blocks = (value: unknown, where: string, depth: number): string | null => {
    if (typeof value === "string" || value === undefined) return null;
    if (!Array.isArray(value)) return `${where} isn't text or a list of blocks`;
    if (depth > 8) return `${where} is nested too deeply`;
    for (const one of value) {
      if (one === null || typeof one !== "object" || Array.isArray(one)) return `${where} has a block that isn't one`;
      const block = one as Record<string, unknown>;
      const type = typeof block["type"] === "string" ? block["type"] : "";
      const sources = Object.hasOwn(allowed, type) ? allowed[type]! : null;
      if (sources === null) return `${where} has a ${type.slice(0, 40) || "nameless"} block`;
      if (block["file_id"] !== undefined) return `${where} names a stored file`;
      if (block["source"] !== undefined) {
        const source = block["source"];
        if (source === null || typeof source !== "object" || Array.isArray(source)) return `${where} has a ${type} source that isn't one`;
        const kind = typeof (source as Record<string, unknown>)["type"] === "string" ? (source as Record<string, unknown>)["type"] as string : "";
        if (!sources.includes(kind)) return `${where} has a ${type} from a ${kind.slice(0, 40) || "nameless"} source`;
        if (kind === "content") { const inner = blocks((source as Record<string, unknown>)["content"], `${where} ${type}`, depth + 1); if (inner !== null) return inner; }
      }
      if (type === "tool_result") { const inner = blocks(block["content"], `${where} tool result`, depth + 1); if (inner !== null) return inner; }
    }
    return null;
  };
  const system = blocks(body["system"], "system", 0);
  if (system !== null) return system;
  const messages = body["messages"];
  if (messages !== undefined && !Array.isArray(messages)) return "messages isn't a list";
  for (const message of (messages ?? []) as unknown[]) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return "a message isn't one";
    const inner = blocks((message as Record<string, unknown>)["content"], "a message", 0);
    if (inner !== null) return inner;
  }
  return null;
}

// ---- the relay ---------------------------------------------------------------------------------------------------------

/** Which listed service serves each agent's turns (only Claude in this slice). */
const UPSTREAM_OF: Readonly<Record<string, keyof typeof FLEXIBLE_RELAY_UPSTREAMS>> = Object.freeze({ claude: "claude" });
/** Answer headers passed back to the agent; everything else (cookies, locations, the service's own identifiers) stays. */
const PASS_BACK = /^(?:content-type|request-id|retry-after|x-should-retry|anthropic-ratelimit-[a-z0-9-]+)$/;
const ERROR_BODY_LIMIT = 64 * 1024;
const UPSTREAM_IDLE_MS = 10 * 60_000;
const WATCH_MS = 250;
const THREAD_ID = /^[0-9a-f]{32}$/;

type CallRecord = { turn: string | null; at: string; route: "messages" | "count-tokens" | "other"; model: string | null; streamed: boolean;
  status: "completed" | "incomplete" | "upstream-error" | "redirect-refused" | "aborted" | "refused"; reason: CallReason | null; httpStatus: number | null;
  usage: Usage; charge: { costUsd: number | null; incomplete: boolean } | null; detail: string | null;
  /** Whose sign-in, which generation, the call was sent with (null: nothing was sent with one); and whether Claude
   * refused that sign-in on it. */
  signIn?: { person: string; generation: string; epoch?: number } | null; signInRefused?: boolean };

/**
 * Start the sign-in relay for one ready thread: loopback, outside the fence, one per thread. Its port is what the
 * thread's fence admits as its second relay (startFlexibleTurn passes it), and every launch of the thread gets its own
 * token from `issue`. `log` hears one redacted line per call (never a credential, token or header value).
 */
export async function startFlexibleRelay(store: Store, input: { thread: string; log?: (line: string) => void }): Promise<FlexibleRelayServer | FlexibleRelayRefusal> {
  if (!flexibleAvailable(store)) return refuse("not-available");
  if (typeof input?.thread !== "string" || !THREAD_ID.test(input.thread) || (input.log !== undefined && typeof input.log !== "function")) return refuse("invalid-request");
  const thread = input.thread;
  const row = store.handle.prepare("SELECT state FROM flexible_thread WHERE id = ?").get(thread);
  if (row === undefined || row["state"] !== "ready") return refuse("thread-unknown");
  const file = store.databaseFile();
  let state: string;
  try { if (file === null || file === "" || file === ":memory:") return refuse("no-state-folder"); state = dirname(realpathSync(file)); } catch { return refuse("no-state-folder"); }
  const log = (line: string) => { try { input.log?.(redact(line)); } catch { /* a listener's trouble is not the call's */ } };

  /** A call being forwarded: whose token, launch and turn it spends for. `cut` is set the moment its authority ends (a
   * writer's cancellation, synchronously): no byte of its answer is forwarded after that. */
  type Live = { digest: string; launch: string; turn: string; person: string; epoch: number; cut: boolean; abort: (why: string) => void };
  const calls = new Set<Live>();
  let pending = 0;
  let closing = false;
  /** Reservations (thread_relay_pending) of this relay's calls still being forwarded. */
  const ours = new Set<number>();
  /** This relay's own name on its reservations: another one's are a relay that is gone. */
  const instance = randomBytes(16).toString("hex");
  /** Settlements that couldn't be written, tried again on every watcher tick; meanwhile their reservations stay. */
  const unsettled = new Map<number, () => boolean>();

  /** Write the call's record, and charge it to its turn when it was forwarded, in one transaction that also clears its
   * reservation (a reservation already cleared means it was settled or reconciled: nothing is charged twice). Whether
   * the record is written. */
  const settle = (grant: Grant, record: CallRecord, secrets: readonly string[], reservation: number | null = null): boolean => {
    let written = false;
    try {
      store.transact(() => {
        if (reservation !== null && Number(store.handle.prepare("DELETE FROM thread_relay_pending WHERE id = ?").run(reservation).changes) !== 1) { written = true; return; }
        let cost = 0, basis: FlexibleCostBasis | null = null, detail = record.detail;
        if (record.status !== "refused" && record.turn !== null) {
          const usage = record.usage;
          // Input-equivalent tokens, never cheaper than the real price at the input rate: a cache read is counted as
          // input, a cache write twice (its price is at most twice the input's).
          const charged = record.charge === null ? null : chargeFlexibleTurn(store, { turn: record.turn,
            usage: { tokensIn: usage.input + usage.cacheRead + 2 * usage.cacheWrite, tokensOut: usage.output, costUsd: record.charge.costUsd },
            ...(record.model === null ? {} : { model: record.model }), incomplete: record.charge.incomplete });
          if (charged !== null && charged.ok) { cost = charged.costMicrousd; basis = charged.basis; }
          else {
            // A charge the turn refused (counters too large to add, say) is never just dropped: the call is charged as
            // unknown cost (F2e's hold), or, if even that is refused, nothing is written and the reservation stays.
            const unknown = chargeFlexibleTurn(store, { turn: record.turn, usage: { tokensIn: 0, tokensOut: 0, costUsd: null }, incomplete: true });
            if (!unknown.ok) throw new Error(`the call couldn't be charged: ${charged === null ? "no charge" : charged.reason}, then ${unknown.reason}`);
            basis = "unknown";
            detail = `${detail ?? ""}${detail ? "; " : ""}its usage couldn't be charged (${charged === null ? "no charge" : charged.reason}), so it counts as unknown`;
          }
        }
        const refused = record.status === "refused";
        const signIn = record.signIn ?? null, signInRefused = signIn !== null && record.signInRefused === true && record.status === "upstream-error";
        store.handle.prepare(`INSERT INTO thread_relay_call (thread, turn, launch, upstream, at, ended_at, route, model, streamed, status, reason, http_status, tokens_in, tokens_out, cache_read, cache_write, cost_microusd, cost_basis, detail,
          sign_in_person, sign_in_generation, sign_in_refused, sign_in_epoch)
          VALUES (?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(thread, record.turn, grant.launch, record.at, new Date().toISOString(), record.route,
          record.model !== null && record.model.length <= 200 ? record.model : null, record.streamed ? 1 : 0, record.status, record.reason, record.httpStatus,
          refused ? 0 : record.usage.input, refused ? 0 : record.usage.output, refused ? 0 : record.usage.cacheRead, refused ? 0 : record.usage.cacheWrite, cost, basis,
          detail === null ? null : redact(detail, secrets).slice(0, 500), signIn?.person ?? null, signIn?.generation ?? null, signInRefused ? 1 : null, signIn?.epoch ?? null);
        // Claude refused the sign-in: that generation is refused from this row on (derived), and the turn ends with
        // Toolroll's own words, in the same transaction (a row that can't be written marks nothing and ends nothing).
        if (signInRefused && record.turn !== null && record.httpStatus !== null) {
          interruptTurnAndStop(store, { turn: record.turn, words: signInRefusedWords(record.httpStatus), reason: "Claude refused its owner's sign-in for threads", at: new Date().toISOString(), launch: grant.launch });
        }
        // A refusal of Toolroll's own that means this turn can't go on (no sign-in that counts, one Claude refused, a
        // billing that moved, threads turned off) ends the turn the same way, with the words the agent was sent, and its
        // agent is required to stop: it never keeps asking on a turn the record says is over.
        if (refused && record.turn !== null && record.reason !== null && TURN_ENDING_REFUSALS.has(record.reason)) {
          interruptTurnAndStop(store, { turn: record.turn, words: RELAY_CALL_ANSWERS[record.reason].message, reason: `the relay refused its call (${record.reason})`, at: new Date().toISOString(), launch: grant.launch });
        }
        written = true;
      });
    } catch (error) {
      log(redact(`relay: a call's record couldn't be written (its reservation holds the thread until it is): ${error instanceof Error ? error.message : String(error)}`, secrets));
      return false;
    }
    log(redact(`relay call ${record.status}${record.reason === null ? "" : ` (${record.reason})`} · ${record.route} · ${record.model ?? "-"} · ${record.httpStatus ?? "-"}${record.detail === null ? "" : ` · ${record.detail}`}`, secrets));
    return written;
  };

  /** A reservation no call of this relay is forwarding, whose turn has ended: its charge was never recorded (a failed
   * write, a Toolroll process gone mid-call), so the turn takes it as unknown cost, and it is cleared. Inside the caller's
   * transaction. */
  const reconcile = (row: Record<string, unknown>): void => {
    const id = Number(row["id"]), turnId = String(row["turn"]);
    if (Number(store.handle.prepare("DELETE FROM thread_relay_pending WHERE id = ?").run(id).changes) !== 1) return;
    // A token count costs nothing whatever happened to it; anything else is unknown cost. A charge the turn refuses
    // undoes the whole reconciliation (the reservation stays).
    const free = row["route"] === "count-tokens";
    const charged = chargeFlexibleTurn(store, { turn: turnId, usage: { tokensIn: 0, tokensOut: 0, costUsd: free ? 0 : null }, incomplete: !free });
    if (!charged.ok) throw new Error(`its reservation couldn't be reconciled: ${charged.reason}`);
    const now = new Date().toISOString();
    store.handle.prepare(`INSERT INTO thread_relay_call (thread, turn, launch, upstream, at, ended_at, route, model, streamed, status, reason, http_status, cost_microusd, cost_basis, detail, sign_in_person, sign_in_generation, sign_in_epoch)
      VALUES (?, ?, ?, 'claude', ?, ?, ?, NULL, 0, 'incomplete', NULL, NULL, 0, ?, ?, ?, ?, ?)`).run(thread, turnId, String(row["launch"]), String(row["reserved_at"]), now, free ? "count-tokens" : "messages",
      charged.basis, free ? "a token count whose record was lost; it costs nothing" : "its charge was never recorded, so it counts as unknown", row["sign_in_person"] ?? null, row["sign_in_generation"] ?? null, row["sign_in_epoch"] ?? null);
    unsettled.delete(id);
  };

  /**
   * Reconcile, from the record, every reservation of this thread no call is being forwarded for: one made by another
   * relay (gone: a crash or a restart of Toolroll) at once, whatever its turn; one of this relay's whose settlement
   * failed once its turn has ended (until then it is retried with its real usage, and holds the turn). Runs when the
   * relay starts, on every watcher tick and right after a turn ends; a reservation that can't be reconciled now stays.
   */
  const sweep = (): void => {
    let rows: Record<string, unknown>[];
    try { rows = store.handle.prepare("SELECT id, turn, launch, relay, route, reserved_at, sign_in_person, sign_in_generation, sign_in_epoch FROM thread_relay_pending WHERE thread = ? ORDER BY id").all(thread) as Record<string, unknown>[]; }
    catch { return; }
    for (const row of rows) {
      if (ours.has(Number(row["id"]))) continue;
      if (row["relay"] === instance) {
        let running = true;
        try { running = flexibleTurn(store, String(row["turn"]))?.status === "running"; } catch { continue; }
        if (running) continue;
      }
      try { store.transact(() => reconcile(row)); } catch (error) { log(`relay: a reservation couldn't be reconciled yet: ${error instanceof Error ? error.message : String(error)}`); }
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const at = new Date().toISOString();
    const reply = (status: number, type: string, message: string, extra: OutgoingHttpHeaders = {}) => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra }).end(errorBody(type, message));
    };
    // Who is calling: exactly one header carries the relay token, and it is a live grant of this thread's.
    const bearer = request.headers.authorization === undefined ? undefined : /^Bearer (\S+)$/.exec(String(request.headers.authorization))?.[1] ?? "";
    const xkey = request.headers["x-api-key"] === undefined ? undefined : String(request.headers["x-api-key"]);
    if (bearer !== undefined && xkey !== undefined) { request.resume(); reply(400, "invalid_request_error", RELAY_CALL_ANSWERS["credential-header"].message); return; }
    const tokenHeader = bearer !== undefined ? "authorization" : xkey !== undefined ? "x-api-key" : null;
    let grant: Grant | null = null;
    try { grant = grantOf(store, bearer ?? xkey ?? ""); } catch { grant = null; }
    if (grant === null || grant.thread !== thread || closing) { request.resume(); reply(401, "authentication_error", UNAUTHORIZED); return; }
    const authed = grant;

    // From here every call is recorded: what it was, and why it was refused or how it ended.
    const upstreamName = UPSTREAM_OF["claude"]!;
    const upstream = FLEXIBLE_RELAY_UPSTREAMS[upstreamName];
    let route: { path: string; kind: "messages" | "count-tokens"; queries: readonly string[] } | null = null;
    let model: string | null = null, streamed = false, turn: FlexibleTurnRow | null = null;
    const refused = (reason: CallReason, detail: string | null = null, extra: OutgoingHttpHeaders = {}) => {
      const words = RELAY_CALL_ANSWERS[reason];
      request.resume();
      reply(words.status, words.type, words.message, extra);
      settle(authed, { turn: turn?.id ?? null, at, route: route?.kind ?? "other", model, streamed, status: "refused", reason, httpStatus: words.status,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, charge: null, detail }, []);
    };
    if (calls.size + pending >= upstream.limits.concurrency) { refused("too-many", null, { "retry-after": "1" }); return; }
    pending++;
    let reserved = true;
    const release = () => { if (reserved) { reserved = false; pending--; } };
    try {
      // The route: exactly a listed path and query, POST, nothing encoded or doubled.
      const raw = String(request.url ?? "");
      const [path, query = ""] = raw.split(/\?(.*)$/s, 2) as [string, string?];
      route = upstream.routes.find(one => one.path === path) ?? null;
      if (request.method !== "POST" || route === null || !route.queries.includes(query) || raw.includes("#")) { route = null; refused("route"); return; }

      // Headers: nothing that selects a credential or overrides the service; the listed ones in their listed shapes.
      for (const [name, value] of Object.entries(request.headers)) {
        if (name === tokenHeader) continue;
        if (upstream.refused.test(name)) { refused("credential-header", `refused header ${name}`); return; }
        const shape = upstream.passHeaders[name];
        if (shape !== undefined && (Array.isArray(value) || typeof value !== "string" || !shape.test(value))) { refused("header", `header ${name}`); return; }
      }
      const betas = request.headers["anthropic-beta"] === undefined ? [] : String(request.headers["anthropic-beta"]).split(",").map(one => one.trim()).filter(one => one !== "");
      const unlisted = betas.find(one => !upstream.betas.includes(one));
      if (unlisted !== undefined) { refused("beta", `beta ${unlisted.slice(0, 80)}`); return; }
      if (request.headers["content-type"] === undefined) { refused("header", "no content-type"); return; }

      // Bound to the thread's current turn, on this agent, held by the token's launch's holder.
      turn = currentTurn(store, thread, authed, "claude");
      if (turn === null) { refused("no-turn"); return; }

      // The body: at most the cap, JSON, the model and max_tokens within limits, nothing that reaches out on its own.
      const declared = request.headers["content-length"] === undefined ? null : Number(request.headers["content-length"]);
      if (declared !== null && (!Number.isSafeInteger(declared) || declared > upstream.limits.maxBodyBytes)) {
        response.once("finish", () => request.destroy());
        refused("body-too-large", null, { connection: "close" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0, tooLarge = false;
      const ended = await new Promise<boolean>(done => {
        request.on("data", (chunk: Buffer) => {
          if (tooLarge) return;
          size += chunk.length;
          if (size > upstream.limits.maxBodyBytes) { tooLarge = true; done(true); return; }
          chunks.push(chunk);
        });
        request.once("end", () => done(true));
        request.once("error", () => done(false));
        request.once("close", () => done(!request.readableAborted));
      });
      if (tooLarge) { chunks.length = 0; response.once("finish", () => request.destroy()); refused("body-too-large", null, { connection: "close" }); return; }
      if (!ended) { release(); response.destroy(); return; }
      const body = Buffer.concat(chunks);
      // One reading of the body, the one checked and the one sent: a key repeated anywhere (which another parser could
      // read the other way), a reserved key or a top level that isn't an object refuses it.
      let parsed: Record<string, unknown>;
      const text = body.toString("utf8");
      const shape = jsonShapeProblem(text);
      if (shape !== null) { refused("body", shape); return; }
      try {
        const value = JSON.parse(text) as unknown;
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        parsed = value as Record<string, unknown>;
      } catch { refused("body"); return; }
      model = typeof parsed["model"] === "string" ? parsed["model"] : null;
      if (model === null || !upstream.models.test(model) || (model !== turn.model && !upstream.helperModels.test(model))) {
        // Only a name of the service's own shape is kept on the record.
        if (model !== null && !upstream.models.test(model)) model = null;
        refused("model"); return;
      }
      streamed = parsed["stream"] === true;
      if (parsed["stream"] !== undefined && typeof parsed["stream"] !== "boolean") { refused("body", "stream isn't true or false"); return; }
      if (route.kind === "messages") {
        const max = parsed["max_tokens"];
        if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1 || max > upstream.limits.maxTokens) { refused("max-tokens"); return; }
      }
      const tools = Array.isArray(parsed["tools"]) ? parsed["tools"] as unknown[] : [];
      const serverTool = upstream.refusedFields.find(field => parsed[field] !== undefined)
        ?? (tools.some(tool => tool !== null && typeof tool === "object" && (tool as Record<string, unknown>)["type"] !== undefined && !upstream.clientToolTypes.includes(String((tool as Record<string, unknown>)["type"]))) ? "tools" : undefined);
      if (serverTool !== undefined) { refused("server-tool", `field ${serverTool}`); return; }
      const fetched = serverFetchIn(parsed, upstream.contentBlocks);
      if (fetched !== null) { refused("server-fetch", fetched); return; }

      // The turn's owner's own sign-in (never anyone else's), on the billing this turn was admitted for. The whole
      // dispatch invariant is checked again in the reservation below.
      const found = signInForTurn(store, state, turn);
      if (!found.ok) { refused(found.reason); return; }
      const credential: DispatchSignIn = found.signIn;
      const auth = upstream.auth[credential.kind];
      if (auth.billing !== turn.billing) { refused("billing-mismatch"); return; }
      const secrets = [credential.value];
      const signIn = { person: credential.person, generation: credential.generation };

      // At the moment of use, in one transaction: the token still live, the turn still this thread's running one, no
      // earlier call of this thread left uncharged (one whose turn has ended is reconciled as unknown cost; one in the
      // running turn holds it), and this call's reservation written before anything is sent.
      let reservation: number | null = null;
      // The person's removal epoch the call is dispatched under (read in the reservation below): any removal after it
      // stops the call, whatever is saved next.
      let epoch = -1;
      let blocked: "unauthorized" | "no-turn" | "unsettled" | "threads-off" | "no-sign-in" | "sign-in-refused" | null = null;
      try {
        store.transact(() => {
          // Interactive agent threads still on (flexible-available.ts), read here: turned off, nothing more is sent.
          if (!flexibleAvailable(store)) { blocked = "threads-off"; return; }
          if (!grantStillLive(store, authed.digest)) { blocked = "unauthorized"; return; }
          const now = currentTurn(store, thread, authed, "claude");
          if (now === null || now.id !== turn!.id) { blocked = "no-turn"; return; }
          // The dispatch invariant, from the record: the thread's starter is the turn's owner is the sign-in's person, at
          // one account generation, an active approver, this generation still active, its billing the turn's, never
          // refused by Claude.
          const stands = signInStandsAt(store, { thread, turn: now.id, person: signIn.person, generation: signIn.generation });
          if (stands !== null) { blocked = stands; return; }
          epoch = signInEpochOf(store, signIn.person);
          for (const row of store.handle.prepare("SELECT id, turn, launch, relay, route, reserved_at, sign_in_person, sign_in_generation, sign_in_epoch FROM thread_relay_pending WHERE thread = ? ORDER BY id").all(thread)) {
            if (ours.has(Number(row["id"]))) continue;
            // This relay's own unsettled call in the running turn holds it (it is retried with its real usage).
            if (row["relay"] === instance && flexibleTurn(store, String(row["turn"]))?.status === "running") { blocked = "unsettled"; return; }
            reconcile(row);
          }
          reservation = Number(store.handle.prepare("INSERT INTO thread_relay_pending (thread, turn, launch, holder, relay, route, reserved_at, sign_in_person, sign_in_generation, sign_in_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(thread, turn!.id, authed.launch, authed.holder, instance, route!.kind, new Date().toISOString(), signIn.person, signIn.generation, epoch).lastInsertRowid);
        });
      } catch { refused("check-failed"); return; }
      if (blocked === "unauthorized") { release(); request.resume(); reply(401, "authentication_error", UNAUTHORIZED); return; }
      if (blocked !== null) { refused(blocked); return; }
      const reserved = reservation!;
      ours.add(reserved);

      // Forward: the fixed origin, the exact route, headers built here, the credential added here, and exactly the object
      // that was checked (written again from it, never the agent's own bytes).
      const sent = Buffer.from(JSON.stringify(parsed), "utf8");
      const target = new URL(`${route.path}${query === "" ? "" : `?${query}`}`, upstream.origin);
      const headers: OutgoingHttpHeaders = { host: target.host, "content-type": "application/json", "content-length": String(sent.length), "accept-encoding": "identity",
        "anthropic-version": String(request.headers["anthropic-version"] ?? "2023-06-01") };
      for (const name of ["accept", "user-agent", "x-app"]) if (typeof request.headers[name] === "string") headers[name] = request.headers[name];
      const allBetas = [...new Set([...betas, ...auth.betas])];
      if (allBetas.length > 0) headers["anthropic-beta"] = allBetas.join(",");
      headers[auth.header] = `${auth.prefix}${credential.value}`;
      const routeKind = route.kind;
      const turnId = turn.id;
      // The call is recorded and charged before the agent sees its answer end: its next call finds this one on the record.
      const live = await forward(target, headers, sent, response, routeKind, streamed, upstream, secrets, one => { release(); calls.add(one); }, authed, turnId, signIn.person, epoch,
        result => {
          const record: CallRecord = { turn: turnId, at, route: routeKind, model, streamed: result.streamed, status: result.status, reason: null, httpStatus: result.httpStatus,
            usage: result.usage, charge: result.charge, detail: result.detail, signIn: { ...signIn, epoch }, signInRefused: result.signInRefused };
          // A settlement that can't be written keeps its reservation (the thread is held) and is tried again.
          if (!settle(authed, record, secrets, reserved)) unsettled.set(reserved, () => settle(authed, record, secrets, reserved));
          ours.delete(reserved);
        });
      calls.delete(live);
    } finally { release(); }
  };

  type Forwarded = { status: CallRecord["status"]; httpStatus: number | null; usage: Usage; charge: CallRecord["charge"]; detail: string | null; streamed: boolean; signInRefused: boolean };
  /** One call to the service, and its answer back to the agent (redacted, metered). Never follows a redirect. `ended`
   * records the call; it runs before the agent's answer is finished. */
  const forward = (target: URL, headers: OutgoingHttpHeaders, body: Buffer, response: ServerResponse, route: "messages" | "count-tokens", streamedAsked: boolean,
    upstream: RelayUpstream, secrets: readonly string[], started: (live: Live) => void, grant: Grant, turn: string, person: string, epoch: number, ended: (result: Forwarded) => void) =>
    new Promise<Live>(resolve => {
      const free = route === "count-tokens";
      let sent = false, settled = false, streamed = streamedAsked;
      let meter: Meter | null = null;
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      const outgoing = send({ protocol: target.protocol, hostname: target.hostname, port: target.port === "" ? undefined : Number(target.port), method: "POST",
        path: `${target.pathname}${target.search}`, headers, agent: false, timeout: UPSTREAM_IDLE_MS, ...(target.protocol === "https:" ? { servername: target.hostname } : {}) });
      const finish = (status: CallRecord["status"], httpStatus: number | null, detail: string | null, complete: boolean, answer: () => void = () => {}, signInRefused = false) => {
        if (settled) return;
        settled = true;
        const usage = meter?.finish().usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        // Nothing reached the service, or it answered without doing the work (an error, a redirect): no cost. A token
        // count costs nothing. Otherwise what the answer said, or unknown when it couldn't be read whole.
        const charge = free || (!sent && !complete) || status === "upstream-error" || status === "redirect-refused" ? { costUsd: 0, incomplete: false }
          : complete ? { costUsd: null, incomplete: false } : { costUsd: null, incomplete: true };
        try { ended({ status, httpStatus, usage, charge, detail, streamed, signInRefused }); } finally {
          try { answer(); } catch { /* an agent that hung up */ }
          resolve(live);
        }
      };
      const live: Live = { digest: grant.digest, launch: grant.launch, turn, person, epoch, cut: false, abort: why => {
        live.cut = true;
        outgoing.destroy();
        finish("aborted", null, why, false, () => {
          if (!response.headersSent) response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" }).end(errorBody("invalid_request_error", `Stopped: ${why}.`));
          else response.destroy();
        });
      } };
      started(live);
      outgoing.on("timeout", () => outgoing.destroy(new Error("the model service stopped answering")));
      outgoing.on("error", error => {
        if (settled) return;
        finish(sent ? "incomplete" : "upstream-error", null, redact(`the model service couldn't be reached: ${error.message}`, secrets), false, () => {
          if (!response.headersSent) response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" }).end(errorBody("api_error", "Toolroll's sign-in relay couldn't reach the model service."));
          else response.destroy();
        });
      });
      outgoing.on("finish", () => { sent = true; });
      // The agent hung up: the call to the service ends too.
      response.on("close", () => { if (!response.writableFinished && !settled) { outgoing.destroy(); finish("aborted", null, "the agent hung up", false); } });
      outgoing.on("response", answer => {
        const status = answer.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          answer.resume();
          finish("redirect-refused", status, "a redirect, not followed", false,
            () => response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" }).end(errorBody("api_error", "The model service answered with a redirect, which Toolroll's sign-in relay doesn't follow.")));
          return;
        }
        if (status < 200 || status >= 300) {
          // An error: read (bounded), redacted, and passed back as the service's own error shape.
          const parts: Buffer[] = [];
          let size = 0;
          answer.on("data", (chunk: Buffer) => { if (size < ERROR_BODY_LIMIT) { parts.push(chunk); size += chunk.length; } });
          answer.on("end", () => {
            // Parsed first, every string in it redacted (an escaped spelling is a plain one by then), written again; text
            // that isn't JSON is redacted as it is. Then the exact bytes about to leave are checked once more, in every
            // JSON spelling: anything still carrying a credential is withheld whole.
            const raw = Buffer.concat(parts).toString("utf8").slice(0, ERROR_BODY_LIMIT);
            let parsed: unknown = undefined;
            try { parsed = JSON.parse(raw) as unknown; } catch { parsed = undefined; }
            let out = parsed !== null && typeof parsed === "object" ? JSON.stringify(redactDeep(parsed, secrets)) : errorBody("api_error", redact(raw, secrets).slice(0, 2000));
            if (leaks(out, secrets)) out = errorBody("api_error", "The model service's error was withheld: it carried a credential.");
            const text = out;
            const pass: OutgoingHttpHeaders = { "content-type": "application/json", "cache-control": "no-store" };
            for (const [name, value] of Object.entries(answer.headers)) if (PASS_BACK.test(name) && name !== "content-type" && value !== undefined) pass[name] = redactHeader(value, secrets);
            let kind = "error";
            try { const value = JSON.parse(text) as { error?: { type?: unknown } }; if (typeof value.error?.type === "string" && /^[a-z_]{1,60}$/.test(value.error.type)) kind = value.error.type; } catch { /* not JSON */ }
            // Claude refused the sign-in itself: recorded as such (that generation refused from now on, the turn ended),
            // and the agent gets Toolroll's words as a 403, never Claude's body.
            if (signInRefusedBy(status, kind)) {
              const words = errorBody("permission_error", signInRefusedWords(status));
              finish("upstream-error", status, `Claude didn't accept the sign-in (HTTP ${status})`, false, () => {
                if (!response.headersSent) response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" }).end(words);
              }, true);
              return;
            }
            finish("upstream-error", status, `the model service said ${kind}`, false, () => { if (!response.headersSent) response.writeHead(status, pass).end(out); });
          });
          answer.on("error", () => finish("upstream-error", status, "the model service's error was cut off", false, () => { if (!response.headersSent) response.writeHead(502).end(); else response.destroy(); }));
          return;
        }
        streamed = /^text\/event-stream/i.test(String(answer.headers["content-type"] ?? ""));
        meter = USAGE_READERS[upstream.usage](route, streamed);
        const pass: OutgoingHttpHeaders = { "cache-control": "no-store" };
        for (const [name, value] of Object.entries(answer.headers)) if (PASS_BACK.test(name) && value !== undefined) pass[name] = redactHeader(value, secrets);
        response.writeHead(status, pass);
        const decoder = new StringDecoder("utf8");
        // Authority ended: the call to the service ends too (never left running untracked), and the agent's answer is
        // cut off; it is still charged for what it used.
        const lapsed = (why = "its authority ended before its answer did") => {
          outgoing.destroy();
          finish("aborted", status, why, meter!.finish().complete, () => response.destroy());
        };
        // A whole answer is held, then checked and sanitized whole at its end; a streamed one goes out an event at a
        // time, each sanitized whole (nothing of a credential can straddle two writes), and nothing at all is forwarded
        // unless the call's authority is re-read from the record just before (any process's revocation counts at once).
        let held = "", events = "";
        const takeEvents = (final: boolean): string | null => {
          let out = "";
          for (let at = events.search(/\r?\n\r?\n/); at >= 0; at = events.search(/\r?\n\r?\n/)) {
            const end = at + events.slice(at).match(/^\r?\n\r?\n/)![0].length;
            out += sanitizeEvent(events.slice(0, end), secrets);
            events = events.slice(end);
          }
          if (final && events !== "") { out += sanitizeEvent(events, secrets); events = ""; }
          return events.length > SSE_EVENT_LIMIT ? null : out;
        };
        answer.on("data", (chunk: Buffer) => {
          if (settled || live.cut) return;
          const text = decoder.write(chunk);
          meter!.feed(text);
          if (!streamed) { held += text; if (held.length > PARSE_LIMIT) lapsed("its answer was too large to check"); return; }
          events += text;
          const out = takeEvents(false);
          if (out === null) { lapsed("an event of its answer was too large to check"); return; }
          if (out === "") return;
          if (!authorizedNow(store, grant.digest, turn, person, epoch)) { lapsed(); return; }
          response.write(out);
        });
        answer.on("end", () => {
          if (settled || live.cut) return;
          const rest = decoder.end();
          if (rest !== "") meter!.feed(rest);
          events += rest;
          const out = streamed ? takeEvents(true) ?? "" : sanitizeWhole(held + rest, secrets);
          const read = meter!.finish();
          // Before the answer completes: its token and its turn are re-read from the record; one that lapsed, or can't be
          // read, ends the answer cut off.
          if (!authorizedNow(store, grant.digest, turn, person, epoch)) { lapsed(); return; }
          if (out === null) { finish("aborted", status, "its answer was withheld: it carried a credential", read.complete, () => response.destroy()); return; }
          finish(read.complete ? "completed" : "incomplete", status, read.complete ? null : "the answer's usage couldn't be read whole", read.complete, () => response.end(out));
        });
        const cutOff = () => { if (!settled) finish("incomplete", status, "the model service's answer was cut off", false, () => response.destroy()); };
        answer.on("aborted", cutOff);
        answer.on("error", cutOff);
        answer.on("close", () => { if (!answer.complete) cutOff(); });
      });
      outgoing.end(body);
    });

  // A call whose authority ends is cut at once: the writer that ended it (a turn finished or interrupted, a token or a
  // launch's tokens revoked) tells every relay here, which stops forwarding that call's answer before its next byte; the
  // call's record is written right after the writer's own transaction.
  const cut = (call: Live, why: string) => { if (call.cut) return; call.cut = true; calls.delete(call); queueMicrotask(() => call.abort(why)); };
  const stopListening = onRelayCancel(cancel => {
    const turnEnded = cancel.turn;
    for (const call of [...calls]) {
      if (turnEnded !== undefined && turnEnded === call.turn) cut(call, "the turn ended");
      else if (cancel.launch !== undefined && cancel.launch === call.launch) cut(call, "this thread's agent was stopped");
      else if (cancel.digest !== undefined && cancel.digest === call.digest) cut(call, "its relay token was revoked");
      else if (cancel.person !== undefined && cancel.person === call.person) cut(call, "its Claude sign-in for threads was removed or ended");
    }
    // A turn that ended: its reservations no call of this relay is forwarding are reconciled right after its writer.
    if (turnEnded !== undefined) queueMicrotask(sweep);
  }, () => {
    // The cancellation couldn't be read here: every call this relay is forwarding is cut (never left running).
    for (const call of [...calls]) cut(call, "Toolroll couldn't check its authority");
  });
  // And from the record, for another Toolroll process's revocation: a call whose token or turn lapsed, or whose
  // authority can't be read, is cut. Settlements that couldn't be written are tried again here.
  const watcher = setInterval(() => {
    for (const call of [...calls]) {
      let why: string | null = null;
      try {
        if (!grantStillLive(store, call.digest)) why = "this thread's agent was stopped";
        else if (flexibleTurn(store, call.turn)?.status !== "running") why = "the turn ended";
        else if (!signInHoldsFor(store, { turn: call.turn, person: call.person, epoch: call.epoch })) why = "its Claude sign-in for threads ended";
      } catch { why = "Toolroll couldn't check its authority"; }
      if (why !== null) cut(call, why);
    }
    for (const [id, retry] of [...unsettled]) if (retry()) unsettled.delete(id);
    sweep();
  }, WATCH_MS);
  watcher.unref();

  const server: Server = createServer((request, response) => {
    response.on("error", () => { /* an agent that hung up */ });
    void handle(request, response).catch(error => {
      log(`relay: a call failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" }).end(errorBody("api_error", "Toolroll's sign-in relay failed on this call."));
      else response.destroy();
    });
  });
  // A tunnel gets nothing. An upgrade request has no listener of its own (the console's terminals keep the one upgrade
  // listener in the server): Node hands it to the request handler, which refuses it like any call.
  server.on("connect", (_request, socket) => { socket.on("error", () => {}); socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n"); });
  server.on("clientError", (_error, socket) => { try { socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n"); } catch { /* gone */ } });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  try {
    await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(0, "127.0.0.1", () => { server.off("error", failed); done(); }); });
  } catch { clearInterval(watcher); return refuse("invalid-request"); }
  // Reservations a relay of this thread left behind (Toolroll stopped mid-call) are reconciled before any new call.
  sweep();
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  return {
    thread, url, port,
    issue: grant => {
      // A relay serves one thread: a grant for another is never issued here.
      if (grant.thread !== thread) throw new Error("this relay serves another thread");
      const token = issueRelayGrant(store, grant);
      return { url, token, revoke: () => { revokeRelayGrant(store, token); } };
    },
    inFlight: () => calls.size + pending,
    close: () => new Promise<void>(done => {
      closing = true;
      clearInterval(watcher);
      stopListening();
      for (const call of [...calls]) { calls.delete(call); call.cut = true; call.abort("the relay closed"); }
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}
