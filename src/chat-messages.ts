/**
 * The chat core's messages, buttons and deliveries, for any chat app: what an app received (updates, and messages the
 * lead answers, queued, claimed and finished), the reply parts planned before any send and settled on the app's own
 * message id, the one-tap buttons behind decision, proposal, flow and question cards, the sent messages a reply can be
 * about, and each paired person's notification receipts and away-mode digest. Every query names its provider
 * (ChatCore.prepare), so one app's rows never reach another's. Telegram runs on it today through the store's
 * Telegram-named methods (one line each); the adapters keep only their transport.
 *
 * Imports the store's types only (no runtime cycle): the store builds its chats on it.
 */
import { join } from "node:path";
import { ChatCore } from "./chat-core.js";
import { readChatMessageBody, readChatPart, savedChatEventBody, savedChatPart, type ChatContent, type ChatMessageBody } from "./contracts/chat-content.js";
import { isTelegramProgressNotification, proposalTaskOf, readNotification, readNotificationReceipt } from "./notification-rows.js";
import type { Notification, NotificationReceipt, Run, TelegramAction, TelegramBinding, TelegramConversation, TelegramConversationPart, TelegramConversationPartPlan,
  TelegramDelivery, TelegramDigest, TelegramFlowAction, TelegramFlowChoice, TelegramFlowPrompt, TelegramProposalAction } from "./store.js";

/** v83: a notification for another person, settled for this destination without sending. */
export const TELEGRAM_SKIPPED_ELSEWHERE = "skipped:for-another-person";

/** A met promise the lead made on another chat: reported there, settled here without sending. */
export const TELEGRAM_SKIPPED_OTHER_CHAT = "skipped:for-another-chat";

/** A fact this person is not messaged about: the lead's work, their own act, or a project they muted. */
export const TELEGRAM_SKIPPED_QUIET = "skipped:quiet";

/** A destination receipt (`d` = notification_delivery) that still owes a
 * send: not delivered, and not explicitly skipped as pre-pairing history.
 * Every reader of Telegram receipts that means "undelivered" uses this, so
 * a skip settles the row without ever pretending to be a delivery. */
export const TELEGRAM_UNSETTLED = "d.delivered_at IS NULL AND (d.receipt IS NULL OR d.receipt NOT LIKE 'skipped:%')";

/**
 * Why the store itself holds a Telegram delivery back: authority,
 * provenance, ordering, a switched-off channel, or a wait it imposed. A
 * row held for one of these is waiting on policy, not failing on the wire.
 * Every other error recorded on a receipt came from an actual send, and
 * THAT is delivery trouble (`pendingForAttention`). One table, so the
 * fences and the tally can never disagree about the words.
 */
export const TELEGRAM_HOLD_REASONS = Object.freeze({
  authority: "Telegram pairing or actor authorization changed",
  destination: "Telegram destination changed",
  claim: "Telegram delivery claim expired or changed",
  rateLimit: "Telegram rate limit is still active",
  resolved: "Notification no longer needs delivery",
  provenance: "Notification has no trusted project provenance",
  installation: "Installation notification requires instance access",
  project: "Notification project is not currently authorized and enrolled",
  task: "Notification task provenance changed",
  order: "Earlier task notification is still undelivered",
  disabled: "Telegram delivery is disabled",
});

/** A Telegram message the lead answers is its event m<update id>, read with the pairing it came from. */
const TELEGRAM_CONVERSATION_SELECT = `SELECT e.*, b.approver AS paired_approver, b.generation AS paired_generation
  FROM chat_event e JOIN chat_binding b ON b.provider = e.provider AND b.id = e.binding
  WHERE e.provider = :provider AND e.kind = 'message'`;

/** In update order. */
const TELEGRAM_CONVERSATION_ORDER = "CAST(substr(e.id, 2) AS INTEGER)";

function readTelegramConversation(row: Record<string, unknown>): TelegramConversation {
  const text = (key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));
  const int = (key: string): number | null => (row[key] === null || row[key] === undefined ? null : Number(row[key]));
  // A message dropped when its chat was unpaired keeps no words.
  const read = readChatMessageBody(String(row["payload"]));
  const body: Partial<ChatMessageBody> = read.ok ? read.value : {};
  const update = Number(String(row["id"]).slice(1));
  const state = String(row["state"]);
  return {
    id: update,
    binding: Number(row["binding"]),
    botId: String(row["installation"]),
    chatId: String(row["channel"]),
    userId: String(row["member"]),
    approver: String(row["paired_approver"]),
    approverGeneration: Number(row["paired_generation"]),
    updateId: update,
    messageId: String(row["ts"]),
    replyTo: row["thread"] === "" ? null : text("thread"),
    request: body.request ?? "",
    text: body.text ?? "",
    context: body.context ?? null,
    taskId: body.about?.task ?? null,
    sourceRun: body.about?.run ?? null,
    state: (state === "dropped" ? "failed" : state) as TelegramConversation["state"],
    claimOwner: text("claim_owner"),
    claimExpiresAt: text("claim_until"),
    attempts: Number(row["attempts"]),
    nextAttemptAt: text("next_at"),
    session: int("session"),
    turn: int("turn"),
    outcome: text("result"),
    replyMessageId: text("reply"),
    createdAt: String(row["created"]),
    startedAt: text("started"),
    finishedAt: text("finished"),
  };
}

/** One planned part of a Telegram reply (chat_part, its content by contracts/chat-content.ts). */
function readTelegramConversationPart(row: Record<string, unknown>, conversation: number): TelegramConversationPart {
  const text = (key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));
  const read = readChatPart(String(row["payload"]));
  if (!read.ok) throw new Error(`Telegram reply part ${conversation}:${String(row["ordinal"])} can't be read: ${read.issues.map(issue => issue.line).join("; ")}`);
  const content = read.value;
  const kind: TelegramConversationPart["kind"] = content.image !== undefined ? "image" : content.card === true || content.proposal !== undefined ? "card" : "reply";
  return {
    conversation,
    ordinal: Number(row["ordinal"]),
    kind,
    text: content.text,
    replyTo: content.replyTo ?? null,
    // A card's proposal, while it exists (a deleted one reads as gone).
    proposal: content.proposal !== undefined && Number(row["proposal_live"] ?? 1) === 1 ? content.proposal : null,
    keyboard: content.keyboard === undefined ? null : content.keyboard.map(line => line.map(button => ({ ...button, text: button.text, callback_data: button.callback_data }))),
    state: String(row["state"]) as TelegramConversationPart["state"],
    messageId: text("message"),
    taskId: content.image?.taskId ?? null,
    run: content.image?.run ?? null,
    artifact: content.image?.artifact ?? null,
    sha256: content.image?.sha256 ?? null,
    attempts: Number(row["attempts"]),
    uncertain: Number(row["uncertain"]),
    nextAttemptAt: text("next_at"),
    lastError: text("problem"),
    createdAt: String(row["created"]),
    sentAt: text("sent"),
  };
}

function readTelegramProposalAction(row: Record<string, unknown>): TelegramProposalAction {
  return {
    token: String(row["token"]),
    binding: Number(row["binding"]),
    proposal: Number(row["proposal"]),
    phase: String(row["phase"]) as TelegramProposalAction["phase"],
    chatId: String(row["chat"]),
    messageId: row["message"] === null ? null : String(row["message"]),
    createdAt: String(row["created"]),
    expiresAt: row["expires"] === null ? null : String(row["expires"]),
    consumedAt: row["consumed"] === null ? null : String(row["consumed"]),
  };
}

function readTelegramAction(row: Record<string, unknown>): TelegramAction {
  return {
    token: String(row["token"]),
    binding: Number(row["binding"]),
    decision: Number(row["decision"]),
    optionId: String(row["option_id"]),
    phase: String(row["phase"]) as TelegramAction["phase"],
    chatId: String(row["chat"]),
    messageId: row["message"] === null ? null : String(row["message"]),
    createdAt: String(row["created"]),
    expiresAt: row["expires"] === null ? null : String(row["expires"]),
    consumedAt: row["consumed"] === null ? null : String(row["consumed"]),
    noteDigest: row["note_digest"] === null || row["note_digest"] === undefined ? null : String(row["note_digest"]),
  };
}

export class ChatMessages extends ChatCore {
  createDecisionAction(
    action: {
      token: string;
      binding: number;
      decision: number;
      optionId: string;
      phase: "choose" | "confirm" | "cancel";
      chatId: string;
      messageId?: string;
      ttlMs?: number;
      /** Binds an irreversible confirmation to the EXACT note it showed. */
      noteDigest?: string;
    },
    now: Date,
  ): void {
    this
      .prepare(
        `INSERT INTO chat_action (provider, token, binding, chat, message, decision, option_id, phase, created, expires, note_digest)
         VALUES (:provider, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.token,
        action.binding,
        action.chatId,
        action.messageId ?? null,
        action.decision,
        action.optionId,
        action.phase,
        now.toISOString(),
        action.ttlMs === undefined ? null : new Date(now.getTime() + action.ttlMs).toISOString(),
        action.noteDigest ?? null,
      );
  }

  /** Which decision an outbound Telegram message carried. Recorded after the
   * send returns its id; a send whose record was lost routes nothing. */
  recordDecisionMessage(binding: number, chatId: string, messageId: string, decision: number, now: Date): void {
    this
      .prepare(
        `INSERT OR IGNORE INTO chat_message_ref (provider, binding, chat, message, kind, decision, created)
         VALUES (:provider, ?, ?, ?, 'decision', ?, ?)`,
      )
      .run(binding, chatId, messageId, decision, now.toISOString());
  }

  /** The decision behind an exact replied-to message, or nothing. Never "the latest". */
  decisionForMessage(binding: number, chatId: string, messageId: string): number | null {
    const row = this
      .prepare("SELECT decision FROM chat_message_ref WHERE provider = :provider AND kind = 'decision' AND binding = ? AND chat = ? AND message = ?")
      .get(binding, chatId, messageId);
    return row === undefined ? null : Number(row["decision"]);
  }

  /** The one live, unexpired draft for a decision, if any. */
  liveNoteDraft(binding: number, decision: number, now: Date): { id: number; note: string; updateId: number; state: string } | null {
    const row = this
      .prepare(
        `SELECT id, note, event, state FROM chat_note_draft
          WHERE provider = :provider AND binding = ? AND decision = ? AND state IN ('pending','armed') AND expires > ?`,
      )
      .get(binding, decision, now.toISOString());
    return row === undefined
      ? null
      : { id: Number(row["id"]), note: String(row["note"]), updateId: Number(row["event"]), state: String(row["state"]) };
  }

  /**
   * Persist a validated note as the live draft. A newer update SUPERSEDES
   * the old draft — drafts are immutable, and only a GREATER update_id may
   * replace one, so out-of-order delivery cannot resurrect an older note
   * (Codex free-text review, state machine). Returns false when an older
   * or equal update tried.
   */
  saveNoteDraft(
    draft: { binding: number; decision: number; updateId: number; messageId: string; replyTo: string; note: string },
    now: Date,
    ttlMs = 10 * 60_000,
  ): boolean {
    return this.store.transact(() => {
      const chat = this;
      const live = chat
        .prepare("SELECT id, event FROM chat_note_draft WHERE provider = :provider AND binding = ? AND decision = ? AND state IN ('pending','armed')")
        .get(draft.binding, draft.decision);
      if (live !== undefined) {
        if (Number(live["event"]) >= draft.updateId) return false;
        chat.prepare("UPDATE chat_note_draft SET state = 'superseded' WHERE provider = :provider AND id = ?").run(live["id"]);
      }
      chat
        .prepare(
          `INSERT INTO chat_note_draft (provider, id, binding, decision, event, message, reply_to, note, state, created, expires)
           VALUES (:provider, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          chat.nextId("chat_note_draft"),
          draft.binding,
          draft.decision,
          draft.updateId,
          draft.messageId,
          draft.replyTo,
          draft.note,
          now.toISOString(),
          new Date(now.getTime() + ttlMs).toISOString(),
        );
      return true;
    });
  }

  /** Move a draft between states; the caller owns the transaction story. */
  setNoteDraftState(id: number, state: "pending" | "armed" | "superseded" | "consumed" | "discarded"): void {
    this.prepare("UPDATE chat_note_draft SET state = ? WHERE provider = :provider AND id = ?").run(state, id);
  }

  createFlowActions(at: { binding: number; chatId: string; card: number; entry: number }, actions: readonly { token: string; action: TelegramFlowAction["action"] }[], now: Date, days = 7): void {
    const stamp = now.toISOString(), expires = new Date(now.getTime() + days * 86_400_000).toISOString();
    const insert = this.prepare("INSERT INTO chat_flow_action (provider, token, binding, card, entry, action, chat, message, created, expires) VALUES (:provider, ?, ?, ?, ?, ?, ?, NULL, ?, ?)");
    for (const one of actions) insert.run(one.token, at.binding, at.card, at.entry, one.action, at.chatId, stamp, expires);
  }

  flowAction(token: string): TelegramFlowAction | null {
    if (!/^[0-9a-f]{32}$/.test(token)) return null;
    const row = this.prepare("SELECT * FROM chat_flow_action WHERE provider = :provider AND token = ? AND action IN ('approve','edit','send-back')").get(token);
    if (row === undefined) return null;
    return { token: String(row["token"]), binding: Number(row["binding"]), card: Number(row["card"]), entry: Number(row["entry"]), action: String(row["action"]) as TelegramFlowAction["action"],
      chatId: String(row["chat"]), messageId: row["message"] === null ? null : String(row["message"]), expiresAt: String(row["expires"]), consumedAt: row["consumed"] === null ? null : String(row["consumed"]) };
  }

  placeFlowActions(tokens: readonly string[], messageId: string): void {
    const place = this.prepare("UPDATE chat_flow_action SET message = ? WHERE provider = :provider AND token = ?");
    for (const token of tokens) place.run(messageId, token);
  }

  /** Retire every button (and prompt) for one visit of a card, in every chat app: it was decided, or its draft replaced. */
  retireFlowVisit(card: number, entry: number, now: Date): void {
    const stamp = now.toISOString();
    this.db.prepare("UPDATE chat_flow_action SET consumed = ? WHERE card = ? AND entry = ? AND consumed IS NULL").run(stamp, card, entry);
    this.db.prepare("UPDATE chat_flow_prompt SET consumed = ? WHERE card = ? AND entry = ? AND consumed IS NULL").run(stamp, card, entry);
  }

  recordFlowPrompt(prompt: TelegramFlowPrompt, now: Date, hours = 24): void {
    const chat = this;
    chat.prepare("DELETE FROM chat_flow_prompt WHERE provider = :provider AND chat = ? AND message = ?").run(prompt.chatId, prompt.messageId);
    chat.prepare("INSERT INTO chat_flow_prompt (provider, id, chat, message, binding, card, entry, mode, created, expires) VALUES (:provider, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(chat.nextId("chat_flow_prompt"), prompt.chatId, prompt.messageId, prompt.binding, prompt.card, prompt.entry, prompt.mode, now.toISOString(), new Date(now.getTime() + hours * 3_600_000).toISOString());
  }

  /** The live prompt a message replies to, if any. */
  flowPrompt(chatId: string, messageId: string, now: Date): TelegramFlowPrompt | null {
    const row = this.prepare("SELECT * FROM chat_flow_prompt WHERE provider = :provider AND chat = ? AND message = ? AND consumed IS NULL AND expires > ?").get(chatId, messageId, now.toISOString());
    if (row === undefined) return null;
    return { chatId: String(row["chat"]), messageId: String(row["message"]), binding: Number(row["binding"]), card: Number(row["card"]), entry: Number(row["entry"]), mode: String(row["mode"]) as TelegramFlowPrompt["mode"] };
  }

  createFlowChoices(at: { binding: number; chatId: string; card: number; entry: number }, choices: readonly { token: string; choice: number; label: string }[], now: Date, days = 7): void {
    const stamp = now.toISOString(), expires = new Date(now.getTime() + days * 86_400_000).toISOString();
    const insert = this.prepare("INSERT INTO chat_flow_choice (provider, token, binding, card, entry, choice, label, chat, message, created, expires) VALUES (:provider, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)");
    for (const one of choices) insert.run(one.token, at.binding, at.card, at.entry, one.choice, one.label, at.chatId, stamp, expires);
  }

  flowChoice(token: string): TelegramFlowChoice | null {
    if (!/^[0-9a-f]{32}$/.test(token)) return null;
    const row = this.prepare("SELECT * FROM chat_flow_choice WHERE provider = :provider AND token = ?").get(token);
    if (row === undefined) return null;
    return { token: String(row["token"]), binding: Number(row["binding"]), card: Number(row["card"]), entry: Number(row["entry"]), choice: Number(row["choice"]), label: String(row["label"]),
      chatId: String(row["chat"]), messageId: row["message"] === null ? null : String(row["message"]), expiresAt: String(row["expires"]), consumedAt: row["consumed"] === null ? null : String(row["consumed"]) };
  }

  placeFlowChoices(tokens: readonly string[], messageId: string): void {
    const place = this.prepare("UPDATE chat_flow_choice SET message = ? WHERE provider = :provider AND token = ?");
    for (const token of tokens) place.run(messageId, token);
  }

  createQuestionActions(at: { binding: number; chatId: string; question: number }, choices: readonly { token: string; choice: string | null }[], now: Date, days = 7): void {
    const stamp = now.toISOString(), expires = new Date(now.getTime() + days * 86_400_000).toISOString();
    const insert = this.prepare("INSERT INTO chat_question_action (provider, token, binding, question, choice, chat, message, created, expires) VALUES (:provider, ?, ?, ?, ?, ?, NULL, ?, ?)");
    for (const one of choices) insert.run(one.token, at.binding, at.question, one.choice, at.chatId, stamp, expires);
  }

  questionAction(token: string): { token: string; binding: number; question: number; choice: string | null; chatId: string; messageId: string | null; expiresAt: string; consumedAt: string | null } | null {
    if (!/^[0-9a-f]{32}$/.test(token)) return null;
    const row = this.prepare("SELECT * FROM chat_question_action WHERE provider = :provider AND token = ?").get(token);
    if (row === undefined) return null;
    return { token: String(row["token"]), binding: Number(row["binding"]), question: Number(row["question"]), choice: row["choice"] === null ? null : String(row["choice"]),
      chatId: String(row["chat"]), messageId: row["message"] === null ? null : String(row["message"]), expiresAt: String(row["expires"]), consumedAt: row["consumed"] === null ? null : String(row["consumed"]) };
  }

  placeQuestionActions(tokens: readonly string[], messageId: string): void {
    const place = this.prepare("UPDATE chat_question_action SET message = ? WHERE provider = :provider AND token = ?");
    for (const token of tokens) place.run(messageId, token);
  }

  /** Retire every button and prompt for a question, in every chat app: it was answered (anywhere). */
  retireQuestion(question: number, now: Date): void {
    const stamp = now.toISOString();
    this.db.prepare("UPDATE chat_question_action SET consumed = ? WHERE question = ? AND consumed IS NULL").run(stamp, question);
    this.db.prepare("UPDATE chat_question_prompt SET consumed = ? WHERE question = ? AND consumed IS NULL").run(stamp, question);
  }

  recordQuestionPrompt(prompt: { chatId: string; messageId: string; binding: number; question: number }, now: Date, hours = 24): void {
    const chat = this;
    chat.prepare("DELETE FROM chat_question_prompt WHERE provider = :provider AND chat = ? AND message = ?").run(prompt.chatId, prompt.messageId);
    chat.prepare("INSERT INTO chat_question_prompt (provider, id, chat, message, binding, question, created, expires) VALUES (:provider, ?, ?, ?, ?, ?, ?, ?)")
      .run(chat.nextId("chat_question_prompt"), prompt.chatId, prompt.messageId, prompt.binding, prompt.question, now.toISOString(), new Date(now.getTime() + hours * 3_600_000).toISOString());
  }

  questionPrompt(chatId: string, messageId: string, now: Date): { chatId: string; messageId: string; binding: number; question: number } | null {
    const row = this.prepare("SELECT * FROM chat_question_prompt WHERE provider = :provider AND chat = ? AND message = ? AND consumed IS NULL AND expires > ?").get(chatId, messageId, now.toISOString());
    return row === undefined ? null : { chatId: String(row["chat"]), messageId: String(row["message"]), binding: Number(row["binding"]), question: Number(row["question"]) };
  }

  decisionAction(token: string): TelegramAction | null {
    const row = this.prepare("SELECT * FROM chat_action WHERE provider = :provider AND token = ? AND decision IS NOT NULL").get(token);
    return row === undefined ? null : readTelegramAction(row);
  }

  /**
   * Kill every live confirm/cancel challenge on a decision. Cancel means
   * cancelled: a confirm that survived its own cancellation would be an
   * irreversible choice still armed after the person said stop.
   */
  consumeChallenges(decision: number, now: Date): void {
    this
      .prepare("UPDATE chat_action SET consumed = ? WHERE provider = :provider AND decision = ? AND phase IN ('confirm','cancel') AND consumed IS NULL")
      .run(now.toISOString(), decision);
  }

  /** Consume once. False means somebody already did, or it expired — either way, no. */
  consumeDecisionAction(token: string, now: Date): boolean {
    const stamp = now.toISOString();
    const { changes } = this
      .prepare("UPDATE chat_action SET consumed = ? WHERE provider = :provider AND token = ? AND decision IS NOT NULL AND consumed IS NULL AND (expires IS NULL OR expires > ?)")
      .run(stamp, token, stamp);
    return Number(changes) > 0;
  }

  /** Stamp the message a choose-action's keyboard actually landed on. */
  placeDecisionActions(tokens: readonly string[], messageId: string): void {
    const place = this.prepare("UPDATE chat_action SET message = ? WHERE provider = :provider AND token = ?");
    for (const token of tokens) place.run(messageId, token);
  }

  /** A Telegram message this bot sent that showed one task (v79): a reply to
   * it is about that task (and that result, when it showed one). A message
   * edited to show something else forgets it. */
  recordTaskMessage(binding: TelegramBinding, messageId: string, taskId: string | null, run: number | null, now: Date): void {
    const chat = this;
    if (taskId === null) {
      chat.prepare("DELETE FROM chat_message_ref WHERE provider = :provider AND kind = 'task' AND binding = ? AND chat = ? AND message = ?").run(binding.id, binding.chatId, messageId);
      return;
    }
    chat.prepare(`INSERT INTO chat_message_ref (provider, binding, chat, message, kind, task_id, run, created) VALUES (:provider, ?, ?, ?, 'task', ?, ?, ?)
      ON CONFLICT (provider, binding, chat, message, kind) WHERE kind <> 'notification' DO UPDATE SET task_id = excluded.task_id, run = excluded.run, created = excluded.created`)
      .run(binding.id, binding.chatId, messageId, taskId, run, now.toISOString());
  }

  /** v98: an update Telegram pushed, kept (queued, with its body) until the bridge applies it; false when it's already kept or applied. */
  queueUpdate(botId: string, updateId: number, payload: string, now: Date): boolean {
    return Number(this.prepare(`INSERT OR IGNORE INTO chat_event (provider, id, installation, kind, channel, member, ts, thread, payload, created, state)
      VALUES (:provider, ?, ?, 'update', '', '', '', '', ?, ?, 'queued')`).run(String(updateId), botId, payload, now.toISOString()).changes) === 1;
  }

  /** v98: pushed updates waiting for the bridge, oldest first. */
  inbox(botId: string, limit: number): { updateId: number; payload: string }[] {
    return this.prepare(`SELECT id, payload FROM chat_event WHERE provider = :provider AND kind = 'update' AND state = 'queued' AND installation = ?
      ORDER BY CAST(id AS INTEGER) LIMIT ?`).all(botId, limit)
      .map(row => ({ updateId: Number(row["id"]), payload: String(row["payload"]) }));
  }

  /** A pushed update the bridge is done with: applied (then its receipt stays), or unreadable (then it is gone). */
  dropInbox(updateId: number): void {
    this.prepare("DELETE FROM chat_event WHERE provider = :provider AND id = ? AND kind = 'update' AND state = 'queued'").run(String(updateId));
  }

  /** True if this update has not been applied before. The (provider, id) key is the idempotency; a pushed update waiting
   * in the inbox is applied in place. A receipt names only its update, as it always has. */
  markUpdateApplied(updateId: number, result: string, now: Date): boolean {
    const { changes } = this
      .prepare(`INSERT INTO chat_event (provider, id, installation, kind, channel, member, ts, thread, payload, created, state, result)
        VALUES (:provider, ?, '', 'update', '', '', '', '', '{}', ?, 'done', ?)
        ON CONFLICT (provider, id) DO UPDATE SET state = 'done', installation = '', payload = '{}', result = excluded.result
        WHERE chat_event.kind = 'update' AND chat_event.state = 'queued'`)
      .run(String(updateId), now.toISOString(), result);
    return Number(changes) > 0;
  }

  /** Persist one ordinary message before its update is acknowledged (event m<update id>). The caller's transaction also marks the update applied. */
  enqueueMessage(
    row: {
      binding: TelegramBinding; updateId: number; messageId: string; replyTo: string | null; request: string; text: string;
      context: string | null; taskId: string | null; sourceRun: number | null;
    },
    now: Date,
  ): number {
    const body = { text: row.text, request: row.request, ...(row.context === null ? {} : { context: row.context }),
      ...(row.taskId === null ? {} : { about: { task: row.taskId, run: row.sourceRun } }) };
    this
      .prepare(
        `INSERT INTO chat_event (provider, id, installation, binding, kind, channel, member, ts, thread, payload, created, state)
         VALUES (:provider, ?, ?, ?, 'message', ?, ?, ?, ?, ?, ?, 'queued')`,
      )
      .run(`m${row.updateId}`, row.binding.botId, row.binding.id, row.binding.chatId, row.binding.userId, row.messageId, row.replyTo ?? "", savedChatEventBody(body), now.toISOString());
    return row.updateId;
  }

  /** Whether a message from this chat is already waiting on, or being answered from, this bot message (a tapped question). */
  messageWaitingOn(binding: number, messageId: string): boolean {
    return this.prepare("SELECT 1 AS hit FROM chat_event WHERE provider = :provider AND kind = 'message' AND binding = ? AND ts = ? AND state IN ('queued', 'running') LIMIT 1").get(binding, messageId) !== undefined;
  }

  getMessage(id: number): TelegramConversation | null {
    const row = this.prepare(`${TELEGRAM_CONVERSATION_SELECT} AND e.id = ?`).get(`m${id}`);
    return row === undefined ? null : readTelegramConversation(row);
  }

  listMessages(botId: string): TelegramConversation[] {
    return this.prepare(`${TELEGRAM_CONVERSATION_SELECT} AND e.installation = ? ORDER BY ${TELEGRAM_CONVERSATION_ORDER}`).all(botId).map(readTelegramConversation);
  }

  /**
   * Claim the oldest message that still needs a turn: queued, or running
   * under a claim that lapsed (a crash mid-turn), and not deferred past now.
   * One at a time per bot — the mate runs one turn per approver anyway.
   */
  claimMessage(botId: string, owner: string, ttlMs: number, now: Date, only?: "turns" | "replies"): TelegramConversation | null {
    return this.store.transact(() => {
      const chat = this, stamp = now.toISOString();
      // "turns": still needs the assistant; "replies": the reply is planned and only sending remains.
      const planned = "EXISTS (SELECT 1 FROM chat_part p WHERE p.provider = e.provider AND p.event = e.id)";
      const which = only === "turns" ? `AND NOT ${planned}` : only === "replies" ? `AND ${planned}` : "";
      const row = chat
        .prepare(
          `SELECT e.id FROM chat_event e
            WHERE e.provider = :provider AND e.kind = 'message' AND e.installation = ? AND e.state IN ('queued','running')
              AND (e.claim_until IS NULL OR e.claim_until <= ?)
              AND (e.next_at IS NULL OR e.next_at <= ?)
              ${which}
            ORDER BY ${TELEGRAM_CONVERSATION_ORDER} LIMIT 1`,
        )
        .get(botId, stamp, stamp);
      if (row === undefined) return null;
      chat
        .prepare(
          `UPDATE chat_event SET state = 'running', claim_owner = ?, claim_until = ?, attempts = attempts + 1,
             started = COALESCE(started, ?), next_at = NULL WHERE provider = :provider AND id = ?`,
        )
        .run(owner, new Date(now.getTime() + ttlMs).toISOString(), stamp, String(row["id"]));
      return this.getMessage(Number(String(row["id"]).slice(1)));
    });
  }

  /** Extend a held claim; false means it lapsed and somebody else may hold the row. */
  renewMessage(id: number, owner: string, ttlMs: number, now: Date): boolean {
    const { changes } = this
      .prepare("UPDATE chat_event SET claim_until = ? WHERE provider = :provider AND id = ? AND claim_owner = ? AND claim_until > ? AND state = 'running'")
      .run(new Date(now.getTime() + ttlMs).toISOString(), `m${id}`, owner, now.toISOString());
    return Number(changes) === 1;
  }

  /**
   * Bind the session a turn is about to be dispatched under, BEFORE the
   * dispatch: the engine receipts the request inside that session, so a
   * later attempt — after a crash, even after the session was ended and
   * replaced from the console — reads the receipt where it was written
   * instead of resolving today's session and finding nothing there.
   */
  bindMessageSession(id: number, owner: string, session: number): boolean {
    const { changes } = this
      .prepare("UPDATE chat_event SET session = ? WHERE provider = :provider AND id = ? AND claim_owner = ? AND state = 'running'")
      .run(session, `m${id}`, owner);
    return Number(changes) === 1;
  }

  /** Bind the admitted turn to its row as soon as the engine's receipt names it. */
  bindMessageTurn(id: number, owner: string, session: number, turn: number): boolean {
    const { changes } = this
      .prepare("UPDATE chat_event SET session = ?, turn = ? WHERE provider = :provider AND id = ? AND claim_owner = ?")
      .run(session, turn, `m${id}`, owner);
    return Number(changes) === 1;
  }

  /**
   * Settle a claimed row: done or failed with its outcome word, or back to
   * queued for a later attempt (a busy engine). Only the claim holder may;
   * a lapsed claim settles nothing, so a reclaimer's outcome stands.
   */
  finishMessage(
    id: number,
    owner: string,
    result: { state: "done" | "failed"; outcome: string; replyMessageId?: string | null } | { state: "queued"; outcome: string; nextAttemptAt: string },
    now: Date,
  ): boolean {
    const stamp = now.toISOString(), chat = this;
    const { changes } = result.state === "queued"
      ? chat
          .prepare(
            `UPDATE chat_event SET state = 'queued', result = ?, next_at = ?, claim_owner = NULL, claim_until = NULL
              WHERE provider = :provider AND id = ? AND claim_owner = ? AND claim_until > ? AND state = 'running'`,
          )
          .run(result.outcome, result.nextAttemptAt, `m${id}`, owner, stamp)
      : chat
          .prepare(
            `UPDATE chat_event SET state = ?, result = ?, reply = COALESCE(?, reply), finished = ?,
               claim_owner = NULL, claim_until = NULL
              WHERE provider = :provider AND id = ? AND claim_owner = ? AND claim_until > ? AND state = 'running'`,
          )
          .run(result.state, result.outcome, result.replyMessageId ?? null, stamp, `m${id}`, owner, stamp);
    return Number(changes) === 1;
  }

  /**
   * Replies the assistant wrote that still have not reached the person
   * `since` ago or longer (status and the console show them with a Retry):
   * the message's row, whose it is, when the oldest unsent part was
   * written, and the last send error.
   */
  unsentReplies(botId: string | null, approver: string | null, since: Date): { conversation: number; approver: string; since: string; error: string | null }[] {
    return this
      .prepare(
        `SELECT c.id, b.approver, MIN(p.created) AS since,
           (SELECT q.problem FROM chat_part q WHERE q.provider = c.provider AND q.event = c.id AND q.state = 'pending' ORDER BY q.ordinal LIMIT 1) AS error
          FROM chat_event c JOIN chat_binding b ON b.provider = c.provider AND b.id = c.binding
          JOIN chat_part p ON p.provider = c.provider AND p.event = c.id AND p.state = 'pending'
         WHERE c.provider = :provider AND c.kind = 'message' AND c.state IN ('queued','running') AND (? IS NULL OR c.installation = ?) AND (? IS NULL OR b.approver = ?)
         GROUP BY c.id HAVING MIN(p.created) <= ? ORDER BY ${TELEGRAM_CONVERSATION_ORDER.replaceAll("e.", "c.")}`,
      )
      .all(botId, botId, approver, approver, since.toISOString())
      .map(row => ({ conversation: Number(String(row["id"]).slice(1)), approver: String(row["approver"]), since: String(row["since"]), error: row["error"] === null ? null : String(row["error"]) }));
  }

  /** Send unsent replies on the next bridge pass instead of waiting out their backoff; returns how many. */
  retryReplies(approver: string | null, now: Date): number {
    const { changes } = this
      .prepare(
        `UPDATE chat_event SET next_at = ?
          WHERE provider = :provider AND kind = 'message' AND state = 'queued'
            AND (? IS NULL OR binding IN (SELECT id FROM chat_binding WHERE provider = :provider AND approver = ?))
            AND EXISTS (SELECT 1 FROM chat_part p WHERE p.provider = chat_event.provider AND p.event = chat_event.id AND p.state = 'pending')`,
      )
      .run(now.toISOString(), approver, approver);
    return Number(changes);
  }

  /**
   * Persist the whole outbound half of a turn — every reply part and every
   * card, with the cards' tokens already minted — in one transaction, BEFORE
   * any send. Only the claim holder may, and only once: a row that already
   * has parts keeps them (a retry resumes, never re-plans). The turn's
   * identity rides the row too, so the parts answer to exactly that turn.
   */
  planReplyParts(
    id: number,
    owner: string,
    turn: { session: number; turn: number },
    parts: readonly TelegramConversationPartPlan[],
    now: Date,
  ): boolean {
    return this.store.transact(() => {
      const chat = this, stamp = now.toISOString(), event = `m${id}`;
      const held = chat
        .prepare("SELECT 1 AS hit FROM chat_event WHERE provider = :provider AND id = ? AND claim_owner = ? AND claim_until > ? AND state = 'running'")
        .get(event, owner, stamp);
      if (held === undefined) return false;
      const existing = chat.prepare("SELECT COUNT(*) AS n FROM chat_part WHERE provider = :provider AND event = ?").get(event);
      if (Number(existing?.["n"] ?? 0) > 0) return false;
      chat.prepare("UPDATE chat_event SET session = ?, turn = ? WHERE provider = :provider AND id = ?").run(turn.session, turn.turn, event);
      const insert = chat.prepare("INSERT INTO chat_part (provider, id, event, ordinal, payload, state, created) VALUES (:provider, ?, ?, ?, ?, 'pending', ?)");
      parts.forEach((part, ordinal) => {
        const content: ChatContent = part.kind === "image"
          ? { text: part.text, image: { taskId: part.taskId, run: part.run, artifact: part.artifact, sha256: part.sha256 } }
          : part.kind === "card"
            ? { text: part.text, proposal: part.proposal, ...(part.keyboard == null ? {} : { keyboard: part.keyboard }), card: true }
            : { text: part.text, ...(part.replyTo == null ? {} : { replyTo: part.replyTo }), ...(part.keyboard == null ? {} : { keyboard: part.keyboard }) };
        insert.run(chat.nextId("chat_part"), event, ordinal, savedChatPart(content), stamp);
      });
      return true;
    });
  }

  replyParts(conversation: number): TelegramConversationPart[] {
    return this
      .prepare(`SELECT p.*, EXISTS (SELECT 1 FROM mate_proposal mp WHERE mp.id = json_extract(p.payload, '$.proposal')) AS proposal_live
        FROM chat_part p WHERE p.provider = :provider AND p.event = ? ORDER BY p.ordinal`)
      .all(`m${conversation}`).map(row => readTelegramConversationPart(row, conversation));
  }

  /**
   * Settle one send attempt under the row's claim. A confirmed message id
   * is the only success: the part is sent, and a reply part's id becomes
   * the row's reply id. Anything else leaves the part pending with its
   * attempt counted, its error named, its next attempt scheduled, and —
   * when the answer was lost rather than refused — its uncertainty counted.
   * A lapsed claim settles nothing, so a reclaimer's outcome stands.
   */
  settleReplyPart(
    conversation: number,
    ordinal: number,
    owner: string,
    outcome: { ok: true; messageId: string } | { ok: false; error: string; uncertain: boolean; retryAt: string },
    now: Date,
  ): boolean {
    return this.store.transact(() => {
      const chat = this, stamp = now.toISOString(), event = `m${conversation}`;
      const held = chat
        .prepare("SELECT 1 AS hit FROM chat_event WHERE provider = :provider AND id = ? AND claim_owner = ? AND claim_until > ? AND state = 'running'")
        .get(event, owner, stamp);
      if (held === undefined) return false;
      const { changes } = outcome.ok
        ? chat
            .prepare(
              `UPDATE chat_part SET state = 'sent', message = ?, sent = ?, attempts = attempts + 1, next_at = NULL, problem = NULL
                WHERE provider = :provider AND event = ? AND ordinal = ? AND state = 'pending'`,
            )
            .run(outcome.messageId, stamp, event, ordinal)
        : chat
            .prepare(
              `UPDATE chat_part SET attempts = attempts + 1, uncertain = uncertain + ?, next_at = ?, problem = ?
                WHERE provider = :provider AND event = ? AND ordinal = ? AND state = 'pending'`,
            )
            .run(outcome.uncertain ? 1 : 0, outcome.retryAt, outcome.error, event, ordinal);
      if (Number(changes) !== 1) return false;
      if (outcome.ok) {
        const part = this.replyParts(conversation).find(one => one.ordinal === ordinal);
        if (part?.kind === "reply") chat.prepare("UPDATE chat_event SET reply = ? WHERE provider = :provider AND id = ?").run(outcome.messageId, event);
      }
      return true;
    });
  }

  /** A card whose proposal no longer waits (confirmed or dismissed from another surface, or gone) is moot: dropped with the reason, never sent. */
  dropReplyPart(conversation: number, ordinal: number, owner: string, reason: string, now: Date): boolean {
    const chat = this, stamp = now.toISOString(), event = `m${conversation}`;
    const held = chat
      .prepare("SELECT 1 AS hit FROM chat_event WHERE provider = :provider AND id = ? AND claim_owner = ? AND claim_until > ? AND state = 'running'")
      .get(event, owner, stamp);
    if (held === undefined) return false;
    const { changes } = chat
      .prepare("UPDATE chat_part SET state = 'dropped', problem = ?, next_at = NULL WHERE provider = :provider AND event = ? AND ordinal = ? AND state = 'pending'")
      .run(reason, event, ordinal);
    return Number(changes) === 1;
  }

  /** The exact task/run bindings of one outbound message this bot sent: a
   * plain fact names one, a digest part may name several, (v64) a confirmed
   * result image names its exact task and run, the lead's reply names the
   * task its turn was about, a card names its task, and (v79) a status
   * message names the task it showed. */
  messageBindings(binding: TelegramBinding, messageId: string): { taskId: string | null; taskRef: number | null; run: number | null; project: string | null }[] {
    const chat = this;
    const facts = chat
      .prepare(
        `SELECT DISTINCT task_id, task_ref, run, project FROM chat_message_ref
          WHERE provider = :provider AND kind = 'notification' AND binding = ? AND chat = ? AND message = ? ORDER BY notification`,
      )
      .all(binding.id, binding.chatId, messageId)
      .map(row => ({
        taskId: row["task_id"] === null ? null : String(row["task_id"]),
        taskRef: row["task_ref"] === null ? null : Number(row["task_ref"]),
        run: row["run"] === null ? null : (this.progressRun({ taskRef: row["task_ref"] === null ? null : Number(row["task_ref"]), run: Number(row["run"]) })?.id ?? Number(row["run"])),
        project: row["project"] === null ? null : String(row["project"]),
      }));
    // Every sent part of this bot's replies on that message, oldest first: images, the lead's replies and its cards.
    const parts = chat
      .prepare(
        `SELECT p.*, c.payload AS asked, EXISTS (SELECT 1 FROM mate_proposal mp WHERE mp.id = json_extract(p.payload, '$.proposal')) AS proposal_live
          FROM chat_part p JOIN chat_event c ON c.provider = p.provider AND c.id = p.event
          WHERE p.provider = :provider AND c.kind = 'message' AND c.binding = ? AND c.channel = ? AND p.message = ? AND p.state = 'sent'
          ORDER BY CAST(substr(p.event, 2) AS INTEGER), p.ordinal`,
      )
      .all(binding.id, binding.chatId, messageId)
      .map(row => ({ part: readTelegramConversationPart(row, Number(String(row["event"]).slice(1))), asked: readChatMessageBody(String(row["asked"])) }));
    const images = parts.filter(one => one.part.kind === "image").map(({ part }) => {
      const taskId = part.taskId!;
      const ref = this.store.lookupRef(taskId);
      return { taskId, taskRef: ref?.id ?? null, run: part.run!, project: ref?.repo ?? null };
    });
    // The lead's own messages: a reply from a turn that was about one task,
    // and a card, which names its task (or, once it filed one, the new task).
    const lead = parts.filter(one => one.part.kind !== "image").map(({ part, asked }) => part.kind === "card"
      ? proposalTaskOf(part.proposal === null ? null : this.store.getMateProposal(part.proposal))
      : asked.ok && asked.value.about !== undefined ? { task: asked.value.about.task, run: asked.value.about.run } : null);
    const shown = chat
      .prepare("SELECT task_id, run FROM chat_message_ref WHERE provider = :provider AND kind = 'task' AND binding = ? AND chat = ? AND message = ?")
      .all(binding.id, binding.chatId, messageId)
      .map(row => ({ task: String(row["task_id"]), run: row["run"] === null ? null : Number(row["run"]) }));
    const pointed = [...lead, ...shown].flatMap(one => {
      if (one === null) return [];
      const ref = this.store.lookupRef(one.task);
      return [{ taskId: one.task, taskRef: ref?.id ?? null, run: one.run, project: ref?.repo ?? null }];
    });
    return [...facts, ...images, ...pointed].filter((one, index, all) => all.findIndex(fact => fact.taskId === one.taskId && fact.taskRef === one.taskRef && fact.run === one.run && fact.project === one.project) === index);
  }

  createProposalAction(
    action: { token: string; binding: number; proposal: number; phase: TelegramProposalAction["phase"]; chatId: string; messageId?: string; ttlMs?: number },
    now: Date,
  ): void {
    this
      .prepare(
        `INSERT INTO chat_action (provider, token, binding, proposal, phase, chat, message, created, expires)
         VALUES (:provider, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.token, action.binding, action.proposal, action.phase, action.chatId, action.messageId ?? null, now.toISOString(),
        action.ttlMs === undefined ? null : new Date(now.getTime() + action.ttlMs).toISOString(),
      );
  }

  proposalAction(token: string): TelegramProposalAction | null {
    const row = this.prepare("SELECT * FROM chat_action WHERE provider = :provider AND token = ? AND proposal IS NOT NULL").get(token);
    return row === undefined ? null : readTelegramProposalAction(row);
  }

  /** Consume once. False means somebody already did, or it expired. */
  consumeProposalAction(token: string, now: Date): boolean {
    const stamp = now.toISOString();
    const { changes } = this
      .prepare("UPDATE chat_action SET consumed = ? WHERE provider = :provider AND token = ? AND proposal IS NOT NULL AND consumed IS NULL AND (expires IS NULL OR expires > ?)")
      .run(stamp, token, stamp);
    return Number(changes) > 0;
  }

  /** Kill every live token on a proposal — after it resolves, or when a challenge is cancelled. */
  consumeProposalActions(proposal: number, now: Date, phases?: readonly TelegramProposalAction["phase"][]): void {
    const filter = phases === undefined ? "" : ` AND phase IN (${phases.map(() => "?").join(",")})`;
    this
      .prepare(`UPDATE chat_action SET consumed = ? WHERE provider = :provider AND proposal = ? AND consumed IS NULL${filter}`)
      .run(now.toISOString(), proposal, ...(phases ?? []));
  }

  /** Stamp the message a card's keyboard actually landed on. */
  placeProposalActions(tokens: readonly string[], messageId: string): void {
    const place = this.prepare("UPDATE chat_action SET message = ? WHERE provider = :provider AND token = ?");
    for (const token of tokens) place.run(messageId, token);
  }

  destination(binding: TelegramBinding): string {
    return `telegram:${binding.botId}:${binding.chatId}:${binding.id}:${binding.approverGeneration}`;
  }

  /** A progress card belongs to one builder result, including its root review.
   * Do not combine planners, correction children, or separate build attempts. */
  progressRun(row: Pick<Notification, "taskRef" | "run">): Run | null {
    const source = row.run === null ? null : this.store.getRun(row.run);
    const result = source?.role === "reviewer" && source.reviewAttempt != null && source.parentRun !== null
      ? this.store.getRun(source.parentRun) : source;
    return result?.role === "builder" && result.taskRef === row.taskRef && source?.taskRef === row.taskRef ? result : null;
  }

  /** Reuse a confirmed message in this exact destination. A mixed digest,
   * decision, image, or message naming another attempt is never editable. The
   * outbound history survives a restart even if the final receipt was lost. */
  progressMessage(binding: TelegramBinding, result: Run): string | null {
    const chat = this, destination = this.destination(binding);
    const messages = chat.prepare(`SELECT DISTINCT message FROM chat_message_ref
      WHERE provider = :provider AND kind = 'notification' AND destination = ? AND task_ref = ? ORDER BY CAST(message AS INTEGER) DESC`)
      .all(destination, result.taskRef);
    for (const message of messages) {
      const rows = chat.prepare(`SELECT n.* FROM chat_message_ref m JOIN notification n ON n.id = m.notification
        WHERE m.provider = :provider AND m.kind = 'notification' AND m.destination = ? AND m.message = ?`).all(destination, String(message["message"]));
      if (rows.length > 0 && rows.every(raw => {
        const row = readNotification(raw);
        return isTelegramProgressNotification(row) && this.progressRun(row)?.id === result.id;
      })) return String(message["message"]);
    }
    return null;
  }

  /** The existing outbox, with a separate receipt for this exact pairing. */
  claimDeliveries(binding: TelegramBinding, owner: string, ttlMs: number, now: Date, only: "all" | "urgent" = "all"): TelegramDelivery[] {
    return this.store.transact(() => {
      const destination = this.destination(binding);
      this.db.prepare(`INSERT OR IGNORE INTO notification_delivery (notification, destination)
        SELECT id, ? FROM notification WHERE resolved_at IS NULL`).run(destination);
      // Someone else's notification is settled here as skipped, never sent —
      // and never left unsettled, where it would fence that task's later rows.
      this.db.prepare(`UPDATE notification_delivery SET receipt = '${TELEGRAM_SKIPPED_ELSEWHERE}'
        WHERE destination = ? AND delivered_at IS NULL AND receipt IS NULL
          AND notification IN (SELECT id FROM notification WHERE recipient IS NOT NULL AND recipient <> ?)`).run(destination, binding.approver);
      // A promise the lead made on another chat is reported there (lead-commitments.ts), not here.
      this.db.prepare(`UPDATE notification_delivery SET receipt = '${TELEGRAM_SKIPPED_OTHER_CHAT}'
        WHERE destination = ? AND delivered_at IS NULL AND receipt IS NULL
          AND notification IN (SELECT id FROM notification WHERE dedupe_key LIKE 'lead-promise:%' AND dedupe_key NOT LIKE 'lead-promise:telegram:%')`).run(destination);
      // Pings follow responsibility (the lead's work, this person's own act, a muted project): settled here, unsent.
      for (const raw of this.db.prepare(`SELECT n.* FROM notification n JOIN notification_delivery d ON d.notification = n.id AND d.destination = ?
          WHERE n.resolved_at IS NULL AND d.delivered_at IS NULL AND d.receipt IS NULL AND (d.claim_owner IS NULL OR d.claim_expires_at <= ?)`).all(destination, now.toISOString())) {
        const row = readNotification(raw);
        if (!this.store.pingAllowed(row, binding.approver)) {
          this.db.prepare(`UPDATE notification_delivery SET receipt = '${TELEGRAM_SKIPPED_QUIET}' WHERE notification = ? AND destination = ?`).run(row.id, destination);
        }
      }
      if (this.store.telegramRetryAt(binding.botId) > now.toISOString()) return [];
      const rows = this.db.prepare(`SELECT n.*, d.claim_generation FROM notification n
        JOIN notification_delivery d ON d.notification = n.id AND d.destination = ?
        WHERE n.resolved_at IS NULL AND ${TELEGRAM_UNSETTLED}
          AND (d.claim_owner IS NULL OR d.claim_expires_at <= ?)
          AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
          AND (? = 'all' OR d.attempts > 0 OR n.dedupe_key LIKE 'decision:%' OR n.push_class = 'attention' OR n.kind IN ('acceptance-evidence', 'acceptance-ready')
            OR EXISTS (SELECT 1 FROM notification urgent
              WHERE urgent.task_ref = n.task_ref AND urgent.id > n.id AND urgent.resolved_at IS NULL
                AND (urgent.dedupe_key LIKE 'decision:%' OR urgent.push_class = 'attention' OR urgent.kind IN ('acceptance-evidence', 'acceptance-ready'))))
        ORDER BY n.id`).all(destination, now.toISOString(), now.toISOString(), only);
      return rows.map(row => {
        this.db.prepare(`UPDATE notification_delivery SET claim_owner = ?, claim_expires_at = ?,
          claim_generation = claim_generation + 1 WHERE notification = ? AND destination = ?`)
          .run(owner, new Date(now.getTime() + ttlMs).toISOString(), Number(row["id"]), destination);
        return { ...readNotification(row), destination, claimGeneration: Number(row["claim_generation"]) + 1 };
      });
    });
  }

  /** Synchronous final fence, called AFTER each asynchronous enrollment read. */
  deliveryProblem(row: TelegramDelivery, binding: TelegramBinding, owner: string, projects: readonly string[], now: Date, batch: readonly number[] = [row.id]): string | null {
    const live = this.store.liveTelegramBindingById(binding.id);
    if (live === null || live.approverGeneration !== binding.approverGeneration ||
        this.store.accountOf(binding.approver)?.role !== "approver") return TELEGRAM_HOLD_REASONS.authority;
    if (row.destination !== this.destination(live)) return TELEGRAM_HOLD_REASONS.destination;
    if (!this.claimHeld(row, owner, now)) return TELEGRAM_HOLD_REASONS.claim;
    if (this.store.telegramRetryAt(binding.botId) > now.toISOString()) return TELEGRAM_HOLD_REASONS.rateLimit;
    const current = this.db.prepare("SELECT * FROM notification WHERE id = ?").get(row.id);
    if (current === undefined || current["resolved_at"] !== null) return TELEGRAM_HOLD_REASONS.resolved;
    if (row.scope === "unknown") return TELEGRAM_HOLD_REASONS.provenance;
    if (row.scope === "installation") {
      // One addressed to this person (their own budget, v105) reaches them; the rest of the installation's are an operator's.
      if (!this.store.isInstanceOperator(binding.approver) && current["recipient"] !== binding.approver) return TELEGRAM_HOLD_REASONS.installation;
    } else {
      if (row.project === null || !projects.includes(row.project) || !this.store.accountCanAccess(binding.approver, row.project)) return TELEGRAM_HOLD_REASONS.project;
      if (row.scope === "task") {
        const ref = this.db.prepare("SELECT repo, external_id FROM task_ref WHERE id = ?").get(row.taskRef);
        if (ref === undefined || ref["repo"] !== row.project || ref["external_id"] !== row.taskId ||
            (row.run !== null && this.store.getRun(row.run)?.taskRef !== row.taskRef)) return TELEGRAM_HOLD_REASONS.task;
      }
    }
    if (row.taskRef !== null) {
      // Skipped history never fences what follows it: it is settled.
      const earlier = this.db.prepare(`SELECT n.id FROM notification n
        LEFT JOIN notification_delivery d ON d.notification = n.id AND d.destination = ?
        WHERE n.task_ref = ? AND n.id < ? AND n.resolved_at IS NULL AND ${TELEGRAM_UNSETTLED}`)
        .all(row.destination, row.taskRef, row.id);
      if (earlier.some(one => !batch.includes(Number(one["id"])))) return TELEGRAM_HOLD_REASONS.order;
    }
    return null;
  }

  claimHeld(row: TelegramDelivery, owner: string, now: Date): boolean {
    return this.db.prepare(`SELECT 1 FROM notification_delivery WHERE notification = ? AND destination = ?
      AND claim_owner = ? AND claim_generation = ? AND claim_expires_at > ? AND delivered_at IS NULL`)
      .get(row.id, row.destination, owner, row.claimGeneration, now.toISOString()) !== undefined;
  }

  /** A confirmed network message remains history even if authority changed
   * while it was in flight. It only binds the OLD destination, never new work. */
  recordMessage(row: TelegramDelivery, binding: TelegramBinding, messageId: string, now: Date): void {
    if (row.destination !== this.destination(binding)) throw new Error("Telegram message destination mismatch");
    this.prepare(`INSERT OR IGNORE INTO chat_message_ref
      (provider, binding, chat, message, kind, notification, destination, project, task_ref, task_id, run, created)
      VALUES (:provider, ?, ?, ?, 'notification', ?, ?, ?, ?, ?, ?, ?)`)
      .run(binding.id, binding.chatId, messageId, row.id, row.destination, row.project, row.taskRef, row.taskId, row.run, now.toISOString());
  }

  /** The newest confirmed message this notification became at one destination, if any. */
  messageOf(notification: number, destination: string): string | null {
    const row = this.prepare("SELECT message FROM chat_message_ref WHERE provider = :provider AND kind = 'notification' AND notification = ? AND destination = ? ORDER BY CAST(message AS INTEGER) DESC LIMIT 1").get(notification, destination);
    return row === undefined ? null : String(row["message"]);
  }

  finalizeDelivery(row: TelegramDelivery, binding: TelegramBinding, owner: string,
    outcome: { ok: true; receipt: string | null } | { ok: false; error: string; retryAt?: string }, now: Date): boolean {
    return this.store.transact(() => {
      if (!this.claimHeld(row, owner, now) || row.destination !== this.destination(binding)) return false;
      if (outcome.ok && (this.store.liveTelegramBindingById(binding.id) === null || this.store.accountOf(binding.approver)?.role !== "approver")) return false;
      // A `skipped:` receipt settles the row without a delivery: nothing
      // reached the phone, so delivered_at stays empty exactly as it does
      // for the pairing skip (TELEGRAM_UNSETTLED treats both as settled).
      const skipped = outcome.ok && outcome.receipt !== null && outcome.receipt.startsWith("skipped:");
      this.db.prepare(`UPDATE notification_delivery SET attempts = attempts + 1, last_attempt_at = ?,
        delivered_at = ?, receipt = ?, last_error = ?, next_attempt_at = ?, claim_owner = NULL, claim_expires_at = NULL
        WHERE notification = ? AND destination = ? AND claim_owner = ? AND claim_generation = ?`)
        .run(now.toISOString(), outcome.ok && !skipped ? now.toISOString() : null, outcome.ok ? outcome.receipt : null,
          outcome.ok ? null : outcome.error, outcome.ok ? null : outcome.retryAt ?? new Date(now.getTime() + 1_000).toISOString(),
          row.id, row.destination, owner, row.claimGeneration);
      return true;
    });
  }

  /** The notifications this pairing holds, each with its delivery state there. */
  deliveries(binding: TelegramBinding): NotificationReceipt[] {
    return this.db.prepare(`SELECT n.*, d.attempts, d.last_attempt_at, d.last_error, d.delivered_at, d.receipt
      FROM notification n JOIN notification_delivery d ON d.notification = n.id WHERE d.destination = ? ORDER BY n.id`)
      .all(this.destination(binding)).map(readNotificationReceipt);
  }

  /** The digest cadence: null everyMs = off. */
  digest(): TelegramDigest {
    const row = this.prepare("SELECT every_ms, set_by, set_at, last_sent_at FROM chat_digest WHERE provider = :provider").get();
    return {
      everyMs: row?.["every_ms"] === null || row?.["every_ms"] === undefined ? null : Number(row["every_ms"]),
      setBy: row?.["set_by"] === null || row?.["set_by"] === undefined ? null : String(row["set_by"]),
      setAt: row?.["set_at"] === null || row?.["set_at"] === undefined ? null : String(row["set_at"]),
      lastSentAt: row?.["last_sent_at"] === null || row?.["last_sent_at"] === undefined ? null : String(row["last_sent_at"]),
    };
  }

  /** Set (or clear, with null) the cadence. Turning it on starts the
   * window NOW — nothing held before the choice is dumped at once. */
  setDigest(everyMs: number | null, by: string, now: Date): void {
    const chat = this;
    chat.prepare("INSERT OR IGNORE INTO chat_digest (provider) VALUES (:provider)").run();
    chat
      .prepare("UPDATE chat_digest SET every_ms = ?, set_by = ?, set_at = ?, last_sent_at = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(last_sent_at, ?) END WHERE provider = :provider")
      .run(everyMs, by, now.toISOString(), everyMs, now.toISOString());
  }

  markDigestSent(now: Date): void {
    const chat = this;
    chat.prepare("INSERT OR IGNORE INTO chat_digest (provider) VALUES (:provider)").run();
    chat.prepare("UPDATE chat_digest SET last_sent_at = ? WHERE provider = :provider").run(now.toISOString());
  }
}
