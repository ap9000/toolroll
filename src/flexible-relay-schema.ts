/**
 * v166: the calls a Flexible thread's sign-in relay handled (the Flexible plan v2 §2 and §8, Codex round 2 item 8, slice
 * F2b). Adds only a table: no saved row changes, and nothing writes it while Flexible isn't available
 * (flexible-available.ts). Kept apart from the store so the update road can read the lists without it.
 *
 * - `thread_relay_call`: one row per call the relay authenticated (flexible-relay.ts), written once, when the call ends,
 *   in the same transaction that charges it to its turn (flexible-turns.ts chargeFlexibleTurn). A forwarded call always
 *   names the turn it was charged to; a refused one (wrong route, a credential header, a model or size over the limits,
 *   too many at once, no running turn) forwarded nothing and costs nothing. Usage is what the relay itself read from
 *   the service's answer (its streamed usage events included), never what the agent says; `cost_basis` is how sure the
 *   charge is (unknown when the answer's usage couldn't be read whole: F2e's unknown-cost hold). `detail` is redacted:
 *   no credential, token or header is ever kept.
 * - `thread_relay_pending`: a call's reservation, written in the same transaction that re-checks its token and its turn,
 *   before anything is sent, and cleared in the same transaction that records and charges the call. One still there is
 *   a call whose charge was never recorded. It names the relay that made it (another relay's is one that is gone) and
 *   its route (a token count costs nothing). Its own relay retries the charge while its turn runs, and the thread
 *   takes no new call meanwhile; anything else is reconciled from the record (on the relay's start, every tick and a
 *   turn's end): charged as unknown, or as nothing for a token count. While one is there after its turn ended, a keyed
 *   turn's cost counts as unknown (F2e's hold).
 */
export const V166_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_relay_call (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  thread        TEXT NOT NULL CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  turn          TEXT CHECK (turn IS NULL OR (length(turn) = 32 AND turn NOT GLOB '*[^0-9a-f]*')),
  launch        TEXT NOT NULL CHECK (length(launch) = 32 AND launch NOT GLOB '*[^0-9a-f]*'),
  upstream      TEXT NOT NULL CHECK (upstream IN ('claude')),
  at            TEXT NOT NULL,
  ended_at      TEXT NOT NULL,
  route         TEXT NOT NULL CHECK (route IN ('messages', 'count-tokens', 'other')),
  model         TEXT CHECK (model IS NULL OR length(model) <= 200),
  streamed      INTEGER NOT NULL CHECK (streamed IN (0, 1)),
  status        TEXT NOT NULL CHECK (status IN ('completed', 'incomplete', 'upstream-error', 'redirect-refused', 'aborted', 'refused')),
  reason        TEXT CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 40 AND reason NOT GLOB '*[^a-z-]*')),
  http_status   INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  tokens_in     INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out    INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  cache_read    INTEGER NOT NULL DEFAULT 0 CHECK (cache_read >= 0),
  cache_write   INTEGER NOT NULL DEFAULT 0 CHECK (cache_write >= 0),
  cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
  cost_basis    TEXT CHECK (cost_basis IS NULL OR cost_basis IN ('measured', 'estimated', 'unknown')),
  detail        TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  CHECK ((status = 'refused') = (reason IS NOT NULL)),
  CHECK (status <> 'refused' OR (tokens_in = 0 AND tokens_out = 0 AND cache_read = 0 AND cache_write = 0 AND cost_microusd = 0 AND cost_basis IS NULL)),
  CHECK (status = 'refused' OR (turn IS NOT NULL AND cost_basis IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS thread_relay_call_turn ON thread_relay_call (turn);
CREATE INDEX IF NOT EXISTS thread_relay_call_thread ON thread_relay_call (thread, at);
CREATE TRIGGER IF NOT EXISTS thread_relay_call_written_once BEFORE UPDATE ON thread_relay_call
BEGIN
  SELECT RAISE(ABORT, 'a relay call is written once');
END;
CREATE TABLE IF NOT EXISTS thread_relay_pending (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  thread        TEXT NOT NULL CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  turn          TEXT NOT NULL CHECK (length(turn) = 32 AND turn NOT GLOB '*[^0-9a-f]*'),
  launch        TEXT NOT NULL CHECK (length(launch) = 32 AND launch NOT GLOB '*[^0-9a-f]*'),
  holder        TEXT NOT NULL CHECK (length(holder) BETWEEN 1 AND 128),
  relay         TEXT NOT NULL CHECK (length(relay) = 32 AND relay NOT GLOB '*[^0-9a-f]*'),
  route         TEXT NOT NULL CHECK (route IN ('messages', 'count-tokens')),
  reserved_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS thread_relay_pending_thread ON thread_relay_pending (thread);
CREATE INDEX IF NOT EXISTS thread_relay_pending_turn ON thread_relay_pending (turn);
CREATE TRIGGER IF NOT EXISTS thread_relay_pending_written_once BEFORE UPDATE ON thread_relay_pending
BEGIN
  SELECT RAISE(ABORT, 'a relay reservation is written once and only cleared');
END;
`;

export const V166_TABLES = Object.freeze(["thread_relay_call", "thread_relay_pending"] as const);
/** The v166 migration's steps, in order (a test seam may stop after each). */
export const V166_STEPS = Object.freeze(["thread-relay-call"] as const);
/** v166's named objects, as a current or resumed file must hold them exactly (store.ts checks each). */
export const V166_OBJECTS = Object.freeze([
  ["table", "thread_relay_call"], ["index", "thread_relay_call_turn"], ["index", "thread_relay_call_thread"], ["trigger", "thread_relay_call_written_once"],
  ["table", "thread_relay_pending"], ["index", "thread_relay_pending_thread"], ["index", "thread_relay_pending_turn"], ["trigger", "thread_relay_pending_written_once"],
] as const);
