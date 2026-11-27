/**
 * Gate 1 Companion Daemon Engine — Pairing Ceremony, Noise IKpsk2 Session Manager,
 * PairedDevicePrincipal (NEVER loopback / requestFromThisComputer === false),
 * and Explicit Read-Only RPC Allowlist (`docs/plans/companion-app/threat-model-and-routes.md`).
 *
 * Wire: `docs/plans/companion-app/noise-relay-protocol.md` §1–§3 and test/fixtures/companion-wire.json.
 *
 * Pairing (one state machine per pairing; every transition is synchronous — nothing awaits between a check and the
 * state it sets):
 *   awaiting_scan → (some socket passes message 1) awaiting_ready → (the first socket to prove the pairing PSK with
 *   `pair.ready`) awaiting_confirm → (owner confirms; the row is saved PENDING) confirming → (relays admitted; the
 *   outcome RES with the PSK entropy is sent — the linearization point) finishing → (`pair.done` or the phone's first
 *   hello activates the row) paired. A second socket that proves the PSK while one is attached contests the pairing.
 *   Terminal states (paired, cancelled, expired, contested, failed) are kept 60 s for Settings, then forgotten.
 *
 * Sessions: a known phone's message 1 gets message 2 (padded to one size for every outcome). A retired phone, or one
 * whose account no longer stands, gets an authenticated `refused` message 2 instead. The phone's first transport
 * message must be `device.hello`; a live session that loses standing gets a stream-0 ERROR and closes 4403.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Store } from "../store.js";
import { pathsAllowed, type CompanionPath } from "./paths.js";
import {
  buildPairingPrologue,
  buildSessionPrologue,
  deriveConfirmationCode,
  deriveDevicePsk,
  MAX_SESSION_AGE_MS,
  MAX_SESSION_MESSAGES,
  NoiseIKpsk2Responder,
  NoiseTransportSession,
  randomPsk32,
} from "./noise.js";
import {
  CompanionStreamGuard,
  decodeCreditPayload,
  decodeFrame,
  encodeErrorPayload,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FrameType,
  GlobalBufferBudget,
  LiveWatchBuffer,
  MAX_FRAME_PAYLOAD_BYTES,
  PACING_PER_CONNECTION,
  TokenBucket,
  WATCH_IDLE_DEADLINE_MS,
  UnaryResponsePacer,
  type CompanionFrame,
} from "./framing.js";
import { decodeRelayEnvelope, encodeRelayEnvelope, RelayOp, signRelayToken } from "./relay-auth.js";
import {
  activatePendingDevice,
  deletePendingDevice,
  deviceAccountStands,
  getPairedDevice,
  livePairedDevices,
  loadOrCreateCompanionHostKeys,
  MAX_PHONES_PER_MAC,
  PENDING_ACTIVATION_MS,
  phoneCount,
  revokePairedDeviceRecord,
  sanitizeDeviceName,
  savePendingDevice,
  sweepCompanionRecords,
  touchPairedDeviceLastSeen,
  type CompanionHostKeys,
  type PairedDeviceRow,
  type RetiredReason,
} from "./store.js";

export const PAIRING_TTL_MS = 5 * 60 * 1000;
/** From a phone socket opening to its message 1. */
export const DAEMON_HANDSHAKE_DEADLINE_MS = 5_000;
/** From message 2 to the pairing phone's `pair.ready`. */
export const PAIR_READY_DEADLINE_MS = 10_000;
/** From message 2 to the session phone's first transport message (device.hello). A refused phone waits the same. */
export const HELLO_DEADLINE_MS = 10_000;
/** Every message 2 payload (pair and session, every status) is padded to exactly this many plaintext bytes. */
export const MSG2_PLAINTEXT_BYTES = 160;
/** How long a finished pairing is kept for Settings to read its outcome. */
export const PAIRING_TERMINAL_KEEP_MS = 60_000;
/** Phone connections one relay link may carry at once (the relays allow 4; a link past this is misbehaving). */
export const MAX_PEERS_PER_RELAY_LINK = 8;
/** Message 1 replay cache: how long an ephemeral key is remembered, and how many (per pairing or device id, total). */
export const MSG1_REPLAY_WINDOW_MS = 15 * 60 * 1000;
export const MSG1_REPLAY_PER_ID = 64;
export const MSG1_REPLAY_TOTAL = 4096;

/** The relay's id grammar for pairing and device ids (protocol §3.3). */
const PEER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PAIR_READY_STREAM = 1;
const PAIR_DONE_STREAM = 3;
/** A session is ended for a fresh handshake this long before its 24 h limit, and this many messages before 2^20, so
 * the stream-0 `rekey` ERROR itself can still be encrypted. */
const REKEY_MARGIN_MS = 60_000;
const REKEY_MARGIN_MESSAGES = 16n;
/** Live standing is re-read at most this often per phone on its frames (the 1 s sweep always reads it fresh). */
const STANDING_CACHE_MS = 250;

const CLOSE_NORMAL = 1000;
const CLOSE_REVOKED = 4403;
const CLOSE_TIMEOUT = 4408;

/**
 * Dedicated principal bound directly at the decrypted Noise session layer.
 * `requestFromThisComputer` is unconditionally `false` — paired devices are NEVER
 * forwarded over loopback HTTP (`127.0.0.1`) or treated as local-owner.
 */
export interface PairedDevicePrincipal {
  readonly kind: "paired-device";
  readonly deviceId: string;
  readonly accountName: string;
  readonly workspaceId: string;
  readonly recoveryGeneration: string;
  readonly requestFromThisComputer: false;
}

/** Explicit static Gate 1 Read-Only RPC allowlist (modeled on REMOTE_TUI_READ_ROUTES). */
export const PAIRED_DEVICE_GATE1_ROUTES = new Set<string>([
  "device.hello",
  "work.rows",
  "task.steps",
  "task.diff",
  "task.approval.read",
  "run.window.read",
  "run.watch.subscribe",
  "device.self.revoke",
]);

export interface CompanionReadHandlers {
  deviceHello: (principal: PairedDevicePrincipal) => Promise<unknown> | unknown;
  workRows: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  taskSteps: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  taskDiff: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Pure read helper (`mintNonce: false`) — NEVER calls GET /t/<task>/approval. */
  taskApprovalRead: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  runWindowRead: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  /** What the account may see right now, as an opaque fingerprint (its standing, credential generation, projects and
   * the console's ceiling). Taken before a read; anything queued for the phone is sent only while it still matches. */
  accessSignature?: (principal: PairedDevicePrincipal) => string;
  /** Subscribe to live run deltas; returned `unsubscribe` stops watching ONLY (never stops the run). `emit` and `end`
   * may be called synchronously inside this call (a backlog, an already-finished run): they are delivered. */
  runWatchSubscribe?: (
    principal: PairedDevicePrincipal,
    params: Record<string, unknown>,
    emit: (record: Buffer) => void,
    /** The run finished: the phone gets END after everything emitted is delivered. `denied`: the account can no longer
     * see it — whatever is queued is discarded and the phone gets an error instead. */
    end?: (reason?: "denied") => void,
  ) => { ok: true; unsubscribe: () => void } | { ok: false; code: string; message: string };
}

export interface PairingQrPayload {
  v: 2;
  /** How the phone can reach this Mac, direct first (paths.ts). */
  paths: CompanionPath[];
  machineId: string;
  workspaceId: string;
  macStaticPub: string; // base64url(32B X25519)
  pairSessionId: string;
  pairPsk: string; // base64url(32B)
  /** When the code stops working (the phone shows "The code expired" after it). */
  expiresAtMs: number;
  /** 5-min Ed25519 role=pair token for the hosted relay — present only when there is a hosted path. */
  pairConnToken?: string;
}

export type PairingStatus = "awaiting_scan" | "awaiting_ready" | "awaiting_confirm" | "confirming" | "finishing" | "paired" | "cancelled" | "expired" | "contested" | "failed";

/** What Settings shows of one pairing (polled every second while it's open). */
export interface PairingView {
  pairSessionId: string;
  status: PairingStatus;
  expiresAtMs: number;
  confirmCode: string | null;
  deviceName: string | null;
  deviceId: string | null;
  error: string | null;
}

const TERMINAL = new Set<PairingStatus>(["paired", "cancelled", "expired", "contested", "failed"]);

/** The ERROR code a pairing phone gets for a pairing that ended (or for a late socket on one that did). */
type PairingErrorCode = "pairing_cancelled" | "pairing_expired" | "pairing_contested" | "pairing_failed";
const PAIRING_ERROR_MESSAGE: Record<PairingErrorCode, string> = {
  pairing_cancelled: "Pairing was cancelled on your Mac.",
  pairing_expired: "The code expired. Start again on your Mac.",
  pairing_contested: "Another device used this code. Pair again.",
  pairing_failed: "Pairing didn't finish. Start again on your Mac.",
};
const errorCodeOf = (status: PairingStatus): PairingErrorCode =>
  status === "cancelled" ? "pairing_cancelled" : status === "expired" ? "pairing_expired" : status === "failed" ? "pairing_failed" : "pairing_contested";

interface Pairing {
  pairSessionId: string;
  accountName: string;
  /** Who may see, confirm and cancel this pairing: the console's binding of the person and the very session that
   * started it (opaque to the engine). A different session — even the same account's — gets "unknown pairing". */
  binding: string;
  /** The account's credential generation that authorized the pairing: it must still hold when the phone is saved. */
  accountGeneration: number;
  pairPsk: Buffer;
  expiresAtMs: number;
  status: PairingStatus;
  terminalAtMs: number | null;
  /** The socket that proved the PSK first (link + connId); its handshake is the one the code was derived from. */
  attachedKey: string | null;
  confirmCode: string | null;
  deviceName: string | null;
  phoneStaticPub: Buffer | null;
  deviceRelayPub: Buffer | null;
  handshakeHash: Buffer | null;
  /** Set at confirm: the pending row this pairing saved. */
  deviceId: string | null;
  pendingCreatedAtMs: number | null;
  error: string | null;
}

/** A way phones reach the engine: the hosted relay's socket (many phones, one connId each) or one direct socket
 * (connId 1). A peer is identified by its link AND its connId — two links can both carry a connId 1. */
export interface PeerLink {
  readonly id: string;
  send(connId: number, payload: Buffer): void;
  /** Ends one phone connection: `code` is its WebSocket close code where the link controls one (direct), and travels
   * in the relay's PEER_CLOSE otherwise. */
  close(connId: number, reason: string, code?: number): void;
  /** Bytes queued on this link and not yet written to the network (a phone that stops reading grows it). */
  backlog?(): number;
  /** The backlog past which a peer sending on this link is dropped rather than queued for. */
  readonly backlogLimit?: number;
  /** Downstream pacing for the whole link (the hosted relay's aggregate budget). Present only on hosted links: each
   * phone connection on such a link also gets its own bucket. */
  readonly pacing?: TokenBucket;
  /** Phone connections this link may carry at once (relay links: MAX_PEERS_PER_RELAY_LINK). */
  readonly maxPeers?: number;
}

/** A relay socket as a link: frames ride PEER_DATA envelopes, a drop is a PEER_CLOSE. */
export function relayEnvelopeLink(id: string, sendEnvelope: (envelope: Buffer) => void, opts: { backlog?: { bytes: () => number; limit: number }; pacing?: TokenBucket } = {}): PeerLink {
  return {
    id,
    maxPeers: MAX_PEERS_PER_RELAY_LINK,
    ...(opts.backlog === undefined ? {} : { backlog: opts.backlog.bytes, backlogLimit: opts.backlog.limit }),
    ...(opts.pacing === undefined ? {} : { pacing: opts.pacing }),
    send: (connId, payload) => sendEnvelope(encodeRelayEnvelope({ op: RelayOp.PEER_DATA, connId, payload })),
    close: (connId, reason, code) => sendEnvelope(encodeRelayEnvelope({
      op: RelayOp.PEER_CLOSE, connId, payload: Buffer.from(JSON.stringify(code === undefined ? { reason } : { reason, code }), "utf8"),
    })),
  };
}

const peerKeyOf = (link: PeerLink, connId: number): string => `${link.id}:${connId}`;

/** Sockets one pairing or device id may hold that haven't sent message 1 yet; a newer one evicts the oldest. Sockets
 * past message 1 are never evicted by a newcomer (§2.4): with the replay cache only the key holder makes those. */
const MAX_UNPROVEN_PER_PEER_ID = 2;

type PeerState = "awaiting_msg1" | "pair_awaiting_ready" | "pair_attached" | "pair_finishing" | "awaiting_hello" | "refusing" | "authenticated";

interface ActivePeerConn {
  key: string;
  link: PeerLink;
  connId: number;
  role: "pair" | "device";
  peerId: string;
  state: PeerState;
  openedAtMs: number;
  /** The deadline of the current state (message 1, pair.ready, hello), or null. */
  timer: ReturnType<typeof setTimeout> | null;
  session: NoiseTransportSession | null;
  principal: PairedDevicePrincipal | null;
  /** A pairing socket past message 1: what its handshake proved (used if it becomes the attached one). */
  pairProof: { phoneStaticPub: Buffer; deviceRelayPub: Buffer; handshakeHash: Buffer } | null;
  streamGuard: CompanionStreamGuard;
  unaryPacers: Map<number, UnaryResponsePacer>;
  watchStreams: Map<number, WatchEntry>;
  /** Each open stream's access fingerprint when its read began (accessSignature). */
  streamAccess: Map<number, string>;
  /** Downstream pacing for this connection (hosted links only). */
  bucket: TokenBucket | null;
  /** Streams with frames ready but held by pacing, in the order they will be served (one ordered queue). */
  waiting: number[];
  draining: boolean;
  pacingTimer: ReturnType<typeof setTimeout> | null;
  /** The live standing as last read (re-read at most every 250 ms on frames; the sweep reads it fresh). */
  cache: { standingAt: number; standing: StandingCode | null };
}

type StandingCode = "device_revoked" | "account_revoked";

interface WatchEntry { buffer: LiveWatchBuffer; unsubscribe: () => void; seq: number; ending: boolean; lastCreditAtMs: number }

/** A PING's payload is echoed back: anything bigger than a keepalive's token is refused. */
const MAX_PING_PAYLOAD_BYTES = 64;
/** How often deadlines that no inbound frame would trigger are checked (stuck requests, stalled responses, idle watches,
 * pairing expiry, standing of live sessions). Runs only while a phone is connected or a pairing is open. */
const DEADLINE_SWEEP_MS = 1_000;

/** A message 2 payload padded with `pad` to exactly MSG2_PLAINTEXT_BYTES, so every outcome is the same size. */
export function paddedMsg2(fields: Record<string, unknown>): Buffer {
  const unpadded = Buffer.byteLength(JSON.stringify({ ...fields, pad: "" }), "utf8");
  if (unpadded > MSG2_PLAINTEXT_BYTES) throw new Error("message 2 payload exceeds its padded size");
  return Buffer.from(JSON.stringify({ ...fields, pad: "0".repeat(MSG2_PLAINTEXT_BYTES - unpadded) }), "utf8");
}

/**
 * Message 1 ephemerals seen in the last 15 minutes (§2.4): a repeated one is a replay and is dropped before any Noise
 * work. Bounded per id and in total; the oldest entries go first.
 */
class Msg1ReplayCache {
  private readonly entries = new Map<string, number>(); // `${id}\0${ephemeral hex}` → expiry, in insertion order
  private readonly perId = new Map<string, string[]>();

  private forget(key: string): void {
    this.entries.delete(key);
    const id = key.slice(0, key.indexOf("\0"));
    const list = this.perId.get(id);
    if (list === undefined) return;
    const at = list.indexOf(key);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.perId.delete(id);
  }

  private prune(nowMs: number): void {
    for (const [key, expiry] of this.entries) {
      if (expiry > nowMs) break;
      this.forget(key);
    }
  }

  seen(id: string, ephemeral: Buffer, nowMs: number): boolean {
    this.prune(nowMs);
    return this.entries.has(`${id}\0${ephemeral.toString("hex")}`);
  }

  remember(id: string, ephemeral: Buffer, nowMs: number): void {
    this.prune(nowMs);
    const key = `${id}\0${ephemeral.toString("hex")}`;
    if (this.entries.has(key)) return;
    this.entries.set(key, nowMs + MSG1_REPLAY_WINDOW_MS);
    const list = this.perId.get(id) ?? [];
    list.push(key);
    this.perId.set(id, list);
    while (list.length > MSG1_REPLAY_PER_ID) this.forget(list[0]!);
    while (this.entries.size > MSG1_REPLAY_TOTAL) this.forget(this.entries.keys().next().value!);
  }
}

export interface CompanionDaemonOptions {
  store: Store;
  handlers: CompanionReadHandlers;
  /** The single relay link of a one-relay setup (tests, the reference relay). Links are otherwise passed per call. */
  sendToRelay?: (envelope: Buffer) => void;
  /** A pairing was confirmed and its PENDING row saved: every connected hosted relay must admit the phone before it is
   * told (resolve) — a refusal (reject) fails the pairing. The callee compensates relays that admitted when another
   * refused; the engine compensates (onDeviceRevoked) when it fails the pairing after this resolved. */
  onDeviceRegistered?: (deviceId: string, deviceRelayPubB64: string) => Promise<void> | void;
  /** A phone's row was retired or deleted: relays should forget it. Called in the background, never awaited. */
  onDeviceRevoked?: (deviceId: string) => Promise<void> | void;
  handshakeDeadlineMs?: number;
  helloDeadlineMs?: number;
  readyDeadlineMs?: number;
  nowMs?: () => number;
  /** The ways a phone can reach this Mac (setPathsProvider replaces it). */
  paths?: () => CompanionPath[];
  /** This console's address for the phone's Handoff links (device.hello's `consoleUrl`), or null when unknown. */
  consoleUrl?: () => string | null;
  /** Test seam: the per-connection pacing budget on hosted links. */
  pacingPerConnection?: { ratePerMin: number; burst: number };
}

export class CompanionDaemonEngine {
  readonly hostKeys: CompanionHostKeys;
  private readonly store: Store;
  private readonly handlers: CompanionReadHandlers;
  private readonly defaultLink: PeerLink | null;
  private readonly onDeviceRegistered: ((deviceId: string, deviceRelayPubB64: string) => Promise<void> | void) | undefined;
  private readonly onDeviceRevoked: ((deviceId: string) => Promise<void> | void) | undefined;
  private readonly handshakeDeadlineMs: number;
  private readonly helloDeadlineMs: number;
  private readonly readyDeadlineMs: number;
  private readonly nowMs: () => number;
  private readonly consoleUrl: () => string | null;
  private readonly pacingPerConnection: { ratePerMin: number; burst: number };
  private readonly globalBudget = new GlobalBufferBudget();
  private readonly replay = new Msg1ReplayCache();
  private readonly pairings = new Map<string, Pairing>();
  private readonly peers = new Map<string, ActivePeerConn>();
  /** The ways a phone can reach this Mac right now (the QR's and every hello's `paths`), set by the service. */
  private pathsOf: () => CompanionPath[] = () => [];
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CompanionDaemonOptions) {
    this.store = opts.store;
    this.handlers = opts.handlers;
    this.defaultLink = opts.sendToRelay === undefined ? null : relayEnvelopeLink("relay", opts.sendToRelay);
    this.onDeviceRegistered = opts.onDeviceRegistered;
    this.onDeviceRevoked = opts.onDeviceRevoked;
    this.handshakeDeadlineMs = opts.handshakeDeadlineMs ?? DAEMON_HANDSHAKE_DEADLINE_MS;
    this.helloDeadlineMs = opts.helloDeadlineMs ?? HELLO_DEADLINE_MS;
    this.readyDeadlineMs = opts.readyDeadlineMs ?? PAIR_READY_DEADLINE_MS;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.consoleUrl = opts.consoleUrl ?? (() => null);
    this.pacingPerConnection = opts.pacingPerConnection ?? PACING_PER_CONNECTION;
    if (opts.paths !== undefined) this.pathsOf = opts.paths;
    this.hostKeys = loadOrCreateCompanionHostKeys(this.store.handle, new Date(this.nowMs()));
  }

  setPathsProvider(provider: () => CompanionPath[]): void {
    this.pathsOf = provider;
  }

  // ---- Pairing: the Mac's side (Settings) --------------------------------------------------------------------------

  /** Step 1 of pairing: initiated ONLY by a signed-in approver account on the Mac, at its current credential generation.
   * `binding` names the person and the session that started it; the view, confirmation and cancellation answer only to
   * the same binding. */
  startPairing(accountName: string, binding: string, accountGeneration: number): { ok: true; qr: PairingQrPayload; expiresAtMs: number } | { ok: false; error: string } {
    const account = this.store.accountOf(accountName);
    if (account === null || account.revokedAt !== null || account.role !== "approver" || account.generation !== accountGeneration) {
      return { ok: false, error: "Only an active approver account can start pairing." };
    }
    const now = this.nowMs();
    if (phoneCount(this.store.handle, new Date(now)) >= MAX_PHONES_PER_MAC) {
      return { ok: false, error: `This Mac already has ${MAX_PHONES_PER_MAC} phones. Remove one first.` };
    }
    // One pairing at a time per binding: a new QR retires the previous one (unless it is already finishing on its
    // phone, which must be left to complete).
    for (const p of [...this.pairings.values()]) {
      if (p.binding !== binding) continue;
      if (TERMINAL.has(p.status)) this.pairings.delete(p.pairSessionId);
      else if (p.status !== "finishing") { this.endPairing(p, "cancelled"); this.pairings.delete(p.pairSessionId); }
    }
    const paths = this.pathsOf();
    if (!pathsAllowed(paths)) return { ok: false, error: "A phone has no way to reach this Mac yet: join a Wi-Fi network or turn on Connect from anywhere." };
    const hosted = paths.find(path => path.kind === "hosted");
    const identity = this.store.workspaceIdentity();
    const pairSessionId = `pair_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const pairPsk = randomPsk32();
    const expiresAtMs = now + PAIRING_TTL_MS;
    const pairConnToken = hosted === undefined ? undefined : signRelayToken(this.hostKeys.relayPriv, {
      role: "pair",
      machineId: this.hostKeys.machineId,
      aud: new URL(hosted.url).host.toLowerCase(),
      pairSessionId,
      nowSec: Math.floor(now / 1000),
      ttlSec: Math.floor(PAIRING_TTL_MS / 1000),
    });

    this.pairings.set(pairSessionId, {
      pairSessionId, accountName, binding, accountGeneration, pairPsk, expiresAtMs,
      status: "awaiting_scan", terminalAtMs: null, attachedKey: null, confirmCode: null, deviceName: null,
      phoneStaticPub: null, deviceRelayPub: null, handshakeHash: null, deviceId: null, pendingCreatedAtMs: null, error: null,
    });
    this.ensureSweep();

    return {
      ok: true,
      expiresAtMs,
      qr: {
        v: 2,
        paths,
        machineId: this.hostKeys.machineId,
        workspaceId: identity.id,
        macStaticPub: this.hostKeys.noiseStaticPub.toString("base64url"),
        pairSessionId,
        pairPsk: pairPsk.toString("base64url"),
        expiresAtMs,
        ...(pairConnToken === undefined ? {} : { pairConnToken }),
      },
    };
  }

  /** A pairing's state for the binding that started it (anyone else: null, as if it didn't exist). */
  pairingView(pairSessionId: string, binding: string): PairingView | null {
    const p = this.pairings.get(pairSessionId);
    if (p === undefined || p.binding !== binding) return null;
    this.expireIfDue(p);
    return {
      pairSessionId: p.pairSessionId,
      status: p.status,
      expiresAtMs: p.expiresAtMs,
      confirmCode: p.status === "awaiting_confirm" || p.status === "confirming" ? p.confirmCode : null,
      deviceName: p.deviceName,
      deviceId: p.deviceId,
      error: p.error,
    };
  }

  /** Step 5 of pairing: the owner confirms the code. Claimed synchronously before any await: a second confirm (a double
   * click, another tab) finds "confirming" and is refused. */
  async confirmPairing(pairSessionId: string, binding: string): Promise<{ ok: true; deviceId: string } | { ok: false; error: string }> {
    const p = this.pairings.get(pairSessionId);
    if (p === undefined || p.binding !== binding) return { ok: false, error: "Unknown pairing session." };
    this.expireIfDue(p);
    if (p.status !== "awaiting_confirm" || p.attachedKey === null || p.phoneStaticPub === null || p.deviceRelayPub === null || p.handshakeHash === null) {
      return { ok: false, error: p.status === "expired" ? "That pairing code expired. Pair again." : "That pairing can't be confirmed now. Pair again." };
    }
    // The phone that showed the code must still be the one attached.
    const attached = this.peers.get(p.attachedKey);
    if (attached === undefined || attached.state !== "pair_attached") {
      this.endPairing(p, "failed", "The iPhone disconnected. Pair again.");
      return { ok: false, error: "The iPhone disconnected. Pair again." };
    }
    const account = this.store.accountOf(p.accountName);
    if (account === null || account.revokedAt !== null || account.role !== "approver" || account.generation !== p.accountGeneration) {
      this.endPairing(p, "failed", "Your account changed while pairing. Pair again.");
      return { ok: false, error: "Your account changed while pairing. Pair again." };
    }
    const now = this.nowMs();
    if (phoneCount(this.store.handle, new Date(now)) >= MAX_PHONES_PER_MAC) {
      const error = `This Mac already has ${MAX_PHONES_PER_MAC} phones. Remove one first.`;
      this.endPairing(p, "failed", error);
      return { ok: false, error };
    }

    // confirming: the PSK has done its job (every socket that will prove it already holds its session keys).
    const identity = this.store.workspaceIdentity();
    const deviceId = `dev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const pskEntropy = randomPsk32();
    const devicePsk = deriveDevicePsk(pskEntropy, p.handshakeHash, identity.id, deviceId);
    p.status = "confirming";
    p.pairPsk.fill(0);
    p.deviceId = deviceId;
    p.pendingCreatedAtMs = now;
    savePendingDevice(this.store.handle, {
      deviceId,
      accountName: p.accountName,
      deviceName: p.deviceName ?? "iPhone",
      phoneStaticPub: p.phoneStaticPub,
      deviceRelayPub: p.deviceRelayPub,
      devicePsk,
      recoveryGeneration: identity.recoveryGeneration,
      accountGeneration: p.accountGeneration,
      createdAt: new Date(now).toISOString(),
    });

    let admissionError: string | null = null;
    try {
      await this.onDeviceRegistered?.(deviceId, p.deviceRelayPub.toString("base64url"));
    } catch (error) {
      admissionError = error instanceof Error ? error.message : String(error);
    }
    // Everything may have changed while the relays answered: the pairing (contested, cancelled, expired), the account,
    // the phone's socket, the row itself.
    const statusNow = (): PairingStatus => p.status; // read again: the awaits above may have moved it
    const after = this.store.accountOf(p.accountName);
    const row = getPairedDevice(this.store.handle, deviceId);
    const still = this.peers.get(attached.key);
    const holds = admissionError === null && statusNow() === "confirming" && this.nowMs() <= p.expiresAtMs
      && after !== null && after.revokedAt === null && after.role === "approver" && after.generation === p.accountGeneration
      && identity.recoveryGeneration === this.store.workspaceIdentity().recoveryGeneration
      && still === attached && still.state === "pair_attached" && row !== null && row.activatedAt === null && row.revokedAt === null;
    if (!holds) {
      deletePendingDevice(this.store.handle, deviceId);
      this.forgetOnRelays(deviceId);
      const error = admissionError !== null ? "The relay didn't accept the phone. Check phone access in Settings and pair again."
        : statusNow() === "contested" ? "Another device used this code. Pair again."
          : statusNow() === "cancelled" ? "Pairing was cancelled."
            : statusNow() === "expired" || this.nowMs() > p.expiresAtMs ? "That pairing code expired. Pair again."
              : "Pairing was interrupted. Pair again.";
      if (statusNow() === "confirming") this.endPairing(p, this.nowMs() > p.expiresAtMs ? "expired" : "failed", error);
      return { ok: false, error };
    }

    // The linearization point: from here the phone holds the keys.
    p.status = "finishing";
    attached.state = "pair_finishing";
    this.sendControl(attached, {
      type: FrameType.RES, streamId: PAIR_READY_STREAM, seq: 0,
      payload: Buffer.from(JSON.stringify({ ok: true, result: { deviceId, recoveryGeneration: identity.recoveryGeneration, pskEntropy: pskEntropy.toString("base64url") } }), "utf8"),
    });
    pskEntropy.fill(0);
    return { ok: true, deviceId };
  }

  /** Cancel from the Mac (the owner's Cancel, or codes that didn't match): only the binding that started it, and only
   * before the phone was given its keys. */
  cancelPairing(pairSessionId: string, binding: string): boolean {
    const p = this.pairings.get(pairSessionId);
    if (p === undefined || p.binding !== binding) return false;
    this.expireIfDue(p);
    if (TERMINAL.has(p.status) || p.status === "finishing") return false;
    this.endPairing(p, "cancelled");
    return true;
  }

  /** Ends a pairing that hasn't reached `finishing`: the attached phone (and any other socket on it) is told why and
   * closed. A pending row is not touched here: a confirm awaiting the relays sees the status and undoes it. */
  private endPairing(p: Pairing, status: "cancelled" | "expired" | "contested" | "failed", error: string | null = null): void {
    p.status = status;
    p.terminalAtMs = this.nowMs();
    p.error = error;
    p.pairPsk.fill(0);
    const code = errorCodeOf(status);
    for (const peer of [...this.peers.values()]) {
      if (peer.role !== "pair" || peer.peerId !== p.pairSessionId) continue;
      if (peer.state === "pair_attached" || peer.state === "pair_awaiting_ready") this.sendPairingError(peer, PAIR_READY_STREAM, code);
      this.dropPeer(peer, code, CLOSE_NORMAL);
    }
    p.attachedKey = null;
    p.handshakeHash = null;
  }

  /** Expiry, read lazily (every view, confirm and sweep): a code past its time before `finishing` expires; a finishing
   * pairing whose phone never acknowledged within 10 minutes fails (its row is deleted and relays told). */
  private expireIfDue(p: Pairing): void {
    const now = this.nowMs();
    if (TERMINAL.has(p.status)) return;
    if (p.status === "finishing") {
      if (p.pendingCreatedAtMs !== null && now > p.pendingCreatedAtMs + PENDING_ACTIVATION_MS) {
        if (p.deviceId !== null && deletePendingDevice(this.store.handle, p.deviceId)) this.forgetOnRelays(p.deviceId);
        p.status = "failed";
        p.terminalAtMs = now;
        p.error = "The iPhone didn't finish pairing. Pair again.";
      }
      return;
    }
    if (p.status !== "confirming" && now > p.expiresAtMs) this.endPairing(p, "expired");
  }

  /** The paired devices the relay should admit right now: live, this recovery generation, and pending ones too. */
  admittedDevices(): { deviceId: string; deviceRelayPub: string }[] {
    return livePairedDevices(this.store, { includePending: true, now: new Date(this.nowMs()) })
      .map(d => ({ deviceId: d.deviceId, deviceRelayPub: d.deviceRelayPub.toString("base64url") }));
  }

  /** Retires a paired phone now (synchronously, in SQLite): its live sessions get a stream-0 ERROR and close 4403, and
   * the relays are told in the background. False when it wasn't live. */
  revokeDevice(deviceId: string, reason: RetiredReason = "removed"): boolean {
    const revoked = revokePairedDeviceRecord(this.store.handle, deviceId, new Date(this.nowMs()), reason);
    for (const peer of [...this.peers.values()]) {
      if (peer.role === "device" && peer.peerId === deviceId) {
        if (peer.state === "authenticated" || peer.state === "awaiting_hello") this.refuseLive(peer, standingCodeOf(reason));
        else this.dropPeer(peer, "device_revoked", CLOSE_REVOKED);
      }
    }
    if (revoked) this.forgetOnRelays(deviceId);
    return revoked;
  }

  /** The periodic record sweep (service start and hourly): 30-day tombstones and unacknowledged pending rows go; the
   * relays forget the pending ones. */
  sweepRecords(): { tombstones: number; pending: string[] } {
    const swept = sweepCompanionRecords(this.store.handle, new Date(this.nowMs()));
    for (const deviceId of swept.pending) this.forgetOnRelays(deviceId);
    return swept;
  }

  private forgetOnRelays(deviceId: string): void {
    if (this.onDeviceRevoked === undefined) return;
    void Promise.resolve().then(() => this.onDeviceRevoked!(deviceId)).catch(() => { /* the callee owes a reconcile */ });
  }

  /** A link went away (the relay socket, a direct socket) — or, with no link, all of them (stopping): every phone
   * session and attached pairing riding it is gone too. A pairing nobody has scanned yet survives a link. */
  handleRelayDisconnected(link?: PeerLink): void {
    for (const peer of [...this.peers.values()]) {
      if (link !== undefined && peer.link !== link) continue;
      this.cleanupPeerLocal(peer);
    }
    if (link !== undefined) return;
    for (const p of this.pairings.values()) {
      if (!TERMINAL.has(p.status) && p.status !== "finishing") this.endPairing(p, "failed", "Phone access restarted. Pair again.");
    }
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  // ---- Links -------------------------------------------------------------------------------------------------------

  /** Handle an inbound binary envelope from a relay link (the default one-relay link when none is given). */
  async handleRelayEnvelope(raw: Buffer, link: PeerLink | null = this.defaultLink): Promise<void> {
    if (link === null) throw new Error("no relay link");
    const env = decodeRelayEnvelope(raw);
    if (env.op === RelayOp.PEER_OPEN) {
      let meta: { role?: unknown; id?: unknown };
      try { meta = JSON.parse(env.payload.toString("utf8")) as typeof meta; } catch { meta = {}; }
      // The relay names who connected; it is checked like any input (a buggy or hostile relay gets a refusal).
      if ((meta.role !== "pair" && meta.role !== "device") || typeof meta.id !== "string" || !PEER_ID.test(meta.id)) {
        link.close(env.connId, "invalid_peer");
        return;
      }
      this.openPeer(link, env.connId, meta.role, meta.id);
      return;
    }
    if (env.op === RelayOp.PEER_CLOSE) {
      this.closePeer(link, env.connId);
      return;
    }
    if (env.op === RelayOp.PEER_DATA) {
      await this.peerData(link, env.connId, env.payload);
    }
  }

  /** A phone opened a connection on a link, as `role` for `peerId` (a pairing session id or a device id). */
  openPeer(link: PeerLink, connId: number, role: "pair" | "device", peerId: string): void {
    const key = peerKeyOf(link, connId);
    const existing = this.peers.get(key);
    // The link already replaced that connection (a reused connId): forget it locally, never close the new one.
    if (existing !== undefined) this.cleanupPeerLocal(existing);
    const reject = (reason: string) => link.close(connId, reason);
    if (!PEER_ID.test(peerId)) { reject("invalid_peer"); return; }
    if (link.maxPeers !== undefined && [...this.peers.values()].filter(peer => peer.link === link).length >= link.maxPeers) {
      reject("too_many_peers");
      return;
    }
    if (role === "pair") {
      const pairing = this.pairings.get(peerId);
      if (pairing !== undefined) this.expireIfDue(pairing);
      // Only a pairing still open to message 1: a late socket on a finished (or failed) one is refused without touching
      // it. An open socket never changes a pairing's state (only a socket that proves the PSK can).
      if (pairing === undefined || (pairing.status !== "awaiting_scan" && pairing.status !== "awaiting_ready" && pairing.status !== "awaiting_confirm")) {
        reject("invalid_pairing");
        return;
      }
    }
    // Sockets that named this id but haven't sent message 1: anyone who saw the id can open them. A newcomer evicts the
    // oldest of those rather than being refused, so strangers can't lock the phone out — and never a socket already
    // past message 1, so a stranger can't evict the phone's own handshake.
    const unproven = [...this.peers.values()].filter(peer => peer.role === role && peer.peerId === peerId && peer.state === "awaiting_msg1");
    for (const stale of unproven.slice(0, Math.max(0, unproven.length - MAX_UNPROVEN_PER_PEER_ID + 1))) this.dropPeer(stale, "superseded_handshake");

    const now = this.nowMs();
    const peer: ActivePeerConn = {
      key, link, connId, role, peerId,
      state: "awaiting_msg1",
      openedAtMs: now,
      timer: null,
      session: null,
      principal: null,
      pairProof: null,
      streamGuard: new CompanionStreamGuard(this.globalBudget),
      unaryPacers: new Map(),
      watchStreams: new Map(),
      streamAccess: new Map(),
      bucket: link.pacing === undefined ? null : new TokenBucket(this.pacingPerConnection.ratePerMin, this.pacingPerConnection.burst, now),
      waiting: [],
      draining: false,
      pacingTimer: null,
      cache: { standingAt: -Infinity, standing: null },
    };
    this.peers.set(key, peer);
    this.armTimer(peer, this.handshakeDeadlineMs, "handshake_timeout");
    this.ensureSweep();
  }

  /** The phone's side of a link closed that connection. */
  closePeer(link: PeerLink, connId: number): void {
    const peer = this.peers.get(peerKeyOf(link, connId));
    if (peer !== undefined) this.cleanupPeerLocal(peer);
  }

  /** One binary message from a phone on a link. */
  async peerData(link: PeerLink, connId: number, data: Buffer): Promise<void> {
    const peer = this.peers.get(peerKeyOf(link, connId));
    if (peer === undefined) return;

    if (peer.state === "awaiting_msg1") {
      if (peer.role === "pair") this.handlePairingMsg1(peer, data);
      else this.handleSessionMsg1(peer, data);
      return;
    }
    // A refused phone gets nothing more than an unanswered hello would: its first transport message ends it the way the
    // hello deadline would have.
    if (peer.state === "refusing") {
      this.dropPeer(peer, "hello_timeout", CLOSE_TIMEOUT);
      return;
    }
    if (peer.session === null) {
      this.dropPeer(peer, "no_session");
      return;
    }
    if (peer.role === "device" && this.needsRekey(peer.session)) {
      this.endForRekey(peer);
      return;
    }

    let plaintext: Buffer;
    try {
      plaintext = peer.session.decrypt(data, this.nowMs());
    } catch {
      this.dropPeer(peer, "decrypt_failed");
      return;
    }
    let frame: CompanionFrame;
    try {
      frame = decodeFrame(plaintext);
    } catch {
      this.dropPeer(peer, "invalid_frame");
      return;
    }
    if (peer.role === "pair") this.handlePairingFrame(peer, frame);
    else await this.handleSessionFrame(peer, frame);
  }

  private armTimer(peer: ActivePeerConn, ms: number, reason: string): void {
    if (peer.timer !== null) clearTimeout(peer.timer);
    peer.timer = setTimeout(() => {
      peer.timer = null;
      if (this.peers.get(peer.key) === peer) this.dropPeer(peer, reason, CLOSE_TIMEOUT);
    }, ms);
    peer.timer.unref?.();
  }

  private clearTimer(peer: ActivePeerConn): void {
    if (peer.timer !== null) clearTimeout(peer.timer);
    peer.timer = null;
  }

  /** The 32-byte ephemeral of a message 1, if it is long enough to carry one and hasn't been seen (§2.4). */
  private freshEphemeral(peer: ActivePeerConn, msg1: Buffer): Buffer | null {
    if (msg1.length < 32) return null;
    const ephemeral = Buffer.from(msg1.subarray(0, 32));
    return this.replay.seen(peer.peerId, ephemeral, this.nowMs()) ? null : ephemeral;
  }

  // ---- Pairing: the phone's side -----------------------------------------------------------------------------------

  private handlePairingMsg1(peer: ActivePeerConn, msg1: Buffer): void {
    const pairing = this.pairings.get(peer.peerId);
    if (pairing !== undefined) this.expireIfDue(pairing);
    if (pairing === undefined || (pairing.status !== "awaiting_scan" && pairing.status !== "awaiting_ready" && pairing.status !== "awaiting_confirm")) {
      this.dropPeer(peer, "pairing_invalid");
      return;
    }
    const ephemeral = this.freshEphemeral(peer, msg1);
    if (ephemeral === null) { this.dropPeer(peer, "handshake_failed"); return; }
    const identity = this.store.workspaceIdentity();
    const responder = new NoiseIKpsk2Responder({
      localStatic: { privateKey: this.hostKeys.noiseStaticPriv, publicKey: this.hostKeys.noiseStaticPub },
      psk: pairing.pairPsk,
      prologue: buildPairingPrologue(identity.id, pairing.pairSessionId),
    });
    let payload: Buffer;
    let remoteStaticPublicKey: Buffer;
    try {
      ({ payload, remoteStaticPublicKey } = responder.readMessage1(msg1));
    } catch {
      this.dropPeer(peer, "handshake_failed");
      return;
    }
    this.replay.remember(peer.peerId, ephemeral, this.nowMs());
    // Message 1 NEVER executes RPCs or changes the pairing: anyone who knows the Mac's key can write one.
    let meta: { protocolVersion?: unknown; mode?: unknown; deviceRelayPub?: unknown };
    try {
      meta = JSON.parse(payload.toString("utf8")) as typeof meta;
    } catch {
      this.dropPeer(peer, "invalid_msg1_payload");
      return;
    }
    if (meta === null || typeof meta !== "object" || meta.protocolVersion !== 1 || meta.mode !== "pair" || typeof meta.deviceRelayPub !== "string") {
      this.dropPeer(peer, "invalid_msg1_payload");
      return;
    }
    const deviceRelayPub = Buffer.from(meta.deviceRelayPub, "base64url");
    if (deviceRelayPub.length !== 32) {
      this.dropPeer(peer, "invalid_device_relay_pub");
      return;
    }
    const { message: msg2, session } = responder.writeMessage2(paddedMsg2({ protocolVersion: 1, status: "awaiting_ready" }), this.nowMs());
    peer.session = session;
    peer.state = "pair_awaiting_ready";
    peer.pairProof = { phoneStaticPub: remoteStaticPublicKey, deviceRelayPub, handshakeHash: Buffer.from(session.handshakeHash) };
    if (pairing.status === "awaiting_scan") pairing.status = "awaiting_ready";
    this.armTimer(peer, this.readyDeadlineMs, "pair_ready_timeout");
    peer.link.send(peer.connId, msg2);
  }

  private handlePairingFrame(peer: ActivePeerConn, frame: CompanionFrame): void {
    const pairing = this.pairings.get(peer.peerId);
    if (peer.state === "pair_awaiting_ready") {
      const req = frame.type === FrameType.REQ && frame.streamId === PAIR_READY_STREAM && frame.seq === 0 ? parseRequest(frame.payload) : null;
      if (req === null || req.method !== "pair.ready") { this.dropPeer(peer, "pair_ready_required"); return; }
      this.onPairReady(peer, pairing, req.params);
      return;
    }
    // Attached or finishing: keepalive (no device or standing checks: this socket is a pairing, not a session).
    if (frame.type === FrameType.PING) {
      if (frame.payload.length > MAX_PING_PAYLOAD_BYTES) { this.dropPeer(peer, "ping_too_large"); return; }
      this.sendControl(peer, { type: FrameType.PONG, streamId: 0, seq: frame.seq, payload: frame.payload });
      return;
    }
    if (frame.type === FrameType.PONG || frame.type === FrameType.CREDIT || frame.type === FrameType.ERROR || frame.type === FrameType.CANCEL) return;
    if (frame.type === FrameType.REQ && frame.streamId === PAIR_DONE_STREAM && frame.seq === 0) {
      const req = parseRequest(frame.payload);
      if (req !== null && req.method === "pair.done") { this.onPairDone(peer, pairing, req.params); return; }
    }
    this.dropPeer(peer, "protocol_error");
  }

  /** A socket proved the pairing PSK (its `pair.ready` decrypted). The first one becomes the attached phone; a second
   * one, while a phone is attached, contests the pairing. */
  private onPairReady(peer: ActivePeerConn, pairing: Pairing | undefined, params: Record<string, unknown>): void {
    if (pairing === undefined || peer.pairProof === null) { this.dropPeer(peer, "pairing_invalid"); return; }
    this.expireIfDue(pairing);
    switch (pairing.status) {
      case "awaiting_scan":
      case "awaiting_ready": {
        this.clearTimer(peer);
        peer.state = "pair_attached";
        pairing.status = "awaiting_confirm";
        pairing.attachedKey = peer.key;
        pairing.phoneStaticPub = peer.pairProof.phoneStaticPub;
        pairing.deviceRelayPub = peer.pairProof.deviceRelayPub;
        pairing.handshakeHash = peer.pairProof.handshakeHash;
        pairing.confirmCode = deriveConfirmationCode(peer.pairProof.handshakeHash);
        pairing.deviceName = sanitizeDeviceName(params["deviceName"]);
        // The phone waits (with keepalive PINGs) for the outcome: bounded by the pairing's expiry, not a per-socket timer.
        return;
      }
      case "awaiting_confirm":
      case "confirming": {
        // Two holders of the code: neither is told which one the owner saw. A confirm awaiting the relays sees this.
        this.sendPairingError(peer, PAIR_READY_STREAM, "pairing_contested");
        this.dropPeer(peer, "pairing_contested", CLOSE_NORMAL);
        this.endPairing(pairing, "contested", "Another device used this code. Pair again.");
        return;
      }
      case "finishing": {
        // The keys already went to the attached phone: its row is retired as contested (it gets a refusal), and this
        // socket is told.
        this.sendPairingError(peer, PAIR_READY_STREAM, "pairing_contested");
        this.dropPeer(peer, "pairing_contested", CLOSE_NORMAL);
        if (pairing.deviceId !== null && revokePairedDeviceRecord(this.store.handle, pairing.deviceId, new Date(this.nowMs()), "contested")) this.forgetOnRelays(pairing.deviceId);
        pairing.status = "contested";
        pairing.terminalAtMs = this.nowMs();
        pairing.error = "Another device used this code. Pair again.";
        return;
      }
      default:
        this.sendPairingError(peer, PAIR_READY_STREAM, errorCodeOf(pairing.status));
        this.dropPeer(peer, errorCodeOf(pairing.status), CLOSE_NORMAL);
    }
  }

  /** The attached phone stored its keys: activate its pending row (atomically, §1.3) — only this pairing's own row. */
  private onPairDone(peer: ActivePeerConn, pairing: Pairing | undefined, params: Record<string, unknown>): void {
    const ok = () => {
      this.sendControl(peer, { type: FrameType.RES, streamId: PAIR_DONE_STREAM, seq: 0, payload: Buffer.from(JSON.stringify({ ok: true, result: { ok: true } }), "utf8") });
      this.dropPeer(peer, "paired", CLOSE_NORMAL);
    };
    if (pairing === undefined || pairing.attachedKey !== peer.key) {
      this.sendPairingError(peer, PAIR_DONE_STREAM, "pairing_failed");
      this.dropPeer(peer, "pairing_failed", CLOSE_NORMAL);
      return;
    }
    const deviceId = params["deviceId"];
    if (pairing.status === "paired" && deviceId === pairing.deviceId) { ok(); return; }
    if (pairing.status !== "finishing") {
      this.sendPairingError(peer, PAIR_DONE_STREAM, errorCodeOf(pairing.status));
      this.dropPeer(peer, errorCodeOf(pairing.status), CLOSE_NORMAL);
      return;
    }
    // Only the pairing's own row: a phone (or a bug) naming another pending device activates nothing.
    if (typeof deviceId !== "string" || deviceId !== pairing.deviceId) {
      this.sendPairingError(peer, PAIR_DONE_STREAM, "pairing_failed");
      return;
    }
    const activated = activatePendingDevice(this.store, deviceId, new Date(this.nowMs()));
    if (activated === "refused") {
      if (deletePendingDevice(this.store.handle, deviceId)) this.forgetOnRelays(deviceId);
      pairing.status = "failed";
      pairing.terminalAtMs = this.nowMs();
      pairing.error = "Pairing didn't finish. Pair again.";
      this.sendPairingError(peer, PAIR_DONE_STREAM, "pairing_failed");
      this.dropPeer(peer, "pairing_failed", CLOSE_NORMAL);
      return;
    }
    pairing.status = "paired";
    pairing.terminalAtMs = this.nowMs();
    ok();
  }

  private sendPairingError(peer: ActivePeerConn, streamId: number, code: PairingErrorCode): void {
    this.sendControl(peer, { type: FrameType.ERROR, streamId, seq: 0, payload: encodeErrorPayload(code, PAIRING_ERROR_MESSAGE[code]) });
  }

  // ---- Sessions ----------------------------------------------------------------------------------------------------

  private handleSessionMsg1(peer: ActivePeerConn, msg1: Buffer): void {
    const identity = this.store.workspaceIdentity();
    const dev = getPairedDevice(this.store.handle, peer.peerId);
    // Unknown, from another restore generation, or pending past its window: dropped without an answer (§2.6).
    if (dev === null || dev.recoveryGeneration !== identity.recoveryGeneration
      || (dev.activatedAt === null && dev.revokedAt === null && Date.parse(dev.createdAt) <= this.nowMs() - PENDING_ACTIVATION_MS)) {
      this.dropPeer(peer, "device_invalid_or_restored");
      return;
    }
    const ephemeral = this.freshEphemeral(peer, msg1);
    if (ephemeral === null) { this.dropPeer(peer, "handshake_failed"); return; }
    const responder = new NoiseIKpsk2Responder({
      localStatic: { privateKey: this.hostKeys.noiseStaticPriv, publicKey: this.hostKeys.noiseStaticPub },
      psk: dev.devicePsk,
      prologue: buildSessionPrologue(identity.id, dev.deviceId, identity.recoveryGeneration),
    });
    let payload: Buffer;
    let remoteStaticPublicKey: Buffer;
    try {
      ({ payload, remoteStaticPublicKey } = responder.readMessage1(msg1));
    } catch {
      this.dropPeer(peer, "handshake_failed");
      return;
    }
    if (remoteStaticPublicKey.length !== dev.phoneStaticPub.length || !timingSafeEqual(remoteStaticPublicKey, dev.phoneStaticPub)) {
      this.dropPeer(peer, "static_key_mismatch");
      return;
    }
    // Only this phone (its static key's `ss`) makes a message 1 that gets here: remembering its ephemeral stops a replay.
    this.replay.remember(peer.peerId, ephemeral, this.nowMs());
    // Message 1 carries metadata only — never executes RPCs.
    let meta: { protocolVersion?: unknown; mode?: unknown; deviceId?: unknown };
    try {
      meta = JSON.parse(payload.toString("utf8")) as typeof meta;
    } catch {
      this.dropPeer(peer, "invalid_msg1_payload");
      return;
    }
    if (meta === null || typeof meta !== "object" || meta.protocolVersion !== 1 || meta.mode !== "session" || meta.deviceId !== dev.deviceId) {
      this.dropPeer(peer, "invalid_msg1_payload");
      return;
    }

    const refusal = this.refusalOf(dev);
    const { message: msg2, session } = responder.writeMessage2(
      paddedMsg2(refusal === null ? { protocolVersion: 1, status: "awaiting_hello" } : { protocolVersion: 1, status: "refused", reason: refusal }),
      this.nowMs(),
    );
    if (refusal === null) {
      peer.session = session;
      peer.state = "awaiting_hello";
      peer.principal = {
        kind: "paired-device",
        deviceId: dev.deviceId,
        accountName: dev.accountName,
        workspaceId: identity.id,
        recoveryGeneration: identity.recoveryGeneration,
        requestFromThisComputer: false,
      };
    } else {
      // Authenticated refusal (§2.1): the phone can read why; on the wire it is the same size, and what follows is what
      // an unanswered hello gets.
      session.close();
      peer.state = "refusing";
    }
    this.armTimer(peer, this.helloDeadlineMs, "hello_timeout");
    peer.link.send(peer.connId, msg2);
  }

  /** Why a known phone (with keys) is refused, or null when it may open a session. */
  private refusalOf(dev: PairedDeviceRow): StandingCode | null {
    if (dev.revokedAt !== null) return standingCodeOf(dev.revokedReason ?? "removed");
    if (!deviceAccountStands(dev, this.store.accountOf(dev.accountName))) return "account_revoked";
    return null;
  }

  /** A live session's standing, re-read at most every 250 ms: null while it stands, else the stream-0 ERROR code. */
  private standingOf(peer: ActivePeerConn, fresh = false): StandingCode | null {
    const now = this.nowMs();
    if (!fresh && now - peer.cache.standingAt < STANDING_CACHE_MS) return peer.cache.standing;
    const principal = peer.principal;
    let code: StandingCode | null;
    if (principal === null) code = "device_revoked";
    else {
      const identity = this.store.workspaceIdentity();
      const dev = getPairedDevice(this.store.handle, principal.deviceId);
      if (dev === null || identity.id !== principal.workspaceId || identity.recoveryGeneration !== principal.recoveryGeneration || dev.recoveryGeneration !== identity.recoveryGeneration) code = "device_revoked";
      else if (dev.activatedAt === null && dev.revokedAt === null && Date.parse(dev.createdAt) <= now - PENDING_ACTIVATION_MS) code = "device_revoked";
      else code = this.refusalOf(dev);
    }
    peer.cache.standingAt = now;
    peer.cache.standing = code;
    return code;
  }

  /** A live session that lost standing: an encrypted stream-0 ERROR the phone trusts, then close 4403 (§2.2). */
  private refuseLive(peer: ActivePeerConn, code: StandingCode): void {
    const message = code === "account_revoked" ? "Your account on this Mac changed. Pair again." : "Your Mac removed this iPhone.";
    this.sendControl(peer, { type: FrameType.ERROR, streamId: 0, seq: 0, payload: encodeErrorPayload(code, message) });
    this.dropPeer(peer, code, CLOSE_REVOKED);
  }

  private needsRekey(session: NoiseTransportSession): boolean {
    return this.nowMs() - session.createdAtMs >= MAX_SESSION_AGE_MS - REKEY_MARGIN_MS
      || session.sendCipher.nonce >= MAX_SESSION_MESSAGES - REKEY_MARGIN_MESSAGES
      || session.recvCipher.nonce >= MAX_SESSION_MESSAGES - REKEY_MARGIN_MESSAGES;
  }

  /** The session reached its lifetime (24 h or 2^20 messages): stream-0 `rekey`, close 1000; the phone reconnects. */
  private endForRekey(peer: ActivePeerConn): void {
    this.emit(peer, { type: FrameType.ERROR, streamId: 0, seq: 0, payload: encodeErrorPayload("rekey", "Reconnecting for fresh keys.") });
    this.dropPeer(peer, "rekey", CLOSE_NORMAL);
  }

  /** The stream's read-time access still holds (no fingerprint taken: nothing to compare). */
  private accessHolds(peer: ActivePeerConn, streamId: number): boolean {
    const taken = peer.streamAccess.get(streamId);
    if (taken === undefined || this.handlers.accessSignature === undefined || peer.principal === null) return true;
    return this.handlers.accessSignature(peer.principal) === taken;
  }

  /** Ends a stream whose account can no longer see what it carries: nothing queued is sent. */
  private denyStream(peer: ActivePeerConn, streamId: number): void {
    this.dropStreamState(peer, streamId);
    this.sendControl(peer, { type: FrameType.ERROR, streamId, seq: 0, payload: encodeErrorPayload("not_found", "That's no longer available to you.") });
  }

  /** Everything a stream holds is let go (watch buffer and subscription, unary response, pacing place). */
  private dropStreamState(peer: ActivePeerConn, streamId: number): void {
    const watch = peer.watchStreams.get(streamId);
    if (watch !== undefined) { watch.unsubscribe(); watch.buffer.clear(); peer.watchStreams.delete(streamId); }
    peer.unaryPacers.delete(streamId);
    peer.streamAccess.delete(streamId);
    peer.waiting = peer.waiting.filter(id => id !== streamId);
    peer.streamGuard.closeStream(streamId);
  }

  private async handleSessionFrame(peer: ActivePeerConn, frame: CompanionFrame): Promise<void> {
    const standing = this.standingOf(peer);
    if (standing !== null) { this.refuseLive(peer, standing); return; }

    // Before hello only a keepalive and the hello itself (L2).
    if (peer.state === "awaiting_hello" && frame.type !== FrameType.PING && frame.type !== FrameType.REQ && frame.type !== FrameType.REQ_CHUNK && frame.type !== FrameType.END) {
      this.dropPeer(peer, "protocol_error");
      return;
    }
    if (frame.type === FrameType.PING) {
      if (frame.payload.length > MAX_PING_PAYLOAD_BYTES) { this.dropPeer(peer, "ping_too_large"); return; }
      this.sendControl(peer, { type: FrameType.PONG, streamId: 0, seq: frame.seq, payload: frame.payload });
      return;
    }
    if (frame.type === FrameType.PONG) return;

    // CANCEL stops watching ONLY — NEVER stops the underlying agent run. A phone's ERROR on a stream ends it the same way.
    if (frame.type === FrameType.CANCEL || frame.type === FrameType.ERROR) {
      this.dropStreamState(peer, frame.streamId);
      return;
    }

    if (frame.type === FrameType.CREDIT) {
      let grant: number;
      try {
        grant = decodeCreditPayload(frame.payload);
      } catch {
        this.dropPeer(peer, "invalid_credit");
        return;
      }
      const pacer = peer.unaryPacers.get(frame.streamId);
      if (pacer !== undefined) {
        pacer.grantCredit(grant);
        this.pumpUnaryPacer(peer, frame.streamId, pacer);
        return;
      }
      const watch = peer.watchStreams.get(frame.streamId);
      if (watch !== undefined) {
        watch.buffer.grantCredit(grant);
        watch.lastCreditAtMs = this.nowMs();
        this.pumpWatchStream(peer, frame.streamId, watch);
      }
      return;
    }

    const ingested = peer.streamGuard.ingestRequestFrame(frame, this.nowMs());
    if (!ingested.ok) {
      this.sendControl(peer, { type: FrameType.ERROR, streamId: frame.streamId, seq: 0, payload: encodeErrorPayload(ingested.code, ingested.message) });
      if (ingested.closeSession) this.dropPeer(peer, ingested.code);
      return;
    }
    if (ingested.completePayload === undefined) return; // still awaiting more REQ_CHUNK / END

    const req = parseRequest(ingested.completePayload);
    if (req === null) {
      this.sendRpcError(peer, frame.streamId, "invalid_json", "RPC payload must be valid JSON");
      return;
    }
    const { method, params } = req;

    // Key confirmation rule (spec §1.3): first transport RPC MUST be `device.hello`
    if (peer.state === "awaiting_hello") {
      if (method !== "device.hello") {
        this.sendRpcError(peer, frame.streamId, "hello_required", "First transport RPC must be device.hello");
        this.dropPeer(peer, "hello_required");
        return;
      }
      const principal = peer.principal!;
      // A pending phone's first hello activates it (its pair.done may have been lost), under the same conditions.
      const row = getPairedDevice(this.store.handle, principal.deviceId);
      if (row !== null && row.activatedAt === null) {
        if (activatePendingDevice(this.store, principal.deviceId, new Date(this.nowMs())) === "refused") { this.dropPeer(peer, "activation_refused"); return; }
        for (const p of this.pairings.values()) {
          if (p.deviceId === principal.deviceId && p.status === "finishing") { p.status = "paired"; p.terminalAtMs = this.nowMs(); }
        }
      }
      this.clearTimer(peer);
      peer.state = "authenticated";
      // One live session per phone: an older one (another path, a socket the phone gave up on) is closed.
      for (const other of [...this.peers.values()]) {
        if (other !== peer && other.state === "authenticated" && other.principal?.deviceId === principal.deviceId) this.dropPeer(other, "superseded");
      }
      touchPairedDeviceLastSeen(this.store.handle, principal.deviceId, new Date(this.nowMs()));
    }

    if (!PAIRED_DEVICE_GATE1_ROUTES.has(method)) {
      this.sendRpcError(peer, frame.streamId, "route_not_allowed", `Method '${method}' is not on the paired-device allowlist`);
      return;
    }

    await this.dispatchGate1Method(peer, frame.streamId, method, params);
  }

  private async dispatchGate1Method(peer: ActivePeerConn, streamId: number, method: string, params: Record<string, unknown>): Promise<void> {
    const principal = peer.principal!;
    // The account's access as the read begins: what it yields is delivered only while this still holds.
    if (this.handlers.accessSignature !== undefined) peer.streamAccess.set(streamId, this.handlers.accessSignature(principal));
    try {
      if (method === "device.self.revoke") {
        this.sendRpcResult(peer, streamId, { ok: true, revoked: true });
        this.revokeDevice(principal.deviceId, "removed");
        return;
      }
      if (method === "run.watch.subscribe") {
        if (this.handlers.runWatchSubscribe === undefined) {
          this.sendRpcError(peer, streamId, "unsupported", "Live watch not configured");
          return;
        }
        const promoted = peer.streamGuard.promoteToWatchStream(streamId);
        if (!promoted.ok) {
          this.sendRpcError(peer, streamId, promoted.code, promoted.message);
          return;
        }
        // Charged to this phone's budget (and the daemon's) while held: a record the budget can't take becomes a cut.
        const buffer = new LiveWatchBuffer({ reserve: bytes => peer.streamGuard.reserveWatch(bytes), release: bytes => peer.streamGuard.releaseWatch(bytes) });
        const watchEntry: WatchEntry = { buffer, unsubscribe: () => {}, seq: 0, ending: false, lastCreditAtMs: this.nowMs() };
        // Admitted before the handler runs, so records it emits (or an end) inside the call are delivered (L6).
        peer.watchStreams.set(streamId, watchEntry);
        let unsubscribed = false;
        const sub = this.handlers.runWatchSubscribe(principal, params, record => {
          if (peer.watchStreams.get(streamId) !== watchEntry) return; // stopped watching
          buffer.push(record);
          this.pumpWatchStream(peer, streamId, watchEntry);
        }, reason => {
          if (peer.watchStreams.get(streamId) !== watchEntry) return;
          if (reason === "denied") { this.denyStream(peer, streamId); return; }
          // Ended by the read side: everything buffered is delivered (as credit allows), then END.
          watchEntry.ending = true;
          this.pumpWatchStream(peer, streamId, watchEntry);
        });
        if (!sub.ok) {
          if (peer.watchStreams.get(streamId) === watchEntry) { buffer.clear(); peer.watchStreams.delete(streamId); }
          this.sendRpcError(peer, streamId, sub.code, sub.message);
          return;
        }
        if (peer.watchStreams.get(streamId) !== watchEntry) { unsubscribed = true; sub.unsubscribe(); }
        if (!unsubscribed) watchEntry.unsubscribe = sub.unsubscribe;
        return;
      }

      let result: unknown;
      switch (method) {
        case "device.hello": {
          const hello = await this.handlers.deviceHello(principal);
          // The phone keeps the freshest ways back to this Mac (a new Wi-Fi address, Tailscale on or off), and the
          // console's address for Handoff.
          const paths = this.pathsOf();
          result = hello !== null && typeof hello === "object"
            ? { ...hello, consoleUrl: this.consoleUrl(), ...(pathsAllowed(paths) ? { paths } : {}) }
            : hello;
          break;
        }
        case "work.rows":
          result = await this.handlers.workRows(principal, params);
          break;
        case "task.steps":
          result = await this.handlers.taskSteps(principal, params);
          break;
        case "task.diff":
          result = await this.handlers.taskDiff(principal, params);
          break;
        case "task.approval.read":
          result = await this.handlers.taskApprovalRead(principal, params);
          break;
        case "run.window.read":
          result = await this.handlers.runWindowRead(principal, params);
          break;
        default:
          this.sendRpcError(peer, streamId, "route_not_allowed", "Not allowed");
          return;
      }
      this.sendRpcResult(peer, streamId, result);
    } catch (err) {
      // A read's own refusal keeps its code (not_found, invalid_params, invalid_cursor, standing_revoked); anything
      // else is a server failure the phone shows as "Couldn't load", without the internal message.
      const raw = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
      const code = typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw) ? raw : "handler_error";
      const msg = code === "handler_error" ? "Something went wrong reading that on your Mac." : (err as Error).message;
      this.sendRpcError(peer, streamId, code, msg);
      if (code === "standing_revoked" && this.peers.get(peer.key) === peer) this.refuseLive(peer, this.standingOf(peer, true) ?? "account_revoked");
    }
  }

  private sendRpcResult(peer: ActivePeerConn, streamId: number, result: unknown): void {
    // The phone cancelled (or the stream was closed) while the read ran: nothing is sent or held for it.
    if (!peer.streamGuard.isOpen(streamId) || this.peers.get(peer.key) !== peer) return;
    const payload = Buffer.from(JSON.stringify({ ok: true, result }), "utf8");
    // Held until the phone has taken it all: charged to this phone's (1 MiB) and the daemon's (64 MiB) budgets.
    if (!peer.streamGuard.reserveResponse(streamId, payload.length)) {
      this.sendRpcError(peer, streamId, "memory_limit", "Too much is waiting for your phone to read. Try again in a moment.");
      return;
    }
    const pacer = new UnaryResponsePacer(streamId, payload, this.nowMs());
    peer.unaryPacers.set(streamId, pacer);
    this.pumpUnaryPacer(peer, streamId, pacer);
  }

  /** Sends what the phone's credit and pacing allow; true when pacing held the rest (the stream is queued for it). */
  private pumpUnaryPacer(peer: ActivePeerConn, streamId: number, pacer: UnaryResponsePacer): boolean {
    if (!this.accessHolds(peer, streamId)) { this.denyStream(peer, streamId); return false; }
    const gate = this.pacingGate(peer, streamId);
    const pulled = pacer.pullAvailable(this.nowMs(), gate.allow);
    if (!pulled.ok) {
      this.dropStreamState(peer, streamId);
      this.sendControl(peer, { type: FrameType.ERROR, streamId, seq: 0, payload: encodeErrorPayload(pulled.code, "Unary response exceeded 30s deadline") });
      return false;
    }
    for (const f of pulled.frames) this.emit(peer, f);
    if (pacer.done) {
      peer.unaryPacers.delete(streamId);
      peer.streamAccess.delete(streamId);
      peer.waiting = peer.waiting.filter(id => id !== streamId);
      peer.streamGuard.closeStream(streamId);
      return false;
    }
    if (!gate.held()) return false;
    this.holdForPacing(peer, streamId);
    return true;
  }

  private pumpWatchStream(peer: ActivePeerConn, streamId: number, watch: WatchEntry): boolean {
    if (!this.accessHolds(peer, streamId)) { this.denyStream(peer, streamId); return false; }
    const gate = this.pacingGate(peer, streamId);
    for (const rec of watch.buffer.drainAvailable(bytes => gate.allow(FRAME_HEADER_BYTES + bytes))) {
      this.emit(peer, { type: FrameType.CHUNK, streamId, seq: watch.seq++, payload: rec });
    }
    // An ended watch closes once everything it buffered has gone out.
    if (watch.ending && watch.buffer.length === 0 && watch.buffer.pendingCut === 0 && peer.watchStreams.get(streamId) === watch && gate.allow(FRAME_HEADER_BYTES)) {
      peer.watchStreams.delete(streamId);
      peer.streamAccess.delete(streamId);
      peer.waiting = peer.waiting.filter(id => id !== streamId);
      peer.streamGuard.closeStream(streamId);
      this.emit(peer, { type: FrameType.END, streamId, seq: watch.seq++, payload: Buffer.alloc(0) });
      return false;
    }
    if (!gate.held()) return false;
    this.holdForPacing(peer, streamId);
    return true;
  }

  /**
   * Downstream pacing (§3.7) for one pump of one stream: each data frame takes its plaintext size from the
   * connection's bucket and the hosted link's before it is encrypted. While streams wait, a stream that isn't being
   * served from the queue waits behind them (one ordered queue per connection). Direct links aren't paced.
   */
  private pacingGate(peer: ActivePeerConn, streamId: number): { allow: (bytes: number) => boolean; held: () => boolean } {
    let held = false;
    const allow = (bytes: number): boolean => {
      if (peer.bucket === null) return true;
      if (held) return false;
      const now = this.nowMs();
      const queuedAhead = peer.waiting.length > 0 && !(peer.draining && peer.waiting[0] === streamId);
      if (queuedAhead || peer.bucket.available(now) < bytes || (peer.link.pacing !== undefined && peer.link.pacing.available(now) < bytes)) {
        held = true;
        return false;
      }
      peer.bucket.take(bytes, now);
      peer.link.pacing?.take(bytes, now);
      return true;
    };
    return { allow, held: () => held };
  }

  private holdForPacing(peer: ActivePeerConn, streamId: number): void {
    if (!peer.waiting.includes(streamId)) peer.waiting.push(streamId);
    if (peer.pacingTimer !== null || peer.bucket === null) return;
    const now = this.nowMs();
    const frame = FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES;
    const wait = Math.max(1, peer.bucket.waitFor(frame, now), peer.link.pacing?.waitFor(frame, now) ?? 0);
    peer.pacingTimer = setTimeout(() => { peer.pacingTimer = null; this.drainPaced(peer); }, wait);
    peer.pacingTimer.unref?.();
  }

  /** Serves the streams pacing held, in order, until the buckets run dry again. A stream that stopped for want of the
   * phone's credit leaves the queue (its CREDIT pumps it again, behind whatever is queued then). */
  private drainPaced(peer: ActivePeerConn): void {
    while (peer.waiting.length > 0 && this.peers.get(peer.key) === peer) {
      const streamId = peer.waiting[0]!;
      const pacer = peer.unaryPacers.get(streamId);
      const watch = peer.watchStreams.get(streamId);
      let held = false;
      peer.draining = true;
      try {
        if (pacer !== undefined) held = this.pumpUnaryPacer(peer, streamId, pacer);
        else if (watch !== undefined) held = this.pumpWatchStream(peer, streamId, watch);
      } finally {
        peer.draining = false;
      }
      if (peer.waiting[0] !== streamId) continue; // it left the queue (finished, refused, ended)
      if (held) return; // the buckets are dry: holdForPacing armed the timer
      peer.waiting.shift();
    }
  }

  private sendRpcError(peer: ActivePeerConn, streamId: number, code: string, message: string): void {
    peer.streamAccess.delete(streamId);
    peer.waiting = peer.waiting.filter(id => id !== streamId);
    peer.streamGuard.closeStream(streamId);
    this.sendControl(peer, { type: FrameType.ERROR, streamId, seq: 0, payload: encodeErrorPayload(code, message) });
  }

  /** A control frame (PONG, ERROR, a pairing outcome): never paced, encrypted and sent now — after every frame already
   * encrypted, ahead of data frames pacing still holds (those aren't encrypted yet, so the order on the wire is the
   * encryption order). */
  private sendControl(peer: ActivePeerConn, frame: CompanionFrame): void {
    this.emit(peer, frame);
  }

  private emit(peer: ActivePeerConn, frame: CompanionFrame): void {
    if (peer.session === null || this.peers.get(peer.key) !== peer) return;
    // A phone that stops reading leaves what we send queued in memory: past the link's limit it is dropped, not fed.
    if (peer.link.backlog !== undefined && peer.link.backlogLimit !== undefined && peer.link.backlog() > peer.link.backlogLimit) {
      this.dropPeer(peer, "not_reading");
      return;
    }
    if (peer.role === "device" && peer.state === "authenticated" && this.needsRekey(peer.session) && !(frame.type === FrameType.ERROR && frame.streamId === 0)) {
      this.endForRekey(peer);
      return;
    }
    try {
      const ct = peer.session.encrypt(encodeFrame(frame), this.nowMs());
      peer.link.send(peer.connId, ct);
    } catch {
      this.dropPeer(peer, "encrypt_failed");
    }
  }

  /** Deadlines no inbound frame would trigger: a request half-sent past 5 s, a response the phone stopped taking past
   * 30 s, a watch whose buffered output the phone hasn't asked for in 60 s, a session that lost standing or reached
   * its lifetime, pairings that expired or finished a minute ago. */
  private ensureSweep(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweepDeadlines(), DEADLINE_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  /** One pass of the deadline sweep (the timer calls it every second; tests call it with an injected clock). */
  sweepDeadlines(): void {
    const now = this.nowMs();
    for (const p of [...this.pairings.values()]) {
      this.expireIfDue(p);
      if (p.terminalAtMs !== null && now - p.terminalAtMs > PAIRING_TERMINAL_KEEP_MS) {
        p.pairPsk.fill(0);
        this.pairings.delete(p.pairSessionId);
      }
    }
    if (this.peers.size === 0 && this.pairings.size === 0) {
      if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
      this.sweepTimer = null;
      return;
    }
    for (const peer of [...this.peers.values()]) {
      if (this.peers.get(peer.key) !== peer) continue;
      // A pairing socket outlives its pairing only until it ends (or, attached and finishing, until the row's window).
      if (peer.role === "pair") {
        const pairing = this.pairings.get(peer.peerId);
        if (pairing === undefined || (TERMINAL.has(pairing.status) && pairing.status !== "paired") || (pairing.status === "paired" && peer.state !== "pair_finishing")) this.dropPeer(peer, "pairing_over");
        continue;
      }
      if (peer.state !== "authenticated" || peer.session === null) continue;
      const standing = this.standingOf(peer, true);
      if (standing !== null) { this.refuseLive(peer, standing); continue; }
      if (this.needsRekey(peer.session)) { this.endForRekey(peer); continue; }
      for (const streamId of peer.streamGuard.expireAssemblies(now)) {
        this.sendRpcError(peer, streamId, "deadline_exceeded", "The request didn't arrive in time.");
      }
      for (const [streamId, pacer] of [...peer.unaryPacers]) {
        if (pacer.isTimedOut(now)) this.pumpUnaryPacer(peer, streamId, pacer);
      }
      for (const [streamId, watch] of [...peer.watchStreams]) {
        if (watch.buffer.length > 0 && now - watch.lastCreditAtMs > WATCH_IDLE_DEADLINE_MS) {
          this.dropStreamState(peer, streamId);
          this.sendControl(peer, { type: FrameType.ERROR, streamId, seq: 0, payload: encodeErrorPayload("idle_timeout", "Stopped watching: your phone stopped reading.") });
        }
      }
    }
  }

  private dropPeer(peer: ActivePeerConn, reason: string, code?: number): void {
    if (this.peers.get(peer.key) !== peer) return; // already gone (a late callback for a replaced peer)
    this.cleanupPeerLocal(peer);
    peer.link.close(peer.connId, reason, code);
  }

  private cleanupPeerLocal(peer: ActivePeerConn): void {
    if (this.peers.get(peer.key) !== peer) return;
    this.clearTimer(peer);
    if (peer.pacingTimer !== null) clearTimeout(peer.pacingTimer);
    peer.pacingTimer = null;
    for (const w of peer.watchStreams.values()) { w.unsubscribe(); w.buffer.clear(); }
    peer.watchStreams.clear();
    peer.unaryPacers.clear();
    peer.waiting = [];
    peer.streamGuard.releaseAll();
    peer.session?.close();
    peer.session = null;
    peer.pairProof = null;
    this.peers.delete(peer.key);
    // The attached phone left before it was given its keys: the pairing can't be confirmed any more.
    for (const p of this.pairings.values()) {
      if (p.attachedKey !== peer.key) continue;
      if (p.status === "awaiting_confirm") {
        if (this.nowMs() > p.expiresAtMs) this.endPairing(p, "expired");
        else this.endPairing(p, "failed", "The iPhone disconnected. Pair again.");
      }
      // confirming: the confirm's recheck sees the socket gone. finishing: the phone may already hold its keys and
      // activates by hello.
      if (p.attachedKey === peer.key) p.attachedKey = null;
    }
  }
}

/** A retired phone's reason as the refusal it is given: an account-level change is `account_revoked`. */
function standingCodeOf(reason: RetiredReason): StandingCode {
  return reason === "password_changed" || reason === "access_changed" ? "account_revoked" : "device_revoked";
}

function parseRequest(payload: Buffer): { method: string; params: Record<string, unknown> } | null {
  let req: { method?: unknown; params?: unknown };
  try {
    req = JSON.parse(payload.toString("utf8")) as typeof req;
  } catch {
    return null;
  }
  if (req === null || typeof req !== "object") return null;
  const method = typeof req.method === "string" ? req.method : "";
  const params = req.params !== null && typeof req.params === "object" && !Array.isArray(req.params) ? req.params as Record<string, unknown> : {};
  return { method, params };
}
