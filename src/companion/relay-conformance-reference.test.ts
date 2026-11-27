/** Reference-relay-only behaviour (knobs the hosted relay doesn't have) and the contract's numbers, held to the frozen
 * fixtures. The shared contract itself is relay/conformance/suite.ts. */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import {
  admin,
  admit,
  bounded,
  connectDaemon,
  connectOk,
  deviceToken,
  newPhone,
  openPhone,
  refusedWith,
  register,
  sendBinary,
  type RelayTarget,
} from "../../relay/conformance/client.js";
import { deriveMachineId } from "./noise.js";
import {
  checkRelayClaims,
  generateEd25519KeyPair,
  parseRelayToken,
  RELAY_REPLAY_BUDGETS,
  RelayReplayCache,
  signRegistrationPop,
  signRelayToken,
} from "./relay-auth.js";
import { RELAY_LIMITS, RelayClose, startReferenceRelay, type ReferenceRelayOptions, type RunningReferenceRelay } from "./relay-server.js";

const wire = JSON.parse(readFileSync(new URL("../../test/fixtures/companion-wire.json", import.meta.url), "utf8"));
const contract = JSON.parse(readFileSync(new URL("../../test/fixtures/companion-relay-contract.json", import.meta.url), "utf8"));

const running: RunningReferenceRelay[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.close();
});

async function start(opts: ReferenceRelayOptions = {}): Promise<{ relay: RunningReferenceRelay; target: RelayTarget }> {
  const relay = await startReferenceRelay(opts);
  running.push(relay);
  return {
    relay,
    target: {
      name: "reference",
      url: relay.url,
      wsUrl: relay.wsUrl,
      publicHost: relay.publicHost,
      timing: { phoneFirstFrameMs: 10_000, phoneIdleMs: 90_000, daemonSilenceMs: 60_000 },
      replayRows: async machineId => relay.replayRows(machineId) ?? 0,
      close: relay.close,
    },
  };
}

describe("contract numbers", () => {
  test("the reference relay's limits and close codes are the frozen fixture's", () => {
    const L = wire.relay.limits;
    expect({
      phoneFirstFrameMs: RELAY_LIMITS.phoneFirstFrameMs,
      phoneIdleMs: RELAY_LIMITS.phoneIdleMs,
      socketsPerMachine: RELAY_LIMITS.socketsPerMachine,
      devicesPerMachine: RELAY_LIMITS.devicesPerMachine,
      phoneUp: RELAY_LIMITS.phoneUp,
      phoneDown: RELAY_LIMITS.phoneDown,
      machineUp: RELAY_LIMITS.machineUp,
      machineDown: RELAY_LIMITS.machineDown,
    }).toEqual({
      phoneFirstFrameMs: L.phoneFirstFrameMs, phoneIdleMs: L.phoneIdleMs, socketsPerMachine: L.socketsPerMachine,
      devicesPerMachine: L.devicesPerMachine, phoneUp: L.phoneUp, phoneDown: L.phoneDown, machineUp: L.machineUp, machineDown: L.machineDown,
    });
    expect(RELAY_LIMITS.daemonSilenceMs).toBe(wire.relay.heartbeat.relayTimeoutMs);
    expect(contract.replayBudgets).toEqual(RELAY_REPLAY_BUDGETS);
    expect(RELAY_LIMITS.tombstoneMs).toBe(wire.relay.tombstoneDays * 86_400_000);
    expect(RELAY_LIMITS.roomIdleDeleteMs).toBe(wire.relay.roomIdleDeleteDays * 86_400_000);
    const { normal: _normal, ...codes } = RelayClose;
    expect(codes).toEqual(wire.relay.closeCodes);
    expect(contract.refusals.map((r: { status: number; code: string }) => ({ status: r.status, code: r.code }))).toEqual(wire.relay.refusals);
    expect(contract.errorHeader).toBe(wire.relay.errorHeader);
    expect(contract.tombstonesPerMachine).toBe(RELAY_LIMITS.tombstonesPerMachine);
    expect(contract.rateLimitsPerMinute).toEqual({ register: RELAY_LIMITS.registerPerMin, connect: RELAY_LIMITS.connectPerMin, client: RELAY_LIMITS.clientPerMin });
  });

  test("claims: each rule, in order (structure before the key, the rest after the signature)", () => {
    const key = generateEd25519KeyPair();
    const machineId = deriveMachineId(key.publicKey);
    const now = 1_800_000_000;
    const sign = (claims: Record<string, unknown>) => {
      const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${encoded}.${Buffer.alloc(64).toString("base64url")}`;
    };
    const base = { v: 1, role: "device", machineId, deviceId: "dev_1", aud: "relay.example", jti: "a".repeat(16), iat: now, exp: now + 60 };
    const check = (claims: Record<string, unknown>, use: "ws" | { method: "PUT"; path: string } = "ws") => {
      const parsed = parseRelayToken(sign(claims));
      return parsed === null ? "unparsable" : (r => (r.ok ? "ok" : r.code))(checkRelayClaims(parsed, { aud: "relay.example", use, nowSec: now }));
    };
    expect(check(base)).toBe("ok");
    expect(check({ ...base, machineId: "UPPER" + machineId.slice(5) })).toBe("unparsable");
    expect(check({ ...base, deviceId: "a/b" })).toBe("unparsable");
    expect(check({ ...base, role: "admin" })).toBe("unparsable");
    expect(check({ ...base, extra: 1 })).toBe("token_invalid");
    expect(check({ ...base, aud: "other" })).toBe("token_invalid");
    expect(check({ ...base, jti: "x".repeat(65) })).toBe("token_invalid");
    expect(check({ ...base, exp: now })).toBe("token_invalid");
    expect(check({ ...base, exp: now + 301 })).toBe("token_invalid");
    expect(check({ ...base, htm: "PUT", htu: "/x" })).toBe("token_invalid");
    expect(check({ ...base, iat: now + 31, exp: now + 90 })).toBe("token_not_yet_valid");
    expect(check({ ...base, iat: now + 30, exp: now + 90 })).toBe("ok");
    expect(check({ ...base, iat: now - 100, exp: now - 30 })).toBe("token_expired");
    expect(check({ ...base, iat: now - 100, exp: now - 29 })).toBe("ok");
    const daemon = { v: 1, role: "daemon", machineId, aud: "relay.example", jti: "b".repeat(16), iat: now, exp: now + 60 };
    expect(check({ ...daemon, htm: "PUT", htu: "/p" }, { method: "PUT", path: "/p" })).toBe("ok");
    expect(check(daemon, { method: "PUT", path: "/p" })).toBe("token_invalid");
    expect(check({ ...daemon, htm: "PUT", htu: "/p/" }, { method: "PUT", path: "/p" })).toBe("token_invalid");
    // A real signer's token round-trips through the parser with its claims intact.
    const real = parseRelayToken(signRelayToken(key.privateKey, { role: "daemon", machineId, aud: "relay.example", nowSec: now }));
    expect(real?.raw["aud"]).toBe("relay.example");
  });

  test("replay cache: per-principal budgets; one use per daemon/device token, three per pair token", () => {
    const cache = new RelayReplayCache();
    const daemon = { kind: "daemon" as const, key: "daemon" };
    const dev = (id: string) => ({ kind: "device" as const, key: `d:${id}` });
    expect(cache.consume(daemon, "j1", 100, 1, 50)).toBe("ok");
    expect(cache.consume(daemon, "j1", 100, 1, 50)).toBe("replayed");
    // The same id under another principal is a different row (no collisions across principals).
    expect(cache.consume(dev("a"), "j1", 100, 1, 50)).toBe("ok");
    const pair = { kind: "pair" as const, key: "p:s1" };
    for (let i = 0; i < 3; i++) expect(cache.consume(pair, "p1", 100, 3, 50)).toBe("ok");
    expect(cache.consume(pair, "p1", 100, 3, 50)).toBe("replayed");
    // A device spends only its own 64 rows; the daemon and other devices are untouched.
    for (let i = 1; i < RELAY_REPLAY_BUDGETS.perDevice; i++) expect(cache.consume(dev("a"), `x${i}`, 100, 1, 50)).toBe("ok");
    expect(cache.consume(dev("a"), "over", 100, 1, 50)).toBe("full");
    expect(cache.consume(dev("b"), "fine", 100, 1, 50)).toBe("ok");
    expect(cache.consume(daemon, "fine", 100, 1, 50)).toBe("ok");
    // Rows are kept until 30 s past their expiry, then make room.
    expect(cache.consume(dev("a"), "over", 200, 1, 130)).toBe("full");
    expect(cache.consume(dev("a"), "over", 200, 1, 131)).toBe("ok");
    // Pair sessions: 16 each, 64 for all of them.
    const big = new RelayReplayCache();
    for (let s = 0; s < 4; s++) for (let i = 0; i < 16; i++) expect(big.consume({ kind: "pair", key: `p:${s}` }, `t${i}`, 100, 3, 50)).toBe("ok");
    expect(big.consume({ kind: "pair", key: "p:0" }, "t99", 100, 3, 50)).toBe("full");
    expect(big.consume({ kind: "pair", key: "p:new" }, "t0", 100, 3, 50)).toBe("full");
    expect(big.consume(daemon, "d", 100, 1, 50)).toBe("ok");
  });
});

describe("reference relay only", () => {
  test("the public host is the token audience and the registration host; it defaults to host:port", async () => {
    const { relay, target } = await start({ publicHost: "Relay.Example.Test" });
    expect(relay.publicHost).toBe("relay.example.test");
    const m = await register(target); // signs relay.example.test
    const daemon = await connectDaemon(target, m); // aud relay.example.test
    daemon.ws.close();
    const plain = await start();
    expect(plain.relay.publicHost).toBe(`127.0.0.1:${plain.relay.port}`);
    // A registration signed for the Host header instead of the configured host is refused.
    const key = generateEd25519KeyPair();
    const { challenge } = (await (await fetch(`${relay.url}/v1/challenge`, { method: "POST" })).json()) as { challenge: string };
    const res = await fetch(`${relay.url}/v1/machines/register`, {
      method: "POST",
      body: JSON.stringify({ relayMachinePub: key.publicKey.toString("base64url"), challenge, signature: signRegistrationPop(key.privateKey, new URL(relay.url).host, challenge) }),
    });
    expect({ status: res.status, code: res.headers.get("toolroll-relay-error") }).toEqual({ status: 401, code: "token_invalid" });
  });

  test("challenges are stateless: the previous secret is accepted while rotating, then not", async () => {
    const old = await start({ challengeSecret: "secret-a" });
    const { challenge } = (await (await fetch(`${old.relay.url}/v1/challenge`, { method: "POST" })).json()) as { challenge: string };
    const tryOn = async (opts: ReferenceRelayOptions) => {
      const { relay } = await start(opts);
      const key = generateEd25519KeyPair();
      return (await fetch(`${relay.url}/v1/machines/register`, {
        method: "POST",
        body: JSON.stringify({ relayMachinePub: key.publicKey.toString("base64url"), challenge, signature: signRegistrationPop(key.privateKey, relay.publicHost, challenge) }),
      })).status;
    };
    expect(await tryOn({ challengeSecret: "secret-b", previousChallengeSecret: "secret-a" })).toBe(200);
    expect(await tryOn({ challengeSecret: "secret-b" })).toBe(401);
  });

  test("trustProxy keys limits by the last X-Forwarded-For entry; without it the header is ignored", async () => {
    const challenge = (url: string, ip: string) => fetch(`${url}/v1/challenge`, { method: "POST", headers: { "x-forwarded-for": `198.51.100.9, ${ip}` } }).then(r => r.status);
    const proxied = await start({ trustProxy: true, registerPerMin: 1 });
    expect(await challenge(proxied.relay.url, "203.0.113.1")).toBe(200);
    expect(await challenge(proxied.relay.url, "203.0.113.1")).toBe(429);
    expect(await challenge(proxied.relay.url, "203.0.113.2")).toBe(200);
    expect(await challenge(proxied.relay.url, "2001:db8:1:2::5")).toBe(200);
    expect(await challenge(proxied.relay.url, "2001:db8:1:2::6")).toBe(429); // same /64
    const direct = await start({ registerPerMin: 1 });
    expect(await challenge(direct.relay.url, "203.0.113.1")).toBe(200);
    expect(await challenge(direct.relay.url, "203.0.113.2")).toBe(429);
  });

  test("the circuit breaker is a windowed budget that closes again on its own", async () => {
    let now = Date.now();
    const { relay, target } = await start({ globalFramesPerMin: 2, nowMs: () => now });
    const m = await register(target);
    const daemon = await connectDaemon(target, m);
    const phone = newPhone();
    await admit(target, m, [phone]);
    const p = await openPhone(target, m, daemon, phone); // its first frame is forwarded frame 1
    await sendBinary(p.ws, Buffer.from("two"));
    await daemon.envelope();
    const health = await fetch(`${relay.url}/v1/health`);
    expect(health.status).toBe(503);
    const shed = await fetch(`${relay.url}/v1/challenge`, { method: "POST" });
    expect({ status: shed.status, code: shed.headers.get("toolroll-relay-error"), retry: Number(shed.headers.get("retry-after")) > 0 }).toEqual({ status: 429, code: "rate_limited", retry: true });
    now += 60_000;
    expect((await fetch(`${relay.url}/v1/health`)).status).toBe(200);
    daemon.ws.close();
  });

  test("at the room cap only an idle room holding nothing makes way; a registration flood never evicts devices or tombstones", async () => {
    let now = Date.now();
    const { target } = await start({ maxRooms: 3, nowMs: () => now, registerPerMin: 1000 });
    const tokenNow = () => ({ nowSec: Math.floor(now / 1000) });
    const registerRaw = async () => {
      const key = generateEd25519KeyPair();
      const { challenge } = (await (await fetch(`${target.url}/v1/challenge`, { method: "POST" })).json()) as { challenge: string };
      const res = await fetch(`${target.url}/v1/machines/register`, {
        method: "POST",
        body: JSON.stringify({ relayMachinePub: key.publicKey.toString("base64url"), challenge, signature: signRegistrationPop(key.privateKey, target.publicHost, challenge) }),
      });
      return { status: res.status, code: res.headers.get("toolroll-relay-error"), retry: res.headers.get("retry-after") };
    };
    const withDevices = await register(target);
    const phone = newPhone();
    await admit(target, withDevices, [phone]);
    now += 1000;
    const withTombstone = await register(target);
    const gone = newPhone();
    await admit(target, withTombstone, [gone]);
    await admit(target, withTombstone, []);
    now += 1000;
    const empty = await register(target);
    now += 1000;
    // The empty room makes way once; after that nothing qualifies and every newcomer waits.
    expect((await registerRaw()).status).toBe(200);
    expect((await admin(target, empty, "PUT", `/v1/machines/${empty.machineId}/devices`, { devices: [] }, undefined)).status).toBe(404);
    // (the newcomer itself is empty and idle: the next one evicts it, so fill it first)
    for (let i = 0; i < 10; i++) {
      const r = await registerRaw();
      if (r.status !== 200) {
        expect(r).toMatchObject({ status: 429, code: "rate_limited" });
        expect(Number(r.retry)).toBeGreaterThan(0);
      }
    }
    const put = (m: typeof withDevices, devices: unknown[]) => fetch(`${target.url}/v1/machines/${m.machineId}/devices`, {
      method: "PUT",
      headers: { authorization: `Bearer ${signRelayToken(m.key.privateKey, { role: "daemon", machineId: m.machineId, aud: target.publicHost, htm: "PUT", htu: `/v1/machines/${m.machineId}/devices`, ...tokenNow() })}` },
      body: JSON.stringify({ devices }),
    });
    expect(await refusedWith(target, deviceToken(target, withTombstone, gone, tokenNow()))).toMatchObject({ status: 403, code: "device_revoked" });
    expect((await put(withDevices, [{ deviceId: phone.deviceId, deviceRelayPub: phone.key.publicKey.toString("base64url") }])).status).toBe(200);
    // Past the 90-day idle window even a room with devices may make way.
    now += RELAY_LIMITS.roomIdleDeleteMs;
    expect((await registerRaw()).status).toBe(200);
  });

  test("open sockets per client address are capped", async () => {
    const { target } = await start({ maxSocketsPerIp: 2 });
    const m = await register(target);
    const daemon = await connectDaemon(target, m);
    const phone = newPhone();
    await admit(target, m, [phone]);
    await openPhone(target, m, daemon, phone);
    expect(await refusedWith(target, deviceToken(target, m, newPhone()))).toMatchObject({ status: 429, code: "rate_limited" });
    daemon.ws.close();
  });

  test("sweep: tombstones expire after 30 days, rooms without a daemon for 90 days are deleted", async () => {
    let now = Date.now();
    const { relay, target } = await start({ nowMs: () => now });
    const tokenNow = () => ({ nowSec: Math.floor(now / 1000) });
    const m = await register(target);
    const phone = newPhone();
    await admit(target, m, [phone]);
    await admit(target, m, []);
    expect(await refusedWith(target, deviceToken(target, m, phone, tokenNow()))).toMatchObject({ status: 403, code: "device_revoked" });
    now += RELAY_LIMITS.tombstoneMs;
    relay.sweep();
    // Gone: with no daemon the relay says so (503); the device is simply unknown now.
    expect(await refusedWith(target, deviceToken(target, m, phone, tokenNow()))).toMatchObject({ status: 503, code: "daemon_unavailable" });
    const put = () => fetch(`${target.url}/v1/machines/${m.machineId}/devices`, {
      method: "PUT",
      headers: { authorization: `Bearer ${signRelayToken(m.key.privateKey, { role: "daemon", machineId: m.machineId, aud: target.publicHost, htm: "PUT", htu: `/v1/machines/${m.machineId}/devices`, ...tokenNow() })}` },
      body: JSON.stringify({ devices: [] }),
    });
    expect((await put()).status).toBe(200);
    now += RELAY_LIMITS.roomIdleDeleteMs - RELAY_LIMITS.tombstoneMs;
    relay.sweep();
    expect((await put()).status).toBe(404);
  });

  test("a daemon's own WebSocket ping does not count as a heartbeat: silence closes it 4408", async () => {
    const { target } = await start({ daemonSilenceMs: 300 });
    const m = await register(target);
    const ws = await connectOk(target, signRelayToken(m.key.privateKey, { role: "daemon", machineId: m.machineId, aud: target.publicHost }));
    const closed = new Promise<number>(resolve => ws.once("close", code => resolve(code)));
    const pinger = setInterval(() => ws.ping(), 50);
    try {
      expect(await bounded(closed, "the silence close")).toBe(RelayClose.timeout);
    } finally {
      clearInterval(pinger);
    }
  });
});
