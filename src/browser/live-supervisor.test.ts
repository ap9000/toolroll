// @vitest-environment happy-dom
/** The page's supervised live stream (browser/live-supervisor.ts, and LiveHub's stream reader in browser/live.ts): one
 * owner for every retry, backoff with jitter capped at a minute, a retired stream never speaks, wakeups retry at once,
 * a hidden tab lets its watching rooms go at once and its stream go after the grace, and the back/forward cache closes
 * and reopens it. A fake clock (vitest timers) and a fake fetch whose streams the test writes. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { backoffDelay, LIVE_BACKOFF_CAP_MS, LIVE_FRAMES_HEADER, LIVE_HIDDEN_GRACE_MS, LiveSupervisor, SseParser, type LiveConnectionState, type SupervisorDeps } from "./live-supervisor.js";
import { LiveHub, type LiveEventName } from "./live.js";

/** One request the page made: what it asked for, and its stream, which the test writes, ends or breaks. */
type Call = { url: string; init: RequestInit; aborted: boolean; write: (text: string) => void; end: () => void; fail: () => void };

/** A server the page reads: `up` answers with a stream, `down` refuses the connection, a number answers that status. */
function fakeServer() {
  const calls: Call[] = [];
  const server = { mode: "up" as "up" | "down" | number, calls, ignoreAbort: false, bodyless: false };
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const call: Call = { url, init, aborted: false,
      write: text => { try { controller.enqueue(encoder.encode(text)); } catch { /* closed */ } },
      end: () => { try { controller.close(); } catch { /* closed */ } },
      fail: () => { try { controller.error(new TypeError("network")); } catch { /* closed */ } } };
    calls.push(call);
    init.signal?.addEventListener("abort", () => { call.aborted = true; if (!server.ignoreAbort) call.fail(); });
    if (server.mode === "down") return Promise.reject(new TypeError("Failed to fetch"));
    if (typeof server.mode === "number") return Promise.resolve(new Response("{}", { status: server.mode, headers: { "content-type": "application/json" } }));
    if (server.bodyless) return Promise.resolve(new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
  };
  return { server, fetch };
}

const frame = (event: string, data: Record<string, unknown> = {}) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const settle = () => vi.advanceTimersByTimeAsync(0);

function supervised(options: { random?: number; online?: () => boolean } = {}) {
  const { server, fetch } = fakeServer();
  const seen: { frames: [string, string][]; trouble: string[]; states: LiveConnectionState[]; opened: string[]; unusable: number } = { frames: [], trouble: [], states: [], opened: [], unusable: 0 };
  const deps: SupervisorDeps = {
    fetch, now: () => Date.now(), random: () => options.random ?? 0,
    setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
    setInterval: (run, ms) => setInterval(run, ms), clearInterval: id => clearInterval(id as ReturnType<typeof setInterval>),
    online: options.online ?? (() => true),
  };
  const supervisor = new LiveSupervisor(deps, {
    opened: url => seen.opened.push(url), frame: (event, data) => seen.frames.push([event, data]),
    trouble: kind => seen.trouble.push(kind), state: state => seen.states.push(state), unusable: () => { seen.unusable += 1; },
  });
  return { supervisor, server, seen };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("backoff", () => {
  test("each wait is within [c/2, c] for c = min(60 s, 1 s·2^(n+1)), and never past the cap", () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const ceiling = Math.min(LIVE_BACKOFF_CAP_MS, 1_000 * 2 ** (attempt + 1));
      expect(backoffDelay(attempt, 0)).toBe(ceiling / 2);
      expect(backoffDelay(attempt, 0.999_999)).toBeLessThanOrEqual(ceiling);
      expect(backoffDelay(attempt, 0.999_999)).toBeGreaterThan(ceiling * 0.99);
    }
    expect(backoffDelay(Number.POSITIVE_INFINITY, 0.999_999)).toBeLessThanOrEqual(LIVE_BACKOFF_CAP_MS);
    expect(LIVE_BACKOFF_CAP_MS).toBe(60_000);
  });

  test("a server that stays down is tried at the backoff's times, one attempt each, saying `retrying` once", async () => {
    const { supervisor, server, seen } = supervised({ random: 0 });
    server.mode = "down";
    supervisor.want("/live?room=workspace");
    await settle();
    const gaps: number[] = [];
    let last = Date.now();
    for (let tried = 1; tried < 8; tried += 1) {
      while (server.calls.length === tried) await vi.advanceTimersByTimeAsync(250);
      gaps.push(Date.now() - last);
      last = Date.now();
    }
    // random 0: c/2 each time — 1, 2, 4, 8, 16, then the cap's half.
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(seen.trouble).toEqual(["retrying"]);
    expect(supervisor.state).toBe("reconnecting");
  });

  test("a stream that stayed up 30 s starts the count again; a shorter one doesn't", async () => {
    const { supervisor, server } = supervised({ random: 0 });
    server.mode = "down";
    supervisor.want("/live?room=workspace");
    await settle();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000); // three failures: the next wait would be 8 s
    server.mode = "up";
    await vi.advanceTimersByTimeAsync(8_000);
    expect(supervisor.state).toBe("live");
    // Up 31 s, with ticks: then it drops.
    for (let at = 0; at < 31; at += 1) { server.calls.at(-1)!.write(frame("tick")); await vi.advanceTimersByTimeAsync(1_000); }
    const before = server.calls.length;
    server.calls.at(-1)!.end();
    await settle();
    await vi.advanceTimersByTimeAsync(999);
    expect(server.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls.length).toBe(before + 1);
    // Up only 5 s this time: the next drop waits longer (the second retry's 2 s).
    await vi.advanceTimersByTimeAsync(5_000);
    server.calls.at(-1)!.end();
    await settle();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(server.calls.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls.length).toBe(before + 2);
  });
});

describe("epochs", () => {
  test("a replaced stream is aborted first, and whatever it still says afterwards is dropped", async () => {
    const { supervisor, server, seen } = supervised();
    server.ignoreAbort = true; // a stubborn stream that keeps talking after its abort
    supervisor.want("/live?room=task%3A1");
    await settle();
    const first = server.calls[0]!;
    first.write(frame("change", { room: "task:1" }));
    await settle();
    supervisor.want("/live?room=task%3A2");
    await settle();
    expect(first.aborted).toBe(true);
    expect(server.calls).toHaveLength(2);
    first.write(frame("change", { room: "task:1", late: true }));
    first.end();
    await settle();
    server.calls[1]!.write(frame("change", { room: "task:2" }));
    await settle();
    expect(seen.frames.map(([event, data]) => [event, JSON.parse(data)])).toEqual([["change", { room: "task:1" }], ["change", { room: "task:2" }]]);
    // The old stream's end was not a drop: nothing retried, nothing said.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.calls).toHaveLength(2);
    expect(seen.trouble).toEqual([]);
  });

  test("an answer that arrives for a retired attempt opens nothing", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=task%3A1");
    supervisor.want("/live?room=task%3A2");
    await settle();
    expect(seen.opened).toEqual(["/live?room=task%3A2"]);
    expect(server.calls[0]!.aborted).toBe(true);
  });

  test("one request at a time, asking for frames, cookie only, never cached", async () => {
    const { supervisor, server } = supervised();
    supervisor.want("/live?room=workspace");
    await settle();
    const init = server.calls[0]!.init;
    expect(init.headers).toMatchObject({ accept: "text/event-stream", [LIVE_FRAMES_HEADER]: "1" });
    expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "manual" });
  });
});

describe("frames", () => {
  test("hello and tick only prove the stream; room frames pass through, split however they arrive", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=workspace");
    await settle();
    const call = server.calls[0]!;
    call.write(frame("hello", { incarnation: "abc", tick: 15_000 }) + frame("tick") + "event: chan");
    call.write(`ge\ndata: {"room":"workspace"}\n`);
    call.write("\n: a comment\n\n");
    await settle();
    expect(seen.frames).toEqual([["change", '{"room":"workspace"}']]);
  });

  test("the parser follows the event-stream format: CRLF, multi-line data, comments, a default name", () => {
    const parser = new SseParser();
    expect(parser.push("event: a\r\ndata: 1\r\ndata: 2\r")).toEqual([]);
    expect(parser.push("\n\r\n:note\n\ndata:x\n\nevent: empty\n\n")).toEqual([{ event: "a", data: "1\n2" }, { event: "message", data: "x" }]);
  });
});

describe("refusals and outages", () => {
  test.each([["a 401", 401], ["a 403", 403]] as const)("%s means signed out: `lost` once, then nothing before about the cap, or a wakeup", async (_name, status) => {
    const { supervisor, server, seen } = supervised({ random: 0 });
    server.mode = status;
    supervisor.want("/live?room=workspace");
    await settle();
    expect(seen.trouble).toEqual(["lost"]);
    expect(supervisor.state).toBe("signed-out");
    // Rooms come and go as the page hears it: none of that knocks again.
    supervisor.want("/live?room=chat");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls.map(one => one.url)).toEqual(["/live?room=workspace", "/live?room=chat"]);
    expect(seen.trouble).toEqual(["lost"]);
    // A wakeup (a sign-in in another tab, the tab shown) tries now.
    await vi.advanceTimersByTimeAsync(1_000);
    supervisor.wake();
    expect(server.calls).toHaveLength(3);
  });

  test("the server's `ended` (every room refused) is a refusal too", async () => {
    const { supervisor, server, seen } = supervised({ random: 0 });
    supervisor.want("/live?room=workspace");
    await settle();
    server.calls[0]!.write(frame("gone", { room: "workspace" }) + frame("ended"));
    await settle();
    expect(seen.frames.map(([event]) => event)).toEqual(["gone"]);
    expect(seen.trouble).toEqual(["lost"]);
    expect(supervisor.state).toBe("signed-out");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(server.calls).toHaveLength(1);
  });

  test("an error answer is `lost` and retried with backoff; a dropped line is `retrying`; back up, both reset", async () => {
    const { supervisor, server, seen } = supervised({ random: 0 });
    server.mode = 500;
    supervisor.want("/live?room=workspace");
    await settle();
    expect(seen.trouble).toEqual(["lost"]);
    server.mode = "up";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(supervisor.state).toBe("live");
    server.calls.at(-1)!.fail();
    await settle();
    expect(seen.trouble).toEqual(["lost", "retrying"]);
    expect(supervisor.state).toBe("reconnecting");
  });

  test("offline: the slow wait, but a wakeup still tries (offline is often wrong for this computer's address)", async () => {
    let online = false;
    const { supervisor, server } = supervised({ random: 0, online: () => online });
    server.mode = "down";
    supervisor.want("/live?room=workspace");
    await settle();
    expect(supervisor.state).toBe("offline");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(server.calls).toHaveLength(1);
    online = true;
    server.mode = "up";
    supervisor.wake();
    await settle();
    expect(server.calls).toHaveLength(2);
    expect(supervisor.state).toBe("live");
  });

  test("going offline tries the open stream again at once, so a dead one shows as offline straight away", async () => {
    let online = true;
    const { supervisor, server } = supervised({ online: () => online });
    supervisor.want("/live?room=workspace");
    await settle();
    online = false;
    server.mode = "down";
    supervisor.offline();
    await settle();
    expect(server.calls).toHaveLength(2);
    expect(supervisor.state).toBe("offline");
  });

  test("a fetch that can't stream here hands the page back to EventSource", async () => {
    const { supervisor, server, seen } = supervised();
    server.bodyless = true;
    supervisor.want("/live?room=workspace");
    await settle();
    expect(seen.unusable).toBe(1);
  });
});

describe("wakeups", () => {
  test("a wakeup fires a pending retry at once; two together make one attempt", async () => {
    const { supervisor, server } = supervised({ random: 0 });
    server.mode = "down";
    supervisor.want("/live?room=workspace");
    await settle();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(server.calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_500);
    supervisor.wake();
    supervisor.wake();
    expect(server.calls).toHaveLength(5);
    // A wakeup right after that attempt isn't lost: it brings the retry forward to the end of the spacing.
    await vi.advanceTimersByTimeAsync(200);
    supervisor.wake();
    expect(server.calls).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(800);
    expect(server.calls).toHaveLength(6);
  });

  test("with a stream open, a wakeup replaces it only if it missed its tick", async () => {
    const { supervisor, server } = supervised();
    supervisor.want("/live?room=workspace");
    await settle();
    server.calls[0]!.write(frame("hello", { incarnation: "a", tick: 15_000 }));
    await vi.advanceTimersByTimeAsync(10_000);
    server.calls[0]!.write(frame("tick"));
    await settle();
    supervisor.wake();
    expect(server.calls).toHaveLength(1);
    // Asleep through more than a tick and its margin: the socket is probably gone.
    vi.setSystemTime(Date.now() + 21_000);
    supervisor.wake();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0]!.aborted).toBe(true);
  });

  test("a stream silent for two ticks and a margin is replaced, with no wakeup at all", async () => {
    const { supervisor, server } = supervised();
    supervisor.want("/live?room=workspace");
    await settle();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.calls).toHaveLength(2);
  });

  test("a timer gap (the device slept) is a wakeup", async () => {
    const { supervisor, server } = supervised({ random: 0 });
    server.mode = "down";
    supervisor.want("/live?room=workspace");
    await settle();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 1_500);
    expect(server.calls).toHaveLength(4);
    // The clock jumps 10 s between two beats, with the 8 s retry still pending.
    vi.setSystemTime(Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.calls).toHaveLength(5);
  });
});

describe("back/forward cache", () => {
  test("pagehide closes the stream and stops retrying; a page restored from the cache opens it again", async () => {
    const { supervisor, server } = supervised();
    supervisor.want("/live?room=workspace");
    await settle();
    supervisor.suspend();
    expect(server.calls[0]!.aborted).toBe(true);
    supervisor.want("/live?room=chat");
    await settle();
    expect(server.calls).toHaveLength(1);
    supervisor.resume();
    await settle();
    expect(server.calls.map(one => one.url)).toEqual(["/live?room=workspace", "/live?room=chat"]);
    expect(supervisor.state).toBe("live");
  });
});

/** LiveHub on the stream reader: the room rules over the supervisor. */
describe("the page's hub", () => {
  let hidden = false;
  beforeEach(() => {
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const setHidden = async (on: boolean) => { hidden = on; document.dispatchEvent(new Event("visibilitychange")); await flush(); };
  const hubWith = () => {
    const { server, fetch } = fakeServer();
    const hub = new LiveHub({ reader: "stream", deps: { fetch, random: () => 0 } });
    return { hub, server };
  };

  test("hidden: watching rooms leave at once, observational ones stay through the grace, then the stream closes; shown, all return", async () => {
    const { hub, server } = hubWith();
    hub.subscribe("summary", () => {}, true);
    hub.subscribe("workspace", () => {});
    hub.subscribe("task:7", () => {});
    await flush();
    expect(server.calls.map(one => one.url)).toEqual(["/live?room=summary&room=task%3A7&room=workspace"]);
    await setHidden(true);
    expect(server.calls[0]!.aborted).toBe(true);
    expect(server.calls.map(one => one.url).at(-1)).toBe("/live?room=summary&room=workspace");
    // The server ticks every 15 s meanwhile.
    for (let at = 0; at < 4; at += 1) { server.calls[1]!.write(frame("tick")); await vi.advanceTimersByTimeAsync(at < 3 ? 15_000 : 14_999); }
    expect(server.calls[1]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls[1]!.aborted).toBe(true);
    expect(server.calls).toHaveLength(2);
    expect(hub.connectionState()).toBe("idle");
    await setHidden(false);
    expect(server.calls.map(one => one.url).at(-1)).toBe("/live?room=summary&room=task%3A7&room=workspace");
    expect(hub.connectionState()).toBe("live");
  });

  test.each(["task:7", "flow:3", "agent:9", "agents-live"])("a hidden tab never keeps %s, even if its part asks to stay", async room => {
    const { hub, server } = hubWith();
    hub.subscribe(room, () => {}, true);
    await flush();
    await setHidden(true);
    expect(server.calls[0]!.aborted).toBe(true);
    expect(server.calls).toHaveLength(1);
  });

  test("a page of observational rooms keeps its one stream through a short hide", async () => {
    const { hub, server } = hubWith();
    hub.subscribe("workspace", () => {});
    hub.subscribe("chat", () => {});
    await flush();
    await setHidden(true);
    await vi.advanceTimersByTimeAsync(20_000);
    await setHidden(false);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.aborted).toBe(false);
  });

  test("rooms hear their frames and the stream's trouble, never hello or tick; `ended` is `lost`", async () => {
    const { hub, server } = hubWith();
    const heard: [LiveEventName, Record<string, unknown>][] = [];
    hub.subscribe("workspace", (event, data) => heard.push([event, data]));
    await flush();
    server.calls[0]!.write(frame("hello", { incarnation: "a", tick: 15_000 }) + frame("tick") + frame("change", { room: "workspace", at: "x" }) + frame("ended"));
    await flush();
    expect(heard).toEqual([["change", { room: "workspace", at: "x" }], ["lost", {}]]);
    expect(hub.connectionState()).toBe("signed-out");
    expect(document.documentElement.dataset["liveState"]).toBe("signed-out");
  });

  test("pagehide closes the stream; pageshow from the cache reopens it", async () => {
    const { hub, server } = hubWith();
    hub.subscribe("workspace", () => {});
    await flush();
    window.dispatchEvent(new Event("pagehide"));
    expect(server.calls[0]!.aborted).toBe(true);
    const shown = new Event("pageshow") as Event & { persisted: boolean };
    Object.defineProperty(shown, "persisted", { value: true });
    window.dispatchEvent(shown);
    await flush();
    expect(server.calls).toHaveLength(2);
    expect(hub.connectionState()).toBe("live");
  });

  test("where fetch can't stream, the page opens its EventSource exactly as before", async () => {
    const opened: string[] = [];
    vi.stubGlobal("EventSource", class { static CLOSED = 2; readyState = 1; constructor(url: string) { opened.push(url); } addEventListener() {} close() {} });
    try {
      const { server, fetch } = fakeServer();
      server.bodyless = true;
      const hub = new LiveHub({ reader: "stream", deps: { fetch } });
      hub.subscribe("workspace", () => {});
      await flush();
      expect(opened).toEqual(["/live?room=workspace"]);
      expect(hub.connectionState()).toBe("idle");
    } finally { vi.unstubAllGlobals(); }
  });

  test("the reader is the stream only where the server marks the page", async () => {
    const opened: string[] = [];
    vi.stubGlobal("EventSource", class { static CLOSED = 2; readyState = 1; constructor(url: string) { opened.push(url); } addEventListener() {} close() {} });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (url: string) => { fetched.push(url); return new Promise<Response>(() => {}); });
    try {
      new LiveHub().subscribe("workspace", () => {});
      await flush();
      expect(opened).toEqual(["/live?room=workspace"]);
      document.body.innerHTML = `<div id="standing-orders-workspace" data-live-reader="stream"></div>`;
      new LiveHub().subscribe("workspace", () => {});
      await flush();
      expect(fetched).toEqual(["/live?room=workspace"]);
      expect(opened).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
