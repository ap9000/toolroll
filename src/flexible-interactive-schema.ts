/** v175: additive launch authority, separate from structured turns and their accounting. */
export const V175_SCHEMA = `
CREATE TABLE IF NOT EXISTS flexible_thread_runtime (
  thread TEXT PRIMARY KEY,
  runtime TEXT NOT NULL CHECK (runtime IN ('stream-json', 'interactive')),
  chosen INTEGER NOT NULL DEFAULT 0 CHECK (chosen IN (0, 1))
);
CREATE TRIGGER IF NOT EXISTS flexible_thread_runtime_creation BEFORE INSERT ON flexible_thread_runtime
WHEN NOT EXISTS (SELECT 1 FROM flexible_thread WHERE id = NEW.thread)
  OR (NEW.runtime = 'interactive' AND NOT EXISTS (SELECT 1 FROM flexible_thread WHERE id = NEW.thread AND state = 'preparing'))
BEGIN
  SELECT RAISE(ABORT, 'runtime is chosen at thread creation');
END;
CREATE TRIGGER IF NOT EXISTS flexible_thread_runtime_written_once BEFORE UPDATE ON flexible_thread_runtime
WHEN OLD.chosen = 1 OR NEW.thread IS NOT OLD.thread OR NEW.chosen <> 1
  OR NOT EXISTS (SELECT 1 FROM flexible_thread WHERE id = OLD.thread AND state = 'preparing')
BEGIN
  SELECT RAISE(ABORT, 'runtime is immutable');
END;
CREATE TRIGGER IF NOT EXISTS flexible_thread_runtime_kept BEFORE DELETE ON flexible_thread_runtime
BEGIN
  SELECT RAISE(ABORT, 'runtime is kept');
END;
CREATE TRIGGER IF NOT EXISTS flexible_thread_runtime_default AFTER INSERT ON flexible_thread
BEGIN
  INSERT INTO flexible_thread_runtime (thread, runtime) VALUES (NEW.id, 'stream-json');
END;
CREATE TABLE IF NOT EXISTS flexible_interactive_session (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  thread TEXT NOT NULL CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  launch TEXT NOT NULL UNIQUE CHECK (length(launch) = 32 AND launch NOT GLOB '*[^0-9a-f]*'),
  holder TEXT NOT NULL CHECK (length(holder) BETWEEN 1 AND 128),
  owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
  account_generation INTEGER NOT NULL CHECK (account_generation >= 0),
  runtime TEXT NOT NULL CHECK (runtime = 'interactive'),
  provider TEXT NOT NULL CHECK (provider = 'claude'),
  billing TEXT NOT NULL CHECK (billing = 'subscription'),
  terms_id INTEGER NOT NULL CHECK (terms_id > 0),
  terms_digest TEXT NOT NULL CHECK (length(terms_digest) = 32 AND terms_digest NOT GLOB '*[^0-9a-f]*'),
  start_key TEXT NOT NULL CHECK (length(start_key) = 32 AND start_key NOT GLOB '*[^0-9a-f]*'),
  message TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level = 'full'),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  helper_models TEXT NOT NULL CHECK (json_valid(helper_models) AND json_type(helper_models) = 'array'),
  fence_digest TEXT NOT NULL CHECK (length(fence_digest) = 32 AND fence_digest NOT GLOB '*[^0-9a-f]*'),
  network_digest TEXT NOT NULL CHECK (length(network_digest) = 32 AND network_digest NOT GLOB '*[^0-9a-f]*'),
  sign_in_epoch INTEGER NOT NULL CHECK (sign_in_epoch >= 0),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'active', 'ended')),
  prepared_at TEXT NOT NULL,
  activated_at TEXT,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 200),
  CHECK ((state = 'ended') = (ended_at IS NOT NULL)),
  CHECK ((state = 'ended') = (end_reason IS NOT NULL)),
  CHECK (state <> 'active' OR activated_at IS NOT NULL),
  CHECK (state <> 'prepared' OR activated_at IS NULL)
);
CREATE TRIGGER IF NOT EXISTS flexible_interactive_session_creation BEFORE INSERT ON flexible_interactive_session
WHEN NEW.state <> 'prepared' OR NEW.activated_at IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM flexible_thread_launch l JOIN flexible_thread t ON t.id = l.thread
    JOIN flexible_thread_runtime r ON r.thread = t.id
    WHERE l.id = NEW.launch AND l.thread = NEW.thread AND l.holder = NEW.holder AND l.turn IS NULL
      AND l.provider = NEW.provider AND l.level = NEW.level AND l.fence_digest = NEW.fence_digest AND l.state = 'spawning'
      AND t.created_by = NEW.owner AND t.state = 'ready' AND r.runtime = 'interactive')
BEGIN
  SELECT RAISE(ABORT, 'interactive authority begins prepared');
END;
CREATE TRIGGER IF NOT EXISTS flexible_interactive_session_written_once BEFORE UPDATE ON flexible_interactive_session
WHEN OLD.state = 'ended' OR NEW.id IS NOT OLD.id OR NEW.thread IS NOT OLD.thread OR NEW.launch IS NOT OLD.launch
  OR NEW.holder IS NOT OLD.holder OR NEW.owner IS NOT OLD.owner OR NEW.account_generation IS NOT OLD.account_generation
  OR NEW.runtime IS NOT OLD.runtime OR NEW.provider IS NOT OLD.provider OR NEW.billing IS NOT OLD.billing
  OR NEW.terms_id IS NOT OLD.terms_id OR NEW.terms_digest IS NOT OLD.terms_digest OR NEW.start_key IS NOT OLD.start_key
  OR NEW.message IS NOT OLD.message OR NEW.level IS NOT OLD.level OR NEW.model IS NOT OLD.model OR NEW.helper_models IS NOT OLD.helper_models
  OR NEW.fence_digest IS NOT OLD.fence_digest OR NEW.network_digest IS NOT OLD.network_digest OR NEW.sign_in_epoch IS NOT OLD.sign_in_epoch
  OR NEW.prepared_at IS NOT OLD.prepared_at OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS NOT OLD.activated_at)
  OR (OLD.state = 'active' AND NEW.state <> 'ended')
  OR (OLD.state = 'prepared' AND NEW.state <> 'active' AND NEW.activated_at IS NOT OLD.activated_at)
BEGIN
  SELECT RAISE(ABORT, 'interactive authority is written once and ends once');
END;
CREATE TRIGGER IF NOT EXISTS flexible_interactive_session_kept BEFORE DELETE ON flexible_interactive_session
BEGIN
  SELECT RAISE(ABORT, 'interactive authority is kept');
END;
CREATE TRIGGER IF NOT EXISTS flexible_interactive_no_turn BEFORE INSERT ON thread_turn
WHEN EXISTS (SELECT 1 FROM flexible_thread_runtime WHERE thread = NEW.thread AND runtime = 'interactive')
BEGIN
  SELECT RAISE(ABORT, 'interactive sessions do not admit structured turns');
END;
CREATE TRIGGER IF NOT EXISTS flexible_interactive_stop AFTER INSERT ON flexible_stop_request
BEGIN
  UPDATE flexible_interactive_session SET state = 'ended', ended_at = NEW.requested_at, end_reason = NEW.reason WHERE launch = NEW.launch AND state <> 'ended';
END;
CREATE TRIGGER IF NOT EXISTS flexible_interactive_launch_end AFTER UPDATE OF state ON flexible_thread_launch
WHEN NEW.state IN ('stopping', 'unresolved', 'exited')
BEGIN
  UPDATE flexible_interactive_session SET state = 'ended', ended_at = COALESCE(NEW.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    end_reason = COALESCE(NEW.stop_reason, NEW.state) WHERE launch = NEW.id AND state <> 'ended';
END;
CREATE TRIGGER IF NOT EXISTS flexible_interactive_threads_off AFTER UPDATE OF enabled ON flexible_setting
WHEN NEW.enabled = 0
BEGIN
  UPDATE flexible_interactive_session SET state = 'ended', ended_at = NEW.updated_at, end_reason = 'threads-off' WHERE state <> 'ended';
END;
CREATE TRIGGER IF NOT EXISTS flexible_interactive_level_insert AFTER INSERT ON flexible_thread_level
WHEN NEW.level <> 'full'
BEGIN
  UPDATE flexible_interactive_session SET state = 'ended', ended_at = NEW.set_at, end_reason = 'level-lowered' WHERE thread = NEW.thread AND state <> 'ended';
END;
CREATE TRIGGER IF NOT EXISTS flexible_interactive_level_update AFTER UPDATE OF level ON flexible_thread_level
WHEN NEW.level <> 'full'
BEGIN
  UPDATE flexible_interactive_session SET state = 'ended', ended_at = NEW.set_at, end_reason = 'level-lowered' WHERE thread = NEW.thread AND state <> 'ended';
END;
CREATE TRIGGER IF NOT EXISTS flexible_interactive_network_insert AFTER INSERT ON project_network
BEGIN
  UPDATE flexible_interactive_session SET state = 'ended', ended_at = NEW.updated_at, end_reason = 'network-changed'
    WHERE thread IN (SELECT id FROM flexible_thread WHERE repo = NEW.repo) AND state <> 'ended';
END;
CREATE TRIGGER IF NOT EXISTS flexible_interactive_network_update AFTER UPDATE OF network_json ON project_network
WHEN NEW.network_json IS NOT OLD.network_json
BEGIN
  UPDATE flexible_interactive_session SET state = 'ended', ended_at = NEW.updated_at, end_reason = 'network-changed'
    WHERE thread IN (SELECT id FROM flexible_thread WHERE repo = NEW.repo) AND state <> 'ended';
END;
CREATE TRIGGER IF NOT EXISTS flexible_interactive_terms_end AFTER UPDATE OF ended_at ON flexible_terms
WHEN NEW.ended_at IS NOT NULL
BEGIN
  UPDATE flexible_interactive_session SET state = 'ended', ended_at = NEW.ended_at, end_reason = 'terms-ended' WHERE terms_id = NEW.id AND state <> 'ended';
END;
`;
export const V175_STEPS = Object.freeze(['flexible-interactive'] as const);
export const V175_TABLES = Object.freeze(['flexible_thread_runtime', 'flexible_interactive_session'] as const);
export const V175_OBJECTS = Object.freeze([...V175_SCHEMA.matchAll(/CREATE (TABLE|TRIGGER|INDEX) IF NOT EXISTS (\w+)/g)].map(one => [one[1]!.toLowerCase(), one[2]!] as const));
