/**
 * The laptop's local owner's password-free acts beyond approving and accepting (docs/plans/local-owner-acts.md, slices
 * 2 and 3): asking for a plan, and retrying its own approved build. One writer per act, shared by the terminal (the
 * CLI rows `task plan` and `task requeue`, run as the local owner) and the browser (the task page's plan button and
 * Retry, posted by a local owner's session). Each writer proves everything inside its own transaction: the local owner
 * acting now as exactly this act (localActNow, never `proveAccountNow` saying yes to any act), the owner's current reach
 * into the project, the one work rule (scope.ts localWorkEligible), the exact thing the screen read, and the act's own
 * guards. Neither is ever chosen for anyone else: a password session, an API token, the lead, a chat bot or a machine
 * keeps the road it had.
 */
import type { Store } from "./store.js";
import { refArchived, requeueEligibility } from "./store.js";
import { LOCAL_OWNER_LAPSED, localActNow } from "./local-owner.js";
import { approverStanding, localWorkEligible, personApprovalOf } from "./scope.js";
import { plannerContractOf, plannerSourceDigest } from "./planner-source.js";
import { scopeApprovedForDispatch } from "./dispatch.js";

/** What a refused local act says, and a reason the surfaces branch on. */
export type LocalActRefusal = { ok: false; reason: string; message: string };

/** The ledger act a local owner's plan request is kept under: the planning source it was bound to, and its transport. */
export const LOCAL_PLAN_ACTION = "task plan (local owner)";
/** What a stale screen hears: the task is not what it read. */
export const LOCAL_TASK_CHANGED = "This task changed. Look at it again.";

/**
 * The planning source a screen binds a plan request to (planner-source.ts): the digest over everything the planner
 * would be given, the filed scope when there is one and the title alone when there is none. Null when it can't be read.
 */
export function planSourceOf(store: Store, taskId: string): string | null {
  const contract = plannerContractOf(store, taskId);
  return contract.ok ? plannerSourceDigest(contract.contract) : null;
}

/**
 * Ask for a plan, as the laptop's local owner, with no password (local-owner slice 2). In one transaction: the owner
 * acting now as exactly `request-plan`; its current reach into the task's project; the task not put away; the one work
 * rule for planning (no release, protected, two-person, escalated, coordinator, imported or unsandboxed work); no plan
 * pins saved on the task (a local request never plans with an agent someone chose; it refuses rather than ignoring or
 * clearing them, so what plans is exactly what the screen's terms say); and the planning source still the one the
 * screen read (`source`). A request already made, with that source unchanged, answers "already" and writes nothing.
 * Otherwise any unchanged-plan pre-authorization saved on the task is withdrawn (with its audit row), so the plan this
 * asks for can only be approved by a person's own yes; then requestPlan's own guards (queued, not planned, not
 * approved, no live claim); then the request's ledger row. It approves nothing, pins nothing and pre-authorizes nothing.
 */
export function requestPlanAsLocalOwner(store: Store, taskId: string, source: string, now: Date): { ok: true; replayed: boolean } | LocalActRefusal {
  try {
    return store.transact((): { ok: true; replayed: boolean } | LocalActRefusal => {
      const local = localActNow(store, "request-plan");
      if (local === null) return { ok: false, reason: "local-owner", message: LOCAL_OWNER_LAPSED };
      const ref = store.lookupRef(taskId);
      if (ref === null || store.getTask(taskId) === null) return { ok: false, reason: "not-found", message: "That task is unavailable in your projects." };
      if (!approverStanding(store, local.account, ref.repo).ok) return { ok: false, reason: "not-found", message: "That task is unavailable in your projects." };
      if (refArchived(store, ref.id)) return { ok: false, reason: "archived", message: "This task is put away. Restore it first." };
      const eligible = localWorkEligible(store, local.account, taskId, { act: "plan" });
      if (!eligible.ok) return { ok: false, reason: "refused", message: eligible.message };
      if (ref.planProvider !== null || ref.planModel !== null) {
        return { ok: false, reason: "refused", message: "This task names its own planning agent, so planning it needs your password." };
      }
      if (planSourceOf(store, taskId) !== source) return { ok: false, reason: "stale", message: LOCAL_TASK_CHANGED };
      // Asked already (by anyone), with nothing about the task changed: the same answer, and nothing written.
      if (ref.plan === "requested" || ref.plan === "drafted") return { ok: true, replayed: true };
      // An unchanged-plan pre-authorization left on the task (a mode or a flow's grant armed it on an earlier request)
      // is never inherited by this one: withdrawn here, in the same transaction, and said in the ledger.
      const armed = store.handle.prepare("SELECT signed_by, basis FROM plan_authorization WHERE task_id = ?").get(taskId);
      if (armed !== undefined) {
        store.handle.prepare("DELETE FROM plan_authorization WHERE task_id = ?").run(taskId);
        store.recordAction({ at: now.toISOString(), actor: `operator:${local.account}`, repo: ref.repo, taskId, runId: null, source: "request",
          action: "unchanged plan pre-authorization withdrawn", outcome: "withdrawn",
          detail: JSON.stringify({ v: 1, signedBy: String(armed["signed_by"]), basis: String(armed["basis"]), why: "the local owner asked for the plan" }) });
      }
      const asked = store.requestPlan(ref.id, now);
      if (!asked.ok) throw new Undone({ ok: false, reason: "refused", message: `This task can't be planned now: ${asked.reason}.` });
      store.recordAction({ at: now.toISOString(), actor: `operator:${local.account}`, repo: ref.repo, taskId, runId: null, action: LOCAL_PLAN_ACTION,
        outcome: "requested", source: "request", detail: JSON.stringify({ v: 1, source, via: local.transport }) });
      return { ok: true, replayed: false };
    });
  } catch (error) {
    if (error instanceof Undone) return error.result;
    // Store.transact's own re-check found the bound owner no longer standing: the same refusal, said, never a crash.
    if (error instanceof Error && error.message === LOCAL_OWNER_LAPSED) return { ok: false, reason: "local-owner", message: LOCAL_OWNER_LAPSED };
    throw error;
  }
}

// ---- Retry the owner's own approved build (slice 3) ---------------------------------------------------------------------

/** The ledger act a local owner's retry is kept under: the build it retried, the exact seal it spent, and its transport. */
export const LOCAL_RETRY_ACTION = "task requeue (local owner)";
/** Local retries per task and exact seal: then a note (Send back) or a password. */
export const LOCAL_RETRY_LIMIT = 3;
/** The fourth local retry of one approval. */
export const LOCAL_RETRY_SPENT = `You've retried this ${LOCAL_RETRY_LIMIT} times. Send it back with a note, or sign in with your password to retry again.`;
/** What a retry hears while Toolroll can't yet prove the last build stopped. */
export const LOCAL_RETRY_STOPPING = "The last build is still stopping. Try again in a moment.";

type Seal = { by: string; at: string; digest: string };
const sameSeal = (a: unknown, b: Seal): boolean => {
  const one = a as Partial<Seal> | null;
  return one !== null && typeof one === "object" && one.by === b.by && one.at === b.at && one.digest === b.digest;
};

/**
 * What a Retry binds to (local-owner slice 3): the task's latest finished build and its approved scope digest, when the
 * task failed or finished and its scope is approved as it stands. What a screen offers only; the writer decides.
 */
export function retryPinsOf(store: Store, taskId: string): { run: number; digest: string } | null {
  const ref = store.lookupRef(taskId);
  const scope = store.getScope(taskId);
  const state = store.getTask(taskId)?.state;
  if (ref === null || scope === null || scope.approvedAt === null || scope.approvedDigest !== scope.digest || (state !== "failed" && state !== "done")) return null;
  const last = store.lastBuilderRun(ref.id);
  return last === null ? null : { run: last.id, digest: scope.digest };
}

/** This owner's earlier retries of this task under exactly this seal: the builds they retried. */
function localRetriesOf(store: Store, taskId: string, account: string, seal: Seal): number[] {
  const rows = store.handle.prepare("SELECT run_id, detail FROM action_ledger WHERE action = ? AND task_id = ? AND actor = ? ORDER BY id")
    .all(LOCAL_RETRY_ACTION, taskId, `operator:${account}`);
  const runs: number[] = [];
  for (const row of rows) {
    let detail: unknown;
    try { detail = JSON.parse(String(row["detail"] ?? "")); } catch { continue; }
    const bound = detail as { v?: unknown; seal?: unknown };
    if (bound.v === 1 && sameSeal(bound.seal, seal)) runs.push(Number(row["run_id"]));
  }
  return runs;
}

/**
 * Retry the local owner's own approved build after it stopped (a console restart, a model error), with no password
 * (local-owner slice 3). One transaction, in this order:
 * - the owner acting now as exactly `retry-build`, and its current reach into the task's project;
 * - the task's current approval is this owner's own person yes on the exact seal (personApprovalOf: the ceremony or a
 *   chat tap, a person's proof for those bytes — never a mode, grant, schedule, automatic or carried seal, the lead, or
 *   another person), still standing for dispatch, and on work the owner could approve again now (localWorkEligible);
 * - bound to what the screen read: `digest` is the approved scope digest, and `run` the latest finished build;
 * - the same request again (this owner's retry of `run` under this seal) answers "already" and writes nothing while
 *   that build is still the latest one;
 * - its own stop proof: no unfinished run of the task, no run after `run`, Toolroll's durable stop facts settled for
 *   every run (an expired claim alone proves nothing), no final result (accepted or published) in any task state, and a
 *   failed task or a finished one whose result wasn't accepted (requeueEligibility re-reads the claim and archive);
 * - at most three local retries of this task under this exact seal (a fresh approval, even of the same bytes, is a new
 *   seal), then the words that lead to a note or a password;
 * - then the requeue (incidents resolved, strikes cleared, as the console's Retry) and its ledger row.
 * Nothing about the scope, route, model, chain, budget or permissions is written.
 */
export function retryAsLocalOwner(store: Store, taskId: string, pins: { run: number; digest: string }, now: Date): { ok: true; replayed: boolean; retries: number } | LocalActRefusal {
  try {
    return store.transact((): { ok: true; replayed: boolean; retries: number } | LocalActRefusal => {
      const local = localActNow(store, "retry-build");
      if (local === null) return { ok: false, reason: "local-owner", message: LOCAL_OWNER_LAPSED };
      const ref = store.lookupRef(taskId);
      if (ref === null || store.getTask(taskId) === null || !approverStanding(store, local.account, ref.repo).ok) {
        return { ok: false, reason: "not-found", message: "That task is unavailable in your projects." };
      }
      const person = personApprovalOf(store, taskId);
      if (!person.ok || person.by !== local.account) {
        return { ok: false, reason: "refused", message: "Only a build of your own approval can be retried without a password. Sign in with your password to retry it." };
      }
      const scope = store.getScope(taskId)!;
      const seal: Seal = { by: scope.approvedBy!, at: scope.approvedAt!, digest: scope.approvedDigest! };
      if (scope.digest !== pins.digest) return { ok: false, reason: "stale", message: LOCAL_TASK_CHANGED };
      if (!scopeApprovedForDispatch(store, ref.id, now)) {
        return { ok: false, reason: "refused", message: "This approval no longer stands. Approve the plan again, or sign in with your password." };
      }
      const eligible = localWorkEligible(store, local.account, taskId, { act: "retry" });
      if (!eligible.ok) return { ok: false, reason: "refused", message: eligible.message };
      const latest = store.lastBuilderRun(ref.id);
      const retried = localRetriesOf(store, taskId, local.account, seal);
      // The same request again: recognised from its own ledger row while that retry is still waiting or building, with
      // the owner and approval proved above.
      const state = store.getTask(taskId)!.state;
      if (retried.includes(pins.run) && latest?.id === pins.run && (state === "queued" || state === "running")) return { ok: true, replayed: true, retries: retried.length };
      if (store.handle.prepare("SELECT 1 AS hit FROM run WHERE task_ref = ? AND finished_at IS NULL LIMIT 1").get(ref.id) !== undefined) {
        return { ok: false, reason: "stopping", message: LOCAL_RETRY_STOPPING };
      }
      if (latest === null || latest.id !== pins.run || store.handle.prepare("SELECT 1 AS hit FROM run WHERE task_ref = ? AND id > ? LIMIT 1").get(ref.id, pins.run) !== undefined) {
        return { ok: false, reason: "stale", message: LOCAL_TASK_CHANGED };
      }
      for (const run of store.runsFor(ref.id)) {
        if (store.stopQuiescenceFact(run.id) !== null) return { ok: false, reason: "stopping", message: LOCAL_RETRY_STOPPING };
      }
      if (store.finalResultReason(pins.run) !== null) {
        return { ok: false, reason: "final", message: "This result was accepted or published, so it isn't built again. Send it back with a note instead." };
      }
      const eligibility = requeueEligibility(store, taskId, now);
      if (!eligibility.ok) {
        return eligibility.reason === "archived" ? { ok: false, reason: "archived", message: "This task is put away. Restore it first." }
          : eligibility.reason === "claimed" ? { ok: false, reason: "stopping", message: LOCAL_RETRY_STOPPING }
          : { ok: false, reason: "refused", message: "This task has nothing to retry." };
      }
      if (eligibility.state !== "failed" && !(eligibility.state === "done" && eligibility.rejectedRun === pins.run)) {
        return { ok: false, reason: "refused", message: "This task has nothing to retry." };
      }
      if (retried.length >= LOCAL_RETRY_LIMIT) return { ok: false, reason: "limit", message: LOCAL_RETRY_SPENT };
      const requeued = store.requeueTask(taskId, local.account, now);
      if (!requeued.ok) throw new Undone({ ok: false, reason: "refused", message: "This task has nothing to retry." });
      store.recordAction({ at: now.toISOString(), actor: `operator:${local.account}`, repo: ref.repo, taskId, runId: pins.run, action: LOCAL_RETRY_ACTION,
        outcome: "requeued", source: "request", detail: JSON.stringify({ v: 1, seal, via: local.transport }) });
      return { ok: true, replayed: false, retries: retried.length + 1 };
    });
  } catch (error) {
    if (error instanceof Undone) return error.result;
    if (error instanceof Error && error.message === LOCAL_OWNER_LAPSED) return { ok: false, reason: "local-owner", message: LOCAL_OWNER_LAPSED };
    throw error;
  }
}

/** A refusal found after a write began: thrown so the transaction rolls back, then answered. */
class Undone extends Error {
  constructor(readonly result: LocalActRefusal) { super(result.message); }
}
