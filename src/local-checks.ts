/**
 * Run checks from this computer's local owner session on a solo install (everyday 9, A6): the already-approved check
 * command, run again on a result's exact commit, with no password. It approves nothing and changes no command (setting
 * or changing a check still takes the password); it re-runs what an approver already approved.
 *
 * - Who: the local owner, in its own live session, as the exact act `run-checks`, on an install that is solo with local
 *   mode on, for work the owner could approve again now without a password (scope.ts localWorkEligible, the retry
 *   rule: not a release, not protected or two-person work, not escalated, not a coordinator's or an imported task, and
 *   never a project whose checks run without a sandbox). Read inside the request's own transaction.
 * - The ceiling, at every command the worker launches (result-follow-ups.ts, as an automatic recheck's is): such a
 *   request never runs wider than `sign-ins`, and only while the install is still solo with local mode on. A project
 *   raised to unsandboxed after the request runs nothing of it.
 */
import type { CheckAccess } from "./check-access.js";
import { soloNow } from "./install-mode.js";
import { localModeOn } from "./local-owner.js";
import { localWorkEligible, type LocalApprovalRefusal } from "./scope.js";
import type { Store } from "./store.js";

/** The widest a local owner's Run checks ever runs. */
export const LOCAL_CHECKS_CEILING: CheckAccess = "sign-ins";

const WORDS: Readonly<Record<LocalApprovalRefusal | "team", string>> = {
  team: "Running checks without a password works only on a solo install. Sign in with your password to run them.",
  "local-mode-off": "Local mode is off, so running checks needs your password.",
  "not-owner": "Only this computer's owner runs checks here without a password.",
  "no-scope": "This task has no approved plan, so running its checks needs your password.",
  release: "Running a release's checks needs your password.",
  protected: "This is protected work, so running its checks needs your password.",
  escalated: "Work with wider permissions needs your password to run its checks.",
  coordinator: "Work a coordinator filed needs your password to run its checks.",
  unsandboxed: "This project's checks run without a sandbox, so running them needs your password.",
  imported: "A task from outside needs your password to run its checks.",
};

/** Why the local owner may not run this task's checks without a password, or null. Read in the caller's transaction. */
export function localChecksRefusal(store: Store, by: string, taskId: string): string | null {
  if (!soloNow(store)) return WORDS.team;
  const eligible = localWorkEligible(store, by, taskId, { act: "retry" });
  return eligible.ok ? null : WORDS[eligible.reason];
}

/** At launch: the ceiling a local owner's request runs under, while the install still allows it. */
export function localChecksStanding(store: Store): { ok: true; access: CheckAccess } | { ok: false; problem: string } {
  if (!soloNow(store) || !localModeOn(store)) return { ok: false, problem: "Asked for without a password, and the install is no longer solo with local mode on, so they didn't run." };
  return { ok: true, access: LOCAL_CHECKS_CEILING };
}
