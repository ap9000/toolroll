/**
 * A flow's result as a card (docs/plans/toolroll-cards.md): its steps from what the flow recorded (flow_event), with no
 * model, and a research report's items shown as the agent's report, never as Toolroll's records.
 */
import { CARD_LIMITS, readChatCard, type ChatCard, type ChatCardBlock } from "./contracts/chat-card.js";
import { publicChatText } from "./chat-display.js";
import { CHAT_CONTROLS } from "./chat-controls.js";
import { flowCardHref, flowDefinitionOf } from "./flow-engine.js";
import type { FlowDefinition } from "./flows.js";
import type { FlowCardRow, FlowEventOutcome, FlowRow, Store } from "./store.js";

const OUTCOME_WORDS: Record<FlowEventOutcome, string> = { created: "Started", ok: "Passed", fail: "Failed", moved: "Moved on", approved: "Approved", "sent-back": "Sent back", cancelled: "Cancelled" };
const clean = (text: string, cap: number): string => publicChatText(text, cap);
const tookWords = (ms: number): string => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} sec` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`;

/** The steps a card went through, in order: where it was, how it left, and for how long. */
function stepsOf(store: Store, definition: FlowDefinition, card: FlowCardRow, now: Date): { title: string; result: string; ms: number | null }[] {
  const events = store.flowEvents(card.id);
  const titleOf = (id: string) => definition.stages.find(one => one.id === id)?.title ?? id;
  return events.map((event, at) => {
    const next = events[at + 1];
    const end = next === undefined ? (card.state === "active" ? now.toISOString() : null) : next.at;
    const ms = end === null ? null : Math.max(0, Date.parse(end) - Date.parse(event.at));
    return { title: titleOf(event.toStage), result: next === undefined ? (card.state === "active" ? "In progress" : "Finished") : OUTCOME_WORDS[next.outcome], ms };
  });
}

/** The result card of one flow card, as its records stand now; null when there is nothing recorded to show. */
export function flowResultCard(store: Store, flow: FlowRow, definition: FlowDefinition, card: FlowCardRow, now: Date, extra: { links?: readonly { label: string; path: string }[]; items?: readonly { title: string; source: string }[] } = {}): ChatCard | null {
  const steps = stepsOf(store, definition, card, now);
  if (steps.length === 0) return null;
  const shown = steps.slice(0, CARD_LIMITS.rows), timed = steps.filter(one => one.ms !== null && one.ms > 0);
  const total = timed.reduce((sum, one) => sum + one.ms!, 0);
  const heading = clean(`${flow.name}: ${card.title}`, CARD_LIMITS.heading);
  const blocks: ChatCardBlock[] = [
    { kind: "facts", heading, items: [{ label: "Steps", value: String(steps.length) }, ...(total > 0 ? [{ label: "Took", value: tookWords(total) }] : []), { label: "State", value: clean(card.state, CARD_LIMITS.cell) }] },
    { kind: "table", heading: "Steps", origin: "records", columns: [{ label: "Step", numeric: false }, { label: "Result", numeric: false }, { label: "Took", numeric: true }],
      rows: shown.map(one => [clean(one.title, CARD_LIMITS.cell), one.result, one.ms === null || one.ms === 0 ? "" : tookWords(one.ms)]), more: steps.length - shown.length },
  ];
  if (timed.length >= 2) blocks.push({ kind: "chart", heading: "Time per step", chart: "bar", points: timed.slice(0, CARD_LIMITS.points).map(one => ({ label: clean(one.title, CARD_LIMITS.label), value: one.ms! / 60_000, shown: tookWords(one.ms!) })) });
  if (extra.items !== undefined && extra.items.length > 0) {
    const items = extra.items.slice(0, CARD_LIMITS.rows);
    blocks.push({ kind: "table", heading: "Found", origin: "report", columns: [{ label: "Item", numeric: false }, { label: "Source", numeric: false }],
      rows: items.map(one => [clean(one.title, CARD_LIMITS.cell), clean(one.source, CARD_LIMITS.cell)]), more: extra.items.length - items.length });
  }
  const buttons = [{ label: "Open card", path: flowCardHref(flow.id, card.id) }, ...(extra.links ?? []).filter(one => one.label !== "Card").map(one => ({ label: clean(one.label, CARD_LIMITS.label), path: one.path })), { label: CHAT_CONTROLS.flows.label, path: CHAT_CONTROLS.flows.href }];
  return readChatCard({ version: 1, title: heading, asOf: now.toISOString(), repos: [flow.repo], blocks, buttons: buttons.slice(0, CARD_LIMITS.buttons), actions: [] });
}

/** A card's "Done" notice: `flow-card:<card>:done:<entry>:<person>` (flow-engine.ts). */
const FLOW_DONE_KEY = /^flow-card:([1-9][0-9]{0,14}):done:[1-9][0-9]{0,9}:/;
/** The result card a "Done" notice carries; null for every other notice. */
export function flowDoneCard(store: Store, notification: { dedupeKey: string }, now: Date): ChatCard | null {
  const visit = FLOW_DONE_KEY.exec(notification.dedupeKey);
  const card = visit === null ? null : store.getFlowCard(Number(visit[1]));
  const flow = card === null ? null : store.getFlow(card.flow);
  const definition = flow === null ? null : flowDefinitionOf(flow);
  return card === null || flow === null || definition === null ? null : flowResultCard(store, flow, definition, card, now);
}
