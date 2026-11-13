/**
 * v160: Settings → Advanced, "Show advanced features" (docs: the eight plan, W4). Adds only a table: a saved row reads
 * as it did. Kept beside nothing else so the update road can read the lists without the store, and so the version is
 * easy to renumber.
 *
 * - `view_preference`: one row per person (the approver row's stable name, never reused): whether that person's pages
 *   show the advanced entry points. `source` says where the row came from: `upgrade` (the migration, once, for every
 *   account that existed before this version, so nobody loses a menu item they had) or `person` (that person chose).
 *   No row reads off, except on the demo. Upgrade rows carry no time: the default is never decided by a timestamp
 *   (approver.added_at moves when a credential is replaced). The row goes when the account is removed.
 */
export const V160_SCHEMA = `
CREATE TABLE IF NOT EXISTS view_preference (
  account    TEXT PRIMARY KEY,
  advanced   INTEGER NOT NULL CHECK (advanced IN (0, 1)),
  source     TEXT NOT NULL CHECK (source IN ('upgrade', 'person')),
  updated_at TEXT
);
`;

/** The one-time backfill: every account present when the table is made keeps everything it saw (ON). Revoked accounts
 * can't sign in again, so they get none. Runs in the same transaction as the table's creation. */
export const V160_BACKFILL = `INSERT OR IGNORE INTO view_preference (account, advanced, source, updated_at)
  SELECT name, 1, 'upgrade', NULL FROM approver WHERE revoked_at IS NULL`;

export const V160_TABLES = Object.freeze(["view_preference"] as const);
/** The v160 migration's steps, in order (a test seam may stop after each). */
export const V160_STEPS = Object.freeze(["advanced-preference"] as const);
