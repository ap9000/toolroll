/** Whether a check-only authorization stands for one automatic recheck (check-only.ts), read at every step. Kept apart
 * from the sweep so the follow-up runner reads it without loading the road that asks. */
import { authorityStandsSql } from "./approval-authority.js";
import type { CheckAccess } from "./check-access.js";
import { checkAccessOf } from "./check-access.js";
import type { Store } from "./store.js";
import { refArchived } from "./task-archive.js";

export type CheckAuthorization = { id: number; taskRef: number; run: number; candidate: string; commandDigest: string; level: "quick" | "full"; access: CheckAccess; scopeDigest: string; expiresAt: string; usedRequest: number | null };

export function readAuthorization(row: Record<string, unknown>): CheckAuthorization {
  return { id: Number(row["id"]), taskRef: Number(row["task_ref"]), run: Number(row["run"]), candidate: String(row["candidate"]), commandDigest: String(row["command_digest"]),
    level: row["level"] === "quick" ? "quick" : "full", access: checkAccessOf(row["check_access"]), scopeDigest: String(row["scope_digest"]), expiresAt: String(row["expires_at"]),
    usedRequest: row["used_request"] === null || row["used_request"] === undefined ? null : Number(row["used_request"]) };
}

/** The approval an authorization stands on: the plan's seal, on these exact bytes, still standing as dispatch reads it. */
export function approvedScopeStands(store: Store, taskRef: number, scopeDigest: string, now: Date): boolean {
  const stamp = now.toISOString();
  return store.handle.prepare(`SELECT 1 AS hit FROM task_scope JOIN task_ref ON task_ref.id = ? AND task_scope.task_id = task_ref.external_id
    WHERE task_scope.digest = ? AND task_scope.approved_digest = task_scope.digest AND task_scope.approved_at IS NOT NULL
      AND ${authorityStandsSql("task_scope", "task_ref.repo", "?")}`).get(taskRef, scopeDigest, stamp, stamp, stamp, stamp) !== undefined;
}

/** The plain reason an authorization doesn't stand, or null: this exact commit and command, on the result it was
 * written for, under the same standing approval, not put away. */
export function authorizationProblem(store: Store, auth: CheckAuthorization, input: { head: string; digest: string }, now: Date): string | null {
  if (auth.candidate !== input.head) return "The commit changed.";
  if (auth.commandDigest !== input.digest) return "The approved check changed.";
  if (refArchived(store, auth.taskRef)) return "This task is put away.";
  if (!approvedScopeStands(store, auth.taskRef, auth.scopeDigest, now)) return "Its approval no longer stands.";
  return null;
}

/** At the run: the used authorization this request claimed. */
export function recheckStanding(store: Store, input: { request: number; runId: number; head: string; digest: string }): { ok: true; access: CheckAccess } | { ok: false; problem: string } {
  const row = store.handle.prepare("SELECT * FROM check_authorization WHERE used_request = ? AND run = ?").get(input.request, input.runId);
  if (row === undefined) return { ok: false, problem: "Its authorization couldn't be read." };
  const auth = readAuthorization(row);
  const problem = authorizationProblem(store, auth, input, new Date());
  return problem === null ? { ok: true, access: auth.access } : { ok: false, problem };
}
