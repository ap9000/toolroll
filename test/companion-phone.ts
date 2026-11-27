/**
 * A TypeScript phone for the companion's tests: the same Noise, framing and pairing wire the iOS app speaks
 * (docs/plans/companion-app/noise-relay-protocol.md, test/fixtures/companion-wire.json), over either a real WebSocket
 * (the reference relay or the direct listener) or straight into an engine through a test link (no sockets: every step
 * is awaited in order, so engine-level tests need no timing at all).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { CompanionDaemonEngine, PairingQrPayload, PeerLink } from "../src/companion/daemon.js";
import { decodeFrame, encodeCreditPayload, encodeFrame, FrameType, type CompanionFrame } from "../src/companion/framing.js";
import {
  buildPairingPrologue,
  buildSessionPrologue,
  deriveConfirmationCode,
  deriveDevicePsk,
  generateX25519KeyPair,
  NoiseIKpsk2Initiator,
  type NoiseTransportSession,
  type X25519KeyPair,
} from "../src/companion/noise.js";
import { generateEd25519KeyPair, signRelayToken, type Ed25519KeyPair } from "../src/companion/relay-auth.js";

/** The frozen wire numbers (Node and Swift tests both read this file, so drift fails both). */
export const WIRE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "companion-wire.json"), "utf8")) as {
  protocolVersion: number;
  msg2: { paddedPlaintextBytes: number; padField: string; statuses: { pair: string[]; session: string[] }; refusedReasons: string[] };
  pairing: { readyDeadlineMs: number; keepalivePingMs: number; ready: { stream: number; method: string }; readyErrors: string[]; done: { stream: number; method: string }; pendingActivationWindowMs: number };
  session: { stream0Errors: string[]; closeCodes: { revoked: number; rekey: number } };
  relay: { errorHeader: string; envelope: Record<string, number>; heartbeat: { intervalMs: number; macTimeoutMs: number; payloadBytes: number }; closeCodes: Record<string, number>;
    limits: { devicesPerMachine: number }; macPacing: { perConnection: { bytesPerMin: number; bytesBurst: number }; perHostedLink: { bytesPerMin: number; bytesBurst: number } } };
  mac: { tombstoneDays: number; msg1ReplayWindowMs: number; msg1ReplayPerId: number; msg1ReplayTotal: number; phonesPerMac: number;
    directPorts: { default: number; fallbackFirst: number; fallbackLast: number }; bonjourService: string; bonjourMachineIdTxtKey: string };
};

/** One phone connection's transport, as the phone sees it. */
export interface PhoneWire {
  send(message: Buffer): Promise<void>;
  next(ms?: number): Promise<Buffer | null>;
  readonly closed: boolean;
  readonly closeReason: string;
  readonly closeCode: number | null;
  close(): void;
}

/** A real WebSocket (the reference relay or the direct listener): binary messages in order, awaited one at a time. */
export class PhoneSocket implements PhoneWire {
  private readonly queue: Buffer[] = [];
  private waiter: ((b: Buffer | null) => void) | null = null;
  closed = false;
  closeReason = "";
  closeCode: number | null = null;
  private constructor(readonly ws: WebSocket) {
    ws.on("message", raw => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (this.waiter !== null) { const w = this.waiter; this.waiter = null; w(buf); } else this.queue.push(buf);
    });
    ws.on("close", (code, reason) => {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason.toString("utf8");
      if (this.waiter !== null) { const w = this.waiter; this.waiter = null; w(null); }
    });
  }
  static open(url: string, token: string | null): Promise<PhoneSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, token === null ? {} : { headers: { authorization: `Bearer ${token}` } });
      const socket = new PhoneSocket(ws);
      ws.once("open", () => resolve(socket));
      ws.once("unexpected-response", (_q, res) => reject(new Error(`refused ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }
  next(ms = 3_000): Promise<Buffer | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error("no message")); }, ms); // guard: bound deadline for a message that must arrive, not a wait
      this.waiter = b => { clearTimeout(timer); resolve(b); };
    });
  }
  async send(b: Buffer): Promise<void> { this.ws.send(b, { binary: true }); }
  close(): void { this.ws.close(); }
}

let linkSeq = 0;

/**
 * A phone connected straight into an engine through its own test link (connId 1): what the engine sends is queued,
 * what the phone sends is awaited through the engine. `link` options make it look like a hosted relay link (pacing).
 */
export class EngineWire implements PhoneWire {
  private readonly queue: Buffer[] = [];
  closed = false;
  closeReason = "";
  closeCode: number | null = null;
  readonly link: PeerLink;
  private constructor(private readonly engine: CompanionDaemonEngine, link: Partial<PeerLink>) {
    linkSeq += 1;
    this.link = {
      id: `test#${linkSeq}`,
      send: (_connId, payload) => { if (!this.closed) this.queue.push(Buffer.from(payload)); },
      close: (_connId, reason, code) => { this.closed = true; this.closeReason = reason; this.closeCode = code ?? null; },
      ...link,
    };
  }
  static open(engine: CompanionDaemonEngine, role: "pair" | "device", id: string, link: Partial<PeerLink> = {}): EngineWire {
    const wire = new EngineWire(engine, link);
    engine.openPeer(wire.link, 1, role, id);
    return wire;
  }
  async send(b: Buffer): Promise<void> { if (!this.closed) await this.engine.peerData(this.link, 1, b); }
  async next(): Promise<Buffer | null> { return this.queue.shift() ?? null; }
  /** Everything the engine sent that the phone hasn't read. */
  get pending(): number { return this.queue.length; }
  close(): void { this.closed = true; this.engine.closePeer(this.link, 1); }
}

export interface PairedPhone { deviceId: string; recoveryGeneration: string; devicePsk: Buffer; noise: X25519KeyPair; relayKey: Ed25519KeyPair; qr: PairingQrPayload }

export const hostedUrlOf = (qr: PairingQrPayload): string => qr.paths.find(path => path.kind === "hosted")!.url;

const req = (streamId: number, method: string, params: Record<string, unknown>): CompanionFrame =>
  ({ type: FrameType.REQ, streamId, seq: 0, payload: Buffer.from(JSON.stringify({ method, params })) });

/** The phone's side of one pairing socket: message 1, message 2, `pair.ready`, the outcome, `pair.done`. */
export class PairingPhone {
  private constructor(
    readonly wire: PhoneWire,
    readonly qr: PairingQrPayload,
    readonly noise: X25519KeyPair,
    readonly relayKey: Ed25519KeyPair,
    readonly session: NoiseTransportSession,
    /** The decrypted message 2 payload (padded). */
    readonly msg2: Buffer,
    readonly msg1: Buffer,
  ) {}

  /** The code both screens show. */
  get code(): string { return deriveConfirmationCode(this.session.handshakeHash); }

  /** Message 1 and 2. Throws when the Mac doesn't answer message 1. */
  static async scan(qr: PairingQrPayload, wire: PhoneWire, opts: { noise?: X25519KeyPair; relayKey?: Ed25519KeyPair; msg1?: Buffer } = {}): Promise<PairingPhone> {
    const noise = opts.noise ?? generateX25519KeyPair();
    const relayKey = opts.relayKey ?? generateEd25519KeyPair();
    const initiator = new NoiseIKpsk2Initiator({
      localStatic: noise, remoteStaticPublicKey: Buffer.from(qr.macStaticPub, "base64url"),
      psk: Buffer.from(qr.pairPsk, "base64url"), prologue: buildPairingPrologue(qr.workspaceId, qr.pairSessionId),
    });
    const msg1 = opts.msg1 ?? initiator.writeMessage1(Buffer.from(JSON.stringify({ protocolVersion: 1, mode: "pair", deviceRelayPub: relayKey.publicKey.toString("base64url") })));
    await wire.send(msg1);
    const msg2 = await wire.next();
    if (msg2 === null) throw new Error(`no message 2: ${wire.closeReason}`);
    const { payload, session } = initiator.readMessage2(msg2);
    return new PairingPhone(wire, qr, noise, relayKey, session, payload, msg1);
  }

  async sendFrame(frame: CompanionFrame): Promise<void> { await this.wire.send(this.session.encrypt(encodeFrame(frame))); }

  async ready(deviceName: unknown = "Test iPhone"): Promise<void> {
    await this.sendFrame(req(1, "pair.ready", { deviceName }));
  }

  async ping(seq = 1): Promise<void> {
    await this.sendFrame({ type: FrameType.PING, streamId: 0, seq, payload: Buffer.from("k") });
  }

  /** The next frame from the Mac, or null when the connection closed (or, on an engine wire, nothing is queued). */
  async frame(ms?: number): Promise<CompanionFrame | null> {
    const ct = await this.wire.next(ms);
    return ct === null ? null : decodeFrame(this.session.decrypt(ct));
  }

  /** The answer on a stream, skipping keepalive PONGs: a RES's result, or an ERROR's code. */
  async answer(streamId: number, ms?: number): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; code: string } | null> {
    for (;;) {
      const f = await this.frame(ms);
      if (f === null) return null;
      if (f.type === FrameType.PONG || f.streamId !== streamId) continue;
      const body = JSON.parse(f.payload.toString("utf8")) as Record<string, unknown>;
      if (f.type === FrameType.RES) return { ok: true, result: body["result"] as Record<string, unknown> };
      if (f.type === FrameType.ERROR) return { ok: false, code: String(body["code"]) };
    }
  }

  async done(deviceId: string): Promise<void> {
    await this.sendFrame(req(3, "pair.done", { deviceId }));
  }

  /** The phone's stored pairing, from the outcome RES. */
  paired(outcome: Record<string, unknown>): PairedPhone {
    const deviceId = String(outcome["deviceId"]);
    return {
      deviceId, recoveryGeneration: String(outcome["recoveryGeneration"]), noise: this.noise, relayKey: this.relayKey, qr: this.qr,
      devicePsk: deriveDevicePsk(Buffer.from(String(outcome["pskEntropy"]), "base64url"), this.session.handshakeHash, this.qr.workspaceId, deviceId),
    };
  }
}

/** A paired phone's session: message 1 and 2, then one RPC at a time, chunks reassembled with credit, like the app. */
export class PhoneSession {
  private nextStream = 1;
  constructor(readonly wire: PhoneWire, readonly session: NoiseTransportSession, readonly msg2: Buffer, readonly msg1: Buffer) {}

  /** The device token a phone mints for the hosted relay. */
  static token(phone: PairedPhone): string {
    return signRelayToken(phone.relayKey.privateKey, { role: "device", machineId: phone.qr.machineId, aud: new URL(hostedUrlOf(phone.qr)).host, deviceId: phone.deviceId, ttlSec: 60 });
  }

  /** The handshake only: the decrypted message 2 tells whether the Mac accepted or refused. Throws when it didn't
   * answer message 1 at all. */
  static async handshake(phone: PairedPhone, wire: PhoneWire, msg1?: Buffer): Promise<PhoneSession> {
    const initiator = new NoiseIKpsk2Initiator({
      localStatic: phone.noise, remoteStaticPublicKey: Buffer.from(phone.qr.macStaticPub, "base64url"), psk: phone.devicePsk,
      prologue: buildSessionPrologue(phone.qr.workspaceId, phone.deviceId, phone.recoveryGeneration),
    });
    const first = msg1 ?? initiator.writeMessage1(Buffer.from(JSON.stringify({ protocolVersion: 1, mode: "session", deviceId: phone.deviceId })));
    await wire.send(first);
    const msg2 = await wire.next();
    if (msg2 === null) throw new Error(`handshake refused: ${wire.closeReason}`);
    const { payload, session } = initiator.readMessage2(msg2);
    return new PhoneSession(wire, session, payload, first);
  }

  get status(): { status: string; reason?: string } {
    return JSON.parse(this.msg2.toString("utf8")) as { status: string; reason?: string };
  }

  /** A session the Mac accepted (throws on a refusal). */
  static async connect(phone: PairedPhone, wire: PhoneWire): Promise<PhoneSession> {
    const s = await PhoneSession.handshake(phone, wire);
    if (s.status.status !== "awaiting_hello") throw new Error(`refused: ${s.status.reason ?? s.status.status}`);
    return s;
  }

  async sendFrame(frame: CompanionFrame): Promise<void> { await this.wire.send(this.session.encrypt(encodeFrame(frame))); }
  async frame(ms?: number): Promise<CompanionFrame | null> {
    const ct = await this.wire.next(ms);
    return ct === null ? null : decodeFrame(this.session.decrypt(ct));
  }
  async open(method: string, params: Record<string, unknown> = {}): Promise<number> {
    const streamId = this.nextStream;
    this.nextStream += 2;
    await this.sendFrame(req(streamId, method, params));
    return streamId;
  }
  async credit(streamId: number, grant: number): Promise<void> { await this.sendFrame({ type: FrameType.CREDIT, streamId, seq: 0, payload: encodeCreditPayload(grant) }); }
  async cancel(streamId: number): Promise<void> { await this.sendFrame({ type: FrameType.CANCEL, streamId, seq: 0, payload: Buffer.alloc(0) }); }
  async call(method: string, params: Record<string, unknown> = {}): Promise<{ ok: true; result: unknown } | { ok: false; code: string }> {
    const streamId = await this.open(method, params);
    const chunks: Buffer[] = [];
    for (;;) {
      const f = await this.frame();
      if (f === null) throw new Error(`closed: ${this.wire.closeReason}`);
      if (f.streamId !== streamId) continue;
      if (f.type === FrameType.RES) return JSON.parse(f.payload.toString("utf8")) as { ok: true; result: unknown };
      if (f.type === FrameType.CHUNK) { chunks.push(f.payload); await this.credit(streamId, 1); continue; }
      if (f.type === FrameType.END) return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: true; result: unknown };
      if (f.type === FrameType.ERROR) return { ok: false, code: (JSON.parse(f.payload.toString("utf8")) as { code: string }).code };
    }
  }
}

/** The whole pairing on the phone's side over one wire: scan, ready, (the test confirms), outcome, done. */
export async function pairOver(wire: PhoneWire, qr: PairingQrPayload, confirm: () => Promise<unknown>, deviceName = "Test iPhone"): Promise<PairedPhone> {
  const phone = await PairingPhone.scan(qr, wire);
  await phone.ready(deviceName);
  await confirm();
  const outcome = await phone.answer(1);
  if (outcome === null || !outcome.ok) throw new Error(`pairing outcome: ${outcome === null ? "closed" : outcome.code}`);
  const paired = phone.paired(outcome.result);
  await phone.done(paired.deviceId);
  const done = await phone.answer(3);
  if (done === null || !done.ok) throw new Error(`pair.done: ${done === null ? "closed" : done.code}`);
  return paired;
}

