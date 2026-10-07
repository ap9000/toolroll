/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { setAuthMode } from "./keys.js";

let dir: string, store: Store | undefined;
const home = process.env["HOME"];
afterEach(() => { store?.close(); store = undefined; process.env["HOME"] = home; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([104, -104])("v%s: runs from before are priced when read (none settled yet), and budgets and plan windows have somewhere to live", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v105-"));
  // Claude on a key: its reported cost counts (on its plan it would be $0).
  process.env["HOME"] = dir;
  setAuthMode("claude", "api-key");
  const file = join(dir, "state.db");
  const now = new Date("2026-09-20T12:00:00.000Z");
  const first = openStore(file);
  first.createTask({ id: "old", title: "before v105", filedBy: { name: "alex", kind: "person" } }, now);
  const ref = first.refFor("built-in", "old").id;
  const run = first.startRun({ taskRef: ref, leaseId: "l", runner: "b1", branch: "b", worktree: "/w", route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now });
  first.handle.prepare("UPDATE run SET cost_usd = 2.5 WHERE id = ?").run(run);
  first.close();
  // The v104 shape: no spend, no budgets.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE run_spend; DROP TABLE budget; DROP TABLE provider_limit");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(113);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(113);
  expect(store.monthSpend(now).items).toMatchObject([{ runId: run, microusd: 2_500_000, source: "reported", person: "alex" }]);
  expect(store.providerLimits()).toEqual([]);
  expect(store.budgets()).toEqual([]);
  store.setBudget({ scope: "installation", key: "*", limitMicrousd: 1_000_000, hardStop: true }, "alex", now);
  expect(store.budgetGate(now)({ project: null, person: null, teammate: null }).over).toMatchObject({ scope: "installation" });
  // Read while Claude is on its plan, the same unsettled run is $0.
  setAuthMode("claude", "subscription");
  expect(store.monthSpend(now).items).toMatchObject([{ runId: run, microusd: 0, source: "subscription" }]);
});
