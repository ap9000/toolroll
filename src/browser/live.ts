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
 */
import { useEffect, useRef } from "react";

export type LiveEventName = "change" | "here" | "gone" | "turn" | "reload" | "lost";
export type LiveListener = (event: LiveEventName, data: Record<string, unknown>) => void;
export const LIVE_EVENT = "so:live";
const EVENTS = ["change", "here", "gone", "turn"] as const;
const RETRY_MS = 30_000;

export const roomName = (kind: string, id?: string | number | null, params?: Record<string, string | number | boolean | null | undefined>): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) if (value !== null && value !== undefined && value !== false) query.set(key, value === true ? "1" : String(value));
  const tail = query.toString();
  return `${kind}${id === null || id === undefined ? "" : `:${encodeURIComponent(String(id))}`}${tail === "" ? "" : `?${tail}`}`;
};

class LiveHub {
  private readonly subscriptions = new Map<number, { room: string; listener: LiveListener; hidden: boolean }>();
  private next = 0;
  private source: EventSource | null = null;
  private url = "";
  private scheduled = false;
  private watching = false;

  /** `hidden`: the room stays joined while the tab is hidden (the summary: a count, never a watch). Every other room
   * leaves with the tab, so a hidden tab never counts as watching anything. */
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
    const rooms = [...new Set([...this.subscriptions.values()].filter(one => !hidden || one.hidden).map(one => one.room))].sort();
    return rooms.length === 0 ? "" : `/live?${rooms.map(room => `room=${encodeURIComponent(room)}`).join("&")}`;
  }

  private reconcile(): void {
    if (typeof EventSource === "undefined" || typeof document === "undefined") return;
    if (!this.watching) {
      this.watching = true;
      document.addEventListener("visibilitychange", () => this.reconcile());
      window.addEventListener("online", () => this.reconcile());
    }
    const url = this.wanted(document.hidden);
    if (url === this.url && (url === "" || this.source !== null)) return;
    this.source?.close();
    this.source = null;
    this.url = url;
    // Server-rendered regions on this page follow this stream rather than open their own.
    if (url === "") { delete document.documentElement.dataset["live"]; return; }
    document.documentElement.dataset["live"] = "1";
    const source = new EventSource(url);
    this.source = source;
    const deliver = (event: LiveEventName, raw: string): void => {
      let data: Record<string, unknown> = {};
      try { const parsed: unknown = JSON.parse(raw); if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>; } catch { /* an empty hint */ }
      const room = typeof data["room"] === "string" ? data["room"] : null;
      for (const one of [...this.subscriptions.values()]) if (room === null || one.room === room) one.listener(event, data);
      window.dispatchEvent(new CustomEvent(LIVE_EVENT, { detail: { room, event, data } }));
    };
    for (const name of EVENTS) source.addEventListener(name, event => deliver(name, (event as MessageEvent<string>).data));
    // The server's stream fell behind and ended: every part reads again; the browser reconnects.
    source.addEventListener("reload", () => deliver("reload", "{}"));
    source.addEventListener("error", () => {
      if (source.readyState !== EventSource.CLOSED || this.source !== source) return;
      this.source = null;
      this.url = "";
      deliver("lost", "{}");
      // The browser gave up (an error answer, not a dropped line): try once more in a while.
      window.setTimeout(() => this.reconcile(), RETRY_MS);
    });
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
export function useLiveRoom(room: string | null, listener: LiveListener, keepWhenHidden = false): void {
  const current = useRef(listener);
  current.current = listener;
  useEffect(() => {
    if (room === null) return;
    return hub.subscribe(room, (event, data) => current.current(event, data), keepWhenHidden);
  }, [room, keepWhenHidden]);
}
