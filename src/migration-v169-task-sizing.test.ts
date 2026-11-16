/** v169: task sizing by a quick model call. A new table and one new column only: no saved row changes, an upgraded file
 * reads off (no row), a saved size reads no classifier, a crash after either step resumes to the same shape, and a table
 * in a shape this build can't name refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V169_STEPS } from "./store.js";
import { V169_TABLES } from "./task-sizing-schema.js";
import { taskSizingSetting } from "./task-sizing.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-16T00:00:00.000Z");

/** A v168 file: made by this build with an approver and a sized task, then the v169 table and column taken away and the
 * version put back. */
function v168File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v169-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", T0);
  made.createTask({ id: "sized", title: "sized" }, T0);
  made.writeSizing(made.lookupRef("sized")!.id, { size: "small", risky: false, source: "heuristic", reason: "short and focused" });
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V169_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("ALTER TABLE task_ref DROP COLUMN size_by");
  raw.exec("UPDATE schema_version SET version = 168");
  raw.close();
  return file;
}
const version = (store: ReturnType<typeof openStore>) => store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];

describe("v169", () => {
  test("fresh: the table, no row (off), update-safe", () => {
    expect(SCHEMA_VERSION).toBe(170);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(169);
    expect(updateSafeSchema(168)).toBe(true);
    expect(V169_STEPS).toEqual(["task-sizing-setting", "task-sizing-columns"]);
    const fresh = openStore(":memory:");
    expect(fresh.handle.prepare("SELECT COUNT(*) AS n FROM task_sizing_setting").get()?.["n"]).toBe(0);
    expect(taskSizingSetting(fresh, () => null)).toMatchObject({ on: false, chosen: false, sizer: null });
    fresh.close();
  });

  test("an upgrade adds the table and the column, changes no saved row, and reads off", () => {
    const file = v168File();
    const upgraded = openStore(file);
    try {
      expect(version(upgraded)).toBe(170);
      expect(taskSizingSetting(upgraded, () => null).on).toBe(false);
      expect(upgraded.lookupRef("sized")!.sizing).toEqual({ size: "small", risky: false, source: "heuristic", reason: "short and focused" });
      expect(upgraded.handle.prepare("SELECT size_by FROM task_ref").get()?.["size_by"]).toBeNull();
    } finally { upgraded.close(); }
  });

  test.each(["task-sizing-setting", "task-sizing-columns"])("a crash after %s resumes to the same shape", step => {
    const file = v168File();
    expect(() => openStore(file, { migrationStep: one => { if (one === step) throw new Error("crash"); } })).toThrow(/crash/);
    const resumed = openStore(file);
    try {
      expect(version(resumed)).toBe(170);
      expect(resumed.handle.prepare("SELECT COUNT(*) AS n FROM task_sizing_setting").get()?.["n"]).toBe(0);
    } finally { resumed.close(); }
  });

  test("a table in a shape this build can't name refuses to open, at v169 too", () => {
    const file = v168File();
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE task_sizing_setting");
    raw.exec("CREATE TABLE task_sizing_setting (id INTEGER PRIMARY KEY, enabled INTEGER, sizer TEXT, updated_by TEXT, updated_at TEXT)");
    raw.close();
    expect(() => openStore(file)).toThrow(/task sizing table has an unknown shape/);
  });
});
