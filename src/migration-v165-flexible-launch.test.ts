/** v165: Flexible threads' agent launches (with their process custody) and each thread's chosen level (the Flexible plan
 * v2, slice F2c). New tables only: no saved row changes, a crash resumes to the same shape, a launch is written once,
 * moves only forward and what it saw only grows, at most one launch per thread is unsettled, and a table in a shape this
 * build can't name refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V165_STEPS } from "./store.js";
import { V165_TABLES } from "./flexible-launch-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = "2026-11-14T00:00:00.000Z";
const ID = "0123456789abcdef0123456789abcdef";
const THREAD = "a".repeat(32);

/** A v164 file: made by this build with an approver, then the v165 tables dropped and the version put back. */
function v164File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v165-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", new Date(T0));
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V165_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 164");
  raw.close();
  return file;
}
const insert = (db: { prepare: DatabaseSync["prepare"] }, over: Record<string, unknown> = {}) => {
  const row = { id: ID, thread: THREAD, provider: "claude", level: "full", fence_digest: "f".repeat(32), holder: "h1", host: "here", marker: "9".repeat(32), state: "spawning", started_at: T0, ...over };
  return db.prepare(`INSERT INTO flexible_thread_launch (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...(Object.values(row) as (string | number | null)[]));
};

describe("v165", () => {
  test("fresh: the tables, no rows, update-safe", () => {
    expect(SCHEMA_VERSION).toBe(165);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(165);
    expect(updateSafeSchema(164)).toBe(true);
    expect(V165_STEPS).toEqual(["thread-launch"]);
    const fresh = openStore(":memory:");
    for (const table of V165_TABLES) expect(fresh.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    fresh.close();
  });

  test("a launch refuses what it can't name, is written once, moves only forward, and what it saw only grows", () => {
    const store = openStore(":memory:");
    const db = store.handle;
    expect(() => insert(db, { id: "../../etc" })).toThrow();
    expect(() => insert(db, { provider: "cursor" })).toThrow();
    expect(() => insert(db, { level: "root" })).toThrow();
    expect(() => insert(db, { marker: "short" })).toThrow();
    expect(() => insert(db, { state: "live" })).toThrow(); // live needs a leader
    expect(() => insert(db, { leader_pid: 1, leader_start: "t1" })).toThrow(); // never pid 1
    expect(() => insert(db, { leader_pid: 42 })).toThrow(); // a pid without its start identity is no identity
    expect(() => insert(db, { state: "exited" })).toThrow(); // an exit has a time
    insert(db);
    expect(() => insert(db, { id: "1".repeat(32) })).toThrow(); // one unsettled launch per thread
    for (const column of ["thread", "provider", "level", "fence_digest", "holder", "host", "boot_id", "marker", "started_at"]) {
      expect(() => db.prepare(`UPDATE flexible_thread_launch SET ${column} = 'changed' WHERE id = ?`).run(ID), column).toThrow();
    }
    db.prepare("UPDATE flexible_thread_launch SET state = 'live', leader_pid = 4242, leader_start = 't100' WHERE id = ?").run(ID);
    expect(() => db.prepare("UPDATE flexible_thread_launch SET leader_pid = 4343 WHERE id = ?").run(ID)).toThrow(/written once/);
    expect(() => db.prepare("UPDATE flexible_thread_launch SET state = 'spawning' WHERE id = ?").run(ID)).toThrow(/only moves forward/);
    db.prepare(`UPDATE flexible_thread_launch SET witnesses = '[{"pid":5,"start":"t101"}]', namespaces = '["pid:[4026532000]"]' WHERE id = ?`).run(ID);
    expect(() => db.prepare("UPDATE flexible_thread_launch SET witnesses = '[]' WHERE id = ?").run(ID)).toThrow(/only grows/);
    expect(() => db.prepare("UPDATE flexible_thread_launch SET namespaces = '{}' WHERE id = ?").run(ID)).toThrow();
    db.prepare("UPDATE flexible_thread_launch SET network_closed_at = ? WHERE id = ?").run(T0, ID);
    expect(() => db.prepare("UPDATE flexible_thread_launch SET network_closed_at = NULL WHERE id = ?").run(ID)).toThrow(/written once/);
    db.prepare("UPDATE flexible_thread_launch SET state = 'unresolved' WHERE id = ?").run(ID);
    expect(() => db.prepare("UPDATE flexible_thread_launch SET state = 'live' WHERE id = ?").run(ID)).toThrow(/only moves forward/);
    db.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ? WHERE id = ?").run(T0, ID);
    expect(() => db.prepare("UPDATE flexible_thread_launch SET end_detail = 'x' WHERE id = ?").run(ID)).toThrow(/only moves forward/);
    // Settled, the thread may launch again.
    insert(db, { id: "1".repeat(32) });
    // A relay grant: only its digest, only ever revoked.
    expect(() => db.prepare("INSERT INTO flexible_relay_grant (token_digest, thread, turn, launch, issued_at) VALUES ('tr-relay-raw', ?, ?, ?, ?)").run(THREAD, ID, ID, T0)).toThrow();
    expect(() => db.prepare("INSERT INTO flexible_relay_grant (token_digest, thread, turn, issued_at) VALUES (?, ?, ?, ?)").run("d".repeat(64), THREAD, ID, T0)).toThrow(); // bound to a launch
    db.prepare("INSERT INTO flexible_relay_grant (token_digest, thread, turn, launch, issued_at) VALUES (?, ?, ?, ?, ?)").run("e".repeat(64), THREAD, ID, ID, T0);
    expect(() => db.prepare("UPDATE flexible_relay_grant SET thread = ?").run("b".repeat(32))).toThrow(/only revoked/);
    expect(() => db.prepare("UPDATE flexible_relay_grant SET launch = ?").run("b".repeat(32))).toThrow(/only revoked/);
    db.prepare("UPDATE flexible_relay_grant SET revoked_at = ?").run(T0);
    expect(() => db.prepare("UPDATE flexible_relay_grant SET revoked_at = NULL").run()).toThrow(/only revoked/);
    // A thread's chosen level: one row per thread, a level it can name.
    expect(() => db.prepare("INSERT INTO flexible_thread_level (thread, level, set_by, set_at) VALUES (?, 'root', 'alex', ?)").run(THREAD, T0)).toThrow();
    db.prepare("INSERT INTO flexible_thread_level (thread, level, set_by, set_at) VALUES (?, 'supervised', 'alex', ?)").run(THREAD, T0);
    expect(() => db.prepare("INSERT INTO flexible_thread_level (thread, level, set_by, set_at) VALUES (?, 'auto', 'alex', ?)").run(THREAD, T0)).toThrow();
    store.close();
  });

  test("an upgrade adds the tables and changes no saved row", () => {
    const file = v164File();
    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining([...V165_STEPS]));
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(165);
    for (const table of V165_TABLES) expect(upgraded.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    expect(upgraded.accountOf("alex")).not.toBeNull();
    upgraded.close();
  });

  test.each([["thread-turn"], ["thread-launch"]])("a crash after %s resumes to the same shape", step => {
    const file = v164File();
    expect(() => openStore(file, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    const resumed = openStore(file);
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(165);
    expect(resumed.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread_launch").get()?.["n"]).toBe(0);
    resumed.close();
  });

  test.each([
    ["the table", "DROP TABLE flexible_thread_launch; CREATE TABLE flexible_thread_launch (id TEXT PRIMARY KEY, thread TEXT)", /flexible_thread_launch has an unknown shape|flexible_thread_launch_\w+ is missing/],
    ["the trigger", "DROP TRIGGER flexible_thread_launch_written_once", /trigger flexible_thread_launch_written_once is missing/],
    ["the unsettled index", "DROP INDEX flexible_thread_launch_unsettled; CREATE INDEX flexible_thread_launch_unsettled ON flexible_thread_launch (thread)", /index flexible_thread_launch_unsettled has an unknown shape/],
    ["the relay grants' trigger", "DROP TRIGGER flexible_relay_grant_written_once", /trigger flexible_relay_grant_written_once is missing/],
    ["the level table", "DROP TABLE flexible_thread_level; CREATE TABLE flexible_thread_level (thread TEXT PRIMARY KEY)", /flexible_thread_level has an unknown shape/],
  ])("a current file whose %s isn't this build's refuses to open", (_what, damage, refusal) => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v165-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(damage);
    raw.close();
    expect(() => openStore(file)).toThrow(refusal);
  });
});
