/**
 * The tool broker: a launch's project tools keep their secrets in Toolroll's
 * own process. The agent's config names a loopback address and a token for
 * this launch only — its opted-in tools, a research step's read-only actions
 * — and the token stops working when the launch ends. Fresh and resumed
 * builds each get their own. (The macOS proof that a fenced shell can't read
 * the secrets by file, descriptor or process listing is in agent-fence.slow.test.ts.)
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serverEnv, startToolBroker, type ToolBroker } from "./tool-broker.js";
import { addToolTo, codexToolArgs, prepareRunTools, setToolSecrets, type ToolSpec } from "./project-tools.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { invokeAgent } from "./invoke.js";
import * as fencing from "./agent-fence.js";
import { macosFenceAvailable } from "./agent-fence.js";
import { NOTES_SERVER } from "../test/notes-mcp-server.js";
import { boundCheckout } from "../test/bound-checkout.js";
vi.mock("./agent-fence.js", { spy: true });

const T0 = new Date("2026-10-12T12:00:00.000Z");
const SECRET = ["notes", "secret", "7c".repeat(16)].join("-");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");


const notesSpec = (server: string, log: string): ToolSpec => ({ name: "notes", transport: "stdio", command: process.execPath, args: [server, log], url: null, secrets: [{ name: "NOTES_TOKEN", optional: false }], bearer: null, headerSecrets: {}, about: "Notes" });

type Rpc = { status: number; body: { result?: { content?: { text: string }[]; tools?: { name: string }[] }; error?: { code: number; message: string } } | null };
let nextId = 1;
async function rpc(url: string, authorization: string | null, method: string, params: unknown = {}): Promise<Rpc> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization === null ? {} : { authorization }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await response.text();
  const json = (response.headers.get("content-type") ?? "").includes("text/event-stream") ? text.split("\n").find(line => line.startsWith("data:"))!.slice(5) : text;
  return { status: response.status, body: json === "" ? null : JSON.parse(json) as Rpc["body"] };
}
const start = (url: string, token: string) => rpc(url, `Bearer ${token}`, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
const text = (answer: Rpc) => answer.body?.result?.content?.[0]?.text;

describe("the tool broker", () => {
  let dir: string, server: string, log: string, broker: ToolBroker | null;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-broker-test-")));
    server = join(dir, "notes.mjs");
    log = join(dir, "notes.log");
    writeFileSync(server, NOTES_SERVER);
    broker = null;
  });
  afterEach(() => { broker?.close(); rmSync(dir, { recursive: true, force: true }); });
  const logged = () => existsSync(log) ? readFileSync(log, "utf8") : "";

  test("a local tool starts on first use with its secret, answers through the token, and stops when the launch closes", async () => {
    broker = await startToolBroker([{ spec: notesSpec(server, log), values: { NOTES_TOKEN: SECRET } }]);
    const url = broker.url("notes");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/notes$/);
    expect(logged()).toBe("");
    expect((await start(url, broker.token)).body?.result).toMatchObject({ serverInfo: { name: "notes" } });
    expect((await rpc(url, `Bearer ${broker.token}`, "tools/list")).body?.result?.tools?.map(one => one.name)).toEqual(["read_note", "delete_note", "ask_roots"]);
    // The server got its secret from the broker; the agent only ever sees the answer.
    expect(text(await rpc(url, `Bearer ${broker.token}`, "tools/call", { name: "read_note", arguments: {} }))).toBe(digest(SECRET));
    // A notification is accepted, and a server's own request is answered for it: nobody is there to ask.
    const note = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(note.status).toBe(202);
    expect(text(await rpc(url, `Bearer ${broker.token}`, "tools/call", { name: "ask_roots", arguments: {} }))).toBe("asked");
    expect(logged()).toContain('roots {"code":-32601');
    const [pid] = broker.pids();
    expect(pid).toEqual(expect.any(Number));

    // Anything but this launch's token, or a tool it wasn't given, is refused.
    expect((await rpc(url, null, "tools/list")).status).toBe(401);
    expect((await rpc(url, "Bearer not-the-token", "tools/list")).status).toBe(401);
    expect((await rpc(url.replace(/notes$/, "other"), `Bearer ${broker.token}`, "tools/list")).status).toBe(404);

    // Closed: the token is revoked, the port shut, the server stopped.
    broker.close();
    await expect(rpc(url, `Bearer ${broker.token}`, "tools/list")).rejects.toThrow();
    await expect.poll(() => { try { process.kill(pid!, 0); return true; } catch { return false; } }).toBe(false);
  });

  test("a research step's tool lists and runs only its read-only actions; a refused call never reaches the server", async () => {
    broker = await startToolBroker([{ spec: notesSpec(server, log), values: { NOTES_TOKEN: SECRET }, actions: ["read_note"] }]);
    const url = broker.url("notes");
    await start(url, broker.token);
    expect((await rpc(url, `Bearer ${broker.token}`, "tools/list")).body?.result?.tools?.map(one => one.name)).toEqual(["read_note"]);
    const refused = await rpc(url, `Bearer ${broker.token}`, "tools/call", { name: "delete_note", arguments: {} });
    expect(refused.body?.error).toMatchObject({ code: -32601 });
    expect(text(await rpc(url, `Bearer ${broker.token}`, "tools/call", { name: "read_note", arguments: {} }))).toBe(digest(SECRET));
    expect(logged()).toContain("call read_note");
    expect(logged()).not.toContain("call delete_note");
    for (const method of ["resources/read", "resources/subscribe", "resources/unsubscribe", "prompts/get", "completion/complete"]) {
      expect((await rpc(url, `Bearer ${broker.token}`, method, { name: "read_note", uri: "private://note" })).body?.error?.code).toBe(-32601);
    }

  });

  test.each(["application/json", "text/event-stream"])("research web batches authorize parsed JSON and filter tools, resources and prompts (%s)", async contentType => {
    const received: string[] = [];
    const web = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        received.push(body);
        const parsed = JSON.parse(body) as { id: number; method: string }[];
        const answers = parsed.filter(one => one.id !== undefined).map(one => ({ jsonrpc: "2.0", id: one.id, result: {
          tools: [{ name: "read_note" }, { name: "delete_note" }], resources: [{ uri: "private://note" }],
          resourceTemplates: [{ uriTemplate: "private://{id}" }], prompts: [{ name: "delete_note" }],
        } }));
        response.writeHead(200, { "content-type": contentType, "mcp-session-id": "kept-session" });
        response.end(contentType === "application/json" ? JSON.stringify(answers) : `data: [\r\ndata: ${answers.map(one => JSON.stringify(one)).join(",")}\r\ndata: ]\r\n\r\n`);
      });
    });
    await new Promise<void>(resolve => web.listen(0, "127.0.0.1", resolve));
    try {
      const spec: ToolSpec = { ...notesSpec(server, log), transport: "http", command: null, args: [], url: `http://127.0.0.1:${(web.address() as AddressInfo).port}`, bearer: "NOTES_TOKEN" };
      broker = await startToolBroker([{ spec, values: { NOTES_TOKEN: SECRET }, actions: ["read_note"] }]);
      const methods = ["tools/list", "resources/list", "resources/templates/list", "prompts/list", "resources/read", "resources/subscribe", "resources/unsubscribe", "prompts/get", "completion/complete"];
      const messages = methods.map((method, id) => ({ jsonrpc: "2.0", id, method }));
      // A duplicate method key must not survive the broker's parse/authorize boundary.
      const body = JSON.stringify(messages).replace('"method":"tools/list"', '"method":"resources/read","method":"tools/list"');
      const response = await fetch(broker.url("notes"), { method: "POST", headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" }, body });
      expect(response.headers.get("mcp-session-id")).toBe("kept-session");
      const raw = await response.text();
      const answers = contentType === "application/json" ? JSON.parse(raw) : raw.split("\n").filter(line => line.startsWith("data:")).flatMap(line => JSON.parse(line.slice(5)));
      expect(received).toEqual([JSON.stringify(messages.slice(0, 4))]);
      expect(answers).toHaveLength(methods.length);
      for (const answer of answers.slice(0, 4)) expect(answer.result).toEqual({ tools: [{ name: "read_note" }], resources: [], resourceTemplates: [], prompts: [] });
      for (const answer of answers.slice(4)) expect(answer.error.code).toBe(-32601);
    } finally {
      await new Promise(resolve => web.close(resolve));
    }
  });

  test("a research batch the web server accepts with an empty 202 still answers its refused requests as JSON; with nothing refused the 202 passes as it is", async () => {
    let upstream: { status: number; type?: string; body: string } = { status: 202, body: "" };
    const received: string[] = [];
    const web = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        received.push(body);
        response.writeHead(upstream.status, { ...(upstream.type === undefined ? {} : { "content-type": upstream.type }), "mcp-session-id": "relay-session" });
        response.end(upstream.body);
      });
    });
    await new Promise<void>(resolve => web.listen(0, "127.0.0.1", resolve));
    try {
      const spec: ToolSpec = { ...notesSpec(server, log), transport: "http", command: null, args: [], url: `http://127.0.0.1:${(web.address() as AddressInfo).port}`, bearer: "NOTES_TOKEN" };
      broker = await startToolBroker([{ spec, values: { NOTES_TOKEN: SECRET }, actions: ["read_note"] }]);
      const post = (messages: unknown[]) => fetch(broker!.url("notes"), { method: "POST", headers: { authorization: `Bearer ${broker!.token}`, "content-type": "application/json" }, body: JSON.stringify(messages) });
      const accepted = { jsonrpc: "2.0", method: "notifications/initialized" };
      const write = { jsonrpc: "2.0", id: "refused-write-marker", method: "tools/call", params: { name: "delete_note", arguments: {} } };

      // Mixed: the notification is relayed and accepted with an empty 202; the refused write is still answered.
      const mixed = await post([accepted, write]);
      expect(mixed.status).toBe(200);
      expect(mixed.headers.get("content-type")).toBe("application/json");
      expect(mixed.headers.get("mcp-session-id")).toBe("relay-session");
      expect(await mixed.json()).toEqual([{ jsonrpc: "2.0", id: "refused-write-marker", error: { code: -32601, message: "This step may only read: that action is not available." } }]);
      expect(received).toEqual([JSON.stringify([accepted])]);

      // Nothing refused: the server's empty 202 is passed on unchanged.
      const plain = await post([accepted]);
      expect(plain.status).toBe(202);
      expect(await plain.text()).toBe("");

      // A non-JSON answer passes only when nothing was refused; beside a refusal, each allowed request gets an error.
      upstream = { status: 200, type: "text/plain", body: "relay-plain-marker" };
      const passed = await post([{ jsonrpc: "2.0", id: 7, method: "tools/list" }]);
      expect(passed.status).toBe(200);
      expect(await passed.text()).toBe("relay-plain-marker");
      const answered = await post([{ jsonrpc: "2.0", id: 8, method: "tools/list" }, write]);
      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual([
        { jsonrpc: "2.0", id: 8, error: { code: -32000, message: "The tool returned an invalid response." } },
        { jsonrpc: "2.0", id: "refused-write-marker", error: { code: -32601, message: "This step may only read: that action is not available." } },
      ]);
    } finally {
      await new Promise(resolve => web.close(resolve));
    }
  });

  test("a web tool is relayed with its sign-in added by the broker, never by the agent", async () => {
    const seen: string[] = [];
    const web: Server = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        seen.push(String(request.headers["authorization"]));
        if (request.headers["authorization"] !== `Bearer ${SECRET}`) { response.writeHead(401).end(); return; }
        const message = JSON.parse(body) as { id?: number; method: string };
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        const result = message.method === "tools/list" ? { tools: [{ name: "get_issue" }, { name: "close_issue" }] } : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "web", version: "1" } };
        response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "web-session" });
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
      });
    });
    await new Promise<void>(resolve => web.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(web.address() as AddressInfo).port}/mcp`;
      broker = await startToolBroker([{ spec: { name: "issues", transport: "http", command: null, args: [], url, secrets: [{ name: "ISSUES_TOKEN", optional: false }], bearer: "ISSUES_TOKEN", headerSecrets: {}, about: "Issues" }, values: { ISSUES_TOKEN: SECRET }, actions: ["get_issue"] }]);
      expect((await start(broker.url("issues"), broker.token)).body?.result).toMatchObject({ serverInfo: { name: "web" } });
      expect((await rpc(broker.url("issues"), `Bearer ${broker.token}`, "tools/list")).body?.result?.tools?.map(one => one.name)).toEqual(["get_issue"]);
      expect((await rpc(broker.url("issues"), `Bearer ${broker.token}`, "tools/call", { name: "close_issue", arguments: {} })).body?.error).toMatchObject({ code: -32601 });
      expect(seen).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
    } finally {
      await new Promise(resolve => web.close(resolve));
    }
  });

  test("a local tool server gets only what it needs from the launch's environment, Toolroll's own settings and its own values", async () => {
    const OTHER = ["other", "tool", "secret", "5a".repeat(8)].join("-");
    const base = { PATH: "/usr/bin:/bin", HOME: "/h", USER: "u", LANG: "en_US.UTF-8", LC_ALL: "C", TMPDIR: "/t", SHELL: "/bin/zsh", TERM: "xterm",
      OTHER_TOOL_TOKEN: OTHER, GITHUB_TOKEN: OTHER, ANTHROPIC_API_KEY: OTHER, NODE_OPTIONS: "--require /x.js", TOOLROLL_DB: "/live/orders.db" };
    expect(serverEnv(base, ["LANG"], { TOOLROLL_DB: "/run/orders.db" }, { NOTES_TOKEN: SECRET })).toEqual({ PATH: "/usr/bin:/bin", HOME: "/h", USER: "u", LC_ALL: "C", TMPDIR: "/t",
      SHELL: "/bin/zsh", TERM: "xterm", TOOLROLL_DB: "/run/orders.db", NOTES_TOKEN: SECRET });
    expect(serverEnv({ PATH: "/bin", NODE_EXTRA_CA_CERTS: "/ca.pem" }, [], {}, {})).toEqual({ PATH: "/bin", NODE_EXTRA_CA_CERTS: "/ca.pem" });
    // A server behind a proxy or a private certificate authority still reaches its service.
    const network = { HTTP_PROXY: "http://p:1", HTTPS_PROXY: "http://p:2", NO_PROXY: "localhost", ALL_PROXY: "socks5://p:3", http_proxy: "http://p:4", https_proxy: "http://p:5",
      no_proxy: "127.0.0.1", all_proxy: "socks5://p:6", SSL_CERT_FILE: "/certs/ca.pem", SSL_CERT_DIR: "/certs" };
    expect(serverEnv({ ...network, PROXY_PASSWORD: OTHER }, [], {}, {})).toEqual(network);
    // The real server sees the same: it reports the names it was started with.
    const envServer = join(dir, "env.mjs");
    writeFileSync(envServer, NOTES_SERVER.replace('createHash("sha256").update(process.env.NOTES_TOKEN ?? "").digest("hex")', 'Object.keys(process.env).sort().join(",")'));
    broker = await startToolBroker([{ spec: notesSpec(envServer, log), values: { NOTES_TOKEN: SECRET } }], { env: { ...process.env, OTHER_TOOL_TOKEN: OTHER, GITHUB_TOKEN: OTHER }, pass: { TOOLROLL_DB: "/run/orders.db" } });
    expect((await start(broker.url("notes"), broker.token)).status).toBe(200);
    const names = text(await rpc(broker.url("notes"), `Bearer ${broker.token}`, "tools/call", { name: "read_note", arguments: {} }))!.split(",");
    expect(names).toEqual(expect.arrayContaining(["NOTES_TOKEN", "PATH", "TOOLROLL_DB"]));
    expect(names.filter(name => !["PATH", "HOME", "USER", "LANG", "TMPDIR", "SHELL", "TERM", "NODE_EXTRA_CA_CERTS", "NOTES_TOKEN", "TOOLROLL_DB", "__CF_USER_TEXT_ENCODING"].includes(name) && !name.startsWith("LC_"))).toEqual([]);
  });

  test("a web tool's redirect is refused, so its sign-in headers never reach another origin", async () => {
    const stolen: string[] = [];
    const elsewhere: Server = createServer((request, response) => { stolen.push(JSON.stringify(request.headers)); response.writeHead(200, { "content-type": "application/json" }).end("{}"); });
    await new Promise<void>(resolve => elsewhere.listen(0, "127.0.0.1", resolve));
    const away = `http://localhost:${(elsewhere.address() as AddressInfo).port}/steal`;
    const web: Server = createServer((_request, response) => { response.writeHead(307, { location: away }).end(); });
    await new Promise<void>(resolve => web.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(web.address() as AddressInfo).port}/mcp`;
      broker = await startToolBroker([{ spec: { name: "issues", transport: "http", command: null, args: [], url, secrets: [{ name: "ISSUES_KEY", optional: false }], bearer: null, headerSecrets: { "x-api-key": "ISSUES_KEY" }, about: "Issues" }, values: { ISSUES_KEY: SECRET } }]);
      const answer = await start(broker.url("issues"), broker.token);
      expect(answer.body?.error).toMatchObject({ message: "The tool's server could not be reached." });
      expect(stolen).toEqual([]);
    } finally {
      await new Promise(resolve => web.close(resolve));
      await new Promise(resolve => elsewhere.close(resolve));
    }
  });
});

test("a Codex build's tool runs through the launcher, which holds only the broker's address and token", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-broker-codex-")));
  try {
    writeFileSync(join(dir, "notes.mjs"), NOTES_SERVER);
    const launcher = fileURLToPath(new URL("../dist/tool-launcher.js", import.meta.url));
    const tools = await codexToolArgs({ tools: [{ spec: notesSpec(join(dir, "notes.mjs"), join(dir, "notes.log")), digest: "d", values: { NOTES_TOKEN: SECRET } }], skipped: [] }, { launcher });
    try {
      const args = JSON.parse(tools.argv.find(one => one.startsWith("mcp_servers.notes.args="))!.slice("mcp_servers.notes.args=".length)) as string[];
      expect(readFileSync(args[1]!, "utf8")).not.toContain(SECRET);
      const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"] });
      const lines = createInterface({ input: child.stdout! });
      const answers: Record<string, unknown>[] = [];
      lines.on("line", line => answers.push(JSON.parse(line) as Record<string, unknown>));
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } } })}\n`);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_note", arguments: {} } })}\n`);
      await expect.poll(() => answers.length).toBe(2);
      expect(answers[1]).toMatchObject({ id: 2, result: { content: [{ text: digest(SECRET) }] } });
      child.stdin!.end();
      await new Promise(resolve => child.on("exit", resolve));
    } finally {
      tools.cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("through the gateway", () => {
  let dir: string, home: string, repo: string, worktree: string, store: Store;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-broker-gateway-")));
    home = join(dir, "home");
    repo = join(dir, "repo");
    worktree = join(dir, "state", "worktrees", "repo", "task");
    for (const path of [home, repo, worktree]) mkdirSync(path, { recursive: true });
    writeFileSync(join(dir, "notes.mjs"), NOTES_SERVER);
    store = openStore(join(dir, "state", "orders.db"));
    // The checkout is a recorded linked worktree of the project, as the pool hands one over: a fenced launch trusts nothing else.
    boundCheckout(store, repo, worktree);
    register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => "tok" });
    expect(addToolTo(store, repo, notesSpec(join(dir, "notes.mjs"), join(dir, "notes.log")), "custom", "alex", T0, { home })).toMatchObject({ ok: true });
    setToolSecrets(repo, "notes", { NOTES_TOKEN: SECRET }, home);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test.each(["codex", "openrouter"] as const)("%s withholds secret-bearing stdio tools before startup and records why", async provider => {
    store.createTask({ id: "withheld", title: "withheld" }, T0);
    const ref = store.refFor("built-in", "withheld").id;
    store.placeTask(ref, repo);
    const took = acquire(store, ref, "builder-1", { now: T0, token: "tok", newLeaseId: () => "lease-withheld", ttlMs: 10 * 365 * 24 * 3600 * 1000 });
    if (!took.ok) throw new Error("claim");
    const id = store.startRun({ taskRef: ref, leaseId: "lease-withheld", runner: "builder-1", branch: "b", worktree, route: { routeDigest: "legacy", phase: "build", provider, model: null, chosen: "legacy" }, now: T0 });
    const tools = await prepareRunTools(store, id, provider, { home, now: T0, containment: { platform: "darwin", fence: "macos-sandbox" } });
    try {
      expect(tools.argv.join(" ")).not.toContain("mcp_servers.notes");
      expect(tools.serverPids?.() ?? []).toEqual([]);
      expect(existsSync(join(dir, "notes.log"))).toBe(false);
      expect(store.runTools(id)).toEqual({ tools: [], skipped: [{ name: "notes", reason: "This tool needs a Claude build to protect its sign-in details." }] });
    } finally { tools.cleanup(); }
  });

  test("a Codex build's stdio tool server runs inside the platform's fence, which its own profile doesn't cover", async () => {
    // A secret-free tool (Codex keeps those) whose server tries a repository beside the build's own.
    const adjacent = join(dirname(worktree), "adjacent");
    mkdirSync(join(adjacent, ".git"), { recursive: true });
    writeFileSync(join(adjacent, "secret.txt"), "synthetic-adjacent");
    const { OPT_IN_SERVER, firedBy } = await import("../scripts/provider-canary.mjs");
    writeFileSync(join(dir, "probe.mjs"), OPT_IN_SERVER);
    const probeLog = join(dir, "probe.log"), launch = join(dir, "launch");
    writeFileSync(launch, "codex-build");
    const probe: ToolSpec = { name: "probe", transport: "stdio", command: process.execPath, args: [join(dir, "probe.mjs"), probeLog, join(adjacent, "secret.txt"), launch], url: null, secrets: [], bearer: null, headerSecrets: {}, about: "Probe" };
    expect(addToolTo(store, repo, probe, "custom", "alex", T0, { home })).toMatchObject({ ok: true });
    store.createTask({ id: "t-codex", title: "t-codex" }, T0);
    const ref = store.refFor("built-in", "t-codex").id;
    store.placeTask(ref, repo);
    const took = acquire(store, ref, "builder-1", { now: T0, token: "tok", newLeaseId: () => "lease-codex", ttlMs: 10 * 365 * 24 * 3600 * 1000 });
    if (!took.ok) throw new Error("claim");
    const id = store.startRun({ taskRef: ref, leaseId: "lease-codex", runner: "builder-1", branch: "b", worktree, route: { routeDigest: "legacy", phase: "build", provider: "codex", model: null, chosen: "legacy" }, now: T0 });
    let listed: string[] | undefined;
    const runner = async (_file: string, args: readonly string[]) => {
      // What Codex's launcher does: read the relay file, then reach the broker, which starts the server.
      const relayArgs = args.find(one => one.startsWith("mcp_servers.probe.args="))!;
      const relay = JSON.parse(readFileSync((JSON.parse(relayArgs.slice("mcp_servers.probe.args=".length)) as string[])[1]!, "utf8")) as { spec: { url: string }; values: Record<string, string> };
      const token = Object.values(relay.values)[0]!;
      await start(relay.spec.url, token);
      listed = (await rpc(relay.spec.url, `Bearer ${token}`, "tools/list")).body?.result?.tools?.map(one => one.name);
      return { code: 0, stderr: "", timedOut: false, notFound: false, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fine" } }) };
    };
    const result = await invokeAgent(store, id, { provider: "codex", model: null }, { phase: "build", brief: "go", maxTurns: 5, permissionMode: "auto", skipPermissions: false, resumeSession: null }, { keyHome: home, clock: () => T0, cwd: worktree, runner: runner as never });
    expect(result.kind).toBe("ran");
    expect(listed).toEqual([]);
    expect(store.runFence(id)).toMatchObject({ method: macosFenceAvailable() ? "codex-profile" : expect.any(String) });
    // On macOS the server ran inside the sandbox: it started, and the adjacent repository stayed out of reach.
    if (macosFenceAvailable()) expect(await firedBy(probeLog)).toEqual({ "codex-build": ["named-tool"] });
    else expect((await firedBy(probeLog))["codex-build"]).toContain("named-tool");
  });

  test.each([
    { label: "a Claude build without the macOS sandbox", platform: "darwin", bubblewrap: false, method: "claude-rules", reason: "This build has no macOS sandbox, so it could read this tool's sign-in details. Toolroll didn't start it." },
    { label: "a Linux Claude build inside bubblewrap", platform: "linux", bubblewrap: true, method: "linux-bubblewrap", reason: "Toolroll doesn't start tools with sign-in details on Linux: a build there could read them from the running tool." },
    { label: "a Linux Claude build with no fence helper", platform: "linux", bubblewrap: false, method: "claude-rules", reason: "Toolroll doesn't start tools with sign-in details on Linux: a build there could read them from the running tool." },
  ] as const)("$label never starts a secret-bearing stdio tool, and the run says why", async ({ label, platform, bubblewrap, method, reason }) => {
    // A distinct value per case: wherever the build could look, this exact marker must not be there.
    const marker = ["no-fence", platform, method, "4e".repeat(12)].join("-");
    setToolSecrets(repo, "notes", { NOTES_TOKEN: marker }, home);
    const real = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    vi.mocked(fencing.macosFenceAvailable).mockReturnValue(false);
    vi.mocked(fencing.linuxFenceAvailable).mockReturnValue(bubblewrap);
    try {
      store.createTask({ id: "unfenced", title: label }, T0);
      const ref = store.refFor("built-in", "unfenced").id;
      store.placeTask(ref, repo);
      const took = acquire(store, ref, "builder-1", { now: T0, token: "tok", newLeaseId: () => "lease-unfenced", ttlMs: 10 * 365 * 24 * 3600 * 1000 });
      if (!took.ok) throw new Error("claim");
      const id = store.startRun({ taskRef: ref, leaseId: "lease-unfenced", runner: "builder-1", branch: "b", worktree, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: T0 });
      const seen: { servers: string[]; config: string; env: string; args: string }[] = [];
      const runner = async (_file: string, args: readonly string[], options?: { env?: Record<string, string | undefined> }) => {
        const config = readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf8");
        seen.push({ servers: Object.keys((JSON.parse(config) as { mcpServers: Record<string, unknown> }).mcpServers), config, env: JSON.stringify(options?.env ?? {}), args: args.join(" ") });
        return { code: 0, stderr: "", timedOut: false, notFound: false, stdout: "" };
      };
      await invokeAgent(store, id, { provider: "claude", model: null }, { phase: "build", brief: "go", maxTurns: 5, permissionMode: "auto", skipPermissions: true, resumeSession: null }, { keyHome: home, clock: () => T0, cwd: worktree, runner: runner as never });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.servers).toEqual([]);
      for (const where of [seen[0]!.config, seen[0]!.env, seen[0]!.args]) expect(where).not.toContain(marker);
      // The server never started, so no process held the marker for the build to read.
      expect(existsSync(join(dir, "notes.log"))).toBe(false);
      expect(store.runTools(id)).toEqual({ tools: [], skipped: [{ name: "notes", reason }] });
      expect(store.runFence(id)).toMatchObject({ method });
    } finally {
      Object.defineProperty(process, "platform", { value: real, configurable: true });
      vi.mocked(fencing.macosFenceAvailable).mockRestore();
      vi.mocked(fencing.linuxFenceAvailable).mockRestore();
    }
  });

  test.skipIf(!macosFenceAvailable())("a fresh build and its resumed repair each reach the opted-in tool with their own token, revoked when the run ends; no config holds the secret", async () => {
    store.createTask({ id: "t-tools", title: "t-tools" }, T0);
    const ref = store.refFor("built-in", "t-tools").id;
    store.placeTask(ref, repo);
    const took = acquire(store, ref, "builder-1", { now: T0, token: "tok", newLeaseId: () => "lease-tools", ttlMs: 10 * 365 * 24 * 3600 * 1000 });
    if (!took.ok) throw new Error("claim");
    const seen: { token: string; url: string; answer: string | undefined; config: string; env: string }[] = [];
    const runner = async (_file: string, args: readonly string[], options?: { env?: Record<string, string | undefined>; onSessionId?: (id: string) => void }) => {
      // What Claude would do with its config: connect to the named server and use it.
      const config = readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf8");
      const notes = (JSON.parse(config) as { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> }).mcpServers["notes"]!;
      const token = notes.headers.Authorization.slice("Bearer ".length);
      await start(notes.url, token);
      seen.push({ token, url: notes.url, answer: text(await rpc(notes.url, notes.headers.Authorization, "tools/call", { name: "read_note", arguments: {} })), config, env: JSON.stringify(options?.env ?? {}) });
      options?.onSessionId?.("session-1");
      return { code: 0, stderr: "", timedOut: false, notFound: false, stdout: `${JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" })}\n${JSON.stringify({ type: "result", subtype: "success", session_id: "session-1", result: "done" })}\n` };
    };
    for (const resumeSession of [null, "session-1"]) {
      const id = store.startRun({ taskRef: ref, leaseId: "lease-tools", runner: "builder-1", branch: "b", worktree, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: T0 });
      if (resumeSession !== null) store.stampRun(id, { sessionId: resumeSession });
      const result = await invokeAgent(store, id, { provider: "claude", model: null }, { phase: resumeSession === null ? "build" : "repair", brief: "go", maxTurns: 5, permissionMode: "auto", skipPermissions: true, resumeSession }, { keyHome: home, clock: () => T0, cwd: worktree, runner: runner as never });
      expect(result.kind).toBe("ran");
      store.finishRun(id, { outcome: "built", now: T0 });
      // The run is over: its token opens nothing.
      await expect(rpc(seen.at(-1)!.url, `Bearer ${seen.at(-1)!.token}`, "tools/list")).rejects.toThrow();
    }
    expect(seen).toHaveLength(2);
    expect(seen.map(one => one.answer)).toEqual([digest(SECRET), digest(SECRET)]);
    expect(seen[0]!.token).not.toBe(seen[1]!.token);
    for (const one of seen) {
      expect(one.config).not.toContain(SECRET);
      expect(one.env).not.toContain(SECRET);
    }
    expect(readFileSync(join(dir, "notes.log"), "utf8").match(/^start /gm)).toHaveLength(2);
  });
});
