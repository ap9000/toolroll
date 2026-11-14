/**
 * v161: Flexible projects' terms (the Flexible plan v2, slice F1). Adds only a table: every saved project reads Secure
 * (no row), as it did. Kept apart from the store so the update road can read the lists without it.
 *
 * - `flexible_terms`: one row per signed or lowered set of terms for a project. `signed_terms_json` / `signed_digest`
 *   are the exact bytes a person signed with their password; `terms_json` / `digest` are the terms in force (the same
 *   bytes, or a narrower copy after someone lowered them: `changed_by`, `derived_from`). At most one row per project is
 *   live (`ended_at` NULL). A row is written once; it only ever ends, once, with a reason (`off`, `lowered`,
 *   `replaced`, `lapsed`). Unreadable terms are never read as a level (flexible.ts).
 */
export const V161_SCHEMA = `
CREATE TABLE IF NOT EXISTS flexible_terms (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  repo              TEXT NOT NULL,
  terms_json        TEXT NOT NULL CHECK (length(terms_json) <= 16384),
  digest            TEXT NOT NULL,
  signed_terms_json TEXT NOT NULL CHECK (length(signed_terms_json) <= 16384),
  signed_digest     TEXT NOT NULL,
  signed_by         TEXT NOT NULL,
  signed_at         TEXT NOT NULL,
  proof             TEXT NOT NULL CHECK (proof IN ('password-now', 'sso-now')),
  changed_by        TEXT NOT NULL,
  changed_at        TEXT NOT NULL,
  derived_from      INTEGER,
  ended_at          TEXT,
  ended_by          TEXT,
  end_reason        TEXT CHECK (end_reason IS NULL OR end_reason IN ('off', 'lowered', 'replaced', 'lapsed')),
  end_detail        TEXT,
  CHECK ((ended_at IS NULL) = (end_reason IS NULL) AND (ended_at IS NULL) = (ended_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS flexible_terms_live ON flexible_terms (repo) WHERE ended_at IS NULL;
CREATE TRIGGER IF NOT EXISTS flexible_terms_written_once BEFORE UPDATE ON flexible_terms
WHEN OLD.ended_at IS NOT NULL OR NEW.repo IS NOT OLD.repo OR NEW.terms_json IS NOT OLD.terms_json OR NEW.digest IS NOT OLD.digest
  OR NEW.signed_terms_json IS NOT OLD.signed_terms_json OR NEW.signed_digest IS NOT OLD.signed_digest OR NEW.signed_by IS NOT OLD.signed_by
  OR NEW.signed_at IS NOT OLD.signed_at OR NEW.proof IS NOT OLD.proof OR NEW.changed_by IS NOT OLD.changed_by
  OR NEW.changed_at IS NOT OLD.changed_at OR NEW.derived_from IS NOT OLD.derived_from OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'flexible terms are written once and end once');
END;
`;

export const V161_TABLES = Object.freeze(["flexible_terms"] as const);
/** The v161 migration's steps, in order (a test seam may stop after each). */
export const V161_STEPS = Object.freeze(["flexible-terms"] as const);
