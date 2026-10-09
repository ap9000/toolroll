/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, type Store } from "./store.js";
import { historySnapshot, changedHistory } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([110, -110])("v%s: the request-budget tables are added and every saved row is left as it was", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v112-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-06T17:00:00.000Z");
  const first = openStore(file);
  first.createTask({ id: "t-1", title: "a task" }, now);
  first.recordAction({ at: now.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: "permission default changed", outcome: "changed", source: "policy", detail: "standard → hands-off" });
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v110 shape: neither table.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE request_budget_limit; DROP TABLE request_budget_usage");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(110)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(112);
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(117);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(117);
  expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'request_budget_%' ORDER BY name").all().map(row => row["name"]))
    .toEqual(["request_budget_limit", "request_budget_usage"]);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  // Bounded from the start: a limit outside its range, or a target that is neither the installation nor a token id, is refused.
  const insert = (target: string, perDay: number) => store!.handle.prepare("INSERT INTO request_budget_limit (target, per_day, set_by, set_at) VALUES (?, ?, 'alex', 'now')").run(target, perDay);
  expect(() => insert("*", 0)).toThrow(/CHECK/);
  expect(() => insert("*", 100_001)).toThrow(/CHECK/);
  expect(() => insert("SO_SECRET", 10)).toThrow(/CHECK/);
  insert("abcdef012345", 10);
  store.close();
  store = undefined;
  // A second open changes nothing it had.
  store = openStore(file);
  expect(store.handle.prepare("SELECT per_day FROM request_budget_limit WHERE target = 'abcdef012345'").get()?.["per_day"]).toBe(10);
  store.close();
  store = undefined;
  const after = new DatabaseSync(file, { readOnly: true });
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
});
