// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserHome, BrowserMessage, BrowserWorkspace } from "../browser-workspace.js";
import { REPLACED_THREAD_DIVIDER, WorkspaceApp } from "./app.js";

const home: BrowserHome = {
  agents: [{ runId: 3, taskId: "t-1", title: "Fix the login button", phase: "Building", agent: "Claude", since: "2026-10-05T10:00:00.000Z", href: "/t/t-1" }],
  counts: [
    { key: "working", label: "Working now", value: 1, href: "/work?view=running" },
    { key: "waiting", label: "Waiting on you", value: 0, href: "/work?view=needs-you" },
    { key: "ready", label: "Ready to review", value: 0, href: "/work?view=needs-you" },
    { key: "done", label: "Done this week", value: 2, href: "/work?view=completed" },
  ],
  planUse: [], catchUp: [], allHref: "/work",
} as unknown as BrowserHome;

const message = (id: number, role: "operator" | "assistant", text: string, extra: Partial<BrowserMessage> = {}): BrowserMessage =>
  ({ id, role, text, html: `<p>${text}</p>`, cardsHtml: "", activity: null, createdAt: "2026-10-05T09:00:00.000Z", ...extra });

const workspace = (over: Partial<BrowserWorkspace> = {}): BrowserWorkspace => ({
  version: 1, path: "/chat", title: "chat", user: "alex", csrf: "csrf", sensitive: false,
  refreshUrl: "/chat", receipt: null, projects: [], crewTruncated: false,
  crew: [{ id: "t-1", title: "Fix the login button", state: "running", label: "Building", tone: "working", href: "/t/t-1", resultHref: null, project: null, action: null, updatedAt: "2026-10-05T10:00:00.000Z", detail: null }],
  conversation: { sessionId: 7, user: "alex", version: "v1", messages: [], pendingTurnId: null, requestId: "a".repeat(32), maxChars: 2000, taskId: null, resultRunId: null },
  focus: null, result: null, catchUpHtml: "<p data-brief>brief</p>", controlsHtml: "", notices: [], pageHtml: null,
  navigation: [{ label: "Chat", href: "/chat", active: true }],
  home,
  ...over,
} as BrowserWorkspace);

let root: Root | null = null;
const mount = async (initial: BrowserWorkspace) => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(WorkspaceApp, { initial })));
};

beforeEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // No refresh in these tests: the view is what the server sent.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener() {}, removeEventListener() {} }));
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

test("the Chat landing is the conversation: Home and the Crew live in the Work panel, a short empty state, and a desk opens ready to type", async () => {
  await mount(workspace());
  const chat = document.querySelector("[data-workspace-chat]")!;
  expect(chat.querySelector("[data-home]")).toBeNull();
  expect(chat.querySelector("[data-brief]")).toBeNull();
  const work = document.querySelector("[data-workspace-detail]")!;
  expect(work.querySelector("[data-home]")).not.toBeNull();
  // Every link Home had is still there.
  expect([...work.querySelectorAll("[data-home] a")].map(one => one.getAttribute("href"))).toEqual(expect.arrayContaining(["/t/t-1", "/work?view=running", "/work?view=needs-you", "/work?view=completed", "/work"]));
  // The Crew is one tab away (a phone's Work sheet too).
  const crewTab = [...work.querySelectorAll('[role="tab"]')].find(one => one.textContent === "Crew") as HTMLButtonElement;
  expect(work.querySelector("[data-workspace-crew]")!.closest("[hidden]")).not.toBeNull();
  await act(async () => crewTab.click());
  expect(work.querySelector("[data-workspace-crew]")!.closest("[hidden]")).toBeNull();
  expect(work.querySelector('[data-workspace-task="t-1"] a')!.getAttribute("href")).toBe("/t/t-1");
  expect(document.activeElement?.id).toBe("lead-message");
});

test("a replaced thread stays readable above the divider; its cards have no buttons and only the new thread continues", async () => {
  const card = { id: 4, kind: "task", label: "File a task", state: "expired" as const, body: "<p>Fix login</p>", said: null, links: [], primary: null, dismissable: false, note: null };
  await mount(workspace({ conversation: {
    sessionId: 7, user: "alex", version: "v1", messages: [message(9, "operator", "What can you reach now?")], pendingTurnId: null, requestId: "a".repeat(32), maxChars: 2000, taskId: null, resultRunId: null,
    previous: { messages: [message(1, "operator", "Remember the payments route"), message(2, "assistant", "Through payments.", { cards: [card] })] },
  } }));
  const chat = document.querySelector("[data-workspace-chat]")!;
  const old = chat.querySelector("[data-previous-thread]")!;
  expect(old.textContent).toContain("Remember the payments route");
  expect(old.querySelectorAll("button, form")).toHaveLength(0);
  const divider = chat.querySelector("[data-thread-divider]")!;
  expect(divider.textContent).toBe(REPLACED_THREAD_DIVIDER);
  // Order: old words, the divider, then the live thread.
  expect(old.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(divider.compareDocumentPosition(chat.querySelector("#chat-thread")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(chat.querySelector("#chat-thread")!.textContent).toContain("What can you reach now?");
  expect(chat.querySelector("#chat-thread")!.textContent).not.toContain("payments");
});

test("quiet page visits: a page shown before its conversation existed adopts the one its own send started, and the next draft survives a reload there", async () => {
  const started = (over: Partial<BrowserWorkspace> = {}) => workspace({ conversation: { ...workspace().conversation!, sessionId: 9 }, ...over });
  let readAs: (request: string | null) => BrowserWorkspace = () => started();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = new URLSearchParams(String(init.body));
      expect(body.get("request-session")).toBe("0");
      return new Response(JSON.stringify({ ok: true, session: 9, task: "", request: body.get("request") }), { status: 202, headers: { "content-type": "application/json" } });
    }
    const asked = new URL(String(input), "http://x").searchParams.get("request");
    return new Response(JSON.stringify(readAs(asked)), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  readAs = asked => started({ receipt: asked ? { request: asked, received: true } : null });
  await mount(workspace({ conversation: { ...workspace().conversation!, sessionId: 0 } }));
  const type = (value: string) => act(() => {
    const box = document.querySelector<HTMLTextAreaElement>("#lead-message")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await type("Start the release notes");
  await act(async () => { document.querySelector<HTMLFormElement>("form[data-workspace-composer]")!.requestSubmit(); });
  await act(async () => { await new Promise(done => setTimeout(done, 20)); });
  // Adopted: no reconnect prompt, and the next draft is kept under the started conversation (session 9).
  expect(document.body.textContent).not.toContain("This conversation changed or ended");
  await type("And the changelog");
  const keys = Object.keys(sessionStorage).filter(one => one.startsWith("standing-orders:workspace-draft:"));
  expect(keys.some(key => JSON.parse(sessionStorage.getItem(key)!).session === 9 && sessionStorage.getItem(key)!.includes("And the changelog"))).toBe(true);
  // Nothing stays behind under session 0: a reload of a page with no conversation never resurrects the sent message.
  expect(keys.filter(key => JSON.parse(sessionStorage.getItem(key)!).session === 0)).toEqual([]);
});

test("quiet page visits: a refresh begun before the first send, landing while it is on its way, does not disconnect the page", async () => {
  let acknowledge!: () => void, release!: () => void, posted = false;
  const started = workspace({ conversation: { ...workspace().conversation!, sessionId: 9 } });
  const unstarted = workspace({ conversation: { ...workspace().conversation!, sessionId: 0 } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted = true;
      const request = new URLSearchParams(String(init.body)).get("request");
      await new Promise<void>(done => { acknowledge = done; });
      return new Response(JSON.stringify({ ok: true, session: 9, task: "", request }), { status: 202, headers: { "content-type": "application/json" } });
    }
    const asked = new URL(String(input), "http://x").searchParams.get("request");
    // The first read is held until after the send went out; it then shows the started conversation with no receipt.
    if (!posted) await new Promise<void>(done => { release = done; });
    return new Response(JSON.stringify(posted ? { ...started, receipt: asked ? { request: asked, received: true } : null } : unstarted), { status: 200, headers: { "content-type": "application/json" } });
  }));
  await mount(unstarted);
  await act(async () => { window.dispatchEvent(new Event("online")); await new Promise(done => setTimeout(done, 5)); });
  await act(() => {
    const box = document.querySelector<HTMLTextAreaElement>("#lead-message")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Start it");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { document.querySelector<HTMLFormElement>("form[data-workspace-composer]")!.requestSubmit(); await new Promise(done => setTimeout(done, 5)); });
  posted = true;
  const reconnecting = () => [...document.querySelectorAll("button")].some(one => one.textContent === "Reconnect");
  await act(async () => { release(); await new Promise(done => setTimeout(done, 20)); });
  expect(reconnecting()).toBe(false);
  await act(async () => { acknowledge(); await new Promise(done => setTimeout(done, 40)); });
  expect(reconnecting()).toBe(false);
  expect(document.body.textContent).not.toContain("Delivery is not confirmed");
});

test("quiet page visits: a conversation another tab started is not adopted without this page's own acknowledgement or receipt", async () => {
  // The send's answer never arrives (lost acknowledgement); the read finds a conversation holding no receipt of it.
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
    ? Promise.reject(new Error("lost"))
    : new Response(JSON.stringify(workspace({ conversation: { ...workspace().conversation!, sessionId: 12 }, receipt: null })), { status: 200, headers: { "content-type": "application/json" } })));
  await mount(workspace({ conversation: { ...workspace().conversation!, sessionId: 0 } }));
  await act(() => {
    const box = document.querySelector<HTMLTextAreaElement>("#lead-message")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Start it");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { document.querySelector<HTMLFormElement>("form[data-workspace-composer]")!.requestSubmit(); });
  await act(async () => { await new Promise(done => setTimeout(done, 20)); });
  expect(document.body.textContent).toContain("This conversation changed or ended");
});
