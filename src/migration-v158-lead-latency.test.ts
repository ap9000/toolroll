/** v158: the lead's latency records and the quick-answer switch add a table and nullable columns, and change no saved
 * row. docs/plans/responsive-chat.md, slice 5. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { leadQuickAnswersOn, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V158_STEPS } from "./store.js";
import { V158_ADDED_COLUMNS, V158_TABLES } from "./lead-latency-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-08T00:00:00.000Z");

describe("v158", () => {
  test("a fresh database has the table and columns; a v156 one gains them, keeps its rows (NULL), and may update in place", () => {
    expect(SCHEMA_VERSION).toBe(159);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(158);
    expect(updateSafeSchema(156)).toBe(true);
    expect(V158_STEPS).toEqual(["lead-quick-setting", "lead-latency-columns"]);
    const columns = (handle: { prepare(sql: string): { all(): unknown[] } }, table: string) => (handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(one => one.name);
    const tables = (handle: { prepare(sql: string): { all(): unknown[] } }) => (handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(one => one.name);

    const fresh = openStore(":memory:");
    for (const table of V158_TABLES) expect(tables(fresh.handle)).toContain(table);
    for (const [table, added] of Object.entries(V158_ADDED_COLUMNS)) for (const column of Object.keys(added)) expect(columns(fresh.handle, table)).toContain(column);
    expect(leadQuickAnswersOn(fresh)).toBe(false);
    fresh.close();

    const dir = mkdtempSync(join(tmpdir(), "toolroll-v158-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    const made = openStore(file);
    made.createTask({ id: "kept", title: "kept" }, T0);
    made.handle.prepare(`INSERT INTO chat_turn (approver, credential_key, provider, model, state, created_at, reserved_microusd, kind)
      VALUES ('alex', 'k', 'claude-subscription', 'opus', 'answered', ?, 0, 'mate-step')`).run(T0.toISOString());
    made.close();
    // Back to a v156 file: the new table and columns gone, as an older build made it.
    const raw = new DatabaseSync(file);
    for (const table of V158_TABLES) raw.exec(`DROP TABLE ${table}`);
    for (const [table, added] of Object.entries(V158_ADDED_COLUMNS)) for (const column of Object.keys(added)) raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    raw.exec("UPDATE schema_version SET version = 156");
    raw.close();

    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining([...V158_STEPS]));
    for (const table of V158_TABLES) expect(tables(upgraded.handle)).toContain(table);
    expect(upgraded.getTask("kept")?.title).toBe("kept");
    expect(upgraded.handle.prepare("SELECT tools, failure_detail FROM chat_turn").get()).toEqual({ tools: null, failure_detail: null });
    expect(leadQuickAnswersOn(upgraded)).toBe(false);
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(159);
    // The new columns refuse values outside their vocabulary.
    expect(() => upgraded.handle.prepare("UPDATE chat_turn SET failure_detail = 'mystery'").run()).toThrow();
    upgraded.close();
    const again = openStore(file);
    expect(again.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(159);
    again.close();
  });
});
