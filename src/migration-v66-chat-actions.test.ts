/** Only disposable database fixtures; no installed database is opened. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
const V65 = `CREATE TABLE lead_proposal_old (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread         INTEGER NOT NULL REFERENCES lead_thread(id) ON DELETE CASCADE,
  turn           INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('task','next','reserve','hold','unhold','steer','scope','cancel','answer','repair','agents','review','control','task_action')),
  payload_json   TEXT NOT NULL,
  ceiling_digest TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('drafting','pending','confirming','confirmed','refused','dismissed','expired')),
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolved_by    TEXT,
  outcome_json   TEXT
)`;
const NOW = new Date("2026-09-17T12:00:00Z");
describe("v66 shared action proposals", () => {
  let root: string | undefined, store: Store | undefined;
  afterEach(() => {
    store?.close();
    store = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });
  const file = () => {
    root = mkdtempSync(join(tmpdir(), "chat-v66-"));
    return join(root, "orders.db");
  };
  function oldShape(path: string, version: number, extra = false) {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec(
      extra
        ? V65.replace("outcome_json   TEXT", "outcome_json   TEXT, extra TEXT")
        : V65,
    );
    db.exec(
      "INSERT INTO lead_proposal_old (id,thread,turn,kind,payload_json,ceiling_digest,state,created_at,resolved_at,resolved_by,outcome_json) SELECT id,thread,turn,kind,payload_json,ceiling_digest,state,created_at,resolved_at,resolved_by,outcome_json FROM lead_proposal",
    );
    db.exec("DROP TABLE lead_proposal");
    db.exec("ALTER TABLE lead_proposal_old RENAME TO lead_proposal");
    db.exec("DROP TABLE service_cursor");
    db.prepare("UPDATE schema_version SET version=?").run(version);
    db.close();
  }
  test.each([65, -65])(
    "migrates v%s without changing prior proposals or review receipts, then reopens",
    (version) => {
      const path = file();
      store = openStore(path);
      store.saveApprover("operator", "fixture", NOW);
      const thread = store.openLeadThread("operator", "ceiling", NOW).thread.id;
      const first = store.draftLeadProposal(
        {
          thread,
          turn: 1,
          kind: "hold",
          payload: { task: "a", reason: "Check the result" },
          ceilingDigest: "ceiling",
        },
        NOW,
      );
      store.casLeadProposal(first, "drafting", "pending", null, null, NOW);
      store.mintCeremonyNonce(
        {
          hash: "hash",
          approver: "operator",
          subject: "scope",
          subjectId: 1,
          digest: "digest",
          ttlMs: 60000,
        },
        NOW,
      );
      const proposals = store.handle
          .prepare("SELECT * FROM lead_proposal")
          .all(),
        receipts = store.handle.prepare("SELECT * FROM ceremony_nonce").all();
      store.close();
      store = undefined;
      oldShape(path, version);
      store = openStore(path);
      expect(
        store.handle.prepare("SELECT version FROM schema_version").get()?.[
          "version"
        ],
      ).toBe(SCHEMA_VERSION);
      expect(store.handle.prepare("SELECT * FROM lead_proposal").all()).toEqual(
        proposals,
      );
      expect(
        store.handle.prepare("SELECT * FROM ceremony_nonce").all(),
      ).toEqual(receipts);
      expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual(
        [],
      );
      const action = store.draftLeadProposal(
        {
          thread,
          turn: 2,
          kind: "action",
          payload: { operation: "task_cancel" },
          ceilingDigest: "ceiling",
        },
        NOW,
      );
      expect(action).toBeGreaterThan(first);
      store.close();
      store = openStore(path);
      expect(store.getLeadProposal(action)?.kind).toBe("action");
      expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual(
        [],
      );
    },
  );
  test("a stamped current file with the old action constraint refuses rather than repairing its authority", () => {
    const path = file();
    store = openStore(path);
    store.close();
    store = undefined;
    oldShape(path, 66);
    expect(() => openStore(path)).toThrow(/shared action history/);
    const db = new DatabaseSync(path);
    expect(
      db.prepare("SELECT version FROM schema_version").get()?.["version"],
    ).toBe(66);
    expect(
      String(
        db
          .prepare("SELECT sql FROM sqlite_master WHERE name='lead_proposal'")
          .get()?.["sql"],
      ),
    ).not.toContain("'task_action','action'");
    db.close();
  });
  test("an unknown older proposal shape is not rebuilt or stripped of its data", () => {
    const path = file();
    store = openStore(path);
    store.close();
    store = undefined;
    oldShape(path, 65, true);
    expect(() => openStore(path)).toThrow(/DDL|shape/);
    const db = new DatabaseSync(path);
    expect(
      db
        .prepare("PRAGMA table_info(lead_proposal)")
        .all()
        .some((r) => r["name"] === "extra"),
    ).toBe(true);
    expect(
      db.prepare("SELECT version FROM schema_version").get()?.["version"],
    ).toBe(-65);
    db.close();
  });
});
