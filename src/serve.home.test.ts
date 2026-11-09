/** Home ("/") and Search ("/search") through the server (UI revamp wave B): Home's counts are the Tasks list's own,
 * its scope links stay inside the projects this person may see, a token keeps landing on Tasks, and search finds
 * tasks by title and every place by name. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import type { BrowserHomeView, BrowserSearchView, BrowserTasksView, BrowserWorkspace } from "./browser-workspace.js";
import { addApprover } from "./scope.js";
import { makeDemoRepos, seedDemo } from "./demo.js";
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
  for (const repo of [repoA, repoB]) execFileSync("git", ["init", "-q", repo]);
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
  const tasks = (await page("/tasks", cookie)).view as BrowserTasksView;
  const tab = (label: string) => tasks.tabs.find(one => one.label === label)?.count;
  expect(home.counts.find(one => one.key === "needs")!.value).toBe(tasks.needsYou);
  expect(home.counts.find(one => one.key === "running")!.value).toBe(tab("Running") ?? tab("Building"));
  expect(home.counts.map(one => one.href)).toEqual(["/tasks?scope=all&view=needs-you", "/tasks?scope=all&view=running", "/tasks?scope=all&view=queued", "/tasks?scope=all&view=completed"]);
  expect(home.say).toMatch(/need|Nothing needs you|No tasks yet/);
  // The rail's Home carries the one Needs-you count the server sends.
  expect(workspace.navigation[0]).toMatchObject({ label: "Home", href: "/", active: true });
  expect(workspace.needsYou?.count ?? 0).toBe(tasks.needsYou);
  // Two projects: the scope links, and a project outside them is never taken as the scope.
  expect(home.scopes?.map(one => one.label)).toEqual(["All projects", repoA.split("/").pop(), repoB.split("/").pop()]);
  // One scope for the page and its chrome: /?project=B scopes Home, the rail's count and the dock's list alike.
  for (const repo of [repoA, repoB]) {
    const scopedPage = await page(`/?project=${encodeURIComponent(repo)}`, cookie);
    const scoped = scopedPage.view as BrowserHomeView;
    expect(scoped.project).toBe(repo);
    expect(scoped.counts[0]!.href).toBe(`/tasks?project=${encodeURIComponent(repo)}&view=needs-you`);
    expect(scopedPage.needsYou).toMatchObject({ scope: repo, count: scoped.counts[0]!.value, href: scoped.counts[0]!.href });
  }
  // Unscoped Home and its chrome both cover every project.
  expect(workspace.needsYou).toMatchObject({ scope: null, href: "/tasks?scope=all&view=needs-you" });
  // A project outside this workspace is refused, never quietly widened.
  const outside = await fetch(url(`/?project=${encodeURIComponent("/somewhere/else")}`), { headers: { cookie } });
  expect(outside.status).toBe(404);
});

test("each of Home's counts equals the list its link opens (Queued included), on the demo's work", async () => {
  // The demo seed has work in every state; a second server over it, presented as an ordinary install.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-home-demo-")));
  const demoStore = openStore(join(root, "orders.db"));
  const repos = makeDemoRepos(root);
  mkdirSync(join(root, "evidence"), { recursive: true });
  demoStore.recordInstallationFact("demo", "1", new Date());
  const seed = seedDemo(demoStore, repos, join(root, "evidence"), new Date());
  demoStore.isDemo = () => false;
  const demo = createDecisionServer({ store: demoStore, evidenceRoot: join(root, "evidence"), repos: [repos.api, repos.web], clock: () => new Date() });
  await new Promise<void>(resolve => demo.listen(0, "127.0.0.1", resolve));
  const address = demo.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  const at = `http://127.0.0.1:${address.port}`;
  try {
    const signed = await fetch(`${at}/login`, { method: "POST", body: new URLSearchParams({ name: seed.login.name, token: seed.login.password }), redirect: "manual" });
    const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const read = async (path: string) => workspaceOf(await (await fetch(`${at}${path}`, { headers: { cookie } })).text());
    const home = (await read("/")).view as BrowserHomeView;
    // Each link opens its own filter (never All), whose count and rows are Home's figure.
    // Each figure keeps the name of the list it opens (Waiting on you is the Needs you list, Done the Finished list).
    expect(home.counts.map(one => one.label)).toEqual(["Waiting on you", "Running", "Queued", "Done"]);
    expect(home.groups.map(one => one.label)).toEqual(home.groups.map(one => ({ you: "Waiting on you", working: "Working", done: "Done" })[one.key]));
    const labels: Record<string, string> = { needs: "Needs you", running: "Running", queued: "Queued", finished: "Finished" };
    for (const count of home.counts) {
      const list = (await read(count.href)).view as BrowserTasksView;
      expect(list.tabs.find(one => one.active)?.label, count.key).toBe(labels[count.key]);
      expect(list.tabs.find(one => one.active)?.count, count.key).toBe(count.value);
      expect(list.rows.length, count.key).toBe(Math.min(count.value, 40));
    }
  } finally {
    demo.closeAllConnections?.();
    await new Promise<void>(resolve => demo.close(() => resolve()));
    demoStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("with a project open in the session, Home's count, the list it opens and the dock's list are the same projects", async () => {
  task("ship-webhooks", "Harden webhook delivery", repoA);
  task("log-format", "Rotate the request-log format", repoB);
  const cookie = await login();
  const csrf = (await page("/tasks", cookie)).csrf;
  const opened = await fetch(url("/projects/open"), { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, path: repoA, return: "/tasks" }), redirect: "manual" });
  expect([302, 303], (await opened.text()).match(/class="problem">[^<]*|<p>[^<]*/g)?.join(" | ")).toContain(opened.status);
  expect((await page("/tasks", cookie)).needsYou?.scope).toBe(repoA);
  const workspace = await page("/", cookie);
  const home = workspace.view as BrowserHomeView;
  const needs = home.counts.find(one => one.key === "needs")!;
  // Home covers every project; its link, the rail's count and the dock's list say so by name.
  expect(home.project).toBeNull();
  expect(needs.href).toBe("/tasks?scope=all&view=needs-you");
  expect(workspace.needsYou).toMatchObject({ scope: null, count: needs.value, href: needs.href });
  const list = (await page(needs.href, cookie)).view as BrowserTasksView;
  expect(list.needsYou).toBe(needs.value);
  expect(list.rows.length).toBe(needs.value);
  expect(needs.value).toBe(2);
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
