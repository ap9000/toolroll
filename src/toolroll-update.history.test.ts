import { test, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { changedHistory, historySnapshot, RETIRED_TABLES } from "./toolroll-update.js";
import { V115_DROPPED_TABLES } from "./store.js";

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
    CREATE TABLE notification_delivery(notification INTEGER NOT NULL REFERENCES notification(id), destination TEXT NOT NULL, claim_owner TEXT, claim_generation INTEGER NOT NULL DEFAULT 0,
      claim_expires_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_attempt_at TEXT, last_error TEXT, delivered_at TEXT, receipt TEXT, PRIMARY KEY (notification, destination));
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


test("an approved column drop refuses every non-null saved value, including zero and empty text", () => {
  for (const [column, value] of [["attempts", "0"], ["receipt", "''"], ["last_error", "'failed'"]]) {
    const db = saved();
    try {
      db.exec(`UPDATE notification SET ${column} = ${value} WHERE id = 1`);
      const before = historySnapshot(db);
      expect(before.find(t => t.name === "notification")!.nonNull?.[column!]).toBe(1);
      db.exec(`ALTER TABLE notification DROP COLUMN ${column}`);
      expect(changedHistory(db, before)).toEqual(["notification"]);
    } finally { db.close(); }
  }
});

const LEGACY_STATES = "UPDATE notification SET attempts = 0; UPDATE notification SET attempts = 1, delivered_at = 'd1', receipt = '' WHERE id = 1; UPDATE notification SET attempts = 2, last_error = 'failed', claim_owner = 'w', claim_expires_at = 'c2' WHERE id = 2;";
const COLUMNS = "attempts, last_attempt_at, last_error, delivered_at, receipt, claim_owner, claim_expires_at";
const DROP = COLUMNS.split(", ").map(c => `ALTER TABLE notification DROP COLUMN ${c};`).join("");
const carried = (where = "") => `INSERT INTO notification_delivery (notification, destination, ${COLUMNS}) SELECT id, 'legacy:single-destination', ${COLUMNS} FROM notification ${where};`;
const transfer = (edit: string) => { const db = saved(); try { db.exec(LEGACY_STATES); const before = historySnapshot(db); db.exec(edit); return changedHistory(db, before); } finally { db.close(); } };

test("v114's populated delivery columns may go only when legacy receipts carry every value", () => {
  // Zero, empty text, a delivery, a failure and a claim: all carried, so the drop keeps history.
  expect(transfer(carried() + DROP)).toEqual([]);
  // A direct drop, a receipt missing for a row, or a value lost in the copy still changes history.
  expect(transfer(DROP)).toEqual(["notification"]);
  expect(transfer(carried("WHERE id = 1") + DROP)).toEqual(["notification", "notification_delivery"]);
  expect(transfer(carried() + "UPDATE notification_delivery SET last_error = NULL WHERE destination = 'legacy:single-destination';" + DROP)).toEqual(["notification"]);
  // Receipts under any other destination, or legacy ones with no drop, are not a transfer.
  expect(transfer(carried().replace("'legacy:single-destination'", "'slack:abc'") + DROP)).toEqual(["notification", "notification_delivery"]);
  expect(transfer(carried())).toEqual(["notification_delivery"]);
});

/** The v114 shapes v115 removes or fills: two routines (one approved and running, one never approved), the other
 * removed features' tables, and one flow with a trigger a person made. */
function routined(): DatabaseSync {
  const db = saved();
  db.exec(`CREATE TABLE routine(id INTEGER PRIMARY KEY, name TEXT, repo TEXT, digest TEXT, approved_at TEXT, approved_digest TEXT, approved_profile_json TEXT, approved_route_json TEXT, paused INTEGER);
    CREATE TABLE routine_fire(id INTEGER PRIMARY KEY, routine_id INTEGER REFERENCES routine(id), outcome TEXT);
    CREATE TABLE flow(id INTEGER PRIMARY KEY, repo TEXT, name TEXT, state TEXT);
    CREATE TABLE flow_trigger(id INTEGER PRIMARY KEY, flow INTEGER REFERENCES flow(id), kind TEXT, config_json TEXT, state TEXT);
    INSERT INTO routine VALUES(1,'nightly','/w/site','d1','a','d1','{}','{}',0),(2,'audit','/w/site','d2',NULL,NULL,NULL,NULL,0);
    INSERT INTO routine_fire VALUES(1,1,'fired');
    INSERT INTO flow VALUES(1,'/w/site','Triage','active');
    INSERT INTO flow_trigger VALUES(1,1,'button','{}','active');`);
  for (const table of RETIRED_TABLES.filter(one => !one.startsWith("routine"))) db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY, note TEXT); INSERT INTO ${table}(note) VALUES('history')`);
  return db;
}
const RETIRE = [...RETIRED_TABLES].reverse().map(table => `DROP TABLE ${table};`).join("");
const flowOf = (id: number, name: string) => `INSERT INTO flow VALUES(${id},'/w/site','${name}','active');`;
const triggerOf = (id: number, flow: number, routine: number, state = "paused") =>
  `INSERT INTO flow_trigger VALUES(${id},${flow},'schedule','{"kind":"schedule","order":{"routine":${routine}}}','${state}');`;
const MOVED = flowOf(2, "nightly") + flowOf(3, "audit") + triggerOf(2, 2, 1, "active") + triggerOf(3, 3, 2);
const moves = (edit: string) => { const db = routined(); try { const before = historySnapshot(db); db.exec(edit); return changedHistory(db, before); } finally { db.close(); } };

test("v115 retires exactly the removed features' tables and adds only the flows and triggers its routines became", () => {
  expect([...RETIRED_TABLES].sort()).toEqual([...V115_DROPPED_TABLES].sort());
  expect(moves(MOVED + RETIRE)).toEqual([]);
  // An undeclared table dropped beside them, or the ledger changed, is still refused.
  expect(moves(MOVED + RETIRE + "DROP TABLE task;")).toEqual(["task"]);
  expect(moves(MOVED + RETIRE + "UPDATE action_ledger SET action='rewritten' WHERE seq=1;")).toEqual(["action_ledger"]);
  // The routines dropped with no flows, or with one missing: the move didn't account for them.
  expect(moves(RETIRE)).toEqual(["flow", "flow_trigger"]);
  expect(moves(flowOf(2, "nightly") + triggerOf(2, 2, 1, "active") + RETIRE)).toEqual(["flow", "flow_trigger"]);
  // A surplus flow or trigger, or one a routine never named.
  expect(moves(MOVED + flowOf(4, "extra") + RETIRE)).toEqual(["flow"]);
  expect(moves(MOVED + triggerOf(4, 2, 1) + RETIRE)).toEqual(["flow_trigger"]);
  expect(moves(flowOf(2, "nightly") + flowOf(3, "audit") + triggerOf(2, 2, 1, "active") + triggerOf(3, 3, 9) + RETIRE)).toEqual(["flow_trigger"]);
  // A trigger hung on a flow the move didn't add, or on the other routine's flow.
  expect(moves(flowOf(2, "nightly") + flowOf(3, "audit") + triggerOf(2, 1, 1, "active") + triggerOf(3, 3, 2) + RETIRE)).toEqual(["flow_trigger"]);
  expect(moves(flowOf(2, "nightly") + flowOf(3, "audit") + triggerOf(2, 3, 1, "active") + triggerOf(3, 2, 2) + RETIRE)).toEqual(["flow_trigger"]);
  // The never-approved routine arrives paused; turned on, it is refused.
  expect(moves(flowOf(2, "nightly") + flowOf(3, "audit") + triggerOf(2, 2, 1, "active") + triggerOf(3, 3, 2, "active") + RETIRE)).toEqual(["flow_trigger"]);
  // Rows a person already had stay as they were.
  expect(moves(MOVED + RETIRE + "UPDATE flow SET name='Renamed' WHERE id=1;")).toEqual(["flow"]);
  expect(moves(MOVED + RETIRE + "UPDATE flow_trigger SET state='paused' WHERE id=1;")).toEqual(["flow_trigger"]);
  // With no routines saved, a flow or trigger appearing is not a move.
  const db = saved();
  try {
    db.exec("CREATE TABLE flow(id INTEGER PRIMARY KEY, repo TEXT, name TEXT, state TEXT); CREATE TABLE flow_trigger(id INTEGER PRIMARY KEY, flow INTEGER, kind TEXT, config_json TEXT, state TEXT);");
    const before = historySnapshot(db);
    db.exec(flowOf(1, "nightly") + triggerOf(1, 1, 1));
    expect(changedHistory(db, before)).toEqual(["flow", "flow_trigger"]);
  } finally { db.close(); }
});

test("v116: an old chat table may go only when every row arrived in the shared table, each fan-in source counted on its own", () => {
  const OLD = `CREATE TABLE telegram_decision_message(binding INTEGER, chat_id TEXT, message_id TEXT, decision INTEGER, created_at TEXT);
    CREATE TABLE telegram_outbound_message(binding INTEGER, chat_id TEXT, message_id TEXT, notification INTEGER, created_at TEXT);
    CREATE TABLE slack_binding(id INTEGER PRIMARY KEY, member TEXT);
    INSERT INTO telegram_decision_message VALUES(1,'c','m1',7,'t');
    INSERT INTO telegram_outbound_message VALUES(1,'c','m2',1,'t'),(1,'c','m3',2,'t'),(1,'c','m4',2,'t');
    INSERT INTO slack_binding VALUES(1,'U1')`;
  const SHARED = `CREATE TABLE chat_message_ref(provider TEXT, binding INTEGER, chat TEXT, message TEXT, kind TEXT, notification INTEGER, decision INTEGER);
    CREATE TABLE chat_binding(provider TEXT, id INTEGER, member TEXT);`;
  const DROP = "DROP TABLE telegram_decision_message; DROP TABLE telegram_outbound_message; DROP TABLE slack_binding;";
  const move = (copy: string) => { const db = saved(); try { db.exec(OLD); const before = historySnapshot(db); db.exec(SHARED + copy + DROP); return changedHistory(db, before); } finally { db.close(); } };
  const decision = "INSERT INTO chat_message_ref VALUES('telegram',1,'c','m1','decision',NULL,7);";
  const outbound = "INSERT INTO chat_message_ref SELECT 'telegram',binding,chat_id,message_id,'notification',notification,NULL FROM telegram_outbound_message;";
  const slack = "INSERT INTO chat_binding SELECT 'slack',id,member FROM slack_binding;";
  expect(move(decision + outbound + slack)).toEqual([]);
  // A lost row, a row filed under the wrong app, or a fan-in source whose rows never arrived: each is refused.
  expect(move(decision + outbound.replace("FROM telegram_outbound_message", "FROM telegram_outbound_message WHERE message_id <> 'm4'") + slack)).toEqual(["telegram_outbound_message"]);
  expect(move(decision + outbound + slack.replace("'slack'", "'discord'"))).toEqual(["slack_binding"]);
  expect(move(outbound + slack)).toEqual(["telegram_decision_message"]);
  // A table with no rule still may not disappear.
  expect(changes("DROP TABLE task")).toEqual(["task"]);
});
