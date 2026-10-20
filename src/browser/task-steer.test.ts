// @vitest-environment happy-dom
/** The task page's composer across live updates (docs/plans/agents-cockpit.md §4): Pause and steer's draft stays with
 * the attempt it was written for (a new attempt starts with an empty box, never the old words aimed at it), and a note
 * left for an attempt that ends while the page is open is offered to the next attempt without a reload. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AssignmentCard } from "../assignment-ui.js";
import type { BrowserTaskView } from "../browser-workspace.js";
import { TaskView } from "./views/task-view.js";
import { saveDraft } from "./views/steer-composer.js";

const card: AssignmentCard = {
  token: "assignment-working", tone: "info", label: "Building",
  status: { headline: "Building", tone: "info", sentence: "Step 2 of 4: Add the guard", details: [], primaryAction: null, why: [] },
  action: null, reasons: [], diagnostics: [], notices: null, attempts: [], lead: null,
};
const pauseOf = (run: number) => ({ action: "/t/t-1/pause", run, state: null, requests: [`web-a${run}`, `web-b${run}`, `web-c${run}`] as [string, string, string], until: null, limitMs: null });
const taskView = (run: number, recent: number[] = []): BrowserTaskView => ({
  kind: "task", id: "t-1", title: "Guard the payout path", project: null, scout: false, tabs: [], version: null,
  status: card, statusHtml: "", approval: "", lead: [], questions: "", facts: [], sections: [], manage: [], cancel: null, thread: [],
  stop: { action: "/t/t-1/stop", run }, pause: pauseOf(run), ...(recent.length === 0 ? {} : { steerRecent: recent }),
});

let root: Root | null = null, host: HTMLElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { if (root !== null) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const show = (view: BrowserTaskView) => act(() => root!.render(createElement(TaskView, { view, details: false, csrf: "csrf" })));

test("Pause and steer's words stay with the attempt they were written for", () => {
  show(taskView(5));
  act(() => (host.querySelector("[data-pause-steer]") as HTMLButtonElement).click());
  const box = host.querySelector<HTMLTextAreaElement>("[data-pause-steer-note]")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "skip the flaky test"); box.dispatchEvent(new Event("input", { bubbles: true })); });
  const formOf = () => host.querySelector<HTMLFormElement>('[data-task-control="pause-and-steer"]')!;
  expect(formOf().querySelector<HTMLInputElement>('input[name="run"]')!.value).toBe("5");
  const firstKey = formOf().querySelector<HTMLInputElement>('input[name="key"]')!.value;
  // A new attempt starts while the page is open: its form is empty and its own, never the old words aimed at run 6.
  show(taskView(6));
  const now = formOf();
  expect(now).not.toBeNull();
  expect(now.querySelector<HTMLInputElement>('input[name="run"]')!.value).toBe("6");
  expect(now.querySelector<HTMLTextAreaElement>("[data-pause-steer-note]")!.value).toBe("");
  expect(now.querySelector<HTMLInputElement>('input[name="key"]')!.value).not.toBe(firstKey);
});

test("a note left for an attempt that ends while the page is open is offered to the next one, without a reload", () => {
  show(taskView(5, [4]));
  expect(host.querySelector("[data-steer-unsent]")).toBeNull();
  // Run 5 had a note in this tab that never went; it ends, and the page's next read lists it among the ended ones.
  saveDraft(5, { text: "check the migration first", key: "k-unsent-0005", submitted: true });
  show(taskView(6, [5, 4]));
  expect(host.querySelector("[data-steer-unsent]")?.getAttribute("data-steer-unsent")).toBe("5");
  expect(host.querySelector("[data-steer-unsent-text]")?.textContent).toBe("check the migration first");
});
