/**
 * The automatic build review's findings (build-review.ts): one schema for the reply a reviewer gives, the `findings`
 * a Claude reviewer's `--json-schema` describes (provider.ts, inside the review channel it shares with evidence
 * reviews), and what `build_review.findings_json` keeps. `parseBuildFindings` (reviewer.ts) reads a reply through it;
 * a saved row is the same payload, written by `settle` after that read.
 *
 * As before, controls and runs of whitespace collapse to one space before text limits are checked. Unknown keys
 * are ignored in both the review envelope and each finding.
 */

import { z } from "zod";
import { TEXT_LIMITS } from "../text-limits.js";
import { limited, readVersioned, toModelSchema, versioned, type ContractResult } from "./contract.js";

export const FINDING_SEVERITIES = ["HIGH", "MEDIUM", "LOW"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** How many findings one review may raise. */
export const FINDINGS_MAX = 40;

/** One finding: how bad, where (a path and the closest line), and how it fails, in one sentence. */
export const buildFindingSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES),
  file: limited("file", "reviewPath").min(1).describe(`file: at most ${TEXT_LIMITS.reviewPath} characters, on one line.`),
  line: z.number().min(1).multipleOf(1),
  scenario: limited("scenario", "reviewNote").min(1).describe(`scenario: at most ${TEXT_LIMITS.reviewNote} characters, on one line.`),
});

export type BuildFinding = z.infer<typeof buildFindingSchema>;

export const FINDINGS_VERSION = 1;

export const buildFindingsSchema = versioned(FINDINGS_VERSION, {
  findings: z.array(buildFindingSchema).max(FINDINGS_MAX),
}).strip();

export type BuildFindings = z.infer<typeof buildFindingsSchema>;

/** The `findings` a reviewer's structured reply may carry (provider.ts's review channel), from the same schema. */
export const FINDINGS_MODEL_SCHEMA: Readonly<Record<string, unknown>> = toModelSchema(buildFindingsSchema.shape.findings);

/** Read a findings payload: version 1 as itself, a newer one refused plainly, anything else by path. */
export function readBuildFindings(input: unknown): ContractResult<BuildFindings> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const body = input as Record<string, unknown>;
    if (Array.isArray(body["findings"])) {
      input = { ...body, findings: body["findings"].map(entry => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
        const finding = { ...entry } as Record<string, unknown>;
        for (const key of ["file", "scenario"] as const) {
          const text = finding[key];
          if (typeof text === "string") finding[key] = text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim();
        }
        return finding;
      }) };
    }
  }
  return readVersioned(buildFindingsSchema, input);
}
