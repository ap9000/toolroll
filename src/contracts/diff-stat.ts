/**
 * The terminal diff-stat (`terminal-diff-stat.json`): one schema for what `parseNumstat` and `budgetedStatJson`
 * write, and the two candidate-inventory reads that use it as a gate's evidence. Toolroll writes it from typed values
 * in its own key order and never rewrites it, so the stored bytes (and every sha256 bound to them) stay as written.
 *
 * Both reads take only the fields their checks use and ignore the rest, exactly as the hand-written checks did: a
 * legacy gate's endpoints, and a saved assessment's file list. Whether those fields match the run is plain code after
 * parsing; anything the schema refuses was refused before too.
 */

import { z } from "zod";
import { parseContract, type ContractResult } from "./contract.js";

/** One file's row. null additions/deletions = binary. */
export const diffStatFileSchema = z.object({
  path: z.string(),
  additions: z.int().nullable(),
  deletions: z.int().nullable(),
  renamedFrom: z.string().optional(),
});

export const diffStatSchema = z.object({
  schema: z.literal(1),
  base: z.string(),
  head: z.string(),
  fileCount: z.int(),
  additions: z.int(),
  deletions: z.int(),
  binaryCount: z.int(),
  files: z.array(diffStatFileSchema),
  /** True when the file list was cut to fit the cap — counts stay complete. */
  filesTruncated: z.boolean(),
});

export type DiffStat = z.infer<typeof diffStatSchema>;
export type DiffStatFile = z.infer<typeof diffStatFileSchema>;

/** What a legacy gate reads of its candidate inventory. `base` may be null, as a run without a base revision has. */
export const candidateEndpointsSchema = diffStatSchema.pick({ head: true, filesTruncated: true }).extend({ base: z.string().nullable() });

/** What a saved assessment reads: the inventory's identity and every changed path. */
export const savedInventorySchema = diffStatSchema
  .pick({ schema: true, head: true, base: true, filesTruncated: true, fileCount: true })
  .extend({ files: z.array(diffStatFileSchema.pick({ path: true })) });

/** A legacy gate's endpoints, from the inventory's parsed JSON (the gate names unreadable JSON itself). */
export function readCandidateEndpoints(input: unknown): ContractResult<z.infer<typeof candidateEndpointsSchema>> {
  return parseContract(candidateEndpointsSchema, input);
}

/** The changed paths of a complete inventory for exactly this candidate, or null: wrong identity, a cut or
 * miscounted list, or a path named twice. */
export function savedInventoryPaths(text: string, head: string, base: string): Set<string> | null {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return null;
  }
  const read = parseContract(savedInventorySchema, input);
  if (!read.ok) return null;
  const inventory = read.value;
  const paths = new Set(inventory.files.map(one => one.path));
  if (inventory.head !== head || inventory.base !== base || inventory.filesTruncated || inventory.fileCount !== inventory.files.length || paths.size !== inventory.files.length) return null;
  return paths;
}
