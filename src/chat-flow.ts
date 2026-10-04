/**
 * Flow decisions in Slack, Discord and Teams (v88): the Approve / Edit /
 * Send back that Telegram has (telegram-flow.ts), on the notice itself.
 *
 * - The notice carries the draft (split over as many parts as it needs, so
 *   what is approved is what was read) and the buttons on its last part.
 * - Approve decides through the same door as the console (decideFlowCard),
 *   as the paired person, for exactly the visit the notice was about, then
 *   repaints the notice with what happened and no buttons.
 * - Edit and Send back open a prompt: the person's next message in their
 *   chat with Toolroll is the new draft (which comes back with fresh
 *   buttons) or the note. "cancel" leaves it, and a prompt lapses after
 *   30 minutes. Chat apps can't all name the message a reply answers, so
 *   the prompt says plainly what the next message does.
 *
 * Every button is one opaque token for one visit of one card, on the part it
 * rides: a tap on any other message, from anyone but the paired person, or
 * for a card that moved on, changes nothing.
 *
 * A "Send to me" visit (flow-send.ts) is one notice with its links; a "Person
 * chooses" visit is the same with the zone's own options as buttons. Instead
 * of a tap, a reply in the notice's thread is the note for where replies go;
 * the first other message in their chat is asked about once ("Use this as
 * your note?"), and everything else goes to the lead as usual. Choices are
 * made through chooseFlowCard, by that person alone, for exactly that visit,
 * and spend that visit's buttons in every chat app.
 */
import { LIMITS } from "./decision.js";
import { keptDraft } from "./flow-draft.js";
import { decideFlowCard, flowCardHref, flowDefinitionOf } from "./flow-engine.js";
import { chooseFlowCard, flowChoiceAt, flowSendPaths, FLOW_CHOOSE_KEY, FLOW_SEND_KEY, readFlowSend } from "./flow-send.js";
import { deciderOf, replyTarget } from "./flows.js";
import { MATE_MESSAGE_MAX_CHARS } from "./mate.js";
import { verifyApproverStanding } from "./principal.js";
import { chatHash, type ChatBinding, type ChatContent, type ChatEvent, type ChatState } from "./chat-delivery-state.js";
import type { Store } from "./store.js";
import { FLOW_DECIDE_KEY, flowDecisionAt } from "./telegram-flow.js";
import { phoneCommand } from "./telegram-status.js";

export type ChatFlowAction = "approve" | "edit" | "send-back";
export const CHAT_FLOW_LABELS: Record<ChatFlowAction, string> = { approve: "Approve", edit: "Edit", "send-back": "Send back" };
const PART_CHARS = 2800;
const PROMPT_MS = 30 * 60_000;
const DRAFT_LIMIT = 4000;

/** Words kept as written, line breaks and all; only control characters go. */
export function chatFlowText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Split on line breaks where it can, so a draft reads as written. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > PART_CHARS) {
    const cut = rest.lastIndexOf("\n", PART_CHARS);
    let at = cut > PART_CHARS / 2 ? cut : PART_CHARS;
    if (/[\uD800-\uDBFF]/.test(rest[at - 1]!)) at -= 1;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
}

/** The buttons a visit gets: Approve always, Edit when there is a draft, Send back when the zone sends back somewhere. */
function actionsFor(waiting: NonNullable<ReturnType<typeof flowDecisionAt>>): ChatFlowAction[] {
  return ["approve",
    ...(waiting.draft !== null && waiting.card.outputs[waiting.draft.id] !== undefined ? ["edit" as const] : []),
    ...(waiting.stage.onFail !== null ? ["send-back" as const] : [])];
}

function decisionParts(text: string, visit: { card: number; entry: number; actions: ChatFlowAction[] }, link: { label: string; path: string } | null): ChatContent[] {
  const all = pieces(chatFlowText(text));
  return all.map((piece, index): ChatContent => index < all.length - 1 ? { text: piece } : { text: piece, flow: visit, ...(link === null ? {} : { link }) });
}

/** A sent visit's links as a part's buttons: the first as its link, the rest beside it. */
function sendLinks(paths: { label: string; path: string }[]): Pick<ChatContent, "link" | "also"> {
  return { ...(paths[0] === undefined ? {} : { link: paths[0] }), ...(paths.length > 1 ? { also: paths.slice(1) } : {}) };
}

/** A "Send to me" notice as chat parts: what was done, then its links; null when it isn't one. */
export function flowSendParts(store: Store, notification: { dedupeKey: string; subject: string; body: string }): ChatContent[] | null {
  const visit = FLOW_SEND_KEY.exec(notification.dedupeKey);
  const kept = visit === null ? null : store.flowSend(Number(visit[1]), Number(visit[2]));
  const content = kept === null ? null : readFlowSend(kept.contentJson);
  if (content === null) return null;
  const all = pieces(chatFlowText(`${notification.subject}\n\n${notification.body}`));
  return all.map((piece, index): ChatContent => index < all.length - 1 ? { text: piece } : { text: piece, ...sendLinks(flowSendPaths(content)) });
}

/**
 * A "flow-decision" notice as chat parts, or null when it isn't one (or the
 * card has already moved on, and there is nothing left to decide).
 */
export function flowDecisionParts(store: Store, notification: { dedupeKey: string; subject: string; body: string; link: string | null }): ChatContent[] | null {
  const choose = FLOW_CHOOSE_KEY.exec(notification.dedupeKey);
  if (choose !== null) {
    const visit = flowChoiceAt(store, Number(choose[1]), Number(choose[2]));
    const kept = visit === null ? null : store.flowSend(visit.card.id, visit.card.entry);
    const content = kept === null ? null : readFlowSend(kept.contentJson);
    if (visit === null || content === null) return null;
    const options = (content.options ?? []).filter(one => visit.stage.options?.[one.choice]?.label === one.label);
    const all = pieces(chatFlowText(`${notification.subject}\n\n${notification.body}`));
    return all.map((piece, index): ChatContent => index < all.length - 1 ? { text: piece }
      : { text: piece, choose: { card: visit.card.id, entry: visit.card.entry, options }, ...sendLinks(flowSendPaths(content)) });
  }
  const visit = FLOW_DECIDE_KEY.exec(notification.dedupeKey);
  const waiting = visit === null ? null : flowDecisionAt(store, Number(visit[1]), Number(visit[2]));
  if (waiting === null) return null;
  return decisionParts(`${notification.subject}\n\n${notification.body}`, { card: waiting.card.id, entry: waiting.card.entry, actions: actionsFor(waiting) },
    notification.link === null ? null : { label: "Open", path: notification.link });
}

/** The live buttons on one part, in the order they were minted: a decision's, a choice's options in their order, or
 * "Use this as your note?" Yes / No. `key` is unique on the part (Slack names each button by it). */
export function chatFlowButtons(state: ChatState, part: number, now: Date): Array<{ token: string; action: ChatFlowAction | "choose" | "note"; label: string; key: string }> {
  const decide = (state.prepare("SELECT token,action FROM chat_flow_action WHERE part=? AND consumed IS NULL AND expires>? ORDER BY rowid").all(part, now.toISOString()) as Array<{ token: string; action: ChatFlowAction }>)
    .map(one => ({ token: String(one.token), action: one.action, label: CHAT_FLOW_LABELS[one.action], key: one.action.replace("-", "_") }));
  const choose = (state.prepare("SELECT token,choice,label FROM chat_flow_choice WHERE part=? AND consumed IS NULL AND expires>? ORDER BY choice").all(part, now.toISOString()) as Array<{ token: string; choice: number; label: string }>)
    .map(one => ({ token: String(one.token), action: "choose" as const, label: String(one.label), key: `choose_${Number(one.choice)}` }));
  const note = (state.prepare("SELECT token,answer FROM chat_flow_note WHERE part=? AND consumed IS NULL AND expires>? ORDER BY answer DESC").all(part, now.toISOString()) as Array<{ token: string; answer: "yes" | "no" }>)
    .map(one => ({ token: String(one.token), action: "note" as const, label: one.answer === "yes" ? "Yes" : "No", key: `note_${one.answer}` }));
  return [...decide, ...choose, ...note];
}

const retire = (state: ChatState, card: number, entry: number, now: Date): void => {
  state.prepare("UPDATE chat_flow_action SET consumed=? WHERE card=? AND entry=? AND consumed IS NULL").run(now.toISOString(), card, entry);
  state.prepare("UPDATE chat_flow_choice SET consumed=? WHERE card=? AND entry=? AND consumed IS NULL").run(now.toISOString(), card, entry);
  state.prepare("UPDATE chat_flow_prompt SET consumed=? WHERE card=? AND entry=? AND consumed IS NULL").run(now.toISOString(), card, entry);
};

/** Show the tapped notice again with what happened, and without its buttons. */
function repaint(state: ChatState, part: number, event: ChatEvent, line: string): void {
  const row = state.prepare("SELECT payload FROM chat_part WHERE id=?").get(part);
  const before = row === undefined ? { text: "" } : JSON.parse(String(row["payload"])) as ChatContent;
  const content: ChatContent = { text: `${before.text}\n\n${line}`.slice(0, PART_CHARS + 400), edit: event.ts, ...(before.link === undefined ? {} : { link: before.link }), ...(before.channel === undefined ? {} : { channel: before.channel }) };
  state.prepare("UPDATE chat_part SET payload=?,state='pending',next_at=NULL WHERE id=?").run(JSON.stringify(content), part);
}

/**
 * A tapped flow button, inside the action's transaction. false when the
 * token isn't a flow button (the caller looks for a proposal's); otherwise
 * the event is finished and anything to say is planned on it.
 */
export function applyChatFlowTap(options: { store: Store; state: ChatState; label: string }, event: ChatEvent, binding: ChatBinding, token: string, repos: readonly string[], now: Date): boolean {
  const { store, state } = options;
  const action = state.prepare("SELECT a.*,p.message,e.binding AS owner,e.channel FROM chat_flow_action a JOIN chat_part p ON p.id=a.part JOIN chat_event e ON e.id=p.event WHERE a.token=?").get(token);
  if (action === undefined) return applyChatChoiceTap(options, event, binding, token, repos, now) || applyChatNoteTap(options, event, binding, token, repos, now);
  const say = (text: string) => state.plan(event.id, [{ text }], now);
  // Bound to the person, the chat and the exact message the button rode.
  if (Number(action["owner"]) !== binding.id || action["channel"] !== event.channel || action["message"] !== event.ts) { say("That button expired or was already used. Ask for the current state before trying again."); return true; }
  if (action["consumed"] !== null || String(action["expires"]) <= now.toISOString()) { say("That was already decided, or these buttons are too old."); return true; }
  const card = Number(action["card"]), entry = Number(action["entry"]), part = Number(action["part"]);
  const waiting = flowDecisionAt(store, card, entry);
  if (waiting === null) {
    retire(state, card, entry, now);
    repaint(state, part, event, "This card has moved on since; nothing was changed.");
    state.finish(event.id);
    return true;
  }
  const decider = deciderOf(waiting.stage, waiting.flow);
  if (decider !== null && decider !== binding.approver) { say(`Only ${decider} decides here.`); return true; }
  if (!verifyApproverStanding(store, binding.approver, binding.generation, repos).ok) { state.finish(event.id, true); return true; }
  const kind = String(action["action"]) as ChatFlowAction;
  if (kind === "approve") {
    const decided = decideFlowCard(store, { card, decision: "approve", note: null, actor: binding.approver, repos, entry }, now);
    if (!decided.ok) { say(decided.message); return true; }
    retire(state, card, entry, now);
    store.retireTelegramFlowVisit(card, entry, now);
    repaint(state, part, event, `✅ You approved it. ${decided.said}`);
    state.finish(event.id);
    return true;
  }
  // One open prompt per person: the newest question is the one the next message answers.
  state.prepare("UPDATE chat_flow_prompt SET consumed=? WHERE binding=? AND consumed IS NULL").run(now.toISOString(), binding.id);
  state.prepare("UPDATE chat_question_prompt SET consumed=? WHERE binding=? AND consumed IS NULL").run(now.toISOString(), binding.id);
  state.prepare("INSERT INTO chat_flow_prompt(binding,card,entry,mode,created,expires) VALUES(?,?,?,?,?,?)")
    .run(binding.id, card, entry, kind, now.toISOString(), new Date(now.getTime() + PROMPT_MS).toISOString());
  const back = waiting.stage.onFail === null ? "the zone before" : flowDefinitionOf(waiting.flow)?.stages.find(one => one.id === waiting.stage.onFail)?.title ?? waiting.stage.onFail;
  say(kind === "edit"
    ? `Send your version of the draft for “${waiting.card.title}” as your next message here. It replaces the draft and comes back here for you to approve. Send “cancel” to leave it as it is.`
    : `What should change on “${waiting.card.title}”? Your next message here is the note, and the card goes back to ${back} with it. Send “cancel” to leave it where it is.`);
  return true;
}

/** A tapped option of a "Person chooses" notice; false when the token isn't one. */
function applyChatChoiceTap(options: { store: Store; state: ChatState; label: string }, event: ChatEvent, binding: ChatBinding, token: string, repos: readonly string[], now: Date): boolean {
  const { store, state } = options;
  const tapped = state.prepare("SELECT c.*,p.message,e.binding AS owner,e.channel FROM chat_flow_choice c JOIN chat_part p ON p.id=c.part JOIN chat_event e ON e.id=p.event WHERE c.token=?").get(token);
  if (tapped === undefined) return false;
  const say = (text: string) => state.plan(event.id, [{ text }], now);
  // Bound to the person, the chat and the exact message the button rode.
  if (Number(tapped["owner"]) !== binding.id || tapped["channel"] !== event.channel || tapped["message"] !== event.ts) { say("That button expired or was already used. Ask for the current state before trying again."); return true; }
  if (tapped["consumed"] !== null || String(tapped["expires"]) <= now.toISOString()) { say("That was already chosen, or these buttons are too old."); return true; }
  const card = Number(tapped["card"]), entry = Number(tapped["entry"]), part = Number(tapped["part"]);
  const visit = flowChoiceAt(store, card, entry);
  if (visit === null) {
    retire(state, card, entry, now);
    repaint(state, part, event, "This card has moved on since; nothing was changed.");
    state.finish(event.id);
    return true;
  }
  if (visit.person !== binding.approver) { say(`Only ${visit.person} chooses here.`); return true; }
  if (!verifyApproverStanding(store, binding.approver, binding.generation, repos).ok) { state.finish(event.id, true); return true; }
  const label = String(tapped["label"]);
  const chosen = chooseFlowCard(store, { card, entry, choice: Number(tapped["choice"]), label, note: null, actor: binding.approver, where: options.label, repos }, now);
  if (!chosen.ok) { say(chosen.message); return true; }
  retire(state, card, entry, now);
  store.retireFlowChoices(card, entry, now);
  repaint(state, part, event, `✅ You chose “${label}”. ${chosen.said}`);
  state.finish(event.id);
  return true;
}

/** A reply that is the note for where a choice's replies go; `say` answers on the message it came from. */
function replyAsNote(options: { store: Store; state: ChatState; label: string }, binding: ChatBinding, said: string, cutShort: boolean, visit: { card: number; entry: number }, repos: readonly string[], now: Date): { ok: true; said: string } | { ok: false; said: string } | null {
  const { store } = options;
  if (said === "") return { ok: false, said: "Say what you'd change." };
  if (cutShort || said.length > LIMITS.note) return { ok: false, said: `That's too long to take from here. Keep it to ${Math.min(LIMITS.note, MATE_MESSAGE_MAX_CHARS).toLocaleString("en-US")} characters, or reply in Toolroll.` };
  if (!verifyApproverStanding(store, binding.approver, binding.generation, repos).ok) return null;
  const chosen = chooseFlowCard(store, { card: visit.card, entry: visit.entry, choice: null, note: said, actor: binding.approver, where: options.label, repos }, now);
  return chosen.ok ? { ok: true, said: chosen.said } : { ok: false, said: chosen.message };
}

/** The choice a part's message carries, by the message any of its parts was posted as (a long notice is several). */
function choiceOnMessage(state: ChatState, binding: ChatBinding, channel: string, message: string): { card: number; entry: number; live: boolean } | null {
  const row = state.prepare(`SELECT c.card,c.entry,MAX(c.consumed IS NULL) AS live FROM chat_part p JOIN chat_event e ON e.id=p.event
    JOIN chat_part q ON q.event=p.event JOIN chat_flow_choice c ON c.part=q.id WHERE e.binding=? AND e.channel=? AND p.message=? GROUP BY c.card,c.entry ORDER BY MAX(c.rowid) DESC LIMIT 1`)
    .get(binding.id, channel, message);
  return row === undefined ? null : { card: Number(row["card"]), entry: Number(row["entry"]), live: Number(row["live"]) === 1 };
}

/**
 * A message in the person's own chat while one of their choices waits. Only a reply in the Choose notice's thread (Slack,
 * Discord) is the note. Any other message there is the lead's, except the first one after a choice that takes replies:
 * that one is asked about, once — "Use this as your note?" — and only Yes makes it the note (No passes it on to the lead).
 * false when the message isn't about a choice at all.
 */
export function answerChoiceMessage(options: { store: Store; state: ChatState; label: string }, event: ChatEvent, binding: ChatBinding, input: { text: string; originalLength?: number; lead?: boolean }, now: Date, repos: readonly string[]): boolean {
  const { store, state } = options;
  if (event.kind !== "message" || event.channel !== binding.channel || input.lead === true) return false;
  const say = (text: string) => state.plan(event.id, [{ text }], now);
  const said = input.text.trim();
  return store.transact(() => {
    if (event.thread !== "" && event.thread !== event.ts) {
      const on = choiceOnMessage(state, binding, event.channel, event.thread);
      if (on === null) return false;
      const visit = flowChoiceAt(store, on.card, on.entry);
      if (visit === null || !on.live) { say("That choice was already made, or the card moved on; nothing was changed."); return true; }
      if (visit.person !== binding.approver) { say(`Only ${visit.person} chooses here.`); return true; }
      if (replyTarget(visit.stage) === null) { say("This step takes one of its options. Tap one above."); return true; }
      const done = replyAsNote(options, binding, said, (input.originalLength ?? 0) > input.text.length, on, repos, now);
      if (done === null) state.finish(event.id, true);
      else say(done.ok ? `↩️ ${done.said}` : done.said);
      return true;
    }
    if (said === "" || phoneCommand(said) !== null) return false;
    // The newest choice of theirs still open here that takes a reply and hasn't asked yet.
    const open = state.prepare(`SELECT DISTINCT c.card,c.entry FROM chat_flow_choice c JOIN chat_part p ON p.id=c.part JOIN chat_event e ON e.id=p.event
      WHERE e.binding=? AND c.consumed IS NULL AND c.expires>? AND NOT EXISTS (SELECT 1 FROM chat_flow_note n WHERE n.card=c.card AND n.entry=c.entry) ORDER BY c.rowid DESC`)
      .all(binding.id, now.toISOString()) as Array<{ card: number; entry: number }>;
    for (const one of open) {
      const visit = flowChoiceAt(store, Number(one.card), Number(one.entry));
      const target = visit === null ? null : replyTarget(visit.stage);
      if (visit === null || target === null || visit.person !== binding.approver) continue;
      const to = visit.definition.stages.find(stage => stage.id === target)?.title ?? target;
      state.plan(event.id, [{ text: `Use this as your note on “${visit.card.title}”?\nYes sends it to ${to}. No passes it to the lead.`,
        note: { card: visit.card.id, entry: visit.card.entry, held: event.id } }], now);
      // What it said is kept beside its question until answered: the event's own copy is cleared once it is handled.
      state.prepare("UPDATE chat_flow_note SET words=? WHERE held=?").run(JSON.stringify({ text: input.text, ...(input.originalLength === undefined ? {} : { originalLength: input.originalLength }) }), event.id);
      return true;
    }
    return false;
  });
}

/** Yes or No to "Use this as your note?"; false when the token isn't one. */
function applyChatNoteTap(options: { store: Store; state: ChatState; label: string }, event: ChatEvent, binding: ChatBinding, token: string, repos: readonly string[], now: Date): boolean {
  const { store, state } = options;
  const tapped = state.prepare("SELECT n.*,p.message,e.binding AS owner,e.channel FROM chat_flow_note n JOIN chat_part p ON p.id=n.part JOIN chat_event e ON e.id=p.event WHERE n.token=?").get(token);
  if (tapped === undefined) return false;
  const say = (text: string) => state.plan(event.id, [{ text }], now);
  if (Number(tapped["owner"]) !== binding.id || tapped["channel"] !== event.channel || tapped["message"] !== event.ts) { say("That button expired or was already used. Ask for the current state before trying again."); return true; }
  const part = Number(tapped["part"]), card = Number(tapped["card"]), entry = Number(tapped["entry"]);
  if (tapped["consumed"] !== null || String(tapped["expires"]) <= now.toISOString()) {
    repaint(state, part, event, "That choice was already made, or the card moved on; nothing was changed.");
    state.finish(event.id);
    return true;
  }
  state.prepare("UPDATE chat_flow_note SET consumed=?,words=NULL WHERE part=?").run(now.toISOString(), part);
  const held = state.event(String(tapped["held"]));
  const words = typeof tapped["words"] === "string" ? JSON.parse(tapped["words"]) as { text?: unknown; originalLength?: unknown } : null;
  if (held === null || words === null || typeof words.text !== "string") { repaint(state, part, event, "That message is no longer kept; nothing was changed."); state.finish(event.id); return true; }
  if (tapped["answer"] === "no") {
    // Passed on as the message it was, to the lead, once.
    state.enqueue({ id: chatHash(`${held.id}:lead`), installation: held.installation, binding: held.binding, kind: "message", channel: held.channel, member: held.member,
      ts: held.ts, thread: held.thread, payload: JSON.stringify({ ...words, lead: true }), created: now.toISOString() });
    repaint(state, part, event, "Passed to the lead.");
    state.finish(event.id);
    return true;
  }
  if (flowChoiceAt(store, card, entry) === null) { repaint(state, part, event, "That choice was already made, or the card moved on; nothing was changed."); state.finish(event.id); return true; }
  const done = replyAsNote(options, binding, words.text.trim(), typeof words.originalLength === "number" && words.originalLength > words.text.length, { card, entry }, repos, now);
  if (done === null) { state.finish(event.id, true); return true; }
  repaint(state, part, event, done.ok ? `↩️ ${done.said}` : done.said);
  state.finish(event.id);
  return true;
}

/**
 * A message from the person while a prompt is open: the new draft or the
 * note. false when no prompt is open (the message goes on as usual).
 */
export function answerChatFlowPrompt(options: { store: Store; state: ChatState; label: string }, event: ChatEvent, binding: ChatBinding, input: { text: string; originalLength?: number }, repos: readonly string[], now: Date): boolean {
  const { store, state } = options;
  if (event.channel !== binding.channel) return false;
  return store.transact(() => {
    const prompt = state.prepare("SELECT * FROM chat_flow_prompt WHERE binding=? AND consumed IS NULL AND expires>? ORDER BY id DESC LIMIT 1").get(binding.id, now.toISOString());
    if (prompt === undefined) return false;
    const id = Number(prompt["id"]), card = Number(prompt["card"]), entry = Number(prompt["entry"]), mode = String(prompt["mode"]);
    const say = (text: string) => state.plan(event.id, [{ text }], now);
    const close = () => state.prepare("UPDATE chat_flow_prompt SET consumed=? WHERE id=?").run(now.toISOString(), id);
    const said = input.text.trim();
    if (/^cancel\.?$/i.test(said)) { close(); say(mode === "edit" ? "Left the draft as it is. The buttons on the notice still work." : "Left it where it is. The buttons on the notice still work."); return true; }
    const waiting = flowDecisionAt(store, card, entry);
    if (waiting === null) { retire(state, card, entry, now); say("That card has moved on since; nothing was changed."); return true; }
    if (said === "") { say(mode === "edit" ? "Send the text itself, or “cancel”." : "Say what should change, or send “cancel”."); return true; }
    // A long message arrives cut short (the chat keeps its first 2,000 characters): never take part of one as the draft.
    // An edit is a draft (DRAFT_LIMIT); a send-back is a note (LIMITS.note). Over it is refused with the limit, never cut.
    const cutShort = (input.originalLength ?? 0) > input.text.length;
    const most = mode === "edit" ? DRAFT_LIMIT : LIMITS.note;
    const limit = cutShort ? Math.min(MATE_MESSAGE_MAX_CHARS, most) : most;
    if (cutShort || said.length > most) { say(`That's too long to take from here. Keep it to ${limit.toLocaleString("en-US")} characters, or ${mode === "edit" ? "change it" : "send it back"} in Toolroll.`); return true; }
    if (!verifyApproverStanding(store, binding.approver, binding.generation, repos).ok) { close(); state.finish(event.id, true); return true; }
    if (mode === "edit") {
      if (waiting.draft === null) { close(); say("This decision has no draft to edit."); return true; }
      const kept = keptDraft(said);
      store.updateFlowCard(card, { outputs: { ...waiting.card.outputs, [waiting.draft.id]: kept } }, now);
      store.addFlowComment({ card, author: binding.approver, body: `Edited the draft in ${options.label}.`, mentions: [] }, now);
      retire(state, card, entry, now);
      store.retireTelegramFlowVisit(card, entry, now);
      const fresh = flowDecisionAt(store, card, entry)!;
      state.plan(event.id, decisionParts(`${waiting.flow.name}: your version of the draft for “${waiting.card.title}”\n\n${kept}\n\nApprove to send it as written.`,
        { card, entry, actions: actionsFor(fresh) }, { label: "Open", path: flowCardHref(waiting.flow.id, card) }), now);
      return true;
    }
    const decided = decideFlowCard(store, { card, decision: "send-back", note: said, actor: binding.approver, repos, entry }, now);
    if (!decided.ok) { close(); say(decided.message); return true; }
    retire(state, card, entry, now);
    store.retireTelegramFlowVisit(card, entry, now);
    say(`↩️ ${decided.said}`);
    return true;
  });
}
