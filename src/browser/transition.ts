/**
 * The motion of an in-place page change (docs/plans/live-pages-and-home.md A2.2).
 *
 * Only the page content moves: during a change `<html>` carries `so-nav` and a direction class, which name
 * `#workspace-main` for the transition (console.css). The sidebar and the phone header hold still by their own names;
 * the message box is named here, one element on each side, so a page with two never breaks the transition.
 *
 * Same level: the old content fades out in 80 ms and the new fades in over 160 ms, no movement. Deeper: the new content
 * fades in and moves 8px from the right over 200 ms; shallower mirrors it. Reduced motion, a hidden tab or a browser
 * without view transitions: a plain swap. A new change skips a running one. Nothing runs longer than 220 ms.
 */

export type Direction = "same" | "deeper" | "shallower";

/** How deep a page sits: the number of segments in its path, where the top level (Home, a menu page) is 1. */
export function depthOf(path: string): number {
  let pathname: string;
  try { pathname = new URL(path, "http://in-place.invalid").pathname; } catch { return 1; }
  return Math.max(1, pathname.split("/").filter(segment => segment !== "").length);
}

/** Which way a change from `from` to `to` goes. */
export function directionOf(from: string, to: string): Direction {
  const a = depthOf(from), b = depthOf(to);
  return b > a ? "deeper" : b < a ? "shallower" : "same";
}

const CLASSES = ["so-nav", "so-nav-same", "so-nav-deeper", "so-nav-shallower"];
const BOX = "form[data-workspace-composer], .so-home-ask";
const BOX_NAME = "so-message-box";

type Running = { skipTransition(): void; finished: Promise<unknown>; ready: Promise<unknown>; updateCallbackDone: Promise<unknown> };
type Starter = (update: () => void) => Running;
let running: Running | null = null;

/** Stop a running change where it is: its new page shows at once. */
export function skipTransition(): void {
  try { running?.skipTransition(); } catch { /* already over */ }
}

function nameBox(): void {
  const box = document.querySelector<HTMLElement>(BOX);
  box?.style.setProperty("view-transition-name", BOX_NAME);
}
function unnameBoxes(): void {
  document.querySelectorAll<HTMLElement>(BOX).forEach(box => { if (box.style.getPropertyValue("view-transition-name") === BOX_NAME) box.style.removeProperty("view-transition-name"); });
}

function stillWanted(): boolean {
  try { if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false; } catch { /* no preference known */ }
  return !document.hidden;
}

/**
 * Run `update` (which changes the DOM synchronously) as a page change going `direction`, or as a plain swap when
 * `direction` is null or motion is off. Resolves once the DOM holds the new page (the transition itself may still run).
 */
export function swap(update: () => void, direction: Direction | null): Promise<void> {
  skipTransition();
  const start = (document as Document & { startViewTransition?: (update: () => void) => Running }).startViewTransition;
  if (direction === null || typeof start !== "function" || !stillWanted()) { update(); return Promise.resolve(); }
  const root = document.documentElement;
  root.classList.remove(...CLASSES);
  root.classList.add("so-nav", `so-nav-${direction}`);
  nameBox();
  let ran = false;
  let fail: unknown = null;
  let applied!: () => void;
  const done = new Promise<void>(resolve => { applied = resolve; });
  const run = () => {
    if (ran) return;
    ran = true;
    unnameBoxes();
    try { update(); } catch (error) { fail = error; }
    nameBox();
    applied();
  };
  let one: Running;
  try { one = (start as Starter).call(document, run); } catch { root.classList.remove(...CLASSES); unnameBoxes(); run(); return fail === null ? done : Promise.reject(fail); }
  running = one;
  const end = () => {
    if (running !== one) return;
    running = null;
    root.classList.remove(...CLASSES);
    unnameBoxes();
  };
  one.finished.then(end, end);
  one.ready.catch(() => undefined);
  // A transition the browser gave up on before its update ran still owes the page its change.
  one.updateCallbackDone.catch(() => undefined).finally(run);
  return done.then(() => { if (fail !== null) throw fail; });
}
