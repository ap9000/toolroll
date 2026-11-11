/**
 * Reading a page ahead (docs/plans/live-pages-and-home.md A2.1).
 *
 * A link the click handler would follow in place, to a page the server reads ahead (server/in-place.ts
 * PREFETCH_ROUTES), is read with `x-toolroll-read: prefetch` when the pointer rests on it for 65 ms, on `touchstart`
 * and on keyboard focus. The server never mints an approval nonce for such a read and never extends the session; it
 * answers 204 for anything it does not read ahead, which is simply no page here.
 *
 * What is read is data only, kept in memory: at most two reads at once, at most 20 pages, each good for 10 seconds,
 * and all of them dropped when the workspace's room says something changed or the page is nudged (an act in place).
 * Nothing here mounts a page: a page read ahead is shown only when the person follows its link, and then only `inert`
 * until the ordinary read confirms it (navigate.ts).
 */
import type { BrowserWorkspace } from "../browser-workspace.js";
import { LIVE_EVENT } from "./live.js";
import { WORKSPACE_NUDGE } from "./live-task.js";
import { readPage } from "./workspace-client.js";

export const PREFETCH_REST_MS = 65;
export const PREFETCH_TTL_MS = 10_000;
export const PREFETCH_MAX_PAGES = 20;
export const PREFETCH_MAX_READS = 2;

/** The addresses the server reads ahead (server/in-place.ts PREFETCH_ROUTES); the server still decides. */
const READ_AHEAD = [/^\/$/, /^\/tasks$/, /^\/t\/[^/]+$/, /^\/projects$/, /^\/agents$/, /^\/search$/];
export function mayPrefetch(url: URL): boolean {
  return READ_AHEAD.some(pattern => pattern.test(url.pathname)) && !(url.pathname === "/agents" && url.searchParams.get("view") === "live");
}

/** One page's key: its path and query, without the hash or the parts a page read ignores. */
export function prefetchKey(url: URL): string {
  const query = new URLSearchParams(url.search);
  for (const name of ["format", "request", "draft"]) query.delete(name);
  const search = query.toString();
  return url.pathname + (search === "" ? "" : `?${search}`);
}

const pages = new Map<string, { page: BrowserWorkspace; at: number }>();
const reads = new Map<string, { stop: AbortController; done: Promise<BrowserWorkspace | null> }>();
/** Moves whenever everything is dropped: a read begun before lands on nothing. */
let generation = 0;
let now: () => number = () => Date.now();

/** TESTS ONLY: a clock of the test's own. */
export function setPrefetchClock(next: () => number): () => void { const before = now; now = next; return () => { now = before; }; }

/** Whether reading ahead is on at all: not when the browser asks to save data, not in a hidden tab. */
export function prefetchAllowed(): boolean {
  if (document.hidden) return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData !== true;
}

/** Drop every page read ahead and every read under way. */
export function dropPrefetched(): void {
  generation += 1;
  pages.clear();
  for (const read of reads.values()) read.stop.abort();
  reads.clear();
}

/** Read `url` ahead, unless it is kept already, being read, not read ahead at all, or two reads are under way. */
export function prefetch(url: URL): void {
  if (!prefetchAllowed() || !mayPrefetch(url) || url.origin !== window.location.origin) return;
  const key = prefetchKey(url);
  const kept = pages.get(key);
  if ((kept !== undefined && now() - kept.at < PREFETCH_TTL_MS) || reads.has(key) || reads.size >= PREFETCH_MAX_READS) return;
  const mine = generation;
  const stop = new AbortController();
  const done = readPage(key, "prefetch", fetch, stop.signal).then(page => {
    if (reads.get(key)?.stop === stop) reads.delete(key);
    if (page === null || mine !== generation) return null;
    pages.delete(key);
    pages.set(key, { page, at: now() });
    while (pages.size > PREFETCH_MAX_PAGES) pages.delete(pages.keys().next().value!);
    return page;
  });
  reads.set(key, { stop, done });
}

/** What is known ahead of a click on `url`: a page read ahead (taken: it is used once), a read still under way, or
 * nothing. */
export function takePrefetched(url: URL): { page: BrowserWorkspace } | { pending: Promise<BrowserWorkspace | null> } | null {
  const key = prefetchKey(url);
  const kept = pages.get(key);
  pages.delete(key);
  if (kept !== undefined && now() - kept.at < PREFETCH_TTL_MS) return { page: kept.page };
  const read = reads.get(key);
  if (read === undefined) return null;
  const mine = generation;
  return { pending: read.done.then(page => { if (mine !== generation) return null; pages.delete(key); return page; }) };
}

/** TESTS ONLY: what is kept. */
export function prefetchedKeys(): string[] { return [...pages.keys()]; }

/** The listeners: which link may be read ahead is the navigator's to say (the same rules as a click it takes over). */
export function installPrefetch(linkOf: (anchor: Element) => URL | null): () => void {
  let resting: { anchor: Element; timer: ReturnType<typeof setTimeout> } | null = null;
  const anchorOf = (target: EventTarget | null): Element | null => target instanceof Element ? target.closest("a[href]") : null;
  const ahead = (anchor: Element | null) => {
    if (anchor === null) return;
    const url = linkOf(anchor);
    if (url !== null) prefetch(url);
  };
  const rest = () => { if (resting !== null) clearTimeout(resting.timer); resting = null; };
  const over = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const anchor = anchorOf(event.target);
    if (anchor === resting?.anchor) return;
    rest();
    if (anchor === null) return;
    resting = { anchor, timer: setTimeout(() => { resting = null; ahead(anchor); }, PREFETCH_REST_MS) };
  };
  const out = (event: PointerEvent) => {
    if (resting === null) return;
    const to = event.relatedTarget;
    if (to instanceof Node && resting.anchor.contains(to)) return;
    rest();
  };
  const touch = (event: TouchEvent) => { ahead(anchorOf(event.target)); };
  const focus = (event: FocusEvent) => {
    const anchor = anchorOf(event.target);
    // Keyboard focus only: a pointer press focuses the link on its way to a click the navigator takes anyway.
    let keyboard = true;
    try { keyboard = anchor?.matches(":focus-visible") ?? false; } catch { /* the selector is unknown: treat as keyboard */ }
    if (keyboard) ahead(anchor);
  };
  const changed = (event: Event) => {
    const detail = (event as CustomEvent<{ room?: unknown; event?: unknown }>).detail;
    if (detail?.room === "workspace" && detail.event === "change") dropPrefetched();
  };
  document.addEventListener("pointerover", over, { passive: true });
  document.addEventListener("pointerout", out, { passive: true });
  document.addEventListener("touchstart", touch, { passive: true });
  document.addEventListener("focusin", focus);
  window.addEventListener(LIVE_EVENT, changed);
  window.addEventListener(WORKSPACE_NUDGE, dropPrefetched);
  return () => {
    rest();
    dropPrefetched();
    document.removeEventListener("pointerover", over);
    document.removeEventListener("pointerout", out);
    document.removeEventListener("touchstart", touch);
    document.removeEventListener("focusin", focus);
    window.removeEventListener(LIVE_EVENT, changed);
    window.removeEventListener(WORKSPACE_NUDGE, dropPrefetched);
  };
}
