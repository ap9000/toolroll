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
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { run, type ExecResult } from "./exec.js";
import type { Store } from "./store.js";
import type { Runner } from "./worktree.js";

/** The ref a fetched remote main is kept under, inside the private directory only. */
const REMOTE_MAIN = "refs/toolroll/remote-main";
const SHA = /^[0-9a-f]{40}$/;
const FETCH_TIMEOUT_MS = 120_000;

/** What the private directory's git may see of this process's environment: nothing that names a repository, an
 * object store or config. The fixed settings below go on top. */
const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSH_AUTH_SOCK", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
const ENV: Record<string, string> = {
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
    "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.recurseSubmodules=false", "-c", "core.fsmonitor=false"];
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
  /** The commit the recorded remote's main is at, as fetched just now. */
  main: string;
  /** Git in the private directory, hardened as above. */
  git: RemoteGit;
  /** Bring this exact commit (with its history) from the project by fetch, for a content comparison. */
  bring: (repo: string, head: string) => Promise<boolean>;
};
export type RemoteMainRead = { ok: true; remote: RemoteMain } | { ok: false; why: string };

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
    if (dir === null) return { ok: false, why: "Toolroll couldn't read the project's remote main" };
    const fetched = await this.exec(dir, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", url, `+refs/heads/main:${REMOTE_MAIN}`]);
    if (fetched.code !== 0 || !this.clean(dir)) return { ok: false, why: "Toolroll couldn't read the project's remote main" };
    const resolved = await this.exec(dir, ["rev-parse", "--verify", "--quiet", `${REMOTE_MAIN}^{commit}`]);
    const main = resolved.stdout.trim();
    if (resolved.code !== 0 || !SHA.test(main)) return { ok: false, why: "Toolroll couldn't read the project's remote main" };
    const git: RemoteGit = args => this.exec(dir, args);
    const bring = async (from: string, head: string): Promise<boolean> => {
      if (!SHA.test(head)) return false;
      if ((await git(["cat-file", "-e", `${head}^{commit}`])).code === 0) return true;
      // The one local fetch: from the project path Toolroll registered (never a URL), for this exact hash-checked commit.
      if (!isAbsolute(from)) return false;
      const got = await this.exec(dir, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", from, `+${head}:refs/toolroll/results/${head}`], "always");
      return got.code === 0 && this.clean(dir) && (await git(["cat-file", "-e", `${head}^{commit}`])).code === 0;
    };
    return { ok: true, remote: { url, main, git, bring } };
  }

  close(): void {
    for (const dir of this.dirs.values()) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* the next pass makes its own */ } }
    this.dirs.clear();
  }
}
