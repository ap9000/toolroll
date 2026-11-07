/**
 * Automatic recheck under a check-only authorization (docs/plans/plain-toolroll.md P2.2).
 *
 * When a build finishes, the approval that built its commit writes one authorization: this task, this exact commit, the
 * approved check command's digest, the access the build's own check had, one automatic run, and an expiry. It never
 * seals anything and starts no build and no agent: it asks the follow-up check road (result-follow-ups.ts), which checks
 * the commit out in a fresh folder and runs the approved command, nothing else.
 *
 * The sweep uses it only when the result's verdict is missing or unreadable. A failed, passed or running check needs
 * nothing, and closes it. The claim (used_at, compare-and-swap in the transaction that asks) is the cap: a second worker
 * or a crash after the claim finds it spent, and the need stays with the person. A changed command is a different
 * digest, so the old authorization covers nothing: Run checks on the new command is the person's act.
 */
import { assignmentChecksForRun } from "./assignment.js";
import { runCheckLevel, repoOfRun, checkCommandFor } from "./check-levels.js";
import { approvedScopeStands, authorizationProblem, readAuthorization } from "./check-only-standing.js";
import { requestFollowUpChecks } from "./result-follow-ups.js";
import { releaseCheckScope } from "./scope.js";
import { refArchived } from "./task-archive.js";
import { approvedCheckStateOf } from "./task-status.js";
import type { Store } from "./store.js";

/** How long a recheck may still start after its build finished. */
export const CHECK_ONLY_WINDOW_MS = 24 * 60 * 60_000;
export const RECHECK_ACTOR = "Toolroll";

/**
 * Written only from the existing approval of this exact commit: the seal this run was admitted under, still standing,
 * on the bytes this run built. Null when anything is missing, and the person's Run checks stays the only road.
 */
export function authorizeCheckOnly(store: Store, runId: number, now: Date): number | null {
  return store.transact(() => {
    const run = store.getRun(runId);
    if (run === null || run.role !== "builder" || run.outcome !== "built" || run.headRevision === null || !/^[a-f0-9]{40}$/.test(run.headRevision)) return null;
    const ref = store.refById(run.taskRef);
    if (ref === null || ref.repo === null || refArchived(store, ref.id)) return null;
    const scope = store.getScope(ref.externalId);
    if (scope === null || scope.approvedDigest !== scope.digest || run.scopeDigest !== scope.digest) return null;
    // A release's check has its own road (check-failure.ts), and the nightly's its own.
    if (releaseCheckScope(scope) || scope.releaseTerms != null) return null;
    if (!approvedScopeStands(store, ref.id, scope.digest, now)) return null;
    const level = runCheckLevel(store, runId);
    if (level === "off") return null;
    const chosen = checkCommandFor(store, ref.repo, level ?? "full");
    if (chosen.command === null || chosen.level === "off") return null;
    const written = store.handle.prepare(`INSERT INTO check_authorization (task_ref, run, candidate, command_digest, level, check_access, scope_digest, written_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (task_ref, candidate, command_digest) DO NOTHING`)
      .run(ref.id, runId, run.headRevision, chosen.command.digest, chosen.level, store.runCheckAccess(runId), scope.digest, now.toISOString(), new Date(now.getTime() + CHECK_ONLY_WINDOW_MS).toISOString());
    return Number(written.changes) > 0 ? Number(written.lastInsertRowid) : null;
  });
}

/** Claim one authorization and ask for its check, in one transaction. Null: nothing was asked. */
export function claimRecheck(store: Store, authorization: number, now: Date): { request: number } | null {
  return store.transact(() => {
    const row = store.handle.prepare("SELECT * FROM check_authorization WHERE id = ? AND used_at IS NULL AND closed_at IS NULL AND expires_at > ?").get(authorization, now.toISOString());
    if (row === undefined) return null;
    const auth = readAuthorization(row);
    const run = store.getRun(auth.run);
    const repo = repoOfRun(store, auth.run);
    if (run === null || repo === null || store.lastBuilderRun(auth.taskRef)?.id !== auth.run || store.hasLiveClaim(auth.taskRef, now)) return null;
    const live = checkCommandFor(store, repo, auth.level).command;
    if (live === null || authorizationProblem(store, auth, { head: run.headRevision ?? "", digest: live.digest }, now) !== null) return null;
    const asked = requestFollowUpChecks(store, { runId: auth.run, level: auth.level, actor: RECHECK_ACTOR, why: "recheck" }, now);
    // An existing request is the person's own: it stands, and this authorization isn't spent on it.
    if (!asked.ok || asked.existing) return null;
    const spent = store.handle.prepare("UPDATE check_authorization SET used_at = ?, used_request = ? WHERE id = ? AND used_at IS NULL").run(now.toISOString(), asked.request, auth.id);
    if (Number(spent.changes) !== 1) throw new Error("the recheck's authorization moved inside its own transaction");
    return { request: asked.request };
  });
}

/** Each sweep: a standing authorization whose result has no readable verdict asks for its one check. */
export function requestMissingRechecks(store: Store, root: string, now: Date): number {
  const open = store.handle.prepare("SELECT * FROM check_authorization WHERE used_at IS NULL AND closed_at IS NULL AND expires_at > ? ORDER BY id").all(now.toISOString());
  let asked = 0;
  for (const row of open) {
    const auth = readAuthorization(row);
    const run = store.getRun(auth.run);
    if (run === null || run.finishedAt === null) continue;
    const state = approvedCheckStateOf(assignmentChecksForRun(store, root, auth.run, now));
    if (state === "not-run" || state === "unreadable") { if (claimRecheck(store, auth.id, now) !== null) asked++; continue; }
    if (state !== "running") store.handle.prepare("UPDATE check_authorization SET closed_at = ? WHERE id = ? AND used_at IS NULL").run(now.toISOString(), auth.id);
  }
  return asked;
}
