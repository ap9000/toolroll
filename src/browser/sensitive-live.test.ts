// @vitest-environment happy-dom
/** A sensitive page opens no live connection (UI revamp wave B, Codex round 2): the real task page asking for a plan
 * approval's password, mounted from the server's own payload, joins no room — not its task's, not the workspace's —
 * while an ordinary page still does. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { request as httpRequest, type Server } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserWorkspace } from "../browser-workspace.js";
import { addApprover, propose } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";
import { T0 } from "../../test/serve-kit.js";
import { WorkspaceApp } from "./app.js";
import { useLiveRoom } from "./live.js";

let store: Store, server: Server, port = 0, token = "", dirs: string[] = [];
let root: Root | null = null;
const opened: string[] = [];
class Stream { url: string; readyState = 0; constructor(url: string) { this.url = url; opened.push(url); } addEventListener() {} removeEventListener() {} close() {} onerror = null; onopen = null; }

/** One plain HTTP exchange with the console (node's own client: the page's fetch is the browser's). */
function exchange(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const one = httpRequest({ host: "127.0.0.1", port, method, path, headers }, response => {
      let text = ""; response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text }));
    });
    one.on("error", reject);
    if (body !== undefined) one.write(body);
    one.end();
  });
}

beforeEach(async () => {
  opened.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", Stream);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "so-sensitive-repo-")));
  const evidence = mkdtempSync(join(tmpdir(), "so-sensitive-ev-"));
  dirs = [repo, evidence];
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  token = alex.token;
  store.createTask({ id: "a-one", title: "Guard the limiter" }, T0);
  store.placeTask(store.refFor("built-in", "a-one", "ours").id, repo);
  propose(store, { taskId: "a-one", goal: "Guard the limiter", now: T0 });
  server = createDecisionServer({ store, evidenceRoot: evidence, repos: [repo], clock: () => new Date() });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  port = address.port;
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** A part of the page that follows a room of its own (as TaskView follows its task's). */
function Follows({ room }: { room: string }) { useLiveRoom(room, () => {}); return null; }

test("the real approval page (a password field) mounts with no live connection; an ordinary page still opens one", async () => {
  const login = await exchange("POST", "/login", { "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ name: "alex", token }).toString());
  const cookie = String(([] as string[]).concat(login.headers["set-cookie"] ?? [])[0] ?? "").split(";")[0]!;
  // The page's own payload, as the workspace reads it (the same object the HTML embeds).
  const page = await exchange("GET", "/t/a-one?format=workspace", { cookie, accept: "application/json" });
  expect(page.status).toBe(200);
  const sensitive = JSON.parse(page.text) as BrowserWorkspace;
  expect(sensitive.sensitive).toBe(true);
  expect(sensitive.view?.kind).toBe("task");
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement("div", null, createElement(WorkspaceApp, { initial: sensitive }), createElement(Follows, { room: "task:a-one" }))));
  await act(async () => { await new Promise(done => setTimeout(done, 20)); });
  expect(opened).toEqual([]);
  await act(async () => root!.unmount()); root = null;

  // The same page without its secret: the parts' rooms open as before.
  const ordinary = { ...sensitive, sensitive: false };
  const second = document.createElement("div"); document.body.append(second); root = createRoot(second);
  await act(async () => root!.render(createElement("div", null, createElement(WorkspaceApp, { initial: ordinary }), createElement(Follows, { room: "task:a-one" }))));
  await act(async () => { await new Promise(done => setTimeout(done, 20)); });
  expect(opened.length).toBeGreaterThan(0);
  expect(opened.join(" ")).toContain("room=task%3Aa-one");
});
