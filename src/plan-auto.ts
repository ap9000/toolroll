import type { Store } from "./store.js";
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
    store.raw().prepare(`INSERT INTO plan_authorization(task_id,source_digest,scope_digest,mode_digest,signed_by,created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET source_digest=excluded.source_digest,scope_digest=excluded.scope_digest,mode_digest=excluded.mode_digest,signed_by=excluded.signed_by,created_at=excluded.created_at`)
      .run(taskId, plannerSourceDigest(source.contract), scope.digest, mode.digest, actor, now.toISOString());
    store.recordAction({ at: now.toISOString(), actor, repo: ref.repo, taskId, runId: null, action: "unchanged plan pre-authorized", outcome: "authorized", source: "work" });
    return true;
  });
}

/** Read-side status only; finalization still proves the authority anew. */
export function planAutoPending(store: Store, taskId: string, now: Date): boolean {
  const ref = store.lookupRef(taskId);
  if (ref?.repo == null || ref.plan !== "requested" || !plainPlan(store, taskId)) return false;
  const row = store.raw().prepare("SELECT * FROM plan_authorization WHERE task_id=?").get(taskId);
  if (row === undefined) return false;
  const mode = store.activeMode(ref.repo, now);
  const terms = mode === null ? null : modeTermsFromJson(mode.termsJson);
  const source = plannerContractOf(store, taskId);
  return mode !== null && terms?.planAuto === true && terms.autoApproveFiling && mode.digest === row["mode_digest"] && mode.signedBy === row["signed_by"] &&
    store.accountCanAccess(mode.signedBy, ref.repo) && source.ok && plannerSourceDigest(source.contract) === row["source_digest"];
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
  const mode = ref?.repo == null ? null : store.activeMode(ref.repo, now);
  const terms = mode === null ? null : modeTermsFromJson(mode.termsJson);
  const by = String(authorization["signed_by"]);
  const covered = eligible && plainPlan(store, taskId) && sourceDigest === authorization["source_digest"] && scope?.digest === authorization["scope_digest"] &&
    mode !== null && mode.digest === authorization["mode_digest"] && mode.signedBy === by &&
    terms?.planAuto === true && terms.autoApproveFiling && store.accountCanAccess(by, ref?.repo ?? null);
  const approved = covered && store.sealScopeApproval(taskId, by, now, {}, { kind: "mode", modeDigest: mode!.digest });
  store.recordAction({ at: now.toISOString(), actor: by, repo: ref?.repo ?? null, taskId, runId, action: "plan auto-approval", outcome: approved ? "approved" : "needs approval", source: "work" });
  return approved;
}
