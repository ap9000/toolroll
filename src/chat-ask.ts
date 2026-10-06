/**
 * The lead's question to its owner (ask_owner) in Slack, Discord and Teams.
 *
 * The reply's last part carries the question with one button per option and
 * one for "Something else", minted when the part is planned (chat_ask_action).
 * A tapped option is sent as the owner's next message in their own chat with
 * Toolroll, so the lead reads it like anything they typed; "Something else"
 * asks them to type it. Buttons are drawn only in that own chat (any thread of
 * it): in a room the question goes out as text, since a tap there is not the
 * owner's own message. A button works once, only for the person the lead
 * asked, and only while nobody has written in that thread since.
 */
import type { ChatBinding, ChatContent, ChatEvent, ChatState } from "./chat-delivery-state.js";
import { chatHash, partContent, savedChatPart } from "./chat-delivery-state.js";
import { MATE_ASK_OTHER, type MateAsk, type Store } from "./store.js";

/** The question as text with its options, where no buttons are drawn. */
export function chatAskText(ask: Pick<MateAsk, "question" | "options">): string {
  return [ask.question, ...ask.options.map(one => `• ${one}`), `• ${MATE_ASK_OTHER}: say it in your own words`].join("\n");
}

/** The live buttons on one part, in the order they were minted: the options, then "Something else". None when the part
 * is not in its owner's own chat with Toolroll (a room), where a tap could not be their message. */
export function chatAskButtons(state: ChatState, part: number, now: Date): Array<{ token: string; label: string; words: boolean }> {
  const row = state.prepare("SELECT p.payload,e.channel,b.channel AS own FROM chat_part p JOIN chat_event e ON e.id=p.event JOIN chat_binding b ON b.id=e.binding WHERE p.id=?").get(part);
  if (row === undefined) return [];
  const content = partContent(String(row["payload"]));
  if ((content.channel ?? row["channel"]) !== row["own"]) return [];
  const options = content.ask?.options ?? [];
  return (state.prepare("SELECT token,choice FROM chat_ask_action WHERE part=? AND consumed IS NULL AND expires>? ORDER BY rowid").all(part, now.toISOString()) as Array<{ token: string; choice: number | null }>)
    .map(one => {
      const label = one.choice === null ? MATE_ASK_OTHER : options[Number(one.choice)] ?? null;
      return label === null ? null : { token: String(one.token), label: label.slice(0, 75), words: one.choice === null };
    })
    .filter((one): one is { token: string; label: string; words: boolean } => one !== null);
}

/** How old a part may be and still be sent: older ones are dropped undelivered (slack-chat.ts, discord-chat.ts,
 * teams-chat.ts), so an edit to one would never land. */
const EDIT_WINDOW_MS = 86_400_000;

/** Show the question again with what happened, and without its buttons: one edit, under the part's own time. A question
 * too old to edit gets the line once as a new message instead. */
function repaint(state: ChatState, part: number, event: ChatEvent, line: string, now: Date): void {
  const row = state.prepare("SELECT payload,created FROM chat_part WHERE id=?").get(part);
  if (row === undefined || new Date(String(row["created"])).getTime() + EDIT_WINDOW_MS <= now.getTime()) {
    state.plan(event.id, [{ text: line }], now);
    return;
  }
  const before = partContent(String(row["payload"]));
  const content: ChatContent = { text: `${before.text}\n\n${line}`.slice(0, 3400), edit: event.ts, ...(before.channel === undefined ? {} : { channel: before.channel }) };
  state.prepare("UPDATE chat_part SET payload=?,state='pending',next_at=NULL WHERE id=?").run(savedChatPart(content), part);
  state.finish(event.id);
}

/** A tapped ask button, inside the action's transaction; false when the token isn't one. */
export function applyChatAskTap(options: { store: Store; state: ChatState }, event: ChatEvent, binding: ChatBinding, token: string, now: Date): boolean {
  const { store, state } = options;
  const action = state.prepare("SELECT a.*,p.message,e.binding AS owner,e.channel FROM chat_ask_action a JOIN chat_part p ON p.id=a.part JOIN chat_event e ON e.id=p.event WHERE a.token=?").get(token);
  if (action === undefined) return false;
  const say = (text: string) => state.plan(event.id, [{ text }], now);
  // Bound to the person, their own chat and the exact message the button rode.
  if (Number(action["owner"]) !== binding.id || action["channel"] !== event.channel || event.channel !== binding.channel || action["message"] !== event.ts) {
    say("That button expired or was already used.");
    return true;
  }
  const turn = Number(action["turn"]), part = Number(action["part"]);
  // Only the person the lead asked answers it: anyone else's tap changes nothing and says nothing.
  const asker = store.getMateTurn(turn)?.approver;
  if (asker !== undefined && asker !== binding.approver) {
    state.finish(event.id);
    return true;
  }
  const found = asker === undefined ? { state: "expired" as const } : store.mateAskState(turn, now);
  const expired = found.state === "expired" || String(action["expires"]) <= now.toISOString();
  // A question already settled was shown so once (or is being): a later tap says nothing more.
  if (action["consumed"] !== null) {
    state.finish(event.id);
    return true;
  }
  if (found.state !== "open" || expired) {
    state.prepare("UPDATE chat_ask_action SET consumed=? WHERE part=? AND consumed IS NULL").run(now.toISOString(), part);
    // The question is shown again without its buttons, so a later tap has nothing to press.
    repaint(state, part, event, found.state === "answered" ? "This question was already answered." : "This question expired. If it still matters, send your answer as a message.", now);
    return true;
  }
  const ask = found.ask;
  if (action["choice"] === null) {
    say("Type your answer here as your next message.");
    return true;
  }
  const option = ask.options[Number(action["choice"])];
  if (option === undefined) { say("That option is no longer there."); return true; }
  state.prepare("UPDATE chat_ask_action SET consumed=? WHERE part=? AND consumed IS NULL").run(now.toISOString(), part);
  // The option is the owner's next message, answered like one they typed.
  state.enqueue({
    id: chatHash(`${state.channel}:ask:${event.id}`).slice(0, 32), installation: event.installation, binding: binding.id, kind: "message",
    channel: event.channel, member: event.member, ts: event.ts, thread: event.thread,
    payload: { text: option, originalLength: option.length }, created: now.toISOString(),
  });
  repaint(state, part, event, `You chose: ${option}`, now);
  return true;
}
