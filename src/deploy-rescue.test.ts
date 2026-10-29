/**
 * `toolroll release --recover-deploy` (deploy-rescue.ts): finds the one unfinished deployment, verifies its journal,
 * and runs that deployment's own recovery only with --yes. It never touches a deployment whose new service may be
 * running, and a rerun after recovery has nothing left to do.
 */
import { test, expect } from "vitest";
import { rescueDeployment, type RescueWorld } from "./deploy-rescue.js";
import { runReleaseCommand } from "./release-cli.js";

const database = "/state/orders.db";
const journal = (phase: string, patch: Record<string, unknown> = {}) => ({
  id: "0f1e2d3c-4b5a-4968-8776-655443322110", phase, database, builder: 41, priorRuntime: "/state/a/dist", nextRuntime: "/state/b/dist", ...patch,
});
function world(stages: Record<string, Record<string, unknown> | null>, recover: (stage: string) => string | null = stage => { stages[stage] = { ...stages[stage], phase: "released" }; return null; }) {
  const calls: { run: number; worktree: string; stage: string }[] = [];
  const w: RescueWorld = {
    database, stateDir: "/state",
    journals: () => Object.entries(stages).map(([stage, one]) => ({ stage, journal: one })),
    runWorktree: run => run === 41 ? "/work/41" : null,
    recover: async input => { calls.push(input); const failed = recover(input.stage); return failed === null ? { ok: true } : { ok: false, message: failed }; },
  };
  return { w, calls };
}

test("the one unfinished deployment is shown first, recovered only with --yes, and then has nothing left", async () => {
  const stages: Record<string, Record<string, unknown> | null> = { "/state/staged-upgrades/old": journal("deployed"), "/state/staged-upgrades/stuck": journal("stopping") };
  const { w, calls } = world(stages);
  const shown = await rescueDeployment(undefined, false, w);
  expect(shown).toMatchObject({ ok: true, acted: false, stage: "/state/staged-upgrades/stuck", phase: "stopping" });
  expect(calls).toEqual([]);
  expect(await rescueDeployment(undefined, true, w)).toMatchObject({ ok: true, acted: true, phase: "released" });
  expect(calls).toEqual([{ run: 41, worktree: "/work/41", stage: "/state/staged-upgrades/stuck" }]);
  // Idempotent: nothing is unfinished now, and nothing runs.
  expect(await rescueDeployment(undefined, true, w)).toMatchObject({ ok: true, acted: false, stage: null });
  expect(calls).toHaveLength(1);
});

test.each([
  ["a deployment whose new service may be running", { "/s/a": journal("started") }, undefined, "forward"],
  ["two unfinished deployments", { "/s/a": journal("stopping"), "/s/b": journal("stopped") }, undefined, "conflict"],
  ["an unreadable journal", { "/s/a": null }, undefined, "damaged"],
  ["another database's deployment", { "/s/a": journal("stopping", { database: "/other/orders.db" }) }, undefined, "conflict"],
  ["a journal with no builder run", { "/s/a": journal("stopping", { builder: null }) }, undefined, "damaged"],
  ["a run with no recorded worktree", { "/s/a": journal("stopping", { builder: 7 }) }, undefined, "damaged"],
  ["a stage that isn't one of this installation's", { "/s/a": journal("stopping") }, "/elsewhere", "usage"],
] as const)("refuses %s and runs nothing", async (_, stages, stage, reason) => {
  const { w, calls } = world({ ...stages });
  expect(await rescueDeployment(stage, true, w)).toMatchObject({ ok: false, reason });
  expect(calls).toEqual([]);
});

test("a recovery that refuses says where the journal stands and how to retry", async () => {
  const { w } = world({ "/s/a": journal("stopping") }, () => "Process 4242 can't be proved to be this service's, so nothing was stopped.");
  const outcome = await rescueDeployment(undefined, true, w);
  expect(outcome).toMatchObject({ ok: false, reason: "failed" });
  expect(!outcome.ok && outcome.message).toMatch(/nothing was stopped\. The journal is at stopping\. .*--recover-deploy --yes/);
});

test("the command line takes --recover-deploy with only --stage, --yes and --json", async () => {
  const { w, calls } = world({ "/state/staged-upgrades/stuck": journal("stopping") });
  const said: string[] = [];
  expect(await runReleaseCommand(["--recover-deploy", "--yes", "--stage", "/state/staged-upgrades/stuck"], line => said.push(line), { rescueWorld: w })).toBe(0);
  expect(calls).toHaveLength(1);
  for (const args of [["--recover-deploy", "main"], ["--recover-deploy", "--repo", "/x"], ["--stage", "/s"]]) {
    expect(await runReleaseCommand(args, () => {}, { rescueWorld: w })).toBe(2);
  }
  expect(calls).toHaveLength(1);
});
