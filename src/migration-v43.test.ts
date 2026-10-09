import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { rebuildLeadProposalForV43 } from "./store.js";

const V42 = `CREATE TABLE lead_proposal (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread         INTEGER NOT NULL REFERENCES lead_thread(id) ON DELETE CASCADE,
  turn           INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('task','next','reserve','hold','unhold','scope','cancel','answer','repair')),
  payload_json   TEXT NOT NULL,
  ceiling_digest TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('drafting','pending','confirming','confirmed','refused','dismissed','expired')),
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolved_by    TEXT,
  outcome_json   TEXT
)`;

describe("schema v43: steering joins lead proposals", () => {
  const fresh = () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE lead_thread (id INTEGER PRIMARY KEY AUTOINCREMENT, approver TEXT NOT NULL)");
    db.exec("INSERT INTO lead_thread (approver) VALUES ('alex')");
    return db;
  };

  test("keeps existing rows and ids, admits steering, restores the index, and is idempotent", () => {
    const db = fresh();
    db.exec(V42);
    db.exec("CREATE INDEX lead_proposal_thread ON lead_proposal (thread, state)");
    db.exec("INSERT INTO lead_proposal (id, thread, turn, kind, payload_json, ceiling_digest, state, created_at) VALUES (7, 1, 1, 'repair', '{}', 'd', 'pending', 'x')");

    rebuildLeadProposalForV43(db);

    expect(db.prepare("SELECT id, kind FROM lead_proposal").all()).toEqual([{ id: 7, kind: "repair" }]);
    db.exec("INSERT INTO lead_proposal (thread, turn, kind, payload_json, ceiling_digest, state, created_at) VALUES (1, 2, 'steer', '{}', 'd', 'pending', 'y')");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'lead_proposal_thread'").get()).toBeDefined();
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'lead_proposal'").get()?.["sql"]);
    rebuildLeadProposalForV43(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'lead_proposal'").get()?.["sql"])).toBe(ddl);
  });

  test("refuses an unknown predecessor shape without dropping it", () => {
    const db = fresh();
    db.exec(V42.replace("outcome_json   TEXT", "outcome_json   TEXT, extra TEXT"));
    expect(() => rebuildLeadProposalForV43(db)).toThrow(/not a shape this migration knows/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'lead_proposal'").get()).toBeDefined();
  });
});
