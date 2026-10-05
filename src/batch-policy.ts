/** Batch checks, the setting (batch-checks.ts runs them): off unless an approver turns it on for a project.
 * Like the check level, it is an append-only ledger entry; the newest one wins. Kept apart from the
 * runner so settings, status and the lead's facts can read it without loading the builder. */
import type { Store, VerifyCommand } from "./store.js";

/** Ledger action for the project setting. The newest entry wins; none means off. */
export const BATCH_POLICY_ACTION = "batch checks changed";
export const BATCH_WINDOW_MS = 10 * 60_000;
export const BATCH_HINT = "Results that finish within 10 minutes of each other share one full check.";

export type ProjectBatchChecks = { on: boolean; windowMs: number; setBy: string | null; at: string | null };

/** A project's batch setting. Off unless an approver turned it on. */
export function projectBatchChecks(store: Store, repo: string): ProjectBatchChecks {
  const row = store.handle.prepare("SELECT actor, at, outcome FROM action_ledger WHERE repo = ? AND task_id IS NULL AND action = ? ORDER BY id DESC LIMIT 1").get(repo, BATCH_POLICY_ACTION);
  if (row === undefined || (row["outcome"] !== "on" && row["outcome"] !== "off")) return { on: false, windowMs: BATCH_WINDOW_MS, setBy: null, at: null };
  return { on: row["outcome"] === "on", windowMs: BATCH_WINDOW_MS, setBy: String(row["actor"]), at: String(row["at"]) };
}

/** An approver's act: turn batching on or off for one project. The ledger keeps before → after. */
export function setProjectBatchChecks(store: Store, repo: string, on: boolean, by: string, now: Date): { changed: boolean; before: boolean } {
  const before = projectBatchChecks(store, repo);
  if (before.on === on) return { changed: false, before: before.on };
  store.recordAction({ at: now.toISOString(), actor: by, repo, taskId: null, runId: null, action: BATCH_POLICY_ACTION, outcome: on ? "on" : "off", source: "policy",
    detail: `Batch checks ${before.on ? "on" : "off"} → ${on ? "on" : "off"}` });
  store.bumpWake();
  return { changed: true, before: before.on };
}

/** The builder's question at its gate: does this Full check wait for a batch? */
export function batchesFullCheck(store: Store, repo: string | null, level: string, command: VerifyCommand | null): boolean {
  return repo !== null && level === "full" && command !== null && command.repo === repo && projectBatchChecks(store, repo).on;
}
