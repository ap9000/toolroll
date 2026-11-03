// @vitest-environment happy-dom
/** Home (UI revamp wave B): the sentence and the counts agree, rows group by what they ask, the selected row opens
 * beside the list, and an agent's question is answered in place through its own one-click route. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserHomeRow, BrowserHomeView } from "../browser-workspace.js";
import { HomeView } from "./views/home-view.js";
import { FormToken } from "./ui/index.js";
import { homeSentence } from "../server/home.js";
import { DESTINATIONS, LEGACY, searchResults } from "./search.js";

const row = (id: string, extra: Partial<BrowserHomeRow> = {}): BrowserHomeRow => ({
  id, title: `Task ${id}`, href: `/t/${id}`, project: "shop", age: "4h ago", chip: { word: "Plan", tone: "ask" }, line: "Review the plan and approve it to start.",
  action: { label: "Approve plan", href: `/t/${id}#approve` }, question: null, ...extra });
const view = (over: Partial<BrowserHomeView> = {}): BrowserHomeView => ({
  kind: "home", say: "3 need you across 2 projects.", project: null, scopes: null,
  counts: [
    { key: "needs", label: "Needs you", value: 3, href: "/work?view=needs-you" }, { key: "running", label: "Running", value: 1, href: "/work?view=running" },
    { key: "queued", label: "Queued", value: 0, href: "/work?view=queued" }, { key: "finished", label: "Finished", value: 2, href: "/work?view=completed" }],
  groups: [
    { key: "decide", label: "Decide", rows: [row("a"), row("q", { chip: { word: "Question", tone: "ask" }, question: { id: 7, text: "How should retries back off?", recap: "They hammer endpoints.", options: [
      { id: "exp", label: "Exponential", consequence: "Slow to give up.", recommended: true }, { id: "fixed", label: "Fixed", consequence: "Gives up fast.", recommended: false }] } })] },
    { key: "running", label: "Running", rows: [row("r", { chip: { word: "Building", tone: "live" }, line: "Step 2 of 4", action: null })] },
  ],
  more: null, newTask: "/tasks/new", ask: { project: null, placeholder: "Ask the lead about your projects…" }, empty: null, ...over });

let root: Root | null = null;
const mount = async (v: BrowserHomeView) => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(FormToken.Provider, { value: "csrf-1" }, createElement(HomeView, { view: v }))));
};
beforeEach(() => {
  document.body.innerHTML = "";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
});
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; vi.unstubAllGlobals(); });

test("the sentence reads the same totals as the figures", () => {
  expect(homeSentence(7, [{ name: "api", needs: 5 }, { name: "web", needs: 2 }], null, true)).toBe("7 need you across 2 projects.");
  expect(homeSentence(1, [{ name: "api", needs: 1 }, { name: "web", needs: 0 }], null, true)).toBe("1 needs you in api.");
  expect(homeSentence(0, [], null, true)).toBe("Nothing needs you.");
  expect(homeSentence(0, [], "api", true)).toBe("Nothing needs you in api.");
  expect(homeSentence(0, [], null, false)).toBe("No tasks yet.");
});

test("four counts link to the Tasks filters; rows group by what they ask; the first that waits is open beside the list", async () => {
  await mount(view());
  expect([...document.querySelectorAll("[data-home-count]")].map(one => [one.getAttribute("data-home-count"), one.getAttribute("href"), one.querySelector(".so-count-v")?.textContent]))
    .toEqual([["needs", "/work?view=needs-you", "3"], ["running", "/work?view=running", "1"], ["queued", "/work?view=queued", "0"], ["finished", "/work?view=completed", "2"]]);
  expect([...document.querySelectorAll(".so-tri-g")].map(one => one.textContent)).toEqual(["Decide", "Running"]);
  expect(document.querySelector('[aria-selected="true"]')?.getAttribute("data-row")).toBe("a");
  expect(document.querySelector(".so-tri-open")?.textContent).toContain("Approve plan");
  // The lead's box posts to /chat as a native form, with the session's token.
  const ask = document.querySelector<HTMLFormElement>("form.so-home-ask")!;
  expect(ask.getAttribute("action")).toBe("/chat");
  expect(ask.querySelector<HTMLInputElement>('input[name="csrf"]')!.value).toBe("csrf-1");
});

test("an agent's question is answered in place: one click, the recommended option chosen, the outcome said where it happened", async () => {
  const posts: { url: string; body: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { posts.push({ url, body: String(init.body) }); return new Response("", { status: 200 }); }));
  await mount(view());
  const question = document.querySelector<HTMLAnchorElement>('[data-row="q"]')!;
  await act(async () => question.click());
  const pane = document.querySelector(".so-tri-open")!;
  expect(pane.textContent).toContain("How should retries back off?");
  expect(pane.querySelector<HTMLInputElement>('input[value="exp"]')!.checked).toBe(true);
  expect(pane.textContent).toContain("Recommended");
  const answer = [...pane.querySelectorAll("button")].find(one => one.textContent === "Answer")!;
  await act(async () => { answer.click(); });
  await act(async () => { await new Promise(done => setTimeout(done, 0)); });
  expect(posts).toEqual([{ url: "/d/7/answer", body: "csrf=csrf-1&choice=exp" }]);
  expect(pane.textContent).toContain("Answered");
});

test("a refused answer stays in place and says nothing changed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('<main><div class="problem">already answered — somebody got there first</div></main>', { status: 409 })));
  await mount(view());
  await act(async () => document.querySelector<HTMLAnchorElement>('[data-row="q"]')!.click());
  const pane = document.querySelector(".so-tri-open")!;
  await act(async () => { [...pane.querySelectorAll("button")].find(one => one.textContent === "Answer")!.click(); });
  await act(async () => { await new Promise(done => setTimeout(done, 0)); });
  expect(pane.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t answer: already answered — somebody got there first. Nothing changed.");
});

test("search finds a setting by any of its words and an old name says where it lives now", () => {
  const workspace = { crew: [], projects: [], chats: [], navigation: [{ label: "Home", href: "/", active: true }] } as never;
  expect(searchResults(workspace, "backup").filter(one => one.kind !== "action").map(one => one.title)).toEqual(["Backups"]);
  expect(searchResults(workspace, "opus").map(one => one.title)).toContain("Models");
  const recipes = searchResults(workspace, "recipes").find(one => one.title === "Recipes")!;
  expect(recipes.sub).toBe("Now Flows → New flow");
  // Every destination is an address inside the console.
  for (const [, href] of [...DESTINATIONS, ...LEGACY]) expect(href.startsWith("/") && !href.startsWith("//")).toBe(true);
  // Ask the lead never sends from a link: it only starts a draft.
  expect(searchResults(workspace, "why is it slow").find(one => one.title === "Ask the lead")!.href).toBe("/chat?draft=why%20is%20it%20slow");
});

test("search with nothing found in a truncated read says so and offers every task", async () => {
  const { SearchView } = await import("./views/search-view.js");
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const workspace = { crew: [], projects: [], chats: [], navigation: [] } as never;
  await act(async () => root!.render(createElement(SearchView, { view: { kind: "search", q: "zzqq", tasks: [], truncated: true }, workspace })));
  expect(host.textContent).toContain("so an older task may not show");
  expect(host.querySelector('a[href="/work?view=all"]')?.textContent).toBe("Open every task in Tasks");
});
