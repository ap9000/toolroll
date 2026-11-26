/**
 * Settings → Updates → "Update automatically" (auto-update.ts), the authority matrix over the real console: off by
 * default; only an unrestricted instance operator's browser step-up turns it on or off (a team needs the password typed
 * now; a solo session stands in until Passwordless is explicitly turned off), written with its ledger row; never a token,
 * a viewer, a project-limited operator, a session whose access changed, or the laptop's local owner. Isolated stores and
 * fixture sessions only: nothing here reaches this machine's updater, services or registry.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { autoUpdatePolicy, setAutoUpdatePolicy } from "./auto-update.js";
import { mintApiToken } from "./api-tokens.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore, type Store } from "./store.js";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS } from "../test/local-owner-world.js";

const NOW = new Date();
const ledger = (store: Store) => store.handle.prepare("SELECT actor, outcome, detail FROM action_ledger WHERE action = 'automatic updates' ORDER BY id").all().map(row => ({ ...row }));

describe("Update automatically, through the console", () => {
  let dir: string, store: Store, server: Server, base: string, actToken: string;
  const people: Record<string, { password: string; cookie: string; csrf: string }> = {};
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "toolroll-auto-switch-"));
    store = openStore(join(dir, "orders.db"));
    for (const name of ["alex", "pat", "vic", "lee"]) {
      const made = addApprover(store, name, NOW, name === "alex" ? undefined : { name: "alex", token: people["alex"]!.password });
      if (!made.ok) throw new Error(name);
      people[name] = { password: made.token, cookie: "", csrf: "" };
    }
    // pat: an operator limited to one project; vic: a viewer; lee: revoked after signing in.
    expect(store.setAccountProjects("pat", ["/somewhere/shop"], "alex", NOW)).toEqual({ ok: true });
    store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vic'").run();
    const minted = mintApiToken();
    store.createApiToken({ id: minted.id, account: "alex", name: "act", secretHash: minted.hash, access: "act", expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(), by: "alex" }, NOW);
    actToken = minted.token;
    mkdirSync(join(dir, "config"));
    server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), clock: () => new Date(), configDir: join(dir, "config"),
      updates: { method: { kind: "managed", updateCommand: "toolroll update" }, current: "0.9.120", launch: async () => { throw new Error("no update runs in this test"); } } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const name of Object.keys(people)) {
      const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: people[name]!.password }), redirect: "manual" });
      people[name]!.cookie = login.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      people[name]!.csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/settings/general`, { headers: { cookie: people[name]!.cookie } })).text())![1]!;
      // No remembered password: each step-up stands on the mode alone or the password typed for it.
      expect((await post(name, "/session/forget-password", { return: "/settings/general" })).status).toBe(303);
    }
  }, 60_000);
  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function post(name: string, path: string, fields: Record<string, string>) {
    const one = people[name]!;
    return fetch(base + path, { method: "POST", headers: { cookie: one.cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf: one.csrf, ...fields }) });
  }
  const said = (answer: Response) => decodeURIComponent(answer.headers.get("location") ?? "").replace(/\+/g, " ");
  const on = () => autoUpdatePolicy(store)?.on;

  test("off by default, shown on Settings → Updates with its one line and a Turn on behind the step-up", async () => {
    expect(autoUpdatePolicy(store)).toEqual({ on: false, revision: 0, by: null, at: null });
    const page = await (await fetch(`${base}/settings/updates`, { headers: { cookie: people["alex"]!.cookie } })).text();
    expect(page).toContain('data-update-auto="off"');
    expect(page).toContain('action="/settings/updates/auto"');
    expect(page).toMatch(/name="enabled" value="on"/);
  });

  test("a team install: only the password typed now; a token, a viewer, a limited operator and a changed account never", async () => {
    for (const typed of ["", "not-it"]) {
      expect(said(await post("alex", "/settings/updates/auto", { enabled: "on", password: typed }))).toContain("problem=Enter your Toolroll password to change automatic updates.");
    }
    expect(said(await post("alex", "/settings/updates/auto", { enabled: "maybe", password: people["alex"]!.password }))).toContain("Choose on or off");
    // The person's own token able to act, password and all, is refused at the door.
    const token = await fetch(`${base}/settings/updates/auto`, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${actToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ enabled: "on", password: people["alex"]!.password }) });
    expect(token.status).toBeGreaterThanOrEqual(400);
    for (const name of ["pat", "vic"]) {
      const refused = await post(name, "/settings/updates/auto", { enabled: "on", password: people[name]!.password });
      expect(refused.status === 403 || said(refused).includes("problem="), `${name} ${refused.status} ${said(refused)}`).toBe(true);
    }
    // lee signed in as an operator, then was revoked: the session no longer stands.
    expect(store.revokeAccount("lee", "alex", NOW)).toMatchObject({ ok: true });
    const revoked = await post("lee", "/settings/updates/auto", { enabled: "on", password: people["lee"]!.password });
    expect(`${revoked.status} ${said(revoked)}`).not.toContain("said=");
    expect(on()).toBe(false);
    expect(ledger(store)).toEqual([]);
    expect(said(await post("alex", "/settings/updates/auto", { enabled: "on", password: people["alex"]!.password }))).toContain("said=Automatic updates are on.");
    expect(autoUpdatePolicy(store)).toMatchObject({ on: true, revision: 1, by: "alex" });
    expect(said(await post("alex", "/settings/updates/auto", { enabled: "off", password: people["alex"]!.password }))).toContain("said=Automatic updates are off.");
    expect(autoUpdatePolicy(store)).toMatchObject({ on: false, revision: 2, by: "alex" });
    expect(ledger(store)).toEqual([{ actor: "alex", outcome: "on", detail: "revision 1" }, { actor: "alex", outcome: "off", detail: "revision 2" }]);
    expect((await post("alex", "/session/forget-password", { return: "/settings/general" })).status).toBe(303);
  });

  test("solo: the operator's own live session stands in; once Passwordless is turned off, the password again", async () => {
    // Solo needs exactly one person: the others go first.
    for (const name of ["pat", "vic"]) expect(store.revokeAccount(name, "alex", NOW)).toMatchObject({ ok: true });
    expect(said(await post("alex", "/settings/install-mode/solo", { password: people["alex"]!.password }))).not.toContain("problem");
    expect((await post("alex", "/session/forget-password", { return: "/settings/general" })).status).toBe(303);
    expect(said(await post("alex", "/settings/updates/auto", { enabled: "on", password: "" }))).toContain("said=Automatic updates are on.");
    expect(on()).toBe(true);
    expect(said(await post("alex", "/settings/passwordless", { action: "off" }))).toContain("Passwordless is off");
    expect(said(await post("alex", "/settings/updates/auto", { enabled: "off", password: "" }))).toContain("problem=Enter your Toolroll password");
    expect(on()).toBe(true);
    expect(said(await post("alex", "/settings/updates/auto", { enabled: "off", password: people["alex"]!.password }))).toContain("said=Automatic updates are off.");
    expect(on()).toBe(false);
  });
});

test("the laptop's local owner (no password) can't turn automatic updates on: no local-owner act names it", async () => {
  const laptop = await openLocalWorld({ updates: { method: { kind: "managed", updateCommand: "toolroll update" }, current: "0.9.120" } });
  try {
    const { cookie, csrf } = await laptop.localSession();
    const answer = await laptop.post("/settings/updates/auto", cookie, { csrf, enabled: "on", password: "" });
    expect(answer.status === 403 || decodeURIComponent(String(answer.headers.location ?? "")).includes("problem="), String(answer.status)).toBe(true);
    expect(autoUpdatePolicy(laptop.store)).toEqual({ on: false, revision: 0, by: null, at: null });
  } finally { await laptop.close(); }
}, LOCAL_WORLD_SETUP_MS);
