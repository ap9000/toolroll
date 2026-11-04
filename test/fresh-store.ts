import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Database, openStore as OpenStore } from "../src/store.js";

/** A fresh database holds the same schema and rows on every open: the
 * current tables and their singleton defaults, with no ids, times or secrets.
 * Building one runs every migration (100-200 ms, mostly ALTER TABLE schema
 * reparses); recreating its finished shape takes 10-25 ms. So each test file
 * builds a fresh database once, with the real `openStore`, and later fresh
 * opens start from that result:
 *
 *  - a new path gets a byte copy of the first fresh file;
 *  - `:memory:` gets a new in-memory connection replaying the first fresh
 *    memory store's exact DDL (in creation order) and rows, so it still has
 *    no database file.
 *
 * The real `openStore` then opens every copy (preflight, version check,
 * pragmas, WAL). Existing files, older-schema fixtures and injected
 * connections never take a copy, so migrations stay exercised. */
export function freshStoreOpener(real: typeof OpenStore, dir: string): typeof OpenStore {
  let template: string | null = null;
  let memory: string | null = null;
  return (file, options = {}) => {
    // A database made with a creator's fact, or under the migration seam, is never a template copy.
    if (options.connect !== undefined || options.createdBy !== undefined || options.migrationStep !== undefined) return real(file, options);
    if (file === ":memory:") {
      if (memory === null) {
        const store = real(file, options);
        memory = replayOf(store.handle);
        return store;
      }
      const sql = memory;
      return real(file, { connect: () => {
        const db = connectSqlite(":memory:");
        db.exec(sql);
        return db;
      } });
    }
    if (existsSync(file) || existsSync(`${file}-wal`) || existsSync(`${file}-journal`)) return real(file, options);
    if (template === null) {
      const built = join(dir, "fresh-template.db");
      real(built).close();
      template = built;
    }
    // The directory is 0700 from birth, exactly as `openStore` makes it.
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    copyFileSync(template, file);
    return real(file, options);
  };
}

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** One transaction recreating a database: every schema object in creation
 * order, then every row through SQLite's own `quote()` so types and blobs
 * survive. Virtual-table shadow tables, and their rows, come from their CREATE
 * VIRTUAL TABLE. */
function replayOf(db: Database): string {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY rowid").all()
    .map(row => ({ type: String(row["type"]), name: String(row["name"]), sql: row["sql"] === null ? null : String(row["sql"]) }));
  const virtual = objects.filter(one => one.type === "table" && /^CREATE VIRTUAL TABLE/i.test(one.sql ?? "")).map(one => one.name);
  const shadow = (name: string): boolean => virtual.some(table => name.startsWith(`${table}_`));
  const ddl = objects.filter(one => one.sql !== null && one.name !== "sqlite_sequence" && !shadow(one.name)).map(one => one.sql!);
  // Shadow tables are left out too: their CREATE VIRTUAL TABLE makes them, and SQLite's defensive mode (Node 24's
  // default) refuses any write to them ("table memory_search_data may not be modified").
  const tables = objects.filter(one => one.type === "table" && !virtual.includes(one.name) && !shadow(one.name)).map(one => one.name);
  const rows = tables.flatMap(table => {
    const columns = db.prepare(`PRAGMA table_info(${ident(table)})`).all().map(column => `quote(${ident(String(column["name"]))})`);
    return db.prepare(`SELECT 'INSERT OR REPLACE INTO ' || ? || ' VALUES(' || ${columns.join(" || ',' || ")} || ')' AS sql FROM ${ident(table)}`)
      .all(ident(table)).map(row => String(row["sql"]));
  });
  return ["BEGIN", ...ddl, ...rows, "COMMIT"].join(";\n");
}

// Loaded on first use: browser-environment test files share this setup and
// cannot bundle node:sqlite.
function connectSqlite(file: string): Database {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(file) as unknown as Database;
}
