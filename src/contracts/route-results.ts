/**
 * Result records (docs/plans/results-routing.md, slice 1): the words and shapes a task family's result record is kept
 * and shown in. A policy path (release-auto.ts EVAL_POLICY): the states, reasons and the execution-class table decide
 * what a cheaper model's evidence is, so a change to them needs a person.
 */
import { z } from "zod";

/** A record's lifecycle. Only mature and rejected records are decided; pending and provisional never count anywhere. */
export const RECORD_STATES = ["pending", "provisional", "mature", "rejected", "not-counted"] as const;
export type RecordState = (typeof RECORD_STATES)[number];

/** Why a record was rejected, in the order they are checked. */
export const REJECT_REASONS = ["model-failures", "task-failed", "cancelled-after-result", "high-finding", "person-revision", "proof-refuted", "check-failed"] as const;
/** Why a record is not counted. Never counted as good, never as 0. */
export const NOT_COUNTED_REASONS = [
  "before-records", "not-eligible", "mixed-cohort", "mixed-models", "model-not-reported", "infrastructure-only", "cancelled-before-result",
  "no-check", "check-unavailable", "touched-protected", "changed-files-unknown", "unanswered",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export type NotCountedReason = (typeof NOT_COUNTED_REASONS)[number];
export type RecordReason = RejectReason | NotCountedReason;

/** The plain words for each reason. */
export const REASON_WORDS: Readonly<Record<RecordReason, string>> = Object.freeze({
  "model-failures": "two or more attempts failed on the model's own account",
  "task-failed": "the task failed",
  "cancelled-after-result": "it was cancelled after a result",
  "high-finding": "the automatic review found a serious problem",
  "person-revision": "a person asked for changes",
  "proof-refuted": "its evidence didn't match the changes",
  "check-failed": "its checks failed",
  "before-records": "started before results were recorded",
  "not-eligible": "not a small or routine task with default checks",
  "mixed-cohort": "its attempts ran under different task sizes or settings",
  "mixed-models": "its attempts ran on different models",
  "model-not-reported": "the provider didn't report the model",
  "infrastructure-only": "it failed only for reasons outside the model",
  "cancelled-before-result": "it was cancelled before a result",
  "no-check": "no checks configured",
  "check-unavailable": "its check result can't be read",
  "touched-protected": "touched protected files",
  "changed-files-unknown": "changed files unknown",
  "unanswered": "no answer in 30 days",
});

/** Why a run was refused a cohort before dispatch: any of these makes its record not counted ("not eligible"). */
export const INELIGIBLE_REASONS = ["no-sealed-route", "not-built-in", "large", "risky", "unsized", "strict", "evidence-demands", "automerge", "release", "protected"] as const;
export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

/** Who a revision came from (task_ref.revision_origin). Only `person` rejects a record. */
export const REVISION_ORIGINS = ["person", "automatic-review", "flow", "lead", "machine"] as const;
export type RevisionOrigin = (typeof REVISION_ORIGINS)[number];

/** A failed run's execution class, kept before the tick normalizes its reason (run.exec_class). */
export const EXEC_CLASSES = ["model", "infrastructure"] as const;
export type ExecClass = (typeof EXEC_CLASSES)[number];

/** The build leg's sealed selection, as a run's cohort keeps it (route v3 `selection`; earlier routes by `chosen`). */
export const selectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("rule"), rule: z.number().int().positive(), ruleGeneration: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("trial"), rule: z.number().int().positive(), reservation: z.number().int().positive() }),
  z.strictObject({ kind: z.enum(["configured", "override", "pin"]) }),
]);
export type Selection = z.infer<typeof selectionSchema>;

/** One record as `toolroll models results --json` returns it. */
export const resultRecordSchema = z.strictObject({
  task: z.string(),
  repo: z.string().nullable(),
  size: z.enum(["small", "medium"]).nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  state: z.enum(RECORD_STATES),
  reason: z.enum([...REJECT_REASONS, ...NOT_COUNTED_REASONS]).nullable(),
  words: z.string(),
  resultRun: z.number().int().nullable(),
  acceptedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  failures: z.strictObject({ model: z.number().int(), infrastructure: z.number().int() }),
  spend: z.strictObject({ apiMicrousd: z.number().int(), subscriptionRuns: z.number().int(), subscriptionTokens: z.number().int(), unknownRuns: z.number().int(), remediationRuns: z.number().int() }),
  selections: z.array(selectionSchema),
});
export type ResultRecordView = z.infer<typeof resultRecordSchema>;
