/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([95, -95])("v%s: a subagent carries over whole and gets a desk only when first needed", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v96-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-26T10:00:00.000Z");
  const first = openStore(file);
  const mate = first.createSubagent({ repo: "/r", handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, now);
  first.close();
  // The v95 shape: no desk column.
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`CREATE TABLE subagent_old (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, handle TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','paused','removed')), version INTEGER NOT NULL,
    soul TEXT NOT NULL, model TEXT, daily_turns INTEGER NOT NULL DEFAULT 200, manager TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, summary_at TEXT)`);
  db.exec("INSERT INTO subagent_old SELECT id, repo, handle, state, version, soul, model, daily_turns, manager, created_by, created_at, updated_by, updated_at, summary_at FROM subagent");
  db.exec("DROP TABLE subagent; ALTER TABLE subagent_old RENAME TO subagent; CREATE UNIQUE INDEX subagent_live ON subagent (repo, handle) WHERE state <> 'removed'");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(117);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(117);
  expect(store.getSubagent(mate)).toMatchObject({ handle: "maya", manager: "alex", deskFlow: null });
  const flow = store.createFlow({ repo: "/r", name: "Maya's desk", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }), by: "alex" }, now);
  store.setSubagentDesk(mate, flow);
  expect(store.getSubagent(mate)?.deskFlow).toBe(flow);
});
