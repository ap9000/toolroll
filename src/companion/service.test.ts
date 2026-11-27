/**
 * Phone access end to end over a real relay (the reference relay on loopback) and the direct path: a TypeScript phone
 * (test/companion-phone.ts: the same Noise, framing and pairing wire the iOS app speaks) pairs, is confirmed on "the
 * Mac", reconnects, reads, watches, and is removed. The reads are stand-ins here (reads.ts is proven against a console in
 * reads.test.ts); this proves the transport, pairing, relay reconciliation and liveness, and teardown.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { addApprover } from "../scope.js";
import { openStore, type Store } from "../store.js";
import type { CompanionReadHandlers, PairingQrPayload } from "./daemon.js";
import { startReferenceRelay, type RunningReferenceRelay } from "./relay-server.js";
import { encodeFrame, FrameType } from "./framing.js";
import { decodeRelayEnvelope, parseRelayTokenUnverified, RelayOp } from "./relay-auth.js";
import { CompanionService, describeRelayCode } from "./service.js";
import { bonjourCommand, startBonjour } from "./bonjour.js";
import { getPairedDevice, livePairedDevices, retireCompanionOnRestore } from "./store.js";
import { hostedUrlOf, PairingPhone, PhoneSession, PhoneSocket, WIRE, type PairedPhone } from "../../test/companion-phone.js";

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

const generationOf = (store: Store): number => store.accountOf("owner")!.generation;

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

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 10)); // guard: bound poll interval while waiting on the fact check() names
  }
}

const storeOf = (service: CompanionService): Store => (service as unknown as { store: Store }).store;

/** A pairing socket on the hosted relay (with the QR's token) or the direct listener (no token). */
const pairWire = (qr: PairingQrPayload, direct: string | null): Promise<PhoneSocket> =>
  direct === null ? PhoneSocket.open(hostedUrlOf(qr), qr.pairConnToken!) : PhoneSocket.open(`${direct}?role=pair&id=${qr.pairSessionId}`, null);

/** Steps 2–4 on the phone: scan, handshake, pair.ready (the Mac then shows the code). */
async function scan(qr: PairingQrPayload, direct: string | null = null, deviceName = "Test iPhone"): Promise<PairingPhone> {
  const phone = await PairingPhone.scan(qr, await pairWire(qr, direct));
  await phone.ready(deviceName);
  return phone;
}

/** The whole pairing: QR, scan, ready, the owner confirms the code, the outcome, pair.done. */
async function pairPhone(service: CompanionService, binding = "owner:session-1", direct: string | null = null): Promise<PairedPhone> {
  const started = service.startPairing("owner", binding, generationOf(storeOf(service)));
  if (!started.ok) throw new Error(started.error);
  const phone = await scan(started.qr, direct);
  await until(() => service.engine.pairingView(started.qr.pairSessionId, binding)?.status === "awaiting_confirm");
  expect(service.engine.pairingView(started.qr.pairSessionId, binding)?.confirmCode).toBe(phone.code);
  expect((await service.engine.confirmPairing(started.qr.pairSessionId, binding)).ok).toBe(true);
  const outcome = await phone.answer(1);
  if (outcome === null || !outcome.ok) throw new Error(`no outcome: ${outcome === null ? "closed" : outcome.code}`);
  const paired = phone.paired(outcome.result);
  await phone.done(paired.deviceId);
  expect(await phone.answer(3)).toEqual({ ok: true, result: { ok: true } });
  return paired;
}

/** A paired phone's session over the hosted relay (its own device token) or the direct listener. */
async function connectPhone(phone: PairedPhone, direct: string | null = null): Promise<PhoneSession> {
  const wire = direct === null
    ? await PhoneSocket.open(hostedUrlOf(phone.qr), PhoneSession.token(phone))
    : await PhoneSocket.open(`${direct}?role=device&id=${phone.deviceId}`, null);
  return PhoneSession.connect(phone, wire);
}

describe("phone access over a relay", () => {
  test("pair, reconnect, hello first, reads, big responses, refusals with codes, watch then END, remove", async () => {
    const store = testStore();
    const service = await startService(store);
    expect(service.paths()).toEqual([{ kind: "hosted", url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/v1\/connect$/) }]);
    const phone = await pairPhone(service);
    expect(getPairedDevice(store.handle, phone.deviceId)?.deviceName).toBe("Test iPhone");

    const s = await connectPhone(phone);
    // Anything before hello is refused and the session dropped.
    expect(await s.call("work.rows")).toEqual({ ok: false, code: "hello_required" });
    const again = await connectPhone(phone);
    const hello = await again.call("device.hello");
    expect(hello).toMatchObject({ ok: true, result: { account: "owner", deviceId: phone.deviceId, workspaceLabel: "Test Mac", consoleUrl: null } });
    expect(await again.call("work.rows", { view: "needs-you" })).toMatchObject({ ok: true, result: { account: "owner", params: { view: "needs-you" } } });
    expect(await again.call("task.steps", { task: "nope" })).toEqual({ ok: false, code: "not_found" });
    expect(await again.call("task.approve", { task: "t-1" })).toEqual({ ok: false, code: "route_not_allowed" });
    const big = await again.call("run.window.read", { run: "1" });
    expect(big.ok && (big.result as { big: string }).big.length).toBe(200_000);

    // Watch: chunks arrive under credit; CANCEL stops watching; a second watch ends with END from the read side.
    const w1 = await again.open("run.watch.subscribe", { run: "1" });
    await again.credit(w1, 3);
    let seen = 0;
    while (seen < 3) { const f = await again.frame(); if (f?.streamId === w1 && f.type === FrameType.CHUNK) seen++; }
    await again.cancel(w1);
    const w2 = await again.open("run.watch.subscribe", { run: "1" });
    await again.credit(w2, 1);
    for (;;) { const f = await again.frame(); if (f?.streamId === w2 && f.type === FrameType.CHUNK) break; }
    watchEnds.pop()!();
    for (;;) { const f = await again.frame(); if (f?.streamId === w2 && f.type === FrameType.END) break; }

    // Removed on the Mac: the call returns at once; the live session gets its stream-0 refusal; a reconnect is refused.
    expect(service.removePhone(phone.deviceId, "someone-else")).toBe(false);
    expect(service.removePhone(phone.deviceId, "owner")).toBe(true);
    for (;;) {
      const f = await again.frame();
      if (f === null) throw new Error("closed without a refusal");
      if (f.streamId === 0 && f.type === FrameType.ERROR) { expect(JSON.parse(f.payload.toString("utf8"))).toMatchObject({ code: "device_revoked" }); break; }
    }
    await until(() => again.wire.closed);
    await expect(connectPhone(phone)).rejects.toThrow();
  });

  test("tokens name the relay they're for, and an admission call's method and path", async () => {
    const store = testStore();
    relay = await startReferenceRelay({ host: "127.0.0.1", port: 0 });
    const running = relay;
    cleanups.push(() => running.close());
    const seen: { method: string; path: string; claims: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
      if (auth !== undefined) seen.push({ method: String(init?.method), path: new URL(String(input)).pathname, claims: parseRelayTokenUnverified(auth.slice(7))!.claims as unknown as Record<string, unknown> });
      return realFetch(input, init);
    }) as typeof fetch;
    cleanups.push(() => { globalThis.fetch = realFetch; });
    const service = new CompanionService({ store, reads, direct: null, hosted: relay.wsUrl, backoff: { first: 50, max: 200 }, lanAddresses: () => [], tailnetIpv4: async () => null });
    cleanups.push(() => service.stop());
    await service.start();
    await until(() => service.status().hosted.state === "connected");
    const host = new URL(relay.wsUrl).host;
    expect(seen.length).toBeGreaterThan(0);
    for (const one of seen) expect(one.claims).toMatchObject({ role: "daemon", aud: host, htm: one.method, htu: one.path });
    const started = service.startPairing("owner", "owner:A", generationOf(store));
    if (!started.ok) throw new Error(started.error);
    const pairClaims = parseRelayTokenUnverified(started.qr.pairConnToken!)!.claims;
    expect(pairClaims).toMatchObject({ role: "pair", aud: host, pairSessionId: started.qr.pairSessionId });
    expect(pairClaims.htm).toBeUndefined();
    expect(started.qr.expiresAtMs).toBe(started.expiresAtMs);
  });

  test("a pairing answers only to the session that started it, confirms once, and a new QR retires the old", async () => {
    const store = testStore();
    const service = await startService(store);
    const started = service.startPairing("owner", "owner:A", generationOf(store));
    if (!started.ok) throw new Error(started.error);
    const phone = await scan(started.qr);
    await until(() => service.engine.pairingView(started.qr.pairSessionId, "owner:A")?.status === "awaiting_confirm");
    expect(phone.code).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    expect(service.engine.pairingView(started.qr.pairSessionId, "owner:B")).toBeNull();
    expect((await service.engine.confirmPairing(started.qr.pairSessionId, "owner:B")).ok).toBe(false);
    expect(service.engine.cancelPairing(started.qr.pairSessionId, "owner:B")).toBe(false);
    const [one, two] = await Promise.all([
      service.engine.confirmPairing(started.qr.pairSessionId, "owner:A"),
      service.engine.confirmPairing(started.qr.pairSessionId, "owner:A"),
    ]);
    expect([one.ok, two.ok].sort()).toEqual([false, true]);
    expect(await phone.answer(1)).toMatchObject({ ok: true });

    const first = service.startPairing("owner", "owner:A", generationOf(store));
    const second = service.startPairing("owner", "owner:A", generationOf(store));
    if (!first.ok || !second.ok) throw new Error("start");
    expect(service.engine.pairingView(first.qr.pairSessionId, "owner:A")).toBeNull(); // retired: as if it never was
    await expect(scan(first.qr)).rejects.toThrow();
  });

  test("a pairing the relay won't admit is undone, not left half-made", async () => {
    const store = testStore();
    const service = await startService(store);
    const started = service.startPairing("owner", "owner:A", generationOf(store));
    if (!started.ok) throw new Error(started.error);
    const phone = await scan(started.qr);
    await until(() => service.engine.pairingView(started.qr.pairSessionId, "owner:A")?.status === "awaiting_confirm");
    // The relay refuses the device admission (its admin token is replaced by a wrong one for this one call).
    const original = (service as unknown as { daemonToken: () => string }).daemonToken.bind(service);
    (service as unknown as { daemonToken: () => string }).daemonToken = () => "not-a-token";
    const confirmed = await service.engine.confirmPairing(started.qr.pairSessionId, "owner:A");
    (service as unknown as { daemonToken: () => string }).daemonToken = original;
    expect(confirmed.ok).toBe(false);
    expect(await phone.answer(1)).toEqual({ ok: false, code: "pairing_failed" });
    expect(service.devices()).toHaveLength(0);
    expect(livePairedDevices(store, { includePending: true })).toHaveLength(0);
  });

  test("a relay that restarts empty is reconciled: the paired phone comes back; a phone removed meanwhile doesn't", async () => {
    const store = testStore();
    const service = await startService(store);
    const kept = await pairPhone(service, "owner:A");
    const removed = await pairPhone(service, "owner:A");
    // The relay forgets everything and the Mac reconnects to its replacement (registering only once the PUT says so).
    const port = Number(new URL(hostedUrlOf(kept.qr)).port);
    await relay.close();
    await until(() => service.status().hosted.state === "unreachable");
    expect(service.removePhone(removed.deviceId, "owner")).toBe(true); // the relay is down: the DELETE can't land
    await until(() => service.owesReconcile);
    const fresh = await startReferenceRelay({ host: "127.0.0.1", port });
    cleanups.push(() => fresh.close());
    await until(() => service.status().hosted.state === "connected", 8_000);
    expect(service.owesReconcile).toBe(false);
    const s = await connectPhone(kept);
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    await expect(connectPhone(removed)).rejects.toThrow(/refused 40[134]/);
  });

  test("stopping phone access closes phone sessions and the relay", async () => {
    const store = testStore();
    const service = await startService(store);
    const phone = await pairPhone(service);
    const s = await connectPhone(phone);
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    await service.stop();
    await until(() => s.wire.closed);
    expect(service.status()).toMatchObject({ running: false, direct: { state: "off", port: null, error: null, addresses: [] }, hosted: { state: "off", superseded: false } });
    await expect(connectPhone(phone)).rejects.toThrow();
  });
});

describe("what reaches a phone after access changes (review round 2)", () => {
  test("a response waiting on credit is refused, not delivered, once the account's access changes", async () => {
    const store = testStore();
    const service = await startService(store);
    const s = await connectPhone(await pairPhone(service));
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    // ~1 MB: more chunks than the opening credit, so the tail waits for the phone's CREDIT.
    const id = await s.open("run.window.read", { run: "1", size: "huge" });
    let chunks = 0;
    for (;;) { const f = await s.frame(); if (f?.streamId === id && f.type === FrameType.CHUNK) { chunks++; if (chunks === 16) break; } }
    accessNow = "projects:a"; // narrowed on the web while the tail is queued
    await s.credit(id, 4);
    const next = await s.frame();
    expect(next?.streamId).toBe(id);
    expect(next?.type).toBe(FrameType.ERROR);
    expect(JSON.parse(next!.payload.toString("utf8"))).toMatchObject({ code: "not_found" });
  });

  test("a watch that loses access is ended as refused and drops what it buffered; a finished watch drains before END", async () => {
    const store = testStore();
    const service = await startService(store);
    const s = await connectPhone(await pairPhone(service));
    expect(await s.call("device.hello")).toMatchObject({ ok: true });

    // Finished: 20 records against 16 credits, then END only after the last 4 go out.
    const w = await s.open("run.watch.subscribe", { run: "controlled" });
    await until(() => controlled.emit !== null);
    for (let n = 0; n < 20; n++) controlled.emit!(n);
    controlled.end!();
    const seen: number[] = [];
    while (seen.length < 16) { const f = await s.frame(); if (f?.streamId === w && f.type === FrameType.CHUNK) seen.push((JSON.parse(f.payload.toString()) as { n: number }).n); }
    await s.credit(w, 4);
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
    const w2 = await s.open("run.watch.subscribe", { run: "controlled" });
    await until(() => controlled.emit !== null);
    for (let n = 0; n < 20; n++) controlled.emit!(n);
    let got = 0;
    while (got < 16) { const f = await s.frame(); if (f?.streamId === w2 && f.type === FrameType.CHUNK) got++; }
    accessNow = "projects:none";
    await s.credit(w2, 8);
    const f = await s.frame();
    expect(f?.streamId).toBe(w2);
    expect(f?.type).toBe(FrameType.ERROR);
  });

  test("a credential change (password, rotation) retires the paired phone: the live session is told, a reconnect is refused", async () => {
    const store = testStore();
    const service = await startService(store);
    const phone = await pairPhone(service);
    const s = await connectPhone(phone);
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = ?").run("owner");
    for (;;) {
      const f = await s.frame(5_000);
      if (f === null) throw new Error("closed without a refusal");
      if (f.streamId === 0 && f.type === FrameType.ERROR) { expect(JSON.parse(f.payload.toString("utf8"))).toMatchObject({ code: "account_revoked" }); break; }
    }
    await until(() => s.wire.closed);
    expect(s.wire.closeCode).toBe(1000); // the relay closes the phone leg; the stream-0 ERROR is what the phone trusts
    const refused = await PhoneSession.handshake(phone, await PhoneSocket.open(hostedUrlOf(phone.qr), PhoneSession.token(phone))).catch(() => null);
    // The relay still admits the phone until the reconcile lands; then the Mac's own answer is an authenticated refusal.
    if (refused !== null) expect(refused.status).toMatchObject({ status: "refused", reason: "account_revoked" });
  });

  test("a pairing started under one credential generation can't be confirmed under the next", async () => {
    const store = testStore();
    const service = await startService(store);
    const started = service.startPairing("owner", "owner:A", generationOf(store));
    if (!started.ok) throw new Error(started.error);
    const phone = await scan(started.qr);
    await until(() => service.engine.pairingView(started.qr.pairSessionId, "owner:A")?.status === "awaiting_confirm");
    store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = ?").run("owner");
    expect((await service.engine.confirmPairing(started.qr.pairSessionId, "owner:A")).ok).toBe(false);
    expect(await phone.answer(1)).toEqual({ ok: false, code: "pairing_failed" });
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
    expect(await raw("DELETE", `/v1/machines/${machine}/devices/%E0`)).toBeGreaterThanOrEqual(400); // unauthenticated: refused before decoding
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
    consoleUrl: () => "http://127.0.0.1:4180",
    ...(opts.peerAddress === undefined ? {} : { directPeerAddressOf: () => opts.peerAddress }),
  });
  cleanups.push(() => service.stop());
  await service.start();
  await until(() => service.status().hosted.state === "connected");
  const state = service.status().direct;
  if (state.state !== "listening" || state.port === null) throw new Error("direct path not listening");
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
  test("paths list direct addresses first and the relay last; pair and reconnect directly; hello refreshes paths and names the console", async () => {
    const store = testStore();
    const { service, direct } = await startBoth(store);
    const port = new URL(direct).port;
    expect(service.paths()).toEqual([
      { kind: "direct", url: `ws://192.168.1.20:${port}/v1/direct` },
      { kind: "direct", url: `ws://100.101.102.103:${port}/v1/direct` },
      { kind: "hosted", url: relay.wsUrl },
    ]);
    expect(service.status().direct).toMatchObject({
      state: "listening", port: Number(port), error: null, tailscale: "found",
      addresses: [{ address: "192.168.1.20", kind: "lan" }, { address: "100.101.102.103", kind: "tailnet" }],
    });
    const health = await raw(direct, "GET", "/v1/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true, machineId: service.engine.hostKeys.machineId });

    const phone = await pairPhone(service, "owner:A", direct);
    expect(phone.qr.v).toBe(2);
    const s = await connectPhone(phone, direct);
    const hello = await s.call("device.hello");
    expect(hello).toMatchObject({ ok: true, result: { deviceId: phone.deviceId, paths: service.paths(), consoleUrl: "http://127.0.0.1:4180" } });
    expect(await s.call("work.rows")).toMatchObject({ ok: true });
    // Paired directly with the relay connected: the relay admitted the phone before it was told (M8), so the same phone
    // can come in from anywhere at once.
    const away = await connectPhone(phone);
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
    await stranger.send(Buffer.alloc(96, 1));
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
    // Phone A over the relay and phone B directly: each is its link's connection 1.
    const overRelay = await connectPhone(a);
    const overDirect = await connectPhone(b, direct);
    expect(await overRelay.call("device.hello")).toMatchObject({ ok: true, result: { deviceId: a.deviceId } });
    expect(await overDirect.call("device.hello")).toMatchObject({ ok: true, result: { deviceId: b.deviceId } });
    // B comes in over the relay too: its newer session wins, the older one is closed.
    const bAway = await connectPhone(b);
    expect(await bAway.call("device.hello")).toMatchObject({ ok: true });
    await until(() => overDirect.wire.closed);
    expect(overDirect.wire.closeReason).toBe("superseded");
    // The relay goes away: A's session ends with it; a direct session doesn't notice.
    const bHome = await connectPhone(b, direct);
    expect(await bHome.call("device.hello")).toMatchObject({ ok: true });
    await relay.close();
    await until(() => overRelay.wire.closed && service.status().hosted.state === "unreachable");
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
    expect(service.removePhone(phone.deviceId, "owner")).toBe(true);
    await until(() => failed === 1 && service.owesReconcile);
    await until(() => !service.owesReconcile, 8_000);
    expect(service.status().hosted.state).toBe("connected");
    await expect(connectPhone(phone)).rejects.toThrow(/refused 40[134]/);
  });

  test("with no relay (direct only), the QR carries no relay token and pairing still works", async () => {
    const store = testStore();
    accessNow = "projects:a,b";
    const service = new CompanionService({ store, reads, direct: { port: 0, host: "127.0.0.1" }, hosted: null, lanAddresses: () => ["10.0.0.5"], tailnetIpv4: async () => null });
    cleanups.push(() => service.stop());
    await service.start();
    const state = service.status().direct;
    if (state.state !== "listening") throw new Error("not listening");
    expect(state.tailscale).toBe("not_found");
    const direct = `ws://127.0.0.1:${state.port}/v1/direct`;
    const started = service.startPairing("owner", "owner:A", generationOf(store));
    if (!started.ok) throw new Error(started.error);
    expect(started.qr.paths).toEqual([{ kind: "direct", url: `ws://10.0.0.5:${state.port}/v1/direct` }]);
    expect(started.qr.pairConnToken).toBeUndefined();
    service.engine.cancelPairing(started.qr.pairSessionId, "owner:A");
    const phone = await pairPhone(service, "owner:A", direct);
    const s = await connectPhone(phone, direct);
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    expect(service.owesReconcile).toBe(false);
  });

  test("a taken port falls back through the next ones and the bound port is kept; all taken says so", async () => {
    const holders = [createServer(), createServer()];
    const ports: number[] = [];
    for (const holder of holders) {
      await new Promise<void>(resolve => holder.listen(0, "127.0.0.1", () => resolve()));
      ports.push((holder.address() as { port: number }).port);
      cleanups.push(() => new Promise<void>(resolve => holder.close(() => resolve())));
    }
    const store = testStore();
    let bound: number | null = null;
    const service = new CompanionService({ store, reads, hosted: null, lanAddresses: () => ["10.0.0.5"], tailnetIpv4: async () => null,
      direct: { port: ports[0]!, host: "127.0.0.1", fallbackPorts: [ports[1]!, 0], onBound: port => { bound = port; } } });
    cleanups.push(() => service.stop());
    await service.start();
    const state = service.status().direct;
    expect(state.state).toBe("listening");
    expect(bound).toBe(state.port);
    expect(ports).not.toContain(state.port);

    const busy = new CompanionService({ store, reads, hosted: null, lanAddresses: () => [], tailnetIpv4: async () => null,
      direct: { port: ports[0]!, host: "127.0.0.1", fallbackPorts: [ports[1]!] } });
    cleanups.push(() => busy.stop());
    await busy.start();
    expect(busy.status().direct).toMatchObject({ state: "failed", port: null, error: `Ports ${ports[0]} and ${ports[1]} on this computer are all in use. Set TOOLROLL_PHONE_PORT to a free port and restart Toolroll.` });
  });
});

test("strangers holding unproven sockets for a phone's id can't lock the phone out", async () => {
  const store = testStore();
  const { service, direct } = await startBoth(store);
  const phone = await pairPhone(service, "owner:A", direct);
  // Two sockets that name the phone's id and never send a handshake (the id is in the URL on the network).
  const squatters = await Promise.all([1, 2].map(() => PhoneSocket.open(`${direct}?role=device&id=${phone.deviceId}`, null)));
  const s = await connectPhone(phone, direct);
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
  // The direct listener's port is kept for the next start (the phone has it saved).
  const direct = access.service()?.status().direct;
  if (direct?.state === "listening") expect(store.handle.prepare("SELECT direct_port FROM companion_access").get()?.["direct_port"]).toBe(direct.port);
  // Turning off asks the relay to forget this machine (best effort), with a token for exactly that call.
  const realFetch = globalThis.fetch;
  const deletes: { path: string; claims: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
    if (init?.method === "DELETE" && auth !== undefined) deletes.push({ path: new URL(String(input)).pathname, claims: parseRelayTokenUnverified(auth.slice(7))!.claims as unknown as Record<string, unknown> });
    return realFetch(input, init);
  }) as typeof fetch;
  cleanups.push(() => { globalThis.fetch = realFetch; });
  const machineId = access.service()!.engine.hostKeys.machineId;
  // Turned off, then a hosted-only form that was posted earlier arrives: refused, access stays off.
  const off = access.change({ act: "off" }, "owner", now);
  const stale = access.change({ act: "hosted-on" }, "owner", now);
  expect(await off).toBe("ok");
  expect(await stale).toBe("not_on");
  expect(access.enabled()).toBe(false);
  expect(access.service()).toBeNull();
  expect(deletes).toEqual([{ path: `/v1/machines/${machineId}`, claims: expect.objectContaining({ role: "daemon", htm: "DELETE", htu: `/v1/machines/${machineId}` }) }]);
  globalThis.fetch = realFetch;
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
  expect(moved.service()?.status().hosted).toEqual({ state: "off", superseded: false });
  expect(moved.service()?.paths().some(path => path.kind === "hosted")).toBe(false);
});

describe("limits a paired phone can't get around (final review)", () => {
  test("responses waiting on a phone that doesn't take them count against its budget; an oversized ping drops it", async () => {
    const store = testStore();
    const { service, direct } = await startBoth(store);
    const phone = await pairPhone(service, "owner:A", direct);
    const s = await connectPhone(phone, direct);
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    // A ~1 MB response is more chunks than the phone's first credit covers, so it's held; another read on top of it
    // would pass the 1 MiB session budget and is refused rather than buffered.
    await s.open("run.window.read", { run: "1", size: "huge" });
    const big = await s.open("run.window.read", { run: "1" });
    let refused: string | null = null;
    for (let i = 0; i < 200 && refused === null; i++) {
      const f = await s.frame();
      if (f === null) break;
      if (f.streamId === big && f.type === FrameType.ERROR) refused = (JSON.parse(f.payload.toString("utf8")) as { code: string }).code;
    }
    expect(refused).toBe("memory_limit");

    const t = await connectPhone(phone, direct);
    expect(await t.call("device.hello")).toMatchObject({ ok: true });
    await t.wire.send(t.session.encrypt(encodeFrame({ type: FrameType.PING, streamId: 0, seq: 1, payload: Buffer.alloc(1_000) })));
    await until(() => t.wire.closed);
    expect(t.wire.closeReason).toBe("ping_too_large");
  });
});

describe("phone records over time (final review)", () => {
  test("any change to the account's generation retires its phones: the record says so, Settings and the relay stop listing them", async () => {
    const store = testStore();
    const { service, direct } = await startBoth(store);
    const phone = await pairPhone(service, "owner:A", direct);
    expect(livePairedDevices(store).map(d => d.deviceId)).toEqual([phone.deviceId]);
    store.revokeDerivedAuthority("owner", "credential-rotation", new Date());
    expect(getPairedDevice(store.handle, phone.deviceId)).toMatchObject({ revokedReason: "password_changed" });
    expect(livePairedDevices(store)).toEqual([]);
    expect(service.engine.admittedDevices()).toEqual([]);
    const refused = await PhoneSession.handshake(phone, await PhoneSocket.open(`${direct}?role=device&id=${phone.deviceId}`, null));
    expect(refused.status).toMatchObject({ status: "refused", reason: "account_revoked" });
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
    const started = service.startPairing("owner", "owner:A", generationOf(store));
    if (!started.ok) throw new Error(started.error);
    const phone = await scan(started.qr, direct);
    await until(() => service.engine.pairingView(started.qr.pairSessionId, "owner:A")?.status === "awaiting_confirm");
    expect((await service.engine.confirmPairing(started.qr.pairSessionId, "owner:A")).ok).toBe(true);
    const outcome = await phone.answer(1);
    if (outcome === null || !outcome.ok) throw new Error("no outcome");
    await phone.done(String(outcome.result["deviceId"]));
    expect(await phone.answer(3)).toMatchObject({ ok: true });
    const late = await PhoneSocket.open(`${direct}?role=pair&id=${started.qr.pairSessionId}`, null);
    expect(await late.next()).toBeNull();
    expect(service.engine.pairingView(started.qr.pairSessionId, "owner:A")?.status).toBe("paired");
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
    expect(store.handle.prepare("SELECT count(*) AS n FROM companion_host_keys").get()?.["n"]).toBe(0);
  });
});

/**
 * A relay stand-in for the daemon leg only: admission calls answer as configured, and the WebSocket answers heartbeats
 * unless told not to. Enough to prove the Mac's own behaviour (liveness, register-on-unknown, 4409 backoff).
 */
async function stubRelay(opts: { ackHeartbeats?: () => boolean; knows?: () => boolean } = {}) {
  const calls: string[] = [];
  const daemons: ServerSocket[] = [];
  let heartbeats = 0;
  const server = createServer((req: IncomingMessage, res) => {
    calls.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/challenge") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ challenge: "c".repeat(43) })); return; }
      if (req.url === "/v1/machines/register") { registered = true; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ machineId })); return; }
      if (req.method === "PUT" && !(registered || (opts.knows?.() ?? true))) {
        res.writeHead(404, { "content-type": "application/json", [WIRE.relay.errorHeader]: "machine_unknown" });
        res.end(JSON.stringify({ error: "machine_unknown" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  let registered = false;
  let machineId = "";
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    daemons.push(ws);
    ws.on("message", (raw: Buffer) => {
      const env = decodeEnvelopeLoose(raw);
      if (env?.op === RelayOp.HEARTBEAT) {
        heartbeats += 1;
        expect(env.payload.length).toBe(8);
        if (opts.ackHeartbeats?.() ?? true) ws.send(Buffer.concat([Buffer.from([RelayOp.HEARTBEAT_ACK, 0, 0, 0, 0]), env.payload]));
      }
    });
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(() => new Promise<void>(resolve => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); server.close(() => resolve()); }));
  return {
    url, calls, daemons,
    get heartbeats() { return heartbeats; },
    setMachine: (id: string) => { machineId = id; },
  };
}

/** The daemon leg's envelope, read without the relay-auth decoder (which predates the heartbeat opcodes). */
function decodeEnvelopeLoose(raw: Buffer): { op: number; connId: number; payload: Buffer } | null {
  if (raw.length < 5) return null;
  if (raw[0] === RelayOp.HEARTBEAT) return { op: raw[0], connId: raw.readUInt32BE(1), payload: Buffer.from(raw.subarray(5)) };
  try { return decodeRelayEnvelope(raw); } catch { return null; }
}

describe("the hosted relay link: liveness, registration, superseded (protocol §3.5–3.7)", () => {
  test("heartbeats every interval; a relay that stops answering them is torn down and reconnected", async () => {
    let ack = true;
    const stub = await stubRelay({ ackHeartbeats: () => ack });
    const store = testStore();
    const service = new CompanionService({ store, reads, direct: null, hosted: stub.url, backoff: { first: 20, max: 40 }, heartbeat: { intervalMs: 40, timeoutMs: 120 },
      lanAddresses: () => [], tailnetIpv4: async () => null });
    stub.setMachine(service.engine.hostKeys.machineId);
    cleanups.push(() => service.stop());
    await service.start();
    await until(() => service.status().hosted.state === "connected" && stub.heartbeats >= 2);
    expect(stub.daemons).toHaveLength(1);
    ack = false; // a half-open connection: the socket stays up, nothing comes back
    await until(() => stub.daemons.length >= 2, 8_000);
    ack = true;
    await until(() => service.status().hosted.state === "connected");
  });

  test("registers only when the relay says it doesn't know this machine", async () => {
    const known = await stubRelay({ knows: () => true });
    const store = testStore();
    const service = new CompanionService({ store, reads, direct: null, hosted: known.url, lanAddresses: () => [], tailnetIpv4: async () => null });
    known.setMachine(service.engine.hostKeys.machineId);
    cleanups.push(() => service.stop());
    await service.start();
    await until(() => service.status().hosted.state === "connected");
    expect(known.calls.some(call => call.includes("/v1/machines/register"))).toBe(false);
    expect(known.calls[0]).toBe(`PUT /v1/machines/${service.engine.hostKeys.machineId}/devices`);

    const unknown = await stubRelay({ knows: () => false });
    const other = new CompanionService({ store, reads, direct: null, hosted: unknown.url, lanAddresses: () => [], tailnetIpv4: async () => null });
    unknown.setMachine(other.engine.hostKeys.machineId);
    cleanups.push(() => other.stop());
    await other.start();
    await until(() => other.status().hosted.state === "connected");
    expect(unknown.calls.slice(0, 4)).toEqual([
      `PUT /v1/machines/${other.engine.hostKeys.machineId}/devices`, "POST /v1/challenge", "POST /v1/machines/register", `PUT /v1/machines/${other.engine.hostKeys.machineId}/devices`,
    ]);
  });

  test("replaced by another daemon with these keys (4409): it backs off and Settings says why", async () => {
    const stub = await stubRelay();
    const store = testStore();
    const service = new CompanionService({ store, reads, direct: null, hosted: stub.url, supersededBackoff: { first: 60_000, max: 600_000 }, lanAddresses: () => [], tailnetIpv4: async () => null });
    stub.setMachine(service.engine.hostKeys.machineId);
    cleanups.push(() => service.stop());
    await service.start();
    await until(() => service.status().hosted.state === "connected");
    stub.daemons[0]!.close(WIRE.relay.closeCodes["superseded"], "superseded");
    await until(() => service.status().hosted.superseded);
    const state = service.status().hosted;
    expect(state).toMatchObject({ state: "unreachable", superseded: true, error: "Another Toolroll with this workspace's keys is connected to the relay." });
    if (state.state !== "unreachable") throw new Error("unreachable");
    expect(Date.parse(state.retryAt) - Date.now()).toBeGreaterThan(50_000);
    expect(stub.daemons).toHaveLength(1);
  });

  test("relay refusal codes read as plain words", () => {
    expect(describeRelayCode("token_expired")).toBe("this Mac's clock looks wrong — check Date & Time");
    expect(describeRelayCode("rate_limited")).toBe("it asked Toolroll to slow down");
    expect(describeRelayCode("<script>")).toBe("an unexpected answer");
  });
});

describe("Bonjour advertisement", () => {
  test("advertises with an explicit argv (no shell) and the machine id in TXT; a missing advertiser never fails", async () => {
    const machineId = "abcdefghijklmnopqrstuvwxyz";
    expect(bonjourCommand("darwin", 4199, machineId)).toEqual(["dns-sd", "-R", "Toolroll abcdef", WIRE.mac.bonjourService, "local", "4199", `${WIRE.mac.bonjourMachineIdTxtKey}=${machineId}`]);
    expect(bonjourCommand("linux", 4199, machineId)).toEqual(["avahi-publish-service", "Toolroll abcdef", "_toolroll._tcp", "4199", `m=${machineId}`]);
    expect(bonjourCommand("win32", 4199, machineId)).toBeNull();
    expect(bonjourCommand("darwin", 4199, "not a machine id; rm -rf")).toBeNull();
    const { EventEmitter } = await import("node:events");
    const spawned: { file: string; args: readonly string[]; shell: unknown }[] = [];
    let killed = 0;
    const advert = startBonjour({ port: 4199, machineId, platform: "darwin", spawn: (file, args, options) => {
      spawned.push({ file, args, shell: options.shell });
      return Object.assign(new EventEmitter(), { exitCode: null, kill: () => { killed += 1; return true; }, unref: () => {} }) as never;
    } });
    expect(spawned).toEqual([{ file: "dns-sd", args: ["-R", "Toolroll abcdef", "_toolroll._tcp", "local", "4199", `m=${machineId}`], shell: false }]);
    advert.stop();
    expect(killed).toBe(1);
    const logs: string[] = [];
    const missing = startBonjour({ port: 4199, machineId, platform: "linux", log: line => logs.push(line), spawn: () => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, kill: () => true, unref: () => {} });
      setImmediate(() => child.emit("error", Object.assign(new Error("spawn avahi-publish-service ENOENT"), { code: "ENOENT" })));
      return child as never;
    } });
    await until(() => logs.length > 0);
    expect(logs[0]).toContain("ENOENT");
    missing.stop();
  });
});
