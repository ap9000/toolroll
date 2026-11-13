/**
 * Settings → Advanced through the console (the eight plan, W4 v2/v3): POST /settings/advanced is a browser sign-in's own
 * view switch. The account is the session's; one strict on/off; viewers, project-limited people and the local owner set
 * their own; an API token, a missing Origin and an ended session change nothing; reading the page writes nothing.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintApiToken } from "./api-tokens.js";
import type { BrowserWorkspace } from "./browser-workspace.js";
import { addApprover } from "./scope.js";
import { advancedPreferenceOf, initLocalMode, openStore, type Store } from "./store.js";
import { createDecisionServer, type DecisionServer } from "./serve.js";

let dir: string, store: Store, server: DecisionServer, base: string;
const passwords: Record<string, string> = {};
async function start(): Promise<void> {
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", configDir: dir });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "so-advanced-")); });
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const cookieOf = (answer: Response) => answer.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
const rail = async (cookie: string) => ((await (await fetch(`${base}/tasks?format=workspace`, { headers: { cookie } })).json()) as BrowserWorkspace).navigation.map(one => one.label);
const ledgerRows = () => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM view_preference").get()?.["n"]);
async function signIn(name: string) {
  const cookie = cookieOf(await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: passwords[name]! }), redirect: "manual" }));
  const page = await (await fetch(`${base}/settings/advanced`, { headers: { cookie } })).text();
  const csrf = csrfOf(page);
  const post = (body: string, headers: Record<string, string> = { origin: base }) =>
    fetch(`${base}/settings/advanced`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers }, redirect: "manual", body: `csrf=${csrf}&${body}` });
  return { cookie, page, post };
}

test("a person's own switch: off by default after the upgrade, theirs only, strict, never from a token, and quiet to read", async () => {
  store = openStore(join(dir, "orders.db"));
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("fixture");
  passwords["alex"] = alex.token;
  const vic = addApprover(store, "vic", new Date(), { name: "alex", token: alex.token });
  if (!vic.ok) throw new Error("fixture");
  passwords["vic"] = vic.token;
  // A viewer limited to one project.
  store.handle.prepare("UPDATE approver SET role = 'viewer', projects_json = '[\"/repo/main\"]' WHERE name = 'vic'").run();
  await start();

  const a = await signIn("alex");
  // Reading the page (and HEAD) writes nothing; the page lists the switch and every advanced page.
  expect(a.page).toContain("Show advanced features");
  expect(a.page).toContain("href=\"/flows\"");
  await fetch(`${base}/settings/advanced`, { method: "HEAD", headers: { cookie: a.cookie } });
  expect(ledgerRows()).toBe(0);
  expect(await rail(a.cookie)).toEqual(["Home", "Chat", "Tasks", "Projects", "Settings"]);

  // Strict: one field, on or off; a duplicate or anything else is refused and changes nothing.
  expect((await a.post("advanced=on&advanced=off")).status).toBe(400);
  expect((await a.post("advanced=yes")).status).toBe(400);
  expect((await a.post("")).status).toBe(400);
  // Another site's Origin, or no form token: the shared mutation guard refuses it.
  expect((await a.post("advanced=on", { origin: "http://evil.example" })).status).toBeGreaterThanOrEqual(400);
  expect((await fetch(`${base}/settings/advanced`, { method: "POST", headers: { cookie: a.cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ advanced: "on" }) })).status).toBeGreaterThanOrEqual(400);
  expect(ledgerRows()).toBe(0);

  // The account is the session's: a forged account field changes nothing for anyone else.
  const on = await a.post("advanced=on&account=vic&name=vic");
  expect(on.status).toBe(303);
  expect(on.headers.get("location")).toMatch(/^\/settings\/advanced\?said=/);
  expect(advancedPreferenceOf(store, "alex")).toBe(true);
  expect(advancedPreferenceOf(store, "vic")).toBeNull();
  expect(await rail(a.cookie)).toEqual(["Home", "Chat", "Tasks", "Flows", "Agents", "Projects", "Settings"]);

  // A viewer limited to one project sets their own, and only their own.
  const v = await signIn("vic");
  expect((await v.post("advanced=on")).status).toBe(303);
  expect(advancedPreferenceOf(store, "vic")).toBe(true);
  expect((await v.post("advanced=off")).status).toBe(303);
  expect(advancedPreferenceOf(store, "vic")).toBe(false);
  expect(advancedPreferenceOf(store, "alex")).toBe(true);

  // An API token is refused (browser sign-in only), even an `act` one.
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: "ci", secretHash: minted.hash, access: "act", expiresAt: "2099-01-01T00:00:00.000Z", by: "alex" }, new Date());
  const bearer = await fetch(`${base}/settings/advanced`, { method: "POST", headers: { authorization: `Bearer ${minted.token}`, origin: base }, redirect: "manual", body: new URLSearchParams({ advanced: "off" }) });
  expect(bearer.status).toBe(403);
  expect(advancedPreferenceOf(store, "alex")).toBe(true);

  // A session that ended changes nothing.
  await fetch(`${base}/logout`, { method: "POST", headers: { cookie: a.cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf: csrfOf(a.page) }) });
  expect((await a.post("advanced=off")).status).not.toBe(303);
  expect(advancedPreferenceOf(store, "alex")).toBe(true);
});

test("the local owner changes and keeps it before setting any password", async () => {
  store = openStore(join(dir, "laptop.db"), { createdBy: "laptop" });
  expect(initLocalMode(store, { owner: "alex", fenceAvailable: true, now: new Date() }).ok).toBe(true);
  await start();
  const link = server.mintLocalLink()!;
  const cookie = cookieOf(await fetch(`${base}${link}`, { redirect: "manual" }));
  expect(await rail(cookie)).toEqual(["Home", "Chat", "Tasks", "Projects", "Settings"]);
  const page = await (await fetch(`${base}/settings/advanced`, { headers: { cookie } })).text();
  const posted = await fetch(`${base}/settings/advanced`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf: csrfOf(page), advanced: "on" }) });
  expect(posted.status).toBe(303);
  expect(store.accountOf("alex")?.passwordSet).toBe(false);
  expect(advancedPreferenceOf(store, "alex")).toBe(true);
  expect(await rail(cookie)).toContain("Flows");
});
