// @vitest-environment happy-dom
/** The task page's approval follows the real rules (src/design/KIT.md "Approval", views/task-view.tsx): a password
 * popover only when one is needed; one click with Passwordless on or a password remembered here; nothing to press when a
 * rule approves automatically; and the box keeps the terms it first showed. And the page never stacks folds: one More
 * on the status box, and a fold inside a fold opens with it. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AssignmentCard } from "../assignment-ui.js";
import type { BrowserTaskThreadItem, BrowserTaskView } from "../browser-workspace.js";
import { TaskView } from "./views/task-view.js";
import { Passwordless } from "./ui/post-form.js";
import { taskRoad } from "../first-run.js";
import { stepRowsOf } from "../workspace-ui.js";

const cardOf = (headline: "Needs you" | "Building", action: AssignmentCard["action"] = { label: "Open result", href: "/review?result=t-1" }): AssignmentCard => ({
  token: "assignment", tone: headline === "Needs you" ? "attention" : "info", label: headline,
  status: { headline, tone: headline === "Needs you" ? "attention" : "live", sentence: "The plan changed after build #12.", details: [], primaryAction: null, why: ["Checks: exit 1"] },
  action, reasons: [], diagnostics: [], notices: { summary: "Saved output is partial", lines: ["The check log was shortened when stored."] }, attempts: [], lead: null,
});
const viewOf = (card: AssignmentCard, extra: Partial<BrowserTaskView> = {}): BrowserTaskView => ({
  kind: "task", id: "t-1", title: "Release check", project: null, scout: false, tabs: [], version: null,
  status: card, statusHtml: "", approval: "", lead: [], questions: "", facts: [], sections: [], manage: [], cancel: null, thread: [], ...extra,
});

let root: Root | null = null, host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  submitted = [];
  vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(function (this: HTMLFormElement) {
    submitted.push({ action: this.getAttribute("action") ?? "", token: this.querySelector<HTMLInputElement>('input[name="token"]')?.value ?? null });
  });
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root !== null) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
/** `key`: a new server render of the page (its native regions install once; a new render mounts them afresh). */
const show = (view: BrowserTaskView, key = "page") => act(() => root!.render(createElement(TaskView, { key, view, details: false, csrf: "csrf" })));

type Approve = NonNullable<BrowserTaskView["approve"]>;
const approveOf = (facts: Approve["facts"], digest = "d1", rememberedUntil: string | null = null): Approve => ({
  action: "/t/t-1/approve", fields: { nonce: "n1", digest }, label: "Approve and start", heading: "Plan ready",
  text: "Approving signs plan version d1 and starts the build.", kind: "standard", facts, rememberedUntil, planHtml: "<p id=\"plan-words\">Goal</p>" });
/** The submits a press asked for, and the password each carried (the native form posts; nothing is sent here). */
let submitted: { action: string; token: string | null }[] = [];
const pressApprove = () => act(() => [...host.querySelectorAll<HTMLButtonElement>("[data-task-approval] .k-slot-acts button")].find(one => one.textContent === "Approve and start")!.click());
const popover = () => document.querySelector<HTMLElement>(".k-pop");

test("a password is needed: Approve opens a password popover, and only its submit sends the form, with the password", () => {
  show(viewOf(cardOf("Needs you", null), { approve: approveOf({ passwordless: false, remembered: false }) }));
  expect(host.textContent).toContain("Asks for your password.");
  pressApprove();
  expect(submitted).toEqual([]);
  const field = popover()!.querySelector<HTMLInputElement>('input[name="token"]')!;
  expect(field.type).toBe("password");
  field.value = "s3cret";
  act(() => popover()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(submitted).toEqual([{ action: "/t/t-1/approve", token: "s3cret" }]);
});

test("Passwordless on, or a password remembered here: one click, no popover", () => {
  for (const facts of [{ passwordless: true, remembered: false }, { passwordless: false, remembered: true }]) {
    submitted = [];
    show(viewOf(cardOf("Needs you", null), { approve: approveOf(facts, "d1", facts.remembered ? "2026-11-02T10:47:00.000Z" : null) }), JSON.stringify(facts));
    expect(host.textContent).toContain("No password needed");
    pressApprove();
    expect(popover()).toBeNull();
    expect(submitted).toEqual([{ action: "/t/t-1/approve", token: "" }]);
  }
});

test("a rule approves automatically: nothing to press", () => {
  show(viewOf(cardOf("Needs you", null), { approve: approveOf({ passwordless: false, remembered: false, automatic: true }) }));
  expect([...host.querySelectorAll("[data-task-approval] button")].some(one => one.textContent === "Approve and start")).toBe(false);
  expect(host.textContent).toContain("Approved automatically by your rule.");
});

test("the box keeps the terms it first showed: newer terms ask for a reload, never a yes", () => {
  show(viewOf(cardOf("Needs you", null), { approve: approveOf({ passwordless: true, remembered: false }, "d1") }));
  show(viewOf(cardOf("Needs you", null), { approve: approveOf({ passwordless: true, remembered: false }, "d2") }));
  expect(host.querySelector<HTMLInputElement>('[data-task-approval] input[name="digest"]')!.value).toBe("d1");
  expect(host.textContent).toContain("The plan changed since this page loaded.");
  expect([...host.querySelectorAll("[data-task-approval] button")].map(one => one.textContent)).toEqual(["Reload"]);
});

test("while the plan is being edited nothing approves: no Approve, no dock, until Save or Cancel", () => {
  const approve = { ...approveOf({ passwordless: true, remembered: false }), planHtml: '<details id="plan-editor"><summary>Edit plan</summary><textarea name="touches"></textarea></details>' };
  show(viewOf(cardOf("Needs you", null), { approve }));
  const approves = () => [...document.querySelectorAll("button")].filter(one => one.textContent === "Approve and start");
  expect(approves().length).toBeGreaterThan(0);
  const editor = host.querySelector<HTMLDetailsElement>("#plan-editor")!;
  act(() => { editor.open = true; editor.dispatchEvent(new Event("toggle")); });
  expect(approves()).toHaveLength(0);
  expect(host.textContent).toContain("You’re editing the plan.");
  expect(submitted).toEqual([]);
  act(() => { editor.open = false; editor.dispatchEvent(new Event("toggle")); });
  expect(approves().length).toBeGreaterThan(0);
});

test("Check again asks Toolroll to look once more: one button, no password, nothing to vouch for", () => {
  const view = viewOf(cardOf("Needs you", { label: "Check again", href: "#recheck-stopped" }), { recheckStopped: { action: "/t/t-1/recheck-stopped", run: 12 } });
  show(view);
  const form = host.querySelector<HTMLFormElement>("#recheck-stopped")!;
  expect(form.getAttribute("action")).toBe("/t/t-1/recheck-stopped");
  expect(form.querySelector<HTMLInputElement>('input[name="run"]')?.value).toBe("12");
  expect(form.querySelector('input[type="password"], input[name="token"], input[type="checkbox"]')).toBeNull();
  expect(form.querySelector("button")?.textContent).toBe("Check again");
  expect(host.textContent).not.toMatch(/Confirm it stopped/);
});

test("the status card has one fold: the notices' lines sit under More with the reasons", () => {
  show(viewOf(cardOf("Needs you")));
  const folds = host.querySelectorAll("[data-task-status] details");
  expect(folds).toHaveLength(1);
  expect(folds[0]!.textContent).toContain("More");
  expect(folds[0]!.textContent).toContain("Checks: exit 1");
  expect(folds[0]!.textContent).toContain("The check log was shortened when stored.");
  expect(host.textContent).not.toContain("Saved output is partial");
});

test("a fold inside a thread entry's More opens with it: one tap shows it all", () => {
  const entry: BrowserTaskThreadItem = { key: "result", at: "2026-10-20T15:20:00.000Z", kind: "result", who: "agent", author: "builder", title: "Result ready", text: null,
    link: null, html: "", more: { summary: "More", html: '<details data-inner><summary>Previous assessment</summary><p>Confirmed 1 of 1.</p></details>' } };
  show(viewOf(cardOf("Building"), { thread: [entry] }));
  const outer = host.querySelector<HTMLDetailsElement>("[data-thread-entry] details:not([data-inner])")!;
  const inner = host.querySelector<HTMLDetailsElement>("[data-inner]")!;
  expect(inner.open).toBe(false);
  act(() => { outer.open = true; outer.dispatchEvent(new Event("toggle")); });
  expect(inner.open).toBe(true);
});

/** The view as the server sends it while the plan waits on this person: its road and step rows. */
const waiting = (approve: Approve): BrowserTaskView => {
  const view = viewOf(cardOf("Needs you", null), { approve, journey: taskRoad({ stage: "needs-you", need: "approval" }, false, false, {}) });
  return { ...view, steps: stepRowsOf(view) };
};

test("in the step rows the approval is the open Approval row: one outline, one chip, the act, then the plan it signs, nothing folded", () => {
  show(waiting({ ...approveOf({ passwordless: true, remembered: false }), planHtml: '<article data-plan-sheet><p id="plan-words">Goal</p></article><details id="plan-editor"><summary>Request changes</summary></details>' }));
  const row = host.querySelector<HTMLElement>('[data-step-row="approve"]')!;
  expect(row.classList.contains("needs")).toBe(true);
  expect(row.getAttribute("aria-current")).toBe("step");
  // Never a toggle while it waits: its head is no button, its body is open.
  expect(row.querySelector("button.k-steprow-head")).toBeNull();
  const body = row.querySelector<HTMLElement>(".k-steprow-body")!;
  expect(body.hidden).toBe(false);
  // The act first, then the sheet, both in the row's body; the plan row above is one line pointing below.
  expect(body.querySelector("[data-task-approval]")).not.toBeNull();
  const sheet = body.querySelector("[data-plan-sheet]")!;
  expect(sheet.closest("details, [hidden]")).toBeNull();
  expect(body.querySelector("[data-task-approval]")!.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(host.querySelector('[data-step-row="plan"]')!.textContent).toContain("Shown below");
  // The chip is said once, by the row.
  expect([...host.querySelectorAll(".k-chip.needs")].map(one => one.closest("[data-step-row]")?.getAttribute("data-step-row"))).toEqual(["approve"]);
  expect(host.querySelectorAll("[data-task-approval]")).toHaveLength(1);
});

test("in the step rows a newer approval disables the yes and the sheet stays the one first shown", () => {
  show(waiting({ ...approveOf({ passwordless: true, remembered: false }, "d1"), planHtml: '<p id="plan-words">First terms</p>' }));
  show(waiting({ ...approveOf({ passwordless: true, remembered: false }, "d2"), planHtml: '<p id="plan-words">Newer terms</p>' }));
  const body = host.querySelector<HTMLElement>('[data-step-row="approve"] .k-steprow-body')!;
  expect(body.querySelector("#plan-words")!.textContent).toBe("First terms");
  expect(body.querySelector<HTMLInputElement>('input[name="digest"]')!.value).toBe("d1");
  expect([...body.querySelectorAll("[data-task-approval] button")].map(one => one.textContent)).toEqual(["Reload"]);
});

test("in the step rows a refused password keeps the terms shown and sends nothing until asked again", () => {
  show(waiting({ ...approveOf({ passwordless: false, remembered: false }, "d1"), planHtml: '<p id="plan-words">First terms</p>' }));
  pressApprove();
  // The person closes the popover (a wrong password is refused by the server, which answers the same page): the
  // act is released, nothing went, and the terms on the page are the ones shown.
  act(() => document.querySelector<HTMLButtonElement>('.k-pop [aria-label="Close"], .k-pop button[data-k-close]')?.click());
  expect(submitted).toEqual([]);
  show(waiting({ ...approveOf({ passwordless: false, remembered: false }, "d1"), planHtml: '<p id="plan-words">Re-rendered terms</p>' }));
  expect(host.querySelector("#plan-words")!.textContent).toBe("First terms");
  pressApprove();
  expect(popover()).not.toBeNull();
});

test("approved in another window: the Plan row takes the approved plan sheet in a live update; the same body is never swapped", () => {
  const editor = '<details id="plan-editor"><summary>Edit plan</summary></details>';
  const base = waiting(approveOf({ passwordless: true, remembered: false }));
  const before: BrowserTaskView = { ...base, plan: { lead: "Add subtract.", by: null, at: null, planning: false, key: "editor", html: editor } };
  show(before);
  const plan = () => host.querySelector<HTMLElement>('[data-step-row="plan"]')!;
  expect(plan().querySelector("[data-plan-sheet]")).toBeNull();
  // A refresh while it still waits changes nothing in the installed body (a person may be typing in the editor).
  show({ ...before, plan: { ...before.plan!, html: `<p id="swapped">x</p>${editor}` } });
  expect(plan().querySelector("#swapped")).toBeNull();
  // Somebody approves elsewhere: the live update carries the approved view, and the Plan row now holds the sheet.
  const approved = viewOf(cardOf("Building", null), { journey: taskRoad({ stage: "building" }, true, false, {}),
    approved: { by: "sam", at: "2026-11-10T09:00:00.000Z", automatic: false, rule: null, how: "", version: "v" },
    plan: { lead: "Add subtract.", by: null, at: null, planning: false, key: "sheet:d1", html: `<article data-plan-sheet><p id="plan-words">Goal</p></article>${editor}` } });
  show({ ...approved, steps: stepRowsOf(approved) });
  expect(host.querySelector("[data-task-approval]")).toBeNull();
  expect(plan().querySelector("[data-plan-sheet] #plan-words")!.textContent).toBe("Goal");
  expect(plan().querySelectorAll("#plan-editor")).toHaveLength(1);
});

test("the task's attempts stay in the Build row: while a correction is planned (the row opens before the build starts) and while it builds", () => {
  const attempts = [{ taskId: "t-0", label: "Original · Complete", href: "/t/t-1?version=t-0", runId: 4, detail: null }, { taskId: "t-1", label: "Correction 1 · Planning", href: "/t/t-1", runId: null, detail: null }];
  const build = () => host.querySelector<HTMLElement>('[data-step-row="build"]')!;
  // A correction being planned: Build hasn't started, and still opens for the earlier attempt.
  const planning = viewOf({ ...cardOf("Building", null), attempts }, { tab: "attempts", journey: taskRoad({ stage: "planning" }, false, false, {}) });
  show({ ...planning, steps: stepRowsOf(planning) });
  expect(build().querySelector("button.k-steprow-head")!.getAttribute("aria-expanded")).toBe("true");
  expect(build().textContent).toContain("Earlier attempts are here.");
  expect(build().querySelector<HTMLElement>(".k-steprow-body")!.hidden).toBe(false);
  expect(build().querySelectorAll("[data-attempt-timeline] a")).toHaveLength(2);
  // With one attempt and nothing stopped before it, a step not reached has nothing to open.
  const first = viewOf(cardOf("Building", null), { tab: "attempts", journey: taskRoad({ stage: "planning" }, false, false, {}) });
  show({ ...first, steps: stepRowsOf(first) }, "first");
  expect(build().querySelector("button")).toBeNull();
  // The correction building: its history is under the live build.
  const building = viewOf({ ...cardOf("Building", null), attempts }, { journey: taskRoad({ stage: "building" }, true, false, {}) });
  show({ ...building, steps: stepRowsOf(building) }, "building");
  expect(build().getAttribute("aria-current")).toBe("step");
  expect(build().querySelectorAll("[data-attempt-timeline] a")).toHaveLength(2);
  // Builds that stopped before this one count as history too.
  const stopped = viewOf(cardOf("Building", null), { journey: taskRoad({ stage: "building" }, true, false, {}), earlier: { summary: "1 earlier build", attempts: [{ label: "Build #3", href: "/r/3", text: null }] } });
  show({ ...stopped, steps: stepRowsOf(stopped) }, "stopped");
  expect(build().querySelector("[data-earlier-attempts]")!.getAttribute("data-earlier-attempts")).toBe("1");
});
