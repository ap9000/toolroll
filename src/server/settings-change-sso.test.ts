/**
 * The sign-in RETURN for a Settings change document (the eight settings plan v2 §2.2), over HTTP against a stand-in
 * provider: a re-check started from a change document (/login/sso?reauth=1&return=…) comes back to that document's
 * address, its `repo` and `section` keys intact, through the real sign-in sanitizer (loginReturn). A return carrying a
 * secret-looking key loses it; a region fetch (`fragment`) still goes to /.
 *
 * Scope, said plainly: this proves the return address only. Local mode is installation-wide, so the `repo` key below
 * only proves a project key survives the round trip; no per-project change document exists yet. Nothing here spends
 * the re-check on an act: proof consumption, replay and an unchanged store are for the slices that wire each ceremony
 * (see the F0 PR notes).
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { openStore, type Store } from "../store.js";
import { addApprover } from "../scope.js";
import { createDecisionServer } from "../serve.js";

const ISSUER = "https://sso.example.com";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
let dir: string, store: Store, server: Server, base: string, cookie: string;
let lastNonce = "";

/** The stand-in provider: discovery, keys, and a token endpoint that signs who signs in (an operator by group). */
const provider = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/keys` });
  if (url === `${ISSUER}/keys`) return json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" }] });
  if (url === `${ISSUER}/token`) {
    const form = new URLSearchParams(String(init?.body));
    if (form.get("code") !== "the-code" || form.get("client_secret") !== "shh" || !form.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
    const now = Math.floor(Date.now() / 1000);
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const data = `${part({ alg: "RS256", kid: "k1" })}.${part({ iss: ISSUER, aud: "so-app", sub: "00u-priya", email: "priya@acme.com", groups: ["eng-leads"], nonce: lastNonce, iat: now, exp: now + 600, auth_time: now })}`;
    return json({ id_token: `${data}.${sign("sha256", Buffer.from(data), keys.privateKey).toString("base64url")}` });
  }
  return json({}, 404);
}) as typeof fetch;

const cookieOf = (answer: Response) => { const all = answer.headers.getSetCookie().map(one => one.split(";")[0]!); return all.find(one => one.startsWith("standing-orders_session=")) ?? all[0]!; };
const csrfOf = (page: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
/** The provider's round trip: /login/sso, the provider (stood in for), the callback, then finish. */
async function providerSignIn(query: string, signedIn = ""): Promise<Response> {
  const start = await fetch(`${base}/login/sso${query}`, { headers: signedIn ? { cookie: signedIn } : {}, redirect: "manual" });
  expect(start.status).toBe(302);
  const go = new URL(start.headers.get("location")!);
  lastNonce = go.searchParams.get("nonce")!;
  const back = await fetch(`${base}/login/sso/callback?code=the-code&state=${go.searchParams.get("state")}`, { headers: { cookie: cookieOf(start) }, redirect: "manual" });
  const finish = /content="0;url=([^"]+)"/.exec(await back.text())![1]!;
  const handoff = back.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => /^so-sign-in=.+/.test(one))!;
  return fetch(`${base}${finish.replace(/&amp;/g, "&")}`, { headers: { cookie: [handoff, ...(signedIn ? [signedIn] : [])].join("; ") }, redirect: "manual" });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-change-sso-"));
  store = openStore(join(dir, "orders.db"));
  const added = addApprover(store, "alex", new Date());
  if (!added.ok) throw new Error("bootstrap");
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", configDir: dir, telegramTokenFile: join(dir, "telegram-token"), ssoFetch: provider });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // An instance operator turns sign-in with the provider on; then an operator signs in with it.
  const alex = cookieOf(await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual" }));
  const page = await (await fetch(`${base}/settings/sign-in`, { headers: { cookie: alex } })).text();
  const saved = await fetch(`${base}/settings/sign-in`, { method: "POST", headers: { cookie: alex, origin: base }, redirect: "manual", body: new URLSearchParams({
    csrf: csrfOf(page), action: "save", issuer: ISSUER, "client-id": "so-app", "client-secret": "shh", label: "Okta", scopes: "openid email profile groups", "groups-claim": "groups",
    passwords: "everyone", "group-0": "eng-leads", "role-0": "operator", "projects-0": "all", password: added.token }) });
  expect(saved.status).toBe(303);
  const signed = await providerSignIn("");
  expect(signed.status).toBe(303);
  cookie = cookieOf(signed);
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const reauth = (back: string) => providerSignIn(`?reauth=1&return=${encodeURIComponent(back)}`, cookie);

test("the return keeps a change document's repo and section keys, and that document answers there", async () => {
  const back = await reauth("/settings/change/local-mode?repo=%2Frepo%2Fmain&section=local-mode");
  expect(back.status).toBe(303);
  expect(back.headers.get("location")).toBe("/settings/change/local-mode?repo=%2Frepo%2Fmain&section=local-mode");
  // And it is the document itself that answers there (local mode is off here: it says so).
  const landed = await fetch(`${base}${back.headers.get("location")!}`, { headers: { cookie }, redirect: "manual" });
  expect(landed.status).toBe(200);
  expect(await landed.text()).toContain("Local mode is off.");
});

test("the return to an operator's change document with no project keeps its section", async () => {
  expect((await reauth("/settings/change/local-mode?section=local-mode")).headers.get("location")).toBe("/settings/change/local-mode?section=local-mode");
});

test("a return carrying a secret-looking key loses it; a region fetch, or anything not a change document, goes to /", async () => {
  expect((await reauth("/settings/change/local-mode?repo=%2Frepo%2Fmain&password=x&token=y&client-secret=z&api-key=k")).headers.get("location")).toBe("/settings/change/local-mode?repo=%2Frepo%2Fmain");
  expect((await reauth("/settings/change/local-mode?fragment=steps")).headers.get("location")).toBe("/");
  expect((await reauth("/settings/change/local-mode/more")).headers.get("location")).toBe("/");
  expect((await reauth("//evil.example/settings/change/local-mode")).headers.get("location")).toBe("/");
});
