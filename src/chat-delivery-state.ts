/** Durable private-chat receipts. Each transport has its own tables and lease. */
import { createHash, randomBytes } from "node:crypto";
import { MATE_ASK_TTL_MS, type Store } from "./store.js";
import { chatSchema, chatTables } from "./contracts/chat-tables.js";
import { readChatPart, savedChatEventBody, savedChatPart, type ChatContent, type ChatEventBody } from "./contracts/chat-content.js";

export { savedChatPart, type ChatContent, type ChatEventBody };
export { chatSchema, chatTables };

export type ChatIdentity = {
  installation: string;
  team?: string;
  app: string;
  bot: string;
  workspace: string;
};
export type ChatBinding = {
  id: number;
  installation: string;
  team: string;
  app: string;
  member: string;
  channel: string;
  approver: string;
  generation: number;
  created: string;
  revoked: string | null;
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
export type ChatRoom = { id: number; installation: string; chat: string; kind: "group" | "private"; conversation: string; boundBy: string; binding: number; cursor: number };
export const chatHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export class ChatState {
  constructor(
    readonly store: Store,
    readonly channel: "slack" | "discord" | "teams",
  ) {}
  prepare(sql: string) {
    return this.db.prepare(
      sql.replace(
        /\bchat_(binding|pair|event|part|action|progress|runtime|room|meta|flow_action|flow_prompt|flow_choice|flow_note|question_action|question_prompt|ask_action)\b/g,
        `${this.channel}_$1`,
      ),
    );
  }
  /** Small transport facts a channel must remember per chat (a Teams service URL). Never credentials. */
  meta(installation: string, key: string): string | null {
    const row = this.prepare("SELECT value FROM chat_meta WHERE installation=? AND key=?").get(installation, key);
    return row === undefined ? null : String(row.value);
  }
  setMeta(installation: string, key: string, value: string, now: Date): void {
    this.prepare("INSERT INTO chat_meta(installation,key,value,updated) VALUES(?,?,?,?) ON CONFLICT(installation,key) DO UPDATE SET value=excluded.value,updated=excluded.updated").run(installation, key, value, now.toISOString());
  }
  // ---- rooms (v73) -----------------------------------------------------------
  private readRoom(row: Record<string, unknown>): ChatRoom {
    return { id: Number(row.id), installation: String(row.installation), chat: String(row.chat), kind: row.kind === "group" ? "group" : "private",
      conversation: String(row.conversation), boundBy: String(row.bound_by), binding: Number(row.binding), cursor: Number(row.cursor) };
  }
  room(installation: string, chat: string): ChatRoom | null {
    const row = this.prepare("SELECT * FROM chat_room WHERE installation=? AND chat=? AND revoked IS NULL").get(installation, chat);
    return row === undefined ? null : this.readRoom(row as Record<string, unknown>);
  }
  rooms(installation: string): ChatRoom[] {
    return (this.prepare("SELECT * FROM chat_room WHERE installation=? AND revoked IS NULL ORDER BY id").all(installation) as Record<string, unknown>[]).map(row => this.readRoom(row));
  }
  /** Point a chat at a conversation; an earlier choice for the same chat is revoked and delivery starts from now. */
  bindRoom(args: { installation: string; chat: string; kind: "group" | "private"; conversation: string; by: string; binding: number }, now: Date): { ok: true } | { ok: false; reason: "group-taken" } {
    return this.store.transact(() => {
      const stamp = now.toISOString();
      // Check the expected collision before revoking the current selection.
      if (args.kind === "group") {
        const group = this.prepare("SELECT installation, chat FROM chat_room WHERE conversation=? AND kind='group' AND revoked IS NULL").get(args.conversation);
        if (group !== undefined && (group.installation !== args.installation || group.chat !== args.chat)) return { ok: false as const, reason: "group-taken" as const };
      }
      this.prepare("UPDATE chat_room SET revoked=?,revoked_by=? WHERE installation=? AND chat=? AND revoked IS NULL").run(stamp, args.by, args.installation, args.chat);
      const thread = this.db.prepare("SELECT thread FROM team_conversation WHERE id=?").get(args.conversation);
      if (thread === undefined) throw new Error("no such team conversation");
      const cursor = Number(this.db.prepare("SELECT COALESCE(MAX(id),0) AS n FROM mate_message WHERE thread=?").get(Number(thread["thread"]))?.["n"] ?? 0);
      this.prepare("INSERT INTO chat_room(installation,chat,kind,conversation,binding,bound_by,bound,cursor) VALUES(?,?,?,?,?,?,?,?)").run(args.installation, args.chat, args.kind, args.conversation, args.binding, args.by, stamp, cursor);
      return { ok: true as const };
    });
  }
  unbindRoom(installation: string, chat: string, by: string, now: Date): boolean {
    return Number(this.prepare("UPDATE chat_room SET revoked=?,revoked_by=? WHERE installation=? AND chat=? AND revoked IS NULL").run(now.toISOString(), by, installation, chat).changes) > 0;
  }
  /** The shared rooms core's view of this installation's room records. */
  roomBackend(installation: string, now: Date): import("./chat-rooms.js").RoomBackend {
    const roomOf = (room: ChatRoom | null) => room === null ? null : { id: room.id, chatId: room.chat, kind: room.kind, conversation: room.conversation, boundBy: room.boundBy, binding: room.binding, cursor: room.cursor };
    return {
      room: chat => roomOf(this.room(installation, chat)),
      bind: args => this.bindRoom({ installation, chat: args.chatId, kind: args.kind, conversation: args.conversation, by: args.by, binding: args.binding }, now),
      unbind: (chat, by) => this.unbindRoom(installation, chat, by, now),
      grant: id => { const binding = this.bindingById(id); return binding === null || !this.live(binding) ? null : { approver: binding.approver, generation: binding.generation, chatId: binding.channel }; },
    };
  }
  advanceRoomCursor(id: number, messageId: number): boolean {
    return Number(this.prepare("UPDATE chat_room SET cursor=? WHERE id=? AND cursor<? AND revoked IS NULL").run(messageId, id, messageId).changes) > 0;
  }
  get db() {
    return this.store.handle;
  }
  /** Every unrevoked binding for an installation, oldest first: one per
   * paired person (v73). Liveness is checked per binding with `live`. */
  bindings(installation: string): ChatBinding[] {
    return this.prepare(
      "SELECT * FROM chat_binding WHERE installation=? AND revoked IS NULL ORDER BY id",
    ).all(installation) as ChatBinding[];
  }
  /** The unrevoked binding one channel member holds, if any. */
  bindingFor(installation: string, member: string): ChatBinding | null {
    return (
      (this.prepare(
        "SELECT * FROM chat_binding WHERE installation=? AND member=? AND revoked IS NULL",
      ).get(installation, member) as ChatBinding | undefined) ?? null
    );
  }
  bindingById(id: number): ChatBinding | null {
    return (
      (this.prepare("SELECT * FROM chat_binding WHERE id=? AND revoked IS NULL").get(id) as
        | ChatBinding
        | undefined) ?? null
    );
  }
  /** The oldest unrevoked binding — the single-person reading kept for
   * status lines and fixtures; inbound, delivery and notices read
   * `bindingFor` / `bindingById` / `bindings`. */
  binding(installation: string): ChatBinding | null {
    return this.bindings(installation)[0] ?? null;
  }
  live(binding: ChatBinding): boolean {
    const current = this.bindingById(binding.id);
    const account = this.store.accountOf(binding.approver);
    return (
      current !== null &&
      account?.role === "approver" &&
      account.revokedAt === null &&
      account.generation === binding.generation
    );
  }
  /** End one person's pairing and everything their chat could still do; teammates' bindings stay. */
  revokeBinding(binding: ChatBinding, now = new Date()): void {
    this.store.transact(() => {
      this.prepare("UPDATE chat_binding SET revoked=? WHERE id=? AND revoked IS NULL").run(now.toISOString(), binding.id);
      this.prepare(
        "UPDATE chat_event SET state='dropped',payload='{}',problem='Chat disconnected' WHERE binding=? AND state='queued'",
      ).run(binding.id);
      this.prepare(
        "UPDATE chat_part SET state='dropped',problem='Chat disconnected' WHERE state='pending' AND event IN (SELECT id FROM chat_event WHERE binding=?)",
      ).run(binding.id);
    });
  }
  revoke(installation: string, now = new Date()): void {
    this.store.transact(() => {
      this.prepare(
        "UPDATE chat_binding SET revoked=? WHERE installation=? AND revoked IS NULL",
      ).run(now.toISOString(), installation);
      this.prepare(
        "UPDATE chat_pair SET consumed=? WHERE installation=? AND consumed IS NULL",
      ).run(now.toISOString(), installation);
      this.prepare(
        "UPDATE chat_event SET state='dropped',payload='{}',problem='Chat disconnected' WHERE installation=? AND state='queued'",
      ).run(installation);
      this.prepare(
        "UPDATE chat_part SET state='dropped',problem='Chat disconnected' WHERE state='pending' AND event IN (SELECT id FROM chat_event WHERE installation=?)",
      ).run(installation);
    });
  }
  pairing(
    installation: string,
    approver: string,
    generation: number,
    now = new Date(),
  ): string {
    const code = randomBytes(16).toString("hex");
    this.store.transact(() => {
      // A fresh code replaces this person's outstanding ones; a teammate's pending code is theirs.
      this.prepare(
        "UPDATE chat_pair SET consumed=? WHERE installation=? AND approver=? AND consumed IS NULL",
      ).run(now.toISOString(), installation, approver);
      this.prepare("INSERT INTO chat_pair VALUES(?,?,?,?,?,NULL)").run(
        chatHash(code),
        installation,
        approver,
        generation,
        new Date(now.getTime() + 600_000).toISOString(),
      );
    });
    return code;
  }
  pair(
    identity: ChatIdentity,
    hash: string,
    member: string,
    channel: string,
    now: Date,
  ): ChatBinding | null {
    return this.store.transact(() => {
      const pair = this.prepare(
        "SELECT approver,generation FROM chat_pair WHERE hash=? AND installation=? AND consumed IS NULL AND expires>?",
      ).get(hash, identity.installation, now.toISOString());
      if (!pair) return null;
      // One binding per channel member, and one channel identity per person.
      if (this.bindingFor(identity.installation, member)) return null;
      if (this.bindings(identity.installation).some(one => one.approver === String(pair.approver) && this.live(one))) return null;
      const account = this.store.accountOf(String(pair.approver));
      if (
        account?.role !== "approver" ||
        account.revokedAt !== null ||
        account.generation !== Number(pair.generation)
      )
        return null;
      this.prepare("UPDATE chat_pair SET consumed=? WHERE hash=?").run(
        now.toISOString(),
        hash,
      );
      this.prepare(
        "INSERT INTO chat_binding(installation,team,app,member,channel,approver,generation,created) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        identity.installation,
        identity.team ?? identity.app,
        identity.app,
        member,
        channel,
        String(pair.approver),
        Number(pair.generation),
        now.toISOString(),
      );
      // The installation's notice cursor starts from now on its FIRST pairing;
      // a later person joins the running cursor (their own history is fenced
      // by their binding's creation time).
      this.prepare(
        "INSERT OR IGNORE INTO chat_runtime(installation, notification) VALUES(?, (SELECT COALESCE(MAX(id),0) FROM notification))",
      ).run(identity.installation);
      return this.bindingFor(identity.installation, member);
    });
  }
  /** Save a received event with its body (contracts/chat-content.ts), versioned. */
  enqueue(event: Omit<ChatEvent, "session" | "state" | "next_at" | "payload"> & { payload: ChatEventBody }): boolean {
    return (
      Number(
        this.prepare(
          "INSERT OR IGNORE INTO chat_event(id,installation,binding,kind,channel,member,ts,thread,payload,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
          event.id,
          event.installation,
          event.binding,
          event.kind,
          event.channel,
          event.member,
          event.ts,
          event.thread,
          savedChatEventBody(event.payload),
          event.created,
        ).changes,
      ) === 1
    );
  }
  event(id: string): ChatEvent | null {
    return (
      (this.prepare("SELECT * FROM chat_event WHERE id=?").get(id) as
        | ChatEvent
        | undefined) ?? null
    );
  }
  next(installation: string, now: Date): ChatEvent | null {
    return (
      (this.prepare(
        "SELECT * FROM chat_event WHERE installation=? AND state='queued' AND (next_at IS NULL OR next_at<=?) ORDER BY created,id LIMIT 1",
      ).get(installation, now.toISOString()) as ChatEvent | undefined) ?? null
    );
  }
  defer(event: string, problem: string, until: Date): void {
    this.prepare(
      "UPDATE chat_event SET next_at=?,problem=? WHERE id=? AND state='queued'",
    ).run(until.toISOString(), problem, event);
  }
  finish(event: string, dropped = false): void {
    this.prepare("UPDATE chat_event SET state=?,payload='{}' WHERE id=?").run(
      dropped ? "dropped" : "done",
      event,
    );
  }
  part(id: number): ChatPart | null {
    return (
      (this.prepare("SELECT * FROM chat_part WHERE id=?").get(id) as
        | ChatPart
        | undefined) ?? null
    );
  }
  plan(event: string, parts: ChatContent[], now: Date): void {
    this.store.transact(() => {
      for (const [ordinal, part] of parts.entries()) {
        const inserted = this.prepare(
          "INSERT OR IGNORE INTO chat_part(event,ordinal,payload,created) VALUES(?,?,?,?)",
        ).run(event, ordinal, savedChatPart(part), now.toISOString());
        if (Number(inserted.changes) && part.proposal)
          this.tokens(
            Number(inserted.lastInsertRowid),
            part.proposal,
            ["confirm", "dismiss"],
            now,
          );
        if (Number(inserted.changes) && part.question)
          for (const one of part.question.choices)
            this.prepare("INSERT INTO chat_question_action(token,part,question,choice,expires) VALUES(?,?,?,?,?)").run(
              randomBytes(16).toString("hex"), Number(inserted.lastInsertRowid), part.question.id, one.choice,
              new Date(now.getTime() + 7 * 86_400_000).toISOString());
        if (Number(inserted.changes) && part.ask)
          for (const choice of [...part.ask.options.map((_, index) => index), null])
            this.prepare("INSERT INTO chat_ask_action(token,part,turn,choice,expires) VALUES(?,?,?,?,?)").run(
              randomBytes(16).toString("hex"), Number(inserted.lastInsertRowid), part.ask.turn, choice,
              new Date(now.getTime() + MATE_ASK_TTL_MS).toISOString());
        if (Number(inserted.changes) && part.choose)
          for (const one of part.choose.options)
            this.prepare("INSERT INTO chat_flow_choice(token,part,card,entry,choice,label,expires) VALUES(?,?,?,?,?,?,?)").run(
              randomBytes(16).toString("hex"), Number(inserted.lastInsertRowid), part.choose.card, part.choose.entry, one.choice, one.label,
              new Date(now.getTime() + 7 * 86_400_000).toISOString());
        if (Number(inserted.changes) && part.note)
          for (const answer of ["yes", "no"])
            this.prepare("INSERT INTO chat_flow_note(token,part,card,entry,held,answer,expires) VALUES(?,?,?,?,?,?,?)").run(
              randomBytes(16).toString("hex"), Number(inserted.lastInsertRowid), part.note.card, part.note.entry, part.note.held, answer,
              new Date(now.getTime() + 86_400_000).toISOString());
        if (Number(inserted.changes) && part.flow)
          for (const action of part.flow.actions)
            this.prepare("INSERT INTO chat_flow_action(token,part,card,entry,action,expires) VALUES(?,?,?,?,?,?)").run(
              randomBytes(16).toString("hex"), Number(inserted.lastInsertRowid), part.flow.card, part.flow.entry, action,
              new Date(now.getTime() + 7 * 86_400_000).toISOString());
      }
      this.finish(event);
    });
  }
  tokens(
    part: number,
    proposal: number,
    phases: Array<"confirm" | "dismiss" | "yes" | "cancel">,
    now: Date,
  ): void {
    this.prepare(
      "UPDATE chat_action SET consumed=? WHERE part=? AND consumed IS NULL",
    ).run(now.toISOString(), part);
    for (const phase of phases)
      this.prepare("INSERT INTO chat_action VALUES(?,?,?,?,?,NULL)").run(
        randomBytes(16).toString("hex"),
        part,
        proposal,
        phase,
        new Date(
          now.getTime() +
            (phase === "yes" || phase === "cancel" ? 600_000 : 86_400_000),
        ).toISOString(),
      );
  }
  lease(installation: string, owner: string, now: Date): boolean {
    this.prepare(
      "INSERT OR IGNORE INTO chat_runtime(installation) VALUES(?)",
    ).run(installation);
    return (
      Number(
        this.prepare(
          "UPDATE chat_runtime SET owner=?,lease_until=? WHERE installation=? AND (owner=? OR lease_until IS NULL OR lease_until<=?)",
        ).run(
          owner,
          new Date(now.getTime() + 60_000).toISOString(),
          installation,
          owner,
          now.toISOString(),
        ).changes,
      ) === 1
    );
  }
  owns(installation: string, owner: string, now = new Date()): boolean {
    return !!this.prepare(
      "SELECT 1 FROM chat_runtime WHERE installation=? AND owner=? AND lease_until>?",
    ).get(installation, owner, now.toISOString());
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
