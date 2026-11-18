/**
 * Settings → General: "Your Claude sign-in for threads" over HTTP (settings.ts flexibleSignInAct / Check / Clear,
 * settings-sections.ts flexibleSignInSection, People's operator removal). Each person's own: saved as a credential act
 * (the live check against a scripted stand-in upstream), never echoed, never anyone else's; checked again and removed
 * with the ordinary step-up; an instance operator removes someone else's from People, never reading or setting it; a
 * laptop owner with no password hears how to set one. Isolated stores, made-up tokens, no model.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addApprover } from "../scope.js";
import { mintApiToken } from "../api-tokens.js";
import { createDecisionServer } from "../serve.js";
import { setFlexibleSetting } from "../flexible-available.js";
import { flexibleSignInStatus } from "../flexible-sign-in.js";
import { threadWorld, type ThreadWorld } from "../../test/flexible-thread-world.js";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS } from "../../test/local-owner-world.js";
import { standInToken } from "../../test/flexible-sign-in-kit.js";

const scripted = vi.hoisted(() => ({ origin: "http://127.0.0.1:9", calls: 0, status: 200 }));
vi.mock("../flexible-relay-upstreams.js", async importOriginal => {
  const real = await importOriginal<typeof import("../flexible-relay-upstreams.js")>();
  return { FLEXIBLE_RELAY_UPSTREAMS: { claude: { ...real.FLEXIBLE_RELAY_UPSTREAMS.claude, get origin() { return scripted.origin; } } } };
});

const NOW = new Date();
let world: ThreadWorld, server: Server, upstream: Server, base: string, actToken: string;
const people: Record<string, { password: string; cookie: string; csrf: string }> = {};

beforeAll(async () => {
  upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      scripted.calls++;
      response.writeHead(scripted.status, { "content-type": "application/json" })
        .end(scripted.status === 200 ? JSON.stringify({ input_tokens: 2 }) : JSON.stringify({ type: "error", error: { type: "authentication_error", message: "nope" } }));
    });
  });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", () => done()));
  scripted.origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  world = threadWorld();
  const alex = addApprover(world.store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const pat = addApprover(world.store, "pat", NOW, { name: "alex", token: alex.token });
  if (!pat.ok) throw new Error("pat");
  // pat: an approver of one project only (so never an instance operator).
  expect(world.store.setAccountProjects("pat", [world.project], "alex", NOW)).toEqual({ ok: true });
  setFlexibleSetting(world.store, true, "alex", NOW);
  const minted = mintApiToken();
  world.store.createApiToken({ id: minted.id, account: "alex", name: "act", secretHash: minted.hash, access: "act", expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(), by: "alex" }, NOW);
  actToken = minted.token;
  mkdirSync(join(world.dir, "config"));
  server = createDecisionServer({ store: world.store, evidenceRoot: join(world.dir, "evidence"), repos: [world.project], clock: () => new Date(), configDir: join(world.dir, "config"),
    telegramTokenFile: join(world.dir, "config", "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [name, password] of [["alex", alex.token], ["pat", pat.token]] as const) {
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: password }), redirect: "manual" });
    const cookie = login.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/settings/general`, { headers: { cookie } })).text())![1]!;
    people[name] = { password, cookie, csrf };
    // No remembered password: each step-up below stands on the password typed for it.
    await post(name, "/session/forget-password", { return: "/settings/general" });
  }
}, 60_000);
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  upstream.closeAllConnections();
  await new Promise(done => upstream.close(done));
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

function post(name: string, path: string, fields: Record<string, string> | URLSearchParams) {
  const person = people[name]!;
  const body = fields instanceof URLSearchParams ? fields : new URLSearchParams(fields);
  body.set("csrf", person.csrf);
  return fetch(base + path, { method: "POST", headers: { cookie: person.cookie, origin: base }, redirect: "manual", body });
}
const page = async (name: string, path: string) => (await fetch(base + path, { headers: { cookie: people[name]!.cookie } })).text();
const said = (answer: Response) => decodeURIComponent(answer.headers.get("location") ?? "").replace(/\+/g, " ");
const rows = (person: string) => world.store.handle.prepare("SELECT state FROM flexible_sign_in WHERE person = ? ORDER BY staged_at").all(person).map(row => row["state"]);

describe("your own sign-in, from the browser", () => {
  test("added with the password typed now and the live check's words; replaced; never echoed, never pre-filled; anything else is refused with nothing kept", async () => {
    const general = await page("alex", "/settings/general");
    expect(general).toContain('data-section="flexible-sign-in"');
    expect(general).toContain('href="/settings/change/flexible-sign-in"');
    const form = await page("alex", "/settings/change/flexible-sign-in");
    expect(form).toContain('action="/settings/flexible-sign-in"');
    expect(form).toMatch(/<input[^>]*name="token"[^>]*type="password"/);
    expect(form).toContain('name="password"');
    const first = standInToken();
    // Refused, nothing kept, nothing sent: no or a wrong password, a person field, a doubled field, an API key, garbage.
    const refusals: [Record<string, string> | URLSearchParams, RegExp][] = [
      [{ token: first, password: "" }, /needs your Toolroll password/],
      [{ token: first, password: "not-it" }, /needs your Toolroll password/],
      [{ token: first, password: people["alex"]!.password, person: "pat" }, /always your own/],
      [new URLSearchParams([["token", first], ["token", standInToken()], ["password", people["alex"]!.password]]), /sent twice/],
      [{ token: ["sk", "ant", "api03", "z".repeat(40)].join("-"), password: people["alex"]!.password }, /That's an API key/],
      [{ token: "garbage", password: people["alex"]!.password }, /doesn't look like a token/],
    ];
    for (const [fields, words] of refusals) {
      const answer = await post("alex", "/settings/flexible-sign-in", fields);
      // A doubled field may already be refused by the console's own form guard, before the handler's words.
      if (said(answer) !== "" || words.source !== "sent twice") {
        expect(said(answer), String(words)).toMatch(/^\/settings\/change\/flexible-sign-in\?problem=/);
        expect(said(answer)).toMatch(words);
      } else expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(said(answer)).not.toContain(first.slice(14, 30));
      expect(said(answer)).not.toContain("z".repeat(8));
    }
    expect(rows("alex")).toEqual([]);
    expect(rows("pat")).toEqual([]);
    expect(scripted.calls).toBe(0);
    // A token (this person's own, able to act) never reaches the route.
    const bearer = await fetch(`${base}/settings/flexible-sign-in`, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${actToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: first, password: people["alex"]!.password }) });
    expect(bearer.status).toBeGreaterThanOrEqual(400);
    expect(rows("alex")).toEqual([]);
    // Saved: one live check after the password was proved, its words said back.
    expect(said(await post("alex", "/settings/flexible-sign-in", { token: first, password: people["alex"]!.password }))).toBe("/settings/general?section=flexible-sign-in&said=Saved. Token-count check accepted.");
    expect(scripted.calls).toBe(1);
    expect(flexibleSignInStatus(world.store, "alex")).toMatchObject({ state: "active", checkOutcome: "accepted" });
    const shown = await page("alex", "/settings/general");
    expect(shown).toContain("Token-count check accepted.");
    expect(shown).toContain(">Replace<");
    // The form again never carries the value (and never did); the page never does either.
    expect(await page("alex", "/settings/change/flexible-sign-in")).not.toContain(first.slice(14, 30));
    expect(shown).not.toContain(first.slice(14, 30));
    // Claude refusing a replacement keeps the working one.
    scripted.status = 401;
    expect(said(await post("alex", "/settings/flexible-sign-in", { token: standInToken(), password: people["alex"]!.password }))).toMatch(/problem=Claude didn't accept this sign-in/);
    scripted.status = 200;
    expect(flexibleSignInStatus(world.store, "alex")).toMatchObject({ state: "active" });
    expect(said(await post("alex", "/settings/flexible-sign-in", { token: standInToken(), password: people["alex"]!.password }))).toContain("said=Replaced. Token-count check accepted.");
    expect(rows("alex").filter(state => state === "active")).toHaveLength(1);
    // Nothing of any token in the ledger.
    expect(JSON.stringify(world.store.handle.prepare("SELECT * FROM action_ledger").all())).not.toContain(first.slice(14, 30));
  });

  test("check again and remove: your own with the step-up; checking changes nothing else", async () => {
    const calls = scripted.calls;
    expect(said(await post("alex", "/settings/flexible-sign-in-check", { password: "not-it" }))).toMatch(/problem=Enter your Toolroll password/);
    expect(scripted.calls).toBe(calls);
    expect(said(await post("alex", "/settings/flexible-sign-in-check", { password: people["alex"]!.password }))).toBe("/settings/general?section=flexible-sign-in&said=Token-count check accepted.");
    expect(scripted.calls).toBe(calls + 1);
    expect(await page("alex", "/settings/change/flexible-sign-in-clear")).toContain('action="/settings/flexible-sign-in-clear"');
    expect(said(await post("alex", "/settings/flexible-sign-in-clear", { password: "not-it" }))).toMatch(/problem=/);
    expect(flexibleSignInStatus(world.store, "alex").state).toBe("active");
    expect(said(await post("alex", "/settings/flexible-sign-in-clear", { password: people["alex"]!.password }))).toContain("said=Removed. Your threads can't reach Claude until you add one again.");
    expect(flexibleSignInStatus(world.store, "alex").state).toBe("none");
  });

  test("People: an instance operator removes someone else's sign-in (never reads or sets it); someone else can't remove yours", async () => {
    expect(said(await post("pat", "/settings/flexible-sign-in", { token: standInToken(), password: people["pat"]!.password }))).toContain("said=Saved.");
    expect(said(await post("alex", "/settings/flexible-sign-in", { token: standInToken(), password: people["alex"]!.password }))).toContain("said=Saved.");
    // pat isn't an operator: alex's stays.
    expect(said(await post("pat", "/settings/flexible-sign-in-clear", { person: "alex", password: people["pat"]!.password }))).toMatch(/problem=An instance operator removes/);
    expect(flexibleSignInStatus(world.store, "alex").state).toBe("active");
    const roster = await page("alex", "/people");
    expect(roster).toContain("Remove their Claude sign-in for threads");
    expect(roster).toContain('name="person" value="pat"');
    expect(said(await post("alex", "/settings/flexible-sign-in-clear", { person: "pat", password: people["alex"]!.password }))).toContain("said=Removed pat's Claude sign-in for threads.");
    expect(flexibleSignInStatus(world.store, "pat").state).toBe("none");
    expect(flexibleSignInStatus(world.store, "alex").state).toBe("active");
    // Removing a person retires their sign-in in the same transaction (not only when it stops counting).
    expect(said(await post("pat", "/settings/flexible-sign-in", { token: standInToken(), password: people["pat"]!.password }))).toContain("said=Saved.");
    expect(world.store.revokeAccount("pat", "alex", new Date())).toMatchObject({ ok: true });
    expect(rows("pat").every(state => state === "retiring")).toBe(true);
  });
});

test("a laptop's owner with no password: the sign-in document and the switch's turn-on document say how to set one, with no form", async () => {
  const laptop = await openLocalWorld();
  try {
    const { cookie } = await laptop.localSession();
    const signIn = (await laptop.send("/settings/change/flexible-sign-in", "GET", { cookie })).body;
    expect(signIn).toContain("This needs a Toolroll password, and you haven't set one.");
    expect(signIn).toContain("toolroll password set");
    expect(signIn).not.toContain('action="/settings/flexible-sign-in"');
    const turnOn = (await laptop.send("/settings/change/flexible", "GET", { cookie })).body;
    expect(turnOn).toContain("This needs a Toolroll password, and you haven't set one.");
    expect(turnOn).not.toContain('action="/settings/flexible"');
  } finally { await laptop.close(); }
}, LOCAL_WORLD_SETUP_MS);
