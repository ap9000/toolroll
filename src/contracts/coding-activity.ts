/**
 * What the coding workspace saves beside each session (docs/plans/zod-revamp.md, item 19): its activity items
 * (`coding_item.payload`), approval requests (`coding_request.payload` and `rpc_id`) and the native custody witness
 * (`coding_custody.payload`). The session record itself is src/contracts/coding-workspace.ts.
 *
 * These rows carry no `version` and are written byte for byte as before. They were read as casts, so the readers stay
 * tolerant: a row that is not JSON fails as it always did, and a row that does not match its schema is read as saved
 * and logged, never refused. The custody witness is only a recovery proof: one without the shape its checks read
 * proves nothing, as before.
 */

import { z } from "zod";
import { contractError } from "./contract.js";

export const codingItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  text: z.string(),
  status: z.string().nullable(),
  /** The browser's submission key, on a user message it sent. */
  clientId: z.string().exactOptional(),
});
export type CodingItem = z.infer<typeof codingItemSchema>;

export const codingQuestionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string() })),
});
export type CodingQuestion = z.infer<typeof codingQuestionSchema>;

export const codingRequestSchema = z.object({
  id: z.string(),
  kind: z.enum(["command", "files", "questions"]),
  method: z.string(),
  title: z.string(),
  detail: z.string(),
  questions: z.array(codingQuestionSchema),
});
export type CodingRequest = z.infer<typeof codingRequestSchema>;

/** The native JSON-RPC id a request is answered with. */
export const codingRpcIdSchema = z.union([z.string(), z.number()]);
export type CodingRpcId = z.infer<typeof codingRpcIdSchema>;

/** The fields recovery reads from a custody witness before it may count as proof that the prior agent is gone. */
export const codingCustodyWitnessSchema = z.object({
  host: z.string(),
  descendants: z.array(z.unknown()),
  observationUnknown: z.boolean(),
});

function tolerant<T>(schema: z.ZodType, what: string, payload: string): T {
  const value: unknown = JSON.parse(payload);
  const read = schema.safeParse(value);
  if (!read.success) console.warn(`A saved ${what} does not match its contract and is read as saved: ${contractError(read.error, { schema, input: value }).join("; ")}`);
  // The saved value itself: a row written again keeps its bytes.
  return value as T;
}

export const readCodingItem = (payload: string): CodingItem => tolerant(codingItemSchema, "coding item", payload);
export const readCodingRequest = (payload: string): CodingRequest => tolerant(codingRequestSchema, "coding request", payload);
export const readCodingRpcId = (saved: string): CodingRpcId => tolerant(codingRpcIdSchema, "coding request id", saved);

/** The saved witness when it has the shape recovery checks, else null (it proves nothing). Not JSON throws. */
export function readCodingCustodyWitness<T>(payload: string): T | null {
  const value: unknown = JSON.parse(payload);
  return codingCustodyWitnessSchema.safeParse(value).success ? value as T : null;
}
