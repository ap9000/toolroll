/**
 * Plan again (the stranger test, round 10; plan-task-loop v2, S2): after a planning incident (the plan or the planner's
 * question failed its checks, or planning failed again and again), the planner tries again on the same task. For the
 * laptop's local owner it is the existing `request-plan` act, under exactly its limits; a password session proves the
 * same facts. Everything around it is refused: a build incident, another version's or task's incident, a stale planning
 * source, saved plan pins, a task no longer queued, approved since, put away, release work, the wrong act, a lapsed local
 * mode. It approves nothing, and an unchanged-plan pre-authorization is withdrawn (and audited) in the same transaction,
 * on a replay too, so the next plan can never approve itself.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { openLocalWorld, LOCAL_T0, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { runOperate } from "../../src/operate.js";
import { asLocalOwner, runAsLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "../../src/local-owner.js";
import { planAgainAsLocalOwner, planSourceOf } from "../../src/local-owner-acts.js";
import { propose } from "../../src/scope.js";
import { register } from "../../src/runner.js";
import { archiveTaskFamily, PLAN_AGAIN_ACTIONS, setLocalModeOff } from "../../src/store.js";
import { sealUnchangedPlanUnderMode } from "../../src/plan-auto.js";
import { personPlanAgain } from "../../src/server/tasks.js";

const T0 = LOCAL_T0;
let world: LocalWorld, file: string, serial = 0, worker = false;
beforeEach(async () => {
  world = await openLocalWorld();
  file = join(world.configDir, "state.db");
  worker = false;
}, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

const rows = (sql: string, ...values: (string | number)[]) => world.store.handle.prepare(sql).all(...values);
const owner = (act: LocalOwnerAct): LocalPrincipal =>
  ({ account: "alex", localGeneration: 1, accountGeneration: world.store.accountOf("alex")!.generation, transport: "terminal", act, sessionHash: null, request: null });
async function terminal(words: string[]): Promise<{ code: number; envelope: Record<string, unknown> }> {
  let out = "";
  const code = await runAsLocalOwner(() => runOperate("task", [...words, "--json", "--db", file], text => { out += text; }, { now: T0 }));
  return { code, envelope: JSON.parse(out.trim() || "{}") as Record<string, unknown> };
}

/** A run of the task's own, finished as given: a planning turn, or (relabelled, as an unapproved task can start no
 * build) a build. */
function finishedRun(id: string, role: "planner" | "builder", reason: string): number {
  const store = world.store;
  if (!worker) { register(store, { name: "worker-1", host: "test", capacity: 4, repos: [world.repo], now: T0, newToken: () => "tok-worker-1" }); worker = true; }
  const ref = store.lookupRef(id)!.id;
  const authority = store.routeAuthorityFor(ref, "planner");
  if (!authority?.ok) throw Error("route fixture");
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}-${++serial}`, runner: "worker-1", role: "planner", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: T0 });
  store.finishRun(runId, { outcome: "failed", reason, now: T0 });
  if (role === "builder") store.handle.prepare("UPDATE run SET role = 'builder' WHERE id = ?").run(runId);
  return runId;
}
/** A task whose plan failed its checks, as claim.ts sealPlanFailure leaves it: queued, plan requested, an incident and
 * its hold, two planning strikes. */
function stoppedPlan(kind = "malformed-plan"): { id: string; incident: number; source: string } {
  const store = world.store;
  const id = `again-${++serial}`;
  store.createTask({ id, title: "Fix the footer link" }, T0);
  store.placeTask(store.refFor("built-in", id).id, world.repo, {}, T0);
  propose(store, { taskId: id, goal: "Make the footer link work.", touches: ["src/footer.ts"], acceptance: [{ id: "c1", statement: "The link works.", how: null, evidence: ["check"] }], now: T0 });
  const ref = store.lookupRef(id)!.id;
  expect(store.requestPlan(ref, T0).ok).toBe(true);
  const run = finishedRun(id, "planner", kind);
  const incident = store.createIncident({ run, kind: kind as never }, T0);
  store.holdOwned({ taskRef: ref, ownerKind: "incident", ownerId: String(incident), reason: kind, until: null }, T0);
  store.handle.prepare("UPDATE task_ref SET plan_strikes = 2 WHERE id = ?").run(ref);
  return { id, incident, source: planSourceOf(store, id)! };
}
const again = (pins: { id: string; incident: number; source: string }) => terminal(["plan", pins.id, "--digest", pins.source, "--incident", String(pins.incident)]);
const armed = (id: string) => rows("SELECT signed_by FROM plan_authorization WHERE task_id = ?", id);
const arm = (id: string) => {
  const scope = world.store.getScope(id)!;
  world.store.handle.prepare("INSERT INTO plan_authorization (task_id, source_digest, scope_digest, mode_digest, signed_by, created_at, basis) VALUES (?, ?, ?, 'm', 'alex', ?, 'mode')")
    .run(id, planSourceOf(world.store, id)!, scope.digest, T0.toISOString());
};
/** Everything Plan again could write about a task. */
const state = (id: string) => JSON.stringify([world.store.lookupRef(id), armed(id), rows("SELECT state FROM task WHERE id = ?", id),
  // (Each request's own admission rows aside: what an act writes carries its detail.)
  rows("SELECT action, outcome, detail FROM action_ledger WHERE task_id = ? AND detail IS NOT NULL ORDER BY id", id),
  rows("SELECT id, resolved_at FROM incident WHERE run IN (SELECT id FROM run WHERE task_ref = (SELECT id FROM task_ref WHERE external_id = ?))", id),
  rows("SELECT digest, approved_digest FROM task_scope WHERE task_id = ?", id)]);

describe("Plan again, as the local owner", () => {
  test("from the terminal: the incident resolved, strikes cleared, the plan still requested and nothing approved; once", async () => {
    for (const kind of ["malformed-plan", "malformed-decision", "plan-attempts-exhausted"]) {
      const pins = stoppedPlan(kind);
      const answer = await again(pins);
      expect(answer.envelope, `${kind}: ${JSON.stringify(answer.envelope)}`).toMatchObject({ ok: true, replayed: false, again: true });
      const ref = world.store.lookupRef(pins.id)!;
      expect(ref).toMatchObject({ plan: "requested", planStrikes: 0, planProvider: null, planModel: null });
      expect(rows("SELECT resolved_by FROM incident WHERE id = ?", pins.incident)).toEqual([{ resolved_by: "alex" }]);
      expect(world.store.activeHolds(ref.id, T0).filter(one => one.ownerKind === "incident")).toEqual([]);
      expect(world.store.getScope(pins.id)?.approvedDigest ?? null).toBeNull();
      const recorded = rows("SELECT actor, outcome, detail FROM action_ledger WHERE action = ? AND task_id = ?", PLAN_AGAIN_ACTIONS.local, pins.id);
      expect(recorded).toHaveLength(1);
      expect(JSON.parse(String(recorded[0]!["detail"]))).toEqual({ v: 1, incident: pins.incident, source: pins.source, via: "terminal" });
      // The same request again: "already", and nothing else written.
      const before = state(pins.id);
      expect((await again(pins)).envelope).toMatchObject({ ok: true, replayed: true });
      expect(state(pins.id)).toBe(before);
    }
  });

  test("an armed pre-authorization is withdrawn and audited in the same write, so the next plan can't approve itself; a replay withdraws too", async () => {
    const pins = stoppedPlan();
    arm(pins.id);
    expect((await again(pins)).envelope).toMatchObject({ ok: true, replayed: false });
    expect(armed(pins.id)).toEqual([]);
    expect(rows("SELECT actor, outcome FROM action_ledger WHERE action = 'unchanged plan pre-authorization withdrawn' AND task_id = ?", pins.id)).toEqual([{ actor: "operator:alex", outcome: "withdrawn" }]);
    // The next valid, unchanged plan: nothing stands behind it, so it waits for a person's own yes.
    const next = finishedRun(pins.id, "planner", "plan-drafted");
    expect(sealUnchangedPlanUnderMode(world.store, pins.id, pins.source, next, true, T0)).toBe(false);
    expect(world.store.getScope(pins.id)?.approvedDigest ?? null).toBeNull();
    // Armed again after Plan again (left by another road), then the same Plan again replayed: withdrawn once more.
    arm(pins.id);
    expect((await again(pins)).envelope).toMatchObject({ ok: true, replayed: true });
    expect(armed(pins.id)).toEqual([]);
    expect(rows("SELECT COUNT(*) AS n FROM action_ledger WHERE action = 'unchanged plan pre-authorization withdrawn' AND task_id = ?", pins.id)).toEqual([{ n: 2 }]);
  });

  test("refused, with nothing written: a build incident, another task's incident, a stale source, saved pins, approved, not queued, put away", async () => {
    const cases: [string, () => { id: string; incident: number; source: string }, RegExp][] = [
      ["a build incident", () => {
        const pins = stoppedPlan();
        const build = finishedRun(pins.id, "builder", "agent");
        return { ...pins, incident: world.store.createIncident({ run: build, kind: "attempts-exhausted" }, T0) };
      }, /changed/],
      ["a builder's malformed question", () => {
        const pins = stoppedPlan();
        const build = finishedRun(pins.id, "builder", "decision:malformed");
        return { ...pins, incident: world.store.createIncident({ run: build, kind: "malformed-decision" }, T0) };
      }, /changed/],
      ["another task's incident", () => { const one = stoppedPlan(), other = stoppedPlan(); return { ...one, incident: other.incident }; }, /changed/],
      ["a stale source", () => ({ ...stoppedPlan(), source: "f".repeat(64) }), /changed/],
      ["saved plan pins", () => { const pins = stoppedPlan(); world.store.setPlanPins(world.store.lookupRef(pins.id)!.id, "claude", "opus", T0); return pins; }, /password/],
      ["approved since", () => { const pins = stoppedPlan(); expect(world.store.sealScopeApproval(pins.id, "alex", T0)).toBe(true); return { ...pins, source: planSourceOf(world.store, pins.id)! }; }, /changed/],
      ["no longer queued", () => { const pins = stoppedPlan(); world.store.setTaskState(pins.id, "failed", T0); return pins; }, /changed/],
      ["put away", () => { const pins = stoppedPlan(); archiveTaskFamily(world.store, pins.id, { by: "alex", byKind: "person", rule: null, reason: "Not now" }, T0); return pins; }, /put away/],
    ];
    for (const [name, make, words] of cases) {
      const pins = make();
      const before = state(pins.id);
      const answer = await again(pins);
      expect(answer.envelope, name).toMatchObject({ ok: false });
      expect(String(answer.envelope["message"]), name).toMatch(words);
      expect(state(pins.id), name).toBe(before);
    }
  });

  test("only the exact act, only while local mode stands; a password session's Plan again is its own road and arms nothing", async () => {
    const pins = stoppedPlan();
    const before = state(pins.id);
    const call = () => planAgainAsLocalOwner(world.store, pins.id, { incident: pins.incident, source: pins.source }, T0);
    expect(asLocalOwner(owner("approve-plan"), call)).toMatchObject({ ok: false, reason: "local-owner" });
    expect(asLocalOwner(owner("retry-build"), call)).toMatchObject({ ok: false, reason: "local-owner" });
    // No local owner at all (a machine, a token, the lead): never this road.
    expect(call()).toMatchObject({ ok: false, reason: "local-owner" });
    expect(state(pins.id)).toBe(before);
    expect(setLocalModeOff(world.store, { name: "alex", authority: "full" }, T0)).toMatchObject({ ok: true });
    expect(asLocalOwner(owner("request-plan"), call)).toMatchObject({ ok: false, reason: "local-owner" });
    expect(state(pins.id)).toBe(before);
    // A password session (an approver the route admitted): the same facts proved, recorded as the person's, nothing armed.
    const person = stoppedPlan();
    expect(personPlanAgain(world.store, person.id, "alex", "nope", person.source, T0)).toMatchObject({ ok: false, status: 409 });
    expect(personPlanAgain(world.store, person.id, "alex", String(person.incident), "f".repeat(64), T0)).toMatchObject({ ok: false, status: 409 });
    expect(personPlanAgain(world.store, person.id, "alex", String(person.incident), person.source, T0)).toEqual({ ok: true });
    expect(rows("SELECT actor FROM action_ledger WHERE action = ? AND task_id = ?", PLAN_AGAIN_ACTIONS.person, person.id)).toEqual([{ actor: "operator:alex" }]);
    expect(armed(person.id)).toEqual([]);
  });
});

describe("the browser's Plan again, as the local owner", () => {
  test("the page offers Plan again for a planning incident; the post is bound to it; Retry and Resolve say the way on", async () => {
    const { cookie, csrf } = await world.localSession();
    const pins = stoppedPlan();
    const page = await world.send(`/t/${pins.id}`, "GET", { cookie });
    expect(page.body).toContain("Plan again");
    expect(page.body).toContain(`name="incident" value="${pins.incident}"`);
    // Retry with nothing to bind to hears the way on, never "This task changed".
    const retried = await world.post(`/t/${pins.id}/requeue`, cookie, { csrf });
    expect(retried.status).toBe(409);
    expect(retried.body).toContain("The plan didn&#39;t pass its checks. Use Plan again first.");
    // Resolve on a planning incident stays a password act (no LOCAL_POSTS row): Plan again is the local road.
    expect((await world.post(`/i/${pins.incident}/resolve`, cookie, { csrf })).status).not.toBe(303);
    const before = state(pins.id);
    for (const form of [{ csrf, incident: String(pins.incident) }, { csrf, incident: "x", source: pins.source }, { csrf, incident: String(pins.incident), source: "f".repeat(64) }]) {
      expect((await world.post(`/t/${pins.id}/plan`, cookie, form)).status, JSON.stringify(form)).toBe(409);
      expect(state(pins.id)).toBe(before);
    }
    expect((await world.post(`/t/${pins.id}/plan`, cookie, { csrf, incident: String(pins.incident), source: pins.source })).status).toBe(303);
    expect(JSON.parse(String(rows("SELECT detail FROM action_ledger WHERE action = ? AND task_id = ?", PLAN_AGAIN_ACTIONS.local, pins.id)[0]!["detail"]))).toMatchObject({ via: "browser" });
  });
});
