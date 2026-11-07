/**
 * GitHub CI attempts as mixed outcomes (docs/plans/learning-loops.md, "A CI observation"): read-only, lane level, never
 * mixed with local pairs, no test name (logs aren't fetched). Only workflow runs Toolroll already knows by id are read:
 * the watched branch's push runs (`branch_check_run`) and the nightly's runs (`github_nightly_watch`). PR runs aren't
 * read: Toolroll records no run id for them.
 *
 * For a run on attempt n > 1, attempts n-1 and n are read with the exact-attempt reader and paired per lane. A pairing
 * needs exactly one job per lane in each attempt, both attempts read whole, the same run and commit, an earlier
 * `failure` that got past setup and a later `success`. Anything else is rejected and counted, never guessed.
 *
 * The only writer of `ci_flaky_observation` and `ci_pairing_rejected`. Nothing here reruns anything or changes a check,
 * a verdict or an approval. A policy path (release-auto.ts EVAL_POLICY).
 */
import { createHash } from "node:crypto";
import { failedBeforeTests } from "./github-jobs.js";
import { githubNightlyOf, laneIdOf, readAttemptJobs, readRun, resolveLane, type GhJob, type GhRead } from "./nightly-github.js";
import type { Store } from "./store.js";

/** How old a known run may be and still be read, how many runs one pass reads, and each read's limit. */
const RECENT_MS = 14 * 86_400_000;
const RUNS_PER_PASS = 30;
const READ_MS = 15_000;
/** How often a project is read at most. */
export const CI_READ_EVERY_MS = 30 * 60_000;
const RETAIN_MS = 180 * 86_400_000;

/** The service cursor a project's reads keep (a cursor key can't hold a path). */
export const ciCursorKey = (repo: string): string => `flaky-ci:${createHash("sha256").update(repo).digest("hex").slice(0, 32)}`;

/** The GitHub repositories this project's records name: the nightly's opt-in and its failed-checks triggers. */
export function ciRepositoriesOf(store: Store, repo: string): string[] {
  const slugs = new Set<string>();
  const nightly = githubNightlyOf(store, repo);
  if (nightly !== null) slugs.add(nightly.slug);
  for (const row of store.handle.prepare("SELECT t.config_json FROM flow_trigger t JOIN flow f ON f.id = t.flow WHERE f.repo = ?").all(repo)) {
    try {
      const config = JSON.parse(String(row["config_json"])) as { kind?: unknown; watch?: unknown; repo?: unknown };
      if (config.kind === "github" && config.watch === "checks" && typeof config.repo === "string") slugs.add(config.repo);
    } catch { /* an unreadable trigger names nothing */ }
  }
  return [...slugs];
}

/** The runs Toolroll knows by id for this project and repository, newest first. */
function knownRuns(store: Store, repo: string, slug: string, now: Date): { id: number; sha: string | null }[] {
  const since = new Date(now.getTime() - RECENT_MS).toISOString();
  const branch = store.handle.prepare("SELECT run_id, head_sha FROM branch_check_run WHERE lower(repo) = lower(?) AND run_created_at >= ? ORDER BY run_created_at DESC, run_id DESC LIMIT ?").all(slug, since, RUNS_PER_PASS)
    .map(row => ({ id: Number(row["run_id"]), sha: String(row["head_sha"]) }));
  const nightly = githubNightlyOf(store, repo)?.slug.toLowerCase() === slug.toLowerCase()
    ? store.handle.prepare("SELECT gh_run FROM github_nightly_watch WHERE repo = ? AND created_at >= ? ORDER BY created_at DESC, gh_run DESC LIMIT ?").all(repo, since, RUNS_PER_PASS).map(row => ({ id: Number(row["gh_run"]), sha: null }))
    : [];
  const seen = new Set<number>();
  return [...branch, ...nightly].filter(one => !seen.has(one.id) && seen.add(one.id) !== undefined).slice(0, RUNS_PER_PASS);
}

export type CiPassResult = { read: number; observed: number; rejected: number };

/** Pair one run's attempts n-1 and n. A pair already decided isn't read again. */
export async function observeCiRun(store: Store, input: { repo: string; slug: string; run: number; sha: string | null; gh: GhRead; now: Date }): Promise<{ observed: number; rejected: number }> {
  const { repo, slug, now } = input;
  const get = (path: string) => input.gh(path, READ_MS);
  const run = await readRun(get, slug, input.run);
  const at = now.toISOString();
  const rejectedRows: { attempt: number; lane: string | null; why: string }[] = [];
  const pairs: { lane: string; name: string; workflow: string; head: string; failed: GhJob; passed: GhJob; failedAttempt: number; passedAttempt: number }[] = [];
  const reject = (attempt: number, lane: string | null, why: string): void => { rejectedRows.push({ attempt, lane, why: lane === null ? why : `${why}: ${lane}` }); };
  if (run === null) return { observed: 0, rejected: 0 };
  if (run.runAttempt <= 1 || run.status !== "completed") return { observed: 0, rejected: 0 };
  const later = run.runAttempt, earlier = later - 1;
  const decided = store.handle.prepare("SELECT 1 FROM ci_flaky_observation WHERE provider = 'github' AND repository = ? AND workflow_run_id = ? AND passed_attempt = ? UNION ALL SELECT 1 FROM ci_pairing_rejected WHERE provider = 'github' AND repository = ? AND workflow_run_id = ? AND attempt = ? LIMIT 1")
    .get(slug, input.run, later, slug, input.run, later);
  if (decided !== undefined) return { observed: 0, rejected: 0 };
  if (input.sha !== null && input.sha !== run.headSha) reject(later, null, "the run's commit isn't the one recorded");
  else {
    const before = await readAttemptJobs(get, slug, run.id, earlier, run.headSha);
    const after = await readAttemptJobs(get, slug, run.id, later, run.headSha);
    if (before === null || after === null) reject(later, null, "an attempt couldn't be read whole");
    else {
      const laneOf = (job: GhJob): string => resolveLane(store, repo, run.path, job.name) ?? laneIdOf(run.path, job.name);
      const group = (jobs: readonly GhJob[]) => { const lanes = new Map<string, GhJob[]>(); for (const job of jobs) lanes.set(laneOf(job), [...(lanes.get(laneOf(job)) ?? []), job]); return lanes; };
      const was = group(before), now2 = group(after);
      for (const lane of new Set([...was.keys(), ...now2.keys()])) {
        const a = was.get(lane) ?? [], b = now2.get(lane) ?? [];
        if (a.length > 1 || b.length > 1) { reject(later, lane, "more than one job with this name"); continue; }
        if (a.length === 0 || b.length === 0) { reject(later, lane, "the job isn't in both attempts"); continue; }
        const first = a[0]!, second = b[0]!;
        // A lane that passed both times is the ordinary case, not a pairing refused.
        if (first.conclusion === "success" && second.conclusion === "success") continue;
        if (first.conclusion !== "failure" || second.conclusion !== "success") { reject(later, lane, `not failure then success (${first.conclusion ?? "no conclusion"}, ${second.conclusion ?? "no conclusion"})`); continue; }
        if (first.steps === null || failedBeforeTests({ id: first.id, status: first.status, conclusion: first.conclusion, steps: first.steps })) { reject(later, lane, "it failed before its tests ran"); continue; }
        pairs.push({ lane, name: first.name, workflow: run.path, head: run.headSha, failed: first, passed: second, failedAttempt: earlier, passedAttempt: later });
      }
    }
  }
  let observed = 0, rejected = 0;
  store.transact(() => {
    for (const one of pairs) {
      observed += Number(store.handle.prepare(`INSERT INTO ci_flaky_observation (repo, provider, repository, workflow, lane_id, lane_name, workflow_run_id, head_sha, failed_attempt, failed_job_id, failed_conclusion,
          passed_attempt, passed_job_id, passed_conclusion, observed_at) VALUES (?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (provider, repository, workflow_run_id, lane_id, failed_attempt, passed_attempt) DO NOTHING`)
        .run(repo, slug, one.workflow, one.lane, one.name, input.run, one.head, one.failedAttempt, one.failed.id, one.failed.conclusion, one.passedAttempt, one.passed.id, one.passed.conclusion, at).changes);
    }
    for (const one of rejectedRows) {
      rejected += Number(store.handle.prepare(`INSERT INTO ci_pairing_rejected (provider, repository, workflow_run_id, attempt, lane_id, why, at) VALUES ('github', ?, ?, ?, ?, ?, ?)
        ON CONFLICT (provider, repository, workflow_run_id, attempt, why) DO NOTHING`).run(slug, input.run, one.attempt, one.lane, one.why.slice(0, 400), at).changes);
    }
  });
  return { observed, rejected };
}

/** One project's pass over its known runs. A read that fails records nothing and is tried on the next pass. */
export async function observeCiAttempts(store: Store, repo: string, gh: GhRead, now: Date): Promise<CiPassResult> {
  const result: CiPassResult = { read: 0, observed: 0, rejected: 0 };
  for (const slug of ciRepositoriesOf(store, repo)) {
    for (const known of knownRuns(store, repo, slug, now)) {
      const done = await observeCiRun(store, { repo, slug, run: known.id, sha: known.sha, gh, now });
      result.read++; result.observed += done.observed; result.rejected += done.rejected;
    }
  }
  return result;
}

/** The storage sweep's own step: CI rows older than the retention window go; nothing else deletes them. */
export function pruneCiObservations(store: Store, now: Date): number {
  const cut = new Date(now.getTime() - RETAIN_MS).toISOString();
  const observed = store.handle.prepare("DELETE FROM ci_flaky_observation WHERE observed_at < ?").run(cut);
  const rejected = store.handle.prepare("DELETE FROM ci_pairing_rejected WHERE at < ?").run(cut);
  return Number(observed.changes) + Number(rejected.changes);
}

/** Pairings refused since `since` for these repositories. */
export function ciNotPaired(store: Store, repositories: readonly string[], since: string): number {
  if (repositories.length === 0) return 0;
  return Number(store.handle.prepare("SELECT COUNT(*) AS n FROM ci_pairing_rejected WHERE at >= ? AND repository IN (SELECT value FROM json_each(?))").get(since, JSON.stringify(repositories))?.["n"] ?? 0);
}
