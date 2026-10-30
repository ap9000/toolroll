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
  return (Array.isArray(runs) ? runs : []).filter(run => run?.path === file && run?.head_sha === head && run?.head_branch === branch && events.includes(run?.event)
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
  if (required === null || typeof required !== "object") return "no list of required checks";
  if (commit?.sha !== sha || typeof commit?.tree?.sha !== "string") return `GitHub doesn't describe ${sha.slice(0, 7)}`;
  if (!Array.isArray(commit.parents) || commit.parents.length !== 1) return `${sha.slice(0, 7)} isn't a squash merge (it has ${Array.isArray(commit.parents) ? commit.parents.length : "no"} parents)`;
  const merged = (Array.isArray(pulls) ? pulls : []).filter(pr => pr?.merged_at != null && pr?.merge_commit_sha === sha && pr?.base?.ref === "main" && pr?.base?.repo?.full_name === repo);
  if (merged.length !== 1) return `${sha.slice(0, 7)} is the merge of ${merged.length === 0 ? "no" : merged.length} merged pull request${merged.length === 1 ? "" : "s"} into main`;
  const pr = merged[0], head = pr.head?.sha, branch = pr.head?.ref;
  if (!SHA.test(head ?? "") || typeof branch !== "string" || branch === "" || pr.head?.repo?.full_name !== repo) return `pull request #${pr.number} has no head commit in ${repo}`;
  if (headCommit?.sha !== head || typeof headCommit?.tree?.sha !== "string") return `GitHub doesn't describe pull request #${pr.number}'s head ${head.slice(0, 7)}`;
  if (headCommit.tree.sha !== commit.tree.sha) return `${sha.slice(0, 7)}'s tree isn't pull request #${pr.number}'s head tree (${head.slice(0, 7)})`;
  if (!Array.isArray(runs) || !Number.isSafeInteger(runsTotal) || runsTotal !== runs.length) return `GitHub's workflow runs on ${head.slice(0, 7)} can't be read whole`;
  const byWorkflow = new Map();
  for (const [name, file] of Object.entries(required)) byWorkflow.set(file, [...(byWorkflow.get(file) ?? []), name]);
  for (const [file, names] of byWorkflow) {
    const events = PROOF_EVENTS[file];
    if (events === undefined) return `no proof rule for ${file}`;
    const newest = provingRun(runs, file, { repo, head, branch });
    if (newest === undefined) return `no ${file} run on pull request #${pr.number}'s head ${head.slice(0, 7)}`;
    if (newest.status !== "completed") return `${file} run ${newest.id} on ${head.slice(0, 7)} hasn't finished`;
    const ran = jobs?.get?.(newest.id);
    if (!Array.isArray(ran)) return `${file} run ${newest.id}'s jobs can't be read`;
    for (const name of names) {
      const named = ran.filter(job => job?.name === name);
      if (named.length !== 1) return `${name}: ${named.length === 0 ? "no" : named.length} job${named.length === 1 ? "" : "s"} of that name in ${file} run ${newest.id}`;
      const job = named[0];
      if (job.head_sha !== head || job.run_id !== newest.id) return `${name}: its job isn't on ${head.slice(0, 7)} in run ${newest.id}`;
      if (job.status !== "completed" || job.conclusion !== "success") return `${name}: ${job.status !== "completed" ? String(job.status) : String(job.conclusion)} in ${file} run ${newest.id}${job.conclusion === "skipped" ? " (a skipped job is not a tested one)" : ""}`;
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

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command !== "verify") { console.error("usage: release-proof.mjs verify --repo <owner/name> --sha <commit> --required <JSON>"); process.exit(2); }
    const repo = flag(args, "repo") ?? "", sha = flag(args, "sha") ?? "", required = parseRequired(flag(args, "required") ?? "");
    if (!REPO.test(repo) || !SHA.test(sha)) throw new Error("--repo owner/name and --sha <40 hex> are required");
    if (required === null) throw new Error("--required must map each check name to a workflow this proof knows");
    const commit = await api(`repos/${repo}/git/commits/${sha}`);
    const pulls = await api(`repos/${repo}/commits/${sha}/pulls?per_page=100`);
    const pr = (Array.isArray(pulls) ? pulls : []).find(one => one?.merge_commit_sha === sha);
    const head = pr?.head?.sha;
    const headCommit = SHA.test(head ?? "") ? await api(`repos/${repo}/git/commits/${head}`) : null;
    const listed = SHA.test(head ?? "") ? await api(`repos/${repo}/actions/runs?head_sha=${head}&per_page=100`) : { total_count: 0, workflow_runs: [] };
    const runs = Array.isArray(listed?.workflow_runs) ? listed.workflow_runs : [];
    const jobs = new Map();
    for (const file of new Set(Object.values(required))) {
      const newest = provingRun(runs, file, { repo, head, branch: pr?.head?.ref });
      if (newest === undefined || !Number.isSafeInteger(newest.run_attempt) || newest.run_attempt < 1) continue;
      const page = await api(`repos/${repo}/actions/runs/${newest.id}/attempts/${newest.run_attempt}/jobs?per_page=100`);
      if (Array.isArray(page?.jobs) && page.total_count === page.jobs.length) jobs.set(newest.id, page.jobs);
    }
    const problem = proofProblem({ repo, sha, required, commit, pulls, headCommit, runs, runsTotal: listed?.total_count, jobs });
    if (problem !== null) { console.error(`Not proven: ${problem}.`); process.exit(1); }
    console.log(`${sha} is pull request #${pr.number}'s head tree (${head}), and every one of its ${Object.keys(required).length} required checks passed there.`);
  } catch (error) { console.error(`Not proven: ${String(error?.message ?? error)}.`); process.exit(1); }
}
