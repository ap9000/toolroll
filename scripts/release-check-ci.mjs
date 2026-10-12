/** Reuse only completed CI for the exact, clean candidate. Unknown always means run locally. */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/** Expand this workflow's job names, refusing constructs we cannot prove complete. */
export function ciJobNames(workflow) {
  const jobs = parse(workflow)?.jobs;
  if (!jobs || Object.keys(jobs).length === 0) throw Error("No CI jobs");
  return Object.entries(jobs).flatMap(([id, job]) => {
    let rows = [{}];
    for (const [axis, values] of Object.entries(job.strategy?.matrix ?? {})) {
      if (["include", "exclude"].includes(axis) || !Array.isArray(values) || values.some(v => !["string", "number", "boolean"].includes(typeof v))) throw Error("Unknown CI matrix");
      rows = rows.flatMap(row => values.map(value => ({ ...row, [axis]: value })));
    }
    return rows.map(row => {
      const name = (job.name ?? id).replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key) => {
        if (!(key in row)) throw Error("Unknown CI matrix name");
        return String(row[key]);
      });
      if (name.includes("${{") || (Object.keys(row).length > 0 && !job.name)) throw Error("Unknown CI job name");
      return name;
    });
  });
}

export function ciSucceeded(sha, run, jobs, expected) {
  return /^[a-f0-9]{40}$/.test(sha) && run?.head_sha === sha && run.path === ".github/workflows/ci.yml"
    && run.event === "push" && run.status === "completed" && run.conclusion === "success" && expected.length > 0
    && new Set(expected).size === expected.length && jobs.length === expected.length
    && expected.every(name => jobs.filter(job => job.name === name && job.head_sha === sha
      && job.status === "completed" && job.conclusion === "success").length === 1);
}

export function macUnitFiles(root = "src") {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return macUnitFiles(path);
    return entry.name.endsWith(".test.ts") && /darwin|macos|macOS|sandbox-exec|launchctl/.test(readFileSync(path, "utf8")) ? [path] : [];
  }).sort();
}

export function passedCandidateCI({ full = false, git, exec = execFileSync, workflow = () => readFileSync(".github/workflows/ci.yml", "utf8") } = {}) {
  if (full) return { passed: false, why: "--full runs units locally" };
  try {
    const sha = git("rev-parse", "HEAD");
    if (!sha || git("status", "--porcelain", "--untracked-files=normal") !== "") throw Error("candidate is not a clean commit");
    const expected = ciJobNames(workflow());
    const api = path => JSON.parse(exec("gh", ["api", "--paginate", "--slurp", path], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }));
    const runs = api(`repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`).flatMap(page => page.workflow_runs ?? []);
    const run = runs.filter(one => one.head_sha === sha && one.event === "push").sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== "completed" || run.conclusion !== "success") throw Error("latest CI run is missing or not successful");
    const jobs = api(`repos/{owner}/{repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`).flatMap(page => page.jobs ?? []);
    if (!ciSucceeded(sha, run, jobs, expected)) throw Error("not every ci.yml job passed on the candidate");
    return { passed: true, why: `ci.yml run ${run.id} passed every job on ${sha}` };
  } catch (error) { return { passed: false, why: `CI unknown or incomplete: ${error.message}` }; }
}
