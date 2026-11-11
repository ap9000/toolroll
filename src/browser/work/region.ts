/**
 * A server-drawn region kept current by the app (docs/plans/task-page-in-app.md §4): the app's version of the
 * workspace-page arm of `regionScript` (server/chrome.ts), for the two regions a task page has: the check progress line
 * and "What is changing right now". When the page's one stream says something changed, it fetches the build's own
 * fragment and swaps it in. Kept as the string has it: one fetch in flight and one more when a change arrived during
 * it, a redirect or a refusal loads /login as a document (the sign-in page is never put in the region), the stamp says
 * how old the region is, a fragment that marks itself final stops, nothing reads on a timer or at start.
 *
 * What differs is its lifetime. The path is fixed and takes only the entry's build number. It binds to the element on
 * the page now (the peek only inside the card of that build), lets go of one that left the document and looks again on
 * every render. Stopped (`signal`), it leaves the room, clears its timer, and a response still under way is dropped
 * before any write or redirect.
 */
import type { PageWork } from "../../page-work-contract.js";
import { joinLiveRoom, type LiveListener } from "../live.js";
import { loadDocument } from "../navigate.js";

export type RegionEntry = Extract<PageWork, { kind: "region" }>;
export type RegionDeps = { fetch: typeof fetch; join: (room: string, listener: LiveListener) => () => void; load: (href: string) => void; now: () => number };

const FRAGMENT: Readonly<Record<RegionEntry["region"], string>> = { "check-progress": "check", "run-peek": "peek" };
const RENDERED = "standing-orders:workspace-rendered";
/** The rows a swap must not take the keyboard from (the string's roving set). */
const HELD = "a.row, a.lane-card, a.worker-job";

export function regionWork(entry: RegionEntry, signal: AbortSignal,
  deps: RegionDeps = { fetch: (input, init) => fetch(input, init), join: joinLiveRoom, load: href => loadDocument(href), now: () => Date.now() }): void {
  const fragment = FRAGMENT[entry.region];
  if (signal.aborted || fragment === undefined || !Number.isSafeInteger(entry.run) || entry.run <= 0) return;
  const target = `/r/${entry.run}?fragment=${fragment}`;
  let region: HTMLElement | null = null;
  let stamp: HTMLElement | null = null;
  let last = deps.now();
  let busy = false, again = false, failed = false, stopped = false;

  /** The region on the page now. The peek is the entry's only inside that build's card. */
  const find = (): void => {
    if (region !== null && region.isConnected) return;
    region = null; stamp = null;
    const found = document.getElementById(entry.region);
    if (found === null) return;
    if (entry.region === "run-peek" && found.closest("[data-live-run]")?.getAttribute("data-live-run") !== String(entry.run)) return;
    region = found;
    stamp = document.getElementById(`${entry.region}-stamp`);
    last = deps.now(); failed = false; stopped = false;
  };
  const tell = (): void => {
    if (signal.aborted || region === null || !region.isConnected || stamp === null || stopped) return;
    const seconds = Math.round((deps.now() - last) / 1000);
    stamp.textContent = failed ? `stale — retrying (${seconds}s old)` : `updated ${seconds}s ago`;
  };
  const swap = (into: HTMLElement, text: string): void => {
    const active = document.activeElement;
    const held = active !== null && into.contains(active) && active.matches(HELD) ? active.getAttribute("href") : null;
    into.innerHTML = text;
    if (held === null) return;
    for (const link of into.querySelectorAll<HTMLElement>(HELD)) if (link.getAttribute("href") === held) { link.focus({ preventScroll: true }); break; }
  };
  const refresh = (): void => {
    if (signal.aborted) return;
    find();
    if (region === null || stopped) return;
    if (busy) { again = true; return; }
    busy = true; again = false;
    const bound = region;
    /** Still this page, this region: anything else and the answer is dropped. */
    const mine = (): boolean => !signal.aborted && region === bound && bound.isConnected;
    deps.fetch(target, { redirect: "manual", cache: "no-store" })
      .then(async response => {
        if (!mine()) return;
        if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) { failed = true; deps.load("/login"); return; }
        const text = response.ok ? await response.text() : null;
        if (!mine()) return;
        if (text) { swap(bound, text); last = deps.now(); failed = false; } else failed = true;
      })
      .catch(() => { if (mine()) failed = true; })
      .then(() => {
        busy = false;
        if (signal.aborted) return;
        // The region was replaced meanwhile: the one on the page now reads on its own turn.
        if (!mine()) { if (again) refresh(); return; }
        tell();
        // A fragment that marks itself final stops: a finished or abandoned build is not fetched again.
        if (bound.querySelector("[data-region-stop]")) { stopped = true; if (stamp !== null) stamp.textContent = ""; return; }
        if (again) refresh();
      });
  };

  find();
  const leave = deps.join("workspace", event => { if (event === "change" || event === "reload") refresh(); });
  const timer = setInterval(tell, 1000);
  window.addEventListener(RENDERED, find, { signal });
  signal.addEventListener("abort", () => { clearInterval(timer); leave(); region = null; stamp = null; }, { once: true });
}
