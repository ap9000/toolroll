import { describe, expect, it } from "vitest";
import { learningSha } from "../project-learning.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { parseContract, toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { knowledgeSchema, knowledgeSelectionSchema, readKnowledge, readKnowledgeSelection } from "./project-knowledge.js";
import { savedRows } from "../../test/context-fixture.js";

const verdict = (read: { ok: true } | { ok: false; issues: { line: string }[] }): SampleVerdict => (read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) });
const written = (schema: typeof knowledgeSchema | typeof knowledgeSelectionSchema) => (input: unknown) => verdict(parseContract(schema, input));

const saved = [...savedRows.knowledge.current, ...savedRows.knowledge.changes];
const reference = { id: "5ccdcc142a14c20a7b7a", title: "Mobile design", content: "Use short labels.", path: "mobile.md", sourceSha: "7ad3ec536f299ad6595d054aeeef579ea33a5348", sourceRevision: "0123456789abcdef0123456789abcdef01234567" };
const note = { ...reference, id: "a1b2c3", title: "Finance", path: null, sourceSha: null, sourceRevision: null };
const current = { version: 1, instructions: "Keep UI copy concise.", references: [reference, note] };
const selection = JSON.parse(savedRows.knowledge.snapshots[1]!.payload) as Record<string, unknown>;

describe("the project knowledge contract", () => {
  it("holds: saved knowledge (unversioned, through 0.9.36) and current knowledge read, malformed ones are refused by path", () => {
    expect(saved).toHaveLength(6);
    assertContract({
      schema: knowledgeSchema,
      read: input => verdict(readKnowledge(input)),
      valid: [
        ...saved.map(row => ({ name: `saved revision ${row.revision}`, input: JSON.parse(row.payload) as unknown })),
        { name: "current version 1", input: current },
        { name: "no instructions or references yet", input: { version: 1, instructions: "", references: [] } },
        { name: "unversioned, with a field its readers ignored", input: { instructions: "x", references: [{ ...reference, retired: true }], retired: 1 } },
        // Reading never re-validates length (text-limits.ts): text a later limit allowed still reads.
        { name: "instructions longer than today's limit", input: { ...current, instructions: "i".repeat(TEXT_LIMITS.knowledgeInstructionsBytes + 1) } },
      ],
      invalid: [
        { name: "newer version", input: { ...current, version: 2 }, paths: ["version"] },
        { name: "version 1 is strict", input: { ...current, extra: true }, paths: ["payload"] },
        { name: "a reference without its text", input: { ...current, references: [{ ...reference, content: undefined }] }, paths: ["references[0].content"] },
        { name: "a reference's path is text or null", input: { ...current, references: [{ ...reference, path: 7 }] }, paths: ["references[0].path"] },
        { name: "unversioned instructions are text", input: { instructions: 4, references: [] }, paths: ["instructions"] },
        { name: "more than 12 references", input: { ...current, references: Array.from({ length: 13 }, (_, index) => ({ ...note, id: String(index) })) }, paths: ["references"] },
      ],
    });
  });

  it("holds its budgets from TEXT_LIMITS when written", () => {
    const json = toModelSchema(knowledgeSchema) as { properties: { instructions: { maxLength: number }; references: { maxItems: number; items: { properties: Record<string, { maxLength?: number; anyOf?: { maxLength?: number }[] }> } } } };
    expect(json.properties.instructions.maxLength).toBe(TEXT_LIMITS.knowledgeInstructionsBytes);
    expect(json.properties.references.maxItems).toBe(12);
    expect(json.properties.references.items.properties["title"]?.maxLength).toBe(TEXT_LIMITS.knowledgeTitleBytes);
    expect(json.properties.references.items.properties["content"]?.maxLength).toBe(TEXT_LIMITS.knowledgeReferenceBytes);
    expect(json.properties.references.items.properties["path"]?.anyOf?.[0]?.maxLength).toBe(TEXT_LIMITS.knowledgePathBytes);
    assertContract({
      read: written(knowledgeSchema),
      valid: [{ name: "current", input: current }],
      invalid: [
        { name: "instructions over the limit", input: { ...current, instructions: "i".repeat(TEXT_LIMITS.knowledgeInstructionsBytes + 1) }, paths: ["instructions"] },
        { name: "a title over the limit", input: { ...current, references: [{ ...reference, title: "t".repeat(TEXT_LIMITS.knowledgeTitleBytes + 1) }] }, paths: ["references[0].title"] },
        { name: "unversioned is not written", input: { instructions: "", references: [] }, paths: ["version"] },
      ],
    });
  });

  it("reads every saved revision as the same knowledge it held, without the envelope", () => {
    for (const row of saved) {
      expect(learningSha(row.payload), `revision ${row.revision}`).toBe(row.sha);
      expect(readKnowledge(JSON.parse(row.payload)), `revision ${row.revision}`).toEqual({ ok: true, value: JSON.parse(row.payload) });
    }
    expect(readKnowledge(current)).toEqual({ ok: true, value: { instructions: current.instructions, references: current.references } });
  });
});

describe("the knowledge selection contract", () => {
  it("holds: every frozen selection reads, malformed ones are refused by path", () => {
    expect(savedRows.knowledge.snapshots).toHaveLength(4);
    assertContract({
      schema: knowledgeSelectionSchema,
      read: input => verdict(readKnowledgeSelection(input)),
      valid: savedRows.knowledge.snapshots.map((row, index) => ({ name: `frozen selection ${index}`, input: JSON.parse(row.payload) as unknown })),
      invalid: [
        { name: "newer version", input: { ...selection, version: 2 }, paths: ["version"] },
        { name: "unversioned", input: { ...selection, version: undefined }, paths: ["version"] },
        { name: "an unknown key", input: { ...selection, skills: [] }, paths: ["payload"] },
        { name: "an omission without its reason", input: { ...selection, omitted: [{ title: "Finance" }] }, paths: ["omitted[0].reason"] },
        { name: "a decision line's id", input: { ...selection, decisions: [{ id: "2", claim: "x", decidedAt: "2026-09-20T12:00:00.000Z" }] }, paths: ["decisions[0].id"] },
        { name: "inheritedFrom is a run or null", input: { ...selection, inheritedFrom: "4" }, paths: ["inheritedFrom"] },
      ],
    });
  });

  it("reads a frozen selection byte for byte, so a resumed run is given exactly the context it was", () => {
    for (const row of savedRows.knowledge.snapshots) {
      expect(learningSha(row.payload)).toBe(row.sha);
      const read = readKnowledgeSelection(JSON.parse(row.payload));
      expect(read.ok && JSON.stringify(read.value)).toBe(row.payload);
    }
  });

  it("holds the selection's budgets from TEXT_LIMITS when written", () => {
    assertContract({
      read: written(knowledgeSelectionSchema),
      valid: [{ name: "a frozen selection", input: selection }],
      invalid: [
        { name: "instructions over the limit", input: { ...selection, instructions: "i".repeat(TEXT_LIMITS.knowledgeInstructionsBytes + 1) }, paths: ["instructions"] },
        { name: "more than 8 decision lines", input: { ...selection, decisions: Array.from({ length: 9 }, (_, id) => ({ id, claim: "x", decidedAt: "2026-09-20T12:00:00.000Z" })) }, paths: ["decisions"] },
      ],
    });
  });
});
