/**
 * Why a release can't be approved now, from the plane's own state (release-approval.ts re-exports all of it): the
 * coordinator's GitHub CI reading on the exact candidate, and the one list of refusals the release sheet shows and every
 * approval road applies (scope.ts approve() reads `releaseApprovalRefusal` inside its transaction). Kept apart from
 * release-approval.ts so scope.ts reads it without importing the card machinery (an import cycle through store.ts).
 */
import { releaseCiHoldOf, releaseCiHoldWords } from "./release-ci-hold.js";
import type { Scope } from "./scope.js";
import type { Store } from "./store.js";
import { taskArchived } from "./task-archive.js";
import { cleanTerminalLine } from "./terminal-text.js";

/** The ledger act holding the coordinator's latest reading of the pull request's CI on the exact candidate. */
export const RELEASE_CI_SEEN_ACTION = "release CI observed";

/** One check's newest attempt, as the coordinator's own gh read it. A re-run is a new check run id. */
export type ReleaseCiRun = { id: number | null; name: string; status: string; conclusion: string | null };
export type ReleaseCiSnapshot = { candidate: string; at: string; state: "passed" | "running" | "failed"; failed: string[]; runs: ReleaseCiRun[] };

export const ciName = (value: unknown): string => cleanTerminalLine(String(value ?? "")).trim().slice(0, 120);

/** The coordinator's latest CI reading for this task on exactly `candidate`, or null (not read yet, or another commit). */
export function releaseCiOf(store: Store, taskId: string, candidate: string): ReleaseCiSnapshot | null {
  const row = store.handle.prepare("SELECT detail, at FROM action_ledger WHERE task_id = ? AND action = ? ORDER BY id DESC LIMIT 1").get(taskId, RELEASE_CI_SEEN_ACTION);
  if (row === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(String(row["detail"])); } catch { return null; }
  const one = parsed as { v?: unknown; candidate?: unknown; state?: unknown; failed?: unknown; runs?: unknown };
  if (one.v !== 1 || one.candidate !== candidate || !["passed", "running", "failed"].includes(String(one.state)) || !Array.isArray(one.failed) || !Array.isArray(one.runs)) return null;
  return { candidate, at: String(row["at"]), state: one.state as ReleaseCiSnapshot["state"], failed: one.failed.map(ciName),
    runs: one.runs.map(run => { const r = run as Record<string, unknown>; return { id: typeof r["id"] === "number" ? r["id"] : null, name: ciName(r["name"]), status: ciName(r["status"]), conclusion: r["conclusion"] == null ? null : ciName(r["conclusion"]) }; }) };
}

/** GitHub CI in one line, as the sheet and the CLI say it. */
export function ciWords(ci: ReleaseCiSnapshot | null, candidate: string): string {
  const short = candidate.slice(0, 7);
  if (ci === null) return `GitHub CI on ${short} hasn't been read yet.`;
  if (ci.state === "passed") return `GitHub CI passed on ${short}.`;
  if (ci.state === "failed") return `GitHub CI failed on ${short}: ${ci.failed.join(", ") || "a check"}.`;
  const finished = ci.runs.filter(run => run.status === "completed").length;
  return `GitHub CI is running on ${short}: ${finished} of ${ci.runs.length} checks finished.`;
}

/** The release check failed on this task already (the coordinator's record): nobody approves it again here. */
function checkFailed(store: Store, taskId: string): boolean {
  return store.handle.prepare("SELECT 1 FROM release_step WHERE task_id = ? AND step = 'check' AND state = 'failed' LIMIT 1").get(taskId) !== undefined;
}

/** Why a release can't be approved now, from the plane's own state, or null. */
export function refusalOf(store: Store, taskId: string, scope: Scope, ci: ReleaseCiSnapshot | null): string | null {
  if (taskArchived(store, taskId)) return "This release is put away. Restore it before approving.";
  const hold = releaseCiHoldOf(store, taskId);
  if (hold !== null) return releaseCiHoldWords(hold);
  if (ci?.state === "failed") return `${ciWords(ci, scope.candidate!)} Fix the branch or rerun the failed job on GitHub, then release again.`;
  if (checkFailed(store, taskId)) return "The release check already failed on this commit. Fix the branch and release the new commit.";
  if (scope.approvedAt !== null && scope.approvedDigest !== scope.digest) return "The release's terms changed after an earlier approval. Read them again.";
  return null;
}

/**
 * The release refusals every approval road shares (scope.ts approve(), read inside its transaction): for a scope
 * sealing release terms or a release check's purpose, the sheet's own reasons in the sheet's own words, so the task
 * page, Home's in-place yes, chat and `toolroll task approve` refuse exactly what `/t/<id>/release` refuses. Null for
 * every other scope, and for a release nothing stops. The sheet's card digest binding stays the sheet's.
 */
export function releaseApprovalRefusal(store: Store, taskId: string, scope: Scope): string | null {
  // A sealed form, as release-card.ts releaseSealOf reads it (release terms, or a release check's purpose).
  if (scope.releaseTerms == null && scope.releaseCheck == null) return null;
  return refusalOf(store, taskId, scope, scope.candidate == null ? null : releaseCiOf(store, taskId, scope.candidate));
}
