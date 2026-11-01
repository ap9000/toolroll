import { afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshStoreOpener } from "./fresh-store.js";
import { NO_GUESSED_IDENTITY } from "./git-identity.js";
import { memoryAnchor, registerSecretFolder } from "../src/tool-secret-store.js";

// Runs before each test file's imports. A reporting command, subprocess, or
// failed fixture must never fall back to the developer's control-plane state.
const state = mkdtempSync(join(tmpdir(), "toolroll-tests-"));
const before = {
  TOOLROLL_DB: process.env.TOOLROLL_DB,
  STANDING_ORDERS_DB: process.env.STANDING_ORDERS_DB,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  TOOLROLL_NO_UPDATE_CHECK: process.env.TOOLROLL_NO_UPDATE_CHECK,
  TOOLROLL_STORAGE_SWEEP: process.env.TOOLROLL_STORAGE_SWEEP,
  TOOLROLL_SECRET_STORE: process.env.TOOLROLL_SECRET_STORE,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};
// Both names: the new one is read first, and neither may name the live store.
process.env.TOOLROLL_DB = join(state, "orders.db");
process.env.STANDING_ORDERS_DB = join(state, "orders.db");
process.env.XDG_CONFIG_HOME = join(state, "config");
// No test asks npm or GitHub for the latest release; the update tests script their own.
process.env.TOOLROLL_NO_UPDATE_CHECK = "1";
// No worker pass a test runs sweeps the machine's temp folders or processes; the sweep's own tests turn it on.
process.env.TOOLROLL_STORAGE_SWEEP = "off";
// No test reads the person's own home: their Codex and Claude sign-ins, settings and sessions stay theirs (and the
// plane's check fence hides them anyway). A test that wants one makes it in this home.
process.env.TOOLROLL_TEST_OUTER_HOME ??= process.env.HOME ?? "";
mkdirSync(join(state, "home"));
process.env.HOME = join(state, "home");
process.env.USERPROFILE = join(state, "home");
// Git in this home never guesses an identity from the host name (macOS does, Linux CI can't): a test that commits
// sets one (test/git-identity.ts withGitIdentity), so a missing one fails here as it would in CI.
writeFileSync(join(state, "home", ".gitconfig"), NO_GUESSED_IDENTITY);
delete process.env.CODEX_HOME;
delete process.env.CLAUDE_CONFIG_DIR;
// No test reads or writes the developer's own keychain: tool secrets stay in files unless a test picks a keychain of its own.
process.env.TOOLROLL_SECRET_STORE = "files";
// Toolroll's folder for secrets, as a started Toolroll has one: this file's state folder, never the developer's.
registerSecretFolder(state, memoryAnchor());
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
