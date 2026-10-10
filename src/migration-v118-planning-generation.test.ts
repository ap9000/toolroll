/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V118_ADDED_COLUMNS, type Store } from "./store.js";
import { historySnapshot, changedHistory } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

const legacy = { route: { routeDigest: "legacy", phase: "plan" as const, provider: "claude", model: null, chosen: "legacy" as const } };

/** A v117 database with a planned task's history: a planner run, its answered and open questions, a plan revision. */
function v117(file: string, now: Date, version: number) {
  const first = openStore(file);
  first.createTask({ id: "t-1", title: "a planned task" }, now);
  const ref = first.refFor(BUILT_IN, "t-1").id;
  const run = first.startRun({ taskRef: ref, leaseId: "lease", runner: "runner", branch: "plan", worktree: "/plan", role: "planner", ...legacy, now });
  const options = [{ id: "a", label: "A", consequence: "a", reversible: true }, { id: "b", label: "B", consequence: "b", reversible: true }];
  const answered = first.saveDecision({ run, urgency: "blocking", recap: "r", question: "which?", options, recommendation: "a" }, now);
  first.answerDecision({ id: answered, choice: "a", by: "alex", via: "cli" }, now);
  first.saveDecision({ run, urgency: "blocking", recap: "r", question: "and then?", options, recommendation: "b" }, now);
  const artifact = first.saveArtifact({ run, kind: "plan", key: "k/plan.md", bytesOriginal: 1, bytesStored: 1, truncated: false, sha256: "0".repeat(64), capture: "fixture" }, now);
  first.insertPlanRevision({ taskRef: ref, revision: 1, artifact, parentHash: null, reason: "r", evidenceLink: null, author: "planner", originRun: run, kind: "initial", authorityKind: "plan-only", authorityDigest: "d", changedFields: [], status: "applied" }, now);
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v117 shape: none of the four columns.
  const db = new DatabaseSync(file);
  db.exec(`DROP TRIGGER ledger_decision_answered; DROP TRIGGER ledger_decision_closed;
    CREATE TRIGGER ledger_decision_answered AFTER UPDATE OF answered_at ON decision
    WHEN NEW.answered_at IS NOT NULL AND OLD.answered_at IS NULL BEGIN
      INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source)
      SELECT NEW.answered_at, COALESCE(NEW.answered_by,'system'), task_ref.repo, task_ref.external_id, NEW.run,
        'decision answered', NEW.state, 'work' FROM run JOIN task_ref ON task_ref.id = run.task_ref WHERE run.id = NEW.run;
    END;`);
  for (const [table, columns] of Object.entries(V118_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();
  return { chain, before };
}

test.each([117, -117])("v%s: planning generations and closure reasons are added, every saved row reads the defaults, and the ledger holds", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v118-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-09T17:00:00.000Z");
  const { chain, before } = v117(file, now, version);

  expect(updateSafeSchema(117)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(118);
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(118);
  const db = store.handle;
  expect(db.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(118);
  for (const table of ["task_ref", "run", "plan_revision"]) {
    expect(db.prepare(`SELECT DISTINCT planning_generation AS g FROM ${table}`).all().map(row => row["g"])).toEqual([0]);
  }
  expect(db.prepare("SELECT count(*) AS n FROM decision WHERE superseded_reason IS NOT NULL").get()?.["n"]).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM decision").get()?.["n"]).toBe(2);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ledger_decision_answered'").get()?.["sql"]).toContain("NEW.superseded_reason IS NULL");
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  // The closure reason is typed from the start.
  expect(() => db.prepare("UPDATE decision SET superseded_reason = 'tired' WHERE id = 1").run()).toThrow(/CHECK/);
  // Saved history keeps working: the answered question is still the planner's memory.
  expect(store.answeredDecisionsFor("t-1")).toEqual([{ question: "which?", choice: "a", note: null }]);
  expect(store.currentPlanRevision(store.refFor(BUILT_IN, "t-1").id)).toMatchObject({ revision: 1 });
  store.close();
  store = undefined;
  // A second open changes nothing.
  store = openStore(file);
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try {
    expect(changedHistory(after, before)).toEqual([]);
    // The rehearsal notices a saved row that does not read the declared default.
    after.prepare("UPDATE run SET planning_generation = 3").run();
    expect(changedHistory(after, before)).toEqual(["run"]);
  } finally { after.close(); }
});
