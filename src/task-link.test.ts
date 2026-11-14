/** The one address of a task and its result (one-workspace plan S1, task-link.ts): exact run, version, section, place and
 * feedback carried; anything malformed left out; old result addresses mapped to the same place. */
import { describe, expect, test } from "vitest";
import { taskLinkFromLegacy, taskLinkOf } from "./task-link.js";

describe("taskLinkOf", () => {
  test("a result is its task page's Result section at exactly the run named", () => {
    expect(taskLinkOf({ task: "t-1", run: 6 })).toBe("/t/t-1?tab=result&run=6");
    expect(taskLinkOf({ task: "t-1", run: 6, section: "changes" })).toBe("/t/t-1?tab=result&run=6&section=changes");
    expect(taskLinkOf({ task: "t-1", run: 6, section: "summary" })).toBe("/t/t-1?tab=result&run=6");
    expect(taskLinkOf({ task: "t-1", run: 6, section: "checks", anchor: "check-log-L12" })).toBe("/t/t-1?tab=result&run=6&section=checks#check-log-L12");
    expect(taskLinkOf({ task: "root", revision: "root-2", run: 9 })).toBe("/t/root?version=root-2&tab=result&run=9");
    expect(taskLinkOf({ task: "t-1", result: true })).toBe("/t/t-1?tab=result");
    expect(taskLinkOf({ task: "t-1", run: 6, feedback: { noted: true, refused: "reason" }, anchor: "request-changes" })).toBe("/t/t-1?tab=result&run=6&noted=1&refused=reason#request-changes");
  });

  test("a task, a place on it, its record", () => {
    expect(taskLinkOf({ task: "a/b c" })).toBe("/t/a%2Fb%20c");
    expect(taskLinkOf({ task: "t-1", anchor: "findings" })).toBe("/t/t-1#findings");
    expect(taskLinkOf({ task: "t-1", record: true })).toBe("/t/t-1?tab=record#record");
    expect(taskLinkOf({ task: "t-1", run: 6, record: true })).toBe("/r/6?record=1");
    expect(taskLinkOf({ task: "t-1", run: 6, record: true, anchor: "run-reason-detail" })).toBe("/r/6?record=1#run-reason-detail");
  });

  test("anything malformed is left out, never spelled", () => {
    for (const run of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) expect(taskLinkOf({ task: "t-1", run }), String(run)).toBe("/t/t-1");
    expect(taskLinkOf({ task: "t-1", run: 6, section: "evil" as never })).toBe("/t/t-1?tab=result&run=6");
    expect(taskLinkOf({ task: "t-1", anchor: "x\"><script>" })).toBe("/t/t-1");
    expect(taskLinkOf({ task: "t-1", run: 6, feedback: { refused: "Reason&x=1" } })).toBe("/t/t-1?tab=result&run=6");
  });
});

describe("taskLinkFromLegacy", () => {
  test("the retired result page and the chat's result detail land on the same place", () => {
    expect(taskLinkFromLegacy("/review?result=T&run=4&tab=changes")).toBe("/t/T?tab=result&run=4&section=changes");
    expect(taskLinkFromLegacy("/review?result=T")).toBe("/t/T?tab=result");
    expect(taskLinkFromLegacy("/review?result=T&run=4&tab=checks#follow-ups")).toBe("/t/T?tab=result&run=4&section=checks#follow-ups");
    expect(taskLinkFromLegacy("/review?result=T&noted=1")).toBe("/t/T?tab=result&noted=1");
    expect(taskLinkFromLegacy("/review?result=T&refused=reason")).toBe("/t/T?tab=result&refused=reason");
    expect(taskLinkFromLegacy("/chat?task=T&result=4&tab=checks")).toBe("/t/T?tab=result&run=4&section=checks");
  });

  test("anything else is not an old result address", () => {
    for (const href of ["/review", "/chat?task=T", "/chat?task=T&result=x", "https://evil.example/review?result=T", "//evil.example/review?result=T", "/t/T", "/tasks?view=ready"]) {
      expect(taskLinkFromLegacy(href), href).toBeNull();
    }
  });
});
