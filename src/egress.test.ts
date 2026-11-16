import { afterEach, describe, expect, test } from "vitest";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { connectFirst } from "./scout-net.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ecosystemsOf, hostAllowed, legacyNetwork, networkFromValue, networkWords, normalizeHost, projectNetworkFromValue, providerOnlyNetwork,
  repositoryEcosystems, resolveNetwork, runNetworkFromValue, startEgressProxy, PROJECT_NETWORK_DEFAULT, PROVIDER_HOSTS, REGISTRY_HOSTS, type EgressProxy,
} from "./egress.js";
import { canonicalProfileJson, profileDigestOf, profileFromJson, type ExecutionProfile } from "./scope.js";
import { shortTempDir } from "../test/short-temp.js";
import { SOCKETS_TOO_DEEP } from "../test/inside-fence.js";

const closers: (() => unknown)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

describe("a host as a policy names it", () => {
  test("exact names and *.suffix, lowercase ASCII; never an address, a port, a path or a bare top-level name", () => {
    expect(normalizeHost(" API.Stripe.com. ")).toBe("api.stripe.com");
    expect(normalizeHost("*.stripe.com")).toBe("*.stripe.com");
    expect(normalizeHost("bücher.example")).toBe("xn--bcher-kva.example");
    for (const bad of ["", "com", "1.2.3.4", "[::1]", "::1", "host:443", "a.b/c", "*.com", "-x.example", "a..b", "x".repeat(64) + ".com", "example.123", "*", "**.a.b"]) {
      expect([bad, normalizeHost(bad)]).toEqual([bad, null]);
    }
  });

  test("a list admits its exact names and names under a *. entry, never the suffix itself or a lookalike", () => {
    const hosts = ["api.anthropic.com", "*.stripe.com"];
    expect(hostAllowed("api.anthropic.com", hosts)).toBe(true);
    expect(hostAllowed("API.ANTHROPIC.COM.", hosts)).toBe(true);
    expect(hostAllowed("files.stripe.com", hosts)).toBe(true);
    expect(hostAllowed("a.b.stripe.com", hosts)).toBe(true);
    for (const no of ["stripe.com", "evilstripe.com", "anthropic.com", "api.anthropic.com.evil.net", "1.2.3.4", "*.stripe.com"]) expect([no, hostAllowed(no, hosts)]).toEqual([no, false]);
  });
});

describe("the network a scope is written with", () => {
  test("ecosystems come from the project's file names, anywhere in the tree", () => {
    expect(ecosystemsOf(["package.json", "api/requirements-dev.txt", "svc/Cargo.lock", "Gemfile", "tools/go.mod", "README.md"])).toEqual(["go", "npm", "python", "ruby", "rust"]);
    expect(ecosystemsOf(["docs/index.md"])).toEqual([]);
  });

  test("the project's own folder is read a few levels deep, skipping dependency and hidden folders; nothing runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "so-egress-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const [path, text] of [["package.json", "{}"], ["svc/api/pyproject.toml", ""], ["node_modules/x/Cargo.toml", ""], [".hidden/go.mod", ""], ["a/b/c/d/Gemfile", ""]] as const) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    expect(repositoryEcosystems(dir)).toEqual(["npm", "python"]);
    expect(repositoryEcosystems(join(dir, "missing"))).toEqual([]);
  });

  test("allowlist: the provider's hosts, the ecosystems' registries and the project's hosts, sorted, once each", () => {
    const network = resolveNetwork("claude", { mode: "allowlist", hosts: ["api.stripe.com", "registry.npmjs.org"], loopback: "proxy-only" }, ["npm"]);
    expect(network.mode).toBe("allowlist");
    expect(network.hosts).toEqual([...new Set([...PROVIDER_HOSTS["claude"]!, ...REGISTRY_HOSTS.npm, "api.stripe.com"])].sort());
    expect(networkWords(network, "claude")).toBe("Network: the agent's provider, npm, and api.stripe.com");
    // Only this agent's own provider collapses: another provider's host, or part of a registry, is said exactly.
    const wider = { ...network, hosts: [...network.hosts, "api.openai.com", "pypi.org"] };
    expect(networkWords(wider, "claude")).toBe("Network: the agent's provider, npm, and api.stripe.com, api.openai.com, pypi.org");
    expect(networkWords(network, "codex")).toContain("api.anthropic.com");
    expect(resolveNetwork("claude", { mode: "open", hosts: [], loopback: "any" }, ["npm"])).toEqual({ version: 1, mode: "open", hosts: [], loopback: "any" });
    expect(networkWords(resolveNetwork("claude", { mode: "open", hosts: [], loopback: "any" }, []), "claude")).toBe("Network: open — any host, and every local service on this Mac");
  });

  test("the defaults are the narrow ones: no local services, provider-only for launches nothing sealed, legacy approvals narrowed", () => {
    expect(PROJECT_NETWORK_DEFAULT).toEqual({ mode: "allowlist", hosts: [], loopback: "proxy-only" });
    expect(providerOnlyNetwork("codex")).toEqual({ version: 1, mode: "allowlist", hosts: [...PROVIDER_HOSTS["codex"]!].sort(), loopback: "proxy-only" });
    expect(legacyNetwork("claude", ["python"]).hosts).toEqual([...PROVIDER_HOSTS["claude"]!, ...REGISTRY_HOSTS.python].sort());
    expect(legacyNetwork("claude", []).loopback).toBe("proxy-only");
    expect(networkWords(null, "claude")).toContain("approved before network rules");
  });
});

describe("a stored network reads back exactly or not at all", () => {
  const good = { version: 1, mode: "allowlist", hosts: ["api.anthropic.com", "registry.npmjs.org"], loopback: "proxy-only" };
  test("exact keys, a known version and mode, normalized sorted unique hosts; open has none", () => {
    expect(networkFromValue(good)).toEqual(good);
    for (const bad of [
      { ...good, extra: 1 }, { ...good, version: 2 }, { ...good, mode: "wide" }, { ...good, loopback: "some" },
      { ...good, hosts: ["registry.npmjs.org", "api.anthropic.com"] }, { ...good, hosts: ["API.anthropic.com"] }, { ...good, hosts: ["1.2.3.4"] },
      { ...good, hosts: ["a.example", "a.example"] }, { ...good, mode: "open" }, { version: 1, mode: "allowlist", hosts: [] }, null, [], "x",
    ]) expect([bad, networkFromValue(bad)]).toEqual([bad, null]);
  });

  test("the most hosts a project may add still seal, beside its provider's and every registry's", () => {
    const project = Array.from({ length: 200 }, (_, i) => `h${i}.example`).sort();
    const sealed = resolveNetwork("claude", { mode: "allowlist", hosts: project, loopback: "proxy-only" }, ["go", "jvm", "npm", "python", "ruby", "rust"]);
    expect(networkFromValue(JSON.parse(JSON.stringify(sealed)))).toEqual(sealed);
  });

  test("a project setting: exact keys; a damaged one is refused (the store reads it as the narrowest)", () => {
    expect(projectNetworkFromValue({ mode: "allowlist", hosts: ["B.example", "a.example"], loopback: "any" })).toEqual({ mode: "allowlist", hosts: ["a.example", "b.example"], loopback: "any" });
    for (const bad of [{ mode: "allowlist", hosts: ["1.2.3.4"], loopback: "any" }, { mode: "allowlist", hosts: [], loopback: "any", x: 1 }, { mode: "x", hosts: [], loopback: "any" }]) {
      expect(projectNetworkFromValue(bad)).toBeNull();
    }
  });

  test("a run's record: what this code writes, nothing else", () => {
    const record = { mode: "allowlist", phase: "agent", hosts: 6, loopback: "proxy-only", counts: { connections: 3, refused: 1, otherHosts: 0, hosts: [{ host: "api.anthropic.com", connections: 3, refused: 0 }] } };
    expect(runNetworkFromValue(record)).toEqual(record);
    expect(runNetworkFromValue({ ...record, phase: "setup" })).toBeNull();
    expect(runNetworkFromValue({ ...record, counts: { ...record.counts, connections: -1 } })).toBeNull();
  });

  test("a profile carries its network sealed: absent stays absent (an approval from before keeps its digest), present is proved", () => {
    const legacy: ExecutionProfile = { provider: "claude", model: "claude-opus-5-5", permissionArgv: "auto", maxTurns: 200, repairMaxTurns: 20, timeoutSeconds: 1800, timeoutKind: "idle", repairTimeoutSeconds: 600, repairModel: "inherit" };
    const json = canonicalProfileJson(legacy);
    expect(profileFromJson(json)).toEqual(legacy);
    expect(json).not.toContain("network");
    const sealed = { ...legacy, network: providerOnlyNetwork("claude") };
    expect(profileFromJson(canonicalProfileJson(sealed))).toEqual(sealed);
    expect(profileDigestOf(sealed)).not.toBe(profileDigestOf(legacy));
    expect(profileDigestOf({ ...sealed, network: { ...sealed.network, hosts: [...sealed.network.hosts, "evil.example"].sort() } })).not.toBe(profileDigestOf(sealed));
    expect(profileFromJson(canonicalProfileJson({ ...legacy, network: { ...sealed.network, wide: true } } as never))).toBeNull();
  });
});

describe("the run's own proxy", () => {
  /** A plain local server, standing in for an approved public host (the proxy is told it is one). */
  async function upstream(): Promise<number> {
    const server: Server = createServer((incoming, outgoing) => outgoing.end(`upstream ${incoming.headers.host}`));
    closers.push(() => server.close());
    await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
    return (server.address() as { port: number }).port;
  }
  async function proxyFor(hosts: string[], port: number, decided: string[] = []): Promise<EgressProxy> {
    const proxy = await startEgressProxy({ hosts, lookup: async () => ["127.0.0.1"], addressAllowed: () => true, upstreamPort: () => port, decided: (host, allowed) => decided.push(`${host}:${allowed}`) });
    closers.push(() => proxy.close());
    return proxy;
  }
  const auth = (proxy: EgressProxy) => `Basic ${Buffer.from(new URL(proxy.url).username + ":" + new URL(proxy.url).password).toString("base64")}`;
  const get = (proxy: EgressProxy, url: string, headers: Record<string, string>) => new Promise<{ status: number; body: string }>((done, fail) => {
    const ask = request({ host: "127.0.0.1", port: proxy.port, path: url, headers }, answer => {
      let body = "";
      answer.on("data", chunk => { body += String(chunk); });
      answer.on("end", () => done({ status: answer.statusCode ?? 0, body }));
    });
    ask.on("error", fail);
    ask.end();
  });
  const tunnel = (proxy: EgressProxy, target: string, authorization: string | null) => new Promise<string>(done => {
    const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization === null ? "" : `Proxy-Authorization: ${authorization}\r\n`}\r\n`));
    socket.once("data", chunk => { done(String(chunk).split("\r\n")[0]!); socket.destroy(); });
    socket.on("error", () => done("error"));
  });

  test("only this run's credentials are served", async () => {
    const proxy = await proxyFor(["approved.example"], await upstream());
    expect((await get(proxy, "http://approved.example/", { host: "approved.example" })).status).toBe(407);
    expect(await tunnel(proxy, "approved.example:443", null)).toMatch(/ 407 /);
    expect(await tunnel(proxy, "approved.example:443", "Basic " + Buffer.from("run:guess").toString("base64"))).toMatch(/ 407 /);
  });

  test("an approved host is reached; anything else is refused and counted, by name, before it resolves", async () => {
    const decided: string[] = [];
    const proxy = await proxyFor(["approved.example"], await upstream(), decided);
    expect(await get(proxy, "http://approved.example/", { host: "approved.example", "proxy-authorization": auth(proxy) })).toEqual({ status: 200, body: "upstream approved.example" });
    expect((await get(proxy, "http://elsewhere.example/", { host: "elsewhere.example", "proxy-authorization": auth(proxy) })).status).toBe(403);
    expect(await tunnel(proxy, "approved.example:443", auth(proxy))).toMatch(/ 200 /);
    expect(await tunnel(proxy, "elsewhere.example:443", auth(proxy))).toMatch(/ 403 /);
    expect(proxy.counts()).toMatchObject({ connections: 2, refused: 2 });
    expect(decided).toEqual(["approved.example:true", "elsewhere.example:false", "approved.example:true", "elsewhere.example:false"]);
  });

  test("CONNECT reaches port 443 only and plain HTTP port 80 only; an address, a mismatched Host and a public-address check each refuse", async () => {
    const proxy = await proxyFor(["approved.example"], await upstream());
    expect(await tunnel(proxy, "approved.example:22", auth(proxy))).toMatch(/ 403 /);
    expect(await tunnel(proxy, "127.0.0.1:443", auth(proxy))).toMatch(/ 403 /);
    expect((await get(proxy, "http://approved.example:8080/", { host: "approved.example:8080", "proxy-authorization": auth(proxy) })).status).toBe(403);
    expect((await get(proxy, "http://approved.example/", { host: "internal.example", "proxy-authorization": auth(proxy) })).status).toBe(403);
    const strict = await startEgressProxy({ hosts: ["approved.example"], lookup: async () => ["10.0.0.5"] });
    closers.push(() => strict.close());
    expect(await tunnel(strict, "approved.example:443", auth(strict))).toMatch(/ 403 /);
    const mapped = await startEgressProxy({ hosts: ["approved.example"], lookup: async () => ["64:ff9b:0:0:0:0:7f00:1"] });
    closers.push(() => mapped.close());
    expect(await tunnel(mapped, "approved.example:443", auth(mapped))).toMatch(/ 403 /);
  });

  test("an open-network thread's proxy reaches any host by name; still never an address, another port, a private address or another run's credentials", async () => {
    const port = await upstream(), decided: string[] = [];
    const open = await startEgressProxy({ hosts: [], open: true, lookup: async () => ["127.0.0.1"], addressAllowed: () => true, upstreamPort: () => port, decided: (host, allowed) => decided.push(`${host}:${allowed}`) });
    closers.push(() => open.close());
    expect(await tunnel(open, "anything.example:443", auth(open))).toMatch(/ 200 /);
    expect((await get(open, "http://elsewhere.example/", { host: "elsewhere.example", "proxy-authorization": auth(open) })).status).toBe(200);
    expect(await tunnel(open, "anything.example:443", null)).toMatch(/ 407 /);
    expect(await tunnel(open, "anything.example:22", auth(open))).toMatch(/ 403 /);
    expect(await tunnel(open, "127.0.0.1:443", auth(open))).toMatch(/ 403 /);
    expect(await tunnel(open, "localhost:443", auth(open))).toMatch(/ 403 /);
    expect(decided).toEqual(["anything.example:true", "elsewhere.example:true", "anything.example:false", "(not a host name):false", "(not a host name):false"]);
    // The public-address rule holds in open mode too.
    const strict = await startEgressProxy({ hosts: [], open: true, lookup: async () => ["10.0.0.5"] });
    closers.push(() => strict.close());
    expect(await tunnel(strict, "anything.example:443", auth(strict))).toMatch(/ 403 /);
  });

  test("closing cancels what is pending: a lookup still resolving, a connection still being made, a socket that connects just after", async () => {
    // The client's answer, or "closed" when the proxy ends the connection without one.
    const ask = (proxy: EgressProxy, target: string) => new Promise<string>(done => {
      const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth(proxy)}\r\n\r\n`));
      socket.once("data", chunk => { done(String(chunk).split("\r\n")[0]!); socket.destroy(); });
      socket.on("error", () => done("closed"));
      socket.on("close", () => done("closed"));
    });
    // A plain TCP stand-in for the upstream: it counts what reaches it and what is still open.
    const upstreamSockets = new Set<Socket>();
    let reached = 0;
    const tcp: TcpServer = createTcpServer(socket => { reached++; upstreamSockets.add(socket); socket.on("close", () => upstreamSockets.delete(socket)); });
    closers.push(() => tcp.close());
    await new Promise<void>(done => tcp.listen(0, "127.0.0.1", () => done()));
    const port = (tcp.address() as { port: number }).port;
    // 1. Closed while the lookup is still pending: when it answers, nothing connects and the client is gone.
    let answer: (addresses: string[]) => void = () => {};
    let lookupSeen: () => void = () => {};
    const asked = new Promise<void>(seen => { lookupSeen = seen; });
    const deferred = await startEgressProxy({ hosts: ["approved.example"], addressAllowed: () => true, upstreamPort: () => port,
      lookup: () => new Promise(resolve => { answer = resolve; lookupSeen(); }) });
    const first = ask(deferred, "approved.example:443");
    await asked;
    await deferred.close();
    answer(["127.0.0.1"]);
    expect(await first).toBe("closed");
    await new Promise(done => setTimeout(done, 30));
    expect(reached).toBe(0);
    // 2. Closed while the upstream connection is being made: it is cancelled (its signal aborted), and a socket handed
    // over after the close is destroyed on arrival, never piped.
    let handOver: (socket: Socket | null) => void = () => {};
    let signalOf: AbortSignal | null = null;
    let connectSeen: () => void = () => {};
    const connecting = new Promise<void>(seen => { connectSeen = seen; });
    const slow = await startEgressProxy({ hosts: ["approved.example"], lookup: async () => ["127.0.0.1"], addressAllowed: () => true, upstreamPort: () => port,
      connect: (_addresses, to, signal) => { signalOf = signal; connectSeen(); return new Promise(resolve => { handOver = socket => resolve(socket); void to; }); } });
    const second = ask(slow, "approved.example:443");
    await connecting;
    await slow.close();
    expect(signalOf!.aborted).toBe(true);
    const late = connect(port, "127.0.0.1");
    await new Promise<void>(done => late.once("connect", () => done()));
    handOver(late);
    expect(await second).toBe("closed");
    for (let i = 0; i < 50 && (upstreamSockets.size > 0 || !late.destroyed); i++) await new Promise(done => setTimeout(done, 10));
    expect(late.destroyed).toBe(true);
    expect(upstreamSockets.size).toBe(0);
    // Only the hand-over itself ever reached the upstream (step 1 never connected).
    expect(reached).toBeLessThanOrEqual(1);
    // 3. The real connector: an aborted signal starts no attempt at all.
    let touched = 0;
    const quiet: TcpServer = createTcpServer(socket => { touched++; socket.destroy(); });
    closers.push(() => quiet.close());
    await new Promise<void>(done => quiet.listen(0, "127.0.0.1", () => done()));
    const aborted = new AbortController();
    aborted.abort();
    expect(await connectFirst(["127.0.0.1"], (quiet.address() as { port: number }).port, 1_000, aborted.signal)).toBeNull();
    await new Promise(done => setTimeout(done, 30));
    expect(touched).toBe(0);
  });

  test("a plain request may name port 80 in its Host", async () => {
    const proxy = await proxyFor(["approved.example"], await upstream());
    expect((await get(proxy, "http://approved.example:80/", { host: "approved.example:80", "proxy-authorization": auth(proxy) })).status).toBe(200);
  });

  test("its counts are bounded: fifty hosts, the rest summed", async () => {
    const proxy = await proxyFor([], await upstream());
    for (let i = 0; i < 55; i++) await tunnel(proxy, `h${i}.example:443`, auth(proxy));
    const counts = proxy.counts();
    expect(counts.hosts).toHaveLength(50);
    expect(counts.otherHosts).toBe(5);
    expect(counts.refused).toBe(55);
  });
});
