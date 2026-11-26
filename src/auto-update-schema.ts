/**
 * v187: automatic Toolroll updates (Settings → Updates, "Update automatically"; auto-update.ts). Adds two tables and
 * changes no saved row:
 *
 * - `auto_update_policy`: one row once a person chose (no row reads off, so a new install and an upgraded one start
 *   with automatic updates off), with its revision, who chose and when. Every change is also in action_ledger.
 * - `auto_update_attempt`: one row per release version an automatic update was ever reserved for (UNIQUE version), so
 *   a failed, restored or rolled-back release is never tried automatically again. Reserved before anything is
 *   prepared or launched; its journal id, launch time and outcome are each written once (a trigger refuses any other
 *   change) and the row is never deleted.
 *
 * Kept apart from the store so the update road can read the lists without it.
 */

export const V187_SCHEMA = `
CREATE TABLE IF NOT EXISTS auto_update_policy (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL CHECK (enabled IN (0,1)),
  revision   INTEGER NOT NULL CHECK (revision >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auto_update_attempt (
  id              INTEGER PRIMARY KEY,
  version         TEXT NOT NULL UNIQUE CHECK (version GLOB '[0-9]*.[0-9]*.[0-9]*' AND version NOT GLOB '*[^0-9.]*'),
  from_version    TEXT NOT NULL,
  enabled_by      TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  reserved_at     TEXT NOT NULL,
  journal_id      TEXT CHECK (journal_id IS NULL OR (length(journal_id) = 36 AND journal_id NOT GLOB '*[^0-9a-f-]*')),
  launched_at     TEXT,
  outcome         TEXT CHECK (outcome IS NULL OR outcome IN ('complete','restored','refused','cancelled','rolled-back','not-started','unknown')),
  outcome_at      TEXT,
  detail          TEXT
);
CREATE TRIGGER IF NOT EXISTS auto_update_attempt_write_once BEFORE UPDATE ON auto_update_attempt
WHEN NEW.id IS NOT OLD.id OR NEW.version IS NOT OLD.version OR NEW.from_version IS NOT OLD.from_version OR NEW.enabled_by IS NOT OLD.enabled_by
  OR NEW.policy_revision IS NOT OLD.policy_revision OR NEW.reserved_at IS NOT OLD.reserved_at
  OR (OLD.journal_id IS NOT NULL AND NEW.journal_id IS NOT OLD.journal_id)
  OR (OLD.launched_at IS NOT NULL AND NEW.launched_at IS NOT OLD.launched_at)
  OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS NOT OLD.outcome OR NEW.outcome_at IS NOT OLD.outcome_at OR NEW.detail IS NOT OLD.detail))
BEGIN
  SELECT RAISE(ABORT, 'An automatic update attempt is written once');
END;
CREATE TRIGGER IF NOT EXISTS auto_update_attempt_no_delete BEFORE DELETE ON auto_update_attempt
BEGIN
  SELECT RAISE(ABORT, 'Automatic update attempts are kept');
END;
`;

export const V187_TABLES = Object.freeze(["auto_update_policy", "auto_update_attempt"] as const);

/** The v187 migration's steps, in order (a test seam may stop after each). */
export const V187_STEPS = Object.freeze(["auto-update"] as const);

/** v187's named objects, as a current or resumed file must hold them exactly (store.ts checks each). */
export const V187_OBJECTS = Object.freeze([
  ["table", "auto_update_policy"],
  ["table", "auto_update_attempt"],
  ["trigger", "auto_update_attempt_write_once"],
  ["trigger", "auto_update_attempt_no_delete"],
] as const);
