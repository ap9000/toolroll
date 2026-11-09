/**
 * v159: one-step start from chat (docs/plans/one-step-chat.md). Adds only: a saved row reads as it did. Kept beside
 * nothing else so the update road can read the lists without the store, and so the version is easy to renumber.
 *
 * - `fast_preview.turn`: the lead turn a chat start's preview was prepared in (fast-start.ts prepareChatStart). Saved
 *   rows read NULL; a chat preview without a turn is unusable, and the form's previews never have one.
 */
export const V159_SCHEMA = ``;

export const V159_ADDED_COLUMNS: Readonly<Record<string, Readonly<Record<string, { definition: string; saved: string }>>>> = Object.freeze({
  fast_preview: { turn: { definition: "INTEGER", saved: "NULL" } },
});

export const V159_TABLES = Object.freeze([] as const);
/** The v159 migration's steps, in order (a test seam may stop after each). */
export const V159_STEPS = Object.freeze(["one-step-chat-tables", "one-step-chat-columns"] as const);
