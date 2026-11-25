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
