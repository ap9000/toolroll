/**
 * Schema v107, the baseline (D9): a new database is the one Toolroll 0.5.0
 * made, then takes the same steps an installation from 0.5.0 takes. Anything
 * older is refused before any DDL, with the file untouched. The schema-version
 * preflight is proved here too: exactly one safe, supported integer is read
 * BEFORE any DDL, and anything else refuses with the file untouched; the epoch
 * sentinel and its clearing are checked compare-and-sets.
 */
import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, openStoreNoMigrate, readSchemaVersion, SCHEMA_VERSION, schemaVersionPreflight, Store, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, type Database } from "./store.js";
import { BASELINE_SCHEMA, BASELINE_SCHEMA_VERSION, BASELINE_SHAPE_SHA256, schemaShape } from "./store-baseline.js";
import { baselineFile } from "../test/baseline.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type Snapshot = { schema: { name: string; type: string; sql: string }[]; rows: Record<string, Record<string, unknown>[]> };

/** Every table's DDL and every row, in rowid order — the whole file. */
function snapshot(file: string): Snapshot {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  // The FTS5 memory index and its shadow tables are a derived view (some are WITHOUT ROWID).
  const schema = (db.prepare("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as { name: string; type: string; sql: string }[]).filter(one => !one.name.startsWith("memory_search")).map(one => ({ ...one }));
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const table of schema.filter(one => one.type === "table")) {
    const statement = db.prepare(`SELECT * FROM "${table.name}" ORDER BY ${table.name === "sqlite_sequence" ? "name" : "rowid"}`);
    statement.setReadBigInts(true);
    rows[table.name] = (statement.all() as Record<string, unknown>[]).map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v])));
  }
  db.close();
  return { schema, rows };
}

/** The file and its WAL, byte for byte. */
const bytes = (file: string): string => [file, `${file}-wal`].map(one => existsSync(one) ? readFileSync(one).toString("base64") : "").join("|");

function rawVersion(file: string): unknown {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT CAST(version AS TEXT) AS version FROM schema_version").all() as { version: string }[];
  db.close();
  return rows.length === 1 ? Number(rows[0]?.version) : rows.map(one => one.version);
}

const corrupt = (file: string, sql: string): void => {
  const db = new sqlite.DatabaseSync(file);
  db.exec(sql);
  db.close();
};

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const scratch = (): string => (dir = mkdtempSync(join(tmpdir(), "so-baseline-")));

describe("the v107 baseline", () => {
  test("is exactly the schema Toolroll 0.5.0 made (its shape digest), and a new database starts from it", () => {
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(BASELINE_SCHEMA);
    expect(BASELINE_SCHEMA_VERSION).toBe(107);
    expect(schemaShape(db as unknown as Database)).toBe(BASELINE_SHAPE_SHA256);
    db.close();
  });

  test("a new file and a 0.5.0 file take the same steps: the same schema, and the same seeded rows", () => {
    const at = scratch();
    const fresh = join(at, "fresh.db");
    openStore(fresh).close();
    const upgraded = baselineFile(join(at, "v107.db"));
    openStore(upgraded).close();
    expect(rawVersion(fresh)).toBe(SCHEMA_VERSION);
    expect(snapshot(fresh)).toEqual(snapshot(upgraded));
    // A second open of the current file changes nothing.
    const before = snapshot(fresh);
    openStore(fresh).close();
    expect(snapshot(fresh)).toEqual(before);
  });

  test("a v107 file whose upgrade stopped partway (the −107 epoch) resumes to the same result", () => {
    const at = scratch();
    const whole = baselineFile(join(at, "whole.db"));
    const partial = baselineFile(join(at, "partial.db"), -BASELINE_SCHEMA_VERSION);
    // One of its steps already ran: the v109 column is there.
    corrupt(partial, "ALTER TABLE task_ref ADD COLUMN auth_wait_pause INTEGER REFERENCES provider_auth_pause(id)");
    openStore(whole).close();
    openStore(partial).close();
    expect(snapshot(partial)).toEqual(snapshot(whole));
  });

  test.each([106, -106, 47, -47, 1])("schema v%s is refused before any DDL, in words a person can act on, and the file is untouched", version => {
    const file = baselineFile(join(scratch(), "old.db"), version);
    const before = bytes(file);
    expect(() => openStore(file)).toThrow(/older than v107 \(Toolroll 0\.5\.0, the first npm release\).*update through 0\.9\.x first/);
    expect(bytes(file)).toBe(before);
    expect(readdirSync(dir!)).toEqual(["old.db"]);
    // The non-migrating door refuses it too (it is not this build's version), and the update never calls it safe.
    expect(openStoreNoMigrate(file)).toMatchObject({ ok: false, reason: "version" });
    expect(updateSafeSchema(version)).toBe(false);
    expect(bytes(file)).toBe(before);
  });

  test("every step from v107 up is update-safe, and nothing below it is", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toEqual(Array.from({ length: SCHEMA_VERSION - BASELINE_SCHEMA_VERSION }, (_, i) => BASELINE_SCHEMA_VERSION + 1 + i));
    expect(updateSafeSchema(BASELINE_SCHEMA_VERSION)).toBe(true);
    expect(updateSafeSchema(BASELINE_SCHEMA_VERSION - 1)).toBe(false);
  });

  test("a fresh open that finds another process created the file first refuses rather than creating it again", () => {
    const file = join(scratch(), "orders.db");
    let raced = false;
    const racing = (path: string): Database => {
      const real = new sqlite.DatabaseSync(path);
      return {
        prepare: sql => real.prepare(sql) as never,
        exec: sql => {
          if (!raced && sql === "BEGIN IMMEDIATE") {
            raced = true;
            baselineFile(path);
          }
          real.exec(sql);
        },
        close: () => real.close(),
      };
    };
    expect(() => openStore(file, { connect: racing })).toThrow(/a schema version appeared under this fresh open/);
    expect(raced).toBe(true);
    expect(rawVersion(file)).toBe(BASELINE_SCHEMA_VERSION);
    openStore(file).close();
    expect(rawVersion(file)).toBe(SCHEMA_VERSION);
  });
});

describe("nothing older than the baseline is kept", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const read = (path: string): string => readFileSync(join(root, path), "utf8");
  /** Every version a name in this text targets: migrateToV50, rebuildArtifactForV34, V47_RUN_DDL, migration-v99-… */
  const versions = (text: string): number[] =>
    [...text.matchAll(/(?:migrateToV|ForV|\bV|migration-v)(\d+)(?=[_A-Z(\-.]|\b)/g)].map(match => Number(match[1]));

  test("no step, rebuild, test seam or old-shape DDL in the store targets a schema older than v108", () => {
    for (const file of ["src/store.ts", "src/action-ledger.ts", "src/chat-migration.ts", "src/toolroll-update.ts"]) {
      const old = versions(read(file)).filter(version => version <= BASELINE_SCHEMA_VERSION);
      expect(old, file).toEqual([]);
      expect(read(file), file).not.toMatch(/_FOR_TESTS\b|\bfunction migrate\(/);
    }
  });

  test("no migration test, SQL fixture, fixture generator or package command for an older schema remains", () => {
    const tests = readdirSync(join(root, "src")).filter(name => /^migration-v\d+/.test(name));
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.filter(name => versions(name).some(version => version <= BASELINE_SCHEMA_VERSION))).toEqual([]);
    expect(readdirSync(join(root, "src", "fixtures")).filter(name => name.endsWith(".sql"))).toEqual([]);
    expect(readdirSync(join(root, "scripts")).filter(name => /fixture/.test(name) && /v\d+/.test(name))).toEqual([]);
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(Object.entries(scripts).filter(([name, command]) => /fixture:v\d+|derive-v\d+/.test(`${name} ${command}`))).toEqual([]);
  });
});

describe("history a database since v107 always keeps is never recreated empty", () => {
  test.each([
    ["DROP TABLE service_cursor", /service progress is missing/],
    ["DROP TABLE team_request", /team history is missing/],
    ["DROP TABLE telegram_team_chat", /Telegram team chat history is missing/],
    ["ALTER TABLE invite DROP COLUMN projects_json", /project access metadata is missing from invite/],
    ["DROP TABLE plan_authorization", /plan authorization metadata is missing/],
    ["DROP TABLE workflow_preview", /workflow recipe metadata is missing/],
    ["DROP TABLE learning_policy", /learning history is missing/],
    ["DROP TABLE knowledge_change", /project knowledge history is missing/],
    ["DROP TABLE telegram_retry", /Telegram delivery history is missing/],
    ["ALTER TABLE notification DROP COLUMN task_id", /notification provenance is missing/],
    ["DROP TABLE telegram_proposal_action", /Telegram conversation history is missing/],
    ["DROP TABLE telegram_conversation_part", /Telegram reply history is missing/],
    ["DROP TABLE mate_turn_evidence", /Telegram image history is missing/],
    ["DROP TABLE skill_test", /saved skills are missing/],
    ["DROP TABLE mate_proposal", /shared action history has an unknown shape/],
    ["DROP TABLE slack_runtime", /Slack history is missing/],
    ["DROP TABLE discord_pair", /Discord history is missing/],
    ["ALTER TABLE teams_meta DROP COLUMN updated", /the teams_meta table has an unknown shape \(no updated\)/],
  ])("a v107 file after `%s` refuses before the epoch changes, untouched", (damage, words) => {
    const file = baselineFile(join(scratch(), "orders.db"));
    corrupt(file, damage);
    const before = bytes(file);
    expect(() => openStore(file)).toThrow(words);
    expect(bytes(file)).toBe(before);
    expect(rawVersion(file)).toBe(BASELINE_SCHEMA_VERSION);
  });

  test("a current file without the shared chat tables refuses rather than recreate its pairings", () => {
    const file = join(scratch(), "orders.db");
    openStore(file).close();
    corrupt(file, "DROP TABLE chat_binding");
    expect(() => openStore(file)).toThrow(/orders\.db: chat history is missing/);
    expect(rawVersion(file)).toBe(SCHEMA_VERSION);
  });
});

describe("the schema-version preflight reads exactly one safe supported integer before any DDL", () => {
  for (const [label, sql, words] of [
    ["a fractional version", "UPDATE schema_version SET version = 107.5", /107\.5 \(real\), not a safe integer/],
    ["a text version", "UPDATE schema_version SET version = 'one hundred seven'", /"one hundred seven" \(text\), not a safe integer/],
    ["a version past the safe range", "UPDATE schema_version SET version = 9223372036854775807", /9223372036854775807 \(integer\), not a safe integer/],
    ["a version one past the safe range", "UPDATE schema_version SET version = 9007199254740993", /not a safe integer/],
    ["a zero version", "UPDATE schema_version SET version = 0", /is 0, which no build ever wrote/],
    ["a newer build's version", `UPDATE schema_version SET version = ${SCHEMA_VERSION + 1}`, /written by a newer build/],
    ["a newer build's mid-flight epoch", `UPDATE schema_version SET version = ${-(SCHEMA_VERSION + 1)}`, /written by a newer build/],
    ["two version rows", "INSERT INTO schema_version (version) VALUES (107)", /carries 2 rows, not one/],
    ["no version row", "DELETE FROM schema_version", /carries no row/],
    // The impossible negative (raw authority repair): an upgrade never begins at the version it upgrades to, so
    // −SCHEMA_VERSION is a marker no build ever wrote — it is not "a resumable epoch", it refuses.
    ["this build's own version as a mid-flight epoch", `UPDATE schema_version SET version = ${-SCHEMA_VERSION}`, /a mid-flight marker no build ever wrote/],
    // A nonempty file with NO version table is not fresh: it is a database some other program shaped.
    ["a nonempty file with no version table", "DROP TABLE schema_version", /carries tables but no schema_version table/],
  ] as const) {
    test(`${label} refuses before DDL — the file is untouched`, () => {
      const file = baselineFile(join(scratch(), "orders.db"));
      corrupt(file, sql);
      const before = snapshot(file);
      expect(() => openStore(file)).toThrow(words);
      expect(() => openStore(file)).toThrow(/alters nothing it cannot name/);
      // Nothing moved: not the version, not one table's DDL, not one row.
      expect(snapshot(file)).toEqual(before);
      expect(before.schema.some(one => one.name === "provider_auth_pause")).toBe(false);
      // EVERY door reads through the one strict reader.
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

  test("the live schema check reads through the strict reader: a corrupt version under an open connection answers false", () => {
    const file = baselineFile(join(scratch(), "orders.db"));
    const store = openStore(file);
    expect(store.schemaCurrent()).toBe(true);
    corrupt(file, `UPDATE schema_version SET version = ${-SCHEMA_VERSION}`);
    expect(store.schemaCurrent()).toBe(false);
    expect(openStoreNoMigrate(file)).toMatchObject({ ok: false, reason: "version", message: expect.stringContaining("no build ever wrote") });
    corrupt(file, "UPDATE schema_version SET version = 'one hundred seven'");
    expect(store.schemaCurrent()).toBe(false);
    corrupt(file, "INSERT INTO schema_version (version) VALUES (107)");
    expect(store.schemaCurrent()).toBe(false);
    store.close();
  });

  test("the epoch sentinel and its clearing are checked compare-and-sets: a version that moves under the open refuses, and the file keeps the other writer's marker", () => {
    const file = baselineFile(join(scratch(), "orders.db"));
    const CAS = /^UPDATE schema_version SET version = \? WHERE version = \?$/;
    // The FIRST sentinel write finds the row already moved by a second migrator (an independent connection): the
    // compare-and-set matches nothing, and this open refuses rather than stamping over a marker it never read.
    const racing = (moveTo: number, onRun: number) => (path: string): Database => {
      const real = new sqlite.DatabaseSync(path);
      let runs = 0;
      return {
        prepare: sql => {
          const statement = real.prepare(sql);
          if (!CAS.test(sql)) return statement as never;
          return {
            run: (...args: unknown[]) => {
              if (++runs === onRun) corrupt(path, `UPDATE schema_version SET version = ${moveTo}`);
              return statement.run(...(args as never[]));
            },
            get: (...args: unknown[]) => statement.get(...(args as never[])),
            all: (...args: unknown[]) => statement.all(...(args as never[])),
          } as never;
        },
        exec: sql => real.exec(sql),
        close: () => real.close(),
      };
    };
    expect(() => openStore(file, { connect: racing(-107, 1) })).toThrow(/moved from v107 between the preflight and the epoch stamp/);
    expect(rawVersion(file)).toBe(-107);
    // The clearing write: the sentinel −107 is expected, but the other migrator finished and wrote the current
    // version — this open's own clear matches nothing and refuses; the file keeps the finished marker.
    corrupt(file, "UPDATE schema_version SET version = 107");
    expect(() => openStore(file, { connect: racing(SCHEMA_VERSION, 2) })).toThrow(/the epoch sentinel -107 moved under this migration/);
    expect(rawVersion(file)).toBe(SCHEMA_VERSION);
    const before = snapshot(file);
    openStore(file).close();
    expect(snapshot(file)).toEqual(before);
  });

  // Persisted header metadata on an unversioned file: a SQLite file with NO objects in sqlite_master but a
  // non-default user version, application id, or schema cookie — or one persisted page from `PRAGMA journal_mode =
  // WAL` alone — was shaped by something, and is not a fresh file this build may expand. Every door refuses it in
  // words and moves nothing.
  for (const [label, shape, words] of [
    ["a user version of 77", "PRAGMA user_version = 77", /persisted user version of 77/],
    ["an application id", "PRAGMA application_id = 1398101071", /persisted application id of 1398101071/],
    ["a schema cookie left by a created-and-dropped table", "CREATE TABLE gone (id INTEGER); DROP TABLE gone", /persisted schema cookie of \d+/],
    ["a WAL journal mode alone (one persisted page, every cookie zero)", "PRAGMA journal_mode = WAL", /no schema_version table but 1 persisted page\(s\)/],
  ] as const) {
    test(`an unversioned file with empty sqlite_master but ${label} refuses at every door — the bytes are untouched`, () => {
      const file = join(scratch(), "shaped.db");
      const raw = new sqlite.DatabaseSync(file);
      raw.exec(shape);
      expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
      raw.close();
      const before = readFileSync(file);
      expect(before.length).toBeGreaterThan(0);
      expect(() => openStore(file)).toThrow(words);
      expect(() => openStore(file)).toThrow(/alters nothing it cannot name/);
      expect(readFileSync(file).equals(before)).toBe(true);
      const door = openStoreNoMigrate(file);
      expect(door).toMatchObject({ ok: false, reason: "version" });
      if (!door.ok) expect(door.message).toMatch(words);
      const again = new sqlite.DatabaseSync(file);
      expect(readSchemaVersion(again as never)).toMatchObject({ ok: false, problem: expect.stringMatching(words) });
      expect(() => schemaVersionPreflight(again as never, file)).toThrow(words);
      expect(new Store(again as never).schemaCurrent()).toBe(false);
      again.close();
      expect(readFileSync(file).equals(before)).toBe(true);
    });
  }

  test("a genuinely empty new file, a zero-byte file, and :memory: still open fresh at this build's version", () => {
    const at = scratch();
    new sqlite.DatabaseSync(join(at, "touched.db")).close();
    for (const file of [join(at, "touched.db"), join(at, "never.db"), ":memory:"]) {
      const store = openStore(file);
      expect(store.schemaCurrent()).toBe(true);
      expect(readSchemaVersion(store.raw())).toEqual({ ok: true, version: SCHEMA_VERSION });
      store.close();
    }
  });

  test("the preflight itself: a fresh file answers null, a supported version answers itself, a mid-flight epoch answers its negative", () => {
    const at = scratch();
    const fresh = new sqlite.DatabaseSync(join(at, "fresh.db"));
    expect(schemaVersionPreflight(fresh as never, "fresh.db")).toBeNull();
    fresh.close();
    const file = baselineFile(join(at, "orders.db"));
    const db = new sqlite.DatabaseSync(file);
    expect(schemaVersionPreflight(db as never, file)).toBe(107);
    db.exec("UPDATE schema_version SET version = -107");
    expect(schemaVersionPreflight(db as never, file)).toBe(-107);
    db.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION}`);
    expect(schemaVersionPreflight(db as never, file)).toBe(SCHEMA_VERSION);
    db.close();
  });
});
