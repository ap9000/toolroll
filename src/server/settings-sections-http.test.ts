/**
 * Settings → General through the real console (the eight settings plan, F0): each persona reads the sections it reads
 * today; the one canonical project is decided before any section loads (two is a 400, unknown and foreign are the same
 * 404, and nothing is read for either); the old /settings/advanced is a permanent redirect to General's Advanced
 * section with no fragment; a change document is its own sensitive document; the switch returns to its section.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mintApiToken } from "../api-tokens.js";
import { setLimitOverride } from "../request-budget.js";
import { addApprover } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";
import { PACKAGE_VERSION } from "../version.js";
import { PROJECT_NOT_AVAILABLE } from "./settings-sections.js";

let store: Store, server: Server, base: string, dir: string, repo: string, other: string, token = "";
const sessions: Record<"operator" | "limited" | "viewer", { cookie: string; csrf: string }> = {} as never;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-sections-")));
  mkdirSync(join(dir, "config"));
  repo = join(dir, "main"); other = join(dir, "other");
  mkdirSync(repo); mkdirSync(other);
  store = openStore(join(dir, "toolroll.db"));
  const now = new Date();
  const alex = addApprover(store, "alex", now); if (!alex.ok) throw new Error("bootstrap");
  const lim = addApprover(store, "lim", now, { name: "alex", token: alex.token }); if (!lim.ok) throw new Error("limited");
  const vera = addApprover(store, "vera", now, { name: "alex", token: alex.token }); if (!vera.ok) throw new Error("viewer");
  store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
  store.raw().prepare("UPDATE approver SET projects_json = ? WHERE name = 'lim'").run(JSON.stringify([repo]));
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: "read", secretHash: minted.hash, access: "read", expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), by: "alex" }, now);
  token = minted.token;
  setLimitOverride(store, "*", { readPerMinute: 600, actPerMinute: 600, perDay: 10000 }, "alex", now);
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo, other], configDir: join(dir, "config"), telegramTokenFile: join(dir, "config", "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [key, name, password] of [["operator", "alex", alex.token], ["limited", "lim", lim.token], ["viewer", "vera", vera.token]] as const) {
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: password }), redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await fetch(`${base}/settings/general`, { headers: { cookie } })).text();
    sessions[key] = { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "" };
  }
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string>) => fetch(base + path, { headers, redirect: "manual" });
const sectionsOf = (page: string) => [...page.matchAll(/data-section="([a-z-]+)"/g)].map(match => match[1]);

describe("General, per persona", () => {
  test("each reads what it reads today, and an API token reads without the controls", async () => {
    const read = async (headers: Record<string, string>) => { const answer = await get("/settings/general", headers); expect(answer.status).toBe(200); return answer.text(); };
    const operator = await read({ cookie: sessions.operator.cookie });
    expect(sectionsOf(operator)).toEqual(["appearance", "this-browser", "your-password", "version", "advanced"]);
    const viewer = await read({ cookie: sessions.viewer.cookie });
    expect(sectionsOf(viewer)).toEqual(["appearance", "this-browser", "your-password", "version", "advanced"]);
    expect(viewer).toContain("Forget now");
    expect(viewer).toContain('action="/settings/advanced"');
    const limited = await read({ cookie: sessions.limited.cookie });
    expect(sectionsOf(limited)).toEqual(["appearance", "this-browser", "your-password", "advanced"]);
    expect(limited).not.toContain("/settings/passwordless");
    const bearer = await read({ authorization: `Bearer ${token}` });
    expect(sectionsOf(bearer)).toEqual(["appearance", "this-browser", "your-password", "version", "advanced"]);
    expect(bearer).not.toContain("Forget now");
    expect(bearer).not.toContain('action="/settings/advanced"');
  });

  test("the asked section: its detail, and where it is said once at the top", async () => {
    const page = await (await get("/settings/general?section=advanced&open=1", { cookie: sessions.viewer.cookie })).text();
    expect(page).toContain('href="#advanced">Jump to Show advanced features</a>');
    expect(page).toMatch(/data-section="advanced" tabindex="-1"/);
    expect(page).toContain('href="/flows"');
    // Operator-only pages only to an operator.
    expect(page).not.toContain('href="/settings/monitoring"');
    expect(await (await get("/settings/general?section=advanced&open=1", { cookie: sessions.operator.cookie })).text()).toContain('href="/settings/monitoring"');
    const plain = await (await get("/settings/general", { cookie: sessions.viewer.cookie })).text();
    expect(plain).not.toContain('href="/flows"');
    expect(plain).not.toContain("Jump to");
  });
});

describe("General without installation data (no Telegram file)", () => {
  test("an instance operator still reads the version Toolroll runs; a viewer has none to read", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "so-sections-bare-")));
    const plain = openStore(":memory:");
    try {
      const alex = addApprover(plain, "alex", new Date()); if (!alex.ok) throw new Error("bootstrap");
      const vera = addApprover(plain, "vera", new Date(), { name: "alex", token: alex.token }); if (!vera.ok) throw new Error("viewer");
      plain.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
      const console_ = createDecisionServer({ store: plain, evidenceRoot: join(bare, "evidence"), repo: join(bare, "main") });
      await new Promise<void>(resolve => console_.listen(0, "127.0.0.1", resolve));
      const at = `http://127.0.0.1:${(console_.address() as { port: number }).port}`;
      try {
        const page = async (name: string, password: string) => {
          const login = await fetch(`${at}/login`, { method: "POST", body: new URLSearchParams({ name, token: password }), redirect: "manual" });
          return (await fetch(`${at}/settings/general`, { headers: { cookie: (login.headers.get("set-cookie") ?? "").split(";")[0]! } })).text();
        };
        const operator = await page("alex", alex.token);
        expect(sectionsOf(operator)).toContain("version");
        expect(operator).toContain(PACKAGE_VERSION);
        expect(sectionsOf(await page("vera", vera.token))).not.toContain("version");
      } finally { await new Promise<void>(resolve => console_.close(() => resolve())); }
    } finally { plain.close(); rmSync(bare, { recursive: true, force: true }); }
  });
});

describe("one canonical project, decided before any section loads", () => {
  test("two is a 400; unknown and foreign are one 404 with the same words; nothing is read for either", async () => {
    const reads = vi.spyOn(store, "firstSuccessAt");
    try {
      const both = await get(`/settings/general?repo=${encodeURIComponent(repo)}&repo=${encodeURIComponent(other)}`, { cookie: sessions.operator.cookie });
      expect(both.status).toBe(400);
      const unknown = await get(`/settings/general?repo=${encodeURIComponent(join(dir, "nowhere"))}`, { cookie: sessions.operator.cookie });
      expect(unknown.status).toBe(404);
      expect(await unknown.text()).toContain(PROJECT_NOT_AVAILABLE.replace("'", "&#39;"));
      // `other` exists here, but not for the project-limited person: the same 404, the same words.
      const foreign = await get(`/settings/general?repo=${encodeURIComponent(other)}`, { cookie: sessions.limited.cookie });
      expect([foreign.status, (await foreign.text()).includes(PROJECT_NOT_AVAILABLE.replace("'", "&#39;"))]).toEqual([404, true]);
      const document = await get(`/settings/change/local-mode?repo=${encodeURIComponent(other)}`, { cookie: sessions.limited.cookie });
      expect(document.status).toBe(404);
      expect(reads).not.toHaveBeenCalled();
      // A project the person may open: the page, and its sections read once.
      expect((await get(`/settings/general?repo=${encodeURIComponent(repo)}`, { cookie: sessions.operator.cookie })).status).toBe(200);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally { reads.mockRestore(); }
  });
});

describe("Settings → Advanced, retired to General", () => {
  test("a permanent redirect to its section, opened, keeping only its own keys and never a fragment", async () => {
    const moved = await get("/settings/advanced?said=Saved&said2=x&section=x", { cookie: sessions.viewer.cookie });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("/settings/general?said=Saved&section=advanced&open=1");
    // Admitted as its target is: an API token is redirected too, and an anonymous caller is sent to sign in.
    expect((await get("/settings/advanced", { authorization: `Bearer ${token}` })).status).toBe(301);
    expect((await get("/settings/advanced", {})).status).not.toBe(301);
  });
  test("the switch's answer lands on its section; the nav no longer lists Advanced", async () => {
    const posted = await fetch(`${base}/settings/advanced`, { method: "POST", redirect: "manual", headers: { cookie: sessions.viewer.cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: sessions.viewer.csrf, advanced: "on" }) });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toMatch(/^\/settings\/general\?section=advanced&said=/);
    const page = await (await get("/settings/general", { cookie: sessions.viewer.cookie })).text();
    expect(page).not.toContain('href="/settings/advanced"');
    expect(page).toContain("Show advanced features");
  });
});

describe("a change document", () => {
  test("is its own sensitive document, and refuses a person who may not make the change", async () => {
    // Local mode is off here: the operator's document says so; nobody else gets past its admission.
    const operator = await get("/settings/change/local-mode", { cookie: sessions.operator.cookie });
    expect(operator.status).toBe(200);
    const body = await operator.text();
    expect(body).toContain("Local mode is off.");
    // Never in place: the focused document (even with no password field on it), with no workspace and no script.
    expect(body).toContain('class="focus-page"');
    expect(body).not.toContain("standing-orders-workspace");
    expect(body).not.toMatch(/<script(?![^>]*nonce)[^>]*>/);
    for (const cookie of [sessions.viewer.cookie, sessions.limited.cookie]) expect((await get("/settings/change/local-mode", { cookie })).status).toBe(403);
    expect((await get("/settings/change/local-mode", { authorization: `Bearer ${token}` })).status).toBe(403);
  });
});
