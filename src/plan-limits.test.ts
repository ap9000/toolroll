import { describe, expect, it } from "vitest";
import { parsePlan, PLAN_LIMITS } from "./plan.js";
import { TEXT_LIMITS } from "./text-limits.js";

const document = [
  "## Approach",
  "Add the templates as data.",
  "## Milestones",
  "1. The templates build.",
  "## Dependencies",
  "- None.",
  "## Risks",
  "- None.",
  "## Proof",
  "- c1 — the gallery tests pass.",
].join("\n");

const payload = (goal: string, outOfScope: string | null = null) => JSON.stringify({
  goal, outOfScope, touches: [],
  acceptance: [{ id: "c1", statement: "The gallery tests pass", how: null, evidence: ["check"] }],
  plan: document, amendment: null,
});

describe("plan limits follow the task's own text limits", () => {
  it("a plan reproducing a long filed goal parses: the contract is the task's, so its caps are the task's", () => {
    expect(PLAN_LIMITS.goal).toBe(TEXT_LIMITS.goal);
    expect(PLAN_LIMITS.outOfScope).toBe(TEXT_LIMITS.goal);
    const parsed = parsePlan(payload("g".repeat(3_820), "o".repeat(3_000)));
    expect(parsed.ok).toBe(true);
    const atLimit = parsePlan(payload("g".repeat(TEXT_LIMITS.goal)));
    expect(atLimit.ok).toBe(true);
  });

  it("a goal over the task limit is still refused, by name", () => {
    const over = parsePlan(payload("g".repeat(TEXT_LIMITS.goal + 1)));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.problems.map(one => one.reason)).toContain("goal-too-long");
  });
});
