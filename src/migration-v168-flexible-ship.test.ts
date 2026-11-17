/** v168: Ship for Flexible threads (the Flexible plan v2, slice F4). New tables only: no saved row changes, a crash
 * resumes to the same shape, a send is born approved, written once, its state only moves forward (nothing final comes
 * back), its import ref and branch are its thread's own, and a table in a shape this build can't name refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V168_STEPS } from "./store.js";
import { V168_TABLES } from "./flexible-ship-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = "2026-11-15T00:00:00.000Z";
const THREAD = "a".repeat(32), REQUEST = "d".repeat(32);

/** A v167 file: made by this build with an approver and a saved row of a v167 table, then the v168 tables dropped and
 * the version put back. */
function v167File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v168-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", new Date(T0));
  made.handle.prepare(`INSERT INTO thread_decision (decision_id, thread, turn, request, request_ref, source, decision, request_digest, payload_digest, connection_id, state, at, by, by_generation, state_at)
    VALUES (?, ?, ?, ?, '7', 'person', 'accept', ?, ?, ?, 'decided', ?, 'alex', 1, ?)`).run("f".repeat(32), THREAD, "b".repeat(32), REQUEST, "1".repeat(64), "2".repeat(64), "c".repeat(32), T0, T0);
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V168_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 167");
  raw.close();
  return file;
}
let ids = 0;
const insert = (db: { prepare: DatabaseSync["prepare"] }, over: Record<string, unknown> = {}) => {
  const seq = (over["seq"] as number | undefined) ?? ++ids;
  const thread = (over["thread"] as string | undefined) ?? THREAD;
  const row = { id: seq.toString(16).padStart(32, "0"), thread, seq, repo: "/projects/shop", base_sha: "1".repeat(40), candidate: "2".repeat(40), import_ref: `refs/toolroll/import/${thread}/${seq}`,
    branch: `toolroll/code-${thread}`, branch_before: null, terms_json: "{}", digest: seq.toString(16).padStart(32, "0"), summary_key: "e".repeat(32), approved_by: "alex", approved_generation: 1,
    proof: "password-now", approved_at: T0, delegation_id: 1, state: "approved", state_at: T0, ...over };
  db.prepare(`INSERT INTO flexible_ship (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...(Object.values(row) as (string | number | null)[]));
  return row.id;
};

describe("v168", () => {
  test("fresh: the tables, no rows, update-safe", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(168);
    expect(updateSafeSchema(167)).toBe(true);
    expect(V168_STEPS).toEqual(["flexible-ship"]);
    const fresh = openStore(":memory:");
    for (const table of V168_TABLES) expect(fresh.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    fresh.close();
  });

  test("a send refuses what it can't name, is born approved, and its import ref and branch are its thread's own", () => {
    const store = openStore(":memory:");
    const db = store.handle;
    expect(() => insert(db, { thread: "../../etc" })).toThrow();
    expect(() => insert(db, { import_ref: "refs/heads/main" })).toThrow(); // never another ref
    expect(() => insert(db, { branch: "main" })).toThrow(); // never the default branch
    expect(() => insert(db, { candidate: "not-a-sha" })).toThrow();
    expect(() => insert(db, { proof: "remote-token" })).toThrow(); // a person's proof, never a machine's credential
    expect(() => insert(db, { proof: "lead-token" })).toThrow();
    expect(() => insert(db, { state: "armed" })).toThrow(); // born approved
    expect(() => insert(db, { state: "approved", task_id: "t", scope_digest: "d" })).toThrow();
    expect(() => insert(db, { seq: 0 })).toThrow();
    insert(db, { seq: 1 });
    expect(() => insert(db, { seq: 1, id: "9".repeat(32), digest: "9".repeat(32) })).toThrow(/UNIQUE/); // one send per number
    store.close();
  });

  test("a send is written once and only moves forward; nothing final comes back", () => {
    const store = openStore(":memory:");
    const db = store.handle;
    const id = insert(db, { seq: 5 });
    for (const [column, value] of [["candidate", "3".repeat(40)], ["terms_json", "{\"x\":1}"], ["digest", "8".repeat(32)], ["summary_key", "7".repeat(32)], ["approved_by", "sam"], ["approved_generation", 2],
      ["branch_before", "4".repeat(40)], ["seq", 6], ["delegation_id", 2]] as const) {
      expect(() => db.prepare(`UPDATE flexible_ship SET ${column} = ? WHERE id = ?`).run(value, id), column).toThrow();
    }
    const move = (state: string, extra = "", ...values: (string | number)[]) => db.prepare(`UPDATE flexible_ship SET state = ?${extra} WHERE id = ?`).run(state, ...values, id);
    expect(() => move("armed", ", task_id = 't', scope_digest = 'd'")).toThrow(/only moves forward/); // never skips the import
    expect(() => move("refused")).toThrow(); // a refusal says why
    expect(() => move("failed")).toThrow(); // so does an interrupted one
    move("imported");
    expect(() => move("approved")).toThrow(/only moves forward/);
    expect(() => move("armed")).toThrow(); // an armed Ship names its task
    move("armed", ", task_id = 'flexible-x', scope_digest = 'scope'");
    expect(() => db.prepare("UPDATE flexible_ship SET task_id = 'other' WHERE id = ?").run(id)).toThrow(/only moves forward/);
    expect(() => move("merged")).toThrow(/only moves forward/); // never merged before its checked head is completed
    expect(() => move("completed")).toThrow(); // a completed Ship names the checked head
    expect(() => move("completed", ", merge_head = ?, merge_at = ?", "5".repeat(40), T0)).toThrow(); // and the check's receipt
    move("completed", ", merge_head = ?, merge_at = ?, check_receipt = 'receipt'", "5".repeat(40), T0);
    expect(() => db.prepare("UPDATE flexible_ship SET merge_head = ? WHERE id = ?").run("6".repeat(40), id)).toThrow(/only moves forward/);
    expect(() => db.prepare("UPDATE flexible_ship SET check_receipt = 'other' WHERE id = ?").run(id)).toThrow(/only moves forward/);
    expect(() => move("merging")).toThrow(); // a reservation names its token
    move("merging", ", merge_token = ?, merge_reserved_at = ?", "a".repeat(32), T0);
    expect(() => db.prepare("UPDATE flexible_ship SET merge_token = ? WHERE id = ?").run("b".repeat(32), id)).toThrow(/only moves forward/); // held as taken
    expect(() => move("sent-back", ", feedback = 'x', merge_token = NULL, merge_reserved_at = NULL")).toThrow(/only moves forward/); // too late to send back
    expect(() => move("completed")).toThrow(); // released only with its token cleared
    move("completed", ", merge_token = NULL, merge_reserved_at = NULL"); // released: the call didn't merge
    move("cancelled");
    for (const to of ["armed", "completed", "merged", "imported"]) expect(() => move(to), to).toThrow(/only moves forward/); // cancelled is final
    const crashed = insert(db, { seq: 7 });
    db.prepare("UPDATE flexible_ship SET state = 'failed', reason = 'interrupted' WHERE id = ?").run(crashed);
    expect(() => db.prepare("UPDATE flexible_ship SET state = 'imported' WHERE id = ?").run(crashed)).toThrow(/only moves forward/); // failed is final
    const back = insert(db, { seq: 6 });
    db.prepare("UPDATE flexible_ship SET state = 'imported' WHERE id = ?").run(back);
    db.prepare("UPDATE flexible_ship SET state = 'armed', task_id = 'flexible-y', scope_digest = 's' WHERE id = ?").run(back);
    expect(() => db.prepare("UPDATE flexible_ship SET state = 'sent-back' WHERE id = ?").run(back)).toThrow(); // sent back with its feedback
    db.prepare("UPDATE flexible_ship SET state = 'sent-back', feedback = 'Rename it.' WHERE id = ?").run(back);
    expect(() => db.prepare("UPDATE flexible_ship SET state = 'armed', feedback = NULL WHERE id = ?").run(back)).toThrow(/only moves forward/);
    store.close();
  });

  test("an upgrade adds the tables and changes no saved row", () => {
    const file = v167File();
    const before = new DatabaseSync(file);
    const decisions = before.prepare("SELECT * FROM thread_decision").all().map(row => ({ ...row }));
    before.close();
    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining([...V168_STEPS]));
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    for (const table of V168_TABLES) expect(upgraded.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    expect(upgraded.accountOf("alex")).not.toBeNull();
    expect(upgraded.handle.prepare("SELECT * FROM thread_decision").all().map(row => ({ ...row }))).toEqual(decisions);
    upgraded.close();
  });

  test.each([["thread-decision"], ["flexible-ship"]])("a crash after %s resumes to the same shape", step => {
    const file = v167File();
    expect(() => openStore(file, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    const resumed = openStore(file);
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    for (const table of V168_TABLES) expect(resumed.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    resumed.close();
  });

  test.each([
    ["the ship table", "DROP TABLE flexible_ship; CREATE TABLE flexible_ship (id TEXT PRIMARY KEY, thread TEXT)", /flexible_ship has an unknown shape|flexible_ship_\w+ is missing/],
    ["the born trigger", "DROP TRIGGER flexible_ship_born", /trigger flexible_ship_born is missing/],
    ["the written-once trigger", "DROP TRIGGER flexible_ship_written_once", /trigger flexible_ship_written_once is missing/],
    ["the task index", "DROP INDEX flexible_ship_task; CREATE INDEX flexible_ship_task ON flexible_ship (task_id)", /index flexible_ship_task has an unknown shape/],
    ["the snapshot table", "DROP TABLE flexible_ref_snapshot; CREATE TABLE flexible_ref_snapshot (thread TEXT)", /flexible_ref_snapshot has an unknown shape/],
  ])("a current file whose %s isn't this build's refuses to open", (_what, damage, refusal) => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v168-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(damage);
    raw.close();
    expect(() => openStore(file)).toThrow(refusal);
  });
});
