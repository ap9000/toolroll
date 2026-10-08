/** Durable chat receipts on the shared chat core: what each app's chats sent us and what we plan to send them. */
import { randomBytes } from "node:crypto";
import { MATE_ASK_TTL_MS } from "./store.js";
import { ChatCore, chatHash, type ChatBinding, type ChatProvider, type ChatRoom } from "./chat-core.js";
import { ChatMessages } from "./chat-messages.js";
import { readChatPart, savedChatEventBody, savedChatPart, type ChatContent, type ChatEventBody } from "./contracts/chat-content.js";

export { savedChatPart, chatHash, type ChatContent, type ChatEventBody, type ChatBinding, type ChatProvider, type ChatRoom };

export type ChatIdentity = {
  installation: string;
  team?: string;
  app: string;
  bot: string;
  workspace: string;
};
export type ChatEvent = {
  id: string;
  installation: string;
  binding: number | null;
  kind: "message" | "action" | "pair" | "notice";
  channel: string;
  member: string;
  ts: string;
  thread: string;
  payload: string;
  created: string;
  session: number | null;
  state: string;
  next_at: string | null;
};
export type ChatPart = {
  id: number;
  event: string;
  ordinal: number;
  payload: string;
  state: string;
  message: string | null;
  file: string | null;
  uploaded: number;
  attempts: number;
  uncertain: number;
  next_at: string | null;
  created: string;
};

const DAY_MS = 86_400_000;

/** One app's chats on the shared core (the same object Telegram's run on): its events, planned parts and their buttons. */
export class ChatState extends ChatMessages {
  constructor(store: ChatCore["store"], provider: ChatProvider) {
    super(store, provider);
  }

  /** Pair-time half kept for the settings pages: mint a code for this installation and return it (only its hash is kept). */
  pairing(installation: string, approver: string, generation: number, now = new Date()): string {
    const code = randomBytes(16).toString("hex");
    this.savePairing({ hash: chatHash(code), installation, approver, generation, by: approver }, now);
    return code;
  }

  /**
   * Consume a code sent in a chat (the shared rules, chat-core.ts). The installation's notice cursor starts from now
   * on its FIRST pairing; a later person joins the running cursor (their own history is fenced by their binding's
   * creation time).
   */
  pair(identity: ChatIdentity, hash: string, member: string, channel: string, now: Date, event: string | null = null): ChatBinding | null {
    return this.store.transact(() => {
      const paired = this.consumePairing({ hash, installation: identity.installation, team: identity.team ?? identity.app, app: identity.app, member, channel, event }, now);
      if (!paired.ok) return null;
      this.prepare("INSERT OR IGNORE INTO chat_runtime (provider, installation, notification) VALUES (:provider, ?, (SELECT COALESCE(MAX(id), 0) FROM notification))")
        .run(identity.installation);
      return paired.binding;
    });
  }

  /** The 60-second lease the Slack, Discord and Teams workers renew. */
  lease(installation: string, owner: string, now: Date): boolean {
    return this.acquire(installation, owner, 60_000, now).ok;
  }

  /** Save a received event with its body (contracts/chat-content.ts), versioned. False: it was already here. */
  enqueue(event: Omit<ChatEvent, "session" | "state" | "next_at" | "payload"> & { payload: ChatEventBody }): boolean {
    return Number(this.prepare(`INSERT OR IGNORE INTO chat_event (provider, id, installation, binding, kind, channel, member, ts, thread, payload, created)
      VALUES (:provider, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.installation, event.binding, event.kind, event.channel, event.member, event.ts, event.thread, savedChatEventBody(event.payload), event.created).changes) === 1;
  }

  event(id: string): ChatEvent | null {
    return (this.prepare("SELECT * FROM chat_event WHERE provider = :provider AND id = ?").get(id) as ChatEvent | undefined) ?? null;
  }

  next(installation: string, now: Date): ChatEvent | null {
    return (this.prepare(`SELECT * FROM chat_event WHERE provider = :provider AND installation = ? AND kind <> 'update' AND state = 'queued'
      AND (next_at IS NULL OR next_at <= ?) ORDER BY created, id LIMIT 1`).get(installation, now.toISOString()) as ChatEvent | undefined) ?? null;
  }

  defer(event: string, problem: string, until: Date): void {
    this.prepare("UPDATE chat_event SET next_at = ?, problem = ? WHERE provider = :provider AND id = ? AND state = 'queued'").run(until.toISOString(), problem, event);
  }

  finish(event: string, dropped = false): void {
    this.prepare("UPDATE chat_event SET state = ?, payload = '{}' WHERE provider = :provider AND id = ?").run(dropped ? "dropped" : "done", event);
  }

  /** Point an event at the binding its pairing made. */
  setEventBinding(event: string, binding: number): void {
    this.prepare("UPDATE chat_event SET binding = ? WHERE provider = :provider AND id = ?").run(binding, event);
  }

  part(id: number): ChatPart | null {
    return (this.prepare("SELECT * FROM chat_part WHERE provider = :provider AND id = ?").get(id) as ChatPart | undefined) ?? null;
  }

  /** The reply to an event, part by part, with each part's buttons minted with it; the event is then handled. Planned once. */
  plan(event: string, parts: ChatContent[], now: Date): void {
    this.store.transact(() => {
      for (const [ordinal, part] of parts.entries()) {
        if (this.prepare("SELECT 1 AS hit FROM chat_part WHERE provider = :provider AND event = ? AND ordinal = ?").get(event, ordinal) !== undefined) continue;
        const id = this.nextId("chat_part");
        this.prepare("INSERT INTO chat_part (provider, id, event, ordinal, payload, created) VALUES (:provider, ?, ?, ?, ?, ?)").run(id, event, ordinal, savedChatPart(part), now.toISOString());
        const token = () => randomBytes(16).toString("hex");
        if (part.proposal) this.tokens(id, part.proposal, ["confirm", "dismiss"], now);
        if (part.question)
          for (const one of part.question.choices)
            this.prepare("INSERT INTO chat_question_action (provider, token, part, question, choice, created, expires) VALUES (:provider, ?, ?, ?, ?, ?, ?)")
              .run(token(), id, part.question.id, one.choice, now.toISOString(), new Date(now.getTime() + 7 * DAY_MS).toISOString());
        if (part.ask)
          for (const choice of [...part.ask.options.map((_, index) => index), null])
            this.prepare("INSERT INTO chat_ask_action (provider, token, part, turn, choice, expires) VALUES (:provider, ?, ?, ?, ?, ?)")
              .run(token(), id, part.ask.turn, choice, new Date(now.getTime() + MATE_ASK_TTL_MS).toISOString());
        if (part.choose)
          for (const one of part.choose.options)
            this.prepare("INSERT INTO chat_flow_choice (provider, token, part, card, entry, choice, label, created, expires) VALUES (:provider, ?, ?, ?, ?, ?, ?, ?, ?)")
              .run(token(), id, part.choose.card, part.choose.entry, one.choice, one.label, now.toISOString(), new Date(now.getTime() + 7 * DAY_MS).toISOString());
        if (part.note)
          for (const answer of ["yes", "no"])
            this.prepare("INSERT INTO chat_flow_note (provider, token, part, card, entry, held, answer, expires) VALUES (:provider, ?, ?, ?, ?, ?, ?, ?)")
              .run(token(), id, part.note.card, part.note.entry, part.note.held, answer, new Date(now.getTime() + DAY_MS).toISOString());
        if (part.flow)
          for (const action of part.flow.actions)
            this.prepare("INSERT INTO chat_flow_action (provider, token, part, card, entry, action, created, expires) VALUES (:provider, ?, ?, ?, ?, ?, ?, ?)")
              .run(token(), id, part.flow.card, part.flow.entry, action, now.toISOString(), new Date(now.getTime() + 7 * DAY_MS).toISOString());
      }
      this.finish(event);
    });
  }

  /** A proposal card's buttons on its part: earlier ones on that part are spent. Yes and Cancel last ten minutes. */
  tokens(part: number, proposal: number, phases: Array<"confirm" | "dismiss" | "yes" | "cancel">, now: Date): void {
    this.prepare("UPDATE chat_action SET consumed = ? WHERE provider = :provider AND part = ? AND consumed IS NULL").run(now.toISOString(), part);
    for (const phase of phases)
      this.prepare("INSERT INTO chat_action (provider, token, part, proposal, phase, created, expires) VALUES (:provider, ?, ?, ?, ?, ?, ?)").run(
        randomBytes(16).toString("hex"), part, proposal, phase, now.toISOString(),
        new Date(now.getTime() + (phase === "yes" || phase === "cancel" ? 600_000 : DAY_MS)).toISOString(),
      );
  }

  /** A proposal card's live buttons on one part, in the order they were minted. */
  partTokens(part: number, now: Date): { token: string; phase: string }[] {
    return this.prepare("SELECT token, phase FROM chat_action WHERE provider = :provider AND part = ? AND consumed IS NULL AND expires > ? ORDER BY rowid")
      .all(part, now.toISOString()).map(row => ({ token: String(row["token"]), phase: String(row["phase"]) }));
  }

  // ---- sending, the same for every app's worker ----------------------------------------------------------------------

  /** The next part to send for an installation: notices only while notifications may go out. */
  nextPart(installation: string, notices: boolean, now: Date, order: "id" | "created" = "id"): ChatPart | null {
    return (this.prepare(`SELECT p.* FROM chat_part p JOIN chat_event e ON e.provider = p.provider AND e.id = p.event
      WHERE p.provider = :provider AND e.installation = ? AND p.state = 'pending' AND (e.kind <> 'notice' OR ? = 1)
        AND (p.next_at IS NULL OR p.next_at <= ?) ORDER BY ${order === "created" ? "p.created, " : ""}p.id LIMIT 1`)
      .get(installation, notices ? 1 : 0, now.toISOString()) as ChatPart | undefined) ?? null;
  }

  /** A part that will not go: why, in words the saved chat shows. */
  dropPart(id: number, problem: string): void {
    this.prepare("UPDATE chat_part SET state = 'dropped', next_at = NULL, problem = ? WHERE provider = :provider AND id = ?").run(problem, id);
  }

  /** Try again no earlier than then (a screenshot waiting for its result's message). */
  holdPart(id: number, until: string): void {
    this.prepare("UPDATE chat_part SET next_at = ? WHERE provider = :provider AND id = ?").run(until, id);
  }

  /** The app's upload identity for a part's file, and whether its bytes are up. */
  setPartFile(id: number, file: string | null, uploaded?: boolean, message?: string | null): void {
    if (message !== undefined) this.prepare("UPDATE chat_part SET message = ? WHERE provider = :provider AND id = ?").run(message, id);
    if (file !== null) this.prepare("UPDATE chat_part SET file = ? WHERE provider = :provider AND id = ?").run(file, id);
    if (uploaded !== undefined) this.prepare("UPDATE chat_part SET uploaded = ? WHERE provider = :provider AND id = ?").run(uploaded ? 1 : 0, id);
  }

  /**
   * Sent: on the app's own message id when it gave one (an uploaded file may not). A card's decide buttons
   * (chat-decide.ts) now ride that message, and any older ones on it stop working; a "What should change?" names it.
   */
  partSent(id: number, message: string | null, now: Date, attempt = true): void {
    this.store.transact(() => {
      this.prepare(`UPDATE chat_part SET state = 'sent', message = COALESCE(?, message), attempts = attempts + ?, problem = NULL, next_at = NULL, sent = ?
        WHERE provider = :provider AND id = ?`).run(message, attempt ? 1 : 0, now.toISOString(), id);
      const row = this.prepare(`SELECT p.payload, p.message, b.channel AS own FROM chat_part p JOIN chat_event e ON e.provider = p.provider AND e.id = p.event
        LEFT JOIN chat_binding b ON b.provider = e.provider AND b.id = e.binding WHERE p.provider = :provider AND p.id = ?`).get(id);
      const read = row === undefined ? null : readChatPart(String(row["payload"]));
      const placed = row?.["message"] == null ? null : String(row["message"]);
      if (read?.ok !== true || placed === null) return;
      const content = read.value, chat = content.channel ?? (row?.["own"] == null ? null : String(row["own"]));
      if (chat !== null) {
        // What the message shows now is all that acts on it: buttons it no longer shows stop working.
        const tokens = JSON.stringify((content.decide?.rows ?? []).flat().flatMap(one => "token" in one ? [one.token] : []));
        this.prepare(`UPDATE chat_decide_action SET consumed_at = ? WHERE channel = :provider AND chat = ? AND message = ? AND consumed_at IS NULL
          AND token NOT IN (SELECT value FROM json_each(?))`).run(now.toISOString(), chat, placed, tokens);
        if (content.decide !== undefined) this.prepare("UPDATE chat_decide_action SET message = ? WHERE channel = :provider AND message IS NULL AND token IN (SELECT value FROM json_each(?))").run(placed, tokens);
      }
      if (content.prompt !== undefined) this.prepare("UPDATE chat_decide_prompt SET message = ? WHERE channel = :provider AND id = ? AND message IS NULL").run(placed, content.prompt);
    });
  }

  /** Not sent this time: counted, named, and (when the answer was lost rather than refused) counted as uncertain. */
  partFailed(id: number, failure: { problem: string; until: string; uncertain: boolean }, giveUpAfter?: number): void {
    this.prepare(`UPDATE chat_part SET attempts = attempts + 1, uncertain = uncertain + ?, next_at = ?, problem = ?,
      state = CASE WHEN ? IS NOT NULL AND attempts >= ? THEN 'dropped' ELSE state END WHERE provider = :provider AND id = ?`)
      .run(failure.uncertain ? 1 : 0, failure.until, failure.problem, giveUpAfter ?? null, giveUpAfter ?? 0, id);
  }

  /** One person's replies still waiting to send, and those that could not be delivered (settings show both). */
  partCounts(binding: number): { pending: number; dropped: number } {
    const row = this.prepare(`SELECT SUM(p.state = 'pending') AS pending, SUM(p.state = 'dropped') AS dropped FROM chat_part p
      JOIN chat_event e ON e.provider = p.provider AND e.id = p.event WHERE p.provider = :provider AND e.binding = ?`).get(binding);
    return { pending: Number(row?.["pending"] ?? 0), dropped: Number(row?.["dropped"] ?? 0) };
  }

  /** Replace a part's content and send it again (a repaint after a tap). */
  repaint(id: number, content: ChatContent): void {
    this.prepare("UPDATE chat_part SET payload = ?, state = 'pending', next_at = NULL WHERE provider = :provider AND id = ?").run(savedChatPart(content), id);
  }
}

/** A saved part's content. One that can't be read is a delivery problem that names the field, never a guess. */
export function partContent(payload: string): ChatContent {
  const read = readChatPart(payload);
  if (!read.ok) throw new ChatDeliveryError(`This saved message can't be read: ${read.issues.map(issue => issue.line).join("; ")}`, 0, false, true);
  return read.value;
}
export class ChatDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryMs = 5000,
    readonly uncertain = false,
    readonly permanent = false,
  ) {
    super(code);
  }
}
