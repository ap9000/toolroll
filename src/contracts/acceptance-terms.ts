/**
 * The acceptance rubric's vocabulary and limits: the evidence kinds a criterion may require, and how many criteria
 * and bytes a rubric may hold. A leaf with no imports but TEXT_LIMITS, because the plan contract (src/contracts/plan.ts)
 * reads these through scope.ts while scope.ts reads the plan contract's criterion: kept here, both load in either order.
 */

import { TEXT_LIMITS } from "../text-limits.js";

export const EVIDENCE_KINDS = ["check", "screenshot", "changed-path", "manual-review"] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const ACCEPTANCE_LIMITS = {
  criteria: 12,
  id: TEXT_LIMITS.acceptanceIdBytes,
  // A statement is one testable outcome; three hundred bytes forced people to
  // drop the qualifying clause that made it testable.
  statement: TEXT_LIMITS.acceptanceStatementBytes,
  how: TEXT_LIMITS.acceptanceHowBytes,
  evidenceKinds: EVIDENCE_KINDS.length,
} as const;
