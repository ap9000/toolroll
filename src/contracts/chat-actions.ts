/**
 * Shared chat actions (chat-actions.ts): one schema for each action's data — what the lead proposes and what a saved
 * proposal carries after `prepareSharedAction` has checked and rewritten it — and one for the saved proposal itself.
 * The allowed fields (`CHAT_ACTION_FIELDS`) and the request types are derived from these; what JSON Schema can't say
 * (credentials and control characters in text, each field's length, a zone or option that exists, who may act) runs
 * in `prepareSharedAction` after parsing, with its own named refusal.
 *
 * A flow drawing, trigger or script inside a request is read by its own contract (flows.ts `validateFlowDefinition`,
 * flow-triggers.ts `validateTriggerConfig`, flow-scripts.ts `validateScript`) when the action is prepared, in every
 * vocabulary those accept; here it is only "a value".
 */

import { z } from "zod";
import { parseContract, readVersioned, versioned, type ContractIssue, type ContractResult } from "./contract.js";

/** An id the store minted: a positive safe integer. */
const id = z.int().min(1);
const words = z.string();
/** A drawing, trigger or script: read by its own contract when the action is prepared. */
const nested = z.unknown();
const skillFile = z.strictObject({ path: z.string(), base64: z.string() });
/** An object whose keys its own reader knows (a script draft, an action's staleness fence). */
const anyObject = z.object({}).catchall(z.unknown());

/**
 * Each action's data, field order as the lead reads it in `get_actions`. Optional where the action works without it;
 * nullable where a prepared request saves "none" as null (an answer with no option, a card with no owner).
 */
export const chatActionRequestSchemas = {
  skill_import: z.strictObject({ repo: words, content: words.optional(), files: z.array(skillFile).optional() }),
  skill_enable: z.strictObject({ repo: words, version: words }),
  skill_disable: z.strictObject({ repo: words, version: words }),
  skill_restore: z.strictObject({ repo: words, restore: id }),
  skill_test: z.strictObject({ repo: words, version: words, sample: words, nonce: words }),
  knowledge_instructions: z.strictObject({ repo: words, instructions: words.optional() }),
  knowledge_save: z.strictObject({ repo: words, title: words, content: words, id: words.optional() }),
  knowledge_remove: z.strictObject({ repo: words, id: words }),
  knowledge_restore: z.strictObject({ repo: words, restore: id }),
  tool_add: z.strictObject({
    repo: words, catalog: words.optional(), name: words.optional(), command: words.optional(), args: z.array(words).optional(),
    url: words.optional(), secrets: z.array(words).optional(), about: words.optional(),
  }),
  tool_remove: z.strictObject({ repo: words, name: words }),
  flow_create: z.strictObject({ repo: words, name: words, definition: nested, trigger: nested.optional() }),
  flow_starter: z.strictObject({ repo: words, starter: words }),
  flow_edit: z.strictObject({ flow: id, name: words.optional(), definition: nested.optional() }),
  flow_card_add: z.strictObject({ flow: id, title: words, description: words.nullable().optional(), zone: words.optional() }),
  flow_card_move: z.strictObject({ card: id, zone: words }),
  flow_card_approve: z.strictObject({ card: id, note: words.optional() }),
  flow_card_send_back: z.strictObject({ card: id, note: words.optional() }),
  /** An option by its number (from 1), or a reply that becomes the note. */
  flow_card_choose: z.strictObject({ card: id, choice: z.int().nullable().optional(), note: words.optional() }),
  flow_card_cancel: z.strictObject({ card: id }),
  flow_card_comment: z.strictObject({ card: id, note: words }),
  flow_card_assign: z.strictObject({ card: id, owner: words.nullable().optional() }),
  flow_card_watch: z.strictObject({ card: id, watching: z.boolean().optional() }),
  flow_script_save: z.strictObject({ repo: words, script: anyObject }),
  flow_trigger_add: z.strictObject({ flow: id, trigger: nested }),
  flow_trigger_pause: z.strictObject({ trigger: id }),
  flow_trigger_resume: z.strictObject({ trigger: id }),
  flow_trigger_remove: z.strictObject({ trigger: id }),
  teammate_create: z.strictObject({ repo: words, template: words.optional(), name: words.optional(), soul: words.optional() }),
  teammate_soul: z.strictObject({ teammate: id, soul: words }),
  teammate_state: z.strictObject({ teammate: id, state: z.enum(["active", "paused", "removed"]) }),
  teammate_note: z.strictObject({ teammate: id, note: words }),
  teammate_answer: z.strictObject({ question: id, choice: words.nullable().optional(), text: words.nullable().optional() }),
  teammate_tools: z.strictObject({
    teammate: id, tool: words, change: z.enum(["grant", "revoke", "rule"]), action: words.optional(), use: z.enum(["free", "ask", "never"]).optional(),
    limitField: words.nullable().optional(), limitOver: z.number().nullable().optional(), undoWith: words.optional(),
  }),
  teammate_memory: z.strictObject({ teammate: id, memory: id, change: z.enum(["edit", "forget"]), text: words.optional() }),
  teammate_routine: z.strictObject({ teammate: id, change: z.enum(["add", "remove"]), routine: id.optional(), schedule: words.optional(), text: words.optional() }),
  teammate_undo: z.strictObject({ teammate: id, call: id }),
  kit_setup: z.strictObject({ repo: words, kit: words }),
  decision_record: z.strictObject({ repo: words, claim: words, why: words, supersedes: id.optional(), source: words.optional() }),
  decision_retire: z.strictObject({ repo: words, decision: id, reason: words }),
  /** The line, and (from 1) the line it replaces; 0 or none adds it. */
  lead_about_you: z.strictObject({ line: words, replaces: z.int().min(0).optional() }),
  scope_approve: z.strictObject({ task: words }),
  result_accept: z.strictObject({ task: words, run: id }),
  task_cancel: z.strictObject({ task: words }),
  task_resume: z.strictObject({ task: words, run: id }),
} as const;

export type ChatActionOperation = keyof typeof chatActionRequestSchemas;
export const CHAT_ACTION_OPERATIONS = Object.keys(chatActionRequestSchemas) as [ChatActionOperation, ...ChatActionOperation[]];
export type ChatActionRequest<O extends ChatActionOperation = ChatActionOperation> = z.infer<(typeof chatActionRequestSchemas)[O]>;

/** The fields each action takes, from its schema. */
export const CHAT_ACTION_FIELDS = Object.fromEntries(
  CHAT_ACTION_OPERATIONS.map(operation => [operation, Object.keys(chatActionRequestSchemas[operation].shape)]),
) as unknown as Record<ChatActionOperation, readonly string[]>;

const isOperation = (value: unknown): value is ChatActionOperation => typeof value === "string" && Object.hasOwn(chatActionRequestSchemas, value);

/** One action's data, refused by path (`card: required`, `payload: unknown key 'cards' (did you mean card?)`). */
export function readChatActionRequest(operation: ChatActionOperation, input: unknown): ContractResult<Record<string, unknown>> {
  return parseContract(chatActionRequestSchemas[operation] as z.ZodType<Record<string, unknown>>, input);
}

export const SHARED_ACTION_VERSION = 1;

/**
 * A prepared action as a proposal saves it: the action, its checked request, the project, the card's title and
 * terms, the stamp that proves nothing changed before it is confirmed, and the state the stamp was taken over (each
 * action's own staleness fence, read back only by that action).
 */
export const sharedActionSchema = versioned(SHARED_ACTION_VERSION, {
  operation: z.enum(CHAT_ACTION_OPERATIONS),
  request: anyObject,
  repo: z.string(),
  title: z.string(),
  terms: z.array(z.string()),
  stamp: z.string(),
  state: anyObject,
});

export type SharedAction = z.infer<typeof sharedActionSchema>;

const SHARED_ACTION_FIELDS = Object.keys(sharedActionSchema.shape).filter(field => field !== "version");

/**
 * A proposal saved before it carried `version` (every one through 0.9.36), as version 1. Its reader took the fields
 * it knew and passed any others through unread, so this keeps exactly the known fields.
 */
export function upgradeUnversionedSharedAction(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { version: SHARED_ACTION_VERSION };
  for (const field of SHARED_ACTION_FIELDS) if (Object.hasOwn(body, field)) out[field] = body[field];
  return out;
}

export const SHARED_ACTION_UPGRADES = { 0: upgradeUnversionedSharedAction } as const;

const under = (prefix: string, issues: readonly ContractIssue[]): ContractIssue[] =>
  issues.map(issue => {
    const path = issue.path === "payload" ? prefix : `${prefix}.${issue.path}`;
    return { ...issue, path, line: `${path}${issue.line.slice(issue.path.length)}` };
  });

/** Read a saved proposal's action: the envelope, then its request by the action's own schema (`request.card: required`). */
export function readSharedAction(input: unknown): ContractResult<SharedAction> {
  const read = readVersioned(sharedActionSchema, input, SHARED_ACTION_UPGRADES);
  if (!read.ok) return read;
  if (!isOperation(read.value.operation)) return { ok: false, issues: [{ path: "operation", kind: "bad-value", line: "operation: not an action" }] };
  const request = readChatActionRequest(read.value.operation, read.value.request);
  return request.ok ? read : { ok: false, issues: under("request", request.issues) };
}
