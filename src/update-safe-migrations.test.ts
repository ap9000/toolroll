/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, readSchemaVersion, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, type Database } from "./store.js";
import { LEDGER_SCHEMA, LEDGER_V54_COLUMNS, LEDGER_V99_TABLE, installLedgerTriggers } from "./action-ledger.js";
import { verifiedDatabaseBackup } from "./desktop-update.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

const GATE = "00000000-0000-4000-8000-000000000110";
let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

/**
 * `toolroll update` carries a database through a migration in place only when
 * it is classed update-safe (UPDATE_SAFE_MIGRATIONS): only additive, every saved
 * row unchanged. A new schema version must be classed one way or the other here.
 */
describe("update-safe migrations", () => {
  test("every schema version is classed: v110 to v114 are update-safe, nothing before them is", () => {
    // A new migration: decide whether `toolroll update` may run it in place (add it to
    // UPDATE_SAFE_MIGRATIONS only when it adds and changes no saved row), then move this pin.
    // v113 (MCP sign-in) only adds its four oauth_ tables plus the purpose column; v111 and v112 are the sibling token and limit migrations.
    // v114 is update-safe under the rehearsal's declared conservation rules (process summaries, notification's unused columns).
    expect(SCHEMA_VERSION).toBe(114);
    expect([...UPDATE_SAFE_MIGRATIONS]).toEqual([110, 111, 112, 113, 114]);
    expect(UPDATE_SAFE_MIGRATIONS.every(version => version > 1 && version <= SCHEMA_VERSION)).toBe(true);
  });

  test("a settled database reaches this build through update-safe migrations alone, or is refused", () => {
    expect(updateSafeSchema(SCHEMA_VERSION)).toBe(true);
    expect(updateSafeSchema(110)).toBe(true);
    expect(updateSafeSchema(109)).toBe(true);
    expect(updateSafeSchema(110)).toBe(true);
    expect(updateSafeSchema(111)).toBe(true);
    // v109 itself was never classed update-safe: a v108 database needs the separate procedure.
    expect(updateSafeSchema(108)).toBe(false);
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
    const columns = [...LEDGER_V54_COLUMNS, "detail"].join(",");
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

    // A database two migrations behind, through one never classed safe, is still refused.
    const older = new DatabaseSync(file);
    older.prepare("UPDATE schema_version SET version = 108").run();
    older.close();
    await expect(verifiedDatabaseBackup(file, join(dir, "older.backup.db"), GATE, undefined, undefined, updateSafeSchema)).rejects.toThrow(/separate verified migration procedure/);
  });
});
