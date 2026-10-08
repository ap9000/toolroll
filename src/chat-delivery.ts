/** Shared saved replies, explicit confirmations and progress for private chat transports. */
import { answerChatQuestionPrompt, applyChatQuestionTap, questionParts } from "./teammate-question.js";
import { applyChatAskTap, chatAskText } from "./chat-ask.js";
import {
  channelRepos,
  resolveChannelMate,
  proposalPreview,
  proposalOutcomeText,
  confirmedLink,
  confirmedCardText,
  replyContextFor,
  mirrorToTaskChat,
  focusContextFor,
  taskInCeiling,
  tooLongText,
} from "./chat-channel.js";
import { MATE_MESSAGE_MAX_CHARS, mateFailureText, runMateTurn, type MateChannelProblem } from "./mate.js";
import { shapeReplyParts } from "./reply-shape.js";
import { warmTurn, type WarmHooks } from "./chat-warmth.js";
import {
  confirmMateProposal,
  dismissMateProposal,
} from "./mate-doors.js";
import { ceilingDigestOf, verifyApproverStanding } from "./principal.js";
import {
  ChatState,
  ChatDeliveryError,
  chatHash,
  savedChatPart,
  type ChatBinding,
  type ChatContent,
  type ChatEvent,
  type ChatIdentity,
} from "./chat-delivery-state.js";
import { readChatActionBody, readChatMessageBody, readChatPairBody, readChatPart } from "./contracts/chat-content.js";
import { readProposalActionRow } from "./contracts/chat-callback-rows.js";
import { answerChatFlowPrompt, answerChoiceMessage, applyChatFlowTap, flowDecisionParts, flowSendParts } from "./chat-flow.js";
import { connectChannel, FLOW_WORDS, takeChannelMessage, watchedChannel } from "./chat-inbox.js";
import { triggerConfigOf } from "./flow-triggers.js";
import { telegramProgressCard } from "./telegram-progress.js";
import { enqueueEveningDigests, finishedView, isTaskFact, joinsBatch, needsPerson, quietCardView } from "./chat-quiet.js";
import { BATCH_MS, chatText, chatTitle } from "./chat-voice.js";
import { LEAD_SAY_KIND, enqueueLeadLapses, leadSayEarlier, leadSayText, leadSubjectOf } from "./lead-voice.js";
import { leadChannelOf } from "./lead-context.js";
import { promiseChannelOf } from "./lead-commitments.js";
import { phoneText, PHONE_HELP, phoneCommand, phoneStatus, phoneTaskView, phoneTaskChoices, phoneTaskListText, resolvePhoneTask, phoneFocusText, PHONE_NO_MATCH, PHONE_BACK_TO_LEAD } from "./telegram-status.js";
import { applyRoomInbound, conversationRow, roomCardApprover, roomCommand, roomGrantAllowed, roomMessagesAfter, roomMessageText, teamDomain } from "./chat-rooms.js";
import { isTelegramProgressNotification, proposalTaskOf, type Notification, type Store } from "./store.js";
import { isShotsKind, resultShotsFor } from "./result-shots.js";
import { messageTeammate } from "./teammate-desk.js";
import { CHAT_APP_NAMES } from "./flow-triggers.js";
import type { SubscriptionMateRunner } from "./subscription-chat.js";
export const chatObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const object = chatObject;
export type ChatDeliveryOptions = {
  store: Store;
  state: ChatState;
  label: string;
  identity: ChatIdentity;
  owner: string;
  member: (member: string, channel: string) => Promise<boolean>;
  readProjects: () => Promise<readonly string[]>;
  evidenceRoot: string;
  current: () => boolean;
  origin: () => string | null;
  subscriptionRunner?: SubscriptionMateRunner;
  canNotify?: () => boolean;
  clock?: () => Date;
  partSize?: number;
  maxProposal?: number;
  /** The app's warm touches for one owner message (a 👍, typing), where the app and the bot's permissions allow them. */
  warm?: (event: ChatEvent, binding: ChatBinding) => WarmHooks;
};
const nowOf = (options: ChatDeliveryOptions) => options.clock?.() ?? new Date();
const CHAT_PART_SIZE = 2800;
export const splitChatText = (text: string, size = CHAT_PART_SIZE): string[] => {
  const parts: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts.length ? parts : ["No reply was recorded."];
};

export async function channelAccess(
  options: ChatDeliveryOptions,
  binding: ChatBinding,
  ceiling?: string,
): Promise<string[]> {
  const state = options.state;
  if (
    !options.current() ||
    !state.owns(options.identity.installation, options.owner, nowOf(options)) ||
    !state.live(binding)
  )
    throw new ChatDeliveryError("Chat access changed");
  const repos = channelRepos(
    options.store,
    binding.approver,
    await options.readProjects(),
  );
  if (ceiling !== undefined && ceilingDigestOf(repos) !== ceiling)
    throw new ChatDeliveryError("Connected projects changed");
  if (!(await options.member(binding.member, binding.channel))) {
    state.revoke(options.identity.installation, nowOf(options));
    throw new ChatDeliveryError(`${options.label} account access changed`);
  }
  // The network wait above can outlive a local disconnect or lease.
  if (
    !options.current() ||
    !state.live(binding) ||
    !state.owns(options.identity.installation, options.owner, nowOf(options))
  )
    throw new ChatDeliveryError("Chat access changed");
  const latest = channelRepos(
    options.store,
    binding.approver,
    await options.readProjects(),
  );
  if (ceilingDigestOf(latest) !== ceilingDigestOf(repos))
    throw new ChatDeliveryError("Connected projects changed");
  if (
    !state.live(binding) ||
    !options.current() ||
    !state.owns(options.identity.installation, options.owner, nowOf(options))
  )
    throw new ChatDeliveryError("Chat access changed");
  return latest;
}

export async function processChatEvent(
  options: ChatDeliveryOptions,
): Promise<boolean> {
  const { store, identity } = options,
    state = options.state,
    now = nowOf(options);
  if (
    !state.owns(identity.installation, options.owner, now) ||
    !options.current()
  )
    return false;
  const event = state.next(identity.installation, now);
  if (!event) return false;
  try {
    if (event.kind === "pair") {
      if (!(await options.member(event.member, event.channel))) {
        state.finish(event.id, true);
        return true;
      }
      if (
        !state.owns(identity.installation, options.owner, nowOf(options)) ||
        !options.current()
      )
        return false;
      const body = readChatPairBody(event.payload);
      const paired = body.ok
        ? state.pair(identity, body.value.hash, event.member, event.channel, nowOf(options))
        : null;
      if (!paired) {
        state.finish(event.id, true);
        return true;
      }
      state
        .prepare("UPDATE chat_event SET binding=? WHERE id=?")
        .run(paired.id, event.id);
      state.plan(
        event.id,
        [
          {
            text: "Connected to Toolroll. Ask about a project, review a result, or describe what you want done. I’ll show any proposed change before you confirm it.",
          },
        ],
        nowOf(options),
      );
      return true;
    }
    // A channel as a flow's inbox (v89): "flow 12" connects it, and after that its messages are cards.
    if (event.kind === "message" && await channelInboxEvent(options, event)) return true;
    const binding = event.binding === null ? null : state.bindingById(event.binding);
    if (!binding) {
      state.finish(event.id, true);
      return true;
    }
    const repos = await channelAccess(options, binding);
    if (event.kind === "action") {
      applyChatAction(options, event, binding, repos);
      return true;
    }
    const body = readChatMessageBody(event.payload);
    if (!body.ok) {
      state.plan(event.id, [{ text: `That message couldn't be read (${body.issues.map(issue => issue.line).join("; ")}). Send it again.` }], nowOf(options));
      return true;
    }
    const input = body.value;
    if (typeof input.unsupported === "string") {
      state.plan(event.id, [{ text: input.unsupported }], nowOf(options));
      return true;
    }
    const text = String(input.text ?? "");
    // A teammate's question asked for this person's next message (v93): it is the answer.
    if (answerChatQuestionPrompt({ store, state, label: options.label }, event, binding,
      { text, ...(typeof input.originalLength === "number" ? { originalLength: input.originalLength } : {}) }, nowOf(options))) return true;
    // A flow decision asked for this person's next message (Edit, Send back): it is the draft or the note.
    if (answerChatFlowPrompt({ store, state, label: options.label }, event, binding,
      { text, ...(typeof input.originalLength === "number" ? { originalLength: input.originalLength } : {}) }, repos, nowOf(options))) return true;
    // A "Person chooses" notice's thread reply is the note; the first other message after it is asked about (chat-flow.ts).
    if (answerChoiceMessage({ store, state, label: options.label }, event, binding,
      { text, ...(typeof input.originalLength === "number" ? { originalLength: input.originalLength } : {}), lead: input.lead === true }, nowOf(options), repos)) return true;
    // A message to a teammate by name (v96), in someone's own chat with Toolroll: a card on its desk.
    if (event.channel === binding.channel) {
      const handed = messageTeammate(store, { who: binding.approver, repos, via: CHAT_APP_NAMES[state.channel] ?? "Chat" }, text, nowOf(options));
      if (handed !== null) {
        state.plan(event.id, [{ text: handed.said, ...(handed.link === undefined ? {} : { link: handed.link }) }], nowOf(options));
        return true;
      }
    }
    // The task this message's turn is about, once chosen (kept on the event,
    // so a reply planned after a restart names the same task).
    let about: { task: string; run: number | null } | null =
      typeof object(input.about).task === "string" ? { task: String(object(input.about).task), run: typeof object(input.about).run === "number" ? Number(object(input.about).run) : null } : null;
    // Read-only commands answer from the database, never from a model.
    const command = phoneCommand(text);
    if (command !== null) {
      const now_ = nowOf(options);
      // The task this chat chose to talk about (/tasks, /task <name>), if any.
      const surface = options.label.toLowerCase();
      const focusedId = store.chatFocus(surface, binding.id);
      const focusedTitle = focusedId === null ? null : phoneText(store.getTask(focusedId)?.title ?? focusedId, 64);
      if (command.kind === "help") state.plan(event.id, [{ text: PHONE_HELP }], now_);
      else if (command.kind === "status") state.plan(event.id, [{ text: phoneStatus(store, repos, now_, focusedTitle) }], now_);
      else if (command.kind === "tasks") state.plan(event.id, [{ text: phoneTaskListText(phoneTaskChoices(store, repos, now_), focusedTitle) }], now_);
      else if (command.kind === "lead") {
        store.setChatFocus(surface, binding.id, null, now_);
        state.plan(event.id, [{ text: PHONE_BACK_TO_LEAD }], now_);
      } else {
        const pick = resolvePhoneTask(store, repos, now_, command.id);
        if (pick.kind === "one") {
          store.setChatFocus(surface, binding.id, pick.id, now_);
          const view = phoneTaskView(store, repos, pick.view, now_);
          // The status names its task (and result): a reply to it is about that task.
          state.plan(event.id, [{ text: phoneFocusText(view.text), ...(view.link === null ? {} : { link: view.link }), task: pick.view, ...(view.run === null ? {} : { run: view.run }) }], now_);
        } else if (pick.kind === "many") {
          state.plan(event.id, [{ text: ["Several tasks match. Add a word from the title, or send one of these:", ...pick.choices.map(one => `• ${one.title} — /task ${one.id}`)].join("\n") }], now_);
        } else state.plan(event.id, [{ text: PHONE_NO_MATCH }], now_);
      }
      return true;
    }
    // The team layer: `/team` anywhere, everything in a followed room, and a
    // DM that chose a conversation. Its replies are planned like any other.
    const room = state.room(identity.installation, event.channel);
    const isRoom = event.channel !== binding.channel;
    if (isRoom || room !== null || roomCommand(text) !== null) {
      const replies: ChatContent[] = [];
      const registry = await options.readProjects();
      const consumed = applyRoomInbound({
        store, channel: state.channel, backend: state.roomBackend(identity.installation, now), chatId: event.channel, isGroup: isRoom,
        sender: { approver: binding.approver, generation: binding.generation, binding: binding.id }, updateKey: event.id, text,
        projects: registry, origin: options.origin(), now, report: { ignored: 0 },
        say: (reply, link) => replies.push({ text: reply, ...(link ? { link } : {}), ...(isRoom ? { channel: event.channel } : {}) }),
      });
      if (consumed) {
        state.plan(event.id, replies, now);
        return true;
      }
    }
    if (text.length > MATE_MESSAGE_MAX_CHARS) {
      state.plan(
        event.id,
        [
          {
            text: tooLongText(
              input.originalLength || text.length,
            ),
          },
        ],
        nowOf(options),
      );
      return true;
    }
    const request = chatHash(
      `${options.state.channel}:${binding.id}:${event.id}`,
    ).slice(0, 32);
    let receipt =
      event.session === null
        ? null
        : store.mateRequestReceipt(event.session, request);
    if (!receipt) {
      if (new Date(event.created).getTime() + 600_000 < now.getTime()) {
        state.plan(
          event.id,
          [
            {
              text: "This message waited too long to start. Send it again when you’re ready.",
            },
          ],
          now,
        );
        return true;
      }
      const resolved = resolveChannelMate(
        store,
        { approver: binding.approver, approverGeneration: binding.generation },
        repos,
        now,
      );
      if (!resolved.ok && resolved.reason === "busy") {
        state.defer(
          event.id,
          "Assistant is answering another message",
          new Date(now.getTime() + 5000),
        );
        return true;
      }
      if (!resolved.ok) {
        state.plan(
          event.id,
          [
            {
              text: (resolved.said ?? "This chat is no longer paired.")
                .replaceAll("this phone", options.label)
                .replaceAll("the phone", options.label),
            },
          ],
          now,
        );
        return true;
      }
      if (event.session !== null && event.session !== resolved.session.id) {
        state.plan(
          event.id,
          [{ text: "This conversation was restarted after you sent that, so it wasn't answered. Send your message again." }],
          now,
        );
        return true;
      }
      state
        .prepare(
          "UPDATE chat_event SET session=? WHERE id=? AND state='queued'",
        )
        .run(resolved.session.id, event.id);
      const contexts = state
        .prepare(
          "SELECT p.payload FROM chat_part p JOIN chat_event e ON e.id=p.event WHERE e.binding=? AND e.channel=? AND (p.message=? OR e.thread=?) AND p.state='sent' ORDER BY p.id DESC LIMIT 100",
        )
        .all(binding.id, binding.channel, event.thread, event.thread)
        // Context only: a part that can't be read adds none.
        .flatMap((row) => { const read = readChatPart(String(row.payload)); return read.ok ? [read.value] : []; })
        // A card is about the task it names, or the one confirming it filed.
        .map((c) => {
          if (c.task || c.proposal === undefined) return c;
          const about = proposalTaskOf(store.getMateProposal(c.proposal));
          return about === null ? c : { ...c, task: about.task, ...(about.run === null ? {} : { run: about.run }) };
        });
      const targets = [
        ...new Map(
          contexts
            .filter((c) => c.task)
            .map((c) => [`${c.task}:${c.run ?? ""}`, c]),
        ).values(),
      ];
      if (targets.length > 1) {
        state.plan(
          event.id,
          [
            {
              text: "This thread is about more than one task. Reply to the message about the one you mean, or send /tasks to pick one.",
            },
          ],
          nowOf(options),
        );
        return true;
      }
      // No reply target: the task this chat chose, when it still exists here.
      const focused = targets.length === 0 ? store.chatFocus(options.label.toLowerCase(), binding.id) : null;
      const focusTask = focused !== null && taskInCeiling(store, focused, repos) ? focused : null;
      const context = targets[0] ?? (focusTask === null ? null : { text: "", task: focusTask, run: null });
      if (context?.task) {
        about = { task: context.task, run: context.run ?? null };
        state
          .prepare("UPDATE chat_event SET payload=? WHERE id=? AND state='queued'")
          .run(JSON.stringify({ ...input, about }), event.id);
      }
      // An unknown surface names no channel rather than a guess.
      const channel = leadChannelOf(options.label);
      // Only ever the owner's own message in their own chat: never the bot's, never a room.
      const warm = warmTurn(options.warm !== undefined && event.kind === "message" && event.member !== identity.bot && event.member === binding.member && event.channel === binding.channel
        ? options.warm(event, binding) : {});
      const outcome = await runMateTurn({
        store,
        who: resolved.who,
        session: resolved.session,
        thread: resolved.thread,
        config: resolved.config,
        key: null,
        message: text,
        requestId: request,
        ...(context?.task
          ? { context: focusTask !== null && targets.length === 0 ? focusContextFor(context.task) : replyContextFor(context.task, context.run ?? null) }
          : {}),
        ...(options.subscriptionRunner
          ? { subscriptionRunner: options.subscriptionRunner }
          : {}),
        clock: () => nowOf(options),
        evidenceRoot: options.evidenceRoot,
        mediaDelivery: "documents",
        ...(channel === undefined ? {} : { channel }),
        onProgress: warm.onProgress,
        revalidate: async () => {
          try {
            await channelAccess(options, binding, resolved.who.ceilingDigest);
            return { ok: true };
          } catch (error) {
            const code = error instanceof ChatDeliveryError ? error.code : "";
            const reason: MateChannelProblem = code === "Connected projects changed" ? "projects-changed"
              : code.endsWith("account access changed") ? "member-changed" : "access-changed";
            return { ok: false, reason };
          }
        },
      }).finally(warm.stop);
      if (outcome.ok && !outcome.replayed && context?.task)
        mirrorToTaskChat(store, resolved.who, context.task, options.label, text, outcome.reply, nowOf(options));
      if (
        !state.owns(identity.installation, options.owner, nowOf(options)) ||
        !options.current()
      )
        return false;
      if (
        !outcome.ok &&
        "refused" in outcome &&
        outcome.refused === "concurrent"
      ) {
        state.defer(
          event.id,
          "Assistant is answering another message",
          new Date(nowOf(options).getTime() + 5000),
        );
        return true;
      }
      receipt = store.mateRequestReceipt(resolved.session.id, request);
      if (!receipt) {
        state.plan(
          event.id,
          [
            {
              text: !outcome.ok
                ? phoneText(outcome.message, 1000)
                : "The assistant did not save a reply. Send your message again.",
            },
          ],
          nowOf(options),
        );
        return true;
      }
    }
    store.sweepStaleMateTurns(nowOf(options));
    const turn = store.getMateTurn(receipt.turn);
    if (turn?.state === "running" || turn?.state === "queued") {
      state.defer(
        event.id,
        "Reply is still running",
        new Date(nowOf(options).getTime() + 5000),
      );
      return true;
    }
    if (turn?.state !== "answered") {
      state.plan(
        event.id,
        [
          {
            text: mateFailureText(turn?.failureReason ?? null),
          },
        ],
        nowOf(options),
      );
      return true;
    }
    const session = store.getMateSession(turn.session);
    if (!session) {
      state.finish(event.id, true);
      return true;
    }
    await channelAccess(options, binding, session.ceilingDigest);
    const reply =
      store
        .listMateMessages(turn.thread, 200)
        .find(
          (message) => message.turn === turn.id && message.role === "assistant",
        )?.text ?? "The reply is no longer in the saved thread.";
    // The lead's answer about one task names it: a reply to it stays on that task.
    // Split as written, then shape each part: no cut ever lands inside a link, code or a bold anchor.
    const shapedParts = shapeReplyParts(reply, options.partSize ?? CHAT_PART_SIZE, { asked: text, appOrigin: options.origin() });
    const parts: ChatContent[] = (shapedParts.length > 0 ? shapedParts : splitChatText("")).map(
      (text) => (about === null ? { text, voice: true } : { text, voice: true, task: about.task, ...(about.run === null ? {} : { run: about.run }) }),
    );
    // The lead's question to its owner: its options as buttons, then "Something else", in their own chat (any thread);
    // in a room a tap is not their message, so the question and its options go out as text.
    const ask = store.mateAsk(turn.id);
    if (ask !== null)
      parts.push({ ...(event.channel === binding.channel ? { text: phoneText(ask.question, 1000), ask: { turn: ask.turn, options: ask.options } } : { text: phoneText(chatAskText(ask), 1000) }),
        ...(about === null ? {} : { task: about.task, ...(about.run === null ? {} : { run: about.run }) }) });
    for (const image of store.listMateTurnEvidence(turn.id))
      parts.push({
        text: image.caption,
        image: {
          taskId: image.taskId,
          run: image.run,
          artifact: image.artifact,
          sha256: image.sha256,
        },
        task: image.taskId,
        run: image.run,
      });
    for (const proposal of store
      .listMateProposals(turn.thread, ["pending"])
      .filter((p) => p.turn === turn.id))
      parts.push({ text: "", proposal: proposal.id });
    state.plan(event.id, parts, nowOf(options));
    return true;
  } catch (error) {
    const problem =
      error instanceof ChatDeliveryError
        ? error
        : new ChatDeliveryError(`${options.label} is waiting to retry`);
    if (problem.permanent) {
      state.plan(event.id, [{ text: problem.message }], nowOf(options));
      state.prepare("UPDATE chat_event SET next_at=NULL,problem=? WHERE id=?").run(problem.message, event.id);
      return true;
    }
    state
      .prepare(
        "UPDATE chat_runtime SET problem=? WHERE installation=? AND owner=?",
      )
      .run(problem.message, identity.installation, options.owner);
    state.defer(
      event.id,
      problem.message,
      new Date(nowOf(options).getTime() + problem.retryMs),
    );
    if (problem.code === "ratelimited")
      state
        .prepare("UPDATE chat_runtime SET retry_at=? WHERE installation=?")
        .run(
          new Date(nowOf(options).getTime() + problem.retryMs).toISOString(),
          identity.installation,
        );
    return true;
  }
}

/**
 * A message in a channel (never a DM) that connects the channel to a flow,
 * or that the channel's flow takes as a card. False: not for an inbox.
 */
async function channelInboxEvent(options: ChatDeliveryOptions, event: ChatEvent): Promise<boolean> {
  const { store, identity } = options, state = options.state, app = state.channel;
  const binding = event.binding === null ? null : state.bindingById(event.binding);
  if (binding !== null && event.channel === binding.channel) return false;
  const body = readChatMessageBody(event.payload);
  // One that can't be read is answered, by path, on the ordinary path.
  if (!body.ok) return false;
  const text = body.value.text ?? "";
  if (FLOW_WORDS.test(text.trim())) {
    // Only a paired approver connects a channel, and only to a flow in their projects.
    if (binding === null || !state.live(binding)) { state.finish(event.id, true); return true; }
    const repos = await channelAccess(options, binding);
    const said = connectChannel(store, { app, installation: identity.installation, conversation: event.channel, binding, text, repos,
      followsConversation: state.room(identity.installation, event.channel) !== null }, nowOf(options));
    state.plan(event.id, [{ text: said, channel: event.channel }], nowOf(options));
    return true;
  }
  const trigger = watchedChannel(store, app, identity.installation, event.channel);
  const config = trigger === null ? null : triggerConfigOf(trigger);
  if (trigger === null || config?.kind !== "chat") return false;
  // What the bot says goes through the chat of whoever connected the channel; if they're gone, nothing is taken.
  const grant = state.bindingById(config.binding);
  if (grant === null || !state.live(grant)) { state.finish(event.id, true); return true; }
  // Teams names a thread by its first message on the conversation; Slack and Discord on the event.
  const root = app === "teams" ? /;messageid=([0-9]+)$/.exec(event.channel)?.[1] ?? event.ts : event.thread;
  const taken = takeChannelMessage(store, trigger, { app, conversation: event.channel, ts: event.ts, thread: root, text, who: binding?.approver ?? "someone" }, nowOf(options));
  if (taken.said === null) { state.finish(event.id); return true; }
  state.prepare("UPDATE chat_event SET binding=? WHERE id=?").run(grant.id, event.id);
  state.plan(event.id, [{ text: taken.said, channel: event.channel, ...(taken.link === undefined ? {} : { link: taken.link }) }], nowOf(options));
  return true;
}

/** Bound to the paired member, exact channel/message, pending proposal and current ceiling. */
export function applyChatAction(
  options: ChatDeliveryOptions,
  event: ChatEvent,
  binding: ChatBinding,
  repos: readonly string[],
): void {
  const state = options.state,
    { store } = options,
    now = nowOf(options),
    signals: Array<() => void> = [];
  store.transact(() => {
    if (
      !state.owns(options.identity.installation, options.owner, now) ||
      !options.current() ||
      !state.live(binding) ||
      event.member !== binding.member ||
      (event.channel !== binding.channel && state.room(options.identity.installation, event.channel)?.kind !== "group")
    )
      return;
    // A button the paired person tapped whose data couldn't be read is answered plainly: what was wrong, and that nothing was done.
    const body = readChatActionBody(event.payload);
    if (!body.ok || "problem" in body.value) {
      const problem = body.ok ? ("problem" in body.value ? body.value.problem : "") : body.issues.map(issue => issue.line).join("; ");
      state.plan(event.id, [{ text: `That button couldn't be read (${problem}). Nothing was done.` }], now);
      return;
    }
    const token = body.value.token;
    // A flow decision's button (v88) is answered by the flow's own door.
    if (applyChatFlowTap({ store, state, label: options.label }, event, binding, token, repos, now)) return;
    // A teammate's question's button (v93) is answered by the question's own door.
    if (applyChatQuestionTap({ store, state, label: options.label }, event, binding, token, now)) return;
    // The lead's question to its owner: the tapped option becomes their next message.
    if (applyChatAskTap({ store, state }, event, binding, token, now)) return;
    const saved = state
      .prepare(
        "SELECT a.*,p.message,e.binding,e.channel,e.thread FROM chat_action a JOIN chat_part p ON p.id=a.part JOIN chat_event e ON e.id=p.event WHERE token=?",
      )
      .get(token);
    // The saved button, read by its schema: one that can't be read is a spent button, never a guess.
    const read = saved === undefined ? null : readProposalActionRow({ ...saved });
    const action = read?.ok === true ? read.value : null;
    const invalid =
      !action ||
      action.binding !== binding.id ||
      action.channel !== event.channel ||
      action.message !== event.ts ||
      (options.state.channel === "slack" && action.thread !== event.thread) ||
      action.consumed !== null ||
      action.expires <= now.toISOString();
    if (invalid) {
      state.plan(
        event.id,
        [
          {
            text: "That button expired or was already used. Ask for the current state before trying again.",
          },
        ],
        now,
      );
      return;
    }
    const proposal = store.getMateProposal(action.proposal);
    const verified = verifyApproverStanding(
      store,
      binding.approver,
      binding.generation,
      repos,
    );
    if (!proposal || !verified.ok) {
      state.finish(event.id, true);
      return;
    }
    let content: ChatContent = {
      text: "",
      proposal: proposal.id,
      edit: event.ts,
    };
    const preview = proposalPreview(store, proposal, repos, options.state.channel);
    const phase = action.phase;
    if (proposal.state !== "pending")
      content = { text: proposalOutcomeText(proposal), edit: event.ts };
    else if (
      !preview.buttons ||
      preview.text.length > (options.maxProposal ?? 10_000)
    )
      content = { ...content, text: "Review this action in Toolroll." };
    else if (phase === "cancel") {
      state.tokens(
        action.part,
        proposal.id,
        ["confirm", "dismiss"],
        now,
      );
    } else if (phase === "dismiss") {
      const dismissed = dismissMateProposal(
        store,
        verified.who,
        proposal.id,
        now,
      );
      content = {
        text: dismissed
          ? "Dismissed."
          : "This proposal could not be dismissed. Ask for its current state.",
        edit: event.ts,
      };
    } else if (
      phase === "confirm" &&
      proposal.kind === "answer" &&
      proposal.payload.reversible === false
    ) {
      content = { ...content, phase: "armed" };
      state.tokens(action.part, proposal.id, ["yes", "cancel"], now);
    } else {
      const outcome = confirmMateProposal(
        store,
        verified.who,
        proposal.id,
        now,
        {
          via: options.state.channel,
          evidenceRoot: options.evidenceRoot,
          confirm: phase === "yes",
          deferSignal: (signal) => signals.push(signal),
        },
      );
      if (!outcome.ok && outcome.reason === "needs-confirm") {
        content = { ...content, phase: "armed" };
        state.tokens(action.part, proposal.id, ["yes", "cancel"], now);
      } else {
        content = {
          text: confirmedCardText(store, outcome, proposal, null),
          edit: event.ts,
          ...(outcome.ok && outcome.taskId ? { task: outcome.taskId } : {}),
        };
        const link = confirmedLink(store, outcome, proposal, repos);
        if (link) content.link = link;
      }
    }
    // Repaint the original persisted card; retain one placement and fresh tokens.
    state
      .prepare(
        "UPDATE chat_part SET payload=?,state='pending',next_at=NULL WHERE id=?",
      )
      .run(savedChatPart(content), action.part);
    if (!content.proposal)
      state
        .prepare(
          "UPDATE chat_action SET consumed=? WHERE proposal=? AND consumed IS NULL",
        )
        .run(now.toISOString(), proposal.id);
    else
      state
        .prepare("UPDATE chat_action SET consumed=? WHERE token=?")
        .run(now.toISOString(), token);
    state.finish(event.id);
  });
  for (const signal of signals) signal();
}

/**
 * Carry new conversation messages to every room that follows one: the
 * lead's replies, teammates' messages (never the room's own), and each
 * reply's pending cards, as ordinary parts sent to the room's channel. A
 * room is a grant from one exact pairing and is rechecked before each
 * message; a room nobody paired can carry waits.
 */
export async function planRoomMessages(options: ChatDeliveryOptions): Promise<void> {
  const state = options.state, { store, identity } = options, now = nowOf(options);
  if (!state.owns(identity.installation, options.owner, now) || !options.current()) return;
  const rooms = state.rooms(identity.installation);
  if (rooms.length === 0) return;
  const registry = await options.readProjects();
  if (!state.owns(identity.installation, options.owner, nowOf(options)) || !options.current()) return;
  const domain = teamDomain(store, registry);
  const backend = state.roomBackend(identity.installation, now);
  const live = state.bindings(identity.installation).filter(one => state.live(one));
  for (const room of rooms) {
    const asRoom = { id: room.id, chatId: room.chat, kind: room.kind, conversation: room.conversation, boundBy: room.boundBy, binding: room.binding, cursor: room.cursor };
    if (!roomGrantAllowed(store, domain, backend, asRoom)) continue;
    const row = conversationRow(store, room.conversation);
    if (row === null) continue;
    for (const message of roomMessagesAfter(store, row.thread, room.cursor)) {
      const text = roomMessageText(message, state.channel, room.chat);
      let carrier: ChatBinding | null = null;
      if (room.kind === "private") carrier = live.find(one => one.channel === room.chat) ?? null;
      else {
        const approver = message.turn === null ? null : roomCardApprover(store, room.conversation, message.turn, live.map(one => one.approver));
        const preferred = approver === null ? undefined : live.find(one => one.approver === approver);
        carrier = preferred ?? live.find(one => one.id === room.binding) ?? null;
      }
      if (carrier === null) break;
      const parts: ChatContent[] = [];
      if (text !== null) {
        if (message.role === "assistant") for (const part of shapeReplyParts(text, options.partSize ?? CHAT_PART_SIZE, { appOrigin: options.origin() })) parts.push({ text: part, voice: true, channel: room.chat });
        else parts.push({ text, channel: room.chat });
      }
      if (message.role === "assistant" && message.turn !== null)
        for (const proposal of store.listMateProposals(row.thread, ["pending"]).filter(one => one.turn === message.turn)) parts.push({ text: "", proposal: proposal.id, channel: room.chat });
      const id = chatHash(`${state.channel}:room:${room.id}:${message.id}`);
      const target = carrier;
      store.transact(() => {
        if (parts.length > 0 && state.enqueue({ id, installation: identity.installation, binding: target.id, kind: "message", channel: room.chat, member: target.member, ts: "", thread: "", payload: {}, created: now.toISOString() }))
          state.plan(id, parts, now);
        state.advanceRoomCursor(room.id, message.id);
      });
    }
  }
}

/** Quiet mode: the task's one card (or its group's) in this person's chat, planned once and then repainted in
 * place whenever what it says changes. */
function planQuietCard(options: ChatDeliveryOptions, binding: ChatBinding, notification: Parameters<typeof isTaskFact>[0] & { taskRef: number | null; taskId: string | null; createdAt: string }, now: Date): void {
  const { state, store, identity } = options;
  if (notification.taskRef === null || notification.taskId === null) return;
  const card = store.chatCardFor(`${state.channel}:${binding.id}`, notification.taskRef, store.getTask(notification.taskId)?.createdAt ?? notification.createdAt, now);
  const view = quietCardView(store, card.tasks, now, options.evidenceRoot, binding.approver);
  if (view === null) return;
  const content: ChatContent = { text: view.text, link: view.link, ...(card.tasks.length === 1 ? { task: notification.taskId } : {}) };
  const shown = chatHash(JSON.stringify(content));
  if (card.message !== null) {
    if (card.digest === shown) return;
    state.prepare("UPDATE chat_part SET payload=?,state='pending',created=?,next_at=NULL WHERE id=? AND state!='dropped'").run(savedChatPart(content), now.toISOString(), Number(card.message));
    store.setChatCardMessage(card.id, card.message, shown);
    return;
  }
  const id = chatHash(`${state.channel}:card:${binding.id}:${card.id}`);
  state.enqueue({ id, installation: identity.installation, binding: binding.id, kind: "notice", channel: binding.channel, member: binding.member,
    ts: "", thread: "", payload: {}, created: now.toISOString() });
  state.plan(id, [content], now);
  const part = state.prepare("SELECT id FROM chat_part WHERE event=?").get(id);
  if (part !== undefined) store.setChatCardMessage(card.id, String(part.id), shown);
}

/** Any update for this person joins their open batch (two minutes from its first), and the batch's one message
 * is planned once, then repainted in place as more updates land. `notification`: an update that is not a finished
 * result (null for one that is). False when nothing in the batch reads as a line, so the update goes out on its own. */
function planFinished(options: ChatDeliveryOptions, binding: ChatBinding, taskRef: number, run: number | null, now: Date, notification: number | null = null): boolean {
  const { state, store, identity } = options;
  const batch = store.chatBatchFor(`${state.channel}:${binding.id}`, taskRef, run, now, BATCH_MS, notification);
  const view = finishedView(store, batch, now, options.evidenceRoot, binding.approver);
  if (view === null) return false;
  // A single update keeps its task and run, so a reply to it names that work.
  const single = batch.items.length === 1 ? batch.items[0]! : null;
  const task = single === null ? null : store.refById(single.taskRef)?.externalId ?? null;
  const content: ChatContent = { text: view.text, link: view.link, ...(view.also === undefined ? {} : { also: view.also }),
    ...(task === null ? {} : { task }), ...(single?.run == null ? {} : { run: single.run }) };
  const shown = chatHash(JSON.stringify(content));
  if (batch.message !== null) {
    if (batch.digest === shown) return true;
    state.prepare("UPDATE chat_part SET payload=?,state='pending',created=?,next_at=NULL WHERE id=? AND state!='dropped'").run(savedChatPart(content), now.toISOString(), Number(batch.message));
    store.setChatBatchMessage(batch.id, batch.message, shown);
    return true;
  }
  const id = chatHash(`${state.channel}:batch:${binding.id}:${batch.id}`);
  state.enqueue({ id, installation: identity.installation, binding: binding.id, kind: "notice", channel: binding.channel, member: binding.member,
    ts: "", thread: "", payload: {}, created: now.toISOString() });
  state.plan(id, [content], now);
  const part = state.prepare("SELECT id FROM chat_part WHERE event=?").get(id);
  if (part !== undefined) store.setChatBatchMessage(batch.id, String(part.id), shown);
  return true;
}

/** Screenshots with a result (result-shots.ts), planned after the result's own message: each an upload that follows
 * it in its thread (Slack, Discord), or one link to them (Teams). A failed check is one plain line instead. */
function planResultShots(options: ChatDeliveryOptions, binding: ChatBinding, notification: Notification, repos: readonly string[], id: string, now: Date): void {
  const { state, store, identity } = options;
  const plan = resultShotsFor(store, options.evidenceRoot, repos, notification);
  if (plan.kind === "none" || notification.taskId === null || notification.run === null) return;
  const where = { task: notification.taskId, run: notification.run };
  // The result's message here: its finished-work batch (quiet), its progress card (every step), or the result's own
  // notice. The transport threads the screenshots under it once it is posted, and holds them until then.
  const follows = (() => {
    // A flow's screenshots follow the "Send to me" or "Person chooses" notice they go with.
    const visit = /^flow-shots:([1-9][0-9]*):([1-9][0-9]*)$/.exec(notification.dedupeKey);
    if (visit !== null) {
      for (const key of [`flow-send:${visit[1]}:${visit[2]}`, `flow-choose:${visit[1]}:${visit[2]}`]) {
        const notice = store.handle.prepare("SELECT id FROM notification WHERE dedupe_key=?").get(key);
        const part = notice === undefined ? undefined : state.prepare("SELECT id FROM chat_part WHERE event=? ORDER BY id DESC LIMIT 1").get(chatHash(`${state.channel}:notice:${binding.id}:${Number(notice["id"])}`));
        if (part !== undefined) return Number(part.id);
      }
      return null;
    }
    const batch = notification.taskRef === null ? null : store.chatBatchMessageFor(`${state.channel}:${binding.id}`, notification.taskRef, notification.run);
    if (batch !== null) return Number(batch);
    const card = state.prepare("SELECT part FROM chat_progress WHERE binding=? AND run=?").get(binding.id, notification.run);
    if (card !== undefined) return Number(card.part);
    for (const one of store.handle.prepare("SELECT id FROM notification WHERE source_run=? AND recipient IS NULL AND id<? ORDER BY id DESC").all(notification.run, notification.id)) {
      const part = state.prepare("SELECT id FROM chat_part WHERE event=? ORDER BY id LIMIT 1").get(chatHash(`${state.channel}:notice:${binding.id}:${Number(one["id"])}`));
      if (part !== undefined) return Number(part.id);
    }
    return null;
  })();
  const image = (artifact: number, sha256: string) => ({ taskId: where.task, run: where.run, artifact, sha256 });
  const parts: ChatContent[] = plan.kind === "line" ? [{ text: plan.text, ...where }]
    // Teams has no file upload here: one message that links to the saved result.
    : state.channel === "teams" ? [{ text: plan.shots.length === 1 ? plan.shots[0]!.caption : `${plan.shots[0]!.caption} · ${plan.shots.length} screenshots`,
      image: image(plan.shots[0]!.artifact, plan.shots[0]!.sha256), shot: { follows: null }, ...where }]
    : plan.shots.map(one => ({ text: one.caption, image: image(one.artifact, one.sha256), shot: { follows }, ...where }));
  state.enqueue({ id, installation: identity.installation, binding: binding.id, kind: "notice", channel: binding.channel, member: binding.member,
    ts: "", thread: "", payload: {}, created: now.toISOString() });
  state.plan(id, parts, now);
}

/** One progress card per exact result; separate urgent facts retain their own review link. */
export async function planChatNotifications(
  options: ChatDeliveryOptions,
): Promise<void> {
  const state = options.state,
    { store, identity } = options,
    bindings = state.bindings(identity.installation).filter(one => state.live(one));
  if (
    bindings.length === 0 ||
    !state.owns(identity.installation, options.owner, nowOf(options)) ||
    !options.current()
  )
    return;
  const registry = await options.readProjects();
  // An evening digest someone asked for is due: record it as their own notification, delivered below.
  try { enqueueEveningDigests(store, nowOf(options), options.evidenceRoot); } catch { /* Retried on the next pass. */ }
  enqueueLeadLapses(store, nowOf(options));
  const cursor = Number(
    state
      .prepare("SELECT notification FROM chat_runtime WHERE installation=?")
      .get(identity.installation)?.notification ?? 0,
  );
  // Every paired person is a destination of their own, under their own ceiling.
  for (const notification of store.notificationsAfter(cursor, 100)) {
    for (const binding of bindings) {
    const repos = channelRepos(store, binding.approver, registry);
    store.transact(() => {
      // One person's notification (v83) goes to that person alone, task or not.
      const personal = notification.recipient !== null;
      if (
        notification.createdAt >= binding.created &&
        notification.resolvedAt === null &&
        // A promise the lead made on another chat is reported there (lead-commitments.ts); one its owner asked for on
        // this chat is always said here, however quiet the lead's own work is kept.
        (promiseChannelOf(notification) ?? state.channel) === state.channel &&
        // Pings follow responsibility: the lead's work, this person's own act and a muted project stay in the console.
        (promiseChannelOf(notification) === state.channel || store.pingAllowed(notification, binding.approver)) &&
        // A flow decision for "anyone who approves" reaches every approver who can see the project.
        // A notification addressed to this person reaches them whatever project
        // their channel follows (a sign-in pause is the installation's, v108).
        (personal
          ? notification.recipient === binding.approver && (notification.project === null || repos.includes(notification.project))
          : (notification.taskId || notification.kind === "flow-decision") && notification.project !== null && repos.includes(notification.project))
      ) {
        const run = store.telegramProgressRun(notification);
        const id = chatHash(
            `${options.state.channel}:notice:${binding.id}:${notification.id}`,
          ),
          now = nowOf(options);
        // Only when I'm needed (the default): the task's one card is edited in place, and a new message
        // follows only when this person is needed. Every step keeps the branches below unchanged.
        const quiet = !personal && isTaskFact(notification) && store.notificationPreference(binding.approver).mode === "quiet";
        if (isShotsKind(notification.kind)) {
          planResultShots(options, binding, notification, repos, id, now);
          return;
        }
        if (notification.kind === LEAD_SAY_KIND) {
          // The lead's words (lead-voice.ts): one message, repainted in place when a later say joins it.
          const content: ChatContent = { text: leadSayText(store, notification, binding.approver),
            ...(notification.link ? { link: { label: "Open", path: notification.link } } : {}) };
          const earlier = leadSayEarlier(store, notification).map(one => state.prepare("SELECT id FROM chat_part WHERE event=?")
            .get(chatHash(`${options.state.channel}:notice:${binding.id}:${one}`))).find(one => one !== undefined);
          if (earlier !== undefined) {
            state.prepare("UPDATE chat_part SET payload=?,state='pending',created=?,next_at=NULL WHERE id=? AND state!='dropped'").run(savedChatPart(content), now.toISOString(), Number(earlier.id));
            return;
          }
          state.enqueue({ id, installation: identity.installation, binding: binding.id, kind: "notice", channel: binding.channel, member: binding.member,
            ts: "", thread: "", payload: {}, created: now.toISOString() });
          state.plan(id, [content], now);
          return;
        }
        if (quiet) {
          planQuietCard(options, binding, notification, now);
          if (!needsPerson(notification)) return;
          if (notification.kind === "run-finished" && run) {
            // Finished work goes out only as the batch line; one left out on purpose (a release check, a replaced
            // task, the reader's own completion) stays quiet rather than falling through to another message.
            planFinished(options, binding, notification.taskRef!, run.id, now);
            return;
          }
          // Every other update for this person within two minutes joins the same one message.
          else if (notification.kind !== "run-finished" && joinsBatch(notification)) {
            if (planFinished(options, binding, notification.taskRef!, run?.id ?? null, now, notification.id)) return;
          }
        }
        if (!quiet && run && notification.taskId && notification.project !== null && isTelegramProgressNotification(notification)) {
          const card = telegramProgressCard(
            store,
            store.getRun(run.id)!,
            notification.taskId,
            notification.project,
            now,
            options.evidenceRoot,
            binding.approver,
          );
          const content: ChatContent = {
            text: card.text,
            task: notification.taskId,
            run: run.id,
            link: card.link,
          };
          const digest = chatHash(JSON.stringify(content));
          const prior = state
            .prepare(
              "SELECT part,digest FROM chat_progress WHERE binding=? AND run=?",
            )
            .get(binding.id, run.id);
          if (prior) {
            if (prior.digest !== digest) {
              state
                .prepare(
                  "UPDATE chat_part SET payload=?,state='pending',created=?,next_at=NULL WHERE id=? AND state!='dropped'",
                )
                .run(
                  JSON.stringify(content),
                  now.toISOString(),
                  Number(prior.part),
                );
              state
                .prepare(
                  "UPDATE chat_progress SET digest=? WHERE binding=? AND run=?",
                )
                .run(digest, binding.id, run.id);
            }
          } else {
            state.enqueue({
              id,
              installation: identity.installation,
              binding: binding.id,
              kind: "notice",
              channel: binding.channel,
              member: binding.member,
              ts: "",
              thread: "",
              payload: {},
              created: now.toISOString(),
            });
            state.plan(id, [content], now);
            const part = state
              .prepare("SELECT id FROM chat_part WHERE event=?")
              .get(id)!;
            state
              .prepare("INSERT INTO chat_progress VALUES(?,?,?,?)")
              .run(binding.id, run.id, Number(part.id), digest);
          }
        } else if (notification.kind === "flow-decision") {
          // The draft as written, and Approve / Edit / Send back on its last part; a card that moved on is not news.
          const parts = flowDecisionParts(store, notification, state.channel);
          if (parts !== null) {
            state.enqueue({ id, installation: identity.installation, binding: binding.id, kind: "notice", channel: binding.channel, member: binding.member,
              ts: "", thread: "", payload: {}, created: now.toISOString() });
            state.plan(id, parts, now);
          }
        } else if (personal && flowSendParts(store, notification, state.channel) !== null) {
          // A flow's "Send to me" (flow-send.ts): what was done, with its links as buttons.
          state.enqueue({ id, installation: identity.installation, binding: binding.id, kind: "notice", channel: binding.channel, member: binding.member,
            ts: "", thread: "", payload: {}, created: now.toISOString() });
          state.plan(id, flowSendParts(store, notification, state.channel)!, now);
        } else if (notification.kind === "flow-card" && questionParts(store, notification, binding) !== null) {
          // A teammate's question (v93): its options and "Answer in words" on the notice, for the person it asks.
          state.enqueue({ id, installation: identity.installation, binding: binding.id, kind: "notice", channel: binding.channel, member: binding.member,
            ts: "", thread: "", payload: {}, created: now.toISOString() });
          state.plan(id, questionParts(store, notification, binding)!, now);
        } else if (notification.pushClass !== null || personal || quiet) {
          state.enqueue({
            id,
            installation: identity.installation,
            binding: binding.id,
            kind: "notice",
            channel: binding.channel,
            member: binding.member,
            ts: "",
            thread: "",
            payload: {},
            created: now.toISOString(),
          });
          state.plan(
            id,
            [
              {
                // Never the task's id or a "— revision" suffix (chat-voice.ts).
                text: chatText(phoneText(
                  notification.body === "" ? leadSubjectOf(store, notification, binding.approver) : `${leadSubjectOf(store, notification, binding.approver)}\n\n${notification.body}`,
                  2500,
                ), notification.taskId === null ? [] : [{ id: notification.taskId, title: chatTitle(store, notification.taskId) }]),
                ...(notification.taskId ? { task: notification.taskId } : {}),
                ...(run ? { run: run.id } : {}),
                ...(notification.link
                  ? { link: { label: notification.kind === "pull-request-ready" ? "Merge" : personal ? "Open" : "Review", path: notification.link } }
                  : {}),
              },
            ],
            now,
          );
        }
      }
    });
    }
    state
      .prepare("UPDATE chat_runtime SET notification=? WHERE installation=?")
      .run(notification.id, identity.installation);
  }
}
