// @vitest-environment happy-dom
/** The live board in the page: clocks tick from the server's now, and a swap flashes a worker whose builds changed —
 * with the plain instant swap wherever view transitions are missing or motion is reduced. */
import { afterEach, expect, test, vi } from "vitest";
import { boardTickScript, regionScript } from "../server/chrome.js";

const run = (script: string) => new Function(script)();
// Read from the style attribute: the test DOM does not know the property by name, browsers do.
const vtNameOf = (e: HTMLElement): string => /view-transition-name:\s*([^;]+)/.exec(e.getAttribute("style") ?? "")?.[1]?.trim() ?? "";
afterEach(() => { document.body.innerHTML = ""; vi.useRealTimers(); vi.unstubAllGlobals(); });

test("a clock counts up from its start against the server's now, not the device's", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
  // The server says it is 12:05 — the device is five minutes slow.
  document.body.innerHTML = `<div data-now="${Date.parse("2026-10-22T12:05:00.000Z")}"><time data-tick datetime="2026-10-22T12:00:00.000Z">5m</time><time data-tick datetime="2026-10-22T09:55:30.000Z">2h</time></div>`;
  run(boardTickScript());
  const [short, long] = [...document.querySelectorAll("time")];
  expect(short!.textContent).toBe("5:00");
  expect(long!.textContent).toBe("2h 09m");
  vi.advanceTimersByTime(3_000);
  expect(short!.textContent).toBe("5:03");
});

test("a clock never runs backwards from a start in the future", () => {
  document.body.innerHTML = `<div data-now="${Date.now()}"><time data-tick datetime="${new Date(Date.now() + 60_000).toISOString()}">0m</time></div>`;
  run(boardTickScript());
  expect(document.querySelector("time")!.textContent).toBe("0:00");
});

async function swapOnce(before: string, after: string, script: string) {
  document.body.innerHTML = `<div id="board-region">${before}</div><p id="board-region-stamp"></p>`;
  document.documentElement.dataset.live = "1";
  const fetched = vi.fn(async () => ({ ok: true, status: 200, type: "basic", text: async () => after }));
  vi.stubGlobal("fetch", fetched);
  run(script);
  dispatchEvent(new CustomEvent("so:live", { detail: { room: "workspace", event: "change" } }));
  await vi.waitFor(() => expect(fetched).toHaveBeenCalled());
  // The swap may add a class or a name of its own; what matters is that the fetched markup is what the region holds.
  const plain = () => document.getElementById("board-region")!.innerHTML.replace(/ class="flash"| flash(?=")| style="[^"]*"/g, "");
  await vi.waitFor(() => expect(plain()).toBe(after));
}

test("without view transitions the swap is the plain one, and a worker that picked up work flashes once", async () => {
  const tile = (value: string) => `<div class="worker" data-flash="mac-1" data-flash-value="${value}"></div><div class="worker" data-flash="mac-2" data-flash-value="t-2"></div>`;
  await swapOnce(tile(""), tile("t-1"), regionScript("board-region", "1", undefined, { animate: true }));
  const [one, two] = [...document.querySelectorAll(".worker")];
  expect(one!.classList.contains("flash")).toBe(true);
  expect(two!.classList.contains("flash")).toBe(false);
});

test("a worker that finished (now holding nothing) does not flash; a region without animate never flashes", async () => {
  const tile = (value: string) => `<div class="worker" data-flash="mac-1" data-flash-value="${value}"></div>`;
  await swapOnce(tile("t-1"), tile(""), regionScript("board-region", "1", undefined, { animate: true }));
  expect(document.querySelector(".worker")!.classList.contains("flash")).toBe(false);
  await swapOnce(tile(""), tile("t-1"), regionScript("board-region", "1"));
  expect(document.querySelector(".worker")!.classList.contains("flash")).toBe(false);
});

test("with view transitions the cards are named for the swap only, by a hash of their key, and the names are cleared after", async () => {
  const seen: string[][] = [];
  let finish: () => void = () => {};
  const finished = new Promise<void>(resolve => { finish = resolve; });
  (document as unknown as { startViewTransition: unknown }).startViewTransition = (update: () => void) => {
    seen.push([...document.querySelectorAll<HTMLElement>("[data-vt]")].map(vtNameOf));
    update();
    seen.push([...document.querySelectorAll<HTMLElement>("[data-vt]")].map(vtNameOf));
    return { finished };
  };
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  try {
    await swapOnce(`<a data-vt="t-1"></a><a data-vt="owner/repo#2"></a>`, `<a data-vt="owner/repo#2"></a><a data-vt="t-1"></a>`,
      regionScript("board-region", "1", undefined, { animate: true }));
    // Earlier tests' regions still listen on this window; the last transition is this region's.
    const [old, fresh] = seen.slice(-2);
    expect(old!.every(name => /^so-c[0-9a-z]+$/.test(name))).toBe(true);
    expect(new Set(old).size).toBe(2);
    // The same task keeps the same name across the swap — that is what makes it slide.
    expect(fresh).toEqual([old![1], old![0]]);
    expect(document.documentElement.classList.contains("so-swap")).toBe(true);
    finish();
    await vi.waitFor(() => expect(document.documentElement.classList.contains("so-swap")).toBe(false));
    expect([...document.querySelectorAll<HTMLElement>("[data-vt]")].map(vtNameOf)).toEqual(["", ""]);
  } finally { delete (document as unknown as { startViewTransition?: unknown }).startViewTransition; }
});

test("under reduced motion the swap never starts a transition", async () => {
  const start = vi.fn();
  (document as unknown as { startViewTransition: unknown }).startViewTransition = start;
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  try {
    await swapOnce(`<a data-vt="t-1"></a>`, `<a data-vt="t-1" class="x"></a>`, regionScript("board-region", "1", undefined, { animate: true }));
    expect(start).not.toHaveBeenCalled();
  } finally { delete (document as unknown as { startViewTransition?: unknown }).startViewTransition; }
});

test("a swapped-in clock ticks at once, and the clocks' own writes do not keep the observer busy", async () => {
  document.body.innerHTML = `<div id="r" data-now="${Date.now()}"></div>`;
  run(boardTickScript());
  const writes = vi.fn();
  document.getElementById("r")!.innerHTML = `<time data-tick datetime="${new Date(Date.now() - 125_000).toISOString()}">2m</time>`;
  await vi.waitFor(() => expect(document.querySelector("time")!.textContent).toBe("2:05"));
  new MutationObserver(writes).observe(document.body, { childList: true, subtree: true, characterData: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(writes).not.toHaveBeenCalled();
});
