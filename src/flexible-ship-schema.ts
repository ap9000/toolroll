/**
 * v168: Ship for Flexible threads (the Flexible plan v2 §1 "controlled import" and §7 "Ship is its own exact-terms
 * approval", slice F4). Adds only tables: no saved row changes, and nothing writes them while Flexible isn't available
 * (flexible-available.ts). Kept apart from the store so the update road can read the lists without it.
 *
 * - `flexible_ship`: one row per Send for checks of a thread (flexible-ship.ts), numbered `seq` 1, 2, … per thread: a
 *   person's yes to exactly the terms in `terms_json` (hashing to `digest`; `summary_key` is the approval summary's key
 *   over what was shown), the controlled import those terms allow (`candidate` fetched into the project's repository at
 *   `import_ref`, then the thread's branch `branch` moved from `branch_before` to it), and what followed. The one press
 *   is the approval: it arms a merge that Toolroll makes by itself only once the required check passes on the exact
 *   candidate. Everything but the state and what each state adds is written once. `state` only moves forward:
 *     approved → refused | failed | imported  (the import was refused in quarantine, was interrupted (a restart settles
 *                                              it, putting refs back), or wrote its refs)
 *     imported → armed | removed               (its check task was filed and sealed and the merge armed, or the import
 *                                              was taken away)
 *     armed → completed | cancelled | sent-back (the check passed on the exact candidate: completed and its pull
 *                                              request owed; or the merge's authority ended; or a person sent it back)
 *     completed → merged | cancelled | sent-back
 *   refused, failed, removed, merged, cancelled and sent-back are final: nothing is ever resurrected or re-armed.
 *   `task_id` and `scope_digest` (the verify-only task and the scope its seal bound) are set once, on `armed`; the
 *   checked head the merge is bound to (`merge_head`, `merge_at`) once, on `completed`.
 * - `flexible_ref_snapshot`: the project's refs as Toolroll last read them for a thread (at its start, and at each
 *   import), so an import can say when a ref outside refs/toolroll/ changed while the thread ran. Detection only: it
 *   decides nothing.
 */
const HEX32 = (column: string) => `length(${column}) = 32 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
const SHA = (column: string) => `length(${column}) IN (40, 64) AND ${column} NOT GLOB '*[^0-9a-f]*'`;

export const V168_SCHEMA = `
CREATE TABLE IF NOT EXISTS flexible_ship (
  id                  TEXT PRIMARY KEY CHECK (${HEX32("id")}),
  thread              TEXT NOT NULL CHECK (${HEX32("thread")}),
  seq                 INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 1000000),
  repo                TEXT NOT NULL CHECK (length(repo) BETWEEN 1 AND 4096),
  base_sha            TEXT NOT NULL CHECK (${SHA("base_sha")}),
  candidate           TEXT NOT NULL CHECK (${SHA("candidate")}),
  import_ref          TEXT NOT NULL CHECK (import_ref = 'refs/toolroll/import/' || thread || '/' || seq),
  branch              TEXT NOT NULL CHECK (branch = 'toolroll/code-' || thread),
  branch_before       TEXT CHECK (branch_before IS NULL OR (${SHA("branch_before")})),
  terms_json          TEXT NOT NULL CHECK (length(terms_json) BETWEEN 2 AND 1048576),
  digest              TEXT NOT NULL CHECK (${HEX32("digest")}),
  summary_key         TEXT NOT NULL CHECK (${HEX32("summary_key")}),
  approved_by         TEXT NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 200),
  approved_generation INTEGER NOT NULL,
  proof               TEXT NOT NULL CHECK (proof IN ('password-now', 'sso-now', 'fresh-password', 'fresh-sso', 'session', 'cli-login', 'local-owner')),
  approved_at         TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('approved', 'refused', 'failed', 'imported', 'removed', 'armed', 'completed', 'merged', 'cancelled', 'sent-back')),
  reason              TEXT CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 40 AND reason NOT GLOB '*[^a-z-]*')),
  detail              TEXT CHECK (detail IS NULL OR length(detail) <= 2000),
  task_id             TEXT CHECK (task_id IS NULL OR length(task_id) BETWEEN 1 AND 200),
  scope_digest        TEXT CHECK (scope_digest IS NULL OR length(scope_digest) BETWEEN 1 AND 128),
  feedback            TEXT CHECK (feedback IS NULL OR length(feedback) BETWEEN 1 AND 20000),
  merge_head          TEXT CHECK (merge_head IS NULL OR (${SHA("merge_head")})),
  merge_at            TEXT,
  state_at            TEXT NOT NULL,
  UNIQUE (thread, seq),
  CHECK ((task_id IS NULL) = (scope_digest IS NULL)),
  CHECK ((task_id IS NOT NULL) = (state IN ('armed', 'completed', 'merged', 'cancelled', 'sent-back'))),
  CHECK ((merge_head IS NULL) = (merge_at IS NULL)),
  CHECK (state NOT IN ('completed', 'merged') OR merge_head IS NOT NULL),
  CHECK ((feedback IS NOT NULL) = (state = 'sent-back')),
  CHECK (state NOT IN ('refused', 'failed') OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS flexible_ship_task ON flexible_ship (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS flexible_ship_thread ON flexible_ship (thread, state);
CREATE TRIGGER IF NOT EXISTS flexible_ship_born BEFORE INSERT ON flexible_ship
WHEN NEW.state IS NOT 'approved' OR NEW.task_id IS NOT NULL OR NEW.merge_head IS NOT NULL OR NEW.feedback IS NOT NULL OR NEW.reason IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a Flexible ship is born approved');
END;
CREATE TRIGGER IF NOT EXISTS flexible_ship_written_once BEFORE UPDATE ON flexible_ship
WHEN NEW.id IS NOT OLD.id OR NEW.thread IS NOT OLD.thread OR NEW.seq IS NOT OLD.seq OR NEW.repo IS NOT OLD.repo OR NEW.base_sha IS NOT OLD.base_sha
  OR NEW.candidate IS NOT OLD.candidate OR NEW.import_ref IS NOT OLD.import_ref OR NEW.branch IS NOT OLD.branch OR NEW.branch_before IS NOT OLD.branch_before
  OR NEW.terms_json IS NOT OLD.terms_json OR NEW.digest IS NOT OLD.digest OR NEW.summary_key IS NOT OLD.summary_key OR NEW.approved_by IS NOT OLD.approved_by
  OR NEW.approved_generation IS NOT OLD.approved_generation OR NEW.proof IS NOT OLD.proof OR NEW.approved_at IS NOT OLD.approved_at
  OR (OLD.task_id IS NOT NULL AND (NEW.task_id IS NOT OLD.task_id OR NEW.scope_digest IS NOT OLD.scope_digest))
  OR (OLD.merge_head IS NOT NULL AND (NEW.merge_head IS NOT OLD.merge_head OR NEW.merge_at IS NOT OLD.merge_at))
  OR (OLD.feedback IS NOT NULL AND NEW.feedback IS NOT OLD.feedback)
  OR OLD.state IN ('refused', 'failed', 'removed', 'merged', 'cancelled', 'sent-back')
  OR (OLD.state = 'approved' AND NEW.state NOT IN ('approved', 'refused', 'failed', 'imported'))
  OR (OLD.state = 'imported' AND NEW.state NOT IN ('imported', 'armed', 'removed'))
  OR (OLD.state = 'armed' AND NEW.state NOT IN ('armed', 'completed', 'cancelled', 'sent-back'))
  OR (OLD.state = 'completed' AND NEW.state NOT IN ('completed', 'merged', 'cancelled', 'sent-back'))
BEGIN
  SELECT RAISE(ABORT, 'a Flexible ship is written once and its state only moves forward');
END;
CREATE TABLE IF NOT EXISTS flexible_ref_snapshot (
  thread    TEXT PRIMARY KEY CHECK (${HEX32("thread")}),
  taken_at  TEXT NOT NULL,
  refs_json TEXT NOT NULL CHECK (length(refs_json) BETWEEN 2 AND 8388608),
  digest    TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*')
);
`;

export const V168_TABLES = Object.freeze(["flexible_ship", "flexible_ref_snapshot"] as const);
/** The v168 migration's steps, in order (a test seam may stop after each). */
export const V168_STEPS = Object.freeze(["flexible-ship"] as const);
/** v168's named objects, as a current or resumed file must hold them exactly (store.ts checks each). */
export const V168_OBJECTS = Object.freeze([
  ["table", "flexible_ship"], ["index", "flexible_ship_task"], ["index", "flexible_ship_thread"], ["trigger", "flexible_ship_born"],
  ["trigger", "flexible_ship_written_once"], ["table", "flexible_ref_snapshot"],
] as const);
