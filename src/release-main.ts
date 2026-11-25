/**
 * Releasing Toolroll from main (docs/plans/release-from-main.md, part A): the pure parts the coordinator (release.ts)
 * and `toolroll release prepare` share. A release is one commit M on main, the squash merge of a `release-<version>`
 * pull request (so release-candidate.yml ran Node 22 on exactly its tree), proven with publish.yml's own proof
 * (scripts/release-proof.mjs) before anything is filed, immediately before the deploy and immediately before the tag.
 * M never moves: commits that land on main after it belong to the next release.
 */
import { join } from "node:path";

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** The branch a version's release pull request comes from (release-candidate.yml runs only for `release-*` heads). */
export const releaseBranchFor = (version: string): string => `release-${version}`;

/** A release from main's journal: one per version, apart from the branch journals so neither is read as the other. */
export const mainJournalFile = (stateDir: string, version: string): string => join(stateDir, "releases", "from-main", `${version}.json`);

/** The lock key `takeReleaseRun` holds for a release from main (never a branch name: branches can't hold a colon). */
export const mainRunKey = (version: string): string => `from-main:${version}`;

export const mainResumeCommand = (version: string, checkout: string): string => `toolroll release ${version} --repo ${checkout}`;

/** GitHub's record of a release commit on main, as the coordinator keeps it and binds every resume to. */
export type MainProof = { sha: string; tree: string; pr: number; head: string; branch: string };

/** What the coordinator reads about a version's release pull request. */
export type MainPull = { kind: "merged"; pr: number; sha: string } | { kind: "open"; pr: number; head: string } | { kind: "none" };

/** Whether a newly read proof is the same release the journal holds: the same commit, tree, pull request, head and branch. */
export function sameRelease(held: MainProof, read: MainProof): string | null {
  if (read.sha !== held.sha) return `the release commit is now ${read.sha.slice(0, 7)}, not ${held.sha.slice(0, 7)}`;
  if (read.tree !== held.tree) return `${held.sha.slice(0, 7)}'s tree is now ${read.tree.slice(0, 12)}, not ${held.tree.slice(0, 12)}`;
  if (read.pr !== held.pr) return `${held.sha.slice(0, 7)} is now pull request #${read.pr}'s merge, not #${held.pr}'s`;
  if (read.head !== held.head || read.branch !== held.branch) return `pull request #${held.pr}'s tested head is now ${read.branch} at ${read.head.slice(0, 7)}, not ${held.branch} at ${held.head.slice(0, 7)}`;
  return null;
}

/**
 * The first-parent walk from main's head back to `sha`, from GitHub's own commit list (`sha → parents`): the commits
 * after it, newest first, or null when `sha` isn't on main's first-parent history within what was read (a rewrite, a
 * removal, or main moved too far: refused, never guessed).
 */
export function firstParentAfter(head: string, sha: string, parents: ReadonlyMap<string, readonly string[]>): string[] | null {
  const after: string[] = [];
  const seen = new Set<string>();
  for (let at: string | undefined = head; at !== undefined; at = parents.get(at)?.[0]) {
    if (at === sha) return after;
    if (seen.has(at) || !parents.has(at)) return null;
    seen.add(at);
    after.push(at);
  }
  return null;
}

/** A JSON string literal's span for the version value of `"version": "<value>"` at `from` in `text`, or null. */
function versionSpan(text: string, from: number, value: string): { start: number; end: number } | null {
  const pattern = /"version"\s*:\s*"/g;
  pattern.lastIndex = from;
  const found = pattern.exec(text);
  if (found === null) return null;
  const start = found.index + found[0].length;
  if (text.slice(start, start + value.length + 1) !== `${value}"`) return null;
  return { start, end: start + value.length };
}

/** Parse strictly: duplicate keys (which JSON.parse silently collapses) refuse, as the plane's own version reader does. */
function strictJson(text: string): Record<string, unknown> | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const tokens = (source: string) => JSON.stringify(source.match(/"(?:\\.|[^"\\])*"|[^\s"{}[\]:,]+|[{}[\]:,]/g));
  return tokens(text) === tokens(JSON.stringify(value)) ? value as Record<string, unknown> : null;
}

/**
 * `package.json` and `package-lock.json` with only the project's own version changed, by byte substitution (the same
 * rule as the docs-and-version reuse in part B): package.json exactly its single top-level "version", the lockfile
 * exactly its top-level "version" and `packages[""].version`; every other byte stays. Null when the file isn't shaped
 * so (a duplicate key, a version elsewhere first, an unexpected current version).
 */
export function bumpVersion(file: "package.json" | "package-lock.json", text: string, from: string, to: string): string | null {
  if (!VERSION_PATTERN.test(to) || !VERSION_PATTERN.test(from)) return null;
  const before = strictJson(text);
  if (before === null || before["version"] !== from) return null;
  const spans: { start: number; end: number }[] = [];
  const first = versionSpan(text, 0, from);
  if (first === null) return null;
  spans.push(first);
  if (file === "package-lock.json") {
    const packages = before["packages"] as Record<string, Record<string, unknown>> | undefined;
    if (packages?.[""]?.["version"] !== from) return null;
    const second = versionSpan(text, first.end, from);
    if (second === null) return null;
    spans.push(second);
  }
  let out = text;
  for (const span of [...spans].reverse()) out = `${out.slice(0, span.start)}${to}${out.slice(span.end)}`;
  // What changed is exactly the version fields this rule names, nothing else.
  const after = strictJson(out);
  if (after === null || after["version"] !== to) return null;
  const strip = (value: Record<string, unknown>) => {
    const copy = structuredClone(value);
    delete copy["version"];
    const root = (copy["packages"] as Record<string, Record<string, unknown>> | undefined)?.[""];
    if (file === "package-lock.json" && root !== undefined) delete root["version"];
    return JSON.stringify(copy);
  };
  if (strip(before) !== strip(after)) return null;
  if (file === "package-lock.json" && (after["packages"] as Record<string, Record<string, unknown>>)[""]?.["version"] !== to) return null;
  return out;
}

/** CHANGELOG.md with `## <version> — <date>` and its notes before the first release heading (or at the end). */
export function changelogWith(text: string, version: string, notes: string, date: string): string {
  const heading = `## ${version} — ${date}`;
  const entry = `${heading}\n\n${notes.trim()}\n\n`;
  const at = text.search(/^## /m);
  return at === -1 ? `${text.replace(/\s*$/, "\n\n")}${entry}` : `${text.slice(0, at)}${entry}${text.slice(at)}`;
}

/** Whether CHANGELOG.md has an entry for `version` (the heading the release coordinator has always required). */
export function changelogHas(text: string, version: string): boolean {
  return new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`, "m").test(text);
}

/** Files whose change since the last release means CI's own rules changed: the judges in scripts/gate-files.json, and
 * the build and test harness a candidate's code runs CI through (Codex review of the plan, finding 1). Shown on the
 * release card with `--full` offered; it never forces anything (the owner's decision, 2026-11-25). */
export const HARNESS_PATTERNS: readonly RegExp[] = [
  /^\.github\/workflows\//, /^scripts\/(?:ci-|release-proof|release-check|gate-|guard-|browser-build|suite-lifecycle|upgrade-rule)/, /^vitest\.config\.ts$/,
  /^test\/(?:setup|setup-state|ensure-build)\b/, /^package(?:-lock)?\.json$/, /^tsconfig[^/]*\.json$/, /^scripts\/gate-files\.json$/,
];

/** Which of `changed` are judges, the build or the test harness. A version bump alone (package.json/lockfile) counts:
 * the caller drops files whose only change is the version before asking. */
export function harnessChanges(changed: readonly string[]): string[] {
  return changed.filter(path => HARNESS_PATTERNS.some(pattern => pattern.test(path)));
}
