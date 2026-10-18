/**
 * Settings → Tools over real HTTP: a Connect goes to the project the page
 * shows (bug, Oct 4: the dropdown moved to standing-orders, Mobbin went to
 * bentoportfolio), names it, refuses a stale post, and a connected service
 * can be connected to another project by signing in there.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { addToolTo, catalogTool, projectToolsOf, setToolSecrets } from "./project-tools.js";
import { connectedSpec } from "./mcp-connect.js";
import { T0 } from "../test/serve-kit.js";

const BENTO = "/repo/bentoportfolio", ORDERS = "/repo/standing-orders";
let store: Store, server: Server, base: string, home: string, token: string;
const signIns: string[] = [];

/** Stripe's sign-in as its servers answer it; each registration is one sign-in started. */
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const stripe = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input), method = init?.method ?? "GET";
  if (url === "https://mcp.stripe.com/" && method === "POST") return reply(401, {}, { "www-authenticate": 'Bearer resource_metadata="https://mcp.stripe.com/.well-known/oauth-protected-resource"' });
  if (url === "https://mcp.stripe.com/.well-known/oauth-protected-resource") return reply(200, { resource: "https://mcp.stripe.com", authorization_servers: ["https://access.stripe.com/mcp"] });
  if (url === "https://access.stripe.com/.well-known/oauth-authorization-server/mcp") return reply(200, { authorization_endpoint: "https://access.stripe.com/mcp/oauth2/authorize", token_endpoint: "https://access.stripe.com/mcp/oauth2/token",
    registration_endpoint: "https://access.stripe.com/mcp/oauth2/register", code_challenge_methods_supported: ["S256"] });
  if (url === "https://access.stripe.com/mcp/oauth2/register") { signIns.push(url); return reply(201, { client_id: "client-7" }); }
  // PostHog's, for Reconnect read-only.
  if (url === "https://mcp.posthog.com/mcp" && method === "POST") return reply(401, {}, { "www-authenticate": 'Bearer resource_metadata="https://mcp.posthog.com/.well-known/oauth-protected-resource/mcp"' });
  if (url === "https://mcp.posthog.com/.well-known/oauth-protected-resource/mcp") return reply(200, { resource: "https://mcp.posthog.com/mcp", authorization_servers: ["https://oauth.posthog.com"], scopes_supported: ["openid", "insight:read", "insight:write", "user:read"] });
  if (url === "https://oauth.posthog.com/.well-known/oauth-authorization-server") return reply(200, { authorization_endpoint: "https://oauth.posthog.com/oauth/authorize/", token_endpoint: "https://oauth.posthog.com/oauth/token/", registration_endpoint: "https://oauth.posthog.com/oauth/register/", code_challenge_methods_supported: ["S256"] });
  if (url === "https://oauth.posthog.com/oauth/register/") { signIns.push(url); return reply(201, { client_id: "posthog-client" }); }
  return reply(404, {});
}) as typeof fetch;

beforeEach(async () => {
  signIns.length = 0;
  home = realpathSync(mkdtempSync(join(tmpdir(), "so-tools-page-")));
  store = openStore(":memory:");
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap failed");
  token = added.token;
  server = createDecisionServer({ store, evidenceRoot: home, clock: () => new Date(), repos: [BENTO, ORDERS], toolHome: home, connectFetch: stripe, codexToolList: async () => null } as Parameters<typeof createDecisionServer>[0]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const login = async () => {
  const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" });
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
};
const page = async (cookie: string, query = "") => (await fetch(`${base}/settings/tools${query}`, { headers: { cookie } })).text();
/** The hidden fields of the first form posting to `action` on the page. */
const formOf = (html: string, action: string) => {
  const form = new RegExp(`<form method="post" action="${action}">[\\s\\S]*?</form>`).exec(html)?.[0] ?? "";
  return Object.fromEntries([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1]!, m[2]!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")]));
};
const post = (cookie: string, path: string, fields: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(fields), redirect: "manual" });
/** Back from the service: declining shows where the sign-in was going, without finishing it. */
const declined = async (started: Response) => {
  const [, name = "", state = ""] = /^([^=;]+)=([^;]+); Path=\/settings\/tools\/connected/.exec(started.headers.get("set-cookie") ?? "") ?? [];
  const back = await (await fetch(`${base}/settings/tools/connected?state=${state}&error=access_denied`, { headers: { cookie: `${name}=${state}` } })).text();
  return decodeURIComponent(/url=([^"]+)"/.exec(back)?.[1]?.replace(/&amp;/g, "&").replace(/&#39;/g, "'") ?? "");
};

test("choosing a project opens it at once, and every form there names and posts that project", async () => {
  const cookie = await login();
  // The dropdown navigates to ?repo=…; that page's Connect goes to the project it shows.
  const shown = await page(cookie, `?repo=${encodeURIComponent(ORDERS)}`);
  const fields = formOf(shown, "/settings/tools/connect");
  expect(fields).toMatchObject({ repo: ORDERS, shown: ORDERS });
  const started = await post(cookie, "/settings/tools/connect", { ...fields, service: "stripe", password: token });
  expect(started.status).toBe(200);
  expect(signIns).toHaveLength(1);
  expect(await declined(started)).toBe(`/settings/tools?repo=${ORDERS}&problem=Stripe wasn't connected to standing-orders: access was declined.`);
});

test("a post from a page that showed another project is refused, and nothing starts or changes", async () => {
  const cookie = await login();
  const fields = formOf(await page(cookie, `?repo=${encodeURIComponent(BENTO)}`), "/settings/tools/connect");
  // The dropdown moved to standing-orders while bentoportfolio's form was still on screen.
  const stale = await post(cookie, "/settings/tools/connect", { ...fields, shown: ORDERS, service: "stripe", password: token });
  expect(stale.status).toBe(303);
  expect(decodeURIComponent(stale.headers.get("location") ?? "")).toBe(`/settings/tools?repo=${ORDERS}&connect=stripe&problem=The project changed; connect again.`);
  expect(signIns).toHaveLength(0);
  const missing = await post(cookie, "/settings/tools/connect", { csrf: fields["csrf"]!, repo: BENTO, service: "stripe", password: token });
  expect(decodeURIComponent(missing.headers.get("location") ?? "")).toContain("The project changed; connect again.");
  expect(signIns).toHaveLength(0);
  expect(addToolTo(store, BENTO, connectedSpec("stripe")!, "connected by signing in", "alex", T0, { home })).toMatchObject({ ok: true });
  const removed = await post(cookie, "/settings/tools/change", { csrf: fields["csrf"]!, repo: BENTO, shown: ORDERS, action: "remove", name: "stripe" });
  expect(decodeURIComponent(removed.headers.get("location") ?? "")).toContain("The project changed; try again.");
  expect(projectToolsOf(store, BENTO).map(one => one.name)).toEqual(["stripe"]);
});

test("a connected service is connected to another project with one action: a fresh sign-in there", async () => {
  expect(addToolTo(store, BENTO, connectedSpec("stripe")!, "connected by signing in", "alex", T0, { home })).toMatchObject({ ok: true });
  const cookie = await login();
  const html = await page(cookie, `?repo=${encodeURIComponent(BENTO)}`);
  const fields = formOf(html.slice(html.indexOf('class="tool-elsewhere"')), "/settings/tools/connect");
  expect(fields).toMatchObject({ repo: BENTO, shown: BENTO });
  const started = await post(cookie, "/settings/tools/connect", { ...fields, also: `stripe:${ORDERS}`, password: token });
  expect(started.status).toBe(200);
  expect(signIns).toHaveLength(1);
  expect(await declined(started)).toBe(`/settings/tools?repo=${ORDERS}&problem=Stripe wasn't connected to standing-orders: access was declined.`);
  // Tokens are never copied: the other project has nothing until its own sign-in finishes.
  expect(projectToolsOf(store, ORDERS)).toEqual([]);
  // Only a service connected on the page's project can be offered elsewhere.
  const refused = await post(cookie, "/settings/tools/connect", { ...formOf(await page(cookie, `?repo=${encodeURIComponent(ORDERS)}`), "/settings/tools/connect"), also: `stripe:${BENTO}`, password: token });
  expect(decodeURIComponent(refused.headers.get("location") ?? "")).toContain("Stripe isn't connected to standing-orders.");
  expect(signIns).toHaveLength(1);
});

test("a gallery template's Connect refuses a wrong password, a stale project and a forged template, and comes back to the template", async () => {
  // PostHog signed in on bentoportfolio; Sentry added from the common tools list, so not connected by signing in.
  expect(addToolTo(store, BENTO, connectedSpec("posthog")!, "connected by signing in", "alex", T0, { home })).toMatchObject({ ok: true });
  const { label: _sentry, ...sentry } = catalogTool("sentry")!;
  expect(addToolTo(store, BENTO, sentry, "the common tools list", "alex", T0, { home })).toMatchObject({ ok: true });
  const cookie = await login();
  const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();

  // Not connected: its Connect (with the password) comes first; the preview names the zone that needs it; Create stays, quieter.
  const figma = await get(`/flows/new/figma-to-pr?repo=${encodeURIComponent(BENTO)}`);
  const fields = formOf(figma, "/settings/tools/connect");
  expect(fields).toMatchObject({ repo: BENTO, shown: BENTO, template: "figma-to-pr" });

  // A wrong password, a stale project and a failed local connection all come back to the template, for the same project.
  const wrong = await post(cookie, "/settings/tools/connect", { ...fields, service: "figma-desktop", password: "nope" });
  expect(decodeURIComponent(wrong.headers.get("location") ?? "")).toBe(`/flows/new/figma-to-pr?repo=${BENTO}&problem=Enter your Toolroll password to connect a tool.`);
  const stale = await post(cookie, "/settings/tools/connect", { ...fields, shown: ORDERS, service: "figma-desktop", password: token });
  expect(decodeURIComponent(stale.headers.get("location") ?? "")).toBe(`/flows/new/figma-to-pr?repo=${ORDERS}&problem=The project changed; connect again.`);
  const offline = await post(cookie, "/settings/tools/connect", { ...fields, service: "figma-desktop", password: token });
  const back = decodeURIComponent(offline.headers.get("location") ?? "");
  expect(back).toMatch(/^\/flows\/new\/figma-to-pr\?repo=\/repo\/bentoportfolio&problem=/);
  expect(projectToolsOf(store, BENTO).map(one => one.name)).not.toContain("figma-desktop");

  // A sign-in elsewhere: started from the template, the service's answer comes back to that template and project.
  const page = await get(`/flows/new/ui-inspiration?repo=${encodeURIComponent(ORDERS)}`);
  const signIn = formOf(page, "/settings/tools/connect");
  expect(signIn).toMatchObject({ repo: ORDERS, shown: ORDERS, template: "ui-inspiration" });
  const started = await post(cookie, "/settings/tools/connect", { ...signIn, service: "stripe", password: token });
  // A template names only its own tools: Stripe isn't one of UI inspiration's, so it goes back to the Tools page as ever.
  expect(started.status).toBe(200);
  expect(await declined(started)).toBe(`/settings/tools?repo=${ORDERS}&problem=Stripe wasn't connected to standing-orders: access was declined.`);
  const mobbin = await post(cookie, "/settings/tools/connect", { ...signIn, service: "mobbin", password: token });
  // Mobbin's sign-in isn't answered here (the replayed fetch knows Stripe only): the reason comes back to the template.
  expect(decodeURIComponent(mobbin.headers.get("location") ?? "")).toBe(`/flows/new/ui-inspiration?repo=${ORDERS}&problem=Mobbin didn't offer a sign-in just now. Try again in a minute.`);
  // An unknown template is never a place to go back to.
  const forged = await post(cookie, "/settings/tools/connect", { ...signIn, template: "../../evil", service: "figma-desktop", password: "nope" });
  expect(decodeURIComponent(forged.headers.get("location") ?? "")).toBe(`/settings/tools?repo=${ORDERS}&connect=figma-desktop&problem=Enter your Toolroll password to connect a tool.`);

  // Created without the tool: the flow is made all the same.
  const preview = await post(cookie, "/flows/new/figma-to-pr", { csrf: fields["csrf"]!, repo: BENTO, name: "", intent: "preview" });
  const previewed = /name="previewed" value="([^"]*)"/.exec(await preview.text())![1]!;
  const made = await post(cookie, "/flows/new/figma-to-pr", { csrf: fields["csrf"]!, repo: BENTO, name: "", intent: "create", previewed });
  expect(made.status).toBe(303);
  expect(store.listFlows([BENTO]).map(one => one.name)).toEqual(["Figma frame to pull request"]);
});

test("PostHog connected with write access says why research can't use it, and Reconnect read-only asks PostHog only to read", async () => {
  expect(addToolTo(store, BENTO, connectedSpec("posthog")!, "connected by signing in", "alex", T0, { home })).toMatchObject({ ok: true });
  store.recordProjectToolTest(BENTO, "posthog", JSON.stringify({ at: T0.toISOString(), ok: true, tools: ["exec"], problem: null }));
  setToolSecrets(BENTO, "posthog", { OAUTH_ACCESS_TOKEN: "ph-secret", OAUTH_GRANTED_SCOPE: "insight:read insight:write user:read" }, home);
  const cookie = await login();
  const html = await page(cookie, `?repo=${encodeURIComponent(BENTO)}`);
  expect(html).toContain('<p class="tool-note" role="status">PostHog is connected with write access, so research runs can&#39;t use it.</p>');
  expect(html).not.toContain("ph-secret");
  const card = html.slice(html.indexOf('id="tool-posthog"'));
  const fields = formOf(card, "/settings/tools/connect");
  expect(fields).toMatchObject({ repo: BENTO, shown: BENTO, service: "posthog", access: "read" });
  const started = await post(cookie, "/settings/tools/connect", { ...fields, password: token });
  expect(started.status).toBe(200);
  const go = new URL(/url=([^"]+)"/.exec(await started.text())![1]!.replace(/&amp;/g, "&"));
  expect(go.origin + go.pathname).toBe("https://oauth.posthog.com/oauth/authorize/");
  expect(go.searchParams.get("scope")).toBe("openid insight:read user:read");
  // Read-only: the grant now reads only, the note goes, and the card is as before.
  setToolSecrets(BENTO, "posthog", { OAUTH_GRANTED_SCOPE: "insight:read openid user:read" }, home);
  const after = await page(cookie, `?repo=${encodeURIComponent(BENTO)}`);
  expect(after).not.toContain("tool-note");
  expect(after).not.toContain("Reconnect read-only");
});

test("Settings → Project's Build access never shows a tool's secret", async () => {
  const cookie = await login();
  const projectPage = async () => (await fetch(`${base}/settings/project?repo=${encodeURIComponent(BENTO)}`, { headers: { cookie } })).text();
  const section = (html: string) => /<section class="build-access"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

  // Named tools: one ready, one missing its secret (named on the page, never its value).
  const secret = ["lin", "api", "9c".repeat(16)].join("_");
  const long = "internal-documentation-search-server-x40";
  expect(addToolTo(store, BENTO, { name: "linear", transport: "stdio", command: "npx", args: ["linear-mcp"], url: null, secrets: [{ name: "LINEAR_TOKEN", optional: false }], bearer: null, headerSecrets: {}, about: "Linear" }, "custom", "alex", T0, { home })).toMatchObject({ ok: true });
  setToolSecrets(BENTO, "linear", { LINEAR_TOKEN: secret }, home);
  expect(addToolTo(store, BENTO, { name: long, transport: "stdio", command: "npx", args: ["docs-mcp"], url: null, secrets: [{ name: "DOCS_TOKEN", optional: false }], bearer: null, headerSecrets: {}, about: "Docs" }, "custom", "alex", T0, { home })).toMatchObject({ ok: true });
  const named = section(await projectPage());
  expect(named).not.toContain(secret);
});

test("Build access says plainly when a project's tools can't be read", async () => {
  const { projectSettingsHtml } = await import("./project-delete-ui.js");
  const { htmlString } = await import("./html.js");
  const view = { repo: BENTO, name: "bentoportfolio", holdings: { tasks: 0, versions: 0, runs: 0, chats: 0, flows: 0, cards: 0, subagents: 0 }, running: [], canDelete: false };
  const failed = htmlString(projectSettingsHtml({ ...view, access: { problem: "Couldn't read this project's tools right now." } } as never, {}));
  expect(failed).toContain('<p class="problem" role="alert">Couldn&#39;t read this project&#39;s tools right now.</p>');
  expect(failed).toContain(">Manage tools</a>");
});
