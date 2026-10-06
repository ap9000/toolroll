/**
 * The task sizing classifier's answer (task-sizing.ts): one schema for the JSON Schema a Claude sizer is given
 * (`--json-schema`) and the reader that takes an answer back. Jev answers through OpenRouter's Decisions API, which
 * takes questions rather than a JSON Schema; its choice and yes/no are read into this same answer before they count.
 *
 * An answer is never kept as it is (it becomes the task's sizing, phase-routing.ts `TaskSizing`), so it carries no
 * version.
 */

import { z } from "zod";
import { TASK_SIZES, type TaskSize } from "../phase-routing.js";
import { limited, parseContract, toModelSchema, type ContractResult } from "./contract.js";

export const sizeAnswerSchema = z.strictObject({
  size: z.enum(TASK_SIZES as readonly TaskSize[] as [TaskSize, ...TaskSize[]]),
  risky: z.boolean(),
  reason: limited("reason", "sizingReason"),
});

export type SizeAnswer = z.infer<typeof sizeAnswerSchema>;

/** What a Claude sizer's `--json-schema` is: the answer schema, exactly. */
export const SIZING_MODEL_SCHEMA: Readonly<Record<string, unknown>> = toModelSchema(sizeAnswerSchema);

/** Read an answer: one of the three sizes, a yes/no and a short reason, or path-named lines saying what is wrong. */
export function readSizeAnswer(value: unknown): ContractResult<SizeAnswer> {
  return parseContract(sizeAnswerSchema, value);
}
