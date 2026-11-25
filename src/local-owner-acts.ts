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
import { PLAN_AGAIN_ACTIONS, planAgain, refArchived, requeueEligibility } from "./store.js";
import { asLocalOwner, LOCAL_OWNER_LAPSED, localActNow, type LocalPrincipal } from "./local-owner.js";
import { agentChangeToolsUnchanged, approve, approverStanding, localWorkEligible, personApprovalOf, type ApproveResult } from "./scope.js";
import { agentOnlyChange } from "./agent-change-check.js";
import { agentChoicesFor, routeOfTask } from "./agentconfig.js";
import { legOf, routeFromJson } from "./phase-routing.js";
import { providerName } from "./provider-auth.js";
import { requestTaskStop } from "./task-control.js";
import type { ProviderId } from "./provider.js";
import { activeRemote } from "./remote-run.js";
import { currentActor } from "./actor.js";
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
      // An unchanged-plan pre-authorization on the task (a mode or a flow's grant armed it on this or an earlier request)
      // never stands behind the local owner's "you'll approve it before anything is built": withdrawn here, in the same
      // transaction and before the "already asked" answer below, and said in the ledger.
      const armed = store.handle.prepare("SELECT signed_by, basis FROM plan_authorization WHERE task_id = ?").get(taskId);
      if (armed !== undefined) {
        store.handle.prepare("DELETE FROM plan_authorization WHERE task_id = ?").run(taskId);
        store.recordAction({ at: now.toISOString(), actor: `operator:${local.account}`, repo: ref.repo, taskId, runId: null, source: "request",
          action: "unchanged plan pre-authorization withdrawn", outcome: "withdrawn",
          detail: JSON.stringify({ v: 1, signedBy: String(armed["signed_by"]), basis: String(armed["basis"]), why: "the local owner asked for the plan" }) });
      }
      // Asked already (by anyone), with nothing about the task changed: the same answer, and nothing else written.
      if (ref.plan === "requested" || ref.plan === "drafted") return { ok: true, replayed: true };
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

// ---- Plan again (the stranger test, round 10; plan-task-loop v2, S2) ------------------------------------------------------

/** What a Retry hears while a plan stopped on its checks: Plan again is the way on, never a requeue. */
export const PLAN_AGAIN_FIRST = "The plan didn't pass its checks. Use Plan again first.";
/** What a Retry with nothing to bind to hears while a build incident stands. */
export const RESOLVE_INCIDENT_FIRST = "Resolve the incident first.";

/**
 * Plan again, as the laptop's local owner, with no password: the planner tries again after a planning incident. It is
 * the existing `request-plan` act (local-owner-acts.md §1, "Ask for a plan"), under exactly its limits, in one
 * transaction: the owner acting now as exactly `request-plan`; its current reach into the project; the one work rule for
 * planning (localWorkEligible); no plan pins saved on the task; the planning source still the one the screen read; then
 * store.ts planAgain's own guards (this version's planning incident, queued, plan requested, scope unapproved, no live
 * claim). Any unchanged-plan pre-authorization on the task is withdrawn and audited inside the same transaction, before
 * the "already" answer too, so the plan Plan again asks for is only ever approved by a person's own yes. It approves,
 * pins and pre-authorizes nothing.
 */
export function planAgainAsLocalOwner(store: Store, taskId: string, pins: { incident: number; source: string }, now: Date): { ok: true; replayed: boolean } | LocalActRefusal {
  try {
    return store.transact((): { ok: true; replayed: boolean } | LocalActRefusal => {
      const local = localActNow(store, "request-plan");
      if (local === null) return { ok: false, reason: "local-owner", message: LOCAL_OWNER_LAPSED };
      const ref = store.lookupRef(taskId);
      if (ref === null || store.getTask(taskId) === null || !approverStanding(store, local.account, ref.repo).ok) {
        return { ok: false, reason: "not-found", message: "That task is unavailable in your projects." };
      }
      if (refArchived(store, ref.id)) return { ok: false, reason: "archived", message: "This task is put away. Restore it first." };
      const eligible = localWorkEligible(store, local.account, taskId, { act: "plan" });
      if (!eligible.ok) return { ok: false, reason: "refused", message: eligible.message };
      if (ref.planProvider !== null || ref.planModel !== null) {
        return { ok: false, reason: "refused", message: "This task names its own planning agent, so planning it again needs your password." };
      }
      if (planSourceOf(store, taskId) !== pins.source) return { ok: false, reason: "stale", message: LOCAL_TASK_CHANGED };
      const done = planAgain(store, { taskId, incident: pins.incident, by: local.account, actor: `operator:${local.account}`, action: PLAN_AGAIN_ACTIONS.local,
        detail: { source: pins.source, via: local.transport }, now,
        // An unchanged-plan pre-authorization never stands behind "you approve the plan before anything is built".
        before: () => withdrawPlanAuthorization(store, taskId, ref.repo, local.account, now, "the local owner asked to plan again") });
      return done.ok ? done : { ok: false, reason: done.reason, message: done.message };
    });
  } catch (error) {
    if (error instanceof Error && error.message === LOCAL_OWNER_LAPSED) return { ok: false, reason: "local-owner", message: LOCAL_OWNER_LAPSED };
    throw error;
  }
}

/** Withdraw an unchanged-plan pre-authorization saved on the task, with its audit row (as requestPlanAsLocalOwner does).
 * Called inside the caller's transaction; nothing to withdraw writes nothing. */
function withdrawPlanAuthorization(store: Store, taskId: string, repo: string | null, account: string, now: Date, why: string): void {
  const armed = store.handle.prepare("SELECT signed_by, basis FROM plan_authorization WHERE task_id = ?").get(taskId);
  if (armed === undefined) return;
  store.handle.prepare("DELETE FROM plan_authorization WHERE task_id = ?").run(taskId);
  store.recordAction({ at: now.toISOString(), actor: `operator:${account}`, repo, taskId, runId: null, source: "request",
    action: "unchanged plan pre-authorization withdrawn", outcome: "withdrawn",
    detail: JSON.stringify({ v: 1, signedBy: String(armed["signed_by"]), basis: String(armed["basis"]), why }) });
}

// ---- Change a task's models from the Mac app (docs/plans/mac-change-models.md, revised 2026-11-22) -------------------------

/** What a pick while a run holds the task, sent as "apply now", hears: nothing changes. */
export const TASK_RUNNING_NOW = "This task is running right now.";
/** What a pick made against another version of the plan hears: nothing changes. */
export const AGENTS_PICK_AGAIN = "The plan changed since you picked — pick again.";
/** What an approved task's pick says when more than the picked agent changed since the approval: it waits for a yes. */
export const AGENTS_DRIFTED = "Your model setup changed since you approved — approve again.";
export const AGENTS_TOOLS_CHANGED = "The project's tools changed since you approved — approve again to use them.";
/** The ledger act an applied change is kept under: the person, the role, the old and new agent, the digest sealed (or
 * null), what became of the approval, and how it came (now, or a pending pick applied when its run ended). */
export const LOCAL_AGENT_CHANGE_ACTION = "task agents (local owner)";
/** The ledger act a pick kept for when the task's run ends (or stops) is kept under. */
export const LOCAL_AGENT_PENDING_ACTION = "task agents pending (local owner)";

/** One pick: the role, the exact configured agent, and the scope digest the person picked against. */
export type AgentPick = { phase: "plan" | "build"; provider: string; model: string; sawDigest: string };
/** When a pick applies while a run holds the task. Ignored when nothing runs (it applies now). */
export type AgentPickWhen = "now" | "next-run" | "restart";
/** What became of the task's approval: `changed` (none stood), `kept` (that agent already; nothing written), `resealed`
 * (the person's own yes carried to the new agent), `replanned` (a new plan was asked for; it needs their yes),
 * `approve-again` (the yes wasn't this person's own; it waits), `drifted` (more than the agent changed; it waits),
 * `pending` (kept for when the run ends or stops). */
export type AgentChangeOutcome = "changed" | "kept" | "resealed" | "replanned" | "approve-again" | "drifted" | "pending";
export type AgentChangeResult = { ok: true; outcome: AgentChangeOutcome; words: string; sealed: string | null } | { ok: false; status: number; message: string };
/** A task's pick waiting for its run to end (the steps read's `pendingAgentChange`). */
export type PendingAgentChange = { phase: "plan" | "build"; provider: string; model: string; when: "next-run" | "restart"; by: string; at: string; problem: string | null };

/** A refusal found after a write began, in the act's own answer shape: thrown so the transaction rolls back. */
class Unpicked extends Error {
  constructor(readonly result: { ok: false; status: number; message: string }) { super(result.message); }
}
const ROLE_NOUN = { plan: "planner", build: "builder" } as const;
const agentNamed = (one: { provider: string; model: string }): string => `${providerName(one.provider)} ${one.model}`;
const UNAVAILABLE = { ok: false as const, status: 404, message: "That task is unavailable in your projects." };

/** The pending pick for a task, or null. */
export function pendingAgentChangeOf(store: Store, taskRef: number): PendingAgentChange | null {
  const row = store.handle.prepare("SELECT phase, provider, model, apply_when, by, at, problem FROM pending_agent_change WHERE task_ref = ?").get(taskRef);
  if (row === undefined) return null;
  return { phase: row["phase"] === "plan" ? "plan" : "build", provider: String(row["provider"]), model: String(row["model"]), when: row["apply_when"] === "restart" ? "restart" : "next-run",
    by: String(row["by"]), at: String(row["at"]), problem: row["problem"] == null ? null : String(row["problem"]) };
}

/** Whether `pick` is one of the role's configured, selectable agents for this task now (the choices editTaskRoute proves
 * again inside its write), or the words that say it isn't. */
function pickConfiguredProblem(store: Store, taskId: string, ref: NonNullable<ReturnType<Store["lookupRef"]>>, pick: AgentPick, now: Date): string | null {
  const routed = routeOfTask(store, taskId, ref, now);
  const offered = agentChoicesFor(store, ref.repo, routed?.kind === "route" ? routed.route : null)[pick.phase].filter(one => one.selectable);
  if (offered.some(one => one.provider === pick.provider && one.model === pick.model)) return null;
  return offered.length === 0 ? `No configured agent can be the ${ROLE_NOUN[pick.phase]} for this task right now.`
    : `${agentNamed(pick)} isn't one of the configured ${ROLE_NOUN[pick.phase]}s right now. Pick again.`;
}

/** The task's current agent for the picked role (its working route), or null. */
function currentAgentOf(store: Store, taskId: string, phase: "plan" | "build"): { provider: string; model: string } | null {
  const route = routeFromJson(store.getScope(taskId)?.proposedRouteJson ?? null);
  return route === null ? null : { provider: legOf(route, phase).provider, model: legOf(route, phase).model };
}

/** The proofs both roads read before anything is written (inside the caller's transaction): the task is one this owner
 * may change without a password, the plan is the one picked against, and the pick is a configured agent. */
function pickProblem(store: Store, account: string, taskId: string, ref: NonNullable<ReturnType<Store["lookupRef"]>>, pick: AgentPick, now: Date): { ok: false; status: number; message: string } | null {
  if (store.getTask(taskId)?.state === "cancelled") return { ok: false, status: 409, message: "This task was cancelled." };
  const eligible = localWorkEligible(store, account, taskId, { act: "agents" });
  if (!eligible.ok) return { ok: false, status: 403, message: eligible.message };
  const scope = store.getScope(taskId);
  if (scope === null || scope.digest !== pick.sawDigest) return { ok: false, status: 409, message: AGENTS_PICK_AGAIN };
  const configured = pickConfiguredProblem(store, taskId, ref, pick, now);
  return configured === null ? null : { ok: false, status: 400, message: configured };
}

/** The words for an approve() refusal on the carry-over road (nothing was changed). */
function carryRefusalWords(result: ApproveResult): string {
  if (!result.ok && "message" in result && typeof result.message === "string") return result.message;
  return !result.ok && result.reason === "second-approver" ? "This task needs a second person's yes, so its models weren't changed." : "Your approval couldn't carry over to the new model, so nothing changed.";
}

/**
 * Apply one pick now, inside the caller's transaction, as `local` (already proved): the pick's proofs, the route edit
 * (configured agents only, against the digest picked), then what becomes of the approval. Only the person's own standing
 * yes, staled by this very edit, with nothing but the picked agent changed since (agent-change-check.ts), is carried, by
 * approve() under the change-task-agents act (its narrow branch re-proves all of it and every other approve rule). Then
 * the author record (after the seal: the requester rule reads authors), any waiting pick cleared, and the ledger row.
 * A refusal after a write throws Unpicked.
 */
function applyPickInside(store: Store, local: LocalPrincipal, taskId: string, pick: AgentPick, how: "now" | "next-run" | "restart", now: Date): AgentChangeResult {
  const ref = store.lookupRef(taskId);
  if (ref === null || store.getTask(taskId) === null || !approverStanding(store, local.account, ref.repo).ok) return UNAVAILABLE;
  if (refArchived(store, ref.id)) return { ok: false, status: 409, message: "This task is put away. Restore it first." };
  if (store.hasLiveClaim(ref.id, now)) return { ok: false, status: 409, message: TASK_RUNNING_NOW };
  const problem = pickProblem(store, local.account, taskId, ref, pick, now);
  if (problem !== null) return problem;
  const role = ROLE_NOUN[pick.phase], to = { provider: pick.provider, model: pick.model };
  const from = currentAgentOf(store, taskId, pick.phase);
  if (from !== null && from.provider === to.provider && from.model === to.model) {
    store.handle.prepare("DELETE FROM pending_agent_change WHERE task_ref = ?").run(ref.id);
    return { ok: true, outcome: "kept", words: `${agentNamed(to)} is already the ${role}.`, sealed: null };
  }
  const before = store.getScope(taskId)!;
  const edited = store.editTaskRoute(ref.id, {
    by: local.account,
    authenticate: () => approverStanding(store, local.account, ref.repo).ok ? { ok: true } : { ok: false, reason: "That task is unavailable in your projects." },
    override: { phase: pick.phase, provider: pick.provider as ProviderId, model: pick.model },
    expectDigest: pick.sawDigest,
    configured: true,
  }, now);
  if (!edited.ok) {
    return edited.reason === "changed" ? { ok: false, status: 409, message: AGENTS_PICK_AGAIN }
      : edited.reason === "live-claim" ? { ok: false, status: 409, message: TASK_RUNNING_NOW }
      : edited.reason === "unauthenticated" || edited.reason === "no-task" ? UNAVAILABLE
      : { ok: false, status: 400, message: edited.detail };
  }
  let outcome: AgentChangeOutcome = "changed", sealed: string | null = null, toolsMoved = false;
  if (edited.replanned) outcome = "replanned";
  else if (edited.staled) {
    const refiled = store.getScope(taskId);
    const ownYes = before.approvedBy === local.account && (before.approvalBasis === "password" || before.approvalBasis === "chat");
    const only = refiled === null ? null : agentOnlyChange(
      { routeJson: refiled.approvedRouteJson, profile: refiled.approvedProfile, chainJson: refiled.approvedChainJson },
      { routeJson: refiled.proposedRouteJson, profile: refiled.profile, chainJson: refiled.proposedChainJson },
      provider => store.agentsFor([provider])[0]?.billing ?? null);
    if (!ownYes) outcome = "approve-again";
    else if (refiled === null || only === null || !only.ok || only.phase !== pick.phase) outcome = "drifted";
    // The project's tools changed since that yes (or what it saw can't be read): carrying it over would approve them too.
    else if (before.approvedDigest === null || !agentChangeToolsUnchanged(store, taskId, before.approvedDigest)) { outcome = "drifted"; toolsMoved = true; }
    else {
      const carried = approve(store, taskId, local.account, now, refiled.digest, "");
      if (!carried.ok) throw new Unpicked({ ok: false, status: 409, message: carryRefusalWords(carried) });
      outcome = "resealed";
      sealed = refiled.digest;
    }
  }
  // Changing how a task runs is authoring it (v102), recorded after the seal so the requester rule never reads it first.
  const after = store.getScope(taskId);
  if (after !== null) store.recordScopeAuthor(taskId, after.digest, local.account, now);
  store.handle.prepare("DELETE FROM pending_agent_change WHERE task_ref = ?").run(ref.id);
  store.recordAction({ at: now.toISOString(), actor: `operator:${local.account}`, repo: ref.repo, taskId, runId: null, action: LOCAL_AGENT_CHANGE_ACTION, outcome, source: "request",
    detail: JSON.stringify({ v: 1, phase: pick.phase, from, to, sealed, act: "change-task-agents", how, via: local.transport }) });
  const changed = `The ${role} is now ${agentNamed(to)}.`;
  const words = outcome === "resealed" ? `${changed} Still approved.`
    : outcome === "replanned" ? `${changed} A new plan is coming; approve it when it's ready.`
    : outcome === "approve-again" ? `${changed} Approve it again to build with it.`
    : outcome === "drifted" ? `${changed} ${toolsMoved ? AGENTS_TOOLS_CHANGED : AGENTS_DRIFTED}`
    : changed;
  return { ok: true, outcome, words, sealed };
}

/** The attempt holding the task's live claim now (its lease-group head), or null. */
function liveAttemptOf(store: Store, taskRef: number, now: Date): number | null {
  const lease = store.currentLiveLease(taskRef, now);
  if (lease === null) return null;
  const row = store.handle.prepare(`SELECT r.id AS id FROM run r WHERE r.task_ref = ? AND r.lease_id = ? AND r.outcome IS NULL
      AND (r.parent_run IS NULL OR NOT EXISTS (SELECT 1 FROM run p WHERE p.id = r.parent_run AND p.lease_id = r.lease_id)) ORDER BY r.id LIMIT 1`).get(taskRef, lease);
  return row === undefined ? null : Number(row["id"]);
}

/**
 * Change one task's planner or builder as the laptop's local owner, with no password (the Mac app's Change Models; the
 * owner's decisions of 2026-11-22). One transaction: the owner acting now as exactly `change-task-agents` (localActNow:
 * never a lead's token, a remote run, a password or another act), its reach into the project, the task not put away, then
 * - nothing running: the pick applies now (applyPickInside); `when` is ignored;
 * - a run holds it and `when` is `now`: refused (TASK_RUNNING_NOW), nothing changes;
 * - `next-run` / `restart`: the same proofs as applying now, read now (work rule, the plan picked against, a configured
 *   agent), then the pick is kept as the task's one waiting change (a newer pick replaces it), bound to the person, the
 *   local-mode and account generations it was made under and the run holding the task; `restart` also asks that run to
 *   stop (requestRunStop, whose hold keeps the task until the change is applied). Its processes are signalled only after
 *   the transaction commits.
 * The waiting change is applied once the claim is gone (applyPendingAgentChanges), as that person, through the same writer.
 */
export function localOwnerChangeAgents(store: Store, taskId: string, pick: AgentPick, when: AgentPickWhen, now: Date): AgentChangeResult {
  let signal: (() => void) | null = null;
  try {
    const result = store.transact((): AgentChangeResult => {
      const local = localActNow(store, "change-task-agents");
      if (local === null) return { ok: false, status: 403, message: LOCAL_OWNER_LAPSED };
      const ref = store.lookupRef(taskId);
      if (ref === null || store.getTask(taskId) === null || !approverStanding(store, local.account, ref.repo).ok) return UNAVAILABLE;
      if (refArchived(store, ref.id)) return { ok: false, status: 409, message: "This task is put away. Restore it first." };
      if (!store.hasLiveClaim(ref.id, now)) return applyPickInside(store, local, taskId, pick, "now", now);
      if (when === "now") return { ok: false, status: 409, message: TASK_RUNNING_NOW };
      const problem = pickProblem(store, local.account, taskId, ref, pick, now);
      if (problem !== null) return problem;
      const run = liveAttemptOf(store, ref.id, now);
      if (when === "restart") {
        if (run === null) return { ok: false, status: 409, message: TASK_RUNNING_NOW };
        const asked = requestTaskStop(store, { taskId, runId: run, by: local.account, via: local.transport === "terminal" ? "cli" : "web", deferSignal: one => { signal = one; } }, now);
        if (!asked.ok) throw new Unpicked({ ok: false, status: 409, message: `${TASK_RUNNING_NOW} It can't be stopped: ${asked.detail}.` });
      }
      store.handle.prepare(`INSERT INTO pending_agent_change (task_ref, phase, provider, model, apply_when, saw_digest, run, by, local_generation, account_generation, transport, at, problem)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT (task_ref) DO UPDATE SET phase = excluded.phase, provider = excluded.provider, model = excluded.model, apply_when = excluded.apply_when,
          saw_digest = excluded.saw_digest, run = excluded.run, by = excluded.by, local_generation = excluded.local_generation,
          account_generation = excluded.account_generation, transport = excluded.transport, at = excluded.at, problem = NULL`)
        .run(ref.id, pick.phase, pick.provider, pick.model, when, pick.sawDigest, run, local.account, local.localGeneration, local.accountGeneration, local.transport, now.toISOString());
      store.recordAction({ at: now.toISOString(), actor: `operator:${local.account}`, repo: ref.repo, taskId, runId: run, action: LOCAL_AGENT_PENDING_ACTION, outcome: when, source: "request",
        detail: JSON.stringify({ v: 1, phase: pick.phase, to: { provider: pick.provider, model: pick.model }, sawDigest: pick.sawDigest, via: local.transport }) });
      const words = when === "restart" ? `Stopping the run; it starts again on ${agentNamed(pick)}.` : `Switches to ${agentNamed(pick)} when this run ends.`;
      return { ok: true, outcome: "pending", words, sealed: null };
    });
    if (result.ok) (signal as (() => void) | null)?.();
    return result;
  } catch (error) {
    if (error instanceof Unpicked) return error.result;
    if (error instanceof Error && error.message === LOCAL_OWNER_LAPSED) return { ok: false, status: 403, message: LOCAL_OWNER_LAPSED };
    throw error;
  }
}

type PendingRow = { taskRef: number; taskId: string; pick: AgentPick; when: "next-run" | "restart"; run: number | null; principal: LocalPrincipal; at: string };

/**
 * Apply each waiting pick whose run has let the task go (the worker's reconcile pass and each tick before the ready set is
 * read). A row for a task cancelled, put away or gone is dropped; one whose task is still claimed waits; a `restart`
 * waits until its stop is settled. Each is applied as the person who picked it — the local owner bound to the local-mode
 * and account generations of the pick, still standing now (localOwnerStandsNow, inside the write), as exactly
 * `change-task-agents` — through the same writer as a pick made now, so every proof is read again at this moment. A
 * `restart` that applied lifts its stop's hold in the same transaction (the task dispatches again); a refusal rolls all of
 * it back, keeps the stop's hold, and leaves its words on the row (`problem`) until a newer pick. Returns how many applied.
 */
export function applyPendingAgentChanges(store: Store, now: Date): number {
  // Only the worker's own pass applies them: never inside a remote API run or a lead's chain, where no owner may act (and
  // a refusal there would only be that chain's, not the pick's).
  if (activeRemote() !== null || currentActor() !== null) return 0;
  const rows = store.handle.prepare(`SELECT p.*, r.external_id AS task_id FROM pending_agent_change p JOIN task_ref r ON r.id = p.task_ref WHERE p.problem IS NULL ORDER BY p.at`).all();
  let applied = 0;
  for (const row of rows) {
    const taskRef = Number(row["task_ref"]), taskId = String(row["task_id"]);
    if (store.getTask(taskId)?.state === "cancelled" || refArchived(store, taskRef)) {
      store.handle.prepare("DELETE FROM pending_agent_change WHERE task_ref = ?").run(taskRef);
      continue;
    }
    if (store.hasLiveClaim(taskRef, now)) continue;
    const run = row["run"] == null ? null : Number(row["run"]);
    const when = row["apply_when"] === "restart" ? "restart" : "next-run";
    if (when === "restart" && run !== null) {
      const stop = store.stopOf(run);
      if (stop !== null && stop.resumedAt === null && (stop.settledAt === null || store.getRun(run)?.outcome == null)) continue;
    }
    const pending: PendingRow = {
      taskRef, taskId, when, run, at: String(row["at"]),
      pick: { phase: row["phase"] === "plan" ? "plan" : "build", provider: String(row["provider"]), model: String(row["model"]), sawDigest: String(row["saw_digest"]) },
      principal: { account: String(row["by"]), localGeneration: Number(row["local_generation"]), accountGeneration: Number(row["account_generation"]),
        transport: row["transport"] === "terminal" ? "terminal" : "browser", act: "change-task-agents", sessionHash: null, request: null },
    };
    let done: AgentChangeResult | "wait";
    try {
      done = asLocalOwner(pending.principal, () => applyPendingAsOwner(store, pending, now));
    } catch (error) {
      // One pick that can't be applied never stops the worker's pass: it keeps the reason, said, on that pick.
      done = { ok: false, status: 500, message: `This change couldn't be applied: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (done === "wait") continue;
    if (done.ok) { applied++; continue; }
    // Outside the owner's chain (a lapsed owner can't write there): the words stay on exactly this pick.
    const words = done.message.slice(0, 500);
    store.transact(() => store.handle.prepare("UPDATE pending_agent_change SET problem = ? WHERE task_ref = ? AND at = ? AND problem IS NULL").run(words, taskRef, pending.at));
  }
  return applied;
}

/** One waiting pick, applied as its person (inside asLocalOwner): see applyPendingAgentChanges. `wait`: its run holds the
 * task again, or its stop hasn't settled, read inside the write (it is tried again on a later pass, never a problem). */
function applyPendingAsOwner(store: Store, pending: PendingRow, now: Date): AgentChangeResult | "wait" {
  try {
    return store.transact((): AgentChangeResult | "wait" => {
      const local = localActNow(store, "change-task-agents");
      if (local === null || local.account !== pending.principal.account) throw new Unpicked({ ok: false, status: 403, message: LOCAL_OWNER_LAPSED });
      // Exactly the pick read above: a newer one (or none) is not this one's to apply.
      const still = store.handle.prepare("SELECT 1 AS hit FROM pending_agent_change WHERE task_ref = ? AND at = ? AND problem IS NULL").get(pending.taskRef, pending.at);
      if (still === undefined) return "wait";
      if (store.hasLiveClaim(pending.taskRef, now)) return "wait";
      const stop = pending.when === "restart" && pending.run !== null ? store.stopOf(pending.run) : null;
      if (stop !== null && stop.resumedAt === null && (stop.settledAt === null || store.getRun(pending.run!)?.outcome == null)) return "wait";
      const done = applyPickInside(store, local, pending.taskId, pending.pick, pending.when, now);
      if (!done.ok) throw new Unpicked(done);
      if (stop !== null && stop.resumedAt === null) {
        const resumed = store.resumeRunStop({ runId: pending.run!, taskRef: pending.taskRef, by: local.account, via: local.transport === "terminal" ? "cli" : "web" }, now);
        if (!resumed.ok) throw new Unpicked({ ok: false, status: 409, message: `The stopped run can't start again yet: ${resumed.detail}.` });
      }
      return done;
    });
  } catch (error) {
    if (error instanceof Unpicked) return error.result;
    if (error instanceof Error && error.message === LOCAL_OWNER_LAPSED) return { ok: false, status: 403, message: LOCAL_OWNER_LAPSED };
    throw error;
  }
}
