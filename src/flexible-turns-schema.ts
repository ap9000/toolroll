/**
 * v164: Flexible threads' turns and the installation's Flexible limits (the Flexible plan v2 §8, slice F2e). Adds only
 * tables: no saved row changes, and nothing writes them while Flexible isn't available (flexible-available.ts). Kept
 * apart from the store so the update road can read the lists without it.
 *
 * - `thread_turn`: one row per agent turn Toolroll admitted for a Flexible thread (flexible-turns.ts), written in the
 *   one transaction that checked the thread's terms and every limit. `id` is what the sign-in relay charges each call
 *   against. Who, under which terms, at which level, on which provider, model and billing, and for which request
 *   (`request_key`, so a repeated request never takes a second turn) are written once. `status` only moves forward:
 *   admitted → running → finished | interrupted | unknown, or admitted → withdrawn (never started: the provider was
 *   never asked, so it counts toward no limit). A turn's usage only grows; once it ends its cost basis can only get
 *   less certain (measured → estimated → unknown). `holder` names the process that runs it: when that process is gone
 *   its turns are withdrawn or interrupted, never resumed. `rail_reserved`: the turn took one of an active mode's daily
 *   starts (given back if it is withdrawn).
 * - `flexible_installation_caps`: the installation's own limits on Flexible threads across every project, set by an
 *   instance operator; a missing row or a NULL limit is no limit beyond each project's terms.
 */
export const V164_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_turn (
  id               TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  thread           TEXT NOT NULL CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  seq              INTEGER NOT NULL CHECK (seq >= 1),
  repo             TEXT NOT NULL,
  owner            TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  terms_id         INTEGER NOT NULL,
  terms_digest     TEXT NOT NULL,
  level            TEXT NOT NULL CHECK (level IN ('supervised', 'auto', 'full')),
  provider         TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
  model            TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  billing          TEXT NOT NULL CHECK (billing IN ('subscription', 'api-key')),
  request_key      TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  holder           TEXT NOT NULL CHECK (length(holder) BETWEEN 1 AND 128),
  admitted_at      TEXT NOT NULL,
  utc_day          TEXT NOT NULL CHECK (utc_day = substr(admitted_at, 1, 10)),
  rail_reserved    INTEGER NOT NULL DEFAULT 0 CHECK (rail_reserved IN (0, 1)),
  status           TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'finished', 'interrupted', 'unknown', 'withdrawn')),
  started_at       TEXT,
  ended_at         TEXT,
  end_detail       TEXT CHECK (end_detail IS NULL OR length(end_detail) <= 2000),
  tokens_in        INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out       INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  cost_microusd    INTEGER NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
  relay_calls      INTEGER NOT NULL DEFAULT 0 CHECK (relay_calls >= 0),
  cost_basis       TEXT CHECK (cost_basis IS NULL OR cost_basis IN ('measured', 'estimated', 'unknown')),
  CHECK ((status IN ('admitted', 'withdrawn')) = (started_at IS NULL)),
  CHECK ((status IN ('admitted', 'running')) = (ended_at IS NULL)),
  CHECK (status NOT IN ('admitted', 'withdrawn') OR (tokens_in = 0 AND tokens_out = 0 AND cost_microusd = 0 AND relay_calls = 0 AND cost_basis IS NULL)),
  CHECK (status NOT IN ('finished', 'interrupted', 'unknown') OR cost_basis IS NOT NULL),
  UNIQUE (thread, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS thread_turn_request ON thread_turn (thread, request_key) WHERE status <> 'withdrawn';
CREATE UNIQUE INDEX IF NOT EXISTS thread_turn_live ON thread_turn (thread) WHERE status IN ('admitted', 'running');
CREATE INDEX IF NOT EXISTS thread_turn_day ON thread_turn (utc_day, repo);
CREATE INDEX IF NOT EXISTS thread_turn_owner_day ON thread_turn (owner, utc_day);
CREATE TRIGGER IF NOT EXISTS thread_turn_written_once BEFORE UPDATE ON thread_turn
WHEN NEW.id IS NOT OLD.id OR NEW.thread IS NOT OLD.thread OR NEW.seq IS NOT OLD.seq OR NEW.repo IS NOT OLD.repo OR NEW.owner IS NOT OLD.owner
  OR NEW.owner_generation IS NOT OLD.owner_generation OR NEW.terms_id IS NOT OLD.terms_id OR NEW.terms_digest IS NOT OLD.terms_digest
  OR NEW.level IS NOT OLD.level OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.billing IS NOT OLD.billing
  OR NEW.request_key IS NOT OLD.request_key OR NEW.holder IS NOT OLD.holder OR NEW.admitted_at IS NOT OLD.admitted_at
  OR NEW.utc_day IS NOT OLD.utc_day OR NEW.rail_reserved IS NOT OLD.rail_reserved
  OR OLD.status = 'withdrawn'
  OR (OLD.status = 'admitted' AND NEW.status NOT IN ('admitted', 'running', 'withdrawn'))
  OR (OLD.status = 'running' AND NEW.status IN ('admitted', 'withdrawn'))
  OR (OLD.status IN ('finished', 'interrupted', 'unknown') AND (NEW.status IS NOT OLD.status OR NEW.ended_at IS NOT OLD.ended_at OR NEW.end_detail IS NOT OLD.end_detail
    OR (NEW.cost_basis IS NOT OLD.cost_basis AND NOT (NEW.cost_basis = 'unknown' OR (NEW.cost_basis = 'estimated' AND OLD.cost_basis = 'measured')))))
  OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
  OR NEW.tokens_in < OLD.tokens_in OR NEW.tokens_out < OLD.tokens_out OR NEW.cost_microusd < OLD.cost_microusd OR NEW.relay_calls < OLD.relay_calls
BEGIN
  SELECT RAISE(ABORT, 'a flexible turn is written once, its status only moves forward and its usage only grows');
END;
CREATE TABLE IF NOT EXISTS flexible_installation_caps (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  live_threads              INTEGER CHECK (live_threads IS NULL OR live_threads BETWEEN 1 AND 1000),
  turns_per_day             INTEGER CHECK (turns_per_day IS NULL OR turns_per_day BETWEEN 1 AND 1000000),
  measured_microusd_per_day INTEGER CHECK (measured_microusd_per_day IS NULL OR measured_microusd_per_day BETWEEN 1 AND 100000000000000),
  updated_by                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
`;

export const V164_TABLES = Object.freeze(["thread_turn", "flexible_installation_caps"] as const);
/** The v164 migration's steps, in order (a test seam may stop after each). */
export const V164_STEPS = Object.freeze(["thread-turn"] as const);
/** v164's named objects, as a current or resumed file must hold them exactly (store.ts checks each). */
export const V164_OBJECTS = Object.freeze([
  ["table", "thread_turn"], ["index", "thread_turn_request"], ["index", "thread_turn_live"], ["index", "thread_turn_day"], ["index", "thread_turn_owner_day"],
  ["trigger", "thread_turn_written_once"], ["table", "flexible_installation_caps"],
] as const);
