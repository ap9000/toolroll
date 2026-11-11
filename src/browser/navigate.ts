/**
 * Following a link without a document load (docs/plans/live-pages-and-home.md A1.5).
 *
 * One `click` listener on `document`, in the bubble phase, so every component's own handler has run first (Home's row
 * selection and the menu's Search panel prevent the default and are left alone). A click is followed in place only
 * when nothing about it is in doubt; any doubt, at any step, is an ordinary document load of the same address, so the
 * browser does exactly what it does today (a sign-in, a download, an error page). Native forms are not touched here.
 *
 * The page on screen and the page read must both say `inPlace`, and every workspace that reaches the screen passes the
 * app's one door (`acceptWorkspace`, app.tsx), which loads a sensitive page as its own document.
 *
 * A2 (the same plan): a page read ahead (prefetch.ts) is shown at once, `inert`, and replaced by a remount from the
 * ordinary read when it lands; without one, the pressed link is marked at once and a 2px line runs along the top of the
 * content column after 150 ms. The change moves only the page content (transition.ts). Back restores where the page
 * was left, from `history.state`. Once this document has started leaving, nothing here loads, shows or pushes anything.
 */
import type { BrowserWorkspace } from "../browser-workspace.js";
import { installPrefetch, mayPrefetch, prefetch, takePrefetched } from "./prefetch.js";
import { directionOf, skipTransition, swap } from "./transition.js";
import { readPage } from "./workspace-client.js";

/** What the app gives the navigator: the page on screen, the one door, and the swap. */
export type InPlaceHost = {
  /** The workspace on screen now: the page being left. */
  current(): BrowserWorkspace;
  /** The app's door (app.tsx acceptWorkspace): true to show `next`; false when it loaded a document instead. `confirm`:
   * `next` is the ordinary read of a page already shown from a read ahead. */
  accept(next: BrowserWorkspace, href: string, replace: boolean, how: "navigate" | "confirm"): boolean;
  /** Show `next` as a new page, synchronously (the DOM holds it when this returns). `provisional`: a page read ahead,
   * shown until its ordinary read confirms it; nothing of it may act meanwhile. */
  show(next: BrowserWorkspace, provisional: boolean): void;
};

/** The addresses the server may answer in place (server/in-place.ts IN_PLACE_ROUTES): anything else is a document load
 * at once, without a read first (a download, an export, a page that always loads as one). The server still decides. */
const MAY_BE_IN_PLACE = [/^\/$/, /^\/tasks$/, /^\/t\/[^/]+$/, /^\/projects$/, /^\/agents$/, /^\/search$/, /^\/settings(?:\/[a-z-]+)?$/];
export function mayBeInPlace(url: URL): boolean {
  return MAY_BE_IN_PLACE.some(pattern => pattern.test(url.pathname)) && !(url.pathname === "/agents" && url.searchParams.get("view") === "live");
}

/** How a document load happens: replaced in tests, never anywhere else. */
let load: (href: string, replace: boolean) => void = (href, replace) => { if (replace) window.location.replace(href); else window.location.assign(href); };
/** Load `href` as a document, unless this document is already leaving: a load started by a script must never cancel a
 * navigation the browser began first (a full-load link, the address bar, Back to another document). */
export function loadDocument(href: string, replace = false): void { if (!documentLeaving()) load(href, replace); }
/** TESTS ONLY: watch document loads instead of making them. */
export function setDocumentLoader(next: (href: string, replace: boolean) => void): () => void {
  const before = load;
  load = next;
  return () => { load = before; };
}

/** The address a link would be followed to in place, or null: no `target`, no `download`, no `data-full-load`, same
 * origin, and not a move within this page. */
export function linkOf(anchor: Element): URL | null {
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.hasAttribute("target") || anchor.hasAttribute("download") || anchor.closest("[data-full-load]") !== null) return null;
  let url: URL;
  try { url = new URL(anchor.getAttribute("href") ?? "", window.location.href); } catch { return null; }
  if (url.origin !== window.location.origin || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  // A link within this page (Skip to content, #section) moves the view, not the page.
  if (url.hash !== "" && url.pathname === window.location.pathname && url.search === window.location.search) return null;
  return url;
}

/** The link a click would follow in place, or null when the click is not one to take over. */
export function linkToFollow(event: MouseEvent): URL | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target;
  const anchor = target instanceof Element ? target.closest("a[href]") : null;
  return anchor === null ? null : linkOf(anchor);
}

/** Leaving this page now would lose something the browser would have asked about (a settings section changed and not
 * saved asks through beforeunload, which an in-place change never fires). */
function leavingAsks(): boolean {
  return document.querySelector("form[data-k-gate][data-dirty]") !== null;
}

/** The history state key on every entry an in-place change made or left. */
const MARK = "toolroll";
const marked = (state: unknown): boolean => typeof state === "object" && state !== null && (state as Record<string, unknown>)[MARK] === "in-place";
/** The history state key that holds where a page was left (A2.3). */
const SCROLL = "toolrollScroll";

let host: InPlaceHost | null = null;
let reading: AbortController | null = null;
/** The address (path and query) of the page on screen, to tell a page change from a hash change on Back. */
let shownAt = "";
/** This document has added an entry of its own: every Back or Forward within it is a page change to read. */
let pushed = false;
/** This page's address as it compares: a `?draft=` the page took into its message box and removed is not a change. */
const here = (): string => {
  const query = new URLSearchParams(window.location.search);
  query.delete("draft");
  const search = query.toString();
  return window.location.pathname + (search === "" ? "" : `?${search}`);
};

// ---- leaving: a navigation the browser began wins (A2, from the A1 journey) -----------------------------------------

/** How long a `beforeunload` is believed: a leave prompt can be cancelled, and nothing says so. */
export const LEAVE_MS = 10_000;
let leftAt = 0;
let leaveTimer: ReturnType<typeof setTimeout> | null = null;
const onStay = new Set<() => void>();
/** True while this document is leaving (a `beforeunload` in the last LEAVE_MS, with no input or `pageshow` since). */
export function documentLeaving(): boolean { return leftAt !== 0 && Date.now() - leftAt < LEAVE_MS; }
/** Run `then` once this document is known to stay after all (the leave was cancelled), or now when it is not leaving. */
export function whenStayed(then: () => void): void {
  if (!documentLeaving()) { then(); return; }
  onStay.add(then);
}
function leaving(): void {
  leftAt = Date.now();
  // A read under way lands on nothing: its answer would show, push or load something over the browser's navigation.
  reading?.abort();
  reading = null;
  loading(false);
  press(null);
  if (leaveTimer !== null) clearTimeout(leaveTimer);
  leaveTimer = setTimeout(stayed, LEAVE_MS);
  // A page read ahead shown and not yet confirmed is never left to act: if this document stays, it loads as one.
  if (held) onStay.add(() => { if (held && reading === null) loadDocument(window.location.href, true); });
}
function stayed(): void {
  if (leftAt === 0) return;
  leftAt = 0;
  if (leaveTimer !== null) clearTimeout(leaveTimer);
  leaveTimer = null;
  const waiting = [...onStay];
  onStay.clear();
  for (const then of waiting) then();
}

// ---- the page while it waits: the pressed link, the line, a page held inert -----------------------------------------

const PRESSED = "data-so-pressed";
const LOADING = "data-so-loading";
export const LINE_AFTER_MS = 150;
let lineTimer: ReturnType<typeof setTimeout> | null = null;

function press(anchor: Element | null): void {
  document.querySelectorAll(`[${PRESSED}]`).forEach(one => { if (one !== anchor) one.removeAttribute(PRESSED); });
  anchor?.setAttribute(PRESSED, "");
}
/** The 2px line along the top of the content column, shown when a read takes longer than LINE_AFTER_MS. */
function loading(on: boolean): void {
  if (lineTimer !== null) clearTimeout(lineTimer);
  lineTimer = null;
  const column = () => document.querySelector(".so-main-column");
  if (!on) { column()?.removeAttribute(LOADING); return; }
  lineTimer = setTimeout(() => { lineTimer = null; column()?.setAttribute(LOADING, ""); }, LINE_AFTER_MS);
}

/** A page read ahead is on screen and not yet confirmed. */
let held = false;
/** Hold the page content (and its side panels) inert, or let it go: visible, not interactive. A confirmed page is a
 * fresh mount, so its nodes never carry the hold; letting go clears whatever is left too. */
function hold(on: boolean): void {
  held = on;
  const main = document.getElementById("workspace-main");
  const parts = [...(main?.children ?? []), ...document.querySelectorAll("[data-workspace-detail]")];
  for (const part of parts) part.toggleAttribute("inert", on);
  if (on) main?.setAttribute("data-so-provisional", ""); else main?.removeAttribute("data-so-provisional");
}

// ---- where a page was left (A2.3) -----------------------------------------------------------------------------------

/** Where a page was left: the window, and each scrolled element in the page content by its path of child indexes. */
export type Scroll = { x: number; y: number; parts: [string, number, number][] };
const MAX_PARTS = 8;

function pathIn(main: Element, node: Element): string {
  const steps: number[] = [];
  for (let at: Element | null = node; at !== null && at !== main; at = at.parentElement) {
    const parent: Element | null = at.parentElement;
    if (parent === null) return "";
    steps.push(Array.prototype.indexOf.call(parent.children, at));
  }
  return steps.reverse().join(".");
}
function partAt(main: Element, path: string): Element | null {
  let at: Element | null = main;
  if (path === "") return main;
  for (const step of path.split(".")) { at = at?.children[Number(step)] ?? null; if (at === null) return null; }
  return at;
}
export function scrollNow(): Scroll {
  const main = document.getElementById("workspace-main");
  const parts: [string, number, number][] = [];
  if (main !== null) {
    for (const node of [main, ...main.querySelectorAll("*")]) {
      if (node.scrollTop > 0 || node.scrollLeft > 0) parts.push([pathIn(main, node), node.scrollTop, node.scrollLeft]);
      if (parts.length >= MAX_PARTS) break;
    }
  }
  return { x: window.scrollX, y: window.scrollY, parts };
}
function scrollOf(state: unknown): Scroll | null {
  const saved = typeof state === "object" && state !== null ? (state as Record<string, unknown>)[SCROLL] : null;
  if (typeof saved !== "object" || saved === null) return null;
  const { x, y, parts } = saved as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || !Array.isArray(parts) || parts.length > MAX_PARTS) return null;
  const good = parts.every(part => Array.isArray(part) && part.length === 3 && typeof part[0] === "string" && /^(\d+(\.\d+)*)?$/.test(part[0]) && typeof part[1] === "number" && typeof part[2] === "number");
  return good ? { x, y, parts: parts as [string, number, number][] } : null;
}
function applyScroll(scroll: Scroll): void {
  const main = document.getElementById("workspace-main");
  if (main !== null) for (const [path, top, left] of scroll.parts) { const node = partAt(main, path); if (node !== null) { node.scrollTop = top; node.scrollLeft = left; } }
  if (scroll.x !== 0 || scroll.y !== 0) window.scrollTo(scroll.x, scroll.y);
}
/** Put a page back where it was: at once (so the first frame is right), and again after the page's own hash reveal and
 * window correction have run (app.tsx useWindowStaysPut, one frame after the page mounts). */
function restoreScroll(scroll: Scroll, page: () => boolean): void {
  applyScroll(scroll);
  requestAnimationFrame(() => requestAnimationFrame(() => { if (page()) applyScroll(scroll); }));
}

/** The current entry, with where its page is now. Every other key it holds stays (the in-place mark, a view's own). */
function withScroll(state: unknown, scroll: Scroll): Record<string, unknown> {
  return { ...(typeof state === "object" && state !== null ? state : {}), [SCROLL]: scroll };
}
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function cancelSave(): void { if (saveTimer !== null) clearTimeout(saveTimer); saveTimer = null; }
/** A scroll in the page: once it settles, the current entry remembers it (so Back to it, from any entry, finds it). */
function onScroll(): void {
  cancelSave();
  const at = here();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (host === null || at !== here() || at !== shownAt) return;
    try { window.history.replaceState(withScroll(window.history.state, scrollNow()), ""); } catch { /* the browser limits how often; the next settle tries again */ }
  }, 150);
}

// ---- following ------------------------------------------------------------------------------------------------------

/** Follow `href` in place, or load it as a document. `pop`: Back or Forward already moved the address bar there, and
 * `saved` is where its page was left. `pressed`: the link the person pressed, marked at once. */
export async function follow(href: string, mode: "push" | "pop", saved: Scroll | null = null, pressed: Element | null = null): Promise<void> {
  reading?.abort();
  skipTransition();
  cancelSave();
  const mine = new AbortController();
  reading = mine;
  const replace = mode === "pop";
  const from = host?.current();
  press(pressed);
  let url: URL;
  try { url = new URL(href, window.location.href); } catch { loadDocument(href, replace); return; }
  if (host === null || from === undefined || from.inPlace !== true || !mayBeInPlace(url) || leavingAsks()) { loadDocument(href, replace); return; }
  const leftHref = window.location.href;
  const ahead = takePrefetched(url);
  const read = readPage(url.pathname + url.search, "navigate", fetch, mine.signal);
  let early: BrowserWorkspace | null = null;
  if (ahead !== null && "page" in ahead) early = ahead.page;
  else {
    loading(true);
    // A read ahead still under way may land before the ordinary read: the first to land decides how this goes.
    if (ahead !== null) early = await Promise.race([ahead.pending, read.then(() => null)]);
  }
  if (reading !== mine) return;
  const done = () => { if (reading === mine) reading = null; loading(false); press(null); };
  if (early !== null && !leavingAsks()) {
    // Shown at once from the read ahead, inert, through the same door as any other page.
    loading(false);
    if (!host.accept(early, href, replace, "navigate")) { mine.abort(); done(); return; }
    record(url, mode);
    document.title = early.title;
    const shown = early;
    await swap(() => { host?.show(shown, true); hold(true); if (saved !== null) applyScroll(saved); }, directionOf(from.path, shown.path));
    if (reading !== mine) return;
    arrive(shown.title, url.hash !== "", saved);
    const next = await read;
    if (reading !== mine) return;
    done();
    // The confirming read failed a check: the address bar already says `href`, so the document replaces this entry.
    if (next === null) { loadDocument(href, true); return; }
    if (!host.accept(next, href, true, "confirm")) return;
    // Remounted from the confirmed page, never patched: every piece of page state starts from it. No motion; the place
    // in the page is kept.
    const kept = scrollNow();
    const focused = document.activeElement?.id === "workspace-main" || document.activeElement === document.body;
    document.title = next.title;
    host.show(next, false);
    hold(false);
    if (focused) document.getElementById("workspace-main")?.focus({ preventScroll: true });
    restoreScroll(kept, () => reading === null && shownAt === here());
    afterArrival(leftHref, mode);
    return;
  }
  const next = await read;
  if (reading !== mine) return;
  done();
  if (next === null) { loadDocument(href, replace); return; }
  // A section form changed while the page was read: the browser asks before it is left.
  if (leavingAsks()) { loadDocument(href, replace); return; }
  if (!host.accept(next, href, replace, "navigate")) return;
  record(url, mode);
  document.title = next.title;
  await swap(() => { host?.show(next, false); hold(false); if (saved !== null) applyScroll(saved); }, directionOf(from.path, next.path));
  if (reading !== null) return;
  arrive(next.title, url.hash !== "", saved);
  afterArrival(leftHref, mode);
}

/** The history entry of a change: a push marks both ends (the entry left keeps whatever state it had, plus where its
 * page was left), so a later document that lands between them (a reload) still knows Back and Forward here are page
 * changes (onPop). */
function record(url: URL, mode: "push" | "pop"): void {
  if (mode === "push") {
    const leaving: unknown = window.history.state;
    window.history.replaceState({ ...withScroll(leaving, scrollNow()), [MARK]: "in-place" }, "");
    window.history.pushState({ [MARK]: "in-place" }, "", url.pathname + url.search + url.hash);
    pushed = true;
  }
  shownAt = here();
}

/** After the swap: focus to the page content, the title said politely, and the top of the page, or where it was left. */
function arrive(title: string, hash: boolean, saved: Scroll | null): void {
  const main = document.getElementById("workspace-main");
  main?.focus({ preventScroll: true });
  announce(title);
  if (saved !== null) { restoreScroll(saved, () => true); return; }
  // A link to a section scrolls there (the page's own hash reveal); otherwise the page starts at its top.
  if (!hash) {
    main?.scrollTo?.(0, 0);
    document.querySelectorAll<HTMLElement>("#workspace-main .so-page-content, #workspace-main [data-kit-page]").forEach(node => node.scrollTo?.(0, 0));
    window.scrollTo(0, 0);
  }
}

/** The page just left is read ahead once the change has settled, so Back to it shows at once (A2.3). */
const LEFT_AHEAD_MS = 400;
function afterArrival(leftHref: string, mode: "push" | "pop"): void {
  if (mode !== "push") return;
  let left: URL;
  try { left = new URL(leftHref); } catch { return; }
  if (!mayPrefetch(left)) return;
  setTimeout(() => { if (host !== null && reading === null && host.current().inPlace === true) prefetch(left); }, LEFT_AHEAD_MS);
}

function announce(title: string): void {
  let region = document.getElementById("so-page-announce");
  if (region === null) {
    region = document.createElement("div");
    region.id = "so-page-announce";
    region.className = "so-sr-only";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.append(region);
  }
  region.textContent = "";
  const said = region;
  // A change of text the reader hears: emptied first, then the new title on the next frame.
  requestAnimationFrame(() => { said.textContent = title; });
}

/** Whether a link may be read ahead: the same rules as a click taken over, on a page that changes in place. */
function aheadOf(anchor: Element): URL | null {
  if (host === null || host.current().inPlace !== true || documentLeaving()) return null;
  const url = linkOf(anchor);
  if (url === null || !mayBeInPlace(url) || url.pathname + url.search === window.location.pathname + window.location.search) return null;
  return url;
}

function onClick(event: MouseEvent): void {
  const url = linkToFollow(event);
  // Not taken over: the browser follows the link itself, as today.
  if (url === null || host === null || host.current().inPlace !== true || !mayBeInPlace(url) || leavingAsks()) return;
  event.preventDefault();
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  void follow(url.pathname + url.search + url.hash, "push", null, anchor);
}

function onPop(event: PopStateEvent): void {
  cancelSave();
  // Back or Forward between entries of this one page (a #section) changes no page.
  if (host === null || here() === shownAt) return;
  // A page that keeps its own history (the Agents Live grid's runs): its own, as today. An entry an in-place change
  // made (in this document, or in one before a reload) is a page change even when this page is not in place: follow()
  // then loads it as a document, so the address bar never names one page over another's content.
  if (host.current().inPlace !== true && !pushed && !marked(event.state)) return;
  void follow(window.location.pathname + window.location.search + window.location.hash, "pop", scrollOf(event.state));
}

/** Start following links in place for this document; returns the stop. One host at a time. */
export function installNavigation(next: InPlaceHost): () => void {
  host = next;
  shownAt = here();
  pushed = false;
  // A document starts out staying.
  leftAt = 0; onStay.clear(); held = false;
  if (leaveTimer !== null) clearTimeout(leaveTimer);
  leaveTimer = null;
  // Where a page was left is this document's to restore (in panes the browser does not know); the window itself never
  // scrolls in the workspace, so a document load loses nothing to it.
  try { window.history.scrollRestoration = "manual"; } catch { /* kept as the browser has it */ }
  const stay = () => stayed();
  document.addEventListener("click", onClick);
  window.addEventListener("popstate", onPop);
  window.addEventListener("beforeunload", leaving);
  window.addEventListener("pageshow", stay);
  document.addEventListener("pointerdown", stay, true);
  document.addEventListener("keydown", stay, true);
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  const stopPrefetch = installPrefetch(aheadOf);
  return () => {
    if (host === next) host = null;
    reading?.abort();
    reading = null;
    loading(false);
    cancelSave();
    stopPrefetch();
    document.removeEventListener("click", onClick);
    window.removeEventListener("popstate", onPop);
    window.removeEventListener("beforeunload", leaving);
    window.removeEventListener("pageshow", stay);
    document.removeEventListener("pointerdown", stay, true);
    document.removeEventListener("keydown", stay, true);
    document.removeEventListener("scroll", onScroll, { capture: true });
  };
}
