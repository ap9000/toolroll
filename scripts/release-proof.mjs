#!/usr/bin/env node
/**
 * Independent proof that a commit on main was tested before it merged (docs/plans/test-matrix.md): publish.yml runs it
 * on a release tag before npm publication, and main-push.yml on each push to main before it skips the full CI run.
 *
 *   node scripts/release-proof.mjs verify --repo <owner/name> --sha <commit> --required <JSON {check name: workflow file}>
 *
 * The commit stands only when, read from GitHub's API with the workflow's own read-only GITHUB_TOKEN:
 * - it is the squash merge (one parent) of exactly one merged pull request into main, by GitHub's merge_commit_sha;
 * - that pull request's head commit has the same tree;
 * - for each workflow named in `required`, the newest run GitHub Actions made on that head commit, for that pull
 *   request's branch in this repository, from its pull request (event pull_request), is complete, and in its latest
 *   attempt every check the list
 *   names for that workflow is exactly one job that concluded `success` (skipped is not success).
 * Anything missing, unreadable, ambiguous or different is no proof. The list in each workflow file must equal
 * src/release.ts REQUIRED_PR_CHECKS (src/ci-workflow.test.ts holds them equal). This proves what GitHub recorded; it
 * relies on main's branch protection requiring every one of those checks, which `toolroll release` refuses to merge
 * without.
 */

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** The events whose runs may prove each workflow's checks. */
export const PROOF_EVENTS = {
  ".github/workflows/ci.yml": ["pull_request"],
  ".github/workflows/release-candidate.yml": ["pull_request"],
};
const workflowIs = (path, file) => typeof path === "string" && (path === file || path.startsWith(`${file}@`));
const mergedPulls = (pulls, repo, sha) => (Array.isArray(pulls) ? pulls : []).filter(pr => pr?.merged_at != null && pr?.merge_commit_sha === sha && pr?.base?.ref === "main" && pr?.base?.repo?.full_name === repo);
const timestamp = value => typeof value === "string" ? Date.parse(value) : NaN;

/** The `required` list, checked: a non-empty object of distinct check names, each mapped to a workflow PROOF_EVENTS knows. */
export function parseRequired(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.some(([name, file]) => name.trim() === "" || typeof file !== "string" || !Object.hasOwn(PROOF_EVENTS, file))) return null;
  return parsed;
}

/** The run that may prove `file`'s checks on `head`: the newest GitHub Actions made of that workflow, on that commit, for
 * that branch of this repository, from an event the workflow may prove with. Undefined when there is none. */
export function provingRun(runs, file, { repo, head, branch }) {
  const events = PROOF_EVENTS[file] ?? [];
  return (Array.isArray(runs) ? runs : []).filter(run => workflowIs(run?.path, file) && run?.head_sha === head && run?.head_branch === branch && events.includes(run?.event)
    && run?.repository?.full_name === repo && run?.head_repository?.full_name === repo && Number.isSafeInteger(run?.id) && run.id > 0)
    .sort((a, b) => b.id - a.id)[0];
}

/**
 * Why `sha` isn't proven, or null when it is. Every input is GitHub's own answer: `commit` and `headCommit` from
 * git/commits, `pulls` from commits/{sha}/pulls, `runs` from actions/runs?head_sha (with its total_count), `jobs` maps a
 * run id to its latest attempt's jobs.
 */
export function proofProblem({ repo, sha, required, commit, pulls, headCommit, runs, runsTotal, jobs }) {
  if (!REPO.test(repo ?? "") || !SHA.test(sha ?? "")) return "no repository or commit to prove";
  if (parseRequired(JSON.stringify(required)) === null) return "no list of required checks";
  if (commit?.sha !== sha || !SHA.test(commit?.tree?.sha ?? "")) return `GitHub doesn't describe ${sha.slice(0, 7)}`;
  if (!Array.isArray(commit.parents) || commit.parents.length !== 1) return `${sha.slice(0, 7)} isn't a squash merge (it has ${Array.isArray(commit.parents) ? commit.parents.length : "no"} parents)`;
  const merged = mergedPulls(pulls, repo, sha);
  if (merged.length !== 1) return `${sha.slice(0, 7)} is the merge of ${merged.length === 0 ? "no" : merged.length} merged pull request${merged.length === 1 ? "" : "s"} into main`;
  const pr = merged[0], head = pr.head?.sha, branch = pr.head?.ref;
  const mergedAt = timestamp(pr.merged_at);
  if (!Number.isSafeInteger(pr.number) || pr.number < 1 || !Number.isFinite(mergedAt)) return "no pull request number or merge time";
  if (!SHA.test(head ?? "") || typeof branch !== "string" || branch === "" || pr.head?.repo?.full_name !== repo) return `pull request #${pr.number} has no head commit in ${repo}`;
  if (headCommit?.sha !== head || typeof headCommit?.tree?.sha !== "string") return `GitHub doesn't describe pull request #${pr.number}'s head ${head.slice(0, 7)}`;
  if (headCommit.tree.sha !== commit.tree.sha) return `${sha.slice(0, 7)}'s tree isn't pull request #${pr.number}'s head tree (${head.slice(0, 7)})`;
  if (!Array.isArray(runs) || !Number.isSafeInteger(runsTotal) || runsTotal !== runs.length
    || runs.some(run => !Number.isSafeInteger(run?.id) || run.id < 1 || run.head_sha !== head)
    || new Set(runs.map(run => run.id)).size !== runs.length) return `GitHub's workflow runs on ${head.slice(0, 7)} can't be read whole`;
  const byWorkflow = new Map();
  for (const [name, file] of Object.entries(required)) byWorkflow.set(file, [...(byWorkflow.get(file) ?? []), name]);
  for (const [file, names] of byWorkflow) {
    const events = PROOF_EVENTS[file];
    if (events === undefined) return `no proof rule for ${file}`;
    const newest = provingRun(runs, file, { repo, head, branch });
    if (newest === undefined) return `no ${file} run on pull request #${pr.number}'s head ${head.slice(0, 7)}`;
    // Select the newest run first: an invalid binding on it must not resurrect an older green run.
    const bound = newest.pull_requests;
    if (!Array.isArray(bound) || bound.length !== 1 || bound[0]?.number !== pr.number
      || bound[0]?.base?.ref !== "main" || bound[0]?.base?.repo?.url !== `https://api.github.com/repos/${repo}`
      || bound[0]?.head?.sha !== head || bound[0]?.head?.ref !== branch || bound[0]?.head?.repo?.url !== `https://api.github.com/repos/${repo}`) return `${file} run ${newest.id}: invalid pull request binding`;
    if (!Number.isSafeInteger(newest.run_attempt) || newest.run_attempt < 1) return `${file} run ${newest.id}: no latest attempt`;
    if (newest.status !== "completed") return `${file} run ${newest.id} on ${head.slice(0, 7)} hasn't finished`;
    const ran = jobs?.get?.(newest.id);
    if (!Array.isArray(ran)) return `${file} run ${newest.id}'s jobs can't be read`;
    for (const name of names) {
      const named = ran.filter(job => job?.name === name);
      if (named.length !== 1) return `${name}: ${named.length === 0 ? "no" : named.length} job${named.length === 1 ? "" : "s"} of that name in ${file} run ${newest.id}`;
      const job = named[0];
      if (job.head_sha !== head || job.run_id !== newest.id) return `${name}: its job isn't on ${head.slice(0, 7)} in run ${newest.id}`;
      if (job.status !== "completed" || job.conclusion !== "success") return `${name}: ${job.status !== "completed" ? String(job.status) : String(job.conclusion)} in ${file} run ${newest.id}${job.conclusion === "skipped" ? " (a skipped job is not a tested one)" : ""}`;
      if (!Number.isFinite(timestamp(job.completed_at)) || timestamp(job.completed_at) > mergedAt) return `${name}: not proven passed before pull request #${pr.number} merged`;
    }
  }
  return null;
}

const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at === -1 ? undefined : args[at + 1]; };

/** One GitHub API read, with the workflow's token sent to GitHub's API alone. */
async function api(path) {
  const token = process.env.GITHUB_TOKEN;
  if (typeof token !== "string" || token === "") throw new Error("no GITHUB_TOKEN");
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path.replace(/\?.*/, "")}`);
  return response.json();
}

/** Read every page, refusing truncation, duplicate rows and changing totals. Never follow a response-supplied URL. */
async function pages(path, key, identity) {
  const all = [], seen = new Set();
  let total;
  for (let page = 1; page <= 100; page++) {
    const body = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const rows = key === undefined ? body : body?.[key];
    if (!Array.isArray(rows) || rows.length > 100) throw new Error(`${path}: unreadable page`);
    if (key !== undefined) {
      if (!Number.isSafeInteger(body.total_count) || body.total_count < 0 || (total !== undefined && total !== body.total_count)) throw new Error(`${path}: unreadable or changing total`);
      total = body.total_count;
    }
    for (const row of rows) {
      if (row === null || typeof row !== "object") throw new Error(`${path}: unreadable row`);
      if (identity !== undefined) {
        const id = row[identity];
        if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) throw new Error(`${path}: missing or duplicate ${identity}`);
        seen.add(id);
      }
      all.push(row);
    }
    if (total !== undefined && all.length > total) throw new Error(`${path}: too many rows`);
    if (rows.length < 100 || all.length === total) {
      if (total !== undefined && all.length !== total) throw new Error(`${path}: incomplete list`);
      return all;
    }
  }
  throw new Error(`${path}: pagination limit; no complete proof`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command !== "verify") { console.error("usage: release-proof.mjs verify --repo <owner/name> --sha <commit> --required <JSON>"); process.exit(2); }
    const repo = flag(args, "repo") ?? "", sha = flag(args, "sha") ?? "", required = parseRequired(flag(args, "required") ?? "");
    if (!REPO.test(repo) || !SHA.test(sha)) throw new Error("--repo owner/name and --sha <40 hex> are required");
    if (required === null) throw new Error("--required must map each check name to a workflow this proof knows");
    const commit = await api(`repos/${repo}/git/commits/${sha}`);
    const pulls = await pages(`repos/${repo}/commits/${sha}/pulls`, undefined, "number");
    const merged = mergedPulls(pulls, repo, sha);
    if (merged.length !== 1) throw new Error(`expected exactly one merged pull request into main, found ${merged.length}`);
    const pr = merged[0];
    const head = pr?.head?.sha;
    const headCommit = SHA.test(head ?? "") ? await api(`repos/${repo}/git/commits/${head}`) : null;
    if (!SHA.test(head ?? "") || !Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error("no pull request head or number");
    const runsPath = `repos/${repo}/actions/runs?head_sha=${head}`;
    const runs = await pages(runsPath, "workflow_runs", "id");
    const jobs = new Map();
    for (const file of new Set(Object.values(required))) {
      const newest = provingRun(runs, file, { repo, head, branch: pr?.head?.ref });
      if (newest === undefined || !Number.isSafeInteger(newest.run_attempt) || newest.run_attempt < 1) continue;
      jobs.set(newest.id, await pages(`repos/${repo}/actions/runs/${newest.id}/attempts/${newest.run_attempt}/jobs`, "jobs", "id"));
    }
    // GitHub's run PR metadata changes on retargeting. As in readCheckRuns, refuse a PR that ever changed base.
    const timeline = await pages(`repos/${repo}/issues/${pr.number}/timeline`);
    if (timeline.some(event => typeof event.event !== "string" || event.event === "base_ref_changed")) throw new Error("pull request base changed or its timeline is unreadable");
    // The attempt may have changed while we paged through its jobs. Do not combine the old attempt with a new run.
    const fresh = await pages(runsPath, "workflow_runs", "id");
    for (const file of new Set(Object.values(required))) {
      const before = provingRun(runs, file, { repo, head, branch: pr.head.ref });
      const after = provingRun(fresh, file, { repo, head, branch: pr.head.ref });
      if (before?.id !== after?.id || before?.run_attempt !== after?.run_attempt || before?.status !== after?.status) throw new Error(`${file}: newest run or attempt changed during proof`);
    }
    const problem = proofProblem({ repo, sha, required, commit, pulls, headCommit, runs: fresh, runsTotal: fresh.length, jobs });
    if (problem !== null) { console.error(`Not proven: ${problem}.`); process.exit(1); }
    console.log(`${sha} is pull request #${pr.number}'s head tree (${head}), and every one of its ${Object.keys(required).length} required checks passed there.`);
  } catch (error) { console.error(`Not proven: ${String(error?.message ?? error)}.`); process.exit(1); }
}
