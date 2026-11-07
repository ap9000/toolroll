/**
 * The project's main as its recorded remote has it, read by Toolroll's own process. Automatic completion of landed
 * work (landed-cleanup.ts) trusts only this: a build shares the project's .git, so it can move the local main or
 * repoint origin in .git/config, and neither may complete its own task.
 *
 * The remote URL is the one captured on first admission or explicitly supplied by the owner (project-admission.ts), never the repository's
 * config. Each read fetches that URL's main into a fresh, private Git directory under Toolroll's evidence folder (which
 * the agent fence denies to builds), with no system or global config, no includes or URL rewriting, no replace
 * objects, no hooks, no ext or file transport and only an explicit credential helper. The shared repository's objects, refs,
 * replace refs, grafts and shallow state are never read: commits enter only by fetch. A content comparison brings the
 * result's exact recorded commit in by fetch too; git checks every object against its hash.
 *
 * Every doubt fails closed: no recorded remote, a URL that isn't allowed, a failed fetch or a remote without main all
 * read as "not proven", and the task stays for a person.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { run, type ExecResult } from "./exec.js";
import type { BoundedOptions, BoundedResult, BoundedRunner } from "./bounded-spawn.js";
import type { Pin } from "./remote-destination.js";
import type { Store } from "./store.js";
import type { Runner } from "./worktree.js";

/** The ref a fetched remote main is kept under, inside the private directory only. */
const REMOTE_MAIN = "refs/toolroll/remote-main";
const SHA = /^[0-9a-f]{40}$/;
const FETCH_TIMEOUT_MS = 120_000;

/** What the private directory's git may see of this process's environment: nothing that names a repository, an
 * object store or config. The fixed settings below go on top. Teardown git (teardown-git.ts) uses the same. */
export const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSH_AUTH_SOCK", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
export const ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
};
/** The only credential helper https may use: the system keychain on macOS; elsewhere none, so a private https remote
 * fails closed instead of asking. */
export const CREDENTIAL_HELPER = process.platform === "darwin" ? "osxkeychain" : "";

/** Settings for every command in the private directory. The directory's own config is ours and empty. File transport
 * is off for the recorded remote; only the result fetch from the registered project path turns it on. */
function hardened(helper: string, file: "never" | "always" = "never"): string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always",
    "-c", `protocol.file.allow=${file}`, "-c", "protocol.ext.allow=never", "-c", "credential.helper=", ...(helper === "" ? [] : ["-c", `credential.helper=${helper}`]),
    "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.recurseSubmodules=false", "-c", "core.fsmonitor=false",
    // Never to an address the recorded URL doesn't name: a moved repository is a person's choice to record (MOVED).
    "-c", "http.followRedirects=false"];
}

// ---- which URLs ------------------------------------------------------------

export type RemoteUrl = { kind: "network"; url: string };

/**
 * A URL Toolroll may fetch remote main from: https or ssh (either form). Local paths, file URLs and loopback hosts
 * (this machine is where builds run) are always refused. Remote helpers (ext::, fd:: and the like), plain http and
 * git:// (no authentication), relative paths, embedded passwords and anything odd are refused.
 */
export function parseRemoteUrl(url: string): RemoteUrl | { why: string } {
  const refused = { why: "its remote URL isn't one Toolroll fetches from" };
  if (url === "" || url.length > 2048 || /[\x00-\x20\x7f]/.test(url) || url.startsWith("-") || url.includes("\\")) return refused;
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url) || /^file:/i.test(url) || /^[A-Za-z]:[\\/]/.test(url)) return refused;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme !== "https" && scheme !== "ssh") return refused;
    try {
      const parsed = new URL(url);
      if (parsed.password !== "" || (scheme === "https" && parsed.username !== "") || parsed.search !== "" || parsed.hash !== "" || parsed.hostname === "" || loopback(parsed.hostname)) return refused;
    } catch { return refused; }
    return { kind: "network", url };
  }
  // scp-like ssh: [user@]host:path, with no slash before the first colon.
  const colon = url.indexOf(":");
  const host = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+)$/.exec(url.slice(0, colon))?.[1];
  if (colon > 0 && colon < url.length - 1 && host !== undefined && !loopback(host)) return { kind: "network", url };
  return refused;
}

/** localhost (and its subdomains), any IPv4 spelling of 127.0.0.0/8 or 0.0.0.0 (inet_aton accepts 127.1, 0x7f.1 and
 * the like), and ::1, :: or an IPv4-mapped loopback. */
function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const parts = host.split(".");
  if (parts.length <= 4 && parts.every(part => /^(0x[0-9a-f]*|[0-9]+)$/.test(part))) {
    const values = parts.map(part => part.startsWith("0x") ? parseInt(part.slice(2) || "0", 16) : /^0[0-7]+$/.test(part) ? parseInt(part, 8) : Number(part));
    const first = values.length === 1 ? Math.floor(values[0]! / 2 ** 24) : values[0]!;
    return first === 127 || values.every(value => value === 0);
  }
  if (!host.includes(":")) return false;
  try {
    const v6 = new URL(`http://[${host}]/`).hostname;
    return v6 === "[::1]" || v6 === "[::]" || /^\[::ffff:(7f[0-9a-f]{2}:|0:)/.test(v6);
  } catch { return true; }
}

/** Why a recorded URL may not be used as the trusted remote; null when it may. */
export function remoteUrlProblem(url: string): string | null {
  const parsed = parseRemoteUrl(url);
  return "why" in parsed ? parsed.why : null;
}

// ---- reading remote main ---------------------------------------------------

export type RemoteGit = (args: readonly string[]) => Promise<ExecResult>;
export type RemoteMain = {
  url: string;
  /** The private Git directory the read fetched into (plane-owned; gone at `close`). */
  gitDir: string;
  /** The commit the recorded remote's main is at, as fetched just now. */
  main: string;
  /** Git in the private directory, hardened as above. */
  git: RemoteGit;
  /** Bring this exact commit (with its history) from the project by fetch, for a content comparison. */
  bring: (repo: string, head: string) => Promise<boolean>;
};
export type RemoteMainRead = { ok: true; remote: RemoteMain } | { ok: false; why: string; reason?: "moved" };

/** What every reader of a remote main shows when its address redirects. The target is remote-supplied text: it is never
 * shown, stored or followed, and the new remote is never adopted automatically. */
export const REMOTE_MOVED = "The repository moved: its address now redirects. Update the project's remote in Toolroll (Settings → Projects), then try again.";
/** git's words for a refused redirect (http.followRedirects=false), read for the status code alone. */
export function redirected(stderr: string): boolean {
  return /returned error: 30[12378]\b/.test(stderr);
}
const UNREAD = "Toolroll couldn't read the project's remote main";

/**
 * One pass's reads of recorded remotes. Every `read` fetches again (the pre-teardown re-check is never older than
 * the teardown); a project's private directory lasts until `close`, so a fetch after the first only brings what
 * changed. Close removes every directory.
 */
export class RemoteMains {
  private readonly dirs = new Map<string, string>();
  constructor(private readonly store: Store, private readonly runner: Runner = run, private readonly scratch: string,
    private readonly helper: string = CREDENTIAL_HELPER) {}

  private exec(dir: string, args: readonly string[], file: "never" | "always" = "never"): Promise<ExecResult> {
    return this.runner("git", ["--git-dir", dir, ...hardened(this.helper, file), ...args],
      { cwd: dir, envAllowlist: ENV_ALLOWLIST, env: ENV, timeoutMs: FETCH_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });
  }

  /** Nothing but fetched objects decides: a private directory that grew alternates, grafts or shallow state is
   * not trusted. */
  private clean(dir: string): boolean {
    return !["shallow", join("info", "grafts"), join("objects", "info", "alternates"), join("objects", "info", "http-alternates")].some(name => existsSync(join(dir, name)));
  }

  private async dirFor(repo: string): Promise<string | null> {
    const known = this.dirs.get(repo);
    if (known !== undefined && existsSync(known)) return known;
    try {
      mkdirSync(this.scratch, { recursive: true });
      const dir = mkdtempSync(join(this.scratch, ".remote-main-"));
      this.dirs.set(repo, dir);
      const made = await this.runner("git", ["init", "--quiet", "--bare", "--template=", dir],
        { cwd: dir, envAllowlist: ENV_ALLOWLIST, env: ENV, timeoutMs: 30_000 });
      return made.code === 0 ? dir : null;
    } catch { return null; }
  }

  async read(repo: string): Promise<RemoteMainRead> {
    const url = this.store.projectRemote(repo);
    if (url === null) return { ok: false, why: "the project has no recorded remote" };
    const problem = remoteUrlProblem(url);
    if (problem !== null) return { ok: false, why: problem };
    const dir = await this.dirFor(repo);
    if (dir === null) return { ok: false, why: UNREAD };
    const fetched = await this.exec(dir, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", url, `+refs/heads/main:${REMOTE_MAIN}`]);
    if (fetched.code !== 0 && redirected(fetched.stderr)) return { ok: false, why: REMOTE_MOVED, reason: "moved" };
    if (fetched.code !== 0 || !this.clean(dir)) return { ok: false, why: UNREAD };
    const resolved = await this.exec(dir, ["rev-parse", "--verify", "--quiet", `${REMOTE_MAIN}^{commit}`]);
    const main = resolved.stdout.trim();
    if (resolved.code !== 0 || !SHA.test(main)) return { ok: false, why: UNREAD };
    const git: RemoteGit = args => this.exec(dir, args);
    const bring = async (from: string, head: string): Promise<boolean> => {
      if (!SHA.test(head)) return false;
      if ((await git(["cat-file", "-e", `${head}^{commit}`])).code === 0) return true;
      // The one local fetch: from the project path Toolroll registered (never a URL), for this exact hash-checked commit.
      if (!isAbsolute(from)) return false;
      const got = await this.exec(dir, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", from, `+${head}:refs/toolroll/results/${head}`], "always");
      return got.code === 0 && this.clean(dir) && (await git(["cat-file", "-e", `${head}^{commit}`])).code === 0;
    };
    return { ok: true, remote: { url, gitDir: dir, main, git, bring } };
  }

  close(): void {
    for (const dir of this.dirs.values()) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* the next pass makes its own */ } }
    this.dirs.clear();
  }
}

// ---- the code map's own read: pinned, depth 1, bounded (docs/plans/code-map.md §1) ---------------------------------

const MAP_MAIN = "refs/toolroll/map-main";
/** What keeps git's own memory down. index-pack still materializes delta bases, so these reduce; they don't bound. */
const LOW_MEMORY = ["-c", "pack.threads=1", "-c", "core.deltaBaseCacheLimit=32m", "-c", "core.bigFileThreshold=1m"];
export const MAP_FETCH_LIMITS = { timeoutMs: 120_000, memoryBytes: 1024 ** 3, diskBytes: 1024 ** 3, fileBytes: 512 * 1024 ** 2, maxStderr: 64 * 1024 } as const;

export type MapGitOptions = { helper?: string; extra?: readonly string[] };
/** Git in a private directory under the map's rules: the same hardening as `RemoteMains`, plus the pin. */
export function mapGitArgs(dir: string, pin: Pin, args: readonly string[], options: MapGitOptions = {}): string[] {
  return ["--git-dir", dir, ...hardened(options.helper ?? CREDENTIAL_HELPER), ...pin.gitArgs, ...(options.extra ?? []), ...args];
}
/** The environment for it: exactly the allowed names, the fixed settings, and the pin's. */
export function mapGitEnv(pin: Pin, from: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) { const value = from[name]; if (value !== undefined) env[name] = value; }
  return { ...env, ...ENV, ...pin.env };
}
export function initPrivateDir(dir: string, bounded: BoundedRunner): Promise<BoundedResult> {
  return bounded("git", ["init", "--quiet", "--bare", "--template=", dir], { cwd: dir, env: mapGitEnv({ gitArgs: [], env: {}, proxy: null }), timeoutMs: 30_000, maxStdout: 4096, maxStderr: 4096, label: "code-map-init" });
}

export type MapPeek = { ok: true; commit: string | null } | { ok: false; why: string; reason?: "moved" };
/** The commit the recorded remote's main is at, without fetching: null when the remote has no `main`. */
export async function peekMain(url: string, dir: string, pin: Pin, bounded: BoundedRunner, helper?: string): Promise<MapPeek> {
  const ran = await bounded("git", mapGitArgs(dir, pin, ["ls-remote", "--", url, "refs/heads/main"], helper === undefined ? {} : { helper }),
    { cwd: dir, env: mapGitEnv(pin), timeoutMs: 30_000, maxStdout: 64 * 1024, maxStderr: MAP_FETCH_LIMITS.maxStderr, label: "code-map-peek" });
  if (ran.code !== 0 && redirected(ran.stderr)) return { ok: false, why: REMOTE_MOVED, reason: "moved" };
  if (ran.code !== 0 || ran.killed !== null) return { ok: false, why: UNREAD };
  const line = ran.stdout.toString("utf8").split("\n").find(one => one.endsWith("\trefs/heads/main"));
  if (line === undefined) return ran.stdout.length === 0 ? { ok: true, commit: null } : { ok: false, why: UNREAD };
  const commit = line.slice(0, line.indexOf("\t"));
  return SHA.test(commit) ? { ok: true, commit } : { ok: false, why: UNREAD };
}

/** A depth-1 private folder is clean when it holds only what the fetch made: a `shallow` file naming exactly the fetched
 * commit, and no grafts or alternates. */
export function shallowClean(dir: string, commit: string): boolean {
  if ([join("info", "grafts"), join("objects", "info", "alternates"), join("objects", "info", "http-alternates")].some(name => existsSync(join(dir, name)))) return false;
  try {
    const held = lstatSync(join(dir, "shallow"));
    if (!held.isFile() || held.size > 128) return false;
    return readFileSync(join(dir, "shallow"), "utf8").trim() === commit;
  } catch (error) {
    // A history of one commit needs no shallow boundary, and git writes none.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export type MapFetch = { ok: true; commit: string; enforced: "system" | "checked" } | { ok: false; why: string; reason?: "moved" };
/** Fetch main at depth 1 into `dir`, under the map's limits. `onStart` records the spawn for crash cleanup. */
export async function readShallowMain(url: string, dir: string, pin: Pin, bounded: BoundedRunner, onStart?: BoundedOptions["onStart"], helper?: string): Promise<MapFetch> {
  const fetched = await bounded("git", mapGitArgs(dir, pin, ["fetch", "--quiet", "--depth=1", "--no-tags", "--no-write-fetch-head", "--", url, `+refs/heads/main:${MAP_MAIN}`], { extra: LOW_MEMORY, ...(helper === undefined ? {} : { helper }) }),
    { cwd: dir, env: mapGitEnv(pin), timeoutMs: MAP_FETCH_LIMITS.timeoutMs, maxStdout: 4096, maxStderr: MAP_FETCH_LIMITS.maxStderr, memoryBytes: MAP_FETCH_LIMITS.memoryBytes,
      diskBytes: MAP_FETCH_LIMITS.diskBytes, fileBytes: MAP_FETCH_LIMITS.fileBytes, folder: dir, label: "code-map-fetch", ...(onStart === undefined ? {} : { onStart }) });
  if (fetched.code !== 0 && redirected(fetched.stderr)) return { ok: false, why: REMOTE_MOVED, reason: "moved" };
  if (fetched.killed !== null) return { ok: false, why: `the fetch went past its ${fetched.killed} limit` };
  if (fetched.code !== 0) return { ok: false, why: UNREAD };
  const resolved = await bounded("git", mapGitArgs(dir, pin, ["rev-parse", "--verify", "--quiet", `${MAP_MAIN}^{commit}`]), { cwd: dir, env: mapGitEnv(pin), timeoutMs: 30_000, maxStdout: 4096, maxStderr: 4096, label: "code-map-rev" });
  const commit = resolved.stdout.toString("utf8").trim();
  if (resolved.code !== 0 || !SHA.test(commit) || !shallowClean(dir, commit)) return { ok: false, why: UNREAD };
  return { ok: true, commit, enforced: fetched.enforced };
}
