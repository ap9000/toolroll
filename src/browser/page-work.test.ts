// @vitest-environment happy-dom
/**
 * The page's work, run by the app (docs/plans/task-page-in-app.md §3): which work the app knows, and the one controller
 * a page has. A re-read of the same page starts what is new and never restarts what runs; a page that is replaced leaves
 * nothing running; a held page, a password page and a document that ran a page script string run none.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PageWork } from "../page-work-contract.js";
import { knownWork, PageWorkController, usePageWork, workKey, type WorkStarter } from "./page-work.js";

const answer: PageWork = { kind: "answer" };
const result: PageWork = { kind: "result" };
const check = (run: number): PageWork => ({ kind: "region", region: "check-progress", run });
const peek = (run: number): PageWork => ({ kind: "region", region: "run-peek", run });

/** A starter that records what started and what was stopped. */
function recorder() {
  const started: string[] = [], stopped: string[] = [];
  const starter: WorkStarter = (entry, signal) => {
    const key = workKey(entry);
    started.push(key);
    signal.addEventListener("abort", () => { stopped.push(key); });
  };
  return { started, stopped, starter };
}

test("the app knows a closed list of work, and all of a page's work or none", () => {
  expect(knownWork(undefined)).toBe(true);
  expect(knownWork([])).toBe(true);
  expect(knownWork([answer, check(7), peek(7)])).toBe(true);
  expect(knownWork([answer, result, check(7)])).toBe(true);
  expect(knownWork([answer, { kind: "chat" }])).toBe(false);
  expect(knownWork([{ kind: "results" }])).toBe(false);
  expect(knownWork([{ kind: "region", region: "board-region", run: 7 }])).toBe(false);
  expect(knownWork([{ kind: "region", region: "run-peek", run: "7" }])).toBe(false);
  expect(knownWork([{ kind: "region", region: "run-peek", run: 0 }])).toBe(false);
  expect(knownWork([{ kind: "region", region: "run-peek", run: 1.5 }])).toBe(false);
  expect(knownWork([{ kind: "script", script: "alert(1)" }])).toBe(false);
  expect(knownWork([null])).toBe(false);
  expect(knownWork("answer")).toBe(false);
  expect(knownWork({ kind: "answer" })).toBe(false);
});

test("a re-read starts what is new and never restarts what runs", () => {
  const { started, stopped, starter } = recorder();
  const page = new PageWorkController(starter);
  page.reconcile([]);
  expect(started).toEqual([]);
  // A question opened while the page was shown.
  page.reconcile([answer]);
  page.reconcile([answer]);
  // A build started.
  page.reconcile([check(7), peek(7), answer]);
  page.reconcile([check(7), peek(7), answer]);
  expect(started).toEqual(["answer", "region:check-progress:7", "region:run-peek:7"]);
  expect(stopped).toEqual([]);
});

test("a region whose build left stops, the next build's starts, and the answer stays until the page is replaced", () => {
  const { started, stopped, starter } = recorder();
  const page = new PageWorkController(starter);
  page.reconcile([check(7), peek(7), answer]);
  page.reconcile([check(8), peek(8)]);
  expect(stopped).toEqual(["region:check-progress:7", "region:run-peek:7"]);
  expect(started.slice(3)).toEqual(["region:check-progress:8", "region:run-peek:8"]);
  page.reconcile([]);
  expect(stopped).toEqual(["region:check-progress:7", "region:run-peek:7", "region:check-progress:8", "region:run-peek:8"]);
  // The question was answered, so the page no longer asks for it: the listener stays, and is not started twice.
  page.reconcile([answer]);
  expect(started.filter(key => key === "answer")).toEqual(["answer"]);
  page.stop();
  expect(stopped.at(-1)).toBe("answer");
});

test("reviewing a result is bound once to the page: a re-read never restarts it, and it ends when the page is replaced", () => {
  const { started, stopped, starter } = recorder();
  const page = new PageWorkController(starter);
  expect(workKey(result)).toBe("result");
  // The build finished while the page was shown: its regions leave, the result's review starts.
  page.reconcile([check(7), peek(7)]);
  page.reconcile([result]);
  page.reconcile([result, answer]);
  page.reconcile([result]);
  // A re-read that no longer names it (a newer build began): the draft under the person's hands is not unbound.
  page.reconcile([check(8)]);
  page.reconcile([result]);
  expect(started.filter(key => key === "result")).toEqual(["result"]);
  expect(stopped).not.toContain("result");
  page.stop();
  expect(stopped).toContain("result");
});

test("a page that was replaced leaves nothing running and starts nothing more", () => {
  const { started, stopped, starter } = recorder();
  const page = new PageWorkController(starter);
  page.reconcile([check(7), answer]);
  page.stop();
  expect(stopped.sort()).toEqual(["answer", "region:check-progress:7"]);
  page.reconcile([peek(7), answer]);
  expect(started).toEqual(["region:check-progress:7", "answer"]);
});

test("a behaviour that cannot start does not stop the others", () => {
  const started: string[] = [];
  const page = new PageWorkController((entry) => { if (entry.kind === "answer") throw new Error("no"); started.push(workKey(entry)); });
  page.reconcile([answer, check(7)]);
  expect(started).toEqual(["region:check-progress:7"]);
});

let root: Root | null = null, host: HTMLElement | null = null;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; host?.remove(); host = null; vi.unstubAllGlobals(); });

function Page(props: { epoch: number; work: unknown; may: () => boolean; starter: WorkStarter }) {
  usePageWork(props.epoch, props.work, props.may, props.starter);
  return null;
}
async function show(props: { epoch: number; work: unknown; may?: () => boolean; starter: WorkStarter }): Promise<void> {
  if (root === null) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
  await act(async () => { root!.render(createElement(Page, { may: () => true, ...props })); });
}

test("the page's work starts with the page, follows its re-reads, and ends when the page changes", async () => {
  const { started, stopped, starter } = recorder();
  await show({ epoch: 1, work: undefined, starter });
  expect(started).toEqual([]);
  // The same page, read again with a question open: its work starts without a new page.
  await show({ epoch: 1, work: [answer], starter });
  await show({ epoch: 1, work: [{ kind: "answer" }], starter });
  expect(started).toEqual(["answer"]);
  await show({ epoch: 1, work: [answer, check(7)], starter });
  expect(started).toEqual(["answer", "region:check-progress:7"]);
  expect(stopped).toEqual([]);
  // Another page: everything the last one started ends, and this page's own starts.
  await show({ epoch: 2, work: [answer], starter });
  expect(stopped.sort()).toEqual(["answer", "region:check-progress:7"]);
  expect(started).toEqual(["answer", "region:check-progress:7", "answer"]);
  await act(async () => root?.unmount());
  root = null;
  expect(stopped.length).toBe(3);
});

test("a page that may not run work runs none: held, a password page, a document that ran a page script", async () => {
  const { started, stopped, starter } = recorder();
  let may = false;
  await show({ epoch: 1, work: [answer, peek(7)], may: () => may, starter });
  await show({ epoch: 1, work: [answer, peek(7), check(7)], may: () => may, starter });
  expect(started).toEqual([]);
  // Its confirmation is a new page (a new epoch): the work starts then.
  may = true;
  await show({ epoch: 2, work: [answer, peek(7)], may: () => may, starter });
  expect(started).toEqual(["answer", "region:run-peek:7"]);
  // The page turned into a password page on its own re-read: everything it ran ends.
  may = false;
  await show({ epoch: 2, work: undefined, may: () => may, starter });
  expect(stopped.sort()).toEqual(["answer", "region:run-peek:7"]);
});

test("work the app does not know starts nothing, and what runs keeps running", async () => {
  const { started, stopped, starter } = recorder();
  await show({ epoch: 1, work: [answer], starter });
  await show({ epoch: 1, work: [answer, { kind: "a-later-kind" }], starter });
  await show({ epoch: 1, work: [{ kind: "script", script: "alert(1)" }], starter });
  expect(started).toEqual(["answer"]);
  expect(stopped).toEqual([]);
});
