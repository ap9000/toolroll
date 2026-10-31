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

const TABLES = ["eval_campaign", "eval_attempt", "eval_invocation", "eval_spend_month", "eval_baseline_pin", "eval_debt"];

test.each([140, -140])("v%s: the eval set's tables are added; no saved row changes", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v141-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-30T12:00:00.000Z");
  const first = openStore(file);
  first.upsertProject("/projects/shop", "shop", now);
  first.createTask({ id: "t-1", title: "a task" }, now);
  first.refFor(BUILT_IN, "t-1");
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v140 shape: none of the six tables.
  const db = new DatabaseSync(file);
  for (const table of [...TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(140)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(141);
  expect(SCHEMA_VERSION).toBe(141);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(141);
  for (const table of TABLES) expect(store.handle.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
  // An attempt's identity is unique, an original included (replaces is 0, never NULL, so two originals can't both land).
  const campaign = (id: string, kind = "eval", state = "running") => store!.handle.prepare(`INSERT INTO eval_campaign (id, kind, canonical, manifest_digest, build_digest, version, k, sealed_json,
    started_by, started_proof, admitted_at, state, month, reserved_microusd) VALUES (?, ?, 1, 'm', 'b', '0.9.82', 3, '{}', 'alex', 'password', ?, ?, '2026-10', 100)`).run(id, kind, now.toISOString(), state);
  campaign("c-1");
  const attempt = () => store!.handle.prepare("INSERT INTO eval_attempt (campaign, case_id, case_version, n, model_pinned, started_at) VALUES ('c-1', 'paginate', 'v', 1, 'm', ?)").run(now.toISOString());
  attempt();
  expect(attempt).toThrow();
  // One running campaign of a kind at a time; a carve never passes the campaign's reservation.
  expect(() => campaign("c-2")).toThrow();
  campaign("r-1", "reviewer");
  expect(() => store!.handle.prepare("UPDATE eval_campaign SET carved_microusd = 101 WHERE id = 'c-1'").run()).toThrow();
  expect(() => store!.handle.prepare("INSERT INTO eval_spend_month (month, ceiling_microusd, reserved_microusd) VALUES ('2026-10', 1, -1)").run()).toThrow();
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  store.handle.exec("DELETE FROM eval_attempt; DELETE FROM eval_campaign");
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
});
