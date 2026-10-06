/**
 * A Sort zone's answer (flow-sort.ts): what Jev, through OpenRouter's Decisions API, says about a card, and what a
 * sort step keeps of it. The Decisions API takes questions, not a JSON Schema, so there is no model-facing schema:
 * the request's keys come from the flow contract (`SORT_ROUTE_KEY`, `sortNoteKeyOf`, `sortKeyOf` in flow.ts), and
 * `jevReplySchema` is how the reply is read before anything routes on it.
 *
 * The reply is an outside service's: keys Toolroll does not read (ids, token counts) are ignored rather than refused.
 * Optional metadata can have any type, as before: the reader defaults non-numeric confidences/chances to zero,
 * skips non-numeric notes, and defaults the model and cost. The route choice must still be text.
 *
 * `sortDecisionSchema` is the decision a sort step keeps (`flow_step_run.decision_json`), unversioned as every release
 * has written it; the card, Insights and spend read saved ones as before.
 */

import { z } from "zod";
import { parseContract, type ContractResult } from "./contract.js";
import { flowSortAnswerSchema, flowSortNoteSchema, SORT_ROUTE_KEY } from "./flow.js";

/** Jev's answer to the zone's question: the key of the answer it picked, how sure it is (0–1), and every answer's chance. */
export const jevChoiceSchema = z.object({
  choice: z.string(),
  confidence: z.unknown().optional(),
  probabilities: z.unknown().optional(),
});

/** Jev's answer to something else the zone notes: a score's level (as a number) or a yes/no's chance of yes. */
export const jevNoteSchema = z.object({
  score: z.unknown().optional(),
  noul: z.unknown().optional(),
  confidence: z.unknown().optional(),
});

/** What Toolroll reads of Jev's reply. */
export const jevReplySchema = z.object({
  model: z.unknown().optional(),
  answers: z.object({ [SORT_ROUTE_KEY]: jevChoiceSchema }).catchall(jevNoteSchema),
  usage: z.unknown().optional(),
});

export type JevReply = z.infer<typeof jevReplySchema>;

/** Read Jev's reply, or path-named lines saying what it lacks (`answers.route.choice: required`). */
export function readJevReply(input: unknown): ContractResult<JevReply> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const body = input as Record<string, unknown>;
    const answers = body["answers"];
    if (typeof answers === "object" && answers !== null && !Array.isArray(answers)) {
      // Extra answers are not necessarily notes. Non-objects have no note fields to read, so ignore them.
      input = { ...body, answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key,
        key === SORT_ROUTE_KEY || (typeof value === "object" && value !== null && !Array.isArray(value)) ? value : {},
      ])) };
    }
  }
  return parseContract(jevReplySchema, input);
}

const noteShape = flowSortNoteSchema.options[0].shape;

/** One thing the zone also noted, as the card shows it: the level or yes/no, and how sure (0–1). */
export const sortNoteAnswerSchema = z.strictObject({
  id: noteShape.id,
  question: noteShape.question.describe("The question the zone also notes."),
  kind: z.enum(["score", "yes-no"]),
  answer: z.string(),
  sure: z.number().min(0).max(1),
});

export type SortNoteAnswer = z.infer<typeof sortNoteAnswerSchema>;

/** What a sort step decided, kept on its run (decision_json) and shown on the card. */
export const sortDecisionSchema = z.strictObject({
  model: z.string(),
  /** The answer as the zone names it, and how sure Jev was (0–1). */
  answer: flowSortAnswerSchema.shape.answer.describe("The zone's chosen answer."),
  sure: z.number().min(0).max(1),
  sureAt: z.number(),
  /** Sure enough to act alone, and where the card went (null: it waited in the zone). */
  confident: z.boolean(),
  to: flowSortAnswerSchema.shape.to.nullable(),
  /** Every answer's chance, by name. */
  chances: z.object({}).catchall(z.number()),
  notes: z.array(sortNoteAnswerSchema),
  cost: z.number().nullable(),
  ms: z.number(),
});

export type SortDecision = z.infer<typeof sortDecisionSchema>;

/** Read a sort decision as a step keeps it. */
export function readSortDecision(input: unknown): ContractResult<SortDecision> {
  return parseContract(sortDecisionSchema, input);
}
