/**
 * One request's work reads (fast reads): the work projection and the saved facts behind its rows, read once for the
 * request instead of once per panel. A page shows the same families in several places (the list, the sidebar's rail,
 * the crew, the chat landing's three views, the Tasks count), and each used to read the whole 10,000-family projection
 * and every row's saved check again.
 *
 * Scope and safety: everything here lives for ONE request (withWorkReads) and one connection, and is gone when the
 * request ends — nothing is shared across requests, sessions or accounts. Nothing here decides who may see what: the
 * work index's own SQL still admits every family by the reader's projects, and the cached projection is keyed by every
 * input it reads (the reader's projects, unplaced work, the project, state and lead filters, the custody and release
 * sets). It is cache metadata only.
 *
 * What a read returns is what it returned before, as long as nothing changed: every reuse first proves the database is
 * where it was (this connection's total changes and the file's data version, one statement), and anything written
 * meanwhile — by this request, another request or another process — drops every saved value. Time is the one input a
 * reuse can't prove unchanged, so the projection is reused only for WORK_READ_REUSE_MS after it was read: one request
 * sees one instant, the way the page's own panels should agree.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Database, Statement, Store } from "./store.js";
import { statementEffect } from "./workspace-revision.js";

/** How long one request keeps reading the projection it read first (wall clock, between its own reads). */
export const WORK_READ_REUSE_MS = 5_000;
/** Saved query answers per request and connection; past it, reads simply go to the database again. */
const MAX_SAVED = 50_000;

type Connection = {
  /** The database as last proved: this connection's total changes and the file's data version. */
  stamp: string | null;
  /** Answers to pure read statements, by statement, method and parameters. */
  answers: Map<string, unknown>;
  /** Values derived from reads (custody readings, release tasks), by name. */
  values: Map<string, unknown>;
  /** The projection, materialized: by every input it reads, with the instant it was read for. */
  ranked: Map<string, { table: string; slot: number; at: number }>;
  /** Temp table slots this request holds on the connection. */
  slots: Set<number>;
  /** The store, its reads answered from `answers` (writes go through and forget everything). */
  store: Store;
};
type Scope = { connections: Map<Database, Connection> };
const scopes = new AsyncLocalStorage<Scope>();
/** Temp table slots in use on each connection, across every open request. */
const busy = new WeakMap<Database, Set<number>>();
const tableOf = (slot: number) => `so_work_ranked_${slot}`;

/** Run one request's reads with their own work reads; whatever they saved is dropped when `run` (or its promise) ends. */
export function withWorkReads<T>(run: () => T): T {
  if (scopes.getStore() !== undefined) return run();
  const scope: Scope = { connections: new Map() };
  let result: T;
  try {
    result = scopes.run(scope, run);
  } catch (error) {
    close(scope);
    throw error;
  }
  if (result instanceof Promise) return result.finally(() => close(scope)) as T;
  close(scope);
  return result;
}

/** Run `run` with no request's work reads: every read goes to the database, as reads outside a request do. */
export function outsideWorkReads<T>(run: () => T): T {
  return scopes.exit(run);
}

function close(scope: Scope): void {
  for (const [db, connection] of scope.connections) {
    for (const slot of connection.slots) release(db, slot);
    connection.answers.clear(); connection.values.clear(); connection.ranked.clear(); connection.slots.clear();
  }
  scope.connections.clear();
}

function release(db: Database, slot: number): void {
  try {
    db.exec(`DROP TABLE IF EXISTS temp."${tableOf(slot)}"`);
    busy.get(db)?.delete(slot);
  } catch { /* the slot stays taken: the next request uses another */ }
}

export type WorkReads = {
  /** The store whose pure reads are answered once per request (rows, refs, verdicts, ledger lookups by id). */
  readonly store: Store;
  /** A value derived from reads, computed once per request while nothing changes. */
  value<T>(name: string, compute: () => T): T;
  /** The temp table holding the projection read for `key` at an instant within reach of `now`, or the one `fill`
   * materializes now (fill(table) creates it). Null when it can't be kept (the caller reads the projection itself). */
  ranked(key: string, now: Date, fill: (table: string) => void): string | null;
  /** Forget the projection kept for `key` (it could not be read). */
  forget(key: string): void;
};

/** This request's work reads on `store`'s connection, proved current; null outside a request's reads. */
export function workReadsOf(store: Store): WorkReads | null {
  const scope = scopes.getStore();
  if (scope === undefined) return null;
  const db = store.handle;
  let connection = scope.connections.get(db);
  if (connection === undefined) {
    const created: Connection = { stamp: null, answers: new Map(), values: new Map(), ranked: new Map(), slots: new Set(), store: store };
    created.store = Object.create(store, { db: { value: savingHandle(db, created) } }) as Store;
    scope.connections.set(db, created);
    connection = created;
  }
  const current = connection;
  prove(db, current);
  return {
    store: current.store,
    value<T>(name: string, compute: () => T): T {
      if (current.values.has(name)) return current.values.get(name) as T;
      const value = compute();
      current.values.set(name, value);
      return value;
    },
    ranked(key, now, fill) {
      const held = current.ranked.get(key);
      if (held !== undefined && Math.abs(now.getTime() - held.at) < WORK_READ_REUSE_MS) return held.table;
      if (held !== undefined) forgetRanked(db, current, key);
      const taken = busy.get(db) ?? new Set<number>();
      busy.set(db, taken);
      let slot = 0;
      while (taken.has(slot)) slot++;
      const table = tableOf(slot);
      try {
        db.exec(`DROP TABLE IF EXISTS temp."${table}"`);
        fill(table);
      } catch {
        try { db.exec(`DROP TABLE IF EXISTS temp."${table}"`); } catch { /* nothing was kept */ }
        return null;
      }
      taken.add(slot); current.slots.add(slot);
      current.ranked.set(key, { table, slot, at: now.getTime() });
      // The temp table is this request's own: what it wrote moves nothing anyone else reads.
      current.stamp = stampOf(db);
      return table;
    },
    forget(key) { forgetRanked(db, current, key); },
  };
}

function forgetRanked(db: Database, connection: Connection, key: string): void {
  const held = connection.ranked.get(key);
  if (held === undefined) return;
  connection.ranked.delete(key);
  connection.slots.delete(held.slot);
  release(db, held.slot);
}

const stampOf = (db: Database): string | null => {
  try {
    const row = db.prepare("SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version()) AS version").get();
    return `${String(row?.["changes"])}:${String(row?.["version"])}`;
  } catch { return null; }
};

/** Anything written since the last proof (or a proof that can't be made) drops every saved answer and value. */
function prove(db: Database, connection: Connection): void {
  const stamp = stampOf(db);
  if (stamp !== null && stamp === connection.stamp) return;
  connection.answers.clear(); connection.values.clear();
  for (const key of [...connection.ranked.keys()]) forgetRanked(db, connection, key);
  connection.stamp = stampOf(db);
}

/** A read whose answer depends on nothing but the database: a plain SELECT (or WITH … SELECT) with no clock, random or
 * change counter in it. */
function pureRead(sql: string): boolean {
  const text = sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
  return /^(?:SELECT|WITH)\b/i.test(text) && statementEffect(text).kind === "none"
    && !/'now'|\b(?:random|randomblob|changes|total_changes|last_insert_rowid|data_version)\b/i.test(text);
}

function keyOf(sql: string, method: string, params: unknown[]): string | null {
  try {
    return `${method}\u0000${sql}\u0000${JSON.stringify(params, (_, value: unknown) => {
      if (typeof value === "bigint") throw Error("unsaved");
      if (value instanceof Uint8Array) return `\u0000bytes:${Buffer.from(value).toString("base64")}`;
      return value;
    })}`;
  } catch { return null; }
}

/** A copy each caller may keep or change: the row's own prototype (node:sqlite's has none), its bytes copied. */
function copied(row: Record<string, unknown>): Record<string, unknown> {
  const out = Object.create(Object.getPrototypeOf(row) as object | null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(row)) out[name] = value instanceof Uint8Array ? value.slice() : value;
  return out;
}

/** The connection, with pure reads answered once: a statement that writes (or any exec) runs as before and forgets
 * every saved answer, before and after it runs. */
function savingHandle(db: Database, connection: Connection): Database {
  const forgetAll = () => { connection.answers.clear(); connection.values.clear(); };
  const handle: Database = {
    exec(sql: string) { forgetAll(); try { db.exec(sql); } finally { forgetAll(); } },
    prepare(sql: string): Statement {
      const statement = db.prepare(sql);
      let saving = pureRead(sql);
      const saved = (method: "get" | "all") => (...params: unknown[]): unknown => {
        const key = saving ? keyOf(sql, method, params) : null;
        if (key === null) {
          if (!pureRead(sql)) forgetAll();
          try { return statement[method](...params); } finally { if (!pureRead(sql)) forgetAll(); }
        }
        if (connection.answers.has(key)) {
          const answer = connection.answers.get(key) as Record<string, unknown> | Record<string, unknown>[] | undefined;
          return answer === undefined ? undefined : Array.isArray(answer) ? answer.map(copied) : copied(answer);
        }
        const answer = statement[method](...params) as Record<string, unknown> | Record<string, unknown>[] | undefined;
        if (connection.answers.size < MAX_SAVED) connection.answers.set(key, answer === undefined ? undefined : Array.isArray(answer) ? answer.map(copied) : copied(answer));
        return answer;
      };
      return new Proxy(statement, {
        get(target, property) {
          if (property === "get" || property === "all") return saved(property);
          if (property === "run" || property === "iterate") {
            const method = Reflect.get(target, property, target) as (...params: unknown[]) => unknown;
            return (...params: unknown[]) => {
              if (property === "run" || !pureRead(sql)) forgetAll();
              try { return method.apply(target, params); } finally { if (property === "run" || !pureRead(sql)) forgetAll(); }
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          // A setter changes how rows read (bigints, arrays, parameter rules): that statement is never answered from memory.
          if (typeof property === "string" && property.startsWith("set")) saving = false;
          return (value as (...args: unknown[]) => unknown).bind(target);
        },
      });
    },
    close() { db.close(); },
  };
  return new Proxy(handle, {
    get(target, property) {
      if (Object.hasOwn(target, property)) return Reflect.get(target, property);
      const value: unknown = Reflect.get(db, property, db);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(db) : value;
    },
    has: (target, property) => Reflect.has(target, property) || Reflect.has(db, property),
    getPrototypeOf: () => Object.getPrototypeOf(db) as object | null,
  });
}
