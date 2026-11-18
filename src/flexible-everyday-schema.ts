/**
 * v173: interactive agent threads for everyday use (docs/plans/threads-everyday.md). Adds three tables and changes no
 * saved row:
 *
 * - `flexible_stop_request`: a durable requirement that one launch of a thread's agent be stopped (its whole tree's
 *   exit verified), written in the same transaction as whatever ended the authority it ran on: a person's sign-in
 *   removed, their account changed, the relay refusing a call that ends the turn, the thread ended. Every console reads
 *   it on its upkeep tick and stops the launches it holds; a row is settled only once its launch's record says exited,
 *   so it survives a crash, a restart and another process writing it. Settling is the one change a row ever takes.
 * - `flexible_turn_dispatch`: the sign-in removal epoch and account generation a turn was begun under (written once, in
 *   the transaction that begins it). The upkeep's backstop compares a running turn's own dispatch facts with the record
 *   now, never today's epoch: a removal followed by a fresh save still ends a turn begun before the removal.
 * - `flexible_thread_meta`: a thread's title (the first line of its first message, cleaned; written once) and its end
 *   (End is final: who ended it, when, and Toolroll's words, written once), and when its working copy was tidied.
 *   Kept apart from `flexible_thread.state`, which stays the record of the repository's own removal.
 *
 * Kept apart from the store so the update road can read the lists without it.
 */

export const V173_SCHEMA = `
CREATE TABLE IF NOT EXISTS flexible_stop_request (
  launch       TEXT PRIMARY KEY CHECK (length(launch) = 32 AND launch NOT GLOB '*[^0-9a-f]*'),
  thread       TEXT NOT NULL CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  reason       TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  requested_at TEXT NOT NULL,
  settled_at   TEXT
);
CREATE INDEX IF NOT EXISTS flexible_stop_request_open ON flexible_stop_request (thread) WHERE settled_at IS NULL;
CREATE TRIGGER IF NOT EXISTS flexible_stop_request_settles_once BEFORE UPDATE ON flexible_stop_request
WHEN NEW.launch IS NOT OLD.launch OR NEW.thread IS NOT OLD.thread OR NEW.reason IS NOT OLD.reason OR NEW.requested_at IS NOT OLD.requested_at
  OR OLD.settled_at IS NOT NULL OR NEW.settled_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a flexible stop request only ever settles, once');
END;
CREATE TRIGGER IF NOT EXISTS flexible_stop_request_kept BEFORE DELETE ON flexible_stop_request
BEGIN
  SELECT RAISE(ABORT, 'a flexible stop request is kept');
END;
CREATE TABLE IF NOT EXISTS flexible_turn_dispatch (
  turn               TEXT PRIMARY KEY CHECK (length(turn) = 32 AND turn NOT GLOB '*[^0-9a-f]*'),
  person             TEXT NOT NULL CHECK (length(person) BETWEEN 1 AND 200),
  sign_in_epoch      INTEGER NOT NULL CHECK (sign_in_epoch >= 0),
  account_generation INTEGER NOT NULL CHECK (account_generation >= 0)
);
CREATE TRIGGER IF NOT EXISTS flexible_turn_dispatch_written_once BEFORE UPDATE ON flexible_turn_dispatch
BEGIN
  SELECT RAISE(ABORT, 'a flexible turn''s dispatch facts are written once');
END;
CREATE TABLE IF NOT EXISTS flexible_thread_meta (
  thread    TEXT PRIMARY KEY CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  title     TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 80),
  ended_at  TEXT,
  ended_by  TEXT CHECK (ended_by IS NULL OR length(ended_by) BETWEEN 1 AND 200),
  end_words TEXT CHECK (end_words IS NULL OR length(end_words) BETWEEN 1 AND 2000),
  tidied_at TEXT,
  CHECK ((ended_at IS NULL) = (ended_by IS NULL)),
  CHECK ((ended_at IS NULL) = (end_words IS NULL)),
  CHECK (tidied_at IS NULL OR ended_at IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS flexible_thread_meta_written_once BEFORE UPDATE ON flexible_thread_meta
WHEN NEW.thread IS NOT OLD.thread
  OR (OLD.title IS NOT NULL AND NEW.title IS NOT OLD.title)
  OR (OLD.ended_at IS NOT NULL AND (NEW.ended_at IS NOT OLD.ended_at OR NEW.ended_by IS NOT OLD.ended_by OR NEW.end_words IS NOT OLD.end_words))
  OR (OLD.tidied_at IS NOT NULL AND NEW.tidied_at IS NOT OLD.tidied_at)
BEGIN
  SELECT RAISE(ABORT, 'a flexible thread''s title and end are written once, and an end is final');
END;
CREATE TRIGGER IF NOT EXISTS flexible_thread_meta_kept BEFORE DELETE ON flexible_thread_meta
BEGIN
  SELECT RAISE(ABORT, 'a flexible thread''s title and end are kept');
END;
`;

export const V173_TABLES = Object.freeze(["flexible_stop_request", "flexible_turn_dispatch", "flexible_thread_meta"] as const);
/** The v173 migration's steps, in order (a test seam may stop after each). */
export const V173_STEPS = Object.freeze(["flexible-everyday"] as const);
/** v173's named objects, as a current or resumed file must hold them exactly (store.ts checks each). */
export const V173_OBJECTS = Object.freeze([
  ["table", "flexible_stop_request"], ["index", "flexible_stop_request_open"], ["trigger", "flexible_stop_request_settles_once"], ["trigger", "flexible_stop_request_kept"],
  ["table", "flexible_turn_dispatch"], ["trigger", "flexible_turn_dispatch_written_once"],
  ["table", "flexible_thread_meta"], ["trigger", "flexible_thread_meta_written_once"], ["trigger", "flexible_thread_meta_kept"],
] as const);
