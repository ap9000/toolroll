/** v156: fallback chains add three tables and change no saved row. docs/plans/fallback-chains.md. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V156_STEPS } from "./store.js";
import { V156_TABLES } from "./fallback-schema.js";
import { FINDING_SOURCES, FINDING_SOURCES_BEFORE_LEAD } from "./fleet-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("v156", () => {
  test("a fresh database has the tables; a v154 one gains them, keeps its rows, and may update in place", () => {
    const fresh = openStore(":memory:");
    const has = (handle: { prepare(sql: string): { all(): unknown[] } }) => (handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(one => one.name);
    for (const table of V156_TABLES) expect(has(fresh.handle)).toContain(table);
    fresh.close();
    expect(SCHEMA_VERSION).toBe(158);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(156);
    expect(updateSafeSchema(154)).toBe(true);
    expect(V156_STEPS).toEqual(["fallback-tables"]);

    const dir = mkdtempSync(join(tmpdir(), "toolroll-v156-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    const made = openStore(file);
    made.createTask({ id: "kept", title: "kept" }, new Date("2026-11-01T00:00:00.000Z"));
    made.close();
    const raw = new DatabaseSync(file);
    for (const table of V156_TABLES) raw.exec(`DROP TABLE ${table}`);
    raw.exec("UPDATE schema_version SET version = 154");
    raw.close();

    const upgraded = openStore(file);
    for (const table of V156_TABLES) expect(has(upgraded.handle)).toContain(table);
    expect(upgraded.getTask("kept")?.title).toBe("kept");
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(158);
    upgraded.close();
    // A second open changes nothing.
    const again = openStore(file);
    expect(again.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(158);
    again.close();
  });

  test("a v155 database, with the first v155 builds' finding CHECK, goes to v156: widened, fallback tables added, rows kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v156-from-155-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    const made = openStore(file);
    made.createTask({ id: "kept", title: "kept" }, new Date("2026-11-01T00:00:00.000Z"));
    made.close();
    const raw = new DatabaseSync(file);
    for (const table of V156_TABLES) raw.exec(`DROP TABLE ${table}`);
    const sql = String(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'finding'").get()!["sql"]);
    raw.exec("PRAGMA foreign_keys = OFF; BEGIN");
    raw.exec(sql.replace(FINDING_SOURCES, FINDING_SOURCES_BEFORE_LEAD).replace(/^CREATE TABLE (?:IF NOT EXISTS )?finding/, "CREATE TABLE finding_old"));
    raw.exec("INSERT INTO finding_old SELECT * FROM finding; DROP TABLE finding; ALTER TABLE finding_old RENAME TO finding; CREATE INDEX finding_family ON finding (family_root, state); COMMIT");
    raw.exec("UPDATE schema_version SET version = 155");
    raw.close();

    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining(["finding-sources", "fallback-tables"]));
    expect(String(upgraded.handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'finding'").get()!["sql"])).toContain(FINDING_SOURCES);
    const names = (upgraded.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(one => one.name);
    for (const table of V156_TABLES) expect(names).toContain(table);
    expect(upgraded.getTask("kept")?.title).toBe("kept");
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(158);
    upgraded.close();
  });
});
