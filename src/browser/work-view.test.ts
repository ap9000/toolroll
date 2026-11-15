// @vitest-environment happy-dom
/** Work ("/", the one-workspace plan S2a): what needs you grouped Decide / Review / Unblock with exact counts (every ask
 * Home admitted, its own rows and links), then Running, Queued and Done; segments that are addresses; the selected row
 * open beside the list at a desk and a plain link on a phone; an agent's question answered in place through its own
 * one-click route. The rail is Work · Chat · Settings, with Projects and Manage projects under it. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { browserNavigationOf, type BrowserHomeRow, type BrowserTaskRow, type BrowserTasksView, type BrowserWorkView } from "../browser-workspace.js";
import { WorkView } from "./views/work-view.js";
import { FormToken } from "./ui/index.js";
import { DESTINATIONS, LEGACY, searchResults } from "./search.js";

const row = (id: string, extra: Partial<BrowserHomeRow> = {}): BrowserHomeRow => ({
  id, title: `Task ${id}`, href: `/t/${id}`, project: "shop", age: "4h ago", state: "needs", ask: "approve", group: "decide", reason: null, line: "Review the plan and approve it to start.",
  action: { label: "Approve plan", href: `/t/${id}#approve` }, question: null, ...extra });
const taskRow = (id: string, rank: number, word: string, tone: BrowserTaskRow["word"]["tone"]): BrowserTaskRow => ({
  id, title: `Task ${id}`, href: `/t/${id}`, project: "shop", age: "1h ago", status: { label: word, tone: "neutral", token: word }, word: { word, tone }, ask: null, chip: null,
  group: rank === 1 ? "building" : "rest", rank, action: null, detail: null, problem: null, notes: [] });
const tab = (key: string, label: string, count: number, active = false) => ({ key, label, href: key === "all" ? "/" : `/?view=${key}`, count, active });
const list = (over: Partial<BrowserTasksView> = {}): BrowserTasksView => ({
  kind: "tasks", layout: "list", projects: null, layouts: { list: "/", board: "/?view=board" }, needsYou: 19, groups: null, empty: null, pages: { first: null, next: null }, tools: [],
  newTask: { label: "New task", href: "/tasks/new" }, limits: null,
  tabs: [tab("all", "All", 23, true), tab("needs-you", "Needs you", 19), tab("ready", "Ready", 16), tab("running", "Running", 1), tab("queued", "Queued", 1), tab("completed", "Finished", 2)],
  rows: [taskRow("a", 0, "Plan", "needs"), taskRow("w", 1, "Building", "live"), taskRow("k", 2, "Queued", ""), taskRow("d", 3, "Complete", "done")], ...over });
const view = (over: Partial<BrowserWorkView> = {}): BrowserWorkView => ({
  kind: "work", project: null, projectName: "All projects", setup: null, empty: null, needsCount: 20, list: list(),
  needs: [
    { key: "decide", label: "Decide", count: 2, rows: [row("a"), row("q", { ask: "answer", line: "How should retries back off?", action: null, question: { id: 7, text: "How should retries back off?", recap: "They hammer endpoints.", options: [
      { id: "exp", label: "Exponential", consequence: "Slow to give up.", recommended: true }, { id: "fixed", label: "Fixed", consequence: "Gives up fast.", recommended: false }] } })] },
    { key: "review", label: "Review", count: 16, rows: [row("r", { ask: "review", group: "review", action: { label: "Open result", href: "/t/r?tab=result&run=3" } })] },
    { key: "unblock", label: "Unblock", count: 2, rows: [row("f", { ask: "wrong", group: "unblock", reason: "Build failed", line: "Build failed.", action: { label: "Review and retry", href: "/t/f" } }),
      row("setup:builder", { ask: "setup", group: "unblock", href: "/start-builder", line: "Start a builder line", action: { label: "Start a builder", href: "/start-builder" } })] },
  ], ...over });

let root: Root | null = null;
const mount = async (v: BrowserWorkView) => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(FormToken.Provider, { value: "csrf-1" }, createElement(WorkView, { view: v }))));
};
const desk = () => vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
const narrow = (width: number) => vi.stubGlobal("matchMedia", (query: string) => {
  const max = /max-width:\s*(\d+)px/.exec(query);
  return { matches: max !== null && width <= Number(max[1]), media: query, addEventListener() {}, removeEventListener() {} };
});
const selectedRow = () => document.querySelector("[data-row][data-selected]")?.getAttribute("data-row");
const pane = () => document.querySelector("[data-work-panel]")!;
beforeEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  desk();
});
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; vi.unstubAllGlobals(); });

test("All leads with what needs you, Decide / Review / Unblock with exact counts, then Running, Queued and Done; a waiting row is listed once", async () => {
  await mount(view());
  expect([...document.querySelectorAll("[data-group]")].map(one => [one.getAttribute("data-group"), one.querySelector(".k-grp")?.textContent]))
    .toEqual([["decide", "Decide2"], ["review", "Review16"], ["unblock", "Unblock2"], ["running", "Running1"], ["queued", "Queued1"], ["done", "Done1"]]);
  expect([...document.querySelectorAll("[data-row]")].map(one => one.getAttribute("data-row"))).toEqual(["a", "q", "r", "f", "setup:builder", "w", "k", "d"]);
  // A group says its exact count past the rows this page lists; the list's own pages hold the rest.
  expect(document.querySelector('[data-group="review"] .k-grp')?.textContent).toBe("Review16");
  expect(document.querySelector(".so-tri-more")).toBeNull();
  // Each row: its chip, its title linking its own page, and its one act.
  expect(document.querySelector('[data-row="a"] .k-chip')?.textContent).toBe("Plan");
  expect(document.querySelector('[data-row="r"] .k-chip')?.textContent).toBe("Result");
  expect(document.querySelector('[data-row="w"] .k-chip.live')?.textContent).toBe("Building");
  expect(document.querySelector('[data-row="a"] .k-row-t')?.getAttribute("href")).toBe("/t/a");
  expect(document.querySelector('[data-row="setup:builder"] .k-row-t')?.getAttribute("href")).toBe("/start-builder");
  expect([...document.querySelectorAll("[data-row] .k-row-a .k-btn")].map(one => one.textContent)).toEqual(["Approve", "Answer", "Review", "Open", "Open", "Watch", "Open", "Open"]);
  // The segments are addresses, Needs you first with the tasks' count: the same number as the rail's Work.
  expect([...document.querySelectorAll(".so-work-h .k-seg a")].map(one => [one.textContent, one.getAttribute("href"), one.getAttribute("aria-current")]))
    .toEqual([["Needs you19", "/?view=needs-you", null], ["All23", "/", "page"], ["Running1", "/?view=running", null], ["Queued1", "/?view=queued", null], ["Done2", "/?view=completed", null]]);
  // A wide desk opens the first row beside the list.
  expect(selectedRow()).toBe("a");
  expect(pane().querySelector("[data-home-approval]")?.getAttribute("data-home-approval")).toBe("reading");
});

test("the Needs you view is the waiting groups alone; another view is the list's own rows", async () => {
  await mount(view({ list: list({ tabs: list().tabs.map(one => ({ ...one, active: one.key === "needs-you" })) }) }));
  expect([...document.querySelectorAll("[data-group]")].map(one => one.getAttribute("data-group"))).toEqual(["decide", "review", "unblock"]);
  await act(async () => root!.unmount()); root = null; document.body.innerHTML = "";
  await mount(view({ list: list({ tabs: list().tabs.map(one => ({ ...one, active: one.key === "running" })), rows: [taskRow("w", 1, "Building", "live")] }) }));
  expect([...document.querySelectorAll("[data-row]")].map(one => one.getAttribute("data-row"))).toEqual(["w"]);
});

test("a release, a flow card and a setup step: their ids never meet a task's, and the panel is one link to their own page", async () => {
  const own = (id: string, ask: "release" | "flow" | "setup", label: string, href: string) => row(id, { ask, group: ask === "setup" ? "unblock" : "decide", href, line: `${label} line`, action: { label, href } });
  await mount(view({ needs: [{ key: "decide", label: "Decide", count: 2, rows: [own("release:rel", "release", "Review the release", "/t/rel/release"), own("flow:12", "flow", "Open the card", "/flows/3?card=12")] },
    { key: "unblock", label: "Unblock", count: 1, rows: [own("setup:builder", "setup", "Start a builder", "/start-builder")] }] }));
  const links = () => [...pane().querySelectorAll("a")].map(one => [one.textContent, one.getAttribute("href")]);
  expect(pane().querySelector("[data-home-approval]")).toBeNull();
  expect(pane().textContent).toContain("Review the release line");
  expect(links()).toEqual([["Review the release", "/t/rel/release"]]);
  const keys = document.querySelector<HTMLElement>(".so-work-list")!;
  const down = async () => act(async () => { keys.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  await down();
  expect(links()).toEqual([["Open the card", "/flows/3?card=12"]]);
  await down();
  expect(links()).toEqual([["Start a builder", "/start-builder"]]);
  // Nothing was read for them: no page of theirs is a task's.
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

test("a click selects in place at a desk and keeps it in the address; arrows move the selection through every group", async () => {
  await mount(view());
  await act(async () => document.querySelector<HTMLAnchorElement>('[data-row="r"] .k-row-t')!.click());
  expect(selectedRow()).toBe("r");
  expect(new URL(window.location.href).searchParams.get("task")).toBe("r");
  const keys = document.querySelector<HTMLElement>(".so-work-list")!;
  await act(async () => { keys.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(selectedRow()).toBe("f");
  await act(async () => { keys.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
  expect(selectedRow()).toBe("r");
  window.history.replaceState(null, "", "/");
});

test("900px and narrower: one column, Needs you first, no panel, and a row is a plain link to its own page", async () => {
  narrow(390);
  await mount(view());
  expect(document.querySelector("[data-work-panel]")).toBeNull();
  expect(selectedRow()).toBeUndefined();
  const link = document.querySelector<HTMLAnchorElement>('[data-row="r"] .k-row-t')!;
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => { link.dispatchEvent(click); });
  expect(click.defaultPrevented).toBe(false);
  expect(document.querySelector("[data-group]")?.getAttribute("data-group")).toBe("decide");
  expect(document.querySelector(".k-dock")?.textContent).toContain("New task");
});

test("901 to 1149px: nothing opens by itself; a chosen row opens as a drawer over the list, and closes", async () => {
  narrow(1024);
  await mount(view());
  expect(document.querySelector(".so-work-drawer")).toBeNull();
  expect(document.querySelector(".so-work-split [data-work-panel]")).toBeNull();
  await act(async () => document.querySelector<HTMLAnchorElement>('[data-row="setup:builder"] .k-row-t')!.click());
  const drawer = document.querySelector(".so-work-drawer")!;
  expect(drawer.getAttribute("role")).toBe("dialog");
  expect(drawer.textContent).toContain("Start a builder line");
  await act(async () => { drawer.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); });
  expect(document.querySelector(".so-work-drawer")).toBeNull();
  window.history.replaceState(null, "", "/");
});

test("no task yet: what to do first and New task", async () => {
  await mount(view({ needs: [], needsCount: 0, empty: { title: "No tasks yet", text: "Describe a change in a sentence; an agent writes a plan for you to approve." }, list: list({ rows: [] }) }));
  expect(document.querySelector(".k-empty-t")?.textContent).toBe("No tasks yet");
  expect(document.querySelector(".so-work-list .k-btn-primary")?.getAttribute("href")).toBe("/tasks/new");
});

// The yellow word itself is guarded everywhere by the design folder's own test; here, the tokens Work must not reach for.
test("Work's stylesheets name no warning or attention colour and no hand-written colour: tokens only", () => {
  for (const file of ["home.css", "work.css"]) {
    const css = readFileSync(join(process.cwd(), "src/browser/views", file), "utf8");
    expect(css, file).not.toMatch(/--so-warning|--so-attention|#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  }
});

test("the rail is Work · Chat · Settings: Work holds the one Needs-you count, a task's pages and an agent's question; Flows and Agents sit under Settings", () => {
  const at = (path: string) => browserNavigationOf(path).map(one => [one.label, one.active]);
  expect(browserNavigationOf("/").map(one => one.label)).toEqual(["Work", "Chat", "Settings"]);
  expect(at("/chat")).toEqual([["Work", false], ["Chat", true], ["Settings", false]]);
  for (const path of ["/", "/t/x", "/d/7", "/tasks"]) expect(at(path)[0], path).toEqual(["Work", true]);
  for (const path of ["/flows", "/agents", "/settings/models"]) expect(at(path)[2], path).toEqual(["Settings", true]);
  expect(browserNavigationOf("/", 3)[0]).toHaveProperty("count", 3);
  expect(browserNavigationOf("/", 3)[1]).not.toHaveProperty("count");
});

test("an agent's question is answered in place: one click, the recommended option chosen, the outcome said where it happened", async () => {
  const posts: { url: string; body: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { posts.push({ url, body: String(init.body) }); return new Response("", { status: 200 }); }));
  await mount(view());
  await act(async () => document.querySelector<HTMLElement>('[data-row="q"]')!.click());
  expect(pane().textContent).toContain("How should retries back off?");
  expect(pane().querySelector<HTMLInputElement>('input[value="exp"]')!.checked).toBe(true);
  expect(pane().textContent).toContain("Recommended");
  const answer = [...pane().querySelectorAll("button")].find(one => one.textContent === "Answer")!;
  await act(async () => { answer.click(); });
  await act(async () => { await new Promise(done => setTimeout(done, 0)); });
  expect(posts).toEqual([{ url: "/d/7/answer", body: "csrf=csrf-1&choice=exp" }]);
  expect(pane().textContent).toContain("Answered");
  window.history.replaceState(null, "", "/");
});

test("a refused answer stays in place and says nothing changed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('<main><div class="problem">already answered — somebody got there first</div></main>', { status: 409 })));
  await mount(view());
  await act(async () => document.querySelector<HTMLElement>('[data-row="q"]')!.click());
  await act(async () => { [...pane().querySelectorAll("button")].find(one => one.textContent === "Answer")!.click(); });
  await act(async () => { await new Promise(done => setTimeout(done, 0)); });
  expect(pane().querySelector('[role="alert"]')?.textContent).toBe("Couldn’t answer: already answered — somebody got there first. Nothing changed.");
  window.history.replaceState(null, "", "/");
});

test("search finds a setting by any of its words and an old name says where it lives now", () => {
  const workspace = { crew: [], projects: [], chats: [], navigation: [{ label: "Work", href: "/", active: true }] } as never;
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
  expect(host.querySelector('.k-empty a[href="/"]')?.textContent).toBe("Open every task in Work");
});

test("the one Needs-you count moves when work does: read again from its list, the rail, the dock and its sheet agree", async () => {
  const { Rail, NeedsDock, refreshNeeds } = await import("./shell.js");
  const href = "/?view=needs-you";
  const workspace = { version: 1, path: "/search", title: "Search", user: "alex", csrf: "c", sensitive: false, refreshUrl: "/search", receipt: null, projects: [], crew: [], crewTruncated: false,
    conversation: null, focus: null, result: null, catchUpHtml: "", controlsHtml: "", notices: [], pageHtml: "", navigation: [{ label: "Work", href: "/", active: false, count: 3 }],
    needsYou: { count: 3, saturated: false, scope: null, label: "3 need you across all your projects", href } } as unknown as import("../browser-workspace.js").BrowserWorkspace;
  const rows = Array.from({ length: 4 }, (_, n) => ({ id: `t${n}`, title: `Task ${n}`, href: `/t/t${n}`, project: null, age: "1h ago" }));
  const asked: string[] = [];
  // Work's Needs you: every ask it lists, in its groups; the count is the tasks' own.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { asked.push(url); return new Response(JSON.stringify({ view: { kind: "work", list: { needsYou: 4 },
    needs: [{ key: "decide", label: "Decide", count: 3, rows: rows.slice(0, 3) }, { key: "unblock", label: "Unblock", count: 1, rows: rows.slice(3) }] } }), { status: 200 }); }));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement("div", null, createElement(Rail, { workspace, states: null, current: null }), createElement(NeedsDock, { workspace }))));
  expect(host.querySelector("[data-needs-count]")?.textContent).toBe("3");
  // New task is a plus beside the brand.
  expect(host.querySelector('.so-rail-top a[aria-label="New task"]')?.getAttribute("href")).toBe("/tasks/new");
  expect([...host.querySelectorAll('.so-rail-top a[aria-label="New task"] path')].map(one => one.getAttribute("d"))).toEqual(["M12 5v14", "M5 12h14"]);
  await act(async () => { await refreshNeeds(href); });
  expect(asked[0]).toBe("/?view=needs-you&format=workspace");
  expect(host.querySelector("[data-needs-count]")?.textContent).toBe("4");
  expect(host.querySelector(".k-dock-needs")?.getAttribute("aria-label")).toBe("Needs you: 4 need you across all your projects");
  await act(async () => { host.querySelector<HTMLButtonElement>(".k-dock-needs")!.click(); });
  await act(async () => { await new Promise(done => setTimeout(done, 0)); });
  const sheet = document.querySelector(".so-needs-sheet")!;
  expect(sheet.querySelectorAll(".so-ti").length).toBe(4);
  expect(sheet.querySelector(".k-count")?.textContent).toBe("4");
  // Projects and Manage projects, always (even with no project yet).
  expect(host.querySelector(".so-rail [data-manage-projects]")?.getAttribute("href")).toBe("/projects");
});

test("a command to type reads as code, never with its backticks, in a row and in the setup step it opens", async () => {
  const say = "No coding agent is signed in. Run `claude auth login`, then it starts by itself.";
  await mount(view({ needs: [{ key: "unblock", label: "Unblock", count: 2, rows: [
    row("setup:agent", { ask: "setup", group: "unblock", href: "/welcome", line: "Run `claude auth login` in a terminal.", action: { label: "Open", href: "/welcome" } }),
    row("first", { ask: "wrong", group: "unblock", reason: null, line: say, action: { label: "Open", href: "/t/first" } })] }] }));
  const desc = document.querySelector('[data-row="first"] .k-row-d')!;
  expect(desc.textContent).toBe("No coding agent is signed in. Run claude auth login, then it starts by itself.");
  expect(desc.querySelector("code")?.textContent).toBe("claude auth login");
  // The setup step opens beside the list (a desk selects the first row): its line, the command as code.
  expect(selectedRow()).toBe("setup:agent");
  expect(pane().querySelector(".so-open-x")?.textContent).toBe("Run claude auth login in a terminal.");
  expect(pane().querySelector(".so-open-x code")?.textContent).toBe("claude auth login");
});
