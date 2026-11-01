/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

const TABLES = ["nightly_lane", "nightly_lane_alias", "github_nightly_cursor", "github_nightly_watch", "nightly_lane_job", "nightly_lane_failure", "nightly_exemption"];

test.each([138, -138])("v%s: GitHub's nightly tables are added; no saved row changes", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v139-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-30T12:00:00.000Z");
  const first = openStore(file);
  first.upsertProject("/projects/shop", "shop", now, { remoteUrl: "https://github.com/acme/shop.git" });
  first.createTask({ id: "t-1", title: "a task" }, now);
  first.refFor(BUILT_IN, "t-1");
  first.handle.prepare("INSERT INTO main_check_failure (repo, sha, run, item, opened_at) VALUES (?, ?, ?, ?, ?)").run("/projects/shop", "a".repeat(40), 1, "part:all", now.toISOString());
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v138 shape: none of the seven tables.
  const db = new DatabaseSync(file);
  for (const table of [...TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(138)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(139);
  expect(SCHEMA_VERSION).toBe(142);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(142);
  for (const table of TABLES) expect(store.handle.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
  // The plane's own nightly debt is untouched and stays apart.
  expect(store.handle.prepare("SELECT count(*) AS n FROM main_check_failure WHERE cleared_at IS NULL").get()?.["n"]).toBe(1);
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
});
