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
  expect(chat.textContent).toContain("What would you like to work on?");
  expect(chat.textContent).not.toContain("Plan the work with your lead");
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
  expect(document.querySelector(".so-phone-work-button")!.textContent).toBe("Work");
  expect(document.activeElement?.id).toBe("lead-message");
});

test("a phone never opens the keyboard by itself", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  await mount(workspace());
  expect(document.activeElement?.id).not.toBe("lead-message");
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
  expect(REPLACED_THREAD_DIVIDER).toBe("New conversation — the projects I can reach changed");
  // Order: old words, the divider, then the live thread.
  expect(old.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(divider.compareDocumentPosition(chat.querySelector("#chat-thread")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(chat.querySelector("#chat-thread")!.textContent).toContain("What can you reach now?");
  expect(chat.querySelector("#chat-thread")!.textContent).not.toContain("payments");
});

test("the phone setup is one dismissible line in Chat, pointing to Settings; the card itself is not in Chat", async () => {
  const phone = { chatApps: [{ label: "Telegram", href: "/settings/telegram" }], tailnet: null, dismissHref: "/onboarding/phone/dismiss" };
  await mount(workspace({ phone }));
  expect(document.querySelector("[data-phone-card]")).toBeNull();
  const notice = document.querySelector("[data-phone-notice]")!;
  expect(notice.querySelector("a")!.getAttribute("href")).toBe("/settings#settings-chat-apps");
  await act(async () => (notice.querySelector('button[type="submit"]') as HTMLButtonElement).click());
  expect(document.querySelector("[data-phone-notice]")).toBeNull();
  expect(fetch).toHaveBeenCalledWith("/onboarding/phone/dismiss", expect.objectContaining({ method: "POST" }));
});
