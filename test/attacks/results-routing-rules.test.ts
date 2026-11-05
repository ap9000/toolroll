/**
 * Attack: route a cheaper model around a person (docs/plans/results-routing.md, slice 2: Authority and Protection).
 * Guards: route-store.ts proveRuleDoor, re-run inside every rule write (a lead token or a remote API token is refused,
 * a local owner only in its exact lowering act, a person re-proved at their credential generation); the offer's three
 * digests (a stale offer refuses by name); the generation compare-and-swap (a switch-off never lands on terms that
 * moved); and the admission hold (a task approved under a rule that switched itself off never starts, with no strike).
 * Each attack runs against a real plane database.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, BUILT_IN, initLocalMode, RunAdmissionRefused, type Store } from "../../src/store.js";
import { addApprover, approve, propose } from "../../src/scope.js";
import { recordCatalog } from "../../src/model-catalog.js";
import { INSTALLATION_SCOPE } from "../../src/agentconfig.js";
import { endRuleByDoor, insertEarnedRule, proveRuleDoor, saveResultRecord, type RuleDoor } from "../../src/route-store.js";
import { acceptSuggestion, ruleById, suggestionsFor, switchOffIfTripped, turnOffRule } from "../../src/route-rules.js";
import type { RecordValue } from "../../src/route-results.js";
import { withActor } from "../../src/actor.js";
import { withRemote, type RemoteRun } from "../../src/remote-run.js";
import { asLocalOwner, type LocalOwnerAct } from "../../src/local-owner.js";

const T0 = new Date("2026-11-01T12:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * 86_400_000);
const REPO = "/repo/shop";
const HAIKU = "claude-haiku-5-5", SONNET = "claude-sonnet-5-5";
let dir: string, store: Store, seq = 0;

function world(laptop: boolean): string {
  store = openStore(join(dir, laptop ? "laptop.db" : "plane.db"), laptop ? { createdBy: "laptop" } : {});
  let token = "";
  if (laptop) { if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now: T0 }).ok) throw new Error("local"); }
  else { const alex = addApprover(store, "alex", T0); if (!alex.ok) throw new Error("alex"); token = alex.token; }
  store.upsertProject(REPO, "shop", T0);
  for (const phase of ["plan", "review"] as const) store.setPhaseConfig(INSTALLATION_SCOPE, phase, "claude", "claude-opus-5-5", "alex", T0);
  store.setPhaseConfig(INSTALLATION_SCOPE, "build", "claude", SONNET, "alex", T0);
  store.setPhaseTierConfig(INSTALLATION_SCOPE, "build", "light", "claude", SONNET, "alex", T0);
  recordCatalog(store, [{ source: "claude", id: HAIKU, name: "Claude Haiku 5.5", inputUsd: 1, outputUsd: 5, context: null, tools: true, releasedAt: null },
    { source: "claude", id: SONNET, name: "Claude Sonnet 5.5", inputUsd: 3, outputUsd: 15, context: null, tools: true, releasedAt: null }], T0);
  for (let one = 0; one < 10; one++) record("mature", new Date(at(-20).getTime() + one * 3_600_000));
  return token;
}
function record(state: RecordValue["state"], when: Date): void {
  const id = `rec-${++seq}`;
  store.createTask({ id, title: id }, T0);
  const ref = store.refFor(BUILT_IN, id).id;
  store.placeTask(ref, REPO);
  saveResultRecord(store, { taskRef: ref, task: id, repo: REPO, cohortSize: "small", provider: "claude", model: HAIKU, state, reason: state === "rejected" ? "check-failed" : null,
    resultRun: null, firstStartedAt: when.toISOString(), acceptedAt: null, decidedAt: null, modelFailures: 0, infraFailures: 0, apiMicrousd: 0, subscriptionRuns: 0, subscriptionTokens: 0,
    unknownRuns: 0, remediationRuns: 0, selections: [], settled: state !== "pending", personRevisions: 0, firstCheckPassed: null, agentTurns: 0, turnsUnknownRuns: 0, accumulationEnded: false }, when);
}
const person = (over: Partial<{ method: string; generation: number }> = {}): RuleDoor => ({ kind: "person", person: { actor: "alex", generation: store.accountOf("alex")!.generation, method: "password-now", live: () => true, ...over } });
const offerId = () => suggestionsFor(store, REPO, T0)[0]!.id;
const rules = () => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM route_rule").get()?.["n"]);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "so-rr-attack-")); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("a lead or a remote token never changes which models run", () => {
  test("under the lead's own actor, a remote run, or a lead/remote proof method: refused in the writer, nothing written", () => {
    world(false);
    const remote = { account: "alex", scope: "act", tokenName: "laptop", source: "api", secret: "s", allows: () => true, lens: null, noteTask: () => {}, files: {} } as unknown as RemoteRun;
    const id = offerId();
    expect(withActor({ account: "alex", lead: true }, () => acceptSuggestion(store, { repo: REPO, id }, person(), T0))).toMatchObject({ reason: "lead-refused" });
    expect(withRemote(remote, () => acceptSuggestion(store, { repo: REPO, id }, person(), T0))).toMatchObject({ reason: "lead-refused" });
    for (const method of ["lead-token", "remote-token"]) expect(acceptSuggestion(store, { repo: REPO, id }, person({ method }), T0)).toMatchObject({ reason: "lead-refused" });
    expect(rules()).toBe(0);
    const accepted = acceptSuggestion(store, { repo: REPO, id }, person(), T0);
    if (!accepted.ok) throw new Error(accepted.problem);
    expect(withActor({ account: "alex", lead: true }, () => turnOffRule(store, accepted.rule, person(), T0))).toMatchObject({ reason: "lead-refused" });
    expect(ruleById(store, accepted.rule)!.state).toBe("active");
  });

  test("a writer called directly, without a door proved for exactly its act, refuses", () => {
    world(false);
    const proved = proveRuleDoor(store, person(), "turn-off", REPO);
    if (!proved.ok) throw new Error("door");
    expect(() => insertEarnedRule(store, proved.door, { repo: REPO, cohortSize: "small", provider: "claude", model: HAIKU, configuredProvider: "claude", configuredModel: SONNET, grant: {}, prices: {}, depends: {} }, T0)).toThrow(/door proved for exactly this act/);
    const forged = Object.freeze({ actor: "alex", act: "turn-off" as const, via: "person" as const });
    expect(() => endRuleByDoor(store, forged, 1, 1, T0)).toThrow(/door proved for exactly this act/);
    expect(rules()).toBe(0);
  });

  test("a revoked credential generation refuses", () => {
    world(false);
    expect(acceptSuggestion(store, { repo: REPO, id: offerId() }, person({ generation: store.accountOf("alex")!.generation + 1 }), T0)).toMatchObject({ reason: "authority" });
  });
});

describe("the local owner only lowers, only in its exact act", () => {
  test("accept refused in every act; turn-off only as routing-turn-off", () => {
    world(true);
    const owner = (act: LocalOwnerAct) => ({ account: "alex", localGeneration: 1, accountGeneration: store.accountOf("alex")!.generation, transport: "terminal" as const, act, sessionHash: null, request: null });
    const local: RuleDoor = { kind: "local-owner", actor: "alex" };
    for (const act of ["read", "approve-plan", "routing-turn-off", "dismiss-suggestion"] as const) {
      expect(asLocalOwner(owner(act), () => acceptSuggestion(store, { repo: REPO, id: offerId() }, local, T0))).toMatchObject({ ok: false, reason: "authority" });
    }
    const accepted = acceptSuggestion(store, { repo: REPO, id: offerId() }, person(), T0);
    if (!accepted.ok) throw new Error(accepted.problem);
    for (const act of ["read", "approve-plan", "dismiss-suggestion"] as const) expect(asLocalOwner(owner(act), () => turnOffRule(store, accepted.rule, local, T0))).toMatchObject({ reason: "authority" });
    expect(asLocalOwner(owner("routing-turn-off"), () => turnOffRule(store, accepted.rule, local, T0))).toMatchObject({ ok: true });
  });
});

describe("stale terms never become a rule, and a rule never switches off on terms that moved", () => {
  test("a stale offer refuses as out of date", () => {
    world(false);
    const id = offerId();
    record("mature", at(-1));
    expect(acceptSuggestion(store, { repo: REPO, id }, person(), T0)).toMatchObject({ ok: false, reason: "stale-suggestion", problem: expect.stringContaining("out of date") });
    expect(rules()).toBe(0);
  });

  test("a generation race: a Models write between the offer and the accept refuses config-changed", () => {
    world(false);
    const id = offerId();
    const other = openStore(join(dir, "plane.db"));
    try { other.setPhaseConfig(INSTALLATION_SCOPE, "repair", "claude", SONNET, "alex", T0); } finally { other.close(); }
    expect(acceptSuggestion(store, { repo: REPO, id }, person(), T0)).toMatchObject({ ok: false, reason: "config-changed" });
  });

  test("a switch-off racing a config write from another connection: the rule pauses, never switches off", () => {
    world(false);
    const accepted = acceptSuggestion(store, { repo: REPO, id: offerId() }, person(), T0);
    if (!accepted.ok) throw new Error(accepted.problem);
    record("rejected", at(1));
    record("rejected", at(1.1));
    const other = openStore(join(dir, "plane.db"));
    try { other.setPhaseTierConfig(INSTALLATION_SCOPE, "build", "light", "claude", HAIKU, "alex", T0); } finally { other.close(); }
    expect(switchOffIfTripped(store, accepted.rule, at(2)).outcome).toBe("moved");
    expect(ruleById(store, accepted.rule)!.state).toBe("paused");
  });
});

describe("a task approved under a rule", () => {
  function approved(token: string, id: string): number {
    store.createTask({ id, title: id }, T0);
    const ref = store.refFor(BUILT_IN, id).id;
    store.placeTask(ref, REPO);
    store.writeSizing(ref, { size: "small", risky: false, source: "person", reason: "t" });
    propose(store, { taskId: id, goal: "Round payouts to the cent", now: T0 });
    if (!approve(store, id, "alex", T0, store.getScope(id)!.digest, token).ok) throw new Error("approve");
    return ref;
  }
  const start = (ref: number) => {
    const authority = store.routeAuthorityFor(ref, "builder");
    if (authority === null || !authority.ok) throw new Error("route");
    return store.startRun({ taskRef: ref, leaseId: `l-${++seq}`, runner: "w", branch: `b-${seq}`, worktree: `/w/${seq}`, route: authority.stamp, now: at(3) });
  };

  test("is held at admission with no strike when the rule switched itself off", () => {
    const token = world(false);
    const accepted = acceptSuggestion(store, { repo: REPO, id: offerId() }, person(), T0);
    if (!accepted.ok) throw new Error(accepted.problem);
    const ref = approved(token, "held");
    record("rejected", at(1));
    record("rejected", at(1.1));
    expect(switchOffIfTripped(store, accepted.rule, at(2)).outcome).toBe("switched-off");
    const strikes = store.refForId(ref)!.strikes;
    expect(() => start(ref)).toThrow(RunAdmissionRefused);
    expect(store.runsFor(ref)).toEqual([]);
    expect(store.refForId(ref)!.strikes).toBe(strikes);
  });

  test("keeps its exact sealed model after a person turns the rule off", () => {
    const token = world(false);
    const accepted = acceptSuggestion(store, { repo: REPO, id: offerId() }, person(), T0);
    if (!accepted.ok) throw new Error(accepted.problem);
    const ref = approved(token, "kept");
    expect(turnOffRule(store, accepted.rule, person(), T0)).toMatchObject({ ok: true });
    expect(store.getRun(start(ref))!.model).toBe(HAIKU);
  });
});
