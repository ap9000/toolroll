/**
 * Git for teardown (landed-cleanup.ts and the checkout removal it drives in worktree.ts), run by Toolroll's own
 * process inside the shared repository a build can write to. A build can plant hooks in .git/hooks and settings in
 * .git/config (or a worktree's config.worktree), so every teardown command runs hardened: an allowlisted environment
 * with no system or global config (remote-main.ts's), no hooks, no fsmonitor, no ext transport, no prompts and no
 * automatic maintenance.
 *
 * Settings that name a command, and includes (which could bring them in from a file nobody looked at), are not
 * overridden but refused: before each command the repository's own config is read with includes off, and if it sets
 * any of them the command never runs. The refusal is a failed git result, so every caller's existing doubt applies and
 * nothing is removed.
 */
import { run, type ExecResult } from "./exec.js";
import { ENV, ENV_ALLOWLIST } from "./remote-main.js";
import { WORKTREE_TIMEOUT_MS, type Runner } from "./worktree.js";

export type Git = (cwd: string, args: readonly string[]) => Promise<ExecResult>;

/** Fixed on every teardown command, ahead of its own arguments. */
export const TEARDOWN_FLAGS: readonly string[] = [
  "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never",
  "-c", "credential.helper=", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "submodule.recurse=false",
];

/** Exit code of a refused command (git's own fatal code, so no caller reads it as "not found" or "no"). */
export const REFUSED_CODE = 128;
const REFUSED_PREFIX = "Toolroll won't run git here: ";

/** Config keys that run a command, or bring in config unread. `*` is one subsection, any name. */
const COMMAND_KEYS: readonly RegExp[] = [
  "core.sshcommand", "core.gitproxy", "core.askpass", "core.pager", "core.editor", "core.alternaterefscommand",
  "sequence.editor", "diff.external", "credential.helper", "credential.*.helper", "filter.*.clean", "filter.*.smudge", "filter.*.process",
  "diff.*.command", "diff.*.textconv", "merge.*.driver", "gpg.program", "gpg.*.program", "uploadpack.packobjectshook",
  "remote.*.uploadpack", "remote.*.receivepack", "remote.*.vcs", "pager.*", "include.path", "includeif.*.path",
].map(key => new RegExp(`^${key.replace(/\./g, "\\.").replace(/\*/g, ".+")}$`));
/** core.fsmonitor as a boolean is git's own daemon; anything else is a command to run. */
const BOOLEAN = /^(|true|false|yes|no|on|off|-?\d+)$/i;

/** The command-running setting a `git config --list --show-scope -z` listing sets, or null. Only local and worktree
 * scope count: teardown commands never read system or global config. */
export function commandSetting(listing: string): string | null {
  const fields = listing.split("\0");
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const scope = fields[at]!;
    const entry = fields[at + 1]!;
    if (scope !== "local" && scope !== "worktree") continue;
    const newline = entry.indexOf("\n");
    const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
    const value = newline < 0 ? "" : entry.slice(newline + 1);
    if (key === "core.fsmonitor" ? !BOOLEAN.test(value.trim()) : COMMAND_KEYS.some(pattern => pattern.test(key))) return key;
  }
  return null;
}

/** Why a teardown command was refused, or null when `result` isn't a refusal. */
export function refusal(result: ExecResult): string | null {
  return result.code === REFUSED_CODE && result.stderr.startsWith(REFUSED_PREFIX) ? result.stderr.slice(REFUSED_PREFIX.length).trim() : null;
}

const refused = (why: string): ExecResult => ({ code: REFUSED_CODE, stdout: "", stderr: `${REFUSED_PREFIX}${why}\n`, timedOut: false, notFound: false });

/** The one way teardown runs git: each command checks the repository's config where it runs, then runs hardened. */
export function teardownGit(runner: Runner = run): Git {
  const options = (cwd: string) => ({ cwd, envAllowlist: ENV_ALLOWLIST, env: ENV, timeoutMs: WORKTREE_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });
  return async (cwd, args) => {
    const config = await runner("git", ["--no-optional-locks", "config", "--list", "--no-includes", "--show-scope", "-z"], options(cwd));
    if (config.code !== 0) return refused("its config couldn't be read");
    const key = commandSetting(config.stdout);
    if (key !== null) return refused(`the project's git config sets ${key}, which can run a command`);
    return runner("git", [...TEARDOWN_FLAGS, ...args], options(cwd));
  };
}
