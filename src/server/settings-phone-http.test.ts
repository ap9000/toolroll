/**
 * Settings → Phone through the real console: the pairing's JSON (GET /settings/phone/pairings/:id) and Rename answer
 * exactly whom the page answers — an approver's own browser session, a project-limited one included; never a viewer,
 * an API token or a signed-out browser — and a rename needs the session's form token.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mintApiToken } from "../api-tokens.js";
import { setLimitOverride } from "../request-budget.js";
import { addApprover } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";

let store: Store, server: Server, base: string, dir: string, token = "";
const sessions: Record<"operator" | "limited" | "viewer", { cookie: string; csrf: string }> = {} as never;
const T0 = new Date();

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-phone-http-")));
  mkdirSync(join(dir, "config"));
  const repo = join(dir, "main");
  mkdirSync(repo);
  store = openStore(join(dir, "toolroll.db"));
  const alex = addApprover(store, "alex", T0); if (!alex.ok) throw new Error("bootstrap");
  const lim = addApprover(store, "lim", T0, { name: "alex", token: alex.token }); if (!lim.ok) throw new Error("limited");
  const vera = addApprover(store, "vera", T0, { name: "alex", token: alex.token }); if (!vera.ok) throw new Error("viewer");
  store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
  store.raw().prepare("UPDATE approver SET projects_json = ? WHERE name = 'lim'").run(JSON.stringify([repo]));
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: "act", secretHash: minted.hash, access: "act", expiresAt: new Date(T0.getTime() + 86_400_000).toISOString(), by: "alex" }, T0);
  token = minted.token;
  setLimitOverride(store, "*", { readPerMinute: 600, actPerMinute: 600, perDay: 10000 }, "alex", T0);
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo], configDir: join(dir, "config"), telegramTokenFile: join(dir, "config", "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [key, name, secret] of [["operator", "alex", alex.token], ["limited", "lim", lim.token], ["viewer", "vera", vera.token]] as const) {
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: secret }), redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await fetch(`${base}/settings/computers`, { headers: { cookie } })).text();
    sessions[key] = { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "" };
  }
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string>) => fetch(base + path, { headers, redirect: "manual" });
const post = (path: string, headers: Record<string, string>, form: Record<string, string>) => fetch(base + path, { method: "POST", redirect: "manual",
  headers: { ...headers, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
const PAIRING = "/settings/phone/pairings/pair_0123456789abcdef";

describe("the pairing's JSON", () => {
  test("an approver's own session reads it (none open here: not found, as JSON, never cached)", async () => {
    for (const who of [sessions.operator, sessions.limited]) {
      const answer = await get(PAIRING, { cookie: who.cookie });
      expect(answer.status).toBe(404);
      expect(answer.headers.get("content-type")).toMatch(/^application\/json/);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(await answer.json()).toEqual({ error: "not_found" });
    }
  });
  test("a viewer, an API token and a signed-out browser are refused, as on the page", async () => {
    for (const path of ["/settings/phone", PAIRING]) {
      expect((await get(path, { cookie: sessions.viewer.cookie })).status, path).toBe(403);
      expect((await get(path, { authorization: `Bearer ${token}` })).status, path).toBe(403);
      const anonymous = await get(path, {});
      expect(anonymous.headers.get("content-type") ?? "", path).not.toMatch(/json/);
      expect([200, 404], path).not.toContain(anonymous.status);
    }
  });
  test("an address that isn't a pairing id is no route", async () => {
    expect((await get("/settings/phone/pairings/a%2Fb", { cookie: sessions.operator.cookie })).status).toBe(404);
    expect((await get("/settings/phone/pairings/" + "a".repeat(129), { cookie: sessions.operator.cookie })).headers.get("content-type") ?? "").not.toMatch(/json/);
  });
});

describe("rename", () => {
  test("needs the session's form token; an unknown phone is the page's own 404", async () => {
    expect((await post("/settings/phone/rename", { cookie: sessions.operator.cookie }, { device: "dev-1", name: "Mine" })).status).toBe(403);
    const unknown = await post("/settings/phone/rename", { cookie: sessions.operator.cookie }, { csrf: sessions.operator.csrf, device: "dev-1", name: "Mine" });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("That phone isn&#39;t paired.");
    const limited = await post("/settings/phone/rename", { cookie: sessions.limited.cookie }, { csrf: sessions.limited.csrf, device: "dev-1", name: "Mine" });
    expect(limited.status).toBe(404);
  });
  test("a viewer and an API token are refused", async () => {
    expect((await post("/settings/phone/rename", { cookie: sessions.viewer.cookie }, { csrf: sessions.viewer.csrf, device: "dev-1", name: "Mine" })).status).toBe(403);
    expect((await post("/settings/phone/rename", { authorization: `Bearer ${token}` }, { device: "dev-1", name: "Mine" })).status).toBe(403);
  });
});
