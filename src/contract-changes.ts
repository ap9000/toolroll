/**
 * The mechanical difference between two sets of contract terms — a task's goal, exclusions, touches and acceptance
 * rubric. Pure and import-light, so both the planner's source (planner-source.ts) and scope filing (scope.ts, which
 * restarts planning when the terms truly change) read the same comparison.
 */
import type { AcceptanceCriterion, EvidenceKind } from "./scope.js";

/** The four contract fields a planner may propose to amend. */
export type ContractTerms = {
  goal: string;
  outOfScope: string | null;
  touches: string[];
  acceptance: AcceptanceCriterion[];
};

export type ContractChange =
  | { field: "goal"; kind: "changed"; before: string; after: string }
  | { field: "outOfScope"; kind: "added" | "removed" | "changed"; before: string | null; after: string | null }
  | { field: "touches"; kind: "added" | "removed"; path: string }
  | {
      field: "acceptance";
      kind: "added" | "removed" | "changed";
      id: string;
      before: { statement: string; evidence: EvidenceKind[]; how: string | null } | null;
      after: { statement: string; evidence: EvidenceKind[]; how: string | null } | null;
      /** For `changed`: which parts moved. `how` is advisory and unsigned,
       * but a planner rewriting it is still a change the operator sees. */
      moved: ("statement" | "evidence" | "how")[];
    };

const trimmed = (text: string | null): string | null => {
  if (text === null) return null;
  const t = text.trim();
  return t === "" ? null : t;
};

/**
 * Every addition, change, and removal between the filed contract and a
 * proposed one. Whitespace at the ends and touch/evidence order do not
 * count (the scope digest ignores them too); everything else does,
 * including the advisory `how`, because the operator wrote it.
 */
export function contractChangesOf(filed: ContractTerms, proposed: ContractTerms): ContractChange[] {
  const changes: ContractChange[] = [];
  if (filed.goal.trim() !== proposed.goal.trim()) {
    changes.push({ field: "goal", kind: "changed", before: filed.goal, after: proposed.goal });
  }
  const filedOut = trimmed(filed.outOfScope);
  const proposedOut = trimmed(proposed.outOfScope);
  if (filedOut !== proposedOut) {
    changes.push({
      field: "outOfScope",
      kind: filedOut === null ? "added" : proposedOut === null ? "removed" : "changed",
      before: filed.outOfScope,
      after: proposed.outOfScope,
    });
  }
  const filedTouches = new Set(filed.touches.map(one => one.trim()).filter(one => one !== ""));
  const proposedTouches = new Set(proposed.touches.map(one => one.trim()).filter(one => one !== ""));
  for (const path of filedTouches) if (!proposedTouches.has(path)) changes.push({ field: "touches", kind: "removed", path });
  for (const path of proposedTouches) if (!filedTouches.has(path)) changes.push({ field: "touches", kind: "added", path });

  const criterionOf = (one: AcceptanceCriterion) => ({ statement: one.statement, evidence: [...one.evidence].sort() as EvidenceKind[], how: one.how });
  const filedById = new Map(filed.acceptance.map(one => [one.id, one]));
  const proposedById = new Map(proposed.acceptance.map(one => [one.id, one]));
  for (const [id, before] of filedById) {
    const after = proposedById.get(id);
    if (after === undefined) {
      changes.push({ field: "acceptance", kind: "removed", id, before: criterionOf(before), after: null, moved: [] });
      continue;
    }
    const moved: ("statement" | "evidence" | "how")[] = [];
    if (before.statement.trim() !== after.statement.trim()) moved.push("statement");
    if ([...before.evidence].sort().join(",") !== [...after.evidence].sort().join(",")) moved.push("evidence");
    if (trimmed(before.how) !== trimmed(after.how)) moved.push("how");
    if (moved.length > 0) {
      changes.push({ field: "acceptance", kind: "changed", id, before: criterionOf(before), after: criterionOf(after), moved });
    }
  }
  for (const [id, after] of proposedById) {
    if (!filedById.has(id)) changes.push({ field: "acceptance", kind: "added", id, before: null, after: criterionOf(after), moved: [] });
  }
  return changes;
}

