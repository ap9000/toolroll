/**
 * People on flow cards (v83): who owns a card, who follows it, what was said
 * on it, and who hears about what. A notification about a card goes to the
 * people it concerns — the one who decides, its owner, its watchers, whoever
 * was @mentioned — on their own paired phone or chat, never to everyone.
 * A "Tell the team" zone still posts to everyone; that is what it is for.
 */
import { scanForSecrets } from "./evidence.js";
import { flowCardHref, type FlowAct } from "./flow-engine.js";
import type { FlowCardRow, Store } from "./store.js";

/** Everyone who may take part in a project's flows: approvers who can reach the project. */
export function flowPeople(store: Store, repo: string): string[] {
  return store.listApprovers().map(one => one.name).filter(name => store.accountCanAccess(name, repo));
}

/** The people a comment @mentions: known names only, each once, in the order written. */
export function mentionsIn(body: string, people: readonly string[]): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(/(^|[^A-Za-z0-9_.@-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,63})/g)) {
    const name = people.find(one => one.toLowerCase() === match[2]!.replace(/[.-]+$/, "").toLowerCase());
    if (name !== undefined && !found.includes(name)) found.push(name);
  }
  return found;
}

type CardEvent = { key: string; subject: string; body: string; attention?: boolean };

/** One notification per person, to that person only. The actor never notifies themself. */
/** A notice's body: whole up to 2,000 characters; longer, its start and a line saying the rest is on the card it links. */
const NOTICE_CHARS = 2000;
function noticeBody(body: string): string {
  if (body.length <= NOTICE_CHARS) return body;
  const mark = "\n… (the rest is on the card)";
  return `${body.slice(0, NOTICE_CHARS - mark.length)}${mark}`;
}

export function notifyPeople(store: Store, card: FlowCardRow, people: Iterable<string>, actor: string | null, event: CardEvent, now: Date): string[] {
  const flow = store.getFlow(card.flow);
  if (flow === null) return [];
  const sent: string[] = [];
  for (const person of new Set(people)) {
    if (person === actor || !store.accountCanAccess(person, flow.repo)) continue;
    const queued = store.enqueueNotification({
      dedupeKey: `flow-card:${card.id}:${event.key}:${person}`, kind: "flow-card", recipient: person,
      ...(event.attention === true ? { pushClass: "attention" as const } : {}),
      subject: `${flow.name}: ${event.subject}`.slice(0, 200), body: noticeBody(event.body), link: flowCardHref(flow.id, card.id), source: { project: flow.repo },
    }, now);
    if (queued) sent.push(person);
  }
  return sent;
}

/** Who follows a card: its owner and its watchers. */
export function cardFollowers(store: Store, card: FlowCardRow): string[] {
  return [...new Set([...(card.owner === null ? [] : [card.owner]), ...store.flowCardWatchers(card.id)])];
}

/** Make someone (or no one) a card's owner. The new owner follows it and hears so. */
export function assignFlowCard(store: Store, card: FlowCardRow, owner: string | null, actor: string, now: Date): FlowAct {
  const flow = store.getFlow(card.flow);
  if (flow === null || card.state !== "active") return { ok: false, message: "That card is finished." };
  if (owner !== null && !flowPeople(store, flow.repo).includes(owner)) return { ok: false, message: `${owner} can't work on this project.` };
  if (owner === card.owner) return { ok: true, said: owner === null ? "It has no owner." : `${owner === actor ? "You already own" : `${owner} already owns`} it.`, card: card.id };
  store.setFlowCardOwner(card.id, owner, actor, now);
  if (owner !== null) {
    store.setFlowCardWatcher(card.id, owner, true, now);
    notifyPeople(store, card, [owner], actor, { key: `owner:${now.getTime()}`, subject: `You now own “${card.title}”`, body: `${actor} made you the owner of “${card.title}”. You'll hear when it needs you or finishes.` }, now);
  }
  return { ok: true, said: owner === null ? "It has no owner now." : owner === actor ? "You own it now." : `${owner} owns it now.`, card: card.id };
}

export function watchFlowCard(store: Store, card: FlowCardRow, name: string, watching: boolean, now: Date): FlowAct {
  store.setFlowCardWatcher(card.id, name, watching, now);
  return { ok: true, said: watching ? "You'll hear about this card." : "You won't hear about this card unless someone mentions you.", card: card.id };
}

/** A comment on a card: keys refused; the people it @mentions, the owner and watchers hear about it; the author and anyone mentioned follow it from now on. */
export function commentOnFlowCard(store: Store, card: FlowCardRow, author: string, text: unknown, now: Date): FlowAct & { mentions?: string[] } {
  const flow = store.getFlow(card.flow);
  if (flow === null) return { ok: false, message: "That card is gone." };
  const body = (typeof text === "string" ? text : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (body === "") return { ok: false, message: "Write something first." };
  if (body.length > 4000) return { ok: false, message: "Keep a comment under 4000 characters." };
  if (scanForSecrets(body).length > 0) return { ok: false, message: "That looks like a key or password. Keep secrets out of comments." };
  const mentions = mentionsIn(body, flowPeople(store, flow.repo));
  const followers = cardFollowers(store, card);
  const id = store.transact(() => {
    const made = store.addFlowComment({ card: card.id, author, body, mentions }, now);
    for (const person of [author, ...mentions]) store.setFlowCardWatcher(card.id, person, true, now);
    return made;
  });
  const quote = body.length > 280 ? `${body.slice(0, 277)}…` : body;
  notifyPeople(store, card, mentions, author, { key: `mention:${id}`, subject: `${author} mentioned you on “${card.title}”`, body: quote, attention: true }, now);
  notifyPeople(store, card, followers.filter(one => !mentions.includes(one)), author, { key: `comment:${id}`, subject: `${author} commented on “${card.title}”`, body: quote }, now);
  return { ok: true, said: mentions.length === 0 ? "Comment added." : `Comment added. ${mentions.join(" and ")} will hear about it.`, card: card.id, mentions };
}

