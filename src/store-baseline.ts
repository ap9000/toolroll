import { createHash } from "node:crypto";
import type { Database } from "./store.js";

/**
 * Schema v107: the database Toolroll 0.5.0, the first npm release, made for a
 * new installation — every table, index and trigger exactly as that release
 * wrote it (sqlite_master order and text), and the rows it seeded. A new
 * database starts here and takes the same numbered steps up to the current
 * schema that an installation from 0.5.0 takes; an older schema is refused
 * (update through 0.9.x first).
 *
 * Captured from a database 0.5.0 created, never edited by hand: its shape
 * digest below must match one this text creates (store-baseline.test.ts), and
 * the upgrade path compares it with the published 0.5.0 package itself.
 */
export const BASELINE_SCHEMA_VERSION = 107;

/** The sha256 of `schemaShape` over a database 0.5.0 created (and over one BASELINE_SCHEMA creates). */
export const BASELINE_SHAPE_SHA256 = "a8c5a0dad9ef6d73f7e2696203dd3618812d7a3975ca4a1b79c7550e315716ca";

/** Every schema object, as SQLite keeps it (type, name, table and text), in one deterministic order, hashed. */
export function schemaShape(db: Database): string {
  const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
  return createHash("sha256").update(rows.map(row => JSON.stringify([row["type"], row["name"], row["tbl_name"], row["sql"]])).join("\n")).digest("hex");
}

export const BASELINE_SCHEMA = `
CREATE TABLE schema_version (
  version INTEGER NOT NULL
);
CREATE TABLE service_cursor (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL CHECK (value >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE task (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE queue_state (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE task_edge (
  blocked TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  blocker TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  PRIMARY KEY (blocked, blocker),
  CHECK (blocked <> blocker)
);
CREATE TABLE task_ref (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  backend                 TEXT NOT NULL,
  external_id             TEXT NOT NULL,
  -- Which repository the work belongs to, when that is known. Capabilities
  -- are repo-scoped, so a gap can only count the tasks it blocks if tasks
  -- say where they live. NULL is honest for a task nobody has placed yet —
  -- it dispatches anywhere, and no gap claims it.
  repo                    TEXT,
  -- The worker this task is reserved for (v19); NULL = any free worker.
  assigned_runner         TEXT,
  zones                   TEXT NOT NULL DEFAULT '[]',
  capability_requirements TEXT NOT NULL DEFAULT '[]',
  park_rate               REAL NOT NULL DEFAULT 0,
  origin                  TEXT NOT NULL DEFAULT 'theirs',
  -- Planning mode (v7): 'requested' dispatches a planner before any scope
  -- is approved; 'drafted' means a proposed scope + plan document await the
  -- operator. NULL is the ordinary task that never asked for a plan.
  plan                    TEXT CHECK (plan IN ('requested','drafted')),
  -- Planning failures count separately from build strikes: a planner that
  -- cannot finish must never spend the builder's three attempts.
  plan_strikes            INTEGER NOT NULL DEFAULT 0,
  -- The standing order this task is an instance of, when it is one (v8).
  -- Ordinary one-off work carries NULL; the board uses this to keep
  -- instances in their track row instead of the main lanes.
  routine_id              INTEGER REFERENCES routine(id),
  -- The pinned agent (v9): which provider/model this task's builds run on,
  -- stamped by the routine fire transaction (digest-authoritative) — a
  -- runtime flag never overrides a pin. NULL = resolve from config.
  agent_provider          TEXT,
  agent_model             TEXT,
  -- Per-task unattended permission override (v37). NULL inherits the
  -- installation default when a scope is next filed; approvals bind the
  -- resulting concrete profile, never this mutable preference.
  permission_mode         TEXT CHECK (permission_mode IN ('auto','bypassPermissions')),
  -- Per-task quality override (v41). NULL inherits the installation
  -- default when the next scope is filed; the scope stores the concrete
  -- signed choice.
  quality_mode            TEXT CHECK (quality_mode IN ('default','strict')),
  -- Per-task declared risk (v47, phase routing). NULL reads as routine
  -- when the next scope is filed; the scope stores the signed level.
  risk_level              TEXT CHECK (risk_level IN ('routine','elevated','high')),
  -- An approver's explicit per-phase route overrides (v47): a JSON list of
  -- {phase, provider, model, by, at}, at most one per phase. Read when the
  -- next scope is filed; the sealed route records what applied.
  route_overrides_json    TEXT,
  -- A revision task (M6.8): which task's reviewed run it revises, and the
  -- immutable brief artifact carrying the exact comment batch. Every
  -- revision requires its own approval; nothing is inherited.
  revision_of             TEXT,
  revision_brief_artifact INTEGER REFERENCES artifact(id),
  -- Immutable provenance (v12): which door filed this work — 'cli',
  -- 'console', 'intake', 'template:<name>', 'revision'. Stamped once at
  -- filing, never updated; NULL is history from before the column existed.
  filed_via               TEXT,
  -- The coordinator that filed this task (v31, MCP gateway): the
  -- AUTHORITATIVE linkage — written only by the branded coordinator door,
  -- joined by exact cid, never parsed out of filed_via (which stays
  -- display-only). NULL is every other filer.
  coordinator_cid         TEXT REFERENCES coordinator_credential(cid),
  -- The deliverable (v34, scout tasks): 'branch' is every task until now;
  -- 'report' dispatches a scout — a read-only session whose whole output
  -- is one report artifact. Stamped at filing, never rewritten.
  deliverable             TEXT NOT NULL DEFAULT 'branch' CHECK (deliverable IN ('branch','report')), strikes INTEGER NOT NULL DEFAULT 0, plan_provider TEXT, plan_model TEXT, filed_by TEXT, filed_by_kind TEXT,
  UNIQUE (backend, external_id)
);
CREATE TABLE coordinator_credential (
  cid             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  repos           TEXT NOT NULL,
  per_hour        INTEGER NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  revoked_at      TEXT
, expires_at TEXT);
CREATE UNIQUE INDEX coordinator_live_name
  ON coordinator_credential (name) WHERE revoked_at IS NULL;
CREATE TABLE coordinator_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cid        TEXT NOT NULL REFERENCES coordinator_credential(cid),
  kind       TEXT NOT NULL CHECK (kind IN ('filed','dismissed','revoked')),
  task_id    TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE mcp_idempotency (
  cid            TEXT NOT NULL REFERENCES coordinator_credential(cid),
  key            TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (cid, key)
);
CREATE TABLE phase_config (
  scope      TEXT NOT NULL,
  phase      TEXT NOT NULL CHECK (phase IN ('plan','build','repair','review')),
  provider   TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter','gemini')),
  model      TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope, phase)
);
CREATE TABLE fallback_config (
  scope       TEXT NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN ('build')),
  entries_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (scope, phase)
);
CREATE TABLE phase_tier_config (
  scope      TEXT NOT NULL,
  phase      TEXT NOT NULL CHECK (phase IN ('plan','build','repair','review')),
  tier       TEXT NOT NULL CHECK (tier IN ('strong')),
  provider   TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter','gemini')),
  model      TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope, phase, tier)
);
CREATE TABLE provider_readiness (
  runner      TEXT NOT NULL REFERENCES runner(name) ON DELETE CASCADE,
  provider    TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter','gemini')),
  state       TEXT NOT NULL CHECK (state IN ('ready','unavailable','unknown')),
  reason      TEXT NOT NULL,
  probe       TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (runner, provider)
);
CREATE TABLE run_route (
  run          INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  route_digest TEXT NOT NULL,
  phase        TEXT NOT NULL CHECK (phase IN ('plan','build','repair','review')),
  provider     TEXT NOT NULL,
  model        TEXT,
  chosen       TEXT NOT NULL CHECK (chosen IN ('recommended','override','pinned','legacy','fallback')),
  stamped_at   TEXT NOT NULL
);
CREATE TABLE routine (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  repo             TEXT NOT NULL,
  goal             TEXT NOT NULL,
  out_of_scope     TEXT,
  touches          TEXT NOT NULL DEFAULT '[]',
  requirements     TEXT NOT NULL DEFAULT '[]',
  -- 'every:<minutes>', 'daily:<HH:MM>[@Zone]', or 'weekly:<0-6>:<HH:MM>[@Zone]' (UTC by default). Parsed, never guessed at.
  schedule         TEXT NOT NULL,
  single_flight    INTEGER NOT NULL DEFAULT 1,
  -- Rolling 7-day ceiling in dollars. NULL is honestly "no ceiling";
  -- enforcement FAILS CLOSED on unmeasured paid runs (finding 5).
  cost_ceiling_usd REAL,
  -- Per-INSTANCE dollar cap (v16): copied into each instance's scope as
  -- its digest-bound budget term, enforced by the same native-cap
  -- plumbing as any scope budget. NULL = only the global backstop.
  budget_per_run_microusd INTEGER,
  paused           INTEGER NOT NULL DEFAULT 0,
  digest           TEXT NOT NULL,
  approved_at      TEXT,
  approved_by      TEXT,
  approved_digest  TEXT,
  -- v24: the routine's execution profile; firings stamp instances FROM
  -- the APPROVED snapshot, never from fresh resolution.
  profile_json          TEXT,
  approved_profile_json TEXT,
  digest_version        INTEGER NOT NULL DEFAULT 1,
  profile_provenance    TEXT,
  -- v48: the routine's four-role agent route, and the snapshot approval
  -- sealed. Every firing copies the APPROVED route onto its instance, so a
  -- configuration change after the yes can never re-route a firing.
  route_json            TEXT,
  approved_route_json   TEXT,
  -- The next scheduled occurrence. NULL until approved; advanced by the
  -- fire transaction and nothing else, aligned to cadence (finding 10).
  next_fire_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- Immutable provenance (v12), same contract as task_ref.filed_via.
  filed_via        TEXT,
  -- v39: the signed rubric every instance's scope copies forward. A
  -- routine is validated mandatory-non-empty at creation/edit time
  -- (validateRoutineTerms) -- by the time a firing reads this column it
  -- is guaranteed present, so fireRoutine never re-checks it.
  acceptance_json  TEXT
, created_by TEXT);
CREATE TABLE installation_fact (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tournament_terms (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref                  INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  generation                INTEGER NOT NULL,
  active                    INTEGER NOT NULL DEFAULT 1,
  -- v27: 'race' = dollar-capped tournament (money contract required);
  -- 'comparison' = labeled cross-runtime comparison (no dollar terms
  -- exist; each lane's sealed clock is its bound). The money CHECK is
  -- kind-aware: races keep their positive budgets, comparisons pin 0.
  kind                      TEXT NOT NULL DEFAULT 'race' CHECK (kind IN ('race','comparison')),
  race_digest               TEXT NOT NULL,
  -- The ordered agents, JSON: [{provider, model, repairModel}] — exact
  -- model ids, resolved at filing, priced at price_version.
  agents                    TEXT NOT NULL,
  n                         INTEGER NOT NULL CHECK (n BETWEEN 2 AND 4),
  per_agent_budget_microusd INTEGER NOT NULL,
  overrun_reserve_microusd  INTEGER NOT NULL,
  total_budget_microusd     INTEGER NOT NULL,
  price_version             INTEGER NOT NULL,
  retries                   INTEGER NOT NULL CHECK (retries = 0),
  -- 'none', or the JSON of the publication grant constraints in force.
  publication_policy        TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  approved_at               TEXT,
  approved_by               TEXT,
  approved_digest           TEXT,
  CHECK ((kind = 'race' AND per_agent_budget_microusd > 0 AND overrun_reserve_microusd > 0 AND total_budget_microusd > 0)
      OR (kind = 'comparison' AND per_agent_budget_microusd = 0 AND overrun_reserve_microusd = 0 AND total_budget_microusd = 0))
);
CREATE UNIQUE INDEX tournament_terms_one_active
  ON tournament_terms (task_ref) WHERE active = 1;
CREATE TABLE contest (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref           INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  terms              INTEGER NOT NULL REFERENCES tournament_terms(id),
  generation         INTEGER NOT NULL DEFAULT 1,
  state              TEXT NOT NULL CHECK (state IN
    ('dispatching','racing','pick-wait','decision-wait','picked','abandoned','interrupted','exhausted')),
  scope_digest       TEXT NOT NULL,
  race_digest        TEXT NOT NULL,
  base_sha           TEXT,
  setup_digest       TEXT,
  current_lease_id   TEXT,
  runner             TEXT,
  incarnation        TEXT,
  created_at         TEXT NOT NULL,
  picked_at          TEXT,
  picked_by          TEXT,
  winner_contestant  INTEGER,
  overdue_paged      INTEGER NOT NULL DEFAULT 0,
  -- v24: 1 = legacy race digest (provider/model/repair only) — admission
  -- keeps byte-comparing the stored fingerprint; 2 = full-profile terms.
  race_semantics     INTEGER NOT NULL DEFAULT 1,
  -- v27: denormalized from the terms at admission, so screens, holds,
  -- and recovery speak the right words without a join.
  kind               TEXT NOT NULL DEFAULT 'race'
);
CREATE INDEX contest_by_task ON contest (task_ref, id DESC);
CREATE TABLE contestant (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  contest             INTEGER NOT NULL REFERENCES contest(id) ON DELETE CASCADE,
  ordinal             INTEGER NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  repair_model        TEXT NOT NULL,
  -- v24: the contestant's full execution-profile snapshot (canonical JSON).
  profile_json        TEXT,
  branch              TEXT NOT NULL,
  worktree            TEXT,
  generation          INTEGER NOT NULL DEFAULT 1,
  state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','ready','building','parked','built','failed','stopped')),
  active_run          INTEGER REFERENCES run(id),
  budget_microusd     INTEGER NOT NULL,
  reserve_microusd    INTEGER NOT NULL,
  measured_microusd   INTEGER NOT NULL DEFAULT 0,
  accounted_microusd  INTEGER NOT NULL DEFAULT 0,
  unknown_spend       INTEGER NOT NULL DEFAULT 0,
  cleanup             TEXT CHECK (cleanup IN ('pending','done','attention')),
  custody             TEXT,
  UNIQUE (contest, ordinal)
);
CREATE TABLE execution_slot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  runner        TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','running','released')),
  run           INTEGER REFERENCES run(id),
  contestant    INTEGER REFERENCES contestant(id),
  incarnation   TEXT,
  process_group INTEGER,
  reserved_at   TEXT NOT NULL,
  running_at    TEXT,
  released_at   TEXT
);
CREATE INDEX execution_slot_live ON execution_slot (runner, state);
CREATE TABLE ceremony_nonce (
  hash        TEXT PRIMARY KEY,
  approver    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  subject_id  INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX ceremony_nonce_expiry ON ceremony_nonce (expires_at);
CREATE TABLE spend_defaults (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  build_per_run_microusd   INTEGER,
  race_per_agent_microusd  INTEGER,
  race_total_microusd      INTEGER,
  -- How many agents compete by default (v16, operator request). Applies
  -- only where a filing names ONE agent and no explicit count — an
  -- explicit list or count always wins, and the race digest binds the
  -- actual lineup either way.
  race_agents              INTEGER CHECK (race_agents BETWEEN 2 AND 4),
  updated_at               TEXT NOT NULL,
  updated_by               TEXT NOT NULL
);
CREATE TABLE permission_default (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  mode       TEXT NOT NULL CHECK (mode IN ('auto','bypassPermissions')),
  updated_at TEXT,
  updated_by TEXT
);
CREATE TABLE quality_default (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  mode       TEXT NOT NULL CHECK (mode IN ('default','strict')),
  updated_at TEXT,
  updated_by TEXT
);
CREATE TABLE chat_config (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  provider                TEXT NOT NULL CHECK (provider IN ('anthropic-api','openrouter-api','claude-subscription','codex-subscription')),
  model                   TEXT NOT NULL,
  daily_turns             INTEGER NOT NULL DEFAULT 50,
  -- The rolling 7-day spend ceiling, integer micro-dollars (change 4):
  -- reservations count against it transactionally. Subscription-backed
  -- chat stores zero: there is no truthful dollar meter on plan usage.
  weekly_ceiling_microusd INTEGER NOT NULL,
  -- The PINNED price (v13b): snapshotted from the provider's own catalog
  -- (or the compiled table) at the authenticated save, integer
  -- micro-dollars per token. Reservations and settlement use THESE, so an
  -- upstream price change never silently moves the ledger math —
  -- re-saving re-pins. NULL only on rows written before the columns
  -- existed; readers fall back to the compiled table then.
  price_in_microusd       INTEGER,
  price_out_microusd      INTEGER,
  updated_at              TEXT NOT NULL,
  updated_by              TEXT NOT NULL
);
CREATE TABLE chat_turn (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  approver          TEXT NOT NULL,
  -- Domain-separated sha256 over provider+key, full hex — a stable,
  -- non-secret accounting identity (128+ bits per change 6).
  credential_key    TEXT NOT NULL,
  provider          TEXT NOT NULL CHECK (provider IN ('anthropic-api','openrouter-api','claude-subscription','codex-subscription')),
  model             TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('queued','running','answered','failed')),
  -- Terminal transitions are generation-checked CAS: a late response
  -- cannot resurrect a swept row (change 5).
  generation        INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  deadline_at       TEXT,
  finished_at       TEXT,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  reserved_microusd INTEGER NOT NULL,
  settled_microusd  INTEGER,
  failure_reason    TEXT CHECK (failure_reason IN
    ('provider-error','timeout','over-budget','malformed-reply','secret-refused','crashed','over-cap','unknown-spend')),
  unknown_spend     INTEGER NOT NULL DEFAULT 0,
  acknowledged_at   TEXT,
  acknowledged_by   TEXT,
  reply_bytes       INTEGER,
  candidate_count   INTEGER,
  kind              TEXT NOT NULL DEFAULT 'chat',
  mate_turn         INTEGER
);
CREATE INDEX chat_turn_credential ON chat_turn (credential_key, created_at);
CREATE INDEX chat_turn_approver ON chat_turn (approver, created_at);
CREATE TABLE mate_session (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  approver            TEXT NOT NULL,
  approver_generation INTEGER NOT NULL,
  credential_key      TEXT NOT NULL,
  ceiling_microusd    INTEGER NOT NULL,
  spent_microusd      INTEGER NOT NULL DEFAULT 0,
  ceiling_digest      TEXT NOT NULL,
  terms_digest        TEXT NOT NULL,
  minted_at           TEXT NOT NULL,
  ended_at            TEXT,
  ended_by            TEXT
);
CREATE INDEX mate_session_live ON mate_session (approver, ended_at);
CREATE TABLE mate_thread (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  approver       TEXT NOT NULL,
  ceiling_digest TEXT NOT NULL,
  opened_at      TEXT NOT NULL,
  last_turn_at   TEXT,
  closed_at      TEXT,
  scope_kind     TEXT NOT NULL DEFAULT 'lead' CHECK (scope_kind IN ('lead','project','task')),
  scope_key      TEXT
);
CREATE INDEX mate_thread_live ON mate_thread (approver, closed_at);
CREATE TABLE mate_message (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread     INTEGER NOT NULL REFERENCES mate_thread(id) ON DELETE CASCADE,
  turn       INTEGER,
  role       TEXT NOT NULL CHECK (role IN ('operator','assistant')),
  text       TEXT NOT NULL,
  activity   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX mate_message_thread ON mate_message (thread, id);
CREATE TABLE chat_focus (
  surface    TEXT NOT NULL,
  binding    INTEGER NOT NULL,
  task       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (surface, binding)
);
CREATE TABLE flow (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo            TEXT NOT NULL,
  name            TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,
  state           TEXT NOT NULL CHECK (state IN ('active','archived')),
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  owner           TEXT
);
CREATE TABLE flow_card (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  flow         INTEGER NOT NULL REFERENCES flow(id),
  title        TEXT NOT NULL,
  description  TEXT,
  stage        TEXT NOT NULL,
  entry        INTEGER NOT NULL DEFAULT 1,
  state        TEXT NOT NULL CHECK (state IN ('active','done','cancelled')),
  task         TEXT,
  primary_task TEXT,
  note         TEXT,
  waiting      TEXT,
  outputs_json TEXT NOT NULL DEFAULT '{}',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  source_json  TEXT,
  owner        TEXT
);
CREATE INDEX flow_card_live ON flow_card (flow, state);
CREATE TABLE flow_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card       INTEGER NOT NULL REFERENCES flow_card(id),
  from_stage TEXT,
  to_stage   TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('created','ok','fail','moved','approved','sent-back','cancelled')),
  actor      TEXT NOT NULL,
  note       TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX flow_event_card ON flow_event (card, id);
CREATE TABLE flow_trigger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  flow         INTEGER NOT NULL REFERENCES flow(id),
  kind         TEXT NOT NULL CHECK (kind IN ('button','schedule','github','linear','flow','webhook','email','chat')),
  config_json  TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active','paused','removed')),
  hook_hash    TEXT UNIQUE,
  cursor       TEXT,
  next_at      TEXT,
  last_at      TEXT,
  last_outcome TEXT,
  failures     INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX flow_trigger_live ON flow_trigger (flow, state);
CREATE TABLE flow_card_watcher (
  card     INTEGER NOT NULL REFERENCES flow_card(id),
  name     TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (card, name)
);
CREATE TABLE flow_comment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card          INTEGER NOT NULL REFERENCES flow_card(id),
  kind          TEXT NOT NULL CHECK (kind IN ('comment','owner')),
  author        TEXT NOT NULL,
  body          TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  at            TEXT NOT NULL
);
CREATE INDEX flow_comment_card ON flow_comment (card, id);
CREATE TABLE flow_script (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo            TEXT NOT NULL,
  name            TEXT NOT NULL,
  about           TEXT NOT NULL,
  body            TEXT NOT NULL,
  timeout_minutes INTEGER NOT NULL,
  version         INTEGER NOT NULL,
  digest          TEXT NOT NULL,
  saved_by        TEXT NOT NULL,
  saved_at        TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('active','removed')),
  language        TEXT NOT NULL DEFAULT 'shell',
  file            TEXT
);
CREATE UNIQUE INDEX flow_script_live ON flow_script (repo, name) WHERE state = 'active';
CREATE TABLE flow_step_run (
  card           INTEGER NOT NULL REFERENCES flow_card(id),
  entry          INTEGER NOT NULL,
  stage          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('check','update','sort','draft','request','email','tool','teammate')),
  script         TEXT,
  script_version INTEGER,
  state          TEXT NOT NULL CHECK (state IN ('running','passed','failed','waiting')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_at        TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  duration_ms    INTEGER,
  exit_code      INTEGER,
  result         TEXT,
  log            TEXT,
  decision_json  TEXT,
  PRIMARY KEY (card, entry)
);
CREATE INDEX flow_step_run_recent ON flow_step_run (started_at);
CREATE TABLE flow_trigger_event (
  trigger    INTEGER NOT NULL REFERENCES flow_trigger(id),
  key        TEXT NOT NULL,
  card       INTEGER REFERENCES flow_card(id),
  note       TEXT,
  at         TEXT NOT NULL,
  PRIMARY KEY (trigger, key)
);
CREATE TABLE flow_mail (
  message_id TEXT PRIMARY KEY,
  card       INTEGER NOT NULL REFERENCES flow_card(id),
  direction  TEXT NOT NULL CHECK (direction IN ('sent','received')),
  address    TEXT NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX flow_mail_card ON flow_mail (card, at);
CREATE TABLE teammate (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo         TEXT NOT NULL,
  handle       TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active','paused','removed')),
  version      INTEGER NOT NULL,
  soul         TEXT NOT NULL,
  model        TEXT,
  daily_turns  INTEGER NOT NULL DEFAULT 200,
  manager      TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  summary_at   TEXT,
  desk_flow    INTEGER REFERENCES flow(id),
  weekly_at    TEXT
);
CREATE UNIQUE INDEX teammate_live ON teammate (repo, handle) WHERE state <> 'removed';
CREATE TABLE teammate_version (
  teammate   INTEGER NOT NULL REFERENCES teammate(id),
  version    INTEGER NOT NULL,
  soul       TEXT NOT NULL,
  saved_by   TEXT NOT NULL,
  saved_at   TEXT NOT NULL,
  PRIMARY KEY (teammate, version)
);
CREATE TABLE teammate_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  teammate    INTEGER NOT NULL REFERENCES teammate(id),
  card        INTEGER REFERENCES flow_card(id),
  entry       INTEGER,
  kind        TEXT NOT NULL CHECK (kind IN ('decided','handled','handed','asked','answered','note','paused','resumed','summary','failed')),
  said        TEXT NOT NULL,
  detail_json TEXT,
  by          TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX teammate_event_recent ON teammate_event (teammate, id);
CREATE TABLE teammate_question (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teammate      INTEGER NOT NULL REFERENCES teammate(id),
  card          INTEGER NOT NULL REFERENCES flow_card(id),
  entry         INTEGER NOT NULL,
  question      TEXT NOT NULL,
  options_json  TEXT NOT NULL,
  asked_of      TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('open','answered','dropped')),
  choice        TEXT,
  answer        TEXT,
  answered_by   TEXT,
  answered_via  TEXT,
  answered_at   TEXT,
  created_at    TEXT NOT NULL,
  tool_call     INTEGER REFERENCES teammate_call(id),
  suggestion    INTEGER REFERENCES teammate_suggestion(id)
);
CREATE TABLE teammate_tool (
  teammate     INTEGER NOT NULL REFERENCES teammate(id),
  tool         TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  rules_json   TEXT NOT NULL,
  listed_at    TEXT,
  updated_by   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (teammate, tool)
);
CREATE TABLE teammate_call (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  teammate    INTEGER NOT NULL REFERENCES teammate(id),
  card        INTEGER NOT NULL REFERENCES flow_card(id),
  entry       INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  action      TEXT NOT NULL,
  input_json  TEXT NOT NULL,
  rule        TEXT NOT NULL CHECK (rule IN ('free','ask','never')),
  why         TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('asked','approved','denied','refused','running','done','failed')),
  result      TEXT,
  decided_by  TEXT,
  decided_at  TEXT,
  created_at  TEXT NOT NULL,
  done_at     TEXT,
  undo_of     INTEGER REFERENCES teammate_call(id),
  undone_by   TEXT,
  undone_at   TEXT
);
CREATE INDEX teammate_call_card ON teammate_call (card, entry, id);
CREATE TABLE teammate_turn (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  teammate    INTEGER NOT NULL REFERENCES teammate(id),
  card        INTEGER REFERENCES flow_card(id),
  model       TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  ms          INTEGER NOT NULL,
  cost_usd    REAL,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  at          TEXT NOT NULL
, billing TEXT);
CREATE INDEX teammate_turn_recent ON teammate_turn (teammate, at);
CREATE INDEX teammate_call_recent ON teammate_call (teammate, id);
CREATE TABLE teammate_memory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  teammate    INTEGER NOT NULL REFERENCES teammate(id),
  text        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('teammate','person')),
  card        INTEGER REFERENCES flow_card(id),
  state       TEXT NOT NULL CHECK (state IN ('active','forgotten')),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX teammate_memory_live ON teammate_memory (teammate, state, id);
CREATE TABLE teammate_suggestion (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teammate      INTEGER NOT NULL REFERENCES teammate(id),
  tool          TEXT NOT NULL,
  action        TEXT NOT NULL,
  rule_json     TEXT NOT NULL,
  was_json      TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  said          TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('open','accepted','dismissed','stale')),
  decided_by    TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX teammate_suggestion_action ON teammate_suggestion (teammate, tool, action, id);
CREATE TABLE flow_mail_watch (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  cursor       TEXT,
  next_at      TEXT,
  failures     INTEGER NOT NULL DEFAULT 0,
  last_outcome TEXT,
  updated_at   TEXT
);
CREATE TABLE project_tool (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo           TEXT NOT NULL,
  name           TEXT NOT NULL,
  spec_json      TEXT NOT NULL,
  digest         TEXT NOT NULL,
  source         TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('active','removed')),
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  removed_at     TEXT,
  removed_by     TEXT,
  last_test_json TEXT
);
CREATE UNIQUE INDEX project_tool_live ON project_tool (repo, name) WHERE state = 'active';
CREATE TABLE tool_seal (
  task            TEXT NOT NULL,
  approved_digest TEXT NOT NULL,
  tools_json      TEXT NOT NULL,
  sealed_at       TEXT NOT NULL,
  PRIMARY KEY (task, approved_digest)
);
CREATE TABLE run_tool (
  run        INTEGER PRIMARY KEY,
  tools_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE telegram_task_message (
  binding    INTEGER NOT NULL,
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  source_run INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (binding, chat_id, message_id)
);
CREATE TABLE mate_proposal (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread         INTEGER NOT NULL REFERENCES mate_thread(id) ON DELETE CASCADE,
  turn           INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('task','next','reserve','hold','unhold','steer','scope','cancel','answer','repair','agents','review','control','task_action','action')),
  payload_json   TEXT NOT NULL,
  ceiling_digest TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('drafting','pending','confirming','confirmed','refused','dismissed','expired')),
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolved_by    TEXT,
  outcome_json   TEXT
);
CREATE INDEX mate_proposal_thread ON mate_proposal (thread, state);
CREATE TABLE coordinator_proposal (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cid          TEXT NOT NULL REFERENCES coordinator_credential(cid),
  name         TEXT NOT NULL,
  repo         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('next','reserve','hold','unhold','scope','cancel','answer')),
  payload_json TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','confirming','confirmed','refused','dismissed','expired')),
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  resolved_by  TEXT,
  outcome_json TEXT
);
CREATE INDEX coordinator_proposal_state ON coordinator_proposal (state, repo);
CREATE TABLE mate_turn (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  approver          TEXT NOT NULL,
  session           INTEGER NOT NULL REFERENCES mate_session(id),
  thread            INTEGER NOT NULL REFERENCES mate_thread(id),
  credential_key    TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('queued','running','answered','failed')),
  generation        INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  deadline_at       TEXT NOT NULL,
  finished_at       TEXT,
  reserved_microusd INTEGER NOT NULL,
  settled_microusd  INTEGER,
  steps             INTEGER NOT NULL DEFAULT 0,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  failure_reason    TEXT
);
CREATE INDEX mate_turn_live ON mate_turn (approver, state);
CREATE TABLE routine_fire (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id        INTEGER NOT NULL REFERENCES routine(id) ON DELETE CASCADE,
  scheduled_for     TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('fired','skipped')),
  reason            TEXT,
  instance_task_ref INTEGER REFERENCES task_ref(id),
  created_at        TEXT NOT NULL,
  UNIQUE (routine_id, scheduled_for)
);
CREATE INDEX routine_fire_recent ON routine_fire (routine_id, id DESC);
CREATE TABLE hold (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref   INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('operator','decision','incident','backoff','contest','revision','stop')),
  owner_id   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  until      TEXT,
  held_at    TEXT NOT NULL,
  UNIQUE (owner_kind, owner_id)
);
CREATE TABLE claim (
  lease_id         TEXT PRIMARY KEY,
  task_ref         INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  lease_generation INTEGER NOT NULL,
  runner           TEXT NOT NULL,
  acquired_at      TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  heartbeat_at     TEXT NOT NULL,
  released_at      TEXT,
  -- Who let go, because "released" alone conflates four different events:
  -- the runner handing it back ('released'), a completion being accepted
  -- ('completed'), expiry reap ('reaped'), and dead-runner recovery
  -- ('recovered'). A retry that finds its lease released must know which:
  -- answering "duplicate" to a runner whose lease was in fact reclaimed
  -- would accept work the reclaim already disowned.
  released_by      TEXT, incarnation TEXT,
  UNIQUE (task_ref, lease_generation)
);
CREATE TABLE capability (
  repo             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('env','cli','mcp','ci','other')),
  name             TEXT NOT NULL,
  probe            TEXT,
  status           TEXT NOT NULL DEFAULT 'unprobed' CHECK (status IN ('unprobed','verified','failed')),
  added_by         TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_verified_at TEXT,
  -- Who ran the probe that produced this status. Verification is a claim
  -- about one environment: the machine whose shell answered. Another runner
  -- trusts it only by re-proving it where it stands, which is what tick does.
  verified_by      TEXT,
  -- The probe's own words when it said no — "exit 1", "timed out", "sh not
  -- found". Collapsing those into one bit would discard exactly the detail
  -- that tells an operator whether to paste a key or fix a PATH.
  last_result      TEXT,
  expires_at       TEXT,
  PRIMARY KEY (repo, kind, name)
);
CREATE TABLE run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  lease_id      TEXT NOT NULL,
  runner        TEXT NOT NULL,
  -- v24 dispatch stamps: the digests this invocation was PROVED against
  -- (warm resume matches on both), and the provider CLI version as
  -- provenance — never authority.
  scope_digest     TEXT,
  profile_digest   TEXT,
  provider_version TEXT,
  -- 'repair' is a resumed session mending its own malformed park payload.
  -- Deliberately NOT 'driver': the design's driver is the event-woken gate
  -- role that first exists at M4, and recording repair under that name now
  -- would make the two indistinguishable in every cost report afterwards.
  -- 'scout' (v34) reads a repository and delivers a report — its own word
  -- so scouting spend never hides under planning or building.
  role          TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair','planner','reviewer','scout')),
  -- Which provider harness this attempt ran on (v9). The default is a
  -- truthful backfill for history: every run before v9 passed through the
  -- fixed claude gateway. New dispatches always supply it explicitly.
  provider      TEXT NOT NULL DEFAULT 'claude',
  parent_run    INTEGER REFERENCES run(id),
  -- The agent session, kept so a malformed park can be repaired by resuming
  -- the conversation that produced it instead of paying for a fresh one.
  session_id    TEXT,
  -- HEAD before the agent spent anything. Evidence is a diff against this,
  -- not against whatever the index looked like when the agent stopped: an
  -- agent that staged or committed before parking would otherwise show a
  -- clean diff over material changes.
  base_revision TEXT,
  branch        TEXT,
  worktree      TEXT,
  model         TEXT,
  phase         TEXT,
  contestant    INTEGER REFERENCES contestant(id),
  -- 'interrupted' (v25) is a held attended session cut down mid-flight —
  -- fence, expiry, crash custody, or shutdown. A real word, never a
  -- synthesized park; the one-shot road keeps writing failed/interrupted
  -- as outcome+reason exactly as before.
  outcome       TEXT CHECK (outcome IN ('built','failed','refused','parked','no-change','interrupted')),
  reason        TEXT,
  committed     INTEGER,
  -- The attended authorization this run consumed (v25) — the ruling-12
  -- attempt identity, stamped in the same transaction that consumes the
  -- one attempt. NULL = ordinary approved/tournament dispatch.
  attended_authorization TEXT REFERENCES attended_authorization(id),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  -- Stamped by the invocation gateway the instant before the provider
  -- process spawns. A run without it never paid anything; the zero-token
  -- invariant is "provider spawns == runs carrying this stamp".
  provider_started_at TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  -- The provider's own usage object, bounded, for when the parsed columns
  -- above turn out to have missed something. NULL = unmeasured, and the
  -- brief says so rather than summing a lie.
  usage_json    TEXT,
  -- HEAD after the agent, as accepted. The builder owns commits; an agent
  -- that moved HEAD itself is refused, so this names the exact commit any
  -- publication may push.
  head_revision TEXT,
  -- The validated terminal handoff's conclusion — bounded, typed at
  -- ingestion, and the only agent prose a PR body may quote.
  handoff       TEXT,
  -- The fallback-chain and credential stamps (v30), inline since v34 —
  -- the same columns ALTER appended on older files; the v34 rebuild
  -- recognizes both placements as one shape.
  chain_cycle INTEGER REFERENCES fallback_cycle(id), chain_index INTEGER, entry_digest TEXT, auth_mode TEXT, terminal_class TEXT, quality_mode TEXT NOT NULL DEFAULT 'default' CHECK (quality_mode IN ('default','strict')), plan_revision INTEGER REFERENCES plan_revision(id), authority_digest TEXT, watch_incarnation TEXT, review_attempt INTEGER,
  -- v29 (the reviewer role): artifact-only runs carry NO workspace,
  -- honestly — every other role requires both (exclusive, no sentinels).
  CHECK ((role = 'reviewer' AND branch IS NULL AND worktree IS NULL)
      OR (role <> 'reviewer' AND branch IS NOT NULL AND worktree IS NOT NULL))
);
CREATE TABLE artifact (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief','base-tree','report','proof','check-log','screenshot','structured-output','plan-contract','review-context')),
  key            TEXT NOT NULL,
  bytes_original INTEGER NOT NULL,
  bytes_stored   INTEGER NOT NULL,
  truncated      INTEGER NOT NULL DEFAULT 0,
  sha256         TEXT NOT NULL,
  capture        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  redacted       INTEGER NOT NULL DEFAULT 0,
  -- Typed capture verdict (v14, finding 20): authority never parses the
  -- prose capture description again. NULL = recorded before v14.
  capture_status TEXT CHECK (capture_status IN ('ok','failed'))
);
CREATE TABLE decision_artifact (
  decision INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  artifact INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  PRIMARY KEY (decision, artifact)
);
CREATE TABLE run_decision (
  run      INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  decision INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  choice   TEXT NOT NULL,
  note     TEXT,
  PRIMARY KEY (run, decision)
);
CREATE TABLE incident (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('malformed-decision','attempts-exhausted','commit-failure','malformed-plan','plan-attempts-exhausted','malformed-report','malformed-proof')),
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE TABLE notification (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key      TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error      TEXT,
  delivered_at    TEXT,
  -- What the delivery command said on success — the closest thing to a
  -- provider receipt a shell command can hand back.
  receipt         TEXT,
  -- The push surface (arc 3, v23): a CLOSED attention class and a
  -- machine-minted console link, stamped by producers at enqueue.
  -- Unstamped kinds never reach a phone; subject/body never do either.
  push_class      TEXT CHECK (push_class IN ('decision','pick','merge','attention')),
  link            TEXT
, resolved_at TEXT, claim_owner TEXT, claim_expires_at TEXT, provenance_scope TEXT NOT NULL DEFAULT 'unknown' CHECK (provenance_scope IN ('unknown','installation','project','task')), project TEXT, task_ref INTEGER REFERENCES task_ref(id), task_id TEXT, source_run INTEGER REFERENCES run(id), recipient TEXT);
CREATE TABLE telegram_digest (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  every_ms     INTEGER,
  set_by       TEXT,
  set_at       TEXT,
  last_sent_at TEXT
);
CREATE TABLE backend_grant (
  repo             TEXT NOT NULL,
  backend          TEXT NOT NULL,
  paths            TEXT NOT NULL DEFAULT '[]',
  mutations        TEXT NOT NULL DEFAULT '[]',
  selector         TEXT NOT NULL,
  credential_scope TEXT,
  observed_by_git  INTEGER NOT NULL,
  granted_at       TEXT NOT NULL,
  granted_by       TEXT NOT NULL,
  -- External dispatch (v20): a SEPARATE authority from tracker writes —
  -- "this plane will BUILD what this tracker nominates". Never granted
  -- by default; dispatch=1 requires remote_repo and plane_id (enforced
  -- in saveGrant — ALTER ADD COLUMN cannot carry cross-column CHECKs).
  dispatch                INTEGER NOT NULL DEFAULT 0 CHECK (dispatch IN (0, 1)),
  remote_repo             TEXT,
  plane_id                TEXT,
  dispatch_blocked        TEXT CHECK (dispatch_blocked IN ('pending-marker','unreachable','foreign','missing','multiple-or-malformed')),
  dispatch_blocked_at     TEXT,
  dispatch_blocked_detail TEXT,
  PRIMARY KEY (repo, backend)
);
CREATE TABLE external_mirror (
  local_task_id   TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  backend         TEXT NOT NULL,
  remote_repo     TEXT NOT NULL,
  remote_id       TEXT NOT NULL,
  provenance      TEXT NOT NULL CHECK (provenance IN ('local-create','intake','granted-all')),
  intake_grant    INTEGER,
  established_by  TEXT NOT NULL,
  established_at  TEXT NOT NULL,
  remote_state    TEXT NOT NULL CHECK (remote_state IN ('open','closed','missing')),
  close_generation INTEGER,
  sync_generation INTEGER NOT NULL DEFAULT 0,
  dispatch_ok     INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_ok IN (0, 1)),
  reopened_by     TEXT,
  reopened_at     TEXT,
  CHECK ((provenance = 'intake') = (intake_grant IS NOT NULL)),
  UNIQUE (backend, remote_repo, remote_id)
);
CREATE TRIGGER external_mirror_immutable
BEFORE UPDATE ON external_mirror
WHEN OLD.backend IS NOT NEW.backend OR OLD.remote_repo IS NOT NEW.remote_repo
  OR OLD.remote_id IS NOT NEW.remote_id OR OLD.provenance IS NOT NEW.provenance
  OR OLD.intake_grant IS NOT NEW.intake_grant
  OR OLD.established_by IS NOT NEW.established_by OR OLD.established_at IS NOT NEW.established_at
BEGIN
  SELECT RAISE(ABORT, 'external mirror identity is immutable');
END;
CREATE TABLE sync_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  backend     TEXT NOT NULL,
  remote_repo TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  outcome     TEXT CHECK (outcome IN ('complete','capped','failed')),
  candidates  INTEGER NOT NULL DEFAULT 0,
  mirrored    INTEGER NOT NULL DEFAULT 0,
  detail      TEXT,
  UNIQUE (backend, remote_repo, generation)
);
CREATE TABLE external_intent (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mirror       TEXT NOT NULL REFERENCES external_mirror(local_task_id),
  kind         TEXT NOT NULL CHECK (kind IN ('comment','transition','close')),
  body         TEXT,
  state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','refused')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);
CREATE TABLE ci_observation (
  github_repo TEXT NOT NULL,
  pr_number   INTEGER NOT NULL,
  head_sha    TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('passing','failing','running','none')),
  generation  INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (github_repo, pr_number)
);
CREATE TABLE merge_intent (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  publication   INTEGER NOT NULL UNIQUE REFERENCES publication(id),
  grant_terms_hash TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('squash','merge','rebase')),
  delete_branch INTEGER NOT NULL DEFAULT 0 CHECK (delete_branch IN (0, 1)),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','waiting-human','firing','merged','refused','superseded')),
  claimed_by    TEXT,
  claimed_until TEXT,
  -- v29 (modes): WHOSE signature this intent fires under, bound at
  -- creation and re-proved in the firing CAS — 'grant' = the grant
  -- ceremony's own unattended-merge signature; 'mode' = a live automerge
  -- mode; 'human' = the per-merge password ceremony.
  authority_basis TEXT NOT NULL DEFAULT 'grant' CHECK (authority_basis IN ('grant','mode','human')),
  mode_digest   TEXT,
  -- v29: the durable one-winner linearization point — the CAS into
  -- 'firing' stamps both; staleness is firing_deadline passing, never a
  -- guess.
  firing_at     TEXT,
  firing_deadline TEXT,
  generation    INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  receipt       TEXT,
  created_at    TEXT NOT NULL,
  settled_at    TEXT,
  CHECK (state <> 'claimed' OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL)),
  CHECK (state <> 'firing' OR (firing_at IS NOT NULL AND firing_deadline IS NOT NULL))
);
CREATE TABLE merge_blocker (
  publication INTEGER NOT NULL REFERENCES publication(id),
  reason      TEXT NOT NULL CHECK (reason IN ('repair-open')),
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  -- v29: lifting is a stamp, not a DELETE — who unblocked, and when, is
  -- an audit answer the People screen promises. One LIVE blocker per
  -- publication (partial unique in the post-migration block); lifted
  -- rows are history and never block a new block.
  lifted_at   TEXT,
  lifted_by   TEXT
);
CREATE TABLE operating_mode (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo            TEXT NOT NULL,
  name            TEXT NOT NULL CHECK (name IN ('standard','hands-off')),
  terms_json      TEXT NOT NULL,
  digest          TEXT NOT NULL,
  signed_by       TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  signed_at       TEXT NOT NULL,
  absolute_expiry TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_by      TEXT,
  revoke_reason   TEXT
);
CREATE UNIQUE INDEX one_live_mode_per_repo
  ON operating_mode (repo) WHERE revoked_at IS NULL;
CREATE TABLE operating_mode_event (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  mode     INTEGER NOT NULL REFERENCES operating_mode(id),
  kind     TEXT NOT NULL CHECK (kind IN ('signed','renewed','revoked','expired-closed','signer-revoked')),
  actor    TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE TABLE invite (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('approver','viewer')),
  minted_by   TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  minted_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_by TEXT,
  consumed_at TEXT,
  revoked_at  TEXT
, projects_json TEXT);
CREATE TABLE mode_rail (
  repo            TEXT NOT NULL,
  utc_day         TEXT NOT NULL,
  reserved_starts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, utc_day)
);
CREATE TABLE task_scope (
  task_id         TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  goal            TEXT NOT NULL,
  out_of_scope    TEXT,
  touches         TEXT NOT NULL DEFAULT '[]',
  proposed_at     TEXT NOT NULL,
  digest          TEXT NOT NULL,
  -- The dollar cap per build attempt, integer micro-dollars (v15):
  -- approved spend, digest-bound, enforced by the provider's own stop.
  budget_microusd INTEGER,
  approved_at     TEXT,
  approved_by     TEXT,
  approved_digest TEXT,
  -- The execution profile (v24, Parity II foundations): WHAT RUNS, bound
  -- into what the operator signs. profile_json = the working profile;
  -- approved_profile_json = the immutable snapshot the approval act took;
  -- digest_version 1 = legacy fields-only digest (grandfathered), 2 =
  -- profile-bearing. profile_state 'unresolved' blocks dispatch AND
  -- approval, with its reason in words. Provenance (resolvedFrom,
  -- grandfathered, provider version) lives in profile_provenance and
  -- NEVER enters a digest.
  profile_json          TEXT,
  profile_state         TEXT NOT NULL DEFAULT 'resolved' CHECK (profile_state IN ('resolved','unresolved')),
  unresolved_reason     TEXT,
  approved_profile_json TEXT,
  digest_version        INTEGER NOT NULL DEFAULT 1,
  profile_provenance    TEXT,
  -- The EXPLICIT fallback chain (v30, fallback chains). proposed_chain_json
  -- is the WORKING snapshot saveScope binds the digest to when the repo has
  -- configured fallbacks (mirrors profile_json); approved_chain_json is the
  -- immutable snapshot the approval COPIED from it (mirrors
  -- approved_profile_json = profile_json), so what is sealed is exactly what
  -- the signed digest bound — never re-resolved. Both NULL = a legacy
  -- single-profile (or no-profile) scope, untouched. approval_kind names
  -- which the approval sealed: 'profile' (legacy) or 'chain'.
  proposed_chain_json   TEXT,
  approved_chain_json   TEXT,
  -- The signed acceptance rubric (v39, Acceptance Contract v2): the SAME
  -- additive shape as every digest-bound field before it. NULL/absent
  -- reads back as [] and digests exactly as a rubric-less scope always
  -- has -- grandfathering is this column simply not existing on a row
  -- nobody has rewritten since. What makes a rubric MANDATORY going
  -- forward is enforced by the authoring roads (proposeGuarded,
  -- createConsoleTask, routine firing, the planner), never by this
  -- schema or by saveScope itself.
  acceptance_json       TEXT,
  -- The concrete quality policy (v41), folded into digest only when strict
  -- so every historical/default approval remains byte-identical.
  quality_mode          TEXT NOT NULL DEFAULT 'default' CHECK (quality_mode IN ('default','strict')),
  approval_kind         TEXT NOT NULL DEFAULT 'profile' CHECK (approval_kind IN ('profile','chain')),
  -- The phase route (v47, explainable risk-aware routing). risk_level is
  -- the signed risk; proposed_route_json is the WORKING canonical route
  -- saveScope computed from risk, quality, evidence, publication, the
  -- configured candidate tiers, and the task's overrides; EVERY route
  -- filed since v47 folds its digest into the scope digest, routine-shaped
  -- ones included. approved_route_json is the immutable snapshot the seal
  -- COPIED, exactly as approved_profile_json mirrors profile_json —
  -- dispatch re-proves against it and mutable configuration can never
  -- rewrite it. route_era is the DURABLE marker: NULL only on a row proven
  -- to predate v47 (legacy — its sealed profile alone governs the build);
  -- the route version on every row saveScope has written since. A row with
  -- an era and a missing or unreadable route is corrupt and FAILS CLOSED
  -- at approval, dispatch, review, and repair alike.
  risk_level            TEXT NOT NULL DEFAULT 'routine' CHECK (risk_level IN ('routine','elevated','high')),
  proposed_route_json   TEXT,
  approved_route_json   TEXT,
  route_era             INTEGER
, proposed_via TEXT, approval_basis TEXT, mode_digest TEXT, candidate TEXT);
CREATE TABLE approver (
  name            TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL,
  added_at        TEXT NOT NULL,
  -- v29 (multi-user): 'viewer' authenticates and reads; every
  -- consequential act requires ACTIVE role 'approver'. Revocation is a
  -- stamp — history stays attributable forever.
  role            TEXT NOT NULL DEFAULT 'approver' CHECK (role IN ('approver','viewer')),
  revoked_at      TEXT,
  revoked_by      TEXT,
  -- Bumped whenever the credential is replaced. Anything that derives
  -- authority from an approver — a paired Telegram chat, an outstanding
  -- pairing code — records the generation it was granted under, and a
  -- rotation strands every grant from the old one.
  generation      INTEGER NOT NULL DEFAULT 1
, projects_json TEXT);
CREATE TABLE telegram_binding (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id              TEXT NOT NULL,
  chat_id             TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  approver            TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  approver_generation INTEGER NOT NULL,
  paired_at           TEXT NOT NULL,
  paired_by           TEXT NOT NULL,
  pair_update_id      INTEGER,
  revoked_at          TEXT,
  revoked_by          TEXT
);
CREATE UNIQUE INDEX telegram_binding_live_user
  ON telegram_binding (bot_id, user_id) WHERE revoked_at IS NULL;
CREATE TABLE telegram_team_chat (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id       TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  binding      INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  kind         TEXT NOT NULL CHECK (kind IN ('group','private')),
  conversation TEXT NOT NULL REFERENCES team_conversation(id) ON DELETE RESTRICT,
  bound_by     TEXT NOT NULL,
  bound_at     TEXT NOT NULL,
  cursor       INTEGER NOT NULL DEFAULT 0,
  revoked_at   TEXT,
  revoked_by   TEXT
);
CREATE UNIQUE INDEX telegram_team_chat_live
  ON telegram_team_chat (bot_id, chat_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX telegram_team_chat_group
  ON telegram_team_chat (conversation) WHERE revoked_at IS NULL AND kind = 'group';
CREATE TABLE notification_delivery (
  notification INTEGER NOT NULL REFERENCES notification(id) ON DELETE RESTRICT,
  destination TEXT NOT NULL,
  claim_owner TEXT,
  claim_generation INTEGER NOT NULL DEFAULT 0,
  claim_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  delivered_at TEXT,
  receipt TEXT,
  PRIMARY KEY (notification, destination)
);
CREATE TABLE telegram_outbound_message (
  binding INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  notification INTEGER NOT NULL REFERENCES notification(id) ON DELETE RESTRICT,
  destination TEXT NOT NULL,
  project TEXT,
  task_ref INTEGER REFERENCES task_ref(id),
  task_id TEXT,
  source_run INTEGER REFERENCES run(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (binding, chat_id, message_id, notification)
);
CREATE TABLE telegram_retry (
  bot_id TEXT PRIMARY KEY,
  next_attempt_at TEXT NOT NULL
);
CREATE TABLE telegram_pairing (
  code_hash       TEXT PRIMARY KEY,
  approver        TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  approver_generation INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_chat   TEXT,
  consumed_user   TEXT,
  consumed_update INTEGER
);
CREATE TABLE telegram_update (
  update_id  INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  result     TEXT NOT NULL
);
CREATE TABLE telegram_action (
  token       TEXT PRIMARY KEY,
  binding     INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  decision    INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  option_id   TEXT NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN ('choose','confirm','cancel')),
  chat_id     TEXT NOT NULL,
  message_id  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  consumed_at TEXT
, note_digest TEXT);
CREATE INDEX telegram_action_by_decision ON telegram_action (decision);
CREATE TABLE telegram_flow_action (
  token       TEXT PRIMARY KEY,
  binding     INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  card        INTEGER NOT NULL REFERENCES flow_card(id),
  entry       INTEGER NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('approve','edit','send-back')),
  chat_id     TEXT NOT NULL,
  message_id  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX telegram_flow_action_visit ON telegram_flow_action (card, entry);
CREATE TABLE telegram_question_action (
  token       TEXT PRIMARY KEY,
  binding     INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  question    INTEGER NOT NULL REFERENCES teammate_question(id),
  choice      TEXT,
  chat_id     TEXT NOT NULL,
  message_id  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE telegram_question_prompt (
  chat_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  binding     INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  question    INTEGER NOT NULL REFERENCES teammate_question(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE telegram_flow_prompt (
  chat_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  binding     INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  card        INTEGER NOT NULL REFERENCES flow_card(id),
  entry       INTEGER NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('edit','send-back')),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE telegram_decision_message (
  binding    INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE CASCADE,
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  decision   INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (binding, chat_id, message_id)
);
CREATE TABLE telegram_note_draft (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  binding    INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE CASCADE,
  decision   INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  update_id  INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  reply_to   TEXT NOT NULL,
  note       TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','armed','superseded','consumed','discarded')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX telegram_note_draft_live
  ON telegram_note_draft (binding, decision) WHERE state IN ('pending','armed');
CREATE TABLE telegram_conversation (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  binding             INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  bot_id              TEXT NOT NULL,
  chat_id             TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  approver            TEXT NOT NULL,
  approver_generation INTEGER NOT NULL,
  update_id           INTEGER NOT NULL UNIQUE,
  message_id          TEXT NOT NULL,
  reply_to            TEXT,
  request             TEXT NOT NULL UNIQUE,
  text                TEXT NOT NULL,
  context             TEXT,
  task_id             TEXT,
  source_run          INTEGER,
  state               TEXT NOT NULL CHECK (state IN ('queued','running','done','failed')),
  claim_owner         TEXT,
  claim_expires_at    TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT,
  session             INTEGER,
  turn                INTEGER,
  outcome             TEXT,
  reply_message_id    TEXT,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  finished_at         TEXT
);
CREATE INDEX telegram_conversation_queue ON telegram_conversation (bot_id, state, id);
CREATE TABLE telegram_proposal_action (
  token       TEXT PRIMARY KEY,
  binding     INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  proposal    INTEGER NOT NULL REFERENCES mate_proposal(id) ON DELETE CASCADE,
  phase       TEXT NOT NULL CHECK (phase IN ('confirm','dismiss','yes','cancel')),
  chat_id     TEXT NOT NULL,
  message_id  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  consumed_at TEXT
);
CREATE INDEX telegram_proposal_action_by_proposal ON telegram_proposal_action (proposal);
CREATE TABLE telegram_conversation_part (
  conversation    INTEGER NOT NULL REFERENCES telegram_conversation(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('reply','card','image')),
  text            TEXT NOT NULL,
  reply_to        TEXT,
  proposal        INTEGER REFERENCES mate_proposal(id) ON DELETE SET NULL,
  keyboard_json   TEXT,
  state           TEXT NOT NULL CHECK (state IN ('pending','sent','dropped')),
  message_id      TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  uncertain       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  sent_at         TEXT,
  task_id         TEXT,
  source_run      INTEGER REFERENCES run(id),
  artifact        INTEGER,
  sha256          TEXT,
  PRIMARY KEY (conversation, ordinal),
  CHECK ((state = 'sent') = (message_id IS NOT NULL)),
  CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
  CHECK ((kind = 'image') = (task_id IS NOT NULL AND source_run IS NOT NULL AND artifact IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE TABLE mate_turn_evidence (
  turn       INTEGER NOT NULL REFERENCES mate_turn(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  task_id    TEXT NOT NULL,
  task_ref   INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  run        INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  artifact   INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  sha256     TEXT NOT NULL,
  format     TEXT NOT NULL CHECK (format IN ('png','jpeg')),
  bytes      INTEGER NOT NULL,
  caption    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (turn, ordinal),
  UNIQUE (turn, artifact)
);
CREATE TABLE bridge_lease (
  bot_id       TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  cursor       INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  push_url     TEXT,
  push_at      TEXT,
  push_problem TEXT
);
CREATE TABLE telegram_inbox (
  update_id    INTEGER PRIMARY KEY,
  bot_id       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  received_at  TEXT NOT NULL
);
CREATE TABLE wake (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE watch_lease (
  runner       TEXT NOT NULL,
  repo         TEXT NOT NULL,
  owner        TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (runner, repo)
);
CREATE TABLE quota (
  runner      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  -- v30 (fallback chains): quota identity must distinguish a subscription
  -- from an API key, else exhausting a claude subscription would wrongly
  -- block a claude api-key fallback. auth_mode + a stable NON-SECRET
  -- credential fingerprint join the key. Defaults keep every pre-v30 row
  -- identical (mode 'subscription', empty fp) since that is what they were.
  auth_mode   TEXT NOT NULL DEFAULT 'subscription' CHECK (auth_mode IN ('subscription','api-key')),
  credential_fp TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL CHECK (state IN ('exhausted','half-open')),
  reason      TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  reset_at    TEXT,
  PRIMARY KEY (runner, provider, scope, auth_mode, credential_fp)
);
CREATE TABLE fallback_cycle (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  -- The approved chain this cycle walks; the cycle is void if the approval
  -- moves (the CAS re-proves it).
  chain_digest  TEXT NOT NULL,
  cursor        INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL CHECK (state IN ('open','sanitizing','awaiting-release','pending-admission','incident','closed')),
  transition_generation INTEGER NOT NULL DEFAULT 0,
  -- The current tail run (the entry running, or the predecessor being
  -- sanitized). NULL only transiently at pending-admission before the next
  -- run opens.
  tail_run      INTEGER REFERENCES run(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_reason TEXT
);
CREATE TABLE fallback_transition (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle         INTEGER NOT NULL REFERENCES fallback_cycle(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('exhaustion','quota-skip')),
  from_index    INTEGER NOT NULL,
  to_index      INTEGER NOT NULL,
  -- The predecessor run whose exhaustion (or whose skip evidence) earned
  -- this step; NULL for a fresh cycle's index-0 (there is no transition
  -- into index 0 — a cycle starts there).
  predecessor_run INTEGER REFERENCES run(id),
  -- The gateway-stamped terminal class + proven evidence identity that
  -- authorized an 'exhaustion' step (NULL for quota-skip, which cites
  -- durable quota evidence instead).
  terminal_class  TEXT,
  evidence_provider TEXT,
  evidence_version  TEXT,
  evidence_auth_mode TEXT,
  evidence_fp     TEXT,
  created_at    TEXT NOT NULL,
  -- The run that consumed this transition's authority (single-use). NULL
  -- until admission; set once, in the same txn that opens the next run.
  consumed_by   INTEGER REFERENCES run(id)
);
CREATE TABLE watch_episode (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT NOT NULL,
  runner      TEXT NOT NULL,
  incarnation TEXT NOT NULL UNIQUE,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  ticks       INTEGER NOT NULL DEFAULT 0,
  built       INTEGER NOT NULL DEFAULT 0,
  broke       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE project (
  path           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  added_at       TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);
CREATE INDEX project_recent ON project (last_opened_at);
CREATE TABLE publication_grant (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo         TEXT NOT NULL,
  github_repo  TEXT NOT NULL,
  remote       TEXT NOT NULL,
  head_prefix  TEXT NOT NULL,
  base         TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  selector     TEXT NOT NULL CHECK (selector IN ('ours','all')),
  draft        INTEGER NOT NULL DEFAULT 1,
  granted_by   TEXT NOT NULL,
  granted_at   TEXT NOT NULL,
  revoked_by   TEXT,
  revoked_at   TEXT
, merge INTEGER NOT NULL DEFAULT 0 CHECK (merge IN (0, 1)), merge_method TEXT CHECK (merge_method IN ('squash','merge','rebase')), merge_delete_branch INTEGER NOT NULL DEFAULT 0 CHECK (merge_delete_branch IN (0, 1)));
CREATE UNIQUE INDEX publication_grant_live
  ON publication_grant (repo) WHERE revoked_at IS NULL;
CREATE TABLE publication (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  task_ref    INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  github_repo TEXT NOT NULL,
  remote      TEXT NOT NULL,
  base        TEXT NOT NULL,
  head        TEXT NOT NULL,
  head_sha    TEXT NOT NULL,
  body_hash   TEXT NOT NULL,
  draft       INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('intended','pushed','opened','failed')),
  pr_number   INTEGER,
  pr_url      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  -- The remote's own verdict, observed (M8 audit C-6): MERGED/CLOSED ends
  -- the watch without widening the local state CHECK.
  remote_state TEXT,
  -- What CI was last SEEN doing, and when (audit SD-4): the review queue
  -- ranks observed-passing first and never upgrades silence to green.
  last_check_state TEXT,
  last_check_at    TEXT
);
CREATE TABLE runner (
  name            TEXT PRIMARY KEY,
  host            TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  capacity        INTEGER NOT NULL,
  -- What capacity bounds (v14, finding 26): 'tasks' is the original
  -- contract (live claims) and stays the default; 'processes' counts
  -- worker processes via execution_slot and is an explicit opt-in —
  -- an upgrade never silently changes what an operator's number means.
  capacity_mode   TEXT NOT NULL DEFAULT 'tasks' CHECK (capacity_mode IN ('tasks','processes')),
  repos           TEXT NOT NULL DEFAULT '[]',
  agents          TEXT NOT NULL DEFAULT '[]',
  registered_at   TEXT NOT NULL,
  heartbeat_at    TEXT NOT NULL,
  retired_at      TEXT,
  -- The queue column's theme note (v19) — operator prose, display only.
  queue_note      TEXT
);
CREATE TABLE worktree (
  path          TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  branch        TEXT NOT NULL,
  runner        TEXT REFERENCES runner(name) ON DELETE SET NULL,
  task_ref      INTEGER REFERENCES task_ref(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  leased_at     TEXT,
  released_at   TEXT,
  -- Reconstructed state is trusted only after it has been checked; see
  -- treehouse's rule about state you did not watch being created.
  verified      INTEGER NOT NULL DEFAULT 0,
  -- Per-occupancy epoch (live-peek findings 16/28): a fresh random value
  -- written ATOMICALLY with every lease and rotated on release, so it can
  -- never repeat across release/forget/adopt/recreation. An observation
  -- proved against one epoch is DISCARDED if the epoch moved before it
  -- rendered — the fence that keeps a successor occupant's files out of a
  -- predecessor's page.
  lease_epoch   TEXT,
  -- The approved setup this checkout last ran to completion (M5.7):
  -- matching the live setup's digest is the cache hit; anything else runs
  -- it again before an agent may spawn here.
  setup_digest  TEXT
);
CREATE TABLE worktree_setup (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT NOT NULL,
  command     TEXT NOT NULL,
  timeout_ms  INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT
);
CREATE UNIQUE INDEX worktree_setup_live
  ON worktree_setup (repo) WHERE revoked_at IS NULL;
CREATE TABLE verify_command (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT NOT NULL,
  command     TEXT NOT NULL,
  timeout_ms  INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  -- v45: opt-in authority for exactly one post-commit replay of this
  -- setup digest when the verification command cannot start because a
  -- required project executable is unavailable. NULL preserves every older grant.
  recovery_setup_digest TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT
);
CREATE UNIQUE INDEX verify_command_live
  ON verify_command (repo) WHERE revoked_at IS NULL;
CREATE TABLE proof_verdict (
  run         INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  verdict     TEXT NOT NULL CHECK (verdict IN ('verified','attested','short','refuted')),
  reasons_json TEXT NOT NULL,
  decided_at  TEXT NOT NULL,
  -- v39: the criterion-to-evidence matrix adjudicate() computed alongside
  -- the verdict -- one shared render, never re-derived. NULL for every
  -- verdict decided before this migration, and for any run whose scope
  -- signed no rubric (adjudicate returns [] and this column stores NULL,
  -- not "[]", so a surface can tell "no matrix" from "an empty one" --
  -- not that the two currently read any differently).
  matrix_json TEXT,
  -- v40 (evidence-review-v1): the verdict adjudicate() computed, BEFORE an
  -- independent reviewer's judgements were folded in — NULL means "no
  -- review folded", reading back exactly as today. Never overwritten once
  -- set: one SUCCESSFUL review per source run, ever (v50's
  -- one_successful_root_review_per_source), so this is written at most
  -- once, by the same transaction that folds it.
  machine_verdict TEXT CHECK (machine_verdict IS NULL OR machine_verdict IN ('verified','attested','short','refuted'))
);
CREATE TABLE criterion_review (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reviewer_run  INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  source_run    INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  criterion_id  TEXT NOT NULL,
  judgement     TEXT NOT NULL CHECK (judgement IN ('upholds','contradicts','cannot-tell')),
  note          TEXT NOT NULL,
  artifact      INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  artifact_sha  TEXT NOT NULL,
  author        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  -- Audit hardening (still evidence-review-v1, unreleased): every input the
  -- reviewer was actually shown, hash-bound and RE-VALIDATED against the
  -- live store at ingest time by ingestReview() -- never trusted from the
  -- caller's say-so. NULL exactly when that input never existed for this
  -- run (no verify command configured, no screenshots claimed): an
  -- omission, recorded as one, never confused with a mismatch.
  scope_digest       TEXT,
  head_sha           TEXT,
  proof_artifact     INTEGER,
  proof_sha          TEXT,
  check_log_artifact INTEGER,
  check_log_sha      TEXT,
  screenshots_json   TEXT NOT NULL DEFAULT '[]',
  -- v51 (inherited review context): the sealed context inventory the
  -- reviewer was shown, hash-bound and re-validated at ingest exactly like
  -- the proof. NULL exactly when the run captured no inventory (every run
  -- that is not a revision, and every run before v51).
  context_artifact   INTEGER,
  context_sha        TEXT
);
CREATE TABLE repair_chain (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  root_task       TEXT NOT NULL,
  source_run      INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  attempt         INTEGER NOT NULL,
  draft_task      TEXT,
  basis           TEXT NOT NULL CHECK (basis IN ('human','mode')),
  mode_digest     TEXT,
  unresolved_json TEXT NOT NULL,
  outcome         TEXT NOT NULL DEFAULT 'drafted'
                    CHECK (outcome IN ('drafted','attempts-spent','no-progress','integrity-refused','resolved')),
  created_at      TEXT NOT NULL,
  settled_at      TEXT
);
CREATE INDEX repair_chain_root ON repair_chain (root_task, attempt);
CREATE TABLE proof_acceptance (
  run         INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  approver    TEXT NOT NULL,
  note        TEXT,
  accepted_at TEXT NOT NULL
);
CREATE TABLE run_note (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run        INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  note       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE intake_grant (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT NOT NULL,
  github      TEXT NOT NULL,
  label       TEXT NOT NULL,
  reviewers   TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT
);
CREATE UNIQUE INDEX intake_grant_live
  ON intake_grant (repo) WHERE revoked_at IS NULL;
CREATE TABLE diff_comment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact      INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  artifact_sha  TEXT NOT NULL,
  run           INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  path          TEXT,
  line          INTEGER,
  note          TEXT NOT NULL,
  author        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  superseded_by INTEGER REFERENCES diff_comment(id),
  consumed_by   TEXT,
  -- Where an ingested comment came from (M8.17): gh:<owner/name>:<id>.
  -- The GitHub comment id is the idempotency key — one ingest, ever.
  -- Its unique index is created AFTER migration (see openStore): a
  -- database whose diff_comment predates the column would die on an
  -- index statement inside this schema block before addColumn could run.
  source_key    TEXT
, reviewer_run INTEGER REFERENCES run(id), severity TEXT CHECK (severity IN ('note','question','problem')));
CREATE TABLE review_request (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run             INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  -- Who asked, as words for the page. AUTHORITY lives in basis/mode_digest
  -- below, never in this string (Codex reviewer round 1, finding 4: an
  -- operator who NAMES themselves 'mode:…' must not be misclassified).
  requested_by    TEXT NOT NULL,
  -- 'human' = an operator's credentialed ask, always dispatchable.
  -- 'mode' = a reviewAuto mode queued it; dispatch re-proves the EXACT
  -- digest below is still the active mode — a renewal is a new signature
  -- and does not inherit its predecessor's queued asks.
  basis           TEXT NOT NULL DEFAULT 'human' CHECK (basis IN ('human','mode')),
  mode_digest     TEXT,
  -- v47: the approved route digest the request was queued under. Admission
  -- re-proves the task's sealed route still carries it — a re-approved
  -- task with a different route spends the request unrun, in words.
  route_digest    TEXT,
  requested_at    TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_reason TEXT,
  -- v50: the ROOT reviewer run this request was spent on — written by the
  -- very admission that consumed it, so a request and its attempt are one
  -- durable fact. NULL on a request spent without a run (route-changed,
  -- mode-ended, already-reviewed, …) and on any v49 row the migration
  -- could not bind to exactly one root.
  reviewer_run    INTEGER REFERENCES run(id),
  -- v50 (explicit-only retries): how the ask was PRODUCED, apart from
  -- whose authority it carries. 'operator' = a fresh credentialed act
  -- (task review, the Retry review button). 'automatic' = a build
  -- disposition's producer (a reviewAuto mode, a Strict / release scope)
  -- — one-shot per source run: it queues the first attempt only, and a
  -- replayed disposition (crash recovery, a re-dispose) can neither queue
  -- nor admit a retry. Request and admission both refuse on it BEFORE
  -- any rail or run exists; a mode-basis row is automatic whatever this
  -- column says.
  origin          TEXT NOT NULL DEFAULT 'operator' CHECK (origin IN ('operator','automatic'))
);
CREATE TABLE task_steer (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  author        TEXT NOT NULL,
  note          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  attached_run  INTEGER REFERENCES run(id),
  attached_at   TEXT,
  delivered_at  TEXT,
  superseded_at TEXT,
  -- v24 (ruling 11): authorship is a VERIFIED principal or it is history.
  -- The default is the legacy label so any road that forgets to say
  -- otherwise fails closed into "unverified".
  authorship_state  TEXT NOT NULL DEFAULT 'unverified-legacy' CHECK (authorship_state IN ('verified','unverified-legacy')),
  superseded_reason TEXT,
  CHECK ((attached_run IS NULL) = (attached_at IS NULL)),
  CHECK (delivered_at IS NULL OR attached_run IS NOT NULL)
);
CREATE TABLE plan_revision (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref         INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  revision         INTEGER NOT NULL,
  artifact         INTEGER NOT NULL REFERENCES artifact(id),
  parent_hash      TEXT,
  reason           TEXT NOT NULL,
  evidence_link    TEXT,
  author           TEXT NOT NULL,
  origin_run       INTEGER REFERENCES run(id),
  kind             TEXT NOT NULL CHECK (kind IN ('initial', 'operator-edit', 'builder-proposal')),
  authority_kind   TEXT NOT NULL CHECK (authority_kind IN ('plan-only', 'authority-change')),
  authority_digest TEXT NOT NULL,
  changed_fields   TEXT,
  status           TEXT NOT NULL CHECK (status IN ('applied', 'blocked', 'rejected')),
  created_at       TEXT NOT NULL,
  resolved_at      TEXT,
  resolved_by      TEXT,
  UNIQUE (task_ref, revision)
);
CREATE TABLE run_checkpoint (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run           INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  plan_revision INTEGER NOT NULL REFERENCES plan_revision(id),
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE push_subscription (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint                  TEXT NOT NULL,
  p256dh                    TEXT NOT NULL,
  auth                      TEXT NOT NULL,
  approver                  TEXT NOT NULL,
  approver_generation       INTEGER NOT NULL,
  ua_words                  TEXT NOT NULL,
  vapid_fingerprint         TEXT NOT NULL,
  starts_after_notification INTEGER NOT NULL,
  created_at                TEXT NOT NULL,
  last_ok_at                TEXT,
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  retired_at                TEXT,
  retired_reason            TEXT
);
CREATE UNIQUE INDEX push_subscription_live
  ON push_subscription (endpoint) WHERE retired_at IS NULL;
CREATE TABLE push_delivery (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  notification     INTEGER NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
  subscription     INTEGER NOT NULL REFERENCES push_subscription(id) ON DELETE CASCADE,
  state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','claimed','accepted','rejected','undeliverable','retired')),
  claim_owner      TEXT,
  claim_expires_at TEXT,
  claim_generation INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  accepted_at      TEXT,
  UNIQUE (notification, subscription),
  CHECK (state <> 'claimed' OR (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL))
);
CREATE INDEX push_delivery_due
  ON push_delivery (state, next_attempt_at) WHERE state IN ('pending','claimed');
CREATE TABLE mutation (
  idempotency_key TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,
  result          TEXT NOT NULL,
  actor           TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE TABLE attended_authorization (
  id                TEXT PRIMARY KEY,
  task_ref          INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  approver          TEXT NOT NULL,
  runner            TEXT NOT NULL,
  runner_generation INTEGER NOT NULL,
  composite_digest  TEXT NOT NULL,
  terms_json        TEXT NOT NULL,
  max_session_turns INTEGER NOT NULL,
  budget_microusd   INTEGER NOT NULL,
  -- Continuation (A4): the finished parent attempt this authorization
  -- continues, and the follow-up text — BOTH also inside the signed
  -- terms_json; these columns exist so admission can join without parsing.
  parent_run        INTEGER REFERENCES run(id),
  followup          TEXT,
  created_at        TEXT NOT NULL,
  absolute_expiry   TEXT NOT NULL,
  last_beat_at      TEXT,
  attempt_run       INTEGER UNIQUE REFERENCES run(id),
  consumed_at       TEXT,
  closed_at         TEXT,
  end_reason        TEXT
, authority_basis TEXT NOT NULL DEFAULT 'password' CHECK (authority_basis IN ('password','mode')), mode_digest TEXT);
CREATE TABLE session_turn (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run                INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('brief','answer','operator','repair')),
  source_id          INTEGER,
  -- Verified operator name for source_kind 'operator' ONLY; brief and
  -- repair turns are machine-authored and say so with NULL.
  author             TEXT,
  text               TEXT NOT NULL,
  reserved_microusd  INTEGER NOT NULL,
  accounted_microusd INTEGER,
  accounted_at       TEXT,
  recorded_at        TEXT NOT NULL,
  written_at         TEXT,
  accepted_at        TEXT,
  settled_at         TEXT,
  measured_microusd  INTEGER,
  output_tokens      INTEGER,
  state              TEXT NOT NULL DEFAULT 'recorded'
                       CHECK (state IN ('recorded','written','accepted','settled','uncertain','cancelled')),
  UNIQUE (run, seq)
);
CREATE TABLE held_session (
  run                   INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  authorization_id      TEXT NOT NULL REFERENCES attended_authorization(id),
  runner                TEXT NOT NULL,
  lease_id              TEXT NOT NULL,
  up_incarnation        TEXT NOT NULL,
  cookie                TEXT NOT NULL,
  socket_path           TEXT NOT NULL,
  supervisor_pid        INTEGER,
  agent_pgid            INTEGER,
  cumulative_microusd   INTEGER NOT NULL DEFAULT 0,
  cumulative_tokens_out INTEGER NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','fencing')),
  fencer                TEXT,
  fencing_deadline      TEXT,
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  end_reason            TEXT
);
CREATE TABLE run_process (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  pid INTEGER CHECK (pid > 0),
  host TEXT NOT NULL,
  process_group INTEGER NOT NULL CHECK (process_group IN (0,1)),
  observed_at TEXT NOT NULL,
  exited_at TEXT,
  boot_id TEXT,
  containment TEXT,
  container TEXT,
  container_empty_at TEXT,
  container_identity TEXT
);
CREATE INDEX run_process_by_run ON run_process(run, exited_at);
CREATE INDEX task_by_state ON task (state);
CREATE INDEX edge_by_blocker ON task_edge (blocker);
CREATE INDEX claim_by_task ON claim (task_ref, lease_generation DESC);
CREATE INDEX hold_by_task ON hold (task_ref);
CREATE TABLE learning_capture (
 source INTEGER PRIMARY KEY REFERENCES run(id), reviewer INTEGER NOT NULL REFERENCES run(id),
 repo TEXT NOT NULL, identity TEXT NOT NULL, environment TEXT NOT NULL, payload TEXT NOT NULL, catalog TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE learning_policy (
 repo TEXT PRIMARY KEY, identity TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE project_lesson (
 id INTEGER PRIMARY KEY, repo TEXT NOT NULL, identity TEXT NOT NULL, source INTEGER NOT NULL REFERENCES run(id),
 reviewer INTEGER NOT NULL REFERENCES run(id), finding TEXT NOT NULL, payload TEXT NOT NULL, sha TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('proposed','adopted','disabled')), version INTEGER NOT NULL DEFAULT 1,
 adopted_by TEXT, UNIQUE(source, finding)
);
CREATE TABLE learning_event (
 id INTEGER PRIMARY KEY, repo TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL,
 action TEXT NOT NULL, before_state TEXT NOT NULL, after_state TEXT NOT NULL, reason TEXT NOT NULL,
 lesson INTEGER REFERENCES project_lesson(id), run INTEGER REFERENCES run(id), evidence TEXT NOT NULL,
 dedupe TEXT UNIQUE
);
CREATE INDEX learning_event_project ON learning_event(repo,id);
CREATE TABLE learning_snapshot (
 run INTEGER PRIMARY KEY REFERENCES run(id), repo TEXT NOT NULL, identity TEXT NOT NULL,
 payload TEXT NOT NULL, sha TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER learning_event_no_update BEFORE UPDATE ON learning_event BEGIN SELECT RAISE(ABORT,'learning history is append-only'); END;
CREATE TRIGGER learning_event_no_delete BEFORE DELETE ON learning_event BEGIN SELECT RAISE(ABORT,'learning history is append-only'); END;
CREATE TRIGGER learning_snapshot_no_update BEFORE UPDATE ON learning_snapshot BEGIN SELECT RAISE(ABORT,'learning snapshots are immutable'); END;
CREATE TRIGGER learning_snapshot_no_delete BEFORE DELETE ON learning_snapshot BEGIN SELECT RAISE(ABORT,'learning snapshots are immutable'); END;
CREATE TRIGGER project_lesson_content_immutable BEFORE UPDATE OF repo,identity,source,reviewer,finding,payload,sha ON project_lesson BEGIN SELECT RAISE(ABORT,'learning sources are immutable'); END;
CREATE TRIGGER learning_capture_no_update BEFORE UPDATE ON learning_capture BEGIN SELECT RAISE(ABORT,'learning sources are immutable'); END;
CREATE TRIGGER learning_capture_no_delete BEFORE DELETE ON learning_capture BEGIN SELECT RAISE(ABORT,'learning sources are immutable'); END;
CREATE TABLE project_knowledge (
 repo TEXT PRIMARY KEY, identity TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, sha TEXT NOT NULL
);
CREATE TABLE knowledge_change (
 id INTEGER PRIMARY KEY, repo TEXT NOT NULL, identity TEXT NOT NULL, revision INTEGER NOT NULL,
 actor TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, sha TEXT NOT NULL,
 UNIQUE(repo,identity,revision)
);
CREATE TABLE knowledge_snapshot (
 run INTEGER PRIMARY KEY REFERENCES run(id), repo TEXT NOT NULL, identity TEXT NOT NULL,
 payload TEXT NOT NULL, sha TEXT NOT NULL
);
CREATE TRIGGER knowledge_change_no_update BEFORE UPDATE ON knowledge_change BEGIN SELECT RAISE(ABORT,'Knowledge history is immutable'); END;
CREATE TRIGGER knowledge_change_no_delete BEFORE DELETE ON knowledge_change BEGIN SELECT RAISE(ABORT,'Knowledge history is immutable'); END;
CREATE TRIGGER knowledge_snapshot_no_update BEFORE UPDATE ON knowledge_snapshot BEGIN SELECT RAISE(ABORT,'Knowledge context is immutable'); END;
CREATE TRIGGER knowledge_snapshot_no_delete BEFORE DELETE ON knowledge_snapshot BEGIN SELECT RAISE(ABORT,'Knowledge context is immutable'); END;
CREATE TABLE project_decision (
 id INTEGER PRIMARY KEY, repo TEXT NOT NULL, identity TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 claim TEXT NOT NULL, why TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','superseded','retired')),
 supersedes INTEGER REFERENCES project_decision(id),
 decided_by TEXT NOT NULL, decided_at TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('conversation','task','result','manual','backward-pass')),
 source_ref TEXT, recorded_by TEXT NOT NULL, sha TEXT NOT NULL
);
CREATE INDEX project_decision_repo ON project_decision(repo, status, id);
CREATE TABLE decision_change (
 id INTEGER PRIMARY KEY, decision INTEGER NOT NULL REFERENCES project_decision(id), revision INTEGER NOT NULL,
 actor TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, sha TEXT NOT NULL,
 UNIQUE(decision, revision)
);
CREATE TRIGGER decision_change_no_update BEFORE UPDATE ON decision_change BEGIN SELECT RAISE(ABORT,'Decision history is immutable'); END;
CREATE TRIGGER decision_change_no_delete BEFORE DELETE ON decision_change BEGIN SELECT RAISE(ABORT,'Decision history is immutable'); END;
CREATE TRIGGER project_decision_no_delete BEFORE DELETE ON project_decision BEGIN SELECT RAISE(ABORT,'Decisions are retired, never deleted'); END;
CREATE VIRTUAL TABLE memory_search USING fts5(kind UNINDEXED, ref UNINDEXED, repo UNINDEXED, scope UNINDEXED, title, body, tokenize='unicode61');
CREATE TABLE memory_session (
 id TEXT PRIMARY KEY, repo TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('claude','codex','lead','crew')),
 source TEXT NOT NULL, seen_at TEXT NOT NULL, surface TEXT NOT NULL, trace_sha TEXT NOT NULL,
 analyzed_at TEXT, verdict TEXT, problem TEXT
);
CREATE INDEX memory_session_repo ON memory_session(repo, seen_at);
CREATE TABLE memory_gap (
 id INTEGER PRIMARY KEY, repo TEXT NOT NULL, key TEXT NOT NULL, mistake TEXT NOT NULL, proposed TEXT NOT NULL,
 domain TEXT NOT NULL CHECK(domain IN ('project','orchestration')), first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
 retired_at TEXT, retired_reason TEXT, UNIQUE(repo, key)
);
CREATE TABLE memory_sighting (
 gap INTEGER NOT NULL REFERENCES memory_gap(id), session TEXT NOT NULL REFERENCES memory_session(id),
 at TEXT NOT NULL, quote TEXT NOT NULL, PRIMARY KEY(gap, session)
);
CREATE TABLE memory_proposal (
 id INTEGER PRIMARY KEY, repo TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('instruction-add','instruction-remove','decision-add')),
 fingerprint TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL, before_text TEXT, after_text TEXT NOT NULL,
 evidence TEXT NOT NULL, sessions INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','stale')),
 created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, surface TEXT NOT NULL
);
CREATE INDEX memory_proposal_pending ON memory_proposal(repo, status, fingerprint);
CREATE TABLE memory_rejection (
 repo TEXT NOT NULL, fingerprint TEXT NOT NULL, rejected_at TEXT NOT NULL, rejected_by TEXT NOT NULL, sessions INTEGER NOT NULL, PRIMARY KEY(repo, fingerprint)
);
CREATE TABLE model_seen (
  source        TEXT NOT NULL CHECK (source IN ('claude','codex','gemini','openrouter')),
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  input_usd     REAL,
  output_usd    REAL,
  context       INTEGER,
  tools         INTEGER NOT NULL DEFAULT 0,
  released_at   TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (source, id)
);
CREATE TABLE runtime_check (
  tool           TEXT PRIMARY KEY CHECK (tool IN ('claude','codex','gemini')),
  installed      TEXT,
  latest         TEXT,
  update_command TEXT,
  problem        TEXT,
  checked_at     TEXT NOT NULL,
  updated_at     TEXT,
  updated_by     TEXT
);
CREATE TABLE model_watch (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  problem    TEXT,
  changed_by TEXT,
  changed_at TEXT
);
CREATE TABLE skill_package (sha TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE skill_owner (sha TEXT NOT NULL REFERENCES skill_package(sha), actor TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(sha,actor));
CREATE TABLE project_skill_change (repo TEXT NOT NULL, identity TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY(repo,revision));
CREATE TABLE skill_snapshot (run INTEGER PRIMARY KEY REFERENCES run(id), repo TEXT NOT NULL, payload TEXT NOT NULL, sha TEXT NOT NULL);
CREATE TABLE skill_test (task_ref INTEGER PRIMARY KEY REFERENCES task_ref(id), package TEXT NOT NULL REFERENCES skill_package(sha), actor TEXT NOT NULL, request_sha TEXT NOT NULL, sample TEXT NOT NULL, source_run INTEGER REFERENCES run(id), feedback TEXT, identity TEXT NOT NULL);
CREATE TRIGGER skill_package_no_update BEFORE UPDATE ON skill_package BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;
CREATE TRIGGER skill_package_no_delete BEFORE DELETE ON skill_package BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;
CREATE TRIGGER skill_owner_no_update BEFORE UPDATE ON skill_owner BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;
CREATE TRIGGER skill_owner_no_delete BEFORE DELETE ON skill_owner BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;
CREATE TRIGGER project_skill_change_no_update BEFORE UPDATE ON project_skill_change BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;
CREATE TRIGGER project_skill_change_no_delete BEFORE DELETE ON project_skill_change BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;
CREATE TRIGGER skill_snapshot_no_update BEFORE UPDATE ON skill_snapshot BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;
CREATE TRIGGER skill_snapshot_no_delete BEFORE DELETE ON skill_snapshot BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;
CREATE TRIGGER skill_test_no_update BEFORE UPDATE ON skill_test BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;
CREATE TRIGGER skill_test_no_delete BEFORE DELETE ON skill_test BEGIN SELECT RAISE(ABORT,'Skill history is immutable'); END;
CREATE TABLE slack_binding (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL,
 team TEXT NOT NULL, app TEXT NOT NULL, member TEXT NOT NULL, channel TEXT NOT NULL,
 approver TEXT NOT NULL, generation INTEGER NOT NULL, created TEXT NOT NULL, revoked TEXT
);
CREATE UNIQUE INDEX slack_one_binding_member ON slack_binding(installation, member) WHERE revoked IS NULL;
CREATE TABLE slack_pair (
 hash TEXT PRIMARY KEY, installation TEXT NOT NULL, approver TEXT NOT NULL,
 generation INTEGER NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE slack_event (
 id TEXT PRIMARY KEY, installation TEXT NOT NULL, binding INTEGER REFERENCES slack_binding(id),
 kind TEXT NOT NULL CHECK(kind IN ('message','action','pair','notice')),
 channel TEXT NOT NULL, member TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT NOT NULL,
 payload TEXT NOT NULL, created TEXT NOT NULL,
 session INTEGER REFERENCES mate_session(id), state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','dropped')),
 next_at TEXT, problem TEXT
);
CREATE INDEX slack_pending_event ON slack_event(installation,state,next_at);
CREATE TABLE slack_part (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL REFERENCES slack_event(id), ordinal INTEGER NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','dropped')),
 message TEXT, file TEXT, uploaded INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 uncertain INTEGER NOT NULL DEFAULT 0, next_at TEXT, problem TEXT, created TEXT NOT NULL,
 UNIQUE(event,ordinal)
);
CREATE TABLE slack_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES slack_part(id),
 proposal INTEGER NOT NULL REFERENCES mate_proposal(id), phase TEXT NOT NULL CHECK(phase IN ('confirm','dismiss','yes','cancel')),
 expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE slack_progress (
 binding INTEGER NOT NULL REFERENCES slack_binding(id), run INTEGER NOT NULL REFERENCES run(id),
 part INTEGER NOT NULL REFERENCES slack_part(id), digest TEXT NOT NULL,
 PRIMARY KEY(binding,run)
);
CREATE TABLE slack_runtime (
 installation TEXT PRIMARY KEY, owner TEXT, lease_until TEXT, connected TEXT,
 problem TEXT, retry_at TEXT, notification INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE slack_room (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL, chat TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('group','private')), conversation TEXT NOT NULL,
 binding INTEGER NOT NULL REFERENCES slack_binding(id),
 bound_by TEXT NOT NULL, bound TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
 revoked TEXT, revoked_by TEXT
);
CREATE UNIQUE INDEX slack_room_live ON slack_room(installation, chat) WHERE revoked IS NULL;
CREATE UNIQUE INDEX slack_room_group ON slack_room(conversation) WHERE revoked IS NULL AND kind='group';
CREATE TABLE slack_meta (
 installation TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated TEXT NOT NULL,
 PRIMARY KEY(installation, key)
);
CREATE TABLE slack_flow_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES slack_part(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('approve','edit','send-back')), expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX slack_flow_action_visit ON slack_flow_action(card, entry);
CREATE TABLE slack_flow_prompt (
 id INTEGER PRIMARY KEY AUTOINCREMENT, binding INTEGER NOT NULL REFERENCES slack_binding(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('edit','send-back')), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX slack_flow_prompt_open ON slack_flow_prompt(binding, consumed);
CREATE TABLE slack_question_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES slack_part(id),
 question INTEGER NOT NULL REFERENCES teammate_question(id), choice TEXT, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX slack_question_action_question ON slack_question_action(question);
CREATE TABLE slack_question_prompt (
 id INTEGER PRIMARY KEY AUTOINCREMENT, binding INTEGER NOT NULL REFERENCES slack_binding(id),
 question INTEGER NOT NULL REFERENCES teammate_question(id), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX slack_question_prompt_open ON slack_question_prompt(binding, consumed);
CREATE TABLE discord_binding (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL,
 team TEXT NOT NULL, app TEXT NOT NULL, member TEXT NOT NULL, channel TEXT NOT NULL,
 approver TEXT NOT NULL, generation INTEGER NOT NULL, created TEXT NOT NULL, revoked TEXT
);
CREATE UNIQUE INDEX discord_one_binding_member ON discord_binding(installation, member) WHERE revoked IS NULL;
CREATE TABLE discord_pair (
 hash TEXT PRIMARY KEY, installation TEXT NOT NULL, approver TEXT NOT NULL,
 generation INTEGER NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE discord_event (
 id TEXT PRIMARY KEY, installation TEXT NOT NULL, binding INTEGER REFERENCES discord_binding(id),
 kind TEXT NOT NULL CHECK(kind IN ('message','action','pair','notice')),
 channel TEXT NOT NULL, member TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT NOT NULL,
 payload TEXT NOT NULL, created TEXT NOT NULL,
 session INTEGER REFERENCES mate_session(id), state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','dropped')),
 next_at TEXT, problem TEXT
);
CREATE INDEX discord_pending_event ON discord_event(installation,state,next_at);
CREATE TABLE discord_part (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL REFERENCES discord_event(id), ordinal INTEGER NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','dropped')),
 message TEXT, file TEXT, uploaded INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 uncertain INTEGER NOT NULL DEFAULT 0, next_at TEXT, problem TEXT, created TEXT NOT NULL,
 UNIQUE(event,ordinal)
);
CREATE TABLE discord_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES discord_part(id),
 proposal INTEGER NOT NULL REFERENCES mate_proposal(id), phase TEXT NOT NULL CHECK(phase IN ('confirm','dismiss','yes','cancel')),
 expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE discord_progress (
 binding INTEGER NOT NULL REFERENCES discord_binding(id), run INTEGER NOT NULL REFERENCES run(id),
 part INTEGER NOT NULL REFERENCES discord_part(id), digest TEXT NOT NULL,
 PRIMARY KEY(binding,run)
);
CREATE TABLE discord_runtime (
 installation TEXT PRIMARY KEY, owner TEXT, lease_until TEXT, connected TEXT,
 problem TEXT, retry_at TEXT, notification INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE discord_room (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL, chat TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('group','private')), conversation TEXT NOT NULL,
 binding INTEGER NOT NULL REFERENCES discord_binding(id),
 bound_by TEXT NOT NULL, bound TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
 revoked TEXT, revoked_by TEXT
);
CREATE UNIQUE INDEX discord_room_live ON discord_room(installation, chat) WHERE revoked IS NULL;
CREATE UNIQUE INDEX discord_room_group ON discord_room(conversation) WHERE revoked IS NULL AND kind='group';
CREATE TABLE discord_meta (
 installation TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated TEXT NOT NULL,
 PRIMARY KEY(installation, key)
);
CREATE TABLE discord_flow_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES discord_part(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('approve','edit','send-back')), expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX discord_flow_action_visit ON discord_flow_action(card, entry);
CREATE TABLE discord_flow_prompt (
 id INTEGER PRIMARY KEY AUTOINCREMENT, binding INTEGER NOT NULL REFERENCES discord_binding(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('edit','send-back')), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX discord_flow_prompt_open ON discord_flow_prompt(binding, consumed);
CREATE TABLE discord_question_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES discord_part(id),
 question INTEGER NOT NULL REFERENCES teammate_question(id), choice TEXT, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX discord_question_action_question ON discord_question_action(question);
CREATE TABLE discord_question_prompt (
 id INTEGER PRIMARY KEY AUTOINCREMENT, binding INTEGER NOT NULL REFERENCES discord_binding(id),
 question INTEGER NOT NULL REFERENCES teammate_question(id), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX discord_question_prompt_open ON discord_question_prompt(binding, consumed);
CREATE TABLE teams_binding (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL,
 team TEXT NOT NULL, app TEXT NOT NULL, member TEXT NOT NULL, channel TEXT NOT NULL,
 approver TEXT NOT NULL, generation INTEGER NOT NULL, created TEXT NOT NULL, revoked TEXT
);
CREATE UNIQUE INDEX teams_one_binding_member ON teams_binding(installation, member) WHERE revoked IS NULL;
CREATE TABLE teams_pair (
 hash TEXT PRIMARY KEY, installation TEXT NOT NULL, approver TEXT NOT NULL,
 generation INTEGER NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE teams_event (
 id TEXT PRIMARY KEY, installation TEXT NOT NULL, binding INTEGER REFERENCES teams_binding(id),
 kind TEXT NOT NULL CHECK(kind IN ('message','action','pair','notice')),
 channel TEXT NOT NULL, member TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT NOT NULL,
 payload TEXT NOT NULL, created TEXT NOT NULL,
 session INTEGER REFERENCES mate_session(id), state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','dropped')),
 next_at TEXT, problem TEXT
);
CREATE INDEX teams_pending_event ON teams_event(installation,state,next_at);
CREATE TABLE teams_part (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL REFERENCES teams_event(id), ordinal INTEGER NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','dropped')),
 message TEXT, file TEXT, uploaded INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 uncertain INTEGER NOT NULL DEFAULT 0, next_at TEXT, problem TEXT, created TEXT NOT NULL,
 UNIQUE(event,ordinal)
);
CREATE TABLE teams_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES teams_part(id),
 proposal INTEGER NOT NULL REFERENCES mate_proposal(id), phase TEXT NOT NULL CHECK(phase IN ('confirm','dismiss','yes','cancel')),
 expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE teams_progress (
 binding INTEGER NOT NULL REFERENCES teams_binding(id), run INTEGER NOT NULL REFERENCES run(id),
 part INTEGER NOT NULL REFERENCES teams_part(id), digest TEXT NOT NULL,
 PRIMARY KEY(binding,run)
);
CREATE TABLE teams_runtime (
 installation TEXT PRIMARY KEY, owner TEXT, lease_until TEXT, connected TEXT,
 problem TEXT, retry_at TEXT, notification INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE teams_room (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL, chat TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('group','private')), conversation TEXT NOT NULL,
 binding INTEGER NOT NULL REFERENCES teams_binding(id),
 bound_by TEXT NOT NULL, bound TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
 revoked TEXT, revoked_by TEXT
);
CREATE UNIQUE INDEX teams_room_live ON teams_room(installation, chat) WHERE revoked IS NULL;
CREATE UNIQUE INDEX teams_room_group ON teams_room(conversation) WHERE revoked IS NULL AND kind='group';
CREATE TABLE teams_meta (
 installation TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated TEXT NOT NULL,
 PRIMARY KEY(installation, key)
);
CREATE TABLE teams_flow_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES teams_part(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('approve','edit','send-back')), expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX teams_flow_action_visit ON teams_flow_action(card, entry);
CREATE TABLE teams_flow_prompt (
 id INTEGER PRIMARY KEY AUTOINCREMENT, binding INTEGER NOT NULL REFERENCES teams_binding(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('edit','send-back')), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX teams_flow_prompt_open ON teams_flow_prompt(binding, consumed);
CREATE TABLE teams_question_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES teams_part(id),
 question INTEGER NOT NULL REFERENCES teammate_question(id), choice TEXT, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX teams_question_action_question ON teams_question_action(question);
CREATE TABLE teams_question_prompt (
 id INTEGER PRIMARY KEY AUTOINCREMENT, binding INTEGER NOT NULL REFERENCES teams_binding(id),
 question INTEGER NOT NULL REFERENCES teammate_question(id), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX teams_question_prompt_open ON teams_question_prompt(binding, consumed);
CREATE TABLE team_lead (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL CHECK(status IN ('active','paused')), created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE team_lead_project (
 lead TEXT NOT NULL REFERENCES team_lead(id), project TEXT NOT NULL, PRIMARY KEY(lead,project)
);
CREATE TABLE team_lead_member (
 lead TEXT NOT NULL REFERENCES team_lead(id), account TEXT NOT NULL REFERENCES approver(name),
 role TEXT NOT NULL CHECK(role IN ('viewer','contributor','manager')), active INTEGER NOT NULL DEFAULT 1,
 revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(lead,account)
);
CREATE TABLE team_conversation (
 id TEXT PRIMARY KEY, lead TEXT NOT NULL REFERENCES team_lead(id), title TEXT NOT NULL,
 visibility TEXT NOT NULL CHECK(visibility IN ('private','team')), projects_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, thread INTEGER NOT NULL UNIQUE REFERENCES mate_thread(id),
 created_by TEXT NOT NULL REFERENCES approver(name), created_at TEXT NOT NULL, last_claimed_at TEXT
);
CREATE TABLE team_participant (
 conversation TEXT NOT NULL REFERENCES team_conversation(id), account TEXT NOT NULL REFERENCES approver(name),
 role TEXT NOT NULL CHECK(role IN ('viewer','contributor','manager')), active INTEGER NOT NULL DEFAULT 1,
 revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(conversation,account)
);
CREATE TABLE team_message (
 message INTEGER PRIMARY KEY REFERENCES mate_message(id), conversation TEXT NOT NULL REFERENCES team_conversation(id),
 author TEXT NOT NULL REFERENCES approver(name), author_generation INTEGER NOT NULL, lead_member_revision INTEGER NOT NULL, participant_revision INTEGER NOT NULL, request_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','answered','failed','cancelled','uncertain')),
 revision INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 0, runner TEXT, claimed_at TEXT,
 turn_id INTEGER REFERENCES mate_turn(id), stop_requested INTEGER NOT NULL DEFAULT 0, error TEXT,
 UNIQUE(conversation,author,request_id)
);
CREATE INDEX team_message_queue ON team_message(status,message);
CREATE INDEX team_message_conversation ON team_message(conversation,message);
CREATE UNIQUE INDEX team_message_single_writer ON team_message(conversation) WHERE status='running';
CREATE TABLE team_read (
 conversation TEXT NOT NULL REFERENCES team_conversation(id), account TEXT NOT NULL REFERENCES approver(name),
 message INTEGER NOT NULL, PRIMARY KEY(conversation,account)
);
CREATE TABLE team_follow (
 conversation TEXT NOT NULL REFERENCES team_conversation(id), account TEXT NOT NULL REFERENCES approver(name),
 generation INTEGER NOT NULL, lead_member_revision INTEGER NOT NULL, participant_revision INTEGER NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(conversation,account)
);
CREATE TABLE team_mate_session (
 session INTEGER PRIMARY KEY REFERENCES mate_session(id), thread INTEGER NOT NULL REFERENCES mate_thread(id)
);
CREATE INDEX team_mate_session_thread ON team_mate_session(thread,session);
CREATE TABLE team_task_owner (
 task_ref INTEGER PRIMARY KEY REFERENCES task_ref(id), lead TEXT NOT NULL REFERENCES team_lead(id), conversation TEXT REFERENCES team_conversation(id),
 revision INTEGER NOT NULL DEFAULT 1, changed_by TEXT NOT NULL, changed_at TEXT NOT NULL
);
CREATE TABLE team_event (
 id INTEGER PRIMARY KEY AUTOINCREMENT, lead TEXT NOT NULL REFERENCES team_lead(id),
 conversation TEXT REFERENCES team_conversation(id), kind TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX team_event_conversation ON team_event(conversation,id);
CREATE INDEX team_event_lead ON team_event(lead,id);
CREATE INDEX team_lead_member_account ON team_lead_member(account,active,lead);
CREATE INDEX team_participant_account ON team_participant(account,active,conversation);
CREATE TABLE team_request (
 account TEXT NOT NULL, generation INTEGER NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 response_json TEXT NOT NULL, PRIMARY KEY(account,generation,request_id)
);
CREATE TABLE sso_identity (
  issuer       TEXT NOT NULL,
  subject      TEXT NOT NULL,
  account      TEXT NOT NULL REFERENCES approver(name),
  email        TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX sso_identity_account ON sso_identity (account);
CREATE TABLE api_token (
  id           TEXT PRIMARY KEY,
  account      TEXT NOT NULL REFERENCES approver(name),
  name         TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  access       TEXT NOT NULL CHECK (access IN ('read','act')),
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  revoked_by   TEXT
);
CREATE INDEX api_token_account ON api_token (account);
CREATE TABLE web_session (
  id_hash          TEXT PRIMARY KEY,
  account          TEXT NOT NULL,
  csrf             TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('approver','viewer')),
  generation       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  last_seen        INTEGER NOT NULL,
  project          TEXT,
  project_revision INTEGER NOT NULL,
  sso_at           INTEGER,
  agent            TEXT,
  address          TEXT
);
CREATE INDEX web_session_account ON web_session (account);
CREATE TABLE approval_policy (
  repo            TEXT PRIMARY KEY,
  not_requester   INTEGER NOT NULL DEFAULT 0 CHECK (not_requester IN (0,1)),
  protect_project INTEGER NOT NULL DEFAULT 0 CHECK (protect_project IN (0,1)),
  protected_paths TEXT NOT NULL DEFAULT '[]',
  updated_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE TABLE scope_approval_vote (
  task_id  TEXT NOT NULL,
  digest   TEXT NOT NULL,
  approver TEXT NOT NULL,
  at       TEXT NOT NULL,
  PRIMARY KEY (task_id, digest, approver)
);
CREATE TABLE scope_author (
  task_id TEXT NOT NULL,
  digest  TEXT NOT NULL,
  author  TEXT NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (task_id, digest, author)
);
CREATE TABLE ledger_seal (
  id   INTEGER PRIMARY KEY,
  prev TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER ledger_seal_no_update BEFORE UPDATE ON ledger_seal
BEGIN SELECT RAISE(ABORT, 'the ledger chain is append-only'); END;
CREATE TRIGGER ledger_seal_no_delete BEFORE DELETE ON ledger_seal
BEGIN SELECT RAISE(ABORT, 'the ledger chain is append-only'); END;
CREATE TABLE ledger_checkpoint (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  through INTEGER NOT NULL,
  hash    TEXT NOT NULL,
  at      TEXT NOT NULL,
  by      TEXT NOT NULL
);
CREATE TRIGGER ledger_checkpoint_no_update BEFORE UPDATE ON ledger_checkpoint
BEGIN SELECT RAISE(ABORT, 'ledger checkpoints are append-only'); END;
CREATE TRIGGER ledger_checkpoint_no_delete BEFORE DELETE ON ledger_checkpoint
BEGIN SELECT RAISE(ABORT, 'ledger checkpoints are append-only'); END;
CREATE TABLE monitoring_status (
  sink        TEXT PRIMARY KEY,
  target      TEXT,
  through     INTEGER NOT NULL DEFAULT 0,
  sent        INTEGER NOT NULL DEFAULT 0,
  last_ok_at  TEXT,
  last_error  TEXT,
  last_error_at TEXT,
  failures    INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT,
  holder      TEXT,
  held_until  TEXT
);
CREATE TABLE run_spend (
  run         INTEGER PRIMARY KEY,
  microusd    INTEGER,
  source      TEXT NOT NULL CHECK (source IN ('reported', 'estimated', 'unpriced', 'subscription')),
  billing     TEXT NOT NULL CHECK (billing IN ('subscription', 'api-key')),
  -- 1 once the run's own evidence set it (a key it was given, what its CLI said); a later turn can only make it a key.
  billing_fixed INTEGER NOT NULL DEFAULT 0,
  price_model TEXT,
  input_usd   REAL,
  output_usd  REAL,
  priced_at   TEXT NOT NULL
);
CREATE TABLE budget (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('installation', 'project', 'person', 'teammate')),
  scope_key   TEXT NOT NULL,
  limit_microusd INTEGER NOT NULL CHECK (limit_microusd > 0),
  hard_stop   INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  removed_by  TEXT,
  removed_at  TEXT
);
CREATE UNIQUE INDEX budget_live ON budget (scope_kind, scope_key) WHERE removed_at IS NULL;
CREATE TABLE provider_limit (
  provider       TEXT NOT NULL,
  window         TEXT NOT NULL,
  used_percent   REAL NOT NULL,
  window_minutes INTEGER,
  resets_at      TEXT,
  reached        INTEGER NOT NULL DEFAULT 0,
  plan           TEXT,
  observed_at    TEXT NOT NULL,
  PRIMARY KEY (provider, window)
);
CREATE TABLE side_spend (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL CHECK (kind IN ('draft')),
  repo      TEXT,
  provider  TEXT NOT NULL,
  model     TEXT,
  cost_usd  REAL,
  billing   TEXT NOT NULL CHECK (billing IN ('subscription', 'api-key')),
  at        TEXT NOT NULL
);
CREATE INDEX side_spend_at ON side_spend (at);
CREATE TABLE provider_account (
  provider    TEXT PRIMARY KEY,
  billing     TEXT NOT NULL CHECK (billing IN ('subscription', 'api-key')),
  observed_at TEXT NOT NULL
);
CREATE INDEX chat_turn_created ON chat_turn (created_at);
CREATE INDEX mate_turn_created ON mate_turn (created_at);
CREATE INDEX teammate_turn_at ON teammate_turn (at);
CREATE TABLE retention_setting (
  kind       TEXT PRIMARY KEY CHECK (kind IN ('evidence', 'checkouts', 'chat', 'notifications')),
  -- NULL is forever; a row only exists once someone chose.
  days       INTEGER CHECK (days IS NULL OR (days >= 7 AND days <= 3650)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE backup_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enabled     INTEGER NOT NULL DEFAULT 1,
  every_hours INTEGER NOT NULL DEFAULT 24,
  keep        INTEGER NOT NULL DEFAULT 7,
  folder      TEXT
);
CREATE TABLE backup_run (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger        TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  ok             INTEGER,
  file           TEXT,
  bytes          INTEGER,
  schema_version INTEGER,
  removed        INTEGER NOT NULL DEFAULT 0,
  error          TEXT
);
CREATE TABLE backup_lease (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  holder     TEXT,
  held_until TEXT
);
CREATE TABLE org_policy (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  providers_json TEXT,
  models_json    TEXT,
  tools_json     TEXT,
  ceiling        TEXT NOT NULL DEFAULT 'escalated' CHECK (ceiling IN ('safe', 'standard', 'escalated')),
  updated_by     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE run_check (
  run         INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  status      TEXT CHECK (status IS NULL OR status IN ('passed', 'failed', 'not-run')),
  exit_code   INTEGER,
  suites_json TEXT NOT NULL DEFAULT '[]',
  release     INTEGER NOT NULL DEFAULT 0 CHECK (release IN (0, 1)),
  recorded_at TEXT,
  snapshot    TEXT,
  line        TEXT,
  final       INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0, 1)),
  updated_at  TEXT,
  notified_at TEXT
);
CREATE INDEX run_check_release ON run_check (run DESC) WHERE release = 1;
CREATE INDEX mate_thread_scope ON mate_thread (approver, scope_kind, scope_key, closed_at);
CREATE TABLE "decision" (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  urgency        TEXT NOT NULL CHECK (urgency IN ('blocking')),
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','expired','answered')),
  recap          TEXT NOT NULL,
  question       TEXT NOT NULL,
  options        TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  assignee       TEXT,
  -- Attention metadata only. A deadline is never a hold expiry: a blocking
  -- decision that goes overdue becomes 'expired' and MORE visible, not a
  -- task that quietly dispatches itself unanswered.
  deadline       TEXT,
  created_at     TEXT NOT NULL,
  answered_at    TEXT,
  answered_by    TEXT,
  -- Which racing agent asked (v14); lets one-open-question-per-agent be a
  -- real database rule instead of a hope (finding 28). NULL = ordinary.
  contestant     INTEGER REFERENCES contestant(id),
  -- Typed closure (v14): 'excluded' = the operator stopped the asking
  -- agent instead of answering. Never a fake option.
  closed_reason  TEXT CHECK (closed_reason IN ('excluded')),
  answered_via   TEXT CHECK (answered_via IN ('cli','web','telegram','slack','discord','teams')),
  choice         TEXT,
  note           TEXT,
  -- v25 held-session linkage. session_turn = the turn whose settlement
  -- produced this park (causal, held runs only). delivered_turn = the
  -- answer turn that claimed delivery into the live session — the
  -- delivery-CAS target: set once (WHERE delivered_turn IS NULL), reverted
  -- only when that turn terminally never reached acceptance.
  session_turn   INTEGER REFERENCES session_turn(id),
  delivered_turn INTEGER REFERENCES session_turn(id)
);
CREATE TABLE "run_stop" (
  run           INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  requested_by  TEXT NOT NULL,
  requested_via TEXT NOT NULL CHECK (requested_via IN ('cli','web','telegram','slack','discord','teams')),
  requested_at  TEXT NOT NULL,
  settled_at    TEXT,
  settlement    TEXT CHECK (settlement IN ('interrupted','recovered','held','finished')),
  resumed_at    TEXT,
  resumed_by    TEXT,
  resumed_via   TEXT CHECK (resumed_via IN ('cli','web','telegram','slack','discord','teams')),
  CHECK ((settled_at IS NULL) = (settlement IS NULL)),
  CHECK (resumed_at IS NULL OR settled_at IS NOT NULL),
  CHECK ((resumed_at IS NULL) = (resumed_by IS NULL))
);
CREATE INDEX run_stop_by_task ON run_stop (task_ref, requested_at DESC);
CREATE UNIQUE INDEX teammate_question_visit ON teammate_question (card, entry) WHERE tool_call IS NULL AND suggestion IS NULL;
CREATE UNIQUE INDEX teammate_question_suggestion ON teammate_question (suggestion) WHERE suggestion IS NOT NULL;
CREATE UNIQUE INDEX teammate_question_call ON teammate_question (tool_call) WHERE tool_call IS NOT NULL;
CREATE INDEX teammate_question_open ON teammate_question (card, entry, state);
CREATE TABLE action_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, actor TEXT NOT NULL, repo TEXT,
  task_id TEXT, run_id INTEGER,
  action TEXT NOT NULL, outcome TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('work','request','access','sign-in','policy')),
  detail TEXT
);
CREATE INDEX action_ledger_project ON action_ledger(repo, id DESC);
CREATE INDEX action_ledger_actor ON action_ledger(actor, id DESC);
CREATE TRIGGER action_ledger_no_update BEFORE UPDATE ON action_ledger
BEGIN SELECT RAISE(ABORT, 'action history is append-only'); END;
CREATE TRIGGER action_ledger_no_delete BEFORE DELETE ON action_ledger
BEGIN SELECT RAISE(ABORT, 'action history is append-only'); END;
CREATE TABLE workflow_recipe (
  id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  repo TEXT NOT NULL, document TEXT NOT NULL, digest TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(id, revision)
);
CREATE INDEX workflow_recipe_project ON workflow_recipe(repo, id, revision DESC);
CREATE TRIGGER workflow_recipe_no_update BEFORE UPDATE ON workflow_recipe
BEGIN SELECT RAISE(ABORT, 'recipe revisions are immutable'); END;
CREATE TRIGGER workflow_recipe_no_delete BEFORE DELETE ON workflow_recipe
BEGIN SELECT RAISE(ABORT, 'recipe revisions are immutable'); END;
CREATE TABLE workflow_preview (
  token TEXT PRIMARY KEY, actor TEXT NOT NULL, repo TEXT NOT NULL,
  document TEXT NOT NULL, digest TEXT NOT NULL, source TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  task_id TEXT REFERENCES task(id), routine_id INTEGER REFERENCES routine(id),
  saved_id TEXT, saved_revision INTEGER,
  CHECK(task_id IS NULL OR routine_id IS NULL),
  FOREIGN KEY(saved_id, saved_revision) REFERENCES workflow_recipe(id, revision)
);
CREATE INDEX workflow_preview_project ON workflow_preview(repo, created_at DESC);
CREATE INDEX workflow_preview_source ON workflow_preview(repo, source, created_at DESC)
WHERE task_id IS NOT NULL OR routine_id IS NOT NULL;
CREATE TABLE plan_authorization (
  task_id TEXT PRIMARY KEY REFERENCES task(id),
  source_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  mode_digest TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER ledger_run_started AFTER INSERT ON run BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES (NEW.started_at,NEW.runner,(SELECT repo FROM task_ref WHERE id = NEW.task_ref),(SELECT external_id FROM task_ref WHERE id = NEW.task_ref),NEW.id,'run started',NEW.role,'work');
END;
CREATE TRIGGER ledger_run_finished AFTER UPDATE OF outcome ON run
WHEN NEW.outcome IS NOT NULL AND OLD.outcome IS NOT NEW.outcome BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES (COALESCE(NEW.finished_at, NEW.started_at),NEW.runner,(SELECT repo FROM task_ref WHERE id = NEW.task_ref),(SELECT external_id FROM task_ref WHERE id = NEW.task_ref),NEW.id,'run finished',NEW.outcome,'work');
END;
CREATE TRIGGER ledger_decision_opened AFTER INSERT ON decision BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES (NEW.created_at,'system',(SELECT repo FROM task_ref WHERE id = (SELECT task_ref FROM run WHERE id = NEW.run)),(SELECT external_id FROM task_ref WHERE id = (SELECT task_ref FROM run WHERE id = NEW.run)),NEW.run,'decision opened',NEW.state,'work');
END;
CREATE TRIGGER ledger_decision_answered AFTER UPDATE OF answered_at ON decision
WHEN NEW.answered_at IS NOT NULL AND OLD.answered_at IS NULL BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES (NEW.answered_at,COALESCE(NEW.answered_by,'system'),(SELECT repo FROM task_ref WHERE id = (SELECT task_ref FROM run WHERE id = NEW.run)),(SELECT external_id FROM task_ref WHERE id = (SELECT task_ref FROM run WHERE id = NEW.run)),NEW.run,'decision answered',NEW.state,'work');
END;
CREATE TRIGGER ledger_scope_approved AFTER UPDATE OF approved_at, approved_digest ON task_scope
WHEN NEW.approved_at IS NOT NULL AND (OLD.approved_at IS NOT NEW.approved_at OR OLD.approved_digest IS NOT NEW.approved_digest) BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES (NEW.approved_at,COALESCE(NEW.approved_by,'system'),(SELECT repo FROM task_ref WHERE backend = 'built-in' AND external_id = NEW.task_id),NEW.task_id,NULL,'scope approved','approved','work');
END;
CREATE TRIGGER ledger_task_state AFTER UPDATE OF state ON task
WHEN OLD.state IS NOT NEW.state BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES (NEW.updated_at,'system',(SELECT repo FROM task_ref WHERE backend = 'built-in' AND external_id = NEW.id),NEW.id,NULL,'task state changed',NEW.state,'work');
END;
CREATE TRIGGER ledger_task_placed AFTER UPDATE OF repo ON task_ref
WHEN OLD.repo IS NOT NEW.repo BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system',NEW.repo,NEW.external_id,NULL,'task placed','recorded','work');
END;
CREATE TRIGGER ledger_coordinator_minted AFTER INSERT ON coordinator_credential BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source,detail) VALUES (NEW.created_at, NEW.created_by, NULL, NULL, NULL,
    'coordinator minted: ' || NEW.name, 'minted', 'access', 'projects: ' || NEW.repos);
END;
CREATE TRIGGER ledger_task_registered AFTER INSERT ON task_ref BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system',NEW.repo,NEW.external_id,NULL,'task registered','recorded','work');
END;
CREATE TRIGGER ledger_steer AFTER INSERT ON task_steer BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES (NEW.created_at,NEW.author,(SELECT repo FROM task_ref WHERE id = NEW.task_ref),(SELECT external_id FROM task_ref WHERE id = NEW.task_ref),NEW.attached_run,'steering added',NEW.authorship_state,'work');
END;
CREATE INDEX decision_attention ON decision (run, id) WHERE state IN ('open','expired');
CREATE INDEX incident_attention ON incident (run, id) WHERE resolved_at IS NULL;
CREATE INDEX task_ref_repo ON task_ref (repo, id);
CREATE INDEX work_family_parent ON task_ref (backend, revision_of, repo, id);
CREATE INDEX work_result ON run (task_ref, id DESC, role, outcome, head_revision, scope_digest, finished_at) WHERE finished_at IS NOT NULL AND role IN ('builder','scout');
CREATE INDEX work_spawned_run ON run (task_ref, id) WHERE provider_started_at IS NOT NULL;
CREATE INDEX work_unsettled_custody ON run_process (run) WHERE exited_at IS NULL AND container_empty_at IS NULL;
CREATE INDEX work_unfinished ON run (task_ref, id DESC) WHERE outcome IS NULL;
CREATE INDEX work_live_claim ON claim (task_ref, lease_generation DESC, expires_at) WHERE released_at IS NULL;
CREATE INDEX work_runner_claim ON claim (runner, expires_at) WHERE released_at IS NULL;
CREATE INDEX work_completion ON action_ledger (task_id, action, source, run_id, id DESC);
CREATE INDEX work_task_ledger ON action_ledger (task_id, id DESC);
CREATE INDEX work_artifact_run ON artifact (run, created_at);
CREATE INDEX work_open_decision ON decision (run, id DESC) WHERE state <> 'answered' AND answered_at IS NULL;
CREATE INDEX run_task_outcome ON run (task_ref, outcome, id DESC);
CREATE INDEX task_done_recent ON task (updated_at DESC, id DESC) WHERE state = 'done';
CREATE INDEX run_started ON run (started_at, id);
CREATE INDEX lead_status_task_run ON run (task_ref, id DESC);
CREATE UNIQUE INDEX diff_comment_source ON diff_comment (source_key) WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX one_open_decision_per_contestant
  ON decision (contestant) WHERE contestant IS NOT NULL AND state IN ('open','expired');
CREATE INDEX task_steer_pending
  ON task_steer (task_ref, id) WHERE delivered_at IS NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX one_open_authorization_per_task
  ON attended_authorization (task_ref) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX one_live_merge_blocker
  ON merge_blocker (publication) WHERE lifted_at IS NULL;
CREATE UNIQUE INDEX session_turn_answer_once
  ON session_turn (source_kind, source_id)
  WHERE source_kind = 'answer' AND state NOT IN ('uncertain','cancelled');
CREATE UNIQUE INDEX one_open_decision_per_run
  ON decision (run) WHERE state IN ('open','expired');
CREATE INDEX decision_undelivered
  ON decision (run, id) WHERE state = 'answered' AND delivered_turn IS NULL;
CREATE UNIQUE INDEX one_open_review_request
  ON review_request (run) WHERE consumed_at IS NULL;
CREATE UNIQUE INDEX root_review_attempt_ordinal
  ON run (parent_run, review_attempt) WHERE role = 'reviewer' AND review_attempt IS NOT NULL;
CREATE UNIQUE INDEX one_live_root_review_per_source
  ON run (parent_run) WHERE role = 'reviewer' AND review_attempt IS NOT NULL AND outcome IS NULL;
CREATE UNIQUE INDEX one_successful_root_review_per_source
  ON run (parent_run) WHERE role = 'reviewer' AND review_attempt IS NOT NULL AND outcome = 'no-change';
CREATE UNIQUE INDEX one_correction_per_reviewer
  ON run (parent_run) WHERE role = 'reviewer' AND review_attempt IS NULL;
CREATE UNIQUE INDEX one_root_review_per_request
  ON review_request (reviewer_run) WHERE reviewer_run IS NOT NULL;
CREATE UNIQUE INDEX fallback_transition_step
  ON fallback_transition (cycle, from_index);
CREATE UNIQUE INDEX one_live_fallback_cycle_per_task
  ON fallback_cycle (task_ref) WHERE state NOT IN ('closed','incident');
CREATE UNIQUE INDEX one_blocked_revision_per_task
  ON plan_revision (task_ref) WHERE status = 'blocked';
CREATE INDEX run_checkpoint_by_run ON run_checkpoint (run, id);
CREATE INDEX run_checkpoint_by_task ON run_checkpoint (task_ref, id);
INSERT INTO queue_state (id, revision) VALUES (1, 0);
INSERT INTO permission_default (id, mode, updated_at, updated_by) VALUES (1, 'auto', NULL, NULL);
INSERT INTO quality_default (id, mode, updated_at, updated_by) VALUES (1, 'default', NULL, NULL);
INSERT INTO telegram_digest (id, every_ms, set_by, set_at, last_sent_at) VALUES (1, NULL, NULL, NULL, NULL);
INSERT INTO wake (id, seq) VALUES (1, 0);
`;
