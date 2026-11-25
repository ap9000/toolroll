import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V181_STEPS } from "./store.js";
import { V181_TABLES } from "./direct-chat-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-24T00:00:00.000Z");

function v180File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v181-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", T0);
  made.createTask({ id: "kept", title: "kept" }, T0);
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of [...V181_TABLES].reverse()) raw.exec(`DROP TABLE IF EXISTS ${table}`);
  raw.exec("UPDATE schema_version SET version = 180");
  raw.close();
  return file;
}

const version = (store: ReturnType<typeof openStore>) =>
  store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];
const threadCount = (store: ReturnType<typeof openStore>) =>
  store.handle.prepare("SELECT COUNT(*) AS n FROM direct_chat_thread").get()?.["n"];

describe("v181", () => {
  test("fresh: direct chat tables exist, empty, and update-safe", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(181);
    expect(updateSafeSchema(180)).toBe(true);
    expect(V181_STEPS).toEqual(["direct-chat-tables"]);
    expect(SCHEMA_VERSION).toBe(181);
    const fresh = openStore(":memory:");
    try { expect(threadCount(fresh)).toBe(0); } finally { fresh.close(); }
  });

  test("upgrade adds tables, preserves saved rows, and resumes cleanly after crash", () => {
    const file = v180File();
    expect(() => openStore(file, { migrationStep: one => { if (one === "direct-chat-tables") throw new Error("crash"); } })).toThrow(/crash/);
    const upgraded = openStore(file);
    try {
      expect(version(upgraded)).toBe(SCHEMA_VERSION);
      expect(threadCount(upgraded)).toBe(0);
      expect(upgraded.lookupRef("kept")).not.toBeNull();
      expect(upgraded.accountOf("alex")).not.toBeNull();
    } finally { upgraded.close(); }
  });

  test("a direct chat table with an unexpected shape refuses to open", () => {
    const file = v180File();
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE direct_chat_tool");
    raw.exec("CREATE TABLE direct_chat_tool (id TEXT PRIMARY KEY)");
    raw.close();
    expect(() => openStore(file)).toThrow(/direct chat table direct_chat_tool has an unknown shape/);
  });
});
