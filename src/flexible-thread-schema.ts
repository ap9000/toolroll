/**
 * v162: Flexible threads' own repositories (the Flexible plan v2 §1, slice F2a). Adds only a table: no saved row
 * changes, and nothing reads it while Flexible isn't available (flexible-available.ts). Kept apart from the store so the
 * update road can read the lists without it.
 *
 * - `flexible_thread`: one row per thread repository Toolroll made (flexible-thread.ts). `repo` is the registered
 *   project it reads from; `base_sha` the commit its branch starts at, held alive in the project's repository by
 *   `keep_ref` (refs/toolroll/threads/<id>/base); `folder` the real path of the thread's own folder under the state
 *   folder's `threads`. The row is the record every later use takes its paths from, never the thread's own folder.
 *   `state` only moves forward: preparing → ready → removing → removed, or to failed; the repository, base, ref and
 *   folder are written once. `live_pid` is the process group leader of the thread's last launch (registered under the
 *   thread's lock as it is spawned): removal refuses while that group may still be alive.
 */
export const V162_SCHEMA = `
CREATE TABLE IF NOT EXISTS flexible_thread (
  id          TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  repo        TEXT NOT NULL,
  base_sha    TEXT NOT NULL CHECK (length(base_sha) IN (40, 64) AND base_sha NOT GLOB '*[^0-9a-f]*'),
  keep_ref    TEXT NOT NULL CHECK (keep_ref = 'refs/toolroll/threads/' || id || '/base'),
  folder      TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'removing', 'removed', 'failed')),
  ended_at    TEXT,
  end_detail  TEXT CHECK (end_detail IS NULL OR length(end_detail) <= 2000),
  live_pid    INTEGER CHECK (live_pid IS NULL OR live_pid > 0),
  live_since  TEXT,
  CHECK ((live_pid IS NULL) = (live_since IS NULL)),
  CHECK ((ended_at IS NULL) = (state IN ('preparing', 'ready', 'removing')))
);
CREATE INDEX IF NOT EXISTS flexible_thread_repo ON flexible_thread (repo, state);
CREATE TRIGGER IF NOT EXISTS flexible_thread_written_once BEFORE UPDATE ON flexible_thread
WHEN NEW.id IS NOT OLD.id OR NEW.repo IS NOT OLD.repo OR NEW.base_sha IS NOT OLD.base_sha OR NEW.keep_ref IS NOT OLD.keep_ref
  OR NEW.folder IS NOT OLD.folder OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR OLD.state IN ('removed', 'failed')
  OR (OLD.state = 'removing' AND NEW.state NOT IN ('removing', 'removed', 'failed'))
  OR (OLD.state = 'ready' AND NEW.state = 'preparing')
BEGIN
  SELECT RAISE(ABORT, 'a flexible thread''s repository is written once and its state only moves forward');
END;
`;

export const V162_TABLES = Object.freeze(["flexible_thread"] as const);
/** The v162 migration's steps, in order (a test seam may stop after each). */
export const V162_STEPS = Object.freeze(["flexible-thread"] as const);
