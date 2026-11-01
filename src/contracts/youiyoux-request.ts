/**
 * A youiyoux change or options request as Toolroll reads it (youiyoux-intake.ts): the published `youi.request/v1`
 * schema (youiyoux's schema/youi.request.schema.json), held to its own limits. Unknown keys are allowed, as the
 * published schema allows them; everything Toolroll reads is checked here, and every string is outside text all the same.
 */

import { z } from "zod";
import { parseContract, type ContractResult } from "./contract.js";

export const REQUEST_ID = /^r-[0-9a-f]{10}$/;
/** An options file's id: `p-` and the same 10 hex as the options request it answers. */
export const PROPOSAL_ID = /^p-[0-9a-f]{10}$/;
/** The provenance every task filed from a request carries (task_ref.filed_via): immutable, and the seal reads it. */
export const YOUIYOUX_FILED_VIA = "youiyoux";
/** The one chat card a pass's filings make for a project (youiyoux-intake.ts), drawn by chat-decide.ts: the new tasks,
 * Approve all and each one's own Approve and Open. */
export const YOUIYOUX_CARD_KIND = "youiyoux-requests";
/** Where a person sees and approves everything waiting on them in the console (flow-triggers.ts NEEDS_YOU_HREF). */
export const YOUIYOUX_HOME_PATH = "/work?view=needs-you";
const text = (max: number) => z.string().min(1).max(max);
const who = z.object({ kind: z.enum(["person", "agent"]), name: text(100) });
// The published schema's date-time: an ISO timestamp with a zone.
const when = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);

export const YOUIYOUX_EVIDENCE = ["screenshot", "check", "changed-path", "manual-review"] as const;
/** A component prop as youiyoux names one: what an option may set. */
const PROP = /^[A-Za-z_$][\w$]{0,63}$/;
const value = z.union([z.string().max(2000), z.number().finite(), z.boolean()]);

/** What an options request offers its agent: the one file to write (`.youi/proposals/<proposal>.json`), the props an
 * option may set (enum values from `values`), and whether it may give the component new text. */
export const youiyouxOfferSchema = z.object({
  proposal: z.string().regex(PROPOSAL_ID),
  file: text(500),
  choices: z.record(z.string().regex(PROP), z.object({
    type: z.enum(["enum", "string", "boolean", "number"]),
    values: z.array(text(200)).max(100).optional(),
    default: value.optional(),
  })).refine(choices => Object.keys(choices).length <= 50, "at most 50 props"),
  text: z.boolean(),
});
export type YouiyouxOffer = z.infer<typeof youiyouxOfferSchema>;

export const youiyouxTaskSchema = z.object({
  title: text(120),
  goal: text(4000),
  touches: z.array(text(500)).max(50),
  touchesKnown: z.boolean(),
  why: text(500).optional(),
  not: z.array(text(300)).max(10),
  acceptance: z.array(z.object({ statement: text(300), evidence: z.array(z.enum(YOUIYOUX_EVIDENCE)).min(1) })).min(1).max(10),
  /** An options request's: what its agent writes (optionsProblem holds it to the request). */
  offer: youiyouxOfferSchema.optional(),
});

export const youiyouxRequestSchema = z.object({
  schema: z.literal("youi.request/v1"),
  id: z.string().regex(REQUEST_ID),
  project: text(200),
  kind: z.enum(["comment", "change", "options"]),
  status: z.enum(["open", "addressed", "closed"]),
  body: text(4000),
  author: who,
  createdAt: when,
  updatedAt: when,
  // Where the person pointed: the page, the component, and (when youiyoux knew it) the file and line that draw it.
  target: z.object({ route: text(300), scope: z.enum(["here", "element"]), name: text(200), file: text(500).optional(), line: z.int().positive().max(Number.MAX_SAFE_INTEGER).optional() }),
  task: youiyouxTaskSchema.optional(),
  thread: z.array(z.unknown()).max(500),
});

export type YouiyouxRequest = z.infer<typeof youiyouxRequestSchema>;
export type YouiyouxTask = z.infer<typeof youiyouxTaskSchema>;

export function readYouiyouxRequest(raw: unknown): ContractResult<YouiyouxRequest> {
  return parseContract(youiyouxRequestSchema, raw);
}

/** The one file an options request's agent may write: `.youi/proposals/p-<the request's hex>.json`. */
export const proposalIdOf = (request: string): string => `p-${request.slice(2)}`;
export const proposalFileOf = (proposal: string): string => `.youi/proposals/${proposal}.json`;

/** Why an options request can't be filed as youiyoux's contract has it, or null: it carries a task with an offer whose
 * proposal is `p-<its own hex>`, whose file is that proposal's, and the task may touch that one file and nothing else. */
export function optionsProblem(request: YouiyouxRequest): string | null {
  if (request.kind !== "options") return null;
  const offer = request.task?.offer;
  if (request.task === undefined || offer === undefined) return "it asks for options with no offer";
  const proposal = proposalIdOf(request.id);
  if (offer.proposal !== proposal) return `its offer is for ${offer.proposal}, not ${proposal}`;
  if (offer.file !== proposalFileOf(proposal)) return `its offer's file isn't ${proposalFileOf(proposal)}`;
  if (!request.task.touchesKnown || request.task.touches.length !== 1 || request.task.touches[0] !== offer.file) return "its task may touch more than its options file";
  return null;
}

/** What Toolroll writes beside a request (`youi.request-task/v1`): the task it became, how that task stands, and, when
 * the console has an address, the task's link and `home`, where a person sees and approves all waiting work. */
export const YOUIYOUX_TASK_STATUSES = ["queued", "needs-you", "building", "ready", "done", "failed", "stopped"] as const;
export type YouiyouxTaskStatus = (typeof YOUIYOUX_TASK_STATUSES)[number];

/** A link youiyoux opens: http or https, at most 2,000 characters, with no user name or password in it. */
export const youiyouxLinkSchema = z.string().max(2000).refine(value => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch { return false; }
}, "an http or https address with no credentials");

export const youiyouxRequestTaskSchema = z.strictObject({
  schema: z.literal("youi.request-task/v1"),
  request: z.string().regex(REQUEST_ID),
  runner: z.literal("Toolroll"),
  task: z.strictObject({ id: z.string().min(1).max(120), url: youiyouxLinkSchema.nullable() }),
  home: youiyouxLinkSchema.optional(),
  status: z.enum(YOUIYOUX_TASK_STATUSES),
  detail: z.string().max(200),
  updatedAt: when,
});
export type YouiyouxRequestTask = z.infer<typeof youiyouxRequestTaskSchema>;

export function readYouiyouxRequestTask(raw: unknown): ContractResult<YouiyouxRequestTask> {
  return parseContract(youiyouxRequestTaskSchema, raw);
}
