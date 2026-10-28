// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { FirstRequest, FirstRun, Journey, LEAVING_HOLD_MS, leaveFor, PhoneCard, rechecked, withSuggestion } from "./first-run.js";
import { firstTaskJourney, taskRoad } from "../first-run.js";
import type { BrowserFirstRun } from "../browser-workspace.js";

const signedOut = (): BrowserFirstRun => ({
  steps: [
    { key: "agent", title: "Agent signed in", done: false, action: { kind: "command", command: "claude auth login" } },
    { key: "project", title: "Project added", done: true, action: null },
    { key: "task", title: "Your first task", done: false, action: { kind: "link", label: "New task", href: "/tasks/new" } },
  ],
  suggestions: [
    { source: "issue", label: "#12 Login button does nothing", draft: "Fix GitHub issue #12: Login button does nothing" },
    { source: "generic", label: "Fix a lint warning", draft: "Fix one lint warning without changing behaviour." },
    { source: "generic", label: "Improve the README's setup section", draft: "Improve the setup section of the README." },
  ],
  sandbox: "npx toolroll demo",
});

let root: Root | null = null;
beforeEach(() => { document.body.innerHTML = ""; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(element));
}
const mount = (firstRun: BrowserFirstRun) => render(createElement(FirstRun, { firstRun }));

test("three steps, each done or with its one action", async () => {
  await mount(signedOut());
  const rows = [...document.querySelectorAll("[data-step]")];
  expect(rows.map(row => [row.getAttribute("data-step"), row.getAttribute("data-done")])).toEqual([["agent", "false"], ["project", "true"], ["task", "false"]]);
  expect(rows[1]!.querySelector("a, button, code")).toBeNull();
  expect(rows[2]!.querySelector("a")!.getAttribute("href")).toBe("/tasks/new");
});

test("above the composer: how it works in one sentence, three first tasks, and the one line about the lead", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const drafted: string[] = [];
  await render(createElement(FirstRequest, { firstRun: { ...signedOut(), intro: "Ask for a change. The lead writes a short plan; you approve it.", lead: { words: "The lead uses your Claude Code sign-in", href: "/settings/lead" } }, onDraft: (text: string) => drafted.push(text) }));
  const lead = document.querySelector("[data-lead-line]")!;
  expect(lead.querySelector("a")!.getAttribute("href")).toBe("/settings/lead");
  const suggestions = [...document.querySelectorAll<HTMLButtonElement>("[data-first-tasks] button")];
  expect(suggestions.map(one => one.textContent)).toEqual(["#12 Login button does nothing", "Fix a lint warning", "Improve the README's setup section"]);
  expect(suggestions.every(one => one.type === "button" && one.closest("form") === null)).toBe(true);
  await act(async () => suggestions[0]!.click());
  expect(drafted).toEqual(["Fix GitHub issue #12: Login button does nothing"]);
  expect(fetcher).not.toHaveBeenCalled();
});

test("with no agent signed in, the page asks again on its own and shows the lead once it's on", async () => {
  vi.useFakeTimers();
  try {
    const answers = [{ lead: "off", agent: false }, { lead: "on", agent: true }];
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => answers.shift() }));
    const reload = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const real = Object.getOwnPropertyDescriptor(window, "location");
    onTestFinished(() => { if (real) Object.defineProperty(window, "location", real); });
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
    await mount({ ...signedOut(), recheck: "/lead/status" });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toBe("/lead/status");
    expect(reload).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

/** A sign-in check whose answers the test hands out one at a time, and a reload it can see; the real location comes back after. */
async function recheckPage() {
  const answers: ((value: unknown) => void)[] = [];
  const fetcher = vi.fn(() => new Promise(done => { answers.push(done); }));
  const reload = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const real = Object.getOwnPropertyDescriptor(window, "location");
  const { href, origin, pathname, search, hash } = window.location;
  const here = { href, origin, pathname, search, hash, reload };
  Object.defineProperty(window, "location", { configurable: true, value: here });
  await mount({ ...signedOut(), recheck: "/lead/status" });
  const answer = async (body: unknown) => { await act(async () => { answers.shift()!({ ok: true, json: async () => body }); await vi.advanceTimersByTimeAsync(0); }); };
  const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  return { fetcher, reload, here, answer, wait, restore: () => { if (real) Object.defineProperty(window, "location", real); } };
}

test("once the person starts leaving, an answer that lands late never reloads the page out from under them", async () => {
  vi.useFakeTimers();
  const page = await recheckPage();
  try {
    await page.wait(3000);
    expect(page.fetcher).toHaveBeenCalledTimes(1);
    // The answer waits on the same sign-in check the page being opened waits on (Settings → Lead): it lands mid-leave.
    window.dispatchEvent(new Event("beforeunload"));
    await page.answer({ lead: "on", agent: true });
    await page.wait(LEAVING_HOLD_MS - 1000);
    expect(page.reload).not.toHaveBeenCalled();
    // The navigation never happened (Stay, a 204): once the hold lapses the page is theirs again and shows the new state.
    await page.wait(1100);
    expect(page.fetcher).toHaveBeenCalledTimes(2);
    await page.answer({ lead: "on", agent: true });
    expect(page.reload).toHaveBeenCalledTimes(1);
  } finally { page.restore(); vi.useRealTimers(); }
});

/** Click and submit as the browser would: the page's own listeners see each one first, then nothing here navigates. */
function inertNavigation() {
  const stop = (event: Event) => event.preventDefault();
  window.addEventListener("click", stop); window.addEventListener("submit", stop);
  const click = (element: Element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  const link = (attributes: Record<string, string> = {}) => { const a = document.createElement("a"); a.href = "/settings/lead"; for (const [name, value] of Object.entries(attributes)) a.setAttribute(name, value); document.body.append(a); return a; };
  return { click, link, done: () => { window.removeEventListener("click", stop); window.removeEventListener("submit", stop); } };
}

test("a new-tab link, or a click a page script handled itself, is not leaving: the answer shows at once", async () => {
  vi.useFakeTimers();
  const page = await recheckPage();
  const nav = inertNavigation();
  try {
    await page.wait(3000);
    nav.click(nav.link({ target: "_blank" }));
    // A link within this page (Skip to content) moves the view, not the page.
    nav.click(nav.link({ href: "#main" }));
    const handled = nav.link(); handled.addEventListener("click", event => event.preventDefault());
    nav.click(handled);
    await page.answer({ lead: "on", agent: true });
    expect(page.reload).toHaveBeenCalledTimes(1);
  } finally { nav.done(); page.restore(); vi.useRealTimers(); }
});

test("a same-tab link or a form is leaving even where beforeunload never fires (iOS Safari); back from the cache, the page is theirs again", async () => {
  vi.useFakeTimers();
  const page = await recheckPage();
  const nav = inertNavigation();
  try {
    await page.wait(3000);
    nav.click(nav.link());
    await page.answer({ lead: "on", agent: true });
    expect(page.reload).not.toHaveBeenCalled();
    // A form posted from this page, once the link's hold lapsed: leaving again.
    await page.wait(LEAVING_HOLD_MS + 100);
    expect(page.fetcher).toHaveBeenCalledTimes(2);
    const form = document.createElement("form"); document.body.append(form);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await page.answer({ lead: "on", agent: true });
    expect(page.reload).not.toHaveBeenCalled();
    // A script's own navigation (the Project selector) says so first.
    await page.wait(LEAVING_HOLD_MS + 100);
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...page.here, assign } });
    leaveFor("/work?project=shop");
    expect(assign).toHaveBeenCalledWith("/work?project=shop");
    await page.answer({ lead: "on", agent: true });
    expect(page.reload).not.toHaveBeenCalled();
    // Restored from the back/forward cache: it asks again and shows the new state.
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await page.wait(3000);
    await page.answer({ lead: "on", agent: true });
    expect(page.reload).toHaveBeenCalledTimes(1);
  } finally { nav.done(); page.restore(); vi.useRealTimers(); }
});

test("a sign-in check counts only a lead that is on or an agent that is signed in", () => {
  expect(rechecked({ lead: "on", agent: null })).toBe(true);
  expect(rechecked({ lead: "off", agent: true })).toBe(true);
  for (const answer of [{ lead: "off", agent: false }, { lead: "off", agent: null }, null, "on", {}]) expect(rechecked(answer)).toBe(false);
});

test("the first task's way to Ready fills in as it moves", () => {
  const states = (read: Parameters<typeof firstTaskJourney>[0], approved = false) => firstTaskJourney(read, approved).map(one => one.state);
  expect(states({ stage: "planning" })).toEqual(["current", "todo", "todo", "todo", "todo"]);
  expect(states({ stage: "queued" })).toEqual(["current", "todo", "todo", "todo", "todo"]);
  expect(states({ stage: "needs-you", need: "approval" })).toEqual(["done", "current", "todo", "todo", "todo"]);
  expect(states({ stage: "queued" }, true)).toEqual(["done", "done", "current", "todo", "todo"]);
  expect(states({ stage: "building" }, true)).toEqual(["done", "done", "current", "todo", "todo"]);
  expect(states({ stage: "checking" }, true)).toEqual(["done", "done", "done", "current", "todo"]);
  expect(states({ stage: "finished" }, true)).toEqual(["done", "done", "done", "done", "done"]);
  expect(states({ stage: "failed" }, true)).toEqual(["done", "done", "stuck", "todo", "todo"]);
  expect(states({ stage: "needs-you", need: "other" }, true)).toEqual(["done", "done", "stuck", "todo", "todo"]);
  expect(firstTaskJourney({ stage: "needs-you", need: "other" }, true, true).map(one => one.state)).toEqual(["done", "done", "done", "stuck", "todo"]);
});

test("a task's road says only what happened: no Checks for a report, skipped checks say so, the wait is the one amber step", () => {
  const road = (...args: Parameters<typeof taskRoad>) => taskRoad(...args).map(one => `${one.key}:${one.state}${one.needsYou ? "!" : ""}:${one.label}`);
  // A research report has no Checks step at all.
  expect(road({ stage: "finished" }, true, true, { report: true })).toEqual(["plan:done:Plan", "approve:done:You approve", "build:done:Build", "ready:done:Ready"]);
  // Past Checks without a passing check: the step is skipped and says why, never done.
  expect(road({ stage: "finished" }, true, true, { checks: "not-run" })[3]).toBe("checks:skipped:Checks not run");
  expect(road({ stage: "complete" }, true, true, { checks: "unread" })[3]).toBe("checks:skipped:Checks unread");
  expect(road({ stage: "finished" }, true, true, { checks: "failed" })[3]).toBe("checks:stuck:Checks failed");
  expect(road({ stage: "finished" }, true, true, { checks: "running" })[3]).toBe("checks:current:Checks running");
  expect(road({ stage: "finished" }, true, true, { checks: "passed" })[3]).toBe("checks:done:Checks");
  // With no checks fact the step is never shown done.
  expect(road({ stage: "finished" }, true, true, {})[3]).toBe("checks:skipped:Checks");
  // You approve is done only when the plan was approved; a rewritten plan waits on approval again.
  expect(road({ stage: "building" }, false, false, {})[1]).toBe("approve:skipped:You approve");
  expect(road({ stage: "needs-you", need: "replan" }, true, true, {}).slice(1, 3)).toEqual(["approve:current!:You approve", "build:todo:Build"]);
  // A report stopped where Checks would be stops at Ready.
  expect(road({ stage: "stopped" }, true, true, { report: true }).at(-1)).toBe("ready:stuck:Ready");
  // At Checks now, a recorded failure reads as one, and a running check says so.
  expect(road({ stage: "waiting" }, true, true, { checks: "failed" })[3]).toBe("checks:stuck:Checks failed");
  expect(road({ stage: "checking" }, true, true, { checks: "running" })[3]).toBe("checks:current:Checks running");
  // The approval is the step that waits on a person; a failure stops at Build and waits on nobody.
  expect(road({ stage: "needs-you", need: "approval" }, false, false, {})[1]).toBe("approve:current!:You approve");
  expect(road({ stage: "failed" }, true, false, {})[2]).toBe("build:stuck:Build");
  expect(road({ stage: "stopped" }, true, false, {}).some(one => one.includes("!"))).toBe(false);
  expect(road({ stage: "needs-you", need: "other" }, true, true, {})[3]).toBe("checks:stuck!:Checks");
});

test("the road names where the task stands, never Ready for a step that stopped there", async () => {
  await render(createElement(Journey, { steps: taskRoad({ stage: "stopped" }, true, true, { report: true }) }));
  expect(document.querySelector("[data-first-task-journey]")!.getAttribute("aria-label")).toBe("Where this task is: Ready, stopped here");
});

test("after the first result, the phone: a chat app or this console over Tailscale, and Not now puts it away", async () => {
  const fetcher = vi.fn(async () => ({ ok: true })); vi.stubGlobal("fetch", fetcher);
  const apps = [{ label: "Telegram", href: "/settings/telegram" }, { label: "Slack", href: "/settings/slack" }, { label: "Discord", href: "/settings/discord" }, { label: "Teams", href: "/settings/teams" }];
  await render(createElement(PhoneCard, { csrf: "c", phone: { chatApps: apps, tailnet: { address: "http://mac.tail1234.ts.net:4180/", restart: "toolroll up --host 0.0.0.0" }, dismissHref: "/onboarding/phone/dismiss" } }));
  const card = document.querySelector("[data-phone-card]")!;
  expect(card.querySelector('a[href="/settings/telegram"]')!.textContent).toBe("Pair Telegram");
  expect([...card.querySelectorAll(".so-phone-others a")].map(one => one.textContent)).toEqual(["Slack", "Discord", "Teams"]);
  expect([...card.querySelectorAll("[data-phone-tailnet] code")].map(one => one.textContent)).toEqual(["http://mac.tail1234.ts.net:4180/", "toolroll up --host 0.0.0.0"]);
  await act(async () => (card.querySelector('button[type="submit"]') as HTMLButtonElement).click());
  expect(document.querySelector("[data-phone-card]")).toBeNull();
  expect(fetcher).toHaveBeenCalledWith("/onboarding/phone/dismiss", expect.objectContaining({ method: "POST" }));
});

test("a tapped first task never replaces what the person already typed", () => {
  expect(withSuggestion("", "Fix GitHub issue #12: Login button does nothing")).toBe("Fix GitHub issue #12: Login button does nothing");
  expect(withSuggestion("  \n", "Fix a lint warning")).toBe("Fix a lint warning");
  expect(withSuggestion("Also keep the old API working", "Fix a lint warning")).toBe("Also keep the old API working\nFix a lint warning");
  expect(withSuggestion("Fix a lint warning", "Fix a lint warning")).toBe("Fix a lint warning");
});
