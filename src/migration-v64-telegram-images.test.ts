/** Isolated v63/v64 fixtures only: production databases are never opened here. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, TELEGRAM_CONVERSATION_PART_V63_COLUMNS, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { hashPairingCode, mintPairingCode, PAIRING_TTL_MS } from "./telegram.js";
import { telegramRequestId } from "./telegram-mate.js";

const NOW = new Date("2026-09-16T09:00:00Z");
const BOT = "777000";
/** The exact deployed v63 shape of the parts table, as the v63 SCHEMA created it. */
const V63_PARTS = `CREATE TABLE telegram_conversation_part (
  conversation    INTEGER NOT NULL REFERENCES telegram_conversation(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('reply','card')),
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
  PRIMARY KEY (conversation, ordinal),
  CHECK ((state = 'sent') = (message_id IS NOT NULL)),
  CHECK ((state = 'sent') = (sent_at IS NOT NULL))
)`;

describe("v64 Telegram result images", () => {
  let dir: string | undefined;
  let store: Store | undefined;
  afterEach(() => { store?.close(); store = undefined; if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

  /** A paired chat whose reply went out in two parts — one confirmed, one still pending after a lost answer — plus a finished run an image could name. */
  const seed = (db: Store): { conversation: number; run: number; taskRef: number; parts: Record<string, unknown>[] } => {
    for (const phase of ["build", "plan", "review"]) db.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", NOW);
    const alex = addApprover(db, "alex", NOW);
    if (!alex.ok) throw new Error("bootstrap");
    db.createTask({ id: "alpha", title: "Work alpha" }, NOW);
    const taskRef = db.refFor("built-in", "alpha").id;
    db.placeTask(taskRef, "/repo/alpha");
    propose(db, { taskId: "alpha", goal: "do alpha", touches: ["src/"], acceptance: [{ id: "c1", statement: "It holds", how: null, evidence: ["manual-review"] }], now: NOW });
    const approved = approve(db, "alpha", "alex", NOW, db.getScope("alpha")!.digest, alex.token);
    if (!approved.ok) throw new Error(approved.reason);
    const route = db.routeAuthorityFor(taskRef, "builder", null);
    if (!route?.ok) throw new Error("route");
    const run = db.startRun({ taskRef, leaseId: "l-alpha", runner: "builder-1", branch: "so/alpha", worktree: "/pool/alpha", route: route.stamp, now: NOW });
    db.finishRun(run, { outcome: "built", committed: true, now: NOW });
    const code = mintPairingCode();
    db.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, NOW);
    const paired = db.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: "4242", userId: "31337", updateId: 1 }, NOW);
    if (!paired.ok) throw new Error("pair");
    const binding = db.liveTelegramBinding(BOT)!;
    const conversation = db.enqueueTelegramConversation({ binding, updateId: 2, messageId: "1002", replyTo: null, request: telegramRequestId(BOT, binding.id, 2), text: "what needs me?", context: null, taskId: null, sourceRun: null }, NOW);
    const claimed = db.claimTelegramConversation(BOT, "owner", 60_000, NOW);
    if (claimed === null) throw new Error("claim");
    if (!db.planTelegramConversationParts(claimed.id, "owner", { session: 1, turn: 1 }, [{ kind: "reply", text: "first", replyTo: "1002" }, { kind: "reply", text: "second" }], NOW)) throw new Error("plan");
    if (!db.settleTelegramConversationPart(claimed.id, 0, "owner", { ok: true, messageId: "100" }, NOW)) throw new Error("settle");
    if (!db.settleTelegramConversationPart(claimed.id, 1, "owner", { ok: false, error: "lost", uncertain: true, retryAt: NOW.toISOString() }, NOW)) throw new Error("settle");
    return { conversation: claimed.id, run, taskRef, parts: db.handle.prepare("SELECT * FROM telegram_conversation_part ORDER BY ordinal").all() as Record<string, unknown>[] };
  };

  /** The exact deployed v63 shape: the parts table without media identity, no turn-evidence table, stamped v63 (or its mid-flight sentinel). */
  const windBack = (file: string, version: number): void => {
    const old = new DatabaseSync(file);
    old.exec("PRAGMA foreign_keys = OFF");
    old.exec(V63_PARTS.replace("telegram_conversation_part (", "telegram_conversation_part_v63 ("));
    const columns = TELEGRAM_CONVERSATION_PART_V63_COLUMNS.join(", ");
    old.exec(`INSERT INTO telegram_conversation_part_v63 (${columns}) SELECT ${columns} FROM telegram_conversation_part`);
    old.exec("DROP TABLE telegram_conversation_part");
    old.exec("ALTER TABLE telegram_conversation_part_v63 RENAME TO telegram_conversation_part");
    old.exec("DROP TABLE mate_turn_evidence");
    old.exec("DROP TABLE service_cursor");
    old.prepare("UPDATE schema_version SET version = ?").run(version);
    old.close();
  };
  const v63Columns = (row: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(TELEGRAM_CONVERSATION_PART_V63_COLUMNS.map(column => [column, row[column]]));

  test.each([63, -63])("v%s upgrades to v64 keeping every part row, receipt, attempt and uncertain count, admits typed image parts, and reopens idempotently", version => {
    dir = mkdtempSync(join(tmpdir(), "so-v64-"));
    const file = join(dir, "orders.db");
    store = openStore(file);
    const before = seed(store);
    expect(before.parts.map(row => [row["ordinal"], row["state"], row["message_id"], row["attempts"], row["uncertain"]])).toEqual([[0, "sent", "100", 1, 0], [1, "pending", null, 1, 1]]);
    store.close(); store = undefined;
    windBack(file, version);
    {
      const old = new DatabaseSync(file);
      expect(String(old.prepare("SELECT sql FROM sqlite_master WHERE name = 'telegram_conversation_part'").get()?.["sql"])).not.toContain("artifact");
      expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'mate_turn_evidence'").get()).toBeUndefined();
      expect(old.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(version);
      old.close();
    }

    store = openStore(file);
    expect(SCHEMA_VERSION).toBe(113);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    const after = store.handle.prepare("SELECT * FROM telegram_conversation_part ORDER BY ordinal").all() as Record<string, unknown>[];
    expect(after.map(v63Columns)).toEqual(before.parts.map(v63Columns));
    expect(after.map(row => [row["task_id"], row["source_run"], row["artifact"], row["sha256"]])).toEqual([[null, null, null, null], [null, null, null, null]]);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn_evidence").get()?.["n"]).toBe(0);
    expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const ddl = String(store.handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'telegram_conversation_part'").get()?.["sql"]);
    expect(ddl).toContain("kind IN ('reply','card','image')");
    expect(ddl).toContain("CHECK ((kind = 'image') = (task_id IS NOT NULL AND source_run IS NOT NULL AND artifact IS NOT NULL AND sha256 IS NOT NULL))");
    // Typed identity is a constraint, not a convention: an image needs every column, and nothing else may carry one.
    const insert = "INSERT INTO telegram_conversation_part (conversation, ordinal, kind, text, state, created_at, task_id, source_run, artifact, sha256) VALUES (?, 9, ?, 'x', 'pending', ?, ?, ?, ?, ?)";
    expect(() => store!.handle.prepare(insert).run(before.conversation, "image", NOW.toISOString(), "alpha", before.run, null, "a".repeat(64))).toThrow(/CHECK|constraint/);
    expect(() => store!.handle.prepare(insert).run(before.conversation, "reply", NOW.toISOString(), "alpha", before.run, 7, "a".repeat(64))).toThrow(/CHECK|constraint/);
    expect(() => store!.handle.prepare(insert).run(before.conversation, "image", NOW.toISOString(), "alpha", 999_999, 7, "a".repeat(64))).toThrow(/FOREIGN KEY|constraint/);
    // The mid-flight row resumes exactly where it was: the confirmed part is not re-planned, the pending one is still owed.
    const claimed = store.claimTelegramConversation(BOT, "owner", 60_000, new Date(NOW.getTime() + 120_000));
    expect(claimed).toMatchObject({ id: before.conversation, state: "running" });
    expect(store.planTelegramConversationParts(before.conversation, "owner", { session: 1, turn: 1 }, [{ kind: "reply", text: "other" }], NOW)).toBe(false);
    expect(store.listTelegramConversationParts(before.conversation).map(one => [one.kind, one.state, one.messageId, one.attempts, one.uncertain, one.taskId, one.run, one.artifact, one.sha256])).toEqual([
      ["reply", "sent", "100", 1, 0, null, null, null, null], ["reply", "pending", null, 1, 1, null, null, null, null],
    ]);
    // A fresh conversation plans an image by identity alone; once confirmed, a reply to that message binds the exact task and run.
    const binding = store.liveTelegramBinding(BOT)!;
    store.enqueueTelegramConversation({ binding, updateId: 3, messageId: "1003", replyTo: null, request: telegramRequestId(BOT, binding.id, 3), text: "show me the screenshots", context: null, taskId: null, sourceRun: null }, NOW);
    store.finishTelegramConversation(before.conversation, "owner", { state: "done", outcome: "test" }, new Date(NOW.getTime() + 120_000));
    const next = store.claimTelegramConversation(BOT, "owner", 60_000, new Date(NOW.getTime() + 120_000));
    if (next === null) throw new Error("claim");
    expect(store.planTelegramConversationParts(next.id, "owner", { session: 1, turn: 2 }, [
      { kind: "reply", text: "One screenshot follows.", replyTo: "1003" },
      { kind: "image", text: `alpha · result #${before.run} · screenshot 1 of 1`, taskId: "alpha", run: before.run, artifact: 7, sha256: "b".repeat(64) },
    ], NOW)).toBe(true);
    expect(store.listTelegramConversationParts(next.id)[1]).toMatchObject({ kind: "image", state: "pending", text: `alpha · result #${before.run} · screenshot 1 of 1`, replyTo: null, proposal: null, keyboard: null, taskId: "alpha", run: before.run, artifact: 7, sha256: "b".repeat(64) });
    expect(store.telegramMessageBindings(binding, "200")).toEqual([]);
    expect(store.settleTelegramConversationPart(next.id, 1, "owner", { ok: true, messageId: "200" }, new Date(NOW.getTime() + 120_000))).toBe(true);
    expect(store.telegramMessageBindings(binding, "200")).toEqual([{ taskId: "alpha", taskRef: before.taskRef, run: before.run, project: "/repo/alpha" }]);
    // An image part never becomes the row's reply id; a dropped image is history with its reason.
    expect(store.getTelegramConversation(next.id)?.replyMessageId).toBeNull();
    expect(store.dropTelegramConversationPart(next.id, 1, "owner", "late", NOW)).toBe(false);
    const rows = store.handle.prepare("SELECT * FROM telegram_conversation_part ORDER BY conversation, ordinal").all();
    store.close(); store = openStore(file);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(store.handle.prepare("SELECT * FROM telegram_conversation_part ORDER BY conversation, ordinal").all()).toEqual(rows);
  });

  test("a current database missing the turn-evidence table or the typed columns fails closed instead of recreating them", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v64-missing-"));
    const file = join(dir, "orders.db");
    store = openStore(file); store.close(); store = undefined;
    let db = new DatabaseSync(file); db.exec("DROP TABLE mate_turn_evidence"); db.close();
    expect(() => openStore(file)).toThrow("Telegram image history is missing");
    db = new DatabaseSync(file);
    db.exec("CREATE TABLE IF NOT EXISTS mate_turn_evidence (turn INTEGER, ordinal INTEGER)");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(V63_PARTS.replace("telegram_conversation_part (", "telegram_conversation_part_v63 ("));
    db.exec("DROP TABLE telegram_conversation_part");
    db.exec("ALTER TABLE telegram_conversation_part_v63 RENAME TO telegram_conversation_part");
    db.close();
    expect(() => openStore(file)).toThrow("Telegram image history is missing");
  });

  test("the rollback is the wind-back: the v63 shape stamped v63 is a file a v63 reader recognizes whole, and a v64 file refuses a v63 reader by its version alone", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v64-rollback-"));
    const file = join(dir, "orders.db");
    store = openStore(file);
    const before = seed(store);
    store.close(); store = undefined;
    windBack(file, 63);
    const db = new DatabaseSync(file);
    expect(db.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(63);
    expect(db.prepare("SELECT * FROM telegram_conversation_part ORDER BY ordinal").all()).toEqual(before.parts.map(v63Columns));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    // The older reader's fence on this file is the version gate itself (migration-v50-review-retries.test.ts proves it refuses a newer stamp before any write).
    expect(SCHEMA_VERSION).toBeGreaterThan(63);
  });
});
