/**
 * How the deployment script runs git on a repository a build can write (the project's Git directory, or the build's
 * checkout): never a fetch (eval-harness review 1, finding 5, and its security scan). Every run takes git's own
 * hardening (no replacement objects, hooks or fsmonitor) and refuses every transport on the command line, the general
 * `protocol.allow` and each named transport's own `protocol.<name>.allow` (a repository's `protocol.file.allow=always`
 * would otherwise outrank the general setting; a command-line value wins over the repository's for the same key). Git
 * 2.45+ also takes `--no-lazy-fetch`. An older git has no such flag (and 2.41.0 ignores GIT_NO_LAZY_FETCH): there, the
 * repository is refused before each command when its own config — read without includes, an include itself refused —
 * names anything that could make a lazy fetch possible or reach a transport (lazyFetchKey).
 */
import { spawnSync } from "node:child_process";

/** Every transport git knows by name, each refused on the command line. */
export const TRANSPORTS = ["file", "git", "ssh", "http", "https", "ext", "fd"];
export const PINNED_PROTOCOLS = ["-c", "protocol.allow=never", ...TRANSPORTS.flatMap(name => ["-c", `protocol.${name}.allow=never`])];
export const SAFE_GIT_BASE = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...PINNED_PROTOCOLS];

/**
 * The key of a `git config --list --no-includes --show-scope -z` listing that makes a lazy fetch or a transport
 * possible on a git without --no-lazy-fetch, or null: an include (whose file this never read), any `protocol.*`,
 * `extensions.partialClone`, a remote's `promisor` (unless plainly false), `partialCloneFilter` or `vcs`. A listing that
 * can't be read names a key (fail closed).
 */
export function lazyFetchKey(listing) {
  if (typeof listing !== "string") return "a config that couldn't be read";
  const fields = listing.split("\0");
  for (let at = 0; at + 1 < fields.length; at += 2) {
    // The repository's own settings; the command line's (this script's pins) are listed too, as scope "command".
    if (fields[at] !== "local" && fields[at] !== "worktree") continue;
    const entry = fields[at + 1];
    const newline = entry.indexOf("\n");
    const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
    const value = newline < 0 ? "true" : entry.slice(newline + 1).trim();
    if (key.startsWith("include.") || key.startsWith("includeif.")) return key;
    if (key.startsWith("protocol.")) return key;
    if (key === "extensions.partialclone") return key;
    if (key.startsWith("remote.")) {
      const variable = key.slice(key.lastIndexOf(".") + 1);
      if (variable === "partialclonefilter" || variable === "vcs") return key;
      if (variable === "promisor" && !/^(false|no|off|0)$/i.test(value)) return key;
    }
  }
  return null;
}

let lazyFlag;
/** Whether the installed git takes --no-lazy-fetch (2.45+), asked once with no system or global config. */
export function lazyFetchFlagSupported(env) {
  if (lazyFlag === undefined) lazyFlag = spawnSync("git", ["--no-lazy-fetch", "version"], { cwd: "/", env, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).status === 0;
  return lazyFlag;
}

/**
 * The arguments for one git command on `repo` (its `-C <dir>` or `--git-dir <dir>`): the hardening, and on git 2.45+
 * `--no-lazy-fetch`; on older git the repository's own config is checked first, and a key lazyFetchKey names refuses
 * the command (throws).
 */
export function safeGitArgs(repo, env, supported = lazyFetchFlagSupported(env)) {
  if (supported) return ["--no-lazy-fetch", ...SAFE_GIT_BASE, ...repo];
  const listed = spawnSync("git", [...SAFE_GIT_BASE, ...repo, "config", "--list", "--no-includes", "--show-scope", "-z"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  const key = listed.status === 0 ? lazyFetchKey(listed.stdout) : "a config that couldn't be read";
  if (key !== null) throw Error(`The repository's git config sets ${key}, which this git (no --no-lazy-fetch) can't read past safely; deploy with git 2.45 or newer, or remove it.`);
  return [...SAFE_GIT_BASE, ...repo];
}
