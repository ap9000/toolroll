/** v162: Flexible threads' own repositories (the Flexible plan v2, slice F2a). A new table only: no saved row changes, a
 * crash resumes to the same shape, the record is written once and only moves forward, and a table in a shape this build
 * can't name refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V162_STEPS } from "./store.js";
import { V162_TABLES } from "./flexible-thread-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = "2026-11-14T00:00:00.000Z";
const ID = "0123456789abcdef0123456789abcdef";
const SHA = "a".repeat(40);

/** A v161 file: made by this build with an approver, then the v162 table dropped and the version put back. */
function v161File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v162-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", new Date(T0));
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V162_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 161");
  raw.close();
  return file;
}
const insert = (db: { prepare: DatabaseSync["prepare"] }, over: Record<string, unknown> = {}) => {
  const id = String(over["id"] ?? ID);
  const row = { id, repo: "/work/app", base_sha: SHA, keep_ref: `refs/toolroll/threads/${id}/base`, folder: `/state/threads/${id}`, created_by: "alex", created_at: T0, state: "preparing", ...over };
  return db.prepare(`INSERT INTO flexible_thread (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...(Object.values(row) as (string | number | null)[]));
};

describe("v162", () => {
  test("fresh: the table, no rows, update-safe", () => {
    expect(SCHEMA_VERSION).toBe(162);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(162);
    expect(updateSafeSchema(161)).toBe(true);
    expect(V162_STEPS).toEqual(["flexible-thread"]);
    const fresh = openStore(":memory:");
    expect(fresh.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread").get()?.["n"]).toBe(0);
    fresh.close();
  });

  test("the table refuses what it can't name, writes the repository once, and its state only moves forward", () => {
    const store = openStore(":memory:");
    const db = store.handle;
    expect(() => insert(db, { id: "../../etc" })).toThrow();
    expect(() => insert(db, { id: ID.toUpperCase() })).toThrow();
    expect(() => insert(db, { base_sha: "HEAD" })).toThrow();
    expect(() => insert(db, { keep_ref: "refs/heads/main" })).toThrow();
    expect(() => insert(db, { state: "running" })).toThrow();
    expect(() => insert(db, { ended_at: T0 })).toThrow();
    expect(() => insert(db, { state: "removed" })).toThrow();
    insert(db);
    for (const column of ["repo", "base_sha", "keep_ref", "folder", "created_by", "created_at"]) {
      expect(() => db.prepare(`UPDATE flexible_thread SET ${column} = 'changed' WHERE id = ?`).run(ID), column).toThrow();
    }
    db.prepare("UPDATE flexible_thread SET state = 'ready' WHERE id = ?").run(ID);
    expect(() => db.prepare("UPDATE flexible_thread SET state = 'preparing' WHERE id = ?").run(ID)).toThrow(/only moves forward/);
    db.prepare("UPDATE flexible_thread SET state = 'removing' WHERE id = ?").run(ID);
    expect(() => db.prepare("UPDATE flexible_thread SET state = 'ready' WHERE id = ?").run(ID)).toThrow(/only moves forward/);
    db.prepare("UPDATE flexible_thread SET state = 'removed', ended_at = ? WHERE id = ?").run(T0, ID);
    expect(() => db.prepare("UPDATE flexible_thread SET state = 'removing', ended_at = NULL WHERE id = ?").run(ID)).toThrow(/only moves forward/);
    expect(() => db.prepare("UPDATE flexible_thread SET end_detail = 'x' WHERE id = ?").run(ID)).toThrow(/only moves forward/);
    store.close();
  });

  test("an upgrade adds the table and changes no saved row", () => {
    const file = v161File();
    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining([...V162_STEPS]));
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(162);
    expect(upgraded.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread").get()?.["n"]).toBe(0);
    expect(upgraded.accountOf("alex")).not.toBeNull();
    upgraded.close();
  });

  test.each([["flexible-terms"], ["flexible-thread"]])("a crash after %s resumes to the same shape", step => {
    const file = v161File();
    expect(() => openStore(file, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    const resumed = openStore(file);
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(162);
    expect(resumed.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread").get()?.["n"]).toBe(0);
    resumed.close();
  });

  test.each([
    ["the table", "DROP TABLE flexible_thread; CREATE TABLE flexible_thread (id TEXT PRIMARY KEY, repo TEXT, folder TEXT)", /flexible_thread table flexible_thread has an unknown shape/],
    ["the trigger", "DROP TRIGGER flexible_thread_written_once", /trigger flexible_thread_written_once is missing/],
    ["the index", "DROP INDEX flexible_thread_repo; CREATE INDEX flexible_thread_repo ON flexible_thread (repo)", /index flexible_thread_repo has an unknown shape/],
  ])("a current file whose %s isn't this build's refuses to open", (_what, damage, refusal) => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v162-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(damage);
    raw.close();
    expect(() => openStore(file)).toThrow(refusal);
  });
});
