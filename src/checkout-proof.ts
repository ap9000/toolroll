/**
 * A running attempt's checkout, proved to be on this machine (docs/plans/agents-cockpit.md phase E): the run is live
 * under the task's current claim, its worktree row is this machine's runner's and this task's, and the path is its own
 * real path, a directory inside this machine's pool. Used to offer "copy the cd command" and "Show in Finder" — and
 * proved again immediately before Finder is asked to reveal it. Nothing is ever launched in it.
 */
import { execFile } from "node:child_process";
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
  // The run, its worktree row and this machine all name the same runner: an inconsistent record fails closed.
  if (run.runner !== local.runner || row.runner !== local.runner) return { ok: false, reason: "this attempt runs on another computer" };
  try {
    const real = realpathSync(run.worktree), pool = realpathSync(local.poolRoot);
    // Strictly inside: the pool directory itself is never a checkout.
    if (real !== run.worktree || !real.startsWith(`${pool}/`) || !lstatSync(real).isDirectory()) return { ok: false, reason: "the checkout isn't inside this machine's pool" };
    return { ok: true, path: real };
  } catch { return { ok: false, reason: "the checkout couldn't be found on this machine" }; }
}

/** How Finder is asked: the system's own `open` by absolute path (never found through PATH), from the root directory,
 * with a minimal environment, one argument. True only when it answered success before the deadline: at the deadline
 * the answer is "not shown", the child is killed outright, and anything it says later is ignored. */
export type RevealExec = (file: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }, done: (error: Error | null) => void) => { kill: (signal: NodeJS.Signals) => unknown } | undefined;
export const REVEAL_COMMAND = "/usr/bin/open";
export const REVEAL_DEADLINE_MS = 10_000;
export function revealInFinder(path: string, run: RevealExec = (file, args, options, done) => execFile(file, [...args], options, error => done(error)), deadlineMs = REVEAL_DEADLINE_MS, clock: () => number = () => performance.now()): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    let child: ReturnType<RevealExec>;
    // The deadline is a moment on a monotonic clock, not the timer having run: a success that arrives after it (even
    // ahead of an overdue timer, in a stalled event loop) is "not shown".
    const due = clock() + deadlineMs;
    const finish = (shown: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(shown); };
    const timer = setTimeout(() => { finish(false); try { child?.kill("SIGKILL"); } catch { /* already gone */ } }, deadlineMs);
    try { child = run(REVEAL_COMMAND, ["-R", path], { cwd: "/", env: { PATH: "/usr/bin:/bin" } }, error => finish(error === null && clock() < due)); }
    catch { finish(false); }
  });
}

/** Whether this console can ask Finder at all (a Mac, or a test's own revealer). */
export const canReveal = (injected: boolean): boolean => injected || process.platform === "darwin";

/** The command to paste into a terminal: `cd` to the path as one single-quoted shell word (a quote inside escaped). */
export function cdCommandOf(path: string): string {
  return `cd '${path.replaceAll("'", `'\\''`)}'`;
}
