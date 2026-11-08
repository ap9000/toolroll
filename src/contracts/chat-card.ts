/**
 * A Toolroll card as it is kept and shown (docs/plans/toolroll-cards.md): what a card's spec became once Toolroll filled
 * it from its own records. Every value here was written by Toolroll; the one exception is a `text` block, which a person
 * reads as a plain paragraph labelled as the lead's note, never as data. A saved card is read back through this
 * schema before any renderer sees it.
 */
import { z } from "zod";

export const CARD_LIMITS = { blocks: 8, columns: 6, rows: 20, points: 12, facts: 10, buttons: 4, actions: 4, cell: 80, label: 40, heading: 80, text: 600, note: 400, notes: 12 } as const;

const label = z.string().min(1).max(CARD_LIMITS.label);
const heading = z.string().min(1).max(CARD_LIMITS.heading);
const cell = z.string().max(CARD_LIMITS.cell);

export const CARD_CHART_TYPES = ["bar", "pie", "line", "area"] as const;
export type CardChartType = (typeof CARD_CHART_TYPES)[number];

const textBlock = z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(CARD_LIMITS.text) });
const dividerBlock = z.strictObject({ kind: z.literal("divider") });
const factsBlock = z.strictObject({ kind: z.literal("facts"), heading, items: z.array(z.strictObject({ label, value: cell })).min(1).max(CARD_LIMITS.facts) });
const tableBlock = z.strictObject({
  kind: z.literal("table"), heading,
  /** `report`: an agent's own report, shown as such; never a figure of Toolroll's. */
  origin: z.enum(["records", "report"]),
  columns: z.array(z.strictObject({ label, numeric: z.boolean() })).min(1).max(CARD_LIMITS.columns),
  rows: z.array(z.array(cell).max(CARD_LIMITS.columns)).max(CARD_LIMITS.rows),
  /** Rows the records hold beyond the ones shown. */
  more: z.int().min(0),
});
/** Lines of saved words, whole: findings and a handover note. `report` as a table's: not Toolroll's figures. */
const notesBlock = z.strictObject({ kind: z.literal("notes"), heading, origin: z.enum(["records", "report"]), items: z.array(z.string().min(1).max(CARD_LIMITS.note)).min(1).max(CARD_LIMITS.notes), more: z.int().min(0) });
const chartBlock = z.strictObject({
  kind: z.literal("chart"), heading, chart: z.enum(CARD_CHART_TYPES),
  points: z.array(z.strictObject({ label, value: z.number().finite().min(0), shown: cell })).min(1).max(CARD_LIMITS.points),
});

export const chatCardSchema = z.strictObject({
  version: z.literal(1),
  title: heading,
  /** When Toolroll read the records. */
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
  /** The projects the values came from: a card goes only where all of them are reachable. */
  repos: z.array(z.string()).max(200),
  blocks: z.array(z.discriminatedUnion("kind", [textBlock, dividerBlock, factsBlock, tableBlock, notesBlock, chartBlock])).min(1).max(CARD_LIMITS.blocks),
  /** Fixed destinations in Toolroll: a path made by chat-controls.ts, never a model's address. */
  buttons: z.array(z.strictObject({ label, path: z.string().max(400).regex(/^\/(?![/\\])/) })).max(CARD_LIMITS.buttons),
  /** Proposals this card leads to: each keeps its own Confirm message directly under the card. */
  actions: z.array(z.strictObject({ proposal: z.int().min(1), label: z.string().min(1).max(CARD_LIMITS.heading) })).max(CARD_LIMITS.actions),
});
export type ChatCard = z.infer<typeof chatCardSchema>;
export type ChatCardBlock = ChatCard["blocks"][number];

/** A saved card, or null: it was changed, or a build that wrote it knew another shape. */
export function readChatCard(value: unknown): ChatCard | null {
  const read = chatCardSchema.safeParse(value);
  if (!read.success) return null;
  const card = read.data;
  for (const block of card.blocks) if (block.kind === "table" && block.rows.some(row => row.length !== block.columns.length)) return null;
  return card;
}
