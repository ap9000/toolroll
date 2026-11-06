/** A release check on a busy machine (check-load.ts): its limit scales with the budget it lost, bounded; a timeout under a
 * cut budget the plane measured itself is the machine's fault; with a normal budget, it stays a failure. */
import { describe, expect, test } from "vitest";
import { checkBudget, checkDeadline, machineSwamped, quietWaitLeft } from "../scripts/release-check.mjs";
import { budgetCut, busyMachineTimeout, CHECK_LIMIT_CEILING_MS, checkLimitFor, CheckLoadWatch, CUT_WINDOW_MS, freeAt, machineSample, normalFree, readCheckLoad, selfStopAfter, type CheckLoadRecord } from "./check-load.js";
import { classifyCheckFailure } from "./check-failure.js";
import type { CheckReport } from "./contracts/release-check.js";

const HOUR = 60 * 60_000, MIN = 60_000;

describe("the plane's copy of the check's arithmetic", () => {
  test("the budget the plane judges is the one the check gives itself from the same load", () => {
    for (const cores of [2, 4, 8, 12, 16, 24, 64]) for (const load of [0, 0.5, 1, 3.7, 9, 12.2, 15.6, 18.9, 21.3, 40, Number.NaN]) {
      expect(freeAt(cores, load), `${cores}/${load}`).toBe(checkBudget(cores, load).free);
    }
    expect(normalFree(24)).toBe(checkBudget(24, 0).free);
  });

  test("when the check stops itself is the check's own deadline", () => {
    for (const limit of [5_000, 40_000, 10 * MIN, HOUR, 90 * MIN, 2 * HOUR]) expect(selfStopAfter(limit), String(limit)).toBe(checkDeadline(0, limit));
  });

  test("a budget is cut at half its normal size or less; unmeasured load never is", () => {
    expect(budgetCut(24, 15.6)).toBe(true); // run 3315: 3 of 18
    expect(budgetCut(24, 18.9)).toBe(true); // run 3311: 2 of 18
    expect(budgetCut(24, 9)).toBe(true); // 9 of 18
    expect(budgetCut(24, 8)).toBe(false); // 10 of 18
    expect(budgetCut(24, 2)).toBe(false);
    expect(budgetCut(24, Number.NaN)).toBe(false);
    expect(budgetCut(2, 50)).toBe(false); // a tiny machine's budget is always its 2
    expect(machineSample("win32", () => [7, 7, 7], () => 8)).toEqual({ cores: 8, load: Number.NaN });
    expect(machineSample("darwin", () => [7.5, 1, 1], () => 8)).toEqual({ cores: 8, load: 7.5 });
  });
});

describe("the limit scales with the budget the check is left, bounded", () => {
  test("a normal budget keeps the approved limit", () => {
    expect(checkLimitFor(HOUR, { cores: 24, load: 2 })).toMatchObject({ limitMs: HOUR, why: expect.stringContaining("the approved 60 min") });
    expect(checkLimitFor(HOUR, { cores: 24, load: Number.NaN })).toMatchObject({ limitMs: HOUR, why: expect.stringContaining("isn't measured") });
  });

  test("a cut budget extends it in proportion — at most twice the approved limit and never past the ceiling", () => {
    // 24 cores at load 9: 9 of 18 → twice.
    expect(checkLimitFor(HOUR, { cores: 24, load: 9 }).limitMs).toBe(2 * HOUR);
    // 3315 (3 of 18) and 3311 (2 of 18): six and nine times, held at twice the approved hour = the two-hour ceiling.
    expect(checkLimitFor(HOUR, { cores: 24, load: 15.6 })).toMatchObject({ limitMs: CHECK_LIMIT_CEILING_MS, why: expect.stringMatching(/extended to 120 min: load 15\.6 on 24 cores left the check 3 of its normal 18/) });
    expect(checkLimitFor(HOUR, { cores: 24, load: 18.9 }).limitMs).toBe(CHECK_LIMIT_CEILING_MS);
    // 16 cores at load 7: 5 of 12 → 2.4×, held at twice.
    expect(checkLimitFor(10 * MIN, { cores: 16, load: 7 }).limitMs).toBe(20 * MIN);
    // A 90-minute limit is held by the ceiling; one at or past it is never extended.
    expect(checkLimitFor(90 * MIN, { cores: 24, load: 18 }).limitMs).toBe(CHECK_LIMIT_CEILING_MS);
    expect(checkLimitFor(3 * HOUR, { cores: 24, load: 18 })).toMatchObject({ limitMs: 3 * HOUR, why: expect.stringContaining("not extended") });
    for (const load of [9, 12, 15, 18, 21, 30]) for (const grant of [5_000, 10 * MIN, HOUR, 2 * HOUR]) {
      const { limitMs } = checkLimitFor(grant, { cores: 24, load });
      expect(limitMs).toBeGreaterThanOrEqual(grant);
      expect(limitMs).toBeLessThanOrEqual(Math.max(grant, Math.min(2 * grant, CHECK_LIMIT_CEILING_MS)));
    }
  });

  test("the check waits up to five minutes on a busy machine and ten on a swamped one, then starts", () => {
    expect(machineSwamped(18.9, 24)).toBe(true); // 2 of 18
    expect(machineSwamped(15.6, 24)).toBe(true); // 3 of 18
    expect(machineSwamped(12, 24)).toBe(false); // 6 of 18: cut, not swamped
    expect(quietWaitLeft(12, 24, 0)).toBe(0); // and not busy (past 85%): it starts at once
    expect(quietWaitLeft(21.3, 24, 0)).toBe(10 * MIN);
    expect(quietWaitLeft(21.3, 24, 4 * MIN)).toBe(6 * MIN);
    expect(quietWaitLeft(21.3, 24, 11 * MIN)).toBe(0);
    expect(quietWaitLeft(2, 24, 0)).toBe(0);
    expect(quietWaitLeft(Number.NaN, 24, 0)).toBe(0);
    // The wait never runs past the plane's window for the budget the check started with.
    expect(10 * MIN).toBeLessThan(CUT_WINDOW_MS);
  });
});

/** A plane record: the load at the start, then the check's own load on top every 15 s, the check ran `elapsedMs`. */
function record(over: Partial<CheckLoadRecord> & { start?: number; later?: number } = {}): CheckLoadRecord {
  const { start = 18.9, later = 22, ...rest } = over;
  const samples = [{ atMs: 0, load: start }, ...Array.from({ length: 200 }, (_, i) => ({ atMs: (i + 1) * 15_000, load: later }))];
  return { version: 1, cores: 24, grantMs: HOUR, limitMs: 2 * HOUR, why: "test", startedAt: "2026-11-06T00:00:00.000Z", elapsedMs: 2 * HOUR - 10 * MIN, samples, ...rest };
}

describe("a timeout on a busy machine, from the plane's record alone", () => {
  test("a cut budget and a check that ran into its own limit: the machine's fault", () => {
    expect(busyMachineTimeout(record(), HOUR, false)).toMatch(/^the machine was busy: its load stayed at 18\.9 or more on 24 cores as the check started, cutting its budget to 2 of its normal 18 cores, and it ran out of its 120 min$/);
    // Stopped by the plane at its limit: no elapsed needed.
    expect(busyMachineTimeout(record({ elapsedMs: null }), HOUR, true)).not.toBeNull();
  });

  test("a normal budget at the start — the check's own load later doesn't count — is never excused: a real hang stays a failure", () => {
    // Quiet at the start; the check's own workers then push the load up. The least load in the window is the start's.
    expect(busyMachineTimeout(record({ start: 2, later: 20, limitMs: HOUR }), HOUR, false)).toBeNull();
    expect(busyMachineTimeout(record({ start: 2, later: 20, limitMs: HOUR }), HOUR, true)).toBeNull();
    // Busy at the start, but the load dropped before the check began (it waited): it started with its normal budget.
    const dropped = record({ start: 21 });
    dropped.samples[20] = { atMs: 5 * MIN, load: 4 };
    expect(busyMachineTimeout(dropped, HOUR, false)).toBeNull();
    // Unmeasured load is never busy.
    expect(busyMachineTimeout(record({ samples: [{ atMs: 0, load: null }] }), HOUR, false)).toBeNull();
  });

  test("a check that ended before its limit wasn't out of time, whatever it said; a record for another grant counts for nothing", () => {
    expect(busyMachineTimeout(record({ elapsedMs: 20 * MIN }), HOUR, false)).toBeNull();
    expect(busyMachineTimeout(record({ elapsedMs: null }), HOUR, false)).toBeNull();
    expect(busyMachineTimeout(record(), 30 * MIN, false)).toBeNull();
    expect(busyMachineTimeout(null, HOUR, true)).toBeNull();
  });

  test("a record the plane could never have written is no record", () => {
    expect(readCheckLoad(record())).not.toBeNull();
    expect(readCheckLoad({ ...record(), limitMs: 3 * HOUR })).toBeNull(); // past twice the grant and the ceiling
    expect(readCheckLoad({ ...record(), limitMs: 30 * MIN })).toBeNull(); // below the approved limit
    expect(readCheckLoad({ ...record(), extra: true })).toBeNull();
    expect(readCheckLoad({ ...record(), samples: [{ atMs: 0, load: -1 }] })).toBeNull();
    expect(readCheckLoad("busy")).toBeNull();
  });

  test("the watch records the limit, every reading and the last attempt's time", () => {
    let clock = 1_000_000;
    const loads = [18.9, 19.5];
    const watch = new CheckLoadWatch(HOUR, { sample: () => ({ cores: 24, load: loads.shift() ?? 20 }), clock: () => clock, everyMs: 0 });
    expect(watch.limitMs).toBe(2 * HOUR);
    watch.attemptStarted();
    clock += 110 * MIN;
    watch.attemptEnded();
    const made = watch.finish();
    expect(made).toMatchObject({ version: 1, cores: 24, grantMs: HOUR, limitMs: 2 * HOUR, elapsedMs: 110 * MIN, samples: [{ atMs: 0, load: 18.9 }] });
    expect(readCheckLoad(JSON.parse(JSON.stringify(made)))).toEqual(made);
    expect(busyMachineTimeout(made, HOUR, false)).not.toBeNull();
  });
});

describe("classification: only the plane's record excuses a timeout, and the report can only withhold it", () => {
  const part = (name: string, extra: Record<string, unknown> = {}) => ({ part: name, selected: true, ran: true, code: 0, timedOut: false, startedAt: null, signal: null, stopped: false, spawnFailed: false, ...extra }) as CheckReport["parts"][number];
  const report = (parts: CheckReport["parts"], over: Partial<CheckReport> = {}): CheckReport => ({ version: 1, nonce: "a".repeat(64), mode: "full", planDigest: null, exitCode: 1, parts, units: null, journeys: [], upgrades: null, ...over });
  // Run 3311: the unit part stopped at the check's own limit; run 3315: the app part.
  const unitTimedOut = report([part("typecheck"), part("build"), part("unit", { code: 143, timedOut: true, stopped: true })]);
  const appTimedOut = report([part("typecheck"), part("build"), part("unit"), part("flows"), part("app", { code: 143, timedOut: true, stopped: true })]);
  const ran = { result: { configured: true, ran: true, exitCode: 1 }, coverage: "full", grantMs: HOUR };

  test("a part out of time under a cut budget: infrastructure, rerun on the same commit", () => {
    for (const one of [unitTimedOut, appTimedOut]) {
      expect(classifyCheckFailure(ran, one, record())).toMatchObject({ class: "infrastructure", why: expect.stringMatching(/timed out; the machine was busy.*Toolroll's own machine, so this commit's check runs again$/) });
    }
    // The plane itself stopped it at the limit.
    expect(classifyCheckFailure({ result: { configured: true, ran: false, attemptFailed: true, failure: "timed-out" }, grantMs: HOUR }, null, record())).toMatchObject({ class: "infrastructure" });
  });

  test("with a normal budget, no record, or a record for another grant, a timeout is unexplained as ever", () => {
    const quiet = record({ start: 2, later: 18, limitMs: HOUR });
    expect(classifyCheckFailure(ran, unitTimedOut, quiet)).toMatchObject({ class: "unknown", why: "unit timed out" });
    expect(classifyCheckFailure(ran, unitTimedOut, null)).toMatchObject({ class: "unknown" });
    expect(classifyCheckFailure({ ...ran, grantMs: undefined }, unitTimedOut, record())).toMatchObject({ class: "unknown" });
    expect(classifyCheckFailure({ result: { configured: true, ran: false, attemptFailed: true, failure: "timed-out" }, grantMs: HOUR }, null, quiet)).toMatchObject({ class: "unknown", why: "the check timed out, and nothing says why" });
  });

  test("a report that says a part timed out when the check ended early isn't believed", () => {
    expect(classifyCheckFailure(ran, unitTimedOut, record({ elapsedMs: 4 * MIN }))).toMatchObject({ class: "unknown" });
  });

  test("anything else that failed wins: a failing test, a signal, unit errors no test owned, no report", () => {
    const withFailure = report([part("typecheck", { code: 2 }), part("build"), part("unit", { code: 143, timedOut: true, stopped: true })]);
    expect(classifyCheckFailure(ran, withFailure, record())).toMatchObject({ class: "deterministic" });
    const failedFile = report(unitTimedOut.parts, { units: { reusedFromCI: false, finished: false, runErrors: 0, identities: [], files: [{ file: "src/a.test.ts", state: "failed", passed: 0, failed: 1, skipped: 0, flaky: false }] } });
    expect(classifyCheckFailure(ran, failedFile, record())).toMatchObject({ class: "deterministic" });
    const signalled = report([part("typecheck"), part("build"), part("unit", { code: 143, timedOut: true, stopped: true }), part("app", { code: 137, signal: "SIGKILL" })]);
    expect(classifyCheckFailure(ran, signalled, record())).toMatchObject({ class: "unknown" });
    const errors = report(unitTimedOut.parts, { units: { reusedFromCI: false, finished: false, runErrors: 2, identities: [], files: [] } });
    expect(classifyCheckFailure(ran, errors, record())).toMatchObject({ class: "unknown" });
    expect(classifyCheckFailure(ran, null, record())).toMatchObject({ class: "unknown" });
    // A real-model journey that failed is counted, never rerun.
    const agent = report(unitTimedOut.parts, { journeys: [{ script: "app", kind: "real", finished: true, groups: [{ group: "lead", state: "failed", retried: true, unattributed: false, journeys: [] }] }] });
    expect(classifyCheckFailure(ran, agent, record())).toMatchObject({ class: "agent-behaviour" });
  });
});
