/**
 * A parked decision (§7): one schema for the question an agent puts to a person — its recap, the question, two to six
 * options each saying whether it can be undone, and the option it recommends. Agents hand it back as a file (the park
 * mailbox); `DECISION_MODEL_SCHEMA` is exported for the scout contract migration to wire into structured output.
 * `parseDecision` (decision.ts) reads decisions through `readDecisionPayload`. The options are what the `decision`
 * row keeps. The existing unversioned format ignores unknown fields, including a field named `version`.
 *
 * What JSON Schema cannot say runs after parsing, in decision.ts, each with a path-named error: text is not blank once
 * trimmed, carries no control characters (a label or assignee is one line), option ids are unique, the recommendation
 * names one of them, and a deadline is a timestamp.
 */

import { z } from "zod";
import { limited, parseContract, toModelSchema, type ContractResult } from "./contract.js";

/** How many options fit on one screen, and the fewest that make a decision. */
export const DECISION_OPTIONS_MIN = 2;
export const DECISION_OPTIONS_MAX = 6;

/** Option ids travel in URLs, CLI arguments, and CAS updates — they are identifiers, not prose. */
export const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** One option: its id, a one-line label, what choosing it does, and whether it can be undone (never defaulted). */
export const decisionOptionSchema = z.object({
  id: limited("option id", "decisionOptionId").regex(OPTION_ID, { error: "must be letters, digits, - or _, starting with a letter or digit" }),
  label: limited("option label", "decisionLabel").min(1),
  consequence: limited("option consequence", "decisionConsequence").min(1),
  reversible: z.boolean(),
});

export type DecisionOption = z.infer<typeof decisionOptionSchema>;

export const decisionSchema = z.object({
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

/** The decision schema for the scout migration's question branch. */
export const DECISION_MODEL_SCHEMA: Readonly<Record<string, unknown>> = toModelSchema(decisionSchema);

/** Read the existing decision format, ignoring keys it never used. */
export function readDecisionPayload(input: unknown): ContractResult<DecisionPayload> {
  return parseContract(decisionSchema, input);
}
