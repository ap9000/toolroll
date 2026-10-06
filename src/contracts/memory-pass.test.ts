import { describe, expect, it } from "vitest";
import { TEXT_LIMITS } from "../text-limits.js";
import { parseContract, toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { MEMORY_VERDICT_MODEL_SCHEMA, memoryEvidenceSchema, memoryVerdictReadSchema, memoryVerdictSchema, readSavedVerdict, savedVerdictSchema } from "./memory-pass.js";
import { savedRows } from "../../test/context-fixture.js";
import { parseVerdict } from "../memory-pass.js";

const verdict = (read: { ok: true } | { ok: false; issues: { line: string }[] }): SampleVerdict => (read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) });

const answer = {
  positive: [{ instruction: "IN-002", effect: "Asked before merging", quote: "Never treat this as approval, so I asked again" }],
  negative: [{ instruction: "IN-001", effect: "Made labels longer", class: "harm", quote: "I will make every label five words long" }],
  gaps: [{ mistake: "Labels were too long for phones", proposedInstruction: "Keep button labels to three words.", domain: "project", quote: "Labels were truncated on the phone again.", matchesGap: null }],
};
const gap = answer.gaps[0]!;
const kept = savedRows.memory.verdicts.map(row => JSON.parse(row.verdict) as Record<string, unknown> & { gaps: Record<string, unknown>[] });
const trace = [answer.positive[0]!.quote, answer.negative[0]!.quote, gap.quote].join("\n");
const surface = { version: "test", instructions: [{ id: "IN-001", text: "Keep labels short." }, { id: "IN-002", text: "Ask before merging." }], decisions: [] };

describe("reading older analyser answers", () => {
  const overBudget = { ...answer,
    positive: [{ ...answer.positive[0], effect: "e".repeat(TEXT_LIMITS.memoryEffect + 5) }],
    negative: [{ ...answer.negative[0], effect: "n".repeat(TEXT_LIMITS.memoryEffect + 5) }],
    gaps: [{ ...gap, mistake: "m".repeat(TEXT_LIMITS.memoryMistake + 5), proposedInstruction: "p".repeat(TEXT_LIMITS.memoryInstruction + 5) }],
  };
  const missingMatch = { ...answer, gaps: [{ ...gap, matchesGap: undefined }] };
  const badItems = { ...answer,
    positive: [null, { instruction: "IN-002", effect: "No quote" }, ...answer.positive],
    negative: [{ ...answer.negative[0], class: "bad" }, ...answer.negative],
    gaps: [{ ...gap, mistake: 123 }, ...answer.gaps],
  };

  it("replays clipped fields, a missing matchesGap and single bad items through the contract harness", () => {
    assertContract({
      read: input => verdict(parseContract(memoryVerdictReadSchema, input)),
      valid: [
        { name: "over-budget fields are clipped", input: overBudget },
        { name: "matchesGap was optional", input: missingMatch },
        { name: "bad items do not lose good siblings", input: badItems },
      ],
      invalid: [{ name: "a verdict is an object", input: null, paths: ["payload"] }],
    });
    expect(parseVerdict(JSON.stringify(overBudget), trace, surface)).toEqual({ ok: true, verdict: {
      positive: [{ ...answer.positive[0], effect: `${"e".repeat(TEXT_LIMITS.memoryEffect)}…` }],
      negative: [{ ...answer.negative[0], effect: `${"n".repeat(TEXT_LIMITS.memoryEffect)}…` }],
      gaps: [{ ...gap, mistake: `${"m".repeat(TEXT_LIMITS.memoryMistake)}…`, proposedInstruction: `${"p".repeat(TEXT_LIMITS.memoryInstruction)}…` }],
    } });
    expect(parseVerdict(JSON.stringify(missingMatch), trace, surface)).toEqual({ ok: true, verdict: answer });
    expect(parseVerdict(JSON.stringify(badItems), trace, surface)).toEqual({ ok: true, verdict: answer });
  });

  it("keeps the old defaults, coercion and unknown-key handling", () => {
    const input = { extra: true,
      positive: [{ ...answer.positive[0], effect: 42, extra: true }, { ...answer.positive[0], effect: undefined }],
      negative: "not a list",
      gaps: [{ ...gap, domain: "unknown", matchesGap: 3, extra: true }],
    };
    expect(parseVerdict(JSON.stringify(input), trace, surface)).toEqual({ ok: true, verdict: {
      positive: [{ ...answer.positive[0], effect: "42" }, { ...answer.positive[0], effect: "" }], negative: [], gaps: [gap],
    } });
    expect(parseVerdict("{}", trace, surface)).toEqual({ ok: true, verdict: { positive: [], negative: [], gaps: [] } });
  });

  it("limits to the first twenty quoted items before dropping malformed claims or unknown instructions", () => {
    const input = {
      positive: [...Array.from({ length: 20 }, () => ({ ...answer.positive[0], instruction: "IN-999" })), ...answer.positive],
      negative: [...Array.from({ length: 20 }, () => ({ ...answer.negative[0], class: "bad" })), ...answer.negative],
      gaps: [...Array.from({ length: 20 }, () => ({ ...gap, mistake: false })), gap],
    };
    expect(parseVerdict(JSON.stringify(input), trace, surface)).toEqual({ ok: true, verdict: { positive: [], negative: [], gaps: [] } });
  });
});

describe("the memory verdict contract (the analyser's answer)", () => {
  it("holds: the JSON Schema round trip loses nothing, answers read, malformed ones are refused by path", () => {
    assertContract({
      schema: memoryVerdictSchema,
      read: input => verdict(parseContract(memoryVerdictSchema, input)),
      valid: [
        { name: "an answer", input: answer },
        { name: "nothing to report", input: { positive: [], negative: [], gaps: [] } },
        { name: "a gap already on the books", input: { ...answer, gaps: [{ ...gap, matchesGap: "4f1c2a9e0b7d3c11" }] } },
      ],
      invalid: [
        { name: "an unknown effect class", input: { ...answer, negative: [{ ...answer.negative[0], class: "bad" }] }, paths: ["negative[0].class"] },
        { name: "an unknown domain", input: { ...answer, gaps: [{ ...gap, domain: "weird" }] }, paths: ["gaps[0].domain"] },
        { name: "matchesGap is a key or null, never left out", input: { ...answer, gaps: [{ ...gap, matchesGap: undefined }] }, paths: ["gaps[0].matchesGap"] },
        { name: "a claim needs its quote", input: { ...answer, positive: [{ instruction: "IN-002", effect: "x" }] }, paths: ["positive[0].quote"] },
        { name: "an unknown key", input: { ...answer, positive: [{ ...answer.positive[0], extra: "x" }] }, paths: ["positive[0]"] },
        { name: "an effect over the limit", input: { ...answer, positive: [{ ...answer.positive[0], effect: "e".repeat(TEXT_LIMITS.memoryEffect + 1) }] }, paths: ["positive[0].effect"] },
        { name: "a mistake over the limit", input: { ...answer, gaps: [{ ...gap, mistake: "m".repeat(TEXT_LIMITS.memoryMistake + 1) }] }, paths: ["gaps[0].mistake"] },
        { name: "a proposed instruction over the limit", input: { ...answer, gaps: [{ ...gap, proposedInstruction: "p".repeat(TEXT_LIMITS.memoryInstruction + 1) }] }, paths: ["gaps[0].proposedInstruction"] },
        { name: "every list is required", input: { positive: [], negative: [] }, paths: ["gaps"] },
      ],
    });
  });

  it("is the schema the analyser is given, every field required (Codex's strict output schema), budgets from TEXT_LIMITS", () => {
    expect(MEMORY_VERDICT_MODEL_SCHEMA).toEqual(toModelSchema(memoryVerdictSchema));
    const json = MEMORY_VERDICT_MODEL_SCHEMA as { required: string[]; additionalProperties: boolean; properties: Record<string, { items: { required: string[]; additionalProperties: boolean; properties: Record<string, { maxLength?: number }> } }> };
    expect(json).toMatchObject({ required: ["positive", "negative", "gaps"], additionalProperties: false });
    expect(json.properties["gaps"]?.items).toMatchObject({ required: ["mistake", "proposedInstruction", "domain", "quote", "matchesGap"], additionalProperties: false });
    expect(json.properties["positive"]?.items.properties["effect"]?.maxLength).toBe(TEXT_LIMITS.memoryEffect);
    expect(json.properties["gaps"]?.items.properties["mistake"]?.maxLength).toBe(TEXT_LIMITS.memoryMistake);
    expect(json.properties["gaps"]?.items.properties["proposedInstruction"]?.maxLength).toBe(TEXT_LIMITS.memoryInstruction);
    expect(json.properties["gaps"]?.items.properties["quote"]?.maxLength).toBe(TEXT_LIMITS.memoryTrace);
    // All objects (including both effect lists) must meet Codex's strict-output requirements.
    for (const object of [json, ...Object.values(json.properties).map(list => list.items)]) {
      expect(object.additionalProperties).toBe(false);
      expect(object.required).toEqual(Object.keys(object.properties));
    }
    expect(() => toModelSchema(memoryVerdictReadSchema)).toThrow();
  });
});

describe("the kept verdict contract", () => {
  it("holds: verdicts kept through 0.9.36 (unversioned, a clipped field one past its limit) and current ones read", () => {
    expect(kept).toHaveLength(2);
    expect((kept[0]!.gaps[1]!["mistake"] as string).length).toBe(TEXT_LIMITS.memoryMistake + 1);
    assertContract({
      schema: savedVerdictSchema,
      read: input => verdict(readSavedVerdict(input)),
      valid: [
        ...kept.map((one, index) => ({ name: `kept verdict ${index}`, input: one })),
        { name: "current version 1", input: { version: 1, ...answer } },
      ],
      invalid: [
        { name: "newer version", input: { version: 2, ...answer }, paths: ["version"] },
        { name: "version 1 names matchesGap", input: { version: 1, ...answer, gaps: [{ ...gap, matchesGap: undefined }] }, paths: ["gaps[0].matchesGap"] },
        { name: "an unknown effect class", input: { ...kept[0], negative: [{ instruction: "IN-001", effect: "x", class: "bad", quote: "y" }] }, paths: ["negative[0].class"] },
      ],
    });
  });

  it("reads a kept verdict as it was, a gap without matchesGap as null", () => {
    for (const one of kept) {
      const read = readSavedVerdict(one);
      expect(read).toEqual({ ok: true, value: { version: 1, ...one, gaps: one.gaps.map(entry => ({ matchesGap: null, ...entry })) } });
    }
  });
});

describe("the proposal evidence contract", () => {
  it("holds: every saved proposal's evidence reads byte for byte, malformed ones are refused by path", () => {
    expect(savedRows.memory.proposals).toHaveLength(2);
    assertContract({
      schema: memoryEvidenceSchema,
      read: input => verdict(parseContract(memoryEvidenceSchema, input)),
      valid: savedRows.memory.proposals.map(row => ({ name: `saved ${row.fingerprint}`, input: JSON.parse(row.evidence) as unknown })),
      invalid: [
        { name: "a sighting needs its session", input: [{ quote: "x" }], paths: ["[0].session"] },
        { name: "at most six sightings", input: Array.from({ length: 7 }, (_, index) => ({ session: String(index), quote: "q" })), paths: ["payload"] },
      ],
    });
    for (const row of savedRows.memory.proposals) expect(JSON.stringify(memoryEvidenceSchema.parse(JSON.parse(row.evidence)))).toBe(row.evidence);
  });
});
