/**
 * The scout reaches only the public web (reviews 826, 827): every request
 * its browser and its web fetch make goes through this local proxy, which resolves the host
 * itself and refuses anything that is not a public internet address —
 * loopback, private, link-local, carrier-grade NAT, multicast and reserved
 * ranges, in IPv4 and IPv6 — then connects to the very addresses it
 * checked, each in turn until one answers, so a name that re-resolves
 * somewhere private gets nowhere. The one
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

/** An IPv6 address as its eight 16-bit groups, whatever way it was written (compressed, expanded, IPv4-tailed). */
function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail !== null) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? left.length !== 8 : missing < 1) return null;
  const groups = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill("0"), ...right].map(one => parseInt(one, 16));
  return groups.length === 8 && groups.every(one => Number.isInteger(one) && one >= 0 && one <= 0xffff) ? groups : null;
}

/**
 * Whether an IP literal is a public internet address. IPv4 inside IPv6 (mapped, translated, compatible or NAT64) is
 * judged as IPv4, read from the address's groups so every way of writing it is caught (an expanded NAT64 form too).
 */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return !NOT_PUBLIC.check(bare, "ipv4");
  if (family !== 6) return false;
  const groups = ipv6Groups(bare);
  if (groups === null) return false;
  const v4 = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  const zero = (from: number, to: number) => groups.slice(from, to).every(one => one === 0);
  // ::ffff:a.b.c.d (mapped), ::ffff:0:a.b.c.d (translated), ::a.b.c.d (compatible), 64:ff9b::a.b.c.d (NAT64).
  if (zero(0, 5) && groups[5] === 0xffff) return isPublicAddress(v4(groups[6]!, groups[7]!));
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return isPublicAddress(v4(groups[6]!, groups[7]!));
  if (zero(0, 6) && (groups[6] !== 0 || groups[7]! > 1)) return isPublicAddress(v4(groups[6]!, groups[7]!));
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return isPublicAddress(v4(groups[6]!, groups[7]!));
  return !NOT_PUBLIC.check(groups.map(one => one.toString(16)).join(":"), "ipv6");
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

/** How long one address may take to answer before the next is tried. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * A connection to the first of the checked addresses that answers, tried in turn (review 827): a host whose IPv6
 * address is unreachable from here is still reached over IPv4. Null when none answers.
 */
export async function connectFirst(addresses: readonly string[], port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Socket | null> {
  for (const address of addresses) {
    const socket = await new Promise<Socket | null>(done => {
      const attempt = connect({ host: address, port });
      const give = (value: Socket | null): void => {
        attempt.removeAllListeners("connect").removeAllListeners("error").removeAllListeners("timeout");
        attempt.setTimeout(0);
        if (value === null) attempt.destroy();
        done(value);
      };
      attempt.setTimeout(timeoutMs);
      attempt.once("connect", () => give(attempt));
      attempt.once("error", () => give(null));
      attempt.once("timeout", () => give(null));
    });
    if (socket !== null) return socket;
  }
  return null;
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

  /** The addresses this request may reach, in the resolver's order, or why it may not. */
  const resolve = async (target: Target): Promise<{ ok: true; addresses: readonly string[] } | { ok: false; why: string }> => {
    const host = target.host.replace(/^\[|\]$/g, "").toLowerCase();
    const isDemo = demo !== null && demo.scheme === target.scheme && demo.host.replace(/^\[|\]$/g, "") === host && demo.port === target.port;
    let addresses: readonly string[];
    try {
      addresses = isIP(host) !== 0 ? [host] : await lookup(host);
    } catch {
      return { ok: false, why: "the host does not resolve" };
    }
    if (addresses.length === 0) return { ok: false, why: "the host does not resolve" };
    if (isDemo) return { ok: true, addresses };
    if (!addresses.every(isPublicAddress)) return { ok: false, why: "not a public internet address" };
    return { ok: true, addresses };
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
      const upstream = await connectFirst(reached.addresses, target.port);
      if (upstream === null) {
        outgoing.writeHead(502).end();
        return;
      }
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      const headers = { ...incoming.headers };
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      const forward = httpRequest({ createConnection: () => upstream, method: incoming.method, path: `${url.pathname}${url.search}`, headers, setHost: false }, answer => {
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
      const upstream = await connectFirst(reached.addresses, target!.port);
      if (upstream === null) {
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      sockets.add(upstream);
      upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
      upstream.on("error", () => client.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
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
