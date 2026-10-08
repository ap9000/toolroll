/**
 * The v47 → v48 upgrade against an AUTHENTIC v47 database — one the v47
 * build's own code wrote (src/fixtures/v47-authentic.sql, derived by
 * scripts/derive-v47-fixture.mjs from commit 1d0fc900) — and against the
 * same file with the v48 migration half-applied under the −47 epoch
 * sentinel. Every pre-existing row survives byte for byte (the routine, as
 * v115 removed routines, as a paused scheduled flow), nothing is backfilled
 * or auto-approved, and a second
 * open changes nothing: the full row and schema snapshots are compared.
 * The schema-version preflight is proved here too: exactly one safe,
 * supported integer is read BEFORE any DDL, and anything else refuses with
 * the file untouched.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, openStoreNoMigrate, readSchemaVersion, SCHEMA_VERSION, schemaVersionPreflight, Store, V115_DROPPED_TABLES, type Database } from "./store.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v47-authentic.sql");
const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type Snapshot = { schema: { name: string; type: string; sql: string }[]; rows: Record<string, Record<string, unknown>[]> };

/** Every table's DDL and every row, in rowid order — the whole file. */
function snapshot(file: string): Snapshot {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  // The FTS5 memory index and its shadow tables are a derived view (some
  // are WITHOUT ROWID); the stores of record beside them are what this dump proves.
  const schema = (db.prepare("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as { name: string; type: string; sql: string }[]).filter(one => !one.name.startsWith("memory_search")).map(one => ({ ...one }));
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const table of schema.filter(one => one.type === "table")) {
    // sqlite_sequence has no stable rowid order across a table rebuild
    // (a v46/v51-style copy-rename re-registers the AUTOINCREMENT counter
    // at the end); its facts are (name, seq), compared by name.
    const statement = db.prepare(`SELECT * FROM "${table.name}" ORDER BY ${table.name === "sqlite_sequence" ? "name" : "rowid"}`);
    statement.setReadBigInts(true);
    rows[table.name] = (statement.all() as Record<string, unknown>[]).map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v])));
  }
  db.close();
  return { schema, rows };
}

/** A fresh file loaded from the authentic v47 SQL. */
function loadFixture(dir: string, name = "orders.db"): string {
  const file = join(dir, name);
  const db = new sqlite.DatabaseSync(file);
  db.exec(readFileSync(FIXTURE, "utf8"));
  db.close();
  return file;
}

function rawVersion(file: string): unknown {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT CAST(version AS TEXT) AS version FROM schema_version").all() as { version: string }[];
  db.close();
  return rows.length === 1 ? Number(rows[0]?.version) : rows.map(one => one.version);
}

/** The v48 migration's additive columns, projected out of an upgraded row. */
const V48_ROUTINE_COLUMNS = ["route_json", "approved_route_json"];
function withoutNew(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  if (table === "routine") for (const column of V48_ROUTINE_COLUMNS) delete copy[column];
  // v49's watch_incarnation and v50's review_attempt / reviewer_run /
  // origin are later additive columns; the v47 fixture never carried them.
  if (table === "run") { delete copy["watch_incarnation"]; delete copy["review_attempt"]; }
  if (table === "review_request") { delete copy["reviewer_run"]; delete copy["origin"]; }
  if (table === "approver" || table === "invite") delete copy["projects_json"];
  // v69's prepared candidate is a later additive column on the scope.
  if (table === "task_scope") delete copy["candidate"];
  // v77's thread scope is a later additive column on the lead thread.
  if (table === "mate_thread") { delete copy["scope_kind"]; delete copy["scope_key"]; }
  // v102's filer is a later additive column on the task reference (null for tasks filed before it).
  // So is the sign-in gate's note (null until a gate holds the task), and sized routing's size and tier (null until filed).
  if (table === "task_ref") {
    for (const column of ["filed_by", "filed_by_kind", "auth_wait_pause", "size", "size_risky", "size_source", "size_reason", "route_tier"]) delete copy[column];
  }
  if (table === "routine") delete copy["created_by"];
  return copy;
}

describe("the authentic v47 database upgrades to v48 and stays put", () => {
  let dir: string | undefined;
  let store: Store | null = null;
  afterEach(() => {
    store?.close();
    store = null;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("the fixture is what v47 wrote: version 47, the v47 shapes, the seeded facts", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v47-auth-"));
    const file = loadFixture(dir);
    expect(rawVersion(file)).toBe(47);
    const before = snapshot(file);
    const routineDdl = before.schema.find(one => one.type === "table" && one.name === "routine")!.sql;
    expect(routineDdl).not.toContain("route_json");
    const proposalDdl = before.schema.find(one => one.type === "table" && one.name === "mate_proposal")!.sql;
    expect(proposalDdl).not.toContain("'agents'");
    expect(before.rows["task_scope"]!.map(one => one["task_id"])).toEqual(["t-routed", "t-pending", "t-legacy", "t-chain"]);
    expect(before.rows["run_route"]).toHaveLength(1);
    expect(before.rows["review_request"]).toHaveLength(1);
    expect(before.rows["routine"]).toHaveLength(1);
    expect(before.rows["mate_proposal"]).toHaveLength(1);
    expect(before.rows["task_steer"]).toHaveLength(1);
  });

  for (const [label, prepare] of [
    ["an authentic v47 file", (_file: string): void => undefined],
    [
      "a −47 epoch with the v48 migration half-applied (one routine column already added)",
      (file: string): void => {
        const db = new sqlite.DatabaseSync(file);
        db.exec("ALTER TABLE routine ADD COLUMN route_json TEXT");
        db.exec("UPDATE schema_version SET version = -47");
        db.close();
      },
    ],
  ] as const) {
    test(`${label} upgrades in place: every row survives, the new columns arrive NULL, nothing is backfilled or auto-approved, and a second open is a byte-for-byte no-op`, () => {
      dir = mkdtempSync(join(tmpdir(), "so-v47-auth-"));
      const file = loadFixture(dir);
      const authentic = snapshot(file);
      prepare(file);
      // The first open migrates.
      store = openStore(file);
      store.close();
      store = null;
      expect(rawVersion(file)).toBe(SCHEMA_VERSION);
      const upgraded = snapshot(file);
      // Every table v47 had is still there; every row is byte for byte the
      // row v47 wrote — no other table gained or lost a row, no id moved, no
      // digest changed. (The features v115 removed take their own tables
      // with them; the routine moves to a scheduled flow, asserted below.)
      for (const table of authentic.schema.filter(one => one.type === "table" && one.name !== "schema_version" && !V115_DROPPED_TABLES.includes(one.name))) {
        expect(upgraded.rows[table.name], table.name).toBeDefined();
        // v115 settles the one unfinished task filed under a fallback chain (asserted below); every other row is as written.
        // The sequence forgets the removed tables and learns the moved routine's flow and schedule (and, from the
        // settlement's write under the ledger's trigger, the empty ledger's counter at 0).
        const settled = (row: Record<string, unknown>) => V115_DROPPED_TABLES.includes(String(row["name"])) || ["flow", "flow_trigger"].includes(String(row["name"])) || (row["name"] === "action_ledger" && Number(row["seq"]) === 0);
        const kept = (rows: Record<string, unknown>[]) => table.name === "task_scope" ? rows.filter(row => row["task_id"] !== "t-chain")
          : table.name === "sqlite_sequence" ? rows.filter(row => !settled(row)) : rows;
        expect(kept(upgraded.rows[table.name]!.map(row => withoutNew(table.name, row))), table.name).toEqual(kept(authentic.rows[table.name]!));
      }
      for (const table of ["approver", "invite"]) for (const row of upgraded.rows[table]!) expect(row["projects_json"]).toBeNull();
      for (const row of upgraded.rows["run"]!) expect(row).toMatchObject({ watch_incarnation: null });
      expect(upgraded.schema.some(one => one.type === "table" && one.name === "routine")).toBe(false);
      expect(upgraded.schema.find(one => one.type === "table" && one.name === "mate_proposal")!.sql).toContain("'agents'");
      // The upgraded facts read back exactly: the routed approval still
      // seals its route, the pre-routing row is legacy (never backfilled),
      // the unfinished task approved under a fallback chain (removed in
      // v115) asks again — its approval withdrawn, its scope saying why —
      // the review request is still pending,
      // the run keeps its provenance, and the routine — approved under
      // v47 with no route — arrives as a scheduled flow whose schedule is
      // paused and carries no approval: nothing fires until a person turns
      // it on, and then each run waits for approval.
      store = openStore(file);
      expect(store.sealedRouteOf("t-routed")).toMatchObject({ ok: true });
      expect(store.getScope("t-legacy")).toMatchObject({ routeEra: null, approvedRouteJson: null });
      expect(store.sealedRouteOf("t-legacy")).toMatchObject({ ok: false, reason: "legacy" });
      expect(store.getScope("t-pending")?.approvedAt).toBeNull();
      const chainBefore = authentic.rows["task_scope"]!.find(row => row["task_id"] === "t-chain")!;
      expect(chainBefore).toMatchObject({ approval_kind: "chain" });
      expect(store.getScope("t-chain")).toMatchObject({
        digest: chainBefore["digest"], approvedAt: null, approvedDigest: null, approvedChainJson: null, proposedChainJson: null,
        approvalKind: "profile", profileState: "unresolved", unresolvedReason: expect.stringContaining("fallback agents"),
      });
      expect(store.runRoute(1)).toMatchObject({ phase: "build", chosen: "recommended" });
      expect(upgraded.rows["review_request"]![0]).toMatchObject({ consumed_at: null });
      const [moved] = store.listFlows([String(authentic.rows["routine"]![0]!["repo"])]);
      expect(moved?.name).toBe(String(authentic.rows["routine"]![0]!["name"]));
      const [schedule] = store.flowTriggers(moved!.id);
      expect(schedule).toMatchObject({ kind: "schedule", state: "paused" });
      expect(JSON.parse(schedule!.configJson)).toMatchObject({ order: { routine: Number(authentic.rows["routine"]![0]!["id"]), approval: null } });
      store.close();
      store = null;
      // The second open is a no-op: the full row AND schema snapshots are identical.
      store = openStore(file);
      store.close();
      store = null;
      expect(rawVersion(file)).toBe(SCHEMA_VERSION);
      expect(snapshot(file)).toEqual(upgraded);
    });
  }

  test("the half-applied −47 file and the authentic v47 file upgrade to the SAME rows and schema", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v47-auth-"));
    const whole = loadFixture(dir, "whole.db");
    const partial = loadFixture(dir, "partial.db");
    {
      const db = new sqlite.DatabaseSync(partial);
      db.exec("ALTER TABLE routine ADD COLUMN route_json TEXT");
      db.exec("UPDATE schema_version SET version = -47");
      db.close();
    }
    openStore(whole).close();
    openStore(partial).close();
    expect(snapshot(partial)).toEqual(snapshot(whole));
  });
});

describe("the schema-version preflight reads exactly one safe supported integer before any DDL", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const corrupt = (file: string, sql: string): void => {
    const db = new sqlite.DatabaseSync(file);
    db.exec(sql);
    db.close();
  };

  for (const [label, sql, words] of [
    ["a fractional version", "UPDATE schema_version SET version = 47.5", /47\.5 \(real\), not a safe integer/],
    ["a text version", "UPDATE schema_version SET version = 'forty-seven'", /"forty-seven" \(text\), not a safe integer/],
    ["a version past the safe range", "UPDATE schema_version SET version = 9223372036854775807", /9223372036854775807 \(integer\), not a safe integer/],
    ["a version one past the safe range", "UPDATE schema_version SET version = 9007199254740993", /not a safe integer/],
    ["a zero version", "UPDATE schema_version SET version = 0", /is 0, which no build ever wrote/],
    ["a newer build's version", `UPDATE schema_version SET version = ${SCHEMA_VERSION + 1}`, /written by a newer build/],
    ["a newer build's mid-flight epoch", `UPDATE schema_version SET version = ${-(SCHEMA_VERSION + 1)}`, /written by a newer build/],
    ["two version rows", "INSERT INTO schema_version (version) VALUES (47)", /carries 2 rows, not one/],
    ["no version row", "DELETE FROM schema_version", /carries no row/],
    // The impossible negatives (raw authority repair): an upgrade never
    // begins at the version it upgrades to, so −48 is a marker no build
    // ever wrote — it is not "a resumable epoch", it refuses.
    ["this build's own version as a mid-flight epoch", `UPDATE schema_version SET version = ${-SCHEMA_VERSION}`, /a mid-flight marker no build ever wrote/],
    // A nonempty file with NO version table is not fresh: it is a database
    // some other program shaped, and this build's DDL never runs over it.
    ["a nonempty file with no version table", "DROP TABLE schema_version", /carries tables but no schema_version table/],
  ] as const) {
    test(`${label} refuses before DDL — the file is untouched`, () => {
      dir = mkdtempSync(join(tmpdir(), "so-preflight-"));
      const file = loadFixture(dir);
      corrupt(file, sql);
      const before = snapshot(file);
      expect(() => openStore(file)).toThrow(words);
      expect(() => openStore(file)).toThrow(/alters nothing it cannot name/);
      // Nothing moved: not the version, not one table's DDL, not one row.
      expect(snapshot(file)).toEqual(before);
      expect(before.schema.find(one => one.type === "table" && one.name === "routine")!.sql).not.toContain("route_json");
      // EVERY door reads through the one strict reader: the non-migrating
      // door refuses in the same words, and the live per-unit-of-work
      // check answers false — never a coerced number that compares equal.
      const door = openStoreNoMigrate(file);
      expect(door).toMatchObject({ ok: false, reason: "version" });
      if (!door.ok) expect(door.message).toMatch(words);
      const raw = new sqlite.DatabaseSync(file);
      const read = readSchemaVersion(raw as never);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.problem).toMatch(words);
      raw.close();
      expect(snapshot(file)).toEqual(before);
    });
  }

  test("the live schema check reads through the strict reader: a corrupt version under an open connection answers false, and the door refuses the −48 marker", () => {
    dir = mkdtempSync(join(tmpdir(), "so-preflight-"));
    const file = loadFixture(dir);
    const store = openStore(file);
    expect(store.schemaCurrent()).toBe(true);
    corrupt(file, `UPDATE schema_version SET version = ${-SCHEMA_VERSION}`);
    expect(store.schemaCurrent()).toBe(false);
    expect(openStoreNoMigrate(file)).toMatchObject({ ok: false, reason: "version", message: expect.stringContaining("no build ever wrote") });
    corrupt(file, "UPDATE schema_version SET version = 'forty-eight'");
    expect(store.schemaCurrent()).toBe(false);
    corrupt(file, "INSERT INTO schema_version (version) VALUES (48)");
    expect(store.schemaCurrent()).toBe(false);
    store.close();
  });

  test("the epoch sentinel and its clearing are checked compare-and-sets: a version that moves under the open refuses, and the file keeps the other writer's marker", () => {
    dir = mkdtempSync(join(tmpdir(), "so-preflight-"));
    const file = loadFixture(dir);
    // A connect wrapper: the FIRST sentinel write finds the row already
    // moved by a second migrator (simulated through an independent
    // connection) — the CAS matches nothing, and this open refuses rather
    // than stamping over a marker it never read.
    const racing = (moveTo: number, on: RegExp): ((path: string) => Database) => (path: string): Database => {
      const real = new sqlite.DatabaseSync(path);
      let moved = false;
      return {
        prepare: sql => {
          const statement = real.prepare(sql);
          if (!on.test(sql)) return statement as never;
          return {
            ...statement,
            run: (...args: unknown[]) => {
              if (!moved) {
                moved = true;
                const other = new sqlite.DatabaseSync(path);
                other.exec(`UPDATE schema_version SET version = ${moveTo}`);
                other.close();
              }
              return statement.run(...(args as never[]));
            },
            get: (...args: unknown[]) => statement.get(...(args as never[])),
            all: (...args: unknown[]) => statement.all(...(args as never[])),
          } as never;
        },
        exec: sql => real.exec(sql),
        close: () => real.close(),
      } as Database;
    };
    // The epoch stamp: v47 → −47 expected, but the row is already −47
    // (another migrator stamped it first).
    expect(() => openStore(file, { connect: racing(-47, /^UPDATE schema_version SET version = \? WHERE version = \?$/) })).toThrow(/moved from v47 between the preflight and the epoch stamp/);
    expect(rawVersion(file)).toBe(-47);
    // The clearing write: the sentinel −47 is expected, but the other
    // migrator finished and wrote 48 — this open's own clear matches
    // nothing and refuses; the file keeps the finished marker.
    corrupt(file, "UPDATE schema_version SET version = 47");
    let stamps = 0;
    const clearingRace = (path: string): Database => {
      const real = new sqlite.DatabaseSync(path);
      return {
        prepare: sql => {
          const statement = real.prepare(sql);
          if (!/^UPDATE schema_version SET version = \? WHERE version = \?$/.test(sql)) return statement as never;
          return {
            run: (...args: unknown[]) => {
              stamps += 1;
              if (stamps === 2) {
                const other = new sqlite.DatabaseSync(path);
                other.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION}`);
                other.close();
              }
              return statement.run(...(args as never[]));
            },
          } as never;
        },
        exec: sql => real.exec(sql),
        close: () => real.close(),
      } as Database;
    };
    expect(() => openStore(file, { connect: clearingRace })).toThrow(/the epoch sentinel -47 moved under this migration/);
    expect(rawVersion(file)).toBe(SCHEMA_VERSION);
    // A plain open of the now-current file changes nothing.
    const before = snapshot(file);
    openStore(file).close();
    expect(snapshot(file)).toEqual(before);
  });

  // Persisted header metadata on an unversioned file (atomic authority
  // closure): a 4096-byte SQLite file with NO objects in sqlite_master but
  // a non-default user version, application id, or schema cookie was
  // shaped by something, and it is not a fresh file this build may expand
  // to schema 48 — every door refuses it in words and moves nothing.
  // A 4096-byte file created by `PRAGMA journal_mode = WAL` alone (final
  // authority closure) has an empty sqlite_master AND every checked header
  // cookie at zero — the one persisted page is the whole evidence that
  // something shaped it, and the complete fresh-file invariant (a page
  // count of zero) refuses it at every door, byte-identically.
  for (const [label, shape, words] of [
    ["a user version of 77", "PRAGMA user_version = 77", /persisted user version of 77/],
    ["an application id", "PRAGMA application_id = 1398101071", /persisted application id of 1398101071/],
    ["a schema cookie left by a created-and-dropped table", "CREATE TABLE gone (id INTEGER); DROP TABLE gone", /persisted schema cookie of \d+/],
    ["a WAL journal mode alone (one persisted page, every cookie zero)", "PRAGMA journal_mode = WAL", /no schema_version table but 1 persisted page\(s\)/],
  ] as const) {
    test(`an unversioned file with empty sqlite_master but ${label} refuses at every door — the bytes are untouched`, () => {
      dir = mkdtempSync(join(tmpdir(), "so-preflight-"));
      const file = join(dir, "shaped.db");
      const raw = new sqlite.DatabaseSync(file);
      raw.exec(shape);
      expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
      if (shape.includes("WAL")) {
        for (const pragma of ["user_version", "application_id", "schema_version"]) expect(raw.prepare(`PRAGMA ${pragma}`).get()).toEqual({ [pragma]: 0 });
        expect(raw.prepare("PRAGMA page_count").get()).toEqual({ page_count: 1 });
      }
      raw.close();
      const before = readFileSync(file);
      expect(before.length).toBeGreaterThan(0);
      if (shape.includes("WAL")) expect(before.length).toBe(4096);
      expect(() => openStore(file)).toThrow(words);
      expect(() => openStore(file)).toThrow(/alters nothing it cannot name/);
      expect(readFileSync(file).equals(before)).toBe(true);
      const door = openStoreNoMigrate(file);
      expect(door).toMatchObject({ ok: false, reason: "version" });
      if (!door.ok) expect(door.message).toMatch(words);
      expect(readFileSync(file).equals(before)).toBe(true);
      const again = new sqlite.DatabaseSync(file);
      const read = readSchemaVersion(again as never);
      expect(read).toMatchObject({ ok: false, problem: expect.stringMatching(words) });
      expect(() => schemaVersionPreflight(again as never, file)).toThrow(words);
      // The live per-unit-of-work check on a connection to such a file
      // answers false through the same reader.
      expect(new Store(again as never).schemaCurrent()).toBe(false);
      again.close();
      expect(readFileSync(file).equals(before)).toBe(true);
      // Still no schema_version table, still nothing in sqlite_master:
      // the file was never expanded.
      const check = new sqlite.DatabaseSync(file, { readOnly: true });
      expect(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
      check.close();
    });
  }

  test("a genuinely empty new file, a zero-byte file, and :memory: still open fresh at this build's version", () => {
    dir = mkdtempSync(join(tmpdir(), "so-preflight-"));
    const created = new sqlite.DatabaseSync(join(dir, "touched.db"));
    created.close();
    for (const file of [join(dir, "touched.db"), join(dir, "never.db"), ":memory:"]) {
      const store = openStore(file);
      expect(store.schemaCurrent()).toBe(true);
      expect(readSchemaVersion(store.raw())).toEqual({ ok: true, version: SCHEMA_VERSION });
      store.close();
    }
  });

  test("the preflight itself: a fresh file answers null, a supported version answers itself, a mid-flight epoch answers its negative", () => {
    dir = mkdtempSync(join(tmpdir(), "so-preflight-"));
    const fresh = new sqlite.DatabaseSync(join(dir, "fresh.db"));
    expect(schemaVersionPreflight(fresh as never, "fresh.db")).toBeNull();
    fresh.close();
    const file = loadFixture(dir);
    const db = new sqlite.DatabaseSync(file);
    expect(schemaVersionPreflight(db as never, file)).toBe(47);
    db.exec("UPDATE schema_version SET version = -47");
    expect(schemaVersionPreflight(db as never, file)).toBe(-47);
    db.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION}`);
    expect(schemaVersionPreflight(db as never, file)).toBe(SCHEMA_VERSION);
    db.close();
  });
});
