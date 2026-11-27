/**
 * The relay conformance suite (relay/PROTOCOL.md). One definition, run against every relay implementation through a
 * RelayTargetFactory over real HTTP and WebSockets:
 *   - the Node reference relay: src/companion/relay-conformance.test.ts (root unit suite);
 *   - the Cloudflare worker under Miniflare: relay/cloudflare/test/conformance.test.ts (`npm run relay:test`).
 * Knobs only one implementation has (the reference relay's breaker, room cap, proxy handling) are tested in that
 * implementation's own test file, never here.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deriveMachineId, MAX_NOISE_MESSAGE_BYTES } from "../../src/companion/noise.js";
import { generateEd25519KeyPair, RelayOp, signRegistrationPop } from "../../src/companion/relay-auth.js";
import {
  admin,
  admit,
  adminToken,
  bounded,
  closeOf,
  connect,
  connectDaemon,
  connectOk,
  daemonWsToken,
  deviceToken,
  newPhone,
  openPhone,
  openSilentPhone,
  rawToken,
  refusedWith,
  register,
  sendBinary,
  token,
  type Daemon,
  type Machine,
  type RelayTarget,
  type RelayTargetFactory,
} from "./client.js";

const wire = JSON.parse(readFileSync(new URL("../../test/fixtures/companion-wire.json", import.meta.url), "utf8")) as {
  relay: {
    errorHeader: string;
    closeCodes: { protocol: number; revoked: number; timeout: number; superseded: number; rateLimited: number; daemonGone: number };
    token: { maxTtlSec: number; skewSec: number; pairTokenMaxUses: number };
    replay: { perDevice: number };
    limits: { socketsPerMachine: number; devicesPerMachine: number; phoneUp: { framesBurst: number }; phoneDown: { bytesBurst: number } };
  };
};
const contract = JSON.parse(readFileSync(new URL("../../test/fixtures/companion-relay-contract.json", import.meta.url), "utf8")) as { replayBudgets: { perDevice: number } };
wire.relay.replay = contract.replayBudgets;
const CLOSE = wire.relay.closeCodes;
const HEADER = wire.relay.errorHeader.toLowerCase();

const nowSec = (): number => Math.floor(Date.now() / 1000);

async function expectRefusal(res: Response, status: number, code: string): Promise<void> {
  expect({ status: res.status, code: res.headers.get(HEADER) }).toEqual({ status, code });
  expect(await res.json()).toEqual({ error: code });
}

/** Proves the daemon socket is still open and that nothing was queued before this point: a heartbeat's ACK is the next
 * envelope it receives. */
async function expectQuietAndAlive(daemon: Daemon): Promise<void> {
  daemon.heartbeat(Date.now());
  const env = await daemon.envelope("HEARTBEAT_ACK");
  expect(env.op).toBe(RelayOp.HEARTBEAT_ACK);
}

function devicesPath(m: Machine): string {
  return `/v1/machines/${m.machineId}/devices`;
}

export function defineRelayConformance(name: string, factory: RelayTargetFactory): void {
  describe(`relay conformance — ${name}`, () => {
    let main: RelayTarget;
    let fast: RelayTarget;

    beforeAll(async () => {
      main = await factory({ registerPerMin: 10_000, connectPerMin: 10_000, clientPerMin: 10_000 });
      fast = await factory({ registerPerMin: 10_000, connectPerMin: 10_000, clientPerMin: 10_000, timing: { phoneFirstFrameMs: 400, phoneIdleMs: 1000, daemonSilenceMs: 1000 } });
    });
    afterAll(async () => {
      await main?.close();
      await fast?.close();
    });

    test("health reports the version and a build id", async () => {
      const res = await fetch(`${main.url}/v1/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; version: number; build: string };
      expect(body.ok).toBe(true);
      expect(body.version).toBe(1);
      expect(typeof body.build).toBe("string");
    });

    test("registration is deterministic and idempotent; bad requests are refused with the table's codes", async () => {
      const key = generateEd25519KeyPair();
      const first = await register(main, key);
      const again = await register(main, key);
      expect(first.machineId).toBe(deriveMachineId(key.publicKey));
      expect(again.machineId).toBe(first.machineId);

      const post = (body: unknown) => fetch(`${main.url}/v1/machines/register`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
      const { challenge } = (await (await fetch(`${main.url}/v1/challenge`, { method: "POST" })).json()) as { challenge: string };
      const pub = key.publicKey.toString("base64url");
      await expectRefusal(await post({ relayMachinePub: pub }), 400, "bad_request");
      await expectRefusal(await post("{not json"), 400, "bad_request");
      await expectRefusal(await post({ relayMachinePub: pub.slice(0, 40), challenge, signature: "x" }), 400, "bad_request");
      await expectRefusal(await post({ relayMachinePub: pub, challenge, signature: signRegistrationPop(key.privateKey, "other.example", challenge), pad: "" }), 401, "token_invalid");
      const tampered = (challenge[0] === "A" ? "B" : "A") + challenge.slice(1);
      await expectRefusal(await post({ relayMachinePub: pub, challenge: tampered, signature: signRegistrationPop(key.privateKey, main.publicHost, tampered) }), 401, "token_invalid");
      await expectRefusal(await post({ relayMachinePub: pub, challenge, signature: signRegistrationPop(key.privateKey, main.publicHost, challenge), pad: "x".repeat(5000) }), 400, "bad_request");
    });

    test("unknown endpoints and methods answer 400 bad_request (the table has no other code for them)", async () => {
      await expectRefusal(await fetch(`${main.url}/v1/nope`), 400, "bad_request");
      const m = await register(main);
      await expectRefusal(await fetch(`${main.url}${devicesPath(m)}`), 400, "bad_request");
      await expectRefusal(await fetch(`${main.url}/v1/machines/${m.machineId}`, { method: "PUT" }), 400, "bad_request");
    });

    test("admission calls: every token rule maps to its refusal", async () => {
      const m = await register(main);
      const path = devicesPath(m);
      const put = (bearer: string | null, target = path) => fetch(`${main.url}${target}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify({ devices: [] }),
      });
      const base = { v: 1, role: "daemon", machineId: m.machineId, aud: main.publicHost, htm: "PUT", htu: path };
      const fresh = () => ({ jti: `j${Math.random().toString(36).slice(2)}${Date.now()}`, iat: nowSec(), exp: nowSec() + 60 });

      await expectRefusal(await put(null), 401, "token_invalid");
      await expectRefusal(await put("not-a-token"), 401, "token_invalid");
      const stranger = generateEd25519KeyPair();
      const unregistered = deriveMachineId(stranger.publicKey);
      await expectRefusal(await put(adminToken(main, { machineId: unregistered, key: stranger }, "PUT", `/v1/machines/${unregistered}/devices`), `/v1/machines/${unregistered}/devices`), 404, "machine_unknown");
      await expectRefusal(await put(adminToken(main, { machineId: m.machineId, key: stranger }, "PUT", path)), 401, "token_invalid");
      await expectRefusal(await put(adminToken(main, m, "PUT", path, { aud: "relay.example.com" })), 401, "token_invalid");
      await expectRefusal(await put(adminToken(main, m, "POST", path)), 401, "token_invalid");
      await expectRefusal(await put(adminToken(main, m, "PUT", `${path}/`)), 401, "token_invalid");
      await expectRefusal(await put(adminToken(main, m, "PUT", `/v1/machines/${m.machineId}`)), 401, "token_invalid");
      await expectRefusal(await put(daemonWsToken(main, m)), 401, "token_invalid");
      await expectRefusal(await put(token(main, m.key.privateKey, { role: "pair", machineId: m.machineId, pairSessionId: "pair_1", htm: "PUT", htu: path })), 401, "token_invalid");
      await expectRefusal(await put(rawToken(m.key.privateKey, { ...base, ...fresh(), extra: true })), 401, "token_invalid");
      await expectRefusal(await put(rawToken(m.key.privateKey, { ...base, ...fresh(), jti: "short" })), 401, "token_invalid");
      await expectRefusal(await put(rawToken(m.key.privateKey, { ...base, ...fresh(), v: 2 })), 401, "token_invalid");
      await expectRefusal(await put(rawToken(m.key.privateKey, { ...base, ...fresh(), exp: nowSec() + 301 })), 401, "token_invalid");
      await expectRefusal(await put(rawToken(m.key.privateKey, { ...base, ...fresh(), iat: nowSec() + 0.5 })), 401, "token_invalid");
      await expectRefusal(await put(rawToken(m.key.privateKey, { ...base, ...fresh(), aud: `${main.publicHost}.` })), 401, "token_invalid");

      const expired = await put(adminToken(main, m, "PUT", path, { nowSec: nowSec() - 400, ttlSec: 60 }));
      await expectRefusal(expired, 401, "token_expired");
      expect(expired.headers.get("date")).not.toBeNull();
      const early = await put(adminToken(main, m, "PUT", path, { nowSec: nowSec() + 120, ttlSec: 60 }));
      await expectRefusal(early, 401, "token_not_yet_valid");
      expect(early.headers.get("date")).not.toBeNull();
      // Inside the 30 s skew both ways: accepted.
      expect((await put(adminToken(main, m, "PUT", path, { nowSec: nowSec() + 20, ttlSec: 60 }))).status).toBe(200);

      const once = adminToken(main, m, "PUT", path);
      expect((await put(once)).status).toBe(200);
      await expectRefusal(await put(once), 401, "token_invalid");
    });

    test("admission bodies: caps, key lengths and id grammar answer 400 bad_request", async () => {
      const m = await register(main);
      const path = devicesPath(m);
      const key = generateEd25519KeyPair().publicKey.toString("base64url");
      const many = Array.from({ length: wire.relay.limits.devicesPerMachine + 1 }, (_, i) => ({ deviceId: `d${i}`, deviceRelayPub: key }));
      await expectRefusal(await admin(main, m, "PUT", path, { devices: many }), 400, "bad_request");
      await expectRefusal(await admin(main, m, "PUT", path, { devices: [{ deviceId: "d1", deviceRelayPub: key.slice(0, 40) }] }), 400, "bad_request");
      await expectRefusal(await admin(main, m, "PUT", path, { devices: [{ deviceId: "bad.id", deviceRelayPub: key }] }), 400, "bad_request");
      await expectRefusal(await admin(main, m, "PUT", path, { devices: [{ deviceId: "d".repeat(129), deviceRelayPub: key }] }), 400, "bad_request");
      await expectRefusal(await admin(main, m, "PUT", path, { devices: [{ deviceId: "d1", deviceRelayPub: key }, { deviceId: "d1", deviceRelayPub: key }] }), 400, "bad_request");
      await expectRefusal(await admin(main, m, "PUT", path, "{nope"), 400, "bad_request");
      await expectRefusal(await admin(main, m, "PUT", path, { devices: [], pad: "x".repeat(17_000) }), 400, "bad_request");
      await expectRefusal(await admin(main, m, "POST", path, { deviceId: "d1", deviceRelayPub: key, pad: "x".repeat(5000) }), 400, "bad_request");
      await expectRefusal(await admin(main, m, "DELETE", `${path}/bad%2Fid`), 400, "bad_request");

      const full = many.slice(0, wire.relay.limits.devicesPerMachine);
      expect((await admin(main, m, "PUT", path, { devices: full })).status).toBe(200);
      await expectRefusal(await admin(main, m, "POST", path, { deviceId: "one_more", deviceRelayPub: key }), 400, "bad_request");
      expect((await admin(main, m, "POST", path, { deviceId: "d0", deviceRelayPub: key })).status).toBe(200); // already admitted
    });

    test("device connect order: unknown, no daemon, bad signature, revoked (DELETE and PUT), re-admitted", async () => {
      const m = await register(main);
      const phone = newPhone();
      // Unknown device, no daemon: 503 before 404.
      expect(await refusedWith(main, deviceToken(main, m, phone))).toMatchObject({ status: 503, code: "daemon_unavailable" });
      // Admitted but no daemon: 503.
      await admit(main, m, [phone]);
      expect(await refusedWith(main, deviceToken(main, m, phone))).toMatchObject({ status: 503, code: "daemon_unavailable" });
      // Revoked: 403 even with no daemon (the tombstone answers first).
      expect((await admin(main, m, "DELETE", `${devicesPath(m)}/${phone.deviceId}`)).status).toBe(200);
      expect(await refusedWith(main, deviceToken(main, m, phone))).toMatchObject({ status: 403, code: "device_revoked" });
      // A token for the tombstoned id signed by any other key is not told it was revoked.
      expect(await refusedWith(main, deviceToken(main, m, { deviceId: phone.deviceId, key: generateEd25519KeyPair() }))).toMatchObject({ status: 401, code: "token_invalid" });

      const daemon = await connectDaemon(main, m);
      const stranger = newPhone();
      expect(await refusedWith(main, deviceToken(main, m, stranger))).toMatchObject({ status: 404, code: "device_unknown" });
      const other = newPhone();
      await admit(main, m, [other]);
      expect(await refusedWith(main, deviceToken(main, m, { deviceId: other.deviceId, key: generateEd25519KeyPair() }))).toMatchObject({ status: 401, code: "token_invalid" });
      expect(await refusedWith(main, deviceToken(main, m, other, { htm: "PUT", htu: devicesPath(m) }))).toMatchObject({ status: 401, code: "token_invalid" });
      expect(await refusedWith(main, deviceToken(main, m, other, { aud: "relay.example.com" }))).toMatchObject({ status: 401, code: "token_invalid" });
      const expired = await refusedWith(main, deviceToken(main, m, other, { nowSec: nowSec() - 400, ttlSec: 60 }));
      expect(expired).toMatchObject({ status: 401, code: "token_expired" });
      expect(expired.headers["date"]).toBeDefined();

      // One-time device tokens.
      const once = deviceToken(main, m, other);
      const first = await connectOk(main, once);
      await daemon.expect(RelayOp.PEER_OPEN);
      expect(await refusedWith(main, once)).toMatchObject({ status: 401, code: "token_invalid" });
      first.close();
      await daemon.expect(RelayOp.PEER_CLOSE);

      // PUT that drops a device tombstones it; PUT that brings it back re-admits it.
      await admit(main, m, []);
      expect(await refusedWith(main, deviceToken(main, m, other))).toMatchObject({ status: 403, code: "device_revoked" });
      await admit(main, m, [other]);
      const back = await openPhone(main, m, daemon, other);
      back.ws.close();
      await daemon.expect(RelayOp.PEER_CLOSE);
      daemon.ws.close();
    });

    test("replay budgets are per principal: a device flood can't starve the daemon; a revoked device writes nothing", async () => {
      const m = await register(main);
      const daemon = await connectDaemon(main, m);
      const [flooder, other] = [newPhone(), newPhone()];
      await admit(main, m, [flooder, other]);
      // Each accepted connect spends one row of the flooder's own budget (each new socket supersedes the last).
      let accepted = 0;
      let refusal: { status: number; code: string | null } | null = null;
      for (let i = 0; i < wire.relay.replay.perDevice + 1 && refusal === null; i++) {
        const result = await connect(main, deviceToken(main, m, flooder));
        if (result.ws !== undefined) { accepted += 1; result.ws.terminate(); } else refusal = result.refused;
      }
      expect(accepted).toBe(wire.relay.replay.perDevice);
      expect(refusal).toMatchObject({ status: 429, code: "replay_cache_full" });
      // The daemon's admission calls and another device are untouched.
      expect((await admin(main, m, "PUT", devicesPath(m), { devices: [flooder, other].map(p => ({ deviceId: p.deviceId, deviceRelayPub: p.key.publicKey.toString("base64url") })) })).status).toBe(200);
      const second = await connectDaemon(main, m);
      while (daemon.inbox.pending > 0) await daemon.envelope();
      const o = await openPhone(main, m, second, other);
      o.ws.close();
      await second.expect(RelayOp.PEER_CLOSE);

      // Revoked: 403 every time, and the replay cache doesn't grow.
      expect((await admin(main, m, "DELETE", `${devicesPath(m)}/${other.deviceId}`)).status).toBe(200);
      const before = await main.replayRows(m.machineId);
      for (let i = 0; i < 5; i++) expect(await refusedWith(main, deviceToken(main, m, other))).toMatchObject({ status: 403, code: "device_revoked" });
      expect(await main.replayRows(m.machineId)).toBe(before);
      second.ws.close();
    });

    test("refusals over HTTP upgrade carry the header and Retry-After where the table says", async () => {
      const r = await refusedWith(main, undefined);
      expect(r).toMatchObject({ status: 401, code: "token_invalid" });
      expect(JSON.parse(r.body)).toEqual({ error: "token_invalid" });
      const unknownKey = generateEd25519KeyPair();
      expect(await refusedWith(main, daemonWsToken(main, { machineId: deriveMachineId(unknownKey.publicKey), key: unknownKey }))).toMatchObject({ status: 404, code: "machine_unknown" });

      const m = await register(main);
      const daemon = await connectDaemon(main, m);
      const phones = Array.from({ length: wire.relay.limits.socketsPerMachine + 1 }, () => newPhone());
      await admit(main, m, phones);
      const open = [];
      for (const phone of phones.slice(0, wire.relay.limits.socketsPerMachine)) open.push(await openPhone(main, m, daemon, phone));
      const full = await refusedWith(main, deviceToken(main, m, phones[wire.relay.limits.socketsPerMachine]!));
      expect(full).toMatchObject({ status: 429, code: "too_many_peers" });
      expect(Number(full.headers["retry-after"])).toBeGreaterThan(0);
      // The same device reconnecting is not a fifth socket: it replaces its own older one.
      const again = await connectOk(main, deviceToken(main, m, phones[0]!));
      expect(await closeOf(open[0]!.ws)).toMatchObject({ code: CLOSE.superseded });
      expect((await daemon.expect(RelayOp.PEER_CLOSE)).connId).toBe(open[0]!.connId);
      await daemon.expect(RelayOp.PEER_OPEN);
      again.close();
      for (const phone of open.slice(1)) phone.ws.close();
      daemon.ws.close();
    });

    test("a new socket for the same device supersedes the old one (4409), PEER_CLOSE then PEER_OPEN", async () => {
      const m = await register(main);
      const daemon = await connectDaemon(main, m);
      const phone = newPhone();
      await admit(main, m, [phone]);
      const first = await openPhone(main, m, daemon, phone);
      const second = await connectOk(main, deviceToken(main, m, phone));
      expect(await closeOf(first.ws)).toMatchObject({ code: CLOSE.superseded, reason: "superseded" });
      const closeEnv = await daemon.expect(RelayOp.PEER_CLOSE);
      expect(closeEnv.connId).toBe(first.connId);
      expect(JSON.parse(closeEnv.payload.toString("utf8"))).toEqual({ reason: "superseded" });
      const openEnv = await daemon.expect(RelayOp.PEER_OPEN);
      expect(openEnv.connId).toBeGreaterThan(first.connId);
      second.close();
      await daemon.expect(RelayOp.PEER_CLOSE);
      daemon.ws.close();
    });

    test("pair tokens allow three uses; a pair socket with no daemon gets 503", async () => {
      const m = await register(main);
      const pairToken = token(main, m.key.privateKey, { role: "pair", machineId: m.machineId, pairSessionId: "pair_session_1" });
      expect(await refusedWith(main, pairToken)).toMatchObject({ status: 503, code: "daemon_unavailable" }); // use 1 (consumed, then 503)
      const daemon = await connectDaemon(main, m);
      const a = await connectOk(main, pairToken); // use 2
      const open = await daemon.expect(RelayOp.PEER_OPEN);
      expect(JSON.parse(open.payload.toString("utf8"))).toEqual({ role: "pair", id: "pair_session_1" });
      const b = await connectOk(main, pairToken); // use 3: two phones may scan one code (the Mac decides who wins)
      await daemon.expect(RelayOp.PEER_OPEN);
      expect(await refusedWith(main, pairToken)).toMatchObject({ status: 401, code: "token_invalid" });
      a.close();
      b.close();
      await daemon.expect(RelayOp.PEER_CLOSE);
      await daemon.expect(RelayOp.PEER_CLOSE);
      daemon.ws.close();
    });

    test("routing: distinct connIds, data both ways, one PEER_CLOSE per phone, none echoed for the daemon's own", async () => {
      const m = await register(main);
      const daemon = await connectDaemon(main, m);
      const [p1, p2] = [newPhone(), newPhone()];
      await admit(main, m, [p1, p2]);
      const a = await openPhone(main, m, daemon, p1);
      const b = await openPhone(main, m, daemon, p2);
      expect(a.connId).not.toBe(b.connId);

      await sendBinary(a.ws, Buffer.from("from-a"));
      const up = await daemon.expect(RelayOp.PEER_DATA);
      expect({ connId: up.connId, text: up.payload.toString("utf8") }).toEqual({ connId: a.connId, text: "from-a" });
      daemon.data(b.connId, Buffer.from("to-b"));
      expect((await b.inbox.next()).toString("utf8")).toBe("to-b");

      // The phone closes: exactly one PEER_CLOSE, and the client sees its own close code come back (the handshake
      // completes instead of ending in 1006).
      a.ws.close(1000, "bye");
      expect(await a.inbox.closed).toMatchObject({ code: 1000 });
      const closed = await daemon.expect(RelayOp.PEER_CLOSE);
      expect({ connId: closed.connId, body: JSON.parse(closed.payload.toString("utf8")) }).toEqual({ connId: a.connId, body: { reason: "peer_closed" } });
      // A late frame for that phone is ignored (the daemon stays up and hears nothing back).
      daemon.data(a.connId, Buffer.from("late"));
      await expectQuietAndAlive(daemon);

      // The daemon closes b: b gets 1000 closed_by_daemon and no PEER_CLOSE comes back.
      daemon.send(RelayOp.PEER_CLOSE, b.connId, Buffer.from(JSON.stringify({ reason: "done" })));
      expect(await b.inbox.closed).toMatchObject({ code: 1000, reason: "closed_by_daemon" });
      await expectQuietAndAlive(daemon);

      // connIds are never reused.
      const c = await openPhone(main, m, daemon, p1);
      expect(c.connId).toBeGreaterThan(b.connId);
      c.ws.close();
      await daemon.expect(RelayOp.PEER_CLOSE);
      daemon.ws.close();
    });

    test("revocation of a live phone closes it 4403 and tells the daemon", async () => {
      const m = await register(main);
      const daemon = await connectDaemon(main, m);
      const [p1, p2] = [newPhone(), newPhone()];
      await admit(main, m, [p1, p2]);
      const a = await openPhone(main, m, daemon, p1);
      const b = await openPhone(main, m, daemon, p2);
      expect((await admin(main, m, "DELETE", `${devicesPath(m)}/${p1.deviceId}`)).status).toBe(200);
      expect(await a.inbox.closed).toMatchObject({ code: CLOSE.revoked, reason: "device_revoked" });
      const env = await daemon.expect(RelayOp.PEER_CLOSE);
      expect({ connId: env.connId, body: JSON.parse(env.payload.toString("utf8")) }).toEqual({ connId: a.connId, body: { reason: "device_revoked" } });
      await admit(main, m, []); // PUT removal closes b the same way
      expect(await b.inbox.closed).toMatchObject({ code: CLOSE.revoked });
      expect((await daemon.expect(RelayOp.PEER_CLOSE)).connId).toBe(b.connId);
      daemon.ws.close();
    });

    test("a newer daemon supersedes the old (4409); the old one's phones get 4503 and the new daemon hears nothing of them", async () => {
      const m = await register(main);
      const old = await connectDaemon(main, m);
      const phone = newPhone();
      await admit(main, m, [phone]);
      const p = await openPhone(main, m, old, phone);
      const next = await connectDaemon(main, m);
      expect(await old.closed).toMatchObject({ code: CLOSE.superseded, reason: "superseded" });
      expect(await p.inbox.closed).toMatchObject({ code: CLOSE.daemonGone, reason: "daemon_gone" });
      await expectQuietAndAlive(next);
      // Phones reach the new daemon.
      const again = await openPhone(main, m, next, phone);
      again.ws.close();
      await next.expect(RelayOp.PEER_CLOSE);
      next.ws.close();
    });

    test("the daemon leaving closes its phones 4503", async () => {
      const m = await register(main);
      const daemon = await connectDaemon(main, m);
      const phone = newPhone();
      await admit(main, m, [phone]);
      const p = await openPhone(main, m, daemon, phone);
      daemon.ws.close(1000);
      expect(await p.inbox.closed).toMatchObject({ code: CLOSE.daemonGone });
      expect(await daemon.closed).toMatchObject({ code: 1000 });
    });

    test("close codes: text and oversize frames from a phone, protocol errors from the daemon (4400)", async () => {
      const m = await register(main);
      const daemon = await connectDaemon(main, m);
      const [p1, p2, p3] = [newPhone(), newPhone(), newPhone()];
      await admit(main, m, [p1, p2, p3]);
      const a = await openPhone(main, m, daemon, p1);
      a.ws.send("text");
      expect(await a.inbox.closed).toMatchObject({ code: CLOSE.protocol, reason: "binary_only" });
      expect(JSON.parse((await daemon.expect(RelayOp.PEER_CLOSE)).payload.toString("utf8"))).toEqual({ reason: "binary_only" });
      const b = await openPhone(main, m, daemon, p2);
      b.ws.send(Buffer.alloc(MAX_NOISE_MESSAGE_BYTES + 1), { binary: true });
      expect(await b.inbox.closed).toMatchObject({ code: CLOSE.protocol, reason: "oversize" });
      await daemon.expect(RelayOp.PEER_CLOSE);

      const c = await openPhone(main, m, daemon, p3);
      daemon.ws.send(Buffer.from([0x09, 0, 0, 0, 0]), { binary: true });
      expect(await daemon.closed).toMatchObject({ code: CLOSE.protocol });
      expect(await c.inbox.closed).toMatchObject({ code: CLOSE.daemonGone });

      for (const bad of [
        (d: Daemon) => d.ws.send("text"),
        (d: Daemon) => d.send(RelayOp.HEARTBEAT_ACK, 0, Buffer.alloc(8)),
        (d: Daemon) => d.send(RelayOp.HEARTBEAT, 0, Buffer.alloc(7)),
        (d: Daemon) => d.send(RelayOp.HEARTBEAT, 3, Buffer.alloc(8)),
        (d: Daemon) => d.send(RelayOp.PEER_OPEN, 1, Buffer.from("{}")),
        (d: Daemon) => d.ws.send(Buffer.from([0x02, 0, 0]), { binary: true }),
      ]) {
        const d = await connectDaemon(main, m);
        bad(d);
        expect(await d.closed).toMatchObject({ code: CLOSE.protocol });
      }
    });

    test("heartbeat: 0x04 is answered with 0x05 echoing the 8 bytes", async () => {
      const m = await register(main);
      const daemon = await connectDaemon(main, m);
      const stamp = 1_764_000_000_123;
      daemon.heartbeat(stamp);
      const ack = await daemon.expect(RelayOp.HEARTBEAT_ACK);
      expect(ack.connId).toBe(0);
      expect(ack.payload.readBigUInt64BE(0)).toBe(BigInt(stamp));
      daemon.ws.close();
    });

    test("rate limits close the phone (4429), never the daemon", async () => {
      const m = await register(main);
      const daemon = await connectDaemon(main, m);
      const [p1, p2] = [newPhone(), newPhone()];
      await admit(main, m, [p1, p2]);

      // Up: a burst past the frame bucket.
      const a = await openPhone(main, m, daemon, p1);
      const frames = wire.relay.limits.phoneUp.framesBurst + 20;
      for (let i = 0; i < frames; i++) a.ws.send(Buffer.from([i & 0xff]), { binary: true });
      expect(await a.inbox.closed).toMatchObject({ code: CLOSE.rateLimited, reason: "rate_limited" });
      let forwarded = 0;
      for (;;) {
        const env = await daemon.envelope();
        if (env.op === RelayOp.PEER_DATA) { forwarded += 1; continue; }
        expect(env.op).toBe(RelayOp.PEER_CLOSE);
        expect(JSON.parse(env.payload.toString("utf8"))).toEqual({ reason: "rate_limited" });
        break;
      }
      expect(forwarded).toBeGreaterThanOrEqual(wire.relay.limits.phoneUp.framesBurst - 1); // msg1 took one
      expect(forwarded).toBeLessThan(frames);
      await expectQuietAndAlive(daemon);

      // Down: the daemon sends one phone more than its burst.
      const b = await openPhone(main, m, daemon, p2);
      const chunk = Buffer.alloc(MAX_NOISE_MESSAGE_BYTES, 7);
      const count = Math.ceil((wire.relay.limits.phoneDown.bytesBurst * 1.25) / chunk.length);
      for (let i = 0; i < count; i++) daemon.data(b.connId, chunk);
      expect(await b.inbox.closed).toMatchObject({ code: CLOSE.rateLimited });
      const env = await daemon.expect(RelayOp.PEER_CLOSE);
      expect({ connId: env.connId, body: JSON.parse(env.payload.toString("utf8")) }).toEqual({ connId: b.connId, body: { reason: "rate_limited" } });
      await expectQuietAndAlive(daemon);
      daemon.ws.close();
    });

    test("DELETE /v1/machines/:id deletes the room: sockets closed, then machine_unknown until it registers again", async () => {
      const m = await register(main);
      const daemon = await connectDaemon(main, m);
      const phone = newPhone();
      await admit(main, m, [phone]);
      const p = await openPhone(main, m, daemon, phone);
      expect((await admin(main, m, "DELETE", `/v1/machines/${m.machineId}`)).status).toBe(200);
      expect(await daemon.closed).toMatchObject({ code: 1000, reason: "machine_deleted" });
      expect(await p.inbox.closed).toMatchObject({ code: CLOSE.daemonGone });
      await expectRefusal(await admin(main, m, "PUT", devicesPath(m), { devices: [] }), 404, "machine_unknown");
      expect(await refusedWith(main, daemonWsToken(main, m))).toMatchObject({ status: 404, code: "machine_unknown" });
      // A wrong-method token for the machine path is refused like any other.
      await register(main, m.key);
      await expectRefusal(await admin(main, m, "DELETE", `/v1/machines/${m.machineId}`, undefined, adminToken(main, m, "PUT", `/v1/machines/${m.machineId}`)), 401, "token_invalid");
      // Registered again: an empty room (the old device is not admitted, and not tombstoned either).
      const fresh = await connectDaemon(main, m);
      expect(await refusedWith(main, deviceToken(main, m, phone))).toMatchObject({ status: 404, code: "device_unknown" });
      fresh.ws.close();
    });

    describe("deadlines (short timings)", () => {
      test("a phone that sends nothing is closed 4408 first_frame_timeout", async () => {
        const m = await register(fast);
        const daemon = await connectDaemon(fast, m);
        const phone = newPhone();
        await admit(fast, m, [phone]);
        const p = await openSilentPhone(fast, m, daemon, phone);
        // Keep the daemon alive meanwhile.
        const beat = setInterval(() => daemon.heartbeat(Date.now()), 300);
        try {
          for (;;) {
            const env = await daemon.envelope();
            if (env.op === RelayOp.HEARTBEAT_ACK) continue;
            expect({ op: env.op, connId: env.connId, body: JSON.parse(env.payload.toString("utf8")) }).toEqual({ op: RelayOp.PEER_CLOSE, connId: p.connId, body: { reason: "first_frame_timeout" } });
            break;
          }
          clearInterval(beat);
          while (daemon.inbox.pending > 0) expect((await daemon.envelope()).op).toBe(RelayOp.HEARTBEAT_ACK);
          if (fast.silentSocketMissesClose) {
            // The close frame can't reach a socket that never spoke (see RelayTarget); the relay has dropped it all the
            // same: what it sends now is never forwarded.
            if (p.ws.readyState === p.ws.OPEN) await sendBinary(p.ws, Buffer.from("late"));
            for (let round = 0; round < 3; round++) await expectQuietAndAlive(daemon);
            p.ws.terminate();
          } else {
            expect(await p.inbox.closed).toMatchObject({ code: CLOSE.timeout, reason: "first_frame_timeout" });
          }
        } finally {
          clearInterval(beat);
        }
        daemon.ws.close();
      });

      test("idle counts traffic in either direction; silence closes the phone 4408 idle_timeout", async () => {
        const m = await register(fast);
        const daemon = await connectDaemon(fast, m);
        const phone = newPhone();
        await admit(fast, m, [phone]);
        const p = await openPhone(fast, m, daemon, phone);
        await sendBinary(p.ws, Buffer.from("hello"));
        await daemon.expect(RelayOp.PEER_DATA);
        // Only daemon → phone traffic (and heartbeats) for more than twice the idle window: the phone stays.
        const started = Date.now();
        const span = fast.timing.phoneIdleMs * 2 + 500;
        let received = 0;
        p.ws.on("message", () => { received += 1; });
        const pump = setInterval(() => { daemon.heartbeat(Date.now()); daemon.data(p.connId, Buffer.from("tick")); }, 250);
        let alive = true;
        void p.inbox.closed.then(() => { alive = false; });
        await bounded(new Promise<void>(resolve => {
          const check = setInterval(() => { if (Date.now() - started >= span || !alive) { clearInterval(check); resolve(); } }, 50);
        }), "the idle window to pass", span + 5000);
        clearInterval(pump);
        expect(alive).toBe(true);
        expect(received).toBeGreaterThan(3);
        // Now silence (the daemon keeps beating so only the phone's idle deadline can fire).
        const beat = setInterval(() => daemon.heartbeat(Date.now()), 300);
        try {
          expect(await p.inbox.closed).toMatchObject({ code: CLOSE.timeout, reason: "idle_timeout" });
        } finally {
          clearInterval(beat);
        }
        daemon.ws.close();
      });

      test("a daemon that heartbeats stays; a silent one is closed 4408 and its phones get 4503", async () => {
        const m = await register(fast);
        const daemon = await connectDaemon(fast, m);
        const started = Date.now();
        const span = fast.timing.daemonSilenceMs * 2 + 500;
        const beat = setInterval(() => daemon.heartbeat(Date.now()), 300);
        let alive = true;
        void daemon.closed.then(() => { alive = false; });
        await bounded(new Promise<void>(resolve => {
          const check = setInterval(() => { if (Date.now() - started >= span || !alive) { clearInterval(check); resolve(); } }, 50);
        }), "the silence window to pass", span + 5000);
        clearInterval(beat);
        expect(alive).toBe(true);

        const phone = newPhone();
        await admit(fast, m, [phone]);
        const p = await connectOk(fast, deviceToken(fast, m, phone));
        const phoneClosed = closeOf(p);
        const keepPhone = setInterval(() => { p.send(Buffer.from([1]), { binary: true }); }, 200);
        try {
          expect(await daemon.closed).toMatchObject({ code: CLOSE.timeout, reason: "heartbeat_timeout" });
          expect(await phoneClosed).toMatchObject({ code: CLOSE.daemonGone });
        } finally {
          clearInterval(keepPhone);
        }
      });
    });

    test("connects are limited per client across machines: varying the machine id doesn't escape the limit", async () => {
      const limited = await factory({ registerPerMin: 10_000, connectPerMin: 10_000, clientPerMin: 5 });
      try {
        const results: Array<{ status: number; code: string | null }> = [];
        for (let i = 0; i < 8; i++) {
          const key = generateEd25519KeyPair();
          const r = await refusedWith(limited, daemonWsToken(limited, { machineId: deriveMachineId(key.publicKey), key }));
          results.push({ status: r.status, code: r.code });
        }
        expect(results.slice(0, 5).every(one => one.status === 404 && one.code === "machine_unknown")).toBe(true);
        expect(results.slice(5).every(one => one.status === 429 && one.code === "rate_limited")).toBe(true);
      } finally {
        await limited.close();
      }
    });

    test("registration is rate limited per client address (429 rate_limited + Retry-After)", async () => {
      const limited = await factory({ registerPerMin: 3, connectPerMin: 10_000, clientPerMin: 10_000 });
      try {
        const statuses: Array<{ status: number; code: string | null; retry: string | null }> = [];
        for (let i = 0; i < 5; i++) {
          const res = await fetch(`${limited.url}/v1/challenge`, { method: "POST" });
          statuses.push({ status: res.status, code: res.headers.get(HEADER), retry: res.headers.get("retry-after") });
          await res.arrayBuffer();
        }
        expect(statuses.slice(0, 3).every(one => one.status === 200)).toBe(true);
        const last = statuses[4]!;
        expect({ status: last.status, code: last.code }).toEqual({ status: 429, code: "rate_limited" });
        expect(Number(last.retry)).toBeGreaterThan(0);
      } finally {
        await limited.close();
      }
    });
  });
}

export type { RelayTarget, RelayTargetFactory };
