/**
 * v156: fallback chains (docs/plans/fallback-chains.md). New tables only, so a saved row reads as it did. Their names
 * differ from the tables v115 dropped: nothing old comes back under an old name. Kept beside nothing else so the update
 * road can read the list without loading the store.
 */
export const V156_SCHEMA = `
CREATE TABLE IF NOT EXISTS fallback_setting (
  repo            TEXT PRIMARY KEY,
  entries_json    TEXT NOT NULL,
  paid_granted_by TEXT,
  paid_granted_at TEXT,
  updated_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fallback_walk (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL,
  scope_digest  TEXT NOT NULL,
  chain_digest  TEXT NOT NULL,
  cursor        INTEGER NOT NULL DEFAULT 0,
  tail_run      INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  closed_reason TEXT,
  opened_at     TEXT NOT NULL,
  closed_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS fallback_walk_one_open ON fallback_walk (task_ref) WHERE state = 'open';
CREATE TABLE IF NOT EXISTS fallback_move (
  walk           INTEGER NOT NULL REFERENCES fallback_walk(id),
  to_index       INTEGER NOT NULL,
  from_run       INTEGER NOT NULL UNIQUE,
  to_run         INTEGER UNIQUE,
  terminal_class TEXT NOT NULL,
  paid           INTEGER NOT NULL DEFAULT 0,
  moved_at       TEXT NOT NULL,
  PRIMARY KEY (walk, to_index)
);
`;

export const V156_TABLES = Object.freeze(["fallback_setting", "fallback_walk", "fallback_move"] as const);
export const V156_STEPS = Object.freeze(["fallback-tables"] as const);
