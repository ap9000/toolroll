/**
 * What a build may reach on the network (docs/plans/agent-baseline-hardening.md, arc 1).
 *
 * A run's network is part of its sealed execution profile: the hosts it may reach are resolved once, when the scope
 * is written (the provider's own hosts, the package registries the project's own checkout names,
 * and the project's added hosts), and that snapshot is what the approval binds and the launch enforces. Nothing at
 * launch re-derives it from settings changed since or from files the agent wrote.
 *
 * The launch enforces it at the operating system (agent-fence.ts: Seatbelt's network rules on macOS, a network
 * namespace on Linux) and reaches the world through one proxy of its own (startEgressProxy), which admits only the
 * snapshot's hosts. The proxy never decrypts TLS: it restricts where a build connects, not what it sends there.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP, type Socket } from "node:net";
import { domainToASCII } from "node:url";
import { readdirSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { connectFirst, isPublicAddress, type Lookup } from "./scout-net.js";
import { lookup as dnsLookup } from "node:dns/promises";

/** The policy's shape version: a worker enforces the versions it knows and refuses any other. */
export const NETWORK_POLICY_VERSION = 1;

/** `allowlist`: only the snapshot's hosts, through the run's proxy. `open`: anywhere (an approver's explicit choice). */
export type NetworkMode = "allowlist" | "open";
/**
 * What a build may reach on this machine's own loopback. Linux gives every build a loopback of its own, so this only
 * matters on macOS, where one loopback serves everything and the sandbox can't admit some local ports while refusing
 * others: `proxy-only` (the default) admits nothing local but the run's own proxy and tool broker; `any` admits every
 * local service on this Mac — local test servers, and also anything else listening here — an approver's explicit choice.
 */
export type LoopbackMode = "any" | "proxy-only";

/** The network a scope was approved with (sealed in its execution profile). */
export type NetworkProfile = { version: 1; mode: NetworkMode; hosts: string[]; loopback: LoopbackMode };

/** A project's own network setting (an approver's): what new scopes of it are written with. */
export type ProjectNetwork = { mode: NetworkMode; hosts: string[]; loopback: LoopbackMode };
export const PROJECT_NETWORK_DEFAULT: ProjectNetwork = { mode: "allowlist", hosts: [], loopback: "proxy-only" };

/** At most this many hosts a project adds (a list longer than this is a different policy: open). */
export const MAX_NETWORK_HOSTS = 200;
/** At most this many in a sealed snapshot: the project's, plus its provider's and every registry's. */
export const MAX_SNAPSHOT_HOSTS = MAX_NETWORK_HOSTS + 100;

/**
 * A host as a policy names it: lowercase ASCII (an international name in its punycode form), no trailing dot, at
 * least two labels, each 1–63 letters, digits or hyphens; or `*.` and such a name, for every name under it. Never an
 * IP address, a port, a path or a bare top-level name. Null when it is none of these.
 */
export function normalizeHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  const wildcard = trimmed.startsWith("*.");
  const bare = wildcard ? trimmed.slice(2) : trimmed;
  if (bare === "" || bare.length > 253 || isIP(bare.replace(/^\[|\]$/g, "")) !== 0) return null;
  // Nothing of a URL's other parts: the converter below would quietly cut a name at a slash or a colon.
  if (/[\s/\\:@?#%[\]*,;]/.test(bare)) return null;
  const ascii = domainToASCII(bare);
  if (ascii === "" || ascii !== ascii.toLowerCase()) return null;
  const labels = ascii.split(".");
  if (labels.length < 2) return null;
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  // A name whose last label is all digits reads as an address to too many resolvers.
  if (/^\d+$/.test(labels.at(-1)!)) return null;
  return wildcard ? `*.${ascii}` : ascii;
}

/** Whether `host` (as a client named it) is one a policy's list admits: an exact name, or a name under a `*.` entry. */
export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  const name = normalizeHost(host);
  if (name === null || name.startsWith("*.")) return false;
  return hosts.some(entry => entry === name || (entry.startsWith("*.") && name.endsWith(entry.slice(1))));
}

/**
 * Each provider's own hosts (catalog version 1): its model API and the sign-in refresh its CLI needs. Codex starts
 * its harness outside its command sandbox, so its hosts matter only to what its commands may reach. An ACP agent
 * talks to whatever model service it was set up with; its row names the hosts its own service uses.
 */
export const PROVIDER_HOSTS: Readonly<Record<string, readonly string[]>> = {
  claude: ["api.anthropic.com", "console.anthropic.com", "platform.claude.com"],
  codex: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  openrouter: ["openrouter.ai"],
  gemini: ["generativelanguage.googleapis.com", "cloudcode-pa.googleapis.com", "oauth2.googleapis.com"],
  opencode: ["opencode.ai", "*.opencode.ai", "models.dev"],
  cursor: ["*.cursor.sh", "*.cursor.com"],
  cline: ["api.cline.bot"],
  qwen: ["chat.qwen.ai", "dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"],
  // Goose talks to whatever model service it is set up with: a project using it adds that service's host.
  goose: [],
};

/** A package ecosystem a project's files name, and the registry hosts its installs read from. */
export type Ecosystem = "npm" | "python" | "rust" | "go" | "ruby" | "jvm";
export const REGISTRY_HOSTS: Readonly<Record<Ecosystem, readonly string[]>> = {
  npm: ["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com", "nodejs.org"],
  python: ["pypi.org", "files.pythonhosted.org"],
  rust: ["crates.io", "index.crates.io", "static.crates.io"],
  go: ["proxy.golang.org", "sum.golang.org"],
  ruby: ["rubygems.org", "index.rubygems.org"],
  jvm: ["repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org", "services.gradle.org", "downloads.gradle.org"],
};

/** The files that name each ecosystem, by file name wherever they are in the tree. */
const ECOSYSTEM_FILES: Readonly<Record<string, Ecosystem>> = {
  "package.json": "npm", "package-lock.json": "npm", "npm-shrinkwrap.json": "npm", "yarn.lock": "npm", "pnpm-lock.yaml": "npm", "bun.lock": "npm", "bun.lockb": "npm",
  "pyproject.toml": "python", "requirements.txt": "python", "pipfile": "python", "pipfile.lock": "python", "poetry.lock": "python", "uv.lock": "python", "setup.py": "python", "setup.cfg": "python",
  "cargo.toml": "rust", "cargo.lock": "rust",
  "go.mod": "go", "go.sum": "go",
  "gemfile": "ruby", "gemfile.lock": "ruby",
  "pom.xml": "jvm", "build.gradle": "jvm", "build.gradle.kts": "jvm", "settings.gradle": "jvm", "settings.gradle.kts": "jvm",
};

/** The ecosystems a list of repository paths names (requirements-*.txt counts as Python). */
export function ecosystemsOf(paths: readonly string[]): Ecosystem[] {
  const found = new Set<Ecosystem>();
  for (const path of paths) {
    const name = basename(path).toLowerCase();
    const one = ECOSYSTEM_FILES[name] ?? (/^requirements[\w.-]*\.txt$/.test(name) ? "python" : undefined);
    if (one !== undefined) found.add(one);
  }
  return [...found].sort();
}

/** How deep and how wide the walk for ecosystem files goes (a monorepo names its ecosystems near its root). */
const WALK_DEPTH = 3, WALK_LIMIT = 5_000;
const WALK_SKIP = new Set(["node_modules", "vendor", "target", "dist", "build", "venv", "__pycache__"]);

/**
 * The ecosystems the project's own checkout names: its files a few folders deep, read straight from the folder the
 * plane registered (which no build can write: agent-fence.ts taskBoundary), never a build's worktree. No process is
 * started and nothing in the repository runs. An unreadable folder names none: its builds reach the provider and the
 * project's own hosts only.
 */
export function repositoryEcosystems(repo: string): Ecosystem[] {
  const paths: string[] = [];
  const walk = (folder: string, depth: number): void => {
    let entries: Dirent[];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (paths.length >= WALK_LIMIT) return;
      if (entry.isFile()) paths.push(join(folder, entry.name));
      else if (entry.isDirectory() && depth < WALK_DEPTH && !entry.name.startsWith(".") && !WALK_SKIP.has(entry.name)) walk(join(folder, entry.name), depth + 1);
    }
  };
  walk(repo, 0);
  return ecosystemsOf(paths);
}

/** The network a new scope is written with: the project's setting, its provider's hosts and its ecosystems' registries. */
export function resolveNetwork(provider: string, project: ProjectNetwork, ecosystems: readonly Ecosystem[]): NetworkProfile {
  if (project.mode === "open") return { version: NETWORK_POLICY_VERSION, mode: "open", hosts: [], loopback: project.loopback };
  const hosts = new Set<string>([
    ...(PROVIDER_HOSTS[provider] ?? []),
    ...ecosystems.flatMap(one => REGISTRY_HOSTS[one]),
    ...project.hosts,
  ]);
  return { version: NETWORK_POLICY_VERSION, mode: "allowlist", hosts: [...hosts].sort(), loopback: project.loopback };
}

/** The network of a launch nothing sealed one for (a planner, a check): its provider's own hosts and nothing else. */
export function providerOnlyNetwork(provider: string): NetworkProfile {
  return { version: NETWORK_POLICY_VERSION, mode: "allowlist", hosts: [...new Set(PROVIDER_HOSTS[provider] ?? [])].sort(), loopback: "proxy-only" };
}

/**
 * The network an approval sealed before network policies existed runs under: a deliberate narrowing (provider hosts
 * and the repository's registries, nothing the project added since, local services of this Mac out of reach). Never
 * widened by a setting changed after it was approved.
 */
export function legacyNetwork(provider: string, ecosystems: readonly Ecosystem[]): NetworkProfile {
  return { ...resolveNetwork(provider, { mode: "allowlist", hosts: [], loopback: "proxy-only" }, ecosystems) };
}

/** Strict re-hydration (scope.ts profileFromJson): exactly the keys this code writes, every host normalized, or null. */
export function networkFromValue(value: unknown): NetworkProfile | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length !== 4 || !["version", "mode", "hosts", "loopback"].every(key => keys.includes(key))) return null;
  if (v["version"] !== NETWORK_POLICY_VERSION) return null;
  if (v["mode"] !== "allowlist" && v["mode"] !== "open") return null;
  if (v["loopback"] !== "any" && v["loopback"] !== "proxy-only") return null;
  if (!Array.isArray(v["hosts"]) || v["hosts"].length > MAX_SNAPSHOT_HOSTS) return null;
  const hosts: string[] = [];
  for (const one of v["hosts"]) {
    if (typeof one !== "string" || normalizeHost(one) !== one) return null;
    hosts.push(one);
  }
  if (v["mode"] === "open" && hosts.length > 0) return null;
  if (new Set(hosts).size !== hosts.length || hosts.some((one, index) => index > 0 && hosts[index - 1]! >= one)) return null;
  return { version: NETWORK_POLICY_VERSION, mode: v["mode"], hosts, loopback: v["loopback"] };
}

/** A project setting as saved (store.ts project_network), or null when it isn't one this code wrote. */
export function projectNetworkFromValue(value: unknown): ProjectNetwork | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 3 || (v["mode"] !== "allowlist" && v["mode"] !== "open") || (v["loopback"] !== "any" && v["loopback"] !== "proxy-only")) return null;
  if (!Array.isArray(v["hosts"]) || v["hosts"].length > MAX_NETWORK_HOSTS) return null;
  const hosts = v["hosts"].map(one => typeof one === "string" ? normalizeHost(one) : null);
  if (hosts.some(one => one === null)) return null;
  return { mode: v["mode"], hosts: [...new Set(hosts as string[])].sort(), loopback: v["loopback"] };
}

/** The network in plain words, for an approval card and a run's record. */
export function networkWords(network: NetworkProfile | null): string {
  if (network === null) return "Network: approved before network rules (provider and package registries only)";
  if (network.mode === "open") return `Network: open — any host${network.loopback === "proxy-only" ? "" : ", and every local service on this Mac"}`;
  const registries = (Object.entries(REGISTRY_HOSTS) as [Ecosystem, readonly string[]][])
    .filter(([, hosts]) => hosts.every(one => network.hosts.includes(one))).map(([name]) => REGISTRY_NAMES[name]);
  const known = new Set([...Object.values(REGISTRY_HOSTS).flat(), ...Object.values(PROVIDER_HOSTS).flat()]);
  const added = network.hosts.filter(one => !known.has(one));
  return `Network: the agent's provider${registries.length === 0 ? "" : `, ${registries.join(", ")}`}${added.length === 0 ? "" : `, and ${added.join(", ")}`}`
    + (network.loopback === "any" ? "; and every local service on this Mac" : "");
}
const REGISTRY_NAMES: Readonly<Record<Ecosystem, string>> = { npm: "npm", python: "PyPI", rust: "crates.io", go: "the Go proxy", ruby: "RubyGems", jvm: "Maven and Gradle" };

/** What the run's proxy saw: connections it made and refused, by host (at most HOST_LIMIT hosts, the rest summed). */
export type EgressCounts = { connections: number; refused: number; hosts: { host: string; connections: number; refused: number }[]; otherHosts: number };
const HOST_LIMIT = 50;

/** What a run's record keeps about its network: the mode it ran under, whether a caller's own proxy carried it, how many
 * hosts its list held, and what the run's proxy saw. */
export type RunNetworkRecord = { mode: "open" | "allowlist"; phase: "agent"; via?: true; hosts?: number; loopback?: LoopbackMode; counts?: EgressCounts };

/** A stored record read back strictly: anything this code didn't write reads as none. */
export function runNetworkFromValue(value: unknown): RunNetworkRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if ((v["mode"] !== "open" && v["mode"] !== "allowlist") || v["phase"] !== "agent") return null;
  const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const out: RunNetworkRecord = { mode: v["mode"], phase: "agent" };
  if (v["via"] === true) out.via = true;
  if (v["hosts"] !== undefined) { if (!count(v["hosts"])) return null; out.hosts = v["hosts"] as number; }
  if (v["loopback"] !== undefined) { if (v["loopback"] !== "any" && v["loopback"] !== "proxy-only") return null; out.loopback = v["loopback"]; }
  if (v["counts"] !== undefined) {
    const c = v["counts"] as Record<string, unknown> | null;
    if (c === null || typeof c !== "object" || !count(c["connections"]) || !count(c["refused"]) || !count(c["otherHosts"]) || !Array.isArray(c["hosts"]) || c["hosts"].length > HOST_LIMIT) return null;
    const hosts: EgressCounts["hosts"] = [];
    for (const one of c["hosts"] as unknown[]) {
      const h = one as Record<string, unknown> | null;
      if (h === null || typeof h !== "object" || typeof h["host"] !== "string" || h["host"].length > 300 || !count(h["connections"]) || !count(h["refused"])) return null;
      hosts.push({ host: h["host"], connections: h["connections"] as number, refused: h["refused"] as number });
    }
    out.counts = { connections: c["connections"] as number, refused: c["refused"] as number, hosts, otherHosts: c["otherHosts"] as number };
  }
  return out;
}

export type EgressProxy = {
  /** The proxy's address with this run's credentials, for HTTPS_PROXY and the like. */
  url: string;
  port: number;
  counts: () => EgressCounts;
  close: () => Promise<void>;
};

/** Every proxy setting a program might read, both cases, so none falls back to a direct connection the OS refuses. */
export function proxyEnv(proxy: EgressProxy, loopback: LoopbackMode): Record<string, string> {
  const local = loopback === "proxy-only" ? "" : "localhost,127.0.0.1,::1";
  return {
    HTTPS_PROXY: proxy.url, https_proxy: proxy.url, HTTP_PROXY: proxy.url, http_proxy: proxy.url, ALL_PROXY: proxy.url, all_proxy: proxy.url,
    NO_PROXY: local, no_proxy: local,
    // Node's own fetch reads the proxy variables only when told to (Node 24 and later; earlier versions ignore it).
    NODE_USE_ENV_PROXY: "1",
  };
}

/**
 * Start one run's proxy on loopback. Only a client presenting this run's credentials is served (another run's agent
 * on the same machine can't borrow it). CONNECT goes only to port 443 and plain HTTP only to port 80, only to a host
 * the run's list admits (matched by name before it is resolved), only to public addresses (the proxy resolves the
 * name itself and connects to exactly the addresses it checked). A plain HTTP request's Host must be the URL's host.
 */
export async function startEgressProxy(options: {
  hosts: readonly string[]; lookup?: Lookup; decided?: (host: string, allowed: boolean, why: string) => void;
  /** Tests only: which resolved addresses may be reached (default: public internet addresses), and the port an
   * approved request is relayed to (default: the one it asked for). */
  addressAllowed?: (address: string) => boolean; upstreamPort?: (port: number) => number;
}): Promise<EgressProxy> {
  const addressAllowed = options.addressAllowed ?? isPublicAddress;
  const upstreamPort = options.upstreamPort ?? ((port: number) => port);
  const lookup = options.lookup ?? (async (host: string) => (await dnsLookup(host, { all: true, verbatim: true })).map(one => one.address));
  const secret = randomBytes(24).toString("base64url");
  const expected = Buffer.from(`Basic ${Buffer.from(`run:${secret}`).toString("base64")}`);
  const sockets = new Set<Socket>();
  const byHost = new Map<string, { connections: number; refused: number }>();
  let connections = 0, refused = 0, otherHosts = 0;
  const count = (host: string, allowed: boolean, why: string): void => {
    if (allowed) connections++; else refused++;
    const key = normalizeHost(host) ?? "(not a host name)";
    let entry = byHost.get(key);
    if (entry === undefined && byHost.size >= HOST_LIMIT) { otherHosts++; return; }
    if (entry === undefined) { entry = { connections: 0, refused: 0 }; byHost.set(key, entry); }
    if (allowed) entry.connections++; else entry.refused++;
    try { options.decided?.(key, allowed, why); } catch { /* a listener's trouble is not the build's */ }
  };
  const authorized = (incoming: IncomingMessage): boolean => {
    const given = Buffer.from(String(incoming.headers["proxy-authorization"] ?? ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  /** The addresses a request may reach, or why it may not. */
  const admit = async (host: string, port: number, wantPort: number): Promise<{ ok: true; addresses: readonly string[] } | { ok: false; why: string }> => {
    if (port !== wantPort) return { ok: false, why: `port ${port} is not allowed` };
    if (!hostAllowed(host, options.hosts)) return { ok: false, why: "not an approved host" };
    let addresses: readonly string[];
    try { addresses = await lookup(normalizeHost(host)!); } catch { return { ok: false, why: "the host does not resolve" }; }
    if (addresses.length === 0) return { ok: false, why: "the host does not resolve" };
    if (!addresses.every(addressAllowed)) return { ok: false, why: "not a public internet address" };
    return { ok: true, addresses };
  };

  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    void (async () => {
      if (!authorized(incoming)) { outgoing.writeHead(407, { "proxy-authenticate": 'Basic realm="toolroll"' }).end(); return; }
      let url: URL;
      try { url = new URL(incoming.url ?? ""); } catch { outgoing.writeHead(400).end(); return; }
      const hostHeader = String(incoming.headers.host ?? "").toLowerCase();
      const sameHost = hostHeader === url.host.toLowerCase() || hostHeader === url.hostname.toLowerCase() || (url.port === "" && hostHeader === `${url.hostname.toLowerCase()}:80`);
      if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || !sameHost) {
        count(url.hostname, false, "not a plain web request for its own host");
        outgoing.writeHead(403, { "content-type": "text/plain" }).end("Toolroll: this build may reach only its approved hosts.");
        return;
      }
      const reached = await admit(url.hostname, Number(url.port || 80), 80);
      if (!reached.ok) {
        count(url.hostname, false, reached.why);
        outgoing.writeHead(403, { "content-type": "text/plain" }).end(`Toolroll: ${url.hostname} is not one of this build's approved hosts.`);
        return;
      }
      const upstream = await connectFirst(reached.addresses, upstreamPort(80));
      if (upstream === null) { outgoing.writeHead(502).end(); return; }
      count(url.hostname, true, "approved");
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
      if (!authorized(incoming)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="toolroll"\r\nContent-Length: 0\r\n\r\n'); return; }
      const match = /^([^:[\]\s]+):(\d{1,5})$/.exec(incoming.url ?? "");
      const reached = match === null ? { ok: false as const, why: "not a host name and port" } : await admit(match[1]!, Number(match[2]), 443);
      if (!reached.ok) {
        count(match?.[1] ?? String(incoming.url ?? ""), false, reached.why);
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = await connectFirst(reached.addresses, upstreamPort(443));
      if (upstream === null) { if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); return; }
      count(match![1]!, true, "approved");
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
    url: `http://run:${secret}@127.0.0.1:${port}`,
    port,
    counts: () => ({ connections, refused, hosts: [...byHost].map(([host, one]) => ({ host, ...one })).sort((a, b) => b.connections + b.refused - (a.connections + a.refused) || a.host.localeCompare(b.host)), otherHosts }),
    close: () => new Promise<void>(done => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}
