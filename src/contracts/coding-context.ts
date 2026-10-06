/**
 * The managed context a desktop coding session captures once (`prepareCodingContext` in coding-context.ts): the
 * frozen text the agent is given, what it was selected from, and the digest that ties the two together. It is saved
 * inside the session's workspace record and checked again (`verifyCodingContext`) before every resume.
 *
 * `metadata` keeps its own `version: 1` because it is part of the digest; its keys are listed in the order the digest
 * was taken in, so a parsed capture digests exactly as it was saved. Repository identity, digest and the materialized
 * skill files are checked in plain code after parsing.
 */

import { z } from "zod";
import { readVersioned, versioned, type ContractResult } from "./contract.js";

export const codingContextMetadataSchema = z.strictObject({
  version: z.literal(1),
  repo: z.string(),
  identity: z.string(),
  baseRevision: z.string(),
  knowledge: z.strictObject({
    revision: z.int(),
    selectionSha256: z.string(),
    references: z.array(z.strictObject({
      id: z.string(),
      title: z.string(),
      path: z.string().nullable(),
      sourceSha: z.string().nullable(),
      sourceRevision: z.string().nullable(),
    })),
    omitted: z.array(z.strictObject({ title: z.string(), reason: z.string() })),
  }),
  skills: z.strictObject({
    revision: z.int(),
    packages: z.array(z.strictObject({ name: z.string(), sha256: z.string(), skillFile: z.string() })),
  }),
  directory: z.string().nullable(),
  files: z.array(z.strictObject({ path: z.string(), sha256: z.string() })),
});

export const CODING_CONTEXT_VERSION = 1;

export const codingContextSchema = versioned(CODING_CONTEXT_VERSION, {
  text: z.string(),
  metadata: codingContextMetadataSchema,
  /** learningSha of `{ text, metadata }`. */
  sha256: z.string(),
});

export type CodingContextMetadata = z.infer<typeof codingContextMetadataSchema>;
export type CodingContext = z.infer<typeof codingContextSchema>;

const CONTEXT_FIELDS = ["text", "metadata", "sha256"] as const;

/**
 * A capture saved before the envelope carried `version` (every session through 0.9.36), as version 1. Readers then
 * read only these three fields; the metadata is kept exactly as saved, since its bytes are what the digest covers.
 */
export function upgradeUnversionedContext(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { version: CODING_CONTEXT_VERSION };
  for (const field of CONTEXT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

export const CODING_CONTEXT_UPGRADES = { 0: upgradeUnversionedContext } as const;

/** Read a saved capture: version 1 as itself, an unversioned one upgraded, a newer one refused plainly. */
export function readCodingContext(input: unknown): ContractResult<CodingContext> {
  return readVersioned(codingContextSchema, input, CODING_CONTEXT_UPGRADES, { distinguishNull: true });
}
