/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { flowFromSteps } from "./flows.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

/** The v88 shape of flow_trigger: every kind but email and chat. */
const V88 = `CREATE TABLE flow_trigger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  flow         INTEGER NOT NULL REFERENCES flow(id),
  kind         TEXT NOT NULL CHECK (kind IN ('button','schedule','github','linear','flow','webhook')),
  config_json  TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active','paused','removed')),
  hook_hash    TEXT UNIQUE,
  cursor       TEXT,
  next_at      TEXT,
  last_at      TEXT,
  last_outcome TEXT,
  failures     INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
)`;

test.each([88, -88])("v%s: flow_trigger admits email and chat, keeping every trigger, its id and what it saw", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v89-"));
  const file = join(dir, "state.db");
  store = openStore(file);
  const now = new Date("2026-09-25T10:00:00Z");
  const flow = store.createFlow({ repo: "/fixture/shop", name: "Support", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, now);
  store.close(); store = undefined;
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("DROP TABLE flow_trigger");
  db.exec(V88);
  db.exec("CREATE INDEX flow_trigger_live ON flow_trigger (flow, state)");
  db.prepare("INSERT INTO flow_trigger (id, flow, kind, config_json, state, hook_hash, cursor, created_by, created_at, updated_at) VALUES (7, ?, 'webhook', '{}', 'active', 'hash-7', NULL, 'alex', ?, ?)").run(flow, now.toISOString(), now.toISOString());
  db.prepare("INSERT INTO flow_trigger_event (trigger, key, card, note, at) VALUES (7, 'delivery:1', NULL, 'seen', ?)").run(now.toISOString());
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = db.prepare("SELECT * FROM flow_trigger").all();
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(114);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(SCHEMA_VERSION);
  expect(store.handle.prepare("SELECT * FROM flow_trigger").all()).toEqual(before);
  expect(store.flowTriggerSaw(7, "delivery:1")).toBe(true);
  // The new kinds go in; ids carry on after the kept one; nothing points nowhere.
  const email = store.addFlowTrigger({ flow, kind: "email", configJson: JSON.stringify({ kind: "email", folder: "INBOX", sender: null, subject: null, zone: null }), hookHash: null, cursor: null, nextAt: now.toISOString(), by: "alex" }, now);
  expect(email).toBe(8);
  expect(() => store!.handle.prepare("INSERT INTO flow_trigger (flow, kind, config_json, state, created_by, created_at, updated_at) VALUES (?, 'fax', '{}', 'active', 'alex', 'x', 'x')").run(flow)).toThrow(/CHECK/);
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name='flow_trigger_live'").get()).toBeDefined();
  store.close(); store = openStore(file);
  expect(store.flowTriggers(flow).map(one => one.kind)).toEqual(expect.arrayContaining(["webhook", "email"]));
});
