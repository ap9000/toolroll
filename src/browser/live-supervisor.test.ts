// @vitest-environment happy-dom
/** The page's supervised live stream (browser/live-supervisor.ts, and LiveHub's stream reader in browser/live.ts): one
 * owner for every retry, backoff with jitter capped at a minute, a retired stream never speaks, wakeups retry at once,
 * a hidden tab lets its watching rooms go at once and its stream go after the grace, and the back/forward cache closes
 * and reopens it. A fake clock (vitest timers) and a fake fetch whose streams the test writes. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { backoffDelay, LIVE_BACKOFF_CAP_MS, LIVE_FRAMES_HEADER, LIVE_HIDDEN_GRACE_MS, LiveSupervisor, SseParser, type LiveConnectionState, type SupervisorDeps } from "./live-supervisor.js";
import { LiveHub, type LiveEventName } from "./live.js";

/** One request the page made: what it asked for, and its stream, which the test writes, ends or breaks. `started`: it holds
 * one of the host's connections (it may wait in the queue for one). */
type Call = { url: string; init: RequestInit; aborted: boolean; started: boolean; write: (text: string) => void; end: () => void; fail: () => void };
/** A probe the page sent (GET /live/ping): the test answers it with a status. */
type Ping = { url: string; init: RequestInit; aborted: boolean; started: boolean; answer: (status: number) => void };

/** A server the page reads: `up` answers with a stream, `down` refuses the connection, a number answers that status.
 * `slots`: how many connections the browser holds to the host at once (HTTP/1.1: six); a request beyond them waits in
 * the queue until one is let go (a stream ends or is aborted, a ping is answered), and an abort takes it off the queue.
 * `pingAnswer`: answer every probe with this status as soon as it holds a connection (else the test answers it). */
function fakeServer(options: { slots?: number } = {}) {
  const calls: Call[] = [];
  const pings: Ping[] = [];
  const slots = options.slots ?? Number.POSITIVE_INFINITY;
  const server = { mode: "up" as "up" | "down" | number, calls, pings, ignoreAbort: false, bodyless: false, pingAnswer: null as number | null, active: 0, mostActive: 0 };
  const queue: { start: () => void; cancelled: boolean }[] = [];
  const release = (): void => {
    server.active -= 1;
    while (queue.length > 0 && server.active < slots) {
      const next = queue.shift()!;
      if (next.cancelled) continue;
      server.active += 1;
      server.mostActive = Math.max(server.mostActive, server.active);
      next.start();
    }
  };
  /** Start now if a connection is free, else wait for one; an abort while waiting cancels. */
  const hold = (start: () => void, signal: AbortSignal | null | undefined, cancel: () => void): void => {
    if (server.active < slots) { server.active += 1; server.mostActive = Math.max(server.mostActive, server.active); start(); return; }
    const waiting = { start, cancelled: false };
    queue.push(waiting);
    signal?.addEventListener("abort", () => { if (!waiting.cancelled && queue.includes(waiting)) { waiting.cancelled = true; cancel(); } });
  };
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith("/live/ping")) {
      return new Promise<Response>((resolve, reject) => {
        let done = false;
        const ping: Ping = { url, init, aborted: false, started: false, answer: status => {
          if (done || !ping.started) return;
          done = true; release(); resolve(new Response(null, { status }));
        } };
        pings.push(ping);
        init.signal?.addEventListener("abort", () => {
          ping.aborted = true;
          if (ping.started && !done) { done = true; release(); reject(new DOMException("aborted", "AbortError")); }
        });
        hold(() => { ping.started = true; if (server.pingAnswer !== null) ping.answer(server.pingAnswer); }, init.signal, () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    let held = false;
    const letGo = (): void => { if (held) { held = false; release(); } };
    const call: Call = { url, init, aborted: false, started: false,
      write: text => { try { controller.enqueue(encoder.encode(text)); } catch { /* closed, or not started */ } },
      end: () => { try { controller.close(); } catch { /* closed */ } letGo(); },
      fail: () => { try { controller.error(new TypeError("network")); } catch { /* closed */ } letGo(); } };
    calls.push(call);
    init.signal?.addEventListener("abort", () => { call.aborted = true; if (!server.ignoreAbort) call.fail(); letGo(); });
    if (server.mode === "down") return Promise.reject(new TypeError("Failed to fetch"));
    if (typeof server.mode === "number") return Promise.resolve(new Response("{}", { status: server.mode, headers: { "content-type": "application/json" } }));
    if (server.bodyless) return Promise.resolve(new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }));
    return new Promise<Response>((resolve, reject) => {
      hold(() => {
        call.started = true;
        held = !call.aborted;
        const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
        resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
      }, init.signal, () => reject(new DOMException("aborted", "AbortError")));
    });
  };
  return { server, fetch };
}

const frame = (event: string, data: Record<string, unknown> = {}) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const settle = () => vi.advanceTimersByTimeAsync(0);

function supervised(options: { random?: number; online?: () => boolean; near?: boolean; shared?: ReturnType<typeof fakeServer> } = {}) {
  const { server, fetch } = options.shared ?? fakeServer();
  const seen: { frames: [string, string][]; trouble: string[]; states: LiveConnectionState[]; opened: string[]; unusable: number } = { frames: [], trouble: [], states: [], opened: [], unusable: 0 };
  const deps: SupervisorDeps = {
    fetch, now: () => Date.now(), random: () => options.random ?? 0,
    setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
    setInterval: (run, ms) => setInterval(run, ms), clearInterval: id => clearInterval(id as ReturnType<typeof setInterval>),
    online: options.online ?? (() => true), near: () => options.near ?? true,
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
  test("a stream that isn't up yet is replaced outright; a retired stream's late words are dropped, and its end is no drop", async () => {
    const { supervisor, server, seen } = supervised();
    server.ignoreAbort = true; // a stubborn stream that keeps talking after its abort
    supervisor.want("/live?room=task%3A1");
    await settle();
    const first = server.calls[0]!;
    first.write(frame("change", { room: "task:1" }));
    await settle();
    // A hidden tab's change of rooms is immediate: the old stream goes first, with no overlap.
    supervisor.want("/live?room=task%3A2", true);
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

const CONN = "0123456789abcdef01234567";
const hello = (conn: string | null = CONN) => frame("hello", { incarnation: "a", tick: 15_000, ...(conn === null ? {} : { conn }) });
const parsed = (frames: [string, string][]) => frames.map(([event, data]) => [event, JSON.parse(data)]);

/** Fluid pages 1b (plan v2 §9 and the round-2 changes): replacing a stream that is up hands over after the replacement
 * has synced, with its own frames held apart (never dropped), one atomic switch, and absolute bounds on the overlap. */
describe("handover", () => {
  test("the old stream keeps speaking while the replacement catches up; at `synced` the switch is one step, and what the page already heard isn't said twice", async () => {
    const { supervisor, server, seen } = supervised();
    server.ignoreAbort = true;
    supervisor.want("/live?room=workspace");
    await settle();
    const old = server.calls[0]!;
    old.write(hello() + frame("change", { room: "workspace", at: "x" }));
    await settle();
    supervisor.want("/live?room=task%3A2&room=workspace");
    await settle();
    const next = server.calls[1]!;
    expect(old.aborted).toBe(false);
    expect(supervisor.state).toBe("live");
    // Both speak: the old one is heard at once, the replacement's own frames are held (not dropped) until its switch.
    old.write(frame("change", { room: "workspace", at: "y" }));
    next.write(hello("fedcba9876543210fedcba98") + frame("change", { room: "workspace", at: "y", revision: "v1:9" }) + frame("change", { room: "task:2", at: "t" }));
    await settle();
    expect(parsed(seen.frames)).toEqual([["change", { room: "workspace", at: "x" }], ["change", { room: "workspace", at: "y" }]]);
    expect(seen.opened).toEqual(["/live?room=workspace"]);
    next.write(frame("synced"));
    await settle();
    expect(old.aborted).toBe(true);
    expect(seen.opened).toEqual(["/live?room=workspace", "/live?room=task%3A2&room=workspace"]);
    // The workspace's `y` was already heard (same `at`); the task's first word is new.
    expect(parsed(seen.frames).slice(2)).toEqual([["change", { room: "task:2", at: "t" }]]);
    // Retired: the old stream is never heard again; the new one is the stream.
    old.write(frame("change", { room: "workspace", at: "old" }));
    next.write(frame("change", { room: "workspace", at: "z" }));
    await settle();
    expect(parsed(seen.frames).slice(3)).toEqual([["change", { room: "workspace", at: "z" }]]);
    expect(seen.trouble).toEqual([]);
    expect(seen.states).toEqual(["connecting", "live"]);
  });

  test("duplicate frames across the two streams: each room's last word stands, said once; a repeat of what the page has is dropped", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=summary&room=workspace");
    await settle();
    const old = server.calls[0]!;
    old.write(hello() + frame("change", { room: "workspace", at: "w1" }) + frame("change", { room: "summary", at: "s1" }) + frame("here", { room: "summary", people: [] }));
    await settle();
    supervisor.want("/live?room=summary&room=task%3A3&room=workspace");
    await settle();
    const next = server.calls[1]!;
    next.write(hello("fedcba9876543210fedcba98")
      // The same as the page has: dropped.
      + frame("change", { room: "workspace", at: "w1" }) + frame("here", { room: "summary", people: [] })
      // The summary moves twice while the replacement syncs, and the old stream hears it too (the same room, the same signal).
      + frame("change", { room: "summary", at: "s2" }) + frame("change", { room: "summary", at: "s3" }) + frame("change", { room: "task:3", at: "t" }));
    old.write(frame("change", { room: "summary", at: "s2" }) + frame("change", { room: "summary", at: "s3" }));
    await settle();
    next.write(frame("synced"));
    await settle();
    expect(parsed(seen.frames)).toEqual([
      ["change", { room: "workspace", at: "w1" }], ["change", { room: "summary", at: "s1" }], ["here", { room: "summary", people: [] }],
      ["change", { room: "summary", at: "s2" }], ["change", { room: "summary", at: "s3" }],
      // The replacement adds only what is new; never s2 after s3.
      ["change", { room: "task:3", at: "t" }]]);
  });

  test("overlapping words against different states resolve to the newest: the replacement's last word for a room wins if the page has something else", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=summary");
    await settle();
    server.calls[0]!.write(hello() + frame("change", { room: "summary", at: "s1" }));
    await settle();
    supervisor.want("/live?room=summary&room=workspace");
    await settle();
    // The replacement joined after a write the old stream hasn't said yet (it settles its reads), then the old one says an older state.
    server.calls[1]!.write(hello(null) + frame("change", { room: "summary", at: "s2" }) + frame("change", { room: "workspace", at: "w" }));
    server.calls[0]!.write(frame("change", { room: "summary", at: "s1b" }));
    await settle();
    server.calls[1]!.write(frame("synced"));
    await settle();
    expect(parsed(seen.frames).at(-2)).toEqual(["change", { room: "summary", at: "s2" }]);
    expect(parsed(seen.frames).at(-1)).toEqual(["change", { room: "workspace", at: "w" }]);
  });

  test("bounded break-before-make: a replacement with no `hello` in 1.5 s breaks the old stream first, then is waited for", async () => {
    const shared = fakeServer({ slots: 1 });
    const { supervisor, server, seen } = supervised({ shared });
    supervisor.want("/live?room=workspace");
    await settle();
    server.calls[0]!.write(hello());
    await settle();
    supervisor.want("/live?room=task%3A1&room=workspace");
    await settle();
    // The only connection is the old stream's: the replacement waits in the queue.
    expect(server.calls[1]!.started).toBe(false);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(server.calls[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls[0]!.aborted).toBe(true);
    expect(server.calls[1]!.started).toBe(true);
    expect(supervisor.state).toBe("live");
    expect(seen.opened.at(-1)).toBe("/live?room=task%3A1&room=workspace");
    expect(server.mostActive).toBe(1);
    expect(seen.trouble).toEqual([]);
  });

  test("an absolute deadline: a replacement that says `hello` in time but never `synced` overlaps 3 s at most, then takes over with what it held", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=workspace");
    await settle();
    server.calls[0]!.write(hello());
    await settle();
    supervisor.want("/live?room=task%3A1&room=workspace");
    await vi.advanceTimersByTimeAsync(100);
    server.calls[1]!.write(hello("fedcba9876543210fedcba98") + frame("change", { room: "task:1", at: "t" }));
    await vi.advanceTimersByTimeAsync(2_899);
    expect(server.calls[0]!.aborted).toBe(false);
    expect(seen.frames).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls[0]!.aborted).toBe(true);
    expect(parsed(seen.frames)).toEqual([["change", { room: "task:1", at: "t" }]]);
    expect(seen.opened.at(-1)).toBe("/live?room=task%3A1&room=workspace");
  });

  test("a newer replacement replaces the older one but never extends the overlap", async () => {
    const { supervisor, server } = supervised();
    supervisor.want("/live?room=workspace");
    await settle();
    server.calls[0]!.write(hello());
    await settle();
    supervisor.want("/live?room=task%3A1&room=workspace");
    await vi.advanceTimersByTimeAsync(1_000);
    supervisor.want("/live?room=task%3A2&room=workspace");
    await vi.advanceTimersByTimeAsync(100);
    expect(server.calls[1]!.aborted).toBe(true);
    server.calls[2]!.write(hello("fedcba9876543210fedcba98"));
    await vi.advanceTimersByTimeAsync(1_899);
    expect(server.calls[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls[0]!.aborted).toBe(true);
    expect(server.calls.filter(one => !one.aborted)).toHaveLength(1);
  });

  test("the old stream dies during the handover: the replacement takes over at once, and nothing is said about trouble", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=workspace");
    await settle();
    server.calls[0]!.write(hello());
    await settle();
    supervisor.want("/live?room=task%3A1&room=workspace");
    await settle();
    server.calls[1]!.write(hello("fedcba9876543210fedcba98") + frame("change", { room: "task:1", at: "t" }));
    await settle();
    server.calls[0]!.fail();
    await settle();
    expect(seen.opened.at(-1)).toBe("/live?room=task%3A1&room=workspace");
    expect(parsed(seen.frames)).toEqual([["change", { room: "task:1", at: "t" }]]);
    expect(seen.trouble).toEqual([]);
    expect(supervisor.state).toBe("live");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.calls).toHaveLength(2);
  });

  test("the replacement fails: the page's stream fails as it always did (both go, one attempt, then backoff)", async () => {
    const { supervisor, server, seen } = supervised({ random: 0 });
    supervisor.want("/live?room=workspace");
    await settle();
    server.calls[0]!.write(hello());
    await settle();
    server.mode = 500;
    supervisor.want("/live?room=task%3A1&room=workspace");
    await settle();
    expect(server.calls[0]!.aborted).toBe(true);
    expect(seen.trouble).toEqual(["lost"]);
    server.mode = "up";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.calls.at(-1)!.url).toBe("/live?room=task%3A1&room=workspace");
    expect(supervisor.state).toBe("live");
  });

  test("an `ended` on either stream during the handover is a refusal: both go", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=workspace");
    await settle();
    server.calls[0]!.write(hello());
    await settle();
    supervisor.want("/live?room=task%3A1&room=workspace");
    await settle();
    server.calls[0]!.write(frame("gone", { room: "workspace" }) + frame("ended"));
    await settle();
    expect(server.calls[1]!.aborted).toBe(true);
    expect(seen.trouble).toEqual(["lost"]);
    expect(supervisor.state).toBe("signed-out");
  });
});

/** Codex fl1b review: order across the two streams, and a replacement the page no longer wants. */
describe("handover order and identity", () => {
  const at = (frames: [string, string][], room: string) => frames.map(([, data]) => JSON.parse(data) as Record<string, unknown>).filter(one => one["room"] === room).map(one => one["at"]);

  test("reversed arrival: the old stream already applied s1 then s2; the replacement's s1 never brings the page back", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=summary");
    await settle();
    const old = server.calls[0]!;
    old.write(hello() + frame("change", { room: "summary", at: "s1", seq: 10 }));
    await settle();
    supervisor.want("/live?room=summary&room=workspace");
    await settle();
    const next = server.calls[1]!;
    // The replacement read s1 when it joined; the old stream then hears s2 (a later read) before the replacement does.
    next.write(hello("fedcba9876543210fedcba98") + frame("change", { room: "summary", at: "s1", seq: 10 }) + frame("change", { room: "workspace", at: "w", seq: 11 }));
    old.write(frame("change", { room: "summary", at: "s2", seq: 20 }));
    await settle();
    next.write(frame("synced"));
    await settle();
    // Not caught up (its summary is older than what the page shows): it waits, and the page stays at s2.
    expect(old.aborted).toBe(false);
    expect(at(seen.frames, "summary")).toEqual(["s1", "s2"]);
    // Its room catches up: now it takes over, and nothing older is replayed.
    next.write(frame("change", { room: "summary", at: "s2", seq: 20 }));
    await settle();
    expect(old.aborted).toBe(true);
    expect(at(seen.frames, "summary")).toEqual(["s1", "s2"]);
    expect(at(seen.frames, "workspace")).toEqual(["w"]);
    // An older state arriving late on the stream itself is dropped too; a newer one is applied.
    next.write(frame("change", { room: "summary", at: "s1", seq: 10 }) + frame("change", { room: "summary", at: "s3", seq: 30 }));
    await settle();
    expect(at(seen.frames, "summary")).toEqual(["s1", "s2", "s3"]);
  });

  test("promotion keeps each room's highest order, not the last to arrive", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=summary");
    await settle();
    server.calls[0]!.write(hello() + frame("change", { room: "summary", at: "s1", seq: 10 }));
    await settle();
    supervisor.want("/live?room=summary&room=workspace");
    await settle();
    // Delivered late and out of order on the replacement: s3 (a later read) before s2.
    server.calls[1]!.write(hello("fedcba9876543210fedcba98") + frame("change", { room: "summary", at: "s3", seq: 30 }) + frame("change", { room: "summary", at: "s2", seq: 20 })
      + frame("change", { room: "workspace", at: "w", seq: 5 }) + frame("synced"));
    await settle();
    expect(server.calls[0]!.aborted).toBe(true);
    expect(at(seen.frames, "summary")).toEqual(["s1", "s3"]);
  });

  test("a reply that finished just as the replacement joined: its last snapshot is applied, and a partial one is never what the page keeps", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=chat");
    await settle();
    server.calls[0]!.write(hello() + frame("turn", { room: "chat", text: "Checking", done: false, seq: 10 }));
    await settle();
    supervisor.want("/live?room=chat&room=workspace");
    await settle();
    // The reply finished; the replacement joined after, so its first word for the conversation is the finished reply.
    server.calls[1]!.write(hello("fedcba9876543210fedcba98") + frame("turn", { room: "chat", text: "", done: true, ok: true, seq: 20 }) + frame("change", { room: "workspace", at: "w", seq: 21 }) + frame("synced"));
    await settle();
    expect(server.calls[0]!.aborted).toBe(true);
    const turns = seen.frames.filter(([event]) => event === "turn").map(([, data]) => JSON.parse(data) as { done: boolean });
    expect(turns.at(-1)!.done).toBe(true);
  });

  test("a replacement that says `synced` with no word yet for a room the page follows is not caught up: it waits (here, to the deadline)", async () => {
    const { supervisor, server } = supervised();
    supervisor.want("/live?room=chat");
    await settle();
    server.calls[0]!.write(hello() + frame("turn", { room: "chat", text: "Checking", done: false, seq: 10 }));
    await settle();
    supervisor.want("/live?room=chat&room=workspace");
    await settle();
    server.calls[1]!.write(hello("fedcba9876543210fedcba98") + frame("change", { room: "workspace", at: "w", seq: 21 }) + frame("synced"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.calls[0]!.aborted).toBe(false);
    // The old stream finishes the reply meanwhile: the page hears it.
    server.calls[0]!.write(frame("turn", { room: "chat", text: "", done: true, ok: true, seq: 20 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.calls[0]!.aborted).toBe(true);
  });

  test("a replacement that never catches up still takes over at the absolute deadline, dropping its older words", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=summary");
    await settle();
    server.calls[0]!.write(hello() + frame("change", { room: "summary", at: "s2", seq: 20 }));
    await settle();
    supervisor.want("/live?room=summary&room=workspace");
    await settle();
    server.calls[1]!.write(hello("fedcba9876543210fedcba98") + frame("change", { room: "summary", at: "s1", seq: 10 }) + frame("synced"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(server.calls[0]!.aborted).toBe(true);
    expect(at(seen.frames, "summary")).toEqual(["s2"]);
  });

  test("a new server run's words are not compared with the old run's orders", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=summary");
    await settle();
    server.calls[0]!.write(hello() + frame("change", { room: "summary", at: "s9", seq: 900 }));
    await settle();
    server.calls[0]!.fail();
    await vi.advanceTimersByTimeAsync(1_000);
    server.calls[1]!.write(frame("hello", { incarnation: "b", tick: 15_000, conn: CONN }) + frame("change", { room: "summary", at: "s1", seq: 1 }));
    await settle();
    expect(at(seen.frames, "summary")).toEqual(["s9", "s1"]);
  });

  test("A → B → A: going back to the open stream's rooms drops the replacement and its timers; a late `synced` from it promotes nothing", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=task%3A1");
    await settle();
    server.calls[0]!.write(hello());
    await settle();
    supervisor.want("/live?room=task%3A2");
    await settle();
    supervisor.want("/live?room=task%3A1");
    await settle();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]!.aborted).toBe(true);
    server.calls[1]!.write(hello("fedcba9876543210fedcba98") + frame("synced"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.calls[0]!.aborted).toBe(false);
    expect(supervisor.wanted).toBe("/live?room=task%3A1");
    expect(seen.opened).toEqual(["/live?room=task%3A1"]);
  });

  test("A → B → A through retarget (the hub's road): the replacement for B is dropped, never promoted", async () => {
    const { supervisor, server, seen } = supervised();
    supervisor.want("/live?room=task%3A1");
    await settle();
    server.calls[0]!.write(hello());
    await settle();
    supervisor.want("/live?room=task%3A2");
    await settle();
    supervisor.retarget("/live?room=task%3A1");
    expect(server.calls[1]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.calls[0]!.aborted).toBe(false);
    expect(seen.opened).toEqual(["/live?room=task%3A1"]);
  });

  test("a stream replaced because it seemed dead is not kept when the page goes back to its rooms", async () => {
    const { supervisor, server } = supervised();
    supervisor.want("/live?room=task%3A1");
    await settle();
    server.calls[0]!.write(hello());
    await settle();
    supervisor.wake();
    server.pings[0]!.answer(204);
    await vi.advanceTimersByTimeAsync(600);
    expect(server.calls).toHaveLength(2);
    supervisor.want("/live?room=task%3A2");
    supervisor.want("/live?room=task%3A1");
    await settle();
    // Still being replaced, now for task 1 again.
    expect(server.calls.at(-1)!.aborted).toBe(false);
    expect(server.calls.at(-1)!.url).toBe("/live?room=task%3A1");
  });
});

/** The corrected probe (plan v2 §9): a pong on the stream proves it alive; a 204 alone proves nothing. */
describe("the probe", () => {
  const upWithConn = async (options: { near?: boolean } = {}) => {
    const harness = supervised(options);
    harness.supervisor.want("/live?room=workspace");
    await settle();
    harness.server.calls[0]!.write(hello());
    await settle();
    return harness;
  };

  test("a wakeup sends one ping naming the stream's conn, quiet and cookie-only; focus and visibility together are one ping", async () => {
    const { supervisor, server } = await upWithConn();
    supervisor.wake();
    supervisor.wake();
    expect(server.pings.map(one => one.url)).toEqual([`/live/ping?conn=${CONN}&n=1`]);
    expect(server.pings[0]!.init).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "manual" });
    expect(server.calls).toHaveLength(1);
  });

  test("a 204 at 0 ms with the pong at 400 ms is alive", async () => {
    const { supervisor, server, seen } = await upWithConn();
    supervisor.wake();
    server.pings[0]!.answer(204);
    await vi.advanceTimersByTimeAsync(400);
    server.calls[0]!.write(frame("pong", { n: 1 }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.calls).toHaveLength(1);
    expect(seen.frames).toEqual([]);
  });

  test("a 204 at 0 ms with no frame for 600 ms, near, is dead: the stream is replaced (by handover)", async () => {
    const { supervisor, server } = await upWithConn();
    supervisor.wake();
    server.pings[0]!.answer(204);
    await vi.advanceTimersByTimeAsync(499);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(101);
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0]!.aborted).toBe(false);
  });

  test("far (a tailnet or public name), the silence after the 204 is 2.5 s", async () => {
    const { supervisor, server } = await upWithConn({ near: false });
    supervisor.wake();
    server.pings[0]!.answer(204);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls).toHaveLength(2);
  });

  test("any frame after the ping, before its 204, proves the stream alive", async () => {
    const { supervisor, server } = await upWithConn();
    supervisor.wake();
    server.calls[0]!.write(frame("tick"));
    await settle();
    expect(server.pings[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(server.calls).toHaveLength(1);
  });

  test("a delayed pong after the replacement has started is ignored: the replacement goes on", async () => {
    const { supervisor, server, seen } = await upWithConn();
    supervisor.wake();
    server.pings[0]!.answer(204);
    await vi.advanceTimersByTimeAsync(600);
    expect(server.calls).toHaveLength(2);
    server.calls[0]!.write(frame("pong", { n: 1 }));
    await settle();
    expect(server.calls[1]!.aborted).toBe(false);
    server.calls[1]!.write(hello("fedcba9876543210fedcba98") + frame("synced"));
    await settle();
    expect(server.calls[0]!.aborted).toBe(true);
    expect(seen.frames).toEqual([]);
  });

  test("no answer at all: dead at 3 s near, 15 s far, and 3 s far just after the device slept", async () => {
    const near = await upWithConn();
    near.supervisor.wake();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(near.server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(near.server.calls).toHaveLength(2);
    expect(near.server.pings[0]!.aborted).toBe(true);
    near.supervisor.dispose();

    const far = await upWithConn({ near: false });
    far.supervisor.wake();
    await vi.advanceTimersByTimeAsync(14_999);
    // The server says nothing at all meanwhile (a tick would have proved it alive).
    expect(far.server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(far.server.calls).toHaveLength(2);
    far.supervisor.dispose();

    const slept = await upWithConn({ near: false });
    slept.supervisor.wake(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(slept.server.calls).toHaveLength(2);
  });

  test("a 429 (the ping budget is spent) is no verdict: the stream's own tick proves it, and no ping goes before Retry-After", async () => {
    const { supervisor, server, seen } = await upWithConn();
    supervisor.wake();
    server.pings[0]!.answer(429);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.calls).toHaveLength(1);
    server.calls[0]!.write(frame("tick"));
    await settle();
    // A 429 without Retry-After asks for 10 s without pings: a wakeup now sends none (the stream just ticked, so it stays).
    supervisor.wake();
    expect(server.pings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.calls).toHaveLength(1);
    expect(seen.trouble).toEqual([]);
    supervisor.wake();
    expect(server.pings).toHaveLength(2);
  });

  test("a 429 and then silence past a tick and its margin: the stream is dead after all", async () => {
    const { supervisor, server } = await upWithConn();
    supervisor.wake();
    server.pings[0]!.answer(429);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls).toHaveLength(2);
  });

  test("any other answer (the server doesn't know the stream, or a sign-in page) is dead at once", async () => {
    for (const status of [404, 401, 500]) {
      const { supervisor, server } = await upWithConn();
      supervisor.wake();
      server.pings[0]!.answer(status);
      await settle();
      expect(server.calls, String(status)).toHaveLength(2);
      supervisor.dispose();
    }
  });
});

/** Six tabs on plain HTTP/1.1 share six connections to the host (plan v2 §9). */
describe("six tabs, six connections", () => {
  const sixTabs = async () => {
    const shared = fakeServer({ slots: 6 });
    const tabs = Array.from({ length: 6 }, () => supervised({ shared }));
    for (const [at, tab] of tabs.entries()) tab.supervisor.want(`/live?room=task%3A${at}`);
    await settle();
    for (const call of shared.server.calls) call.write(hello());
    await settle();
    expect(shared.server.active).toBe(6);
    return { shared, tabs };
  };

  test("every slot held: a tab that changes its rooms gets its new stream within the 1.5 s bound, never a deadlock, never a seventh connection", async () => {
    const { shared, tabs } = await sixTabs();
    tabs[0]!.supervisor.want("/live?room=task%3A0&room=workspace");
    await settle();
    expect(shared.server.calls[6]!.started).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(shared.server.calls[6]!.started).toBe(true);
    expect(tabs[0]!.supervisor.state).toBe("live");
    expect(tabs[0]!.seen.opened.at(-1)).toBe("/live?room=task%3A0&room=workspace");
    expect(shared.server.mostActive).toBe(6);
    // The other tabs kept their streams.
    for (const tab of tabs.slice(1)) expect(tab.supervisor.state).toBe("live");
    expect(shared.server.calls.slice(1, 6).every(one => !one.aborted)).toBe(true);
  });

  test("every slot held: the visible tab's probe waits in the queue, is judged at its deadline, and the tab is live again within bounds", async () => {
    const { shared, tabs } = await sixTabs();
    shared.server.pingAnswer = 204;
    tabs[0]!.supervisor.wake();
    await settle();
    expect(shared.server.pings[0]!.started).toBe(false);
    // 3 s deadline (near), then the replacement's 1.5 s hello wait breaks the old stream: at most 4.5 s.
    await vi.advanceTimersByTimeAsync(4_500);
    expect(tabs[0]!.supervisor.state).toBe("live");
    expect(shared.server.calls.at(-1)!.started).toBe(true);
    expect(shared.server.calls[0]!.aborted).toBe(true);
    // The abandoned probe left the queue: it never took the connection the stream needed.
    expect(shared.server.pings[0]!.started).toBe(false);
    expect(shared.server.mostActive).toBe(6);
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

  test("with a stream open from a server that names no stream (nothing to probe), a wakeup replaces it only if it missed its tick", async () => {
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
    expect(server.pings).toEqual([]);
    // By handover: the old stream goes once the new one has synced.
    server.calls[1]!.write(frame("hello", { incarnation: "a", tick: 15_000 }) + frame("synced"));
    await settle();
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

  test("A → B → A on a shown page: the page ends on A's stream, and B's replacement is dropped (Codex fl1b finding 2)", async () => {
    const { hub, server } = hubWith();
    let leave = hub.subscribe("task:1", () => {});
    await flush();
    server.calls[0]!.write(frame("hello", { incarnation: "a", tick: 15_000, conn: "0123456789abcdef01234567" }));
    await flush();
    leave(); leave = hub.subscribe("task:2", () => {});
    await flush();
    expect(server.calls.map(one => one.url)).toEqual(["/live?room=task%3A1", "/live?room=task%3A2"]);
    leave(); hub.subscribe("task:1", () => {});
    await flush();
    expect(server.calls[1]!.aborted).toBe(true);
    server.calls[1]!.write(frame("synced"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.calls[0]!.aborted).toBe(false);
    expect(server.calls).toHaveLength(2);
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
