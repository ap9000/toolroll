/**
 * Credentials and sessions (v101): API tokens are shown once, read or act
 * (never approve), expire, and are named in the ledger; a revoked, expired or
 * guessed one names no one; a browser session survives a restart and can be
 * ended from elsewhere; coordinator and runner credentials expire.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { authenticateCoordinator, mintCoordinator } from "./coordinator.js";
import { authenticate, register, RUNNER_TOKEN_MS } from "./runner.js";

let dir: string, store: Store, server: Server, base: string, password: string;
async function listen(): Promise<void> {
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-credentials-"));
  store = openStore(join(dir, "orders.db"));
  const added = addApprover(store, "alex", new Date());
  if (!added.ok) throw new Error("bootstrap");
  password = added.token;
  await listen();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const sessionOf = (answer: Response) => answer.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
const signIn = async (agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Chrome/129.0 Safari/537.36") =>
  sessionOf(await fetch(`${base}/login`, { method: "POST", headers: { "user-agent": agent }, body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" }));
async function makeToken(cookie: string, fields: Record<string, string>): Promise<string> {
  const page = await (await fetch(`${base}/settings/sessions`, { headers: { cookie } })).text();
  const made = await fetch(`${base}/settings/sessions`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf: csrfOf(page), action: "create-token", password, ...fields }), redirect: "manual" });
  const html = await made.text();
  expect(html).not.toContain("<script");
  return /(so_[a-f0-9]{12}_[A-Za-z0-9_-]{43})/.exec(html)![1]!;
}

test("an API token is shown once, reads or acts as its person (never more), is named in the ledger, and ends when revoked or expired", async () => {
  const cookie = await signIn();
  const reader = await makeToken(cookie, { name: "dashboard", access: "read", days: "30" });
  const actor = await makeToken(cookie, { name: "CI", access: "act", days: "90" });
  expect(store.apiTokens("alex").map(one => [one.name, one.access])).toEqual([["CI", "act"], ["dashboard", "read"]]);
  expect(JSON.stringify(store.handle.prepare("SELECT * FROM credential").all())).not.toContain(reader.slice(16));
  // Read: reads, can't file work.
  expect((await fetch(`${base}/ledger?format=json`, { headers: { authorization: `Bearer ${reader}` } })).status).toBe(200);
  expect((await fetch(`${base}/tasks/add`, { method: "POST", headers: { authorization: `Bearer ${reader}` }, body: new URLSearchParams({ title: "from a reader", repo: "/repo/main" }), redirect: "manual" })).status).toBe(403);
  // Act: files work as alex, and the ledger says which token.
  const filed = await fetch(`${base}/tasks/add`, { method: "POST", headers: { authorization: `Bearer ${actor}` }, body: new URLSearchParams({ title: "from CI", repo: "/repo/main" }), redirect: "manual" });
  expect(filed.status).toBeLessThan(400);
  expect(store.actionLedger({ repos: null, source: "request" }).find(one => one.detail === "API token: CI")).toMatchObject({ actor: "alex" });
  expect(store.apiTokens("alex").find(one => one.name === "CI")?.lastUsedAt).not.toBeNull();
  // Revoked: names no one.
  const page = await (await fetch(`${base}/settings/sessions`, { headers: { cookie } })).text();
  const id = store.apiTokens("alex").find(one => one.name === "dashboard")!.id;
  expect(page).toContain(`data-token="${id}"`);
  await fetch(`${base}/settings/sessions`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf: csrfOf(page), action: "revoke-token", token: id }), redirect: "manual" });
  expect((await fetch(`${base}/ledger?format=json`, { headers: { authorization: `Bearer ${reader}` }, redirect: "manual" })).status).toBe(303);
  // A guessed token names no one either; expiry ends a live one.
  expect((await fetch(`${base}/ledger?format=json`, { headers: { authorization: `Bearer so_${"a".repeat(12)}_${"b".repeat(43)}` }, redirect: "manual" })).status).toBe(303);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 91 * 86_400_000);
  expect((await fetch(`${base}/ledger?format=json`, { headers: { authorization: `Bearer ${actor}` }, redirect: "manual" })).status).toBe(303);
  expect(store.actionLedger({ repos: null, source: "access" }).map(one => one.action)).toEqual(expect.arrayContaining(["API token created: CI", "API token created: dashboard", "API token revoked: dashboard"]));
});

test("tokens outlive a password change but end with an access change", async () => {
  const cookie = await signIn();
  const second = addApprover(store, "sam", new Date(), { name: "alex", token: password });
  if (!second.ok) throw new Error("sam");
  const samCookie = sessionOf(await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "sam", token: second.token }), redirect: "manual" }));
  const samPage = await (await fetch(`${base}/settings/sessions`, { headers: { cookie: samCookie } })).text();
  const made = await (await fetch(`${base}/settings/sessions`, { method: "POST", headers: { cookie: samCookie, origin: base }, body: new URLSearchParams({ csrf: csrfOf(samPage), action: "create-token", name: "sam-ci", access: "act", days: "30", password: second.token }) })).text();
  const token = /(so_[a-f0-9]{12}_[A-Za-z0-9_-]{43})/.exec(made)![1]!;
  store.revokeDerivedAuthority("sam", "credential-rotation", new Date());
  expect(store.apiTokens("sam")[0]?.revokedAt).toBeNull();
  expect(store.setAccountProjects("sam", ["/repo/main"], "alex", new Date())).toEqual({ ok: true });
  expect(store.apiTokens("sam")[0]?.revokedAt).not.toBeNull();
  expect((await fetch(`${base}/work`, { headers: { authorization: `Bearer ${token}` }, redirect: "manual" })).status).toBe(303);
  expect(cookie).toBeTruthy();
});

test("a browser session survives a restart, lists where it came from, and can be ended from another", async () => {
  const laptop = await signIn();
  const phone = await signIn("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1");
  // A restart: a new server on the same database. The cookie still signs in.
  await new Promise<void>(resolve => server.close(() => resolve()));
  await listen();
  const page = await (await fetch(`${base}/settings/sessions`, { headers: { cookie: laptop } })).text();
  expect(page).toContain("Chrome on macOS");
  expect(page).toContain("Safari on iPhone or iPad");
  expect(page).toContain("This browser");
  // End the phone's session from the laptop.
  const ended = await fetch(`${base}/settings/sessions`, { method: "POST", headers: { cookie: laptop, origin: base }, body: new URLSearchParams({ csrf: csrfOf(page), action: "end-others" }), redirect: "manual" });
  expect(decodeURIComponent(ended.headers.get("location")!)).toContain("Signed out of 1 other session.");
  expect((await fetch(`${base}/work`, { headers: { cookie: phone }, redirect: "manual" })).status).toBe(303);
  expect((await fetch(`${base}/work`, { headers: { cookie: laptop }, redirect: "manual" })).status).toBe(200);
  // No cookie is kept, only its hash.
  expect(JSON.stringify(store.handle.prepare("SELECT id_hash FROM web_session").all())).not.toContain(laptop.split("=")[1]!);
});

test("coordinator credentials expire (older ones until renewed), and a runner's token lasts a year from registering", () => {
  const now = new Date();
  const made = mintCoordinator(store, { name: "ci-bot", repos: ["/repo/main"], by: "alex", now, days: 1 });
  if (!made.ok) throw new Error(JSON.stringify(made));
  expect(authenticateCoordinator(store, made.token)).toMatchObject({ ok: true });
  vi.spyOn(Date, "now").mockReturnValue(now.getTime() + 2 * 86_400_000);
  expect(authenticateCoordinator(store, made.token)).toEqual({ ok: false, reason: "expired" });
  vi.restoreAllMocks();
  const registered = register(store, { name: "builder-9", host: "h", now: new Date(now.getTime() - RUNNER_TOKEN_MS - 60_000), newToken: () => "tok-9" });
  expect(registered).toBeTruthy();
  expect(authenticate(store, "builder-9", "tok-9")).toEqual({ ok: false, reason: "expired" });
  register(store, { name: "builder-9", host: "h", now, newToken: () => "tok-9b" });
  expect(authenticate(store, "builder-9", "tok-9b")).toMatchObject({ ok: true });
});
