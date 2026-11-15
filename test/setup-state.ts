import { afterAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
// @ts-expect-error plain ESM script without declarations
import { approvedTools, passes } from "../scripts/isolated-env.mjs";

// Runs before each test file's imports. A reporting command, subprocess, or failed fixture must never fall back to the
// developer's control-plane state, home, tools or credentials. Only Node's own modules and the isolation helper load
// before the worker's environment is rebuilt below; Toolroll's own modules load after it (dynamic imports).
const state = mkdtempSync(join(tmpdir(), "toolroll-tests-"));
const home = join(state, "home");
const personHomes = [userInfo().homedir, process.env.HOME].filter((one): one is string => typeof one === "string" && one !== "").map(real);

/**
 * The names a test worker keeps from the environment it was started with, exactly: Vitest's own, locale and terminal,
 * CI markers, this run's temp folder and fake outer home (test/temp-root.ts), and the switches a few suites read.
 * Everything else — PATH, credentials, SSH_AUTH_SOCK, GH_CONFIG_DIR, DOCKER_CONFIG, AWS_*, ANTHROPIC_*, OPENAI_*, any
 * *_TOKEN/*_KEY/*_SECRET, an agent session's own variables — is dropped. A credential-free proxy passes (passes()).
 */
const WORKER_PASS = ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "TEST", "NODE_ENV", "MODE", "DEV", "PROD", "SSR", "BASE_URL",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "CI", "GITHUB_ACTIONS", "RUNNER_OS", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME",
  "TOOLROLL_TEST_OUTER_HOME", "TOOLROLL_REQUIRE_NATIVE", "TOOLROLL_ATTACK_SKIPS", "SO_EXPECT_NATIVE_CONTAINMENT", "TOOLROLL_RELEASE_BUILD",
  "TOOLROLL_CHECK_RESULTS_FD", "TOOLROLL_CHECK_GATE", "PLAIN_WORDS_DUMP", "PLAIN_WORDS_OUT", "FAST_READS_OUT", "TELEGRAM_CARDS_OUT", "SANDBOX_RUNTIME",
  // Windows keeps the system names its processes need (PowerShell, which runs the Job Object helper, among them). A
  // stated Windows residual: PATH, APPDATA and LOCALAPPDATA stay the runner's own. An approved-tools folder needs
  // symlinks a Windows runner without developer mode can't make, and PowerShell under a fresh empty APPDATA spends its
  // first start building caches, past the containment helper's admission deadline. Windows CI runs only the Job Object
  // containment tests.
  ...(process.platform === "win32" ? ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "COMSPEC", "SystemDrive", "ProgramFiles",
    "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "ALLUSERSPROFILE",
    "PUBLIC", "APPDATA", "LOCALAPPDATA", "PSModulePath", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS", "OS",
    "COMPUTERNAME", "USERDOMAIN", "USERNAME", "DriverData"] : [])];

const outer = { ...process.env };
const kept: Record<string, string> = {};
for (const name of WORKER_PASS) { const value = outer[name]; if (value !== undefined) kept[name] = value; }
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) { const value = outer[name]; if (value !== undefined && passes(name, value)) kept[name] = value; }
mkdirSync(home);
for (const one of [join(home, ".cache"), join(home, ".local", "share"), join(home, ".local", "state")]) mkdirSync(one, { recursive: true });
// The approved tools only, by exact name, each linked by its resolved path (scripts/isolated-env.mjs APPROVED_TOOLS);
// a test that needs a stand-in puts its own folder first. Nothing the person installed (an agent CLI, gh, a browser)
// is on it.
const tools = process.platform === "win32" ? null : approvedTools(join(state, "tools"), { outerPath: outer.PATH }).dir as string;
// The one agent CLI a test may run, and only when a person asks for it: the installed Codex's own `sandbox` command (no
// model, its own CODEX_HOME), which the native attack checks exercise. TOOLROLL_TEST_CODEX_SANDBOX names that binary;
// unset (the default, and CI), those checks are skipped with a note.
const codexSandbox = outer["TOOLROLL_TEST_CODEX_SANDBOX"];
let codexDir: string | null = null;
if (tools !== null && codexSandbox !== undefined && isAbsolute(codexSandbox) && existsSync(codexSandbox)) {
  codexDir = join(state, "codex-sandbox");
  mkdirSync(codexDir);
  symlinkSync(realpathSync(codexSandbox), join(codexDir, "codex"));
}
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, kept, {
  HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(state, "config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"),
  ...(tools === null ? {} : { PATH: codexDir === null ? tools : `${tools}${delimiter}${codexDir}`, SHELL: join(tools, "sh") }),
  // Git in this home never guesses an identity from the host name (macOS does, Linux CI can't): a test that commits
  // sets one (test/git-identity.ts withGitIdentity), so a missing one fails here as it would in CI. No system config.
  GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  // Both names: the new one is read first, and neither may name the live store.
  TOOLROLL_DB: join(state, "orders.db"), STANDING_ORDERS_DB: join(state, "orders.db"),
  // No test asks npm or GitHub for the latest release; the update tests script their own.
  TOOLROLL_NO_UPDATE_CHECK: "1",
  // No worker pass a test runs sweeps the machine's temp folders or processes; the sweep's own tests turn it on.
  TOOLROLL_STORAGE_SWEEP: "off",
  // No test reads or writes the developer's own keychain: tool secrets stay in files unless a test picks a keychain of its own.
  TOOLROLL_SECRET_STORE: "files",
});
// Fail closed: a test file never runs with the person's own home as its HOME (os.homedir(), and so every default rooted
// in it: ~/.toolroll, ~/.claude, the build caches, follows HOME), nor with a PATH folder of theirs.
if (personHomes.includes(real(process.env["HOME"]!))) throw new Error(`test/setup-state.ts: a test's HOME must be its own throwaway folder, not ${process.env["HOME"]}`);
if (tools !== null && process.env["PATH"]!.split(delimiter).some(one => one !== tools && one !== codexDir)) throw new Error("test/setup-state.ts: a test worker's PATH is its approved tools only");

const { NO_GUESSED_IDENTITY } = await import("./git-identity.js");
writeFileSync(join(home, ".gitconfig"), NO_GUESSED_IDENTITY);
const { memoryAnchor, registerSecretFolder } = await import("../src/tool-secret-store.js");
// Toolroll's folder for secrets, as a started Toolroll has one: this file's state folder, never the developer's.
registerSecretFolder(state, memoryAnchor());
// Fresh databases start from one copy per test file instead of rerunning every migration.
vi.mock("../src/store.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/store.js")>();
  const { freshStoreOpener } = await import("./fresh-store.js");
  return { ...real, openStore: freshStoreOpener(real.openStore, mkdtempSync(join(state, "fresh-"))) };
});
afterAll(() => {
  // Nothing of the person's comes back after the tests: work a test left running (a timed-out git command, a late
  // incident record) still finishes in this file's own throwaway home and database, never in ~/.toolroll or the real
  // database. 2026-11-14: a Flexible thread test's incident landed in the real ~/.toolroll/git-incidents.jsonl, as a
  // HOME put back here would send it. The worker process ends with the file; nothing after it reads these.
  rmSync(state, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function real(path: string): string { try { return realpathSync(path); } catch { return path; } }
