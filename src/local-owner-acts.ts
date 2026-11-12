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
import { refArchived } from "./store.js";
import { LOCAL_OWNER_LAPSED, localActNow } from "./local-owner.js";
import { approverStanding, localWorkEligible } from "./scope.js";
import { plannerContractOf, plannerSourceDigest } from "./planner-source.js";

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

/** A refusal found after a write began: thrown so the transaction rolls back, then answered. */
class Undone extends Error {
  constructor(readonly result: LocalActRefusal) { super(result.message); }
}
