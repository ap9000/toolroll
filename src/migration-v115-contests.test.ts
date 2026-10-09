/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

/** The v114 contest tables, exactly as the fresh schema created them before v115 removed contests. */
const V114_CONTEST_DDL = `
CREATE TABLE tournament_terms (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref                  INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  generation                INTEGER NOT NULL,
  active                    INTEGER NOT NULL DEFAULT 1,
  kind                      TEXT NOT NULL DEFAULT 'race' CHECK (kind IN ('race','comparison')),
  race_digest               TEXT NOT NULL,
  agents                    TEXT NOT NULL,
  n                         INTEGER NOT NULL CHECK (n BETWEEN 2 AND 4),
  per_agent_budget_microusd INTEGER NOT NULL,
  overrun_reserve_microusd  INTEGER NOT NULL,
  total_budget_microusd     INTEGER NOT NULL,
  price_version             INTEGER NOT NULL,
  retries                   INTEGER NOT NULL CHECK (retries = 0),
  publication_policy        TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  approved_at               TEXT,
  approved_by               TEXT,
  approved_digest           TEXT,
  CHECK ((kind = 'race' AND per_agent_budget_microusd > 0 AND overrun_reserve_microusd > 0 AND total_budget_microusd > 0)
      OR (kind = 'comparison' AND per_agent_budget_microusd = 0 AND overrun_reserve_microusd = 0 AND total_budget_microusd = 0))
);
CREATE UNIQUE INDEX tournament_terms_one_active ON tournament_terms (task_ref) WHERE active = 1;
CREATE TABLE contest (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref           INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  terms              INTEGER NOT NULL REFERENCES tournament_terms(id),
  generation         INTEGER NOT NULL DEFAULT 1,
  state              TEXT NOT NULL CHECK (state IN
    ('dispatching','racing','pick-wait','decision-wait','picked','abandoned','interrupted','exhausted')),
  scope_digest       TEXT NOT NULL,
  race_digest        TEXT NOT NULL,
  base_sha           TEXT,
  setup_digest       TEXT,
  current_lease_id   TEXT,
  runner             TEXT,
  incarnation        TEXT,
  created_at         TEXT NOT NULL,
  picked_at          TEXT,
  picked_by          TEXT,
  winner_contestant  INTEGER,
  overdue_paged      INTEGER NOT NULL DEFAULT 0,
  race_semantics     INTEGER NOT NULL DEFAULT 1,
  kind               TEXT NOT NULL DEFAULT 'race'
);
CREATE INDEX contest_by_task ON contest (task_ref, id DESC);
CREATE TABLE contestant (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  contest             INTEGER NOT NULL REFERENCES contest(id) ON DELETE CASCADE,
  ordinal             INTEGER NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  repair_model        TEXT NOT NULL,
  profile_json        TEXT,
  branch              TEXT NOT NULL,
  worktree            TEXT,
  generation          INTEGER NOT NULL DEFAULT 1,
  state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','ready','building','parked','built','failed','stopped')),
  active_run          INTEGER REFERENCES run(id),
  budget_microusd     INTEGER NOT NULL,
  reserve_microusd    INTEGER NOT NULL,
  measured_microusd   INTEGER NOT NULL DEFAULT 0,
  accounted_microusd  INTEGER NOT NULL DEFAULT 0,
  unknown_spend       INTEGER NOT NULL DEFAULT 0,
  cleanup             TEXT CHECK (cleanup IN ('pending','done','attention')),
  custody             TEXT,
  UNIQUE (contest, ordinal)
);
CREATE UNIQUE INDEX one_open_decision_per_contestant
  ON decision (contestant) WHERE contestant IS NOT NULL AND state IN ('open','expired');`;

const T0 = "2026-10-07T09:00:00.000Z";
const FUTURE = "2026-10-07T21:00:00.000Z";

/** Every kept row the migration may touch, for exact before/after comparison. */
function snapshot(file: string): Record<string, unknown[]> {
  const db = new DatabaseSync(file);
  try {
    const all = (sql: string) => db.prepare(sql).all().map(row => ({ ...row }));
    return {
      task: all("SELECT id, state FROM task ORDER BY id"),
      run: all("SELECT id, task_ref, contestant, outcome, reason FROM run ORDER BY id"),
      decision: all("SELECT id, contestant, state, closed_reason, answered_by FROM decision ORDER BY id"),
      hold: all("SELECT task_ref, owner_kind, owner_id, reason FROM hold ORDER BY id"),
      claim: all("SELECT lease_id, released_at, released_by FROM claim ORDER BY lease_id"),
      slot: all("SELECT id, contestant, state FROM execution_slot ORDER BY id"),
      notification: all("SELECT dedupe_key, resolved_at FROM notification ORDER BY id"),
      schema: all("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name"),
    };
  } finally {
    db.close();
  }
}

test("v114 → v115: contests go, and every task they owned ends ordinary, held and recoverable", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v115-contests-"));
  const file = join(dir, "state.db");
  const first = openStore(file);
  for (const id of ["t-racing", "t-pick", "t-terms", "t-picked", "t-plain"]) first.createTask({ id, title: id }, new Date(T0));
  const ref = (id: string) => first.refFor("built-in", id).id;
  const refs = { racing: ref("t-racing"), pick: ref("t-pick"), terms: ref("t-terms"), picked: ref("t-picked"), plain: ref("t-plain") };
  first.close();

  // The v114 shape: the contest tables, the contestant references on run, decision and execution_slot, and v114.
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(V114_CONTEST_DDL);
  const version = Number(db.prepare("PRAGMA schema_version").get()?.["schema_version"]);
  (db as unknown as { enableDefensive?: (on: boolean) => void }).enableDefensive?.(false); // Node 24 opens defensive
  db.exec("PRAGMA writable_schema = ON");
  for (const table of ["run", "decision", "execution_slot"]) {
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.["sql"]);
    const referenced = sql.replace(/(\n\s*contestant\s+INTEGER)(,)/, "$1 REFERENCES contestant(id)$2");
    expect(referenced).not.toBe(sql);
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?").run(referenced, table);
  }
  db.exec(`PRAGMA schema_version = ${version + 1}`);
  db.exec("PRAGMA writable_schema = OFF");
  db.prepare("UPDATE schema_version SET version = 114").run();

  const run = (taskRef: number, lease: string, contestant: number | null, outcome: string | null) =>
    Number(db.prepare("INSERT INTO run (task_ref, lease_id, runner, branch, worktree, contestant, outcome, started_at) VALUES (?, ?, 'runner-a', 'so/x', '/tmp/x', ?, ?, ?)")
      .run(taskRef, lease, contestant, outcome, T0).lastInsertRowid);
  const terms = (taskRef: number, approved: boolean) =>
    Number(db.prepare(`INSERT INTO tournament_terms (task_ref, generation, race_digest, agents, n, per_agent_budget_microusd, overrun_reserve_microusd,
        total_budget_microusd, price_version, retries, publication_policy, created_at, approved_at, approved_by, approved_digest)
      VALUES (?, 1, 'race', '[]', 2, 1000, 100, 5000, 1, 0, 'none', ?, ?, ?, ?)`)
      .run(taskRef, T0, approved ? T0 : null, approved ? "alex" : null, approved ? "race" : null).lastInsertRowid);
  const contest = (taskRef: number, state: string, lease: string | null) =>
    Number(db.prepare("INSERT INTO contest (task_ref, terms, state, scope_digest, race_digest, current_lease_id, runner, created_at) VALUES (?, ?, ?, 's', 'race', ?, 'runner-a', ?)")
      .run(taskRef, terms(taskRef, true), state, lease, T0).lastInsertRowid);
  const lane = (contestId: number, ordinal: number, state: string) =>
    Number(db.prepare("INSERT INTO contestant (contest, ordinal, provider, model, repair_model, branch, state, budget_microusd, reserve_microusd) VALUES (?, ?, 'claude', 'claude-sonnet-5', 'inherit', ?, ?, 1000, 100)")
      .run(contestId, ordinal, `so/race/${contestId}/${ordinal}`, state).lastInsertRowid);
  const question = (runId: number, contestant: number | null) =>
    Number(db.prepare("INSERT INTO decision (run, urgency, recap, question, options, recommendation, contestant, created_at) VALUES (?, 'blocking', 'r', 'q?', '[]', 'a', ?, ?)")
      .run(runId, contestant, T0).lastInsertRowid);
  const hold = (taskRef: number, kind: string, owner: string, reason: string) =>
    db.prepare("INSERT INTO hold (task_ref, owner_kind, owner_id, reason, held_at) VALUES (?, ?, ?, ?, ?)").run(taskRef, kind, owner, reason, T0);
  const page = (key: string) =>
    db.prepare("INSERT INTO notification (dedupe_key, kind, subject, body, created_at) VALUES (?, 'contest-finished', 's', 'b', ?)").run(key, T0);
  db.prepare("UPDATE task SET state = 'running' WHERE id IN ('t-racing', 't-pick')").run();
  db.prepare("UPDATE task SET state = 'done' WHERE id = 't-picked'").run();

  // t-racing: two agents mid-race under a live claim — one building in a running slot, one parked on a question.
  db.prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES ('lease-race', ?, 1, 'runner-a', ?, ?, ?)")
    .run(refs.racing, T0, FUTURE, T0);
  const racing = contest(refs.racing, "racing", "lease-race");
  const building = lane(racing, 1, "building"), parked = lane(racing, 2, "parked");
  const buildingRun = run(refs.racing, "lease-race", building, null);
  const parkedRun = run(refs.racing, "lease-race", parked, "parked");
  db.prepare("INSERT INTO execution_slot (runner, state, run, contestant, reserved_at, running_at) VALUES ('runner-a', 'running', ?, ?, ?, ?)").run(buildingRun, building, T0, T0);
  const raceQuestion = question(parkedRun, parked);
  hold(refs.racing, "decision", String(raceQuestion), "an agent asks");
  page(`decision:${raceQuestion}`);
  // t-pick: finished, waiting for a pick that can no longer be made.
  const picking = contest(refs.pick, "pick-wait", null);
  const builtRun = run(refs.pick, "lease-pick", lane(picking, 1, "built"), "built");
  hold(refs.pick, "contest", String(picking), "compare and pick");
  page(`contest-pick-wait:${picking}`);
  // t-terms: approved race terms, never raced.
  terms(refs.terms, true);
  // t-picked: a decided contest — history only.
  const decided = contest(refs.picked, "picked", null);
  run(refs.picked, "lease-picked", lane(decided, 1, "built"), "built");
  // t-plain: ordinary work with its own question and hold — untouched.
  const plainRun = run(refs.plain, "lease-plain", null, "parked");
  const plainQuestion = question(plainRun, null);
  hold(refs.plain, "decision", String(plainQuestion), "ordinary question");
  hold(refs.plain, "operator", String(refs.plain), "waiting on legal");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();

  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(116);
  const raw = store.handle;
  expect(raw.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(116);
  // The tables and their indexes are gone; the history columns stay without their foreign key.
  expect(raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('tournament_terms','contest','contestant','tournament_terms_one_active','contest_by_task','one_open_decision_per_contestant')").all()).toEqual([]);
  for (const table of ["run", "decision", "execution_slot"]) {
    const sql = String(raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.["sql"]);
    expect(sql).toMatch(/contestant\s+INTEGER/);
    expect(sql).not.toMatch(/REFERENCES contest/);
  }
  expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(raw.prepare("PRAGMA integrity_check").all().map(row => row["integrity_check"])).toEqual(["ok"]);
  store.close(); store = undefined;

  const after = snapshot(file);
  // Every run keeps its row and its contestant value; only the attempt still open ends, as interrupted.
  expect(after.run).toEqual([
    { id: buildingRun, task_ref: refs.racing, contestant: building, outcome: "failed", reason: "interrupted" },
    { id: parkedRun, task_ref: refs.racing, contestant: parked, outcome: "parked", reason: null },
    { id: builtRun, task_ref: refs.pick, contestant: expect.any(Number), outcome: "built", reason: null },
    { id: expect.any(Number), task_ref: refs.picked, contestant: expect.any(Number), outcome: "built", reason: null },
    { id: plainRun, task_ref: refs.plain, contestant: null, outcome: "parked", reason: null },
  ]);
  expect(after.slot).toEqual([{ id: expect.any(Number), contestant: building, state: "released" }]);
  expect(after.claim).toEqual([{ lease_id: "lease-race", released_at: expect.any(String), released_by: "recovered" }]);
  // The raced agent's question closes the way exclude closed one; the ordinary question stays open.
  expect(after.decision).toEqual([
    { id: raceQuestion, contestant: parked, state: "answered", closed_reason: "excluded", answered_by: "toolroll update" },
    { id: plainQuestion, contestant: null, state: "open", closed_reason: null, answered_by: null },
  ]);
  // Contest holds and the raced question's hold are gone; each owned task is queued under an operator hold that says why.
  const why = "Several agents were set to build this task. That option was removed in this update; remove this hold to build it with one agent.";
  expect(after.hold).toEqual(expect.arrayContaining([
    { task_ref: refs.plain, owner_kind: "decision", owner_id: String(plainQuestion), reason: "ordinary question" },
    { task_ref: refs.plain, owner_kind: "operator", owner_id: String(refs.plain), reason: "waiting on legal" },
    { task_ref: refs.racing, owner_kind: "operator", owner_id: String(refs.racing), reason: why },
    { task_ref: refs.pick, owner_kind: "operator", owner_id: String(refs.pick), reason: why },
    { task_ref: refs.terms, owner_kind: "operator", owner_id: String(refs.terms), reason: why },
  ]));
  expect(after.hold).toHaveLength(5);
  expect(after.task).toEqual([
    { id: "t-pick", state: "queued" },
    { id: "t-picked", state: "done" },
    { id: "t-plain", state: "queued" },
    { id: "t-racing", state: "queued" },
    { id: "t-terms", state: "queued" },
  ]);
  expect(after.notification).toEqual([
    { dedupe_key: `decision:${raceQuestion}`, resolved_at: expect.any(String) },
    { dedupe_key: `contest-pick-wait:${picking}`, resolved_at: expect.any(String) },
  ]);

  // The settled tasks read as ordinary held work.
  store = openStore(file);
  expect(store.activeHolds(refs.racing, new Date(T0)).map(one => one.ownerKind)).toEqual(["operator"]);
  store.close(); store = undefined;

  // A second open changes nothing.
  expect(snapshot(file)).toEqual(after);
  store = openStore(file);
  store.close(); store = undefined;
  expect(snapshot(file)).toEqual(after);
});

test("a fresh v115 database never creates the contest tables, and writes no contestant", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v115-fresh-"));
  store = openStore(join(dir, "state.db"));
  expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name IN ('tournament_terms','contest','contestant','one_open_decision_per_contestant')").all()).toEqual([]);
  expect(String(store.handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'run'").get()?.["sql"])).not.toMatch(/REFERENCES contestant/);
});
