/**
 * Live terminals, written down for the updater (docs/plans/live-terminal.md, review round 2 finding 7). Terminals live
 * in the console's memory, but an update is decided by another process, so each one is a row in a small catalog
 * beside the database (`<db>.terminals.sqlite`), as the coding workspace keeps its own:
 *
 * - a start inserts its row before any work, and an update's gate (a trigger) refuses that insert while the update
 *   owns admission: no terminal starts during a drain;
 * - a row is `starting` or `running` until the terminal's sweep ends, then deleted — or kept as `uncertain` when the
 *   sweep couldn't prove its processes gone, until the terminal is removed; the updater counts rows whose console is
 *   still alive as active work, so "update when idle" waits for running and unproved terminals;
 * - rows of a console that is gone are stale (its programs went with it, or are swept at its next start).
 */
import { chmodSync, lstatSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { processMayBeAlive } from "./process-liveness.js";
import { sqliteRuntime } from "./sqlite-runtime.js";
import type { Database } from "./store.js";
import type { TerminalLedger } from "./live-terminal.js";

const gatePrefix = "so_terminal_update_";
const PAUSED = "Toolroll is updating. Running terminals keep going; new ones can start after the update.";
const SCHEMA = "CREATE TABLE IF NOT EXISTS live_terminal (id TEXT PRIMARY KEY, console_pid INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('starting','running','uncertain')), at TEXT NOT NULL)";

export function terminalCatalogPath(orders: Database): string | null {
  const main = orders.prepare("PRAGMA database_list").all().find(row => row["name"] === "main")?.["file"];
  return typeof main === "string" && main !== "" ? `${main}.terminals.sqlite` : null;
}

function exists(file: string): boolean {
  try { return lstatSync(file).isFile(); } catch { return false; }
}

function open(file: string, readOnly: boolean): DatabaseSync {
  if (exists(file) && lstatSync(file).isSymbolicLink()) throw Error("The terminal catalog is linked, not a regular database.");
  const db = new (sqliteRuntime().DatabaseSync)(file, { readOnly });
  db.exec("PRAGMA busy_timeout=1000");
  return db;
}

/** The updater's read: never creates the catalog. */
function withCatalog<T>(orders: Database, absent: T, readOnly: boolean, action: (db: DatabaseSync) => T): T {
  const file = terminalCatalogPath(orders);
  if (file === null || !exists(file)) return absent;
  const db = open(file, readOnly);
  try { return action(db); } finally { db.close(); }
}

/** The console's ledger: creates the catalog, drops rows of consoles that are gone, and writes its own. */
export function openTerminalLedger(orders: Database, alive: (pid: number) => boolean = pid => processMayBeAlive(pid, false)): TerminalLedger | null {
  const file = terminalCatalogPath(orders);
  if (file === null) return null;
  const db = open(file, false);
  chmodSync(file, 0o600);
  db.exec(SCHEMA);
  for (const row of db.prepare("SELECT DISTINCT console_pid FROM live_terminal").all()) {
    const pid = Number(row["console_pid"]);
    if (pid !== process.pid && !alive(pid)) db.prepare("DELETE FROM live_terminal WHERE console_pid=?").run(pid);
  }
  return {
    reserve(id) {
      // Fail closed even where this catalog had no gate to install (it didn't exist yet when the update began): the main
      // database's own admission pause refuses too.
      if (orders.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_desktop_update_*' LIMIT 1").get() !== undefined) throw new Error(PAUSED);
      try { db.prepare("INSERT INTO live_terminal (id, console_pid, state, at) VALUES (?, ?, 'starting', ?)").run(id, process.pid, new Date().toISOString()); }
      catch (error) { throw new Error(error instanceof Error && error.message.includes(PAUSED) ? PAUSED : "No terminal can start right now (its record couldn't be written)."); }
    },
    running(id) { db.prepare("UPDATE live_terminal SET state='running', at=? WHERE id=?").run(new Date().toISOString(), id); },
    // A sweep that couldn't prove its processes gone stays written down: the updater counts it while this console lives.
    release(id, cleanup) {
      try {
        if (cleanup === "uncertain") db.prepare("UPDATE live_terminal SET state='uncertain', at=? WHERE id=?").run(new Date().toISOString(), id);
        else db.prepare("DELETE FROM live_terminal WHERE id=?").run(id);
      } catch { /* the next start drops it as stale */ }
    },
    forget(id) { try { db.prepare("DELETE FROM live_terminal WHERE id=?").run(id); } catch { /* stale later */ } },
  };
}

function gateStatement(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid update identity.");
  return `CREATE TRIGGER ${gatePrefix}start BEFORE INSERT ON live_terminal BEGIN SELECT RAISE(ABORT, '${PAUSED} [${id}]'); END`;
}

function changeGate(db: DatabaseSync, id: string, install: boolean): void {
  const wanted = gateStatement(id);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA);
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_terminal_update_*'").all();
    if (rows.some(row => String(row["sql"]) !== wanted)) throw Error("Another or unrecognized update owns terminal admission. Its gate was preserved.");
    if (install && rows.length === 0) db.exec(wanted);
    if (!install) for (const row of rows) db.exec(`DROP TRIGGER "${String(row["name"])}"`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function installTerminalUpdateGate(orders: Database, id: string): void { withCatalog(orders, undefined, false, db => changeGate(db, id, true)); }
export function removeTerminalUpdateGate(orders: Database, id: string): void { withCatalog(orders, undefined, false, db => changeGate(db, id, false)); }

/** Terminals starting or running in a console that is still alive: active work an update waits for. */
export function activeTerminalUpdateWork(orders: Database, alive: (pid: number) => boolean = pid => processMayBeAlive(pid, false)): { terminals: number } {
  return withCatalog(orders, { terminals: 0 }, true, db => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_terminal'").get()) return { terminals: 0 };
    const rows = db.prepare("SELECT console_pid FROM live_terminal").all();
    return { terminals: rows.filter(row => alive(Number(row["console_pid"]))).length };
  });
}
