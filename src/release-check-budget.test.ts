/** The release check's one concurrency budget (scripts/release-check.mjs, docs/plans/heavy-jobs.md v2): it shares out
 * what the machine has free — never more than that in all — never makes its own load, and changes only speed. */
import { expect, test } from "vitest";
import { checkBudget, loadWords, machineBusy, machineLoad } from "../scripts/release-check.mjs";

// The typecheck's one, then every share: never past the budget.
const total = (budget: ReturnType<typeof checkBudget>) => 1 + budget.unitWorkers + budget.lanes.app + budget.lanes.flows + budget.upgradeWorkers;

test("a quiet machine shares three quarters of its cores, and the shares add up to the budget, never more", () => {
  expect(checkBudget(24, 2)).toEqual({ free: 16, unitWorkers: 7, lanes: { app: 4, flows: 2 }, upgradeWorkers: 2, sequential: false });
  expect(checkBudget(8, 0)).toEqual({ free: 6, unitWorkers: 2, lanes: { app: 1, flows: 1 }, upgradeWorkers: 1, sequential: false });
  for (const [cores, load] of [[24, 2], [8, 0], [16, 4], [64, 0], [12, 3]] as const) {
    const budget = checkBudget(cores, load);
    expect(total(budget)).toBeLessThanOrEqual(budget.free);
  }
});

test("a busy machine gets one of each, one part after another — slower, never stacked on the load", () => {
  // 2026-10-20: load 21 on 24 cores.
  expect(checkBudget(24, 21)).toEqual({ free: 2, unitWorkers: 1, lanes: { app: 1, flows: 1 }, upgradeWorkers: 1, sequential: true });
  expect(checkBudget(2, 0)).toMatchObject({ free: 2, sequential: true });
});

test("a stricter TOOLROLL_UPGRADE_WORKERS stays stricter", () => {
  expect(checkBudget(24, 2, 1).upgradeWorkers).toBe(1);
  expect(checkBudget(24, 2, 9).upgradeWorkers).toBe(2);
});

test("unmeasured load (Windows reports 0) budgets from the cores alone and is never busy", () => {
  expect(machineLoad("win32", () => [0, 0, 0])).toBeNaN();
  expect(machineLoad("darwin", () => [3.5, 2, 1])).toBe(3.5);
  expect(checkBudget(16, Number.NaN)).toEqual(checkBudget(16, 0));
  expect(machineBusy(Number.NaN, 4)).toBe(false);
  expect(machineBusy(21, 24)).toBe(true);
  expect(machineBusy(12, 24)).toBe(false);
});

test("the summary names the load the check ran under and the budget it chose", () => {
  expect(loadWords([2, 9.4, 6], 24, checkBudget(24, 2))).toBe("load: 2.0 at start, peak 9.4, mean 5.8 on 24 cores; budget 16 of 24 cores: 7 unit workers, 4 app and 2 flows browser lanes, 2 upgrade workers");
  expect(loadWords([21], 24, checkBudget(24, 21))).toMatch(/one part after another$/);
  expect(loadWords([Number.NaN], 8, checkBudget(8))).toMatch(/^load: not measured on this platform; budget 6 of 8 cores/);
});
