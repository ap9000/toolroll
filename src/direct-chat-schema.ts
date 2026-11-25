export const V181_THREAD_SCHEMA = `
CREATE TABLE IF NOT EXISTS direct_chat_thread (
  id                  TEXT PRIMARY KEY,
  owner               TEXT NOT NULL,
  local_generation    INTEGER,
  account_generation  INTEGER NOT NULL,
  create_request_id   TEXT,
  title               TEXT NOT NULL,
  repo                TEXT NOT NULL,
  clone_path          TEXT NOT NULL,
  branch              TEXT NOT NULL,
  base_sha            TEXT NOT NULL,
  provider            TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'gemini')),
  model_id            TEXT NOT NULL,
  provider_session_id TEXT,
  main_dirty_files    TEXT,
  archived_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
`;

export const V181_TURN_SCHEMA = `
CREATE TABLE IF NOT EXISTS direct_chat_turn (
  id                      TEXT PRIMARY KEY,
  thread_id               TEXT NOT NULL REFERENCES direct_chat_thread(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  request_id              TEXT,
  user_prompt             TEXT NOT NULL,
  switched_from_provider  TEXT,
  log_path                TEXT NOT NULL,
  stderr_path             TEXT NOT NULL,
  byte_offset             INTEGER NOT NULL DEFAULT 0,
  pid                     INTEGER,
  start_identity          TEXT,
  pgid                    INTEGER,
  boot_id                 TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('running', 'completed', 'stopped', 'failed', 'interrupted')),
  assistant_text          TEXT NOT NULL DEFAULT '',
  error_text              TEXT,
  created_at              TEXT NOT NULL,
  finished_at             TEXT,
  UNIQUE (thread_id, seq)
);
`;

export const V181_TOOL_SCHEMA = `
CREATE TABLE IF NOT EXISTS direct_chat_tool (
  id          TEXT NOT NULL,
  turn_id     TEXT NOT NULL REFERENCES direct_chat_turn(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (turn_id, id)
);
`;

export const V181_INDEX_SCHEMA = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_chat_thread_create_req
  ON direct_chat_thread(owner, create_request_id)
  WHERE create_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_direct_chat_thread_owner_updated
  ON direct_chat_thread(owner, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_chat_turn_req
  ON direct_chat_turn(thread_id, request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_direct_chat_turn_running
  ON direct_chat_turn(status)
  WHERE status = 'running';
`;

export const V181_SCHEMA = `${V181_THREAD_SCHEMA}${V181_TURN_SCHEMA}${V181_TOOL_SCHEMA}${V181_INDEX_SCHEMA}`;

export const V181_TABLES = Object.freeze([
  "direct_chat_thread",
  "direct_chat_turn",
  "direct_chat_tool",
] as const);

export const V181_TABLE_DDLS = Object.freeze({
  direct_chat_thread: V181_THREAD_SCHEMA,
  direct_chat_turn: V181_TURN_SCHEMA,
  direct_chat_tool: V181_TOOL_SCHEMA,
} as const);

export const V181_STEPS = Object.freeze(["direct-chat-tables"] as const);

export const V182_ARTIFACT_SCHEMA = `
CREATE TABLE IF NOT EXISTS direct_chat_artifact (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL REFERENCES direct_chat_thread(id) ON DELETE CASCADE,
  turn_id      TEXT REFERENCES direct_chat_turn(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('output', 'attachment')),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  source_path  TEXT,
  created_at   TEXT NOT NULL
);
`;

export const V182_SHIP_SCHEMA = `
CREATE TABLE IF NOT EXISTS direct_chat_ship (
  id                  TEXT PRIMARY KEY,
  thread_id           TEXT NOT NULL REFERENCES direct_chat_thread(id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,
  repo                TEXT NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('ship', 'keep-branch')),
  base_sha            TEXT NOT NULL,
  candidate_sha       TEXT NOT NULL,
  branch              TEXT NOT NULL,
  terms_json          TEXT NOT NULL,
  approved_by         TEXT NOT NULL,
  approved_generation INTEGER NOT NULL,
  local_generation    INTEGER,
  proof               TEXT NOT NULL CHECK (proof IN ('password-now', 'solo-session', 'local-owner')),
  state               TEXT NOT NULL CHECK (state IN ('kept', 'imported', 'armed', 'completed', 'merging', 'merged', 'cancelled', 'failed')),
  task_id             TEXT,
  scope_digest        TEXT,
  pr_url              TEXT,
  detail              TEXT,
  created_at          TEXT NOT NULL,
  state_at            TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);
`;

export const V182_INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_direct_chat_artifact_thread
  ON direct_chat_artifact(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_direct_chat_artifact_turn
  ON direct_chat_artifact(turn_id)
  WHERE turn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_direct_chat_ship_thread
  ON direct_chat_ship(thread_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_direct_chat_ship_active
  ON direct_chat_ship(state)
  WHERE state IN ('armed', 'completed', 'merging');
CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_chat_ship_task
  ON direct_chat_ship(task_id)
  WHERE task_id IS NOT NULL;
`;

export const V182_SCHEMA = `${V182_ARTIFACT_SCHEMA}${V182_SHIP_SCHEMA}${V182_INDEX_SCHEMA}`;

export const V182_TABLES = Object.freeze([
  "direct_chat_artifact",
  "direct_chat_ship",
] as const);

export const V182_TABLE_DDLS = Object.freeze({
  direct_chat_artifact: V182_ARTIFACT_SCHEMA,
  direct_chat_ship: V182_SHIP_SCHEMA,
} as const);

export const V182_STEPS = Object.freeze(["direct-chat-phase1b-tables"] as const);

export const V183_ADDED_COLUMNS = Object.freeze({
  direct_chat_thread: {
    git_dir: { definition: "TEXT" },
    config_sha256: { definition: "TEXT" },
    diff_cache_json: { definition: "TEXT" },
    is_legacy: { definition: "INTEGER NOT NULL DEFAULT 0" },
  },
  direct_chat_turn: {
    stop_requested_at: { definition: "TEXT" },
  },
  direct_chat_ship: {
    merge_token: { definition: "TEXT" },
    merge_reserved_at: { definition: "TEXT" },
  },
} as const);

export const V181_REQUIRED_COLUMNS = Object.freeze({
  direct_chat_thread: ["id", "owner", "local_generation", "account_generation", "create_request_id", "title", "repo", "clone_path", "branch", "base_sha", "provider", "model_id", "provider_session_id", "main_dirty_files", "archived_at", "created_at", "updated_at"],
  direct_chat_turn: ["id", "thread_id", "seq", "request_id", "user_prompt", "switched_from_provider", "log_path", "stderr_path", "byte_offset", "pid", "start_identity", "pgid", "boot_id", "status", "assistant_text", "error_text", "created_at", "finished_at"],
  direct_chat_tool: ["id", "turn_id", "ordinal", "name", "detail", "status", "updated_at"],
} as const);

export const V182_REQUIRED_COLUMNS = Object.freeze({
  direct_chat_artifact: ["id", "thread_id", "turn_id", "kind", "filename", "mime_type", "byte_size", "sha256", "storage_path", "source_path", "created_at"],
  direct_chat_ship: ["id", "thread_id", "seq", "repo", "mode", "base_sha", "candidate_sha", "branch", "terms_json", "approved_by", "approved_generation", "local_generation", "proof", "state", "task_id", "scope_digest", "pr_url", "detail", "created_at", "state_at"],
} as const);

export const V183_STEPS = Object.freeze(["direct-chat-hardening-columns"] as const);
