/**
 * Phone access end to end over a real relay (the reference relay on loopback) and the direct path: a TypeScript phone
 * (the same Noise and framing the iOS app speaks) pairs, is confirmed on "the Mac", reconnects, reads, watches, and is
 * removed. The reads are stand-ins here (reads.ts is proven against a console in reads.test.ts); this proves the
 * transport, pairing binding, relay reconciliation and teardown.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { addApprover } from "../scope.js";
import { openStore, type Store } from "../store.js";
import type { CompanionReadHandlers, PairingQrPayload } from "./daemon.js";
import { startReferenceRelay, type RunningReferenceRelay } from "./relay-server.js";
import { decodeFrame, encodeCreditPayload, encodeFrame, FrameType, type CompanionFrame } from "./framing.js";
import {
  buildPairingPrologue,
  buildSessionPrologue,
  deriveConfirmationCode,
  deriveDevicePsk,
  generateX25519KeyPair,
  NoiseIKpsk2Initiator,
  type NoiseTransportSession,
  type X25519KeyPair,
} from "./noise.js";
import { generateEd25519KeyPair, signRelayToken, type Ed25519KeyPair } from "./relay-auth.js";
import { CompanionService } from "./service.js";
import { getPairedDevice, livePairedDevices, retireCompanionOnRestore } from "./store.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function testStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-companion-service-"));
  const store = openStore(join(dir, "toolroll.db"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  if (!addApprover(store, "owner", new Date()).ok) throw new Error("no approver");
  return store;
}

const watchEnds: (() => void)[] = [];
/** The stand-in account's access fingerprint: a test changes it to narrow the account mid-stream. */
let accessNow = "projects:a,b";
/** A controllable watch: the test emits and ends it. */
const controlled: { emit: ((n: number) => void) | null; end: ((reason?: "denied") => void) | null } = { emit: null, end: null };
const reads: CompanionReadHandlers = {
  accessSignature: () => accessNow,
  deviceHello: p => ({ version: 1, workspaceId: p.workspaceId, workspaceLabel: "Test Mac", account: p.accountName, deviceId: p.deviceId, toolroll: "test" }),
  workRows: (p, params) => ({ rows: [{ id: "t-1", title: "A task" }], account: p.accountName, params }),
  taskSteps: (_p, params) => { if (params["task"] !== "t-1") throw Object.assign(new Error("No such task."), { code: "not_found" }); return { cards: [] }; },
  taskDiff: () => ({ files: [] }),
  taskApprovalRead: () => ({ terms: [] }),
  runWindowRead: (_p, params) => ({ big: "x".repeat(params["size"] === "huge" ? 1_000_000 : 200_000) }),
  runWatchSubscribe: (_p, params, emit, end) => {
    if (params["run"] === "controlled") {
      controlled.emit = n => emit(Buffer.from(JSON.stringify({ k: "say", n })));
      controlled.end = reason => end?.(reason);
      return { ok: true, unsubscribe: () => { controlled.emit = null; } };
    }
    let n = 0;
    const timer = setInterval(() => { emit(Buffer.from(JSON.stringify({ k: "say", n: n++ }))); }, 5);
    const stop = () => clearInterval(timer);
    watchEnds.push(() => { stop(); end?.(); });
    return { ok: true, unsubscribe: stop };
  },
};

/** The relay the last startService used (a test restarts or probes it). */
let relay: RunningReferenceRelay;

async function startService(store: Store): Promise<CompanionService> {
  accessNow = "projects:a,b";
  relay = await startReferenceRelay({ host: "127.0.0.1", port: 0 });
  const running = relay;
  cleanups.push(() => running.close());
  const service = new CompanionService({ store, reads, direct: null, hosted: relay.wsUrl, backoff: { first: 50, max: 200 }, lanAddresses: () => [], tailnetIpv4: async () => null });
  cleanups.push(() => service.stop());
  await service.start();
  await until(() => service.status().hosted.state === "connected");
  return service;
}

const hostedUrlOf = (qr: PairingQrPayload): string => qr.paths.find(path => path.kind === "hosted")!.url;

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 10)); // guard: bound poll interval while waiting on the fact check() names
  }
}

/** A phone socket: binary messages in order, awaited one at a time. */
class PhoneSocket {
  private readonly queue: Buffer[] = [];
  private waiter: ((b: Buffer | null) => void) | null = null;
  closed = false;
  closeReason = "";
  private constructor(readonly ws: WebSocket) {
    ws.on("message", raw => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (this.waiter !== null) { const w = this.waiter; this.waiter = null; w(buf); } else this.queue.push(buf);
    });
    ws.on("close", (_code, reason) => {
      this.closed = true;
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
  send(b: Buffer): void { this.ws.send(b, { binary: true }); }
  close(): void { this.ws.close(); }
}

interface PairedPhone { deviceId: string; recoveryGeneration: string; devicePsk: Buffer; noise: X25519KeyPair; relayKey: Ed25519KeyPair; qr: PairingQrPayload }

/** Steps 2–4 on the phone: scan, handshake, show the code; resolves the code and a promise of the finished pairing. */
async function scan(qr: PairingQrPayload, deviceName = "Test iPhone", direct: string | null = null) {
  const noise = generateX25519KeyPair();
  const relayKey = generateEd25519KeyPair();
  const initiator = new NoiseIKpsk2Initiator({
    localStatic: noise, remoteStaticPublicKey: Buffer.from(qr.macStaticPub, "base64url"),
    psk: Buffer.from(qr.pairPsk, "base64url"), prologue: buildPairingPrologue(qr.workspaceId, qr.pairSessionId),
  });
  const socket = direct === null ? await PhoneSocket.open(hostedUrlOf(qr), qr.pairConnToken!) : await PhoneSocket.open(`${direct}?role=pair&id=${qr.pairSessionId}`, null);
  socket.send(initiator.writeMessage1(Buffer.from(JSON.stringify({ protocolVersion: 1, mode: "pair", deviceName, deviceRelayPub: relayKey.publicKey.toString("base64url") }))));
  const msg2 = await socket.next();
  if (msg2 === null) throw new Error("closed before msg2");
  const { session } = initiator.readMessage2(msg2);
  const code = deriveConfirmationCode(session.handshakeHash);
  const finished = (async (): Promise<PairedPhone | null> => {
    const fin = await socket.next(5_000).catch(() => null);
    if (fin === null) return null;
    const body = JSON.parse(session.decrypt(fin).toString("utf8")) as { type: string; deviceId: string; recoveryGeneration: string; pskEntropy: string };
    expect(body.type).toBe("pair.confirmed");
    socket.close();
    return {
      deviceId: body.deviceId, recoveryGeneration: body.recoveryGeneration, noise, relayKey, qr,
      devicePsk: deriveDevicePsk(Buffer.from(body.pskEntropy, "base64url"), session.handshakeHash, qr.workspaceId, body.deviceId),
    };
  })();
  return { code, finished, socket };
}

/** A paired phone's session: one RPC at a time, chunks reassembled with credit, like the app. */
class PhoneSession {
  private nextStream = 1;
  constructor(readonly socket: PhoneSocket, readonly session: NoiseTransportSession) {}
  /** Over the hosted relay, or (`direct`: the direct listener's ws://…/v1/direct) straight to the Mac with no token. */
  static async connect(phone: PairedPhone, direct: string | null = null): Promise<PhoneSession> {
    const token = signRelayToken(phone.relayKey.privateKey, { role: "device", machineId: phone.qr.machineId, deviceId: phone.deviceId, ttlSec: 60 });
    const socket = direct === null ? await PhoneSocket.open(hostedUrlOf(phone.qr), token) : await PhoneSocket.open(`${direct}?role=device&id=${phone.deviceId}`, null);
    const initiator = new NoiseIKpsk2Initiator({
      localStatic: phone.noise, remoteStaticPublicKey: Buffer.from(phone.qr.macStaticPub, "base64url"), psk: phone.devicePsk,
      prologue: buildSessionPrologue(phone.qr.workspaceId, phone.deviceId, phone.recoveryGeneration),
    });
    socket.send(initiator.writeMessage1(Buffer.from(JSON.stringify({ protocolVersion: 1, mode: "session", deviceId: phone.deviceId }))));
    const msg2 = await socket.next();
    if (msg2 === null) throw new Error(`handshake refused: ${socket.closeReason}`);
    return new PhoneSession(socket, initiator.readMessage2(msg2).session);
  }
  private sendFrame(frame: CompanionFrame): void { this.socket.send(this.session.encrypt(encodeFrame(frame))); }
  async frame(): Promise<CompanionFrame | null> {
    const ct = await this.socket.next();
    return ct === null ? null : decodeFrame(this.session.decrypt(ct));
  }
  open(method: string, params: Record<string, unknown> = {}): number {
    const streamId = this.nextStream;
    this.nextStream += 2;
    this.sendFrame({ type: FrameType.REQ, streamId, seq: 0, payload: Buffer.from(JSON.stringify({ method, params })) });
    return streamId;
  }
  credit(streamId: number, grant: number): void { this.sendFrame({ type: FrameType.CREDIT, streamId, seq: 0, payload: encodeCreditPayload(grant) }); }
  cancel(streamId: number): void { this.sendFrame({ type: FrameType.CANCEL, streamId, seq: 0, payload: Buffer.alloc(0) }); }
  async call(method: string, params: Record<string, unknown> = {}): Promise<{ ok: true; result: unknown } | { ok: false; code: string }> {
    const streamId = this.open(method, params);
    const chunks: Buffer[] = [];
    for (;;) {
      const f = await this.frame();
      if (f === null) throw new Error(`closed: ${this.socket.closeReason}`);
      if (f.streamId !== streamId) continue;
      if (f.type === FrameType.RES) return JSON.parse(f.payload.toString("utf8")) as { ok: true; result: unknown };
      if (f.type === FrameType.CHUNK) { chunks.push(f.payload); this.credit(streamId, 1); continue; }
      if (f.type === FrameType.END) return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: true; result: unknown };
      if (f.type === FrameType.ERROR) return { ok: false, code: (JSON.parse(f.payload.toString("utf8")) as { code: string }).code };
    }
  }
}

async function pairPhone(service: CompanionService, binding = "owner:session-1", direct: string | null = null): Promise<PairedPhone> {
  const started = service.startPairing("owner", binding);
  if (!started.ok) throw new Error(started.error);
  const { code, finished } = await scan(started.qr, "Test iPhone", direct);
  await until(() => service.engine.getPairingStatus(started.qr.pairSessionId, binding)?.status === "awaiting_confirm");
  expect(service.engine.getPairingStatus(started.qr.pairSessionId, binding)?.confirmCode).toBe(code);
  const confirmed = await service.engine.confirmPairing(started.qr.pairSessionId, binding);
  expect(confirmed.ok).toBe(true);
  const phone = await finished;
  if (phone === null) throw new Error("no pair.confirmed");
  return phone;
}

describe("phone access over a relay", () => {
  test("pair, reconnect, hello first, reads, big responses, refusals with codes, watch then END, remove", async () => {
    const store = testStore();
    const service = await startService(store);
    expect(service.paths()).toEqual([{ kind: "hosted", url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/v1\/connect$/) }]);
    const phone = await pairPhone(service);
    expect(getPairedDevice(store.handle, phone.deviceId)?.deviceName).toBe("Test iPhone");

    const s = await PhoneSession.connect(phone);
    // Anything before hello is refused and the session dropped.
    expect(await s.call("work.rows")).toEqual({ ok: false, code: "hello_required" });
    const again = await PhoneSession.connect(phone);
    const hello = await again.call("device.hello");
    expect(hello).toMatchObject({ ok: true, result: { account: "owner", deviceId: phone.deviceId, workspaceLabel: "Test Mac" } });
    expect(await again.call("work.rows", { view: "needs-you" })).toMatchObject({ ok: true, result: { account: "owner", params: { view: "needs-you" } } });
    expect(await again.call("task.steps", { task: "nope" })).toEqual({ ok: false, code: "not_found" });
    expect(await again.call("task.approve", { task: "t-1" })).toEqual({ ok: false, code: "route_not_allowed" });
    const big = await again.call("run.window.read", { run: "1" });
    expect(big.ok && (big.result as { big: string }).big.length).toBe(200_000);

    // Watch: chunks arrive under credit; CANCEL stops watching; a second watch ends with END from the read side.
    const w1 = again.open("run.watch.subscribe", { run: "1" });
    again.credit(w1, 3);
    let seen = 0;
    while (seen < 3) { const f = await again.frame(); if (f?.streamId === w1 && f.type === FrameType.CHUNK) seen++; }
    again.cancel(w1);
    const w2 = again.open("run.watch.subscribe", { run: "1" });
    again.credit(w2, 1);
    for (;;) { const f = await again.frame(); if (f?.streamId === w2 && f.type === FrameType.CHUNK) break; }
    watchEnds.pop()!();
    for (;;) { const f = await again.frame(); if (f?.streamId === w2 && f.type === FrameType.END) break; }

    // Removed on the Mac: the live session closes and the phone can't come back.
    await service.engine.revokeDevice(phone.deviceId);
    await until(() => again.socket.closed);
    await expect(PhoneSession.connect(phone)).rejects.toThrow();
  });

  test("a pairing answers only to the session that started it, confirms once, and a new QR retires the old", async () => {
    const store = testStore();
    const service = await startService(store);
    const started = service.startPairing("owner", "owner:A");
    if (!started.ok) throw new Error(started.error);
    const { code, finished } = await scan(started.qr);
    await until(() => service.engine.getPairingStatus(started.qr.pairSessionId, "owner:A")?.status === "awaiting_confirm");
    expect(code).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    expect(service.engine.getPairingStatus(started.qr.pairSessionId, "owner:B")).toBeNull();
    expect((await service.engine.confirmPairing(started.qr.pairSessionId, "owner:B")).ok).toBe(false);
    expect(service.engine.cancelPairing(started.qr.pairSessionId, "owner:B")).toBe(false);
    const [one, two] = await Promise.all([
      service.engine.confirmPairing(started.qr.pairSessionId, "owner:A"),
      service.engine.confirmPairing(started.qr.pairSessionId, "owner:A"),
    ]);
    expect([one.ok, two.ok].sort()).toEqual([false, true]);
    expect(await finished).not.toBeNull();
    expect(service.devices()).toHaveLength(1);

    const first = service.startPairing("owner", "owner:A");
    const second = service.startPairing("owner", "owner:A");
    if (!first.ok || !second.ok) throw new Error("start");
    expect(service.engine.getPairingStatus(first.qr.pairSessionId, "owner:A")).toBeNull(); // retired: as if it never was
    await expect(scan(first.qr)).rejects.toThrow();
  });

  test("a pairing the relay won't register is undone, not left half-made", async () => {
    const store = testStore();
    const service = await startService(store);
    const started = service.startPairing("owner", "owner:A");
    if (!started.ok) throw new Error(started.error);
    const { finished } = await scan(started.qr);
    await until(() => service.engine.getPairingStatus(started.qr.pairSessionId, "owner:A")?.status === "awaiting_confirm");
    // The relay refuses the device registration (its admin token is replaced by a wrong one for this one call).
    const original = (service as unknown as { daemonToken: () => string }).daemonToken.bind(service);
    (service as unknown as { daemonToken: () => string }).daemonToken = () => "not-a-token";
    const confirmed = await service.engine.confirmPairing(started.qr.pairSessionId, "owner:A");
    (service as unknown as { daemonToken: () => string }).daemonToken = original;
    expect(confirmed.ok).toBe(false);
    expect(await finished).toBeNull();
    expect(service.devices()).toHaveLength(0);
  });

  test("a relay that restarts empty is reconciled: the paired phone comes back; a phone removed meanwhile doesn't", async () => {
    const store = testStore();
    const service = await startService(store);
    const kept = await pairPhone(service, "owner:A");
    const removed = await pairPhone(service, "owner:A");
    // The relay forgets everything and the Mac reconnects to its replacement.
    const port = Number(new URL(hostedUrlOf(kept.qr)).port);
    await relay.close();
    await until(() => service.status().hosted.state === "unreachable");
    await service.engine.revokeDevice(removed.deviceId); // the relay is down: the DELETE can't land
    expect(service.owesReconcile).toBe(true);
    const fresh = await startReferenceRelay({ host: "127.0.0.1", port });
    cleanups.push(() => fresh.close());
    await until(() => service.status().hosted.state === "connected", 8_000);
    expect(service.owesReconcile).toBe(false);
    const s = await PhoneSession.connect(kept);
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    await expect(PhoneSession.connect(removed)).rejects.toThrow(/refused 40[13]/);
  });

  test("stopping phone access closes phone sessions and the relay", async () => {
    const store = testStore();
    const service = await startService(store);
    const phone = await pairPhone(service);
    const s = await PhoneSession.connect(phone);
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    await service.stop();
    await until(() => s.socket.closed);
    expect(service.status()).toEqual({ running: false, direct: { state: "off" }, hosted: { state: "off" } });
    await expect(PhoneSession.connect(phone)).rejects.toThrow();
  });
});

describe("what reaches a phone after access changes (review round 2)", () => {
  test("a response waiting on credit is refused, not delivered, once the account's access changes", async () => {
    const store = testStore();
    const service = await startService(store);
    const s = await PhoneSession.connect(await pairPhone(service));
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    // ~1 MB: more chunks than the opening credit, so the tail waits for the phone's CREDIT.
    const id = s.open("run.window.read", { run: "1", size: "huge" });
    let chunks = 0;
    for (;;) { const f = await s.frame(); if (f?.streamId === id && f.type === FrameType.CHUNK) { chunks++; if (chunks === 16) break; } }
    accessNow = "projects:a"; // narrowed on the web while the tail is queued
    s.credit(id, 4);
    const next = await s.frame();
    expect(next?.streamId).toBe(id);
    expect(next?.type).toBe(FrameType.ERROR);
    expect(JSON.parse(next!.payload.toString("utf8"))).toMatchObject({ code: "not_found" });
  });

  test("a watch that loses access is ended as refused and drops what it buffered; a finished watch drains before END", async () => {
    const store = testStore();
    const service = await startService(store);
    const s = await PhoneSession.connect(await pairPhone(service));
    expect(await s.call("device.hello")).toMatchObject({ ok: true });

    // Finished: 20 records against 16 credits, then END only after the last 4 go out.
    const w = s.open("run.watch.subscribe", { run: "controlled" });
    await until(() => controlled.emit !== null);
    for (let n = 0; n < 20; n++) controlled.emit!(n);
    controlled.end!();
    const seen: number[] = [];
    while (seen.length < 16) { const f = await s.frame(); if (f?.streamId === w && f.type === FrameType.CHUNK) seen.push((JSON.parse(f.payload.toString()) as { n: number }).n); }
    s.credit(w, 4);
    for (;;) {
      const f = await s.frame();
      if (f?.streamId !== w) continue;
      if (f.type === FrameType.CHUNK) { seen.push((JSON.parse(f.payload.toString()) as { n: number }).n); continue; }
      expect(f.type).toBe(FrameType.END);
      break;
    }
    expect(seen).toEqual([...Array(20).keys()]);

    // Refused: buffered records past the credit are never sent.
    controlled.emit = null;
    const w2 = s.open("run.watch.subscribe", { run: "controlled" });
    await until(() => controlled.emit !== null);
    for (let n = 0; n < 20; n++) controlled.emit!(n);
    let got = 0;
    while (got < 16) { const f = await s.frame(); if (f?.streamId === w2 && f.type === FrameType.CHUNK) got++; }
    accessNow = "projects:none";
    s.credit(w2, 8);
    const f = await s.frame();
    expect(f?.streamId).toBe(w2);
    expect(f?.type).toBe(FrameType.ERROR);
  });

  test("a credential change (password, rotation) retires the paired phone; it must pair again", async () => {
    const store = testStore();
    const service = await startService(store);
    const phone = await pairPhone(service);
    const s = await PhoneSession.connect(phone);
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = ?").run("owner");
    // The live session is dropped at its next frame, and a reconnect is refused at the handshake.
    await s.call("work.rows").catch(() => null);
    await until(() => s.socket.closed);
    await expect(PhoneSession.connect(phone)).rejects.toThrow();
  });

  test("a pairing started under one credential generation can't be confirmed under the next", async () => {
    const store = testStore();
    const service = await startService(store);
    const generation = store.accountOf("owner")!.generation;
    const started = service.startPairing("owner", "owner:A", generation);
    if (!started.ok) throw new Error(started.error);
    const { finished } = await scan(started.qr);
    await until(() => service.engine.getPairingStatus(started.qr.pairSessionId, "owner:A")?.status === "awaiting_confirm");
    store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = ?").run("owner");
    expect((await service.engine.confirmPairing(started.qr.pairSessionId, "owner:A")).ok).toBe(false);
    expect(await finished).toBeNull();
    expect(service.devices()).toHaveLength(0);
  });
});

describe("the reference relay survives malformed requests", () => {
  test("a bad escape, a bad Host header and a bad upgrade get refusals, and the relay keeps answering", async () => {
    const store = testStore();
    const service = await startService(store);
    const base = new URL(relay.wsUrl);
    const { request } = await import("node:http");
    const raw = (method: string, path: string, headers: Record<string, string> = {}) => new Promise<number>(resolve => {
      const req = request({ host: base.hostname, port: Number(base.port), method, path, headers }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", () => resolve(-1));
      req.end();
    });
    const machine = service.engine.hostKeys.machineId;
    expect(await raw("DELETE", `/v1/machines/${machine}/devices/%E0`)).toBe(401); // unauthenticated: refused before decoding
    expect(await raw("GET", "/v1/health", { host: "[::not-a-host" })).toBe(200);
    expect(await raw("GET", "/v1/connect", { host: "%%%", connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" })).toBeGreaterThanOrEqual(400);
    expect(await raw("GET", "/v1/health")).toBe(200);
    expect(service.status().hosted.state).toBe("connected");
  });
});

/** A service with both paths: the direct listener on loopback (it reports a LAN address to phones) and a relay. */
async function startBoth(store: Store, opts: { peerAddress?: string } = {}): Promise<{ service: CompanionService; direct: string }> {
  accessNow = "projects:a,b";
  relay = await startReferenceRelay({ host: "127.0.0.1", port: 0 });
  const running = relay;
  cleanups.push(() => running.close());
  const service = new CompanionService({
    store, reads, direct: { port: 0, host: "127.0.0.1" }, hosted: relay.wsUrl, backoff: { first: 50, max: 200 },
    lanAddresses: () => ["192.168.1.20"], tailnetIpv4: async () => "100.101.102.103",
    ...(opts.peerAddress === undefined ? {} : { directPeerAddressOf: () => opts.peerAddress }),
  });
  cleanups.push(() => service.stop());
  await service.start();
  await until(() => service.status().hosted.state === "connected");
  const state = service.status().direct;
  if (state.state !== "listening") throw new Error("direct path not listening");
  return { service, direct: `ws://127.0.0.1:${state.port}/v1/direct` };
}

const raw = (url: string, method: string, path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>(resolve => {
  const base = new URL(url);
  void import("node:http").then(({ request }) => {
    const req = request({ host: base.hostname, port: Number(base.port), method, path, headers }, res => {
      let body = "";
      res.on("data", chunk => { body += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", () => resolve({ status: -1, body: "" }));
    req.end();
  });
});

describe("the direct path: a phone on this Mac's network, no relay", () => {
  test("paths list direct addresses first and the relay last; pair and reconnect directly; hello refreshes paths", async () => {
    const store = testStore();
    const { service, direct } = await startBoth(store);
    const port = new URL(direct).port;
    expect(service.paths()).toEqual([
      { kind: "direct", url: `ws://192.168.1.20:${port}/v1/direct` },
      { kind: "direct", url: `ws://100.101.102.103:${port}/v1/direct` },
      { kind: "hosted", url: relay.wsUrl },
    ]);
    const health = await raw(direct, "GET", "/v1/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true, machineId: service.engine.hostKeys.machineId });

    const phone = await pairPhone(service, "owner:A", direct);
    expect(phone.qr.v).toBe(2);
    const s = await PhoneSession.connect(phone, direct);
    const hello = await s.call("device.hello");
    expect(hello).toMatchObject({ ok: true, result: { deviceId: phone.deviceId, paths: service.paths() } });
    expect(await s.call("work.rows")).toMatchObject({ ok: true });
    // The relay learns of a directly paired phone on its own: the same phone can then come in from anywhere.
    await until(() => !service.owesReconcile);
    const away = await PhoneSession.connect(phone);
    expect(await away.call("device.hello")).toMatchObject({ ok: true });
  });

  test("the listener takes no token, no other route, and nothing from outside a private network", async () => {
    const store = testStore();
    const { direct } = await startBoth(store);
    const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
    expect((await raw(direct, "GET", "/v1/direct?role=device&id=dev_x", { ...upgrade, authorization: "Bearer x" })).status).toBe(404);
    expect((await raw(direct, "GET", "/v1/direct?role=daemon&id=x", upgrade)).status).toBe(404);
    expect((await raw(direct, "GET", "/v1/connect?role=device&id=dev_x", upgrade)).status).toBe(404);
    expect((await raw(direct, "POST", "/v1/machines/register")).status).toBe(404);
    // A device id nobody paired: the socket opens, the handshake is refused.
    const stranger = await PhoneSocket.open(`${direct}?role=device&id=dev_unknown`, null);
    stranger.send(Buffer.alloc(96, 1));
    expect(await stranger.next()).toBeNull();

    const outside = testStore();
    const { direct: publicView } = await startBoth(outside, { peerAddress: "203.0.113.9" });
    expect((await raw(publicView, "GET", "/v1/health")).status).toBe(-1); // dropped before any HTTP
  });

  test("one session per phone across paths; the same connection number on both paths stays apart; a relay outage leaves direct up", async () => {
    const store = testStore();
    const { service, direct } = await startBoth(store);
    const a = await pairPhone(service, "owner:A");
    const b = await pairPhone(service, "owner:B", direct);
    await until(() => !service.owesReconcile);
    // Phone A over the relay and phone B directly: each is its link's connection 1.
    const overRelay = await PhoneSession.connect(a);
    const overDirect = await PhoneSession.connect(b, direct);
    expect(await overRelay.call("device.hello")).toMatchObject({ ok: true, result: { deviceId: a.deviceId } });
    expect(await overDirect.call("device.hello")).toMatchObject({ ok: true, result: { deviceId: b.deviceId } });
    // B comes in over the relay too: its newer session wins, the older one is closed.
    const bAway = await PhoneSession.connect(b);
    expect(await bAway.call("device.hello")).toMatchObject({ ok: true });
    await until(() => overDirect.socket.closed);
    expect(overDirect.socket.closeReason).toBe("superseded");
    // The relay goes away: A's session ends with it; a direct session doesn't notice.
    const bHome = await PhoneSession.connect(b, direct);
    expect(await bHome.call("device.hello")).toMatchObject({ ok: true });
    await relay.close();
    await until(() => overRelay.socket.closed && service.status().hosted.state === "unreachable");
    expect(await bHome.call("work.rows")).toMatchObject({ ok: true });
    // The relay stays listed while it's down: a phone saving this list keeps its way back from elsewhere.
    expect(service.paths().map(path => path.kind)).toEqual(["direct", "direct", "hosted"]);
  });

  test("a removal the relay didn't take is retried while connected, not only on reconnect", async () => {
    const store = testStore();
    const { service } = await startBoth(store);
    const phone = await pairPhone(service, "owner:A");
    const realFetch = globalThis.fetch;
    let failed = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.method === "DELETE" && failed === 0) { failed += 1; throw new TypeError("fetch failed"); }
      return realFetch(input, init);
    }) as typeof fetch;
    cleanups.push(() => { globalThis.fetch = realFetch; });
    await service.engine.revokeDevice(phone.deviceId);
    expect(failed).toBe(1);
    expect(service.owesReconcile).toBe(true);
    await until(() => !service.owesReconcile, 8_000);
    expect(service.status().hosted.state).toBe("connected");
    await expect(PhoneSession.connect(phone)).rejects.toThrow(/refused 40[13]/);
  });

  test("with no relay (direct only), the QR carries no relay token and pairing still works", async () => {
    const store = testStore();
    accessNow = "projects:a,b";
    const service = new CompanionService({ store, reads, direct: { port: 0, host: "127.0.0.1" }, hosted: null, lanAddresses: () => ["10.0.0.5"], tailnetIpv4: async () => null });
    cleanups.push(() => service.stop());
    await service.start();
    const state = service.status().direct;
    if (state.state !== "listening") throw new Error("not listening");
    const direct = `ws://127.0.0.1:${state.port}/v1/direct`;
    const started = service.startPairing("owner", "owner:A");
    if (!started.ok) throw new Error(started.error);
    expect(started.qr.paths).toEqual([{ kind: "direct", url: `ws://10.0.0.5:${state.port}/v1/direct` }]);
    expect(started.qr.pairConnToken).toBeUndefined();
    service.engine.cancelPairing(started.qr.pairSessionId, "owner:A");
    const phone = await pairPhone(service, "owner:A", direct);
    const s = await PhoneSession.connect(phone, direct);
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    expect(service.owesReconcile).toBe(false);
  });
});

test("strangers holding unproven sockets for a phone's id can't lock the phone out", async () => {
  const store = testStore();
  const { service, direct } = await startBoth(store);
  const phone = await pairPhone(service, "owner:A", direct);
  // Two sockets that name the phone's id and never send a handshake (the id is in the URL on the network).
  const squatters = await Promise.all([1, 2].map(() => PhoneSocket.open(`${direct}?role=device&id=${phone.deviceId}`, null)));
  const s = await PhoneSession.connect(phone, direct);
  expect(await s.call("device.hello")).toMatchObject({ ok: true });
  await until(() => squatters.some(one => one.closed));
});

test("the direct listener drops a socket that never finishes its request headers", async () => {
  const store = testStore();
  const { direct } = await startBoth(store);
  const { connect } = await import("node:net");
  const url = new URL(direct);
  const socket = connect(Number(url.port), url.hostname);
  let closed = false;
  socket.on("close", () => { closed = true; });
  socket.on("error", () => {});
  socket.write("GET /v1/health HTTP/1.1\r\nHost: x\r\n"); // never finishes the headers
  await until(() => closed, 8_000);
});

test("a hosted-only change can't turn phone access back on, and an approval doesn't follow a changed relay", async () => {
  const { createPhoneAccess } = await import("./access.js");
  const store = testStore();
  relay = await startReferenceRelay({ host: "127.0.0.1", port: 0 });
  const running = relay;
  cleanups.push(() => running.close());
  const env = { TOOLROLL_RELAY_URL: relay.wsUrl, TOOLROLL_PHONE_RELAY_PORT: "4389" };
  const access = createPhoneAccess({ store, reads, env });
  cleanups.push(() => access.stop());
  const now = new Date();
  expect(await access.change({ act: "on", hosted: true }, "owner", now)).toBe("ok");
  expect(access.hostedEnabled()).toBe(true);
  // Turned off, then a hosted-only form that was posted earlier arrives: refused, access stays off.
  const off = access.change({ act: "off" }, "owner", now);
  const stale = access.change({ act: "hosted-on" }, "owner", now);
  expect(await off).toBe("ok");
  expect(await stale).toBe("not_on");
  expect(access.enabled()).toBe(false);
  expect(access.service()).toBeNull();
  // Approved for one relay; the configuration then names another: the new one isn't used until approved.
  expect(await access.change({ act: "on", hosted: true }, "owner", now)).toBe("ok");
  await access.stop();
  const other = await startReferenceRelay({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => other.close());
  const moved = createPhoneAccess({ store, reads, env: { ...env, TOOLROLL_RELAY_URL: other.wsUrl } });
  cleanups.push(() => moved.stop());
  await moved.resume();
  expect(moved.hostedApprovalStale()).toBe(true);
  expect(moved.hostedEnabled()).toBe(false);
  expect(moved.service()?.status().hosted).toEqual({ state: "off" });
  expect(moved.service()?.paths().some(path => path.kind === "hosted")).toBe(false);
});


describe("limits a paired phone can't get around (final review)", () => {
  test("responses waiting on a phone that doesn't take them count against its budget; an oversized ping drops it", async () => {
    const store = testStore();
    const { service, direct } = await startBoth(store);
    const phone = await pairPhone(service, "owner:A", direct);
    const s = await PhoneSession.connect(phone, direct);
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    // A ~1 MB response is more chunks than the phone's first credit covers, so it's held; another read on top of it
    // would pass the 1 MiB session budget and is refused rather than buffered.
    s.open("run.window.read", { run: "1", size: "huge" });
    const big = s.open("run.window.read", { run: "1" });
    let refused: string | null = null;
    for (let i = 0; i < 200 && refused === null; i++) {
      const f = await s.frame();
      if (f === null) break;
      if (f.streamId === big && f.type === FrameType.ERROR) refused = (JSON.parse(f.payload.toString("utf8")) as { code: string }).code;
    }
    expect(refused).toBe("memory_limit");

    const t = await PhoneSession.connect(phone, direct);
    expect(await t.call("device.hello")).toMatchObject({ ok: true });
    t.socket.send(t.session.encrypt(encodeFrame({ type: FrameType.PING, streamId: 0, seq: 1, payload: Buffer.alloc(1_000) })));
    await until(() => t.socket.closed);
    expect(t.socket.closeReason).toBe("ping_too_large");
  });
});

describe("phone records over time (final review)", () => {
  test("any change to the account's generation retires its phones: the record says so, Settings and the relay stop listing them", async () => {
    const store = testStore();
    const { service, direct } = await startBoth(store);
    const phone = await pairPhone(service, "owner:A", direct);
    expect(livePairedDevices(store).map(d => d.deviceId)).toEqual([phone.deviceId]);
    store.revokeDerivedAuthority("owner", "credential-rotation", new Date());
    expect(getPairedDevice(store.handle, phone.deviceId)?.revokedAt).not.toBeNull();
    expect(livePairedDevices(store)).toEqual([]);
    expect(service.engine.admittedDevices()).toEqual([]);
    await expect(PhoneSession.connect(phone, direct)).rejects.toThrow();
  });

  test("a restore retires this Mac's companion keys too: the restored copy gets its own machine id", async () => {
    const store = testStore();
    const { service } = await startBoth(store);
    const before = service.engine.hostKeys.machineId;
    await service.stop();
    retireCompanionOnRestore(store.handle);
    const again = new CompanionService({ store, reads, direct: null, hosted: null, lanAddresses: () => [], tailnetIpv4: async () => null });
    expect(again.engine.hostKeys.machineId).not.toBe(before);
  });

  test("a late scan of a code that already paired is refused and leaves the pairing as paired", async () => {
    const store = testStore();
    const { service, direct } = await startBoth(store);
    const started = service.startPairing("owner", "owner:A");
    if (!started.ok) throw new Error(started.error);
    const { code, finished } = await scan(started.qr, "Test iPhone", direct);
    await until(() => service.engine.getPairingStatus(started.qr.pairSessionId, "owner:A")?.status === "awaiting_confirm");
    expect(service.engine.getPairingStatus(started.qr.pairSessionId, "owner:A")?.confirmCode).toBe(code);
    expect((await service.engine.confirmPairing(started.qr.pairSessionId, "owner:A")).ok).toBe(true);
    expect(await finished).not.toBeNull();
    const late = await PhoneSocket.open(`${direct}?role=pair&id=${started.qr.pairSessionId}`, null);
    expect(await late.next()).toBeNull();
    expect(service.engine.getPairingStatus(started.qr.pairSessionId, "owner:A")?.status).toBe("confirmed");
  });

  test("the direct listener refuses an upgrade from a web page (it carries an Origin)", async () => {
    const store = testStore();
    const { direct } = await startBoth(store);
    const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
    expect((await raw(direct, "GET", "/v1/direct?role=device&id=dev_x", { ...upgrade, origin: "http://evil.example" })).status).toBe(404);
  });

  test("on a workspace that never turned phone access on, listing phones creates nothing", () => {
    const store = testStore();
    expect(livePairedDevices(store)).toEqual([]);
    expect(store.handle.prepare("SELECT 1 AS hit FROM sqlite_master WHERE name = 'companion_paired_device'").get()).toBeUndefined();
  });
});

