/**
 * An agent CLI's sign-in status command (`claude auth status --json`, `codex login status`), run safely: the one runner
 * every sign-in check uses (provider-connection.ts's checker by default, so the console's, the worker's, onboarding's and
 * agent-detect.ts's too).
 *
 * - Where nothing may run. Every folder an agent can write, derived here from Toolroll's own records at each check, so
 *   no caller can leave one out: every project the store knows (and the project registry beside it), every worktree,
 *   Toolroll's state folder, and the repository this process was started in. A database that exists but can't be read
 *   refuses every check.
 * - Which binary. The first match on PATH, as the person's shell would find it, and only if it is a trusted install:
 *   its PATH folder is absolute and trusted, and the binary's real path is a trusted file (trusted-path.ts: owned by
 *   this user or root, nothing above it writable by others, no ACL that lets anyone change it), neither inside a folder
 *   above. A launcher script (`#!`) also needs its package folder trusted the same way and outside those folders: the
 *   nearest folder above it holding a package.json, else its own folder. A first match that isn't trusted runs nothing
 *   (its sign-in reads unknown); a later match is never tried instead.
 * - Checked again right before the start, with fresh ACL answers (nothing cached from the first check), and the exact
 *   real path is started.
 * - Its environment is built from nothing: PATH of trusted folders only, the user and locale names, and the location
 *   variables (HOME, TMPDIR, CLAUDE_CONFIG_DIR, CODEX_HOME) only when each names a folder owned by this user, not
 *   writable by others, with no ACL that lets anyone change it, outside every folder above; any other is left out (the
 *   CLI's own default applies). Its working folder is a fresh, empty folder of this check's own, removed after.
 * - Bounded: every step, the ACL reads included, sits inside one deadline; the command runs in a process group of its
 *   own, ended at the deadline by that group's exact id (SIGTERM, then SIGKILL), so anything it started goes with it;
 *   whatever its group still holds when it exits is ended too.
 *
 * Residuals, stated: a launcher may load code from other places this same user owns, which then has the user's own
 * trust; and a descendant that starts a session of its own (setsid) leaves the process group, so the group kill can't
 * reach it.
 */
import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExecResult, RunOptions } from "./exec.js";
import type { Store } from "./store.js";
import { boundedAcl, trustedBinary, trustedFolders, type AclReader } from "./trusted-path.js";

/** How long a status command may take, every check before it included. */
export const STATUS_TIMEOUT_MS = 800;
/** After SIGTERM, how long the group has before SIGKILL. */
const KILL_GRACE_MS = 250;
const STATUS_MAX_BUFFER = 32 * 1024;
/** The plain names a status command gets from the environment it was asked from. */
export const STATUS_ENV_NAMES: readonly string[] = ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];
/** The location names it gets only when each names a trusted folder (statusEnvironment). */
export const STATUS_LOCATION_NAMES: readonly string[] = ["HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

type Env = Readonly<Record<string, string | undefined>>;
type ExclusionStore = Pick<Store, "knownRepos" | "listProjects" | "listWorktrees" | "databaseFile">;

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const realOrNull = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };
const NOT_FOUND: ExecResult = { code: 127, stdout: "", stderr: "", timedOut: false, notFound: true };
/** What a refused check answers: nothing ran, and the sign-in check reads it as unknown. */
const REFUSED: ExecResult = { code: 126, stdout: "", stderr: "", timedOut: false, notFound: false };

/** The repository `dir` is in (the nearest folder above it holding `.git`), read from the folders alone; null outside. */
export function repositoryOf(dir: string): string | null {
  let at = realOrNull(dir);
  while (at !== null) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

/**
 * Every folder an agent can write, from Toolroll's own records now (see the header): the store's projects and
 * worktrees, the registry's projects, the state folder, and the start repository, as real paths. Null when the
 * database exists but can't be read (every check then refuses).
 */
export async function excludedFolders(source: { store?: ExclusionStore | undefined; databaseFile?: string | undefined }, extra: readonly string[] = []): Promise<string[] | null> {
  const { databasePath, openStoreReadOnly } = await import("./store.js");
  const file = source.store?.databaseFile() ?? source.databaseFile ?? databasePath(process.env, homedir());
  const found: string[] = [...extra];
  let store: ExclusionStore | null = source.store ?? null;
  let opened: Store | null = null;
  if (file !== null && file !== ":memory:") {
    found.push(dirname(file));
    const { readProjectRegistryNow } = await import("./repos.js");
    const registry = readProjectRegistryNow(join(dirname(file), "repos.json"));
    if (!("error" in registry)) found.push(...registry.repos);
    if (store === null && existsSync(file)) {
      opened = openStoreReadOnly(file);
      if (opened === null) return null;
      store = opened;
    }
  }
  try {
    if (store !== null) found.push(...store.knownRepos(), ...store.listProjects().map(one => one.path), ...store.listWorktrees().map(one => one.path));
  } catch { return null; } finally { opened?.close(); }
  const repo = repositoryOf(process.cwd());
  if (repo !== null) found.push(repo);
  return [...new Set(found.flatMap(one => { const real = realOrNull(one); return real === null ? [] : [real]; }))];
}

export type StatusTrust = {
  /** The PATH searched, as the environment says it. */
  path: string;
  uid: number | undefined;
  /** Folders an agent can write, as real paths (excludedFolders): nothing inside them runs. */
  untrusted: readonly string[];
  acl: AclReader | null;
};

export type Resolved = { ok: true; real: string } | { ok: false; missing: true } | { ok: false; missing: false; why: string };

/** Whether a file starts with `#!` (a launcher script), by a two-byte read that never follows a final symlink. */
function isScript(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const head = Buffer.alloc(2);
    return readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x23 && head[1] === 0x21;
  } catch { return false; } finally { if (fd !== null) closeSync(fd); }
}

/** A launcher's package folder: the nearest folder above it holding a package.json, else its own folder. */
export function packageFolderOf(script: string): string {
  for (let folder = dirname(script); ; ) {
    if (existsSync(join(folder, "package.json"))) return folder;
    const up = dirname(folder);
    if (up === folder) return dirname(script);
    folder = up;
  }
}

/** The status command's binary: the first match on PATH, and whether it is a trusted install (see the header). */
export function resolveStatusBinary(binary: string, trust: StatusTrust): Resolved {
  const refused = (why: string): Resolved => ({ ok: false, missing: false, why });
  const excluded = (path: string): boolean => trust.untrusted.some(root => inside(path, root));
  for (const entry of trust.path.split(delimiter)) {
    if (entry === "") continue;
    const candidate = join(isAbsolute(entry) ? entry : resolve(entry), binary);
    try { accessSync(candidate, constants.X_OK); } catch { continue; }
    // The first match is what the person's shell runs: from here it is trusted or nothing runs.
    if (!isAbsolute(entry)) return refused("it was found through a relative PATH entry");
    if (trust.uid === undefined) return refused("who owns it can't be checked on this system");
    const folder = realOrNull(entry);
    if (folder === null) return refused("its PATH folder can't be read");
    if (excluded(folder)) return refused("its PATH folder is inside a project, worktree or Toolroll's own folder");
    const folders = trustedFolders(folder, trust.uid, trust.acl);
    if (!folders.ok) return refused(folders.why);
    const file = trustedBinary(candidate, trust.uid, trust.acl);
    if (!file.ok) return refused(file.why);
    if (excluded(file.real)) return refused("it is inside a project, worktree or Toolroll's own folder");
    if (isScript(file.real)) {
      // A launcher loads its package: that folder must be trusted the same way (the folder itself, no sticky pass).
      const pack = packageFolderOf(file.real);
      if (excluded(pack)) return refused("its package folder is inside a project, worktree or Toolroll's own folder");
      const packed = trustedFolders(pack, trust.uid, trust.acl);
      if (!packed.ok) return refused(`its package folder: ${packed.why}`);
    }
    return { ok: true, real: file.real };
  }
  return { ok: false, missing: true };
}

/** The PATH a status command gets: the trusted, absolute folders of `trust.path`, outside every untrusted folder. */
export function trustedPathOf(trust: StatusTrust): string {
  if (trust.uid === undefined) return "";
  const kept: string[] = [];
  for (const entry of trust.path.split(delimiter)) {
    if (entry === "" || !isAbsolute(entry)) continue;
    const folder = realOrNull(entry);
    if (folder === null || trust.untrusted.some(root => inside(folder, root)) || !trustedFolders(folder, trust.uid, trust.acl).ok) continue;
    if (!kept.includes(folder)) kept.push(folder);
  }
  return kept.join(delimiter);
}

/** A location variable's folder may be handed on: absolute, owned by this user, not writable by others, no ACL that lets
 * anyone change it, and outside every untrusted folder. */
export function trustedLocation(value: string | undefined, trust: StatusTrust): string | null {
  if (value === undefined || value === "" || !isAbsolute(value) || trust.uid === undefined) return null;
  const real = realOrNull(value);
  if (real === null || trust.untrusted.some(root => inside(real, root))) return null;
  try {
    const seen = lstatSync(real);
    if (!seen.isDirectory() || seen.uid !== trust.uid || (seen.mode & 0o022) !== 0) return null;
  } catch { return null; }
  const acl = trust.acl?.(real);
  return acl === undefined || acl.ok ? value : null;
}

/** The status command's whole environment, built from nothing (see the header). */
export function statusEnvironment(source: Env, trust: StatusTrust): Record<string, string> {
  const env: Record<string, string> = { PATH: trustedPathOf(trust) };
  for (const name of STATUS_ENV_NAMES) { const value = source[name]; if (value !== undefined && value !== "") env[name] = value; }
  for (const name of STATUS_LOCATION_NAMES) { const value = trustedLocation(source[name], trust); if (value !== null) env[name] = value; }
  return env;
}

/** End a process group by its exact id; one already gone is fine. */
function endGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch { /* gone */ }
}

/**
 * Run one status command, bounded: `file` (an absolute path) in a process group of its own with exactly `env`. At the
 * deadline the group gets SIGTERM, then SIGKILL; when the command exits, whatever its group still holds is ended.
 */
export function runBoundedStatus(file: string, args: readonly string[], options: { env: Record<string, string>; cwd: string; timeoutMs: number; maxBuffer?: number }): Promise<ExecResult> {
  const cap = options.maxBuffer ?? STATUS_MAX_BUFFER;
  return new Promise(done => {
    let stdout = "", stderr = "", timedOut = false, settled = false, code: number | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (result: ExecResult): void => { if (settled) return; settled = true; for (const one of timers) clearTimeout(one); done(result); };
    if (options.timeoutMs <= 0) return finish({ code: 124, stdout: "", stderr: "", timedOut: true, notFound: false });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return finish({ code: missing ? 127 : -1, stdout: "", stderr: "", timedOut: false, notFound: missing });
    }
    const pgid = child.pid;
    const end = (signal: NodeJS.Signals): void => {
      if (pgid === undefined) return;
      if (process.platform === "win32") { try { child.kill(signal); } catch { /* gone */ } } else endGroup(pgid, signal);
    };
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < cap) stdout += chunk.slice(0, cap - stdout.length); });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < cap) stderr += chunk.slice(0, cap - stderr.length); });
    child.once("error", error => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      finish({ code: missing ? 127 : -1, stdout, stderr, timedOut: false, notFound: missing });
    });
    // The command answered: anything it left behind in its group is ended now (the group can't be reused while any of
    // it is alive), so nothing outlives the check.
    child.once("exit", exitCode => { code = exitCode; end("SIGKILL"); });
    child.once("close", () => finish({ code: timedOut ? 124 : code ?? -1, stdout, stderr, timedOut, notFound: false }));
    timers.push(setTimeout(() => {
      timedOut = true;
      end("SIGTERM");
      timers.push(setTimeout(() => end("SIGKILL"), KILL_GRACE_MS));
      // Never wait past the grace for pipes something else may hold.
      timers.push(setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish({ code: 124, stdout, stderr, timedOut: true, notFound: false }); }, KILL_GRACE_MS + 250));
    }, options.timeoutMs));
  });
}

/** A console's given projects (its options), read at each check, as the probe's extra folders: no closure of the
 * console's is needed. */
export function givenRepos(given: { repo?: string | undefined; repos?: readonly string[] | undefined; currentRepos?: (() => readonly string[]) | undefined }): () => string[] {
  return () => [...(given.repo === undefined ? [] : [given.repo]), ...(given.repos ?? []), ...(given.currentRepos?.() ?? [])];
}

export type StatusProbeOptions = {
  /** Where the PATH and the allowed names come from (this process's environment by default). */
  env?: Env;
  /** Toolroll's own records the excluded folders come from: the store in hand, or the database file (by default the
   * one this environment names). */
  store?: ExclusionStore;
  databaseFile?: string;
  /** More folders an agent can write (a console's given projects), besides those always derived. */
  untrusted?: () => readonly string[];
  timeoutMs?: number;
  uid?: number;
  /** A fresh ACL reader for each resolution, given its deadline (tests); trusted-path.ts boundedAcl by default. */
  aclFor?: (deadline: number) => AclReader | null;
};

/**
 * The sign-in checker's probe (provider-connection.ts createConnectionChecker): finds the binary as above, checks it
 * again right before the start, and runs it bounded with its own environment and an empty working folder. A binary that
 * isn't there answers "not found"; one that isn't trusted runs nothing and answers what its sign-in check reads as
 * unknown.
 */
export function statusProbe(options: StatusProbeOptions = {}): (file: string, args: readonly string[], runOptions?: RunOptions) => Promise<ExecResult> {
  return async (file, args, runOptions) => {
    const deadline = Date.now() + Math.min(runOptions?.timeoutMs ?? STATUS_TIMEOUT_MS, options.timeoutMs ?? STATUS_TIMEOUT_MS);
    const env = options.env ?? process.env;
    const untrusted = await excludedFolders({ store: options.store, databaseFile: options.databaseFile }, options.untrusted?.() ?? []);
    if (untrusted === null) return REFUSED;
    const aclFor = options.aclFor ?? ((at: number) => boundedAcl(at));
    const trustWith = (acl: AclReader | null): StatusTrust => ({ path: env["PATH"] ?? "", uid: options.uid ?? process.getuid?.(), untrusted, acl });
    const trust = trustWith(aclFor(deadline));
    const found = resolveStatusBinary(file, trust);
    if (!found.ok) return found.missing ? NOT_FOUND : REFUSED;
    const childEnv = statusEnvironment(env, trust);
    // Checked again right before the start, with fresh ACL answers: the same real path, still trusted.
    const again = resolveStatusBinary(file, trustWith(aclFor(deadline)));
    if (!again.ok || again.real !== found.real) return REFUSED;
    // A fresh, empty working folder of this check's own, gone after it.
    let cwd: string;
    try { cwd = mkdtempSync(join(tmpdir(), "toolroll-status-")); } catch { return REFUSED; }
    try {
      return await runBoundedStatus(found.real, args, { env: childEnv, cwd, timeoutMs: deadline - Date.now(), maxBuffer: Math.min(runOptions?.maxBuffer ?? STATUS_MAX_BUFFER, STATUS_MAX_BUFFER) });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}
