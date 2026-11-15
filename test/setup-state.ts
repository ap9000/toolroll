import { afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { freshStoreOpener } from "./fresh-store.js";
import { NO_GUESSED_IDENTITY } from "./git-identity.js";
import { memoryAnchor, registerSecretFolder } from "../src/tool-secret-store.js";

// Runs before each test file's imports. A reporting command, subprocess, or
// failed fixture must never fall back to the developer's control-plane state.
const state = mkdtempSync(join(tmpdir(), "toolroll-tests-"));
// Both names: the new one is read first, and neither may name the live store.
process.env.TOOLROLL_DB = join(state, "orders.db");
process.env.STANDING_ORDERS_DB = join(state, "orders.db");
process.env.XDG_CONFIG_HOME = join(state, "config");
// No test asks npm or GitHub for the latest release; the update tests script their own.
process.env.TOOLROLL_NO_UPDATE_CHECK = "1";
// No worker pass a test runs sweeps the machine's temp folders or processes; the sweep's own tests turn it on.
process.env.TOOLROLL_STORAGE_SWEEP = "off";
// The macOS lane (vitest.config.ts TOOLROLL_TEST_LANE) picks the files of this run only: a Vitest a test starts runs
// exactly the files it names, never filtered by the outer run's lane.
delete process.env.TOOLROLL_TEST_LANE;
// No test reads the person's own home: their Codex and Claude sign-ins, settings and sessions stay theirs (and the
// plane's check fence hides them anyway). A test that wants one makes it in this home.
process.env.TOOLROLL_TEST_OUTER_HOME ??= process.env.HOME ?? "";
mkdirSync(join(state, "home"));
process.env.HOME = join(state, "home");
process.env.USERPROFILE = join(state, "home");
// Fail closed: a test file never starts with the person's own home as its HOME (os.homedir(), and so every default
// rooted in it: ~/.toolroll, ~/.claude, the build caches, follows HOME).
assertNotPersonHome(process.env.HOME);
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
  // Nothing of the person's comes back after the tests: work a test left running (a timed-out git command, a late
  // incident record) still finishes in this file's own throwaway home and database, never in ~/.toolroll or the real
  // database. 2026-11-14: a Flexible thread test's incident landed in the real ~/.toolroll/git-incidents.jsonl, as a
  // HOME put back here would send it. The worker process ends with the file; nothing after it reads these.
  rmSync(state, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** Throws when `home` is the person's own home folder (the password database's, or the HOME this run started with). */
function assertNotPersonHome(home: string | undefined): void {
  const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
  const person = [userInfo().homedir, process.env.TOOLROLL_TEST_OUTER_HOME].filter((one): one is string => typeof one === "string" && one !== "").map(real);
  if (home === undefined || home === "" || person.includes(real(home))) throw new Error(`test/setup-state.ts: a test's HOME must be its own throwaway folder, not ${home ?? "unset"}`);
}
