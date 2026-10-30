/**
 * GitHub's own job records, read by the plane's gh (release-adapters.ts for a release's checks, nightly-github.ts for
 * GitHub's nightly): what each step of a finished job did. Step numbers and outcomes are the runner's records; nothing
 * the tested code prints is read.
 */

/** One job's step outcomes as GitHub's Actions API reports them. */
export type JobRecord = { id: number; status: string; conclusion: string | null; steps: { number: number; name: string; status: string; conclusion: string | null }[] };

/**
 * Whether a finished, unsuccessful job ended before any of the workflow's own steps ran: every step after GitHub's own
 * first one ("Set up job", always number 1) never ran (no conclusion, or skipped) — leaving out only GitHub's own
 * closing "Complete job" when it is the last step. Step numbers and outcomes are the runner's records; nothing the
 * candidate prints is read. A job with no steps never reached one. Anything else (a step that ran, even the checkout)
 * is not confirmed infrastructure.
 */
export function failedBeforeTests(job: JobRecord): boolean {
  if (job.status !== "completed" || job.conclusion === "success" || job.conclusion === null) return false;
  const steps = [...job.steps].sort((a, b) => a.number - b.number);
  if (new Set(steps.map(one => one.number)).size !== steps.length) return false;
  const last = steps.at(-1);
  const own = steps.filter(one => one.number > 1 && !(one === last && one.name === "Complete job" && steps.length > 1));
  return own.every(one => one.status !== "in_progress" && (one.conclusion === null || one.conclusion === "skipped"));
}
