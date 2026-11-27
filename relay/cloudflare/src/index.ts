/**
 * The hosted Toolroll companion relay: a Cloudflare Worker routing to one Durable Object per machine, with the
 * WebSocket Hibernation API. It implements relay/PROTOCOL.md exactly as the Node reference relay
 * (src/companion/relay-server.ts) does; relay/conformance/suite.ts runs against both.
 *
 * It holds no Noise keys and never sees plaintext. State that must survive the object being evicted between events
 * lives in SQLite (the machine, admitted devices, tombstones, used token ids) or in each socket's attachment (its
 * deadlines and rate buckets); memory is only a cache of the attachments.
 */

import { DurableObject } from "cloudflare:workers";
import {
  bucketTake,
  challengeValid,
  checkClaims,
  CLOSE,
  deriveMachineId,
  ENVELOPE_HEADER_BYTES,
  encodeEnvelope,
  fromB64Url,
  fullBucket,
  HEARTBEAT_PAYLOAD_BYTES,
  ID,
  jsonBytes,
  jsonResponse,
  LIMITS,
  MAX_DAEMON_FRAME_BYTES,
  MAX_NOISE_MESSAGE_BYTES,
  maxUses,
  mintChallenge,
  principalOf,
  OP,
  parseToken,
  rateKeyOf,
  readJsonObject,
  refusalResponse,
  relayKeyOrNull,
  socketDeadline,
  timingFrom,
  toB64Url,
  verifyEd25519,
  type BucketState,
  type ParsedToken,
  type Refusal,
  type Role,
  type Timing,
  type TokenUse,
} from "./contract.js";

export interface Env {
  MACHINE_ROOM: DurableObjectNamespace;
  /** Per client address: challenges and registrations. */
  RL_REGISTER?: RateLimit;
  /** Per machine + client address: WebSocket connects and admission calls. */
  RL_CONNECT?: RateLimit;
  /** Per client address across every machine: checked first on connects and admission calls, before any Durable
   * Object is touched (varying the machine id can't escape RL_CONNECT). */
  RL_CLIENT?: RateLimit;
  /** The relay's public host: token `aud` and the registration signature's host. Required. */
  RELAY_PUBLIC_HOST?: string;
  /** HMAC keys for registration challenges (`wrangler secret put CHALLENGE_SECRET`); the previous one is accepted
   * while rotating. */
  CHALLENGE_SECRET?: string;
  CHALLENGE_SECRET_PREVIOUS?: string;
  /** The deployed commit, shown by /v1/health (`npm run relay:deploy` sets it). */
  BUILD_ID?: string;
  /** Tests only: shorter deadlines (an override can never lengthen one). */
  RELAY_PHONE_FIRST_FRAME_MS?: string;
  RELAY_PHONE_IDLE_MS?: string;
  RELAY_DAEMON_SILENCE_MS?: string;
}

/** One structured log line (Workers Logs). Never tokens, keys, challenges or full ids. */
function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/** A short prefix of a machine id: enough to correlate lines, not the id. */
function machineTag(machineId: string): string {
  return machineId.slice(0, 6);
}

function refuse(route: string, refusal: Refusal, extra: Record<string, unknown> = {}): Response {
  log({ event: "refusal", route, status: refusal.status, code: refusal.code, ...extra });
  return refusalResponse(refusal);
}

function publicHostOf(env: Env): string {
  return (env.RELAY_PUBLIC_HOST ?? "").trim().toLowerCase();
}

function challengeSecrets(env: Env): string[] {
  return [env.CHALLENGE_SECRET, env.CHALLENGE_SECRET_PREVIOUS].filter((one): one is string => typeof one === "string" && one.length >= 32);
}

function routeOf(path: string): string {
  return path.startsWith("/v1/machines/")
    ? path.replace(/^\/v1\/machines\/[^/]+/, "/v1/machines/:id").replace(/\/devices\/[^/]+$/, "/devices/:id")
    : path;
}

async function limited(binding: RateLimit | undefined, key: string): Promise<boolean> {
  return binding !== undefined && !(await binding.limit({ key })).success;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const route = routeOf(path);
    const configured = { challengeSecret: challengeSecrets(env).length > 0, publicHost: publicHostOf(env).length > 0, rateLimits: env.RL_REGISTER !== undefined && env.RL_CONNECT !== undefined && env.RL_CLIENT !== undefined };

    if (request.method === "GET" && path === "/v1/health") {
      const ok = configured.challengeSecret && configured.publicHost;
      const body = { ok, version: 1, runtime: "cloudflare-do", build: env.BUILD_ID ?? "dev", configured };
      if (!ok) {
        return new Response(JSON.stringify(body), {
          status: 503,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return jsonResponse(200, body);
    }
    // Misconfigured (no public host): nothing can verify, so everything waits (health above says why).
    if (!configured.publicHost) return refuse(route, { status: 429, code: "rate_limited", retryAfterSec: 60 });
    const client = rateKeyOf(request.headers.get("cf-connecting-ip"));

    if (request.method === "POST" && (path === "/v1/challenge" || path === "/v1/machines/register")) {
      if (await limited(env.RL_REGISTER, client)) return refuse(route, { status: 429, code: "rate_limited", retryAfterSec: 60 });
      const secrets = challengeSecrets(env);
      if (secrets.length === 0) return refuse(route, { status: 429, code: "rate_limited", retryAfterSec: 60 });
      if (path === "/v1/challenge") {
        return jsonResponse(200, { challenge: await mintChallenge(secrets[0]!, Date.now()), expiresInSec: LIMITS.challengeTtlMs / 1000 });
      }
      const body = await readJsonObject(request, LIMITS.registerBodyBytes);
      const pub = relayKeyOrNull(body?.["relayMachinePub"]);
      const challenge = body?.["challenge"], signature = body?.["signature"];
      if (pub === null || typeof challenge !== "string" || typeof signature !== "string") return refuse(route, { status: 400, code: "bad_request" });
      if (!(await challengeValid(secrets, challenge, Date.now()))) return refuse(route, { status: 401, code: "token_invalid" });
      let sig: Uint8Array;
      try { sig = fromB64Url(signature); } catch { return refuse(route, { status: 400, code: "bad_request" }); }
      const popMsg = new TextEncoder().encode(`register\0${publicHostOf(env)}\0${challenge}`);
      if (!(await verifyEd25519(pub, popMsg, sig))) return refuse(route, { status: 401, code: "token_invalid" });
      const machineId = await deriveMachineId(pub);
      return env.MACHINE_ROOM.get(env.MACHINE_ROOM.idFromName(machineId)).fetch("https://room/internal/register", {
        method: "POST",
        body: JSON.stringify({ machineId, relayMachinePub: toB64Url(pub) }),
      });
    }

    const machineMatch = /^\/v1\/machines\/([a-z2-7]{26})(\/devices(?:\/([^/]*))?)?$/.exec(path);
    if (machineMatch !== null) {
      const devicesPath = machineMatch[2] !== undefined;
      const shapeOk = !devicesPath ? request.method === "DELETE"
        : machineMatch[3] === undefined ? request.method === "PUT" || request.method === "POST"
          : request.method === "DELETE";
      if (!shapeOk) return refuse(route, { status: 400, code: "bad_request" });
      const machineId = machineMatch[1]!;
      if (await limited(env.RL_CLIENT, client)) return refuse(route, { status: 429, code: "rate_limited", retryAfterSec: 60 });
      if (await limited(env.RL_CONNECT, `${machineId}|${client}`)) return refuse(route, { status: 429, code: "rate_limited", retryAfterSec: 60 }, { machine: machineTag(machineId) });
      return env.MACHINE_ROOM.get(env.MACHINE_ROOM.idFromName(machineId)).fetch(request);
    }

    if (path === "/v1/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return refuse(route, { status: 400, code: "bad_request" });
      if (await limited(env.RL_CLIENT, client)) return refuse(route, { status: 429, code: "rate_limited", retryAfterSec: 60 });
      const auth = request.headers.get("authorization") ?? "";
      const parsed = auth.startsWith("Bearer ") ? parseToken(auth.slice(7).trim()) : null;
      if (parsed === null) return refuse(route, { status: 401, code: "token_invalid" });
      if (await limited(env.RL_CONNECT, `${parsed.machineId}|${client}`)) {
        return refuse(route, { status: 429, code: "rate_limited", retryAfterSec: 60 }, { role: parsed.role, machine: machineTag(parsed.machineId) });
      }
      return env.MACHINE_ROOM.get(env.MACHINE_ROOM.idFromName(parsed.machineId)).fetch(request);
    }

    return refuse(route, { status: 400, code: "bad_request" });
  },
};

// ---- The machine room ----

interface Attachment {
  role: Role;
  /** Phones: their connId (never reused while the room exists). Daemon: 0. */
  connId: number;
  /** Daemon: its epoch. Phones: the epoch of the daemon they were admitted under. */
  epoch: number;
  peerId: string;
  openedAt: number;
  /** Phones: first frame (0 = none yet). */
  firstAt: number;
  /** Last frame in either direction (phones) or from the daemon; at most FLUSH_MS behind memory. */
  lastAt: number;
  /** The relay or the daemon closed it: later frames are dropped and no (second) PEER_CLOSE goes out. */
  closed: boolean;
  /** Phones: up frames, up bytes, down bytes. */
  buckets?: [BucketState, BucketState, BucketState];
}

interface MachineRow extends Record<string, SqlStorageValue> { machine_id: string; pub: string; last_daemon_at: number; next_conn_id: number; epoch: number }
interface KeyRow extends Record<string, SqlStorageValue> { pub: string }

/** How stale an attachment's lastAt / buckets may get before they are written back (no storage is involved). */
const FLUSH_MS = 1_000;
/** last_daemon_at is a storage write: refresh it at most daily (it only drives the 90-day room GC). */
const DAEMON_SEEN_WRITE_MS = 24 * 60 * 60 * 1000;
const OPEN = 1;

function attachmentOf(ws: WebSocket): Attachment | null {
  try { return ws.deserializeAttachment() as Attachment | null; } catch { return null; }
}

function saveAttachment(ws: WebSocket, att: Attachment): void {
  try { ws.serializeAttachment(att); } catch { /* the socket is gone */ }
}

function sendQuietly(ws: WebSocket, data: Uint8Array): void {
  try { ws.send(data); } catch { /* closed: its close handler does the bookkeeping */ }
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try { ws.close(code, reason); } catch { /* already closing */ }
}

export class MachineRoomDO extends DurableObject<Env> {
  protected readonly state: DurableObjectState;
  private readonly timing: Timing;
  /** Fresh copies of attachments (by `${role}:${connId|epoch}`), written back every FLUSH_MS. */
  private readonly mem = new Map<string, { att: Attachment; flushedAt: number }>();
  /** All phones → daemon, and daemon → all phones (in memory: an eviction refills them, which only favours the user). */
  private machineUp: BucketState;
  private machineDown: BucketState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.timing = timingFrom(env as unknown as Record<string, unknown>);
    this.machineUp = fullBucket(LIMITS.machineUp.bytesBurst, this.now());
    this.machineDown = fullBucket(LIMITS.machineDown.bytesBurst, this.now());
    // No DDL here: a request for a machine nobody registered must leave no storage behind. register() creates the
    // schema; every other path reads the machine row first and stops at machine_unknown when there is none.
  }

  private now(): number {
    return Date.now();
  }

  private get sql(): SqlStorage {
    return this.state.storage.sql;
  }

  private ensureSchema(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS machine (k INTEGER PRIMARY KEY CHECK (k = 1), machine_id TEXT NOT NULL, pub TEXT NOT NULL, last_daemon_at INTEGER NOT NULL, next_conn_id INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS device (device_id TEXT PRIMARY KEY, pub TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS tombstone (device_id TEXT PRIMARY KEY, pub TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS jti (principal TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, exp INTEGER NOT NULL, uses INTEGER NOT NULL, PRIMARY KEY (principal, id))");
    this.sql.exec("CREATE INDEX IF NOT EXISTS jti_exp ON jti (exp)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS jti_kind ON jti (kind)");
  }

  /** The machine row, or null for a room nobody registered (or one deleted) — read-only: an absent table is null. */
  private machine(): MachineRow | null {
    const table = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'machine'").toArray();
    if (table.length === 0) return null;
    return this.sql.exec<MachineRow>("SELECT machine_id, pub, last_daemon_at, next_conn_id, epoch FROM machine WHERE k = 1").toArray()[0] ?? null;
  }

  /** The device's live key or its tombstone's key. */
  private deviceKey(deviceId: string): { pub: string; revoked: boolean } | null {
    const live = this.sql.exec<KeyRow>("SELECT pub FROM device WHERE device_id = ?", deviceId).toArray()[0];
    if (live !== undefined) return { pub: live.pub, revoked: false };
    const stone = this.sql.exec<KeyRow>("SELECT pub FROM tombstone WHERE device_id = ? AND expires_at > ?", deviceId, this.now()).toArray()[0];
    return stone === undefined ? null : { pub: stone.pub, revoked: true };
  }

  // ---- socket bookkeeping ----

  private key(att: Attachment): string {
    return att.role === "daemon" ? `daemon:${att.epoch}` : `phone:${att.connId}`;
  }

  /** The freshest view of a socket's attachment (memory if this instance has seen it, else what the socket carries). */
  private view(ws: WebSocket): Attachment | null {
    const stored = attachmentOf(ws);
    if (stored === null) return null;
    const cached = this.mem.get(this.key(stored));
    if (cached === undefined) {
      this.mem.set(this.key(stored), { att: stored, flushedAt: this.now() });
      return stored;
    }
    if (stored.closed) cached.att.closed = true;
    return cached.att;
  }

  private flush(ws: WebSocket, att: Attachment, force = false): void {
    const entry = this.mem.get(this.key(att));
    const now = this.now();
    if (!force && entry !== undefined && now - entry.flushedAt < FLUSH_MS) return;
    saveAttachment(ws, att);
    this.mem.set(this.key(att), { att, flushedAt: now });
  }

  private forget(att: Attachment): void {
    this.mem.delete(this.key(att));
  }

  /** The live daemon: the current epoch's socket, open and not retired. Old CLOSING sockets never count. */
  private daemon(epoch = this.machine()?.epoch ?? -1): WebSocket | null {
    for (const ws of this.state.getWebSockets("daemon")) {
      const att = this.view(ws);
      if (att !== null && att.epoch === epoch && !att.closed && ws.readyState === OPEN) return ws;
    }
    return null;
  }

  /** Live phone sockets (open, not closed by the relay or the daemon). */
  private phones(): Array<{ ws: WebSocket; att: Attachment }> {
    const out: Array<{ ws: WebSocket; att: Attachment }> = [];
    for (const ws of this.state.getWebSockets("phone")) {
      const att = this.view(ws);
      if (att !== null && !att.closed && ws.readyState === OPEN) out.push({ ws, att });
    }
    return out;
  }

  /** Closes a phone the relay or the daemon decided to drop. Idempotent: at most one PEER_CLOSE. */
  private closePhone(ws: WebSocket, att: Attachment, code: number, reason: string, notifyDaemon: boolean): void {
    if (att.closed) return;
    att.closed = true;
    this.flush(ws, att, true);
    closeQuietly(ws, code, reason);
    if (notifyDaemon) this.peerClose(att, reason);
    log({ event: "close", leg: att.role, code, reason });
  }

  private peerClose(att: Attachment, reason: string): void {
    const daemon = this.daemon();
    // Only to the daemon that opened it: a phone admitted under an older daemon is never news to a newer one.
    if (daemon === null || this.view(daemon)?.epoch !== att.epoch) return;
    sendQuietly(daemon, encodeEnvelope(OP.PEER_CLOSE, att.connId, jsonBytes({ reason })));
  }

  /** Retires a daemon socket and every phone (they were talking to its Noise sessions; no PEER_CLOSE to anyone). */
  private retireDaemon(ws: WebSocket | null, att: Attachment | null, code: number | null, reason: string): void {
    if (ws !== null && att !== null && !att.closed) {
      att.closed = true;
      this.flush(ws, att, true);
      if (code !== null) closeQuietly(ws, code, reason);
      log({ event: "close", leg: "daemon", code, reason });
    }
    for (const phone of this.phones()) this.closePhone(phone.ws, phone.att, CLOSE.daemonGone, "daemon_gone", false);
  }

  /** A daemon socket from an older epoch that is still around (its close handshake never finished): closed on its
   * own, without touching the current daemon's phones. */
  private dropStaleDaemon(ws: WebSocket, att: Attachment): void {
    if (att.closed) return;
    att.closed = true;
    this.flush(ws, att, true);
    closeQuietly(ws, CLOSE.superseded, "superseded");
  }

  // ---- alarm: the earliest deadline across sockets, plus the far housekeeping deadlines ----

  /** The far deadlines: replay rows and tombstones expiring, and — only while nothing is connected — the room's idle GC
   * (a connected room is never collected, so its GC deadline must not keep the alarm firing). */
  private nextHousekeeping(machine: MachineRow, idle: boolean): number {
    const jti = this.sql.exec<{ m: number | null }>("SELECT MIN(exp) AS m FROM jti").toArray()[0]?.m ?? null;
    const stone = this.sql.exec<{ m: number | null }>("SELECT MIN(expires_at) AS m FROM tombstone").toArray()[0]?.m ?? null;
    let next = idle ? machine.last_daemon_at + LIMITS.roomIdleDeleteMs : Infinity;
    if (jti !== null) next = Math.min(next, (jti + 31) * 1000);
    if (stone !== null) next = Math.min(next, stone);
    return next;
  }

  /** Makes sure an alarm fires no later than `at`. */
  private async armBy(at: number): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null || current > at) await this.state.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const now = this.now();
    const machine = this.machine();
    if (machine === null) return;
    let next = Infinity;
    let sockets = 0;
    let daemonLive = false;
    for (const ws of this.state.getWebSockets()) {
      const att = this.view(ws);
      if (att === null) continue;
      if (att.closed || ws.readyState !== OPEN) continue;
      if (att.role === "daemon" && att.epoch !== machine.epoch) { this.dropStaleDaemon(ws, att); continue; }
      const due = socketDeadline(att, this.timing);
      if (due.at <= now) {
        if (att.role === "daemon") this.retireDaemon(ws, att, CLOSE.timeout, due.reason);
        else this.closePhone(ws, att, CLOSE.timeout, due.reason, true);
        continue;
      }
      sockets += 1;
      if (att.role === "daemon") daemonLive = true;
      next = Math.min(next, due.at);
    }
    // A daemon connected for months still counts as seen (a daily write at most), so its room never ages toward GC.
    if (daemonLive && now - machine.last_daemon_at > DAEMON_SEEN_WRITE_MS) this.sql.exec("UPDATE machine SET last_daemon_at = ? WHERE k = 1", now);
    const nowSec = Math.floor(now / 1000);
    this.sql.exec("DELETE FROM jti WHERE exp < ?", nowSec - 30);
    this.sql.exec("DELETE FROM tombstone WHERE expires_at <= ?", now);
    if (sockets === 0 && now - machine.last_daemon_at >= LIMITS.roomIdleDeleteMs) {
      log({ event: "room_gc", machine: machineTag(machine.machine_id) });
      await this.deleteRoom();
      return;
    }
    next = Math.min(next, this.nextHousekeeping(machine, sockets === 0));
    if (next === Infinity) return; // nothing connected or pending: no alarm until something arrives
    await this.state.storage.setAlarm(Math.max(next, now + 1));
  }

  private async deleteRoom(): Promise<void> {
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
    this.mem.clear();
  }

  // ---- token admission ----

  private bearer(request: Request): ParsedToken | null {
    const auth = request.headers.get("authorization") ?? "";
    return auth.startsWith("Bearer ") ? parseToken(auth.slice(7).trim()) : null;
  }

  /** The claim rules (writes nothing). */
  private checkToken(parsed: ParsedToken, use: TokenUse): Refusal | { jti: string; exp: number } {
    const checked = checkClaims(parsed, publicHostOf(this.env), use, Math.floor(this.now() / 1000));
    return checked.ok ? { jti: checked.jti, exp: checked.exp } : { status: 401, code: checked.code };
  }

  /** Consumes one use of the jti from its principal's own budget, in one synchronous statement (this turn, no await
   * in between). Ids are remembered per principal, so a device can neither spend nor collide with the daemon's. */
  private consumeJti(parsed: ParsedToken, jti: string, exp: number): Refusal | null {
    const nowSec = Math.floor(this.now() / 1000);
    const who = principalOf(parsed);
    const consume = (): boolean => this.sql.exec(
      "INSERT INTO jti (principal, kind, id, exp, uses) SELECT ?, ?, ?, ?, 1 "
      + "WHERE ((SELECT COUNT(*) FROM jti WHERE principal = ?) < ? AND (SELECT COUNT(*) FROM jti WHERE kind = ?) < ?) "
      + "OR EXISTS (SELECT 1 FROM jti WHERE principal = ? AND id = ?) "
      + "ON CONFLICT (principal, id) DO UPDATE SET uses = uses + 1 WHERE uses < ? RETURNING uses",
      who.key, who.kind, jti, exp, who.key, who.own, who.kind, who.total, who.key, jti, maxUses(parsed.role),
    ).toArray().length === 1;
    if (consume()) return null;
    if (this.sql.exec("SELECT 1 FROM jti WHERE principal = ? AND id = ?", who.key, jti).toArray().length === 1) return { status: 401, code: "token_invalid" };
    // This principal's budget is spent: drop what has expired (the alarm does this too) and try once more.
    this.sql.exec("DELETE FROM jti WHERE exp < ?", nowSec - 30);
    if (consume()) return null;
    return { status: 429, code: "replay_cache_full", retryAfterSec: 30 };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/internal/register" && request.method === "POST") return await this.register(request);
      if (url.pathname === "/v1/connect") return await this.admitSocket(request);
      return await this.admission(request, url.pathname);
    } catch (error) {
      log({ event: "error", route: routeOf(url.pathname), message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      return refusalResponse({ status: 400, code: "bad_request" });
    }
  }

  private async register(request: Request): Promise<Response> {
    const { machineId, relayMachinePub } = (await request.json()) as { machineId: string; relayMachinePub: string };
    const now = this.now();
    // The id is derived from the key, so a stored row never changes key: write the first time, then only refresh the
    // GC clock when it is old.
    this.ensureSchema();
    const existing = this.machine();
    if (existing === null) {
      this.sql.exec("INSERT INTO machine (k, machine_id, pub, last_daemon_at, next_conn_id, epoch) VALUES (1, ?, ?, ?, 0, 0)", machineId, relayMachinePub, now);
    } else if (now - existing.last_daemon_at > DAEMON_SEEN_WRITE_MS) {
      this.sql.exec("UPDATE machine SET last_daemon_at = ? WHERE k = 1", now);
    }
    await this.armBy(this.nextHousekeeping(this.machine()!, true));
    return jsonResponse(200, { machineId });
  }

  /** PUT/POST /v1/machines/:id/devices, DELETE /v1/machines/:id/devices/:deviceId, DELETE /v1/machines/:id. */
  private async admission(request: Request, path: string): Promise<Response> {
    const route = routeOf(path);
    const match = /^\/v1\/machines\/([a-z2-7]{26})(\/devices(?:\/([^/]*))?)?$/.exec(path);
    const method = request.method;
    if (match === null || (method !== "PUT" && method !== "POST" && method !== "DELETE")) return refuse(route, { status: 400, code: "bad_request" });
    const machineId = match[1]!;
    const tag = { machine: machineTag(machineId) };
    const parsed = this.bearer(request);
    if (parsed === null) return refuse(route, { status: 401, code: "token_invalid" }, tag);
    const machine = this.machine();
    if (machine === null || machine.machine_id !== machineId) return refuse(route, { status: 404, code: "machine_unknown" }, tag);
    if (parsed.machineId !== machineId) return refuse(route, { status: 401, code: "token_invalid" }, tag);
    const signed = await verifyEd25519(fromB64Url(machine.pub), parsed.input, parsed.sig);
    // After the await: the room may have been deleted meanwhile.
    if (this.machine()?.pub !== machine.pub) return refuse(route, { status: 404, code: "machine_unknown" }, tag);
    if (!signed) return refuse(route, { status: 401, code: "token_invalid" }, tag);
    const claims = this.checkToken(parsed, { method, path });
    if ("code" in claims) return refuse(route, claims, tag);
    const replay = this.consumeJti(parsed, claims.jti, claims.exp);
    if (replay !== null) return refuse(route, replay, tag);

    if (match[2] === undefined) {
      // DELETE /v1/machines/:id: the Mac turned phone access off or retires its keys.
      for (const ws of this.state.getWebSockets("daemon")) {
        const att = this.view(ws);
        if (att !== null && !att.closed) { att.closed = true; saveAttachment(ws, att); closeQuietly(ws, CLOSE.normal, "machine_deleted"); }
      }
      this.retireDaemon(null, null, null, "machine_deleted");
      await this.deleteRoom();
      log({ event: "machine_deleted", ...tag });
      return jsonResponse(200, { ok: true });
    }

    const now = this.now();
    if (method === "DELETE") {
      const deviceId = match[3]!;
      if (!ID.test(deviceId)) return refuse(route, { status: 400, code: "bad_request" }, tag);
      this.state.storage.transactionSync(() => {
        const row = this.sql.exec<KeyRow>("SELECT pub FROM device WHERE device_id = ?", deviceId).toArray()[0];
        if (row === undefined) return;
        this.sql.exec("DELETE FROM device WHERE device_id = ?", deviceId);
        this.writeTombstone(deviceId, row.pub, now);
      });
      for (const phone of this.phones()) {
        if (phone.att.role === "device" && phone.att.peerId === deviceId) this.closePhone(phone.ws, phone.att, CLOSE.revoked, "device_revoked", true);
      }
      await this.armBy(this.nextHousekeeping(this.machine()!, true));
      return jsonResponse(200, { ok: true });
    }

    if (method === "POST") {
      const body = await readJsonObject(request, LIMITS.postBodyBytes);
      const deviceId = body?.["deviceId"];
      const pub = relayKeyOrNull(body?.["deviceRelayPub"]);
      if (typeof deviceId !== "string" || !ID.test(deviceId) || pub === null) return refuse(route, { status: 400, code: "bad_request" }, tag);
      if (this.machine()?.pub !== machine.pub) return refuse(route, { status: 404, code: "machine_unknown" }, tag);
      const pubB64 = toB64Url(pub);
      const outcome = this.state.storage.transactionSync((): "ok" | "full" | "rekeyed" => {
        const current = this.sql.exec<KeyRow>("SELECT pub FROM device WHERE device_id = ?", deviceId).toArray()[0];
        if (current === undefined) {
          const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM device").one().n;
          if (count >= LIMITS.devicesPerMachine) return "full";
          this.sql.exec("INSERT INTO device (device_id, pub) VALUES (?, ?)", deviceId, pubB64);
        } else if (current.pub !== pubB64) {
          this.sql.exec("UPDATE device SET pub = ? WHERE device_id = ?", pubB64, deviceId);
        }
        this.sql.exec("DELETE FROM tombstone WHERE device_id = ?", deviceId);
        return current !== undefined && current.pub !== pubB64 ? "rekeyed" : "ok";
      });
      if (outcome === "full") return refuse(route, { status: 400, code: "bad_request" }, tag);
      if (outcome === "rekeyed") this.supersedeDevice(deviceId);
      return jsonResponse(200, { ok: true });
    }

    // PUT: replace the whole admitted set atomically; devices that left it get a tombstone with their stored key.
    const body = await readJsonObject(request, LIMITS.putBodyBytes);
    const list = body?.["devices"];
    if (!Array.isArray(list) || list.length > LIMITS.devicesPerMachine) return refuse(route, { status: 400, code: "bad_request" }, tag);
    const next = new Map<string, string>();
    for (const item of list) {
      const entry = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
      const deviceId = entry?.["deviceId"];
      const pub = relayKeyOrNull(entry?.["deviceRelayPub"]);
      if (typeof deviceId !== "string" || !ID.test(deviceId) || pub === null || next.has(deviceId)) return refuse(route, { status: 400, code: "bad_request" }, tag);
      next.set(deviceId, toB64Url(pub));
    }
    if (this.machine()?.pub !== machine.pub) return refuse(route, { status: 404, code: "machine_unknown" }, tag);
    const { gone, rekeyed } = this.state.storage.transactionSync(() => {
      const existing = new Map(this.sql.exec<{ device_id: string; pub: string }>("SELECT device_id, pub FROM device").toArray().map(row => [row.device_id, row.pub]));
      const goneIds: string[] = [];
      const rekeyedIds: string[] = [];
      for (const [deviceId, pub] of existing) {
        if (next.has(deviceId)) continue;
        this.sql.exec("DELETE FROM device WHERE device_id = ?", deviceId);
        this.writeTombstone(deviceId, pub, now);
        goneIds.push(deviceId);
      }
      for (const [deviceId, pub] of next) {
        const before = existing.get(deviceId);
        if (before === pub) continue;
        if (before === undefined) this.sql.exec("INSERT INTO device (device_id, pub) VALUES (?, ?)", deviceId, pub);
        else { this.sql.exec("UPDATE device SET pub = ? WHERE device_id = ?", pub, deviceId); rekeyedIds.push(deviceId); }
        this.sql.exec("DELETE FROM tombstone WHERE device_id = ?", deviceId);
      }
      return { gone: new Set(goneIds), rekeyed: new Set(rekeyedIds) };
    });
    for (const phone of this.phones()) {
      if (phone.att.role !== "device") continue;
      if (gone.has(phone.att.peerId)) this.closePhone(phone.ws, phone.att, CLOSE.revoked, "device_revoked", true);
      else if (rekeyed.has(phone.att.peerId)) this.closePhone(phone.ws, phone.att, CLOSE.superseded, "superseded", true);
    }
    if (gone.size > 0) await this.armBy(this.nextHousekeeping(this.machine()!, true));
    return jsonResponse(200, { ok: true, devices: next.size });
  }

  /** A tombstone keeps the stored key for 30 days so a removed phone hears device_revoked (at most 256 per room). */
  private writeTombstone(deviceId: string, pub: string, now: number): void {
    this.sql.exec(
      "INSERT INTO tombstone (device_id, pub, expires_at) VALUES (?, ?, ?) ON CONFLICT (device_id) DO UPDATE SET pub = excluded.pub, expires_at = excluded.expires_at",
      deviceId, pub, now + LIMITS.tombstoneMs,
    );
    this.sql.exec(
      "DELETE FROM tombstone WHERE device_id IN (SELECT device_id FROM tombstone ORDER BY expires_at ASC LIMIT max(0, (SELECT COUNT(*) FROM tombstone) - ?))",
      LIMITS.tombstonesPerMachine,
    );
  }

  private supersedeDevice(deviceId: string): void {
    for (const phone of this.phones()) {
      if (phone.att.role === "device" && phone.att.peerId === deviceId) this.closePhone(phone.ws, phone.att, CLOSE.superseded, "superseded", true);
    }
  }

  /** WS /v1/connect — relay/PROTOCOL.md "Connect order". */
  private async admitSocket(request: Request): Promise<Response> {
    const route = "/v1/connect";
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return refuse(route, { status: 400, code: "bad_request" });
    const parsed = this.bearer(request);
    if (parsed === null) return refuse(route, { status: 401, code: "token_invalid" });
    const tag = { role: parsed.role, machine: machineTag(parsed.machineId) };
    const machine = this.machine();
    if (machine === null || machine.machine_id !== parsed.machineId) return refuse(route, { status: 404, code: "machine_unknown" }, tag);

    let key: { pub: string; revoked: boolean };
    if (parsed.role === "device") {
      const found = this.deviceKey(parsed.deviceId!);
      if (found === null) {
        return refuse(route, this.daemon(machine.epoch) === null ? { status: 503, code: "daemon_unavailable" } : { status: 404, code: "device_unknown" }, tag);
      }
      key = found;
    } else {
      key = { pub: machine.pub, revoked: false };
    }
    const signed = await verifyEd25519(fromB64Url(key.pub), parsed.input, parsed.sig);

    // ---- From here to the 101 nothing awaits: the checks and the slot reservation happen in one turn. ----
    const after = this.machine();
    if (after === null || after.pub !== machine.pub) return refuse(route, { status: 404, code: "machine_unknown" }, tag);
    if (parsed.role === "device") {
      const again = this.deviceKey(parsed.deviceId!);
      if (again === null || again.pub !== key.pub || again.revoked !== key.revoked) return refuse(route, { status: 401, code: "token_invalid" }, tag);
    }
    if (!signed) return refuse(route, { status: 401, code: "token_invalid" }, tag);
    const claims = this.checkToken(parsed, "ws");
    if ("code" in claims) return refuse(route, claims, tag);
    // A revoked device is told so before its jti is consumed: it never writes to the replay cache.
    if (key.revoked) return refuse(route, { status: 403, code: "device_revoked" }, tag);
    const replay = this.consumeJti(parsed, claims.jti, claims.exp);
    if (replay !== null) return refuse(route, replay, tag);

    const now = this.now();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (parsed.role === "daemon") {
      // A newer daemon proved the machine key: the old one gets 4409 and its phones go with it.
      const old = this.daemon(after.epoch);
      this.retireDaemon(old, old === null ? null : this.view(old), CLOSE.superseded, "superseded");
      const epoch = after.epoch + 1;
      if (now - after.last_daemon_at > DAEMON_SEEN_WRITE_MS) this.sql.exec("UPDATE machine SET epoch = ?, last_daemon_at = ? WHERE k = 1", epoch, now);
      else this.sql.exec("UPDATE machine SET epoch = ? WHERE k = 1", epoch);
      const att: Attachment = { role: "daemon", connId: 0, epoch, peerId: "daemon", openedAt: now, firstAt: now, lastAt: now, closed: false };
      this.state.acceptWebSocket(server, ["daemon"]);
      this.flush(server, att, true);
      log({ event: "open", leg: "daemon", ...tag });
    } else {
      const daemon = this.daemon(after.epoch);
      if (daemon === null) return refuse(route, { status: 503, code: "daemon_unavailable" }, tag);
      const peerId = parsed.deviceId ?? parsed.pairSessionId!;
      const live = this.phones();
      const sameDevice = (att: Attachment): boolean => parsed.role === "device" && att.role === "device" && att.peerId === peerId;
      if (live.filter(phone => !sameDevice(phone.att)).length >= LIMITS.socketsPerMachine) {
        return refuse(route, { status: 429, code: "too_many_peers", retryAfterSec: 5 }, tag);
      }
      for (const phone of live) if (sameDevice(phone.att)) this.closePhone(phone.ws, phone.att, CLOSE.superseded, "superseded", true);
      // connIds are never reused while the room exists (a late PEER_CLOSE can't name a newer phone).
      const connId = after.next_conn_id >= 0xffff_fff0 ? 1 : after.next_conn_id + 1;
      this.sql.exec("UPDATE machine SET next_conn_id = ? WHERE k = 1", connId);
      const att: Attachment = {
        role: parsed.role, connId, epoch: after.epoch, peerId, openedAt: now, firstAt: 0, lastAt: now, closed: false,
        buckets: [fullBucket(LIMITS.phoneUp.framesBurst, now), fullBucket(LIMITS.phoneUp.bytesBurst, now), fullBucket(LIMITS.phoneDown.bytesBurst, now)],
      };
      this.state.acceptWebSocket(server, ["phone"]);
      this.flush(server, att, true);
      sendQuietly(daemon, encodeEnvelope(OP.PEER_OPEN, connId, jsonBytes({ role: parsed.role, id: peerId })));
      log({ event: "open", leg: parsed.role, ...tag });
    }
    const response = new Response(null, { status: 101, webSocket: client });
    const deadline = parsed.role === "daemon" ? now + this.timing.daemonSilenceMs : now + this.timing.phoneFirstFrameMs;
    await this.armBy(deadline);
    return response;
  }

  // ---- frames ----

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const att = this.view(ws);
    if (att === null || att.closed) return; // dropped already: a late frame is ignored
    const now = this.now();
    att.lastAt = now;
    if (att.role === "daemon") { this.daemonFrame(ws, att, message, now); return; }

    if (att.firstAt === 0) { att.firstAt = now; this.flush(ws, att, true); }
    if (typeof message === "string") { this.closePhone(ws, att, CLOSE.protocol, "binary_only", true); return; }
    if (message.byteLength > MAX_NOISE_MESSAGE_BYTES) { this.closePhone(ws, att, CLOSE.protocol, "oversize", true); return; }
    const [frames, bytes] = att.buckets ?? (att.buckets = [fullBucket(LIMITS.phoneUp.framesBurst, now), fullBucket(LIMITS.phoneUp.bytesBurst, now), fullBucket(LIMITS.phoneDown.bytesBurst, now)]);
    const size = message.byteLength;
    if (!bucketTake(frames, LIMITS.phoneUp.framesPerMin, LIMITS.phoneUp.framesBurst, 1, now)
      || !bucketTake(bytes, LIMITS.phoneUp.bytesPerMin, LIMITS.phoneUp.bytesBurst, size, now)
      || !bucketTake(this.machineUp, LIMITS.machineUp.bytesPerMin, LIMITS.machineUp.bytesBurst, size, now)) {
      this.closePhone(ws, att, CLOSE.rateLimited, "rate_limited", true);
      return;
    }
    const daemon = this.daemon();
    if (daemon === null || this.view(daemon)?.epoch !== att.epoch) { this.closePhone(ws, att, CLOSE.daemonGone, "daemon_gone", false); return; }
    sendQuietly(daemon, encodeEnvelope(OP.PEER_DATA, att.connId, new Uint8Array(message)));
    this.flush(ws, att);
  }

  private daemonFrame(ws: WebSocket, att: Attachment, message: ArrayBuffer | string, now: number): void {
    const machine = this.machine();
    if (machine === null || att.epoch !== machine.epoch) { this.dropStaleDaemon(ws, att); return; }
    if (typeof message === "string") { this.retireDaemon(ws, att, CLOSE.protocol, "binary_only"); return; }
    const bytes = new Uint8Array(message);
    if (bytes.length < ENVELOPE_HEADER_BYTES || bytes.length > MAX_DAEMON_FRAME_BYTES) { this.retireDaemon(ws, att, CLOSE.protocol, "oversize"); return; }
    const op = bytes[0]!;
    const connId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
    const payload = bytes.subarray(ENVELOPE_HEADER_BYTES);
    this.flush(ws, att);
    if (op === OP.HEARTBEAT) {
      if (connId !== 0 || payload.length !== HEARTBEAT_PAYLOAD_BYTES) { this.retireDaemon(ws, att, CLOSE.protocol, "protocol"); return; }
      sendQuietly(ws, encodeEnvelope(OP.HEARTBEAT_ACK, 0, payload));
      return;
    }
    if (op !== OP.PEER_DATA && op !== OP.PEER_CLOSE) { this.retireDaemon(ws, att, CLOSE.protocol, "protocol"); return; }
    const target = this.phoneByConnId(connId);
    if (target === null) return; // a late frame for a phone that is gone
    if (op === OP.PEER_CLOSE) { this.closePhone(target.ws, target.att, CLOSE.normal, "closed_by_daemon", false); return; }
    const down = (target.att.buckets ??= [fullBucket(LIMITS.phoneUp.framesBurst, now), fullBucket(LIMITS.phoneUp.bytesBurst, now), fullBucket(LIMITS.phoneDown.bytesBurst, now)])[2];
    // Over the phone's own downstream budget or the machine's, only that phone is closed (the frame isn't sent: it
    // would break its Noise stream anyway). Never the daemon.
    if (!bucketTake(down, LIMITS.phoneDown.bytesPerMin, LIMITS.phoneDown.bytesBurst, payload.length, now)
      || !bucketTake(this.machineDown, LIMITS.machineDown.bytesPerMin, LIMITS.machineDown.bytesBurst, payload.length, now)) {
      this.closePhone(target.ws, target.att, CLOSE.rateLimited, "rate_limited", true);
      return;
    }
    target.att.lastAt = now; // idle counts traffic in either direction
    sendQuietly(target.ws, payload);
    this.flush(target.ws, target.att);
  }

  private phoneByConnId(connId: number): { ws: WebSocket; att: Attachment } | null {
    if (connId === 0) return null;
    for (const phone of this.phones()) if (phone.att.connId === connId) return phone;
    return null;
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Complete the close handshake (a no-op where the runtime already answered the client's close frame).
    closeQuietly(ws, code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason.slice(0, 100));
    this.closed(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.closed(ws);
  }

  /** The peer went away (or errored). Idempotent across close + error. */
  private closed(ws: WebSocket): void {
    const att = this.view(ws);
    if (att === null) return;
    if (att.closed) { this.forget(att); return; }
    att.closed = true;
    saveAttachment(ws, att);
    this.forget(att);
    if (att.role === "daemon") {
      if (att.epoch === this.machine()?.epoch) {
        log({ event: "close", leg: "daemon", reason: "daemon_left" });
        this.retireDaemon(null, null, null, "daemon_gone");
      }
      return;
    }
    this.peerClose(att, "peer_closed");
  }
}
