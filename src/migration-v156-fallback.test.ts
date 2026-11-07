/** v156: fallback chains add three tables and change no saved row. docs/plans/fallback-chains.md. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V156_STEPS } from "./store.js";
import { V156_TABLES } from "./fallback-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("v156", () => {
  test("a fresh database has the tables; a v154 one gains them, keeps its rows, and may update in place", () => {
    const fresh = openStore(":memory:");
    const has = (handle: { prepare(sql: string): { all(): unknown[] } }) => (handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(one => one.name);
    for (const table of V156_TABLES) expect(has(fresh.handle)).toContain(table);
    fresh.close();
    expect(SCHEMA_VERSION).toBe(156);
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
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(156);
    upgraded.close();
    // A second open changes nothing.
    const again = openStore(file);
    expect(again.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(156);
    again.close();
  });
});
