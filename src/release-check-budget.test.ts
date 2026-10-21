/** The release check's one concurrency budget (scripts/release-check.mjs, docs/plans/heavy-jobs.md v2): it shares out
 * what the machine has free, never makes its own load, and changes only speed — never what passes. */
import { expect, test } from "vitest";
import { checkBudget, loadWords, machineBusy, machineLoad } from "../scripts/release-check.mjs";

test("a quiet machine shares three quarters of its cores: half to units, the rest to browser lanes and upgrade workers", () => {
  expect(checkBudget(24, 2)).toEqual({ free: 16, unitWorkers: 8, lanes: { app: 4, flows: 2 }, upgradeWorkers: 4 });
  expect(checkBudget(8, 0)).toEqual({ free: 6, unitWorkers: 3, lanes: { app: 1, flows: 1 }, upgradeWorkers: 1 });
});

test("a busy machine leaves the check the minimum, one of each — slower, never stacked on top of the load", () => {
  // 2026-10-20: load 21 on 24 cores.
  expect(checkBudget(24, 21)).toEqual({ free: 2, unitWorkers: 1, lanes: { app: 1, flows: 1 }, upgradeWorkers: 1 });
  expect(checkBudget(2, 0)).toEqual({ free: 2, unitWorkers: 1, lanes: { app: 1, flows: 1 }, upgradeWorkers: 1 });
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
  const budget = checkBudget(24, 2);
  expect(loadWords([2, 9.4, 6], 24, budget)).toBe("load: 2.0 at start, peak 9.4, mean 5.8 on 24 cores; budget 16 of 24 cores: 8 unit workers, 4 app and 2 flows browser lanes, 4 upgrade workers");
  expect(loadWords([Number.NaN], 8, checkBudget(8))).toMatch(/^load: not measured on this platform; budget 6 of 8 cores/);
});
