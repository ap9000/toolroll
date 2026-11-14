/**
 * The page's live stream, read with fetch (docs: eight/fluid plan v2 §1, §9; slice 1a). One supervisor per tab owns the
 * stream and every retry: the browser never reconnects behind its back, and the page sees every frame, including the
 * server's `tick`, so a socket that went silent is noticed.
 *
 * - One stream at a time. Replacing it (new rooms, a silent socket, a wakeup) aborts the old one first. Each stream
 *   gets an epoch; anything a retired stream still says (a frame, its end, its error) is dropped.
 * - Backoff with jitter: the n-th retry waits `c/2 + random·c/2`, `c = min(LIVE_BACKOFF_CAP_MS, 1 s·2^(n+1))`. A stream
 *   that stays up LIVE_STABLE_MS starts the count again.
 * - Refused (401/403, a redirect, or the server's `ended`): the page is signed out or lost its access. It waits about
 *   the cap, or until a wakeup, rather than knocking at once.
 * - Offline (the browser says so and the attempt failed): the same slow wait, but every wakeup still tries, because
 *   "offline" is often wrong for this computer's own address.
 * - Wakeups: back online, the tab shown, focus, a page restored from the back/forward cache, the Page Lifecycle
 *   `resume`, a network change, and a timer gap (the device slept). A wakeup fires a pending retry at once; with a
 *   stream open, one that missed its tick is replaced.
 * - Back/forward cache: the stream is closed on `pagehide` and reopened on `pageshow`.
 *
 * GET only, quiet: the stream never extends the session or writes (the server's `/live` row is `noTouch`). It adds no
 * script element and needs nothing beyond the page's existing `connect-src 'self'`.
 */

/** The longest wait between attempts. */
export const LIVE_BACKOFF_CAP_MS = 60_000;
const LIVE_BACKOFF_BASE_MS = 1_000;
/** A stream up this long resets the backoff. */
export const LIVE_STABLE_MS = 30_000;
/** A hidden tab keeps its observational rooms this long, then closes its stream (watching rooms leave at once). */
export const LIVE_HIDDEN_GRACE_MS = 60_000;
/** A gap this long between one-second beats means the device slept: a wakeup. */
export const LIVE_GAP_MS = 5_000;
/** The server's tick, until its `hello` says otherwise (live-bus.ts KEEP_ALIVE_MS). */
const DEFAULT_TICK_MS = 15_000;
/** Two wakeups closer than this make one attempt (focus and visibility arrive together). */
const WAKE_SPACING_MS = 1_000;
/** Asks the server for the frames this reader understands (`hello`, named `tick`); without it the stream is as before. */
export const LIVE_FRAMES_HEADER = "x-toolroll-live";

/** Where the page's stream stands. `idle`: no stream wanted (no rooms, a quiet page, a hidden tab past its grace). */
export type LiveConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "offline" | "signed-out";

/** The wait before retry number `attempt` (0-based), for a random draw in [0, 1). */
export function backoffDelay(attempt: number, random: number): number {
  const ceiling = Math.min(LIVE_BACKOFF_CAP_MS, LIVE_BACKOFF_BASE_MS * 2 ** (Math.min(attempt, 30) + 1));
  return ceiling / 2 + random * (ceiling / 2);
}

export type SseFrame = { event: string; data: string };

/** Server-sent events, read from text as it arrives (the WHATWG event-stream format: `event:`, `data:`, comments). */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const at = this.buffer.search(/\r\n|\n|\r/);
      if (at < 0) break;
      // A lone `\r` at the very end may be the first half of `\r\n`: wait for the next chunk.
      if (this.buffer[at] === "\r" && at === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + (this.buffer.startsWith("\r\n", at) ? 2 : 1));
      if (line === "") {
        if (this.data.length > 0) frames.push({ event: this.event === "" ? "message" : this.event, data: this.data.join("\n") });
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
    }
    return frames;
  }
}

export type SupervisorDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  random: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  setInterval: (run: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  /** What the browser says about the network (navigator.onLine); only ever a hint. */
  online: () => boolean;
};

export type SupervisorEvents = {
  /** A stream for `url` is open: its rooms are joined on the server. */
  opened: (url: string) => void;
  /** A room's frame (never `hello` or `tick`, which only prove the stream). */
  frame: (event: string, data: string) => void;
  /** Once per outage: `retrying` when the line dropped, `lost` when the server refused or ended the stream. */
  trouble: (kind: "retrying" | "lost") => void;
  state: (state: LiveConnectionState) => void;
  /** This browser can't read a stream with fetch: the page goes back to EventSource. */
  unusable: () => void;
};

export const browserSupervisorDeps = (): SupervisorDeps => ({
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: id => window.clearTimeout(id as number),
  setInterval: (run, ms) => window.setInterval(run, ms),
  clearInterval: id => window.clearInterval(id as number),
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
});

/** Whether this browser can read a stream with fetch. */
export function fetchStreamsSupported(): boolean {
  return typeof fetch === "function" && typeof ReadableStream === "function" && typeof TextDecoder === "function" && typeof AbortController === "function";
}

type Failure = "network" | "dropped" | "error" | "refused";

export class LiveSupervisor {
  private target = "";
  private epoch = 0;
  private controller: AbortController | null = null;
  private status: LiveConnectionState = "idle";
  /** Failed attempts since the last stable stream: the backoff's n. */
  private attempt = 0;
  private retry: unknown = null;
  private retryAt = Number.POSITIVE_INFINITY;
  private waiting: "backoff" | "offline" | "refused" | null = null;
  private openedAt = 0;
  private lastByteAt = 0;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private tickMs = DEFAULT_TICK_MS;
  private said: "retrying" | "lost" | null = null;
  private beat: unknown = null;
  private lastBeatAt = 0;
  /** Closed for the back/forward cache (pagehide) and not yet shown again. */
  private suspendedAt: number | null = null;
  private disposed = false;

  constructor(private readonly deps: SupervisorDeps, private readonly events: SupervisorEvents) {}

  get state(): LiveConnectionState { return this.status; }
  /** The stream this page wants now ("" for none). */
  get wanted(): string { return this.target; }
  /** A stream is open (its answer arrived) and not retired. */
  get live(): boolean { return this.status === "live" && this.controller !== null; }

  /** The page wants a stream for `url` ("" for none). A different url replaces the stream: the old one first. */
  want(url: string): void {
    if (this.disposed || url === this.target) return;
    this.target = url;
    if (url === "") { this.stop(); return; }
    // Refused: the page drops and adds rooms as it hears the refusal; whatever it wants then waits for the retry.
    if (this.waiting === "refused" || this.suspendedAt !== null) return;
    this.open();
  }

  /** The rooms the open stream holds changed without a new stream (the server already let some go). */
  retarget(url: string): void { if (!this.disposed && url !== "") this.target = url; }

  /** Something suggests the connection may have changed (focus, the tab shown, back online, a timer gap). */
  wake(): void {
    if (this.disposed || this.target === "") return;
    if (this.suspendedAt !== null) { this.suspendedAt = null; this.open(); return; }
    if (this.waiting !== null) {
      // Right after an attempt, the wakeup brings the retry forward to the end of the spacing (never later than it was).
      const due = this.lastAttemptAt + WAKE_SPACING_MS - this.deps.now();
      if (due <= 0) this.open();
      else if (due < this.retryAt - this.deps.now()) this.schedule(due);
      return;
    }
    if (this.controller === null) { this.open(); return; }
    // An open stream that missed its tick is probably dead under us (a phone that slept): replace it now.
    if (this.status === "live" && this.deps.now() - this.lastByteAt > this.tickMs + 5_000) this.open();
  }

  /** The browser says the network went away: an open stream is tried again at once, so a dead one shows as offline. */
  offline(): void {
    if (this.disposed || this.target === "" || this.suspendedAt !== null) return;
    if (this.controller !== null) this.open();
  }

  /** The page is leaving or entering the back/forward cache: close the stream (an open fetch can keep it out). */
  suspend(): void {
    if (this.disposed) return;
    this.retire();
    this.cancelRetry();
    this.waiting = null;
    this.suspendedAt = this.deps.now();
  }

  /** The page is shown again (restored from the back/forward cache). */
  resume(): void {
    if (this.disposed || this.suspendedAt === null) return;
    this.suspendedAt = null;
    if (this.target !== "") this.open();
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  private setState(next: LiveConnectionState): void {
    if (this.status === next) return;
    this.status = next;
    this.events.state(next);
  }

  private retire(): void {
    this.epoch += 1;
    const controller = this.controller;
    this.controller = null;
    try { controller?.abort(); } catch { /* already finished */ }
  }

  private cancelRetry(): void {
    if (this.retry !== null) this.deps.clearTimeout(this.retry);
    this.retry = null;
    this.retryAt = Number.POSITIVE_INFINITY;
  }

  private schedule(delay: number): void {
    this.cancelRetry();
    this.retryAt = this.deps.now() + delay;
    this.retry = this.deps.setTimeout(() => { this.retry = null; this.retryAt = Number.POSITIVE_INFINITY; this.open(); }, delay);
  }

  private stop(): void {
    this.retire();
    this.cancelRetry();
    this.waiting = null;
    this.attempt = 0;
    this.said = null;
    this.suspendedAt = null;
    if (this.beat !== null) this.deps.clearInterval(this.beat);
    this.beat = null;
    this.setState("idle");
  }

  private ensureBeat(): void {
    if (this.beat !== null) return;
    this.lastBeatAt = this.deps.now();
    this.beat = this.deps.setInterval(() => this.onBeat(), 1_000);
  }

  /** Once a second: a long gap means the device slept; a silent stream is replaced; a pagehide that didn't leave resumes. */
  private onBeat(): void {
    const now = this.deps.now();
    const gap = now - this.lastBeatAt;
    this.lastBeatAt = now;
    if (this.target === "") return;
    if (this.suspendedAt !== null) { if (now - this.suspendedAt > 2_000) this.resume(); return; }
    if (gap > LIVE_GAP_MS) { this.wake(); return; }
    if (this.status === "live" && this.controller !== null && now - this.lastByteAt > this.tickMs * 2 + 5_000) this.open();
  }

  private open(): void {
    if (this.disposed || this.target === "") return;
    this.retire();
    this.cancelRetry();
    this.waiting = null;
    this.suspendedAt = null;
    const epoch = this.epoch, url = this.target;
    const controller = new AbortController();
    this.controller = controller;
    this.lastAttemptAt = this.deps.now();
    this.setState(this.said === null && this.attempt === 0 ? "connecting" : "reconnecting");
    this.ensureBeat();
    this.read(epoch, url, controller).catch(() => {
      // A fault in the reader itself, not the network: this browser goes back to the old way.
      if (epoch === this.epoch && !this.disposed) this.events.unusable();
    });
  }

  private async read(epoch: number, url: string, controller: AbortController): Promise<void> {
    let response: Response;
    try {
      response = await this.deps.fetch(url, { headers: { accept: "text/event-stream", [LIVE_FRAMES_HEADER]: "1" }, credentials: "same-origin", cache: "no-store", redirect: "manual", signal: controller.signal });
    } catch {
      if (epoch === this.epoch) this.fail("network");
      return;
    }
    if (epoch !== this.epoch) { void response.body?.cancel().catch(() => undefined); return; }
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => undefined); this.fail("refused"); return; }
    if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("text/event-stream")) { void response.body?.cancel().catch(() => undefined); this.fail("error"); return; }
    const body = response.body;
    if (body === null || typeof body.getReader !== "function") { this.events.unusable(); return; }
    const reader = body.getReader();
    const parser = new SseParser(), decoder = new TextDecoder();
    this.openedAt = this.lastByteAt = this.deps.now();
    this.tickMs = DEFAULT_TICK_MS;
    this.said = null;
    this.setState("live");
    this.events.opened(url);
    try {
      for (;;) {
        if (epoch !== this.epoch) { void reader.cancel().catch(() => undefined); return; }
        const { done, value } = await reader.read();
        if (epoch !== this.epoch) { void reader.cancel().catch(() => undefined); return; }
        if (done) break;
        const now = this.deps.now();
        this.lastByteAt = now;
        if (now - this.openedAt >= LIVE_STABLE_MS) this.attempt = 0;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (epoch !== this.epoch) return;
          if (frame.event === "hello") { this.hello(frame.data); continue; }
          if (frame.event === "tick") continue;
          // Every room refused this page: signed out, or its access went. Stop and wait, as for a 401.
          if (frame.event === "ended") { this.fail("refused"); return; }
          try { this.events.frame(frame.event, frame.data); }
          catch (error) { queueMicrotask(() => { throw error; }); }
        }
      }
    } catch {
      if (epoch === this.epoch) this.fail("network");
      return;
    }
    if (epoch === this.epoch) this.fail("dropped");
  }

  private hello(raw: string): void {
    try {
      const tick: unknown = (JSON.parse(raw) as Record<string, unknown>)["tick"];
      if (typeof tick === "number" && Number.isFinite(tick) && tick >= 1_000 && tick <= 120_000) this.tickMs = tick;
    } catch { /* a hello without a tick keeps the default */ }
  }

  private fail(kind: Failure): void {
    this.retire();
    const say = kind === "error" || kind === "refused" ? "lost" : "retrying";
    if (say === "lost" ? this.said !== "lost" : this.said === null) { this.said = say; this.events.trouble(say); }
    let delay: number;
    if (kind === "refused") { this.waiting = "refused"; delay = backoffDelay(Number.POSITIVE_INFINITY, this.deps.random()); }
    else if (!this.deps.online()) { this.waiting = "offline"; delay = backoffDelay(Number.POSITIVE_INFINITY, this.deps.random()); }
    else { this.waiting = "backoff"; delay = backoffDelay(this.attempt, this.deps.random()); this.attempt += 1; }
    this.setState(this.waiting === "backoff" ? "reconnecting" : this.waiting === "offline" ? "offline" : "signed-out");
    this.schedule(delay);
  }
}
