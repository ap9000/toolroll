/**
 * Sprint 1 hardening (v99): wrong passwords lock a name, one address runs out
 * of tries across names, every road that takes a password counts, sign-ins
 * and policy changes are ledger events, a person's coordinators end with
 * their standing, and /healthz answers a probe.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover, authenticateApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { mintCoordinator } from "./coordinator.js";
import { formatLogLine } from "./log.js";
import { scanForSecrets } from "./evidence.js";

const T0 = new Date("2026-09-27T18:00:00.000Z");
let dir: string, store: Store, server: Server, base: string, password: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-hardening-"));
  store = openStore(join(dir, "orders.db"));
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap");
  password = added.token;
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const signIn = (name: string, token: string) => fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
const events = (source: string) => store.actionLedger({ repos: null, source, limit: 101 }).reverse().map(one => [one.actor, one.action, one.outcome]);

test("five wrong passwords lock the name (even the right one waits), each sign-in is an event, and a typed-in stranger's name stays out", async () => {
  for (let i = 0; i < 4; i++) expect((await signIn("alex", "not-it")).status).toBe(403);
  const fifth = await signIn("alex", "not-it");
  expect(fifth.status).toBe(403);
  const locked = await signIn("alex", password);
  expect(locked.status).toBe(429);
  expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(800);
  expect(await locked.text()).toContain("Too many wrong passwords. Try again in 15 minutes.");
  // The lock holds on every road that takes a password: a request's bearer, and a step-up inside the console.
  const bearer = await fetch(`${base}/work`, { headers: { authorization: `Bearer alex:${password}` }, redirect: "manual" });
  // A machine's refusal, never a login page, and it names the API token that replaces a password on a request (D7).
  expect(bearer.status).toBe(401);
  expect(await bearer.text()).toContain("toolroll tokens create");
  expect(authenticateApprover(store, "alex", password)).toEqual({ ok: false, reason: "not-an-approver" });
  // A name that isn't an account never lands in history as typed (it may be a password in the wrong box).
  expect((await signIn("hunter2-typed-as-a-name", "x")).status).toBe(403);
  expect(events("sign-in")).toEqual([
    ...Array(4).fill(["alex", "sign-in refused", "wrong password"]),
    // The fifth wrong password locks the name as it's checked, then is refused.
    ["alex", "account locked", "locked"],
    ["alex", "sign-in refused", "wrong password"],
    ["alex", "sign-in refused", "locked"],
    ["unknown account", "sign-in refused", "wrong password"],
  ]);
  expect(store.actionLedger({ repos: null, source: "sign-in" }).find(one => one.action === "account locked")?.detail).toBe("5 wrong passwords in a row; locked for 15 minutes");
});

test("one address runs out of tries across many names, and a right password clears a name's count", async () => {
  for (let i = 0; i < 3; i++) expect((await signIn("alex", "not-it")).status).toBe(403);
  const ok = await signIn("alex", password);
  expect(ok.status).toBe(303);
  expect(events("sign-in").at(-1)).toEqual(["alex", "signed in", "browser"]);
  // The count cleared: four more wrong ones don't lock it.
  for (let i = 0; i < 4; i++) await signIn("alex", "not-it");
  expect((await signIn("alex", password)).status).toBe(303);
  // Twenty wrong tries from one address, over many names, and the address waits (a right password included).
  for (let i = 0; i < 13; i++) await signIn(`guess-${i}`, "x");
  const spent = await signIn("alex", password);
  expect(spent.status).toBe(429);
  expect(await spent.text()).toContain("Too many sign-in attempts.");
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  // An instance operator reads the events that belong to no project, on a server that serves a set of projects.
  const history = await (await fetch(`${base}/ledger?format=json&source=sign-in`, { headers: { cookie } })).text();
  expect(history).toContain('"signed in"');
  // Signing out is an event too.
  await fetch(`${base}/logout`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual" });
  expect(events("sign-in").filter(one => one[1] === "signed out")).toEqual([["alex", "signed out", "browser"]]);
});

test("/healthz answers a probe from any address with nothing but its status", async () => {
  const answer = await fetch(`${base}/healthz`, { headers: { host: "10.0.0.7:8080" } });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ status: "ok" });
  expect((await fetch(`${base}/healthz`, { method: "HEAD" })).status).toBe(200);
});

test("policy changes are ledger events with what changed, and a person's coordinators end with their standing", () => {
  store.setPermissionDefault("bypassPermissions", "alex", T0);
  store.setPermissionDefault("bypassPermissions", "alex", T0); // no change: nothing kept
  store.setQualityDefault("strict", "alex", T0);
  store.setPhaseConfig("installation", "build", "codex", "gpt-5", "alex", T0);
  expect(store.actionLedger({ repos: null, source: "policy" }).reverse().map(one => [one.action, one.detail])).toEqual([
    ["permission default changed", "Auto → Full access"],
    ["quality default changed", "Default → Strict / release"],
    ["agent for build changed", expect.stringMatching(/ → codex · gpt-5$/)],
  ]);
  const second = addApprover(store, "sam", T0, { name: "alex", token: password });
  if (!second.ok) throw new Error("second");
  const made = mintCoordinator(store, { name: "sams-bot", repos: ["/repo/main"], perHour: 6, by: "sam", now: T0 });
  if (!made.ok) throw new Error(JSON.stringify(made));
  expect(store.revokeAccount("sam", "alex", T0)).toMatchObject({ ok: true });
  expect(store.handle.prepare("SELECT revoked_at FROM credential WHERE kind = 'coordinator' AND name = 'sams-bot'").get()?.["revoked_at"]).toBe(T0.toISOString());
  expect(store.actionLedger({ repos: null, source: "access" }).map(one => [one.action, one.detail])).toContainEqual(["coordinator revoked: sams-bot", "made by sam"]);
});

test("log lines say the event and its facts, and never carry key-shaped text", () => {
  const key = ["sk", "live", "a".repeat(28)].join("_");
  expect(formatLogLine("error", "serve.error", { path: "/work", error: `boom ${key}` }, T0, false)).toBe('2026-09-27T18:00:00.000Z error serve.error path=/work error="[redacted: key-shaped text]"');
  expect(JSON.parse(formatLogLine("warn", "sign-in.locked", { account: "alex", minutes: 15 }, T0, true))).toEqual({ at: T0.toISOString(), level: "warn", event: "sign-in.locked", account: "alex", minutes: 15 });
  // The shapes teams paste most are caught; ordinary words aren't.
  for (const secret of [key, `AIza${"B".repeat(35)}`, `glpat-${"c".repeat(20)}`, `8929217973:AA${"d".repeat(33)}`, "postgres://app:s3cret-pw@db.internal/app"]) expect(scanForSecrets(secret), secret).toHaveLength(1);
  for (const plain of ["meet at 10:30", "https://github.com/ap9000/standing-orders", "put the sk_live key on the Tools page"]) expect(scanForSecrets(plain), plain).toHaveLength(0);
});
