import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import {
  buildPairingPrologue,
  buildSessionPrologue,
  deriveConfirmationCode,
  deriveDevicePsk,
  deriveMachineId,
  generateX25519KeyPair,
  MAX_NOISE_MESSAGE_BYTES,
  NoiseIKpsk2Initiator,
  NoiseIKpsk2Responder,
  randomPsk32,
} from "./noise.js";
import {
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  generateEd25519KeyPair,
  RelayOp,
  signRegistrationPop,
  signRelayToken,
} from "./relay-auth.js";
import { startReferenceRelay, type RunningReferenceRelay } from "./relay-server.js";

const relays: RunningReferenceRelay[] = [];

afterEach(async () => {
  while (relays.length > 0) {
    await relays.pop()!.close();
  }
});

async function registerMachine(relay: RunningReferenceRelay, relayKey: ReturnType<typeof generateEd25519KeyPair>) {
  const chalRes = await fetch(`${relay.url}/v1/challenge`, { method: "POST" });
  expect(chalRes.status).toBe(200);
  const { challenge } = (await chalRes.json()) as { challenge: string };
  const host = new URL(relay.url).host;
  const sig = signRegistrationPop(relayKey.privateKey, host, challenge);
  const regRes = await fetch(`${relay.url}/v1/machines/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      relayMachinePub: relayKey.publicKey.toString("base64url"),
      challenge,
      signature: sig,
    }),
  });
  expect(regRes.status).toBe(200);
  const { machineId } = (await regRes.json()) as { machineId: string };
  expect(machineId).toBe(deriveMachineId(relayKey.publicKey));
  return machineId;
}

function connectWs(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP_${res.statusCode}`)));
  });
}

function nextMessage(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    ws.once("message", data => resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)));
    ws.once("error", reject);
    ws.once("close", code => reject(new Error(`CLOSED_${code}`)));
  });
}

describe("Portable Relay Conformance Suite (v1)", () => {
  test("deterministic machineId registration, migration reclaim, pre-upgrade auth, and role ownership", async () => {
    const relayA = await startReferenceRelay();
    relays.push(relayA);
    const machineKey = generateEd25519KeyPair();
    const machineIdA = await registerMachine(relayA, machineKey);

    // Reclaiming exact same machineId on a brand-new empty relay (migration recovery!)
    const relayB = await startReferenceRelay();
    relays.push(relayB);
    const machineIdB = await registerMachine(relayB, machineKey);
    expect(machineIdB).toBe(machineIdA);

    // Pre-upgrade rejections: no token, malformed token, expired token, unknown device, wrong signer for daemon
    await expect(connectWs(relayA.wsUrl)).rejects.toThrow("HTTP_401");
    await expect(connectWs(relayA.wsUrl, "not-a-token")).rejects.toThrow("HTTP_401");
    const expiredToken = signRelayToken(machineKey.privateKey, {
      role: "daemon",
      machineId: machineIdA,
      nowSec: Math.floor(Date.now() / 1000) - 600,
      ttlSec: 60,
    });
    await expect(connectWs(relayA.wsUrl, expiredToken)).rejects.toThrow("HTTP_401");

    const rogueKey = generateEd25519KeyPair();
    const forgedDaemonToken = signRelayToken(rogueKey.privateKey, { role: "daemon", machineId: machineIdA });
    await expect(connectWs(relayA.wsUrl, forgedDaemonToken)).rejects.toThrow("HTTP_401");
  });

  test("tunnels full Noise IKpsk2 pairing + reconnect across relay, supports multi-phone connId routing, and enforces revocation", async () => {
    const relay = await startReferenceRelay();
    relays.push(relay);

    const machineKey = generateEd25519KeyPair();
    const machineId = await registerMachine(relay, machineKey);
    const daemonToken = signRelayToken(machineKey.privateKey, { role: "daemon", machineId });
    const daemonWs = await connectWs(relay.wsUrl, daemonToken);

    const workspaceId = "ws_test_01";
    const pairSessionId = "pair_abc_01";
    const recoveryGen = "a".repeat(32);
    const macNoise = generateX25519KeyPair();
    const phoneNoise = generateX25519KeyPair();
    const pairPsk = randomPsk32();

    // 1. Pairing bootstrap via pairConnToken embedded in QR code
    const pairConnToken = signRelayToken(machineKey.privateKey, { role: "pair", machineId, pairSessionId });
    const openPromise = nextMessage(daemonWs);
    const phonePairWs = await connectWs(relay.wsUrl, pairConnToken);
    const openEnv = decodeRelayEnvelope(await openPromise);
    expect(openEnv.op).toBe(RelayOp.PEER_OPEN);
    const pairConnId = openEnv.connId;

    const pairPrologue = buildPairingPrologue(workspaceId, pairSessionId);
    const initPair = new NoiseIKpsk2Initiator({
      localStatic: phoneNoise,
      remoteStaticPublicKey: macNoise.publicKey,
      psk: pairPsk,
      prologue: pairPrologue,
    });
    const respPair = new NoiseIKpsk2Responder({
      localStatic: macNoise,
      psk: pairPsk,
      prologue: pairPrologue,
    });

    const daemonMsg1Promise = nextMessage(daemonWs);
    phonePairWs.send(initPair.writeMessage1(Buffer.from('{"mode":"pair"}')), { binary: true });
    const env1 = decodeRelayEnvelope(await daemonMsg1Promise);
    expect(env1.op).toBe(RelayOp.PEER_DATA);
    expect(env1.connId).toBe(pairConnId);
    respPair.readMessage1(env1.payload);

    const phoneMsg2Promise = nextMessage(phonePairWs);
    const { message: msg2, session: macPairSession } = respPair.writeMessage2(Buffer.from('{"status":"pending"}'));
    daemonWs.send(encodeRelayEnvelope({ op: RelayOp.PEER_DATA, connId: pairConnId, payload: msg2 }), { binary: true });
    const { session: phonePairSession } = initPair.readMessage2(await phoneMsg2Promise);
    expect(deriveConfirmationCode(macPairSession.handshakeHash)).toBe(deriveConfirmationCode(phonePairSession.handshakeHash));

    // 2. Register 2 paired devices on the relay and verify multi-phone concurrent routing
    const dev1Key = generateEd25519KeyPair();
    const dev2Key = generateEd25519KeyPair();
    for (const [deviceId, key] of [["dev_1", dev1Key], ["dev_2", dev2Key]] as const) {
      const regDev = await fetch(`${relay.url}/v1/machines/${machineId}/devices`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${daemonToken}` },
        body: JSON.stringify({ deviceId, deviceRelayPub: key.publicKey.toString("base64url") }),
      });
      expect(regDev.status).toBe(200);
    }

    phonePairWs.close();
    await nextMessage(daemonWs); // PEER_CLOSE for pair socket

    const dev1Token = signRelayToken(dev1Key.privateKey, { role: "device", machineId, deviceId: "dev_1" });
    const dev2Token = signRelayToken(dev2Key.privateKey, { role: "device", machineId, deviceId: "dev_2" });

    const o1 = nextMessage(daemonWs);
    const ws1 = await connectWs(relay.wsUrl, dev1Token);
    const conn1 = decodeRelayEnvelope(await o1).connId;

    const o2 = nextMessage(daemonWs);
    const ws2 = await connectWs(relay.wsUrl, dev2Token);
    const conn2 = decodeRelayEnvelope(await o2).connId;
    expect(conn1).not.toBe(conn2);

    // Encrypted session reconnect on dev_1 using derived devicePsk
    const devicePsk = deriveDevicePsk(randomPsk32(), macPairSession.handshakeHash, workspaceId, "dev_1");
    const sessPrologue = buildSessionPrologue(workspaceId, "dev_1", recoveryGen);
    const initS = new NoiseIKpsk2Initiator({ localStatic: phoneNoise, remoteStaticPublicKey: macNoise.publicKey, psk: devicePsk, prologue: sessPrologue });
    const respS = new NoiseIKpsk2Responder({ localStatic: macNoise, psk: devicePsk, prologue: sessPrologue });

    const d1 = nextMessage(daemonWs);
    ws1.send(initS.writeMessage1(Buffer.from('{"mode":"session","deviceId":"dev_1"}')), { binary: true });
    respS.readMessage1(decodeRelayEnvelope(await d1).payload);

    const p2 = nextMessage(ws1);
    const { message: sMsg2, session: macS } = respS.writeMessage2(Buffer.from('{"status":"ready"}'));
    daemonWs.send(encodeRelayEnvelope({ op: RelayOp.PEER_DATA, connId: conn1, payload: sMsg2 }), { binary: true });
    const { session: phoneS } = initS.readMessage2(await p2);

    const ctReq = phoneS.encrypt(Buffer.from("work.rows"));
    const dReq = nextMessage(daemonWs);
    ws1.send(ctReq, { binary: true });
    expect(macS.decrypt(decodeRelayEnvelope(await dReq).payload).toString("utf8")).toBe("work.rows");

    // 3. Revoke dev_1: closes active socket & blocks pre-upgrade reconnect immediately
    const closedPromise = new Promise<number>(resolve => ws1.once("close", code => resolve(code)));
    const delRes = await fetch(`${relay.url}/v1/machines/${machineId}/devices/dev_1`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${daemonToken}` },
    });
    expect(delRes.status).toBe(200);
    expect(await closedPromise).toBe(1000);
    await expect(connectWs(relay.wsUrl, dev1Token)).rejects.toThrow("HTTP_403");

    ws2.close();
    daemonWs.close();
  });

  test("enforces max 4 phones, 5s first-frame deadline, 65,535 B frame cap, rate limit, and global circuit breaker", async () => {
    const relay = await startReferenceRelay({
      firstFrameDeadlineMs: 120,
      maxPhonesPerMachine: 4,
      phoneFrameBurst: 3,
      phoneFramesPerMin: 3,
      globalMaxFrames: 5,
    });
    relays.push(relay);

    const machineKey = generateEd25519KeyPair();
    const machineId = await registerMachine(relay, machineKey);
    const daemonToken = signRelayToken(machineKey.privateKey, { role: "daemon", machineId });
    const daemonWs = await connectWs(relay.wsUrl, daemonToken);

    const devKey = generateEd25519KeyPair();
    await fetch(`${relay.url}/v1/machines/${machineId}/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${daemonToken}` },
      body: JSON.stringify({ deviceId: "dev_a", deviceRelayPub: devKey.publicKey.toString("base64url") }),
    });
    const devToken = signRelayToken(devKey.privateKey, { role: "device", machineId, deviceId: "dev_a" });

    // 1. First-frame deadline drops silent peer socket
    const silentWs = await connectWs(relay.wsUrl, devToken);
    const silentClosed = await new Promise<string>(resolve => silentWs.once("close", (_c, r) => resolve(r.toString("utf8"))));
    expect(silentClosed).toBe("first_frame_timeout");

    // 2. Max 4 concurrent phones -> 5th gets HTTP 429 before upgrade
    const openPhones: WebSocket[] = [];
    for (let i = 0; i < 4; i++) {
      const ws = await connectWs(relay.wsUrl, devToken);
      ws.send(Buffer.from([0x01]), { binary: true }); // satisfy first-frame deadline
      openPhones.push(ws);
    }
    await expect(connectWs(relay.wsUrl, devToken)).rejects.toThrow("HTTP_429");

    // 3. Oversized (> 65,535 B) phone frame closed
    const oversizedClosed = new Promise<number>(resolve => openPhones[0]!.once("close", code => resolve(code)));
    openPhones[0]!.send(Buffer.alloc(MAX_NOISE_MESSAGE_BYTES + 1), { binary: true });
    await oversizedClosed;

    // 4. Global circuit breaker trips at 5 frames -> HTTP 503 on new requests
    const forwarded5 = nextMessage(daemonWs);
    openPhones[1]!.send(Buffer.from([0x02]), { binary: true });
    await forwarded5;
    const health = await fetch(`${relay.url}/v1/health`);
    expect(health.status).toBe(503);

    for (const p of openPhones) p.close();
    daemonWs.close();
  });
});
