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
    expect(JSON.stringify(SIZING_MODEL_SCHEMA)).not.toContain("you will be asked to shorten it");
  });

  it("defaults absent or non-text reasons and clips only after collapsing whitespace", () => {
    for (const reason of [undefined, null, 4, false, {}, []]) {
      expect(readSizeAnswer({ size: "small", risky: false, reason, extra: true }))
        .toEqual({ ok: true, value: { size: "small", risky: false, reason: "" } });
    }
    expect(readSizeAnswer({ size: "medium", risky: true, reason: `  One${" \n".repeat(200)}change  ` }))
      .toEqual({ ok: true, value: { size: "medium", risky: true, reason: "One change" } });
    expect(readSizeAnswer({ size: "large", risky: false, reason: "x".repeat(TEXT_LIMITS.sizingReason + 1) }))
      .toEqual({ ok: true, value: { size: "large", risky: false, reason: `${"x".repeat(TEXT_LIMITS.sizingReason - 1)}…` } });
  });
});
