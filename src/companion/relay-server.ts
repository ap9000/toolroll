/**
 * The open-source reference relay for the Toolroll companion (normative contract: relay/PROTOCOL.md).
 * Plain Node.js HTTP + `ws`, for self-hosting (relay/reference/Dockerfile) and for tests. The hosted relay
 * (relay/cloudflare) implements the same contract; relay/conformance/suite.ts runs against both.
 *
 * The relay holds no Noise keys, cannot read payloads and cannot authorize any Toolroll act. It admits sockets with
 * Ed25519 tokens before the upgrade, routes phones to the Mac (the daemon) over the 5-byte connId envelope and enforces
 * the limits in PROTOCOL.md. All state is in memory: a restart forgets every machine, and the Mac registers again when
 * it sees 404 machine_unknown.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { MAX_NOISE_MESSAGE_BYTES } from "./noise.js";
import {
  checkRelayClaims,
  ed25519Verify,
  encodeRelayEnvelope,
  HEARTBEAT_PAYLOAD_BYTES,
  MAX_DAEMON_WS_FRAME_BYTES,
  parseRelayToken,
  RELAY_ENVELOPE_HEADER_BYTES,
  RELAY_ID_PATTERN,
  RelayOp,
  RelayReplayCache,
  relayTokenMaxUses,
  replayPrincipalOf,
  verifyMachineRegistration,
  type ParsedRelayToken,
  type RelayRole,
} from "./relay-auth.js";

/** relay/PROTOCOL.md, "Limits". The same numbers live in test/fixtures/companion-wire.json (the suite compares). */
export const RELAY_LIMITS = Object.freeze({
  phoneFirstFrameMs: 10_000,
  phoneIdleMs: 90_000,
  daemonSilenceMs: 60_000,
  socketsPerMachine: 4,
  devicesPerMachine: 32,
  tombstonesPerMachine: 256,
  tombstoneMs: 30 * 24 * 60 * 60 * 1000,
  roomIdleDeleteMs: 90 * 24 * 60 * 60 * 1000,
  phoneUp: { framesPerMin: 600, framesBurst: 120, bytesPerMin: 4 * 1024 * 1024, bytesBurst: 1024 * 1024 },
  phoneDown: { bytesPerMin: 16 * 1024 * 1024, bytesBurst: 4 * 1024 * 1024 },
  machineUp: { bytesPerMin: 32 * 1024 * 1024, bytesBurst: 8 * 1024 * 1024 },
  machineDown: { bytesPerMin: 64 * 1024 * 1024, bytesBurst: 16 * 1024 * 1024 },
  registerPerMin: 20,
  connectPerMin: 120,
  clientPerMin: 600,
  registerBodyBytes: 4096,
  putBodyBytes: 16_384,
  postBodyBytes: 4096,
  challengeTtlMs: 60_000,
});

/** Close codes (relay/PROTOCOL.md "Close codes"). */
export const RelayClose = Object.freeze({
  normal: 1000,
  protocol: 4400,
  revoked: 4403,
  timeout: 4408,
  superseded: 4409,
  rateLimited: 4429,
  daemonGone: 4503,
});

export interface ReferenceRelayOptions {
  host?: string;
  port?: number;
  /** The relay's public host: token `aud` and the registration signature's host. Lowercased. Default `host:port` of
   * the listening socket (right for tests and a relay reached directly; behind a proxy set RELAY_PUBLIC_HOST). */
  publicHost?: string;
  /** Take the client address from the last `X-Forwarded-For` entry (set only behind a proxy you run). */
  trustProxy?: boolean;
  /** HMAC key for stateless registration challenges (random per process when unset), plus the previous one while
   * rotating. */
  challengeSecret?: string;
  previousChallengeSecret?: string;
  /** Build id shown by /v1/health. */
  build?: string;
  /** Timing overrides (tests). */
  phoneFirstFrameMs?: number;
  phoneIdleMs?: number;
  daemonSilenceMs?: number;
  /** Per client address per minute (register + challenge) and per machine + client address per minute (connect +
   * admission calls). */
  registerPerMin?: number;
  connectPerMin?: number;
  /** Per client address per minute across every machine (connect + admission calls), checked first: varying the
   * machine id can't get around the per-machine limit. */
  clientPerMin?: number;
  /** Machines held at once (reference only). At the cap the least recently active room with no sockets is dropped. */
  maxRooms?: number;
  /** Open WebSockets per client address (reference only). */
  maxSocketsPerIp?: number;
  /** Frames forwarded per minute across the whole relay before it sheds load with 503 (reference only; 0 = off). */
  globalFramesPerMin?: number;
  /** Clock for deterministic tests (token times, tombstones, room GC). */
  nowMs?: () => number;
  /** One structured line per refusal and close; never tokens, keys or full ids. */
  log?: (entry: Record<string, unknown>) => void;
}

export interface RunningReferenceRelay {
  url: string;
  wsUrl: string;
  port: number;
  publicHost: string;
  close: () => Promise<void>;
  /** Runs the hourly sweep now (room GC, expired tombstones and jti rows). */
  sweep: () => void;
  stats: () => { machines: number; forwardedThisWindow: number };
  /** Replay-cache rows a machine holds (tests), or null for an unknown machine. */
  replayRows: (machineId: string) => number | null;
}

type RefusalCode =
  | "bad_request" | "token_invalid" | "token_expired" | "token_not_yet_valid" | "device_revoked" | "machine_unknown"
  | "device_unknown" | "rate_limited" | "too_many_peers" | "replay_cache_full" | "daemon_unavailable";

interface Refusal { status: number; code: RefusalCode; retryAfterSec?: number }

class TokenBucket {
  private tokens: number;
  private at: number;
  private readonly ratePerMs: number;
  constructor(perMinute: number, private readonly burst: number, nowMs: number) {
    this.tokens = burst;
    this.ratePerMs = perMinute / 60_000;
    this.at = nowMs;
  }
  take(cost: number, nowMs: number): boolean {
    this.refill(nowMs);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
  /** Seconds until `cost` would be available (for Retry-After). */
  waitSec(cost: number, nowMs: number): number {
    this.refill(nowMs);
    return Math.max(1, Math.ceil((cost - this.tokens) / this.ratePerMs / 1000));
  }
  full(nowMs: number): boolean { this.refill(nowMs); return this.tokens >= this.burst; }
  private refill(nowMs: number): void {
    const elapsed = Math.max(0, nowMs - this.at);
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerMs);
    this.at = nowMs;
  }
}

/** Rate buckets by key with a bounded number of keys (full buckets are dropped first). */
class KeyedBuckets {
  private readonly buckets = new Map<string, TokenBucket>();
  constructor(private readonly perMin: number, private readonly maxKeys = 50_000) {}
  take(key: string, nowMs: number): Refusal | null {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) this.prune(nowMs);
      bucket = new TokenBucket(this.perMin, this.perMin, nowMs);
      this.buckets.set(key, bucket);
    }
    return bucket.take(1, nowMs) ? null : { status: 429, code: "rate_limited", retryAfterSec: bucket.waitSec(1, nowMs) };
  }
  private prune(nowMs: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.full(nowMs)) this.buckets.delete(key);
    while (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
  }
}

interface PeerConn {
  connId: number;
  ws: WebSocket;
  role: "pair" | "device";
  peerId: string;
  /** Set once the relay or the daemon closed it: later frames are dropped and no second PEER_CLOSE is sent. */
  closed: boolean;
  firstFrame: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  frames: TokenBucket;
  bytes: TokenBucket;
  down: TokenBucket;
}

interface DaemonConn {
  ws: WebSocket;
  epoch: number;
  /** Superseded or deleted: its close must not touch the room any more. */
  retired: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface MachineRoom {
  machineId: string;
  pub: Buffer;
  devices: Map<string, Buffer>;
  tombstones: Map<string, { pub: Buffer; expiresAtMs: number }>;
  replay: RelayReplayCache;
  daemon: DaemonConn | null;
  epoch: number;
  peers: Map<number, PeerConn>;
  nextConnId: number;
  lastDaemonAtMs: number;
  lastActiveMs: number;
  up: TokenBucket;
  down: TokenBucket;
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests", 503: "Service Unavailable",
};

function refusalHeaders(refusal: Refusal): Record<string, string> {
  return {
    "toolroll-relay-error": refusal.code,
    ...(refusal.retryAfterSec !== undefined ? { "retry-after": String(refusal.retryAfterSec) } : {}),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendRefusal(res: ServerResponse, refusal: Refusal): void {
  sendJson(res, refusal.status, { error: refusal.code }, refusalHeaders(refusal));
}

function rejectUpgrade(socket: Duplex, refusal: Refusal): void {
  const text = JSON.stringify({ error: refusal.code });
  const headers = { ...refusalHeaders(refusal), date: new Date().toUTCString() };
  socket.end(
    `HTTP/1.1 ${refusal.status} ${STATUS_TEXT[refusal.status] ?? "Error"}\r\n`
    + Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")
    + `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`,
  );
  socket.destroy();
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Reads a JSON object body of at most `maxBytes` (null when longer, malformed or not an object). */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) { resolve(null); req.resume(); return; }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (value: Record<string, unknown> | null) => { if (!done) { done = true; resolve(value); } };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) { finish(null); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        finish(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null);
      } catch {
        finish(null);
      }
    });
    req.on("error", () => finish(null));
  });
}

/** A 32-byte Ed25519 key in unpadded base64url, or null. */
function relayKeyOrNull(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const key = Buffer.from(value, "base64url");
  return key.length === 32 ? key : null;
}

/** The rate-limit key for a client address: IPv4 as is, IPv6 by its /64. */
export function clientRateKey(ip: string | null | undefined): string {
  if (ip === null || ip === undefined || ip.length === 0) return "no-ip";
  const plain = ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
  if (!plain.includes(":")) return plain;
  const [head, tail = ""] = plain.toLowerCase().split("::");
  const left = head!.split(":").filter(Boolean);
  const right = tail.split(":").filter(Boolean);
  const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${full.slice(0, 4).join(":")}::/64`;
}

/** A short, non-reversible tag for a machine id in logs. */
function idTag(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

export async function startReferenceRelay(opts: ReferenceRelayOptions = {}): Promise<RunningReferenceRelay> {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const L = RELAY_LIMITS;
  const phoneFirstFrameMs = opts.phoneFirstFrameMs ?? L.phoneFirstFrameMs;
  const phoneIdleMs = opts.phoneIdleMs ?? L.phoneIdleMs;
  const daemonSilenceMs = opts.daemonSilenceMs ?? L.daemonSilenceMs;
  const maxRooms = opts.maxRooms ?? 1_000;
  const maxSocketsPerIp = opts.maxSocketsPerIp ?? 64;
  const globalFramesPerMin = opts.globalFramesPerMin ?? 0;
  const log = opts.log ?? (() => {});
  const challengeSecrets = [opts.challengeSecret ?? randomBytes(32).toString("base64url"), opts.previousChallengeSecret]
    .filter((one): one is string => typeof one === "string" && one.length > 0);
  const registerLimit = new KeyedBuckets(opts.registerPerMin ?? L.registerPerMin);
  const connectLimit = new KeyedBuckets(opts.connectPerMin ?? L.connectPerMin);
  const clientLimit = new KeyedBuckets(opts.clientPerMin ?? L.clientPerMin);
  const socketsByIp = new Map<string, number>();
  const rooms = new Map<string, MachineRoom>();
  let publicHost = (opts.publicHost ?? "").toLowerCase();
  // The breaker is a windowed budget: it opens for the rest of the minute in which the relay forwarded too much, then
  // closes again on its own.
  let windowStartMs = nowMs();
  let forwardedThisWindow = 0;

  const breakerOpen = (): boolean => {
    if (globalFramesPerMin <= 0) return false;
    if (nowMs() - windowStartMs >= 60_000) { windowStartMs = nowMs(); forwardedThisWindow = 0; }
    return forwardedThisWindow >= globalFramesPerMin;
  };
  const countForwarded = (): void => { forwardedThisWindow += 1; };

  const clientKey = (req: IncomingMessage): string => {
    if (opts.trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      const list = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "").split(",").map(one => one.trim()).filter(Boolean);
      if (list.length > 0) return clientRateKey(list[list.length - 1]);
    }
    return clientRateKey(req.socket.remoteAddress);
  };

  const refused = (route: string, refusal: Refusal, extra: Record<string, unknown> = {}): Refusal => {
    log({ event: "refusal", route, status: refusal.status, code: refusal.code, ...extra });
    return refusal;
  };

  // ---- Challenges: stateless, HMAC-signed, 60 s (no pool anyone can fill) ----
  const challengeMac = (secret: string, body: Buffer): Buffer => createHmac("sha256", secret).update(body).digest();
  const mintChallenge = (): string => {
    const body = Buffer.alloc(24);
    randomBytes(16).copy(body, 0);
    body.writeBigUInt64BE(BigInt(nowMs() + L.challengeTtlMs), 16);
    return Buffer.concat([body, challengeMac(challengeSecrets[0]!, body)]).toString("base64url");
  };
  const challengeValid = (challenge: string): boolean => {
    if (!/^[A-Za-z0-9_-]{75}$/.test(challenge)) return false;
    const raw = Buffer.from(challenge, "base64url");
    if (raw.length !== 56) return false;
    const body = raw.subarray(0, 24), mac = raw.subarray(24);
    if (!challengeSecrets.some(secret => timingSafeEqual(challengeMac(secret, body), mac))) return false;
    return Number(body.readBigUInt64BE(16)) > nowMs();
  };

  // ---- Rooms ----
  const liveDaemon = (room: MachineRoom): DaemonConn | null =>
    room.daemon !== null && !room.daemon.retired && room.daemon.ws.readyState === WebSocket.OPEN ? room.daemon : null;

  const sendPeerClose = (room: MachineRoom, connId: number, reason: string): void => {
    const daemon = liveDaemon(room);
    if (daemon === null) return;
    daemon.ws.send(encodeRelayEnvelope({ op: RelayOp.PEER_CLOSE, connId, payload: Buffer.from(JSON.stringify({ reason }), "utf8") }), { binary: true });
  };

  /** Closes a phone socket the relay or the daemon decided to drop. Idempotent: one PEER_CLOSE at most. */
  const closePeer = (room: MachineRoom, peer: PeerConn, code: number, reason: string, notifyDaemon: boolean): void => {
    if (peer.closed) return;
    peer.closed = true;
    if (peer.timer !== null) clearTimeout(peer.timer);
    room.peers.delete(peer.connId);
    if (peer.ws.readyState === WebSocket.OPEN || peer.ws.readyState === WebSocket.CONNECTING) peer.ws.close(code, reason);
    if (notifyDaemon) sendPeerClose(room, peer.connId, reason);
    log({ event: "close", leg: peer.role, code, reason, machine: idTag(room.machineId) });
  };

  const armPeerTimer = (room: MachineRoom, peer: PeerConn): void => {
    if (peer.timer !== null) clearTimeout(peer.timer);
    const firstFrame = !peer.firstFrame;
    peer.timer = setTimeout(() => {
      closePeer(room, peer, RelayClose.timeout, firstFrame ? "first_frame_timeout" : "idle_timeout", true);
    }, firstFrame ? phoneFirstFrameMs : phoneIdleMs);
    peer.timer.unref?.();
  };

  const armDaemonTimer = (room: MachineRoom, daemon: DaemonConn): void => {
    if (daemon.timer !== null) clearTimeout(daemon.timer);
    daemon.timer = setTimeout(() => {
      if (room.daemon === daemon && !daemon.retired) daemon.ws.close(RelayClose.timeout, "heartbeat_timeout");
    }, daemonSilenceMs);
    daemon.timer.unref?.();
  };

  /** Drops the room's daemon and its phones (replacement, deletion or the daemon leaving). */
  const retireDaemon = (room: MachineRoom, code: number | null, reason: string): void => {
    const daemon = room.daemon;
    if (daemon !== null) {
      daemon.retired = true;
      if (daemon.timer !== null) clearTimeout(daemon.timer);
      if (code !== null && (daemon.ws.readyState === WebSocket.OPEN || daemon.ws.readyState === WebSocket.CONNECTING)) daemon.ws.close(code, reason);
    }
    room.daemon = null;
    // The phones were talking to that daemon's Noise sessions: they go with it, and no PEER_CLOSE reaches anyone.
    for (const peer of [...room.peers.values()]) closePeer(room, peer, RelayClose.daemonGone, "daemon_gone", false);
  };

  const pruneRoom = (room: MachineRoom, now: number): void => {
    for (const [id, stone] of room.tombstones) if (stone.expiresAtMs <= now) room.tombstones.delete(id);
    room.replay.prune(Math.floor(now / 1000));
  };

  const addTombstone = (room: MachineRoom, deviceId: string, pub: Buffer, now: number): void => {
    room.tombstones.delete(deviceId);
    if (room.tombstones.size >= L.tombstonesPerMachine) {
      let oldest: string | null = null, oldestAt = Infinity;
      for (const [id, stone] of room.tombstones) if (stone.expiresAtMs < oldestAt) { oldest = id; oldestAt = stone.expiresAtMs; }
      if (oldest !== null) room.tombstones.delete(oldest);
    }
    room.tombstones.set(deviceId, { pub, expiresAtMs: now + L.tombstoneMs });
  };

  const sweep = (): void => {
    const now = nowMs();
    for (const room of [...rooms.values()]) {
      if (room.daemon === null && room.peers.size === 0 && now - room.lastDaemonAtMs >= L.roomIdleDeleteMs) {
        rooms.delete(room.machineId);
        log({ event: "room_gc", machine: idTag(room.machineId) });
        continue;
      }
      pruneRoom(room, now);
    }
  };
  const sweepTimer = setInterval(sweep, 60 * 60 * 1000);
  sweepTimer.unref?.();

  const newRoom = (machineId: string, pub: Buffer, now: number): MachineRoom => ({
    machineId,
    pub,
    devices: new Map(),
    tombstones: new Map(),
    replay: new RelayReplayCache(),
    daemon: null,
    epoch: 0,
    peers: new Map(),
    nextConnId: 1,
    lastDaemonAtMs: now,
    lastActiveMs: now,
    up: new TokenBucket(L.machineUp.bytesPerMin, L.machineUp.bytesBurst, now),
    down: new TokenBucket(L.machineDown.bytesPerMin, L.machineDown.bytesBurst, now),
  });

  // ---- Token admission ----
  const bearer = (req: IncomingMessage): string | null => {
    const auth = req.headers["authorization"];
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
    return auth.slice(7).trim() || null;
  };

  /** The claim rules, after the signature verified. Writes nothing. */
  const checkClaims = (
    parsed: ParsedRelayToken,
    use: "ws" | { method: "PUT" | "POST" | "DELETE"; path: string },
  ): { refusal: Refusal; jti?: never; exp?: never } | { refusal?: never; jti: string; exp: number } => {
    const checked = checkRelayClaims(parsed, { aud: publicHost, use, nowSec: Math.floor(nowMs() / 1000), ...(use === "ws" ? {} : { role: "daemon" as const }) });
    return checked.ok ? { jti: checked.claims.jti, exp: checked.claims.exp } : { refusal: { status: 401, code: checked.code } };
  };

  /** Consumes one use of the jti from its principal's own budget (relay/PROTOCOL.md "Replay"). */
  const consumeJti = (room: MachineRoom, parsed: ParsedRelayToken, jti: string, exp: number): Refusal | null => {
    const consumed = room.replay.consume(replayPrincipalOf(parsed), jti, exp, relayTokenMaxUses(parsed.role), Math.floor(nowMs() / 1000));
    if (consumed === "replayed") return { status: 401, code: "token_invalid" };
    if (consumed === "full") return { status: 429, code: "replay_cache_full", retryAfterSec: 30 };
    return null;
  };

  /** A daemon-signed admission call: token → machine → signature → claims (htm/htu) → jti. */
  const admitDaemonCall = (
    req: IncomingMessage, machineId: string, method: "PUT" | "POST" | "DELETE", path: string,
  ): { room: MachineRoom; refusal?: never } | { refusal: Refusal; room?: never } => {
    const token = bearer(req);
    const parsed = token === null ? null : parseRelayToken(token);
    if (parsed === null) return { refusal: { status: 401, code: "token_invalid" } };
    const room = rooms.get(machineId);
    if (room === undefined) return { refusal: { status: 404, code: "machine_unknown" } };
    if (parsed.machineId !== machineId || !ed25519Verify(room.pub, parsed.signingInput, parsed.signature)) {
      return { refusal: { status: 401, code: "token_invalid" } };
    }
    const claims = checkClaims(parsed, { method, path });
    if (claims.refusal !== undefined) return { refusal: claims.refusal };
    const refusal = consumeJti(room, parsed, claims.jti, claims.exp);
    return refusal === null ? { room } : { refusal };
  };

  // ---- HTTP ----
  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://relay.invalid"); // never the Host header: a bad one must not throw
    const path = url.pathname;
    const route = path.startsWith("/v1/machines/") ? path.replace(/^\/v1\/machines\/[^/]+/, "/v1/machines/:id").replace(/\/devices\/[^/]+$/, "/devices/:id") : path;
    const refuse = (refusal: Refusal, extra: Record<string, unknown> = {}): void => sendRefusal(res, refused(route, refusal, extra));

    if (req.method === "GET" && path === "/v1/health") {
      const shedding = breakerOpen();
      sendJson(res, shedding ? 503 : 200, { ok: !shedding, version: 1, runtime: "reference", build: opts.build ?? "dev", configured: { publicHost: publicHost.length > 0 } });
      return;
    }
    if (breakerOpen()) { refuse({ status: 429, code: "rate_limited", retryAfterSec: 60 }); return; }
    const ip = clientKey(req);

    if (req.method === "POST" && (path === "/v1/challenge" || path === "/v1/machines/register")) {
      const limited = registerLimit.take(ip, nowMs());
      if (limited !== null) { refuse(limited); return; }
      if (path === "/v1/challenge") {
        sendJson(res, 200, { challenge: mintChallenge(), expiresInSec: L.challengeTtlMs / 1000 });
        return;
      }
      const body = await readJsonBody(req, L.registerBodyBytes);
      if (body === null || typeof body["relayMachinePub"] !== "string" || typeof body["challenge"] !== "string" || typeof body["signature"] !== "string") {
        refuse({ status: 400, code: "bad_request" });
        return;
      }
      if (relayKeyOrNull(body["relayMachinePub"]) === null) { refuse({ status: 400, code: "bad_request" }); return; }
      if (!challengeValid(body["challenge"])) { refuse({ status: 401, code: "token_invalid" }); return; }
      const checked = verifyMachineRegistration({
        relayMachinePubB64: body["relayMachinePub"],
        relayHost: publicHost,
        challenge: body["challenge"],
        signatureB64: body["signature"],
      });
      if (!checked.ok) { refuse({ status: 401, code: "token_invalid" }); return; }
      const now = nowMs();
      const existing = rooms.get(checked.machineId);
      if (existing !== undefined) {
        existing.lastActiveMs = now;
      } else {
        if (rooms.size >= maxRooms) {
          // Registration is free, so at the cap the oldest idle room that holds nothing makes way (its Mac registers
          // again on 404). A room holding admitted devices or tombstones is never evicted for a newcomer — only by the
          // 90-day GC — so a registration flood can't erase a real machine's phones or their revocations.
          const now = nowMs();
          let victim: MachineRoom | null = null;
          for (const room of rooms.values()) {
            const idle = room.daemon === null && room.peers.size === 0;
            const empty = room.devices.size === 0 && room.tombstones.size === 0;
            const expired = now - room.lastDaemonAtMs >= L.roomIdleDeleteMs;
            if (idle && (empty || expired) && (victim === null || room.lastActiveMs < victim.lastActiveMs)) victim = room;
          }
          if (victim === null) { refuse({ status: 429, code: "rate_limited", retryAfterSec: 60 }); return; }
          rooms.delete(victim.machineId);
        }
        rooms.set(checked.machineId, newRoom(checked.machineId, checked.publicKey, now));
      }
      sendJson(res, 200, { machineId: checked.machineId });
      return;
    }

    const machineMatch = /^\/v1\/machines\/([a-z2-7]{26})(\/devices(?:\/([^/]*))?)?$/.exec(path);
    const method = req.method;
    if (machineMatch === null || (method !== "PUT" && method !== "POST" && method !== "DELETE")) {
      refuse({ status: 400, code: "bad_request" });
      return;
    }
    const machineId = machineMatch[1]!;
    const devicesPath = machineMatch[2] !== undefined;
    const deviceSegment = machineMatch[3];
    const shapeOk = !devicesPath ? method === "DELETE"
      : deviceSegment === undefined ? method === "PUT" || method === "POST"
        : method === "DELETE";
    if (!shapeOk) { refuse({ status: 400, code: "bad_request" }); return; }
    const limited = clientLimit.take(ip, nowMs()) ?? connectLimit.take(`${machineId}|${ip}`, nowMs());
    if (limited !== null) { refuse(limited); return; }
    const admitted = admitDaemonCall(req, machineId, method, path);
    if (admitted.refusal !== undefined) { refuse(admitted.refusal, { machine: idTag(machineId) }); return; }
    const room = admitted.room;
    const now = nowMs();
    room.lastActiveMs = now;

    if (!devicesPath) {
      // DELETE /v1/machines/:id — the Mac turned phone access off or retires its keys.
      retireDaemon(room, RelayClose.normal, "machine_deleted");
      rooms.delete(machineId);
      log({ event: "machine_deleted", machine: idTag(machineId) });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "DELETE") {
      const deviceId = deviceSegment!;
      if (!RELAY_ID_PATTERN.test(deviceId)) { refuse({ status: 400, code: "bad_request" }); return; }
      const pub = room.devices.get(deviceId);
      if (pub !== undefined) {
        room.devices.delete(deviceId);
        addTombstone(room, deviceId, pub, now);
      }
      for (const peer of [...room.peers.values()]) {
        if (peer.role === "device" && peer.peerId === deviceId) closePeer(room, peer, RelayClose.revoked, "device_revoked", true);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST") {
      const body = await readJsonBody(req, L.postBodyBytes);
      const deviceId = body?.["deviceId"];
      const pub = relayKeyOrNull(body?.["deviceRelayPub"]);
      if (typeof deviceId !== "string" || !RELAY_ID_PATTERN.test(deviceId) || pub === null) { refuse({ status: 400, code: "bad_request" }); return; }
      if (rooms.get(machineId) !== room) { refuse({ status: 404, code: "machine_unknown" }); return; } // deleted during the body read
      const current = room.devices.get(deviceId);
      if (current === undefined && room.devices.size >= L.devicesPerMachine) { refuse({ status: 400, code: "bad_request" }); return; }
      if (current !== undefined && !current.equals(pub)) supersedeDevice(room, deviceId);
      room.devices.set(deviceId, pub);
      room.tombstones.delete(deviceId);
      sendJson(res, 200, { ok: true });
      return;
    }

    // PUT: replace the whole admitted set in one step. Devices that left it get a tombstone with their stored key.
    const body = await readJsonBody(req, L.putBodyBytes);
    const list = body?.["devices"];
    if (!Array.isArray(list) || list.length > L.devicesPerMachine) { refuse({ status: 400, code: "bad_request" }); return; }
    const next = new Map<string, Buffer>();
    for (const item of list) {
      const entry = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
      const deviceId = entry?.["deviceId"];
      const pub = relayKeyOrNull(entry?.["deviceRelayPub"]);
      if (typeof deviceId !== "string" || !RELAY_ID_PATTERN.test(deviceId) || pub === null || next.has(deviceId)) {
        refuse({ status: 400, code: "bad_request" });
        return;
      }
      next.set(deviceId, pub);
    }
    if (rooms.get(machineId) !== room) { refuse({ status: 404, code: "machine_unknown" }); return; }
    for (const [deviceId, pub] of room.devices) {
      if (!next.has(deviceId)) addTombstone(room, deviceId, pub, now);
    }
    const previous = room.devices;
    room.devices = next;
    for (const deviceId of next.keys()) room.tombstones.delete(deviceId);
    for (const peer of [...room.peers.values()]) {
      if (peer.role !== "device") continue;
      if (!next.has(peer.peerId)) closePeer(room, peer, RelayClose.revoked, "device_revoked", true);
      else if (!previous.get(peer.peerId)?.equals(next.get(peer.peerId)!)) closePeer(room, peer, RelayClose.superseded, "superseded", true);
    }
    sendJson(res, 200, { ok: true, devices: next.size });
  };

  /** A device's key changed: its open sockets were admitted with the old key. */
  const supersedeDevice = (room: MachineRoom, deviceId: string): void => {
    for (const peer of [...room.peers.values()]) {
      if (peer.role === "device" && peer.peerId === deviceId) closePeer(room, peer, RelayClose.superseded, "superseded", true);
    }
  };

  const httpServer: Server = createServer((req, res) => {
    handleHttp(req, res).catch(() => {
      if (!res.headersSent) sendRefusal(res, { status: 400, code: "bad_request" });
      else res.destroy();
    });
  });
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 15_000;
  httpServer.keepAliveTimeout = 5_000;

  // Frames up to twice the cap reach the relay and get its 4400; anything bigger is refused by `ws` itself (1009).
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_DAEMON_WS_FRAME_BYTES * 2 });

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      upgrade(req, socket, head);
    } catch {
      rejectUpgrade(socket, { status: 400, code: "bad_request" });
    }
  });

  /** WS /v1/connect — relay/PROTOCOL.md "Connect order". Everything here is synchronous (Node's Ed25519 verify included),
   * so the state read before the signature check is still the state when the slot is reserved. */
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    const reject = (refusal: Refusal, extra: Record<string, unknown> = {}): void => rejectUpgrade(socket, refused("/v1/connect", refusal, extra));
    if (url.pathname !== "/v1/connect") { reject({ status: 400, code: "bad_request" }); return; }
    if (breakerOpen()) { reject({ status: 429, code: "rate_limited", retryAfterSec: 60 }); return; }
    const ip = clientKey(req);
    if ((socketsByIp.get(ip) ?? 0) >= maxSocketsPerIp) { reject({ status: 429, code: "rate_limited", retryAfterSec: 30 }); return; }
    const clientLimited = clientLimit.take(ip, nowMs());
    if (clientLimited !== null) { reject(clientLimited); return; }
    const token = bearer(req);
    const parsed = token === null ? null : parseRelayToken(token);
    if (parsed === null) { reject({ status: 401, code: "token_invalid" }); return; }
    const tag = { role: parsed.role, machine: idTag(parsed.machineId) };
    const limited = connectLimit.take(`${parsed.machineId}|${ip}`, nowMs());
    if (limited !== null) { reject(limited, tag); return; }
    const room = rooms.get(parsed.machineId);
    if (room === undefined) { reject({ status: 404, code: "machine_unknown" }, tag); return; }

    let verifyKey: Buffer;
    let revoked = false;
    if (parsed.role === "device") {
      const live = room.devices.get(parsed.deviceId!);
      const stone = live === undefined ? room.tombstones.get(parsed.deviceId!) : undefined;
      if (live === undefined && stone === undefined) {
        reject(liveDaemon(room) === null ? { status: 503, code: "daemon_unavailable" } : { status: 404, code: "device_unknown" }, tag);
        return;
      }
      verifyKey = live ?? stone!.pub;
      revoked = live === undefined;
    } else {
      verifyKey = room.pub;
    }
    if (!ed25519Verify(verifyKey, parsed.signingInput, parsed.signature)) { reject({ status: 401, code: "token_invalid" }, tag); return; }
    const claims = checkClaims(parsed, "ws");
    if (claims.refusal !== undefined) { reject(claims.refusal, tag); return; }
    // A revoked device is told so before its jti is consumed: it never writes to the replay cache.
    if (revoked) { reject({ status: 403, code: "device_revoked" }, tag); return; }
    const replay = consumeJti(room, parsed, claims.jti, claims.exp);
    if (replay !== null) { reject(replay, tag); return; }

    if (parsed.role === "daemon") {
      wss.handleUpgrade(req, socket, head, ws => attachDaemon(room, ws, ip));
      return;
    }
    if (liveDaemon(room) === null) { reject({ status: 503, code: "daemon_unavailable" }, tag); return; }
    const peerId = parsed.deviceId ?? parsed.pairSessionId!;
    const others = [...room.peers.values()].filter(peer => !(parsed.role === "device" && peer.role === "device" && peer.peerId === peerId));
    if (others.length >= L.socketsPerMachine) { reject({ status: 429, code: "too_many_peers", retryAfterSec: 5 }, tag); return; }
    // `ws` completes an upgrade without verifyClient synchronously, so the slot is taken in this same turn.
    wss.handleUpgrade(req, socket, head, ws => {
      if (parsed.role === "device") {
        for (const peer of [...room.peers.values()]) {
          if (peer.role === "device" && peer.peerId === peerId) closePeer(room, peer, RelayClose.superseded, "superseded", true);
        }
      }
      attachPeer(room, ws, parsed.role as "pair" | "device", peerId, ip);
    });
  };

  const trackIp = (ws: WebSocket, ip: string): void => {
    socketsByIp.set(ip, (socketsByIp.get(ip) ?? 0) + 1);
    ws.once("close", () => {
      const left = (socketsByIp.get(ip) ?? 1) - 1;
      if (left <= 0) socketsByIp.delete(ip); else socketsByIp.set(ip, left);
    });
  };

  const attachDaemon = (room: MachineRoom, ws: WebSocket, ip: string): void => {
    trackIp(ws, ip);
    // A newer daemon proved the machine key: the old one gets 4409 and its phones go with it.
    if (room.daemon !== null) retireDaemon(room, RelayClose.superseded, "superseded");
    room.epoch += 1;
    const daemon: DaemonConn = { ws, epoch: room.epoch, retired: false, timer: null };
    room.daemon = daemon;
    room.lastDaemonAtMs = nowMs();
    room.lastActiveMs = room.lastDaemonAtMs;
    armDaemonTimer(room, daemon);

    ws.on("message", (raw, isBinary) => {
      if (daemon.retired) return;
      armDaemonTimer(room, daemon);
      if (!isBinary) { ws.close(RelayClose.protocol, "binary_only"); return; }
      const buf = rawDataToBuffer(raw);
      if (buf.length < RELAY_ENVELOPE_HEADER_BYTES || buf.length > MAX_DAEMON_WS_FRAME_BYTES) { ws.close(RelayClose.protocol, "oversize"); return; }
      const op = buf[0]!;
      const connId = buf.readUInt32BE(1);
      const payload = buf.subarray(RELAY_ENVELOPE_HEADER_BYTES);
      if (op === RelayOp.HEARTBEAT) {
        if (connId !== 0 || payload.length !== HEARTBEAT_PAYLOAD_BYTES) { ws.close(RelayClose.protocol, "protocol"); return; }
        ws.send(encodeRelayEnvelope({ op: RelayOp.HEARTBEAT_ACK, connId: 0, payload }), { binary: true });
        return;
      }
      if (op === RelayOp.PEER_CLOSE) {
        const peer = room.peers.get(connId);
        if (peer !== undefined) closePeer(room, peer, RelayClose.normal, "closed_by_daemon", false);
        return;
      }
      if (op !== RelayOp.PEER_DATA) { ws.close(RelayClose.protocol, "protocol"); return; }
      const peer = room.peers.get(connId);
      if (peer === undefined || peer.closed) return; // a late frame for a phone that is gone
      const t = nowMs();
      // Over its own downstream budget or the machine's, only that phone is closed (the frame isn't sent; an unsent
      // frame would break its Noise stream anyway). Never the daemon.
      if (!peer.down.take(payload.length, t) || !room.down.take(payload.length, t)) {
        closePeer(room, peer, RelayClose.rateLimited, "rate_limited", true);
        return;
      }
      countForwarded();
      armPeerTimer(room, peer); // idle counts traffic in either direction
      peer.ws.send(payload, { binary: true });
    });

    ws.on("close", () => {
      if (daemon.timer !== null) clearTimeout(daemon.timer);
      if (room.daemon !== daemon) return; // superseded or deleted: the room already moved on
      log({ event: "close", leg: "daemon", machine: idTag(room.machineId) });
      retireDaemon(room, null, "daemon_gone");
    });
    ws.on("error", () => {});
  };

  const attachPeer = (room: MachineRoom, ws: WebSocket, role: "pair" | "device", peerId: string, ip: string): void => {
    trackIp(ws, ip);
    const connId = room.nextConnId;
    room.nextConnId = room.nextConnId >= 0xffff_fff0 ? 1 : room.nextConnId + 1;
    const t0 = nowMs();
    const peer: PeerConn = {
      connId, ws, role, peerId, closed: false, firstFrame: false, timer: null,
      frames: new TokenBucket(L.phoneUp.framesPerMin, L.phoneUp.framesBurst, t0),
      bytes: new TokenBucket(L.phoneUp.bytesPerMin, L.phoneUp.bytesBurst, t0),
      down: new TokenBucket(L.phoneDown.bytesPerMin, L.phoneDown.bytesBurst, t0),
    };
    room.peers.set(connId, peer);
    armPeerTimer(room, peer);
    liveDaemon(room)?.ws.send(encodeRelayEnvelope({
      op: RelayOp.PEER_OPEN,
      connId,
      payload: Buffer.from(JSON.stringify({ role, id: peerId }), "utf8"),
    }), { binary: true });

    ws.on("message", (raw, isBinary) => {
      if (peer.closed) return; // dropped while its close handshake runs: nothing more is forwarded
      peer.firstFrame = true;
      armPeerTimer(room, peer);
      if (!isBinary) { closePeer(room, peer, RelayClose.protocol, "binary_only", true); return; }
      const buf = rawDataToBuffer(raw);
      if (buf.length > MAX_NOISE_MESSAGE_BYTES) { closePeer(room, peer, RelayClose.protocol, "oversize", true); return; }
      if (breakerOpen()) { closePeer(room, peer, RelayClose.rateLimited, "rate_limited", true); return; }
      const t = nowMs();
      if (!peer.frames.take(1, t) || !peer.bytes.take(buf.length, t) || !room.up.take(buf.length, t)) {
        closePeer(room, peer, RelayClose.rateLimited, "rate_limited", true);
        return;
      }
      const daemon = liveDaemon(room);
      if (daemon === null) { closePeer(room, peer, RelayClose.daemonGone, "daemon_gone", false); return; }
      countForwarded();
      daemon.ws.send(encodeRelayEnvelope({ op: RelayOp.PEER_DATA, connId, payload: buf }), { binary: true });
    });

    ws.on("close", () => {
      if (peer.closed) return;
      peer.closed = true;
      if (peer.timer !== null) clearTimeout(peer.timer);
      room.peers.delete(connId);
      sendPeerClose(room, connId, "peer_closed");
    });
    ws.on("error", () => {});
  };

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const bindHost = opts.host ?? "127.0.0.1";
  if (publicHost.length === 0) publicHost = `${bindHost}:${port}`.toLowerCase();

  return {
    url: `http://${bindHost}:${port}`,
    wsUrl: `ws://${bindHost}:${port}/v1/connect`,
    port,
    publicHost,
    sweep,
    stats: () => ({ machines: rooms.size, forwardedThisWindow }),
    replayRows: machineId => rooms.get(machineId)?.replay.size ?? null,
    close: async () => {
      clearInterval(sweepTimer);
      for (const room of rooms.values()) {
        for (const peer of [...room.peers.values()]) closePeer(room, peer, 1001, "relay_shutdown", false);
        if (room.daemon !== null) {
          room.daemon.retired = true;
          if (room.daemon.timer !== null) clearTimeout(room.daemon.timer);
          room.daemon.ws.close(1001, "relay_shutdown");
        }
      }
      for (const client of wss.clients) client.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      httpServer.closeAllConnections();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    },
  };
}
