/**
 * The release card (docs/plans/chat-management.md §0a.5): how a deploy gate is approved from chat until the
 * authenticator ships. Alex's decision (2026-10-25): chat keeps approving releases by tap, so the tap is made to mean
 * exactly what was shown.
 *
 * - `approvalTermsOf`: every signed term of the scope (its agent profile and phase route setting by setting) and every
 *   field of its release terms, one line each, "none" for an empty one and "any file in the project" for unnamed paths
 *   (a contract test changes each input of the approval digest in turn and holds the text to change with it).
 * - `releaseChangeList`: what changed since the last verified release, from the plane's own record of it (the merge
 *   commit of the newest merged release whose merge operation succeeded), read as verified Git objects from the
 *   project's recorded Git directory: never a tag or a ref, so moving one changes nothing, and history rewritten around
 *   the objects (a shallow boundary, grafts, replacement refs) refuses the list rather than shortening it.
 *   With no earlier release on record, the pull request's own commits from GitHub, for the recorded owner/name.
 * - `releaseCardOf`: the short card, the full terms (sent as a file where the chat app limits a message), and
 *   `cardDigest`, which binds the scope digest, the plan form's digest, the baseline and the change list: Continue and
 *   Approve carry it, and anything different at the tap refuses.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { checkAccessWords } from "./check-access.js";
import { CHECK_LEVEL_WORDS, effectiveCheckLevel } from "./check-levels.js";
import { verifiedRange } from "./commit-extract.js";
import { releaseTermsSchema, type ReleaseTerms } from "./contracts/release-terms.js";
import { routeFromJson } from "./phase-routing.js";
import { projectName } from "./project.js";
import { RELEASE_CI_RUNNING_WORDS, releaseCiRunningOf } from "./release-ci-hold.js";
import { RELEASE_PATH, releaseConfigProblem, releaseGitEnv, releaseRemote, releaseTools } from "./release-git.js";
import type { Scope } from "./scope.js";
import type { Store } from "./store.js";
import { nightlyReleaseLines } from "./nightly-github.js";

/** One signed term as the card says it. `key` names the scope field or the release term's path. */
export type TermLine = { key: string; label: string; value: string };

const NONE = "none";
/** A budget in dollars from integer micro-dollars, in integer arithmetic: cents when it is whole cents, else every digit. */
const money = (micro: number): string => {
  const exact = BigInt(micro), whole = exact / 1_000_000n, rest = (exact < 0n ? -exact : exact) % 1_000_000n;
  const fraction = rest.toString().padStart(6, "0");
  return `${exact < 0n && whole === 0n ? "-" : ""}$${whole}.${rest % 10_000n === 0n ? fraction.slice(0, 2) : fraction}`;
};
/** Words the card itself says in place of a value: a signed string spelled the same is quoted, never mistaken for one. */
const RESERVED = new Set([NONE, "yes", "no", "null", "empty", "not set", "any file in the project", "the whole project", "unreadable"]);
/** Text that reads the same plain as quoted: ASCII letters, digits and ordinary punctuation only (no lookalike letters
 * from other scripts, no direction marks), never a comma, semicolon, parenthesis, quote, backslash, line break or
 * control character, nor a trailing space. */
const PLAIN = /^[A-Za-z0-9~/.#$@][A-Za-z0-9 ._/@~+#=!?&%$*:<>|^-]*$/;
/** JSON-quoted with everything outside printable ASCII \u-escaped (JSON.stringify leaves non-ASCII as it is). */
const quoted = (value: string): string => JSON.stringify(value).replace(/[^\x20-\x7e]/g, one => `\\u${one.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** One signed string, unambiguous: as it is when plain, else quoted; an empty, number-like or colon-bearing string, or
 * one of the card's own words, is quoted too. */
const text = (value: string): string =>
  PLAIN.test(value) && !value.endsWith(" ") && !RESERVED.has(value.toLowerCase()) && !/^-?\d+(\.\d+)?$/.test(value) ? value : quoted(value);
/** One signed value as the card says it, every shape distinct: "none" for null, "not set" for absent, "empty" for an
 * empty list, `""` for an empty string; a list's entries each said the same way, so a comma never joins two into one. */
const said = (value: unknown): string => {
  if (value === undefined) return "not set";
  if (value === null) return NONE;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "empty" : value.map(one => typeof one === "string" ? text(one) : one === null ? "null" : said(one)).join(", ");
  return text(String(value));
};

/** The scope's own terms the card names, in order. A contract test holds `goal`, `outOfScope`, `touches` and
 * `acceptance` (contracts/scope.ts) and the scope's other signed fields to this list; the agent profile and the phase
 * route follow as one line per signed setting (`profile.…`, `route.…`). */
export const SCOPE_TERM_LABELS = {
  title: "Title", project: "Project", filedBy: "Filed by", goal: "Goal", outOfScope: "Not in scope", touches: "Paths it may touch",
  acceptance: "Done when", qualityMode: "Evidence standard", agents: "Agents and model", permission: "Agents may", checks: "Checks", checkAccess: "Check access",
  budgetMicrousd: "Budget per attempt", candidate: "Candidate commit",
} as const;

/** Every leaf of a signed value, at its path (`a.b`, `legs.0.model`), as the card says it. */
function leavesOf(value: unknown, path: string): { path: string; value: string }[] {
  if (Array.isArray(value)) return value.every(one => one === null || typeof one !== "object") ? [{ path, value: said(value) }]
    : value.flatMap((one, index) => leavesOf(one, `${path}.${index}`));
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return keys.length === 0 ? [{ path, value: "no settings" }] : keys.flatMap(key => leavesOf((value as Record<string, unknown>)[key], `${path}.${key}`));
  }
  return [{ path, value: said(value) }];
}

/** Every field of the release terms, by its path in the terms (contracts/release-terms.ts), against the schema's
 * own leaves: the contract test checks every one has a label. */
export const RELEASE_TERM_LABELS: Readonly<Record<string, string>> = {
  version: "Release terms version", repo: "Repository", packageVersion: "Package version", branch: "Branch", pr: "Pull request", base: "Base",
  approvedSha: "Approved commit", approvedTree: "Approved tree",
  "policy.version": "Carry policy version", "policy.rules": "Carry rules", "policy.carry": "Carry later commits",
  "policy.protectProject": "Protected: the whole project", "policy.protectedPaths": "Protected paths",
  "policy.limits.lines": "Carry limit: lines", "policy.limits.files": "Carry limit: files", "policy.limits.churn": "Carry limit: churn",
  "policy.unsandboxedCarry": "Carry when checks aren't sandboxed",
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
    project: repo === null ? NONE : `${text(projectName(repo))} (${text(repo)})`,
    filedBy: filer === null ? NONE : filer.name === null ? filer.kind : `${text(filer.name)}${filer.kind === "person" ? "" : ` (${filer.kind})`}`,
    goal: said(scope.goal),
    // null (nothing excluded) and an empty exclusion are signed apart, and read apart.
    outOfScope: said(scope.outOfScope),
    // No paths named is no limit: the work may touch any file in the project.
    touches: scope.touches.length === 0 ? "any file in the project" : said(scope.touches),
    // Each criterion's fields quoted, always: a colon or a parenthesis in one never moves the boundary to the next.
    acceptance: scope.acceptance.length === 0 ? NONE : scope.acceptance.map(one => `${quoted(one.id)}: ${quoted(one.statement)} (evidence: ${said(one.evidence)})`).join("; "),
    qualityMode: scope.qualityMode === "strict" ? "strict" : "standard",
    agents: profile === null ? NONE : `${profile.provider} · ${text(profile.model)}`,
    permission: said(words.profile(profile)),
    checks: CHECK_LEVEL_WORDS[effectiveCheckLevel(store, repo, scope.taskId).level],
    checkAccess: checkAccessWords(profile?.checkAccess ?? "sandboxed"),
    budgetMicrousd: scope.budgetMicrousd === null ? NONE : money(scope.budgetMicrousd),
    candidate: said(scope.candidate),
  };
  const lines: TermLine[] = (Object.keys(SCOPE_TERM_LABELS) as (keyof typeof SCOPE_TERM_LABELS)[]).map(key => ({ key, label: SCOPE_TERM_LABELS[key], value: scopeValues[key] }));
  // Every signed setting of the agent profile (what it may read, reach and write, its limits) and the phase route the
  // digest binds, one line each: the summary lines above never stand in for them.
  if (profile !== null) for (const leaf of leavesOf(profile, "profile")) lines.push({ key: leaf.path, label: `Agent setting ${leaf.path.slice("profile.".length)}`, value: leaf.value });
  if (scope.proposedRouteJson != null) {
    const route = routeFromJson(scope.proposedRouteJson);
    // Unreadable (it then never seals): its stored text, exactly, so two different ones never read alike.
    if (route === null) lines.push({ key: "route", label: "Phase route (unreadable)", value: quoted(scope.proposedRouteJson) });
    else for (const leaf of leavesOf(route, "route")) lines.push({ key: leaf.path, label: `Phase route ${leaf.path.slice("route.".length)}`, value: leaf.value });
  }
  const terms = scope.releaseTerms ?? null;
  for (const path of schemaLeaves(releaseTermsSchema)) {
    const label = RELEASE_TERM_LABELS[path] ?? path;
    const value = terms === null ? NONE : path === "pr" ? `#${terms.pr}`
      // The whole project is protected, and the signed list is said too (it is part of what was signed).
      : path === "policy.protectedPaths" && terms.policy.protectProject ? `the whole project (listed: ${said(terms.policy.protectedPaths)})`
      // Absent (sealed before the setting existed) is off, said apart from a signed "no".
      : path === "policy.unsandboxedCarry" && terms.policy.unsandboxedCarry === undefined ? "no (not set when sealed)" : said(valueAt(terms, path));
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
  /** A release is on the record but its merge commit can't be read (eval-harness review 2, finding 4). */
  baselineUnreadable?: true;
};

const SHA = /^[0-9a-f]{40}$/;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * The plane's own record of the last verified release of `repo`: the merge commit GitHub answered with, recorded once
 * the release verified the merged tree (the newest merged authority whose merge operation succeeded). Never a tag.
 * Whether the plane recorded one, and its merge commit (eval-harness review 2, finding 4):
 * `recorded: false` only when no merged release is on the record at all; a recorded one whose commit isn't a full id is
 * `recorded: true` with `sha: null` — something to refuse on, never "no previous release".
 */
export function releaseBaselineRecord(store: Store, repo: string): { recorded: false } | { recorded: true; sha: string | null } {
  const row = store.handle.prepare(`SELECT o.external_ref FROM release_authority a LEFT JOIN release_operation o
    ON o.authority = a.id AND o.kind = 'merge' AND o.state = 'succeeded'
    WHERE a.repo = ? AND a.state = 'merged' ORDER BY a.id DESC, o.finished_at DESC LIMIT 1`).get(repo);
  if (row === undefined) return { recorded: false };
  const ref = row["external_ref"];
  return { recorded: true, sha: typeof ref === "string" && SHA.test(ref) ? ref : null };
}

/** The commits after `from` up to `to`, as verified Git objects only, from the project's recorded Git directory: the
 * release coordinator's checkout config allowlist first, then commit-extract's verified range (every commit hashed here,
 * a shallow boundary, grafts or replacement refs refused, and the range proved to stop only in the last release's own
 * history). Null when they can't be read, so a card never shows a shortened list. */
export function commitsBetween(repo: string, from: string, to: string): { sha: string; subject: string }[] | null {
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
  const range = verifiedRange(gitDir, from, to, { git: tools.git, env });
  if (!range.ok) return null;
  return range.value.map(one => ({ sha: one.id, subject: one.message.split("\n")[0]!.trim() }));
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
  const record = releaseBaselineRecord(store, terms.repo);
  // A release recorded with a merge commit that can't be read: the list couldn't be read (eval-harness review 2,
  // finding 4) — never the pull request's commits, as if there were no previous release.
  if (record.recorded && record.sha === null) return { baseline: null, commits: null, source: "unread", baselineUnreadable: true, digest: sha256(`release-changes:${JSON.stringify({ baseline: null, source: "unread", commits: null, recorded: true })}`) };
  const baseline = record.recorded ? record.sha : null;
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
  if (changes.commits === null) return [head, changes.baseline === null && changes.baselineUnreadable !== true ? `The pull request's commits couldn't be read; see #${terms?.pr ?? "?"} on GitHub.` : "The change list couldn't be read."];
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
    // Option A's disclosure, on the card as on the approval sheet: never approved from chat without it.
    ...(terms !== null && terms.policy.carry && terms.access !== "sandboxed" ? ["This project's checks don't run in the sandbox: later test-only commits will run outside the sandbox without being shown to you first."] : []),
    // Filed while CI runs (Alex, 2026-10-29): a person may approve now, and is told plainly what still waits.
    ...(releaseCiRunningOf(store, scope.taskId) === null ? [] : [RELEASE_CI_RUNNING_WORDS]),
    // GitHub's nightly (nightly-github.ts): what holds this release, or why it can't be read. Not a signed term.
    ...(terms === null ? [] : nightlyReleaseLines(store, { repo: terms.repo, taskId: scope.taskId, candidate: scope.candidate ?? null, now: new Date() })),
    "",
    ...changeWords(changes, terms, 5),
    "",
    `Every term is in ${fileName}.`,
  ].join("\n");
  const full = [`${version === null ? "Deploy gate" : `Release ${version}`}: every term`, "", termsText(lines), "", ...changeWords(changes, terms, 200)].join("\n");
  return { digest: cardDigestOf(scope.digest, formDigest, changes), short, full, fileName, changes };
}
