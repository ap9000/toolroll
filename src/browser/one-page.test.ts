// @vitest-environment happy-dom
/** One page per task (docs/plans/one-page-task-and-agent.md): the tabs keep every panel mounted and the address keeps
 * the tab; the Result tab holds the result it loaded (a newer one is announced, never swapped in); and the current
 * result on a task page still says what is its own — its report not matching its changes, its caveats. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserTaskView } from "../browser-workspace.js";
import { TaskView } from "./views/task-view.js";
import { SelectedResult } from "./views/result-view.js";

type Selected = NonNullable<BrowserTaskView["result"]>["selected"];
const selectedOf = (build: number, extra: Partial<Selected> = {}): Selected => ({
  taskId: "t-1", title: "Release check", project: null, build, taskHref: "/t/t-1", chatHref: "/chat?task=t-1",
  status: { label: "Ready for review", tone: "success", token: "assignment-ready" }, problem: null, next: null, complete: null, decision: null, checks: null,
  mismatch: null, acts: { primary: null, secondary: null, line: null }, runChecks: null, intent: null, noRun: null, panel: null, notes: [], record: null, failure: null, ...extra,
} as Selected);
const viewOf = (extra: Partial<BrowserTaskView> = {}): BrowserTaskView => ({
  kind: "task", id: "t-1", title: "Release check", project: null, scout: false, tabs: [], version: null,
  status: null, statusHtml: "<p>Ready</p>", approval: "", lead: [], questions: "", facts: [], sections: [{ id: "scope", title: "Scope", html: "<p id=\"scope-words\">Goal</p>", open: true, count: null }],
  manage: [], cancel: null, thread: [], ...extra,
});
const shown = (selected: Selected) => createElement("div", { "data-shown": selected.build });

let root: Root | null = null, host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  history.replaceState(null, "", "/t/t-1");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (view: BrowserTaskView) => act(() => root!.render(createElement(TaskView, { view, details: false, csrf: "c", result: shown })));
const panel = (key: string) => host.querySelector<HTMLElement>(`[data-task-panel="${key}"]`)!;

test("the tab the address names is in front; switching keeps every panel mounted and the address follows", () => {
  render(viewOf({ tab: "plan" }));
  expect(panel("plan").hidden).toBe(false);
  expect(panel("activity").hidden).toBe(true);
  act(() => host.querySelector<HTMLButtonElement>('[data-task-tab="result"]')!.click());
  expect(panel("result").hidden).toBe(false);
  expect(panel("plan").hidden).toBe(true);
  // Hidden, never unmounted: the Plan's content is still there.
  expect(host.querySelector("#scope-words")).not.toBeNull();
  expect(new URL(location.href).searchParams.get("tab")).toBe("result");
  act(() => host.querySelector<HTMLButtonElement>('[data-task-tab="activity"]')!.click());
  expect(new URL(location.href).searchParams.has("tab")).toBe(false);
});

test("the Result tab holds the result it loaded: an update or a newer run is announced with Reload, never swapped in", () => {
  const result = (build: number, revision: string) => ({ selected: selectedOf(build), current: true, attempts: [], revision });
  render(viewOf({ tab: "result", result: result(5, "r1") }));
  expect(host.querySelector("[data-shown]")?.getAttribute("data-shown")).toBe("5");
  expect(host.querySelector("[data-result-newer]")).toBeNull();
  render(viewOf({ tab: "result", result: result(5, "r2") }));
  expect(host.querySelector("[data-shown]")?.getAttribute("data-shown")).toBe("5");
  expect(host.querySelector("[data-result-newer]")?.textContent).toContain("This result was updated.");
  render(viewOf({ tab: "result", result: result(6, "r3") }));
  expect(host.querySelector("[data-shown]")?.getAttribute("data-shown")).toBe("5");
  expect(host.querySelector("[data-result-newer]")?.textContent).toContain("A newer result is ready.");
});

test("a first result arriving on a page opened before it is announced, not mounted", () => {
  render(viewOf({ tab: "result", result: null }));
  expect(host.querySelector('[data-task-result="none"]')).not.toBeNull();
  render(viewOf({ tab: "result", result: { selected: selectedOf(7), current: true, attempts: [], revision: "r1" } }));
  expect(host.querySelector("[data-shown]")).toBeNull();
  expect(host.querySelector("[data-result-newer]")?.textContent).toContain("A result is ready.");
});

test("the current result on a task page drops only its duplicate status: what doesn't match and its caveats still show", () => {
  const selected = selectedOf(5, {
    mismatch: { headline: "The report doesn't match the changes", said: [],
      rows: [{ text: "It changed a file outside the approved paths.", path: "src/elsewhere.ts", lines: null, href: null, absent: false, noteLabel: null }] },
    problem: "The saved report was shortened.",
  });
  act(() => root!.render(createElement(SelectedResult, { selected, csrf: "c", inTask: { current: true } })));
  expect(host.querySelector("[data-result-status]")).toBeNull();
  const warnings = host.querySelector("[data-result-warnings]")!;
  expect(warnings.textContent).toContain("The report doesn't match the changes");
  expect(warnings.textContent).toContain("It changed a file outside the approved paths.");
  expect(warnings.textContent).toContain("The saved report was shortened.");
  // An earlier attempt keeps its whole card.
  act(() => root!.render(createElement(SelectedResult, { selected, csrf: "c", inTask: { current: false } })));
  expect(host.querySelector("[data-result-status]")).not.toBeNull();
});
