/** Durable invalidation for authenticated workspace reads. This is cache
 * metadata only: it never grants access or certifies task/process state.
 *
 * The revision is one service_cursor row. Every Toolroll connection is wrapped
 * (trackWorkspaceWrites, from the Store) and moves it once per committed
 * meaningful write: inside a transaction at its outer COMMIT (a rollback, or a
 * savepoint rolled back to, moves nothing), and right after an autocommit
 * statement. Quiet writes (heartbeats, cursors, receipts) move nothing; a beat
 * after a liveness or lease gap is a revival and does. Readers in another
 * process see the commit through PRAGMA data_version. No trigger is installed:
 * the schema stays the schema (v114 dropped the 801 per-table triggers). */
import type { Database, Statement } from './store.js';
import { DEFAULT_LIVENESS_MS } from './runner.js';
import type { Store } from './store.js';

/** The service_cursor row every meaningful commit moves (live-bus.ts listens for it). */
export const WORKSPACE_REVISION_KEY = 'workspace-content:v1';
const KEY = WORKSPACE_REVISION_KEY;
const MAX_AGE_MS = 60_000;
const OMIT = new Set(['schema_version', 'service_cursor', 'wake', 'notification_delivery', 'sqlite_sequence',
  'team_read', 'team_request', 'push_delivery', 'chat_message_ref']);
const QUIET: Record<string, readonly string[]> = {
  runner: ['heartbeat_at'], claim: ['heartbeat_at', 'expires_at'], watch_lease: ['heartbeat_at', 'expires_at'],
  watch_episode: ['ticks'], provider_readiness: ['observed_at'],
  // A chat worker's lease, poll cursor and rate-limit wait are its own bookkeeping; its connection and problem are news.
  chat_runtime: ['owner', 'lease_until', 'generation', 'cursor', 'heartbeat', 'retry_at'],
};
/** A quiet beat that revives what a view already rendered as gone: the rows a beat may move, read before and after.
 * A runner beat after its liveness window (or backwards) is a revival; a lease renewed at or past its expiry is one. */
const REVIVAL: Record<string, { rows: string; revived: (before: Beat, after: Beat) => boolean }> = {
  runner: { rows: 'SELECT rowid AS id, heartbeat_at AS h, NULL AS e FROM runner',
    revived: (before, after) => after.h < before.h || Date.parse(after.h) >= Date.parse(before.h) + DEFAULT_LIVENESS_MS },
  claim: { rows: 'SELECT rowid AS id, heartbeat_at AS h, expires_at AS e FROM claim WHERE released_at IS NULL', revived: (before, after) => before.e !== null && after.h >= before.e },
  watch_lease: { rows: 'SELECT rowid AS id, heartbeat_at AS h, expires_at AS e FROM watch_lease', revived: (before, after) => before.e !== null && after.h >= before.e },
};
type Beat = { h: string; e: string | null };
const BUMP = `INSERT INTO service_cursor(key,value,updated_at) VALUES ('${KEY}',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(key) DO UPDATE SET value=service_cursor.value+1,updated_at=excluded.updated_at`;

/** What one statement does to the workspace: a transaction boundary, a write to a table (quiet or not), or nothing. */
type Effect =
  | { kind: 'begin' | 'commit' | 'rollback' | 'none' }
  | { kind: 'savepoint' | 'rollback-to' | 'release'; name: string }
  | { kind: 'write'; table: string; quiet: boolean };

const NAME = String.raw`(?:"((?:[^"]|"")+)"|\[([^\]]+)\]|([A-Za-z_][\w$]*))`;
const TABLE = new RegExp(String.raw`^(?:${NAME}\s*\.\s*)?${NAME}`);
function tableAt(text: string): { schema: string | null; table: string; rest: string } | null {
  const match = TABLE.exec(text);
  if (match === null) return null;
  const schema = match[1] ?? match[2] ?? match[3] ?? null;
  const table = match[4] ?? match[5] ?? match[6]!;
  return { schema: schema?.toLowerCase() ?? null, table: table.replaceAll('""', '"').toLowerCase(), rest: text.slice(match[0].length) };
}

/** The columns an UPDATE's SET clause assigns, or null when it can't be read (then the write counts). */
function assigned(rest: string): string[] | null {
  const set = /^\s+SET\s+/i.exec(rest);
  if (set === null) return null;
  const columns: string[] = [];
  let depth = 0, quote: string | null = null, start = set[0].length;
  const take = (end: number): boolean => {
    const lhs = rest.slice(start, end).split('=')[0]!.trim();
    const names = lhs.startsWith('(') ? lhs.slice(1, -1).split(',') : [lhs];
    for (const one of names) { const name = tableAt(one.trim()); if (name === null) return false; columns.push(name.table); }
    return true;
  };
  for (let i = start; i < rest.length; i++) {
    const c = rest[i]!;
    if (quote !== null) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && c === ',') { if (!take(i)) return null; start = i + 1; }
    else if (depth === 0 && /^\s(?:WHERE|FROM|RETURNING|ORDER|LIMIT)\b/i.test(rest.slice(i, i + 11))) { return take(i) ? columns : null; }
  }
  return take(rest.length) ? columns : null;
}

export function statementEffect(sql: string): Effect {
  const text = sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  if (/^BEGIN\b/i.test(text)) return { kind: 'begin' };
  if (/^(?:COMMIT|END)\b/i.test(text)) return { kind: 'commit' };
  let match = /^ROLLBACK(?:\s+TRANSACTION)?\s+TO\s+(?:SAVEPOINT\s+)?(\S+?)\s*;?\s*$/i.exec(text);
  if (match !== null) return { kind: 'rollback-to', name: match[1]!.toLowerCase() };
  if (/^ROLLBACK\b/i.test(text)) return { kind: 'rollback' };
  match = /^SAVEPOINT\s+(\S+?)\s*;?\s*$/i.exec(text);
  if (match !== null) return { kind: 'savepoint', name: match[1]!.toLowerCase() };
  match = /^RELEASE\s+(?:SAVEPOINT\s+)?(\S+?)\s*;?\s*$/i.exec(text);
  if (match !== null) return { kind: 'release', name: match[1]!.toLowerCase() };
  // WITH … is only ever a prefix to one data statement here; its CTEs cannot write.
  const body = /^WITH\b/i.test(text) ? text.replace(/^WITH\b[\s\S]*?(?=\b(?:INSERT|REPLACE|UPDATE|DELETE)\b)/i, '') : text;
  match = /^(?:(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO|DELETE\s+FROM)\s+/i.exec(body);
  const update = match === null ? /^UPDATE(?:\s+OR\s+\w+)?\s+/i.exec(body) : null;
  const at = match ?? update;
  if (at === null) return { kind: 'none' };
  const target = tableAt(body.slice(at[0].length));
  if (target === null) return { kind: 'write', table: '', quiet: false };
  if (target.schema === 'temp' || OMIT.has(target.table) || target.table.startsWith('memory_search')) return { kind: 'none' };
  const quietColumns = QUIET[target.table];
  if (update === null || quietColumns === undefined) return { kind: 'write', table: target.table, quiet: false };
  const columns = assigned(target.rest);
  return { kind: 'write', table: target.table, quiet: columns !== null && columns.every(column => quietColumns.includes(column)) };
}

/** How many times this connection has moved the revision; read through any wrapper around it. */
const BUMPS = Symbol('workspace revision bumps');

/** Wrap one connection so each committed meaningful write moves the workspace revision exactly once. Native
 * extensions (scalar functions, isTransaction) pass through; a test spy on prepare/exec replaces only the facade's. */
export function trackWorkspaceWrites(db: Database): Database {
  const state = { bumps: 0 };
  const effects = new Map<string, Effect>();
  const effectOf = (sql: string): Effect => {
    let effect = effects.get(sql);
    if (effect === undefined) {
      effect = statementEffect(sql);
      if (effects.size >= 2048) effects.clear();
      effects.set(sql, effect);
    }
    return effect;
  };
  let open = false, dirty = false, bySavepoint = false;
  let savepoints: { name: string; dirty: boolean }[] = [];
  const native = db as Database & { isTransaction?: unknown };
  const inTransaction = (): boolean => typeof native.isTransaction === 'boolean' ? native.isTransaction : open;
  let totals: Statement | null = null;
  const total = (): number => Number((totals ??= db.prepare('SELECT total_changes() AS n')).get()?.['n'] ?? 0);
  const bump = (): void => {
    try { db.exec(BUMP); state.bumps++; } catch { /* a file without the cursor (an old shape opened bare) has no revision to move */ }
  };
  const reset = (): void => { open = false; dirty = false; bySavepoint = false; savepoints = []; };
  /** A meaningful write changed a row: its transaction's commit moves the revision, or this autocommit does now. */
  const wrote = (): void => { if (inTransaction()) dirty = true; else bump(); };
  const control = (effect: Effect, run: () => void): void => {
    switch (effect.kind) {
      case 'begin': run(); reset(); open = true; return;
      case 'commit': if (dirty) { bump(); dirty = false; } run(); reset(); return;
      case 'rollback': try { run(); } finally { reset(); } return;
      case 'savepoint':
        if (!inTransaction()) { reset(); bySavepoint = true; }
        run(); open = true; savepoints.push({ name: effect.name, dirty }); return;
      case 'rollback-to': {
        run();
        const at = savepoints.map(one => one.name).lastIndexOf(effect.name);
        if (at >= 0) { dirty = savepoints[at]!.dirty; savepoints.length = at + 1; }
        return;
      }
      case 'release': {
        const at = savepoints.map(one => one.name).lastIndexOf(effect.name);
        // Releasing the savepoint that began the transaction commits it.
        if (at === 0 && bySavepoint && dirty) { bump(); dirty = false; }
        run();
        if (at >= 0) savepoints.length = at;
        if (!inTransaction()) reset();
        return;
      }
      default: run();
    }
  };
  /** Run one data statement and report whether it changed the workspace. */
  const measured = <T>(effect: Effect, body: () => T): T => {
    if (effect.kind !== 'write') return body();
    const revival = effect.quiet ? REVIVAL[effect.table] : undefined;
    const beats = (): Map<number, Beat> => new Map(db.prepare(revival!.rows).all()
      .map(row => [Number(row['id']), { h: String(row['h']), e: row['e'] == null ? null : String(row['e']) }]));
    const before = revival === undefined ? null : beats();
    const changes = total();
    const result = body();
    if (total() === changes) return result;
    if (!effect.quiet) wrote();
    else if (before !== null) {
      for (const [id, after] of beats()) {
        const was = before.get(id);
        if (was !== undefined && was.h !== after.h && revival!.revived(was, after)) { wrote(); break; }
      }
    }
    return result;
  };
  const methods: Database = {
    exec(sql) {
      let effect = effectOf(sql);
      // A script of several statements is read by its first; past a quiet first one, any row it changes counts.
      if (effect.kind === 'none' && /;\s*\S/.test(sql)) effect = { kind: 'write', table: '', quiet: false };
      if (effect.kind === 'write' || effect.kind === 'none') measured(effect, () => db.exec(sql));
      else control(effect, () => db.exec(sql));
    },
    prepare(sql) {
      const statement = db.prepare(sql), effect = effectOf(sql);
      if (effect.kind === 'none') return statement;
      const run = <T>(body: () => T): T => effect.kind === 'write' ? measured(effect, body) : (control(effect, () => { body(); }), undefined as T);
      return passThrough(statement, {
        run: (...params) => effect.kind === 'write' ? measured(effect, () => statement.run(...params)) : runControl(effect, control, () => statement.run(...params)),
        get: (...params) => run(() => statement.get(...params)),
        all: (...params) => run(() => statement.all(...params)),
      });
    },
    close() { db.close(); },
  };
  return passThrough(db, Object.assign(methods, { [BUMPS]: () => state.bumps }));
}

function runControl(effect: Effect, control: (effect: Effect, run: () => void) => void, body: () => ReturnType<Statement['run']>): ReturnType<Statement['run']> {
  let result: ReturnType<Statement['run']> = { changes: 0 };
  control(effect, () => { result = body(); });
  return result;
}

function passThrough<T extends object>(inner: T, methods: T): T {
  return new Proxy(methods, {
    get(target, property) {
      if (Object.hasOwn(target, property)) return Reflect.get(target, property);
      const value: unknown = Reflect.get(inner, property, inner);
      return typeof value === 'function' ? value.bind(inner) : value;
    },
    has: (target, property) => Reflect.has(target, property) || Reflect.has(inner, property),
    getPrototypeOf: () => Object.getPrototypeOf(inner),
  });
}

export type WorkspaceRevision = { current(): string; expiresAt(now: Date): number };

type WorkspaceValidator = { etag: string; revision: string; expiresAt: number };

/** Per-server response metadata. Reads preserve insertion order; writes at
 * capacity discard the oldest key before storing the supplied validator. */
export class WorkspaceValidatorCache {
  private readonly entries = new Map<string, WorkspaceValidator>();

  get(key: string): WorkspaceValidator | undefined { return this.entries.get(key); }

  set(key: string, validator: WorkspaceValidator): void {
    if (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, validator);
  }
}

export function prepareWorkspaceRevision(store: Store): WorkspaceRevision {
  const db = store.raw();
  db.prepare('INSERT OR IGNORE INTO service_cursor(key,value,updated_at) VALUES (?,0,?)').run(KEY, new Date().toISOString());
  const cursor = db.prepare('SELECT CAST(value AS TEXT) AS value FROM service_cursor WHERE key = ?');
  // Another connection's commit moves data_version; this connection's own moves its bump count. Neither moved: the
  // revision read last is still the revision.
  const dataVersion = db.prepare('PRAGMA data_version');
  const counted = (db as { [BUMPS]?: () => number })[BUMPS];
  let seen: { data: unknown; bumps: number; revision: string } | null = null;
  const boundary = db.prepare(`SELECT MIN(at) AS at FROM (
    SELECT MIN(expires_at) AS at FROM claim WHERE released_at IS NULL AND expires_at > ?
    UNION ALL SELECT MIN(until) FROM hold WHERE until > ?
    UNION ALL SELECT MIN(absolute_expiry) FROM operating_mode WHERE revoked_at IS NULL AND absolute_expiry > ?
    UNION ALL SELECT MIN(strftime('%Y-%m-%dT%H:%M:%fZ',heartbeat_at,'+${DEFAULT_LIVENESS_MS / 1000} seconds')) FROM runner
      WHERE retired_at IS NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',heartbeat_at,'+${DEFAULT_LIVENESS_MS / 1000} seconds') >= ?
    UNION ALL SELECT MIN(expires_at) FROM watch_lease WHERE expires_at > ?
    UNION ALL SELECT MIN(expires_at) FROM capability WHERE expires_at > ?
    UNION ALL SELECT MIN(reset_at) FROM quota WHERE reset_at > ?
  )`);
  return {
    current() {
      const data = dataVersion.get()?.['data_version'], bumps = counted?.() ?? -1;
      if (seen !== null && counted !== undefined && seen.data === data && seen.bumps === bumps) return seen.revision;
      const value = cursor.get(KEY)?.['value'];
      if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Workspace revision is unavailable');
      seen = { data, bumps, revision: `v1:${value}` };
      return seen.revision;
    },
    expiresAt(now) {
      const iso = now.toISOString();
      const value = boundary.get(iso, iso, iso, iso, iso, iso, iso)?.['at'];
      const at = typeof value === 'string' ? Date.parse(value) : NaN;
      return Math.min(now.getTime() + MAX_AGE_MS, Number.isFinite(at) ? at : Infinity);
    },
  };
}
