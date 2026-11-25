import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS } from "./store.js";
import { FINDING_SOURCES, FINDING_SOURCES_BEFORE_LEAD } from "./fleet-schema.js";
import { V177_OBJECTS, V177_SCHEMA, WORKSPACE_ID_PATTERN, RECOVERY_GENERATION_PATTERN } from "./workspace-identity-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
function v176(): string {
  const dir = mkdtempSync(join(tmpdir(), "so-workspace-identity-")); dirs.push(dir);
  const file = join(dir, "orders.db"), store = openStore(file);
  store.createTask({ id: "kept", title: "Keep this task" }, new Date("2026-11-20T00:00:00.000Z")); store.close();
  const raw = new DatabaseSync(file);
  raw.exec("DROP INDEX action_ledger_action");
  for (const [type, name] of [...V177_OBJECTS].reverse()) raw.exec(`DROP ${type} ${name}`);
  raw.exec("UPDATE schema_version SET version = 176"); raw.close(); return file;
}
test("fresh/v176 files gain one identity without changing saved tasks, and reopening preserves it", () => {
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(177); expect(UPDATE_SAFE_MIGRATIONS).toContain(177);
  const file = v176(), before = new DatabaseSync(file), task = before.prepare("SELECT * FROM task WHERE id = 'kept'").get(); before.close();
  const store = openStore(file), identity = store.workspaceIdentity();
  expect(WORKSPACE_ID_PATTERN.test(identity.id)).toBe(true); expect(RECOVERY_GENERATION_PATTERN.test(identity.recoveryGeneration)).toBe(true);
  expect(new Date(identity.createdAt).toISOString()).toBe(identity.createdAt);
  expect(store.handle.prepare("SELECT * FROM task WHERE id = 'kept'").get()).toEqual(task);
  expect(() => store.handle.prepare("UPDATE workspace_identity SET workspace_id = ?").run("b".repeat(36))).toThrow();
  expect(() => store.handle.exec("DELETE FROM workspace_identity")).toThrow(); store.close();
  const reopened = openStore(file); expect(reopened.workspaceIdentity()).toEqual(identity); reopened.close();
  const fresh = openStore(":memory:"); expect(fresh.workspaceIdentity().id).not.toBe(identity.id); fresh.close();
});
test("an interrupted upgrade after identity insertion resumes without reminting", () => {
  const file = v176();
  expect(() => openStore(file, { migrationStep: step => { if (step === "workspace-identity") throw Error("interrupted"); } })).toThrow("interrupted");
  const raw = new DatabaseSync(file), before = raw.prepare("SELECT * FROM workspace_identity").get(); raw.close();
  const resumed = openStore(file); expect(resumed.handle.prepare("SELECT * FROM workspace_identity").get()).toEqual(before); resumed.close();
});
test("current identity shape damage refuses before repair", () => {
  for (const object of ["workspace_identity_immutable", "workspace_identity"]) {
    const file = v176(); openStore(file).close(); const raw = new DatabaseSync(file);
    raw.exec(`DROP ${object === "workspace_identity" ? "TABLE" : "TRIGGER"} ${object}`); raw.close();
    expect(() => openStore(file)).toThrow(/workspace identity/);
    const after = new DatabaseSync(file); expect(after.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(object)).toBeUndefined(); after.close();
  }
});
test("a missing current identity row is never recreated, including direct reads", () => {
  const file = v176(), store = openStore(file);
  store.handle.exec("DROP TRIGGER workspace_identity_not_deleted; DELETE FROM workspace_identity");
  const trigger = V177_SCHEMA.slice(V177_SCHEMA.indexOf("CREATE TRIGGER IF NOT EXISTS workspace_identity_not_deleted")); store.handle.exec(trigger);
  expect(() => store.workspaceIdentity()).toThrow(/exactly one row/); store.close();
  expect(() => openStore(file)).toThrow(/exactly one row/);
  const raw = new DatabaseSync(file); expect(raw.prepare("SELECT count(*) AS n FROM workspace_identity").get()?.["n"]).toBe(0); raw.close();
});

test("current identity cannot be reminted during stale finding compatibility replay; resumed -177 also refuses identity loss; -SCHEMA_VERSION is impossible", () => {
  for (const damage of ["table", "row"] as const) for (const version of [177, -177, SCHEMA_VERSION, -SCHEMA_VERSION]) {
    const file = v176(); openStore(file).close(); const raw = new DatabaseSync(file);
    const sql = String(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'finding'").get()!["sql"]);
    raw.exec("PRAGMA foreign_keys = OFF; BEGIN");
    raw.exec(sql.replace(FINDING_SOURCES, FINDING_SOURCES_BEFORE_LEAD).replace(/^CREATE TABLE (?:IF NOT EXISTS )?finding/, "CREATE TABLE finding_old"));
    raw.exec("INSERT INTO finding_old SELECT * FROM finding; DROP TABLE finding; ALTER TABLE finding_old RENAME TO finding; CREATE INDEX finding_family ON finding (family_root, state); COMMIT");
    expect(String(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'finding'").get()!["sql"])).toContain(FINDING_SOURCES_BEFORE_LEAD);
    if (damage === "table") raw.exec("DROP TABLE workspace_identity");
    else {
      raw.exec("DROP TRIGGER workspace_identity_not_deleted; DELETE FROM workspace_identity");
      raw.exec(V177_SCHEMA.slice(V177_SCHEMA.indexOf("CREATE TRIGGER IF NOT EXISTS workspace_identity_not_deleted")));
    }
    raw.prepare("UPDATE schema_version SET version = ?").run(version); raw.close();
    expect(() => openStore(file)).toThrow(version === -SCHEMA_VERSION ? /mid-flight marker no build ever wrote/ : /workspace identity/);
    const after = new DatabaseSync(file);
    expect(after.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(version);
    expect(after.prepare("SELECT title FROM task WHERE id = 'kept'").get()?.["title"]).toBe("Keep this task");
    if (damage === "table") expect(after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workspace_identity'").get()).toBeUndefined();
    else expect(after.prepare("SELECT count(*) AS n FROM workspace_identity").get()?.["n"]).toBe(0);
    after.close();
  }
});
