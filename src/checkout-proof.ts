/**
 * A running attempt's checkout, proved to be on this machine (docs/plans/agents-cockpit.md phase E): the run is live
 * under the task's current claim, its worktree row is this machine's runner's and this task's, and the path is its own
 * real path, a directory inside this machine's pool. Used to offer "copy the cd command" and "Show in Finder" — and
 * proved again immediately before Finder is asked to reveal it. Nothing is ever launched in it.
 */
import { lstatSync, realpathSync } from "node:fs";
import type { Store } from "./store.js";

export type CheckoutProof = { ok: true; path: string } | { ok: false; reason: string };

export function localCheckoutOf(store: Store, runId: number, local: { runner?: string | undefined; poolRoot?: string | undefined }, now: Date): CheckoutProof {
  if (local.runner === undefined || local.poolRoot === undefined) return { ok: false, reason: "this console doesn't run builds on this machine" };
  const run = store.getRun(runId);
  if (run === null || run.outcome !== null || run.worktree === null) return { ok: false, reason: "this attempt has no running checkout" };
  if (store.currentLiveLease(run.taskRef, now) !== run.leaseId) return { ok: false, reason: "this attempt isn't the one running now" };
  const row = store.getWorktree(run.worktree);
  if (row === null || row.taskRef !== run.taskRef) return { ok: false, reason: "the checkout isn't where the record says" };
  if (row.runner !== local.runner) return { ok: false, reason: "this attempt runs on another computer" };
  try {
    const real = realpathSync(run.worktree), pool = realpathSync(local.poolRoot);
    if (real !== run.worktree || !(real === pool || real.startsWith(`${pool}/`)) || !lstatSync(real).isDirectory()) return { ok: false, reason: "the checkout isn't inside this machine's pool" };
    return { ok: true, path: real };
  } catch { return { ok: false, reason: "the checkout couldn't be found on this machine" }; }
}

/** The command to paste into a terminal: `cd` to the path as one single-quoted shell word (a quote inside escaped). */
export function cdCommandOf(path: string): string {
  return `cd '${path.replaceAll("'", `'\\''`)}'`;
}
