import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePlan } from "../plan.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { PLAN_MODEL_SCHEMA, planSchema } from "./plan.js";

type Sample = { name: string; payload: unknown; paths?: string[] };
const saved = JSON.parse(readFileSync(new URL("../../test/fixtures/plans/plan-payloads.json", import.meta.url), "utf8")) as { valid: Sample[]; invalid: (Sample & { paths: string[] })[] };

const read = (input: unknown): SampleVerdict => {
  const parsed = parsePlan(JSON.stringify(input));
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.problems.map(problem => problem.message) };
};

const plan = (payload: Record<string, unknown>) => parsePlan(JSON.stringify(payload));
const document = "## Approach\nDo it.\n## Milestones\n1. Do it.\n## Dependencies\n- None.\n## Risks\n- None.\n## Proof\n- c1 — the checks.";
const c1 = { id: "c1", statement: "It works.", evidence: ["check"] };

describe("the plan contract", () => {
  it("holds: the JSON Schema round trip loses nothing, saved plans parse and malformed ones are refused by path", () => {
    expect(saved.valid.length + saved.invalid.length).toBeGreaterThanOrEqual(15);
    assertContract({
      schema: planSchema,
      read,
      valid: saved.valid.map(one => ({ name: one.name, input: one.payload })),
      invalid: saved.invalid.map(one => ({ name: one.name, input: one.payload, paths: one.paths })),
    });
  });

  it("is what the planner's --json-schema says, with limits from TEXT_LIMITS", () => {
    expect(PLAN_MODEL_SCHEMA).toEqual(toModelSchema(planSchema));
    const properties = PLAN_MODEL_SCHEMA["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["goal"]?.["maxLength"]).toBe(TEXT_LIMITS.goal);
    expect(properties["plan"]?.["maxLength"]).toBe(TEXT_LIMITS.planDocumentBytes);
    expect(properties["amendment"]).toMatchObject({ anyOf: [{ maxLength: TEXT_LIMITS.planAmendment }, { type: "null" }] });
    expect(PLAN_MODEL_SCHEMA).toMatchObject({ additionalProperties: false, required: ["version", "goal", "acceptance", "plan"] });
  });

  it("reads an old plan exactly as before: empty text is none, the criteria are scope.ts's", () => {
    const parsed = plan({ goal: "g", outOfScope: "", touches: null, acceptance: [{ ...c1, how: "" }], plan: document, amendment: "" });
    expect(parsed).toEqual({ ok: true, plan: { goal: "g", outOfScope: null, touches: [], acceptance: [{ id: "c1", statement: "It works.", how: null, evidence: ["check"] }], plan: document, amendment: null } });
  });

  it("keeps the reason codes the planner relies on, and every message names its path", () => {
    const reasons = (payload: Record<string, unknown>) => {
      const parsed = plan(payload);
      return parsed.ok ? [] : parsed.problems.map(problem => [problem.reason, problem.message]);
    };
    expect(reasons({ acceptance: [c1], plan: "" })).toEqual([
      ["missing-goal", "goal: required"],
      ["missing-plan", "plan: must not be empty"],
    ]);
    expect(reasons({ goal: "g", acceptance: [c1], plan: document, amendment: "a".repeat(TEXT_LIMITS.planAmendment + 1) })).toEqual([["amendment-too-long", "amendment: over 1,000 characters"]]);
    expect(reasons({ goal: "g\u001b[2J", acceptance: [c1], plan: "Intro\n" + document })).toEqual([
      ["goal-controls", "goal: carries control characters that could become terminal escapes"],
      ["plan-preamble", "plan: plan must start with ## Approach"],
    ]);
    expect(reasons({ version: 1, goal: "g", acceptance: [c1], plan: document, notes: "x" })).toEqual([["payload-unknown-key", "payload: unknown key 'notes'"]]);
    expect(reasons({ version: 3, goal: "g", acceptance: [c1], plan: document })).toEqual([["newer-version", "version: made by a newer Toolroll (version 3; this one reads up to 1)"]]);
    expect(reasons({ goal: "g", acceptance: [], plan: document })).toEqual([["missing-acceptance", "acceptance: at least 1 item"]]);
    expect(reasons({ goal: "g", acceptance: [c1, c1], plan: document })[0]?.[0]).toBe("acceptance[1]-duplicate-id");
  });

  it("refuses a payload over its byte cap, and anything that is not one JSON object, before the schema", () => {
    expect(parsePlan("x".repeat(TEXT_LIMITS.planPayloadBytes + 1))).toMatchObject({ ok: false, problems: [{ reason: "too-large" }] });
    expect(parsePlan("{")).toMatchObject({ ok: false, problems: [{ reason: "not-json" }] });
    expect(parsePlan("[]")).toMatchObject({ ok: false, problems: [{ reason: "not-an-object" }] });
  });
});

describe("docs/plans/zod-revamp.md", () => {
  it("marks wave 1 items 1 and 2 done", () => {
    const doc = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(doc).toMatch(/^\| 1 ✅ \| \*\*Foundation\*\*/m);
    expect(doc).toMatch(/^\| 2 ✅ \| \*\*Plan payload\*\*/m);
    const done = doc.slice(doc.indexOf("## Done"));
    expect(done).toContain("**1. Foundation**");
    expect(done).toContain("**2. Plan payload**");
  });

  it("marks wave 1 item 7, the small structured answers, done", () => {
    const doc = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(doc).toMatch(/^\| 7 ✅ \| \*\*Small structured answers\*\*/m);
    expect(doc.slice(doc.indexOf("## Done"))).toContain("**7. Small structured answers**");
  });
});
