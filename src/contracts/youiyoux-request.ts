/**
 * A youiyoux change request as Toolroll reads it (youiyoux-intake.ts): the published `youi.request/v1` schema
 * (youiyoux's schema/youi.request.schema.json), held to its own limits. Unknown keys are allowed, as the published
 * schema allows them; everything Toolroll reads is checked here, and every string is outside text all the same.
 */

import { z } from "zod";
import { parseContract, type ContractResult } from "./contract.js";

export const REQUEST_ID = /^r-[0-9a-f]{10}$/;
/** The provenance every task filed from a request carries (task_ref.filed_via): immutable, and the seal reads it. */
export const YOUIYOUX_FILED_VIA = "youiyoux";
const text = (max: number) => z.string().min(1).max(max);
const who = z.object({ kind: z.enum(["person", "agent"]), name: text(100) });
// The published schema's date-time: an ISO timestamp with a zone.
const when = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);

export const YOUIYOUX_EVIDENCE = ["screenshot", "check", "changed-path", "manual-review"] as const;

export const youiyouxTaskSchema = z.object({
  title: text(120),
  goal: text(4000),
  touches: z.array(text(500)).max(50),
  touchesKnown: z.boolean(),
  why: text(500).optional(),
  not: z.array(text(300)).max(10),
  acceptance: z.array(z.object({ statement: text(300), evidence: z.array(z.enum(YOUIYOUX_EVIDENCE)).min(1) })).min(1).max(10),
});

export const youiyouxRequestSchema = z.object({
  schema: z.literal("youi.request/v1"),
  id: z.string().regex(REQUEST_ID),
  project: text(200),
  kind: z.enum(["comment", "change"]),
  status: z.enum(["open", "addressed", "closed"]),
  body: text(4000),
  author: who,
  createdAt: when,
  updatedAt: when,
  target: z.object({ route: text(300), scope: z.enum(["here", "element"]), name: text(200) }),
  task: youiyouxTaskSchema.optional(),
  thread: z.array(z.unknown()).max(500),
});

export type YouiyouxRequest = z.infer<typeof youiyouxRequestSchema>;
export type YouiyouxTask = z.infer<typeof youiyouxTaskSchema>;

export function readYouiyouxRequest(raw: unknown): ContractResult<YouiyouxRequest> {
  return parseContract(youiyouxRequestSchema, raw);
}

/** What Toolroll writes beside a request (`youi.request-task/v1`): the task it became and how that task stands. */
export const YOUIYOUX_TASK_STATUSES = ["queued", "needs-you", "building", "ready", "done", "failed", "stopped"] as const;
export type YouiyouxTaskStatus = (typeof YOUIYOUX_TASK_STATUSES)[number];
export type YouiyouxRequestTask = {
  schema: "youi.request-task/v1";
  request: string;
  runner: "Toolroll";
  task: { id: string; url: string | null };
  status: YouiyouxTaskStatus;
  detail: string;
  updatedAt: string;
};
