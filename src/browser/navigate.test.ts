// @vitest-environment happy-dom
/**
 * Following links in place (docs/plans/live-pages-and-home.md A1.2, A1.3, A1.5, A1.6), against the real console's own
 * workspaces: a menu link swaps the page without a document load (the address, the title, focus, one live stream);
 * Back reads its entry the same way; every doubt is a document load; a sensitive workspace is never rendered by any of
 * the three roads; Home's row selection and the Search panel keep working with the listener installed; the phone
 * drawer closes; the message box keeps or restores its draft; a native form shown in place still posts with the key;
 * and what chromeScript binds once per document is either delegated or never drawn by the workspace. The page's own
 * work, run by the app (docs/plans/task-page-in-app.md): a task with an open question opens and answers in place; a
 * document that ran a page script, and work this app does not know, are document loads; a held page runs none.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { request as httpRequest, type Server } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserWorkspace } from "../browser-workspace.js";
import { PAGE_WORK_VERSION } from "../page-work-contract.js";
import { addApprover, propose } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";
import { chromeScript, KBD_HELP } from "../server/chrome.js";
import { browserWorkspaceDocument } from "../browser-shell.js";
import { KEY_FILL_SCRIPT } from "../server/mutation-key.js";
import { html, htmlString } from "../html.js";
import { presented, sealScopeFixture, T0 } from "../../test/serve-kit.js";
import { acceptWorkspace, useWorkspace, WorkspaceApp } from "./app.js";
import { follow, forgetPlaces, LEAVE_MS, linkToFollow, mayBeInPlace, pageHeld, replaceAddress, setDocumentLoader } from "./navigate.js";
import { mayPrefetch, prefetch, prefetchedKeys, PREFETCH_MAX_PAGES, PREFETCH_TTL_MS, setPrefetchClock, takePrefetched } from "./prefetch.js";
import { askDraft, keepAskDraft, PAGE_READ_MS, readPage } from "./workspace-client.js";
import { WORKSPACE_NUDGE } from "./live-task.js";

let store: Store, server: Server, port = 0, token = "", cookie = "", dirs: string[] = [];
let root: Root | null = null, host: HTMLElement | null = null;
let loads: { href: string; replace: boolean }[] = [];
let restoreLoader: () => void = () => undefined;
/** What the page's fetch should answer instead of the console, by path (the doubt cases). */
let override: ((path: string, init: RequestInit) => Promise<Response> | null) | null = null;
const reads: { path: string; purpose: string | null }[] = [];

class Stream {
  static all: Stream[] = [];
  url: string; readyState = 1; onerror = null; onopen = null;
  constructor(url: string) { this.url = url; Stream.all.push(this); }
  addEventListener() {} removeEventListener() {}
  close() { this.readyState = 2; }
}
const openStreams = () => Stream.all.filter(one => one.readyState !== 2);

/** One HTTP exchange with the console (node's own client), as this browser's signed-in session. */
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

/** The page's fetch: same-origin requests go to the console with the session cookie; nothing else is reachable. */
async function pageFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input), `http://127.0.0.1:${port}`);
  const path = url.pathname + url.search;
  const headers = new Headers(init.headers);
  if (url.searchParams.get("format") === "workspace") reads.push({ path, purpose: headers.get("x-toolroll-read") });
  const replaced = override?.(path, init) ?? null;
  if (replaced !== null) return replaced;
  return toConsole(path, init);
}

/** The console's own answer to one of the page's requests. */
async function toConsole(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const flat: Record<string, string> = { cookie };
  headers.forEach((value, key) => { flat[key] = value; });
  const answer = await exchange(init.method ?? "GET", path, flat, typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : undefined);
  const out = new Headers();
  for (const [key, value] of Object.entries(answer.headers)) if (typeof value === "string") out.set(key, value);
  return new Response(answer.status === 204 || answer.status === 304 ? null : answer.text, { status: answer.status, headers: out });
}

beforeEach(async () => {
  Stream.all = []; loads = []; reads.length = 0; override = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", Stream);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn(pageFetch));
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "so-nav-repo-")));
  const evidence = mkdtempSync(join(tmpdir(), "so-nav-ev-"));
  dirs = [repo, evidence];
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  token = alex.token;
  store.createTask({ id: "a-one", title: "Guard the limiter" }, T0);
  store.placeTask(store.refFor("built-in", "a-one", "ours").id, repo);
  propose(store, { taskId: "a-one", goal: "Guard the limiter", now: T0 });
  server = createDecisionServer({ store, evidenceRoot: evidence, repos: [repo], clock: () => new Date(),
    connectionProbe: async (file: string) => ({ code: 1, stdout: file === "codex" ? "Not logged in\n" : JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false }),
    firstTaskRunner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: false }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  port = address.port;
  const login = await exchange("POST", "/login", { "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ name: "alex", token }).toString());
  cookie = String(([] as string[]).concat(login.headers["set-cookie"] ?? [])[0] ?? "").split(";")[0]!;
  restoreLoader = setDocumentLoader((href, replace) => { loads.push({ href, replace }); });
  try { sessionStorage.clear(); } catch { /* none */ }
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null; host?.remove(); host = null;
  restoreLoader();
  document.body.textContent = "";
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function workspaceAt(path: string): Promise<BrowserWorkspace> {
  const page = await exchange("GET", `${path}${path.includes("?") ? "&" : "?"}format=workspace`, { cookie, accept: "application/json" });
  expect(page.status, path).toBe(200);
  return JSON.parse(page.text) as BrowserWorkspace;
}

/** Open `path` as this document's first page: the address bar there, the app mounted from its workspace. */
async function open(path: string, initial?: BrowserWorkspace): Promise<BrowserWorkspace> {
  const first = initial ?? await workspaceAt(path);
  setURL(`http://127.0.0.1:${port}${path}`);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(WorkspaceApp, { initial: first })); });
  await settle();
  return first;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

function click(element: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  element.dispatchEvent(event);
  return event;
}

/** Wait for the address bar to say `path` (an in-place change), or for a document load. */
async function arrivedAt(path: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (window.location.pathname + window.location.search === path || loads.length > 0) break;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  await settle();
}

const setURL = (url: string): void => { (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url); };
const railLink = (href: string) => document.querySelector<HTMLAnchorElement>(`.so-rail a[href="${href}"]`)!;

test("a menu link changes the page in place: the address, the title, focus, the page itself, one live stream", async () => {
  const home = await open("/");
  expect(home.inPlace).toBe(true);
  const before = window.history.length;
  const event = click(railLink("/tasks"));
  expect(event.defaultPrevented).toBe(true);
  await arrivedAt("/tasks");
  expect(loads).toEqual([]);
  expect(window.location.pathname).toBe("/tasks");
  expect(window.history.length).toBe(before + 1);
  const tasks = await workspaceAt("/tasks");
  expect(document.title.replace(/^\(\d+\+?\) /, "")).toBe(tasks.title);
  expect(document.activeElement?.id).toBe("workspace-main");
  expect(document.querySelector('.so-rail a.so-nav[aria-current="page"]')?.getAttribute("href")).toMatch(/^\/tasks(\?|$)/);
  expect(document.querySelector("[data-home]")).toBeNull();
  expect(reads.at(-1)).toEqual({ path: "/tasks?format=workspace", purpose: "navigate" });
  expect(document.getElementById("so-page-announce")?.getAttribute("aria-live")).toBe("polite");
  expect(openStreams().length).toBeLessThanOrEqual(1);
  // Back: the entry is read the same way and swapped without adding one.
  window.history.replaceState(null, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await arrivedAt("/");
  await settle();
  expect(loads).toEqual([]);
  expect(document.querySelector("[data-home]")).not.toBeNull();
  expect(reads.at(-1)).toEqual({ path: "/?format=workspace", purpose: "navigate" });
  expect(window.history.length).toBe(before + 1);
});

test("after a reload on a page that is not in place, Back to an entry an in-place change made loads that page", async () => {
  // The entry left by an in-place change carries the mark, and keeps the state it had.
  await open("/");
  window.history.replaceState({ kept: 1 }, "", "/");
  click(railLink("/tasks"));
  await arrivedAt("/tasks");
  expect(window.history.state).toEqual({ toolroll: "in-place", toolrollEntry: expect.stringMatching(/^[0-9a-f]{16}$/) });
  await act(async () => root?.unmount());
  root = null; host?.remove(); host = null; loads = [];
  // A new document at /tasks whose page now carries a page script (not in place); the person presses Back.
  const tasks = await workspaceAt("/tasks");
  await open("/tasks", { ...tasks, inPlace: false });
  window.history.replaceState({ kept: 1, toolroll: "in-place" }, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate", { state: { kept: 1, toolroll: "in-place" } }));
  await settle();
  expect(loads).toEqual([{ href: "/", replace: true }]);
  // An entry of the page's own (no mark) is left to the page, as today.
  loads = [];
  window.history.replaceState({ liveRun: 3 }, "", "/tasks?own=1");
  window.dispatchEvent(new PopStateEvent("popstate", { state: { liveRun: 3 } }));
  await settle();
  expect(loads).toEqual([]);
});

test("each doubt is a document load of the same address", async () => {
  await open("/");
  const cases: [string, (path: string, init: RequestInit) => Promise<Response> | null][] = [
    ["redirected (signed out)", () => Promise.resolve(new Response(null, { status: 303, headers: { location: "/login" } }))],
    ["not JSON", () => Promise.resolve(new Response("<p>page</p>", { status: 200, headers: { "content-type": "text/html" } }))],
    ["refused", () => Promise.resolve(new Response("no", { status: 403 }))],
    ["signed out", () => Promise.resolve(new Response("no", { status: 401 }))],
    ["server error", () => Promise.resolve(new Response("no", { status: 500 }))],
    ["network error", () => Promise.reject(new TypeError("offline"))],
    ["incomplete workspace", () => Promise.resolve(new Response(JSON.stringify({ version: 1 }), { status: 200, headers: { "content-type": "application/json" } }))],
  ];
  for (const [name, answer] of cases) {
    loads = [];
    override = (path) => path.startsWith("/tasks?") ? answer(path, {}) : null;
    click(railLink("/tasks"));
    await arrivedAt("/tasks");
    expect(loads, name).toEqual([{ href: "/tasks", replace: false }]);
    expect(window.location.pathname, name).toBe("/");
    expect(document.querySelector("[data-home]"), name).not.toBeNull();
  }
  // A page that is not in place (it carries a page script) loads as a document too.
  loads = [];
  const tasks = await workspaceAt("/tasks");
  override = (path) => path.startsWith("/tasks?") ? Promise.resolve(new Response(JSON.stringify({ ...tasks, inPlace: false }), { status: 200, headers: { "content-type": "application/json" } })) : null;
  click(railLink("/tasks"));
  await arrivedAt("/tasks");
  expect(loads).toEqual([{ href: "/tasks", replace: false }]);
});

test("a read that takes more than its limit, or that a later click overtakes, is never shown", async () => {
  vi.useFakeTimers();
  try {
    const never = (_: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const slow = readPage("/tasks", "navigate", never as typeof fetch);
    vi.advanceTimersByTime(PAGE_READ_MS + 1);
    expect(await slow).toBeNull();
    const stop = new AbortController();
    const overtaken = readPage("/tasks", "navigate", never as typeof fetch, stop.signal);
    stop.abort();
    expect(await overtaken).toBeNull();
  } finally { vi.useRealTimers(); }
});

test("which clicks are taken over: left button, no modifier, a same-origin link with no target, download or full-load mark", async () => {
  setURL(`http://127.0.0.1:${port}/tasks`);
  const link = (attrs: string) => { document.body.innerHTML = `<a ${attrs}><span>go</span></a>`; return document.querySelector("span")!; };
  // The click as the listener sees it, never dispatched: the test document follows no link anywhere.
  const taken = (target: Element, init: Partial<MouseEvent> = {}) => {
    const url = linkToFollow({ defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target, ...init } as MouseEvent);
    return url === null ? null : url.pathname + url.search + url.hash;
  };
  expect(taken(link('href="/agents"'))).toBe("/agents");
  expect(taken(link('href="/agents"'), { metaKey: true })).toBeNull();
  expect(taken(link('href="/agents"'), { ctrlKey: true })).toBeNull();
  expect(taken(link('href="/agents"'), { shiftKey: true })).toBeNull();
  expect(taken(link('href="/agents"'), { button: 1 })).toBeNull();
  expect(taken(link('href="/agents" target="_blank"'))).toBeNull();
  expect(taken(link('href="/agents" download'))).toBeNull();
  expect(taken(link('href="/agents" data-full-load'))).toBeNull();
  expect(taken(link('href="https://elsewhere.example/agents"'))).toBeNull();
  expect(taken(link('href="#section"'))).toBeNull();
  expect(taken(link('href="/tasks#section"'))).toBeNull();
  expect(taken(link('href="/t/one#scope"'))).toBe("/t/one#scope");
  // A component's own handler took the click (Home's row, the menu's Search).
  expect(taken(link('href="/agents"'), { defaultPrevented: true })).toBeNull();
  // Only addresses the server may answer in place are read first; the rest are the browser's own load at once.
  const at = (path: string) => mayBeInPlace(new URL(path, "http://127.0.0.1:9"));
  expect(["/", "/tasks", "/t/one", "/projects", "/agents", "/search", "/settings", "/settings/models"].every(at)).toBe(true);
  expect(["/welcome", "/term", "/agents?view=live", "/t/one/release", "/ledger/export", "/settings/slack/manifest", "/chat", "/login"].some(at)).toBe(false);
});

test("a sensitive workspace is never rendered, by a followed link, by a page's own re-read, or by a confirmation", async () => {
  const sensitive = await workspaceAt("/t/a-one");
  expect(sensitive.sensitive).toBe(true);
  await open("/");
  const serve = (path: string) => path.startsWith("/tasks?") || path.startsWith("/?")
    ? Promise.resolve(new Response(JSON.stringify(sensitive), { status: 200, headers: { "content-type": "application/json" } })) : null;
  // A followed link.
  override = serve;
  click(railLink("/tasks"));
  await arrivedAt("/tasks");
  expect(loads).toEqual([{ href: "/tasks", replace: false }]);
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(window.location.pathname).toBe("/");
  // The page's own re-read (Home re-reads itself on a nudge) that comes back sensitive.
  loads = [];
  await act(async () => { window.dispatchEvent(new Event(WORKSPACE_NUDGE)); });
  for (let i = 0; i < 50 && loads.length === 0; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(loads).toEqual([{ href: "/t/a-one", replace: false }]);
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(document.querySelector("[data-home]")).not.toBeNull();
  // A confirmation (A2's road) goes through the same door.
  loads = [];
  expect(acceptWorkspace(sensitive, "confirm", "/t/a-one")).toBe(false);
  expect(loads).toEqual([{ href: "/t/a-one", replace: false }]);
});

test("the sensitive page's own document still shows its re-read; it never changes page in place", async () => {
  const sensitive = await open("/t/a-one");
  expect(acceptWorkspace(sensitive, "refresh")).toBe(true);
  expect(loads).toEqual([]);
  // Nothing changes page in place from it: its own workspace says it is not in place.
  expect(sensitive.inPlace).not.toBe(true);
  expect(acceptWorkspace(await workspaceAt("/tasks"), "navigate")).toBe(false);
});

test("Home's row selection and the Search panel still work with the listener installed", async () => {
  await open("/");
  const row = document.querySelector<HTMLAnchorElement>('[data-home] a[role="option"]');
  expect(row).not.toBeNull();
  const readsBefore = reads.length;
  await act(async () => { click(row!); });
  await settle();
  expect(row!.getAttribute("aria-selected")).toBe("true");
  expect(window.location.pathname).toBe("/");
  expect(loads).toEqual([]);
  expect(reads.slice(readsBefore).some(one => one.purpose === "navigate")).toBe(false);
  await act(async () => { click(document.querySelector("[data-rail-search]")!); });
  await settle();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(window.location.pathname).toBe("/");
  expect(loads).toEqual([]);
});

test("the phone drawer closes when one of its links changes the page", async () => {
  await open("/");
  await act(async () => { click(document.querySelector('.so-ph button[aria-label="Open navigation"]')!); });
  const sheet = document.querySelector('[role="dialog"][aria-label="Navigation"]');
  expect(sheet).not.toBeNull();
  click(sheet!.querySelector('a[href="/tasks"]')!);
  await arrivedAt("/tasks");
  expect(loads).toEqual([]);
  expect(window.location.pathname).toBe("/tasks");
  expect(document.querySelector('[role="dialog"][aria-label="Navigation"]')).toBeNull();
  expect(document.activeElement?.id).toBe("workspace-main");
});

test("a native form on a page shown in place posts with the browser's key", async () => {
  localStorage.setItem("toolroll.key", JSON.stringify({ epoch: "e", key: "c".repeat(64) }));
  new Function(KEY_FILL_SCRIPT)();
  await open("/");
  let target: string | null = null;
  for (const path of ["/settings/models", "/settings/tools", "/settings/general", "/settings/approval", "/settings/checks", "/settings"]) {
    const page = await workspaceAt(path);
    if (page.inPlace === true && /<form[^>]*method="post"/i.test(page.pageHtml ?? "")) { target = path; break; }
  }
  expect(target, "an in-place Settings page with a native form").not.toBeNull();
  await act(async () => { await follow(target!, "push"); });
  await settle();
  expect(loads).toEqual([]);
  const form = document.querySelector<HTMLFormElement>('#workspace-main form[method="post"]');
  expect(form).not.toBeNull();
  const formData = new FormData();
  const event = new Event("formdata", { bubbles: true });
  Object.defineProperty(event, "formData", { value: formData });
  form!.dispatchEvent(event);
  expect(formData.get("toolroll-key")).toBe("c".repeat(64));
});

test("what chromeScript binds once per document is delegated, beside the app, or never drawn by the workspace", async () => {
  // Every element chromeScript looks up, and how each survives an in-place change. A new lookup must be classified here.
  const ABSENT = [".app", ".side-toggle", "[data-waiting]", ".nav-group", "palette-index"]; // the legacy chrome: never in the React workspace
  const BESIDE = [".kbd-help"]; // placed beside the app's mount (browser-shell.ts), so it outlives every page change
  const AT_USE = ["time[data-elapsed-since]", "a.row, a.lane-card", "details.switcher[open],details.work-tools[open]", "[data-workspace-shell]", "summary", "[hidden],[inert]", "[role=textbox],[role=dialog]:not(.kbd-help)"]; // read at a key or click
  const script = chromeScript();
  const found = new Set([...script.matchAll(/(?:querySelector(?:All)?|getElementById|closest)\("([^"]+)"\)/g)].map(match => match[1]!));
  for (const selector of found) expect([...ABSENT, ...BESIDE, ...AT_USE], selector).toContain(selector);
  // The keyboard help sits outside the app's mount.
  const document_ = htmlString(browserWorkspaceDocument(html`<html><head></head><body><main>x</main></body></html>`, await workspaceAt("/"), "n", "", KBD_HELP));
  expect(document_.indexOf('class="kbd-help"')).toBeGreaterThan(document_.indexOf("</div>", document_.indexOf('id="standing-orders-workspace"')));
  // None of the load-time lookups finds anything in the workspace, before or after an in-place change.
  const absent = () => ABSENT.every(selector => (selector === "palette-index" ? document.getElementById(selector) : document.querySelector(selector)) === null);
  await open("/");
  expect(absent()).toBe(true);
  click(railLink("/tasks"));
  await arrivedAt("/tasks");
  expect(loads).toEqual([]);
  expect(absent()).toBe(true);
});

// ---- the message box across pages (A1.3) ---------------------------------------------------------------------------

const conversation = (session: number, taskId: string) => ({ sessionId: session, user: "alex", version: "1", requestId: "a".repeat(32), maxChars: 4000,
  taskId, resultRunId: null, project: null, pendingTurnId: null, messages: [] });
const page = (path: string, chat: ReturnType<typeof conversation> | null): BrowserWorkspace => ({ version: 1, path, title: path, user: "alex", csrf: "c", sensitive: false,
  inPlace: true, refreshUrl: path, receipt: null, projects: [], crew: [], crewTruncated: false, conversation: chat, focus: null, result: null, catchUpHtml: "",
  controlsHtml: "", notices: [], view: null, pageHtml: null, navigation: [] } as unknown as BrowserWorkspace);

test("the message box keeps its words within one conversation and takes the saved draft for another", async () => {
  setURL(`http://127.0.0.1:${port}/t/one`);
  let controller: ReturnType<typeof useWorkspace> | null = null;
  function Probe({ initial }: { initial: BrowserWorkspace }) { controller = useWorkspace(initial); return null; }
  const one = page("/t/one", conversation(7, "one"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(Probe, { initial: one })); });
  await act(async () => { controller!.edit("about the limiter"); });
  // The same conversation on another address (a tab of the same task): the words stay.
  await act(async () => { controller!.adopt(page("/t/one?tab=activity", conversation(7, "one"))); });
  expect(controller!.draft.text).toBe("about the limiter");
  expect(controller!.epoch).toBe(1);
  // Another task's conversation: its own saved draft (none yet).
  await act(async () => { controller!.adopt(page("/t/two", conversation(9, "two"))); });
  expect(controller!.draft.text).toBe("");
  await act(async () => { controller!.edit("about the other one"); });
  // Back to the first: its saved words.
  await act(async () => { controller!.adopt(page("/t/one", conversation(7, "one"))); });
  expect(controller!.draft.text).toBe("about the limiter");
  await act(async () => { controller!.adopt(page("/t/two", conversation(9, "two"))); });
  expect(controller!.draft.text).toBe("about the other one");
});

test("Home's ask box keeps its words in this tab, for this sign-in and project only, until sent", () => {
  keepAskDraft("csrf-one", "/r/shop", "what broke?");
  expect(askDraft("csrf-one", "/r/shop")).toBe("what broke?");
  expect(askDraft("csrf-two", "/r/shop")).toBe("");
  expect(askDraft("csrf-one", null)).toBe("");
  keepAskDraft("csrf-one", "/r/shop", "");
  expect(askDraft("csrf-one", "/r/shop")).toBe("");
  keepAskDraft("", null, "no sign-in");
  expect(askDraft("", null)).toBe("");
});

// ---- A2: reading ahead, the inert page and its confirmation, the pressed link, Back with its place -----------------

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
const purposeOf = (init: RequestInit) => new Headers(init.headers).get("x-toolroll-read");
/** A gate: the request waits until the test opens it, then is answered by `answer` (the console, by default). */
function gate(): { open(answer?: () => Promise<Response>): void; wait(path: string, init: RequestInit): Promise<Response> } {
  let release!: (answer: (() => Promise<Response>) | undefined) => void;
  const opened = new Promise<(() => Promise<Response>) | undefined>(resolve => { release = resolve; });
  return {
    open: answer => release(answer),
    wait: (path, init) => opened.then(answer => answer === undefined ? toConsole(path, init) : answer()),
  };
}
async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 10) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
const rest = (element: Element) => element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
const mainParts = () => [...document.getElementById("workspace-main")!.children];

test("a link the pointer rests on is read ahead, never minting or mounting; its click shows it at once, inert, then remounts it from the confirmed read", async () => {
  await open("/");
  rest(railLink("/tasks"));
  await waitFor(() => prefetchedKeys().includes("/tasks"));
  expect(reads.filter(one => one.purpose === "prefetch").map(one => one.path)).toEqual(["/tasks?format=workspace"]);
  // Read ahead is data only: nothing of it is on screen.
  expect(document.querySelector("[data-home]")).not.toBeNull();
  const confirming = gate();
  override = (path, init) => path.startsWith("/tasks?") && purposeOf(init) === "navigate" ? confirming.wait(path, init) : null;
  click(railLink("/tasks"));
  await waitFor(() => window.location.pathname === "/tasks");
  await settle();
  // Shown at once, before the ordinary read lands, and nothing of it takes input.
  expect(document.querySelector("[data-home]")).toBeNull();
  expect(mainParts().length).toBeGreaterThan(0);
  expect(mainParts().every(part => part.hasAttribute("inert"))).toBe(true);
  expect(document.getElementById("workspace-main")!.hasAttribute("data-so-provisional")).toBe(true);
  expect(reads.at(-1)).toEqual({ path: "/tasks?format=workspace", purpose: "navigate" });
  const shown = mainParts()[0];
  confirming.open();
  await waitFor(() => !document.getElementById("workspace-main")!.hasAttribute("data-so-provisional"));
  await settle();
  expect(loads).toEqual([]);
  // Remounted from the confirmed page (a new instance), never patched, and interactive.
  expect(mainParts()[0]).not.toBe(shown);
  expect(mainParts().some(part => part.hasAttribute("inert"))).toBe(false);
  expect(document.activeElement?.id).toBe("workspace-main");
  // A page used once is not kept.
  expect(prefetchedKeys()).not.toContain("/tasks");
});

test("a confirming read that fails any check loads the document over the same entry, and the page read ahead never takes input", async () => {
  await open("/");
  rest(railLink("/tasks"));
  await waitFor(() => prefetchedKeys().includes("/tasks"));
  const tasks = await workspaceAt("/tasks");
  for (const [name, answer] of [
    ["server error", () => Promise.resolve(new Response("no", { status: 500 }))],
    ["no longer in place", () => Promise.resolve(json({ ...tasks, inPlace: false }))],
  ] as const) {
    loads = [];
    override = (path, init) => path.startsWith("/tasks?") && purposeOf(init) === "navigate" ? answer() : null;
    if (!prefetchedKeys().includes("/tasks")) { prefetch(new URL("/tasks", window.location.href)); await waitFor(() => prefetchedKeys().includes("/tasks")); }
    await act(async () => { await follow("/tasks", "push"); });
    expect(loads, name).toEqual([{ href: "/tasks", replace: true }]);
    expect(mainParts().every(part => part.hasAttribute("inert")), name).toBe(true);
  }
});

test("a sensitive page read ahead is never rendered: its click loads the document", async () => {
  const sensitive = await workspaceAt("/t/a-one");
  await open("/");
  override = (path, init) => path.startsWith("/tasks?") && purposeOf(init) === "prefetch" ? Promise.resolve(json(sensitive)) : null;
  rest(railLink("/tasks"));
  await waitFor(() => prefetchedKeys().includes("/tasks"));
  click(railLink("/tasks"));
  await waitFor(() => loads.length > 0);
  expect(loads).toEqual([{ href: "/tasks", replace: false }]);
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(document.querySelector("[data-home]")).not.toBeNull();
  expect(window.location.pathname).toBe("/");
});

test("reading ahead: two at once, twenty pages, ten seconds each, dropped on a change or a nudge, off when hidden or saving data", async () => {
  await open("/");
  const held = gate();
  override = (path, init) => purposeOf(init) === "prefetch" ? held.wait(path, init) : null;
  const at = (path: string) => new URL(path, window.location.href);
  for (const path of ["/tasks", "/projects", "/agents"]) prefetch(at(path));
  await settle();
  expect(reads.filter(one => one.purpose === "prefetch").length).toBe(2);
  held.open();
  await waitFor(() => prefetchedKeys().length === 2);
  // Only the pages the server reads ahead.
  expect(["/", "/tasks", "/t/one", "/projects", "/agents", "/search"].every(path => mayPrefetch(at(path)))).toBe(true);
  expect(["/settings", "/settings/models", "/agents?view=live", "/agents?run=3", "/chat", "/welcome", "/term"].some(path => mayPrefetch(at(path)))).toBe(false);
  // A change in the workspace's room, and a nudge, drop everything.
  window.dispatchEvent(new CustomEvent("so:live", { detail: { room: "workspace", event: "change", data: {} } }));
  expect(prefetchedKeys()).toEqual([]);
  const tasks = await workspaceAt("/tasks");
  override = (_path, init) => purposeOf(init) === "prefetch" ? Promise.resolve(json(tasks)) : null;
  prefetch(at("/tasks"));
  await waitFor(() => prefetchedKeys().length === 1);
  window.dispatchEvent(new Event(WORKSPACE_NUDGE));
  expect(prefetchedKeys()).toEqual([]);
  // At most twenty pages, the oldest dropped first.
  for (let i = 0; i < PREFETCH_MAX_PAGES + 5; i++) { prefetch(at(`/t/x${i}`)); await waitFor(() => prefetchedKeys().includes(`/t/x${i}`)); }
  expect(prefetchedKeys().length).toBe(PREFETCH_MAX_PAGES);
  expect(prefetchedKeys()).not.toContain("/t/x0");
  // Ten seconds each.
  let clock = Date.now();
  const restoreClock = setPrefetchClock(() => clock);
  try {
    prefetch(at("/search"));
    await waitFor(() => prefetchedKeys().includes("/search"));
    clock += PREFETCH_TTL_MS + 1;
    expect(takePrefetched(at("/search"))).toBeNull();
  } finally { restoreClock(); }
  // Off in a hidden tab, and when the browser asks to save data.
  const readsBefore = reads.length;
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  prefetch(at("/projects"));
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
  prefetch(at("/projects"));
  Object.defineProperty(navigator, "connection", { value: undefined, configurable: true });
  await settle();
  expect(reads.length).toBe(readsBefore);
});

test("without a page read ahead the pressed link is marked at once, and a slow read draws the line until it lands", async () => {
  await open("/");
  const slow = gate();
  override = (path, init) => path.startsWith("/tasks?") && purposeOf(init) === "navigate" ? slow.wait(path, init) : null;
  const link = railLink("/tasks");
  click(link);
  expect(link.hasAttribute("data-so-pressed")).toBe(true);
  const column = document.querySelector(".so-main-column")!;
  expect(column.hasAttribute("data-so-loading")).toBe(false);
  await waitFor(() => column.hasAttribute("data-so-loading"), 1_000);
  expect(column.hasAttribute("data-so-loading")).toBe(true);
  slow.open();
  await arrivedAt("/tasks");
  expect(loads).toEqual([]);
  expect(document.querySelector(".so-main-column")!.hasAttribute("data-so-loading")).toBe(false);
  expect(document.querySelector("[data-so-pressed]")).toBeNull();
});

test("Back puts the page where it was left: kept in this tab, never written to history by a scroll; the entry left keeps its mark and every other key", async () => {
  await open("/");
  click(railLink("/tasks"));
  await arrivedAt("/tasks");
  window.history.replaceState({ ...window.history.state, kept: 1 }, "");
  const entry = (window.history.state as Record<string, unknown>).toolrollEntry;
  expect(entry).toMatch(/^[0-9a-f]{16}$/);
  const pane = () => document.querySelector<HTMLElement>("#workspace-main .so-page-content")!;
  const written: unknown[] = [];
  const replace = window.history.replaceState.bind(window.history);
  const push = window.history.pushState.bind(window.history);
  const replaced = vi.spyOn(window.history, "replaceState").mockImplementation((state, unused, url) => { written.push(state); replace(state, unused, url); });
  const pushedTo = vi.spyOn(window.history, "pushState").mockImplementation((state, unused, url) => { written.push(state); push(state, unused, url); });
  // A scroll that settles is kept under the entry's name in this tab's storage. History hears nothing of it: a history
  // write is a navigation to everything that waits for one.
  pane().scrollTop = 120;
  pane().dispatchEvent(new Event("scroll"));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
  expect(written).toEqual([]);
  const kept = new Map(JSON.parse(sessionStorage.getItem("toolroll.places") ?? "[]") as [string, { parts: [string, number, number][] }][]);
  expect(kept.get(String(entry))?.parts.some(part => part[1] === 120)).toBe(true);
  await act(async () => { await follow("/projects", "push"); });
  replaced.mockRestore(); pushedTo.mockRestore();
  await settle();
  const left = written.find(state => typeof state === "object" && state !== null && (state as Record<string, unknown>).kept === 1) as Record<string, unknown> | undefined;
  expect(left).toEqual({ toolroll: "in-place", toolrollEntry: entry, kept: 1 });
  expect(JSON.stringify(written)).not.toContain("parts");
  expect(pane().scrollTop).toBe(0);
  // Back to it, in a document that remembers nothing itself (a reload between the two entries).
  forgetPlaces();
  window.history.replaceState(left, "", "/tasks");
  window.dispatchEvent(new PopStateEvent("popstate", { state: left }));
  await arrivedAt("/tasks");
  await waitFor(() => pane()?.scrollTop === 120);
  expect(loads).toEqual([]);
  expect(pane().scrollTop).toBe(120);
  // What the storage holds is checked like any input: a damaged list is no place at all.
  await act(async () => { await follow("/projects", "push"); });
  await settle();
  forgetPlaces();
  sessionStorage.setItem("toolroll.places", JSON.stringify([[entry, { x: "0", y: 0, parts: [["0", 120, 0]] }], ["not a name", { x: 0, y: 9, parts: [] }]]));
  window.history.replaceState(left, "", "/tasks");
  window.dispatchEvent(new PopStateEvent("popstate", { state: left }));
  await arrivedAt("/tasks");
  await settle();
  expect(loads).toEqual([]);
  expect(pane().scrollTop).toBe(0);
});

test("a page's own change to its address keeps the entry: its place is still saved there, Back is still a page change, and another page's address is never written over", async () => {
  await open("/");
  click(railLink("/tasks"));
  await arrivedAt("/tasks");
  window.history.replaceState({ ...window.history.state, kept: 1 }, "");
  const state = window.history.state as Record<string, unknown>;
  const pane = () => document.querySelector<HTMLElement>("#workspace-main .so-page-content")!;
  const placeKept = (): number[] => {
    const kept = new Map(JSON.parse(sessionStorage.getItem("toolroll.places") ?? "[]") as [string, { parts: [string, number, number][] }][]);
    return (kept.get(String(state.toolrollEntry))?.parts ?? []).map(part => part[1]);
  };
  const scrollTo = async (top: number): Promise<void> => {
    pane().scrollTop = top;
    pane().dispatchEvent(new Event("scroll"));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
  };
  // The page names a section of its own (a result section, a task tab): the same entry, every key of its state kept.
  expect(replaceAddress("/tasks?section=changes#top")).toBe(true);
  expect(window.location.pathname + window.location.search + window.location.hash).toBe("/tasks?section=changes#top");
  expect(window.history.state).toEqual(state);
  await scrollTo(90);
  expect(placeKept()).toContain(90);
  // An address written past navigation is, as far as it knows, another page's: the place stops being saved. (What
  // the task page did before, and why its own changes go through `replaceAddress`.)
  window.history.replaceState(window.history.state, "", "/tasks?section=checks");
  await scrollTo(40);
  expect(placeKept()).not.toContain(40);
  // And while the address names another page, this page writes nothing over it.
  expect(replaceAddress("/tasks?section=summary")).toBe(false);
  expect(window.location.search).toBe("?section=checks");
  // Back under the page's own address, it is the page's to change again; Back to the entry before is a page change.
  window.history.replaceState(window.history.state, "", "/tasks?section=changes");
  expect(replaceAddress("/tasks?section=summary")).toBe(true);
  expect(loads).toEqual([]);
  window.history.replaceState({ toolroll: "in-place" }, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate", { state: { toolroll: "in-place" } }));
  await arrivedAt("/");
  expect(loads).toEqual([]);
});

test("Back and then Forward before the page is read: the page on screen stays under its own address, and the late answer shows nothing", async () => {
  await open("/");
  click(railLink("/tasks"));
  await arrivedAt("/tasks");
  const tasksEntry = window.history.state as Record<string, unknown>;
  const title = document.title;
  const late = gate();
  override = (path, init) => path.startsWith("/?") && purposeOf(init) === "navigate" ? late.wait(path, init) : null;
  // Back: the address is Home's, and Home is being read.
  window.history.replaceState({ toolroll: "in-place" }, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate", { state: { toolroll: "in-place" } }));
  await settle();
  expect(reads.at(-1)).toEqual({ path: "/?format=workspace", purpose: "navigate" });
  // Forward, before it lands: the address is the Tasks list's again, the page still on screen.
  window.history.replaceState(tasksEntry, "", "/tasks");
  window.dispatchEvent(new PopStateEvent("popstate", { state: tasksEntry }));
  await settle();
  late.open();
  await settle();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(window.location.pathname).toBe("/tasks");
  expect(document.querySelector("[data-home]")).toBeNull();
  expect(document.title).toBe(title);
  expect(loads).toEqual([]);
  expect(document.querySelector(".so-main-column")!.hasAttribute("data-so-loading")).toBe(false);
  // Links work as before.
  override = null;
  click(railLink("/projects"));
  await arrivedAt("/projects");
  expect(loads).toEqual([]);
  expect(window.location.pathname).toBe("/projects");
});

test("a page shown ahead whose confirming read Back called off is read again on Forward: it never stays unconfirmed", async () => {
  await open("/");
  const homeEntry = { toolroll: "in-place" };
  rest(railLink("/tasks"));
  await waitFor(() => prefetchedKeys().includes("/tasks"));
  const first = gate(), home = gate();
  let tasksReads = 0;
  override = (path, init) => {
    if (purposeOf(init) !== "navigate") return null;
    if (path.startsWith("/tasks?")) { tasksReads += 1; return tasksReads === 1 ? first.wait(path, init) : null; }
    return path.startsWith("/?") ? home.wait(path, init) : null;
  };
  click(railLink("/tasks"));
  await waitFor(() => window.location.pathname === "/tasks");
  await settle();
  const main = () => document.getElementById("workspace-main")!;
  expect(main().hasAttribute("data-so-provisional")).toBe(true);
  expect(pageHeld()).toBe(true);
  const tasksEntry = window.history.state as Record<string, unknown>;
  // Back (Home is being read; the page shown ahead is still on screen, inert), then Forward before Home lands.
  window.history.replaceState(homeEntry, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate", { state: homeEntry }));
  await settle();
  expect(main().hasAttribute("data-so-provisional")).toBe(true);
  window.history.replaceState(tasksEntry, "", "/tasks");
  window.dispatchEvent(new PopStateEvent("popstate", { state: tasksEntry }));
  await waitFor(() => !main().hasAttribute("data-so-provisional"));
  await settle();
  // Confirmed by a read of its own, and interactive; the two answers called off change nothing when they land.
  expect(tasksReads).toBe(2);
  expect(pageHeld()).toBe(false);
  expect(mainParts().some(part => part.hasAttribute("inert"))).toBe(false);
  first.open(); home.open();
  await settle();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(window.location.pathname).toBe("/tasks");
  expect(document.querySelector("[data-home]")).toBeNull();
  expect(loads).toEqual([]);
});

test("a page shown ahead of its own read acts on nothing: a result is marked seen only once the page is confirmed, and an opened agent is never read ahead", async () => {
  const tasks = await workspaceAt("/tasks");
  const withResult = { ...tasks, result: { runId: 7, html: "<p>Done.</p>" } };
  await open("/");
  const seen: string[] = [];
  const confirming = gate();
  override = (path, init) => {
    if (path === "/agents/seen" || path === "/agents/watch") { seen.push(`${path} ${String(init.body)}`); return Promise.resolve(json({ ok: true })); }
    if (!path.startsWith("/tasks?")) return null;
    return purposeOf(init) === "prefetch" ? Promise.resolve(json(withResult)) : confirming.wait(path, init);
  };
  rest(railLink("/tasks"));
  await waitFor(() => prefetchedKeys().includes("/tasks"));
  click(railLink("/tasks"));
  await waitFor(() => window.location.pathname === "/tasks");
  await settle();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(document.getElementById("workspace-main")!.hasAttribute("data-so-provisional")).toBe(true);
  expect(pageHeld()).toBe(true);
  expect(seen).toEqual([]);
  confirming.open(() => Promise.resolve(json(withResult)));
  await waitFor(() => !document.getElementById("workspace-main")!.hasAttribute("data-so-provisional"));
  await waitFor(() => seen.length > 0);
  expect(pageHeld()).toBe(false);
  expect(seen.length).toBe(1);
  expect(seen[0]).toContain("/agents/seen");
  expect(seen[0]).toContain("run=7");
  // An opened agent (seen or watched by opening it) is never read ahead at all.
  const at = (path: string) => new URL(path, window.location.href);
  expect(mayPrefetch(at("/agents"))).toBe(true);
  expect(["/agents?run=3", "/agents?run=3&project=x", "/agents?view=live"].some(path => mayPrefetch(at(path)))).toBe(false);
  const before = reads.length;
  prefetch(at("/agents?run=3"));
  await settle();
  expect(reads.length).toBe(before);
});

// ---- a navigation the browser began wins over one a script would start ----------------------------------------------

test("once the document is leaving, a page that became sensitive on its own re-read loads nothing over it; if it stays, it reads again in full", async () => {
  const sensitive = await workspaceAt("/t/a-one");
  await open("/");
  const asked: (string | null)[] = [];
  override = (path, init) => {
    if (!path.startsWith("/?")) return null;
    asked.push(new Headers(init.headers).get("if-none-match"));
    return Promise.resolve(json(sensitive, { etag: '"sensitive-1"' }));
  };
  window.dispatchEvent(new Event("beforeunload"));
  await act(async () => { window.dispatchEvent(new Event(WORKSPACE_NUDGE)); });
  await waitFor(() => asked.length > 0);
  await settle();
  expect(loads).toEqual([]);
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(document.querySelector("[data-home]")).not.toBeNull();
  // The door still refuses while leaving, on every road.
  expect(acceptWorkspace(sensitive, "navigate", "/t/a-one")).toBe(false);
  expect(loads).toEqual([]);
  // The leave was cancelled (the person acts on the page again): it reads again, in full, and the door loads it.
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await waitFor(() => loads.length > 0);
  expect(loads).toEqual([{ href: "/t/a-one", replace: false }]);
  expect(asked.length).toBe(2);
  expect(asked[1]).toBeNull();
  expect(document.querySelector('input[type="password"]')).toBeNull();
});

test("once the document is leaving, a followed link's late answer shows, pushes and loads nothing; after a cancelled leave links work again", async () => {
  await open("/");
  const before = window.history.length;
  for (const answer of [undefined, () => Promise.resolve(new Response("no", { status: 500 }))]) {
    const late = gate();
    override = (path, init) => path.startsWith("/tasks?") && purposeOf(init) === "navigate" ? late.wait(path, init) : null;
    click(railLink("/tasks"));
    await settle();
    window.dispatchEvent(new Event("beforeunload"));
    late.open(answer);
    await settle();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(loads).toEqual([]);
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(before);
    expect(document.querySelector("[data-home]")).not.toBeNull();
    document.body.dispatchEvent(new Event("keydown", { bubbles: true }));
  }
  override = null;
  click(railLink("/tasks"));
  await arrivedAt("/tasks");
  expect(loads).toEqual([]);
  expect(window.location.pathname).toBe("/tasks");
  expect(LEAVE_MS).toBeLessThanOrEqual(10_000);
});

// ---- the page's own work, run by the app (docs/plans/task-page-in-app.md) ------------------------------------------

/** A task whose build stopped on a question, as the console's own records keep it; the question's number. */
function stoppedOnQuestion(id: string): number {
  store.createTask({ id, title: `decide ${id}` }, T0);
  const ref = store.refFor("built-in", id, "ours").id;
  store.placeTask(ref, dirs[0]!);
  sealScopeFixture(store, id, token);
  const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "b1", branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: T0, ...presented(store, ref, "builder") });
  store.finishRun(run, { outcome: "parked", reason: "decision:1", now: T0 });
  return store.saveDecision({
    run, urgency: "blocking", recap: `why ${id} stopped`, question: "Which way?",
    options: [
      { id: "keep", label: "Keep and backfill", consequence: "reversible cleanup later", reversible: true },
      { id: "drop", label: "Drop it", consequence: "it does not come back", reversible: false },
    ],
    recommendation: "keep",
  }, T0);
}

/** A page as a tab that runs page work reads it (the app's own reads say so; `workspaceAt` reads as an older tab). */
async function workAt(path: string): Promise<BrowserWorkspace> {
  const page = await exchange("GET", `${path}${path.includes("?") ? "&" : "?"}format=workspace`, { cookie, accept: "application/json", "x-toolroll-work": String(PAGE_WORK_VERSION) });
  expect(page.status, path).toBe(200);
  return JSON.parse(page.text) as BrowserWorkspace;
}

/** A POST answered as a browser's fetch answers it: the redirect followed, the answer naming the page it landed on. */
async function followed(path: string, init: RequestInit): Promise<Response> {
  const posted = await toConsole(path, init);
  const to = posted.headers.get("location");
  if (posted.status !== 303 || to === null) return posted;
  const landed = await toConsole(to);
  Object.defineProperty(landed, "url", { value: `${window.location.origin}${to}` });
  return landed;
}

const submit = async (form: Element): Promise<Event> => {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  await act(async () => { form.dispatchEvent(event); });
  return event;
};
/** The menu's Tasks link as a task page draws it (it names the task's project). */
const tasksLink = () => document.querySelector<HTMLAnchorElement>(`.so-rail a[href^="/tasks?project="]`)!;
const answerForm = (decision: number) => document.querySelector<HTMLFormElement>(`[data-decision-id="${decision}"] form.decide-inline`);

test("a task with an open question opens in place, and its answer acts in place: one POST, the receipt in its card", async () => {
  const decision = stoppedOnQuestion("q-one");
  // An older tab says nothing about page work: it is still told to load the page as a document, and handed none.
  const old = await workspaceAt("/t/q-one");
  expect(old.inPlace).toBe(false);
  expect(old.work).toBeUndefined();
  // This app's reads say it runs page work, so the page is the app's: no page script, in place.
  const task = await workAt("/t/q-one");
  expect(task.work).toEqual([{ kind: "answer" }]);
  expect(task.inPlace).toBe(true);
  expect(task.sensitive).not.toBe(true);

  await open("/");
  await act(async () => { await follow("/t/q-one", "push"); });
  await arrivedAt("/t/q-one");
  expect(loads).toEqual([]);
  expect(window.location.pathname).toBe("/t/q-one");
  expect(answerForm(decision)).not.toBeNull();

  const posts: string[] = [];
  override = (path, init) => { if (init.method !== "POST") return null; posts.push(`${path} ${String(init.body)}`); return followed(path, init); };
  expect((await submit(answerForm(decision)!)).defaultPrevented).toBe(true);
  await waitFor(() => document.querySelector(`[data-decision-id="${decision}"] .answered`) !== null);
  expect(posts.length).toBe(1);
  expect(posts[0]).toMatch(new RegExp(`^/d/${decision}/answer `));
  expect(posts[0]).toContain("choice=keep");
  expect(answerForm(decision)).toBeNull();
  expect(store.getDecision(decision)?.answer).not.toBeNull();
  expect(loads).toEqual([]);

  // Another page, in place: the task's listener ended with it, so a form of that shape there is the browser's own.
  const tasks = tasksLink().getAttribute("href")!;
  click(tasksLink());
  await arrivedAt(tasks);
  expect(loads).toEqual([]);
  expect(window.location.pathname).toBe("/tasks");
  document.getElementById("workspace-main")!.insertAdjacentHTML("beforeend", `<div data-decision-id="99"><form class="decide-inline" method="post" action="/d/99/answer"><input type="hidden" name="choice" value="keep"></form></div>`);
  expect((await submit(answerForm(99)!)).defaultPrevented).toBe(false);
  await settle();
  expect(posts.length).toBe(1);
});

test("a document that ran a page script never changes page in place, and the app runs no work beside that script", async () => {
  const decision = stoppedOnQuestion("q-two");
  const task = await workAt("/t/q-two");
  // The document as a server would never send it (a script string and work at once): the string is what ran.
  await open("/t/q-two", { ...task, scripted: true });
  const posts: string[] = [];
  override = (path, init) => { if (init.method !== "POST") return null; posts.push(path); return followed(path, init); };
  expect((await submit(answerForm(decision)!)).defaultPrevented).toBe(false);
  await settle();
  expect(posts).toEqual([]);
  // A followed link and a confirmation are document loads: the script's listeners last as long as the document.
  const tasks = tasksLink().getAttribute("href")!;
  click(tasksLink());
  await arrivedAt(tasks);
  expect(loads).toEqual([{ href: tasks, replace: false }]);
  expect(window.location.pathname).toBe("/t/q-two");
  loads = [];
  expect(acceptWorkspace(await workspaceAt("/tasks"), "confirm", "/tasks")).toBe(false);
  expect(loads).toEqual([{ href: "/tasks", replace: false }]);
  // Its own re-read still shows.
  loads = [];
  expect(acceptWorkspace(task, "refresh")).toBe(true);
  expect(loads).toEqual([]);
});

test("work this app does not know is a document load; a malformed list is no page at all", async () => {
  await open("/");
  const tasks = await workspaceAt("/tasks");
  expect(tasks.inPlace).toBe(true);
  // A newer server names work this app has no version of: showing the page without it would leave it half working.
  override = path => path.startsWith("/tasks?") ? Promise.resolve(json({ ...tasks, work: [{ kind: "answer" }, { kind: "a-later-kind" }] })) : null;
  click(railLink("/tasks"));
  await arrivedAt("/tasks");
  expect(loads).toEqual([{ href: "/tasks", replace: false }]);
  expect(window.location.pathname).toBe("/");
  expect(document.querySelector("[data-home]")).not.toBeNull();
  loads = [];
  expect(acceptWorkspace({ ...tasks, work: [{ kind: "region", region: "run-peek", run: 0 }] } as BrowserWorkspace, "confirm", "/tasks")).toBe(false);
  expect(acceptWorkspace({ ...tasks, work: [{ kind: "region", region: "board-region", run: 3 }] } as unknown as BrowserWorkspace, "navigate", "/tasks")).toBe(false);
  expect(loads).toEqual([{ href: "/tasks", replace: false }, { href: "/tasks", replace: false }]);
  // The page on screen re-reading itself is shown either way (the app starts none of the unknown work).
  loads = [];
  const home = await workspaceAt("/");
  expect(acceptWorkspace({ ...home, work: [{ kind: "result" }] } as unknown as BrowserWorkspace, "refresh")).toBe(true);
  expect(loads).toEqual([]);
  // Work that is not a list of named entries fails the read itself.
  for (const work of ["answer", [null], [{ kind: 7 }], { kind: "answer" }]) {
    const read = await readPage("/tasks", "navigate", () => Promise.resolve(json({ ...tasks, work })));
    expect(read, JSON.stringify(work)).toBeNull();
  }
  expect(await readPage("/tasks", "navigate", () => Promise.resolve(json({ ...tasks, scripted: "yes" })))).toBeNull();
});

test("a page shown ahead of its own read runs no work; the confirmed page does", async () => {
  const decision = stoppedOnQuestion("q-held");
  await open("/");
  const link = document.createElement("a");
  link.href = "/t/q-held";
  link.textContent = "decide q-held";
  document.querySelector(".so-rail")!.append(link);
  rest(link);
  await waitFor(() => prefetchedKeys().includes("/t/q-held"));
  const confirming = gate();
  const posts: string[] = [];
  override = (path, init) => {
    if (init.method === "POST") { posts.push(path); return followed(path, init); }
    return path.startsWith("/t/q-held?") && purposeOf(init) === "navigate" ? confirming.wait(path, init) : null;
  };
  click(link);
  await waitFor(() => window.location.pathname === "/t/q-held");
  await settle();
  expect(pageHeld()).toBe(true);
  expect(answerForm(decision)).not.toBeNull();
  // Held: a submit there is nobody's (the page is inert, and the app has started none of its work).
  expect((await submit(answerForm(decision)!)).defaultPrevented).toBe(false);
  await settle();
  expect(posts).toEqual([]);
  confirming.open();
  await waitFor(() => !document.getElementById("workspace-main")!.hasAttribute("data-so-provisional"));
  await settle();
  expect(pageHeld()).toBe(false);
  expect(loads).toEqual([]);
  expect((await submit(answerForm(decision)!)).defaultPrevented).toBe(true);
  await waitFor(() => document.querySelector(`[data-decision-id="${decision}"] .answered`) !== null);
  expect(posts).toEqual([`/d/${decision}/answer`]);
});
