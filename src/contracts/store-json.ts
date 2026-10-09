/**
 * The JSON columns the store reads back (docs/plans/zod-revamp.md, item 18): one schema per `table.column`, read
 * through `readVersioned`. Every writer through 0.9.41 stores the bare value, and writes are unchanged, so a row reads
 * as version 0 and is upgraded in memory only to `{ version: 1, value }`; nothing is rewritten.
 *
 * Existing field contracts describe known shapes, without imposing their write-time limits on old rows.
 * Legacy cast-only readers also accepted null,
 * partial objects and wrong-shaped JSON: LEGACY_JSON_COLUMNS names those compatibility exceptions. Such rows keep
 * their original values and report legacyIssues, rather than newly throwing or taking a different fallback.
 * List readers still filter, coerce, clip and default after parsing. No reader serializes a schema's output back.
 * Contracts owned elsewhere stay there: flow.ts, route.ts, stage-output.ts, flow-send.ts and chat-content.ts
 * (chat-tables.ts only owns DDL). Plan and handoff artifacts are files, not JSON columns in store.ts.
 */

import { z } from "zod";
import { decisionOptionSchema } from "./decision.js";
import { scopeTermsSchema, storedRubricSchema } from "./scope.js";
import { criterionEvidenceSchema, proofCriterionSchema } from "./proof.js";
import { sharedActionSchema } from "./chat-actions.js";
import { readVersioned, versioned, type ContractIssue, type ContractResult } from "./contract.js";

/** Dynamic tool arguments, event details and operation results have no common field contract. */
const savedObject = z.looseObject({});

/** A JSON list; its reader filters, coerces and clips the items after parsing, as before. */
const savedList = z.array(z.unknown());

/** An object with a text `label`: a card's source (its reader keeps picking the fields it knows). */
const cardSource = z.looseObject({ label: z.string() });

/** A teammate's rule for one tool action, as `teammates.ts` writes it. */
export const savedToolRuleSchema = z.looseObject({
  use: z.enum(["free", "ask", "never"]),
  limit: z.looseObject({ field: z.string(), over: z.number() }).optional(),
  /** Another action of the same tool that undoes this one with the same input. */
  undo: z.string().optional(),
});
export const savedToolActionSchema = z.looseObject({
  name: z.string(), about: z.string(), input: savedObject.nullable(), readOnly: z.boolean(),
});
export type SavedToolRule = z.infer<typeof savedToolRuleSchema>;
export type SavedToolAction = z.infer<typeof savedToolActionSchema>;

// Reuse the option's canonical fields, dropping only write-time text bounds on a saved row.
export const savedDecisionOptionSchema = decisionOptionSchema.extend({
  id: z.string(), label: z.string(), consequence: z.string(),
}).loose();
const savedQuestionOptionSchema = savedDecisionOptionSchema.pick({ id: true, label: true });
const savedFenceSchema = z.looseObject({ method: z.string(), paths: z.number() });
const savedToolsSchema = z.looseObject({
  tools: savedList.optional(), skipped: savedList.optional(), fence: savedFenceSchema.optional(),
});
const savedModeTermsSchema = z.looseObject({
  dailyRunCap: z.number().nullable().optional(), dailyMeasuredCapMicrousd: z.number().nullable().optional(),
  reviewAuto: z.boolean().optional(), quickMint: z.boolean().optional(), publication: z.string().optional(),
});
const savedProgressSchema = z.looseObject({
  revisionHash: z.string(),
  milestones: z.array(z.looseObject({
    id: z.string(), state: z.enum(["pending", "current", "completed", "blocked"]), note: z.string().nullable().optional(),
  })),
});
const savedMatrixRowSchema = proofCriterionSchema.pick({ id: true, statement: true }).extend({
  id: z.string(), statement: z.string(), requiredEvidence: savedList, state: z.string(), detail: savedList,
  answered: z.array(criterionEvidenceSchema.extend({ ref: z.string() }).loose()).optional(),
  review: z.looseObject({ judgement: z.string(), note: z.string(), author: z.string() }).nullable().optional(),
}).loose();

const STORE_COLUMN_VALUES = {
  "run_check.suites_json": savedList,
  "teammate_suggestion.rule_json": savedToolRuleSchema,
  "teammate_suggestion.was_json": savedToolRuleSchema,
  "teammate_suggestion.evidence_json": z.array(z.number()),
  "teammate_call.input_json": savedObject,
  "teammate_tool.actions_json": z.array(savedToolActionSchema),
  "teammate_tool.rules_json": z.object({}).catchall(savedToolRuleSchema),
  "teammate_question.options_json": z.array(savedQuestionOptionSchema),
  "teammate_event.detail_json": savedObject,
  "flow_card.source_json": cardSource,
  "flow_comment.mentions_json": savedList,
  "task_scope.touches": z.lazy(() => scopeTermsSchema.unwrap().shape.touches.unwrap()),
  /** Read by the scope contract's `parseAcceptanceCriteria` (`scope.ts`), which owns the criterion's shape. */
  "task_scope.acceptance_json": storedRubricSchema,
  "operating_mode.terms_json": savedModeTermsSchema,
  "approval_policy.protected_paths": savedList,
  "runner.repos": savedList,
  "runner.agents": savedList,
  "decision.options": z.array(savedDecisionOptionSchema),
  "tool_seal.tools_json": savedList,
  "run_tool.tools_json": savedToolsSchema,
  /** `json_extract(tools_json, '$.fence')`: the fence an attempt ran with. */
  "run_tool.tools_json.fence": savedFenceSchema,
  "mate_ask.options_json": z.array(z.string()),
  "lead_config.about_json": savedList,
  "mutation.result": z.unknown(),
  "plan_revision.changed_fields": z.array(z.string()),
  "run_checkpoint.snapshot_json": savedProgressSchema,
  "publication_grant.capabilities": z.array(z.enum(["push-branch", "open-pr"])),
  "task_ref.zones": savedList,
  "task_ref.capability_requirements": savedList,
  "coordinator_proposal.payload_json": savedObject,
  "coordinator_proposal.outcome_json": savedObject,
  // Other proposal kinds have operation-specific fields; the action variant already has a canonical contract.
  "mate_proposal.payload_json": z.union([sharedActionSchema, savedObject]),
  "mate_proposal.outcome_json": savedObject,
  "proof_verdict.matrix_json": z.array(savedMatrixRowSchema),
  "proof_verdict.reasons_json": savedList,
  "criterion_review.screenshots_json": savedList,
  "repair_chain.unresolved_json": savedList,
  "backend_grant.paths": savedList,
  "backend_grant.mutations": savedList,
} as const;

export type StoreColumn = keyof typeof STORE_COLUMN_VALUES;
export type StoreColumnValue<C extends StoreColumn> = z.infer<(typeof STORE_COLUMN_VALUES)[C]>;

/** Every JSON column the store reads itself, by `table.column`. */
export const STORE_COLUMNS = (Object.keys(STORE_COLUMN_VALUES) as StoreColumn[]).filter(column => column !== "run_tool.tools_json.fence");
/** A SQL projection, not a physical column; replay it separately after its owning column. */
export const STORE_PROJECTIONS = ["run_tool.tools_json.fence"] as const;

/** These readers historically only parsed JSON. Shape errors must not change their values or catch boundaries. */
export const LEGACY_JSON_COLUMNS: readonly StoreColumn[] = [
  "teammate_suggestion.rule_json", "teammate_suggestion.was_json", "teammate_suggestion.evidence_json",
  "teammate_call.input_json", "teammate_tool.actions_json", "teammate_tool.rules_json", "teammate_question.options_json",
  "teammate_event.detail_json", "task_scope.touches", "task_scope.acceptance_json",
  "operating_mode.terms_json", "decision.options", "run_tool.tools_json",
  "run_tool.tools_json.fence", "mate_ask.options_json", "mutation.result", "plan_revision.changed_fields",
  "run_checkpoint.snapshot_json", "publication_grant.capabilities",
  "coordinator_proposal.payload_json", "coordinator_proposal.outcome_json",
  "mate_proposal.payload_json", "mate_proposal.outcome_json",
];

/** One column's versioned envelope: `{ version: 1, value }`, built in memory around the saved bare value. */
export function storeColumnSchema<C extends StoreColumn>(column: C) {
  return versioned(1, { value: STORE_COLUMN_VALUES[column] as (typeof STORE_COLUMN_VALUES)[C] });
}

const SCHEMAS = new Map([...STORE_COLUMNS, ...STORE_PROJECTIONS].map(column => [column, storeColumnSchema(column)]));

/** A saved bare value is version 0; its upgrade wraps it. */
const UPGRADES = { 0: (payload: Record<string, unknown>) => ({ version: 1, value: payload["value"] }) };

/** What a column read finds: its value, or why not — `malformed` when the saved text is not JSON at all. */
export type StoreColumnRead<T> = { ok: true; value: T; legacyIssues?: ContractIssue[] } | { ok: false; malformed: boolean; issues: ContractIssue[] };

/**
 * Read one saved column value (`String(raw)`, as every reader did) through its schema. Never throws: the caller keeps
 * the fallback its reader always had.
 */
export function readStoreColumn<C extends StoreColumn>(column: C, raw: unknown): StoreColumnRead<StoreColumnValue<C>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    return { ok: false, malformed: true, issues: [{ path: "payload", kind: "invalid", line: `payload: ${column} is not JSON (${error instanceof Error ? error.message : String(error)})` }] };
  }
  return readParsedColumn(column, parsed);
}

function readParsedColumn<C extends StoreColumn>(column: C, parsed: unknown): StoreColumnRead<StoreColumnValue<C>> {
  const read = readVersioned(SCHEMAS.get(column)!, { value: parsed }, UPGRADES) as ContractResult<{ value: StoreColumnValue<C> }>;
  // Return the original JSON, including unknown keys, property order and own __proto__ keys. In particular, never
  // replace old cast-only values with a schema's stripped/defaulted output. A matrix historically accepted any list.
  const legacy = LEGACY_JSON_COLUMNS.includes(column) || (column === "proof_verdict.matrix_json" && Array.isArray(parsed));
  if (read.ok || legacy) return {
    ok: true, value: parsed as StoreColumnValue<C>,
    ...(!read.ok ? { legacyIssues: read.issues.map(unwrap) } : {}),
  };
  return { ok: false, malformed: false, issues: read.issues.map(unwrap) };
}

/** `value.label: required` reads as `label: required`: the envelope is the reader's, not the row's. */
function unwrap(issue: ContractIssue): ContractIssue {
  const at = issue.path === "value" ? "payload" : issue.path.startsWith("value.") ? issue.path.slice(6) : issue.path.startsWith("value[") ? `payload${issue.path.slice(5)}` : issue.path;
  return { ...issue, path: at, line: issue.line.startsWith(`${issue.path}:`) ? `${at}${issue.line.slice(issue.path.length)}` : issue.line };
}

/**
 * Read one saved column value for a reader that let a bad row throw: unreadable JSON throws the same SyntaxError
 * `JSON.parse` threw. Legacy shape issues are advisory; only a previously enforced shape can throw.
 */
export function parseStoreColumn<C extends StoreColumn>(column: C, raw: unknown): StoreColumnValue<C> {
  const parsed: unknown = JSON.parse(String(raw));
  const read = readParsedColumn(column, parsed);
  if (!read.ok) throw new Error(`${column}: ${read.issues.map(issue => issue.line).join("; ")}`);
  return read.value;
}

/** A list of text, as `readJsonArray` always read one: unreadable or not a list is none; non-text items are dropped. */
export function readStoreTextList(column: StoreColumn, raw: unknown): string[] {
  const read = readStoreColumn(column, raw);
  return read.ok && Array.isArray(read.value) ? read.value.filter((one): one is string => typeof one === "string") : [];
}

/** A list read with every item as text (`String(item)`), as reasons and unresolved criteria always were; otherwise none. */
export function readStoreStringifiedList(column: StoreColumn, raw: unknown): string[] {
  const read = readStoreColumn(column, raw);
  try {
    return read.ok && Array.isArray(read.value) ? read.value.map(one => String(one)) : [];
  } catch {
    // JSON objects can shadow toString with a non-function. The old readers caught failed coercion too.
    return [];
  }
}
