/**
 * What a lead may put on a card (docs/plans/toolroll-cards.md): a json-render spec limited to this catalog.
 *
 * json-render defines the catalog and checks a spec's structure. Its own check lets any props through when a catalog has
 * several components, so each element's props are read here, strictly, against its component. json-render's dynamic
 * features ($state, repeat, visible, on) are refused: a card is data Toolroll fills, not a program.
 *
 * Nothing here can carry a figure or an address. Fields, Table and Chart name a source; Text is the one free field.
 */
import { defineCatalog, defineSchema, validateSpec, type Spec } from "@json-render/core";
import { z } from "zod";
import { CHAT_CONTROLS } from "./chat-controls.js";
import { CARD_CHART_TYPES, CARD_LIMITS } from "./contracts/chat-card.js";

export const CARD_SOURCES = ["tasks", "results", "flows", "flow_zones", "spend", "projects", "builders", "mode", "integrations", "providers", "findings", "handover"] as const;
export type CardSourceName = (typeof CARD_SOURCES)[number];
export const CARD_TASK_STATES = ["queued", "running", "done", "failed", "cancelled"] as const;

const source = z.enum(CARD_SOURCES);
const repo = z.string().regex(/^r[0-9]{1,3}$/);
const pick = z.array(z.string().max(40)).min(1).max(CARD_LIMITS.columns);
/** What narrows a source: read by the sources, which check each against who is asking. */
const narrowing = { repo: repo.optional(), task: z.string().max(200).optional(), state: z.enum(CARD_TASK_STATES).optional(), limit: z.int().min(1).max(CARD_LIMITS.rows).optional(), flow: z.int().min(1).optional(), days: z.int().min(1).max(90).optional() };

const schema = defineSchema(s => ({
  spec: s.object({
    root: s.string(),
    elements: s.record(s.object({ type: s.ref("catalog.components"), props: s.propsOf("catalog.components"), children: s.array(s.string()) })),
  }),
  catalog: s.object({ components: s.map({ props: s.zod(), description: s.string() }) }),
}));

export const CARD_CATALOG = defineCatalog(schema, {
  components: {
    Card: { props: z.strictObject({}), description: "The root. Its children are the card's parts in order. Its title comes from its first source." },
    Text: { props: z.strictObject({ text: z.string().min(1).max(CARD_LIMITS.text) }), description: "Your own words, shown as a plain paragraph. Never a place for figures you want read as records." },
    Fields: { props: z.strictObject({ source, facts: z.array(z.string().max(40)).min(1).max(CARD_LIMITS.facts).optional(), ...narrowing }), description: "Key facts from a source, filled by Toolroll. facts picks which." },
    Table: { props: z.strictObject({ source, columns: pick.optional(), ...narrowing }), description: "Rows from a source, filled by Toolroll. columns picks which." },
    Notes: { props: z.strictObject({ source, ...narrowing }), description: "Saved words from a source, whole, one to a line: findings or handover (with task)." },
    Chart: { props: z.strictObject({ source, chart: z.enum(CARD_CHART_TYPES), ...narrowing }), description: "A chart of a source's numbers, filled by Toolroll: bar, pie, line or area." },
    Divider: { props: z.strictObject({}), description: "A line between parts." },
    Actions: { props: z.strictObject({}), description: "Holds the card's Buttons." },
    Button: {
      props: z.strictObject({ control: z.enum(Object.keys(CHAT_CONTROLS) as [string, ...string[]]).optional(), task: z.string().max(200).optional(), run: z.int().min(1).optional(), repo: repo.optional(), proposal: z.int().min(1).optional() }),
      description: "control opens a fixed Toolroll page (as show_control). proposal points at one you proposed earlier this reply; its Confirm stays on its own message under the card.",
    },
  },
});

export type CardComponent = keyof typeof CARD_CATALOG.data.components;
export type CardElement = { type: CardComponent; props: Record<string, unknown>; children: string[] };
/** A checked spec, as the parts of its card in order. */
export type CardPlan = { parts: { type: CardComponent; props: Record<string, unknown> }[]; buttons: Record<string, unknown>[] };

const issues = (lines: string[]) => ({ ok: false as const, issues: lines });

/** A spec as a card plan, or every reason it isn't one, in words the lead can fix on its next step. */
export function readCardSpec(raw: unknown): { ok: true; plan: CardPlan } | { ok: false; issues: string[] } {
  const shape = CARD_CATALOG.validate(raw);
  if (!shape.success) return issues((shape.error?.issues ?? []).map(one => `${one.path.join(".")}: ${one.message}`));
  const spec = raw as Spec & { elements: Record<string, Record<string, unknown>> };
  const structure = validateSpec(spec as Spec, { checkOrphans: true });
  const refused = structure.issues.map(one => one.message);
  if (refused.length > 0) return issues(refused);
  const parsed = new Map<string, CardElement>();
  for (const key of Object.keys(spec.elements)) {
    const element = spec.elements[key]!;
    const extra = Object.keys(element).filter(one => one !== "type" && one !== "props" && one !== "children");
    if (extra.length > 0) { refused.push(`${key}: a card element has only type, props and children, not ${extra.join(", ")}`); continue; }
    const type = element["type"] as CardComponent;
    const props = CARD_CATALOG.data.components[type].props.safeParse(element["props"]);
    if (!props.success) { refused.push(...props.error.issues.map(one => `${key}.props.${one.path.join(".")}: ${one.message}`)); continue; }
    parsed.set(key, { type, props: props.data as Record<string, unknown>, children: (element["children"] as string[]) });
  }
  if (refused.length > 0) return issues(refused);
  const own = (key: string) => Object.hasOwn(spec.elements, key) ? parsed.get(key) : undefined;
  const root = own(spec.root);
  if (root?.type !== "Card") return issues(["root: the root must be a Card"]);
  const seen = new Set<string>([spec.root]);
  const plan: CardPlan = { parts: [], buttons: [] };
  const used = (key: string): CardElement | null => {
    const element = own(key);
    if (element === undefined) { refused.push(`${key}: no such element`); return null; }
    if (seen.has(key)) { refused.push(`${key}: an element appears once`); return null; }
    seen.add(key);
    return element;
  };
  for (const key of root.children) {
    const element = used(key);
    if (element === null) continue;
    if (element.type === "Actions") {
      for (const inner of element.children) {
        const button = used(inner);
        if (button === null) continue;
        if (button.type !== "Button") refused.push(`${inner}: Actions holds Buttons`);
        else if ((button.props["control"] === undefined) === (button.props["proposal"] === undefined)) refused.push(`${inner}: a Button names a control or a proposal, one of them`);
        else plan.buttons.push(button.props);
      }
      continue;
    }
    if (element.type === "Card" || element.type === "Button") { refused.push(`${key}: a ${element.type} can't be a part of a card`); continue; }
    if (element.children.length > 0) { refused.push(`${key}: a ${element.type} has no children`); continue; }
    plan.parts.push({ type: element.type, props: element.props });
  }
  if (seen.size !== parsed.size) refused.push("every element must be reached from the root");
  if (plan.parts.length > CARD_LIMITS.blocks) refused.push(`a card has at most ${CARD_LIMITS.blocks} parts`);
  if (plan.buttons.length > CARD_LIMITS.buttons + CARD_LIMITS.actions) refused.push("too many Buttons");
  if (!plan.parts.some(one => one.type === "Fields" || one.type === "Table" || one.type === "Notes" || one.type === "Chart")) refused.push("a card shows data: give it Fields, a Table, Notes or a Chart. For words alone, just reply");
  return refused.length > 0 ? issues(refused) : { ok: true, plan };
}

/** The catalog in words, for the lead's tool description: json-render's full prompt describes features a card refuses. */
export function cardCatalogWords(): string {
  return Object.entries(CARD_CATALOG.data.components).map(([name, one]) => `${name}: ${one.description}`).join(" ");
}
