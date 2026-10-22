// @vitest-environment happy-dom
/** The live board in the page: clocks tick from the server's now, a swap slides cards through one view transition at a
 * time, and a worker whose builds changed flashes — with the plain instant swap wherever view transitions are missing or
 * motion is reduced. */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { boardTickScript, regionScript } from "../server/chrome.js";

// Every script a test runs is torn down after it: its listeners, its intervals, its observers — so no earlier test's
// region answers a later test's event.
const cleanups: (() => void)[] = [];
const realSetInterval = globalThis.setInterval;
beforeEach(() => {
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
      add(type, listener, options);
      cleanups.push(() => target.removeEventListener(type, listener, options));
    });
  }
  vi.stubGlobal("setInterval", ((fn: () => void, ms?: number) => {
    const id = realSetInterval(fn, ms);
    cleanups.push(() => clearInterval(id));
    return id;
  }) as typeof setInterval);
  const Real = globalThis.MutationObserver;
  vi.stubGlobal("MutationObserver", class extends Real {
    constructor(callback: MutationCallback) { super(callback); cleanups.push(() => this.disconnect()); }
  });
});
afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length > 0) cleanups.pop()!();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.className = "";
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

const run = (script: string) => new Function(script)();
// Read from the style attribute: the test DOM does not know the property by name, browsers do.
const vtNameOf = (e: HTMLElement): string => /view-transition-name:\s*([^;]+)/.exec(e.getAttribute("style") ?? "")?.[1]?.trim() ?? "";
const names = () => [...document.querySelectorAll<HTMLElement>("[data-vt]")].map(vtNameOf);
const change = () => dispatchEvent(new CustomEvent("so:live", { detail: { room: "workspace", event: "change" } }));

/** A page with the board region and a server answering each fetch with the next fragment in turn. */
function page(before: string, fragments: string[], options: { animate?: boolean } = { animate: true }) {
  document.body.innerHTML = `<div id="board-region">${before}</div><p id="board-region-stamp"></p>`;
  document.documentElement.dataset.live = "1";
  const queue = [...fragments];
  const fetched = vi.fn(async () => ({ ok: true, status: 200, type: "basic", text: async () => queue.shift() ?? fragments[fragments.length - 1]! }));
  vi.stubGlobal("fetch", fetched);
  run(regionScript("board-region", "1", undefined, options));
  return fetched;
}
const region = () => document.getElementById("board-region")!;

test("a clock counts up from its start against the server's now, not the device's", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
  // The server says it is 12:05 — the device is five minutes slow.
  document.body.innerHTML = `<div id="board-region"><div data-now="${Date.parse("2026-10-22T12:05:00.000Z")}"><time data-tick datetime="2026-10-22T12:00:00.000Z">5m</time><time data-tick datetime="2026-10-22T09:55:30.000Z">2h</time></div></div>`;
  run(boardTickScript());
  const [short, long] = [...document.querySelectorAll("time")];
  expect(short!.textContent).toBe("5:00");
  expect(long!.textContent).toBe("2h 09m");
  vi.advanceTimersByTime(3_000);
  expect(short!.textContent).toBe("5:03");
});

test("a clock never runs backwards from a start in the future", () => {
  document.body.innerHTML = `<div id="board-region"><div data-now="${Date.now()}"><time data-tick datetime="${new Date(Date.now() + 60_000).toISOString()}">0m</time></div></div>`;
  run(boardTickScript());
  expect(document.querySelector("time")!.textContent).toBe("0:00");
});

test("a swapped-in clock ticks at once; changes elsewhere on the page and the clocks' own writes do not rescan", async () => {
  document.body.innerHTML = `<div id="board-region"></div><p id="elsewhere"></p>`;
  const scans = vi.spyOn(region(), "querySelectorAll");
  run(boardTickScript());
  region().innerHTML = `<div data-now="${Date.now()}"><time data-tick datetime="${new Date(Date.now() - 125_000).toISOString()}">2m</time></div>`;
  await vi.waitFor(() => expect(document.querySelector("time")!.textContent).toBe("2:05"));
  scans.mockClear();
  document.getElementById("elsewhere")!.textContent = "updated 3s ago";
  document.querySelector("time")!.textContent = "9:99";
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(scans).not.toHaveBeenCalled();
});

test("a hidden tab's clocks do not tick", () => {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="board-region"><div data-now="${Date.now()}"><time data-tick datetime="${new Date(Date.now() - 60_000).toISOString()}">1m</time></div></div>`;
  run(boardTickScript());
  expect(document.querySelector("time")!.textContent).toBe("1:00");
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  try {
    vi.advanceTimersByTime(5_000);
    expect(document.querySelector("time")!.textContent).toBe("1:00");
  } finally { delete (document as unknown as { hidden?: boolean }).hidden; }
});

test("without view transitions the swap is the plain one, and a worker that picked up work flashes once", async () => {
  const tiles = (value: string) => `<div class="worker" data-flash="mac-1" data-flash-value="${value}"></div><div class="worker" data-flash="mac-2" data-flash-value="t-2"></div>`;
  page(tiles(""), [tiles("t-1")]);
  change();
  await vi.waitFor(() => expect(region().querySelector("[data-flash='mac-1']")!.getAttribute("data-flash-value")).toBe("t-1"));
  const [one, two] = [...document.querySelectorAll(".worker")];
  expect(one!.classList.contains("flash")).toBe(true);
  expect(two!.classList.contains("flash")).toBe(false);
});

test("a worker that finished (now holding nothing) does not flash; a region without animate never flashes", async () => {
  const tile = (value: string) => `<div class="worker" data-flash="mac-1" data-flash-value="${value}"></div>`;
  page(tile("t-1"), [tile("")]);
  change();
  await vi.waitFor(() => expect(region().querySelector(".worker")!.getAttribute("data-flash-value")).toBe(""));
  expect(region().querySelector(".worker")!.classList.contains("flash")).toBe(false);
  while (cleanups.length > 0) cleanups.pop()!();
  page(tile(""), [tile("t-1")], {});
  change();
  await vi.waitFor(() => expect(region().querySelector(".worker")!.getAttribute("data-flash-value")).toBe("t-1"));
  expect(region().querySelector(".worker")!.classList.contains("flash")).toBe(false);
});

/** A view transition that runs its update later and finishes when told — the browser's real shape. */
function deferredTransitions() {
  const started: { finish: () => void; namesBefore: string[] }[] = [];
  (document as unknown as { startViewTransition: unknown }).startViewTransition = (update: () => void) => {
    let finish: () => void = () => {};
    const finished = new Promise<void>(resolve => { finish = resolve; });
    started.push({ finish, namesBefore: names() });
    setTimeout(update, 0);
    return { finished };
  };
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  return started;
}

test("each card is named for the swap by its whole key, the same task keeps its name, and names clear after", async () => {
  const started = deferredTransitions();
  page(`<a data-vt="t-1"></a><a data-vt="owner/repo#2"></a>`, [`<a data-vt="owner/repo#2"></a><a data-vt="t-1"></a>`]);
  change();
  await vi.waitFor(() => expect(started).toHaveLength(1));
  const before = started[0]!.namesBefore;
  expect(before.every(name => /^so-c[0-9a-f]+$/.test(name))).toBe(true);
  await vi.waitFor(() => expect(region().firstElementChild!.getAttribute("data-vt")).toBe("owner/repo#2"));
  // The same task keeps the same name across the swap — that is what makes it slide.
  expect(names()).toEqual([before[1], before[0]]);
  expect(document.documentElement.classList.contains("so-swap")).toBe(true);
  started[0]!.finish();
  await vi.waitFor(() => expect(document.documentElement.classList.contains("so-swap")).toBe(false));
  expect(names()).toEqual(["", ""]);
});

test("two keys a short hash would confuse get different names", async () => {
  const started = deferredTransitions();
  page(`<a data-vt="t-aa2"></a><a data-vt="t-acp"></a>`, [`<a data-vt="t-acp"></a>`]);
  change();
  await vi.waitFor(() => expect(started).toHaveLength(1));
  const [a, b] = started[0]!.namesBefore;
  expect(a).not.toBe("");
  expect(b).not.toBe("");
  expect(a).not.toBe(b);
});

test("a change during a transition waits for it: one transition at a time, and the first's cleanup never ends the second", async () => {
  const started = deferredTransitions();
  const fetched = page(`<a data-vt="t-1"></a>`, [`<a data-vt="t-1" class="one"></a>`, `<a data-vt="t-1" class="two"></a>`]);
  change();
  await vi.waitFor(() => expect(started).toHaveLength(1));
  change();
  await new Promise(resolve => setTimeout(resolve, 20));
  // The second fetch is not even made while the first transition runs.
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(started).toHaveLength(1);
  started[0]!.finish();
  await vi.waitFor(() => expect(started).toHaveLength(2));
  await vi.waitFor(() => expect(region().querySelector("a")!.className).toBe("two"));
  expect(document.documentElement.classList.contains("so-swap")).toBe(true);
  expect(names()).not.toEqual([""]);
  started[1]!.finish();
  await vi.waitFor(() => expect(document.documentElement.classList.contains("so-swap")).toBe(false));
});

test("under reduced motion the swap never starts a transition", async () => {
  const start = vi.fn();
  (document as unknown as { startViewTransition: unknown }).startViewTransition = start;
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  page(`<a data-vt="t-1"></a>`, [`<a data-vt="t-1" class="x"></a>`]);
  change();
  await vi.waitFor(() => expect(region().querySelector("a")!.className).toBe("x"));
  expect(start).not.toHaveBeenCalled();
});

test("a focused worker link keeps focus through a swap — not the lane card with the same address", async () => {
  const body = (word: string) => `<a class="worker-job" href="/t/t-1/run/3">${word}</a><a class="lane-card" href="/t/t-1/run/3">c</a>`;
  page(body("w"), [body("w2")], {});
  region().querySelector<HTMLElement>("a.worker-job")!.focus();
  change();
  await vi.waitFor(() => expect(region().querySelector("a.worker-job")!.textContent).toBe("w2"));
  expect(document.activeElement).toBe(region().querySelector("a.worker-job"));
});
