/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V126_ADDED_COLUMNS, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

const INBOX = JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] });
const columnsOf = (s: Store, table: string) => s.handle.prepare(`PRAGMA table_info(${table})`).all().map(row => row["name"]);

test.each([125, -125])("v%s: signed-webhook receipts and task sources are added; saved receipts read their state from their card, saved cards a person's", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v126-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-19T12:00:00.000Z");
  const first = openStore(file);
  const flow = first.createFlow({ repo: "/projects/shop", name: "Errors", by: "alex", definitionJson: INBOX }, now);
  const trigger = first.addFlowTrigger({ flow, kind: "github", configJson: "{}", hookHash: "h", cursor: null, nextAt: null, by: "alex" }, now);
  const card = first.addFlowCard({ flow, title: "An issue", description: null, stage: "inbox", by: "GitHub", byKind: "automation" }, now);
  expect(first.recordFlowTriggerEvent(trigger, "issue:1", card, null, now)).toBe(true);
  expect(first.recordFlowTriggerEvent(trigger, "issue:2", null, "it looked like it held a key or password", now)).toBe(true);
  first.close();
  // The v125 shape: no receipt state, acceptance time or held item; no credential generation or turned-away count; no
  // card maker kind; no task sources.
  const db = new DatabaseSync(file);
  db.exec("DROP INDEX flow_trigger_event_accepted");
  db.exec("DROP TABLE task_source");
  for (const [table, columns] of Object.entries(V126_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(125)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(126);
  expect(SCHEMA_VERSION).toBe(142);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(142);
  for (const [table, columns] of Object.entries(V126_ADDED_COLUMNS)) expect(columnsOf(store, table)).toEqual(expect.arrayContaining(Object.keys(columns)));
  expect(store.handle.prepare("SELECT count(*) AS n FROM task_source").get()?.["n"]).toBe(0);
  expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'flow_trigger_event_accepted'").get()).toBeDefined();
  // A saved receipt reads accepted with its card and skipped without; neither holds anything.
  expect(store.flowReceipt(trigger, "issue:1")).toMatchObject({ state: "accepted", card, acceptedAt: null, itemJson: null });
  expect(store.flowReceipt(trigger, "issue:2")).toMatchObject({ state: "skipped", card: null });
  // A saved card counts toward the hourly limit at its arrival.
  expect(store.flowCardsAcceptedSince(trigger, new Date(now.getTime() - 60_000))).toBe(1);
  // A saved trigger is on its first credential generation, with nothing turned away; a saved card was a person's.
  expect(store.getFlowTrigger(trigger)).toMatchObject({ hookCredential: "legacy", droppedCount: 0, droppedSince: null });
  expect(store.getFlowCard(card)?.createdKind).toBe("person");
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
  // Opening again changes nothing.
  store = openStore(file);
  expect(store.flowReceipt(trigger, "issue:1")?.state).toBe("accepted");
});

test("a task's source is immutable once written", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v126-"));
  store = openStore(join(dir, "state.db"));
  store.handle.prepare("INSERT INTO task_source (task_id, flow, card, card_entry, source_json, at) VALUES ('t-1', 1, 1, 1, '{}', 't')").run();
  expect(() => store!.handle.prepare("UPDATE task_source SET source_json = '{\"kind\":\"other\"}' WHERE task_id = 't-1'").run()).toThrow(/immutable/);
});
