/**
 * The chat core every app shares (Telegram, Slack, Discord, Teams): who is paired, the one-time codes that pair
 * them, the rooms they follow, one live worker per installation, and the small facts a transport remembers. One
 * object is bound to one provider, and every query it runs names that provider (`:provider`), so an id or a member
 * from one app never reaches another app's rows. Adapters keep only their transport: sign-in, receiving (webhooks or
 * polling), formatting and sending.
 *
 * Imports the store's types only, so the store can build its Telegram methods on it.
 */
import { createHash } from "node:crypto";
import type { ChatProvider } from "./contracts/chat-tables.js";
import type { Database, Statement, Store } from "./store.js";

export type { ChatProvider };

/** One person's chat in one app (chat_binding). */
export type ChatBinding = {
  provider: ChatProvider;
  id: number;
  installation: string;
  team: string;
  app: string;
  member: string;
  channel: string;
  approver: string;
  generation: number;
  created: string;
  created_by: string | null;
  pair_event: string | null;
  revoked: string | null;
  revoked_by: string | null;
};
export type ChatRoom = { id: number; installation: string; chat: string; kind: "group" | "private"; conversation: string; boundBy: string; boundAt: string; binding: number; cursor: number };
export type PairingResult =
  | { ok: true; binding: ChatBinding; replay: boolean; first: boolean }
  | { ok: false; reason: "unknown-code" | "already-bound" };
export type LeaseResult = { ok: true; generation: number; cursor: number } | { ok: false; reason: "busy"; holder: string; until: string };

export const chatHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

/** Tables whose rows carry a per-provider number the core assigns. */
type Numbered = "chat_binding" | "chat_part" | "chat_room" | "chat_flow_prompt" | "chat_question_prompt" | "chat_note_draft";

const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

export function readChatBinding(row: Record<string, unknown>): ChatBinding {
  return {
    provider: String(row["provider"]) as ChatProvider, id: Number(row["id"]), installation: String(row["installation"]),
    team: String(row["team"]), app: String(row["app"]), member: String(row["member"]), channel: String(row["channel"]),
    approver: String(row["approver"]), generation: Number(row["generation"]), created: String(row["created"]),
    created_by: str(row["created_by"]), pair_event: str(row["pair_event"]), revoked: str(row["revoked"]), revoked_by: str(row["revoked_by"]),
  };
}

function readRoom(row: Record<string, unknown>): ChatRoom {
  return { id: Number(row["id"]), installation: String(row["installation"]), chat: String(row["chat"]), kind: row["kind"] === "group" ? "group" : "private",
    conversation: String(row["conversation"]), boundBy: String(row["bound_by"]), boundAt: String(row["bound"]), binding: Number(row["binding"]), cursor: Number(row["cursor"]) };
}

export class ChatCore {
  constructor(
    readonly store: Store,
    readonly provider: ChatProvider,
  ) {}

  get db(): Database {
    return this.store.handle;
  }

  /** A statement bound to this provider. Its SQL must name `:provider`; one that doesn't is refused before it runs. */
  prepare(sql: string): Statement {
    if (!/:provider\b/.test(sql)) throw new Error(`a chat query must name its provider: ${sql.slice(0, 80)}`);
    const statement = this.db.prepare(sql), bound = { provider: this.provider };
    return {
      run: (...params) => statement.run(bound, ...params),
      get: (...params) => statement.get(bound, ...params),
      all: (...params) => statement.all(bound, ...params),
    };
  }

  /** The next number in this provider's run of a table (rows keep the numbers they were given). */
  nextId(table: Numbered): number {
    return Number(this.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${table} WHERE provider = :provider`).get()?.["n"] ?? 1);
  }

  // ---- pairings ---------------------------------------------------------------------------------------------------

  /** Every unrevoked binding of an installation, oldest first (liveness is checked per binding with `live`). */
  bindings(installation: string): ChatBinding[] {
    return this.prepare("SELECT * FROM chat_binding WHERE provider = :provider AND installation = ? AND revoked IS NULL ORDER BY id")
      .all(installation).map(readChatBinding);
  }

  /** The unrevoked binding one member holds, if any. */
  bindingFor(installation: string, member: string): ChatBinding | null {
    const row = this.prepare("SELECT * FROM chat_binding WHERE provider = :provider AND installation = ? AND member = ? AND revoked IS NULL").get(installation, member);
    return row === undefined ? null : readChatBinding(row);
  }

  /** The exact binding, while unrevoked. */
  bindingById(id: number): ChatBinding | null {
    const row = this.prepare("SELECT * FROM chat_binding WHERE provider = :provider AND id = ? AND revoked IS NULL").get(id);
    return row === undefined ? null : readChatBinding(row);
  }

  /** The oldest unrevoked binding: the single-person reading kept for status lines and fixtures. */
  binding(installation: string): ChatBinding | null {
    return this.bindings(installation)[0] ?? null;
  }

  /** Unrevoked, and its person still an approver, unrevoked, at the generation it was paired under. */
  live(binding: Pick<ChatBinding, "id" | "approver" | "generation">): boolean {
    const current = this.bindingById(binding.id);
    const account = this.store.accountOf(binding.approver);
    return current !== null && current.approver === binding.approver && current.generation === binding.generation &&
      account?.role === "approver" && account.revokedAt === null && account.generation === binding.generation;
  }

  /** Every live binding of an installation, oldest first. */
  liveBindings(installation: string): ChatBinding[] {
    return this.bindings(installation).filter(binding => this.live(binding));
  }

  /** Mint-time half of pairing: a fresh code replaces this person's outstanding ones (a teammate's stay theirs). */
  savePairing(code: { hash: string; installation: string | null; approver: string; generation: number; by: string }, now: Date, ttlMs = PAIRING_CODE_TTL_MS): void {
    this.store.transact(() => {
      this.prepare("UPDATE chat_pair SET consumed = ? WHERE provider = :provider AND approver = ? AND consumed IS NULL").run(now.toISOString(), code.approver);
      this.prepare("INSERT INTO chat_pair (provider, hash, installation, approver, generation, created, created_by, expires) VALUES (:provider, ?, ?, ?, ?, ?, ?, ?)")
        .run(code.hash, code.installation, code.approver, code.generation, now.toISOString(), code.by, new Date(now.getTime() + ttlMs).toISOString());
    });
  }

  /**
   * Consume a code and create the binding, in one transaction, by the same rules in every app: the code is unexpired,
   * unconsumed and for this installation; its person is still an approver at the generation it was minted under; the
   * member holds no other live pairing here, and the person no other live pairing on this installation. The
   * conditional UPDATE is the consumption: exactly one caller wins however many race. The same event replayed (an app
   * redelivering) finds its finished binding. Success retires the person's other outstanding codes. `first`: the
   * member never paired with this installation before (a first pairing starts its notifications from now).
   */
  consumePairing(attempt: { hash: string; installation: string; team: string; app: string; member: string; channel: string; event: string | null }, now: Date): PairingResult {
    return this.store.transact(() => {
      const stamp = now.toISOString();
      const code = this.prepare("SELECT * FROM chat_pair WHERE provider = :provider AND hash = ?").get(attempt.hash);
      if (code === undefined || (code["installation"] !== null && code["installation"] !== attempt.installation)) return { ok: false as const, reason: "unknown-code" as const };
      if (code["consumed"] !== null) {
        const mine = attempt.event !== null && code["consumed_event"] === attempt.event && code["consumed_member"] === attempt.member && code["consumed_channel"] === attempt.channel;
        const live = mine ? this.bindingFor(attempt.installation, attempt.member) : null;
        return live !== null && live.channel === attempt.channel && this.live(live)
          ? { ok: true as const, binding: live, replay: true, first: false }
          : { ok: false as const, reason: "unknown-code" as const };
      }
      if (String(code["expires"]) <= stamp) return { ok: false as const, reason: "unknown-code" as const };
      const approver = String(code["approver"]), generation = Number(code["generation"]);
      const account = this.store.accountOf(approver);
      if (account?.role !== "approver" || account.revokedAt !== null || account.generation !== generation) return { ok: false as const, reason: "unknown-code" as const };
      if (this.bindingFor(attempt.installation, attempt.member) !== null) return { ok: false as const, reason: "already-bound" as const };
      if (this.bindings(attempt.installation).some(one => one.approver === approver && this.live(one))) return { ok: false as const, reason: "already-bound" as const };
      const consumed = this.prepare(`UPDATE chat_pair SET consumed = ?, consumed_channel = ?, consumed_member = ?, consumed_event = ?
        WHERE provider = :provider AND hash = ? AND consumed IS NULL AND expires > ?`).run(stamp, attempt.channel, attempt.member, attempt.event, attempt.hash, stamp);
      if (Number(consumed.changes) !== 1) return { ok: false as const, reason: "unknown-code" as const };
      this.prepare("UPDATE chat_pair SET consumed = ? WHERE provider = :provider AND approver = ? AND consumed IS NULL").run(stamp, approver);
      const first = this.prepare("SELECT 1 AS hit FROM chat_binding WHERE provider = :provider AND installation = ? AND member = ? LIMIT 1").get(attempt.installation, attempt.member) === undefined;
      const id = this.nextId("chat_binding");
      this.prepare(`INSERT INTO chat_binding (provider, id, installation, team, app, member, channel, approver, generation, created, created_by, pair_event)
        VALUES (:provider, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, attempt.installation, attempt.team, attempt.app, attempt.member, attempt.channel, approver, generation, stamp, approver, attempt.event);
      return { ok: true as const, binding: this.bindingById(id)!, replay: false, first };
    });
  }

  /** End one person's pairing and everything their chat could still do: its buttons, prompts, queued messages and unsent parts. */
  revokeBinding(binding: Pick<ChatBinding, "id">, now = new Date(), by: string | null = null): boolean {
    return this.store.transact(() => {
      const stamp = now.toISOString();
      const revoked = Number(this.prepare("UPDATE chat_binding SET revoked = ?, revoked_by = ? WHERE provider = :provider AND id = ? AND revoked IS NULL").run(stamp, by, binding.id).changes) > 0;
      this.prepare("UPDATE chat_action SET consumed = ? WHERE provider = :provider AND binding = ? AND consumed IS NULL").run(stamp, binding.id);
      for (const table of ["chat_flow_action", "chat_flow_choice", "chat_question_action"])
        this.prepare(`UPDATE ${table} SET consumed = ? WHERE provider = :provider AND binding = ? AND consumed IS NULL`).run(stamp, binding.id);
      for (const table of ["chat_flow_prompt", "chat_question_prompt"])
        this.prepare(`UPDATE ${table} SET consumed = ? WHERE provider = :provider AND binding = ? AND consumed IS NULL`).run(stamp, binding.id);
      this.prepare("UPDATE chat_event SET state = 'dropped', payload = '{}', problem = 'Chat disconnected', result = COALESCE(result, 'revoked') WHERE provider = :provider AND binding = ? AND state = 'queued'").run(binding.id);
      this.prepare(`UPDATE chat_part SET state = 'dropped', problem = 'Chat disconnected' WHERE provider = :provider AND state = 'pending'
        AND event IN (SELECT id FROM chat_event WHERE provider = :provider AND binding = ?)`).run(binding.id);
      return revoked;
    });
  }

  /** End every pairing of an installation (its app was disconnected), and every code still waiting for one. */
  revoke(installation: string, now = new Date(), by: string | null = null): void {
    this.store.transact(() => {
      for (const binding of this.bindings(installation)) this.revokeBinding(binding, now, by);
      this.prepare("UPDATE chat_pair SET consumed = ? WHERE provider = :provider AND (installation = ? OR installation IS NULL) AND consumed IS NULL").run(now.toISOString(), installation);
      this.prepare("UPDATE chat_event SET state = 'dropped', payload = '{}', problem = 'Chat disconnected', result = COALESCE(result, 'revoked') WHERE provider = :provider AND installation = ? AND state = 'queued' AND kind <> 'update'").run(installation);
      this.prepare(`UPDATE chat_part SET state = 'dropped', problem = 'Chat disconnected' WHERE provider = :provider AND state = 'pending'
        AND event IN (SELECT id FROM chat_event WHERE provider = :provider AND installation = ?)`).run(installation);
    });
  }

  // ---- rooms (team conversations) ---------------------------------------------------------------------------------

  room(installation: string, chat: string): ChatRoom | null {
    const row = this.prepare("SELECT * FROM chat_room WHERE provider = :provider AND installation = ? AND chat = ? AND revoked IS NULL").get(installation, chat);
    return row === undefined ? null : readRoom(row);
  }

  rooms(installation: string): ChatRoom[] {
    return this.prepare("SELECT * FROM chat_room WHERE provider = :provider AND installation = ? AND revoked IS NULL ORDER BY id").all(installation).map(readRoom);
  }

  /**
   * Point a chat at a team conversation: an earlier choice for the same chat is revoked in the same transaction, and
   * delivery starts from now (the conversation's history is read in the console, never replayed into a chat that
   * just arrived). A conversation another group of this app already follows refuses.
   */
  bindRoom(args: { installation: string; chat: string; kind: "group" | "private"; conversation: string; by: string; binding: number }, now: Date): { ok: true; room: ChatRoom } | { ok: false; reason: "group-taken" } {
    return this.store.transact(() => this.store.savepoint(() => {
      const stamp = now.toISOString();
      if (args.kind === "group") {
        const group = this.prepare("SELECT installation, chat FROM chat_room WHERE provider = :provider AND conversation = ? AND kind = 'group' AND revoked IS NULL").get(args.conversation);
        if (group !== undefined && (group["installation"] !== args.installation || group["chat"] !== args.chat)) return { ok: false as const, reason: "group-taken" as const };
      }
      this.prepare("UPDATE chat_room SET revoked = ?, revoked_by = ? WHERE provider = :provider AND installation = ? AND chat = ? AND revoked IS NULL").run(stamp, args.by, args.installation, args.chat);
      const thread = this.db.prepare("SELECT thread FROM team_conversation WHERE id = ?").get(args.conversation);
      if (thread === undefined) throw new Error("no such team conversation");
      const cursor = Number(this.db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM mate_message WHERE thread = ?").get(Number(thread["thread"]))?.["n"] ?? 0);
      this.prepare("INSERT INTO chat_room (provider, id, installation, chat, kind, conversation, binding, bound_by, bound, cursor) VALUES (:provider, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.nextId("chat_room"), args.installation, args.chat, args.kind, args.conversation, args.binding, args.by, stamp, cursor);
      return { ok: true as const, room: this.room(args.installation, args.chat)! };
    }));
  }

  unbindRoom(installation: string, chat: string, by: string, now: Date): boolean {
    return Number(this.prepare("UPDATE chat_room SET revoked = ?, revoked_by = ? WHERE provider = :provider AND installation = ? AND chat = ? AND revoked IS NULL").run(now.toISOString(), by, installation, chat).changes) > 0;
  }

  /** Forward only: a cursor never moves back, and a revoked room keeps its last position. */
  advanceRoomCursor(id: number, messageId: number): boolean {
    return Number(this.prepare("UPDATE chat_room SET cursor = ? WHERE provider = :provider AND id = ? AND cursor < ? AND revoked IS NULL").run(messageId, id, messageId).changes) > 0;
  }

  /** The shared rooms engine's view of this installation's rooms (chat-rooms.ts). */
  roomBackend(installation: string, now: Date): import("./chat-rooms.js").RoomBackend {
    const roomOf = (room: ChatRoom | null) => room === null ? null : { id: room.id, chatId: room.chat, kind: room.kind, conversation: room.conversation, boundBy: room.boundBy, binding: room.binding, cursor: room.cursor };
    return {
      room: chat => roomOf(this.room(installation, chat)),
      bind: args => {
        const bound = this.bindRoom({ installation, chat: args.chatId, kind: args.kind, conversation: args.conversation, by: args.by, binding: args.binding }, now);
        return bound.ok ? { ok: true } : bound;
      },
      unbind: (chat, by) => this.unbindRoom(installation, chat, by, now),
      grant: id => { const binding = this.bindingById(id); return binding === null || !this.live(binding) ? null : { approver: binding.approver, generation: binding.generation, chatId: binding.channel }; },
    };
  }

  // ---- the worker -------------------------------------------------------------------------------------------------

  /**
   * Take or renew the installation's one worker lease. A holder renews at its generation; an expired holder is taken
   * over at the next generation, and the poll cursor rides the lease, so a stale generation can neither poll nor move it.
   */
  acquire(installation: string, owner: string, ttlMs: number, now: Date): LeaseResult {
    return this.store.transact(() => {
      const stamp = now.toISOString(), until = new Date(now.getTime() + ttlMs).toISOString();
      const row = this.prepare("SELECT * FROM chat_runtime WHERE provider = :provider AND installation = ?").get(installation);
      if (row === undefined) {
        this.prepare("INSERT INTO chat_runtime (provider, installation, owner, lease_until, generation, heartbeat) VALUES (:provider, ?, ?, ?, 1, ?)").run(installation, owner, until, stamp);
        return { ok: true as const, generation: 1, cursor: 0 };
      }
      const holder = str(row["owner"]), held = holder !== null && str(row["lease_until"]) !== null && String(row["lease_until"]) > stamp;
      if (held && holder !== owner) return { ok: false as const, reason: "busy" as const, holder: holder!, until: String(row["lease_until"]) };
      const generation = held ? Number(row["generation"]) : Number(row["generation"]) + 1;
      this.prepare("UPDATE chat_runtime SET owner = ?, lease_until = ?, generation = ?, heartbeat = ? WHERE provider = :provider AND installation = ?").run(owner, until, generation, stamp, installation);
      return { ok: true as const, generation, cursor: Number(row["cursor"]) };
    });
  }

  /** Hand the lease back (it ends now), so the next worker is not told busy for the rest of its time. */
  release(installation: string, owner: string, now: Date): void {
    this.prepare("UPDATE chat_runtime SET lease_until = ? WHERE provider = :provider AND installation = ? AND owner = ?").run(now.toISOString(), installation, owner);
  }

  owns(installation: string, owner: string, now = new Date()): boolean {
    return this.prepare("SELECT 1 AS hit FROM chat_runtime WHERE provider = :provider AND installation = ? AND owner = ? AND lease_until > ?").get(installation, owner, now.toISOString()) !== undefined;
  }

  /** The poll cursor moves forward only, and only under the generation that read it. */
  advanceCursor(installation: string, owner: string, generation: number, cursor: number, now: Date): boolean {
    return Number(this.prepare(`UPDATE chat_runtime SET cursor = ?, heartbeat = ? WHERE provider = :provider AND installation = ? AND owner = ? AND generation = ? AND cursor < ?`)
      .run(cursor, now.toISOString(), installation, owner, generation, cursor).changes) > 0;
  }

  /** When the app said to wait (a rate limit): "" when it hasn't. */
  retryAt(installation: string): string {
    return String(this.prepare("SELECT retry_at FROM chat_runtime WHERE provider = :provider AND installation = ?").get(installation)?.["retry_at"] ?? "");
  }

  /** Wait at least until then before the next send; a later wait already asked for stands. */
  deferUntil(installation: string, until: string): void {
    this.prepare(`INSERT INTO chat_runtime (provider, installation, retry_at) VALUES (:provider, ?, ?)
      ON CONFLICT (provider, installation) DO UPDATE SET retry_at = CASE WHEN retry_at IS NULL OR retry_at < excluded.retry_at THEN excluded.retry_at ELSE retry_at END`).run(installation, until);
  }

  /** What is wrong with the connection right now (null: nothing), as the lease holder last saw it. */
  setProblem(installation: string, owner: string, problem: string | null): void {
    this.prepare("UPDATE chat_runtime SET problem = ? WHERE provider = :provider AND installation = ? AND owner = ?").run(problem, installation, owner);
  }

  /** The worker reached the app. */
  setConnected(installation: string, owner: string, now: Date): void {
    this.prepare("UPDATE chat_runtime SET connected = ?, problem = NULL WHERE provider = :provider AND installation = ? AND owner = ?").run(now.toISOString(), installation, owner);
  }

  /** The worker stopped: no holder, no connection. */
  stop(installation: string, owner: string): void {
    this.prepare("UPDATE chat_runtime SET owner = NULL, lease_until = NULL, connected = NULL WHERE provider = :provider AND installation = ? AND owner = ?").run(installation, owner);
  }

  /** The connection as settings show it. */
  runtime(installation: string): { connected: string | null; problem: string | null; leaseUntil: string | null } | null {
    const row = this.prepare("SELECT connected, problem, lease_until FROM chat_runtime WHERE provider = :provider AND installation = ?").get(installation);
    return row === undefined ? null : { connected: str(row["connected"]), problem: str(row["problem"]), leaseUntil: str(row["lease_until"]) };
  }

  /** Where the app pushes this installation's updates (null: the worker asks for them), and what's wrong, if anything. */
  setPush(installation: string, push: { url: string | null; problem: string | null }, now: Date): void {
    this.prepare("UPDATE chat_runtime SET push_url = ?, push_problem = ?, push_at = ? WHERE provider = :provider AND installation = ?").run(push.url, push.problem, now.toISOString(), installation);
  }

  push(installation: string): { url: string | null; problem: string | null; at: string | null } | null {
    const row = this.prepare("SELECT push_url, push_problem, push_at, owner FROM chat_runtime WHERE provider = :provider AND installation = ?").get(installation);
    return row === undefined || row["owner"] === null && row["push_at"] === null ? null : { url: str(row["push_url"]), problem: str(row["push_problem"]), at: str(row["push_at"]) };
  }

  // ---- small facts ------------------------------------------------------------------------------------------------

  /** Small transport facts an app must remember per chat (a Teams service URL). Never credentials. */
  meta(installation: string, key: string): string | null {
    return str(this.prepare("SELECT value FROM chat_meta WHERE provider = :provider AND installation = ? AND key = ?").get(installation, key)?.["value"]);
  }

  setMeta(installation: string, key: string, value: string, now: Date): void {
    this.prepare(`INSERT INTO chat_meta (provider, installation, key, value, updated) VALUES (:provider, ?, ?, ?, ?)
      ON CONFLICT (provider, installation, key) DO UPDATE SET value = excluded.value, updated = excluded.updated`).run(installation, key, value, now.toISOString());
  }
}
