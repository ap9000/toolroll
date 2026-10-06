/**
 * Chat channels as inboxes (v89): a Slack, Discord or Teams channel feeds a
 * flow.
 *
 * - Connecting happens in the channel itself: a paired approver sends
 *   "flow 12" (or "flow off"), which proves the channel is one they are in
 *   and that the flow is one they can change. One channel feeds one flow; a
 *   channel that follows a team conversation is left as it is.
 * - From then on every new message there — from anyone the app lets the bot
 *   see — is a card in that flow, and the bot says so in the message's
 *   thread. A reply in that thread joins the card's discussion.
 * - The card remembers where it came from, so an Update zone can answer in
 *   that same thread, through the chat of the person who connected it.
 *
 * Nothing here gives a message any authority: a card's work waits for the
 * usual approvals, and text that looks like a key never becomes a card.
 */
import { flowCardHref, flowDefinitionOf } from "./flow-engine.js";
import { addTriggerCard, CHAT_APP_NAMES, triggerConfigOf, type ChatApp } from "./flow-triggers.js";
import { ChatState, chatHash, type ChatBinding } from "./chat-delivery-state.js";
import type { FlowCardSource, FlowTriggerRow, Store } from "./store.js";

/** "flow 12" or "flow off", after any mention of the bot; Telegram's "/flow 12" or "/flow@bot 12" too. */
export const FLOW_WORDS = /^(?:<@[^>]+>\s*)?\/?flow(?:@[A-Za-z0-9_]{1,64})?\s+(off|[1-9][0-9]{0,9})\s*$/i;
const TITLE_CHARS = 120;

/** A channel's own id: Teams puts the thread's message id on the end of a channel conversation. */
export const channelOf = (app: ChatApp, conversation: string): string => app === "teams" ? conversation.replace(/;messageid=[0-9]+$/, "") : conversation;

/** The flow a channel feeds, if it feeds one. */
export function watchedChannel(store: Store, app: ChatApp, installation: string, conversation: string): FlowTriggerRow | null {
  return store.chatTriggerFor(app, installation, channelOf(app, conversation));
}

/** What a receiver needs to know about a channel message: whether the channel feeds a flow, and whether these are the words that connect one. */
export function channelInbox(store: Store, app: ChatApp, installation: string, conversation: string, text: string): { watched: boolean; command: boolean } {
  return { watched: watchedChannel(store, app, installation, conversation) !== null, command: FLOW_WORDS.test(text.trim()) };
}

/** "flow 12" / "flow off" from a paired approver in a channel: connect it to the flow, or stop it feeding one. */
export function connectChannel(store: Store, input: { app: ChatApp; installation: string; conversation: string; binding: Pick<ChatBinding, "id" | "approver">; text: string; repos: readonly string[]; followsConversation: boolean }, now: Date): string {
  const words = FLOW_WORDS.exec(input.text.trim());
  if (words === null) return "Send “flow” and a flow's number, like “flow 12”, or “flow off”.";
  const chat = channelOf(input.app, input.conversation);
  const current = store.chatTriggerFor(input.app, input.installation, chat);
  const name = CHAT_APP_NAMES[input.app];
  if (words[1]!.toLowerCase() === "off") {
    if (current === null) return "This channel doesn't feed a flow.";
    const flow = store.getFlow(current.flow);
    if (flow !== null && !input.repos.includes(flow.repo)) return "Only someone who can change that flow can stop this channel feeding it.";
    store.updateFlowTrigger(current.id, { state: "removed", lastAt: now.toISOString(), lastOutcome: `Disconnected in ${name} by ${input.binding.approver}.` }, now);
    return `This channel no longer feeds ${flow?.name ?? "its flow"}.`;
  }
  if (input.followsConversation) return "This channel follows a team conversation. Send “team off” first to make it feed a flow instead.";
  const flow = store.getFlow(Number(words[1]));
  if (flow === null || flow.state !== "active" || !input.repos.includes(flow.repo) || flowDefinitionOf(flow) === null) return `There's no flow ${words[1]} you can change. The number is in the flow's address: /flows/12.`;
  if (current !== null && current.flow === flow.id) return `This channel already feeds ${flow.name}.`;
  store.transact(() => {
    if (current !== null) store.updateFlowTrigger(current.id, { state: "removed", lastAt: now.toISOString(), lastOutcome: `Moved to ${flow.name} by ${input.binding.approver}.` }, now);
    const id = store.addFlowTrigger({ flow: flow.id, kind: "chat", hookHash: null, cursor: null, nextAt: null, by: input.binding.approver,
      configJson: JSON.stringify({ kind: "chat", app: input.app, installation: input.installation, chat, binding: input.binding.id, zone: null }) }, now);
    store.updateFlowTrigger(id, { lastAt: now.toISOString(), lastOutcome: `Connected in ${name} by ${input.binding.approver}.` }, now);
  });
  return `This channel now feeds ${flow.name}: each new message here becomes a card, and replies in its thread join the card's discussion. Send “flow off” to stop.`;
}

/** A message's words as a card: the first line is the title, all of it the details when there's more. */
function cardWords(text: string): { title: string; description: string | null } {
  const clean = text.replace(/<@[A-Z0-9]+>/g, "").replace(/\r\n?/g, "\n").trim();
  const first = clean.split("\n")[0]!.trim();
  const title = first.length > TITLE_CHARS ? `${first.slice(0, TITLE_CHARS - 1).trimEnd()}…` : first;
  return { title: title || "Message", description: clean === title ? null : clean.slice(0, 4000) };
}

/**
 * A message in a channel that feeds a flow: a new card (and what to say in
 * its thread), a reply that joins a card's discussion (nothing to say), or
 * why it was left out.
 */
export function takeChannelMessage(store: Store, trigger: FlowTriggerRow, message: { app: ChatApp; conversation: string; ts: string; thread: string; text: string; who: string }, now: Date): { said: string | null; link?: { label: string; path: string } } {
  const config = triggerConfigOf(trigger);
  if (config?.kind !== "chat") return { said: null };
  const name = CHAT_APP_NAMES[message.app];
  if (message.text.trim() === "") return { said: null };
  if (message.thread !== message.ts) {
    // A reply in the thread of a message that became a card: it joins that card's discussion.
    const card = store.flowTriggerCard(trigger.id, `msg:${message.thread}`);
    if (card !== null && store.getFlowCard(card)?.state === "active") store.addFlowComment({ card, author: `${message.who} (${name})`.slice(0, 64), body: message.text.slice(0, 2000), mentions: [] }, now);
    return { said: null };
  }
  const words = cardWords(message.text);
  const source: FlowCardSource = { kind: "chat", label: `${name} message`, url: null,
    chat: { app: message.app, installation: config.installation, chat: config.chat, conversation: message.conversation, thread: message.ts, binding: config.binding } };
  const made = addTriggerCard(store, trigger, { key: `msg:${message.ts}`, title: words.title, description: words.description, source }, name, now);
  const flow = store.getFlow(trigger.flow);
  if (made.made === "added") {
    store.updateFlowTrigger(trigger.id, { lastAt: now.toISOString(), lastOutcome: "Added a card." }, now);
    return { said: `Added to ${flow?.name ?? "the flow"} as a card. Replies here join its discussion.`, ...(flow === null ? {} : { link: { label: "Open the card", path: flowCardHref(flow.id, made.card!) } }) };
  }
  return { said: made.made === "skipped" && made.note !== null ? `Not added: ${made.note.replace(/^[^:]+: /, "")}.` : null };
}

/**
 * Answer in the thread a card came from (an Update zone): one message,
 * through the chat of whoever connected the channel. Idempotent per card
 * visit, so a retried step never answers twice.
 */
export function replyInChannel(store: Store, source: NonNullable<FlowCardSource["chat"]>, visit: { card: number; entry: number }, text: string, now: Date): { ok: true } | { ok: false; said: string } {
  if (source.app !== "slack" && source.app !== "discord" && source.app !== "teams") return { ok: false, said: `Answering in a ${CHAT_APP_NAMES[source.app as ChatApp] ?? source.app} group isn't supported yet, so nothing was posted. The card's link is in the group.` };
  const state = new ChatState(store, source.app);
  const grant = state.bindingById(source.binding);
  if (grant === null || !state.live(grant)) return { ok: false, said: `The person who connected that ${CHAT_APP_NAMES[source.app]} channel is no longer paired, so nothing was posted.` };
  const id = chatHash(`${source.app}:flow-reply:${visit.card}:${visit.entry}`);
  store.transact(() => {
    if (state.enqueue({ id, installation: grant.installation, binding: grant.id, kind: "message", channel: source.conversation, member: grant.member,
      ts: source.thread, thread: source.thread, payload: {}, created: now.toISOString() })) state.plan(id, [{ text: text.slice(0, 3500), channel: source.conversation }], now);
  });
  return { ok: true };
}
