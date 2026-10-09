/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, readSchemaVersion, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V115_DROPPED_TABLES, type Database } from "./store.js";
import { LEDGER_COLUMNS, LEDGER_SCHEMA, LEDGER_V99_TABLE, installLedgerTriggers } from "./action-ledger.js";
import { verifiedDatabaseBackup } from "./desktop-update.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";
import { baselineFile } from "../test/baseline.js";

const GATE = "00000000-0000-4000-8000-000000000110";
/** The 0.9.52 release: schema v114, the last with contests, held sessions, fallback chains and routines. */
const V114_RELEASE = "1fba8161a675d974e3de0b842eaf24600f94fc5f";
const REPO = join(__dirname, "..");
let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

/**
 * `toolroll update` carries a database through a migration in place only when
 * it is classed update-safe (UPDATE_SAFE_MIGRATIONS): only additive, every saved
 * row unchanged. A new schema version must be classed one way or the other here.
 */
describe("update-safe migrations", () => {
  test("every schema version is classed: v108 to v117 are update-safe, from the v107 baseline up", () => {
    // A new migration: decide whether `toolroll update` may run it in place (add it to
    // UPDATE_SAFE_MIGRATIONS only when it adds and changes no saved row), then move this pin.
    // v108 (sign-in pauses) and v109 (the pause a task waits on) each only add a table or a column.
    // v113 (MCP sign-in) only adds its four oauth_ tables plus the purpose column; v111 and v112 are the sibling token and limit migrations.
    // v114 is update-safe under the rehearsal's declared conservation rules (process summaries, notification's unused columns).
    // v115 is update-safe only under its named rules: the removed features' tables retire whole and each routine becomes one flow and trigger.
    // v116 moves every old chat table's rows into the shared chat tables, and the rehearsal checks each moved count (HISTORY_RULES' moved tables).
    // v117 renames the lead's and the subagents' tables and columns; the rehearsal checks each renamed table's rows arrived.
    expect(SCHEMA_VERSION).toBe(117);
    expect([...UPDATE_SAFE_MIGRATIONS]).toEqual([108, 109, 110, 111, 112, 113, 114, 115, 116, 117]);
    expect(UPDATE_SAFE_MIGRATIONS.every(version => version > 1 && version <= SCHEMA_VERSION)).toBe(true);
  });

  test("a settled database reaches this build through update-safe migrations alone, or is refused", () => {
    expect(updateSafeSchema(SCHEMA_VERSION)).toBe(true);
    expect(updateSafeSchema(110)).toBe(true);
    expect(updateSafeSchema(109)).toBe(true);
    expect(updateSafeSchema(111)).toBe(true);
    expect(updateSafeSchema(108)).toBe(true);
    expect(updateSafeSchema(107)).toBe(true);
    // Below the v107 baseline nothing is carried: update through 0.9.x first.
    expect(updateSafeSchema(106)).toBe(false);
    expect(updateSafeSchema(47)).toBe(false);
    // A fresh file, a mid-flight marker, nonsense, and a newer build's schema are never carried forward.
    for (const version of [null, -109, -110, -112, 0, SCHEMA_VERSION + 1, 1.5]) expect(updateSafeSchema(version)).toBe(false);
  });

  test("a v109 database is backed up for toolroll update, and its rehearsal keeps every row and the ledger chain", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-update-safe-"));
    const file = join(dir, "state.db");
    const now = new Date("2026-10-06T17:00:00.000Z");
    const first = openStore(file);
    first.createTask({ id: "t-1", title: "a task" }, now);
    first.recordAction({ at: now.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: "permission default changed", outcome: "changed", source: "policy", detail: "standard → hands-off" });
    first.sealLedger();
    const chain = first.ledgerChain({ full: true });
    first.close();
    expect(chain.ok).toBe(true);
    // The v109 shape: the v99 ledger table, its triggers back in place.
    const db = new DatabaseSync(file);
    for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%action_ledger%'").all()) db.exec(`DROP TRIGGER "${String(trigger["name"])}"`);
    const columns = LEDGER_COLUMNS.join(",");
    db.exec(LEDGER_V99_TABLE("action_ledger_old"));
    db.exec(`INSERT INTO action_ledger_old (${columns}) SELECT ${columns} FROM action_ledger; DROP TABLE action_ledger; ALTER TABLE action_ledger_old RENAME TO action_ledger`);
    db.exec(LEDGER_SCHEMA);
    installLedgerTriggers(db as never);
    db.prepare("UPDATE schema_version SET version = 109").run();
    db.close();

    // The desktop update never migrates: it still refuses anything but the current schema.
    await expect(verifiedDatabaseBackup(file, join(dir, "desktop.backup.db"), GATE)).rejects.toThrow(/separate verified migration procedure/);
    // toolroll update takes it as it is.
    const backup = join(dir, "orders.backup.db");
    expect(await verifiedDatabaseBackup(file, backup, GATE, undefined, undefined, updateSafeSchema)).toMatch(/^[a-f0-9]{64}$/);
    const copy = new DatabaseSync(backup);
    expect(readSchemaVersion(copy as unknown as Database)).toEqual({ ok: true, version: 109 });
    const before = historySnapshot(copy);
    copy.close();

    // The rehearsal: the new build migrates the copy, and no saved row changes.
    const store = openStore(backup);
    try {
      expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(SCHEMA_VERSION);
      expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
    } finally { store.close(); }
    const after = new DatabaseSync(backup, { readOnly: true });
    try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }

    // A database older than the v107 baseline is refused, in words that say what to do.
    const older = new DatabaseSync(file);
    older.prepare("UPDATE schema_version SET version = 106").run();
    older.close();
    await expect(verifiedDatabaseBackup(file, join(dir, "older.backup.db"), GATE, undefined, undefined, updateSafeSchema)).rejects.toThrow(/older than v107: update through 0\.9\.x first/);
  });

  test("a v107 database (0.5.0's baseline) is backed up for toolroll update, and its rehearsal keeps every saved row", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-update-safe-"));
    const file = baselineFile(join(dir, "state.db"));
    const backup = join(dir, "orders.backup.db");
    expect(await verifiedDatabaseBackup(file, backup, GATE, undefined, undefined, updateSafeSchema)).toMatch(/^[a-f0-9]{64}$/);
    const copy = new DatabaseSync(backup);
    expect(readSchemaVersion(copy as unknown as Database)).toEqual({ ok: true, version: 107 });
    const before = historySnapshot(copy);
    copy.close();
    openStore(backup).close();
    const after = new DatabaseSync(backup, { readOnly: true });
    try {
      expect(readSchemaVersion(after as unknown as Database)).toEqual({ ok: true, version: SCHEMA_VERSION });
      expect(changedHistory(after, before)).toEqual([]);
      expect(after.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
    } finally { after.close(); }
  });

  test("a v114 database made by 0.9.52 itself is carried to v115 by toolroll update: routines become paused or running scheduled flows, the removed tables retire, and every other row and the ledger chain stay", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-update-safe-"));
    const file = join(dir, "state.db");
    // The older runtime is the released source itself, run through its own migrating open.
    const older = join(dir, "older");
    mkdirSync(older);
    execFileSync("sh", ["-c", `git -C "$1" archive "$2" src | tar -x -C "$3"`, "sh", REPO, V114_RELEASE, older]);
    symlinkSync(join(REPO, "node_modules"), join(older, "node_modules"));
    writeFileSync(join(older, "seed.ts"), `import { openStore, SCHEMA_VERSION } from "./src/store.ts";
const now = new Date("2026-10-07T20:00:00.000Z");
const store = openStore(process.argv[2]!);
store.createTask({ id: "t-1", title: "a task" }, now);
for (let n = 0; n < 40; n++) store.recordAction({ at: now.toISOString(), actor: "alex", repo: "/w/site", taskId: "t-1", runId: null, action: "note " + n, outcome: "noted", source: "policy", detail: null });
store.sealLedger();
const routine = store.handle.prepare(\`INSERT INTO routine (name, repo, goal, touches, requirements, schedule, single_flight, cost_ceiling_usd, paused, digest, approved_at, approved_by,
  approved_digest, approved_profile_json, approved_route_json, next_fire_at, created_at, updated_at, acceptance_json, created_by) VALUES (?, '/w/site', ?, '[]', '[]', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'alex')\`);
// The owner's routine: approved, then paused. And one approved and running.
routine.run("weekly-review", "Review the week's merged work", "weekly:1:09:00", 10, 1, "d1", now.toISOString(), "alex", "d1", "{}", "{}", "2026-10-12T09:00:00.000Z", now.toISOString(), now.toISOString());
routine.run("nightly-deps", "Refresh the lockfile", "every:60", null, 0, "d2", now.toISOString(), "alex", "d2", "{}", "{}", "2026-10-07T21:00:00.000Z", now.toISOString(), now.toISOString());
store.handle.prepare("INSERT INTO routine_fire (routine_id, scheduled_for, outcome, reason, created_at) VALUES (1, ?, 'skipped', 'budget', ?)").run(now.toISOString(), now.toISOString());
console.log(JSON.stringify({ speaks: SCHEMA_VERSION, chain: store.ledgerChain({ full: true }) }));
store.close();
`);
    writeFileSync(join(older, "read.ts"), `import { openStoreNoMigrate } from "./src/store.ts";
const read = openStoreNoMigrate(process.argv[2]!);
console.log(JSON.stringify({ ok: read.ok, message: read.ok ? null : read.message }));
`);
    const tsx = (script: string) => JSON.parse(execFileSync(join(REPO, "node_modules", ".bin", "tsx"), [join(older, script), file], { cwd: older, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop()!);
    const seeded = tsx("seed.ts");
    expect(seeded).toMatchObject({ speaks: 114, chain: { ok: true } });

    // toolroll update takes it: the backup, then the rehearsal on a copy.
    const backup = join(dir, "orders.backup.db");
    expect(await verifiedDatabaseBackup(file, backup, GATE, undefined, undefined, updateSafeSchema)).toMatch(/^[a-f0-9]{64}$/);
    const copy = new DatabaseSync(backup);
    expect(readSchemaVersion(copy as unknown as Database)).toEqual({ ok: true, version: 114 });
    const before = historySnapshot(copy);
    const orphans = copy.prepare("PRAGMA foreign_key_check").all();
    copy.close();
    const store = openStore(backup);
    try {
      expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(117);
      expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: seeded.chain.through, head: seeded.chain.head });
      const moved = store.handle.prepare(`SELECT f.name, t.state, t.next_at, json_extract(t.config_json, '$.schedule') AS schedule, json_extract(t.config_json, '$.order.goal') AS goal,
        json_extract(t.config_json, '$.order.costCeilingUsd') AS ceiling, json_extract(t.config_json, '$.order.routine') AS routine, t.last_outcome
        FROM flow f JOIN flow_trigger t ON t.flow = f.id ORDER BY f.id`).all().map(row => ({ ...row }));
      expect(moved).toEqual([
        { name: "weekly-review", state: "paused", next_at: "2026-10-12T09:00:00.000Z", schedule: "weekly:1:09:00", goal: "Review the week's merged work", ceiling: 10, routine: 1, last_outcome: "Skipped (as a routine): budget." },
        { name: "nightly-deps", state: "active", next_at: "2026-10-07T21:00:00.000Z", schedule: "every:60", goal: "Refresh the lockfile", ceiling: null, routine: 2, last_outcome: null },
      ]);
      for (const table of V115_DROPPED_TABLES) expect(store.handle.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), table).toBeUndefined();
    } finally { store.close(); }
    const after = new DatabaseSync(backup, { readOnly: true });
    try {
      expect(changedHistory(after, before)).toEqual([]);
      expect(after.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
      expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual(orphans);
    } finally { after.close(); }

    // The release before it no longer reads the migrated file as its own: v116 is newer than it speaks.
    rmSync(file);
    execFileSync("cp", [backup, file]);
    expect(tsx("read.ts")).toMatchObject({ ok: false, message: expect.stringMatching(/schema v117, written by a newer build/) });
  }, 120_000);
});
