/**
 * v171: interactive agent threads' installation switch (Settings → General, "Interactive agent threads (beta)";
 * flexible-available.ts). Adds one table and changes no saved row:
 *
 * - `flexible_setting`: one row once a person chose (no row reads off, so a new install and an upgraded one start with
 *   threads off until a person's step-up turns them on), with who chose and when. Every change is also in action_ledger.
 *
 * Kept apart from the store so the update road can read the lists without it.
 */

export const V171_SCHEMA = `
CREATE TABLE IF NOT EXISTS flexible_setting (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL CHECK (enabled IN (0,1)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const V171_TABLES = Object.freeze(["flexible_setting"] as const);
/** The v171 migration's steps, in order (a test seam may stop after each). */
export const V171_STEPS = Object.freeze(["flexible-setting"] as const);
