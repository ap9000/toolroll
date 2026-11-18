/** v174: interactive agent threads for everyday use (flexible-everyday-schema.ts). Three new tables: no saved row
 * changes, a crash after the step resumes to the same shape, a table in a shape this build can't name refuses to open,
 * and each table's written-once rules hold (a stop request only settles, once; dispatch facts never change; a thread's
 * title and end are written once, and an end is final; a Ship's laptop consent is written once and kept). */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V174_STEPS } from "./store.js";
import { V174_TABLES } from "./flexible-everyday-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-18T00:00:00.000Z");
const id = (c: string) => c.repeat(32);

/** A v173 file: made by this build with an approver and a task, then v174's tables taken away and the version put back. */
function v173File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v174-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", T0);
  made.createTask({ id: "kept", title: "kept" }, T0);
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V174_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 173");
  raw.close();
  return file;
}
const version = (store: ReturnType<typeof openStore>) => store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];

describe("v174", () => {
  test("fresh: the tables, empty; update-safe", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(174);
    expect(updateSafeSchema(173)).toBe(true);
    expect(V174_STEPS).toEqual(["flexible-everyday"]);
    const fresh = openStore(":memory:");
    for (const table of V174_TABLES) expect(fresh.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    fresh.close();
  });

  test("an upgrade adds the tables and changes no saved row", () => {
    const upgraded = openStore(v173File());
    try {
      expect(version(upgraded)).toBe(SCHEMA_VERSION);
      for (const table of V174_TABLES) expect(upgraded.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
      expect(upgraded.lookupRef("kept")).not.toBeNull();
    } finally { upgraded.close(); }
  });

  test("a crash after the step resumes to the same shape", () => {
    const file = v173File();
    expect(() => openStore(file, { migrationStep: one => { if (one === "flexible-everyday") throw new Error("crash"); } })).toThrow(/crash/);
    const resumed = openStore(file);
    try { expect(version(resumed)).toBe(SCHEMA_VERSION); } finally { resumed.close(); }
  });

  test("a table in a shape this build can't name refuses to open", () => {
    const file = v173File();
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE flexible_stop_request");
    raw.exec("CREATE TABLE flexible_stop_request (launch TEXT PRIMARY KEY, thread TEXT, reason TEXT, requested_at TEXT, settled_at TEXT)");
    raw.close();
    expect(() => openStore(file)).toThrow(/interactive agent threads (table|index|trigger) flexible_stop_request\w* (has an unknown shape|is missing)/);
  });

  test("written once: a stop request only settles, once; dispatch facts never change; a title and an end are final", () => {
    const store = openStore(":memory:");
    try {
      const run = (sql: string, ...args: unknown[]) => () => store.handle.prepare(sql).run(...args as never[]);
      run("INSERT INTO flexible_stop_request (launch, thread, reason, requested_at) VALUES (?, ?, 'why', 't')", id("a"), id("b"))();
      expect(run("UPDATE flexible_stop_request SET reason = 'other' WHERE launch = ?", id("a"))).toThrow(/only ever settles/);
      run("UPDATE flexible_stop_request SET settled_at = 't2' WHERE launch = ?", id("a"))();
      expect(run("UPDATE flexible_stop_request SET settled_at = 't3' WHERE launch = ?", id("a"))).toThrow(/only ever settles/);
      expect(run("DELETE FROM flexible_stop_request WHERE launch = ?", id("a"))).toThrow(/is kept/);
      run("INSERT INTO flexible_turn_dispatch (turn, person, sign_in_epoch, account_generation) VALUES (?, 'alex', 0, 1)", id("c"))();
      expect(run("UPDATE flexible_turn_dispatch SET sign_in_epoch = 1 WHERE turn = ?", id("c"))).toThrow(/written once/);
      run("INSERT INTO flexible_thread_meta (thread, title) VALUES (?, 'Fix the parser')", id("d"))();
      expect(run("UPDATE flexible_thread_meta SET title = 'Other' WHERE thread = ?", id("d"))).toThrow(/written once/);
      expect(run("UPDATE flexible_thread_meta SET ended_at = 't' WHERE thread = ?", id("d"))).toThrow(/CHECK constraint failed/);
      run("UPDATE flexible_thread_meta SET ended_at = 't', ended_by = 'alex', end_words = 'You ended this thread.' WHERE thread = ?", id("d"))();
      expect(run("UPDATE flexible_thread_meta SET ended_at = NULL, ended_by = NULL, end_words = NULL WHERE thread = ?", id("d"))).toThrow(/an end is final/);
      expect(run("DELETE FROM flexible_thread_meta WHERE thread = ?", id("d"))).toThrow(/are kept/);
      run("INSERT INTO flexible_ship_laptop (ship, owner, local_generation, account_generation, consented_at) VALUES (?, 'alex', 1, 2, 't')", id("e"))();
      expect(run("UPDATE flexible_ship_laptop SET local_generation = 2 WHERE ship = ?", id("e"))).toThrow(/written once/);
      expect(run("DELETE FROM flexible_ship_laptop WHERE ship = ?", id("e"))).toThrow(/is kept/);
    } finally { store.close(); }
  });
});
