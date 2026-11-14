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
