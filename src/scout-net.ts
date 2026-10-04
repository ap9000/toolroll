/**
 * The scout's browser reaches only the public web (review 826): every
 * request it makes goes through this local proxy, which resolves the host
 * itself and refuses anything that is not a public internet address —
 * loopback, private, link-local, carrier-grade NAT, multicast and reserved
 * ranges, in IPv4 and IPv6 — then connects to the very address it checked,
 * so a name that re-resolves somewhere private gets nowhere. The one
 * exception is the project's own demo URL, when one is set, matched by its
 * exact scheme, host and port. Redirects and a page's own requests pass
 * through the same check; file: never reaches a proxy, and the pinned
 * Playwright refuses to open it.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/** Address ranges a scout's browser may never reach. */
const NOT_PUBLIC = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ] as const) list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of [
    ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ] as const) list.addSubnet(net, prefix, "ipv6");
  return list;
})();

/** Whether an IP literal is a public internet address. IPv4 inside IPv6 (mapped, compatible or NAT64) is judged as IPv4. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return !NOT_PUBLIC.check(bare, "ipv4");
  if (family !== 6) return false;
  const embedded = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)?.[1];
  if (embedded !== undefined) return isPublicAddress(embedded);
  const mappedHex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare);
  if (mappedHex !== null) {
    const high = parseInt(mappedHex[1]!, 16);
    const low = parseInt(mappedHex[2]!, 16);
    return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (/^::ffff:/i.test(bare)) return false;
  return !NOT_PUBLIC.check(bare, "ipv6");
}

export type Lookup = (host: string) => Promise<readonly string[]>;
const systemLookup: Lookup = async host => (await dnsLookup(host, { all: true, verbatim: true })).map(one => one.address);

type Target = { scheme: "http" | "https"; host: string; port: number };

/** The demo URL's own origin, or null when none is set or it is not an http(s) address. */
function demoTarget(demoUrl: string | null | undefined): Target | null {
  if (demoUrl === undefined || demoUrl === null || demoUrl === "") return null;
  try {
    const url = new URL(demoUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const scheme = url.protocol === "http:" ? "http" : "https";
    return { scheme, host: url.hostname.toLowerCase(), port: Number(url.port || (scheme === "http" ? 80 : 443)) };
  } catch {
    return null;
  }
}

export type ScoutProxy = { url: string; close: () => Promise<void> };

/**
 * Start the scout browser's proxy on loopback. `refused` hears every request it turned away (for the live log and
 * tests). `lookup` resolves a host name to its addresses (the system resolver unless a test supplies one).
 */
export async function startScoutProxy(options: { demoUrl?: string | null; lookup?: Lookup; refused?: (target: string, why: string) => void } = {}): Promise<ScoutProxy> {
  const lookup = options.lookup ?? systemLookup;
  const demo = demoTarget(options.demoUrl);
  const sockets = new Set<Socket>();

  /** The one address this request may reach, or why it may not. */
  const resolve = async (target: Target): Promise<{ ok: true; address: string } | { ok: false; why: string }> => {
    const host = target.host.replace(/^\[|\]$/g, "").toLowerCase();
    const isDemo = demo !== null && demo.scheme === target.scheme && demo.host.replace(/^\[|\]$/g, "") === host && demo.port === target.port;
    let addresses: readonly string[];
    try {
      addresses = isIP(host) !== 0 ? [host] : await lookup(host);
    } catch {
      return { ok: false, why: "the host does not resolve" };
    }
    if (addresses.length === 0) return { ok: false, why: "the host does not resolve" };
    if (isDemo) return { ok: true, address: addresses[0]! };
    if (!addresses.every(isPublicAddress)) return { ok: false, why: "not a public internet address" };
    return { ok: true, address: addresses[0]! };
  };
  const refuse = (target: string, why: string): void => {
    try { options.refused?.(target, why); } catch { /* a listener's trouble is not the browser's */ }
  };

  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(incoming.url ?? "");
      } catch {
        outgoing.writeHead(400).end();
        return;
      }
      if (url.protocol !== "http:") {
        refuse(url.protocol, "only web pages");
        outgoing.writeHead(403, { "content-type": "text/plain" }).end("Toolroll's scout browser opens only public web pages.");
        return;
      }
      const target: Target = { scheme: "http", host: url.hostname, port: Number(url.port || 80) };
      const reached = await resolve(target);
      if (!reached.ok) {
        refuse(url.origin, reached.why);
        outgoing.writeHead(403, { "content-type": "text/plain" }).end("Toolroll's scout browser opens only public web pages.");
        return;
      }
      const headers = { ...incoming.headers };
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      const forward = httpRequest({ host: reached.address, port: target.port, method: incoming.method, path: `${url.pathname}${url.search}`, headers, setHost: false }, answer => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      });
      forward.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.pipe(forward);
    })();
  });

  server.on("connect", (incoming: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    void (async () => {
      const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(incoming.url ?? "");
      const target: Target | null = match === null ? null : { scheme: "https", host: match[1]!, port: Number(match[2]) };
      const reached = target === null ? { ok: false as const, why: "not a host and port" } : await resolve(target);
      if (!reached.ok) {
        refuse(incoming.url ?? "", reached.why);
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = connect({ host: reached.address, port: target!.port }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
      upstream.on("error", () => { if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); });
    })();
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => { server.off("error", fail); done(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(done => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}
