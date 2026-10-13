import type { Store } from "./store.js";
import { releaseUnattendedRun, reserveUnattendedRun, unattendedGrantStands, type UnattendedGrant } from "./flow-unattended.js";
import { modeTermsFromJson } from "./modes.js";
import { plannerContractOf, plannerSourceDigest } from "./planner-source.js";
import { modeFilingCoverage, propose } from "./scope.js";

export const PLAN_AUTO_SCHEMA = `CREATE TABLE IF NOT EXISTS plan_authorization (
  task_id TEXT PRIMARY KEY REFERENCES task(id),
  source_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  mode_digest TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);`;

function plainPlan(store: Store, taskId: string): boolean {
  const ref = store.lookupRef(taskId);
  return ref !== null && ref.deliverable === "branch" && ref.coordinatorCid === null &&
    store.mirrorByTask(taskId) === null;
}

/** Join the console's authority-free proposal to the authenticated filing
 * road in one transaction. Planning defers the seal until verified ingestion. */
export function applyModeToNewFiling(store: Store, taskId: string, actor: string, now: Date): void {
  const ref = store.lookupRef(taskId);
  const scope = store.getScope(taskId);
  const coverage = modeFilingCoverage(store, ref?.repo ?? null, actor, now);
  if (ref === null || scope === null || scope.proposedVia != null || coverage === null) return;
  const filed = propose(store, { taskId, goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, acceptance: scope.acceptance,
    budgetMicrousd: scope.budgetMicrousd ?? coverage.defaultBudgetMicrousd,
    qualityMode: scope.qualityMode ?? "default",
    ...(coverage.escalated ? { posture: "escalated" as const } : {}), now });
  if (ref.plan === "requested") authorizePlanUnderMode(store, taskId, actor, now);
  else if (filed.profileState === "resolved") store.sealScopeApproval(taskId, actor, now, {}, { kind: "mode", modeDigest: coverage.digest });
}

/** Called only by credentialed operator roads, never by proposal/intake
 * code. This authorizes the exact filed contract, not arbitrary future
 * planner text. Rewrites, mode renewal, expiry and revocation fail closed. */
export function authorizePlanUnderMode(store: Store, taskId: string, actor: string, now: Date): boolean {
  return store.transact(() => {
    const ref = store.lookupRef(taskId);
    if (ref === null || ref.repo === null || ref.plan !== "requested" || !plainPlan(store, taskId) || store.hasLiveClaim(ref.id, now)) return false;
    const mode = store.activeMode(ref.repo, now);
    const terms = mode === null ? null : modeTermsFromJson(mode.termsJson);
    if (mode === null || mode.signedBy !== actor || !terms?.planAuto || !terms.autoApproveFiling || !store.accountCanAccess(actor, ref.repo)) return false;
    const source = plannerContractOf(store, taskId);
    if (!source.ok || source.contract.scope === null || source.contract.revision !== null) return false;
    const scope = source.contract.scope;
    if (scope.proposedVia !== null || scope.acceptance.length === 0 || scope.touches.length === 0 || scope.terms.profileState !== "resolved" || store.scopeSealed(taskId)) return false;
    store.raw().prepare(`INSERT INTO plan_authorization(task_id,source_digest,scope_digest,mode_digest,signed_by,created_at,basis) VALUES (?,?,?,?,?,?,'mode')
      ON CONFLICT(task_id) DO UPDATE SET source_digest=excluded.source_digest,scope_digest=excluded.scope_digest,mode_digest=excluded.mode_digest,signed_by=excluded.signed_by,created_at=excluded.created_at,basis='mode'`)
      .run(taskId, plannerSourceDigest(source.contract), scope.digest, mode.digest, actor, now.toISOString());
    store.recordAction({ at: now.toISOString(), actor, repo: ref.repo, taskId, runId: null, action: "unchanged plan pre-authorized", outcome: "authorized", source: "work" });
    return true;
  });
}

/** A scope whose resolved profile or route runs with full permissions: a flow grant never seals one. */
function escalatedPosture(store: Store, taskId: string): boolean {
  const row = store.raw().prepare("SELECT profile_json, proposed_route_json FROM task_scope WHERE task_id = ?").get(taskId);
  const text = `${row?.["profile_json"] ?? ""} ${row?.["proposed_route_json"] ?? ""}`;
  return /"(?:bypassPermissions|danger-full-access|yolo)"/.test(text);
}

/**
 * A flow card's new filing under its flow's "runs on its own" grant (flow-unattended.ts), inside the engine's filing
 * transaction, which has just proved the grant covers this card. A plain build that plans is pre-authorized for an
 * unchanged plan only; anything else is sealed now, under a distinct `grant` basis. False (the filing then waits for a
 * person, as it always did) when the filed terms aren't the safe, fixed ones the grant was signed for.
 */
export function sealFlowFilingUnderGrant(store: Store, taskId: string, grant: UnattendedGrant, card: { flow: number; id: number }, now: Date): boolean {
  const ref = store.lookupRef(taskId);
  const scope = store.getScope(taskId);
  if (ref === null || scope === null || scope.proposedVia != null || scope.profileState !== "resolved" || escalatedPosture(store, taskId)) return false;
  if (!unattendedGrantStands(store, grant.digest, grant.signedBy, ref.repo, scope.touches, now)) return false;
  // The day's run is taken first, in one capped statement; a filing that then can't be sealed gives it back.
  if (!reserveUnattendedRun(store, grant, taskId, now)) return false;
  let done = false;
  if (ref.plan === "requested") {
    const source = plannerContractOf(store, taskId);
    if (plainPlan(store, taskId) && source.ok && source.contract.scope !== null && source.contract.revision === null && source.contract.scope.acceptance.length > 0) {
      store.raw().prepare(`INSERT INTO plan_authorization(task_id,source_digest,scope_digest,mode_digest,signed_by,created_at,basis) VALUES (?,?,?,?,?,?,'grant')
        ON CONFLICT(task_id) DO UPDATE SET source_digest=excluded.source_digest,scope_digest=excluded.scope_digest,mode_digest=excluded.mode_digest,signed_by=excluded.signed_by,created_at=excluded.created_at,basis='grant'`)
        .run(taskId, plannerSourceDigest(source.contract), source.contract.scope.digest, grant.digest, grant.signedBy, now.toISOString());
      done = true;
    }
  } else {
    done = store.sealScopeApproval(taskId, grant.signedBy, now, {}, { kind: "grant", modeDigest: grant.digest });
  }
  if (!done) { releaseUnattendedRun(store, grant, taskId); return false; }
  store.recordAction({ at: now.toISOString(), actor: grant.signedBy, repo: ref.repo, taskId, runId: null, source: "work",
    action: ref.plan === "requested" ? "flow ran on its own: unchanged plan pre-authorized" : "flow ran on its own: approved", outcome: "authorized", detail: `flow #${card.flow} · card ${card.id}` });
  return true;
}

/** Whether the authority that armed this plan authorization still stands (read side and finalization alike). */
function armedAuthorityStands(store: Store, row: Record<string, unknown>, repo: string, now: Date): { basis: "mode" | "grant"; digest: string } | null {
  const by = String(row["signed_by"]), digest = String(row["mode_digest"]);
  if (row["basis"] === "grant") {
    const scope = store.getScope(String(row["task_id"]));
    return unattendedGrantStands(store, digest, by, repo, scope?.touches ?? [], now) ? { basis: "grant", digest } : null;
  }
  const mode = store.activeMode(repo, now);
  const terms = mode === null ? null : modeTermsFromJson(mode.termsJson);
  return mode !== null && terms?.planAuto === true && terms.autoApproveFiling && mode.digest === digest && mode.signedBy === by && store.accountCanAccess(by, repo)
    ? { basis: "mode", digest } : null;
}

/** Read-side status only; finalization still proves the authority anew. */
export function planAutoPending(store: Store, taskId: string, now: Date): boolean {
  const ref = store.lookupRef(taskId);
  if (ref?.repo == null || ref.plan !== "requested" || !plainPlan(store, taskId)) return false;
  const row = store.raw().prepare("SELECT * FROM plan_authorization WHERE task_id=?").get(taskId);
  if (row === undefined) return false;
  const source = plannerContractOf(store, taskId);
  return armedAuthorityStands(store, row, ref.repo, now) !== null && source.ok && plannerSourceDigest(source.contract) === row["source_digest"];
}

/** Inside the verified planner finalization transaction, after the source,
 * artifact, contract changes and lease fence have all been checked. */
export function sealUnchangedPlanUnderMode(store: Store, taskId: string, sourceDigest: string, runId: number, eligible: boolean, now: Date): boolean {
  const authorization = store.raw().prepare("SELECT * FROM plan_authorization WHERE task_id = ?").get(taskId);
  if (authorization === undefined) return false;
  // One conclusion consumes the authorization even when it needs a human.
  store.raw().prepare("DELETE FROM plan_authorization WHERE task_id = ?").run(taskId);
  const ref = store.lookupRef(taskId);
  const scope = store.getScope(taskId);
  const by = String(authorization["signed_by"]);
  const authority = ref?.repo == null ? null : armedAuthorityStands(store, authorization, ref.repo, now);
  const covered = eligible && plainPlan(store, taskId) && sourceDigest === authorization["source_digest"] && scope?.digest === authorization["scope_digest"] &&
    authority !== null && (authority.basis === "mode" || !escalatedPosture(store, taskId));
  const approved = covered && store.sealScopeApproval(taskId, by, now, {}, { kind: authority!.basis, modeDigest: authority!.digest });
  store.recordAction({ at: now.toISOString(), actor: by, repo: ref?.repo ?? null, taskId, runId, action: "plan auto-approval", outcome: approved ? "approved" : "needs approval", source: "work" });
  return approved;
}
