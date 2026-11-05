/**
 * Trials, the slow case (docs/plans/results-routing.md, slice 3): the place count and its insert are one serialized
 * write, so a filing waits out another connection's write (the store's 15-second writer wait) before it can count.
 * The rest of the trial cases are in route-trials.test.ts; this setup mirrors theirs.
 *
 * Trials (docs/plans/results-routing.md, slice 3): trying a cheaper Claude model on the next N eligible tasks of a
 * project, each approved by a person. A place per task — reserved at filing, consumed exactly once at admission
 * against the sealed digest, or released — and a trial task sealed and dispatched only on a person's own yes.
 * Isolated databases only; records are written through their one writer (route-store.ts saveResultRecord).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, BUILT_IN, RunAdmissionRefused, initLocalMode, type Store } from "./store.js";
import { addApprover, approve, approvalProofDetail, APPROVAL_PROOF, propose } from "./scope.js";
import { recordCatalog } from "./model-catalog.js";
import { INSTALLATION_SCOPE } from "./agentconfig.js";
import { legOf, recommendRoute, type RouteCandidates } from "./phase-routing.js";
import { admitTrialRun, consumeTrialPlace, saveResultRecord, type RuleDoor } from "./route-store.js";
import type { RecordValue } from "./route-results.js";
import {
  acceptSuggestion, routeRulesPass, ruleById, selectionEvidenceWords, startTrial, stopTrial, suggestionsFor, trialOffersFor, trialsOf, trialWords,
} from "./route-rules.js";
import { withActor } from "./actor.js";
import { withRemote, type RemoteRun } from "./remote-run.js";
import { asLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "./local-owner.js";
import { runModelsCommand } from "./models-cli.js";

const T0 = new Date("2026-11-01T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const REPO = "/repo/shop";
const HAIKU = "claude-haiku-5-5", SONNET = "claude-sonnet-5-5", OPUS = "claude-opus-5-5";
let dir: string, store: Store, token: string, seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-route-trials-"));
  store = openStore(join(dir, "plane.db"));
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  token = alex.token;
  configure();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** Small and routine tasks build on Sonnet; Sonnet has 10 accepted results here, Haiku none. */
function configure(): void {
  store.upsertProject(REPO, "shop", T0);
  store.setPhaseConfig(INSTALLATION_SCOPE, "plan", "claude", OPUS, "alex", T0);
  store.setPhaseConfig(INSTALLATION_SCOPE, "build", "claude", SONNET, "alex", T0);
  store.setPhaseTierConfig(INSTALLATION_SCOPE, "build", "light", "claude", SONNET, "alex", T0);
  store.setPhaseConfig(INSTALLATION_SCOPE, "review", "claude", OPUS, "alex", T0);
  recordCatalog(store, [
    { source: "claude", id: HAIKU, name: "Claude Haiku 5.5", inputUsd: 1, outputUsd: 5, context: null, tools: true, releasedAt: null },
    { source: "claude", id: SONNET, name: "Claude Sonnet 5.5", inputUsd: 3, outputUsd: 15, context: null, tools: true, releasedAt: null },
    { source: "claude", id: OPUS, name: "Claude Opus 5.5", inputUsd: 5, outputUsd: 25, context: null, tools: true, releasedAt: null },
  ], T0);
  for (let one = 0; one < 10; one++) seed(SONNET, "mature", new Date(at(-30).getTime() + one * 3_600_000));
}

const refOf = (id: string) => store.refFor(BUILT_IN, id).id;
const person = (over: Partial<{ method: string; generation: number; live: () => boolean }> = {}): RuleDoor => ({
  kind: "person", person: { actor: "alex", generation: store.accountOf("alex")!.generation, method: "password-now", live: () => true, ...over },
});

function seed(model: string, state: RecordValue["state"], when: Date, size: "small" | "medium" = "small"): void {
  const id = `rec-${++seq}`;
  store.createTask({ id, title: id }, T0);
  store.placeTask(refOf(id), REPO);
  saveResultRecord(store, {
    taskRef: refOf(id), task: id, repo: REPO, cohortSize: size, provider: "claude", model, state, reason: state === "rejected" ? "check-failed" : null,
    resultRun: null, firstStartedAt: when.toISOString(), acceptedAt: null, decidedAt: null, modelFailures: 0, infraFailures: 0, apiMicrousd: 400_000,
    subscriptionRuns: 0, subscriptionTokens: 0, unknownRuns: 0, remediationRuns: 0, selections: [], settled: state === "mature" || state === "rejected",
    personRevisions: 0, firstCheckPassed: null, agentTurns: 0, turnsUnknownRuns: 0, accumulationEnded: false,
  }, when);
}

/** A small task filed now (and approved by the password ceremony unless asked not to). */
function file(id: string, options: { approveIt?: boolean; size?: "small" | "medium" | "large"; on?: Store } = {}): string {
  const db = options.on ?? store;
  db.createTask({ id, title: id }, T0);
  const ref = db.refFor(BUILT_IN, id).id;
  db.placeTask(ref, REPO);
  db.writeSizing(ref, { size: options.size ?? "small", risky: false, source: "person", reason: "set by the test" });
  propose(db, { taskId: id, goal: "Round payouts to the cent", now: T0 });
  if (options.approveIt === true && !approve(db, id, "alex", T0, db.getScope(id)!.digest, token).ok) throw new Error(`approve ${id}`);
  return id;
}
const build = (id: string, on: Store = store) => legOf(JSON.parse(on.getScope(id)!.proposedRouteJson!) as never, "build") as unknown as { model: string; selection?: { kind: string; rule: number; reservation?: number } };
const places = (where = "1 = 1") => store.handle.prepare(`SELECT id, task_ref, state, consumed_run, scope_digest FROM route_trial_reservation WHERE ${where} ORDER BY id`).all()
  .map(one => ({ id: Number(one["id"]), ref: Number(one["task_ref"]), state: String(one["state"]), run: one["consumed_run"] == null ? null : Number(one["consumed_run"]), digest: String(one["scope_digest"]) }));
function startBuild(id: string, on: Store = store): number {
  const authority = on.routeAuthorityFor(on.refFor(BUILT_IN, id).id, "builder");
  if (authority === null || !authority.ok) throw new Error(`no route for ${id}: ${authority === null ? "none" : authority.problem}`);
  return on.startRun({ taskRef: on.refFor(BUILT_IN, id).id, leaseId: `lease-${++seq}`, runner: "worker", branch: `standing-orders/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: at(1) });
}
function startHaikuTrial(): number {
  const [offer] = trialOffersFor(store, REPO, T0);
  if (offer === undefined) throw new Error("no trial offer");
  const started = startTrial(store, { repo: REPO, id: offer.id }, person(), T0);
  if (!started.ok) throw new Error(started.problem);
  return started.trial;
}

describe("places", () => {
  test("the count and the insert are one write transaction: a filing waits while another connection holds the write", () => {
    const trial = startHaikuTrial();
    for (let one = 0; one < 9; one++) file(`t-${one}`);
    const held = refOf("rec-1");
    store.createTask({ id: "blocked", title: "blocked" }, T0);
    store.placeTask(refOf("blocked"), REPO);
    store.writeSizing(refOf("blocked"), { size: "small", risky: false, source: "person", reason: "t" });
    const other = openStore(join(dir, "plane.db"));
    try {
      other.handle.exec("BEGIN IMMEDIATE");
      other.handle.prepare("INSERT INTO route_trial_reservation (rule, task_ref, scope_digest, state, created_at, updated_at) VALUES (?, ?, 'x', 'reserved', ?, ?)")
        .run(trial, held, T0.toISOString(), T0.toISOString());
      expect(() => propose(store, { taskId: "blocked", goal: "Round payouts", now: T0 })).toThrow();
      other.handle.exec("COMMIT");
    } finally { other.close(); }
    store.createTask({ id: "after", title: "after" }, T0);
    store.placeTask(refOf("after"), REPO);
    store.writeSizing(refOf("after"), { size: "small", risky: false, source: "person", reason: "t" });
    propose(store, { taskId: "after", goal: "Round payouts", now: T0 });
    expect(build("after").model).toBe(SONNET);
    expect(places("state IN ('reserved','consumed')")).toHaveLength(10);
  });

});
