/** Isolated v61/v62 fixtures only: production databases are never opened here. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addLegacyChatTables, windChatsBack } from "../test/legacy-chat.js";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { hashPairingCode, mintPairingCode, PAIRING_TTL_MS } from "./telegram.js";
import { telegramRequestId } from "./telegram-lead.js";

const NOW = new Date("2026-09-16T09:00:00Z");
const BOT = "777000";
/** The v62 tables a v61 wind-back drops, children first. */
const V62_TABLES = ["telegram_proposal_action", "telegram_conversation"];
const V52_RUN_STOP = `CREATE TABLE run_stop (
  run INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE, task_ref INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL, requested_via TEXT NOT NULL CHECK (requested_via IN ('cli','web')), requested_at TEXT NOT NULL,
  settled_at TEXT, settlement TEXT CHECK (settlement IN ('interrupted','recovered','held','finished')), resumed_at TEXT, resumed_by TEXT,
  resumed_via TEXT CHECK (resumed_via IN ('cli','web')), CHECK ((settled_at IS NULL) = (settlement IS NULL)),
  CHECK (resumed_at IS NULL OR settled_at IS NOT NULL), CHECK ((resumed_at IS NULL) = (resumed_by IS NULL)))`;

describe("v63 Telegram durable replies", () => {
  let dir: string | undefined;
  let store: Store | undefined;
  afterEach(() => { store?.close(); store = undefined; if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

  /** A paired chat with one queued message: the rows a deployed v62 candidate holds mid-flight. */
  const seed = (db: Store): void => {
    for (const phase of ["build", "plan", "review"]) db.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", NOW);
    const alex = addApprover(db, "alex", NOW);
    if (!alex.ok) throw new Error("bootstrap");
    const code = mintPairingCode();
    db.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, NOW);
    const paired = db.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: "4242", userId: "31337", updateId: 1 }, NOW);
    if (!paired.ok) throw new Error("pair");
    const binding = db.liveTelegramBinding(BOT)!;
    db.enqueueTelegramConversation({ binding, updateId: 2, messageId: "1002", replyTo: null, request: telegramRequestId(BOT, binding.id, 2), text: "what needs me?", context: null, taskId: null, sourceRun: null }, NOW);
  };

  /** The exact deployed v61 shape, or the v62 candidate shape (its rows kept, in the old Telegram tables), or either's mid-flight sentinel. */
  const windBack = (file: string, version: number): { conversation: Record<string, unknown>[] } => {
    const old = new DatabaseSync(file);
    windChatsBack(old);
    const conversation = old.prepare("SELECT * FROM telegram_conversation ORDER BY id").all() as Record<string, unknown>[];
    old.exec("DROP TABLE telegram_conversation_part");
    if (Math.abs(version) === 61) {
      for (const table of V62_TABLES) old.exec(`DROP TABLE ${table}`);
      old.exec("DROP TABLE run_stop");
      old.exec(V52_RUN_STOP);
    }
    old.exec("DROP TABLE service_cursor");
    old.prepare("UPDATE schema_version SET version = ?").run(version);
    old.close();
    return { conversation };
  };

  test.each([62, -62, 61, -61])("v%s upgrades through v63 to the current schema keeping every conversation row, and reopens idempotently", version => {
    dir = mkdtempSync(join(tmpdir(), "so-v63-"));
    const file = join(dir, "orders.db");
    store = openStore(file);
    seed(store);
    const seen = store.listTelegramConversations(BOT);
    expect(seen).toHaveLength(1);
    store.close(); store = undefined;
    const before = windBack(file, version);
    expect(before.conversation).toHaveLength(1);
    const fromV62 = Math.abs(version) === 62;

    store = openStore(file);
    expect(SCHEMA_VERSION).toBe(117);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    // Every conversation row carried into the shared chat tables (v114), read back exactly as it was written.
    expect(store.listTelegramConversations(BOT)).toEqual(fromV62 ? seen : []);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM chat_part WHERE provider = 'telegram'").get()?.["n"]).toBe(0);
    expect(String(store.handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'run_stop'").get()?.["sql"])).toContain("'cli','web','telegram'");
    expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // A part only belongs to a message that exists.
    expect(() => store!.handle.prepare("INSERT INTO chat_part (provider, id, event, ordinal, payload, created) VALUES ('telegram', 1, 'm999', 0, '{}', ?)").run(NOW.toISOString())).toThrow(/FOREIGN KEY|constraint/);
    if (fromV62) {
      const id = seen[0]!.id;
      expect(store.claimTelegramConversation(BOT, "owner", 60_000, NOW)).toMatchObject({ id, state: "running" });
      expect(store.planTelegramConversationParts(id, "owner", { session: 1, turn: 1 }, [{ kind: "reply", text: "hello", replyTo: "1002" }], NOW)).toBe(true);
      expect(store.listTelegramConversationParts(id)).toEqual([expect.objectContaining({ ordinal: 0, kind: "reply", text: "hello", state: "pending", messageId: null, attempts: 0, uncertain: 0 })]);
      // A second plan never replaces the first; a settle needs the claim; a confirmed id is the only success.
      expect(store.planTelegramConversationParts(id, "owner", { session: 1, turn: 1 }, [{ kind: "reply", text: "other" }], NOW)).toBe(false);
      expect(store.settleTelegramConversationPart(id, 0, "somebody-else", { ok: true, messageId: "7" }, NOW)).toBe(false);
      expect(store.settleTelegramConversationPart(id, 0, "owner", { ok: false, error: "lost", uncertain: true, retryAt: NOW.toISOString() }, NOW)).toBe(true);
      expect(store.settleTelegramConversationPart(id, 0, "owner", { ok: true, messageId: "7" }, NOW)).toBe(true);
      expect(store.listTelegramConversationParts(id)[0]).toMatchObject({ state: "sent", messageId: "7", attempts: 2, uncertain: 1, lastError: null });
      expect(store.getTelegramConversation(id)?.replyMessageId).toBe("7");
      expect(store.settleTelegramConversationPart(id, 0, "owner", { ok: true, messageId: "8" }, NOW)).toBe(false);
    }
    const after = store.listTelegramConversations(BOT);
    store.close(); store = openStore(file);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(store.listTelegramConversations(BOT)).toEqual(after);
  });

  test("a v113 database missing the parts table fails closed instead of recreating it", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v63-missing-"));
    const file = join(dir, "orders.db");
    store = openStore(file); store.close(); store = undefined;
    const db = new DatabaseSync(file); addLegacyChatTables(db); db.exec("DROP TABLE telegram_conversation_part; UPDATE schema_version SET version = 113"); db.close();
    expect(() => openStore(file)).toThrow("Telegram reply history is missing");
  });

  test("the rollback is the wind-back: dropping the parts table and stamping v62 leaves a file a v62 reader recognizes whole", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v63-rollback-"));
    const file = join(dir, "orders.db");
    store = openStore(file);
    seed(store);
    store.close(); store = undefined;
    const before = windBack(file, 62);
    const db = new DatabaseSync(file);
    expect(db.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(62);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'telegram_conversation_part'").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM telegram_conversation ORDER BY id").all()).toEqual(before.conversation);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
