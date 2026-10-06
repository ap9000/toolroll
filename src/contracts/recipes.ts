/**
 * A recipe document (recipes.ts): reusable work a person imports, exports, previews and saves. One schema for both
 * versions, a discriminated union on `version` — version 1 is fixed work, version 2 adds questions whose answers fill
 * `{{key}}` placeholders. Recipes are strict and always were: every key is required, and an unknown one (an approval,
 * provider or credential setting smuggled in) is refused by name.
 *
 * A success check is the scope's own saved criterion (src/contracts/scope.ts), strict about its keys. The reader fills
 * an absent or empty `how` with null before parsing, as the scope reader always has. What JSON Schema can't say runs
 * in recipes.ts after parsing, each refusal naming its field: the 32 KB size, text and placeholder rules, schedules,
 * the budget/schedule/deliverable/planning combinations, question keys and the scope reader's byte, control-character
 * and duplicate checks. Saved recipes and previews keep their exact bytes, so their digests still match.
 */

import { z } from "zod";
import { parseContract, versioned, type ContractResult } from "./contract.js";
import { savedCriterionSchema } from "./scope.js";

export const RECIPE_FORMAT = "standing-orders-recipe";

/** Numbers the recipe rules use, in plain code after parsing (bytes of the whole document, characters of a field). */
export const RECIPE_LIMITS = { documentBytes: 32_768, description: 400, inputs: 8, label: 80, answer: 500 } as const;

/** A question a version 2 recipe asks: its key, its label and an optional default answer (null for none). */
export const recipeInputSchema = z.strictObject({
  key: z.string(),
  label: z.string(),
  defaultValue: z.string().nullable(),
});

const recipeFields = {
  format: z.literal(RECIPE_FORMAT),
  name: z.string(),
  description: z.string(),
  goal: z.string(),
  outOfScope: z.string().nullable(),
  touches: z.array(z.string()),
  acceptance: z.array(savedCriterionSchema),
  planning: z.enum(["auto", "required", "skip"]),
  deliverable: z.enum(["branch", "report"]),
  schedule: z.string().nullable(),
  costCeilingUsd: z.number().positive().nullable(),
};

export const recipeV1Schema = versioned(1, recipeFields);
export const recipeV2Schema = versioned(2, { ...recipeFields, inputs: z.array(recipeInputSchema).min(1).max(RECIPE_LIMITS.inputs) });
export const recipeDocumentSchema = z.discriminatedUnion("version", [recipeV1Schema, recipeV2Schema]);

export type RecipeDocument = z.infer<typeof recipeDocumentSchema>;
export type RecipeInput = z.infer<typeof recipeInputSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A success check as the scope reader reads it: an absent or empty `how` is null; every other key, known or not, as given. */
function checkBody(entry: unknown): unknown {
  if (!isRecord(entry) || (entry["how"] !== undefined && entry["how"] !== "")) return entry;
  return { ...entry, how: null };
}

/** Read a recipe's structure (format and version already checked): every refusal is a path-named issue. */
export function readRecipeDocument(input: Record<string, unknown>): ContractResult<RecipeDocument> {
  const body = Array.isArray(input["acceptance"]) ? { ...input, acceptance: input["acceptance"].map(checkBody) } : input;
  return input["version"] === 2 ? parseContract(recipeV2Schema, body) : parseContract(recipeV1Schema, body);
}
