/**
 * The running console, proved live (docs/plans/agents-cockpit.md B1): the discovery socket answers only `hello`; the
 * CLI attaches only when the live console answers fresh challenges on BOTH channels with the secret the database
 * holds, bound to the address it dialed. Each start binds its own socket (a fresh name in the record), so nothing
 * ever removes another console's; a second start on the same database (by any path spelling) never takes the record
 * from a live first one. A run folder open to others, a stale socket, a replayed hello, a stale record with a recycled
 * pid and a replacement listener, another build, a malformed proof and an IPv4-to-IPv6 relay are each refused or read
 * as nothing running; a live console reached directly passes.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect as tcpConnect, createServer as createTcpServer, createServer as createSocketServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { askSocket, claimInstance, recordLiveness, clearInstance, httpProof, INSTANCE_PATH, instanceHttpAnswer, instanceRunDir, openInstanceSocket, prepareRunDir, proveLiveConsole, readInstance, runDirProblem, socketPathProblem, socketProof } from "./console-instance.js";
import { createDecisionServer } from "./serve.js";
import { openStore, type Store } from "./store.js";
import { fakePid } from "../test/fake-pid.js";

const BUILD = "9.9.9-test";
let dir: string, state: string, databaseFile: string, store: Store, run: string;
const closers: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  // A short base: a Unix socket path is limited to ~104 bytes on macOS.
  dir = realpathSync(mkdtempSync(join("/tmp", "so-ci-")));
  state = join(dir, "s");
  mkdirSync(state, { mode: 0o700 });
  databaseFile = join(state, "orders.db");
  store = openStore(databaseFile);
  run = instanceRunDir(databaseFile);
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function listen(server: HttpServer | NetServer, host: string, port = 0): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { const address = server.address(); resolve(typeof address === "object" && address !== null ? address.port : 0); });
  });
}
function closeServer(server: HttpServer | NetServer): Promise<void> {
  return new Promise<void>(resolve => { server.close(() => resolve()); (server as HttpServer).closeAllConnections?.(); });
}
const ipv6 = await (async () => { const probe = createTcpServer(); try { await listen(probe, "::1"); await closeServer(probe); return true; } catch { return false; } })();
/** A stand-in console HTTP listener answering with the instance secret, bound to its own receiving end. */
function consoleHttp(secret: () => string | null): HttpServer {
  return createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const value = secret();
    if (url.pathname !== INSTANCE_PATH || value === null) { response.writeHead(404); response.end(); return; }
    const answer = instanceHttpAnswer(value, url.searchParams.get("c"), { address: request.socket.localAddress, port: request.socket.localPort });
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(answer.body);
  });
}
/** A console start: its HTTP listener, its own socket, then its claim on the record. */
async function start(host = "127.0.0.1", database = databaseFile, pid = process.pid) {
  let secret: string | null = null;
  const http = consoleHttp(() => secret);
  const port = await listen(http, host);
  closers.push(() => closeServer(http));
  const socket = await openInstanceSocket(database, { pid, build: BUILD, database, port }, () => secret);
  if (!socket.ok) throw new Error(socket.problem);
  closers.push(() => socket.close());
  secret = await claimInstance(store, database, { pid, port, build: BUILD, socket: socket.name }, new Date());
  return { port, secret, name: socket.name };
}

describe("the proofs", () => {
  test("each channel's answer binds its own word, the challenge and (over HTTP) the receiving address and port", () => {
    const secret = "a".repeat(64), c = "0".repeat(64);
    expect(socketProof(secret, c)).not.toBe(httpProof(secret, c, "127.0.0.1", 4180));
    expect(httpProof(secret, c, "127.0.0.1", 4180)).not.toBe(httpProof(secret, c, "::1", 4180));
    expect(httpProof(secret, c, "127.0.0.1", 4180)).not.toBe(httpProof(secret, c, "127.0.0.1", 4181));
    expect(instanceHttpAnswer(secret, "short", { address: "127.0.0.1", port: 1 }).status).toBe(400);
    expect(instanceHttpAnswer(secret, null, { address: "127.0.0.1", port: 1 }).status).toBe(400);
    expect(JSON.parse(instanceHttpAnswer(secret, c, { address: "127.0.0.1", port: 4180 }).body)).toEqual({ proof: httpProof(secret, c, "127.0.0.1", 4180) });
  });

  test("a stopping console forgets only its own record", async () => {
    const first = await claimInstance(store, databaseFile, { pid: fakePid(1), port: 4180, build: BUILD, socket: "0000000000000001.sock" }, new Date(), async () => "gone" as const);
    const second = await claimInstance(store, databaseFile, { pid: fakePid(2), port: 4181, build: BUILD, socket: "0000000000000002.sock" }, new Date(), async () => "gone" as const);
    clearInstance(store, first!);
    expect(readInstance(store)?.pid).toBe(fakePid(2));
    clearInstance(store, second!);
    expect(readInstance(store)).toBeNull();
  });
});

describe("the discovery socket", () => {
  test("answers hello with public facts and the socket proof; refuses every other verb; changes nothing", async () => {
    const { port, secret, name } = await start();
    const before = readInstance(store);
    const c = "1".repeat(64);
    const hello = await askSocket(join(run, name), { verb: "hello", challenge: c });
    expect(hello).toEqual({ answer: { pid: process.pid, build: BUILD, database: databaseFile, port, proof: socketProof(secret!, c) } });
    expect(JSON.stringify(hello)).not.toContain(secret!);
    for (const asked of [{ verb: "secret" }, { verb: "sign-in", challenge: c }, { verb: "hello" }, { verb: "hello", challenge: "xyz" }]) {
      expect(await askSocket(join(run, name), asked)).toEqual({ answer: { error: "refused" } });
    }
    expect(readInstance(store)).toEqual(before);
  });

  test("the run folder must be private, and is never changed to make it so: checked before anything is made", async () => {
    expect(prepareRunDir(run)).toBeNull();
    expect(lstatSync(run).mode & 0o777).toBe(0o700);
    for (const mode of [0o755, 0o750, 0o777]) {
      chmodSync(run, mode);
      expect(runDirProblem(run)).toContain("open to other users");
      // A console starting refuses it as it is — it never chmods a folder.
      expect(await openInstanceSocket(databaseFile, { pid: fakePid(3), build: BUILD, database: databaseFile, port: 1 }, () => null)).toMatchObject({ ok: false });
      expect(lstatSync(run).mode & 0o777).toBe(mode);
    }
    chmodSync(run, 0o700);
    // A parent others can write: refused before the run folder is even made.
    rmSync(run, { recursive: true });
    chmodSync(state, 0o777);
    try {
      expect(prepareRunDir(run)).toContain("can be written by other users");
      expect(() => lstatSync(run)).toThrow();
    } finally { chmodSync(state, 0o700); }
    expect(socketPathProblem(join(run, "0123456789abcdef.sock"))).toBeNull();
    expect(socketPathProblem(join(run, "other.sock"))).toContain("isn't a console socket");
    expect(socketPathProblem(join(`/tmp/${"x".repeat(120)}`, "0123456789abcdef.sock"))).toContain("too long");
  });

  test("a stale socket (nobody listening) is nothing running and is left alone; a socket that isn't a socket is refused", async () => {
    const { name } = await start();
    await closers.pop()!();
    // A console killed outright leaves its socket file; nobody answers.
    spawnSync(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", join(run, name)]);
    expect(lstatSync(join(run, name)).isSocket()).toBe(true);
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toEqual({ ok: false, state: "none", message: "no console is running" });
    expect(lstatSync(join(run, name)).isSocket()).toBe(true);
    rmSync(join(run, name));
    writeFileSync(join(run, name), "");
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toMatchObject({ ok: false, state: "refused" });
  });

  test("each start binds its own socket; a second start on the same database (even by another spelling) never takes a live first one's record", async () => {
    const first = await start();
    const alias = join(dir, "alias");
    mkdirSync(alias, { mode: 0o700 });
    symlinkSync(databaseFile, join(alias, "state.db"));
    expect(instanceRunDir(join(alias, "state.db"))).toBe(run);
    const second = await start("127.0.0.1", join(alias, "state.db"), fakePid(5));
    expect(second.secret).toBeNull();
    expect(second.name).not.toBe(first.name);
    expect(readdirSync(run).sort()).toEqual([first.name, second.name].sort());
    expect(readInstance(store)?.secret).toBe(first.secret);
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toMatchObject({ ok: true, port: first.port });
  });

  test("two starts racing for a free record: exactly one claims it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    // Both see the same (dead) record; the slow one checks liveness while the fast one claims.
    await claimInstance(store, databaseFile, { pid: fakePid(8), port: 3, build: BUILD, socket: "0000000000000008.sock" }, new Date(), async () => "gone" as const);
    const slow = claimInstance(store, databaseFile, { pid: fakePid(6), port: 1, build: BUILD, socket: "0000000000000006.sock" }, new Date(), async () => { await gate; return "gone" as const; });
    const fast = await claimInstance(store, databaseFile, { pid: fakePid(7), port: 2, build: BUILD, socket: "0000000000000007.sock" }, new Date(), async () => "gone" as const);
    release();
    expect(fast).not.toBeNull();
    expect(await slow).toBeNull();
    expect(readInstance(store)?.pid).toBe(fakePid(7));
  });
});

describe("taking the record", () => {
  test("only from nobody, or from a console confirmed gone: a slow, malformed or wrongly proved answer keeps the record", async () => {
    const first = await claimInstance(store, databaseFile, { pid: fakePid(10), port: 1, build: BUILD, socket: "000000000000000a.sock" }, new Date(), async () => "gone" as const);
    for (const answer of ["live", "unknown"] as const) {
      expect(await claimInstance(store, databaseFile, { pid: fakePid(11), port: 2, build: BUILD, socket: "000000000000000b.sock" }, new Date(), async () => answer)).toBeNull();
      expect(readInstance(store)?.secret).toBe(first);
    }
    // A socket that answers without the secret (an agent's) is "unknown", never "gone".
    expect(prepareRunDir(run)).toBeNull();
    const liar = createSocketServer(socket => socket.on("data", () => socket.end(`${JSON.stringify({ pid: fakePid(10), proof: "c".repeat(64) })}\n`)));
    await new Promise<void>(resolve => liar.listen(join(run, "000000000000000a.sock"), () => resolve()));
    closers.push(() => closeServer(liar));
    expect(await recordLiveness(databaseFile, readInstance(store)!)).toBe("unknown");
    expect(await claimInstance(store, databaseFile, { pid: fakePid(12), port: 3, build: BUILD, socket: "000000000000000c.sock" }, new Date())).toBeNull();
    expect(readInstance(store)?.secret).toBe(first);
  });

  test("a record this build can't read is never taken for none: not claimed over, and attaching is refused", async () => {
    store.handle.prepare("INSERT INTO console_instance (id, secret, pid, port, build, socket, started_at) VALUES (1, 'not-a-secret', 1, 1, 'x', 'bad', 'now')").run();
    expect(await claimInstance(store, databaseFile, { pid: fakePid(13), port: 3, build: BUILD, socket: "000000000000000d.sock" }, new Date(), async () => "gone" as const)).toBeNull();
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toMatchObject({ ok: false, state: "refused" });
  });
});

describe("attaching", () => {
  test("a live console reached directly passes both proofs", async () => {
    const { port } = await start();
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toEqual({ ok: true, url: `http://127.0.0.1:${port}`, port, pid: process.pid, build: BUILD });
  });

  test("the real console answers the HTTP challenge on its instance route, and only an up console does", async () => {
    let secret: string | null = null;
    const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", instanceSecret: () => secret });
    const port = await listen(server, "127.0.0.1");
    closers.push(() => closeServer(server));
    const c = "2".repeat(64);
    expect((await fetch(`http://127.0.0.1:${port}${INSTANCE_PATH}?c=${c}`)).status).toBe(404);
    secret = "b".repeat(64);
    const answer = await fetch(`http://127.0.0.1:${port}${INSTANCE_PATH}?c=${c}`);
    expect(await answer.json()).toEqual({ proof: httpProof(secret, c, "127.0.0.1", port) });
    expect((await fetch(`http://127.0.0.1:${port}${INSTANCE_PATH}?c=${c}&c=${c}`)).status).toBe(400);
  });

  test("another build refuses, naming the restart", async () => {
    await start();
    expect(await proveLiveConsole(databaseFile, store, "1.0.0")).toMatchObject({ ok: false, state: "refused", message: expect.stringContaining("toolroll up") });
  });

  test("a malformed proof (not 64 hex characters, even of the same length in letters) is refused, never a crash", async () => {
    expect(prepareRunDir(run)).toBeNull();
    const name = "00000000000000aa.sock";
    await claimInstance(store, databaseFile, { pid: process.pid, port: 1, build: BUILD, socket: name }, new Date(), async () => "gone" as const);
    const odd = createSocketServer(socket => socket.on("data", () => socket.end(`${JSON.stringify({ pid: process.pid, build: BUILD, database: databaseFile, port: 1, proof: "é".repeat(64) })}\n`)));
    await new Promise<void>(resolve => odd.listen(join(run, name), () => resolve()));
    closers.push(() => closeServer(odd));
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toMatchObject({ ok: false, state: "refused" });
  });

  test("a stale record with a replayed hello, a recycled pid and a replacement listener on the recorded port is refused", async () => {
    const replacement = createHttpServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ proof: "f".repeat(64) })); });
    const port = await listen(replacement, "127.0.0.1");
    closers.push(() => closeServer(replacement));
    expect(prepareRunDir(run)).toBeNull();
    const name = "00000000000000bb.sock";
    const secret = (await claimInstance(store, databaseFile, { pid: process.pid, port, build: BUILD, socket: name }, new Date(), async () => "gone" as const))!;
    const recorded = { pid: process.pid, build: BUILD, database: databaseFile, port, proof: socketProof(secret, "3".repeat(64)) };
    const impostor = createSocketServer(socket => socket.on("data", () => socket.end(`${JSON.stringify(recorded)}\n`)));
    await new Promise<void>(resolve => impostor.listen(join(run, name), () => resolve()));
    closers.push(() => closeServer(impostor));
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toMatchObject({ ok: false, state: "refused" });
    expect(await proveLiveConsole(databaseFile, store, BUILD, { challenge: () => "3".repeat(64) })).toMatchObject({ ok: false, state: "refused", message: expect.stringContaining(`127.0.0.1:${port}`) });
  });

  test.skipIf(!ipv6)("a genuine console reached through an IPv4-to-IPv6 relay is refused on both-channel verification", async () => {
    const { port, secret } = await start("::1");
    const piped: { destroy: () => void }[] = [];
    const relay = createTcpServer(inbound => { const outbound = tcpConnect(port, "::1"); piped.push(inbound, outbound); inbound.pipe(outbound).pipe(inbound); inbound.on("error", () => outbound.destroy()); outbound.on("error", () => inbound.destroy()); });
    await listen(relay, "127.0.0.1", port);
    closers.push(() => { for (const one of piped) one.destroy(); return closeServer(relay); });
    const started = Date.now();
    const relayed = await fetch(`http://127.0.0.1:${port}${INSTANCE_PATH}?c=${"4".repeat(64)}`, { headers: { connection: "close" } });
    expect(await relayed.json()).toEqual({ proof: httpProof(secret!, "4".repeat(64), "::1", port) });
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toMatchObject({ ok: false, state: "refused", message: expect.stringContaining(`127.0.0.1:${port}`) });
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  test("with no record, nothing is running", async () => {
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toEqual({ ok: false, state: "none", message: "no console is running" });
  });
});
