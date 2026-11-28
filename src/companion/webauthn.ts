/**
 * Local WebAuthn (ES256 / P-256) verifier and canonical challenge builder for ADR 0005
 * (`docs/adr/0005-passkey-phone-approvals.md`). Zero external dependencies: uses Node's built-in `node:crypto` only.
 *
 * Security invariants enforced here:
 * - `rpId = "toolroll.dev"` and `origin = "https://toolroll.dev"` (configurable only for tests/forks).
 * - Unique 32-byte `user.id` per `(workspaceId, accountName)` so pairing multiple Macs never overwrites passkeys in
 *   iCloud Keychain: `SHA-256("toolroll-passkey-user-v1\0" || utf8(workspaceId) || "\0" || utf8(accountName))`.
 * - Registration requires `webauthn.create`, constant-time challenge match, `origin`, `rpIdHash`, `UP=1`, `UV=1`,
 *   `AT=1`, and an on-curve P-256 COSE public key (`kty: 2, alg: -7, crv: 1`).
 * - Assertion requires `webauthn.get`, constant-time challenge match (`base64url(SHA-256(canonicalActionChallenge))`),
 *   `origin`, `rpIdHash`, `UP=1` AND `UV=1`, constant-time `userHandle` match, valid ECDSA-SHA256 signature over
 *   `authData || SHA-256(clientDataJSON)`, and `signCount` policy (`0 -> 0` accepted for synced passkeys; otherwise
 *   strictly increasing `newSignCount > storedSignCount`).
 */

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from "node:crypto";

export const PASSKEY_RP_ID = "toolroll.dev";
export const PASSKEY_RP_NAME = "Toolroll";
export const PASSKEY_ORIGIN = "https://toolroll.dev";
export const PASSKEY_CHALLENGE_TTL_MS = 120_000;

/** ASN.1 SubjectPublicKeyInfo prefix for uncompressed NIST P-256 public key (`0x04 || x || y`). */
const P256_SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
const P256_P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const P256_B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");

export type PasskeyVerb = "approve" | "accept" | "land" | "ship";

export interface WebAuthnRegistrationPayload {
  credentialId?: string;
  clientDataJSON: string; // base64url
  attestationObject: string; // base64url
}

export interface WebAuthnAssertionPayload {
  credentialId: string; // base64url
  clientDataJSON: string; // base64url
  authenticatorData: string; // base64url
  signature: string; // base64url (DER ECDSA)
  userHandle: string; // base64url
}

export type VerifiedRegistration =
  | {
    ok: true;
    credentialId: string;
    publicKeySpki: string;
    signCount: number;
    be: boolean;
    bs: boolean;
  }
  | { ok: false; code: string; message: string };

export type VerifiedAssertion =
  | {
    ok: true;
    credentialId: string;
    newSignCount: number;
    be: boolean;
    bs: boolean;
  }
  | { ok: false; code: string; message: string };

export function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

export function randomChallenge32(): string {
  return randomBytes(32).toString("base64url");
}

/** Deterministic sorted-key JSON encoding for canonical challenge payloads and idempotency request hashes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** ADR 0005 unique 32-byte opaque user.id per (workspaceId, accountName). */
export function derivePasskeyUserHandle(workspaceId: string, accountName: string): Buffer {
  return sha256(Buffer.concat([
    Buffer.from("toolroll-passkey-user-v1\0", "utf8"),
    Buffer.from(workspaceId, "utf8"),
    Buffer.from("\0", "utf8"),
    Buffer.from(accountName, "utf8"),
  ]));
}

export type VerbChallengeBinding =
  | { verb: "approve"; taskId: string; sawDigest: string }
  | { verb: "accept"; taskId: string; runId: number | null; receiptDigest: string; noteHash: string; publish: boolean }
  | { verb: "land"; taskId: string; planKey: string; into: string | null; undo: boolean }
  | { verb: "ship"; runId: number; taskId: string; prNumber: number; headSha: string; method: string; anyway: boolean };

/**
 * Builds the canonical verb-specific challenge payload and its SHA-256 base64url digest.
 * Distinct per verb so an assertion for one verb can never replay against another.
 */
export function buildActionChallenge(input: {
  workspaceId: string;
  recoveryGeneration: string;
  accountName: string;
  deviceId: string;
  binding: VerbChallengeBinding;
  nonce?: string;
}): { challenge: string; canonicalPayload: string; bindingJson: string; wording: string } {
  const nonce = input.nonce ?? randomChallenge32();
  const payload = {
    v: 1,
    verb: input.binding.verb,
    workspaceId: input.workspaceId,
    recoveryGeneration: input.recoveryGeneration,
    accountName: input.accountName,
    deviceId: input.deviceId,
    binding: input.binding,
    nonce,
  };
  const canonicalPayload = canonicalJson(payload);
  const challenge = sha256(canonicalPayload).toString("base64url");
  const bindingJson = canonicalJson(input.binding);
  const wording = wordingForBinding(input.binding);
  return { challenge, canonicalPayload, bindingJson, wording };
}

function wordingForBinding(binding: VerbChallengeBinding): string {
  switch (binding.verb) {
    case "approve":
      return `Approve task ${binding.taskId} plan (${binding.sawDigest.slice(0, 12)})`;
    case "accept":
      return `Accept task ${binding.taskId} result (${binding.receiptDigest.slice(0, 12)})${binding.publish ? " and open pull request" : ""}`;
    case "land":
      return `${binding.undo ? "Undo landing" : "Land"} task ${binding.taskId} (${binding.planKey})`;
    case "ship":
      return `Merge PR #${binding.prNumber} for task ${binding.taskId} at ${binding.headSha.slice(0, 10)} (${binding.method})`;
  }
}

/**
 * Structured ADR 0005 honest proof detail JSON (compatible with `scope.ts:proofDetailOf`).
 * Sized strictly under `store.recordAction`'s 300-character detail cap so it is never truncated.
 */
export function passkeyProofDetail(input: {
  at: Date;
  generation: number;
  digest: string;
  verb: PasskeyVerb;
  credentialId: string;
  pairedDeviceId: string;
  be: boolean;
  bs: boolean;
}): string {
  return JSON.stringify({
    v: 1,
    at: input.at.toISOString(),
    generation: input.generation,
    digest: input.digest,
    verb: input.verb,
    cred: sha256(input.credentialId).toString("hex").slice(0, 16),
    deviceId: input.pairedDeviceId.slice(0, 32),
    uv: true,
    be: input.be,
    bs: input.bs,
    summary: "Passkey user verification",
  });
}

/**
 * Structured ADR 0005 honest proof detail JSON for an act authorized under a bounded in-memory Passkey session
 * window (`outcome: "passkey-fresh"`). Records the original Passkey assertion timestamp (`provedAt`) honestly.
 */
export function passkeyFreshProofDetail(input: {
  at: Date;
  provedAtMs: number;
  generation: number;
  digest: string;
  verb: "approve" | "accept";
  credentialId: string;
  pairedDeviceId: string;
  be: boolean;
  bs: boolean;
}): string {
  return JSON.stringify({
    v: 1,
    at: input.at.toISOString(),
    provedAt: new Date(input.provedAtMs).toISOString(),
    generation: input.generation,
    digest: input.digest,
    verb: input.verb,
    cred: sha256(input.credentialId).toString("hex").slice(0, 12),
    dev: input.pairedDeviceId.slice(0, 24),
    uv: true,
    be: input.be,
    bs: input.bs,
    summary: "Passkey session window",
  });
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function decodeBase64UrlStrict(raw: unknown): Buffer | null {
  if (typeof raw !== "string" || raw.length === 0 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  return Buffer.from(raw, "base64url");
}

function bytesToBigInt(buf: Buffer): bigint {
  let out = 0n;
  for (const byte of buf) out = (out << 8n) | BigInt(byte);
  return out;
}

function isOnP256Curve(xBuf: Buffer, yBuf: Buffer): boolean {
  if (xBuf.length !== 32 || yBuf.length !== 32) return false;
  const x = bytesToBigInt(xBuf);
  const y = bytesToBigInt(yBuf);
  if (x <= 0n || x >= P256_P || y <= 0n || y >= P256_P) return false;
  const lhs = (y * y) % P256_P;
  const rhs = (((x * x) % P256_P) * x - 3n * x + P256_B) % P256_P;
  const normalizedRhs = rhs < 0n ? rhs + P256_P : rhs;
  return lhs === normalizedRhs;
}

/** Encodes raw 32-byte (x, y) P-256 coordinates as SubjectPublicKeyInfo DER and checks Node crypto parses it. */
export function p256CoordsToSpkiDer(x: Buffer, y: Buffer): Buffer | null {
  if (!isOnP256Curve(x, y)) return null;
  const spki = Buffer.concat([P256_SPKI_PREFIX, Buffer.from([0x04]), x, y]);
  try {
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec") return null;
    return spki;
  } catch {
    return null;
  }
}

// ---- Minimal Strict CBOR Decoder (for WebAuthn attestationObject & COSE_Key) ---------------------------------------

type CborValue = number | string | Buffer | boolean | null | CborValue[] | Map<number | string, CborValue>;

function decodeCborItem(buf: Buffer, offset: number, depth: number): { value: CborValue; next: number } {
  if (depth > 8 || offset >= buf.length) throw new Error("cbor_bounds");
  const initial = buf[offset++]!;
  const major = initial >> 5;
  const ai = initial & 0x1f;

  let arg = 0;
  if (ai < 24) {
    arg = ai;
  } else if (ai === 24) {
    if (offset + 1 > buf.length) throw new Error("cbor_eof");
    arg = buf[offset++]!;
  } else if (ai === 25) {
    if (offset + 2 > buf.length) throw new Error("cbor_eof");
    arg = buf.readUInt16BE(offset);
    offset += 2;
  } else if (ai === 26) {
    if (offset + 4 > buf.length) throw new Error("cbor_eof");
    arg = buf.readUInt32BE(offset);
    offset += 4;
  } else {
    // Indefinite length (31) or 64-bit integers are not needed for WebAuthn COSE P-256 keys/attestation.
    throw new Error("cbor_unsupported");
  }

  switch (major) {
    case 0:
      return { value: arg, next: offset };
    case 1:
      return { value: -1 - arg, next: offset };
    case 2: {
      if (offset + arg > buf.length) throw new Error("cbor_eof");
      return { value: Buffer.from(buf.subarray(offset, offset + arg)), next: offset + arg };
    }
    case 3: {
      if (offset + arg > buf.length) throw new Error("cbor_eof");
      return { value: buf.subarray(offset, offset + arg).toString("utf8"), next: offset + arg };
    }
    case 4: {
      if (arg > 256) throw new Error("cbor_limit");
      const arr: CborValue[] = [];
      for (let i = 0; i < arg; i++) {
        const item = decodeCborItem(buf, offset, depth + 1);
        arr.push(item.value);
        offset = item.next;
      }
      return { value: arr, next: offset };
    }
    case 5: {
      if (arg > 256) throw new Error("cbor_limit");
      const map = new Map<number | string, CborValue>();
      for (let i = 0; i < arg; i++) {
        const k = decodeCborItem(buf, offset, depth + 1);
        if (typeof k.value !== "number" && typeof k.value !== "string") throw new Error("cbor_key_type");
        const v = decodeCborItem(buf, k.next, depth + 1);
        map.set(k.value, v.value);
        offset = v.next;
      }
      return { value: map, next: offset };
    }
    case 7:
      if (ai === 20) return { value: false, next: offset };
      if (ai === 21) return { value: true, next: offset };
      if (ai === 22) return { value: null, next: offset };
      throw new Error("cbor_simple");
    default:
      throw new Error("cbor_major");
  }
}

/** Minimal CBOR encoder used by tests and fixture generators to construct valid WebAuthn attestationObjects / COSE keys. */
export function encodeCbor(value: CborValue): Buffer {
  const header = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("non_integer");
    return value >= 0 ? header(0, value) : header(1, -1 - value);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([header(2, value.length), value]);
  if (typeof value === "string") {
    const b = Buffer.from(value, "utf8");
    return Buffer.concat([header(3, b.length), b]);
  }
  if (Array.isArray(value)) return Buffer.concat([header(4, value.length), ...value.map(encodeCbor)]);
  if (value instanceof Map) {
    const parts: Buffer[] = [header(5, value.size)];
    for (const [k, v] of value.entries()) parts.push(encodeCbor(k), encodeCbor(v));
    return Buffer.concat(parts);
  }
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  throw new Error("unsupported_cbor");
}

function parseClientData(rawB64: unknown): { ok: true; raw: Buffer; type: string; challenge: string; origin: string } | { ok: false; code: string; message: string } {
  const raw = decodeBase64UrlStrict(rawB64);
  if (raw === null || raw.length > 8_192) return { ok: false, code: "invalid_client_data", message: "Invalid WebAuthn clientDataJSON." };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, code: "invalid_client_data", message: "WebAuthn clientDataJSON is not valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || typeof parsed["type"] !== "string" || typeof parsed["challenge"] !== "string" || typeof parsed["origin"] !== "string") {
    return { ok: false, code: "invalid_client_data", message: "WebAuthn clientDataJSON is missing required fields." };
  }
  return { ok: true, raw, type: parsed["type"], challenge: parsed["challenge"], origin: parsed["origin"] };
}

export function verifyRegistrationResponse(input: {
  payload: WebAuthnRegistrationPayload;
  expectedChallenge: string;
  rpId?: string;
  expectedOrigin?: string;
}): VerifiedRegistration {
  const rpId = input.rpId ?? PASSKEY_RP_ID;
  const expectedOrigin = input.expectedOrigin ?? PASSKEY_ORIGIN;
  const client = parseClientData(input.payload.clientDataJSON);
  if (!client.ok) return client;
  if (client.type !== "webauthn.create") {
    return { ok: false, code: "invalid_type", message: "Expected webauthn.create clientData type." };
  }
  if (!constantTimeStringEqual(client.challenge, input.expectedChallenge)) {
    return { ok: false, code: "challenge_mismatch", message: "Registration challenge does not match." };
  }
  if (client.origin !== expectedOrigin) {
    return { ok: false, code: "origin_mismatch", message: `Passkey origin must be ${expectedOrigin}.` };
  }

  const attRaw = decodeBase64UrlStrict(input.payload.attestationObject);
  if (attRaw === null || attRaw.length > 16_384) {
    return { ok: false, code: "invalid_attestation", message: "Invalid WebAuthn attestationObject." };
  }
  let attObj: CborValue;
  try {
    const decoded = decodeCborItem(attRaw, 0, 0);
    if (decoded.next !== attRaw.length) return { ok: false, code: "invalid_attestation", message: "Trailing bytes in attestationObject." };
    attObj = decoded.value;
  } catch {
    return { ok: false, code: "invalid_attestation", message: "Could not decode WebAuthn attestationObject CBOR." };
  }
  if (!(attObj instanceof Map)) return { ok: false, code: "invalid_attestation", message: "attestationObject must be a CBOR map." };
  const authData = attObj.get("authData");
  if (!Buffer.isBuffer(authData) || authData.length < 55) {
    return { ok: false, code: "invalid_auth_data", message: "Authenticator data is missing or truncated." };
  }

  const expectedRpHash = sha256(rpId);
  if (!timingSafeEqual(authData.subarray(0, 32), expectedRpHash)) {
    return { ok: false, code: "rp_id_mismatch", message: "Passkey rpIdHash does not match toolroll.dev." };
  }
  const flags = authData[32]!;
  const up = (flags & 0x01) !== 0;
  const uv = (flags & 0x04) !== 0;
  const be = (flags & 0x08) !== 0;
  const bs = (flags & 0x10) !== 0;
  const at = (flags & 0x40) !== 0;
  const ed = (flags & 0x80) !== 0;
  if (!up) return { ok: false, code: "user_presence_required", message: "Passkey registration requires user presence (UP=1)." };
  if (!uv) return { ok: false, code: "user_verification_required", message: "Passkey registration requires user verification (UV=1)." };
  if (!at) return { ok: false, code: "attested_credential_missing", message: "Passkey registration requires attested credential data (AT=1)." };

  const signCount = authData.readUInt32BE(33);
  const credIdLen = authData.readUInt16BE(53);
  if (credIdLen === 0 || credIdLen > 1023 || 55 + credIdLen >= authData.length) {
    return { ok: false, code: "invalid_credential_id", message: "Invalid passkey credentialId length." };
  }
  const credentialIdBuf = authData.subarray(55, 55 + credIdLen);
  const credentialId = credentialIdBuf.toString("base64url");
  if (input.payload.credentialId !== undefined && !constantTimeStringEqual(input.payload.credentialId, credentialId)) {
    return { ok: false, code: "credential_id_mismatch", message: "Credential ID does not match attested authData." };
  }

  let coseKey: CborValue;
  let coseEnd: number;
  try {
    const decoded = decodeCborItem(authData, 55 + credIdLen, 0);
    coseKey = decoded.value;
    coseEnd = decoded.next;
  } catch {
    return { ok: false, code: "invalid_cose_key", message: "Could not decode COSE public key." };
  }
  if (!ed && coseEnd !== authData.length) {
    return { ok: false, code: "invalid_auth_data", message: "Unexpected trailing bytes in authData." };
  }
  if (!(coseKey instanceof Map)) {
    return { ok: false, code: "invalid_cose_key", message: "COSE public key must be a CBOR map." };
  }
  const kty = coseKey.get(1);
  const alg = coseKey.get(3);
  const crv = coseKey.get(-1);
  const x = coseKey.get(-2);
  const y = coseKey.get(-3);
  if (kty !== 2 || alg !== -7 || crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) {
    return { ok: false, code: "unsupported_algorithm", message: "Only ES256 (P-256) passkeys are supported." };
  }
  const spki = p256CoordsToSpkiDer(x, y);
  if (spki === null) {
    return { ok: false, code: "invalid_public_key", message: "Passkey public key is not a valid point on P-256." };
  }

  return {
    ok: true,
    credentialId,
    publicKeySpki: spki.toString("base64url"),
    signCount,
    be,
    bs,
  };
}

export function verifyAssertionResponse(input: {
  payload: WebAuthnAssertionPayload;
  expectedChallenge: string;
  expectedUserHandle: Buffer;
  storedPublicKeySpki: string;
  storedSignCount: number;
  rpId?: string;
  expectedOrigin?: string;
}): VerifiedAssertion {
  const rpId = input.rpId ?? PASSKEY_RP_ID;
  const expectedOrigin = input.expectedOrigin ?? PASSKEY_ORIGIN;
  const client = parseClientData(input.payload.clientDataJSON);
  if (!client.ok) return client;
  if (client.type !== "webauthn.get") {
    return { ok: false, code: "invalid_type", message: "Expected webauthn.get clientData type." };
  }
  if (!constantTimeStringEqual(client.challenge, input.expectedChallenge)) {
    return { ok: false, code: "challenge_mismatch", message: "Assertion challenge does not match." };
  }
  if (client.origin !== expectedOrigin) {
    return { ok: false, code: "origin_mismatch", message: `Passkey origin must be ${expectedOrigin}.` };
  }

  const authData = decodeBase64UrlStrict(input.payload.authenticatorData);
  const signature = decodeBase64UrlStrict(input.payload.signature);
  const userHandle = decodeBase64UrlStrict(input.payload.userHandle);
  if (authData === null || authData.length < 37 || authData.length > 8_192) {
    return { ok: false, code: "invalid_auth_data", message: "Invalid authenticatorData." };
  }
  if (signature === null || signature.length === 0 || signature.length > 256) {
    return { ok: false, code: "invalid_signature", message: "Invalid WebAuthn signature." };
  }
  if (userHandle === null || userHandle.length !== input.expectedUserHandle.length || !timingSafeEqual(userHandle, input.expectedUserHandle)) {
    return { ok: false, code: "user_handle_mismatch", message: "Passkey userHandle does not match this Workspace account." };
  }

  const expectedRpHash = sha256(rpId);
  if (!timingSafeEqual(authData.subarray(0, 32), expectedRpHash)) {
    return { ok: false, code: "rp_id_mismatch", message: "Passkey rpIdHash does not match toolroll.dev." };
  }
  const flags = authData[32]!;
  const up = (flags & 0x01) !== 0;
  const uv = (flags & 0x04) !== 0;
  const be = (flags & 0x08) !== 0;
  const bs = (flags & 0x10) !== 0;
  if (!up) return { ok: false, code: "user_presence_required", message: "Passkey approval requires user presence (UP=1)." };
  if (!uv) return { ok: false, code: "user_verification_required", message: "Passkey approval requires user verification (UV=1)." };

  const newSignCount = authData.readUInt32BE(33);
  // ADR 0005 signCount policy: accept 0 -> 0 (standard for Apple synced passkeys); otherwise require strictly increasing.
  if (!(input.storedSignCount === 0 && newSignCount === 0) && newSignCount <= input.storedSignCount) {
    return { ok: false, code: "sign_count_regression", message: "Passkey signCount did not advance." };
  }

  let publicKey;
  try {
    publicKey = createPublicKey({ key: Buffer.from(input.storedPublicKeySpki, "base64url"), format: "der", type: "spki" });
  } catch {
    return { ok: false, code: "invalid_public_key", message: "Stored passkey public key is unreadable." };
  }

  const signedData = Buffer.concat([authData, sha256(client.raw)]);
  const validSig = cryptoVerify("sha256", signedData, publicKey, signature);
  if (!validSig) {
    return { ok: false, code: "signature_invalid", message: "Passkey signature verification failed." };
  }

  return {
    ok: true,
    credentialId: input.payload.credentialId,
    newSignCount,
    be,
    bs,
  };
}
