/**
 * The release card (docs/plans/chat-management.md §0a.5): how a deploy gate is approved from chat until the
 * authenticator ships. Alex's decision (2026-10-25): chat keeps approving releases by tap, so the tap is made to mean
 * exactly what was shown.
 *
 * - `approvalTermsOf`: every signed term of the scope and every field of its release terms, one line each, "none" for
 *   an empty one (a contract test holds it to the schemas, so a field added later and left out fails).
 * - `releaseChangeList`: what changed since the last verified release, from the plane's own record of it (the merge
 *   commit of the newest merged release whose merge operation succeeded), read as Git objects through the hardened
 *   release runner from the project's recorded Git directory: never a tag or a ref, so moving one changes nothing.
 *   With no earlier release on record, the pull request's own commits from GitHub, for the recorded owner/name.
 * - `releaseCardOf`: the short card, the full terms (sent as a file where the chat app limits a message), and
 *   `cardDigest`, which binds the scope digest, the plan form's digest, the baseline and the change list: Continue and
 *   Approve carry it, and anything different at the tap refuses.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { HARDENED_GIT_ARGS } from "./agent-fence.js";
import { checkAccessWords } from "./check-access.js";
import { CHECK_LEVEL_WORDS, effectiveCheckLevel } from "./check-levels.js";
import { releaseTermsSchema, type ReleaseTerms } from "./contracts/release-terms.js";
import { projectName } from "./project.js";
import { RELEASE_PATH, releaseConfigProblem, releaseGitEnv, releaseRemote, releaseTools } from "./release-git.js";
import type { Scope } from "./scope.js";
import type { Store } from "./store.js";

/** One signed term as the card says it. `key` names the scope field or the release term's path. */
export type TermLine = { key: string; label: string; value: string };

const NONE = "none";
const money = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;
const said = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return NONE;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length === 0 ? NONE : value.map(one => String(one)).join(", ");
  return String(value);
};

/** The scope's own terms the card names, in order. A contract test holds `goal`, `outOfScope`, `touches` and
 * `acceptance` (contracts/scope.ts) and the scope's other signed fields to this list. */
export const SCOPE_TERM_LABELS = {
  title: "Title", project: "Project", filedBy: "Filed by", goal: "Goal", outOfScope: "Not in scope", touches: "Paths it may touch",
  acceptance: "Done when", agents: "Agents and model", permission: "Agents may", checks: "Checks", checkAccess: "Check access",
  budgetMicrousd: "Budget per attempt", candidate: "Candidate commit",
} as const;

/** Every field of the release terms, by its path in the terms (contracts/release-terms.ts), against the schema's
 * own leaves: the contract test checks every one has a label. */
export const RELEASE_TERM_LABELS: Readonly<Record<string, string>> = {
  version: "Release terms version", repo: "Repository", packageVersion: "Package version", branch: "Branch", pr: "Pull request", base: "Base",
  approvedSha: "Approved commit", approvedTree: "Approved tree",
  "policy.version": "Carry policy version", "policy.rules": "Carry rules", "policy.carry": "Carry later commits",
  "policy.protectProject": "Protected: the whole project", "policy.protectedPaths": "Protected paths",
  "policy.limits.lines": "Carry limit: lines", "policy.limits.files": "Carry limit: files", "policy.limits.churn": "Carry limit: churn",
  "grant.id": "Release check grant", "grant.digest": "Release check grant digest", access: "Release check access", expiresAt: "Expires",
};

/** The leaf paths of a zod object schema (nested objects joined with dots). */
export function schemaLeaves(schema: unknown, prefix = ""): string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (shape === undefined || shape === null) return [prefix];
  return Object.entries(shape).flatMap(([key, child]) => schemaLeaves(child, prefix === "" ? key : `${prefix}.${key}`));
}

const valueAt = (terms: unknown, path: string): unknown => path.split(".").reduce<unknown>((at, key) => at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined, terms);

/** Every signed term of `scope`, its release terms included, one line each. Reads only. */
export function approvalTermsOf(store: Store, scope: Scope, words: { profile: (profile: Scope["profile"]) => string | null }): TermLine[] {
  const ref = store.lookupRef(scope.taskId);
  const repo = ref?.repo ?? null;
  const filer = store.taskFiler(scope.taskId);
  const profile = scope.profile ?? null;
  const scopeValues: Record<keyof typeof SCOPE_TERM_LABELS, string> = {
    title: said(store.getTask(scope.taskId)?.title),
    project: repo === null ? NONE : `${projectName(repo)} (${repo})`,
    filedBy: filer === null ? NONE : filer.name === null ? filer.kind : `${filer.name}${filer.kind === "person" ? "" : ` (${filer.kind})`}`,
    goal: said(scope.goal),
    outOfScope: said(scope.outOfScope),
    touches: said(scope.touches),
    acceptance: scope.acceptance.length === 0 ? NONE : scope.acceptance.map(one => `${one.id}: ${one.statement}`).join("; "),
    agents: profile === null ? NONE : `${profile.provider} · ${profile.model}`,
    permission: said(words.profile(profile)),
    checks: CHECK_LEVEL_WORDS[effectiveCheckLevel(store, repo, scope.taskId).level],
    checkAccess: checkAccessWords(profile?.checkAccess ?? "sandboxed"),
    budgetMicrousd: scope.budgetMicrousd === null ? NONE : money(scope.budgetMicrousd),
    candidate: said(scope.candidate),
  };
  const lines: TermLine[] = (Object.keys(SCOPE_TERM_LABELS) as (keyof typeof SCOPE_TERM_LABELS)[]).map(key => ({ key, label: SCOPE_TERM_LABELS[key], value: scopeValues[key] }));
  const terms = scope.releaseTerms ?? null;
  for (const path of schemaLeaves(releaseTermsSchema)) {
    const label = RELEASE_TERM_LABELS[path] ?? path;
    const value = terms === null ? NONE : path === "pr" ? `#${terms.pr}` : path === "policy.protectedPaths" && terms.policy.protectProject ? "the whole project" : said(valueAt(terms, path));
    lines.push({ key: `release.${path}`, label, value });
  }
  return lines;
}

export const termsText = (lines: readonly TermLine[]): string => lines.map(line => `${line.label}: ${line.value}`).join("\n");

// ---- what changed since the last verified release ----------------------------------------------------------------

export type ChangeList = {
  /** The merge commit of the last verified release, or null when none is recorded. */
  baseline: string | null;
  /** Newest first; null when it couldn't be read. */
  commits: { sha: string; subject: string }[] | null;
  source: "recorded" | "pull-request" | "unread";
  digest: string;
};

const SHA = /^[0-9a-f]{40}$/;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The plane's own record of the last verified release of `repo`: the merge commit GitHub answered with, recorded once
 * the release verified the merged tree (the newest merged authority whose merge operation succeeded). Never a tag. */
export function releaseBaseline(store: Store, repo: string): string | null {
  const row = store.handle.prepare(`SELECT o.external_ref FROM release_authority a JOIN release_operation o ON o.authority = a.id
    WHERE a.repo = ? AND a.state = 'merged' AND o.kind = 'merge' AND o.state = 'succeeded' AND o.external_ref IS NOT NULL ORDER BY a.id DESC, o.finished_at DESC LIMIT 1`).get(repo);
  const ref = row === undefined ? null : String(row["external_ref"]);
  return ref !== null && SHA.test(ref) ? ref : null;
}

/** The commits after `from` up to `to`, as Git objects only, from the project's recorded Git directory through the
 * release coordinator's hardened settings (its checkout config allowlist first). Null when they can't be read. */
export function commitsBetween(repo: string, from: string, to: string, limit = 200): { sha: string; subject: string }[] | null {
  if (!SHA.test(from) || !SHA.test(to)) return null;
  let gitDir: string;
  try {
    const named = join(realpathSync(repo), ".git");
    if (!lstatSync(named).isDirectory()) return null;
    gitDir = realpathSync(named);
  } catch { return null; }
  const tools = releaseTools();
  const env = { ...releaseGitEnv(), PATH: RELEASE_PATH };
  const listing = spawnSync(tools.git, [`--git-dir=${gitDir}`, "--no-optional-locks", "config", "--list", "--no-includes", "--show-scope", "-z"], { cwd: "/", env, encoding: "utf8", timeout: 15_000 });
  if (listing.status !== 0 || releaseConfigProblem(listing.stdout) !== null) return null;
  const read = spawnSync(tools.git, [`--git-dir=${gitDir}`, "--no-replace-objects", "--no-pager", ...HARDENED_GIT_ARGS, "-c", "core.pager=cat", "-c", "log.showSignature=false",
    "rev-list", `--max-count=${limit}`, "--format=%H%x09%s", `${from}..${to}`], { cwd: "/", env, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  if (read.status !== 0) return null;
  return read.stdout.split("\n").filter(line => line !== "" && !line.startsWith("commit ")).map(line => {
    const tab = line.indexOf("\t");
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  }).filter(one => SHA.test(one.sha));
}

/** A pull request's own commits from GitHub, for the recorded owner/name. Null when GitHub can't be read. */
function pullRequestCommits(slug: string, pr: number): { sha: string; subject: string }[] | null {
  const tools = releaseTools();
  const read = spawnSync(tools.gh, ["api", `repos/${slug}/pulls/${pr}/commits?per_page=100`, "--jq", '.[] | .sha + "\\t" + (.commit.message | split("\\n")[0])'],
    { cwd: "/", env: releaseGitEnv(), encoding: "utf8", timeout: 15_000 });
  if (read.status !== 0) return null;
  return read.stdout.split("\n").filter(line => line !== "").map(line => { const tab = line.indexOf("\t"); return { sha: line.slice(0, tab), subject: line.slice(tab + 1) }; })
    .filter(one => SHA.test(one.sha)).reverse();
}

/** What changed since the last verified release, for a release's terms, from Toolroll's records only. */
export function releaseChangeList(store: Store, terms: ReleaseTerms): ChangeList {
  const baseline = releaseBaseline(store, terms.repo);
  let commits: ChangeList["commits"];
  let source: ChangeList["source"];
  if (baseline !== null) {
    commits = commitsBetween(terms.repo, baseline, terms.approvedSha);
    source = commits === null ? "unread" : "recorded";
  } else {
    const remote = store.projectRemote(terms.repo);
    const parsed = remote === null ? null : releaseRemote(remote);
    commits = parsed === null ? null : pullRequestCommits(parsed.slug, terms.pr);
    source = commits === null ? "unread" : "pull-request";
  }
  return { baseline, commits, source, digest: sha256(`release-changes:${JSON.stringify({ baseline, source, commits })}`) };
}

// ---- the card --------------------------------------------------------------------------------------------------

export type ReleaseCard = {
  /** Binds the scope digest, the plan form's digest, the baseline and the change list. */
  digest: string;
  short: string;
  full: string;
  fileName: string;
  changes: ChangeList;
};

/** The card digest: everything the person is shown that can change under them. */
export function cardDigestOf(scopeDigest: string, formDigest: string, changes: Pick<ChangeList, "baseline" | "digest">): string {
  return sha256(`release-card:v1:${JSON.stringify([scopeDigest, formDigest, changes.baseline, changes.digest])}`);
}

function changeWords(changes: ChangeList, terms: ReleaseTerms | null, cap: number): string[] {
  const head = changes.baseline === null ? `No earlier verified release is recorded. ${changes.source === "pull-request" ? `Pull request #${terms?.pr ?? "?"}'s commits:` : ""}`.trim()
    : `Changes since the last verified release (${changes.baseline.slice(0, 7)}):`;
  if (changes.commits === null) return [head, changes.baseline === null ? `The pull request's commits couldn't be read; see #${terms?.pr ?? "?"} on GitHub.` : "The change list couldn't be read."];
  if (changes.commits.length === 0) return [head, "No commits."];
  return [head, ...changes.commits.slice(0, cap).map(one => `• ${one.sha.slice(0, 7)} ${one.subject.slice(0, 100)}`), ...(changes.commits.length > cap ? [`• and ${changes.commits.length - cap} more`] : [])];
}

/** The release card for a deploy gate, against the live records now. */
export function releaseCardOf(store: Store, scope: Scope, formDigest: string, words: { profile: (profile: Scope["profile"]) => string | null }): ReleaseCard {
  const terms = scope.releaseTerms ?? null;
  const lines = approvalTermsOf(store, scope, words);
  const value = (key: string) => lines.find(line => line.key === key)?.value ?? NONE;
  const changes: ChangeList = terms === null
    ? { baseline: null, commits: null, source: "unread", digest: sha256("release-changes:none") }
    : releaseChangeList(store, terms);
  const version = terms?.packageVersion ?? null;
  const fileName = `release-${version ?? scope.taskId.replace(/[^A-Za-z0-9._-]/g, "-")}-terms.txt`;
  const short = [
    version === null ? `Deploy gate: ${value("title")}` : `Release ${version}: ${value("title")}`,
    terms === null ? `Candidate ${said(scope.candidate).slice(0, 12)} · ${value("project")}` : `${projectName(terms.repo)} · ${terms.branch} · pull request #${terms.pr} · commit ${terms.approvedSha.slice(0, 7)}`,
    terms === null ? `Checks: ${value("checks")} · check access: ${value("checkAccess")}` : `Carry later commits: ${terms.policy.carry ? "yes" : "no"} · checks: ${value("checks")} · expires ${terms.expiresAt}`,
    "",
    ...changeWords(changes, terms, 5),
    "",
    `Every term is in ${fileName}.`,
  ].join("\n");
  const full = [`${version === null ? "Deploy gate" : `Release ${version}`}: every term`, "", termsText(lines), "", ...changeWords(changes, terms, 200)].join("\n");
  return { digest: cardDigestOf(scope.digest, formDigest, changes), short, full, fileName, changes };
}
