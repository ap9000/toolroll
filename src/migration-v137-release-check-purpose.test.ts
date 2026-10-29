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

test.each([136, -136])("v%s: a scope's release check purpose is added; saved scopes have none", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v137-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-29T12:00:00.000Z");
  const first = openStore(file);
  first.upsertProject("/projects/shop", "shop", now);
  first.createTask({ id: "t-1", title: "a task" }, now);
  first.refFor(BUILT_IN, "t-1");
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v136 shape: no column.
  const db = new DatabaseSync(file);
  db.exec("ALTER TABLE task_scope DROP COLUMN release_check_json");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(136)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(137);
  expect(SCHEMA_VERSION).toBe(137);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(137);
  expect(store.handle.prepare("SELECT count(*) AS n FROM pragma_table_info('task_scope') WHERE name = 'release_check_json'").get()?.["n"]).toBe(1);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try {
    expect(changedHistory(after, before)).toEqual([]);
  } finally { after.close(); }
});
