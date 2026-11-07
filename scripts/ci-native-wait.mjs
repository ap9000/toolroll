#!/usr/bin/env node
/**
 * The root lanes' verdict, for ci.yml (docs/plans/trusted-release-reports.md, H1). Cgroup, fence and Job Object lanes
 * need root, so a candidate's code runs with root there. They run as native-lanes.yml, a workflow run of its own, with
 * its own token and artifact store, so nothing they run can reach ci.yml's hardened jobs. (A reusable workflow would
 * keep the caller's run, so it wouldn't do.) But `toolroll release`, main's protection and the release proof bind each
 * required check to ci.yml by name AND file, and the release tool that judges a release is the one already deployed. So
 * the required names stay ci.yml jobs, and each one is this script: it runs nothing of the candidate's, waits for its
 * lane's job in that independent run, and passes only if it passed.
 *
 *   node ci-native-wait.mjs wait --check <required name> --repo <owner/name> --sha <commit> --event <event> [--since <ISO time>] [--minutes <n>]
 *
 * The run must be native-lanes.yml, of this repository, on exactly this commit, from a pull_request (or, for a call from
 * main-push.yml or nightly.yml, the workflow_dispatch they start, no older than --since); the newest such run stands,
 * and its job is read from its latest attempt. Anything else is no verdict, and no verdict by the deadline fails.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_WORKFLOW = ".github/workflows/native-lanes.yml";
/** ci.yml's required name → the lane's job in native-lanes.yml. The lanes' own names are never required names. */
export const NATIVE_JOBS = Object.freeze({
  "linux native containment · delegated cgroup v2": "native · linux cgroup",
  "linux fence · sandbox-runtime": "native · linux fence",
  "Windows Job Object containment": "native · windows job object",
});

const workflowIs = path => {
  if (typeof path !== "string") return false;
  if (path === NATIVE_WORKFLOW) return true;
  // As release.ts and release-proof.mjs: native-lanes.yml@evil.yml is another workflow, not this one's ref.
  const ref = path.startsWith(`${NATIVE_WORKFLOW}@`) ? path.slice(NATIVE_WORKFLOW.length + 1) : "";
  return /^[A-Za-z0-9._+/-]+$/.test(ref) && !/\.ya?ml$/i.test(ref);
};

/** The run that stands for `sha`: the newest of the workflow on that commit, in this repository, from the right event. */
export function standingRun(runs, { repo, sha, event, since = null }) {
  const wanted = event === "pull_request" ? "pull_request" : "workflow_dispatch";
  const floor = since === null ? -Infinity : Date.parse(since);
  return (Array.isArray(runs) ? runs : []).filter(run => workflowIs(run?.path) && run?.head_sha === sha && run?.event === wanted && run?.repository?.full_name === repo
    && Number.isSafeInteger(run?.id) && run.id > 0 && (wanted === "pull_request" || Date.parse(run?.created_at) >= floor))
    .sort((a, b) => b.id - a.id)[0];
}

/** `{ state: "passed" | "pending" | "failed", why }` for one lane: exactly one job of that name, completed, success. */
export function laneVerdict(jobs, name) {
  const named = (Array.isArray(jobs) ? jobs : []).filter(job => job?.name === name);
  if (named.length === 0) return { state: "pending", why: `${name} hasn't started` };
  if (named.length > 1) return { state: "failed", why: `${named.length} jobs are named ${name}` };
  const [job] = named;
  if (job.status !== "completed") return { state: "pending", why: `${name} is ${String(job.status)}` };
  return job.conclusion === "success" ? { state: "passed", why: `${name} passed` } : { state: "failed", why: `${name} ended ${String(job.conclusion)}: ${String(job.html_url)}` };
}

async function api(path, token) {
  const response = await fetch(`https://api.github.com/${path}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
  return response.json();
}

async function wait({ check, repo, sha, event, since, minutes, token }) {
  const job = Object.hasOwn(NATIVE_JOBS, check) ? NATIVE_JOBS[check] : undefined;
  if (job === undefined) throw new Error(`${check} isn't a root lane`);
  const deadline = Date.now() + minutes * 60_000;
  let last = "no native-lanes.yml run yet";
  while (Date.now() < deadline) {
    try {
      const listed = await api(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, token);
      const run = standingRun(listed.workflow_runs, { repo, sha, event, since });
      if (run !== undefined) {
        const jobs = await api(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, token);
        const verdict = laneVerdict(jobs.jobs, job);
        if (verdict.state !== "pending") { console.log(`run ${run.id}: ${verdict.why}`); return verdict.state === "passed" ? 0 : 1; }
        last = verdict.why;
      }
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise(done => setTimeout(done, 20_000));
  }
  console.error(`::error::no verdict for ${check} in ${minutes} minutes: ${last}`);
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = name => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
  const [command] = args;
  const [check, repo, sha, event] = ["check", "repo", "sha", "event"].map(flag);
  const token = process.env["GITHUB_TOKEN"];
  if (command !== "wait" || !check || !repo || !/^[0-9a-f]{40}$/.test(sha ?? "") || !event || !token) { console.error("usage: ci-native-wait.mjs wait --check <name> --repo <owner/name> --sha <commit> --event <event> [--since <time>] [--minutes <n>]"); process.exit(2); }
  process.exit(await wait({ check, repo, sha, event, since: flag("since") ?? null, minutes: Number(flag("minutes") ?? 40), token }));
}
