// @vitest-environment happy-dom
/** Outcome first (one-workspace plan S1): a task whose result waits on this person's review, or a finished task, leads
 * with its status, its sentence, its caveats and its one act, then its result; the steps that got it there fold under
 * "Plan and steps". A machine-reported failure (a failed check) reads in that status before the act, never only in a
 * fold below it (approval criterion 5). A task that is running or waits on an approval keeps its open steps. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AssignmentCard } from "../assignment-ui.js";
import type { BrowserTaskView } from "../browser-workspace.js";
import { TaskView } from "./views/task-view.js";
import { SelectedResult } from "./views/result-view.js";
import { FormToken } from "./ui/post-form.js";
import { taskRoad } from "../first-run.js";
import { stepRowsOf } from "../workspace-ui.js";

type Headline = "Ready for review" | "Complete" | "Building";
const cardOf = (headline: Headline, details: AssignmentCard["status"]["details"] = []): AssignmentCard => ({
  token: "assignment", tone: headline === "Building" ? "info" : "attention", label: headline,
  status: { headline, tone: headline === "Building" ? "live" : "attention", sentence: headline === "Building" ? "Step 2 of 4." : "Checks failed on 9e07b41. Look at the failure before accepting.",
    details, primaryAction: null, why: [] },
  action: headline === "Building" ? null : { label: "Review and accept", href: "/t/t-1?tab=result&run=6" }, reasons: [], diagnostics: [], notices: null, attempts: [], lead: null,
} as AssignmentCard);
const viewOf = (card: AssignmentCard, read: Parameters<typeof taskRoad>[0], built: boolean, extra: Partial<BrowserTaskView> = {}): BrowserTaskView => {
  const view = { kind: "task", id: "t-1", title: "Fix the payout rounding drift", project: null, scout: false, tabs: [], version: null,
    status: card, statusHtml: "", approval: "", lead: [], questions: "", facts: [], sections: [], manage: [], cancel: null, thread: [],
    plan: { lead: "Round at cent precision.", by: null, at: null, planning: false, key: "sheet:d1", html: '<article data-plan-sheet><p id="plan-words">Round at cent precision.</p></article>' },
    journey: taskRoad(read, true, built, { checks: "passed" }), ...extra } as BrowserTaskView;
  return { ...view, steps: stepRowsOf(view) };
};
const failedCheck = [
  { key: "checks", label: "Project checks", text: "Failed on 9e07b41", href: null, mark: "failed", action: null, why: null },
] as AssignmentCard["status"]["details"];

let root: Root | null = null, host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root !== null) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const show = (view: BrowserTaskView, key = "page") => act(() => root!.render(createElement(FormToken.Provider, { value: "csrf" }, createElement(TaskView, { key, view, details: false, csrf: "csrf" }))));
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

test("a result waiting on review: status, sentence and the act first, then the steps folded under Plan and steps", () => {
  show(viewOf(cardOf("Ready for review"), { stage: "needs-you", need: "review-result" }, true));
  const outcome = host.querySelector("[data-task-outcome]")!;
  const steps = host.querySelector("[data-task-steps]")!;
  expect(outcome).not.toBeNull();
  expect(before(outcome, steps)).toBe(true);
  expect(outcome.querySelector("[data-task-status] h2")?.textContent).toBe("Ready for your review");
  expect(outcome.textContent).toContain("Look at the failure before accepting.");
  expect(outcome.querySelector("[data-primary-action]")?.textContent).toBe("Review and accept");
  // The steps are there, folded: the plan is one tap away, never ahead of the outcome.
  const fold = steps.querySelector("details")!;
  expect(fold.open).toBe(false);
  expect(fold.querySelector("summary")?.textContent).toBe("Plan and steps");
  expect(fold.querySelector("#plan-words")).not.toBeNull();
  // Said once: the Ready row holds nothing the outcome already says.
  expect(steps.querySelector('[data-step-row="ready"] .k-steprow-body')).toBeNull();
  expect(host.querySelectorAll("[data-task-status]")).toHaveLength(1);
});

test("a failed check reads in the leading status, before its act: never only in the folded Checks row (approval criterion 5)", () => {
  show(viewOf(cardOf("Ready for review", failedCheck), { stage: "needs-you", need: "review-result" }, true));
  const outcome = host.querySelector("[data-task-outcome]")!;
  const failure = outcome.querySelector('[data-status-detail="checks"]');
  expect(failure?.textContent).toBe("Failed on 9e07b41");
  expect(failure!.closest("details")).toBeNull();
  const act = outcome.querySelector("[data-primary-action]")!;
  expect(before(outcome.querySelector("[data-task-status] h2")!, act)).toBe(true);
  expect(failure!.closest("[data-task-status]")).toBe(act.closest("[data-task-status]"));
  // Read before the act, in order: the failed check comes ahead of the control that completes the work.
  expect(before(failure!, act)).toBe(true);
});

test("the result's own caveats and its mismatch read above Mark complete, never under it (review finding 2)", () => {
  const selected = { taskId: "t-1", title: "Fix the payout rounding drift", project: null, build: 6, taskHref: "/t/t-1", chatHref: "/chat?task=t-1",
    status: { label: "Ready for review", tone: "success", token: "assignment-ready" }, problem: "Only the USD path was exercised.", next: null,
    complete: { action: "/t/t-1/complete", receipt: "r".repeat(64), run: 6, returnTo: "/t/t-1" },
    decision: { label: "Accept", ready: true, why: null, effect: "Finishes the task." }, checks: null, mismatch: null,
    acts: { primary: "accept", secondary: null, line: null }, runChecks: null, intent: null, noRun: null, panel: null, notes: [], record: null, failure: null,
  } as unknown as NonNullable<BrowserTaskView["result"]>["selected"];
  const view = viewOf(cardOf("Ready for review"), { stage: "needs-you", need: "review-result" }, true, { result: { selected, current: true, attempts: [], revision: "r1" }, tab: "result" });
  act(() => root!.render(createElement(FormToken.Provider, { value: "csrf" }, createElement(TaskView, { view, details: false, csrf: "csrf",
    result: (one, token, current) => createElement(SelectedResult, { selected: one, csrf: token, inTask: { current } }) }))));
  const markComplete = [...host.querySelectorAll<HTMLElement>("[data-task-outcome] [data-task-status] button")].find(one => one.textContent?.trim() === "Mark complete");
  expect(markComplete).toBeDefined();
  const caveat = [...host.querySelectorAll<HTMLElement>("[data-result-warnings]")].find(one => one.textContent?.includes("Only the USD path was exercised."));
  expect(caveat).toBeDefined();
  // In the status box, above the act: never below it.
  expect(caveat!.closest("[data-task-status]")).toBe(markComplete!.closest("[data-task-status]"));
  expect(before(caveat!, markComplete!)).toBe(true);
  expect(host.querySelectorAll("[data-result-warnings]")).toHaveLength(1);
});

test("an earlier result shows that result and Open current work, and none of the current work's controls (review finding 1)", () => {
  const selected = { taskId: "t-1", title: "Fix the payout rounding drift", project: null, build: 4, taskHref: "/t/t-1", chatHref: "/chat?task=t-1",
    status: { label: "Failed", tone: "danger", token: "failed" }, problem: null, next: null, complete: null, decision: null, checks: null, mismatch: null,
    acts: { primary: null, secondary: null, line: null }, runChecks: null, intent: null, noRun: null, panel: null, notes: [], record: null, failure: null,
  } as unknown as NonNullable<BrowserTaskView["result"]>["selected"];
  // Even handed a view that still carries the live run's controls, the page renders none of them.
  const view = viewOf(cardOf("Building"), { stage: "building" }, false, {
    historical: { label: "Build #4. The task has moved on since.", href: "/t/t-1" },
    result: { selected, current: false, attempts: [], revision: "r1" }, tab: "result",
    stop: { action: "/t/t-1/stop", run: 5 }, retry: { action: "/t/t-1/requeue", pins: null },
    approve: { action: "/t/t-1/approve", fields: { nonce: "n", digest: "d" }, label: "Approve", heading: "Plan ready", text: "", kind: "standard", facts: { passwordless: true, remembered: false }, rememberedUntil: null, planHtml: "" },
  });
  act(() => root!.render(createElement(FormToken.Provider, { value: "csrf" }, createElement(TaskView, { view, details: false, csrf: "csrf",
    result: one => createElement("div", { "data-shown": one.build }) }))));
  expect(host.querySelector("[data-shown]")?.getAttribute("data-shown")).toBe("4");
  expect(host.querySelector<HTMLAnchorElement>("[data-open-current]")?.getAttribute("href")).toBe("/t/t-1");
  expect(host.textContent).toContain("Earlier result");
  expect(host.textContent).toContain("Build #4. The task has moved on since.");
  expect(host.querySelectorAll("form")).toHaveLength(0);
  for (const gone of ["[data-task-status]", "[data-task-approval]", "[data-task-panel]", "[data-step-row]", "[data-task-more-about]", ".so-task-tools"]) expect(host.querySelector(gone), gone).toBeNull();
  expect(document.querySelector(".k-dock")).toBeNull();
});

test("a finished task leads with its outcome too; the plan opens from the fold when asked", () => {
  show(viewOf(cardOf("Complete"), { stage: "complete" }, true));
  expect(host.querySelector("[data-task-outcome] [data-task-status]")).not.toBeNull();
  const fold = host.querySelector<HTMLDetailsElement>("[data-task-steps] details")!;
  expect(fold.open).toBe(false);
  act(() => { fold.open = true; fold.dispatchEvent(new Event("toggle")); });
  expect(fold.open).toBe(true);
});

test("a running build keeps its open steps: nothing folds", () => {
  show(viewOf(cardOf("Building"), { stage: "building" }, false));
  expect(host.querySelector("[data-task-outcome]")).toBeNull();
  expect(host.querySelector("[data-task-steps]")).toBeNull();
  expect(host.querySelector('[data-step-row="build"]')?.getAttribute("aria-current")).toBe("step");
  expect(host.querySelector('[data-step-row="build"]')!.closest("details")).toBeNull();
});
