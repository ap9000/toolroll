/**
 * Flexible threads, slice F2d (the Flexible plan v2 §4 and §6, Codex round 2 item 9, binding): the answers to a thread's
 * agent. When the agent asks the person something (a permission request or a question), the request is recorded here
 * and its answer moves through one durable state machine, so an answer is never sent on stale authority and never sent
 * twice:
 *
 *   pending ─(the owner decides, or a recorded policy)─▶ decided ─(queued)─▶ sending ─(written)─▶ sent ─(ack)─▶ delivered
 *      │                                                    │                   │                  └─(no ack in time, or
 *      │                                                    │                   │                     its agent gone)─▶ uncertain
 *      │                                                    └──(cancelled, revoked, authority/thread/turn/connection
 *      │                                                        changed before the write)──────────────────────▶ not-sent
 *      │                                                                        └─(write error, crash mid-write)─▶ uncertain
 *      └─(turn ended, agent stopped, Toolroll restarted)─▶ withdrawn
 *
 * The rules this module keeps:
 * - Nothing here works while FLEXIBLE_AVAILABLE is false: every entry point refuses with `not-available` first. No
 *   route, CLI command, MCP tool or chat action reaches it yet (F3 wires the thread view).
 * - Two stores, one decision id. The request and its answer live in the coding catalog (a separate database: in
 *   production `<database>.coding.sqlite`, beside coding sessions), the decision and its intent in the main database
 *   (thread_decision, v167, and an append-only action_ledger row). The decision id is made once and written once on
 *   both sides; every later step proves both sides still name the same id, the same answer bytes (payload digest) and
 *   the same state before it moves.
 * - A model never decides. A decision is a person's (the turn's owner, at the account generation they proved, from a
 *   person's surface) or a recorded policy's (a closed set of rules that only ever decline or cancel). An agent's own
 *   automatic allow or deny is recorded as the provider's, never as anyone's approval, and nothing is sent for it.
 * - The answer token is server-made, single use and bound to its request, turn, connection (the agent launch that
 *   asked: process custody generation), owner and generation. Only its SHA-256 is kept. A second answer, an answer by
 *   another person or at another generation, or an answer after the request moved, is refused and nothing is sent.
 * - The card is the scope: the person answers the request exactly as the card showed it (its digest), and the answer
 *   bytes are fixed when it is decided (their digest is in both stores).
 * - The final authority check and the write to the agent happen together: inside one main-database write transaction
 *   (no other writer, in this process or another, can change authority between them), the person's standing, the
 *   project's Flexible terms, the thread, the turn (still running, still the owner's, still this holder's), the
 *   connection (still the thread's live launch, the very object asked) and the generation are re-read; only then is the
 *   answer written, synchronously, and its outcome recorded in the same transaction. Anything changed: nothing is sent.
 * - Cancellation (the owner's, or a revocation) wins over a decided answer, and over a sending one whose write hasn't
 *   begun; once the write has begun it loses and says so. Exactly one of a cancel and a send wins.
 * - Sent without an ack becomes uncertain (FLEXIBLE_ANSWER_ACK_MS, or at once when its agent launch is gone). Later tool
 *   activity is an ack only when it correlates with exactly one request on that connection and turn.
 * - Uncertain is final: nothing is ever sent again automatically. A crash while decided, sending or sent recovers to
 *   uncertain, never to a resend; a pending request is withdrawn.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { FLEXIBLE_AVAILABLE } from "./flexible-available.js";
import { flexibleDelegationAtUse, FLEXIBLE_LEVELS, FLEXIBLE_UNAVAILABLE, isFlexibleLevel } from "./flexible.js";
import { flexibleLaunch } from "./flexible-launch.js";
import { flexibleTurn, type FlexibleClock } from "./flexible-turns.js";
import { sqliteRuntime } from "./sqlite-runtime.js";
import type { Store } from "./store.js";

export type FlexibleAnswerState = "pending" | "decided" | "sending" | "sent" | "delivered" | "not-sent" | "uncertain" | "withdrawn";
export type FlexibleRequestKind = "permission" | "question";
export type FlexibleDecision = "accept" | "decline" | "cancel" | "answer";
/** How long a sent answer waits for its agent's acknowledgement before it is uncertain. */
export const FLEXIBLE_ANSWER_ACK_MS = 120_000;
/** The policies that may decide a request without a person: each only ever declines or cancels (never allows). */
export const FLEXIBLE_ANSWER_RULES = Object.freeze({
  /** The thread's level has no proven way to ask the person, so Toolroll refuses the request (plan §4). */
  "no-channel": "decline",
  /** The thread was lowered below what the request needs (plan §5). */
  lowered: "cancel",
} as const);
export type FlexibleAnswerRule = keyof typeof FLEXIBLE_ANSWER_RULES;

export type FlexibleAnswerRefusal = { ok: false; reason: FlexibleAnswerReason; message: string; state?: FlexibleAnswerState };
type FlexibleAnswerReason = "not-available" | "invalid-request" | "request-unknown" | "not-a-person" | "token-mismatch" | "already-answered" | "card-changed"
  | "not-owner" | "stale-generation" | "authority-changed" | "thread-changed" | "turn-changed" | "connection-changed" | "stores-disagree" | "too-late" | "not-sent";
const WORDS: Readonly<Record<FlexibleAnswerReason, string>> = Object.freeze({
  "not-available": FLEXIBLE_UNAVAILABLE,
  "invalid-request": "That answer isn't one Toolroll can read. Nothing was sent.",
  "request-unknown": "There's no such request.",
  "not-a-person": "Only a person can answer an agent's request. Nothing was sent.",
  "token-mismatch": "This card isn't the one Toolroll made for this request. Nothing was sent.",
  "already-answered": "This request isn't waiting for an answer any more. Nothing was sent.",
  "card-changed": "The request changed since you saw it. Look at it again before answering. Nothing was sent.",
  "not-owner": "Only the person whose turn this is can answer it. Nothing was sent.",
  "stale-generation": "Your account changed since this started. Sign in again. Nothing was sent.",
  "authority-changed": "You can no longer answer for this thread (its Flexible terms or your access changed). Nothing was sent.",
  "thread-changed": "This thread isn't running any more. Nothing was sent.",
  "turn-changed": "The agent's turn ended or changed. Nothing was sent; if it asks again, you'll get a new card.",
  "connection-changed": "The agent that asked has stopped or restarted. Nothing was sent; if it asks again, you'll get a new card.",
  "stores-disagree": "Toolroll's records of this answer don't agree, so it wasn't sent.",
  "too-late": "Your answer was already sent, so it can't be cancelled.",
  "not-sent": "Your answer wasn't sent.",
});
const refuse = (reason: FlexibleAnswerReason, state?: FlexibleAnswerState, message: string = WORDS[reason]): FlexibleAnswerRefusal =>
  state === undefined ? { ok: false, reason, message } : { ok: false, reason, message, state };
/** What a person sees for an answer whose delivery couldn't be confirmed (plan §6.3). */
export const FLEXIBLE_ANSWER_UNCERTAIN = "We couldn't confirm the agent got your answer. Check its activity. If it asks again, you'll get a new card.";

/** The connection an answer is written to: the agent launch (its id is the launch's) as the holder process holds it.
 * `write` is synchronous, so it runs inside the transaction that made the final check: "written" (handed to the
 * agent), "not-written" (provably nothing went out), or a throw (unknown). `ready` waits until it can be written. */
export type FlexibleAnswerConnection = {
  id: string;
  write: (requestRef: string, answer: FlexibleAnswerPayload) => "written" | "not-written";
  ready?: () => Promise<void>;
};
export type FlexibleAnswerPayload = { decision: "accept" | "decline" | "cancel" } | { answers: Record<string, { answers: string[] }> };

// ---- the catalog --------------------------------------------------------------------------------------------------------

/**
 * The request side, in the coding catalog. One row per request an agent made: what it asked (the card, as shown, and
 * its digest), who may answer (owner and generation, from the turn's record) and where the answer may go (thread, turn,
 * connection, holder), the token's digest, and then the decision (its id, the exact answer and its digest), written
 * once. `state` moves only as the machine above.
 */
const CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_request (
  id               TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  thread           TEXT NOT NULL CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  turn             TEXT NOT NULL CHECK (length(turn) = 32 AND turn NOT GLOB '*[^0-9a-f]*'),
  connection_id    TEXT NOT NULL CHECK (length(connection_id) = 32 AND connection_id NOT GLOB '*[^0-9a-f]*'),
  holder           TEXT NOT NULL CHECK (length(holder) BETWEEN 1 AND 128),
  owner            TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
  owner_generation INTEGER NOT NULL,
  request_ref      TEXT NOT NULL CHECK (length(request_ref) BETWEEN 1 AND 200),
  kind             TEXT NOT NULL CHECK (kind IN ('permission', 'question')),
  card             TEXT NOT NULL CHECK (json_valid(card) AND length(card) <= 65536),
  request_digest   TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  correlation      TEXT CHECK (correlation IS NULL OR length(correlation) BETWEEN 1 AND 200),
  token_digest     TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  state            TEXT NOT NULL CHECK (state IN ('pending', 'decided', 'sending', 'sent', 'delivered', 'not-sent', 'uncertain', 'withdrawn')),
  decision_id      TEXT CHECK (decision_id IS NULL OR (length(decision_id) = 32 AND decision_id NOT GLOB '*[^0-9a-f]*')),
  source           TEXT CHECK (source IS NULL OR source IN ('person', 'policy')),
  decision         TEXT CHECK (decision IS NULL OR decision IN ('accept', 'decline', 'cancel', 'answer')),
  answer           TEXT CHECK (answer IS NULL OR (json_valid(answer) AND length(answer) <= 200000)),
  payload_digest   TEXT CHECK (payload_digest IS NULL OR (length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*')),
  decided_by       TEXT,
  decided_at       TEXT,
  created_at       TEXT NOT NULL,
  sent_at          TEXT,
  ended_at         TEXT,
  detail           TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  CHECK ((decision_id IS NULL) = (source IS NULL) AND (decision_id IS NULL) = (decision IS NULL) AND (decision_id IS NULL) = (answer IS NULL)
    AND (decision_id IS NULL) = (payload_digest IS NULL) AND (decision_id IS NULL) = (decided_by IS NULL) AND (decision_id IS NULL) = (decided_at IS NULL)),
  CHECK (state <> 'pending' OR decision_id IS NULL),
  CHECK (state IN ('pending', 'withdrawn') OR decision_id IS NOT NULL),
  CHECK ((ended_at IS NULL) = (state IN ('pending', 'decided', 'sending', 'sent'))),
  CHECK (sent_at IS NULL OR state IN ('sent', 'delivered', 'uncertain')),
  CHECK (state NOT IN ('sent', 'delivered') OR sent_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS thread_request_ref ON thread_request (connection_id, request_ref);
CREATE INDEX IF NOT EXISTS thread_request_open ON thread_request (thread, state);
CREATE TRIGGER IF NOT EXISTS thread_request_moves BEFORE UPDATE ON thread_request
WHEN NEW.id IS NOT OLD.id OR NEW.thread IS NOT OLD.thread OR NEW.turn IS NOT OLD.turn OR NEW.connection_id IS NOT OLD.connection_id OR NEW.holder IS NOT OLD.holder
  OR NEW.owner IS NOT OLD.owner OR NEW.owner_generation IS NOT OLD.owner_generation OR NEW.request_ref IS NOT OLD.request_ref OR NEW.kind IS NOT OLD.kind
  OR NEW.card IS NOT OLD.card OR NEW.request_digest IS NOT OLD.request_digest OR NEW.correlation IS NOT OLD.correlation OR NEW.token_digest IS NOT OLD.token_digest
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.decision_id IS NOT NULL AND (NEW.decision_id IS NOT OLD.decision_id OR NEW.source IS NOT OLD.source OR NEW.decision IS NOT OLD.decision
    OR NEW.answer IS NOT OLD.answer OR NEW.payload_digest IS NOT OLD.payload_digest OR NEW.decided_by IS NOT OLD.decided_by OR NEW.decided_at IS NOT OLD.decided_at))
  OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS NOT OLD.sent_at)
  OR OLD.state IN ('delivered', 'not-sent', 'uncertain', 'withdrawn')
  OR (OLD.state = 'pending' AND NEW.state NOT IN ('pending', 'decided', 'withdrawn'))
  OR (OLD.state = 'decided' AND NEW.state NOT IN ('decided', 'sending', 'not-sent', 'uncertain'))
  OR (OLD.state = 'sending' AND NEW.state NOT IN ('sending', 'sent', 'not-sent', 'uncertain'))
  OR (OLD.state = 'sent' AND NEW.state NOT IN ('sent', 'delivered', 'uncertain'))
BEGIN
  SELECT RAISE(ABORT, 'a thread request is written once and its answer only moves forward');
END
`;
const CATALOG_OBJECTS = Object.freeze([["table", "thread_request"], ["index", "thread_request_ref"], ["index", "thread_request_open"], ["trigger", "thread_request_moves"]] as const);
const squash = (sql: string): string => sql.replace(/\bIF NOT EXISTS\b/i, "").replace(/\s+/g, " ").replace(/;$/, "").trim();

/** The coding catalog's request side, opened by this module (`openFlexibleAnswerCatalog`). */
export type FlexibleAnswerCatalog = { readonly file: string; close: () => void };
const handles = new WeakMap<FlexibleAnswerCatalog, DatabaseSync>();
const dbOf = (catalog: FlexibleAnswerCatalog): DatabaseSync => {
  const db = handles.get(catalog);
  if (db === undefined) throw new Error("not a Flexible answer catalog");
  return db;
};

/** Open the catalog's request side in `file` (in production the coding catalog, `<database>.coding.sqlite`): the
 * table made if absent, and refused if it is there in a shape this build can't name. */
export function openFlexibleAnswerCatalog(file: string): { ok: true; catalog: FlexibleAnswerCatalog } | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof file !== "string" || file === "" || file.includes("\0")) return refuse("invalid-request");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new (sqliteRuntime().DatabaseSync)(file);
  try {
    chmodSync(file, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
    db.exec(CATALOG_SCHEMA);
    const statements = CATALOG_SCHEMA.split(/;\s*\n(?=CREATE )/).map(squash).filter(one => one !== "");
    for (const [type, name] of CATALOG_OBJECTS) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name);
      const want = statements.find(one => new RegExp(`^CREATE (?:UNIQUE )?${type.toUpperCase()} ${name}\\b`).test(one));
      if (row === undefined || want === undefined || squash(String(row["sql"])) !== want) throw new Error(`${file}: the Flexible answers ${type} ${name} has an unknown shape`);
    }
  } catch (error) { db.close(); throw error; }
  const catalog: FlexibleAnswerCatalog = { file, close: () => { handles.delete(catalog); db.close(); } };
  handles.set(catalog, db);
  return { ok: true, catalog };
}

type RequestRow = {
  id: string; thread: string; turn: string; connection: string; holder: string; owner: string; ownerGeneration: number; requestRef: string; kind: FlexibleRequestKind;
  card: string; requestDigest: string; correlation: string | null; tokenDigest: string; state: FlexibleAnswerState; decisionId: string | null; answer: string | null; payloadDigest: string | null;
};
function readRequest(row: Record<string, unknown> | undefined): RequestRow | null {
  if (row === undefined) return null;
  const text = (value: unknown) => value === null || value === undefined ? null : String(value);
  return { id: String(row["id"]), thread: String(row["thread"]), turn: String(row["turn"]), connection: String(row["connection_id"]), holder: String(row["holder"]),
    owner: String(row["owner"]), ownerGeneration: Number(row["owner_generation"]), requestRef: String(row["request_ref"]), kind: String(row["kind"]) as FlexibleRequestKind,
    card: String(row["card"]), requestDigest: String(row["request_digest"]), correlation: text(row["correlation"]), tokenDigest: String(row["token_digest"]),
    state: String(row["state"]) as FlexibleAnswerState, decisionId: text(row["decision_id"]), answer: text(row["answer"]), payloadDigest: text(row["payload_digest"]) };
}
const requestOf = (catalog: FlexibleAnswerCatalog, id: string): RequestRow | null =>
  readRequest(dbOf(catalog).prepare("SELECT * FROM thread_request WHERE id = ?").get(id) as Record<string, unknown> | undefined);

type DecisionRow = { id: number; decisionId: string; thread: string; turn: string; request: string | null; source: "person" | "policy" | "provider"; by: string; byGeneration: number | null;
  payloadDigest: string | null; connection: string; state: Exclude<FlexibleAnswerState, "pending" | "withdrawn">; writeStartedAt: string | null };
function decisionOf(store: Store, request: string): DecisionRow | null {
  const row = store.handle.prepare("SELECT * FROM thread_decision WHERE request = ?").get(request);
  if (row === undefined) return null;
  return { id: Number(row["id"]), decisionId: String(row["decision_id"]), thread: String(row["thread"]), turn: String(row["turn"]), request: row["request"] === null ? null : String(row["request"]),
    source: String(row["source"]) as DecisionRow["source"], by: String(row["by"]), byGeneration: row["by_generation"] === null ? null : Number(row["by_generation"]),
    payloadDigest: row["payload_digest"] === null ? null : String(row["payload_digest"]), connection: String(row["connection_id"]), state: String(row["state"]) as DecisionRow["state"],
    writeStartedAt: row["write_started_at"] === null ? null : String(row["write_started_at"]) };
}

// ---- small helpers --------------------------------------------------------------------------------------------------------

const ID = /^[0-9a-f]{32}$/;
const HOLDER = /^[A-Za-z0-9._:-]{1,128}$/;
const REF = /^[\x21-\x7e]{1,200}$/;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const sameDigest = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const systemClock: FlexibleClock = () => new Date();
/** Each decision a write was attempted for in this process: never cancellable again, whatever the record says. */
const attempted = new Set<string>();

function ledger(store: Store, at: string, actor: string, source: "work" | "policy", outcome: string, row: { thread: string; turn: string; decisionId: string }, detail?: string): void {
  store.recordAction({ at, actor, repo: null, taskId: null, runId: null, source, action: "flexible answer", outcome,
    detail: `thread ${row.thread} · turn ${row.turn} · decision ${row.decisionId}${detail === undefined ? "" : ` · ${detail}`}` });
}

/** Move a decision in both stores to a final state (the caller holds the main transaction). The catalog moves only from
 * the states given; the main row only if it is still open. */
function settle(store: Store, catalog: FlexibleAnswerCatalog, request: RequestRow, decision: DecisionRow | null, to: "not-sent" | "uncertain" | "delivered", at: string, detail: string, actor = "toolroll"): void {
  const from = to === "delivered" ? ["sent"] : to === "not-sent" ? ["decided", "sending"] : ["decided", "sending", "sent"];
  dbOf(catalog).prepare(`UPDATE thread_request SET state = ?, ended_at = ?, detail = ? WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})`)
    .run(to, at, detail.slice(0, 500), request.id, ...from);
  if (decision === null || !["decided", "sending", "sent"].includes(decision.state)) return;
  store.handle.prepare("UPDATE thread_decision SET state = ?, state_at = ?, detail = ? WHERE id = ?").run(to, at, detail.slice(0, 500), decision.id);
  ledger(store, at, actor, decision.source === "person" ? "work" : "policy", to, { thread: decision.thread, turn: decision.turn, decisionId: decision.decisionId }, detail);
}

/**
 * Whether an answer bound to `bound` may still go to its agent, read now (the caller holds the main transaction): the
 * thread ready, the turn still running as this holder's and the owner's, the connection still the thread's live launch
 * held by this holder; and for a person's answer, the person is the owner, still an approver with access at the very
 * generation the turn was admitted at, the project's Flexible terms still stand for them at the turn's level, and the
 * thread wasn't lowered below it. Null when it may.
 */
function standing(store: Store, bound: { thread: string; turn: string; connection: string; holder: string; owner: string; ownerGeneration: number }, person: { name: string; generation: number } | null): FlexibleAnswerRefusal | null {
  const thread = store.handle.prepare("SELECT state FROM flexible_thread WHERE id = ?").get(bound.thread);
  if (thread === undefined || thread["state"] !== "ready") return refuse("thread-changed");
  const turn = flexibleTurn(store, bound.turn);
  if (turn === null || turn.thread !== bound.thread || turn.status !== "running" || turn.holder !== bound.holder || turn.owner !== bound.owner || turn.ownerGeneration !== bound.ownerGeneration) {
    return refuse("turn-changed");
  }
  const launch = flexibleLaunch(store, bound.connection);
  if (launch === null || launch.thread !== bound.thread || launch.state !== "live" || launch.holder !== bound.holder) return refuse("connection-changed");
  if (person === null) return null;
  if (person.name !== bound.owner) return refuse("not-owner");
  const account = store.accountOf(bound.owner);
  if (account === null || account.revokedAt !== null) return refuse("authority-changed");
  if (account.generation !== bound.ownerGeneration || person.generation !== bound.ownerGeneration) return refuse("stale-generation");
  const delegation = flexibleDelegationAtUse(store, { repo: turn.repo, starter: { name: turn.owner, generation: turn.ownerGeneration }, digest: turn.termsDigest, level: turn.level, freshProof: true });
  if (!delegation.ok || delegation.termsId !== turn.termsId) return refuse("authority-changed");
  const chosen = store.handle.prepare("SELECT level FROM flexible_thread_level WHERE thread = ?").get(bound.thread);
  if (chosen !== undefined && isFlexibleLevel(chosen["level"]) && FLEXIBLE_LEVELS.indexOf(turn.level) > FLEXIBLE_LEVELS.indexOf(chosen["level"])) return refuse("authority-changed");
  return null;
}
const boundOf = (row: RequestRow) => ({ thread: row.thread, turn: row.turn, connection: row.connection, holder: row.holder, owner: row.owner, ownerGeneration: row.ownerGeneration });

// ---- the card --------------------------------------------------------------------------------------------------------------

export type FlexibleRequestCard = { title: string; detail?: string; questions?: { id: string; question: string; options?: { label: string }[] }[] };
function cardProblem(kind: unknown, card: unknown): string | null {
  if (kind !== "permission" && kind !== "question") return "kind";
  if (typeof card !== "object" || card === null || Array.isArray(card)) return "card";
  const c = card as Record<string, unknown>;
  if (typeof c["title"] !== "string" || c["title"].length < 1 || c["title"].length > 200) return "title";
  if (c["detail"] !== undefined && (typeof c["detail"] !== "string" || c["detail"].length > 32_000)) return "detail";
  const questions = c["questions"];
  if (kind === "question" && (!Array.isArray(questions) || questions.length < 1)) return "questions";
  if (questions !== undefined) {
    if (!Array.isArray(questions) || questions.length > 20) return "questions";
    const ids = new Set<string>();
    for (const one of questions as unknown[]) {
      const q = one as Record<string, unknown>;
      if (typeof one !== "object" || one === null || typeof q["id"] !== "string" || !/^[\x21-\x7e]{1,100}$/.test(q["id"]) || ids.has(q["id"]) || typeof q["question"] !== "string" || q["question"].length > 4000) return "questions";
      ids.add(q["id"]);
    }
  }
  return null;
}

/** The exact answer bytes for a decision on a request (null when the decision doesn't fit the request). */
function answerFor(kind: FlexibleRequestKind, card: string, decision: FlexibleDecision, answers: unknown): FlexibleAnswerPayload | null {
  if (kind === "permission") return decision === "accept" || decision === "decline" || decision === "cancel" ? { decision } : null;
  if (decision === "cancel" || decision === "decline") return { answers: {} };
  if (decision !== "answer" || typeof answers !== "object" || answers === null || Array.isArray(answers)) return null;
  const questions = (JSON.parse(card) as FlexibleRequestCard).questions ?? [];
  const given = answers as Record<string, unknown>;
  if (Object.keys(given).some(key => !questions.some(q => q.id === key))) return null;
  const result: Record<string, { answers: string[] }> = {};
  for (const q of questions) {
    const values = (given[q.id] as { answers?: unknown } | undefined)?.answers;
    if (!Array.isArray(values) || values.length < 1 || values.length > 10 || values.some(v => typeof v !== "string" || v.length > 16_000)) return null;
    result[q.id] = { answers: [...values as string[]] };
  }
  return { answers: result };
}

// ---- recording a request ---------------------------------------------------------------------------------------------------

export type FlexibleRequestInput = {
  thread: string; turn: string;
  /** The agent launch that asked (flexible_thread_launch id): the only connection its answer may go to. */
  connection: string; holder: string;
  /** The agent's own id for its request (a JSON-RPC id, a control request id), as text. */
  requestRef: string; kind: FlexibleRequestKind; card: FlexibleRequestCard;
  /** What later tool activity of exactly this request would carry (a tool-use id), if the agent has one. */
  correlation?: string | null; clock?: FlexibleClock;
};

/**
 * Record a request the thread's agent made, while its turn runs on that very launch (checked in the same main
 * transaction the catalog row is written in). Who may answer comes from the turn's record, never the caller. Returns
 * the request's id, its card digest and its single-use answer token (only its digest is kept).
 */
export function recordFlexibleRequest(store: Store, catalog: FlexibleAnswerCatalog, input: FlexibleRequestInput):
  { ok: true; request: string; token: string; requestDigest: string } | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (![input.thread, input.turn, input.connection].every(id => typeof id === "string" && ID.test(id)) || typeof input.holder !== "string" || !HOLDER.test(input.holder)
    || typeof input.requestRef !== "string" || !REF.test(input.requestRef) || cardProblem(input.kind, input.card) !== null
    || (input.correlation != null && (typeof input.correlation !== "string" || !REF.test(input.correlation)))) return refuse("invalid-request");
  const card = JSON.stringify(input.card);
  if (card.length > 65_536) return refuse("invalid-request");
  return store.transact(() => {
    const at = (input.clock ?? systemClock)().toISOString();
    const turn = flexibleTurn(store, input.turn);
    if (turn === null) return refuse("turn-changed");
    const problem = standing(store, { thread: input.thread, turn: input.turn, connection: input.connection, holder: input.holder, owner: turn.owner, ownerGeneration: turn.ownerGeneration }, null);
    if (problem !== null) return problem;
    const id = randomBytes(16).toString("hex"), token = randomBytes(32).toString("hex"), requestDigest = sha256(card);
    dbOf(catalog).prepare(`INSERT INTO thread_request (id, thread, turn, connection_id, holder, owner, owner_generation, request_ref, kind, card, request_digest, correlation, token_digest, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(id, input.thread, input.turn, input.connection, input.holder, turn.owner, turn.ownerGeneration,
      input.requestRef, input.kind, card, requestDigest, input.correlation ?? null, sha256(token), at);
    return { ok: true as const, request: id, token, requestDigest };
  });
}

// ---- deciding ----------------------------------------------------------------------------------------------------------------

type Decided = { ok: true; decisionId: string; state: "decided" };

/** Record a decision: the main database first (thread_decision + the ledger's intent, in the transaction that checked
 * standing), then the catalog row pending → decided by compare-and-swap. If the catalog moved meanwhile, the decision is
 * not-sent at once. */
function decide(store: Store, catalog: FlexibleAnswerCatalog, input: { request: string; clock?: FlexibleClock }, who: { source: "person"; name: string; generation: number; token: string; shownDigest: string } | { source: "policy"; rule: FlexibleAnswerRule },
  decision: FlexibleDecision, answers: unknown): Decided | FlexibleAnswerRefusal {
  const clock = input.clock ?? systemClock;
  const made = store.transact((): FlexibleAnswerRefusal | { decisionId: string; answer: string; payloadDigest: string; tokenDigest: string; at: string; row: RequestRow } => {
    const at = clock().toISOString();
    const row = requestOf(catalog, input.request);
    if (row === null) return refuse("request-unknown");
    if (who.source === "person" && !sameDigest(sha256(who.token), row.tokenDigest)) return refuse("token-mismatch");
    if (row.state !== "pending" || decisionOf(store, row.id) !== null) return refuse("already-answered", row.state);
    if (who.source === "person" && who.shownDigest !== row.requestDigest) return refuse("card-changed");
    const problem = standing(store, boundOf(row), who.source === "person" ? { name: who.name, generation: who.generation } : null);
    if (problem !== null) return problem;
    const payload = answerFor(row.kind, row.card, decision, answers);
    if (payload === null) return refuse("invalid-request");
    const answer = JSON.stringify(payload), payloadDigest = sha256(answer), decisionId = randomBytes(16).toString("hex");
    const by = who.source === "person" ? who.name : "toolroll";
    store.handle.prepare(`INSERT INTO thread_decision (decision_id, thread, turn, request, request_ref, source, rule, decision, request_digest, payload_digest, connection_id, state, at, by, by_generation, state_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'decided', ?, ?, ?, ?)`).run(decisionId, row.thread, row.turn, row.id, row.requestRef, who.source, who.source === "policy" ? who.rule : null,
      decision, row.requestDigest, payloadDigest, row.connection, at, by, who.source === "person" ? who.generation : null, at);
    ledger(store, at, by, who.source === "person" ? "work" : "policy", "intended", { thread: row.thread, turn: row.turn, decisionId }, `${decision} · request ${row.id}${who.source === "policy" ? ` · rule ${who.rule}` : ""}`);
    return { decisionId, answer, payloadDigest, tokenDigest: row.tokenDigest, at, row };
  });
  if ("ok" in made) return made;
  const swapped = dbOf(catalog).prepare(`UPDATE thread_request SET state = 'decided', decision_id = ?, source = ?, decision = ?, answer = ?, payload_digest = ?, decided_by = ?, decided_at = ?
    WHERE id = ? AND state = 'pending' AND token_digest = ?`).run(made.decisionId, who.source, decision, made.answer, made.payloadDigest, who.source === "person" ? who.name : "toolroll", made.at, made.row.id, made.tokenDigest);
  if (Number(swapped.changes) !== 1) {
    store.transact(() => settle(store, catalog, made.row, decisionOf(store, made.row.id), "not-sent", clock().toISOString(), "the request moved before the answer was recorded"));
    return refuse("already-answered", "not-sent");
  }
  return { ok: true, decisionId: made.decisionId, state: "decided" };
}

/**
 * A person answers a request: the turn's owner, at the generation they proved, with the request's single-use token and
 * the digest of the card exactly as they saw it. `by.kind` must be "person": a model, a lead or an agent never decides
 * (the caller's surface proves the person; F3).
 */
export function decideFlexibleAnswer(store: Store, catalog: FlexibleAnswerCatalog, input: { request: string; token: string; shownDigest: string; by: { kind: "person"; name: string; generation: number };
  decision: FlexibleDecision; answers?: unknown; clock?: FlexibleClock }): Decided | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (input.by?.kind !== "person") return refuse("not-a-person");
  if (typeof input.request !== "string" || !ID.test(input.request) || typeof input.token !== "string" || !/^[0-9a-f]{64}$/.test(input.token)
    || typeof input.shownDigest !== "string" || typeof input.by.name !== "string" || !Number.isSafeInteger(input.by.generation)
    || !["accept", "decline", "cancel", "answer"].includes(input.decision)) return refuse("invalid-request");
  return decide(store, catalog, input, { source: "person", name: input.by.name, generation: input.by.generation, token: input.token, shownDigest: input.shownDigest }, input.decision, input.answers);
}

/** Toolroll decides a request by a recorded rule (FLEXIBLE_ANSWER_RULES): only ever a decline or a cancel. */
export function decideFlexibleAnswerByPolicy(store: Store, catalog: FlexibleAnswerCatalog, input: { request: string; rule: FlexibleAnswerRule; clock?: FlexibleClock }): Decided | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.request !== "string" || !ID.test(input.request) || !Object.hasOwn(FLEXIBLE_ANSWER_RULES, input.rule)) return refuse("invalid-request");
  return decide(store, catalog, input, { source: "policy", rule: input.rule }, FLEXIBLE_ANSWER_RULES[input.rule], undefined);
}

// ---- sending ------------------------------------------------------------------------------------------------------------------

/** The catalog row and the main row of one decision, proved to agree (same decision id, same answer bytes). */
function agreeing(store: Store, catalog: FlexibleAnswerCatalog, request: string): { row: RequestRow; decision: DecisionRow } | { row: RequestRow | null; decision: DecisionRow | null; problem: true } {
  const row = requestOf(catalog, request), decision = row === null ? null : decisionOf(store, row.id);
  if (row === null || decision === null || row.decisionId === null || row.answer === null || row.payloadDigest === null || decision.payloadDigest === null) return { row, decision, problem: true };
  const agree = row.decisionId === decision.decisionId && sameDigest(sha256(row.answer), decision.payloadDigest) && sameDigest(row.payloadDigest, decision.payloadDigest)
    && row.connection === decision.connection && row.turn === decision.turn && row.thread === decision.thread;
  return agree ? { row, decision } : { row, decision, problem: true };
}

/**
 * Send a decided answer to its agent, on `connection` (which must be the launch that asked, held by `holder`). First
 * (one transaction) the answer is queued: decided → sending in both stores. Then, when the connection is ready, the
 * final step runs in ONE main transaction: both stores re-read and proved to agree, the answer still sending and not
 * cancelled, the authority re-checked; only then is the answer written (synchronously), and sent, not-sent or
 * uncertain recorded with it. Never sends twice: a decision whose write was attempted is never written again.
 */
export async function sendFlexibleAnswer(store: Store, catalog: FlexibleAnswerCatalog, input: { request: string; connection: FlexibleAnswerConnection; holder: string; clock?: FlexibleClock }):
  Promise<{ ok: true; state: "sent"; decisionId: string } | FlexibleAnswerRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.request !== "string" || !ID.test(input.request) || typeof input.holder !== "string" || !HOLDER.test(input.holder)
    || typeof input.connection?.id !== "string" || typeof input.connection.write !== "function") return refuse("invalid-request");
  const clock = input.clock ?? systemClock;
  const connection = input.connection;
  /** Why this answer may not go now, or null (the caller holds the main transaction). */
  const blocked = (row: RequestRow, decision: DecisionRow): FlexibleAnswerRefusal | null => {
    if (connection.id !== row.connection || input.holder !== row.holder) return refuse("connection-changed");
    return standing(store, boundOf(row), decision.source === "person" ? { name: decision.by, generation: decision.byGeneration ?? -1 } : null);
  };
  // 1. Queue it.
  const queued = store.transact((): FlexibleAnswerRefusal | { decisionId: string } => {
    const at = clock().toISOString();
    const both = agreeing(store, catalog, input.request);
    if (both.row === null) return refuse("request-unknown");
    if (both.decision === null || both.row.state !== "decided" || both.decision.state !== "decided") return refuse("already-answered", both.decision?.state ?? both.row.state);
    if ("problem" in both) { settle(store, catalog, both.row, both.decision, "not-sent", at, "the two records of this answer disagree"); return refuse("stores-disagree", "not-sent"); }
    const problem = blocked(both.row, both.decision);
    if (problem !== null) { settle(store, catalog, both.row, both.decision, "not-sent", at, problem.message); return { ...problem, state: "not-sent" }; }
    // The catalog first: if it moved meanwhile, nothing changes here.
    const moved = dbOf(catalog).prepare("UPDATE thread_request SET state = 'sending' WHERE id = ? AND state = 'decided' AND decision_id = ?").run(both.row.id, both.decision.decisionId);
    if (Number(moved.changes) !== 1) return refuse("stores-disagree");
    store.handle.prepare("UPDATE thread_decision SET state = 'sending', state_at = ? WHERE id = ? AND state = 'decided'").run(at, both.decision.id);
    return { decisionId: both.decision.decisionId };
  });
  if ("ok" in queued) return queued;
  let readyFailed = false;
  try { await connection.ready?.(); } catch { readyFailed = true; }
  // 2. The final check and the write, together.
  return store.transact(() => {
    const at = clock().toISOString();
    const both = agreeing(store, catalog, input.request);
    if (both.row === null || both.decision === null) return refuse("stores-disagree");
    if (both.decision.state !== "sending" || both.decision.writeStartedAt !== null || attempted.has(both.decision.decisionId)) {
      return refuse(both.decision.state === "not-sent" ? "not-sent" : "already-answered", both.decision.state);
    }
    if ("problem" in both || both.row.state !== "sending") { settle(store, catalog, both.row, both.decision, "not-sent", at, "the two records of this answer disagree"); return refuse("stores-disagree", "not-sent"); }
    const problem = readyFailed ? refuse("connection-changed") : blocked(both.row, both.decision);
    if (problem !== null) { settle(store, catalog, both.row, both.decision, "not-sent", at, problem.message); return { ...problem, state: "not-sent" as const }; }
    const { row, decision } = both;
    attempted.add(decision.decisionId);
    store.handle.prepare("UPDATE thread_decision SET write_started_at = ? WHERE id = ? AND state = 'sending' AND write_started_at IS NULL").run(at, decision.id);
    let outcome: "sent" | "not-sent" | "uncertain";
    try { outcome = connection.write(row.requestRef, JSON.parse(row.answer!) as FlexibleAnswerPayload) === "written" ? "sent" : "not-sent"; }
    catch { outcome = "uncertain"; }
    if (outcome === "sent") {
      dbOf(catalog).prepare("UPDATE thread_request SET state = 'sent', sent_at = ? WHERE id = ? AND state = 'sending'").run(at, row.id);
      store.handle.prepare("UPDATE thread_decision SET state = 'sent', state_at = ? WHERE id = ?").run(at, decision.id);
      ledger(store, at, decision.source === "person" ? decision.by : "toolroll", decision.source === "person" ? "work" : "policy", "sent", { thread: row.thread, turn: row.turn, decisionId: decision.decisionId });
      return { ok: true as const, state: "sent" as const, decisionId: decision.decisionId };
    }
    const detail = outcome === "not-sent" ? "the agent's connection took nothing" : "the write to the agent failed partway";
    settle(store, catalog, row, { ...decision, state: "sending" }, outcome, at, detail);
    return outcome === "not-sent" ? refuse("connection-changed", "not-sent") : refuse("not-sent", "uncertain", FLEXIBLE_ANSWER_UNCERTAIN);
  });
}

// ---- cancelling and revoking ---------------------------------------------------------------------------------------------------

/** Whether an answer can still be stopped: decided, or sending with no write begun (in the record or in this process). */
const stoppable = (decision: DecisionRow | null): boolean =>
  decision !== null && (decision.state === "decided" || (decision.state === "sending" && decision.writeStartedAt === null)) && !attempted.has(decision.decisionId);

/**
 * The owner cancels their decided or sending answer (no write begun yet): it is not-sent in both stores. Once its
 * write has begun the cancel loses and says so; exactly one of a cancel and a send wins.
 */
export function cancelFlexibleAnswer(store: Store, catalog: FlexibleAnswerCatalog, input: { request: string; by: { kind: "person"; name: string; generation: number }; clock?: FlexibleClock }):
  { ok: true; state: "not-sent" } | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (input.by?.kind !== "person") return refuse("not-a-person");
  if (typeof input.request !== "string" || !ID.test(input.request) || typeof input.by.name !== "string" || !Number.isSafeInteger(input.by.generation)) return refuse("invalid-request");
  return store.transact(() => {
    const at = (input.clock ?? systemClock)().toISOString();
    const row = requestOf(catalog, input.request);
    if (row === null) return refuse("request-unknown");
    if (input.by.name !== row.owner) return refuse("not-owner");
    const account = store.accountOf(row.owner);
    if (account === null || account.revokedAt !== null || account.generation !== input.by.generation || input.by.generation !== row.ownerGeneration) return refuse("stale-generation");
    const decision = decisionOf(store, row.id);
    if (!stoppable(decision)) return refuse(decision === null ? "already-answered" : "too-late", decision?.state ?? row.state);
    settle(store, catalog, row, decision, "not-sent", at, `cancelled by ${input.by.name}`, input.by.name);
    return { ok: true as const, state: "not-sent" as const };
  });
}

/**
 * Authority over a thread's requests ended (its turn ended, its agent was stopped or lowered, the owner's access or the
 * terms changed): every pending request of the thread (or only of `turn` / `connection`) is withdrawn, and every answer
 * that can still be stopped is not-sent, in one transaction. An answer whose write has begun is left to its ack or its
 * timeout. Returns how many moved.
 */
export function revokeFlexibleAnswers(store: Store, catalog: FlexibleAnswerCatalog, input: { thread: string; turn?: string; connection?: string; reason: string; clock?: FlexibleClock }):
  { ok: true; withdrawn: number; notSent: number } | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (![input.thread, ...(input.turn === undefined ? [] : [input.turn]), ...(input.connection === undefined ? [] : [input.connection])].every(id => typeof id === "string" && ID.test(id))
    || typeof input.reason !== "string" || input.reason.length < 1 || input.reason.length > 200) return refuse("invalid-request");
  return store.transact(() => {
    const at = (input.clock ?? systemClock)().toISOString();
    let withdrawn = 0, notSent = 0;
    const rows = dbOf(catalog).prepare("SELECT * FROM thread_request WHERE thread = ? AND state IN ('pending', 'decided', 'sending')").all(input.thread)
      .map(one => readRequest(one as Record<string, unknown>)!).filter(one => (input.turn === undefined || one.turn === input.turn) && (input.connection === undefined || one.connection === input.connection));
    for (const row of rows) {
      const decision = decisionOf(store, row.id);
      if (row.state === "pending") {
        dbOf(catalog).prepare("UPDATE thread_request SET state = 'withdrawn', ended_at = ?, detail = ? WHERE id = ? AND state = 'pending'").run(at, input.reason, row.id);
        withdrawn++;
        // A decision recorded in the main database whose catalog row never moved (a crash, or this very moment): not-sent.
        if (decision !== null) settle(store, catalog, row, decision, "not-sent", at, input.reason);
      } else if (stoppable(decision)) {
        settle(store, catalog, row, decision, "not-sent", at, input.reason);
        notSent++;
      }
    }
    return { ok: true as const, withdrawn, notSent };
  });
}

// ---- acknowledgements ------------------------------------------------------------------------------------------------------------

/** The agent acknowledged a request by its own id (an exact acknowledgement, such as Codex's serverRequest/resolved):
 * a sent answer on that connection is delivered. Nothing else moves. */
export function ackFlexibleAnswer(store: Store, catalog: FlexibleAnswerCatalog, input: { connection: string; requestRef: string; clock?: FlexibleClock }):
  { ok: true; delivered: boolean } | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.connection !== "string" || !ID.test(input.connection) || typeof input.requestRef !== "string" || !REF.test(input.requestRef)) return refuse("invalid-request");
  return store.transact(() => {
    const at = (input.clock ?? systemClock)().toISOString();
    const row = readRequest(dbOf(catalog).prepare("SELECT * FROM thread_request WHERE connection_id = ? AND request_ref = ?").get(input.connection, input.requestRef) as Record<string, unknown> | undefined);
    if (row === null || row.state !== "sent") return { ok: true as const, delivered: false };
    const decision = decisionOf(store, row.id);
    if (decision === null || decision.state !== "sent" || decision.decisionId !== row.decisionId) return { ok: true as const, delivered: false };
    settle(store, catalog, row, decision, "delivered", at, "the agent acknowledged it");
    return { ok: true as const, delivered: true };
  });
}

/** Tool activity the agent reported on a connection in a turn, carrying `correlation` (a tool-use id): an ack only when
 * exactly one request of that connection and turn ever carried it (in any state), and that one was sent. Anything
 * ambiguous infers nothing. */
export function noteFlexibleToolActivity(store: Store, catalog: FlexibleAnswerCatalog, input: { connection: string; turn: string; correlation: string; clock?: FlexibleClock }):
  { ok: true; delivered: string | null; matched: number } | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (![input.connection, input.turn].every(id => typeof id === "string" && ID.test(id)) || typeof input.correlation !== "string" || !REF.test(input.correlation)) return refuse("invalid-request");
  return store.transact(() => {
    const at = (input.clock ?? systemClock)().toISOString();
    const open = dbOf(catalog).prepare("SELECT * FROM thread_request WHERE connection_id = ? AND turn = ? AND correlation = ?")
      .all(input.connection, input.turn, input.correlation).map(one => readRequest(one as Record<string, unknown>)!);
    if (open.length !== 1 || open[0]!.state !== "sent") return { ok: true as const, delivered: null, matched: open.length };
    const row = open[0]!, decision = decisionOf(store, row.id);
    if (decision === null || decision.state !== "sent" || decision.decisionId !== row.decisionId) return { ok: true as const, delivered: null, matched: 1 };
    settle(store, catalog, row, decision, "delivered", at, "the agent's next tool activity matched it");
    return { ok: true as const, delivered: row.id, matched: 1 };
  });
}

/** Sent answers that waited past FLEXIBLE_ANSWER_ACK_MS for an ack, or whose agent launch is no longer live, are
 * uncertain (the time read once, inside the transaction). */
export function expireFlexibleAnswers(store: Store, catalog: FlexibleAnswerCatalog, input: { clock?: FlexibleClock; ackMs?: number } = {}): { ok: true; uncertain: number } | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const window = input.ackMs ?? FLEXIBLE_ANSWER_ACK_MS;
  if (!Number.isSafeInteger(window) || window < 0) return refuse("invalid-request");
  return store.transact(() => {
    const now = (input.clock ?? systemClock)();
    const at = now.toISOString();
    let uncertain = 0;
    for (const raw of dbOf(catalog).prepare("SELECT * FROM thread_request WHERE state = 'sent'").all()) {
      const row = readRequest(raw as Record<string, unknown>)!;
      const sentAt = Date.parse(String((raw as Record<string, unknown>)["sent_at"]));
      const launch = flexibleLaunch(store, row.connection);
      const gone = launch === null || launch.state !== "live";
      if (!gone && Number.isFinite(sentAt) && now.getTime() - sentAt < window) continue;
      settle(store, catalog, row, decisionOf(store, row.id), "uncertain", at, gone ? "the agent stopped before it acknowledged the answer" : "the agent never acknowledged the answer");
      uncertain++;
    }
    return { ok: true as const, uncertain };
  });
}

// ---- after a restart ------------------------------------------------------------------------------------------------------------

/**
 * A holder process is gone (the caller proved it, as for flexible-agents.ts recoverFlexibleLaunchesOf): its pending
 * requests are withdrawn; its decided, sending and sent answers are uncertain (never sent again); a decision the main
 * database recorded whose catalog row never left pending is not-sent. Both stores, one transaction.
 */
export function recoverFlexibleAnswersOf(store: Store, catalog: FlexibleAnswerCatalog, input: { holder: string; clock?: FlexibleClock }):
  { ok: true; withdrawn: number; uncertain: number; notSent: number } | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.holder !== "string" || !HOLDER.test(input.holder)) return refuse("invalid-request");
  return store.transact(() => {
    const at = (input.clock ?? systemClock)().toISOString();
    let withdrawn = 0, uncertain = 0, notSent = 0;
    const rows = dbOf(catalog).prepare("SELECT * FROM thread_request WHERE holder = ? AND state IN ('pending', 'decided', 'sending', 'sent')").all(input.holder).map(one => readRequest(one as Record<string, unknown>)!);
    for (const row of rows) {
      const decision = decisionOf(store, row.id);
      if (row.state === "pending") {
        dbOf(catalog).prepare("UPDATE thread_request SET state = 'withdrawn', ended_at = ?, detail = ? WHERE id = ? AND state = 'pending'").run(at, "Toolroll restarted", row.id);
        withdrawn++;
        if (decision !== null) { settle(store, catalog, row, decision, "not-sent", at, "Toolroll restarted before the answer was recorded"); notSent++; }
      } else {
        settle(store, catalog, row, decision, "uncertain", at, "Toolroll restarted before the answer was confirmed");
        uncertain++;
      }
    }
    // Main rows still open on this holder's launches whose catalog row is gone or already final.
    const open = store.handle.prepare(`SELECT d.request FROM thread_decision d JOIN flexible_thread_launch l ON l.id = d.connection_id
      WHERE l.holder = ? AND d.state IN ('decided', 'sending', 'sent') AND d.request IS NOT NULL`).all(input.holder).map(one => String(one["request"]));
    for (const request of open) {
      const decision = decisionOf(store, request);
      if (decision === null) continue;
      const row = requestOf(catalog, request);
      const to = decision.state === "decided" && (row === null || row.state === "pending" || row.state === "withdrawn" || row.state === "not-sent") ? "not-sent" : "uncertain";
      store.handle.prepare("UPDATE thread_decision SET state = ?, state_at = ?, detail = ? WHERE id = ?").run(to, at, "Toolroll restarted", decision.id);
      ledger(store, at, "toolroll", decision.source === "person" ? "work" : "policy", to, { thread: decision.thread, turn: decision.turn, decisionId: decision.decisionId }, "Toolroll restarted");
      if (to === "not-sent") notSent++; else uncertain++;
    }
    return { ok: true as const, withdrawn, uncertain, notSent };
  });
}

// ---- the agent's own decisions ---------------------------------------------------------------------------------------------------

/** Record an allow or deny the agent made by its own rules (observed in its stream, inside the delegation): the
 * provider's, never a person's or Toolroll's approval, and nothing is sent. Only while that turn runs on that launch. */
export function recordFlexibleProviderDecision(store: Store, input: { thread: string; turn: string; connection: string; holder: string; requestRef: string; decision: "accept" | "decline"; provider: string; clock?: FlexibleClock }):
  { ok: true; decisionId: string } | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (![input.thread, input.turn, input.connection].every(id => typeof id === "string" && ID.test(id)) || typeof input.holder !== "string" || !HOLDER.test(input.holder)
    || typeof input.requestRef !== "string" || !REF.test(input.requestRef) || (input.decision !== "accept" && input.decision !== "decline")
    || typeof input.provider !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(input.provider)) return refuse("invalid-request");
  return store.transact(() => {
    const at = (input.clock ?? systemClock)().toISOString();
    const turn = flexibleTurn(store, input.turn);
    if (turn === null) return refuse("turn-changed");
    const problem = standing(store, { thread: input.thread, turn: input.turn, connection: input.connection, holder: input.holder, owner: turn.owner, ownerGeneration: turn.ownerGeneration }, null);
    if (problem !== null) return problem;
    const decisionId = randomBytes(16).toString("hex");
    store.handle.prepare(`INSERT INTO thread_decision (decision_id, thread, turn, request, request_ref, source, decision, connection_id, state, at, by, state_at, detail)
      VALUES (?, ?, ?, NULL, ?, 'provider', ?, ?, 'delivered', ?, ?, ?, 'decided by the agent''s own rules')`).run(decisionId, input.thread, input.turn, input.requestRef, input.decision, input.connection, at, `provider:${input.provider}`, at);
    return { ok: true as const, decisionId };
  });
}
