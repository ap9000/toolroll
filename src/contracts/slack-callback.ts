/**
 * A Slack button tap (slack-chat.ts `receiveSlack`): the `block_actions` interaction Slack sends, and the button data
 * Toolroll put on it. The interaction is Slack's, so fields Toolroll doesn't read are ignored; the button (its
 * `action_id` and one-time token `value`) is Toolroll's. A tap from the paired person whose button can't be read is
 * answered with why (`actions[0].value: must be a Toolroll button token`), and nothing is done.
 */

import { z } from "zod";
import { parseContract, type ContractResult } from "./contract.js";

/** Toolroll's buttons: toolroll_* since the rename; standing_orders_* buttons on older messages still work. */
export const SLACK_BUTTON_ACTION = /^(?:toolroll|standing_orders)_(?:confirm|dismiss|yes|cancel|flow_approve|flow_edit|flow_send_back|flow_choose_[0-3]|flow_note_(?:yes|no)|question_choice|question_words)$/;
/** A link button opens its page in Slack's own client; Slack still reports the tap, and there is nothing to do. */
export const SLACK_LINK_ACTION = /^(?:toolroll|standing_orders)_link(?:_[0-9]+)?$/;

const token = z.string().regex(/^[a-f0-9]{32}$/, { error: "must be a Toolroll button token" });

/** The interaction around a tap: who, and the message the button is on. */
export const slackBlockActionsSchema = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string() }),
  container: z.object({ type: z.string(), channel_id: z.string().optional(), message_ts: z.string().optional() }),
  message: z.object({ thread_ts: z.string().optional() }).optional(),
  actions: z.array(z.object({ action_id: z.string().optional(), value: z.string().optional(), action_ts: z.string().optional() })),
});
export type SlackBlockActions = z.infer<typeof slackBlockActionsSchema>;

/** The one tapped button, as Toolroll made it. */
export const slackButtonSchema = z.object({
  action_id: z.string().regex(SLACK_BUTTON_ACTION, { error: "not a Toolroll button" }),
  value: token,
  action_ts: z.string().regex(/^\d{10,16}\.\d{6}$/, { error: "must be a Slack timestamp" }),
});
export type SlackButton = z.infer<typeof slackButtonSchema>;

export function readSlackBlockActions(body: unknown): ContractResult<SlackBlockActions> {
  return parseContract(slackBlockActionsSchema, body);
}

/** The tapped button: exactly one, Toolroll's (`actions[0].action_id: not a Toolroll button`). */
export function readSlackButton(interaction: SlackBlockActions): ContractResult<SlackButton> {
  const read = parseContract(z.object({ actions: z.array(slackButtonSchema).length(1) }), { actions: interaction.actions });
  return read.ok ? { ok: true, value: read.value.actions[0]! } : read;
}
