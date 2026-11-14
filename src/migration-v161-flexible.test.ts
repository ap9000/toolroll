/** v161: Flexible projects' terms (the Flexible plan v2, slice F1). A new table only: every saved project reads Secure,
 * a crash resumes to the same shape, and a table in a shape this build can't name refuses to open. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V161_STEPS } from "./store.js";
import { V161_TABLES } from "./flexible-schema.js";
import { flexibleStanding } from "./flexible.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = "2026-11-13T00:00:00.000Z";
const REPO = "/work/app";

/** A v160 file: made by this build with a project, then the v161 table dropped and the version put back. */
function v160File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v161-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", new Date(T0));
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V161_TABLES) raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE schema_version SET version = 160");
  raw.close();
  return file;
}
const insert = (db: DatabaseSync | { prepare: DatabaseSync["prepare"] }, over: Record<string, unknown> = {}) => {
  const row = { repo: REPO, terms_json: "{}", digest: "d", signed_terms_json: "{}", signed_digest: "d", signed_by: "alex", signed_at: T0, proof: "password-now", changed_by: "alex", changed_at: T0, ...over };
  return db.prepare(`INSERT INTO flexible_terms (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...(Object.values(row) as (string | number | null)[]));
};

describe("v161", () => {
  test("fresh: the table, no rows, update-safe; a project reads Secure", () => {
    expect(SCHEMA_VERSION).toBe(161);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(161);
    expect(updateSafeSchema(160)).toBe(true);
    expect(V161_STEPS).toEqual(["flexible-terms"]);
    const fresh = openStore(":memory:");
    expect(fresh.handle.prepare("SELECT COUNT(*) AS n FROM flexible_terms").get()?.["n"]).toBe(0);
    expect(flexibleStanding(fresh, REPO)).toEqual({ state: "secure" });
    fresh.close();
  });

  test("the table refuses what it can't name, keeps one live row per project, and writes a row once", () => {
    const store = openStore(":memory:");
    const db = store.handle;
    expect(() => insert(db, { proof: "session" })).toThrow();
    expect(() => insert(db, { end_reason: "off" })).toThrow();
    expect(() => insert(db, { ended_at: T0, end_reason: "guess", ended_by: "alex" })).toThrow();
    expect(() => insert(db, { terms_json: "x".repeat(16_385) })).toThrow();
    const id = Number(insert(db).lastInsertRowid);
    expect(() => insert(db)).toThrow(/UNIQUE/);
    // Ended rows don't count toward the one live row.
    insert(db, { repo: "/work/other", ended_at: T0, ended_by: "alex", end_reason: "off" });
    insert(db, { repo: "/work/other" });
    // Written once: no term, digest, signer or proof changes; it ends once, then never changes again.
    for (const column of ["terms_json", "digest", "signed_terms_json", "signed_digest", "signed_by", "proof", "changed_by", "repo"]) {
      expect(() => db.prepare(`UPDATE flexible_terms SET ${column} = 'changed' WHERE id = ?`).run(id), column).toThrow(/written once/);
    }
    db.prepare("UPDATE flexible_terms SET ended_at = ?, ended_by = 'alex', end_reason = 'off' WHERE id = ?").run(T0, id);
    expect(() => db.prepare("UPDATE flexible_terms SET end_reason = 'lowered' WHERE id = ?").run(id)).toThrow(/written once/);
    expect(() => db.prepare("UPDATE flexible_terms SET ended_at = NULL, ended_by = NULL, end_reason = NULL WHERE id = ?").run(id)).toThrow(/written once/);
    store.close();
  });

  test("an upgrade adds the table and changes no saved row: every saved project reads Secure", () => {
    const file = v160File();
    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toEqual(expect.arrayContaining([...V161_STEPS]));
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(161);
    expect(flexibleStanding(upgraded, REPO)).toEqual({ state: "secure" });
    upgraded.close();
  });

  test.each([["advanced-preference"], ["flexible-terms"]])("a crash after %s resumes to the same shape", step => {
    const file = v160File();
    expect(() => openStore(file, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    const resumed = openStore(file);
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(161);
    expect(resumed.handle.prepare("SELECT COUNT(*) AS n FROM flexible_terms").get()?.["n"]).toBe(0);
    resumed.close();
  });

  test.each([
    ["the table", "DROP TABLE flexible_terms; CREATE TABLE flexible_terms (id INTEGER PRIMARY KEY, repo TEXT, terms_json TEXT)", /flexible_terms table flexible_terms has an unknown shape/],
    ["the trigger", "DROP TRIGGER flexible_terms_written_once", /trigger flexible_terms_written_once is missing/],
    ["the index", "DROP INDEX flexible_terms_live; CREATE INDEX flexible_terms_live ON flexible_terms (repo)", /index flexible_terms_live has an unknown shape/],
  ])("a current file whose %s isn't this build's refuses to open", (_what, damage, refusal) => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v161-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(damage);
    raw.close();
    expect(() => openStore(file)).toThrow(refusal);
  });
});
