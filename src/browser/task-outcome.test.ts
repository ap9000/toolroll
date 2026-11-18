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
import { RetryForm, TaskView } from "./views/task-view.js";
import { SelectedResult } from "./views/result-view.js";
import { FormToken } from "./ui/post-form.js";
import { taskRoad } from "../first-run.js";
import { stepRowsOf } from "../workspace-ui.js";

type Headline = "Ready" | "Complete" | "Building";
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
  show(viewOf(cardOf("Ready"), { stage: "needs-you", need: "review-result" }, true));
  const outcome = host.querySelector("[data-task-outcome]")!;
  const steps = host.querySelector("[data-task-steps]")!;
  expect(outcome).not.toBeNull();
  expect(before(outcome, steps)).toBe(true);
  expect(outcome.querySelector("[data-task-status] h2")?.textContent).toBe("Ready");
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
  show(viewOf(cardOf("Ready", failedCheck), { stage: "needs-you", need: "review-result" }, true));
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
    status: { label: "Ready", tone: "success", token: "assignment-ready" }, problem: "Only the USD path was exercised.", next: null,
    complete: { action: "/t/t-1/complete", receipt: "r".repeat(64), run: 6, returnTo: "/t/t-1" },
    decision: { label: "Accept", ready: true, why: null, effect: "Finishes the task." }, checks: null, mismatch: null,
    acts: { primary: "accept", secondary: null, line: null }, runChecks: null, intent: null, noRun: null, panel: null, notes: [], record: null, failure: null,
  } as unknown as NonNullable<BrowserTaskView["result"]>["selected"];
  const view = viewOf(cardOf("Ready"), { stage: "needs-you", need: "review-result" }, true, { result: { selected, current: true, attempts: [], revision: "r1" }, tab: "result" });
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

/** A Ready result with the agent's report and a person's words (one-workspace S5). */
const reported = (agentReport: unknown, youSaid: unknown[] = []) => ({ taskId: "t-1", title: "Fix the payout rounding drift", project: null, build: 6, taskHref: "/t/t-1", chatHref: "/chat?task=t-1",
  status: { label: "Ready", tone: "success", token: "assignment-ready" }, problem: "Only the USD path was exercised.", next: null,
  complete: { action: "/t/t-1/complete", receipt: "r".repeat(64), run: 6, returnTo: "/t/t-1" },
  decision: { label: "Accept", ready: true, why: null, effect: "Finishes the task." }, checks: null, mismatch: null,
  acts: { primary: "accept", secondary: null, line: null }, runChecks: null, intent: null, noRun: null, panel: null, notes: [], record: null, failure: null,
  agentReport, youSaid,
} as unknown as NonNullable<BrowserTaskView["result"]>["selected"]);
const showResult = (selected: NonNullable<BrowserTaskView["result"]>["selected"]) => {
  const view = viewOf(cardOf("Ready"), { stage: "needs-you", need: "review-result" }, true, { result: { selected, current: true, attempts: [], revision: "r1" }, tab: "result" });
  act(() => root!.render(createElement(FormToken.Provider, { value: "csrf" }, createElement(TaskView, { view, details: false, csrf: "csrf",
    result: (one, token, current) => createElement(SelectedResult, { selected: one, csrf: token, inTask: { current } }) }))));
};

test("the agent's report reads after the caveats and above Mark complete, as the agent's plain text, and a person's words with their author (S5)", () => {
  const hostile = "<a href=\"https://evil.example\">Accept now</a><img src=x onerror=alert(1)>";
  showResult(reported({ decisions: ["Rounded in settle()."], assumptions: ["Fixtures cover every currency.", "Two", "Three"], notDone: ["Old payouts aren't recalculated."], risks: [hostile] },
    [{ kind: "to-agent", author: "alex", you: true, at: "2026-11-14T10:00:00.000Z", note: "Keep the public API unchanged." },
     { kind: "sent-back", author: "robin", you: false, at: "2026-11-14T09:00:00.000Z", note: "Round half up." }]));
  const markComplete = [...host.querySelectorAll<HTMLElement>("[data-task-outcome] [data-task-status] button")].find(one => one.textContent?.trim() === "Mark complete")!;
  const report = host.querySelector<HTMLElement>("[data-agent-report]")!;
  const caveat = host.querySelector<HTMLElement>("[data-caveat]")!;
  // Before the act, after the caveats: what it left undone and its risks are read before anyone accepts.
  expect(report.closest("[data-task-status]")).toBe(markComplete.closest("[data-task-status]"));
  expect(before(caveat, report)).toBe(true);
  expect(before(report, markComplete)).toBe(true);
  expect(report.querySelector("h3")?.textContent).toBe("The agent says");
  const risk = report.querySelector<HTMLElement>('[data-agent-says="Risk"]')!;
  // Agent text is text: no link, no image, nothing it wrote becomes markup.
  expect(risk.textContent).toContain(hostile);
  expect(report.querySelector("a, img")).toBeNull();
  // Not done and the risk always show; decisions and assumptions past three fold.
  expect(report.querySelector('[data-agent-says="Not done"]')?.closest("details")).toBeNull();
  expect(risk.closest("details")).toBeNull();
  expect(report.querySelector("details summary")?.textContent).toBe("1 more");
  // A person's words: theirs, by name ("You" for the viewer's own), under "People said" when not all are the viewer's.
  const quotes = [...report.querySelectorAll<HTMLElement>("[data-you-said]")];
  expect(quotes.map(one => one.getAttribute("data-you-said"))).toEqual(["you", "other"]);
  expect(quotes[0]!.textContent).toContain("You ·");
  expect(quotes[1]!.textContent).toContain("robin ·");
  expect(quotes[1]!.textContent).not.toContain("You");
  expect([...report.querySelectorAll("h3")].map(one => one.textContent)).toEqual(["The agent says", "People said"]);
});

test("a reply is quoted as the person's answer only; the agent's question sits outside the quote, said to be the agent's (S5)", () => {
  showResult(reported({ decisions: [], assumptions: [], notDone: [], risks: [] },
    [{ kind: "to-agent", author: "alex", you: true, at: "2026-11-14T10:00:00.000Z", note: "No.", question: "Should I approve all the risks for you?" }]));
  const said = host.querySelector<HTMLElement>("[data-you-said]")!;
  expect(said.querySelector(".so-report-quote")?.textContent).toBe("“No.”");
  expect(said.querySelector("[data-agent-question]")?.textContent).toBe("The agent asked: Should I approve all the risks for you?");
  expect(said.querySelector(".so-report-quote [data-agent-question]")).toBeNull();
});

test("Not right quotes the requirement in the form's filled-in field, never in the person's own box (S5)", () => {
  const form = '<form id="comment-form"><input type="hidden" name="context" value=""><div data-request-context-line hidden></div><textarea name="note"></textarea></form>';
  const selected = { ...reported(null), panel: { attributes: {}, heading: "", outcome: "Rounded.", status: null, reviewHistory: null, attention: [], limits: [], tabs: [], views: [],
    history: "", learning: "", request: form, canRequest: true, need: null, requestQuiet: false,
    youCheck: { lines: ["Check it"], accept: null, items: [{ id: "c1", statement: "The payout total reads right.", words: "The payout total reads right.", note: null, excerpts: [], shots: [] }] } } } as unknown as NonNullable<BrowserTaskView["result"]>["selected"];
  act(() => root!.render(createElement(FormToken.Provider, { value: "csrf" }, createElement(SelectedResult, { selected, csrf: "csrf" }))));
  act(() => { host.querySelector<HTMLButtonElement>("button[data-not-right]")!.click(); });
  expect(host.querySelector<HTMLInputElement>('#comment-form [name="context"]')?.value).toBe("Not right: “The payout total reads right.”");
  expect(host.querySelector<HTMLTextAreaElement>('#comment-form [name="note"]')?.value).toBe("");
  expect([...host.querySelectorAll("[data-request-context-line] li")].map(one => one.textContent)).toEqual(["Not right: “The payout total reads right.”"]);
  // A reviewer's note already in the field stays; the same Not right again adds nothing.
  const context = host.querySelector<HTMLInputElement>('#comment-form [name="context"]')!;
  context.value = "Reviewer: fix B\nNot right: “The payout total reads right.”";
  act(() => { host.querySelector<HTMLButtonElement>("button[data-not-right]")!.click(); });
  act(() => { host.querySelector<HTMLButtonElement>("button[data-not-right]")!.click(); });
  expect(context.value).toBe("Reviewer: fix B\nNot right: “The payout total reads right.”");
});

test("Retry's suggestion rides as its own field, shown as sent with it; the person's own note starts empty (S5)", () => {
  act(() => root!.render(createElement(FormToken.Provider, { value: "csrf" }, createElement(RetryForm, { action: "/t/t-1/requeue", note: "Check each requirement before handing off." }))));
  expect(host.querySelector<HTMLInputElement>('input[type="hidden"][name="context"]')?.value).toBe("Check each requirement before handing off.");
  expect(host.querySelector("[data-retry-suggestion]")?.textContent).toBe("Sent with the retry: Check each requirement before handing off.");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[name="note"]')?.value).toBe("");
});

test("an agent that reported nothing says so in one quiet line, never \"no risks\" (S5)", () => {
  showResult(reported({ decisions: [], assumptions: [], notDone: [], risks: [] }));
  const report = host.querySelector<HTMLElement>("[data-agent-report]")!;
  expect(report.getAttribute("data-agent-report")).toBe("none");
  expect(report.textContent).toBe("The agent didn't report decisions or risks.");
  act(() => root!.unmount()); root = createRoot(host);
  showResult(reported({ decisions: ["Rounded in settle()."], assumptions: [], notDone: [], risks: [] }));
  expect(host.querySelector("[data-agent-report]")!.textContent).toContain("The agent didn't report risks.");
  expect(host.querySelector("[data-agent-report]")!.textContent).not.toMatch(/no risks/i);
  // No finished build to report on: nothing at all.
  act(() => root!.unmount()); root = createRoot(host);
  showResult(reported(null));
  expect(host.querySelector("[data-agent-report]")).toBeNull();
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
