// @vitest-environment happy-dom
/** The Live grid in the browser (agents-live-view.tsx): tiles from /agents/live, their lines and subagents from the
 * read windows; subagents nested under their parent, holding Done for 30 s, then leaving; nothing leaves while the
 * grid is being looked at; Needs you on the quiet one; the terminals line; and nothing on it that acts. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserAgentsView } from "../browser-workspace.js";
import { AgentsView } from "./views/agents-view.js";

class Events extends EventTarget {
  static latest: Events | null = null;
  static CLOSED = 2;
  readyState = 1;
  close = vi.fn(() => { this.readyState = 2; });
  constructor(readonly url: string) { super(); Events.latest = this; }
}

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const tile = (runId: number, extra: Record<string, unknown> = {}) => ({ runId, role: "builder", title: `Task ${runId}`, project: "/p/shop-web", agent: "claude", model: "sonnet",
  startedAt: iso(600 - runId), endedAt: null, state: "working", why: null, quietSince: null, local: true, parentRun: null, ...extra });
let tiles: unknown[] = [];
const sub: Record<number, unknown[]> = {};
const requests: { url: string; method: string }[] = [];
let root: Root | null = null, host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("EventSource", Events);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? "GET" });
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url === "/agents/live") return json({ tiles });
    if (url === "/term/state") return json({ sessions: [{ endedAt: null }, { endedAt: null }, { endedAt: iso(5) }] });
    const run = Number(/\/agents\/live\/(\d+)/.exec(url)?.[1]);
    if (url.includes("file=main")) return json({ records: [{ k: "say", at: iso(30), t: [`main words of ${run}`] }], cursor: "c", more: false });
    return json({ records: sub[run] ?? [], cursor: "c", more: false });
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  requests.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const view: BrowserAgentsView = { kind: "agents", groups: [], selected: null, lanes: null, empty: null, live: true };
const flush = async () => { for (let n = 0; n < 6; n += 1) await act(async () => { await vi.advanceTimersByTimeAsync(10); }); };

test("tiles, nested subagents, Needs you, the terminals line, and no control that acts", async () => {
  tiles = [tile(1, { state: "needs-you", why: "quiet", quietSince: iso(300) }), tile(2)];
  sub[2] = [{ k: "child", s: 1, at: iso(100), parent: "s1", desc: "Reproduce the failure" }, { k: "say", s: 1, at: iso(90), t: ["child words"] },
    { k: "child", s: 2, at: iso(80), parent: "s1", desc: "Review the parser" }, { k: "end", s: 2, at: iso(5), ok: true }];
  await act(async () => { root = createRoot(host); root.render(createElement(AgentsView, { view })); });
  await flush();
  expect([...host.querySelectorAll("[data-live-tile]")].map(one => one.getAttribute("data-live-tile"))).toEqual(["1", "2"]);
  const quiet = host.querySelector('[data-live-tile="1"]')!;
  expect(quiet.querySelector("[data-live-chip]")?.textContent).toBe("Needs you");
  expect(quiet.textContent).toContain("Quiet for 5 min");
  const parent = host.querySelector('[data-live-tile="2"]')!;
  expect([...parent.querySelectorAll("[data-live-child]")].map(one => one.textContent?.includes("Done") ? "done" : "working")).toEqual(["working", "done"]);
  expect(parent.textContent).toContain("child words");
  expect(host.textContent).toContain("2 terminals you're driving");
  expect(host.querySelector('a[href="/term"]')).not.toBeNull();
  // Nothing here acts: no form, no button that posts, every request a GET.
  expect(host.querySelectorAll("form, textarea, button[type=submit]").length).toBe(0);
  expect(requests.every(one => one.method === "GET")).toBe(true);

  // A Done subagent holds for 30 s, then leaves.
  await act(async () => { await vi.advanceTimersByTimeAsync(26_000); });
  expect(parent.querySelectorAll("[data-live-child]").length).toBe(1);
});

test("nothing leaves while the grid is being looked at; it goes when focus leaves", async () => {
  tiles = [tile(1), tile(2), tile(3)];
  await act(async () => { root = createRoot(host); root.render(createElement(AgentsView, { view })); });
  await flush();
  const grid = host.querySelector("[data-live-grid] ul")!;
  const link = grid.querySelector("a")! as HTMLAnchorElement;
  await act(async () => { link.focus(); }); // looking: focus in the grid
  tiles = [tile(1), tile(3)];
  // The room's change makes the page read the tiles again: run 2 has left.
  expect(Events.latest?.url).toContain("agents-live");
  await act(async () => { Events.latest!.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ room: "agents-live", at: "x" }) })); });
  await flush();
  const shown = () => [...host.querySelectorAll("[data-live-tile]")].map(one => one.getAttribute("data-live-tile"));
  expect(shown()).toEqual(["1", "2", "3"]); // held while the grid is being looked at
  await act(async () => { link.blur(); });
  await flush();
  expect(shown()).toEqual(["1", "3"]);
});
