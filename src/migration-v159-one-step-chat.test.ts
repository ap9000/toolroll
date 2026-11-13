/** v159: one-step start from chat adds a nullable column and a table, and changes no saved row.
 * docs/plans/one-step-chat.md, C1 and C5. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V159_STEPS } from "./store.js";
import { V159_ADDED_COLUMNS, V159_TABLES } from "./one-step-chat-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-09T00:00:00.000Z");

describe("v159", () => {
  test("a fresh database has the column and tables; a v158 one gains them, keeps its rows (NULL), and may update in place", () => {
    expect(SCHEMA_VERSION).toBe(160);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(159);
    expect(updateSafeSchema(158)).toBe(true);
    expect(V159_STEPS).toEqual(["one-step-chat-tables", "one-step-chat-columns"]);
    const columns = (handle: { prepare(sql: string): { all(): unknown[] } }, table: string) => (handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(one => one.name);
    const tables = (handle: { prepare(sql: string): { all(): unknown[] } }) => (handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(one => one.name);

    const fresh = openStore(":memory:");
    for (const table of V159_TABLES) expect(tables(fresh.handle)).toContain(table);
    for (const [table, added] of Object.entries(V159_ADDED_COLUMNS)) for (const column of Object.keys(added)) expect(columns(fresh.handle, table)).toContain(column);
    fresh.close();

    const dir = mkdtempSync(join(tmpdir(), "toolroll-v159-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    const made = openStore(file);
    made.handle.prepare(`INSERT INTO fast_preview (id, actor, via, task_id, repo, title, permission, sizing_json, digest, created_at, expires_at)
      VALUES ('p1', 'alex', 'console', 'task-1', '/work/app', 'Fix it', NULL, '{}', 'd', ?, ?)`).run(T0.toISOString(), T0.toISOString());
    made.close();
    // Back to a v158 file: the new table and column gone, as an older build made it.
    const raw = new DatabaseSync(file);
    for (const table of V159_TABLES) raw.exec(`DROP TABLE ${table}`);
    for (const [table, added] of Object.entries(V159_ADDED_COLUMNS)) for (const column of Object.keys(added)) raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    raw.exec("UPDATE schema_version SET version = 158");
    raw.close();

    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining([...V159_STEPS]));
    for (const table of V159_TABLES) expect(tables(upgraded.handle)).toContain(table);
    expect(upgraded.handle.prepare("SELECT id, via, turn FROM fast_preview").get()).toEqual({ id: "p1", via: "console", turn: null });
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(160);
    upgraded.close();
    const again = openStore(file);
    expect(again.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(160);
    again.close();
  });
});
