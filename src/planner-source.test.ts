/**
 * Who may widen a revision's contract at planning: a person's send-back
 * notes may become an amendment they approve; a repair draft's brief never.
 */
import { describe, expect, test } from "vitest";
import { PLANNER_SOURCE_LIMITS, PLANNER_SOURCE_VERSION, plannerHandoffProblemOf, plannerSourceBlock, type PlannerSource } from "./planner-source.js";
import { parsePlan } from "./plan.js";

const sourceWith = (brief: Record<string, unknown>): PlannerSource => ({
  version: PLANNER_SOURCE_VERSION,
  taskId: "t-rev",
  title: "Add subtract — revision",
  contract: { scope: null, revision: { of: "t", briefArtifact: 1, briefSha256: "0".repeat(64) } } as unknown as PlannerSource["contract"],
  sourceDigest: "d".repeat(64),
  revisionBrief: JSON.stringify(brief),
  answers: [],
});

describe("planning a revision", () => {
  test("a send-back's notes may amend the copied contract, for the person to approve", () => {
    const block = plannerSourceBlock(sourceWith({ schema: 1, sourceTask: "t", sourceRun: 3, comments: [{ id: 1, note: "Also add multiply(a, b)." }] })).join("\n");
    expect(block).toContain("amend the contract to include it");
    expect(block).toContain("The operator approves every change before anything builds.");
    expect(block).not.toContain("cannot widen");
  });

  test("a repair draft's brief never widens it", () => {
    for (const kind of ["ci-repair", "criterion-repair", "evidence-observation"]) {
      const block = plannerSourceBlock(sourceWith({ schema: 1, kind, sourceTask: "t", sourceRun: 3, comments: [{ id: 1, note: "Also add multiply(a, b)." }] })).join("\n");
      expect(block).toContain("the brief\ncannot widen it.");
      expect(block).not.toContain("amend the contract to include it");
    }
  });
});

describe("what the planner's handoff can carry back", () => {
  const terms = { goal: "Add a toggle", outOfScope: null, touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "A toggle exists.", how: null, evidence: ["check" as const] }] };

  test("terms that fit pass; each limit is named with the actual size, the limit and what to shorten", () => {
    expect(plannerHandoffProblemOf(terms)).toBeNull();
    expect(plannerHandoffProblemOf({ ...terms, goal: "g".repeat(8_000) })).toBeNull();
    expect(plannerHandoffProblemOf({ ...terms, outOfScope: "x".repeat(8_001) }))
      .toBe("The exclusions are 8,001 characters; the planner can carry at most 8,000. Shorten the exclusions and planning starts again.");
    expect(plannerHandoffProblemOf({ ...terms, touches: Array.from({ length: 33 }, (_, i) => `src/${i}.ts`) }))
      .toBe("The scope lists 33 paths; the planner can carry at most 32. List fewer paths and planning starts again.");
    // Multibyte terms still fit with a short plan. Reserving the maximum plan size falsely refused this valid handoff.
    const wide = { ...terms, goal: "€".repeat(8_000), outOfScope: "€".repeat(8_000) };
    expect(plannerHandoffProblemOf(wide)).toBeNull();
    const plan = "## Approach\nAdd a toggle.\n## Milestones\n- Add the toggle.\n## Dependencies\n- None found.\n## Risks\n- None found.\n## Proof\n- c1: Run the focused check.";
    expect(parsePlan(Buffer.from(JSON.stringify({ ...wide, plan }))).ok).toBe(true);
    // Terms alone over the whole payload's byte cap cannot fit even a short plan.
    const oversized = { ...wide, touches: Array.from({ length: 32 }, (_, i) => `${i}/` + "€".repeat(196)) };
    expect(plannerHandoffProblemOf(oversized)).toBe(
      `The goal, exclusions, paths and criteria are ${Buffer.byteLength(JSON.stringify(oversized)).toLocaleString("en-US")} bytes together; ` +
      `the planner can carry at most ${PLANNER_SOURCE_LIMITS.handoffTerms.toLocaleString("en-US")} bytes in its whole handoff. Shorten the scope and planning starts again.`,
    );
  });
});
