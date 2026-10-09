/**
 * The one set of chat tables every chat app shares (v116): Telegram, Slack, Discord and Teams keep their pairings,
 * received events, planned message parts, buttons, rooms and delivery receipts here, each row keyed by `provider`.
 * A row's identity is (provider, id): ids carried over from the per-app tables keep their numbers, and nothing infers
 * the app from an id. A leaf: it imports nothing, so the store creates these tables without loading the chat modules.
 */

export const CHAT_PROVIDERS = ["telegram", "slack", "discord", "teams"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];
export const isChatProvider = (value: unknown): value is ChatProvider => CHAT_PROVIDERS.includes(value as ChatProvider);

const PROVIDER = `provider TEXT NOT NULL CHECK (provider IN (${CHAT_PROVIDERS.map(one => `'${one}'`).join(",")}))`;

export const CHAT_SCHEMA = `
-- One person's chat in one app, speaking as one approver generation. Revoked, never deleted.
-- installation: the bot (Telegram) or workspace app; member: the app's user id; channel: their private chat.
CREATE TABLE IF NOT EXISTS chat_binding (
 ${PROVIDER}, id INTEGER NOT NULL, installation TEXT NOT NULL, team TEXT NOT NULL, app TEXT NOT NULL,
 member TEXT NOT NULL, channel TEXT NOT NULL, approver TEXT NOT NULL, generation INTEGER NOT NULL,
 created TEXT NOT NULL, created_by TEXT, pair_event TEXT, revoked TEXT, revoked_by TEXT,
 PRIMARY KEY (provider, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_binding_live ON chat_binding(provider, installation, member) WHERE revoked IS NULL;
CREATE INDEX IF NOT EXISTS chat_binding_approver ON chat_binding(provider, approver) WHERE revoked IS NULL;
-- One-time pairing codes, by hash. installation NULL: any installation of the app (a Telegram code works on its bot).
CREATE TABLE IF NOT EXISTS chat_pair (
 ${PROVIDER}, hash TEXT NOT NULL, installation TEXT, approver TEXT NOT NULL, generation INTEGER NOT NULL,
 created TEXT, created_by TEXT, expires TEXT NOT NULL, consumed TEXT, consumed_channel TEXT, consumed_member TEXT, consumed_event TEXT,
 PRIMARY KEY (provider, hash)
);
-- Everything an app sent us, once each (the key is the idempotency). kind 'update' is an applied (or pushed and
-- waiting) Telegram update; 'message' is a message the lead answers, queued to running to done or failed.
-- session: the lead session its turn was dispatched under, a pointer to its receipt (never an authority).
CREATE TABLE IF NOT EXISTS chat_event (
 ${PROVIDER}, id TEXT NOT NULL, installation TEXT NOT NULL, binding INTEGER,
 kind TEXT NOT NULL CHECK (kind IN ('message','action','pair','notice','update')),
 channel TEXT NOT NULL, member TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT NOT NULL,
 payload TEXT NOT NULL, created TEXT NOT NULL, session INTEGER,
 state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed','dropped')),
 next_at TEXT, problem TEXT, claim_owner TEXT, claim_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 turn INTEGER, started TEXT, finished TEXT, result TEXT, reply TEXT,
 PRIMARY KEY (provider, id),
 FOREIGN KEY (provider, binding) REFERENCES chat_binding(provider, id)
);
CREATE INDEX IF NOT EXISTS chat_event_pending ON chat_event(provider, installation, state, next_at);
CREATE INDEX IF NOT EXISTS chat_event_binding ON chat_event(provider, binding, state);
-- What we send, planned before any send and marked sent only on the app's own message id.
CREATE TABLE IF NOT EXISTS chat_part (
 ${PROVIDER}, id INTEGER NOT NULL, event TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','dropped')),
 message TEXT, file TEXT, uploaded INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 uncertain INTEGER NOT NULL DEFAULT 0, next_at TEXT, problem TEXT, created TEXT NOT NULL, sent TEXT,
 PRIMARY KEY (provider, id), UNIQUE (provider, event, ordinal),
 FOREIGN KEY (provider, event) REFERENCES chat_event(provider, id)
);
CREATE INDEX IF NOT EXISTS chat_part_pending ON chat_part(provider, state, next_at);
CREATE INDEX IF NOT EXISTS chat_part_message ON chat_part(provider, message);
-- A lead proposal's buttons (proposal), or a builder decision's (decision, option_id), one opaque token each.
-- A button rides its planned part, or (Telegram) the binding, chat and message it was placed on.
CREATE TABLE IF NOT EXISTS chat_action (
 ${PROVIDER}, token TEXT NOT NULL, part INTEGER, binding INTEGER, chat TEXT, message TEXT,
 proposal INTEGER REFERENCES lead_proposal(id) ON DELETE CASCADE,
 decision INTEGER REFERENCES decision(id) ON DELETE CASCADE, option_id TEXT, note_digest TEXT,
 phase TEXT NOT NULL CHECK (phase IN ('confirm','dismiss','yes','cancel','choose')),
 created TEXT, expires TEXT, consumed TEXT,
 PRIMARY KEY (provider, token),
 CHECK ((proposal IS NULL) <> (decision IS NULL)),
 FOREIGN KEY (provider, part) REFERENCES chat_part(provider, id)
);
CREATE INDEX IF NOT EXISTS chat_action_part ON chat_action(provider, part);
CREATE INDEX IF NOT EXISTS chat_action_proposal ON chat_action(proposal);
CREATE INDEX IF NOT EXISTS chat_action_decision ON chat_action(decision);
CREATE TABLE IF NOT EXISTS chat_progress (
 ${PROVIDER}, binding INTEGER NOT NULL, run INTEGER NOT NULL REFERENCES run(id), part INTEGER NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY (provider, binding, run),
 FOREIGN KEY (provider, binding) REFERENCES chat_binding(provider, id),
 FOREIGN KEY (provider, part) REFERENCES chat_part(provider, id)
);
-- One live worker per installation (lease, its generation and the poll cursor), its connection and retry state,
-- the newest notification its notices started from, and where (Telegram) pushes updates.
CREATE TABLE IF NOT EXISTS chat_runtime (
 ${PROVIDER}, installation TEXT NOT NULL, owner TEXT, lease_until TEXT, generation INTEGER NOT NULL DEFAULT 0,
 cursor INTEGER NOT NULL DEFAULT 0, heartbeat TEXT, connected TEXT, problem TEXT, retry_at TEXT,
 notification INTEGER NOT NULL DEFAULT 0, push_url TEXT, push_at TEXT, push_problem TEXT,
 PRIMARY KEY (provider, installation)
);
-- A chat's place in the shared team conversations: a group follows one conversation, a private chat may select one.
CREATE TABLE IF NOT EXISTS chat_room (
 ${PROVIDER}, id INTEGER NOT NULL, installation TEXT NOT NULL, chat TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('group','private')), conversation TEXT NOT NULL REFERENCES team_conversation(id),
 binding INTEGER NOT NULL, bound_by TEXT NOT NULL, bound TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
 revoked TEXT, revoked_by TEXT,
 PRIMARY KEY (provider, id),
 FOREIGN KEY (provider, binding) REFERENCES chat_binding(provider, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_room_live ON chat_room(provider, installation, chat) WHERE revoked IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_room_group ON chat_room(provider, conversation) WHERE revoked IS NULL AND kind = 'group';
-- Small transport facts an app must remember per chat (a Teams service URL). Never credentials.
CREATE TABLE IF NOT EXISTS chat_meta (
 ${PROVIDER}, installation TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated TEXT NOT NULL,
 PRIMARY KEY (provider, installation, key)
);
-- A flow decision's buttons (Approve, Edit, Send back, and the Yes or Cancel Approve arms) for one visit of one card.
CREATE TABLE IF NOT EXISTS chat_flow_action (
 ${PROVIDER}, token TEXT NOT NULL, part INTEGER, binding INTEGER, chat TEXT, message TEXT,
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 action TEXT NOT NULL CHECK (action IN ('approve','edit','send-back','yes','cancel')),
 created TEXT, expires TEXT NOT NULL, consumed TEXT,
 PRIMARY KEY (provider, token),
 FOREIGN KEY (provider, part) REFERENCES chat_part(provider, id)
);
CREATE INDEX IF NOT EXISTS chat_flow_action_visit ON chat_flow_action(card, entry);
CREATE INDEX IF NOT EXISTS chat_flow_action_part ON chat_flow_action(provider, part);
-- Edit and Send back wait for the person's next message (or, on Telegram, a reply to the prompt message).
CREATE TABLE IF NOT EXISTS chat_flow_prompt (
 ${PROVIDER}, id INTEGER NOT NULL, binding INTEGER NOT NULL, chat TEXT, message TEXT,
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK (mode IN ('edit','send-back')), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT,
 PRIMARY KEY (provider, id)
);
CREATE INDEX IF NOT EXISTS chat_flow_prompt_open ON chat_flow_prompt(provider, binding, consumed);
CREATE UNIQUE INDEX IF NOT EXISTS chat_flow_prompt_message ON chat_flow_prompt(provider, chat, message) WHERE message IS NOT NULL;
-- A flow's "Person chooses" buttons: one per option (choice is its index, label its words when sent).
CREATE TABLE IF NOT EXISTS chat_flow_choice (
 ${PROVIDER}, token TEXT NOT NULL, part INTEGER, binding INTEGER, chat TEXT, message TEXT,
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 choice INTEGER NOT NULL, label TEXT NOT NULL, created TEXT, expires TEXT NOT NULL, consumed TEXT,
 PRIMARY KEY (provider, token),
 FOREIGN KEY (provider, part) REFERENCES chat_part(provider, id)
);
CREATE INDEX IF NOT EXISTS chat_flow_choice_visit ON chat_flow_choice(card, entry);
CREATE INDEX IF NOT EXISTS chat_flow_choice_part ON chat_flow_choice(provider, part);
-- "Use this as your note?" Yes / No about the person's message held (its event; words kept only until answered).
CREATE TABLE IF NOT EXISTS chat_flow_note (
 ${PROVIDER}, token TEXT NOT NULL, part INTEGER NOT NULL,
 card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
 held TEXT NOT NULL, words TEXT, answer TEXT NOT NULL CHECK (answer IN ('yes','no')), expires TEXT NOT NULL, consumed TEXT,
 PRIMARY KEY (provider, token),
 FOREIGN KEY (provider, part) REFERENCES chat_part(provider, id)
);
CREATE INDEX IF NOT EXISTS chat_flow_note_visit ON chat_flow_note(card, entry);
-- A subagent's question: one button per option and one to answer in words (choice NULL).
CREATE TABLE IF NOT EXISTS chat_question_action (
 ${PROVIDER}, token TEXT NOT NULL, part INTEGER, binding INTEGER, chat TEXT, message TEXT,
 question INTEGER NOT NULL REFERENCES subagent_question(id), choice TEXT, created TEXT, expires TEXT NOT NULL, consumed TEXT,
 PRIMARY KEY (provider, token),
 FOREIGN KEY (provider, part) REFERENCES chat_part(provider, id)
);
CREATE INDEX IF NOT EXISTS chat_question_action_question ON chat_question_action(question);
CREATE TABLE IF NOT EXISTS chat_question_prompt (
 ${PROVIDER}, id INTEGER NOT NULL, binding INTEGER NOT NULL, chat TEXT, message TEXT,
 question INTEGER NOT NULL REFERENCES subagent_question(id), created TEXT NOT NULL, expires TEXT NOT NULL, consumed TEXT,
 PRIMARY KEY (provider, id)
);
CREATE INDEX IF NOT EXISTS chat_question_prompt_open ON chat_question_prompt(provider, binding, consumed);
CREATE UNIQUE INDEX IF NOT EXISTS chat_question_prompt_message ON chat_question_prompt(provider, chat, message) WHERE message IS NOT NULL;
-- The lead's question to its owner (ask_owner): one button per option and one for "Something else" (choice NULL).
CREATE TABLE IF NOT EXISTS chat_ask_action (
 ${PROVIDER}, token TEXT NOT NULL, part INTEGER NOT NULL, turn INTEGER NOT NULL, choice INTEGER, expires TEXT NOT NULL, consumed TEXT,
 PRIMARY KEY (provider, token),
 FOREIGN KEY (provider, part) REFERENCES chat_part(provider, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chat_ask_action_turn ON chat_ask_action(turn);
-- What one sent message carried, so a reply to it is about exactly that: a notification (kind 'notification', one row
-- per notification it showed), a builder decision ('decision') or the task a status showed ('task').
CREATE TABLE IF NOT EXISTS chat_message_ref (
 ${PROVIDER}, binding INTEGER NOT NULL, chat TEXT NOT NULL, message TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('notification','decision','task')),
 notification INTEGER REFERENCES notification(id), destination TEXT, project TEXT,
 task_ref INTEGER REFERENCES task_ref(id), task_id TEXT, run INTEGER,
 decision INTEGER REFERENCES decision(id) ON DELETE CASCADE, created TEXT NOT NULL,
 CHECK ((kind = 'notification') = (notification IS NOT NULL AND destination IS NOT NULL)),
 CHECK ((kind = 'decision') = (decision IS NOT NULL)),
 CHECK (kind <> 'task' OR task_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_message_ref_notification ON chat_message_ref(provider, binding, chat, message, notification) WHERE kind = 'notification';
CREATE UNIQUE INDEX IF NOT EXISTS chat_message_ref_one ON chat_message_ref(provider, binding, chat, message, kind) WHERE kind <> 'notification';
CREATE INDEX IF NOT EXISTS chat_message_ref_destination ON chat_message_ref(destination, notification);
CREATE INDEX IF NOT EXISTS chat_message_ref_task ON chat_message_ref(destination, task_ref) WHERE kind = 'notification';
-- A note typed as a reply to a builder decision, held until a tap answers with it. Only a later event replaces it.
CREATE TABLE IF NOT EXISTS chat_note_draft (
 ${PROVIDER}, id INTEGER NOT NULL, binding INTEGER NOT NULL,
 decision INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE, event INTEGER NOT NULL,
 message TEXT NOT NULL, reply_to TEXT NOT NULL, note TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','armed','superseded','consumed','discarded')),
 created TEXT NOT NULL, expires TEXT NOT NULL,
 PRIMARY KEY (provider, id),
 FOREIGN KEY (provider, binding) REFERENCES chat_binding(provider, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_note_draft_live ON chat_note_draft(provider, binding, decision) WHERE state IN ('pending','armed');
-- Away mode: routine facts wait and go as one digest every every_ms (null: each fact as it lands).
CREATE TABLE IF NOT EXISTS chat_digest (
 ${PROVIDER}, every_ms INTEGER, set_by TEXT, set_at TEXT, last_sent_at TEXT,
 PRIMARY KEY (provider)
);
`;

/** Every shared chat table, parents before children. */
export const CHAT_TABLES = [
  "chat_binding",
  "chat_pair",
  "chat_event",
  "chat_part",
  "chat_action",
  "chat_progress",
  "chat_runtime",
  "chat_room",
  "chat_meta",
  "chat_flow_action",
  "chat_flow_prompt",
  "chat_flow_choice",
  "chat_flow_note",
  "chat_question_action",
  "chat_question_prompt",
  "chat_ask_action",
  "chat_message_ref",
  "chat_note_draft",
  "chat_digest",
] as const;
export type ChatTable = (typeof CHAT_TABLES)[number];
