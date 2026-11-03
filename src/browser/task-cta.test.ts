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

test("Confirm it stopped is a step-up: a password popover, or one click with Passwordless on", () => {
  const view = viewOf(cardOf("Needs you", { label: "Confirm it stopped", href: "#confirm-stopped" }), { confirmStopped: { action: "/t/t-1/confirm-stopped", run: 12 } });
  show(view);
  act(() => host.querySelector<HTMLButtonElement>("#confirm-stopped button")!.click());
  expect(popover()?.querySelector('input[type="password"]')).not.toBeNull();
  expect(submitted).toEqual([]);
  act(() => root!.render(createElement(Passwordless.Provider, { value: true }, createElement(TaskView, { key: "pwless", view, details: false, csrf: "csrf" }))));
  act(() => host.querySelector<HTMLButtonElement>("#confirm-stopped button")!.click());
  expect(submitted).toEqual([{ action: "/t/t-1/confirm-stopped", token: "" }]);
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
