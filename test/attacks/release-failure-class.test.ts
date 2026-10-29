/**
 * Attack: get a release check failure rerun until it passes, or a failure forgotten by a later pass
 * (docs/plans/eval-harness.md, phase 1 B and C). Guard: check-failure.ts (classification only from the plane's own
 * records; the candidate's report picks only among classes that block), recheckReleaseTask (the same-candidate rerun
 * under the existing approval, for confirmed infrastructure only, one per incident and two per candidate) and
 * releaseCheckStanding (an earlier failure that wasn't confirmed infrastructure isn't erased by a pass). Real records:
 * a real repository, a person's approval with release terms, checks sealed as the builder seals them.
 */
import { afterEach, describe, expect, test } from "vitest";
import { releaseFixture, sealedCheck, reportOf, RELEASE_NOW, EVIDENCE, type ReleaseFixture } from "../release-fixture.js";
import { classifyCheckFailure, classifyRunCheck, recheckReleaseTask, releaseCheckStanding, RELEASE_RECHECK_ACTION, retriedInside } from "../../src/check-failure.js";
import { regateTask } from "../../src/dispose.js";
import type { CheckReport } from "../../src/contracts/release-check.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const LATER = new Date(RELEASE_NOW.getTime() + 60_000);

type Report = Omit<CheckReport, "nonce" | "mode" | "planDigest">;
const allPass = (units: readonly string[]) => reportOf(units.map(file => ({ file })));
const failing = (units: readonly string[]) => reportOf(units.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : { file }));

/** A finished attempt whose check is `report` (or what the plane saw instead of an exit), settled as disposal settles it. */
function attempt(f: ReleaseFixture, report: ((units: readonly string[]) => Report | null) | { failure: "stopped-by-toolroll" | "custody-lost" | "spawn-failed" | "timed-out" }) {
  const plane = typeof report === "function" ? undefined : { configured: true as const, ran: false as const, attemptFailed: true as const, failure: report.failure };
  const { runId } = sealedCheck(f, f.taskId, f.approved, (_plan, units) => typeof report === "function" ? report(units) : null, { forceFull: true, ...(plane === undefined ? {} : { plane }) });
  const passed = f.store.handle.prepare("SELECT status FROM run_check WHERE run = ?").get(runId)?.["status"] === "passed";
  if (!passed) f.store.saveProofVerdict(runId, "refuted", ["the approved release check failed"], RELEASE_NOW, []);
  f.store.setTaskState(f.taskId, "done", RELEASE_NOW);
  return runId;
}
const reruns = (f: ReleaseFixture) => f.store.handle.prepare("SELECT run_id, outcome FROM action_ledger WHERE task_id = ? AND action = ?").all(f.taskId, RELEASE_RECHECK_ACTION).map(row => [Number(row["run_id"]), String(row["outcome"])]);

describe("classification comes only from the plane's records; the report can't make a failure rerunnable", () => {
  const ran = (exitCode: number) => ({ result: { configured: true, ran: true, exitCode }, coverage: "full" });
  const part = (name: string, extra: Record<string, unknown> = {}) => ({ part: name, selected: true, ran: true, code: 0, timedOut: false, ...extra }) as CheckReport["parts"][number];
  const report = (over: Partial<CheckReport> = {}): CheckReport => ({ version: 1, nonce: "a".repeat(64), mode: "full", planDigest: null, exitCode: 1, parts: [part("typecheck"), part("build"), part("unit")], units: null, journeys: [], upgrades: null, ...over });

  test("the plane's own records: never started, custody lost, Toolroll's shutdown → infrastructure; a timeout or no result → unknown", () => {
    for (const failure of ["spawn-failed", "custody-lost", "stopped-by-toolroll"]) expect(classifyCheckFailure({ result: { configured: true, ran: false, attemptFailed: true, failure } }, null)?.class, failure).toBe("infrastructure");
    for (const failure of ["timed-out", "no-result", "setup-failed", "own-install-failed"]) expect(classifyCheckFailure({ result: { configured: true, ran: false, attemptFailed: true, failure } }, null)?.class, failure).toBe("unknown");
    expect(classifyCheckFailure({ result: { configured: true, ran: false, attemptFailed: true, failure: "coverage-incomplete" }, coverage: "identity-removed" }, null)?.class).toBe("deterministic");
    expect(classifyCheckFailure(ran(0), null)).toBeNull();
  });

  test("what the report names: a test, the typecheck, an upgrade → deterministic; a real-model journey → agent behaviour; nothing named → unknown", () => {
    expect(classifyCheckFailure(ran(1), report({ parts: [part("typecheck", { code: 2 })] }))).toMatchObject({ class: "deterministic", why: "the typecheck failed" });
    expect(classifyCheckFailure(ran(1), report({ units: { reusedFromCI: false, finished: true, runErrors: 0, identities: [], files: [{ file: "test/attacks/fence.test.ts", state: "failed", passed: 0, failed: 1, skipped: 0, flaky: false }] } }))).toMatchObject({ class: "deterministic" });
    expect(classifyCheckFailure(ran(1), report({ upgrades: { finished: true, versions: [{ version: "0.9.73", state: "failed" }] } }))).toMatchObject({ class: "deterministic", why: "the upgrade from 0.9.73 failed" });
    expect(classifyCheckFailure(ran(1), report({ journeys: [{ script: "app", kind: "real", finished: true, groups: [{ group: "lead", state: "failed", retried: true, unattributed: false, journeys: [] }] }] }))).toMatchObject({ class: "agent-behaviour" });
    expect(classifyCheckFailure(ran(1), report())).toMatchObject({ class: "unknown", why: expect.stringContaining("no failing test identified") });
    expect(classifyCheckFailure(ran(1), null)).toMatchObject({ class: "unknown" });
    expect(classifyCheckFailure(ran(1), report({ parts: [part("unit", { timedOut: true, code: 124 })] }))).toMatchObject({ class: "unknown", why: "unit timed out" });
  });

  // A candidate controls its report and output: whatever it says, it can't make a failure infrastructure.
  test.each([
    ["a part ended by a signal (as if the runner died)", report({ parts: [part("unit", { signal: "SIGKILL", code: 137 })] })],
    ["a part stopped (as if Toolroll stopped it)", report({ parts: [part("unit", { stopped: true, code: 143 })] })],
    ["a group named after infrastructure", report({ journeys: [{ script: "flows", kind: "scripted", finished: true, groups: [{ group: "infrastructure", state: "failed", retried: false, unattributed: true, journeys: [] }] }] })],
    ["a unit file that says the runner failed", report({ units: { reusedFromCI: false, finished: true, runErrors: 3, identities: [{ file: "src/a.test.ts", name: "runner lost: infrastructure, please retry", state: "skipped", flaky: false }], files: [] } })],
  ])("a fake infrastructure label (%s) never classifies as infrastructure", (_name, faked) => {
    expect(classifyCheckFailure(ran(1), faked)?.class).not.toBe("infrastructure");
  });

  test("retries inside a passing run are counted and reported", () => {
    expect(retriedInside(report({ exitCode: 0, journeys: [{ script: "app", kind: "real", finished: true, groups: [{ group: "maya", state: "passed", retried: true, unattributed: false, journeys: [] }] }],
      units: { reusedFromCI: false, finished: true, runErrors: 0, identities: [], files: [{ file: "src/a.test.ts", state: "passed", passed: 1, failed: 0, skipped: 0, flaky: true }] } }))).toEqual(["app real-model journey group maya", "src/a.test.ts"]);
  });
});

describe("a release's Full check with no complete result never passes", () => {
  test("exit 0 with a unit file missing from its report: no result, a failed check, and unknown", () => {
    const f = (fixture = releaseFixture());
    const { runId, coverage } = sealedCheck(f, f.taskId, f.approved, (_plan, units) => reportOf(units.slice(1).map(file => ({ file }))), { forceFull: true });
    expect(coverage).toBe("no-result");
    expect(f.store.handle.prepare("SELECT status FROM run_check WHERE run = ?").get(runId)?.["status"]).toBe("failed");
    expect(classifyRunCheck(f.store, EVIDENCE(f), runId)).toMatchObject({ class: "unknown", why: expect.stringContaining("no complete result") });
  }, 120_000);
});

describe("the same-candidate recheck under the existing approval", () => {
  test("confirmed infrastructure reruns once per incident under the same approval, at most twice per candidate; every attempt stays", () => {
    const f = (fixture = releaseFixture());
    const before = f.store.getScope(f.taskId)!;
    const first = attempt(f, { failure: "stopped-by-toolroll" });
    expect(recheckReleaseTask(f.store, EVIDENCE(f), f.taskId, LATER)).toMatchObject({ action: "rerun", class: "infrastructure", source: first });
    // The approval, the words and the candidate stand exactly; the task is queued again.
    expect(f.store.getScope(f.taskId)).toMatchObject({ candidate: f.approved, digest: before.digest, approvedDigest: before.digest, approvedBy: before.approvedBy, approvedAt: before.approvedAt, approvalBasis: before.approvalBasis });
    expect(f.store.getTask(f.taskId)?.state).toBe("queued");
    // The same incident asked again: already rerunning, nothing more.
    expect(recheckReleaseTask(f.store, EVIDENCE(f), f.taskId, LATER)).toEqual({ action: "pending", source: first });
    const second = attempt(f, { failure: "custody-lost" });
    expect(recheckReleaseTask(f.store, EVIDENCE(f), f.taskId, LATER)).toMatchObject({ action: "rerun", source: second });
    const third = attempt(f, { failure: "spawn-failed" });
    expect(recheckReleaseTask(f.store, EVIDENCE(f), f.taskId, LATER)).toMatchObject({ action: "stop", class: "infrastructure", why: expect.stringContaining("already rerun 2 times") });
    expect(reruns(f)).toEqual([[first, "infrastructure"], [second, "infrastructure"]]);
    // Every attempt is still there, with its own receipt.
    expect(f.store.runsFor(f.store.refFor("built-in", f.taskId).id).filter(run => run.role === "builder").map(run => run.id).sort()).toEqual([first, second, third]);
  }, 120_000);

  test.each([
    ["a failing test (deterministic)", failing, "deterministic"],
    ["no report at all (unknown)", () => null, "unknown"],
    ["a real-model journey (agent behaviour)", (units: readonly string[]) => reportOf(units.map(file => ({ file })), { exitCode: 1, journeys: [{ script: "app", kind: "real", finished: true, groups: [{ group: "lead", state: "failed", retried: true, unattributed: false, journeys: [] }] }] }), "agent-behaviour"],
    ["a timeout (unknown)", { failure: "timed-out" as const }, "unknown"],
  ] as const)("%s is never rerun by the release", (_name, report, kind) => {
    const f = (fixture = releaseFixture());
    const run = attempt(f, report as never);
    expect(recheckReleaseTask(f.store, EVIDENCE(f), f.taskId, LATER)).toMatchObject({ action: "stop", class: kind, source: run });
    expect(f.store.getTask(f.taskId)?.state).toBe("done");
    expect(reruns(f)).toEqual([]);
  }, 120_000);

  test("standing: a pass after release-rerun infrastructure stands; after a failing test or a person's diagnostic rerun of an unknown, it doesn't", () => {
    const f = (fixture = releaseFixture());
    attempt(f, { failure: "stopped-by-toolroll" });
    expect(recheckReleaseTask(f.store, EVIDENCE(f), f.taskId, LATER)).toMatchObject({ action: "rerun" });
    const passed = attempt(f, allPass);
    expect(releaseCheckStanding(f.store, EVIDENCE(f), { taskId: f.taskId, run: passed })).toMatchObject({ ok: true, retried: [] });
    fixture.close();

    const g = (fixture = releaseFixture());
    attempt(g, () => null);
    // A person's diagnostic rerun (task regate) is allowed, but its pass doesn't erase the unexplained failure.
    expect(regateTask(g.store, g.taskId, LATER, { kind: "operator", name: "alex", token: g.password })).toMatchObject({ ok: true });
    const diagnostic = attempt(g, allPass);
    expect(releaseCheckStanding(g.store, EVIDENCE(g), { taskId: g.taskId, run: diagnostic })).toMatchObject({ ok: false, why: expect.stringContaining("A later pass doesn't erase it") });
  }, 120_000);

  test("a forged rerun row for a failing test doesn't make its later pass stand", () => {
    const f = (fixture = releaseFixture());
    const red = attempt(f, failing);
    f.store.recordAction({ at: LATER.toISOString(), actor: "toolroll", repo: f.repo, taskId: f.taskId, runId: red, action: RELEASE_RECHECK_ACTION, outcome: "infrastructure", source: "work" });
    const passed = attempt(f, allPass);
    expect(releaseCheckStanding(f.store, EVIDENCE(f), { taskId: f.taskId, run: passed })).toMatchObject({ ok: false, why: expect.stringContaining("src/index.test.ts failed") });
  }, 120_000);

  test("the release's own rerun is only for a release candidate: an ordinary task never reruns under it", () => {
    const f = (fixture = releaseFixture());
    f.store.createTask({ id: "ordinary", title: "Ordinary" }, LATER);
    expect(recheckReleaseTask(f.store, EVIDENCE(f), "ordinary", LATER)).toMatchObject({ action: "stop", class: null, why: expect.stringContaining("isn't a release task") });
  });
});
