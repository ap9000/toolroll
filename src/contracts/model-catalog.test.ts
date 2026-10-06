import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexCatalog } from "../model-catalog.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { codexModelSchema, codexModelsCacheSchema, npmLatestSchema } from "./model-catalog.js";

const verdictOf = (schema: typeof codexModelSchema | typeof npmLatestSchema | typeof codexModelsCacheSchema) => (input: unknown): SampleVerdict => {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true } : { ok: false, lines: parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`) };
};

function catalogOf(text: string) {
  const home = mkdtempSync(join(tmpdir(), "catalog-"));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "models_cache.json"), text);
  return codexCatalog(home);
}

describe("the model catalog's outside inputs", () => {
  it("hold: the JSON Schema round trip loses nothing; a listed model and npm's version read, unknown keys ignored", () => {
    assertContract({
      schema: codexModelSchema,
      read: verdictOf(codexModelSchema),
      valid: [{ name: "a listed model", input: { slug: "gpt-5-codex", visibility: "list", display_name: "GPT-5 Codex", priority: 1 } }],
      invalid: [
        { name: "a hidden model", input: { slug: "gpt-5", visibility: "hide" }, paths: ["visibility"] },
        { name: "an argv-unsafe id", input: { slug: "-rf", visibility: "list" }, paths: ["slug"] },
      ],
    });
    assertContract({
      schema: npmLatestSchema,
      read: verdictOf(npmLatestSchema),
      valid: [{ name: "a release", input: { name: "@openai/codex", version: "0.50.1" } }],
      invalid: [{ name: "a tag", input: { version: "latest" }, paths: ["version"] }],
    });
    assertContract({ schema: codexModelsCacheSchema, read: verdictOf(codexModelsCacheSchema), valid: [{ name: "a list", input: { models: [], fetched_at: "x" } }], invalid: [] });
  });

  it("reads a damaged Codex cache as an empty list, skips entries that don't fit, and keeps the first 30", () => {
    for (const text of ["not json", "null", "5", "[]", "{}", '{"models":5}']) expect(catalogOf(text)).toEqual([]);
    expect(catalogOf(JSON.stringify({ models: [null, 5, "x", { slug: "gpt-5", visibility: "list" }, { slug: "o3", visibility: "list", display_name: `O3 ${"x".repeat(100)}` }, { slug: "o4", visibility: "list", display_name: 7 }, { slug: 5, visibility: "list" }] })))
      .toEqual([{ id: "gpt-5", name: "gpt-5" }, { id: "o3", name: `O3 ${"x".repeat(77)}` }, { id: "o4", name: "o4" }]);
    expect(catalogOf(JSON.stringify({ models: Array.from({ length: 40 }, (_, index) => ({ slug: `m${index}`, visibility: "list" })) }))).toHaveLength(30);
  });
});
