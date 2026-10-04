/** Durable private-chat receipts. Each transport has its own tables and lease. */
import { createHash, randomBytes } from "node:crypto";
import { MATE_ASK_TTL_MS, type Store } from "./store.js";

const CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_binding (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL,
 team TEXT NOT NULL, app TEXT NOT NULL, member TEXT NOT NULL, channel TEXT NOT NULL,
 approver TEXT NOT NULL, generation INTEGER NOT NULL, created TEXT NOT NULL, revoked TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_one_binding_member ON chat_binding(installation, member) WHERE revoked IS NULL;
CREATE TABLE IF NOT EXISTS chat_pair (
 hash TEXT PRIMARY KEY, installation TEXT NOT NULL, approver TEXT NOT NULL,
 generation INTEGER NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE IF NOT EXISTS chat_event (
 id TEXT PRIMARY KEY, installation TEXT NOT NULL, binding INTEGER REFERENCES chat_binding(id),
 kind TEXT NOT NULL CHECK(kind IN ('message','action','pair','notice')),
 channel TEXT NOT NULL, member TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT NOT NULL,
 payload TEXT NOT NULL, created TEXT NOT NULL,
 session INTEGER REFERENCES mate_session(id), state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','dropped')),
 next_at TEXT, problem TEXT
);
CREATE INDEX IF NOT EXISTS chat_pending_event ON chat_event(installation,state,next_at);
CREATE TABLE IF NOT EXISTS chat_part (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL REFERENCES chat_event(id), ordinal INTEGER NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','dropped')),
 message TEXT, file TEXT, uploaded INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 uncertain INTEGER NOT NULL DEFAULT 0, next_at TEXT, problem TEXT, created TEXT NOT NULL,
 UNIQUE(event,ordinal)
);
CREATE TABLE IF NOT EXISTS chat_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id),
 proposal INTEGER NOT NULL REFERENCES mate_proposal(id), phase TEXT NOT NULL CHECK(phase IN ('confirm','dismiss','yes','cancel')),
 expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE IF NOT EXISTS chat_progress (
 binding INTEGER NOT NULL REFERENCES chat_binding(id), run INTEGER NOT NULL REFERENCES run(id),
 part INTEGER NOT NULL REFERENCES chat_part(id), digest TEXT NOT NULL,
 PRIMARY KEY(binding,run)
);
CREATE TABLE IF NOT EXISTS chat_runtime (
 installation TEXT PRIMARY KEY, owner TEXT, lease_until TEXT, connected TEXT,
 problem TEXT, retry_at TEXT, notification INTEGER NOT NULL DEFAULT 0
);
`;
/** v73: a chat's place in the shared team conversations — a channel follows one
 * conversation, a DM may select one. Rows are revoked, never deleted. */
const CHAT_ROOM_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_room (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL, chat TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('group','private')), conversation TEXT NOT NULL,
 binding INTEGER NOT NULL REFERENCES chat_binding(id),
 bound_by TEXT NOT NULL, bound TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
 revoked TEXT, revoked_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_room_live ON chat_room(installation, chat) WHERE revoked IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_room_group ON chat_room(conversation) WHERE revoked IS NULL AND kind='group';
CREATE TABLE IF NOT EXISTS chat_meta (
 installation TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated TEXT NOT NULL,
 PRIMARY KEY(installation, key)
);
`;
/** v88: flow decisions in the chat app, as on Telegram (telegram-flow.ts).
 * A button is one opaque token for one visit (card, entry) of one card, on
 * the part it rides; Edit and Send back open a prompt the person's next
 * message in their DM answers. */
const CHAT_FLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_flow_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('approve','edit','send-back')), expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_flow_action_visit ON chat_flow_action(card, entry);
CREATE TABLE IF NOT EXISTS chat_flow_prompt (
 id INTEGER PRIMARY KEY AUTOINCREMENT, binding INTEGER NOT NULL REFERENCES chat_binding(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('edit','send-back')), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_flow_prompt_open ON chat_flow_prompt(binding, consumed);
`;
/** A flow's "Person chooses" zone in the chat app (flow-send.ts): one button per option (choice is its index, label its words
 * when sent) for one visit of one card, on the part it rides. A reply is the person's next message (chat_flow_prompt,
 * mode send-back). Never in CHAT_TABLES: an older database has no such table until this schema creates it. */
const CHAT_FLOW_CHOICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_flow_choice (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 choice INTEGER NOT NULL, label TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_flow_choice_visit ON chat_flow_choice(card, entry);
`;
/** v93: a teammate's question in the chat app. One button per option (choice)
 * and one to answer in words (choice NULL); that one opens a prompt the
 * person's next message in their DM answers. Never in CHAT_TABLES: an older
 * database has no such tables until this schema creates them. */
const CHAT_QUESTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_question_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id),
 question INTEGER NOT NULL REFERENCES teammate_question(id), choice TEXT, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_question_action_question ON chat_question_action(question);
CREATE TABLE IF NOT EXISTS chat_question_prompt (
 id INTEGER PRIMARY KEY AUTOINCREMENT, binding INTEGER NOT NULL REFERENCES chat_binding(id),
 question INTEGER NOT NULL REFERENCES teammate_question(id), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_question_prompt_open ON chat_question_prompt(binding, consumed);
`;
/** The lead's question to its owner (ask_owner) in the chat app: one button per option (choice is its index) and one for
 * "Something else" (choice NULL). A tap sends the option as the owner's next message. Never in CHAT_TABLES. */
const CHAT_ASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_ask_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id) ON DELETE CASCADE,
 turn INTEGER NOT NULL, choice INTEGER, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_ask_action_turn ON chat_ask_action(turn);
`;
const CHAT_TABLES = [
  "chat_binding",
  "chat_pair",
  "chat_event",
  "chat_part",
  "chat_action",
  "chat_progress",
  "chat_runtime",
] as const;
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
export type ChatContent = {
  text: string;
  /** Where the part is sent when not the binding's own DM: a room's channel. */
  channel?: string;
  proposal?: number;
  image?: { taskId: string; run: number; artifact: number; sha256: string };
  /** A screenshot sent with a result (result-shots.ts): it follows that result's message part, in its thread when
   * the app allows; a refused upload becomes one plain line, and one removed by retention goes quietly. */
  shot?: { follows: number | null };
  task?: string;
  run?: number;
  edit?: string;
  phase?: "armed";
  link?: { label: string; path: string };
  /** More link buttons after `link`: [Look first] beside [Merge] or [Accept and finish]. */
  also?: Array<{ label: string; path: string }>;
  /** A flow decision's buttons ride this part (v88): minted when it is planned. */
  flow?: { card: number; entry: number; actions: Array<"approve" | "edit" | "send-back"> };
  /** A flow's "Person chooses" buttons ride this part: minted when it is planned. */
  choose?: { card: number; entry: number; options: Array<{ choice: number; label: string }> };
  /** A teammate's question's buttons ride this part (v93): each option, then one to answer in words (choice null). */
  question?: { id: number; choices: Array<{ choice: string | null; label: string }> };
  /** The lead's question to its owner rides this part: its options, then "Something else". */
  ask?: { turn: number; options: string[] };
  /** The lead's own reply, already shaped (reply-shape.ts): the channel renders its bold anchors and labelled links in its own format. */
  voice?: true;
};
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
        /\bchat_(binding|pair|event|part|action|progress|runtime|room|meta|flow_action|flow_prompt|flow_choice|question_action|question_prompt|ask_action)\b/g,
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
  enqueue(event: Omit<ChatEvent, "session" | "state" | "next_at">): boolean {
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
          event.payload,
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
        ).run(event, ordinal, JSON.stringify(part), now.toISOString());
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

export const chatSchema = (channel: "slack" | "discord" | "teams"): string =>
  (CHAT_SCHEMA + CHAT_ROOM_SCHEMA + CHAT_FLOW_SCHEMA + CHAT_FLOW_CHOICE_SCHEMA + CHAT_QUESTION_SCHEMA + CHAT_ASK_SCHEMA).replaceAll("chat_", `${channel}_`);
export const chatTables = (channel: "slack" | "discord" | "teams"): string[] =>
  CHAT_TABLES.map((name) => name.replace("chat_", `${channel}_`));
export class ChatDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryMs = 5000,
    readonly uncertain = false,
  ) {
    super(code);
  }
}
