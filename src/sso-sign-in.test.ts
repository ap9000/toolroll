/**
 * Sign-in with an identity provider (v100), over HTTP against a stand-in
 * provider: an instance operator turns it on; a person signs in, gets an
 * account from their groups, and their groups set it again at each sign-in;
 * a step-up is the provider's recent check, not a password; passwords can be
 * kept for instance operators only; an existing account can be linked.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer, ssoStepUps } from "./serve.js";

const ISSUER = "https://sso.example.com";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
let dir: string, store: Store, server: Server, base: string, password: string;
/** Who the provider says signs in next, and their groups. */
let person = { sub: "00u-priya", email: "priya@acme.com", groups: ["eng"] };
let lastNonce = "";

const provider = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/keys` });
  if (url === `${ISSUER}/keys`) return json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" }] });
  if (url === `${ISSUER}/token`) {
    const form = new URLSearchParams(String(init?.body));
    if (form.get("code") !== "the-code" || form.get("client_secret") !== "shh" || !form.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
    const now = Math.floor(new Date().getTime() / 1000); // the provider's own clock
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const data = `${part({ alg: "RS256", kid: "k1" })}.${part({ iss: ISSUER, aud: "so-app", sub: person.sub, email: person.email, groups: person.groups, nonce: lastNonce, iat: now, exp: now + 600, auth_time: now })}`;
    return json({ id_token: `${data}.${sign("sha256", Buffer.from(data), keys.privateKey).toString("base64url")}` });
  }
  return json({}, 404);
}) as typeof fetch;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-sso-"));
  store = openStore(join(dir, "orders.db"));
  const added = addApprover(store, "alex", new Date());
  if (!added.ok) throw new Error("bootstrap");
  password = added.token;
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", configDir: dir, telegramTokenFile: join(dir, "telegram-token"), ssoFetch: provider });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
  person = { sub: "00u-priya", email: "priya@acme.com", groups: ["eng"] };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The session cookie (a sign-in also clears its hand-off cookie), or the one cookie set. */
const cookieOf = (answer: Response) => { const all = answer.headers.getSetCookie().map(one => one.split(";")[0]!); return all.find(one => one.startsWith("standing-orders_session=")) ?? all[0]!; };
const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
async function passwordSignIn(name: string, secret: string) {
  return fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: secret }), redirect: "manual" });
}
/** The provider's round trip: /login/sso, the provider (stood in for), the callback, then finish. */
async function providerSignIn(query = "", cookie = ""): Promise<Response> {
  const start = await fetch(`${base}/login/sso${query}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  expect(start.status).toBe(302);
  const go = new URL(start.headers.get("location")!);
  lastNonce = go.searchParams.get("nonce")!;
  const bound = cookieOf(start);
  const back = await fetch(`${base}/login/sso/callback?code=the-code&state=${go.searchParams.get("state")}`, { headers: { cookie: bound }, redirect: "manual" });
  const html = await back.text();
  const finish = /content="0;url=([^"]+)"/.exec(html)?.[1];
  if (finish === undefined) return new Response(html, { status: back.status });
  // The hand-off is this browser's: its cookie goes along to finish.
  const handoff = back.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => /^so-sign-in=.+/.test(one))!;
  return fetch(`${base}${finish.replace(/&amp;/g, "&")}`, { headers: { cookie: [handoff, ...(cookie ? [cookie] : [])].join("; ") }, redirect: "manual" });
}
async function turnOn(passwords = "everyone") {
  const signedIn = await passwordSignIn("alex", password);
  const cookie = cookieOf(signedIn);
  const page = await (await fetch(`${base}/settings/sign-in`, { headers: { cookie } })).text();
  const saved = await fetch(`${base}/settings/sign-in`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({
    csrf: csrfOf(page), action: "save", issuer: ISSUER, "client-id": "so-app", "client-secret": "shh", label: "Okta", scopes: "openid email profile groups", "groups-claim": "groups", passwords,
    "group-0": "eng-leads", "role-0": "operator", "projects-0": "all", "group-1": "eng", "role-1": "viewer", "projects-1": "/repo/main", password }) });
  expect(saved.headers.get("location")).toBe(`/settings/sign-in?said=${encodeURIComponent("Saved. People can sign in with Okta.")}`);
  return cookie;
}

test("an instance operator turns it on (the secret in a private file, the change on the record), and sign-in offers it", async () => {
  await turnOn();
  expect(statSync(join(dir, "sign-in.json")).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(dir, "sign-in.json"), "utf8"))).toMatchObject({ issuer: ISSUER, clientId: "so-app", clientSecret: "shh", rules: [{ group: "eng-leads", role: "operator", projects: "all" }, { group: "eng", role: "viewer", projects: ["/repo/main"] }] });
  const change = store.actionLedger({ repos: null, source: "policy" }).find(one => one.action === "sign-in with a provider turned on");
  expect(change?.detail).toMatch(/^off → Okta \(https:\/\/sso\.example\.com\) · eng-leads: operator, all projects; eng: viewer, 1 project · passwords: everyone$/);
  expect(change?.detail).not.toContain("shh");
  expect(await (await fetch(`${base}/login`)).text()).toContain('<a class="button-link login-sso" href="/login/sso">Sign in with Okta</a>');
});

test("a person signs in with the provider: an account from their groups, set again by their groups at each sign-in; no group, no entry", async () => {
  await turnOn();
  const first = await providerSignIn();
  expect(first.status).toBe(303);
  expect(store.accountOf("priya")).toMatchObject({ role: "viewer", projects: ["/repo/main"] });
  expect(store.ssoAccount(ISSUER, "00u-priya")).toBe("priya");
  const cookie = cookieOf(first);
  expect((await fetch(`${base}/work`, { headers: { cookie }, redirect: "manual" })).status).toBe(200);
  // Promoted in the provider: the next sign-in makes them an operator everywhere, on the record.
  person.groups = ["eng", "eng-leads"];
  expect((await providerSignIn()).status).toBe(303);
  expect(store.accountOf("priya")).toMatchObject({ role: "approver", projects: null });
  expect(store.actionLedger({ repos: null, source: "access" }).find(one => one.action === "access changed by groups")?.detail).toBe("viewer · main → operator · all projects");
  // The old session ended with the change.
  expect((await fetch(`${base}/work`, { headers: { cookie }, redirect: "manual" })).status).toBe(303);
  // No matching group: refused, and said so.
  person = { sub: "00u-sales", email: "sam@acme.com", groups: ["sales"] };
  const refused = await providerSignIn();
  expect(refused.status).toBe(403);
  expect(await refused.text()).toContain("Your Okta account isn&#39;t in a group that may use Toolroll.");
  expect(store.accountOf("sam")).toBeNull();
  expect(store.actionLedger({ repos: null, source: "sign-in" }).map(one => [one.actor, one.action, one.outcome]).reverse()).toEqual(expect.arrayContaining([
    ["priya", "signed in", "Okta"], ["unknown account", "sign-in refused", "no matching group"]]));
});

test("a step-up is the provider's check from moments ago; later, a link to be checked again", async () => {
  await turnOn();
  person.groups = ["eng-leads"];
  const cookie = cookieOf(await providerSignIn());
  const tools = await (await fetch(`${base}/settings/tools`, { headers: { cookie } })).text();
  expect(tools).toContain('data-sso-step-up="confirmed"');
  expect(tools).not.toMatch(/type="password"[^>]*autocomplete="current-password"/);
  const add = (csrf: string) => fetch(`${base}/settings/tools/change`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf, repo: "/repo/main", shown: "/repo/main", action: "add-catalog", catalog: "playwright", password: "" }) });
  expect((await add(csrfOf(tools))).headers.get("location")).toContain("said=");
  // Eleven minutes on: the page asks to confirm with the provider, and an empty password no longer does.
  const later = Date.now() + 11 * 60_000;
  vi.spyOn(Date, "now").mockReturnValue(later);
  const stale = await (await fetch(`${base}/settings/tools`, { headers: { cookie } })).text();
  expect(stale).toContain('href="/login/sso?reauth=1&amp;return=%2Fsettings%2Ftools">Confirm with Okta</a>');
  const refused = await fetch(`${base}/settings/tools/change`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf: csrfOf(stale), repo: "/repo/main", shown: "/repo/main", action: "add-catalog", catalog: "shadcn", password: "" }) });
  expect(decodeURIComponent(refused.headers.get("location") ?? "")).toContain("problem=");
  // Confirming with the provider makes it fresh again, and says so on the record.
  vi.restoreAllMocks();
  expect((await providerSignIn("?reauth=1&return=/settings/tools", cookie)).headers.get("location")).toBe("/settings/tools");
  expect(await (await fetch(`${base}/settings/tools`, { headers: { cookie } })).text()).toContain('data-sso-step-up="confirmed"');
  expect(store.actionLedger({ repos: null, source: "sign-in", limit: 1 })[0]).toMatchObject({ actor: "priya", action: "confirmed", outcome: "Okta" });
});

test("someone who signs in only with the provider approves a task on a fresh sign-in, and not on a stale one", async () => {
  await turnOn();
  person.groups = ["eng-leads"];
  const cookie = cookieOf(await providerSignIn());
  // Approvals bind exact routing: every phase names a model.
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", new Date());
  store.createTask({ id: "t-sso", title: "approve me" }, new Date());
  const csrf = csrfOf(await (await fetch(`${base}/tasks`, { headers: { cookie } })).text());
  const post = (path: string, fields: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf, ...fields }) });
  expect((await post("/t/t-sso/scope", { acceptance: "c1: ok | manual-review", sawDigest: "", goal: "the goal", not: "", touches: "" })).status).toBe(303);
  const digest = store.getScope("t-sso")?.digest ?? "";
  const page = async () => (await fetch(`${base}/t/t-sso`, { headers: { cookie } })).text();
  const nonceOf = (html: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? "";
  // Eleven minutes on, an empty password approves nothing.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
  expect((await post("/t/t-sso/approve", { nonce: nonceOf(await page()), digest, token: "" })).status).toBe(400);
  expect(store.getScope("t-sso")?.approvedBy ?? null).toBeNull();
  vi.restoreAllMocks();
  // Fresh: the form says the provider confirmed it, and the approval is priya's.
  const html = await page();
  expect(html).toContain('data-sso-step-up="confirmed"');
  expect((await post("/t/t-sso/approve", { nonce: nonceOf(html), digest, token: "" })).status).toBe(303);
  expect(store.getScope("t-sso")?.approvedBy).toBe("priya");
});

test("passwords for instance operators only: others are sent to the provider; an existing account can be linked", async () => {
  const operator = await turnOn("operators");
  // A password viewer from before.
  const invite = store.mintInvite("viewer", "alex", new Date(), undefined, ["/repo/main"]);
  expect((await fetch(`${base}/join/${invite.token}`, { method: "POST", body: new URLSearchParams({ name: "casey", password: "casey-password-1" }), redirect: "manual" })).status).toBe(303);
  const casey = await passwordSignIn("casey", "casey-password-1");
  expect(casey.status).toBe(403);
  expect(await casey.text()).toContain("Sign in with Okta.");
  expect((await passwordSignIn("alex", password)).status).toBe(303);
  // alex links their account: from now on the provider signs them in as alex.
  person = { sub: "00u-alex", email: "alex@acme.com", groups: ["eng-leads"] };
  expect((await providerSignIn("?link=1", operator)).headers.get("location")).toBe(`/settings/sign-in?said=${encodeURIComponent("This account signs in with Okta now.")}`);
  expect(store.ssoAccount(ISSUER, "00u-alex")).toBe("alex");
  const again = await providerSignIn();
  expect(again.status).toBe(303);
  expect(store.accountOf("alex")?.role).toBe("approver");
});

test("the hand-off to finish is the starting browser's alone", async () => {
  await turnOn();
  const start = await fetch(`${base}/login/sso`, { redirect: "manual" });
  const go = new URL(start.headers.get("location")!);
  lastNonce = go.searchParams.get("nonce")!;
  const back = await fetch(`${base}/login/sso/callback?code=the-code&state=${go.searchParams.get("state")}`, { headers: { cookie: cookieOf(start) }, redirect: "manual" });
  const finish = /content="0;url=([^"]+)"/.exec(await back.text())![1]!.replace(/&amp;/g, "&");
  const elsewhere = await fetch(`${base}${finish}`, { redirect: "manual" });
  expect(elsewhere.status).toBe(400);
  expect(await elsewhere.text()).toContain("started in another browser");
  expect(store.accountOf("priya")).toBeNull();
});

test("only step-up password fields become the provider's check; a secret field stays", () => {
  const html = '<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>' +
    '<input type="password" name="token" autocomplete="current-password" class="inline">' +
    '<label>Token from @BotFather<input type="password" name="token" autocomplete="off"></label>';
  const fresh = ssoStepUps(html, { label: "Okta", fresh: true }, "/x");
  expect(fresh).toBe('<input type="hidden" name="password" value=""><span class="sso-step-up" data-sso-step-up="confirmed">Confirmed with Okta</span>' +
    '<input type="hidden" name="token" value=""><span class="sso-step-up" data-sso-step-up="confirmed">Confirmed with Okta</span>' +
    '<label>Token from @BotFather<input type="password" name="token" autocomplete="off"></label>');
  expect(ssoStepUps(html, { label: "Okta", fresh: false }, "/t/a?b=1")).toContain('href="/login/sso?reauth=1&amp;return=%2Ft%2Fa%3Fb%3D1">Confirm with Okta</a>');
});
