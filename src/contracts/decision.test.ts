import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDecision, repairPrompt } from "../decision.js";
import { SCOUT_OUTPUT_JSON_SCHEMA } from "../scout-report.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { DECISION_MODEL_SCHEMA, decisionSchema } from "./decision.js";

type Sample = { name: string; payload: unknown; paths?: string[] };
const saved = JSON.parse(readFileSync(new URL("../../test/fixtures/answers/decision.json", import.meta.url), "utf8")) as { valid: Sample[]; invalid: (Sample & { paths: string[] })[] };

const read = (input: unknown): SampleVerdict => {
  const parsed = parseDecision(JSON.stringify(input));
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.problems.map(problem => problem.message) };
};

const option = (id: string, reversible = true) => ({ id, label: `Option ${id}`, consequence: `What ${id} does.`, reversible });
const base = { urgency: "blocking", recap: "A recap.", question: "Which one?", options: [option("a"), option("b")], recommendation: "b" };
const reasons = (payload: Record<string, unknown>) => {
  const parsed = parseDecision(JSON.stringify(payload));
  return parsed.ok ? [] : parsed.problems.map(problem => [problem.reason, problem.message]);
};

describe("the parked decision contract", () => {
  it("holds: the JSON Schema round trip loses nothing, park files and saved decisions parse, malformed ones are refused by path", () => {
    expect(saved.valid.length + saved.invalid.length).toBeGreaterThanOrEqual(20);
    assertContract({
      schema: decisionSchema,
      read,
      valid: saved.valid.map(one => ({ name: one.name, input: one.payload })),
      invalid: saved.invalid.map(one => ({ name: one.name, input: one.payload, paths: one.paths })),
    });
  });

  it("is the scout's question branch, exactly, with limits from TEXT_LIMITS", () => {
    expect(DECISION_MODEL_SCHEMA).toEqual(toModelSchema(decisionSchema));
    expect(SCOUT_OUTPUT_JSON_SCHEMA.properties.decision).toBe(DECISION_MODEL_SCHEMA);
    const properties = DECISION_MODEL_SCHEMA["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["recap"]?.["maxLength"]).toBe(TEXT_LIMITS.decisionRecap);
    expect(properties["options"]).toMatchObject({ minItems: 2, maxItems: 6, items: { additionalProperties: false, required: ["id", "label", "consequence", "reversible"] } });
  });

  it("reads an unversioned decision exactly as before: known fields only, text trimmed, the deadline normalized", () => {
    const parsed = parseDecision(JSON.stringify({ ...base, recap: "  A recap.\n", context: "ignored", options: [{ ...option("a"), risk: "ignored" }, option("b", false)], assignee: " alex ", deadline: "2026-10-07T09:00:00+02:00" }));
    expect(parsed).toEqual({
      ok: true,
      decision: { urgency: "blocking", recap: "A recap.", question: "Which one?", options: [option("a"), option("b", false)], recommendation: "b", assignee: "alex", deadline: "2026-10-07T07:00:00.000Z" },
    });
  });

  it("keeps the reason codes repair turns and incidents rely on, and every message names its path", () => {
    expect(reasons({ ...base, recommendation: "ghost" })).toEqual([["bad-recommendation", 'recommendation: "ghost" does not match any option id']]);
    expect(reasons({ ...base, options: [] })).toEqual([["too-few-options", "options: at least 2 items"]]);
    expect(reasons({ ...base, options: [option("a"), { id: "b", label: "B", consequence: "c" }] })).toEqual([["missing-reversible", "options[1].reversible: required"]]);
    expect(reasons({ ...base, options: [option("a"), option("a")], recommendation: "a" })).toEqual([["duplicate-option-id", 'options[1].id: "a" appears twice']]);
    expect(reasons({ ...base, urgency: "advisory", recap: "   ", question: "Which?\u001b[2J" })).toEqual([
      ["bad-urgency", 'urgency: must be "blocking"'],
      ["missing-recap", "recap: must not be blank"],
      ["question-control-characters", "question: contains control characters — text only"],
    ]);
    expect(reasons({ ...base, options: [{ ...option("a"), label: "two\nlines" }, option("b")] })).toEqual([["option-0-label-control-characters", "options[0].label: must be one line with no control characters"]]);
    expect(reasons({ ...base, options: [{ ...option("a"), consequence: "x".repeat(TEXT_LIMITS.decisionConsequence + 1) }, option("b")] })).toEqual([["option-0-consequence-too-long", "options[0].consequence: over 500 characters"]]);
    expect(reasons({ ...base, deadline: "soon" })).toEqual([["bad-deadline", 'deadline: must be an ISO 8601 timestamp (got "soon")']]);
    expect(reasons({ version: 1, ...base, notes: "x" })).toEqual([["payload-unknown-key", "payload: unknown key 'notes'"]]);
    expect(reasons({ version: 2, ...base })).toEqual([["newer-version", "version: made by a newer Toolroll (version 2; this one reads up to 1)"]]);
  });

  it("sends the repair turn exactly the path-named lines", () => {
    const parsed = parseDecision(JSON.stringify({ ...base, options: [option("a"), { id: "b", label: "B", consequence: "c" }] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(repairPrompt(parsed.problems, "PARK.json")).toContain("- options[1].reversible: required (missing-reversible)");
  });
});
