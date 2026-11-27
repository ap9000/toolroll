/**
 * Engine mechanics (protocol §1.2, §3.7, review L3–L6, L10): downstream pacing keeps the wire in order, a phone's
 * ERROR ends its stream, a reused connection number never closes the new connection, the relay's PEER_OPEN is checked
 * and capped, a watch's synchronous records are delivered, and pairings expire, fail and are forgotten on time.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { openStore, type Store } from "../store.js";
import { addApprover } from "../scope.js";
import { FrameType, TokenBucket } from "./framing.js";
import { decodeRelayEnvelope, encodeRelayEnvelope, RelayOp } from "./relay-auth.js";
import { CompanionDaemonEngine, MAX_PEERS_PER_RELAY_LINK, PAIRING_TERMINAL_KEEP_MS, PAIRING_TTL_MS, type CompanionReadHandlers, type PeerLink } from "./daemon.js";
import { EngineWire, PairingPhone, PhoneSession, WIRE, type PairedPhone } from "../../test/companion-phone.js";

const dirs: string[] = [];
const stores: Store[] = [];
const engines: CompanionDaemonEngine[] = [];
afterEach(() => {
  vi.useRealTimers();
  // Engines first: a running engine's sweep reads its store, so it stops before the store closes.
  while (engines.length > 0) engines.pop()!.handleRelayDisconnected();
  while (stores.length > 0) stores.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const BINDING = "owner:s";
const FRAME = 13 + 60_000;

function engineOf(handlers: Partial<CompanionReadHandlers> = {}, extra: Partial<ConstructorParameters<typeof CompanionDaemonEngine>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-companion-daemon-"));
  dirs.push(dir);
  const store = openStore(join(dir, "toolroll.db"));
  stores.push(store);
  if (!addApprover(store, "owner", new Date()).ok) throw new Error("approver");
  const engine = new CompanionDaemonEngine({
    store,
    paths: () => [{ kind: "direct", url: "ws://192.168.1.20:4199/v1/direct" }],
    handlers: {
      deviceHello: p => ({ deviceId: p.deviceId }),
      workRows: () => ({ rows: [] }),
      taskSteps: () => ({ steps: [] }),
      taskDiff: () => ({ files: [] }),
      taskApprovalRead: () => ({ terms: [] }),
      runWindowRead: params => ({ big: "x".repeat(200_000), params }),
      ...handlers,
    },
    ...extra,
  });
  engines.push(engine);
  const start = () => {
    const started = engine.startPairing("owner", BINDING, store.accountOf("owner")!.generation);
    if (!started.ok) throw new Error(started.error);
    return started.qr;
  };
  const pair = async (): Promise<PairedPhone> => {
    const qr = start();
    const phone = await PairingPhone.scan(qr, EngineWire.open(engine, "pair", qr.pairSessionId));
    await phone.ready();
    await engine.confirmPairing(qr.pairSessionId, BINDING);
    const outcome = await phone.answer(1);
    if (outcome === null || !outcome.ok) throw new Error("no outcome");
    const paired = phone.paired(outcome.result);
    await phone.done(paired.deviceId);
    await phone.answer(3);
    return paired;
  };
  return { store, engine, start, pair };
}

describe("downstream pacing (§3.7)", () => {
  test("data frames wait for the buckets in one ordered queue; control frames go out at once; the wire stays in encryption order", async () => {
    vi.useFakeTimers();
    // One full frame per second per connection; the link's aggregate is roomy.
    const { engine, pair } = engineOf({}, { pacingPerConnection: { ratePerMin: FRAME * 60, burst: FRAME } });
    const phone = await pair();
    const link: Partial<PeerLink> = { pacing: new TokenBucket(100 * FRAME * 60, 100 * FRAME, Date.now()) };
    const s = await PhoneSession.connect(phone, EngineWire.open(engine, "device", phone.deviceId, link));
    await s.open("device.hello");
    expect((await s.frame())?.type).toBe(FrameType.RES); // small, inside the burst
    vi.advanceTimersByTime(2_000); // refill
    const a = await s.open("run.window.read", { run: "1" }); // ~200 KB: 4 chunks + END
    const b = await s.open("work.rows"); // queued behind a
    await s.sendFrame({ type: FrameType.PING, streamId: 0, seq: 9, payload: Buffer.from("k") });
    const seen: string[] = [];
    const drain = async () => { for (let f = await s.frame(); f !== null; f = await s.frame()) seen.push(`${f.streamId}:${f.type}`); };
    await drain();
    for (let n = 0; n < 8; n++) { vi.advanceTimersByTime(1_000); await drain(); }
    const C = FrameType.CHUNK, E = FrameType.END, R = FrameType.RES, P = FrameType.PONG;
    expect(seen).toEqual([`${a}:${C}`, `0:${P}`, `${a}:${C}`, `${a}:${C}`, `${a}:${C}`, `${a}:${E}`, `${b}:${R}`]);
  });

  test("a direct link isn't paced", async () => {
    const { engine, pair } = engineOf({}, { pacingPerConnection: { ratePerMin: 60, burst: 1 } });
    const phone = await pair();
    const s = await PhoneSession.connect(phone, EngineWire.open(engine, "device", phone.deviceId));
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    expect(await s.call("run.window.read", { run: "1" })).toMatchObject({ ok: true });
  });
});

describe("streams and links (L3–L6)", () => {
  test("a phone's ERROR ends its stream and releases what it was assembling (L3)", async () => {
    const { engine, pair } = engineOf();
    const phone = await pair();
    const s = await PhoneSession.connect(phone, EngineWire.open(engine, "device", phone.deviceId));
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    await s.sendFrame({ type: FrameType.REQ_CHUNK, streamId: 3, seq: 0, payload: Buffer.alloc(10_000, 0x20) });
    await s.sendFrame({ type: FrameType.ERROR, streamId: 3, seq: 0, payload: Buffer.from(JSON.stringify({ code: "cancelled", message: "" })) });
    // The assembly is gone: its END is a stray now, refused on that stream without ending the session.
    await s.sendFrame({ type: FrameType.END, streamId: 3, seq: 1, payload: Buffer.alloc(0) });
    const answer = await s.frame();
    expect(answer).toMatchObject({ type: FrameType.ERROR, streamId: 3 });
    expect(JSON.parse(answer!.payload.toString("utf8"))).toMatchObject({ code: "protocol_error" });
    expect(s.wire.closed).toBe(false);
  });

  test("a reused connection number replaces the old one locally and never closes the new one (L4)", () => {
    const { engine } = engineOf();
    const closes: string[] = [];
    const link: PeerLink = { id: "relay-x", send: () => {}, close: (connId, reason) => closes.push(`${connId}:${reason}`) };
    engine.openPeer(link, 5, "device", "dev_aaaaaaaaaaaaaaaa");
    engine.openPeer(link, 5, "device", "dev_bbbbbbbbbbbbbbbb");
    expect(closes).toEqual([]);
  });

  test("PEER_OPEN is checked like any input and a relay link carries at most 8 phones (L5)", async () => {
    const out: { op: number; connId: number; payload: Buffer }[] = [];
    const { engine } = engineOf({}, { sendToRelay: raw => out.push(decodeRelayEnvelope(raw)) });
    const open = (connId: number, meta: unknown) => engine.handleRelayEnvelope(encodeRelayEnvelope({ op: RelayOp.PEER_OPEN, connId, payload: Buffer.from(typeof meta === "string" ? meta : JSON.stringify(meta)) }));
    const closed = (connId: number) => out.filter(e => e.op === RelayOp.PEER_CLOSE && e.connId === connId).map(e => (JSON.parse(e.payload.toString("utf8")) as { reason: string }).reason);
    await open(1, { role: "daemon", id: "dev_a" });
    await open(2, { role: "device", id: "../etc" });
    await open(3, "{not json");
    await open(4, { role: "device", id: "x".repeat(129) });
    expect([1, 2, 3, 4].map(closed)).toEqual([["invalid_peer"], ["invalid_peer"], ["invalid_peer"], ["invalid_peer"]]);
    for (let n = 0; n < MAX_PEERS_PER_RELAY_LINK; n++) await open(10 + n, { role: "device", id: `dev_${n}` });
    expect(out.filter(e => e.op === RelayOp.PEER_CLOSE && e.connId >= 10)).toEqual([]);
    await open(99, { role: "device", id: "dev_ninth" });
    expect(closed(99)).toEqual(["too_many_peers"]);
  });

  test("records a watch emits (and its end) inside the subscribe call are delivered (L6)", async () => {
    const { engine, pair } = engineOf({
      runWatchSubscribe: (_p, _params, emit, end) => {
        emit(Buffer.from(JSON.stringify({ k: "say", n: 1 })));
        end?.();
        return { ok: true, unsubscribe: () => {} };
      },
    });
    const phone = await pair();
    const s = await PhoneSession.connect(phone, EngineWire.open(engine, "device", phone.deviceId));
    expect(await s.call("device.hello")).toMatchObject({ ok: true });
    const w = await s.open("run.watch.subscribe", { run: "1" });
    expect(await s.frame()).toMatchObject({ type: FrameType.CHUNK, streamId: w });
    expect(await s.frame()).toMatchObject({ type: FrameType.END, streamId: w });
  });
});

describe("pairing deadlines and lifetime (§1.2, L10)", () => {
  test("a socket past message 2 that never sends pair.ready is closed after 10 s; the pairing is untouched", async () => {
    vi.useFakeTimers();
    const { engine, start } = engineOf();
    const qr = start();
    const phone = await PairingPhone.scan(qr, EngineWire.open(engine, "pair", qr.pairSessionId));
    vi.advanceTimersByTime(WIRE.pairing.readyDeadlineMs - 1);
    expect(phone.wire.closed).toBe(false);
    vi.advanceTimersByTime(2);
    expect(phone.wire.closed).toBe(true);
    expect(phone.wire.closeReason).toBe("pair_ready_timeout");
    expect(engine.pairingView(qr.pairSessionId, BINDING)?.status).toBe("awaiting_ready");
  });

  test("a code that expires while the phone waits: the phone is told, the view says expired, and a minute later it's gone", async () => {
    const clock = { now: Date.parse("2026-11-27T10:00:00.000Z") };
    const { engine, start } = engineOf({}, { nowMs: () => clock.now });
    const qr = start();
    const phone = await PairingPhone.scan(qr, EngineWire.open(engine, "pair", qr.pairSessionId));
    await phone.ready();
    clock.now += PAIRING_TTL_MS + 1;
    engine.sweepDeadlines();
    expect(await phone.answer(1)).toEqual({ ok: false, code: "pairing_expired" });
    expect(engine.pairingView(qr.pairSessionId, BINDING)).toMatchObject({ status: "expired", confirmCode: null });
    clock.now += PAIRING_TERMINAL_KEEP_MS + 1;
    engine.sweepDeadlines();
    expect(engine.pairingView(qr.pairSessionId, BINDING)).toBeNull();
  });

  test("the attached phone leaving before the owner confirms fails the pairing (it can't be confirmed any more)", async () => {
    const { engine, start } = engineOf();
    const qr = start();
    const phone = await PairingPhone.scan(qr, EngineWire.open(engine, "pair", qr.pairSessionId));
    await phone.ready();
    phone.wire.close();
    expect(engine.pairingView(qr.pairSessionId, BINDING)).toMatchObject({ status: "failed", error: "The iPhone disconnected. Pair again." });
    expect((await engine.confirmPairing(qr.pairSessionId, BINDING)).ok).toBe(false);
  });

  test("a new QR for the same session cancels the previous pairing and tells its phone", async () => {
    const { engine, start } = engineOf();
    const qr = start();
    const phone = await PairingPhone.scan(qr, EngineWire.open(engine, "pair", qr.pairSessionId));
    await phone.ready();
    start();
    expect(await phone.answer(1)).toEqual({ ok: false, code: "pairing_cancelled" });
    expect(engine.pairingView(qr.pairSessionId, BINDING)).toBeNull();
  });
});

describe("the deadline sweep never takes the process down", () => {
  test("a sweep whose store was closed stops itself instead of throwing from its timer", async () => {
    const { store, engine, pair } = engineOf();
    const phone = await pair();
    // A connected phone: the sweep re-reads its standing from the store every pass.
    const s = await PhoneSession.connect(phone, EngineWire.open(engine, "device", phone.deviceId));
    await s.open("device.hello");
    await s.frame();
    vi.useFakeTimers();
    engine.handleRelayDisconnected(); // stop the real-timer sweep, then arm one under fake timers
    const again = await PhoneSession.connect(phone, EngineWire.open(engine, "device", phone.deviceId));
    await again.open("device.hello");
    await again.frame();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    // Before the fix the timer's callback threw "database is not open" — an uncaught exception in production.
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
  });
});
