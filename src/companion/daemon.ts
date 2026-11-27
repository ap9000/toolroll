/**
 * Gate 1 Companion Daemon Engine — Pairing Ceremony, Noise IKpsk2 Session Manager,
 * PairedDevicePrincipal (NEVER loopback / requestFromThisComputer === false),
 * and Explicit Read-Only RPC Allowlist (`docs/plans/companion-app/threat-model-and-routes.md`).
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Store } from "../store.js";
import { pathsAllowed, type CompanionPath } from "./paths.js";
import {
  buildPairingPrologue,
  buildSessionPrologue,
  deriveConfirmationCode,
  deriveDevicePsk,
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
  FrameType,
  GlobalBufferBudget,
  LiveWatchBuffer,
  UnaryResponsePacer,
  type CompanionFrame,
} from "./framing.js";
import {
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  RelayOp,
  signRelayToken,
} from "./relay-auth.js";
import {
  deviceAccountStands,
  getPairedDevice,
  listPairedDevices,
  loadOrCreateCompanionHostKeys,
  revokePairedDeviceRecord,
  sanitizeDeviceName,
  savePairedDevice,
  savePushSubscription,
  sweepCompanionIdempotencyOnStartup,
  touchPairedDeviceLastSeen,
  type CompanionHostKeys,
} from "./store.js";

export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const DAEMON_HANDSHAKE_DEADLINE_MS = 5_000;

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
  "push.register",
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
  /** Subscribe to live run deltas; returned `unsubscribe` stops watching ONLY (never stops the run). */
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
  /** 5-min Ed25519 role=pair token for the hosted relay — present only when there is a hosted path. */
  pairConnToken?: string;
}

export interface PendingPairingState {
  pairSessionId: string;
  accountName: string;
  pairPsk: Buffer;
  expiresAtMs: number;
  status: "awaiting_scan" | "awaiting_confirm" | "confirming" | "confirmed" | "aborted_race" | "aborted_rejected" | "expired" | "failed";
  /** Who may see, confirm and cancel this pairing: the console's binding of the person and the very session that
   * started it (opaque to the engine). A different session — even the same account's — gets "unknown pairing". */
  binding: string;
  /** The account's credential generation that authorized the pairing: it must still hold when the phone is saved. */
  accountGeneration: number | null;
  /** The attached phone's peer key (link + connId), once a phone opened this pairing. */
  peerKey: string | null;
  confirmCode: string | null;
  deviceName: string | null;
  phoneStaticPub: Buffer | null;
  deviceRelayPub: Buffer | null;
  session: NoiseTransportSession | null;
}

/** A way phones reach the engine: the hosted relay's socket (many phones, one connId each) or one direct socket
 * (connId 1). A peer is identified by its link AND its connId — two links can both carry a connId 1. */
export interface PeerLink {
  readonly id: string;
  send(connId: number, payload: Buffer): void;
  close(connId: number, reason: string): void;
}

/** A relay socket as a link: frames ride PEER_DATA envelopes, a drop is a PEER_CLOSE. */
export function relayEnvelopeLink(id: string, sendEnvelope: (envelope: Buffer) => void): PeerLink {
  return {
    id,
    send: (connId, payload) => sendEnvelope(encodeRelayEnvelope({ op: RelayOp.PEER_DATA, connId, payload })),
    close: (connId, reason) => sendEnvelope(encodeRelayEnvelope({ op: RelayOp.PEER_CLOSE, connId, payload: Buffer.from(JSON.stringify({ reason }), "utf8") })),
  };
}

const peerKeyOf = (link: PeerLink, connId: number): string => `${link.id}:${connId}`;

/** Unproven sockets (no completed hello yet) one device id may hold at once, across every link; a newer one evicts the oldest. */
const MAX_PENDING_PER_PEER_ID = 2;

interface ActivePeerConn {
  key: string;
  link: PeerLink;
  connId: number;
  role: "pair" | "device";
  peerId: string;
  state: "awaiting_msg1" | "awaiting_hello" | "pair_pending_confirm" | "authenticated";
  handshakeTimer: ReturnType<typeof setTimeout>;
  session: NoiseTransportSession | null;
  principal: PairedDevicePrincipal | null;
  streamGuard: CompanionStreamGuard;
  unaryPacers: Map<number, UnaryResponsePacer>;
  watchStreams: Map<number, WatchEntry>;
  /** Each open stream's access fingerprint when its read began (accessSignature). */
  streamAccess: Map<number, string>;
}

interface WatchEntry { buffer: LiveWatchBuffer; unsubscribe: () => void; seq: number; ending: boolean }

export interface CompanionDaemonOptions {
  store: Store;
  handlers: CompanionReadHandlers;
  relayUrl?: string;
  /** The single relay link of a one-relay setup (tests, the reference relay). Links are otherwise passed per call. */
  sendToRelay?: (envelope: Buffer) => void;
  /** The phone's pairing link: called when a pairing is confirmed through a relay link, so that relay admits the
   * device before the phone is told. Not called for a pairing confirmed over a direct link. */
  onDeviceRegistered?: (deviceId: string, deviceRelayPubB64: string, via: PeerLink) => Promise<void> | void;
  onDeviceRevoked?: (deviceId: string) => Promise<void> | void;
  handshakeDeadlineMs?: number;
  nowMs?: () => number;
  /** The ways a phone can reach this Mac (setPathsProvider replaces it). */
  paths?: () => CompanionPath[];
}

export class CompanionDaemonEngine {
  readonly hostKeys: CompanionHostKeys;
  private readonly store: Store;
  private readonly handlers: CompanionReadHandlers;
  private readonly defaultLink: PeerLink | null;
  private readonly onDeviceRegistered: ((deviceId: string, deviceRelayPubB64: string, via: PeerLink) => Promise<void> | void) | undefined;
  private readonly onDeviceRevoked: ((deviceId: string) => Promise<void> | void) | undefined;
  private readonly handshakeDeadlineMs: number;
  private readonly nowMs: () => number;
  private readonly globalBudget = new GlobalBufferBudget();
  private readonly pairings = new Map<string, PendingPairingState>();
  private readonly peers = new Map<string, ActivePeerConn>();
  /** The ways a phone can reach this Mac right now (the QR's and every hello's `paths`), set by the service. */
  private pathsOf: () => CompanionPath[] = () => [];

  constructor(opts: CompanionDaemonOptions) {
    this.store = opts.store;
    this.handlers = opts.handlers;
    this.defaultLink = opts.sendToRelay === undefined ? null : relayEnvelopeLink("relay", opts.sendToRelay);
    this.onDeviceRegistered = opts.onDeviceRegistered;
    this.onDeviceRevoked = opts.onDeviceRevoked;
    this.handshakeDeadlineMs = opts.handshakeDeadlineMs ?? DAEMON_HANDSHAKE_DEADLINE_MS;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    if (opts.paths !== undefined) this.pathsOf = opts.paths;
    this.hostKeys = loadOrCreateCompanionHostKeys(this.store.handle, opts.relayUrl, new Date(this.nowMs()));
    sweepCompanionIdempotencyOnStartup(this.store.handle, new Date(this.nowMs()));
  }


  setPathsProvider(provider: () => CompanionPath[]): void {
    this.pathsOf = provider;
  }

  /** Step 1 of pairing: initiated ONLY by a signed-in approver account on the Mac. `binding` names the person and
   * the session that started it; status, confirmation and cancellation answer only to the same binding. */
  startPairing(accountName: string, binding: string = accountName, accountGeneration: number | null = null): { ok: true; qr: PairingQrPayload; expiresAtMs: number } | { ok: false; error: string } {
    const account = this.store.accountOf(accountName);
    if (account === null || account.revokedAt !== null || account.role !== "approver" || (accountGeneration !== null && account.generation !== accountGeneration)) {
      return { ok: false, error: "Only an active approver account can start pairing." };
    }
    // One pairing at a time per binding: a new QR retires the previous one (its phone, if any, is dropped).
    for (const [id, p] of [...this.pairings]) {
      if (p.binding === binding) {
        this.abortPairing(id, "aborted_rejected");
        this.pairings.delete(id);
      } else if (this.nowMs() > p.expiresAtMs || p.status === "confirmed" || p.status === "failed" || p.status.startsWith("aborted")) {
        this.abortPairing(id, "aborted_rejected");
        this.pairings.delete(id);
      }
    }
    const paths = this.pathsOf();
    if (!pathsAllowed(paths)) return { ok: false, error: "A phone has no way to reach this Mac yet: join a Wi-Fi network or turn on Connect from anywhere." };
    const hosted = paths.some(path => path.kind === "hosted");
    const identity = this.store.workspaceIdentity();
    const pairSessionId = `pair_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const pairPsk = randomPsk32();
    const now = this.nowMs();
    const expiresAtMs = now + PAIRING_TTL_MS;
    const pairConnToken = !hosted ? undefined : signRelayToken(this.hostKeys.relayPriv, {
      role: "pair",
      machineId: this.hostKeys.machineId,
      pairSessionId,
      nowSec: Math.floor(now / 1000),
      ttlSec: Math.floor(PAIRING_TTL_MS / 1000),
    });

    this.pairings.set(pairSessionId, {
      pairSessionId,
      accountName,
      pairPsk,
      expiresAtMs,
      status: "awaiting_scan",
      binding,
      accountGeneration,
      peerKey: null,
      confirmCode: null,
      deviceName: null,
      phoneStaticPub: null,
      deviceRelayPub: null,
      session: null,
    });

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
        ...(pairConnToken === undefined ? {} : { pairConnToken }),
      },
    };
  }

  /** A pairing's state, for the binding that started it only (anyone else: null, as if it didn't exist). */
  getPairingStatus(pairSessionId: string, binding?: string): (Omit<PendingPairingState, "pairPsk" | "session" | "phoneStaticPub" | "deviceRelayPub" | "binding" | "accountGeneration" | "peerKey"> & { attached: boolean }) | null {
    const p = this.pairings.get(pairSessionId);
    if (p === undefined || (binding !== undefined && p.binding !== binding)) return null;
    if ((p.status === "awaiting_scan" || p.status === "awaiting_confirm") && this.nowMs() > p.expiresAtMs) {
      this.abortPairing(pairSessionId, "aborted_rejected");
      p.status = "expired";
    }
    return {
      pairSessionId: p.pairSessionId,
      accountName: p.accountName,
      expiresAtMs: p.expiresAtMs,
      status: p.status,
      attached: p.peerKey !== null,
      confirmCode: p.confirmCode,
      deviceName: p.deviceName,
    };
  }

  /** Step 5 of pairing: owner explicitly confirms the 6-char code on the Mac. Claimed once, synchronously, before any
   * await: a second confirm (a double click, another tab) finds "confirming" and is refused. */
  async confirmPairing(pairSessionId: string, binding?: string): Promise<{ ok: true; deviceId: string } | { ok: false; error: string }> {
    const p = this.pairings.get(pairSessionId);
    if (p === undefined || (binding !== undefined && p.binding !== binding)) return { ok: false, error: "Unknown pairing session." };
    if (p.status !== "awaiting_confirm" || p.session === null || p.peerKey === null || p.phoneStaticPub === null || p.deviceRelayPub === null) {
      return { ok: false, error: `Pairing cannot be confirmed in state: ${p.status}` };
    }
    // The phone that showed the code must still be the one attached.
    const attached = this.peers.get(p.peerKey);
    if (attached === undefined || attached.role !== "pair" || attached.peerId !== pairSessionId || attached.state !== "pair_pending_confirm") {
      this.abortPairing(pairSessionId, "aborted_rejected");
      return { ok: false, error: "The phone disconnected. Start pairing again." };
    }
    if (this.nowMs() > p.expiresAtMs) {
      p.status = "expired";
      this.dropPeer(attached, "pairing_expired");
      this.pairings.delete(pairSessionId);
      return { ok: false, error: "Pairing session expired." };
    }
    const account = this.store.accountOf(p.accountName);
    if (account === null || account.revokedAt !== null || account.role !== "approver" || (p.accountGeneration !== null && account.generation !== p.accountGeneration)) {
      this.abortPairing(pairSessionId, "aborted_rejected");
      return { ok: false, error: "Approver account standing changed." };
    }

    const identity = this.store.workspaceIdentity();
    const deviceId = `dev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const pskEntropy = randomPsk32();
    const devicePsk = deriveDevicePsk(pskEntropy, p.session.handshakeHash, identity.id, deviceId);
    const session = p.session, deviceRelayPub = p.deviceRelayPub;
    p.status = "confirming";

    savePairedDevice(this.store.handle, {
      deviceId,
      accountName: p.accountName,
      deviceName: p.deviceName ?? "iPhone",
      phoneStaticPub: p.phoneStaticPub,
      deviceRelayPub: p.deviceRelayPub,
      devicePsk,
      pskVersion: 1,
      recoveryGeneration: identity.recoveryGeneration,
      accountGeneration: p.accountGeneration ?? account.generation,
      createdAt: new Date(this.nowMs()).toISOString(),
    });

    try {
      await this.onDeviceRegistered?.(deviceId, deviceRelayPub.toString("base64url"), attached.link);
    } catch {
      // The relay may or may not have admitted the phone: undo the record here and ask the relay to forget it too
      // (revokeDevice's removal; a reconcile on the next connect settles it if that can't land either).
      await this.revokeDevice(deviceId);
      this.abortPairing(pairSessionId, "aborted_rejected");
      p.status = "failed";
      return { ok: false, error: "The relay didn't accept the phone. Check phone access in Settings and pair again." };
    }
    // Standing, the phone's socket and the pairing itself may have changed while the relay answered.
    const after = this.store.accountOf(p.accountName);
    const still = this.peers.get(attached.key);
    if (p.status !== "confirming" || after === null || after.revokedAt !== null || after.role !== "approver" || after.generation !== account.generation
      || still !== attached || still.peerId !== pairSessionId || still.state !== "pair_pending_confirm") {
      await this.revokeDevice(deviceId);
      this.abortPairing(pairSessionId, "aborted_rejected");
      p.status = "failed";
      return { ok: false, error: "Pairing was interrupted. Start pairing again." };
    }

    // Send encrypted pairing finalization payload including recoveryGeneration (needed for reconnect prologue!)
    const finalizePayload = Buffer.from(JSON.stringify({
      type: "pair.confirmed",
      deviceId,
      recoveryGeneration: identity.recoveryGeneration,
      pskEntropy: pskEntropy.toString("base64url"),
      pskVersion: 1,
    }), "utf8");
    const ct = session.encrypt(finalizePayload, this.nowMs());
    attached.link.send(attached.connId, ct);

    p.status = "confirmed";
    p.pairPsk.fill(0);
    return { ok: true, deviceId };
  }

  /** Cancel from the Mac (the owner's Cancel, or codes that didn't match): only the binding that started it. */
  cancelPairing(pairSessionId: string, binding: string): boolean {
    const p = this.pairings.get(pairSessionId);
    if (p === undefined || p.binding !== binding) return false;
    if (p.status === "confirming" || p.status === "confirmed") return false;
    this.abortPairing(pairSessionId, "aborted_rejected");
    return true;
  }

  /** The paired devices the relay should admit right now: live, this recovery generation. */
  admittedDevices(): { deviceId: string; deviceRelayPub: string }[] {
    const generation = this.store.workspaceIdentity().recoveryGeneration;
    return listPairedDevices(this.store.handle)
      .filter(d => d.revokedAt === null && d.recoveryGeneration === generation)
      .map(d => ({ deviceId: d.deviceId, deviceRelayPub: d.deviceRelayPub.toString("base64url") }));
  }

  /** A link went away (the relay socket, a direct socket) — or, with no link, all of them (stopping): every phone
   * session and attached pairing riding it is gone too. Nothing is kept that a reconnect could resurrect (a phone
   * reconnects with a fresh handshake; a pairing starts over). A pairing nobody has scanned yet survives a link. */
  handleRelayDisconnected(link?: PeerLink): void {
    const gone = new Set<string>();
    for (const peer of [...this.peers.values()]) {
      if (link !== undefined && peer.link !== link) continue;
      gone.add(peer.key);
      this.cleanupPeerLocal(peer);
    }
    for (const p of this.pairings.values()) {
      const attachedHere = p.peerKey !== null && gone.has(p.peerKey);
      if ((link === undefined && (p.status === "awaiting_scan" || p.status === "awaiting_confirm")) || (attachedHere && p.status === "awaiting_confirm")) {
        p.pairPsk.fill(0);
        p.session?.close();
        p.session = null;
        p.peerKey = null;
        p.status = "aborted_rejected";
      }
    }
  }

  abortPairing(pairSessionId: string, reason: "aborted_race" | "aborted_rejected" = "aborted_rejected"): void {
    const p = this.pairings.get(pairSessionId);
    if (p === undefined) return;
    p.status = reason;
    p.pairPsk.fill(0);
    p.peerKey = null;
    // Every socket referencing this pairSessionId, on any link.
    for (const peer of [...this.peers.values()]) {
      if (peer.role === "pair" && peer.peerId === pairSessionId) this.dropPeer(peer, reason);
    }
    p.session?.close();
    p.session = null;
  }

  /** Immediately revokes a paired device in SQLite, terminates any active session, and notifies the relay. */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const revoked = revokePairedDeviceRecord(this.store.handle, deviceId, new Date(this.nowMs()));
    for (const peer of [...this.peers.values()]) {
      if (peer.principal?.deviceId === deviceId || (peer.role === "device" && peer.peerId === deviceId)) {
        this.dropPeer(peer, "device_revoked");
      }
    }
    await this.onDeviceRevoked?.(deviceId);
    return revoked;
  }

  /** Handle an inbound binary envelope from a relay link (the default one-relay link when none is given). */
  async handleRelayEnvelope(raw: Buffer, link: PeerLink | null = this.defaultLink): Promise<void> {
    if (link === null) throw new Error("no relay link");
    const env = decodeRelayEnvelope(raw);
    if (env.op === RelayOp.PEER_OPEN) {
      const meta = JSON.parse(env.payload.toString("utf8")) as { role: "pair" | "device"; id: string };
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
    if (existing !== undefined) this.dropPeer(existing, "replaced");
    const reject = (reason: string) => link.close(connId, reason);
    if (role === "pair") {
      const pairing = this.pairings.get(peerId);
      if (pairing === undefined || this.nowMs() > pairing.expiresAtMs || pairing.status === "aborted_race" || pairing.status === "aborted_rejected") {
        reject("invalid_pairing");
        return;
      }
      // SECOND-HANDSHAKE RACE ABORT: if a peer is already attached to this pairSessionId (on any link), abort the
      // ENTIRE pairing — a second scanner is never told which one won.
      if (pairing.peerKey !== null) {
        this.abortPairing(peerId, "aborted_race");
        reject("aborted_race");
        return;
      }
      pairing.peerKey = key;
    } else {
      // Sockets that claimed this device id but haven't finished hello: anyone who saw the id can open them, and a
      // message 1 seen on the network can be replayed (only hello proves the phone holds the session keys). A newcomer
      // evicts the oldest rather than being refused, so strangers can't lock the phone out; a live session is untouched.
      const unproven = [...this.peers.values()].filter(peer => peer.role === "device" && peer.peerId === peerId && (peer.state === "awaiting_msg1" || peer.state === "awaiting_hello"));
      for (const stale of unproven.slice(0, Math.max(0, unproven.length - MAX_PENDING_PER_PEER_ID + 1))) this.dropPeer(stale, "superseded_handshake");
    }

    const handshakeTimer = setTimeout(() => {
      const peer = this.peers.get(key);
      if (peer !== undefined && (peer.state === "awaiting_msg1" || peer.state === "awaiting_hello")) {
        this.dropPeer(peer, "handshake_timeout");
      }
    }, this.handshakeDeadlineMs);
    handshakeTimer.unref?.();

    this.peers.set(key, {
      key,
      link,
      connId,
      role,
      peerId,
      state: "awaiting_msg1",
      handshakeTimer,
      session: null,
      principal: null,
      streamGuard: new CompanionStreamGuard(this.globalBudget),
      unaryPacers: new Map(),
      watchStreams: new Map(),
      streamAccess: new Map(),
    });
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
      if (peer.role === "pair") {
        this.handlePairingMsg1(peer, data);
      } else {
        this.handleSessionMsg1(peer, data);
      }
      return;
    }

    if (peer.state === "pair_pending_confirm") {
      // Zero RPCs allowed before the owner explicitly clicks Confirm on the Mac!
      this.dropPeer(peer, "unconfirmed_device");
      return;
    }

    if (peer.session === null) {
      this.dropPeer(peer, "no_session");
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

    await this.handleAuthenticatedFrame(peer, frame);
  }

  private handlePairingMsg1(peer: ActivePeerConn, msg1: Buffer): void {
    const pairing = this.pairings.get(peer.peerId);
    if (pairing === undefined || pairing.status !== "awaiting_scan" || this.nowMs() > pairing.expiresAtMs) {
      this.dropPeer(peer, "pairing_invalid");
      return;
    }
    const identity = this.store.workspaceIdentity();
    const prologue = buildPairingPrologue(identity.id, pairing.pairSessionId);
    const responder = new NoiseIKpsk2Responder({
      localStatic: { privateKey: this.hostKeys.noiseStaticPriv, publicKey: this.hostKeys.noiseStaticPub },
      psk: pairing.pairPsk,
      prologue,
    });
    let payload: Buffer;
    let remoteStaticPublicKey: Buffer;
    try {
      ({ payload, remoteStaticPublicKey } = responder.readMessage1(msg1));
    } catch {
      this.dropPeer(peer, "handshake_failed");
      return;
    }
    // Message 1 NEVER executes RPCs or mutates durable state.
    let meta: { protocolVersion?: unknown; mode?: unknown; deviceName?: unknown; deviceRelayPub?: unknown };
    try {
      meta = JSON.parse(payload.toString("utf8")) as typeof meta;
    } catch {
      this.dropPeer(peer, "invalid_msg1_payload");
      return;
    }
    if (meta.protocolVersion !== 1 || meta.mode !== "pair" || typeof meta.deviceRelayPub !== "string") {
      this.dropPeer(peer, "invalid_msg1_payload");
      return;
    }
    const deviceRelayPub = Buffer.from(meta.deviceRelayPub, "base64url");
    if (deviceRelayPub.length !== 32) {
      this.dropPeer(peer, "invalid_device_relay_pub");
      return;
    }

    const { message: msg2, session } = responder.writeMessage2(
      Buffer.from(JSON.stringify({ protocolVersion: 1, status: "pending_confirm" }), "utf8"),
      this.nowMs(),
    );
    clearTimeout(peer.handshakeTimer);
    peer.session = session;
    peer.state = "pair_pending_confirm";
    pairing.status = "awaiting_confirm";
    pairing.confirmCode = deriveConfirmationCode(session.handshakeHash);
    pairing.deviceName = sanitizeDeviceName(meta.deviceName);
    pairing.phoneStaticPub = remoteStaticPublicKey;
    pairing.deviceRelayPub = deviceRelayPub;
    pairing.session = session;

    peer.link.send(peer.connId, msg2);
  }

  private handleSessionMsg1(peer: ActivePeerConn, msg1: Buffer): void {
    const dev = getPairedDevice(this.store.handle, peer.peerId);
    const identity = this.store.workspaceIdentity();
    if (dev === null || dev.revokedAt !== null || dev.recoveryGeneration !== identity.recoveryGeneration) {
      this.dropPeer(peer, "device_invalid_or_restored");
      return;
    }
    const account = this.store.accountOf(dev.accountName);
    if (!deviceAccountStands(dev, account)) {
      this.dropPeer(peer, "account_revoked");
      return;
    }

    const prologue = buildSessionPrologue(identity.id, dev.deviceId, identity.recoveryGeneration);
    const responder = new NoiseIKpsk2Responder({
      localStatic: { privateKey: this.hostKeys.noiseStaticPriv, publicKey: this.hostKeys.noiseStaticPub },
      psk: dev.devicePsk,
      prologue,
    });
    let payload: Buffer;
    let remoteStaticPublicKey: Buffer;
    try {
      ({ payload, remoteStaticPublicKey } = responder.readMessage1(msg1));
    } catch {
      this.dropPeer(peer, "handshake_failed");
      return;
    }
    if (!timingSafeEqual(remoteStaticPublicKey, dev.phoneStaticPub)) {
      this.dropPeer(peer, "static_key_mismatch");
      return;
    }
    // Message 1 carries metadata only — never executes RPCs.
    let meta: { protocolVersion?: unknown; mode?: unknown; deviceId?: unknown };
    try {
      meta = JSON.parse(payload.toString("utf8")) as typeof meta;
    } catch {
      this.dropPeer(peer, "invalid_msg1_payload");
      return;
    }
    if (meta.protocolVersion !== 1 || meta.mode !== "session" || meta.deviceId !== dev.deviceId) {
      this.dropPeer(peer, "invalid_msg1_payload");
      return;
    }

    const { message: msg2, session } = responder.writeMessage2(
      Buffer.from(JSON.stringify({ protocolVersion: 1, status: "awaiting_hello" }), "utf8"),
      this.nowMs(),
    );
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
    peer.link.send(peer.connId, msg2);
  }

  private verifyLiveStanding(principal: PairedDevicePrincipal): boolean {
    const identity = this.store.workspaceIdentity();
    if (identity.id !== principal.workspaceId || identity.recoveryGeneration !== principal.recoveryGeneration) {
      return false;
    }
    const dev = getPairedDevice(this.store.handle, principal.deviceId);
    if (dev === null || dev.revokedAt !== null) return false;
    return deviceAccountStands(dev, this.store.accountOf(principal.accountName));
  }

  /** The stream's read-time access still holds (no fingerprint taken: nothing to compare). */
  private accessHolds(peer: ActivePeerConn, streamId: number): boolean {
    const taken = peer.streamAccess.get(streamId);
    if (taken === undefined || this.handlers.accessSignature === undefined || peer.principal === null) return true;
    return this.handlers.accessSignature(peer.principal) === taken;
  }

  /** Ends a stream whose account can no longer see what it carries: nothing queued is sent. */
  private denyStream(peer: ActivePeerConn, streamId: number): void {
    const watch = peer.watchStreams.get(streamId);
    if (watch !== undefined) { watch.unsubscribe(); peer.watchStreams.delete(streamId); }
    peer.unaryPacers.delete(streamId);
    peer.streamAccess.delete(streamId);
    peer.streamGuard.closeStream(streamId);
    this.sendEncryptedFrame(peer, { type: FrameType.ERROR, streamId, seq: 0, payload: encodeErrorPayload("not_found", "That's no longer available to you.") });
  }

  private async handleAuthenticatedFrame(peer: ActivePeerConn, frame: CompanionFrame): Promise<void> {
    if (peer.principal === null || !this.verifyLiveStanding(peer.principal)) {
      this.dropPeer(peer, "standing_revoked");
      return;
    }

    if (frame.type === FrameType.PING) {
      this.sendEncryptedFrame(peer, { type: FrameType.PONG, streamId: 0, seq: frame.seq, payload: frame.payload });
      return;
    }
    if (frame.type === FrameType.PONG) return;

    if (frame.type === FrameType.CANCEL) {
      // CANCEL stops watching ONLY — NEVER stops the underlying agent run!
      const watch = peer.watchStreams.get(frame.streamId);
      if (watch !== undefined) {
        watch.unsubscribe();
        peer.watchStreams.delete(frame.streamId);
      }
      peer.unaryPacers.delete(frame.streamId);
      peer.streamAccess.delete(frame.streamId);
      peer.streamGuard.closeStream(frame.streamId);
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
        this.pumpWatchStream(peer, frame.streamId, watch);
      }
      return;
    }

    const ingested = peer.streamGuard.ingestRequestFrame(frame, this.nowMs());
    if (!ingested.ok) {
      this.sendEncryptedFrame(peer, {
        type: FrameType.ERROR,
        streamId: frame.streamId,
        seq: 0,
        payload: encodeErrorPayload(ingested.code, ingested.message),
      });
      if (ingested.closeSession) this.dropPeer(peer, ingested.code);
      return;
    }
    if (ingested.completePayload === undefined) return; // still awaiting more REQ_CHUNK / END

    let req: { method?: unknown; params?: unknown };
    try {
      req = JSON.parse(ingested.completePayload.toString("utf8")) as typeof req;
    } catch {
      this.sendRpcError(peer, frame.streamId, "invalid_json", "RPC payload must be valid JSON");
      return;
    }
    const method = typeof req.method === "string" ? req.method : "";
    const params = req.params !== null && typeof req.params === "object" && !Array.isArray(req.params)
      ? (req.params as Record<string, unknown>)
      : {};

    // Key confirmation rule (spec §1.3): first transport RPC MUST be `device.hello`
    if (peer.state === "awaiting_hello") {
      if (method !== "device.hello") {
        this.sendRpcError(peer, frame.streamId, "hello_required", "First transport RPC must be device.hello");
        this.dropPeer(peer, "hello_required");
        return;
      }
      clearTimeout(peer.handshakeTimer);
      peer.state = "authenticated";
      // One live session per phone: an older one (another path, a socket the phone gave up on) is closed.
      for (const other of [...this.peers.values()]) {
        if (other !== peer && other.state === "authenticated" && other.principal?.deviceId === peer.principal.deviceId) this.dropPeer(other, "superseded");
      }
      touchPairedDeviceLastSeen(this.store.handle, peer.principal.deviceId, new Date(this.nowMs()));
    }

    if (!PAIRED_DEVICE_GATE1_ROUTES.has(method)) {
      this.sendRpcError(peer, frame.streamId, "route_not_allowed", `Method '${method}' is not on the paired-device allowlist`);
      return;
    }

    await this.dispatchGate1Method(peer, frame.streamId, method, params);
  }

  private async dispatchGate1Method(
    peer: ActivePeerConn,
    streamId: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const principal = peer.principal!;
    // The account's access as the read begins: what it yields is delivered only while this still holds.
    if (this.handlers.accessSignature !== undefined) peer.streamAccess.set(streamId, this.handlers.accessSignature(principal));
    try {
      if (method === "device.self.revoke") {
        this.sendRpcResult(peer, streamId, { ok: true, revoked: true });
        await this.revokeDevice(principal.deviceId);
        return;
      }
      if (method === "push.register") {
        const apnsToken = typeof params["apnsToken"] === "string" ? params["apnsToken"] : "";
        const p256dh = typeof params["p256dh"] === "string" ? params["p256dh"] : "";
        const authSecret = typeof params["authSecret"] === "string" ? params["authSecret"] : "";
        savePushSubscription(this.store.handle, {
          deviceId: principal.deviceId,
          apnsToken,
          p256dh,
          authSecret,
          includeTitles: false, // privacy default: task titles stay on Mac unless opted in on Mac
          updatedAt: new Date(this.nowMs()).toISOString(),
        });
        this.sendRpcResult(peer, streamId, { ok: true });
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
        const buffer = new LiveWatchBuffer();
        const watchEntry: WatchEntry = { buffer, unsubscribe: () => {}, seq: 0, ending: false };
        const sub = this.handlers.runWatchSubscribe(principal, params, record => {
          if (peer.watchStreams.get(streamId) !== watchEntry) return; // stopped watching, or not admitted yet
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
          peer.streamGuard.closeStream(streamId);
          this.sendRpcError(peer, streamId, sub.code, sub.message);
          return;
        }
        watchEntry.unsubscribe = sub.unsubscribe;
        peer.watchStreams.set(streamId, watchEntry);
        this.pumpWatchStream(peer, streamId, watchEntry);
        return;
      }

      let result: unknown;
      switch (method) {
        case "device.hello": {
          const hello = await this.handlers.deviceHello(principal);
          // The phone keeps the freshest ways back to this Mac (a new Wi-Fi address, Tailscale on or off).
          const paths = this.pathsOf();
          result = hello !== null && typeof hello === "object" && pathsAllowed(paths) ? { ...hello, paths } : hello;
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
      if (code === "standing_revoked") this.dropPeer(peer, "standing_revoked");
    }
  }

  private sendRpcResult(peer: ActivePeerConn, streamId: number, result: unknown): void {
    const payload = Buffer.from(JSON.stringify({ ok: true, result }), "utf8");
    const pacer = new UnaryResponsePacer(streamId, payload, this.nowMs());
    peer.unaryPacers.set(streamId, pacer);
    this.pumpUnaryPacer(peer, streamId, pacer);
  }

  private pumpUnaryPacer(peer: ActivePeerConn, streamId: number, pacer: UnaryResponsePacer): void {
    if (!this.accessHolds(peer, streamId)) { this.denyStream(peer, streamId); return; }
    const pulled = pacer.pullAvailable(this.nowMs());
    if (!pulled.ok) {
      peer.unaryPacers.delete(streamId);
      peer.streamGuard.closeStream(streamId);
      this.sendEncryptedFrame(peer, {
        type: FrameType.ERROR,
        streamId,
        seq: 0,
        payload: encodeErrorPayload(pulled.code, "Unary response exceeded 30s deadline"),
      });
      return;
    }
    for (const f of pulled.frames) {
      this.sendEncryptedFrame(peer, f);
    }
    if (pacer.done) {
      peer.unaryPacers.delete(streamId);
      peer.streamAccess.delete(streamId);
      peer.streamGuard.closeStream(streamId);
    }
  }

  private pumpWatchStream(peer: ActivePeerConn, streamId: number, watch: WatchEntry): void {
    if (!this.accessHolds(peer, streamId)) { this.denyStream(peer, streamId); return; }
    for (const rec of watch.buffer.drainAvailable()) {
      this.sendEncryptedFrame(peer, {
        type: FrameType.CHUNK,
        streamId,
        seq: watch.seq++,
        payload: rec,
      });
    }
    // An ended watch closes once everything it buffered has gone out.
    if (watch.ending && watch.buffer.length === 0 && watch.buffer.pendingCut === 0 && peer.watchStreams.get(streamId) === watch) {
      peer.watchStreams.delete(streamId);
      peer.streamAccess.delete(streamId);
      peer.streamGuard.closeStream(streamId);
      this.sendEncryptedFrame(peer, { type: FrameType.END, streamId, seq: watch.seq++, payload: Buffer.alloc(0) });
    }
  }

  private sendRpcError(peer: ActivePeerConn, streamId: number, code: string, message: string): void {
    peer.streamAccess.delete(streamId);
    peer.streamGuard.closeStream(streamId);
    this.sendEncryptedFrame(peer, {
      type: FrameType.ERROR,
      streamId,
      seq: 0,
      payload: encodeErrorPayload(code, message),
    });
  }

  private sendEncryptedFrame(peer: ActivePeerConn, frame: CompanionFrame): void {
    if (peer.session === null) return;
    try {
      const ct = peer.session.encrypt(encodeFrame(frame), this.nowMs());
      peer.link.send(peer.connId, ct);
    } catch {
      this.dropPeer(peer, "encrypt_failed");
    }
  }

  private dropPeer(peer: ActivePeerConn, reason: string): void {
    if (this.peers.get(peer.key) !== peer) return; // already gone (a late callback for a replaced peer)
    this.cleanupPeerLocal(peer);
    peer.link.close(peer.connId, reason);
  }

  private cleanupPeerLocal(peer: ActivePeerConn): void {
    if (this.peers.get(peer.key) !== peer) return;
    clearTimeout(peer.handshakeTimer);
    for (const w of peer.watchStreams.values()) w.unsubscribe();
    peer.watchStreams.clear();
    peer.unaryPacers.clear();
    peer.streamGuard.releaseAll();
    peer.session?.close();
    this.peers.delete(peer.key);
    for (const p of this.pairings.values()) {
      if (p.peerKey === peer.key && p.status === "awaiting_confirm") {
        p.pairPsk.fill(0);
        p.session?.close();
        p.session = null;
        p.status = "aborted_rejected";
      }
      if (p.peerKey === peer.key) p.peerKey = null;
    }
  }
}
