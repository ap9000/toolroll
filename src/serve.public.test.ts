/**
 * Serving on a real domain (remote team, phase 3): HSTS on the public https host, API tokens refused over plain HTTP
 * from outside this computer and the tailnet, and forwarded headers believed only from a loopback peer. The socket
 * peer is set per test, as a direct caller (or the same-host proxy) would present it.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { mintApiToken } from "./api-tokens.js";
import type { RunOperateAs } from "./cli-http.js";
import { HSTS_VALUE, USE_HTTPS } from "./public-access.js";

const PUBLIC = "toolroll.example.test";
let dir: string, store: Store, server: Server, port: number, ran: number, peer: string | null, token: string;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-public-")));
  store = openStore(join(dir, "orders.db"));
  const now = new Date();
  if (!addApprover(store, "alice", now).ok) throw new Error("alice");
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alice", name: "alice-laptop", secretHash: minted.hash, access: "act", expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), by: "alice" }, now);
  token = minted.token;
  ran = 0;
  const cliRunner: RunOperateAs = async () => { ran++; return 0; };
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), configDir: dir, publicUrl: `https://${PUBLIC}`, cliRunner });
  // The peer a test speaks as: the socket's own address unless a test names another.
  peer = null;
  server.prependListener("connection", socket => {
    const actual = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(socket), "remoteAddress");
    Object.defineProperty(socket, "remoteAddress", { get: () => peer ?? actual?.get?.call(socket) });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: PUBLIC, connection: "close", ...options.headers } }, incoming => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", chunk => { body += chunk; });
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }));
    });
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}
const cli = (headers: Record<string, string> = {}) => send("/api/cli", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ argv: ["status"] }) });
const refused = (answer: Answer) => answer.status === 403 && answer.body === USE_HTTPS;

test("HSTS goes only to the public host reached over HTTPS through the same-host proxy", async () => {
  const proxied = await send("/login", { headers: { "x-forwarded-for": "203.0.113.10", "x-forwarded-proto": "https" } });
  expect(proxied.status).toBe(200);
  expect(proxied.headers["strict-transport-security"]).toBe(HSTS_VALUE);

  // Not proved HTTPS, not the public host, or a forged header from a direct caller: no HSTS.
  expect((await send("/login", { headers: { "x-forwarded-for": "203.0.113.10" } })).headers["strict-transport-security"]).toBeUndefined();
  expect((await send("/login", { headers: { host: `127.0.0.1:${port}`, "x-forwarded-proto": "https" } })).headers["strict-transport-security"]).toBeUndefined();
  peer = "198.51.100.7";
  expect((await send("/login", { headers: { "x-forwarded-proto": "https" } })).headers["strict-transport-security"]).toBeUndefined();
});

test("API tokens over plain HTTP from elsewhere are refused before anything checks or runs them", async () => {
  peer = "198.51.100.7";
  const answer = await cli();
  expect(refused(answer), answer.body).toBe(true);
  expect(answer.headers["content-type"]).toMatch(/^text\/plain/);
  expect(ran).toBe(0);
  expect(refused(await send("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }))).toBe(true);
  expect(refused(await send("/mcp"))).toBe(true);
  // Token sign-in (`toolroll connect` checks the token against /api/team) and any other bearer road.
  expect(refused(await send("/api/team", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }))).toBe(true);
  expect(refused(await send("/", { headers: { authorization: "Bearer alice:not-a-password" } }))).toBe(true);
  // A direct caller cannot claim to be the proxy or to have used HTTPS.
  expect(refused(await cli({ "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https" }))).toBe(true);
  // Through the same-host proxy: a relayed remote caller over plain HTTP, or with no readable caller, is refused too.
  peer = null;
  expect(refused(await cli({ "x-forwarded-for": "203.0.113.10" }))).toBe(true);
  expect(refused(await cli({ "x-forwarded-for": "203.0.113.10", "x-forwarded-proto": "http" }))).toBe(true);
  expect(refused(await cli({ forwarded: "for=203.0.113.10;proto=http" }))).toBe(true);
  expect(ran).toBe(0);
});

test("MCP sign-in refuses plain HTTP from elsewhere at every token endpoint before handling it, and stays open over HTTPS", async () => {
  const before = store.handle.prepare("SELECT COUNT(*) AS n FROM oauth_client").get()?.["n"];
  peer = "198.51.100.7";
  const form = { "content-type": "application/x-www-form-urlencoded" };
  expect(refused(await send("/oauth/token", { method: "POST", headers: form, body: "grant_type=refresh_token&refresh_token=sor_x_y&client_id=c" }))).toBe(true);
  expect(refused(await send("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: ["https://a.example/cb"] }) }))).toBe(true);
  expect(refused(await send("/oauth/authorize?response_type=code&client_id=c"))).toBe(true);
  expect(refused(await send("/oauth/revoke", { method: "POST", headers: form, body: "token=x" }))).toBe(true);
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM oauth_client").get()?.["n"]).toBe(before);
  // Discovery is public; and through the same-host proxy over HTTPS the endpoints answer as before.
  expect((await send("/.well-known/oauth-authorization-server")).status).toBe(200);
  peer = null;
  const https = { "x-forwarded-for": "203.0.113.10", "x-forwarded-proto": "https" };
  const token = await send("/oauth/token", { method: "POST", headers: { ...form, ...https }, body: "grant_type=refresh_token&refresh_token=sor_x_y&client_id=c" });
  expect(refused(token)).toBe(false);
  expect(token.headers["content-type"]).toMatch(/json/);
  expect(refused(await send("/oauth/revoke", { method: "POST", headers: { ...form, ...https }, body: "token=x" }))).toBe(false);
});

test("password sign-in in the browser is untouched over plain HTTP", async () => {
  peer = "198.51.100.7";
  const answer = await send("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=alice&token=wrong" });
  expect(refused(answer)).toBe(false);
  expect(answer.headers["content-type"]).toMatch(/^text\/html/);
});

test("this computer, the tailnet and HTTPS through the proxy still reach the remote CLI", async () => {
  for (const [who, headers] of [
    [null, {}],
    [null, { "x-forwarded-for": "100.101.102.103" }],
    [null, { "x-forwarded-for": "203.0.113.10", "x-forwarded-proto": "https" }],
    ["100.101.102.103", {}],
    ["::ffff:100.64.0.1", {}],
    ["fd7a:115c:a1e0::1", {}],
  ] as const) {
    peer = who;
    const answer = await cli(headers);
    expect(refused(answer), `${who ?? "loopback"} ${JSON.stringify(headers)}: ${answer.body}`).toBe(false);
  }
  expect(ran).toBe(6);
});
