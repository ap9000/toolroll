/**
 * The relay contract as the Cloudflare worker implements it (normative: relay/PROTOCOL.md). Pure functions and
 * constants only — no Workers globals — so Node tests import this file directly and compare it with
 * test/fixtures/companion-wire.json and test/fixtures/companion-relay-contract.json.
 */

export const MAX_NOISE_MESSAGE_BYTES = 65_535;
export const ENVELOPE_HEADER_BYTES = 5;
export const MAX_DAEMON_FRAME_BYTES = MAX_NOISE_MESSAGE_BYTES + ENVELOPE_HEADER_BYTES;
export const HEARTBEAT_PAYLOAD_BYTES = 8;

export const OP = Object.freeze({ PEER_OPEN: 0x01, PEER_DATA: 0x02, PEER_CLOSE: 0x03, HEARTBEAT: 0x04, HEARTBEAT_ACK: 0x05 });

export const CLOSE = Object.freeze({
  normal: 1000,
  protocol: 4400,
  revoked: 4403,
  timeout: 4408,
  superseded: 4409,
  rateLimited: 4429,
  daemonGone: 4503,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export const LIMITS = Object.freeze({
  phoneFirstFrameMs: 10_000,
  phoneIdleMs: 90_000,
  daemonSilenceMs: 60_000,
  socketsPerMachine: 4,
  devicesPerMachine: 32,
  tombstonesPerMachine: 256,
  tombstoneMs: 30 * DAY_MS,
  roomIdleDeleteMs: 90 * DAY_MS,
  phoneUp: { framesPerMin: 600, framesBurst: 120, bytesPerMin: 4 * 1024 * 1024, bytesBurst: 1024 * 1024 },
  phoneDown: { bytesPerMin: 16 * 1024 * 1024, bytesBurst: 4 * 1024 * 1024 },
  machineUp: { bytesPerMin: 32 * 1024 * 1024, bytesBurst: 8 * 1024 * 1024 },
  machineDown: { bytesPerMin: 64 * 1024 * 1024, bytesBurst: 16 * 1024 * 1024 },
  registerBodyBytes: 4096,
  putBodyBytes: 16_384,
  postBodyBytes: 4096,
  challengeTtlMs: 60_000,
});

export const TOKEN = Object.freeze({
  maxTtlSec: 300,
  skewSec: 30,
  maxPartBytes: 1024,
  pairMaxUses: 3,
});

/** Replay budgets per principal within one machine (PROTOCOL.md "Replay"): the daemon's rows are reserved, each
 * device and each pair session has its own, and class totals bound the room (512 + 32 × 64 + 4 × 16). */
export const REPLAY = Object.freeze({
  daemon: 512,
  perDevice: 64,
  perPairSession: 16,
  devicesTotal: 32 * 64,
  pairSessionsTotal: 4 * 16,
});

export type PrincipalKind = "daemon" | "device" | "pair";

export function principalOf(parsed: Pick<ParsedToken, "role" | "deviceId" | "pairSessionId">): { kind: PrincipalKind; key: string; own: number; total: number } {
  if (parsed.role === "device") return { kind: "device", key: `d:${parsed.deviceId}`, own: REPLAY.perDevice, total: REPLAY.devicesTotal };
  if (parsed.role === "pair") return { kind: "pair", key: `p:${parsed.pairSessionId}`, own: REPLAY.perPairSession, total: REPLAY.pairSessionsTotal };
  return { kind: "daemon", key: "daemon", own: REPLAY.daemon, total: REPLAY.daemon };
}

export const MACHINE_ID = /^[a-z2-7]{26}$/;
export const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const JTI = /^[A-Za-z0-9_-]{16,64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const RFC4648_LOWER = "abcdefghijklmnopqrstuvwxyz234567";

export type Role = "daemon" | "pair" | "device";

export type RefusalCode =
  | "bad_request" | "token_invalid" | "token_expired" | "token_not_yet_valid" | "device_revoked" | "machine_unknown"
  | "device_unknown" | "rate_limited" | "too_many_peers" | "replay_cache_full" | "daemon_unavailable";

export interface Refusal { status: number; code: RefusalCode; retryAfterSec?: number }

export function refusalResponse(refusal: Refusal): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "toolroll-relay-error": refusal.code,
    date: new Date().toUTCString(),
  };
  if (refusal.retryAfterSec !== undefined) headers["retry-after"] = String(refusal.retryAfterSec);
  return new Response(JSON.stringify({ error: refusal.code }), { status: refusal.status, headers });
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// ---- base64url / base32 ----

export function fromB64Url(s: string): Uint8Array {
  if (!B64URL.test(s)) throw new Error("not base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A 32-byte Ed25519 key in unpadded base64url, or null. */
export function relayKeyOrNull(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length !== 43) return null;
  try {
    const key = fromB64Url(value);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function base32Lower(data: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of data) {
    acc = ((acc << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += RFC4648_LOWER[(acc >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += RFC4648_LOWER[(acc << (5 - bits)) & 0x1f];
  return out;
}

export async function deriveMachineId(pubKey: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode("toolroll-machine-id-v1\0");
  const buf = new Uint8Array(prefix.length + pubKey.length);
  buf.set(prefix, 0);
  buf.set(pubKey, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return base32Lower(digest).slice(0, 26);
}

export async function verifyEd25519(pubRaw: Uint8Array, message: Uint8Array, sig: Uint8Array): Promise<boolean> {
  if (pubRaw.length !== 32 || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", pubRaw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, sig, message);
  } catch {
    return false;
  }
}

// ---- Tokens (PROTOCOL.md "Tokens") ----

export interface ParsedToken {
  role: Role;
  machineId: string;
  deviceId?: string;
  pairSessionId?: string;
  raw: Record<string, unknown>;
  input: Uint8Array;
  sig: Uint8Array;
}

/** Structure and routing fields only; every other claim is checked after the signature (checkClaims). */
export function parseToken(token: string): ParsedToken | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, sigB64] = parts as [string, string];
  if (encoded.length === 0 || encoded.length > TOKEN.maxPartBytes || !B64URL.test(encoded)) return null;
  if (sigB64.length !== 86 || !B64URL.test(sigB64)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromB64Url(encoded)));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const role = c["role"];
  if (role !== "daemon" && role !== "pair" && role !== "device") return null;
  const machineId = c["machineId"];
  if (typeof machineId !== "string" || !MACHINE_ID.test(machineId)) return null;
  const deviceId = c["deviceId"], pairSessionId = c["pairSessionId"];
  if (role === "device" && (typeof deviceId !== "string" || !ID.test(deviceId))) return null;
  if (role === "pair" && (typeof pairSessionId !== "string" || !ID.test(pairSessionId))) return null;
  return {
    role,
    machineId,
    ...(role === "device" ? { deviceId: deviceId as string } : {}),
    ...(role === "pair" ? { pairSessionId: pairSessionId as string } : {}),
    raw: c,
    input: new TextEncoder().encode(`tr-relay-v1.${encoded}`),
    sig: fromB64Url(sigB64),
  };
}

export type TokenUse = "ws" | { method: "PUT" | "POST" | "DELETE"; path: string };
export type ClaimsResult = { ok: true; jti: string; exp: number } | { ok: false; code: "token_invalid" | "token_expired" | "token_not_yet_valid" };

const BASE_CLAIMS = ["v", "role", "machineId", "aud", "jti", "iat", "exp"];

export function checkClaims(parsed: ParsedToken, aud: string, use: TokenUse, nowSec: number): ClaimsResult {
  const c = parsed.raw;
  const allowed = new Set(BASE_CLAIMS);
  if (parsed.role === "device") allowed.add("deviceId");
  if (parsed.role === "pair") allowed.add("pairSessionId");
  if (use !== "ws") { allowed.add("htm"); allowed.add("htu"); }
  const invalid = { ok: false as const, code: "token_invalid" as const };
  if (Object.keys(c).some(key => !allowed.has(key)) || BASE_CLAIMS.some(key => !(key in c))) return invalid;
  if (c["v"] !== 1 || typeof c["aud"] !== "string" || c["aud"] !== aud || aud.length === 0) return invalid;
  if (use !== "ws" && parsed.role !== "daemon") return invalid;
  if (typeof c["jti"] !== "string" || !JTI.test(c["jti"])) return invalid;
  const iat = c["iat"], exp = c["exp"];
  if (typeof iat !== "number" || typeof exp !== "number" || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return invalid;
  if (exp - iat <= 0 || exp - iat > TOKEN.maxTtlSec) return invalid;
  if (use !== "ws" && (c["htm"] !== use.method || c["htu"] !== use.path)) return invalid;
  if (iat > nowSec + TOKEN.skewSec) return { ok: false, code: "token_not_yet_valid" };
  if (exp <= nowSec - TOKEN.skewSec) return { ok: false, code: "token_expired" };
  return { ok: true, jti: c["jti"], exp };
}

export function maxUses(role: Role): number {
  return role === "pair" ? TOKEN.pairMaxUses : 1;
}

// ---- Envelope ----

export function encodeEnvelope(op: number, connId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(ENVELOPE_HEADER_BYTES + payload.length);
  out[0] = op;
  new DataView(out.buffer).setUint32(1, connId >>> 0, false);
  out.set(payload, ENVELOPE_HEADER_BYTES);
  return out;
}

export function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

// ---- Challenges: 16 random bytes + expiry, HMAC-SHA256 ----

async function challengeKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function mintChallenge(secret: string, nowMs: number): Promise<string> {
  const body = new Uint8Array(24);
  body.set(crypto.getRandomValues(new Uint8Array(16)), 0);
  new DataView(body.buffer).setBigUint64(16, BigInt(nowMs + LIMITS.challengeTtlMs), false);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await challengeKey(secret), body));
  const out = new Uint8Array(body.length + mac.length);
  out.set(body, 0);
  out.set(mac, body.length);
  return toB64Url(out);
}

/** Valid under any of `secrets` (the current one and, while rotating, the previous one) and not expired. */
export async function challengeValid(secrets: string[], challenge: string, nowMs: number): Promise<boolean> {
  let raw: Uint8Array;
  try { raw = fromB64Url(challenge); } catch { return false; }
  if (raw.length !== 24 + 32) return false;
  const body = raw.slice(0, 24), mac = raw.slice(24);
  let signed = false;
  for (const secret of secrets) {
    if (await crypto.subtle.verify("HMAC", await challengeKey(secret), mac, body)) { signed = true; break; }
  }
  return signed && Number(new DataView(body.buffer).getBigUint64(16, false)) > nowMs;
}

// ---- Rate keys and buckets ----

/** The rate-limit key for a client address: IPv4 as is, IPv6 by its /64. */
export function rateKeyOf(ip: string | null): string {
  if (ip === null || ip.length === 0) return "no-ip";
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head!.split(":").filter(Boolean);
  const right = tail.split(":").filter(Boolean);
  const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${full.slice(0, 4).join(":")}::/64`;
}

/** A token bucket whose state is two numbers, so it can ride in a socket attachment across hibernation. */
export interface BucketState { tokens: number; at: number }

export function bucketTake(state: BucketState, perMin: number, burst: number, cost: number, nowMs: number): boolean {
  const elapsed = Math.max(0, nowMs - state.at);
  state.tokens = Math.min(burst, state.tokens + (elapsed * perMin) / 60_000);
  state.at = nowMs;
  if (state.tokens < cost) return false;
  state.tokens -= cost;
  return true;
}

export function fullBucket(burst: number, nowMs: number): BucketState {
  return { tokens: burst, at: nowMs };
}

// ---- Timing (env-overridable for tests; an override can only shorten a deadline) ----

export interface Timing { phoneFirstFrameMs: number; phoneIdleMs: number; daemonSilenceMs: number }

export function timingFrom(env: Record<string, unknown>): Timing {
  const pick = (name: string, fallback: number): number => {
    const raw = env[name];
    const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
    return Number.isSafeInteger(value) && value > 0 && value <= fallback ? value : fallback;
  };
  return {
    phoneFirstFrameMs: pick("RELAY_PHONE_FIRST_FRAME_MS", LIMITS.phoneFirstFrameMs),
    phoneIdleMs: pick("RELAY_PHONE_IDLE_MS", LIMITS.phoneIdleMs),
    daemonSilenceMs: pick("RELAY_DAEMON_SILENCE_MS", LIMITS.daemonSilenceMs),
  };
}

// ---- Sweep decision (R1: computed from socket attachments only, so a fresh instance decides the same) ----

export interface SweepSocket {
  role: Role;
  openedAt: number;
  /** First frame from the phone (0 = none yet). */
  firstAt: number;
  /** Last frame in either direction (phones) / from the daemon. */
  lastAt: number;
}

/** When this socket's deadline falls: first frame, idle, or daemon silence. */
export function socketDeadline(s: SweepSocket, timing: Timing): { at: number; reason: "first_frame_timeout" | "idle_timeout" | "heartbeat_timeout" } {
  if (s.role === "daemon") return { at: Math.max(s.lastAt, s.openedAt) + timing.daemonSilenceMs, reason: "heartbeat_timeout" };
  if (s.firstAt === 0) return { at: s.openedAt + timing.phoneFirstFrameMs, reason: "first_frame_timeout" };
  return { at: Math.max(s.lastAt, s.firstAt) + timing.phoneIdleMs, reason: "idle_timeout" };
}

/** Reads a request body of at most `max` bytes (null when longer). */
export async function readBoundedText(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all);
  } catch {
    return null;
  }
}

export async function readJsonObject(request: Request, max: number): Promise<Record<string, unknown> | null> {
  const text = await readBoundedText(request, max);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
