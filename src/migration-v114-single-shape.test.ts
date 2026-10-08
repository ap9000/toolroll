/** v114: the schema version names one exact shape. A current file opens with its connection settings and no DDL; the
 * one-time upgrade drops the workspace triggers, rebuilds notification without its unused delivery columns and compacts
 * every settled run's exited process witnesses into one summary. Isolated fixtures only. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Database, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date("2026-10-07T09:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const legacy = { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const };
const DROPPED = ["attempts INTEGER", "last_attempt_at TEXT", "last_error TEXT", "delivered_at TEXT", "receipt TEXT", "claim_owner TEXT", "claim_expires_at TEXT"];

/** Every statement a connection is asked to run, in order. */
function traced(): { connect: (path: string) => Database; statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    connect: path => {
      const db = new DatabaseSync(path);
      return new Proxy(db, {
        get(target, property) {
          if (property === "exec") return (sql: string) => { statements.push(sql); target.exec(sql); };
          if (property === "prepare") return (sql: string) => { statements.push(sql); return target.prepare(sql); };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as Database;
    },
  };
}
const writes = (statements: string[]) => statements.filter(sql => /^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|BEGIN|SAVEPOINT|VACUUM)\b/i.test(sql));

/** A v113 file as the previous build left it: notification with its delivery columns, the per-table workspace
 * triggers, and the raw witnesses of a settled run, an unsettled finished run and an open run. */
function v113(): { file: string; settled: number; lingering: number; open: number } {
  dir = mkdtempSync(join(tmpdir(), "so-v114-"));
  const file = join(dir, "state.db");
  const first = openStore(file);
  const runs: number[] = [];
  for (const id of ["settled", "lingering", "open"]) {
    first.createTask({ id, title: id }, NOW);
    const ref = first.refFor("built-in", id).id;
    runs.push(first.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "b1", branch: `so/${id}`, worktree: `/w/${id}`, route: legacy, now: NOW }));
  }
  const [settled, lingering, open] = runs as [number, number, number];
  first.finishRun(settled, { outcome: "built", now: new Date(at(60_000)) });
  first.finishRun(lingering, { outcome: "failed", now: new Date(at(60_000)) });
  first.enqueueNotification({ source: { installation: true }, dedupeKey: "one", kind: "test", subject: "One", body: "first" }, NOW);
  first.enqueueNotification({ source: { installation: true }, dedupeKey: "two", kind: "test", subject: "Two", body: "second" }, NOW);
  first.close();
  const db = new DatabaseSync(file);
  for (const column of DROPPED) db.exec(`ALTER TABLE notification ADD COLUMN ${column}`);
  db.exec("CREATE TRIGGER workspace_revision_v1_task_insert_0123456789abcdef AFTER INSERT ON task BEGIN UPDATE service_cursor SET value = value + 1 WHERE key = 'workspace-content:v1'; END");
  const witness = db.prepare("INSERT INTO run_process (run, pid, host, process_group, observed_at, exited_at, boot_id) VALUES (?, ?, ?, ?, ?, ?, 'boot')");
  // A settled run: many short-lived witnesses, every one exited.
  for (let i = 0; i < 50; i++) witness.run(settled, 1000 + i, hostname(), i % 2, at(i * 100), at(i * 100 + 50));
  // A finished run with one witness whose exit is unproven, and an open run: both keep every row.
  witness.run(lingering, 3000, hostname(), 1, at(0), at(10));
  witness.run(lingering, 3001, hostname(), 1, at(0), null);
  witness.run(open, 4000, hostname(), 1, at(0), at(10));
  db.exec("UPDATE schema_version SET version = 113");
  db.close();
  return { file, settled, lingering, open };
}

test("the upgrade runs once: settled witnesses become one summary, notification keeps every row and id, the triggers go", () => {
  const { file, settled, lingering, open } = v113();
  const history = new DatabaseSync(file, { readOnly: true });
  const before = historySnapshot(history);
  const notifications = history.prepare("SELECT id, dedupe_key, subject, body, created_at FROM notification ORDER BY id").all();
  const sequence = history.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY rowid").all();
  history.close();

  const first = traced();
  store = openStore(file, { connect: first.connect });
  expect(writes(first.statements).length).toBeGreaterThan(0);
  const db = store.handle;
  expect(db.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
  expect(db.prepare("SELECT name FROM pragma_table_info('notification') ORDER BY cid").all().map(row => row["name"]))
    .toEqual(["id", "dedupe_key", "kind", "subject", "body", "created_at", "push_class", "link", "resolved_at", "provenance_scope", "project", "task_ref", "task_id", "source_run", "recipient"]);
  expect(db.prepare("SELECT id, dedupe_key, subject, body, created_at FROM notification ORDER BY id").all()).toEqual(notifications);
  expect(db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY rowid").all()).toEqual(sequence);
  expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workspace_revision_%'").get()?.["n"]).toBe(0);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  // The settled run: one summary, no raw rows. Its exits stay proven, so nothing waits on a person.
  expect(db.prepare("SELECT COUNT(*) AS n FROM run_process WHERE run = ?").get(settled)?.["n"]).toBe(0);
  const settledGroups = 25; // a count of groups, not a process ID
  expect(db.prepare("SELECT witnesses, process_groups, first_observed_at, last_observed_at, last_exited_at FROM run_process_summary WHERE run = ?").get(settled))
    .toEqual({ witnesses: 50, process_groups: settledGroups, first_observed_at: at(0), last_observed_at: at(4900), last_exited_at: at(4950) });
  expect(store.stopQuiescenceFact(settled)).toBeNull();
  expect(store.processesSummarized(settled)).toBe(true);
  // Unsettled custody keeps every row: the finished run with an unproven exit, and the open run.
  expect(db.prepare("SELECT run, COUNT(*) AS n FROM run_process GROUP BY run ORDER BY run").all()).toEqual([{ run: lingering, n: 2 }, { run: open, n: 1 }]);
  expect(store.processesSummarized(lingering) || store.processesSummarized(open)).toBe(false);
  store.close(); store = undefined;

  // The update rehearsal accepts exactly this: rows removed equal witnesses summarized, notification lost only the declared columns.
  const after = new DatabaseSync(file, { readOnly: true });
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }

  // A second open is a current open: connection settings and reads only.
  const second = traced();
  store = openStore(file, { connect: second.connect });
  expect(writes(second.statements)).toEqual([]);
  expect(second.statements.filter(sql => /^\s*PRAGMA\s+(?:journal_mode|foreign_keys|busy_timeout)\b/i.test(sql)).length).toBeGreaterThan(0);
  expect(store.handle.prepare("SELECT witnesses FROM run_process_summary WHERE run = ?").get(settled)?.["witnesses"]).toBe(50);
});

test("a fresh file is the exact shape the upgrade reaches, and opening it again runs no DDL", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v114-fresh-"));
  const file = join(dir, "state.db");
  openStore(file).close();
  const upgraded = v113().file;
  const shape = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return Object.fromEntries(["notification", "run_process", "run_process_summary"].map(table =>
        [table, db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}') ORDER BY cid`).all()]));
    } finally { db.close(); }
  };
  openStore(upgraded).close();
  expect(shape(upgraded)).toEqual(shape(file));
  const again = traced();
  store = openStore(file, { connect: again.connect });
  expect(writes(again.statements)).toEqual([]);
});

test("the worker's reconcile pass compacts a run once it settles, once, and the summary still proves its exits", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v114-settle-"));
  store = openStore(join(dir, "state.db"));
  store.createTask({ id: "t", title: "t" }, NOW);
  const ref = store.refFor("built-in", "t").id;
  const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b1", branch: "so/t", worktree: "/w/t", route: legacy, now: NOW });
  const witness = store.handle.prepare("INSERT INTO run_process (run, pid, host, process_group, observed_at, exited_at) VALUES (?, ?, ?, 1, ?, ?)");
  witness.run(run, 5000, hostname(), at(0), at(5));
  witness.run(run, 5001, hostname(), at(1), at(6));
  // An open run is never compacted, however settled its witnesses look.
  expect(store.recordFinishedRunExits(new Date(at(10)))).toBe(0);
  expect(store.processesSummarized(run)).toBe(false);
  store.finishRun(run, { outcome: "built", now: new Date(at(20)) });
  store.recordFinishedRunExits(new Date(at(30)));
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM run_process WHERE run = ?").get(run)?.["n"]).toBe(0);
  expect(store.handle.prepare("SELECT witnesses, settled_at FROM run_process_summary WHERE run = ?").get(run)).toEqual({ witnesses: 2, settled_at: at(30) });
  // Idempotent: nothing more to do, and the summary is unchanged.
  expect(store.compactRunProcesses(new Date(at(40)))).toBe(0);
  expect(store.handle.prepare("SELECT settled_at FROM run_process_summary WHERE run = ?").get(run)?.["settled_at"]).toBe(at(30));
  // A run with a summary and no witnesses is not "spawned but never witnessed".
  store.handle.prepare("UPDATE run SET provider_started_at = ? WHERE id = ?").run(at(1), run);
  expect(store.stopQuiescenceFact(run)).toBeNull();
  expect(store.runCustodyProvenGone(run)).toBe(true);
});


test("compaction shrinks a large file; a failed reclaim keeps the epoch and retries without duplicating summaries", () => {
  const { file, settled } = v113();
  const db = new DatabaseSync(file);
  db.exec("BEGIN");
  const insert = db.prepare("INSERT INTO run_process (run, pid, host, process_group, observed_at, exited_at) VALUES (?, ?, ?, 1, ?, ?)");
  for (let i = 0; i < 12000; i++) insert.run(settled, 10000 + i, "fixture-host-".repeat(20), at(0), at(1));
  db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  const before = historySnapshot(db); db.close();
  const bytes = statSync(file).size;
  const trace = traced();
  expect(() => openStore(file, { connect: path => {
    const connection = trace.connect(path), exec = connection.exec.bind(connection);
    return new Proxy(connection, { get(target, key) {
      if (key === "exec") return (sql: string) => { if (sql === "VACUUM") throw Error("reclaim failed"); return exec(sql); };
      return Reflect.get(target, key);
    } });
  } })).toThrow("reclaim failed");
  const interrupted = new DatabaseSync(file);
  expect(interrupted.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(-113);
  expect(interrupted.prepare("SELECT witnesses FROM run_process_summary WHERE run = ?").get(settled)?.["witnesses"]).toBe(12050);
  interrupted.close();
  store = openStore(file);
  expect(statSync(file).size).toBeLessThan(bytes / 2);
  expect(store.handle.prepare("PRAGMA freelist_count").get()?.["freelist_count"]).toBe(0);
  expect(store.handle.prepare("SELECT witnesses FROM run_process_summary WHERE run = ?").get(settled)?.["witnesses"]).toBe(12050);
  expect(store.ledgerChain({ full: true }).ok).toBe(true);
  const after = new DatabaseSync(file, { readOnly: true });
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
});
