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
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** Config keys that run a command, bring in unread config, or redirect inspection away from the checked path.
 * `*` is one subsection, any name. */
const COMMAND_KEYS: readonly RegExp[] = [
  "core.sshcommand", "core.gitproxy", "core.askpass", "core.pager", "core.editor", "core.alternaterefscommand",
  "core.worktree", "gpg.ssh.defaultkeycommand", "trailer.*.command", "trailer.*.cmd", "submodule.*.update", "sequence.editor", "diff.external", "credential.helper", "credential.*.helper", "filter.*.clean", "filter.*.smudge", "filter.*.process",
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

/** Refuse nested repositories without asking Git to enter them or evaluate their config.
 * Includes ignored/untracked repositories and bare repositories; never follows symlinks. */
function nestedRepository(path: string): boolean {
  const pending = [path];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const entries = readdirSync(dir, { withFileTypes: true });
    if (dir !== path && (entries.some(entry => entry.name === ".git") ||
      ["HEAD", "objects", "config"].every(name => entries.some(entry => entry.name === name)))) return true;
    for (const entry of entries) if (entry.isDirectory() && entry.name !== ".git") pending.push(join(dir, entry.name));
  }
  return false;
}

/** The one way teardown runs git, including the target checkout immediately before removal. */
export function teardownGit(runner: Runner = run): Git {
  const options = (cwd: string) => ({ cwd, envAllowlist: ENV_ALLOWLIST, env: ENV, timeoutMs: WORKTREE_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });
  const configProblem = async (cwd: string): Promise<ExecResult | null> => {
    const config = await runner("git", ["--no-optional-locks", "config", "--list", "--no-includes", "--show-scope", "-z"], options(cwd));
    if (config.code !== 0) return refused("its config couldn't be read");
    const key = commandSetting(config.stdout);
    return key === null ? null : refused(`the project's git config sets ${key}, which can run a command`);
  };
  return async (cwd, args) => {
    const problem = await configProblem(cwd);
    if (problem !== null) return problem;
    const removal = args[0] === "worktree" && args[1] === "remove";
    const inspection = args.includes("status") || args.includes("diff");
    const target = removal ? resolve(cwd, args.at(-1)!) : cwd;
    if (removal) {
      const targetProblem = await configProblem(target);
      if (targetProblem !== null) return targetProblem;
    }
    if (removal || inspection || args.includes("checkout") || args.includes("clean")) {
      try {
        if (existsSync(target) && nestedRepository(target)) return refused("the checkout contains a nested repository");
      } catch { return refused("the checkout couldn't be inspected for nested repositories"); }
      // ls-files reads index entries only; it cannot run submodule filters. Even an uninitialized
      // gitlink is kept, so worktree remove's internal status can never traverse it.
      const index = await runner("git", [...TEARDOWN_FLAGS, "ls-files", "--stage", "-z"], options(target));
      if (index.code !== 0) return refused("the checkout's index couldn't be read");
      if (index.stdout.split("\0").some(entry => entry.startsWith("160000 "))) return refused("the checkout contains a gitlink");
    }
    const safeArgs = [...args];
    if (inspection && !safeArgs.includes("--ignore-submodules=all")) {
      const command = safeArgs.findIndex(arg => arg === "status" || arg === "diff");
      safeArgs.splice(command + 1, 0, "--ignore-submodules=all");
    }
    return runner("git", [...TEARDOWN_FLAGS, ...safeArgs], options(cwd));
  };
}

/**
 * Git on a build's checkout, as the plane runs it outside every fence (staging, committing and inspecting the build's
 * work): the same fixed hardening as teardown (no hooks, fsmonitor, ext transport, credential helpers or automatic
 * maintenance, no submodule recursion), and refused outright when the checkout's own config (local or worktree scope,
 * read with includes off) names a command — a filter, an external diff, a textconv, a pager — which a build could have
 * planted. The operator's own global configuration (their identity, a git-lfs install) still applies.
 */
export function checkoutGit(inner: Runner = run): Runner {
  return async (file, args, options) => {
    if (file !== "git") return inner(file, args, options);
    const listing = await inner("git", ["--no-optional-locks", "config", "--list", "--no-includes", "--show-scope", "-z"], options);
    if (listing.code !== 0) return refused("its config couldn't be read");
    const key = commandSetting(listing.stdout);
    if (key !== null) return refused(`the checkout's git config sets ${key}, which can run a command`);
    return inner("git", [...TEARDOWN_FLAGS, ...args], options);
  };
}
