/**
 * Project knowledge (project-knowledge.ts): one schema for the saved knowledge (instructions and references, every
 * revision in `knowledge_change` and the current one in `project_knowledge`), and for the selection a run is given and
 * keeps (`knowledge_snapshot`). The rules JSON Schema cannot state — UTF-8 byte limits, control characters, secrets,
 * the selection's total size — run in plain code when knowledge is written. A saved payload's digest is checked
 * against its stored bytes before it is parsed, and it is upgraded only in memory: stored bytes are never rewritten.
 */

import { z } from "zod";
import type { TextLimitKey } from "../text-limits.js";
import type { RepositoryContext } from "../repository-context.js";
import { limited, readVersioned, versioned, type ContractResult } from "./contract.js";
import { decisionLineSchema } from "./project-memory.js";

/** How many references a project keeps, and how many a run is given. Text limits live in TEXT_LIMITS. */
export const KNOWLEDGE_COUNTS = { references: 12, selected: 3, decisions: 8 } as const;

/** A text field: bounded by its TEXT_LIMITS entry when written, read as saved (text-limits.ts: reading never
 * re-validates length, so an older runtime still reads text a newer one allowed). */
type Text = (field: string, key: TextLimitKey) => z.ZodString;
const written: Text = limited;
const saved: Text = () => z.string();

const referenceShape = (text: Text) => ({
  id: z.string(),
  title: text("reference title", "knowledgeTitleBytes"),
  content: text("reference text", "knowledgeReferenceBytes"),
  /** A committed .md or .txt file the text was read from, at `sourceRevision` with blob `sourceSha`; null for a note. */
  path: text("reference path", "knowledgePathBytes").nullable(),
  sourceSha: z.string().nullable(),
  sourceRevision: z.string().nullable(),
});

const knowledgeShape = (text: Text) => ({
  instructions: text("instructions", "knowledgeInstructionsBytes"),
  references: z.array(z.strictObject(referenceShape(text))).max(KNOWLEDGE_COUNTS.references),
});

export const KNOWLEDGE_VERSION = 1;

/** Knowledge as it is written. */
export const knowledgeSchema = versioned(KNOWLEDGE_VERSION, knowledgeShape(written));
/** Knowledge as it is read back. */
export const savedKnowledgeSchema = versioned(KNOWLEDGE_VERSION, knowledgeShape(saved));

/** Knowledge as every reader returns it: the payload without its envelope. */
export type Knowledge = Omit<z.infer<typeof knowledgeSchema>, "version">;
export type KnowledgeReference = Knowledge["references"][number];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function pick(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(body, field)) out[field] = body[field];
  return out;
}

const REFERENCE_FIELDS = Object.keys(referenceShape(saved));

/**
 * Knowledge saved before it carried `version` (through 0.9.36: `{instructions, references}`), as version 1. Its
 * readers took the fields they knew, so this keeps exactly those; values are never rewritten.
 */
export function upgradeKnowledgeV0(body: Record<string, unknown>): Record<string, unknown> {
  const references = body["references"];
  return {
    version: KNOWLEDGE_VERSION,
    ...pick(body, ["instructions"]),
    ...(references === undefined ? {} : { references: Array.isArray(references) ? references.map(one => (isRecord(one) ? pick(one, REFERENCE_FIELDS) : one)) : references }),
  };
}

export const KNOWLEDGE_UPGRADES = { 0: upgradeKnowledgeV0 } as const;

/** Read saved knowledge: version 1 as itself, an unversioned one upgraded, a newer one refused plainly. */
export function readKnowledge(input: unknown): ContractResult<Knowledge> {
  const read = readVersioned(savedKnowledgeSchema, input, KNOWLEDGE_UPGRADES);
  if (!read.ok) return read;
  const { version: _version, ...knowledge } = read.value;
  return { ok: true, value: knowledge };
}

/** What a person drafts on the Knowledge page or the CLI; each action reads the fields it needs. */
export const knowledgeDraftSchema = z.strictObject({
  instructions: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  path: z.string().optional(),
  id: z.string().optional(),
});

export type KnowledgeDraft = z.infer<typeof knowledgeDraftSchema>;

/** A source a run was not given, and why. */
export const knowledgeOmissionSchema = z.strictObject({ title: z.string(), reason: z.string() });

const selectionShape = (text: Text) => ({
  revision: z.int().min(0),
  instructions: text("instructions", "knowledgeInstructionsBytes"),
  references: z.array(z.strictObject(referenceShape(text))).max(KNOWLEDGE_COUNTS.references),
  omitted: z.array(knowledgeOmissionSchema),
  /** The run whose selection a reviewer inherited; null for a selection of its own. */
  inheritedFrom: z.int().nullable(),
  /** Settled decisions, one line each; absent when there are none. */
  decisions: z.array(decisionLineSchema).max(KNOWLEDGE_COUNTS.decisions).optional(),
  /** Source excerpts from the crew's checkout (repository-context.ts owns their shape); absent when not captured. */
  repository: z.looseObject({}).optional(),
});

export const KNOWLEDGE_SELECTION_VERSION = 1;

/** The selection a run is given, as it is frozen. The keys are in the order a selection has always been written. */
export const knowledgeSelectionSchema = versioned(KNOWLEDGE_SELECTION_VERSION, selectionShape(written));
/** A frozen selection as it is read back. */
export const savedKnowledgeSelectionSchema = versioned(KNOWLEDGE_SELECTION_VERSION, selectionShape(saved));

export type KnowledgeSelection = Omit<z.infer<typeof knowledgeSelectionSchema>, "repository"> & { repository?: RepositoryContext };

/** Read a frozen selection: version 1 (every selection ever frozen) as itself, a newer one refused plainly. */
export function readKnowledgeSelection(input: unknown): ContractResult<KnowledgeSelection> {
  return readVersioned(savedKnowledgeSelectionSchema, input) as ContractResult<KnowledgeSelection>;
}
