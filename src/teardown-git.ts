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
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/**
 * Config settings that run a command, bring in unread config, or redirect inspection away from the checked path, by
 * their structure (security review of e48e9d8d: a name pattern let `filter..clean`, `[filter ""]` and names with odd
 * characters through). A key is `section[.subsection].variable`: the section is before the first dot, the variable
 * after the last, and the subsection — any bytes at all, empty included — between them. Each family below is refused
 * whatever its subsection is, or whether it has one; section and variable compare case-insensitively, as git reads them.
 * `*` as a variable is every variable of the section.
 */
const COMMAND_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  core: ["sshcommand", "gitproxy", "askpass", "pager", "editor", "alternaterefscommand", "worktree"],
  filter: ["clean", "smudge", "process"],
  diff: ["external", "command", "textconv"],
  merge: ["driver"],
  difftool: ["cmd", "path"],
  mergetool: ["cmd", "path"],
  trailer: ["command", "cmd"],
  submodule: ["update"],
  sequence: ["editor"],
  credential: ["helper"],
  gpg: ["program", "defaultkeycommand"],
  uploadpack: ["packobjectshook"],
  remote: ["uploadpack", "receivepack", "vcs"],
  interactive: ["difffilter"],
  browser: ["cmd", "path"],
  man: ["cmd", "path"],
  pager: ["*"],
  include: ["path"],
  includeif: ["path"],
};

/** A config key's parts as git names them: section and variable lowercased, the subsection as it is (or null). */
function keyParts(key: string): { section: string; subsection: string | null; variable: string } {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0) return { section: key.toLowerCase(), subsection: null, variable: "" };
  return { section: key.slice(0, first).toLowerCase(), subsection: first === last ? null : key.slice(first + 1, last), variable: key.slice(last + 1).toLowerCase() };
}

/** git-lfs settings that name no program (where it fetches, what, whether it checks locks, how it signs in); any other
 * `lfs.*` key in a checkout's own config could (extensions, custom and standalone transfer agents), so it's refused. */
const INERT_LFS_PLAIN = new Set(["url", "pushurl", "fetchinclude", "fetchexclude", "locksverify", "repositoryformatversion", "setlockablereadonly", "skipdownloaderrors", "concurrenttransfers"]);
const INERT_LFS_SUBSECTION = new Set(["access", "locksverify"]);
const lfsCommand = (key: string): boolean => {
  const { section, subsection, variable } = keyParts(key);
  if (section !== "lfs") return false;
  return subsection === null ? !INERT_LFS_PLAIN.has(variable) : !INERT_LFS_SUBSECTION.has(variable);
};

/** core.fsmonitor as a boolean is git's own daemon; anything else is a command to run. */
const BOOLEAN = /^(|true|false|yes|no|on|off|-?\d+)$/i;

/** Whether one setting can run a command (or bring in config nobody read), whatever scope it came from. git-lfs's own
 * filters, exactly as `git lfs install` writes them (LFS_FILTER), are the one filter allowed. */
function runsCommand(key: string, value: string): boolean {
  const { section, subsection, variable } = keyParts(key);
  if (section === "core" && variable === "fsmonitor") return !BOOLEAN.test(value.trim());
  if (section === "filter" && subsection === "lfs" && LFS_FILTER[`filter.lfs.${variable}`] === value) return false;
  const family = COMMAND_FAMILIES[section];
  if (family !== undefined && (family.includes("*") || family.includes(variable))) return true;
  return lfsCommand(key);
}

/** The command-running setting a `git config --list --show-scope -z` listing sets, or null. Only local and worktree
 * scope count: teardown commands never read system or global config. */
export function commandSetting(listing: string): string | null {
  const fields = listing.split("\0");
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const scope = fields[at]!;
    const entry = fields[at + 1]!;
    if (scope !== "local" && scope !== "worktree") continue;
    const newline = entry.indexOf("\n");
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const value = newline < 0 ? "" : entry.slice(newline + 1);
    if (runsCommand(key, value)) return key.toLowerCase();
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

/**
 * Runs `work` with a write view of `cwd`'s repository (gitView): the env to give git, and how to restore its output.
 * From a folder inside a checkout, the view is of the checkout git would find (checkoutRootOf); with none, git's own
 * "not a git repository", nothing run. One whose `.git` or config can't be read as git reads it is refused.
 */
async function inView(cwd: string, work: (env: Record<string, string>, restore: (result: ExecResult, args: readonly string[]) => ExecResult) => Promise<ExecResult>): Promise<ExecResult> {
  const root = checkoutRootOf(cwd);
  if (root === null) return NOT_A_REPOSITORY;
  let view: GitView;
  try { view = gitView(root, "write"); } catch (error) { return refused(error instanceof Error ? error.message : "the checkout couldn't be read"); }
  try {
    return await work(view.env, (result, args) => ({ ...result, stdout: view.restore(result.stdout, args), stderr: view.restore(result.stderr, args) }));
  } finally { view.dispose(); }
}

/** The one way teardown runs git, including the target checkout immediately before removal. Every command runs
 * against a write view of its repository (gitView), whose config is the one inspected and whose info is a copy, so a
 * setting or attributes file an agent adds after the inspection is never read (a build's process can outlive its turn:
 * on macOS containment is observational, src/containment.ts, and a sibling build shares the repository). */
export function teardownGit(runner: Runner = run): Git {
  const options = (cwd: string, env: Record<string, string>) => ({ cwd, envAllowlist: ENV_ALLOWLIST, env: { ...ENV, ...env }, timeoutMs: WORKTREE_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });
  const configProblem = async (cwd: string, env: Record<string, string>): Promise<ExecResult | null> => {
    const config = await runner("git", ["--no-optional-locks", "config", "--list", "--no-includes", "--show-scope", "-z"], options(cwd, env));
    if (config.code !== 0) return refused("its config couldn't be read");
    const key = commandSetting(config.stdout);
    return key === null ? null : refused(`the project's git config sets ${key}, which can run a command`);
  };
  return (cwd, args) => inView(cwd, async (env, restore) => {
    const problem = await configProblem(cwd, env);
    if (problem !== null) return problem;
    const removal = args[0] === "worktree" && args[1] === "remove";
    const inspection = args.includes("status") || args.includes("diff");
    const target = removal ? resolve(cwd, args.at(-1)!) : cwd;
    if (removal || inspection || args.includes("checkout") || args.includes("clean")) {
      const checked = await inView(target, async targetEnv => {
        if (removal) {
          const targetProblem = await configProblem(target, targetEnv);
          if (targetProblem !== null) return targetProblem;
        }
        try {
          if (existsSync(target) && nestedRepository(target)) return refused("the checkout contains a nested repository");
        } catch { return refused("the checkout couldn't be inspected for nested repositories"); }
        // ls-files reads index entries only; it cannot run submodule filters. Even an uninitialized
        // gitlink is kept, so worktree remove's internal status can never traverse it.
        const index = await runner("git", [...TEARDOWN_FLAGS, ...WRITE_VIEW_FLAGS, "ls-files", "--stage", "-z"], options(target, targetEnv));
        if (index.code !== 0) return refused("the checkout's index couldn't be read");
        if (index.stdout.split("\0").some(entry => entry.startsWith("160000 "))) return refused("the checkout contains a gitlink");
        return index;
      });
      if (refusal(checked) !== null) return checked;
      if (checked.code !== 0) return refused("the checkout's index couldn't be read");
    }
    const safeArgs = [...args];
    if (inspection && !safeArgs.includes("--ignore-submodules=all")) {
      const command = safeArgs.findIndex(arg => arg === "status" || arg === "diff");
      safeArgs.splice(command + 1, 0, "--ignore-submodules=all");
    }
    return restore(await runner("git", [...TEARDOWN_FLAGS, ...WRITE_VIEW_FLAGS, ...safeArgs], options(cwd, env)), args);
  });
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
  const dirs = gitDirsOf(checkout);
  if (dirs === null) return true;
  for (const path of [join(dirs.common, "config"), join(dirs.gitdir, "config.worktree")]) {
    if (!existsSync(path) && path.endsWith("config.worktree")) continue;
    if (configIncludes(path)) return true;
  }
  return false;
}

/** One config file, read only as the regular file it is (bounded), or null. */
function regularFile(path: string): string | null {
  try {
    const held = lstatSync(path);
    if (!held.isFile() || held.size > 1024 * 1024) return null;
    return readFileSync(path, "utf8");
  } catch { return null; }
}

/** A checkout's git directory and common directory, as git finds them from its `.git` (a folder, or a one-line
 * `gitdir: ` file); null when the pointer isn't one git would read the same way. */
function gitDirsOf(checkout: string): { gitdir: string; common: string } | null {
  let gitdir = join(checkout, ".git");
  try {
    if (!lstatSync(gitdir).isDirectory()) {
      // As git reads a .git file: "gitdir: " then the path, one line; anything else (more lines, stray space) refused.
      const text = (regularFile(gitdir) ?? "").replace(/\r?\n$/, "");
      if (!text.startsWith("gitdir: ") || /[\r\n]/.test(text)) return null;
      const pointer = text.slice("gitdir: ".length);
      if (pointer === "" || pointer !== pointer.trim()) return null;
      gitdir = resolve(checkout, pointer);
    }
  } catch { return null; }
  const named = regularFile(join(gitdir, "commondir"))?.trim();
  return { gitdir, common: named === undefined || named === "" ? gitdir : resolve(gitdir, named) };
}

/** Whether one config file includes another (or can't be read as a plain file): by a plain reading, and as git itself
 * parses it, includes not followed (only this one regular file, from a neutral folder, with no other config read). */
function configIncludes(path: string): boolean {
  return includeIn(path) !== null;
}

/** The include key one config file sets (lowercased, as git names it), "include" when only a plain reading finds one,
 * or "an unreadable file" when it can't be read as a plain file or parsed; null when it includes nothing. */
function includeIn(path: string): string | null {
  const text = regularFile(path);
  if (text === null) return "an unreadable file";
  const parsed = spawnSync("git", ["config", "--file", path, "--no-includes", "--name-only", "--list", "-z"],
    { cwd: "/", encoding: "utf8", timeout: 5_000, env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" } });
  if (parsed.status !== 0) return "an unreadable file";
  const named = parsed.stdout.split("\0").find(name => /^(include\.path|includeif\..*\.path)$/i.test(name));
  if (named !== undefined) return named.toLowerCase();
  return /^\s*\[\s*include(if)?\b/im.test(text) ? "include" : null;
}

/**
 * A private view of a checkout's repository for one git command on a checkout an agent writes (security review of
 * 0.9.75, and its follow-up for the plane's writes): git reads the repository's config and `info/attributes` from its
 * common directory as it starts, whatever --attr-source says, so an agent that adds a filter to both after the config
 * was inspected would have git run it. The view is a fresh folder of the plane's own, given to git as GIT_COMMON_DIR:
 * a copy of the config as it was read once (with a linked worktree's config.worktree folded in), an `info` holding
 * only copies (a read: `exclude`; a write: `exclude` and `attributes`, frozen, so staging and checkout keep the
 * operator's line-ending and git-lfs rules), and links to everything else. Git then reads no config and no attributes
 * file the agent can still change; GIT_DIR stays the checkout's own (HEAD, index). Its config is inspected, never the
 * checkout's again. Throws when it can't be made.
 *
 * A write through the view lands in the repository itself (git 2.50.1, established by test/attacks/
 * checkout-git-write-toctou.test.ts and the builder's suites): objects, loose refs and reflogs are written inside the
 * linked folders; packed-refs and shallow are rewritten through git's lockfiles, which follow a link to the real file
 * (and take their lock beside it); HEAD, index and a worktree's own files are under GIT_DIR. Names git may create are
 * linked even before they exist (a dangling link git writes through), and `worktrees` is made in the repository first
 * (git can't create a folder under a dangling link). The one thing a command can't change through it is the config:
 * the view's is a copy, so a config write (a branch's section dropped by `branch -D`) stays in the view.
 */
type GitView = { env: Record<string, string>; restore: (output: string, args: readonly string[]) => string; dispose: () => void };
/** What git keeps in a common directory (its path.c common_list, and reftable), linked whether or not it exists yet. */
const COMMON_NAMES = ["branches", "gc.pid", "logs", "lost-found", "modules", "objects", "packed-refs", "reftable", "refs", "remotes", "rr-cache", "shallow", "svn", "worktrees"];
function gitView(checkout: string, kind: "read" | "write"): GitView {
  const dirs = gitDirsOf(checkout);
  if (dirs === null) throw new Error("the checkout's .git couldn't be read as git reads it");
  const view = realpathSync(mkdtempSync(join(tmpdir(), `toolroll-git-${kind}-`)));
  const dispose = () => rmSync(view, { recursive: true, force: true });
  let main = dirs.common;
  try {
    let config = regularFile(join(dirs.common, "config"));
    if (config === null) throw new Error("the checkout's git config couldn't be read as a plain file");
    const configPath = join(view, "config");
    writeFileSync(configPath, config, { mode: 0o600 });
    const plain = { cwd: "/", encoding: "utf8" as const, timeout: 5_000, env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" } };
    if (/worktreeconfig/i.test(config)) {
      const flag = spawnSync("git", ["config", "--file", configPath, "--no-includes", "--type=bool", "--get", "extensions.worktreeConfig"], plain);
      if (flag.status !== 0 && flag.status !== 1) throw new Error("the checkout's git config couldn't be read");
      if (flag.stdout.trim() === "true") {
        // Git would also read the worktree's config.worktree, which the agent can still change: folded in as it is now.
        const worktree = join(dirs.gitdir, "config.worktree");
        const own = existsSync(worktree) ? regularFile(worktree) : "";
        if (own === null) throw new Error("the checkout's config.worktree couldn't be read as a plain file");
        config = `${config}\n${own}`;
        writeFileSync(configPath, config, { mode: 0o600 });
      }
      const unset = spawnSync("git", ["config", "--file", configPath, "--unset-all", "extensions.worktreeConfig"], plain);
      if (unset.status !== 0 && unset.status !== 5) throw new Error("the checkout's git config couldn't be read");
    }
    const include = includeIn(configPath);
    if (include !== null) throw new Error(`the checkout's git config includes another file (${include})`);
    mkdirSync(join(view, "info"));
    for (const name of kind === "write" ? ["exclude", "attributes"] : ["exclude"]) {
      const path = join(dirs.common, "info", name);
      if (!existsSync(path)) continue;
      const text = regularFile(path);
      // A write that dropped the operator's exclude or attributes could stage what they keep out: refused instead.
      if (text === null && kind === "write") throw new Error(`the checkout's info/${name} couldn't be read as a plain file`);
      if (text !== null) writeFileSync(join(view, "info", name), text, { mode: 0o600 });
    }
    if (kind === "write" && !existsSync(join(dirs.common, "worktrees"))) {
      try { mkdirSync(join(dirs.common, "worktrees")); } catch { /* git reports it if it needs the folder */ }
    }
    for (const name of new Set([...readdirSync(dirs.common), ...COMMON_NAMES])) {
      if (name === "config" || name === "info" || name === "hooks") continue;
      symlinkSync(join(dirs.common, name), join(view, name));
    }
    try { main = realpathSync(dirs.common); } catch { /* git names it as found */ }
  } catch (error) { dispose(); throw error; }
  // Where git names the view (rev-parse --git-common-dir), the caller is told the repository's own common directory;
  // where `worktree list` names it as the main worktree, that worktree (git's own rule: the common dir less `/.git`).
  const mainWorktree = main.endsWith("/.git") ? main.slice(0, -"/.git".length) : main;
  const restore = (output: string, args: readonly string[]) => {
    if (!output.includes(view)) return output;
    const asWorktree = args.includes("worktree");
    return output.split(`${view}/`).join(`${dirs.common}/`).split(view).join(asWorktree ? mainWorktree : dirs.common);
  };
  return { env: { GIT_DIR: dirs.gitdir, GIT_COMMON_DIR: view, GIT_WORK_TREE: resolve(checkout) }, restore, dispose };
}

/** The checkout git would find from `cwd`: the nearest folder, `cwd` or above, with a `.git`; null when there is
 * none (git's own "not a git repository"). A `.git` that can't even be looked at counts as found (the view refuses it). */
function checkoutRootOf(cwd: string): string | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    try { lstatSync(join(dir, ".git")); return dir; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") return dir; }
    if (dirname(dir) === dir) return null;
  }
}
const NOT_A_REPOSITORY: ExecResult = { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n", timedOut: false, notFound: false };

/** Settings fixed on every write through a view: `worktree add` records absolute paths (relative ones would need a
 * config write, which a view keeps). */
export const WRITE_VIEW_FLAGS: readonly string[] = ["-c", "worktree.useRelativePaths=false"];

/** Whether the checkout's .lfsconfig (read as git parses it, that file only) sets any git-lfs key that could name a
 * program (anything but INERT_LFS). A file that
 * isn't a plain one, or doesn't parse, counts as naming one. */
export function lfsExtensionIn(checkout: string): boolean {
  const path = join(checkout, ".lfsconfig");
  try { if (!lstatSync(path).isFile()) return true; } catch { return false; }
  const parsed = spawnSync("git", ["config", "--file", path, "--no-includes", "--name-only", "--list", "-z"],
    { cwd: "/", encoding: "utf8", timeout: 5_000, env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" } });
  return parsed.status !== 0 || parsed.stdout.split("\0").filter(Boolean).some(name => lfsCommand(name) || ["include", "includeif"].includes(keyParts(name).section));
}

/** Every command runs against a view of the checkout's repository (gitView) whose config and info are copies the
 * plane made, inspected there, so neither can change between the inspection and the run. `mode` "read" is for reading
 * a checkout an agent may still be writing (the code page): every command also takes readFlags(), and the view holds
 * no info/attributes. "build" is the plane's staging and committing of a build's work, which writes the repository
 * through the view (gitView). */
export function checkoutGit(inner: Runner = run, mode: "build" | "read" = "build"): Runner {
  return async (file, args, options) => {
    if (file !== "git") return inner(file, args, options);
    const cwd = options?.cwd;
    if (cwd === undefined || checkoutIncludes(cwd)) return refused("the checkout's git config includes another file, or couldn't be read as a plain file");
    // git-lfs also reads .lfsconfig from the checkout: one that names an extension (a command it would run) is refused.
    if (lfsExtensionIn(cwd)) return refused("the checkout's .lfsconfig sets a git-lfs key that can run a command");
    let view: GitView;
    try { view = gitView(cwd, mode === "read" ? "read" : "write"); } catch (error) { return refused(error instanceof Error ? error.message : "the checkout couldn't be read"); }
    try {
      const viewed = { ...options, env: { ...(options?.env ?? {}), ...view.env } };
      // The checkout's own config may name no command.
      const own = await inner("git", ["--no-optional-locks", "config", "--list", "--show-scope", "-z"], viewed);
      if (own.code !== 0) return refused("its config couldn't be read");
      const key = commandSetting(own.stdout);
      if (key !== null) return refused(`the checkout's git config sets ${key}, which can run a command`);
      // The operator's own config contributes values only (carriedSettings); git then reads no global or system config.
      // A read carries no filter: it reads attributes from the empty tree anyway.
      const carried = mode === "read" ? withoutFilters(carriedSettings(own.stdout)) : carriedSettings(own.stdout);
      const env = { ...viewed.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
      // Never into a submodule or nested repository, whose own config this never read: status and diff skip them.
      const safeArgs = [...args];
      const command = safeArgs.findIndex(arg => arg === "status" || arg === "diff");
      if (command >= 0 && !safeArgs.includes("--ignore-submodules=all")) safeArgs.splice(command + 1, 0, "--ignore-submodules=all");
      const flags = mode === "read" ? readFlags() : WRITE_VIEW_FLAGS;
      const ran = await inner("git", [...TEARDOWN_FLAGS, ...flags, "-c", "diff.ignoreSubmodules=all", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...carried, ...safeArgs], { ...options, env });
      return { ...ran, stdout: view.restore(ran.stdout, args), stderr: view.restore(ran.stderr, args) };
    } finally { view.dispose(); }
  };
}

const withoutFilters = (carried: readonly string[]): string[] =>
  carried.filter((one, at, all) => !(one.startsWith("filter.") || (one === "-c" && all[at + 1]?.startsWith("filter."))));

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
/** The read flags, for every read of an agent-written checkout, whatever the HTTP method (security review of
 * 01bf3114): the worktree's attributes come from the empty tree. Git still reads the repository's info/attributes and
 * its config as it starts, so the flags alone don't stop a filter planted in both after the inspection: every read
 * also runs against a view of the checkout's repository (gitView; checkoutGitSync, checkoutGit "read"), whose config and info are the plane's. The cost is cosmetic: a checkout's line-ending or encoding rules are not applied, so
 * a file they would normalize can read as changed (fail closed: shipping then asks for a clean commit). */
export function readFlags(): readonly string[] {
  return PAGE_READ_FLAGS;
}

/**
 * checkoutGit, synchronously, for reads a page shows from a checkout an agent writes (docs/plans/get-side-effects.md):
 * the same refusals (an include, an .lfsconfig extension, a config key that can run a command), no system or global
 * config, the operator's own values carried, PAGE_READ_FLAGS and a view of the checkout's repository (gitView: they hold even if its config
 * or info/attributes change after they were read), submodules skipped, bounded. A refusal throws.
 */
export function checkoutGitSync(cwd: string, args: readonly string[], options: { timeoutMs?: number; maxBuffer?: number } = {}): string {
  if (checkoutIncludes(cwd)) throw new Error("the checkout's git config includes another file, or couldn't be read as a plain file");
  if (lfsExtensionIn(cwd)) throw new Error("the checkout's .lfsconfig sets a git-lfs key that can run a command");
  // Its config and info/attributes as read once, in a folder of the plane's own: neither can change before git runs.
  const view = gitView(cwd, "read");
  try {
    const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...view.env };
    const bounded = { cwd, env, encoding: "utf8" as const, timeout: options.timeoutMs ?? 60_000, maxBuffer: options.maxBuffer ?? 1_048_576, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
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
    const carried = withoutFilters(carriedSettings(own.stdout));
    const ran = spawnSync("git", [...TEARDOWN_FLAGS, ...readFlags(), "-c", "diff.ignoreSubmodules=all", ...carried, ...safeArgs], bounded);
    if (ran.status !== 0) throw new Error(`git ${args[0] ?? ""} failed`);
    return view.restore(ran.stdout, args);
  } finally { view.dispose(); }
}

/**
 * checkoutGit ("build": the repository written through its view) for callers that name the repository with a leading
 * `git -C <dir>` instead of a cwd: worktree add and remove in a project's repository, a merge in a checkout of it.
 * The project's repository is shared with every build, which can write its config, info and hooks; nothing here runs
 * what they name. Anything but git goes to `inner` as given.
 */
export function hardenedGit(inner: Runner = run, mode: "build" | "read" = "build"): Runner {
  const hardened = checkoutGit(inner, mode);
  return (file, args, options) => {
    if (file !== "git") return inner(file, args, options);
    let cwd = options?.cwd;
    let rest = [...args];
    while (rest[0] === "-C" && rest.length > 1) { cwd = resolve(cwd ?? process.cwd(), rest[1]!); rest = rest.slice(2); }
    return hardened("git", rest, { ...options, ...(cwd === undefined ? {} : { cwd }) });
  };
}
