/**
 * A typed yes to a Start card, on Telegram (docs/plans/one-step-chat.md C5). Toolroll reads the word when the message
 * arrives, before any model runs: the lead never sees it as an instruction and has no tool that presses a card. Which
 * card a yes belongs to comes from Telegram's own message ids and Toolroll's delivery record (chat_part), never from the
 * text or the lead.
 *
 * Read at ingress (telegram.ts applyConversation, the typed-message path only) in the transaction that saves the message,
 * and read again from the tables by confirmTypedStart (lead-doors.ts) in the transaction that acts on it.
 */
import { sharedActionAllowsChallenge, sharedActionPayload } from "./chat-actions.js";
import type { Store } from "./store.js";

/** The card's last line on Telegram, outside the terms (terms are digest-bound), in Toolroll's fixed words. */
export const TYPED_START_LINE = "Tap Start work, or reply yes.";
/** What a yes that counted for nothing says. It is never passed to the lead. */
export const TYPED_START_REFUSED = "That yes didn't start anything. Tap Start work on the card.";

const WORDS: ReadonlySet<string> = new Set(["yes", "y", "yep", "yeah", "yes please", "yes start", "start", "start it", "go ahead", "do it"]);

/** Whether a typed message is exactly one of the fixed yes words: trimmed, lower-cased, one trailing `.` or `!` removed.
 * Anything longer or different ("yes but make it blue", "ok", "sure") is an ordinary message to the lead. */
export function typedYes(text: string): boolean {
  const word = text.trim().toLowerCase().replace(/[.!]$/, "");
  return WORDS.has(word);
}

export type TypedStartCard = { proposal: number; cardMessage: string; stamp: string; how: "reply" | "next" };

/**
 * The Start card a yes in this chat answers, by ids, or null. Every condition from the plan:
 * - the chat's last sent card is a card for a `task_start` proposal: sent (a confirmed message id), never
 *   uncertain, the last part of its event, sent with its buttons and the fixed "reply yes" line, its terms whole on the
 *   card (sharedActionAllowsChallenge);
 * - the message is a Telegram reply to that card's message (`reply`), or replies to nothing and its message id is the
 *   card's plus one (`next`): nothing at all was sent or typed in the chat between them;
 * - the proposal is pending, the only pending proposal in the person's own thread with the lead (never a team room),
 *   drafted in a turn that answered (one finalized after a timeout doesn't qualify).
 */
export function typedStartCard(store: Store, chat: { binding: number; chatId: string; approver: string }, message: { id: string; replyTo: string | null }): TypedStartCard | null {
  const own = /^[1-9][0-9]{0,15}$/;
  if (!own.test(message.id) || (message.replyTo !== null && !own.test(message.replyTo))) return null;
  // The chat's last sent card, by Telegram's own message id (ids in one private chat run in order, both directions).
  const last = store.handle.prepare(`SELECT p.id, p.event, p.ordinal, p.payload, p.message, p.uncertain FROM chat_part p
      JOIN chat_event e ON e.provider = p.provider AND e.id = p.event
     WHERE p.provider = 'telegram' AND e.binding = ? AND e.channel = ? AND p.state = 'sent' AND p.message IS NOT NULL
       AND json_valid(p.payload) AND json_extract(p.payload, '$.card') = 1
     ORDER BY CAST(p.message AS INTEGER) DESC LIMIT 1`).get(chat.binding, chat.chatId);
  if (last === undefined) return null;
  const cardMessage = String(last["message"]);
  if (!own.test(cardMessage) || Number(last["uncertain"]) !== 0) return null;
  const how = message.replyTo === cardMessage ? "reply" : message.replyTo === null && BigInt(message.id) === BigInt(cardMessage) + 1n ? "next" : null;
  if (how === null) return null;
  const lastOrdinal = store.handle.prepare("SELECT MAX(ordinal) AS n FROM chat_part WHERE provider = 'telegram' AND event = ?").get(String(last["event"]))?.["n"];
  if (Number(lastOrdinal) !== Number(last["ordinal"])) return null;
  let content: { text?: unknown; proposal?: unknown; keyboard?: unknown; card?: unknown };
  try { content = JSON.parse(String(last["payload"])) as typeof content; } catch { return null; }
  if (content.card !== true || typeof content.proposal !== "number" || !Array.isArray(content.keyboard) || typeof content.text !== "string" || !content.text.trimEnd().endsWith(TYPED_START_LINE)) return null;
  const proposal = store.getLeadProposal(content.proposal);
  const action = proposal?.kind === "action" ? sharedActionPayload(proposal.payload) : null;
  if (proposal === null || action === null || action.operation !== "task_start" || !sharedActionAllowsChallenge(action) || proposal.state !== "pending") return null;
  const thread = store.getLeadThread(proposal.thread);
  if (thread === null || thread.approver !== chat.approver || thread.closedAt !== null) return null;
  if (store.handle.prepare("SELECT 1 AS hit FROM team_conversation WHERE thread = ?").get(proposal.thread) !== undefined) return null;
  if (store.getLeadTurn(proposal.turn)?.state !== "answered") return null;
  const pending = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM lead_proposal WHERE thread = ? AND state = 'pending'").get(proposal.thread)?.["n"]);
  if (pending !== 1) return null;
  return { proposal: proposal.id, cardMessage, stamp: action.stamp, how };
}

/** Record a typed yes for the message just saved (event `m<update_id>`), in the caller's transaction. */
export function recordTypedStart(store: Store, event: string, card: TypedStartCard, now: Date): void {
  store.handle.prepare(`INSERT INTO chat_typed_start (provider, event, proposal, card_message, stamp, how, created) VALUES ('telegram', ?, ?, ?, ?, ?, ?)`)
    .run(event, card.proposal, card.cardMessage, card.stamp, card.how, now.toISOString());
}

export type TypedStartRow = { provider: "telegram"; event: string; proposal: number; cardMessage: string; stamp: string; how: "reply" | "next";
  outcome: "started" | "refused" | "not-counted" | null; taskId: string | null };

/** A message's typed-yes record, or null when it has none. */
export function typedStartOf(store: Store, provider: "telegram", event: string): TypedStartRow | null {
  const row = store.handle.prepare("SELECT * FROM chat_typed_start WHERE provider = ? AND event = ?").get(provider, event);
  if (row === undefined) return null;
  return { provider, event, proposal: Number(row["proposal"]), cardMessage: String(row["card_message"]), stamp: String(row["stamp"]), how: row["how"] === "reply" ? "reply" : "next",
    outcome: row["outcome"] === "started" || row["outcome"] === "refused" || row["outcome"] === "not-counted" ? row["outcome"] : null,
    taskId: row["task_id"] === null ? null : String(row["task_id"]) };
}

/** Whether an UNSETTLED typed yes names exactly this proposal: the only thing `typedStart` may open, and only once. */
export function typedStartNames(store: Store, typed: { provider: string; event: string }, proposal: number): boolean {
  if (typed.provider !== "telegram" || typeof typed.event !== "string") return false;
  const row = typedStartOf(store, "telegram", typed.event);
  return row !== null && row.outcome === null && row.proposal === proposal;
}
