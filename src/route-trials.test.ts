/**
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

describe("the offer", () => {
  test("offered when the configured model has 10 decided at ≥ 90% and the cheaper one too few results; one per size", () => {
    const [offer, ...rest] = trialOffersFor(store, REPO, T0);
    expect(rest).toEqual([]);
    expect(offer).toMatchObject({ cohortSize: "small", model: HAIKU, configured: { model: SONNET }, places: 10, evidence: { decided: 0 }, configuredEvidence: { decided: 10, mature: 10 } });
    expect(offer!.id).toMatch(/^trial:small:claude-haiku-5-5:[0-9a-f]{12}$/);
  });

  test("not offered below 10 configured results, below 90%, beside a suggestion, or with the switch off", () => {
    store.handle.prepare("DELETE FROM route_record WHERE model = ?").run(SONNET);
    for (let one = 0; one < 9; one++) seed(SONNET, "mature", at(-20 + one / 24));
    expect(trialOffersFor(store, REPO, T0)).toEqual([]);
    seed(SONNET, "rejected", at(-10));
    seed(SONNET, "rejected", at(-9));
    expect(trialOffersFor(store, REPO, T0)).toEqual([]);
    for (let one = 0; one < 10; one++) seed(SONNET, "mature", at(-5 + one / 24));
    expect(trialOffersFor(store, REPO, T0)).toHaveLength(1);
    // Haiku earned it on its own: a suggestion, not a trial.
    for (let one = 0; one < 10; one++) seed(HAIKU, "mature", at(-3 + one / 24));
    expect(suggestionsFor(store, REPO, T0)).toHaveLength(1);
    expect(trialOffersFor(store, REPO, T0)).toEqual([]);
  });

  test("a stale offer (new results), a price change or a Models change refuses by name; nothing is started", () => {
    const [offer] = trialOffersFor(store, REPO, T0);
    seed(SONNET, "mature", at(-1));
    expect(startTrial(store, { repo: REPO, id: offer!.id }, person(), T0)).toMatchObject({ ok: false, reason: "stale-suggestion", problem: expect.stringContaining("out of date") });
    const [fresh] = trialOffersFor(store, REPO, T0);
    recordCatalog(store, [{ source: "claude", id: HAIKU, name: "Claude Haiku 5.5", inputUsd: 2, outputUsd: 5, context: null, tools: true, releasedAt: null },
      { source: "claude", id: SONNET, name: "Claude Sonnet 5.5", inputUsd: 3, outputUsd: 15, context: null, tools: true, releasedAt: null }], T0);
    expect(startTrial(store, { repo: REPO, id: fresh!.id }, person(), T0)).toMatchObject({ ok: false, reason: "price-changed" });
    const [third] = trialOffersFor(store, REPO, T0);
    store.setPhaseConfig(INSTALLATION_SCOPE, "repair", "claude", SONNET, "alex", T0);
    expect(startTrial(store, { repo: REPO, id: third!.id }, person(), T0)).toMatchObject({ ok: false, reason: "config-changed" });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM route_rule WHERE kind = 'trial'").get()?.["n"]).toBe(0);
  });

  test("eligibility is re-checked when a person accepts a stale offer: Haiku earned a suggestion since", () => {
    const [offer] = trialOffersFor(store, REPO, T0);
    for (let one = 0; one < 10; one++) seed(HAIKU, "mature", at(-3 + one / 24));
    expect(startTrial(store, { repo: REPO, id: offer!.id }, person(), T0)).toMatchObject({ ok: false, reason: "stale-suggestion" });
  });

  test("two concurrent trial starts: one wins (the winner index), the other is refused taken", () => {
    const [offer] = trialOffersFor(store, REPO, T0);
    const other = openStore(join(dir, "plane.db"));
    try {
      const first = startTrial(store, { repo: REPO, id: offer!.id }, person(), T0);
      const second = startTrial(other, { repo: REPO, id: offer!.id }, { kind: "person", person: { actor: "alex", generation: other.accountOf("alex")!.generation, method: "password-now", live: () => true } }, T0);
      expect([first.ok, second.ok].sort()).toEqual([false, true]);
      expect(second).toMatchObject({ ok: false, reason: "taken" });
    } finally { other.close(); }
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM route_rule WHERE state = 'trialling'").get()?.["n"]).toBe(1);
  });
});

describe("routing: the one precedence order", () => {
  const candidates: RouteCandidates = {
    plan: { routine: { provider: "claude", model: OPUS, source: "t" }, strong: null },
    build: { light: { provider: "claude", model: SONNET, source: "t" }, routine: { provider: "claude", model: SONNET, source: "t" }, strong: null },
    repair: { routine: null, strong: null },
    review: { routine: { provider: "claude", model: OPUS, source: "t" }, strong: null },
  };
  const trial = { id: 7, generation: 1, cohortSize: "small" as const, provider: "claude" as const, model: HAIKU, configured: { provider: "claude", model: SONNET }, limit: 10, reservation: 3 };
  const rule = { id: 8, generation: 1, cohortSize: "small" as const, provider: "claude" as const, model: "claude-haiku-4-5", configured: { provider: "claude", model: SONNET } };
  const route = (over: Record<string, unknown> = {}) => legOf(recommendRoute({ qualityMode: "default", evidence: [], publication: "none", candidates, overrides: [],
    size: { size: "small", risky: false, source: "person", reason: "" }, earned: { rules: [rule], release: false, protected: false, trial }, ...over } as never), "build");

  test("pin > override > trial > earned rule > configured", () => {
    expect(route()).toMatchObject({ model: HAIKU, selection: { kind: "trial", rule: 7, reservation: 3 } });
    expect(route({ overrides: [{ phase: "build", provider: "claude", model: OPUS, by: "alex", at: T0.toISOString() }] })).toMatchObject({ model: OPUS, chosen: "override" });
    expect(route({ pins: { build: { provider: "claude", model: OPUS } } })).toMatchObject({ model: OPUS, chosen: "pinned" });
    expect(route({ earned: { rules: [rule], release: false, protected: false, trial: { ...trial, reservation: null } } })).toMatchObject({ model: "claude-haiku-4-5", selection: { kind: "rule" } });
  });

  test("large, risky, strict, screenshots, a release or protected paths are never in a trial", () => {
    const none = { earned: { rules: [], release: false, protected: false, trial } };
    expect(route({ ...none, size: { size: "large", risky: false, source: "person", reason: "" } }).selection).toBeUndefined();
    expect(route({ ...none, size: { size: "small", risky: true, source: "person", reason: "" } }).selection).toBeUndefined();
    expect(route({ ...none, qualityMode: "strict" }).selection).toBeUndefined();
    expect(route({ ...none, evidence: ["screenshot"] }).selection).toBeUndefined();
    expect(route({ earned: { rules: [], release: true, protected: false, trial } }).selection).toBeUndefined();
    expect(route({ earned: { rules: [], release: false, protected: true, trial } }).selection).toBeUndefined();
  });

  test("an override or pin takes no place; an ineligible task takes none either", () => {
    startHaikuTrial();
    const id = file("overridden");
    expect(build(id).selection).toMatchObject({ kind: "trial" });
    expect(store.editTaskRoute(refOf(id), { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "build", provider: "claude", model: OPUS } }, T0).ok).toBe(true);
    expect(build(id)).toMatchObject({ model: OPUS });
    expect(places()).toMatchObject([{ ref: refOf(id), state: "released" }]);
    file("large", { size: "large" });
    expect(places()).toHaveLength(1);
  });
});

describe("places", () => {
  test("ten places: the eleventh filing builds on the configured model, with its reason", () => {
    startHaikuTrial();
    for (let one = 0; one < 10; one++) expect(build(file(`t-${one}`)).model).toBe(HAIKU);
    const eleventh = file("t-10");
    expect(build(eleventh).model).toBe(SONNET);
    expect(build(eleventh).selection).toBeUndefined();
    expect(JSON.stringify(build(eleventh))).toContain("every place in the trial for small tasks is taken");
    expect(places("state = 'reserved'")).toHaveLength(10);
  });

  test("at 9 of 10, two filings from two connections: exactly one place", () => {
    startHaikuTrial();
    for (let one = 0; one < 9; one++) file(`t-${one}`);
    const other = openStore(join(dir, "plane.db"));
    try {
      file("race-a");
      file("race-b", { on: other });
      expect([build("race-a").model, build("race-b", other).model].sort()).toEqual([HAIKU, SONNET].sort());
    } finally { other.close(); }
    expect(places("state = 'reserved'")).toHaveLength(10);
  });

  test("repeated saves reuse one place, bound to the digest each save files", () => {
    startHaikuTrial();
    const id = file("saved");
    const first = places()[0]!;
    for (let one = 0; one < 5; one++) store.refileScope(id, at(one / 24));
    expect(places()).toEqual([{ ...first, digest: store.getScope(id)!.digest }]);
    expect(build(id).selection).toMatchObject({ kind: "trial", reservation: first.id });
  });

  test("a retry consumes nothing more; a repair of the same task neither", () => {
    startHaikuTrial();
    const id = file("retried", { approveIt: true });
    const run = startBuild(id);
    expect(places()).toMatchObject([{ state: "consumed", run }]);
    store.finishRun(run, { outcome: "failed", reason: "agent", now: at(1) });
    const again = startBuild(id);
    expect(store.getRun(again)!.model).toBe(HAIKU);
    expect(places()).toMatchObject([{ state: "consumed", run }]);
    expect(admitTrialRun(store, { taskId: id, taskRef: refOf(id), role: "repair", run: again, now: at(1) })).toBeNull();
    expect(places()).toMatchObject([{ state: "consumed", run }]);
  });

  test("a released place can't be consumed, by admission or directly", () => {
    startHaikuTrial();
    const id = file("released", { approveIt: true });
    const place = places()[0]!;
    store.applyCancellation(id, { kind: "operator", text: null }, T0, null);
    expect(places()).toMatchObject([{ state: "released" }]);
    expect(consumeTrialPlace(store, place.id, place.digest, 1, T0)).toBe(false);
    expect(() => consumeTrialPlace(store, place.id, "", 1, T0)).toThrow(/sealed scope digest/);
    // Even with the task revived by a forged state, admission refuses on the place.
    store.handle.prepare("UPDATE task SET state = 'queued' WHERE id = ?").run(id);
    expect(() => startBuild(id)).toThrow(RunAdmissionRefused);
    expect(places()).toMatchObject([{ state: "released", run: null }]);
  });

  test("admission racing cancel, both orders, two connections: exactly one of consumed or released", () => {
    startHaikuTrial();
    const a = file("admit-first", { approveIt: true });
    const b = file("cancel-first", { approveIt: true });
    const other = openStore(join(dir, "plane.db"));
    try {
      startBuild(a);
      other.applyCancellation(a, { kind: "operator", text: null }, T0, null);
      other.applyCancellation(b, { kind: "operator", text: null }, T0, null);
      expect(() => startBuild(b)).toThrow(RunAdmissionRefused);
    } finally { other.close(); }
    expect(places(`task_ref = ${refOf(a)}`)).toMatchObject([{ state: "consumed" }]);
    expect(places(`task_ref = ${refOf(b)}`)).toMatchObject([{ state: "released", run: null }]);
  });

  test("re-file racing admission: a re-file that drops the trial first stales the approval; after admission it never releases", () => {
    startHaikuTrial();
    const first = file("refile-first", { approveIt: true });
    const second = file("admit-then-refile", { approveIt: true });
    const other = openStore(join(dir, "plane.db"));
    try {
      expect(other.editTaskRoute(other.refFor(BUILT_IN, first).id, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "build", provider: "claude", model: OPUS } }, T0).ok).toBe(true);
      expect(() => startBuild(first)).toThrow(/approved and then changed/);
      startBuild(second);
      expect(other.editTaskRoute(other.refFor(BUILT_IN, second).id, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "build", provider: "claude", model: OPUS } }, T0).ok).toBe(true);
    } finally { other.close(); }
    expect(places(`task_ref = ${refOf(first)}`)).toMatchObject([{ state: "released" }]);
    expect(places(`task_ref = ${refOf(second)}`)).toMatchObject([{ state: "consumed" }]);
  });

  test("the tenth consumed place finishes the trial; its cohort is free again", () => {
    const trial = startHaikuTrial();
    for (let one = 0; one < 10; one++) startBuild(file(`t-${one}`, { approveIt: true }));
    expect(ruleById(store, trial)).toMatchObject({ state: "finished", endReason: "all-places-used" });
    expect(build(file("next")).model).toBe(SONNET);
  });
});

describe("only a person approves a trial task", () => {
  const BASES = ["mode", "grant", "schedule", "auto-check", "auto-green"] as const;

  test("every non-person basis is refused at the seal; a plain task under the same call seals", () => {
    startHaikuTrial();
    const plain = file("plain", { size: "medium" });
    expect(build(plain).selection).toBeUndefined();
    expect(store.sealScopeApproval(plain, "alex", T0, {}, { kind: "mode", modeDigest: "m" })).toBe(true);
    for (const kind of BASES) {
      const id = file(`seal-${kind}`);
      expect(build(id).selection).toMatchObject({ kind: "trial" });
      expect(store.sealScopeApproval(id, "alex", T0, {}, { kind, modeDigest: "m" }), kind).toBe(false);
      expect(store.getScope(id)!.approvedAt).toBeNull();
    }
    const carried = file("seal-carried");
    expect(store.sealScopeApproval(carried, "alex", T0, {}, { kind: "carried", modeDigest: "m" } as never)).toBe(false);
    const ai = file("seal-ai");
    expect(store.sealScopeApproval(ai, "helper (AI)", T0)).toBe(false);
    // The lead (its own actor, or a remote API run) approves nothing, by the person's road or chat.
    const lead = file("seal-lead");
    expect(withActor({ account: "alex", lead: true }, () => store.sealScopeApproval(lead, "alex", T0))).toBe(false);
    expect(withActor({ account: "alex", lead: true }, () => store.sealScopeApproval(lead, "alex", T0, {}, { kind: "chat", modeDigest: "m" }))).toBe(false);
    const remote = { account: "alex", scope: "act", tokenName: "laptop", source: "api", secret: "s", allows: () => true, lens: null, noteTask: () => {}, files: {} } as unknown as RemoteRun;
    expect(withRemote(remote, () => store.sealScopeApproval(lead, "alex", T0, {}, { kind: "chat", modeDigest: "m" }))).toBe(false);
    // A person's ceremony, and a person's chat tap, seal it.
    expect(approve(store, file("seal-person"), "alex", T0, store.getScope("seal-person")!.digest, token).ok).toBe(true);
    expect(store.sealScopeApproval(file("seal-chat"), "alex", T0, {}, { kind: "chat", modeDigest: "m" })).toBe(true);
  });

  test("every non-person approval is refused at dispatch and admission, even when written straight into the row", () => {
    startHaikuTrial();
    for (const basis of [...BASES, "carried", "lead", "password-by-a-machine", "chat-without-proof"] as const) {
      const id = file(`forged-${basis}`, { approveIt: true });
      const ref = refOf(id);
      if (basis === "password-by-a-machine") {
        // The proof row at the seal's instant says a lead token: a machine's seal.
        const scope = store.getScope(id)!;
        store.recordAction({ at: scope.approvedAt!, actor: "alex", repo: REPO, taskId: id, runId: null, action: APPROVAL_PROOF, outcome: "lead-token", source: "work",
          detail: approvalProofDetail(T0.getTime(), store.accountOf("alex")!.generation, scope.digest) });
      } else if (basis === "chat-without-proof") {
        // A seal at an instant no person's proof names.
        store.handle.prepare("UPDATE task_scope SET approval_basis = 'chat', approved_at = ? WHERE task_id = ?").run(at(0.5).toISOString(), id);
      } else {
        store.handle.prepare("UPDATE task_scope SET approval_basis = ? WHERE task_id = ?").run(basis, id);
      }
      expect(store.modeApprovalLive(ref, at(1)), basis).toBe(false);
      expect(() => startBuild(id), basis).toThrow(RunAdmissionRefused);
      expect(admitTrialRun(store, { taskId: id, taskRef: ref, role: "builder", run: 1, now: at(1) }), basis).toMatch(/^trial-person/);
      expect(places(`task_ref = ${ref}`), basis).toMatchObject([{ state: "reserved", run: null }]);
    }
  });

  test("a person's chat tap with its proof dispatches", () => {
    startHaikuTrial();
    const id = file("chat-ok");
    expect(store.sealScopeApproval(id, "alex", T0, {}, { kind: "chat", modeDigest: "m" })).toBe(true);
    const scope = store.getScope(id)!;
    store.recordAction({ at: scope.approvedAt!, actor: "alex", repo: REPO, taskId: id, runId: null, action: APPROVAL_PROOF, outcome: "chat", source: "request",
      detail: approvalProofDetail(T0.getTime(), store.accountOf("alex")!.generation, scope.digest) });
    expect(store.modeApprovalLive(refOf(id), at(1))).toBe(true);
    expect(store.getRun(startBuild(id))!.model).toBe(HAIKU);
  });
});

describe("stopping, the pass and the words", () => {
  test("stop: waiting plans are re-filed on the configured model; an approved task keeps its place and model", () => {
    const trial = startHaikuTrial();
    const waiting = file("waiting");
    const approved = file("approved", { approveIt: true });
    expect(stopTrial(store, trial, person(), T0)).toMatchObject({ ok: true, trial: { state: "turned-off", endReason: "stopped" } });
    expect(places(`task_ref = ${refOf(waiting)}`)).toMatchObject([{ state: "released" }]);
    // Sealing the waiting plan on the place it no longer holds is refused; the pass re-files it.
    expect(approve(store, waiting, "alex", T0, store.getScope(waiting)!.digest, token).ok).toBe(false);
    expect(routeRulesPass(store, REPO, at(1))).toMatchObject({ refiled: 1 });
    expect(build(waiting).model).toBe(SONNET);
    expect(store.getRun(startBuild(approved))!.model).toBe(HAIKU);
    expect(build(file("after-stop")).model).toBe(SONNET);
  });

  test("a trial past its days ends in the pass", () => {
    const trial = startHaikuTrial();
    routeRulesPass(store, REPO, at(91));
    expect(ruleById(store, trial)!.state).toBe("expired");
  });

  test("the evidence line says which trial task this is; Settings and the command line say the progress", async () => {
    const trial = startHaikuTrial();
    file("first");
    const id = file("second", { approveIt: true });
    expect(selectionEvidenceWords(store, JSON.parse(store.getScope(id)!.proposedRouteJson!) as never, T0)).toMatch(/^Trying a cheaper model: Claude Haiku 5\.5, trial 2 of 10\./);
    startBuild(id);
    expect(trialWords(store, trialsOf(store, REPO, T0)[0]!)).toBe("Trying Claude Haiku 5.5 instead of Claude Sonnet 5.5 on the next 10 small tasks: 2 of 10 so far (1 started, 1 waiting). A person approves each one.");
    const lines: string[] = [];
    const code = await runModelsCommand(["suggestions"], new Map<string, string | true>([["json", true], ["repo", REPO]]),
      { store, write: line => lines.push(line), json: true, now: T0, actor: "alex", proof: { actor: "alex", generation: store.accountOf("alex")!.generation, method: "password-now" } });
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ trials: [{ id: trial, state: "trialling", places: { limit: 10, consumed: 1, reserved: 1 } }] });
  });

  test("the command line starts with the person's proof and stops; a lead's proof is refused", async () => {
    const run = async (args: string[], method = "password-now") => {
      const lines: string[] = [];
      const code = await runModelsCommand(args, new Map<string, string | true>([["json", true], ["repo", REPO]]),
        { store, write: line => lines.push(line), json: true, now: T0, actor: "alex", proof: { actor: "alex", generation: store.accountOf("alex")!.generation, method } });
      return { code, body: JSON.parse(lines.join("\n")) as Record<string, unknown> };
    };
    const offer = ((await run(["suggestions"])).body["trialOffers"] as { id: string }[])[0]!;
    expect((await run(["try", offer.id], "lead-token")).body).toMatchObject({ ok: false, reason: "refused" });
    const started = await run(["try", offer.id]);
    expect(started.body).toMatchObject({ ok: true, size: "small", model: HAIKU, places: 10 });
    expect((await run(["stop", String(started.body["trial"])])).body).toMatchObject({ ok: true, state: "turned-off" });
  });
});

describe("the authority matrix", () => {
  const owner = (act: LocalOwnerAct): LocalPrincipal => ({ account: "alex", localGeneration: 1, accountGeneration: store.accountOf("alex")!.generation, transport: "terminal", act, sessionHash: null, request: null });
  const local: RuleDoor = { kind: "local-owner", actor: "alex" };

  test("a lead token or remote token never starts or stops a trial; a revoked generation refuses", () => {
    const [offer] = trialOffersFor(store, REPO, T0);
    const remote = { account: "alex", scope: "act", tokenName: "laptop", source: "api", secret: "s", allows: () => true, lens: null, noteTask: () => {}, files: {} } as unknown as RemoteRun;
    expect(withActor({ account: "alex", lead: true }, () => startTrial(store, { repo: REPO, id: offer!.id }, person(), T0))).toMatchObject({ reason: "lead-refused" });
    expect(withRemote(remote, () => startTrial(store, { repo: REPO, id: offer!.id }, person(), T0))).toMatchObject({ reason: "lead-refused" });
    for (const method of ["lead-token", "remote-token"]) expect(startTrial(store, { repo: REPO, id: offer!.id }, person({ method }), T0)).toMatchObject({ reason: "lead-refused" });
    expect(startTrial(store, { repo: REPO, id: offer!.id }, person({ generation: 99 }), T0)).toMatchObject({ reason: "authority" });
    expect(startTrial(store, { repo: REPO, id: offer!.id }, person({ method: "session" }), T0)).toMatchObject({ reason: "authority" });
    const trial = startHaikuTrial();
    expect(withActor({ account: "alex", lead: true }, () => stopTrial(store, trial, person(), T0))).toMatchObject({ reason: "lead-refused" });
    expect(stopTrial(store, trial, person({ method: "remote-token" }), T0)).toMatchObject({ reason: "lead-refused" });
    expect(ruleById(store, trial)!.state).toBe("trialling");
    expect(stopTrial(store, trial, person({ method: "session" }), T0)).toMatchObject({ ok: true });
  });

  test("the local owner stops only in its exact act, and never starts one", () => {
    store.close();
    store = openStore(join(dir, "laptop.db"), { createdBy: "laptop" });
    if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now: T0 }).ok) throw new Error("local mode");
    configure();
    const [offer] = trialOffersFor(store, REPO, T0);
    for (const act of ["read", "trial-stop", "routing-turn-off", "approve-plan"] as const) {
      expect(asLocalOwner(owner(act), () => startTrial(store, { repo: REPO, id: offer!.id }, local, T0))).toMatchObject({ ok: false, reason: "authority" });
    }
    const trial = startHaikuTrial();
    for (const act of ["read", "routing-turn-off", "dismiss-suggestion"] as const) expect(asLocalOwner(owner(act), () => stopTrial(store, trial, local, T0))).toMatchObject({ reason: "authority" });
    expect(stopTrial(store, trial, local, T0)).toMatchObject({ reason: "authority" });
    expect(asLocalOwner(owner("trial-stop"), () => stopTrial(store, trial, local, T0))).toMatchObject({ ok: true });
  });

  test("a trial and an earned rule never share a cohort", () => {
    startHaikuTrial();
    for (let one = 0; one < 10; one++) seed("claude-haiku-4-5", "mature", at(-3 + one / 24));
    recordCatalog(store, [{ source: "claude", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", inputUsd: 1, outputUsd: 5, context: null, tools: true, releasedAt: null },
      { source: "claude", id: SONNET, name: "Claude Sonnet 5.5", inputUsd: 3, outputUsd: 15, context: null, tools: true, releasedAt: null }], T0);
    expect(suggestionsFor(store, REPO, T0)).toEqual([]);
    store.handle.prepare("UPDATE route_rule SET state = 'turned-off' WHERE kind = 'trial'").run();
    const [offer] = suggestionsFor(store, REPO, T0);
    store.handle.prepare("UPDATE route_rule SET state = 'trialling' WHERE kind = 'trial'").run();
    expect(acceptSuggestion(store, { repo: REPO, id: offer!.id }, person(), T0)).toMatchObject({ ok: false, reason: "taken" });
  });
});
