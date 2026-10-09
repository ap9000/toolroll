/**
 * Telegram inside the shared team conversations (v72): a group follows one
 * team conversation, a private chat may select one, and every message a
 * paired teammate sends there is saved through the same team operation the
 * browser and CLI use — same queue, same single writer, same permissions and
 * spending consent. Replies and teammates' messages come back through a
 * per-chat cursor read on every bridge cycle. No model runs here.
 */
import type { Store, TelegramBinding, TelegramTeamChat } from "./store.js";
import { renderReply, shapeReplyParts } from "./reply-shape.js";
import { TeamLeads } from "./team-leads.js";
import type { TeamActor, TeamConversation } from "./team-contract.js";
import { proposalPreview, tooLongText } from "./chat-channel.js";
import { PART_CAP, mintCardTokens, phoneLinkButton, splitParts, type InlineButton } from "./telegram-lead.js";
import type { TelegramTransport } from "./telegram.js";
import { LEAD_MESSAGE_MAX_CHARS } from "./lead.js";
import { phoneText } from "./telegram-status.js";
import type { TelegramMessage } from "./contracts/telegram-callback.js";

export type TeamCommand = { kind: "list" } | { kind: "select"; index: number } | { kind: "off" };

/** `/team` lists, `/team <n>` chooses, `/team off` (or `private`) leaves. Any other slash text is not ours. */
export function teamCommand(text: string): TeamCommand | null {
  const trimmed = text.trim();
  if (/^\/team(?:@\w+)?\s*$/.test(trimmed)) return { kind: "list" };
  const pick = /^\/team(?:@\w+)?\s+([1-9][0-9]{0,2})\s*$/.exec(trimmed);
  if (pick !== null) return { kind: "select", index: Number(pick[1]) };
  if (/^\/team(?:@\w+)?\s+(?:off|private)\s*$/i.test(trimmed)) return { kind: "off" };
  return /^\/team(?:@\w+)?(?:\s|$)/.test(trimmed) ? { kind: "list" } : null;
}

export const PAIR_FIRST = "Pair your phone first: open Settings → Telegram in Toolroll, then send the code here in a private chat.";

type Counts = { ignored: number; chatQueued?: number; chatRefused?: number; statusReplies?: number; problems: string[] };

export type TeamInbound = {
  store: Store;
  botId: string;
  now: Date;
  report: Counts;
  /** The enrolled ceiling read for this update; null when unreadable. */
  projects: readonly string[] | null;
  phoneOrigin: (() => string | null) | undefined;
  updateId: number;
  message: TelegramMessage;
  /** Queue one reply for after the update's transaction commits. */
  say: (chatId: string, text: string, keyboard?: InlineButton[][]) => void;
};

function domainFor(store: Store, projects: readonly string[] | null): TeamLeads {
  return new TeamLeads(store, () => projects ?? []);
}

function actorOf(binding: TelegramBinding): TeamActor {
  return { name: binding.approver, generation: binding.approverGeneration };
}

function conversationRow(store: Store, id: string): { conversation: string; title: string; thread: number; lead: string; leadName: string; visibility: string } | null {
  const row = store.handle.prepare("SELECT c.id, c.title, c.thread, c.lead, c.visibility, l.name FROM team_conversation c JOIN team_lead l ON l.id = c.lead WHERE c.id = ?").get(id);
  return row === undefined ? null : { conversation: String(row["id"]), title: String(row["title"]), thread: Number(row["thread"]), lead: String(row["lead"]), leadName: String(row["name"]), visibility: String(row["visibility"]) };
}

/** The conversations a person may talk in, with their lead's name, as the console lists them. */
function conversationsFor(store: Store, domain: TeamLeads, actor: TeamActor): { conversation: TeamConversation; leadName: string }[] {
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

function audience(conversation: TeamConversation): string {
  return conversation.visibility === "team" ? "Team" : "Private";
}

/** The `/team` listing for a private chat: everything the person can talk in, the current choice marked. */
function privateListing(rows: { conversation: TeamConversation; leadName: string }[], current: string | null): string {
  if (rows.length === 0) return "You are not in any team conversation yet. Join one in Toolroll under Chat → Team chat, then send /team again.";
  const lines = ["Your conversations", ""];
  rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${phoneText(row.conversation.title, 80)} — ${audience(row.conversation)} · lead ${phoneText(row.leadName, 40)}${row.conversation.id === current ? " (current)" : ""}`);
  });
  lines.push("", current === null ? "This chat talks to your private assistant. Send /team <number> to talk in a conversation instead." : "Send /team <number> to switch, or /team off for your private assistant.");
  return lines.join("\n");
}

function groupListing(rows: { conversation: TeamConversation; leadName: string }[], current: string | null): string {
  if (rows.length === 0) return "No team conversation you manage is available to this group. Create one in Toolroll under Chat → Team chat, then send /team again.";
  const lines = [current === null ? "Choose the conversation this group follows" : "This group follows a conversation", ""];
  rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${phoneText(row.conversation.title, 80)} — lead ${phoneText(row.leadName, 40)}${row.conversation.id === current ? " (current)" : ""}`);
  });
  lines.push("", "Send /team <number> to follow it (managers only), or /team off to stop. Everyone in this group will read its replies.");
  return lines.join("\n");
}

/**
 * Handle one inbound message that belongs to the team layer. Returns true
 * when it was consumed here (a `/team` command in any chat, any message in
 * a group, or a private message while a conversation is selected); false
 * hands the update to the older personal paths untouched.
 */
export function applyTeamInbound(input: TeamInbound): boolean {
  const { store, botId, now, report, message, say } = input;
  const chat = message.chat;
  const from = message.from;
  if (chat === undefined || from === undefined) return false;
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const isPrivate = chat.type === "private";
  if (!isGroup && !isPrivate) return false;
  const chatId = String(chat.id);
  const suspicious = message.text === undefined || message.forward_origin !== undefined || message.forward_date !== undefined ||
    message.via_bot !== undefined || message.sender_chat !== undefined || message.caption !== undefined;
  if (suspicious) {
    if (isGroup) { report.ignored++; return true; }
    return false;
  }
  const text = message.text!;
  const command = teamCommand(text);
  const binding = store.liveTelegramBindingFor(botId, String(from.id));
  const paired = binding !== null && store.accountOf(binding.approver)?.role === "approver";
  const teamChat = store.telegramTeamChat(botId, chatId);
  const domain = domainFor(store, input.projects);

  if (command !== null) {
    report.statusReplies = (report.statusReplies ?? 0) + 1;
    if (!paired || binding === null) { say(chatId, PAIR_FIRST); return true; }
    const actor = actorOf(binding);
    const rows = conversationsFor(store, domain, actor).filter(row => !isGroup || (row.conversation.visibility === "team" && managerOf(domain, actor, row.conversation.id)));
    const current = teamChat?.conversation ?? null;
    if (command.kind === "list") { say(chatId, isGroup ? groupListing(rows, current) : privateListing(rows, current)); return true; }
    if (command.kind === "off") {
      const ended = teamChat !== null && (!isGroup || managerOf(domain, actor, teamChat.conversation) || teamChat.boundBy === actor.name) && store.unbindTelegramTeamChat(botId, chatId, actor.name, now);
      say(chatId, ended ? (isGroup ? "This group no longer follows a conversation." : "Back to your private assistant.") : isGroup ? "This group follows nothing you can change." : "This chat already talks to your private assistant.");
      return true;
    }
    const chosen = rows[command.index - 1];
    if (chosen === undefined) { say(chatId, `Choose a number from the list: send /team to see it.`); return true; }
    const bound = store.bindTelegramTeamChat({ botId, chatId, kind: isGroup ? "group" : "private", conversation: chosen.conversation.id, by: actor.name, binding: binding.id }, now);
    if (!bound.ok) { say(chatId, "Another group already follows that conversation. Stop it there first, or choose a different conversation."); return true; }
    say(chatId, isGroup
      ? `This group now follows ${phoneText(chosen.conversation.title, 80)} (lead ${phoneText(chosen.leadName, 40)}). Paired members' messages go there; everyone here reads its replies. Send /team off to stop.`
      : `This chat now talks in ${phoneText(chosen.conversation.title, 80)} (lead ${phoneText(chosen.leadName, 40)}). Send /team off for your private assistant.`);
    return true;
  }

  if (teamChat === null) {
    // A group the bot merely sits in stays silent; a private chat falls through to the personal assistant.
    if (isGroup) report.ignored++;
    return isGroup;
  }
  if (!paired || binding === null) {
    // Unpaired members' chatter is nobody's message. A slash attempt gets the one hint.
    if (text.trimStart().startsWith("/")) { say(chatId, PAIR_FIRST); report.statusReplies = (report.statusReplies ?? 0) + 1; }
    else report.ignored++;
    return true;
  }
  // A current sender must not queue into a destination whose sharing grant
  // ended: it could run successfully while every reply is withheld.
  const grant = store.liveTelegramBindingById(teamChat.binding);
  let connected = false;
  try {
    if (grant !== null && grant.botId === botId && grant.approver === teamChat.boundBy &&
      (isGroup || grant.id === binding.id)) {
      const access = domain.access(actorOf(grant), teamChat.conversation, isGroup ? "manager" : "viewer");
      connected = !isGroup || access.conversation.visibility === "team";
    }
  } catch { /* Give a reconnect instruction without disclosing conversation content. */ }
  if (!connected) {
    say(chatId, isGroup ? "This group's connection ended. Ask a conversation manager to send /team and connect it again." : "This chat's connection ended. Send /team and choose the conversation again.");
    report.chatRefused = (report.chatRefused ?? 0) + 1;
    return true;
  }
  const trimmed = text.trim();
  if (trimmed === "") { report.ignored++; return true; }
  if (trimmed.length > LEAD_MESSAGE_MAX_CHARS) { say(chatId, tooLongText(trimmed.length)); report.chatRefused = (report.chatRefused ?? 0) + 1; return true; }
  const actor = actorOf(binding);
  const row = conversationRow(store, teamChat.conversation);
  if (row === null) { store.unbindTelegramTeamChat(botId, chatId, "system", now); report.ignored++; return true; }
  // Membership first, in the domain's own words: a removed person is told so.
  try { domain.access(actor, row.conversation, "contributor"); }
  catch (error) { say(chatId, phoneText(error instanceof Error ? error.message : "You cannot talk in this conversation.", 300)); report.chatRefused = (report.chatRefused ?? 0) + 1; return true; }
  // Consent is the person's own, per conversation, and is checked before the
  // message is saved: an unconsented message must not sit in the shared queue.
  const session = store.teamMateSession(actor.name, row.thread);
  if (session === null || session.approverGeneration !== actor.generation || session.endedAt !== null) {
    const origin = input.phoneOrigin?.() ?? null;
    const link = phoneLinkButton(origin, { label: "Enable chat", path: `/chat?conversation=${encodeURIComponent(row.conversation)}` });
    say(chatId, `${phoneText(row.title, 80)}: enable chat for yourself in Toolroll first (it shows the provider and limits), then send again.`, link === null ? undefined : [link]);
    report.chatRefused = (report.chatRefused ?? 0) + 1;
    return true;
  }
  const answer = domain.execute(actor, { operation: "send", args: { conversationId: row.conversation, requestId: teamRequestId(chatId, input.updateId), text: trimmed } }, now);
  if (!answer.ok) { say(chatId, phoneText(answer.message, 300)); report.chatRefused = (report.chatRefused ?? 0) + 1; return true; }
  report.chatQueued = (report.chatQueued ?? 0) + 1;
  return true;
}

/** The request identity a Telegram message carries into the team queue: the chat and the update, so the same update never saves twice and delivery can tell its own messages apart. */
export function teamRequestId(chatId: string, updateId: number): string {
  return `telegram:${chatId}:${updateId}`;
}

type TeamDeliveryReport = { sent: number; problems: string[] };

/**
 * Carry new conversation messages to every chat that follows one: the
 * lead's replies, teammates' messages (never this chat's own), and each
 * reply's pending cards. Read from the cursor on every cycle; a failed send
 * leaves the cursor where it was, so the next cycle retries the same
 * message rather than skipping it.
 */
export async function deliverTeamChats(
  store: Store, botId: string, transport: TelegramTransport, clock: () => Date, report: TeamDeliveryReport,
  projects: readonly string[], phoneOrigin?: () => string | null,
  options: { readProjects?: () => Promise<readonly string[]>; canDeliver?: () => boolean } = {},
): Promise<void> {
  for (const chat of store.listTelegramTeamChats(botId)) {
    // Selection is a grant from an exact pairing. Current membership, scope,
    // and the selection itself are rechecked after each await and before each
    // send; another person's new pairing cannot inherit this destination.
    const access = async (): Promise<readonly string[] | null> => {
      try {
        if (options.canDeliver !== undefined && !options.canDeliver()) return null;
        const enrolled = options.readProjects === undefined ? projects : await options.readProjects();
        if (options.canDeliver !== undefined && !options.canDeliver()) return null;
        if (store.telegramTeamChat(botId, chat.chatId)?.id !== chat.id) return null;
        const binding = store.liveTelegramBindingById(chat.binding);
        if (binding === null || binding.botId !== botId || binding.approver !== chat.boundBy ||
          (chat.kind === "private" && binding.chatId !== chat.chatId)) return null;
        const allowed = domainFor(store, enrolled).access(actorOf(binding), chat.conversation, chat.kind === "group" ? "manager" : "viewer");
        if (chat.kind === "group" && allowed.conversation.visibility !== "team") return null;
        return allowed.conversation.projects;
      } catch { return null; }
    };
    if (await access() === null) continue;
    const row = conversationRow(store, chat.conversation);
    if (row === null) continue;
    const pending = store.handle.prepare(`SELECT m.id, m.role, m.text, m.turn, q.author, q.request_id, q.status FROM lead_message m
      LEFT JOIN team_message q ON q.message = m.id WHERE m.thread = ? AND m.id > ? ORDER BY m.id LIMIT 20`).all(row.thread, chat.cursor);
    for (const message of pending) {
      const id = Number(message["id"]);
      const role = String(message["role"]);
      const requestId = message["request_id"] === null || message["request_id"] === undefined ? null : String(message["request_id"]);
      const ownMessage = requestId !== null && requestId.startsWith(`telegram:${chat.chatId}:`);
      const status = message["status"] === null || message["status"] === undefined ? null : String(message["status"]);
      const skip = role === "operator" && (ownMessage || status === "cancelled" || String(message["author"] ?? "").length === 0);
      const prefix = `telegram-team:${chat.id}:`;
      if (!skip) {
        // The lead's reply is split as written, then each part shaped and measured as Telegram shows it, so no cut lands
        // inside a link and no rendered part passes Telegram's ceiling.
        const text = role === "assistant" ? shapeReplyParts(String(message["text"]), PART_CAP, { appOrigin: phoneOrigin?.() ?? null }, shaped => renderReply(shaped, "telegram").length).map(part => renderReply(part, "telegram")) : `${phoneText(String(message["author"]), 40)}: ${String(message["text"])}`;
        const sent = await sendParts(store, transport, chat.chatId, text, `${prefix}message:${id}`, clock, access, report);
        if (sent !== null) { report.problems.push(`team chat ${chat.chatId}: ${sent}`); break; }
      }
      let complete = true;
      if (role === "assistant" && message["turn"] !== null) {
        const turn = Number(message["turn"]);
        const cardBinding = cardBindingFor(store, botId, chat, turn);
        for (const proposal of store.listLeadProposals(row.thread, ["pending"]).filter(one => one.turn === turn)) {
          const enrolled = await access();
          if (enrolled === null) { complete = false; break; }
          const preview = proposalPreview(store, proposal, enrolled, "telegram");
          if (store.serviceCursor(`${prefix}proposal:${proposal.id}`) >= splitParts(preview.text).length) continue;
          const keyboard: InlineButton[][] = [];
          let tokens: string[] = [];
          if (preview.buttons && cardBinding !== null) {
            const minted = mintCardTokens(store, cardBinding, proposal.id, clock(), undefined, chat.chatId);
            keyboard.push(...minted.keyboard); tokens = minted.tokens;
          }
          const link = preview.buttons ? null : phoneLinkButton(phoneOrigin?.() ?? null, { label: "Open in Toolroll", path: `/chat?conversation=${encodeURIComponent(row.conversation)}&proposal=${proposal.id}` });
          if (link !== null) keyboard.push(link);
          const problem = await sendParts(store, transport, chat.chatId, preview.text, `${prefix}proposal:${proposal.id}`, clock, access, report, keyboard.length === 0 ? undefined : keyboard, tokens);
          if (problem !== null) {
            for (const token of tokens) store.consumeTelegramProposalAction(token, clock());
            report.problems.push(`team card ${proposal.id}: ${problem}`); complete = false; break;
          }
        }
      }
      if (!complete || await access() === null) break;
      // Commit only after the body and every card are delivered. Confirmed
      // parts survive a retry, so a failed card does not repeat the body.
      store.transact(() => {
        if (store.advanceTelegramTeamCursor(chat.id, id)) store.handle.prepare("DELETE FROM service_cursor WHERE key LIKE ?").run(`${prefix}%`);
      });
    }
  }
}

/** Whose binding a group card's tokens ride: the person the lead was answering, else any paired member of the conversation. */
function cardBindingFor(store: Store, botId: string, chat: TelegramTeamChat, turn: number): TelegramBinding | null {
  const author = store.handle.prepare("SELECT author FROM team_message WHERE turn_id = ?").get(turn);
  const bindings = store.liveTelegramBindings(botId);
  if (chat.kind === "private") return bindings.find(one => one.chatId === chat.chatId) ?? null;
  const own = author === undefined ? undefined : bindings.find(one => one.approver === String(author["author"]));
  if (own !== undefined) return own;
  const members = new Set(store.handle.prepare("SELECT account FROM team_participant WHERE conversation = ? AND active = 1").all(chat.conversation).map(one => String(one["account"])));
  return bindings.find(one => members.has(one.approver)) ?? null;
}

async function sendParts(
  store: Store, transport: TelegramTransport, chatId: string, text: string | readonly string[], receipt: string, clock: () => Date,
  access: () => Promise<readonly string[] | null>, report: TeamDeliveryReport, keyboard?: InlineButton[][], tokens: string[] = [],
): Promise<string | null> {
  const parts = typeof text === "string" ? splitParts(text) : text;
  const delivered = store.serviceCursor(receipt);
  for (const [index, part] of parts.entries()) {
    if (index < delivered) continue;
    if (await access() === null) return "conversation access changed; delivery stopped";
    const last = index === parts.length - 1;
    try {
      const answer = await transport("sendMessage", { chat_id: chatId, text: part, link_preview_options: { is_disabled: true }, ...(last && keyboard !== undefined ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
      if (!answer.ok) return answer.description ?? "Telegram did not accept the message";
      const messageId = typeof answer.result === "object" && answer.result !== null ? (answer.result as { message_id?: unknown }).message_id : undefined;
      if (typeof messageId !== "number") return "Telegram did not confirm a message id";
      store.transact(() => {
        if (last && tokens.length > 0) store.placeTelegramProposalActions(tokens, String(messageId));
        store.setServiceCursor(receipt, index + 1, clock());
      });
      report.sent++;
    } catch (error) {
      return `Telegram transport failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return null;
}
