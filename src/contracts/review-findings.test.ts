import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBuildFindings } from "../reviewer.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { buildFindingsSchema, FINDINGS_MAX, FINDINGS_MODEL_SCHEMA, readBuildFindings } from "./review-findings.js";

type Sample = { name: string; payload: unknown; paths?: string[] };
const saved = JSON.parse(readFileSync(new URL("../../test/fixtures/answers/review-findings.json", import.meta.url), "utf8")) as { valid: Sample[]; invalid: (Sample & { paths: string[] })[] };

/** The production reader: a reviewer's reply text, or a saved row's bytes, through parseBuildFindings. */
const read = (input: unknown): SampleVerdict => {
  const parsed = parseBuildFindings(JSON.stringify(input));
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.problem.split("; ") };
};

describe("the build review findings contract", () => {
  it("holds: the JSON Schema round trip loses nothing, saved rows and replies parse, malformed ones are refused by path", () => {
    expect(saved.valid.length + saved.invalid.length).toBeGreaterThanOrEqual(15);
    assertContract({
      schema: buildFindingsSchema,
      read,
      valid: saved.valid.map(one => ({ name: one.name, input: one.payload })),
      invalid: saved.invalid.map(one => ({ name: one.name, input: one.payload, paths: one.paths })),
    });
  });

  it("reads a saved row back exactly as settle() wrote it", () => {
    for (const one of saved.valid.filter(sample => sample.name.startsWith("saved row"))) {
      const parsed = parseBuildFindings(JSON.stringify(one.payload));
      expect(parsed.ok && JSON.stringify({ version: 1, findings: parsed.findings })).toBe(JSON.stringify(one.payload));
    }
  });

  it("is the findings a Claude reviewer's --json-schema describes, with limits from TEXT_LIMITS", () => {
    expect(FINDINGS_MODEL_SCHEMA).toEqual(toModelSchema(buildFindingsSchema.shape.findings));
    expect(FINDINGS_MODEL_SCHEMA).toMatchObject({
      type: "array", maxItems: FINDINGS_MAX,
      items: { additionalProperties: false, required: ["severity", "file", "line", "scenario"], properties: { file: { maxLength: TEXT_LIMITS.reviewPath }, scenario: { maxLength: TEXT_LIMITS.reviewNote }, line: { minimum: 1 } } },
    });
  });

  it("keeps text to one line and refuses a reply by its paths", () => {
    expect(parseBuildFindings('```json\n{"version":1,"findings":[{"severity":"LOW","file":"a.ts","line":3,"scenario":"one\\n\\u001b[31mline"}]}\n```'))
      .toEqual({ ok: true, findings: [{ severity: "LOW", file: "a.ts", line: 3, scenario: "one [31mline" }] });
    expect(parseBuildFindings('{"version":1,"findings":[{"severity":"HIGH","file":"a.ts","line":0,"scenario":"x"},{"severity":"high","file":"b.ts","line":1,"scenario":"y"}]}'))
      .toEqual({ ok: false, problem: 'findings[0].line: at least 1; findings[1].severity: must be one of "HIGH", "MEDIUM", "LOW"' });
    expect(readBuildFindings({ version: 3, findings: [] })).toMatchObject({ ok: false, issues: [{ kind: "newer-version" }] });
  });
});
