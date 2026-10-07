/** Durable invalidation for authenticated workspace reads. This is cache
 * metadata only: it never grants access or certifies task/process state. */
import { createHash } from 'node:crypto';
import { DEFAULT_LIVENESS_MS } from './runner.js';
import type { Store } from './store.js';

/** The service_cursor row the revision triggers move (live-bus.ts listens for it). */
export const WORKSPACE_REVISION_KEY = 'workspace-content:v1';
const KEY = WORKSPACE_REVISION_KEY;
const PREFIX = 'workspace_revision_v1_';
const MAX_AGE_MS = 60_000;
const OMIT = new Set(['schema_version', 'service_cursor', 'wake', 'notification_delivery',
  'team_read', 'team_request', 'push_delivery', 'telegram_update', 'telegram_outbound_message', 'telegram_retry', 'bridge_lease']);
const QUIET: Record<string, readonly string[]> = {
  runner: ['heartbeat_at'], claim: ['heartbeat_at', 'expires_at'], watch_lease: ['heartbeat_at', 'expires_at'],
  watch_episode: ['ticks'], provider_readiness: ['observed_at'],
};
const identifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

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
  const bump = `INSERT INTO service_cursor(key,value,updated_at) VALUES ('${KEY}',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value=service_cursor.value+1,updated_at=excluded.updated_at;`;
  const wanted = new Map<string, string>();
  // Virtual tables (the FTS5 memory index) cannot carry triggers, and their
  // shadow tables are derived views rebuilt from the stores of record.
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE 'memory_search%'").all();
  for (const row of tables) {
    const table = String(row['name']);
    if (OMIT.has(table)) continue;
    const columns = db.prepare(`PRAGMA table_info(${identifier(table)})`).all().map(column => String(column['name']));
    const meaningful = columns.filter(column => !QUIET[table]?.includes(column));
    const changes = meaningful.map(column => `OLD.${identifier(column)} IS NOT NEW.${identifier(column)}`);
    // A routine beat is quiet, but a revival after a liveness/lease gap must
    // invalidate an already-rendered "offline" view immediately.
    if (table === 'runner') changes.push(`NEW.heartbeat_at < OLD.heartbeat_at OR NEW.heartbeat_at >= strftime('%Y-%m-%dT%H:%M:%fZ',OLD.heartbeat_at,'+${DEFAULT_LIVENESS_MS / 1000} seconds')`);
    if (table === 'claim' || table === 'watch_lease') changes.push('NEW.heartbeat_at >= OLD.expires_at');
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const guard = event === 'UPDATE' ? ` WHEN ${changes.join(' OR ')}` : '';
      const body = `AFTER ${event} ON ${identifier(table)}${guard} BEGIN ${bump} END`;
      const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
      wanted.set(`${PREFIX}${table}_${event.toLowerCase()}_${digest}`, body);
    }
  }
  // Only DDL and one metadata row are written here; no task/history scan or
  // backfill holds the writer. Existing installations perform no DDL writes.
  store.transact(() => {
    const existing = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE ?").all(`${PREFIX}%`);
    const installed = new Set(existing.map(row => String(row['name'])).filter(name => name.startsWith(PREFIX)));
    for (const name of installed) if (!wanted.has(name)) db.exec(`DROP TRIGGER ${identifier(name)}`);
    for (const [name, body] of wanted) if (!installed.has(name)) db.exec(`CREATE TRIGGER ${identifier(name)} ${body}`);
    db.prepare('INSERT OR IGNORE INTO service_cursor(key,value,updated_at) VALUES (?,0,?)').run(KEY, new Date().toISOString());
  });
  const current = db.prepare('SELECT CAST(value AS TEXT) AS value FROM service_cursor WHERE key = ?');
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
      const value = current.get(KEY)?.['value'];
      if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Workspace revision is unavailable');
      return `v1:${value}`;
    },
    expiresAt(now) {
      const iso = now.toISOString();
      const value = boundary.get(iso, iso, iso, iso, iso, iso, iso)?.['at'];
      const at = typeof value === 'string' ? Date.parse(value) : NaN;
      return Math.min(now.getTime() + MAX_AGE_MS, Number.isFinite(at) ? at : Infinity);
    },
  };
}
