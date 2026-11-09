/**
 * v159: one-step start from chat (docs/plans/one-step-chat.md). Adds only: a saved row reads as it did. Kept beside
 * nothing else so the update road can read the lists without the store, and so the version is easy to renumber.
 *
 * - `fast_preview.turn`: the lead turn a chat start's preview was prepared in (fast-start.ts prepareChatStart). Saved
 *   rows read NULL; a chat preview without a turn is unusable, and the form's previews never have one.
 * - `chat_typed_start` (C5): a typed yes to a Start card, recorded with the inbound message in the transaction that saves
 *   it (typed-start.ts): which card it answered (the proposal and the chat message that carried it), the card's action
 *   stamp then, how it was tied to the card (`reply` to it, or the `next` message after it), and once settled, the
 *   outcome and the task it started. A new table: nothing saved changes.
 */
export const V159_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_typed_start (
  provider     TEXT NOT NULL CHECK (provider IN ('telegram')),
  event        TEXT NOT NULL,
  proposal     INTEGER NOT NULL REFERENCES lead_proposal(id) ON DELETE CASCADE,
  card_message TEXT NOT NULL,
  stamp        TEXT NOT NULL,
  how          TEXT NOT NULL CHECK (how IN ('reply', 'next')),
  created      TEXT NOT NULL,
  outcome      TEXT CHECK (outcome IS NULL OR outcome IN ('started', 'refused', 'not-counted')),
  task_id      TEXT,
  finished     TEXT,
  PRIMARY KEY (provider, event),
  FOREIGN KEY (provider, event) REFERENCES chat_event(provider, id)
);
CREATE INDEX IF NOT EXISTS chat_typed_start_proposal ON chat_typed_start (proposal);
`;

export const V159_ADDED_COLUMNS: Readonly<Record<string, Readonly<Record<string, { definition: string; saved: string }>>>> = Object.freeze({
  fast_preview: { turn: { definition: "INTEGER", saved: "NULL" } },
});

export const V159_TABLES = Object.freeze(["chat_typed_start"] as const);
/** The v159 migration's steps, in order (a test seam may stop after each). */
export const V159_STEPS = Object.freeze(["one-step-chat-tables", "one-step-chat-columns"] as const);
