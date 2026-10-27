/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V123_ADDED_COLUMNS, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

/** v123's new tables (flows that run on their own, the tool-secret sealing key's record) and their indexes. */
const V123_TABLES = ["flow_script_provenance", "flow_unattended_grant", "flow_unattended_run", "tool_secret_key", "tool_secret_legacy"];
const V123_INDEXES = ["flow_unattended_live", "flow_unattended_digest", "flow_unattended_run_day"];

const columnsOf = (s: Store, table: string) => s.handle.prepare(`PRAGMA table_info(${table})`).all().map(row => row["name"]);

test.each([122, -122])("v%s: unattended flows and tool secrets are added; saved plan authorizations read the mode, saved firings read not on time and no script", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v123-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-13T12:00:00.000Z");
  const first = openStore(file);
  first.createTask({ id: "t-1", title: "a task" }, now);
  first.refFor(BUILT_IN, "t-1");
  const flow = first.createFlow({ repo: "/projects/shop", name: "Nightly", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }) }, now);
  const trigger = first.addFlowTrigger({ flow, kind: "schedule", configJson: "{}", hookHash: null, cursor: null, nextAt: null, by: "alex" }, now);
  expect(first.recordFlowTriggerEvent(trigger, "slot-1", null, null, now)).toBe(true);
  first.raw().prepare("INSERT INTO plan_authorization (task_id, source_digest, scope_digest, mode_digest, signed_by, created_at) VALUES ('t-1', 's', 'c', 'm', 'alex', ?)").run(now.toISOString());
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v122 shape: no unattended-flow or tool-secret tables, no plan_authorization.basis, no flow_trigger_event.on_time or ran_script.
  const db = new DatabaseSync(file);
  for (const index of V123_INDEXES) db.exec(`DROP INDEX ${index}`);
  for (const table of V123_TABLES) db.exec(`DROP TABLE ${table}`);
  for (const [table, columns] of Object.entries(V123_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(122)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(123);
  expect(SCHEMA_VERSION).toBe(136);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(136);
  for (const table of V123_TABLES) expect(store.handle.prepare("SELECT count(*) AS n FROM " + table).get()?.["n"]).toBe(0);
  for (const index of V123_INDEXES) expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)).toBeDefined();
  for (const [table, columns] of Object.entries(V123_ADDED_COLUMNS)) expect(columnsOf(store, table)).toEqual(expect.arrayContaining(Object.keys(columns)));
  expect(store.handle.prepare("SELECT basis FROM plan_authorization WHERE task_id = 't-1'").get()).toEqual({ basis: "mode" });
  expect(store.handle.prepare("SELECT on_time, ran_script FROM flow_trigger_event WHERE trigger = ? AND key = 'slot-1'").get(trigger)).toEqual({ on_time: 0, ran_script: null });
  expect(store.toolSecretKeyDigest()).toBeNull();
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try {
    expect(changedHistory(after, before)).toEqual([]);
    // The rehearsal notices a saved row that does not read the declared default.
    after.prepare("UPDATE plan_authorization SET basis = 'grant'").run();
    expect(changedHistory(after, before)).toEqual(["plan_authorization"]);
    after.prepare("UPDATE plan_authorization SET basis = 'mode'").run();
    after.prepare("UPDATE flow_trigger_event SET on_time = 1").run();
    expect(changedHistory(after, before)).toEqual(["flow_trigger_event"]);
    after.prepare("UPDATE flow_trigger_event SET on_time = 0, ran_script = 'abc'").run();
    expect(changedHistory(after, before)).toEqual(["flow_trigger_event"]);
    after.prepare("UPDATE flow_trigger_event SET ran_script = NULL").run();
  } finally { after.close(); }
  // Opening again changes nothing (the file is current), and the new columns and tables take writes.
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(136);
  expect(store.recordFlowTriggerEvent(trigger, "slot-2", null, null, now, null, true, "d".repeat(64))).toBe(true);
  expect(store.handle.prepare("SELECT on_time, ran_script FROM flow_trigger_event WHERE trigger = ? AND key = 'slot-2'").get(trigger)).toEqual({ on_time: 1, ran_script: "d".repeat(64) });
  expect(store.swapToolSecretKeyDigest(null, "e".repeat(64), now)).toBe(true);
  expect(store.toolSecretKeyDigest()).toBe("e".repeat(64));
});
