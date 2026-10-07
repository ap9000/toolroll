/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { mintCoordinator } from "./coordinator.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([102, -102])("v%s: the ledger written before is sealed whole on first read, and the chain verifies from then on", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v103-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-28T12:00:00.000Z");
  const first = openStore(file);
  first.createTask({ id: "old-task", title: "filed before v103" }, now);
  for (let i = 0; i < 3; i++) first.recordAction({ at: now.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: `before ${i}`, outcome: "done", source: "policy" });
  first.close();
  // The v102 shape: no chain, no checkpoints, no ledger rows for teammate calls or minted coordinators.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE ledger_seal; DROP TABLE ledger_checkpoint; DROP TRIGGER ledger_coordinator_minted");
  const before = Number(db.prepare("SELECT COUNT(*) AS n FROM action_ledger").get()?.n);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(113);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(113);
  // Nothing is sealed until something reads or the worker passes; then everything is, in order.
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM ledger_seal").get()?.n).toBe(0);
  expect(store.ledgerChain()).toMatchObject({ ok: true, entries: before, unsealed: 0, checkpoints: 0 });
  expect(mintCoordinator(store, { name: "after", repos: ["/repo/a"], by: "alex", now }).ok).toBe(true);
  expect(store.ledgerChain()).toMatchObject({ ok: true, entries: before + 1 });
  expect(store.ledgerCheckpoint("alex", now)).toMatchObject({ through: before + 1 });
});
