/**
 * An agent CLI's sign-in status command (`claude auth status --json`, `codex login status`), run safely: the one runner
 * every sign-in check uses (provider-connection.ts's checker by default, the console's, agent-detect.ts's).
 *
 * - Which binary. The first match on PATH, as the person's shell would find it, and only if it is a trusted install:
 *   its PATH folder is absolute and trusted, and the binary's real path is a trusted file (trusted-path.ts: owned by
 *   this user or root, nothing above it writable by others, no ACL that lets anyone change it). Neither may sit inside a
 *   folder an agent can write: a project Toolroll knows, a worktree, Toolroll's own state folder, or the repository this
 *   process was started in. A first match that isn't trusted runs nothing (its sign-in reads unknown); a later match is
 *   never tried instead.
 * - Checked again right before the start (real path, owner, mode and folders), and the exact real path is started.
 * - Its environment is built from nothing: PATH of trusted folders only, HOME, the user and locale names, TMPDIR, and
 *   the two variables a status command reads to find its own sign-in (CLAUDE_CONFIG_DIR, CODEX_HOME). No token, key,
 *   socket, loader or interpreter variable reaches it.
 * - Bounded: in a process group of its own, ended at the deadline by that group's exact id (SIGTERM, then SIGKILL), so
 *   anything it started goes with it; whatever its group still holds when it exits is ended too.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExecResult, RunOptions } from "./exec.js";
import { rememberedAcl, trustedBinary, trustedFolders, type AclReader } from "./trusted-path.js";

/** How long a status command may run. */
export const STATUS_TIMEOUT_MS = 800;
/** After SIGTERM, how long the group has before SIGKILL. */
const KILL_GRACE_MS = 250;
const STATUS_MAX_BUFFER = 32 * 1024;
/** The names a status command gets from the environment it was asked from (besides PATH and HOME, set here). */
export const STATUS_ENV_NAMES: readonly string[] = ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

type Env = Readonly<Record<string, string | undefined>>;

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const realOrNull = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };

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

export type StatusTrust = {
  /** The PATH searched, as the environment says it. */
  path: string;
  uid: number | undefined;
  /** Folders an agent can write (real paths taken here): nothing inside them runs. */
  untrusted: readonly string[];
  acl: AclReader | null;
};

export type Resolved = { ok: true; real: string } | { ok: false; missing: true } | { ok: false; missing: false; why: string };

/** The status command's binary: the first match on PATH, and whether it is a trusted install (see the header). */
export function resolveStatusBinary(binary: string, trust: StatusTrust): Resolved {
  const untrusted = trust.untrusted.flatMap(one => { const real = realOrNull(one); return real === null ? [] : [real]; });
  const refused = (why: string): Resolved => ({ ok: false, missing: false, why });
  for (const entry of trust.path.split(delimiter)) {
    if (entry === "") continue;
    const candidate = join(isAbsolute(entry) ? entry : resolve(entry), binary);
    try { accessSync(candidate, constants.X_OK); } catch { continue; }
    // The first match is what the person's shell runs: from here it is trusted or nothing runs.
    if (!isAbsolute(entry)) return refused("it was found through a relative PATH entry");
    if (trust.uid === undefined) return refused("who owns it can't be checked on this system");
    const folder = realOrNull(entry);
    if (folder === null) return refused("its PATH folder can't be read");
    if (untrusted.some(root => inside(folder, root))) return refused("its PATH folder is inside a project or worktree");
    const folders = trustedFolders(folder, trust.uid, trust.acl);
    if (!folders.ok) return refused(folders.why);
    const file = trustedBinary(candidate, trust.uid, trust.acl);
    if (!file.ok) return refused(file.why);
    if (untrusted.some(root => inside(file.real, root))) return refused("it is inside a project or worktree");
    return { ok: true, real: file.real };
  }
  return { ok: false, missing: true };
}

/** The PATH a status command gets: the trusted, absolute folders of `trust.path`, outside every untrusted folder. */
export function trustedPathOf(trust: StatusTrust): string {
  if (trust.uid === undefined) return "";
  const untrusted = trust.untrusted.flatMap(one => { const real = realOrNull(one); return real === null ? [] : [real]; });
  const kept: string[] = [];
  for (const entry of trust.path.split(delimiter)) {
    if (entry === "" || !isAbsolute(entry)) continue;
    const folder = realOrNull(entry);
    if (folder === null || untrusted.some(root => inside(folder, root)) || !trustedFolders(folder, trust.uid, trust.acl).ok) continue;
    if (!kept.includes(folder)) kept.push(folder);
  }
  return kept.join(delimiter);
}

/** The status command's whole environment, built from nothing (see the header). */
export function statusEnvironment(source: Env, home: string, path: string): Record<string, string> {
  const env: Record<string, string> = { PATH: path, HOME: home };
  for (const name of STATUS_ENV_NAMES) { const value = source[name]; if (value !== undefined && value !== "") env[name] = value; }
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

export type StatusProbeOptions = {
  /** Where the PATH and the allowed names come from (this process's environment by default). */
  env?: Env;
  home?: string;
  /** Folders an agent can write, read at each check (projects, worktrees, Toolroll's state folder). The repository
   * this process was started in is always added. */
  untrusted?: () => readonly string[];
  timeoutMs?: number;
  uid?: number;
  acl?: AclReader | null;
};

/**
 * The sign-in checker's probe (provider-connection.ts createConnectionChecker): finds the binary as above, checks it
 * again right before the start, and runs it bounded with its own environment. A binary that isn't there answers "not
 * found"; one that isn't trusted runs nothing and answers what its sign-in check reads as unknown.
 */
export function statusProbe(options: StatusProbeOptions = {}): (file: string, args: readonly string[], runOptions?: RunOptions) => Promise<ExecResult> {
  return async (file, args, runOptions) => {
    const env = options.env ?? process.env;
    const home = options.home ?? env["HOME"] ?? homedir();
    const cwdRepo = repositoryOf(process.cwd());
    const trust: StatusTrust = {
      path: env["PATH"] ?? "", uid: options.uid ?? process.getuid?.(),
      untrusted: [...(options.untrusted?.() ?? []), ...(cwdRepo === null ? [] : [cwdRepo])],
      acl: options.acl === undefined ? rememberedAcl() : options.acl,
    };
    const found = resolveStatusBinary(file, trust);
    if (!found.ok) return found.missing ? { code: 127, stdout: "", stderr: "", timedOut: false, notFound: true } : { code: 126, stdout: "", stderr: "", timedOut: false, notFound: false };
    const childEnv = statusEnvironment(env, home, trustedPathOf(trust));
    // Checked again right before the start: the same real path, still trusted (owner, mode, folders).
    const again = resolveStatusBinary(file, trust);
    if (!again.ok || again.real !== found.real) return { code: 126, stdout: "", stderr: "", timedOut: false, notFound: false };
    const timeoutMs = Math.min(runOptions?.timeoutMs ?? STATUS_TIMEOUT_MS, options.timeoutMs ?? STATUS_TIMEOUT_MS);
    return runBoundedStatus(found.real, args, { env: childEnv, cwd: runOptions?.cwd ?? home, timeoutMs, maxBuffer: Math.min(runOptions?.maxBuffer ?? STATUS_MAX_BUFFER, STATUS_MAX_BUFFER) });
  };
}
