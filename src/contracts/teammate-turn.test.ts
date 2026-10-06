import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TURN_LIMITS } from "../teammates.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { readTurnAnswer, teammateTurnSchema, TURN_ACTIONS, TURN_MODEL_SCHEMA } from "./teammate-turn.js";

type Sample = { name: string; payload: unknown; paths?: string[] };
const saved = JSON.parse(readFileSync(new URL("../../test/fixtures/answers/teammate-turn.json", import.meta.url), "utf8")) as { valid: Sample[]; invalid: (Sample & { paths: string[] })[] };

const read = (input: unknown): SampleVerdict => {
  const parsed = readTurnAnswer(input);
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};

describe("the teammate turn contract", () => {
  it("holds: the JSON Schema round trip loses nothing, turns parse and malformed ones are refused by path", () => {
    assertContract({
      schema: teammateTurnSchema,
      read,
      valid: saved.valid.map(one => ({ name: one.name, input: one.payload })),
      invalid: saved.invalid.map(one => ({ name: one.name, input: one.payload, paths: one.paths })),
    });
  });

  it("is what Claude's --json-schema says: one flat object with every field, and no text limits (those are asked once to shorten)", () => {
    expect(TURN_MODEL_SCHEMA).toEqual(toModelSchema(teammateTurnSchema));
    expect(TURN_MODEL_SCHEMA).toMatchObject({ type: "object", additionalProperties: false, required: ["action", "answer", "text", "note", "question", "options", "reason", "tool", "input", "remember"] });
    expect((TURN_MODEL_SCHEMA["properties"] as Record<string, unknown>)["action"]).toEqual({ type: "string", enum: [...TURN_ACTIONS] });
    expect(JSON.stringify(TURN_MODEL_SCHEMA)).not.toContain("maxLength");
    for (const combinator of ["anyOf", "oneOf", "allOf"]) expect(TURN_MODEL_SCHEMA).not.toHaveProperty(combinator);
  });

  it("takes its limits from TEXT_LIMITS", () => {
    expect(TURN_LIMITS).toEqual({ answer: TEXT_LIMITS.teammateAnswer, text: TEXT_LIMITS.stageOutput, note: TEXT_LIMITS.note, question: TEXT_LIMITS.teammateQuestion, reason: TEXT_LIMITS.teammateReason, remember: TEXT_LIMITS.teammateRemember });
  });
});
