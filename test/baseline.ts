/**
 * A database file at the v107 baseline: exactly what Toolroll 0.5.0 made for a new installation (store-baseline.ts),
 * stamped at `version`. The oldest shape this build upgrades, and a real one: no newer fields relabelled as older.
 */
import { createRequire } from "node:module";
import { BASELINE_SCHEMA, BASELINE_SCHEMA_VERSION } from "../src/store-baseline.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export function baselineFile(file: string, version: number = BASELINE_SCHEMA_VERSION): string {
  const db = new DatabaseSync(file);
  try {
    db.exec(BASELINE_SCHEMA);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
  } finally {
    db.close();
  }
  return file;
}
