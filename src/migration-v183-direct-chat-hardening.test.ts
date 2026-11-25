import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V183_STEPS } from "./store.js";
import { V181_TABLES, V182_TABLES, V183_ADDED_COLUMNS } from "./direct-chat-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-24T00:00:00.000Z");

function v182File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v183-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", T0);
  made.createTask({ id: "kept", title: "kept" }, T0);
  made.close();
  const raw = new DatabaseSync(file);
  // Drop and recreate v181/v182 tables without v183 columns, then stamp v182.
  for (const table of [...V182_TABLES].reverse()) raw.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const table of [...V181_TABLES].reverse()) raw.exec(`DROP TABLE IF EXISTS ${table}`);
  raw.exec("UPDATE schema_version SET version = 180");
  raw.close();
  // Upgrade to v182 by crashing before v183 step, or just verify upgrade from v180 -> v183 adds all v183 columns.
  return file;
}

const hasCol = (store: ReturnType<typeof openStore>, table: string, col: string) => {
  const rows = store.handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(r => r.name === col);
};

describe("v183", () => {
  test("fresh: hardening columns exist and migration is update-safe", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(183);
    expect(updateSafeSchema(182)).toBe(true);
    expect(V183_STEPS).toEqual(["direct-chat-hardening-columns"]);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(183);
    const fresh = openStore(":memory:");
    try {
      for (const [table, cols] of Object.entries(V183_ADDED_COLUMNS)) {
        for (const col of Object.keys(cols)) {
          expect(hasCol(fresh, table, col), `${table}.${col}`).toBe(true);
        }
      }
    } finally {
      fresh.close();
    }
  });

  test("upgrade adds hardening columns, preserves saved rows, and resumes cleanly after crash", () => {
    const file = v182File();
    expect(() => openStore(file, { migrationStep: one => { if (one === "direct-chat-hardening-columns") throw new Error("crash"); } })).toThrow(/crash/);
    const upgraded = openStore(file);
    try {
      expect(upgraded.lookupRef("kept")).not.toBeNull();
      expect(upgraded.accountOf("alex")).not.toBeNull();
      for (const [table, cols] of Object.entries(V183_ADDED_COLUMNS)) {
        for (const col of Object.keys(cols)) {
          expect(hasCol(upgraded, table, col), `${table}.${col}`).toBe(true);
        }
      }
    } finally {
      upgraded.close();
    }
  });
});
