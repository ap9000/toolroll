/**
 * v186: Installation-wide Skill Library (all projects by default, with per-project opt-out), pinned GitHub repository
 * bundle imports (supporting 59+ skills such as pstack), daily auto-update sweep with suspicion hold and one-step
 * rollback, and "Also install on this computer" local sync for Claude Code, Codex and Gemini CLI.
 *
 * Additive only: adds four new tables and two immutability triggers, changing no saved row.
 */
export const V186_SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_library_change (
  revision INTEGER PRIMARY KEY CHECK (revision >= 1),
  actor    TEXT NOT NULL,
  at       TEXT NOT NULL,
  payload  TEXT NOT NULL,
  sha      TEXT NOT NULL,
  source   TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bundle-import', 'auto-update', 'rollback'))
);
CREATE TRIGGER IF NOT EXISTS skill_library_change_no_update BEFORE UPDATE ON skill_library_change
BEGIN
  SELECT RAISE(ABORT, 'Skill library history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS skill_library_change_no_delete BEFORE DELETE ON skill_library_change
BEGIN
  SELECT RAISE(ABORT, 'Skill library history is immutable');
END;
CREATE TABLE IF NOT EXISTS skill_project_opt_out (
  repo       TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  actor      TEXT NOT NULL,
  at         TEXT NOT NULL,
  PRIMARY KEY (repo, skill_name)
);
CREATE TABLE IF NOT EXISTS skill_bundle (
  id                TEXT PRIMARY KEY,
  repo_url          TEXT NOT NULL,
  owner             TEXT NOT NULL,
  repo_name         TEXT NOT NULL,
  branch            TEXT NOT NULL,
  subpath           TEXT NOT NULL DEFAULT '',
  pinned_commit     TEXT NOT NULL CHECK (length(pinned_commit) = 40 AND pinned_commit NOT GLOB '*[^0-9a-f]*'),
  previous_commit   TEXT CHECK (previous_commit IS NULL OR (length(previous_commit) = 40 AND previous_commit NOT GLOB '*[^0-9a-f]*')),
  previous_revision INTEGER,
  skill_names_json  TEXT NOT NULL,
  auto_update       INTEGER NOT NULL DEFAULT 1 CHECK (auto_update IN (0, 1)),
  last_checked_at   TEXT,
  last_updated_at   TEXT,
  held_commit       TEXT CHECK (held_commit IS NULL OR (length(held_commit) = 40 AND held_commit NOT GLOB '*[^0-9a-f]*')),
  held_reason       TEXT,
  held_at           TEXT,
  actor             TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_local_sync (
  tool            TEXT PRIMARY KEY CHECK (tool IN ('claude', 'codex', 'gemini')),
  enabled         INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  target_dir      TEXT,
  installed_json  TEXT NOT NULL DEFAULT '{}',
  synced_revision INTEGER NOT NULL DEFAULT 0,
  synced_at       TEXT,
  updated_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
`;

export const V186_TABLES = Object.freeze([
  "skill_library_change",
  "skill_project_opt_out",
  "skill_bundle",
  "skill_local_sync",
] as const);

/** The v186 migration's steps, in order (a test seam may stop after each). */
export const V186_STEPS = Object.freeze(["skill-library"] as const);

/** v186's named objects, as a current or resumed file must hold them exactly (store.ts checks each). */
export const V186_OBJECTS = Object.freeze([
  ["table", "skill_library_change"],
  ["trigger", "skill_library_change_no_update"],
  ["trigger", "skill_library_change_no_delete"],
  ["table", "skill_project_opt_out"],
  ["table", "skill_bundle"],
  ["table", "skill_local_sync"],
] as const);
