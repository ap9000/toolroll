import { chatFlowButtons } from "./chat-flow.js";
import { refuseResultShots, resultShotsPruned, shotWaitsUntil } from "./result-shots.js";
import { chatQuestionButtons } from "./teammate-question.js";
import { chatAskButtons } from "./chat-ask.js";
import { channelInbox } from "./chat-inbox.js";
import { roomCommand } from "./chat-rooms.js";
import {
  processChatEvent,
  applyChatAction,
  planChatNotifications,
  channelAccess,
  type ChatDeliveryOptions,
  planRoomMessages,
} from "./chat-delivery.js";
/** Slack is a transport for the same saved assistant and confirmation doors. */
import {
  proposalPreview,
  proposalLink,
  proposalOutcomeText,
  armedCardText,
  armedYesLabel,
} from "./chat-channel.js";
import { MATE_MESSAGE_MAX_CHARS } from "./mate.js";
import { renderReply } from "./reply-shape.js";
import {
  SlackState,
  slackHash,
  type SlackIdentity,
  type SlackBinding,
  type SlackEvent,
  type SlackPart,
  type SlackContent,
} from "./slack-state.js";
import { ChatDeliveryError, partContent } from "./chat-delivery-state.js";
import { readChatPart, type ChatEventBody } from "./contracts/chat-content.js";
import { readSlackBlockActions, readSlackButton, SLACK_LINK_ACTION } from "./contracts/slack-callback.js";
import {
  object,
  slackId,
  slackTs,
  slackMember,
  SlackError,
  uploadSlackBytes,
  type SlackApi,
} from "./slack-api.js";
import {
  resultImageFileName,
  safeResultImageCaption,
  verifyResultImage,
} from "./chat-evidence.js";
import { type Store } from "./store.js";
import type { SubscriptionMateRunner } from "./subscription-chat.js";

export type SlackChatOptions = {
  store: Store;
  identity: SlackIdentity;
  api: SlackApi;
  owner: string;
  readProjects: () => Promise<readonly string[]>;
  evidenceRoot: string;
  current: () => boolean;
  origin: () => string | null;
  subscriptionRunner?: SubscriptionMateRunner;
  canNotify?: () => boolean;
  clock?: () => Date;
  upload?: typeof uploadSlackBytes;
};
const nowOf = (options: SlackChatOptions): Date =>
  options.clock?.() ?? new Date();
const split = (text: string, size = 2800): string[] => {
  const parts: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts.length ? parts : ["No reply was recorded."];
};

/** Synchronous receipt before ACK. Never stores response_url, raw tokens, or a pairing code. */
export function receiveSlack(
  state: SlackState,
  identity: SlackIdentity,
  type: string,
  raw: unknown,
  now: Date,
): boolean {
  const body = object(raw);
  if (body.api_app_id !== identity.app) return false;
  const team = type === "events_api" ? body.team_id : object(body.team).id;
  if (team !== identity.team || body.is_ext_shared_channel === true)
    return false;
  const event = type === "events_api" ? object(body.event) : body;
  if (
    type === "events_api" &&
    (event.type === "app_uninstalled" || event.type === "tokens_revoked")
  ) {
    state.revoke(identity.installation, now);
    return true;
  }
  if (type === "events_api" && event.type === "user_change") {
    const user = object(event.user),
      binding = typeof user.id === "string" ? state.bindingFor(identity.installation, user.id) : null;
    if (binding !== null && user.deleted === true)
      state.revokeBinding(binding, now);
    return true;
  }
  let member: unknown,
    channel: unknown,
    ts: unknown,
    thread: unknown,
    id: string,
    payload: ChatEventBody,
    kind: SlackEvent["kind"];
  if (type === "events_api" && event.type === "message") {
    if (
      event.subtype !== undefined ||
      event.bot_id !== undefined ||
      !["im", "channel", "group"].includes(String(event.channel_type)) ||
      typeof event.text !== "string"
    )
      return false;
    if (typeof body.event_id !== "string" || body.event_id.length > 120)
      return false;
    member = event.user;
    channel = event.channel;
    ts = event.ts;
    thread = event.thread_ts ?? event.ts;
    const match = /^pair ([a-f0-9]{32})$/.exec(event.text.trim());
    kind = match ? "pair" : "message";
    payload = match
      ? { hash: slackHash(match[1]!) }
      : {
          text: event.text.slice(0, MATE_MESSAGE_MAX_CHARS + 1),
          originalLength: event.text.length,
        };
    id = slackHash(`${identity.installation}:event:${body.event_id}`);
  } else if (type === "interactive" && body.type === "block_actions") {
    const interaction = readSlackBlockActions(body);
    if (!interaction.ok || interaction.value.container.type !== "message") return false;
    const { actions, container, user } = interaction.value;
    // A link button opens its page itself: nothing to do, and nothing to say.
    if (actions.length === 1 && SLACK_LINK_ACTION.test(actions[0]!.action_id ?? "")) return false;
    member = user.id;
    channel = container.channel_id;
    ts = container.message_ts;
    thread = interaction.value.message?.thread_ts ?? ts;
    kind = "action";
    // A button that isn't one Toolroll made is answered with why, once the tap is proved to be the paired person's below.
    const button = readSlackButton(interaction.value);
    payload = button.ok ? { token: button.value.value } : { problem: button.issues.map(issue => issue.line).join("; ") };
    const tapped = actions[0];
    id = slackHash(
      `${identity.installation}:action:${member}:${ts}:${tapped?.value ?? ""}:${tapped?.action_ts ?? ""}`,
    );
  } else return false;
  if (
    !slackId(member, "UW") ||
    !slackId(channel, "DCG") ||
    !slackTs(ts) ||
    !slackTs(thread) ||
    member === identity.bot
  )
    return false;
  // A channel or private group is a room: accepted only while it follows a
  // conversation, or for the `/team` words that make it follow one.
  const isRoom = !slackId(channel, "D");
  const words = "text" in payload ? payload.text ?? "" : "";
  // v89: a channel that feeds a flow takes anyone's message (as a card, with no say over anything); "flow 12" connects one.
  const inbox = isRoom && kind === "message" ? channelInbox(state.store, "slack", identity.installation, String(channel), words) : { watched: false, command: false };
  const roomish = isRoom && (state.room(identity.installation, String(channel)) !== null || (kind === "message" && roomCommand(words) !== null) || inbox.watched || inbox.command);
  if (isRoom && !roomish) return false;
  const binding = state.bindingFor(identity.installation, member);
  const open = inbox.watched && !inbox.command;
  if (
    kind !== "pair" && !open &&
    (!binding ||
      !state.live(binding) ||
      (binding.channel !== channel && !roomish))
  )
    return false;
  if (kind === "pair" && (binding || isRoom)) return false;
  return state.enqueue({
    id,
    installation: identity.installation,
    binding: kind === "pair" || binding === null ? null : binding.id,
    kind,
    channel,
    member,
    ts,
    thread,
    payload,
    created: now.toISOString(),
  });
}

const delivery = (options: SlackChatOptions): ChatDeliveryOptions => ({
  ...options,
  state: new SlackState(options.store),
  label: "Slack",
  member: (member, channel) =>
    slackMember(options.api, options.identity, member, channel),
  // A 👍 on the owner's message where the app has reactions:write; Slack shows bots no typing indicator.
  warm: (event) => ({
    react: () => options.api("reactions.add", { channel: event.channel, timestamp: event.ts, name: "thumbsup" }),
  }),
});
export const processSlackEvent = (options: SlackChatOptions) =>
  processChatEvent(delivery(options));
export const applySlackAction = (
  options: SlackChatOptions,
  event: SlackEvent,
  binding: SlackBinding,
  repos: readonly string[],
) => applyChatAction(delivery(options), event, binding, repos);
export const planSlackNotifications = (options: SlackChatOptions) =>
  planChatNotifications(delivery(options));
export const planSlackRooms = (options: SlackChatOptions) =>
  planRoomMessages(delivery(options));
const access = (
  options: SlackChatOptions,
  binding: SlackBinding,
  ceiling?: string,
) => channelAccess(delivery(options), binding, ceiling);
export function slackBlocks(
  text: string,
  buttons: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  const lines = text.split("\n"),
    title = lines[0] ?? "Toolroll";
  const blocks: Record<string, unknown>[] = [];
  if (title.length <= 150 && lines.length > 1) {
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: title, emoji: true },
    });
    text = lines.slice(1).join("\n").trim();
  }
  for (const part of split(text))
    blocks.push({
      type: "section",
      text: { type: "plain_text", text: part, emoji: true },
    });
  if (buttons.length) blocks.push({ type: "actions", elements: buttons });
  return blocks;
}
/** The lead's reply as mrkdwn sections: no header block, so its first line stays an ordinary line. */
export function slackVoiceBlocks(
  mrkdwn: string,
  buttons: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = split(mrkdwn).map((part) => ({
    type: "section",
    text: { type: "mrkdwn", text: part },
  }));
  if (buttons.length) blocks.push({ type: "actions", elements: buttons });
  return blocks;
}
function linkButton(
  origin: string | null,
  link: SlackContent["link"],
): Record<string, unknown>[] {
  if (
    !origin ||
    !link ||
    !link.path.startsWith("/") ||
    link.path.startsWith("//")
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
        type: "button",
        text: { type: "plain_text", text: link.label },
        url: `${url.origin}${link.path}`,
        action_id: "toolroll_link",
      },
    ];
  } catch {
    return [];
  }
}

export async function deliverSlackPart(
  options: SlackChatOptions,
): Promise<boolean> {
  const state = new SlackState(options.store),
    { store, identity } = options,
    now = nowOf(options);
  if (
    !state.owns(identity.installation, options.owner, now) ||
    !options.current()
  )
    return false;
  const row = state.db
    .prepare(
      "SELECT p.* FROM slack_part p JOIN slack_event e ON e.id=p.event WHERE e.installation=? AND p.state='pending' AND (e.kind!='notice' OR ?=1) AND (p.next_at IS NULL OR p.next_at<=?) ORDER BY p.id LIMIT 1",
    )
    .get(
      identity.installation,
      options.canNotify?.() === false ? 0 : 1,
      now.toISOString(),
    ) as SlackPart | undefined;
  if (!row) return false;
  const event = state.event(row.event)!,
    binding = event.binding === null ? null : state.bindingById(event.binding);
  if (!binding) {
    state.db
      .prepare(
        "UPDATE slack_part SET state='dropped',problem='Chat access changed' WHERE id=?",
      )
      .run(row.id);
    return true;
  }
  if (new Date(row.created).getTime() + 86_400_000 < now.getTime()) {
    state.db
      .prepare(
        "UPDATE slack_part SET state='dropped',problem='Delivery expired; open the saved chat to recover it' WHERE id=?",
      )
      .run(row.id);
    return true;
  }
  try {
    const session =
      event.session === null ? null : store.getMateSession(event.session);
    const repos = await access(options, binding, session?.ceilingDigest);
    if (event.kind === "notice" && options.canNotify?.() === false)
      return false;
    const content = partContent(row.payload);
    const destination = content.channel ?? binding.channel;
    let text = content.text,
      buttons: Record<string, unknown>[] = [];
    if (
      content.task &&
      !repos.includes(store.lookupRef(content.task)?.repo ?? "")
    )
      throw new SlackError("Connected projects changed");
    // A screenshot sent with a result goes in that result's thread once its message is placed, and waits until then.
    const result = content.shot?.follows == null ? undefined : state.db.prepare("SELECT message,state,next_at FROM slack_part WHERE id=?").get(content.shot.follows);
    if (result !== undefined && !slackTs(result["message"]) && result["state"] === "pending") {
      state.db.prepare("UPDATE slack_part SET next_at=? WHERE id=?").run(shotWaitsUntil(result["next_at"], now), row.id);
      return true;
    }
    const follows = result?.["message"];
    const thread = slackTs(follows) ? String(follows) : event.thread;
    if (content.image && content.shot && resultShotsPruned(options.evidenceRoot, content.image.run)) {
      state.db.prepare("UPDATE slack_part SET state='dropped',problem='Removed by retention' WHERE id=?").run(row.id);
      return true;
    }
    if (content.image) {
      const verified = verifyResultImage(
        store,
        options.evidenceRoot,
        repos,
        content.image,
      );
      if (!verified.ok) {
        text = `Screenshot not sent\n${verified.problem}. Open the saved result to review it.`;
      } else {
        let file = row.file;
        if (!row.uploaded) {
          const allocated = await options.api("files.getUploadURLExternal", {
            filename: resultImageFileName(
              content.image.taskId,
              content.image.run,
              content.image.artifact,
              verified.format,
            ),
            length: verified.bytes.length,
          });
          if (
            !slackId(allocated.file_id, "F") ||
            typeof allocated.upload_url !== "string"
          )
            throw new SlackError("Slack did not identify the upload");
          file = allocated.file_id;
          state.db
            .prepare("UPDATE slack_part SET file=? WHERE id=?")
            .run(file, row.id);
          await access(options, binding, session?.ceilingDigest);
          const fresh = verifyResultImage(
            store,
            options.evidenceRoot,
            repos,
            content.image,
          );
          if (!fresh.ok)
            throw new SlackError("Screenshot evidence changed before upload");
          await (options.upload ?? uploadSlackBytes)(
            allocated.upload_url,
            fresh.bytes,
          );
          state.db
            .prepare("UPDATE slack_part SET uploaded=1 WHERE id=?")
            .run(row.id);
        }
        await access(options, binding, session?.ceilingDigest);
        if (
          !verifyResultImage(store, options.evidenceRoot, repos, content.image)
            .ok
        )
          throw new SlackError("Screenshot evidence changed before sharing");
        // A lost completion response is reconciled against Slack's file receipt.
        if (row.uncertain && file) {
          const remote = object(
              (await options.api("files.info", { file })).file,
            ),
            shares = object(object(remote.shares).private);
          const receipts = Array.isArray(shares[destination])
            ? (shares[destination] as unknown[])
            : [];
          const found = receipts
            .map(object)
            .find(
              (receipt) =>
                (receipt.thread_ts ?? "") === thread && slackTs(receipt.ts),
            );
          if (found) {
            state.db
              .prepare(
                "UPDATE slack_part SET state='sent',message=?,problem=NULL WHERE id=?",
              )
              .run(String(found.ts), row.id);
            return true;
          }
        }
        const completed = await options.api("files.completeUploadExternal", {
          files: [
            {
              id: file,
              title: safeResultImageCaption(
                content.text,
                content.image.taskId,
                content.image.run,
              ),
            },
          ],
          channel_id: destination,
          thread_ts: thread === "" ? undefined : thread,
          initial_comment: safeResultImageCaption(
            content.text,
            content.image.taskId,
            content.image.run,
          ),
        });
        if (
          !Array.isArray(completed.files) ||
          !completed.files.some((value) => object(value).id === file)
        )
          throw new SlackError(
            "Slack did not confirm the file identity",
            15_000,
            true,
          );
        state.db
          .prepare("UPDATE slack_part SET state='sent',problem=NULL WHERE id=?")
          .run(row.id);
        return true;
      }
    }
    if (content.proposal) {
      const proposal = store.getMateProposal(content.proposal);
      if (!proposal) text = "This proposal is unavailable.";
      else if (proposal.state !== "pending")
        text = proposalOutcomeText(proposal);
      else {
        const preview = proposalPreview(store, proposal, repos, "slack");
        text =
          content.phase === "armed"
            ? armedCardText(proposal, preview.text)
            : preview.text.replace(
                "\n\nConfirm or Dismiss below. Nothing changes until you confirm.",
                "",
              );
        if (preview.buttons && preview.text.length <= 10_000) {
          const tokens = state.db
            .prepare(
              "SELECT token,phase FROM slack_action WHERE part=? AND consumed IS NULL AND expires>? ORDER BY rowid",
            )
            .all(row.id, now.toISOString());
          buttons = tokens.map((action) => ({
            type: "button",
            text: {
              type: "plain_text",
              text:
                action.phase === "yes"
                  ? armedYesLabel(proposal)
                  : action.phase === "cancel"
                    ? "Cancel"
                    : action.phase === "dismiss"
                      ? "Dismiss"
                      : "Confirm",
            },
            action_id: `toolroll_${action.phase}`,
            value: String(action.token),
            ...(action.phase === "confirm"
              ? { style: "primary" }
              : action.phase === "yes"
                ? { style: "danger" }
                : {}),
          }));
          if (!buttons.length)
            text = "This confirmation expired. Ask for a fresh proposal.";
        } else {
          const link = proposalLink(store, proposal, repos) ?? {
            label: "Review action",
            path: `/chat`,
          };
          buttons = linkButton(options.origin(), link);
          if (!buttons.length)
            text +=
              "\n\nOpen Toolroll on your computer to review this action.";
          if (text.length > 10_000)
            text =
              "Review the full action in Toolroll before confirming.";
        }
      }
    } else
      buttons = [
        // A flow decision (v88): Approve / Edit / Send back, then the link.
        ...(content.flow || content.choose || content.note
          ? chatFlowButtons(state, row.id, now).map((one) => ({
              type: "button",
              text: { type: "plain_text", text: one.label },
              action_id: `toolroll_flow_${one.key}`,
              value: one.token,
              ...(one.action === "approve" ? { style: "primary" } : {}),
            }))
          : []),
        // A teammate's question (v93): its options, then "Answer in words".
        ...(content.question
          ? chatQuestionButtons(state, row.id, now).map((one) => ({
              type: "button",
              text: { type: "plain_text", text: one.label },
              action_id: one.words ? "toolroll_question_words" : "toolroll_question_choice",
              value: one.token,
            }))
          : []),
        // The lead's question to its owner: its options, then "Something else".
        ...(content.ask
          ? chatAskButtons(state, row.id, now).map((one) => ({
              type: "button",
              text: { type: "plain_text", text: one.label },
              action_id: one.words ? "toolroll_question_words" : "toolroll_question_choice",
              value: one.token,
            }))
          : []),
        ...linkButton(options.origin(), content.link),
        // [Look first] beside [Merge] or [Accept and finish]: each button's own action id.
        ...(content.also ?? []).flatMap((one, index) => linkButton(options.origin(), one).map(button => ({ ...button, action_id: `toolroll_link_${index + 2}` }))),
      ];
    const target = content.edit ?? row.message;
    // The lead's own reply goes out in Slack's mrkdwn (bold anchors, labelled links); everything else stays plain.
    const voiced = content.voice === true && !content.proposal && !content.image ? renderReply(text, "slack") : null;
    const args = {
      channel: destination,
      text: voiced ?? text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
      blocks: voiced === null ? slackBlocks(text, buttons) : slackVoiceBlocks(voiced, buttons),
      mrkdwn: voiced !== null,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    };
    const answer = target
      ? await options.api("chat.update", { ...args, ts: target })
      : await options.api("chat.postMessage", {
          ...args,
          thread_ts:
            event.kind === "notice" && thread === ""
              ? undefined
              : thread,
        });
    if (!slackTs(answer.ts) || (target && answer.ts !== target))
      throw new SlackError(
        "Slack did not confirm the message identity",
        15_000,
        true,
      );
    state.db
      .prepare(
        "UPDATE slack_part SET state='sent',message=?,attempts=attempts+1,problem=NULL,next_at=NULL WHERE id=?",
      )
      .run(answer.ts, row.id);
    state.db
      .prepare(
        "UPDATE slack_runtime SET problem=NULL WHERE installation=? AND owner=?",
      )
      .run(identity.installation, options.owner);
    return true;
  } catch (error) {
    if (error instanceof ChatDeliveryError && error.permanent) {
      state.prepare("UPDATE chat_part SET state='dropped',next_at=NULL,problem=? WHERE id=?").run(error.message, row.id);
      return true;
    }
    // No permission to upload files here: one plain line instead of the result's screenshots.
    const saved = readChatPart(row.payload), content = saved.ok ? saved.value : null;
    if (content !== null && content.image && content.shot && error instanceof SlackError && ["missing_scope", "no_permission"].includes(error.code)) {
      refuseResultShots(state, store, row, content, "Slack", nowOf(options));
      return true;
    }
    const problem =
      error instanceof SlackError
        ? error
        : new SlackError("Slack delivery is waiting to retry", 15_000, true);
    state.db
      .prepare(
        "UPDATE slack_runtime SET problem=? WHERE installation=? AND owner=?",
      )
      .run(problem.message, identity.installation, options.owner);
    const until = new Date(
      nowOf(options).getTime() +
        Math.max(
          problem.retryMs,
          [5000, 15000, 60000, 300000][Math.min(row.attempts, 3)]!,
        ),
    ).toISOString();
    state.db
      .prepare(
        "UPDATE slack_part SET attempts=attempts+1,uncertain=uncertain+?,next_at=?,problem=? WHERE id=?",
      )
      .run(problem.uncertain ? 1 : 0, until, problem.message, row.id);
    if (problem.code === "ratelimited")
      state.db
        .prepare("UPDATE slack_runtime SET retry_at=? WHERE installation=?")
        .run(until, identity.installation);
    return true;
  }
}
