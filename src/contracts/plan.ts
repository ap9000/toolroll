/**
 * The planner's handoff: one schema for the file a planner writes, the JSON Schema it is given (`--json-schema`) and
 * the parser that reads it back (`parsePlan` in plan.ts). The rules JSON Schema cannot state — the plan document's
 * sections, UTF-8 byte limits, control characters, duplicate criterion ids, the Proof naming every criterion and the
 * silent-amendment contract check — run in plain code after parsing, each with a named error.
 */

import { z } from "zod";
import { ACCEPTANCE_LIMITS, EVIDENCE_KINDS, type EvidenceKind } from "../scope.js";
import { limited, readVersioned, toModelSchema, versioned, type ContractResult } from "./contract.js";

/** How many paths a plan may say it touches. */
export const PLAN_TOUCHES = 32;

/** One acceptance criterion: the scope's own shape (scope.ts `AcceptanceCriterion`), `how` advisory and unsigned. */
export const acceptanceCriterionSchema = z.strictObject({
  id: limited("acceptance id", "acceptanceIdBytes").min(1),
  statement: limited("acceptance statement", "acceptanceStatementBytes").min(1),
  how: limited("acceptance how", "acceptanceHowBytes").nullable().optional(),
  evidence: z.array(z.enum(EVIDENCE_KINDS as readonly EvidenceKind[] as [EvidenceKind, ...EvidenceKind[]])).min(1).max(EVIDENCE_KINDS.length),
});

export const PLAN_VERSION = 1;

export const planSchema = versioned(PLAN_VERSION, {
  goal: limited("goal", "goal").min(1),
  outOfScope: limited("outOfScope", "goal").nullable().optional(),
  touches: z.array(limited("touch", "planTouch").min(1)).max(PLAN_TOUCHES).optional(),
  acceptance: z.array(acceptanceCriterionSchema).min(1).max(ACCEPTANCE_LIMITS.criteria),
  plan: limited("plan", "planDocumentBytes").min(1),
  amendment: limited("amendment", "planAmendment").nullable().optional(),
});

export type PlanPayload = z.infer<typeof planSchema>;

/** What the planner's `--json-schema` is: the plan schema, exactly. */
export const PLAN_MODEL_SCHEMA: Readonly<Record<string, unknown>> = toModelSchema(planSchema);

const PLAN_FIELDS = ["goal", "outOfScope", "touches", "acceptance", "plan", "amendment"] as const;
const CRITERION_FIELDS = ["id", "statement", "how", "evidence"] as const;

function pick(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A plan written before plans carried `version` (every plan through 0.9.33), as version 1. The old parser read only
 * the fields it knew and ignored any others, read a null goal, plan or acceptance as missing and null touches as
 * none; this keeps exactly that, so every plan that parsed then parses now. Values themselves are never rewritten.
 */
export function upgradeUnversionedPlan(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { version: PLAN_VERSION, ...pick(body, PLAN_FIELDS) };
  for (const field of ["goal", "plan", "touches", "acceptance"] as const) {
    if (out[field] === null) delete out[field];
  }
  if (Array.isArray(out["acceptance"])) {
    out["acceptance"] = out["acceptance"].map(criterion => (isRecord(criterion) ? pick(criterion, CRITERION_FIELDS) : criterion));
  }
  return out;
}

export const PLAN_UPGRADES = { 0: upgradeUnversionedPlan } as const;

/** The payload as version 1, upgraded when it was saved unversioned; null for anything that is not an object. */
export function planPayloadBody(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  return Object.prototype.hasOwnProperty.call(input, "version") ? input : upgradeUnversionedPlan(input);
}

/** Read a plan payload: version 1 as itself, an unversioned one upgraded, a newer one refused plainly. */
export function readPlanPayload(input: unknown): ContractResult<PlanPayload> {
  return readVersioned(planSchema, input, PLAN_UPGRADES);
}
