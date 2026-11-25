/** v180: a task's pending model change (docs/plans/mac-change-models.md). A new table only: no saved row changes, a fresh
 * file and an upgraded one start with no pending change, a crash after the step resumes to the same shape, and a table in
 * a shape this build can't name refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V180_STEPS } from "./store.js";
import { V180_TABLES } from "./agent-change-schema.js";
import { V181_TABLES, V182_TABLES } from "./direct-chat-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-22T00:00:00.000Z");

/** A v179 file: made by this build with an approver and a task, then the v180 table taken away and the version put back. */
function v179File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v180-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", T0);
  made.createTask({ id: "kept", title: "kept" }, T0);
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of [...V182_TABLES].reverse()) raw.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const table of [...V181_TABLES].reverse()) raw.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const table of V180_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 179");
  raw.close();
  return file;
}
const version = (store: ReturnType<typeof openStore>) => store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];
const pending = (store: ReturnType<typeof openStore>) => store.handle.prepare("SELECT COUNT(*) AS n FROM pending_agent_change").get()?.["n"];

describe("v180", () => {
  test("fresh: the table, empty; update-safe", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(180);
    expect(updateSafeSchema(179)).toBe(true);
    expect(V180_STEPS).toEqual(["pending-agent-change"]);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(180);
    const fresh = openStore(":memory:");
    try { expect(pending(fresh)).toBe(0); } finally { fresh.close(); }
  });

  test("an upgrade adds the table and changes no saved row; a crash after the step resumes to the same shape", () => {
    const file = v179File();
    expect(() => openStore(file, { migrationStep: one => { if (one === "pending-agent-change") throw new Error("crash"); } })).toThrow(/crash/);
    const upgraded = openStore(file);
    try {
      expect(version(upgraded)).toBe(SCHEMA_VERSION);
      expect(pending(upgraded)).toBe(0);
      expect(upgraded.lookupRef("kept")).not.toBeNull();
      expect(upgraded.accountOf("alex")).not.toBeNull();
    } finally { upgraded.close(); }
  });

  test("a table in a shape this build can't name refuses to open", () => {
    const file = v179File();
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE pending_agent_change");
    raw.exec("CREATE TABLE pending_agent_change (task_ref INTEGER PRIMARY KEY, phase TEXT, provider TEXT, model TEXT)");
    raw.close();
    expect(() => openStore(file)).toThrow(/pending model change table has an unknown shape/);
  });
});
