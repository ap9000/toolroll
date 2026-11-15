/** v166: the calls a Flexible thread's sign-in relay handled and reserved (the Flexible plan v2, slice F2b). New tables only: no
 * saved row changes, a crash resumes to the same shape, a call is written once, a refused one costs nothing and a
 * forwarded one always names its turn, and a table in a shape this build can't name refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V166_STEPS } from "./store.js";
import { V166_TABLES } from "./flexible-relay-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = "2026-11-15T00:00:00.000Z";
const THREAD = "a".repeat(32), TURN = "b".repeat(32), LAUNCH = "c".repeat(32);

/** A v165 file: made by this build with an approver and a saved row of every Flexible table v165 has, then the v166
 * table dropped and the version put back. */
function v165File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v166-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", new Date(T0));
  made.handle.prepare("INSERT INTO flexible_relay_grant (token_digest, thread, turn, launch, issued_at) VALUES (?, ?, ?, ?, ?)").run("e".repeat(64), THREAD, TURN, LAUNCH, T0);
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V166_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 165");
  raw.close();
  return file;
}
const insert = (db: { prepare: DatabaseSync["prepare"] }, over: Record<string, unknown> = {}) => {
  const row = { thread: THREAD, turn: TURN, launch: LAUNCH, upstream: "claude", at: T0, ended_at: T0, route: "messages", model: "claude-sonnet-4-5", streamed: 1, status: "completed",
    http_status: 200, tokens_in: 10, tokens_out: 5, cost_microusd: 0, cost_basis: "estimated", ...over };
  return db.prepare(`INSERT INTO thread_relay_call (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...(Object.values(row) as (string | number | null)[]));
};

describe("v166", () => {
  test("fresh: the table, no rows, update-safe", () => {
    expect(SCHEMA_VERSION).toBe(167);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(166);
    expect(updateSafeSchema(165)).toBe(true);
    expect(V166_STEPS).toEqual(["thread-relay-call"]);
    const fresh = openStore(":memory:");
    for (const table of V166_TABLES) expect(fresh.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    fresh.close();
  });

  test("a call refuses what it can't name, a refused one costs nothing, a forwarded one names its turn, and each is written once", () => {
    const store = openStore(":memory:");
    const db = store.handle;
    expect(() => insert(db, { thread: "../../etc" })).toThrow();
    expect(() => insert(db, { upstream: "openai" })).toThrow();
    expect(() => insert(db, { route: "complete" })).toThrow();
    expect(() => insert(db, { status: "forwarded" })).toThrow();
    expect(() => insert(db, { tokens_in: -1 })).toThrow();
    expect(() => insert(db, { cost_basis: "guessed" })).toThrow();
    expect(() => insert(db, { turn: null })).toThrow(); // a forwarded call always names its turn
    expect(() => insert(db, { cost_basis: null })).toThrow(); // and how sure its charge is
    expect(() => insert(db, { status: "refused" })).toThrow(); // a refusal says why
    expect(() => insert(db, { status: "refused", reason: "route", cost_basis: null })).toThrow(); // and costs nothing
    expect(() => insert(db, { status: "refused", reason: "Route!", tokens_in: 0, tokens_out: 0, cost_basis: null })).toThrow();
    expect(() => insert(db, { status: "completed", reason: "route" })).toThrow();
    expect(() => insert(db, { detail: "x".repeat(501) })).toThrow();
    insert(db);
    insert(db, { turn: null, status: "refused", reason: "no-turn", tokens_in: 0, tokens_out: 0, cost_basis: null, http_status: 409 });
    for (const column of ["thread", "turn", "status", "tokens_in", "cost_microusd", "cost_basis", "detail"]) {
      expect(() => db.prepare(`UPDATE thread_relay_call SET ${column} = NULL WHERE id = 1`).run(), column).toThrow(/written once/);
    }
    expect(() => db.prepare("UPDATE thread_relay_call SET tokens_in = tokens_in + 1 WHERE id = 1").run()).toThrow(/written once/);
    // A reservation: what it names, written once, only ever cleared.
    const reserve = (over: Record<string, unknown> = {}) => {
      const row = { thread: THREAD, turn: TURN, launch: LAUNCH, holder: "h1", relay: "e".repeat(32), route: "messages", reserved_at: T0, ...over };
      return db.prepare(`INSERT INTO thread_relay_pending (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...(Object.values(row) as (string | number | null)[]));
    };
    expect(() => reserve({ turn: null })).toThrow();
    expect(() => reserve({ thread: "x" })).toThrow();
    expect(() => reserve({ relay: "not-a-relay" })).toThrow();
    expect(() => reserve({ route: "complete" })).toThrow();
    reserve();
    reserve({ route: "count-tokens" });
    expect(() => db.prepare("UPDATE thread_relay_pending SET turn = ?").run("d".repeat(32))).toThrow(/only cleared/);
    db.prepare("DELETE FROM thread_relay_pending").run();
    store.close();
  });

  test("an upgrade adds the table and changes no saved row", () => {
    const file = v165File();
    const before = new DatabaseSync(file);
    const grants = before.prepare("SELECT * FROM flexible_relay_grant").all().map(row => ({ ...row }));
    before.close();
    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining([...V166_STEPS]));
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(167);
    for (const table of V166_TABLES) expect(upgraded.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    expect(upgraded.accountOf("alex")).not.toBeNull();
    expect(upgraded.handle.prepare("SELECT * FROM flexible_relay_grant").all().map(row => ({ ...row }))).toEqual(grants);
    upgraded.close();
  });

  test.each([["thread-launch"], ["thread-relay-call"]])("a crash after %s resumes to the same shape", step => {
    const file = v165File();
    expect(() => openStore(file, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    const resumed = openStore(file);
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(167);
    expect(resumed.handle.prepare("SELECT COUNT(*) AS n FROM thread_relay_call").get()?.["n"]).toBe(0);
    resumed.close();
  });

  test.each([
    ["the table", "DROP TABLE thread_relay_call; CREATE TABLE thread_relay_call (id INTEGER PRIMARY KEY, thread TEXT)", /thread_relay_call has an unknown shape|thread_relay_call_\w+ is missing/],
    ["the trigger", "DROP TRIGGER thread_relay_call_written_once", /trigger thread_relay_call_written_once is missing/],
    ["the turn index", "DROP INDEX thread_relay_call_turn; CREATE INDEX thread_relay_call_turn ON thread_relay_call (thread)", /index thread_relay_call_turn has an unknown shape/],
    ["the reservations' trigger", "DROP TRIGGER thread_relay_pending_written_once", /trigger thread_relay_pending_written_once is missing/],
  ])("a current file whose %s isn't this build's refuses to open", (_what, damage, refusal) => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v166-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(damage);
    raw.close();
    expect(() => openStore(file)).toThrow(refusal);
  });
});
