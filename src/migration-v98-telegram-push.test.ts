/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([97, -97])("v%s: the poll lease carries over whole, and pushed updates have somewhere to wait", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v98-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-26T21:00:00.000Z");
  const first = openStore(file);
  first.acquireBridgeLease("777000", "follow-a", 120_000, now);
  first.close();
  // The v97 shape: no inbox, no push columns on the lease.
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE bridge_lease_old (bot_id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL)`);
  db.exec("INSERT INTO bridge_lease_old SELECT bot_id, owner, generation, cursor, expires_at, heartbeat_at FROM bridge_lease; DROP TABLE bridge_lease; ALTER TABLE bridge_lease_old RENAME TO bridge_lease; DROP TABLE telegram_inbox");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(112);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(112);
  expect(store.telegramPush("777000")).toEqual({ url: null, problem: null, at: null });
  store.setTelegramPush("777000", { url: "https://example.ts.net/hooks/telegram", problem: null }, now);
  expect(store.telegramPush("777000")?.url).toBe("https://example.ts.net/hooks/telegram");
  expect(store.queueTelegramUpdate("777000", 5, '{"update_id":5}', now)).toBe(true);
  expect(store.telegramInbox("777000", 10)).toEqual([{ updateId: 5, payload: '{"update_id":5}' }]);
});
