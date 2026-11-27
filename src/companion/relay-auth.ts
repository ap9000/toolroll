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

export function parseRelayTokenUnverified(token: string): { claims: RelayTokenClaims; signingInput: Buffer; signature: Buffer } | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, sigB64] = parts;
  if (!encoded || !sigB64) return null;
  try {
    const raw = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as Partial<RelayTokenClaims>;
    if (
      parsed.v !== 1
      || (parsed.role !== "daemon" && parsed.role !== "pair" && parsed.role !== "device")
      || typeof parsed.machineId !== "string" || parsed.machineId.length !== 26
      || typeof parsed.jti !== "string" || parsed.jti.length === 0
      || typeof parsed.iat !== "number" || typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (parsed.role === "pair" && (typeof parsed.pairSessionId !== "string" || parsed.pairSessionId.length === 0)) {
      return null;
    }
    if (parsed.role === "device" && (typeof parsed.deviceId !== "string" || parsed.deviceId.length === 0)) {
      return null;
    }
    return {
      claims: parsed as RelayTokenClaims,
      signingInput: Buffer.from(`tr-relay-v1.${encoded}`, "ascii"),
      signature: Buffer.from(sigB64, "base64url"),
    };
  } catch {
    return null;
  }
}

export function verifyRelayToken(
  token: string,
  expectedPublicKey: Buffer,
  nowSec = Math.floor(Date.now() / 1000),
  clockSkewSec = 30,
): { ok: true; claims: RelayTokenClaims } | { ok: false; reason: string } {
  const parsed = parseRelayTokenUnverified(token);
  if (parsed === null) return { ok: false, reason: "malformed_token" };
  const { claims, signingInput, signature } = parsed;
  if (claims.exp - claims.iat > MAX_RELAY_TOKEN_TTL_SEC + 5) {
    return { ok: false, reason: "ttl_too_long" };
  }
  if (nowSec > claims.exp + clockSkewSec) {
    return { ok: false, reason: "token_expired" };
  }
  if (nowSec + clockSkewSec < claims.iat) {
    return { ok: false, reason: "token_not_yet_valid" };
  }
  if (!ed25519Verify(expectedPublicKey, signingInput, signature)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true, claims };
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
  if (op !== RelayOp.PEER_OPEN && op !== RelayOp.PEER_DATA && op !== RelayOp.PEER_CLOSE) {
    throw new Error(`Unknown relay opcode: 0x${op.toString(16)}`);
  }
  const connId = raw.readUInt32BE(1);
  const payload = Buffer.from(raw.subarray(RELAY_ENVELOPE_HEADER_BYTES));
  if (op === RelayOp.PEER_DATA && payload.length > MAX_NOISE_MESSAGE_BYTES) {
    throw new Error(`PEER_DATA exceeds ${MAX_NOISE_MESSAGE_BYTES} bytes`);
  }
  return { op, connId, payload };
}
