/**
 * The flaky tests list (docs/plans/learning-loops.md, slice 2): what counts as mixed outcomes under recorded conditions
 * and what never does, the bounds of the CI pairing, retention through the real sweep, and that none of it writes a
 * check's outcome. Real repositories and plane databases, fake checks, no model.
 */
import { afterEach, describe, expect, test } from "vitest";
import { EVIDENCE, RELEASE_NOW, builtRun, releaseFixture, reportOf, sealedCheck, type ReleaseFixture } from "../test/release-fixture.js";
import { captureCheckConditions, recordCheckFacts, type CheckConditions } from "./check-facts.js";
import type { CheckReport } from "./contracts/release-check.js";
import { storeEvidence } from "./evidence.js";
import { fixTaskOf, flakyList, flakyShow, observableIdentity, recordObservations } from "./flaky.js";
import { executeSweep } from "./storage-sweep.js";
import { learnRequestFor } from "./check-facts.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const open = () => (fixture = releaseFixture());
const ENV = ["HOME", "LANG", "PATH", "TZ"];
const ANSWER = "unit:src/index.test.ts::answer";
const conditionsOf = (f: ReleaseFixture, over: Record<string, string> = {}, head = f.approved): CheckConditions =>
  captureCheckConditions({ repo: f.repo, head, command: f.store.liveVerifyCommand(f.repo)!, access: "sandboxed", envNames: ENV, env: { PATH: "/usr/bin", HOME: "/home/check", LANG: "C", TZ: "UTC", ...over } });
const ref = (f: ReleaseFixture) => f.store.refFor("built-in", f.taskId).id;
const PASSING = [{ file: "src/index.test.ts", passed: ["answer"] }, { file: "src/browser/app.test.ts" }, { file: "test/attacks/fence.test.ts" }];
const FAILING = [{ file: "src/index.test.ts", failed: ["answer"] }, { file: "src/browser/app.test.ts" }, { file: "test/attacks/fence.test.ts" }];
type Units = Parameters<typeof reportOf>[0];
/** A sealed check and its facts, as the builder records them. */
function sealed(f: ReleaseFixture, units: Units): number {
  const one = sealedCheck(f, f.taskId, f.approved, () => reportOf(units), { forceFull: true });
  recordCheckFacts(f.store, EVIDENCE(f), { runId: one.runId, taskRef: ref(f), repo: f.repo, conditions: conditionsOf(f), receipt: { status: one.status }, report: one.report,
    attempt: { nonce: one.prepared.nonce, learn: one.prepared.learn }, stdout: one.stdout, now: RELEASE_NOW });
  return one.runId;
}
/** A check's facts alone (the report's lines are read the same whether or not its attempt was sealed): quick, for rules. */
function checked(f: ReleaseFixture, units: Units, options: { conditions?: CheckConditions; at?: Date; extra?: Parameters<typeof reportOf>[1]; head?: string } = {}): number {
  const head = options.head ?? f.approved, report = { ...reportOf(units, options.extra), nonce: "n", mode: "full", planDigest: null } as unknown as CheckReport;
  const runId = builtRun(f.store, f.taskId, head);
  recordCheckFacts(f.store, EVIDENCE(f), { runId, taskRef: ref(f), repo: f.repo, conditions: options.conditions ?? conditionsOf(f, {}, head), receipt: { status: report.exitCode === 0 ? "passed" : "failed" }, report, attempt: null, stdout: null, now: options.at ?? RELEASE_NOW });
  return runId;
}
const observations = (f: ReleaseFixture) => f.store.handle.prepare("SELECT identity, failed_run, passed_run, kind FROM local_observation ORDER BY id").all();

describe("what counts as mixed outcomes", () => {
  test("failed then passed at the same tree, command and conditions is listed, tracked, and changes no check", () => {
    const f = open();
    const failed = sealed(f, FAILING), passed = sealed(f, PASSING);
    expect(observations(f)).toEqual([{ identity: ANSWER, failed_run: failed, passed_run: passed, kind: "regate" }]);
    const list = flakyList(f.store, f.repo, RELEASE_NOW);
    expect(list.rows.map(one => [one.key, one.status, one.observations])).toEqual([[ANSWER, "mixed outcomes", 1]]);
    expect(list.rows[0]!.sources).toContain("Test report");
    expect(learnRequestFor(f.store, f.repo, RELEASE_NOW).learn).toEqual([ANSWER]);
    expect(f.store.handle.prepare("SELECT status FROM run_check WHERE run = ?").get(failed)).toMatchObject({ status: "failed" });
    const shown = flakyShow(f.store, f.repo, ANSWER, RELEASE_NOW)!;
    expect(shown.history).toHaveLength(1);
    expect(shown.history[0]).toMatchObject({ kind: "regate", failed: `build #${failed}`, passed: `build #${passed}`, commit: f.approved.slice(0, 7) });
  });

  test("passed first and failed later is the same observation, the other way round", () => {
    const f = open();
    const passed = checked(f, PASSING), failed = checked(f, FAILING);
    expect(observations(f)).toEqual([{ identity: ANSWER, failed_run: failed, passed_run: passed, kind: "regate" }]);
  });

  test("one inherited variable apart is not an observation", () => {
    const f = open();
    checked(f, FAILING, { conditions: conditionsOf(f, { TZ: "Asia/Tokyo" }) });
    checked(f, PASSING);
    expect(observations(f)).toEqual([]);
    expect(flakyList(f.store, f.repo, RELEASE_NOW).rows).toEqual([]);
  });

  test("a failure with a typecheck failure beside it lists the test; the part never is, and the check stays failed", () => {
    const f = open();
    const parts = ["typecheck", "unit"].map(part => ({ part: part as "typecheck", selected: true, ran: true, code: 1, timedOut: false }));
    const failed = checked(f, FAILING, { extra: { parts } });
    checked(f, PASSING);
    expect(observations(f).map(one => one["identity"])).toEqual([ANSWER]);
    expect(f.store.handle.prepare("SELECT state FROM check_result WHERE run = ? AND source = 'receipt'").get(failed)).toMatchObject({ state: "failed" });
  });

  test("never observable: parts, the whole check, unexplained, upgrades and real-model journeys", () => {
    for (const identity of ["part:typecheck", "check", "unexplained", "upgrade:0.9.1", "journey:app:real:core::opens", "group:app:real:core"]) expect(observableIdentity(identity)).toBe(false);
    for (const identity of [ANSWER, "file:src/a.test.ts", "journey:app:scripted:core::opens", "group:flows:scripted:core"]) expect(observableIdentity(identity)).toBe(true);
  });

  test("an infrastructure-class run is never paired, and one stamped after its check is left out of the list", () => {
    const f = open();
    const failed = checked(f, FAILING);
    f.store.handle.prepare("UPDATE run SET exec_class = 'infrastructure' WHERE id = ?").run(failed);
    checked(f, PASSING);
    expect(observations(f)).toEqual([]);
    const g = f.store;
    g.handle.prepare("UPDATE run SET exec_class = 'model' WHERE id = ?").run(failed);
    const again = checked(f, PASSING);
    expect(observations(f).length).toBe(1);
    g.handle.prepare("UPDATE run SET exec_class = 'infrastructure' WHERE id = ?").run(again);
    expect(flakyList(f.store, f.repo, RELEASE_NOW).rows).toEqual([]);
  });

  test("a retry inside one check is an observation, its run on both sides; a nightly's isn't", () => {
    const f = open();
    const retried = { units: { reusedFromCI: false, finished: true, runErrors: 0, files: [{ file: "src/index.test.ts", state: "passed" as const, passed: 1, failed: 0, skipped: 0, todo: 0, flaky: true }],
      identities: [{ file: "src/index.test.ts", name: "answer", state: "passed" as const, flaky: true }] } } as Parameters<typeof reportOf>[1];
    const run = checked(f, PASSING, { extra: retried });
    expect(observations(f)).toEqual([{ identity: ANSWER, failed_run: run, passed_run: run, kind: "in-check-retry" }]);
    const again = open();
    const nightly = builtRun(again.store, again.taskId, again.approved);
    again.store.handle.prepare("INSERT INTO check_fact (run, repo, task_ref, head, tree, command_digest, access, conditions_digest, conditions_class, purpose, learn_state, recorded_at) VALUES (?, ?, ?, ?, 't', 'c', 'sandboxed', 'd', 'x', 'nightly', 'not-asked', ?)").run(nightly, again.repo, ref(again), again.approved, RELEASE_NOW.toISOString());
    again.store.handle.prepare("INSERT INTO check_result (run, identity, state, source, recorded_at) VALUES (?, ?, 'passed-on-retry', 'report', ?)").run(nightly, ANSWER, RELEASE_NOW.toISOString());
    expect(recordObservations(again.store, nightly, RELEASE_NOW)).toEqual([]);
  });

  test("a file-level failure counts only as failed, then the whole check passed, and says it isn't confirmed per test", () => {
    const f = open();
    const failedRun = builtRun(f.store, f.taskId, f.approved);
    storeEvidence(f.store, EVIDENCE(f), failedRun, "check-log", "check-log.txt", Buffer.from(" FAIL  src/index.test.ts > answer\n Tests  1 failed | 3 passed\n"), "npm test", RELEASE_NOW, { captureStatus: "ok" });
    recordCheckFacts(f.store, EVIDENCE(f), { runId: failedRun, taskRef: ref(f), repo: f.repo, conditions: conditionsOf(f), receipt: { status: "failed" }, report: null, attempt: null, stdout: null, now: RELEASE_NOW });
    const passed = checked(f, PASSING);
    expect(observations(f)).toEqual([{ identity: "file:src/index.test.ts", failed_run: failedRun, passed_run: passed, kind: "regate" }]);
    expect(flakyList(f.store, f.repo, RELEASE_NOW).rows[0]).toMatchObject({ kind: "file", name: expect.stringContaining("file-level, not confirmed per test") });
  });

  test("racing dispositions on one pair leave one row", () => {
    const f = open();
    const failed = checked(f, FAILING), passed = checked(f, PASSING);
    expect(recordObservations(f.store, passed, RELEASE_NOW)).toEqual([]);
    expect(recordObservations(f.store, failed, RELEASE_NOW)).toEqual([]);
    expect(observations(f)).toHaveLength(1);
  });

  test("the row's status: a failure since keeps it; 20 clean runs since its file changed clear it, and 19 don't", () => {
    const f = open();
    checked(f, FAILING); checked(f, PASSING);
    for (let i = 0; i < 25; i++) checked(f, PASSING);
    // The failure is in the walk until the file changes: however many passes follow, the row stays mixed.
    expect(flakyList(f.store, f.repo, RELEASE_NOW).rows[0]!.status).toBe("mixed outcomes");
    const head = f.commit({ "src/index.test.ts": "changed\n" });
    for (let i = 0; i < 19; i++) checked(f, PASSING, { head });
    expect(flakyList(f.store, f.repo, RELEASE_NOW).rows[0]!).toMatchObject({ status: "mixed outcomes", fileChanged: RELEASE_NOW.toISOString() });
    checked(f, PASSING, { head });
    expect(flakyList(f.store, f.repo, RELEASE_NOW).rows[0]!.status).toBe("no failures since its file changed");
  });

  test("the fix task says to make the test reliable and never to skip or delete it", () => {
    const task = fixTaskOf({ key: ANSWER, name: "src/a.test.ts › ans\u0007wer", observations: 2, conditions: ["darwin-arm64-node24"], kind: "test" });
    expect(task.title).toContain("Make this test reliable");
    expect(task.goal).toMatch(/Never skip, delete or loosen/);
    expect(task.goal).not.toContain("\u0007");
  });
});

describe("retention, through the real sweep", () => {
  test("rows past 180 days go; a window past what is kept says so and never a zero", async () => {
    const f = open();
    const old = new Date(RELEASE_NOW.getTime() - 200 * 86_400_000);
    checked(f, FAILING, { at: old }); checked(f, PASSING, { at: old });
    expect(observations(f)).toHaveLength(1);
    const swept = await executeSweep(f.store, { databaseFile: f.databaseFile, pool: null, tempRoots: [], census: () => [], actor: "worker" } as unknown as Parameters<typeof executeSweep>[1], () => RELEASE_NOW);
    expect(swept.parts.find(one => one.kind === "check history")?.problem).toBeUndefined();
    expect(swept.parts.find(one => one.kind === "check history")?.count).toBeGreaterThan(0);
    expect(observations(f)).toEqual([]);
    expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM check_fact").get()).toMatchObject({ n: 2 });
    const wide = flakyList(f.store, f.repo, RELEASE_NOW, 365);
    expect(wide.complete).toBe(false);
    expect(flakyList(f.store, f.repo, RELEASE_NOW).complete).toBe(true);
  });
});
