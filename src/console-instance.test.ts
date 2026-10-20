/**
 * The running console, proved live (docs/plans/agents-cockpit.md B1): the discovery socket answers only `hello`; the
 * CLI attaches only when the live console answers fresh challenges on BOTH channels with the secret the database
 * holds, bound to the address it dialed. A stale socket, a socket in a directory others can write, a replayed hello,
 * a stale record with a recycled pid and a replacement listener, another build, and an IPv4-to-IPv6 relay to the
 * genuine console are each refused; a live console reached directly passes.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect as tcpConnect, createServer as createTcpServer, createServer as createSocketServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { askSocket, clearInstance, httpProof, INSTANCE_PATH, instanceHttpAnswer, instanceSocketPath, openInstanceSocket, prepareSocketPlace, proveLiveConsole, readInstance, recordInstance, socketPlaceProblem, socketProof } from "./console-instance.js";
import { createDecisionServer } from "./serve.js";
import { fakePid } from "../test/fake-pid.js";
import { openStore, type Store } from "./store.js";

const BUILD = "9.9.9-test";
let dir: string, state: string, databaseFile: string, store: Store, socketPath: string;
const closers: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  // A short base: a Unix socket path is limited to ~104 bytes on macOS.
  dir = realpathSync(mkdtempSync(join("/tmp", "so-ci-")));
  state = join(dir, "s");
  mkdirSync(state, { mode: 0o700 });
  databaseFile = join(state, "orders.db");
  socketPath = instanceSocketPath(databaseFile);
  store = openStore(databaseFile);
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const listenHttp = (server: HttpServer | NetServer, host: string, port = 0) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => { const address = server.address(); resolve(typeof address === "object" && address !== null ? address.port : 0); });
});
const closeServer = (server: HttpServer | NetServer) => new Promise<void>(resolve => { server.close(() => resolve()); (server as HttpServer).closeAllConnections?.(); });
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
/** A genuine console: a record, its HTTP listener on 127.0.0.1, and its discovery socket. */
async function genuine(host = "127.0.0.1") {
  let secret: string | null = null;
  const http = consoleHttp(() => secret);
  const port = await listenHttp(http, host);
  closers.push(() => closeServer(http));
  const socket = await openInstanceSocket(socketPath, { pid: process.pid, build: BUILD, database: databaseFile, port }, () => secret);
  if (!socket.ok) throw new Error(socket.problem);
  secret = recordInstance(store, { pid: process.pid, port, build: BUILD }, new Date());
  closers.push(() => socket.close());
  return { port, secret: secret as string };
}

const ipv6 = await (async () => { const probe = createTcpServer(); try { await listenHttp(probe, "::1"); await closeServer(probe); return true; } catch { return false; } })();

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

  test("a stopping console forgets only its own record", () => {
    const first = recordInstance(store, { pid: fakePid(1), port: 4180, build: BUILD }, new Date());
    const second = recordInstance(store, { pid: fakePid(2), port: 4181, build: BUILD }, new Date());
    clearInstance(store, first);
    expect(readInstance(store)?.pid).toBe(fakePid(2));
    clearInstance(store, second);
    expect(readInstance(store)).toBeNull();
  });
});

describe("the discovery socket", () => {
  test("answers hello with public facts and the socket proof; refuses every other verb; changes nothing", async () => {
    const { port, secret } = await genuine();
    const before = readInstance(store);
    const c = "1".repeat(64);
    const hello = await askSocket(socketPath, { verb: "hello", challenge: c });
    expect(hello).toEqual({ answer: { pid: process.pid, build: BUILD, database: databaseFile, port, proof: socketProof(secret, c) } });
    expect(JSON.stringify(hello)).not.toContain(secret);
    for (const asked of [{ verb: "secret" }, { verb: "sign-in", challenge: c }, { verb: "hello" }, { verb: "hello", challenge: "xyz" }]) {
      expect(await askSocket(socketPath, asked)).toEqual({ answer: { error: "refused" } });
    }
    expect(readInstance(store)).toEqual(before);
  });

  test("the socket's place must be private: a directory open to others (even read-only), a writable parent, a too-long path, a non-socket", async () => {
    prepareSocketPlace(socketPath);
    expect(socketPlaceProblem(socketPath)).toBeNull();
    const run = join(state, "run");
    for (const mode of [0o755, 0o750, 0o777]) {
      chmodSync(run, mode);
      expect(socketPlaceProblem(socketPath)).toContain("open to other users");
    }
    // A console being started closes an existing directory of this user's to everyone else.
    chmodSync(run, 0o755);
    const opened = await openInstanceSocket(socketPath, { pid: fakePid(3), build: BUILD, database: databaseFile, port: 1 }, () => "a".repeat(64));
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.close();
    chmodSync(state, 0o777);
    try {
      expect(socketPlaceProblem(socketPath)).toContain("can be written by other users");
    } finally { chmodSync(state, 0o700); }
    expect(socketPlaceProblem(join(run, `${"x".repeat(120)}.sock`))).toContain("too long");
    // A plain file where the socket goes is not a socket.
    writeFileSync(socketPath, "");
    expect(socketPlaceProblem(socketPath)).toContain("isn't a socket");
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toMatchObject({ ok: false, state: "refused" });
  });

  test("a stale socket (nobody listening) reads as no console running; discovery leaves it, and the next up clears it", async () => {
    prepareSocketPlace(socketPath);
    // A console killed outright: its socket file stays, nobody answers.
    spawnSync(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", socketPath]);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    recordInstance(store, { pid: process.pid, port: 1, build: BUILD }, new Date());
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toEqual({ ok: false, state: "none", message: "no console is running" });
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    const next = await openInstanceSocket(socketPath, { pid: fakePid(4), build: BUILD, database: databaseFile, port: 1 }, () => "a".repeat(64));
    expect(next.ok).toBe(true);
    if (next.ok) next.close();
  });

  test("a second console on the same database never takes over the first one's socket or record", async () => {
    const { port, secret } = await genuine();
    const second = await openInstanceSocket(socketPath, { pid: fakePid(5), build: BUILD, database: databaseFile, port: port + 1 }, () => "b".repeat(64));
    expect(second).toMatchObject({ ok: false, another: true });
    expect(readInstance(store)?.secret).toBe(secret);
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toMatchObject({ ok: true, port });
  });
});

describe("attaching", () => {
  test("a live console reached directly passes both proofs", async () => {
    const { port } = await genuine();
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toEqual({ ok: true, url: `http://127.0.0.1:${port}`, port, pid: process.pid, build: BUILD });
  });

  test("the real console answers the HTTP challenge on its instance route, and only an up console does", async () => {
    let secret: string | null = null;
    const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", instanceSecret: () => secret });
    const port = await listenHttp(server, "127.0.0.1");
    closers.push(() => closeServer(server));
    const c = "2".repeat(64);
    expect((await fetch(`http://127.0.0.1:${port}${INSTANCE_PATH}?c=${c}`)).status).toBe(404);
    secret = recordInstance(store, { pid: process.pid, port, build: BUILD }, new Date());
    const answer = await fetch(`http://127.0.0.1:${port}${INSTANCE_PATH}?c=${c}`);
    expect(await answer.json()).toEqual({ proof: httpProof(secret, c, "127.0.0.1", port) });
    // Never from the Host header: a client naming another host gets an answer bound to where it really arrived.
    expect((await fetch(`http://127.0.0.1:${port}${INSTANCE_PATH}?c=${c}&c=${c}`)).status).toBe(400);
  });

  test("a malformed proof (not 64 hex characters, even of the same length in letters) is refused, never a crash", async () => {
    const secret = recordInstance(store, { pid: process.pid, port: 1, build: BUILD }, new Date());
    void secret;
    prepareSocketPlace(socketPath);
    const odd = createSocketServer(socket => socket.on("data", () => socket.end(`${JSON.stringify({ pid: process.pid, build: BUILD, database: databaseFile, port: 1, proof: "é".repeat(64) })}\n`)));
    await new Promise<void>(resolve => odd.listen(socketPath, () => resolve()));
    closers.push(() => closeServer(odd));
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toMatchObject({ ok: false, state: "refused" });
  });

  test("another build refuses, naming the restart", async () => {
    await genuine();
    expect(await proveLiveConsole(databaseFile, store, "1.0.0")).toMatchObject({ ok: false, state: "refused", message: expect.stringContaining("toolroll up") });
  });

  test("a stale record with a replayed hello, a recycled pid and a replacement listener on the recorded port is refused", async () => {
    // The old console's record and one hello it once gave.
    const replacement = createHttpServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ proof: "f".repeat(64) })); });
    const port = await listenHttp(replacement, "127.0.0.1");
    closers.push(() => closeServer(replacement));
    const secret = recordInstance(store, { pid: process.pid, port, build: BUILD }, new Date());
    const recorded = { pid: process.pid, build: BUILD, database: databaseFile, port, proof: socketProof(secret, "3".repeat(64)) };
    prepareSocketPlace(socketPath);
    const impostor = createSocketServer(socket => socket.on("data", () => socket.end(`${JSON.stringify(recorded)}\n`)));
    await new Promise<void>(resolve => impostor.listen(socketPath, () => resolve()));
    closers.push(() => closeServer(impostor));
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toMatchObject({ ok: false, state: "refused" });
    // Even replaying the very challenge's answer on the socket, the replacement listener can't answer HTTP.
    expect(await proveLiveConsole(databaseFile, store, BUILD, { challenge: () => "3".repeat(64) })).toMatchObject({ ok: false, state: "refused", message: expect.stringContaining(`127.0.0.1:${port}`) });
  });

  test.skipIf(!ipv6)("a genuine console reached through an IPv4-to-IPv6 relay is refused on both-channel verification", async () => {
    // The real console listens on [::1]:P; an agent listens on 127.0.0.1:P and forwards every byte to it.
    const { port, secret } = await genuine("::1");
    const piped: { destroy: () => void }[] = [];
    const relay = createTcpServer(inbound => { const outbound = tcpConnect(port, "::1"); piped.push(inbound, outbound); inbound.pipe(outbound).pipe(inbound); inbound.on("error", () => outbound.destroy()); outbound.on("error", () => inbound.destroy()); });
    await listenHttp(relay, "127.0.0.1", port);
    closers.push(() => { for (const one of piped) one.destroy(); return closeServer(relay); });
    const started = Date.now();
    // The relay works (it reaches the real console), and the socket proof is genuine — yet the answer is bound to ::1.
    const relayed = await fetch(`http://127.0.0.1:${port}${INSTANCE_PATH}?c=${"4".repeat(64)}`, { headers: { connection: "close" } });
    expect(await relayed.json()).toEqual({ proof: httpProof(secret, "4".repeat(64), "::1", port) });
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toMatchObject({ ok: false, state: "refused", message: expect.stringContaining(`127.0.0.1:${port}`) });
    // Refused on the answer's binding, not by waiting out a timeout.
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  test("with no record and no socket, nothing is running", async () => {
    expect(await proveLiveConsole(databaseFile, store, BUILD)).toEqual({ ok: false, state: "none", message: "no console is running" });
  });
});
