/**
 * Attack: run a cheaper model's trial without a person, or spend a trial place twice (docs/plans/results-routing.md,
 * slice 3: Trials, Authority and Protection). Guards: store.ts sealScopeApproval → route-store.ts trialSealProblem (only a
 * person's ceremony or chat tap seals a trial task); approval-authority.ts trialSealStandsSql inside authorityStandsSql
 * (the queue, the work index, the claim and build belts) and route-store.ts admitTrialRun at admission (a forged row
 * still never dispatches or opens a run); consumeTrialPlace (a compare-and-swap on `reserved` and the sealed digest);
 * and proveRuleDoor for starting (a person's step-up) and stopping (a person, or the local owner in exactly
 * `trial-stop`). Each attack runs against a real plane database.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, BUILT_IN, RunAdmissionRefused, type Store } from "../../src/store.js";
import { addApprover, approve, propose } from "../../src/scope.js";
import { recordCatalog } from "../../src/model-catalog.js";
import { INSTALLATION_SCOPE } from "../../src/agentconfig.js";
import { consumeTrialPlace, insertTrial, proveRuleDoor, saveResultRecord, settleTrialPlaces, type RuleDoor } from "../../src/route-store.js";
import { startTrial, trialOffersFor } from "../../src/route-rules.js";
import { withActor } from "../../src/actor.js";

const T0 = new Date("2026-11-01T12:00:00.000Z");
const REPO = "/repo/shop";
const HAIKU = "claude-haiku-5-5", SONNET = "claude-sonnet-5-5";
let dir: string, store: Store, token: string, seq = 0;
const refOf = (id: string) => store.refFor(BUILT_IN, id).id;
const person = (method = "password-now"): RuleDoor => ({ kind: "person", person: { actor: "alex", generation: store.accountOf("alex")!.generation, method, live: () => true } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-rr-trial-attack-"));
  store = openStore(join(dir, "plane.db"));
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  token = alex.token;
  store.upsertProject(REPO, "shop", T0);
  for (const phase of ["plan", "review"] as const) store.setPhaseConfig(INSTALLATION_SCOPE, phase, "claude", "claude-opus-5-5", "alex", T0);
  store.setPhaseConfig(INSTALLATION_SCOPE, "build", "claude", SONNET, "alex", T0);
  store.setPhaseTierConfig(INSTALLATION_SCOPE, "build", "light", "claude", SONNET, "alex", T0);
  recordCatalog(store, [{ source: "claude", id: HAIKU, name: "Claude Haiku 5.5", inputUsd: 1, outputUsd: 5, context: null, tools: true, releasedAt: null },
    { source: "claude", id: SONNET, name: "Claude Sonnet 5.5", inputUsd: 3, outputUsd: 15, context: null, tools: true, releasedAt: null }], T0);
  for (let one = 0; one < 10; one++) {
    const id = `rec-${++seq}`;
    store.createTask({ id, title: id }, T0);
    store.placeTask(refOf(id), REPO);
    const when = new Date(T0.getTime() - 20 * 86_400_000 + one * 3_600_000);
    saveResultRecord(store, { taskRef: refOf(id), task: id, repo: REPO, cohortSize: "small", provider: "claude", model: SONNET, state: "mature", reason: null, resultRun: null,
      firstStartedAt: when.toISOString(), acceptedAt: null, decidedAt: null, modelFailures: 0, infraFailures: 0, apiMicrousd: 0, subscriptionRuns: 0, subscriptionTokens: 0,
      unknownRuns: 0, remediationRuns: 0, selections: [], settled: true, personRevisions: 0, firstCheckPassed: null, agentTurns: 0, turnsUnknownRuns: 0, accumulationEnded: false }, when);
  }
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function trial(): number {
  const started = startTrial(store, { repo: REPO, id: trialOffersFor(store, REPO, T0)[0]!.id }, person(), T0);
  if (!started.ok) throw new Error(started.problem);
  return started.trial;
}
function file(id: string): number {
  store.createTask({ id, title: id }, T0);
  store.placeTask(refOf(id), REPO);
  store.writeSizing(refOf(id), { size: "small", risky: false, source: "person", reason: "t" });
  propose(store, { taskId: id, goal: "Round payouts to the cent", now: T0 });
  return refOf(id);
}
const start = (ref: number) => {
  const authority = store.routeAuthorityFor(ref, "builder");
  if (authority === null || !authority.ok) throw new Error("route");
  return store.startRun({ taskRef: ref, leaseId: `l-${++seq}`, runner: "w", branch: `b-${seq}`, worktree: `/w/${seq}`, route: authority.stamp, now: T0 });
};

describe("a trial task is never approved or dispatched by a machine", () => {
  test("a mode seal and a lead's ceremony are refused; a mode basis written straight into the row never dispatches or opens a run", () => {
    trial();
    const ref = file("auto");
    expect(store.sealScopeApproval("auto", "alex", T0, {}, { kind: "mode", modeDigest: "m" })).toBe(false);
    expect(withActor({ account: "alex", lead: true }, () => approve(store, "auto", "alex", T0, store.getScope("auto")!.digest, token).ok)).toBe(false);
    expect(approve(store, "auto", "alex", T0, store.getScope("auto")!.digest, token).ok).toBe(true);
    store.handle.prepare("UPDATE task_scope SET approval_basis = 'mode' WHERE task_id = ?").run("auto");
    expect(store.modeApprovalLive(ref, T0)).toBe(false);
    expect(() => start(ref)).toThrow(RunAdmissionRefused);
    expect(store.runsFor(ref)).toEqual([]);
  });
});

describe("a place is spent once, and only its own task's", () => {
  test("a forged route naming another task's place files nothing; a consume without the sealed digest refuses", () => {
    trial();
    const mine = file("mine");
    const place = Number(store.handle.prepare("SELECT id FROM route_trial_reservation WHERE task_ref = ?").get(mine)?.["id"]);
    const theirs = file("theirs");
    const rule = Number(store.handle.prepare("SELECT rule FROM route_trial_reservation WHERE id = ?").get(place)?.["rule"]);
    expect(() => settleTrialPlaces(store, theirs, { kind: "trial", rule, reservation: place }, "d", T0)).toThrow(/doesn't hold/);
    expect(() => consumeTrialPlace(store, place, "", 1, T0)).toThrow(/sealed scope digest/);
    expect(consumeTrialPlace(store, place, "not-the-sealed-digest", 1, T0)).toBe(false);
  });

  test("a place consumed by one task's run never admits another task's build on it", () => {
    trial();
    const ref = file("first");
    expect(approve(store, "first", "alex", T0, store.getScope("first")!.digest, token).ok).toBe(true);
    start(ref);
    expect(store.handle.prepare("SELECT state FROM route_trial_reservation WHERE task_ref = ?").get(ref)?.["state"]).toBe("consumed");
    expect(Number(store.handle.prepare("SELECT COUNT(*) AS n FROM route_trial_reservation WHERE state = 'consumed'").get()?.["n"])).toBe(1);
  });
});

describe("starting takes a person's step-up; a writer called directly refuses", () => {
  test("a door proved for stopping never inserts a trial; a lead's proof never starts one", () => {
    const proved = proveRuleDoor(store, person(), "trial-stop", REPO);
    if (!proved.ok) throw new Error("door");
    expect(() => insertTrial(store, proved.door, { repo: REPO, cohortSize: "small", model: HAIKU, configuredProvider: "claude", configuredModel: SONNET, limit: 10, grant: {}, prices: {}, depends: {} }, T0))
      .toThrow(/door proved for exactly this act/);
    expect(startTrial(store, { repo: REPO, id: trialOffersFor(store, REPO, T0)[0]!.id }, person("lead-token"), T0)).toMatchObject({ ok: false, reason: "lead-refused" });
    expect(Number(store.handle.prepare("SELECT COUNT(*) AS n FROM route_rule").get()?.["n"])).toBe(0);
  });
});
