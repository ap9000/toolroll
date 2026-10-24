/**
 * The attack suite's shared harness. Every test under test/attacks/ replays a bypass a review found against the real
 * production guard, asserts the attack fails, and asserts the legitimate path beside it still works. This module
 * gives them the same few pieces:
 *
 * - synthetic markers: a secret-looking string no real file holds, so "the marker never appears" is the proof;
 * - scratch folders (homes, state folders, projects, run folders) under the test run's own temp root, removed after;
 * - git with a fixed identity and no global or system config, so a developer's settings never decide a result;
 * - runners for the generated Seatbelt profile (`sandbox-exec`) and the installed `codex sandbox`, probed once. Where
 *   one can't run (not macOS, Codex not installed, or already inside a sandbox, which can't nest), a native check is
 *   skipped with a plain note saying why, and the policy assertions beside it still run;
 * - `expectedToFail`: an attack whose fix isn't on main yet, named with the task that fixes it. Vitest's `fails`
 *   turns the test red the moment the fix lands, so the marker is removed then and the attack stays covered.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, type TestContext } from "vitest";
import { agentFence, codexFenceArgv, fenceGrants, HARDENED_GIT_ARGS, linuxFenceAvailable, macosFenceAvailable, macosFenced, NO_GRANTS, runFolders, SANDBOX_EXEC, taskBoundary, trustedWorktreeBinding, type FenceGrants } from "../../src/agent-fence.js";
import { poolRootOf } from "../../src/worktree.js";
// Every attack file imports this harness, and this harness every guard (scripts/quick-check.mjs SECURITY_CRITICAL),
// so a Quick command that follows imports (`vitest related <changed files>`) runs the whole suite when one changes.
import "../../src/checkout-cleanup.js";
import "../../src/flow-unattended.js";
import "../../src/invoke.js";
import "../../src/landed-cleanup.js";
import "../../src/project-tools.js";
import "../../src/provider-home.js";
import "../../src/teardown-git.js";
import "../../src/tool-broker.js";

/** A synthetic secret, unique per call: `synthetic-attack-<label>-<hex>`. Never a real credential's shape. */
export function marker(label: string): string {
  return `synthetic-attack-${label}-${randomBytes(6).toString("hex")}`;
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const q = (path: string): string => JSON.stringify(path);

/** A fresh real-path scratch folder per test (`so-attack-<label>-…`), removed after it. */
export function useScratch(label: string): () => string {
  let dir: string | null = null;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), `so-attack-${label}-`))); });
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    dir = null;
  });
  return () => {
    if (dir === null) throw new Error("scratch folder used outside a test");
    return dir;
  };
}

/** Child processes a test started; killed after it whatever happened. */
export function useChildren(): (child: ChildProcess) => ChildProcess {
  const children: ChildProcess[] = [];
  afterEach(() => { for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL"); });
  return child => { children.push(child); return child; };
}

/** A long-lived process holding `env`, ready once it has printed its first line (no fixed sleep). */
export async function holder(env: Record<string, string>, track: (child: ChildProcess) => ChildProcess): Promise<ChildProcess> {
  const child = track(spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["ignore", "pipe", "ignore"] }));
  await new Promise<void>((done, failed) => {
    child.once("error", failed);
    child.stdout!.once("data", () => done());
  });
  return child;
}

export function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** Git with a fixed identity, outside any global or system config; throws with stderr on failure. */
export const GIT_ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Attack suite", GIT_AUTHOR_EMAIL: "attack@example.invalid",
  GIT_COMMITTER_NAME: "Attack suite", GIT_COMMITTER_EMAIL: "attack@example.invalid",
};
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository at `path` with one commit (and any `files`), on main. */
export function repository(path: string, files: Record<string, string> = { "README.md": "fixture\n" }): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  for (const [file, text] of Object.entries(files)) write(join(path, file), text);
  git(path, "add", "-A");
  git(path, "commit", "-qm", "fixture");
  return path;
}

/** Why a native facility can't run here, or null when it can. Probed once per test file. */
type Probe = { available: boolean; note: string };

let seatbeltProbe: Probe | null = null;
/** The macOS Seatbelt fence, as builds get it: the production probe, plus the plain reason when it is unavailable. */
export function seatbelt(): Probe {
  if (seatbeltProbe !== null) return seatbeltProbe;
  if (process.platform !== "darwin") return seatbeltProbe = { available: false, note: "Seatbelt checks skipped: not macOS" };
  if (macosFenceAvailable()) return seatbeltProbe = { available: true, note: "" };
  const ran = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 5_000 });
  const why = /Operation not permitted/.test(ran.stderr ?? "") ? "this process is already inside a sandbox, and Seatbelt can't nest" : "sandbox-exec is missing";
  return seatbeltProbe = { available: false, note: `Seatbelt checks skipped: ${why}` };
}

/** Toolroll's own OS fence, as any launch gets it: Seatbelt on a Mac, bubblewrap on Linux. */
export function osFence(): Probe {
  if (process.platform === "darwin") return seatbelt();
  if (process.platform === "linux") return linuxFenceAvailable() ? { available: true, note: "" } : { available: false, note: "OS fence checks skipped: bubblewrap can't make its namespaces here" };
  return { available: false, note: "OS fence checks skipped: no macOS sandbox or bubblewrap on this platform" };
}

let codexProbe: Probe | null = null;
/** The installed `codex sandbox`, with the generated policy: runs here only when Codex is installed and can sandbox. */
export function codexSandbox(): Probe {
  if (codexProbe !== null) return codexProbe;
  const version = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (version.error !== undefined || version.status !== 0) return codexProbe = { available: false, note: "Codex sandbox checks skipped: codex is not installed" };
  const home = mkdtempSync(join(tmpdir(), "so-codex-probe-"));
  try {
    const ran = spawnSync("codex", ["sandbox", ...codexFenceArgv([], false), "-P", "standing-orders", "--", "/usr/bin/true"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: home }, timeout: 30_000 });
    if (ran.status === 0) return codexProbe = { available: true, note: "" };
    const nested = /Operation not permitted|sandbox_apply/.test(`${ran.stderr ?? ""}`);
    return codexProbe = { available: false, note: `Codex sandbox checks skipped: ${nested ? "this process is already inside a sandbox, and Codex's can't nest" : `codex sandbox exited ${ran.status ?? "on a signal"}`}` };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Skip the rest of a test, with its plain note, when `probe` can't run here. */
export function needs(ctx: TestContext, probe: Probe): void {
  // The Quick check names every native attack that couldn't run, so a sandboxed run never reads as a full pass.
  const skips = process.env["TOOLROLL_ATTACK_SKIPS"];
  if (!probe.available && skips !== undefined) appendFileSync(skips, `${ctx.task.name}: ${probe.note}\n`);
  ctx.skip(!probe.available, probe.note);
}

const NATIVE_ENV = () => ({ ...process.env, NODE_OPTIONS: undefined });

/** `script` in /bin/sh under the generated Seatbelt profile for `fence` and `grants`, exactly as a build spawns it. */
export function underSeatbelt(script: string, fence: readonly string[], grants: FenceGrants = NO_GRANTS, options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number }): SpawnSyncReturns<string> {
  const { file, args } = macosFenced("/bin/sh", ["-c", script], fence, grants);
  return spawnSync(file, args, { cwd: options.cwd, encoding: "utf8", env: options.env ?? NATIVE_ENV(), timeout: options.timeout ?? 60_000 });
}

/** `script` in /bin/sh under `codex sandbox` with the generated permission profile, with its own CODEX_HOME. */
export function underCodex(script: string, fence: readonly string[], fullAccess: boolean, grants: FenceGrants = NO_GRANTS, options: { cwd: string; codexHome: string; timeout?: number }): SpawnSyncReturns<string> {
  mkdirSync(options.codexHome, { recursive: true });
  return spawnSync("codex", ["sandbox", ...codexFenceArgv(fence, fullAccess, grants), "-P", "standing-orders", "--", "/bin/sh", "-c", script], {
    cwd: options.cwd, encoding: "utf8", env: { ...NATIVE_ENV(), CODEX_HOME: options.codexHome }, timeout: options.timeout ?? 60_000,
  });
}

/** Lines a probe printed, trimmed. */
export const lines = (result: { stdout: string }): string[] => result.stdout.trim().split("\n").filter(line => line !== "");

/** The marker must appear nowhere in what a fenced command printed. */
export function expectNoMarker(result: { stdout: string; stderr: string }, secret: string): void {
  expect(result.stdout, result.stderr).not.toContain(secret);
  expect(result.stderr).not.toContain(secret);
}

/**
 * An attack whose fix is not on main yet: the test runs, is expected to fail, and names the task that fixes it. When
 * that task lands the test passes, `fails` reports it, and the marker comes off so the attack stays covered.
 */
export function expectedToFail(taskId: string, name: string, fn: (ctx: TestContext) => unknown, timeout?: number): void {
  test.fails(`${name} (expected to fail until ${taskId} lands)`, fn, timeout);
}

/** Shared-install keys as the plane names them (24 hex): this project's copy and another project's. */
export const LINKED_KEY = "0123456789abcdef01234567";
export const OTHER_KEY = "fedcba9876543210fedcba98";

/**
 * One plane with two projects, laid out as Toolroll lays them out, every secret holding `secret`:
 *
 * - `state` (…/standing-orders): orders.db, up-login.txt, the checkout pool `pool` (state/worktrees) and shared
 *   installs (state/deps/<key>/node_modules, with their ready notes);
 * - `home`: ~/.ssh/id and ~/.toolroll/tool-secrets/t.json;
 * - project `main` (projects/app) with this build's checkout `active` (pool/app/task-0123abcd) and a same-project
 *   sibling (pool/app/sibling-4567cdef) holding an untracked secret;
 * - another project's checkout `theirs` (pool/other/task-89abcdef), and a prefix-named project's (`app-extra`), each
 *   holding the secret, plus a sibling whose name starts with the own checkout's (`task-0123abcd-4567cdef`);
 * - a stand-in system temp folder `root` with this launch's own tool folder `own`.
 *
 * `launch` builds the fence exactly as invoke.ts does for one provider: the trusted binding from the plane's record,
 * the task boundary, the agent fence and the grants with the pool roots.
 */
export function plane(dir: string, secret: string) {
  const state = join(dir, "standing-orders");
  const home = join(dir, "home");
  const pool = join(state, "worktrees");
  const main = join(dir, "projects", "app");
  const active = join(pool, "app", "task-0123abcd");
  const sibling = join(pool, "app", "sibling-4567cdef");
  const prefixSibling = join(pool, "app", "task-0123abcd-4567cdef");
  const theirs = join(pool, "other", "task-89abcdef");
  const prefixed = join(pool, "app-extra", "task-2468ace0");
  const root = join(dir, "T");
  const own = join(root, "so-tools-mine");
  const databaseFile = join(state, "orders.db");
  write(databaseFile, `db ${secret}`);
  write(join(state, "up-login.txt"), secret);
  write(join(home, ".ssh", "id"), secret);
  write(join(home, ".toolroll", "tool-secrets", "t.json"), JSON.stringify({ token: secret }));
  write(join(own, "mcp.json"), "own-tools");
  repository(main);
  git(main, "worktree", "add", "-qb", "task", active);
  git(main, "worktree", "add", "-qb", "sibling", sibling);
  git(main, "worktree", "add", "-qb", "prefix", prefixSibling);
  write(join(sibling, "secret.txt"), secret);
  write(join(prefixSibling, "secret.txt"), secret);
  for (const [project, checkout] of [["other", theirs], ["app-extra", prefixed]] as const) {
    const repo = repository(join(dir, "projects", project));
    git(repo, "worktree", "add", "-qb", "task", checkout);
    write(join(checkout, "secret.txt"), secret);
  }
  const head = git(active, "rev-parse", "HEAD");
  // Shared installs as the plane makes them: this project's copy (linked from the checkout) and another project's.
  for (const [key, repo] of [[LINKED_KEY, main], [OTHER_KEY, join(dir, "projects", "other")]] as const) {
    write(join(state, "deps", key, "node_modules", "pkg", "package.json"), JSON.stringify({ name: "pkg", main: "index.js" }));
    write(join(state, "deps", key, "node_modules", "pkg", "index.js"), `module.exports = { value: ${JSON.stringify(key === LINKED_KEY ? "linked" : secret)} };\n`);
    write(join(state, "deps", key, "ready.json"), JSON.stringify({ version: 1, repo, key, lock: "lock", node: "node", setup: "setup-1", tree: null, createdAt: "2026-10-12T00:00:00.000Z" }));
  }
  const linked = { repo: main, setupDigest: "setup-1" };
  const shared = (key: string) => join(state, "deps", key, "node_modules");
  write(join(active, "node_modules", ".toolroll-shared"), `${shared(LINKED_KEY)}\n`);
  symlinkSync(join(shared(LINKED_KEY), "pkg"), join(active, "node_modules", "pkg"), "dir");
  const launch = (provider: "claude" | "codex", options: { linked?: typeof linked | null } = {}) => {
    const binding = trustedWorktreeBinding(main, active, [pool]);
    const boundary = taskBoundary({ worktree: active, provider, home, binding });
    const folders = runFolders(own, root);
    return {
      binding, boundary,
      fence: agentFence({ databaseFile, worktree: active, home, boundary, binding, runFolders: folders }),
      grants: fenceGrants({ databaseFile, worktree: active, boundary, runFolders: folders, linked: options.linked === undefined ? linked : options.linked, binding, home, poolRoots: [pool, poolRootOf(active, main)] }),
    };
  };
  return { dir, state, home, pool, main, active, sibling, prefixSibling, theirs, prefixed, root, own, databaseFile, head, linked, shared, launch };
}
export type Plane = ReturnType<typeof plane>;

/** What a build's ordinary work needs, as a shell probe, and the lines it prints when all of it works. */
export function ordinaryWork(at: Plane): { script: string; expected: string[] } {
  return {
    script: [
      "pwd -P",
      `git ${HARDENED_GIT_ARGS.join(" ")} rev-parse HEAD`,
      `git ${HARDENED_GIT_ARGS.join(" ")} status --porcelain >/dev/null && echo status-ok`,
      "echo mine > mine.txt && cat mine.txt && rm mine.txt",
      `${q(process.execPath)} -e 'console.log("node-" + require("pkg").value)'`,
    ].join("\n"),
    expected: [at.active, at.head, "status-ok", "mine", "node-linked"],
  };
}
