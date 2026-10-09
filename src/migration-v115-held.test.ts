/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { register } from "./runner.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

/** The v114 held-session tables and indexes, exactly as the fresh schema created them before v115 removed them. */
const V114_HELD_DDL = `
CREATE TABLE attended_authorization (
  id                TEXT PRIMARY KEY,
  task_ref          INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  approver          TEXT NOT NULL,
  runner            TEXT NOT NULL,
  runner_generation INTEGER NOT NULL,
  composite_digest  TEXT NOT NULL,
  terms_json        TEXT NOT NULL,
  max_session_turns INTEGER NOT NULL,
  budget_microusd   INTEGER NOT NULL,
  parent_run        INTEGER REFERENCES run(id),
  followup          TEXT,
  created_at        TEXT NOT NULL,
  absolute_expiry   TEXT NOT NULL,
  last_beat_at      TEXT,
  attempt_run       INTEGER UNIQUE REFERENCES run(id),
  consumed_at       TEXT,
  closed_at         TEXT,
  end_reason        TEXT,
  authority_basis   TEXT NOT NULL DEFAULT 'password' CHECK (authority_basis IN ('password','mode')),
  mode_digest       TEXT
);
CREATE TABLE session_turn (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run                INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('brief','answer','operator','repair')),
  source_id          INTEGER,
  author             TEXT,
  text               TEXT NOT NULL,
  reserved_microusd  INTEGER NOT NULL,
  accounted_microusd INTEGER,
  accounted_at       TEXT,
  recorded_at        TEXT NOT NULL,
  written_at         TEXT,
  accepted_at        TEXT,
  settled_at         TEXT,
  measured_microusd  INTEGER,
  output_tokens      INTEGER,
  state              TEXT NOT NULL DEFAULT 'recorded'
                       CHECK (state IN ('recorded','written','accepted','settled','uncertain','cancelled')),
  UNIQUE (run, seq)
);
CREATE TABLE held_session (
  run                   INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  authorization_id      TEXT NOT NULL REFERENCES attended_authorization(id),
  runner                TEXT NOT NULL,
  lease_id              TEXT NOT NULL,
  up_incarnation        TEXT NOT NULL,
  cookie                TEXT NOT NULL,
  socket_path           TEXT NOT NULL,
  supervisor_pid        INTEGER,
  agent_pgid            INTEGER,
  cumulative_microusd   INTEGER NOT NULL DEFAULT 0,
  cumulative_tokens_out INTEGER NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','fencing')),
  fencer                TEXT,
  fencing_deadline      TEXT,
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  end_reason            TEXT
);
CREATE UNIQUE INDEX one_open_authorization_per_task ON attended_authorization (task_ref) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX session_turn_answer_once ON session_turn (source_kind, source_id)
  WHERE source_kind = 'answer' AND state NOT IN ('uncertain','cancelled');
CREATE INDEX decision_undelivered ON decision (run, id) WHERE state = 'answered' AND delivered_turn IS NULL;`;

const T0 = "2026-10-07T09:00:00.000Z";
const FUTURE = "2026-10-07T21:00:00.000Z";
const HELD_NAMES = "('attended_authorization','session_turn','held_session','one_open_authorization_per_task','session_turn_answer_once','decision_undelivered')";

/** Every kept row the migration may touch, for exact before/after comparison. */
function snapshot(file: string): Record<string, unknown[]> {
  const db = new DatabaseSync(file);
  try {
    const all = (sql: string) => db.prepare(sql).all().map(row => ({ ...row }));
    return {
      task: all("SELECT id, state FROM task ORDER BY id"),
      run: all("SELECT id, task_ref, attended_authorization, outcome, reason FROM run ORDER BY id"),
      decision: all("SELECT id, run, state, session_turn, delivered_turn FROM decision ORDER BY id"),
      claim: all("SELECT lease_id, released_at, released_by FROM claim ORDER BY lease_id"),
      worktree: all("SELECT path, task_ref, released_at, verified FROM worktree ORDER BY path"),
      schema: all("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name"),
    };
  } finally {
    db.close();
  }
}

test("v114 → v115: held sessions go, and the attempt one still owned ends as an ordinary interrupted attempt", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v115-held-"));
  const file = join(dir, "state.db");
  const first = openStore(file);
  register(first, { name: "runner-a", host: "test", repos: [], now: new Date(T0), newToken: () => "tok-runner-a" });
  for (const id of ["t-held", "t-ended", "t-minted", "t-plain"]) first.createTask({ id, title: id }, new Date(T0));
  const ref = (id: string) => first.refFor("built-in", id).id;
  const refs = { held: ref("t-held"), ended: ref("t-ended"), minted: ref("t-minted"), plain: ref("t-plain") };
  first.close();

  // The v114 shape: the three tables, their indexes, the references from run and decision, and v114.
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(V114_HELD_DDL);
  const version = Number(db.prepare("PRAGMA schema_version").get()?.["schema_version"]);
  (db as unknown as { enableDefensive?: (on: boolean) => void }).enableDefensive?.(false); // Node 24 opens defensive
  db.exec("PRAGMA writable_schema = ON");
  const reference = (table: string, rewrite: (sql: string) => string) => {
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.["sql"]);
    const referenced = rewrite(sql);
    expect(referenced).not.toBe(sql);
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?").run(referenced, table);
  };
  reference("run", sql => sql.replace(/(\n\s*attended_authorization\s+TEXT)(,)/, "$1 REFERENCES attended_authorization(id)$2"));
  reference("decision", sql => sql
    .replace(/(\n\s*session_turn\s+INTEGER)(,)/, "$1 REFERENCES session_turn(id)$2")
    .replace(/(\n\s*delivered_turn\s+INTEGER)(\s*\n\))/, "$1 REFERENCES session_turn(id)$2"));
  db.exec(`PRAGMA schema_version = ${version + 1}`);
  db.exec("PRAGMA writable_schema = OFF");
  db.prepare("UPDATE schema_version SET version = 114").run();

  const run = (taskRef: number, lease: string, authorization: string | null, outcome: string | null) =>
    Number(db.prepare("INSERT INTO run (task_ref, lease_id, runner, branch, worktree, attended_authorization, outcome, started_at) VALUES (?, ?, 'runner-a', 'so/x', ?, ?, ?, ?)")
      .run(taskRef, lease, `/tmp/wt-${lease}`, authorization, outcome, T0).lastInsertRowid);
  const authorize = (id: string, taskRef: number, attemptRun: number | null, closed: boolean) =>
    db.prepare(`INSERT INTO attended_authorization (id, task_ref, approver, runner, runner_generation, composite_digest, terms_json, max_session_turns,
        budget_microusd, created_at, absolute_expiry, last_beat_at, attempt_run, consumed_at, closed_at, end_reason)
      VALUES (?, ?, 'alex', 'runner-a', 1, 'd', '{}', 4, 1000000, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, taskRef, T0, FUTURE, T0, attemptRun, attemptRun === null ? null : T0, closed ? T0 : null, closed ? "finished" : null);
  const custody = (runId: number, authorization: string, lease: string, ended: boolean) =>
    db.prepare(`INSERT INTO held_session (run, authorization_id, runner, lease_id, up_incarnation, cookie, socket_path, started_at, ended_at, end_reason)
      VALUES (?, ?, 'runner-a', ?, 'inc-1', 'secret-cookie', '/tmp/so.sock', ?, ?, ?)`)
      .run(runId, authorization, lease, T0, ended ? T0 : null, ended ? "finished" : null);
  const turn = (runId: number, seq: number, kind: string, sourceId: number | null) =>
    Number(db.prepare("INSERT INTO session_turn (run, seq, source_kind, source_id, text, reserved_microusd, recorded_at, state) VALUES (?, ?, ?, ?, 'words', 1000, ?, 'settled')")
      .run(runId, seq, kind, sourceId, T0).lastInsertRowid);
  const claim = (lease: string, taskRef: number, released: boolean) =>
    db.prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at, released_by) VALUES (?, ?, 1, 'runner-a', ?, ?, ?, ?, ?)")
      .run(lease, taskRef, T0, FUTURE, T0, released ? T0 : null, released ? "completed" : null);
  const checkout = (lease: string, taskRef: number) =>
    db.prepare("INSERT INTO worktree (path, repo, branch, runner, task_ref, created_at, leased_at, verified) VALUES (?, '/repo', 'so/x', 'runner-a', ?, ?, ?, 1)")
      .run(`/tmp/wt-${lease}`, taskRef, T0, T0);
  db.prepare("UPDATE task SET state = 'running' WHERE id IN ('t-held', 't-plain')").run();
  db.prepare("UPDATE task SET state = 'done' WHERE id = 't-ended'").run();

  // t-held: a live held session — claim, checkout, open run bound to its authorization, its turns, and an answered
  // question the session already delivered.
  claim("lease-held", refs.held, false);
  checkout("lease-held", refs.held);
  authorize("auth-held", refs.held, null, false);
  const heldRun = run(refs.held, "lease-held", "auth-held", null);
  db.prepare("UPDATE attended_authorization SET attempt_run = ?, consumed_at = ? WHERE id = 'auth-held'").run(heldRun, T0);
  custody(heldRun, "auth-held", "lease-held", false);
  turn(heldRun, 1, "brief", null);
  const parkTurn = turn(heldRun, 2, "operator", null);
  const asked = Number(db.prepare("INSERT INTO decision (run, urgency, state, recap, question, options, recommendation, created_at, answered_at, answered_by, choice, session_turn) VALUES (?, 'blocking', 'answered', 'r', 'q?', '[]', 'a', ?, ?, 'alex', 'go', ?)")
    .run(heldRun, T0, T0, parkTurn).lastInsertRowid);
  const answerTurn = turn(heldRun, 3, "answer", asked);
  db.prepare("UPDATE decision SET delivered_turn = ? WHERE id = ?").run(answerTurn, asked);
  // t-ended: a held session that finished and built — history only.
  claim("lease-ended", refs.ended, true);
  authorize("auth-ended", refs.ended, null, true);
  const endedRun = run(refs.ended, "lease-ended", "auth-ended", "built");
  db.prepare("UPDATE attended_authorization SET attempt_run = ? WHERE id = 'auth-ended'").run(endedRun);
  custody(endedRun, "auth-ended", "lease-ended", true);
  // t-minted: an open authorization that never dispatched — it simply goes.
  authorize("auth-minted", refs.minted, null, false);
  // t-plain: an ordinary attempt mid-build under its own live claim — untouched.
  claim("lease-plain", refs.plain, false);
  checkout("lease-plain", refs.plain);
  const plainRun = run(refs.plain, "lease-plain", null, null);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();

  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(115);
  const raw = store.handle;
  expect(raw.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(115);
  // The tables and their indexes are gone (the one on decision too); the history columns stay without their foreign key.
  expect(raw.prepare(`SELECT name FROM sqlite_master WHERE name IN ${HELD_NAMES}`).all()).toEqual([]);
  const runSql = String(raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run'").get()?.["sql"]);
  expect(runSql).toMatch(/attended_authorization\s+TEXT/);
  const decisionSql = String(raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'decision'").get()?.["sql"]);
  expect(decisionSql).toMatch(/session_turn\s+INTEGER/);
  expect(decisionSql).toMatch(/delivered_turn\s+INTEGER/);
  expect(`${runSql}\n${decisionSql}`).not.toMatch(/REFERENCES (attended_authorization|session_turn)/);
  expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(raw.prepare("PRAGMA integrity_check").all().map(row => row["integrity_check"])).toEqual(["ok"]);
  store.close(); store = undefined;

  const after = snapshot(file);
  // Every run keeps its row and its authorization value; only the attempt the open session owned ends, as interrupted.
  expect(after.run).toEqual([
    { id: heldRun, task_ref: refs.held, attended_authorization: "auth-held", outcome: "failed", reason: "interrupted" },
    { id: endedRun, task_ref: refs.ended, attended_authorization: "auth-ended", outcome: "built", reason: null },
    { id: plainRun, task_ref: refs.plain, attended_authorization: null, outcome: null, reason: null },
  ]);
  // Its claim is handed back the way an interrupted attempt's is; other claims are untouched.
  expect(after.claim).toEqual([
    { lease_id: "lease-ended", released_at: T0, released_by: "completed" },
    { lease_id: "lease-held", released_at: expect.any(String), released_by: "interrupted" },
    { lease_id: "lease-plain", released_at: null, released_by: null },
  ]);
  // Its checkout is released unverified, the work left on disk; the ordinary one keeps its lease.
  expect(after.worktree).toEqual([
    { path: "/tmp/wt-lease-held", task_ref: refs.held, released_at: expect.any(String), verified: 0 },
    { path: "/tmp/wt-lease-plain", task_ref: refs.plain, released_at: null, verified: 1 },
  ]);
  // The question stays answered, its turn links kept as history.
  expect(after.decision).toEqual([{ id: asked, run: heldRun, state: "answered", session_turn: parkTurn, delivered_turn: answerTurn }]);
  // The task returns to the queue; the rest keep their states.
  expect(after.task).toEqual([
    { id: "t-ended", state: "done" },
    { id: "t-held", state: "queued" },
    { id: "t-minted", state: "queued" },
    { id: "t-plain", state: "running" },
  ]);

  // The settled task reads as ordinary ready work again: no live claim, no open run.
  store = openStore(file);
  expect(store.currentLiveLease(refs.held, new Date(T0))).toBeNull();
  expect(store.getRun(heldRun)).toMatchObject({ outcome: "failed", reason: "interrupted" });
  store.close(); store = undefined;

  // A second open changes nothing.
  expect(snapshot(file)).toEqual(after);
  store = openStore(file);
  store.close(); store = undefined;
  expect(snapshot(file)).toEqual(after);
});

test("a fresh v115 database never creates the held-session tables, and its runs and decisions name none", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v115-held-fresh-"));
  store = openStore(join(dir, "state.db"));
  expect(store.handle.prepare(`SELECT name FROM sqlite_master WHERE name IN ${HELD_NAMES}`).all()).toEqual([]);
  for (const table of ["run", "decision"]) {
    expect(String(store.handle.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table)?.["sql"])).not.toMatch(/REFERENCES (attended_authorization|session_turn)/);
  }
});
