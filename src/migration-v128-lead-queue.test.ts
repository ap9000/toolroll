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

test("v128: the personal lead queue and lead_message.pending are added; a saved message waits exactly when a team queue holds it unadmitted", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v128-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-20T12:00:00.000Z");
  const first = openStore(file);
  first.createTask({ id: "t-1", title: "kept" }, now);
  first.close();
  // The v127 shape: no queue table, no pending column or history index; then one message of each kind.
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  db.exec("DROP TABLE lead_queue; DROP INDEX lead_message_history; ALTER TABLE lead_message DROP COLUMN pending");
  db.prepare("UPDATE schema_version SET version = ?").run(127);
  const at = now.toISOString();
  db.prepare("INSERT INTO lead_thread (id, approver, ceiling_digest, opened_at) VALUES (1, 'alex', 'c', ?)").run(at);
  const message = (id: number, turn: number | null, role: "operator" | "assistant", text: string) =>
    db.prepare("INSERT INTO lead_message (id, thread, turn, role, text, created_at) VALUES (?, 1, ?, ?, ?, ?)").run(id, turn, role, text, at);
  message(1, 7, "operator", "an ordinary admitted message");
  message(2, 7, "assistant", "its reply");
  message(3, null, "operator", "a mirrored channel question (no queue row)");
  message(4, null, "assistant", "a mirrored channel answer");
  message(5, null, "operator", "a team message still waiting");
  message(6, 8, "operator", "a team message its turn took");
  message(7, null, "operator", "a team message cancelled before it ran");
  const team = (id: number, status: string, turn: number | null) =>
    db.prepare("INSERT INTO team_message (message, conversation, author, author_generation, lead_member_revision, participant_revision, request_id, payload_hash, status, turn_id) VALUES (?, 'c1', 'alex', 1, 1, 1, ?, 'h', ?, ?)").run(id, `r${id}`, status, turn);
  team(5, "queued", null);
  team(6, "answered", 8);
  team(7, "cancelled", null);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(127)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(128);
  expect(SCHEMA_VERSION).toBe(132);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(132);
  const pending = Object.fromEntries((store.handle.prepare("SELECT id, pending FROM lead_message ORDER BY id").all() as { id: number; pending: number }[]).map(row => [row.id, row.pending]));
  expect(pending).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: 0, 7: 1 });
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM lead_queue").get()?.["n"]).toBe(0);
  // The model's history reads through the index, whatever waits.
  const plan = store.handle.prepare("EXPLAIN QUERY PLAN SELECT id FROM lead_message WHERE thread = ? AND pending = 0 ORDER BY id DESC LIMIT 40").all(1)
    .map(row => String(row["detail"])).join(" ");
  expect(plan).toContain("lead_message_history");
  expect(store.getTask("t-1")?.title).toBe("kept");
  store.close();
  store = undefined;
  // Every saved row reads what V128_ADDED_COLUMNS declares, and nothing else moved: the update check sees no change.
  const after = new DatabaseSync(file);
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
});
