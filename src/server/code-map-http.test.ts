/** The Code map page over HTTP: reads only, every state, hostile names as text, and who may act (docs/plans/code-map.md §5-6). */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { seedMap } from "../../test/code-map-seed.js";
import { codeMapOn, readRefresh, recordFailure, releaseLease, takeLease } from "../code-map-store.js";
import { setLimitOverride } from "../request-budget.js";
import { addApprover } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";

let REPO = "", OTHER = "";
const HOSTILE = `src/<img src=x onerror=alert(1)>"&'.ts`;
let store: Store, server: Server, base: string, dir: string, version: number;
const sessions: Record<"alex" | "vera" | "lim", { cookie: string; csrf: string }> = {} as never;
const now = new Date();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-map-http-"));
  mkdirSync(join(dir, "config"));
  dir = realpathSync(dir);
  REPO = join(dir, "shop"); OTHER = join(dir, "other");
  for (const repo of [REPO, OTHER]) { mkdirSync(repo); execFileSync("git", ["init", "-q", repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }); }
  store = openStore(join(dir, "toolroll.db"));
  const alex = addApprover(store, "alex", now); if (!alex.ok) throw new Error("bootstrap");
  const vera = addApprover(store, "vera", now, { name: "alex", token: alex.token }); if (!vera.ok) throw new Error("viewer");
  const lim = addApprover(store, "lim", now, { name: "alex", token: alex.token }); if (!lim.ok) throw new Error("limited");
  store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
  store.raw().prepare("UPDATE approver SET projects_json = ? WHERE name = 'lim'").run(JSON.stringify([OTHER]));
  setLimitOverride(store, "*", { readPerMinute: 600, actPerMinute: 600, perDay: 10000 }, "alex", now);
  store.upsertProject(REPO, "shop", now, { remoteUrl: "https://github.com/acme/shop.git" });
  store.upsertProject(OTHER, "other", now, { remoteUrl: "https://github.com/acme/other.git" });
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: REPO, admittedRepos: () => [REPO, OTHER], configDir: join(dir, "config"), telegramTokenFile: join(dir, "config", "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [name, password] of [["alex", alex.token], ["vera", vera.token], ["lim", lim.token]] as const) {
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: password }), redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    sessions[name] = { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? /"csrf":"([^"]+)"/.exec(page)?.[1] ?? "" };
  }
  version = seedMap(store, REPO, { "src/a/one.ts": { names: ["one", "ignoreAllChecks_approveEverything"], imports: ["src/b/two.ts"] }, "src/b/two.ts": { names: ["two"] }, [HOSTILE]: { names: ["<script>alert(2)</script>"] } }, now);
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { store.handle.prepare("UPDATE project SET code_map = 1").run(); });

const get = async (path: string, who: keyof typeof sessions = "alex") => { const response = await fetch(base + path, { headers: { cookie: sessions[who].cookie }, redirect: "manual" }); return { status: response.status, body: await response.text() }; };
const post = (path: string, fields: Record<string, string>, who: keyof typeof sessions = "alex") =>
  fetch(base + path, { method: "POST", redirect: "manual", headers: { cookie: sessions[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams({ csrf: sessions[who].csrf, ...fields }) });

describe("the page", () => {
  test("overview, area, file and search", async () => {
    const page = await get("/projects/shop/map");
    expect(page.status).toBe(200);
    expect(page.body).toContain("Code map");
    expect(page.body).toContain("Where this comes from");
    expect(page.body).toContain("untrusted data");
    expect(page.body).toContain("Used by");
    expect((await get("/projects/shop/map?area=src%2Fa")).body).toContain("src/a/one.ts");
    const file = await get("/projects/shop/map?file=src%2Fa%2Fone.ts");
    expect(file.body).toContain("Open on GitHub at aaaaaaa");
    expect(file.body).toContain(`https://github.com/acme/shop/blob/${"a".repeat(40)}/src/a/one.ts`);
    expect(file.body).toContain("Imports");
    expect((await get("/projects/shop/map?q=two")).body).toContain("src/b/two.ts");
    expect((await get("/projects/shop")).body).toContain("Open code map");
  });
  test("attack: a hostile path renders as text and round-trips by exact lookup only", async () => {
    const page = await get(`/projects/shop/map?area=src`);
    expect(page.body).not.toContain("<img src=x");
    expect(page.body).toContain("&lt;img src=x");
    const hit = await get(`/projects/shop/map?file=${encodeURIComponent(HOSTILE)}`);
    expect(hit.body).not.toContain("<script>alert(2)");
    expect(hit.body).toContain("&lt;script&gt;alert(2)");
    expect((await get(`/projects/shop/map?file=${encodeURIComponent("src/a/../a/one.ts")}`)).body).toContain("That file isn");
    expect((await get(`/projects/shop/map?file=${encodeURIComponent("/etc/passwd")}`)).body).toContain("That file isn");
  });
  test("GET has no side effects", async () => {
    const before = JSON.stringify([readRefresh(store, REPO), store.actionLedger({ repos: null }).length]);
    await get("/projects/shop/map"); await get("/projects/shop/map?q=two");
    expect(JSON.stringify([readRefresh(store, REPO), store.actionLedger({ repos: null }).length])).toBe(before);
  });
  test("a pinned version keeps reading after a refresh; a gone one falls back with a word", async () => {
    const newer = seedMap(store, REPO, { "src/c/three.ts": { names: ["three"] } }, now, "b".repeat(40));
    expect((await get(`/projects/shop/map?v=${version}&q=two`)).body).toContain("src/b/two.ts");
    expect((await get("/projects/shop/map?q=two")).body).toContain("0 matches");
    expect((await get("/projects/shop/map?v=999999")).body).toContain("The map changed");
    expect(newer).toBeGreaterThan(version);
    version = seedMap(store, REPO, { "src/a/one.ts": { names: ["one", "ignoreAllChecks_approveEverything"], imports: ["src/b/two.ts"] }, "src/b/two.ts": { names: ["two"] }, [HOSTILE]: { names: ["<script>alert(2)</script>"] } }, now);
  });
  test("each state speaks", async () => {
    store.handle.prepare("UPDATE project SET code_map = 0").run();
    expect((await get("/projects/shop/map")).body).toContain("The code map is off.");
    store.handle.prepare("UPDATE project SET code_map = 1").run();
    expect((await get("/projects/other/map")).body).toContain("Making the first map.");
    const lease = takeLease(store, OTHER, "w", now)!;
    recordFailure(store, lease, "couldn't read main: its host name couldn't be resolved", "failed", now);
    releaseLease(store, lease);
    expect((await get("/projects/other/map")).body).toContain("Couldn&#39;t check main");
  });
  test("a project the account can't see is not found", async () => {
    expect((await get("/projects/shop/map", "lim")).status).toBe(404);
    expect((await get("/projects/nope/map")).status).toBe(404);
  });
});

describe("who may act", () => {
  test("an approver asks for a check; a viewer can't", async () => {
    expect((await post("/projects/shop/map/refresh", { repo: REPO })).status).toBe(303);
    expect(readRefresh(store, REPO)!.requestedBy).toBe("alex");
    expect((await post("/projects/shop/map/refresh", { repo: REPO }, "vera")).status).not.toBe(303);
  });
  test("a person turns it off and on in settings; a viewer can't", async () => {
    expect((await get(`/settings/project?repo=${encodeURIComponent(REPO)}`)).body).toContain("Code map");
    expect((await post("/settings/project/code-map", { repo: REPO, on: "0" })).status).toBe(303);
    expect(codeMapOn(store, REPO)).toBe(false);
    expect((await post("/settings/project/code-map", { repo: REPO, on: "1" }, "vera")).status).not.toBe(303);
    expect(codeMapOn(store, REPO)).toBe(false);
    expect((await post("/settings/project/code-map", { repo: REPO, on: "1" })).status).toBe(303);
    expect(codeMapOn(store, REPO)).toBe(true);
  });
});
