/** v163: which notes a signed-in person typed (one-workspace S5). A new table only: no saved row changes, a crash resumes
 * to the same shape, a row is written once, and a table in a shape this build can't name refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V163_STEPS } from "./store.js";
import { V163_TABLES } from "./typed-words-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = "2026-11-14T00:00:00.000Z";

/** A v162 file: made by this build with an approver, then the v163 table dropped and the version put back. */
function v162File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v163-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", new Date(T0));
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V163_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 162");
  raw.close();
  return file;
}

describe("v163", () => {
  test("fresh: the table, no rows, update-safe", () => {
    expect(SCHEMA_VERSION).toBe(170);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(163);
    expect(updateSafeSchema(162)).toBe(true);
    expect(V163_STEPS).toEqual(["typed-by-person"]);
    const fresh = openStore(":memory:");
    expect(fresh.handle.prepare("SELECT COUNT(*) AS n FROM typed_by_person").get()?.["n"]).toBe(0);
    fresh.close();
  });

  test("a row names exactly one existing note, and is written once", () => {
    const store = openStore(":memory:");
    const db = store.handle;
    store.createTask({ id: "t-1", title: "x" }, new Date(T0));
    const ref = store.refFor("built-in", "t-1").id;
    const steer = Number(db.prepare("INSERT INTO task_steer (task_ref, author, note, created_at, authorship_state) VALUES (?, 'alex', 'n', ?, 'verified')").run(ref, T0).lastInsertRowid);
    const insert = (comment: number | null, steerId: number | null, author = "alex", words = "n") =>
      db.prepare("INSERT INTO typed_by_person (comment, steer, author, words, typed_at) VALUES (?, ?, ?, ?, ?)").run(comment, steerId, author, words, T0);
    expect(() => insert(null, null)).toThrow();
    expect(() => insert(999, null)).toThrow(/FOREIGN KEY/);
    expect(() => insert(null, steer, "")).toThrow();
    expect(() => insert(null, steer, "alex", "   ")).toThrow();
    insert(null, steer);
    expect(() => insert(null, steer)).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE typed_by_person SET author = 'mallory'").run()).toThrow(/written once/);
    store.close();
  });

  test("an upgrade adds the table and changes no saved row", () => {
    const file = v162File();
    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining([...V163_STEPS]));
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(170);
    expect(upgraded.handle.prepare("SELECT COUNT(*) AS n FROM typed_by_person").get()?.["n"]).toBe(0);
    expect(upgraded.accountOf("alex")).not.toBeNull();
    upgraded.close();
  });

  test("a crash after the step resumes to the same shape", () => {
    const file = v162File();
    expect(() => openStore(file, { migrationStep: at => { if (at === "typed-by-person") throw new Error("crash"); } })).toThrow("crash");
    const resumed = openStore(file);
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(170);
    resumed.close();
  });

  test.each([
    ["the table", "DROP TABLE typed_by_person; CREATE TABLE typed_by_person (id INTEGER PRIMARY KEY, comment INTEGER, steer INTEGER, author TEXT, words TEXT, question TEXT, typed_at TEXT)", /typed_by_person table typed_by_person has an unknown shape/],
    ["the trigger", "DROP TRIGGER typed_by_person_written_once", /trigger typed_by_person_written_once is missing/],
  ])("a current file whose %s isn't this build's refuses to open", (_what, damage, refusal) => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v163-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(damage);
    raw.close();
    expect(() => openStore(file)).toThrow(refusal);
  });
});
