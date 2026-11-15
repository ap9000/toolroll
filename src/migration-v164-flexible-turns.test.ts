/** v164: Flexible threads' turns and the installation's Flexible limits (the Flexible plan v2, slice F2e). New tables
 * only: no saved row changes, a crash resumes to the same shape, a turn is written once and only moves forward, and a
 * table in a shape this build can't name refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V164_STEPS } from "./store.js";
import { V164_TABLES } from "./flexible-turns-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = "2026-11-14T00:00:00.000Z";
const ID = "0123456789abcdef0123456789abcdef";
const THREAD = "a".repeat(32);

/** A v163 file: made by this build with an approver, then the v164 tables dropped and the version put back. */
function v163File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v164-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", new Date(T0));
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V164_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 163");
  raw.close();
  return file;
}
const insert = (db: { prepare: DatabaseSync["prepare"] }, over: Record<string, unknown> = {}) => {
  const row = { id: ID, thread: THREAD, seq: 1, repo: "/work/app", owner: "alex", owner_generation: 1, terms_id: 1, terms_digest: "d".repeat(32), level: "full", provider: "claude",
    model: "claude-sonnet-4-5", billing: "subscription", request_key: "m-1", holder: "h1", admitted_at: T0, utc_day: T0.slice(0, 10), status: "admitted", ...over };
  return db.prepare(`INSERT INTO thread_turn (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...(Object.values(row) as (string | number | null)[]));
};

describe("v164", () => {
  test("fresh: the tables, no rows, update-safe", () => {
    expect(SCHEMA_VERSION).toBe(164);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(164);
    expect(updateSafeSchema(163)).toBe(true);
    expect(V164_STEPS).toEqual(["thread-turn"]);
    const fresh = openStore(":memory:");
    for (const table of V164_TABLES) expect(fresh.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    fresh.close();
  });

  test("a turn refuses what it can't name, is written once, moves only forward and its usage only grows", () => {
    const store = openStore(":memory:");
    const db = store.handle;
    expect(() => insert(db, { id: "../../etc" })).toThrow();
    expect(() => insert(db, { level: "root" })).toThrow();
    expect(() => insert(db, { provider: "gemini" })).toThrow();
    expect(() => insert(db, { utc_day: "2026-11-13" })).toThrow();
    expect(() => insert(db, { status: "running" })).toThrow(); // running needs a start time
    expect(() => insert(db, { tokens_in: 5 })).toThrow(); // no usage before it starts
    insert(db);
    expect(() => insert(db, { id: "1".repeat(32), seq: 2 })).toThrow(); // the same request, and one live turn per thread
    for (const column of ["thread", "repo", "owner", "terms_digest", "level", "model", "billing", "request_key", "holder", "admitted_at"]) {
      expect(() => db.prepare(`UPDATE thread_turn SET ${column} = 'changed' WHERE id = ?`).run(ID), column).toThrow();
    }
    db.prepare("UPDATE thread_turn SET status = 'running', started_at = ? WHERE id = ?").run(T0, ID);
    db.prepare("UPDATE thread_turn SET tokens_in = 10, cost_microusd = 5, relay_calls = 1, cost_basis = 'measured' WHERE id = ?").run(ID);
    expect(() => db.prepare("UPDATE thread_turn SET tokens_in = 9 WHERE id = ?").run(ID)).toThrow(/usage only grows/);
    expect(() => db.prepare("UPDATE thread_turn SET status = 'admitted', started_at = NULL WHERE id = ?").run(ID)).toThrow(/only moves forward/);
    expect(() => db.prepare("UPDATE thread_turn SET status = 'finished', ended_at = ?, cost_basis = NULL WHERE id = ?").run(T0, ID)).toThrow(); // an ended turn has a basis
    db.prepare("UPDATE thread_turn SET status = 'finished', ended_at = ? WHERE id = ?").run(T0, ID);
    expect(() => db.prepare("UPDATE thread_turn SET status = 'interrupted' WHERE id = ?").run(ID)).toThrow(/only moves forward/);
    db.prepare("UPDATE thread_turn SET cost_basis = 'estimated' WHERE id = ?").run(ID);
    expect(() => db.prepare("UPDATE thread_turn SET cost_basis = 'measured' WHERE id = ?").run(ID)).toThrow(/usage only grows/);
    // A withdrawn turn never changes again, and a new request on the thread may follow it.
    insert(db, { id: "2".repeat(32), seq: 2, request_key: "m-2" });
    db.prepare("UPDATE thread_turn SET status = 'withdrawn', ended_at = ? WHERE id = ?").run(T0, "2".repeat(32));
    expect(() => db.prepare("UPDATE thread_turn SET end_detail = 'x' WHERE id = ?").run("2".repeat(32))).toThrow(/only moves forward/);
    insert(db, { id: "3".repeat(32), seq: 3, request_key: "m-2" });
    // The installation's limits: one row, positive limits or none.
    expect(() => db.prepare("INSERT INTO flexible_installation_caps (id, live_threads, updated_by, updated_at) VALUES (2, 1, 'alex', ?)").run(T0)).toThrow();
    expect(() => db.prepare("INSERT INTO flexible_installation_caps (id, live_threads, updated_by, updated_at) VALUES (1, 0, 'alex', ?)").run(T0)).toThrow();
    store.close();
  });

  test("an upgrade adds the tables and changes no saved row", () => {
    const file = v163File();
    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining([...V164_STEPS]));
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(164);
    for (const table of V164_TABLES) expect(upgraded.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    expect(upgraded.accountOf("alex")).not.toBeNull();
    upgraded.close();
  });

  test.each([["typed-by-person"], ["thread-turn"]])("a crash after %s resumes to the same shape", step => {
    const file = v163File();
    expect(() => openStore(file, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    const resumed = openStore(file);
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(164);
    expect(resumed.handle.prepare("SELECT COUNT(*) AS n FROM thread_turn").get()?.["n"]).toBe(0);
    resumed.close();
  });

  test.each([
    ["the table", "DROP TABLE thread_turn; CREATE TABLE thread_turn (id TEXT PRIMARY KEY, thread TEXT, repo TEXT)", /thread_turn has an unknown shape|thread_turn_\w+ is missing/],
    ["the trigger", "DROP TRIGGER thread_turn_written_once", /trigger thread_turn_written_once is missing/],
    ["the live index", "DROP INDEX thread_turn_live; CREATE INDEX thread_turn_live ON thread_turn (thread)", /index thread_turn_live has an unknown shape/],
    ["the limits table", "DROP TABLE flexible_installation_caps; CREATE TABLE flexible_installation_caps (id INTEGER PRIMARY KEY, live_threads INTEGER)", /flexible_installation_caps has an unknown shape/],
  ])("a current file whose %s isn't this build's refuses to open", (_what, damage, refusal) => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v164-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(damage);
    raw.close();
    expect(() => openStore(file)).toThrow(refusal);
  });
});
