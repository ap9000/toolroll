import { describe, expect, it } from "vitest";
import { exportRecipe, parseRecipe, recipeDigest, RecipeError } from "../recipes.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { recipeDocumentSchema } from "./recipes.js";

// A version 2 recipe as 0.9.41 wrote it, and the digest 0.9.41 gave it: the shape and key order a saved row holds.
const saved = {
  format: "standing-orders-recipe", version: 2, name: "Test one overlooked module", description: "grow the test suite one module at a time",
  goal: "Test {{module}} well.", outOfScope: "No refactoring of the code under test.", touches: [],
  acceptance: [{ id: "c1", statement: "Tests pass", how: null, evidence: ["check"] }], planning: "skip", deliverable: "branch",
  schedule: "daily:05:00", costCeilingUsd: null, inputs: [{ key: "module", label: "Module", defaultValue: "src" }],
};
const SAVED_DIGEST = "f8e86bfa4131c1d82238c58b67fe6322c933ea8f2c862c0ae92fb8ecf78ffa60";
const v1 = (() => { const { inputs: _inputs, ...rest } = saved; return { ...rest, version: 1, goal: "Test the parser well.", schedule: null }; })();

const read = (input: unknown): SampleVerdict => {
  try { parseRecipe(input); return { ok: true }; } catch (error) {
    if (!(error instanceof RecipeError)) throw error;
    return { ok: false, lines: error.message.split("; ") };
  }
};

describe("the recipe document contract", () => {
  it("holds: the JSON Schema round trip loses nothing, both versions read, and every structural refusal names its field", () => {
    assertContract({
      schema: recipeDocumentSchema,
      read,
      valid: [
        { name: "version 1", input: v1 },
        { name: "version 2", input: saved },
        { name: "a check without how, or with an empty one", input: { ...v1, acceptance: [{ id: "c1", statement: "Tests pass", evidence: ["check"] }, { id: "c2", statement: "Docs", how: "", evidence: ["manual-review"] }] } },
        { name: "a repeating recipe with a weekly budget", input: { ...v1, schedule: "every:60", costCeilingUsd: 5 } },
      ],
      invalid: [
        { name: "an unknown key", input: { ...v1, approvals: "auto" }, paths: ["payload"] },
        { name: "a missing key", input: (() => { const { goal: _goal, ...rest } = v1; return rest; })(), paths: ["goal"] },
        { name: "inputs on version 1", input: { ...v1, inputs: saved.inputs }, paths: ["payload"] },
        { name: "a newer version", input: { ...v1, version: 3 }, paths: ["version"] },
        { name: "another format", input: { ...v1, format: "other" }, paths: ["format"] },
        { name: "a name that is not text", input: { ...v1, name: 5 }, paths: ["name"] },
        { name: "an unknown planning", input: { ...v1, planning: "never" }, paths: ["planning"] },
        { name: "a negative budget", input: { ...v1, schedule: "every:60", costCeilingUsd: -1 }, paths: ["costCeilingUsd"] },
        { name: "a budget on one-time work", input: { ...v1, costCeilingUsd: 5 }, paths: ["costCeilingUsd"] },
        { name: "a bad schedule", input: { ...v1, schedule: "every:1" }, paths: ["schedule"] },
        { name: "a long description", input: { ...v1, description: "x".repeat(401) }, paths: ["description"] },
        { name: "a check with an extra key", input: { ...v1, acceptance: [{ ...v1.acceptance[0], approved: true }] }, paths: ["acceptance[0]"] },
        { name: "no checks", input: { ...v1, acceptance: [] }, paths: ["acceptance"] },
        { name: "no questions", input: { ...saved, inputs: [] }, paths: ["inputs"] },
        { name: "a question without a default", input: { ...saved, inputs: [{ key: "module", label: "Module" }] }, paths: ["inputs[0].defaultValue"] },
        { name: "a bad question key", input: { ...saved, inputs: [{ key: "Module", label: "Module", defaultValue: null }] }, paths: ["inputs[0].key"] },
      ],
    });
  });

  it("keeps saved bytes and digests: canonical key order, trimmed text and an empty how as null", () => {
    const parsed = parseRecipe({ ...saved, inputs: [{ key: "module", label: " Module ", defaultValue: " src " }], acceptance: [{ statement: "Tests pass", id: "c1", evidence: ["check"], how: "" }] });
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(saved));
    expect(Object.keys(parsed)).toEqual(Object.keys(saved));
    expect(recipeDigest(parsed)).toBe(SAVED_DIGEST);
    expect(exportRecipe(parsed)).toBe(`${JSON.stringify(saved, null, 2)}\n`);
  });
});
