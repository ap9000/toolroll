// @vitest-environment happy-dom
/** Home (docs/plans/live-pages-and-home.md B1): the heading said once, what needs you grouped by what is asked with
 * exact counts, the selected row open beside the list, an agent's question answered in place through its own one-click
 * route; with nothing waiting, what runs and what finished today; on a phone the next one as a card and the message box
 * at the bottom. The menu puts Chat under Home. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { browserNavigationOf, type BrowserHomeRow, type BrowserHomeView } from "../browser-workspace.js";
import { HomeView } from "./views/home-view.js";
import { FormToken } from "./ui/index.js";
import { homeSentence } from "../server/home.js";
import { DESTINATIONS, LEGACY, searchResults } from "./search.js";

const row = (id: string, extra: Partial<BrowserHomeRow> = {}): BrowserHomeRow => ({
  id, title: `Task ${id}`, href: `/t/${id}`, project: "shop", age: "4h ago", state: "needs", ask: "approve", reason: null, line: "Review the plan and approve it to start.",
  action: { label: "Approve plan", href: `/t/${id}#approve` }, question: null, ...extra });
const view = (over: Partial<BrowserHomeView> = {}): BrowserHomeView => ({
  kind: "home", say: "19 tasks need you", project: null, scopes: null,
  counts: [
    { key: "needs", label: "Needs you", value: 19, href: "/tasks?scope=all&view=needs-you" }, { key: "running", label: "Running", value: 1, href: "/tasks?scope=all&view=running" },
    { key: "queued", label: "Queued", value: 1, href: "/tasks?scope=all&view=queued" }, { key: "finished", label: "Finished", value: 2, href: "/tasks?scope=all&view=completed" }],
  groups: [
    { key: "approve", label: "Approve a plan", count: 1, rows: [row("a")] },
    { key: "answer", label: "Answer a question", count: 1, rows: [row("q", { ask: "answer", line: "How should retries back off?", action: null, question: { id: 7, text: "How should retries back off?", recap: "They hammer endpoints.", options: [
      { id: "exp", label: "Exponential", consequence: "Slow to give up.", recommended: true }, { id: "fixed", label: "Fixed", consequence: "Gives up fast.", recommended: false }] } })] },
    { key: "wrong", label: "Something went wrong", count: 1, rows: [row("f", { ask: "wrong", reason: "Build failed", line: "Build failed.", action: { label: "Review and retry", href: "/t/f" } })] },
    { key: "review", label: "Review results", count: 16, rows: [row("r", { ask: "review", action: { label: "Open result", href: "/review?result=r&run=3" } })] },
  ],
  working: [row("w", { state: "running", ask: null, line: "Building", action: null })],
  finishedToday: { count: 0, rows: [], href: "/tasks?scope=all&view=completed" },
  newTask: "/tasks/new", ask: { project: null, placeholder: "Ask Toolroll" },
  lastLead: { text: "The pagination build is on step 2 of 3.", age: "4m ago", href: "/chat" }, empty: null, ...over });

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

test("the heading reads the one total", () => {
  expect(homeSentence(19, true)).toBe("19 tasks need you");
  expect(homeSentence(1, true)).toBe("1 task needs you");
  expect(homeSentence(0, true)).toBe("Nothing needs you");
  expect(homeSentence(0, false)).toBe("No tasks yet");
  // What isn't a task is named apart; the task count stays the rail's.
  expect(homeSentence(3, true, 2)).toBe("3 tasks and 2 other things need you");
  expect(homeSentence(1, true, 1)).toBe("1 task and 1 other thing need you");
  expect(homeSentence(0, true, 2)).toBe("2 things need you");
  expect(homeSentence(0, false, 1)).toBe("1 thing needs you");
});

test("a release, a flow card and a setup step: their own groups, ids that never meet a task's, and one link to their own page", async () => {
  const own = (id: string, ask: "release" | "flow" | "setup", label: string, href: string) => row(id, { ask, href, line: `${label} line`, action: { label, href } });
  await mount(view({ say: "1 task and 2 other things need you", groups: [
    { key: "release", label: "Approve a release", count: 1, rows: [own("rel", "release", "Review the release", "/t/rel/release")] },
    { key: "approve", label: "Approve a plan", count: 1, rows: [row("a")] },
    { key: "flow", label: "Flow decisions", count: 1, rows: [own("flow:12", "flow", "Open the card", "/flows/3?card=12")] },
    { key: "setup", label: "Finish setting up", count: 1, rows: [own("setup:builder", "setup", "Start a builder", "/start-builder")] },
  ] }));
  expect([...document.querySelectorAll("[data-group]")].map(one => one.getAttribute("data-group"))).toEqual(["release", "approve", "flow", "setup"]);
  expect([...document.querySelectorAll(".so-tri-list [data-row]")].map(one => one.getAttribute("data-row"))).toEqual(["rel", "a", "flow:12", "setup:builder"]);
  // The release is first and open: its line and the one link to its sheet; never the plan approval.
  const pane = document.querySelector(".so-tri-open")!;
  const links = () => [...pane.querySelectorAll("a")].map(one => [one.textContent, one.getAttribute("href")]);
  expect(pane.querySelector("[data-home-approval]")).toBeNull();
  expect(pane.textContent).toContain("Review the release line");
  expect(links()).toEqual([["Review the release", "/t/rel/release"]]);
  const list = document.querySelector<HTMLElement>(".so-tri-list")!;
  const down = async () => act(async () => { list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  await down(); await down();
  expect(links()).toEqual([["Open the card", "/flows/3?card=12"]]);
  await down();
  expect(links()).toEqual([["Start a builder", "/start-builder"]]);
});

test("what needs you is grouped by what is asked, each heading with its exact count; rows wear no chip; the first is open beside the list", async () => {
  await mount(view());
  expect(document.querySelector("[data-home-say]")?.textContent).toBe("19 tasks need you");
  expect(document.querySelector("[data-home-activity]")?.textContent).toBe("1 running now·1 queued·See all tasks");
  expect([...document.querySelectorAll("[data-group]")].map(one => [one.getAttribute("data-group"), one.querySelector(".so-tri-g span")?.textContent, one.querySelector("[data-group-count]")?.textContent]))
    .toEqual([["approve", "Approve a plan", "1"], ["answer", "Answer a question", "1"], ["wrong", "Something went wrong", "1"], ["review", "Review results", "16"]]);
  // A group with more than it lists says how many more, and opens them in Tasks.
  expect(document.querySelector('[data-group="review"] .so-tri-more')?.textContent).toBe("15 more in Tasks");
  expect(document.querySelector('[data-group="review"] .so-tri-more')?.getAttribute("href")).toBe("/tasks?scope=all&view=needs-you");
  // A row is title, then project and age; only the failed row says why. No chip in the list.
  expect(document.querySelector(".so-tri-list .k-chip")).toBeNull();
  expect([...document.querySelectorAll(".so-ti-why")].map(one => one.closest("[data-row]")?.getAttribute("data-row"))).toEqual(["f"]);
  expect(document.querySelector('[data-row="a"] .so-ti-m')?.textContent).toBe("shop · 4h ago");
  // The first row is selected and open beside the list with its one ink act.
  expect(document.querySelector('[aria-selected="true"]')?.getAttribute("data-row")).toBe("a");
  const pane = document.querySelector(".so-tri-open")!;
  expect(pane.querySelector(".k-chip.needs")?.textContent).toBe("Needs you");
  expect(pane.textContent).toContain("Approve a plan");
  // A plan waiting for approval is read beside the list (home-approval.test.ts): nothing to press until it is read.
  expect(pane.querySelector("[data-home-approval]")?.getAttribute("data-home-approval")).toBe("reading");
  expect(pane.querySelector("[data-home-approve]")).toBeNull();
  // The lead's last message, one line that opens the chat, above the filled message box that posts to /chat.
  const lead = document.querySelector<HTMLAnchorElement>("[data-home-lead]")!;
  expect(lead.getAttribute("href")).toBe("/chat");
  expect(lead.textContent).toBe("ChatThe pagination build is on step 2 of 3.4m agoOpen chat");
  const ask = document.querySelector<HTMLFormElement>("form.so-home-ask")!;
  expect(ask.getAttribute("action")).toBe("/chat");
  expect(ask.querySelector<HTMLInputElement>('input[name="csrf"]')!.value).toBe("csrf-1");
  expect(ask.querySelector("textarea")?.getAttribute("placeholder")).toBe("Ask Toolroll");
});

test("arrow keys move the selection through every group, and the pane follows", async () => {
  await mount(view());
  const list = document.querySelector<HTMLElement>(".so-tri-list")!;
  const press = async (key: string) => act(async () => { list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
  await press("ArrowDown"); await press("ArrowDown");
  expect(document.querySelector('[aria-selected="true"]')?.getAttribute("data-row")).toBe("f");
  expect(document.querySelector(".so-tri-open .k-btn-primary")?.textContent).toBe("Review and retry");
  await press("ArrowUp");
  expect(document.querySelector('[aria-selected="true"]')?.getAttribute("data-row")).toBe("q");
  // A click selects at a desk instead of leaving the page.
  await act(async () => document.querySelector<HTMLAnchorElement>('[data-row="r"]')!.click());
  expect(document.querySelector('[aria-selected="true"]')?.getAttribute("data-row")).toBe("r");
});

test("on a phone the next one is a card with its one action, the list keeps every group, and the message box and New task sit at the bottom", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  await mount(view());
  const next = document.querySelector("[data-home-next]")!;
  expect(next.querySelector(".k-chip.needs")?.textContent).toBe("Needs you");
  expect(next.textContent).toContain("Approve a plan · shop · 4h ago");
  expect(next.querySelector(".k-btn-primary")?.getAttribute("href")).toBe("/t/a#approve");
  // The card's row is marked so the list doesn't repeat it there; every row is a link to its task.
  expect(document.querySelector('[data-row="a"]')?.classList.contains("so-ti-next")).toBe(true);
  expect([...document.querySelectorAll(".so-tri-list [data-row]")].map(one => one.getAttribute("href"))).toEqual(["/t/a", "/t/q", "/t/f", "/t/r"]);
  const bar = document.querySelector("[data-home-bar]")!;
  expect(bar.querySelector("[data-home-lead]")).not.toBeNull();
  expect(bar.querySelector("form.so-home-ask")).not.toBeNull();
  expect(bar.querySelector('a.so-home-plus[aria-label="New task"]')?.getAttribute("href")).toBe("/tasks/new");
  // The bar replaces the dock's New task.
  expect(document.querySelector(".k-dock")).toBeNull();
});

test("with nothing waiting: what runs, what finished today with its count, and the message box", async () => {
  await mount(view({ say: "Nothing needs you", groups: [], counts: view().counts.map(one => one.key === "needs" ? { ...one, value: 0 } : one),
    working: [row("w", { state: "running", ask: null, line: "Building", project: "shop", age: "4m ago", action: null }), row("k", { state: "queued", ask: null, line: "Queued", action: null })],
    finishedToday: { count: 12, rows: [row("d", { state: "done", ask: null, line: "Completed by alex.", action: null })], href: "/tasks?scope=all&view=completed" } }));
  expect(document.querySelector("[data-home-say]")?.textContent).toBe("Nothing needs you");
  expect(document.querySelector(".so-tri-list")).toBeNull();
  expect(document.querySelector('[aria-label="Running"]')?.querySelectorAll("[data-row]").length).toBe(2);
  expect(document.querySelector('[data-row="w"] .so-mark.live')).not.toBeNull();
  expect(document.querySelector('[data-row="k"] .so-mark.queued')).not.toBeNull();
  expect(document.querySelector('[data-row="w"] .so-wrow-m')?.textContent).toBe("Building · shop");
  const done = document.querySelector('[aria-label="Done today"]')!;
  expect(done.querySelector(".so-sec-h")?.textContent).toBe("Done today 12");
  expect(done.querySelector('[data-row="d"] .so-wrow-check')).not.toBeNull();
  expect(done.querySelector("a.k-link")?.getAttribute("href")).toBe("/tasks?scope=all&view=completed");
  expect(document.querySelector(".so-clear-ask form.so-home-ask")).not.toBeNull();
  expect(document.querySelector(".so-clear-ask [data-home-lead]")).not.toBeNull();
});

test("the project filter is one select whose choices open that project's Home", async () => {
  const assign = vi.fn();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
  await mount(view({ scopes: [{ key: "", label: "All projects", href: "/", active: true }, { key: "/p/shop", label: "shop", href: "/?project=%2Fp%2Fshop", active: false }] }));
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Project"]')!;
  expect([...select.options].map(one => [one.value, one.textContent])).toEqual([["/", "All projects"], ["/?project=%2Fp%2Fshop", "shop"]]);
  expect(document.querySelector(".k-seg")).toBeNull();
  await act(async () => { select.value = "/?project=%2Fp%2Fshop"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(assign).toHaveBeenCalledWith("/?project=%2Fp%2Fshop");
});

test("no lead line when there is no message to show; no message box when chat isn't allowed, and New task stays on the dock", async () => {
  await mount(view({ lastLead: null }));
  expect(document.querySelector("[data-home-lead]")).toBeNull();
  expect(document.querySelector("form.so-home-ask")).not.toBeNull();
  await act(async () => root!.unmount()); root = null; document.body.innerHTML = "";
  await mount(view({ ask: null, lastLead: null }));
  expect(document.querySelector("form.so-home-ask")).toBeNull();
  expect(document.querySelector(".k-dock")?.textContent).toContain("New task");
});

// The yellow word itself is guarded everywhere by the design folder's own test; here, the tokens Home must not reach for.
test("Home's stylesheet names no warning or attention colour and no hand-written colour: tokens only", () => {
  const css = readFileSync(join(process.cwd(), "src/browser/views/home.css"), "utf8");
  expect(css).not.toMatch(/--so-warning|--so-attention|#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});

test("the menu puts Chat under Home: Chat is the current item on /chat, Home is not", () => {
  const at = (path: string) => browserNavigationOf(path).map(one => [one.label, one.active]);
  expect(at("/chat").slice(0, 2)).toEqual([["Home", false], ["Chat", true]]);
  expect(at("/chat?project=%2Fp").slice(0, 2)).toEqual([["Home", false], ["Chat", true]]);
  expect(at("/").slice(0, 2)).toEqual([["Home", true], ["Chat", false]]);
  expect(at("/d/7").slice(0, 2)).toEqual([["Home", true], ["Chat", false]]);
  expect(browserNavigationOf("/").map(one => one.label)).toEqual(["Home", "Chat", "Tasks", "Flows", "Agents", "Projects", "Settings"]);
  // The one Needs-you count stays on Home.
  expect(browserNavigationOf("/", null, 3)[1]).not.toHaveProperty("count");
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
  // Ask in Chat never sends from a link: it only starts a draft.
  expect(searchResults(workspace, "why is it slow").find(one => one.title === "Ask in Chat")!.href).toBe("/chat?draft=why%20is%20it%20slow");
});

test("search with nothing found in a truncated read says so and offers every task", async () => {
  const { SearchView } = await import("./views/search-view.js");
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const workspace = { crew: [], projects: [], chats: [], navigation: [] } as never;
  await act(async () => root!.render(createElement(SearchView, { view: { kind: "search", q: "zzqq", tasks: [], truncated: true }, workspace })));
  expect(host.textContent).toContain("so an older task may not show");
  expect(host.querySelector('a[href="/tasks?view=all"]')?.textContent).toBe("Open every task in Tasks");
});

test("the one Needs-you count moves when work does: read again from its list, the rail, the dock and its sheet agree", async () => {
  const { Rail, NeedsDock, refreshNeeds } = await import("./shell.js");
  const href = "/tasks?scope=all&view=needs-you";
  const workspace = { version: 1, path: "/search", title: "Search", user: "alex", csrf: "c", sensitive: false, refreshUrl: "/search", receipt: null, projects: [], crew: [], crewTruncated: false,
    conversation: null, focus: null, result: null, catchUpHtml: "", controlsHtml: "", notices: [], pageHtml: "", navigation: [{ label: "Home", href: "/", active: false, count: 3 }],
    needsYou: { count: 3, saturated: false, scope: null, label: "3 need you across all your projects", href } } as unknown as import("../browser-workspace.js").BrowserWorkspace;
  const rows = Array.from({ length: 4 }, (_, n) => ({ id: `t${n}`, title: `Task ${n}`, href: `/t/t${n}`, project: null, age: "1h ago", chip: "Plan", group: "decide", status: { label: "Needs you" } }));
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { asked.push(url); return new Response(JSON.stringify({ view: { kind: "tasks", needsYou: 4, rows, pages: { next: null } } }), { status: 200 }); }));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement("div", null, createElement(Rail, { workspace, states: null, current: null }), createElement(NeedsDock, { workspace }))));
  expect(host.querySelector("[data-needs-count]")?.textContent).toBe("3");
  // New task is a plus beside the brand.
  expect(host.querySelector('.so-rail-top a[aria-label="New task"]')?.getAttribute("href")).toBe("/tasks/new");
  expect([...host.querySelectorAll('.so-rail-top a[aria-label="New task"] path')].map(one => one.getAttribute("d"))).toEqual(["M12 5v14", "M5 12h14"]);
  await act(async () => { await refreshNeeds(href); });
  expect(asked[0]).toBe("/tasks?scope=all&view=needs-you&format=workspace");
  expect(host.querySelector("[data-needs-count]")?.textContent).toBe("4");
  expect(host.querySelector(".k-dock-needs")?.getAttribute("aria-label")).toBe("Needs you: 4 need you across all your projects");
  await act(async () => { host.querySelector<HTMLButtonElement>(".k-dock-needs")!.click(); });
  await act(async () => { await new Promise(done => setTimeout(done, 0)); });
  const sheet = document.querySelector(".so-needs-sheet")!;
  expect(sheet.querySelectorAll(".so-ti").length).toBe(4);
  expect(sheet.querySelector(".k-count")?.textContent).toBe("4");
});
