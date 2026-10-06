/**
 * The builder's proof: one schema for the file a builder writes (the proof manifest), the `proof.json` the machine
 * stores, and the reader that reads both back (`parseProof` in proof.ts). The rules JSON Schema cannot state — UTF-8
 * byte limits, blank text, control characters, relative screenshot paths and duplicate ids or paths — run in plain
 * code after parsing, each with a path-named error.
 */

import { z } from "zod";
import { TEXT_LIMITS } from "../text-limits.js";
import { EVIDENCE_KINDS, type EvidenceKind } from "../scope.js";
import { limited, readVersioned, versioned, type ContractResult } from "./contract.js";

/** How many entries each proof list may hold. Text limits live in TEXT_LIMITS. */
export const PROOF_COUNTS = { criteria: 12, evidencePerCriterion: 4, checks: 12, changed: 64, caveats: 8, screenshots: 8 } as const;

/** Every proof limit by its long-standing name: the counts above and the byte limits from TEXT_LIMITS. */
export const PROOF_LIMITS = {
  payload: TEXT_LIMITS.proofPayloadBytes,
  ...PROOF_COUNTS,
  criterionId: TEXT_LIMITS.proofCriterionIdBytes,
  criterionStatement: TEXT_LIMITS.proofLineBytes,
  criterionHow: TEXT_LIMITS.proofHowBytes,
  evidenceRef: TEXT_LIMITS.proofLineBytes,
  checkCommand: TEXT_LIMITS.proofLineBytes,
  checkSummary: TEXT_LIMITS.proofLineBytes,
  changedPath: TEXT_LIMITS.proofLineBytes,
  caveat: TEXT_LIMITS.proofLineBytes,
  screenshotPath: TEXT_LIMITS.proofLineBytes,
  screenshotCaption: TEXT_LIMITS.proofLineBytes,
} as const;

export const CRITERION_VERDICTS = ["met", "not-met", "not-checked", "pending-verification"] as const;

const line = (field: string) => limited(field, "proofLineBytes").min(1);

/** One typed reference a criterion cites: an existing check's command, screenshot's path, a path in `changed`, or
 * (kind `manual-review`) free text pointing at nothing machine-checkable. */
export const criterionEvidenceSchema = z.strictObject({
  kind: z.enum(EVIDENCE_KINDS as readonly EvidenceKind[] as [EvidenceKind, ...EvidenceKind[]]),
  ref: line("evidence ref"),
});

/** One criterion the proof answers. `pending-verification` asserts all agent-owned work is met and only the
 * machine-owned final check remains. */
export const proofCriterionSchema = z.strictObject({
  id: limited("criterion id", "proofCriterionIdBytes").min(1),
  statement: line("criterion statement"),
  how: limited("criterion how", "proofHowBytes").min(1),
  verdict: z.enum(CRITERION_VERDICTS),
  evidence: z.array(criterionEvidenceSchema).max(PROOF_COUNTS.evidencePerCriterion),
});

export const proofCheckSchema = z.strictObject({
  command: line("check command"),
  summary: line("check summary"),
  exitCode: z.int().min(0).max(255),
});

/** A screenshot the proof claims; its path is where the file lived in the worktree, its bytes are checked by the
 * caller. */
export const proofScreenshotSchema = z.strictObject({
  path: line("screenshot path"),
  caption: line("screenshot caption"),
});

export const PROOF_VERSION = 2;

/** The proof as stored and as every reader returns it: every list present, nothing unknown. */
export const proofSchema = versioned(PROOF_VERSION, {
  criteria: z.array(proofCriterionSchema).max(PROOF_COUNTS.criteria),
  checks: z.array(proofCheckSchema).max(PROOF_COUNTS.checks),
  changed: z.array(line("changed path")).max(PROOF_COUNTS.changed),
  caveats: z.array(line("caveat")).max(PROOF_COUNTS.caveats),
  screenshots: z.array(proofScreenshotSchema).max(PROOF_COUNTS.screenshots),
});

export type ParsedProof = z.infer<typeof proofSchema>;
export type ParsedCriterion = z.infer<typeof proofCriterionSchema>;
export type CriterionEvidenceRef = z.infer<typeof criterionEvidenceSchema>;
export type ParsedCheck = z.infer<typeof proofCheckSchema>;
export type ParsedScreenshot = z.infer<typeof proofScreenshotSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The listed fields of `body`, a null or missing one left out (the old parser read null text as missing). */
function pick(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (body[field] !== undefined && body[field] !== null) out[field] = body[field];
  }
  return out;
}

const each = (value: unknown, fields: readonly string[]) => (Array.isArray(value) ? value.map(one => (isRecord(one) ? pick(one, fields) : one)) : value);

/**
 * A version 1 proof — what a builder writes (`{ "version": 1, "screenshots": [...] }`) and every proof stored through
 * 0.9.34 — as version 2. Version 1 read only the fields it knew and ignored any others, and read a missing or null
 * list (a criterion's `evidence` too) as empty; this keeps exactly that. Values themselves are never rewritten.
 */
export function upgradeProofV1(body: Record<string, unknown>): Record<string, unknown> {
  const list = (field: string) => (body[field] === undefined || body[field] === null ? [] : body[field]);
  const criteria = list("criteria");
  return {
    version: PROOF_VERSION,
    criteria: Array.isArray(criteria)
      ? criteria.map(one => {
          if (!isRecord(one)) return one;
          const evidence = one["evidence"] === undefined || one["evidence"] === null ? [] : one["evidence"];
          return { ...pick(one, ["id", "statement", "how", "verdict"]), evidence: each(evidence, ["kind", "ref"]) };
        })
      : criteria,
    checks: each(list("checks"), ["command", "summary", "exitCode"]),
    changed: list("changed"),
    caveats: list("caveats"),
    screenshots: each(list("screenshots"), ["path", "caption"]),
  };
}

export const PROOF_UPGRADES = { 1: upgradeProofV1 } as const;

/** The payload as version 2 (upgraded from version 1 when needed), for the plain-code rules; null for a non-object. */
export function proofPayloadBody(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  return input["version"] === 1 ? upgradeProofV1(input) : input;
}

/** Read a proof payload: version 2 as itself, version 1 upgraded, a newer one refused plainly. */
export function readProofPayload(input: unknown): ContractResult<ParsedProof> {
  return readVersioned(proofSchema, input, PROOF_UPGRADES);
}
