/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([103, -103])("v%s: monitoring has somewhere to keep its progress, and the ledger it streams is untouched", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v104-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-28T12:00:00.000Z");
  const first = openStore(file);
  first.recordAction({ at: now.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: "before v104", outcome: "done", source: "policy" });
  const chain = first.ledgerChain();
  first.close();
  // The v103 shape: no monitoring progress.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE monitoring_status");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(112);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(112);
  expect(store.monitoringStatus()).toEqual([]);
  expect(store.ledgerChain()).toMatchObject({ ok: true, head: chain.head });
  expect(store.holdMonitoring("webhook", "me", now, new Date(now.getTime() + 60_000))).toBe(true);
  expect(store.sealedAfter(0, 10).map(one => one.action)).toEqual(["before v104"]);
});
