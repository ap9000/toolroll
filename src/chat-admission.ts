import { channelInbox } from "./chat-inbox.js";
import { roomCommand } from "./chat-rooms.js";
import type { ChatBinding, ChatState } from "./chat-delivery-state.js";
import type { ChatEventBody } from "./contracts/chat-content.js";
import type { ChatApp } from "./contracts/flow.js";

/**
 * Whether a received message or tap, already proved to come from this app, may be queued — and under which binding.
 * A room (any conversation that isn't a direct message) is taken only while it follows a conversation, for the words
 * that make it follow one, or when it feeds a flow (v89: anyone's message then, as a card with no say over anything).
 * A pairing message comes only from someone unpaired, in a direct message; everything else only from a live paired
 * member in their own conversation or a followed room. Null when it is not taken.
 */
export function admitChatEvent(
  state: ChatState,
  app: ChatApp,
  installation: string,
  event: { kind: "message" | "pair" | "action"; member: string; channel: string; isRoom: boolean; payload: ChatEventBody },
): { binding: ChatBinding | null } | null {
  const { kind, member, channel, isRoom, payload } = event;
  const words = "text" in payload ? payload.text ?? "" : "";
  const inbox = isRoom && kind === "message" ? channelInbox(state.store, app, installation, channel, words) : { watched: false, command: false };
  const roomish = isRoom && (state.room(installation, channel) !== null || (kind === "message" && roomCommand(words) !== null) || inbox.watched || inbox.command);
  if (isRoom && !roomish) return null;
  const binding = state.bindingFor(installation, member);
  const open = inbox.watched && !inbox.command;
  if (kind === "pair" ? !!binding || isRoom : !open && (!binding || !state.live(binding) || (binding.channel !== channel && !roomish))) return null;
  return { binding };
}
