/** A release's approval held for its pull request's CI (Codex review round 1, finding 4). A leaf module: the seal
 * primitive (store.ts), the person's ceremony (scope.ts), chat and release-auto.ts all read the same row. */
import type { Store } from "./store.js";

/**
 * A release filed while its pull request's CI was still running (pipeline-speed.md D2) waits for CI before anyone but
 * the automatic road may approve it (Codex review round 1, finding 4): `release-auto.ts holdApprovalForCi` records the
 * hold before the task is filed, and only the plane's own reading of exact-head CI passing lifts it
 * (`liftCiHold`). The newest row for the task wins; the hold names the candidate commit it waits on.
 * Since Alex's decision of 2026-10-29 (a person may approve during CI) the coordinator records a "CI still running"
 * note instead (below); a hold an older coordinator placed still holds until lifted.
 */
export const RELEASE_CI_HELD_ACTION = "release approval waits for CI";
export const RELEASE_CI_PASSED_ACTION = "release approval CI passed";

/** The candidate whose CI a release task's approval waits for, or null when nothing holds it. Fail closed: a hold row
 * whose candidate can't be read still holds. */
export function releaseCiHoldOf(store: Store, taskId: string): { candidate: string | null } | null {
  const row = store.handle.prepare("SELECT action, detail FROM action_ledger WHERE task_id = ? AND action IN (?, ?) ORDER BY id DESC LIMIT 1")
    .get(taskId, RELEASE_CI_HELD_ACTION, RELEASE_CI_PASSED_ACTION);
  if (row === undefined || row["action"] !== RELEASE_CI_HELD_ACTION) return null;
  const detail = typeof row["detail"] === "string" ? row["detail"] : "";
  return { candidate: /^[0-9a-f]{40}$/.test(detail) ? detail : null };
}

/** Why a person can't approve a release waiting for CI yet, in words. */
export function releaseCiHoldWords(hold: { candidate: string | null }): string {
  const commit = hold.candidate === null ? "this release's commit" : hold.candidate.slice(0, 7);
  return `GitHub CI is still running on ${commit}. This release can be approved once every pull request check passes; \`toolroll release\` asks you then.`;
}

/**
 * A person's release asks for approval while its pull request's CI still runs (Alex, 2026-10-29; pipeline-speed.md,
 * "Decision: a person's release asks during CI"). This row never holds approval: it lets the approval card say so, until
 * the plane reads exact-head CI passing (`liftCiHold` records RELEASE_CI_PASSED_ACTION, which ends it as it ends a
 * hold). Deployment gates and operation issuance also refuse while it remains, so a direct deploy cannot bypass
 * the coordinator's CI wait. Its absence is not a CI pass: the coordinator still reads exact-head checks itself.
 */
export const RELEASE_CI_RUNNING_ACTION = "release asked while CI runs";
export const RELEASE_CI_RUNNING_WORDS = "GitHub's checks are still running; nothing deploys until they pass.";

/** The candidate whose CI was still running when the release task was filed, or null once the plane read it passing. */
export function releaseCiRunningOf(store: Store, taskId: string): { candidate: string | null } | null {
  const row = store.handle.prepare("SELECT action, detail FROM action_ledger WHERE task_id = ? AND action IN (?, ?) ORDER BY id DESC LIMIT 1")
    .get(taskId, RELEASE_CI_RUNNING_ACTION, RELEASE_CI_PASSED_ACTION);
  if (row === undefined || row["action"] !== RELEASE_CI_RUNNING_ACTION) return null;
  const detail = typeof row["detail"] === "string" ? row["detail"] : "";
  return { candidate: /^[0-9a-f]{40}$/.test(detail) ? detail : null };
}

/** Record that the release task is filed while CI runs on `candidate` (before the task exists). Idempotent. */
export function noteCiRunning(store: Store, input: { taskId: string; candidate: string; now: Date }): void {
  if (!/^[0-9a-f]{40}$/.test(input.candidate)) throw new Error("a CI note needs the exact candidate commit");
  const running = releaseCiRunningOf(store, input.taskId);
  if (running !== null && running.candidate === input.candidate) return;
  store.recordAction({ at: input.now.toISOString(), actor: "toolroll", repo: store.lookupRef(input.taskId)?.repo ?? null, taskId: input.taskId, runId: null,
    action: RELEASE_CI_RUNNING_ACTION, outcome: "running", source: "work", detail: input.candidate });
}
