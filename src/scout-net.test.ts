/**
 * The scout's browser reaches only public pages (review 826): its proxy refuses loopback, private, link-local and
 * reserved addresses, by literal or by what a name resolves to, and lets through only the project's demo URL.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, request, type Server } from "node:http";
import { connectFirst, isPublicAddress, startScoutProxy, type Lookup } from "./scout-net.js";

describe("which addresses are public", () => {
  test("loopback, private, link-local, CGNAT, multicast, reserved and IPv4-in-IPv6 forms are not; ordinary internet addresses are", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::10.0.0.1", "fe80::1%en0", "localhost", "not an address"]) {
      expect([address, isPublicAddress(address)]).toEqual([address, false]);
    }
    for (const address of ["93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:93.184.216.34"]) {
      expect([address, isPublicAddress(address)]).toEqual([address, true]);
    }
  });
});

describe("the scout browser's proxy", () => {
  let demo: Server;
  let demoPort = 0;
  beforeAll(async () => {
    demo = createServer((_incoming, outgoing) => outgoing.end("the demo"));
    await new Promise<void>(done => demo.listen(0, "127.0.0.1", () => done()));
    demoPort = (demo.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise<void>(done => demo.close(() => done())); });

  const names: Record<string, string[]> = { "localhost": ["127.0.0.1"], "intranet.corp": ["10.0.0.5"], "metadata.cloud": ["169.254.169.254"], "rebind.example": ["93.184.216.34", "127.0.0.1"] };
  const lookup: Lookup = async host => { const found = names[host]; if (found === undefined) throw new Error("no such host"); return found; };

  /** One plain-http request through the proxy: its status and body. */
  const get = (proxy: string, url: string) => new Promise<{ status: number; body: string }>((done, fail) => {
    const via = new URL(proxy);
    const target = new URL(url);
    const sent = request({ host: via.hostname, port: Number(via.port), path: url, headers: { host: target.host } }, answer => {
      let body = "";
      answer.on("data", chunk => { body += String(chunk); });
      answer.on("end", () => done({ status: answer.statusCode ?? 0, body }));
    });
    sent.on("error", fail);
    sent.end();
  });
  /** One CONNECT (how a browser opens https) through the proxy: the status it answers. */
  const tunnel = (proxy: string, hostPort: string) => new Promise<number>((done, fail) => {
    const via = new URL(proxy);
    const sent = request({ host: via.hostname, port: Number(via.port), method: "CONNECT", path: hostPort });
    sent.on("connect", (answer, socket) => { socket.destroy(); done(answer.statusCode ?? 0); });
    sent.on("response", answer => done(answer.statusCode ?? 0));
    sent.on("error", fail);
    sent.end();
  });

  test("refuses loopback, private and link-local targets, by literal and by name, over http and https", async () => {
    const refused: string[] = [];
    const proxy = await startScoutProxy({ lookup, refused: target => refused.push(target) });
    try {
      expect((await get(proxy.url, `http://127.0.0.1:${demoPort}/`)).status).toBe(403);
      expect((await get(proxy.url, `http://localhost:${demoPort}/`)).status).toBe(403);
      expect((await get(proxy.url, "http://intranet.corp/")).status).toBe(403);
      expect((await get(proxy.url, "http://metadata.cloud/latest/meta-data/")).status).toBe(403);
      // A name that resolves to a public address AND a private one is refused outright.
      expect((await get(proxy.url, "http://rebind.example/")).status).toBe(403);
      expect((await get(proxy.url, "http://[::1]/")).status).toBe(403);
      expect((await get(proxy.url, "ftp://93.184.216.34/file")).status).toBe(403);
      expect(await tunnel(proxy.url, `127.0.0.1:${demoPort}`)).toBe(403);
      expect(await tunnel(proxy.url, "localhost:443")).toBe(403);
      expect(await tunnel(proxy.url, "[fe80::1]:443")).toBe(403);
      expect(await tunnel(proxy.url, "169.254.169.254:443")).toBe(403);
      expect(refused).toHaveLength(11);
    } finally {
      await proxy.close();
    }
  });

  test("the project's demo URL is the one exception: its exact scheme, host and port", async () => {
    const proxy = await startScoutProxy({ lookup, demoUrl: `http://localhost:${demoPort}/app` });
    try {
      expect(await get(proxy.url, `http://localhost:${demoPort}/anything`)).toEqual({ status: 200, body: "the demo" });
      // Another port on the same host, the same port by another name, or https to it: refused.
      expect((await get(proxy.url, `http://localhost:${demoPort + 1}/`)).status).toBe(403);
      expect((await get(proxy.url, `http://127.0.0.1:${demoPort}/`)).status).toBe(403);
      expect(await tunnel(proxy.url, `localhost:${demoPort}`)).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  test("each checked address is tried in turn: one that refuses falls back to the next (review 827)", async () => {
    // The demo's name resolves first to an IPv6 address nothing listens on here, then to its IPv4 one.
    const both: Lookup = async host => (host === "demo.dual" ? ["::1", "127.0.0.1"] : lookup(host));
    const proxy = await startScoutProxy({ lookup: both, demoUrl: `http://demo.dual:${demoPort}` });
    try {
      expect(await get(proxy.url, `http://demo.dual:${demoPort}/`)).toEqual({ status: 200, body: "the demo" });
    } finally {
      await proxy.close();
    }
    const tunnelled = await startScoutProxy({ lookup: both, demoUrl: `https://demo.dual:${demoPort}` });
    try {
      expect(await tunnel(tunnelled.url, `demo.dual:${demoPort}`)).toBe(200);
    } finally {
      await tunnelled.close();
    }
    const first = await connectFirst(["::1", "127.0.0.1"], demoPort);
    expect(first?.remoteAddress).toBe("127.0.0.1");
    first?.destroy();
    // None answering is a refusal, not a hang.
    const dead = createServer();
    await new Promise<void>(done => dead.listen(0, "127.0.0.1", () => done()));
    const deadPort = (dead.address() as { port: number }).port;
    await new Promise<void>(done => dead.close(() => done()));
    expect(await connectFirst(["127.0.0.1"], deadPort)).toBeNull();
  });

  test("an https demo is reached through a tunnel to the address the proxy checked", async () => {
    const proxy = await startScoutProxy({ lookup, demoUrl: `https://localhost:${demoPort}` });
    try {
      expect(await tunnel(proxy.url, `localhost:${demoPort}`)).toBe(200);
      expect(await tunnel(proxy.url, `localhost:${demoPort + 1}`)).toBe(403);
    } finally {
      await proxy.close();
    }
  });
});
