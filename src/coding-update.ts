import { createHash } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import { isThisMachine } from './machine-identity.js';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteRuntime } from './sqlite-runtime.js';
import { processMayBeAlive } from './process-liveness.js';
import type { Database } from './store.js';

const gatePrefix = 'so_coding_update_';
const pausedMessage = 'Toolroll is updating. Current work can finish; new coding work will resume after the update.';

export function codingCatalogPath(orders: Database): string | null {
  const main = orders.prepare('PRAGMA database_list').all().find(row => row['name'] === 'main')?.['file'];
  return typeof main === 'string' && main !== '' ? `${main}.coding.sqlite` : null;
}

export function codingCatalogExists(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function connect(file: string, readOnly: boolean): DatabaseSync {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('The coding catalog is linked or not a regular database. No app was replaced.');
  const db = new (sqliteRuntime().DatabaseSync)(file, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=1000');
    for (const table of ['coding_owner', 'coding_session', 'coding_item', 'coding_request', 'coding_submission']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw Error('The coding catalog is incomplete. Preserve it and resolve its state before updating.');
    }
    if (!db.prepare('SELECT 1 FROM coding_owner WHERE singleton=1').get()) throw Error('The coding catalog has no process ownership record. Preserve it and resolve its state before updating.');
    return db;
  } catch (error) { db.close(); throw error; }
}

function withCatalog<T>(orders: Database, absent: T, readOnly: boolean, action: (db: DatabaseSync) => T): T {
  const file = codingCatalogPath(orders);
  // A legacy installation has no coding catalog. Never create one in the updater.
  if (file === null || !codingCatalogExists(file)) return absent;
  const db = connect(file, readOnly);
  try { return action(db); } finally { db.close(); }
}

const gateRows = (db: DatabaseSync) => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_coding_update_*' ORDER BY name").all();
function gateStatements(id: string): string[] {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid coding update identity.');
  const refusal = `SELECT RAISE(ABORT, '${pausedMessage} [${id}]');`;
  return [
    // Workspace saves are INSERT ... ON CONFLICT UPDATE, so existing-session
    // events, approvals and Stop must still be allowed to settle during drain.
    `CREATE TRIGGER ${gatePrefix}session BEFORE INSERT ON coding_session WHEN NOT EXISTS (SELECT 1 FROM coding_session WHERE id=NEW.id) BEGIN ${refusal} END`,
    `CREATE TRIGGER ${gatePrefix}submission BEFORE INSERT ON coding_submission BEGIN ${refusal} END`,
  ];
}

function changeGate(db: DatabaseSync, id: string, install: boolean): void {
  const wanted = gateStatements(id);
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = gateRows(db);
    if (rows.some(row => !wanted.includes(String(row['sql']))) || (rows.length > 0 && rows.length !== wanted.length)) throw Error('Another or unrecognized update owns coding admission. Its gate was preserved.');
    if (install && rows.length === 0) for (const statement of wanted) db.exec(statement);
    if (!install) for (const row of rows) db.exec(`DROP TRIGGER "${String(row['name'])}"`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function installCodingUpdateGate(orders: Database, id: string): void { withCatalog(orders, undefined, false, db => changeGate(db, id, true)); }
export function removeCodingUpdateGate(orders: Database, id: string): void { withCatalog(orders, undefined, false, db => changeGate(db, id, false)); }

export function activeCodingUpdateWork(orders: Database): { coding: number; codingDeliveries: number } {
  return withCatalog(orders, { coding: 0, codingDeliveries: 0 }, true, db => ({
    coding: Number(db.prepare("SELECT count(*) n FROM coding_session WHERE json_extract(document,'$.status') IN ('starting','working','needs-input','stopping','uncertain') OR json_extract(document,'$.turnId') IS NOT NULL").get()?.['n']),
    codingDeliveries: Number(db.prepare("SELECT count(*) n FROM coding_submission WHERE status IN ('preparing','pending','uncertain')").get()?.['n']),
  }));
}

/** An idle provider may remain loaded during drain. The normal server stop
 * must close it and establish native/tool exit before either app swap. */
export function assertCodingUpdateStopped(orders: Database): void {
  withCatalog(orders, undefined, true, db => {
    const owner = db.prepare('SELECT token,pid,native_pid,clean FROM coding_owner WHERE singleton=1').get();
    if (!owner || owner['clean'] !== 1 || owner['token'] !== '' || owner['pid'] !== 0 || owner['native_pid'] !== null) throw Error('The coding server has not verified agent and tool shutdown. No app was replaced.');
  });
}

/** What a stale owner record named when an updater released it, for its ledger. */
export type ReleasedCodingOwner = { pid: number; nativePid: number | null };

/** A runtime killed before its close (deploys over 0.9.11, Oct 2) leaves the
 * owner record naming a dead process, and every later swap refuses. Only an
 * updater that has itself proved each process of the stopped service gone may
 * release it here, and only while nothing the catalog records still lives:
 * the agent, its tools, a session or an unconfirmed message. Returns what it
 * released, or null when the record was already released by an ordinary stop;
 * anything unproven keeps the ordinary refusal. */
export function releaseStaleCodingOwner(orders: Database, stoppedPids: readonly number[], alive: (pid: number, group: boolean) => boolean = processMayBeAlive): ReleasedCodingOwner | null {
  return withCatalog(orders, null, false, db => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const owner = db.prepare('SELECT token,pid,native_pid,clean FROM coding_owner WHERE singleton=1').get()!;
      const pid = Number(owner['pid']), nativePid = owner['native_pid'] === null ? null : Number(owner['native_pid']);
      if (owner['token'] === '' && pid === 0 && nativePid === null && owner['clean'] === 1) { db.exec('ROLLBACK'); return null; }
      const refuse = (why: string): never => { throw Error(`The coding server has not verified agent and tool shutdown (${why}). No app was replaced.`); };
      // A record its own server released while recovery was still required stays as it is: that needs a person's check.
      if (owner['token'] === '' || !Number.isSafeInteger(pid) || pid <= 0) refuse('its saved record needs a recovery check');
      if (!stoppedPids.includes(pid)) refuse(`process ${pid} is not one this update stopped`);
      if (alive(pid, false)) refuse(`process ${pid} is still running`);
      // The agent runs in its own process group: a service killed by launchd can leave it behind.
      if (nativePid !== null && alive(nativePid, true)) refuse(`the agent process ${nativePid} is still running`);
      const custody = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='coding_custody'").get()
        ? db.prepare('SELECT payload FROM coding_custody WHERE singleton=1').get() : undefined;
      if (custody) {
        let c: { pid?: unknown; group?: unknown; descendants?: unknown; observationUnknown?: unknown; container?: unknown; host?: unknown; machineId?: unknown };
        try { c = JSON.parse(String(custody['payload'])); } catch { c = {}; }
        const processes = Array.isArray(c.descendants) ? c.descendants as { pid: unknown; group: unknown }[] : null;
        if (typeof c.host !== 'string' || (c.machineId !== undefined && c.machineId !== null && typeof c.machineId !== 'string')
          || !isThisMachine({ host: c.host, machineId: (c.machineId ?? null) as string | null }) || c.container || c.observationUnknown !== false || processes === null) refuse("the agent's tool processes could not be accounted for");
        const recorded = [...(c.pid === null ? [] : [{ pid: c.pid, group: c.group }]), ...processes!];
        for (const one of recorded) {
          if (!Number.isSafeInteger(one.pid) || Number(one.pid) <= 0) refuse("the agent's tool processes could not be accounted for");
          if (alive(Number(one.pid), one.group === true)) refuse(`the agent's process ${String(one.pid)} is still running`);
        }
      }
      const sessions = Number(db.prepare("SELECT count(*) n FROM coding_session WHERE json_extract(document,'$.status') IN ('starting','working','needs-input','stopping','uncertain') OR json_extract(document,'$.turnId') IS NOT NULL").get()?.['n']);
      const deliveries = Number(db.prepare("SELECT count(*) n FROM coding_submission WHERE status IN ('preparing','pending','uncertain')").get()?.['n']);
      if (sessions > 0 || deliveries > 0) refuse(`${sessions} coding session(s) and ${deliveries} unconfirmed message(s) were still active`);
      db.prepare("UPDATE coding_owner SET token='',pid=0,native_pid=NULL,clean=1 WHERE singleton=1 AND token=?").run(owner['token'] as string);
      db.exec('COMMIT');
      return { pid, nativePid };
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* already ended */ } throw error; }
  });
}

function snapshot(db: DatabaseSync): string {
  const data: Record<string, unknown> = {};
  // Include every catalog table, including current/future custody records.
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const name = String(row['name']);
    data[name] = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all();
  }
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/** Back up through SQLite so committed WAL records are included. This is a
 * retained recovery artifact; updates never restore the live catalog. */
export async function backupCodingCatalog(sourceFile: string, target: string, updateId: string): Promise<void> {
  const reservation = connect(sourceFile, false);
  try {
    reservation.exec('BEGIN IMMEDIATE');
    const source = connect(sourceFile, true);
    let before: string;
    try { before = snapshot(source); await sqliteRuntime().backup(source, target); } finally { source.close(); }
    chmodSync(target, 0o600);
    const copied = connect(target, false);
    try {
      if (copied.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok' || copied.prepare('PRAGMA foreign_key_check').all().length !== 0 || snapshot(copied) !== before) throw Error('Coding catalog backup verification failed. The installed app is unchanged.');
      changeGate(copied, updateId, false);
    } finally { copied.close(); }
    reservation.exec('COMMIT');
    const fd = openSync(target, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  } finally { reservation.close(); }
}
