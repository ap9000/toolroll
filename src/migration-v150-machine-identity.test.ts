/**
 * Schema v150 (machine-identity.ts): each process witness gains this machine's stable id and the hostnames a machine
 * id was seen under get a table; no saved row changes. A fresh database, an upgrade from v149 (and from one that
 * stopped mid-way), a crash after each step resuming to the same rows, the update rehearsal's history rules, and a
 * saved witness, which keeps being matched by its host name. Isolated databases only.
 */
import { afterEach, describe, expect, test } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V150_ADDED_COLUMNS, V150_STEPS, V150_TABLES, type MigrationStep, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";
import { injectMachineIdentity } from "./machine-identity.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const AT = NOW.toISOString();
let dir: string | undefined;
const open: Store[] = [];
afterEach(() => {
  for (const one of open.splice(0)) { try { one.close(); } catch { /* closed */ } }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  injectMachineIdentity(null);
});
const opened = (store: Store): Store => { open.push(store); return store; };

/** A v149 database with a finished run and two open witnesses (this machine's name, another's): then v150 taken away. */
function v149Fixture(version: 149 | -149): string {
  dir ??= mkdtempSync(join(tmpdir(), "so-v150-"));
  const file = join(dir, `v149-${version < 0 ? "mid" : "at"}.db`);
  const first = openStore(file);
  first.createTask({ id: "pay", title: "Round payouts" }, NOW);
  const ref = first.refFor(BUILT_IN, "pay").id;
  const run = first.startRun({ taskRef: ref, leaseId: "lease-1", runner: "worker", branch: "standing-orders/pay", worktree: "/pool/pay",
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: NOW });
  first.finishRun(run, { outcome: "failed", reason: "agent", now: NOW });
  first.close();
  const db = new DatabaseSync(file);
  for (const table of V150_TABLES) db.exec(`DROP TABLE ${table}`);
  for (const [table, columns] of Object.entries(V150_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("INSERT INTO run_process (run, host, process_group, observed_at) VALUES (?, ?, 1, ?), (?, 'other-mac', 1, ?)").run(run, hostname(), AT, run, AT);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  return file;
}
const rowsOf = (store: Store) => Object.fromEntries(["run", "run_process", ...V150_TABLES].map(table =>
  [table, store.handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));

describe("the v150 migration", () => {
  test("a fresh database has the table and the column", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v150-"));
    const store = opened(openStore(join(dir, "fresh.db")));
    expect(SCHEMA_VERSION).toBe(151);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(151);
    expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'machine_host_alias'").get()).toBeDefined();
    expect(store.handle.prepare("PRAGMA table_info(run_process)").all().map(row => String(row["name"]))).toContain("machine_id");
  });

  test.each([149, -149] as const)("v%s: the table and column arrive, saved witnesses read no id and keep their host match", version => {
    injectMachineIdentity({ ok: true, id: "a".repeat(32), source: "injected" }, []);
    const file = v149Fixture(version);
    expect(updateSafeSchema(149)).toBe(true);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(150);
    const store = opened(openStore(file));
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(151);
    expect(store.handle.prepare("SELECT host, machine_id FROM run_process ORDER BY id").all().map(row => ({ ...row })))
      .toEqual([{ host: hostname(), machine_id: null }, { host: "other-mac", machine_id: null }]);
    // No saved name is taken for this machine's: the alias table starts empty.
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM machine_host_alias").get()?.["n"]).toBe(0);
    // The saved witness under this machine's name is still this machine's; the other one still another computer's.
    const run = Number(store.handle.prepare("SELECT id FROM run").get()!["id"]);
    expect(store.stopQuiescenceFact(run)?.kind).toBe("elsewhere");
    store.handle.prepare("UPDATE run_process SET exited_at = ? WHERE host = 'other-mac'").run(AT);
    expect(store.stopQuiescenceFact(run)?.kind).not.toBe("elsewhere");
    // The new shapes refuse what they can't name.
    expect(() => store.handle.prepare("UPDATE run_process SET machine_id = 'short'").run()).toThrow();
    expect(() => store.handle.prepare("INSERT INTO machine_host_alias (machine_id, host, first_seen_at) VALUES (?, '', ?)").run("a".repeat(32), AT)).toThrow();
  });

  test("the update rehearsal's history rules accept the migration on its own", () => {
    const file = v149Fixture(149);
    const db = new DatabaseSync(file);
    const before = historySnapshot(db);
    db.close();
    opened(openStore(file)).close();
    open.length = 0;
    const after = new DatabaseSync(file, { readOnly: true });
    try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
  });

  test.each(V150_STEPS.map(step => [step]))("a crash after %s resumes on the next open, to exactly the rows an uninterrupted migration makes", (step: MigrationStep) => {
    const fixture = v149Fixture(149);
    const reference = join(dir!, "reference.db"), crashed = join(dir!, "crashed.db");
    copyFileSync(fixture, reference);
    copyFileSync(fixture, crashed);
    const whole = opened(openStore(reference));
    expect(() => openStore(crashed, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    const peek = new DatabaseSync(crashed, { readOnly: true });
    try { expect(peek.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(-149); } finally { peek.close(); }
    const resumed = opened(openStore(crashed));
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(151);
    expect(rowsOf(resumed)).toEqual(rowsOf(whole));
  });
});
