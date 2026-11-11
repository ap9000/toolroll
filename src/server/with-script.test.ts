/**
 * Adding one script to a page's script (docs/plans/task-page-in-app.md §1). The app runs all of a page's behaviour or
 * none of it: `app` survives only when every part names it.
 */
import { expect, test } from "vitest";
import { withScript } from "./chrome.js";

test("a page with no script takes the added one whole", () => {
  expect(withScript(undefined, { script: "a();" })).toEqual({ script: "a();", fetches: false });
  expect(withScript(undefined, { script: "a();", fetches: true, app: [{ kind: "answer" }] })).toEqual({ script: "a();", fetches: true, app: [{ kind: "answer" }] });
});

test("both parts covered: the work is both parts' work, in order", () => {
  const both = withScript({ script: "a();", app: [{ kind: "region", region: "run-peek", run: 7 }] }, { script: "b();", app: [{ kind: "answer" }] });
  expect(both).toEqual({ script: "a();b();", fetches: false, app: [{ kind: "region", region: "run-peek", run: 7 }, { kind: "answer" }] });
});

test("one part the app does not cover leaves the whole page a script", () => {
  // A covered page gains an uncovered script (a task with a result, until the app has the result's behaviour).
  expect(withScript({ script: "a();", app: [{ kind: "answer" }] }, { script: "b();" })).toEqual({ script: "a();b();", fetches: false });
  // An uncovered page gains a covered one: the string still carries both, so the app must run neither.
  expect(withScript({ script: "a();", fetches: true }, { script: "b();", app: [{ kind: "answer" }] })).toEqual({ script: "a();b();", fetches: true });
  // A covered part with no entries is still covered; an uncovered one beside it is not.
  expect(withScript({ script: "a();", app: [] }, { script: "b();", app: [] }).app).toEqual([]);
  expect(withScript({ script: "", app: [] }, { script: "b();" }).app).toBeUndefined();
});
