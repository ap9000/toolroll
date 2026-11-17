/** v171: interactive agent threads' switch (flexible-available.ts). A new table only: no saved row changes, a fresh file
 * and an upgraded one read off (no row) until a person turns them on, a crash after the step resumes to the same shape,
 * and a table in a shape this build can't name refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V171_STEPS } from "./store.js";
import { V171_TABLES } from "./flexible-setting-schema.js";
import { flexibleAvailable, flexibleSetting } from "./flexible-available.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-16T00:00:00.000Z");

/** A v170 file: made by this build with an approver and a task, then the v171 table taken away and the version put back. */
function v170File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v171-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", T0);
  made.createTask({ id: "kept", title: "kept" }, T0);
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V171_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 170");
  raw.close();
  return file;
}
const version = (store: ReturnType<typeof openStore>) => store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];

describe("v171", () => {
  test("fresh: the table, no row, so interactive agent threads are off; update-safe", () => {
    expect(SCHEMA_VERSION).toBe(171);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(171);
    expect(updateSafeSchema(170)).toBe(true);
    expect(V171_STEPS).toEqual(["flexible-setting"]);
    const fresh = openStore(":memory:");
    expect(fresh.handle.prepare("SELECT COUNT(*) AS n FROM flexible_setting").get()?.["n"]).toBe(0);
    expect(flexibleAvailable(fresh)).toBe(false);
    expect(flexibleSetting(fresh)).toEqual({ on: false, by: null, at: null });
    fresh.close();
  });

  test("an upgrade adds the table, changes no saved row, and reads off", () => {
    const file = v170File();
    const upgraded = openStore(file);
    try {
      expect(version(upgraded)).toBe(171);
      expect(flexibleAvailable(upgraded)).toBe(false);
      expect(upgraded.handle.prepare("SELECT COUNT(*) AS n FROM flexible_setting").get()?.["n"]).toBe(0);
      expect(upgraded.lookupRef("kept")).not.toBeNull();
    } finally { upgraded.close(); }
  });

  test("a crash after the step resumes to the same shape, still off", () => {
    const file = v170File();
    expect(() => openStore(file, { migrationStep: one => { if (one === "flexible-setting") throw new Error("crash"); } })).toThrow(/crash/);
    const resumed = openStore(file);
    try {
      expect(version(resumed)).toBe(171);
      expect(flexibleAvailable(resumed)).toBe(false);
    } finally { resumed.close(); }
  });

  test("a table in a shape this build can't name refuses to open, at v171 too; a row that isn't exactly on reads off", () => {
    const file = v170File();
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE flexible_setting");
    raw.exec("CREATE TABLE flexible_setting (id INTEGER PRIMARY KEY, enabled INTEGER, updated_by TEXT, updated_at TEXT)");
    raw.close();
    expect(() => openStore(file)).toThrow(/interactive agent threads setting table has an unknown shape/);
    // The reader alone (a database opened before the table existed, or a value no build writes): off.
    const loose = new DatabaseSync(":memory:");
    expect(flexibleAvailable({ handle: loose as never })).toBe(false);
    loose.exec("CREATE TABLE flexible_setting (id INTEGER PRIMARY KEY, enabled, updated_by TEXT, updated_at TEXT)");
    loose.exec("INSERT INTO flexible_setting VALUES (1, '1', 'x', 'y')");
    expect(flexibleAvailable({ handle: loose as never })).toBe(false);
    loose.close();
  });
});
