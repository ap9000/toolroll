/**
 * The machine verification receipt (`verification-receipt.json`): one schema for what `sealVerificationReceipt`
 * writes and what `verificationEvidence` reads back. Only the machine writes it, from typed values, so every receipt
 * ever sealed already has exactly this shape; the bindings that need the store — the run, its candidate, the approved
 * command, the retained log and a reused gate's source — are checked in plain code after parsing.
 *
 * Version 1 is a gate executed in its own run. Version 2 added `reusedFrom` and `executedHere: false` for a gate
 * reused by an unchanged observation follow-up. Version 3 (docs/plans/release-once.md) is a release check: it keeps
 * the raw exit (`result`) apart from `coverage` — `full`, `composed` (a targeted run composed with the full check A),
 * `partial` (never passes) or `identity-removed` (a required test went away; asks again) — names the sealed check
 * artifacts, and for a composed check every link its reader proves again. A direct receipt is still sealed as version 1,
 * so its bytes (and the digests bound to them) read the same in every Toolroll that reads receipts.
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
  // A release check that didn't cover what it owed, or lost a required test (release-once.md): never a pass.
  "coverage-incomplete",
  // A Full release check with no complete, valid result (check-report.ts fullCheckProblem): an error, never a pass.
  "no-result",
  // Toolroll's own shutdown stopped the check (its hard stop): it never finished.
  "stopped-by-toolroll",
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

export const RECEIPT_VERSION = 3;

export const RECEIPT_COVERAGES = ["full", "composed", "partial", "identity-removed", "no-result"] as const;
export type ReceiptCoverage = typeof RECEIPT_COVERAGES[number];

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
  /** Version 3: what the check covered, apart from its exit. */
  coverage: z.enum(RECEIPT_COVERAGES).optional(),
  /** Version 3: the attempt sealed before the check ran, and its sealed report (null: it gave none). */
  check: z.strictObject({ attempt: z.enum(["full", "targeted"]), report: z.string().nullable(), inventory: z.string().nullable(),
    /** The command's own exit, kept here when `result` reads a failed attempt because the coverage fell short. */
    exitCode: z.int().min(0).max(255).nullable().optional() }).optional(),
  /** Version 3, composed: the full check A and every link the reader proves again. */
  composed: z.strictObject({
    base: z.int().min(1), baseReceipt: z.string(), baseReport: z.string(), authority: z.int().min(1), carries: z.array(z.int()),
    artifacts: z.string(), plan: z.string(), snapshot: z.string(), report: z.string(),
  }).optional(),
});

export type VerificationReceipt = z.infer<typeof verificationReceiptSchema>;

/** A version 1 or 2 receipt read as version 3: the same fields. Reuse is a version 2 field and coverage a version 3
 * one; a receipt naming a field newer than it was sealed as is refused by its reader, which still knows the version. */
export function upgradeDirectReceipt(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, version: RECEIPT_VERSION };
}

export const RECEIPT_UPGRADES = { 1: upgradeDirectReceipt, 2: upgradeDirectReceipt } as const;

/** Read a receipt: version 3 as itself, 1 and 2 upgraded, a newer one refused plainly. */
export function readVerificationReceipt(input: unknown): ContractResult<VerificationReceipt> {
  return readVersioned(verificationReceiptSchema, input, RECEIPT_UPGRADES);
}
