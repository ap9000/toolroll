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
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { ensureGitViewsRoot, withCheckoutLock } from "./git-views.js";
import { gitIncident, type GitIncident } from "./git-incident.js";
import { basename, dirname, join, resolve } from "node:path";
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
 * Which repository config the plane's git accepts: deny by default (security scans of the round-2 fixes). A key is
 * `section[.subsection].variable`: the section is before the first dot, the variable after the last, and the
 * subsection — any bytes at all, empty included — between them; section and variable compare case-insensitively, as
 * git reads them, and every rule holds whatever the subsection is (Codex review of e48e9d8d: `filter..clean`).
 *
 * A section must be known (KNOWN_SECTIONS). A known section is wholly inert ("any"), inert but for named variables
 * (`deny`), or inert only for named variables (`allow`: any other variable in it, known or not, is refused). Unknown
 * sections are refused, whatever git version runs: the audit covers git 2.50.1's git-config(1) (and the keys our own
 * product and git-lfs set), and a newer git's new keys land in a section this list doesn't know, or a variable an
 * `allow` list doesn't name, and are refused until audited. test/attacks/checkout-git-config-audit.test.ts holds the
 * table (aliases, URL rewrites, protocol policy, hooks by config, trace targets, tar filters, every program key).
 */
type SectionRule = "any" | { deny: readonly string[] } | { allow: readonly string[] };
const KNOWN_SECTIONS: ReadonlyMap<string, SectionRule> = new Map<string, SectionRule>(Object.entries({
  core: { allow: ["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode", "autocrlf", "eol", "safecrlf",
    "symlinks", "hookspath", "fsmonitor", "excludesfile", "attributesfile", "quotepath", "longpaths", "untrackedcache", "sharedrepository", "compression",
    "loosecompression", "bigfilethreshold", "preloadindex", "checkstat", "trustctime", "abbrev", "commentchar", "commentstring", "whitespace", "fscache",
    "packedgitlimit", "packedgitwindowsize", "deltabasecachelimit", "multipackindex", "commitgraph", "splitindex", "warnambiguousrefs", "notesref",
    "sparsecheckout", "sparsecheckoutcone", "filesreflocktimeout", "packedrefstimeout", "usereplacerefs", "fsync", "fsyncmethod", "fsyncobjectfiles",
    "checkroundtripencoding", "protecthfs", "protectntfs", "logallrefupdates", "restrictinheritedhandles", "maxtreedepth", "createobject"] },
  // A remote: never its helper programs; its URLs are checked apart (helperUrl).
  remote: { allow: ["url", "pushurl", "fetch", "push", "mirror", "tagopt", "prune", "prunetags", "promisor", "partialclonefilter", "skipdefaultupdate",
    "skipfetchall", "followremotehead", "serveroption", "proxy", "proxyauthmethod"] },
  branch: "any", user: "any", init: "any", pull: "any", push: "any", fetch: "any", status: "any", color: "any", advice: "any", extensions: "any",
  worktree: "any", index: "any", pack: "any", feature: "any", rerere: "any", tag: "any", log: "any", format: "any", i18n: "any", safe: "any",
  blame: "any", column: "any", grep: "any", apply: "any", rebase: "any", help: "any", versionsort: "any", checkout: "any", clean: "any",
  notes: "any", splitindex: "any", transfer: "any", fsck: "any", receive: "any", repack: "any", maintenance: "any", mailmap: "any", am: "any",
  reset: "any", stash: "any", commit: "any", http: "any",
  merge: { allow: ["conflictstyle", "ff", "log", "renormalize", "stat", "autostash", "defaulttoupstream", "renamelimit", "renames", "directoryrenames",
    "verifysignatures", "tool", "guitool", "branchdesc", "suppressdest", "name", "recursive"] },
  diff: { allow: ["algorithm", "renames", "renamelimit", "noprefix", "mnemonicprefix", "context", "interhunkcontext", "colormoved", "colormovedws",
    "indentheuristic", "statgraphwidth", "statnamewidth", "submodule", "ignoresubmodules", "orderfile", "tool", "guitool", "wserrorhighlight", "relative",
    "dirstat", "suppressblankempty", "autorefreshindex", "srcprefix", "dstprefix", "xfuncname", "funcname", "binary", "cachetextconv", "wordregex"] },
  submodule: { deny: ["update"] },
  gc: { deny: ["recentobjectshook"] },
  uploadpack: { deny: ["packobjectshook"] },
  // git-lfs's own: lfsCommand decides (inert keys only); filter: git-lfs's exact values only (runsCommand).
  lfs: "any",
  ssh: { allow: ["variant"] },
}));
/** A remote URL git hands to a remote helper: `<helper>::…`, or a scheme git has no transport of its own for (it runs
 * git-remote-<scheme>). scp-like `host:path`, `user@host:path` and plain paths are git's own. */
const OWN_SCHEMES = new Set(["https", "http", "ssh", "git", "file", "git+ssh", "ssh+git"]);
function helperUrl(value: string): boolean {
  const url = value.trim();
  if (url.includes("::")) return true;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  return scheme !== null && !OWN_SCHEMES.has(scheme[1]!.toLowerCase());
}

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
 * filters, exactly as `git lfs install` writes them (LFS_FILTER), are the one filter allowed, and only where the caller
 * has also refused a `.lfsconfig` naming a git-lfs extension (`lfsChecked`): git-lfs reads that file as it runs. */
function runsCommand(key: string, value: string, lfsChecked: boolean): boolean {
  const { section, subsection, variable } = keyParts(key);
  if (section === "core" && variable === "fsmonitor") return !BOOLEAN.test(value.trim());
  // A filter: whether it is required names no program; its commands only git-lfs's own, exactly, beside a checked
  // .lfsconfig.
  if (section === "filter") return !((variable === "required" && BOOLEAN.test(value.trim())) || (lfsChecked && subsection === "lfs" && LFS_FILTER.get(`filter.lfs.${variable}`) === value));
  if (section === "lfs") return lfsCommand(key);
  if (section === "remote" && (variable === "url" || variable === "pushurl") && helperUrl(value)) return true;
  const rule = KNOWN_SECTIONS.get(section);
  if (rule === undefined) return true;
  if (rule === "any") return false;
  if ("deny" in rule) return rule.deny.includes(variable);
  return !rule.allow.includes(variable);
}

/** The command-running setting a `git config --list --show-scope -z` listing sets, or null. Only local and worktree
 * scope count: teardown commands never read system or global config. `lfsChecked`: the caller refuses a checkout whose
 * `.lfsconfig` names a git-lfs extension (lfsExtensionIn), so git-lfs's own exact filters may stand (runsCommand).
 * Fails closed: a listing that can't be classified names a setting. */
export function commandSetting(listing: string, options: { lfsChecked?: boolean } = {}): string | null {
  try {
    const fields = listing.split("\0");
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const scope = fields[at]!;
      const entry = fields[at + 1]!;
      if (scope !== "local" && scope !== "worktree") continue;
      const newline = entry.indexOf("\n");
      const key = newline < 0 ? entry : entry.slice(0, newline);
      const value = newline < 0 ? "" : entry.slice(newline + 1);
      if (runsCommand(key, value, options.lfsChecked === true)) return key.toLowerCase();
    }
    return null;
  } catch { return "a setting that couldn't be read"; }
}


/**
 * What the plane's git on a build's checkout keeps of the operator's own (global and system) configuration: values,
 * never commands — identity, line endings, ignore and case settings — and git-lfs's filters only as git-lfs itself
 * installs them, exactly. Everything else there (filters, diff drivers, fsmonitor, signing and its key commands,
 * whatever an include brings in) is left out, so nothing in it can run a file of the checkout's.
 */
const CARRIED_VALUES = new Set(["user.name", "user.email", "core.autocrlf", "core.eol", "core.safecrlf", "core.excludesfile", "core.ignorecase",
  "core.precomposeunicode", "core.quotepath", "core.filemode", "core.symlinks", "core.longpaths"]);
const LFS_FILTER: ReadonlyMap<string, string> = new Map(Object.entries({
  "filter.lfs.clean": "git-lfs clean -- %f", "filter.lfs.smudge": "git-lfs smudge -- %f", "filter.lfs.process": "git-lfs filter-process", "filter.lfs.required": "true",
}));

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
    if (CARRIED_VALUES.has(key) || LFS_FILTER.get(key) === value) carried.set(key, value);
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
 * Runs `work` with a write view of `cwd`'s repository (gitView): the view, and how to restore git's output. From a
 * folder inside a checkout, the view is of the checkout git would find (checkoutRootOf); with none, git's own "not a
 * git repository", nothing run. One whose `.git` or config can't be read as git reads it, or isn't bound to one
 * repository (boundDirs; `binding.repo` when the caller has the project's), is refused; so is a command whose
 * repository changed under it while git ran.
 */
async function inView(cwd: string, binding: GitBinding, work: (view: GitView, restore: (result: ExecResult, args: readonly string[]) => ExecResult) => Promise<ExecResult>, after = true): Promise<ExecResult> {
  const root = checkoutRootOf(cwd);
  if (root === null) return NOT_A_REPOSITORY;
  // One plane git command at a time on a checkout (git-views.ts withCheckoutLock: re-entrant along one call chain).
  let key: string;
  try { key = realpathSync(root); } catch { return refused("the checkout couldn't be found"); }
  try {
    return await withCheckoutLock(realpathSync(homedir()), key, async () => {
      let view: GitView;
      try { view = gitView(root, "write", binding); } catch (error) { return refused(error instanceof Error ? error.message : "the checkout couldn't be read"); }
      try {
        const result = await work(view, (result, args) => ({ ...result, stdout: view.restore(result.stdout, args), stderr: view.restore(result.stderr, args) }));
        if (!after) return result;
        const why = view.settle();
        return why === null ? result : refused(why);
      } finally { view.dispose(); }
    });
  } catch (error) { return refused(error instanceof Error ? error.message : "the checkout is busy"); }
}

/** The one way teardown runs git, including the target checkout immediately before removal. Every command runs
 * against a write view of its repository (gitView), whose config is the one inspected and whose info is a copy, so a
 * setting or attributes file an agent adds after the inspection is never read (a build's process can outlive its turn:
 * on macOS containment is observational, src/containment.ts, and a sibling build shares the repository). A removal's
 * target is bound to the same repository as the folder it is removed from. A removal without --force runs under the
 * target's own view (its own config.worktree folded in), so git's last check of whether it is clean reads it as the
 * target itself would. `binding.repo`: the project's main checkout, from the plane's records, when the caller has it. */
export function teardownGit(runner: Runner = run, binding: GitBinding = {}): Git {
  const options = (cwd: string, env: Record<string, string>) => ({ cwd, envAllowlist: ENV_ALLOWLIST, env: { ...ENV, ...env }, timeoutMs: WORKTREE_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });
  const configProblem = async (cwd: string, env: Record<string, string>): Promise<ExecResult | null> => {
    // git-lfs's own filters may stand only beside a .lfsconfig that names no extension (commandSetting's lfsChecked).
    if (lfsExtensionIn(env["GIT_WORK_TREE"] ?? cwd)) return refused("the checkout's .lfsconfig sets a git-lfs key that can run a command");
    const config = await runner("git", ["--no-optional-locks", "config", "--list", "--no-includes", "--show-scope", "-z"], options(cwd, env));
    if (config.code !== 0) return refused("its config couldn't be read");
    const key = commandSetting(config.stdout, { lfsChecked: true });
    return key === null ? null : refused(`the project's git config sets ${key}, which can run a command`);
  };
  return (cwd, args) => inView(cwd, binding, async (view, restore) => {
    const problem = await configProblem(cwd, view.env);
    if (problem !== null) return problem;
    const removal = args[0] === "worktree" && args[1] === "remove";
    const forced = removal && args.includes("--force");
    const inspection = args.includes("status") || args.includes("diff");
    const target = removal ? resolve(cwd, args.at(-1)!) : cwd;
    const safeArgs = [...args];
    if (inspection && !safeArgs.includes("--ignore-submodules=all")) {
      const command = safeArgs.findIndex(arg => arg === "status" || arg === "diff");
      safeArgs.splice(command + 1, 0, "--ignore-submodules=all");
    }
    const ran = async (env: Record<string, string>) => restore(await runner("git", [...TEARDOWN_FLAGS, ...WRITE_VIEW_FLAGS, ...safeArgs], options(cwd, env)), args);
    if (!(removal || inspection || args.includes("checkout") || args.includes("clean"))) return ran(view.env);
    // The checkout the command acts on, in its own view (bound to the same repository), checked first.
    return inView(target, { repo: binding.repo ?? dirname(view.dirs.common) }, async targetView => {
      if (removal) {
        const targetProblem = await configProblem(target, targetView.env);
        if (targetProblem !== null) return targetProblem;
      }
      try {
        if (existsSync(target) && nestedRepository(target)) return refused("the checkout contains a nested repository");
      } catch { return refused("the checkout couldn't be inspected for nested repositories"); }
      // ls-files reads index entries only; it cannot run submodule filters. Even an uninitialized
      // gitlink is kept, so worktree remove's internal status can never traverse it.
      const index = await runner("git", [...TEARDOWN_FLAGS, ...WRITE_VIEW_FLAGS, "ls-files", "--stage", "-z"], options(target, targetView.env));
      if (index.code !== 0) return refused("the checkout's index couldn't be read");
      if (index.stdout.split("\0").some(entry => entry.startsWith("160000 "))) return refused("the checkout contains a gitlink");
      // git's own clean check in a removal (a `status` it runs in the target) reads the config GIT_COMMON_DIR names:
      // the target's view, inspected above, so it judges the target by the target's own settings.
      return ran(removal && !forced ? { ...view.env, GIT_COMMON_DIR: targetView.env["GIT_COMMON_DIR"]! } : view.env);
      // A removed target has no git directory left to prove: the folder it was removed from is proven instead.
    }, !removal);
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
export function checkoutIncludes(checkout: string, gitFile = "git"): boolean {
  const dirs = gitDirsOf(checkout);
  if (dirs === null) return true;
  for (const path of [join(dirs.common, "config"), join(dirs.gitdir, "config.worktree")]) {
    if (!existsSync(path) && path.endsWith("config.worktree")) continue;
    if (includeIn(path, gitFile) !== null) return true;
  }
  return false;
}

/** One config file, read only as the regular file it is (bounded), or null. */
function regularFile(path: string): string | null {
  // Opened without following a link and without blocking, then judged by what was opened: a FIFO swapped in after a
  // look never hangs the read (eval-harness review 1, finding 7).
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const held = fstatSync(fd);
    if (!held.isFile() || held.size > 1024 * 1024) return null;
    return readFileSync(fd, "utf8");
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
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


/** The include key one config file sets (lowercased, as git names it), "include" when only a plain reading finds one,
 * or "an unreadable file" when it can't be read as a plain file or parsed; null when it includes nothing. */
function includeIn(path: string, gitFile = "git"): string | null {
  const text = regularFile(path);
  if (text === null) return "an unreadable file";
  const parsed = spawnSync(gitFile, ["config", "--file", path, "--no-includes", "--name-only", "--list", "-z"],
    { cwd: "/", encoding: "utf8", timeout: 5_000, env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" } });
  if (parsed.status !== 0) return "an unreadable file";
  const named = parsed.stdout.split("\0").find(name => /^(include\.path|includeif\..*\.path)$/i.test(name));
  if (named !== undefined) return named.toLowerCase();
  return /^\s*\[\s*include(if)?\b/im.test(text) ? "include" : null;
}

/**
 * A checkout's git directories, bound (Codex review of e48e9d8d): read once from its `.git`, as real paths, and proven
 * to be one repository's own, so no pointer, `commondir` file or link the agent can still change decides where the
 * plane's git writes. A main checkout's `.git` is a real folder (not a link) holding no `commondir`; a linked one's is a
 * one-line `gitdir: ` file naming `<common>/worktrees/<id>`, a real folder whose `commondir` resolves to that common
 * folder and whose `gitdir` names this checkout's `.git` back, and whose common folder is the `.git` folder of a main
 * checkout. With `repo` (the project's main checkout, from the plane's own records) the common folder must be the real
 * path of its `.git` folder, a real one holding no `commondir`. Throws with the reason otherwise.
 */
type BoundDirs = { checkout: string; gitdir: string; common: string; linked: boolean };
export type GitBinding = { repo?: string | null };
function boundDirs(checkout: string, binding: GitBinding = {}): BoundDirs {
  const fail = (why: string): never => { throw new Error(`the checkout's .git ${why}`); };
  let top: string;
  try { top = realpathSync(checkout); } catch { return fail("couldn't be found"); }
  const dotgit = join(top, ".git");
  let held: import("node:fs").Stats;
  try { held = lstatSync(dotgit); } catch { return fail("couldn't be read"); }
  let dirs: BoundDirs;
  if (held.isDirectory()) {
    if (existsSync(join(dotgit, "commondir"))) fail("names another repository (commondir)");
    dirs = { checkout: top, gitdir: dotgit, common: dotgit, linked: false };
  } else {
    if (!held.isFile()) fail("is a link");
    const named = gitDirsOf(top);
    if (named === null) return fail("couldn't be read as git reads it");
    let gitdir: string;
    try { gitdir = realpathSync(named.gitdir); } catch { return fail("names a git directory that isn't there"); }
    const admin = lstatSync(gitdir);
    if (!admin.isDirectory()) fail("names something other than a git directory");
    const common = dirname(dirname(gitdir));
    if (basename(dirname(gitdir)) !== "worktrees") fail("names a folder that isn't one of its repository's worktrees");
    const commondir = regularFile(join(gitdir, "commondir"))?.trim();
    let named_: string | null = null;
    try { named_ = commondir === undefined || commondir === "" ? null : realpathSync(resolve(gitdir, commondir)); } catch { named_ = null; }
    if (named_ !== common) fail("belongs to a git directory whose commondir names another repository");
    const back = regularFile(join(gitdir, "gitdir"))?.trim();
    let backReal: string | null = null;
    try { backReal = back === undefined || back === "" ? null : realpathSync(resolve(gitdir, back)); } catch { backReal = null; }
    if (backReal !== dotgit) fail("belongs to a git directory that names another checkout");
    dirs = { checkout: top, gitdir, common, linked: true };
  }
  // The common folder is a main checkout's own `.git` folder, a real one.
  if (basename(dirs.common) !== ".git") fail("belongs to a repository that isn't a checkout's");
  try { if (!lstatSync(dirs.common).isDirectory()) fail("belongs to a repository that is a link"); } catch { fail("belongs to a repository that isn't there"); }
  if (binding.repo != null) {
    // The anchor is the plane's own record, never a pointer file: the recorded project's main checkout, whose `.git`
    // must be a real folder (not a link, holding no `commondir`); its real path is the only common folder accepted. A
    // record that isn't such a checkout (a linked worktree, as agent-fence.ts trustedWorktreeBinding also refuses) or
    // can't be read is refused, never taken as unbound.
    let recorded: string | null = null;
    try {
      const dotgit = join(realpathSync(binding.repo), ".git");
      const held = lstatSync(dotgit);
      recorded = held.isDirectory() && !held.isSymbolicLink() && !existsSync(join(dotgit, "commondir")) ? realpathSync(dotgit) : null;
    } catch { recorded = null; }
    if (recorded === null) fail("can't be checked against the project's record: its main checkout's .git isn't a real folder");
    if (recorded !== dirs.common) fail("belongs to another repository than the project's");
  }
  return dirs;
}

/**
 * A private view of a checkout's repository for one git command on a checkout an agent writes (security review of
 * 0.9.75, its follow-up for the plane's writes, and the Codex review of e48e9d8d): git reads the repository's config
 * and `info/attributes` from its common directory as it starts, whatever --attr-source says, so an agent that adds a
 * filter to both after the config was inspected would have git run it. The view is a fresh folder of the plane's own,
 * in a folder every fence denies to builds (git-views.ts), given to git as GIT_COMMON_DIR: a copy of the config as it
 * was read once (with a linked worktree's config.worktree folded in), an `info` holding only copies (`exclude` and
 * `sparse-checkout`; a write also `attributes`, frozen, so staging and checkout keep the operator's line-ending and
 * git-lfs rules), and links to the real paths of everything else. GIT_DIR is the worktree's own folder as a real path
 * (git won't take HEAD as a link, so it can't be a view); git's ref store reads its `commondir`, so the binding
 * (boundDirs) is proven just before git runs and again after (`intact`), and a command whose repository changed under
 * it counts as refused. Its config is inspected, never the checkout's again. Throws when it can't be made.
 *
 * A write through the view lands in the repository itself (git 2.50.1, established by test/attacks/
 * checkout-git-write-toctou.test.ts and checkout-git-view-binding.test.ts): objects, loose refs and reflogs are written
 * inside the linked folders; packed-refs is rewritten through git's lockfile, which follows a link to the real file (and
 * takes its lock beside it). Names git may create are linked even before they exist (a dangling link git writes
 * through), and `worktrees` is made in the repository first (git can't create a folder under a dangling link). The one thing a command can't change through it is the config: the view's is a
 * copy, so a config write (a branch's section dropped by `branch -D`) stays in the view and is lost.
 */
type GitView = { env: Record<string, string>; restore: (output: string, args: readonly string[]) => string; dispose: () => void; dirs: BoundDirs;
  /** After git ran: its worktree-own writes carried back, and null, or why the run can't stand (an incident). */
  settle: () => string | null };
/** What git keeps only per worktree and the plane never links: HEAD (git won't take it as a link) and the pointers. */
/** What the plane links of a worktree's own git folder (git writes them in place through the link: the index and its
 * logs by lockfile, per-worktree refs and logs inside the folders), whether or not they exist yet; a rebase's,
 * cherry-pick's or sequencer's state folder only when one is already there. */
const ADMIN_LINKED = ["index", "logs", "refs", "reftable"];
/** What git keeps in a common directory (its path.c common_list, and reftable), linked whether or not it exists yet. */
const COMMON_NAMES = ["branches", "gc.pid", "logs", "lost-found", "modules", "objects", "packed-refs", "reftable", "refs", "remotes", "rr-cache", "shallow", "svn", "worktrees"];
function gitView(checkout: string, kind: "read" | "write", binding: GitBinding = {}, gitFile = "git"): GitView {
  const dirs = boundDirs(checkout, binding);
  const root = ensureGitViewsRoot(realpathSync(homedir()));
  const view = realpathSync(mkdtempSync(join(root, `${kind}-`)));
  const admin = realpathSync(mkdtempSync(join(root, `${kind}-gitdir-`)));
  const dispose = () => { rmSync(view, { recursive: true, force: true }); rmSync(admin, { recursive: true, force: true }); };
  const initial = new Map<string, string | null>();
  const priorWorktrees = new Set<string>();
  try {
    let config = regularFile(join(dirs.common, "config"));
    if (config === null) throw new Error("the checkout's git config couldn't be read as a plain file");
    const configPath = join(view, "config");
    writeFileSync(configPath, config, { mode: 0o600 });
    const plain = { cwd: "/", encoding: "utf8" as const, timeout: 5_000, env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" } };
    if (/worktreeconfig/i.test(config)) {
      const flag = spawnSync(gitFile, ["config", "--file", configPath, "--no-includes", "--type=bool", "--get", "extensions.worktreeConfig"], plain);
      if (flag.status !== 0 && flag.status !== 1) throw new Error("the checkout's git config couldn't be read");
      if (flag.stdout.trim() === "true") {
        // Git would also read the worktree's config.worktree, which the agent can still change: folded in as it is now.
        const worktree = join(dirs.gitdir, "config.worktree");
        const own = existsSync(worktree) ? regularFile(worktree) : "";
        if (own === null) throw new Error("the checkout's config.worktree couldn't be read as a plain file");
        config = `${config}\n${own}`;
        writeFileSync(configPath, config, { mode: 0o600 });
      }
      const unset = spawnSync(gitFile, ["config", "--file", configPath, "--unset-all", "extensions.worktreeConfig"], plain);
      if (unset.status !== 0 && unset.status !== 5) throw new Error("the checkout's git config couldn't be read");
    }
    const include = includeIn(configPath, gitFile);
    if (include !== null) throw new Error(`the checkout's git config includes another file (${include})`);
    mkdirSync(join(view, "info"));
    // A main checkout's sparse-checkout patterns are in its own (common) info folder; a linked one's in its admin's.
    for (const name of kind === "write" ? ["exclude", "attributes", "sparse-checkout"] : ["exclude", "sparse-checkout"]) {
      if (name === "sparse-checkout" && dirs.linked) continue;
      const path = join(dirs.common, "info", name);
      if (!existsSync(path)) continue;
      const text = regularFile(path);
      // A write that dropped the operator's exclude or attributes could stage what they keep out: refused instead.
      if (text === null && kind === "write") throw new Error(`the checkout's info/${name} couldn't be read as a plain file`);
      if (text !== null) writeFileSync(join(view, "info", name), text, { mode: 0o600 });
    }
    if (kind === "write") {
      const folder = join(dirs.common, "worktrees");
      if (!existsSync(folder)) { try { mkdirSync(folder); } catch { /* git reports it if it needs the folder */ } }
      try { for (const id of readdirSync(folder)) priorWorktrees.add(id); } catch { /* none yet */ }
    }
    for (const name of new Set([...readdirSync(dirs.common), ...COMMON_NAMES])) {
      if (name === "config" || name === "info" || name === "hooks" || name === "commondir") continue;
      symlinkSync(join(dirs.common, name), join(view, name));
    }
    // GIT_DIR is the plane's too (git's ref store reads `commondir` from GIT_DIR as it goes, empirically on 2.50.1):
    // its `commondir` names the view and its `gitdir` this checkout, both the plane's; HEAD is a copy (git won't take
    // it as a link) carried back after the run; the worktree's other files are linked (the index and logs even before
    // they exist), so git's lockfiles write them in place.
    // (A folder under a dangling link can't be made by git: the worktree's `logs` is made first, as git would.)
    if (kind === "write" && !existsSync(join(dirs.gitdir, "logs"))) { try { mkdirSync(join(dirs.gitdir, "logs")); } catch { /* git reports it */ } }
    // Only what git needs of the worktree's own folder is linked (ADMIN_LINKED, and a split index's shared files), each
    // checked to be a real entry directly in it, never a link (Codex review of a0fa135d).
    const linked = [...ADMIN_LINKED, ...readdirSync(dirs.gitdir).filter(name => name.startsWith("sharedindex."))];
    for (const name of new Set(linked)) {
      const path = join(dirs.gitdir, name);
      let held: import("node:fs").Stats | null = null;
      try { held = lstatSync(path); } catch { held = null; }
      if (held !== null && (held.isSymbolicLink() || dirname(realpathSync(path)) !== dirs.gitdir)) throw new Error(`the checkout's git directory has ${name} as a link`);
      symlinkSync(path, join(admin, name));
      initial.set(name, null);
    }
    const head = regularFile(join(dirs.gitdir, "HEAD"));
    if (head === null) throw new Error("the checkout's HEAD couldn't be read as a plain file");
    // The worktree's own state files (WORKTREE_STATE: HEAD, a merge's, cherry-pick's, rebase's or bisect's pseudo-refs
    // and messages) are copies (git won't take them as links), carried back after the run; its state folders, when
    // there, are linked.
    for (const name of WORKTREE_STATE) {
      const path = join(dirs.gitdir, name);
      if (!existsSync(path) && name !== "HEAD") continue;
      const text = name === "HEAD" ? head : regularFile(path);
      if (text === null) throw new Error(`the checkout's ${name} couldn't be read as a plain file`);
      writeFileSync(join(admin, name), text, { mode: 0o600 });
      initial.set(name, text);
    }
    for (const name of WORKTREE_STATE_DIRS) {
      const path = join(dirs.gitdir, name);
      let held: import("node:fs").Stats | null = null;
      try { held = lstatSync(path); } catch { continue; }
      if (held.isSymbolicLink() || !held.isDirectory()) throw new Error(`the checkout's git directory has ${name} as a link`);
      symlinkSync(path, join(admin, name));
      initial.set(name, null);
    }
    writeFileSync(join(admin, "commondir"), `${view}\n`, { mode: 0o600 });
    writeFileSync(join(admin, "gitdir"), `${join(dirs.checkout, ".git")}\n`, { mode: 0o600 });
    // A main checkout's own info (its sparse-checkout) is the view's frozen one; a linked one's is its own.
    symlinkSync(dirs.linked ? join(dirs.gitdir, "info") : join(view, "info"), join(admin, "info"));
    if (!pinned(dirs).ok) throw new Error("the checkout's repository has a folder that is a link");
  } catch (error) { dispose(); throw error; }
  // The folders down to the worktree's own, as they are now: carry-back writes only while each is still the same one.
  let anchor: Anchor;
  try { anchor = anchorOf(dirs.gitdir); } catch { dispose(); throw new Error("the checkout's repository has a folder that is a link"); }
  // Where git names a view (rev-parse --git-dir, --git-common-dir), the caller is told the repository's own folder;
  // where `worktree list` names the common view as the main worktree, that worktree (git's rule: the common dir less
  // `/.git`).
  const mainWorktree = dirname(dirs.common);
  const restore = (output: string, args: readonly string[]) => {
    if (!output.includes(view) && !output.includes(admin)) return output;
    const asWorktree = args.includes("worktree");
    return output.split(admin).join(dirs.gitdir).split(`${view}/`).join(`${dirs.common}/`).split(view).join(asWorktree ? mainWorktree : dirs.common);
  };
  const settle = (): string | null => {
    const now = pinned(dirs);
    let bound = false;
    try { const again = boundDirs(checkout, binding); bound = again.gitdir === dirs.gitdir && again.common === dirs.common; } catch { bound = false; }
    if (!now.ok || !bound) {
      // Too late to prevent: recorded and told (git-incident.ts), never rolled back where the swap leads.
      if (kind === "write") {
        gitIncident({ checkout: dirs.checkout, repository: dirs.common, swapped: now.swapped.length > 0 ? now.swapped.map(({ path, leadsTo }) => ({ path, leadsTo })) : [{ path: join(dirs.checkout, ".git"), leadsTo: null }],
          record: join(dirname(ensureGitViewsRoot(realpathSync(homedir()))), "git-incidents.jsonl") });
      }
      return "the checkout's repository changed while git ran";
    }
    if (kind === "write") {
      // The worktree's own state git rewrote in the plane's GIT_DIR goes back to it, and what it removed is removed
      // there; anything else git left there the plane can't keep, and says so.
      const left = readdirSync(admin).filter(name => !initial.has(name) && !WORKTREE_STATE.includes(name) && !["commondir", "gitdir", "info"].includes(name));
      try { carryBack(admin, dirs.gitdir, initial, anchor); } catch (error) {
        if (!(error instanceof AnchorMoved)) return "the checkout's git state couldn't be carried back after git ran";
        gitIncident({ checkout: dirs.checkout, repository: dirs.common, swapped: [{ path: error.message, leadsTo: null }], record: join(dirname(ensureGitViewsRoot(realpathSync(homedir()))), "git-incidents.jsonl") });
        return "the checkout's repository changed while git ran";
      }
      if (left.length > 0) return `git left state Toolroll can't keep in the checkout (${left.slice(0, 5).join(", ")})`;
      const relinked = relinkAdded(view, dirs.common, priorWorktrees);
      if (relinked !== null) return relinked;
    }
    return null;
  };
  return { env: { GIT_DIR: admin, GIT_COMMON_DIR: view, GIT_WORK_TREE: dirs.checkout }, restore, dispose, dirs, settle };
}

/** A worktree's own state files git may write (git's per-worktree names: HEAD and the pseudo-refs and messages of a
 * merge, cherry-pick, revert, rebase or bisect), and its state folders. */
const WORKTREE_STATE = ["HEAD", "ORIG_HEAD", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "MERGE_RR", "AUTO_MERGE", "FETCH_HEAD", "COMMIT_EDITMSG",
  "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "SQUASH_MSG", "TAG_EDITMSG", "BISECT_LOG", "BISECT_START", "BISECT_TERMS", "BISECT_EXPECTED_REV",
  "BISECT_ANCESTORS_OK", "BISECT_NAMES", "BISECT_RUN", "BISECT_HEAD"];
const WORKTREE_STATE_DIRS = ["sequencer", "rebase-merge", "rebase-apply"];

/**
 * Whether every path git may write through a view is still the repository's own (Codex review of a0fa135d: git
 * writes deeper than the top-level folders, through a link at `refs/heads/x`, `logs/…` or `objects/xx` as well). The
 * walk, by lstat, never following a link: every name of the common folder git may write (COMMON_NAMES: refs, logs,
 * reftable, packed-refs, worktrees with each worktree's own folder, rr-cache, modules, …) all the way down, HEAD and
 * the index; the worktree's own state (WORKTREE_STATE: its HEAD, index, refs, logs, a merge's, rebase's or bisect's
 * state, a split index's shared files); and the object store (the common `objects`, and a submodule git directory's
 * own under modules/): its fan-out folders' entries for links, `info` and `pack` all the way down, but not each loose
 * object (a big repository has very many, and hard-linked objects are legitimate). Any link is refused, so is a folder
 * that can't be listed, and so is any file walked deep with a second hard link (git appends to a log in place). The
 * exemption is by place only: an `objects` anywhere else (under refs/, logs/, worktrees/) is walked like the rest. For each one found, where it leads (for an incident's record).
 *
 * Checked when the view is made and again after git ran; between the two, a process that outlived the agent's turn
 * can still swap one of these for a link and have git write through it mid-command. That window is an accepted
 * residual: git takes paths, not handles. Seen after the run, it is an incident (git-incident.ts).
 */
function pinned(dirs: BoundDirs): { ok: boolean; swapped: GitIncident["swapped"] } {
  const swapped: GitIncident["swapped"] = [];
  const seen = new Set<string>();
  let budget = 400_000;
  const stores = objectStores(dirs.common);
  /** `deep`: every entry all the way down, each file held to one hard link. `shallow`: the folder's own entries
   * checked for links only. `store`: an object store (objects/: its fan-out folders shallow, `info` and `pack` deep
   * without the hard-link test). A link, or a folder that can't be listed, is swapped. */
  const check = (path: string, mode: "deep" | "shallow" | "store" | "deep-unlinked"): void => {
    if (seen.has(path)) return;
    if (budget-- <= 0) return;
    seen.add(path);
    let held: import("node:fs").Stats;
    try { held = lstatSync(path); } catch { return; }
    if (held.isSymbolicLink()) {
      let real: string | null = null;
      try { real = realpathSync(path); } catch { real = null; }
      swapped.push({ path, leadsTo: real });
      return;
    }
    if (held.isFile() && mode === "deep" && held.nlink > 1) { swapped.push({ path, leadsTo: null }); return; }
    if (!held.isDirectory()) return;
    let entries: string[];
    // A folder that can't be listed hides what's in it: it counts as swapped (fail closed).
    try { entries = readdirSync(path); } catch { swapped.push({ path, leadsTo: null }); return; }
    for (const name of entries) {
      const child = join(path, name);
      if (mode === "shallow") { try { if (lstatSync(child).isSymbolicLink()) check(child, "shallow"); } catch { /* gone */ } continue; }
      if (mode === "store") { check(child, name === "info" || name === "pack" ? "deep-unlinked" : "shallow"); continue; }
      // The object store exemption by exact place, never by name (stores, enumerated before the walk).
      check(child, stores.has(child) ? "store" : mode);
    }
  };
  // The common folder's every name git may write, all the way down (refs, logs, reftable, packed-refs, worktrees with
  // each worktree's own folder, rr-cache, modules, the rest of COMMON_NAMES), and the worktree's own state.
  for (const name of COMMON_NAMES) if (name !== "objects") check(join(dirs.common, name), "deep");
  for (const name of ["HEAD", "index"]) check(join(dirs.common, name), "deep");
  for (const name of [...WORKTREE_STATE, ...WORKTREE_STATE_DIRS, "index", "refs", "logs", "reftable"]) check(join(dirs.gitdir, name), "deep");
  try { for (const name of readdirSync(dirs.gitdir)) if (name.startsWith("sharedindex.")) check(join(dirs.gitdir, name), "deep"); } catch { swapped.push({ path: dirs.gitdir, leadsTo: null }); }
  // The object store: the folder and its fan-out folders for links (not each loose object: a big repository has very
  // many, and `clone --local` hard-links them legitimately; git writes a new object to a fresh temporary file linked
  // into place, never through an existing one), `info` and `pack` all the way down.
  for (const store of stores) check(store, "store");
  if (budget <= 0) swapped.push({ path: dirs.common, leadsTo: null });
  // A path that is no longer its own real path (a folder on the way swapped) counts too.
  for (const path of [dirs.common, dirs.gitdir]) { try { if (realpathSync(path) !== path) swapped.push({ path, leadsTo: realpathSync(path) }); } catch { swapped.push({ path, leadsTo: null }); } }
  return { ok: swapped.length === 0, swapped };
}

/**
 * The object stores the walk exempts from its full check, enumerated before it, never decided by a name met on the
 * way: the common `objects`, and `<gitdir>/objects` for each submodule git directory under modules/ — a folder with
 * its own config, HEAD, refs/ and objects/, reached through no component named refs, logs, reftable, objects, info,
 * worktrees or hooks (so `modules/x/refs/objects` with a planted HEAD is no store).
 */
function objectStores(common: string): Set<string> {
  const stores = new Set([join(common, "objects")]);
  const NOT_A_PATH = new Set(["refs", "logs", "reftable", "objects", "info", "worktrees", "hooks"]);
  const visit = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || NOT_A_PATH.has(entry.name)) continue;
      const at = join(dir, entry.name);
      const own = (name: string, folder: boolean) => { try { const held = lstatSync(join(at, name)); return folder ? held.isDirectory() : held.isFile(); } catch { return false; } };
      if (own("config", false) && own("HEAD", false) && own("refs", true) && own("objects", true)) {
        stores.add(join(at, "objects"));
        visit(join(at, "modules"), depth + 1);
      } else visit(at, depth + 1);
    }
  };
  visit(join(common, "modules"), 0);
  return stores;
}

/** Every folder from the root down to `path`, with its device and inode as they are now (none may be a link). */
type Anchor = { path: string; dev: number; ino: number }[];
function anchorOf(path: string): Anchor {
  const anchor: Anchor = [];
  for (let at = path; ; at = dirname(at)) {
    const held = lstatSync(at);
    if (held.isSymbolicLink() || !held.isDirectory()) throw new AnchorMoved(at);
    anchor.unshift({ path: at, dev: held.dev, ino: held.ino });
    if (dirname(at) === at) return anchor;
  }
}
class AnchorMoved extends Error {}
/** Throws AnchorMoved unless every folder of `anchor` is still the one it was (Node has no openat, so each component
 * is looked at again right before each rename or unlink). */
function holdAnchor(anchor: Anchor): void {
  for (const one of anchor) {
    let held: import("node:fs").Stats;
    try { held = lstatSync(one.path); } catch { throw new AnchorMoved(one.path); }
    if (held.isSymbolicLink() || !held.isDirectory() || held.dev !== one.dev || held.ino !== one.ino) throw new AnchorMoved(one.path);
  }
}

/** Carry the WORKTREE_STATE files git rewrote or removed in the plane's GIT_DIR back to the worktree's own folder: a
 * new file of a random name, created exclusively (never through a link), then renamed into place; before each rename
 * or unlink, every folder down to the worktree's own is proven the same one it was when the view was made. */
function carryBack(admin: string, gitdir: string, initial: ReadonlyMap<string, string | null>, anchor: Anchor): void {
  for (const name of WORKTREE_STATE) {
    const here = join(admin, name);
    let held: import("node:fs").Stats | null = null;
    try { held = lstatSync(here); } catch { held = null; }
    const was = initial.get(name);
    if (held === null) {
      // Removed by git: removed in the worktree's own folder too (a merge's state once it concluded).
      if (initial.get(name) != null) { holdAnchor(anchor); rmSync(join(gitdir, name), { force: true }); }
      continue;
    }
    if (held.isSymbolicLink() || !held.isFile()) continue;
    const text = readFileSync(here);
    if (was !== undefined && was !== null && text.toString("utf8") === was) continue;
    holdAnchor(anchor);
    const temporary = join(gitdir, `.toolroll-${randomBytes(16).toString("hex")}`);
    const fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, text); } finally { closeSync(fd); }
    try { holdAnchor(anchor); renameSync(temporary, join(gitdir, name)); } catch (error) { rmSync(temporary, { force: true }); throw error; }
  }
}

/**
 * A worktree `worktree add` made through a view, pointed at its repository instead of the view. Before git 2.48 the new
 * checkout's `.git` file names the common directory as given (the view, removed right after the run: every later
 * command in that checkout would find no repository); later versions name its real path, and this finds nothing to do.
 * Only a worktree folder this run made (not there when the view was made) whose checkout's `.git` is a plain file
 * reading exactly `gitdir: <view>/worktrees/<id>` (a name private to this run, in a folder every fence denies) is
 * rewritten: a new file created exclusively (never through a link) and renamed into place, then bound to the repository
 * (boundDirs) as any checkout is. Before it writes, the repository's own record of the worktree must name this very
 * checkout and repository, and every folder down to the checkout is anchored (anchorOf) and proven the same one before
 * the open, the re-read and the rename, as carryBack does. A failure after the rename isn't undone (the old content
 * names a view that no longer exists, so the checkout is unusable either way); it refuses. Null when every such
 * checkout is bound, or why one isn't.
 */
function relinkAdded(view: string, common: string, prior: ReadonlySet<string>): string | null {
  let ids: string[];
  try { ids = readdirSync(join(common, "worktrees")).filter(id => !prior.has(id)); } catch { return null; }
  for (const id of ids) {
    const named = regularFile(join(common, "worktrees", id, "gitdir"))?.trim();
    if (named === undefined || !named.startsWith("/") || basename(named) !== ".git") continue;
    const stale = `gitdir: ${join(view, "worktrees", id)}`;
    let folder: string;
    try { folder = realpathSync(dirname(named)); } catch { continue; }
    const dotgit = join(folder, ".git");
    const read = (): string | null => { try { return lstatSync(dotgit).isFile() ? regularFile(dotgit) : null; } catch { return null; } };
    if (read()?.trim() !== stale) continue;
    // The repository's record of this worktree names this checkout and this repository, before anything is written.
    const admin = join(common, "worktrees", id);
    let recorded: boolean;
    try {
      const commondir = regularFile(join(admin, "commondir"))?.trim();
      recorded = lstatSync(admin).isDirectory() && commondir !== undefined && commondir !== ""
        && realpathSync(resolve(admin, commondir)) === realpathSync(common) && realpathSync(named) === dotgit;
    } catch { recorded = false; }
    if (!recorded) return "the new checkout's record in its repository doesn't name it";
    let anchor: Anchor;
    try { anchor = anchorOf(folder); } catch { return "the new checkout's folder changed before it could be pointed at its repository"; }
    const temporary = join(folder, `.toolroll-${randomBytes(16).toString("hex")}`);
    try {
      holdAnchor(anchor);
      const fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o644);
      try { writeSync(fd, `gitdir: ${admin}\n`); } finally { closeSync(fd); }
      // Checked again at the moment of use: the same folders, and still the plain file git wrote.
      holdAnchor(anchor);
      if (read()?.trim() !== stale) { rmSync(temporary, { force: true }); return "the new checkout's .git changed before it could be pointed at its repository"; }
      holdAnchor(anchor);
      renameSync(temporary, dotgit);
    } catch { rmSync(temporary, { force: true }); return "the new checkout's .git couldn't be pointed at its repository"; }
    try { boundDirs(folder, { repo: dirname(common) }); } catch (error) { return error instanceof Error ? error.message : "the new checkout isn't bound to its repository"; }
  }
  return null;
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
 * config write, which a view keeps); no transport at all (a caller that fetches allows its one protocol by name, as the
 * nightly check's local fetch does with protocol.file.allow); and no split index (its shared index files would be
 * written in the plane's GIT_DIR). */
export const WRITE_VIEW_FLAGS: readonly string[] = ["-c", "worktree.useRelativePaths=false", "-c", "protocol.allow=never", "-c", "core.splitIndex=false"];

/** Whether the checkout's .lfsconfig (read as git parses it, that file only) sets any git-lfs key that could name a
 * program (anything but INERT_LFS). A file that
 * isn't a plain one, or doesn't parse, counts as naming one. */
export function lfsExtensionIn(checkout: string, gitFile = "git"): boolean {
  const path = join(checkout, ".lfsconfig");
  try { if (!lstatSync(path).isFile()) return true; } catch { return false; }
  const parsed = spawnSync(gitFile, ["config", "--file", path, "--no-includes", "--name-only", "--list", "-z"],
    { cwd: "/", encoding: "utf8", timeout: 5_000, env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" } });
  return parsed.status !== 0 || parsed.stdout.split("\0").filter(Boolean).some(name => lfsCommand(name) || ["include", "includeif"].includes(keyParts(name).section));
}

/** Every command runs against a view of the checkout's repository (gitView) whose config and info are copies the
 * plane made, inspected there, so neither can change between the inspection and the run. `mode` "read" is for reading
 * a checkout an agent may still be writing (the code page): every command also takes readFlags(), and the view holds
 * no info/attributes. "build" is the plane's staging and committing of a build's work, which writes the repository
 * through the view (gitView). */
export function checkoutGit(inner: Runner = run, mode: "build" | "read" = "build", binding: GitBinding = {}): Runner {
  return async (file, args, options) => {
    if (file !== "git") return inner(file, args, options);
    const cwd = options?.cwd;
    if (cwd === undefined || checkoutIncludes(cwd)) return refused("the checkout's git config includes another file, or couldn't be read as a plain file");
    // git-lfs also reads .lfsconfig from the checkout: one that names an extension (a command it would run) is refused.
    if (lfsExtensionIn(cwd)) return refused("the checkout's .lfsconfig sets a git-lfs key that can run a command");
    const once = async (): Promise<ExecResult> => {
    let view: GitView;
    try { view = gitView(cwd, mode === "read" ? "read" : "write", binding); } catch (error) { return refused(error instanceof Error ? error.message : "the checkout couldn't be read"); }
    try {
      const viewed = { ...options, env: { ...(options?.env ?? {}), ...view.env } };
      // The checkout's own config may name no command.
      const own = await inner("git", ["--no-optional-locks", "config", "--list", "--show-scope", "-z"], viewed);
      if (own.code !== 0) return refused("its config couldn't be read");
      const key = commandSetting(own.stdout, { lfsChecked: true });
      if (key !== null) return refused(`the checkout's git config sets ${key}, which can run a command`);
      // A git without --no-lazy-fetch: a repository that could fetch lazily is refused, from the view's frozen config.
      if (!lazyFetchSupported() && lazyFetchSetting(own.stdout) !== null) return refused(PARTIAL_CLONE_REFUSAL);
      // The operator's own config contributes values only (carriedSettings); git then reads no global or system config.
      // A read carries no filter: it reads attributes from the empty tree anyway.
      const carried = mode === "read" ? withoutFilters(carriedSettings(own.stdout)) : carriedSettings(own.stdout);
      const env = { ...viewed.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
      // Never into a submodule or nested repository, whose own config this never read: status and diff skip them.
      const safeArgs = withoutUnsupportedFlags(args);
      const command = safeArgs.findIndex(arg => arg === "status" || arg === "diff");
      if (command >= 0 && !safeArgs.includes("--ignore-submodules=all")) safeArgs.splice(command + 1, 0, "--ignore-submodules=all");
      const flags = mode === "read" ? readFlags() : WRITE_VIEW_FLAGS;
      const ran = await inner("git", [...TEARDOWN_FLAGS, ...flags, "-c", "diff.ignoreSubmodules=all", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...carried, ...safeArgs], { ...options, env });
      const why = view.settle();
      if (why !== null) return refused(why);
      return { ...ran, stdout: view.restore(ran.stdout, args), stderr: view.restore(ran.stderr, args) };
    } finally { view.dispose(); }
    };
    if (mode !== "build") return once();
    // A write, one at a time on a checkout (git-views.ts withCheckoutLock: re-entrant along one call chain).
    try { return await withCheckoutLock(realpathSync(homedir()), realpathSync(cwd), once); }
    catch (error) { return refused(error instanceof Error ? error.message : "the checkout is busy"); }
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
  return lazyFetchSupported() ? PAGE_READ_FLAGS : PAGE_READ_FLAGS.filter(flag => flag !== "--no-lazy-fetch");
}

/**
 * checkoutGit, synchronously, for reads a page shows from a checkout an agent writes (docs/plans/get-side-effects.md):
 * the same refusals (an include, an .lfsconfig extension, a config key that can run a command), no system or global
 * config, the operator's own values carried, PAGE_READ_FLAGS and a view of the checkout's repository (gitView: they hold even if its config
 * or info/attributes change after they were read), submodules skipped, bounded. A refusal throws.
 */
export function checkoutGitSync(cwd: string, args: readonly string[], options: { timeoutMs?: number; maxBuffer?: number; binding?: GitBinding } = {}): string {
  const ran = viewedGitSync(cwd, args, options);
  if (ran.status !== 0) throw new Error(`git ${args[0] ?? ""} failed`);
  return ran.stdout;
}

/**
 * checkoutGitSync's run, answering git's exit status instead of throwing on a non-zero one (a refusal, or a repository
 * that changed while git ran, still throws): for reads whose "no" is an exit code (`merge-base --is-ancestor`), and,
 * with `buffer`, for blobs read as bytes (their output is never rewritten).
 */
export function viewedGitSync(cwd: string, args: readonly string[], options: { timeoutMs?: number; maxBuffer?: number; binding?: GitBinding }): { status: number | null; stdout: string };
export function viewedGitSync(cwd: string, args: readonly string[], options: { timeoutMs?: number; maxBuffer?: number; binding?: GitBinding; buffer: true; input?: Buffer; git?: string }): { status: number | null; stdout: Buffer };
export function viewedGitSync(cwd: string, args: readonly string[], options: { timeoutMs?: number; maxBuffer?: number; binding?: GitBinding; buffer?: true; input?: Buffer; git?: string } = {}): { status: number | null; stdout: string | Buffer } {
  const gitFile = options.git ?? "git";
  if (checkoutIncludes(cwd, gitFile)) throw new Error("the checkout's git config includes another file, or couldn't be read as a plain file");
  if (lfsExtensionIn(cwd, gitFile)) throw new Error("the checkout's .lfsconfig sets a git-lfs key that can run a command");
  // Its config and info/attributes as read once, in a folder of the plane's own: neither can change before git runs.
  const view = gitView(cwd, "read", options.binding, gitFile);
  try {
    const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...view.env };
    const bounded = { cwd, env, encoding: "utf8" as const, timeout: options.timeoutMs ?? 60_000, maxBuffer: options.maxBuffer ?? 1_048_576, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
    const own = spawnSync(gitFile, ["--no-optional-locks", "config", "--list", "--show-scope", "-z"], bounded);
    if (own.status !== 0) throw new Error("its config couldn't be read");
    const key = commandSetting(own.stdout, { lfsChecked: true });
    if (key !== null) throw new Error(`the checkout's git config sets ${key}, which can run a command`);
    // A git without --no-lazy-fetch: a repository that could fetch lazily is refused, from the view's frozen config.
    if (!lazyFetchSupported() && lazyFetchSetting(own.stdout) !== null) throw new Error(PARTIAL_CLONE_REFUSAL);
    const safeArgs = withoutUnsupportedFlags(args);
    const command = safeArgs.findIndex(arg => arg === "status" || arg === "diff");
    if (command >= 0 && !safeArgs.includes("--ignore-submodules=all")) safeArgs.splice(command + 1, 0, "--ignore-submodules=all");
    // An external diff program is named by config, which may change after it was read: never used here.
    if (command >= 0 && safeArgs[command] === "diff") safeArgs.splice(command + 1, 0, "--no-ext-diff", "--no-textconv");
    // The operator's own values, but no filter: PAGE_READ_FLAGS reads attributes from the empty tree anyway.
    const carried = withoutFilters(carriedSettings(own.stdout));
    const argv = [...TEARDOWN_FLAGS, ...readFlags(), "-c", "diff.ignoreSubmodules=all", ...carried, ...safeArgs];
    if (options.buffer === true) {
      // stdin is the caller's own bytes when given (cat-file --batch), else closed.
      const ran = spawnSync(gitFile, argv, { ...bounded, encoding: "buffer", ...(options.input === undefined ? {} : { input: options.input, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] }) });
      const why = view.settle();
      if (why !== null) throw new Error(why);
      return { status: ran.error === undefined ? ran.status : null, stdout: ran.stdout };
    }
    const ran = spawnSync(gitFile, argv, bounded);
    const why = view.settle();
    if (why !== null) throw new Error(why);
    return { status: ran.error === undefined ? ran.status : null, stdout: view.restore(ran.stdout ?? "", args) };
  } finally { view.dispose(); }
}

/**
 * checkoutGit ("build": the repository written through its view) for callers that name the repository with a leading
 * `git -C <dir>` instead of a cwd: worktree add and remove in a project's repository, a merge in a checkout of it.
 * The project's repository is shared with every build, which can write its config, info and hooks; nothing here runs
 * what they name. Anything but git goes to `inner` as given.
 */
export function hardenedGit(inner: Runner = run, mode: "build" | "read" = "build", binding: GitBinding = {}): Runner {
  const hardened = checkoutGit(inner, mode, binding);
  return (file, args, options) => {
    if (file !== "git") return inner(file, args, options);
    let cwd = options?.cwd;
    let rest = [...args];
    while (rest[0] === "-C" && rest.length > 1) { cwd = resolve(cwd ?? process.cwd(), rest[1]!); rest = rest.slice(2); }
    return hardened("git", rest, { ...options, ...(cwd === undefined ? {} : { cwd }) });
  };
}

/**
 * Git older than 2.45 has no `--no-lazy-fetch` (and no GIT_NO_LAZY_FETCH): there, every hardened read leaves the flag
 * out and instead refuses a repository whose config makes lazy fetching possible (lazyFetchSetting), while
 * `protocol.allow=never` stays on every read and write, so a lazy fetch that slipped past would still find no
 * transport. Asked once per process, as the plane's other plain git probes run: no system or global config.
 */
let lazyFetch: boolean | undefined;
export function lazyFetchSupported(): boolean {
  if (lazyFetch === undefined) {
    const probe = spawnSync("git", ["--no-lazy-fetch", "version"], { cwd: "/", encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" } });
    lazyFetch = probe.status === 0;
  }
  return lazyFetch;
}
/** For tests: forget the probe's answer, or set it (null forgets). */
export function setLazyFetchSupportedForTest(value: boolean | null): void { lazyFetch = value ?? undefined; }

/** The words for a partial clone refused on a git without `--no-lazy-fetch`. */
export const PARTIAL_CLONE_REFUSAL = "this project is a partial clone; protected reads need git 2.45 or newer";

/** `--no-lazy-fetch` where the installed git has it, else nothing (and lazyFetchSetting refuses partial clones). */
export function noLazyFetch(): readonly string[] { return lazyFetchSupported() ? ["--no-lazy-fetch"] : []; }

/** A caller's own arguments with `--no-lazy-fetch` taken out when the installed git doesn't know it. */
function withoutUnsupportedFlags(args: readonly string[]): string[] {
  return lazyFetchSupported() ? [...args] : args.filter(arg => arg !== "--no-lazy-fetch");
}

/**
 * The repository setting (local or worktree scope of a `git config --list --show-scope -z` listing) that makes lazy
 * fetching possible, or null: `extensions.partialClone` set at all, any `remote.<name>.promisor` not plainly false, or
 * any `remote.<name>.partialCloneFilter` set (git makes that remote a promisor). Fails closed: a listing that can't be
 * read names a setting. `remote.<name>.vcs` (a foreign-VCS helper) is named too, though the classifier already refuses
 * it (commandSetting: not in the remote allowlist), as it does every `protocol.*` key and every include.
 */
export function lazyFetchSetting(listing: string): string | null {
  try {
    const fields = listing.split("\0");
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const scope = fields[at]!;
      if (scope !== "local" && scope !== "worktree") continue;
      const entry = fields[at + 1]!;
      const newline = entry.indexOf("\n");
      const key = newline < 0 ? entry : entry.slice(0, newline);
      const value = newline < 0 ? null : entry.slice(newline + 1);
      const { section, subsection, variable } = keyParts(key);
      if (section === "extensions" && variable === "partialclone") return key.toLowerCase();
      if (section === "remote" && subsection !== null && (variable === "partialclonefilter" || variable === "vcs")) return key.toLowerCase();
      if (section === "remote" && subsection !== null && variable === "promisor" && !/^(false|no|off|0)$/i.test((value ?? "true").trim())) return key.toLowerCase();
    }
    return null;
  } catch { return "a setting that couldn't be read"; }
}

/**
 * For the reads that run git directly on a repository rather than through a view: with `--no-lazy-fetch` they run as
 * they always have (the flag stops any fetch). Without it, they must not check a repository's config and then run git
 * on it (the config could change in between, or an include could set what the check never saw): `inner`, wrapped so
 * every git command runs through a frozen read view (checkoutGit "read"), whose own config listing (includes refused,
 * command and protocol settings refused, a partial clone refused) is the config git then runs with.
 */
export function lazyFetchSafeGit(inner: Runner = run): Runner {
  // On every git version (eval-harness review 1, finding 7): with --no-lazy-fetch the direct read still took the
  // repository's config and its includes as git found them, and an include naming a FIFO could hang the plane.
  return checkoutGit(inner, "read");
}
