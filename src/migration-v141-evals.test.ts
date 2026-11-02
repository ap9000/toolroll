/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V141_ADDED_COLUMNS, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

const TABLES = ["eval_campaign", "eval_attempt", "eval_invocation", "eval_baseline_pin", "eval_debt"];

test.each([140, -140])("v%s: the eval set's tables and how billing was known are added; no saved row changes", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v141-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-30T12:00:00.000Z");
  const first = openStore(file);
  first.upsertProject("/projects/shop", "shop", now);
  first.createTask({ id: "t-1", title: "a task" }, now);
  const taskRef = first.refFor(BUILT_IN, "t-1").id;
  const run = first.startRun({ taskRef, leaseId: "l-1", runner: "runner-a", branch: "b/1", worktree: "/w/1", now, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
  first.recordUsage(run, { tokensIn: 10, tokensOut: 2, costUsd: 0.01 });
  first.handle.prepare(`INSERT INTO chat_turn (approver, credential_key, provider, model, state, created_at, reserved_microusd, settled_microusd, tokens_in, tokens_out)
    VALUES ('alex', 'k', 'claude-subscription', 'sonnet', 'answered', ?, 0, 0, 9, 3)`).run(now.toISOString());
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v140 shape: none of the tables, none of the columns.
  const db = new DatabaseSync(file);
  for (const table of [...TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
  for (const [table, columns] of Object.entries(V141_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(140)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(141);
  expect(SCHEMA_VERSION).toBe(143);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(143);
  for (const table of TABLES) expect(store.handle.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
  // Saved rows keep what they had; how their billing was known reads NULL (unknown), never a class.
  // A saved run's cost reads as not marked unknown (0), its money unknown all the same through its NULL billing basis.
  expect({ ...store.handle.prepare("SELECT tokens_in, cost_usd, billing_basis, cost_unknown FROM run WHERE id = ?").get(run) }).toEqual({ tokens_in: 10, cost_usd: 0.01, billing_basis: null, cost_unknown: 0 });
  expect({ ...store.handle.prepare("SELECT tokens_in, billing_reported FROM chat_turn").get() }).toEqual({ tokens_in: 9, billing_reported: null });
  expect(() => store!.handle.prepare("UPDATE run SET billing_basis = 'probably'").run()).toThrow();
  expect(() => store!.handle.prepare("UPDATE chat_turn SET billing_reported = 'free'").run()).toThrow();
  expect(() => store!.handle.prepare("UPDATE run SET cost_unknown = 2").run()).toThrow();
  expect(() => store!.handle.prepare("UPDATE run SET cost_unknown = NULL").run()).toThrow();
  // An attempt's identity is unique, an original included (replaces is 0, never NULL, so two originals can't both land).
  const campaign = (id: string, canonical: number, state = "running") => store!.handle.prepare(`INSERT INTO eval_campaign (id, kind, canonical, manifest_digest, build_digest, version, k, sealed_json,
    started_by, started_proof, runner_host, runner_pid, admitted_at, state) VALUES (?, 'eval', ?, 'm', 'b', '0.9.82', 3, '{}', 'alex', 'password', 'h', 1, ?, ?)`).run(id, canonical, now.toISOString(), state);
  campaign("c-1", 1);
  // A campaign's runner start (recovery's pid identity) is nullable; its spending reads known until abandoned.
  expect({ ...store.handle.prepare("SELECT runner_started, spending_unknown FROM eval_campaign WHERE id = 'c-1'").get() }).toEqual({ runner_started: null, spending_unknown: 0 });
  expect(() => store!.handle.prepare("UPDATE eval_campaign SET spending_unknown = 2").run()).toThrow();
  const attempt = () => store!.handle.prepare("INSERT INTO eval_attempt (campaign, case_id, case_version, n, model_pinned, started_at) VALUES ('c-1', 'paginate', 'v', 1, 'm', ?)").run(now.toISOString());
  attempt();
  expect(attempt).toThrow();
  // One canonical campaign runs at a time (settlement order); diagnostic ones aren't held to it.
  expect(() => campaign("c-2", 1)).toThrow();
  campaign("d-1", 0);
  campaign("d-2", 0);
  // A dispatch's money is one of three amounts, and never negative.
  const dispatch = (amount: string, api: number | null) => store!.handle.prepare("INSERT INTO eval_invocation (attempt, kind, world_ref, recorded, amount, api_microusd) VALUES (1, 'builder', ?, 1, ?, ?)").run(`run:${amount}${api}`, amount, api);
  expect(() => dispatch("free", null)).toThrow();
  expect(() => dispatch("api", -1)).toThrow();
  dispatch("unknown", null);
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  store.handle.exec("DELETE FROM eval_invocation; DELETE FROM eval_attempt; DELETE FROM eval_campaign");
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
});
