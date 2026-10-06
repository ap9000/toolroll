/**
 * The coding handoff receipt: the immutable terms under which a committed desktop coding session became an ordinary
 * review task (`coding_handoff.payload`, coding-handoff.ts). Its bytes are hashed and sealed, and its id is the hash of
 * its terms, so the keys are listed in the order the receipt has always been written in — `version` after the
 * preview — and a parsed receipt serializes to exactly the bytes it was read from. The saved hash, derived identity,
 * branch and scope seal are checked in plain code: the hash before parsing, the rest after.
 */

import { z } from "zod";
import { readVersioned, type ContractResult } from "./contract.js";
import { acceptanceCriterionSchema } from "./plan.js";

export const CODING_HANDOFF_VERSION = 1;

export const codingHandoffReceiptSchema = z.strictObject({
  sessionId: z.string(),
  repo: z.string(),
  base: z.string(),
  candidate: z.string(),
  title: z.string(),
  /** The session's first message, as the person wrote it. */
  originalPrompt: z.string(),
  changedPaths: z.array(z.string()),
  version: z.literal(CODING_HANDOFF_VERSION),
  identity: z.string(),
  actor: z.string(),
  generation: z.int(),
  goal: z.string(),
  acceptance: z.array(acceptanceCriterionSchema),
  outOfScope: z.string(),
  /** The first 32 hex of learningSha over every field above, in this order. */
  id: z.string(),
  taskId: z.string(),
  branch: z.string(),
});

export type CodingHandoffReceipt = z.infer<typeof codingHandoffReceiptSchema>;

/** Read a receipt: version 1 as itself, a newer one refused plainly. Receipts have always carried `version`. */
export function readCodingHandoffReceipt(input: unknown): ContractResult<CodingHandoffReceipt> {
  return readVersioned(codingHandoffReceiptSchema, input, {}, { distinguishNull: true });
}

/** Read a receipt's saved bytes: JSON first, then the schema. */
export function parseCodingHandoffReceipt(raw: string): ContractResult<CodingHandoffReceipt> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, issues: [{ path: "payload", kind: "invalid", line: "payload: not JSON" }] };
  }
  return readCodingHandoffReceipt(body);
}
