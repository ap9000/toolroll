import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION } from "./store.js";
import { addApprover } from "./scope.js";
import { SUBAGENT_TEMPLATES } from "./subagents.js";
import { V176_ADDED_COLUMNS, V176_OBJECTS } from "./subagent-backup-schema.js";
const dirs: string[] = [], NOW = new Date("2026-11-19T12:00:00Z");
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function v175(): string {
  const dir = mkdtempSync(join(tmpdir(), "so-backup-migration-")); dirs.push(dir);
  const file = join(dir, "orders.db"), store = openStore(file);
  if (!addApprover(store, "alex", NOW).ok) throw Error("bootstrap");
  const id = store.createSubagent({ repo: join(dir, "shop"), handle: "maya", soul: SUBAGENT_TEMPLATES[0]!.soul, model: "sonnet", manager: "alex", by: "alex" }, NOW);
  store.addSubagentTurn({ subagent: id, card: null, model: "sonnet", ok: true, ms: 50, costUsd: 0.01, tokensIn: 100, tokensOut: 20 }, NOW); store.close();
  const raw = new DatabaseSync(file);
  for (const [type, name] of [...V176_OBJECTS].reverse()) raw.exec(`DROP ${type} ${name}`);
  for (const [table, columns] of Object.entries(V176_ADDED_COLUMNS)) for (const column of Object.keys(columns).reverse()) raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  raw.exec("UPDATE schema_version SET version = 175"); raw.close(); return file;
}
test("v175 rows retain their data and acquire off/Claude/settled defaults; new databases share the shape", () => {
  const file = v175(); const raw = new DatabaseSync(file);
  const oldMate = raw.prepare("SELECT * FROM subagent").get()!, oldTurn = raw.prepare("SELECT * FROM subagent_turn").get()!; raw.close();
  const store = openStore(file);
  expect(SCHEMA_VERSION).toBe(177);
  expect(store.handle.prepare("SELECT * FROM subagent").get()).toMatchObject({ ...oldMate, codex_backup_model: null, authority_generation: 0 });
  expect(store.handle.prepare("SELECT * FROM subagent_turn").get()).toMatchObject({ ...oldTurn, provider: "claude", model_reported: null, pending: 0, counted_attempt: 0, backup_of: null });
  expect(store.getSubagent(Number(oldMate["id"]))?.codexBackupModel).toBeNull(); store.close();
  openStore(":memory:").close();
});
test("an interrupted v176 upgrade resumes; a current file with a missing revocation trigger refuses repair", () => {
  const file = v175();
  expect(() => openStore(file, { migrationStep: step => { if (step === "subagent-backup-columns") throw Error("simulated crash"); } })).toThrow("simulated crash");
  openStore(file).close();
  const raw = new DatabaseSync(file); raw.exec("DROP TRIGGER subagent_authority_changed"); raw.close();
  expect(() => openStore(file)).toThrow(/subagent backup trigger/);
  const after = new DatabaseSync(file); expect(after.prepare("SELECT 1 FROM sqlite_master WHERE name='subagent_authority_changed'").get()).toBeUndefined(); after.close();
});
test("current files refuse an altered one-backup index", () => {
  const file = v175(); openStore(file).close(); const raw = new DatabaseSync(file);
  raw.exec("DROP INDEX subagent_backup_once; CREATE INDEX subagent_backup_once ON subagent_turn(backup_of)"); raw.close();
  expect(() => openStore(file)).toThrow(/subagent backup index/);
});
