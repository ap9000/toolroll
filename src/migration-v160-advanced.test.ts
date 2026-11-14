/** v160: each person's "Show advanced features" (the eight plan, W4 v3). A new table; the accounts present at the upgrade
 * get an ON row once, in the transaction that makes the table; anyone after reads off (the demo on). Never by time. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { advancedPreferenceOf, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V160_STEPS, type Store } from "./store.js";
import { V160_TABLES } from "./advanced-schema.js";
import { advancedShownFor } from "./advanced.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-13T00:00:00.000Z");
const rows = (store: Store) => store.handle.prepare("SELECT account, advanced, source, updated_at FROM view_preference ORDER BY account").all().map(one => ({ ...one }));
const version = (store: Store) => store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];

/** A v159 file: made by this build, then the v160 table dropped and the version put back, as an older build left it. */
function v159File(accounts: (store: Store) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v160-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  accounts(made);
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V160_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 159");
  raw.close();
  return file;
}
const people = (store: Store) => {
  store.saveApprover("alex", "hash-a", T0);
  store.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, role, generation) VALUES ('vic', 'hash-v', ?, 'viewer', 1)").run(T0.toISOString());
  store.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, role, generation, revoked_at, revoked_by) VALUES ('gone', 'hash-g', ?, 'approver', 2, ?, 'alex')").run(T0.toISOString(), T0.toISOString());
};

describe("v160", () => {
  test("fresh: the table, no rows, update-safe; a new account reads off, the demo on", () => {
    expect(SCHEMA_VERSION).toBe(161);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(160);
    expect(updateSafeSchema(159)).toBe(true);
    expect(V160_STEPS).toEqual(["advanced-preference"]);
    const fresh = openStore(":memory:");
    expect(rows(fresh)).toEqual([]);
    fresh.saveApprover("newcomer", "hash", T0);
    expect(advancedPreferenceOf(fresh, "newcomer")).toBeNull();
    expect(advancedShownFor(fresh, "newcomer")).toBe(false);
    fresh.recordInstallationFact("demo", "1", T0);
    expect(advancedShownFor(fresh, "newcomer")).toBe(true);
    // The table refuses what it can't name.
    expect(() => fresh.handle.prepare("INSERT INTO view_preference (account, advanced, source) VALUES ('x', 2, 'person')").run()).toThrow();
    expect(() => fresh.handle.prepare("INSERT INTO view_preference (account, advanced, source) VALUES ('x', 1, 'guess')").run()).toThrow();
    fresh.close();
  });

  test("an upgrade keeps everything on for each account present (no time on the row); revoked accounts get none", () => {
    const file = v159File(people);
    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining([...V160_STEPS]));
    expect(version(upgraded)).toBe(161);
    expect(rows(upgraded)).toEqual([
      { account: "alex", advanced: 1, source: "upgrade", updated_at: null },
      { account: "vic", advanced: 1, source: "upgrade", updated_at: null },
    ]);
    expect(advancedShownFor(upgraded, "alex")).toBe(true);
    expect(advancedShownFor(upgraded, "gone")).toBe(false);
    // A credential replaced later (approver.added_at moves) changes nothing: the default never reads a timestamp.
    upgraded.saveApprover("alex", "hash-a2", new Date("2027-01-01T00:00:00.000Z"));
    expect(advancedShownFor(upgraded, "alex")).toBe(true);
    // Someone who joins after the upgrade starts with it off.
    upgraded.saveApprover("robin", "hash-r", T0);
    expect(advancedShownFor(upgraded, "robin")).toBe(false);
    upgraded.close();
    const again = openStore(file);
    expect(version(again)).toBe(161);
    expect(rows(again).map(one => one["account"])).toEqual(["alex", "vic"]);
    again.close();
  });

  test("an accountless upgrade writes nothing; its first account reads off", () => {
    const file = v159File(() => {});
    const upgraded = openStore(file);
    expect(rows(upgraded)).toEqual([]);
    expect(upgraded.bootstrapApproverIfNone("first", "hash", T0)).toEqual({ ok: true });
    expect(advancedShownFor(upgraded, "first")).toBe(false);
    upgraded.close();
  });

  test("a later upgrade never backfills: an account made after v160 keeps no row", () => {
    const file = v159File(people);
    const upgraded = openStore(file);
    upgraded.saveApprover("robin", "hash-r", T0);
    upgraded.close();
    // As the next schema's upgrade would: the version below this build's, the table already here.
    const raw = new DatabaseSync(file);
    raw.exec("UPDATE schema_version SET version = 159");
    raw.close();
    const later = openStore(file);
    expect(version(later)).toBe(161);
    expect(advancedPreferenceOf(later, "robin")).toBeNull();
    expect(rows(later).map(one => one["account"])).toEqual(["alex", "vic"]);
    later.close();
  });

  test.each([["one-step-chat-columns"], ["advanced-preference"]])("a crash after %s resumes to exactly the uninterrupted rows", step => {
    const file = v159File(people);
    expect(() => openStore(file, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    const peek = new DatabaseSync(file, { readOnly: true });
    try { expect(peek.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(-159); } finally { peek.close(); }
    const resumed = openStore(file);
    expect(version(resumed)).toBe(161);
    expect(rows(resumed)).toEqual([
      { account: "alex", advanced: 1, source: "upgrade", updated_at: null },
      { account: "vic", advanced: 1, source: "upgrade", updated_at: null },
    ]);
    resumed.close();
  });

  test("removing an account removes its row", () => {
    const store = openStore(":memory:");
    store.saveApprover("alex", "hash-a", T0);
    store.saveApprover("sam", "hash-s", T0);
    store.handle.prepare("INSERT INTO view_preference (account, advanced, source, updated_at) VALUES ('sam', 1, 'person', ?)").run(T0.toISOString());
    expect(store.revokeAccount("sam", "alex", T0)).toMatchObject({ ok: true });
    expect(advancedPreferenceOf(store, "sam")).toBeNull();
    store.close();
  });

  test.each([
    ["missing", "DROP TABLE view_preference", /view_preference table is missing/],
    ["wrong columns", "DROP TABLE view_preference; CREATE TABLE view_preference (account TEXT PRIMARY KEY, advanced INTEGER)", /view_preference table has an unknown shape/],
    ["a loosened check", "DROP TABLE view_preference; CREATE TABLE view_preference (account TEXT PRIMARY KEY, advanced INTEGER NOT NULL, source TEXT NOT NULL CHECK (source IN ('upgrade', 'person')), updated_at TEXT)", /unknown shape/],
  ])("a current file whose table is %s is refused, not opened", (_name, damage, message) => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v160-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(damage);
    raw.close();
    expect(() => openStore(file)).toThrow(message);
  });

  test("a resumed upgrade whose table was damaged is refused", () => {
    const file = v159File(people);
    expect(() => openStore(file, { migrationStep: at => { if (at === "advanced-preference") throw new Error("crash"); } })).toThrow("crash");
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE view_preference; CREATE TABLE view_preference (account TEXT, advanced INTEGER)");
    raw.close();
    expect(() => openStore(file)).toThrow(/view_preference table has an unknown shape/);
  });

  test.each([
    ["missing", "DROP TABLE view_preference"],
    ["without its account column", "DROP TABLE view_preference; CREATE TABLE view_preference (who TEXT, advanced INTEGER)"],
  ])("a damaged table (%s) never blocks a revocation", (_name, damage) => {
    const store = openStore(":memory:");
    store.saveApprover("alex", "hash-a", T0);
    store.saveApprover("sam", "hash-s", T0);
    store.handle.exec(damage);
    expect(store.revokeAccount("sam", "alex", T0)).toMatchObject({ ok: true });
    expect(store.accountOf("sam")?.revokedAt).toBe(T0.toISOString());
    // And the revocation's own transaction went through whole: sam's live state ended with it.
    expect(store.revokeAccount("sam", "alex", T0)).toEqual({ ok: false, reason: "already-revoked" });
    store.close();
  });
});
