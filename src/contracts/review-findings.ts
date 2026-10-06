/**
 * The automatic build review's findings (build-review.ts): one schema for the reply a reviewer gives, the `findings`
 * a Claude reviewer's `--json-schema` describes (provider.ts, inside the review channel it shares with evidence
 * reviews), and what `build_review.findings_json` keeps. `parseBuildFindings` (reviewer.ts) reads a reply through it;
 * a saved row is the same payload, written by `settle` after that read.
 *
 * What JSON Schema cannot say runs after parsing, in reviewer.ts: a file or scenario is one line (controls and runs of
 * whitespace collapse to one space) and is not blank once it is.
 */

import { z } from "zod";
import { limited, readVersioned, toModelSchema, versioned, type ContractResult } from "./contract.js";

export const FINDING_SEVERITIES = ["HIGH", "MEDIUM", "LOW"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** How many findings one review may raise. */
export const FINDINGS_MAX = 40;

/** One finding: how bad, where (a path and the closest line), and how it fails, in one sentence. */
export const buildFindingSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES),
  file: limited("file", "reviewPath").min(1),
  line: z.int().min(1),
  scenario: limited("scenario", "reviewNote").min(1),
});

export type BuildFinding = z.infer<typeof buildFindingSchema>;

export const FINDINGS_VERSION = 1;

export const buildFindingsSchema = versioned(FINDINGS_VERSION, {
  findings: z.array(buildFindingSchema).max(FINDINGS_MAX),
});

export type BuildFindings = z.infer<typeof buildFindingsSchema>;

/** The `findings` a reviewer's structured reply may carry (provider.ts's review channel), from the same schema. */
export const FINDINGS_MODEL_SCHEMA: Readonly<Record<string, unknown>> = toModelSchema(buildFindingsSchema.shape.findings);

/** Read a findings payload: version 1 as itself, a newer one refused plainly, anything else by path. */
export function readBuildFindings(input: unknown): ContractResult<BuildFindings> {
  return readVersioned(buildFindingsSchema, input);
}
