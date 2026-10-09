/**
 * Team conversations inside any chat transport: a group or channel follows
 * one team conversation, a private chat may select one, and messages a
 * paired teammate sends there are saved through the same team operation
 * the browser and CLI use. The transport supplies identity (who sent it),
 * where rooms are recorded, and how to reply; nothing here runs a model.
 */
import type { Store } from "./store.js";
import { TeamLeads } from "./team-leads.js";
import type { TeamActor, TeamConversation } from "./team-contract.js";
import { tooLongText, type PhoneLink } from "./chat-channel.js";
import { LEAD_MESSAGE_MAX_CHARS } from "./lead.js";
import { phoneText } from "./telegram-status.js";

export type RoomCommand = { kind: "list" } | { kind: "select"; index: number } | { kind: "off" };

/** `/team` lists, `/team <n>` chooses, `/team off` (or `private`) leaves.
 * The bare word works too, because Slack and Discord keep unregistered
 * slash text for themselves. Any other text is not ours. */
export function roomCommand(text: string): RoomCommand | null {
  const trimmed = text.trim();
  if (/^\/?team(?:@\w+)?\s*$/i.test(trimmed)) return { kind: "list" };
  const pick = /^\/?team(?:@\w+)?\s+([1-9][0-9]{0,2})\s*$/i.exec(trimmed);
  if (pick !== null) return { kind: "select", index: Number(pick[1]) };
  if (/^\/?team(?:@\w+)?\s+(?:off|private)\s*$/i.test(trimmed)) return { kind: "off" };
  return /^\/team(?:@\w+)?(?:\s|$)/i.test(trimmed) ? { kind: "list" } : null;
}

export const PAIR_FIRST = "Pair your account first: open Settings in Toolroll, choose this chat service, and send the code here in a private chat.";

/** A room is a grant from one exact pairing (`binding`): its delivery and its
 * sends are rechecked against that person's current membership. */
export type Room = { id: number; chatId: string; kind: "group" | "private"; conversation: string; boundBy: string; binding: number; cursor: number };

/** Where a transport records which chat follows which conversation. */
export type RoomBackend = {
  room(chatId: string): Room | null;
  bind(args: { chatId: string; kind: "group" | "private"; conversation: string; by: string; binding: number }): { ok: true } | { ok: false; reason: "group-taken" };
  /** The pairing a room was granted from, if it is still live. */
  grant(binding: number): { approver: string; generation: number; chatId: string } | null;
  unbind(chatId: string, by: string): boolean;
};

export type RoomCounts = { ignored: number; chatQueued?: number; chatRefused?: number; statusReplies?: number };

export type RoomInbound = {
  store: Store;
  /** The transport's request-id prefix, e.g. "telegram", "slack". */
  channel: string;
  backend: RoomBackend;
  chatId: string;
  isGroup: boolean;
  /** The paired sender, already proved by the transport; null when unpaired. */
  sender: { approver: string; generation: number; binding: number } | null;
  /** A transport-unique key for this inbound message (update id, event id). */
  updateKey: string;
  text: string;
  /** The enrolled ceiling; null when unreadable. */
  projects: readonly string[] | null;
  origin: string | null;
  now: Date;
  report: RoomCounts;
  /** Queue one reply into the chat the message came from. */
  say: (text: string, link?: PhoneLink) => void;
};

export function teamRequestId(channel: string, chatId: string, updateKey: string): string {
  return `${channel}:${chatId}:${updateKey}`;
}

function domainFor(store: Store, projects: readonly string[] | null): TeamLeads {
  return new TeamLeads(store, () => projects ?? []);
}

export function conversationRow(store: Store, id: string): { conversation: string; title: string; thread: number; lead: string; leadName: string; visibility: string } | null {
  const row = store.handle.prepare("SELECT c.id, c.title, c.thread, c.lead, c.visibility, l.name FROM team_conversation c JOIN team_lead l ON l.id = c.lead WHERE c.id = ?").get(id);
  return row === undefined ? null : { conversation: String(row["id"]), title: String(row["title"]), thread: Number(row["thread"]), lead: String(row["lead"]), leadName: String(row["name"]), visibility: String(row["visibility"]) };
}

function conversationsFor(domain: TeamLeads, actor: TeamActor): { conversation: TeamConversation; leadName: string }[] {
  try {
    const snapshot = domain.snapshot(actor);
    return snapshot.conversations.map(conversation => ({ conversation, leadName: snapshot.leads.find(lead => lead.id === conversation.leadId)?.name ?? "lead" }));
  } catch {
    return [];
  }
}

function managerOf(domain: TeamLeads, actor: TeamActor, conversationId: string): boolean {
  try { return domain.access(actor, conversationId, "manager").role === "manager"; } catch { return false; }
}

function privateListing(rows: { conversation: TeamConversation; leadName: string }[], current: string | null): string {
  if (rows.length === 0) return "You are not in any team conversation yet. Join one in Toolroll under Chat → Team chat, then send /team again.";
  const lines = ["Your conversations", ""];
  rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${phoneText(row.conversation.title, 80)} — ${row.conversation.visibility === "team" ? "Team" : "Private"} · lead ${phoneText(row.leadName, 40)}${row.conversation.id === current ? " (current)" : ""}`);
  });
  lines.push("", current === null ? "This chat talks to your private assistant. Send /team <number> to talk in a conversation instead." : "Send /team <number> to switch, or /team off for your private assistant.");
  return lines.join("\n");
}

function groupListing(rows: { conversation: TeamConversation; leadName: string }[], current: string | null): string {
  if (rows.length === 0) return "No team conversation you manage is available to this room. Create one in Toolroll under Chat → Team chat, then send /team again.";
  const lines = [current === null ? "Choose the conversation this room follows" : "This room follows a conversation", ""];
  rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${phoneText(row.conversation.title, 80)} — lead ${phoneText(row.leadName, 40)}${row.conversation.id === current ? " (current)" : ""}`);
  });
  lines.push("", "Send /team <number> to follow it (managers only), or /team off to stop. Everyone in this room will read its replies.");
  return lines.join("\n");
}

/**
 * Handle one inbound message that belongs to the team layer. Returns true
 * when it was consumed here (a `/team` command in any chat, any message in
 * a followed room, or a private message while a conversation is selected);
 * false hands the message to the transport's personal path untouched.
 */
export function applyRoomInbound(input: RoomInbound): boolean {
  const { store, backend, chatId, isGroup, sender, now, report, say } = input;
  const command = roomCommand(input.text);
  const room = backend.room(chatId);
  const domain = domainFor(store, input.projects);
  const paired = sender !== null && store.accountOf(sender.approver)?.role === "approver";
  const actor: TeamActor | null = sender === null ? null : { name: sender.approver, generation: sender.generation };

  if (command !== null) {
    report.statusReplies = (report.statusReplies ?? 0) + 1;
    if (!paired || actor === null) { say(PAIR_FIRST); return true; }
    const rows = conversationsFor(domain, actor).filter(row => !isGroup || (row.conversation.visibility === "team" && managerOf(domain, actor, row.conversation.id)));
    const current = room?.conversation ?? null;
    if (command.kind === "list") { say(isGroup ? groupListing(rows, current) : privateListing(rows, current)); return true; }
    if (command.kind === "off") {
      const ended = room !== null && (!isGroup || managerOf(domain, actor, room.conversation) || room.boundBy === actor.name) && backend.unbind(chatId, actor.name);
      say(ended ? (isGroup ? "This room no longer follows a conversation." : "Back to your private assistant.") : isGroup ? "This room follows nothing you can change." : "This chat already talks to your private assistant.");
      return true;
    }
    const chosen = rows[command.index - 1];
    if (chosen === undefined) { say("Choose a number from the list: send /team to see it."); return true; }
    const bound = backend.bind({ chatId, kind: isGroup ? "group" : "private", conversation: chosen.conversation.id, by: actor.name, binding: sender!.binding });
    if (!bound.ok) { say("Another room already follows that conversation. Stop it there first, or choose a different conversation."); return true; }
    say(isGroup
      ? `This room now follows ${phoneText(chosen.conversation.title, 80)} (lead ${phoneText(chosen.leadName, 40)}). Paired members' messages go there; everyone here reads its replies. Send /team off to stop.`
      : `This chat now talks in ${phoneText(chosen.conversation.title, 80)} (lead ${phoneText(chosen.leadName, 40)}). Send /team off for your private assistant.`);
    return true;
  }

  if (room === null) {
    // A room the bot merely sits in stays silent; a private chat falls through to the personal assistant.
    if (isGroup) report.ignored++;
    return isGroup;
  }
  if (!paired || actor === null) {
    // Unpaired members' chatter is nobody's message. A slash attempt gets the one hint.
    if (input.text.trimStart().startsWith("/")) { say(PAIR_FIRST); report.statusReplies = (report.statusReplies ?? 0) + 1; }
    else report.ignored++;
    return true;
  }
  const trimmed = input.text.trim();
  if (trimmed === "") { report.ignored++; return true; }
  if (trimmed.length > LEAD_MESSAGE_MAX_CHARS) { say(tooLongText(trimmed.length)); report.chatRefused = (report.chatRefused ?? 0) + 1; return true; }
  const row = conversationRow(store, room.conversation);
  if (row === null) { backend.unbind(chatId, "system"); report.ignored++; return true; }
  // A current sender must not queue into a destination whose sharing grant
  // ended: it could run successfully while every reply is withheld.
  if (!roomGrantAllowed(store, domain, backend, room)) {
    say(isGroup ? "This room's connection ended. Ask a conversation manager to send /team and connect it again." : "This chat's connection ended. Send /team and choose the conversation again.");
    report.chatRefused = (report.chatRefused ?? 0) + 1;
    return true;
  }
  // Membership first, in the domain's own words: a removed person is told so.
  try { domain.access(actor, row.conversation, "contributor"); }
  catch (error) { say(phoneText(error instanceof Error ? error.message : "You cannot talk in this conversation.", 300)); report.chatRefused = (report.chatRefused ?? 0) + 1; return true; }
  // Consent is the person's own, per conversation, and is checked before the
  // message is saved: an unconsented message must not sit in the shared queue.
  const session = store.teamMateSession(actor.name, row.thread);
  if (session === null || session.approverGeneration !== actor.generation || session.endedAt !== null) {
    say(`${phoneText(row.title, 80)}: enable chat for yourself in Toolroll first (it shows the provider and limits), then send again.`,
      { label: "Enable chat", path: `/chat?conversation=${encodeURIComponent(row.conversation)}` });
    report.chatRefused = (report.chatRefused ?? 0) + 1;
    return true;
  }
  const answer = domain.execute(actor, { operation: "send", args: { conversationId: row.conversation, requestId: teamRequestId(input.channel, chatId, input.updateKey), text: trimmed } }, now);
  if (!answer.ok) { say(phoneText(answer.message, 300)); report.chatRefused = (report.chatRefused ?? 0) + 1; return true; }
  report.chatQueued = (report.chatQueued ?? 0) + 1;
  return true;
}

/** Whether the pairing a room was granted from still holds: live, the same
 * person, still a manager of a team conversation for a group (a viewer for a
 * private selection). */
export function roomGrantAllowed(store: Store, domain: TeamLeads, backend: RoomBackend, room: Room): boolean {
  const grant = backend.grant(room.binding);
  if (grant === null || grant.approver !== room.boundBy || (room.kind === "private" && grant.chatId !== room.chatId)) return false;
  try {
    const access = domain.access({ name: grant.approver, generation: grant.generation }, room.conversation, room.kind === "group" ? "manager" : "viewer");
    return room.kind !== "group" || access.conversation.visibility === "team";
  } catch { return false; }
}

export function teamDomain(store: Store, projects: readonly string[] | null): TeamLeads { return domainFor(store, projects); }

export type RoomMessage = { id: number; role: "assistant" | "operator"; text: string; turn: number | null; author: string | null; requestId: string | null; status: string | null };

/** The conversation messages a room has not received yet, oldest first. */
export function roomMessagesAfter(store: Store, thread: number, cursor: number, limit = 20): RoomMessage[] {
  return store.handle.prepare(`SELECT m.id, m.role, m.text, m.turn, q.author, q.request_id, q.status FROM lead_message m
    LEFT JOIN team_message q ON q.message = m.id WHERE m.thread = ? AND m.id > ? ORDER BY m.id LIMIT ?`).all(thread, cursor, limit)
    .map(row => ({ id: Number(row["id"]), role: row["role"] === "assistant" ? "assistant" as const : "operator" as const, text: String(row["text"]), turn: row["turn"] === null ? null : Number(row["turn"]),
      author: row["author"] === null || row["author"] === undefined ? null : String(row["author"]), requestId: row["request_id"] === null || row["request_id"] === undefined ? null : String(row["request_id"]), status: row["status"] === null || row["status"] === undefined ? null : String(row["status"]) }));
}

/** What a room shows for one message: the lead's reply as is, a teammate's message with its author, this room's own messages and cancelled ones not at all. */
export function roomMessageText(message: RoomMessage, channel: string, chatId: string): string | null {
  if (message.role === "assistant") return message.text;
  const own = message.requestId !== null && message.requestId.startsWith(`${channel}:${chatId}:`);
  if (own || message.status === "cancelled" || message.author === null || message.author.length === 0) return null;
  return `${phoneText(message.author, 40)}: ${message.text}`;
}

/** Whose binding a room card rides: the person the lead was answering, else any paired participant. */
export function roomCardApprover(store: Store, conversation: string, turn: number, paired: readonly string[]): string | null {
  const author = store.handle.prepare("SELECT author FROM team_message WHERE turn_id = ?").get(turn);
  if (author !== undefined && paired.includes(String(author["author"]))) return String(author["author"]);
  const members = new Set(store.handle.prepare("SELECT account FROM team_participant WHERE conversation = ? AND active = 1").all(conversation).map(one => String(one["account"])));
  return paired.find(one => members.has(one)) ?? null;
}
