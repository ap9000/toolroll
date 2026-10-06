/**
 * What a finished zone hands the zones after it (docs/plans/zod-revamp.md, item 8): its `{{stage.<id>}}` words and, by
 * kind, more fields (a research zone's `{{stage.<id>.items}}` and `{{stage.<id>.report}}`), kept on the card as one
 * versioned payload (`flow_card.outputs_json`) with any output too long to pass on attached whole.
 *
 * - `stageHandoffSchema` is one zone's handoff; `STAGE_HANDOFFS` says which of its fields each zone kind hands on. A
 *   template's `{{stage.<id>.<field>}}` is checked against it when a flow is saved (`stageReferenceProblems`), so a
 *   refusal names the path: `stages[1].instructions: stage.research.unknown is not available`.
 * - `cardOutputsSchema` is what the card keeps: every handoff's fields flat (`<zone>`, `<zone>.items`, `<zone>.report`,
 *   as `{{stage.…}}` names them) and, for a zone whose output was over TEXT_LIMITS.stageOutput, the output whole: its
 *   `{{stage.<zone>}}` says where it is kept, and a task filed after it is given it whole (flowGoalCuts).
 *
 * Saved before this contract (version 0), a card's outputs were the flat map alone; they read exactly as every release
 * read them: the string values, anything else skipped.
 */

import { z } from "zod";
import { parseContract, readVersioned, versioned, type ContractIssue, type ContractResult } from "./contract.js";
import type { FlowDefinition, FlowStage, FlowStageKind } from "./flow.js";

/** One zone's handoff to the zones after it. */
export const stageHandoffSchema = z.strictObject({
  text: z.string().describe("{{stage.<id>}}: what the zone produced, whole up to TEXT_LIMITS.stageOutput characters; a longer one says where it is kept whole."),
  items: z.string().optional().describe("{{stage.<id>.items}}: what a research zone found, as a numbered list (title, why, link)."),
  report: z.string().optional().describe("{{stage.<id>.report}}: a research zone's whole report (REPORT_FILL_LIMIT)."),
});

export type StageHandoff = z.infer<typeof stageHandoffSchema>;
export type StageField = Exclude<keyof StageHandoff, "text">;

const words = stageHandoffSchema.pick({ text: true });

/**
 * What each zone kind hands on, or null when it hands nothing on (it holds, asks, messages or ends). A sort hands on its
 * decision in words (`sortWords` of the small-answers contract's SortDecision, src/contracts/sort-answer.ts), and a
 * Send to me zone what it sent.
 */
export const STAGE_HANDOFFS = {
  inbox: null, task: words, report: stageHandoffSchema, approval: null, check: words, "pull-request": words, update: words, notify: null,
  sort: words, draft: words, request: words, email: words, tool: words, wait: words, teammate: words, send: words, choose: null, done: null,
} as const satisfies Record<FlowStageKind, z.ZodObject | null>;

/** The extra `{{stage.<id>.<field>}}` fields a zone kind hands on. */
export function stageFieldsOf(kind: FlowStageKind): StageField[] {
  const schema = STAGE_HANDOFFS[kind];
  return schema === null ? [] : (Object.keys(schema.shape).filter(field => field !== "text") as StageField[]);
}

/** One zone's handoff, read from the card's flat outputs (a field it never wrote is left out; no words read as ""). */
export function stageHandoffOf(outputs: Readonly<Record<string, string>>, zone: string): StageHandoff {
  const fields = Object.keys(stageHandoffSchema.shape).filter(field => field !== "text") as StageField[];
  return { text: outputs[zone] ?? "", ...Object.fromEntries(fields.flatMap(field => outputs[`${zone}.${field}`] === undefined ? [] : [[field, outputs[`${zone}.${field}`]!]])) };
}

/** The card's flat outputs with one zone's handoff in place of its last: a field this visit didn't hand on is gone, so
 * nothing stale is left behind. */
export function withStageHandoff(outputs: Readonly<Record<string, string>>, zone: string, handoff: StageHandoff): Record<string, string> {
  const read = stageHandoffSchema.parse(handoff);
  const next: Record<string, string> = { ...outputs, [zone]: read.text };
  for (const field of Object.keys(stageHandoffSchema.shape).filter(one => one !== "text") as StageField[]) {
    const value = read[field];
    if (value === undefined) delete next[`${zone}.${field}`];
    else next[`${zone}.${field}`] = value;
  }
  return next;
}

// ------------------------------------------------------------------ what the card keeps

export const CARD_OUTPUTS_VERSION = 1;

export const cardOutputsSchema = versioned(CARD_OUTPUTS_VERSION, {
  outputs: z.object({}).catchall(z.string()).describe("Every {{stage.…}} value by its name: <zone>, and a research zone's <zone>.items and <zone>.report."),
  attached: z.object({}).catchall(z.string()).describe("A zone's output in full when it was over TEXT_LIMITS.stageOutput characters, by zone."),
});

export type CardOutputs = z.infer<typeof cardOutputsSchema>;

/** Version 0, the flat map every release before wrote: its string values, as they read them; anything else is skipped. */
export function upgradeFlatOutputs(raw: unknown): CardOutputs {
  const outputs = raw !== null && typeof raw === "object" ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  return { version: CARD_OUTPUTS_VERSION, outputs, attached: {} };
}

/**
 * Read a card's outputs. Version 1 as itself and a newer version refused plainly. Anything without a numeric `version`
 * was saved before outputs carried one (a zone may be called `version`; its words were a string), and is read as the
 * flat map it is.
 */
export function readCardOutputs(input: unknown): ContractResult<CardOutputs> {
  const legacy = input === null || typeof input !== "object" || Array.isArray(input) || typeof (input as Record<string, unknown>)["version"] !== "number";
  return legacy ? parseContract(cardOutputsSchema, upgradeFlatOutputs(input)) : readVersioned(cardOutputsSchema, input);
}

/** A card's outputs as the store keeps them: unreadable JSON is the empty card it always was; `newer` is a row a newer
 * Toolroll wrote, which this one reads as empty and never writes over. */
export function cardOutputsFromStore(json: string): { outputs: Record<string, string>; attached: Record<string, string>; issues: ContractIssue[]; newer: boolean } {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { raw = {}; }
  const read = readCardOutputs(raw);
  if (read.ok) return { outputs: read.value.outputs, attached: read.value.attached, issues: [], newer: false };
  return { outputs: {}, attached: {}, issues: read.issues, newer: read.issues.some(one => one.kind === "newer-version") };
}

/** A card's outputs as the store saves them. A zone's attachment is kept only while its output is the pointer to it. */
export function cardOutputsForStore(outputs: Readonly<Record<string, string>>, attached: Readonly<Record<string, string>>): string {
  const kept = Object.fromEntries(Object.entries(attached).filter(([zone]) => outputs[zone] !== undefined));
  return JSON.stringify(cardOutputsSchema.parse({ version: CARD_OUTPUTS_VERSION, outputs, attached: kept }));
}

// ------------------------------------------------------------------ template references, checked at save

/** Where a zone's words take fill-ins, by the drawing's path: its instructions and message, a request's address,
 * headers and body, an email's fields and a tool's arguments. */
export function templateFields(stage: FlowStage): { path: string; text: string }[] {
  const fields: { path: string; text: string }[] = [];
  const add = (path: string, text: string | null | undefined) => { if (typeof text === "string") fields.push({ path, text }); };
  add("instructions", stage.instructions);
  add("message", stage.message);
  if (stage.request !== undefined) {
    add("request.url", stage.request.url);
    for (const [name, value] of Object.entries(stage.request.headers)) add(`request.headers.${name}`, value);
    add("request.body", stage.request.body);
  }
  if (stage.email !== undefined) { add("email.to", stage.email.to); add("email.subject", stage.email.subject); add("email.body", stage.email.body); }
  if (stage.tool !== undefined) add("tool.args", stage.tool.args);
  return fields;
}

/** Every `{{stage.…}}` in some words, as written between the braces (`stage.research.items`). */
const STAGE_REFERENCE = /\{\{\s*(stage\.[^{}]*?)\s*\}\}/g;
export function stageReferences(text: string): string[] {
  return [...text.matchAll(STAGE_REFERENCE)].map(match => match[1]!);
}

/** What one `{{stage.…}}` reference can't be, against the drawing: null when its zone hands that field on. */
export function stageReferenceProblem(definition: FlowDefinition, reference: string): string | null {
  const [zone = "", ...rest] = reference.slice("stage.".length).split(".");
  const field = rest.join(".");
  const stage = definition.stages.find(one => one.id === zone);
  if (stage === undefined) return `${reference} is not available: there's no zone called ${zone === "" ? "(none)" : zone}`;
  if (STAGE_HANDOFFS[stage.kind] === null) return `${reference} is not available: ${stage.title} hands nothing on`;
  if (field === "") return null;
  const fields = stageFieldsOf(stage.kind);
  if ((fields as string[]).includes(field)) return null;
  const offered = [`{{stage.${zone}}}`, ...fields.map(one => `{{stage.${zone}.${one}}}`)];
  return `${reference} is not available (${stage.title} hands on ${offered.length === 1 ? offered[0] : `${offered.slice(0, -1).join(", ")} and ${offered.at(-1)}`})`;
}

/**
 * Template references a save adds that its zones don't hand on, each named by its path
 * (`stages[1].instructions: stage.research.unknown is not available ...`). A reference the flow already had before
 * this save (`previous`, the saved drawing) is never refused, nor is any reference when a flow is only read or run:
 * this checks new and changed words alone.
 */
export function stageReferenceProblems(definition: FlowDefinition, previous: FlowDefinition | null): ContractIssue[] {
  const had = new Set((previous?.stages ?? []).flatMap(stage => templateFields(stage).flatMap(field => stageReferences(field.text))));
  const problems: ContractIssue[] = [];
  definition.stages.forEach((stage, index) => {
    for (const field of templateFields(stage)) {
      for (const reference of new Set(stageReferences(field.text))) {
        if (had.has(reference)) continue;
        const problem = stageReferenceProblem(definition, reference);
        const path = `stages[${index}].${field.path}`;
        if (problem !== null) problems.push({ path, kind: "bad-value", line: `${path}: ${problem}` });
      }
    }
  });
  return problems;
}
