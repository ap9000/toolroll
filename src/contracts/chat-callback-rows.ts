/**
 * The saved side of a chat button: the row its one-time token names. A proposal card's buttons in Slack, Discord and
 * Teams (`chat_action`, read with the part and event it rides) and a result's, plan's, failure's or pull request's own
 * buttons (`chat_decide_action`, chat-decide.ts). SQLite's own CHECKs bound them when written; these say what a
 * reader may rely on, so a row that isn't that is refused by column, never read as a guess.
 */

import { z } from "zod";
import { parseContract, type ContractResult } from "./contract.js";

const when = z.string();

/** A proposal card's button (chat-delivery.ts), with the part's message and the event's binding, channel and thread. */
export const proposalActionRowSchema = z.strictObject({
  token: z.string(),
  part: z.int(),
  proposal: z.int(),
  phase: z.enum(["confirm", "dismiss", "yes", "cancel"]),
  expires: when,
  consumed: when.nullable(),
  message: z.string().nullable(),
  binding: z.int().nullable(),
  channel: z.string(),
  thread: z.string(),
});
export type ProposalActionRow = z.infer<typeof proposalActionRowSchema>;

export function readProposalActionRow(row: unknown): ContractResult<ProposalActionRow> {
  return parseContract(proposalActionRowSchema, row);
}

export const DECIDE_ACTS = ["accept", "changes", "retry", "approve", "not-now", "merge"] as const;
export const DECIDE_PHASES = ["offer", "yes", "cancel"] as const;

/** A decide button (chat-decide.ts): who and where it was sent, what it does to which task and run, and the stamp it holds. */
export const decideActionRowSchema = z.strictObject({
  token: z.string().regex(/^d:[a-f0-9]{24}$/),
  channel: z.string(),
  binding: z.int(),
  chat: z.string(),
  message: z.string().nullable(),
  act: z.enum(DECIDE_ACTS),
  phase: z.enum(DECIDE_PHASES),
  task_id: z.string(),
  run: z.int().nullable(),
  digest: z.string(),
  created_at: when,
  expires_at: when,
  consumed_at: when.nullable(),
});
export type DecideActionRow = z.infer<typeof decideActionRowSchema>;

export function readDecideActionRow(row: unknown): ContractResult<DecideActionRow> {
  return parseContract(decideActionRowSchema, row);
}
