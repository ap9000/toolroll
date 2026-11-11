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
 */
import type { BrowserWorkspace } from "../browser-workspace.js";
import { readPage } from "./workspace-client.js";

/** What the app gives the navigator: the page on screen, the one door, and the swap. */
export type InPlaceHost = {
  /** The workspace on screen now: the page being left. */
  current(): BrowserWorkspace;
  /** The app's door (app.tsx acceptWorkspace): true to show `next`; false when it loaded a document instead. */
  accept(next: BrowserWorkspace, href: string, replace: boolean): boolean;
  /** Show `next` as a new page, synchronously (the DOM holds it when this returns). */
  show(next: BrowserWorkspace): void;
};

/** The addresses the server may answer in place (server/in-place.ts IN_PLACE_ROUTES): anything else is a document load
 * at once, without a read first (a download, an export, a page that always loads as one). The server still decides. */
const MAY_BE_IN_PLACE = [/^\/$/, /^\/tasks$/, /^\/t\/[^/]+$/, /^\/projects$/, /^\/agents$/, /^\/search$/, /^\/settings(?:\/[a-z-]+)?$/];
export function mayBeInPlace(url: URL): boolean {
  return MAY_BE_IN_PLACE.some(pattern => pattern.test(url.pathname)) && !(url.pathname === "/agents" && url.searchParams.get("view") === "live");
}

/** How a document load happens: replaced in tests, never anywhere else. */
let load: (href: string, replace: boolean) => void = (href, replace) => { if (replace) window.location.replace(href); else window.location.assign(href); };
export function loadDocument(href: string, replace = false): void { load(href, replace); }
/** TESTS ONLY: watch document loads instead of making them. */
export function setDocumentLoader(next: (href: string, replace: boolean) => void): () => void {
  const before = load;
  load = next;
  return () => { load = before; };
}

/** The link a click would follow in place, or null when the click is not one to take over. */
export function linkToFollow(event: MouseEvent): URL | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target;
  const anchor = target instanceof Element ? target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.hasAttribute("target") || anchor.hasAttribute("download") || anchor.closest("[data-full-load]") !== null) return null;
  let url: URL;
  try { url = new URL(anchor.getAttribute("href") ?? "", window.location.href); } catch { return null; }
  if (url.origin !== window.location.origin || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  // A link within this page (Skip to content, #section) moves the view, not the page.
  if (url.hash !== "" && url.pathname === window.location.pathname && url.search === window.location.search) return null;
  return url;
}

/** Leaving this page now would lose something the browser would have asked about (a settings section changed and not
 * saved asks through beforeunload, which an in-place change never fires). */
function leavingAsks(): boolean {
  return document.querySelector("form[data-k-gate][data-dirty]") !== null;
}

/** The history state key on every entry an in-place change made or left. */
const MARK = "toolroll";
const marked = (state: unknown): boolean => typeof state === "object" && state !== null && (state as Record<string, unknown>)[MARK] === "in-place";

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

/** Follow `href` in place, or load it as a document. `pop`: Back or Forward already moved the address bar there. */
export async function follow(href: string, mode: "push" | "pop"): Promise<void> {
  reading?.abort();
  const mine = new AbortController();
  reading = mine;
  const replace = mode === "pop";
  const from = host?.current();
  let url: URL;
  try { url = new URL(href, window.location.href); } catch { loadDocument(href, replace); return; }
  if (host === null || from === undefined || from.inPlace !== true || !mayBeInPlace(url) || leavingAsks()) { loadDocument(href, replace); return; }
  const next = await readPage(url.pathname + url.search, "navigate", fetch, mine.signal);
  // A later click (or Back) took over: it decides.
  if (reading !== mine) return;
  reading = null;
  if (next === null) { loadDocument(href, replace); return; }
  // A section form changed while the page was read: the browser asks before it is left.
  if (leavingAsks()) { loadDocument(href, replace); return; }
  if (!host.accept(next, href, replace)) return;
  const address = url.pathname + url.search + url.hash;
  if (mode === "push") {
    // Both ends of the change carry the mark (the entry left keeps whatever state it had), so a later document that
    // lands between them (a reload) still knows Back and Forward here are page changes (onPop).
    const leaving: unknown = window.history.state;
    window.history.replaceState({ ...(typeof leaving === "object" && leaving !== null ? leaving : {}), [MARK]: "in-place" }, "");
    window.history.pushState({ [MARK]: "in-place" }, "", address);
    pushed = true;
  }
  shownAt = here();
  document.title = next.title;
  host.show(next);
  arrive(next.title, url.hash !== "");
}

/** After the swap: focus to the page content, the title said politely, the top of the page. */
function arrive(title: string, hash: boolean): void {
  const main = document.getElementById("workspace-main");
  main?.focus({ preventScroll: true });
  announce(title);
  // A link to a section scrolls there (the page's own hash reveal); otherwise the page starts at its top.
  if (!hash) {
    main?.scrollTo?.(0, 0);
    document.querySelectorAll<HTMLElement>("#workspace-main .so-page-content, #workspace-main [data-kit-page]").forEach(node => node.scrollTo?.(0, 0));
    window.scrollTo(0, 0);
  }
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

function onClick(event: MouseEvent): void {
  const url = linkToFollow(event);
  // Not taken over: the browser follows the link itself, as today.
  if (url === null || host === null || host.current().inPlace !== true || !mayBeInPlace(url) || leavingAsks()) return;
  event.preventDefault();
  void follow(url.pathname + url.search + url.hash, "push");
}

function onPop(event: PopStateEvent): void {
  // Back or Forward between entries of this one page (a #section) changes no page.
  if (host === null || here() === shownAt) return;
  // A page that keeps its own history (the Agents Live grid's runs): its own, as today. An entry an in-place change
  // made (in this document, or in one before a reload) is a page change even when this page is not in place: follow()
  // then loads it as a document, so the address bar never names one page over another's content.
  if (host.current().inPlace !== true && !pushed && !marked(event.state)) return;
  void follow(window.location.pathname + window.location.search + window.location.hash, "pop");
}

/** Start following links in place for this document; returns the stop. One host at a time. */
export function installNavigation(next: InPlaceHost): () => void {
  host = next;
  shownAt = here();
  pushed = false;
  document.addEventListener("click", onClick);
  window.addEventListener("popstate", onPop);
  return () => {
    if (host === next) host = null;
    reading?.abort();
    reading = null;
    document.removeEventListener("click", onClick);
    window.removeEventListener("popstate", onPop);
  };
}
