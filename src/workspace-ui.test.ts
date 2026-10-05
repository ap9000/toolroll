import { describe, expect, test } from "vitest";
import { acceptWordsOf, buildProgressOf, earlierAttemptsWords, lastErrorLineOf, missedRequirementOf, reportMismatchesOf } from "./workspace-ui.js";
import { failedAttemptSentence, failingCheckSuggestion, GENERAL_SUGGESTION, INTERNAL_ERROR, isInternalErrorReason, latestFinishedAttempt, missedRequirementLine, missedRequirementSuggestion, NO_REASON_RECORDED, RETRY_NOTE_LIMIT, retryNoteOf, RUN_REASON_WORDS, stopSuggestionOf } from "./needs-you.js";

describe("the result's Accept words", () => {
  test("Accept and finish only when every requirement is met and the checks passed; it says it finishes, and never that it publishes", () => {
    expect(acceptWordsOf({ checks: "passed", unmet: 0, action: "complete", publishing: "pull-request", proof: true }))
      .toEqual({ label: "Accept and finish", ready: true, why: null, effect: "Finishes the task. No pull request opens; you can open one from the task after." });
    expect(acceptWordsOf({ checks: "passed", unmet: 0, action: "complete", publishing: "other", proof: true }).effect).toBe("Finishes the task. Nothing is published.");
  });

  test("a missing or unreadable proof is Accept without checks, and says so", () => {
    expect(acceptWordsOf({ checks: "passed", unmet: 0, action: "complete", publishing: "off", proof: false }))
      .toMatchObject({ label: "Accept without checks", ready: false, why: "Nothing on record says what was met." });
    expect(acceptWordsOf({ checks: "not-run", unmet: 0, action: "complete", publishing: "off", proof: false }).why).toBe("Nothing on record says what was met and checks didn't run.");
  });

  test("Accept without checks names what is missing in one line", () => {
    expect(acceptWordsOf({ checks: "not-run", unmet: 0, action: "complete", publishing: "off", proof: true }))
      .toEqual({ label: "Accept without checks", ready: false, why: "Checks didn't run.", effect: "Finishes the task. The branch stays; publishing isn't set up." });
    expect(acceptWordsOf({ checks: "passed", unmet: 2, action: "complete", publishing: "other", proof: true }))
      .toEqual({ label: "Accept without checks", ready: false, why: "2 requirements aren't met.", effect: "Finishes the task. Nothing is published." });
    expect(acceptWordsOf({ checks: "off", unmet: 1, action: "complete", publishing: "off", proof: true }).why).toBe("Checks are off for this project and 1 requirement isn't met.");
    expect(acceptWordsOf({ checks: null, unmet: 0, action: "complete", publishing: "off", proof: true }).label).toBe("Accept without checks");
  });

  test("an acceptance that can't finish the task never says it does, nor that a second step follows", () => {
    expect(acceptWordsOf({ checks: "failed", unmet: 0, action: "accept", publishing: "pull-request", proof: true }))
      .toEqual({ label: "Accept without checks", ready: false, why: "Checks failed.", effect: "Records that you accept it. The task stays open." });
  });
});

describe("a report that doesn't match its saved changes, said plainly", () => {
  const criteria = [
    { id: "c1", statement: "Ledger-fixture tests demonstrate the half-cent drift is gone.", answered: [{ kind: "check", ref: "npm test" }, { kind: "changed-path", ref: "src/payout.ts" }] },
    { id: "c2", statement: "The console still renders payout dashboards.", answered: [{ kind: "screenshot", ref: "evidence/a.png" }] },
  ];
  const changes = new Map([["src/payout.ts", { from: 12, to: 16 }], ["src/payout.test.ts", null]]);

  test("a claimed file the changes don't have is named, each one, as not in the saved changes", () => {
    expect(reportMismatchesOf(["claimed changed paths not in the sealed diff: src/ledger.ts, src/fees.ts"], criteria, changes)).toEqual([
      { text: "The report says it changed", path: "src/ledger.ts", lines: null, inChanges: false, note: null, reason: "claimed changed paths not in the sealed diff: src/ledger.ts, src/fees.ts" },
      { text: "The report says it changed", path: "src/fees.ts", lines: null, inChanges: false, note: null, reason: "claimed changed paths not in the sealed diff: src/ledger.ts, src/fees.ts" },
    ]);
  });

  test("a requirement its own note contradicts points at the changed lines that requirement cites", () => {
    const [row] = reportMismatchesOf(['criterion "c1" is marked met, but caveat 2 admits an exception to it: only the happy path is covered'], criteria, changes);
    expect(row).toMatchObject({ text: "The report marks “Ledger-fixture tests demonstrate the half-cent drift is gone.” met, but its own note says: only the happy path is covered",
      path: "src/payout.ts", lines: { from: 12, to: 16 }, inChanges: true, note: 2 });
  });

  test("a note that names no requirement keeps its plain words and the note it is", () => {
    const [row] = reportMismatchesOf(["caveat 1 names no criterion — every caveat is an exception to exactly one signed criterion, named by its exact id (an unrelated idea belongs in the handoff's follow-ups): Captured against fixtures."], criteria, changes);
    expect(row).toMatchObject({ text: "The agent left a note without saying which requirement it affects: Captured against fixtures.", path: null, lines: null, note: 1 });
  });

  test("a requirement whose evidence doesn't hold is listed too, beside a failed check that the checks row already says", () => {
    const failing = [criteria[0]!, { ...criteria[1]!, state: "failed", detail: ['criterion "c2"\'s screenshot evidence "evidence/a.png" could not be verified: not a PNG'] }];
    expect(reportMismatchesOf(["the repository's approved verification command exited 1"], failing, changes)).toEqual([
      { text: "“The console still renders payout dashboards.”: screenshot evidence \"evidence/a.png\" could not be verified: not a PNG", path: null, lines: null, inChanges: null, note: null,
        reason: 'criterion "c2"\'s screenshot evidence "evidence/a.png" could not be verified: not a PNG' },
    ]);
    const [unsigned] = reportMismatchesOf(['caveat 2 names "c9", which is no signed or answered criterion — every caveat names an exact criterion id: skipped the ledger'], criteria, changes);
    expect(unsigned).toMatchObject({ text: "The report's note 2 is about \"c9\", which isn't one of the signed requirements: skipped the ledger", note: 2 });
  });
});

describe("what went wrong with a failed attempt, in one line", () => {
  test("the run's recorded reason, or that none was recorded — never a pointer elsewhere", () => {
    expect(failedAttemptSentence("timeout")).toBe("Ran out of time.");
    expect(failedAttemptSentence("acceptance")).toBe("The result didn't meet its signed requirements.");
    expect(failedAttemptSentence(null)).toBe(NO_REASON_RECORDED);
    expect(failedAttemptSentence(" ")).toBe("No reason was recorded for this attempt.");
  });

  test("a recorded code is never shown as stored; a reason already in words is said as written", () => {
    for (const code of [...Object.keys(RUN_REASON_WORDS), "some-new-code", "decision:12"]) {
      const sentence = failedAttemptSentence(code);
      expect(sentence.toLowerCase()).not.toBe(`${code}.`);
      if (/[-:]/.test(code)) expect(sentence).not.toContain(code);
      expect(sentence).toMatch(/^[A-Z].*\.$/);
    }
    expect(failedAttemptSentence("some-new-code")).toBe("The attempt stopped unexpectedly.");
    expect(failedAttemptSentence("lane 3 binary drifted out of its attested range")).toBe("Lane 3 binary drifted out of its attested range.");
  });

  test("the latest finished attempt, whatever its outcome and whatever order the runs come in; planning, reviewing and unfinished runs are not it", () => {
    const runs = [
      { id: 7, role: "builder", outcome: "failed", reason: "timeout", finishedAt: "t" },
      { id: 9, role: "reviewer", outcome: "failed", reason: "reviewer-error", finishedAt: "t" },
      { id: 8, role: "builder", outcome: "failed", reason: "acceptance", finishedAt: "t" },
      { id: 10, role: "builder", outcome: "built", reason: null, finishedAt: "t" },
      { id: 11, role: "builder", outcome: null, reason: null, finishedAt: null },
    ];
    // A newer attempt that didn't fail is still the one described: never an older failure.
    expect(latestFinishedAttempt(runs)?.id).toBe(10);
    expect(latestFinishedAttempt([...runs].reverse())?.id).toBe(10);
    expect(latestFinishedAttempt(runs.filter(one => one.id !== 10))?.id).toBe(8);
    expect(latestFinishedAttempt(runs.filter(one => one.finishedAt === null))).toBeNull();
    // A run a reconcile marked failed without a finish time still ended: it is the latest attempt.
    expect(latestFinishedAttempt([...runs, { id: 12, role: "builder", outcome: "failed", reason: "orphaned", finishedAt: null }])?.id).toBe(12);
  });

  test("a recorded reason is one plain line: its first line only, about 140 characters at most; machine output reads as an internal error", () => {
    expect(failedAttemptSentence("the worker lost its lease\nthen it tried again")).toBe("The worker lost its lease.");
    const long = failedAttemptSentence(`the build ${"kept on going ".repeat(20)}`);
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long).toMatch(/^The build kept on going .*going…$/);
    for (const machine of [
      "Error: spawn claude ENOENT",
      "TypeError: Cannot read properties of undefined (reading 'id')\n    at runTask (/Users/me/so/dist/worker.js:120:7)",
      "could not open /Users/me/.config/standing-orders/state.db",
      "worker.js:120 threw",
    ]) {
      expect(isInternalErrorReason(machine), machine).toBe(true);
      expect(failedAttemptSentence(machine)).toBe(INTERNAL_ERROR);
    }
    for (const words of ["timeout", "lane 3 binary drifted out of its attested range", "decision:12", "the ENV file was missing", "EOF before the plan finished",
      "see docs/setup.md first", "the patch for src/ledger.ts did not apply"]) expect(isInternalErrorReason(words), words).toBe(false);
  });

  test("a failing check ends on its last error line, numbered as in the saved log", () => {
    const log = "$ npm test\n(exit 1)\n\n--- stdout ---\n12 passed\n1 failed\n\n--- stderr ---\nFAIL src/payout.test.ts > rounds half cents\nAssertionError: expected 0.01 to be 0\n    at payout.test.ts:14:5\n";
    expect(lastErrorLineOf(log)).toEqual({ line: 10, text: "AssertionError: expected 0.01 to be 0" });
    // Nothing on stderr: the last line it printed that names a failure.
    expect(lastErrorLineOf("$ npm test\n(exit 1)\n\n--- stdout ---\n1 failed\ndone\n\n--- stderr ---\n")).toEqual({ line: 5, text: "1 failed" });
    expect(lastErrorLineOf("$ npm test\n(exit 1)\n\n--- stdout ---\n\n--- stderr ---\n")).toBeNull();
    // A silent check: the log's own section header is never offered as the failing line.
    expect(lastErrorLineOf("=== tweak-footer on its own · full check on 1a2b3c4 ===\n$ npm test\n(exit 1)\n\n--- stdout ---\n\n--- stderr ---\n")).toBeNull();
  });
});

describe("what a failed attempt missed, and what to change", () => {
  test("the first missed requirement, with the evidence line in plain words and the suggestion Retry starts with", () => {
    const missed = missedRequirementOf([
      { id: "c1", statement: "The export keeps every column.", state: "pass", detail: [] },
      { id: "c2", statement: "No reference to LEGACY_PAYOUT remains in the codebase.", state: "failed",
        detail: ['criterion "c2" is marked met, but caveat 1 admits an exception to it: c2: src/admin.ts still reads it.'] },
      { id: "c3", statement: "Docs say how.", state: "missing", detail: [] },
    ]);
    expect(missed).toEqual({ id: "c2", statement: "No reference to LEGACY_PAYOUT remains in the codebase.", evidence: "The agent's own note says: src/admin.ts still reads it." });
    expect(missedRequirementLine(missed!.statement)).toBe("Missed a requirement: No reference to LEGACY_PAYOUT remains in the codebase.");
    expect(missedRequirementSuggestion(missed!.statement)).toBe("Before handing off, make sure no reference to LEGACY_PAYOUT remains in the codebase.");
    // An acronym keeps its capitals; a person's own check is not a miss.
    expect(missedRequirementSuggestion("CSV headers stay quoted.")).toBe("Before handing off, make sure CSV headers stay quoted.");
    expect(missedRequirementOf([{ id: "c1", statement: "Reads well.", state: "manual-review", detail: [] }])).toBeNull();
    expect(missedRequirementOf([{ id: "c1", statement: "Docs say how.", state: "missing", detail: [] }])?.evidence).toBe("The agent's report doesn't answer it.");
  });

  test("Retry's prefilled note fits its field: cut at a word to 500 characters", () => {
    expect(retryNoteOf("Say what to do differently this time.")).toBe("Say what to do differently this time.");
    const long = missedRequirementSuggestion(`Every exported ${"column ".repeat(120)}keeps its header.`);
    expect(long.length).toBeGreaterThan(RETRY_NOTE_LIMIT);
    const note = retryNoteOf(long);
    expect(note.length).toBeLessThanOrEqual(RETRY_NOTE_LIMIT);
    expect(note).toMatch(/^Before handing off, make sure every exported column column .*column…$/);
  });

  test("a failing check's line and a stop reason each come with one suggestion", () => {
    expect(failingCheckSuggestion("FAIL settle rounds half-cents.")).toBe("Make the check pass. It ended on: FAIL settle rounds half-cents.");
    expect(stopSuggestionOf("timeout")).toBe("Split the work into smaller steps, or name the one part to finish first.");
    expect(stopSuggestionOf("something-new")).toBe(GENERAL_SUGGESTION);
    expect(stopSuggestionOf(null)).toBe(GENERAL_SUGGESTION);
    expect(RUN_REASON_WORDS["plan-revised"]).toBe("the plan changed, so a fresh attempt took over");
  });
});

describe("how far along a live build is", () => {
  const steps = (states: ("pending" | "current" | "completed" | "blocked")[], note: string | null = null) =>
    states.map((state, index) => ({ description: `Step ${index + 1} words.`, state, note: state === "blocked" ? note : null }));

  test("Step N of M names the step in progress, else the first one not done", () => {
    expect(buildProgressOf(steps(["completed", "current", "pending"]))).toEqual({ step: 2, total: 3, line: "Step 2 of 3: Step 2 words.", stuck: null });
    expect(buildProgressOf(steps(["completed", "pending", "pending"]))?.line).toBe("Step 2 of 3: Step 2 words.");
    expect(buildProgressOf(steps(["completed", "completed"]))?.line).toBe("All 2 steps done. Finishing up.");
    expect(buildProgressOf([])).toBeNull();
    expect(buildProgressOf(null)).toBeNull();
  });

  test("a blocked step replaces the step line: stuck, which of how many, and why (its note, else the step itself)", () => {
    const line = "Stuck on step 3 of 3: the staging flag is off.";
    expect(buildProgressOf(steps(["completed", "current", "blocked"], "the staging flag is off")))
      .toEqual({ step: 3, total: 3, line, stuck: { step: 3, why: "the staging flag is off", line } });
    expect(buildProgressOf(steps(["completed", "blocked", "pending"]))?.line).toBe("Stuck on step 2 of 3: Step 2 words.");
  });

  test("with only the recorded progress (a list row reads no plan file), steps go by number", () => {
    const recorded = (states: ("pending" | "current" | "completed" | "blocked")[], note: string | null = null) =>
      states.map(state => ({ description: null, state, note: state === "blocked" ? note : null }));
    expect(buildProgressOf(recorded(["completed", "current", "pending"]))?.line).toBe("Step 2 of 3.");
    expect(buildProgressOf(recorded(["completed", "blocked", "pending"], "waiting on staging"))?.line).toBe("Stuck on step 2 of 3: waiting on staging.");
    expect(buildProgressOf(recorded(["completed", "blocked"]))?.line).toBe("Stuck on step 2 of 2.");
  });

  test("earlier stopped attempts are one line", () => {
    expect(earlierAttemptsWords(1)).toBe("1 earlier attempt stopped");
    expect(earlierAttemptsWords(2)).toBe("2 earlier attempts stopped");
  });
});
