/**
 * The Slack, Discord and Teams receipt tables (chat-delivery-state.ts keeps their rows). A leaf: it imports nothing, so
 * the store can create these tables without loading the chat state modules that themselves import the store.
 */

const CHAT_SCHEMA = `
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
const CHAT_ROOM_SCHEMA = `
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
const CHAT_FLOW_SCHEMA = `
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
const CHAT_FLOW_CHOICE_SCHEMA = `
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
const CHAT_QUESTION_SCHEMA = `
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
const CHAT_ASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_ask_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id) ON DELETE CASCADE,
 turn INTEGER NOT NULL, choice INTEGER, expires TEXT NOT NULL, consumed TEXT
);
CREATE INDEX IF NOT EXISTS chat_ask_action_turn ON chat_ask_action(turn);
`;
const CHAT_TABLES = [
  "chat_binding",
  "chat_pair",
  "chat_event",
  "chat_part",
  "chat_action",
  "chat_progress",
  "chat_runtime",
] as const;

export const chatSchema = (channel: "slack" | "discord" | "teams"): string =>
  (CHAT_SCHEMA + CHAT_ROOM_SCHEMA + CHAT_FLOW_SCHEMA + CHAT_FLOW_CHOICE_SCHEMA + CHAT_QUESTION_SCHEMA + CHAT_ASK_SCHEMA).replaceAll("chat_", `${channel}_`);
export const chatTables = (channel: "slack" | "discord" | "teams"): string[] =>
  CHAT_TABLES.map((name) => name.replace("chat_", `${channel}_`));
