/**
 * The workspace record: one desktop coding session as the coding catalog saves it (`coding_session.document`). The
 * session itself is what the console, chat and the coding handoff read; the record is that session with its
 * `version`. Row ownership, generation and recovery state are checked in plain code by the workspace after parsing.
 */

import { z } from "zod";
import { readVersioned, versioned, type ContractResult } from "./contract.js";
import { codingContextSchema, upgradeUnversionedContext } from "./coding-context.js";

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

const SESSION_FIELDS = Object.keys(codingSessionSchema.shape);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A record saved before it carried `version` (every session through 0.9.36), as version 1. The old reader cast the
 * document and read only the fields it knew, so this keeps exactly those, and upgrades the capture inside it.
 */
export function upgradeUnversionedSession(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { version: CODING_SESSION_VERSION };
  for (const field of SESSION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) out[field] = body[field];
  }
  const context = out["context"];
  if (isRecord(context) && !Object.prototype.hasOwnProperty.call(context, "version")) out["context"] = upgradeUnversionedContext(context);
  return out;
}

export const CODING_SESSION_UPGRADES = { 0: upgradeUnversionedSession } as const;

/** Read a workspace record as its session: version 1 as itself, an unversioned one upgraded, a newer one refused. */
export function readCodingSessionRecord(input: unknown): ContractResult<CodingSession> {
  const read = readVersioned(codingSessionRecordSchema, input, CODING_SESSION_UPGRADES);
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

/** The document a session is saved as: always the current version. */
export function codingSessionDocument(session: CodingSession): string {
  return JSON.stringify({ version: CODING_SESSION_VERSION, ...session });
}
