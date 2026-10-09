import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { rebuildLeadSessionForV36 } from "./store.js";

const V35_LEAD_SESSION = `CREATE TABLE lead_session (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  approver            TEXT NOT NULL,
  approver_generation INTEGER NOT NULL,
  credential_key      TEXT NOT NULL,
  ceiling_microusd    INTEGER NOT NULL,
  spent_microusd      INTEGER NOT NULL DEFAULT 0,
  ceiling_digest      TEXT NOT NULL,
  terms_digest        TEXT NOT NULL,
  minted_at           TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  ended_at            TEXT,
  ended_by            TEXT
)`;

describe("schema v36: mate conversations use an explicit lifecycle", () => {
  const fresh = () => {
    const db = new DatabaseSync(":memory:");
    db.exec(V35_LEAD_SESSION);
    db.exec("CREATE INDEX lead_session_live ON lead_session (approver, ended_at, expires_at)");
    return db;
  };

  test("rows survive, legacy live grants close, and expiry leaves the schema", () => {
    const db = fresh();
    db.exec(`INSERT INTO lead_session VALUES
      (7, 'alex', 1, 'cred', 5000000, 42, 'ceiling', 'terms', '2026-09-02T12:00:00.000Z', '2026-09-02T16:00:00.000Z', NULL, NULL),
      (8, 'sam', 2, 'cred-2', 9000000, 5, 'ceiling-2', 'terms-2', '2026-09-01T12:00:00.000Z', '2026-09-01T16:00:00.000Z', '2026-09-01T13:00:00.000Z', 'sam')`);

    rebuildLeadSessionForV36(db);

    expect(db.prepare("PRAGMA table_info(lead_session)").all().map(row => row["name"])).not.toContain("expires_at");
    expect(db.prepare("SELECT id, spent_microusd, ended_at, ended_by FROM lead_session ORDER BY id").all()).toEqual([
      { id: 7, spent_microusd: 42, ended_at: expect.any(String), ended_by: "v36-migration" },
      { id: 8, spent_microusd: 5, ended_at: "2026-09-01T13:00:00.000Z", ended_by: "sam" },
    ]);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'lead_session_live'").get()?.["sql"]).toContain("(approver, ended_at)");
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'lead_session'").get()?.["sql"]);
    rebuildLeadSessionForV36(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'lead_session'").get()?.["sql"])).toBe(ddl);
  });

  test("a lookalike table is refused rather than copied", () => {
    const db = fresh();
    db.exec("ALTER TABLE lead_session ADD COLUMN surprise TEXT");
    expect(() => rebuildLeadSessionForV36(db)).toThrow(/not a shape this migration knows/);
  });
});
