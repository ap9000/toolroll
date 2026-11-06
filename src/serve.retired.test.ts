/** Home and Tasks, with permanent redirects (docs/plans/plain-toolroll.md P1.4), through the server: every retired page
 * answers 301 to its place, a project-limited person learns nothing through any of them, /n/<n> opens a task by its
 * stored number only inside the viewer's projects (the same 404 as an unknown number), the push allowlist takes the new
 * destinations and keeps every old one, an old payload lands on its own destination through the old service worker
 * and the new one alike, a new payload lands on an allowed page through the old one, and no rendered link points at a
 * retired page. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createContext, runInContext } from "node:vm";
import type { Server } from "node:http";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore, type Store } from "./store.js";
import { safePushLink } from "./push.js";
import { PWA_WORKER } from "./server/pages-assets.js";
import { ROUTES } from "./server/route-table.js";
import { T0 } from "../test/serve-kit.js";

let store: Store, server: Server, base: string, evidenceRoot: string, repoA: string, repoB: string;
const tokens: Record<string, string> = {};
const url = (path: string) => `${base}${path}`;
async function login(name: string): Promise<string> {
  const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name, token: tokens[name]! }), redirect: "manual" });
  expect(response.status).toBe(303);
  return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
}
const get = (path: string, cookie: string) => fetch(url(path), { headers: { cookie }, redirect: "manual" });
const task = (id: string, title: string, repo: string): number => {
  store.createTask({ id, title }, T0);
  const ref = store.refFor("built-in", id, "ours").id;
  store.placeTask(ref, repo);
  return ref;
};

beforeEach(async () => {
  store = openStore(":memory:");
  evidenceRoot = mkdtempSync(join(tmpdir(), "so-retired-ev-"));
  repoA = realpathSync(mkdtempSync(join(tmpdir(), "so-retired-a-")));
  repoB = realpathSync(mkdtempSync(join(tmpdir(), "so-retired-b-")));
  for (const repo of [repoA, repoB]) execFileSync("git", ["init", "-q", repo]);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  tokens["alex"] = alex.token;
  const sam = addApprover(store, "sam", T0, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  tokens["sam"] = sam.token;
  expect(store.setAccountProjects("sam", [repoA], "alex", T0)).toEqual({ ok: true });
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

describe("retired pages redirect for good", () => {
  test("each old address answers 301 to its place on Home or Tasks, keeping only the keys the target knows", async () => {
    const cookie = await login("alex");
    const expected: Record<string, string> = {
      "/work": "/tasks", "/work?view=needs-you": "/tasks?view=needs-you", "/work?layout=board": "/tasks?view=board",
      "/inbox": "/", "/next": "/", "/workbench": "/tasks?scope=all", "/board": "/tasks?view=board", "/board?view=order": "/tasks?view=order",
      "/queue": "/tasks?view=order", "/review": "/tasks?view=ready", "/done": "/tasks?view=done", "/work/put-away": "/tasks/archive",
    };
    for (const [from, to] of Object.entries(expected)) {
      const answer = await get(from, cookie);
      expect(answer.status, from).toBe(301);
      expect(answer.headers.get("location"), from).toBe(to);
    }
    // The targets are pages.
    for (const to of new Set(Object.values(expected))) expect((await fetch(url(to), { headers: { cookie } })).status, to).toBe(200);
  });

  test("a project-limited person redirected through each path learns nothing about another project", async () => {
    task("in-a", "Ship the receipts", repoA);
    task("in-b", "Secret pricing change", repoB);
    const cookie = await login("sam");
    for (const route of ROUTES.filter(one => one.retired === true)) {
      const path = `${route.sample}${route.sample.includes("?") ? "&" : "?"}project=${encodeURIComponent(repoB)}`;
      const first = await get(path, cookie);
      const landed = first.status === 301 ? await fetch(url(first.headers.get("location")!), { headers: { cookie } }) : first;
      const body = await landed.text();
      expect(body, path).not.toContain("Secret pricing change");
      expect(body, path).not.toContain("in-b");
    }
  });

  test("/n/<number> opens a task by its stored number inside the viewer's projects; outside, the same 404 as an unknown one", async () => {
    const mine = task("in-a", "Ship the receipts", repoA);
    const theirs = task("in-b", "Secret pricing change", repoB);
    const sam = await login("sam");
    const open = await get(`/n/${mine}`, sam);
    expect([301, 302]).toContain(open.status);
    expect(open.headers.get("location")).toBe("/t/in-a");
    const outside = await get(`/n/${theirs}`, sam), unknown = await get("/n/999999", sam);
    expect(outside.status).toBe(404);
    expect(unknown.status).toBe(404);
    const strip = (html: string) => html.replace(/<input type="hidden" name="csrf"[^>]*>/g, "").replace(/nonce="[^"]*"/g, "").replace(/\/n\/[0-9]+/g, "/n/N");
    expect(strip(await outside.text())).toBe(strip(await unknown.text()));
  });

  test("no rendered link points at a retired page", async () => {
    task("in-a", "Ship the receipts", repoA);
    const cookie = await login("alex");
    const retired = ["/work", "/inbox", "/next", "/workbench", "/board", "/queue", "/done"];
    for (const path of ["/", "/tasks", "/tasks?view=board", "/tasks?view=ready", "/tasks?view=order", "/t/in-a", "/settings", "/projects", "/agents", "/flows"]) {
      const html = await (await fetch(url(path), { headers: { cookie } })).text();
      // Markup links (in the page and inside the workspace's own HTML strings) and the workspace's own "href" fields.
      const hrefs = [...html.matchAll(/(?:href|action)=\\?"([^"\\]*)\\?"/g), ...html.matchAll(/"(?:href|path|refreshUrl)":"([^"]*)"/g)].map(match => match[1]!.split("#")[0]!);
      const bad = hrefs.filter(href => retired.some(one => href === one || href.startsWith(`${one}?`)) || href === "/review");
      expect(bad, path).toEqual([]);
    }
  });
});

/** A service worker's two decisions, run in a sandbox: where a push points, and where its tap lands. */
function worker(source: string) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: { url: string }[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; },
    registration: { showNotification: (_title: string, options: { data: { url: string } }) => { shown.push(options.data); return Promise.resolve(); } },
    location: { origin: "https://toolroll.example" },
  };
  const clients = { matchAll: () => Promise.resolve([]), openWindow: (target: string) => { opened.push(target); return Promise.resolve(); } };
  runInContext(source, createContext({ self, clients, URL }));
  return {
    async land(payload: { url: unknown }): Promise<string> {
      handlers["push"]!({ data: { json: () => payload }, waitUntil: () => {} });
      const data = shown.at(-1)!;
      let done: Promise<unknown> = Promise.resolve();
      handlers["notificationclick"]!({ notification: { close: () => {}, data }, waitUntil: (promise: Promise<unknown>) => { done = promise; } });
      await done;
      return new URL(opened.at(-1)!).pathname + new URL(opened.at(-1)!).search;
    },
  };
}

describe("push links", () => {
  const OLD = ["/next", "/review", "/system", "/routines", "/routines/7", "/d/12", "/r/34"];
  const NEW = ["/", "/tasks?view=ready", "/tasks?view=board", "/n/41"];
  const oldWorker = readFileSync(new URL("../test/fixtures/push/sw-0.9.92.js", import.meta.url), "utf8");

  test("the allowlist takes the new destinations and keeps every old shape; it refuses look-alikes and title ids", () => {
    for (const link of [...OLD, ...NEW]) expect(safePushLink("decision", link), link).toBe(link);
    for (const link of ["/n/1x", "/n/../x", "/n/fix-the-footer", "/t/fix-the-footer", "/tasks?view=ready&x=1", "https://evil.example/", "//evil.example"]) expect(safePushLink("decision", link), link).toBe("/");
    expect(safePushLink("merge", null)).toBe("/tasks?view=ready");
  });

  test("an old payload lands on its own destination through the old worker and the new one", async () => {
    for (const source of [oldWorker, PWA_WORKER]) for (const link of OLD) expect(await worker(source).land({ url: link }), link).toBe(link);
  });

  test("the old worker, given each new payload, lands on an allowed page (a shape it doesn't know falls back to /next, which redirects Home)", async () => {
    const old = worker(oldWorker);
    for (const link of NEW) expect([...OLD, link]).toContain(await old.land({ url: link }));
    expect(await worker(PWA_WORKER).land({ url: "/n/41" })).toBe("/n/41");
    expect(await worker(PWA_WORKER).land({ url: "/elsewhere" })).toBe("/");
  });
});
