/**
 * Schema v152: the code map's tables, a project's switch and the run-id watermark. A saved project reads on and not
 * enrolled; a fresh database, an upgrade from v151 (and one stopped mid-way) and a crash after each step all end the same.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { V152_ADDED_COLUMNS, V152_TABLES, V152_TRIGGERS } from "./code-map-store.js";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V152_STEPS, type MigrationStep, type Store } from "./store.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
let dir: string | undefined;
const open: Store[] = [];
afterEach(() => { for (const one of open.splice(0)) { try { one.close(); } catch { /* closed */ } } if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const opened = (store: Store): Store => { open.push(store); return store; };

function v151Fixture(version: 151 | -151): string {
  dir ??= mkdtempSync(join(tmpdir(), "so-v152-"));
  const file = join(dir, `v151-${version < 0 ? "mid" : "at"}.db`);
  const first = openStore(file);
  first.upsertProject("/repo/shop", "shop", NOW, { remoteUrl: "https://git.example/shop.git" });
  first.close();
  const db = new DatabaseSync(file);
  for (const trigger of V152_TRIGGERS) db.exec(`DROP TRIGGER ${trigger}`);
  for (const table of [...V152_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
  for (const column of Object.keys(V152_ADDED_COLUMNS["project"]!)) db.exec(`ALTER TABLE project DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  return file;
}
const projectRow = (store: Store) => ({ ...store.handle.prepare("SELECT code_map, code_map_enroll_until FROM project").get() });
const meta = (store: Store) => Number(store.handle.prepare("SELECT run_watermark FROM code_map_meta").get()!["run_watermark"]);

describe("v152: the code map", () => {
  test("a fresh database has every table and trigger, and a zero watermark set once", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v152-"));
    const store = opened(openStore(join(dir, "fresh.db")));
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(meta(store)).toBe(0);
    expect(() => store.handle.exec("UPDATE code_map_meta SET run_watermark = 5")).toThrow(/once/);
    expect(() => store.handle.exec("DELETE FROM code_map_meta")).toThrow(/once/);
  });
  test("a saved project reads on and not enrolled, and the update may run it in place", () => {
    const store = opened(openStore(v151Fixture(151)));
    expect(projectRow(store)).toEqual({ code_map: 1, code_map_enroll_until: null });
    expect(UPDATE_SAFE_MIGRATIONS).toContain(152);
    expect(updateSafeSchema(151)).toBe(true);
  });
  test("an upgrade stopped mid-way resumes", () => {
    const store = opened(openStore(v151Fixture(-151)));
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(projectRow(store)).toEqual({ code_map: 1, code_map_enroll_until: null });
  });
  test.each(V152_STEPS.map(step => [step]))("a crash after %s resumes on the next open, to the rows an uninterrupted migration makes", (step: MigrationStep) => {
    const file = v151Fixture(151);
    const crashed = `${file}.crashed`;
    copyFileSync(file, crashed);
    const clean = opened(openStore(file));
    expect(() => openStore(crashed, { migrationStep: finished => { if (finished === step) throw new Error("stop"); } })).toThrow("stop");
    const resumed = opened(openStore(crashed));
    expect(projectRow(resumed)).toEqual(projectRow(clean));
    expect(meta(resumed)).toBe(meta(clean));
  });
  test("a current store missing a table refuses to open: its map couldn't be trusted", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v152-"));
    const file = join(dir, "broken.db");
    openStore(file).close();
    const db = new DatabaseSync(file);
    db.exec("DROP TRIGGER code_map_snapshot_no_update");
    db.close();
    expect(() => openStore(file)).toThrow(/code map trigger code_map_snapshot_no_update is missing/);
  });
});
