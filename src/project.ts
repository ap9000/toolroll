/**
 * Projects, as the console means them: a project IS a repo path on this
 * server — one row of truth, no new concept — and, critically, project
 * *selection* is never project *authorization*.
 *
 * The ceiling is server configuration: the repos named at startup, plus any
 * git repository under a configured project root. A session picking a
 * project picks from inside that ceiling; a registry row, a store row, or a
 * request header can name a path, but naming is not access (per the v2
 * review's first finding). No configuration at all is the legacy unscoped
 * mode — everything visible — and the code says so where it decides.
 */

import { realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { run, type ExecResult, type RunOptions } from "./exec.js";
import { folderAnswers, FolderUnavailable } from "./folder-gate.js";

export type ProjectExec = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

/**
 * One canonicalization for every path that becomes project identity:
 * startup config, a session open, task placement. Comparisons elsewhere
 * fall back to raw equality for legacy rows written before this existed.
 * Throws FolderUnavailable when the console's folder gate holds the read back (folder-gate.ts).
 */
export function canonicalProject(path: string): string | null {
  // In the console, a folder that hasn't answered a look lately is not read on its thread (folder-gate.ts). That is
  // "unavailable", never "not a folder": it throws, so no caller falls back to the path's spelling because of it.
  if (!folderAnswers(path)) throw new FolderUnavailable(resolve(path));
  try {
    const real = realpathSync(resolve(path));
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Two repo identities, canonical when possible, raw-equal as the legacy fallback. */
export function sameRepo(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  const ca = canonicalProject(a);
  const cb = canonicalProject(b);
  return ca !== null && ca === cb;
}

/** Whether this path is actually a git repository — direct argv, bounded, no shell. */
export async function isGitRepo(path: string, exec: ProjectExec = run): Promise<boolean> {
  const result = await exec("git", ["rev-parse", "--git-dir"], { cwd: path, timeoutMs: 5_000 });
  return result.code === 0;
}

/** Validate a whole selection before enrolling anything; subfolders resolve to their checkout root. */
export async function projectSelection(paths: readonly string[], exec: ProjectExec = run): Promise<string[]> {
  if (paths.length === 0 || paths.length > 50) throw new Error("Choose between 1 and 50 project folders.");
  const repos = new Set<string>();
  for (const path of paths) {
    if (!path.trim() || path.length > 4096) throw new Error("Choose a valid project folder.");
    const canonical = canonicalProject(path);
    if (canonical === null) throw new Error(`This folder is unavailable: ${path}`);
    const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: canonical, timeoutMs: 5000 });
    const root = result.code === 0 ? canonicalProject(result.stdout.trim()) : null;
    if (root === null) throw new Error(`This folder is not a Git project: ${path}`);
    repos.add(root);
  }
  return [...repos];
}

export type ProjectCeiling = {
  /** Canonical repo paths named at startup. */
  repos: readonly string[];
  /** Canonical directories: any git repo under one is authorized. */
  roots: readonly string[];
  /** How this ceiling resolves a path it is asked about (project-identity.ts): the console's saved identities, which
   * read no folder. Absent: canonicalProject, a synchronous read. */
  canon?: (path: string) => string | null;
};

/**
 * Resolve the startup configuration once. A configured path that does not
 * currently resolve is kept in its normalized form rather than dropped —
 * dropping would silently *widen* the server toward unscoped mode, and a
 * ceiling that loosens itself when a disk is unmounted is not a ceiling.
 */
export function resolveCeiling(
  repos: readonly string[],
  roots: readonly string[],
  canon: (path: string) => string | null | undefined = canonicalProject,
): { ceiling: ProjectCeiling; unresolved: string[] } {
  const unresolved: string[] = [];
  const keep = (paths: readonly string[]): string[] =>
    [...new Set(paths.map(path => {
      const canonical = canon(path) ?? null;
      if (canonical !== null) return canonical;
      unresolved.push(path);
      return resolve(path);
    }))];
  return { ceiling: { repos: keep(repos), roots: keep(roots) }, unresolved };
}

/** Whether the ceiling is even configured. Unconfigured = legacy unscoped mode. */
export function unscoped(ceiling: ProjectCeiling): boolean {
  return ceiling.repos.length === 0 && ceiling.roots.length === 0;
}

/**
 * The authorization question, answered from configuration alone. A path
 * under a root must additionally BE a git repository — a root authorizes
 * its repos, not every directory beneath it — which is why this is async.
 */
export async function authorizedProject(
  ceiling: ProjectCeiling,
  path: string,
  exec: ProjectExec = run,
): Promise<boolean> {
  if (unscoped(ceiling)) return true;
  const canonical = (ceiling.canon ?? canonicalProject)(path);
  if (canonical === null) return false;
  if (ceiling.repos.includes(canonical)) return true;
  for (const root of ceiling.roots) {
    if (canonical.startsWith(root + sep) && (await isGitRepo(canonical, exec))) return true;
  }
  return false;
}

/**
 * The cheap synchronous subset for per-row visibility checks: a row whose
 * repo is NULL (unplaced) is always visible; a named repo must match the
 * configured set or live under a root. The under-a-root case skips the
 * git check here — rows only enter the store through placement, which
 * validated them; this guards reads, and a non-repo directory under an
 * authorized root read-visible is a smaller wrong than an async row filter.
 */
export function rowVisible(ceiling: ProjectCeiling, repo: string | null): boolean {
  if (repo === null || unscoped(ceiling)) return true;
  // Exact saved identities are common. Check the whole set before resolving
  // aliases, so the hundredth project does not stat the other99 directories.
  const canon = ceiling.canon;
  if (ceiling.repos.includes(repo) || ceiling.repos.some(one => canon === undefined ? sameRepo(one, repo) : (canon(one) ?? null) !== null && canon(one) === canon(repo))) return true;
  // With a resolver (the console's saved identities), an identity it can't vouch for fails closed before any root is
  // matched: a path's spelling never stands in for where it leads.
  if (canon !== undefined) {
    const resolved = canon(repo);
    return resolved !== null && ceiling.roots.some(root => resolved.startsWith(root + sep));
  }
  const canonical = canonicalProject(repo) ?? repo;
  return ceiling.roots.some(root => canonical.startsWith(root + sep));
}

/** A display name for a project: its basename, the way people say it. */
export function projectName(path: string): string {
  return basename(path);
}

/**
 * A typed path with `~` spelled out as the home folder of the user Toolroll runs as: "~" and "~/…". A path naming
 * another user's home ("~alex/…") is null: the server never guesses whose folder that is.
 */
export function expandHomePath(path: string, home: string): string | null {
  if (path === "~") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  if (path.startsWith("~")) return null;
  return path;
}

/** Folders the system owns: a projects folder or an added repository is never one of these, nor inside one. */
export const SYSTEM_TREES = ["/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/dev", "/private", "/var", "/proc", "/sys", "/boot", "/run", "/lib", "/lib64", "/cores", "/Network"];
/** Folders that hold everyone's folders: never a projects folder themselves (a folder inside one may be). */
export const SYSTEM_TOPS = ["/Applications", "/Volumes", "/Users", "/home", "/opt", "/mnt", "/media", "/srv", "/tmp", "/root", "/snap"];

/** A folder as the console's bounded look found it (folder-look.ts `folderFacts`): its real path in the disk's own
 * spelling and the identity (device:inode, from bigint stats) of it and of every folder above it, itself first. */
export type FolderIdentity = { kind: "found"; real: string; dir: boolean; uid: number; chain: readonly string[] };
/** There (its identity); not there (ENOENT/ENOTDIR: its path, in the disk's spelling as far as the path exists); or a
 * read that failed any other way — never taken for "not there". */
export type FolderSeen = FolderIdentity | { kind: "missing"; path: string } | { kind: "unreadable" };

/** What a widening choice is compared with, each as the same look found it. */
export type FolderComparisons = {
  root: FolderSeen;
  home: FolderSeen;
  library: FolderSeen;
  /** Toolroll's own settings, records, evidence, tool secrets and task checkouts. */
  protectedDirs: readonly FolderSeen[];
  tops: readonly FolderSeen[];
  trees: readonly FolderSeen[];
};

/** The paths `folderRefusal` compares with, in the order `comparisonsOf` reads them back. */
export function comparisonPaths(home: string, protectedDirs: readonly string[]): string[] {
  return ["/", home, resolve(home, "Library"), ...protectedDirs, ...SYSTEM_TOPS, ...SYSTEM_TREES];
}
export function comparisonsOf(found: readonly FolderSeen[], protectedCount: number): FolderComparisons {
  const after = 3 + protectedCount;
  const unread: FolderSeen = { kind: "unreadable" };
  return {
    root: found[0] ?? unread, home: found[1] ?? unread, library: found[2] ?? unread,
    protectedDirs: found.slice(3, after), tops: found.slice(after, after + SYSTEM_TOPS.length), trees: found.slice(after + SYSTEM_TOPS.length),
  };
}

/**
 * Why a folder can't be the projects folder (`kind` "folder") or a repository can't be added ("repo"), or null.
 * Judged on identity, never spelling: a folder is "inside" another when that one's device and inode are among the
 * folders above it, so a case alias (`/users/…` on a case-insensitive disk), a firmlink or a link never passes for a
 * different folder. A folder compared with that isn't there (a pool or evidence folder not made yet) still excludes by
 * its path, compared without case; one that couldn't be read refuses outright (fail closed). Refused: the disk's top,
 * the home folder and anything holding it, ~/Library, any hidden folder (any name in its real path starting with "."),
 * anything holding or inside Toolroll's own state, the system's folders.
 */
export function folderRefusal(kind: "folder" | "repo", target: FolderIdentity, facts: FolderComparisons): string | null {
  const id = (one: FolderIdentity): string => one.chain[0]!;
  const lower = (path: string): string => path.toLowerCase();
  const underPath = (path: string, outer: string): boolean => lower(path) === lower(outer) || lower(path).startsWith(outer === "/" ? "/" : `${lower(outer)}/`);
  /** Whether `one` is `outer` or inside it; null when `outer` couldn't be read. */
  const within = (one: FolderIdentity, outer: FolderSeen): boolean | null =>
    outer.kind === "found" ? one.chain.includes(id(outer)) : outer.kind === "missing" ? underPath(one.real, outer.path) : null;
  /** Whether `inner` is `one` or inside it; null when `inner` couldn't be read. */
  const holds = (one: FolderIdentity, inner: FolderSeen): boolean | null =>
    inner.kind === "found" ? inner.chain.includes(id(one)) : inner.kind === "missing" ? underPath(inner.path, one.real) : null;
  const same = (one: FolderIdentity, other: FolderSeen): boolean | null =>
    other.kind === "found" ? id(other) === id(one) : other.kind === "missing" ? lower(other.path) === lower(one.real) : null;
  const cant = (why: string): string => kind === "folder" ? `${why} can’t be the projects folder` : `${why} can’t be added`;
  const unchecked = cant("a folder Toolroll couldn’t check against its own and the system’s folders");
  const { root, home, library } = facts;
  if (root.kind !== "found" || home.kind !== "found") return unchecked;
  if (id(target) === id(root)) return cant("the top of the disk");
  if (id(target) === id(home)) return kind === "folder" ? "your home folder itself can’t be the projects folder. Choose a folder inside it, like ~/Developer" : "your home folder itself can’t be added";
  if (holds(target, home)) return `that folder holds your home folder, so it can’t be ${kind === "folder" ? "the projects folder" : "added"}`;
  for (const dir of facts.protectedDirs) {
    const inDir = within(target, dir);
    // The home folder itself as a state folder (a database right in it) excludes only what is inside it, not home's own.
    const holdsDir = dir.kind === "found" && id(dir) === id(home) ? false : holds(target, dir);
    if (inDir === null || holdsDir === null) return unchecked;
    if ((dir.kind === "found" && id(dir) === id(home) ? false : inDir) || holdsDir) return cant("a folder holding Toolroll’s own settings, records or task checkouts");
  }
  const inLibrary = within(target, library);
  if (inLibrary === null) return unchecked;
  if (inLibrary) return cant("a folder in ~/Library");
  if (target.real.split("/").some(name => name.startsWith("."))) return cant("a hidden folder");
  if (within(target, home)) return null;
  for (const top of facts.tops) {
    const is = same(target, top);
    if (is === null) return unchecked;
    if (is) return cant("a system folder");
  }
  for (const tree of facts.trees) {
    const under = within(target, tree);
    if (under === null) return unchecked;
    if (under) return cant("a system folder");
  }
  return null;
}
