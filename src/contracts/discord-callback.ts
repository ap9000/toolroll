/**
 * A Discord button tap (discord-chat.ts `receiveDiscord`): the component interaction Discord sends over the gateway,
 * and the button data Toolroll put on it. The interaction is Discord's, so fields Toolroll doesn't read are ignored;
 * the button's `custom_id` (`so_` and a one-time token) is Toolroll's. A tap from the paired person on Toolroll's own
 * message whose button can't be read is answered with why (`data.custom_id: not a Toolroll button`), and nothing is done.
 */

import { z } from "zod";
import { parseContract, type ContractResult } from "./contract.js";

const user = z.object({ id: z.string() });

/** The interaction around a tap (type 3: a message component): the app, the person, the channel, the message. */
export const discordComponentInteractionSchema = z.object({
  type: z.literal(3),
  id: z.string(),
  application_id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  channel: z.object({ type: z.int() }),
  member: z.object({ user }).optional(),
  user: user.optional(),
  message: z.object({ id: z.string(), channel_id: z.string(), author: user }),
  data: z.object({ custom_id: z.unknown().optional() }),
});
export type DiscordComponentInteraction = z.infer<typeof discordComponentInteractionSchema>;

/** Toolroll's button data: `so_` and a one-time token. */
export const discordButtonSchema = z.object({
  custom_id: z.string().regex(/^so_[a-f0-9]{32}$/, { error: "not a Toolroll button" }),
});

export function readDiscordComponentInteraction(body: unknown): ContractResult<DiscordComponentInteraction> {
  return parseContract(discordComponentInteractionSchema, body);
}

/** The tapped button's one-time token. */
export function readDiscordButtonToken(interaction: DiscordComponentInteraction): ContractResult<string> {
  const read = parseContract(z.object({ data: discordButtonSchema }), { data: interaction.data });
  return read.ok ? { ok: true, value: read.value.data.custom_id.slice(3) } : read;
}
