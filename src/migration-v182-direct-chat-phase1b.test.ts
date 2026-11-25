import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V182_STEPS } from "./store.js";
import { V182_TABLES } from "./direct-chat-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-24T00:00:00.000Z");

function v181File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v182-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", T0);
  made.createTask({ id: "kept", title: "kept" }, T0);
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of [...V182_TABLES].reverse()) raw.exec(`DROP TABLE IF EXISTS ${table}`);
  raw.exec("UPDATE schema_version SET version = 181");
  raw.close();
  return file;
}

const version = (store: ReturnType<typeof openStore>) =>
  store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];
const tableCount = (store: ReturnType<typeof openStore>, table: string) =>
  store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"];

describe("v182", () => {
  test("fresh: artifact and ship tables exist, empty, and update-safe", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(182);
    expect(updateSafeSchema(181)).toBe(true);
    expect(V182_STEPS).toEqual(["direct-chat-phase1b-tables"]);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(182);
    const fresh = openStore(":memory:");
    try {
      expect(tableCount(fresh, "direct_chat_artifact")).toBe(0);
      expect(tableCount(fresh, "direct_chat_ship")).toBe(0);
    } finally {
      fresh.close();
    }
  });

  test("upgrade adds tables, preserves saved rows, and resumes cleanly after crash", () => {
    const file = v181File();
    expect(() => openStore(file, { migrationStep: one => { if (one === "direct-chat-phase1b-tables") throw new Error("crash"); } })).toThrow(/crash/);
    const upgraded = openStore(file);
    try {
      expect(version(upgraded)).toBe(SCHEMA_VERSION);
      expect(tableCount(upgraded, "direct_chat_artifact")).toBe(0);
      expect(tableCount(upgraded, "direct_chat_ship")).toBe(0);
      expect(upgraded.lookupRef("kept")).not.toBeNull();
      expect(upgraded.accountOf("alex")).not.toBeNull();
    } finally {
      upgraded.close();
    }
  });

  test("an unexpected direct_chat_ship shape refuses to open", () => {
    const file = v181File();
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE direct_chat_ship");
    raw.exec("CREATE TABLE direct_chat_ship (id TEXT PRIMARY KEY)");
    raw.close();
    expect(() => openStore(file)).toThrow(/direct chat table direct_chat_ship has an unknown shape/);
  });
});
