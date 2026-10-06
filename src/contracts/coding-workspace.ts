/**
 * The workspace record: one desktop coding session as the coding catalog saves it (`coding_session.document`). The
 * session itself is what the console, chat and the coding handoff read; the record is that session with its
 * `version`. Row ownership, generation and recovery state are checked in plain code by the workspace after parsing.
 */

import { z } from "zod";
import { readVersioned, versioned, type ContractResult } from "./contract.js";
import { CODING_CONTEXT_VERSION, codingContextSchema } from "./coding-context.js";

export const CODING_STATUSES = ["starting", "ready", "working", "needs-input", "stopping", "interrupted", "failed", "uncertain", "closed"] as const;

export const codingSessionSchema = z.strictObject({
  id: z.string(),
  owner: z.string(),
  generation: z.int(),
  repo: z.string(),
  title: z.string(),
  provider: z.literal("codex"),
  model: z.string().nullable(),
  branch: z.string(),
  base: z.string(),
  worktree: z.string(),
  nativeThreadId: z.string().nullable(),
  turnId: z.string().nullable(),
  status: z.enum(CODING_STATUSES),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Set once startup or the last message could not be confirmed; absent on sessions that never needed it. */
  deliveryReviewRequired: z.boolean().optional(),
  /** The request the session started with, kept so it is never resent. */
  initialRequest: z.strictObject({ requestId: z.string(), prompt: z.string() }).optional(),
  /** Absent when no managed context was captured. */
  context: codingContextSchema.optional(),
});

export const CODING_SESSION_VERSION = 1;

export const codingSessionRecordSchema = versioned(CODING_SESSION_VERSION, codingSessionSchema.shape);

export type CodingStatus = z.infer<typeof codingSessionSchema>["status"];
export type CodingSession = z.infer<typeof codingSessionSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Unversioned records were read as a cast, including partial fields, nulls and unknown nested keys. Preserve that
 * boundary exactly; only records explicitly written as version 1 are subject to its strict schema.
 */
export function readCodingSessionRecord(input: unknown): ContractResult<CodingSession> {
  if (isRecord(input) && !Object.prototype.hasOwnProperty.call(input, "version")) return { ok: true, value: input as CodingSession };
  const read = readVersioned(codingSessionRecordSchema, input, {}, { distinguishNull: true });
  if (!read.ok) return read;
  const { version: _version, ...session } = read.value;
  return { ok: true, value: session };
}

/** Read a saved `coding_session.document`, throwing a path-named refusal; the catalog was written by Toolroll alone. */
export function parseCodingSessionDocument(document: string): CodingSession {
  let body: unknown;
  try {
    body = JSON.parse(document);
  } catch {
    throw Error("A saved coding session could not be read: payload: not JSON");
  }
  const read = readCodingSessionRecord(body);
  if (!read.ok) throw Error(`A saved coding session could not be read: ${read.issues.map(issue => issue.line).join("; ")}`);
  return read.value;
}

/** Stamp the current version only if the entire record fits, without dropping any legacy fields. */
export function codingSessionDocument(session: CodingSession): string {
  const record = { version: CODING_SESSION_VERSION, ...session };
  if (isRecord(record.context) && !Object.prototype.hasOwnProperty.call(record.context, "version")) {
    record.context = { ...record.context, version: CODING_CONTEXT_VERSION };
  }
  return JSON.stringify(codingSessionRecordSchema.safeParse(record).success ? record : session);
}
