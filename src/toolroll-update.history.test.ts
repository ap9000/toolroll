import { test, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

/** A small saved database: the ledger tables, an ordinary table, a WITHOUT ROWID one and the v113 shapes v114 changes. */
function saved(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(113);
    CREATE TABLE action_ledger(seq INTEGER PRIMARY KEY, at TEXT, action TEXT, hash TEXT);
    CREATE TABLE ledger_seal(id INTEGER PRIMARY KEY, through INTEGER, signature TEXT);
    CREATE TABLE ledger_checkpoint(id INTEGER PRIMARY KEY, through INTEGER, head TEXT);
    CREATE TABLE task(id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE setting(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
    CREATE TABLE run(id INTEGER PRIMARY KEY, finished_at TEXT);
    CREATE TABLE run_process(id INTEGER PRIMARY KEY, run INTEGER REFERENCES run(id), pid INTEGER, observed_at TEXT, exited_at TEXT);
    CREATE TABLE notification(id INTEGER PRIMARY KEY, kind TEXT, attempts INTEGER, last_attempt_at TEXT, last_error TEXT, delivered_at TEXT, receipt TEXT, claim_owner TEXT, claim_expires_at TEXT);
    INSERT INTO action_ledger VALUES(1,'a','started','h1'),(2,'b','finished','h2');
    INSERT INTO ledger_seal VALUES(1,2,'sig');
    INSERT INTO task VALUES('T-1','Keep my work'),('T-2','And this');
    INSERT INTO setting VALUES('theme','dark');
    INSERT INTO run VALUES(1,'x'),(2,NULL);
    INSERT INTO run_process VALUES(1,1,10,'o1','e1'),(2,1,11,'o2','e2'),(3,1,12,'o3','e3'),(4,2,13,'o4',NULL);
    INSERT INTO notification(kind) VALUES('ready'),('failed');`);
  return db;
}
const changes = (edit: string) => { const db = saved(); try { const before = historySnapshot(db); db.exec(edit); return changedHistory(db, before); } finally { db.close(); } };
const COMPACT = `CREATE TABLE run_process_summary(run INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE, witnesses INTEGER NOT NULL, process_groups INTEGER NOT NULL,
  first_observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL, last_exited_at TEXT NOT NULL, settled_at TEXT NOT NULL);`;

test("an unchanged database, and one that only adds tables, rows to the ledger or new columns, keeps its history", () => {
  expect(changes("")).toEqual([]);
  expect(changes("CREATE TABLE fresh(x); ALTER TABLE task ADD COLUMN note TEXT; INSERT INTO ledger_checkpoint VALUES(1,2,'h2'); INSERT INTO action_ledger VALUES(3,'c','checkpoint','h3')")).toEqual([]);
});

test("a snapshot is bounded: ordinary tables are only counted, never read row by row", () => {
  const db = saved();
  try {
    db.exec("CREATE TABLE big(id INTEGER PRIMARY KEY, body TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 50000) INSERT INTO big SELECT i, 'row ' || i FROM n");
    const read: string[] = [], prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => { const s = prepare(sql); const all = s.all.bind(s); s.all = (...a: never[]) => { read.push(sql); return all(...a); }; return s; };
    const before = historySnapshot(db);
    expect(before.find(t => t.name === "big")).toMatchObject({ count: 50000, last: 50000 });
    expect(before.find(t => t.name === "big")!.hash).toBeUndefined();
    db.exec("UPDATE big SET body = 'rewritten' WHERE id = 7");
    expect(changedHistory(db, before)).toEqual([]);
    expect(read.filter(sql => /"big"|"task"|"run_process"|"notification"/.test(sql) && !/^PRAGMA table_info|count\(\*\)/.test(sql))).toEqual([]);
    db.exec("DELETE FROM big WHERE id = 7; INSERT INTO big(body) VALUES('replaced')");
    expect(changedHistory(db, before)).toEqual(["big"]);
  } finally { db.close(); }
});

test("an edited ledger or seal row is refused; a removed one too", () => {
  expect(changes("UPDATE action_ledger SET action='rewritten' WHERE seq=1")).toEqual(["action_ledger"]);
  expect(changes("UPDATE ledger_seal SET signature='forged'")).toEqual(["ledger_seal"]);
  expect(changes("DELETE FROM action_ledger WHERE seq=2; INSERT INTO action_ledger VALUES(3,'b','finished','h2')")).toEqual(["action_ledger"]);
  expect(changes("UPDATE setting SET value='light'")).toEqual(["setting"]);
});

test("a deleted or added ordinary row is refused", () => {
  expect(changes("DELETE FROM task WHERE id='T-2'")).toEqual(["task"]);
  expect(changes("INSERT INTO task VALUES('T-3','new')")).toEqual(["task"]);
  expect(changes("DROP TABLE task")).toEqual(["task"]);
});

test("a dropped column is refused unless the new schema declares it", () => {
  expect(changes("ALTER TABLE task DROP COLUMN title")).toEqual(["task"]);
  expect(changes("ALTER TABLE notification DROP COLUMN kind")).toEqual(["notification"]);
  expect(changes(["attempts", "last_attempt_at", "last_error", "delivered_at", "receipt", "claim_owner", "claim_expires_at"].map(c => `ALTER TABLE notification DROP COLUMN ${c};`).join(""))).toEqual([]);
  expect(changes("ALTER TABLE notification DROP COLUMN receipt; DELETE FROM notification WHERE id=2")).toEqual(["notification"]);
});

test("v114 run_process compaction passes only when the summary accounts for every removed witness", () => {
  expect(changes(COMPACT + "DELETE FROM run_process WHERE run=1; INSERT INTO run_process_summary VALUES(1,3,1,'o1','o3','e3','now')")).toEqual([]);
  expect(changes(COMPACT + "DELETE FROM run_process WHERE run=1")).toEqual(["run_process"]);
  expect(changes(COMPACT + "DELETE FROM run_process WHERE run=1; INSERT INTO run_process_summary VALUES(1,2,1,'o1','o3','e3','now')")).toEqual(["run_process"]);
  expect(changes(COMPACT + "INSERT INTO run_process VALUES(5,2,14,'o5',NULL)")).toEqual(["run_process"]);
  // A summary already saved is history too: a second compaction may only add to it.
  const db = saved();
  try {
    db.exec(COMPACT + "DELETE FROM run_process WHERE run=1; INSERT INTO run_process_summary VALUES(1,3,1,'o1','o3','e3','now')");
    const before = historySnapshot(db);
    db.exec("DELETE FROM run_process WHERE run=2; INSERT INTO run_process_summary VALUES(2,1,1,'o4','o4','e4','later')");
    expect(changedHistory(db, before)).toEqual([]);
    db.exec("UPDATE run_process_summary SET witnesses=9 WHERE run=1");
    expect(changedHistory(db, before)).toEqual(["run_process", "run_process_summary"]);
  } finally { db.close(); }
});
