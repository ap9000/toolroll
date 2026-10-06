import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEXT_LIMITS } from "../text-limits.js";
import { toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { readSizeAnswer, sizeAnswerSchema, SIZING_MODEL_SCHEMA } from "./task-sizing.js";

type Sample = { name: string; payload: unknown; paths?: string[] };
const saved = JSON.parse(readFileSync(new URL("../../test/fixtures/answers/task-sizing.json", import.meta.url), "utf8")) as { valid: Sample[]; invalid: (Sample & { paths: string[] })[] };

const read = (input: unknown): SampleVerdict => {
  const parsed = readSizeAnswer(input);
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};

describe("the task sizing answer contract", () => {
  it("holds: the JSON Schema round trip loses nothing, classifier answers parse and malformed ones are refused by path", () => {
    assertContract({
      schema: sizeAnswerSchema,
      read,
      valid: saved.valid.map(one => ({ name: one.name, input: one.payload })),
      invalid: saved.invalid.map(one => ({ name: one.name, input: one.payload, paths: one.paths })),
    });
  });

  it("is what a Claude sizer's --json-schema says, with the reason's limit from TEXT_LIMITS", () => {
    expect(SIZING_MODEL_SCHEMA).toEqual(toModelSchema(sizeAnswerSchema));
    expect(SIZING_MODEL_SCHEMA).toMatchObject({
      type: "object", additionalProperties: false, required: ["size", "risky", "reason"],
      properties: { size: { enum: ["small", "medium", "large"] }, risky: { type: "boolean" }, reason: { type: "string", maxLength: TEXT_LIMITS.sizingReason } },
    });
  });
});
