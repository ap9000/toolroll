/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V140_ADDED_COLUMNS, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([139, -139])("v%s: what a provider reported is added; saved runs and chat requests read not reported", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v140-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-30T12:00:00.000Z");
  const first = openStore(file);
  first.upsertProject("/projects/shop", "shop", now);
  first.createTask({ id: "t-1", title: "a task" }, now);
  const taskRef = first.refFor(BUILT_IN, "t-1").id;
  const authority = first.routeAuthorityFor(taskRef, "builder") ?? first.routeAuthorityFor(taskRef, "builder", { provider: "claude", model: null });
  const run = first.startRun({ taskRef, leaseId: "l-1", runner: "runner-a", branch: "b/1", worktree: "/w/1", now, ...(authority?.ok ? { route: authority.stamp } : {}) });
  first.recordUsage(run, { tokensIn: 10, tokensOut: 2, costUsd: 0.01, agentTurns: 3 });
  first.handle.prepare(`INSERT INTO chat_turn (approver, credential_key, provider, model, state, created_at, reserved_microusd, settled_microusd, tokens_in, tokens_out)
    VALUES ('alex', 'k', 'anthropic-api', 'claude-sonnet-4-5', 'answered', ?, 100, 40, 9, 3)`).run(now.toISOString());
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v139 shape: none of the four columns.
  const db = new DatabaseSync(file);
  for (const [table, columns] of Object.entries(V140_ADDED_COLUMNS)) {
    for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(139)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(140);
  expect(SCHEMA_VERSION).toBe(142);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(142);
  // Saved rows keep every value they had, and what was never reported reads NULL, never 0.
  expect({ ...store.handle.prepare("SELECT tokens_in, tokens_out, cost_usd, agent_turns, model_reported FROM run WHERE id = ?").get(run) })
    .toEqual({ tokens_in: 10, tokens_out: 2, cost_usd: 0.01, agent_turns: 3, model_reported: null });
  expect({ ...store.handle.prepare("SELECT settled_microusd, tokens_in, model_reported, provider_turns, reported_cost_usd FROM chat_turn").get() })
    .toEqual({ settled_microusd: 40, tokens_in: 9, model_reported: null, provider_turns: null, reported_cost_usd: null });
  // A reported count or cost is never negative.
  expect(() => store!.handle.prepare("UPDATE chat_turn SET provider_turns = -1").run()).toThrow();
  expect(() => store!.handle.prepare("UPDATE chat_turn SET reported_cost_usd = -0.5").run()).toThrow();
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
});
