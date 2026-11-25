/**
 * A release from main's proof, as the plane keeps it (docs/plans/release-from-main.md, part C): the release coordinator
 * proves the release commit with publish.yml's own proof (scripts/release-proof.mjs) right before the deploy and records
 * that here, in the action ledger, for the task. The deploy gates (deploy-gate.ts here, scripts/deploy-candidate.mjs in
 * the deployment) accept a check whose coverage is `deploy` only for a task whose sealed scope is a main release and
 * whose newest proof record, made after the person's approval, names exactly the approved commit, tree, pull request and
 * branch. A build can't write the ledger: it has no access to the plane's database.
 */
import type { Store } from "./store.js";
import type { Scope } from "./scope.js";
import type { MainProof } from "./release-main.js";

export const MAIN_PROOF_ACTION = "main release proved";
/** A re-proof that failed (Codex review, finding 3): it makes every earlier proof of the task unusable. */
export const MAIN_PROOF_FAILED_ACTION = "main release proof failed";
/** How long a proof stands for a deployment: the coordinator proves right before its deploy (whose own limit is 30
 * minutes) and right before resuming an interrupted one, so a proof older than this deploys nothing. */
export const MAIN_PROOF_VALID_MS = 30 * 60_000;
const SHA = /^[0-9a-f]{40}$/;

/** Keep the coordinator's proof of `proof.sha` for task `taskId`: one ledger row, its facts as compact JSON. */
export function recordMainReleaseProof(store: Store, input: { taskId: string; version: string; proof: MainProof; now: Date }): void {
  const { proof } = input;
  if (![proof.sha, proof.tree, proof.head].every(one => SHA.test(one)) || !Number.isSafeInteger(proof.pr) || proof.pr < 1 || !/^[A-Za-z0-9._/-]{1,100}$/.test(proof.branch)) throw new Error("not a release proof this plane keeps");
  const ref = store.lookupRef(input.taskId);
  if (ref === null) throw new Error(`no task ${input.taskId}`);
  store.recordAction({ at: input.now.toISOString(), actor: "toolroll release", repo: ref.repo, taskId: input.taskId, runId: null, action: MAIN_PROOF_ACTION, outcome: input.version,
    source: "work", detail: JSON.stringify({ sha: proof.sha, tree: proof.tree, pr: proof.pr, head: proof.head, branch: proof.branch }) });
}

/** A re-proof of the release commit failed: kept for the task, so no earlier proof of it deploys anything. */
export function recordMainReleaseProofFailure(store: Store, input: { taskId: string; version: string; why: string; now: Date }): void {
  const ref = store.lookupRef(input.taskId);
  if (ref === null) throw new Error(`no task ${input.taskId}`);
  store.recordAction({ at: input.now.toISOString(), actor: "toolroll release", repo: ref.repo, taskId: input.taskId, runId: null, action: MAIN_PROOF_FAILED_ACTION, outcome: input.version,
    source: "work", detail: input.why });
}

/**
 * Why a main release task can't deploy on a deploy check, or null when it can: its scope is a sealed main release, and
 * the newest proof record for it is a proof (never a failed re-proof), made after the approval and within
 * MAIN_PROOF_VALID_MS of `now`, naming exactly what was approved. Read only.
 */
export function mainReleaseProofProblem(store: Store, taskId: string, scope: Pick<Scope, "releaseCheck" | "candidate" | "approvedAt"> | null, now: Date): string | null {
  const purpose = scope?.releaseCheck ?? null;
  if (scope === null || purpose === null || purpose.purpose !== "main-release") return "only a release from main deploys on the deploy check";
  if (scope.approvedAt === null) return "the release isn't approved";
  const row = store.handle.prepare("SELECT at, action, detail FROM action_ledger WHERE task_id = ? AND action IN (?, ?) ORDER BY id DESC LIMIT 1").get(taskId, MAIN_PROOF_ACTION, MAIN_PROOF_FAILED_ACTION);
  if (row === undefined) return "the release commit's proof isn't recorded: run `toolroll release` to prove it";
  if (row["action"] === MAIN_PROOF_FAILED_ACTION) return `the release commit's last proof failed (${String(row["detail"] ?? "no reason kept")})`;
  const age = now.getTime() - Date.parse(String(row["at"]));
  if (!(age >= 0 && age < MAIN_PROOF_VALID_MS)) return "the release commit's proof is older than 30 minutes: run `toolroll release` to prove it again";
  let facts: Record<string, unknown>;
  try { facts = JSON.parse(String(row["detail"])) as Record<string, unknown>; } catch { return "the release commit's proof can't be read"; }
  if (Date.parse(String(row["at"])) < Date.parse(scope.approvedAt)) return "the release commit wasn't proven since it was approved: run `toolroll release` to prove it";
  if (facts["sha"] !== purpose.approvedSha || facts["sha"] !== scope.candidate || facts["tree"] !== purpose.approvedTree || facts["pr"] !== purpose.pr || facts["branch"] !== purpose.branch) {
    return "the recorded proof names another release commit than the one approved";
  }
  return null;
}
