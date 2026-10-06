/**
 * The memory pass (memory-pass.ts): one schema for the verdict a model returns on one session — the analyser's
 * `--json-schema` (Codex's output schema) and the parser of its answer — the verdict as each session keeps it
 * (`memory_session.verdict`), and a proposal with its evidence (`memory_proposal`). What JSON Schema cannot state —
 * a quote really in the trace, an instruction id on the surface audited — is checked in plain code after parsing.
 */

import { z } from "zod";
import type { TextLimitKey } from "../text-limits.js";
import { limited, readVersioned, toModelSchema, versioned, type ContractResult } from "./contract.js";

export const MEMORY_EFFECTS = ["harm", "non-compliance", "irrelevant"] as const;
export const MEMORY_DOMAINS = ["project", "orchestration"] as const;
export const MEMORY_PROPOSAL_KINDS = ["instruction-add", "instruction-remove", "decision-add"] as const;

/** A text field: bounded by its TEXT_LIMITS entry for the model, read as saved (verdicts kept through 0.9.36 clipped
 * a long field and marked the cut with `…`, one past the limit). */
type Text = (field: string, key: TextLimitKey) => z.ZodString;
const bounded: Text = limited;
const saved: Text = () => z.string();

const verdictShape = (text: Text) => {
  const instruction = z.string().describe("An instruction's id from INSTRUCTIONS, such as IN-001.");
  const quote = text("quote", "memoryTrace").describe("Copied verbatim from the trace, at least 12 characters.");
  return {
    positive: z.array(z.strictObject({ instruction, effect: text("effect", "memoryEffect"), quote })),
    negative: z.array(z.strictObject({ instruction, effect: text("effect", "memoryEffect"), class: z.enum(MEMORY_EFFECTS), quote })),
    gaps: z.array(z.strictObject({
      mistake: text("mistake", "memoryMistake"),
      proposedInstruction: text("proposed instruction (one imperative sentence)", "memoryInstruction"),
      domain: z.enum(MEMORY_DOMAINS),
      quote,
      matchesGap: z.string().nullable().describe("The key of a gap already on the books when it is the same underlying gap, otherwise null."),
    })),
  };
};

/** The verdict a model returns on one session. */
export const memoryVerdictSchema = z.strictObject(verdictShape(bounded));

/** What the analyser is told to return: `--json-schema` for Claude, the output schema for Codex, and the prompt for
 * every other provider. */
export const MEMORY_VERDICT_MODEL_SCHEMA = toModelSchema(memoryVerdictSchema);

export type Verdict = z.infer<typeof memoryVerdictSchema>;

export const MEMORY_VERDICT_VERSION = 1;

/** A verdict as a session keeps it. */
export const savedVerdictSchema = versioned(MEMORY_VERDICT_VERSION, verdictShape(saved));

export type SavedVerdict = z.infer<typeof savedVerdictSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A verdict kept before it carried `version` (through 0.9.36), as version 1. Those left a gap's `matchesGap` out when
 * there was none; that reads as null. Values are never rewritten.
 */
export function upgradeVerdictV0(body: Record<string, unknown>): Record<string, unknown> {
  const gaps = body["gaps"];
  return {
    version: MEMORY_VERDICT_VERSION,
    ...body,
    ...(Array.isArray(gaps) ? { gaps: gaps.map(gap => (isRecord(gap) && !Object.prototype.hasOwnProperty.call(gap, "matchesGap") ? { ...gap, matchesGap: null } : gap)) } : {}),
  };
}

export const MEMORY_VERDICT_UPGRADES = { 0: upgradeVerdictV0 } as const;

/** Read a kept verdict: version 1 as itself, an unversioned one upgraded, a newer one refused plainly. */
export function readSavedVerdict(input: unknown): ContractResult<SavedVerdict> {
  return readVersioned(savedVerdictSchema, input, MEMORY_VERDICT_UPGRADES);
}

/** One corroborating sighting: the session and its verbatim quote. A proposal keeps at most six. */
export const memoryEvidenceSchema = z.array(z.strictObject({ session: z.string(), quote: z.string() })).max(6);

export type MemoryEvidence = z.infer<typeof memoryEvidenceSchema>;

/** A proposal as its row reads; its evidence is a JSON list (an older runtime reads it as one, so it has no envelope). */
export const memoryProposalSchema = z.strictObject({
  id: z.int(),
  repo: z.string(),
  kind: z.enum(MEMORY_PROPOSAL_KINDS),
  fingerprint: z.string(),
  title: z.string(),
  rationale: z.string(),
  beforeText: z.string().nullable(),
  afterText: z.string(),
  evidence: memoryEvidenceSchema,
  sessions: z.int(),
  status: z.string(),
  createdAt: z.string(),
  surface: z.string(),
});

export type MemoryProposal = z.infer<typeof memoryProposalSchema>;
