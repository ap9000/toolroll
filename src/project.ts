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

export type ProjectExec = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

/**
 * One canonicalization for every path that becomes project identity:
 * startup config, a session open, task placement. Comparisons elsewhere
 * fall back to raw equality for legacy rows written before this existed.
 */
export function canonicalProject(path: string): string | null {
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
  const canonical = (canon ?? canonicalProject)(repo) ?? repo;
  return ceiling.roots.some(root => canonical.startsWith(root + sep));
}

/** A display name for a project: its basename, the way people say it. */
export function projectName(path: string): string {
  return basename(path);
}
