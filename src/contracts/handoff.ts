/**
 * The handoff artifact (`handoff.json`, M6.10): one schema for the machine's own statement of where a finished run
 * left the world — workspace identity, exact base and head, which answered decisions the brief carried, the agent's
 * conclusion and lists, and a freshness stamp a successor proves against the branch. `storeHandoffArtifact` writes it
 * and every reader reads it through `readHandoffArtifact`.
 *
 * The agent's own terminal handoff (`STANDING-ORDERS-DONE-*`, `parseHandoff` in decision.ts) is a different contract;
 * this file records what the machine made of it.
 */

import { z } from "zod";
import { readVersioned, versioned, type ContractResult } from "./contract.js";

export const ROUTE_PHASES = ["plan", "build", "repair", "review"] as const;
export const ROUTE_CHOICES = ["recommended", "override", "pinned", "legacy", "fallback"] as const;

/** The sealed route leg the run ran as (v47); absent on handoffs written before routes existed. */
export const handoffRouteSchema = z.strictObject({
  digest: z.string(),
  phase: z.enum(ROUTE_PHASES),
  provider: z.string(),
  model: z.string().nullable(),
  chosen: z.enum(ROUTE_CHOICES),
});

export const HANDOFF_VERSION = 1;

export const handoffSchema = versioned(HANDOFF_VERSION, {
  taskId: z.string(),
  runId: z.int(),
  provider: z.string(),
  /** v47: the exact model that ran. Absent on handoffs written before routes existed. */
  model: z.string().optional(),
  route: handoffRouteSchema.optional(),
  sessionId: z.string().nullable(),
  branch: z.string(),
  worktree: z.string(),
  base: z.string(),
  head: z.string(),
  outcome: z.enum(["built", "no-change"]),
  committed: z.boolean(),
  /** Decision ids whose answers were in this run's brief — causality, not time. */
  decisionsIncorporated: z.array(z.int()),
  /** The agent's conclusion — agent-reported, and labeled so by its position here. */
  conclusion: z.string(),
  /** The agent's structured lists; absent on handoffs written before they existed, read as none. */
  changes: z.array(z.string()).optional(),
  verification: z.array(z.string()).optional(),
  followUps: z.array(z.string()).optional(),
  freshness: z.strictObject({
    stampedAt: z.string(),
    /** A successor proves this against the branch before trusting anything above. */
    currentAsOf: z.string(),
  }),
});

export type HandoffArtifact = z.infer<typeof handoffSchema>;

const HANDOFF_FIELDS = Object.keys(handoffSchema.shape).filter(field => field !== "version");

/**
 * A handoff written before handoffs carried `version` (every handoff through 0.9.34, stamped `schema: 1`), as
 * version 1. The shape is the same; readers then read only the fields they knew and ignored any others, so this keeps
 * exactly the known fields. Anything not stamped `schema: 1` is left as it is, for the schema to refuse by path.
 */
export function upgradeSchemaOneHandoff(body: Record<string, unknown>): Record<string, unknown> {
  if (body["schema"] !== 1) return body;
  const out: Record<string, unknown> = { version: HANDOFF_VERSION };
  for (const field of HANDOFF_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

export const HANDOFF_UPGRADES = { 0: upgradeSchemaOneHandoff } as const;

/** Read a handoff artifact: version 1 as itself, a `schema: 1` one upgraded, a newer one refused plainly. */
export function readHandoffArtifact(input: unknown): ContractResult<HandoffArtifact> {
  return readVersioned(handoffSchema, input, HANDOFF_UPGRADES);
}

/** Read a stored handoff's bytes: JSON first, then the schema. */
export function parseHandoffArtifact(raw: string): ContractResult<HandoffArtifact> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, issues: [{ path: "payload", kind: "invalid", line: "payload: not JSON" }] };
  }
  return readHandoffArtifact(body);
}
