/**
 * A file as v117 wrote it, from one this build made: the three credential tables (api_token, coordinator_credential,
 * lead_credential) in their last shapes with every row the one credential table holds, the references naming them,
 * and the coordinator ledger trigger on its old table. Isolated fixtures only.
 */
import type { DatabaseSync } from "node:sqlite";

const API_TOKEN = `CREATE TABLE api_token (
  id           TEXT PRIMARY KEY,
  account      TEXT NOT NULL REFERENCES approver(name),
  name         TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  access       TEXT NOT NULL CHECK (access IN ('read','act')),
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  revoked_by   TEXT
, projects_json TEXT, replaces TEXT, replaced_by TEXT, overlap_until TEXT, purpose TEXT NOT NULL DEFAULT 'api' CHECK (purpose IN ('api','mcp')))`;
const COORDINATOR = `CREATE TABLE coordinator_credential (
  cid             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  repos           TEXT NOT NULL,
  per_hour        INTEGER NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  revoked_at      TEXT
, expires_at TEXT)`;
const LEAD = `CREATE TABLE lead_credential (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT
)`;

export function toV117(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`${API_TOKEN}; CREATE INDEX api_token_account ON api_token (account); ${COORDINATOR}; ${LEAD}; CREATE INDEX lead_credential_owner ON lead_credential (owner);`);
  db.exec(`INSERT INTO api_token SELECT public_id, account, name, secret_hash, access, created_at, created_by, expires_at, last_used_at, revoked_at, revoked_by,
    projects_json, replaces, replaced_by, overlap_until, purpose FROM credential WHERE kind = 'person' ORDER BY rowid`);
  db.exec(`INSERT INTO coordinator_credential SELECT public_id, name, secret_hash, projects_json, per_hour, created_by, created_at, revoked_at, expires_at
    FROM credential WHERE kind = 'coordinator' ORDER BY rowid`);
  db.exec(`INSERT INTO lead_credential SELECT public_id, account, secret_hash, created_at, created_by, revoked_at, revoked_by FROM credential WHERE kind = 'lead' ORDER BY rowid`);
  const version = Number(db.prepare("PRAGMA schema_version").get()!["schema_version"]);
  (db as unknown as { enableDefensive?: (on: boolean) => void }).enableDefensive?.(false);
  db.exec("PRAGMA writable_schema = ON");
  for (const row of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%REFERENCES credential(id)%'").all() as { name: string; sql: string }[]) {
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?")
      .run(row.sql.replaceAll("REFERENCES credential(id)", row.name.startsWith("oauth_") ? "REFERENCES api_token(id)" : "REFERENCES coordinator_credential(cid)"), row.name);
  }
  db.exec(`PRAGMA schema_version = ${version + 1}`);
  db.exec("PRAGMA writable_schema = OFF");
  db.exec("DROP TABLE credential");
  db.exec(`CREATE UNIQUE INDEX coordinator_live_name
  ON coordinator_credential (name) WHERE revoked_at IS NULL;
CREATE TRIGGER ledger_coordinator_minted AFTER INSERT ON coordinator_credential BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source,detail) VALUES (NEW.created_at, NEW.created_by, NULL, NULL, NULL,
    'coordinator minted: ' || NEW.name, 'minted', 'access', 'projects: ' || NEW.repos);
END;`);
  db.prepare("UPDATE schema_version SET version = 117").run();
  db.exec("PRAGMA foreign_keys = ON");
}
