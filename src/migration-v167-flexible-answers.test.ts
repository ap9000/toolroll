/** v167: the decisions on a Flexible thread's agent's requests (the Flexible plan v2, slice F2d). A new table only: no
 * saved row changes, a crash resumes to the same shape, a decision is born decided (a provider's observed delivered),
 * written once, its state only moves forward, a policy never allows, and a table in a shape this build can't name
 * refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V167_STEPS } from "./store.js";
import { V167_TABLES } from "./flexible-answers-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = "2026-11-15T00:00:00.000Z";
const THREAD = "a".repeat(32), TURN = "b".repeat(32), LAUNCH = "c".repeat(32), REQUEST = "d".repeat(32);

/** A v166 file: made by this build with an approver and a saved row of a v166 table, then the v167 table dropped and
 * the version put back. */
function v166File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v167-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", new Date(T0));
  made.handle.prepare("INSERT INTO thread_relay_pending (thread, turn, launch, holder, relay, route, reserved_at) VALUES (?, ?, ?, 'h1', ?, 'messages', ?)").run(THREAD, TURN, LAUNCH, "e".repeat(32), T0);
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V167_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 166");
  raw.close();
  return file;
}
let ids = 0;
const insert = (db: { prepare: DatabaseSync["prepare"] }, over: Record<string, unknown> = {}) => {
  const row = { decision_id: (++ids).toString(16).padStart(32, "0"), thread: THREAD, turn: TURN, request: (ids).toString(16).padStart(32, "d"), request_ref: "7", source: "person", decision: "accept",
    request_digest: "1".repeat(64), payload_digest: "2".repeat(64), connection_id: LAUNCH, state: "decided", at: T0, by: "alex", by_generation: 1, state_at: T0, ...over };
  return db.prepare(`INSERT INTO thread_decision (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...(Object.values(row) as (string | number | null)[]));
};

describe("v167", () => {
  test("fresh: the table, no rows, update-safe", () => {
    expect(SCHEMA_VERSION).toBe(167);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(167);
    expect(updateSafeSchema(166)).toBe(true);
    expect(V167_STEPS).toEqual(["thread-decision"]);
    const fresh = openStore(":memory:");
    for (const table of V167_TABLES) expect(fresh.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    fresh.close();
  });

  test("a decision refuses what it can't name, is born decided, never allows by policy, and is written once", () => {
    const store = openStore(":memory:");
    const db = store.handle;
    expect(() => insert(db, { thread: "../../etc" })).toThrow();
    expect(() => insert(db, { source: "model" })).toThrow(); // only a person, a policy or the provider decides
    expect(() => insert(db, { decision: "approve" })).toThrow();
    expect(() => insert(db, { state: "pending" })).toThrow();
    expect(() => insert(db, { state: "sent" })).toThrow(/born decided/); // born decided
    expect(() => insert(db, { by_generation: null })).toThrow(); // a person's at their generation
    expect(() => insert(db, { source: "policy", by_generation: null })).toThrow(); // a policy names its rule
    expect(() => insert(db, { source: "policy", rule: "no-channel", by_generation: null, decision: "accept" })).toThrow(); // and never allows
    expect(() => insert(db, { source: "provider", request: null, by_generation: null, request_digest: null, payload_digest: null })).toThrow(/born decided/); // a provider's is observed
    expect(() => insert(db, { request_digest: null })).toThrow();
    expect(() => insert(db, { write_started_at: T0 })).toThrow();
    expect(() => insert(db, { attempt_id: "a".repeat(32), write_started_at: T0 })).toThrow(/born decided/);
    insert(db, { decision_id: "f".repeat(32), request: "e".repeat(32) });
    expect(() => insert(db, { request: "e".repeat(32) })).toThrow(/UNIQUE/); // one decision per request
    expect(() => insert(db, { decision_id: "f".repeat(32) })).toThrow(/UNIQUE/); // one id per decision
    insert(db, { source: "policy", rule: "no-channel", by: "toolroll", by_generation: null, decision: "decline" });
    insert(db, { source: "provider", request: null, by: "provider:claude", by_generation: null, request_digest: null, payload_digest: null, state: "delivered" });
    const id = Number(db.prepare("SELECT id FROM thread_decision WHERE decision_id = ?").get("f".repeat(32))!["id"]);
    for (const column of ["decision_id", "thread", "turn", "request", "request_ref", "source", "decision", "request_digest", "payload_digest", "connection_id", "at", "by", "by_generation"]) {
      expect(() => db.prepare(`UPDATE thread_decision SET ${column} = ${column === "by_generation" ? "2" : "'x'"} WHERE id = ?`).run(id), column).toThrow();
    }
    const move = (to: string, extra = "") => db.prepare(`UPDATE thread_decision SET state = ?${extra} WHERE id = ?`).run(to, id);
    expect(() => move("sent")).toThrow(); // decided never skips sending
    expect(() => move("delivered")).toThrow(/only moves forward/);
    const mark = (attempt: string, time: string) => db.prepare("UPDATE thread_decision SET attempt_id = ?, write_started_at = ? WHERE id = ?").run(attempt, time, id);
    expect(() => mark("a".repeat(32), T0)).toThrow(/only moves forward/); // an attempt only while sending
    move("sending");
    expect(() => move("decided")).toThrow(/only moves forward/);
    expect(() => move("sent")).toThrow(); // a sent answer's write began
    expect(() => db.prepare("UPDATE thread_decision SET write_started_at = ? WHERE id = ?").run(T0, id)).toThrow(); // its id and time together
    mark("a".repeat(32), T0);
    expect(() => mark("b".repeat(32), T0)).toThrow(/only moves forward/); // written once
    expect(() => mark("a".repeat(32), "2026-11-15T00:00:01.000Z")).toThrow(/only moves forward/);
    expect(() => move("not-sent")).toThrow(); // an answer with an attempt is never not-sent
    move("sent");
    expect(() => move("not-sent")).toThrow(/only moves forward/); // what was sent was sent
    move("uncertain");
    for (const to of ["sent", "delivered", "decided"]) expect(() => move(to), to).toThrow(/only moves forward/); // uncertain is final
    store.close();
  });

  test("an upgrade adds the table and changes no saved row", () => {
    const file = v166File();
    const before = new DatabaseSync(file);
    const pending = before.prepare("SELECT * FROM thread_relay_pending").all().map(row => ({ ...row }));
    before.close();
    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining([...V167_STEPS]));
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(167);
    for (const table of V167_TABLES) expect(upgraded.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    expect(upgraded.accountOf("alex")).not.toBeNull();
    expect(upgraded.handle.prepare("SELECT * FROM thread_relay_pending").all().map(row => ({ ...row }))).toEqual(pending);
    upgraded.close();
  });

  test.each([["thread-relay-call"], ["thread-decision"]])("a crash after %s resumes to the same shape", step => {
    const file = v166File();
    expect(() => openStore(file, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    const resumed = openStore(file);
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(167);
    expect(resumed.handle.prepare("SELECT COUNT(*) AS n FROM thread_decision").get()?.["n"]).toBe(0);
    resumed.close();
  });

  test.each([
    ["the table", "DROP TABLE thread_decision; CREATE TABLE thread_decision (id INTEGER PRIMARY KEY, thread TEXT)", /thread_decision has an unknown shape|thread_decision_\w+ is missing/],
    ["the born trigger", "DROP TRIGGER thread_decision_born", /trigger thread_decision_born is missing/],
    ["the written-once trigger", "DROP TRIGGER thread_decision_written_once", /trigger thread_decision_written_once is missing/],
    ["the request index", "DROP INDEX thread_decision_request; CREATE INDEX thread_decision_request ON thread_decision (request)", /index thread_decision_request has an unknown shape/],
  ])("a current file whose %s isn't this build's refuses to open", (_what, damage, refusal) => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v167-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(damage);
    raw.close();
    expect(() => openStore(file)).toThrow(refusal);
  });
});
