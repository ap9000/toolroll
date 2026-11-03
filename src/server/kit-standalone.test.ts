// @vitest-environment happy-dom
/**
 * The kit's behaviour on a page the workspace bundle doesn't place (kit-standalone.ts) keeps the kit's rules: an overlay
 * never leaves the page inert behind it, a gated send does nothing while its box is empty, and an idea adds its words
 * after what was typed, never instead of it.
 */
import { beforeAll, expect, test } from "vitest";
import { KIT_BEHAVIOR_MARKUP, KIT_STANDALONE_SCRIPT } from "./kit-standalone.js";

const $ = (id: string) => document.getElementById(id)!;
beforeAll(() => { new Function(KIT_STANDALONE_SCRIPT)(); });

test("an overlay opens over an inert page, and every way out gives the page back", () => {
  document.body.innerHTML = `<nav id="nav"><a href="#">Home</a></nav><main id="main"><button id="open" data-k-open="p1">Details</button>
<div class="k-pop" id="p1" hidden><input id="field"><button id="x" data-k-close>Close</button></div></main>`;
  for (const close of [() => $("x").click(), () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })), () => (document.querySelector(".k-scrim") as HTMLElement).click()]) {
    $("open").click();
    expect($("p1").hidden).toBe(false);
    expect($("nav").inert).toBe(true);
    expect(document.activeElement).toBe($("field"));
    close();
    expect($("p1").hidden).toBe(true);
    expect(Array.from(document.querySelectorAll<HTMLElement>("*")).filter(one => one.inert)).toEqual([]);
    expect(document.querySelector(".k-scrim")).toBeNull();
  }
});

test("a gated send waits for words; an idea adds its words after what was typed", () => {
  document.body.innerHTML = `<form id="f"><div class="k-composer" data-k-composer="nt"><textarea class="k-composer-ta" id="nt-text"></textarea>
<button class="k-send" id="send" type="submit" data-gate="1" aria-disabled="true">Send</button></div></form><a id="idea" href="/tasks/new?text=x" data-k-draft="Fix one lint warning." data-k-into="nt">Fix a lint warning</a>`;
  let submitted = 0;
  $("f").addEventListener("submit", event => { event.preventDefault(); submitted += 1; });
  $("send").click();
  expect(submitted).toBe(0);
  const box = $("nt-text") as HTMLTextAreaElement;
  box.value = "Keep this";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  expect($("send").getAttribute("aria-disabled")).toBe("false");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  $("idea").dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(box.value).toBe("Keep this\nFix one lint warning.");
  $("idea").click();
  expect(box.value).toBe("Keep this\nFix one lint warning.");
});

test("only pages with kit behaviour carry the script", () => {
  expect(KIT_BEHAVIOR_MARKUP.test('<div class="k-composer" data-k-composer="a">')).toBe(true);
  expect(KIT_BEHAVIOR_MARKUP.test('<button data-k-open="p">')).toBe(true);
  expect(KIT_BEHAVIOR_MARKUP.test('<div class="k-composer-bar">')).toBe(false);
  expect(KIT_BEHAVIOR_MARKUP.test('<p class="k-note">plain</p>')).toBe(false);
});
