/**
 * The tables behind what happens to a result after its agent finishes (docs/plans/fleet-follow-through.md). v155 adds
 * them and changes no saved row, so the updater's history check needs no rule for it.
 *
 * Every reader of these tables goes through `readingFleet`: a deploy reads with the candidate's code over the installed
 * runtime's file before this version's migration has run (as buildReviewOf does), and a missing table is simply nothing
 * to show. Writers run only in a process whose Store opened, and so migrated, the file.
 */
export const V155_SCHEMA = `
-- A finding sent to the task that owns the code. It belongs to the task family, so a revision or repair inherits it.
-- summary, action and excerpt can hold model output or repository text: they are data everywhere they are read.
CREATE TABLE IF NOT EXISTS finding (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  family_root   TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  repo          TEXT,
  source        TEXT NOT NULL CHECK (source IN ('build-review', 'person', 'check-failure')),
  source_key    TEXT UNIQUE,
  source_run    INTEGER,
  severity      TEXT CHECK (severity IS NULL OR severity IN ('HIGH', 'MEDIUM', 'LOW')),
  file          TEXT,
  line          INTEGER,
  summary       TEXT NOT NULL,
  action        TEXT NOT NULL,
  excerpt       TEXT,
  revision      TEXT,
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'rejected', 'with-person', 'closed')),
  rounds        INTEGER NOT NULL DEFAULT 1,
  sent_by       TEXT NOT NULL,
  sent_at       TEXT NOT NULL,
  delivered_run INTEGER,
  delivered_how TEXT CHECK (delivered_how IS NULL OR delivered_how IN ('mailbox', 'brief')),
  delivered_at  TEXT,
  read_at       TEXT,
  closed_by     TEXT,
  closed_note   TEXT,
  closed_at     TEXT
);
CREATE INDEX IF NOT EXISTS finding_family ON finding (family_root, state);
-- What the owner answered. 'saved' until the attempt that wrote it settles: then 'counted', or 'refused' with the reason
-- (an accepted answer on a run that changed nothing; a rejection that names no file in the code).
CREATE TABLE IF NOT EXISTS finding_answer (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  finding   INTEGER NOT NULL REFERENCES finding(id) ON DELETE CASCADE,
  round     INTEGER NOT NULL,
  run       INTEGER NOT NULL,
  answer    TEXT NOT NULL CHECK (answer IN ('accepted', 'rejected')),
  detail    TEXT NOT NULL,
  file      TEXT,
  line      INTEGER,
  revision  TEXT,
  state     TEXT NOT NULL DEFAULT 'saved' CHECK (state IN ('saved', 'counted', 'refused')),
  problem   TEXT,
  at        TEXT NOT NULL,
  UNIQUE (finding, round, run)
);
-- One failed check on one revision of one task family: the UNIQUE key is what stops a second repair of the same failure.
-- attempt is the repair ledger's (repair_chain) attempt this row drafted, when it drafted one.
CREATE TABLE IF NOT EXISTS check_repair (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  family_root  TEXT NOT NULL,
  owner_task   TEXT NOT NULL,
  repo         TEXT NOT NULL,
  revision     TEXT NOT NULL,
  failure_key  TEXT NOT NULL,
  source_run   INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('waiting', 'repairing', 'with-person', 'parked', 'fixed')),
  why          TEXT NOT NULL,
  repair_task  TEXT,
  attempt      INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (family_root, revision, failure_key)
);
CREATE INDEX IF NOT EXISTS check_repair_state ON check_repair (repo, state);
-- A failing result saved before a change. The after side is never stored: it is read from the task's latest results,
-- so a newer commit reads as out of date on its own.
CREATE TABLE IF NOT EXISTS evidence_pair (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  family_root    TEXT NOT NULL,
  repo           TEXT,
  before_run     INTEGER NOT NULL,
  before_head    TEXT NOT NULL,
  receipt_digest TEXT NOT NULL,
  command_digest TEXT,
  saved_by       TEXT NOT NULL,
  saved_at       TEXT NOT NULL,
  UNIQUE (family_root, before_run)
);
-- A bug fix's optional failing test first: asked for on the family; the agent's report beside it, shown as its own report.
CREATE TABLE IF NOT EXISTS failing_first (
  family_root TEXT PRIMARY KEY,
  repo        TEXT,
  asked_by    TEXT NOT NULL,
  asked_at    TEXT NOT NULL,
  report_run  INTEGER,
  test        TEXT,
  output      TEXT,
  reported_at TEXT
);
-- What a provider said when an attempt failed, kept as data for a person. Nothing reads it to route work.
CREATE TABLE IF NOT EXISTS provider_capture (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run         INTEGER NOT NULL UNIQUE,
  repo        TEXT,
  provider    TEXT NOT NULL,
  model       TEXT,
  auth_mode   TEXT,
  exit_code   INTEGER,
  code        TEXT,
  text        TEXT NOT NULL,
  hint        INTEGER NOT NULL DEFAULT 0 CHECK (hint IN (0, 1)),
  label       TEXT CHECK (label IS NULL OR label IN ('exhausted', 'not-exhausted')),
  labelled_by TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_capture_provider ON provider_capture (provider, id);
`;

export const V155_TABLES = Object.freeze(["finding", "finding_answer", "check_repair", "evidence_pair", "failing_first", "provider_capture"] as const);
export const V155_STEPS = Object.freeze(["follow-through-tables"] as const);

/** One read, or `fallback` when the file predates v155. Any other error is real and goes on. */
export function readingFleet<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    if (/no such table: (finding|finding_answer|check_repair|evidence_pair|failing_first|provider_capture)\b/.test(String(error))) return fallback;
    throw error;
  }
}
