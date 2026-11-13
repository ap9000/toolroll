import { describe, expect, test } from "vitest";
import { acceptWordsOf, resultStatusOf, SET_A_CHECK, buildProgressOf, lastErrorLineOf, missedRequirementOf, reportMismatchesOf, stepRowsOf, type StepRowFacts } from "./workspace-ui.js";
import { taskRoad } from "./first-run.js";
import { failedAttemptSentence, INTERNAL_ERROR, isInternalErrorReason, latestFinishedAttempt, missedRequirementLine, missedRequirementSuggestion, RETRY_NOTE_LIMIT, retryNoteOf, RUN_REASON_WORDS } from "./needs-you.js";

describe("the result's Accept words", () => {
  test("Accept only when every requirement is met and the checks passed; it says it finishes, and never that it publishes", () => {
    expect(acceptWordsOf({ checks: "passed", unmet: 0, action: "complete", publishing: "pull-request", proof: true }))
      .toEqual({ label: "Accept", ready: true, why: null, effect: "Finishes the task. No pull request opens; you can open one from the task after." });
    expect(acceptWordsOf({ checks: "passed", unmet: 0, action: "complete", publishing: "other", proof: true }).effect).toBe("Finishes the task. Nothing is published.");
  });

  test("nothing on record is Accept anyway when the checks passed, Accept without checks when they didn't run, and says so", () => {
    expect(acceptWordsOf({ checks: "passed", unmet: 0, action: "complete", publishing: "off", proof: false }))
      .toMatchObject({ label: "Accept anyway", ready: false, why: "Nothing on record says what was met." });
    expect(acceptWordsOf({ checks: "not-run", unmet: 0, action: "complete", publishing: "off", proof: false }).label).toBe("Accept without checks");
    expect(acceptWordsOf({ checks: "not-run", unmet: 0, action: "complete", publishing: "off", proof: false }).why).toBe("Nothing on record says what was met and checks didn't run.");
  });

  test("the label names the gap: without checks only when the checks are what's missing; the why line says what, once", () => {
    expect(acceptWordsOf({ checks: "not-run", unmet: 0, action: "complete", publishing: "off", proof: true }))
      .toEqual({ label: "Accept without checks", ready: false, why: "Checks didn't run.", effect: "Finishes the task. The branch stays; publishing isn't set up." });
    expect(acceptWordsOf({ checks: "passed", unmet: 2, action: "complete", publishing: "other", proof: true }))
      .toEqual({ label: "Accept anyway", ready: false, why: "2 requirements aren't met.", effect: "Finishes the task. Nothing is published." });
    // Checks deliberately Off are checked at release: only the unmet requirement is said, and it isn't "without checks".
    expect(acceptWordsOf({ checks: "off", unmet: 1, action: "complete", publishing: "off", proof: true })).toMatchObject({ label: "Accept anyway", why: "1 requirement isn't met." });
    expect(acceptWordsOf({ checks: "off", unmet: 0, action: "complete", publishing: "off", proof: true })).toMatchObject({ label: "Accept", ready: true });
    // Checks running, unreadable or failed, with requirements unmet too: the checks are a gap, so the label says it.
    for (const checks of ["running", "unavailable", "failed"] as const) {
      expect(acceptWordsOf({ checks, unmet: 1, action: "complete", publishing: "off", proof: true }).label).toBe("Accept without checks");
    }
    expect(acceptWordsOf({ checks: null, unmet: 0, action: "complete", publishing: "off", proof: true }).label).toBe("Accept without checks");
  });

  test("an acceptance that can't finish the task never says it does, nor that a second step follows", () => {
    expect(acceptWordsOf({ checks: "failed", unmet: 0, action: "accept", publishing: "pull-request", proof: true }))
      .toEqual({ label: "Accept without checks", ready: false, why: "Checks failed.", effect: "Records that you accept it. The task stays open." });
  });
});

describe("a result with no project check set says where to set one", () => {
  const attested = (checkLevel?: "quick" | "full" | "off" | null) => resultStatusOf({ runId: 7, role: "builder", outcome: "built", verdict: "attested", reasons: [], accepted: false, ...(checkLevel === undefined ? {} : { checkLevel }) });
  test("the task card names Settings → Projects → Checks, never a pass", () => {
    expect(attested()).toMatchObject({ token: "agent-attested", label: "Ready · no project check set up",
      detail: `No project check is set up, so the checks listed are the agent's own report. ${SET_A_CHECK}` });
    expect(SET_A_CHECK).toBe("Set one in Settings → Projects → Checks.");
    expect(attested("full").detail).not.toMatch(/passed|ran on/i);
  });
  test("checks deliberately Off aren't told to set one", () => {
    expect(attested("off").detail).not.toContain(SET_A_CHECK);
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

  test("a requirement whose evidence doesn't hold is listed too, beside a failed check that the checks row already says", () => {
    const failing = [criteria[0]!, { ...criteria[1]!, state: "failed", detail: ['criterion "c2"\'s screenshot evidence "evidence/a.png" could not be verified: not a PNG'] }];
    expect(reportMismatchesOf(["the repository's approved verification command exited 1"], failing, changes)).toEqual([
      { text: "“The console still renders payout dashboards.”: screenshot evidence \"evidence/a.png\" could not be verified: not a PNG", path: null, lines: null, inChanges: null, note: null,
        reason: 'criterion "c2"\'s screenshot evidence "evidence/a.png" could not be verified: not a PNG' },
    ]);
    const [unsigned] = reportMismatchesOf(['caveat 2 names "c9", which is no signed or answered criterion — every caveat names an exact criterion id: skipped the ledger'], criteria, changes);
    expect(unsigned).toMatchObject({ text: "The report's note 2 is about \"c9\", which isn't one of the approved requirements: skipped the ledger", note: 2 });
  });
});

describe("what went wrong with a failed attempt, in one line", () => {
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
});

describe("the task page's step rows (stepRowsOf)", () => {
  const facts = (extra: Partial<StepRowFacts> & Pick<StepRowFacts, "journey">): StepRowFacts => ({ scout: false, status: { status: { headline: "Building", sentence: "Step 2 of 3: Adding the test." }, attempts: [] }, ...extra });
  const rows = (view: StepRowFacts) => stepRowsOf(view)!.map(one => `${one.key}:${one.mark}${one.open ? "+" : ""}${one.opens ? "" : "-"}:${one.sentence}`);

  test("no road, no rows: a cancelled task keeps its status block", () => {
    expect(stepRowsOf(facts({ journey: null }))).toBeNull();
  });

  test("waiting on the approval: the plan is one line pointing below, the approval is the one ink step, the rest say what will happen", () => {
    const view = facts({ journey: taskRoad({ stage: "needs-you", need: "approval" }, false, false, {}), approve: { heading: "Plan ready" },
      plan: { lead: "Add subtract next to add.", by: "Claude Sonnet", at: "2026-11-10T23:28:00.000Z", planning: false },
      status: { status: { headline: "Needs you", sentence: "Approve the plan." }, attempts: [] } });
    expect(rows(view)).toEqual(["plan:done:Written by Claude Sonnet · shown below", "approve:needs+:", "build:todo-:Starts when you approve",
      "checks:todo-:The project's checks run on the result", "ready:todo-:A result for you to review"]);
    const approval = stepRowsOf(view)![1]!;
    expect(approval).toMatchObject({ label: "Approval", needsYou: true, state: "current" });
    expect(stepRowsOf(view)![0]!.at).toBe("2026-11-10T23:28:00.000Z");
  });

  test("a held task whose plan still waits for a yes: the road stops at Plan, and the Approval row is open with its form", () => {
    const held = facts({ journey: taskRoad({ stage: "stopped" }, false, false, {}), approve: { heading: "Plan ready" },
      plan: { lead: "Rename the helper.", by: null, at: null, planning: false }, status: { status: { headline: "Stopped", sentence: "On hold." }, attempts: [] } });
    expect(rows(held).slice(0, 3)).toEqual(["plan:wait+:Stopped", "approve:todo+:You approve before anything is built", "build:todo-:Starts when you approve"]);
    // With no approval to give, a step not reached holds nothing to open.
    expect(rows({ ...held, approve: null })[1]).toBe("approve:todo-:You approve before anything is built");
  });

  test("a revision whose plan is being updated with the notes says so on the Plan row, not that a plan is being written", () => {
    const updating = facts({ journey: taskRoad({ stage: "planning" }, false, false, {}), plan: { lead: "Add subtract.", by: null, at: null, planning: true, updating: true },
      status: { status: { headline: "Planning", sentence: "" }, attempts: [] } });
    expect(rows(updating)[0]).toMatch(/^plan:live\+?:Updating the plan$/);
    expect(rows({ ...updating, plan: { ...updating.plan!, updating: false } })[0]).toMatch(/^plan:live\+?:Writing the plan$/);
  });

  test("building: the build runs in blue with its progress line; finished steps say who and when", () => {
    const view = facts({ journey: taskRoad({ stage: "building" }, true, false, {}), progress: { line: "Step 2 of 3: Adding the test." },
      approved: { by: "alex", at: "2026-11-10T23:30:00.000Z", automatic: false, rule: null },
      plan: { lead: "Add subtract next to add.", by: null, at: null, planning: false } });
    expect(rows(view)).toEqual(["plan:done:Add subtract next to add.", "approve:done:Approved by alex", "build:live+:Working now",
      "checks:todo-:The project's checks run on the result", "ready:todo-:A result for you to review"]);
    expect(stepRowsOf({ ...view, approved: { by: "", at: "2026-11-10T23:30:00.000Z", automatic: true, rule: "your operating mode" } })![1]!.sentence).toBe("Approved automatically");
  });

  test("checks failed: Checks is the stuck row, and the result opens from Ready although Ready wasn't reached", () => {
    const journey = taskRoad({ stage: "finished" }, true, true, { checks: "failed" });
    const view = facts({ journey, status: { status: { headline: "Failed", sentence: "Checks failed on a1b2c3d." }, attempts: [] }, result: { selected: {} } });
    expect(rows(view).slice(3)).toEqual(["checks:stuck+:The checks failed", "ready:todo:Not ready: the checks didn't pass. The result is here."]);
    // With no result yet, a step not reached has nothing to open.
    expect(rows({ ...view, result: null }).at(-1)).toBe("ready:todo-:A result for you to review");
  });

  test("ready for review waits on the viewer at Ready; a finished task opens its last step", () => {
    const review = facts({ journey: taskRoad({ stage: "needs-you", need: "review-result" }, true, true, { checks: "passed" }),
      status: { status: { headline: "Ready for review", sentence: "Ready." }, attempts: [] } });
    // The open row's head says how it stands; the box under it says the rest (no sentence twice).
    expect(rows(review).slice(3)).toEqual(["checks:done:Project checks passed", "ready:needs+:"]);
    // A finished road with a result still waiting on the viewer: Ready is theirs, never one done line.
    const finished = facts({ journey: taskRoad({ stage: "finished" }, true, true, { checks: "passed" }), status: { status: { headline: "Ready for review" }, attempts: [] } });
    expect(rows(finished).at(-1)).toBe("ready:needs+:");
    const done = facts({ journey: taskRoad({ stage: "complete" }, true, true, { checks: "passed" }), status: { status: { headline: "Complete", sentence: "Done." }, attempts: [] } });
    expect(rows(done).at(-1)).toBe("ready:done+:Finished");
    expect(stepRowsOf(done)!.filter(one => one.open)).toHaveLength(1);
  });

  test("a report has four rows and no Checks; skipped checks say why", () => {
    const report = facts({ scout: true, journey: taskRoad({ stage: "finished" }, true, true, { report: true }), status: { status: { headline: "Complete", sentence: "" }, attempts: [] } });
    expect(stepRowsOf(report)!.map(one => one.label)).toEqual(["Plan", "Approval", "Build", "Ready"]);
    expect(rows(report).at(-1)).toBe("ready:done+:Finished");
    expect(rows({ ...report, status: { status: { headline: "Waiting", sentence: "" }, attempts: [] } }).at(-1)).toBe("ready:done+:Report ready");
    const notRun = facts({ journey: taskRoad({ stage: "finished" }, true, true, { checks: "not-run" }) });
    expect(rows(notRun)[3]).toBe("checks:skipped:The checks didn't run");
    // The label is always the step's name; the state words are the sentence.
    expect(stepRowsOf(notRun)![3]!.label).toBe("Checks");
  });

  test("a failed build stops at Build in vermilion, waiting on nobody", () => {
    const failed = facts({ journey: taskRoad({ stage: "failed" }, true, false, {}), status: { status: { headline: "Failed", sentence: "The new test did not pass." }, attempts: [] } });
    expect(rows(failed)[2]).toBe("build:stuck+:Failed");
    expect(stepRowsOf(failed)!.some(one => one.needsYou)).toBe(false);
    // A stopped build waits, in grey: vermilion is only for a failure.
    const stopped = facts({ journey: taskRoad({ stage: "stopped" }, true, false, {}), status: { status: { headline: "Stopped" }, attempts: [] } });
    expect(rows(stopped)[2]).toBe("build:wait+:Stopped");
  });
});
