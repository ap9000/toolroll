import { afterEach, describe, expect, test } from "vitest";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ecosystemsOf, hostAllowed, legacyNetwork, networkFromValue, networkWords, normalizeHost, projectNetworkFromValue, providerOnlyNetwork,
  repositoryEcosystems, resolveNetwork, runNetworkFromValue, startEgressProxy, PROJECT_NETWORK_DEFAULT, PROVIDER_HOSTS, REGISTRY_HOSTS, type EgressProxy,
} from "./egress.js";
import { canonicalProfileJson, profileDigestOf, profileFromJson, type ExecutionProfile } from "./scope.js";

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
    expect(networkWords(network)).toBe("Network: the agent's provider, npm, and api.stripe.com");
    expect(resolveNetwork("claude", { mode: "open", hosts: [], loopback: "any" }, ["npm"])).toEqual({ version: 1, mode: "open", hosts: [], loopback: "any" });
    expect(networkWords(resolveNetwork("claude", { mode: "open", hosts: [], loopback: "any" }, []))).toBe("Network: open — any host, and every local service on this Mac");
  });

  test("the defaults are the narrow ones: no local services, provider-only for launches nothing sealed, legacy approvals narrowed", () => {
    expect(PROJECT_NETWORK_DEFAULT).toEqual({ mode: "allowlist", hosts: [], loopback: "proxy-only" });
    expect(providerOnlyNetwork("codex")).toEqual({ version: 1, mode: "allowlist", hosts: [...PROVIDER_HOSTS["codex"]!].sort(), loopback: "proxy-only" });
    expect(legacyNetwork("claude", ["python"]).hosts).toEqual([...PROVIDER_HOSTS["claude"]!, ...REGISTRY_HOSTS.python].sort());
    expect(legacyNetwork("claude", []).loopback).toBe("proxy-only");
    expect(networkWords(null)).toContain("approved before network rules");
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

describe("the Linux bridge's forwarder", () => {
  test("ends as its agent ended, a signal included, without waiting on anything", async () => {
    const { startEgressBridge } = await import("./egress-bridge.js");
    const { spawn } = await import("node:child_process");
    const bridge = await startEgressBridge([]);
    closers.push(() => bridge.close());
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>(done => {
      const started = Date.now();
      const child = spawn(process.execPath, [bridge.forwarder, bridge.folder, "--", "/bin/sh", "-c", "kill -TERM $$"], { stdio: "ignore" });
      child.on("exit", (code, signal) => done({ code, signal, ms: Date.now() - started }));
    });
    expect(ended.signal ?? ended.code).toBe("SIGTERM");
    expect(ended.ms).toBeLessThan(3000);
  });

  test("is made only in a private folder of this user's: never through a link planted where the folder should be", async () => {
    const { startEgressBridge } = await import("./egress-bridge.js");
    const { chmodSync, symlinkSync } = await import("node:fs");
    // A short folder: a socket's whole path must stay under ~100 bytes.
    const dir = realpathSync(mkdtempSync("/tmp/sob-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const elsewhere = join(dir, "elsewhere"), planted = join(dir, "bridge-secrets"), open = join(dir, "open");
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(open);
    chmodSync(open, 0o777);
    symlinkSync(elsewhere, planted);
    await expect(startEgressBridge([], planted)).rejects.toThrow(/isn't a private folder/);
    await expect(startEgressBridge([], open)).rejects.toThrow(/isn't a private folder/);
    // A private folder too deep for a socket path is refused in words, never truncated.
    const deep = join(elsewhere, "x".repeat(90));
    mkdirSync(deep, { mode: 0o700 });
    await expect(startEgressBridge([], deep)).rejects.toThrow(/too deep for a socket path/);
    const own = await startEgressBridge([], elsewhere);
    closers.push(() => own.close());
    expect(own.folder.startsWith(elsewhere)).toBe(true);
  });
});
