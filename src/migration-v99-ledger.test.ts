/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { LEDGER_SCHEMA, LEDGER_V54_COLUMNS, LEDGER_V54_TABLE, installLedgerTriggers } from "./action-ledger.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([98, -98])("v%s: every ledger row and id carries over, work still records itself, and sign-in and policy events fit", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v99-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-27T17:00:00.000Z");
  const first = openStore(file);
  first.createTask({ id: "t-1", title: "a task" }, now);
  first.recordAction({ at: now.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: "invitation created", outcome: "viewer", source: "access" });
  const before = first.actionLedger({ repos: null, limit: 101 });
  first.close();
  expect(before.length).toBeGreaterThan(0);
  // The v98 shape: the v54 ledger table, with its append-only and work triggers in place.
  const db = new DatabaseSync(file);
  for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%action_ledger%'").all()) db.exec(`DROP TRIGGER "${String(trigger["name"])}"`);
  db.exec(LEDGER_V54_TABLE("action_ledger_old"));
  db.exec(`INSERT INTO action_ledger_old (${LEDGER_V54_COLUMNS.join(",")}) SELECT ${LEDGER_V54_COLUMNS.join(",")} FROM action_ledger; DROP TABLE action_ledger; ALTER TABLE action_ledger_old RENAME TO action_ledger`);
  db.exec(LEDGER_SCHEMA);
  installLedgerTriggers(db as never);
  expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%action_ledger%'").get()?.["n"]).toBeGreaterThan(3);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();

  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(114);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(114);
  // Every row, with its id, as it was; the new detail is empty.
  expect(store.actionLedger({ repos: null, limit: 101 })).toEqual(before.map(one => ({ ...one, detail: null })));
  // Work still records itself (the triggers are back), and the ledger stays append-only.
  store.setTaskState("t-1", "done", now);
  expect(store.actionLedger({ repos: null, limit: 1 })[0]).toMatchObject({ action: "task state changed", outcome: "done", source: "work" });
  expect(() => store!.handle.prepare("UPDATE action_ledger SET actor = 'mallory'").run()).toThrow(/append-only/);
  expect(() => store!.handle.prepare("DELETE FROM action_ledger").run()).toThrow(/append-only/);
  // The new kinds of event, each with its detail; ids keep counting up.
  const id = store.recordAction({ at: now.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: "permission default changed", outcome: "changed", source: "policy", detail: "standard → hands-off" });
  expect(id).toBeGreaterThan(Math.max(...before.map(one => one.id)));
  store.recordAction({ at: now.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: "signed in", outcome: "browser", source: "sign-in" });
  expect(store.actionLedger({ repos: null, source: "policy" })).toEqual([expect.objectContaining({ id, detail: "standard → hands-off" })]);
  // A second open changes nothing.
  store.close();
  const bytes = () => new DatabaseSync(file).prepare("SELECT sql FROM sqlite_master WHERE name = 'action_ledger'").get()?.["sql"];
  const shape = bytes();
  store = openStore(file);
  store.close(); store = undefined;
  expect(bytes()).toBe(shape);
});
