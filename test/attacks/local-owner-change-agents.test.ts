/**
 * Change a task's models from the Mac app (docs/plans/mac-change-models.md, revised 2026-11-22): the laptop's local owner
 * picks one task's planner or builder with no password, and on an approved task the pick is their yes to the new agent
 * only. Every way around it is refused, with nothing written: no local owner (a machine, a token), the lead's token in
 * the chain, another act, an ended request, local mode off; work the owner can't touch without a password; approve()'s
 * narrow branch on a seal this pick didn't stale, on someone else's seal, or with more than the agent changed; a refused
 * carry-over rolls back the edit and its author record; and a waiting pick whose owner no longer stands is never applied.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openLocalWorld, LOCAL_T0, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { asLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "../../src/local-owner.js";
import { withActor } from "../../src/actor.js";
import { AGENTS_PICK_AGAIN, applyPendingAgentChanges, localOwnerChangeAgents, LOCAL_AGENT_CHANGE_ACTION, pendingAgentChangeOf, TASK_RUNNING_NOW, type AgentPick } from "../../src/local-owner-acts.js";
import { approve } from "../../src/scope.js";
import { register } from "../../src/runner.js";
import { acquire, release } from "../../src/claim.js";
import { archiveTaskFamily, setLocalModeOff } from "../../src/store.js";
import { presented } from "../serve-kit.js";

const T0 = LOCAL_T0;
const OPUS = { provider: "claude", model: "claude-opus-5-5" };
let world: LocalWorld, serial = 0;
beforeEach(async () => {
  world = await openLocalWorld();
  for (const phase of ["plan", "build"]) world.store.setPhaseTierConfig("installation", phase, "strong", "claude", "claude-opus-5-5", "test", T0);
  register(world.store, { name: "worker-1", host: "test", capacity: 8, repos: [world.repo], now: T0, newToken: () => "tok-worker-1" });
}, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

const rows = (sql: string, ...values: (string | number)[]) => world.store.handle.prepare(sql).all(...values);
const owner = (act: LocalOwnerAct, more: Partial<LocalPrincipal> = {}): LocalPrincipal =>
  ({ account: "alex", localGeneration: 1, accountGeneration: world.store.accountOf("alex")!.generation, transport: "terminal", act, sessionHash: null, request: null, ...more });
/** A task with a proposed plan; `sealedBy`: approved by that person's ceremony. */
function task(sealedBy: string | null = "alex"): string {
  const id = `agents-${++serial}`;
  const made = world.store.createConsoleTask({ id, title: `Fix ${id}`, repo: world.repo, goal: `do ${id}`, acceptance: [{ id: "c1", statement: `${id} is done.`, evidence: ["manual-review"] }], filedVia: "cli" }, T0);
  if (!made.ok) throw Error(made.reason);
  if (sealedBy !== null && !world.store.sealScopeApproval(id, sealedBy, T0)) throw Error("seal");
  return id;
}
const pickOf = (id: string, phase: "plan" | "build" = "build"): AgentPick => ({ phase, ...OPUS, sawDigest: world.store.getScope(id)!.digest });
const change = (id: string, pick: AgentPick = pickOf(id), when: "now" | "next-run" | "restart" = "now") => localOwnerChangeAgents(world.store, id, pick, when, T0);
/** Everything a pick could write about a task. */
const state = (id: string) => JSON.stringify([world.store.lookupRef(id), world.store.getScope(id), rows("SELECT author, digest FROM scope_author WHERE task_id = ? ORDER BY rowid", id),
  rows("SELECT action, outcome, detail FROM action_ledger WHERE task_id = ? AND action LIKE 'task agents%' ORDER BY id", id),
  rows("SELECT * FROM pending_agent_change WHERE task_ref = (SELECT id FROM task_ref WHERE external_id = ?)", id)]);
function running(id: string): { run: number; lease: string } {
  const ref = world.store.lookupRef(id)!.id;
  const taken = acquire(world.store, ref, "worker-1", { token: "tok-worker-1", now: T0, ttlMs: 3_600_000 });
  if (!taken.ok) throw Error(`claim: ${JSON.stringify(taken)}`);
  const run = world.store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "worker-1", branch: `b-${id}`, worktree: world.root, now: T0, ...presented(world.store, ref, "builder") });
  return { run, lease: taken.claim.leaseId };
}

describe("who may pick", () => {
  test("only the local owner acting now as exactly change-task-agents; never a machine, the lead's token, another act, an ended request or a lapsed local mode", () => {
    const id = task();
    const before = state(id);
    // No local owner at all (an API token, a machine): never this road.
    expect(change(id)).toMatchObject({ ok: false, status: 403 });
    for (const act of ["approve-plan", "request-plan", "change-models", "stop-run", "read"] as LocalOwnerAct[]) {
      expect(asLocalOwner(owner(act), () => change(id)), act).toMatchObject({ ok: false, status: 403 });
    }
    // The lead's token inside the owner's chain is the lead, not the owner.
    expect(asLocalOwner(owner("change-task-agents"), () => withActor({ account: "alex", lead: true }, () => change(id)))).toMatchObject({ ok: false, status: 403 });
    // A browser request already answered proves nothing.
    expect(asLocalOwner(owner("change-task-agents", { transport: "browser", request: { ended: true } }), () => change(id))).toMatchObject({ ok: false, status: 403 });
    // Bound to another account generation (a password set since, say): no longer standing.
    expect(asLocalOwner(owner("change-task-agents", { accountGeneration: 999 }), () => change(id))).toMatchObject({ ok: false, status: 403 });
    expect(state(id)).toBe(before);
    expect(setLocalModeOff(world.store, { name: "alex", authority: "full" }, T0)).toMatchObject({ ok: true });
    expect(asLocalOwner(owner("change-task-agents"), () => change(id))).toMatchObject({ ok: false, status: 403 });
    expect(state(id)).toBe(before);
  });

  test("the work rule: protected work, a stale digest, an unconfigured agent or a running task's apply-now each refuse with nothing written", () => {
    const pick = (id: string, p: AgentPick = pickOf(id), when: "now" | "next-run" = "now") => asLocalOwner(owner("change-task-agents"), () => change(id, p, when));
    const stale = task();
    const before = state(stale);
    expect(pick(stale, { ...pickOf(stale), sawDigest: "0".repeat(32) })).toEqual({ ok: false, status: 409, message: AGENTS_PICK_AGAIN });
    expect(pick(stale, { ...pickOf(stale), model: "claude-haiku-4-5" })).toMatchObject({ ok: false, status: 400 });
    expect(state(stale)).toBe(before);
    const busy = task();
    const run = running(busy);
    const busyBefore = state(busy);
    expect(pick(busy)).toEqual({ ok: false, status: 409, message: TASK_RUNNING_NOW });
    // A waiting pick is held to the same proofs, read now.
    expect(pick(busy, { ...pickOf(busy), sawDigest: "0".repeat(32) }, "next-run")).toEqual({ ok: false, status: 409, message: AGENTS_PICK_AGAIN });
    expect(state(busy)).toBe(busyBefore);
    release(world.store, run.lease, T0);
    world.store.setApprovalRules(world.repo, { protectProject: true, protectedPaths: [], notRequester: false }, "alex", T0);
    const guarded = task(null);
    const guardedBefore = state(guarded);
    expect(pick(guarded)).toMatchObject({ ok: false, status: 403, message: "This is protected work, so changing its models needs your password." });
    expect(state(guarded)).toBe(guardedBefore);
  });
});

describe("approve()'s narrow branch", () => {
  const sealAs = (id: string) => asLocalOwner(owner("change-task-agents"), () => approve(world.store, id, "alex", T0, world.store.getScope(id)!.digest, ""));
  const personEdit = (id: string, phase: "plan" | "build" = "build", agent = OPUS) => {
    const edited = world.store.editTaskRoute(world.store.lookupRef(id)!.id, { by: "alex", authenticate: () => ({ ok: true }), override: { phase, provider: "claude", model: agent.model }, configured: true }, T0);
    if (!edited.ok) throw Error(edited.detail);
    return edited;
  };

  test("refuses a task no pick staled: unapproved, or approved as it stands", () => {
    const fresh = task(null);
    expect(sealAs(fresh)).toMatchObject({ ok: false, reason: "policy" });
    expect(world.store.getScope(fresh)!.approvedAt).toBeNull();
    const standing = task();
    const digest = world.store.getScope(standing)!.approvedDigest;
    expect(sealAs(standing)).toMatchObject({ ok: false, reason: "policy" });
    expect(world.store.getScope(standing)!.approvedDigest).toBe(digest);
  });

  test("refuses someone else's seal, and more than one agent changed; seals exactly an agent-only change of the owner's own yes", () => {
    world.store.saveApprover("bob", "hash-b", T0);
    const theirs = task("bob");
    personEdit(theirs);
    expect(sealAs(theirs)).toMatchObject({ ok: false, reason: "policy" });
    expect(world.store.getScope(theirs)!.approvedBy).toBe("bob");
    // The planner and the builder both moved since the yes: not one pick.
    const both = task();
    personEdit(both, "plan");
    personEdit(both, "build");
    expect(sealAs(both)).toMatchObject({ ok: false, reason: "policy" });
    const scope = world.store.getScope(both)!;
    expect(scope.approvedDigest).not.toBe(scope.digest);
    // The control: only the builder moved on the owner's own yes.
    const own = task();
    personEdit(own);
    expect(sealAs(own)).toMatchObject({ ok: true });
  });

  test("the writer: someone else's yes is not carried — the task waits for a yes", () => {
    world.store.saveApprover("bob", "hash-b", T0);
    const theirs = task("bob");
    expect(asLocalOwner(owner("change-task-agents"), () => change(theirs))).toMatchObject({ ok: true, outcome: "approve-again" });
    const scope = world.store.getScope(theirs)!;
    expect(scope.approvedDigest).not.toBe(scope.digest);
  });
});

describe("check and write together", () => {
  test("a carry-over approve() refuses: the route edit, the author record and the ledger row roll back with it", () => {
    const id = task();
    // The organisation's policy allows only Sonnet: approve() refuses the new builder inside the pick's own transaction.
    world.store.setOrgPolicy({ providers: null, models: ["sonnet"], tools: null, ceiling: "escalated" }, "alex", T0);
    const before = state(id);
    const done = asLocalOwner(owner("change-task-agents"), () => change(id));
    expect(done).toMatchObject({ ok: false, status: 409 });
    // approve()'s own words (the policy's), not a refusal read before the write.
    expect((done as { message: string }).message).not.toBe(AGENTS_PICK_AGAIN);
    expect((done as { message: string }).message).toMatch(/claude-opus-5-5|model/i);
    expect(state(id)).toBe(before);
    expect(rows("SELECT COUNT(*) AS n FROM action_ledger WHERE task_id = ? AND action = ?", id, LOCAL_AGENT_CHANGE_ACTION)).toEqual([{ n: 0 }]);
  });
});

describe("a waiting pick", () => {
  test("is applied only as its owner still standing: a lapsed owner leaves it unapplied with its words", () => {
    const id = task();
    const run = running(id);
    expect(asLocalOwner(owner("change-task-agents"), () => change(id, pickOf(id), "next-run"))).toMatchObject({ ok: true, outcome: "pending" });
    const ref = world.store.lookupRef(id)!.id;
    world.store.finishRun(run.run, { outcome: "failed", reason: "retryable-infra", now: T0 });
    release(world.store, run.lease, T0);
    expect(setLocalModeOff(world.store, { name: "alex", authority: "full" }, T0)).toMatchObject({ ok: true });
    const scopeBefore = JSON.stringify(world.store.getScope(id));
    expect(applyPendingAgentChanges(world.store, T0)).toBe(0);
    expect(JSON.stringify(world.store.getScope(id))).toBe(scopeBefore);
    expect(pendingAgentChangeOf(world.store, ref)?.problem).toMatch(/no longer stands/);
  });

  test("a row forged with someone else's generations is never applied", () => {
    const id = task();
    const run = running(id);
    expect(asLocalOwner(owner("change-task-agents"), () => change(id, pickOf(id), "next-run"))).toMatchObject({ ok: true, outcome: "pending" });
    const ref = world.store.lookupRef(id)!.id;
    world.store.handle.prepare("UPDATE pending_agent_change SET account_generation = account_generation + 1 WHERE task_ref = ?").run(ref);
    world.store.finishRun(run.run, { outcome: "failed", reason: "retryable-infra", now: T0 });
    release(world.store, run.lease, T0);
    const scopeBefore = JSON.stringify(world.store.getScope(id));
    expect(applyPendingAgentChanges(world.store, T0)).toBe(0);
    expect(JSON.stringify(world.store.getScope(id))).toBe(scopeBefore);
    expect(pendingAgentChangeOf(world.store, ref)?.problem).toMatch(/no longer stands/);
  });

  test("a newer pick replaces it; cancel and archive clear it", () => {
    const one = task();
    running(one);
    const ref = world.store.lookupRef(one)!.id;
    expect(asLocalOwner(owner("change-task-agents"), () => change(one, pickOf(one), "next-run"))).toMatchObject({ ok: true });
    expect(asLocalOwner(owner("change-task-agents"), () => change(one, pickOf(one, "plan"), "next-run"))).toMatchObject({ ok: true });
    expect(rows("SELECT phase FROM pending_agent_change WHERE task_ref = ?", ref)).toEqual([{ phase: "plan" }]);
    // Cancel: refused while claimed, so end the run first; the waiting pick goes with the task.
    world.store.handle.prepare("UPDATE claim SET released_at = ?, released_by = 'released' WHERE task_ref = ? AND released_at IS NULL").run(T0.toISOString(), ref);
    expect(world.store.cancelTask(one, T0, "not now")).toEqual({ ok: true });
    expect(pendingAgentChangeOf(world.store, ref)).toBeNull();
    const two = task();
    const run = running(two);
    const twoRef = world.store.lookupRef(two)!.id;
    expect(asLocalOwner(owner("change-task-agents"), () => change(two, pickOf(two), "next-run"))).toMatchObject({ ok: true });
    world.store.finishRun(run.run, { outcome: "failed", reason: "retryable-infra", now: T0 });
    release(world.store, run.lease, T0);
    expect(archiveTaskFamily(world.store, two, { by: "alex", byKind: "person", rule: null, reason: "Not now" }, T0)).toMatchObject({ ok: true });
    expect(pendingAgentChangeOf(world.store, twoRef)).toBeNull();
  });
});

describe("the browser road", () => {
  test("the local session's route post reaches the writer; a password-free size edit on it is refused in words", async () => {
    const { cookie, csrf } = await world.localSession();
    const id = task(null);
    const digest = world.store.getScope(id)!.digest;
    const sized = await world.post(`/t/${id}/route`, cookie, { csrf, size: "large" });
    expect(sized.status).toBe(400);
    expect(world.store.lookupRef(id)!.sizing?.source ?? null).not.toBe("person");
    const picked = await world.post(`/t/${id}/route`, cookie, { csrf, phase: "build", agent: "claude|claude-opus-5-5", sawDigest: digest });
    expect(picked.status).toBe(303);
    expect(decodeURIComponent(String(picked.headers.location))).toContain("The builder is now Claude claude-opus-5-5.");
    expect(JSON.parse(String(rows("SELECT detail FROM action_ledger WHERE task_id = ? AND action = ?", id, LOCAL_AGENT_CHANGE_ACTION)[0]!["detail"]))).toMatchObject({ via: "browser", act: "change-task-agents" });
  });
});
