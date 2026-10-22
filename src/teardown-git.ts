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
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * A command-running setting in any scope (the operator's global config, and what it includes) that names anything but
 * a known, safe program with plain arguments (runsCheckoutFiles): `sh filter.sh`, `awk -f x`, `./tools/x` could run the
 * build's own bytes. Null when none.
 */
export function relativeCommandSetting(listing: string): string | null {
  const fields = listing.split("\0");
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const entry = fields[at + 1]!;
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const key = entry.slice(0, newline).toLowerCase();
    // An include names a config file, read relative to the file that includes it: not a command.
    if (key === "include.path" || key.startsWith("includeif.")) continue;
    if (key === "core.fsmonitor" ? BOOLEAN.test(entry.slice(newline + 1).trim()) : !OPERATION_KEYS.some(pattern => pattern.test(key))) continue;
    if (runsCheckoutFiles(entry.slice(newline + 1))) return key;
  }
  return null;
}

/** The command-running settings the plane's add, status, commit and diff can run: filters, diff drivers, fsmonitor,
 * commit signing (credential helpers, pagers, editors and transports aren't run by them here). */
const OPERATION_KEYS: readonly RegExp[] = ["filter.*.clean", "filter.*.smudge", "filter.*.process", "diff.*.command", "diff.*.textconv", "diff.external",
  "core.fsmonitor", "gpg.program", "gpg.*.program", "core.alternaterefscommand"].map(key => new RegExp(`^${key.replace(/\./g, "\\.").replace(/\*/g, ".+")}$`));

/** Programs a command-running git setting may name, whatever its scope: none runs a file it is pointed at as code. */
const SAFE_PROGRAMS = new Set(["git-lfs", "git-crypt", "gpg", "gpg2", "ssh", "ssh-keygen", "less", "more", "cat", "delta", "diff-so-fancy",
  "vim", "nvim", "vi", "nano", "emacs", "code", "cursor", "subl", "zed", "mate", "true", "false",
  "git-credential-osxkeychain", "git-credential-libsecret", "git-credential-manager", "git-credential-manager-core"]);

/**
 * Whether a command-running setting's value could run anything but a known, safe program with plain arguments
 * (an allowlist: a shell, an interpreter, `awk -f`, a quoted or piped command, a relative path all fail it). Its
 * program is the first word, bare or absolute; every word is plain text (no quotes, separators, substitutions or
 * redirections) and none is a relative path.
 */
export function runsCheckoutFiles(value: string): boolean {
  const words = value.trim().replace(/^!/, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  if (!words.every(word => /^[\w%@=:,.+\/~-]+$/.test(word))) return true;
  const program = words[0]!;
  if (!(program.startsWith("/") || !program.includes("/")) || !SAFE_PROGRAMS.has(program.split("/").pop()!)) return true;
  return words.slice(1).some(word => {
    const path = word.replace(/^--?[\w-]+=/, "");
    return path.startsWith("./") || path.startsWith("../") || (path.includes("/") && !path.startsWith("/") && !path.startsWith("~") && !/^[a-z]+:\/\//i.test(path));
  });
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
 * planted. It never enters a submodule or nested repository (whose config it never read). The operator's own global
 * configuration (their identity, a git-lfs install) still applies.
 */
/**
 * Whether a checkout's own git config (its repository's config and its worktree's config.worktree) includes another
 * file, read without git: every git command follows includes as it starts, so an include of the build's could point
 * git at any file, a pipe that never ends among them. Each file is read only as the regular file it is, bounded; one
 * that can't be read so counts as including.
 */
export function checkoutIncludes(checkout: string): boolean {
  const regular = (path: string): string | null => {
    try {
      const held = lstatSync(path);
      if (!held.isFile() || held.size > 1024 * 1024) return null;
      return readFileSync(path, "utf8");
    } catch { return null; }
  };
  let gitdir = join(checkout, ".git");
  try {
    if (!lstatSync(gitdir).isDirectory()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(regular(gitdir) ?? "")?.[1]?.trim();
      if (pointer === undefined) return true;
      gitdir = resolve(checkout, pointer);
    }
  } catch { return true; }
  const common = (() => { const named = regular(join(gitdir, "commondir"))?.trim(); return named === undefined || named === "" ? gitdir : resolve(gitdir, named); })();
  for (const path of [join(common, "config"), join(gitdir, "config.worktree")]) {
    if (!existsSync(path) && path.endsWith("config.worktree")) continue;
    const text = regular(path);
    if (text === null || /^\s*\[\s*include(if)?\b/im.test(text)) return true;
  }
  return false;
}

export function checkoutGit(inner: Runner = run): Runner {
  return async (file, args, options) => {
    if (file !== "git") return inner(file, args, options);
    const cwd = options?.cwd;
    if (cwd === undefined || checkoutIncludes(cwd)) return refused("the checkout's git config includes another file, or couldn't be read as a plain file");
    // Then as written: the checkout's own config may name no command.
    const own = await inner("git", ["--no-optional-locks", "config", "--list", "--no-includes", "--show-scope", "-z"], options);
    if (own.code !== 0) return refused("its config couldn't be read");
    const key = commandSetting(own.stdout);
    if (key !== null) return refused(`the checkout's git config sets ${key}, which can run a command`);
    // Then as git will run (only the operator's own includes are left to follow): what they bring in is judged too.
    const listing = await inner("git", ["--no-optional-locks", "config", "--list", "--includes", "--show-scope", "-z"], options);
    if (listing.code !== 0) return refused("its config couldn't be read");
    const relative = relativeCommandSetting(listing.stdout);
    if (relative !== null) return refused(`git config sets ${relative} to a command that can run the checkout's own files, which the build could have written`);
    // Never into a submodule or nested repository, whose own config this never read: status and diff skip them.
    const safeArgs = [...args];
    const command = safeArgs.findIndex(arg => arg === "status" || arg === "diff");
    if (command >= 0 && !safeArgs.includes("--ignore-submodules=all")) safeArgs.splice(command + 1, 0, "--ignore-submodules=all");
    return inner("git", [...TEARDOWN_FLAGS, "-c", "diff.ignoreSubmodules=all", ...safeArgs], options);
  };
}
