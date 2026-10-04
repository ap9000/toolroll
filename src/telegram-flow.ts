/**
 * Flow decisions on Telegram (v86). A card waiting at a "Person decides"
 * zone reaches the decider with the draft in front of it (when a Draft zone
 * sends it there) and three buttons: Approve, Edit, Send back.
 *
 * - Approve decides it through the same door as the console
 *   (decideFlowCard), as the paired person, for exactly the visit the
 *   message was about.
 * - Edit asks for the person's own version as a reply; it replaces the
 *   draft on the card and comes back with fresh buttons, so what is
 *   approved is always what they read.
 * - Send back asks what should change; the reply is the note.
 *
 * Every button is one opaque token for one visit of one card, placed on the
 * message it rides. A card that moved on answers so; a tap from anyone but
 * the paired person and chat never reaches here (telegram.ts checks it).
 *
 * A "Person chooses" visit (flow-send.ts) has one button per option the flow
 * names; a reply to that message instead of a tap is the note for where
 * replies go. Both go through chooseFlowCard, for exactly that visit.
 */
import { randomBytes } from "node:crypto";
import { LIMITS } from "./decision.js";
import { keptDraft } from "./flow-draft.js";
import { decideFlowCard, draftFor, flowDefinitionOf } from "./flow-engine.js";
import { chooseFlowCard, flowChoiceAt, flowSendPaths, readFlowSend, type FlowChoiceVisit, type FlowSendContent } from "./flow-send.js";
import { deciderOf, type FlowStage } from "./flows.js";
import { phoneLinkButton, type InlineButton } from "./telegram-mate.js";
import type { FlowCardRow, FlowRow, Store, TelegramBinding, TelegramFlowAction, TelegramFlowChoice, TelegramFlowPrompt } from "./store.js";

export const FLOW_DECIDE_KEY = /^flow-decide:([1-9][0-9]{0,14}):([1-9][0-9]{0,9})$/;
const DRAFT_LIMIT = 4000;

type Waiting = { card: FlowCardRow; flow: FlowRow; stage: FlowStage; draft: FlowStage | null };

/** The card, if it is still at that visit, waiting at a decision. */
export function flowDecisionAt(store: Store, cardId: number, entry: number): Waiting | null {
  const card = store.getFlowCard(cardId);
  const flow = card === null ? null : store.getFlow(card.flow);
  const definition = flow === null ? null : flowDefinitionOf(flow);
  if (card === null || flow === null || definition === null || card.state !== "active" || card.entry !== entry) return null;
  const stage = definition.stages.find(one => one.id === card.stage);
  if (stage === undefined || stage.kind !== "approval") return null;
  return { card, flow, stage, draft: draftFor(definition, stage) };
}

/** Buttons for one visit, minted before the send; `place` stamps the message they landed on. */
export function flowButtons(store: Store, binding: TelegramBinding, waiting: Waiting, now: Date): { keyboard: InlineButton[][]; tokens: string[] } {
  const mint = (action: TelegramFlowAction["action"]) => ({ action, token: randomBytes(16).toString("hex") });
  const approve = mint("approve");
  const edit = waiting.draft !== null && waiting.card.outputs[waiting.draft.id] !== undefined ? mint("edit") : null;
  const back = waiting.stage.onFail !== null ? mint("send-back") : null;
  const all = [approve, edit, back].filter((one): one is NonNullable<typeof one> => one !== null);
  store.createTelegramFlowActions({ binding: binding.id, chatId: binding.chatId, card: waiting.card.id, entry: waiting.card.entry }, all, now);
  const second = [edit === null ? null : { text: "✏️ Edit", callback_data: edit.token }, back === null ? null : { text: "↩️ Send back", callback_data: back.token }]
    .filter((one): one is { text: string; callback_data: string } => one !== null);
  return { keyboard: [[{ text: "✅ Approve", callback_data: approve.token }], ...(second.length === 0 ? [] : [second])], tokens: all.map(one => one.token) };
}

/** What a "Send to me" or "Person chooses" visit sent, read back for its message. */
export function flowSentContent(store: Store, card: number, entry: number): FlowSendContent | null {
  const kept = store.flowSend(card, entry);
  return kept === null ? null : readFlowSend(kept.contentJson);
}

/** A sent visit's links as one row of buttons: Toolroll's pages under the trusted origin, and its pull request. */
export function flowSendKeyboardRow(origin: string | null, content: FlowSendContent): InlineButton[] {
  const pages = origin === null ? [] : flowSendPaths(content).flatMap(one => phoneLinkButton(origin, one) ?? []);
  const pull = content.links.flatMap(one => "url" in one ? [{ text: one.label, url: one.url }] : []);
  return [...pages.slice(0, 1), ...pull, ...pages.slice(1)].slice(0, 3);
}

/** A choice's buttons for one visit, one option to a row, minted before the send; `place` stamps the message they landed on. */
export function flowChoiceButtons(store: Store, binding: TelegramBinding, visit: FlowChoiceVisit, content: FlowSendContent, now: Date): { keyboard: InlineButton[][]; tokens: string[] } {
  // Only the options the zone still offers as they were sent: a flow changed since sends no stale button.
  const options = (content.options ?? []).filter(one => visit.stage.options?.[one.choice]?.label === one.label).map(one => ({ ...one, token: randomBytes(16).toString("hex") }));
  store.createTelegramFlowChoices({ binding: binding.id, chatId: binding.chatId, card: visit.card.id, entry: visit.card.entry }, options, now);
  return { keyboard: options.map(one => [{ text: one.label, callback_data: one.token }]), tokens: options.map(one => one.token) };
}

/** A tapped option, applied inside the update's transaction. */
export function applyFlowChoiceTap(store: Store, binding: TelegramBinding, choice: TelegramFlowChoice, message: { text: string }, repos: readonly string[] | null, now: Date): FlowTapEffect[] {
  if (choice.consumedAt !== null || choice.expiresAt <= now.toISOString()) return [{ kind: "ack", text: "That was already chosen, or these buttons are too old." }];
  const visit = flowChoiceAt(store, choice.card, choice.entry);
  if (visit === null) {
    store.retireFlowChoices(choice.card, choice.entry, now);
    return [{ kind: "ack", text: "That card has moved on since; nothing was changed." }, { kind: "edit", text: `${message.text}\n\nThis card has moved on since; nothing was changed.`.slice(0, 4000) }];
  }
  if (visit.person !== binding.approver) return [{ kind: "ack", text: `Only ${visit.person} chooses here.` }];
  if (repos === null) return [{ kind: "ack", text: "Couldn't check your projects just now. Try again in a moment." }];
  const chosen = chooseFlowCard(store, { card: choice.card, entry: choice.entry, choice: choice.choice, label: choice.label, note: null, actor: binding.approver, where: "Telegram", repos }, now);
  if (!chosen.ok) return [{ kind: "ack", text: chosen.message.slice(0, 190) }];
  store.retireFlowChoices(choice.card, choice.entry, now);
  return [{ kind: "ack", text: choice.label.slice(0, 190) }, { kind: "edit", text: `${message.text}\n\n✅ You chose “${choice.label}”. ${chosen.said}`.slice(0, 4000) }];
}

export type FlowTapEffect =
  | { kind: "ack"; text: string }
  | { kind: "edit"; text: string }
  | { kind: "prompt"; text: string; placeholder: string; prompt: Omit<TelegramFlowPrompt, "messageId"> };

/** A tapped flow button, applied inside the update's transaction. */
export function applyFlowTap(store: Store, binding: TelegramBinding, action: TelegramFlowAction, message: { chatId: string; messageId: string; text: string }, repos: readonly string[] | null, now: Date): FlowTapEffect[] {
  if (action.consumedAt !== null || action.expiresAt <= now.toISOString()) return [{ kind: "ack", text: "That was already decided, or these buttons are too old." }];
  const waiting = flowDecisionAt(store, action.card, action.entry);
  if (waiting === null) return [{ kind: "ack", text: "That card has moved on since; nothing was changed." }];
  const decider = deciderOf(waiting.stage, waiting.flow);
  if (decider !== null && decider !== binding.approver) return [{ kind: "ack", text: `Only ${decider} decides here.` }];
  if (action.action === "approve") {
    if (repos === null) return [{ kind: "ack", text: "Couldn't check your projects just now. Try again in a moment." }];
    const decided = decideFlowCard(store, { card: waiting.card.id, decision: "approve", note: null, actor: binding.approver, repos, entry: action.entry }, now);
    if (!decided.ok) return [{ kind: "ack", text: decided.message.slice(0, 190) }];
    store.retireTelegramFlowVisit(action.card, action.entry, now);
    return [{ kind: "ack", text: "Approved" }, { kind: "edit", text: `${message.text}\n\n✅ You approved it. ${decided.said}`.slice(0, 4000) }];
  }
  const prompt = { chatId: binding.chatId, binding: binding.id, card: action.card, entry: action.entry, mode: action.action };
  if (action.action === "edit") {
    return [{ kind: "ack", text: "Send your version" }, { kind: "prompt", prompt, placeholder: "Your version of the draft",
      text: `Send your version of the draft for “${waiting.card.title}” as a reply to this message. It replaces the draft, and comes back here for you to approve.` }];
  }
  const back = waiting.stage.onFail === null ? "the zone before" : titleOf(waiting, waiting.stage.onFail);
  return [{ kind: "ack", text: "What should change?" }, { kind: "prompt", prompt, placeholder: "What should change",
    text: `What should change on “${waiting.card.title}”? Reply to this message and it goes back to ${back} with your note.` }];
}

const titleOf = (waiting: Waiting, id: string) => flowDefinitionOf(waiting.flow)?.stages.find(one => one.id === id)?.title ?? id;

export type FlowReplyEffect =
  | { kind: "say"; text: string }
  /** The edited draft, back for a decision: send it with these buttons, then place them. */
  | { kind: "decide"; text: string; keyboard: InlineButton[][]; tokens: string[] };

/** A reply to an Edit or Send back prompt, applied inside the update's transaction. */
export function applyFlowReply(store: Store, binding: TelegramBinding, prompt: TelegramFlowPrompt, text: string, repos: readonly string[] | null, now: Date): FlowReplyEffect[] {
  if (prompt.binding !== binding.id) return [];
  // A reply to a choice's message (flow-send.ts): the note for where replies go.
  const choosing = flowChoiceAt(store, prompt.card, prompt.entry);
  if (choosing !== null) {
    if (choosing.person !== binding.approver) return [{ kind: "say", text: `Only ${choosing.person} chooses here.` }];
    if (text.trim() === "") return [{ kind: "say", text: "Say what you'd change." }];
    if (repos === null) return [{ kind: "say", text: "Couldn't check your projects just now. Reply again in a moment." }];
    const chosen = chooseFlowCard(store, { card: prompt.card, entry: prompt.entry, choice: null, note: text.trim(), actor: binding.approver, where: "Telegram", repos }, now);
    if (!chosen.ok) return [{ kind: "say", text: chosen.message }];
    store.retireFlowChoices(prompt.card, prompt.entry, now);
    return [{ kind: "say", text: `↩️ ${chosen.said}` }];
  }
  const waiting = flowDecisionAt(store, prompt.card, prompt.entry);
  if (waiting === null) { store.retireTelegramFlowVisit(prompt.card, prompt.entry, now); return [{ kind: "say", text: "That card has moved on since; nothing was changed." }]; }
  const said = text.trim();
  if (said === "") return [{ kind: "say", text: prompt.mode === "edit" ? "Send the text itself as a reply." : "Say what should change." }];
  if (prompt.mode === "edit") {
    if (waiting.draft === null) return [{ kind: "say", text: "This decision has no draft to edit." }];
    if (said.length > DRAFT_LIMIT) return [{ kind: "say", text: `That's ${said.length.toLocaleString("en-US")} characters. Keep it to ${DRAFT_LIMIT.toLocaleString("en-US")}, or change it in Toolroll.` }];
    const kept = keptDraft(said);
    store.updateFlowCard(waiting.card.id, { outputs: { ...waiting.card.outputs, [waiting.draft.id]: kept } }, now);
    store.addFlowComment({ card: waiting.card.id, author: binding.approver, body: "Edited the draft in Telegram.", mentions: [] }, now);
    store.retireTelegramFlowVisit(prompt.card, prompt.entry, now);
    const fresh = flowDecisionAt(store, prompt.card, prompt.entry)!;
    const buttons = flowButtons(store, binding, fresh, now);
    return [{ kind: "decide", keyboard: buttons.keyboard, tokens: buttons.tokens,
      text: `${waiting.flow.name}: your version of the draft for “${waiting.card.title}”\n\n${kept}\n\nApprove to send it as written.` }];
  }
  // A note over its limit is refused with the limit, never cut.
  if (said.length > LIMITS.note) return [{ kind: "say", text: `That's ${said.length.toLocaleString("en-US")} characters. Keep the note to ${LIMITS.note.toLocaleString("en-US")}, or send it back in Toolroll.` }];
  if (repos === null) return [{ kind: "say", text: "Couldn't check your projects just now. Reply again in a moment." }];
  const decided = decideFlowCard(store, { card: waiting.card.id, decision: "send-back", note: said, actor: binding.approver, repos, entry: prompt.entry }, now);
  if (!decided.ok) return [{ kind: "say", text: decided.message }];
  store.retireTelegramFlowVisit(prompt.card, prompt.entry, now);
  return [{ kind: "say", text: `↩️ ${decided.said}` }];
}
