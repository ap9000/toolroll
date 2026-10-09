import type { Database } from "./store.js";
import { activeCodingUpdateWork, installCodingUpdateGate, removeCodingUpdateGate } from "./coding-update.js";

export const UPDATE_PAUSED = "Toolroll is updating. Current work can finish; new work will resume after the update. Open Update status in the desktop app.";
const prefix = "so_desktop_update_";
const rows = (db: Database) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_desktop_update_*' ORDER BY name").all();
const statements = (id: string, frozen = false): string[] => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid update identity.");
  return [
    `CREATE TRIGGER ${prefix}claim BEFORE INSERT ON claim BEGIN SELECT RAISE(ABORT, '${UPDATE_PAUSED} [${id}]'); END`,
    `CREATE TRIGGER ${prefix}mate BEFORE INSERT ON mate_turn BEGIN SELECT RAISE(ABORT, '${UPDATE_PAUSED} [${id}]'); END`,
    `CREATE TRIGGER ${prefix}run BEFORE INSERT ON run ${frozen ? "" : "WHEN NEW.parent_run IS NULL AND NOT EXISTS (SELECT 1 FROM claim WHERE lease_id=NEW.lease_id AND released_at IS NULL) "}BEGIN SELECT RAISE(ABORT, '${UPDATE_PAUSED} [${id}]'); END`,
    // An already-owned mate turn may finish its remaining provider steps.
    `CREATE TRIGGER ${prefix}chat BEFORE INSERT ON chat_turn ${frozen ? "" : "WHEN NEW.mate_turn IS NULL "}BEGIN SELECT RAISE(ABORT, '${UPDATE_PAUSED} [${id}]'); END`,
  ];
};

/** SQLite enforces the gate even for a CLI racing an old in-memory snapshot.
 * Existing leases, replies, heartbeats and task data remain writable. */
export function installUpdateGate(db: Database, id: string): void {
  const wanted = statements(id);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = rows(db);
    if (existing.length > 0 && (existing.length !== wanted.length || existing.some(row => ![...wanted, ...statements(id, true)].includes(String(row.sql))))) throw Error("Another or unrecognized update owns admission. Recover that update first.");
    if (existing.length === 0) for (const statement of wanted) db.exec(statement);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  installCodingUpdateGate(db, id);
}

export function removeUpdateGate(db: Database, id: string): void {
  const wanted = [...statements(id), ...statements(id, true)];
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = rows(db);
    if (existing.some(row => !wanted.includes(String(row.sql)))) throw Error("This update does not own the admission pause. Nothing was cleared.");
    removeCodingUpdateGate(db, id);
    for (const row of existing) db.exec(`DROP TRIGGER "${String(row.name)}"`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function updateAdmissionPaused(db: Database): boolean { return rows(db).length > 0; }

export function updateGateOwned(db: Database, id: string): boolean {
  const wanted = [...statements(id), ...statements(id, true)], existing = rows(db);
  return existing.length === statements(id).length && existing.every(row => wanted.includes(String(row.sql)));
}

export function activeUpdateWork(db: Database): Record<string, number> {
  const count = (sql: string) => Number(db.prepare(sql).get()?.n ?? 0);
  return {
    runs: count("SELECT count(*) n FROM run WHERE outcome IS NULL"),
    claims: count("SELECT count(*) n FROM claim WHERE released_at IS NULL"),
    conversations: count("SELECT count(*) n FROM mate_turn WHERE state IN ('queued','running')") + count("SELECT count(*) n FROM chat_turn WHERE state IN ('queued','running')"),
    stopping: count("SELECT count(*) n FROM run_stop WHERE settled_at IS NULL"),
    ...activeCodingUpdateWork(db),
  };
}

/** Last admission race closes in the same SQLite write transaction as the
 * empty-work check. Existing work is never killed to satisfy an update. */
export function freezeUpdateGate(db: Database, id: string): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!updateGateOwned(db, id)) throw Error("The update no longer owns admission.");
    installCodingUpdateGate(db, id);
    const idle = Object.values(activeUpdateWork(db)).every(n => n === 0);
    if (idle) {
      for (const row of rows(db)) db.exec(`DROP TRIGGER "${String(row.name)}"`);
      for (const sql of statements(id, true)) db.exec(sql);
    }
    db.exec("COMMIT"); return idle;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
