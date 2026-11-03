/** Home ("/") and Search ("/search") through the server (UI revamp wave B): Home's counts are the Tasks list's own,
 * its scope links stay inside the projects this person may see, a token keeps landing on Tasks, and search finds
 * tasks by title and every place by name. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { BrowserHomeView, BrowserSearchView, BrowserTasksView, BrowserWorkspace } from "./browser-workspace.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore, type Store } from "./store.js";
import { T0, workspaceOf } from "../test/serve-kit.js";

let store: Store, server: Server, base: string, evidenceRoot: string, repoA: string, repoB: string, token: string;
const url = (path: string) => `${base}${path}`;

async function login(): Promise<string> {
  const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" });
  expect(response.status).toBe(303);
  return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
}
const page = async (path: string, cookie: string): Promise<BrowserWorkspace> => workspaceOf(await (await fetch(url(path), { headers: { cookie } })).text());
const task = (id: string, title: string, repo: string) => {
  store.createTask({ id, title }, T0);
  store.placeTask(store.refFor("built-in", id, "ours").id, repo);
};

beforeEach(async () => {
  store = openStore(":memory:");
  evidenceRoot = mkdtempSync(join(tmpdir(), "so-home-ev-"));
  repoA = realpathSync(mkdtempSync(join(tmpdir(), "so-home-a-")));
  repoB = realpathSync(mkdtempSync(join(tmpdir(), "so-home-b-")));
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap failed");
  token = alex.token;
  server = createDecisionServer({ store, evidenceRoot, repos: [repoA, repoB], clock: () => new Date() });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  for (const dir of [evidenceRoot, repoA, repoB]) rmSync(dir, { recursive: true, force: true });
});

test("Home's four counts are the Tasks list's own counts, scoped the same way, and each opens its filter", async () => {
  task("ship-webhooks", "Harden webhook delivery", repoA);
  task("log-format", "Rotate the request-log format", repoB);
  const cookie = await login();
  const workspace = await page("/", cookie);
  const home = workspace.view as BrowserHomeView;
  expect(home.kind).toBe("home");
  const tasks = (await page("/work", cookie)).view as BrowserTasksView;
  const tab = (label: string) => tasks.tabs.find(one => one.label === label)?.count;
  expect(home.counts.find(one => one.key === "needs")!.value).toBe(tasks.needsYou);
  expect(home.counts.find(one => one.key === "running")!.value).toBe(tab("Running") ?? tab("Building"));
  expect(home.counts.map(one => one.href)).toEqual(["/work?view=needs-you", "/work?view=running", "/work?view=queued", "/work?view=completed"]);
  expect(home.say).toMatch(/need|Nothing needs you|No tasks yet/);
  // The rail's Home carries the one Needs-you count the server sends.
  expect(workspace.navigation[0]).toMatchObject({ label: "Home", href: "/", active: true });
  expect(workspace.needsYou?.count ?? 0).toBe(tasks.needsYou);
  // Two projects: the scope links, and a project outside them is never taken as the scope.
  expect(home.scopes?.map(one => one.label)).toEqual(["All projects", repoA.split("/").pop(), repoB.split("/").pop()]);
  const scoped = (await page(`/?project=${encodeURIComponent(repoA)}`, cookie)).view as BrowserHomeView;
  expect(scoped.project).toBe(repoA);
  expect(scoped.counts[0]!.href).toBe(`/work?project=${encodeURIComponent(repoA)}&view=needs-you`);
  const outside = (await page(`/?project=${encodeURIComponent("/somewhere/else")}`, cookie)).view as BrowserHomeView;
  expect(outside.project).toBeNull();
});

test("before anything is filed, Home is the first-run checklist in the chat; the chat itself stays where it was", async () => {
  const cookie = await login();
  const first = await fetch(url("/"), { headers: { cookie }, redirect: "manual" });
  expect([302, 303]).toContain(first.status);
  expect(first.headers.get("location")).toBe("/chat");
  const chat = await fetch(url("/chat"), { headers: { cookie }, redirect: "manual" });
  expect(chat.status).toBe(200);
});

test("search finds tasks by title and id, and strips control characters from the words", async () => {
  task("ship-webhooks", "Harden webhook delivery", repoA);
  task("log-format", "Rotate the request-log format", repoB);
  const cookie = await login();
  const found = (await page(`/search?q=${encodeURIComponent("webhook\u0007")}`, cookie)).view as BrowserSearchView;
  expect(found.kind).toBe("search");
  expect(found.q).toBe("webhook");
  expect(found.tasks.map(one => one.id)).toEqual(["ship-webhooks"]);
  expect(found.tasks[0]!.href).toBe("/t/ship-webhooks");
  const byId = (await page("/search?q=log-format", cookie)).view as BrowserSearchView;
  expect(byId.tasks.map(one => one.title)).toEqual(["Rotate the request-log format"]);
  const none = (await page("/search", cookie)).view as BrowserSearchView;
  expect(none.tasks).toEqual([]);
});
