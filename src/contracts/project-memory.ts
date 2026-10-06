/**
 * Project memory's decisions (project-memory.ts): one schema for a decision as its row reads, the record its history
 * keeps, the change a person or the lead drafts, and the one line a brief carries. The rules JSON Schema cannot state —
 * UTF-8 byte limits, blank text, control characters and secrets — run in plain code (`clean`) when a decision is
 * written; a row is read as it was written, and its digest is checked against the row before anything trusts it.
 */

import { z } from "zod";
import type { TextLimitKey } from "../text-limits.js";
import { limited, versioned } from "./contract.js";

export const DECISION_STATUSES = ["active", "superseded", "retired"] as const;
export const DECISION_SOURCES = ["conversation", "task", "result", "manual", "backward-pass"] as const;

/** A text field: bounded by its TEXT_LIMITS entry when written, read as saved (text-limits.ts: reading never
 * re-validates length, so an older runtime still reads text a newer one allowed). */
type Text = (field: string, key: TextLimitKey) => z.ZodString;
const written: Text = limited;
const saved: Text = () => z.string();

const recordShape = (text: Text) => ({
  repo: z.string(),
  revision: z.int().min(1),
  claim: text("decision", "decisionClaimBytes"),
  why: text("reason", "decisionWhyBytes"),
  status: z.enum(DECISION_STATUSES),
  supersedes: z.int().nullable(),
  // An omitted draft author defaults to the account name, which has never had the explicit author's byte limit.
  decidedBy: z.string(),
  decidedAt: z.string(),
  sourceKind: z.enum(DECISION_SOURCES),
  sourceRef: text("source", "decisionSourceBytes").nullable(),
  recordedBy: z.string(),
});

/** A decision as it is recorded, in the order its digest lists the fields. */
export const decisionRecordSchema = z.strictObject(recordShape(written));
/** A decision as its row reads. */
export const decisionSchema = z.strictObject({ id: z.int(), ...recordShape(saved) });

export type Decision = z.infer<typeof decisionSchema>;
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

/** What a person or the lead asks to record; only the choice and its reason are required. */
export const decisionDraftSchema = z.strictObject({
  claim: z.string(),
  why: z.string(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  sourceKind: z.enum(DECISION_SOURCES).optional(),
  sourceRef: z.string().nullable().optional(),
  supersedes: z.int().nullable().optional(),
});

export type DecisionDraft = z.infer<typeof decisionDraftSchema>;

/** One decision in a brief: its id, the choice and when; the why loads on demand by id. */
export const decisionLineSchema = z.strictObject({ id: z.int(), claim: z.string(), decidedAt: z.string() });

export type DecisionLine = z.infer<typeof decisionLineSchema>;

export const DECISION_CHANGE_VERSION = 1;

/**
 * One entry of a decision's history (`decision_change.payload`): the record when it was made, or the reason its status
 * changed. Entries written before this carried `version` are the same shapes without it; nothing reads them back.
 */
export const decisionChangeSchema = z.union([
  versioned(DECISION_CHANGE_VERSION, recordShape(written)),
  versioned(DECISION_CHANGE_VERSION, { reason: limited("reason", "decisionRetireBytes") }),
]);

export type DecisionChange = z.infer<typeof decisionChangeSchema>;
