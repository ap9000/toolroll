/** Discord messages and buttons transport the shared assistant's saved actions. */
import { chatQuestionButtons } from "./teammate-question.js";
import { chatAskButtons } from "./chat-ask.js";
import { chatFlowButtons } from "./chat-flow.js";
import { refuseResultShots, resultShotsPruned } from "./result-shots.js";
import { channelInbox } from "./chat-inbox.js";
import { roomCommand } from "./chat-rooms.js";
import {
  ChatState,
  ChatDeliveryError,
  chatHash,
  type ChatIdentity,
  type ChatContent,
  type ChatPart,
} from "./chat-delivery-state.js";
import {
  processChatEvent,
  planChatNotifications,
  channelAccess,
  chatObject as object,
  type ChatDeliveryOptions,
  planRoomMessages,
} from "./chat-delivery.js";
import { chatResultHref } from "./chat-controls.js";
import { MATE_MESSAGE_MAX_CHARS } from "./mate.js";
import { discordPlain, renderReply } from "./reply-shape.js";
import { WARM_EMOJI } from "./chat-warmth.js";
import {
  proposalPreview,
  proposalLink,
  proposalOutcomeText,
  armedCardText,
  armedYesLabel,
} from "./chat-channel.js";
import {
  resultImageFileName,
  safeResultImageCaption,
  verifyResultImage,
} from "./chat-evidence.js";
import {
  discordId,
  discordMember,
  DiscordError,
  DISCORD_REFUSED,
  type DiscordApi,
} from "./discord-api.js";
export type DiscordChatOptions = Omit<
  ChatDeliveryOptions,
  "state" | "label" | "member" | "partSize" | "maxProposal"
> & { api: DiscordApi };
export const discordDelivery = (
  options: DiscordChatOptions,
): ChatDeliveryOptions => ({
  ...options,
  state: new ChatState(options.store, "discord"),
  label: "Discord",
  member: (member, channel) => discordMember(options.api, member, channel),
  // A 👍 on the owner's message and "typing…" while the lead works; a missing permission is skipped silently.
  warm: (event) => ({
    react: () => options.api("PUT", `/channels/${event.channel}/messages/${event.ts}/reactions/${encodeURIComponent(WARM_EMOJI)}/@me`),
    typing: () => options.api("POST", `/channels/${event.channel}/typing`),
  }),
  partSize: 1800,
  maxProposal: 3400,
});
export const processDiscordEvent = (options: DiscordChatOptions) =>
  processChatEvent(discordDelivery(options));
export const planDiscordRooms = (options: DiscordChatOptions) =>
  planRoomMessages(discordDelivery(options));
export const planDiscordNotifications = (options: DiscordChatOptions) =>
  planChatNotifications(discordDelivery(options));
/** Save only normalized input. Interaction credentials and pairing codes never enter SQLite. */
export function receiveDiscord(
  state: ChatState,
  identity: ChatIdentity,
  type: string,
  raw: unknown,
  now: Date,
): boolean {
  const body = object(raw);
  if (body.webhook_id !== undefined) return false;
  // A guild channel is a room: accepted only while it follows a conversation,
  // or for the `/team` words that make it follow one.
  const isRoom = body.guild_id !== undefined;
  let member: unknown,
    channel: unknown,
    id: unknown,
    ts: unknown,
    thread: unknown,
    kind: "message" | "pair" | "action",
    payload: Record<string, unknown>;
  if (type === "MESSAGE_CREATE") {
    const author = object(body.author),
      ref = object(body.message_reference);
    if (
      author.bot === true ||
      author.system === true ||
      ![0, 19].includes(Number(body.type)) ||
      typeof body.content !== "string" ||
      (!isRoom && ref.guild_id !== undefined)
    )
      return false;
    member = author.id;
    channel = body.channel_id;
    id = body.id;
    ts = body.id;
    thread = ref.message_id ?? body.id;
    if (ref.channel_id !== undefined && ref.channel_id !== channel)
      return false;
    const pair = /^pair ([a-f0-9]{32})$/.exec(body.content.trim());
    kind = pair ? "pair" : "message";
    payload = pair
      ? { hash: chatHash(pair[1]!) }
      : {
          text: body.content.slice(0, MATE_MESSAGE_MAX_CHARS + 1),
          originalLength: body.content.length,
          ...(Array.isArray(body.attachments) && body.attachments.length
            ? {
                unsupported:
                  "Incoming files are not supported yet. Describe the request in a message; saved result screenshots can still be sent here.",
              }
            : {}),
        };
  } else if (type === "INTERACTION_CREATE") {
    const data = object(body.data),
      message = object(body.message);
    if (
      body.type !== 3 ||
      body.application_id !== identity.app ||
      (isRoom ? object(body.channel).type !== 0 : object(body.channel).type !== 1) ||
      object(message.author).id !== identity.bot ||
      message.channel_id !== body.channel_id ||
      !/^so_[a-f0-9]{32}$/.test(String(data.custom_id))
    )
      return false;
    member = isRoom ? object(object(body.member).user).id : object(body.user).id;
    channel = body.channel_id;
    id = body.id;
    ts = message.id;
    thread = message.id;
    kind = "action";
    payload = { token: String(data.custom_id).slice(3) };
  } else return false;
  if (
    !discordId(member) ||
    !discordId(channel) ||
    !discordId(id) ||
    !discordId(ts) ||
    !discordId(thread) ||
    member === identity.bot
  )
    return false;
  // v89: a channel that feeds a flow takes anyone's message (as a card, with no say over anything); "flow 12" connects one.
  const inbox = isRoom && kind === "message" ? channelInbox(state.store, "discord", identity.installation, String(channel), String(payload.text ?? "")) : { watched: false, command: false };
  const roomish = isRoom && (state.room(identity.installation, String(channel)) !== null || (kind === "message" && roomCommand(String(payload.text ?? "")) !== null) || inbox.watched || inbox.command);
  if (isRoom && !roomish) return false;
  const binding = state.bindingFor(identity.installation, member);
  const open = inbox.watched && !inbox.command;
  if (
    kind === "pair"
      ? !!binding || isRoom
      : !open && (!binding ||
        !state.live(binding) ||
        (binding.channel !== channel && !roomish))
  )
    return false;
  return state.enqueue({
    id: chatHash(
      `${identity.installation}:${kind === "action" ? "interaction" : "message"}:${id}`,
    ),
    installation: identity.installation,
    binding: kind === "pair" || binding === null ? null : binding.id,
    kind,
    channel,
    member,
    ts,
    thread,
    payload: JSON.stringify(payload),
    created: now.toISOString(),
  });
}
function link(
  origin: string | null,
  target: ChatContent["link"],
): Record<string, unknown>[] {
  if (
    !origin ||
    !target ||
    !target.path.startsWith("/") ||
    target.path.startsWith("//")
  )
    return [];
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return [];
    return [
      {
        type: 2,
        style: 5,
        label: target.label.slice(0, 80),
        url: url.origin + target.path,
      },
    ];
  } catch {
    return [];
  }
}
/** Escape Discord's presentation syntax; allowed_mentions also prevents actual pings. */
export { discordPlain };
export function discordCard(
  text: string,
  buttons: Record<string, unknown>[] = [],
  voice = false,
): Record<string, unknown> {
  // The lead's own reply: one description in Discord's Markdown (bold anchors, labelled links), no title line promoted to a header.
  if (voice)
    return {
      content: "",
      embeds: [{ description: renderReply(text, "discord").slice(0, 4096), color: 0x297b70 }],
      components: Array.from({ length: Math.min(5, Math.ceil(buttons.length / 5)) }, (_, row) => ({ type: 1, components: buttons.slice(row * 5, row * 5 + 5) })),
      allowed_mentions: { parse: [], replied_user: false },
    };
  const lines = text.split("\n"),
    first = lines[0] ?? "Toolroll",
    title =
      discordPlain(first).length <= 256 &&
      first.length <= 150 &&
      lines.length > 1
        ? first
        : "Toolroll",
    detail = title === first ? lines.slice(1).join("\n").trim() : text;
  // Long answers were split before this point; approval controls only appear when full terms fit.
  return {
    content: "",
    embeds: [
      {
        title: discordPlain(title),
        description: discordPlain(detail || title).slice(0, 4096),
        color: 0x297b70,
      },
    ],
    // A row holds at most 5 buttons (a question's 4 options and "Answer in words", then the link, need two).
    components: Array.from({ length: Math.min(5, Math.ceil(buttons.length / 5)) }, (_, row) => ({ type: 1, components: buttons.slice(row * 5, row * 5 + 5) })),
    allowed_mentions: { parse: [], replied_user: false },
  };
}
export async function deliverDiscordPart(
  options: DiscordChatOptions,
): Promise<boolean> {
  const shared = discordDelivery(options),
    state = shared.state,
    { store, identity } = options,
    now = options.clock?.() ?? new Date();
  if (
    !options.current() ||
    !state.owns(identity.installation, options.owner, now)
  )
    return false;
  const row = state
    .prepare(
      "SELECT p.* FROM chat_part p JOIN chat_event e ON e.id=p.event WHERE e.installation=? AND p.state='pending' AND (e.kind!='notice' OR ?=1) AND (p.next_at IS NULL OR p.next_at<=?) ORDER BY p.id LIMIT 1",
    )
    .get(
      identity.installation,
      options.canNotify?.() === false ? 0 : 1,
      now.toISOString(),
    ) as ChatPart | undefined;
  if (!row) return false;
  const event = state.event(row.event)!,
    binding = event.binding === null ? null : state.bindingById(event.binding);
  if (
    !binding ||
    new Date(row.created).getTime() + 86_400_000 < now.getTime()
  ) {
    state
      .prepare(
        "UPDATE chat_part SET state='dropped',problem='Delivery expired or access changed; open the saved chat' WHERE id=?",
      )
      .run(row.id);
    return true;
  }
  try {
    const session =
        event.session === null ? null : store.getMateSession(event.session),
      repos = await channelAccess(shared, binding, session?.ceilingDigest);
    if (event.kind === "notice" && options.canNotify?.() === false)
      return false;
    const content = JSON.parse(row.payload) as ChatContent;
    const destination = content.channel ?? binding.channel;
    if (
      content.task &&
      !repos.includes(store.lookupRef(content.task)?.repo ?? "")
    )
      throw new DiscordError("Connected projects changed");
    let text = content.text,
      buttons: Record<string, unknown>[] = [],
      file: { bytes: Uint8Array; name: string } | undefined;
    if (content.image && content.shot && resultShotsPruned(options.evidenceRoot, content.image.run)) {
      state.prepare("UPDATE chat_part SET state='dropped',problem='Removed by retention' WHERE id=?").run(row.id);
      return true;
    }
    // A screenshot sent with a result replies to that result's message once it is placed.
    const follows = content.shot?.follows == null ? undefined : state.prepare("SELECT message FROM chat_part WHERE id=? AND state='sent'").get(content.shot.follows)?.message;
    const thread = discordId(follows) ? String(follows) : event.thread;
    if (content.image) {
      const image = verifyResultImage(
        store,
        options.evidenceRoot,
        repos,
        content.image,
      );
      if (!image.ok)
        text = `Screenshot not sent\n${image.problem}. Open the saved result to review it.`;
      else if (image.bytes.length > 10 * 1024 * 1024)
        text =
          "Screenshot exceeds Discord’s upload limit. Open the saved result to review it.";
      else {
        file = {
          bytes: image.bytes,
          name: resultImageFileName(
            content.image.taskId,
            content.image.run,
            content.image.artifact,
            image.format,
          ),
        };
        text = safeResultImageCaption(
          content.text,
          content.image.taskId,
          content.image.run,
        );
      }
      buttons = link(options.origin(), {
        label: "Open result",
        path: chatResultHref(content.image.taskId, content.image.run, "checks"),
      });
    }
    if (content.proposal) {
      const proposal = store.getMateProposal(content.proposal);
      if (!proposal) text = "This proposal is unavailable.";
      else if (proposal.state !== "pending")
        text = proposalOutcomeText(proposal);
      else {
        const preview = proposalPreview(store, proposal, repos, "discord");
        text =
          content.phase === "armed"
            ? armedCardText(proposal, preview.text)
            : preview.text.replace(
                "\n\nConfirm or Dismiss below. Nothing changes until you confirm.",
                "",
              );
        if (
          preview.buttons &&
          preview.text.length <= 3400 &&
          discordPlain(text).length <= 3900
        ) {
          buttons = state
            .prepare(
              "SELECT token,phase FROM chat_action WHERE part=? AND consumed IS NULL AND expires>? ORDER BY rowid",
            )
            .all(row.id, now.toISOString())
            .map((action) => ({
              type: 2,
              style:
                action.phase === "yes" ? 4 : action.phase === "confirm" ? 1 : 2,
              label:
                action.phase === "yes"
                  ? armedYesLabel(proposal)
                  : action.phase === "cancel"
                    ? "Cancel"
                    : action.phase === "dismiss"
                      ? "Dismiss"
                      : "Confirm",
              custom_id: `so_${action.token}`,
            }));
          if (!buttons.length)
            text = "This confirmation expired. Ask for a fresh proposal.";
        } else {
          buttons = link(
            options.origin(),
            proposalLink(store, proposal, repos) ?? {
              label: "Review action",
              path: "/chat",
            },
          );
          text = "Review the full action in Toolroll before confirming.";
          if (!buttons.length)
            text += " Open Toolroll on your computer.";
        }
      }
    } else if (!content.image)
      buttons = [
        // A flow decision (v88): Approve / Edit / Send back, then the link.
        ...(content.flow
          ? chatFlowButtons(state, row.id, now).map((one) => ({
              type: 2,
              style: one.action === "approve" ? 3 : 2,
              label: one.label,
              custom_id: `so_${one.token}`,
            }))
          : []),
        // A teammate's question (v93): its options, then "Answer in words".
        ...(content.question
          ? chatQuestionButtons(state, row.id, now).map((one) => ({
              type: 2,
              style: one.words ? 1 : 2,
              label: one.label.slice(0, 80),
              custom_id: `so_${one.token}`,
            }))
          : []),
        // The lead's question to its owner: its options, then "Something else".
        ...(content.ask
          ? chatAskButtons(state, row.id, now).map((one) => ({
              type: 2,
              style: one.words ? 2 : 1,
              label: one.label.slice(0, 80),
              custom_id: `so_${one.token}`,
            }))
          : []),
        ...link(options.origin(), content.link),
        ...(content.also ?? []).flatMap(one => link(options.origin(), one)),
      ];
    let target = content.edit ?? row.message;
    if (target && content.image && row.uploaded) {
      if (!file)
        text =
          "Screenshot delivered earlier. The saved evidence has since changed; open the result to review its current state.";
      file = undefined;
    }
    const nonce = chatHash(`discord:part:${row.id}:${event.id}`).slice(0, 24);
    // Recent Discord nonce receipts reconcile uncertain sends, including attachments.
    if (row.uncertain && !target) {
      const recent = await options.api(
        "GET",
        `/channels/${destination}/messages?limit=100`,
      );
      const found = (Array.isArray(recent.items) ? recent.items : [])
        .map(object)
        .find(
          (m) =>
            m.nonce === nonce &&
            object(m.author).id === identity.bot &&
            m.channel_id === destination &&
            discordId(m.id),
        );
      if (found) {
        // Record the recovered placement, then repaint current terms/progress.
        // A notification or proposal may have changed while delivery was uncertain.
        target = String(found.id);
        if (content.image) {
          const attachments = Array.isArray(found.attachments)
            ? found.attachments.map(object)
            : [];
          if (
            file &&
            !attachments.some(
              (a) =>
                a.filename === file!.name &&
                Number(a.size) === file!.bytes.length,
            )
          )
            throw new DiscordError(
              "Discord’s earlier file receipt does not match the saved evidence",
              60_000,
            );
          if (!file && attachments.length)
            text =
              "Screenshot delivered earlier. The saved evidence has since changed; open the result to review its current state.";
          // Preserve the original remote attachment; never upload it again on an edit.
          file = undefined;
        }
        state
          .prepare("UPDATE chat_part SET message=?,uploaded=? WHERE id=?")
          .run(
            target,
            content.image &&
              Array.isArray(found.attachments) &&
              found.attachments.length
              ? 1
              : 0,
            row.id,
          );
      }
    }
    await channelAccess(shared, binding, session?.ceilingDigest);
    if (file && content.image) {
      const fresh = verifyResultImage(
        store,
        options.evidenceRoot,
        repos,
        content.image,
      );
      if (!fresh.ok)
        throw new DiscordError("Screenshot evidence changed before upload");
      file.bytes = fresh.bytes;
    }
    const args = discordCard(text, buttons, content.voice === true && !content.proposal && !content.image);
    if (file)
      args.attachments = [
        { id: 0, filename: file.name, description: text.slice(0, 1024) },
      ];
    if (!target) {
      args.nonce = nonce;
      args.enforce_nonce = true;
      if (discordId(thread))
        args.message_reference = {
          message_id: thread,
          channel_id: destination,
          fail_if_not_exists: false,
        };
    }
    const answer = await options.api(
      target ? "PATCH" : "POST",
      `/channels/${destination}/messages${target ? `/${target}` : ""}`,
      args,
      file,
    );
    if (
      !discordId(answer.id) ||
      answer.channel_id !== destination ||
      (target && answer.id !== target) ||
      object(answer.author).id !== identity.bot ||
      (file &&
        (!Array.isArray(answer.attachments) ||
          !answer.attachments.some(
            (v) =>
              object(v).filename === file!.name &&
              Number(object(v).size) === file!.bytes.length,
          )))
    )
      throw new DiscordError(
        "Discord did not confirm the message and file identity",
        15_000,
        true,
      );
    state
      .prepare(
        "UPDATE chat_part SET state='sent',message=?,attempts=attempts+1,problem=NULL,next_at=NULL WHERE id=?",
      )
      .run(answer.id, row.id);
    state
      .prepare(
        "UPDATE chat_runtime SET problem=NULL WHERE installation=? AND owner=?",
      )
      .run(identity.installation, options.owner);
    return true;
  } catch (error) {
    // No permission to attach files here: one plain line instead of the result's screenshots.
    const content = JSON.parse(row.payload) as ChatContent;
    if (content.image && content.shot && error instanceof DiscordError && error.code === DISCORD_REFUSED) {
      refuseResultShots(state, store, row, content, "Discord", options.clock?.() ?? new Date());
      return true;
    }
    const problem =
      error instanceof ChatDeliveryError
        ? error
        : new DiscordError(
            "Discord delivery is waiting to retry",
            15_000,
            true,
          );
    const until = new Date(
      (options.clock?.() ?? new Date()).getTime() +
        Math.max(
          problem.retryMs,
          [5000, 15000, 60000, 300000][Math.min(row.attempts, 3)]!,
        ),
    ).toISOString();
    state
      .prepare(
        "UPDATE chat_part SET attempts=attempts+1,uncertain=uncertain+?,next_at=?,problem=? WHERE id=?",
      )
      .run(problem.uncertain ? 1 : 0, until, problem.message, row.id);
    state
      .prepare(
        "UPDATE chat_runtime SET problem=? WHERE installation=? AND owner=?",
      )
      .run(
        problem.code === "ratelimited"
          ? "Discord asked us to wait. Saved replies will retry."
          : problem.message,
        identity.installation,
        options.owner,
      );
    if (problem.code === "ratelimited")
      state
        .prepare("UPDATE chat_runtime SET retry_at=? WHERE installation=?")
        .run(until, identity.installation);
    return true;
  }
}
