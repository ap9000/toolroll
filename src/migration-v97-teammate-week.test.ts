/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([96, -96])("v%s: a teammate's calls carry over whole; turns start being counted, and calls can be undone", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v97-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-26T10:00:00.000Z");
  const first = openStore(file);
  const flow = first.createFlow({ repo: "/r", name: "Support", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }), by: "alex" }, now);
  const card = first.addFlowCard({ flow, title: "Label it", description: null, stage: "inbox", by: "alex" }, now);
  const mate = first.createTeammate({ repo: "/r", handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, now);
  const call = first.addTeammateCall({ teammate: mate, card, entry: 1, tool: "desk", action: "add_label", input: { ticket: "T-1" }, rule: "free", why: "Urgent.", state: "done", result: "added" }, now);
  first.close();
  // The v96 shape: no turn log, no undo columns, no weekly stamp.
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DROP TABLE teammate_turn");
  db.exec(`CREATE TABLE teammate_call_old (id INTEGER PRIMARY KEY AUTOINCREMENT, teammate INTEGER NOT NULL REFERENCES teammate(id), card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL, tool TEXT NOT NULL,
    action TEXT NOT NULL, input_json TEXT NOT NULL, rule TEXT NOT NULL CHECK (rule IN ('free','ask','never')), why TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('asked','approved','denied','refused','running','done','failed')), result TEXT, decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL, done_at TEXT)`);
  db.exec("INSERT INTO teammate_call_old SELECT id, teammate, card, entry, tool, action, input_json, rule, why, state, result, decided_by, decided_at, created_at, done_at FROM teammate_call");
  db.exec("DROP TABLE teammate_call; ALTER TABLE teammate_call_old RENAME TO teammate_call");
  db.exec(`CREATE TABLE teammate_old (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, handle TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','paused','removed')), version INTEGER NOT NULL,
    soul TEXT NOT NULL, model TEXT, daily_turns INTEGER NOT NULL DEFAULT 200, manager TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, summary_at TEXT,
    desk_flow INTEGER REFERENCES flow(id))`);
  db.exec("INSERT INTO teammate_old SELECT id, repo, handle, state, version, soul, model, daily_turns, manager, created_by, created_at, updated_by, updated_at, summary_at, desk_flow FROM teammate");
  db.exec("DROP TABLE teammate; ALTER TABLE teammate_old RENAME TO teammate; CREATE UNIQUE INDEX teammate_live ON teammate (repo, handle) WHERE state <> 'removed'");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(112);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(112);
  expect(store.teammateCall(call)).toMatchObject({ action: "add_label", state: "done", undoOf: null, undoneBy: null });
  expect(store.getTeammate(mate)).toMatchObject({ weeklyAt: null, deskFlow: null });
  store.addTeammateTurn({ teammate: mate, card, model: "default", ok: true, ms: 4000, costUsd: 0.01 }, now);
  expect(store.teammateTurns(mate, "2026-01-01")).toMatchObject([{ costUsd: 0.01, ok: true }]);
  expect(store.markTeammateCallUndone(call, "alex", now)).toBe(true);
});
