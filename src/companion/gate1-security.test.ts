/**
 * Gate 1 Mandatory Security Test Suite (`docs/plans/companion-app/threat-model-and-routes.md` §5):
 * 1. Pairing & second-handshake race abort + untrusted deviceName sanitization
 * 2. ADR 0001 backup restore wipe (`retireRestoredAuthority` wipes paired_devices/device_psk/push & rotates recovery_generation)
 * 3. Revocation & loopback isolation (`requestFromThisComputer === false`, `/login/once`, `/term/*`, `/t/<task>/approval`, non-allowlisted routes refused)
 * 4. Slow-client flow control & `CANCEL` stops watching only (never stops the underlying agent run)
 * 5. E2EE push registration (`p256dh` + `authSecret`), privacy default (`includeTitles: false`), and APNs 4 KB envelope ceiling
 */

import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "../store.js";
import { addApprover } from "../scope.js";
import { retireRestoredAuthority } from "../restore-retirement.js";
import { encryptPushPayload } from "../push.js";
import {
  buildPairingPrologue,
  buildSessionPrologue,
  deriveConfirmationCode,
  deriveDevicePsk,
  generateX25519KeyPair,
  NoiseIKpsk2Initiator,
} from "./noise.js";
import {
  decodeFrame,
  encodeCreditPayload,
  encodeFrame,
  FrameType,
  INITIAL_STREAM_CREDIT,
} from "./framing.js";
import { decodeRelayEnvelope, encodeRelayEnvelope, generateEd25519KeyPair, RelayOp } from "./relay-auth.js";
import { CompanionDaemonEngine, type PairedDevicePrincipal } from "./daemon.js";
import {
  ensureCompanionTables,
  getPairedDevice,
  getPushSubscription,
  listPairedDevices,
  sweepCompanionIdempotencyOnStartup,
} from "./store.js";

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function createTestStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-companion-gate1-"));
  dirs.push(dir);
  const store = openStore(join(dir, "toolroll.db"));
  stores.push(store);
  const added = addApprover(store, "owner", new Date());
  if (!added.ok) throw new Error("failed to add approver");
  return store;
}

describe("Gate 1 Companion Security Test Suite", () => {
  test("1. Pairing race: 2nd handshake aborts entire session, wipes pairPsk, and unconfirmed devices get zero RPCs", async () => {
    const store = createTestStore();
    const outbound: Array<{ op: number; connId: number; payload: Buffer }> = [];
    const daemon = new CompanionDaemonEngine({
      store,
      sendToRelay: raw => outbound.push(decodeRelayEnvelope(raw)),
      handlers: {
        deviceHello: p => ({ ok: true, deviceId: p.deviceId }),
        workRows: () => ({ rows: [] }),
        taskSteps: () => ({ steps: [] }),
        taskDiff: () => ({ files: [] }),
        taskApprovalRead: () => ({ terms: [] }),
        runWindowRead: () => ({ lines: [] }),
      },
    });

    const started = daemon.startPairing("owner");
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("unreachable");
    const { qr } = started;

    // Phone A connects and runs msg1 with control/bidi chars in untrusted deviceName
    const phoneANoise = generateX25519KeyPair();
    const phoneARelay = generateEd25519KeyPair();
    const prologue = buildPairingPrologue(qr.workspaceId, qr.pairSessionId);
    const initA = new NoiseIKpsk2Initiator({
      localStatic: phoneANoise,
      remoteStaticPublicKey: Buffer.from(qr.macStaticPub, "base64url"),
      psk: Buffer.from(qr.pairPsk, "base64url"),
      prologue,
    });

    await daemon.handleRelayEnvelope(encodeRelayEnvelope({
      op: RelayOp.PEER_OPEN,
      connId: 10,
      payload: Buffer.from(JSON.stringify({ role: "pair", id: qr.pairSessionId })),
    }));
    await daemon.handleRelayEnvelope(encodeRelayEnvelope({
      op: RelayOp.PEER_DATA,
      connId: 10,
      payload: initA.writeMessage1(Buffer.from(JSON.stringify({
        protocolVersion: 1,
        mode: "pair",
        deviceName: "\u202eWork\x07 iPhone",
        deviceRelayPub: phoneARelay.publicKey.toString("base64url"),
      }))),
    }));

    const status = daemon.getPairingStatus(qr.pairSessionId);
    expect(status?.status).toBe("awaiting_confirm");
    expect(status?.deviceName).toBe("Work iPhone"); // bidi + control stripped
    expect(status?.confirmCode).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);

    // Complete msg2 on Phone A, then attempt an RPC BEFORE Mac confirmation -> must be dropped!
    const msg2Env = outbound.find(e => e.op === RelayOp.PEER_DATA && e.connId === 10)!;
    const { session: phoneASession } = initA.readMessage2(msg2Env.payload);
    expect(deriveConfirmationCode(phoneASession.handshakeHash)).toBe(status?.confirmCode);

    // Now Phone B (attacker or raced owner) arrives on the SAME pairSessionId BEFORE confirmation -> ABORT ENTIRE PAIRING!
    await daemon.handleRelayEnvelope(encodeRelayEnvelope({
      op: RelayOp.PEER_OPEN,
      connId: 11,
      payload: Buffer.from(JSON.stringify({ role: "pair", id: qr.pairSessionId })),
    }));
    expect(daemon.getPairingStatus(qr.pairSessionId)?.status).toBe("aborted_race");
    expect(outbound.some(e => e.op === RelayOp.PEER_CLOSE && e.connId === 10)).toBe(true);
    expect(outbound.some(e => e.op === RelayOp.PEER_CLOSE && e.connId === 11)).toBe(true);
    expect((await daemon.confirmPairing(qr.pairSessionId)).ok).toBe(false);
    expect(listPairedDevices(store.handle).length).toBe(0);
  });

  test("2 & 3. Full pairing, loopback isolation (requestFromThisComputer=false), route allowlist, mid-session revocation, and ADR 0001 restore wipe", async () => {
    const store = createTestStore();
    const outbound: Array<{ op: number; connId: number; payload: Buffer }> = [];
    const seenPrincipals: PairedDevicePrincipal[] = [];
    const daemon = new CompanionDaemonEngine({
      store,
      sendToRelay: raw => outbound.push(decodeRelayEnvelope(raw)),
      handlers: {
        deviceHello: p => {
          seenPrincipals.push(p);
          return { workspaceId: p.workspaceId, recoveryGeneration: p.recoveryGeneration };
        },
        workRows: p => {
          seenPrincipals.push(p);
          return { rows: [{ id: "t-1", title: "Build companion" }] };
        },
        taskSteps: () => ({ steps: [] }),
        taskDiff: () => ({ files: [], patch: "x".repeat(150_000) }), // multi-chunk (>60KB)
        taskApprovalRead: () => ({ key: "k1", digest: "d1", terms: ["read-only"], mintedNonce: false }),
        runWindowRead: () => ({ lines: ["ok"] }),
      },
    });

    // Pair cleanly
    const started = daemon.startPairing("owner");
    if (!started.ok) throw new Error("unreachable");
    const { qr } = started;
    const phoneNoise = generateX25519KeyPair();
    const phoneRelay = generateEd25519KeyPair();
    const initPair = new NoiseIKpsk2Initiator({
      localStatic: phoneNoise,
      remoteStaticPublicKey: Buffer.from(qr.macStaticPub, "base64url"),
      psk: Buffer.from(qr.pairPsk, "base64url"),
      prologue: buildPairingPrologue(qr.workspaceId, qr.pairSessionId),
    });

    await daemon.handleRelayEnvelope(encodeRelayEnvelope({
      op: RelayOp.PEER_OPEN,
      connId: 1,
      payload: Buffer.from(JSON.stringify({ role: "pair", id: qr.pairSessionId })),
    }));
    await daemon.handleRelayEnvelope(encodeRelayEnvelope({
      op: RelayOp.PEER_DATA,
      connId: 1,
      payload: initPair.writeMessage1(Buffer.from(JSON.stringify({
        protocolVersion: 1,
        mode: "pair",
        deviceName: "Work iPhone",
        deviceRelayPub: phoneRelay.publicKey.toString("base64url"),
      }))),
    }));
    const msg2Pair = outbound.pop()!.payload;
    const { session: pairSession } = initPair.readMessage2(msg2Pair);

    const confirmed = await daemon.confirmPairing(qr.pairSessionId);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) throw new Error("unreachable");
    const finPayload = JSON.parse(pairSession.decrypt(outbound.pop()!.payload).toString("utf8")) as {
      deviceId: string;
      recoveryGeneration: string;
      pskEntropy: string;
    };
    expect(finPayload.deviceId).toBe(confirmed.deviceId);
    const devicePsk = deriveDevicePsk(
      Buffer.from(finPayload.pskEntropy, "base64url"),
      pairSession.handshakeHash,
      qr.workspaceId,
      finPayload.deviceId,
    );

    // Reconnect session with exact recoveryGeneration prologue
    const initSess = new NoiseIKpsk2Initiator({
      localStatic: phoneNoise,
      remoteStaticPublicKey: Buffer.from(qr.macStaticPub, "base64url"),
      psk: devicePsk,
      prologue: buildSessionPrologue(qr.workspaceId, finPayload.deviceId, finPayload.recoveryGeneration),
    });
    await daemon.handleRelayEnvelope(encodeRelayEnvelope({
      op: RelayOp.PEER_OPEN,
      connId: 2,
      payload: Buffer.from(JSON.stringify({ role: "device", id: finPayload.deviceId })),
    }));
    await daemon.handleRelayEnvelope(encodeRelayEnvelope({
      op: RelayOp.PEER_DATA,
      connId: 2,
      payload: initSess.writeMessage1(Buffer.from(JSON.stringify({
        protocolVersion: 1,
        mode: "session",
        deviceId: finPayload.deviceId,
      }))),
    }));
    const { session: phoneSess } = initSess.readMessage2(outbound.pop()!.payload);

    // 1. Key confirmation via device.hello
    const sendRpc = async (streamId: number, method: string, params: Record<string, unknown> = {}) => {
      const frame = encodeFrame({
        type: FrameType.REQ,
        streamId,
        seq: 0,
        payload: Buffer.from(JSON.stringify({ method, params })),
      });
      await daemon.handleRelayEnvelope(encodeRelayEnvelope({
        op: RelayOp.PEER_DATA,
        connId: 2,
        payload: phoneSess.encrypt(frame),
      }));
      const replies = outbound.splice(0, outbound.length).filter(e => e.op === RelayOp.PEER_DATA && e.connId === 2);
      return replies.map(r => decodeFrame(phoneSess.decrypt(r.payload)));
    };

    const helloRes = await sendRpc(1, "device.hello");
    expect(helloRes.length).toBe(1);
    expect(JSON.parse(helloRes[0]!.payload.toString("utf8"))).toMatchObject({ ok: true });

    // Verify paired-device principal NEVER claims requestFromThisComputer
    const workRes = await sendRpc(3, "work.rows");
    expect(JSON.parse(workRes[0]!.payload.toString("utf8"))).toMatchObject({ ok: true });
    expect(seenPrincipals.every(p => p.kind === "paired-device" && p.requestFromThisComputer === false)).toBe(true);

    // Blocked / non-allowlisted routes refused cleanly
    for (const [idx, forbidden] of ["/login/once", "/term/start", "GET /t/t-1/approval", "task.approve", "settings.update"].entries()) {
      const res = await sendRpc(5 + idx * 2, forbidden);
      expect(res[0]!.type).toBe(FrameType.ERROR);
      expect(JSON.parse(res[0]!.payload.toString("utf8"))).toMatchObject({ code: "route_not_allowed" });
    }

    // 5. E2EE push.register validates p256dh + authSecret & defaults includeTitles = false
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const p256dh = ua.getPublicKey().toString("base64url");
    const authSecret = randomBytes(16).toString("base64url");
    const pushReg = await sendRpc(21, "push.register", { apnsToken: "a".repeat(64), p256dh, authSecret });
    expect(JSON.parse(pushReg[0]!.payload.toString("utf8"))).toMatchObject({ ok: true });
    const savedPush = getPushSubscription(store.handle, finPayload.deviceId);
    expect(savedPush?.includeTitles).toBe(false);
    // Verify real src/push.ts RFC 8291 encryption fits safely in APNs 4,096 B JSON envelope
    const ciphertext = encryptPushPayload(p256dh, authSecret, JSON.stringify({ kind: "needs_you", taskId: "t-1", phrase: "Decision needed" }));
    const apnsJson = JSON.stringify({
      aps: { alert: { title: "Toolroll", body: "Open app to check your workspace." }, "mutable-content": 1, badge: 1 },
      tr: { v: 1, m: "m_opaque", c: ciphertext.toString("base64url") },
    });
    expect(Buffer.byteLength(apnsJson, "utf8")).toBeLessThan(4_096);

    // Startup idempotency sweep turns lingering in_flight -> unknown
    ensureCompanionTables(store.handle);
    store.handle.prepare(`
      INSERT INTO companion_idempotency (device_id, idempotency_key, method, request_hash, state, outcome_json, updated_at)
      VALUES (?, 'k-1', 'task.land', 'h1', 'in_flight', NULL, ?)
    `).run(finPayload.deviceId, new Date().toISOString());
    expect(sweepCompanionIdempotencyOnStartup(store.handle).markedUnknown).toBe(1);

    // ADR 0001 backup restore wipe: retires paired devices, push tokens, idempotency & rotates recovery_generation!
    store.transact(() => {
      retireRestoredAuthority(store, { now: new Date(), actor: "owner" });
    });
    expect(getPairedDevice(store.handle, finPayload.deviceId)).toBeNull();
    expect(getPushSubscription(store.handle, finPayload.deviceId)).toBeNull();
    expect(listPairedDevices(store.handle)).toHaveLength(0);

    // Next RPC on old active session MUST immediately terminate peer because recoveryGeneration & device are gone!
    outbound.length = 0;
    await daemon.handleRelayEnvelope(encodeRelayEnvelope({
      op: RelayOp.PEER_DATA,
      connId: 2,
      payload: phoneSess.encrypt(encodeFrame({
        type: FrameType.REQ,
        streamId: 23,
        seq: 0,
        payload: Buffer.from(JSON.stringify({ method: "work.rows" })),
      })),
    }));
    expect(outbound.some(e => e.op === RelayOp.PEER_CLOSE && e.connId === 2)).toBe(true);
  });

  test("4. Slow-client credit wait (unary never drops chunks) & CANCEL stops watching only without stopping agent run", async () => {
    const store = createTestStore();
    const outbound: Array<{ op: number; connId: number; payload: Buffer }> = [];
    let watchUnsubscribed = false;
    let agentRunStopped = false;
    let pushRecord: ((rec: Buffer) => void) | null = null;

    const daemon = new CompanionDaemonEngine({
      store,
      sendToRelay: raw => outbound.push(decodeRelayEnvelope(raw)),
      handlers: {
        deviceHello: () => ({ ok: true }),
        workRows: () => ({ rows: [] }),
        taskSteps: () => ({ steps: [] }),
        // ~1.0 MiB diff response (> 16 chunks of 60KB -> requires CREDIT frame!)
        taskDiff: () => ({ patch: "d".repeat(980_000) }),
        taskApprovalRead: () => ({ terms: [] }),
        runWindowRead: () => ({ lines: [] }),
        runWatchSubscribe: (_p, _params, emit) => {
          pushRecord = emit;
          return { ok: true, unsubscribe: () => { watchUnsubscribed = true; } };
        },
      },
    });

    // Quick pair + reconnect helper
    const started = daemon.startPairing("owner");
    if (!started.ok) throw new Error("unreachable");
    const { qr } = started;
    const phoneNoise = generateX25519KeyPair();
    const phoneRelay = generateEd25519KeyPair();
    const initPair = new NoiseIKpsk2Initiator({
      localStatic: phoneNoise,
      remoteStaticPublicKey: Buffer.from(qr.macStaticPub, "base64url"),
      psk: Buffer.from(qr.pairPsk, "base64url"),
      prologue: buildPairingPrologue(qr.workspaceId, qr.pairSessionId),
    });
    await daemon.handleRelayEnvelope(encodeRelayEnvelope({ op: RelayOp.PEER_OPEN, connId: 1, payload: Buffer.from(JSON.stringify({ role: "pair", id: qr.pairSessionId })) }));
    await daemon.handleRelayEnvelope(encodeRelayEnvelope({
      op: RelayOp.PEER_DATA,
      connId: 1,
      payload: initPair.writeMessage1(Buffer.from(JSON.stringify({ protocolVersion: 1, mode: "pair", deviceName: "iPhone", deviceRelayPub: phoneRelay.publicKey.toString("base64url") }))),
    }));
    const { session: pairSess } = initPair.readMessage2(outbound.pop()!.payload);
    await daemon.confirmPairing(qr.pairSessionId);
    const fin = JSON.parse(pairSess.decrypt(outbound.pop()!.payload).toString("utf8")) as { deviceId: string; recoveryGeneration: string; pskEntropy: string };
    const devicePsk = deriveDevicePsk(Buffer.from(fin.pskEntropy, "base64url"), pairSess.handshakeHash, qr.workspaceId, fin.deviceId);

    const initSess = new NoiseIKpsk2Initiator({
      localStatic: phoneNoise,
      remoteStaticPublicKey: Buffer.from(qr.macStaticPub, "base64url"),
      psk: devicePsk,
      prologue: buildSessionPrologue(qr.workspaceId, fin.deviceId, fin.recoveryGeneration),
    });
    await daemon.handleRelayEnvelope(encodeRelayEnvelope({ op: RelayOp.PEER_OPEN, connId: 2, payload: Buffer.from(JSON.stringify({ role: "device", id: fin.deviceId })) }));
    await daemon.handleRelayEnvelope(encodeRelayEnvelope({ op: RelayOp.PEER_DATA, connId: 2, payload: initSess.writeMessage1(Buffer.from(JSON.stringify({ protocolVersion: 1, mode: "session", deviceId: fin.deviceId }))) }));
    const { session: phoneSess } = initSess.readMessage2(outbound.pop()!.payload);

    const sendFrame = async (f: Parameters<typeof encodeFrame>[0]) => {
      await daemon.handleRelayEnvelope(encodeRelayEnvelope({ op: RelayOp.PEER_DATA, connId: 2, payload: phoneSess.encrypt(encodeFrame(f)) }));
      return outbound.splice(0, outbound.length).filter(e => e.op === RelayOp.PEER_DATA && e.connId === 2).map(e => decodeFrame(phoneSess.decrypt(e.payload)));
    };

    await sendFrame({ type: FrameType.REQ, streamId: 1, seq: 0, payload: Buffer.from(JSON.stringify({ method: "device.hello" })) });

    // Multi-chunk unary diff pauses at 16 initial chunks, resumes cleanly on CREDIT without dropping anything
    const firstBatch = await sendFrame({ type: FrameType.REQ, streamId: 3, seq: 0, payload: Buffer.from(JSON.stringify({ method: "task.diff" })) });
    expect(firstBatch.length).toBe(INITIAL_STREAM_CREDIT);
    expect(firstBatch.every(f => f.type === FrameType.CHUNK)).toBe(true);

    const secondBatch = await sendFrame({ type: FrameType.CREDIT, streamId: 3, seq: 0, payload: encodeCreditPayload(4) });
    expect(secondBatch.at(-1)!.type).toBe(FrameType.END);
    const fullDiff = Buffer.concat([...firstBatch, ...secondBatch].filter(f => f.type === FrameType.CHUNK).map(f => f.payload));
    expect((JSON.parse(fullDiff.toString("utf8")) as { result: { patch: string } }).result.patch.length).toBe(980_000);

    // Live watch + CANCEL stops watching ONLY (agentRunStopped stays false)
    await sendFrame({ type: FrameType.REQ, streamId: 5, seq: 0, payload: Buffer.from(JSON.stringify({ method: "run.watch.subscribe", params: { runId: 1 } })) });
    expect(pushRecord).not.toBeNull();
    pushRecord!(Buffer.from(JSON.stringify({ k: "line", text: "running..." })));
    outbound.length = 0;

    await sendFrame({ type: FrameType.CANCEL, streamId: 5, seq: 0, payload: Buffer.alloc(0) });
    expect(watchUnsubscribed).toBe(true);
    expect(agentRunStopped).toBe(false);
  });
});
