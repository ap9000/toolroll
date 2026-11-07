/**
 * Schema v153: Phase 2's tables and columns. Saved rows read their declared defaults; a fresh database, an upgrade from
 * v151 (and one stopped mid-way) and a crash after any step all end the same.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V153_ADDED_COLUMNS, V153_STEPS, type MigrationStep, type Store } from "./store.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const TABLES = ["vanished_charge", "retry_episode", "check_authorization", "builder_service", "builder_restart", "fast_preview"];
let dir: string | undefined;
const open: Store[] = [];
afterEach(() => { for (const one of open.splice(0)) { try { one.close(); } catch { /* closed */ } } if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const opened = (store: Store): Store => { open.push(store); return store; };

/** A v151 database with a saved task and project. */
function v151Fixture(version: 151 | -151): string {
  dir ??= mkdtempSync(join(tmpdir(), "so-v153-"));
  const file = join(dir, `v151-${version < 0 ? "mid" : "at"}.db`);
  const first = openStore(file);
  first.createTask({ id: "saved", title: "saved" }, NOW);
  first.upsertProject("/repos/shop", "shop", NOW);
  first.close();
  const db = new DatabaseSync(file);
  for (const table of TABLES) db.exec(`DROP TABLE ${table}`);
  for (const [table, columns] of Object.entries(V153_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  return file;
}
const shape = (store: Store) => ({ tables: TABLES.map(name => store.handle.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name)?.["name"]),
  ref: store.handle.prepare("SELECT fast_start_at, fast_start_until FROM task_ref WHERE external_id = 'saved'").get(),
  project: store.handle.prepare("SELECT fast_start FROM project WHERE path = '/repos/shop'").get() });

describe("v153", () => {
  test("an upgrade adds the tables, and a saved row reads NULL", () => {
    const store = opened(openStore(v151Fixture(151)));
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(shape(store)).toEqual({ tables: TABLES, ref: { fast_start_at: null, fast_start_until: null }, project: { fast_start: null } });
  });

  test("a resumed upgrade ends the same, and a crash after any step resumes", () => {
    expect(shape(opened(openStore(v151Fixture(-151)))).tables).toEqual(TABLES);
    for (const stop of V153_STEPS) {
      dir = mkdtempSync(join(tmpdir(), "so-v153-"));
      const file = v151Fixture(151);
      expect(() => openStore(file, { migrationStep: (step: MigrationStep) => { if (step === stop) throw new Error("power cut"); } })).toThrow("power cut");
      expect(shape(opened(openStore(file))).tables).toEqual(TABLES);
    }
  });

  test("the update may run it in place", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(153);
    expect(updateSafeSchema(151)).toBe(true);
  });
});
