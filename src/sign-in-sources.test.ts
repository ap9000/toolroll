/**
 * Sign-in hardening over HTTP: a source that guessed wrong is locked while the owner signs in from elsewhere, rotating
 * sources holds back every source that failed, every per-source cap counts a native IPv6 caller by its /64 (sign-in,
 * join, MCP sign-in), and a password bearer on a long live team stream (GET /live?room=team) proves its password again on a bounded
 * interval while a credential-generation bump still ends it at once.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover, authenticateApprover, hashPassword } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { OAUTH_LIMITS } from "./mcp-oauth.js";
import { TEAM_PASSWORD_REVERIFY_MS } from "./team-http.js";

const T0 = new Date("2026-09-27T18:00:00.000Z");
const REDIRECT = "http://127.0.0.1:7777/callback";
let dir: string, store: Store, server: Server, base: string, password: string, now: Date;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-hardening-"));
  store = openStore(join(dir, "orders.db"));
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap");
  password = added.token;
  now = new Date();
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", configDir: dir, clock: () => now });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A sign-in relayed by this computer's proxy for `from` (the last X-Forwarded-For hop); null: from this computer. */
const signIn = (name: string, token: string, from: string | null = null) => fetch(`${base}/login`, {
  method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual",
  headers: from === null ? {} : { "x-forwarded-for": from, "x-forwarded-proto": "https" },
});
const events = () => store.actionLedger({ repos: null, source: "sign-in", limit: 101 }).reverse().map(one => [one.actor, one.action, one.outcome]);

test("a source that got the password wrong five times is locked; the owner signs in from anywhere else", async () => {
  for (let i = 0; i < 5; i++) expect((await signIn("alex", "not-it", "203.0.113.5")).status).toBe(403);
  const locked = await signIn("alex", password, "203.0.113.5");
  expect(locked.status).toBe(429);
  expect(await locked.text()).toContain("Too many wrong passwords. Try again in 15 minutes.");
  // The owner, from a source that hasn't failed: a right password works, from another address and from this computer.
  expect((await signIn("alex", password, "198.51.100.7")).status).toBe(303);
  expect((await signIn("alex", password)).status).toBe(303);
  expect(authenticateApprover(store, "alex", password)).toEqual({ ok: true });
  // The attacker's lock stands, on every road from that source: a request's password bearer too.
  expect((await signIn("alex", password, "203.0.113.5")).status).toBe(429);
  const bearer = await fetch(`${base}/work`, { headers: { authorization: `Bearer alex:${password}`, "x-forwarded-for": "203.0.113.5", "x-forwarded-proto": "https" }, redirect: "manual" });
  expect(bearer.headers.get("location")).toMatch(/^\/login/);
  expect(events().filter(one => one[1] === "account locked")).toEqual([["alex", "account locked", "locked"]]);
});

test("guessing from rotating sources holds back each source that failed, never a clean one", async () => {
  for (let i = 1; i <= 5; i++) expect((await signIn("alex", "not-it", `203.0.113.${i}`)).status).toBe(403);
  // Each source failed once; the account is slowed, so even the right password from one of them waits (unchecked).
  const held = await signIn("alex", password, "203.0.113.1");
  expect(held.status).toBe(429);
  expect(await held.text()).toContain("Too many wrong passwords.");
  // A fresh source is still checked: a wrong password from it is refused as wrong, the right one signs in.
  expect((await signIn("alex", "not-it", "203.0.113.6")).status).toBe(403);
  expect((await signIn("alex", password, "198.51.100.7")).status).toBe(303);
  // The owner's sign-in ended the slowdown; a source with tries left is checked again.
  expect((await signIn("alex", password, "203.0.113.1")).status).toBe(303);
});

test("sign-in tries are counted per /64 for a native IPv6 caller, however it is spelled", async () => {
  for (let i = 0; i < 20; i++) expect((await signIn(`guess-${i}`, "x", `2001:db8:7:7::${(i + 1).toString(16)}`)).status).toBe(403);
  const spent = await signIn("alex", password, "2001:0DB8:0007:0007:ffff:ffff:ffff:fffe");
  expect(spent.status).toBe(429);
  expect(await spent.text()).toContain("Too many sign-in attempts.");
  expect((await signIn("alex", password, "2001:db8:7:8::1")).status).toBe(303);
});

test("join attempts are counted per /64", async () => {
  const join = (from: string) => fetch(`${base}/join/${"a".repeat(24)}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": from, "x-forwarded-proto": "https" }, body: new URLSearchParams({ name: "newcomer", password: "long-enough-password" }) });
  for (let i = 0; i < 10; i++) expect((await join(`2001:db8:9:1::${i + 1}`)).status).toBe(200);
  expect((await join("[2001:db8:9:1::ff]")).status).toBe(429);
  expect((await join("2001:db8:9:2::1")).status).toBe(200);
});

test("MCP sign-in's registration and pending-consent caps count per /64", async () => {
  const reg = (name: string, from: string) => fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": from, "x-forwarded-proto": "https" }, body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }) });
  for (let i = 0; i < OAUTH_LIMITS.clientsPerSource; i++) expect((await reg(`Client ${i}`, `2001:db8:a:1::${i + 1}`)).status).toBe(201);
  expect((await reg("Overflow", "2001:db8:a:1:ffff::1")).status).toBe(429);
  const other = await reg("Other /64", "2001:db8:a:2::1");
  expect(other.status).toBe(201);
  const client = ((await other.json()) as { client_id: string }).client_id;
  const url = new URL(`${base}/oauth/authorize`);
  url.search = new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: REDIRECT, code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: `${base}/mcp` }).toString();
  const start = (from: string) => fetch(url, { headers: { "x-forwarded-for": from, "x-forwarded-proto": "https" } });
  for (let i = 0; i < OAUTH_LIMITS.requestsPerSource; i++) expect((await start(`2001:db8:b:1::${i + 1}`)).status).toBe(200);
  expect((await start("2001:db8:b:1::abc")).status).toBe(429);
  expect((await start("2001:db8:b:2::1")).status).toBe(200);
});

/** A password-bearer's live team room from this computer, read as text until some event shows up or it ends. */
async function teamStream() {
  const controller = new AbortController();
  const response = await fetch(`${base}/live?room=team`, { headers: { authorization: `Bearer alex:${password}` }, signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(), decode = new TextDecoder();
  let seen = "";
  const until = async (text: string): Promise<{ seen: string; ended: boolean }> => {
    while (!seen.includes(text)) {
      const chunk = await reader.read();
      if (chunk.done) return { seen, ended: true };
      seen += decode.decode(chunk.value);
    }
    return { seen, ended: false };
  };
  const ended = async () => { for (;;) if ((await reader.read()).done) return true; };
  return { until, ended, stop: () => controller.abort() };
}

test("a password bearer on a long team stream proves its password again once the bounded interval passes", async () => {
  expect(TEAM_PASSWORD_REVERIFY_MS).toBeGreaterThan(0);
  expect(TEAM_PASSWORD_REVERIFY_MS).toBeLessThanOrEqual(15 * 60_000);
  const stream = await teamStream();
  expect((await stream.until("event: change")).ended).toBe(false);
  // The password stops being right, with no credential-generation bump to end the stream for it.
  const generation = store.accountOf("alex")!.generation;
  store.handle.prepare("UPDATE approver SET credential_hash = ? WHERE name = ?").run(hashPassword("a-different-password"), "alex");
  expect(store.accountOf("alex")!.generation).toBe(generation);
  // Once the interval passes, the next signal (any write) checks the password again, and the room ends.
  now = new Date(now.getTime() + TEAM_PASSWORD_REVERIFY_MS + 1);
  store.createTask({ id: "after-the-interval", title: "a write" }, now);
  const after = await stream.until("event: gone");
  expect(after.seen).toContain("event: gone");
  expect(await stream.ended()).toBe(true);
});

test("a credential-generation bump still ends a password bearer's stream at once, inside the interval", async () => {
  const stream = await teamStream();
  expect((await stream.until("event: change")).ended).toBe(false);
  // No time passes: the password proof still stands, and the generation check alone ends the room at the write's signal.
  store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = ?").run("alex");
  expect((await stream.until("event: gone")).seen).toContain("event: gone");
  expect(await stream.ended()).toBe(true);
});
