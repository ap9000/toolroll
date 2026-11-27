/**
 * Noise Protocol Framework (Revision 34) — `Noise_IKpsk2_25519_ChaChaPoly_SHA256`
 * plus Toolroll companion key/ID derivations (`docs/plans/companion-app/noise-relay-protocol.md`).
 *
 * Zero third-party crypto dependencies: uses Node's built-in `node:crypto` primitives
 * (X25519, ChaCha20-Poly1305, SHA-256, HMAC-SHA256, HKDF-SHA256) and `BigInt` 64-bit
 * byte-encoded nonces (never JS `Number`). Verified byte-for-byte against independent
 * Revision 34 `snow` test vectors in `test/fixtures/companion-noise/vectors.json`.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

export const NOISE_PROTOCOL_NAME = "Noise_IKpsk2_25519_ChaChaPoly_SHA256";
/** Noise Protocol Framework Rev 34 §3 hard ceiling (ciphertext including 16-byte AEAD tag). */
export const MAX_NOISE_MESSAGE_BYTES = 65_535;
export const AEAD_TAG_BYTES = 16;
export const MAX_NOISE_PLAINTEXT_BYTES = MAX_NOISE_MESSAGE_BYTES - AEAD_TAG_BYTES; // 65_519
/** Noise Rev 34 §5.1 reserved REKEY nonce; MUST NEVER be used for transport encryption/decryption. */
export const RESERVED_MAX_NONCE = 0xffff_ffff_ffff_ffffn;
/** Mandatory re-handshake threshold (2^20 messages or 24 hours per spec §1.6). */
export const MAX_SESSION_MESSAGES = 1n << 20n; // 1_048_576
export const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const ZERO_32 = Buffer.alloc(32);

export interface X25519KeyPair {
  privateKey: Buffer; // 32 raw bytes
  publicKey: Buffer; // 32 raw bytes
}

export function generateX25519KeyPair(): X25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: Buffer.from(privDer.subarray(privDer.length - 32)),
    publicKey: Buffer.from(pubDer.subarray(pubDer.length - 32)),
  };
}

export function x25519PublicFromPrivate(privateKey: Buffer): Buffer {
  assertLen(privateKey, 32, "x25519 privateKey");
  const privObj = x25519PrivateKeyObject(privateKey);
  const pubObj = createPublicKey(privObj);
  const pubDer = pubObj.export({ format: "der", type: "spki" });
  return Buffer.from(pubDer.subarray(pubDer.length - 32));
}

function x25519PrivateKeyObject(raw: Buffer): KeyObject {
  assertLen(raw, 32, "x25519 privateKey");
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function x25519PublicKeyObject(raw: Buffer): KeyObject {
  assertLen(raw, 32, "x25519 publicKey");
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function x25519Dh(privateKey: Buffer, publicKey: Buffer): Buffer {
  const secret = diffieHellman({
    privateKey: x25519PrivateKeyObject(privateKey),
    publicKey: x25519PublicKeyObject(publicKey),
  });
  // RFC 7748 §6.1: reject low-order points yielding an all-zero shared secret.
  if (timingSafeEqual(secret, ZERO_32)) {
    throw new Error("X25519 shared secret is all zeros (low-order public key)");
  }
  return secret;
}

function assertLen(buf: Buffer, expected: number, label: string): void {
  if (buf.length !== expected) {
    throw new Error(`${label} must be ${expected} bytes (got ${buf.length})`);
  }
}

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** Noise Protocol Framework Rev 34 §4.3 HKDF(chaining_key, input_key_material, num_outputs). */
function noiseHkdf(ck: Buffer, ikm: Buffer, outputs: 2): [Buffer, Buffer];
function noiseHkdf(ck: Buffer, ikm: Buffer, outputs: 3): [Buffer, Buffer, Buffer];
function noiseHkdf(ck: Buffer, ikm: Buffer, outputs: 2 | 3): Buffer[] {
  const tempKey = hmacSha256(ck, ikm);
  const out1 = hmacSha256(tempKey, Buffer.from([0x01]));
  const out2 = hmacSha256(tempKey, Buffer.concat([out1, Buffer.from([0x02])]));
  if (outputs === 2) return [out1, out2];
  const out3 = hmacSha256(tempKey, Buffer.concat([out2, Buffer.from([0x03])]));
  return [out1, out2, out3];
}

/** 12-byte Noise ChaChaPoly nonce: 4 zero bytes || uint64_le(n). */
export function encodeNoiseNonce(n: bigint): Buffer {
  if (n < 0n || n >= RESERVED_MAX_NONCE) {
    throw new Error(`Noise nonce out of range or reserved (2^64 - 1): ${n.toString()}`);
  }
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(n, 4);
  return nonce;
}

function chachaEncrypt(key: Buffer, nonce: bigint, ad: Buffer, plaintext: Buffer): Buffer {
  if (plaintext.length > MAX_NOISE_PLAINTEXT_BYTES) {
    throw new Error(`Noise plaintext exceeds ${MAX_NOISE_PLAINTEXT_BYTES} bytes`);
  }
  const iv = encodeNoiseNonce(nonce);
  const cipher = createCipheriv("chacha20-poly1305", key, iv, { authTagLength: AEAD_TAG_BYTES });
  cipher.setAAD(ad);
  const ct = cipher.update(plaintext);
  const fin = cipher.final();
  const tag = cipher.getAuthTag();
  return Buffer.concat([ct, fin, tag]);
}

function chachaDecrypt(key: Buffer, nonce: bigint, ad: Buffer, ciphertext: Buffer): Buffer {
  if (ciphertext.length < AEAD_TAG_BYTES || ciphertext.length > MAX_NOISE_MESSAGE_BYTES) {
    throw new Error(`Noise ciphertext length out of bounds: ${ciphertext.length}`);
  }
  const iv = encodeNoiseNonce(nonce);
  const body = ciphertext.subarray(0, ciphertext.length - AEAD_TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - AEAD_TAG_BYTES);
  const decipher = createDecipheriv("chacha20-poly1305", key, iv, { authTagLength: AEAD_TAG_BYTES });
  decipher.setAAD(ad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export class NoiseCipherState {
  private key: Buffer | null;
  private n: bigint;
  private readonly maxMessages: bigint;

  constructor(key: Buffer | null = null, maxMessages: bigint = MAX_SESSION_MESSAGES) {
    if (key !== null) assertLen(key, 32, "cipher key");
    this.key = key === null ? null : Buffer.from(key);
    this.n = 0n;
    this.maxMessages = maxMessages;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  get nonce(): bigint {
    return this.n;
  }

  initializeKey(key: Buffer): void {
    assertLen(key, 32, "cipher key");
    this.key = Buffer.from(key);
    this.n = 0n;
  }

  encryptWithAd(ad: Buffer, plaintext: Buffer, enforceSessionCap = false): Buffer {
    if (this.key === null) return Buffer.from(plaintext);
    if (this.n >= RESERVED_MAX_NONCE) {
      throw new Error("Noise cipher reached reserved nonce 2^64 - 1");
    }
    if (enforceSessionCap && this.n >= this.maxMessages) {
      throw new Error("Noise session message limit reached — re-handshake required");
    }
    const out = chachaEncrypt(this.key, this.n, ad, plaintext);
    this.n += 1n;
    return out;
  }

  decryptWithAd(ad: Buffer, ciphertext: Buffer, enforceSessionCap = false): Buffer {
    if (this.key === null) return Buffer.from(ciphertext);
    if (this.n >= RESERVED_MAX_NONCE) {
      throw new Error("Noise cipher reached reserved nonce 2^64 - 1");
    }
    if (enforceSessionCap && this.n >= this.maxMessages) {
      throw new Error("Noise session message limit reached — re-handshake required");
    }
    const out = chachaDecrypt(this.key, this.n, ad, ciphertext);
    this.n += 1n;
    return out;
  }

  /** Stateless encrypt/decrypt at an explicit uint64 nonce (never mutates internal counter). */
  encryptExplicitNonce(nonce: bigint, ad: Buffer, plaintext: Buffer): Buffer {
    if (this.key === null) throw new Error("CipherState has no key");
    return chachaEncrypt(this.key, nonce, ad, plaintext);
  }

  decryptExplicitNonce(nonce: bigint, ad: Buffer, ciphertext: Buffer): Buffer {
    if (this.key === null) throw new Error("CipherState has no key");
    return chachaDecrypt(this.key, nonce, ad, ciphertext);
  }
}

class SymmetricState {
  readonly cipher = new NoiseCipherState();
  ck: Buffer;
  h: Buffer;

  constructor(protocolName: string) {
    const nameBytes = Buffer.from(protocolName, "ascii");
    this.h = nameBytes.length <= 32
      ? Buffer.concat([nameBytes, Buffer.alloc(32 - nameBytes.length)])
      : sha256(nameBytes);
    this.ck = Buffer.from(this.h);
  }

  mixHash(data: Buffer): void {
    this.h = sha256(Buffer.concat([this.h, data]));
  }

  mixKey(ikm: Buffer): void {
    const [ck, tempK] = noiseHkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cipher.initializeKey(tempK);
  }

  mixKeyAndHash(ikm: Buffer): void {
    const [ck, tempH, tempK] = noiseHkdf(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(tempH);
    this.cipher.initializeKey(tempK);
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    const ct = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    const pt = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split(): [NoiseCipherState, NoiseCipherState] {
    const [k1, k2] = noiseHkdf(this.ck, Buffer.alloc(0), 2);
    return [new NoiseCipherState(k1), new NoiseCipherState(k2)];
  }
}

export class NoiseTransportSession {
  readonly handshakeHash: Buffer;
  readonly remoteStaticPublicKey: Buffer;
  readonly sendCipher: NoiseCipherState;
  readonly recvCipher: NoiseCipherState;
  readonly createdAtMs: number;
  private closed = false;

  constructor(params: {
    handshakeHash: Buffer;
    remoteStaticPublicKey: Buffer;
    sendCipher: NoiseCipherState;
    recvCipher: NoiseCipherState;
    createdAtMs?: number;
  }) {
    this.handshakeHash = Buffer.from(params.handshakeHash);
    this.remoteStaticPublicKey = Buffer.from(params.remoteStaticPublicKey);
    this.sendCipher = params.sendCipher;
    this.recvCipher = params.recvCipher;
    this.createdAtMs = params.createdAtMs ?? Date.now();
  }

  isExpired(nowMs = Date.now()): boolean {
    return this.closed
      || nowMs - this.createdAtMs >= MAX_SESSION_AGE_MS
      || this.sendCipher.nonce >= MAX_SESSION_MESSAGES
      || this.recvCipher.nonce >= MAX_SESSION_MESSAGES;
  }

  close(): void {
    this.closed = true;
  }

  encrypt(plaintext: Buffer, nowMs = Date.now()): Buffer {
    if (this.closed) throw new Error("Noise transport session is closed");
    if (nowMs - this.createdAtMs >= MAX_SESSION_AGE_MS) {
      this.closed = true;
      throw new Error("Noise session exceeded 24h lifetime — re-handshake required");
    }
    if (plaintext.length > MAX_NOISE_PLAINTEXT_BYTES) {
      throw new Error(`Noise transport plaintext exceeds ${MAX_NOISE_PLAINTEXT_BYTES} bytes`);
    }
    try {
      return this.sendCipher.encryptWithAd(Buffer.alloc(0), plaintext, true);
    } catch (err) {
      this.closed = true;
      throw err;
    }
  }

  decrypt(ciphertext: Buffer, nowMs = Date.now()): Buffer {
    if (this.closed) throw new Error("Noise transport session is closed");
    if (nowMs - this.createdAtMs >= MAX_SESSION_AGE_MS) {
      this.closed = true;
      throw new Error("Noise session exceeded 24h lifetime — re-handshake required");
    }
    if (ciphertext.length > MAX_NOISE_MESSAGE_BYTES) {
      this.closed = true;
      throw new Error(`Noise transport ciphertext exceeds ${MAX_NOISE_MESSAGE_BYTES} bytes`);
    }
    try {
      return this.recvCipher.decryptWithAd(Buffer.alloc(0), ciphertext, true);
    } catch (err) {
      this.closed = true;
      throw err;
    }
  }
}

export interface InitiatorOptions {
  localStatic: X25519KeyPair;
  remoteStaticPublicKey: Buffer;
  psk: Buffer;
  prologue: Buffer;
  /** Deterministic ephemeral keypair for test vectors only. */
  ephemeralForTest?: X25519KeyPair;
}

export class NoiseIKpsk2Initiator {
  private readonly sym: SymmetricState;
  private readonly s: X25519KeyPair;
  private readonly rs: Buffer;
  private readonly psk: Buffer;
  private readonly fixedE: X25519KeyPair | undefined;
  private e: X25519KeyPair | null = null;
  private step: 0 | 1 | 2 = 0;

  constructor(opts: InitiatorOptions) {
    assertLen(opts.localStatic.privateKey, 32, "localStatic.privateKey");
    assertLen(opts.localStatic.publicKey, 32, "localStatic.publicKey");
    assertLen(opts.remoteStaticPublicKey, 32, "remoteStaticPublicKey");
    assertLen(opts.psk, 32, "psk");
    this.s = opts.localStatic;
    this.rs = Buffer.from(opts.remoteStaticPublicKey);
    this.psk = Buffer.from(opts.psk);
    this.fixedE = opts.ephemeralForTest;
    this.sym = new SymmetricState(NOISE_PROTOCOL_NAME);
    this.sym.mixHash(opts.prologue);
    // Pre-message: <- s
    this.sym.mixHash(this.rs);
  }

  /** Message 1: -> e, es, s, ss */
  writeMessage1(payload: Buffer): Buffer {
    if (this.step !== 0) throw new Error("writeMessage1 already called");
    const e = this.fixedE ?? generateX25519KeyPair();
    this.e = e;
    // e (PSK handshake §9.2: MixHash(e.pub) followed by MixKey(e.pub))
    this.sym.mixHash(e.publicKey);
    this.sym.mixKey(e.publicKey);
    // es
    this.sym.mixKey(x25519Dh(e.privateKey, this.rs));
    // s
    const encS = this.sym.encryptAndHash(this.s.publicKey);
    // ss
    this.sym.mixKey(x25519Dh(this.s.privateKey, this.rs));
    // payload
    const encPayload = this.sym.encryptAndHash(payload);
    const msg = Buffer.concat([e.publicKey, encS, encPayload]);
    if (msg.length > MAX_NOISE_MESSAGE_BYTES) {
      throw new Error(`Noise message 1 exceeds ${MAX_NOISE_MESSAGE_BYTES} bytes`);
    }
    this.step = 1;
    return msg;
  }

  /** Message 2: <- e, ee, se, psk */
  readMessage2(message: Buffer, nowMs?: number): { payload: Buffer; session: NoiseTransportSession } {
    if (this.step !== 1 || this.e === null) throw new Error("readMessage2 called out of order");
    if (message.length < 32 + AEAD_TAG_BYTES || message.length > MAX_NOISE_MESSAGE_BYTES) {
      throw new Error(`Invalid Noise message 2 length: ${message.length}`);
    }
    const re = message.subarray(0, 32);
    const encPayload = message.subarray(32);
    // e (PSK handshake §9.2: MixHash(re) then MixKey(re))
    this.sym.mixHash(re);
    this.sym.mixKey(re);
    // ee
    this.sym.mixKey(x25519Dh(this.e.privateKey, re));
    // se
    this.sym.mixKey(x25519Dh(this.s.privateKey, re));
    // psk
    this.sym.mixKeyAndHash(this.psk);
    // payload
    const payload = this.sym.decryptAndHash(encPayload);
    const [sendCipher, recvCipher] = this.sym.split();
    this.step = 2;
    const session = new NoiseTransportSession({
      handshakeHash: this.sym.h,
      remoteStaticPublicKey: this.rs,
      sendCipher,
      recvCipher,
      ...(nowMs !== undefined ? { createdAtMs: nowMs } : {}),
    });
    return { payload, session };
  }
}

export interface ResponderOptions {
  localStatic: X25519KeyPair;
  psk: Buffer;
  prologue: Buffer;
  /** Deterministic ephemeral keypair for test vectors only. */
  ephemeralForTest?: X25519KeyPair;
}

export class NoiseIKpsk2Responder {
  private readonly sym: SymmetricState;
  private readonly s: X25519KeyPair;
  private readonly psk: Buffer;
  private readonly fixedE: X25519KeyPair | undefined;
  private re: Buffer | null = null;
  private rsRemote: Buffer | null = null;
  private step: 0 | 1 | 2 = 0;

  constructor(opts: ResponderOptions) {
    assertLen(opts.localStatic.privateKey, 32, "localStatic.privateKey");
    assertLen(opts.localStatic.publicKey, 32, "localStatic.publicKey");
    assertLen(opts.psk, 32, "psk");
    this.s = opts.localStatic;
    this.psk = Buffer.from(opts.psk);
    this.fixedE = opts.ephemeralForTest;
    this.sym = new SymmetricState(NOISE_PROTOCOL_NAME);
    this.sym.mixHash(opts.prologue);
    // Pre-message: <- s
    this.sym.mixHash(this.s.publicKey);
  }

  /**
   * Message 1: -> e, es, s, ss.
   * Per spec §1.2: responder MUST NOT execute RPCs or mutate durable state from msg 1 payload.
   */
  readMessage1(message: Buffer): { payload: Buffer; remoteStaticPublicKey: Buffer } {
    if (this.step !== 0) throw new Error("readMessage1 already called");
    // 32 (e) + 48 (encrypted s) + 16 (min payload tag) = 96 bytes minimum
    if (message.length < 32 + 48 + AEAD_TAG_BYTES || message.length > MAX_NOISE_MESSAGE_BYTES) {
      throw new Error(`Invalid Noise message 1 length: ${message.length}`);
    }
    const re = message.subarray(0, 32);
    const encS = message.subarray(32, 80);
    const encPayload = message.subarray(80);
    // e (PSK handshake §9.2)
    this.sym.mixHash(re);
    this.sym.mixKey(re);
    // es
    this.sym.mixKey(x25519Dh(this.s.privateKey, re));
    // s
    const rsRemote = this.sym.decryptAndHash(encS);
    assertLen(rsRemote, 32, "remote static public key");
    // ss
    this.sym.mixKey(x25519Dh(this.s.privateKey, rsRemote));
    // payload
    const payload = this.sym.decryptAndHash(encPayload);
    this.re = Buffer.from(re);
    this.rsRemote = rsRemote;
    this.step = 1;
    return { payload, remoteStaticPublicKey: Buffer.from(rsRemote) };
  }

  /** Message 2: <- e, ee, se, psk */
  writeMessage2(payload: Buffer, nowMs?: number): { message: Buffer; session: NoiseTransportSession } {
    if (this.step !== 1 || this.re === null || this.rsRemote === null) {
      throw new Error("writeMessage2 called out of order");
    }
    const e = this.fixedE ?? generateX25519KeyPair();
    // e (PSK handshake §9.2)
    this.sym.mixHash(e.publicKey);
    this.sym.mixKey(e.publicKey);
    // ee
    this.sym.mixKey(x25519Dh(e.privateKey, this.re));
    // se
    this.sym.mixKey(x25519Dh(e.privateKey, this.rsRemote));
    // psk
    this.sym.mixKeyAndHash(this.psk);
    // payload
    const encPayload = this.sym.encryptAndHash(payload);
    const message = Buffer.concat([e.publicKey, encPayload]);
    if (message.length > MAX_NOISE_MESSAGE_BYTES) {
      throw new Error(`Noise message 2 exceeds ${MAX_NOISE_MESSAGE_BYTES} bytes`);
    }
    const [recvCipher, sendCipher] = this.sym.split();
    this.step = 2;
    const session = new NoiseTransportSession({
      handshakeHash: this.sym.h,
      remoteStaticPublicKey: this.rsRemote,
      sendCipher,
      recvCipher,
      ...(nowMs !== undefined ? { createdAtMs: nowMs } : {}),
    });
    return { message, session };
  }
}

// ---- Toolroll Companion Prologues & Key/ID Derivations ----------------------

function assertNoNul(value: string, label: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be non-empty and contain no NUL bytes`);
  }
}

/** `toolroll-noise-v1\0pair\0<workspaceId>\0<pairSessionId>` */
export function buildPairingPrologue(workspaceId: string, pairSessionId: string): Buffer {
  assertNoNul(workspaceId, "workspaceId");
  assertNoNul(pairSessionId, "pairSessionId");
  return Buffer.from(`toolroll-noise-v1\0pair\0${workspaceId}\0${pairSessionId}`, "utf8");
}

/** `toolroll-noise-v1\0session\0<workspaceId>\0<deviceId>\0<recoveryGeneration>` */
export function buildSessionPrologue(workspaceId: string, deviceId: string, recoveryGeneration: string): Buffer {
  assertNoNul(workspaceId, "workspaceId");
  assertNoNul(deviceId, "deviceId");
  if (!/^[0-9a-f]{32}$/.test(recoveryGeneration)) {
    throw new Error(`Invalid recoveryGeneration (expected 32 lowercase hex chars): ${recoveryGeneration}`);
  }
  return Buffer.from(`toolroll-noise-v1\0session\0${workspaceId}\0${deviceId}\0${recoveryGeneration}`, "utf8");
}

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RFC4648_LOWER_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(data: Buffer, alphabet: string): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(acc >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += alphabet[(acc << (5 - bits)) & 0x1f];
  }
  return out;
}

/** 6-character Crockford Base32 confirmation code formatted `XXX-XXX` derived from Noise `h_pair`. */
export function deriveConfirmationCode(handshakeHash: Buffer): string {
  assertLen(handshakeHash, 32, "handshakeHash");
  const okm = Buffer.from(hkdfSync("sha256", handshakeHash, Buffer.alloc(0), Buffer.from("toolroll-pair-confirm-v1", "ascii"), 8));
  const raw = base32Encode(okm, CROCKFORD_ALPHABET);
  return `${raw.slice(0, 3)}-${raw.slice(3, 6)}`;
}

/** `HKDF-SHA256(ikm = pskEntropy, salt = h_pair, info = "toolroll-device-psk-v1:<workspaceId>:<deviceId>", len = 32)` */
export function deriveDevicePsk(pskEntropy: Buffer, handshakeHash: Buffer, workspaceId: string, deviceId: string): Buffer {
  assertLen(pskEntropy, 32, "pskEntropy");
  assertLen(handshakeHash, 32, "handshakeHash");
  assertNoNul(workspaceId, "workspaceId");
  assertNoNul(deviceId, "deviceId");
  const info = Buffer.from(`toolroll-device-psk-v1:${workspaceId}:${deviceId}`, "utf8");
  return Buffer.from(hkdfSync("sha256", pskEntropy, handshakeHash, info, 32));
}

/** Deterministic `machineId = base32_lower(SHA-256("toolroll-machine-id-v1\0" || relayMachinePub))[0..26]`. */
export function deriveMachineId(relayMachinePublicKey: Buffer): string {
  assertLen(relayMachinePublicKey, 32, "relayMachinePublicKey");
  const digest = sha256(Buffer.concat([Buffer.from("toolroll-machine-id-v1\0", "ascii"), relayMachinePublicKey]));
  return base32Encode(digest, RFC4648_LOWER_ALPHABET).slice(0, 26);
}

/** Deterministic opaque 32-byte WebAuthn `user.id` per `(workspaceId, accountName)`. */
export function derivePasskeyUserHandle(workspaceId: string, accountName: string): Buffer {
  assertNoNul(workspaceId, "workspaceId");
  assertNoNul(accountName, "accountName");
  return sha256(Buffer.from(`toolroll-passkey-user-v1\0${workspaceId}\0${accountName}`, "utf8"));
}

/** Generate 32 cryptographically random bytes (for `pairPsk` / `pskEntropy`). */
export function randomPsk32(): Buffer {
  return randomBytes(32);
}
