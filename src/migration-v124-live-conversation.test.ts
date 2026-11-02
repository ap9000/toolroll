/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

/** v124's new tables (the live conversation's project setting and note history) and their index. */
const V124_TABLES = ["live_detail_setting", "steer_note_run"];
const V124_INDEXES = ["steer_note_run_by_run"];

test.each([123, -123])("v%s: the live conversation's setting and note history are added; saved projects show no commands", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v124-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-19T12:00:00.000Z");
  const first = openStore(file);
  first.upsertProject("/projects/shop", "shop", now);
  first.createTask({ id: "t-1", title: "a task" }, now);
  first.refFor(BUILT_IN, "t-1");
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v123 shape: neither table, nor the index.
  const db = new DatabaseSync(file);
  for (const index of V124_INDEXES) db.exec(`DROP INDEX ${index}`);
  for (const table of [...V124_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(123)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(124);
  expect(SCHEMA_VERSION).toBe(143);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(143);
  for (const table of V124_TABLES) expect(store.handle.prepare("SELECT count(*) AS n FROM " + table).get()?.["n"]).toBe(0);
  for (const index of V124_INDEXES) expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)).toBeDefined();
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try {
    expect(changedHistory(after, before)).toEqual([]);
  } finally { after.close(); }
  // Opening again changes nothing: the file is current.
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(143);
});
