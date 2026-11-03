// @vitest-environment happy-dom
// The lead chat in the revamp look (lead-chat.tsx): message acts, code Copy, proposal rows, Stop, refusals in place,
// the "/" commands, and the empty state's pills — through the same useWorkspace send path as before.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserActionCard, BrowserMessage, BrowserWorkspace } from "../browser-workspace.js";
import { WorkspaceApp } from "./app.js";
import { pillWords, questionBefore } from "./lead-chat.js";

const message = (id: number, role: "operator" | "assistant", text: string, extra: Partial<BrowserMessage> = {}): BrowserMessage =>
  ({ id, role, text, html: `<p>${text}</p>`, cardsHtml: "", activity: null, createdAt: "2026-10-05T09:00:00.000Z", ...extra });
const card = (id: number, over: Partial<BrowserActionCard> = {}): BrowserActionCard => ({ id, kind: "task", label: "Choose the retry policy", state: "pending",
  body: "<h3>Retry policy</h3><p>Exponential backoff.</p>", said: null, links: [], primary: { kind: "confirm", label: "File task", irreversible: false, native: false }, dismissable: true, note: null, ...over });

const conversation = (over: Partial<NonNullable<BrowserWorkspace["conversation"]>> = {}): NonNullable<BrowserWorkspace["conversation"]> =>
  ({ sessionId: 7, user: "alex", version: "v1", messages: [], pendingTurnId: null, requestId: "a".repeat(32), maxChars: 2000, taskId: null, resultRunId: null, ...over });
const workspace = (over: Partial<BrowserWorkspace> = {}): BrowserWorkspace => ({
  version: 1, path: "/chat", title: "chat", user: "alex", csrf: "csrf", sensitive: false,
  refreshUrl: "/chat", receipt: null, projects: [{ name: "payments-api", path: "/repos/payments-api", href: "/projects/x", knowledgeHref: "/k" }], crewTruncated: false, crew: [],
  conversation: conversation(), focus: null, result: null, catchUpHtml: "", controlsHtml: "", notices: [], pageHtml: null,
  navigation: [{ label: "Chat", href: "/chat", active: true }], leadName: "Ada",
  ...over,
} as BrowserWorkspace);

let root: Root | null = null;
let posts: { url: string; body: URLSearchParams }[] = [];
let answer: (url: string, body: URLSearchParams) => Response = () => new Response(null, { status: 204 });
const mount = async (initial: BrowserWorkspace) => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(WorkspaceApp, { initial })));
};
const type = (value: string) => act(() => {
  const box = document.querySelector<HTMLTextAreaElement>("#lead-message")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
  box.dispatchEvent(new Event("input", { bubbles: true }));
});
const button = (name: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === name || one.getAttribute("aria-label") === name);
const settle = () => act(async () => { await new Promise(done => setTimeout(done, 20)); });

beforeEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
  posts = [];
  answer = () => new Response(null, { status: 204 });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") { const body = new URLSearchParams(String(init.body)); posts.push({ url: String(input), body }); return answer(String(input), body); }
    return new Response(null, { status: 204 });
  }));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener() {}, removeEventListener() {} }));
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

test("the desk top bar: Chat, the lead's name and the project, New chat and Lead settings as quiet acts", async () => {
  await mount(workspace({ conversation: conversation({ messages: [message(1, "operator", "Hi")] }) }));
  const bar = document.querySelector(".k-tb")!;
  expect(bar.querySelector("h1")!.textContent).toBe("Chat");
  expect(bar.querySelector(".k-tb-ctx")!.textContent).toBe("Ada");
  const end = bar.querySelector<HTMLFormElement>('form[action="/chat/mate/end"]')!;
  expect(end.querySelector('button[type="submit"]')!.className).toContain("k-btn-ghost");
  expect(bar.querySelector('a[href="/settings/lead"]')!.className).toContain("k-btn-ghost");
  expect(bar.querySelector(".k-btn-primary")).toBeNull();
});

test("a project's thread names its project in the bar and as the composer's chip; New chat stays on the main conversation", async () => {
  await mount(workspace({ conversation: conversation({ project: "/repos/payments-api", messages: [message(1, "operator", "Hi")] }) }));
  expect(document.querySelector(".k-tb-ctx")!.textContent).toBe("Ada · payments-api");
  const chip = document.querySelector(".k-composer-chip")!;
  expect(chip.firstElementChild!.textContent).toBe("payments-api");
  expect(chip.querySelector(".k-chip-sub")!.textContent).toBe("Ada");
  expect(document.querySelector('form[action="/chat/mate/end"]')).toBeNull();
});

test("the composer is one object: the chip says All projects and the lead, and Conversation settings open from the + menu", async () => {
  await mount(workspace({ controlsHtml: '<details class="lead-follow"><summary>Automatic crew updates</summary><form method="post" action="/chat/mate/follow"><button type="submit">Enable updates</button></form></details>',
    conversation: conversation({ messages: [message(1, "operator", "Hi")] }) }));
  const chip = document.querySelector(".k-composer-chip")!;
  expect(chip.firstElementChild!.textContent).toBe("All projects");
  expect(chip.querySelector(".k-chip-sub")!.textContent).toBe("Ada");
  // Nothing boxed under the composer: the settings are not on the page until the + menu opens them.
  expect(document.querySelector(".so-composer-area details")).toBeNull();
  expect(document.querySelector('form[action="/chat/mate/follow"]')).toBeNull();
  const plus = document.querySelector<HTMLButtonElement>(".k-composer-plus")!;
  await act(async () => plus.click());
  const menu = document.querySelector(".k-menu")!;
  expect([...menu.querySelectorAll("button")].map(one => one.textContent)).toEqual(["Choose project", "Conversation settings"]);
  await act(async () => button("Conversation settings", menu)!.click());
  await settle();
  const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]:not([hidden]) .lc-settings')!.closest<HTMLElement>('[role="dialog"]')!;
  expect(panel.textContent).toContain("Conversation settings");
  expect(panel.querySelector('form[action="/chat/mate/follow"]')).not.toBeNull();
  // Escape closes it and focus goes back to the + button.
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
  expect(document.querySelector(".lc-settings")).toBeNull();
  expect(document.activeElement).toBe(plus);
});

test("yours on the right with Edit; the lead's with its name, code Copy, Copy and Retry; Retry asks the same question as a new message", async () => {
  const code = message(2, "assistant", "Run it", { html: '<p>Run it:</p><pre class="chat-code"><code>toolroll tasks --needs</code></pre>' });
  await mount(workspace({ conversation: conversation({ messages: [message(1, "operator", "What needs me?"), code] }) }));
  const yours = document.querySelector('[data-message-id="1"]')!;
  expect(yours.classList.contains("lc-you")).toBe(true);
  const lead = document.querySelector('[data-message-id="2"]')!;
  expect(lead.querySelector(".lc-who")!.textContent).toContain("Ada");
  // The server's code block gets its Copy beside it.
  expect(lead.querySelector(".lc-code [data-code-copy] + pre code")!.textContent).toBe("toolroll tasks --needs");
  expect(button("Copy Ada's answer", lead)).toBeDefined();
  // Edit puts the words back in the box.
  await act(async () => button("Edit: put these words back in the message box", yours)!.click());
  expect(document.querySelector<HTMLTextAreaElement>("#lead-message")!.value).toBe("What needs me?");
  await type("");
  // Retry: the composer's one send path, the same question.
  answer = (_url, body) => new Response(JSON.stringify({ ok: true, queued: true, request: body.get("request") }), { status: 202, headers: { "content-type": "application/json" } });
  await act(async () => button("Retry: ask the same question again", lead)!.click());
  await settle();
  expect(posts.map(one => [one.url, one.body.get("message")])).toEqual([["/chat", "What needs me?"]]);
});

test("Retry never sends over words still being written: it says so in place and nothing goes", async () => {
  await mount(workspace({ conversation: conversation({ messages: [message(1, "operator", "What needs me?"), message(2, "assistant", "Two things.")] }) }));
  await type("half a thought");
  await act(async () => button("Retry: ask the same question again", document.querySelector('[data-message-id="2"]')!)!.click());
  await settle();
  expect(posts).toEqual([]);
  expect(document.querySelector('[data-message-id="2"] [role="alert"]')!.textContent).toContain("Send or clear the message you're writing first.");
  expect(document.querySelector<HTMLTextAreaElement>("#lead-message")!.value).toBe("half a thought");
});

test("what the lead proposed: slim rows with kit chips; one waiting on you opens with its acts, and its outcome shows in place", async () => {
  const cards = [card(10), card(11, { state: "confirmed", said: "filed as a task", primary: null, dismissable: false, links: [{ label: "Open task", href: "/t/abc" }] })];
  await mount(workspace({ conversation: conversation({ messages: [message(1, "operator", "Retry policy?"), message(2, "assistant", "Filed it.", { cards })] }) }));
  const waiting = document.querySelector('[data-action-card="10"]')!;
  expect(waiting.querySelector(".k-chip.needs")!.textContent).toBe("Needs you");
  expect(waiting.querySelector(".lc-card-body")!.textContent).toContain("Exponential backoff.");
  const done = document.querySelector('[data-action-card="11"]')!;
  expect(done.querySelector(".k-chip.done")!.textContent).toBe("Done");
  // A row that only points somewhere is the link.
  expect(done.querySelector("a.lc-card-row")!.getAttribute("href")).toBe("/t/abc");
  answer = () => new Response(JSON.stringify({ ok: false, said: "your approver standing changed" }), { status: 403, headers: { "content-type": "application/json" } });
  await act(async () => waiting.querySelector<HTMLButtonElement>("[data-card-confirm]")!.click());
  await settle();
  expect(posts.at(-1)!.url).toBe("/chat/proposal/10/confirm");
  expect(document.querySelector('[data-action-card="10"] [role="alert"]')!.textContent).toBe("Your approver standing changed Nothing changed.");
  expect(document.querySelector("[data-sonner-toast]")).toBeNull();
});

test("while the lead answers: Thinking…, Stop posts the conversation's own stop door, and words typed meanwhile queue", async () => {
  await mount(workspace({ conversation: conversation({ pendingTurnId: 42, messages: [message(1, "operator", "What is blocking settlement?")] }) }));
  expect(document.querySelector("[data-live-reply] .lc-thinking")!.textContent).toBe("Thinking…");
  const box = document.querySelector(".k-composer")!;
  expect(box.classList.contains("working")).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>(".k-stop")!.click());
  await settle();
  expect(posts.map(one => [one.url, one.body.get("turn"), one.body.get("csrf")])).toEqual([["/chat/mate/stop", "42", "csrf"]]);
  await type("And the refunds?");
  expect(box.classList.contains("working")).toBe(false);
  expect(document.querySelector('[data-workspace-composer] button[type="submit"]')!.getAttribute("aria-label")).toBe("Queue message");
});

test("a refused send keeps the words and says why under the box", async () => {
  answer = () => new Response(JSON.stringify({ ok: false, said: "Chat is paused until the spend is confirmed." }), { status: 409, headers: { "content-type": "application/json" } });
  await mount(workspace());
  await type("Ship it");
  await act(async () => { document.querySelector<HTMLFormElement>("form[data-workspace-composer]")!.requestSubmit(); });
  await settle();
  expect(document.querySelector<HTMLTextAreaElement>("#lead-message")!.value).toBe("Ship it");
  expect(document.querySelector(".k-composer-err")!.textContent).toBe("Chat is paused until the spend is confirmed.");
  expect(document.querySelector("#lead-message")!.getAttribute("aria-invalid")).toBe("true");
});

test("the / commands still open, move and apply from the keyboard", async () => {
  await mount(workspace());
  await type("/st");
  const list = document.querySelector('[role="listbox"]')!;
  expect([...list.querySelectorAll('[role="option"]')].map(one => one.textContent)).toEqual(["/statusWhat needs you right now"]);
  const box = document.querySelector<HTMLTextAreaElement>("#lead-message")!;
  expect(box.getAttribute("role")).toBe("combobox");
  await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(box.value).toBe("What needs my attention right now?");
  expect(posts).toEqual([]);
});

test("empty: one sentence and suggestion pills that only draft words; the kits stay one click away", async () => {
  await mount(workspace());
  const empty = document.querySelector("[data-chat-empty]")!;
  expect(empty.querySelector("h2")!.textContent).toBe("What should we work on?");
  expect(empty.querySelectorAll("p")).toHaveLength(1);
  await act(async () => button("File a task…", empty)!.click());
  expect(document.querySelector<HTMLTextAreaElement>("#lead-message")!.value).toBe("File a task: ");
  expect(posts).toEqual([]);
  expect([...empty.querySelectorAll("[data-kit-links] a")].map(one => one.getAttribute("href"))).toContain("/kits/bug-triage");
});

test("helpers: the question a reply answers, and a pill's words", () => {
  const thread = [message(1, "operator", "First"), message(2, "assistant", "One"), message(3, "assistant", "Two")];
  expect(questionBefore(thread, 2)).toBe("First");
  expect(questionBefore(thread, 0)).toBeNull();
  expect(pillWords("File a task: ")).toBe("File a task…");
  expect(pillWords("Make a flow for ")).toBe("Make a flow for…");
  expect(pillWords("What needs me?")).toBe("What needs me?");
});

test("the composer's ring is for keyboard focus only: Tab marks it, a pointer clears it", async () => {
  await mount(workspace());
  const root = document.documentElement;
  expect(root.classList.contains("k-js")).toBe(true);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
  expect(root.classList.contains("k-kbd")).toBe(true);
  await act(async () => document.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(root.classList.contains("k-kbd")).toBe(false);
  // Typing in the box never turns the ring on.
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
  expect(root.classList.contains("k-kbd")).toBe(false);
});
