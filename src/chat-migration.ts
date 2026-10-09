/**
 * The v116 move onto the one set of chat tables (contracts/chat-tables.ts). Until then Telegram kept 21 tables of its
 * own and Slack, Discord and Teams 16 cloned tables each (`slack_binding`, `discord_part`, ...). An older database
 * still has them: openStore creates the ones its version should have had (exactly as earlier builds did), the older
 * migration steps bring them to their last shape, and `convertChatTables` copies every row into the shared tables in
 * one transaction, checks the counts and foreign keys, and drops the old tables. Nothing else reads them.
 */
import { CHAT_PROVIDERS, CHAT_TABLES } from "./contracts/chat-tables.js";
import { readChatMessageBody, readChatPart } from "./contracts/chat-content.js";
import type { Database } from "./store.js";

export type LegacyChatApp = "slack" | "discord" | "teams";
export const LEGACY_CHAT_APPS: readonly LegacyChatApp[] = ["slack", "discord", "teams"];

/* The per-app template the Slack, Discord and Teams tables were stamped from (v67-v114), kept verbatim. */
const LEGACY_APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_binding (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL,
 team TEXT NOT NULL, app TEXT NOT NULL, member TEXT NOT NULL, channel TEXT NOT NULL,
 approver TEXT NOT NULL, generation INTEGER NOT NULL, created TEXT NOT NULL, revoked TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_one_binding_member ON chat_binding(installation, member) WHERE revoked IS NULL;
CREATE TABLE IF NOT EXISTS chat_pair (
 hash TEXT PRIMARY KEY, installation TEXT NOT NULL, approver TEXT NOT NULL,
 generation INTEGER NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE IF NOT EXISTS chat_event (
 id TEXT PRIMARY KEY, installation TEXT NOT NULL, binding INTEGER REFERENCES chat_binding(id),
 kind TEXT NOT NULL CHECK(kind IN ('message','action','pair','notice')),
 channel TEXT NOT NULL, member TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT NOT NULL,
 payload TEXT NOT NULL, created TEXT NOT NULL,
 session INTEGER REFERENCES mate_session(id), state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','dropped')),
 next_at TEXT, problem TEXT
);
CREATE INDEX IF NOT EXISTS chat_pending_event ON chat_event(installation,state,next_at);
CREATE TABLE IF NOT EXISTS chat_part (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL REFERENCES chat_event(id), ordinal INTEGER NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','dropped')),
 message TEXT, file TEXT, uploaded INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 uncertain INTEGER NOT NULL DEFAULT 0, next_at TEXT, problem TEXT, created TEXT NOT NULL,
 UNIQUE(event,ordinal)
);
CREATE TABLE IF NOT EXISTS chat_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id),
 proposal INTEGER NOT NULL REFERENCES mate_proposal(id), phase TEXT NOT NULL CHECK(phase IN ('confirm','dismiss','yes','cancel')),
 expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE IF NOT EXISTS chat_progress (
 binding INTEGER NOT NULL REFERENCES chat_binding(id), run INTEGER NOT NULL REFERENCES run(id),
 part INTEGER NOT NULL REFERENCES chat_part(id), digest TEXT NOT NULL,
 PRIMARY KEY(binding,run)
);
CREATE TABLE IF NOT EXISTS chat_runtime (
 installation TEXT PRIMARY KEY, owner TEXT, lease_until TEXT, connected TEXT,
 problem TEXT, retry_at TEXT, notification INTEGER NOT NULL DEFAULT 0
);
`;
/** v73: a chat's place in the shared team conversations — a channel follows one
 * conversation, a DM may select one. Rows are revoked, never deleted. */
const LEGACY_APP_ROOM_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_room (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL, chat TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('group','private')), conversation TEXT NOT NULL,
 binding INTEGER NOT NULL REFERENCES chat_binding(id),
 bound_by TEXT NOT NULL, bound TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
 revoked TEXT, revoked_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_room_live ON chat_room(installation, chat) WHERE revoked IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_room_group ON chat_room(conversation) WHERE revoked IS NULL AND kind='group';
CREATE TABLE IF NOT EXISTS chat_meta (
 installation TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated TEXT NOT NULL,
 PRIMARY KEY(installation, key)
);
`;
/** v88: flow decisions in the chat app, as on Telegram (telegram-flow.ts).
 * A button is one opaque token for one visit (card, entry) of one card, on
 * the part it rides; Edit and Send back open a prompt the person's next
 * message in their DM answers. */
const LEGACY_APP_FLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_flow_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('approve','edit','send-back')), expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_flow_action_visit ON chat_flow_action(card, entry);
CREATE TABLE IF NOT EXISTS chat_flow_prompt (
 id INTEGER PRIMARY KEY AUTOINCREMENT, binding INTEGER NOT NULL REFERENCES chat_binding(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('edit','send-back')), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_flow_prompt_open ON chat_flow_prompt(binding, consumed);
`;
/** A flow's "Person chooses" zone in the chat app (flow-send.ts): one button per option (choice is its index, label its words
 * when sent) for one visit of one card, on the part it rides. A reply in that notice's thread is the note; chat_flow_note
 * is "Use this as your note?" Yes / No about one other message (held: its event; words: what it said, kept only until
 * answered, as an event's own payload is cleared once it is handled), asked once per visit.
 * Never in CHAT_TABLES: an older database has no such table until this schema creates it. */
const LEGACY_APP_FLOW_CHOICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_flow_choice (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 choice INTEGER NOT NULL, label TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_flow_choice_visit ON chat_flow_choice(card, entry);
CREATE TABLE IF NOT EXISTS chat_flow_note (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id),
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 held TEXT NOT NULL, words TEXT, answer TEXT NOT NULL CHECK(answer IN ('yes','no')), expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_flow_note_visit ON chat_flow_note(card, entry);
`;
/** v93: a teammate's question in the chat app. One button per option (choice)
 * and one to answer in words (choice NULL); that one opens a prompt the
 * person's next message in their DM answers. Never in CHAT_TABLES: an older
 * database has no such tables until this schema creates them. */
const LEGACY_APP_QUESTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_question_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id),
 question INTEGER NOT NULL REFERENCES teammate_question(id), choice TEXT, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_question_action_question ON chat_question_action(question);
CREATE TABLE IF NOT EXISTS chat_question_prompt (
 id INTEGER PRIMARY KEY AUTOINCREMENT, binding INTEGER NOT NULL REFERENCES chat_binding(id),
 question INTEGER NOT NULL REFERENCES teammate_question(id), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_question_prompt_open ON chat_question_prompt(binding, consumed);
`;
/** The lead's question to its owner (ask_owner) in the chat app: one button per option (choice is its index) and one for
 * "Something else" (choice NULL). A tap sends the option as the owner's next message. Never in CHAT_TABLES. */
const LEGACY_APP_ASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_ask_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id) ON DELETE CASCADE,
 turn INTEGER NOT NULL, choice INTEGER, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_ask_action_turn ON chat_ask_action(turn);
`;

/** One app's old tables, as an older database has (or should have had) them. */
export const legacyAppSchema = (app: LegacyChatApp): string =>
  (LEGACY_APP_SCHEMA + LEGACY_APP_ROOM_SCHEMA + LEGACY_APP_FLOW_SCHEMA + LEGACY_APP_FLOW_CHOICE_SCHEMA + LEGACY_APP_QUESTION_SCHEMA + LEGACY_APP_ASK_SCHEMA).replaceAll("chat_", `${app}_`);

const LEGACY_APP_TABLE_SUFFIXES = ["binding", "pair", "event", "part", "action", "progress", "runtime", "room", "meta",
  "flow_action", "flow_prompt", "flow_choice", "flow_note", "question_action", "question_prompt", "ask_action"] as const;
/** One app's 16 old tables, parents first. */
export const legacyAppTables = (app: LegacyChatApp): string[] => LEGACY_APP_TABLE_SUFFIXES.map(suffix => `${app}_${suffix}`);

/** Telegram's own tables (v1-v114) and the bridge's lease, kept verbatim. */
export const LEGACY_TELEGRAM_SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_flow_choice (
  token       TEXT PRIMARY KEY,
  binding     INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  card        INTEGER NOT NULL REFERENCES flow_card(id),
  entry       INTEGER NOT NULL,
  choice      INTEGER NOT NULL,
  label       TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  message_id  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS telegram_flow_choice_visit ON telegram_flow_choice (card, entry);

-- v79: a Telegram message that showed one task (a /task status, a task
-- picked from /tasks): a reply to it is about that task. Like chat_focus,
-- a pointer and never an authority — the turn re-proves the task.
CREATE TABLE IF NOT EXISTS telegram_task_message (
  binding    INTEGER NOT NULL,
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  source_run INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (binding, chat_id, message_id)
);


-- Away mode (v34, mate arc §10): the Telegram bridge's digest cadence.
-- One row. every_ms NULL = off (every fact pages as it lands); set, the
-- bridge holds ROUTINE rows unclaimed until the window elapses and sends
-- them as one message — decisions and attention-class facts still page
-- singly. last_sent_at anchors the window; it never deletes a row.
CREATE TABLE IF NOT EXISTS telegram_digest (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  every_ms     INTEGER,
  set_by       TEXT,
  set_at       TEXT,
  last_sent_at TEXT
);
INSERT OR IGNORE INTO telegram_digest (id, every_ms) VALUES (1, NULL);


-- One Telegram chat speaking as one approver. Bindings are never deleted:
-- revocation is a stamp, because "who could answer as whom, when" is an
-- audit question a DELETE cannot answer. The partial unique index (v72) is
-- the rule that one Telegram user has one live binding per bot: several
-- teammates pair their own private chats with the same bot.
CREATE TABLE IF NOT EXISTS telegram_binding (
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
CREATE UNIQUE INDEX IF NOT EXISTS telegram_binding_live_user
  ON telegram_binding (bot_id, user_id) WHERE revoked_at IS NULL;

-- v72: a Telegram chat's place in the shared team conversations. A group
-- follows exactly one team conversation (and a conversation has at most one
-- group); a private chat may select one conversation to talk in instead of
-- its personal assistant. The cursor is the last conversation message this
-- chat received. Rows are revoked, never deleted.
CREATE TABLE IF NOT EXISTS telegram_team_chat (
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
CREATE UNIQUE INDEX IF NOT EXISTS telegram_team_chat_live
  ON telegram_team_chat (bot_id, chat_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS telegram_team_chat_group
  ON telegram_team_chat (conversation) WHERE revoked_at IS NULL AND kind = 'group';


CREATE TABLE IF NOT EXISTS telegram_outbound_message (
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
CREATE TABLE IF NOT EXISTS telegram_retry (
  bot_id TEXT PRIMARY KEY,
  next_attempt_at TEXT NOT NULL
);

-- One-time pairing codes, hashed like every other credential, consumed in
-- one transaction with the binding they create.
CREATE TABLE IF NOT EXISTS telegram_pairing (
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

-- Every Telegram update this installation has applied, exactly once. The
-- PRIMARY KEY is the idempotency: a replayed batch re-applies nothing.
CREATE TABLE IF NOT EXISTS telegram_update (
  update_id  INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  result     TEXT NOT NULL
);

-- Opaque one-tap actions. callback_data carries only the random token; what
-- the tap MEANS — which binding, decision, option, and phase — lives here,
-- where a stolen bot token cannot read or forge it. Confirm challenges are
-- short-lived rows in the same table, consumed exactly once.
CREATE TABLE IF NOT EXISTS telegram_action (
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
);
CREATE INDEX IF NOT EXISTS telegram_action_by_decision ON telegram_action (decision);

-- v86: a flow card waiting at a "Person decides" zone reaches the decider on
-- Telegram with Approve / Edit / Send back. Each button is one opaque token
-- for one visit of one card (card, entry), placed on the message it rides so
-- a tap on any other message proves itself stale. Edit and Send back ask
-- for a reply to a prompt: telegram_flow_prompt names which prompt means
-- what, so the reply becomes the new draft or the note.
CREATE TABLE IF NOT EXISTS telegram_flow_action (
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
CREATE INDEX IF NOT EXISTS telegram_flow_action_visit ON telegram_flow_action (card, entry);
-- v93: a teammate's question on Telegram. One button per option (choice)
-- and one to reply in words (choice NULL), placed on the message it rides;
-- a reply to the prompt the Reply button sends is the answer.
CREATE TABLE IF NOT EXISTS telegram_question_action (
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
CREATE TABLE IF NOT EXISTS telegram_question_prompt (
  chat_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  binding     INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  question    INTEGER NOT NULL REFERENCES teammate_question(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS telegram_flow_prompt (
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

-- Which outbound Telegram message carries which decision (v10). A free-text
-- reply is routed through the EXACT message it replies to — never "the
-- latest decision", never "the only open one" (Codex free-text review,
-- finding 1). Losing the send/record race fails closed: an unrecorded
-- message routes nothing.
CREATE TABLE IF NOT EXISTS telegram_decision_message (
  binding    INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE CASCADE,
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  decision   INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (binding, chat_id, message_id)
);

-- The free-text draft (v10): an operator's note, held immutable and
-- expiring until a TAP commits it with the choice. One live draft per
-- (binding, decision); a newer valid reply SUPERSEDES, never edits.
CREATE TABLE IF NOT EXISTS telegram_note_draft (
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

CREATE UNIQUE INDEX IF NOT EXISTS telegram_note_draft_live
  ON telegram_note_draft (binding, decision) WHERE state IN ('pending','armed');

-- v62: the durable inbound conversation queue. An ordinary paired message
-- becomes a row in the SAME transaction that marks its update applied, so
-- the poll cursor never moves past text nobody holds. The row carries the
-- exact binding, sender, update, message and the request identity the
-- shared mate engine receipts it under; the async model turn runs OUTSIDE
-- any transaction under a short claim, and a replay or restart finds the
-- receipt instead of dispatching the provider again.
CREATE TABLE IF NOT EXISTS telegram_conversation (
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
CREATE INDEX IF NOT EXISTS telegram_conversation_queue ON telegram_conversation (bot_id, state, id);

-- v62: opaque one-tap tokens for the mate's proposal cards, the same shape
-- as telegram_action for decisions: callback_data carries only the token,
-- and what a tap MEANS (which binding, which proposal, which phase) lives
-- here. Consumed exactly once; an irreversible answer arms a yes/cancel
-- pair first, exactly as a decision button does.
CREATE TABLE IF NOT EXISTS telegram_proposal_action (
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
CREATE INDEX IF NOT EXISTS telegram_proposal_action_by_proposal ON telegram_proposal_action (proposal);

-- v63: the outbound half of a conversation, durable BEFORE any send. Once
-- the engine's turn is answered (or recovered from its receipt), the exact
-- reply text, split into Telegram-sized parts, and one card per pending
-- proposal are written here in one transaction; the bridge then sends
-- them in order under the row's claim, marking a part sent only when
-- Telegram confirmed a message id. A crash, an outage, a rate limit or a
-- restart resumes from the first unsent part — never another model call,
-- proposal, task or revision. A card's buttons are minted with the part,
-- so a resend carries the same tokens. A part whose network answer was
-- lost is counted as uncertain: a resend may duplicate it, and the row
-- says so instead of claiming an exactly-once Telegram cannot provide.
-- v64: an 'image' part is one verified screenshot of one exact result,
-- named by typed columns — task, run, artifact and the hash its record
-- carried when the part was planned — never by JSON inside text or a
-- keyboard, and never by bytes: every send re-reads the artifact from the
-- evidence root and re-verifies it against these columns first. Its text
-- is the short caption. A confirmed image message binds replies to that
-- exact task and run, exactly as an outbox fact's message does.
CREATE TABLE IF NOT EXISTS telegram_conversation_part (
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


-- The bridge's poll lease and cursor, per bot. One live poller at a time;
-- the cursor only ever moves forward, and only under a live generation.
CREATE TABLE IF NOT EXISTS bridge_lease (
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
-- v98: updates Telegram pushed to /hooks/telegram, kept until the bridge
-- applies them (in update order, through the same door as polled ones).
CREATE TABLE IF NOT EXISTS telegram_inbox (
  update_id    INTEGER PRIMARY KEY,
  bot_id       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  received_at  TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS telegram_flow_confirm (
  token       TEXT PRIMARY KEY,
  binding     INTEGER NOT NULL,
  chat_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  card        INTEGER NOT NULL,
  entry       INTEGER NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN ('yes','cancel')),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS telegram_flow_confirm_visit ON telegram_flow_confirm (card, entry);
`;

/** Telegram's 21 old tables and the bridge's lease, children first. */
export const LEGACY_TELEGRAM_TABLES = [
  "telegram_note_draft", "telegram_decision_message", "telegram_task_message", "telegram_outbound_message",
  "telegram_action", "telegram_proposal_action", "telegram_flow_action", "telegram_flow_confirm", "telegram_flow_choice",
  "telegram_flow_prompt", "telegram_question_action", "telegram_question_prompt", "telegram_conversation_part",
  "telegram_conversation", "telegram_team_chat", "telegram_pairing", "telegram_update", "telegram_inbox",
  "telegram_retry", "telegram_digest", "telegram_binding", "bridge_lease",
] as const;

const tableExists = (db: Database, table: string): boolean =>
  db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
const columnsOf = (db: Database, table: string): Set<string> =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row["name"])));

/** Whether this database already keeps its chats in the shared tables (v116 ran, or it was made at v116 or later). */
export function chatTablesShared(db: Database): boolean {
  return CHAT_TABLES.every(table => tableExists(db, table)) && columnsOf(db, "chat_binding").has("provider");
}

/** Whether any of the old per-app tables is still here. */
export function legacyChatTablesPresent(db: Database): boolean {
  return [...LEGACY_TELEGRAM_TABLES, ...LEGACY_CHAT_APPS.flatMap(legacyAppTables)].some(table => tableExists(db, table));
}

/**
 * The columns every shape of each old table has had since it first existed (later steps add the rest). An old table
 * without them is a shape this build cannot name: openStore refuses before it stamps the migration epoch.
 */
const LEGACY_BASE_COLUMNS: Record<string, readonly string[]> = {
  telegram_binding: ["id", "bot_id", "chat_id", "user_id", "approver", "approver_generation", "paired_at", "paired_by", "revoked_at", "revoked_by"],
  telegram_pairing: ["code_hash", "approver", "approver_generation", "created_at", "created_by", "expires_at", "consumed_at"],
  telegram_update: ["update_id", "applied_at", "result"],
  telegram_action: ["token", "binding", "decision", "option_id", "phase", "chat_id", "message_id", "created_at", "expires_at", "consumed_at"],
  telegram_decision_message: ["binding", "chat_id", "message_id", "decision", "created_at"],
  telegram_note_draft: ["id", "binding", "decision", "update_id", "message_id", "reply_to", "note", "state", "created_at", "expires_at"],
  telegram_outbound_message: ["binding", "chat_id", "message_id", "notification", "destination", "project", "task_ref", "task_id", "source_run", "created_at"],
  telegram_retry: ["bot_id", "next_attempt_at"],
  telegram_conversation: ["id", "binding", "bot_id", "chat_id", "user_id", "approver", "approver_generation", "update_id", "message_id", "reply_to", "request", "text", "context", "task_id", "source_run", "state", "claim_owner", "claim_expires_at", "attempts", "next_attempt_at", "session", "turn", "outcome", "reply_message_id", "created_at", "started_at", "finished_at"],
  telegram_proposal_action: ["token", "binding", "proposal", "phase", "chat_id", "message_id", "created_at", "expires_at", "consumed_at"],
  telegram_conversation_part: ["conversation", "ordinal", "kind", "text", "reply_to", "proposal", "keyboard_json", "state", "message_id", "attempts", "uncertain", "next_attempt_at", "last_error", "created_at", "sent_at"],
  bridge_lease: ["bot_id", "owner", "generation", "cursor", "expires_at", "heartbeat_at"],
  telegram_digest: ["id", "every_ms", "set_by", "set_at", "last_sent_at"],
  telegram_team_chat: ["id", "bot_id", "chat_id", "binding", "kind", "conversation", "bound_by", "bound_at", "cursor", "revoked_at", "revoked_by"],
  telegram_task_message: ["binding", "chat_id", "message_id", "task_id", "source_run", "created_at"],
  telegram_flow_action: ["token", "binding", "card", "entry", "action", "chat_id", "message_id", "created_at", "expires_at", "consumed_at"],
  telegram_flow_prompt: ["chat_id", "message_id", "binding", "card", "entry", "mode", "created_at", "expires_at", "consumed_at"],
  telegram_flow_choice: ["token", "binding", "card", "entry", "choice", "label", "chat_id", "message_id", "created_at", "expires_at", "consumed_at"],
  telegram_flow_confirm: ["token", "binding", "chat_id", "message_id", "card", "entry", "phase", "created_at", "expires_at", "consumed_at"],
  telegram_question_action: ["token", "binding", "question", "choice", "chat_id", "message_id", "created_at", "expires_at", "consumed_at"],
  telegram_question_prompt: ["chat_id", "message_id", "binding", "question", "created_at", "expires_at", "consumed_at"],
  telegram_inbox: ["update_id", "bot_id", "payload", "received_at"],
};
const LEGACY_APP_COLUMNS: Record<(typeof LEGACY_APP_TABLE_SUFFIXES)[number], readonly string[]> = {
  binding: ["id", "installation", "team", "app", "member", "channel", "approver", "generation", "created", "revoked"],
  pair: ["hash", "installation", "approver", "generation", "expires", "consumed"],
  event: ["id", "installation", "binding", "kind", "channel", "member", "ts", "thread", "payload", "created", "session", "state", "next_at", "problem"],
  part: ["id", "event", "ordinal", "payload", "state", "message", "file", "uploaded", "attempts", "uncertain", "next_at", "problem", "created"],
  action: ["token", "part", "proposal", "phase", "expires", "consumed"],
  progress: ["binding", "run", "part", "digest"],
  runtime: ["installation", "owner", "lease_until", "connected", "problem", "retry_at", "notification"],
  room: ["id", "installation", "chat", "kind", "conversation", "binding", "bound_by", "bound", "cursor", "revoked", "revoked_by"],
  meta: ["installation", "key", "value", "updated"],
  flow_action: ["token", "part", "card", "entry", "action", "expires", "consumed"],
  flow_prompt: ["id", "binding", "card", "entry", "mode", "created", "expires", "consumed"],
  flow_choice: ["token", "part", "card", "entry", "choice", "label", "expires", "consumed"],
  flow_note: ["token", "part", "card", "entry", "held", "words", "answer", "expires", "consumed"],
  question_action: ["token", "part", "question", "choice", "expires", "consumed"],
  question_prompt: ["id", "binding", "question", "created", "expires", "consumed"],
  ask_action: ["token", "part", "turn", "choice", "expires", "consumed"],
};
/** The columns the copy reads, beyond the base ones: added by migration steps that run before it. */
const LEGACY_LATER_COLUMNS: Record<string, readonly string[]> = {
  telegram_action: ["note_digest"],
  telegram_conversation_part: ["task_id", "source_run", "artifact", "sha256"],
  telegram_binding: ["pair_update_id"],
  telegram_pairing: ["consumed_chat", "consumed_user", "consumed_update"],
  bridge_lease: ["push_url", "push_at", "push_problem"],
};

function expectedColumns(table: string, withLater: boolean): readonly string[] | null {
  const base = LEGACY_BASE_COLUMNS[table];
  if (base !== undefined) return withLater ? [...base, ...(LEGACY_LATER_COLUMNS[table] ?? [])] : base;
  const app = LEGACY_CHAT_APPS.find(one => table.startsWith(`${one}_`));
  if (app === undefined) return null;
  return LEGACY_APP_COLUMNS[table.slice(app.length + 1) as keyof typeof LEGACY_APP_COLUMNS] ?? null;
}

/**
 * What is wrong with the old chat tables this database still has, before anything is changed: one that lacks a column
 * its every shape has had is not a table this build knows how to carry. Null when they are fine (or already gone).
 */
export function legacyChatProblem(db: Database): string | null {
  for (const table of [...LEGACY_TELEGRAM_TABLES, ...LEGACY_CHAT_APPS.flatMap(legacyAppTables)]) {
    if (!tableExists(db, table)) continue;
    const have = columnsOf(db, table);
    const missing = (expectedColumns(table, false) ?? []).filter(column => !have.has(column));
    if (missing.length > 0) return `the ${table} table has an unknown shape (no ${missing.join(", ")})`;
  }
  return null;
}

const P = (app: string) => `'${app}'`;

/** One copy: what it inserts, and the count it must reach (source rows, by the same predicate). */
type Copy = { source: string; target: string; insert: string; expect: string; found: string };

function appCopies(app: LegacyChatApp): Copy[] {
  const t = (suffix: string) => `${app}_${suffix}`;
  const one = (suffix: string, target: string, columns: string, select: string, where = `provider = ${P(app)}`): Copy => ({
    source: t(suffix), target,
    insert: `INSERT INTO ${target} (provider, ${columns}) SELECT ${P(app)}, ${select} FROM ${t(suffix)}`,
    expect: `SELECT COUNT(*) AS n FROM ${t(suffix)}`, found: `SELECT COUNT(*) AS n FROM ${target} WHERE ${where}`,
  });
  return [
    one("binding", "chat_binding", "id, installation, team, app, member, channel, approver, generation, created, revoked", "id, installation, team, app, member, channel, approver, generation, created, revoked"),
    one("pair", "chat_pair", "hash, installation, approver, generation, expires, consumed", "hash, installation, approver, generation, expires, consumed"),
    one("event", "chat_event", "id, installation, binding, kind, channel, member, ts, thread, payload, created, session, state, next_at, problem", "id, installation, binding, kind, channel, member, ts, thread, payload, created, session, state, next_at, problem"),
    one("part", "chat_part", "id, event, ordinal, payload, state, message, file, uploaded, attempts, uncertain, next_at, problem, created", "id, event, ordinal, payload, state, message, file, uploaded, attempts, uncertain, next_at, problem, created"),
    one("action", "chat_action", "token, part, proposal, phase, expires, consumed", "token, part, proposal, phase, expires, consumed", `provider = ${P(app)} AND part IS NOT NULL`),
    one("progress", "chat_progress", "binding, run, part, digest", "binding, run, part, digest"),
    one("runtime", "chat_runtime", "installation, owner, lease_until, connected, problem, retry_at, notification", "installation, owner, lease_until, connected, problem, retry_at, notification"),
    one("room", "chat_room", "id, installation, chat, kind, conversation, binding, bound_by, bound, cursor, revoked, revoked_by", "id, installation, chat, kind, conversation, binding, bound_by, bound, cursor, revoked, revoked_by"),
    one("meta", "chat_meta", "installation, key, value, updated", "installation, key, value, updated"),
    one("flow_action", "chat_flow_action", "token, part, card, entry, action, expires, consumed", "token, part, card, entry, action, expires, consumed"),
    one("flow_prompt", "chat_flow_prompt", "id, binding, card, entry, mode, created, expires, consumed", "id, binding, card, entry, mode, created, expires, consumed"),
    one("flow_choice", "chat_flow_choice", "token, part, card, entry, choice, label, expires, consumed", "token, part, card, entry, choice, label, expires, consumed"),
    one("flow_note", "chat_flow_note", "token, part, card, entry, held, words, answer, expires, consumed", "token, part, card, entry, held, words, answer, expires, consumed"),
    one("question_action", "chat_question_action", "token, part, question, choice, expires, consumed", "token, part, question, choice, expires, consumed"),
    one("question_prompt", "chat_question_prompt", "id, binding, question, created, expires, consumed", "id, binding, question, created, expires, consumed"),
    one("ask_action", "chat_ask_action", "token, part, turn, choice, expires, consumed", "token, part, turn, choice, expires, consumed"),
  ];
}

const TG = P("telegram");
/** A JSON object of the fields that are not null (top level only: a nested object keeps its own nulls). */
const withoutNulls = (base: string, optional: string) => `json_patch(${base}, ${optional})`;

/** Telegram's rows, each table into its shared one. Every copy names the count it must reach. */
function telegramCopies(): Copy[] {
  const copy = (source: string, target: string, insert: string, found: string, expect = `SELECT COUNT(*) AS n FROM ${source}`): Copy =>
    ({ source, target, insert, expect, found: `SELECT COUNT(*) AS n FROM ${target} WHERE provider = ${TG} AND ${found}` });
  const conversationBody = withoutNulls(
    "json_object('version', 1, 'text', c.text, 'request', c.request)",
    "json_object('context', c.context)",
  );
  const partBody = withoutNulls(
    "json_object('version', 1, 'text', p.text)",
    `json_object('replyTo', p.reply_to, 'proposal', p.proposal, 'keyboard', json(p.keyboard_json),
      'card', CASE WHEN p.kind = 'card' THEN json('true') END,
      'image', CASE WHEN p.kind = 'image' THEN json_object('taskId', p.task_id, 'run', p.source_run, 'artifact', p.artifact, 'sha256', p.sha256) END)`,
  );
  return [
    copy("telegram_binding", "chat_binding",
      `INSERT INTO chat_binding (provider, id, installation, team, app, member, channel, approver, generation, created, created_by, pair_event, revoked, revoked_by)
       SELECT ${TG}, id, bot_id, bot_id, bot_id, user_id, chat_id, approver, approver_generation, paired_at, paired_by, CAST(pair_update_id AS TEXT), revoked_at, revoked_by FROM telegram_binding`, "1"),
    copy("telegram_pairing", "chat_pair",
      `INSERT INTO chat_pair (provider, hash, installation, approver, generation, created, created_by, expires, consumed, consumed_channel, consumed_member, consumed_event)
       SELECT ${TG}, code_hash, NULL, approver, approver_generation, created_at, created_by, expires_at, consumed_at, consumed_chat, consumed_user, CAST(consumed_update AS TEXT) FROM telegram_pairing`, "1"),
    copy("telegram_team_chat", "chat_room",
      `INSERT INTO chat_room (provider, id, installation, chat, kind, conversation, binding, bound_by, bound, cursor, revoked, revoked_by)
       SELECT ${TG}, id, bot_id, chat_id, kind, conversation, binding, bound_by, bound_at, cursor, revoked_at, revoked_by FROM telegram_team_chat`, "1"),
    // Every applied update is a receipt; a pushed one still waiting is queued with its body. One row per update id.
    copy("telegram_update", "chat_event",
      `INSERT INTO chat_event (provider, id, installation, kind, channel, member, ts, thread, payload, created, state, result)
       SELECT ${TG}, CAST(update_id AS TEXT), '', 'update', '', '', '', '', '{}', applied_at, 'done', result FROM telegram_update`,
      "kind = 'update' AND state = 'done'"),
    copy("telegram_inbox", "chat_event",
      `INSERT INTO chat_event (provider, id, installation, kind, channel, member, ts, thread, payload, created, state)
       SELECT ${TG}, CAST(update_id AS TEXT), bot_id, 'update', '', '', '', '', payload, received_at, 'queued' FROM telegram_inbox
        WHERE update_id NOT IN (SELECT update_id FROM telegram_update)`,
      "kind = 'update' AND state = 'queued'", "SELECT COUNT(*) AS n FROM telegram_inbox WHERE update_id NOT IN (SELECT update_id FROM telegram_update)"),
    // A message the lead answers: its event is m<update id>, and its words, server context and request ride the body.
    copy("telegram_conversation", "chat_event",
      `INSERT INTO chat_event (provider, id, installation, binding, kind, channel, member, ts, thread, payload, created, session, state,
         next_at, claim_owner, claim_until, attempts, turn, started, finished, result, reply)
       SELECT ${TG}, 'm' || c.update_id, c.bot_id, c.binding, 'message', c.chat_id, c.user_id, c.message_id, COALESCE(c.reply_to, ''),
         CASE WHEN c.task_id IS NULL THEN ${conversationBody} ELSE json_set(${conversationBody}, '$.about', json_object('task', c.task_id, 'run', c.source_run)) END,
         c.created_at, c.session, c.state, c.next_attempt_at, c.claim_owner, c.claim_expires_at, c.attempts, c.turn, c.started_at, c.finished_at,
         c.outcome, c.reply_message_id
         FROM telegram_conversation c`,
      "kind = 'message'"),
    copy("telegram_conversation_part", "chat_part",
      `INSERT INTO chat_part (provider, id, event, ordinal, payload, state, message, attempts, uncertain, next_at, problem, created, sent)
       SELECT ${TG}, ROW_NUMBER() OVER (ORDER BY p.conversation, p.ordinal), 'm' || c.update_id, p.ordinal, ${partBody},
         p.state, p.message_id, p.attempts, p.uncertain, p.next_attempt_at, p.last_error, p.created_at, p.sent_at
         FROM telegram_conversation_part p JOIN telegram_conversation c ON c.id = p.conversation`, "1"),
    copy("telegram_proposal_action", "chat_action",
      `INSERT INTO chat_action (provider, token, binding, chat, message, proposal, phase, created, expires, consumed)
       SELECT ${TG}, token, binding, chat_id, message_id, proposal, phase, created_at, expires_at, consumed_at FROM telegram_proposal_action`,
      "proposal IS NOT NULL"),
    copy("telegram_action", "chat_action",
      `INSERT INTO chat_action (provider, token, binding, chat, message, decision, option_id, note_digest, phase, created, expires, consumed)
       SELECT ${TG}, token, binding, chat_id, message_id, decision, option_id, note_digest, phase, created_at, expires_at, consumed_at FROM telegram_action`,
      "decision IS NOT NULL"),
    copy("telegram_flow_action", "chat_flow_action",
      `INSERT INTO chat_flow_action (provider, token, binding, chat, message, card, entry, action, created, expires, consumed)
       SELECT ${TG}, token, binding, chat_id, message_id, card, entry, action, created_at, expires_at, consumed_at FROM telegram_flow_action`,
      "action IN ('approve','edit','send-back')"),
    copy("telegram_flow_confirm", "chat_flow_action",
      `INSERT INTO chat_flow_action (provider, token, binding, chat, message, card, entry, action, created, expires, consumed)
       SELECT ${TG}, token, binding, chat_id, message_id, card, entry, phase, created_at, expires_at, consumed_at FROM telegram_flow_confirm`,
      "action IN ('yes','cancel')"),
    copy("telegram_flow_choice", "chat_flow_choice",
      `INSERT INTO chat_flow_choice (provider, token, binding, chat, message, card, entry, choice, label, created, expires, consumed)
       SELECT ${TG}, token, binding, chat_id, message_id, card, entry, choice, label, created_at, expires_at, consumed_at FROM telegram_flow_choice`, "1"),
    copy("telegram_flow_prompt", "chat_flow_prompt",
      `INSERT INTO chat_flow_prompt (provider, id, binding, chat, message, card, entry, mode, created, expires, consumed)
       SELECT ${TG}, ROW_NUMBER() OVER (ORDER BY created_at, rowid), binding, chat_id, message_id, card, entry, mode, created_at, expires_at, consumed_at FROM telegram_flow_prompt`, "1"),
    copy("telegram_question_action", "chat_question_action",
      `INSERT INTO chat_question_action (provider, token, binding, chat, message, question, choice, created, expires, consumed)
       SELECT ${TG}, token, binding, chat_id, message_id, question, choice, created_at, expires_at, consumed_at FROM telegram_question_action`, "1"),
    copy("telegram_question_prompt", "chat_question_prompt",
      `INSERT INTO chat_question_prompt (provider, id, binding, chat, message, question, created, expires, consumed)
       SELECT ${TG}, ROW_NUMBER() OVER (ORDER BY created_at, rowid), binding, chat_id, message_id, question, created_at, expires_at, consumed_at FROM telegram_question_prompt`, "1"),
    copy("telegram_decision_message", "chat_message_ref",
      `INSERT INTO chat_message_ref (provider, binding, chat, message, kind, decision, created)
       SELECT ${TG}, binding, chat_id, message_id, 'decision', decision, created_at FROM telegram_decision_message`, "kind = 'decision'"),
    copy("telegram_task_message", "chat_message_ref",
      `INSERT INTO chat_message_ref (provider, binding, chat, message, kind, task_id, run, created)
       SELECT ${TG}, binding, chat_id, message_id, 'task', task_id, source_run, created_at FROM telegram_task_message`, "kind = 'task'"),
    copy("telegram_outbound_message", "chat_message_ref",
      `INSERT INTO chat_message_ref (provider, binding, chat, message, kind, notification, destination, project, task_ref, task_id, run, created)
       SELECT ${TG}, binding, chat_id, message_id, 'notification', notification, destination, project, task_ref, task_id, source_run, created_at FROM telegram_outbound_message`,
      "kind = 'notification'"),
    copy("telegram_note_draft", "chat_note_draft",
      `INSERT INTO chat_note_draft (provider, id, binding, decision, event, message, reply_to, note, state, created, expires)
       SELECT ${TG}, id, binding, decision, update_id, message_id, reply_to, note, state, created_at, expires_at FROM telegram_note_draft`, "1"),
    copy("bridge_lease", "chat_runtime",
      `INSERT INTO chat_runtime (provider, installation, owner, lease_until, generation, cursor, heartbeat, push_url, push_at, push_problem)
       SELECT ${TG}, bot_id, owner, expires_at, generation, cursor, heartbeat_at, push_url, push_at, push_problem FROM bridge_lease`, "lease_until IS NOT NULL"),
    // A bot with a rate-limit wait but no lease yet gets a runtime row of its own.
    copy("telegram_retry", "chat_runtime",
      `INSERT INTO chat_runtime (provider, installation, retry_at)
       SELECT ${TG}, bot_id, next_attempt_at FROM telegram_retry WHERE true
       ON CONFLICT (provider, installation) DO UPDATE SET retry_at = excluded.retry_at`, "retry_at IS NOT NULL"),
    copy("telegram_digest", "chat_digest",
      `INSERT INTO chat_digest (provider, every_ms, set_by, set_at, last_sent_at)
       SELECT ${TG}, every_ms, set_by, set_at, last_sent_at FROM telegram_digest WHERE id = 1`, "1",
      "SELECT COUNT(*) AS n FROM telegram_digest WHERE id = 1"),
  ];
}

/**
 * v116: every old chat table's rows into the shared ones, in one transaction. Each copy is one INSERT ... SELECT (no
 * row passes through this process), then every count is checked against its source, every Telegram message's words
 * against the person its binding names, and every foreign key; only then are the old tables dropped. Anything that
 * doesn't add up rolls the whole move back and the open fails, with the old tables as they were. Run again (a resumed
 * upgrade) it finds no old tables and does nothing.
 */
export function convertChatTables(db: Database): { copied: number } {
  const apps = LEGACY_CHAT_APPS.filter(app => tableExists(db, `${app}_binding`));
  const telegram = tableExists(db, "telegram_binding");
  const legacy = [...LEGACY_TELEGRAM_TABLES, ...LEGACY_CHAT_APPS.flatMap(legacyAppTables)].filter(table => tableExists(db, table));
  if (legacy.length === 0) return { copied: 0 };
  const copies = [...(telegram ? telegramCopies() : []), ...apps.flatMap(appCopies)].filter(copy => tableExists(db, copy.source));
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of legacy) {
        const expected = expectedColumns(table, true);
        if (expected === null) continue;
        const have = columnsOf(db, table);
        const missing = expected.filter(column => !have.has(column));
        if (missing.length > 0) throw new Error(`the ${table} table has an unknown shape (no ${missing.join(", ")}) — refusing to move it`);
      }
      // A table the shared one already has rows for (a copy made by hand?) is not ours to merge into.
      for (const provider of CHAT_PROVIDERS) {
        const present = provider === "telegram" ? telegram : apps.includes(provider);
        if (!present) continue;
        const held = Number(db.prepare("SELECT COUNT(*) AS n FROM chat_binding WHERE provider = ?").get(provider)?.["n"] ?? 0);
        if (held > 0) throw new Error(`the shared chat tables already hold ${provider} pairings — refusing to merge the old ${provider} tables into them`);
      }
      if (telegram) {
        // A message speaks for the person its pairing names, at the generation it was paired under, and every reply
        // part belongs to a message: what doesn't is named, never dropped or guessed.
        const strays = Number(db.prepare(`SELECT COUNT(*) AS n FROM telegram_conversation c JOIN telegram_binding b ON b.id = c.binding
          WHERE c.approver <> b.approver OR c.approver_generation <> b.approver_generation`).get()?.["n"] ?? 0);
        if (strays > 0) throw new Error(`${strays} Telegram messages name a person their pairing does not — refusing to move them`);
        const orphans = Number(db.prepare("SELECT COUNT(*) AS n FROM telegram_conversation_part p WHERE NOT EXISTS (SELECT 1 FROM telegram_conversation c WHERE c.id = p.conversation)").get()?.["n"] ?? 0);
        if (orphans > 0) throw new Error(`${orphans} Telegram reply parts belong to no message — refusing to move them`);
      }
      let copied = 0;
      for (const copy of copies) {
        const before = Number(db.prepare(copy.found).get()?.["n"] ?? 0);
        db.exec(copy.insert);
        const want = Number(db.prepare(copy.expect).get()?.["n"] ?? 0);
        const got = Number(db.prepare(copy.found).get()?.["n"] ?? 0) - (copy.target === "chat_runtime" && copy.source === "telegram_retry" ? 0 : before);
        // telegram_retry merges into the runtime rows the lease made; every other copy adds exactly its source's rows.
        if (copy.source === "telegram_retry" ? got < want : got !== want)
          throw new Error(`moving ${copy.source} into ${copy.target} copied ${got} of ${want} rows — refusing to drop it`);
        copied += want;
      }
      // Every moved Telegram message and reply part reads by the shared contracts (a page at a time).
      if (telegram) {
        const unreadable = (sql: string, read: (raw: string) => { ok: boolean }): number => {
          let after = 0, bad = 0;
          for (;;) {
            const page = db.prepare(sql).all(after);
            for (const row of page) if (!read(String(row["payload"])).ok) bad++;
            if (page.length < 500) return bad;
            after = Number(page[page.length - 1]!["rowid"]);
          }
        };
        const parts = unreadable("SELECT rowid, payload FROM chat_part WHERE provider = 'telegram' AND rowid > ? ORDER BY rowid LIMIT 500", readChatPart);
        const messages = unreadable("SELECT rowid, payload FROM chat_event WHERE provider = 'telegram' AND kind = 'message' AND rowid > ? ORDER BY rowid LIMIT 500", readChatMessageBody);
        if (parts + messages > 0) throw new Error(`${parts} Telegram reply parts and ${messages} Telegram messages would not read in the shared chat tables — refusing to move them`);
      }
      const broken = db.prepare("PRAGMA foreign_key_check").all().filter(row => (CHAT_TABLES as readonly string[]).includes(String(row["table"])));
      if (broken.length > 0) throw new Error(`the shared chat tables would have ${broken.length} broken references (first: ${String(broken[0]!["table"])} → ${String(broken[0]!["parent"])}) — refusing to drop the old tables`);
      for (const table of legacy) db.exec(`DROP TABLE ${table}`);
      db.exec("COMMIT");
      return { copied };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
