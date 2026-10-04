/**
 * One-click connections: Connect finds a service's sign-in, registers
 * this console, and sends the person there with PKCE; the code comes back as
 * tokens in the tool's secrets file (never the database); a tool of the same
 * name set up another way is never overwritten; and the worker renews a
 * sign-in before it runs out, trying a revoked one only now and then.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { addToolTo, catalogTool, prepareRunTools, projectToolsOf, readToolSecrets, removeToolFrom, setToolSecrets, testTool } from "./project-tools.js";
import { CONNECT_CALLBACK, ONE_CLICK, connectedSpec, connectionsOf, discoverSignIn, finishConnect, oneClickServices, refreshConnections, readsOnly, researchToolsOf, startConnect } from "./mcp-connect.js";
import { scoutProxyEnv } from "./scout.js";

const T0 = new Date("2026-09-26T23:00:00.000Z");
let dir: string, repo: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-connect-")));
  repo = join(dir, "shop");
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** Stripe's sign-in as its servers answer it, and every request that reaches it. */
function stripe(tokens: () => Record<string, unknown> = () => ({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })) {
  const seen: { url: string; method: string; body: string }[] = [];
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET", body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
    seen.push({ url, method, body });
    if (url === "https://mcp.stripe.com/" && method === "POST") return reply(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer resource_metadata="https://mcp.stripe.com/.well-known/oauth-protected-resource"' });
    if (url === "https://mcp.stripe.com/.well-known/oauth-protected-resource") return reply(200, { resource: "https://mcp.stripe.com", authorization_servers: ["https://access.stripe.com/mcp"] });
    if (url === "https://access.stripe.com/.well-known/oauth-authorization-server/mcp") return reply(200, { authorization_endpoint: "https://access.stripe.com/mcp/oauth2/authorize", token_endpoint: "https://access.stripe.com/mcp/oauth2/token",
      registration_endpoint: "https://access.stripe.com/mcp/oauth2/register", code_challenge_methods_supported: ["S256"] });
    if (url === "https://access.stripe.com/mcp/oauth2/register") return reply(201, { client_id: "client-7" });
    if (url === "https://access.stripe.com/mcp/oauth2/token") return reply(200, tokens());
    return reply(404, {});
  }) as typeof fetch;
  return { fetcher, seen };
}

test("Connect registers this console and sends the person to sign in with PKCE, for the resource the server names", async () => {
  const { fetcher, seen } = stripe();
  const started = await startConnect({ service: "stripe", repo, by: "alex", origin: "http://127.0.0.1:4180", kit: "support-desk" }, fetcher, T0.getTime());
  if (!started.ok) throw new Error(started.said);
  const go = new URL(started.go);
  expect(go.origin + go.pathname).toBe("https://access.stripe.com/mcp/oauth2/authorize");
  expect(Object.fromEntries(go.searchParams)).toMatchObject({ response_type: "code", client_id: "client-7", redirect_uri: `http://127.0.0.1:4180${CONNECT_CALLBACK}`, code_challenge_method: "S256", state: started.state, resource: "https://mcp.stripe.com" });
  expect(go.searchParams.get("code_challenge")).toBe(createHash("sha256").update(started.visit.verifier).digest("base64url"));
  expect(JSON.parse(seen.find(one => one.url.endsWith("/register"))!.body)).toMatchObject({ redirect_uris: [`http://127.0.0.1:4180${CONNECT_CALLBACK}`], token_endpoint_auth_method: "none" });
  expect(started.visit).toMatchObject({ service: "stripe", repo, by: "alex", kit: "support-desk", resource: "https://mcp.stripe.com", expires: T0.getTime() + 15 * 60_000 });
});

test("the code becomes tokens in the tool's secrets file, never the database, and the tool joins the project", async () => {
  const { fetcher, seen } = stripe();
  const started = await startConnect({ service: "stripe", repo, by: "alex", origin: "http://127.0.0.1:4180" }, fetcher, T0.getTime());
  if (!started.ok) throw new Error(started.said);
  expect(await finishConnect(store, started.visit, "code-1", T0, { fetcher, home: dir, test: false })).toEqual({ ok: true, said: "Stripe is connected to shop." });
  expect(new URLSearchParams(seen.at(-1)!.body).get("code_verifier")).toBe(started.visit.verifier);
  expect(Object.fromEntries(new URLSearchParams(seen.at(-1)!.body))).toMatchObject({ grant_type: "authorization_code", code: "code-1", client_id: "client-7", resource: "https://mcp.stripe.com" });
  const [tool] = projectToolsOf(store, repo);
  expect(tool!.spec).toMatchObject({ name: "stripe", transport: "http", url: "https://mcp.stripe.com/", bearer: "OAUTH_ACCESS_TOKEN" });
  expect(readToolSecrets(repo, "stripe", dir)).toMatchObject({ OAUTH_ACCESS_TOKEN: "access-1", OAUTH_REFRESH_TOKEN: "refresh-1", OAUTH_CLIENT_ID: "client-7", OAUTH_EXPIRES_AT: "2026-09-27T00:00:00.000Z" });
  store.close();
  for (const file of ["orders.db", "orders.db-wal"].map(one => join(dir, one)).filter(existsSync)) expect(readFileSync(file).includes("refresh-1")).toBe(false);
  store = openStore(join(dir, "orders.db"));
  expect(connectionsOf(store, repo).find(one => one.id === "stripe")?.state).toBe("connected");
  // Signing in again keeps the one tool and replaces its tokens.
  const again = await startConnect({ service: "stripe", repo, by: "alex", origin: "http://127.0.0.1:4180" }, stripe(() => ({ access_token: "access-2" })).fetcher, T0.getTime());
  if (!again.ok) throw new Error(again.said);
  expect(await finishConnect(store, again.visit, "code-2", T0, { fetcher: stripe(() => ({ access_token: "access-2" })).fetcher, home: dir, test: false })).toMatchObject({ ok: true });
  expect(projectToolsOf(store, repo)).toHaveLength(1);
  expect(readToolSecrets(repo, "stripe", dir)["OAUTH_ACCESS_TOKEN"]).toBe("access-2");
});

test("a tool of the same name set up another way is never overwritten", async () => {
  const { label: _label, ...sentry } = catalogTool("sentry")!;
  expect(addToolTo(store, repo, sentry, "the common tools list", "alex", T0, { home: dir })).toMatchObject({ ok: true });
  expect(connectionsOf(store, repo).find(one => one.id === "sentry")?.state).toBe("taken");
  const visit = { service: "sentry", repo, by: "alex", kit: null, verifier: "v", clientId: "c", clientSecret: null, token: "https://mcp.sentry.dev/oauth/token", resource: "https://mcp.sentry.dev/mcp", redirect: "http://127.0.0.1:4180/x", expires: T0.getTime() + 60_000 };
  let asked = 0;
  const said = await finishConnect(store, visit, "code", T0, { fetcher: (async () => { asked++; return new Response("{}"); }) as typeof fetch, home: dir, test: false });
  expect(said).toEqual({ ok: false, said: "This project already has a tool called sentry, set up another way. Remove it on this page to connect Sentry by signing in." });
  expect(asked).toBe(0);
  expect(projectToolsOf(store, repo)[0]!.spec.transport).toBe("stdio");
});

test("the worker renews a sign-in that runs out within ten minutes, and tries a revoked one only every five", async () => {
  const { fetcher } = stripe(() => ({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 300 }));
  const started = await startConnect({ service: "stripe", repo, by: "alex", origin: "http://127.0.0.1:4180" }, fetcher, T0.getTime());
  if (!started.ok) throw new Error(started.said);
  await finishConnect(store, started.visit, "code-1", T0, { fetcher, home: dir, test: false });
  // Five minutes left: renewed, with its refresh token, for the same resource.
  const renewing = stripe(() => ({ access_token: "access-2", expires_in: 3600 }));
  expect(await refreshConnections(store, [repo], T0, { fetcher: renewing.fetcher, home: dir })).toEqual({ refreshed: 1, problems: [] });
  expect(Object.fromEntries(new URLSearchParams(renewing.seen[0]!.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "client-7", resource: "https://mcp.stripe.com" });
  expect(readToolSecrets(repo, "stripe", dir)).toMatchObject({ OAUTH_ACCESS_TOKEN: "access-2", OAUTH_REFRESH_TOKEN: "refresh-1", OAUTH_EXPIRES_AT: "2026-09-27T00:00:00.000Z" });
  // An hour left: nothing to do.
  const idle = stripe();
  expect(await refreshConnections(store, [repo], T0, { fetcher: idle.fetcher, home: dir })).toEqual({ refreshed: 0, problems: [] });
  expect(idle.seen).toHaveLength(0);
  // Revoked: said once, then left alone for five minutes.
  const late = new Date(T0.getTime() + 55 * 60_000);
  const revoked = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
  expect(await refreshConnections(store, [repo], late, { fetcher: revoked, home: dir })).toEqual({ refreshed: 0, problems: ["stripe: its sign-in ran out; connect it again on the Tools page"] });
  expect(await refreshConnections(store, [repo], new Date(late.getTime() + 60_000), { fetcher: revoked, home: dir })).toEqual({ refreshed: 0, problems: [] });
  expect((await refreshConnections(store, [repo], new Date(late.getTime() + 6 * 60_000), { fetcher: revoked, home: dir })).problems).toHaveLength(1);
});

test("a stand-in takes a service's place only at a loopback address", () => {
  expect(oneClickServices({ STANDING_ORDERS_TEST_CONNECT: "stripe|Stripe|http://127.0.0.1:5123/mcp" }).find(one => one.id === "stripe")?.url).toBe("http://127.0.0.1:5123/mcp");
  expect(oneClickServices({ STANDING_ORDERS_TEST_CONNECT: "stripe|Stripe|http://evil.example/mcp" }).find(one => one.id === "stripe")?.url).toBe("https://mcp.stripe.com/");
  expect(oneClickServices({ STANDING_ORDERS_TEST_CONNECT: "stripe|Stripe|https://127.0.0.1/mcp" }).find(one => one.id === "stripe")?.url).toBe("https://mcp.stripe.com/");
});

test("Mobbin, PostHog and Better Stack connect by signing in; Figma connects through its desktop app, with no key", () => {
  const listed = connectionsOf(store, repo);
  expect(listed.filter(one => ["mobbin", "figma", "posthog", "betterstack", "figma-desktop"].includes(one.id))).toEqual([
    { id: "mobbin", label: "Mobbin", about: "Real app screens and flows to learn from.", state: "open" },
    { id: "posthog", label: "PostHog", about: "Product analytics, funnels and events.", state: "open" },
    { id: "betterstack", label: "Better Stack", about: "Uptime checks and incidents.", state: "open" },
    { id: "figma-desktop", label: "Figma (desktop app)", about: "Open the Figma desktop app, turn on the Dev Mode MCP server in Preferences, then Connect.", state: "open", local: true },
  ]);
  expect(oneClickServices({}).map(one => one.id)).not.toContain("figma");
  expect(connectedSpec("figma")).toBeNull();
  // The desktop app's Dev Mode server on this computer: streamable HTTP, no key (it uses the app's own sign-in).
  const { label, ...figma } = catalogTool("figma-desktop")!;
  expect(label).toBe("Figma (desktop app)");
  expect(figma).toMatchObject({ transport: "http", url: "http://127.0.0.1:3845/mcp", secrets: [], bearer: null, headerSecrets: {} });
  expect(addToolTo(store, repo, figma, "Figma (desktop app), connected on this computer", "alex", T0, { home: dir })).toMatchObject({ ok: true, spec: { name: "figma-desktop", url: "http://127.0.0.1:3845/mcp" } });
  expect(connectionsOf(store, repo).find(one => one.id === "figma-desktop")?.state).toBe("connected");
});

test("the desktop app's test says plainly when Figma isn't running or its server is off", async () => {
  const { label: _label, ...figma } = catalogTool("figma-desktop")!;
  const refused = vi.fn(async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3845"), { code: "ECONNREFUSED" }) }); });
  vi.stubGlobal("fetch", refused);
  try {
    expect(await testTool(figma, {})).toEqual({ ok: false, problem: "The Figma desktop app isn't running, or its Dev Mode MCP server is off. Open Figma and turn the server on in Preferences." });
    expect(refused).toHaveBeenCalledWith("http://127.0.0.1:3845/mcp", expect.anything());
    // Any other unreachable tool keeps the general words.
    expect(await testTool({ ...figma, name: "mine", url: "http://127.0.0.1:3846/mcp" }, {})).toEqual({ ok: false, problem: "It could not be reached." });
  } finally {
    vi.unstubAllGlobals();
  }
});

/**
 * Registration answers as recorded (no live calls): the dry check before a
 * service is listed. Every listed service must have one that accepts; one
 * that refuses (Figma: 403 for any app it hasn't approved) can't be listed.
 */
const REGISTRATION: Readonly<Record<string, number>> = {
  ...Object.fromEntries(ONE_CLICK.map(one => [one.id, 201])),
  figma: 403,
};

/** A service's sign-in replayed at a stand-in address on this computer: discovery, then its recorded registration answer. */
function replayed(id: string) {
  const origin = "http://127.0.0.1:5123", reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${origin}/mcp` && init?.method === "POST") return reply(401, {}, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
    if (url === `${origin}/.well-known/oauth-protected-resource`) return reply(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url === `${origin}/.well-known/oauth-authorization-server`) return reply(200, { authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` });
    if (url === `${origin}/register`) return REGISTRATION[id]! < 300 ? reply(REGISTRATION[id]!, { client_id: `${id}-client` }) : new Response("Forbidden", { status: REGISTRATION[id]! });
    return reply(404, {});
  }) as typeof fetch;
}

test("a one-click service is listed only when its recorded registration accepts Toolroll; a refusal says so plainly, with the alternative", async () => {
  for (const service of ONE_CLICK) expect(REGISTRATION[service.id], `${service.id} has no recorded registration answer`).toBe(201);
  for (const [id, status] of Object.entries(REGISTRATION)) if (status >= 400) expect(ONE_CLICK.map(one => one.id)).not.toContain(id);
  for (const id of Object.keys(REGISTRATION)) {
    vi.stubEnv("STANDING_ORDERS_TEST_CONNECT", `${id}|${ONE_CLICK.find(one => one.id === id)?.label ?? "Figma"}|http://127.0.0.1:5123/mcp`);
    try {
      const started = await startConnect({ service: id, repo, by: "alex", origin: "http://127.0.0.1:4180" }, replayed(id), T0.getTime());
      if (id === "figma") expect(started).toEqual({ ok: false, said: "Figma doesn't let other apps sign in this way yet. Connect Figma (desktop app) instead." });
      else expect(started, id).toMatchObject({ ok: true, visit: { clientId: `${id}-client` } });
    } finally {
      vi.unstubAllEnvs();
    }
  }
  // 401 reads the same; a service with no alternative just says it.
  vi.stubEnv("STANDING_ORDERS_TEST_CONNECT", "zapier|Zapier|http://127.0.0.1:5123/mcp");
  try {
    const refusing = (async (input: string | URL | Request, init?: RequestInit) => String(input).endsWith("/register") ? new Response("", { status: 401 }) : replayed("zapier")(input, init)) as typeof fetch;
    expect(await startConnect({ service: "zapier", repo, by: "alex", origin: "http://127.0.0.1:4180" }, refusing, T0.getTime())).toEqual({ ok: false, said: "Zapier doesn't let other apps sign in this way yet." });
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a sign-in on another origin is found through the server's resource metadata (Mobbin's Supabase auth)", async () => {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const asked: string[] = [];
  const auth = "https://abcd.supabase.co/auth/v1";
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    if (url === "https://api.mobbin.com/mcp" && init?.method === "POST") return reply(401, {}, { "www-authenticate": 'Bearer resource_metadata="https://api.mobbin.com/.well-known/oauth-protected-resource/mcp"' });
    if (url === "https://api.mobbin.com/.well-known/oauth-protected-resource/mcp") return reply(200, { resource: "https://api.mobbin.com/mcp", authorization_servers: [auth], scopes_supported: ["openid", "email"] });
    if (url === "https://abcd.supabase.co/.well-known/oauth-authorization-server/auth/v1") return reply(200, { issuer: auth, authorization_endpoint: `${auth}/oauth/authorize`, token_endpoint: `${auth}/oauth/token`,
      registration_endpoint: `${auth}/oauth/clients/register`, code_challenge_methods_supported: ["S256"] });
    return reply(404, {});
  }) as typeof fetch;
  expect(await discoverSignIn("https://api.mobbin.com/mcp", fetcher)).toEqual({ authorize: `${auth}/oauth/authorize`, token: `${auth}/oauth/token`, register: `${auth}/oauth/clients/register`,
    scopes: ["openid", "email"], resource: "https://api.mobbin.com/mcp" });
  expect(asked.some(one => one.startsWith("https://api.mobbin.com/.well-known/oauth-authorization-server"))).toBe(false);
  // An auth server that only answers OpenID's form under its own path is found too.
  const oidc = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://abcd.supabase.co/.well-known/oauth-authorization-server/auth/v1") return reply(404, {});
    if (url === `${auth}/.well-known/openid-configuration`) return reply(200, { authorization_endpoint: `${auth}/oauth/authorize`, token_endpoint: `${auth}/oauth/token`, registration_endpoint: `${auth}/oauth/clients/register` });
    return fetcher(input, init);
  }) as typeof fetch;
  expect((await discoverSignIn("https://api.mobbin.com/mcp", oidc))?.register).toBe(`${auth}/oauth/clients/register`);
  // Connect sends the person to that other origin, for Mobbin's resource.
  const started = await startConnect({ service: "mobbin", repo, by: "alex", origin: "http://127.0.0.1:4180" }, (async (input: string | URL | Request, init?: RequestInit) =>
    String(input) === `${auth}/oauth/clients/register` ? reply(201, { client_id: "mobbin-client" }) : fetcher(input, init)) as typeof fetch, T0.getTime());
  if (!started.ok) throw new Error(started.said);
  expect(new URL(started.go).origin).toBe("https://abcd.supabase.co");
  expect(started.visit).toMatchObject({ clientId: "mobbin-client", token: `${auth}/oauth/token`, resource: "https://api.mobbin.com/mcp" });
});

test("research gets only the read-only actions of services signed in, and nothing of the rest", () => {
  const connect = (id: string, tools: string[]) => {
    expect(addToolTo(store, repo, connectedSpec(id)!, "connected by signing in", "alex", T0, { home: dir })).toMatchObject({ ok: true });
    store.recordProjectToolTest(repo, id, JSON.stringify({ at: T0.toISOString(), ok: true, tools, problem: null }));
  };
  expect(researchToolsOf(projectToolsOf(store, repo))).toEqual({ services: [], allowed: [], reads: {}, local: [] });
  connect("mobbin", ["search_screens", "search_flows", "save_to_collection", "searchApps", "search_and_save_screens"]);
  // Figma's desktop app: added with no key, read-only by what its last test listed.
  const { label: _figma, ...figma } = catalogTool("figma-desktop")!;
  addToolTo(store, repo, figma, "Figma (desktop app), connected on this computer", "alex", T0, { home: dir });
  store.recordProjectToolTest(repo, "figma-desktop", JSON.stringify({ at: T0.toISOString(), ok: true, problem: null,
    tools: ["get_code", "get_image", "get_variable_defs", "get_metadata", "get_screenshot", "get_code_connect_map", "create_design_system_rules", "add_code_connect_map", "generate_figma_design"] }));
  connect("posthog", ["query-run", "insights-get-all", "insight-get", "insight-create-from-query", "insight-update", "insight-delete", "event-definitions-list", "feature-flag-get-all", "create-feature-flag", "switch-project"]);
  connect("betterstack", ["uptime_list_monitors", "uptime_get_incident", "uptime_acknowledge_incident", "uptime_resolve_incident", "uptime_create_monitor", "uptime_pause_monitor", "telemetry_query"]);
  // Stripe is connected too, but names no reads: research never gets it.
  connect("stripe", ["list_customers", "create_refund"]);
  const { label: _label, ...sentry } = catalogTool("sentry")!;
  addToolTo(store, repo, sentry, "the common tools list", "alex", T0, { home: dir });
  const research = researchToolsOf(projectToolsOf(store, repo));
  expect(research.services.map(one => one.id)).toEqual(["mobbin", "posthog", "betterstack", "figma-desktop"]);
  expect(research.allowed).toEqual([
    "mcp__mobbin__search_screens", "mcp__mobbin__search_flows", "mcp__mobbin__searchApps",
    "mcp__posthog__query-run", "mcp__posthog__insights-get-all", "mcp__posthog__insight-get", "mcp__posthog__event-definitions-list",
    "mcp__betterstack__uptime_list_monitors", "mcp__betterstack__uptime_get_incident",
    "mcp__figma-desktop__get_code", "mcp__figma-desktop__get_image", "mcp__figma-desktop__get_variable_defs", "mcp__figma-desktop__get_metadata", "mcp__figma-desktop__get_screenshot", "mcp__figma-desktop__get_code_connect_map",
  ]);
  expect(research.reads).toEqual({
    mobbin: ["search_screens", "search_flows", "searchApps"],
    posthog: ["query-run", "insights-get-all", "insight-get", "event-definitions-list"],
    betterstack: ["uptime_list_monitors", "uptime_get_incident"],
    "figma-desktop": ["get_code", "get_image", "get_variable_defs", "get_metadata", "get_screenshot", "get_code_connect_map"],
  });
  // Its one loopback address is the only one research reaches directly, past its proxy.
  expect(research.local).toEqual(["127.0.0.1:3845"]);
  expect(scoutProxyEnv("http://127.0.0.1:7000", "http://127.0.0.1:7001/mcp", research.local)).toMatchObject({ NO_PROXY: "127.0.0.1:7001,127.0.0.1:3845", no_proxy: "127.0.0.1:7001,127.0.0.1:3845" });
  expect(scoutProxyEnv("http://127.0.0.1:7000")).not.toHaveProperty("NO_PROXY");
  // Left out of this run (not launched), a service gives nothing.
  expect(researchToolsOf(projectToolsOf(store, repo), new Set(["figma-desktop"])).allowed.every(one => one.startsWith("mcp__figma-desktop__"))).toBe(true);
  expect(researchToolsOf(projectToolsOf(store, repo), new Set(["mobbin"])).local).toEqual([]);
  // A failed test lists nothing to read.
  store.recordProjectToolTest(repo, "mobbin", JSON.stringify({ at: T0.toISOString(), ok: false, tools: [], problem: "signed out" }));
  expect(researchToolsOf(projectToolsOf(store, repo)).services.map(one => one.id)).not.toContain("mobbin");
  // A tool named figma-desktop at another address isn't the desktop app: research reads nothing of it.
  removeToolFrom(store, repo, "figma-desktop", "alex", T0, dir);
  addToolTo(store, repo, { ...figma, url: "http://127.0.0.1:9999/mcp" }, "added by hand", "alex", T0, { home: dir });
  store.recordProjectToolTest(repo, "figma-desktop", JSON.stringify({ at: T0.toISOString(), ok: true, tools: ["get_code"], problem: null }));
  expect(researchToolsOf(projectToolsOf(store, repo)).services.map(one => one.id)).not.toContain("figma-desktop");
});

test("read-only is an allow-list of reading verbs: any word nobody listed withholds the action", () => {
  const frames = ["frame", "image", "file"];
  for (const action of ["get_frame", "listFiles", "search-images", "find_frame_by_id", "read_file", "query_frames", "describe_image", "fetch_file", "view_frame", "export_image", "frames-export-images"]) {
    expect(readsOnly(action, frames), action).toBe(true);
  }
  for (const action of ["frame", "export_frame", "get_frame_and_rename", "sync_frames", "run_file", "get_frame_comments", "frame_get_then_post", "get frame", ""]) {
    expect(readsOnly(action, frames), action).toBe(false);
  }
  // A reading verb inside another action's name never makes it a read.
  expect(readsOnly("insight-create-from-query", ["insight"])).toBe(false);
});

test("a research launch gets only connected services' read-only actions: Codex enables just those per server, and the rest are left out", () => {
  const ids = ["mobbin", "posthog", "stripe"];
  for (const id of ids) {
    expect(addToolTo(store, repo, connectedSpec(id)!, "connected by signing in", "alex", T0, { home: dir })).toMatchObject({ ok: true });
    setToolSecrets(repo, id, { OAUTH_ACCESS_TOKEN: "access" }, dir);
  }
  let recorded = "";
  const runs = {
    projectTools: (one: string) => store.projectTools(one), orgPolicy: () => store.orgPolicy(),
    getRun: () => ({ taskRef: 1 }), refById: () => ({ repo, externalId: "research" }), getScope: () => null, toolSealFor: () => null,
    recordRunTools: (_run: number, json: string) => { recorded = json; },
  } as unknown as Parameters<typeof prepareRunTools>[0];
  const readOnly = { mobbin: ["search_screens", "search_flows"], posthog: [] };
  const launched = prepareRunTools(runs, 7, "codex", { home: dir, now: T0, includeModel: false, readOnly });
  try {
    const argv = launched.argv.join(" ");
    expect(argv).toContain('mcp_servers.mobbin.enabled_tools=["search_screens","search_flows"]');
    expect(argv).not.toContain("mcp_servers.posthog.");
    expect(argv).not.toContain("mcp_servers.stripe.");
    expect(JSON.parse(recorded)).toMatchObject({ tools: [{ name: "mobbin" }], skipped: [
      { name: "posthog", reason: "research reads only connected services' read-only actions" },
      { name: "stripe", reason: "research reads only connected services' read-only actions" },
    ] });
  } finally {
    launched.cleanup();
  }
  // Nothing readable: no project server at all.
  const none = prepareRunTools(runs, 7, "codex", { home: dir, now: T0, includeModel: false, readOnly: {} });
  expect(none.argv.join(" ")).not.toContain("mcp_servers.");
  none.cleanup();
  // A build is not limited: every server, every action.
  const build = prepareRunTools(runs, 7, "codex", { home: dir, now: T0, includeModel: false });
  try {
    expect(ids.every(id => build.argv.join(" ").includes(`mcp_servers.${id}.command`))).toBe(true);
    expect(build.argv.join(" ")).not.toContain("enabled_tools");
  } finally {
    build.cleanup();
  }
});

test("the gallery's research tools read only: Sentry, Cloudflare, Vercel, Intercom and Linear keep their reads and withhold every write", () => {
  // Action names as each service's MCP server lists them.
  const services: Record<string, { reads: string[]; writes: string[] }> = {
    sentry: { reads: ["find_organizations", "find_projects", "find_issues", "get_issue_details", "search_events", "search_issues", "get_trace_details", "find_releases", "get_event_attachment"],
      writes: ["update_issue", "create_project", "create_team", "create_dsn", "update_project", "analyze_issue_with_seer", "find_dsns"] },
    cloudflare: { reads: ["accounts_list", "workers_list", "workers_get_worker", "query_worker_observability", "search"],
      writes: ["execute", "set_active_account", "workers_get_worker_code_and_deploy", "kv_namespace_create", "d1_database_query"] },
    vercel: { reads: ["list_teams", "list_projects", "get_project", "list_deployments", "get_deployment", "get_deployment_build_logs", "search_vercel_documentation"],
      writes: ["deploy_to_vercel", "get_access_to_vercel_url", "web_fetch_vercel_url", "buy_domain", "check_domain_availability_and_price"] },
    intercom: { reads: ["search", "fetch", "search_conversations", "get_conversation", "search_contacts", "get_contact"],
      writes: ["reply_to_conversation", "close_conversation", "create_contact", "update_contact", "assign_conversation"] },
    linear: { reads: ["list_issues", "get_issue", "list_comments", "list_teams", "list_issue_statuses", "get_user", "list_cycles", "list_projects"],
      writes: ["create_comment", "create_issue", "update_issue", "create_project", "update_project", "create_issue_label"] },
  };
  for (const [id, { reads, writes }] of Object.entries(services)) {
    const subjects = ONE_CLICK.find(one => one.id === id)!.reads!;
    for (const action of reads) expect(readsOnly(action, subjects), `${id} ${action}`).toBe(true);
    for (const action of writes) expect(readsOnly(action, subjects), `${id} ${action}`).toBe(false);
    expect(addToolTo(store, repo, connectedSpec(id)!, "connected by signing in", "alex", T0, { home: dir })).toMatchObject({ ok: true });
    store.recordProjectToolTest(repo, id, JSON.stringify({ at: T0.toISOString(), ok: true, tools: [...reads, ...writes], problem: null }));
  }
  // A research launch gets exactly the reads, by server.
  expect(researchToolsOf(projectToolsOf(store, repo)).reads).toEqual(Object.fromEntries(Object.entries(services).map(([id, one]) => [id, one.reads])));
});

test("a build gets the project's Figma desktop app with every action", () => {
  const { label: _label, ...figma } = catalogTool("figma-desktop")!;
  expect(addToolTo(store, repo, figma, "Figma (desktop app), connected on this computer", "alex", T0, { home: dir })).toMatchObject({ ok: true });
  let recorded = "";
  const runs = {
    projectTools: (one: string) => store.projectTools(one), orgPolicy: () => store.orgPolicy(),
    getRun: () => ({ taskRef: 1 }), refById: () => ({ repo, externalId: "figma-frame" }), getScope: () => null, toolSealFor: () => null,
    recordRunTools: (_run: number, json: string) => { recorded = json; },
  } as unknown as Parameters<typeof prepareRunTools>[0];
  for (const provider of ["claude", "codex"] as const) {
    const build = prepareRunTools(runs, 9, provider, { home: dir, now: T0, includeModel: false });
    try {
      expect(JSON.parse(recorded), provider).toMatchObject({ tools: [{ name: "figma-desktop" }], skipped: [] });
      if (provider === "codex") expect(build.argv.join(" ")).toContain("figma-desktop");
      expect(build.argv.join(" "), provider).not.toContain("enabled_tools");
    } finally {
      build.cleanup();
    }
  }
});
