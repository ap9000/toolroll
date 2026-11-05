/**
 * Architecture: results routing's writers and hooks, as this tree holds them (docs/plans/results-routing.md,
 * Protection items 2-4). Every required call and pinned body the manifest names is in place; the only SQL in the
 * product that writes a results-routing row, run.exec_class, task_ref.revision_origin or a Models (phase_*) row is in
 * route-store.ts or a named store.ts writer (the project deletion's included); and the writer refuses what its
 * contract doesn't name, whoever calls it.
 */
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MODELS_WRITERS, ROUTING_HOOKS, ROUTING_PINNED, routingHookProblem, sqlWriteProblem } from "../../src/route-hooks.js";
import { MODEL_SETTINGS, PROJECT_SETTINGS } from "../../src/project-delete.js";
import { recordRevisionOrigin, saveResultRecord } from "../../src/route-store.js";
import { openStore } from "../../src/store.js";

const ROOT = join(import.meta.dirname, "../..");
const read = (file: string): Buffer | null => { try { return readFileSync(join(ROOT, file)); } catch { return null; } };
function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap(name => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return name === "browser" || name === "tui" ? [] : sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [relative(ROOT, join(ROOT, path))] : [];
  });
}

describe("this tree", () => {
  test("holds every required call and pinned body", () => {
    expect(routingHookProblem({ candidate: read }, { paths: [], candidate: read, base: read })).toBeNull();
    // The manifest names each of the plan's inputs and consumers, the project deletion's Models writer among them.
    expect(ROUTING_HOOKS.map(hook => `${hook.file}:${hook.inside}→${hook.calls}`)).toEqual(expect.arrayContaining([
      "src/dispose.ts:disposeBuildOutcomeLocked→recordExecClass", "src/result-actions.ts:createResultRevision→recordRevisionOrigin",
      "src/operate.ts:reconcileCommand→reevaluateResultRecords", "src/project-delete.ts:deleteRows→forgetProjectModels",
      "src/release-auto.ts:changeProblem→routingHookProblem"]));
    expect(ROUTING_HOOKS.filter(hook => hook.calls === "requestResultChanges" || hook.calls === "createResultRevision" || hook.calls === "applyChatReview").every(hook => hook.args === true)).toBe(true);
    expect(ROUTING_PINNED.map(pin => pin.fn)).toEqual(expect.arrayContaining(["Store#setPhaseConfig", "Store#clearPhaseConfig", "Store#setPhaseTierConfig",
      "Store#clearPhaseTierConfig", "Store#setPhaseTierAlternate", "Store#clearPhaseTierAlternates", "forgetProjectModels", "Store#admitRun", "Store#sealScopeApproval"]));
    expect(MODELS_WRITERS["src/store.ts"]).toContain("forgetProjectModels");
  });

  test("writes its rows only from their writers, everywhere in the product", () => {
    const files = sources("src");
    expect(files.length).toBeGreaterThan(200);
    // With no base to keep anything, every write found must stand where it is.
    expect(sqlWriteProblem(files, read, () => null)).toBeNull();
    // A project's Models rows are deleted only through forgetProjectModels, never the generic settings list.
    const models = new Set(MODEL_SETTINGS.map(([table]) => table));
    expect(PROJECT_SETTINGS.filter(([table]) => models.has(table))).toEqual([]);
  });

  test("the writer refuses what its contract doesn't name, whoever calls it", () => {
    const store = openStore(":memory:");
    try {
      expect(() => recordRevisionOrigin(store, "t-1", "someone" as never)).toThrow(/unknown revision origin/);
      const value = { taskRef: 1, task: "t-1", repo: null, cohortSize: null, provider: null, model: null, state: "rejected" as const, reason: null, resultRun: null, firstStartedAt: null,
        acceptedAt: null, decidedAt: null, modelFailures: 0, infraFailures: 0, apiMicrousd: 0, subscriptionRuns: 0, subscriptionTokens: 0, unknownRuns: 0, remediationRuns: 0, selections: [], settled: true };
      expect(() => saveResultRecord(store, value, new Date())).toThrow(/can't have the reason/);
      expect(() => saveResultRecord(store, { ...value, state: "mature", reason: "no-check" }, new Date())).toThrow(/can't have the reason/);
      expect(() => saveResultRecord(store, { ...value, state: "rejected", reason: "unanswered" }, new Date())).toThrow(/can't have the reason/);
    } finally { store.close(); }
  });
});
