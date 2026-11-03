// @vitest-environment happy-dom
/**
 * The kit's overlays never leave the page unusable (Codex wave 0 r1 #4, #5): a panel removed by a re-render gives the
 * page back, and a pre-rendered panel opened over another is the one thing not inert.
 */
import { beforeAll, beforeEach, expect, test } from "vitest";
import { closeAll, installKitBehavior } from "./kit/behavior.js";

const $ = (id: string) => document.getElementById(id)!;
const anyInert = () => Array.from(document.querySelectorAll<HTMLElement>("*")).filter(element => element.inert).map(element => element.id || element.className);
beforeAll(() => installKitBehavior());
beforeEach(() => {
  closeAll();
  document.body.innerHTML = `<nav id="nav"><a href="#">Home</a></nav>
<div id="region"><button id="open-d1" data-k-open="d1">Details</button>
<div class="k-drawer" id="d1" hidden><button id="open-p2" data-k-open="p2">Approve</button><button data-k-close>Close</button></div>
<div class="k-pop" id="p2" hidden><input id="pw" type="password"><button data-k-close>Close</button></div></div>`;
});

test("an overlay a re-render removed releases the page, on workspace-rendered and on the removal itself", async () => {
  for (const announce of [true, false]) {
    $("open-d1").click();
    expect($("nav").inert).toBe(true);
    $("region").innerHTML = '<p id="fresh">New content</p>';
    if (announce) window.dispatchEvent(new CustomEvent("standing-orders:workspace-rendered"));
    else await new Promise(resolve => setTimeout(resolve, 0));
    expect(anyInert()).toEqual([]);
    expect(document.querySelector(".k-scrim")).toBeNull();
    document.body.innerHTML = `<nav id="nav"><a href="#">Home</a></nav><div id="region"><button id="open-d1" data-k-open="d1">Details</button><div class="k-drawer" id="d1" hidden><button data-k-close>Close</button></div></div>`;
  }
});

test("a pre-rendered popover opened over a drawer is live; closing each gives back exactly what it took", () => {
  $("open-d1").click();
  expect($("p2").inert).toBe(true);
  $("open-p2").click();
  expect($("p2").hidden).toBe(false);
  expect($("p2").closest("[inert]")).toBeNull();
  expect($("d1").inert).toBe(true);
  expect($("nav").inert).toBe(true);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect($("p2").hidden).toBe(true);
  expect($("d1").inert).toBe(false);
  expect($("d1").hidden).toBe(false);
  expect($("nav").inert).toBe(true);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(anyInert()).toEqual([]);
  expect(document.querySelector(".k-scrim")).toBeNull();
});

test("a server form's button shows its busy face once, a second press does nothing, and Back puts the face back", () => {
  document.body.innerHTML = `<form id="f" method="post" action="/d/1/answer"><button id="go" class="k-btn" type="submit" data-k-busy="Answering…"><span class="k-face">Answer</span></button></form>`;
  const form = $("f") as HTMLFormElement;
  // Counted after the kit's own listener (on the document): what the browser would send.
  let sent = 0;
  const count = (event: Event) => { if (!event.defaultPrevented) sent += 1; event.preventDefault(); };
  window.addEventListener("submit", count);
  const press = () => form.dispatchEvent(Object.assign(new Event("submit", { bubbles: true, cancelable: true }), { submitter: $("go") }));
  press();
  expect($("go").textContent).toBe("Answering…");
  expect($("go").classList.contains("busy")).toBe(true);
  expect(form.getAttribute("aria-busy")).toBe("true");
  press();
  expect(sent).toBe(1);
  window.dispatchEvent(new Event("pageshow"));
  expect($("go").textContent).toBe("Answer");
  expect(form.hasAttribute("aria-busy")).toBe(false);
  window.removeEventListener("submit", count);
});

test("Print on a server page opens the browser's print dialog", () => {
  document.body.innerHTML = `<button id="print" class="k-btn" type="button" data-k-print>Print</button>`;
  let printed = 0;
  const original = window.print;
  window.print = () => { printed += 1; };
  try { $("print").click(); } finally { window.print = original; }
  expect(printed).toBe(1);
});
