/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, openStore, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V120_ADDED_COLUMNS, verifiedAuthor, type Store } from "./store.js";
import { historySnapshot, changedHistory } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([119, -119])("v%s: a steering note's mailing and reading are added, and every saved note reads as never mailed", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v120-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-11T12:00:00.000Z");
  const first = openStore(file);
  first.createTask({ id: "t-1", title: "a steered task" }, now);
  const ref = first.refFor(BUILT_IN, "t-1").id;
  first.fileSteerNote("t-1", verifiedAuthor("alex"), "prefer the smaller diff", now);
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v119 shape: none of the three columns.
  const db = new DatabaseSync(file);
  for (const [table, columns] of Object.entries(V120_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(119)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(120);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(134);
  expect(store.listSteerNotes(ref)).toMatchObject([{ note: "prefer the smaller diff", mailedRun: null, mailedAt: null, ackedAt: null, deliveredAt: null }]);
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try {
    expect(changedHistory(after, before)).toEqual([]);
    // The rehearsal notices a saved note that does not read the declared default.
    after.prepare("UPDATE task_steer SET acked_at = 'x'").run();
    expect(changedHistory(after, before)).toEqual(["task_steer"]);
  } finally { after.close(); }
});
