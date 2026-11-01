import { describe, expect, it } from "vitest";
import { ACCEPT_NEEDS_REASON, resultActsOf, type ResultActFacts } from "./result-acts.js";
import { cantAcceptYetOf } from "./workspace-ui.js";

const base: ResultActFacts = { accept: null, runChecks: false, checksRunning: false, blocked: null, canRequest: true, need: null, next: null };
// A mismatch is the status card's headline; the line before the acts only says what accepting takes.
const MISMATCH = ACCEPT_NEEDS_REASON;

describe("the result page's one ink act", () => {
  it("a failed build: Retry, then Run checks when they didn't run; never Accept or Request changes", () => {
    const failed = { ...base, accept: { ready: true }, failed: { retry: true } };
    expect(resultActsOf(failed)).toEqual({ primary: "retry", secondary: null, line: null });
    expect(resultActsOf({ ...failed, runChecks: true })).toEqual({ primary: "retry", secondary: "run-checks", line: null });
    expect(resultActsOf({ ...failed, checksRunning: true })).toEqual({ primary: "retry", secondary: "checks-running", line: null });
    // Nothing to retry from here (already retried, or a viewer): Run checks alone, or nothing.
    expect(resultActsOf({ ...failed, failed: { retry: false }, runChecks: true })).toEqual({ primary: "run-checks", secondary: null, line: null });
    expect(resultActsOf({ ...failed, failed: { retry: false } })).toEqual({ primary: null, secondary: null, line: null });
    // A failed task's delivered result: Accept anyway, only ever in outline, takes the outline place from Run checks.
    expect(resultActsOf({ ...failed, failed: { retry: true, acceptAnyway: true }, runChecks: true })).toEqual({ primary: "retry", secondary: "accept-anyway", line: null });
    expect(resultActsOf({ ...failed, failed: { retry: false, acceptAnyway: true } })).toEqual({ primary: null, secondary: "accept-anyway", line: null });
  });

  it("a result that can't be accepted never gets Accept as ink, even without the feedback form", () => {
    expect(resultActsOf({ ...base, accept: { ready: false }, blocked: MISMATCH, canRequest: false })).toEqual({ primary: null, secondary: "accept", line: MISMATCH });
  });

  it("every state has at most one ink act and it is never navigation", () => {
    const acts = new Set(["accept", "next-check", "checks-running", "run-checks", "request-changes", "rebuild", "confirm-stopped", "revise", "draft-repair"]);
    for (const accept of [null, { ready: true }, { ready: false }]) for (const runChecks of [false, true]) for (const checksRunning of [false, true]) for (const blocked of [null, MISMATCH])
      for (const canRequest of [false, true]) for (const need of [null, "rebuild", "confirm-stopped"] as const) for (const next of [null, "revise"] as const) {
        const chosen = resultActsOf({ accept, runChecks, checksRunning, blocked, canRequest, need, next });
        if (chosen.primary !== null) expect(acts.has(chosen.primary)).toBe(true);
        expect(chosen.secondary === null || chosen.secondary !== chosen.primary).toBe(true);
        // A result that can't be accepted is never offered Accept as its ink act while Request changes is possible.
        if (blocked !== null && need === null && next === null && canRequest) expect(chosen).toMatchObject({ primary: "request-changes", line: MISMATCH });
        // ...and never Accept as its ink act, form or not; nor while checks run.
        if (blocked !== null || (checksRunning && need === null && next === null)) expect(chosen.primary).not.toBe("accept");
      }
  });

  it("says why a refuted result can't be accepted yet, once, until a person accepts it", () => {
    expect(cantAcceptYetOf("refuted", ['claimed changed path "src/ledger.ts" is not in the sealed diff'], false)).toBe(MISMATCH);
    expect(cantAcceptYetOf("refuted", ["the repository's approved verification command exited 1"], false)).toBe("Can't accept yet: the project's check failed on these changes.");
    expect(cantAcceptYetOf("refuted", [], true)).toBeNull();
    expect(cantAcceptYetOf("verified", [], false)).toBeNull();
    expect(cantAcceptYetOf("short", [], false)).toBeNull();
  });
});
