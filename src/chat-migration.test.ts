/**
 * v116: every chat app's rows move into the shared chat tables (chat-migration.ts). The fixture is a v113 file with
 * Telegram's own tables and Slack's, Discord's and Teams' cloned ones: pairings live and revoked, codes, rooms, Ready
 * cards with armed buttons, pending and retrying sends, a pushed update waiting, the away-mode digest, and 4,100
 * historical Telegram messages with their replies beside a Slack history. Synthetic data from the repository's own
 * DDL and stores; never a production database.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { register } from "./runner.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { TeamLeads } from "./team-leads.js";
import { assignmentOf } from "./assignment.js";
import { ChatCore } from "./chat-core.js";
import { ChatState, partContent } from "./chat-delivery-state.js";
import { CHAT_PROVIDERS, CHAT_TABLES } from "./contracts/chat-tables.js";
import { LEGACY_CHAT_APPS, LEGACY_TELEGRAM_TABLES, legacyAppTables } from "./chat-migration.js";
import { telegramRequestId } from "./telegram-lead.js";
import { CHAT_HARNESSES, type ChatHarness } from "../test/chat-providers.js";
import { addLegacyChatTables, OWNER_V114, ownerShapedV114, windChatsBack } from "../test/legacy-chat.js";
import { changedHistory, historySnapshot, CHAT_MOVES } from "./toolroll-update.js";

const T0 = new Date("2026-10-08T09:00:00.000Z");
const REPO = "/projects/alpha";
const BOT = "777000";
const HISTORY = 4_100;
/** sha256 of every legacy row in the owner-shaped v114 fixture (test/legacy-chat.ts ownerShapedV114). */
const OWNER_FIXTURE_SHA256 = "e1f2b7f58f70247da91e0638979a5f1649e8b1d260914bb79c9271f185a3ca8d";

let dir: string;
let file: string;
let store: Store;
let now: Date;
let alexToken = "";

/** Columns the old per-app tables never had: a Slack, Discord or Teams row read back from them has the defaults. */
const NEW_FOR_APPS: Record<string, readonly string[]> = {
  chat_binding: ["created_by", "pair_event", "revoked_by"],
  chat_pair: ["created", "created_by", "consumed_channel", "consumed_member", "consumed_event"],
  chat_event: ["claim_owner", "claim_until", "attempts", "turn", "started", "finished", "result", "reply"],
  chat_part: ["sent"],
  chat_action: ["binding", "chat", "message", "decision", "option_id", "note_digest", "created"],
  chat_flow_action: ["binding", "chat", "message", "created"],
  chat_flow_choice: ["binding", "chat", "message", "created"],
  chat_flow_prompt: ["chat", "message"],
  chat_question_action: ["binding", "chat", "message", "created"],
  chat_question_prompt: ["chat", "message"],
  chat_runtime: ["generation", "cursor", "heartbeat", "push_url", "push_at", "push_problem"],
};
/** Every shared chat row, as one comparable list per table (each row's columns the old tables could carry). */
function chatRows(db: { prepare(sql: string): { all(): Record<string, unknown>[] } }, keep: (table: string, row: Record<string, unknown>) => boolean = () => true) {
  return Object.fromEntries(CHAT_TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all()
    .filter(row => keep(table, row))
    .map(row => Object.fromEntries(Object.entries(row).filter(([column]) => row["provider"] === "telegram" || !(NEW_FOR_APPS[table] ?? []).includes(column))))
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)]));
}
const historical = (table: string, row: Record<string, unknown>) =>
  !(table === "chat_event" && /^(m?2\d{5}|hist-\d+)$/.test(String(row["id"]))) && !(table === "chat_part" && (/^(m2\d{5}|hist-\d+)$/.test(String(row["event"]))));

function readyResult(id: string, title: string): number {
  store.createTask({ id, title }, now);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, now);
  propose(store, { taskId: id, goal: title, touches: ["src/guard.ts"], acceptance: [{ id: "c1", statement: "The guard stays readable.", how: null, evidence: ["check"] }], now });
  expect(approve(store, id, "alex", now, store.getScope(id)!.digest, alexToken).ok).toBe(true);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route fixture");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "worker-1", branch: `so/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now });
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "b".repeat(40) });
  store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "The guard reads well." });
  store.finishRun(run, { outcome: "built", committed: true, now });
  store.setTaskState(id, "done", now);
  store.saveProofVerdict(run, "verified", [], now, [{ id: "c1", statement: "The guard stays readable.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }] as never, "verified");
  store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, now);
  storeEvidence(store, dir, run, "check-log", "checks.txt", Buffer.from("1 test passed"), "npm test", now, { captureStatus: "ok" });
  sealVerificationReceipt(store, dir, run, "a".repeat(40), store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, now);
  mkdirSync(join(dir, String(run)), { recursive: true });
  const patch = Buffer.from("diff --git a/src/guard.ts b/src/guard.ts\n+guard\n", "utf8");
  writeFileSync(join(dir, String(run), "terminal-diff.patch"), patch);
  store.saveArtifact({ run, kind: "terminal-diff", key: `${run}/terminal-diff.patch`, bytesOriginal: patch.length, bytesStored: patch.length, truncated: false,
    sha256: createHash("sha256").update(patch).digest("hex"), capture: "git diff base head (exit 0)" }, now);
  return run;
}

/** Every app in use the way a v113 install would have it, written through today's stores, then wound back. */
async function seed(): Promise<{ run: number; harnesses: ChatHarness[] }> {
  const world = { store, clock: () => now, evidenceRoot: dir, projects: () => [REPO], origin: "https://console.example", merge: async () => ({ ok: true as const }) };
  const harnesses = CHAT_PROVIDERS.map(provider => CHAT_HARNESSES[provider](world));
  for (const h of harnesses) {
    h.sendPair(h.mint("alex"), h.member(0));
    h.sendPair(h.mint("sam"), h.member(1));
    await h.pass();
  }
  // A Ready card everywhere, armed (Yes and Cancel live) in each app.
  const run = readyResult("guard-1", "Keep the guard readable");
  for (const h of harnesses) await h.pass();
  for (const h of harnesses) {
    const card = [...h.cards(h.member(0))].reverse().find(one => one.buttons.some(button => button.label === "Accept and finish"))!;
    h.tap(card, /^Accept and finish$/, h.member(0));
    await h.pass();
  }
  // A send that failed, waiting to retry, in every app.
  store.createTask({ id: "payout-1", title: "Guard the payout path" }, now);
  const ref = store.refFor("built-in", "payout-1").id;
  store.placeTask(ref, REPO, {}, now);
  store.setTaskState("payout-1", "failed", now);
  store.enqueueNotification({ dedupeKey: "exhausted:payout-1", kind: "attempts-exhausted", pushClass: "attention", subject: "payout-1 stalled", body: "The last attempt failed.", source: { taskRef: ref } }, now);
  for (const h of harnesses) { h.failSends(1); await h.pass(); }
  // Sam unpairs in every app: revoked, with nothing left to do.
  for (const provider of CHAT_PROVIDERS) {
    const chat = new ChatCore(store, provider);
    for (const binding of chat.bindings(harnesses.find(h => h.provider === provider)!.installation).filter(one => one.approver === "sam")) chat.revokeBinding(binding, now, "sam");
  }
  // A code still waiting, a room a group follows, the away-mode digest, a pushed update, and a reply half sent.
  harnesses[0]!.mint("sam");
  const leads = new TeamLeads(store, () => [REPO]);
  const lead = leads.execute({ name: "alex", generation: 1 }, { operation: "create-lead", args: { name: "Engineering", projects: [REPO] } }, now);
  if (!lead.ok) throw new Error(lead.message);
  const made = leads.execute({ name: "alex", generation: 1 }, { operation: "create-conversation", args: { leadId: (lead.result as { leadId: string }).leadId, title: "Website", visibility: "team", projects: [REPO] } }, now);
  if (!made.ok) throw new Error(made.message);
  const conversation = (made.result as { conversationId: string }).conversationId;
  const alexTelegram = store.liveTelegramBindingFor(BOT, harnesses[0]!.member(0))!;
  expect(store.bindTelegramTeamChat({ botId: BOT, chatId: "-1001", binding: alexTelegram.id, kind: "group", conversation, by: "alex" }, now).ok).toBe(true);
  const slack = new ChatState(store, "slack");
  const alexSlack = slack.bindingFor(harnesses[1]!.installation, harnesses[1]!.member(0))!;
  expect(slack.bindRoom({ installation: harnesses[1]!.installation, chat: "CROOM", kind: "group", conversation, by: "alex", binding: alexSlack.id }, now).ok).toBe(true);
  store.setTelegramDigest(3_600_000, "alex", now);
  expect(store.queueTelegramUpdate(BOT, 99_999, '{"update_id":99999}', now)).toBe(true);
  store.enqueueTelegramConversation({ binding: alexTelegram, updateId: 90_001, messageId: "9001", replyTo: null, request: telegramRequestId(BOT, alexTelegram.id, 90_001), text: "what needs me?", context: "Current task: guard-1.", taskId: "guard-1", sourceRun: run }, now);
  const claimed = store.claimTelegramConversation(BOT, "owner", 60_000, now)!;
  expect(store.planTelegramConversationParts(claimed.id, "owner", { session: 1, turn: 1 }, [{ kind: "reply", text: "first", replyTo: "9001" }, { kind: "reply", text: "second" }], now)).toBe(true);
  expect(store.settleTelegramConversationPart(claimed.id, 0, "owner", { ok: true, messageId: "9100" }, now)).toBe(true);
  expect(store.settleTelegramConversationPart(claimed.id, 1, "owner", { ok: false, error: "Bad Gateway", uncertain: true, retryAt: now.toISOString() }, now)).toBe(true);
  store.enqueueTelegramConversation({ binding: alexTelegram, updateId: 90_002, messageId: "9002", replyTo: "9100", request: telegramRequestId(BOT, alexTelegram.id, 90_002), text: "and then?", context: null, taskId: null, sourceRun: null }, now);
  return { run, harnesses };
}

/** Telegram's own history (4,100 messages with their replies and receipts) and a Slack history, in the old tables. */
function addHistory(db: DatabaseSync, telegramBinding: number, slackBinding: number, slackInstallation: string): void {
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
    INSERT INTO telegram_conversation (id, binding, bot_id, chat_id, user_id, approver, approver_generation, update_id, message_id, reply_to, request, text, context,
      task_id, source_run, state, attempts, session, turn, outcome, reply_message_id, created_at, started_at, finished_at)
    SELECT 200000 + i, ?, ?, '4242', '4242', 'alex', 1, 200000 + i, CAST(300000 + i AS TEXT), CASE WHEN i % 7 = 0 THEN CAST(299999 + i AS TEXT) END,
      printf('%032x', 200000 + i), 'historical message ' || i, CASE WHEN i % 10 = 0 THEN 'Current task: guard-1.' END,
      CASE WHEN i % 10 = 0 THEN 'guard-1' END, NULL, CASE WHEN i % 50 = 0 THEN 'failed' ELSE 'done' END, 1, NULL, NULL,
      CASE WHEN i % 50 = 0 THEN 'failed:provider' ELSE 'answered' END, CASE WHEN i % 50 = 0 THEN NULL ELSE CAST(400000 + i AS TEXT) END,
      strftime('%Y-%m-%dT%H:%M:%fZ', '2026-09-01', '+' || i || ' minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', '2026-09-01', '+' || i || ' minutes'),
      strftime('%Y-%m-%dT%H:%M:%fZ', '2026-09-01', '+' || i || ' minutes', '+20 seconds') FROM n`).run(HISTORY, telegramBinding, BOT);
  db.exec(`INSERT INTO telegram_conversation_part (conversation, ordinal, kind, text, reply_to, state, message_id, attempts, uncertain, next_attempt_at, last_error, created_at, sent_at)
    SELECT id, 0, 'reply', 'historical reply ' || (id - 200000), message_id, 'sent', CAST(400000 + id - 200000 AS TEXT), 1, 0, NULL, NULL, finished_at, finished_at
      FROM telegram_conversation WHERE id >= 200000 AND state = 'done';
    INSERT INTO telegram_conversation_part (conversation, ordinal, kind, text, keyboard_json, state, message_id, attempts, uncertain, next_attempt_at, last_error, created_at, sent_at)
    SELECT id, 1, 'reply', 'a part still owed', '[[{"text":"Continue","callback_data":"0123456789abcdef0123456789abcdef"}]]',
      CASE WHEN (id - 200000) % 100 = 1 THEN 'dropped' ELSE 'pending' END, NULL, 3, 1, '2026-10-01T00:00:00.000Z', 'Bad Gateway', finished_at, NULL
      FROM telegram_conversation WHERE id >= 200000 AND (id - 200000) % 100 IN (1, 2);
    INSERT INTO telegram_update (update_id, applied_at, result) SELECT update_id, created_at, 'seen' FROM telegram_conversation WHERE id >= 200000;`);
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 299)
    INSERT INTO slack_event (id, installation, binding, kind, channel, member, ts, thread, payload, created, session, state, next_at, problem)
    SELECT 'hist-' || i, ?, ?, 'message', 'DUAMEMBER', 'UAMEMBER', '1780000000.' || printf('%06d', i), '', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', '2026-08-01', '+' || i || ' minutes'),
      NULL, 'done', NULL, NULL FROM n`).run(slackInstallation, slackBinding);
  db.exec(`INSERT INTO slack_part (id, event, ordinal, payload, state, message, file, uploaded, attempts, uncertain, next_at, problem, created)
    SELECT 100000 + CAST(substr(id, 6) AS INTEGER), id, 0, '{"version":1,"text":"historical Slack reply"}', 'sent', '1780000001.' || printf('%06d', CAST(substr(id, 6) AS INTEGER)), NULL, 0, 1, 0, NULL, NULL, created
      FROM slack_event WHERE id LIKE 'hist-%'`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-chat-migration-"));
  file = join(dir, "orders.db");
  store = openStore(file);
  now = T0;
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("bootstrap failed");
  alexToken = alex.token;
  expect(addApprover(store, "sam", now, { name: "alex", token: alexToken }).ok).toBe(true);
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", now);
  register(store, { name: "worker-1", host: "test", capacity: 9, repos: [REPO], now, newToken: () => "tok-worker-1" });
});
afterEach(() => { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

describe("v116 moves every chat app onto the shared chat tables", () => {
  test("a v113 file with every app's history upgrades whole: every row, state and stamp, 4,100 Telegram messages with their replies, and no old table left", async () => {
    const { harnesses } = await seed();
    const telegram = store.listTelegramConversations(BOT);
    const parts = telegram.map(one => store.listTelegramConversationParts(one.id));
    const before = chatRows(store.handle);
    const alexTelegram = store.liveTelegramBindingFor(BOT, harnesses[0]!.member(0))!.id;
    const alexSlack = new ChatState(store, "slack").bindingFor(harnesses[1]!.installation, harnesses[1]!.member(0))!.id;
    store.close();

    const old = new DatabaseSync(file);
    windChatsBack(old);
    addHistory(old, alexTelegram, alexSlack, harnesses[1]!.installation);
    old.exec("UPDATE schema_version SET version = 113");
    const counts = Object.fromEntries([...LEGACY_TELEGRAM_TABLES, ...LEGACY_CHAT_APPS.flatMap(legacyAppTables)].map(table => [table, Number(old.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!["n"])]));
    for (const table of CHAT_TABLES) expect(Number(old.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!["n"]), table).toBe(0);
    old.close();
    expect(counts["telegram_conversation"]).toBe(telegram.length + HISTORY);
    expect(counts["slack_event"]).toBeGreaterThan(300);

    const started = Date.now();
    store = openStore(file);
    const took = Date.now() - started;
    expect(took).toBeLessThan(30_000);
    expect(SCHEMA_VERSION).toBe(118);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(118);
    for (const table of [...LEGACY_TELEGRAM_TABLES, ...LEGACY_CHAT_APPS.flatMap(legacyAppTables)])
      expect(store.handle.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), table).toBeUndefined();
    expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    // Every row today's stores wrote comes back exactly (the old app tables never had the newer audit columns).
    expect(chatRows(store.handle, historical)).toEqual(before);
    // Telegram's own reading of it is unchanged, history included.
    const after = store.listTelegramConversations(BOT);
    expect(after).toHaveLength(telegram.length + HISTORY);
    expect(after.filter(one => one.id < 200_000)).toEqual(telegram);
    expect(telegram.map(one => store.listTelegramConversationParts(one.id))).toEqual(parts);
    expect(store.getTelegramConversation(200_010)).toMatchObject({ binding: alexTelegram, approver: "alex", updateId: 200_010, messageId: "300010", text: "historical message 10",
      context: "Current task: guard-1.", taskId: "guard-1", state: "done", outcome: "answered", replyMessageId: "400010", replyTo: null });
    expect(store.getTelegramConversation(200_007)?.replyTo).toBe("300006");
    expect(store.getTelegramConversation(200_050)).toMatchObject({ state: "failed", outcome: "failed:provider", replyMessageId: null });
    expect(store.listTelegramConversationParts(200_002).map(one => [one.ordinal, one.kind, one.state, one.messageId, one.attempts, one.uncertain, one.lastError, one.keyboard]))
      .toEqual([[0, "reply", "sent", "400002", 1, 0, null, null], [1, "reply", "pending", null, 3, 1, "Bad Gateway", [[{ text: "Continue", callback_data: "0123456789abcdef0123456789abcdef" }]]]]);
    expect(store.listTelegramConversationParts(200_001).map(one => one.state)).toEqual(["sent", "dropped"]);
    // Every applied update stays applied: a replayed one is still recognised.
    expect(store.markTelegramUpdateApplied(200_123, "seen", now)).toBe(false);
    expect(store.telegramInbox(BOT, 10)).toEqual([{ updateId: 99_999, payload: '{"update_id":99999}' }]);
    // A reply to a historical message still binds its task.
    const binding = store.liveTelegramBindingFor(BOT, harnesses[0]!.member(0))!;
    expect(store.telegramMessageBindings(binding, "400010").map(one => one.taskId)).toEqual(["guard-1"]);
    // Slack's history is Slack's, numbered as it was.
    const slack = new ChatState(store, "slack");
    expect(partContent(slack.part(100_042)!.payload).text).toBe("historical Slack reply");
    expect(Number(store.handle.prepare("SELECT COUNT(*) AS n FROM chat_event WHERE provider = 'slack' AND id LIKE 'hist-%'").get()!["n"])).toBe(300);
    // Pairings, revoked ones included, and rooms keep their numbers per app.
    for (const provider of CHAT_PROVIDERS) {
      const h = harnesses.find(one => one.provider === provider)!;
      expect(new ChatCore(store, provider).liveBindings(h.installation).map(one => one.approver)).toEqual(["alex"]);
      expect(Number(store.handle.prepare("SELECT COUNT(*) AS n FROM chat_binding WHERE provider = ? AND revoked IS NOT NULL").get(provider)!["n"])).toBe(1);
    }
    expect(store.listTelegramTeamChats(BOT).map(one => one.chatId)).toEqual(["-1001"]);
    expect(store.telegramDigest()).toMatchObject({ everyMs: 3_600_000, setBy: "alex" });

    // The apps carry on from where they were: a Yes armed before the upgrade still finishes the result, once.
    const shown = harnesses.flatMap(h => h.cards(h.member(0)).filter(one => one.buttons.some(button => button.label === "Yes")).map(card => ({ h, card })));
    expect(shown.length).toBeGreaterThan(0);
    const { h: armedIn, card: armed } = shown[0]!;
    const resumed = CHAT_HARNESSES[armedIn.provider]({ store, clock: () => now, evidenceRoot: dir, projects: () => [REPO], origin: "https://console.example", merge: async () => ({ ok: true as const }) });
    resumed.tapToken(armed.buttons.find(button => button.label === "Yes")!.token!, armed.message, armedIn.member(0), armed.buttons.find(button => button.label === "Yes")!.action);
    await resumed.pass();
    expect(assignmentOf(store, "guard-1", now, { principal: "operator", repos: [REPO] }, dir)?.state).toBe("complete");
    expect(resumed.cards(armedIn.member(0)).find(one => one.message === armed.message)!.text).toContain("✓ Accepted and finished.");
    // Reopening changes nothing.
    const settled = chatRows(store.handle);
    store.close();
    store = openStore(file);
    expect(chatRows(store.handle)).toEqual(settled);
  }, 60_000);

  test("an old table in a shape the move can't name refuses before anything changes", async () => {
    await seed();
    store.close();
    const old = new DatabaseSync(file);
    windChatsBack(old);
    old.exec("ALTER TABLE telegram_binding DROP COLUMN paired_by; UPDATE schema_version SET version = 113");
    old.close();
    const bytes = readFileSync(file);
    expect(() => openStore(file)).toThrow("the telegram_binding table has an unknown shape (no paired_by); refusing to move chat history it cannot name");
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  test("a move that can't account for every row rolls back whole, leaves the old tables, and finishes on the next open once the file is mended", async () => {
    await seed();
    const telegram = store.listTelegramConversations(BOT);
    store.close();
    const old = new DatabaseSync(file);
    windChatsBack(old);
    old.exec("PRAGMA foreign_keys = OFF");
    // A reply part whose message is gone: the move refuses to carry a row it can't place.
    old.exec("INSERT INTO telegram_conversation_part (conversation, ordinal, kind, text, state, attempts, uncertain, created_at) VALUES (999999, 0, 'reply', 'orphan', 'pending', 0, 0, '2026-10-01T00:00:00.000Z')");
    old.exec("UPDATE schema_version SET version = 113");
    const legacy = old.prepare("SELECT COUNT(*) AS n FROM telegram_conversation").get()!["n"];
    old.close();
    expect(() => openStore(file)).toThrow(/1 Telegram reply parts belong to no message/);
    const inspect = new DatabaseSync(file);
    // The epoch sentinel says an upgrade is mid-flight; every old row is where it was; nothing was half moved.
    expect(inspect.prepare("SELECT version FROM schema_version").get()!["version"]).toBe(-113);
    expect(inspect.prepare("SELECT COUNT(*) AS n FROM telegram_conversation").get()!["n"]).toBe(legacy);
    for (const table of CHAT_TABLES) expect(Number(inspect.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!["n"]), table).toBe(0);
    inspect.exec("DELETE FROM telegram_conversation_part WHERE conversation = 999999");
    inspect.close();
    store = openStore(file);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()!["version"]).toBe(118);
    expect(store.listTelegramConversations(BOT)).toEqual(telegram);
  });

  test("an upgrade interrupted after the move resumes without moving anything twice; a v114 file without the shared tables refuses", async () => {
    await seed();
    const before = chatRows(store.handle);
    store.close();
    const old = new DatabaseSync(file);
    windChatsBack(old);
    old.exec("UPDATE schema_version SET version = 113");
    old.close();
    store = openStore(file);
    const moved = chatRows(store.handle);
    expect(moved).toEqual(before);
    store.close();
    // The move committed, then the process died before the version was written: the sentinel is still -113.
    let raw = new DatabaseSync(file);
    raw.exec("UPDATE schema_version SET version = -113");
    raw.close();
    store = openStore(file);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()!["version"]).toBe(118);
    expect(chatRows(store.handle)).toEqual(moved);
    for (const table of LEGACY_TELEGRAM_TABLES) expect(store.handle.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table)).toBeUndefined();
    store.close();
    raw = new DatabaseSync(file);
    raw.exec("DROP TABLE chat_digest");
    raw.close();
    expect(() => openStore(file)).toThrow("chat history is missing");
  });

  test("the move is an in-place update from v114 (and v110 on): every legacy table has a rule saying where its rows go", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(116);
    expect(updateSafeSchema(114)).toBe(true);
    expect(updateSafeSchema(113)).toBe(true);
    expect(Object.keys(CHAT_MOVES).sort()).toEqual([...LEGACY_TELEGRAM_TABLES, ...LEGACY_CHAT_APPS.flatMap(legacyAppTables)].sort());
    expect(Object.keys(CHAT_MOVES)).toHaveLength(70);
  });

  test("the owner's v114 shape (4,220 Telegram sends, 8 conversations, 8 replies, 1 pairing, Slack empty) upgrades with every count the same, and the rehearsal accepts it", () => {
    store.close();
    const old = new DatabaseSync(file);
    ownerShapedV114(old);
    const legacy = [...LEGACY_TELEGRAM_TABLES, ...LEGACY_CHAT_APPS.flatMap(legacyAppTables)];
    const count = (db: DatabaseSync, sql: string) => Number(db.prepare(sql).get()!["n"]);
    const counts = Object.fromEntries(legacy.map(table => [table, count(old, `SELECT COUNT(*) AS n FROM ${table}`)]));
    expect({ outbound: counts["telegram_outbound_message"], conversations: counts["telegram_conversation"], parts: counts["telegram_conversation_part"],
      bindings: counts["telegram_binding"], pairing: counts["telegram_pairing"] }).toEqual(OWNER_V114);
    for (const table of legacy.filter(one => !one.startsWith("telegram_") && one !== "bridge_lease")) expect(counts[table], table).toBe(0);
    for (const table of CHAT_TABLES) expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), table).toBeUndefined();
    expect(old.prepare("SELECT version FROM schema_version").get()!["version"]).toBe(114);
    // The fixture, byte for byte: every legacy row, in order (its sha256 is quoted in the handoff).
    const digest = createHash("sha256");
    for (const table of legacy) for (const row of old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) digest.update(`${table}:${JSON.stringify(row)}\n`);
    expect(digest.digest("hex")).toBe(OWNER_FIXTURE_SHA256);
    const before = historySnapshot(old);
    old.close();

    // This open refused it before ("chat history is missing"); now it moves it.
    store = openStore(file);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()!["version"]).toBe(SCHEMA_VERSION);
    const db = store.handle;
    const shared = (sql: string) => Number(db.prepare(sql).get()!["n"]);
    expect({
      outbound: shared("SELECT COUNT(*) AS n FROM chat_message_ref WHERE provider = 'telegram' AND kind = 'notification'"),
      conversations: shared("SELECT COUNT(*) AS n FROM chat_event WHERE provider = 'telegram' AND kind = 'message'"),
      parts: shared("SELECT COUNT(*) AS n FROM chat_part WHERE provider = 'telegram'"),
      bindings: shared("SELECT COUNT(*) AS n FROM chat_binding WHERE provider = 'telegram'"),
      pairing: shared("SELECT COUNT(*) AS n FROM chat_pair WHERE provider = 'telegram'"),
    }).toEqual(OWNER_V114);
    for (const provider of ["slack", "discord", "teams"]) for (const table of CHAT_TABLES.filter(one => one !== "chat_digest"))
      expect(shared(`SELECT COUNT(*) AS n FROM ${table} WHERE provider = '${provider}'`), `${provider} ${table}`).toBe(0);
    for (const table of legacy) expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), table).toBeUndefined();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // Telegram reads it as it did: its pairing, its conversations with their replies, and every sent message's notification.
    const binding = store.liveTelegramBindingFor("8123456789", "5550001")!;
    expect(binding).toMatchObject({ id: 1, approver: "alex", chatId: "5550001" });
    expect(store.listTelegramConversations("8123456789").map(one => [one.updateId, one.state, one.replyMessageId])).toEqual(
      Array.from({ length: 8 }, (_, i) => [700401 + i, "done", String(6001 + i)]));
    expect(store.listTelegramConversationParts(store.listTelegramConversations("8123456789")[2]!.id).map(one => [one.state, one.messageId, one.text])).toEqual([["sent", "6003", "Two results are ready for you."]]);
    expect(store.telegramMessageBindings(binding, "4242")).toHaveLength(1);
    expect(db.prepare("SELECT notification, destination FROM chat_message_ref WHERE provider = 'telegram' AND message = '4242'").all()).toEqual([{ notification: 903242, destination: "telegram:8123456789:5550001:1:1" }]);
    expect(store.markTelegramUpdateApplied(700405, "seen", new Date())).toBe(false);
    store.close();

    // The update's rehearsal: every moved table's rows arrived, nothing else changed.
    const after = new DatabaseSync(file, { readOnly: true });
    try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
    store = openStore(file);
  });

  test("an app whose pairings are already in the shared tables is never merged again from old ones", async () => {
    await seed();
    store.close();
    const old = new DatabaseSync(file);
    addLegacyChatTables(old);
    old.exec(`INSERT INTO telegram_binding (bot_id, chat_id, user_id, approver, approver_generation, paired_at, paired_by) VALUES ('${BOT}', '1', '1', 'alex', 1, '2026-10-01', 'alex');
      UPDATE schema_version SET version = 113`);
    old.close();
    expect(() => openStore(file)).toThrow("the shared chat tables already hold telegram pairings — refusing to merge the old telegram tables into them");
  });
});
