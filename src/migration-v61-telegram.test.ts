/** Isolated v60 fixtures only: production databases are never opened here. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addLegacyChatTables } from "../test/legacy-chat.js";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

const NOW = new Date("2026-09-15T18:00:00Z");
const columns = ["provenance_scope", "project", "task_ref", "task_id", "source_run"];
const tables = ["notification_delivery", "telegram_outbound_message", "telegram_retry"];
/** v62 (the conversation queue) and v63 (its outbound parts) ride above this foundation; a v60 wind-back drops them too. */
const laterTables = ["telegram_conversation_part", "telegram_conversation", "telegram_proposal_action"];

describe("v61 Telegram delivery foundation", () => {
  let dir: string | undefined;
  let store: Store | undefined;
  afterEach(() => { store?.close(); store = undefined; if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

  test.each([60, -60])("v%s preserves legacy rows and unknown provenance, then reopens idempotently", version => {
    dir = mkdtempSync(join(tmpdir(), "so-v61-"));
    const file = join(dir, "orders.db");
    store = openStore(file);
    store.enqueueNotification({ dedupeKey: "legacy-task", kind: "decision", subject: "a", body: "private task", link: "/t/a" }, NOW);
    store.enqueueNotification({ dedupeKey: "legacy-sent", kind: "merge", subject: "b", body: "sent" }, NOW);
    store.close(); store = undefined;
    const old = new DatabaseSync(file);
    addLegacyChatTables(old);
    for (const table of [...laterTables, ...tables]) old.exec(`DROP TABLE ${table}`);
    for (const column of columns) old.exec(`ALTER TABLE notification DROP COLUMN ${column}`);
    old.exec("DROP TABLE service_cursor");
    old.prepare("UPDATE schema_version SET version = ?").run(version);
    const before = old.prepare("SELECT * FROM notification ORDER BY id").all();
    old.close();
    store = openStore(file);
    expect(SCHEMA_VERSION).toBe(116);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    const after = store.handle.prepare("SELECT * FROM notification ORDER BY id").all();
    expect(after.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !columns.includes(key))))).toEqual(before);
    expect(store.listNotifications("all").map(row => row.scope)).toEqual(["unknown", "unknown"]);
    // The receipts, sent messages and retry waits moved to the shared chat tables (v116): still none.
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM notification_delivery").get()?.["n"]).toBe(0);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM chat_message_ref").get()?.["n"]).toBe(0);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM chat_runtime").get()?.["n"]).toBe(0);
    for (const table of tables.slice(1)) expect(store.handle.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table)).toBeUndefined();
    store.close(); store = openStore(file);
    expect(store.handle.prepare("SELECT * FROM notification ORDER BY id").all()).toEqual(after);
  });

  test("a v113 database missing delivery history fails closed instead of recreating it", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v61-missing-"));
    const file = join(dir, "orders.db");
    store = openStore(file); store.close(); store = undefined;
    const db = new DatabaseSync(file); addLegacyChatTables(db); db.exec("DROP TABLE telegram_outbound_message; UPDATE schema_version SET version = 113"); db.close();
    expect(() => openStore(file)).toThrow("Telegram delivery history is missing");
  });
});
