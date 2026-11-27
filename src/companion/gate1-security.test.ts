/**
 * Gate 1 security suite for the companion engine (`docs/plans/companion-app/threat-model-and-routes.md` §5, protocol
 * §1–§2). Engine-level: the phone (test/companion-phone.ts) talks to the engine through a test link, every step awaited
 * in order, with an injected clock — no sockets, no timing.
 *
 * 1. Pairing: key confirmation (`pair.ready`) before any code; an open or a message 1 never aborts or advances past
 *    awaiting_ready; contest rules in every state; `pair.done` bound to the pairing's own device; activation by hello.
 * 2. Replay and eviction: a replayed message 1 is dropped; a stranger can't evict a handshake past message 1.
 * 3. Refusals: a retired phone gets an authenticated, padded `refused`; live sessions get a stream-0 ERROR and 4403.
 * 4. Loopback isolation and the allowlist: `requestFromThisComputer === false`; non-allowlisted routes (push.register
 *    included) refused.
 * 5. ADR 0001 restore wipe; slow-client credit; CANCEL stops watching only.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "../store.js";
import { addApprover } from "../scope.js";
import { retireRestoredAuthority } from "../restore-retirement.js";
import { encodeCreditPayload, encodeFrame, FrameType, INITIAL_STREAM_CREDIT } from "./framing.js";
import { CompanionDaemonEngine, MSG2_PLAINTEXT_BYTES, type CompanionReadHandlers, type PairedDevicePrincipal } from "./daemon.js";
import { getPairedDevice, listPairedDevices, MAX_PHONES_PER_MAC, savePendingDevice } from "./store.js";
import { EngineWire, PairingPhone, PhoneSession, WIRE, type PairedPhone } from "../../test/companion-phone.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-27T10:00:00.000Z");
const BINDING = "owner:session-1";

function createTestStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-companion-gate1-"));
  dirs.push(dir);
  const store = openStore(join(dir, "toolroll.db"));
  stores.push(store);
  if (!addApprover(store, "owner", new Date(T0)).ok) throw new Error("failed to add approver");
  return store;
}

interface World {
  store: Store;
  engine: CompanionDaemonEngine;
  clock: { now: number };
  principals: PairedDevicePrincipal[];
  registered: string[];
  revoked: string[];
  /** Holds the relay admission open while set (a test resolves it). */
  admission: { gate: Promise<void> | null };
  generation: () => number;
}

function world(handlers: Partial<CompanionReadHandlers> = {}): World {
  const store = createTestStore();
  const clock = { now: T0 };
  const principals: PairedDevicePrincipal[] = [];
  const registered: string[] = [];
  const revoked: string[] = [];
  const admission: { gate: Promise<void> | null } = { gate: null };
  const engine = new CompanionDaemonEngine({
    store,
    nowMs: () => clock.now,
    paths: () => [{ kind: "direct", url: "ws://192.168.1.20:4199/v1/direct" }],
    onDeviceRegistered: async deviceId => { registered.push(deviceId); if (admission.gate !== null) await admission.gate; },
    onDeviceRevoked: deviceId => { revoked.push(deviceId); },
    handlers: {
      deviceHello: p => { principals.push(p); return { version: 1, workspaceId: p.workspaceId, account: p.accountName, deviceId: p.deviceId }; },
      workRows: p => { principals.push(p); return { rows: [{ id: "t-1", title: "Build companion" }] }; },
      taskSteps: () => ({ steps: [] }),
      taskDiff: () => ({ files: [] }),
      taskApprovalRead: () => ({ terms: [] }),
      runWindowRead: () => ({ lines: ["ok"] }),
      ...handlers,
    },
  });
  return { store, engine, clock, principals, registered, revoked, admission, generation: () => store.accountOf("owner")!.generation };
}

function start(w: World, binding = BINDING) {
  const started = w.engine.startPairing("owner", binding, w.generation());
  if (!started.ok) throw new Error(started.error);
  return started.qr;
}

/** A pairing socket through message 2 and `pair.ready` (attached when it's the first). */
async function readyPhone(w: World, qr: ReturnType<typeof start>, deviceName = "Test iPhone"): Promise<PairingPhone> {
  const phone = await PairingPhone.scan(qr, EngineWire.open(w.engine, "pair", qr.pairSessionId));
  await phone.ready(deviceName);
  return phone;
}

/** A whole pairing on the engine: ready, confirm, outcome, done. */
async function pairPhone(w: World, binding = BINDING): Promise<PairedPhone> {
  const qr = start(w, binding);
  const phone = await readyPhone(w, qr);
  expect((await w.engine.confirmPairing(qr.pairSessionId, binding)).ok).toBe(true);
  const outcome = await phone.answer(1);
  if (outcome === null || !outcome.ok) throw new Error("no outcome");
  const paired = phone.paired(outcome.result);
  await phone.done(paired.deviceId);
  expect(await phone.answer(3)).toEqual({ ok: true, result: { ok: true } });
  return paired;
}

async function connect(w: World, phone: PairedPhone): Promise<PhoneSession> {
  const s = await PhoneSession.connect(phone, EngineWire.open(w.engine, "device", phone.deviceId));
  await s.open("device.hello");
  const hello = await s.frame();
  expect(hello?.type).toBe(FrameType.RES);
  return s;
}

const errorCode = (payload: Buffer): string => (JSON.parse(payload.toString("utf8")) as { code: string }).code;

describe("1. pairing: key confirmation, contest rules, activation", () => {
  test("a bare open and a message 1 never abort a pairing or show a code; pair.ready attaches the first proven phone", async () => {
    const w = world();
    const qr = start(w);
    // A bare open (anyone who saw the pairing id on the network) and a stranger's message 1: no code, no abort.
    EngineWire.open(w.engine, "pair", qr.pairSessionId);
    const stranger = await PairingPhone.scan(qr, EngineWire.open(w.engine, "pair", qr.pairSessionId));
    expect(stranger.msg2.length).toBe(MSG2_PLAINTEXT_BYTES);
    expect(JSON.parse(stranger.msg2.toString("utf8"))).toMatchObject({ protocolVersion: 1, status: "awaiting_ready" });
    expect(w.engine.pairingView(qr.pairSessionId, BINDING)).toMatchObject({ status: "awaiting_ready", confirmCode: null });

    // The owner's phone proves the PSK: it is attached and the code is the one its handshake derives.
    const phone = await readyPhone(w, qr, "\u202eWork\x07 iPhone");
    const view = w.engine.pairingView(qr.pairSessionId, BINDING);
    expect(view).toMatchObject({ status: "awaiting_confirm", confirmCode: phone.code, deviceName: "Work iPhone" });
    expect(view?.confirmCode).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    // A socket that passed message 2 but sends garbage instead of pair.ready is dropped alone.
    await stranger.wire.send(Buffer.alloc(40, 7));
    expect(stranger.wire.closed).toBe(true);
    expect(w.engine.pairingView(qr.pairSessionId, BINDING)?.status).toBe("awaiting_confirm");
    // Keepalive while waiting for the owner: PING answered with PONG.
    await phone.ping(7);
    expect((await phone.frame())).toMatchObject({ type: FrameType.PONG, seq: 7 });

    expect((await w.engine.confirmPairing(qr.pairSessionId, BINDING)).ok).toBe(true);
    expect(w.engine.pairingView(qr.pairSessionId, BINDING)?.status).toBe("finishing");
    const outcome = await phone.answer(1);
    if (outcome === null || !outcome.ok) throw new Error("no outcome");
    expect(Object.keys(outcome.result).sort()).toEqual(["deviceId", "pskEntropy", "recoveryGeneration"]);
    const pending = getPairedDevice(w.store.handle, String(outcome.result["deviceId"]));
    expect(pending).toMatchObject({ activatedAt: null, revokedAt: null, deviceName: "Work iPhone" });
    expect(w.registered).toEqual([outcome.result["deviceId"]]);

    await phone.done(String(outcome.result["deviceId"]));
    expect(await phone.answer(3)).toEqual({ ok: true, result: { ok: true } });
    expect(phone.wire.closeCode).toBe(1000);
    expect(getPairedDevice(w.store.handle, String(outcome.result["deviceId"]))?.activatedAt).not.toBeNull();
    expect(w.engine.pairingView(qr.pairSessionId, BINDING)?.status).toBe("paired");
  });

  test("contested while comparing codes: both phones are told, nothing is saved", async () => {
    const w = world();
    const qr = start(w);
    const owner = await readyPhone(w, qr);
    const other = await readyPhone(w, qr);
    expect(await other.answer(1)).toEqual({ ok: false, code: "pairing_contested" });
    expect(await owner.answer(1)).toEqual({ ok: false, code: "pairing_contested" });
    expect(w.engine.pairingView(qr.pairSessionId, BINDING)?.status).toBe("contested");
    expect((await w.engine.confirmPairing(qr.pairSessionId, BINDING)).ok).toBe(false);
    expect(listPairedDevices(w.store.handle)).toHaveLength(0);
  });

  test("contested while confirming: the confirm's recheck deletes the pending row and tells the relays", async () => {
    const w = world();
    const qr = start(w);
    const owner = await readyPhone(w, qr);
    // A second holder of the code is past message 2 already (message 1 is refused once confirming starts).
    const other = await PairingPhone.scan(qr, EngineWire.open(w.engine, "pair", qr.pairSessionId));
    let release!: () => void;
    w.admission.gate = new Promise(resolve => { release = resolve; });
    const confirming = w.engine.confirmPairing(qr.pairSessionId, BINDING);
    expect(w.engine.pairingView(qr.pairSessionId, BINDING)?.status).toBe("confirming");
    // No new scan while confirming: the PSK is gone.
    await expect(PairingPhone.scan(qr, EngineWire.open(w.engine, "pair", qr.pairSessionId))).rejects.toThrow(/no message 2/);
    await other.ready();
    expect(await other.answer(1)).toEqual({ ok: false, code: "pairing_contested" });
    release();
    const confirmed = await confirming;
    expect(confirmed).toEqual({ ok: false, error: "Another device used this code. Pair again." });
    expect(await owner.answer(1)).toEqual({ ok: false, code: "pairing_contested" });
    expect(listPairedDevices(w.store.handle)).toHaveLength(0);
    await new Promise(resolve => setImmediate(resolve)); // guard: bound one turn for the background relay call to be made
    expect(w.revoked).toEqual(w.registered);
  });

  test("contested while finishing: the attached phone's row is retired as contested and it is refused", async () => {
    const w = world();
    const qr = start(w);
    const owner = await readyPhone(w, qr);
    const other = await PairingPhone.scan(qr, EngineWire.open(w.engine, "pair", qr.pairSessionId));
    expect((await w.engine.confirmPairing(qr.pairSessionId, BINDING)).ok).toBe(true);
    const outcome = await owner.answer(1);
    if (outcome === null || !outcome.ok) throw new Error("no outcome");
    const paired = owner.paired(outcome.result);
    await other.ready();
    expect(await other.answer(1)).toEqual({ ok: false, code: "pairing_contested" });
    expect(getPairedDevice(w.store.handle, paired.deviceId)).toMatchObject({ revokedReason: "contested" });
    expect(w.engine.pairingView(qr.pairSessionId, BINDING)).toMatchObject({ status: "contested", error: "Another device used this code. Pair again." });
    await owner.done(paired.deviceId);
    expect(await owner.answer(3)).toEqual({ ok: false, code: "pairing_contested" });
    const refused = await PhoneSession.handshake(paired, EngineWire.open(w.engine, "device", paired.deviceId));
    expect(refused.status).toMatchObject({ status: "refused", reason: "device_revoked" });
  });

  test("after a pairing ends, a new socket is refused", async () => {
    const w = world();
    const qr = start(w);
    const phone = await readyPhone(w, qr);
    expect(w.engine.cancelPairing(qr.pairSessionId, BINDING)).toBe(true);
    expect(await phone.answer(1)).toEqual({ ok: false, code: "pairing_cancelled" });
    expect(w.engine.pairingView(qr.pairSessionId, BINDING)?.status).toBe("cancelled");
    const late = EngineWire.open(w.engine, "pair", qr.pairSessionId);
    expect(late.closed).toBe(true);
    expect(late.closeReason).toBe("invalid_pairing");
  });

  test("pair.done for another pairing's device is refused; only the pairing's own row activates", async () => {
    const w = world();
    const qrA = start(w, "owner:A");
    const qrB = start(w, "owner:B");
    const a = await readyPhone(w, qrA);
    const b = await readyPhone(w, qrB);
    expect((await w.engine.confirmPairing(qrA.pairSessionId, "owner:A")).ok).toBe(true);
    expect((await w.engine.confirmPairing(qrB.pairSessionId, "owner:B")).ok).toBe(true);
    const outA = await a.answer(1), outB = await b.answer(1);
    if (outA === null || !outA.ok || outB === null || !outB.ok) throw new Error("no outcome");
    await a.done(String(outB.result["deviceId"]));
    expect(await a.answer(3)).toEqual({ ok: false, code: "pairing_failed" });
    expect(getPairedDevice(w.store.handle, String(outB.result["deviceId"]))?.activatedAt).toBeNull();
    expect(getPairedDevice(w.store.handle, String(outA.result["deviceId"]))?.activatedAt).toBeNull();
    // A's own pair.done still works on the same socket.
    await a.done(String(outA.result["deviceId"]));
    expect(await a.answer(3)).toEqual({ ok: true, result: { ok: true } });
  });

  test("a lost pair.done: the phone's first hello activates its row; a repeat pair.done answers ok", async () => {
    const w = world();
    const qr = start(w);
    const phone = await readyPhone(w, qr);
    expect((await w.engine.confirmPairing(qr.pairSessionId, BINDING)).ok).toBe(true);
    const outcome = await phone.answer(1);
    if (outcome === null || !outcome.ok) throw new Error("no outcome");
    const paired = phone.paired(outcome.result);
    await connect(w, paired);
    expect(getPairedDevice(w.store.handle, paired.deviceId)?.activatedAt).not.toBeNull();
    expect(w.engine.pairingView(qr.pairSessionId, BINDING)?.status).toBe("paired");
    await phone.done(paired.deviceId);
    expect(await phone.answer(3)).toEqual({ ok: true, result: { ok: true } });
  });

  test("a pending phone nobody activated within 10 minutes is deleted by the sweep and can't connect", async () => {
    const w = world();
    const qr = start(w);
    const phone = await readyPhone(w, qr);
    expect((await w.engine.confirmPairing(qr.pairSessionId, BINDING)).ok).toBe(true);
    const outcome = await phone.answer(1);
    if (outcome === null || !outcome.ok) throw new Error("no outcome");
    const paired = phone.paired(outcome.result);
    w.clock.now += WIRE.pairing.pendingActivationWindowMs + 1;
    expect(w.engine.sweepRecords().pending).toEqual([paired.deviceId]);
    expect(getPairedDevice(w.store.handle, paired.deviceId)).toBeNull();
    await new Promise(resolve => setImmediate(resolve)); // guard: bound one turn for the background relay call to be made
    expect(w.revoked).toContain(paired.deviceId);
    await expect(PhoneSession.connect(paired, EngineWire.open(w.engine, "device", paired.deviceId))).rejects.toThrow(/handshake refused/);
  });

  test("a confirm whose relay admission fails deletes the row and fails the pairing", async () => {
    const w = world();
    const qr = start(w);
    const phone = await readyPhone(w, qr);
    const refused = Promise.reject(new Error("relay said no"));
    refused.catch(() => {});
    w.admission.gate = refused;
    const confirmed = await w.engine.confirmPairing(qr.pairSessionId, BINDING);
    expect(confirmed.ok).toBe(false);
    expect(await phone.answer(1)).toEqual({ ok: false, code: "pairing_failed" });
    expect(listPairedDevices(w.store.handle)).toHaveLength(0);
    expect(w.engine.pairingView(qr.pairSessionId, BINDING)?.status).toBe("failed");
  });

  test("a confirm under a moved credential generation fails; the pairing answers only its own binding", async () => {
    const w = world();
    const qr = start(w);
    await readyPhone(w, qr);
    expect(w.engine.pairingView(qr.pairSessionId, "owner:other")).toBeNull();
    expect((await w.engine.confirmPairing(qr.pairSessionId, "owner:other")).ok).toBe(false);
    expect(w.engine.cancelPairing(qr.pairSessionId, "owner:other")).toBe(false);
    w.store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'owner'").run();
    expect((await w.engine.confirmPairing(qr.pairSessionId, BINDING)).ok).toBe(false);
    expect(listPairedDevices(w.store.handle)).toHaveLength(0);
  });

  test(`a Mac with ${MAX_PHONES_PER_MAC} phones refuses another pairing`, () => {
    const w = world();
    expect(MAX_PHONES_PER_MAC).toBe(WIRE.mac.phonesPerMac);
    const identity = w.store.workspaceIdentity();
    for (let n = 0; n < MAX_PHONES_PER_MAC; n++) {
      savePendingDevice(w.store.handle, { deviceId: `dev_${n}`, accountName: "owner", deviceName: "p", phoneStaticPub: Buffer.alloc(32, 1), deviceRelayPub: Buffer.alloc(32, 2),
        devicePsk: Buffer.alloc(32, 3), recoveryGeneration: identity.recoveryGeneration, accountGeneration: w.generation(), createdAt: new Date(w.clock.now).toISOString() });
    }
    expect(w.engine.startPairing("owner", BINDING, w.generation())).toEqual({ ok: false, error: "This Mac already has 32 phones. Remove one first." });
  });
});

describe("2. replay and eviction", () => {
  test("a replayed message 1 is dropped before any Noise work (pairing and session)", async () => {
    const w = world();
    const qr = start(w);
    const first = await PairingPhone.scan(qr, EngineWire.open(w.engine, "pair", qr.pairSessionId));
    const replay = EngineWire.open(w.engine, "pair", qr.pairSessionId);
    await replay.send(first.msg1);
    expect(replay.closed).toBe(true);
    expect(replay.pending).toBe(0);

    const phone = await pairPhone(w, "owner:B");
    const s = await PhoneSession.connect(phone, EngineWire.open(w.engine, "device", phone.deviceId));
    const again = EngineWire.open(w.engine, "device", phone.deviceId);
    await again.send(s.msg1);
    expect(again.closed).toBe(true);
    expect(again.pending).toBe(0);
  });

  test("strangers who open sockets after the phone's message 1 can't evict its handshake; unproven ones go oldest first", async () => {
    const w = world();
    const phone = await pairPhone(w);
    const wire = EngineWire.open(w.engine, "device", phone.deviceId);
    const s = await PhoneSession.handshake(phone, wire);
    const strangers = [1, 2, 3].map(() => EngineWire.open(w.engine, "device", phone.deviceId));
    // Two unproven sockets at most: the oldest stranger went, the phone's (past message 1) stayed.
    expect(strangers.map(one => one.closed)).toEqual([true, false, false]);
    expect(wire.closed).toBe(false);
    await s.open("device.hello");
    expect((await s.frame())?.type).toBe(FrameType.RES);
  });
});

describe("3. refusals: authenticated, padded, terminal", () => {
  test("a removed phone gets a 160-byte refused message 2, then what an unanswered hello gets", async () => {
    const w = world();
    const phone = await pairPhone(w);
    const accepted = await PhoneSession.handshake(phone, EngineWire.open(w.engine, "device", phone.deviceId));
    expect(accepted.msg2.length).toBe(WIRE.msg2.paddedPlaintextBytes);
    expect(accepted.status.status).toBe("awaiting_hello");
    accepted.wire.close();
    expect(w.engine.revokeDevice(phone.deviceId)).toBe(true);
    const wire = EngineWire.open(w.engine, "device", phone.deviceId);
    const refused = await PhoneSession.handshake(phone, wire);
    expect(refused.msg2.length).toBe(MSG2_PLAINTEXT_BYTES);
    expect(refused.status).toMatchObject({ protocolVersion: 1, status: "refused", reason: "device_revoked" });
    expect(WIRE.msg2.refusedReasons).toContain(refused.status.reason);
    await refused.open("device.hello");
    expect(wire.closed).toBe(true);
    expect(wire.closeReason).toBe("hello_timeout");
    expect(wire.closeCode).toBe(4408);
  });

  test("a password change retires the phone as account_revoked; a moved generation without the record says the same", async () => {
    const w = world();
    const phone = await pairPhone(w);
    w.store.revokeDerivedAuthority("owner", "credential-rotation", new Date(w.clock.now));
    expect(getPairedDevice(w.store.handle, phone.deviceId)).toMatchObject({ revokedReason: "password_changed" });
    const refused = await PhoneSession.handshake(phone, EngineWire.open(w.engine, "device", phone.deviceId));
    expect(refused.status).toMatchObject({ status: "refused", reason: "account_revoked" });

    const other = world();
    const second = await pairPhone(other);
    other.store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'owner'").run();
    const moved = await PhoneSession.handshake(second, EngineWire.open(other.engine, "device", second.deviceId));
    expect(moved.status).toMatchObject({ status: "refused", reason: "account_revoked" });
  });

  test("a live session that loses standing gets a stream-0 ERROR and closes 4403 (removal now; a credential change within a sweep)", async () => {
    const w = world();
    const phone = await pairPhone(w);
    const s = await connect(w, phone);
    w.engine.revokeDevice(phone.deviceId);
    const err = await s.frame();
    expect(err).toMatchObject({ type: FrameType.ERROR, streamId: 0 });
    expect(errorCode(err!.payload)).toBe("device_revoked");
    expect(s.wire.closeCode).toBe(WIRE.session.closeCodes.revoked);

    const v = world();
    const two = await pairPhone(v);
    const live = await connect(v, two);
    v.store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'owner'").run();
    v.clock.now += 1_000;
    v.engine.sweepDeadlines();
    const end = await live.frame();
    expect(end).toMatchObject({ type: FrameType.ERROR, streamId: 0 });
    expect(errorCode(end!.payload)).toBe("account_revoked");
    expect(WIRE.session.stream0Errors).toContain("account_revoked");
    expect(live.wire.closeCode).toBe(4403);
  });

  test("a session at its lifetime is ended with a stream-0 rekey and close 1000", async () => {
    const w = world();
    const phone = await pairPhone(w);
    const s = await connect(w, phone);
    // Inside the last minute of its 24 hours (the sweep checks every second, so a quiet session is caught there too).
    w.clock.now += 24 * 60 * 60 * 1000 - 30_000;
    await s.open("work.rows");
    const end = await s.frame();
    expect(end).toMatchObject({ type: FrameType.ERROR, streamId: 0 });
    expect(errorCode(end!.payload)).toBe("rekey");
    expect(s.wire.closeCode).toBe(WIRE.session.closeCodes.rekey);

    const quiet = await connect(w, phone);
    w.clock.now += 24 * 60 * 60 * 1000 - 30_000;
    w.engine.sweepDeadlines();
    const ended = await quiet.frame();
    expect(errorCode(ended!.payload)).toBe("rekey");
    expect(quiet.wire.closed).toBe(true);
  });
});

describe("4. loopback isolation and the allowlist", () => {
  test("a paired device is never this computer; only Gate 1 reads answer, push.register included in the refusals", async () => {
    const w = world();
    const s = await connect(w, await pairPhone(w));
    expect(await s.call("work.rows")).toMatchObject({ ok: true });
    expect(w.principals.length).toBeGreaterThan(0);
    expect(w.principals.every(p => p.kind === "paired-device" && p.requestFromThisComputer === false)).toBe(true);
    for (const forbidden of ["/login/once", "/term/start", "GET /t/t-1/approval", "task.approve", "settings.update", "push.register"]) {
      expect(await s.call(forbidden)).toEqual({ ok: false, code: "route_not_allowed" });
    }
  });

  test("before hello only a PING and the hello: anything else drops the session", async () => {
    const w = world();
    const phone = await pairPhone(w);
    const s = await PhoneSession.connect(phone, EngineWire.open(w.engine, "device", phone.deviceId));
    await s.sendFrame({ type: FrameType.PING, streamId: 0, seq: 3, payload: Buffer.from("x") });
    expect(await s.frame()).toMatchObject({ type: FrameType.PONG, seq: 3 });
    await s.credit(1, 4);
    expect(s.wire.closed).toBe(true);
    expect(s.wire.closeReason).toBe("protocol_error");

    const t = await PhoneSession.connect(phone, EngineWire.open(w.engine, "device", phone.deviceId));
    expect(await t.call("work.rows")).toEqual({ ok: false, code: "hello_required" });
    expect(t.wire.closed).toBe(true);
  });
});

describe("5. restore wipe, credit, CANCEL", () => {
  test("ADR 0001: a restore deletes every paired phone and this Mac's keys; a live session ends at its next frame", async () => {
    const w = world();
    const phone = await pairPhone(w);
    const s = await connect(w, phone);
    w.store.transact(() => { retireRestoredAuthority(w.store, { now: new Date(w.clock.now), actor: "owner" }); });
    expect(getPairedDevice(w.store.handle, phone.deviceId)).toBeNull();
    expect(listPairedDevices(w.store.handle)).toHaveLength(0);
    expect(w.store.handle.prepare("SELECT count(*) AS n FROM companion_host_keys").get()?.["n"]).toBe(0);
    w.clock.now += 1_000;
    await s.open("work.rows");
    const end = await s.frame();
    expect(end).toMatchObject({ type: FrameType.ERROR, streamId: 0 });
    expect(s.wire.closed).toBe(true);
  });

  test("a unary response waits for credit and never drops a chunk; CANCEL stops watching, never the run", async () => {
    let unsubscribed = false;
    let emitRecord: ((rec: Buffer) => void) | null = null;
    const w = world({
      taskDiff: () => ({ patch: "d".repeat(980_000) }),
      runWatchSubscribe: (_p, _params, emit) => { emitRecord = emit; return { ok: true, unsubscribe: () => { unsubscribed = true; } }; },
    });
    const s = await connect(w, await pairPhone(w));
    const diff = await s.open("task.diff");
    const first = [];
    for (let f = await s.frame(); f !== null; f = await s.frame()) first.push(f);
    expect(first).toHaveLength(INITIAL_STREAM_CREDIT);
    expect(first.every(f => f.type === FrameType.CHUNK && f.streamId === diff)).toBe(true);
    await s.sendFrame({ type: FrameType.CREDIT, streamId: diff, seq: 0, payload: encodeCreditPayload(4) });
    const rest = [];
    for (let f = await s.frame(); f !== null; f = await s.frame()) rest.push(f);
    expect(rest.at(-1)?.type).toBe(FrameType.END);
    const body = Buffer.concat([...first, ...rest].filter(f => f.type === FrameType.CHUNK).map(f => f.payload));
    expect((JSON.parse(body.toString("utf8")) as { result: { patch: string } }).result.patch.length).toBe(980_000);

    const watch = await s.open("run.watch.subscribe", { run: "1" });
    expect(emitRecord).not.toBeNull();
    emitRecord!(Buffer.from(JSON.stringify({ k: "line", text: "running" })));
    expect((await s.frame())?.streamId).toBe(watch);
    await s.wire.send(s.session.encrypt(encodeFrame({ type: FrameType.CANCEL, streamId: watch, seq: 0, payload: Buffer.alloc(0) })));
    expect(unsubscribed).toBe(true);
  });
});
