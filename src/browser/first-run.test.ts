// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FirstRequest, FirstRun, PhoneCard, rechecked, withSuggestion } from "./first-run.js";
import { firstTaskJourney } from "../first-run.js";
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
