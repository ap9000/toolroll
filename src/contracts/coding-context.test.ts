import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { codingContextSchema, readCodingContext, type CodingContext } from "./coding-context.js";
import { learningSha } from "../project-learning.js";
import { savedContext } from "../../test/coding-fixtures.js";

const read = (input: unknown): SampleVerdict => {
  const parsed = readCodingContext(input);
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};

const saved = JSON.parse(savedContext) as Omit<CodingContext, "version">;
const current: CodingContext = { version: 1, ...saved };
const empty: CodingContext = {
  version: 1,
  text: "",
  metadata: { version: 1, repo: "/work/project", identity: "f".repeat(64), baseRevision: "a".repeat(40), knowledge: { revision: 0, selectionSha256: "e".repeat(64), references: [], omitted: [] }, skills: { revision: 0, packages: [] }, directory: null, files: [] },
  sha256: "0".repeat(64),
};

describe("the coding context contract", () => {
  it("holds: the JSON Schema round trip loses nothing, saved and current captures read, malformed ones are refused by path", () => {
    assertContract({
      schema: codingContextSchema,
      read,
      valid: [
        { name: "saved by 0.9.36, before the envelope carried version", input: saved },
        { name: "saved with a field the old reader ignored", input: { ...saved, retired: true } },
        { name: "current version 1", input: current },
        { name: "nothing selected, no skills directory", input: empty },
      ],
      invalid: [
        { name: "newer version", input: { ...current, version: 2 }, paths: ["version"] },
        { name: "version 1 is strict", input: { ...current, retired: true }, paths: ["payload"] },
        { name: "missing digest", input: { ...saved, sha256: undefined }, paths: ["sha256"] },
        { name: "metadata from a newer capture", input: { ...current, metadata: { ...current.metadata, version: 2 } }, paths: ["metadata.version"] },
        { name: "metadata is strict", input: { ...saved, metadata: { ...saved.metadata, extra: 1 } }, paths: ["metadata"] },
        { name: "reference path is required", input: { ...current, metadata: { ...current.metadata, knowledge: { ...current.metadata.knowledge, references: [{ id: "r", title: "t", sourceSha: null, sourceRevision: null }] } } }, paths: ["metadata.knowledge.references[0].path"] },
        { name: "skill file digest is a string", input: { ...current, metadata: { ...current.metadata, files: [{ path: "copy-review/SKILL.md", sha256: 7 }] } }, paths: ["metadata.files[0].sha256"] },
        { name: "revision is an integer", input: { ...empty, metadata: { ...empty.metadata, skills: { revision: 1.5, packages: [] } } }, paths: ["metadata.skills.revision"] },
      ],
    });
  });

  it("reads the saved capture exactly as before: same metadata bytes, and its digest still matches", () => {
    const parsed = readCodingContext(JSON.parse(savedContext));
    expect(parsed).toEqual({ ok: true, value: current });
    if (!parsed.ok) return;
    expect(JSON.stringify(parsed.value.metadata)).toBe(JSON.stringify(saved.metadata));
    expect(learningSha(JSON.stringify({ text: parsed.value.text, metadata: parsed.value.metadata }))).toBe(saved.sha256);
  });

  it("distinguishes a null digest from a missing digest", () => {
    expect(read({ ...current, sha256: null })).toEqual({ ok: false, lines: ["sha256: must be a string (got null)"] });
    expect(read({ ...current, sha256: undefined })).toEqual({ ok: false, lines: ["sha256: required"] });
  });
});
