/**
 * The JSON columns the store reads back (docs/plans/zod-revamp.md, item 18): one schema per `table.column`, read
 * through `readVersioned`. Every writer through 0.9.41 stores the bare value, and writes are unchanged, so a row reads
 * as version 0 and is upgraded in memory only to `{ version: 1, value }`; nothing is rewritten.
 *
 * Each schema accepts exactly what the store's reader accepted before: a list column is any JSON list (its reader
 * keeps filtering, coercing, clipping and defaulting the items after parsing), and a column the old code cast holds
 * any JSON value, kept exactly as parsed. Shapes another contract owns are read by it, not here: a scope's or
 * routine's `acceptance_json` (`scope.ts`), routes (`route.ts`), a card's outputs (`stage-output.ts`), a flow
 * send (`flow-send.ts`), chat tables (`chat-tables.ts`), a saved proposal's action (`chat-actions.ts`).
 */

import { z } from "zod";
import type { DecisionOption } from "./decision.js";
import { readVersioned, versioned, type ContractIssue, type ContractResult } from "./contract.js";

/** Any JSON value, exactly as `JSON.parse` made it (the old reader's cast): nothing is copied, stripped or checked. */
const asSaved = <T>() => z.unknown() as unknown as z.ZodType<T>;

/** A JSON list; its reader filters, coerces and clips the items after parsing, as before. */
const savedList = z.array(z.unknown());

/** An object with a text `label`: a card's source (its reader keeps picking the fields it knows). */
const cardSource = z.looseObject({ label: z.string() });

/** A teammate's rule for one tool action, as `teammates.ts` writes it. */
type SavedToolRule = { use: "free" | "ask" | "never"; limit?: { field: string; over: number }; undo?: string };
type SavedToolAction = { name: string; about: string; input: Record<string, unknown> | null; readOnly: boolean };

const STORE_COLUMN_VALUES = {
  "run_check.suites_json": savedList,
  "teammate_suggestion.rule_json": asSaved<SavedToolRule>(),
  "teammate_suggestion.was_json": asSaved<SavedToolRule>(),
  "teammate_suggestion.evidence_json": asSaved<number[]>(),
  "teammate_call.input_json": asSaved<Record<string, unknown>>(),
  "teammate_grant.actions_json": asSaved<SavedToolAction[]>(),
  "teammate_grant.rules_json": asSaved<Record<string, SavedToolRule>>(),
  "teammate_question.options_json": asSaved<{ id: string; label: string }[]>(),
  "teammate_event.detail_json": asSaved<Record<string, unknown>>(),
  "flow_card.source_json": cardSource,
  "flow_comment.mentions_json": savedList,
  "task_scope.touches": savedList,
  /** Read by the scope contract's `parseAcceptanceCriteria` (`scope.ts`), which owns the criterion's shape. */
  "task_scope.acceptance_json": asSaved<unknown>(),
  "operating_mode.terms_json": asSaved<Record<string, unknown>>(),
  "attended_authorization.terms_json": asSaved<{ profileJson?: unknown }>(),
  "approval_policy.protected_paths": savedList,
  "fallback_config.entries_json": savedList,
  "runner.repos": savedList,
  "runner.agents": savedList,
  "decision.options": asSaved<DecisionOption[]>(),
  "tool_seal.tools_json": savedList,
  "run_tool.tools_json": asSaved<{ tools?: unknown; skipped?: unknown }>(),
  /** `json_extract(tools_json, '$.fence')`: the fence an attempt ran with. */
  "run_tool.tools_json.fence": asSaved<{ method: string; paths: number }>(),
  "mate_ask.options_json": asSaved<unknown>(),
  "lead_config.about_json": savedList,
  "mutation.result": asSaved<unknown>(),
  "plan_revision.changed_fields": asSaved<string[]>(),
  "run_checkpoint.snapshot_json": asSaved<unknown>(),
  "telegram_conversation_part.keyboard_json": asSaved<unknown>(),
  "publication_grant.capabilities": asSaved<unknown>(),
  "task_ref.zones": savedList,
  "task_ref.capability_requirements": savedList,
  "routine.touches": savedList,
  "routine.requirements": savedList,
  /** Read by `parseAcceptanceCriteria`, as `task_scope.acceptance_json`. */
  "routine.acceptance_json": asSaved<unknown>(),
  "tournament_terms.agents": asSaved<unknown>(),
  "coordinator_proposal.payload_json": asSaved<Record<string, unknown>>(),
  "coordinator_proposal.outcome_json": asSaved<Record<string, unknown>>(),
  "mate_proposal.payload_json": asSaved<Record<string, unknown>>(),
  "mate_proposal.outcome_json": asSaved<Record<string, unknown>>(),
  "proof_verdict.matrix_json": savedList,
  "proof_verdict.reasons_json": savedList,
  "criterion_review.screenshots_json": savedList,
  "repair_chain.unresolved_json": savedList,
  "external_mirror.paths": savedList,
  "external_mirror.mutations": savedList,
} as const;

export type StoreColumn = keyof typeof STORE_COLUMN_VALUES;
export type StoreColumnValue<C extends StoreColumn> = z.infer<(typeof STORE_COLUMN_VALUES)[C]>;

/** Every JSON column the store reads itself, by `table.column`. */
export const STORE_COLUMNS = Object.keys(STORE_COLUMN_VALUES) as StoreColumn[];

/** One column's versioned envelope: `{ version: 1, value }`, built in memory around the saved bare value. */
export function storeColumnSchema<C extends StoreColumn>(column: C) {
  return versioned(1, { value: STORE_COLUMN_VALUES[column] as (typeof STORE_COLUMN_VALUES)[C] });
}

const SCHEMAS = new Map(STORE_COLUMNS.map(column => [column, storeColumnSchema(column)]));

/** A saved bare value is version 0; its upgrade wraps it. */
const UPGRADES = { 0: (payload: Record<string, unknown>) => ({ version: 1, value: payload["value"] }) };

/** What a column read finds: its value, or why not — `malformed` when the saved text is not JSON at all. */
export type StoreColumnRead<T> = { ok: true; value: T } | { ok: false; malformed: boolean; issues: ContractIssue[] };

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
  const read = readVersioned(SCHEMAS.get(column)!, { value: parsed }, UPGRADES) as ContractResult<{ value: StoreColumnValue<C> }>;
  return read.ok ? { ok: true, value: read.value.value } : { ok: false, malformed: false, issues: read.issues.map(issue => unwrap(issue)) };
}

/** `value.label: required` reads as `label: required`: the envelope is the reader's, not the row's. */
function unwrap(issue: ContractIssue): ContractIssue {
  const at = issue.path === "value" ? "payload" : issue.path.startsWith("value.") ? issue.path.slice(6) : issue.path.startsWith("value[") ? `payload${issue.path.slice(5)}` : issue.path;
  return { ...issue, path: at, line: issue.line.startsWith(`${issue.path}:`) ? `${at}${issue.line.slice(issue.path.length)}` : issue.line };
}

/**
 * Read one saved column value for a reader that let a bad row throw: unreadable JSON throws the same SyntaxError
 * `JSON.parse` threw, and a value its schema refuses throws the path-named lines (a cast column accepts every JSON
 * value, so it never does).
 */
export function parseStoreColumn<C extends StoreColumn>(column: C, raw: unknown): StoreColumnValue<C> {
  const parsed: unknown = JSON.parse(String(raw));
  const read = readVersioned(SCHEMAS.get(column)!, { value: parsed }, UPGRADES) as ContractResult<{ value: StoreColumnValue<C> }>;
  if (!read.ok) throw new Error(`${column}: ${read.issues.map(issue => unwrap(issue).line).join("; ")}`);
  return read.value.value;
}

/** A list of text, as `readJsonArray` always read one: unreadable or not a list is none; non-text items are dropped. */
export function readStoreTextList(column: StoreColumn, raw: unknown): string[] {
  const read = readStoreColumn(column, raw);
  return read.ok && Array.isArray(read.value) ? read.value.filter((one): one is string => typeof one === "string") : [];
}

/** A list read with every item as text (`String(item)`), as reasons and unresolved criteria always were; otherwise none. */
export function readStoreStringifiedList(column: StoreColumn, raw: unknown): string[] {
  const read = readStoreColumn(column, raw);
  return read.ok && Array.isArray(read.value) ? read.value.map(one => String(one)) : [];
}
