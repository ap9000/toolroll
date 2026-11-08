#!/usr/bin/env node
/**
 * Whether a pull request's upgrade test runs (.github/workflows/upgrade-path.yml). The rule is the release check's own
 * (release-check.mjs needsUpgrade and upgradeChanges), so a change that could affect an upgrade fails here, on the pull
 * request, before anyone is asked to approve a release.
 *
 *   node <trusted copy>/scripts/ci-upgrade-scope.mjs decide --base <sha> --head <sha> --root <checkout>
 *
 * prints `upgrade=run` or `upgrade=skip` (for $GITHUB_OUTPUT) and says why on stderr. It compares the merge base with
 * the head commit. A diff it can't read runs the test, as it does in the release check.
 *
 * Trust: the workflow runs the base revision's copy of this file and of the rule, and it runs none of the candidate's
 * code. Git runs through the same hardened read as scripts/ci-scope.mjs.
 */
import { readGit } from "./deploy-git.mjs";
import { needsUpgrade, upgradeChanges } from "./release-check.mjs";

const SHA = /^[0-9a-f]{40}$/;

/** The files between the merge base and the head, or null when git can't say. A commit has no untracked files, and the
 * trusted copy beside the checkout must not read as one. */
export function pullRequestChanges(git, base, head) {
  if (!SHA.test(base ?? "") || !SHA.test(head ?? "")) return null;
  try {
    const from = git(["merge-base", base, head]).trim();
    if (!SHA.test(from)) return null;
    return upgradeChanges(from, (...args) => args[0] === "ls-files" ? "" : git([...args, head, "--"]));
  } catch { return null; }
}

/** The decision and why. `changed` is null when the diff couldn't be read. */
export function upgradeScope(changed) {
  const run = needsUpgrade(changed);
  return { run, why: changed === null ? "the diff couldn't be read" : run ? `${changed.length} changed file${changed.length === 1 ? "" : "s"}, some of which can affect upgrades` : "nothing here can affect an upgrade" };
}

const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at === -1 ? undefined : args[at + 1]; };

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "decide") { console.error("usage: ci-upgrade-scope.mjs decide --base <sha> --head <sha> --root <checkout>"); process.exit(2); }
  const root = flag(args, "root") ?? ".";
  const git = argv => readGit(["-C", root], argv, { PATH: process.env.PATH ?? "/usr/bin:/bin" });
  const decision = upgradeScope(pullRequestChanges(git, flag(args, "base"), flag(args, "head")));
  console.error(`upgrade test: ${decision.run ? "runs" : "not needed"}: ${decision.why}`);
  console.log(`upgrade=${decision.run ? "run" : "skip"}`);
}
