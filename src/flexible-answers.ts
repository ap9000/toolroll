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
 * - Recording a request, a person's decision and a send check the interactive agent threads' switch
 *   (flexible-available.ts flexibleAvailable: off unless a person turned them on) first; revoking, expiring,
 *   cancelling, acknowledging and recovering never do. No route, CLI command, MCP tool or chat action reaches it but
 *   the thread view (F3).
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
 * - The final authority check is serialised with the write, and no I/O runs inside a database transaction. One main
 *   write transaction (no other writer, in this process or another, can change authority inside it) re-reads the
 *   person's standing, the project's Flexible terms, the thread, the turn (still running, still the owner's, still this
 *   holder's), the connection (still the thread's live launch, the very object asked) and the generation, and then
 *   commits a write attempt (its id and time) in both stores, the catalog first, the main database second. Only after
 *   that commit do any bytes leave, through a bounded, non-blocking send with a deadline, outside every transaction;
 *   its outcome is recorded in a new transaction. Anything changed before the attempt: nothing is sent.
 * - Cancellation (the owner's, or a revocation) wins over a decided answer, and over a sending one with no attempt in
 *   either store; once an attempt is committed in either store it loses and says so. Exactly one of a cancel and a send
 *   wins. An answer with an attempt is never not-sent (both stores refuse it): only sent, delivered or uncertain.
 * - A partial or late send is uncertain, never retried. An attempt that was interrupted (a crash, a failed record, the
 *   two stores split) is uncertain: on restart (recoverFlexibleAnswersOf) or once its send's deadline has passed
 *   (expireFlexibleAnswers). Sent without an ack becomes uncertain (FLEXIBLE_ANSWER_ACK_MS, or at once when its agent
 *   launch is gone). Later tool activity is an ack only when it correlates with exactly one request on that connection
 *   and turn.
 * - Uncertain is final: nothing is ever sent again automatically. A crash while decided, sending or sent recovers to
 *   uncertain, never to a resend; a pending request is withdrawn.
 * - The catalog is always `<database>.coding.sqlite` beside the store's own file (never a caller's path), inside a
 *   folder boundary only this user outside the fence can change (openFlexibleAnswerCatalog): no link anywhere along it,
 *   a regular file of this user's made 0600 without following links, outside the threads' folder.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsConstants, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Writable } from "node:stream";
import { flexibleAvailable } from "./flexible-available.js";
import { flexibleDelegationAtUse, FLEXIBLE_LEVELS, FLEXIBLE_UNAVAILABLE, isFlexibleLevel } from "./flexible.js";
import { flexibleLaunch } from "./flexible-launch.js";
import { flexibleTurn, type FlexibleClock } from "./flexible-turns.js";
import { sqliteRuntime } from "./sqlite-runtime.js";
import { platformAcl, type AclVerdict } from "./trusted-path.js";
import type { Store } from "./store.js";

export type FlexibleAnswerState = "pending" | "decided" | "sending" | "sent" | "delivered" | "not-sent" | "uncertain" | "withdrawn";
export type FlexibleRequestKind = "permission" | "question";
export type FlexibleDecision = "accept" | "decline" | "cancel" | "answer";
/** How long a sent answer waits for its agent's acknowledgement before it is uncertain. */
export const FLEXIBLE_ANSWER_ACK_MS = 120_000;
/** The default deadline for handing an answer's bytes to its agent (a send never waits longer). */
export const FLEXIBLE_ANSWER_WRITE_MS = 10_000;
/** The most bytes one answer may be on the wire. */
const MAX_ANSWER_BYTES = 1_048_576;
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
  | "not-owner" | "stale-generation" | "authority-changed" | "thread-changed" | "turn-changed" | "connection-changed" | "stores-disagree" | "too-late" | "not-sent" | "uncertain" | "catalog-unsafe"
  | "scope-unshown";
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
  "uncertain": "We couldn't confirm the agent got your answer. Check its activity. If it asks again, you'll get a new card.",
  "catalog-unsafe": "Toolroll's record of agents' requests isn't where, or what, Toolroll made it, so it wasn't opened.",
  "scope-unshown": "This request couldn't be shown in full, so it can't be allowed. You can deny it. Nothing was sent.",
});
const refuse = (reason: FlexibleAnswerReason, state?: FlexibleAnswerState, message: string = WORDS[reason]): FlexibleAnswerRefusal =>
  state === undefined ? { ok: false, reason, message } : { ok: false, reason, message, state };
/** What a person sees for an answer whose delivery couldn't be confirmed (plan §6.3). */
export const FLEXIBLE_ANSWER_UNCERTAIN = WORDS["uncertain"];

/** What a bounded send reports: how many bytes were handed over (null: unknown) and whether all of them were. */
export type FlexibleSendResult = { written: number | null; complete: boolean };
/**
 * The connection an answer goes to: the agent launch (its id is the launch's) as the holder process holds it.
 * - `frame` turns an answer into this agent's exact bytes (pure: no I/O; it runs inside the attempt's transaction).
 * - `send` hands those bytes over, non-blocking and bounded: it must settle by `deadlineMs` (or when `signal` aborts),
 *   saying how many bytes left and whether all did. It is called at most once per answer and never retried; anything
 *   short of complete is uncertain. (Toolroll also stops waiting at the deadline itself.)
 * - `ready` waits until the connection can take an answer (backpressure); the answer stays cancellable meanwhile.
 */
export type FlexibleAnswerConnection = {
  id: string;
  frame: (requestRef: string, answer: FlexibleAnswerPayload) => Uint8Array;
  send: (bytes: Uint8Array, limits: { deadlineMs: number; signal: AbortSignal }) => Promise<FlexibleSendResult>;
  ready?: () => Promise<void>;
};

/** A bounded `send` over a Node stream (an agent's stdin): one write, settled by its callback (all bytes flushed to the
 * stream's handle) or by the deadline, whichever is first. A stream that isn't writable takes nothing. Bytes still
 * queued at the deadline may yet go out: that answer is uncertain. */
export function streamAnswerSender(stream: Writable): FlexibleAnswerConnection["send"] | FlexibleAnswerRefusal {
  return (bytes, { deadlineMs, signal }) => new Promise<FlexibleSendResult>(resolve => {
    if (stream.destroyed || !stream.writable || signal.aborted) { resolve({ written: 0, complete: false }); return; }
    let settled = false;
    const finish = (result: FlexibleSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ written: null, complete: false });
    const timer = setTimeout(onAbort, deadlineMs);
    signal.addEventListener("abort", onAbort, { once: true });
    try { stream.write(bytes, error => finish(error == null ? { written: bytes.length, complete: true } : { written: null, complete: false })); }
    catch { finish({ written: null, complete: false }); }
  });
}
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
  attempt_id       TEXT CHECK (attempt_id IS NULL OR (length(attempt_id) = 32 AND attempt_id NOT GLOB '*[^0-9a-f]*')),
  write_started_at TEXT,
  sent_at          TEXT,
  ended_at         TEXT,
  detail           TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  CHECK ((attempt_id IS NULL) = (write_started_at IS NULL)),
  CHECK (attempt_id IS NULL OR state IN ('sending', 'sent', 'delivered', 'uncertain')),
  CHECK ((decision_id IS NULL) = (source IS NULL) AND (decision_id IS NULL) = (decision IS NULL) AND (decision_id IS NULL) = (answer IS NULL)
    AND (decision_id IS NULL) = (payload_digest IS NULL) AND (decision_id IS NULL) = (decided_by IS NULL) AND (decision_id IS NULL) = (decided_at IS NULL)),
  CHECK (state <> 'pending' OR decision_id IS NULL),
  CHECK (state IN ('pending', 'withdrawn') OR decision_id IS NOT NULL),
  CHECK ((ended_at IS NULL) = (state IN ('pending', 'decided', 'sending', 'sent'))),
  CHECK (sent_at IS NULL OR state IN ('sent', 'delivered', 'uncertain')),
  CHECK (state NOT IN ('sent', 'delivered') OR sent_at IS NOT NULL),
  CHECK (state NOT IN ('sent', 'delivered') OR attempt_id IS NOT NULL)
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
  OR (OLD.attempt_id IS NOT NULL AND (NEW.attempt_id IS NOT OLD.attempt_id OR NEW.write_started_at IS NOT OLD.write_started_at))
  OR (OLD.attempt_id IS NULL AND NEW.attempt_id IS NOT NULL AND (OLD.state <> 'sending' OR NEW.state <> 'sending'))
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

/**
 * Why `folder` (a real path) isn't a boundary only this user can change, or null: the folder itself is this user's own
 * (not root's, not another's), not group- or world-writable, and on macOS has no ACL entry allowing anyone a change
 * (trusted-path.ts platformAcl, as trustedBinary checks a binary's folders); every folder above it is this user's or root's
 * and not group- or world-writable unless sticky (/tmp). Unreadable refuses.
 */
function folderBoundaryProblem(folder: string, acl: ((path: string) => AclVerdict) | null = platformAcl()): string | null {
  const uid = process.getuid?.();
  if (uid === undefined) return "who owns its folder can't be checked on this system";
  try {
    const held = lstatSync(folder);
    if (!held.isDirectory() || held.isSymbolicLink()) return "its folder isn't a folder";
    if (held.uid !== uid) return "its folder is owned by another user";
    if ((held.mode & 0o022) !== 0) return "others can change its folder (group- or world-writable)";
    const verdict = acl?.(folder);
    if (verdict !== undefined && !verdict.ok) return `its folder's ACL ${verdict.why}`;
    for (let last = folder, up = dirname(folder); up !== last; last = up, up = dirname(up)) {
      const dir = lstatSync(up);
      if (!dir.isDirectory()) return `${up} isn't a folder`;
      if (dir.uid !== uid && dir.uid !== 0) return `${up} is owned by another user`;
      if ((dir.mode & 0o022) !== 0 && (dir.mode & 0o1000) === 0) return `others can change ${up} (group- or world-writable)`;
      // Every folder above gets the same ACL check as the catalog's own folder (as trustedBinary does): an allow-write
      // entry anywhere up the path would let someone else swap what lies below it.
      const above = acl?.(up);
      if (above !== undefined && !above.ok) return `the ACL of ${up} ${above.why}`;
    }
  } catch { return "its folder can't be checked"; }
  return null;
}

/** Why `path` isn't a regular file of this user's that is itself (no link, one name), or null; absent is fine. */
function fileProblem(path: string): string | null {
  let held;
  try { held = lstatSync(path); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "it can't be read"; }
  if (held.isSymbolicLink()) return "it is a link";
  if (!held.isFile()) return "it isn't a file";
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "it isn't this user's";
  if (held.nlink !== 1) return "it has another name";
  return null;
}

/**
 * Open the catalog's request side: always `<database>.coding.sqlite` beside the store's own file, never a path a caller
 * chose. Refused (`catalog-unsafe`) when the store has no file; when its folder isn't the store's own state folder by
 * real path (no link on the way: the store's file's real folder, and the folder's real path, are the folder itself);
 * when that folder isn't a boundary only this user can change (folderBoundaryProblem: this user's, not group- or
 * world-writable, no allow-write ACL); when it is inside a thread's folder (agent-writable); or when the catalog or its
 * journal files (-wal, -shm, -journal) are anything but this user's own regular files with one name, before SQLite
 * opens it and again after. A missing catalog is made 0600 with O_EXCL and O_NOFOLLOW.
 *
 * The residual, stated: node:sqlite opens by name and can't report the descriptor it opened, so the identity check
 * (device and inode, before and after the open) reads the path, not SQLite's handle. Inside the boundary above, only
 * this same user, outside every thread's fence (the fence denies the state folder but the thread's own subfolder), can
 * swap an entry between those checks and the open: an attacker who can do that already owns Toolroll's state.
 */
export function openFlexibleAnswerCatalog(store: Store): { ok: true; catalog: FlexibleAnswerCatalog } | FlexibleAnswerRefusal {
  const database = store.databaseFile();
  if (database === null || !isAbsolute(database)) return refuse("catalog-unsafe");
  const folder = dirname(database), file = join(folder, `${basename(database)}.coding.sqlite`);
  const unsafe = (why: string) => refuse("catalog-unsafe", undefined, `${WORDS["catalog-unsafe"]} (${why})`);
  let real: string;
  try { real = realpathSync(folder); } catch { return unsafe("its folder can't be read"); }
  if (real !== folder) return unsafe("its folder is reached through a link");
  try { if (dirname(realpathSync(database)) !== folder) return unsafe("it isn't in the store's own state folder"); } catch { return unsafe("the store's file can't be read"); }
  if (/(^|\/)threads\/[0-9a-f]{32}(\/|$)/.test(folder)) return unsafe("it is inside a thread's folder");
  const boundary = folderBoundaryProblem(folder);
  if (boundary !== null) return unsafe(boundary);
  const threads = join(folder, "threads");
  const fromThreads = relative(threads, file);
  if (fromThreads === "" || (!fromThreads.startsWith("..") && !isAbsolute(fromThreads))) return unsafe("it is inside the threads' folder");
  for (const one of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    const problem = fileProblem(one);
    if (problem !== null) return unsafe(`${basename(one)}: ${problem}`);
  }
  try { closeSync(openSync(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return unsafe("it couldn't be made"); }
  const before = lstatSync(file);
  if (fileProblem(file) !== null || (before.mode & 0o077) !== 0) return unsafe("it isn't a private file of this user's");
  const db = new (sqliteRuntime().DatabaseSync)(file);
  try {
    const after = lstatSync(file);
    if (after.ino !== before.ino || after.dev !== before.dev || fileProblem(file) !== null) { db.close(); return unsafe("it changed while it was opened"); }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
    // The journal files SQLite has now opened or made: still this user's own regular files with one name.
    for (const one of [`${file}-wal`, `${file}-shm`, `${file}-journal`]) {
      const problem = fileProblem(one);
      if (problem !== null) { db.close(); return unsafe(`${basename(one)}: ${problem}`); }
    }
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
  attemptId: string | null; writeStartedAt: string | null; sentAt: string | null;
};
function readRequest(row: Record<string, unknown> | undefined): RequestRow | null {
  if (row === undefined) return null;
  const text = (value: unknown) => value === null || value === undefined ? null : String(value);
  return { id: String(row["id"]), thread: String(row["thread"]), turn: String(row["turn"]), connection: String(row["connection_id"]), holder: String(row["holder"]),
    owner: String(row["owner"]), ownerGeneration: Number(row["owner_generation"]), requestRef: String(row["request_ref"]), kind: String(row["kind"]) as FlexibleRequestKind,
    card: String(row["card"]), requestDigest: String(row["request_digest"]), correlation: text(row["correlation"]), tokenDigest: String(row["token_digest"]),
    state: String(row["state"]) as FlexibleAnswerState, decisionId: text(row["decision_id"]), answer: text(row["answer"]), payloadDigest: text(row["payload_digest"]),
    attemptId: text(row["attempt_id"]), writeStartedAt: text(row["write_started_at"]), sentAt: text(row["sent_at"]) };
}
const requestOf = (catalog: FlexibleAnswerCatalog, id: string): RequestRow | null =>
  readRequest(dbOf(catalog).prepare("SELECT * FROM thread_request WHERE id = ?").get(id) as Record<string, unknown> | undefined);

type DecisionRow = { id: number; decisionId: string; thread: string; turn: string; request: string | null; source: "person" | "policy" | "provider"; by: string; byGeneration: number | null;
  payloadDigest: string | null; connection: string; state: Exclude<FlexibleAnswerState, "pending" | "withdrawn">; writeStartedAt: string | null; attemptId: string | null; stateAt: string };
function decisionOf(store: Store, request: string): DecisionRow | null {
  const row = store.handle.prepare("SELECT * FROM thread_decision WHERE request = ?").get(request);
  if (row === undefined) return null;
  return { id: Number(row["id"]), decisionId: String(row["decision_id"]), thread: String(row["thread"]), turn: String(row["turn"]), request: row["request"] === null ? null : String(row["request"]),
    source: String(row["source"]) as DecisionRow["source"], by: String(row["by"]), byGeneration: row["by_generation"] === null ? null : Number(row["by_generation"]),
    payloadDigest: row["payload_digest"] === null ? null : String(row["payload_digest"]), connection: String(row["connection_id"]), state: String(row["state"]) as DecisionRow["state"],
    writeStartedAt: row["write_started_at"] === null ? null : String(row["write_started_at"]), attemptId: row["attempt_id"] === null ? null : String(row["attempt_id"]), stateAt: String(row["state_at"]) };
}

// ---- small helpers --------------------------------------------------------------------------------------------------------

const ID = /^[0-9a-f]{32}$/;
const HOLDER = /^[A-Za-z0-9._:-]{1,128}$/;
const REF = /^[\x21-\x7e]{1,200}$/;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const sameDigest = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const systemClock: FlexibleClock = () => new Date();
/** The states an answer can still move from. */
const OPEN: ReadonlySet<FlexibleAnswerState> = new Set(["pending", "decided", "sending", "sent"]);
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
  // An answer with an attempt is never not-sent (both stores refuse it too).
  const unattempted = to === "not-sent" ? " AND attempt_id IS NULL" : "";
  dbOf(catalog).prepare(`UPDATE thread_request SET state = ?, ended_at = ?, detail = ? WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})${unattempted}`)
    .run(to, at, detail.slice(0, 500), request.id, ...from);
  if (decision === null || !["decided", "sending", "sent"].includes(decision.state) || (to === "not-sent" && decision.attemptId !== null)) return;
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

/** Question ids that name an object's own machinery: never a question's id, never a key of an answer. */
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
/** A request's card: what the person is shown and answers. `tool` and `input` (the SHA-256 of the agent's COMPLETE
 * request, canonical JSON) bind the card to exactly what an allow would allow; `complete` false says the card couldn't
 * show all of it (too long, a secret-shaped line, characters a terminal can't show), and then it can't be accepted. */
export type FlexibleRequestCard = { title: string; detail?: string; tool?: string; input?: string; complete?: boolean;
  questions?: { id: string; question: string; options?: { label: string }[] }[] };
function cardProblem(kind: unknown, card: unknown): string | null {
  if (kind !== "permission" && kind !== "question") return "kind";
  if (typeof card !== "object" || card === null || Array.isArray(card)) return "card";
  const c = card as Record<string, unknown>;
  if (typeof c["title"] !== "string" || c["title"].length < 1 || c["title"].length > 200) return "title";
  if (c["detail"] !== undefined && (typeof c["detail"] !== "string" || c["detail"].length > 32_000)) return "detail";
  if (c["tool"] !== undefined && (typeof c["tool"] !== "string" || !/^[\x21-\x7e]{1,100}$/.test(c["tool"]))) return "tool";
  if (c["input"] !== undefined && (typeof c["input"] !== "string" || !/^[0-9a-f]{64}$/.test(c["input"]))) return "input";
  if (c["complete"] !== undefined && typeof c["complete"] !== "boolean") return "complete";
  // A permission is bound to the tool and the digest of its whole input: a card without them isn't one.
  if (kind === "permission" && (c["tool"] === undefined || c["input"] === undefined)) return "scope";
  const questions = c["questions"];
  if (kind === "question" && (!Array.isArray(questions) || questions.length < 1)) return "questions";
  if (questions !== undefined) {
    if (!Array.isArray(questions) || questions.length > 20) return "questions";
    const ids = new Set<string>();
    for (const one of questions as unknown[]) {
      const q = one as Record<string, unknown>;
      if (typeof one !== "object" || one === null || typeof q["id"] !== "string" || !/^[\x21-\x7e]{1,100}$/.test(q["id"]) || RESERVED_IDS.has(q["id"]) || ids.has(q["id"]) || typeof q["question"] !== "string" || q["question"].length > 4000) return "questions";
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
  const prototype = Object.getPrototypeOf(answers);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const questions = (JSON.parse(card) as FlexibleRequestCard).questions ?? [];
  const given = answers as Record<string, unknown>;
  // Only the input's own keys, each one of the card's questions; reserved names never.
  if (Object.keys(given).some(key => RESERVED_IDS.has(key) || !questions.some(q => q.id === key))) return null;
  const entries: [string, { answers: string[] }][] = [];
  for (const q of questions) {
    if (RESERVED_IDS.has(q.id) || !Object.hasOwn(given, q.id)) return null;
    const entry = given[q.id];
    if (typeof entry !== "object" || entry === null || !Object.hasOwn(entry, "answers")) return null;
    const values = (entry as { answers: unknown }).answers;
    if (!Array.isArray(values) || values.length < 1 || values.length > 10 || values.some(v => typeof v !== "string" || v.length > 16_000)) return null;
    entries.push([q.id, { answers: [...values as string[]] }]);
  }
  return { answers: Object.fromEntries(entries) };
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
  if (!flexibleAvailable(store)) return refuse("not-available");
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
function decide(store: Store, catalog: FlexibleAnswerCatalog, input: { request: string; clock?: FlexibleClock }, who: { source: "person"; name: string; generation: number; token: string; shownDigest: string; held?: () => boolean } | { source: "policy"; rule: FlexibleAnswerRule },
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
    // The person's own session, still held now (its saved authority, read in this transaction).
    if (who.source === "person" && who.held !== undefined) {
      let held = false;
      try { held = who.held() === true; } catch { held = false; }
      if (!held) return refuse("authority-changed");
    }
    // An allow covers the agent's whole request: only one whose card says it showed all of it (a card without the
    // flag fails closed).
    if (decision === "accept" && row.kind === "permission" && (JSON.parse(row.card) as FlexibleRequestCard).complete !== true) return refuse("scope-unshown");
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
  decision: FlexibleDecision; answers?: unknown; clock?: FlexibleClock;
  /** The person's own session (the surface that proved them), re-read inside the decision's transaction: false refuses. */
  held?: () => boolean }): Decided | FlexibleAnswerRefusal {
  if (!flexibleAvailable(store)) return refuse("not-available");
  if (input.by?.kind !== "person") return refuse("not-a-person");
  if (typeof input.request !== "string" || !ID.test(input.request) || typeof input.token !== "string" || !/^[0-9a-f]{64}$/.test(input.token)
    || typeof input.shownDigest !== "string" || typeof input.by.name !== "string" || !Number.isSafeInteger(input.by.generation)
    || !["accept", "decline", "cancel", "answer"].includes(input.decision) || (input.held !== undefined && typeof input.held !== "function")) return refuse("invalid-request");
  return decide(store, catalog, input, { source: "person", name: input.by.name, generation: input.by.generation, token: input.token, shownDigest: input.shownDigest,
    ...(input.held === undefined ? {} : { held: input.held }) }, input.decision, input.answers);
}

/** Toolroll decides a request by a recorded rule (FLEXIBLE_ANSWER_RULES): only ever a decline or a cancel. */
export function decideFlexibleAnswerByPolicy(store: Store, catalog: FlexibleAnswerCatalog, input: { request: string; rule: FlexibleAnswerRule; clock?: FlexibleClock }): Decided | FlexibleAnswerRefusal {
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
 * Send a decided answer to its agent, on `connection` (which must be the launch that asked, held by `holder`):
 * 1. Queued (one transaction): decided → sending in both stores. Still cancellable while the connection gets ready.
 * 2. The attempt (one main write transaction): both stores re-read and proved to agree, the answer still sending with
 *    no attempt and not cancelled, the authority re-checked, the answer framed (pure); then the attempt (its id and
 *    time) is committed in the coding catalog first and in the main database second. From here a cancel loses, and the
 *    answer can only end sent or uncertain.
 * 3. The bytes, outside every transaction: one bounded, non-blocking send that settles by `writeMs`. Never retried.
 * 4. The outcome (a new transaction): sent only when every byte was handed over; anything else (partial, late, an
 *    error) is uncertain. A failure to record leaves the attempt for the reconcilers, which make it uncertain.
 */
export async function sendFlexibleAnswer(store: Store, catalog: FlexibleAnswerCatalog, input: { request: string; connection: FlexibleAnswerConnection; holder: string; clock?: FlexibleClock; writeMs?: number;
  /** The deciding person's own session, re-read inside the queue's and the final attempt's transactions: false, and the
   * answer is not-sent (bound to the decision by its caller, which decides and sends with the same session). */
  held?: () => boolean }):
  Promise<{ ok: true; state: "sent"; decisionId: string } | FlexibleAnswerRefusal> {
  if (!flexibleAvailable(store)) return refuse("not-available");
  if (typeof input.request !== "string" || !ID.test(input.request) || typeof input.holder !== "string" || !HOLDER.test(input.holder)
    || typeof input.connection?.id !== "string" || typeof input.connection.frame !== "function" || typeof input.connection.send !== "function"
    || (input.writeMs !== undefined && (!Number.isSafeInteger(input.writeMs) || input.writeMs < 1 || input.writeMs > 60_000))
    || (input.held !== undefined && typeof input.held !== "function")) return refuse("invalid-request");
  const clock = input.clock ?? systemClock;
  const connection = input.connection;
  const writeMs = input.writeMs ?? FLEXIBLE_ANSWER_WRITE_MS;
  /** Why this answer may not go now, or null (the caller holds the main transaction). */
  const blocked = (row: RequestRow, decision: DecisionRow): FlexibleAnswerRefusal | null => {
    if (connection.id !== row.connection || input.holder !== row.holder) return refuse("connection-changed");
    const problem = standing(store, boundOf(row), decision.source === "person" ? { name: decision.by, generation: decision.byGeneration ?? -1 } : null);
    if (problem !== null) return problem;
    let held = true;
    try { held = input.held === undefined || input.held() === true; } catch { held = false; }
    return held ? null : refuse("authority-changed");
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
  // 2. The final check and the attempt, committed (catalog first, then here) before any byte leaves.
  let attempt: FlexibleAnswerRefusal | { attempt: { attemptId: string; bytes: Uint8Array; requestId: string } };
  try {
    attempt = store.transact((): typeof attempt => {
      const at = clock().toISOString();
      const both = agreeing(store, catalog, input.request);
      if (both.row === null || both.decision === null) return refuse("stores-disagree");
      if (both.decision.state !== "sending" || both.decision.attemptId !== null || both.row.attemptId !== null || attempted.has(both.decision.decisionId)) {
        return refuse(both.decision.state === "not-sent" ? "not-sent" : "already-answered", both.decision.state);
      }
      if ("problem" in both || both.row.state !== "sending") { settle(store, catalog, both.row, both.decision, "not-sent", at, "the two records of this answer disagree"); return refuse("stores-disagree", "not-sent"); }
      const problem = readyFailed ? refuse("connection-changed") : blocked(both.row, both.decision);
      if (problem !== null) { settle(store, catalog, both.row, both.decision, "not-sent", at, problem.message); return { ...problem, state: "not-sent" as const }; }
      const { row, decision } = both;
      let bytes: unknown;
      try { bytes = connection.frame(row.requestRef, JSON.parse(row.answer!) as FlexibleAnswerPayload); } catch { bytes = null; }
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_ANSWER_BYTES) {
        settle(store, catalog, row, decision, "not-sent", at, "the answer couldn't be put in the agent's form");
        return refuse("not-sent", "not-sent");
      }
      const attemptId = randomBytes(16).toString("hex");
      const marked = dbOf(catalog).prepare("UPDATE thread_request SET attempt_id = ?, write_started_at = ? WHERE id = ? AND state = 'sending' AND attempt_id IS NULL AND decision_id = ?")
        .run(attemptId, at, row.id, decision.decisionId);
      if (Number(marked.changes) !== 1) return refuse("stores-disagree");
      // The catalog holds the attempt from here: whatever happens next in this process, it is never cancelled or retried.
      attempted.add(decision.decisionId);
      store.handle.prepare("UPDATE thread_decision SET attempt_id = ?, write_started_at = ? WHERE id = ? AND state = 'sending' AND attempt_id IS NULL").run(attemptId, at, decision.id);
      ledger(store, at, decision.source === "person" ? decision.by : "toolroll", decision.source === "person" ? "work" : "policy", "attempt", { thread: row.thread, turn: row.turn, decisionId: decision.decisionId },
        `attempt ${attemptId} · marked in the coding catalog first, then here`);
      return { attempt: { attemptId, bytes, requestId: row.id } };
    });
  } catch {
    // The attempt may be in the catalog and not here (the stores split): nothing was sent, and it is uncertain.
    markUncertain(store, catalog, input.request, clock, "the answer's attempt couldn't be recorded in both stores");
    return refuse("uncertain", "uncertain");
  }
  if (!("attempt" in attempt)) return attempt;
  const { attemptId, bytes } = attempt.attempt;
  // 3. The bytes, outside every transaction, bounded.
  const decisionId = queued.decisionId;
  attempting.add(decisionId);
  let result: FlexibleSendResult;
  try { result = await boundedSend(connection, bytes, writeMs); } finally { attempting.delete(decisionId); }
  const outcome = result.complete && result.written === bytes.length ? "sent" : "uncertain";
  // 4. The outcome, in a new transaction: the catalog's row first (by its attempt), then this store's.
  try {
    const recorded = store.transact(() => {
      const at = clock().toISOString();
      const row = requestOf(catalog, input.request), decision = decisionOf(store, input.request);
      // Both stores must still hold exactly this attempt, still sending; the catalog's move must change exactly its row.
      if (row === null || decision === null || decision.attemptId !== attemptId || decision.state !== "sending" || row.attemptId !== attemptId || row.state !== "sending") return false;
      const moved = outcome === "sent"
        ? dbOf(catalog).prepare("UPDATE thread_request SET state = 'sent', sent_at = ? WHERE id = ? AND attempt_id = ? AND state = 'sending'").run(at, row.id, attemptId)
        : dbOf(catalog).prepare("UPDATE thread_request SET state = 'uncertain', ended_at = ?, detail = ? WHERE id = ? AND attempt_id = ? AND state = 'sending'").run(at, "the send didn't finish", row.id, attemptId);
      if (Number(moved.changes) !== 1) return false;
      store.handle.prepare("UPDATE thread_decision SET state = ?, state_at = ?, detail = ? WHERE id = ? AND attempt_id = ? AND state = 'sending'")
        .run(outcome, at, outcome === "sent" ? null : result.written === null ? "the send didn't finish in time" : `${result.written} of ${bytes.length} bytes were handed over`, decision.id, attemptId);
      ledger(store, at, decision.source === "person" ? decision.by : "toolroll", decision.source === "person" ? "work" : "policy", outcome, { thread: row.thread, turn: row.turn, decisionId: decision.decisionId });
      return true;
    });
    if (!recorded) { markUncertain(store, catalog, input.request, clock, "the answer's attempt changed while it was sent"); return refuse("uncertain", "uncertain"); }
  } catch {
    markUncertain(store, catalog, input.request, clock, "the send's outcome couldn't be recorded");
    return refuse("uncertain", "uncertain");
  }
  return outcome === "sent" ? { ok: true, state: "sent", decisionId } : refuse("uncertain", "uncertain");
}

/** In this process: the decisions whose bytes are being sent right now (the reconcilers leave them alone). */
const attempting = new Set<string>();

/** One bounded send: settled by the connection or, at the latest, by `writeMs` (then aborted). Never throws. */
async function boundedSend(connection: FlexibleAnswerConnection, bytes: Uint8Array, writeMs: number): Promise<FlexibleSendResult> {
  const unknown: FlexibleSendResult = { written: null, complete: false };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<FlexibleSendResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(unknown); }, writeMs); });
  const valid = (result: unknown): result is FlexibleSendResult => typeof result === "object" && result !== null && typeof (result as FlexibleSendResult).complete === "boolean"
    && ((result as FlexibleSendResult).written === null || (Number.isSafeInteger((result as FlexibleSendResult).written) && (result as FlexibleSendResult).written! >= 0));
  try {
    const sent = Promise.resolve().then(() => connection.send(bytes, { deadlineMs: writeMs, signal: controller.signal })).then(result => valid(result) ? result : unknown, () => unknown);
    return await Promise.race([sent, late]);
  } finally { clearTimeout(timer); }
}

/** Best effort, in its own transaction: an answer whose attempt may have begun is uncertain in both stores. */
function markUncertain(store: Store, catalog: FlexibleAnswerCatalog, request: string, clock: FlexibleClock, detail: string): void {
  try {
    store.transact(() => {
      const row = requestOf(catalog, request);
      if (row !== null) settle(store, catalog, row, decisionOf(store, request), "uncertain", clock().toISOString(), detail);
    });
  } catch { /* the reconcilers (expireFlexibleAnswers, recoverFlexibleAnswersOf) settle it */ }
}

// ---- cancelling and revoking ---------------------------------------------------------------------------------------------------

/** Whether an answer can still be stopped: decided, or sending with no attempt in either store (nor in this process). */
const stoppable = (decision: DecisionRow | null, row: RequestRow | null): boolean =>
  decision !== null && row !== null && (decision.state === "decided" || decision.state === "sending") && (row.state === "decided" || row.state === "sending")
  && decision.attemptId === null && row.attemptId === null && !attempted.has(decision.decisionId);

/**
 * The owner cancels their decided or sending answer (no attempt committed in either store yet): it is not-sent in both
 * stores. Once an attempt is committed the cancel loses and says so; exactly one of a cancel and a send wins.
 */
export function cancelFlexibleAnswer(store: Store, catalog: FlexibleAnswerCatalog, input: { request: string; by: { kind: "person"; name: string; generation: number }; clock?: FlexibleClock }):
  { ok: true; state: "not-sent" } | FlexibleAnswerRefusal {
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
    if (!stoppable(decision, row)) return refuse(decision === null ? "already-answered" : "too-late", decision?.state ?? row.state);
    settle(store, catalog, row, decision, "not-sent", at, `cancelled by ${input.by.name}`, input.by.name);
    return { ok: true as const, state: "not-sent" as const };
  });
}

/**
 * Authority over a thread's requests ended (its turn ended, its agent was stopped or lowered, the owner's access or the
 * terms changed): every pending request of the thread (or only of `turn` / `connection`) is withdrawn, and every answer
 * that can still be stopped is not-sent, in one transaction. An answer with a committed attempt is left to its ack,
 * its timeout or the reconcilers. Returns how many moved.
 */
export function revokeFlexibleAnswers(store: Store, catalog: FlexibleAnswerCatalog, input: { thread: string; turn?: string; connection?: string; reason: string; clock?: FlexibleClock }):
  { ok: true; withdrawn: number; notSent: number } | FlexibleAnswerRefusal {
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
      } else if (stoppable(decision, row)) {
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

/**
 * The reconciler while Toolroll runs (the time read once, inside the transaction): a sent answer that waited past
 * `ackMs` for an ack, or whose agent launch is no longer live, is uncertain; so is an attempt whose send's deadline
 * (`writeMs`) has passed without a recorded outcome (interrupted), and one the two stores disagree on (one says sent, the
 * other still sending). A send still running in this process is left alone.
 */
export function expireFlexibleAnswers(store: Store, catalog: FlexibleAnswerCatalog, input: { clock?: FlexibleClock; ackMs?: number; writeMs?: number } = {}): { ok: true; uncertain: number } | FlexibleAnswerRefusal {
  const ackMs = input.ackMs ?? FLEXIBLE_ANSWER_ACK_MS, writeMs = input.writeMs ?? FLEXIBLE_ANSWER_WRITE_MS;
  if (!Number.isSafeInteger(ackMs) || ackMs < 0 || !Number.isSafeInteger(writeMs) || writeMs < 0) return refuse("invalid-request");
  return store.transact(() => {
    const now = (input.clock ?? systemClock)();
    const at = now.toISOString();
    // Not yet past `limit` since `since`; an unreadable time is past.
    const within = (since: string | null | undefined, limit: number) => { const t = Date.parse(String(since)); return Number.isFinite(t) && now.getTime() - t < limit; };
    let uncertain = 0;
    for (const raw of dbOf(catalog).prepare("SELECT * FROM thread_request WHERE state IN ('sending', 'sent')").all()) {
      const row = readRequest(raw as Record<string, unknown>)!;
      const decision = decisionOf(store, row.id);
      if (decision !== null && attempting.has(decision.decisionId)) continue;
      const launch = flexibleLaunch(store, row.connection);
      const gone = launch === null || launch.state !== "live";
      let why: string | null = null;
      if (row.state === "sent" || decision?.state === "sent") {
        if (row.state !== decision?.state) why = "the two records of this answer disagree";
        else if (gone) why = "the agent stopped before it acknowledged the answer";
        else if (!within(row.sentAt, ackMs)) why = "the agent never acknowledged the answer";
      } else {
        const started = row.writeStartedAt ?? decision?.writeStartedAt ?? null;
        if (started !== null && !within(started, writeMs)) why = "the answer's send was interrupted";
      }
      if (why === null) continue;
      settle(store, catalog, row, decision, "uncertain", at, why);
      uncertain++;
    }
    // This store's answers still sending or sent whose catalog row already ended (or is gone): the stores split.
    for (const one of store.handle.prepare("SELECT request FROM thread_decision WHERE state IN ('sending', 'sent') AND request IS NOT NULL").all()) {
      const decision = decisionOf(store, String(one["request"]));
      if (decision === null || attempting.has(decision.decisionId)) continue;
      const row = requestOf(catalog, String(one["request"]));
      if (row !== null && OPEN.has(row.state)) continue;
      store.handle.prepare("UPDATE thread_decision SET state = 'uncertain', state_at = ?, detail = ? WHERE id = ?").run(at, "the two records of this answer disagree", decision.id);
      ledger(store, at, "toolroll", decision.source === "person" ? "work" : "policy", "uncertain", { thread: decision.thread, turn: decision.turn, decisionId: decision.decisionId }, "the two records of this answer disagree");
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

// ---- what a person's surface shows ------------------------------------------------------------------------------------------

/** One request as the thread's own surface shows it to its owner (F3): the card exactly as recorded (its digest is what
 * the person's answer must name), and where its answer stands. No token, no answer bytes. */
export type FlexibleRequestView = { request: string; turn: string; connection: string; requestRef: string; kind: FlexibleRequestKind; card: FlexibleRequestCard; requestDigest: string;
  state: FlexibleAnswerState; decision: FlexibleDecision | null; detail: string | null; createdAt: string };

/** A thread's requests, newest last (at most `limit`, default 20): every one still open, then the latest that ended, of
 * `turn` when given. Reads the coding catalog only; nothing moves. The caller admits the reader (the thread's owner). */
export function flexibleRequestsOf(catalog: FlexibleAnswerCatalog, input: { thread: string; turn?: string; limit?: number }): { ok: true; requests: FlexibleRequestView[] } | FlexibleAnswerRefusal {
  const limit = input.limit ?? 20;
  if (typeof input.thread !== "string" || !ID.test(input.thread) || (input.turn !== undefined && (typeof input.turn !== "string" || !ID.test(input.turn)))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return refuse("invalid-request");
  const rows = dbOf(catalog).prepare(`SELECT * FROM thread_request WHERE thread = ? AND (? IS NULL OR turn = ?)
    ORDER BY (state IN ('pending', 'decided', 'sending', 'sent')) DESC, created_at DESC, id LIMIT ?`).all(input.thread, input.turn ?? null, input.turn ?? null, limit) as Record<string, unknown>[];
  const requests = rows.map(raw => {
    const row = readRequest(raw)!;
    return { request: row.id, turn: row.turn, connection: row.connection, requestRef: row.requestRef, kind: row.kind, card: JSON.parse(row.card) as FlexibleRequestCard, requestDigest: row.requestDigest,
      state: row.state, decision: raw["decision"] === null ? null : String(raw["decision"]) as FlexibleDecision, detail: raw["detail"] === null ? null : String(raw["detail"]), createdAt: String(raw["created_at"]) };
  }).sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.request < b.request ? -1 : 1);
  return { ok: true, requests };
}
