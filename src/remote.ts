/**
 * The half of "in flight" that is not on this machine.
 *
 * Branches come off the local filesystem in milliseconds. Pull requests and
 * issues are a network round trip per repository, and that difference is the
 * whole reason this is a separate module with a budget attached rather than
 * three more lines inside discovery.
 *
 * An earlier draft kept these behind their own command precisely because of
 * the cost, and the milestone still asks for one command that shows every
 * branch, pull request, and issue in flight. Both concerns are real, so this
 * follows the rule the rest of the tool already uses for expensive reads:
 * price it, bound it, and **say what you withheld**. Twenty-four repositories
 * on hotel wifi will not hang; they will come back with what fitted in the
 * budget and a line naming what did not.
 *
 * The budget is for the whole phase, not per repository. A per-call timeout
 * bounds the worst case at repos × timeout, which for a machine full of work
 * is not a bound anybody would recognise as one.
 */

import { readPulls, type Pull } from "./pulls.js";
import { githubIssues } from "./issues.js";
import type { BackendTask, Runner } from "./backend.js";

export type RemoteState = {
  pulls: Pull[];
  issues: BackendTask[];
  /**
   * Whether each read actually succeeded.
   *
   * An empty list means nothing without these. A repository with issues
   * switched off, one whose token expired, and one that genuinely has no open
   * issues all produce `issues: []`, and only the first two are a reason to
   * stop trusting the number above it.
   */
  pullsRead: boolean;
  issuesRead: boolean;
  /** What could not be read, in words. */
  problems: string[];
  /** True when the budget ran out before this repository was asked. */
  skipped: boolean;
};

export type RemoteOptions = {
  runner?: Runner;
  /** Total wall clock for the whole phase, not per repository. */
  budgetMs?: number;
  concurrency?: number;
  now?: () => number;
  issueLimit?: number;
};

/**
 * Long enough for a dozen repositories on an ordinary connection, short enough
 * that somebody who typed a command still feels like it answered.
 */
export const DEFAULT_BUDGET_MS = 15_000;

/** GitHub is the bottleneck here, not the local machine. */
export const DEFAULT_REMOTE_CONCURRENCY = 6;

export const EMPTY: RemoteState = {
  pulls: [],
  issues: [],
  pullsRead: false,
  issuesRead: false,
  problems: [],
  skipped: false,
};

/**
 * Read pull requests and issues for each repository, within one budget.
 *
 * Only repositories that look like they are on a remote are asked; a local-only
 * repo has no pull requests by definition, and spending part of a shared budget
 * to be told so would come out of the repositories that do.
 */
export async function readRemote(
  repos: readonly { path: string; remoteUrl: string | null }[],
  options: RemoteOptions = {},
): Promise<Map<string, RemoteState>> {
  const {
    runner,
    budgetMs = DEFAULT_BUDGET_MS,
    concurrency = DEFAULT_REMOTE_CONCURRENCY,
    now = () => Date.now(),
    issueLimit,
  } = options;

  const state = new Map<string, RemoteState>();
  const wanted = repos.filter(repo => repo.remoteUrl !== null);
  for (const repo of repos) state.set(repo.path, { ...EMPTY });

  if (wanted.length === 0) return state;

  const deadline = now() + budgetMs;
  let next = 0;

  const consume = async (): Promise<void> => {
    while (next < wanted.length) {
      const repo = wanted[next++];
      if (repo === undefined) return;

      // Checked before each repository rather than after: once the budget is
      // spent, every remaining repository is marked and none of them waits.
      const remaining = deadline - now();
      if (remaining <= 0) {
        state.set(repo.path, { ...EMPTY, skipped: true });
        continue;
      }

      try {
        // The per-call timeout is clamped to what is left of the budget. A
        // deadline checked only before starting is not a bound: with six lanes
        // and a twenty-second call timeout, six repositories begun a moment
        // before the budget expires run twenty seconds past it. Handing each
        // call the remaining time makes the budget mean what it says.
        state.set(repo.path, await readOne(repo.path, runner, issueLimit, remaining));
      } catch (error) {
        // A runner that throws rather than returning a failure must not end a
        // report covering everything else — the same rule discovery follows.
        state.set(repo.path, {
          ...EMPTY,
          problems: [`could not read ${repo.path}: ${describe(error)}`],
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, wanted.length)) }, consume),
  );
  return state;
}

async function readOne(
  path: string,
  runner: Runner | undefined,
  issueLimit: number | undefined,
  timeoutMs: number,
): Promise<RemoteState> {
  const issues = githubIssues({
    repo: path,
    timeoutMs,
    ...(runner === undefined ? {} : { runner }),
    ...(issueLimit === undefined ? {} : { limit: issueLimit }),
  });

  // Both round trips at once: they are independent, and doing them in sequence
  // would double the time this repository costs the shared budget.
  const [pulls, listed] = await Promise.all([
    readPulls(path, { timeoutMs, ...(runner === undefined ? {} : { runner }) }),
    issues.listReady(),
  ]);

  const problems = [...pulls.problems];
  // Every failed read is said out loud. An earlier version swallowed the
  // `unreachable` ones as though they meant "issues are switched off here",
  // but that bucket also holds an expired token, a rate limit, and a dropped
  // connection — and reporting any of those as `issues: []` turns "we could
  // not look" into "there is nothing there", which is the one thing this
  // report must never do.
  if (!listed.ok) problems.push(`could not read issues: ${listed.message}`);

  return {
    pulls: pulls.pulls,
    issues: listed.ok ? listed.value : [],
    pullsRead: pulls.problems.length === 0,
    issuesRead: listed.ok,
    problems,
    skipped: false,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
