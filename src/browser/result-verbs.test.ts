// @vitest-environment happy-dom
/** Three verbs, as relabels (docs/plans/plain-toolroll.md P1.3): route for route, each verb on a result's act row
 * posts to the handler, with the fields, its act always used. Only the words changed. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserResultView } from "../browser-workspace.js";
import { SelectedResult } from "./views/result-view.js";
import { ResultStatusAct } from "./views/task-view.js";

type Selected = NonNullable<BrowserResultView["selected"]>;
const base = (extra: Partial<Selected>): Selected => ({
  taskId: "t-1", title: "Fix the footer", project: null, build: 7, taskHref: "/t/t-1", chatHref: "/chat?task=t-1",
  status: { label: "Ready for review", tone: "success", token: "ready-to-review" }, problem: null, next: null, complete: null, decision: null, checks: null,
  mismatch: null, acts: { primary: null, secondary: null, line: null }, runChecks: null, intent: null, noRun: null, panel: null, notes: [], record: null, failure: null, ...extra,
} as Selected);

let root: Root | null = null, host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (selected: Selected) => act(() => root!.render(createElement(SelectedResult, { selected, csrf: "c" })));
/** The act row's controls: each one's words, and the form it posts (action and named fields) or the place it opens. */
const row = () => [...host.querySelectorAll<HTMLElement>("[data-result-acts] [data-act]")].map(control => {
  const form = control.closest("form");
  return { verb: control.textContent?.trim() ?? "", kind: control.dataset["act"], ink: control.hasAttribute("data-ink-act"),
    action: form?.getAttribute("action") ?? control.getAttribute("href"), fields: form === null ? [] : [...form.querySelectorAll<HTMLInputElement>("input[name]")].map(one => one.name).sort() };
});

describe("each verb is today's post, relabelled", () => {
  test("Accept: the exact-receipt completion, with the same fields", () => {
    render(base({ complete: { action: "/t/t-1/complete", receipt: "r".repeat(64), run: 7, returnTo: "/t/t-1" },
      decision: { label: "Accept", ready: true, why: null, effect: "Finishes the task." } as Selected["decision"],
      acts: { primary: "accept", secondary: null, line: null } }));
    expect(row()).toEqual([{ verb: "Accept", kind: "accept", ink: true, action: "/t/t-1/complete", fields: ["csrf", "receipt", "return", "run"] }]);
  });

  test("Send back: the request for changes (an unpublished result) opens its own form, never a new one", () => {
    render(base({ acts: { primary: "request-changes", secondary: null, line: null } }));
    expect(row()).toEqual([{ verb: "Send back", kind: "request-changes", ink: true, action: "#request-changes", fields: [] }]);
  });

  test("Send back: saved notes become the revision, through the same /revise post", () => {
    render(base({ next: { kind: "revise", title: "2 notes ready", detail: "Sends it back with your notes.", control: '<form method="post" action="/r/7/revise"><input type="hidden" name="batch" value="b"><input type="hidden" name="source" value="s"><button type="submit">Send back</button></form>' },
      acts: { primary: "revise", secondary: null, line: null } }));
    const form = host.querySelector<HTMLFormElement>('[data-result-acts] form[action="/r/7/revise"]');
    expect(form?.querySelector("button")?.textContent).toBe("Send back");
    expect([...form!.querySelectorAll<HTMLInputElement>("input[name]")].map(one => one.name).sort()).toEqual(["batch", "source"]);
  });

  test("Retry: a failed build's Retry posts the same requeue with its note", () => {
    render(base({ status: { label: "Failed", tone: "danger", token: "failed" },
      failure: { line: "The agent failed.", evidence: null, suggestion: "Say what to do differently this time.", link: null, retry: { action: "/t/t-1/requeue", note: "Say what to do differently this time." } },
      acts: { primary: "retry", secondary: null, line: null } }));
    const form = host.querySelector<HTMLFormElement>('[data-result-acts] form[action="/t/t-1/requeue"]');
    expect(form).not.toBeNull();
    expect(form!.textContent).toContain("Retry");
    expect([...form!.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[name]")].map(one => one.getAttribute("name")).sort()).toContain("note");
  });
});

describe("on a task page, the Ready status box holds the one act (pages audit #1)", () => {
  /** The result as a task page's Ready row renders it, with the status box's act slot. */
  const inTask = (selected: Selected): HTMLElement => {
    const slot = document.createElement("div"); document.body.append(slot); slots.push(slot);
    act(() => root!.render(createElement(ResultStatusAct.Provider, { value: slot }, createElement(SelectedResult, { selected, csrf: "c", inTask: { current: true } }))));
    return slot;
  };
  const slots: HTMLElement[] = [];
  afterEach(() => { for (const one of slots.splice(0)) one.remove(); });
  /** Every ink act on the page: the decision's and the status box's. */
  const inks = () => [...document.querySelectorAll<HTMLElement>(".k-btn-primary")].map(one => one.textContent?.trim());
  const ready = { complete: { action: "/t/t-1/complete", receipt: "r".repeat(64), run: 7, returnTo: "/t/t-1" },
    decision: { label: "Accept", ready: true, why: null, effect: "Finishes the task." } as Selected["decision"] };

  test("nothing owed: Mark complete is the result's own exact-receipt completion, moved up, and not offered twice", () => {
    const slot = inTask(base({ ...ready, acts: { primary: "accept", secondary: null, line: null } }));
    const form = slot.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/t/t-1/complete");
    expect([...form!.querySelectorAll<HTMLInputElement>("input[name]")].map(one => one.name === "csrf" ? ["csrf"] : [one.name, one.value]).sort()).toEqual([["csrf"], ["receipt", "r".repeat(64)], ["return", "/t/t-1"], ["run", "7"]]);
    expect(slot.querySelector("[data-ink-act=accept]")?.textContent).toBe("Mark complete");
    expect(row()).toEqual([]);
    expect(inks()).toEqual(["Mark complete"]);
  });

  test("an acceptance owed (your check, a reason): nothing moves up, Accept stays the decision's ink act", () => {
    const owed = { ...ready.complete, accept: { note: null } } as Selected["complete"];
    const slot = inTask(base({ ...ready, complete: owed, acts: { primary: "accept", secondary: null, line: null } }));
    expect(slot.childElementCount).toBe(0);
    expect(row()).toMatchObject([{ verb: "Accept", ink: true, action: "/t/t-1/complete" }]);
  });

  test("checks didn't pass: Review and accept takes the person to the decision and posts nothing; Accept waits in outline", () => {
    const slot = inTask(base({ ...ready, decision: { label: "Accept without checks", ready: false, why: null, effect: "Finishes the task." } as Selected["decision"],
      acts: { primary: null, secondary: "accept", line: null } }));
    const jump = slot.querySelector<HTMLAnchorElement>("[data-review-and-accept]");
    expect(jump?.textContent).toBe("Review and accept");
    expect(jump?.getAttribute("href")).toBe("#result-decision");
    expect(slot.querySelector("form")).toBeNull();
    expect(row()).toMatchObject([{ verb: "Accept without checks", ink: false }]);
    expect(inks()).toEqual(["Review and accept"]);
  });

  test("off a task page (the result alone): no slot, the acts stay in the decision", () => {
    render(base({ ...ready, acts: { primary: "accept", secondary: null, line: null } }));
    expect(row()).toMatchObject([{ verb: "Accept", ink: true }]);
  });
});
