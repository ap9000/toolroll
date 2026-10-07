/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { LEDGER_SCHEMA, LEDGER_V54_COLUMNS, LEDGER_V99_TABLE, installLedgerTriggers } from "./action-ledger.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([109, -109])("v%s: every ledger row, id, detail and seal carries over, and remote commands (api, mcp) fit", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v110-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-06T17:00:00.000Z");
  const first = openStore(file);
  first.createTask({ id: "t-1", title: "a task" }, now);
  first.recordAction({ at: now.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: "permission default changed", outcome: "changed", source: "policy", detail: "standard → hands-off" });
  first.sealLedger();
  const before = first.actionLedger({ repos: null, limit: 101 });
  const chain = first.ledgerChain({ full: true });
  first.close();
  expect(before.some(one => one.detail === "standard → hands-off")).toBe(true);
  expect(chain.ok).toBe(true);
  // The v109 shape: the v99 ledger table, with its append-only and work triggers in place.
  const db = new DatabaseSync(file);
  for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%action_ledger%'").all()) db.exec(`DROP TRIGGER "${String(trigger["name"])}"`);
  const columns = [...LEDGER_V54_COLUMNS, "detail"].join(",");
  db.exec(LEDGER_V99_TABLE("action_ledger_old"));
  db.exec(`INSERT INTO action_ledger_old (${columns}) SELECT ${columns} FROM action_ledger; DROP TABLE action_ledger; ALTER TABLE action_ledger_old RENAME TO action_ledger`);
  db.exec(LEDGER_SCHEMA);
  installLedgerTriggers(db as never);
  expect(() => db.prepare("INSERT INTO action_ledger(at,actor,action,outcome,source) VALUES ('x','sam','remote command: status','done','api')").run()).toThrow(/CHECK/);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();

  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(112);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(112);
  // Every row, with its id and detail, as it was; the chain over them still proves.
  expect(store.actionLedger({ repos: null, limit: 101 })).toEqual(before);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  // The indexes over the ledger are back, work still records itself, and the ledger stays append-only.
  expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'action_ledger' ORDER BY name").all().map(row => row["name"]))
    .toEqual(expect.arrayContaining(["action_ledger_actor", "action_ledger_project", "work_completion", "work_task_ledger"]));
  store.setTaskState("t-1", "done", now);
  expect(store.actionLedger({ repos: null, limit: 1 })[0]).toMatchObject({ action: "task state changed", outcome: "done", source: "work" });
  expect(() => store!.handle.prepare("UPDATE action_ledger SET actor = 'mallory'").run()).toThrow(/append-only/);
  // The new sources, each with its token's name; any other word is still refused.
  const id = store.recordAction({ at: now.toISOString(), actor: "sam", repo: null, taskId: null, runId: null, action: "remote command: status", outcome: "done", source: "api", detail: "token laptop" });
  expect(id).toBeGreaterThan(Math.max(...before.map(one => one.id)));
  store.recordAction({ at: now.toISOString(), actor: "sam", repo: null, taskId: null, runId: null, action: "remote command: task show", outcome: "done", source: "mcp", detail: "token agent" });
  expect(store.actionLedger({ repos: null, source: "api" })).toEqual([expect.objectContaining({ id, actor: "sam", detail: "token laptop" })]);
  expect(() => store!.handle.prepare("INSERT INTO action_ledger(at,actor,action,outcome,source) VALUES ('x','sam','y','z','cli')").run()).toThrow(/CHECK/);
  // A second open changes nothing.
  store.close();
  const bytes = () => new DatabaseSync(file).prepare("SELECT sql FROM sqlite_master WHERE name = 'action_ledger'").get()?.["sql"];
  const shape = bytes();
  store = openStore(file);
  store.close(); store = undefined;
  expect(bytes()).toBe(shape);
});
