/**
 * Earned rules (docs/plans/results-routing.md, slice 2): suggesting from a project's own records, accepting with the
 * bounded switch-back grant, the one precedence order, the configuration generations that pause a rule, the sealed
 * trigger that switches it off, held tasks, exposure and the authority matrix. Isolated databases only; records are
 * written through their one writer (route-store.ts saveResultRecord) so each case sets exactly the evidence it needs.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, BUILT_IN, RunAdmissionRefused, initLocalMode, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { recordCatalog } from "./model-catalog.js";
import { INSTALLATION_SCOPE } from "./agentconfig.js";
import { checkScope, effectiveRoutes } from "./model-choices.js";
import { legOf, recommendRoute, type RouteCandidates, type RouteInput } from "./phase-routing.js";
import { saveResultRecord, liveEarnedRules, ruleHoldOf, type RuleDoor } from "./route-store.js";
import type { RecordValue } from "./route-results.js";
import {
  acceptSuggestion, dependsOf, dismissSuggestion, grantFor, keepRule, routeRulesPass, ruleById, selectionEvidenceWords, setSuggestModels, suggestionsFor,
  switchOffIfTripped, tripOf, turnOffRule,
} from "./route-rules.js";
import { withActor } from "./actor.js";
import { withRemote, type RemoteRun } from "./remote-run.js";
import { asLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "./local-owner.js";
import { setPasswordless } from "./passwordless.js";
import { approveSetup, previewSetup } from "./control-setup.js";
import { runModelsCommand } from "./models-cli.js";

const T0 = new Date("2026-11-01T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const REPO = "/repo/shop";
const HAIKU = "claude-haiku-5-5", SONNET = "claude-sonnet-5-5", OPUS = "claude-opus-5-5";
let dir: string, store: Store, token: string, seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-route-rules-"));
  store = openStore(join(dir, "plane.db"));
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  token = alex.token;
  configure();
});
/** The project, Sized-by-job-like rows (small and routine tasks both build on Sonnet), and the listed prices. */
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
}
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const refOf = (id: string) => store.refFor(BUILT_IN, id).id;
const person = (over: Partial<{ method: string; generation: number; live: () => boolean; actor: string }> = {}): RuleDoor => ({
  kind: "person", person: { actor: "alex", generation: store.accountOf("alex")!.generation, method: "password-now", live: () => true, ...over },
});

/** One record of `model` in the small cohort, its family's first run at `when` (newest records sort first). */
function seed(model: string, state: RecordValue["state"], when: Date, size: "small" | "medium" = "small", reason: RecordValue["reason"] = null): string {
  const id = `rec-${++seq}`;
  store.createTask({ id, title: id }, T0);
  store.placeTask(refOf(id), REPO);
  saveResultRecord(store, {
    taskRef: refOf(id), task: id, repo: REPO, cohortSize: size, provider: "claude", model, state,
    reason: reason ?? (state === "rejected" ? "check-failed" : state === "not-counted" ? "no-check" : null), resultRun: null, firstStartedAt: when.toISOString(),
    acceptedAt: null, decidedAt: null, modelFailures: 0, infraFailures: 0, apiMicrousd: 400_000, subscriptionRuns: 0, subscriptionTokens: 0, unknownRuns: 0,
    remediationRuns: 0, selections: [], settled: state === "mature" || state === "rejected", personRevisions: 0, firstCheckPassed: null, agentTurns: 0, turnsUnknownRuns: 0,
    accumulationEnded: false,
  }, when);
  return id;
}
/** `n` decided records of a model, oldest first, one hour apart, from `from` days. */
function seedMany(model: string, states: readonly RecordValue["state"][], from = -30, size: "small" | "medium" = "small"): void {
  states.forEach((state, index) => seed(model, state, new Date(at(from).getTime() + index * 3_600_000), size));
}
const mature = (n: number) => Array<RecordValue["state"]>(n).fill("mature");

/** A small task filed and approved now, under whatever routes it. */
function file(id: string, size: "small" | "medium" | "large" = "small", options: { touches?: string[]; approveIt?: boolean; when?: Date } = {}): string {
  const when = options.when ?? T0;
  store.createTask({ id, title: id }, when);
  store.placeTask(refOf(id), REPO);
  store.writeSizing(refOf(id), { size, risky: false, source: "person", reason: "set by the test" });
  propose(store, { taskId: id, goal: "Round payouts to the cent", touches: options.touches ?? [], now: when });
  if (options.approveIt !== false && !approve(store, id, "alex", when, store.getScope(id)!.digest, token).ok) throw new Error(`approve ${id}`);
  return id;
}
const proposedBuild = (id: string) => legOf(JSON.parse(store.getScope(id)!.proposedRouteJson!) as never, "build") as unknown as { model: string; selection?: { kind: string; rule: number } };

function acceptHaiku(): number {
  seedMany(HAIKU, mature(10));
  const [offer] = suggestionsFor(store, REPO, T0);
  if (offer === undefined) throw new Error("no suggestion");
  const accepted = acceptSuggestion(store, { repo: REPO, id: offer.id }, person(), T0);
  if (!accepted.ok) throw new Error(accepted.problem);
  return accepted.rule;
}

describe("suggestions: the thresholds", () => {
  test("10 decided at ≥ 90% mature, clean last 3, cheaper on both prices: suggested once per size", () => {
    seedMany(HAIKU, mature(9));
    expect(suggestionsFor(store, REPO, T0)).toEqual([]);
    seed(HAIKU, "mature", at(-1));
    const [offer, ...rest] = suggestionsFor(store, REPO, T0);
    expect(rest).toEqual([]);
    expect(offer).toMatchObject({ cohortSize: "small", model: HAIKU, configured: { model: SONNET }, evidence: { decided: 10, mature: 10 } });
    expect(offer!.prices).toEqual({ model: { in: 1, out: 5 }, configured: { in: 3, out: 15 } });
  });

  test("9 of 10 mature is the edge; a rejection among the latest 3 never suggests", () => {
    seedMany(HAIKU, ["rejected", ...mature(9)]);
    expect(suggestionsFor(store, REPO, T0)).toHaveLength(1);
    seed(HAIKU, "rejected", at(-1));
    expect(suggestionsFor(store, REPO, T0)).toEqual([]);
  });

  test("8 of 10 is not enough", () => {
    seedMany(HAIKU, ["rejected", "rejected", ...mature(8)]);
    expect(suggestionsFor(store, REPO, T0)).toEqual([]);
  });

  test("the configured model doing more than 5 points better, too many not counted, or no cheaper price: no suggestion", () => {
    seedMany(HAIKU, ["rejected", ...mature(9)], -40);
    seedMany(SONNET, mature(10), -60);
    expect(suggestionsFor(store, REPO, T0)).toEqual([]);
  });

  test("more than a third not counted refuses; a missing price refuses", () => {
    seedMany(HAIKU, mature(10));
    for (let one = 0; one < 6; one++) seed(HAIKU, "not-counted", at(-50 + one));
    expect(suggestionsFor(store, REPO, T0)).toEqual([]);
  });

  test("a model with no listed price, or not cheaper on both, is never suggested", () => {
    seedMany(OPUS, mature(10));
    expect(suggestionsFor(store, REPO, T0)).toEqual([]);
  });

  test("pending and provisional records are never decided", () => {
    seedMany(HAIKU, [...mature(9), "pending", "provisional", "pending"]);
    expect(suggestionsFor(store, REPO, T0)).toEqual([]);
  });

  test("the project's switch off, or Not now within 30 days, keeps it quiet", () => {
    seedMany(HAIKU, mature(10));
    const [offer] = suggestionsFor(store, REPO, T0);
    expect(dismissSuggestion(store, { repo: REPO, id: offer!.id }, person(), T0)).toEqual({ ok: true });
    expect(suggestionsFor(store, REPO, at(29))).toEqual([]);
    expect(suggestionsFor(store, REPO, at(31)).length).toBeLessThanOrEqual(1);
    expect(setSuggestModels(store, REPO, false, person())).toEqual({ ok: true });
    expect(suggestionsFor(store, REPO, at(31))).toEqual([]);
    expect(setSuggestModels(store, REPO, true, person())).toEqual({ ok: true });
  });
});

describe("accepting", () => {
  test("seals the grant and the price snapshot; a new small task routes to Haiku with the rule sealed in a v3 route", () => {
    const rule = acceptHaiku();
    const row = ruleById(store, rule)!;
    expect(row).toMatchObject({ state: "active", model: HAIKU, configured: { provider: "claude", model: SONNET }, acceptedBy: "alex" });
    expect(row.grant).toEqual(grantFor(T0));
    const id = file("after-accept", "small", { approveIt: false });
    const route = JSON.parse(store.getScope(id)!.proposedRouteJson!);
    expect(route.version).toBe(3);
    expect(proposedBuild(id)).toMatchObject({ model: HAIKU, selection: { kind: "rule", rule, ruleGeneration: 1 } });
    expect(selectionEvidenceWords(store, store.getScope(id) && JSON.parse(store.getScope(id)!.proposedRouteJson!), T0)).toContain("Why this model: Claude Haiku 5.5 builds small tasks in this project. So far, 10 of the last 10");
    // A medium task is another cohort: untouched.
    expect(proposedBuild(file("medium-one", "medium", { approveIt: false }))).toMatchObject({ model: SONNET });
    expect(proposedBuild(file("medium-one-b", "medium", { approveIt: false })).selection).toBeUndefined();
  });

  test("a stale offer, a changed price, a changed configuration and a taken size each refuse by name", () => {
    seedMany(HAIKU, mature(10));
    const [offer] = suggestionsFor(store, REPO, T0);
    seed(HAIKU, "mature", at(-1));
    expect(acceptSuggestion(store, { repo: REPO, id: offer!.id }, person(), T0)).toMatchObject({ ok: false, reason: "stale-suggestion" });
    const [fresh] = suggestionsFor(store, REPO, T0);
    recordCatalog(store, [{ source: "claude", id: HAIKU, name: "Claude Haiku 5.5", inputUsd: 1.5, outputUsd: 5, context: null, tools: true, releasedAt: null },
      { source: "claude", id: SONNET, name: "Claude Sonnet 5.5", inputUsd: 3, outputUsd: 15, context: null, tools: true, releasedAt: null },
      { source: "claude", id: OPUS, name: "Claude Opus 5.5", inputUsd: 5, outputUsd: 25, context: null, tools: true, releasedAt: null }], T0);
    expect(acceptSuggestion(store, { repo: REPO, id: fresh!.id }, person(), T0)).toMatchObject({ ok: false, reason: "price-changed" });
    const [priced] = suggestionsFor(store, REPO, T0);
    store.setPhaseConfig(REPO, "review", "claude", SONNET, "alex", T0);
    store.setPhaseConfig(REPO, "repair", "claude", SONNET, "alex", T0);
    expect(acceptSuggestion(store, { repo: REPO, id: priced!.id }, person(), T0)).toMatchObject({ ok: false, reason: "config-changed" });
    const [current] = suggestionsFor(store, REPO, T0);
    expect(acceptSuggestion(store, { repo: REPO, id: current!.id }, person(), T0)).toMatchObject({ ok: true });
    expect(acceptSuggestion(store, { repo: REPO, id: current!.id }, person(), T0)).toMatchObject({ ok: false, reason: "taken" });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM route_rule WHERE state = 'active'").get()?.["n"]).toBe(1);
  });

  test("a configured repair row on another provider refuses the rule (repairs resume the builder's session)", () => {
    seedMany(HAIKU, mature(10));
    store.setPhaseConfig(REPO, "build", "codex", "gpt-6-sol", "alex", T0);
    store.setPhaseTierConfig(REPO, "build", "light", "codex", "gpt-6-luna", "alex", T0);
    store.setPhaseConfig(REPO, "repair", "codex", "gpt-6-sol", "alex", T0);
    // The configured builder isn't Claude any more: nothing to suggest.
    expect(suggestionsFor(store, REPO, T0)).toEqual([]);
    const candidate = { id: 1, generation: 1, cohortSize: "small" as const, provider: "claude" as const, model: HAIKU, configured: { provider: "claude", model: SONNET } };
    expect(checkScope(store, REPO, { rules: [candidate] })).toMatchObject({ kind: "invalid", problem: expect.stringContaining("Repairs must use the builder's provider (claude)") });
  });
});

describe("the one precedence order", () => {
  const candidates: RouteCandidates = {
    plan: { routine: { provider: "claude", model: OPUS, source: "t" }, strong: null },
    build: { light: { provider: "claude", model: SONNET, source: "t" }, routine: { provider: "claude", model: SONNET, source: "t" }, strong: { provider: "claude", model: OPUS, source: "t" },
      alternates: { light: [{ provider: "codex", model: "gpt-6-luna", source: "t" }] } },
    repair: { routine: null, strong: null },
    review: { routine: { provider: "claude", model: OPUS, source: "t" }, strong: null },
  };
  const rule = { id: 7, generation: 2, cohortSize: "small" as const, provider: "claude" as const, model: HAIKU, configured: { provider: "claude", model: SONNET } };
  const base = (over: Partial<RouteInput> = {}): RouteInput => ({ qualityMode: "default", evidence: [], publication: "none", candidates, overrides: [],
    size: { size: "small", risky: false, source: "person", reason: "" }, earned: { rules: [rule], release: false, protected: false }, ...over });
  const build = (over: Partial<RouteInput> = {}) => legOf(recommendRoute(base(over)), "build");

  test("rule beats configured; the repair follows the rule's builder; the route seals as version 3", () => {
    const route = recommendRoute(base());
    expect(route.version).toBe(3);
    expect(legOf(route, "build")).toMatchObject({ model: HAIKU, chosen: "recommended", selection: { kind: "rule", rule: 7, ruleGeneration: 2 } });
    expect(legOf(route, "repair")).toMatchObject({ provider: "claude", model: HAIKU });
  });
  test("pin and override beat the rule, with version 2 bytes", () => {
    expect(build({ pins: { build: { provider: "claude", model: OPUS } } })).toMatchObject({ model: OPUS, chosen: "pinned" });
    expect(build({ overrides: [{ phase: "build", provider: "claude", model: OPUS, by: "alex", at: T0.toISOString() }] })).toMatchObject({ model: OPUS, chosen: "override" });
    expect(recommendRoute(base({ pins: { build: { provider: "claude", model: OPUS } } })).version).toBe(2);
  });
  test("past the headroom limits the rule is skipped and says so; headroom then moves only the configured leg", () => {
    const leg = build({ headroom: [{ provider: "claude", fiveHour: 95, weekly: 10 }, { provider: "codex", fiveHour: 5, weekly: 5 }] });
    expect(leg.selection).toBeUndefined();
    expect(leg.provider).toBe("codex");
    expect(leg.reasons.at(-1)).toContain("earned rule skipped for this filing: claude has used 95% of its 5-hour window");
  });
  test("large, risky, strict, screenshots, automerge, release and protected tasks are untouched", () => {
    expect(build({ size: { size: "large", risky: false, source: "person", reason: "" } }).selection).toBeUndefined();
    expect(build({ size: { size: "small", risky: true, source: "person", reason: "" } }).selection).toBeUndefined();
    expect(build({ qualityMode: "strict" }).selection).toBeUndefined();
    expect(build({ evidence: ["screenshot"] }).selection).toBeUndefined();
    expect(build({ publication: "automerge" }).selection).toBeUndefined();
    expect(build({ earned: { rules: [rule], release: true, protected: false } }).selection).toBeUndefined();
    expect(build({ earned: { rules: [rule], release: false, protected: true } }).selection).toBeUndefined();
    expect(build({ earned: { rules: [{ ...rule, cohortSize: "medium" }], release: false, protected: false } }).selection).toBeUndefined();
  });
  test("a rule earned against another configured builder never applies", () => {
    const leg = build({ earned: { rules: [{ ...rule, configured: { provider: "claude", model: OPUS } }], release: false, protected: false } });
    expect(leg).toMatchObject({ model: SONNET });
    expect(leg.selection).toBeUndefined();
  });
  test("Models previews show the rule; the preset reads the configured rows", () => {
    acceptHaiku();
    const routes = effectiveRoutes(store, REPO);
    if (!routes.ok) throw new Error(routes.problem);
    expect(legOf(routes.routes.find(one => one.label === "small")!.route, "build")).toMatchObject({ model: HAIKU, selection: { kind: "rule" } });
    expect(legOf(routes.routes.find(one => one.label === "routine")!.route, "build").model).toBe(SONNET);
    const configured = effectiveRoutes(store, REPO, { rules: false });
    if (!configured.ok) throw new Error(configured.problem);
    expect(legOf(configured.routes.find(one => one.label === "small")!.route, "build").model).toBe(SONNET);
  });
});

describe("configuration generations pause a rule", () => {
  test("a change away and back pauses (the generation moved twice)", () => {
    const rule = acceptHaiku();
    store.setPhaseTierConfig(INSTALLATION_SCOPE, "build", "light", "claude", OPUS, "alex", T0);
    store.setPhaseTierConfig(INSTALLATION_SCOPE, "build", "light", "claude", SONNET, "alex", T0);
    expect(ruleById(store, rule)!.state).toBe("paused");
    expect(liveEarnedRules(store, REPO)).toEqual([]);
    expect(proposedBuild(file("while-paused", "small", { approveIt: false })).model).toBe(SONNET);
    // Keep: live again on the configuration as it stands, its sealed terms unchanged.
    expect(keepRule(store, rule, person(), T0)).toMatchObject({ ok: true, rule: { state: "active" } });
    expect(ruleById(store, rule)!.grant).toEqual(grantFor(T0));
  });

  test("a control-setup write pauses dependent rules", () => {
    const rule = acceptHaiku();
    const inputs = { provider: "claude", model: OPUS, command: "", seconds: "60" };
    const preview = previewSetup(store, REPO, inputs);
    if (!preview.ok) throw new Error(preview.message);
    expect(approveSetup(store, REPO, inputs, preview.fingerprint, "alex", token, T0)).toEqual({ ok: true });
    expect(ruleById(store, rule)!.state).toBe("paused");
  });

  test("a paused rule whose configured builder changed can't be kept, and refuses in words", () => {
    const rule = acceptHaiku();
    store.setPhaseTierConfig(INSTALLATION_SCOPE, "build", "light", "claude", OPUS, "alex", T0);
    expect(keepRule(store, rule, person(), T0)).toMatchObject({ ok: false, reason: "config-changed" });
    expect(turnOffRule(store, rule, person(), T0)).toMatchObject({ ok: true, rule: { state: "dropped" } });
  });
});

describe("switching off", () => {
  test("the trigger reads decided records only, newest first, with the sealed terms", () => {
    const grant = grantFor(T0);
    expect(tripOf(grant, [], [])).toEqual({ trips: false });
    expect(tripOf(grant, ["rejected", "mature", "mature", "mature", "mature", "rejected"], []).trips).toBe(false);
    expect(tripOf(grant, ["rejected", "mature", "rejected"], [])).toMatchObject({ trips: true, why: "2 of the latest 3 decided tasks were rejected" });
    expect(tripOf(grant, ["mature", "mature", "mature", "mature", "mature", "rejected", "mature", "rejected", "mature", "mature", "mature"], []).trips).toBe(false);
    expect(tripOf(grant, ["mature", "mature", "mature", "mature", "mature", "mature", "rejected", "rejected", "rejected", "mature"], []).trips).toBe(true);
    expect(tripOf(grant, [], [true, false, true, false, true])).toMatchObject({ trips: true, why: "3 of the latest 5 approvals picked another model" });
    expect(tripOf(grant, [], [false, true, true, ...Array(8).fill(false), true]).trips).toBe(false);
  });

  test("ten started tasks with pending results trigger nothing; two rejected after the cutoff switch it off", () => {
    const rule = acceptHaiku();
    for (let one = 0; one < 10; one++) seed(HAIKU, "pending", at(1 + one / 24));
    expect(switchOffIfTripped(store, rule, at(2))).toEqual({ outcome: "kept", why: null });
    // Records from before the grant's cutoff never count toward it.
    seed(HAIKU, "rejected", at(-2));
    seed(HAIKU, "rejected", at(-3));
    expect(switchOffIfTripped(store, rule, at(2)).outcome).toBe("kept");
    seed(HAIKU, "rejected", at(3));
    seed(HAIKU, "rejected", at(3.1));
    expect(switchOffIfTripped(store, rule, at(4))).toEqual({ outcome: "switched-off", why: "2 of the latest 2 decided tasks were rejected" });
    expect(ruleById(store, rule)).toMatchObject({ state: "switched-off", endReason: "2 of the latest 2 decided tasks were rejected" });
    expect(proposedBuild(file("after-off", "small", { approveIt: false, when: at(4) })).model).toBe(SONNET);
  });

  test("ordering is deterministic: same start time sorts by task id", () => {
    const rule = acceptHaiku();
    const when = at(2);
    seed(HAIKU, "rejected", when);
    seed(HAIKU, "mature", when);
    seed(HAIKU, "rejected", when);
    expect(switchOffIfTripped(store, rule, at(3)).outcome).toBe("switched-off");
  });

  test("an ended grant expires the rule; a grant by an account that's gone pauses it", () => {
    const rule = acceptHaiku();
    expect(switchOffIfTripped(store, rule, at(91))).toMatchObject({ outcome: "expired" });
    expect(ruleById(store, rule)!.state).toBe("expired");
  });

  test("a switch-off racing a config write: one wins, and a rule is never switched off on stale evidence", () => {
    // The config write first: the rule pauses, and the switch-off finds it moved.
    const first = acceptHaiku();
    seed(HAIKU, "rejected", at(1));
    seed(HAIKU, "rejected", at(1.1));
    const other = openStore(join(dir, "plane.db"));
    try {
      other.setPhaseConfig(INSTALLATION_SCOPE, "repair", "claude", SONNET, "alex", T0);
      expect(switchOffIfTripped(store, first, at(2))).toEqual({ outcome: "moved", why: null });
      expect(ruleById(store, first)!.state).toBe("paused");
      // A generation that moved without the pause (a stale connection's view): the check pauses, never switches off.
      expect(turnOffRule(store, first, person(), T0)).toMatchObject({ ok: true });
      const second = store.handle.prepare(`INSERT INTO route_rule (repo, cohort_size, kind, provider, model, configured_provider, configured_model, state, generation, grant_json, prices_json, depends_json, accepted_by, accepted_at)
        VALUES (?, 'small', 'rule', 'claude', ?, 'claude', ?, 'active', 1, ?, '{}', ?, 'alex', ?)`).run(REPO, HAIKU, SONNET, JSON.stringify(grantFor(T0)), JSON.stringify({ "installation|build": 0 }), T0.toISOString()).lastInsertRowid;
      expect(switchOffIfTripped(store, Number(second), at(2))).toEqual({ outcome: "paused", why: "config-changed" });
      // The switch-off first: the config write afterwards finds nothing live to pause.
      store.handle.prepare("DELETE FROM route_rule").run();
      const third = Number(store.handle.prepare(`INSERT INTO route_rule (repo, cohort_size, kind, provider, model, configured_provider, configured_model, state, generation, grant_json, prices_json, depends_json, accepted_by, accepted_at)
        VALUES (?, 'small', 'rule', 'claude', ?, 'claude', ?, 'active', 1, ?, '{}', ?, 'alex', ?)`).run(REPO, HAIKU, SONNET, JSON.stringify(grantFor(T0)), JSON.stringify(dependsOf(store, REPO)), T0.toISOString()).lastInsertRowid);
      expect(switchOffIfTripped(store, third, at(2)).outcome).toBe("switched-off");
      other.setPhaseConfig(INSTALLATION_SCOPE, "repair", "claude", OPUS, "alex", T0);
      expect(ruleById(store, third)!.state).toBe("switched-off");
    } finally { other.close(); }
  });
});

describe("held tasks", () => {
  function startBuild(id: string): number {
    const authority = store.routeAuthorityFor(refOf(id), "builder");
    if (authority === null || !authority.ok) throw new Error(`no route for ${id}`);
    return store.startRun({ taskRef: refOf(id), leaseId: `lease-${++seq}`, runner: "worker", branch: `standing-orders/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: at(4) });
  }

  test("a task approved under a rule that switched itself off is refused at admission with no strike; the pass holds and re-files it", () => {
    const rule = acceptHaiku();
    const id = file("approved-then-off");
    seed(HAIKU, "rejected", at(1));
    seed(HAIKU, "rejected", at(1.1));
    expect(switchOffIfTripped(store, rule, at(2)).outcome).toBe("switched-off");
    expect(ruleHoldOf(store, id)).toEqual({ rule, model: HAIKU });
    const strikes = store.refForId(refOf(id))!.strikes;
    expect(() => startBuild(id)).toThrow(RunAdmissionRefused);
    expect(() => startBuild(id)).toThrow(/rule-switched-off/);
    expect(store.runsFor(refOf(id))).toEqual([]);
    expect(store.refForId(refOf(id))!.strikes).toBe(strikes);
    const pass = routeRulesPass(store, REPO, at(2));
    expect(pass).toMatchObject({ held: 1, refiled: 1 });
    expect(store.activeHolds(refOf(id), at(2)).map(one => one.reason)).toEqual(["Results for Claude Haiku 5.5 dropped after you approved this. Approve it again or re-file it."]);
    // Re-filed on the configured builder: approving again lifts the hold and builds on Sonnet.
    expect(proposedBuild(id).model).toBe(SONNET);
    expect(approve(store, id, "alex", at(2), store.getScope(id)!.digest, token).ok).toBe(true);
    expect(store.activeHolds(refOf(id), at(2))).toEqual([]);
    expect(store.getRun(startBuild(id))!.model).toBe(SONNET);
    // Needs you heard about it.
    expect(store.handle.prepare("SELECT subject FROM notification WHERE dedupe_key = ?").get(`route-rule-off:${rule}`)?.["subject"]).toBe("Claude Haiku 5.5 switched itself off for small tasks");
  });

  test("a rule a person turned off keeps the sealed model of tasks already approved", () => {
    const rule = acceptHaiku();
    const id = file("approved-then-turned-off");
    expect(turnOffRule(store, rule, person(), T0)).toMatchObject({ ok: true, rule: { state: "turned-off" } });
    expect(ruleHoldOf(store, id)).toBeNull();
    expect(store.getRun(startBuild(id))!.model).toBe(HAIKU);
    expect(routeRulesPass(store, REPO, at(1))).toMatchObject({ held: 0 });
  });

  test("a plan still waiting under a rule that's no longer live is re-filed on the configured builder", () => {
    const rule = acceptHaiku();
    const id = file("waiting", "small", { approveIt: false });
    expect(proposedBuild(id).model).toBe(HAIKU);
    turnOffRule(store, rule, person(), T0);
    expect(routeRulesPass(store, REPO, at(1))).toMatchObject({ refiled: 1 });
    expect(proposedBuild(id).model).toBe(SONNET);
  });
});

describe("exposure", () => {
  const events = (id: string) => store.handle.prepare(`SELECT ev.kind, ev.model FROM route_exposure_event ev JOIN route_exposure e ON e.id = ev.exposure WHERE e.task_ref = ? ORDER BY ev.id`)
    .all(refOf(id)).map(one => `${String(one["kind"])}${one["model"] == null ? "" : `:${String(one["model"])}`}`);

  test("re-filing five times is one exposure; the approval closes it as proposed", () => {
    acceptHaiku();
    const id = file("refiled", "small", { approveIt: false });
    for (let one = 0; one < 5; one++) store.refileScope(id, at(one / 24));
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM route_exposure WHERE task_ref = ?").get(refOf(id))?.["n"]).toBe(1);
    expect(approve(store, id, "alex", T0, store.getScope(id)!.digest, token).ok).toBe(true);
    expect(events(id)).toEqual(["proposed", "refiled", "refiled", "refiled", "refiled", "refiled", "approved-as-proposed"]);
  });

  test("a person who picks another model closes it as approved with that model; a cancel closes it too", () => {
    acceptHaiku();
    const id = file("other-model", "small", { approveIt: false });
    const edited = store.editTaskRoute(refOf(id), { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "build", provider: "claude", model: OPUS } }, T0);
    expect(edited.ok).toBe(true);
    expect(approve(store, id, "alex", T0, store.getScope(id)!.digest, token).ok).toBe(true);
    expect(events(id)).toEqual(["proposed", "refiled", `approved-with-other:${OPUS}`]);
    const cancelled = file("cancelled", "small", { approveIt: false });
    store.applyCancellation(cancelled, { kind: "operator", text: null }, T0, null);
    expect(events(cancelled)).toEqual(["proposed", "cancelled"]);
  });

  test("three of the latest ten approvals with another model switch the rule off", () => {
    const rule = acceptHaiku();
    for (let one = 0; one < 3; one++) {
      const id = file(`declined-${one}`, "small", { approveIt: false });
      store.editTaskRoute(refOf(id), { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "build", provider: "claude", model: OPUS } }, T0);
      approve(store, id, "alex", T0, store.getScope(id)!.digest, token);
    }
    expect(switchOffIfTripped(store, rule, at(1))).toEqual({ outcome: "switched-off", why: "3 of the latest 3 approvals picked another model" });
  });
});

describe("the authority matrix", () => {
  const remote = (account: string): RemoteRun => ({ account, scope: "act", tokenName: "laptop", source: "api", secret: "s", allows: () => true, lens: null, noteTask: () => {}, files: {} } as unknown as RemoteRun);
  const owner = (act: LocalOwnerAct): LocalPrincipal => ({ account: "alex", localGeneration: 1, accountGeneration: store.accountOf("alex")!.generation, transport: "terminal", act, sessionHash: null, request: null });
  const local: RuleDoor = { kind: "local-owner", actor: "alex" };

  test("a person with a step-up accepts; a lead token and a remote token are refused in the writer", () => {
    seedMany(HAIKU, mature(10));
    const [offer] = suggestionsFor(store, REPO, T0);
    expect(withActor({ account: "alex", lead: true }, () => acceptSuggestion(store, { repo: REPO, id: offer!.id }, person(), T0))).toMatchObject({ ok: false, reason: "lead-refused" });
    expect(withRemote(remote("alex"), () => acceptSuggestion(store, { repo: REPO, id: offer!.id }, person(), T0))).toMatchObject({ ok: false, reason: "lead-refused" });
    expect(acceptSuggestion(store, { repo: REPO, id: offer!.id }, person({ method: "lead-token" }), T0)).toMatchObject({ ok: false, reason: "lead-refused" });
    expect(acceptSuggestion(store, { repo: REPO, id: offer!.id }, person({ method: "remote-token" }), T0)).toMatchObject({ ok: false, reason: "lead-refused" });
    expect(acceptSuggestion(store, { repo: REPO, id: offer!.id }, person({ generation: 99 }), T0)).toMatchObject({ ok: false, reason: "authority" });
    expect(acceptSuggestion(store, { repo: REPO, id: offer!.id }, person({ live: () => false }), T0)).toMatchObject({ ok: false, reason: "authority" });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM route_rule").get()?.["n"]).toBe(0);
  });

  test("Passwordless off: a session alone can't accept; on, it can. Turning off takes a session either way", () => {
    seedMany(HAIKU, mature(10));
    const [offer] = suggestionsFor(store, REPO, T0);
    expect(acceptSuggestion(store, { repo: REPO, id: offer!.id }, person({ method: "session" }), T0)).toMatchObject({ ok: false, reason: "authority" });
    setPasswordless(store, true, "alex", T0);
    const accepted = acceptSuggestion(store, { repo: REPO, id: offer!.id }, person({ method: "session" }), T0);
    expect(accepted).toMatchObject({ ok: true });
    setPasswordless(store, false, "alex", T0);
    expect(turnOffRule(store, (accepted as { rule: number }).rule, person({ method: "session" }), T0)).toMatchObject({ ok: true });
  });

  test("the local owner: only the exact act, and never a raising one", () => {
    // A laptop install: its owner, in local mode.
    store.close();
    store = openStore(join(dir, "laptop.db"), { createdBy: "laptop" });
    if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now: T0 }).ok) throw new Error("local mode");
    configure();
    const rule = acceptHaiku();
    expect(asLocalOwner(owner("read"), () => turnOffRule(store, rule, local, T0))).toMatchObject({ ok: false, reason: "authority" });
    expect(asLocalOwner(owner("dismiss-suggestion"), () => turnOffRule(store, rule, local, T0))).toMatchObject({ ok: false, reason: "authority" });
    expect(turnOffRule(store, rule, local, T0)).toMatchObject({ ok: false, reason: "authority" });
    expect(asLocalOwner(owner("routing-turn-off"), () => turnOffRule(store, rule, local, T0))).toMatchObject({ ok: true });
    seed(HAIKU, "mature", at(-0.5));
    const [offer] = suggestionsFor(store, REPO, T0);
    expect(asLocalOwner(owner("routing-turn-off"), () => acceptSuggestion(store, { repo: REPO, id: offer!.id }, local, T0))).toMatchObject({ ok: false, reason: "authority" });
    expect(asLocalOwner(owner("routing-turn-off"), () => dismissSuggestion(store, { repo: REPO, id: offer!.id }, local, T0))).toMatchObject({ ok: false, reason: "authority" });
    expect(asLocalOwner(owner("dismiss-suggestion"), () => dismissSuggestion(store, { repo: REPO, id: offer!.id }, local, T0))).toEqual({ ok: true });
    expect(asLocalOwner(owner("dismiss-suggestion"), () => setSuggestModels(store, REPO, false, local))).toEqual({ ok: true });
    expect(asLocalOwner(owner("dismiss-suggestion"), () => setSuggestModels(store, REPO, true, local))).toMatchObject({ ok: false, reason: "authority" });
  });
});

describe("the command line", () => {
  const run = async (args: string[], proof: { actor: string; generation: number; method: string } | null = { actor: "alex", generation: store.accountOf("alex")!.generation, method: "password-now" }) => {
    const lines: string[] = [];
    const code = await runModelsCommand(args, new Map<string, string | true>([["json", true], ["repo", REPO]]), { store, write: line => lines.push(line), json: true, now: T0, actor: proof?.actor ?? null, proof });
    return { code, body: JSON.parse(lines.join("\n")) as Record<string, unknown> };
  };
  test("suggestions, accept, turn-off and keep say the same as Settings; a lead's proof is refused", async () => {
    seedMany(HAIKU, mature(10));
    const listed = await run(["suggestions"]);
    const [offer] = listed.body["suggestions"] as { id: string; words: string }[];
    expect(offer!.words).toContain("10 of the last 10 decided similar tasks were accepted with checks passing");
    expect((await run(["accept", offer!.id], { actor: "alex", generation: store.accountOf("alex")!.generation, method: "lead-token" })).body).toMatchObject({ ok: false, reason: "refused" });
    const accepted = await run(["accept", offer!.id]);
    expect(accepted.body).toMatchObject({ ok: true, size: "small", model: HAIKU });
    const rule = accepted.body["rule"] as number;
    expect((await run(["suggestions"])).body).toMatchObject({ suggestions: [], rules: [{ id: rule, state: "active" }] });
    expect((await run(["turn-off", String(rule)])).body).toMatchObject({ ok: true, state: "turned-off" });
    expect((await run(["accept", offer!.id], null)).body).toMatchObject({ ok: false, reason: "unauthenticated" });
  });
});
