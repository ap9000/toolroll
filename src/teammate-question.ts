/**
 * A teammate's question, answered in the chat app (v93).
 *
 * When a teammate asks its person something ("Refund all $200, or half?"),
 * the notice reaches them in their chat app under the teammate's name, with
 * one button per option and one to answer in their own words. A tap answers
 * at once; "Answer in words" opens a prompt: on Telegram, a reply to it; in
 * Slack, Discord and Teams, their next message in their chat with Standing
 * Orders ("cancel" leaves it). Either way the answer goes through the same
 * door as the card's own panel (answerTeammateQuestion): once, and only from
 * the person it was asked of. Answered anywhere, every button retires.
 */
import { randomBytes } from "node:crypto";
import type { ChatBinding, ChatContent, ChatEvent, ChatState } from "./chat-delivery-state.js";
import { partContent, savedChatPart } from "./chat-delivery-state.js";
import type { Store, TelegramBinding, TeammateQuestionRow } from "./store.js";
import type { InlineButton } from "./telegram-mate.js";
import { answerTeammateQuestion } from "./teammate-work.js";
import { labelOf } from "./teammate-admin.js";
import { telegramButton } from "./contracts/telegram-callback.js";

/** The key notifyPeople gives a teammate's question: flow-card:<card>:teammate-q:<question>:<person>. */
export const TEAMMATE_Q_KEY = /^flow-card:[1-9][0-9]{0,14}:teammate-q:([1-9][0-9]{0,14}):/;
export const IN_WORDS = "Answer in words";
const PROMPT_MS = 30 * 60_000;
const ANSWER_CHARS = 2000;

/** The question a notice is about, while it is still open. */
export function openQuestionOf(store: Store, dedupeKey: string): TeammateQuestionRow | null {
  const match = TEAMMATE_Q_KEY.exec(dedupeKey);
  const question = match === null ? null : store.teammateQuestion(Number(match[1]));
  return question !== null && question.state === "open" ? question : null;
}

const who = (store: Store, question: TeammateQuestionRow) => { const mate = store.getTeammate(question.teammate); return mate === null ? "Your teammate" : labelOf(mate).split(" · ")[0]!; };

/** Everyone else's buttons retire once a question is answered anywhere. */
function retireEverywhere(store: Store, question: number, now: Date, state?: ChatState): void {
  store.retireTelegramQuestion(question, now);
  state?.prepare("UPDATE chat_question_action SET consumed=? WHERE question=? AND consumed IS NULL").run(now.toISOString(), question);
  state?.prepare("UPDATE chat_question_prompt SET consumed=? WHERE question=? AND consumed IS NULL").run(now.toISOString(), question);
}

// ---- Telegram ----------------------------------------------------------------------

/** Buttons for the question, minted before the send (for the person it asks only); `place` stamps the message they land on. */
export function telegramQuestionButtons(store: Store, binding: TelegramBinding, question: TeammateQuestionRow, now: Date): { keyboard: InlineButton[][]; tokens: string[] } | null {
  if (binding.approver !== question.askedOf) return null;
  const choices = [...question.options.map(one => ({ token: randomBytes(16).toString("hex"), choice: one.id as string | null, label: one.label })), { token: randomBytes(16).toString("hex"), choice: null, label: `✏️ ${IN_WORDS}` }];
  store.createTelegramQuestionActions({ binding: binding.id, chatId: binding.chatId, question: question.id }, choices, now);
  const rows: InlineButton[][] = [];
  const options = choices.filter(one => one.choice !== null);
  for (let at = 0; at < options.length; at += 2) rows.push(options.slice(at, at + 2).map(one => telegramButton(one.label.slice(0, 60), one.token)));
  rows.push([telegramButton(choices.at(-1)!.label, choices.at(-1)!.token)]);
  return { keyboard: rows, tokens: choices.map(one => one.token) };
}

export type QuestionTapEffect =
  | { kind: "ack"; text: string }
  | { kind: "edit"; text: string }
  | { kind: "prompt"; text: string; placeholder: string; question: number };

/** A tapped question button, inside the update's transaction. */
export function applyTelegramQuestionTap(store: Store, binding: TelegramBinding, action: NonNullable<ReturnType<Store["getTelegramQuestionAction"]>>, message: { text: string }, now: Date): QuestionTapEffect[] {
  if (action.consumedAt !== null || action.expiresAt <= now.toISOString()) return [{ kind: "ack", text: "That was already answered, or these buttons are too old." }];
  const question = store.teammateQuestion(action.question);
  if (question === null || question.state !== "open") { store.retireTelegramQuestion(action.question, now); return [{ kind: "ack", text: "That was already answered." }]; }
  if (action.choice === null) return [{ kind: "ack", text: "Send your answer" }, { kind: "prompt", question: question.id, placeholder: "Your answer",
    text: `Your answer to ${who(store, question)}: “${question.question}” Reply to this message.` }];
  const answered = answerTeammateQuestion(store, question.id, { choice: action.choice, text: null, by: binding.approver, via: "telegram" }, now);
  if (!answered.ok) return [{ kind: "ack", text: answered.said.slice(0, 190) }];
  retireEverywhere(store, question.id, now);
  const label = question.options.find(one => one.id === action.choice)?.label ?? action.choice;
  return [{ kind: "ack", text: "Answered" }, { kind: "edit", text: `${message.text}\n\n✅ You answered: ${label}. ${answered.said}`.slice(0, 4000) }];
}

/** A reply to the "answer in words" prompt, inside the update's transaction. */
export function applyTelegramQuestionReply(store: Store, binding: TelegramBinding, prompt: NonNullable<ReturnType<Store["telegramQuestionPrompt"]>>, text: string, now: Date): string | null {
  if (prompt.binding !== binding.id) return null;
  const said = text.trim();
  if (said === "") return "Send the answer itself as a reply.";
  if (said.length > ANSWER_CHARS) return `Keep it under ${ANSWER_CHARS.toLocaleString("en-US")} characters.`;
  const answered = answerTeammateQuestion(store, prompt.question, { choice: null, text: said, by: binding.approver, via: "telegram" }, now);
  retireEverywhere(store, prompt.question, now);
  return answered.ok ? `✅ ${answered.said}` : answered.said;
}

// ---- Slack, Discord, Teams ---------------------------------------------------------

/** A question notice as chat parts (the buttons on the last), or null when it isn't one, isn't for this person, or was answered. */
export function questionParts(store: Store, notification: { dedupeKey: string; subject: string; body: string; link: string | null }, binding: ChatBinding): ChatContent[] | null {
  const question = openQuestionOf(store, notification.dedupeKey);
  if (question === null || question.askedOf !== binding.approver) return null;
  return [{ text: `${notification.subject}\n\n${notification.body}`.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 3000),
    question: { id: question.id, choices: [...question.options.map(one => ({ choice: one.id as string | null, label: one.label })), { choice: null, label: IN_WORDS }] },
    ...(notification.link === null ? {} : { link: { label: "Open", path: notification.link } }) }];
}

/** The live buttons on one part, in the order they were minted. */
export function chatQuestionButtons(state: ChatState, part: number, now: Date): Array<{ token: string; label: string; words: boolean }> {
  const row = state.prepare("SELECT payload FROM chat_part WHERE id=?").get(part);
  const content = row === undefined ? null : partContent(String(row["payload"]));
  const labels = new Map((content?.question?.choices ?? []).map(one => [one.choice ?? "", one.label]));
  return (state.prepare("SELECT token,choice FROM chat_question_action WHERE part=? AND consumed IS NULL AND expires>? ORDER BY rowid").all(part, now.toISOString()) as Array<{ token: string; choice: string | null }>)
    .map(one => ({ token: String(one.token), label: (labels.get(one.choice ?? "") ?? IN_WORDS).slice(0, 75), words: one.choice === null }));
}

/** Show the tapped notice again with the answer, and without its buttons. */
function repaint(state: ChatState, part: number, event: ChatEvent, line: string): void {
  const row = state.prepare("SELECT payload FROM chat_part WHERE id=?").get(part);
  const before = row === undefined ? { text: "" } : partContent(String(row["payload"]));
  const content: ChatContent = { text: `${before.text}\n\n${line}`.slice(0, 3400), edit: event.ts, ...(before.link === undefined ? {} : { link: before.link }), ...(before.channel === undefined ? {} : { channel: before.channel }) };
  state.prepare("UPDATE chat_part SET payload=?,state='pending',next_at=NULL WHERE id=?").run(savedChatPart(content), part);
}

/** A tapped question button, inside the action's transaction; false when the token isn't one. */
export function applyChatQuestionTap(options: { store: Store; state: ChatState; label: string }, event: ChatEvent, binding: ChatBinding, token: string, now: Date): boolean {
  const { store, state } = options;
  const action = state.prepare("SELECT a.*,p.message,e.binding AS owner,e.channel FROM chat_question_action a JOIN chat_part p ON p.id=a.part JOIN chat_event e ON e.id=p.event WHERE a.token=?").get(token);
  if (action === undefined) return false;
  const say = (text: string) => state.plan(event.id, [{ text }], now);
  // Bound to the person, the chat and the exact message the button rode.
  if (Number(action["owner"]) !== binding.id || action["channel"] !== event.channel || action["message"] !== event.ts) { say("That button expired or was already used."); return true; }
  const questionId = Number(action["question"]), part = Number(action["part"]);
  const question = store.teammateQuestion(questionId);
  if (action["consumed"] !== null || String(action["expires"]) <= now.toISOString() || question === null || question.state !== "open") {
    retireEverywhere(store, questionId, now, state);
    repaint(state, part, event, "This was already answered.");
    state.finish(event.id);
    return true;
  }
  if (action["choice"] === null) {
    // One open prompt per person, across flow decisions and questions: the newest is the one the next message answers.
    state.prepare("UPDATE chat_question_prompt SET consumed=? WHERE binding=? AND consumed IS NULL").run(now.toISOString(), binding.id);
    state.prepare("UPDATE chat_flow_prompt SET consumed=? WHERE binding=? AND consumed IS NULL").run(now.toISOString(), binding.id);
    state.prepare("INSERT INTO chat_question_prompt(binding,question,created,expires) VALUES(?,?,?,?)").run(binding.id, questionId, now.toISOString(), new Date(now.getTime() + PROMPT_MS).toISOString());
    say(`Your next message here is your answer to ${who(store, question)}: “${question.question}” Send “cancel” to leave it.`);
    return true;
  }
  const answered = answerTeammateQuestion(store, questionId, { choice: String(action["choice"]), text: null, by: binding.approver, via: options.label.toLowerCase() }, now);
  if (!answered.ok) { say(answered.said); return true; }
  retireEverywhere(store, questionId, now, state);
  const label = question.options.find(one => one.id === action["choice"])?.label ?? String(action["choice"]);
  repaint(state, part, event, `✅ You answered: ${label}. ${answered.said}`);
  state.finish(event.id);
  return true;
}

/** The person's message while an "answer in words" prompt is open: the answer. false when none is open. */
export function answerChatQuestionPrompt(options: { store: Store; state: ChatState; label: string }, event: ChatEvent, binding: ChatBinding, input: { text: string; originalLength?: number }, now: Date): boolean {
  const { store, state } = options;
  if (event.channel !== binding.channel) return false;
  return store.transact(() => {
    const prompt = state.prepare("SELECT * FROM chat_question_prompt WHERE binding=? AND consumed IS NULL AND expires>? ORDER BY id DESC LIMIT 1").get(binding.id, now.toISOString());
    if (prompt === undefined) return false;
    const id = Number(prompt["id"]), questionId = Number(prompt["question"]);
    const say = (text: string) => state.plan(event.id, [{ text }], now);
    const said = input.text.trim();
    if (/^cancel\.?$/i.test(said)) { state.prepare("UPDATE chat_question_prompt SET consumed=? WHERE id=?").run(now.toISOString(), id); say("Left it unanswered. The buttons on the message still work."); return true; }
    if (said === "") { say("Send the answer itself, or “cancel”."); return true; }
    // A message the chat cut short is never taken as part of an answer.
    if ((input.originalLength ?? 0) > input.text.length || said.length > ANSWER_CHARS) { say(`That's too long to take from here. Keep it under ${ANSWER_CHARS.toLocaleString("en-US")} characters, or answer on the card.`); return true; }
    const answered = answerTeammateQuestion(store, questionId, { choice: null, text: said, by: binding.approver, via: options.label.toLowerCase() }, now);
    retireEverywhere(store, questionId, now, state);
    say(answered.ok ? `✅ ${answered.said}` : answered.said);
    return true;
  });
}
