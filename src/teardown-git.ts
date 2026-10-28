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
import { inReadOnlyRequest } from "./read-only-request.js";
import { spawnSync } from "node:child_process";
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
/** git-lfs settings that name no program (where it fetches, what, whether it checks locks, how it signs in); any other
 * `lfs.*` key in a checkout's own config could (extensions, custom and standalone transfer agents), so it's refused. */
const INERT_LFS = /^lfs\.(url|pushurl|fetchinclude|fetchexclude|locksverify|repositoryformatversion|.+\.access|.+\.locksverify|setlockablereadonly|skipdownloaderrors|concurrenttransfers)$/;
const lfsCommand = (key: string): boolean => key.startsWith("lfs.") && !INERT_LFS.test(key);

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
    if (key === "core.fsmonitor" ? !BOOLEAN.test(value.trim()) : COMMAND_KEYS.some(pattern => pattern.test(key)) || lfsCommand(key)) return key;
  }
  return null;
}


/**
 * What the plane's git on a build's checkout keeps of the operator's own (global and system) configuration: values,
 * never commands — identity, line endings, ignore and case settings — and git-lfs's filters only as git-lfs itself
 * installs them, exactly. Everything else there (filters, diff drivers, fsmonitor, signing and its key commands,
 * whatever an include brings in) is left out, so nothing in it can run a file of the checkout's.
 */
const CARRIED_VALUES = new Set(["user.name", "user.email", "core.autocrlf", "core.eol", "core.safecrlf", "core.excludesfile", "core.ignorecase",
  "core.precomposeunicode", "core.quotepath", "core.filemode", "core.symlinks", "core.longpaths"]);
const LFS_FILTER: Readonly<Record<string, string>> = {
  "filter.lfs.clean": "git-lfs clean -- %f", "filter.lfs.smudge": "git-lfs smudge -- %f", "filter.lfs.process": "git-lfs filter-process", "filter.lfs.required": "true",
};

/** The `-c` settings that carry the operator's own values (CARRIED_VALUES, LFS_FILTER) from a global/system listing. */
export function carriedSettings(listing: string): string[] {
  const fields = listing.split("\0");
  const carried = new Map<string, string>();
  for (let at = 0; at + 1 < fields.length; at += 2) {
    if (fields[at] !== "global" && fields[at] !== "system") continue;
    const entry = fields[at + 1]!;
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const key = entry.slice(0, newline).toLowerCase();
    const value = entry.slice(newline + 1);
    if (CARRIED_VALUES.has(key) || LFS_FILTER[key] === value) carried.set(key, value);
  }
  return [...carried].flatMap(([key, value]) => ["-c", `${key}=${value}`]);
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
 * maintenance, no submodule recursion, no signing), refused outright when the checkout's own config includes a file
 * or names a command — a filter, an external diff, a textconv, a pager — which a build could have planted. It reads no
 * global or system config: only their values (identity, line endings, a standard git-lfs install) are carried over.
 * It never enters a submodule or nested repository (whose config it never read).
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
      // As git reads a .git file: "gitdir: " then the path, one line; anything else (more lines, stray space) refused.
      const text = (regular(gitdir) ?? "").replace(/\r?\n$/, "");
      if (!text.startsWith("gitdir: ") || /[\r\n]/.test(text)) return true;
      const pointer = text.slice("gitdir: ".length);
      if (pointer === "" || pointer !== pointer.trim()) return true;
      gitdir = resolve(checkout, pointer);
    }
  } catch { return true; }
  const common = (() => { const named = regular(join(gitdir, "commondir"))?.trim(); return named === undefined || named === "" ? gitdir : resolve(gitdir, named); })();
  for (const path of [join(common, "config"), join(gitdir, "config.worktree")]) {
    if (!existsSync(path) && path.endsWith("config.worktree")) continue;
    const text = regular(path);
    if (text === null || /^\s*\[\s*include(if)?\b/im.test(text)) return true;
    // And as git itself parses it, includes not followed (only this one regular file, from a neutral folder, with no
    // other config read): an include git sees by any spelling is refused.
    const parsed = spawnSync("git", ["config", "--file", path, "--no-includes", "--name-only", "--list", "-z"],
      { cwd: "/", encoding: "utf8", timeout: 5_000, env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" } });
    if (parsed.status !== 0 || parsed.stdout.split("\0").some(name => /^(include\.path|includeif\..*\.path)$/i.test(name))) return true;
  }
  return false;
}

/** Whether the checkout's .lfsconfig (read as git parses it, that file only) sets any git-lfs key that could name a
 * program (anything but INERT_LFS). A file that
 * isn't a plain one, or doesn't parse, counts as naming one. */
export function lfsExtensionIn(checkout: string): boolean {
  const path = join(checkout, ".lfsconfig");
  try { if (!lstatSync(path).isFile()) return true; } catch { return false; }
  const parsed = spawnSync("git", ["config", "--file", path, "--no-includes", "--name-only", "--list", "-z"],
    { cwd: "/", encoding: "utf8", timeout: 5_000, env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" } });
  return parsed.status !== 0 || parsed.stdout.split("\0").filter(Boolean).some(name => lfsCommand(name.toLowerCase()) || /^include(if)?\./i.test(name));
}

export function checkoutGit(inner: Runner = run): Runner {
  return async (file, args, options) => {
    if (file !== "git") return inner(file, args, options);
    const cwd = options?.cwd;
    if (cwd === undefined || checkoutIncludes(cwd)) return refused("the checkout's git config includes another file, or couldn't be read as a plain file");
    // git-lfs also reads .lfsconfig from the checkout: one that names an extension (a command it would run) is refused.
    if (lfsExtensionIn(cwd)) return refused("the checkout's .lfsconfig sets a git-lfs key that can run a command");
    // The checkout's own config may name no command.
    const own = await inner("git", ["--no-optional-locks", "config", "--list", "--show-scope", "-z"], options);
    if (own.code !== 0) return refused("its config couldn't be read");
    const key = commandSetting(own.stdout);
    if (key !== null) return refused(`the checkout's git config sets ${key}, which can run a command`);
    // The operator's own config contributes values only (carriedSettings); git then reads no global or system config.
    const carried = carriedSettings(own.stdout);
    const env = { ...(options?.env ?? {}), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    // Never into a submodule or nested repository, whose own config this never read: status and diff skip them.
    const safeArgs = [...args];
    const command = safeArgs.findIndex(arg => arg === "status" || arg === "diff");
    if (command >= 0 && !safeArgs.includes("--ignore-submodules=all")) safeArgs.splice(command + 1, 0, "--ignore-submodules=all");
    return inner("git", [...TEARDOWN_FLAGS, "-c", "diff.ignoreSubmodules=all", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...carried, ...safeArgs], { ...options, env });
  };
}

/**
 * Flags for reading a checkout an agent writes while a page waits (docs/plans/get-side-effects.md). Command-line
 * settings win over anything the checkout's config says, even one changed after it was inspected: no fsmonitor, hooks,
 * pager or credential helper; no network (lazy fetch off, every protocol refused); and attributes read from the empty
 * tree, so no filter or textconv a .gitattributes names can run. A diff also takes --no-ext-diff --no-textconv.
 */
export const PAGE_READ_FLAGS: readonly string[] = [
  "--no-lazy-fetch", "--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "-c", "protocol.allow=never", "-c", "core.pager=cat", "-c", "core.alternateRefsCommand=", "-c", "core.attributesFile=/dev/null",
];
/** The read flags for now: a page visit gets all of PAGE_READ_FLAGS; a person's POST keeps the checkout's attributes
 * (their line-ending and encoding rules, so a clean file reads as clean), with the rest unchanged. */
export function readFlags(): readonly string[] {
  return inReadOnlyRequest() ? PAGE_READ_FLAGS : PAGE_READ_FLAGS.filter(one => !one.startsWith("--attr-source="));
}

/**
 * checkoutGit, synchronously, for reads a page shows from a checkout an agent writes (docs/plans/get-side-effects.md):
 * the same refusals (an include, an .lfsconfig extension, a config key that can run a command), no system or global
 * config, the operator's own values carried, PAGE_READ_FLAGS (which hold even if the config changes after it was read),
 * submodules skipped, bounded. A refusal throws.
 */
export function checkoutGitSync(cwd: string, args: readonly string[], options: { timeoutMs?: number; maxBuffer?: number } = {}): string {
  const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const bounded = { cwd, env, encoding: "utf8" as const, timeout: options.timeoutMs ?? 60_000, maxBuffer: options.maxBuffer ?? 1_048_576, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  if (checkoutIncludes(cwd)) throw new Error("the checkout's git config includes another file, or couldn't be read as a plain file");
  if (lfsExtensionIn(cwd)) throw new Error("the checkout's .lfsconfig sets a git-lfs key that can run a command");
  const own = spawnSync("git", ["--no-optional-locks", "config", "--list", "--show-scope", "-z"], bounded);
  if (own.status !== 0) throw new Error("its config couldn't be read");
  const key = commandSetting(own.stdout);
  if (key !== null) throw new Error(`the checkout's git config sets ${key}, which can run a command`);
  const safeArgs = [...args];
  const command = safeArgs.findIndex(arg => arg === "status" || arg === "diff");
  if (command >= 0 && !safeArgs.includes("--ignore-submodules=all")) safeArgs.splice(command + 1, 0, "--ignore-submodules=all");
  // An external diff program is named by config, which may change after it was read: never used here.
  if (command >= 0 && safeArgs[command] === "diff") safeArgs.splice(command + 1, 0, "--no-ext-diff", "--no-textconv");
  // The operator's own values, but no filter: PAGE_READ_FLAGS reads attributes from the empty tree anyway.
  const carried = carriedSettings(own.stdout).filter((one, at, all) => !(one.startsWith("filter.") || (one === "-c" && all[at + 1]?.startsWith("filter."))));
  const ran = spawnSync("git", [...TEARDOWN_FLAGS, ...readFlags(), "-c", "diff.ignoreSubmodules=all", ...carried, ...safeArgs], bounded);
  if (ran.status !== 0) throw new Error(`git ${args[0] ?? ""} failed`);
  return ran.stdout;
}
