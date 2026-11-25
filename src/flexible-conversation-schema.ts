/**
 * v185: what was said in a Flexible thread, turn by turn (threads that feel like conversations). Adds one table and
 * changes no saved row:
 *
 * - `flexible_turn_said`: one row per turn a person's message started, written in the transaction that admitted the
 *   turn. `said` is the person's own message, exactly as they sent it; `start_tip` the thread branch's commit when the
 *   turn's agent was handed it (read by Toolroll as plain bytes, never by git in the thread's folder); `reply` the
 *   agent's final answer for that turn (its result), lines that look like a key hidden; `files` the paths the turn
 *   changed (a JSON list, from its start commit to the next turn's), filled in once Toolroll reads them. Each is written
 *   once: the message and its turn never change, and a value filled in stays.
 *
 * A turn's fresh agent reads the thread's earlier turns from here as quoted data (flexible-conversation.ts), and the
 * person's surfaces show their own messages from here. Kept apart from the store so the update road can read the lists
 * without it.
 */
export const V185_SCHEMA = `
CREATE TABLE IF NOT EXISTS flexible_turn_said (
  turn      TEXT PRIMARY KEY CHECK (length(turn) = 32 AND turn NOT GLOB '*[^0-9a-f]*'),
  thread    TEXT NOT NULL CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  seq       INTEGER NOT NULL CHECK (seq >= 1),
  said      TEXT NOT NULL CHECK (length(said) BETWEEN 1 AND 100000),
  said_at   TEXT NOT NULL,
  start_tip TEXT CHECK (start_tip IS NULL OR (length(start_tip) IN (40, 64) AND start_tip NOT GLOB '*[^0-9a-f]*')),
  reply     TEXT CHECK (reply IS NULL OR length(reply) <= 20000),
  files     TEXT CHECK (files IS NULL OR length(files) <= 20000),
  UNIQUE (thread, seq)
);
CREATE TRIGGER IF NOT EXISTS flexible_turn_said_written_once BEFORE UPDATE ON flexible_turn_said
WHEN NEW.turn IS NOT OLD.turn OR NEW.thread IS NOT OLD.thread OR NEW.seq IS NOT OLD.seq OR NEW.said IS NOT OLD.said OR NEW.said_at IS NOT OLD.said_at
  OR (OLD.start_tip IS NOT NULL AND NEW.start_tip IS NOT OLD.start_tip)
  OR (OLD.reply IS NOT NULL AND NEW.reply IS NOT OLD.reply)
  OR (OLD.files IS NOT NULL AND NEW.files IS NOT OLD.files)
BEGIN
  SELECT RAISE(ABORT, 'what was said in a flexible turn is written once');
END;
`;

export const V185_TABLES = Object.freeze(["flexible_turn_said"] as const);
/** The v185 migration's steps, in order (a test seam may stop after each). */
export const V185_STEPS = Object.freeze(["flexible-conversation"] as const);
/** v185's named objects, as a current or resumed file must hold them exactly (store.ts checks each). */
export const V185_OBJECTS = Object.freeze([["table", "flexible_turn_said"], ["trigger", "flexible_turn_said_written_once"]] as const);
