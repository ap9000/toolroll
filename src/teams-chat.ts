/** Microsoft Teams on the shared chat layer: activities in, Adaptive Cards
 * out, the same durable receipts, rooms and commands as every other channel. */
import { resultShotsPruned } from "./result-shots.js";
import { chatQuestionButtons } from "./teammate-question.js";
import { chatAskButtons } from "./chat-ask.js";
import { ChatDeliveryError, ChatState, chatHash, partContent, type ChatContent, type ChatIdentity, type ChatPart } from "./chat-delivery-state.js";
import { channelAccess, chatObject as object, planChatNotifications, planRoomMessages, processChatEvent, splitChatText, type ChatDeliveryOptions } from "./chat-delivery.js";
import { PLATFORM_LIMITS } from "./text-limits.js";
import { roomCommand } from "./chat-rooms.js";
import { MATE_MESSAGE_MAX_CHARS } from "./mate.js";
import { renderReply } from "./reply-shape.js";
import { armedCardText, armedYesLabel, proposalLink, proposalOutcomeText, proposalPreview } from "./chat-channel.js";
import { chatFlowButtons } from "./chat-flow.js";
import { channelInbox } from "./chat-inbox.js";
import { chatResultHref } from "./chat-controls.js";
import { TeamsError, type TeamsApi } from "./teams-api.js";
import { readTeamsSubmit } from "./contracts/teams-callback.js";
import type { ChatEventBody } from "./contracts/chat-content.js";

export type TeamsChatOptions = Omit<ChatDeliveryOptions, "state" | "label" | "member" | "partSize" | "maxProposal"> & { api: TeamsApi };

const serviceKey = (conversation: string) => `serviceUrl:${conversation}`;
export const teamsUserId = (v: unknown): v is string => typeof v === "string" && /^29:[A-Za-z0-9_=-]{10,200}$/.test(v);
/** A conversation id; a channel post's carries its thread as ";messageid=<first message>" (v89). */
export const teamsConversationId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9:@._%-]{8,300}(;messageid=[0-9]{1,20})?$/.test(v);
const validServiceUrl = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try { const url = new URL(v); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
};

export async function teamsMember(api: TeamsApi, state: ChatState, installation: string, member: string, channel: string): Promise<boolean> {
  const serviceUrl = state.meta(installation, serviceKey(channel));
  if (serviceUrl === null) return false;
  try {
    const found = await api("GET", serviceUrl, `/v3/conversations/${encodeURIComponent(channel)}/members/${encodeURIComponent(member)}`);
    return found.id === member;
  } catch (error) {
    if (error instanceof TeamsError && error.uncertain) throw error;
    return false;
  }
}

export const teamsDelivery = (options: TeamsChatOptions): ChatDeliveryOptions => {
  const state = new ChatState(options.store, "teams");
  return {
    ...options,
    state,
    label: "Teams",
    member: (member, channel) => teamsMember(options.api, state, options.identity.installation, member, channel),
    // "Typing…" while the lead works; Teams gives bots no reactions, so there is no 👍 here.
    warm: (event) => ({
      typing: async () => {
        const serviceUrl = state.meta(options.identity.installation, serviceKey(event.channel));
        if (serviceUrl !== null) await options.api("POST", serviceUrl, `/v3/conversations/${encodeURIComponent(event.channel)}/activities`, { type: "typing" });
      },
    }),
    partSize: 3500,
    maxProposal: 6000,
  };
};
export const processTeamsEvent = (options: TeamsChatOptions) => processChatEvent(teamsDelivery(options));
export const planTeamsRooms = (options: TeamsChatOptions) => planRoomMessages(teamsDelivery(options));
export const planTeamsNotifications = (options: TeamsChatOptions) => planChatNotifications(teamsDelivery(options));

/** Strip the bot's own mention from channel text; Teams delivers channel messages only when the bot is mentioned. */
function withoutMentions(text: string): string {
  return text.replace(/<at>[^<]*<\/at>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Save one Bot Framework activity before it is acknowledged: a personal
 * message (or `pair <code>`), a channel message where the bot was mentioned,
 * or an Adaptive Card submit carrying one of our tokens. The token that
 * authenticated the request is never stored; only the service URL the
 * conversation replies through is kept, per conversation.
 */
export function receiveTeams(state: ChatState, identity: ChatIdentity, raw: unknown, serviceUrlClaim: string | null, now: Date): boolean {
  const activity = object(raw);
  if (activity.type !== "message") return false;
  const conversation = object(activity.conversation), from = object(activity.from), recipient = object(activity.recipient);
  const channel = conversation.id, member = from.id, id = activity.id;
  const isRoom = conversation.conversationType === "channel" || conversation.conversationType === "groupChat";
  if (!teamsConversationId(channel) || !teamsUserId(member) || typeof id !== "string" || id.length > 200) return false;
  if (recipient.id !== identity.bot || (typeof conversation.tenantId === "string" && conversation.tenantId.toLowerCase() !== identity.team)) return false;
  if (!validServiceUrl(activity.serviceUrl) || (serviceUrlClaim !== null && serviceUrlClaim.replace(/\/$/, "") !== activity.serviceUrl.replace(/\/$/, ""))) return false;
  if (!isRoom && conversation.conversationType !== "personal") return false;
  // A card's button: its data is Toolroll's. One that can't be read is answered with why, once the tap is proved to
  // be the paired person's below. A button carries no words of its own: other data beside words is a message, as before.
  const read = activity.value === undefined || activity.value === null ? null : readTeamsSubmit(activity.value);
  const button = read !== null && (read.ok || typeof activity.text !== "string") ? read : null;
  const submitted = button?.ok === true ? button.value : null;
  let kind: "message" | "pair" | "action", payload: ChatEventBody, eventId: string;
  if (button !== null) {
    kind = "action";
    payload = button.ok ? { token: button.value } : { problem: button.issues.map(issue => issue.line).join("; ") };
    eventId = chatHash(`${identity.installation}:action:${member}:${activity.replyToId ?? id}:${submitted ?? JSON.stringify(activity.value) ?? ""}`);
  } else {
    if (typeof activity.text !== "string") return false;
    const text = isRoom ? withoutMentions(activity.text) : activity.text.trim();
    const pair = /^pair ([a-f0-9]{32})$/.exec(text);
    kind = pair ? "pair" : "message";
    payload = pair ? { hash: chatHash(pair[1]!) } : { text: text.slice(0, MATE_MESSAGE_MAX_CHARS + 1), originalLength: text.length,
      ...(Array.isArray(activity.attachments) && activity.attachments.length > 0 ? { unsupported: "Incoming files are not supported yet. Describe the request in a message; saved result screenshots open from their links." } : {}) };
    eventId = chatHash(`${identity.installation}:message:${id}`);
  }
  const words = "text" in payload ? payload.text ?? "" : "";
  // v89: a channel that feeds a flow takes anyone's message (as a card, with no say over anything); "flow 12" connects one.
  const inbox = isRoom && kind === "message" ? channelInbox(state.store, "teams", identity.installation, channel, words) : { watched: false, command: false };
  const roomish = isRoom && (state.room(identity.installation, channel) !== null || (kind === "message" && roomCommand(words) !== null) || inbox.watched || inbox.command);
  if (isRoom && !roomish) return false;
  const binding = state.bindingFor(identity.installation, member);
  const open = inbox.watched && !inbox.command;
  if (kind === "pair" ? !!binding || isRoom : !open && (!binding || !state.live(binding) || (binding.channel !== channel && !roomish))) return false;
  return state.store.transact(() => {
    state.setMeta(identity.installation, serviceKey(channel), activity.serviceUrl as string, now);
    return state.enqueue({
      id: eventId, installation: identity.installation, binding: kind === "pair" || binding === null ? null : binding.id, kind, channel, member,
      ts: kind === "action" ? String(activity.replyToId ?? id) : id, thread: kind === "action" ? String(activity.replyToId ?? id) : id,
      payload, created: now.toISOString(),
    });
  });
}

function openUrlAction(origin: string | null, target: ChatContent["link"]): Record<string, unknown>[] {
  if (!origin || !target || !target.path.startsWith("/") || target.path.startsWith("//")) return [];
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return [];
    return [{ type: "Action.OpenUrl", title: target.label.slice(0, 80), url: url.origin + target.path }];
  } catch { return []; }
}

/** One Adaptive Card: plain text (within PLATFORM_LIMITS.teams: teamsMessages splits longer), then the buttons (submit tokens, or one link). */
export function teamsCard(text: string, actions: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: { type: "AdaptiveCard", version: "1.4", $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        body: [{ type: "TextBlock", text, wrap: true }], ...(actions.length ? { actions } : {}) },
    }],
  };
}

/** Text longer than one Teams message, as several, never cut: the leading parts as plain messages, and the last as
 * `last` makes it (a card with the buttons, or a message), so the buttons come after all of the text. */
export function teamsMessages(text: string, markdown: boolean, last: (text: string) => Record<string, unknown>): Record<string, unknown>[] {
  const parts = text.length <= PLATFORM_LIMITS.teams ? [text] : splitChatText(text, PLATFORM_LIMITS.teams);
  return parts.map((part, at) => at === parts.length - 1 ? last(part) : { type: "message", text: part, textFormat: markdown ? "markdown" : "plain" });
}

/** Send the next pending part: a plain message, an edit, or a card with its tokens. */
export async function deliverTeamsPart(options: TeamsChatOptions): Promise<boolean> {
  const shared = teamsDelivery(options), state = shared.state, { store, identity } = options, now = options.clock?.() ?? new Date();
  if (!options.current() || !state.owns(identity.installation, options.owner, now)) return false;
  const row = state.prepare(
    "SELECT p.* FROM chat_part p JOIN chat_event e ON e.id=p.event WHERE e.installation=? AND p.state='pending' AND (e.kind!='notice' OR ?=1) AND (p.next_at IS NULL OR p.next_at<=?) ORDER BY p.created,p.id LIMIT 1",
  ).get(identity.installation, options.canNotify?.() === false ? 0 : 1, now.toISOString()) as ChatPart | undefined;
  if (!row) return false;
  const event = state.event(row.event)!, binding = event.binding === null ? null : state.bindingById(event.binding);
  if (!binding || new Date(row.created).getTime() + 86_400_000 < now.getTime()) {
    state.prepare("UPDATE chat_part SET state='dropped',problem='Delivery expired or access changed; open the saved chat' WHERE id=?").run(row.id);
    return true;
  }
  try {
    const session = event.session === null ? null : store.getMateSession(event.session);
    const repos = await channelAccess(shared, binding, session?.ceilingDigest);
    if (event.kind === "notice" && options.canNotify?.() === false) return false;
    const content = partContent(row.payload);
    const destination = content.channel ?? binding.channel;
    const serviceUrl = state.meta(identity.installation, serviceKey(destination));
    if (serviceUrl === null) throw new TeamsError("This Teams conversation has no known service address yet; send it a message first", 60_000);
    if (content.task && !repos.includes(store.lookupRef(content.task)?.repo ?? "")) throw new TeamsError("Connected projects changed");
    let text = content.text, actions: Record<string, unknown>[] = [];
    if (content.image && content.shot && resultShotsPruned(options.evidenceRoot, content.image.run)) {
      state.prepare("UPDATE chat_part SET state='dropped',problem='Removed by retention' WHERE id=?").run(row.id);
      return true;
    }
    if (content.image) {
      text = `${content.text}\n\nScreenshots open from the saved result.`;
      actions = openUrlAction(options.origin(), { label: "Open result", path: chatResultHref(content.image.taskId, content.image.run, "checks") });
    }
    if (content.proposal) {
      const proposal = store.getMateProposal(content.proposal);
      if (!proposal) text = "This proposal is unavailable.";
      else if (proposal.state !== "pending") text = proposalOutcomeText(proposal);
      else {
        const preview = proposalPreview(store, proposal, repos, "teams");
        text = content.phase === "armed" ? armedCardText(proposal, preview.text) : preview.text.replace("\n\nConfirm or Dismiss below. Nothing changes until you confirm.", "");
        if (preview.buttons && preview.text.length <= PLATFORM_LIMITS.teams) {
          actions = state.prepare("SELECT token,phase FROM chat_action WHERE part=? AND consumed IS NULL AND expires>? ORDER BY rowid").all(row.id, now.toISOString())
            .map(action => ({ type: "Action.Submit", title: action.phase === "yes" ? armedYesLabel(proposal) : action.phase === "cancel" ? "Cancel" : action.phase === "dismiss" ? "Dismiss" : "Confirm", data: { so: String(action.token) } }));
          if (!actions.length) text = "This confirmation expired. Ask for a fresh proposal.";
        } else {
          actions = openUrlAction(options.origin(), proposalLink(store, proposal, repos, "teams") ?? { label: "Review action", path: "/chat" });
          text = "Review the full action in Toolroll before confirming.";
        }
      }
    } else if (!content.image) {
      // A flow decision (v88): Approve / Edit / Send back, then the link.
      const flow = content.flow || content.choose || content.note ? chatFlowButtons(state, row.id, now).map(one => ({ type: "Action.Submit", title: one.label, data: { so: one.token }, ...(one.action === "approve" ? { style: "positive" } : {}) })) : [];
      // A teammate's question (v93): its options, then "Answer in words".
      const asked = content.question ? chatQuestionButtons(state, row.id, now).map(one => ({ type: "Action.Submit", title: one.label.slice(0, 80), data: { so: one.token } })) : [];
      // The lead's question to its owner: its options, then "Something else".
      const owner = content.ask ? chatAskButtons(state, row.id, now).map(one => ({ type: "Action.Submit", title: one.label.slice(0, 80), data: { so: one.token } })) : [];
      actions = [...flow, ...asked, ...owner, ...openUrlAction(options.origin(), content.link), ...(content.also ?? []).flatMap(one => openUrlAction(options.origin(), one))];
    }
    const target = content.edit ?? row.message;
    // The lead's own reply goes out in Teams' Markdown (bold anchors, labelled links); everything else stays plain.
    const voiced = content.voice === true && !content.proposal && !content.image ? renderReply(text, "teams") : null;
    const bodies = teamsMessages(voiced ?? text, voiced !== null, one => actions.length || content.proposal ? teamsCard(one, actions) : { type: "message", text: one, textFormat: voiced !== null ? "markdown" : "plain" });
    const activities = `/v3/conversations/${encodeURIComponent(destination)}/activities`;
    // An edit replaces its one message with the first part; any more follow it as new messages.
    let answer = await options.api(target ? "PUT" : "POST", serviceUrl, target ? `${activities}/${encodeURIComponent(target)}` : activities, bodies[0]!);
    for (const more of bodies.slice(1)) answer = await options.api("POST", serviceUrl, activities, more);
    const messageId = target ?? (typeof answer.id === "string" ? answer.id : null);
    if (messageId === null) throw new TeamsError("Teams did not confirm the message", 15_000, true);
    state.prepare("UPDATE chat_part SET state='sent',message=?,attempts=attempts+1,next_at=NULL,problem=NULL WHERE id=?").run(messageId, row.id);
    return true;
  } catch (error) {
    if (error instanceof ChatDeliveryError && error.permanent) {
      state.prepare("UPDATE chat_part SET state='dropped',next_at=NULL,problem=? WHERE id=?").run(error.message, row.id);
      return true;
    }
    const problem = error instanceof TeamsError ? error : new TeamsError("Teams delivery failed", 15_000, true);
    state.prepare("UPDATE chat_part SET attempts=attempts+1,uncertain=?,next_at=?,problem=?,state=CASE WHEN attempts>=20 THEN 'dropped' ELSE state END WHERE id=?")
      .run(problem.uncertain ? 1 : 0, new Date(now.getTime() + problem.retryMs).toISOString(), problem.message, row.id);
    return true;
  }
}
