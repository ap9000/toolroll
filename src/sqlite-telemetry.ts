import type { Database, Statement } from './store.js';
import type { ServerTelemetry } from './server-telemetry.js';

type State = { telemetry: ServerTelemetry; measuringWait: boolean };

/** Statements that may have written, on every Store connection of this process, counted as they run (fast reads:
 * work-reads.ts proves nothing changed before it reuses a read, without a statement of its own). A write, a run(),
 * any exec: counted. Only work-reads.ts's own temp tables (its kept copies of the projection) are not. */
let writes = 0;
export const writesSoFar = (): number => writes;
const ownTemp = (op: string) => /^(?:CREATE\s+TEMP\s+TABLE\s+"so_work_ranked_\d+"|DROP\s+TABLE\s+IF\s+EXISTS\s+temp\."so_work_ranked_\d+"$)/i.test(op);
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
  const methods: Database = {
    exec(sql) {
      const op = operation(sql);
      if (!ownTemp(op)) writes++;
      if (/^BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/i.test(op)) {
        const at = telemetry.clock();
        try { db.exec(sql); heldAt = telemetry.clock(); }
        finally { if (!state.measuringWait) telemetry.writeWait.observe(elapsed(at)); }
      } else if (/^(?:COMMIT|END|ROLLBACK(?!\s+TO))\b/i.test(op)) {
        db.exec(sql); finish();
      } else standalone(writing(op), () => db.exec(sql));
    },
    prepare(sql): Statement {
      const op = operation(sql), statement = db.prepare(sql), write = writing(op), counts = !ownTemp(op);
      const methods: Statement = {
        run: (...params) => { if (counts) writes++; return standalone(write, () => statement.run(...params)); },
        get: (...params) => { if (write && counts) writes++; return standalone(write, () => statement.get(...params)); },
        all: (...params) => { if (write && counts) writes++; return standalone(write, () => statement.all(...params)); },
      };
      // A write read row by row (INSERT … RETURNING through iterate) counts too.
      const native = statement as Statement & { iterate?: (...params: unknown[]) => unknown };
      if (write && counts && typeof native.iterate === 'function') Object.assign(methods, { iterate: (...params: unknown[]) => { writes++; return native.iterate!(...params); } });
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
