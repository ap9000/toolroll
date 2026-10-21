/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V122_ADDED_COLUMNS, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

/** v122's new tables (fresh base's branch moves). */
const V122_TABLES = ["branch_base_move"];

test.each([121, -121])("v%s: a project's recorded remote and fresh base's branch moves are added; saved projects read no remote", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v122-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-12T12:00:00.000Z");
  const first = openStore(file);
  first.upsertProject("/projects/shop", "shop", now);
  first.createTask({ id: "t-1", title: "a task" }, now);
  const ref = first.refFor(BUILT_IN, "t-1").id;
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v121 shape: no project.remote_url, no branch_base_move.
  const db = new DatabaseSync(file);
  db.exec("DROP INDEX branch_base_move_branch");
  for (const table of V122_TABLES) db.exec(`DROP TABLE ${table}`);
  for (const [table, columns] of Object.entries(V122_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(121)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(122);
  expect(SCHEMA_VERSION).toBe(128);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(128);
  expect(store.handle.prepare("PRAGMA table_info(project)").all().map(row => row["name"])).toContain("remote_url");
  expect(store.projectRemote("/projects/shop")).toBeNull();
  for (const table of V122_TABLES) expect(store.handle.prepare("SELECT count(*) AS n FROM " + table).get()?.["n"]).toBe(0);
  expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'branch_base_move_branch'").get()).toBeDefined();
  expect(store.latestBranchBaseMove(ref, "toolroll/t-1")).toBeNull();
  expect(store.listProjects()).toMatchObject([{ path: "/projects/shop", name: "shop", remoteUrl: null }]);
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try {
    expect(changedHistory(after, before)).toEqual([]);
    // The rehearsal notices a saved project that does not read the declared default.
    after.prepare("UPDATE project SET remote_url = 'https://example.com/shop.git'").run();
    expect(changedHistory(after, before)).toEqual(["project"]);
    after.prepare("UPDATE project SET remote_url = NULL").run();
  } finally { after.close(); }
  // Opening again changes nothing (the file is current), and an owner's admission records the remote.
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(128);
  store.upsertProject("/projects/shop", "shop", now, { remoteUrl: "https://example.com/shop.git" });
  expect(store.projectRemote("/projects/shop")).toBe("https://example.com/shop.git");
  store.recordBranchBaseMove(ref, "toolroll/t-1", "a".repeat(40), "b".repeat(40), now);
  expect(store.latestBranchBaseMove(ref, "toolroll/t-1")).toMatchObject({ from: "a".repeat(40), to: "b".repeat(40), afterRun: 0 });
});
