/**
 * Older databases kept their chats in per-app tables (v1-v114: Telegram's own 21, and 16 for each of Slack, Discord
 * and Teams) until v116 moved them into the shared chat tables. A fixture for an older version adds them back to a
 * file a current build made, exactly as earlier builds created them.
 */
import { LEGACY_CHAT_APPS, LEGACY_TELEGRAM_SCHEMA, legacyAppSchema } from "../src/chat-migration.js";
import { CHAT_TABLES } from "../src/contracts/chat-tables.js";

type Exec = { exec(sql: string): void; prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] } };

/** Add every old chat table (empty), with the columns later steps gave them, so the file reads as a v114 one would. */
export function addLegacyChatTables(db: Exec): void {
  db.exec(LEGACY_TELEGRAM_SCHEMA);
  for (const app of LEGACY_CHAT_APPS) db.exec(legacyAppSchema(app));
  if (!db.prepare("PRAGMA table_info(telegram_action)").all().some(row => row["name"] === "note_digest")) db.exec("ALTER TABLE telegram_action ADD COLUMN note_digest TEXT");
}

const APP_COLUMNS: Record<string, string> = {
  binding: "id, installation, team, app, member, channel, approver, generation, created, revoked",
  pair: "hash, installation, approver, generation, expires, consumed",
  event: "id, installation, binding, kind, channel, member, ts, thread, payload, created, session, state, next_at, problem",
  part: "id, event, ordinal, payload, state, message, file, uploaded, attempts, uncertain, next_at, problem, created",
  action: "token, part, proposal, phase, expires, consumed",
  progress: "binding, run, part, digest",
  runtime: "installation, owner, lease_until, connected, problem, retry_at, notification",
  room: "id, installation, chat, kind, conversation, binding, bound_by, bound, cursor, revoked, revoked_by",
  meta: "installation, key, value, updated",
  flow_action: "token, part, card, entry, action, expires, consumed",
  flow_prompt: "id, binding, card, entry, mode, created, expires, consumed",
  flow_choice: "token, part, card, entry, choice, label, expires, consumed",
  flow_note: "token, part, card, entry, held, words, answer, expires, consumed",
  question_action: "token, part, question, choice, expires, consumed",
  question_prompt: "id, binding, question, created, expires, consumed",
  ask_action: "token, part, turn, choice, expires, consumed",
};

/**
 * Wind a file's chats back to how a v114 build kept them: every shared chat row into its old per-app table (the
 * reverse of the v116 move), and the shared tables emptied. A fixture seeded through today's store becomes the file
 * an older build would have written, so the upgrade can be checked against it.
 */
export function windChatsBack(db: Exec): void {
  addLegacyChatTables(db);
  db.exec("PRAGMA foreign_keys = OFF");
  const TG = "provider = 'telegram'";
  db.exec(`
INSERT INTO telegram_binding (id, bot_id, chat_id, user_id, approver, approver_generation, paired_at, paired_by, pair_update_id, revoked_at, revoked_by)
  SELECT id, installation, channel, member, approver, generation, created, COALESCE(created_by, approver), CAST(pair_event AS INTEGER), revoked, revoked_by FROM chat_binding WHERE ${TG};
INSERT INTO telegram_pairing (code_hash, approver, approver_generation, created_at, created_by, expires_at, consumed_at, consumed_chat, consumed_user, consumed_update)
  SELECT hash, approver, generation, COALESCE(created, expires), COALESCE(created_by, approver), expires, consumed, consumed_channel, consumed_member, CAST(consumed_event AS INTEGER) FROM chat_pair WHERE ${TG};
INSERT INTO telegram_team_chat (id, bot_id, chat_id, binding, kind, conversation, bound_by, bound_at, cursor, revoked_at, revoked_by)
  SELECT id, installation, chat, binding, kind, conversation, bound_by, bound, cursor, revoked, revoked_by FROM chat_room WHERE ${TG};
INSERT INTO telegram_update (update_id, applied_at, result)
  SELECT CAST(id AS INTEGER), created, COALESCE(result, 'seen') FROM chat_event WHERE ${TG} AND kind = 'update' AND state = 'done';
INSERT INTO telegram_inbox (update_id, bot_id, payload, received_at)
  SELECT CAST(id AS INTEGER), installation, payload, created FROM chat_event WHERE ${TG} AND kind = 'update' AND state = 'queued';
INSERT INTO telegram_conversation (id, binding, bot_id, chat_id, user_id, approver, approver_generation, update_id, message_id, reply_to, request, text,
    context, task_id, source_run, state, claim_owner, claim_expires_at, attempts, next_attempt_at, session, turn, outcome, reply_message_id, created_at, started_at, finished_at)
  SELECT CAST(substr(e.id, 2) AS INTEGER), e.binding, e.installation, e.channel, e.member, b.approver, b.generation, CAST(substr(e.id, 2) AS INTEGER), e.ts, NULLIF(e.thread, ''),
    COALESCE(json_extract(e.payload, '$.request'), ''), COALESCE(json_extract(e.payload, '$.text'), ''), json_extract(e.payload, '$.context'),
    json_extract(e.payload, '$.about.task'), json_extract(e.payload, '$.about.run'), CASE e.state WHEN 'dropped' THEN 'failed' ELSE e.state END,
    e.claim_owner, e.claim_until, e.attempts, e.next_at, e.session, e.turn, e.result, e.reply, e.created, e.started, e.finished
  FROM chat_event e JOIN chat_binding b ON b.provider = e.provider AND b.id = e.binding WHERE e.${TG} AND e.kind = 'message';
INSERT INTO telegram_conversation_part (conversation, ordinal, kind, text, reply_to, proposal, keyboard_json, state, message_id, attempts, uncertain,
    next_attempt_at, last_error, created_at, sent_at, task_id, source_run, artifact, sha256)
  SELECT CAST(substr(event, 2) AS INTEGER), ordinal,
    CASE WHEN json_extract(payload, '$.image') IS NOT NULL THEN 'image' WHEN json_extract(payload, '$.card') IS NOT NULL OR json_extract(payload, '$.proposal') IS NOT NULL THEN 'card' ELSE 'reply' END,
    json_extract(payload, '$.text'), json_extract(payload, '$.replyTo'), json_extract(payload, '$.proposal'), json_extract(payload, '$.keyboard'), state, message, attempts, uncertain,
    next_at, problem, created, sent, json_extract(payload, '$.image.taskId'), json_extract(payload, '$.image.run'), json_extract(payload, '$.image.artifact'), json_extract(payload, '$.image.sha256')
  FROM chat_part WHERE ${TG};
INSERT INTO telegram_proposal_action (token, binding, proposal, phase, chat_id, message_id, created_at, expires_at, consumed_at)
  SELECT token, binding, proposal, phase, chat, message, created, expires, consumed FROM chat_action WHERE ${TG} AND proposal IS NOT NULL;
INSERT INTO telegram_action (token, binding, decision, option_id, phase, chat_id, message_id, created_at, expires_at, consumed_at, note_digest)
  SELECT token, binding, decision, option_id, phase, chat, message, created, expires, consumed, note_digest FROM chat_action WHERE ${TG} AND decision IS NOT NULL;
INSERT INTO telegram_flow_action (token, binding, card, entry, action, chat_id, message_id, created_at, expires_at, consumed_at)
  SELECT token, binding, card, entry, action, chat, message, created, expires, consumed FROM chat_flow_action WHERE ${TG} AND action IN ('approve','edit','send-back');
INSERT INTO telegram_flow_confirm (token, binding, chat_id, message_id, card, entry, phase, created_at, expires_at, consumed_at)
  SELECT token, binding, chat, message, card, entry, action, created, expires, consumed FROM chat_flow_action WHERE ${TG} AND action IN ('yes','cancel');
INSERT INTO telegram_flow_choice (token, binding, card, entry, choice, label, chat_id, message_id, created_at, expires_at, consumed_at)
  SELECT token, binding, card, entry, choice, label, chat, message, created, expires, consumed FROM chat_flow_choice WHERE ${TG};
INSERT INTO telegram_flow_prompt (chat_id, message_id, binding, card, entry, mode, created_at, expires_at, consumed_at)
  SELECT chat, message, binding, card, entry, mode, created, expires, consumed FROM chat_flow_prompt WHERE ${TG};
INSERT INTO telegram_question_action (token, binding, question, choice, chat_id, message_id, created_at, expires_at, consumed_at)
  SELECT token, binding, question, choice, chat, message, created, expires, consumed FROM chat_question_action WHERE ${TG};
INSERT INTO telegram_question_prompt (chat_id, message_id, binding, question, created_at, expires_at, consumed_at)
  SELECT chat, message, binding, question, created, expires, consumed FROM chat_question_prompt WHERE ${TG};
INSERT INTO telegram_decision_message (binding, chat_id, message_id, decision, created_at)
  SELECT binding, chat, message, decision, created FROM chat_message_ref WHERE ${TG} AND kind = 'decision';
INSERT INTO telegram_task_message (binding, chat_id, message_id, task_id, source_run, created_at)
  SELECT binding, chat, message, task_id, run, created FROM chat_message_ref WHERE ${TG} AND kind = 'task';
INSERT INTO telegram_outbound_message (binding, bot_id, chat_id, message_id, notification, destination, project, task_ref, task_id, source_run, created_at)
  SELECT m.binding, b.installation, m.chat, m.message, m.notification, m.destination, m.project, m.task_ref, m.task_id, m.run, m.created
  FROM chat_message_ref m JOIN chat_binding b ON b.provider = m.provider AND b.id = m.binding WHERE m.${TG} AND m.kind = 'notification';
INSERT INTO telegram_note_draft (id, binding, decision, update_id, message_id, reply_to, note, state, created_at, expires_at)
  SELECT id, binding, decision, event, message, reply_to, note, state, created, expires FROM chat_note_draft WHERE ${TG};
INSERT INTO bridge_lease (bot_id, owner, generation, cursor, expires_at, heartbeat_at, push_url, push_at, push_problem)
  SELECT installation, owner, generation, cursor, lease_until, COALESCE(heartbeat, lease_until), push_url, push_at, push_problem FROM chat_runtime WHERE ${TG} AND owner IS NOT NULL AND lease_until IS NOT NULL;
INSERT INTO telegram_retry (bot_id, next_attempt_at) SELECT installation, retry_at FROM chat_runtime WHERE ${TG} AND retry_at IS NOT NULL;
UPDATE telegram_digest SET every_ms = (SELECT every_ms FROM chat_digest WHERE ${TG}), set_by = (SELECT set_by FROM chat_digest WHERE ${TG}),
  set_at = (SELECT set_at FROM chat_digest WHERE ${TG}), last_sent_at = (SELECT last_sent_at FROM chat_digest WHERE ${TG}) WHERE id = 1 AND EXISTS (SELECT 1 FROM chat_digest WHERE ${TG});
`);
  for (const app of LEGACY_CHAT_APPS)
    for (const [suffix, columns] of Object.entries(APP_COLUMNS))
      db.exec(`INSERT INTO ${app}_${suffix} (${columns}) SELECT ${columns} FROM chat_${suffix} WHERE provider = '${app}'`);
  for (const table of ["chat_note_draft", "chat_message_ref", "chat_ask_action", "chat_question_prompt", "chat_question_action", "chat_flow_note", "chat_flow_choice",
    "chat_flow_prompt", "chat_flow_action", "chat_meta", "chat_room", "chat_runtime", "chat_progress", "chat_action", "chat_part", "chat_event", "chat_pair", "chat_binding", "chat_digest"])
    db.exec(`DELETE FROM ${table}`);
  db.exec("PRAGMA foreign_keys = ON");
}

/** The owner's v114 database as it was copied for review (Oct 8): Telegram with 4,220 sent-message records, 8
 * conversations with 8 reply parts, 1 pairing and no pairing codes; Slack, Discord and Teams empty. */
export const OWNER_V114 = { outbound: 4_220, conversations: 8, parts: 8, bindings: 1, pairing: 0 } as const;

type Raw = Exec & { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown } };

/**
 * Wind a file a current build made (with approver `alex`) back to that shape: the 70 old chat tables and none of the
 * shared ones (v114 had none), Telegram holding the owner's counts, and schema v114. Synthetic rows, fixed stamps.
 */
export function ownerShapedV114(db: Raw, bot = "8123456789", chat = "5550001"): void {
  windChatsBack(db);
  db.exec("PRAGMA foreign_keys = OFF");
  for (const table of [...CHAT_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
  const at = (minutes: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', '2026-09-01', '+' || (${minutes}) || ' minutes')`;
  db.prepare(`INSERT INTO telegram_binding (id, bot_id, chat_id, user_id, approver, approver_generation, paired_at, paired_by, pair_update_id)
    VALUES (1, ?, ?, ?, 'alex', 1, '2026-09-01T08:00:00.000Z', 'alex', 700000)`).run(bot, chat, chat);
  db.prepare(`INSERT INTO bridge_lease (bot_id, owner, generation, cursor, expires_at, heartbeat_at) VALUES (?, 'bridge-1', 3, 700412, '2026-10-08T18:00:00.000Z', '2026-10-08T17:59:30.000Z')`).run(bot);
  // Every fact the bridge sent: its notification, its receipt and the message that carried it.
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${OWNER_V114.outbound})
    INSERT INTO notification (id, dedupe_key, kind, subject, body, created_at, push_class, provenance_scope)
    SELECT 900000 + i, 'owner-fact:' || i, CASE WHEN i % 5 = 0 THEN 'attempts-exhausted' ELSE 'run-finished' END, 'Task ' || i || ' finished', 'The result is ready.',
      ${at("i")}, CASE WHEN i % 5 = 0 THEN 'attention' END, 'installation' FROM n`);
  db.prepare(`INSERT INTO notification_delivery (notification, destination, attempts, last_attempt_at, delivered_at, receipt)
    SELECT id, ?, 1, created_at, created_at, 'telegram:message:' || (id - 899000) FROM notification WHERE id > 900000`).run(`telegram:${bot}:${chat}:1:1`);
  db.prepare(`INSERT INTO telegram_outbound_message (binding, bot_id, chat_id, message_id, notification, destination, created_at)
    SELECT 1, ?, ?, CAST(id - 899000 AS TEXT), id, ?, created_at FROM notification WHERE id > 900000`).run(bot, chat, `telegram:${bot}:${chat}:1:1`);
  // Eight messages to the lead, each answered in one part.
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${OWNER_V114.conversations})
    INSERT INTO telegram_conversation (id, binding, bot_id, chat_id, user_id, approver, approver_generation, update_id, message_id, request, text,
      state, attempts, session, turn, outcome, reply_message_id, created_at, started_at, finished_at)
    SELECT i, 1, ?, ?, ?, 'alex', 1, 700400 + i, CAST(5000 + i AS TEXT), printf('%032x', 700400 + i), 'What needs me today? (' || i || ')',
      'done', 1, i, i, 'answered', CAST(6000 + i AS TEXT), ${at("6000 + i")}, ${at("6000 + i")}, ${at("6000 + i")} FROM n`).run(bot, chat, chat);
  db.exec(`INSERT INTO telegram_conversation_part (conversation, ordinal, kind, text, reply_to, state, message_id, attempts, uncertain, created_at, sent_at)
    SELECT id, 0, 'reply', 'Two results are ready for you.', message_id, 'sent', reply_message_id, 1, 0, finished_at, finished_at FROM telegram_conversation;
    INSERT INTO telegram_update (update_id, applied_at, result) SELECT update_id, created_at, 'conversation' FROM telegram_conversation;
    INSERT INTO telegram_update (update_id, applied_at, result) VALUES (700000, '2026-09-01T08:00:00.000Z', 'paired');
    UPDATE schema_version SET version = 114;
    PRAGMA foreign_keys = ON;`);
}
