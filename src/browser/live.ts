/**
 * One live stream per page (GET /live). Every part of the page that follows
 * something joins its room here — the workspace, a task, a flow, the chat's
 * running reply, the team conversation — and the page keeps one EventSource
 * for all of them. Events are hints: a `change` asks a part to read itself
 * again the usual way; nothing here carries page content except the chat's
 * reply preview and the summary room's project counts (its `change` carries them).
 *
 * Rooms are named `<kind>[:<id>][?<params>]`. A hidden tab leaves every room
 * but the summary (it isn't "here", and that frees the browser's few
 * connections) and rejoins them when shown; the summary stays, so the tab's
 * title can keep its count. The browser reconnects a dropped stream by itself;
 * when it gives up, every room hears `lost`, so a part can read once and show
 * what the read says (signed out, offline).
 *
 * Pages rendered by the server join through the same stream: each event is
 * also dispatched on `window` as `so:live` ({ room, event, data }).
 *
 * Where the server marks the page (`data-live-reader="stream"` on the workspace) and the browser can, the stream is read
 * with fetch by one supervisor (live-supervisor.ts) that owns every retry, sees the server's tick, wakes on focus,
 * network and sleep, and says where the connection stands (useLiveConnection). There a hidden tab leaves its watching
 * rooms (a task's, a flow's, an agent's: presence and watches) at once and keeps the observational ones (the
 * workspace, the summary, a conversation) for LIVE_HIDDEN_GRACE_MS, then closes its stream. Anywhere else, or if the
 * fetch reader can't work here, the page keeps its EventSource exactly as before.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { browserSupervisorDeps, fetchStreamsSupported, LIVE_HIDDEN_GRACE_MS, LiveSupervisor, type LiveConnectionState, type SupervisorDeps } from "./live-supervisor.js";

/** `retrying`: the line dropped and the browser is reconnecting by itself (what is shown may be stale until the next
 * `change`); `lost`: it gave up. */
export type LiveEventName = "change" | "here" | "gone" | "turn" | "reload" | "lost" | "retrying";
export type LiveListener = (event: LiveEventName, data: Record<string, unknown>) => void;
export const LIVE_EVENT = "so:live";
const EVENTS = ["change", "here", "gone", "turn"] as const;
const RETRY_MS = 30_000;
/** After the server refused a room (`gone`), how long a page waits for the stream's own verdict before it reopens. */
const REFUSAL_SETTLE_MS = 2_000;

export const roomName = (kind: string, id?: string | number | null, params?: Record<string, string | number | boolean | null | undefined>): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) if (value !== null && value !== undefined && value !== false) query.set(key, value === true ? "1" : String(value));
  const tail = query.toString();
  return `${kind}${id === null || id === undefined ? "" : `:${encodeURIComponent(String(id))}`}${tail === "" ? "" : `?${tail}`}`;
};

/** Rooms that only observe (a count, the workspace's revision, a conversation): a hidden tab may keep them a while.
 * Every other room is a watch or a presence (task, flow, agent, agents-live) and leaves the moment the tab hides. */
const OBSERVATIONAL_ROOMS = new Set(["workspace", "summary", "chat", "team"]);
const roomKind = (room: string): string => room.split(/[:?]/, 1)[0] ?? "";
const roomsOf = (url: string): string[] => url === "" ? [] : new URLSearchParams(url.slice(url.indexOf("?") + 1)).getAll("room");
/** How the page reads its stream: `stream` (fetch, supervised) where the server marks the page and the browser can. */
export type LiveReader = "stream" | "eventsource";
function pickReader(): LiveReader {
  if (typeof document === "undefined") return "eventsource";
  const marked = document.getElementById("standing-orders-workspace")?.dataset["liveReader"] === "stream";
  return marked && fetchStreamsSupported() ? "stream" : "eventsource";
}

export class LiveHub {
  private readonly subscriptions = new Map<number, { room: string; listener: LiveListener; hidden: boolean }>();
  private next = 0;
  private source: EventSource | null = null;
  private url = "";
  /** The rooms the open stream still holds on the server: its rooms, less each one it heard `gone` for. */
  private held = new Set<string>();
  /** When the open stream last heard a room refused, and the reopen waiting on it. */
  private refusedAt = 0;
  private settling: number | null = null;
  /** After the stream ended or was given up on, no new one opens before this (its retry timer reconciles then). */
  private quietUntil = 0;
  private scheduled = false;
  private watching = false;
  /** A sensitive page (a password field, a one-time secret) opens no live connection at all, whoever asks for a room. */
  private quiet = false;
  /** Chosen at the first reconcile; `stream` falls back to `eventsource` for good if its reader can't work here. */
  private reader: LiveReader | null;
  private supervisor: LiveSupervisor | null = null;
  private readonly deps: Partial<SupervisorDeps>;
  private connection: LiveConnectionState = "idle";
  private readonly stateListeners = new Set<() => void>();
  /** When this tab was hidden (stream reader only), and the timer that releases its stream after the grace. */
  private hiddenSince: number | null = null;
  private graceTimer: number | null = null;

  constructor(options: { reader?: LiveReader; deps?: Partial<SupervisorDeps> } = {}) {
    this.reader = options.reader ?? null;
    this.deps = options.deps ?? {};
  }

  /** Where the page's stream stands (always `idle` on the EventSource reader, which has no supervisor). */
  connectionState = (): LiveConnectionState => this.connection;
  onConnectionState = (listener: () => void): (() => void) => { this.stateListeners.add(listener); return () => { this.stateListeners.delete(listener); }; };

  setQuiet(on: boolean): void {
    if (this.quiet === on) return;
    this.quiet = on;
    this.schedule();
  }

  /** `hidden`: the room stays joined while the tab is hidden (the summary: a count, never a watch). Every other room
   * leaves with the tab, so a hidden tab never counts as watching anything. (The stream reader decides by the room's
   * kind instead: observational rooms stay through the grace, watching rooms never.) */
  subscribe(room: string, listener: LiveListener, hidden = false): () => void {
    const id = this.next++;
    this.subscriptions.set(id, { room, listener, hidden });
    this.schedule();
    return () => { this.subscriptions.delete(id); this.schedule(); };
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    // Parts mount and unmount together: settle the room list once per turn.
    queueMicrotask(() => { this.scheduled = false; this.reconcile(); });
  }

  private wanted(hidden: boolean): string {
    if (this.quiet) return "";
    const stream = this.reader === "stream";
    // Past the grace a hidden tab holds no stream at all; its title keeps the last count it heard.
    if (stream && hidden && this.hiddenSince !== null && Date.now() - this.hiddenSince >= LIVE_HIDDEN_GRACE_MS) return "";
    const keeps = (one: { room: string; hidden: boolean }): boolean => !hidden || (stream ? OBSERVATIONAL_ROOMS.has(roomKind(one.room)) : one.hidden);
    const rooms = [...new Set([...this.subscriptions.values()].filter(keeps).map(one => one.room))].sort();
    return rooms.length === 0 ? "" : `/live?${rooms.map(room => `room=${encodeURIComponent(room)}`).join("&")}`;
  }

  private unsettle(): void {
    if (this.settling !== null) window.clearTimeout(this.settling);
    this.settling = null;
  }

  /** One event to the rooms it names (or every room, when it names none) and to the page's server-rendered regions. */
  private deliver(event: LiveEventName, raw: string): void {
    let data: Record<string, unknown> = {};
    try { const parsed: unknown = JSON.parse(raw); if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>; } catch { /* an empty hint */ }
    const room = typeof data["room"] === "string" ? data["room"] : null;
    for (const one of [...this.subscriptions.values()]) if (room === null || one.room === room) one.listener(event, data);
    window.dispatchEvent(new CustomEvent(LIVE_EVENT, { detail: { room, event, data } }));
  }

  private setConnection(next: LiveConnectionState): void {
    if (this.connection === next) return;
    this.connection = next;
    if (next === "idle") delete document.documentElement.dataset["liveState"];
    else document.documentElement.dataset["liveState"] = next;
    for (const listener of [...this.stateListeners]) listener();
  }

  private reconcile(): void {
    if (typeof document === "undefined") return;
    this.reader ??= pickReader();
    if (this.reader === "stream") { this.reconcileStream(); return; }
    if (typeof EventSource === "undefined") return;
    if (!this.watching) {
      this.watching = true;
      document.addEventListener("visibilitychange", () => this.reconcile());
      // Back online: the network was the problem, so try now rather than at the retry.
      window.addEventListener("online", () => { this.quietUntil = 0; this.reconcile(); });
    }
    const url = this.wanted(document.hidden);
    if (url === this.url && (url === "" || this.source !== null)) return;
    // A room the server refused (`gone`) has already left the open stream, so a page that drops just those rooms keeps
    // it as it is: reopening at once would race the stream's own end (a sign-out answers every room `gone`, then
    // `ended`) into a request that can't sign in.
    const rooms = roomsOf(url);
    if (this.source !== null && rooms.length > 0 && rooms.length === this.held.size && rooms.every(room => this.held.has(room))) { this.url = url; return; }
    // Just refused: a sign-out answers every room `gone` and then `ended`, and the page drops rooms as it hears them. Wait
    // for the stream's verdict before reopening — `ended` closes it for the retry; a stream still open after this
    // (one room narrowed, the rest fine) reopens with the rooms wanted then.
    // The stream just ended (refused) or was given up on: whatever the page drops or adds meanwhile waits for the retry.
    if (url !== "" && Date.now() < this.quietUntil) return;
    const waited = Date.now() - this.refusedAt;
    if (this.source !== null && url !== "" && waited < REFUSAL_SETTLE_MS) {
      if (this.settling === null) this.settling = window.setTimeout(() => { this.settling = null; this.reconcile(); }, REFUSAL_SETTLE_MS - waited);
      return;
    }
    this.unsettle();
    this.source?.close();
    this.source = null;
    this.url = url;
    // Server-rendered regions on this page follow this stream rather than open their own.
    if (url === "") { delete document.documentElement.dataset["live"]; return; }
    document.documentElement.dataset["live"] = "1";
    const source = new EventSource(url);
    this.source = source;
    this.held = new Set(roomsOf(url));
    this.refusedAt = 0;
    for (const name of EVENTS) source.addEventListener(name, event => {
      const raw = (event as MessageEvent<string>).data;
      if (name === "gone" && this.source === source) this.heardGone(raw);
      this.deliver(name, raw);
    });
    // The server's stream fell behind and ended: every part reads again; the browser reconnects.
    source.addEventListener("reload", () => this.deliver("reload", "{}"));
    // Every room refused this page (it was signed out, or lost its access): stop, rather than let the browser reconnect at
    // once into a request that can't sign in; try once more in a while, as after an error answer.
    source.addEventListener("ended", () => {
      if (this.source !== source) return;
      this.unsettle();
      source.close();
      this.source = null;
      this.url = "";
      this.deliver("lost", "{}");
      this.quietUntil = Date.now() + RETRY_MS;
      window.setTimeout(() => this.reconcile(), RETRY_MS);
    });
    source.addEventListener("error", () => {
      if (this.source !== source) return;
      if (source.readyState !== EventSource.CLOSED) { this.deliver("retrying", "{}"); return; }
      this.source = null;
      this.url = "";
      this.deliver("lost", "{}");
      // The browser gave up (an error answer, not a dropped line): try once more in a while.
      this.quietUntil = Date.now() + RETRY_MS;
      window.setTimeout(() => this.reconcile(), RETRY_MS);
    });
  }

  private heardGone(raw: string): void {
    this.refusedAt = Date.now();
    try { const room: unknown = (JSON.parse(raw) as Record<string, unknown>)["room"]; if (typeof room === "string") this.held.delete(room); } catch { /* no room named */ }
  }

  /** The supervised reader: the same room rules, one owner for the stream and its retries. */
  private reconcileStream(): void {
    const supervisor = this.supervisor ?? this.startSupervisor();
    const url = this.wanted(document.hidden);
    if (url === supervisor.wanted) return;
    // As above: rooms the server already let go leave the open stream as it is.
    const rooms = roomsOf(url);
    if (supervisor.live && rooms.length > 0 && rooms.length === this.held.size && rooms.every(room => this.held.has(room))) { supervisor.retarget(url); return; }
    const waited = Date.now() - this.refusedAt;
    if (supervisor.live && url !== "" && waited < REFUSAL_SETTLE_MS) {
      if (this.settling === null) this.settling = window.setTimeout(() => { this.settling = null; this.reconcile(); }, REFUSAL_SETTLE_MS - waited);
      return;
    }
    this.unsettle();
    if (url === "") delete document.documentElement.dataset["live"];
    else document.documentElement.dataset["live"] = "1";
    supervisor.want(url);
  }

  private startSupervisor(): LiveSupervisor {
    const supervisor = new LiveSupervisor({ ...browserSupervisorDeps(), ...this.deps }, {
      opened: url => { this.held = new Set(roomsOf(url)); this.refusedAt = 0; },
      frame: (event, raw) => {
        if (event === "reload") { this.deliver("reload", "{}"); return; }
        if (!(EVENTS as readonly string[]).includes(event)) return;
        if (event === "gone") this.heardGone(raw);
        this.deliver(event as LiveEventName, raw);
      },
      trouble: kind => { this.unsettle(); this.deliver(kind, "{}"); },
      state: state => this.setConnection(state),
      unusable: () => this.fallBack(),
    });
    this.supervisor = supervisor;
    const wake = (): void => supervisor.wake();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.hiddenSince ??= Date.now();
        if (this.graceTimer === null) this.graceTimer = window.setTimeout(() => { this.graceTimer = null; this.reconcile(); }, LIVE_HIDDEN_GRACE_MS);
      } else {
        this.hiddenSince = null;
        if (this.graceTimer !== null) window.clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
      this.reconcile();
      if (!document.hidden) wake();
    });
    window.addEventListener("online", wake);
    window.addEventListener("offline", () => supervisor.offline());
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", event => { if ((event as PageTransitionEvent).persisted) supervisor.resume(); else wake(); });
    window.addEventListener("pagehide", () => supervisor.suspend());
    document.addEventListener("resume", wake);
    (navigator as Navigator & { connection?: EventTarget }).connection?.addEventListener?.("change", wake);
    return supervisor;
  }

  /** The fetch reader can't work in this browser: the page goes back to its EventSource, as before this reader. */
  private fallBack(): void {
    if (this.reader !== "stream") return;
    this.supervisor?.dispose();
    this.reader = "eventsource";
    this.setConnection("idle");
    this.reconcile();
  }
}

const hub = new LiveHub();


/** Rooms a server-rendered region may ask the page's stream for (chrome.ts regionScript): it pushes the name onto
 * `window.__soLiveRooms`, before or after this module loads, and hears its events as `so:live`. */
const REGION_ROOMS = new Set(["workspace"]);
if (typeof window !== "undefined") {
  const holder = window as unknown as { __soLiveRooms?: unknown };
  const join = (room: unknown): number => { if (typeof room === "string" && REGION_ROOMS.has(room)) hub.subscribe(room, () => {}); return 0; };
  const asked = holder.__soLiveRooms;
  if (Array.isArray(asked)) for (const room of asked) join(room);
  holder.__soLiveRooms = { push: join };
}

/** Join a room for as long as the component shows it; null joins nothing. The listener may change freely.
 * `keepWhenHidden`: stay joined while the tab is hidden (only for a room that is never a watch). */
/** Whether this page may hold a live connection: false on a sensitive page (the workspace sets it before it renders). */
export function setLiveQuiet(on: boolean): void { hub.setQuiet(on); }

export function useLiveRoom(room: string | null, listener: LiveListener, keepWhenHidden = false): void {
  const current = useRef(listener);
  current.current = listener;
  useEffect(() => {
    if (room === null) return;
    return hub.subscribe(room, (event, data) => current.current(event, data), keepWhenHidden);
  }, [room, keepWhenHidden]);
}

/** Join a room outside a component (the app's page work, page-work.ts): the listener hears the room's events and the
 * ones no room names, until the function returned is called. */
export function joinLiveRoom(room: string, listener: LiveListener): () => void { return hub.subscribe(room, listener); }

/** Where the page's live connection stands, for the shell's indicator (`idle` on a page that reads no stream). */
export function useLiveConnection(): LiveConnectionState {
  return useSyncExternalStore(hub.onConnectionState, hub.connectionState, () => "idle");
}
