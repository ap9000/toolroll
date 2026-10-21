// @vitest-environment happy-dom
/** The task page's one action, never out of reach (views/task-view.tsx): while something waits on the person and its
 * button has scrolled away, a bar pinned to the foot of the page names it, and a tap brings it back with the cursor
 * where it starts; it never acts by itself. And the page never stacks folds: one More on the status card, and a fold
 * inside a fold opens with it. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AssignmentCard } from "../assignment-ui.js";
import type { BrowserTaskThreadItem, BrowserTaskView } from "../browser-workspace.js";
import { TaskView } from "./views/task-view.js";

const cardOf = (headline: "Needs you" | "Building", action: AssignmentCard["action"] = { label: "Open result", href: "/review?result=t-1" }): AssignmentCard => ({
  token: "assignment", tone: headline === "Needs you" ? "attention" : "info", label: headline,
  status: { headline, tone: headline === "Needs you" ? "attention" : "live", sentence: "The plan changed after build #12.", details: [], primaryAction: null, why: ["Checks: exit 1"] },
  action, reasons: [], diagnostics: [], notices: { summary: "Saved output is partial", lines: ["The check log was shortened when stored."] }, attempts: [], lead: null,
});
const viewOf = (card: AssignmentCard, extra: Partial<BrowserTaskView> = {}): BrowserTaskView => ({
  kind: "task", id: "t-1", title: "Release check", project: null, scout: false, tabs: [], version: null,
  status: card, statusHtml: "", approval: "", lead: [], questions: "", facts: [], sections: [], manage: [], cancel: null, thread: [], ...extra,
});
const approvalOf = (nonce: string, digest = "d1") => '<section class="task-plan-review"><form method="post" action="/t/t-1/approve">'
  + `<input type="hidden" name="nonce" value="${nonce}"><input type="hidden" name="digest" value="${digest}"><input type="text" name="username" tabindex="-1">`
  + '<input type="password" name="token"><button type="submit" data-primary-action>Approve &amp; build again</button></form></section>';
const APPROVAL = approvalOf("n1");

let root: Root | null = null, host: HTMLElement;
let observed: { callback: IntersectionObserverCallback; target: Element | null }[] = [];
const seen = (visible: boolean) => act(() => { for (const one of observed) one.callback([{ isIntersecting: visible, target: one.target } as IntersectionObserverEntry], {} as IntersectionObserver); });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observed = [];
  vi.stubGlobal("IntersectionObserver", class {
    private entry: { callback: IntersectionObserverCallback; target: Element | null };
    constructor(callback: IntersectionObserverCallback) { this.entry = { callback, target: null }; observed.push(this.entry); }
    observe(target: Element) { this.entry.target = target; }
    disconnect() { observed = observed.filter(one => one !== this.entry); }
  });
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root !== null) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; vi.unstubAllGlobals(); });
/** `key`: a new server render of the page (its native regions install once; a new render mounts them afresh). */
const show = (view: BrowserTaskView, key = "page") => act(() => root!.render(createElement(TaskView, { key, view, details: false, csrf: "csrf" })));
const bar = () => host.querySelector<HTMLElement>("[data-pinned-action]");

test("while the action is on screen there is no bar; scrolled away, the bar names it and brings it back", () => {
  show(viewOf(cardOf("Needs you")));
  expect(bar()).toBeNull();
  seen(true);
  expect(bar()).toBeNull();
  seen(false);
  expect(bar()?.textContent).toContain("Needs you");
  const button = bar()!.querySelector("button")!;
  expect(button.textContent).toContain("Open result");
  act(() => button.click());
  // It brings the action back into view; it never follows the link itself.
  const action = host.querySelector<HTMLAnchorElement>("[data-task-status] [data-primary-action]")!;
  expect(action.scrollIntoView).toHaveBeenCalled();
  expect(document.activeElement).toBe(action);
  seen(true);
  expect(bar()).toBeNull();
});

test("when the approval is the action, the bar names its yes and puts the cursor in its password", () => {
  show(viewOf(cardOf("Needs you", null), { approval: APPROVAL }));
  seen(false);
  expect(bar()!.querySelector("button")!.textContent).toContain("Approve & build again");
  act(() => bar()!.querySelector("button")!.click());
  expect((document.activeElement as HTMLInputElement | null)?.name).toBe("token");
  // Focus only: nothing was submitted.
  expect(host.querySelector<HTMLInputElement>('input[name="token"]')!.value).toBe("");
});

test("Confirm it stopped is the one action too", () => {
  show(viewOf(cardOf("Needs you", { label: "Confirm it stopped", href: "#confirm-stopped" }), { confirmStopped: { action: "/t/t-1/confirm-stopped", run: 12 } }));
  seen(false);
  expect(bar()!.querySelector("button")!.textContent).toContain("Confirm it stopped");
  act(() => bar()!.querySelector("button")!.click());
  expect((document.activeElement as HTMLInputElement | null)?.name).toBe("token");
});

test("a button inside a closed fold is never the one action, and the bar follows a live update that swaps it", () => {
  const folded = '<details class="task-secondary-approval"><summary>Updated approval terms</summary>' + APPROVAL + "</details>";
  show(viewOf(cardOf("Needs you", null), { approval: folded }));
  seen(false);
  expect(bar()).toBeNull();
  // The same page, live-updated in place (no remount): the approval now leads, open.
  show(viewOf(cardOf("Needs you", null), { approval: APPROVAL }));
  seen(false);
  expect(bar()!.querySelector("button")!.textContent).toContain("Approve & build again");
  // Updated again: the approval is gone and the status card leads with Build again.
  show(viewOf(cardOf("Needs you", { label: "Build again", href: "/t/t-1" }), { approval: "" }));
  seen(false);
  expect(bar()!.querySelector("button")!.textContent).toContain("Build again");
  expect(observed).toHaveLength(1);
});

test("the status card's own action changing in place (no new render of the page) moves the bar with it", () => {
  show(viewOf(cardOf("Needs you", { label: "Open result", href: "/review" })));
  seen(false);
  expect(bar()!.querySelector("button")!.textContent).toContain("Open result");
  show(viewOf(cardOf("Needs you", { label: "Check the build", href: "/r/12" })));
  seen(false);
  expect(bar()!.querySelector("button")!.textContent).toContain("Check the build");
  expect(observed).toHaveLength(1);
});

test("a refresh that only re-mints the approval's nonce keeps the region (and a password being typed)", () => {
  show(viewOf(cardOf("Needs you", null), { approval: approvalOf("n1") }));
  const field = host.querySelector<HTMLInputElement>('input[name="token"]')!;
  field.value = "typed";
  show(viewOf(cardOf("Needs you", null), { approval: approvalOf("n2") }));
  expect(host.querySelector<HTMLInputElement>('input[name="token"]')).toBe(field);
  expect(field.value).toBe("typed");
  // A different plan to sign is a new region.
  show(viewOf(cardOf("Needs you", null), { approval: approvalOf("n3", "d2") }));
  expect(host.querySelector<HTMLInputElement>('input[name="digest"]')!.value).toBe("d2");
});

test("plan words that name the fold's class never pass for the fold", async () => {
  const { approvalIdentity } = await import("./views/task-view.js");
  const words = '<p class="approval-goal">Fix task-secondary-approval so &quot;task-secondary-approval&quot; opens</p>';
  const open = approvalOf("n1").replace("</form>", `${words}</form>`);
  const folded = `<details class="task-secondary-approval"><summary>Updated approval terms</summary>${open}</details>`;
  expect(approvalIdentity(open)).toBe("open:d1");
  expect(approvalIdentity(folded)).toBe("folded:d1");
  show(viewOf(cardOf("Needs you", null), { approval: folded }));
  show(viewOf(cardOf("Needs you", null), { approval: open }));
  expect(host.querySelector("details.task-secondary-approval")).toBeNull();
  seen(false);
  expect(bar()!.querySelector("button")!.textContent).toContain("Approve & build again");
});

test("nothing waits on the person: no bar, however far the page scrolls", () => {
  show(viewOf(cardOf("Building")));
  seen(false);
  expect(bar()).toBeNull();
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
