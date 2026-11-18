/** v172: each person's own Claude sign-in for threads (flexible-sign-in.ts). A new table and three nullable columns: no
 * saved row changes (a saved relay call reads no sign-in), a fresh file and an upgraded one have no sign-in, a crash
 * after either step resumes to the same shape, and a table or column in a shape this build can't name refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V172_STEPS } from "./store.js";
import { V172_ADDED_COLUMNS, V172_TABLES } from "./flexible-sign-in-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-17T00:00:00.000Z");

/** A v171 file: made by this build with an approver, a task and one saved relay call, then v172's index, columns and
 * table taken away and the version put back. */
function v171File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v172-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", T0);
  made.createTask({ id: "kept", title: "kept" }, T0);
  made.close();
  const raw = new DatabaseSync(file);
  raw.exec("DROP INDEX thread_relay_call_sign_in_refused");
  for (const [table, columns] of Object.entries(V172_ADDED_COLUMNS)) for (const column of Object.keys(columns).reverse()) raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  for (const table of V172_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec(`INSERT INTO thread_relay_call (thread, turn, launch, upstream, at, ended_at, route, model, streamed, status, reason, http_status, cost_microusd, cost_basis)
    VALUES ('${"a".repeat(32)}', '${"b".repeat(32)}', '${"c".repeat(32)}', 'claude', 't', 't', 'messages', NULL, 0, 'completed', NULL, 200, 0, 'estimated')`);
  raw.exec("UPDATE schema_version SET version = 171");
  raw.close();
  return file;
}
const version = (store: ReturnType<typeof openStore>) => store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];

describe("v172", () => {
  test("fresh: the table and columns, no sign-in; update-safe", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(172);
    expect(updateSafeSchema(171)).toBe(true);
    expect(V172_STEPS).toEqual(["flexible-sign-in-columns", "flexible-sign-in"]);
    const fresh = openStore(":memory:");
    expect(fresh.handle.prepare("SELECT COUNT(*) AS n FROM flexible_sign_in").get()?.["n"]).toBe(0);
    expect(fresh.handle.prepare("SELECT sign_in_person, sign_in_generation, sign_in_refused FROM thread_relay_call").all()).toEqual([]);
    fresh.close();
  });

  test("an upgrade adds the table and columns and changes no saved row: a saved call reads no sign-in", () => {
    const upgraded = openStore(v171File());
    try {
      expect(version(upgraded)).toBe(SCHEMA_VERSION);
      expect(upgraded.handle.prepare("SELECT COUNT(*) AS n FROM flexible_sign_in").get()?.["n"]).toBe(0);
      expect(upgraded.handle.prepare("SELECT status, sign_in_person, sign_in_generation, sign_in_refused FROM thread_relay_call").all().map(row => ({ ...row })))
        .toEqual([{ status: "completed", sign_in_person: null, sign_in_generation: null, sign_in_refused: null }]);
      expect(upgraded.lookupRef("kept")).not.toBeNull();
    } finally { upgraded.close(); }
  });

  test("a crash after either step resumes to the same shape", () => {
    for (const at of V172_STEPS) {
      const file = v171File();
      expect(() => openStore(file, { migrationStep: one => { if (one === at) throw new Error("crash"); } })).toThrow(/crash/);
      const resumed = openStore(file);
      try { expect(version(resumed), at).toBe(SCHEMA_VERSION); } finally { resumed.close(); }
      openStore(file).close();
    }
  });

  test("a table or column in a shape this build can't name refuses to open; the rows' rules hold", () => {
    const file = v171File();
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("DROP INDEX flexible_sign_in_one_active");
    raw.exec("CREATE INDEX flexible_sign_in_one_active ON flexible_sign_in (person)");
    raw.close();
    expect(() => openStore(file)).toThrow(/Claude sign-ins index flexible_sign_in_one_active has an unknown shape/);

    const other = v171File();
    const loose = new DatabaseSync(other);
    loose.exec("ALTER TABLE thread_relay_call ADD COLUMN sign_in_person TEXT");
    loose.close();
    expect(() => openStore(other)).toThrow(/sign_in_person|unknown shape/);

    // At most one active sign-in per person; a staged row carries its save's binding, and nothing else does.
    const store = openStore(":memory:");
    const insert = (generation: string, state: string, op: string | null) => store.handle.prepare(`INSERT INTO flexible_sign_in (person, account_generation, generation, kind, state, save_op, proof, staged_at, retire_after, activated_at, retired_at)
      VALUES ('alex', 0, ?, 'setup-token', ?, ?, 'password-now', 't', 't', 't', 't')`).run(generation, state, op);
    insert("1".repeat(32), "active", null);
    expect(() => insert("2".repeat(32), "active", null)).toThrow(/UNIQUE/);
    expect(() => insert("3".repeat(32), "staged", null)).toThrow(/CHECK/);
    expect(() => insert("4".repeat(32), "retiring", "4".repeat(32))).toThrow(/CHECK/);
    store.close();
  });
});
