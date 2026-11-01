/**
 * Attack: reach the network around a build's approved hosts (docs/plans/agent-baseline-hardening.md, arc 1): connect
 * straight out, send UDP, look a name up (a lookup is itself a message out), reach another local service, or a unix
 * socket outside the build's own folders. Guard: Anthropic's sandbox-runtime confines the network (macOS: its Seatbelt
 * profile admits only the run's proxy port, every local service only under `loopback: any`, and unix sockets only under
 * the run's own folders; Linux: a network namespace of its own, the run's proxy relayed in on its port 3128); the run's
 * proxy admits only the run's hosts, with its credential.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { NO_GRANTS, type FenceGrants, type NetworkFence } from "../../src/agent-fence.js";
import { startEgressProxy, type EgressProxy } from "../../src/egress.js";
import { lines, needs, osFence, underSandboxAsync, useScratch } from "./harness.js";

const underSandbox = (script: string, fence: readonly string[], grants: FenceGrants, options: { cwd: string }) =>
  underSandboxAsync(script, fence, grants, { cwd: options.cwd, env: { ...process.env, NODE_OPTIONS: undefined } as NodeJS.ProcessEnv });

const servers: (Server | NetServer)[] = [];
const proxies: EgressProxy[] = [];
afterEach(async () => {
  for (const one of servers.splice(0)) one.close();
  for (const one of proxies.splice(0)) await one.close();
});

/** A local HTTP server answering "upstream", on a port of its own. */
async function upstream(): Promise<number> {
  const server = createHttpServer((_, response) => response.end("upstream"));
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
  return (server.address() as { port: number }).port;
}

/** A unix socket server answering "socket" at `path`. */
async function socketAt(path: string): Promise<void> {
  const server = createNetServer(socket => socket.end("socket\n"));
  servers.push(server);
  await new Promise<void>(done => server.listen(path, () => done()));
}

const grantsFor = (network: NetworkFence): FenceGrants => ({ ...NO_GRANTS, network });

describe("attack: reaching the network around the build's approved hosts (macOS)", () => {
  const scratch = useScratch("net");

  test("proxy-only: nothing leaves but through the run's proxy, which admits its hosts alone", async ctx => {
    ctx.skip(process.platform !== "darwin", "macOS network checks skipped: not macOS");
    needs(ctx, osFence());
    const dir = scratch();
    const local = await upstream();
    // The proxy believes approved.test is a public address at the local server (test seams), so a CONNECT and a plain
    // request to it reach the server; any other host is refused before it resolves.
    const proxy = await startEgressProxy({ hosts: ["approved.test"], lookup: async () => ["127.0.0.1"], addressAllowed: () => true, upstreamPort: () => local });
    proxies.push(proxy);
    const network: NetworkFence = { mode: "allowlist", proxyPort: proxy.port, brokerPorts: [], loopback: "proxy-only", socketRoots: [realpathSync(dir)], token: proxy.secret };
    const result = await underSandbox([
      `curl -s -m 5 --noproxy '*' http://127.0.0.1:${local}/ || echo direct-loopback-refused`,
      `curl -s -m 5 --noproxy '*' https://1.1.1.1/ >/dev/null 2>&1 || echo direct-internet-refused`,
      `python3 -c "import socket; socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b'x', ('1.1.1.1', 53))" 2>/dev/null || echo udp-refused`,
      `python3 -c "import socket; socket.gethostbyname('example.org')" 2>/dev/null || echo dns-refused`,
      // Launch Services lookups stay as the runtime's baseline has them (it lists apps); opening one is refused
      // (fence-apple-events.test.ts).
      `curl -s -m 5 -x '${proxy.url}' http://approved.test/ && echo`,
      `curl -s -m 5 -o /dev/null -w '%{http_code}\\n' -x '${proxy.url}' http://elsewhere.test/`,
      `curl -s -m 5 -o /dev/null -w '%{http_code}\\n' -x 'http://127.0.0.1:${proxy.port}' http://approved.test/`,
    ].join("\n"), [], grantsFor(network), { cwd: dir });
    expect(lines(result), result.stderr).toEqual([
      "direct-loopback-refused", "direct-internet-refused", "udp-refused", "dns-refused",
      "upstream", "403", "407",
    ]);
    const counts = proxy.counts();
    expect(counts.connections).toBe(1);
    expect(counts.hosts.find(one => one.host === "elsewhere.test")?.refused).toBe(1);
  });

  test("loopback any: every local service on this Mac is reachable (all or none), unix sockets only under the run's folders, nothing beyond", async ctx => {
    ctx.skip(process.platform !== "darwin", "macOS network checks skipped: not macOS");
    needs(ctx, osFence());
    const dir = scratch();
    const local = await upstream();
    const proxy = await startEgressProxy({ hosts: [] });
    proxies.push(proxy);
    const inside = join(realpathSync(dir), "in.sock");
    const outsideDir = join(realpathSync(tmpdir()), "..", `so-net-test-${process.pid}`);
    mkdirSync(outsideDir, { recursive: true });
    const outside = join(realpathSync(outsideDir), "out.sock");
    await socketAt(inside);
    await socketAt(outside);
    const network: NetworkFence = { mode: "allowlist", proxyPort: proxy.port, brokerPorts: [], loopback: "any", socketRoots: [realpathSync(dir)], token: proxy.secret };
    const result = await underSandbox([
      `curl -s -m 5 --noproxy '*' http://127.0.0.1:${local}/ && echo`,
      `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${inside}'); print(s.recv(16).decode().strip())" 2>/dev/null || echo inside-socket-refused`,
      `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${outside}'); print(s.recv(16).decode().strip())" 2>/dev/null || echo outside-socket-refused`,
      `curl -s -m 5 --noproxy '*' https://1.1.1.1/ >/dev/null 2>&1 || echo direct-internet-refused`,
      `python3 -c "import socket; socket.gethostbyname('example.org')" 2>/dev/null || echo dns-refused`,
    ].join("\n"), [], grantsFor(network), { cwd: dir });
    expect(lines(result), result.stderr).toEqual(["upstream", "socket", "outside-socket-refused", "direct-internet-refused", "dns-refused"]);
  });

  test("open: the network is as it always was (an approver's explicit choice)", async ctx => {
    ctx.skip(process.platform !== "darwin", "macOS network checks skipped: not macOS");
    needs(ctx, osFence());
    const dir = scratch();
    const local = await upstream();
    const result = await underSandbox(`curl -s -m 5 --noproxy '*' http://127.0.0.1:${local}/ && echo`, [], grantsFor({ mode: "open" }), { cwd: dir });
    expect(lines(result), result.stderr).toEqual(["upstream"]);
  });
});

describe("attack: reaching the network around the build's approved hosts (Linux)", () => {
  const scratch = useScratch("netlinux");

  test("a network of its own: the host's loopback, the internet and name lookups are out of reach; the run's proxy comes in on the runtime's relay", async ctx => {
    ctx.skip(process.platform !== "linux", "Linux network checks skipped: not Linux");
    needs(ctx, osFence());
    const dir = scratch();
    const local = await upstream();
    const proxy = await startEgressProxy({ hosts: ["approved.test"], lookup: async () => ["127.0.0.1"], addressAllowed: () => true, upstreamPort: () => local });
    proxies.push(proxy);
    const network: NetworkFence = { mode: "allowlist", proxyPort: proxy.port, brokerPorts: [], loopback: "proxy-only", socketRoots: [], token: proxy.secret };
    const result = await underSandbox([
      `curl -s -m 5 --noproxy '*' http://127.0.0.1:${local}/ || echo host-loopback-refused`,
      `curl -s -m 5 --noproxy '*' https://1.1.1.1/ >/dev/null 2>&1 || echo direct-internet-refused`,
      `getent hosts example.org >/dev/null 2>&1 || echo dns-refused`,
      // Through the proxy the runtime relays in (its HTTP_PROXY, with this run's credential).
      `curl -s -m 5 http://approved.test/ && echo`,
      `curl -s -m 5 -o /dev/null -w '%{http_code}\\n' http://elsewhere.test/`,
    ].join("\n"), [], grantsFor(network), { cwd: dir });
    expect(lines(result), result.stderr).toEqual(["host-loopback-refused", "direct-internet-refused", "dns-refused", "upstream", "403"]);
  });
});
