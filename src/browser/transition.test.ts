// @vitest-environment happy-dom
/**
 * The motion of an in-place page change (docs/plans/live-pages-and-home.md A2.2): which way a change goes, the class on
 * `<html>` that names the page content for the transition and leaves with it, a plain swap when motion is off or the
 * browser has no view transitions, and a new change skipping a running one. The timings themselves are read from the
 * shipped stylesheet: nothing runs past 220 ms.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { depthOf, directionOf, swap } from "./transition.js";

type Fake = { skipTransition: ReturnType<typeof vi.fn>; finished: Promise<void>; ready: Promise<void>; updateCallbackDone: Promise<void>; end(): void };
let started: Fake[] = [];
function installTransitions(): void {
  started = [];
  (document as unknown as { startViewTransition: (update: () => void) => Fake }).startViewTransition = (update: () => void) => {
    let end!: () => void;
    const finished = new Promise<void>(resolve => { end = resolve; });
    const done = Promise.resolve().then(update);
    const one: Fake = { skipTransition: vi.fn(() => end()), finished, ready: done, updateCallbackDone: done, end };
    started.push(one);
    return one;
  };
}

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  document.documentElement.className = "";
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

test("depth is the number of path segments, the top level counting as one; the direction follows it", () => {
  expect(depthOf("/")).toBe(1);
  expect(depthOf("/tasks")).toBe(1);
  expect(depthOf("/tasks?project=%2Fr%2Fshop")).toBe(1);
  expect(depthOf("/t/a-one")).toBe(2);
  expect(depthOf("/t/a-one#scope")).toBe(2);
  expect(depthOf("/settings/models")).toBe(2);
  expect(depthOf("/settings/")).toBe(1);
  expect(directionOf("/", "/tasks")).toBe("same");
  expect(directionOf("/tasks", "/projects")).toBe("same");
  expect(directionOf("/tasks", "/t/a-one")).toBe("deeper");
  expect(directionOf("/t/a-one", "/")).toBe("shallower");
  expect(directionOf("/settings", "/settings/models")).toBe("deeper");
  expect(directionOf("/settings/models", "/settings/tools")).toBe("same");
});

test("a change runs as a view transition with its direction on <html>, removed when it finishes; the message box is named on both sides", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
  installTransitions();
  document.body.innerHTML = '<form class="so-home-ask"></form>';
  const root = document.documentElement;
  const done = swap(() => { document.body.innerHTML = '<form data-workspace-composer></form>'; }, "deeper");
  expect(root.classList.contains("so-nav")).toBe(true);
  expect(root.classList.contains("so-nav-deeper")).toBe(true);
  expect(document.querySelector<HTMLElement>(".so-home-ask")!.style.getPropertyValue("view-transition-name")).toBe("so-message-box");
  await done;
  expect(document.querySelector<HTMLElement>("form[data-workspace-composer]")!.style.getPropertyValue("view-transition-name")).toBe("so-message-box");
  started[0]!.end();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(root.className).toBe("");
  expect(document.querySelector<HTMLElement>("form[data-workspace-composer]")!.style.getPropertyValue("view-transition-name")).toBe("");
});

test("a new change skips a running one, and the classes belong to the newest", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
  installTransitions();
  const order: string[] = [];
  const first = swap(() => order.push("first"), "deeper");
  const second = swap(() => order.push("second"), "shallower");
  expect(started[0]!.skipTransition).toHaveBeenCalled();
  await Promise.all([first, second]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(order).toEqual(["first", "second"]);
  expect(document.documentElement.classList.contains("so-nav-shallower")).toBe(true);
  expect(document.documentElement.classList.contains("so-nav-deeper")).toBe(false);
  started[1]!.end();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.documentElement.className).toBe("");
});

test("a plain swap, at once, under reduced motion, without view transitions, or with no direction", async () => {
  installTransitions();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query }));
  let ran = 0;
  await swap(() => { ran += 1; }, "same");
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
  await swap(() => { ran += 1; }, null);
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  const plain = swap(() => { ran += 1; }, "deeper");
  // Synchronous: the DOM holds the new page before the call returns.
  expect(ran).toBe(3);
  await plain;
  expect(started.length).toBe(0);
  expect(document.documentElement.className).toBe("");
});

test("the shipped timings: 80 ms out, 160 ms in, 8px over 200 ms deeper and shallower, nothing past 220 ms, none under reduced motion", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "server", "console.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const squash = (text: string) => text.replace(/\s+/g, " ");
  const all = squash(css);
  expect(all).toContain("::view-transition-old(root) { animation: so-page-leave 80ms ease-in both; }");
  expect(all).toContain("::view-transition-new(root) { animation: so-page-arrive 160ms ease-out 60ms both; }");
  expect(all).toContain("html.so-nav #workspace-main { view-transition-name: so-page; }");
  expect(all).toContain("html.so-nav::view-transition-old(so-page) { animation: so-page-leave 80ms ease-in both; }");
  expect(all).toContain("html.so-nav-same::view-transition-new(so-page) { animation: so-page-arrive 160ms ease-out 60ms both; }");
  expect(all).toContain("html.so-nav-deeper::view-transition-new(so-page) { animation: so-page-deeper 200ms cubic-bezier(.2, .8, .2, 1) both; }");
  expect(all).toContain("html.so-nav-shallower::view-transition-new(so-page) { animation: so-page-shallower 200ms cubic-bezier(.2, .8, .2, 1) both; }");
  expect(all).toContain("@keyframes so-page-deeper { from { opacity: 0; transform: translateX(8px); } }");
  expect(all).toContain("@keyframes so-page-shallower { from { opacity: 0; transform: translateX(-8px); } }");
  expect(all).toContain(".so-ph { view-transition-name: so-phone-header; }");
  // Every in-place and cross-document page rule: duration plus delay at most 220 ms.
  for (const match of all.matchAll(/(so-page-(?:leave|arrive|deeper|shallower)) (\d+)ms [^;]*?(?: (\d+)ms)? both/g)) {
    expect(Number(match[2]) + Number(match[3] ?? 0), match[0]).toBeLessThanOrEqual(220);
  }
  expect(all).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*::view-transition-group\(\*\), ::view-transition-old\(\*\), ::view-transition-new\(\*\) \{ animation: none !important; \}/);
  // The loading line is ink, never amber.
  const workspace = squash(readFileSync(join(import.meta.dirname, "workspace.css"), "utf8"));
  expect(workspace).toMatch(/\.so-main-column\[data-so-loading\]::before \{[^}]*height: 2px;[^}]*background: var\(--so-ink\);/);
});
