/**
 * Reading the state of repositories.
 *
 * Every git invocation here is a read, and every one is prefixed with
 * `--no-optional-locks` — Toolroll scans repositories the operator may be
 * working in right now, and a discovery pass must never contend for the index
 * lock with their editor.
 *
 * Nothing raises. A repository that cannot be read comes back as a snapshot
 * carrying a named problem, because the alternative is a scan of forty repos
 * ending on the one that is broken.
 *
 * The reads are deliberately unequal in cost, and that shapes the module.
 * Listing refs, worktrees and the remote is O(refs) and lands in tens of
 * milliseconds. Computing ahead/behind walks history per branch — measured at
 * 22s on a cold 304MB repo — so it is bounded and degrades to a branch list
 * without it. Reading the working tree is O(working tree), measured at over
 * two minutes, so it does not happen at all unless asked for.
 */

import { basename } from "node:path";
import { run, type ExecResult, type RunOptions } from "./exec.js";
import { checkoutGit } from "./teardown-git.js";
import { parseWorktrees, parseBranches, type Branch, type Worktree } from "./git.js";
import { findRepos, type ScanOptions } from "./scan.js";

export type RepoSnapshot = {
  path: string;
  name: string;
  /** Current branch, or null in detached HEAD. */
  head: string | null;
  remoteUrl: string | null;
  branches: Branch[];
  worktrees: Worktree[];
  /** Uncommitted files, or null when the working tree was not read. */
  dirtyFiles: number | null;
  /**
   * Whether ahead/behind could be computed. False means every branch carries a
   * zeroed track, which is absence of data and not evidence of being in sync —
   * a distinction the report has to respect or it hides the whole repository.
   */
  hasTracking: boolean;
  /** What could not be read, in words. Never silently dropped. */
  problems: string[];
};

export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

export type InspectOptions = {
  runner?: Runner;
  /** Read the working tree for uncommitted changes. Off by default: see above. */
  dirty?: boolean;
};

export type DiscoverOptions = InspectOptions & {
  scan?: ScanOptions;
  concurrency?: number;
};

/** Enough to keep git busy without turning a laptop fan on. */
export const DEFAULT_CONCURRENCY = 8;

/** Ref reads land in tens of milliseconds; seconds here means something is wrong. */
export const REF_TIMEOUT_MS = 5_000;
/**
 * Ahead/behind is worth waiting for, since it is the signal itself. Ten
 * seconds because a 59MB repo with 18 branches and no commit-graph measured
 * 7.5s cold — just over a five second bound, which is the worst place for a
 * limit to sit.
 */
export const TRACK_TIMEOUT_MS = 10_000;
/** The working tree is unbounded, so the bound has to be ours. */
export const STATUS_TIMEOUT_MS = 10_000;

const GIT = "git";
/** Read-only, and refuses to take the index lock it would otherwise want. */
const READ_ONLY = ["--no-optional-locks"] as const;
const HEADS = "refs/heads";
const BRANCH_FORMAT =
  "--format=%(refname:short)%09%(upstream:track)%09%(committerdate:iso8601-strict)";
/** The same three columns with the expensive one left empty. */
const BRANCH_FORMAT_CHEAP = "--format=%(refname:short)%09%09%(committerdate:iso8601-strict)";

type Git = (args: readonly string[], timeoutMs?: number) => Promise<ExecResult>;
type BranchRead = { result: ExecResult; degraded: boolean };

export async function inspectRepo(path: string, options: InspectOptions = {}): Promise<RepoSnapshot> {
  const { runner = run, dirty = false } = options;
  // Scanned and enrolled projects share their repository with every build, which can write its config, info and hooks
  // (`--dirty`'s status would run a planted fsmonitor or filter): the hardened git, against a frozen view of the
  // repository (teardown-git.ts checkoutGit). An injected runner (tests) is used as given.
  const hardened = runner === run ? checkoutGit(run, "build") : runner;
  const git: Git = (args, timeoutMs = REF_TIMEOUT_MS) =>
    hardened(GIT, [...READ_ONLY, ...args], { cwd: path, timeoutMs });

  const [worktrees, branchRead, head, remote, status] = await Promise.all([
    git(["worktree", "list", "--porcelain"]),
    readBranches(git),
    git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(["remote", "get-url", "origin"]),
    dirty ? git(["status", "--porcelain"], STATUS_TIMEOUT_MS) : null,
  ]);

  // One missing binary is one problem, not five identical ones.
  if (worktrees.notFound) {
    return { ...emptySnapshot(path), problems: ["git is not installed"] };
  }

  const branches = branchRead.result;
  const problems = [
    describeProblem("read worktrees", worktrees),
    describeProblem("read branches", branches),
    branchRead.degraded
      ? `ahead/behind skipped: it took over ${TRACK_TIMEOUT_MS / 1000}s to compute here`
      : null,
    status === null ? null : describeProblem("read the working tree", status),
  ].filter((problem): problem is string => problem !== null);

  return {
    path,
    name: basename(path),
    // A failed symbolic-ref means detached HEAD, which is a state and not a fault.
    head: head.code === 0 ? head.stdout.trim() : null,
    // A repo with no origin is ordinary; reporting it as an error would be noise.
    remoteUrl: remote.code === 0 ? remote.stdout.trim() : null,
    branches: branches.code === 0 ? parseBranches(branches.stdout) : [],
    worktrees: worktrees.code === 0 ? parseWorktrees(worktrees.stdout) : [],
    dirtyFiles: status !== null && status.code === 0 ? countLines(status.stdout) : null,
    hasTracking: branches.code === 0 && !branchRead.degraded,
    problems,
  };
}

/**
 * Ahead/behind is the whole point of the report, so it is tried first — but a
 * branch list without it beats a timeout with nothing in it.
 */
async function readBranches(git: Git): Promise<BranchRead> {
  const rich = await git(["for-each-ref", BRANCH_FORMAT, HEADS], TRACK_TIMEOUT_MS);
  if (!rich.timedOut) return { result: rich, degraded: false };

  const cheap = await git(["for-each-ref", BRANCH_FORMAT_CHEAP, HEADS], REF_TIMEOUT_MS);
  return { result: cheap, degraded: cheap.code === 0 };
}

/**
 * Inspect known repositories, skipping the walk entirely. Enrolled paths are
 * already the answer to "which repositories" — searching for them again would
 * be the tool distrusting a list the operator wrote down.
 */
export async function inspectAll(
  paths: readonly string[],
  options: InspectOptions & { concurrency?: number } = {},
): Promise<RepoSnapshot[]> {
  const { runner = run, dirty = false, concurrency = DEFAULT_CONCURRENCY } = options;
  return mapWithConcurrency(paths, concurrency, path => inspectRepo(path, { runner, dirty }));
}

/** Every repository at or below `roots`, inspected with bounded concurrency. */
export async function discover(
  roots: readonly string[],
  options: DiscoverOptions = {},
): Promise<RepoSnapshot[]> {
  const { scan, ...rest } = options;
  return inspectAll(await findRepos(roots, scan), rest);
}

function emptySnapshot(path: string): RepoSnapshot {
  return {
    path,
    name: basename(path),
    head: null,
    remoteUrl: null,
    branches: [],
    worktrees: [],
    dirtyFiles: null,
    hasTracking: false,
    problems: [],
  };
}

function describeProblem(action: string, result: ExecResult): string | null {
  if (result.code === 0) return null;
  if (result.timedOut) return `could not ${action}: timed out`;
  return `could not ${action}: ${firstLine(result.stderr)}`;
}

function firstLine(text: string): string {
  const [line = ""] = text.trim().split("\n");
  return line;
}

function countLines(text: string): number {
  return text.split("\n").filter(line => line.trim() !== "").length;
}

/**
 * Results stay in input order regardless of completion order, so the output of
 * a scan does not depend on which repository happened to answer first.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const consume = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      const item = items[index] as T;
      results[index] = await worker(item);
    }
  };

  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, consume));
  return results;
}
