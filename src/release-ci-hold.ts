/** A release's approval held for its pull request's CI (Codex review round 1, finding 4). A leaf module: the seal
 * primitive (store.ts), the person's ceremony (scope.ts), chat and release-auto.ts all read the same row. */
import type { Store } from "./store.js";

/**
 * A release filed while its pull request's CI was still running (pipeline-speed.md D2) waits for CI before anyone but
 * the automatic road may approve it (Codex review round 1, finding 4): `release-auto.ts holdApprovalForCi` records the
 * hold before the task is filed, and only the plane's own reading of exact-head CI passing lifts it
 * (`liftCiHold`). The newest row for the task wins; the hold names the candidate commit it waits on.
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
