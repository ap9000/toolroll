import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { openStore, type Store } from "./store.js";
import { addApprover, hashPassword } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { mintApiToken } from "./api-tokens.js";
import { ENVELOPE_VERSION } from "./envelope.js";
import { MODERN } from "./mcp-core.js";
import type { Principal, RunOperateAs } from "./mcp-person.js";
import { OAUTH_LIMITS, OAUTH_TIMES, redirectAllowed, redirectMatches } from "./mcp-oauth.js";

/**
 * MCP sign-in (mcp-oauth.ts) end to end on a real console: discovery from /mcp's 401, registration, the console's own
 * sign-in, consent with CSRF and a step-up, PKCE, refresh rotation, revocation, and that the token it makes is a
 * person's token at /mcp only. Commands run through a stand-in for runOperateAs that records the principal.
 */

const modernMeta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} };
const REDIRECT = "http://127.0.0.1:7777/callback";

let dir: string, store: Store, base: string, close: () => Promise<void>;
let ran: { argv: string[]; principal: Principal; source: string | undefined }[];
let passwords: Record<string, string>;
let clock: Date;

const fakeRunAs: RunOperateAs = async (argv, opts) => {
  ran.push({ argv, principal: opts.principal, source: opts.source });
  opts.write(`${JSON.stringify({ envelopeVersion: ENVELOPE_VERSION, command: argv.slice(0, 2).join(" "), ok: true })}\n`);
  return 0;
};

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-mcp-oauth-")));
  store = openStore(join(dir, "orders.db"));
  ran = [];
  const now = new Date();
  clock = now;
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("alex");
  const sam = addApprover(store, "sam", now, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  const invite = store.mintInvite("viewer", "alex", now);
  if (!store.consumeInviteAndCreateAccount({ tokenValue: invite.token, name: "vic", credentialHash: hashPassword("vic-password-long") }, now).ok) throw new Error("vic");
  passwords = { alex: alex.token, sam: sam.token, vic: "vic-password-long" };
  // Two projects the server knows; sam may use only the shop.
  for (const [id, repo] of [["t-shop", "/repo/shop"], ["t-bank", "/repo/bank"]] as const) {
    store.createTask({ id, title: id }, now);
    store.handle.prepare("UPDATE task_ref SET repo = ? WHERE id = ?").run(repo, store.refFor("built-in", id).id);
  }
  expect(store.setAccountProjects("sam", ["/repo/shop"], "alex", now)).toEqual({ ok: true });
  expect(store.setAccountProjects("vic", ["/repo/shop"], "alex", now)).toEqual({ ok: true });
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/shop", configDir: dir, runOperateAs: fakeRunAs, clock: () => clock });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
  close = () => new Promise(resolve => server.close(() => resolve()));
});
afterEach(async () => {
  await close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const mcp = (bearer: string | null, method = "tools/list", params: Record<string, unknown> = {}) =>
  fetch(`${base}/mcp`, { method: "POST", headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { _meta: modernMeta, ...params } }) });

async function register(redirects: string[] = [REDIRECT]): Promise<string> {
  const answer = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test Agent", redirect_uris: redirects, token_endpoint_auth_method: "none" }) });
  expect(answer.status).toBe(201);
  return ((await answer.json()) as { client_id: string }).client_id;
}

async function signIn(name: string): Promise<string> {
  const answer = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: passwords[name]! }), redirect: "manual" });
  expect(answer.status).toBe(303);
  return (answer.headers.get("set-cookie") ?? "").split(";")[0]!;
}

const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
/** The address a page that moves on by itself goes to. */
const movesTo = (html: string) => (/http-equiv="refresh" content="0;url=([^"]+)"/.exec(html)?.[1] ?? "").replace(/&#38;/g, "&");
const hidden = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";

/** Start a sign-in as the client would, and reach the consent page signed in as `name`. */
async function consentPage(client: string, name: string, challenge: string, extra: Record<string, string> = {}) {
  const start = new URL(`${base}/oauth/authorize`);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: `${base}/mcp`, scope: "read act", ...extra })) start.searchParams.set(key, value);
  const first = await fetch(start, { redirect: "manual" });
  expect(first.status).toBe(200);
  const next = movesTo(await first.text());
  expect(next).toMatch(/^\/oauth\/authorize\?request=[A-Za-z0-9_-]{32}$/);
  // Not signed in yet: the console's own sign-in, coming back here.
  const anonymous = await fetch(`${base}${next}`, { redirect: "manual" });
  expect(anonymous.status).toBe(303);
  expect(anonymous.headers.get("location")).toBe(`/login?return=${encodeURIComponent(next)}`);
  const cookie = await signIn(name);
  const page = await fetch(`${base}${next}`, { headers: { cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  return { cookie, html, request: hidden(html, "request"), csrf: hidden(html, "csrf"), headers: page.headers };
}

async function consent(cookie: string, fields: Record<string, string | string[]>, headers: Record<string, string> = { origin: base }) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) for (const one of Array.isArray(value) ? value : [value]) body.append(key, one);
  return fetch(`${base}/oauth/authorize`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers }, body, redirect: "manual" });
}

const token = (fields: Record<string, string>) => fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

/** A whole sign-in up to the code: sam, act, the shop. */
async function codeFor(client: string, name = "sam", projects = ["/repo/shop"], access = "act") {
  const { verifier, challenge } = pkce();
  const page = await consentPage(client, name, challenge);
  const allowed = await consent(page.cookie, { request: page.request, csrf: page.csrf, decision: "allow", access, project: projects, password: passwords[name]! });
  expect(allowed.status).toBe(200);
  const back = new URL(movesTo(await allowed.text()));
  return { verifier, code: back.searchParams.get("code")!, back, page };
}

async function tokensFor(client: string) {
  const { verifier, code } = await codeFor(client);
  const answer = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier, resource: `${base}/mcp` });
  expect(answer.status).toBe(200);
  return await answer.json() as { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string };
}

describe("MCP sign-in (OAuth 2.1)", () => {
  test("pending consent caps isolate sources, never evict a sign-in, and admit again after expiry", async () => {
    const client = await register();
    const page = await consentPage(client, "sam", pkce().challenge);
    const url = new URL(`${base}/oauth/authorize`);
    url.search = new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", resource: `${base}/mcp` }).toString();
    const start = (source: string) => fetch(url, { headers: { "x-forwarded-for": source } });
    for (let i = 0; i < OAUTH_LIMITS.requestsPerSource; i++) expect((await start("192.0.2.1")).status).toBe(200);
    const refused = await start("192.0.2.1");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("600");
    expect(movesTo(await refused.text())).toBe("");
    // All other sources retain their share until the global bound is full.
    for (let i = OAUTH_LIMITS.requestsPerSource + 1; i < OAUTH_LIMITS.requests; i++) {
      expect((await start(`192.0.2.${2 + Math.floor(i / OAUTH_LIMITS.requestsPerSource)}`)).status).toBe(200);
    }
    expect((await start("198.51.100.1")).status).toBe(429);
    const allowed = await consent(page.cookie, { request: page.request, csrf: page.csrf, decision: "allow", access: "read", project: "/repo/shop", password: passwords["sam"]! });
    expect(new URL(movesTo(await allowed.text())).searchParams.has("code")).toBe(true);
    clock = new Date(clock.getTime() + OAUTH_TIMES.requestMs);
    expect((await start("192.0.2.1")).status).toBe(200);
  });

  test("registration caps isolate sources and expire unused registrations before deduplication", async () => {
    const reg = (name: string, source: string) => fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": source }, body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }) });
    const first = await (await reg("First client", "192.0.2.1")).json() as { client_id: string };
    for (let i = 1; i < OAUTH_LIMITS.clientsPerSource; i++) expect((await reg(`Client ${i}`, "192.0.2.1")).status).toBe(201);
    expect((await reg("Overflow", "192.0.2.1")).status).toBe(429);
    expect((await reg("Another source", "198.51.100.1")).status).toBe(201);
    // Earlier untrusted hops cannot change the bucket chosen by the trusted proxy's last hop.
    expect((await reg("Overflow", "203.0.113.1, 192.0.2.1")).status).toBe(429);
    expect(store.oauthClient(first.client_id)).not.toBeNull();
    for (let i = OAUTH_LIMITS.clientsPerSource + 1; i < OAUTH_LIMITS.clients; i++) {
      expect(store.registerOAuthClient({ id: `client-${i}`, name: `Client ${i}`, redirectUris: [REDIRECT], source: `source-${i}` }, clock, OAUTH_LIMITS.clients, OAUTH_LIMITS.clientsPerSource)).not.toBeNull();
    }
    expect((await reg("Global overflow", "203.0.113.2")).status).toBe(429);
    clock = new Date(clock.getTime() + 86_400_000);
    const fresh = await reg("First client", "192.0.2.1");
    expect(fresh.status).toBe(201);
    expect(((await fresh.json()) as { client_id: string }).client_id).not.toBe(first.client_id);
    expect(store.oauthClient(first.client_id)).toBeNull();
  });

  test("registration expiry cannot evict a live consent, and unused clients cannot authorize after expiry", async () => {
    const client = await register();
    clock = new Date(clock.getTime() + 86_400_000 - 60_000);
    const page = await consentPage(client, "sam", pkce().challenge);
    clock = new Date(clock.getTime() + 60_000);
    await register(["https://other-agent.example/callback"]);
    expect(store.oauthClient(client)).not.toBeNull();
    const allowed = await consent(page.cookie, { request: page.request, csrf: page.csrf, decision: "allow", access: "read", project: "/repo/shop", password: passwords["sam"]! });
    expect(new URL(movesTo(await allowed.text())).searchParams.has("code")).toBe(true);
    const unused = await register();
    clock = new Date(clock.getTime() + 86_400_000);
    const params = new URLSearchParams({ client_id: unused, redirect_uri: REDIRECT, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", resource: `${base}/mcp` });
    const expired = await fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" });
    expect(expired.status).toBe(400);
    expect(movesTo(await expired.text())).toBe("");
  });

  test("discovery: /mcp's 401 names the resource metadata, which names this console's authorization server", async () => {
    const refused = await mcp(null);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(`Bearer realm="toolroll-mcp", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read", "act"] });
    const server = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(server).toMatchObject({ issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], grant_types_supported: ["authorization_code", "refresh_token"] });
  });

  test("registration takes https or loopback http redirects only, and issues no secret", async () => {
    const reg = async (body: unknown) => fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ok = await reg({ client_name: "Agent‮ evil", redirect_uris: ["https://agent.example/cb", "http://[::1]:9/cb"] });
    expect(ok.status).toBe(201);
    const body = await ok.json() as Record<string, unknown>;
    expect(body).toMatchObject({ client_name: "Agent evil", token_endpoint_auth_method: "none", redirect_uris: ["https://agent.example/cb", "http://[::1]:9/cb"] });
    expect(body).not.toHaveProperty("client_secret");
    // The same client again is the same client.
    expect((await (await reg({ client_name: "Agent‮ evil", redirect_uris: ["https://agent.example/cb", "http://[::1]:9/cb"] })).json() as Record<string, unknown>)["client_id"]).toBe(body["client_id"]);
    for (const redirect of ["http://agent.example/cb", "http://localhost:9/cb", "https://agent.example/cb#x", "https://user:pw@agent.example/cb", "javascript:alert(1)", "cursor://cb"]) {
      const refused = await reg({ redirect_uris: [redirect] });
      expect(refused.status, redirect).toBe(400);
      expect(((await refused.json()) as Record<string, unknown>)["error"]).toBe("invalid_redirect_uri");
    }
    expect((await reg({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" })).status).toBe(400);
    expect((await reg({ redirect_uris: [] })).status).toBe(400);
  });

  test("the whole flow: PKCE, consent, a scoped person token at /mcp, and nowhere else", async () => {
    const client = await register();
    const { verifier, code, back, page } = await codeFor(client);
    // The consent page: framed by nobody, the client unverified beside where it returns, sam's project only.
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.html).toContain("unverified");
    expect(page.html).toContain("returns to 127.0.0.1:7777");
    expect(page.html).toContain("/repo/shop");
    expect(page.html).not.toContain("/repo/bank");
    expect(page.html).toContain("Allow access");
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("iss")).toBe(base);

    const answer = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier, resource: `${base}/mcp` });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const tokens = await answer.json() as Record<string, unknown>;
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "act" });
    expect(tokens["access_token"]).toMatch(/^so_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(tokens["refresh_token"]).toMatch(/^sor_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
    const access = tokens["access_token"] as string;
    const id = access.slice(3, 15);

    // An ordinary API token of sam's, listed and revocable like any other, its secrets kept only as hashes.
    expect(store.apiTokens("sam").find(one => one.id === id)).toMatchObject({ name: "MCP: Test Agent", access: "act", revokedAt: null });
    const kept = JSON.stringify(store.handle.prepare("SELECT * FROM oauth_grant").all()) + JSON.stringify(store.handle.prepare("SELECT * FROM oauth_code").all()) + JSON.stringify(store.handle.prepare("SELECT * FROM api_token").all());
    for (const secret of [access, tokens["refresh_token"] as string, code, verifier]) expect(kept).not.toContain(secret.slice(-43));
    expect(JSON.stringify(store.actionLedger({ repos: null, limit: 200 }))).not.toContain(access.slice(-43));

    // /mcp runs it as sam, in the project sam chose, from source mcp.
    const called = await mcp(access, "tools/call", { name: "task_show", arguments: { ref: "t-shop" } });
    expect(called.status).toBe(200);
    expect(ran.at(-1)).toMatchObject({ source: "mcp", principal: { kind: "person", account: "sam", scope: "act", tokenId: id, projects: ["/repo/shop"] } });
    // Never outside /mcp: the remote CLI and the console refuse it.
    const cli = await fetch(`${base}/api/cli`, { method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: JSON.stringify({ argv: ["status"] }) });
    expect(cli.status).toBe(401);
    expect((await fetch(`${base}/work`, { headers: { authorization: `Bearer ${access}` }, redirect: "manual" })).status).not.toBe(200);
  });

  test("a wrong verifier is refused and spends the code; a code works once", async () => {
    const client = await register();
    const { verifier, code } = await codeFor(client);
    const wrong = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: pkce().verifier });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    expect((await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier })).status).toBe(400);
    expect(store.apiTokens("sam")).toEqual([]);

    // A code used twice: the token it made ends too.
    const again = await codeFor(client);
    const first = await token({ grant_type: "authorization_code", code: again.code, redirect_uri: REDIRECT, client_id: client, code_verifier: again.verifier });
    expect(first.status).toBe(200);
    const access = ((await first.json()) as { access_token: string }).access_token;
    expect((await token({ grant_type: "authorization_code", code: again.code, redirect_uri: REDIRECT, client_id: client, code_verifier: again.verifier })).status).toBe(400);
    expect((await mcp(access)).status).toBe(401);

    // Another client, or another redirect, can't spend a code.
    const other = await register(["http://127.0.0.1:8888/other"]);
    const third = await codeFor(client);
    expect((await token({ grant_type: "authorization_code", code: third.code, redirect_uri: REDIRECT, client_id: other, code_verifier: third.verifier })).status).toBe(400);
  });

  test("pre-consent errors stay on Toolroll even for a registered attacker redirect", async () => {
    const redirect = "https://attacker.example/callback";
    const client = await register([redirect]);
    const go = async (extra: Record<string, string>) => {
      const url = new URL(`${base}/oauth/authorize`);
      for (const [key, value] of Object.entries({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: pkce().challenge, code_challenge_method: "S256", resource: `${base}/mcp`, ...extra })) url.searchParams.set(key, value);
      const answer = await fetch(url, { redirect: "manual" });
      const html = await answer.text();
      expect(answer.headers.get("location")).toBeNull();
      expect(html).not.toContain('http-equiv="refresh"');
      expect(html).not.toContain("attacker.example");
      return { status: answer.status, to: movesTo(html) };
    };
    for (const extra of [{ code_challenge_method: "plain" }, { resource: "https://elsewhere.example/mcp" }, { scope: "admin" }, { response_type: "token" }, { state: "x".repeat(1025) }]) {
      expect(await go(extra)).toEqual({ status: 400, to: "" });
    }
    const unregistered = await go({ redirect_uri: "http://127.0.0.1:7777/elsewhere" });
    expect(unregistered.status).toBe(400);
    expect(unregistered.to).toBe("");
    // A loopback redirect may name any port (RFC 8252), on the registered path.
    expect(redirectMatches("http://127.0.0.1:51234/callback", [REDIRECT])).toBe("http://127.0.0.1:51234/callback");
    expect(redirectMatches("https://agent.example:444/cb", ["https://agent.example/cb"])).toBeNull();
    expect(redirectAllowed("http://127.0.0.1.evil.example/cb")).toBe(false);
  });

  test("a refresh rotates both secrets; the old ones stop, and a replayed refresh ends the grant", async () => {
    const client = await register();
    const first = await tokensFor(client);
    const rotated = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client, resource: `${base}/mcp` });
    expect(rotated.status).toBe(200);
    const second = await rotated.json() as { access_token: string; refresh_token: string };
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token.slice(0, 15)).toBe(first.access_token.slice(0, 15));
    expect((await mcp(first.access_token)).status).toBe(401);
    expect((await mcp(second.access_token)).status).toBe(200);
    // Another client can't use it.
    const other = await register(["http://127.0.0.1:8888/other"]);
    expect((await token({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: other })).status).toBe(400);
    const thirdResponse = await token({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: client });
    expect(thirdResponse.status).toBe(200);
    const third = await thirdResponse.json() as { access_token: string; refresh_token: string };
    // An unknown guess naming a real family cannot revoke it.
    const guess = `sor_${first.access_token.slice(3, 15)}_${randomBytes(32).toString("base64url")}`;
    expect((await token({ grant_type: "refresh_token", refresh_token: guess, client_id: client })).status).toBe(400);
    expect((await mcp(third.access_token)).status).toBe(200);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM oauth_refresh").get()?.["n"]).toBe(3);
    // Even the grandparent secret ends the family, including the newest access and refresh tokens.
    const replay = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client });
    expect(replay.status).toBe(400);
    expect((await mcp(second.access_token)).status).toBe(401);
    expect((await mcp(third.access_token)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: third.refresh_token, client_id: client })).status).toBe(400);
    expect((await token({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: client })).status).toBe(400);
    expect(store.apiTokens("sam")[0]!.revokedAt).not.toBeNull();
  });

  test("an access token lasts an hour: past it /mcp answers 401 and a refresh carries on", async () => {
    const client = await register();
    const tokens = await tokensFor(client);
    store.handle.prepare("UPDATE oauth_grant SET access_expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect((await mcp(tokens.access_token)).status).toBe(401);
    const renewed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client });
    expect(renewed.status).toBe(200);
    expect((await mcp(((await renewed.json()) as { access_token: string }).access_token)).status).toBe(200);
  });

  test("two refreshes with one secret: one wins, and the other ends the grant rather than both getting tokens", async () => {
    const client = await register();
    const tokens = await tokensFor(client);
    const answers = await Promise.all([1, 2].map(() => token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client })));
    expect(answers.map(one => one.status).sort()).toEqual([200, 400]);
    const winner = (await answers.find(one => one.status === 200)!.json()) as { access_token: string };
    expect((await mcp(winner.access_token)).status).toBe(401);
  });

  test("revoked from Sessions & tokens: the next /mcp call is a 401 that names the sign-in, and refresh is refused", async () => {
    const client = await register();
    const tokens = await tokensFor(client);
    const id = tokens.access_token.slice(3, 15);
    expect(store.revokeApiToken(id, "sam", new Date())).toBe(true);
    const refused = await mcp(tokens.access_token);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    expect((await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client })).status).toBe(400);
  });

  test("a change to the person's access ends the grant", async () => {
    const client = await register();
    const tokens = await tokensFor(client);
    expect(store.setAccountProjects("sam", ["/repo/shop", "/repo/bank"], "alex", new Date())).toEqual({ ok: true });
    expect((await mcp(tokens.access_token)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client })).status).toBe(400);
    expect(store.apiTokens("sam")[0]!.revokedAt).not.toBeNull();
  });

  test("consent is required: a declined, forged or cross-site form grants nothing", async () => {
    const client = await register();
    const { challenge } = pkce();
    const page = await consentPage(client, "sam", challenge);
    const allow = { request: page.request, decision: "allow", access: "read", project: "/repo/shop", password: passwords["sam"]! };
    // No CSRF value, a wrong one, another site's page, or no page named at all.
    expect((await consent(page.cookie, allow)).status).toBe(403);
    expect((await consent(page.cookie, { ...allow, csrf: "0".repeat(64) })).status).toBe(403);
    expect((await consent(page.cookie, { ...allow, csrf: page.csrf }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await consent(page.cookie, { ...allow, csrf: page.csrf }, {})).status).toBe(403);
    // Without a session: nothing.
    expect((await consent("", { ...allow, csrf: page.csrf })).status).toBe(403);
    // A session and CSRF value alone are not a decision, so an incomplete form must stay local too.
    const undecided = await consent(page.cookie, { ...allow, csrf: page.csrf, decision: "" });
    expect(undecided.status).toBe(400);
    expect(movesTo(await undecided.text())).toBe("");
    // The step-up: a wrong password grants nothing.
    const wrong = await consent(page.cookie, { ...allow, csrf: page.csrf, password: "not-it" });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).toContain("Enter your Toolroll password");
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM oauth_code").get()?.["n"]).toBe(0);
    // Declined: back to the client with access_denied, and the request is spent.
    const declined = await consent(page.cookie, { request: page.request, csrf: page.csrf, decision: "deny" });
    expect(declined.status).toBe(200);
    const denial = new URL(movesTo(await declined.text()));
    expect(denial.searchParams.get("error")).toBe("access_denied");
    expect(denial.searchParams.get("state")).toBe("st-1");
    expect(denial.searchParams.get("iss")).toBe(base);
    expect((await consent(page.cookie, { ...allow, csrf: page.csrf })).status).toBe(410);
    // A code nobody consented to is just a guess.
    expect((await token({ grant_type: "authorization_code", code: "guess".repeat(9), redirect_uri: REDIRECT, client_id: client, code_verifier: pkce().verifier })).status).toBe(400);
    expect(store.apiTokens("sam")).toEqual([]);
  });

  test("the consent answer moves on by a page, not a redirect the form-action 'self' policy would stop", async () => {
    const client = await register();
    const { challenge } = pkce();
    const page = await consentPage(client, "sam", challenge);
    // The page holding the form allows posting to itself only…
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    const allowed = await consent(page.cookie, { request: page.request, csrf: page.csrf, decision: "allow", access: "read", project: "/repo/shop", password: passwords["sam"]! });
    // …so the answer is a page, never a 3xx to the client's address, and it posts nowhere.
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("location")).toBeNull();
    expect(allowed.headers.get("content-security-policy")).toContain("form-action 'none'");
    expect(movesTo(await allowed.text())).toMatch(/^http:\/\/127\.0\.0\.1:7777\/callback\?code=/);
  });

  test("an ungranted project can't be granted, and a viewer can only read", async () => {
    const client = await register();
    const { challenge } = pkce();
    const page = await consentPage(client, "sam", challenge);
    const foreign = await consent(page.cookie, { request: page.request, csrf: page.csrf, decision: "allow", access: "read", project: ["/repo/shop", "/repo/bank"], password: passwords["sam"]! });
    expect(foreign.status).toBe(403);
    const said = await foreign.text();
    expect(said).toContain("Choose from your own projects.");
    expect(said).not.toContain("/repo/bank");
    expect((await consent(page.cookie, { request: page.request, csrf: page.csrf, decision: "allow", access: "read", password: passwords["sam"]! })).status).toBe(400);

    const viewer = await consentPage(client, "vic", pkce().challenge);
    expect(viewer.html).not.toContain('value="act"');
    const act = await consent(viewer.cookie, { request: viewer.request, csrf: viewer.csrf, decision: "allow", access: "act", project: "/repo/shop", password: passwords["vic"]! });
    expect(act.status).toBe(403);
    const read = await codeFor(client, "vic", ["/repo/shop"], "read");
    const tokens = await (await token({ grant_type: "authorization_code", code: read.code, redirect_uri: REDIRECT, client_id: client, code_verifier: read.verifier })).json() as { access_token: string; scope: string };
    expect(tokens.scope).toBe("read");
    const listed = await (await mcp(tokens.access_token)).json() as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map(one => one.name)).not.toContain("file_task");
  });

  test("without projects, consent offers only cancellation and issues no code", async () => {
    expect(store.setAccountProjects("sam", [], "alex", clock)).toEqual({ ok: true });
    const page = await consentPage(await register(), "sam", pkce().challenge);
    expect(page.html).toContain("You don't have access to any projects.");
    expect(page.html).not.toContain('value="allow"');
    expect(page.html).not.toContain('<script');
    const response = await consent(page.cookie, { request: page.request, csrf: page.csrf, decision: "deny" });
    expect(new URL(movesTo(await response.text())).searchParams.get("error")).toBe("access_denied");
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM oauth_code").get()?.["n"]).toBe(0);
  });

  test("a pasted so_ token works as before, everywhere it did", async () => {
    const minted = mintApiToken();
    const now = new Date();
    store.createApiToken({ id: minted.id, account: "sam", name: "laptop", secretHash: minted.hash, access: "read", expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), by: "sam" }, now);
    expect((await mcp(minted.token)).status).toBe(200);
    await mcp(minted.token, "tools/call", { name: "task_show", arguments: { ref: "t-shop" } });
    expect(ran.at(-1)!.principal).toMatchObject({ account: "sam", tokenId: minted.id, projects: ["/repo/shop"] });
    const cli = await fetch(`${base}/api/cli`, { method: "POST", headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" }, body: JSON.stringify({ argv: ["status"] }) });
    expect(cli.status).not.toBe(401);
  });

  test("MCP intersects current account access, API-token limits and the OAuth grant; corrupt limits fail closed", async () => {
    const client = await register();
    const tokens = await tokensFor(client);
    const id = tokens.access_token.slice(3, 15);
    const projects = async () => {
      await mcp(tokens.access_token, "tools/call", { name: "list_tasks", arguments: {} });
      return ran.at(-1)!.principal.projects;
    };
    // Neither stored record can confer a project outside current account access.
    store.handle.prepare("UPDATE oauth_grant SET projects_json = ? WHERE token = ?").run(JSON.stringify(["/repo/shop", "/repo/bank"]), id);
    store.handle.prepare("UPDATE api_token SET projects_json = ? WHERE id = ?").run(JSON.stringify(["/repo/shop", "/repo/bank"]), id);
    expect(await projects()).toEqual(["/repo/shop"]);
    store.handle.prepare("UPDATE api_token SET projects_json = ? WHERE id = ?").run(JSON.stringify(["/repo/bank"]), id);
    expect(await projects()).toEqual([]);
    store.handle.prepare("UPDATE api_token SET projects_json = ? WHERE id = ?").run(JSON.stringify(["/repo/shop"]), id);
    store.handle.prepare("UPDATE oauth_grant SET projects_json = ? WHERE token = ?").run(JSON.stringify(["/repo/bank"]), id);
    expect(await projects()).toEqual([]);
    store.handle.prepare("UPDATE oauth_grant SET projects_json = ? WHERE token = ?").run(JSON.stringify(["/repo/shop", 1]), id);
    expect(await projects()).toEqual([]);
    store.handle.prepare("UPDATE oauth_grant SET projects_json = ? WHERE token = ?").run(JSON.stringify(["/repo/shop"]), id);
    store.handle.prepare("UPDATE api_token SET projects_json = 'broken' WHERE id = ?").run(id);
    expect(await projects()).toEqual([]);
    expect((await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client })).status).toBe(400);
  });

  test("an MCP-managed token missing its grant cannot become an ordinary bearer", async () => {
    const client = await register();
    const tokens = await tokensFor(client);
    store.handle.prepare("DELETE FROM oauth_refresh").run();
    store.handle.prepare("DELETE FROM oauth_grant").run();
    expect((await mcp(tokens.access_token)).status).toBe(401);
    expect((await fetch(`${base}/api/cli`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ argv: ["status"] }) })).status).toBe(401);
  });
});
