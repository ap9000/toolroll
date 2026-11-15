/**
 * Flexible threads, slice F2b (flexible-relay.ts): the sign-in relay's guards, each against a scripted stand-in for the
 * model service (a local HTTP server, put in place of the fixed upstream only by replacing flexible-relay-upstreams.ts
 * with vi.mock: the shipped list has no knob). No model is called and no real credential exists: the relay's credential
 * here is made up at run time and kept in the test's own owner-only files (test/setup-state.ts: files, its own HOME).
 *
 * Rows: a call is forwarded to exactly the fixed origin and route with Toolroll's credential and none of the agent's,
 * and its usage (whole or streamed) is counted by the relay and charged to the running turn; a cut-off stream is charged
 * as unknown; and every refusal: a wrong route, a redirect from upstream, a credential header from the agent, a
 * disallowed model, an oversized body or max_tokens, a server tool, too many calls at once, a call after the turn ends
 * (and one cut when it ends), a revoked token (by its endpoint, by the thread's stop, by custody left unresolved),
 * another thread's token, another billing, and an upstream error that echoes the key (redacted everywhere).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { rmSync } from "node:fs";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, finishFlexibleTurn, flexibleTurn } from "./flexible-turns.js";
import { prepareFlexibleThread, stopFlexibleThreadAgent, type FlexibleThreadPaths } from "./flexible-thread.js";
import { holdLaunch } from "./flexible-launch.js";
import { realCustodyIO, startIdentityOf } from "./flexible-custody.js";
import { FLEXIBLE_RELAY_CREDENTIAL, relayUrlInside, startFlexibleRelay, type FlexibleRelayServer } from "./flexible-relay.js";
import { writeHeldSecret } from "./tool-secret-store.js";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";
import { fakePid } from "../test/fake-pid.js";

vi.mock("./flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));
// The scripted upstream: the shipped list, with only its origin pointed at the stand-in.
const scripted = vi.hoisted(() => ({ origin: "http://127.0.0.1:9" }));
vi.mock("./flexible-relay-upstreams.js", async importOriginal => {
  const real = await importOriginal<typeof import("./flexible-relay-upstreams.js")>();
  return { FLEXIBLE_RELAY_UPSTREAMS: { claude: { ...real.FLEXIBLE_RELAY_UPSTREAMS.claude, get origin() { return scripted.origin; } } } };
});

const NOW = new Date();
const STORAGE = { names: [], denies: [] };
const io = realCustodyIO(() => null);
/** Made up at run time: shaped like a setup-token and an API key, never a real one. */
const SETUP_TOKEN = ["sk", "ant", "oat01", randomBytes(24).toString("hex")].join("-");
const API_KEY = ["sk", "ant", "api03", randomBytes(24).toString("hex")].join("-");

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
let world: ThreadWorld, digest: string, upstream: Server, seen: Seen[], script: (request: IncomingMessage, response: ServerResponse, body: string) => void;
let relay: FlexibleRelayServer, id: string, paths: FlexibleThreadPaths, turn: string, token: string, launch: string, lines: string[];
const children: ChildProcess[] = [];
const servers: Server[] = [];

const MESSAGE = (usage: Record<string, number>) => JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage });
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}
function credential(kind: "setup-token" | "api-key", value: string): void {
  writeHeldSecret(world.state, FLEXIBLE_RELAY_CREDENTIAL.name, FLEXIBLE_RELAY_CREDENTIAL.file, JSON.stringify({ kind, value }));
}
function admitAndBegin(over: Partial<Parameters<typeof admitFlexibleTurn>[1]> = {}): string {
  const made = admitFlexibleTurn(world.store, { thread: id, starter: { name: "alex", generation: world.store.accountOf("alex")!.generation }, digest, level: "full", freshProof: false,
    provider: "claude", model: "claude-sonnet-4-5", billing: "subscription", requestKey: `m-${randomBytes(4).toString("hex")}`, holder: "h1", clock: () => NOW, ...over });
  if (!made.ok) throw new Error(`${made.reason}: ${made.message}`);
  const begun = beginFlexibleTurn(world.store, { turn: made.turn, holder: over.holder ?? "h1", clock: () => NOW });
  if (!begun.ok) throw new Error(begun.message);
  return made.turn;
}
/** A live launch of the thread on the record (as flexibleThreadSpawn registers one), held by `holder`. */
function liveLaunch(thread: string, pid = fakePid(1), start = "t1", holder = "h1"): string {
  const one = randomBytes(16).toString("hex");
  world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, ?, 'live', ?)`).run(one, thread, "f".repeat(32), holder, "9".repeat(32), pid, start, NOW.toISOString());
  return one;
}

beforeEach(async () => {
  world = threadWorld();
  world.store.saveApprover("alex", "hash-a", NOW);
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: world.store.accountOf("alex")!.generation, starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  digest = flexibleDigestOf(terms);
  world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  id = made.thread.id; paths = made.paths;
  seen = [];
  script = (_request, response) => { response.writeHead(200, { "content-type": "application/json", "request-id": "req_1" }).end(MESSAGE({ input_tokens: 12, output_tokens: 5 })); };
  upstream = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", chunk => parts.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8");
      seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      script(request, response, body);
    });
  });
  scripted.origin = `http://127.0.0.1:${await listen(upstream)}`;
  lines = [];
  const started = await startFlexibleRelay(world.store, { thread: id, log: line => lines.push(line) });
  if ("ok" in started) throw new Error(started.message);
  relay = started;
  credential("setup-token", SETUP_TOKEN);
  turn = admitAndBegin();
  launch = liveLaunch(id);
  token = relay.issue({ thread: id, turn, launch }).token;
});
afterEach(async () => {
  await relay.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  for (const child of children.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

const BODY = { model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
function call(over: { path?: string; method?: string; headers?: Record<string, string>; body?: unknown; bearer?: string | null } = {}): Promise<Response> {
  const bearer = over.bearer === undefined ? token : over.bearer;
  return fetch(`${relay.url}${over.path ?? "/v1/messages?beta=true"}`, { method: over.method ?? "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...over.headers },
    ...(over.method === "GET" ? {} : { body: typeof over.body === "string" ? over.body : JSON.stringify(over.body ?? BODY) }) });
}
const calls = () => world.store.handle.prepare("SELECT turn, route, model, streamed, status, reason, http_status, tokens_in, tokens_out, cache_read, cache_write, cost_microusd, cost_basis, detail FROM thread_relay_call ORDER BY id").all().map(row => ({ ...row }));
const until = async (test: () => boolean) => { for (let i = 0; i < 100 && !test(); i++) await new Promise(done => setTimeout(done, 50)); expect(test()).toBe(true); };

describe("forwarding and charging", () => {
  test("a call goes to exactly the fixed origin and route with Toolroll's credential and none of the agent's, and its usage is charged to the running turn", async () => {
    const answer = await call({ headers: { "anthropic-beta": "claude-code-20250219", "x-stainless-os": "MacOS", "user-agent": "claude-cli/2 (external, cli)", "x-app": "cli" } });
    expect(answer.status).toBe(200);
    expect(JSON.parse(await answer.text())).toMatchObject({ type: "message", usage: { input_tokens: 12, output_tokens: 5 } });
    expect(answer.headers.get("request-id")).toBe("req_1");
    expect(seen).toHaveLength(1);
    const [one] = seen;
    expect(one!.method).toBe("POST");
    expect(one!.url).toBe("/v1/messages?beta=true");
    expect(one!.headers.authorization).toBe(`Bearer ${SETUP_TOKEN}`);
    expect(one!.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
    expect(one!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(one!.headers["accept-encoding"]).toBe("identity");
    expect(one!.headers["x-api-key"]).toBeUndefined();
    expect(one!.headers["x-stainless-os"]).toBeUndefined();
    expect(JSON.stringify(one!.headers)).not.toContain(token);
    expect(JSON.parse(one!.body)).toEqual(BODY);
    expect(calls()).toEqual([{ turn, route: "messages", model: "claude-sonnet-4-5", streamed: 0, status: "completed", reason: null, http_status: 200, tokens_in: 12, tokens_out: 5,
      cache_read: 0, cache_write: 0, cost_microusd: 0, cost_basis: "estimated", detail: null }]);
    expect(flexibleTurn(world.store, turn)).toMatchObject({ tokensIn: 12, tokensOut: 5, relayCalls: 1, costBasis: "estimated" });
    // A token count is forwarded too, and costs nothing.
    script = (_request, response) => { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 40 })); };
    expect((await call({ path: "/v1/messages/count_tokens", body: { model: "claude-sonnet-4-5", messages: [] } })).status).toBe(200);
    // (A plan turn's $0 is F2e's "estimated", whatever was reported.)
    expect(calls()[1]).toMatchObject({ route: "count-tokens", status: "completed", cost_microusd: 0, cost_basis: "estimated" });
    // The relay listens on loopback; the agent inside the fence reaches it at its second-relay address.
    expect(relay.url).toBe(`http://127.0.0.1:${relay.port}`);
    expect(relayUrlInside(relay.port, "darwin")).toBe(relay.url);
    expect(relayUrlInside(relay.port, "linux")).toBe("http://127.0.0.1:1080");
  });

  test("streamed usage (message_start, message_delta) is read by the relay and charged; a stream cut off before message_stop is charged as unknown", async () => {
    const events = [
      ["message_start", { type: "message_start", message: { id: "msg_2", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5", usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi there" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 55 } }],
      ["message_stop", { type: "message_stop" }],
    ] as const;
    const sse = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    // Sent in small pieces, so an event is split across chunks.
    script = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      let at = 0;
      const next = () => { if (at >= sse.length) { response.end(); return; } response.write(sse.slice(at, at + 37)); at += 37; setImmediate(next); };
      next();
    };
    const answer = await call({ body: { ...BODY, stream: true } });
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe(sse);
    expect(calls()).toEqual([expect.objectContaining({ status: "completed", streamed: 1, tokens_in: 100, tokens_out: 55, cache_read: 20, cache_write: 10, cost_basis: "estimated" })]);
    // Input-equivalent: a cache read counted as input, a cache write twice.
    expect(flexibleTurn(world.store, turn)).toMatchObject({ tokensIn: 100 + 20 + 2 * 10, tokensOut: 55, relayCalls: 1, costBasis: "estimated" });

    script = (_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(sse.slice(0, sse.indexOf("event: message_delta"))); setTimeout(() => response.destroy(), 20); };
    const cut = await call({ body: { ...BODY, stream: true } });
    await cut.text().catch(() => "");
    await until(() => calls().length === 2);
    expect(calls()[1]).toMatchObject({ status: "incomplete", tokens_in: 100, tokens_out: 1, cost_basis: "unknown" });
    expect(flexibleTurn(world.store, turn)!.costBasis).toBe("unknown");
  });
});

describe("refusals: nothing is forwarded", () => {
  test("a wrong route, method or query is refused; a tunnel gets nothing; without a token nothing is even recorded", async () => {
    for (const [path, method] of [["/v1/complete", "POST"], ["/v1/models", "POST"], ["/v1/messages", "GET"], ["/v1/messages?beta=false", "POST"], ["/v1/messages/../complete", "POST"],
      ["/v1/messages/batches", "POST"], ["//v1/messages", "POST"], ["/v1/messages%2Fcount_tokens", "POST"]] as const) {
      expect((await call({ path, method })).status, `${method} ${path}`).toBe(404);
    }
    // Absolute-form (a proxy request) is no route either.
    const absolute = await new Promise<number>(done => {
      const raw = httpRequest({ host: "127.0.0.1", port: relay.port, method: "POST", path: "http://api.anthropic.com/v1/messages", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, answer => { answer.resume(); done(answer.statusCode ?? 0); });
      raw.end(JSON.stringify(BODY));
    });
    expect(absolute).toBe(404);
    const tunnel = await new Promise<string>(done => {
      const socket = connect(relay.port, "127.0.0.1", () => socket.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n"));
      let said = "";
      socket.on("data", chunk => { said += chunk; });
      socket.on("close", () => done(said));
    });
    expect(tunnel).toMatch(/^HTTP\/1\.1 403/);
    expect(calls().every(row => row["status"] === "refused" && row["reason"] === "route")).toBe(true);
    expect(calls()).toHaveLength(9);
    for (const bearer of [null, "", `tr-relay-${"0".repeat(48)}`, SETUP_TOKEN]) expect((await call({ bearer })).status).toBe(401);
    expect(calls()).toHaveLength(9);
    expect(seen).toHaveLength(0);
  });

  test("a redirect from upstream is refused, never followed, and its location never reaches the agent", async () => {
    const elsewhere: string[] = [];
    const other = await listen(createServer((request, response) => { elsewhere.push(request.url ?? ""); response.end("{}"); }));
    script = (_request, response) => { response.writeHead(307, { location: `http://127.0.0.1:${other}/v1/messages`, "set-cookie": "s=1" }).end(); };
    const answer = await call();
    expect(answer.status).toBe(502);
    expect(answer.headers.get("location")).toBeNull();
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(seen).toHaveLength(1);
    expect(elsewhere).toEqual([]);
    expect(calls()).toEqual([expect.objectContaining({ status: "redirect-refused", http_status: 307, cost_microusd: 0, cost_basis: "estimated" })]);
  });

  test("a credential header, an override or a credential-selecting beta from the agent is refused", async () => {
    // Its own key beside the token: refused before anything else.
    expect((await call({ headers: { "x-api-key": API_KEY } })).status).toBe(400);
    // Its own key alone isn't a relay token.
    expect((await call({ bearer: null, headers: { "x-api-key": API_KEY } })).status).toBe(401);
    for (const headers of [{ "anthropic-dangerous-direct-browser-access": "true" }, { cookie: "session=1" }, { "proxy-authorization": "Basic eDp5" }, { "x-goog-api-key": "k" },
      { "anthropic-organization": "org" }, { "x-auth-token": "t" }]) {
      expect((await call({ headers })).status, JSON.stringify(headers)).toBe(400);
    }
    for (const beta of ["oauth-2025-04-20", "mcp-client-2025-04-04", "claude-code-20250219,files-api-2025-04-14"]) {
      expect((await call({ headers: { "anthropic-beta": beta } })).status, beta).toBe(400);
    }
    expect((await call({ headers: { "anthropic-version": "latest" } })).status).toBe(400);
    expect(seen).toHaveLength(0);
    expect(calls().map(row => row["reason"])).toEqual([...Array(6).fill("credential-header"), "beta", "beta", "beta", "header"]);
    // The token in x-api-key alone is accepted (the agent's choice of header), never forwarded.
    expect((await call({ bearer: null, headers: { "x-api-key": token } })).status).toBe(200);
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${SETUP_TOKEN}`);
  });

  test("a model the turn may not use, max_tokens over the cap, an oversized body and a server tool are refused", async () => {
    for (const model of ["claude-opus-4-1", "gpt-5", "claude-sonnet-4-5 --x", "../claude"]) expect((await call({ body: { ...BODY, model } })).status, model).toBe(400);
    expect((await call({ body: { ...BODY, max_tokens: 200_000 } })).status).toBe(400);
    expect((await call({ body: { ...BODY, max_tokens: undefined } })).status).toBe(400);
    expect((await call({ body: { ...BODY, tools: [{ type: "web_search_20250305", name: "web_search" }] } })).status).toBe(400);
    expect((await call({ body: { ...BODY, mcp_servers: [{ type: "url", url: "https://evil.example/mcp", name: "x" }] } })).status).toBe(400);
    expect((await call({ body: "not json" })).status).toBe(400);
    // Declared over the cap: refused before a byte is read.
    const declared = await new Promise<number>(done => {
      const raw = httpRequest({ host: "127.0.0.1", port: relay.port, method: "POST", path: "/v1/messages", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(32 * 1024 * 1024 + 1) } },
        answer => { answer.resume(); done(answer.statusCode ?? 0); });
      raw.on("error", () => done(-1));
      raw.write("{");
    });
    expect(declared).toBe(413);
    // Streamed past the cap without a length: refused once it is.
    const streamed = await new Promise<number>(done => {
      const raw = httpRequest({ host: "127.0.0.1", port: relay.port, method: "POST", path: "/v1/messages", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } },
        answer => { answer.resume(); done(answer.statusCode ?? 0); });
      raw.on("error", () => done(-1));
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const more = () => { while (sent < 34) { sent++; if (!raw.write(chunk)) { raw.once("drain", more); return; } } raw.end(); };
      more();
    });
    expect([413, -1]).toContain(streamed);
    // The helper model is allowed.
    expect((await call({ body: { ...BODY, model: "claude-haiku-4-5" } })).status).toBe(200);
    expect(seen.map(one => JSON.parse(one.body).model)).toEqual(["claude-haiku-4-5"]);
    await until(() => calls().length === 12);
    expect(calls().slice(0, 11).map(row => row["reason"])).toEqual(["model", "model", "model", "model", "max-tokens", "max-tokens", "server-tool", "server-tool", "body", "body-too-large", "body-too-large"]);
  });

  test("too many calls at once: the seventh is refused while six run, and they all finish", async () => {
    const held: ServerResponse[] = [];
    script = (_request, response) => { held.push(response); };
    const running = Array.from({ length: 6 }, () => call());
    await until(() => seen.length === 6);
    // Its own connection: the client's pool may otherwise queue it behind the six held ones.
    const seventh = await new Promise<{ status: number; retry: string | undefined }>(done => {
      const raw = httpRequest({ host: "127.0.0.1", port: relay.port, method: "POST", path: "/v1/messages", agent: false, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } },
        answer => { answer.resume(); done({ status: answer.statusCode ?? 0, retry: answer.headers["retry-after"] as string | undefined }); });
      raw.end(JSON.stringify(BODY));
    });
    expect(seventh).toEqual({ status: 429, retry: "1" });
    expect(seen).toHaveLength(6);
    for (const response of held) response.writeHead(200, { "content-type": "application/json" }).end(MESSAGE({ input_tokens: 1, output_tokens: 1 }));
    expect((await Promise.all(running)).map(one => one.status)).toEqual(Array(6).fill(200));
    script = (_request, response) => { response.writeHead(200, { "content-type": "application/json" }).end(MESSAGE({ input_tokens: 1, output_tokens: 1 })); };
    expect((await call()).status).toBe(200);
  });

  test("a call after the turn ends is refused, and a call running when it ends is cut and charged as unknown", async () => {
    const held: ServerResponse[] = [];
    script = (_request, response) => { held.push(response); response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 1 } } })}\n\n`); };
    const running = call({ body: { ...BODY, stream: true } });
    await until(() => seen.length === 1);
    expect(finishFlexibleTurn(world.store, { turn, holder: "h1", outcome: "finished", usage: null, clock: () => NOW })).toMatchObject({ ok: true });
    const cut = await running;
    await cut.text().catch(() => "");
    await until(() => calls().length === 1);
    expect(calls()[0]).toMatchObject({ turn, status: "aborted", detail: "the turn ended", cost_basis: "unknown" });
    expect((await call()).status).toBe(409);
    expect(calls()[1]).toMatchObject({ turn: null, status: "refused", reason: "no-turn" });
    expect(seen).toHaveLength(1);
    // The next turn on the same launch: the same token spends for it, and only it.
    const next = admitAndBegin();
    script = (_request, response) => { response.writeHead(200, { "content-type": "application/json" }).end(MESSAGE({ input_tokens: 2, output_tokens: 2 })); };
    const again = await call();
    expect(again.status).toBe(200);
    await again.text(); // its record is written before its answer ends
    expect(calls()[2]).toMatchObject({ turn: next, status: "completed" });
  });

  test("a revoked token is refused: by its endpoint, when the thread is stopped (from the database, by any process), and while custody is unresolved", async () => {
    const endpoint = relay.issue({ thread: id, turn, launch });
    expect((await call({ bearer: endpoint.token })).status).toBe(200);
    endpoint.revoke();
    expect((await call({ bearer: endpoint.token })).status).toBe(401);
    expect((await call()).status).toBe(200); // another grant of the launch is untouched
    // Custody unresolved: the launch is no longer live.
    world.store.handle.prepare("UPDATE flexible_thread_launch SET state = 'unresolved' WHERE id = ?").run(launch);
    expect((await call()).status).toBe(401);
    expect(seen).toHaveLength(2);
  });

  test("the thread's stop revokes its launch's token at once, and cuts a call in flight", async () => {
    world.store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ? WHERE id = ?").run(NOW.toISOString(), launch);
    const child = spawn("/bin/sh", ["-c", "sleep 30"], { cwd: paths.repo, detached: true, stdio: "ignore" });
    children.push(child);
    const real = liveLaunch(id, child.pid!, startIdentityOf(child.pid!, io)!);
    holdLaunch(real, child);
    world.store.handle.prepare("UPDATE flexible_thread SET live_pid = ?, live_since = ? WHERE id = ?").run(child.pid!, NOW.toISOString(), id);
    const own = relay.issue({ thread: id, turn, launch: real }).token;
    script = () => { /* never answers */ };
    const running = call({ bearer: own });
    await until(() => seen.length === 1);
    expect(await stopFlexibleThreadAgent(world.store, { id, reason: "test", clock: () => NOW, io })).toMatchObject({ ok: true });
    const cut = await running.then(one => one.status, () => -1);
    expect([409, -1]).toContain(cut);
    await until(() => calls().length === 1);
    expect(calls()[0]).toMatchObject({ status: "aborted", detail: "this thread's agent was stopped" });
    expect((await call({ bearer: own })).status).toBe(401);
  });

  test("another thread's token, another billing, or no credential: refused; a grant for another thread is never issued here", async () => {
    const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
    if (!made.ok) throw new Error(made.message);
    const otherLaunch = liveLaunch(made.thread.id, fakePid(2), "t2");
    expect(() => relay.issue({ thread: made.thread.id, turn, launch: otherLaunch })).toThrow(/another thread/);
    const other = await startFlexibleRelay(world.store, { thread: made.thread.id });
    if ("ok" in other) throw new Error(other.message);
    try {
      const foreign = other.issue({ thread: made.thread.id, turn, launch: otherLaunch }).token;
      expect((await call({ bearer: foreign })).status).toBe(401);
    } finally { await other.close(); }
    credential("api-key", API_KEY);
    expect((await call()).status).toBe(403); // a plan turn never spends on a key
    writeHeldSecret(world.state, FLEXIBLE_RELAY_CREDENTIAL.name, FLEXIBLE_RELAY_CREDENTIAL.file, JSON.stringify({ kind: "setup-token", value: API_KEY })); // the wrong shape for its kind
    expect((await call()).status).toBe(503);
    writeHeldSecret(world.state, FLEXIBLE_RELAY_CREDENTIAL.name, FLEXIBLE_RELAY_CREDENTIAL.file, null);
    expect((await call()).status).toBe(503);
    expect(seen).toHaveLength(0);
    expect(calls().map(row => row["reason"])).toEqual(["billing-mismatch", "no-credential", "no-credential"]);
  });
});

/** Read the relay's answer to one streamed call chunk by chunk (its own connection). */
function streamCall(bearer = token): { chunks: string[]; first: Promise<void>; closed: Promise<void> } {
  const chunks: string[] = [];
  let gotFirst!: () => void, gotClosed!: () => void;
  const first = new Promise<void>(done => { gotFirst = done; }), closed = new Promise<void>(done => { gotClosed = done; });
  const raw = httpRequest({ host: "127.0.0.1", port: relay.port, method: "POST", path: "/v1/messages", agent: false, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" } }, answer => {
    answer.on("data", chunk => { chunks.push(String(chunk)); gotFirst(); });
    answer.on("close", () => gotClosed());
    answer.on("error", () => gotClosed());
  });
  raw.on("error", () => { gotFirst(); gotClosed(); });
  raw.end(JSON.stringify({ ...BODY, stream: true }));
  return { chunks, first, closed };
}
const START = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`;
const AFTER = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "AFTER-CUT" } })}\n\n`;

describe("in-flight authority, settlement and usage", () => {
  test("a revocation or a turn's end between the relay's own looks cuts the answer before its next chunk", async () => {
    for (const end of ["revoke", "finish"] as const) {
      const live = end === "revoke" ? relay.issue({ thread: id, turn, launch }) : null;
      let held: ServerResponse | null = null;
      script = (_request, response) => { held = response; response.writeHead(200, { "content-type": "text/event-stream" }); response.write(START); };
      const stream = streamCall(live?.token ?? token);
      await stream.first;
      // The authority ends, and the service sends more at once: well inside one look of the relay's poll.
      if (end === "revoke") live!.revoke();
      else expect(finishFlexibleTurn(world.store, { turn, holder: "h1", outcome: "finished", usage: null, clock: () => NOW })).toMatchObject({ ok: true });
      (held as ServerResponse | null)?.write(AFTER);
      await stream.closed;
      expect(stream.chunks.join(""), end).not.toContain("AFTER-CUT");
      await until(() => calls().length === (end === "revoke" ? 1 : 2));
      expect(calls().at(-1), end).toMatchObject({ status: "aborted", detail: end === "revoke" ? "its relay token was revoked" : "the turn ended" });
      seen = [];
    }
  });

  test("another process's revocation, seen only on the record, stops the answer from completing even when it ends before the relay's next look", async () => {
    let held: ServerResponse | null = null;
    script = (_request, response) => { held = response; response.writeHead(200, { "content-type": "text/event-stream" }); response.write(START); };
    const stream = streamCall();
    await stream.first;
    // Revoked in the database only (as another Toolroll process does): no in-process cancellation reaches this relay.
    world.store.handle.prepare("UPDATE flexible_relay_grant SET revoked_at = ? WHERE launch = ?").run(NOW.toISOString(), launch);
    (held as ServerResponse | null)?.end(`${AFTER}event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`);
    await stream.closed;
    expect(stream.chunks.join("")).not.toContain("message_stop");
    await until(() => calls().length === 1);
    expect(calls()[0]).toMatchObject({ status: "aborted" });
  });

  test("a failure to read the call's authority while it streams cuts it", async () => {
    let held: ServerResponse | null = null;
    script = (_request, response) => { held = response; response.writeHead(200, { "content-type": "text/event-stream" }); response.write(START); };
    const stream = streamCall();
    await stream.first;
    const db = world.store.handle;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => { if (sql.includes("flexible_relay_grant g JOIN")) throw new Error("database is locked"); return prepare(sql); }) as typeof db.prepare;
    try {
      await stream.closed;
    } finally { db.prepare = prepare as typeof db.prepare; }
    (held as ServerResponse | null)?.write(AFTER);
    expect(stream.chunks.join("")).not.toContain("AFTER-CUT");
    await until(() => calls().length === 1);
    expect(calls()[0]).toMatchObject({ status: "aborted", detail: "Toolroll couldn't check its authority", cost_basis: "unknown" });
  });

  test("a settlement that can't be written keeps its reservation: the thread takes no new call, the ended keyed turn holds the dollar limits, and the retry records it", async () => {
    // A keyed turn on an API key.
    expect(finishFlexibleTurn(world.store, { turn, holder: "h1", outcome: "finished", usage: null, clock: () => NOW })).toMatchObject({ ok: true });
    credential("api-key", API_KEY);
    const keyed = admitAndBegin({ billing: "api-key" });
    const db = world.store.handle;
    const prepare = db.prepare.bind(db);
    let failing = true;
    db.prepare = ((sql: string) => { if (failing && sql.includes("INSERT INTO thread_relay_call")) throw new Error("disk I/O error"); return prepare(sql); }) as typeof db.prepare;
    try {
      const first = await call();
      expect(first.status).toBe(200);
      await first.text();
      const pending = () => Number(prepare("SELECT COUNT(*) AS n FROM thread_relay_pending").get()!["n"]);
      expect(pending()).toBe(1);
      // The next call in that turn is refused while the reservation stands; nothing reaches the service.
      const held = await call();
      expect(held.status).toBe(503);
      expect(((await held.json()) as { error: { message: string } }).error.message).toBe("An earlier model call in this turn couldn't be charged yet, so nothing more is sent until it is.");
      expect(pending()).toBe(1);
      expect(seen).toHaveLength(1);
      // The turn ends with a measured cost of its own; its unrecorded call still leaves its cost unknown: an installation
      // dollar limit can't be checked, so a new keyed turn waits.
      expect(finishFlexibleTurn(world.store, { turn: keyed, holder: "h1", outcome: "finished", usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.01 }, clock: () => NOW })).toMatchObject({ ok: true, turn: { costBasis: "measured" } });
      prepare("INSERT INTO flexible_installation_caps (id, live_threads, turns_per_day, measured_microusd_per_day, updated_by, updated_at) VALUES (1, NULL, NULL, 1000000000, 'alex', ?)").run(NOW.toISOString());
      const next = admitFlexibleTurn(world.store, { thread: id, starter: { name: "alex", generation: world.store.accountOf("alex")!.generation }, digest, level: "full", freshProof: false,
        provider: "claude", model: "claude-sonnet-4-5", billing: "api-key", requestKey: "m-held", holder: "h1", clock: () => NOW });
      expect(next).toMatchObject({ ok: false, reason: "spend-unknown", cap: "installation-dollars" });
      // Writable again: the relay's retry records the call and clears its reservation.
      failing = false;
      await until(() => pending() === 0);
      expect(calls().find(row => row["status"] === "completed")).toMatchObject({ turn: keyed, tokens_in: 12, tokens_out: 5 });
    } finally { db.prepare = prepare as typeof db.prepare; }
  });

  test("usage that isn't there whole (empty, absent, no message_delta, counters that aren't whole numbers) is charged as unknown, never zero", async () => {
    const scripts: ((response: ServerResponse) => void)[] = [
      response => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "message", content: [], usage: {} })),
      response => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "message", content: [] })),
      response => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "message", content: [], usage: { input_tokens: 1.5, output_tokens: 2 } })),
      response => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "message", content: [], usage: { input_tokens: "12", output_tokens: 2 } })),
      response => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`${START}event: message_stop\ndata: {"type":"message_stop"}\n\n`); },
      response => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`${START}event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":-3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`); },
    ];
    for (const one of scripts) {
      script = (_request, response) => one(response);
      const answer = await call();
      await answer.text();
    }
    expect(calls().map(row => [row["status"], row["cost_basis"]])).toEqual(Array(scripts.length).fill(["incomplete", "unknown"]));
    expect(flexibleTurn(world.store, turn)!.costBasis).toBe("unknown");
  });

  test("an allowed answer header carrying the key, and a key spelled with JSON escapes in an error, never reach the agent", async () => {
    script = (_request, response) => { response.writeHead(200, { "content-type": "application/json", "request-id": `req-${SETUP_TOKEN}`, "anthropic-ratelimit-tokens-remaining": SETUP_TOKEN }).end(MESSAGE({ input_tokens: 1, output_tokens: 1 })); };
    const answer = await call();
    expect(answer.headers.get("request-id")).toBe("req-[redacted]");
    expect(answer.headers.get("anthropic-ratelimit-tokens-remaining")).toBe("[redacted]");
    await answer.text();
    const escaped = [...SETUP_TOKEN].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const halfEscaped = `\\u0073${SETUP_TOKEN.slice(1, 10)}\\/${SETUP_TOKEN.slice(10)}`;
    for (const body of [`{"type":"error","error":{"type":"invalid_request_error","message":"bad key ${escaped}"}}`, `not json, key ${escaped}`, `{"type":"error","error":{"type":"x","message":"${halfEscaped}"}}`]) {
      script = (_request, response) => { response.writeHead(400, { "content-type": "application/json" }).end(body); };
      const failed = await call();
      const text = await failed.text();
      const plain = text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\\//g, "/");
      expect(plain, body.slice(0, 60)).not.toContain(SETUP_TOKEN);
      expect(plain).not.toContain(SETUP_TOKEN.slice(10));
    }
  });
});

describe("the body: one reading, inline content only", () => {
  test("a repeated key anywhere, a reserved key or a top level that isn't one object is refused; what is sent is exactly the checked object, written again", async () => {
    const bodies = [
      // The first model is the turn's; a parser that takes the last would send the other.
      '{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[],"model":"claude-opus-4-1"}',
      '{"model":"claude-sonnet-4-5","max_tokens":10,"max_tokens":999999,"messages":[]}',
      '{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[{"role":"user","content":[{"type":"text","text":"a","type":"image"}]}]}',
      '{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[],"m\\u006fdel":"claude-opus-4-1"}',
      '{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[],"__proto__":{"model":"claude-opus-4-1"}}',
      '{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[{"role":"user","content":"hi","constructor":1}]}',
      '[{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[]}]',
      '{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[]} {"model":"claude-opus-4-1"}',
      `{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[],"metadata":${"[".repeat(70)}${"]".repeat(70)}}`,
    ];
    for (const body of bodies) expect((await call({ body })).status, body.slice(0, 120)).toBe(400);
    expect(seen).toHaveLength(0);
    expect(calls().map(row => row["reason"])).toEqual(Array(bodies.length).fill("body"));
    // Accepted: the upstream gets the checked object written again, not the agent's bytes (spacing, escapes and all).
    const raw = '{ "model" : "claude-sonnet-4-5", "max_tokens" : 10, "messages" : [ { "role" : "user", "content" : "h\\u0069" } ] }';
    expect((await call({ body: raw })).status).toBe(200);
    expect(seen[0]!.body).toBe(JSON.stringify(JSON.parse(raw)));
    expect(seen[0]!.headers["content-length"]).toBe(String(Buffer.byteLength(seen[0]!.body)));
  });

  test("content the service would fetch itself (a URL image or document, a stored file, a URL inside a tool result) is refused; inline content passes", async () => {
    const user = (content: unknown) => ({ ...BODY, messages: [{ role: "user", content }] });
    const refusedBodies = [
      user([{ type: "image", source: { type: "url", url: "https://evil.example/x.png" } }]),
      user([{ type: "document", source: { type: "url", url: "https://evil.example/x.pdf" } }]),
      user([{ type: "document", source: { type: "file", file_id: "file_123" } }]),
      user([{ type: "image", source: { type: "file", file_id: "file_123" } }]),
      user([{ type: "container_upload", file_id: "file_123" }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "url", url: "https://evil.example/y.png" } }] }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "document", source: { type: "url", url: "https://evil.example/z" } }] }] }]),
      user([{ type: "document", source: { type: "content", content: [{ type: "image", source: { type: "url", url: "https://evil.example/w.png" } }] } }]),
      user([{ type: "web_fetch_tool_result", tool_use_id: "t1", content: {} }]),
      user([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" }, file_id: "file_1" }]),
      { ...BODY, system: [{ type: "document", source: { type: "url", url: "https://evil.example/s" } }] },
    ];
    for (const body of refusedBodies) expect((await call({ body })).status, JSON.stringify(body).slice(0, 160)).toBe(400);
    expect(seen).toHaveLength(0);
    expect(calls().map(row => row["reason"])).toEqual(Array(refusedBodies.length).fill("server-fetch"));
    // Inline: text, base64 image and document, a text document, a tool result with inline content, a system string.
    const inline = { ...user([{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      { type: "document", source: { type: "text", media_type: "text/plain", data: "notes" } },
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }]), system: "be brief" };
    expect((await call({ body: inline })).status).toBe(200);
    expect(JSON.parse(seen[0]!.body)).toEqual(inline);
  });
});

describe("the credential is never echoed", () => {
  test("an upstream error, a streamed answer and response headers that carry the key are redacted for the agent, the record and the log", async () => {
    script = (_request, response) => {
      response.writeHead(401, { "content-type": "application/json", "x-echo": SETUP_TOKEN, "request-id": "req_9" })
        .end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid bearer ${SETUP_TOKEN}; also ${API_KEY}` } }));
    };
    const failed = await call();
    expect(failed.status).toBe(401);
    const text = await failed.text();
    expect(text).not.toContain(SETUP_TOKEN);
    expect(text).not.toContain(API_KEY);
    expect(JSON.parse(text)).toEqual({ type: "error", error: { type: "authentication_error", message: "invalid bearer [redacted]; also [redacted]" } });
    expect(failed.headers.get("x-echo")).toBeNull();
    expect(failed.headers.get("request-id")).toBe("req_9");
    // A streamed answer that echoes it, split across chunks.
    const sse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`
      + `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `the key is ${SETUP_TOKEN}.` } })}\n\n`
      + `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
    script = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const middle = sse.indexOf(SETUP_TOKEN) + 10;
      response.write(sse.slice(0, middle));
      setTimeout(() => response.end(sse.slice(middle)), 20);
    };
    const streamed = await (await call({ body: { ...BODY, stream: true } })).text();
    expect(streamed).not.toContain(SETUP_TOKEN);
    expect(streamed).not.toContain(SETUP_TOKEN.slice(10));
    expect(streamed).toContain("the key is [redacted].");
    expect(calls()[1]).toMatchObject({ status: "completed", tokens_out: 7 });
    // An upstream that can't be reached says why without it either.
    scripted.origin = "http://127.0.0.1:1";
    expect((await call()).status).toBe(502);
    const everything = JSON.stringify(calls()) + lines.join("\n") + JSON.stringify(world.store.handle.prepare("SELECT * FROM action_ledger").all());
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(everything).not.toContain(SETUP_TOKEN);
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain(token);
    expect(calls()[0]).toMatchObject({ status: "upstream-error", http_status: 401, detail: "the model service said authentication_error", cost_microusd: 0 });
  });
});
