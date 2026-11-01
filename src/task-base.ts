/**
 * Where a task's work starts, against current main (fresh base): one view for
 * the task page and `task show`. The base is saved run lineage — a builder
 * branch's pinned origin, or the newest plan's base — and the behind count is
 * read from Git now. Reads only.
 */

import { viewedGitSync } from "./teardown-git.js";
import type { Store } from "./store.js";

export type TaskBaseView = {
  /** The base commit, in full. */
  base: string;
  branch: string;
  /** The project's main: its checked-out branch, as a dispatch pass resolves it. Null when Git could not say. */
  main: string | null;
  /** Commits on main the base does not have; null when Git could not say. */
  behind: number | null;
  /** One short line: `Base 9d087efe · Behind main by 2 commits`. */
  words: string;
};

/** A synchronous, read-only Git call in `cwd`: its trimmed output, or null on any failure. */
export type GitRead = (cwd: string, args: readonly string[]) => string | null;

export const readGit: GitRead = (cwd, args) => {
  try {
    // Every git version through a frozen read view, bounded (eval-harness review 1, finding 7): a partial clone, an
    // include or a command-naming key is refused from the config git then runs with.
    const ran = viewedGitSync(cwd, args, { timeoutMs: 5_000, maxBuffer: 65_536 });
    return ran.status === 0 ? ran.stdout.trim() : null;
  } catch {
    return null;
  }
};

const commits = (count: number) => `${count} commit${count === 1 ? "" : "s"}`;

/** The base line on its own, for surfaces that label it already: `9d087efe · Behind main by 2 commits`. */
export function baseStandingWords(view: Pick<TaskBaseView, "base" | "main" | "behind">): string {
  const short = view.base.slice(0, 8);
  if (view.main === null || view.behind === null) return short;
  return view.behind === 0 ? `${short} · Up to date with ${view.main}` : `${short} · Behind ${view.main} by ${commits(view.behind)}`;
}

/**
 * The lease's fresh-base request for one attempt on `branch`, or nothing when the task's start is pinned elsewhere: a
 * revision keeps the head of the attempt it revises, and a prepared candidate or coding review keeps the base its
 * candidate was proved against.
 */
export function freshBaseFor(store: Store, taskId: string, branch: string, main: string): { freshBase: { main: string; recordedBase: string | null } } | Record<string, never> {
  const ref = store.lookupRef(taskId);
  if (ref === null || ref.revisionOf !== null || store.getScope(taskId)?.candidate != null || store.filedViaOf(taskId)?.startsWith("coding:") === true) return {};
  return { freshBase: { main, recordedBase: store.recordedBranchBase(ref.id, branch) } };
}

export function taskBaseOf(store: Store, taskId: string, git: GitRead = readGit): TaskBaseView | null {
  const ref = store.lookupRef(taskId);
  if (ref === null || ref.repo === null) return null;
  const latest = store.runsFor(ref.id).find(one => one.role !== "reviewer" && one.branch !== null && one.baseRevision !== null);
  if (latest === undefined || latest.branch === null || latest.baseRevision === null) return null;
  const branch = latest.branch;
  // A move to current main newer than the latest attempt is where the next one starts.
  const move = store.latestBranchBaseMove(ref.id, branch);
  const base = move !== null && move.afterRun >= latest.id ? move.to : store.recordedBranchBase(ref.id, branch) ?? latest.baseRevision;
  const main = git(ref.repo, ["symbolic-ref", "--short", "-q", "HEAD"]) || null;
  const counted = main === null ? null : git(ref.repo, ["rev-list", "--count", `${base}..refs/heads/${main}`]);
  const behind = counted === null || !/^\d+$/.test(counted) ? null : Number(counted);
  const view = { base, branch, main: behind === null ? null : main, behind };
  return { ...view, words: `Base ${baseStandingWords(view)}` };
}

/** `git`'s answers kept for `ttlMs` (at most `entries` of them), for a page that shows the base line on every refresh:
 * each read still goes through the same frozen view when it runs; only its answer is reused for a moment. Display only —
 * never for a decision. */
export function recentGitReads(git: GitRead = readGit, ttlMs = 15_000, entries = 64, now: () => number = Date.now): GitRead {
  const kept = new Map<string, { at: number; value: string | null }>();
  return (cwd, args) => {
    const key = JSON.stringify([cwd, args]), at = now(), hit = kept.get(key);
    if (hit !== undefined && at - hit.at < ttlMs && at >= hit.at) return hit.value;
    const value = git(cwd, args);
    kept.delete(key);
    if (kept.size >= entries) kept.delete(kept.keys().next().value!);
    kept.set(key, { at, value });
    return value;
  };
}
