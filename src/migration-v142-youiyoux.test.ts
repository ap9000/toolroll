/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([141, -141])("v%s: youiyoux's intake and request tables are added; no saved row changes", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v142-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-11-01T12:00:00.000Z");
  const first = openStore(file);
  first.upsertProject("/projects/shop", "shop", now);
  first.createTask({ id: "t-1", title: "a task" }, now);
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v141 shape: neither table.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE youiyoux_request; DROP TABLE youiyoux_intake");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(141)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(142);
  expect(SCHEMA_VERSION).toBe(142);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(142);
  for (const table of ["youiyoux_intake", "youiyoux_request"]) expect(store.handle.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
  // A choice is on, off or automatic; a request id is youiyoux's shape; a status is one of youiyoux's words; a task is one request's.
  const intake = (enabled: number | null) => store!.handle.prepare("INSERT OR REPLACE INTO youiyoux_intake (repo, enabled) VALUES ('/projects/shop', ?)").run(enabled);
  intake(null); intake(0); intake(1);
  expect(() => intake(2)).toThrow();
  expect(() => store!.handle.prepare("UPDATE youiyoux_intake SET uses = 2").run()).toThrow();
  const request = (id: string, task: string | null, status: string | null = null) => store!.handle.prepare("INSERT INTO youiyoux_request (repo, request, task_id, filed_at, status) VALUES ('/projects/shop', ?, ?, ?, ?)").run(id, task, now.toISOString(), status);
  request("r-0123456789", "t-1", "needs-you");
  expect(() => request("r-0123456789", null)).toThrow();
  expect(() => request("r-ABCDEF0123", null)).toThrow();
  expect(() => request("r-0123456789a", null)).toThrow();
  expect(() => request("../r-01234567", null)).toThrow();
  expect(() => request("r-1111111111", "t-1")).toThrow();
  expect(() => request("r-2222222222", null, "approved")).toThrow();
  request("r-3333333333", null);
  request("r-4444444444", null);
  store.handle.exec("DELETE FROM youiyoux_request; DELETE FROM youiyoux_intake");
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
});
