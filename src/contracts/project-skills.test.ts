import { describe, expect, it } from "vitest";
import { learningSha } from "../project-learning.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { parseContract, toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { readSkillsSnapshotPayload, SKILL_LIMITS, savedSkillPackageSchema, savedSkillsSnapshotSchema, skillPackageSchema, skillSelectionSchema } from "./project-skills.js";
import { savedRows } from "../../test/context-fixture.js";

const reader = (schema: Parameters<typeof parseContract>[0]) => (input: unknown): SampleVerdict => {
  const read = parseContract(schema, input);
  return read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) };
};

const packages = savedRows.skills.packages.map(row => JSON.parse(row.payload) as Record<string, unknown> & { files: Record<string, unknown>[] });
const skill = packages.find(one => one["name"] === "copy-review")!;
const selection = JSON.parse(savedRows.skills.changes.at(-1)!.payload) as Record<string, unknown>;
const snapshot = JSON.parse(savedRows.skills.snapshots[0]!.payload) as Record<string, unknown>;

describe("the skill package contract", () => {
  it("holds: every saved package reads, malformed ones are refused by path", () => {
    expect(packages).toHaveLength(2);
    assertContract({
      schema: skillPackageSchema,
      read: reader(savedSkillPackageSchema),
      valid: [
        ...packages.map(one => ({ name: `saved package ${String(one["name"])}`, input: one })),
        // Reading never re-validates length (text-limits.ts).
        { name: "a description longer than today's limit", input: { ...skill, description: "d".repeat(TEXT_LIMITS.skillDescriptionBytes + 1) } },
      ],
      invalid: [
        { name: "a name that is not lowercase words", input: { ...skill, name: "Copy Review" }, paths: ["name"] },
        { name: "no files", input: { ...skill, files: [] }, paths: ["files"] },
        { name: "a file without its bytes", input: { ...skill, files: [{ path: "SKILL.md" }] }, paths: ["files[0].base64"] },
        { name: "an unknown key", input: { ...skill, version: 1 }, paths: ["payload"] },
        { name: "warnings are lines", input: { ...skill, warnings: "none" }, paths: ["warnings"] },
      ],
    });
  });

  it("reads a saved package byte for byte, so the same folder imported again is the same version", () => {
    for (const row of savedRows.skills.packages) {
      expect(learningSha(row.payload)).toBe(row.sha);
      expect(JSON.stringify(savedSkillPackageSchema.parse(JSON.parse(row.payload)))).toBe(row.payload);
      expect(JSON.stringify(skillPackageSchema.parse(JSON.parse(row.payload)))).toBe(row.payload);
    }
  });

  it("holds a new package to its budgets from TEXT_LIMITS", () => {
    expect(SKILL_LIMITS).toEqual({ files: 64, packageBytes: TEXT_LIMITS.skillPackageBytes, fileBytes: TEXT_LIMITS.skillFileBytes, bodyBytes: TEXT_LIMITS.skillBodyBytes, enabled: 8, selectionBytes: TEXT_LIMITS.skillSelectionBytes });
    const json = toModelSchema(skillPackageSchema) as { properties: Record<string, { maxLength?: number; maxItems?: number; items?: { properties: Record<string, { maxLength?: number }> } }> };
    expect(json.properties["name"]?.maxLength).toBe(TEXT_LIMITS.skillNameBytes);
    expect(json.properties["description"]?.maxLength).toBe(TEXT_LIMITS.skillDescriptionBytes);
    expect(json.properties["requirements"]?.maxLength).toBe(TEXT_LIMITS.skillRequirementsBytes);
    expect(json.properties["source"]?.maxLength).toBe(TEXT_LIMITS.skillSourceBytes);
    expect(json.properties["files"]?.maxItems).toBe(SKILL_LIMITS.files);
    expect(json.properties["files"]?.items?.properties["path"]?.maxLength).toBe(TEXT_LIMITS.skillPath);
    assertContract({
      read: reader(skillPackageSchema),
      valid: [{ name: "a package", input: skill }],
      invalid: [
        { name: "a description over the limit", input: { ...skill, description: "d".repeat(TEXT_LIMITS.skillDescriptionBytes + 1) }, paths: ["description"] },
        { name: "a path over the limit", input: { ...skill, files: [{ path: "p".repeat(TEXT_LIMITS.skillPath + 1), base64: "" }] }, paths: ["files[0].path"] },
        { name: "more than 64 files", input: { ...skill, files: Array.from({ length: 65 }, (_, index) => ({ path: `f${index}.md`, base64: "" })) }, paths: ["files"] },
      ],
    });
  });
});

describe("the skill selection contract", () => {
  it("holds: every saved selection reads byte for byte, malformed ones are refused by path", () => {
    expect(savedRows.skills.changes).toHaveLength(3);
    // No round trip here: Zod's fromJSONSchema rebuilds a record as a preprocess. The selection is never model-facing;
    // its JSON Schema is checked as it stands.
    expect(toModelSchema(skillSelectionSchema)).toMatchObject({ type: "object", additionalProperties: { type: "object", required: ["sha", "enabled"], additionalProperties: false } });
    assertContract({
      read: reader(skillSelectionSchema),
      valid: [
        ...savedRows.skills.changes.map(row => ({ name: `saved selection revision ${row.revision}`, input: JSON.parse(row.payload) as unknown })),
        { name: "nothing chosen yet", input: {} },
        // A skill may be named `version`: the selection carries no envelope to collide with it.
        { name: "a skill named version", input: { version: { sha: "abc", enabled: true } } },
      ],
      invalid: [
        { name: "a choice without its version", input: { ...selection, "copy-review": { enabled: true } }, paths: ["copy-review.sha"] },
        { name: "enabled is true or false", input: { ...selection, "copy-review": { sha: "abc", enabled: "yes" } }, paths: ["copy-review.enabled"] },
        { name: "a choice with an unknown key", input: { "copy-review": { sha: "abc", enabled: true, pinned: true } }, paths: ["copy-review"] },
      ],
    });
    for (const row of savedRows.skills.changes) {
      expect(learningSha(row.payload)).toBe(row.sha);
      expect(JSON.stringify(skillSelectionSchema.parse(JSON.parse(row.payload)))).toBe(row.payload);
    }
  });
});

describe("the skills snapshot contract", () => {
  it("holds: every frozen snapshot (normal, test, inherited, empty) reads byte for byte, malformed ones are refused by path", () => {
    expect(savedRows.skills.snapshots).toHaveLength(4);
    assertContract({
      schema: savedSkillsSnapshotSchema,
      read: input => {
        const read = readSkillsSnapshotPayload(input);
        return read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) };
      },
      valid: savedRows.skills.snapshots.map((row, index) => ({ name: `frozen snapshot ${index}`, input: JSON.parse(row.payload) as unknown })),
      invalid: [
        { name: "newer version", input: { ...snapshot, version: 2 }, paths: ["version"] },
        { name: "unversioned", input: { ...snapshot, version: undefined }, paths: ["version"] },
        { name: "the packages by digest", input: { ...snapshot, packageShas: [7] }, paths: ["packageShas[0]"] },
        { name: "test is true or false", input: { ...snapshot, test: 1 }, paths: ["test"] },
        { name: "an unknown key", input: { ...snapshot, packages: [] }, paths: ["payload"] },
      ],
    });
    for (const row of savedRows.skills.snapshots) {
      expect(learningSha(row.payload)).toBe(row.sha);
      const read = readSkillsSnapshotPayload(JSON.parse(row.payload));
      expect(read.ok && JSON.stringify(read.value)).toBe(row.payload);
    }
  });
});
