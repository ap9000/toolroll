/**
 * What the model catalog (model-catalog.ts) reads from outside Toolroll: the Codex CLI's own model list
 * (`~/.codex/models_cache.json`) and npm's latest-version answer for each agent CLI. Both belong to someone else, so
 * both are read loosely: unknown keys are ignored, an entry that doesn't fit is skipped, and a file or answer that
 * doesn't fit at all reads as nothing (an empty list, no version) — never an error.
 */

import { z } from "zod";
import { modelIdSchema } from "./provider.js";

/** One listed Codex model: a usable id, shown in the picker. Its display name is used when it is text. */
export const codexModelSchema = z.object({ slug: modelIdSchema, visibility: z.literal("list"), display_name: z.unknown().optional() });

/** The Codex cache file: its `models` list, entries read one by one with `codexModelSchema`. */
export const codexModelsCacheSchema = z.object({ models: z.array(z.unknown()) });

/** npm's `/<package>/latest` answer: a version starting with major.minor.patch. */
export const npmLatestSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+/) });
