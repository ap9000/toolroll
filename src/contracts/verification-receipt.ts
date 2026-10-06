/**
 * The machine verification receipt (`verification-receipt.json`): one schema for what `sealVerificationReceipt`
 * writes and what `verificationEvidence` reads back. Only the machine writes it, from typed values, so every receipt
 * ever sealed already has exactly this shape; the bindings that need the store — the run, its candidate, the approved
 * command, the retained log and a reused gate's source — are checked in plain code after parsing.
 *
 * Version 1 is a gate executed in its own run. Version 2 added `reusedFrom` and `executedHere: false` for a gate
 * reused by an unchanged observation follow-up. A direct receipt is still sealed as version 1, so its bytes (and the
 * digests bound to them) read the same in every Toolroll that reads receipts.
 */

import { z } from "zod";
import { readVersioned, versioned, type ContractResult } from "./contract.js";

export const VERIFICATION_FAILURES = [
  "spawn-failed",
  "timed-out",
  "dependency-missing",
  "setup-stale",
  "setup-failed",
  "own-install-failed",
  "tracked-files-changed",
  "setup-changed-files",
  "checkout-moved",
  "cleanliness-unavailable",
  "dependency-still-missing",
  "retry-spawn-failed",
  "retry-timed-out",
  "custody-lost",
] as const;

/**
 * What the repository's approved verification command did: not configured; configured but the run could not attempt
 * it (`attemptFailed`, which downgrades to `short` rather than `refuted`: "we could not check" is not "the claim is
 * false"); or ran, with its exit code.
 */
export const verifyCommandFactsSchema = z.union([
  z.strictObject({ configured: z.literal(false) }),
  z.strictObject({ configured: z.literal(true), ran: z.literal(false), attemptFailed: z.literal(true), failure: z.enum(VERIFICATION_FAILURES).optional() }),
  z.strictObject({ configured: z.literal(true), ran: z.literal(true), exitCode: z.int().min(0).max(255), setupReplayed: z.literal(true).optional() }),
]);

export type VerifyCommandFacts = z.infer<typeof verifyCommandFactsSchema>;

/** The approved verification grant the gate ran, exactly as the store held it. */
export const receiptCommandSchema = z.strictObject({
  id: z.int(),
  repo: z.string(),
  command: z.string(),
  timeoutMs: z.int(),
  digest: z.string(),
  recoverySetupDigest: z.string().nullable(),
  approvedBy: z.string(),
  approvedAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: z.string().nullable(),
});

/** The retained check log the receipt binds, by artifact id and content. */
export const receiptLogSchema = z.strictObject({
  artifactId: z.int(),
  sha256: z.string(),
  bytesStored: z.int(),
  bytesOriginal: z.int(),
  truncated: z.boolean(),
  redacted: z.boolean(),
  captureStatus: z.enum(["ok", "failed"]).nullable(),
});

export const RECEIPT_VERSION = 2;

const receiptFields = {
  run: z.int(),
  head: z.string(),
  base: z.string().nullable(),
  scopeDigest: z.string().nullable(),
};

/** The receipt as read: a reused gate names its source run and digest; a direct one names neither. */
export const verificationReceiptSchema = versioned(RECEIPT_VERSION, {
  ...receiptFields,
  reusedFrom: z.strictObject({ run: z.int(), digest: z.string() }).optional(),
  executedHere: z.literal(false).optional(),
  command: receiptCommandSchema,
  result: verifyCommandFactsSchema,
  log: receiptLogSchema,
});

export type VerificationReceipt = z.infer<typeof verificationReceiptSchema>;

/** A version 1 receipt read as version 2: the same fields. Reuse is a version 2 field; a version 1 receipt naming it
 * is refused by its reader, which still knows the version it was sealed as. */
export function upgradeDirectReceipt(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, version: RECEIPT_VERSION };
}

export const RECEIPT_UPGRADES = { 1: upgradeDirectReceipt } as const;

/** Read a receipt: version 2 as itself, version 1 as a direct gate, a newer one refused plainly. */
export function readVerificationReceipt(input: unknown): ContractResult<VerificationReceipt> {
  return readVersioned(verificationReceiptSchema, input, RECEIPT_UPGRADES);
}
