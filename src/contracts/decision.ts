/**
 * A parked decision (§7): one schema for the question an agent puts to a person — its recap, the question, two to six
 * options each saying whether it can be undone, and the option it recommends. Agents hand it back as a file (the park
 * mailbox) or, for a Claude scout, as structured output (`--json-schema`, scout-report.ts); `parseDecision`
 * (decision.ts) reads both through `readDecisionPayload`. The options are what the `decision` row keeps.
 *
 * What JSON Schema cannot say runs after parsing, in decision.ts, each with a path-named error: text is not blank once
 * trimmed, carries no control characters (a label or assignee is one line), option ids are unique, the recommendation
 * names one of them, and a deadline is a timestamp.
 */

import { z } from "zod";
import { limited, readVersioned, toModelSchema, versioned, type ContractResult } from "./contract.js";

/** How many options fit on one screen, and the fewest that make a decision. */
export const DECISION_OPTIONS_MIN = 2;
export const DECISION_OPTIONS_MAX = 6;

/** Option ids travel in URLs, CLI arguments, and CAS updates — they are identifiers, not prose. */
export const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** One option: its id, a one-line label, what choosing it does, and whether it can be undone (never defaulted). */
export const decisionOptionSchema = z.strictObject({
  id: limited("option id", "decisionOptionId").regex(OPTION_ID, { error: "must be letters, digits, - or _, starting with a letter or digit" }),
  label: limited("option label", "decisionLabel").min(1),
  consequence: limited("option consequence", "decisionConsequence").min(1),
  reversible: z.boolean(),
});

export type DecisionOption = z.infer<typeof decisionOptionSchema>;

export const DECISION_VERSION = 1;

export const decisionSchema = versioned(DECISION_VERSION, {
  /** Required rather than defaulted: an agent that did not say whether the loop can continue has not composed a decision. */
  urgency: z.literal("blocking"),
  recap: limited("recap", "decisionRecap").min(1),
  question: limited("question", "decisionQuestion").min(1),
  options: z.array(decisionOptionSchema).min(DECISION_OPTIONS_MIN).max(DECISION_OPTIONS_MAX),
  /** An option's id. */
  recommendation: limited("recommendation", "decisionOptionId").min(1),
  assignee: limited("assignee", "decisionAssignee").min(1).nullable().optional(),
  /** An ISO 8601 timestamp. */
  deadline: z.string().nullable().optional(),
});

export type DecisionPayload = z.infer<typeof decisionSchema>;

/** What a Claude scout's question branch is (scout-report.ts): the decision schema, exactly. */
export const DECISION_MODEL_SCHEMA: Readonly<Record<string, unknown>> = toModelSchema(decisionSchema);

const DECISION_FIELDS = Object.keys(decisionSchema.shape).filter(field => field !== "version");
const OPTION_FIELDS = Object.keys(decisionOptionSchema.shape);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function pick(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

/**
 * A decision written without `version` (every park file and saved decision through 0.9.36, and what agents are still
 * asked to write), as version 1. The old parser read only the fields it knew, in the payload and in each option, and
 * ignored any others; this keeps exactly that. Values themselves are never rewritten.
 */
export function upgradeUnversionedDecision(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { version: DECISION_VERSION, ...pick(body, DECISION_FIELDS) };
  if (Array.isArray(out["options"])) out["options"] = out["options"].map(option => (isRecord(option) ? pick(option, OPTION_FIELDS) : option));
  return out;
}

export const DECISION_UPGRADES = { 0: upgradeUnversionedDecision } as const;

/** Read a decision payload: version 1 as itself, an unversioned one upgraded, a newer one refused plainly. */
export function readDecisionPayload(input: unknown): ContractResult<DecisionPayload> {
  return readVersioned(decisionSchema, input, DECISION_UPGRADES);
}
