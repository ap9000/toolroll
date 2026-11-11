// @vitest-environment happy-dom
/**
 * A server-drawn region kept current, in both forms a page can get it (docs/plans/task-page-in-app.md §5): the page
 * script string a document ships (`regionScript`, its workspace-page arm) and the app's version (`regionWork`). One table
 * runs against both. The cases below it are the app's alone: its lifetime, the region it binds to, sign-in.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { regionScript } from "../../server/chrome.js";
import type { LiveListener } from "../live.js";
import { regionWork, type RegionEntry } from "./region.js";

type Answer = { ok: boolean; status: number; type: string; text: () => Promise<string> };
type Call = { url: string; init: RequestInit; land(answer: Answer): void; fail(): void };
const text = (body: string): Answer => ({ ok: true, status: 200, type: "basic", text: () => Promise.resolve(body) });
const refused = (status: number, type = "basic"): Answer => ({ ok: false, status, type, text: () => Promise.resolve("<p>Sign in</p>") });
const flush = async (): Promise<void> => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

/** A fetch whose answers the case lands when it chooses. */
function desk() {
  const calls: Call[] = [];
  const fetcher = (url: string, init: RequestInit): Promise<Answer> => new Promise((resolve, reject) => { calls.push({ url, init, land: resolve, fail: () => reject(new Error("offline")) }); });
  return { calls, fetcher };
}

const PAGE = (inner = "first") => `<div id="standing-orders-workspace"><div id="check-progress">${inner}</div><p id="check-progress-stamp"></p></div>`;
const region = () => document.getElementById("check-progress");
const stamp = () => document.getElementById("check-progress-stamp")?.textContent ?? null;

type Started = { hint(event: string): void; stop(): void; loads: string[] | null; left: () => number | null };
type Form = { name: string; start(fetcher: ReturnType<typeof desk>["fetcher"]): Started };

const asString: Form = {
  name: "the page script string",
  start(fetcher) {
    vi.stubGlobal("fetch", fetcher);
    // The string's listeners live as long as the document: keep hold of them, so one case cannot read for the next.
    const added: [string, EventListenerOrEventListenerObject][] = [];
    const holder = globalThis as unknown as { addEventListener: typeof window.addEventListener };
    const add = holder.addEventListener;
    holder.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => { added.push([type, listener]); add.call(window, type, listener); }) as typeof window.addEventListener;
    try { new Function(regionScript("check-progress", "check", "/r/7"))(); } finally { holder.addEventListener = add; }
    return {
      hint: event => { window.dispatchEvent(new CustomEvent("so:live", { detail: { room: "workspace", event } })); },
      stop: () => { for (const [type, listener] of added) window.removeEventListener(type, listener); delete (window as unknown as { __soLiveRooms?: unknown }).__soLiveRooms; },
      loads: null, left: () => null,
    };
  },
};
const asApp: Form = {
  name: "the app",
  start(fetcher) {
    const loads: string[] = [];
    const heard: LiveListener[] = [];
    let left = 0;
    const page = new AbortController();
    regionWork({ kind: "region", region: "check-progress", run: 7 }, page.signal, {
      fetch: fetcher as unknown as typeof fetch, load: href => { loads.push(href); }, now: () => Date.now(),
      join: (room, listener) => { expect(room).toBe("workspace"); heard.push(listener); return () => { left += 1; heard.splice(heard.indexOf(listener), 1); }; },
    });
    return { hint: event => { for (const one of [...heard]) one(event as Parameters<LiveListener>[0], {}); }, stop: () => page.abort(), loads, left: () => left };
  },
};

let running: Started | null = null;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { running?.stop(); running = null; vi.clearAllTimers(); vi.useRealTimers(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

describe.each([asString, asApp])("a region kept current on a workspace page: $name", form => {
  const begin = (page = PAGE()) => {
    document.body.innerHTML = page;
    const { calls, fetcher } = desk();
    running = form.start(fetcher);
    return { calls, page: running };
  };

  test("nothing is read at the start or on a timer", async () => {
    const { calls } = begin();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toEqual([]);
    expect(region()?.textContent).toBe("first");
  });

  test("a change reads the build's own fragment once and swaps it in; the stamp says how old it is", async () => {
    const { calls, page } = begin();
    page.hint("change");
    expect(calls.map(one => one.url)).toEqual(["/r/7?fragment=check"]);
    expect(calls[0]?.init).toMatchObject({ redirect: "manual", cache: "no-store" });
    calls[0]!.land(text(`<p class="meta">unit 12/18</p>`));
    await flush();
    expect(region()?.innerHTML).toBe(`<p class="meta">unit 12/18</p>`);
    expect(stamp()).toBe("updated 0s ago");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(stamp()).toBe("updated 3s ago");
    // A reload hint reads too; any other event does not.
    page.hint("presence");
    expect(calls.length).toBe(1);
    page.hint("reload");
    expect(calls.length).toBe(2);
  });

  test("changes that arrive during a read make exactly one more", async () => {
    const { calls, page } = begin();
    page.hint("change");
    page.hint("change");
    page.hint("change");
    page.hint("change");
    expect(calls.length).toBe(1);
    calls[0]!.land(text("second"));
    await flush();
    expect(calls.length).toBe(2);
    calls[1]!.land(text("third"));
    await flush();
    expect(calls.length).toBe(2);
    expect(region()?.textContent).toBe("third");
  });

  test("a read that fails keeps what is shown and says it is stale", async () => {
    const { calls, page } = begin();
    page.hint("change");
    calls[0]!.land(refused(500));
    await flush();
    expect(region()?.textContent).toBe("first");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stamp()).toBe("stale — retrying (2s old)");
    // The network going away reads the same; the next good read clears it.
    page.hint("change");
    calls[1]!.fail();
    await flush();
    expect(region()?.textContent).toBe("first");
    expect(stamp()).toMatch(/^stale — retrying \(\d+s old\)$/);
    page.hint("change");
    calls[2]!.land(text("back"));
    await flush();
    expect(region()?.textContent).toBe("back");
    expect(stamp()).toBe("updated 0s ago");
  });

  test("a fragment that says it is final stops the reads and clears the stamp", async () => {
    const { calls, page } = begin();
    page.hint("change");
    calls[0]!.land(text(`<p data-region-stop>Checks passed</p>`));
    await flush();
    expect(region()?.textContent).toBe("Checks passed");
    expect(stamp()).toBe("");
    page.hint("change");
    page.hint("reload");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.length).toBe(1);
    expect(stamp()).toBe("");
  });

  test("the row a person holds keeps the keyboard through a swap", async () => {
    const rows = (word: string) => `<a class="row" href="/t/one">${word} one</a><a class="row" href="/t/two">${word} two</a>`;
    const { calls, page } = begin(PAGE(rows("old")));
    document.querySelector<HTMLElement>('a.row[href="/t/two"]')!.focus();
    page.hint("change");
    calls[0]!.land(text(rows("new")));
    await flush();
    expect(document.activeElement?.textContent).toBe("new two");
  });

  test("a page without the region reads nothing", async () => {
    const { calls, page } = begin(`<div id="standing-orders-workspace"><p>No build is running</p></div>`);
    page.hint("change");
    await flush();
    expect(calls).toEqual([]);
  });
});

describe("the app's region lasts only as long as its page, and reads only its own build", () => {
  const begin = (entry: RegionEntry, page: string) => {
    document.body.innerHTML = page;
    const { calls, fetcher } = desk();
    const loads: string[] = [];
    const heard: LiveListener[] = [];
    let left = 0;
    const control = new AbortController();
    regionWork(entry, control.signal, { fetch: fetcher as unknown as typeof fetch, load: href => { loads.push(href); }, now: () => Date.now(),
      join: (_room, listener) => { heard.push(listener); return () => { left += 1; heard.splice(heard.indexOf(listener), 1); }; } });
    const started: Started = { hint: event => { for (const one of [...heard]) one(event as Parameters<LiveListener>[0], {}); }, stop: () => control.abort(), loads, left: () => left };
    running = started;
    return { calls, loads, control, hint: started.hint, joined: () => heard.length, left: () => left };
  };
  const check: RegionEntry = { kind: "region", region: "check-progress", run: 7 };
  const peek = (run: number): RegionEntry => ({ kind: "region", region: "run-peek", run });
  const PEEK = (run: number) => `<div class="card attempt-live" data-live-run="${run}"><div id="run-peek">watching</div><p id="run-peek-stamp"></p></div>`;

  test.each([[401, "basic"], [403, "basic"], [0, "opaqueredirect"]])("a refusal (%i %s) loads the sign-in page as a document and never draws it in the region", async (status, type) => {
    const { calls, loads, hint } = begin(check, PAGE());
    hint("change");
    calls[0]!.land(refused(status, type));
    await flush();
    expect(loads).toEqual(["/login"]);
    expect(region()?.textContent).toBe("first");
  });

  test("replaced: it leaves the room, stops its clock, and reads nothing more", async () => {
    const { calls, control, hint, joined, left } = begin(check, PAGE());
    hint("change");
    calls[0]!.land(text("second"));
    await flush();
    expect(stamp()).toBe("updated 0s ago");
    control.abort();
    expect(left()).toBe(1);
    expect(joined()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stamp()).toBe("updated 0s ago");
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new Event("standing-orders:workspace-rendered"));
    expect(calls.length).toBe(1);
  });

  test("an answer still under way when the page is replaced writes nothing and loads nothing", async () => {
    const one = begin(check, PAGE());
    one.hint("change");
    one.hint("change");
    one.control.abort();
    // The next page has a region of the same name.
    document.body.innerHTML = PAGE("the next page");
    one.calls[0]!.land(text("late"));
    await flush();
    expect(region()?.textContent).toBe("the next page");
    expect(stamp()).toBe("");
    expect(one.calls.length).toBe(1);
    // A late refusal is dropped as well: the next page is not sent to sign in by the last one's read.
    const two = begin(check, PAGE());
    two.hint("change");
    two.control.abort();
    two.calls[0]!.land(refused(401));
    await flush();
    expect(two.loads).toEqual([]);
  });

  test("a region that was replaced on the same page gets no late answer, and the next change reads into the one there now", async () => {
    const { calls, hint } = begin(check, PAGE());
    hint("change");
    const old = region()!;
    document.body.innerHTML = PAGE("drawn again");
    window.dispatchEvent(new Event("standing-orders:workspace-rendered"));
    calls[0]!.land(text("late"));
    await flush();
    expect(old.textContent).toBe("first");
    expect(region()?.textContent).toBe("drawn again");
    hint("change");
    calls[1]!.land(text("current"));
    await flush();
    expect(region()?.textContent).toBe("current");
    expect(stamp()).toBe("updated 0s ago");
  });

  test("a region drawn after the start is read on the next change", async () => {
    const { calls, hint } = begin(check, `<div id="standing-orders-workspace"></div>`);
    hint("change");
    expect(calls).toEqual([]);
    document.body.innerHTML = PAGE();
    window.dispatchEvent(new Event("standing-orders:workspace-rendered"));
    hint("change");
    expect(calls.map(one => one.url)).toEqual(["/r/7?fragment=check"]);
  });

  test("the peek reads only inside the card of its own build", async () => {
    const stale = begin(peek(7), PEEK(8));
    stale.hint("change");
    expect(stale.calls).toEqual([]);
    stale.control.abort();
    const mine = begin(peek(8), PEEK(8));
    mine.hint("change");
    expect(mine.calls.map(one => one.url)).toEqual(["/r/8?fragment=peek"]);
    mine.calls[0]!.land(text("src/limiter.ts"));
    await flush();
    expect(document.getElementById("run-peek")?.textContent).toBe("src/limiter.ts");
    expect(document.getElementById("run-peek-stamp")?.textContent).toBe("updated 0s ago");
  });

  test.each([0, -3, 1.5, Number.NaN])("a build number that is not one (%s) starts nothing", run => {
    const { hint, joined, calls } = begin({ kind: "region", region: "check-progress", run }, PAGE());
    expect(joined()).toBe(0);
    hint("change");
    expect(calls).toEqual([]);
  });

  test("a region name the app does not know starts nothing", () => {
    const { joined } = begin({ kind: "region", region: "board-region", run: 7 } as unknown as RegionEntry, PAGE());
    expect(joined()).toBe(0);
  });
});
