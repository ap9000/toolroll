/**
 * The gate view `verificationEvidence` returns as `bytes`: a sealed receipt exactly as sealed (either version), or,
 * for a run from before receipts, the view of its legacy machine log header. Reused gates, failed-check repair and
 * saved assessments read a view back through `readVerificationView`.
 *
 * A legacy view is built by Toolroll from the run's single-attempt log header (the "check log metadata"), its
 * approved command and its candidate inventory; it is never saved, so its schema is strict. A sealed receipt is read
 * by the receipt's own contract.
 */

import { z } from "zod";
import { parseContract, type ContractResult } from "./contract.js";
import { readVerificationReceipt, receiptCommandSchema, receiptLogSchema, verifyCommandFactsSchema, type VerificationReceipt } from "./verification-receipt.js";

export const LEGACY_GATE_SOURCE = "legacy machine log header";

export const legacyGateViewSchema = z.strictObject({
  version: z.literal(1),
  source: z.literal(LEGACY_GATE_SOURCE),
  run: z.int(),
  head: z.string(),
  base: z.string().nullable(),
  /** Left out of the bytes when the run never recorded one. */
  scopeDigest: z.string().nullable().optional(),
  command: receiptCommandSchema,
  result: verifyCommandFactsSchema,
  log: receiptLogSchema,
  /** The diff-stat artifact whose endpoints bound the candidate. */
  candidate: receiptLogSchema,
});

export type LegacyGateView = z.infer<typeof legacyGateViewSchema>;

/** What every view carries. */
export type VerificationView = Pick<VerificationReceipt, "run" | "head" | "base" | "scopeDigest" | "command" | "result" | "log">;

/**
 * Read a view's bytes. The value is the object as written, once its shape is checked: its key order is part of what a
 * reused gate compares and seals again.
 */
export function readVerificationView(bytes: string): ContractResult<VerificationView> {
  let input: unknown;
  try {
    input = JSON.parse(bytes);
  } catch {
    return { ok: false, issues: [{ path: "payload", kind: "wrong-type", line: "payload: is not JSON" }] };
  }
  const legacy = typeof input === "object" && input !== null && (input as { source?: unknown }).source !== undefined;
  const read = legacy ? parseContract(legacyGateViewSchema, input) : readVerificationReceipt(input);
  return read.ok ? { ok: true, value: input as VerificationView } : read;
}
