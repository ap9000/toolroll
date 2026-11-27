/**
 * Cloudflare-only behaviour of the worker under Miniflare: hibernation and eviction (R1), the SQLite tables and the
 * alarm's housekeeping (replay rows, tombstones, 90-day room GC), configuration and health, secret rotation, logs.
 * The shared wire contract is relay/conformance/suite.ts.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  admin,
  adminToken,
  admit,
  daemonWsToken,
  bounded,
  closeOf,
  connectDaemon,
  newPhone,
  openPhone,
  refusedWith,
  register,
  sendBinary,
} from "../../conformance/client.js";
import { deriveMachineId } from "../../../src/companion/noise.js";
import { generateEd25519KeyPair, RelayOp, signRegistrationPop } from "../../../src/companion/relay-auth.js";
import { CLOSE, LIMITS, REPLAY, timingFrom } from "../src/contract.js";
import { startWorker, TEST_CHALLENGE_SECRET, type RunningWorker } from "./miniflare.js";

const wire = JSON.parse(readFileSync(new URL("../../../test/fixtures/companion-wire.json", import.meta.url), "utf8"));
const contract = JSON.parse(readFileSync(new URL("../../../test/fixtures/companion-relay-contract.json", import.meta.url), "utf8"));

const workers: RunningWorker[] = [];
afterEach(async () => {
  while (workers.length > 0) await workers.pop()!.close();
});

async function worker(opts: Parameters<typeof startWorker>[0] = {}): Promise<RunningWorker> {
  const w = await startWorker({ registerPerMin: 10_000, connectPerMin: 10_000, clientPerMin: 10_000, ...opts });
  workers.push(w);
  return w;
}

async function sql<T extends Record<string, unknown>>(w: RunningWorker, machineId: string, query: string): Promise<T[]> {
  const storage = await w.mf.unsafeGetDurableObjectStorage(w.scriptName, "MachineRoomDO", { name: machineId });
  return storage.exec<T & Record<string, string | number | null | ArrayBuffer>>(query) as Promise<T[]>;
}

/** The room's own tables (not workerd's internal ones). */
async function userTables(w: RunningWorker, machineId: string): Promise<string[]> {
  const rows = await sql<{ name: string }>(w, machineId, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  return rows.map(r => r.name).filter(name => !name.startsWith("_cf") && !name.startsWith("sqlite_") && !name.startsWith("__miniflare"));
}

/** Waits until `check` holds, re-reading on every turn of the event loop's timers (a ceiling, not the fact). */
async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  await bounded((async () => { while (!(await check())) await new Promise(resolve => setImmediate(resolve)); })(), what);
}

/** Waits until wall-clock time reaches `at` (the fact under test is a deadline passing). */
async function clockPasses(at: number): Promise<void> {
  await until("the deadline to pass", async () => Date.now() >= at);
}

describe("contract numbers", () => {
  test("the worker's limits and close codes are the frozen fixture's; timing overrides can only shorten", () => {
    const L = wire.relay.limits;
    expect({ ...CLOSE, normal: undefined }).toEqual({ ...wire.relay.closeCodes, normal: undefined });
    expect([LIMITS.phoneFirstFrameMs, LIMITS.phoneIdleMs, LIMITS.socketsPerMachine, LIMITS.devicesPerMachine]).toEqual([L.phoneFirstFrameMs, L.phoneIdleMs, L.socketsPerMachine, L.devicesPerMachine]);
    expect([LIMITS.phoneUp, LIMITS.phoneDown, LIMITS.machineUp, LIMITS.machineDown]).toEqual([L.phoneUp, L.phoneDown, L.machineUp, L.machineDown]);
    expect(LIMITS.daemonSilenceMs).toBe(wire.relay.heartbeat.relayTimeoutMs);
    expect(LIMITS.tombstoneMs).toBe(wire.relay.tombstoneDays * 86_400_000);
    expect(LIMITS.roomIdleDeleteMs).toBe(wire.relay.roomIdleDeleteDays * 86_400_000);
    expect(LIMITS.tombstonesPerMachine).toBe(contract.tombstonesPerMachine);
    expect(REPLAY).toEqual(contract.replayBudgets);
    expect(timingFrom({ RELAY_PHONE_IDLE_MS: "500", RELAY_PHONE_FIRST_FRAME_MS: "999999", RELAY_DAEMON_SILENCE_MS: "-1" })).toEqual({
      phoneFirstFrameMs: LIMITS.phoneFirstFrameMs, phoneIdleMs: 500, daemonSilenceMs: LIMITS.daemonSilenceMs,
    });
  });
});

describe("hibernation (R1)", () => {
  test("deadlines live in socket attachments: a fresh instance after eviction keeps healthy sockets and still times out idle ones", async () => {
    const w = await worker({ timing: { phoneFirstFrameMs: 300, phoneIdleMs: 2500, daemonSilenceMs: 2500 } });
    const m = await register(w);
    const daemon = await connectDaemon(w, m);
    const phone = newPhone();
    await admit(w, m, [phone]);
    const opened = Date.now();
    const p = await openPhone(w, m, daemon, phone); // its first frame is in
    const evict = () => w.mf.unsafeEvictDurableObject(w.scriptName, "MachineRoomDO", { name: m.machineId, webSockets: "hibernate" });
    await evict();
    // The first-frame alarm fires on a fresh instance. Before the fix it found no in-memory state and closed the phone
    // as first_frame_timeout. Keep the daemon beating (each beat wakes yet another fresh instance).
    const beat = setInterval(() => daemon.heartbeat(Date.now()), 400);
    try {
      await clockPasses(opened + 300 + 700);
      await sendBinary(p.ws, Buffer.from("still here"));
      for (;;) {
        const env = await daemon.envelope();
        if (env.op === RelayOp.HEARTBEAT_ACK) continue;
        expect({ op: env.op, connId: env.connId }).toEqual({ op: RelayOp.PEER_DATA, connId: p.connId });
        break;
      }
      await evict();
      // Now the phone goes quiet: the idle deadline (from the attachment, across the eviction) closes it.
      expect(await p.inbox.closed).toMatchObject({ code: CLOSE.timeout, reason: "idle_timeout" });
    } finally {
      clearInterval(beat);
    }
    // And a silent daemon is closed from its attachment's timestamp too, after another eviction.
    await evict();
    expect(await daemon.closed).toMatchObject({ code: CLOSE.timeout, reason: "heartbeat_timeout" });
  });

  test("with no sockets left, only the far housekeeping alarm remains", async () => {
    const w = await worker({ timing: { phoneFirstFrameMs: 300, phoneIdleMs: 600, daemonSilenceMs: 600 } });
    const m = await register(w);
    const daemon = await connectDaemon(w, m);
    expect(await daemon.closed).toMatchObject({ code: CLOSE.timeout });
    // The room still exists and answers; its tables hold the machine row and the daemon's one replay row.
    expect(await sql<{ n: number }>(w, m.machineId, "SELECT COUNT(*) AS n FROM machine")).toEqual([{ n: 1 }]);
    expect(await sql<{ principal: string; kind: string; uses: number }>(w, m.machineId, "SELECT principal, kind, uses FROM jti")).toEqual([{ principal: "daemon", kind: "daemon", uses: 1 }]);
  });
});

describe("storage is created only by registration", () => {
  test("a flood of made-up machine ids from one client is rate limited and leaves no Durable Object storage behind", async () => {
    const w = await worker({ clientPerMin: 6 });
    const statuses: number[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const key = generateEd25519KeyPair();
      const m = { machineId: deriveMachineId(key.publicKey), key };
      ids.push(m.machineId);
      const res = i % 2 === 0
        ? await admin(w, m, "PUT", `/v1/machines/${m.machineId}/devices`, { devices: [] })
        : await fetch(`${w.url}/v1/machines/${m.machineId}`, { method: "DELETE", headers: { authorization: `Bearer ${adminToken(w, m, "DELETE", `/v1/machines/${m.machineId}`)}` } });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses.slice(0, 6)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(statuses.slice(6)).toEqual([429, 429, 429, 429]);
    // Miniflare lists every object a request reached; none of them holds a table or an alarm.
    for (const id of ids) expect(await userTables(w, id)).toEqual([]);
  });

  test("unknown-machine connects and admission calls write nothing; register creates the room", async () => {
    const w = await worker();
    const strangers = Array.from({ length: 3 }, () => { const key = generateEd25519KeyPair(); return { machineId: deriveMachineId(key.publicKey), key }; });
    for (const m of strangers) {
      expect(await refusedWith(w, daemonWsToken(w, m))).toMatchObject({ status: 404, code: "machine_unknown" });
      expect((await admin(w, m, "DELETE", `/v1/machines/${m.machineId}/devices/dev_1`)).status).toBe(404);
      expect(await userTables(w, m.machineId)).toEqual([]);
    }
    const real = await register(w);
    expect(await userTables(w, real.machineId)).toEqual(["device", "jti", "machine", "tombstone"]);
    // A deleted room leaves nothing either, and refuses as unknown without recreating tables.
    expect((await admin(w, real, "DELETE", `/v1/machines/${real.machineId}`)).status).toBe(200);
    expect(await userTables(w, real.machineId)).toEqual([]);
    expect((await admin(w, real, "PUT", `/v1/machines/${real.machineId}/devices`, { devices: [] })).status).toBe(404);
    expect(await userTables(w, real.machineId)).toEqual([]);
  });
});

describe("SQLite tables and housekeeping", () => {
  test("replay rows are per principal, keyed (principal, id), and expired ones are pruned by the alarm", async () => {
    const w = await worker();
    const m = await register(w);
    const [a, b] = [newPhone(), newPhone()];
    await admit(w, m, [a, b]);
    const columns = await sql<{ name: string }>(w, m.machineId, "SELECT name FROM pragma_table_info('jti') ORDER BY cid");
    expect(columns.map(c => c.name)).toEqual(["principal", "kind", "id", "exp", "uses"]);
    const indexes = await sql<{ name: string }>(w, m.machineId, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jti' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    expect(indexes.map(i => i.name)).toEqual(["jti_exp", "jti_kind"]);
    const old = Math.floor(Date.now() / 1000) - 120;
    await sql(w, m.machineId, `INSERT INTO jti (principal, kind, id, exp, uses) VALUES ('d:${a.deviceId}', 'device', 'old-token-id-0001', ${old}, 1), ('daemon', 'daemon', 'old-token-id-0002', ${old}, 1)`);
    // A PUT that drops a device re-arms the alarm at the earliest housekeeping deadline — here already past.
    await admit(w, m, [a]);
    await until("expired replay rows to be pruned", async () => (await sql(w, m.machineId, `SELECT 1 FROM jti WHERE exp = ${old}`)).length === 0);
    expect((await sql(w, m.machineId, "SELECT 1 FROM jti")).length).toBeGreaterThan(0); // the live ones stay
  });

  test("a full principal budget is refused for that principal only", async () => {
    const w = await worker();
    const m = await register(w);
    const exp = Math.floor(Date.now() / 1000) + 200;
    await sql(w, m.machineId, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${REPLAY.daemon}) INSERT INTO jti (principal, kind, id, exp, uses) SELECT 'daemon', 'daemon', 'filler-' || i || '-xxxxxxxx', ${exp}, 1 FROM n`);
    const res = await admin(w, m, "PUT", `/v1/machines/${m.machineId}/devices`, { devices: [] });
    expect({ status: res.status, code: res.headers.get("toolroll-relay-error"), retry: Number(res.headers.get("retry-after")) > 0 }).toEqual({ status: 429, code: "replay_cache_full", retry: true });
    // Expired rows make room again (pruned inline before refusing).
    await sql(w, m.machineId, "UPDATE jti SET exp = 1 WHERE id = 'filler-1-xxxxxxxx'");
    expect((await admin(w, m, "PUT", `/v1/machines/${m.machineId}/devices`, { devices: [] })).status).toBe(200);
  });

  test("tombstones expire after 30 days and rooms without a daemon for 90 days are deleted by the alarm", async () => {
    const w = await worker();
    const m = await register(w);
    const [a, b, c] = [newPhone(), newPhone(), newPhone()];
    await admit(w, m, [a, b, c]);
    await admit(w, m, [b, c]); // tombstones a
    const stones = await sql<{ device_id: string; expires_at: number }>(w, m.machineId, "SELECT device_id, expires_at FROM tombstone");
    expect(stones.map(s => s.device_id)).toEqual([a.deviceId]);
    expect(Math.abs(stones[0]!.expires_at - (Date.now() + LIMITS.tombstoneMs))).toBeLessThan(60_000);
    await sql(w, m.machineId, `UPDATE tombstone SET expires_at = ${Date.now() - 1}`);
    await admit(w, m, [c]); // tombstones b and re-arms the alarm (a's tombstone is due)
    await until("the expired tombstone to go", async () => (await sql(w, m.machineId, `SELECT 1 FROM tombstone WHERE device_id = '${a.deviceId}'`)).length === 0);

    await sql(w, m.machineId, `UPDATE machine SET last_daemon_at = ${Date.now() - LIMITS.roomIdleDeleteMs - 1000}`);
    await admit(w, m, []); // re-arms at the (past) GC deadline
    await until("the room to be deleted", async () => (await admin(w, m, "PUT", `/v1/machines/${m.machineId}/devices`, { devices: [] })).status === 404);
  });
});

describe("configuration", () => {
  test("health shows the build and which settings are present; without a challenge secret registration is unavailable", async () => {
    const ok = await worker();
    const health = (await (await fetch(`${ok.url}/v1/health`)).json()) as Record<string, unknown>;
    expect(health).toEqual({ ok: true, version: 1, runtime: "cloudflare-do", build: "test", configured: { challengeSecret: true, publicHost: true, rateLimits: true } });

    const bare = await worker({ bindings: { CHALLENGE_SECRET: "" } });
    const res = await fetch(`${bare.url}/v1/health`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { configured: Record<string, boolean> }).configured.challengeSecret).toBe(false);
    const chal = await fetch(`${bare.url}/v1/challenge`, { method: "POST" });
    expect({ status: chal.status, code: chal.headers.get("toolroll-relay-error") }).toEqual({ status: 429, code: "rate_limited" });
  });

  test("CHALLENGE_SECRET rotation: the previous secret's challenges are accepted while it is set", async () => {
    const before = await worker();
    const { challenge } = (await (await fetch(`${before.url}/v1/challenge`, { method: "POST" })).json()) as { challenge: string };
    const registerWith = async (w: RunningWorker) => {
      const key = generateEd25519KeyPair();
      return (await fetch(`${w.url}/v1/machines/register`, {
        method: "POST",
        body: JSON.stringify({ relayMachinePub: key.publicKey.toString("base64url"), challenge, signature: signRegistrationPop(key.privateKey, w.publicHost, challenge) }),
      })).status;
    };
    const next = "the-next-challenge-secret-0123456789abcdef";
    expect(await registerWith(await worker({ bindings: { CHALLENGE_SECRET: next, CHALLENGE_SECRET_PREVIOUS: TEST_CHALLENGE_SECRET } }))).toBe(200);
    expect(await registerWith(await worker({ bindings: { CHALLENGE_SECRET: next } }))).toBe(401);
  });

  test("logs are structured and carry no tokens, keys, challenges or full ids", async () => {
    const w = await worker();
    const m = await register(w);
    const daemon = await connectDaemon(w, m);
    const phone = newPhone();
    await admit(w, m, [phone]);
    const p = await openPhone(w, m, daemon, phone);
    p.ws.send("text");
    await closeOf(p.ws);
    expect(await refusedWith(w, "junk.token")).toMatchObject({ status: 401 });
    await admin(w, m, "DELETE", `/v1/machines/${m.machineId}/devices/${phone.deviceId}`);
    daemon.ws.close();
    await until("log lines", async () => w.logs.some(line => line.includes("binary_only")));
    const text = w.logs.join("\n");
    for (const line of w.logs) expect(() => JSON.parse(line)).not.toThrow();
    expect(text).not.toContain(m.machineId);
    expect(text).not.toContain(phone.deviceId);
    expect(text).not.toContain(m.key.publicKey.toString("base64url"));
    expect(text).not.toContain(TEST_CHALLENGE_SECRET);
    expect(text).not.toContain("junk.token");
  });
});

describe("deploy smoke test", () => {
  test("scripts/smoke.ts passes against the worker (the same run relay:deploy does against staging and production)", async () => {
    const w = await worker();
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const run = spawn(process.execPath, ["--import", "tsx", "relay/cloudflare/scripts/smoke.ts", w.url, "test"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    run.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    run.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    const code = await bounded(new Promise<number | null>(resolve => run.once("close", resolve)), "the smoke test", 30_000);
    expect({ code, passed: output.includes("smoke passed") }).toEqual({ code: 0, passed: true });
  });
});
