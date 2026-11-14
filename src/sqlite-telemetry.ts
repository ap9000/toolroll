import type { Database, Statement } from './store.js';
import type { ServerTelemetry } from './server-telemetry.js';

type State = { telemetry: ServerTelemetry; measuringWait: boolean };

/** Statements that may have changed what a read returns, on every Store connection of this process, counted as they
 * run (fast reads: work-reads.ts proves nothing changed before it reuses a read, without a statement of its own).
 * Counted: every write, every run(), every exec, every statement that fails (an error may roll a transaction back on
 * its own), and every end of a transaction or savepoint — COMMIT, END, ROLLBACK, ROLLBACK TO, RELEASE — because a
 * rollback takes back writes already counted, so an answer read between them must not stand. Not counted: work-reads.ts's
 * own temp tables (its kept copies of the projection), BEGIN, SAVEPOINT and the busy timeout (they change no row), and an
 * end of a transaction in which nothing at all was counted since it opened (it has nothing to take back). */
let writes = 0;
export const writesSoFar = (): number => writes;
const ownTemp = (op: string) => /^(?:CREATE\s+TEMP\s+TABLE\s+"so_work_ranked_\d+"|DROP\s+TABLE\s+IF\s+EXISTS\s+temp\."so_work_ranked_\d+"$)/i.test(op);
const opening = (op: string) => /^(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?|SAVEPOINT\s+\w+)\s*;?$/i.test(op);
const settingOnly = (op: string) => /^PRAGMA\s+busy_timeout\s*=\s*\d+\s*;?$/i.test(op);
const ending = (op: string) => /^(?:COMMIT|END|ROLLBACK|RELEASE)\b[^;]*;?\s*$/i.test(op);
const states = new WeakMap<Database, State>();

/** One observation for the entire bounded BEGIN retry, including a failed acquisition. */
export function measureWriteWait<T>(db: Database, body: () => T): T {
  const state = states.get(db);
  if (!state || state.measuringWait) return body();
  const started = state.telemetry.clock(); state.measuringWait = true;
  try { return body(); }
  finally { state.measuringWait = false; state.telemetry.writeWait.observe((state.telemetry.clock() - started) / 1000); }
}

/** Preserve SQLite calls, timeouts and transaction semantics. No SQL or parameters leave this wrapper.
 * Native SQLite does not expose busy-handler time for autocommit writes: report their whole duration separately.
 * Runtime explicit IMMEDIATE/EXCLUSIVE transactions report acquisition and hold; startup migrations are excluded.
 */
export function instrumentDatabase(db: Database, telemetry: ServerTelemetry): Database {
  const state: State = { telemetry, measuringWait: false };
  let heldAt: number | null = null;
  const elapsed = (at: number) => (telemetry.clock() - at) / 1000;
  const operation = (sql: string) => sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '').trim();
  const writing = (sql: string) => /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql) || /^WITH\b[\s\S]*\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
  const standalone = <T>(write: boolean, body: () => T): T => {
    if (!write || heldAt !== null) return body();
    const at = telemetry.clock();
    try { return body(); } finally { telemetry.writeStatement.observe(elapsed(at)); }
  };
  const finish = () => { if (heldAt !== null) { telemetry.writeHold.observe(elapsed(heldAt)); heldAt = null; } };
  /** The write count when this connection's open transaction began (null with none open). */
  let openedAt: number | null = null;
  const native = db as Database & { isTransaction?: unknown };
  /** Count a statement before it runs as `counts` says, and any statement that fails. */
  const counted = <T>(counts: boolean, body: () => T): T => {
    if (counts) writes++;
    try { return body(); } catch (error) { writes++; throw error; }
  };
  const execNow = (sql: string, op: string): void => {
    if (/^BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/i.test(op)) {
      const at = telemetry.clock();
      try { db.exec(sql); heldAt = telemetry.clock(); }
      finally { if (!state.measuringWait) telemetry.writeWait.observe(elapsed(at)); }
    } else if (/^(?:COMMIT|END|ROLLBACK(?!\s+TO))\b/i.test(op)) {
      db.exec(sql); finish();
    } else standalone(writing(op), () => db.exec(sql));
  };
  /** Whether running `op` this way counts, by the statement's own text, on every path (exec, run, get, all, iterate):
   * a transaction's opening marks where it began; its end counts unless nothing was counted since; anything else that
   * may write counts (exec and run always). */
  const counts = (op: string, path: 'exec' | 'run' | 'read', write: boolean): boolean => {
    if (ownTemp(op) || settingOnly(op)) return false;
    if (opening(op)) { if (openedAt === null && native.isTransaction !== true) openedAt = writes; return false; }
    if (ending(op)) return openedAt === null || writes !== openedAt;
    return path !== 'read' || write;
  };
  /** After a statement: a transaction no longer open forgets where it began. */
  const settled = (op: string): void => {
    if (native.isTransaction === false || (native.isTransaction === undefined && /^(?:COMMIT|END|ROLLBACK(?!\s+TO))\b/i.test(op))) openedAt = null;
  };
  const tracked = <T>(op: string, path: 'exec' | 'run' | 'read', write: boolean, body: () => T): T => {
    try { return counted(counts(op, path, write), body); } finally { settled(op); }
  };
  const methods: Database = {
    exec(sql) {
      const op = operation(sql);
      tracked(op, 'exec', true, () => execNow(sql, op));
    },
    prepare(sql): Statement {
      const op = operation(sql), statement = db.prepare(sql), write = writing(op);
      const methods: Statement = {
        run: (...params) => tracked(op, 'run', write, () => standalone(write, () => statement.run(...params))),
        get: (...params) => tracked(op, 'read', write, () => standalone(write, () => statement.get(...params))),
        all: (...params) => tracked(op, 'read', write, () => standalone(write, () => statement.all(...params))),
      };
      // Row by row too (a write's RETURNING, a transaction control read through iterate): the same rule.
      const rows = statement as Statement & { iterate?: (...params: unknown[]) => unknown };
      if (typeof rows.iterate === 'function') Object.assign(methods, { iterate: (...params: unknown[]) => tracked(op, 'read', write, () => rows.iterate!(...params)) });
      return preservingNative(statement, methods);
    },
    close() { try { db.close(); } finally { finish(); } },
  };
  // Store.handle also exposes native extensions (for example scalar functions used by work summaries).
  // Preserve their receivers and getters instead of narrowing the live connection to the minimal test interface.
  const wrapped = preservingNative(db, methods);
  states.set(wrapped, state);
  return wrapped;
}

function preservingNative<T extends object>(native: T, methods: T): T {
  // Overrides belong to the facade, so a test spy or caller replacing prepare/run never mutates the
  // native method that the timed implementation calls (and cannot recurse back into itself).
  return new Proxy(methods, {
    get(target, property) {
      if (Object.hasOwn(target, property)) return Reflect.get(target, property);
      const value: unknown = Reflect.get(native, property, native);
      return typeof value === 'function' ? value.bind(native) : value;
    },
    has: (target, property) => Reflect.has(target, property) || Reflect.has(native, property),
    getPrototypeOf: () => Object.getPrototypeOf(native),
  });
}
