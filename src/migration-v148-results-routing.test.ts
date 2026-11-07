/**
 * Schema v148 (docs/plans/results-routing.md, slice 1): every results-routing table and the run, revision and
 * project columns land at once, and no saved row changes. A fresh database, an upgrade from v147 (and from one that
 * stopped mid-way), a crash after each step resuming to the same rows, and the update rehearsal's history rules.
 * Isolated databases only.
 */
import { afterEach, describe, expect, test } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V148_ADDED_COLUMNS, V148_STEPS, V148_TABLES, type MigrationStep, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
let dir: string | undefined;
const open: Store[] = [];
afterEach(() => { for (const one of open.splice(0)) { try { one.close(); } catch { /* closed */ } } if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const opened = (store: Store): Store => { open.push(store); return store; };

/** A v147 database with a task, a revision link, a finished run and a project: then the v148 shape taken away. */
function v147Fixture(version: 147 | -147): string {
  dir ??= mkdtempSync(join(tmpdir(), "so-v148-"));
  const file = join(dir, `v147-${version < 0 ? "mid" : "at"}.db`);
  const first = openStore(file);
  first.createTask({ id: "pay", title: "Round payouts" }, NOW);
  const ref = first.refFor(BUILT_IN, "pay").id;
  const run = first.startRun({ taskRef: ref, leaseId: "lease-1", runner: "worker", branch: "standing-orders/pay", worktree: "/pool/pay",
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: NOW });
  first.finishRun(run, { outcome: "failed", reason: "retryable-infra", now: NOW });
  first.handle.prepare("INSERT INTO project (path, name, added_at, last_opened_at) VALUES ('/repo/shop', 'shop', ?, ?)").run(NOW.toISOString(), NOW.toISOString());
  first.setPhaseConfig("installation", "build", "claude", "claude-haiku-4-5", "alex", NOW);
  first.close();
  const db = new DatabaseSync(file);
  for (const table of V148_TABLES) db.exec(`DROP TABLE ${table}`);
  for (const [table, columns] of Object.entries(V148_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  return file;
}
const rowsOf = (store: Store) => Object.fromEntries(["run", "task_ref", "project", ...V148_TABLES].map(table =>
  [table, store.handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
const tables = (store: Store) => store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (SELECT value FROM json_each(?)) ORDER BY name")
  .all(JSON.stringify(V148_TABLES)).map(row => String(row["name"]));

describe("the v148 migration", () => {
  test("a fresh database has every table and column", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v148-"));
    const store = opened(openStore(join(dir, "fresh.db")));
    expect(SCHEMA_VERSION).toBe(150);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(150);
    expect(tables(store)).toEqual([...V148_TABLES].sort());
    for (const [table, columns] of Object.entries(V148_ADDED_COLUMNS)) {
      const present = store.handle.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row["name"]));
      for (const column of Object.keys(columns)) expect(present, `${table}.${column}`).toContain(column);
    }
  });

  test.each([147, -147] as const)("v%s: the tables and columns arrive, every saved row reads its declared value, and nothing else changes", version => {
    const file = v147Fixture(version);
    const db = new DatabaseSync(file);
    const before = historySnapshot(db);
    db.close();
    expect(updateSafeSchema(147)).toBe(true);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(148);
    const store = opened(openStore(file));
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(150);
    expect(tables(store)).toEqual([...V148_TABLES].sort());
    // Saved rows: no class kept (counts as the model's), no origin (never a person), suggestions on.
    expect(store.handle.prepare("SELECT exec_class FROM run").all().map(row => row["exec_class"])).toEqual([null]);
    expect(store.handle.prepare("SELECT revision_origin FROM task_ref").all().map(row => row["revision_origin"])).toEqual([null]);
    expect(store.handle.prepare("SELECT suggest_models FROM project").all().map(row => row["suggest_models"])).toEqual([1]);
    for (const table of V148_TABLES) expect(store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"], table).toBe(0);
    // The new shapes refuse what they can't name.
    expect(() => store.handle.prepare("UPDATE run SET exec_class = 'luck'").run()).toThrow();
    expect(() => store.handle.prepare("UPDATE task_ref SET revision_origin = 'someone'").run()).toThrow();
    expect(() => store.handle.prepare("UPDATE project SET suggest_models = 2").run()).toThrow();
    const rule = (state: string) => store.handle.prepare(`INSERT INTO route_rule (repo, cohort_size, kind, provider, model, configured_provider, state, grant_json, prices_json, depends_json, accepted_by, accepted_at)
      VALUES ('/repo/shop', 'small', 'rule', 'claude', 'claude-haiku-4-5', 'claude', ?, '{}', '{}', '{}', 'alex', ?)`).run(state, NOW.toISOString());
    rule("active");
    // One live winner per project and size.
    expect(() => rule("paused")).toThrow();
    rule("switched-off");
    expect(() => store.handle.prepare("INSERT INTO route_record (task_ref, state, evaluated_at) VALUES (1, 'rejected', ?)").run(NOW.toISOString())).toThrow();
    expect(() => store.handle.prepare("INSERT INTO models_generation (scope, phase, generation, changed_at) VALUES ('installation', 'build', 0, ?)").run(NOW.toISOString())).toThrow();
    store.handle.prepare("DELETE FROM route_rule").run();
    expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    store.close();
    open.length = 0;
    const after = new DatabaseSync(file, { readOnly: true });
    try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
  });

  test.each(V148_STEPS.map(step => [step]))("a crash after %s resumes on the next open, to exactly the rows an uninterrupted migration makes", (step: MigrationStep) => {
    const fixture = v147Fixture(147);
    const reference = join(dir!, "reference.db"), crashed = join(dir!, "crashed.db");
    copyFileSync(fixture, reference);
    copyFileSync(fixture, crashed);
    const whole = opened(openStore(reference));
    expect(() => openStore(crashed, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    // Mid-flight: the epoch sentinel stays, so no reader takes the half-made shape for v147 or v148.
    const peek = new DatabaseSync(crashed, { readOnly: true });
    try { expect(peek.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(-147); } finally { peek.close(); }
    const resumed = opened(openStore(crashed));
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(150);
    expect(rowsOf(resumed)).toEqual(rowsOf(whole));
  });
});
