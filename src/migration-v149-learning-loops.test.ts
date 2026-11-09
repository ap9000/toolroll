/**
 * Schema v149 (docs/plans/learning-loops.md, slice 1): every learning-loops table lands at once and no saved row
 * changes. A fresh database, an upgrade from v148 (and from one that stopped mid-way), a crash after the step resuming
 * to the same rows, the update rehearsal's history rules, and each table's own rules (what its one writer may change,
 * and what nobody may). Isolated databases only.
 */
import { afterEach, describe, expect, test } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V149_STEPS, V149_TABLES, type MigrationStep, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const AT = NOW.toISOString();
let dir: string | undefined;
const open: Store[] = [];
afterEach(() => { for (const one of open.splice(0)) { try { one.close(); } catch { /* closed */ } } if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const opened = (store: Store): Store => { open.push(store); return store; };

/** A v148 database with a task, a finished run, a project, a decision and a memory proposal: then the v149 tables gone. */
function v148Fixture(version: 148 | -148): string {
  dir ??= mkdtempSync(join(tmpdir(), "so-v149-"));
  const file = join(dir, `v148-${version < 0 ? "mid" : "at"}.db`);
  const first = openStore(file);
  first.createTask({ id: "pay", title: "Round payouts" }, NOW);
  const ref = first.refFor(BUILT_IN, "pay").id;
  const run = first.startRun({ taskRef: ref, leaseId: "lease-1", runner: "worker", branch: "standing-orders/pay", worktree: "/pool/pay",
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: NOW });
  first.finishRun(run, { outcome: "failed", reason: "agent", now: NOW });
  first.recordRunCheck(run, { status: "failed", exitCode: 1, suites: [] }, NOW);
  first.handle.prepare("INSERT INTO project (path, name, added_at, last_opened_at) VALUES ('/repo/shop', 'shop', ?, ?)").run(AT, AT);
  first.handle.prepare(`INSERT INTO project_decision (repo, identity, claim, why, status, decided_by, decided_at, source_kind, recorded_by, sha)
    VALUES ('/repo/shop', 'id', 'Round half up', 'Finance asked', 'active', 'alex', ?, 'manual', 'alex', 'sha')`).run(AT);
  first.handle.prepare(`INSERT INTO memory_proposal (repo, kind, fingerprint, title, rationale, after_text, evidence, sessions, status, created_at, surface)
    VALUES ('/repo/shop', 'decision-add', 'fp', 'Note', 'Why', 'Claim', '[]', 0, 'pending', ?, 's')`).run(AT);
  first.close();
  const db = new DatabaseSync(file);
  for (const table of V149_TABLES) db.exec(`DROP TABLE ${table}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  return file;
}
const rowsOf = (store: Store) => Object.fromEntries(["run", "run_check", "project", "project_decision", "memory_proposal", ...V149_TABLES].map(table =>
  [table, store.handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
const tables = (store: Store) => store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (SELECT value FROM json_each(?)) ORDER BY name")
  .all(JSON.stringify(V149_TABLES)).map(row => String(row["name"]));
const triggers = (store: Store) => store.handle.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (SELECT value FROM json_each(?))").get(JSON.stringify(V149_TABLES))?.["n"];

/** Each table's own rules, on a migrated store with its saved run (1), decision (1) and proposal (1). */
function tableRules(store: Store): void {
  const db = store.handle;
  const run = Number(db.prepare("SELECT id FROM run").get()!["id"]);
  const refuses = (sql: string, ...params: unknown[]) => expect(() => db.prepare(sql).run(...params), sql).toThrow();
  db.prepare("INSERT INTO check_fact (run, repo, task_ref, purpose, learn_state, recorded_at) VALUES (?, '/repo/shop', 1, 'ordinary', 'not-asked', ?)").run(run, AT);
  db.prepare("INSERT INTO check_result (run, identity, state, source, recorded_at) VALUES (?, 'check', 'failed', 'receipt', ?)").run(run, AT);
  // Recorded once; kept.
  refuses("UPDATE check_fact SET learn_state = 'recorded'");
  refuses("DELETE FROM check_fact");
  refuses("UPDATE check_result SET state = 'passed'");
  // Shapes the contract doesn't name.
  refuses("INSERT INTO check_fact (run, task_ref, purpose, learn_state, recorded_at) VALUES (?, 1, 'ordinary', 'not-recorded', ?)", run + 1, AT);
  refuses("INSERT INTO check_result (run, identity, state, source, recorded_at) VALUES (?, 'x', 'flaky', 'report', ?)", run, AT);
  refuses("INSERT INTO check_result (run, identity, state, source, recorded_at) VALUES (?, 'x', 'passed', 'rumour', ?)", run, AT);
  refuses("INSERT INTO local_observation (repo, identity, failed_run, passed_run, tree, conditions_digest, kind, observed_at) VALUES ('/r', 'x', ?, ?, 't', 'c', 'regate', ?)", run, run, AT);
  refuses("INSERT INTO ci_flaky_observation (repo, provider, repository, workflow, lane_id, lane_name, workflow_run_id, head_sha, failed_attempt, failed_job_id, failed_conclusion, passed_attempt, passed_job_id, passed_conclusion, observed_at) VALUES ('/r', 'github', 'a/b', 'ci', 'l', 'L', 9, 'h', 2, 1, 'failure', 1, 2, 'success', ?)", AT);
  // A tracked identity only ends, once; never deleted.
  db.prepare("INSERT INTO learning_watch (repo, identity, reason, source_ref, since) VALUES ('/repo/shop', 'unit:a.test.ts::x', 'observation', 'observation:1', ?)").run(AT);
  refuses("UPDATE learning_watch SET identity = 'unit:b.test.ts::y'");
  db.prepare("UPDATE learning_watch SET until = ?").run(AT);
  refuses("UPDATE learning_watch SET until = ?", AT);
  refuses("DELETE FROM learning_watch");
  // A note's facts are recorded once; its tally only counts up and is never pruned.
  const proposal = Number(db.prepare("SELECT id FROM memory_proposal").get()!["id"]);
  const second = Number(db.prepare(`INSERT INTO run (task_ref, lease_id, runner, branch, worktree, phase, started_at) SELECT task_ref, 'lease-2', runner, branch, worktree, phase, started_at FROM run WHERE id = ? RETURNING id`).get(run)!["id"]);
  db.prepare("INSERT INTO lesson_note (proposal, repo, failed_run, passing_run, identities_json, changed_paths_json, test_files_changed_json, facts_digest, created_at) VALUES (?, '/repo/shop', ?, ?, '[]', '[]', '[]', 'd', ?)").run(proposal, run, second, AT);
  refuses("UPDATE lesson_note SET facts_digest = 'e'");
  db.prepare("INSERT INTO lesson_note_tally (note, month, executions, failures) VALUES (?, '2026-11', 3, 1)").run(proposal);
  db.prepare("UPDATE lesson_note_tally SET executions = 4, failures = 2, partial = 1").run();
  refuses("UPDATE lesson_note_tally SET executions = 1");
  refuses("UPDATE lesson_note_tally SET partial = 0");
  refuses("UPDATE lesson_note_tally SET month = '2026-12'");
  refuses("UPDATE lesson_note_tally SET failures = 9");
  refuses("DELETE FROM lesson_note_tally");
  refuses("INSERT INTO lesson_note_tally (note, month) VALUES (?, 'Nov')", proposal);
  // Memory use is recorded once.
  db.prepare("INSERT INTO memory_use (run, repo, kind, item, phase) VALUES (?, '/repo/shop', 'decision', '1', 'build')").run(run);
  refuses("UPDATE memory_use SET version = 2");
  refuses("DELETE FROM memory_use");
  refuses("INSERT INTO memory_use (run, kind, item, phase) VALUES (?, 'rumour', '1', 'build')", run);
  // A tidy-up proposal is decided once, and only its decision changes.
  db.prepare("INSERT INTO memory_tidy_proposal (repo, kind, items_json, rationale, evidence_json, source, created_at) VALUES ('/repo/shop', 'retire', '[]', 'unused', '{}', 'usage', ?)").run(AT);
  refuses("UPDATE memory_tidy_proposal SET items_json = '[1]'");
  refuses("UPDATE memory_tidy_proposal SET status = 'accepted', decided_at = ?", AT);
  db.prepare("UPDATE memory_tidy_proposal SET status = 'accepted', decided_by = 'alex', decided_proof = 'p', decided_at = ?").run(AT);
  refuses("UPDATE memory_tidy_proposal SET status = 'rejected'");
  refuses("DELETE FROM memory_tidy_proposal");
  // A merge is undone once, never rewritten.
  const decision = Number(db.prepare("SELECT id FROM project_decision").get()!["id"]);
  const successor = Number(db.prepare(`INSERT INTO project_decision (repo, identity, claim, why, status, decided_by, decided_at, source_kind, recorded_by, sha)
    VALUES ('/repo/shop', 'id', 'Merged', 'Both said it', 'active', 'alex', ?, 'manual', 'alex', 'sha2') RETURNING id`).get(AT)!["id"]);
  db.prepare("INSERT INTO decision_merge (merge, successor, successor_revision, predecessor, predecessor_revision, at, by) VALUES (1, ?, 1, ?, 1, ?, 'alex')").run(successor, decision, AT);
  refuses("UPDATE decision_merge SET predecessor_revision = 2");
  db.prepare("UPDATE decision_merge SET undone_at = ?, undone_by = 'alex'").run(AT);
  refuses("UPDATE decision_merge SET undone_at = NULL, undone_by = NULL");
  refuses("DELETE FROM decision_merge");
  refuses("INSERT INTO decision_merge (merge, successor, successor_revision, predecessor, predecessor_revision, at, by) VALUES (2, ?, 1, ?, 1, ?, 'alex')", decision, decision, AT);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

describe("the v149 migration", () => {
  test("a fresh database has every table and its rules", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v149-"));
    const store = opened(openStore(join(dir, "fresh.db")));
    expect(SCHEMA_VERSION).toBe(158);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(158);
    expect(tables(store)).toEqual([...V149_TABLES].sort());
    expect(triggers(store)).toBeGreaterThan(15);
  });

  test.each([148, -148] as const)("v%s: the tables arrive with their rules, and no saved row changes", version => {
    const file = v148Fixture(version);
    const db = new DatabaseSync(file);
    const before = historySnapshot(db);
    db.close();
    expect(updateSafeSchema(148)).toBe(true);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(149);
    const store = opened(openStore(file));
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(158);
    expect(tables(store)).toEqual([...V149_TABLES].sort());
    for (const table of V149_TABLES) expect(store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"], table).toBe(0);
    store.close();
    open.length = 0;
    // The update rehearsal's rules: nothing saved before v149 changed.
    const after = new DatabaseSync(file, { readOnly: true });
    try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
    tableRules(opened(openStore(file)));
  });

  test.each(V149_STEPS.map(step => [step]))("a crash after %s resumes on the next open, to exactly the rows an uninterrupted migration makes", (step: MigrationStep) => {
    const fixture = v148Fixture(148);
    const reference = join(dir!, "reference.db"), crashed = join(dir!, "crashed.db");
    copyFileSync(fixture, reference);
    copyFileSync(fixture, crashed);
    const whole = opened(openStore(reference));
    expect(() => openStore(crashed, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    const peek = new DatabaseSync(crashed, { readOnly: true });
    try { expect(peek.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(-148); } finally { peek.close(); }
    const resumed = opened(openStore(crashed));
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(158);
    expect(rowsOf(resumed)).toEqual(rowsOf(whole));
    expect(triggers(resumed)).toBe(triggers(whole));
  });
});
