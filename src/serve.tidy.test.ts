/**
 * Put away old tasks on the console (docs/plans/task-tidy.md): the preview reads only; putting away is an approver's
 * step-up bound to the preview's digest (a stale digest, a ticked task outside the list, a wrong password, a viewer, a
 * bad form token and a token caller are refused and change nothing); Put away and Restore one task are an approver's
 * browser acts; the Archived view and the task page say who put it away and why.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { openStore, archiveOf, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { fire, seedFlow } from "../test/tidy-fixture.js";

const REPO = resolve("/repo/main");
const day = (d: number) => new Date(Date.UTC(2026, 9, d, 16));

describe("Put away old tasks on the console", () => {
  let store: Store;
  let server: Server | null = null;
  let base: string;
  let alexToken: string;
  let veraToken: string;
  let evidenceRoot: string;
  const url = (path: string) => `${base}${path}`;
  const loginAs = async (name: string, token: string): Promise<string> => {
    const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const csrfOf = (html: string): string => /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
  const digestOf = (html: string): string => /name="digest" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? "";
  const page = async (cookie: string, path: string) => fetch(url(path), { headers: { cookie }, redirect: "manual" });
  const post = (cookie: string, path: string, fields: [string, string][], headers: Record<string, string> = {}) =>
    fetch(url(path), { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields), redirect: "manual" });
  const archived = () => store.handle.prepare("SELECT r.external_id id FROM task_archive a JOIN task_ref r ON r.id = a.task_ref ORDER BY id").all().map(row => String(row["id"]));

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "toolroll-serve-tidy-"));
    const alex = addApprover(store, "alex", day(1));
    if (!alex.ok) throw new Error("bootstrap failed");
    alexToken = alex.token;
    const vera = addApprover(store, "vera", day(1), { name: "alex", token: alexToken });
    if (!vera.ok) throw new Error("viewer add");
    store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
    veraToken = vera.token;
    const flow = seedFlow(store, "Site check", { kind: "schedule", schedule: "daily:09:00@UTC", title: "Is the site current?", description: null, zone: null }, day(1), REPO);
    for (const d of [28, 29, 30, 31]) fire(store, flow, { key: `slot:2026-10-${d}T16:00:00.000Z`, task: `site-oct-${d}`, title: `Is the site current? — Oct ${d}`, at: day(d), repo: REPO });
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date("2026-11-01T18:00:00.000Z"), repo: REPO });
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
    const address = server!.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    if (server !== null) await new Promise<void>(done => server!.close(() => done()));
    server = null;
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the preview lists each task with why, binds a digest, and changes nothing", async () => {
    const alex = await loginAs("alex", alexToken);
    const response = await page(alex, "/tasks/archive");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Old routine runs");
    for (const d of [28, 29, 30]) expect(html).toContain(`value="site-oct-${d}" checked`);
    expect(html).not.toContain('value="site-oct-31"');
    expect(html).toContain("A newer run, “Is the site current? — Oct 31”, replaces it.");
    const digest = digestOf(html);
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
    // The archive page names no CLI digest line (docs/plans/plain-toolroll.md: deleted in Phase 1).
    expect(html).not.toContain("toolroll task tidy --apply --digest");
    expect(archived()).toEqual([]);
    expect((await page(await loginAs("vera", veraToken), "/tasks/archive")).status).toBe(403);
  });

  test("a viewer, a bad form token, a token caller, a wrong password, a stale digest and a task outside the list change nothing", async () => {
    const alex = await loginAs("alex", alexToken);
    const html = await (await page(alex, "/tasks/archive")).text();
    const csrf = csrfOf(html), digest = digestOf(html);
    const good: [string, string][] = [["csrf", csrf], ["digest", digest], ["days", "14"], ["task", "site-oct-28"], ["password", alexToken]];
    const vera = await loginAs("vera", veraToken);
    const veraCsrf = csrfOf(await (await page(vera, "/tasks")).text());
    expect((await post(vera, "/work/put-away", good.map(([k, v]) => [k, k === "csrf" ? veraCsrf : k === "password" ? veraToken : v]))).status).toBe(403);
    expect((await post(alex, "/work/put-away", good.map(([k, v]) => [k, k === "csrf" ? "0".repeat(64) : v]))).status).toBe(403);
    expect((await post("", "/work/put-away", good, { authorization: `Bearer alex:${alexToken}` })).status).toBe(403);
    const wrong = await post(alex, "/work/put-away", good.map(([k, v]) => [k, k === "password" ? "not-it" : v]));
    expect(wrong.status).toBe(303);
    expect(wrong.headers.get("location")).toContain("problem=");
    const stale = await post(alex, "/work/put-away", good.map(([k, v]) => [k, k === "digest" ? "f".repeat(32) : v]));
    expect(decodeURIComponent(stale.headers.get("location") ?? "").replace(/\+/g, " ")).toContain("The list changed since you looked.");
    const outside = await post(alex, "/work/put-away", [...good, ["task", "site-oct-31"]]);
    expect(decodeURIComponent(outside.headers.get("location") ?? "").replace(/\+/g, " ")).toContain("Only tasks in the list can be put away.");
    expect((await post(alex, "/work/put-away", [...good, ["digest", digest]])).status).toBe(400);
    expect(archived()).toEqual([]);
  });

  test("puts away exactly the ticked tasks, then Archived shows who and why, and Restore brings one back", async () => {
    const alex = await loginAs("alex", alexToken);
    const html = await (await page(alex, "/tasks/archive")).text();
    const done = await post(alex, "/work/put-away", [["csrf", csrfOf(html)], ["digest", digestOf(html)], ["days", "14"], ["task", "site-oct-28"], ["task", "site-oct-30"], ["password", alexToken]]);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/tasks?view=archived");
    expect(archived()).toEqual(["site-oct-28", "site-oct-30"]);
    expect(archiveOf(store, "site-oct-28")).toMatchObject({ by: "alex", byKind: "person", rule: "routine" });
    const list = await (await page(alex, "/tasks?view=archived")).text();
    expect(list).toContain("Archived by alex: A newer run, “Is the site current? — Oct 31”, replaces it.");
    const needs = await (await page(alex, "/tasks?view=needs-you")).text();
    expect(needs).not.toContain('data-task="site-oct-28"');
    const taskPage = await (await page(alex, "/t/site-oct-30")).text();
    expect(taskPage).toContain("data-archived");
    const restored = await post(alex, "/t/site-oct-30/restore", [["csrf", csrfOf(taskPage)], ["return", "/t/site-oct-30"]]);
    expect(restored.status).toBe(303);
    expect(archived()).toEqual(["site-oct-28"]);
  });

  test("Put away one task: an approver's browser act; a viewer, a bad form token and a token caller are refused", async () => {
    const alex = await loginAs("alex", alexToken);
    const csrf = csrfOf(await (await page(alex, "/tasks")).text());
    const vera = await loginAs("vera", veraToken);
    const veraCsrf = csrfOf(await (await page(vera, "/tasks")).text());
    expect((await post(vera, "/t/site-oct-31/archive", [["csrf", veraCsrf]])).status).toBe(403);
    expect((await post(alex, "/t/site-oct-31/archive", [["csrf", "0".repeat(64)]])).status).toBe(403);
    expect((await post("", "/t/site-oct-31/archive", [["csrf", csrf]], { authorization: `Bearer alex:${alexToken}` })).status).toBe(403);
    expect(archived()).toEqual([]);
    const done = await post(alex, "/t/site-oct-31/archive", [["csrf", csrf], ["return", "/tasks?view=needs-you"]]);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/tasks?view=needs-you");
    expect(archiveOf(store, "site-oct-31")).toMatchObject({ by: "alex", reason: "Put away by hand" });
    expect((await post(alex, "/t/site-oct-31/archive", [["csrf", csrf]])).status).toBe(409);
    expect((await post(alex, "/t/site-oct-31/restore", [["csrf", csrf], ["return", "https://evil.example/"]])).headers.get("location")).toBe("/t/site-oct-31");
  });

  test("the Tasks page offers Put away old tasks and Put away to an approver only", async () => {
    const alex = await (await page(await loginAs("alex", alexToken), "/tasks?view=needs-you")).text();
    expect(alex).toContain('href="/tasks/archive"');
    expect(alex).toContain('action="/t/site-oct-28/archive"');
    const vera = await (await page(await loginAs("vera", veraToken), "/tasks?view=needs-you")).text();
    expect(vera).not.toContain('href="/tasks/archive"');
    expect(vera).not.toContain("/archive");
  });
});
