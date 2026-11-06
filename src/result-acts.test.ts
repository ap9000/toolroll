import { describe, expect, it } from "vitest";
import { ACCEPT_NEEDS_REASON, RESULT_VERB, resultActsOf, type ResultActFacts } from "./result-acts.js";
import { cantAcceptYetOf } from "./workspace-ui.js";

const base: ResultActFacts = { accept: null, runChecks: false, checksRunning: false, blocked: null, canRequest: true, need: null, next: null };
// A mismatch is the status card's headline; the line before the acts only says what accepting takes.
const MISMATCH = ACCEPT_NEEDS_REASON;

describe("the result page's one ink act", () => {
  it("a failed build: Retry, then Accept anyway where it may be accepted; never Accept or Send back; Run checks stays in its row", () => {
    const failed = { ...base, accept: { ready: true }, failed: { retry: true } };
    expect(resultActsOf(failed)).toEqual({ primary: "retry", secondary: null, line: null });
    expect(resultActsOf({ ...failed, runChecks: true })).toEqual({ primary: "retry", secondary: null, line: null });
    expect(resultActsOf({ ...failed, checksRunning: true })).toEqual({ primary: "retry", secondary: null, line: null });
    // Nothing to retry from here (already retried, or a viewer): nothing in the act row.
    expect(resultActsOf({ ...failed, failed: { retry: false }, runChecks: true })).toEqual({ primary: null, secondary: null, line: null });
    // A failed task's delivered result: Accept anyway, only ever in outline.
    expect(resultActsOf({ ...failed, failed: { retry: true, acceptAnyway: true }, runChecks: true })).toEqual({ primary: "retry", secondary: "accept-anyway", line: null });
    expect(resultActsOf({ ...failed, failed: { retry: false, acceptAnyway: true } })).toEqual({ primary: null, secondary: "accept-anyway", line: null });
  });

  it("a result that can't be accepted never gets Accept as ink, even without the feedback form", () => {
    expect(resultActsOf({ ...base, accept: { ready: false }, blocked: MISMATCH, canRequest: false })).toEqual({ primary: null, secondary: "accept", line: MISMATCH });
  });

  it("the rule table: every state's act row is drawn from the three verbs, one ink act at most, never navigation", () => {
    const verbs = new Set(["Accept", "Send back", "Retry"]);
    for (const accept of [null, { ready: true }, { ready: false }]) for (const runChecks of [false, true]) for (const checksRunning of [false, true]) for (const blocked of [null, MISMATCH])
      for (const canRequest of [false, true]) for (const need of [null, "rebuild", "recheck-stopped"] as const) for (const next of [null, "revise", "draft-repair"] as const)
      for (const unanswered of [0, 1]) for (const notRight of [0, 1]) for (const failed of [null, { retry: true }, { retry: false, acceptAnyway: true }]) {
        const chosen = resultActsOf({ accept, runChecks, checksRunning, blocked, canRequest, need, next, unanswered, notRight, failed });
        for (const kind of [chosen.primary, chosen.secondary]) {
          if (kind === null || kind === "recheck-stopped") continue;
          expect(verbs.has(RESULT_VERB[kind] ?? ""), kind).toBe(true);
        }
        expect(chosen.secondary === null || chosen.secondary !== chosen.primary).toBe(true);
        // Never two of the same verb side by side.
        if (chosen.primary !== null && chosen.secondary !== null) expect(RESULT_VERB[chosen.primary], `${chosen.primary}/${chosen.secondary}`).not.toBe(RESULT_VERB[chosen.secondary]);
        if (failed !== null) continue;
        // A result that can't be accepted is never offered Accept as its ink act while Send back is possible.
        if (blocked !== null && need === null && next === null && canRequest) expect(chosen).toMatchObject({ primary: "request-changes", line: MISMATCH });
        // ...and never Accept as its ink act, form or not; nor while checks run.
        if (blocked !== null || (checksRunning && need === null && next === null)) expect(chosen.primary).not.toBe("accept");
      }
  });

  it("each verb is today's post: Accept, Send back and Retry over the acts they always made", () => {
    expect(RESULT_VERB).toEqual({ accept: "Accept", "accept-anyway": "Accept", "request-changes": "Send back", revise: "Send back", "draft-repair": "Send back",
      retry: "Retry", rebuild: "Retry", "confirm-stopped": null, "next-check": null, "checks-running": null, "run-checks": null });
  });

  it("says why a refuted result can't be accepted yet, once, until a person accepts it", () => {
    expect(cantAcceptYetOf("refuted", ['claimed changed path "src/ledger.ts" is not in the sealed diff'], false)).toBe(MISMATCH);
    expect(cantAcceptYetOf("refuted", ["the repository's approved verification command exited 1"], false)).toBe("Can't accept yet: the project's check failed on these changes.");
    expect(cantAcceptYetOf("refuted", [], true)).toBeNull();
    expect(cantAcceptYetOf("verified", [], false)).toBeNull();
    expect(cantAcceptYetOf("short", [], false)).toBeNull();
  });
});
