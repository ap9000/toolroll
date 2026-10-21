/**
 * Attack: reach the network around a build's approved hosts (docs/plans/agent-baseline-hardening.md, arc 1): connect
 * straight out, send UDP, look a name up (a lookup is itself a message out), ask an outside service to fetch for it,
 * reach another local service, a well-known proxy or debugger port, or a unix socket outside the build's own folders.
 * Guard: the macOS fence denies every outbound connection but the run's own proxy and broker (and, under `loopback:
 * any`, every local service on this Mac — Seatbelt can't refuse one local port once it admits the rest, so that is an
 * approver's explicit choice), denies the delegation services, and admits unix sockets only under the run's own
 * folders; the proxy admits only the run's hosts, with its credentials.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { agentFence, BRIDGE_DIR, linuxFenced, linuxHostSockets, macosFenced, NO_GRANTS, type FenceGrants, type NetworkFence } from "../../src/agent-fence.js";
import { startEgressBridge, type EgressBridge } from "../../src/egress-bridge.js";
import { spawnSync } from "node:child_process";
import { startEgressProxy, type EgressProxy } from "../../src/egress.js";
import { lines, needs, seatbelt, useScratch } from "./harness.js";

/** Whether bubblewrap can make the whole confined network here (its own network and process view). */
function bubblewrapNet(): { available: boolean; note: string } {
  if (process.platform !== "linux") return { available: false, note: "bubblewrap network checks skipped: not Linux" };
  const ran = spawnSync("bwrap", ["--dev-bind", "/", "/", "--unshare-net", "--unshare-pid", "--proc", "/proc", "--", "true"], { encoding: "utf8", timeout: 5_000 });
  return ran.status === 0 ? { available: true, note: "" } : { available: false, note: `bubblewrap network checks skipped: ${(ran.stderr ?? "").trim() || "bwrap can't make a namespace here"}` };
}

/** `script` under the generated bubblewrap command, without blocking this process. */
function underBubblewrap(script: string, grants: FenceGrants, options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
  return underBubblewrapIn(script, [], grants, options);
}
function underBubblewrapIn(script: string, fence: readonly string[], grants: FenceGrants, options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
  const { file, args } = linuxFenced("/bin/sh", ["-c", script], fence, grants);
  return new Promise(done => {
    const child = spawn(file, args, { cwd: options.cwd, env: { ...process.env, NODE_OPTIONS: undefined } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("close", () => done({ stdout, stderr }));
  });
}

/** `script` under the generated Seatbelt profile, without blocking this process (its own servers must answer). */
function underSeatbelt(script: string, fence: readonly string[], grants: FenceGrants, options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
  const { file, args } = macosFenced("/bin/sh", ["-c", script], fence, grants);
  return new Promise(done => {
    const child = spawn(file, args, { cwd: options.cwd, env: { ...process.env, NODE_OPTIONS: undefined } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("close", () => done({ stdout, stderr }));
  });
}

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
    needs(ctx, seatbelt());
    const dir = scratch();
    const local = await upstream();
    // The proxy believes approved.test is a public address at the local server (test seams), so a CONNECT and a plain
    // request to it reach the server; any other host is refused before it resolves.
    const proxy = await startEgressProxy({ hosts: ["approved.test"], lookup: async () => ["127.0.0.1"], addressAllowed: () => true, upstreamPort: () => local });
    proxies.push(proxy);
    const network: NetworkFence = { mode: "allowlist", proxyPort: proxy.port, brokerPorts: [], loopback: "proxy-only", socketRoots: [realpathSync(dir)] };
    const result = await underSeatbelt([
      `curl -s -m 5 --noproxy '*' http://127.0.0.1:${local}/ || echo direct-loopback-refused`,
      `curl -s -m 5 --noproxy '*' https://1.1.1.1/ >/dev/null 2>&1 || echo direct-internet-refused`,
      `python3 -c "import socket; socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b'x', ('1.1.1.1', 53))" 2>/dev/null || echo udp-refused`,
      `python3 -c "import socket; socket.gethostbyname('example.org')" 2>/dev/null || echo dns-refused`,
      `/usr/bin/lsappinfo list >/dev/null 2>&1 && test -n "$(/usr/bin/lsappinfo list 2>/dev/null)" || echo launch-services-refused`,
      `curl -s -m 5 -x '${proxy.url}' http://approved.test/ && echo`,
      `curl -s -m 5 -o /dev/null -w '%{http_code}\\n' -x '${proxy.url}' http://elsewhere.test/`,
      `curl -s -m 5 -o /dev/null -w '%{http_code}\\n' -x 'http://127.0.0.1:${proxy.port}' http://approved.test/`,
    ].join("\n"), [], grantsFor(network), { cwd: dir });
    expect(lines(result), result.stderr).toEqual([
      "direct-loopback-refused", "direct-internet-refused", "udp-refused", "dns-refused", "launch-services-refused",
      "upstream", "403", "407",
    ]);
    const counts = proxy.counts();
    expect(counts.connections).toBe(1);
    expect(counts.hosts.find(one => one.host === "elsewhere.test")?.refused).toBe(1);
  });

  test("loopback any: every local service on this Mac is reachable (all or none), unix sockets only under the run's folders, nothing beyond", async ctx => {
    needs(ctx, seatbelt());
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
    const network: NetworkFence = { mode: "allowlist", proxyPort: proxy.port, brokerPorts: [], loopback: "any", socketRoots: [realpathSync(dir)] };
    const result = await underSeatbelt([
      `curl -s -m 5 --noproxy '*' http://127.0.0.1:${local}/ && echo`,
      `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${inside}'); print(s.recv(16).decode().strip())" 2>/dev/null || echo inside-socket-refused`,
      `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${outside}'); print(s.recv(16).decode().strip())" 2>/dev/null || echo outside-socket-refused`,
      `curl -s -m 5 --noproxy '*' https://1.1.1.1/ >/dev/null 2>&1 || echo direct-internet-refused`,
      `python3 -c "import socket; socket.gethostbyname('example.org')" 2>/dev/null || echo dns-refused`,
    ].join("\n"), [], grantsFor(network), { cwd: dir });
    expect(lines(result), result.stderr).toEqual(["upstream", "socket", "outside-socket-refused", "direct-internet-refused", "dns-refused"]);
  });

  test("open: the network is as it always was (an approver's explicit choice)", async ctx => {
    needs(ctx, seatbelt());
    const dir = scratch();
    const local = await upstream();
    const result = await underSeatbelt(`curl -s -m 5 --noproxy '*' http://127.0.0.1:${local}/ && echo`, [], grantsFor({ mode: "open" }), { cwd: dir });
    expect(lines(result), result.stderr).toEqual(["upstream"]);
  });
});

describe("attack: reaching the network around the build's approved hosts (Linux)", () => {
  const scratch = useScratch("netlinux");
  const bridges: EgressBridge[] = [];
  afterEach(async () => { for (const one of bridges.splice(0)) await one.close(); });

  test("a network of its own: the host's loopback, the internet and name lookups are out of reach; the run's proxy comes in by its bridge", async ctx => {
    needs(ctx, bubblewrapNet());
    const dir = scratch();
    const local = await upstream();
    const proxy = await startEgressProxy({ hosts: ["approved.test"], lookup: async () => ["127.0.0.1"], addressAllowed: () => true, upstreamPort: () => local });
    proxies.push(proxy);
    const bridge = await startEgressBridge([proxy.port]);
    bridges.push(bridge);
    const network: NetworkFence = { mode: "allowlist", proxyPort: proxy.port, brokerPorts: [], loopback: "proxy-only", socketRoots: [],
      bridge: { folder: realpathSync(bridge.folder), forwarder: realpathSync(bridge.forwarder), node: process.execPath } };
    const result = await underBubblewrap([
      `curl -s -m 5 --noproxy '*' http://127.0.0.1:${local}/ || echo host-loopback-refused`,
      `curl -s -m 5 --noproxy '*' https://1.1.1.1/ >/dev/null 2>&1 || echo direct-internet-refused`,
      `getent hosts example.org >/dev/null 2>&1 || echo dns-refused`,
      `curl -s -m 5 -x '${proxy.url}' http://approved.test/ && echo`,
      `curl -s -m 5 -o /dev/null -w '%{http_code}\\n' -x '${proxy.url}' http://elsewhere.test/`,
      `test -S /var/run/docker.sock && echo docker-socket-visible || echo docker-socket-hidden`,
      `ls -A /run/user/$(id -u) 2>/dev/null | grep -q . && echo runtime-visible || echo runtime-hidden`,
    ].join("\n"), grantsFor(network), { cwd: dir });
    expect(lines(result), result.stderr).toEqual(["host-loopback-refused", "direct-internet-refused", "dns-refused", "upstream", "403", "docker-socket-hidden", "runtime-hidden"]);
  });

  test("a build can't see or touch a bridge made after it started", async ctx => {
    needs(ctx, bubblewrapNet());
    const dir = scratch();
    const state = join(dir, "toolroll");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "orders.db"), "");
    // The earlier build: its fence (which holds the bridge folder from launch) and its own bridge.
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree: null, home: join(dir, "home") });
    const bridgeRoot = realpathSync(join(state, BRIDGE_DIR));
    expect(fence).toContain(bridgeRoot);
    const own = await startEgressBridge([], bridgeRoot);
    bridges.push(own);
    const network: NetworkFence = { mode: "allowlist", proxyPort: 18080, brokerPorts: [], loopback: "proxy-only", socketRoots: [],
      bridge: { folder: realpathSync(own.folder), forwarder: realpathSync(own.forwarder), node: process.execPath } };
    const later = join(bridgeRoot, "so-net-later");
    const pending = underBubblewrapIn([
      "sleep 1",
      `ls -A ${JSON.stringify(bridgeRoot)} | grep -v ${JSON.stringify(own.folder.split("/").at(-1)!)} | grep -q . && echo later-visible || echo later-hidden`,
      `(echo x > ${JSON.stringify(join(later, "forward.mjs"))}) 2>/dev/null && echo later-written || echo later-untouched`,
    ].join("\n"), fence, grantsFor(network), { cwd: dir });
    // The later run's bridge is made while the earlier build runs.
    setTimeout(() => { mkdirSync(later, { recursive: true }); writeFileSync(join(later, "forward.mjs"), "original"); }, 200);
    const result = await pending;
    expect(lines(result), result.stderr).toEqual(["later-hidden", "later-untouched"]);
    expect(readFileSync(join(later, "forward.mjs"), "utf8")).toBe("original");
  });

  test("this user's own engine, multiplexer and agent sockets are among the masks, wherever they exist; never through a link", async () => {
    const dir = scratch();
    const home = join(dir, "home"), tmp = join(dir, "tmp");
    for (const path of [join(home, ".docker/desktop"), join(home, ".colima/default"), join(tmp, "tmux-501"), join(tmp, "ssh-abc"), join(tmp, "unrelated")]) mkdirSync(path, { recursive: true });
    // A link planted where a mask is looked for is never followed onto its target.
    const { symlinkSync } = await import("node:fs");
    symlinkSync("/usr", join(tmp, "ssh-planted"));
    const uid = process.getuid?.();
    const masks = linuxHostSockets(uid, home, tmp);
    for (const path of [join(home, ".docker"), join(home, ".colima"), join(tmp, "tmux-501"), join(tmp, "ssh-abc")]) expect(masks).toContain(path);
    expect(masks).not.toContain(join(tmp, "unrelated"));
    expect(masks).not.toContain(join(tmp, "ssh-planted"));
    expect(masks).not.toContain("/usr");
  });

  test("a link planted where the bridges' folder goes is fenced by its own name, and no bridge is made through it", async () => {
    const { symlinkSync } = await import("node:fs");
    const dir = scratch();
    const state = join(dir, "shared");
    const target = join(dir, "attacker");
    mkdirSync(state, { recursive: true });
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(state, "orders.db"), "");
    symlinkSync(target, join(state, BRIDGE_DIR));
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree: null, home: join(dir, "home") });
    expect(fence).toContain(join(realpathSync(state), BRIDGE_DIR));
    expect(fence).toContain(realpathSync(target));
    await expect(startEgressBridge([], join(realpathSync(state), BRIDGE_DIR))).rejects.toThrow(/isn't a private folder/);
  });
});
