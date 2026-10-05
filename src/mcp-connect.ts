/**
 * One-click connections: services whose MCP servers let an app register
 * itself (OAuth dynamic client registration, with PKCE), so connecting one is
 * a sign-in and nothing else: no developer app to create, no key to paste.
 *
 * Connect finds the server's sign-in (its protected-resource metadata, or the
 * authorization server at its origin), registers Toolroll as a client
 * with this console's callback, and sends the person to the service to sign
 * in. The callback trades the code for tokens, which live in the tool's own
 * secrets file (never the database, never a log), and the tool joins the
 * project like any other: tested, listed, and given to teammates under rules.
 * The worker refreshes tokens before they expire.
 */
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import { LOCAL_APPS, addToolTo, catalogTool, localAppOf, projectToolsOf, readToolSecrets, setToolSecrets, testToolOf, type ProjectTool, type ToolSpec } from "./project-tools.js";
import type { Store } from "./store.js";
import { envValue } from "./names.js";

/**
 * A one-click service. `reads` names what a research step may read there:
 * an action is read-only only when it is named by a reading verb (READING)
 * and every other word in its name is one of these.
 */
export type OneClick = { id: string; label: string; url: string; about: string; reads?: readonly string[] };

/**
 * Services that connect this way: their servers speak streamable HTTP and
 * advertise registering clients on the spot. Advertising isn't accepting:
 * Figma's server advertises it, but its registration answers 403 to any app
 * Figma hasn't approved, so Figma connects through its desktop app instead
 * (LOCAL_APPS). A service is listed only when its registration accepts
 * Toolroll; mcp-connect.test.ts replays each one's answer (no live calls).
 *
 * Signed in end to end, live: Mobbin. The rest register in replayed checks
 * only, until someone signs in to each for real.
 */
export const ONE_CLICK: readonly OneClick[] = [
  { id: "stripe", label: "Stripe", url: "https://mcp.stripe.com/", about: "Payments, customers, refunds and invoices." },
  { id: "notion", label: "Notion", url: "https://mcp.notion.com/mcp", about: "Pages and databases: search, read and write." },
  { id: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", about: "Issues, projects and comments.",
    reads: ["issue", "project", "team", "comment", "label", "cycle", "document", "status", "statuses", "user"] },
  { id: "sentry", label: "Sentry", url: "https://mcp.sentry.dev/mcp", about: "Errors and issues, with their stack traces.",
    reads: ["organization", "project", "issue", "detail", "details", "event", "trace", "release", "tag", "attachment"] },
  { id: "atlassian", label: "Jira and Confluence", url: "https://mcp.atlassian.com/v1/mcp", about: "Jira issues and Confluence pages." },
  { id: "intercom", label: "Intercom", url: "https://mcp.intercom.com/mcp", about: "Customer conversations and contacts.",
    reads: ["conversation", "contact"] },
  { id: "attio", label: "Attio", url: "https://mcp.attio.com/mcp", about: "Your CRM: people, companies, deals and notes." },
  { id: "zapier", label: "Zapier", url: "https://mcp.zapier.com/api/mcp/mcp", about: "Thousands of apps, through the actions you choose in Zapier." },
  { id: "square", label: "Square", url: "https://mcp.squareup.com/mcp", about: "Payments, orders, customers and catalog." },
  { id: "paypal", label: "PayPal", url: "https://mcp.paypal.com/mcp", about: "Payments, invoices and disputes." },
  { id: "klaviyo", label: "Klaviyo", url: "https://mcp.klaviyo.com/mcp", about: "Email and SMS lists, campaigns and profiles." },
  { id: "webflow", label: "Webflow", url: "https://mcp.webflow.com/mcp", about: "Sites, pages and CMS items." },
  { id: "wix", label: "Wix", url: "https://mcp.wix.com/mcp", about: "Your Wix site, store and bookings." },
  { id: "canva", label: "Canva", url: "https://mcp.canva.com/mcp", about: "Designs: search, create and export." },
  { id: "vercel", label: "Vercel", url: "https://mcp.vercel.com/", about: "Projects, deployments and logs.",
    reads: ["team", "project", "deployment", "build", "runtime", "log", "logs", "vercel", "documentation"] },
  { id: "cloudflare", label: "Cloudflare", url: "https://mcp.cloudflare.com/mcp", about: "Workers, DNS and your Cloudflare account.",
    reads: ["account", "worker", "workers", "observability", "analytics", "log", "logs", "page", "pages", "project", "deployment"] },
  // Mobbin's sign-in is its Supabase auth server, on another origin: its protected-resource metadata names it.
  { id: "mobbin", label: "Mobbin", url: "https://api.mobbin.com/mcp", about: "Real app screens and flows to learn from.",
    reads: ["screen", "flow", "app", "site", "element", "pattern", "ui", "ios", "android", "web"] },
  { id: "posthog", label: "PostHog", url: "https://mcp.posthog.com/mcp", about: "Product analytics, funnels and events.",
    reads: ["insight", "run", "event", "definition", "property", "properties"] },
  { id: "betterstack", label: "Better Stack", url: "https://mcp.betterstack.com", about: "Uptime checks and incidents.",
    reads: ["uptime", "monitor", "incident", "availability", "response", "time"] },
];
const loopback = (value: string) => { try { const url = new URL(value); return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname); } catch { return false; } };
/**
 * The list, with one service standing in on this computer when the person
 * running Toolroll says so ("stripe|Stripe|http://127.0.0.1:5123/mcp"
 * in TOOLROLL_TEST_CONNECT): how the end-to-end check signs in for
 * real without a real account. Only a loopback address is taken.
 */
export function oneClickServices(environment: NodeJS.ProcessEnv = process.env): typeof ONE_CLICK {
  const [id = "", label = "", url = ""] = (envValue(environment, "TEST_CONNECT") ?? "").split("|");
  if (!/^[a-z0-9-]{1,40}$/.test(id) || label === "" || !loopback(url)) return ONE_CLICK;
  const known = ONE_CLICK.find(one => one.id === id);
  const standIn: OneClick = { id, label, url, about: known?.about ?? "A service on this computer.", ...(known?.reads === undefined ? {} : { reads: known.reads }) };
  return ONE_CLICK.some(one => one.id === id) ? ONE_CLICK.map(one => one.id === id ? standIn : one) : [...ONE_CLICK, standIn];
}
export const oneClickOf = (id: string) => oneClickServices().find(one => one.id === id) ?? null;

/** What to use when a service won't let Toolroll sign in by itself. */
const INSTEAD: Readonly<Record<string, string>> = { figma: "Connect Figma (desktop app) instead." };

/** An app on this computer that Connect adds without a sign-in (LOCAL_APPS): its tool, name and one line of how. */
export const localConnectOf = (id: string): { id: string; label: string; about: string } | null => {
  const app = LOCAL_APPS.find(one => one.tool === id), tool = catalogTool(id);
  return app === undefined || tool === null ? null : { id, label: tool.label, about: app.connect };
};

/** Where each service stands in a project: connected, open to connect, or its name taken by a tool set up another way. `local` connects with no sign-in. */
export function connectionsOf(store: Store, repo: string): { id: string; label: string; about: string; state: "connected" | "open" | "taken"; local?: true }[] {
  const tools = projectToolsOf(store, repo);
  const signIn = oneClickServices().map(service => {
    const had = tools.find(one => one.name === service.id);
    return { id: service.id, label: service.label, about: service.about, state: had === undefined ? "open" as const : had.spec.url === service.url && had.spec.bearer === ACCESS ? "connected" as const : "taken" as const };
  });
  const local = LOCAL_APPS.flatMap(app => {
    const one = localConnectOf(app.tool);
    if (one === null) return [];
    const had = tools.find(tool => tool.name === one.id);
    return [{ ...one, state: had === undefined ? "open" as const : localAppOf(had.spec) !== null ? "connected" as const : "taken" as const, local: true as const }];
  });
  return [...signIn, ...local];
}

/** The verbs that only read. An action named by anything else is withheld from research. */
const READING = new Set(["list", "get", "search", "find", "read", "query", "describe", "fetch", "view", "export-image"]);
/** Words that only qualify what is read ("insights-get-all", "get_by_id"). */
const QUALIFIERS = new Set(["all", "by", "id", "ids"]);

/**
 * Whether an action only reads: its name has a reading verb, and every other
 * word is a reading verb, a qualifier or something this service lets
 * research read. An allow-list: a word nobody listed withholds the action.
 */
export function readsOnly(action: string, subjects: readonly string[]): boolean {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(action)) return false;
  const words = action.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(word => word !== "")
    .join(" ").replace(/\bexport images?\b/g, "export-image").split(" ");
  const subject = (word: string) => subjects.includes(word) || subjects.includes(word.replace(/s$/, ""));
  return words.some(word => READING.has(word)) && words.every(word => READING.has(word) || QUALIFIERS.has(word) || subject(word));
}

/**
 * What a research step may use of a project's connected services: each
 * signed-in service's read-only actions, as its last test listed them —
 * by server (`reads`, for Codex's `enabled_tools`) and named the way Claude
 * allows them (`mcp__<service>__<action>`). `local` is the loopback host of
 * each app on this computer it reads (its proxy lets only those through). A service not connected, without
 * read-only actions, or left out of this run (`launched`) gives nothing.
 */
export type ResearchTools = { services: { id: string; label: string }[]; allowed: string[]; reads: Record<string, string[]>; local: string[] };
export function researchToolsOf(tools: readonly ProjectTool[], launched: ReadonlySet<string> | null = null): ResearchTools {
  const research: ResearchTools = { services: [], allowed: [], reads: {}, local: [] };
  // Signed-in services, then apps on this computer (each exactly as listed: its own address, no key).
  const readable = [
    ...oneClickServices().map(service => ({ id: service.id, label: service.label, reads: service.reads, is: (spec: ToolSpec) => spec.url === service.url && spec.bearer === ACCESS })),
    ...LOCAL_APPS.map(app => ({ id: app.tool, label: catalogTool(app.tool)?.label ?? app.tool, reads: app.reads, is: (spec: ToolSpec) => localAppOf(spec) === app })),
  ];
  for (const service of readable) {
    const tool = tools.find(one => one.name === service.id);
    if (service.reads === undefined || tool === undefined || !service.is(tool.spec) || (launched !== null && !launched.has(tool.name))) continue;
    const reads = (tool.lastTest?.ok ? tool.lastTest.tools : []).filter(action => readsOnly(action, service.reads!));
    if (reads.length === 0) continue;
    research.services.push({ id: service.id, label: service.label });
    research.allowed.push(...reads.map(action => `mcp__${service.id}__${action}`));
    research.reads[service.id] = reads;
    if (localAppOf(tool.spec) !== null) research.local.push(new URL(tool.spec.url!).host);
  }
  return research;
}

/** The secrets a connected tool keeps: the bearer the MCP server takes, and what refreshing it needs. */
const ACCESS = "OAUTH_ACCESS_TOKEN", REFRESH = "OAUTH_REFRESH_TOKEN", CLIENT = "OAUTH_CLIENT_ID", CLIENT_SECRET = "OAUTH_CLIENT_SECRET", TOKEN_URL = "OAUTH_TOKEN_URL", EXPIRES = "OAUTH_EXPIRES_AT", RESOURCE = "OAUTH_RESOURCE";
/** Where a service sends the person back after they sign in. */
export const CONNECT_CALLBACK = "/settings/tools/connected";
const VISIT_MS = 15 * 60_000, RENEW_RETRY_MS = 5 * 60_000;
const renewTried = new Map<string, number>();

type Fetch = typeof fetch;
type Server = { authorize: string; token: string; register: string; scopes: string[]; resource: string | null };
/** RFC 6749 scope tokens; and the most scope text a sign-in address carries (addresses stay well under 8 KB). */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;
const SCOPE_PARAM_LIMIT = 6_000;
/** A sign-in on its way: what the callback needs to finish it (kept in the console's memory, 15 minutes). `kit` or `template` is the page it returns to. */
export type ConnectVisit = { service: string; repo: string; by: string; kit: string | null; template: string | null; verifier: string; clientId: string; clientSecret: string | null; token: string; resource: string; redirect: string; expires: number };

const json = async (fetcher: Fetch, url: string): Promise<Record<string, unknown> | null> => {
  try {
    const answer = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!answer.ok) return null;
    const body = await answer.json() as unknown;
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
};
const secure = (value: string) => { try { return new URL(value).protocol === "https:"; } catch { return false; } };

/** A server's sign-in: the resource metadata its 401 names (or the well-known one), then its authorization server's metadata. */
export async function discoverSignIn(mcpUrl: string, fetcher: Fetch = fetch): Promise<Server | null> {
  const mcp = new URL(mcpUrl);
  // Sign-in addresses are https, except a stand-in on this computer whose own sign-in is here too (OAuth's loopback exception).
  const https = (value: unknown): value is string => typeof value === "string" && (secure(value) || (loopback(mcpUrl) && loopback(value)));
  let pointer: string | null = null;
  try {
    const probe = await fetcher(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "toolroll", version: "1" } } }), signal: AbortSignal.timeout(10_000) });
    pointer = /resource_metadata="([^"]+)"/.exec(probe.headers.get("www-authenticate") ?? "")?.[1] ?? null;
    await probe.body?.cancel();
  } catch { pointer = null; }
  const resource = (pointer !== null && https(pointer) ? await json(fetcher, pointer) : null)
    ?? await json(fetcher, `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname === "/" ? "" : mcp.pathname}`)
    ?? await json(fetcher, `${mcp.origin}/.well-known/oauth-protected-resource`);
  const issuers = Array.isArray(resource?.["authorization_servers"]) ? (resource!["authorization_servers"] as unknown[]).filter(https) : [];
  const issuer = new URL(issuers[0] ?? mcp.origin);
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const meta = await json(fetcher, `${issuer.origin}/.well-known/oauth-authorization-server${path}`)
    ?? await json(fetcher, `${issuer.origin}/.well-known/oauth-authorization-server`)
    ?? (path === "" ? null : await json(fetcher, `${issuer.origin}${path}/.well-known/openid-configuration`))
    ?? await json(fetcher, `${issuer.origin}/.well-known/openid-configuration`);
  if (meta === null || !https(meta["authorization_endpoint"]) || !https(meta["token_endpoint"]) || !https(meta["registration_endpoint"])) return null;
  const methods = Array.isArray(meta["code_challenge_methods_supported"]) ? meta["code_challenge_methods_supported"] as unknown[] : ["S256"];
  if (!methods.includes("S256")) return null;
  // Ask for every scope the server lists for this resource: a token missing one the server itself requires is
  // refused after a successful sign-in (PostHog lists 155 and needs user:read, the 140th). Only well-formed scope
  // tokens, and at most what fits a sign-in address.
  const listed = Array.isArray(resource?.["scopes_supported"]) ? (resource!["scopes_supported"] as unknown[]).filter((one): one is string => typeof one === "string" && SCOPE_TOKEN.test(one)) : [];
  const scopes: string[] = [];
  for (const one of listed) { if (scopes.join(" ").length + one.length + 1 > SCOPE_PARAM_LIMIT) break; scopes.push(one); }
  // A token is for the resource the server names (Stripe's has no trailing slash), when it names one.
  const named = resource?.["resource"];
  return { authorize: meta["authorization_endpoint"] as string, token: meta["token_endpoint"] as string, register: meta["registration_endpoint"] as string, scopes, resource: https(named) ? named : null };
}

/**
 * Start connecting a service: find its sign-in, register this console as a
 * client, and hand back the address to send the person to (and the visit the
 * callback finishes). The person's password was checked before this.
 */
export async function startConnect(input: { service: string; repo: string; by: string; origin: string; kit?: string | null; template?: string | null }, fetcher: Fetch = fetch, now = Date.now()): Promise<{ ok: true; go: string; state: string; visit: ConnectVisit } | { ok: false; said: string }> {
  const service = oneClickOf(input.service);
  if (service === null) return { ok: false, said: "Choose a service from the list." };
  const server = await discoverSignIn(service.url, fetcher);
  if (server === null) return { ok: false, said: `${service.label} didn't offer a sign-in just now. Try again in a minute.` };
  const redirect = `${input.origin}${CONNECT_CALLBACK}`;
  let clientId: string, clientSecret: string | null;
  try {
    const registered = await fetcher(server.register, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ client_name: "Toolroll", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
    // Figma's answer (Oct 2026): it registers only apps it has approved. Said before reading a body that may not be JSON.
    if (registered.status === 401 || registered.status === 403) return { ok: false, said: `${service.label} doesn't let other apps sign in this way yet.${INSTEAD[service.id] === undefined ? "" : ` ${INSTEAD[service.id]}`}` };
    const body = await registered.json() as { client_id?: unknown; client_secret?: unknown };
    if (!registered.ok || typeof body.client_id !== "string") return { ok: false, said: `${service.label} didn't let Toolroll register (HTTP ${registered.status}).` };
    clientId = body.client_id;
    clientSecret = typeof body.client_secret === "string" ? body.client_secret : null;
  } catch {
    return { ok: false, said: `${service.label} couldn't be reached.` };
  }
  const resource = server.resource ?? service.url;
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const go = new URL(server.authorize);
  go.searchParams.set("response_type", "code");
  go.searchParams.set("client_id", clientId);
  go.searchParams.set("redirect_uri", redirect);
  go.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  go.searchParams.set("code_challenge_method", "S256");
  go.searchParams.set("state", state);
  go.searchParams.set("resource", resource);
  if (server.scopes.length > 0) go.searchParams.set("scope", server.scopes.join(" "));
  return { ok: true, go: go.toString(), state, visit: { service: service.id, repo: input.repo, by: input.by, kit: input.kit ?? null, template: input.template ?? null, verifier, clientId, clientSecret, token: server.token, resource, redirect, expires: now + VISIT_MS } };
}

/** The spec a connected service joins the project with: its MCP address, signed in with the token its sign-in gave. */
export function connectedSpec(serviceId: string): ToolSpec | null {
  const service = oneClickOf(serviceId);
  if (service === null) return null;
  return { name: service.id, transport: "http", command: null, args: [], url: service.url, bearer: ACCESS, headerSecrets: {},
    secrets: [ACCESS, REFRESH, CLIENT, CLIENT_SECRET, TOKEN_URL, EXPIRES, RESOURCE].map(name => ({ name, optional: name !== ACCESS })), about: `${service.label}: ${service.about} Connected by signing in.` };
}

const tokensFrom = (body: Record<string, unknown>, now: number) => ({
  access: typeof body["access_token"] === "string" ? body["access_token"] : null,
  refresh: typeof body["refresh_token"] === "string" ? body["refresh_token"] : null,
  expires: typeof body["expires_in"] === "number" && body["expires_in"] > 0 ? new Date(now + body["expires_in"] * 1000).toISOString() : null,
});

/**
 * Finish connecting: trade the code for tokens, add the tool to the project
 * (or refresh its sign-in, when it's there already), keep the tokens in its
 * secrets file, and test it.
 */
export async function finishConnect(store: Store, visit: ConnectVisit, code: string, now: Date, options: { fetcher?: Fetch; home?: string; test?: boolean; omitEnv?: readonly string[] } = {}): Promise<{ ok: true; said: string } | { ok: false; said: string }> {
  const service = oneClickOf(visit.service)!;
  const fetcher = options.fetcher ?? fetch, home = options.home ?? homedir();
  const spec = connectedSpec(service.id)!;
  const had = projectToolsOf(store, visit.repo).find(one => one.name === spec.name);
  if (had !== undefined && (had.spec.url !== spec.url || had.spec.bearer !== ACCESS)) return { ok: false, said: `This project already has a tool called ${spec.name}, set up another way. Remove it on this page to connect ${service.label} by signing in.` };
  let body: Record<string, unknown>;
  try {
    const answer = await fetcher(visit.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: visit.redirect, client_id: visit.clientId, code_verifier: visit.verifier, resource: visit.resource, ...(visit.clientSecret === null ? {} : { client_secret: visit.clientSecret }) }) });
    body = await answer.json() as Record<string, unknown>;
    if (!answer.ok) return { ok: false, said: `${service.label} didn't finish the sign-in (${typeof body["error"] === "string" ? body["error"] : `HTTP ${answer.status}`}).` };
  } catch {
    return { ok: false, said: `${service.label} couldn't be reached to finish the sign-in.` };
  }
  const tokens = tokensFrom(body, now.getTime());
  if (tokens.access === null) return { ok: false, said: `${service.label} didn't send a sign-in token.` };
  if (had === undefined) {
    const added = addToolTo(store, visit.repo, spec, `${service.label}, connected by signing in`, visit.by, now, { home });
    if (!added.ok) return { ok: false, said: added.message };
  }
  setToolSecrets(visit.repo, spec.name, { [ACCESS]: tokens.access, [CLIENT]: visit.clientId, [TOKEN_URL]: visit.token, [RESOURCE]: visit.resource,
    ...(tokens.refresh === null ? {} : { [REFRESH]: tokens.refresh }), ...(tokens.expires === null ? {} : { [EXPIRES]: tokens.expires }), ...(visit.clientSecret === null ? {} : { [CLIENT_SECRET]: visit.clientSecret }) }, home);
  // The success line names the project it went to: the page and chat may be looking at another.
  const to = basename(visit.repo);
  if (options.test === false) return { ok: true, said: `${service.label} is connected to ${to}.` };
  const tested = await testToolOf(store, visit.repo, spec.name, now, { home, ...(options.omitEnv === undefined ? {} : { omitEnv: options.omitEnv }) });
  return tested?.ok ? { ok: true, said: `${service.label} is connected to ${to}: ${tested.tools.length} action${tested.tools.length === 1 ? "" : "s"}. Let a teammate use it from its page.` }
    : { ok: true, said: `${service.label} is signed in for ${to}, but its test didn't pass yet: ${tested?.problem ?? "no answer"}.` };
}

/** Keep connected services signed in: any token expiring within ten minutes is refreshed (the worker's pass, and before a teammate's call). */
export async function refreshConnections(store: Store, repos: readonly string[], now: Date, options: { fetcher?: Fetch; home?: string } = {}): Promise<{ refreshed: number; problems: string[] }> {
  const fetcher = options.fetcher ?? fetch, home = options.home ?? homedir();
  const report = { refreshed: 0, problems: [] as string[] };
  for (const repo of repos) for (const tool of projectToolsOf(store, repo)) {
    if (tool.spec.bearer !== ACCESS) continue;
    const values = readToolSecrets(repo, tool.name, home);
    const expires = values[EXPIRES] === undefined ? null : Date.parse(values[EXPIRES]);
    if (expires === null || Number.isNaN(expires) || expires - now.getTime() > 10 * 60_000 || values[REFRESH] === undefined || values[TOKEN_URL] === undefined || values[CLIENT] === undefined) continue;
    // One try every five minutes at most: a sign-in the service has revoked is said once in a while, not every pass.
    const key = `${repo}\0${tool.name}`;
    if (now.getTime() - (renewTried.get(key) ?? 0) < RENEW_RETRY_MS) continue;
    renewTried.set(key, now.getTime());
    try {
      const answer = await fetcher(values[TOKEN_URL], { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, signal: AbortSignal.timeout(15_000),
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: values[REFRESH], client_id: values[CLIENT], ...(values[CLIENT_SECRET] === undefined ? {} : { client_secret: values[CLIENT_SECRET] }), ...(values[RESOURCE] === undefined ? {} : { resource: values[RESOURCE] }) }) });
      const body = await answer.json() as Record<string, unknown>;
      const tokens = tokensFrom(body, now.getTime());
      if (!answer.ok || tokens.access === null) { report.problems.push(`${tool.name}: its sign-in ran out; connect it again on the Tools page`); continue; }
      setToolSecrets(repo, tool.name, { [ACCESS]: tokens.access, ...(tokens.refresh === null ? {} : { [REFRESH]: tokens.refresh }), ...(tokens.expires === null ? {} : { [EXPIRES]: tokens.expires }) }, home);
      renewTried.delete(key);
      report.refreshed++;
    } catch {
      report.problems.push(`${tool.name}: couldn't reach it to renew its sign-in`);
    }
  }
  return report;
}
