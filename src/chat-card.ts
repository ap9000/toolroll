/**
 * From a checked spec to a card (docs/plans/toolroll-cards.md): Toolroll fills every data part from its records and every
 * button from its own tables. Nothing the model wrote reaches a card except a Text part, and that as a plain paragraph.
 */
import type { CardPlan, CardSourceName } from "./card-catalog.js";
import { readCardSource, type CardData, type CardQuery, type CardReader } from "./card-sources.js";
import { publicChatText } from "./chat-display.js";
import { CARD_LIMITS, readChatCard, type ChatCard, type ChatCardBlock } from "./contracts/chat-card.js";

/** How a Button becomes a page or a proposal: the lead's own checks, so a card can't reach what show_control can't. */
export type CardButtons = (props: Record<string, unknown>) => { ok: true; button?: ChatCard["buttons"][number]; action?: ChatCard["actions"][number] } | { ok: false; message: string };

const queryOf = (props: Record<string, unknown>, repoOf: (id: unknown) => string | null): CardQuery | null => {
  const repo = props["repo"] === undefined ? null : repoOf(props["repo"]);
  if (props["repo"] !== undefined && repo === null) return null;
  return { repo, ...(props["state"] === undefined ? {} : { state: String(props["state"]) }), ...(props["limit"] === undefined ? {} : { limit: Number(props["limit"]) }),
    ...(props["flow"] === undefined ? {} : { flow: Number(props["flow"]) }), ...(props["days"] === undefined ? {} : { days: Number(props["days"]) }) };
};

function tableOf(data: CardData, wanted: unknown): ChatCardBlock | string {
  const ids = Array.isArray(wanted) ? wanted.map(String) : data.columns.slice(0, CARD_LIMITS.columns).map(one => one.id);
  const columns = ids.map(id => data.columns.find(one => one.id === id));
  const missing = ids.filter((_, index) => columns[index] === undefined);
  if (missing.length > 0) return `No column ${missing.join(", ")}. This source has: ${data.columns.map(one => one.id).join(", ")}.`;
  return { kind: "table", heading: data.heading, origin: "records", columns: columns.map(one => ({ label: one!.label, numeric: one!.numeric === true })), rows: data.rows.map(row => ids.map(id => row[id] ?? "")), more: data.more };
}

function factsOf(data: CardData, wanted: unknown): ChatCardBlock | string {
  const ids = Array.isArray(wanted) ? wanted.map(String) : data.facts.map(one => one.id);
  const items = ids.flatMap(id => data.facts.filter(one => one.id === id));
  if (items.length !== ids.length) return `This source's facts are: ${data.facts.map(one => one.id).join(", ")}.`;
  if (items.length === 0) return "This source has no facts to show now.";
  return { kind: "facts", heading: data.heading, items: items.slice(0, CARD_LIMITS.facts).map(({ label, value }) => ({ label, value })) };
}

/** A plan as a card, read now, or why it can't be one. */
export function buildChatCard(reader: CardReader, plan: CardPlan, repoOf: (id: unknown) => string | null, buttons: CardButtons): { ok: true; card: ChatCard } | { ok: false; message: string } {
  const blocks: ChatCardBlock[] = [];
  const repos = new Set<string>();
  let title: string | null = null;
  for (const part of plan.parts) {
    if (part.type === "Divider") { blocks.push({ kind: "divider" }); continue; }
    if (part.type === "Text") {
      const text = publicChatText(String(part.props["text"]), CARD_LIMITS.text);
      if (text !== "") blocks.push({ kind: "text", text });
      continue;
    }
    const query = queryOf(part.props, repoOf);
    if (query === null) return { ok: false, message: "repo must be one of the ids from list_repos." };
    const data = readCardSource(reader, part.props["source"] as CardSourceName, query);
    if ("problem" in data) return { ok: false, message: data.problem };
    title ??= data.heading;
    for (const repo of data.repos) repos.add(repo);
    if (part.type === "Chart") {
      if (data.points.length === 0) return { ok: false, message: "There are no numbers to chart yet: show a Table or Fields instead." };
      blocks.push({ kind: "chart", heading: data.heading, chart: part.props["chart"] as "bar", points: [...data.points] });
      continue;
    }
    const block = part.type === "Table" ? tableOf(data, part.props["columns"]) : factsOf(data, part.props["facts"]);
    if (typeof block === "string") return { ok: false, message: block };
    blocks.push(block);
  }
  const links: ChatCard["buttons"] = [], actions: ChatCard["actions"] = [];
  for (const props of plan.buttons) {
    const made = buttons(props);
    if (!made.ok) return made;
    if (made.button !== undefined) links.push(made.button);
    if (made.action !== undefined) actions.push(made.action);
  }
  const card = readChatCard({ version: 1, title: title ?? "Toolroll", asOf: reader.now.toISOString(), repos: [...repos], blocks, buttons: links.slice(0, CARD_LIMITS.buttons), actions: actions.slice(0, CARD_LIMITS.actions) });
  return card === null ? { ok: false, message: "That card doesn't fit. Show fewer parts." } : { ok: true, card };
}

/** A card kept on a `control` proposal, as its marker says. */
export const CARD_CONTROL = "card";
export function cardOfProposal(proposal: { kind: string; payload: Record<string, unknown> }): ChatCard | null {
  return proposal.kind === "control" && proposal.payload["control"] === CARD_CONTROL ? readChatCard(proposal.payload["card"]) : null;
}
export function isCardProposal(proposal: { kind: string; payload: Record<string, unknown> }): boolean {
  return proposal.kind === "control" && proposal.payload["control"] === CARD_CONTROL;
}
/** The plain version kept beside a card, for when the card itself can't be read. */
export const cardPlainOf = (proposal: { payload: Record<string, unknown> }): string =>
  typeof proposal.payload["plain"] === "string" ? proposal.payload["plain"] : "This card can't be shown.";
/** Cards before the proposals they lead to, so each Confirm sits under its card. */
export function cardsFirst<T extends { kind: string; payload: Record<string, unknown> }>(proposals: readonly T[]): T[] {
  return [...proposals.filter(isCardProposal), ...proposals.filter(one => !isCardProposal(one))];
}
/** A card goes only where every project behind it is still reachable. */
export const cardWithin = (card: Pick<ChatCard, "repos">, repos: readonly string[]): boolean => card.repos.every(one => repos.includes(one));
