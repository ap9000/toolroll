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
import { addToolTo, projectToolsOf } from "./project-tools.js";
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
  const first = await page(cookie);
  expect(first).toMatch(/<form class="tools" method="get" action="\/settings\/tools" data-autosave><label>Project<select name="repo" data-tools-project>/);
  // The Show project button stays for a page without scripts; the script submits on change and marks the forms stale.
  expect(first).toContain('<button type="submit">Show project</button>');
  expect(first).toContain("input[name=shown]");
  expect(first).toContain('aria-label="Connect Stripe to bentoportfolio"');
  // The dropdown navigates to ?repo=…; that page's Connect goes to the project it shows.
  const shown = await page(cookie, `?repo=${encodeURIComponent(ORDERS)}`);
  expect(shown).toContain('<h2 id="connect-heading">Connect to standing-orders</h2>');
  expect(shown).toContain('aria-label="Connect Stripe to standing-orders"');
  expect(shown).toContain("Add to standing-orders");
  const fields = formOf(shown, "/settings/tools/connect");
  expect(fields).toMatchObject({ repo: ORDERS, shown: ORDERS });
  const started = await post(cookie, "/settings/tools/connect", { ...fields, service: "stripe", password: token });
  expect(started.status).toBe(200);
  expect(signIns).toHaveLength(1);
  expect(await declined(started)).toBe(`/settings/tools?repo=${ORDERS}&problem=Stripe wasn't connected to standing-orders: access was declined.`);
  // A kit's or the lead's Connect link names the project on its own button.
  expect(await page(cookie, `?repo=${encodeURIComponent(ORDERS)}&connect=stripe`)).toContain('class="connect-wanted">Connect Stripe to standing-orders</button>');
});

test("a post from a page that showed another project is refused, and nothing starts or changes", async () => {
  const cookie = await login();
  const fields = formOf(await page(cookie, `?repo=${encodeURIComponent(BENTO)}`), "/settings/tools/connect");
  // The dropdown moved to standing-orders while bentoportfolio's form was still on screen.
  const stale = await post(cookie, "/settings/tools/connect", { ...fields, shown: ORDERS, service: "stripe", password: token });
  expect(stale.status).toBe(303);
  expect(decodeURIComponent(stale.headers.get("location") ?? "")).toBe(`/settings/tools?repo=${ORDERS}&connect=stripe&problem=The project changed; connect again.#connect`);
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
  expect(html).toContain('<button name="also" value="stripe:/repo/standing-orders" class="secondary">Also connect Stripe to standing-orders</button>');
  // Already on standing-orders: nothing to offer from there.
  expect(await page(cookie, `?repo=${encodeURIComponent(ORDERS)}`)).not.toContain("Also connect Stripe");
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
