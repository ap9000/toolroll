#!/usr/bin/env node
/**
 * Whether a pull request's area lanes run (docs/plans/test-matrix.md): the Windows, Linux fence, cgroup and git lanes
 * run on every pull request except a narrow documentation-only change, and always on anything else.
 *
 *   node <trusted copy>/scripts/ci-scope.mjs decide --event <event> --head-ref <branch> --base <sha> --head <sha> --root <checkout>
 *
 * prints `areas=run` or `areas=docs-only` (for $GITHUB_OUTPUT) and says why on stderr. Documentation-only means: a
 * pull request, from a branch not named release-*, whose diff from the merge base to the head only adds or modifies
 * Markdown files under docs/, CHANGELOG.md or README.md. A rename, copy, deletion, type change or unmerged entry, any
 * other file, an empty diff, or a diff that can't be read whole runs every lane. The lanes it spares report as skipped,
 * which main's protection accepts for a merge and the release gate never accepts (src/release.ts prChecksVerdict): a
 * release needs every lane executed on its exact head.
 *
 * Trust: ci.yml runs the trusted base revision's copy of this file, as it does the shard verifier. Git runs with no
 * system or global config, no hooks, no external diff or text conversion.
 */
import { readGit } from "./deploy-git.mjs";

const SHA = /^[0-9a-f]{40}$/;

/** A path documentation-only may touch: a Markdown file under docs/ (any depth), CHANGELOG.md or README.md. */
export function docsPath(path) {
  if (typeof path !== "string" || path === "") return false;
  const parts = path.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) return false;
  if (parts.length === 1) return path === "CHANGELOG.md" || path === "README.md";
  return parts[0] === "docs" && path.endsWith(".md");
}

/**
 * `git diff --name-status -z` output as entries, or null when it isn't exactly that shape: a status (A, C, D, M, R, T,
 * U, X or B, a score after R and C) and its path, two paths for a rename or a copy.
 */
export function parseNameStatus(raw) {
  if (typeof raw !== "string") return null;
  if (raw === "") return [];
  if (!raw.endsWith("\0")) return null;
  const words = raw.slice(0, -1).split("\0");
  const entries = [];
  for (let at = 0; at < words.length;) {
    const status = words[at++];
    if (!/^(?:[ADMTUXB]|[RC]\d{1,3})$/.test(status)) return null;
    const count = /^[RC]/.test(status) ? 2 : 1;
    const paths = words.slice(at, at + count);
    if (paths.length !== count || paths.some(path => path === "")) return null;
    at += count;
    entries.push({ status: status[0], paths });
  }
  return entries;
}

/** Whether the area lanes run, and why. `entries` is parseNameStatus's answer (null: the diff couldn't be read). */
export function areaLanes({ event, headRef, entries }) {
  if (event !== "pull_request") return { run: true, why: `a ${String(event)} run tests everything` };
  if (typeof headRef !== "string" || headRef === "" || headRef.startsWith("release-")) return { run: true, why: "a release candidate's branch runs every lane" };
  if (!Array.isArray(entries)) return { run: true, why: "the diff couldn't be read whole" };
  if (entries.length === 0) return { run: true, why: "the diff is empty" };
  for (const entry of entries) {
    if (entry.status !== "A" && entry.status !== "M") return { run: true, why: `${entry.paths.join(" → ")} was ${{ D: "deleted", R: "renamed", C: "copied", T: "changed in type" }[entry.status] ?? "changed"}` };
    const other = entry.paths.find(path => !docsPath(path));
    if (other !== undefined) return { run: true, why: `${other} isn't documentation` };
  }
  return { run: false, why: `${entries.length} documentation file${entries.length === 1 ? "" : "s"} only` };
}

/** The pull request's changes from its merge base to its head, or null when git can't give them whole. */
export function diffEntries(root, base, head) {
  if (!SHA.test(base ?? "") || !SHA.test(head ?? "")) return null;
  try {
    const git = args => readGit(["-C", root], args, { PATH: process.env.PATH ?? "/usr/bin:/bin" });
    const from = git(["merge-base", base, head]).trim();
    if (!SHA.test(from)) return null;
    return parseNameStatus(git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--find-renames", "--find-copies-harder", "--name-status", "-z", from, head, "--"]));
  } catch { return null; }
}

const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at === -1 ? undefined : args[at + 1]; };

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "decide") { console.error("usage: ci-scope.mjs decide --event <event> --head-ref <branch> --base <sha> --head <sha> --root <checkout>"); process.exit(2); }
  const event = flag(args, "event"), headRef = flag(args, "head-ref") ?? "";
  // Only a pull request's diff is read; anything else runs everything before git is asked.
  const entries = event === "pull_request" ? diffEntries(flag(args, "root") ?? ".", flag(args, "base"), flag(args, "head")) : null;
  const decision = areaLanes({ event, headRef, entries });
  console.error(`area lanes: ${decision.run ? "run" : "not applicable (docs-only)"}: ${decision.why}`);
  console.log(`areas=${decision.run ? "run" : "docs-only"}`);
}
