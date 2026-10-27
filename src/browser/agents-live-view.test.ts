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
  for (const key of Object.keys(sub)) delete sub[Number(key)];
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
  // Codex av6 #2: no link into the List view's agent page (opening it there marks seen and watches): nothing here opens it.
  expect(host.querySelectorAll('a[href^="/agents?run="]').length).toBe(0);

  // A Done subagent holds for 30 s, then leaves.
  await act(async () => { await vi.advanceTimersByTimeAsync(26_000); });
  expect(parent.querySelectorAll("[data-live-child]").length).toBe(1);
});

test("nothing leaves while the grid is being looked at; it goes when focus leaves", async () => {
  tiles = [tile(1), tile(2), tile(3)];
  await act(async () => { root = createRoot(host); root.render(createElement(AgentsView, { view })); });
  await flush();
  const grid = host.querySelector("[data-live-grid] ul")!;
  const link = grid.querySelector("[role=log]")! as HTMLElement;
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

// ---- Codex av6, round 1 ----------------------------------------------------------------------------------------------
import { applyWindow, createScheduler, EMPTY, KEEP_LINES } from "./views/agents-live-view.js";

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body }) as unknown as Response;

test("#1 failures back off and never spin: a run of failures, a deadline, a 429 that asks for time", async () => {
  const calls: number[] = [];
  const failing = vi.fn(async () => { calls.push(Date.now()); throw new Error("down"); }) as unknown as typeof fetch;
  const one = createScheduler(() => {}, failing);
  one.want(["7:main"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(calls.length).toBeGreaterThan(2);
  expect(calls.length).toBeLessThan(10); // 1 s, 2 s, 4 s … 30 s: a handful in a minute, never a loop
  one.dispose();
  const asked: number[] = [];
  const busy = vi.fn(async () => { asked.push(Date.now()); return reply(429, {}, { "retry-after": "20" }); }) as unknown as typeof fetch;
  const two = createScheduler(() => {}, busy);
  two.want(["7:main"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(19_000); });
  expect(asked.length).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(asked.length).toBe(2);
  two.dispose();
});

test("#4 the page going aborts every read and starts none after", async () => {
  const signals: AbortSignal[] = [];
  const hanging = vi.fn((_url: string, init?: RequestInit) => { signals.push(init!.signal!); return new Promise<Response>(() => {}); }) as unknown as typeof fetch;
  const scheduler = createScheduler(() => {}, hanging);
  scheduler.want(["1:main", "1:sub", "2:main", "2:sub", "3:main", "3:sub"]);
  expect(signals).toHaveLength(4); // four at most
  scheduler.dispose();
  expect(signals.every(signal => signal.aborted)).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(hanging).toHaveBeenCalledTimes(4);
});

test("#5 #6 #9 each file keeps its own state; a restart starts that file over; steps close by id; output is kept", () => {
  let stream = applyWindow(EMPTY, "main", { error: "gone" });
  stream = applyWindow(stream, "sub", { records: [] });
  expect([stream.mainState, stream.subState]).toEqual(["unavailable", "ready"]);
  stream = applyWindow(EMPTY, "main", { records: [
    { k: "step", id: "s1", kind: "command", target: "npm test" }, { k: "step", id: "s2", kind: "read", target: "a.ts" },
    { k: "done", id: "s1", ok: true, out: ["24 passed"] }, { k: "step", id: "s3", kind: "edit", target: "b.ts", once: true }] });
  expect(stream.main.open.map(([, words]) => words)).toEqual(["Reading a.ts"]); // s2 still open; the one-off s3 opens nothing
  expect(stream.main.lines).toContain("  24 passed");
  stream = applyWindow(stream, "main", { restarted: true, records: [{ k: "say", t: ["new file"] }] });
  expect(stream.main.lines).toEqual(["Output restarted.", "new file"]);
  let sub = applyWindow(EMPTY, "sub", { records: [{ k: "child", s: 1, desc: "a" }, { k: "step", s: 1, id: "c1s1", kind: "read", target: "x" }, { k: "done", s: 1, id: "c1s1", ok: true }] });
  expect(sub.children.get(1)!.open).toEqual([]);
  sub = applyWindow(sub, "sub", { restarted: true, records: [{ k: "child", s: 2, desc: "b" }] });
  expect([...sub.children.keys()]).toEqual([2]);
  expect(applyWindow(EMPTY, "main", { records: Array.from({ length: KEEP_LINES + 50 }, (_, i) => ({ k: "say", t: [`l${i}`] })) }).main.lines).toHaveLength(KEEP_LINES);
});

test("#7 one streamed set: the newest 24 local runs are read and shown live; the 25th says so and is never read", async () => {
  tiles = Array.from({ length: 25 }, (_, i) => tile(25 - i));
  await act(async () => { root = createRoot(host); root.render(createElement(AgentsView, { view })); });
  await flush();
  expect(host.querySelector('[data-live-tile="1"]')?.textContent).toContain("Not shown live");
  expect(requests.some(one => one.url.startsWith("/agents/live/1?"))).toBe(false);
  expect(requests.some(one => one.url.startsWith("/agents/live/25?"))).toBe(true);
  expect(host.querySelector("[data-live-headline]")?.textContent).toContain("24 of 25 shown live");
});

test("#8 an older answer to the tile list never replaces a newer one", async () => {
  const held: ((value: unknown) => void)[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/agents/live") return new Promise(resolve => held.push(resolve));
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ records: [], more: false }) });
  }));
  await act(async () => { root = createRoot(host); root.render(createElement(AgentsView, { view })); });
  await act(async () => { Events.latest!.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ room: "agents-live", at: "x" }) })); });
  const answer = (runs: number[]) => ({ ok: true, json: async () => ({ tiles: runs.map(run => tile(run)) }) });
  await act(async () => { held[1]!(answer([2, 3])); });
  await act(async () => { held[0]!(answer([1])); });
  await flush();
  expect([...host.querySelectorAll("[data-live-tile]")].map(one => one.getAttribute("data-live-tile"))).toEqual(["2", "3"]);
});

test("#10 #11 pointer and focus hold the grid together; an expired subagent never comes back", async () => {
  tiles = [tile(1), tile(2)];
  sub[1] = [{ k: "child", s: 1, at: iso(100), desc: "old helper" }, { k: "end", s: 1, at: iso(40), ok: true }];
  await act(async () => { root = createRoot(host); root.render(createElement(AgentsView, { view })); });
  await flush();
  expect(host.querySelectorAll("[data-live-child]").length).toBe(0); // ended 40 s ago: already gone
  const grid = host.querySelector("[data-live-grid] ul")!;
  await act(async () => { grid.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); });
  await flush();
  expect(host.querySelectorAll("[data-live-child]").length).toBe(0); // looking never brings it back
  const log = host.querySelector('[data-live-tile="2"] [role=log]') as HTMLElement;
  await act(async () => { log.focus(); });
  tiles = [tile(1)];
  await act(async () => { Events.latest!.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ room: "agents-live", at: "y" }) })); });
  await flush();
  await act(async () => { grid.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })); });
  await flush();
  expect(host.querySelector('[data-live-tile="2"]')).not.toBeNull(); // the pointer left, but focus still holds it
});

test("#12 repairs nest under their build; a subagent's subagent nests under it", async () => {
  tiles = [tile(1), tile(2, { role: "repair", parentRun: 1, title: "Fix the handoff" })];
  sub[1] = [{ k: "child", s: 1, at: iso(50), desc: "outer" }, { k: "child", s: 2, at: iso(40), desc: "inner", via: 1 }];
  await act(async () => { root = createRoot(host); root.render(createElement(AgentsView, { view })); });
  await flush();
  const build = host.querySelector('[data-live-tile="1"]')!;
  expect(build.querySelector('[data-live-tile="2"]')?.textContent).toContain("Fix the handoff");
  expect(build.querySelector('[data-live-child="1"] [data-live-child="2"]')?.textContent).toContain("inner");
});

test("#13 #14 the well keeps every retained line (scrollable); chips print ink text on their soft fill", async () => {
  tiles = [tile(1)];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url === "/agents/live") return json({ tiles });
    if (url.includes("file=main")) return json({ records: Array.from({ length: 40 }, (_, i) => ({ k: "say", t: [`line ${i}`] })), more: false });
    return json({ records: [], more: false });
  }));
  await act(async () => { root = createRoot(host); root.render(createElement(AgentsView, { view })); });
  await flush();
  expect(host.querySelector("[data-live-lines]")?.textContent).toContain("line 0");
  expect(host.querySelector("[data-live-lines]")?.textContent).toContain("line 39");
  expect(host.querySelector("[data-live-chip]")?.className).toContain("text-foreground");
});
