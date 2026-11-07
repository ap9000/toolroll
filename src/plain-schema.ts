/** v153 (docs/plans/plain-toolroll.md Phase 2): the tables the authority slices own, new tables only. Kept apart so
 * store.ts loads them without loading the roads that use them. */

/** A vanished build's one charge per run, and the episode its automatic retries stay inside (vanished-retry.ts). */
export const VANISHED_SCHEMA = `
CREATE TABLE IF NOT EXISTS vanished_charge (
  run        INTEGER PRIMARY KEY REFERENCES run(id),
  task_ref   INTEGER NOT NULL REFERENCES task_ref(id),
  charged_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS vanished_charge_open ON vanished_charge (task_ref) WHERE settled_at IS NULL;
CREATE TABLE IF NOT EXISTS retry_episode (
  task_ref          INTEGER PRIMARY KEY REFERENCES task_ref(id),
  retries           INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0),
  reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
  stopped           TEXT CHECK (stopped IS NULL OR stopped IN ('no-budget', 'attempts', 'spend')),
  stopped_run       INTEGER,
  started_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
`;

/** A check-only authorization (check-only.ts): one automatic run of the approved check on one exact commit. The unique
 * key is the cap: one per (commit, command digest), however many workers race. Written only from the approval that
 * built that commit; it seals nothing and starts no agent. */
export const CHECK_ONLY_SCHEMA = `
CREATE TABLE IF NOT EXISTS check_authorization (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref       INTEGER NOT NULL REFERENCES task_ref(id),
  run            INTEGER NOT NULL REFERENCES run(id),
  candidate      TEXT NOT NULL CHECK (length(candidate) = 40),
  command_digest TEXT NOT NULL,
  level          TEXT NOT NULL CHECK (level IN ('quick', 'full')),
  check_access   TEXT NOT NULL,
  scope_digest   TEXT NOT NULL,
  written_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  used_request   INTEGER,
  closed_at      TEXT,
  UNIQUE (task_ref, candidate, command_digest)
);
CREATE INDEX IF NOT EXISTS check_authorization_open ON check_authorization (expires_at) WHERE used_at IS NULL AND closed_at IS NULL;
`;

/** Whether this computer's own builder is meant to be running, and with what (builder-restart.ts): set by `background
 * on` and `up`, cleared by `background off` and `stop`. `builder_restart` is every automatic restart Toolroll tried. */
export const BUILDER_SERVICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS builder_service (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  desired        TEXT NOT NULL CHECK (desired IN ('running', 'stopped')),
  build          TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  set_by         TEXT NOT NULL,
  set_at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS builder_restart (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL
);
`;
