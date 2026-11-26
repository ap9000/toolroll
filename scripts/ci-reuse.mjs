#!/usr/bin/env node
/**
 * CI result reuse for narrow documentation-only and version-only pull requests (docs/plans/release-from-main.md,
 * part B). Runs from the trusted base revision's checkout (`.trusted-base/scripts/ci-reuse.mjs`) with zero external
 * dependencies:
 *
 *   node <trusted copy>/scripts/ci-reuse.mjs decide \
 *     --event <event> --base-ref <branch> --base <sha> --head <sha> \
 *     --repo <owner/name> --root <checkout> --checks <JSON {check name: workflow file}>
 *
 *   node <trusted copy>/scripts/ci-reuse.mjs verify \
 *     --event <event> --base-ref <branch> --base <sha> --head <sha> \
 *     --repo <owner/name> --root <checkout> --check <exact check name> --workflow <workflow file>
 *
 * Reuse is permitted ONLY when ALL of the following hold (fail closed on any ambiguity, error or missing proof):
 * 1. Event is `pull_request` targeting `main`.
 * 2. Hash-verified Git reads through `deploy-git.mjs` (isolated view, no repo/system/global config, no filters or
 *    textconv, no replace objects, no lazy fetch; every commit, tree and changed blob hashed against its id) prove:
 *    - `merge-base(base, head) === base` (`head` contains `base` whole, not a stale branch);
 *    - at least one tree entry changed between `base` and `head`;
 *    - no file was deleted, renamed, mode-changed, symlinked or added as a submodule;
 *    - every added regular `100644` file satisfies `docsPath` (`README.md`, `CHANGELOG.md`, `docs/**.md`);
 *    - every modified regular `100644` file either satisfies `docsPath` OR is in `VERSIONED` (`package.json`,
 *      `package-lock.json`) and changed ONLY its version string(s) (`versionOnly`, strict JSON token equality).
 * 3. GitHub's API (read with the job's own read-only GITHUB_TOKEN) proves that `base` passed EACH requested check
 *    by exact name and workflow (concluding `success`, never `skipped`), either:
 *    - via `release-proof.mjs proveRelease` (base is the squash merge of a single PR into `main` whose head tree
 *      equals `base`'s and passed that exact check in `.github/workflows/ci.yml`), OR
 *    - via `main-push.yml` (newest completed `push` run on `head_branch === "main"`, `head_sha === base`, with
 *      exactly one job `main · full CI / <check>` concluding `success`, race-checked on latest attempt).
 *
 * Every required job in ci.yml runs `verify` independently for its own exact check name and concludes `success`
 * (never `skipped`), so `release-proof.mjs`, `main-push.yml`, `publish.yml`, `toolroll release` and subsequent reuse
 * PRs work inductively without weakening any release check.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { objectsOf, readGit, treeOf } from "./deploy-git.mjs";
import { docsPath } from "./ci-scope.mjs";
import { parseRequired, proveRelease } from "./release-proof.mjs";
import { VERSIONED } from "./upgrade-rule.mjs";

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export const CI_WORKFLOW = ".github/workflows/ci.yml";
export const MAIN_PUSH_WORKFLOW = ".github/workflows/main-push.yml";
export const MAIN_PUSH_JOB_PREFIX = "main · full CI / ";

/** Every ci.yml check proven by scope before shards and native lanes reuse base. */
export const CI_REUSE_CHECKS = Object.freeze({
  "node 24 · ubuntu-latest": CI_WORKFLOW,
  "node 24 · macos-latest": CI_WORKFLOW,
  "node 26 · SQLite": CI_WORKFLOW,
  "linux native containment · delegated cgroup v2": CI_WORKFLOW,
  "linux fence · sandbox-runtime": CI_WORKFLOW,
  "Windows Job Object containment": CI_WORKFLOW,
  "git 2.41 · debian trixie": CI_WORKFLOW,
  "git 2.47 · debian trixie": CI_WORKFLOW,
});

const workflowIs = (path, file) => {
  if (typeof path !== "string") return false;
  if (path === file) return true;
  const ref = path.startsWith(`${file}@`) ? path.slice(file.length + 1) : "";
  return /^[A-Za-z0-9._+/-]+$/.test(ref) && !/\.ya?ml$/i.test(ref);
};

/**
 * Exact match to src/check-report.ts `versionOnlyChange` and scripts/release-check.mjs `versionOnly`:
 * `before` and `after` (raw UTF-8 bytes) differ only in top-level `"version"` (and `packages[""].version` for
 * `package-lock.json`). Duplicate keys, rounded numbers, key reordering, non-UTF-8 bytes, or any other field edit
 * return false.
 */
export function versionOnly(path, before, after) {
  if (!VERSIONED.includes(path) || !(before instanceof Uint8Array) || !(after instanceof Uint8Array)) return false;
  const rest = bytes => {
    const text = utf8.decode(bytes);
    const json = JSON.parse(text);
    const tokens = value => JSON.stringify(value.match(/"(?:\\.|[^"\\])*"|[^\s"{}\[\]:,]+|[{}\[\]:,]/g));
    if (tokens(text) !== tokens(JSON.stringify(json))) throw new Error("ambiguous JSON");
    if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("not an object");
    if (typeof json.version !== "string") throw new Error("not a version string");
    delete json.version;
    if (path === "package-lock.json" && json.packages !== null && typeof json.packages === "object" && !Array.isArray(json.packages)) {
      const root = json.packages[""];
      if (root !== null && typeof root === "object" && !Array.isArray(root)) {
        if (typeof root.version !== "string") throw new Error("not a root version string");
        delete root.version;
      }
    }
    return JSON.stringify(json);
  };
  try { return rest(before) === rest(after); } catch { return false; }
}

/**
 * Pure diff classifier over hash-verified tree entries (`treeOf` output) and a blob loader (`ids => Map<id, {type, bytes}>`).
 * Fails closed on deletions, renames, mode/type changes, symlinks, submodules, empty diffs, non-docs additions, or
 * non-version edits to versioned files.
 */
export function diffTreesEligibility(baseEntries, headEntries, readBlobs) {
  if (!Array.isArray(baseEntries) || !Array.isArray(headEntries)) return { ok: false, why: "trees couldn't be read" };
  const baseMap = new Map(baseEntries.map(entry => [entry.path, entry]));
  const headMap = new Map(headEntries.map(entry => [entry.path, entry]));
  for (const path of baseMap.keys()) {
    if (!headMap.has(path)) return { ok: false, why: `${path} was deleted` };
  }
  const changed = [];
  const versionPairs = [];
  const verifyIds = [];
  for (const [path, h] of headMap) {
    const b = baseMap.get(path);
    if (b === undefined) {
      if (h.mode !== "100644" || h.type !== "blob") return { ok: false, why: `${path} was added with mode ${h.mode}` };
      if (!docsPath(path)) return { ok: false, why: `${path} isn't a documentation file` };
      changed.push({ path, kind: "docs-add" });
      verifyIds.push(h.id);
      continue;
    }
    if (b.mode === h.mode && b.type === h.type && b.id === h.id) continue;
    if (b.mode !== "100644" || h.mode !== "100644" || b.type !== "blob" || h.type !== "blob") {
      return { ok: false, why: `${path} changed mode or type (${b.mode} -> ${h.mode})` };
    }
    if (docsPath(path)) {
      changed.push({ path, kind: "docs-edit" });
      verifyIds.push(h.id);
    } else if (VERSIONED.includes(path)) {
      changed.push({ path, kind: "version-bump" });
      versionPairs.push({ path, beforeId: b.id, afterId: h.id });
      verifyIds.push(b.id, h.id);
    } else {
      return { ok: false, why: `${path} isn't documentation or a version file` };
    }
  }
  if (changed.length === 0) return { ok: false, why: "no tree entries changed between base and head" };
  const blobs = readBlobs(verifyIds);
  for (const id of verifyIds) {
    const blob = blobs?.get?.(id);
    if (blob === undefined || blob.type !== "blob" || !(blob.bytes instanceof Uint8Array)) {
      return { ok: false, why: `changed object ${String(id).slice(0, 12)} isn't a verified blob` };
    }
  }
  for (const { path, beforeId, afterId } of versionPairs) {
    if (!versionOnly(path, blobs.get(beforeId).bytes, blobs.get(afterId).bytes)) {
      return { ok: false, why: `${path} changed more than its version` };
    }
  }
  const hasDocs = changed.some(one => one.kind === "docs-add" || one.kind === "docs-edit");
  const kind = versionPairs.length > 0 ? (hasDocs ? "docs-and-version" : "version-only") : "docs-only";
  return { ok: true, kind, changed };
}

/**
 * Hash-verified diff eligibility between `base` and `head` in `root`, read exclusively through `deploy-git.mjs`
 * (isolated view, no repo/system/global config, no filters, no replace objects, SHA-verified commits/trees/blobs).
 */
export function verifiedDiffEligible(root, base, head, env = { PATH: process.env.PATH ?? "/usr/bin:/bin" }) {
  if (!SHA.test(base ?? "") || !SHA.test(head ?? "")) return { ok: false, why: "base and head must be full commit ids" };
  if (base === head) return { ok: false, why: "base and head are the same commit" };
  try {
    const repo = ["-C", root];
    const from = readGit(repo, ["merge-base", base, head], env).trim();
    if (from !== base) return { ok: false, why: "head isn't descended from base (merge base differs from base)" };
    const baseEntries = treeOf(repo, base, env);
    const headEntries = treeOf(repo, head, env);
    return diffTreesEligibility(baseEntries, headEntries, ids => objectsOf(repo, ids, env));
  } catch (error) {
    return { ok: false, why: `verified git read failed: ${String(error?.message ?? error).slice(0, 200)}` };
  }
}

/** One GitHub API read, sending GITHUB_TOKEN only to GitHub's API with no redirects. */
async function fetchApi(path) {
  const token = process.env.GITHUB_TOKEN;
  if (typeof token !== "string" || token === "") throw new Error("no GITHUB_TOKEN");
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path.replace(/\?.*/, "")}`);
  return response.json();
}

/** Paginate a GitHub API list whole, refusing truncation, changing totals or duplicate ids. */
async function pages(api, path, key, identity) {
  const all = [], seen = new Set();
  let total;
  for (let page = 1; page <= 100; page++) {
    const body = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const rows = key === undefined ? body : body?.[key];
    if (!Array.isArray(rows) || rows.length > 100) throw new Error(`${path}: unreadable page`);
    if (key !== undefined) {
      if (!Number.isSafeInteger(body.total_count) || body.total_count < 0 || (total !== undefined && total !== body.total_count)) {
        throw new Error(`${path}: unreadable or changing total`);
      }
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

function newestMainPushRun(runs, { repo, sha }) {
  return (Array.isArray(runs) ? runs : [])
    .filter(run => workflowIs(run?.path, MAIN_PUSH_WORKFLOW) && run?.head_sha === sha && run?.head_branch === "main"
      && run?.event === "push" && run?.repository?.full_name === repo && run?.head_repository?.full_name === repo
      && Number.isSafeInteger(run?.id) && run.id > 0)
    .sort((a, b) => b.id - a.id)[0];
}

/**
 * Fallback proof for commits on `main` that ran `main-push.yml`'s `main · full CI` directly (for example a commit
 * pushed without PR proof): the newest `push` run of `main-push.yml` on `main` at `sha` must be complete, and in its
 * latest attempt every requested ci.yml check must appear as exactly one job `main · full CI / <check>` concluding
 * `success` (never `skipped`).
 */
export async function proveMainPush({ repo, sha, required }, api = fetchApi) {
  try {
    if (!REPO.test(repo ?? "") || !SHA.test(sha ?? "")) return { ok: false, why: "no repository or commit to prove" };
    if (parseRequired(JSON.stringify(required ?? null)) === null) return { ok: false, why: "invalid required checks" };
    if (Object.values(required).some(file => file !== CI_WORKFLOW)) {
      return { ok: false, why: "main-push.yml only proves ci.yml checks" };
    }
    const runsPath = `repos/${repo}/actions/runs?head_sha=${sha}`;
    const runs = await pages(api, runsPath, "workflow_runs", "id");
    const newest = newestMainPushRun(runs, { repo, sha });
    if (newest === undefined) return { ok: false, why: `no ${MAIN_PUSH_WORKFLOW} push run on main for ${sha.slice(0, 7)}` };
    if (!Number.isSafeInteger(newest.run_attempt) || newest.run_attempt < 1) return { ok: false, why: `main-push run ${newest.id}: no latest attempt` };
    if (newest.status !== "completed") return { ok: false, why: `main-push run ${newest.id} hasn't finished` };
    const jobs = await pages(api, `repos/${repo}/actions/runs/${newest.id}/attempts/${newest.run_attempt}/jobs`, "jobs", "id");
    const fresh = await pages(api, runsPath, "workflow_runs", "id");
    const after = newestMainPushRun(fresh, { repo, sha });
    if (after?.id !== newest.id || after?.run_attempt !== newest.run_attempt || after?.status !== newest.status) {
      return { ok: false, why: "main-push newest run or attempt changed during proof" };
    }
    for (const check of Object.keys(required)) {
      const fullName = `${MAIN_PUSH_JOB_PREFIX}${check}`;
      const named = jobs.filter(job => job?.name === fullName);
      if (named.length !== 1) return { ok: false, why: `${fullName}: ${named.length === 0 ? "no" : named.length} job(s) in run ${newest.id}` };
      const job = named[0];
      if (job.head_sha !== sha || job.run_id !== newest.id) return { ok: false, why: `${fullName}: job doesn't belong to ${sha.slice(0, 7)} in run ${newest.id}` };
      if (job.status !== "completed" || job.conclusion !== "success") {
        return { ok: false, why: `${fullName}: ${job.status !== "completed" ? String(job.status) : String(job.conclusion)} in run ${newest.id}` };
      }
    }
    return { ok: true, source: "main_push", run: newest.id };
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error) };
  }
}

/**
 * Prove that `base` passed every check in `required` (exact check name -> workflow file), either on its squash-merged
 * pull request (`release-proof.mjs proveRelease`) or on a direct `main-push.yml` full CI run on `main`.
 */
export async function proveBaseChecks({ repo, base, required }, api = fetchApi) {
  if (!REPO.test(repo ?? "") || !SHA.test(base ?? "")) return { ok: false, why: "repo and base commit are required" };
  if (parseRequired(JSON.stringify(required ?? null)) === null) return { ok: false, why: "invalid required checks" };
  const pr = await proveRelease({ repo, sha: base, required }, api);
  if (pr.ok) return { ok: true, source: "pull_request", pr: pr.pr, head: pr.head };
  const push = await proveMainPush({ repo, sha: base, required }, api);
  if (push.ok) return push;
  return { ok: false, why: `base ${base.slice(0, 7)} not proven (PR proof: ${pr.why}; main-push proof: ${push.why})` };
}

/**
 * End-to-end reuse decision: checks event + target branch, hash-verified Git diff, and per-check GitHub API proof.
 */
export async function evaluateReuse({ event, baseRef, base, head, repo, root, required, env }, api = fetchApi) {
  if (event !== "pull_request") return { ok: false, why: `event ${String(event)} cannot reuse CI` };
  if (baseRef !== "main") return { ok: false, why: `pull request targets ${String(baseRef || "unknown")}, not main` };
  const diff = verifiedDiffEligible(root, base, head, env);
  if (!diff.ok) return diff;
  const proof = await proveBaseChecks({ repo, base, required }, api);
  if (!proof.ok) return proof;
  return { ok: true, kind: diff.kind, changed: diff.changed, proof };
}

/** Sanitize and wrap diagnostic output in a stop-commands block so untrusted paths/errors never become workflow commands. */
function writeSafeNote(text) {
  const token = randomBytes(16).toString("hex");
  const clean = String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "?").slice(0, 1000);
  process.stderr.write(`::stop-commands::${token}\n${clean}\n::${token}::\n`);
}

const flag = (args, name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "decide" && command !== "verify") {
    process.stderr.write("usage: ci-reuse.mjs decide|verify --event <event> --base-ref <ref> --base <sha> --head <sha> --repo <owner/name> --root <checkout> [--checks <JSON> | --check <name> --workflow <file>]\n");
    process.exit(2);
  }
  const event = flag(args, "event") ?? "";
  const baseRef = flag(args, "base-ref") ?? "";
  const base = flag(args, "base") ?? "";
  const head = flag(args, "head") ?? "";
  const repo = flag(args, "repo") ?? "";
  const root = flag(args, "root") ?? ".";

  if (command === "decide") {
    const required = parseRequired(flag(args, "checks") ?? "");
    if (event !== "pull_request" || baseRef !== "main" || required === null) {
      writeSafeNote(`ci-reuse decide: reuse=false (${event !== "pull_request" ? `event ${event}` : baseRef !== "main" ? `base ref ${baseRef}` : "invalid --checks"})`);
      console.log("reuse=false");
      process.exit(0);
    }
    try {
      const result = await evaluateReuse({ event, baseRef, base, head, repo, root, required });
      if (result.ok) {
        writeSafeNote(`ci-reuse decide: reuse=true (${result.kind}, ${result.changed.length} file(s), proven via ${result.proof.source})`);
        console.log("reuse=true");
      } else {
        writeSafeNote(`ci-reuse decide: reuse=false (${result.why})`);
        console.log("reuse=false");
      }
      process.exit(0);
    } catch (error) {
      writeSafeNote(`ci-reuse decide: reuse=false (${String(error?.message ?? error)})`);
      console.log("reuse=false");
      process.exit(0);
    }
  }

  // verify: exits 0 iff this exact check is cryptographically proven reusable from base; otherwise fails closed (exit 1).
  const check = flag(args, "check") ?? "";
  const workflow = flag(args, "workflow") ?? "";
  const required = parseRequired(JSON.stringify({ [check]: workflow }));
  if (required === null) {
    writeSafeNote("ci-reuse verify failed: invalid --check or --workflow");
    process.exit(1);
  }
  try {
    const result = await evaluateReuse({ event, baseRef, base, head, repo, root, required });
    if (result.ok) {
      writeSafeNote(`ci-reuse verify passed for ${check} (${result.kind}, ${result.changed.length} file(s), proven via ${result.proof.source})`);
      console.log("Reused proven check from base commit.");
      process.exit(0);
    }
    writeSafeNote(`ci-reuse verify failed for ${check}: ${result.why}`);
    process.exit(1);
  } catch (error) {
    writeSafeNote(`ci-reuse verify failed: ${String(error?.message ?? error)}`);
    process.exit(1);
  }
}
