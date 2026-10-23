/**
 * What is waiting on a person.
 *
 * A pull request is where agent work stops being reversible, so it is where the
 * operator's attention actually has to land. The question this module answers is
 * not "what pull requests exist" but "which of these is waiting on me, and for
 * how long has it been waiting" — the case that motivated it was two finished,
 * green, unflagged pull requests that sat open for two months because nothing
 * ever said so.
 *
 * Three rules shape the classification.
 *
 * Absence of a verdict is not a negative verdict. GitHub computes mergeability
 * lazily, so `UNKNOWN` means not yet computed and must never be reported as a
 * conflict. Likewise an empty check rollup means no checks are configured, not
 * that checks passed.
 *
 * A failure outranks work still in progress. If one check has failed while
 * others are queued, the failure is already actionable and saying "running"
 * would defer a decision that can be made now.
 *
 * Nothing here reaches the network or the filesystem except `readPulls`, so the
 * part worth testing needs no fixture repository and no GitHub account.
 */

import { run, type ExecResult, type RunOptions } from "./exec.js";

/** Whose move it is. `none` means nobody is blocked — the author is still writing. */
export type Attention = "human" | "agent" | "machine" | "none";

export type ChecksState = "passing" | "failing" | "running" | "none";

export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export type Pull = {
  number: number;
  title: string;
  branch: string;
  url: string;
  isDraft: boolean;
  /** UNKNOWN means GitHub has not computed it yet, not that it conflicts. */
  mergeable: Mergeable;
  checks: ChecksState;
  createdAt: string;
  updatedAt: string;
};

export type PullsRead = {
  pulls: Pull[];
  /** What could not be read, in words. Never silently dropped. */
  problems: string[];
};

export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

export type ReadPullsOptions = {
  runner?: Runner;
  limit?: number;
  /** Overridden when a caller is spending a shared budget; see `remote.ts`. */
  timeoutMs?: number;
};

const GH = "gh";

/** A pull request read crosses the network, so it gets a network-sized bound. */
export const PULL_TIMEOUT_MS = 20_000;

/**
 * Enough to cover a backlog without paginating. A repository with more open
 * pull requests than this has a problem no report is going to solve.
 */
export const DEFAULT_PULL_LIMIT = 50;

/**
 * Long enough that a busy person is not nagged about this morning's work, short
 * enough to catch the case above. A four-day content routine clears this only
 * when nobody looked at the previous run.
 */
export const DEFAULT_STALE_DAYS = 3;

/**
 * The convention this repository's reviewers already use to send a draft back.
 * Callers override it; it is a default, not a rule imposed on anyone.
 */
export const DEFAULT_REVISION_MARKERS = ["[NEEDS REVISION]"] as const;

const FIELDS = [
  "number",
  "title",
  "headRefName",
  "url",
  "isDraft",
  "mergeable",
  "createdAt",
  "updatedAt",
  "statusCheckRollup",
].join(",");

/** Conclusions that mean the check finished and did not succeed. */
const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "CANCELLED",
]);
/** Not-yet-finished states, spelled differently by check runs and status contexts. */
const PENDING = new Set(["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"]);

const MS_PER_DAY = 86_400_000;

/**
 * Open pull requests for the repository at `path`.
 *
 * Failure comes back as a problem rather than an exception, for the same reason
 * discovery never throws: a repository with no GitHub remote, or an operator who
 * has not logged in, must not end a report covering everything else.
 */
export async function readPulls(path: string, options: ReadPullsOptions = {}): Promise<PullsRead> {
  const { runner = run, limit = DEFAULT_PULL_LIMIT, timeoutMs = PULL_TIMEOUT_MS } = options;

  const result = await runner(
    GH,
    ["pr", "list", "--state", "open", "--limit", String(limit), "--json", FIELDS],
    { cwd: path, timeoutMs },
  );

  if (result.notFound) {
    return { pulls: [], problems: ["gh is not installed — pull requests were not read"] };
  }
  if (result.timedOut) {
    return { pulls: [], problems: ["could not read pull requests: timed out"] };
  }
  if (result.code !== 0) {
    return { pulls: [], problems: [`could not read pull requests: ${firstLine(result.stderr)}`] };
  }

  const parsed = parsePulls(result.stdout);
  if (parsed === null) {
    return {
      pulls: [],
      problems: ["could not read pull requests: gh returned something unreadable"],
    };
  }
  return { pulls: parsed, problems: [] };
}

/**
 * Parse `gh pr list --json`. Returns null when the payload is not the array it
 * should be; individual records of the wrong shape are dropped rather than
 * trusted, because this is another program's output and not our own.
 */
export function parsePulls(json: string): Pull[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  return parsed.map(readPull).filter((pull): pull is Pull => pull !== null);
}

function readPull(record: unknown): Pull | null {
  if (typeof record !== "object" || record === null) return null;
  const raw = record as Record<string, unknown>;

  const number = raw["number"];
  if (typeof number !== "number") return null;

  return {
    number,
    title: readString(raw["title"]),
    branch: readString(raw["headRefName"]),
    url: readString(raw["url"]),
    isDraft: raw["isDraft"] === true,
    mergeable: readMergeable(raw["mergeable"]),
    checks: summarizeChecks(raw["statusCheckRollup"]),
    createdAt: readString(raw["createdAt"]),
    updatedAt: readString(raw["updatedAt"]),
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readMergeable(value: unknown): Mergeable {
  if (value === "MERGEABLE" || value === "CONFLICTING") return value;
  return "UNKNOWN";
}

/**
 * Collapse the check rollup to one state.
 *
 * An empty rollup is `none`, not `passing`: a repository with no CI has not
 * told us anything, and treating silence as approval is how a broken change
 * gets reported as ready. SKIPPED is likewise not a failure — a job whose `if`
 * guard excluded it did exactly what it was written to do.
 */
export function summarizeChecks(rollup: unknown): ChecksState {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";

  const states = rollup.map(readCheckState);
  if (states.includes("failing")) return "failing";
  if (states.includes("running")) return "running";
  return "passing";
}

/** The checks that finished and did not succeed, by the name GitHub shows, with their details page when one is given. */
export function failingChecks(rollup: unknown): { name: string; url: string | null }[] {
  if (!Array.isArray(rollup)) return [];
  return rollup.filter(entry => readCheckState(entry) === "failing").map(entry => {
    const raw = entry as Record<string, unknown>;
    const name = readString(raw["name"]) || readString(raw["context"]) || "a check";
    const url = readString(raw["detailsUrl"]) || readString(raw["targetUrl"]);
    return { name, url: url === "" ? null : url };
  });
}

function readCheckState(entry: unknown): ChecksState {
  if (typeof entry !== "object" || entry === null) return "none";
  const raw = entry as Record<string, unknown>;

  // Check runs report `status` then `conclusion`; status contexts report `state`.
  const status = readString(raw["status"]);
  const conclusion = readString(raw["conclusion"]);
  const state = readString(raw["state"]);

  if (PENDING.has(status) || PENDING.has(state)) return "running";
  if (FAILED.has(conclusion) || FAILED.has(state)) return "failing";
  return "passing";
}

/**
 * Whose move it is.
 *
 * Note the two that look alike and are not. A pull request sent back with a
 * revision marker is waiting on the agent, because a person already looked and
 * said what they wanted. One that is simply green and open is waiting on a
 * person, because nobody has looked at all.
 */
export function classify(
  pull: Pull,
  markers: readonly string[] = DEFAULT_REVISION_MARKERS,
): Attention {
  if (pull.isDraft) return "none";
  if (isFlagged(pull, markers)) return "agent";
  if (pull.mergeable === "CONFLICTING") return "agent";
  if (pull.checks === "failing") return "agent";
  if (pull.checks === "running") return "machine";
  return "human";
}

export function isFlagged(
  pull: Pull,
  markers: readonly string[] = DEFAULT_REVISION_MARKERS,
): boolean {
  const title = pull.title.toUpperCase();
  return markers.some(marker => title.includes(marker.toUpperCase()));
}

/**
 * Why it is waiting, in the words the operator would use. Kept beside
 * `classify` so a new state cannot be added to one without the other.
 */
export function describe(
  pull: Pull,
  markers: readonly string[] = DEFAULT_REVISION_MARKERS,
): string {
  if (pull.isDraft) return "still a draft";
  if (isFlagged(pull, markers)) return "sent back for revision";
  if (pull.mergeable === "CONFLICTING") return "conflicts with the base branch";
  if (pull.checks === "failing") return "checks failing";
  if (pull.checks === "running") return "checks still running";
  if (pull.checks === "none") return "ready, no checks configured";
  return "ready to merge";
}

/**
 * Idle days, measured from the last time anything happened rather than from
 * opening. A pull request being actively discussed is not stalled however old
 * it is. Null when the timestamp could not be read, which is absence of data
 * and not evidence of freshness.
 */
export function idleDays(pull: Pull, now: Date): number | null {
  const updated = Date.parse(pull.updatedAt);
  if (Number.isNaN(updated)) return null;
  return Math.max(0, (now.getTime() - updated) / MS_PER_DAY);
}

function firstLine(text: string): string {
  const [line = ""] = text.trim().split("\n");
  return line;
}
