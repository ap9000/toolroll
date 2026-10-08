import type { Database } from "./store.js";

/** Reclaim whole free pages on databases created without auto_vacuum. Call only after committing writes.
 * A migration needs at least 1 MiB to justify the I/O; retention reclaims whenever more than 25% is free. */
export function reclaimDatabase(db: Database, reason: "migration" | "retention"): boolean {
  const free = Number(db.prepare("PRAGMA freelist_count").get()!["freelist_count"]);
  const pages = Number(db.prepare("PRAGMA page_count").get()!["page_count"]);
  const size = Number(db.prepare("PRAGMA page_size").get()!["page_size"]);
  if (reason === "migration" ? free * size < 1024 * 1024 : free * 4 <= pages) return false;
  db.exec("VACUUM");
  // VACUUM writes through WAL too: checkpoint so the main file (and its backups) shrinks now.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return true;
}
