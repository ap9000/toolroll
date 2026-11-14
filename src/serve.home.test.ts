/** Work ("/", the one-workspace plan S2a) and Search ("/search") through the server: Work's segments are the Tasks
 * list's own counts, its Needs you carries every ask Home admitted (tasks, flow cards…) grouped Decide / Review /
 * Unblock, its project links stay inside the projects this person may see, and search finds tasks by title and every
 * place by name. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import type { BrowserSearchView, BrowserWorkspace, BrowserWorkView } from "./browser-workspace.js";
import { addApprover } from "./scope.js";
import { makeDemoRepos, seedDemo } from "./demo.js";
import { createDecisionServer } from "./serve.js";
import { openStore, type Store } from "./store.js";
import { renderedHtmlOf, T0, workspaceOf } from "../test/serve-kit.js";

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

test("Work's segments are the Tasks list's own counts, scoped the same way, and each opens its view", async () => {
  task("ship-webhooks", "Harden webhook delivery", repoA);
  task("log-format", "Rotate the request-log format", repoB);
  const cookie = await login();
  const workspace = await page("/", cookie);
  const work = workspace.view as BrowserWorkView;
  expect(work.kind).toBe("work");
  const tab = (key: string) => work.list.tabs.find(one => one.key === key)!;
  // Work at / covers every project; its segments are its own addresses.
  expect(work.project).toBeNull();
  expect(work.projectName).toBe("All projects");
  expect(work.list.tabs.map(one => one.href)).toEqual(["/", "/?view=needs-you", "/?view=ready", "/?view=running", "/?view=queued", "/?view=completed"]);
  // Needs you counts the tasks and every other ask (a setup step here: no builder yet).
  expect(work.needsCount).toBe(tab("needs-you").count + work.needs.flatMap(one => one.rows).filter(row => row.id.includes(":")).length);
  // The rail's Work carries the one Needs-you count the server sends; its list is Work's Needs you view.
  expect(workspace.navigation.map(one => one.label)).toEqual(["Work", "Chat", "Settings"]);
  expect(workspace.navigation[0]).toMatchObject({ label: "Work", href: "/", active: true });
  expect(workspace.needsYou).toMatchObject({ scope: null, count: tab("needs-you").count, href: "/?view=needs-you" });
  // One scope for the page and its chrome: /?project=B scopes Work's list and the rail's count alike.
  for (const repo of [repoA, repoB]) {
    const scopedPage = await page(`/?project=${encodeURIComponent(repo)}`, cookie);
    const scoped = scopedPage.view as BrowserWorkView;
    expect(scoped.project).toBe(repo);
    expect(scoped.list.rows.map(row => row.id)).toEqual([repo === repoA ? "ship-webhooks" : "log-format"]);
    expect(scoped.list.tabs.find(one => one.key === "needs-you")!.href).toBe(`/?project=${encodeURIComponent(repo)}&view=needs-you`);
    expect(scopedPage.needsYou).toMatchObject({ scope: repo, href: `/?project=${encodeURIComponent(repo)}&view=needs-you` });
  }
  // A project outside this workspace is refused, never quietly widened.
  const outside = await fetch(url(`/?project=${encodeURIComponent("/somewhere/else")}`), { headers: { cookie } });
  expect(outside.status).toBe(404);
  // The old list's address is Work with the same query (no loop: / never redirects back).
  const moved = await fetch(url(`/tasks?view=running&project=${encodeURIComponent(repoA)}`), { headers: { cookie }, redirect: "manual" });
  expect([moved.status, moved.headers.get("location")]).toEqual([301, `/?view=running&project=${encodeURIComponent(repoA)}`]);
  expect((await fetch(url("/"), { headers: { cookie }, redirect: "manual" })).status).toBe(200);
  // Without JavaScript, Work is a list of links to its tasks (React renders the page itself).
  const html = await (await fetch(url("/"), { headers: { cookie } })).text();
  expect(html).toContain('<a class="work-title" href="/t/ship-webhooks">Harden webhook delivery</a>');
  const stub = /<div data-kit-page><h1>Work<\/h1>[\s\S]*?<p><a href="\/tasks\/new">/.exec(renderedHtmlOf(html))?.[0] ?? "";
  expect(stub).toContain("ship-webhooks");
  expect(stub).not.toMatch(/<form|<button|<input/);
});

test("each of Work's views is the list its segment opens (Queued included), and Needs you groups every ask, on the demo's work", async () => {
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
    const work = (await read("/")).view as BrowserWorkView;
    // What needs you, in Work's three groups, in order; their exact counts add up to the Needs you figure.
    expect(work.needs.map(one => one.label)).toEqual(work.needs.map(one => ({ decide: "Decide", review: "Review", unblock: "Unblock" })[one.key]));
    expect(work.needs.map(one => one.key)).toEqual(["decide", "review", "unblock"].filter(key => work.needs.some(one => one.key === key)));
    expect(work.needs.reduce((sum, one) => sum + one.count, 0)).toBe(work.needsCount);
    // A flow card is never a task: the tasks' Needs you is the list's own figure, and the rest are the other asks.
    const others = work.needs.flatMap(one => one.rows).filter(row => row.id.includes(":")).length;
    expect(work.needsCount - others).toBe(work.list.needsYou);
    // A result to review opens the one result view (task-link.ts): its task page at that exact run, never the old page.
    const reviews = work.needs.find(one => one.key === "review")?.rows ?? [];
    expect(reviews.length).toBeGreaterThan(0);
    for (const row of reviews) expect(row.action?.href, row.id).toMatch(/^\/t\/[^?#]+\?tab=result&run=[1-9][0-9]*$/);
    for (const tab of work.list.tabs.filter(one => ["needs-you", "running", "queued", "completed"].includes(one.key ?? ""))) {
      const list = ((await read(tab.href)).view as BrowserWorkView).list;
      expect(list.tabs.find(one => one.active)?.key, tab.key).toBe(tab.key);
      expect(list.tabs.find(one => one.active)?.count, tab.key).toBe(tab.count);
      expect(list.rows.length, tab.key).toBe(Math.min(tab.count, 40));
    }
  } finally {
    demo.closeAllConnections?.();
    await new Promise<void>(resolve => demo.close(() => resolve()));
    demoStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("with a project open in the session, Work still covers every project, and its count and Needs you list agree", async () => {
  task("ship-webhooks", "Harden webhook delivery", repoA);
  task("log-format", "Rotate the request-log format", repoB);
  const cookie = await login();
  const csrf = (await page("/", cookie)).csrf;
  const opened = await fetch(url("/projects/open"), { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, path: repoA, return: "/" }), redirect: "manual" });
  expect([302, 303], (await opened.text()).match(/class="problem">[^<]*|<p>[^<]*/g)?.join(" | ")).toContain(opened.status);
  const workspace = await page("/", cookie);
  const work = workspace.view as BrowserWorkView;
  // Work covers every project; the rail's count and the list it opens say so by name.
  expect(work.project).toBeNull();
  expect(workspace.needsYou).toMatchObject({ scope: null, href: "/?view=needs-you" });
  const list = ((await page(workspace.needsYou!.href, cookie)).view as BrowserWorkView).list;
  expect(list.needsYou).toBe(workspace.needsYou!.count);
  expect(list.rows.length).toBe(2);
  expect(workspace.needsYou!.count).toBe(2);
});

test("before anything is filed, Work is the first-run checklist in the chat; the chat itself stays where it was", async () => {
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

test("a flow card waiting on this person is a Decide row in Work that opens the card; a project they can't see adds none", async () => {
  task("ship-webhooks", "Harden webhook delivery", repoA);
  const stage = (id: string, kind: string, rest: Record<string, unknown> = {}) => ({ id, title: id, kind, zone: {}, next: null, onFail: null, ...rest });
  const flowIn = (repo: string, title: string) => {
    const flow = store.createFlow({ repo, name: "Purchases", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "decide", stages: [stage("decide", "approval", { next: "done" }), stage("done", "done")] }) }, T0);
    const card = store.addFlowCard({ flow, title, description: null, stage: "decide", by: "alex", byKind: "person" }, T0);
    return { flow, card };
  };
  const mine = flowIn(repoA, "Buy a label printer");
  flowIn("/somewhere/else", "Buy a forklift");
  const cookie = await login();
  const work = (await page("/", cookie)).view as BrowserWorkView;
  const flows = work.needs.flatMap(one => one.rows).filter(row => row.ask === "flow");
  expect(flows).toEqual([expect.objectContaining({ id: `flow:${mine.card}`, title: "Buy a label printer", href: `/flows/${mine.flow}?card=${mine.card}`, group: "decide",
    action: { label: "Open the card", href: `/flows/${mine.flow}?card=${mine.card}` }, question: null })]);
  expect(work.needs.find(one => one.key === "decide")!.rows.some(row => row.id === `flow:${mine.card}`)).toBe(true);
  expect(work.needsCount).toBe(work.list.needsYou + work.needs.flatMap(one => one.rows).filter(row => row.id.includes(":")).length);
});
