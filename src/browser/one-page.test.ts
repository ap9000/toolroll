// @vitest-environment happy-dom
/** One page per task (docs/plans/task-page-steps.md): the steps are the page, closed rows stay mounted, the address
 * keeps its tab; the Result tab holds the result it loaded (a newer one is announced, never swapped in); and the current
 * result on a task page still says what is its own — its report not matching its changes, its caveats. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserTaskView } from "../browser-workspace.js";
import { TaskView } from "./views/task-view.js";
import { SelectedResult } from "./views/result-view.js";
import { taskRoad } from "../first-run.js";
import { stepRowsOf } from "../workspace-ui.js";

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

/** A view with its road and rows (as the server sends it): building, or finished with a result to review. */
const withRows = (stage: "building" | "review", extra: Partial<BrowserTaskView> = {}): BrowserTaskView => {
  const journey = stage === "building" ? taskRoad({ stage: "building" }, true, false, {}) : taskRoad({ stage: "needs-you", need: "review-result" }, true, true, { checks: "passed" });
  const view = viewOf({ journey, approved: { by: "alex", at: "2026-11-10T09:00:00.000Z", automatic: false, rule: null, how: "", version: "v" },
    plan: { lead: "Add subtract next to add.", by: null, at: "2026-11-10T08:00:00.000Z", html: '<details id="plan-edit"><summary>Edit plan</summary><textarea></textarea></details>', planning: false, key: "sheet:v" },
    ...extra });
  return { ...view, steps: stepRowsOf(view) };
};
const row = (key: string) => host.querySelector<HTMLElement>(`[data-step-row="${key}"]`)!;
const body = (key: string) => row(key).querySelector<HTMLElement>(".k-steprow-body");

test("the steps are the page: the current row is open, finished rows open on press and stay mounted when closed", () => {
  render(withRows("building"));
  expect(host.querySelector("[role=tablist], .k-tabs, .k-steps")).toBeNull();
  expect(row("build").getAttribute("aria-current")).toBe("step");
  expect(body("build")!.hidden).toBe(false);
  // A finished row is one line whose head is a disclosure; its body is there, hidden.
  const head = row("plan").querySelector<HTMLButtonElement>("button.k-steprow-head")!;
  expect(head.getAttribute("aria-expanded")).toBe("false");
  expect(body("plan")!.hidden).toBe(true);
  expect(host.querySelector("#plan-edit")).not.toBeNull();
  act(() => head.click());
  expect(head.getAttribute("aria-expanded")).toBe("true");
  expect(body("plan")!.hidden).toBe(false);
  act(() => head.click());
  expect(body("plan")!.hidden).toBe(true);
  expect(host.querySelector("#plan-edit")).not.toBeNull();
  // Steps not reached are one line with nothing to open.
  expect(row("checks").querySelector("button")).toBeNull();
  expect(body("checks")).toBeNull();
  // Under the rows, More about this task keeps the old Plan tab's sections.
  expect(host.querySelector("[data-task-more-about] #scope-words")).not.toBeNull();
});

test("the address keeps its tab: activity opens the panel, result opens Ready, attempts opens Build", () => {
  render(withRows("building", { tab: "activity" }));
  expect(panel("activity").hidden).toBe(false);
  act(() => host.querySelector<HTMLButtonElement>("[data-close-activity]")!.click());
  expect(panel("activity").hidden).toBe(true);
  expect(new URL(location.href).searchParams.has("tab")).toBe(false);
  act(() => host.querySelector<HTMLButtonElement>("[data-open-activity]")!.click());
  expect(panel("activity").hidden).toBe(false);
  expect(new URL(location.href).searchParams.get("tab")).toBe("activity");
  act(() => root!.unmount()); root = createRoot(host);
  const result = { selected: selectedOf(5), current: true, attempts: [], revision: "r1" };
  render(withRows("review", { tab: "result", result }));
  expect(body("ready")!.hidden).toBe(false);
  expect(host.querySelector("[data-step-row=\"ready\"] [data-shown]")?.getAttribute("data-shown")).toBe("5");
});

test("a hash link to a part inside a closed row opens that row; links to another version or run are not intercepted", () => {
  history.replaceState(null, "", "/t/t-1#plan-edit");
  render(withRows("building"));
  expect(body("plan")!.hidden).toBe(false);
  history.replaceState(null, "", "/t/t-1");
  const link = (href: string) => { const a = document.createElement("a"); a.href = href; a.textContent = "go"; host.querySelector(".k-doc")!.append(a); return a; };
  const click = (a: HTMLAnchorElement) => { const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }); act(() => { a.dispatchEvent(event); }); return event.defaultPrevented; };
  expect(click(link("/t/t-1?tab=attempts"))).toBe(true);
  expect(click(link("/t/t-1?version=t-0&tab=attempts"))).toBe(false);
  expect(click(link("/t/t-1?tab=result&run=99"))).toBe(false);
  expect(click(link("/t/t-1?tab=attempts&section=holds"))).toBe(false);
});

test("a live update keeps the result the Ready row loaded, and announces a newer one", () => {
  const result = (build: number, revision: string) => ({ selected: selectedOf(build), current: true, attempts: [], revision });
  render(withRows("review", { result: result(5, "r1") }));
  render(withRows("review", { result: result(6, "r2") }));
  expect(host.querySelector("[data-step-row=\"ready\"] [data-shown]")?.getAttribute("data-shown")).toBe("5");
  expect(host.querySelector("[data-result-newer]")?.textContent).toContain("A newer result is ready.");
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
  // No result yet: the first tab is the Plan, with no empty result in it.
  render(viewOf({ tab: "result", result: null }));
  expect(host.querySelector("[data-task-result]")).toBeNull();
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

test("How it ran: the result's record says time, turns, tokens and cache in one line, unknowns as a dash, and why steps are missing", () => {
  const efficiency = { version: 1, time: { waitMs: 12_000, agentMs: 14 * 60_000 }, turns: 38,
    usage: { in: 1_900_000, out: 41_000, cacheRead: 1_539_000, cacheWrite: null, cacheShare: 0.81, provider: "claude", model: "sonnet" },
    steps: { state: "expired" as const, reason: "Step details are kept for a day after a run; this one's have expired.", total: null, failed: null, unknownDuration: null, byKind: {}, longest: [], repeats: null, repeatsReason: null } };
  act(() => root!.render(createElement(SelectedResult, { selected: selectedOf(5, { efficiency }), csrf: "c" })));
  const row = host.querySelector("#how-it-ran")!;
  expect(row.querySelector("summary")?.textContent).toContain("14 min · 38 turns · 1.9M tokens in, 81% from cache · 41k out");
  expect(row.querySelector("[data-run-efficiency-steps]")?.textContent).toContain("have expired");
  const unknown = { ...efficiency, turns: null, usage: { ...efficiency.usage, in: null, out: null, cacheShare: null } };
  act(() => root!.render(createElement(SelectedResult, { selected: selectedOf(6, { efficiency: unknown }), csrf: "c" })));
  expect(host.querySelector("#how-it-ran summary")?.textContent).toContain("14 min · — tokens in · — out");
});

test("Can I merge? sits with a result in the Ready row: never loose under the rows, never on a research task", () => {
  const mergeReady = { answer: "not-yet" as const, sentence: "Not yet: the checks are still running.", rows: [] };
  const result = { selected: selectedOf(5), current: true, attempts: [], revision: "r1" };
  // Still building: no result, so no merge answer anywhere on the page.
  render(withRows("building", { mergeReady }));
  expect(host.querySelector("[data-merge-ready]")).toBeNull();
  // A result to review: the answer is in the Ready row, once, with a plain chip.
  act(() => root!.render(createElement(TaskView, { key: "review", view: withRows("review", { mergeReady, result }), details: false, csrf: "c", result: shown })));
  expect([...host.querySelectorAll("[data-merge-ready]")].map(one => one.closest("[data-step-row]")?.getAttribute("data-step-row"))).toEqual(["ready"]);
  expect(host.querySelector("[data-merge-ready] .k-chip")?.className).not.toMatch(/needs|ink/);
  // A research task has nothing to merge.
  act(() => root!.render(createElement(TaskView, { key: "scout", view: withRows("review", { mergeReady, result, scout: true }), details: false, csrf: "c", result: shown })));
  expect(host.querySelector("[data-merge-ready]")).toBeNull();
});
