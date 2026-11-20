import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema } from "./store.js";
import { V175_OBJECTS, V175_TABLES } from "./flexible-interactive-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function v174(): string {
  const dir = mkdtempSync(join(tmpdir(), "attach-migration-")); dirs.push(dir);
  const file = join(dir, "orders.db");
  const store = openStore(file);
  store.createTask({ id: "kept", title: "kept" }, new Date());
  store.close();
  const raw = new DatabaseSync(file);
  for (const [type, name] of [...V175_OBJECTS].reverse()) raw.exec(`DROP ${type} ${name}`);
  raw.exec("UPDATE schema_version SET version = 174"); raw.close();
  return file;
}
test("fresh and v174 files have v175's empty authority tables; saved records survive", () => {
  expect(SCHEMA_VERSION).toBe(176);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(175);
  expect(updateSafeSchema(174)).toBe(true);
  for (const file of [":memory:", v174()]) {
    const store = openStore(file);
    for (const table of V175_TABLES) expect(store.handle.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    if (file !== ":memory:") expect(store.lookupRef("kept")).not.toBeNull();
    store.close();
  }
});
test("crash after v175 resumes; current files refuse missing or altered guards", () => {
  const file = v174();
  expect(() => openStore(file, { migrationStep: step => { if (step === "flexible-interactive") throw new Error("crash"); } })).toThrow("crash");
  openStore(file).close();
  const raw = new DatabaseSync(file); raw.exec("DROP TRIGGER flexible_interactive_session_written_once"); raw.close();
  expect(() => openStore(file)).toThrow(/is missing/);
});

test("legacy threads gain a saved stream-json runtime without changing their thread record", () => {
  const file = v174(), raw = new DatabaseSync(file), thread = "a".repeat(32);
  raw.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state)
    VALUES (?, '/fixture', ?, ?, '/fixture/thread', 'alex', 't', 'ready')`).run(thread, "1".repeat(40), `refs/toolroll/threads/${thread}/base`);
  const before = raw.prepare("SELECT * FROM flexible_thread").get(); raw.close();
  const upgraded = openStore(file);
  try {
    expect(upgraded.handle.prepare("SELECT * FROM flexible_thread").get()).toEqual(before);
    expect(upgraded.handle.prepare("SELECT runtime FROM flexible_thread_runtime WHERE thread = ?").get(thread)?.["runtime"]).toBe("stream-json");
    expect(() => upgraded.handle.prepare("UPDATE flexible_thread_runtime SET runtime = 'interactive', chosen = 1").run()).toThrow(/immutable/);
  } finally { upgraded.close(); }
});
