/**
 * Settings → Computers through the real console (the eight settings plan, F2): who reads what; the old /start-builder
 * and /fleet land there; registering a computer is its own change document whose form token is spent once (a
 * replayed or doubled post registers nothing) and whose refusals come back with safe drafts and no password; retiring
 * one is a step-up that comes back to its document on a refusal and to Computers when done.
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
import { createDemoSandbox } from "../demo.js";
import { inPlaceRoute } from "./in-place.js";

let store: Store, server: Server, base: string, dir: string, repo: string, other: string, password = "", inesPassword = "", token = "";
const sessions: Record<"operator" | "limited" | "viewer" | "approver", { cookie: string; csrf: string }> = {} as never;
const T0 = new Date();

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-computers-")));
  mkdirSync(join(dir, "config"));
  repo = join(dir, "main"); other = join(dir, "other");
  mkdirSync(repo); mkdirSync(other);
  store = openStore(join(dir, "toolroll.db"));
  const alex = addApprover(store, "alex", T0); if (!alex.ok) throw new Error("bootstrap");
  password = alex.token;
  const lim = addApprover(store, "lim", T0, { name: "alex", token: alex.token }); if (!lim.ok) throw new Error("limited");
  const vera = addApprover(store, "vera", T0, { name: "alex", token: alex.token }); if (!vera.ok) throw new Error("viewer");
  // A second approver with access to everything: another person who may register computers too.
  const ines = addApprover(store, "ines", T0, { name: "alex", token: alex.token }); if (!ines.ok) throw new Error("approver");
  inesPassword = ines.token;
  store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
  store.raw().prepare("UPDATE approver SET projects_json = ? WHERE name = 'lim'").run(JSON.stringify([repo]));
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: "act", secretHash: minted.hash, access: "act", expiresAt: new Date(T0.getTime() + 86_400_000).toISOString(), by: "alex" }, T0);
  token = minted.token;
  setLimitOverride(store, "*", { readPerMinute: 600, actPerMinute: 600, perDay: 10000 }, "alex", T0);
  store.saveRunner({ name: "studio", host: "studio.local", capacity: 2, repos: [repo], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null }, "hash-studio");
  for (const [id, where] of [["t-main", repo], ["t-other", other]] as const) {
    const made = store.createConsoleTask({ id, title: `task ${id}`, repo: where, goal: "do it", acceptance: [{ id: "c1", statement: "done.", evidence: ["manual-review"] }], filedVia: "cli" }, T0);
    if (!made.ok) throw new Error(made.reason);
  }
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo, other], configDir: join(dir, "config"), telegramTokenFile: join(dir, "config", "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [key, name, secret] of [["operator", "alex", alex.token], ["limited", "lim", lim.token], ["viewer", "vera", vera.token], ["approver", "ines", ines.token]] as const) {
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
const post = (path: string, cookie: string, form: Record<string, string>) => fetch(base + path, { method: "POST", redirect: "manual",
  headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
const sectionsOf = (page: string) => [...page.matchAll(/data-section="([a-z-]+)"/g)].map(match => match[1]);
const nonceOf = (page: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(page)?.[1] ?? "";
const runnerRows = () => JSON.stringify(store.raw().prepare("SELECT * FROM runner ORDER BY name").all());

describe("who reads what", () => {
  test("everyone reads Connect a builder; the computers as /fleet showed them, to a person with instance access", async () => {
    const read = async (headers: Record<string, string>) => { const answer = await get("/settings/computers", headers); expect(answer.status).toBe(200); return answer.text(); };
    expect(sectionsOf(await read({ cookie: sessions.operator.cookie }))).toEqual(["start", "builders"]);
    expect(sectionsOf(await read({ cookie: sessions.viewer.cookie }))).toEqual(["start", "builders"]);
    expect(sectionsOf(await read({ authorization: `Bearer ${token}` }))).toEqual(["start", "builders"]);
    const limited = await read({ cookie: sessions.limited.cookie });
    expect(sectionsOf(limited)).toEqual(["start"]);
    expect(limited).not.toContain("studio");
    // The controls follow who may change: the viewer reads, the operator registers and retires.
    const viewer = await read({ cookie: sessions.viewer.cookie });
    expect(viewer).not.toContain("/settings/change/register-computer");
    expect(await read({ cookie: sessions.operator.cookie })).toContain('href="/settings/change/register-computer"');
  });
  test("the page changes in place; its change documents never do", () => {
    expect(inPlaceRoute("settings.group-computers", new URL("http://x/settings/computers"))).toBe(true);
    for (const id of ["settings.change.register-computer", "settings.change.retire-computer"]) expect(inPlaceRoute(id, new URL("http://x/"))).toBe(false);
  });
});

describe("old addresses", () => {
  test("/start-builder keeps its task: that task's own project, and the same 404 for an unknown or unseen one", async () => {
    const moved = await get("/start-builder?task=t-other", { cookie: sessions.operator.cookie });
    expect([moved.status, moved.headers.get("location")]).toEqual([301, "/settings/computers?task=t-other&section=start"]);
    const shown = await (await get("/settings/computers?task=t-other&section=start", { cookie: sessions.operator.cookie })).text();
    expect(shown).toContain("<strong>No builder is connected</strong> to <strong>other</strong>");
    // The open project has a live builder; its own page says so.
    expect(await (await get(`/settings/computers?repo=${encodeURIComponent(repo)}`, { cookie: sessions.operator.cookie })).text()).toContain("A builder is connected to <strong>main</strong>");
    expect((await get("/settings/computers?task=no-such-task", { cookie: sessions.operator.cookie })).status).toBe(404);
    expect((await get("/settings/computers?task=t-other", { cookie: sessions.limited.cookie })).status).toBe(404);
    expect((await get("/settings/computers?task=t-main&task=t-other", { cookie: sessions.operator.cookie })).status).toBe(400);
  });
  test("/fleet is the builders section", async () => {
    const moved = await get("/fleet", { cookie: sessions.operator.cookie });
    expect(moved.headers.get("location")).toBe("/settings/computers?section=builders");
  });
});

describe("registering a computer", () => {
  const document = async () => { const page = await (await get("/settings/change/register-computer", { cookie: sessions.operator.cookie })).text(); return { page, nonce: nonceOf(page) }; };
  test("is its own sensitive document; refused to anyone who may not register", async () => {
    const { page, nonce } = await document();
    expect(page).toContain('class="focus-page"');
    expect(page).not.toContain("standing-orders-workspace");
    expect(nonce).toHaveLength(32);
    for (const cookie of [sessions.viewer.cookie, sessions.limited.cookie]) expect((await get("/settings/change/register-computer", { cookie })).status).toBe(403);
    expect((await get("/settings/change/register-computer", { authorization: `Bearer ${token}` })).status).toBe(403);
  });
  test("a refusal comes back to the document with its drafts and no password, and registers nothing", async () => {
    const before = runnerRows();
    const noNonce = await post("/fleet/runner/register", sessions.operator.cookie, { csrf: sessions.operator.csrf, name: "attic", capacity: "4", token: password });
    expect(noNonce.status).toBe(303);
    expect(noNonce.headers.get("location")).toMatch(/^\/settings\/change\/register-computer\?problem=.*&name=attic&capacity=4$/);
    const wrong = await post("/fleet/runner/register", sessions.operator.cookie, { csrf: sessions.operator.csrf, name: "attic", capacity: "4", token: "not-the-password", nonce: (await document()).nonce });
    const back = wrong.headers.get("location") ?? "";
    expect(back).toMatch(/^\/settings\/change\/register-computer\?problem=Registering.*&name=attic&capacity=4$/);
    expect(back).not.toContain("not-the-password");
    const badName = await post("/fleet/runner/register", sessions.operator.cookie, { csrf: sessions.operator.csrf, name: "", capacity: "2", token: password, nonce: (await document()).nonce });
    expect(badName.headers.get("location")).toMatch(/&field=name$/);
    expect(runnerRows()).toBe(before);
    // The document shows the drafts back.
    const again = await (await get(back, { cookie: sessions.operator.cookie })).text();
    expect(again).toContain('value="attic"');
    expect(again).toMatch(/<option value="4" selected>/);
    expect(again).toContain("Registering a computer takes your password");
  });
  test("its form token is spent once: the post registers and shows the token once; the same post replayed registers nothing", async () => {
    const { nonce } = await document();
    const form = { csrf: sessions.operator.csrf, name: "attic", capacity: "2", token: password, nonce };
    const created = await post("/fleet/runner/register", sessions.operator.cookie, form);
    expect(created.status).toBe(200);
    const shown = await created.text();
    expect(shown).toContain("attic is registered");
    expect(shown).toContain('class="focus-page"');
    expect(shown).not.toContain("<script");
    expect(shown).toContain('href="/settings/computers?section=builders"');
    const after = runnerRows();
    expect(store.getRunner("attic")?.runner.capacity).toBe(2);
    // The same post again (a replay, a back button): refused, and the token minted above still stands.
    const replay = await post("/fleet/runner/register", sessions.operator.cookie, form);
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toMatch(/^\/settings\/change\/register-computer\?problem=That\+form\+was\+already\+used/);
    expect(runnerRows()).toBe(after);
  });
  test("two identical posts at once (a double click): exactly one registers", async () => {
    const { nonce } = await document();
    const form = { csrf: sessions.operator.csrf, name: "twin", capacity: "1", token: password, nonce };
    const answers = await Promise.all([post("/fleet/runner/register", sessions.operator.cookie, form), post("/fleet/runner/register", sessions.operator.cookie, form)]);
    expect(answers.map(one => one.status).sort()).toEqual([200, 303]);
    expect(answers.find(one => one.status === 303)!.headers.get("location")).toMatch(/problem=That\+form\+was\+already\+used/);
    expect(store.raw().prepare("SELECT COUNT(*) AS n FROM runner WHERE name = 'twin'").get()?.["n"]).toBe(1);
  });
  test("a wrong password spends the form's token: retrying it with the right one registers nothing", async () => {
    const { nonce } = await document();
    const before = runnerRows();
    const wrong = await post("/fleet/runner/register", sessions.operator.cookie, { csrf: sessions.operator.csrf, name: "retry", capacity: "1", token: "nope", nonce });
    expect(wrong.headers.get("location")).toMatch(/problem=Registering/);
    const retry = await post("/fleet/runner/register", sessions.operator.cookie, { csrf: sessions.operator.csrf, name: "retry", capacity: "1", token: password, nonce });
    expect(retry.headers.get("location")).toMatch(/problem=That\+form\+was\+already\+used/);
    expect(runnerRows()).toBe(before);
  });
  test("another approver can't spend (or burn) someone else's form: refused, and the owner's form still works", async () => {
    const { nonce } = await document();
    const before = runnerRows();
    // Ines may register computers herself, with her own password; alex's form token is not hers.
    const theirs = await post("/fleet/runner/register", sessions.approver.cookie, { csrf: sessions.approver.csrf, name: "borrowed", capacity: "1", token: inesPassword, nonce });
    expect(theirs.status).toBe(303);
    expect(theirs.headers.get("location")).toMatch(/problem=That\+form\+was\+already\+used/);
    expect(runnerRows()).toBe(before);
    // The owner submits the form they were shown: it still works.
    const owner = await post("/fleet/runner/register", sessions.operator.cookie, { csrf: sessions.operator.csrf, name: "kept", capacity: "1", token: password, nonce });
    expect(owner.status).toBe(200);
    expect(store.getRunner("kept")).not.toBeNull();
    expect(store.getRunner("borrowed")).toBeNull();
  });
});

describe("the demo", () => {
  test("registers and retires no computer, even by a direct post: refused before any form token or proof", async () => {
    const made = createDemoSandbox(new Date());
    const demo = createDecisionServer({ store: made.store, evidenceRoot: made.evidenceRoot, clock: () => new Date(), repos: made.seed.repos, demoLead: made.lead });
    await new Promise<void>(resolve => demo.listen(0, "127.0.0.1", resolve));
    try {
      const at = `http://127.0.0.1:${(demo.address() as { port: number }).port}`;
      const signed = await fetch(at + demo.mintSignInLink(made.seed.login.name)!, { redirect: "manual" });
      const cookie = signed.headers.getSetCookie().map(one => one.split(";")[0]).join("; ");
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${at}/settings/general`, { headers: { cookie } })).text())![1]!;
      made.store.saveRunner({ name: "demo-box", host: "here", capacity: 1, repos: [], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null }, "hash-demo");
      const rows = () => JSON.stringify(made.store.raw().prepare("SELECT * FROM runner ORDER BY name").all());
      const before = rows();
      const send = (path: string, form: Record<string, string>) => fetch(at + path, { method: "POST", redirect: "manual",
        headers: { cookie, origin: at, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...form }) });
      const register = await send("/fleet/runner/register", { name: "sneaky", capacity: "1", token: "x", nonce: "0".repeat(32) });
      expect(register.status).toBe(403);
      expect(await register.text()).toContain("The demo doesn&#39;t register computers.");
      const retire = await send("/fleet/runner/retire", { name: "demo-box", token: "x" });
      expect(retire.status).toBe(403);
      expect(await retire.text()).toContain("The demo doesn&#39;t retire computers.");
      expect(rows()).toBe(before);
      // Its pages offer neither.
      expect((await fetch(`${at}/settings/change/register-computer`, { headers: { cookie } })).status).toBe(403);
    } finally {
      made.lead.stop();
      await new Promise<void>(resolve => demo.close(() => resolve()));
      made.store.close();
      rmSync(made.sandbox, { recursive: true, force: true });
    }
  });
});

describe("retiring a computer", () => {
  test("its document names it; a wrong password comes back there; done, Computers says so", async () => {
    store.saveRunner({ name: "shed", host: "shed.local", capacity: 1, repos: [], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null }, "hash-shed");
    const page = await (await get("/settings/change/retire-computer?computer=shed", { cookie: sessions.operator.cookie })).text();
    expect(page).toContain('name="name" value="shed"');
    expect(page).toContain('class="focus-page"');
    for (const cookie of [sessions.viewer.cookie, sessions.limited.cookie]) expect((await get("/settings/change/retire-computer?computer=shed", { cookie })).status).toBe(403);
    const wrong = await post("/fleet/runner/retire", sessions.operator.cookie, { csrf: sessions.operator.csrf, name: "shed", token: "nope" });
    expect(wrong.headers.get("location")).toMatch(/^\/settings\/change\/retire-computer\?computer=shed&problem=Retiring/);
    expect(store.getRunner("shed")?.runner.retiredAt).toBeNull();
    const unknown = await post("/fleet/runner/retire", sessions.operator.cookie, { csrf: sessions.operator.csrf, name: "nobody", token: password });
    expect(unknown.headers.get("location")).toMatch(/^\/settings\/change\/retire-computer\?computer=nobody&problem=There/);
    const done = await post("/fleet/runner/retire", sessions.operator.cookie, { csrf: sessions.operator.csrf, name: "shed", token: password });
    expect(done.headers.get("location")).toBe(`/settings/computers?section=builders&said=${encodeURIComponent("shed is retired. It takes no more work.")}`);
    expect(store.getRunner("shed")?.runner.retiredAt).not.toBeNull();
  });
});
