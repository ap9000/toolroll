// @vitest-environment happy-dom
/** Inline steering (chat Workbench): a pin on a diff line opens a form under that line — not the result page's request
 * form — and what is written there goes to the lead as one chat message naming the run, file and line, quoting it. */
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LineSteer, STEER_LIMITS, steerMessage } from "./line-steer.js";
import { replyTook } from "./app.js";
import type { BrowserMessage } from "../browser-workspace.js";

let root: Root | null = null, host: HTMLElement, panel: HTMLDivElement;
const DIFF = `<div class="diff-review" data-review-diff><div class="diff-lines">
  <div class="diff-line diff-addition" data-diff-file="scripts/app-e2e.mjs" data-diff-line="1390"><button type="button" class="diff-annotate pick-line" data-path="scripts/app-e2e.mjs" data-line="1390" data-side="new" aria-label="Annotate">+</button><span class="diff-gutter"></span><span class="diff-gutter">1390</span><code><b aria-hidden="true">+</b>    }, null, { timeout: 5000 }).catch(() =&gt; {});</code></div>
  <div class="diff-line diff-context" data-diff-file="scripts/app-e2e.mjs" data-diff-line="1391"><button type="button" class="diff-annotate pick-line" data-path="scripts/app-e2e.mjs" data-line="1391" data-side="new" aria-label="Annotate">+</button><code><b aria-hidden="true"> </b>const typing = await measure();</code></div>
</div></div>`;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  panel = document.createElement("div"); panel.innerHTML = DIFF; document.body.append(panel);
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); panel.remove(); });

const mount = (steer: (text: string) => Promise<string | null>, maxChars = 4000) => {
  const ref = createRef<HTMLDivElement>();
  (ref as { current: HTMLDivElement | null }).current = panel;
  return act(() => { root = createRoot(host); root.render(createElement(LineSteer, { host: ref, run: 3224, maxChars, steer })); });
};
const pin = (line: number) => act(() => { panel.querySelector<HTMLButtonElement>(`button.pick-line[data-line="${line}"]`)!.click(); });
const type = (value: string) => act(() => {
  const box = panel.querySelector<HTMLTextAreaElement>("[data-diff-steer] textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
  box.dispatchEvent(new Event("input", { bubbles: true }));
});

test("the message names the file, line and run, quotes the line on one line, and is bounded", () => {
  expect(steerMessage({ run: 3224, path: "src/a.ts", line: 12, side: "new", code: "  const a =\n 1;  ", note: "  Fail with the numbers.  " }))
    .toBe('On "src/a.ts":12 (run #3224): Fail with the numbers.\n\n> const a = 1;');
  expect(steerMessage({ run: 1, path: "src/a.ts", line: 3, side: "old", code: "", note: "Why?" })).toBe('On "src/a.ts":3 (removed line) (run #1): Why?\n\n> ');
  // A file name that looks like a reference stays one quoted name.
  expect(steerMessage({ run: 7, path: 'src/decoy.ts:1 (run #999): x".ts', line: 4, side: "new", code: "y", note: "n" })).toBe('On "src/decoy.ts:1 (run #999): x\\".ts":4 (run #7): n\n\n> y');
  const long = steerMessage({ run: 1, path: "p".repeat(900), line: 1, side: "new", code: "c".repeat(900), note: "n".repeat(9000) });
  expect(long.length).toBeLessThan(STEER_LIMITS.path + STEER_LIMITS.code + STEER_LIMITS.note + 60);
});

test("a pin opens the form under its own line, and the page's own handlers never see the click", async () => {
  const seen = vi.fn();
  document.addEventListener("click", seen);
  await mount(async () => null);
  await pin(1390);
  document.removeEventListener("click", seen);
  const row = panel.querySelector('[data-diff-line="1390"]')!;
  const form = row.nextElementSibling?.querySelector<HTMLFormElement>("[data-diff-steer]");
  expect(form?.dataset.diffFile).toBe("scripts/app-e2e.mjs");
  expect(form?.dataset.diffLine).toBe("1390");
  expect(form?.querySelector("label")?.textContent).toContain("line 1390 of scripts/app-e2e.mjs");
  expect(seen).not.toHaveBeenCalled();
  // Another pin moves the one form; there is never a second.
  await pin(1391);
  expect(panel.querySelectorAll("[data-diff-steer]")).toHaveLength(1);
  expect(panel.querySelector('[data-diff-line="1391"]')!.nextElementSibling?.querySelector("[data-diff-steer]")).not.toBeNull();
});

test("sending posts one message with the quoted line, then says it went", async () => {
  const steer = vi.fn(async () => null);
  await mount(steer);
  await pin(1390);
  const send = () => panel.querySelector<HTMLButtonElement>('[data-diff-steer] button[type="submit"]')!;
  expect(send().disabled).toBe(true);
  expect(send().getAttribute("aria-label")).toBe("Send to the lead");
  await type("Don't swallow the timeout.");
  await act(async () => { send().click(); });
  expect(steer).toHaveBeenCalledTimes(1);
  expect(steer).toHaveBeenCalledWith('On "scripts/app-e2e.mjs":1390 (run #3224): Don\'t swallow the timeout.\n\n> }, null, { timeout: 5000 }).catch(() => {});');
  expect(panel.querySelector("[data-steer-sent]")?.textContent).toContain("Sent to the lead");
});

test("a refusal keeps the words and says why; a message over the limit can't be sent", async () => {
  await mount(async () => "Send or clear the message you're writing first.", 4000);
  await pin(1390);
  await type("Please fix.");
  await act(async () => { panel.querySelector<HTMLButtonElement>('[data-diff-steer] button[type="submit"]')!.click(); });
  expect(panel.querySelector('[data-diff-steer] [role="alert"]')?.textContent).toContain("Send or clear");
  expect(panel.querySelector<HTMLTextAreaElement>("[data-diff-steer] textarea")!.value).toBe("Please fix.");
  await act(async () => root?.unmount()); root = null;
  await mount(async () => null, 40);
  await pin(1390);
  await type("A comment long enough to pass the conversation's limit.");
  expect(panel.querySelector<HTMLButtonElement>('[data-diff-steer] button[type="submit"]')!.disabled).toBe(true);
  expect(panel.querySelector('[data-diff-steer] [role="alert"]')?.textContent).toContain("longer than one message");
});

test("the diff opens with its pins showing, and keeps them when the result page's own script resets it to View", async () => {
  await mount(async () => null);
  const review = panel.querySelector<HTMLElement>("[data-review-diff]")!;
  expect(review.dataset.mode).toBe("annotate");
  // The result page's own script sets View on any diff it finds.
  await act(async () => { review.setAttribute("data-mode", "view"); await Promise.resolve(); });
  expect(review.dataset.mode).toBe("annotate");
});

test("Escape closes the form, takes its slot out of the diff, and gives the cursor back to the pin", async () => {
  await mount(async () => null);
  await pin(1390);
  await act(() => { panel.querySelector("[data-diff-steer]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(panel.querySelector(".diff-steer-slot")).toBeNull();
  expect(document.activeElement).toBe(panel.querySelector('button.pick-line[data-line="1390"]'));
});

test("while one comment is on its way, its form holds still and another pin waits; it never says another was sent", async () => {
  let finish: (value: string | null) => void = () => {};
  const steer = vi.fn(() => new Promise<string | null>(done => { finish = done; }));
  await mount(steer);
  await pin(1390);
  await type("First.");
  await act(async () => { panel.querySelector<HTMLButtonElement>('[data-diff-steer] button[type="submit"]')!.click(); });
  expect(panel.querySelector<HTMLTextAreaElement>("[data-diff-steer] textarea")!.readOnly).toBe(true);
  await pin(1391);
  expect(panel.querySelector('[data-diff-line="1391"]')!.nextElementSibling?.classList.contains("diff-steer-slot") ?? false).toBe(false);
  await act(async () => { finish(null); });
  expect(steer).toHaveBeenCalledTimes(1);
  expect(panel.querySelector('[data-diff-line="1390"]')!.nextElementSibling?.querySelector("[data-steer-sent]")).not.toBeNull();
});

test("a delivery that isn't confirmed is never called sent", async () => {
  await mount(async () => "Delivery isn't confirmed. Check the chat for it before sending it again.");
  await pin(1390);
  await type("Please.");
  await act(async () => { panel.querySelector<HTMLButtonElement>('[data-diff-steer] button[type="submit"]')!.click(); });
  expect(panel.querySelector("[data-steer-sent]")).toBeNull();
  expect(panel.querySelector('[data-diff-steer] [role="alert"]')?.textContent).toContain("isn't confirmed");
});

test("Enter sends; Shift + Enter is a new line, and nothing sends while an input method is still composing", async () => {
  const steer = vi.fn(async () => null);
  await mount(steer);
  await pin(1390);
  await type("Words");
  const box = panel.querySelector<HTMLTextAreaElement>("[data-diff-steer] textarea")!;
  expect(box.placeholder).toBe("Comment for the lead…");
  await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })); });
  await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })); });
  expect(steer).not.toHaveBeenCalled();
  await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(steer).toHaveBeenCalledTimes(1);
  // Sent: one quiet line with its first words, where the comment was.
  expect(panel.querySelector("[data-steer-sent]")?.textContent).toBe("Sent to the lead · Words");
});

test("Escape while an input method is composing keeps the comment; sent, the cursor goes back to the pin", async () => {
  await mount(async () => null);
  await pin(1390);
  await type("Keep me");
  const form = panel.querySelector("[data-diff-steer]")!;
  await act(() => { form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })); });
  expect(panel.querySelector<HTMLTextAreaElement>("[data-diff-steer] textarea")?.value).toBe("Keep me");
  await act(async () => { panel.querySelector<HTMLTextAreaElement>("[data-diff-steer] textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(panel.querySelector("[data-steer-sent]")).not.toBeNull();
  expect(document.activeElement).toBe(panel.querySelector('button.pick-line[data-line="1390"]'));
});

test("the pane is marked while steering is installed, and unmarked after", async () => {
  await mount(async () => null);
  expect(panel.hasAttribute("data-line-steer")).toBe(true);
  await act(async () => root?.unmount()); root = null;
  expect(panel.hasAttribute("data-line-steer")).toBe(false);
});

const message = (role: BrowserMessage["role"], createdAt: string): BrowserMessage => ({ id: createdAt, role, text: "", html: "", activity: null, createdAt, cardsHtml: "" });
test("a reply says how long it took only after the message it answers, and only under an hour", () => {
  expect(replyTook(message("assistant", "2026-10-23T10:02:10Z"), message("operator", "2026-10-23T10:00:00Z"))).toBe("2 min");
  expect(replyTook(message("assistant", "2026-10-23T10:00:40Z"), message("operator", "2026-10-23T10:00:00Z"))).toBe("40 s");
  expect(replyTook(message("assistant", "2026-10-23T12:00:00Z"), message("operator", "2026-10-23T10:00:00Z"))).toBeNull();
  expect(replyTook(message("assistant", "2026-10-23T10:01:00Z"), message("assistant", "2026-10-23T10:00:00Z"))).toBeNull();
  expect(replyTook(message("operator", "2026-10-23T10:01:00Z"), message("operator", "2026-10-23T10:00:00Z"))).toBeNull();
});
