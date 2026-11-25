/**
 * v180: a task's pending model change (docs/plans/mac-change-models.md, "Revised after critic review"). Adds one table and
 * changes no saved row:
 *
 * - `pending_agent_change`: at most one row per task, written by the laptop owner's model pick while a run holds the task
 *   (`next-run`: when this run ends; `restart`: the run was asked to stop). It carries the exact pick, the scope digest the
 *   person picked against, the run that held the task, and the local-mode and account generations the pick was made
 *   under; the change is applied as that person once the claim is gone (local-owner-acts.ts applyPendingAgentChanges),
 *   and the row cleared on success, a newer pick, cancel or archive. A refused apply keeps the row with `problem`.
 *
 * Kept apart from the store so the update road can read the lists without it.
 */

export const V180_SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_agent_change (
  task_ref           INTEGER PRIMARY KEY REFERENCES task_ref(id),
  phase              TEXT NOT NULL CHECK (phase IN ('plan', 'build')),
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  apply_when         TEXT NOT NULL CHECK (apply_when IN ('next-run', 'restart')),
  saw_digest         TEXT NOT NULL,
  run                INTEGER REFERENCES run(id),
  by                 TEXT NOT NULL,
  local_generation   INTEGER NOT NULL,
  account_generation INTEGER NOT NULL,
  transport          TEXT NOT NULL CHECK (transport IN ('browser', 'terminal')),
  at                 TEXT NOT NULL,
  problem            TEXT
);
`;

export const V180_TABLES = Object.freeze(["pending_agent_change"] as const);
/** The v180 migration's steps, in order (a test seam may stop after each). */
export const V180_STEPS = Object.freeze(["pending-agent-change"] as const);
