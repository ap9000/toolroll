/** v187: automatic updates' switch and per-version attempts (auto-update-schema.ts). New tables only: no saved row
 * changes, a fresh file and an upgraded one read off (no row) until a person turns it on, a crash after the step resumes
 * to the same shape, a table in a shape this build can't name refuses to open, attempts are written once and kept, and a
 * policy the reader can't name reads as unreadable (callers fail closed). */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V187_STEPS } from "./store.js";
import { V187_TABLES } from "./auto-update-schema.js";
import { autoUpdatePolicy } from "./auto-update.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-26T00:00:00.000Z");

/** A v186 file: made by this build with an approver and a task, then the v187 tables taken away and the version put back. */
function v186File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v187-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", T0);
  made.createTask({ id: "kept", title: "kept" }, T0);
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V187_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 186");
  raw.close();
  return file;
}
const version = (store: ReturnType<typeof openStore>) => store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];
const attempt = (store: ReturnType<typeof openStore>, version: string) =>
  store.handle.prepare("INSERT INTO auto_update_attempt (version, from_version, enabled_by, policy_revision, reserved_at) VALUES (?, '0.9.120', 'alex', 1, ?)").run(version, T0.toISOString());

describe("v187", () => {
  test("fresh: the tables, no rows, so automatic updates are off; update-safe", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(187);
    expect(updateSafeSchema(186)).toBe(true);
    expect(V187_STEPS).toEqual(["auto-update"]);
    const fresh = openStore(":memory:");
    for (const table of V187_TABLES) expect(fresh.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    expect(autoUpdatePolicy(fresh)).toEqual({ on: false, revision: 0, by: null, at: null });
    fresh.close();
  });

  test("an upgrade adds the tables, changes no saved row, and reads off", () => {
    const upgraded = openStore(v186File());
    try {
      expect(version(upgraded)).toBe(SCHEMA_VERSION);
      expect(autoUpdatePolicy(upgraded)).toEqual({ on: false, revision: 0, by: null, at: null });
      expect(upgraded.lookupRef("kept")).not.toBeNull();
    } finally { upgraded.close(); }
  });

  test("a crash after the step resumes to the same shape, still off", () => {
    const file = v186File();
    expect(() => openStore(file, { migrationStep: one => { if (one === "auto-update") throw new Error("crash"); } })).toThrow(/crash/);
    const resumed = openStore(file);
    try {
      expect(version(resumed)).toBe(SCHEMA_VERSION);
      expect(autoUpdatePolicy(resumed)?.on).toBe(false);
    } finally { resumed.close(); }
  });

  test("a table in a shape this build can't name refuses to open", () => {
    const file = v186File();
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("DROP TRIGGER auto_update_attempt_no_delete");
    raw.close();
    expect(() => openStore(file)).toThrow(/automatic updates trigger auto_update_attempt_no_delete is missing/);
  });

  test("one attempt per version; each later field is written once; nothing is deleted; only stable versions", () => {
    const store = openStore(":memory:");
    try {
      attempt(store, "0.9.121");
      expect(() => attempt(store, "0.9.121")).toThrow(/UNIQUE/);
      for (const bad of ["0.9.121-beta.1", "nightly", "1.2"]) expect(() => attempt(store, bad), bad).toThrow(/CHECK/);
      const set = (sql: string) => store.handle.prepare(`UPDATE auto_update_attempt SET ${sql} WHERE version = '0.9.121'`).run();
      set(`journal_id = '${"a".repeat(8)}-aaaa-aaaa-aaaa-${"a".repeat(12)}'`);
      expect(() => set(`journal_id = '${"b".repeat(8)}-bbbb-bbbb-bbbb-${"b".repeat(12)}'`)).toThrow(/written once/);
      set("outcome = 'restored', outcome_at = 'now', detail = 'it failed its health check'");
      for (const change of ["outcome = 'complete'", "detail = 'other'", "outcome = NULL", "version = '0.9.122'", "enabled_by = 'someone'", "policy_revision = 9"]) expect(() => set(change), change).toThrow(/written once/);
      expect(() => store.handle.prepare("DELETE FROM auto_update_attempt").run()).toThrow(/kept/);
    } finally { store.close(); }
  });

  test("the reader fails closed on a policy it can't name", () => {
    const loose = new DatabaseSync(":memory:");
    expect(autoUpdatePolicy({ handle: loose as never })).toBeNull();
    loose.exec("CREATE TABLE auto_update_policy (id INTEGER, enabled, revision, updated_by TEXT, updated_at TEXT)");
    loose.exec("INSERT INTO auto_update_policy VALUES (1, '1', 1, 'x', 'y')");
    expect(autoUpdatePolicy({ handle: loose as never })).toBeNull();
    loose.exec("DELETE FROM auto_update_policy; INSERT INTO auto_update_policy VALUES (1, 1, 1, 'x', 'y'), (1, 0, 2, 'x', 'y')");
    expect(autoUpdatePolicy({ handle: loose as never })).toBeNull();
    loose.close();
  });
});
