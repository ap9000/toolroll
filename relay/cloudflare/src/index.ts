/**
 * Cloudflare Workers + Durable Object (WebSocket Hibernation) hosting adapter
 * for the Toolroll Companion Relay (`relay/PROTOCOL.md`).
 *
 * One hosting option implementing the exact same v1 wire contract as `src/companion/relay-server.ts`.
 * Holds zero Noise keys, never sees plaintext RPC payloads, and enforces Ed25519 pre-upgrade admission,
 * deterministic machineId ownership, 5-byte connId multi-phone routing, 65,535 B frame cap, and rate caps.
 */

const MAX_NOISE_MESSAGE_BYTES = 65_535;
const RELAY_ENVELOPE_HEADER_BYTES = 5;
const MAX_DAEMON_WS_FRAME_BYTES = MAX_NOISE_MESSAGE_BYTES + RELAY_ENVELOPE_HEADER_BYTES;
const MAX_RELAY_TOKEN_TTL_SEC = 300;
const MAX_PHONES_PER_MACHINE = 4;
/** Paired phones one machine may admit (the Mac's live paired devices). */
const MAX_DEVICES_PER_MACHINE = 32;
const MAX_ID_LENGTH = 128;
/** Per phone socket, per minute (PROTOCOL.md data-plane limits). */
const PHONE_FRAMES_PER_MIN = 600;
const PHONE_BYTES_PER_MIN = 4 * 1024 * 1024;
/** Per machine, per minute, in each direction: phones → daemon over it closes the sending phone; daemon → phones over it
 * closes the phone being sent to. Never the daemon, so one phone can't cut the others off. */
const MACHINE_BYTES_PER_MIN = 32 * 1024 * 1024; // each direction
/** A phone socket that has sent nothing for this long is closed (the app pings well within it). */
const PHONE_IDLE_MS = 90_000;
/** A phone socket must send its first message (Noise message 1) within this. */
const PHONE_FIRST_FRAME_MS = 10_000;
const SWEEP_MS = 15_000;
const RFC4648_LOWER = "abcdefghijklmnopqrstuvwxyz234567";

const OP_PEER_OPEN = 0x01;
const OP_PEER_DATA = 0x02;
const OP_PEER_CLOSE = 0x03;

/** A Workers Rate Limiting binding (wrangler.jsonc `ratelimits`). */
interface RateLimit { limit(options: { key: string }): Promise<{ success: boolean }> }

interface Env {
  MACHINE_ROOM: DurableObjectNamespace;
  /** Per client address: registration challenges and registrations (each can wake a machine room). */
  RL_REGISTER?: RateLimit;
  /** Per client address: WebSocket connects and device-set changes. */
  RL_CONNECT?: RateLimit;
  RELAY_PUBLIC_HOST: string;
  /** HMAC key for stateless registration challenges (`wrangler secret put CHALLENGE_SECRET`). */
  CHALLENGE_SECRET: string;
  APNS_TOPIC?: string;
  APNS_ENVIRONMENT?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY_P8?: string;
}

interface RelayTokenClaims {
  v: 1;
  role: "daemon" | "pair" | "device";
  machineId: string;
  deviceId?: string;
  pairSessionId?: string;
  jti: string;
  iat: number;
  exp: number;
}

function fromB64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base32Lower(data: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += RFC4648_LOWER[(acc >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += RFC4648_LOWER[(acc << (5 - bits)) & 0x1f];
  return out;
}

async function deriveMachineId(pubKey: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode("toolroll-machine-id-v1\0");
  const buf = new Uint8Array(prefix.length + pubKey.length);
  buf.set(prefix, 0);
  buf.set(pubKey, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return base32Lower(digest).slice(0, 26);
}

async function verifyEd25519(pubRaw: Uint8Array, message: Uint8Array, sig: Uint8Array): Promise<boolean> {
  if (pubRaw.length !== 32 || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", pubRaw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, sig, message);
  } catch {
    return false;
  }
}

function parseToken(token: string): { claims: RelayTokenClaims; input: Uint8Array; sig: Uint8Array } | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64Url(parts[0]))) as Partial<RelayTokenClaims>;
    const id = (value: unknown): boolean => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
    if (
      claims.v !== 1
      || (claims.role !== "daemon" && claims.role !== "pair" && claims.role !== "device")
      || typeof claims.machineId !== "string" || !/^[a-z2-7]{26}$/.test(claims.machineId)
      || typeof claims.iat !== "number" || typeof claims.exp !== "number"
      || !id(claims.jti)
      || (claims.deviceId !== undefined && !id(claims.deviceId))
      || (claims.pairSessionId !== undefined && !id(claims.pairSessionId))
      || (claims.role === "device" && claims.deviceId === undefined)
      || (claims.role === "pair" && claims.pairSessionId === undefined)
    ) return null;
    return {
      claims: claims as RelayTokenClaims,
      input: new TextEncoder().encode(`tr-relay-v1.${parts[0]}`),
      sig: fromB64Url(parts[1]),
    };
  } catch {
    return null;
  }
}

async function verifyToken(token: string, pubKey: Uint8Array): Promise<RelayTokenClaims | null> {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (parsed.claims.exp - parsed.claims.iat > MAX_RELAY_TOKEN_TTL_SEC + 5) return null;
  if (nowSec > parsed.claims.exp + 30 || nowSec + 30 < parsed.claims.iat) return null;
  const ok = await verifyEd25519(pubKey, parsed.input, parsed.sig);
  return ok ? parsed.claims : null;
}

function encodeEnvelope(op: number, connId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(RELAY_ENVELOPE_HEADER_BYTES + payload.length);
  out[0] = op;
  new DataView(out.buffer).setUint32(1, connId >>> 0, false);
  out.set(payload, RELAY_ENVELOPE_HEADER_BYTES);
  return out;
}

/** A registration challenge with no storage: 16 random bytes, an expiry, and an HMAC over both. Unauthenticated callers
 * can ask for as many as they like without writing anything. A replay inside its minute only re-registers the same
 * machine key (machine ids are derived from the key), which changes nothing. */
async function challengeKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function mintChallenge(secret: string, nowMs: number): Promise<string> {
  const body = new Uint8Array(24);
  body.set(crypto.getRandomValues(new Uint8Array(16)), 0);
  new DataView(body.buffer).setBigUint64(16, BigInt(nowMs + 60_000), false);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await challengeKey(secret), body));
  const out = new Uint8Array(body.length + mac.length);
  out.set(body, 0);
  out.set(mac, body.length);
  return toB64Url(out);
}
async function challengeValid(secret: string, challenge: string, nowMs: number): Promise<boolean> {
  let raw: Uint8Array;
  try { raw = fromB64Url(challenge); } catch { return false; }
  if (raw.length !== 24 + 32) return false;
  const body = raw.subarray(0, 24), mac = raw.subarray(24);
  if (!(await crypto.subtle.verify("HMAC", await challengeKey(secret), mac, body))) return false;
  return Number(new DataView(body.buffer, body.byteOffset, 24).getBigUint64(16, false)) > nowMs;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The rate-limit key for a client address: an IPv6 client is keyed by its /64 (one subscriber's whole prefix). */
function rateKeyOf(ip: string | null): string {
  if (ip === null || ip.length === 0) return "no-ip";
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head!.split(":").filter(Boolean);
  const right = tail.split(":").filter(Boolean);
  const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${full.slice(0, 4).join(":")}::/64`;
}

/** Decodes base64url, or null for anything that isn't. */
function b64OrNull(s: unknown): Uint8Array | null {
  if (typeof s !== "string") return null;
  try { return fromB64Url(s); } catch { return null; }
}

/** A sliding one-minute token bucket (in memory: it resets only when the room hibernates, i.e. when it's idle). */
class MinuteBucket {
  private tokens: number;
  private at = Date.now();
  constructor(private readonly perMinute: number) { this.tokens = perMinute; }
  take(n: number): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.at) / 60_000) * this.perMinute);
    this.at = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/health") {
      return jsonResponse(200, { ok: true, version: 1, runtime: "cloudflare-do" });
    }
    // Everything past health is rate limited per client address before any work (a made-up machine id still wakes a
    // room). Without the bindings (local dev, self-hosters who skip them) nothing is limited.
    const client = rateKeyOf(request.headers.get("cf-connecting-ip"));
    const limiter = url.pathname === "/v1/challenge" || url.pathname === "/v1/machines/register" ? env.RL_REGISTER : env.RL_CONNECT;
    if (limiter !== undefined && !(await limiter.limit({ key: client })).success) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    if (request.method === "POST" && url.pathname === "/v1/challenge") {
      if (!env.CHALLENGE_SECRET) return jsonResponse(503, { error: "relay_not_configured" });
      return jsonResponse(200, { challenge: await mintChallenge(env.CHALLENGE_SECRET, Date.now()), expiresInSec: 60 });
    }
    if (request.method === "POST" && url.pathname === "/v1/machines/register") {
      if (Number(request.headers.get("content-length") ?? "0") > 4096) return jsonResponse(413, { error: "too_large" });
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body["relayMachinePub"] !== "string" || typeof body["challenge"] !== "string" || typeof body["signature"] !== "string") {
        return jsonResponse(400, { error: "invalid_body" });
      }
      if (!env.CHALLENGE_SECRET || !(await challengeValid(env.CHALLENGE_SECRET, body["challenge"], Date.now()))) {
        return jsonResponse(401, { error: "invalid_or_expired_challenge" });
      }
      let pubKey: Uint8Array;
      try { pubKey = fromB64Url(body["relayMachinePub"]); } catch { return jsonResponse(400, { error: "invalid_body" }); }
      if (pubKey.length !== 32) return jsonResponse(400, { error: "invalid_body" });
      const host = env.RELAY_PUBLIC_HOST || url.host;
      const popMsg = new TextEncoder().encode(`register\0${host}\0${body["challenge"]}`);
      let signature: Uint8Array;
      try { signature = fromB64Url(body["signature"]); } catch { return jsonResponse(400, { error: "invalid_body" }); }
      const ok = await verifyEd25519(pubKey, popMsg, signature);
      if (!ok) return jsonResponse(401, { error: "invalid_pop_signature" });

      const machineId = await deriveMachineId(pubKey);
      const roomStub = env.MACHINE_ROOM.get(env.MACHINE_ROOM.idFromName(machineId));
      return roomStub.fetch("https://do/register", {
        method: "POST",
        body: JSON.stringify({ machineId, relayMachinePub: body["relayMachinePub"] }),
      });
    }

    // Route machine device management and WebSocket connect directly to the machine's DO shard.
    const devMatch = /^\/v1\/machines\/([a-z2-7]{26})\/devices(?:\/([^/]+))?$/.exec(url.pathname);
    if (devMatch) {
      const roomStub = env.MACHINE_ROOM.get(env.MACHINE_ROOM.idFromName(devMatch[1]!));
      return roomStub.fetch(request);
    }

    if (url.pathname === "/v1/connect") {
      const auth = request.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer ")) return jsonResponse(401, { error: "missing_token" });
      const parsed = parseToken(auth.slice(7).trim());
      if (!parsed) return jsonResponse(401, { error: "malformed_token" });
      const roomStub = env.MACHINE_ROOM.get(env.MACHINE_ROOM.idFromName(parsed.claims.machineId));
      return roomStub.fetch(request);
    }

    return jsonResponse(404, { error: "not_found" });
  },
};

interface SocketAttachment {
  role: "daemon" | "pair" | "device";
  connId: number;
  peerId: string;
  /** When the socket opened (ms), for the first-message deadline. */
  openedAt?: number;
}

/** A socket's attachment, or null for a socket that has none (never a thrown error). */
function attachmentOf(ws: WebSocket): SocketAttachment | null {
  try { return ws.deserializeAttachment() as SocketAttachment | null; } catch { return null; }
}

/** Sends, ignoring a socket that has just closed (its close handler does the bookkeeping). */
function sendQuietly(ws: WebSocket, data: Uint8Array): void {
  try { ws.send(data); } catch { /* closed */ }
}

export class MachineRoomDO {
  private readonly state: DurableObjectState;
  /** Per phone socket: its frame and byte buckets and when it last sent anything (in memory, reset on hibernation). */
  private readonly phones = new Map<WebSocket, { frames: MinuteBucket; bytes: MinuteBucket; lastAt: number }>();
  /** Phones → daemon, all phones of this machine together. */
  private readonly machineBytes = new MinuteBucket(MACHINE_BYTES_PER_MIN);
  /** Daemon → phones: its own budget, so phones can't spend it and a flooding daemon only loses the phone it floods. */
  private readonly daemonBytes = new MinuteBucket(MACHINE_BYTES_PER_MIN);

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private phoneOf(ws: WebSocket) {
    let entry = this.phones.get(ws);
    if (entry === undefined) {
      entry = { frames: new MinuteBucket(PHONE_FRAMES_PER_MIN), bytes: new MinuteBucket(PHONE_BYTES_PER_MIN), lastAt: Date.now() };
      this.phones.set(ws, entry);
    }
    return entry;
  }

  private async ensureSweep(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  /** Closes phone sockets that never sent a first message, or went quiet; re-arms while any phone is connected. */
  async alarm(): Promise<void> {
    const now = Date.now();
    let phones = 0;
    for (const ws of this.state.getWebSockets()) {
      const att = attachmentOf(ws);
      if (att === null || att.role === "daemon") continue;
      const seen = this.phones.get(ws);
      const quietSince = seen?.lastAt ?? att.openedAt ?? now;
      const limit = seen === undefined ? PHONE_FIRST_FRAME_MS : PHONE_IDLE_MS;
      if (now - quietSince > limit) { try { ws.close(1000, seen === undefined ? "first_frame_timeout" : "idle_timeout"); } catch { /* closing */ } continue; }
      phones += 1;
    }
    if (phones > 0) await this.state.storage.setAlarm(now + SWEEP_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      const { machineId, relayMachinePub } = (await request.json()) as { machineId: string; relayMachinePub: string };
      // The id is derived from the key, so a stored key never changes: write only the first time.
      if ((await this.state.storage.get<string>("relayMachinePub")) !== relayMachinePub) {
        await this.state.storage.put({ machineId, relayMachinePub });
      }
      return jsonResponse(200, { machineId });
    }

    const machinePubB64 = await this.state.storage.get<string>("relayMachinePub");
    if (!machinePubB64) return jsonResponse(401, { error: "unknown_machine" });
    const machinePub = fromB64Url(machinePubB64);

    // Device registration / revocation
    const devMatch = /^\/v1\/machines\/([a-z2-7]{26})\/devices(?:\/([^/]+))?$/.exec(url.pathname);
    if (devMatch) {
      const auth = request.headers.get("authorization") ?? "";
      const claims = auth.startsWith("Bearer ") ? await verifyToken(auth.slice(7).trim(), machinePub) : null;
      if (!claims || claims.role !== "daemon" || claims.machineId !== devMatch[1]) {
        return jsonResponse(401, { error: "unauthorized" });
      }
      if (request.method === "POST" && !devMatch[2]) {
        const body = (await request.json().catch(() => null)) as { deviceId?: unknown; deviceRelayPub?: unknown } | null;
        if (typeof body?.deviceId !== "string" || body.deviceId.length === 0 || body.deviceId.length > MAX_ID_LENGTH
          || typeof body.deviceRelayPub !== "string" || b64OrNull(body.deviceRelayPub)?.length !== 32) {
          return jsonResponse(400, { error: "invalid_body" });
        }
        const key = `dev:${body.deviceId}`, current = await this.state.storage.get<string>(key);
        if (current === undefined && (await this.state.storage.list({ prefix: "dev:" })).size >= MAX_DEVICES_PER_MACHINE) {
          return jsonResponse(409, { error: "too_many_devices" });
        }
        if (current !== body.deviceRelayPub) await this.state.storage.put(key, body.deviceRelayPub);
        return jsonResponse(200, { ok: true, deviceId: body.deviceId });
      }
      // Replace the whole admitted set (the daemon reconciles after every connect); a phone that left it is closed.
      if (request.method === "PUT" && !devMatch[2]) {
        const body = (await request.json().catch(() => null)) as { devices?: unknown } | null;
        const list = Array.isArray(body?.devices) ? (body!.devices as unknown[]) : null;
        if (list === null || list.length > MAX_DEVICES_PER_MACHINE) return jsonResponse(400, { error: "invalid_body" });
        const next = new Map<string, string>();
        for (const item of list) {
          const entry = item !== null && typeof item === "object" ? (item as { deviceId?: unknown; deviceRelayPub?: unknown }) : null;
          if (typeof entry?.deviceId !== "string" || entry.deviceId.length === 0 || entry.deviceId.length > MAX_ID_LENGTH
            || typeof entry.deviceRelayPub !== "string" || b64OrNull(entry.deviceRelayPub)?.length !== 32) {
            return jsonResponse(400, { error: "invalid_body" });
          }
          next.set(entry.deviceId, entry.deviceRelayPub);
        }
        // Only what changed is written (the Mac sends the full set on every connect).
        const existing = await this.state.storage.list<string>({ prefix: "dev:" });
        const gone = [...existing.keys()].filter(key => !next.has(key.slice(4)));
        const changed = Object.fromEntries([...next].filter(([deviceId, pub]) => existing.get(`dev:${deviceId}`) !== pub).map(([deviceId, pub]) => [`dev:${deviceId}`, pub]));
        if (gone.length > 0) await this.state.storage.delete(gone);
        if (Object.keys(changed).length > 0) await this.state.storage.put(changed);
        for (const ws of this.state.getWebSockets()) {
          const att = ws.deserializeAttachment() as SocketAttachment | null;
          if (att?.role === "device" && !next.has(att.peerId)) ws.close(1000, "device_revoked");
        }
        return jsonResponse(200, { ok: true, devices: next.size });
      }
      if (request.method === "DELETE" && devMatch[2]) {
        let deviceId: string;
        try { deviceId = decodeURIComponent(devMatch[2]); } catch { return jsonResponse(400, { error: "invalid_device_id" }); }
        await this.state.storage.delete(`dev:${deviceId}`);
        for (const ws of this.state.getWebSockets()) {
          const att = ws.deserializeAttachment() as SocketAttachment | null;
          if (att?.role === "device" && att.peerId === deviceId) {
            ws.close(1000, "device_revoked");
          }
        }
        return jsonResponse(200, { ok: true, revoked: deviceId });
      }
    }

    // WebSocket upgrade (/v1/connect)
    if (url.pathname === "/v1/connect" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const parsed = parseToken(token);
      if (!parsed) return jsonResponse(401, { error: "malformed_token" });

      let verifyKey: Uint8Array | null = null;
      if (parsed.claims.role === "daemon" || parsed.claims.role === "pair") {
        verifyKey = machinePub;
      } else if (parsed.claims.role === "device" && parsed.claims.deviceId) {
        const devPubB64 = await this.state.storage.get<string>(`dev:${parsed.claims.deviceId}`);
        verifyKey = devPubB64 ? fromB64Url(devPubB64) : null;
      }
      if (!verifyKey) return jsonResponse(403, { error: "unknown_or_revoked_device" });
      const claims = await verifyToken(token, verifyKey);
      if (!claims) return jsonResponse(401, { error: "invalid_token" });
      // The signature check awaited: a removal may have landed meanwhile, so the device must still be admitted now.
      if (claims.role === "device" && (await this.state.storage.get<string>(`dev:${claims.deviceId}`)) === undefined) {
        return jsonResponse(403, { error: "unknown_or_revoked_device" });
      }

      const activeSockets = this.state.getWebSockets();
      const daemonNow = activeSockets.find(s => attachmentOf(s)?.role === "daemon");
      const peerCount = activeSockets.filter(s => attachmentOf(s)?.role !== "daemon").length;
      if (claims.role !== "daemon" && peerCount >= MAX_PHONES_PER_MACHINE) {
        return jsonResponse(429, { error: "too_many_peers" });
      }
      // A phone with no Mac connected has nobody to talk to: refused now, so the app says it can't reach the Mac.
      if (claims.role !== "daemon" && daemonNow === undefined) {
        return jsonResponse(503, { error: "daemon_unavailable" });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      // Phone ids are never reused while the room exists: a counter in durable storage (it survives hibernation, where
      // an in-memory one wouldn't). Taking max(active)+1 could hand a closed phone's id to a new one before the closed
      // one's PEER_CLOSE reached the Mac, which would then drop the newcomer.
      let connId = 0;
      if (claims.role !== "daemon") {
        const last = (await this.state.storage.get<number>("nextConnId")) ?? Math.max(0, ...activeSockets.map(s => attachmentOf(s)?.connId ?? 0));
        connId = last >= 0xffff_fff0 ? 1 : last + 1;
        await this.state.storage.put("nextConnId", connId);
      }
      if (claims.role === "daemon") {
        // A new daemon replaces the old (it proved the machine key); the old one's phones go with it.
        for (const s of activeSockets) s.close(1000, attachmentOf(s)?.role === "daemon" ? "replaced_by_new_daemon" : "daemon_replaced");
      }
      const attachment: SocketAttachment = {
        role: claims.role,
        connId,
        peerId: claims.deviceId ?? claims.pairSessionId ?? "daemon",
        openedAt: Date.now(),
      };
      this.state.acceptWebSocket(server);
      server.serializeAttachment(attachment);
      if (claims.role !== "daemon") await this.ensureSweep();

      if (claims.role !== "daemon" && daemonNow !== undefined) {
        sendQuietly(daemonNow, encodeEnvelope(OP_PEER_OPEN, connId, new TextEncoder().encode(JSON.stringify({ role: claims.role, id: attachment.peerId }))));
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    return jsonResponse(404, { error: "not_found" });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === "string") {
      ws.close(1003, "binary_required");
      return;
    }
    const bytes = new Uint8Array(message);
    const att = attachmentOf(ws);
    if (!att) {
      ws.close(1008, "unattached");
      return;
    }
    const sockets = this.state.getWebSockets();

    if (att.role === "daemon") {
      if (bytes.length < RELAY_ENVELOPE_HEADER_BYTES || bytes.length > MAX_DAEMON_WS_FRAME_BYTES) {
        ws.close(1009, "invalid_frame_size");
        return;
      }
      const op = bytes[0]!;
      const connId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
      const target = connId === 0 ? undefined : sockets.find(s => attachmentOf(s)?.connId === connId);
      if (op === OP_PEER_CLOSE) {
        target?.close(1000, "closed_by_daemon");
      } else if (op === OP_PEER_DATA && target) {
        // Over the daemon's own budget: that phone is closed (the frame isn't sent); the daemon and other phones stay.
        if (!this.daemonBytes.take(bytes.length)) { target.close(1008, "rate_limited"); return; }
        sendQuietly(target, bytes.subarray(RELAY_ENVELOPE_HEADER_BYTES));
      }
      return;
    }

    if (bytes.length > MAX_NOISE_MESSAGE_BYTES) {
      ws.close(1009, "frame_too_large");
      return;
    }
    const phone = this.phoneOf(ws);
    phone.lastAt = Date.now();
    if (!phone.frames.take(1) || !phone.bytes.take(bytes.length) || !this.machineBytes.take(bytes.length)) {
      ws.close(1008, "rate_limited");
      return;
    }
    const daemon = sockets.find(s => attachmentOf(s)?.role === "daemon");
    if (!daemon) {
      ws.close(1000, "daemon_unavailable");
      return;
    }
    sendQuietly(daemon, encodeEnvelope(OP_PEER_DATA, att.connId, bytes));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.phones.delete(ws);
    const att = attachmentOf(ws);
    if (!att) return;
    const sockets = this.state.getWebSockets().filter(s => s !== ws);
    if (att.role === "daemon") {
      // Only when no other daemon has taken over (a replacement closes the old one too).
      if (sockets.some(s => attachmentOf(s)?.role === "daemon")) return;
      for (const s of sockets) {
        if (attachmentOf(s)?.role !== "daemon") s.close(1000, "daemon_disconnected");
      }
    } else {
      const daemon = sockets.find(s => attachmentOf(s)?.role === "daemon");
      if (daemon) {
        sendQuietly(daemon, encodeEnvelope(OP_PEER_CLOSE, att.connId, new TextEncoder().encode(JSON.stringify({ reason: "peer_closed" }))));
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
