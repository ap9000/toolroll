import { afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshStoreOpener } from "./fresh-store.js";

// Runs before each test file's imports. A reporting command, subprocess, or
// failed fixture must never fall back to the developer's control-plane state.
const state = mkdtempSync(join(tmpdir(), "toolroll-tests-"));
const before = {
  TOOLROLL_DB: process.env.TOOLROLL_DB,
  STANDING_ORDERS_DB: process.env.STANDING_ORDERS_DB,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  TOOLROLL_NO_UPDATE_CHECK: process.env.TOOLROLL_NO_UPDATE_CHECK,
  TOOLROLL_STORAGE_SWEEP: process.env.TOOLROLL_STORAGE_SWEEP,
};
// Both names: the new one is read first, and neither may name the live store.
process.env.TOOLROLL_DB = join(state, "orders.db");
process.env.STANDING_ORDERS_DB = join(state, "orders.db");
process.env.XDG_CONFIG_HOME = join(state, "config");
// No test asks npm or GitHub for the latest release; the update tests script their own.
process.env.TOOLROLL_NO_UPDATE_CHECK = "1";
// No worker pass a test runs sweeps the machine's temp folders or processes; the sweep's own tests turn it on.
process.env.TOOLROLL_STORAGE_SWEEP = "off";
// Fresh databases start from one copy per test file instead of rerunning every migration.
vi.mock("../src/store.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/store.js")>();
  return { ...real, openStore: freshStoreOpener(real.openStore, mkdtempSync(join(state, "fresh-"))) };
});
afterAll(() => {
  for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(state, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
