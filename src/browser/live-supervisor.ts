/**
 * The page's live stream, read with fetch (docs: eight/fluid plan v2 §1, §9; slices 1a and 1b). One supervisor per tab
 * owns the stream and every retry: the browser never reconnects behind its back, and the page sees every frame,
 * including the server's `tick`, so a socket that went silent is noticed.
 *
 * - Handover (1b). Replacing a stream that is up (new rooms, a probe that found it dead) opens the replacement beside it.
 *   The old stream keeps speaking; the replacement's frames are held apart (they are its own, never dropped) until the
 *   server says `synced` (every room it asked for has said where it stands, a running reply's first snapshot included)
 *   and has caught up: for every room both streams spoke of, its words are at least as new as what the page applied.
 *   Then, in one step, the old stream is aborted, the replacement becomes the stream, and its held frames are applied.
 * - Order across streams: every room frame carries the server's `seq`, the order of the read its content came from
 *   (live-bus.ts liveOrderAfter, scoped to the room). Per room and kind of frame, within one server run (`hello.incarnation`), a frame no
 *   newer than what the page already applied is dropped, from either stream: a duplicate, or an older state that
 *   arrived late. What the page shows never goes backwards. A replacement that is no longer wanted (the page went back
 *   to the rooms the open stream holds) is dropped, never promoted.
 *   Bounded break-before-make: a replacement that hasn't said `hello` within LIVE_HANDOVER_HELLO_MS (the browser's six
 *   connections to a host may hold it in the queue) breaks the old stream first; and two streams never overlap longer
 *   than LIVE_HANDOVER_MAX_MS from the first replacement, whatever the replacement says. A stream that isn't up yet, a
 *   hidden tab letting rooms go, and a page coming back are replaced the 1a way: the old one first.
 * - Epochs: a retired stream (its frames, its end, its error) is never heard; only the stream and its replacement are.
 * - The probe (1b). A wakeup with a stream up asks the server for a `pong` on that very stream (GET /live/ping, bound to
 *   the stream's `conn` and this session). Any frame on the stream after the ping proves it alive. The ping's 204 alone
 *   proves nothing (the pong may be on its way): only a further silence after it, LIVE_PROBE_SILENCE_*_MS, means dead.
 *   No answer at all by LIVE_PROBE_DEADLINE_*_MS means dead too. Near (this computer, the LAN) waits less than far. A
 *   429 (the server's ping budget is spent) is no verdict: the page pings no more until its Retry-After, and judges
 *   the stream only by its own tick meanwhile.
 * - Backoff with jitter: the n-th retry waits `c/2 + random·c/2`, `c = min(LIVE_BACKOFF_CAP_MS, 1 s·2^(n+1))`. A stream
 *   that stays up LIVE_STABLE_MS starts the count again.
 * - Refused (401/403, a redirect, or the server's `ended`): the page is signed out or lost its access. It waits about
 *   the cap, or until a wakeup, rather than knocking at once.
 * - Offline (the browser says so and the attempt failed): the same slow wait, but every wakeup still tries, because
 *   "offline" is often wrong for this computer's own address.
 * - Wakeups: back online, the tab shown, focus, a page restored from the back/forward cache, the Page Lifecycle
 *   `resume`, a network change, and a timer gap (the device slept). A wakeup fires a pending retry at once; with a
 *   stream up, it probes it.
 * - Back/forward cache: the stream is closed on `pagehide` and reopened on `pageshow`.
 *
 * GET only, quiet: the stream and the probe never extend the session or write (the server's live rows are `noTouch`).
 * They add no script element and need nothing beyond the page's existing `connect-src 'self'`.
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
/** Handover: a replacement that hasn't said `hello` this long after it started breaks the old stream first. */
export const LIVE_HANDOVER_HELLO_MS = 1_500;
/** Handover: two streams overlap at most this long from the first replacement, whatever the replacement says. */
export const LIVE_HANDOVER_MAX_MS = 3_000;
/** A replacement's frames held before its switch, at most; one more and it takes over at once. */
const HANDOVER_HELD_MAX = 64;
/** The probe: after the ping's 204, this long with no frame at all means the stream is dead. */
export const LIVE_PROBE_SILENCE_NEAR_MS = 500;
export const LIVE_PROBE_SILENCE_FAR_MS = 2_500;
/** The probe: no answer of any kind within this long means the stream is dead (near, or just after a long sleep; far). */
export const LIVE_PROBE_DEADLINE_NEAR_MS = 3_000;
export const LIVE_PROBE_DEADLINE_FAR_MS = 15_000;
/** The server's name for a stream, in its `hello`: what a probe names. */
const CONN_NAME = /^[0-9a-f]{24}$/;

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
  /** The console is on this computer or the local network (a probe waits less for it). */
  near: () => boolean;
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
  near: () => typeof location === "undefined" || nearHost(location.hostname),
});

/** This computer or the local network, by the page's own host name (a tailnet or public name is far). */
export function nearHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || /^fe80:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) || /^169\.254\./.test(host);
}

/** Whether this browser can read a stream with fetch. */
export function fetchStreamsSupported(): boolean {
  return typeof fetch === "function" && typeof ReadableStream === "function" && typeof TextDecoder === "function" && typeof AbortController === "function";
}

type Failure = "network" | "dropped" | "error" | "refused";

/** One stream the page opened: the current one, or its replacement during a handover. */
type Stream = {
  url: string;
  controller: AbortController;
  /** Its answer arrived and its body is being read. */
  reading: boolean;
  openedAt: number;
  lastByteAt: number;
  tickMs: number;
  /** The server's name for it (`hello`), which a probe names; null until then, or from a server that gives none. */
  conn: string | null;
  helloAt: number | null;
  /** A replacement's room frames, held apart until it takes over (then applied, in order). */
  held: SseFrame[];
  /** The server run it speaks for (`hello`): `seq` compares only within one. */
  incarnation: string | null;
  /** A replacement that said `synced`: it takes over once it has caught up. */
  synced: boolean;
  /** Being replaced because it seemed dead (a probe, a missed tick, offline), not for new rooms: never kept in place of
   * its replacement. */
  suspect: boolean;
};

type Probe = { stream: Stream; controller: AbortController; silence: unknown; deadline: unknown };

/** A frame's room and event (its slot), what makes a repeat of it the same (a change's `at`, else all its data), and
 * the order of the read it came from (`seq`; null from a server that gives none). */
function frameKey(frame: SseFrame): { slot: string; same: string; seq: number | null } | null {
  try {
    const data: unknown = JSON.parse(frame.data);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    const { room, at, seq } = data as Record<string, unknown>;
    if (typeof room !== "string") return null;
    const rest: Record<string, unknown> = { ...(data as Record<string, unknown>) };
    delete rest["seq"];
    return { slot: `${room}\u0000${frame.event}`, same: frame.event === "change" && at !== undefined ? JSON.stringify(at) : JSON.stringify(rest),
      seq: typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : null };
  } catch { return null; }
}

export class LiveSupervisor {
  private target = "";
  /** The stream the page hears. */
  private current: Stream | null = null;
  /** Its replacement during a handover: read, but its frames held apart until it takes over. */
  private candidate: Stream | null = null;
  /** The handover's absolute end (set at the first replacement, never moved by a later one) and its hello wait. */
  private handoverDue: unknown = null;
  private helloDue: unknown = null;
  private probing: Probe | null = null;
  private pings = 0;
  /** What the page last applied per room and event: its content, and the server run and order it came from. A frame
   * no newer (from either stream) is dropped. */
  private readonly heard = new Map<string, { same: string; incarnation: string | null; seq: number | null }>();
  /** The server asked for no pings before this (a 429's Retry-After). */
  private pingQuietUntil = 0;
  private status: LiveConnectionState = "idle";
  /** Failed attempts since the last stable stream: the backoff's n. */
  private attempt = 0;
  private retry: unknown = null;
  private retryAt = Number.POSITIVE_INFINITY;
  private waiting: "backoff" | "offline" | "refused" | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
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
  get live(): boolean { return this.status === "live" && this.current?.reading === true; }

  /** The page wants a stream for `url` ("" for none). A different url replaces the stream: by handover when it is up,
   * or the old one first when `immediate` (a hidden tab letting its watching rooms go) or when it isn't up yet. */
  want(url: string, immediate = false): void {
    if (this.disposed || url === this.target) return;
    this.target = url;
    if (url === "") { this.stop(); return; }
    // Back to the rooms the open (and healthy) stream holds: the replacement on its way is no longer wanted.
    if (!immediate && this.candidate !== null && this.current?.reading === true && !this.current.suspect && this.current.url === url) { this.dropCandidate(); return; }
    // Refused: the page drops and adds rooms as it hears the refusal; whatever it wants then waits for the retry.
    if (this.waiting === "refused" || this.suspendedAt !== null) return;
    this.open(immediate);
  }

  /** The rooms the open stream holds changed without a new stream (the server already let some go). */
  retarget(url: string): void {
    if (this.disposed || url === "") return;
    this.target = url;
    if (this.candidate === null || this.candidate.url === url) return;
    // The replacement on its way is for rooms the page no longer wants: drop it with its timers. A stream that seemed
    // dead still needs replacing, now for these rooms.
    this.dropCandidate();
    if (this.current?.suspect === true) this.open(false, true);
  }

  private dropCandidate(): void {
    const candidate = this.candidate;
    this.candidate = null;
    this.endHandover();
    this.abort(candidate);
  }

  /** Something suggests the connection may have changed (focus, the tab shown, back online, a timer gap). `slept`: the
   * device was suspended a while (a timer gap), so a probe waits only the short deadline. */
  wake(slept = false): void {
    if (this.disposed || this.target === "") return;
    if (this.suspendedAt !== null) { this.suspendedAt = null; this.open(); return; }
    if (this.waiting !== null) {
      // Right after an attempt, the wakeup brings the retry forward to the end of the spacing (never later than it was).
      const due = this.lastAttemptAt + WAKE_SPACING_MS - this.deps.now();
      if (due <= 0) this.open();
      else if (due < this.retryAt - this.deps.now()) this.schedule(due);
      return;
    }
    const current = this.current;
    if (current === null) { this.open(); return; }
    // Not up yet, or already being replaced: that attempt answers the question.
    if (!current.reading || this.candidate !== null) return;
    if (current.conn !== null && this.deps.now() >= this.pingQuietUntil) { this.probe(current, slept); return; }
    // A server that names no stream (or asked for no pings now) can't be probed: one that missed its tick is probably
    // dead under us. Replace it.
    if (this.deps.now() - current.lastByteAt > current.tickMs + 5_000) this.open(false, true);
  }

  /** The browser says the network went away: an open stream is tried again at once, so a dead one shows as offline. */
  offline(): void {
    if (this.disposed || this.target === "" || this.suspendedAt !== null) return;
    if (this.current !== null) this.open(false, true);
  }

  /** The page is leaving or entering the back/forward cache: close the stream (an open fetch can keep it out). */
  suspend(): void {
    if (this.disposed) return;
    this.retireAll();
    this.cancelRetry();
    this.waiting = null;
    this.heard.clear();
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

  private active(stream: Stream): boolean { return stream === this.current || stream === this.candidate; }

  private abort(stream: Stream | null): void {
    try { stream?.controller.abort(); } catch { /* already finished */ }
  }

  private endHandover(): void {
    if (this.handoverDue !== null) this.deps.clearTimeout(this.handoverDue);
    if (this.helloDue !== null) this.deps.clearTimeout(this.helloDue);
    this.handoverDue = this.helloDue = null;
  }

  /** Every stream goes: the current one and any replacement. Whatever they still say is never heard. */
  private retireAll(): void {
    this.endHandover();
    this.endProbe();
    const streams = [this.current, this.candidate];
    this.current = this.candidate = null;
    for (const stream of streams) this.abort(stream);
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
    this.retireAll();
    this.cancelRetry();
    this.waiting = null;
    this.attempt = 0;
    this.said = null;
    this.suspendedAt = null;
    this.heard.clear();
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
    if (gap > LIVE_GAP_MS) { this.wake(true); return; }
    const current = this.current;
    if (current?.reading === true && this.candidate === null && now - current.lastByteAt > current.tickMs * 2 + 5_000) this.open(false, true);
  }

  /** `suspect`: the stream is being replaced because it seemed dead. */
  private open(immediate = false, suspect = false): void {
    if (this.disposed || this.target === "") return;
    if (suspect && this.current !== null) this.current.suspect = true;
    this.cancelRetry();
    this.waiting = null;
    this.suspendedAt = null;
    this.endProbe();
    this.lastAttemptAt = this.deps.now();
    this.ensureBeat();
    const stream: Stream = { url: this.target, controller: new AbortController(), reading: false, openedAt: 0, lastByteAt: 0, tickMs: DEFAULT_TICK_MS, conn: null, helloAt: null, held: [],
      incarnation: null, synced: false, suspect: false };
    if (immediate || this.current === null || !this.current.reading) {
      // One stream at a time: the old one (and any replacement on its way) goes first.
      this.retireAll();
      this.current = stream;
      this.setState(this.said === null && this.attempt === 0 ? "connecting" : "reconnecting");
    } else {
      // Handover: the stream that is up keeps speaking beside its replacement (a newer replacement replaces an older one).
      this.abort(this.candidate);
      this.candidate = stream;
      // The absolute bound runs from the first replacement: a later one never extends the overlap.
      this.handoverDue ??= this.deps.setTimeout(() => { this.handoverDue = null; this.takeOver(); }, LIVE_HANDOVER_MAX_MS);
      if (this.helloDue !== null) this.deps.clearTimeout(this.helloDue);
      this.helloDue = this.deps.setTimeout(() => { this.helloDue = null; if (this.candidate === stream && stream.helloAt === null) this.takeOver(); }, LIVE_HANDOVER_HELLO_MS);
    }
    this.read(stream).catch(() => {
      // A fault in the reader itself, not the network: this browser goes back to the old way.
      if (this.active(stream) && !this.disposed) this.events.unusable();
    });
  }

  /** The replacement becomes the stream, in one step: the old stream is aborted (never heard again) and, if the
   * replacement is up, the page hears it is open and gets its held frames. A replacement for rooms the page no longer
   * wants is dropped instead (false). */
  private takeOver(): boolean {
    const next = this.candidate;
    if (next === null) return false;
    if (next.url !== this.target) { this.dropCandidate(); return false; }
    this.endHandover();
    this.endProbe();
    const old = this.current;
    this.candidate = null;
    this.current = next;
    this.abort(old);
    if (next.reading) this.up(next);
    else this.setState(this.said === null && this.attempt === 0 ? "connecting" : "reconnecting");
    return true;
  }

  /** A replacement that said `synced` takes over once it has caught up: for every room it holds that the page has heard
   * (each kind of frame but a refusal), it has said something too, and where both carry orders from this server run,
   * its newest is at least as new as what the page applied. Else it waits (within the handover's bounds). */
  private promoteIfCaughtUp(stream: Stream): void {
    if (stream !== this.candidate || !stream.synced) return;
    const newest = new Map<string, number | null>();
    for (const frame of stream.held) {
      const key = frameKey(frame);
      if (key === null) continue;
      const had = newest.get(key.slot);
      newest.set(key.slot, key.seq === null ? had ?? null : Math.max(had ?? 0, key.seq));
    }
    const rooms = new Set(new URLSearchParams(stream.url.slice(stream.url.indexOf("?") + 1)).getAll("room"));
    for (const [slot, applied] of this.heard) {
      const [room = "", event = ""] = slot.split("\u0000");
      if (!rooms.has(room) || event === "gone") continue;
      if (!newest.has(slot)) return;
      const seq = newest.get(slot) ?? null;
      if (seq !== null && applied.seq !== null && applied.incarnation === stream.incarnation && seq < applied.seq) return;
    }
    this.takeOver();
  }

  /** The current stream is up: the page hears it opened, then anything it held that is newer than what it has. */
  private up(stream: Stream): void {
    this.said = null;
    this.setState("live");
    this.events.opened(stream.url);
    const frames = stream.held;
    stream.held = [];
    // Each room's newest frame of each kind is the one that stands (a change, a presence, a reply's snapshot, a refusal):
    // the highest order, whatever order they arrived in (the last to arrive where none carries an order).
    const keys = frames.map(frameKey);
    const last = new Map<string, number>();
    keys.forEach((key, at) => {
      if (key === null) return;
      const kept = last.get(key.slot);
      const keptSeq = kept === undefined ? null : keys[kept]?.seq ?? null;
      if (kept === undefined || key.seq === null || keptSeq === null || key.seq >= keptSeq) last.set(key.slot, at);
    });
    for (const [at, frame] of frames.entries()) {
      if (this.current !== stream) return;
      const key = keys[at] ?? null;
      if (key !== null && last.get(key.slot) !== at) continue;
      this.apply(stream, frame);
    }
  }

  /** A room frame from the current stream (or a promoted replacement's held one): applied unless the page already has
   * it or something newer for that room and kind. */
  private apply(stream: Stream, frame: SseFrame): void {
    const key = frameKey(frame);
    if (key !== null) {
      const applied = this.heard.get(key.slot);
      if (applied !== undefined) {
        const comparable = key.seq !== null && applied.seq !== null && applied.incarnation === stream.incarnation;
        // No newer than what the page has (or the very same words): dropped.
        if ((comparable && key.seq! <= applied.seq!) || applied.same === key.same) return;
      }
      this.heard.set(key.slot, { same: key.same, incarnation: stream.incarnation, seq: key.seq });
    }
    try { this.events.frame(frame.event, frame.data); }
    catch (error) { queueMicrotask(() => { throw error; }); }
  }

  private async read(stream: Stream): Promise<void> {
    let response: Response;
    try {
      response = await this.deps.fetch(stream.url, { headers: { accept: "text/event-stream", [LIVE_FRAMES_HEADER]: "1" }, credentials: "same-origin", cache: "no-store", redirect: "manual", signal: stream.controller.signal });
    } catch {
      if (this.active(stream)) this.failed(stream, "network");
      return;
    }
    if (!this.active(stream)) { void response.body?.cancel().catch(() => undefined); return; }
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => undefined); this.failed(stream, "refused"); return; }
    if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("text/event-stream")) { void response.body?.cancel().catch(() => undefined); this.failed(stream, "error"); return; }
    const body = response.body;
    if (body === null || typeof body.getReader !== "function") { this.events.unusable(); return; }
    const reader = body.getReader();
    const parser = new SseParser(), decoder = new TextDecoder();
    stream.reading = true;
    stream.openedAt = stream.lastByteAt = this.deps.now();
    if (stream === this.current) this.up(stream);
    try {
      for (;;) {
        if (!this.active(stream)) { void reader.cancel().catch(() => undefined); return; }
        const { done, value } = await reader.read();
        if (!this.active(stream)) { void reader.cancel().catch(() => undefined); return; }
        if (done) break;
        const now = this.deps.now();
        stream.lastByteAt = now;
        if (stream === this.current) {
          if (now - stream.openedAt >= LIVE_STABLE_MS) this.attempt = 0;
          // Anything at all on the stream after a ping went out proves it alive.
          if (this.probing?.stream === stream) this.endProbe();
        }
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (!this.active(stream) || !this.take(stream, frame)) return;
        }
      }
    } catch {
      if (this.active(stream)) this.failed(stream, "network");
      return;
    }
    if (this.active(stream)) this.failed(stream, "dropped");
  }

  /** One frame from a live stream; false when that stream has finished. */
  private take(stream: Stream, frame: SseFrame): boolean {
    switch (frame.event) {
      case "hello": this.hello(stream, frame.data); return true;
      case "tick": case "pong": return true;
      // Its rooms have all said where they stand: the replacement takes over.
      case "synced": if (stream === this.candidate) { stream.synced = true; this.promoteIfCaughtUp(stream); } return true;
      // Every room refused this page: signed out, or its access went. Stop and wait, as for a 401.
      case "ended": this.failed(stream, "refused"); return false;
    }
    if (stream === this.current) { this.apply(stream, frame); return true; }
    stream.held.push(frame);
    if (stream.held.length > HANDOVER_HELD_MAX) this.takeOver();
    else this.promoteIfCaughtUp(stream);
    return true;
  }

  private hello(stream: Stream, raw: string): void {
    stream.helloAt = this.deps.now();
    try {
      const said = JSON.parse(raw) as Record<string, unknown>;
      const tick: unknown = said["tick"], conn: unknown = said["conn"], incarnation: unknown = said["incarnation"];
      if (typeof incarnation === "string" && incarnation.length <= 64) stream.incarnation = incarnation;
      if (typeof tick === "number" && Number.isFinite(tick) && tick >= 1_000 && tick <= 120_000) stream.tickMs = tick;
      if (typeof conn === "string" && CONN_NAME.test(conn)) stream.conn = conn;
    } catch { /* a hello without a tick keeps the default */ }
  }

  /** A stream failed. The old stream dying while its replacement is on the way hands over now; anything else (the
   * replacement failing, a refusal, the only stream dropping) is the page's stream failing: one attempt, then backoff. */
  private failed(stream: Stream, kind: Failure): void {
    if (stream === this.current && this.candidate !== null && kind !== "refused" && this.takeOver()) return;
    this.fail(kind);
  }

  /**
   * Is the stream that is up still alive? GET /live/ping asks the server for a `pong` on it. Any frame on the stream
   * after this proves it alive (read() ends the probe). The ping's 204 doesn't prove it dead: only a silence after it
   * does. No answer at all by the deadline is dead too. Dead: the stream is replaced (by handover).
   */
  private probe(stream: Stream, slept: boolean): void {
    if (this.probing !== null) return;
    const near = this.deps.near();
    const probe: Probe = { stream, controller: new AbortController(), silence: null, deadline: null };
    this.probing = probe;
    const dead = (): void => {
      if (this.probing !== probe) return;
      this.endProbe();
      if (this.current === stream && this.candidate === null) this.open(false, true);
    };
    probe.deadline = this.deps.setTimeout(dead, near || slept ? LIVE_PROBE_DEADLINE_NEAR_MS : LIVE_PROBE_DEADLINE_FAR_MS);
    this.pings += 1;
    let answer: Promise<Response>;
    try {
      answer = this.deps.fetch(`/live/ping?conn=${stream.conn ?? ""}&n=${this.pings}`, { credentials: "same-origin", cache: "no-store", redirect: "manual", signal: probe.controller.signal });
    } catch { dead(); return; }
    answer.then(response => {
      void response.body?.cancel().catch(() => undefined);
      if (this.probing !== probe) return;
      // The pong may still be on its way: only silence after the 204 means dead. Any other answer: the server doesn't
      // know this stream (it restarted, or the stream ended there), or this page is signed out.
      if (response.status === 204) probe.silence = this.deps.setTimeout(dead, near ? LIVE_PROBE_SILENCE_NEAR_MS : LIVE_PROBE_SILENCE_FAR_MS);
      else if (response.status === 429) {
        // The server's ping budget is spent: no verdict. No pings until its Retry-After; meanwhile only the stream's own
        // tick can prove it (no pong is coming), so silence past a tick and its margin is what means dead.
        const said = response.headers.get("retry-after"), after = said !== null && /^[0-9]{1,6}$/.test(said.trim()) ? Number(said.trim()) : 10;
        this.pingQuietUntil = this.deps.now() + Math.min(60, Math.max(1, after)) * 1_000;
        if (probe.deadline !== null) this.deps.clearTimeout(probe.deadline);
        probe.deadline = null;
        probe.silence = this.deps.setTimeout(dead, Math.max(0, stream.lastByteAt + stream.tickMs + 5_000 - this.deps.now()));
      }
      else dead();
    }, dead);
  }

  private endProbe(): void {
    const probe = this.probing;
    if (probe === null) return;
    this.probing = null;
    if (probe.silence !== null) this.deps.clearTimeout(probe.silence);
    if (probe.deadline !== null) this.deps.clearTimeout(probe.deadline);
    try { probe.controller.abort(); } catch { /* already answered */ }
  }

  private fail(kind: Failure): void {
    this.retireAll();
    this.heard.clear();
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
