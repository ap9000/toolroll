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

test.each([135, -135])("v%s: each run's own live-view answer is added; saved runs have none (commands off)", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v136-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-26T12:00:00.000Z");
  const first = openStore(file);
  first.upsertProject("/projects/shop", "shop", now);
  first.createTask({ id: "t-1", title: "a task" }, now);
  first.refFor(BUILT_IN, "t-1");
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v135 shape: no table.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE run_live_detail");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(135)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(136);
  expect(SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
  expect(store.handle.prepare("SELECT count(*) AS n FROM run_live_detail").get()?.["n"]).toBe(0);
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try {
    expect(changedHistory(after, before)).toEqual([]);
  } finally { after.close(); }
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
});
