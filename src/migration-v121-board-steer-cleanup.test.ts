/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attemptKeyOf } from "./agent-board.js";
import { BUILT_IN, openStore, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V121_ADDED_COLUMNS, verifiedAuthor, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

/** v121's new tables, children before the tables they reference. */
const V121_TABLES = ["agent_turn", "agent_now", "agent_question", "agent_seen", "agent_view", "landed_cleanup_item", "landed_cleanup", "run_pause", "run_resume"];
const route = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };

test.each([120, -120])("v%s: the Agents board, live steering and landed cleanup are added; saved runs read keyless and saved notes as never sent", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v121-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-11T12:00:00.000Z");
  const first = openStore(file);
  first.createTask({ id: "t-1", title: "a steered task" }, now);
  const ref = first.refFor(BUILT_IN, "t-1").id;
  first.placeTask(ref, "/projects/shop");
  const run = first.startRun({ taskRef: ref, leaseId: "lease-1", runner: "builder-1", branch: "feat/a", worktree: dir, provider: "claude", now, ...route });
  first.fileSteerNote("t-1", verifiedAuthor("alex"), "prefer the smaller diff", now);
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v120 shape: none of v121's tables or columns.
  const db = new DatabaseSync(file);
  for (const index of ["agent_board_open", "agent_board_recent", "agent_board_repair"]) db.exec(`DROP INDEX ${index}`);
  for (const table of V121_TABLES) db.exec(`DROP TABLE ${table}`);
  for (const [table, columns] of Object.entries(V121_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(120)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(121);
  store = openStore(file);
  const handle = store.handle;
  expect(handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(135);
  for (const table of V121_TABLES) expect(handle.prepare("SELECT count(*) AS n FROM " + table).get()?.["n"]).toBe(0);
  expect(attemptKeyOf(store, run)).toBeNull();
  expect(handle.prepare("SELECT live_input_opened_at, live_input_closed_at, live_pause_limit_ms FROM run WHERE id = ?").get(run))
    .toMatchObject({ live_input_opened_at: null, live_input_closed_at: null, live_pause_limit_ms: null });
  expect(store.listSteerNotes(ref)).toMatchObject([{ note: "prefer the smaller diff", liveUuid: null, liveSends: 0, liveSentAt: null, liveMissedAt: null }]);
  expect(store.pausesForTask(ref)).toEqual([]);
  expect(store.resumesForTask(ref)).toEqual([]);
  expect(handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try {
    expect(changedHistory(after, before)).toEqual([]);
    // The rehearsal notices a saved run that does not read the declared default.
    after.prepare("UPDATE run SET attempt_key = 'x' WHERE id = ?").run(run);
    expect(changedHistory(after, before)).toEqual(["run"]);
    after.prepare("UPDATE run SET attempt_key = NULL WHERE id = ?").run(run);
  } finally { after.close(); }
  // Opening again changes nothing (the file is current), and what is admitted or filed now carries the new identities.
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(135);
  const later = store.startRun({ taskRef: ref, leaseId: "lease-2", runner: "builder-1", branch: "feat/a", worktree: dir, provider: "claude", now, ...route });
  expect(attemptKeyOf(store, later)).toMatch(/^[0-9a-f]{24}$/);
  store.fileSteerNote("t-1", verifiedAuthor("alex"), "and keep the API", now);
  expect(store.listSteerNotes(ref)[1]!.liveUuid).toMatch(/^[0-9a-f-]{36}$/);
});
