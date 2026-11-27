/**
 * Ed25519 relay authentication tokens, deterministic machineId proof-of-possession,
 * and 5-byte outer multi-phone routing envelope (`docs/plans/companion-app/noise-relay-protocol.md` §4).
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { deriveMachineId, MAX_NOISE_MESSAGE_BYTES } from "./noise.js";

export const MAX_RELAY_TOKEN_TTL_SEC = 5 * 60; // 5 minutes
export const RELAY_ENVELOPE_HEADER_BYTES = 5;
export const MAX_DAEMON_WS_FRAME_BYTES = MAX_NOISE_MESSAGE_BYTES + RELAY_ENVELOPE_HEADER_BYTES; // 65_540

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface Ed25519KeyPair {
  privateKey: Buffer; // 32 raw seed bytes
  publicKey: Buffer; // 32 raw public bytes
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: Buffer.from(privDer.subarray(privDer.length - 32)),
    publicKey: Buffer.from(pubDer.subarray(pubDer.length - 32)),
  };
}

function ed25519PrivateKeyObject(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error(`Ed25519 private key must be 32 bytes (got ${raw.length})`);
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

function ed25519PublicKeyObject(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error(`Ed25519 public key must be 32 bytes (got ${raw.length})`);
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function ed25519Sign(privateKey: Buffer, data: Buffer): Buffer {
  return cryptoSign(null, data, ed25519PrivateKeyObject(privateKey));
}

export function ed25519Verify(publicKey: Buffer, data: Buffer, signature: Buffer): boolean {
  if (signature.length !== 64) return false;
  try {
    return cryptoVerify(null, data, ed25519PublicKeyObject(publicKey), signature);
  } catch {
    return false;
  }
}

/** Proof-of-possession signature for `POST /v1/machines/register`. */
export function signRegistrationPop(privateKey: Buffer, relayHost: string, challenge: string): string {
  const msg = Buffer.from(`register\0${relayHost}\0${challenge}`, "utf8");
  return ed25519Sign(privateKey, msg).toString("base64url");
}

export function verifyRegistrationPop(publicKey: Buffer, relayHost: string, challenge: string, sigB64Url: string): boolean {
  const msg = Buffer.from(`register\0${relayHost}\0${challenge}`, "utf8");
  return ed25519Verify(publicKey, msg, Buffer.from(sigB64Url, "base64url"));
}

export type RelayRole = "daemon" | "pair" | "device";

export interface RelayTokenClaims {
  v: 1;
  role: RelayRole;
  machineId: string;
  deviceId?: string;
  pairSessionId?: string;
  /** The relay's public host (exact, lowercase). A token minted for one relay is refused by every other. */
  aud: string;
  /** HTTP admission calls only: the method and exact path the token is for. WebSocket tokens never carry them. */
  htm?: "PUT" | "POST" | "DELETE";
  htu?: string;
  jti: string;
  iat: number; // unix seconds
  exp: number; // unix seconds
}

export function signRelayToken(
  privateKey: Buffer,
  claims: Omit<RelayTokenClaims, "v" | "jti" | "iat" | "exp"> & { ttlSec?: number; nowSec?: number; jti?: string },
): string {
  const nowSec = claims.nowSec ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(1, claims.ttlSec ?? MAX_RELAY_TOKEN_TTL_SEC), MAX_RELAY_TOKEN_TTL_SEC);
  const payload: RelayTokenClaims = {
    v: 1,
    role: claims.role,
    machineId: claims.machineId,
    aud: claims.aud,
    ...(claims.htm !== undefined ? { htm: claims.htm } : {}),
    ...(claims.htu !== undefined ? { htu: claims.htu } : {}),
    ...(claims.deviceId !== undefined ? { deviceId: claims.deviceId } : {}),
    ...(claims.pairSessionId !== undefined ? { pairSessionId: claims.pairSessionId } : {}),
    jti: claims.jti ?? randomUUID(),
    iat: nowSec,
    exp: nowSec + ttl,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = ed25519Sign(privateKey, Buffer.from(`tr-relay-v1.${encoded}`, "ascii")).toString("base64url");
  return `${encoded}.${sig}`;
}

// ---- Verification (relay side; relay/PROTOCOL.md "Tokens") -------------------

/** Clock skew the relay allows on `iat` and `exp`, both ways. */
export const RELAY_TOKEN_SKEW_SEC = 30;
/** The claims part (before the dot) may be at most this many bytes. */
export const MAX_RELAY_TOKEN_PART_BYTES = 1024;
export const RELAY_MACHINE_ID_PATTERN = /^[a-z2-7]{26}$/;
export const RELAY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const RELAY_JTI_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** The token refusals a relay answers with 401 (relay/PROTOCOL.md "Refusals"). */
export type RelayTokenRefusal = "token_invalid" | "token_expired" | "token_not_yet_valid";

/** What a relay needs before it can pick the verification key: the role and the ids it routes on. Everything else in
 * the claims is checked only after the signature (checkRelayClaims). */
export interface ParsedRelayToken {
  role: RelayRole;
  machineId: string;
  /** role=device only. */
  deviceId?: string;
  /** role=pair only. */
  pairSessionId?: string;
  /** The decoded claims object, unchecked beyond the fields above. */
  raw: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
}

/** Structure only: `base64url(JSON) "." base64url(sig)`, the claims part ≤ 1024 bytes, a JSON object with a known role,
 * a well-formed machineId and, for device and pair tokens, the id the relay looks up. Null for anything else
 * (the relay answers 401 token_invalid). */
export function parseRelayToken(token: string): ParsedRelayToken | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, sigB64] = parts as [string, string];
  if (encoded.length === 0 || encoded.length > MAX_RELAY_TOKEN_PART_BYTES || !B64URL.test(encoded)) return null;
  if (sigB64.length !== 86 || !B64URL.test(sigB64)) return null; // 64 bytes, unpadded
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const claims = raw as Record<string, unknown>;
  const role = claims["role"];
  if (role !== "daemon" && role !== "pair" && role !== "device") return null;
  const machineId = claims["machineId"];
  if (typeof machineId !== "string" || !RELAY_MACHINE_ID_PATTERN.test(machineId)) return null;
  const deviceId = claims["deviceId"], pairSessionId = claims["pairSessionId"];
  if (role === "device" && (typeof deviceId !== "string" || !RELAY_ID_PATTERN.test(deviceId))) return null;
  if (role === "pair" && (typeof pairSessionId !== "string" || !RELAY_ID_PATTERN.test(pairSessionId))) return null;
  return {
    role,
    machineId,
    ...(role === "device" ? { deviceId: deviceId as string } : {}),
    ...(role === "pair" ? { pairSessionId: pairSessionId as string } : {}),
    raw: claims,
    signingInput: Buffer.from(`tr-relay-v1.${encoded}`, "ascii"),
    signature: Buffer.from(sigB64, "base64url"),
  };
}

/** What the token must be for: the relay's public host, and either a WebSocket connect or one exact HTTP call. */
export interface RelayTokenExpectation {
  aud: string;
  /** "ws" for `/v1/connect`; for an admission call, its method and exact path (no query, no trailing slash). */
  use: "ws" | { method: "PUT" | "POST" | "DELETE"; path: string };
  /** HTTP admission calls are daemon-only; a WebSocket accepts any role. */
  role?: RelayRole;
  nowSec: number;
}

const BASE_CLAIMS = ["v", "role", "machineId", "aud", "jti", "iat", "exp"];

/** The claim rules (relay/PROTOCOL.md "Tokens"), checked after the signature: exactly the allowed keys, v=1, the exact
 * audience, the jti grammar, integer times with 0 < exp-iat ≤ 300, htm/htu exactly on HTTP calls, then the clock. */
export function checkRelayClaims(
  parsed: ParsedRelayToken,
  expect: RelayTokenExpectation,
): { ok: true; claims: RelayTokenClaims } | { ok: false; code: RelayTokenRefusal } {
  const c = parsed.raw;
  const allowed = new Set(BASE_CLAIMS);
  if (parsed.role === "device") allowed.add("deviceId");
  if (parsed.role === "pair") allowed.add("pairSessionId");
  if (expect.use !== "ws") { allowed.add("htm"); allowed.add("htu"); }
  const keys = Object.keys(c);
  const invalid = { ok: false as const, code: "token_invalid" as const };
  if (keys.some(key => !allowed.has(key)) || BASE_CLAIMS.some(key => !(key in c))) return invalid;
  if (c["v"] !== 1 || c["aud"] !== expect.aud) return invalid;
  if (expect.role !== undefined && parsed.role !== expect.role) return invalid;
  if (typeof c["jti"] !== "string" || !RELAY_JTI_PATTERN.test(c["jti"])) return invalid;
  const iat = c["iat"], exp = c["exp"];
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return invalid;
  const ttl = (exp as number) - (iat as number);
  if (ttl <= 0 || ttl > MAX_RELAY_TOKEN_TTL_SEC) return invalid;
  if (expect.use !== "ws") {
    if (c["htm"] !== expect.use.method || c["htu"] !== expect.use.path) return invalid;
  }
  if ((iat as number) > expect.nowSec + RELAY_TOKEN_SKEW_SEC) return { ok: false, code: "token_not_yet_valid" };
  if ((exp as number) <= expect.nowSec - RELAY_TOKEN_SKEW_SEC) return { ok: false, code: "token_expired" };
  return { ok: true, claims: c as unknown as RelayTokenClaims };
}

/** Replay budgets per principal within one machine (relay/PROTOCOL.md "Replay"): the daemon has its own reserved
 * rows, each device and each pair session its own, so no principal can fill the cache for another. Class totals bound
 * the room: 512 + 32 × 64 + 4 × 16 rows. */
export const RELAY_REPLAY_BUDGETS = Object.freeze({
  daemon: 512,
  perDevice: 64,
  perPairSession: 16,
  devicesTotal: 32 * 64,
  pairSessionsTotal: 4 * 16,
});

export type ReplayPrincipalKind = "daemon" | "device" | "pair";

/** The principal a token's jti is charged to: the daemon, one deviceId or one pairSessionId. */
export function replayPrincipalOf(parsed: Pick<ParsedRelayToken, "role" | "deviceId" | "pairSessionId">): { kind: ReplayPrincipalKind; key: string } {
  if (parsed.role === "device") return { kind: "device", key: `d:${parsed.deviceId}` };
  if (parsed.role === "pair") return { kind: "pair", key: `p:${parsed.pairSessionId}` };
  return { kind: "daemon", key: "daemon" };
}

function replayBudget(kind: ReplayPrincipalKind): { own: number; total: number } {
  if (kind === "device") return { own: RELAY_REPLAY_BUDGETS.perDevice, total: RELAY_REPLAY_BUDGETS.devicesTotal };
  if (kind === "pair") return { own: RELAY_REPLAY_BUDGETS.perPairSession, total: RELAY_REPLAY_BUDGETS.pairSessionsTotal };
  return { own: RELAY_REPLAY_BUDGETS.daemon, total: RELAY_REPLAY_BUDGETS.daemon };
}

/** One-time `jti` bookkeeping for one machine (relay/PROTOCOL.md "Replay"): daemon and device tokens once, pair tokens
 * at most 3 times. Ids are remembered per principal (a device can't spend or collide with the daemon's ids) until
 * 30 s after the token's expiry; each principal has its own budget (RELAY_REPLAY_BUDGETS). */
export class RelayReplayCache {
  private readonly rows = new Map<string, { principal: string; kind: ReplayPrincipalKind; exp: number; uses: number }>();
  private readonly perPrincipal = new Map<string, number>();
  private readonly perKind = new Map<ReplayPrincipalKind, number>();
  /** Consumes one use. "ok", "replayed" (used up) or "full" (this principal's budget is spent, nothing expired). */
  consume(principal: { kind: ReplayPrincipalKind; key: string }, jti: string, expSec: number, maxUses: number, nowSec: number): "ok" | "replayed" | "full" {
    const id = `${principal.key}\u0000${jti}`;
    const row = this.rows.get(id);
    if (row !== undefined) {
      if (row.uses >= maxUses) return "replayed";
      row.uses += 1;
      return "ok";
    }
    const budget = replayBudget(principal.kind);
    const over = (): boolean => (this.perPrincipal.get(principal.key) ?? 0) >= budget.own || (this.perKind.get(principal.kind) ?? 0) >= budget.total;
    if (over()) this.prune(nowSec);
    if (over()) return "full";
    this.rows.set(id, { principal: principal.key, kind: principal.kind, exp: expSec, uses: 1 });
    this.perPrincipal.set(principal.key, (this.perPrincipal.get(principal.key) ?? 0) + 1);
    this.perKind.set(principal.kind, (this.perKind.get(principal.kind) ?? 0) + 1);
    return "ok";
  }
  prune(nowSec: number): void {
    for (const [id, row] of this.rows) {
      if (row.exp >= nowSec - RELAY_TOKEN_SKEW_SEC) continue;
      this.rows.delete(id);
      const left = (this.perPrincipal.get(row.principal) ?? 1) - 1;
      if (left <= 0) this.perPrincipal.delete(row.principal); else this.perPrincipal.set(row.principal, left);
      this.perKind.set(row.kind, (this.perKind.get(row.kind) ?? 1) - 1);
    }
  }
  get size(): number { return this.rows.size; }
  /** Rows charged to one principal (tests). */
  rowsOf(principalKey: string): number { return this.perPrincipal.get(principalKey) ?? 0; }
}

/** Uses a `jti` may have: pair tokens ride in the QR and a phone may retry, so 3; every other role once. */
export function relayTokenMaxUses(role: RelayRole): number {
  return role === "pair" ? 3 : 1;
}

/** Verify a registration request and return the deterministic `machineId`. */
export function verifyMachineRegistration(params: {
  relayMachinePubB64: string;
  relayHost: string;
  challenge: string;
  signatureB64: string;
}): { ok: true; machineId: string; publicKey: Buffer } | { ok: false; reason: string } {
  const publicKey = Buffer.from(params.relayMachinePubB64, "base64url");
  if (publicKey.length !== 32) return { ok: false, reason: "invalid_public_key" };
  if (!verifyRegistrationPop(publicKey, params.relayHost, params.challenge, params.signatureB64)) {
    return { ok: false, reason: "invalid_pop_signature" };
  }
  return { ok: true, machineId: deriveMachineId(publicKey), publicKey };
}

// ---- Multi-phone outer routing envelope (Relay <-> Daemon leg) --------------

export const RelayOp = {
  PEER_OPEN: 0x01,
  PEER_DATA: 0x02,
  PEER_CLOSE: 0x03,
  /** Daemon → relay every 20 s: `[4B 0][8B BE ms timestamp]`. */
  HEARTBEAT: 0x04,
  /** Relay → daemon, echoing the heartbeat's 8 bytes. */
  HEARTBEAT_ACK: 0x05,
} as const;

export type RelayOpCode = (typeof RelayOp)[keyof typeof RelayOp];

/** HEARTBEAT and HEARTBEAT_ACK carry an 8-byte big-endian millisecond timestamp (connId 0). */
export const HEARTBEAT_PAYLOAD_BYTES = 8;

/** A daemon heartbeat envelope for `nowMs` (the relay echoes the same 8 bytes in HEARTBEAT_ACK). */
export function encodeHeartbeat(nowMs: number, op: typeof RelayOp.HEARTBEAT | typeof RelayOp.HEARTBEAT_ACK = RelayOp.HEARTBEAT): Buffer {
  const payload = Buffer.alloc(HEARTBEAT_PAYLOAD_BYTES);
  payload.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(nowMs))));
  return encodeRelayEnvelope({ op, connId: 0, payload });
}

export interface RelayEnvelope {
  op: RelayOpCode;
  connId: number; // uint32 BE
  payload: Buffer;
}

export function encodeRelayEnvelope(env: RelayEnvelope): Buffer {
  if (env.op === RelayOp.PEER_DATA && env.payload.length > MAX_NOISE_MESSAGE_BYTES) {
    throw new Error(`PEER_DATA payload ${env.payload.length} exceeds ${MAX_NOISE_MESSAGE_BYTES}`);
  }
  const out = Buffer.allocUnsafe(RELAY_ENVELOPE_HEADER_BYTES + env.payload.length);
  out.writeUInt8(env.op, 0);
  out.writeUInt32BE(env.connId >>> 0, 1);
  env.payload.copy(out, RELAY_ENVELOPE_HEADER_BYTES);
  return out;
}

export function decodeRelayEnvelope(raw: Buffer): RelayEnvelope {
  if (raw.length < RELAY_ENVELOPE_HEADER_BYTES) {
    throw new Error(`Relay envelope truncated: ${raw.length} bytes`);
  }
  const op = raw.readUInt8(0);
  if (op < RelayOp.PEER_OPEN || op > RelayOp.HEARTBEAT_ACK) {
    throw new Error(`Unknown relay opcode: 0x${op.toString(16)}`);
  }
  const connId = raw.readUInt32BE(1);
  const payload = Buffer.from(raw.subarray(RELAY_ENVELOPE_HEADER_BYTES));
  if (op === RelayOp.PEER_DATA && payload.length > MAX_NOISE_MESSAGE_BYTES) {
    throw new Error(`PEER_DATA exceeds ${MAX_NOISE_MESSAGE_BYTES} bytes`);
  }
  if ((op === RelayOp.HEARTBEAT || op === RelayOp.HEARTBEAT_ACK) && (connId !== 0 || payload.length !== HEARTBEAT_PAYLOAD_BYTES)) {
    throw new Error(`Heartbeat envelope must be [4B 0][8B timestamp]`);
  }
  return { op: op as RelayOpCode, connId, payload };
}
