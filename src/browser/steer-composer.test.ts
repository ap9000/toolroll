// @vitest-environment happy-dom
/** The shared steering composer (docs/plans/agents-cockpit.md §4): the note box names the exact run and its own draft
 * key, offers Pause and send only while a live agent is not paused, keeps its draft across a refusal (a reload), and
 * clears it only when the page comes back with that draft's own key. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { BrowserAgentControls } from "../browser-workspace.js";
import { saveDraft, SteerNote, UnsentNote } from "./views/steer-composer.js";

const controls = (over: Partial<BrowserAgentControls> = {}): BrowserAgentControls => ({ send: "live", words: "Notes reach the agent right away.",
  pause: { action: "/t/t-1/pause", run: 5, state: null, requests: ["web-a", "web-b", "web-c"], until: null }, stop: { action: "/t/t-1/stop", run: 5, label: "Stop" }, ...over });
let root: Root | null = null, host: HTMLElement;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; sessionStorage.clear(); host = document.createElement("div"); document.body.append(host); history.replaceState(null, "", "/t/t-1"); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); });
const render = (node: ReturnType<typeof createElement>) => act(() => { root = createRoot(host); root.render(node); });
const type = (value: string) => act(() => {
  const box = host.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
  box.dispatchEvent(new Event("input", { bubbles: true }));
});

test("the box names its run and key; Pause and send goes to the pause route only while a live agent is not paused", () => {
  render(createElement(SteerNote, { steer: { action: "/t/t-1/steer", run: 5 }, controls: controls(), back: "task" }));
  const form = host.querySelector<HTMLFormElement>("[data-steer-note]")!;
  const hidden = Object.fromEntries([...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map(one => [one.name, one.value]));
  expect(hidden).toMatchObject({ return: "task", run: "5" });
  expect(hidden["request"]).toBe(`steer-${hidden["key"]}`);
  expect(hidden["key"]).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  expect(host.querySelector("[data-steer-pause-send]")?.getAttribute("formaction")).toBe("/t/t-1/pause");
  act(() => root?.render(createElement(SteerNote, { steer: { action: "/t/t-1/steer", run: 5 }, controls: controls({ pause: { action: "/t/t-1/pause", run: 5, state: "paused", requests: ["a", "b", "c"], until: null } }), back: "task" })));
  expect(host.querySelector("[data-steer-pause-send]")).toBeNull();
  act(() => root?.render(createElement(SteerNote, { steer: { action: "/t/t-1/steer", run: 5 }, controls: controls({ send: "mailbox", pause: null }), back: "task" })));
  expect(host.querySelector("[data-steer-pause-send]")).toBeNull();
});

test("a refused send keeps the draft through a reload; the page coming back with its key clears it", async () => {
  render(createElement(SteerNote, { steer: { action: "/t/t-1/steer", run: 5 }, controls: controls(), back: "task" }));
  type("use the read replica");
  const key = host.querySelector<HTMLInputElement>('input[name="key"]')!.value;
  await act(async () => root?.unmount()); root = null;
  // A refusal: the page comes back without this draft's key — the words are still in the box.
  render(createElement(SteerNote, { steer: { action: "/t/t-1/steer", run: 5 }, controls: controls(), back: "task" }));
  expect(host.querySelector("textarea")!.value).toBe("use the read replica");
  await act(async () => root?.unmount()); root = null;
  history.replaceState(null, "", `/t/t-1?sent=${key}`);
  render(createElement(SteerNote, { steer: { action: "/t/t-1/steer", run: 5 }, controls: controls(), back: "task" }));
  expect(host.querySelector("textarea")!.value).toBe("");
});

test("a note written for an attempt that has ended is shown, with Send to the next attempt naming that attempt", () => {
  saveDraft(3, { text: "check the migration first", key: "k-unsent-0003", submitted: true });
  render(createElement(UnsentNote, { runs: [4, 3], action: "/t/t-1/steer", back: "task" }));
  const form = host.querySelector<HTMLFormElement>("[data-steer-unsent]")!;
  expect(form.getAttribute("data-steer-unsent")).toBe("3");
  expect(host.querySelector("[data-steer-unsent-text]")?.textContent).toBe("check the migration first");
  expect(Object.fromEntries([...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map(one => [one.name, one.value])))
    .toMatchObject({ note: "check the migration first", after: "3", key: "k-unsent-0003", return: "task" });
});
