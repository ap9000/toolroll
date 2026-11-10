/**
 * Whether a change can affect an upgrade: the release check's rule (release-check.mjs) and the pull request's
 * (ci-upgrade-scope.mjs), in one place.
 *
 * It imports nothing. The pull request's scope job runs the base revision's copy before anything is installed, so a
 * package import anywhere in what this file loads fails that job, and a failed scope job runs the upgrade test on every
 * pull request.
 */

/** Where a release bumps the project's own version. */
export const VERSIONED = ["package.json", "package-lock.json"];

/** Skip only paths known not to affect upgrades. Unknown runtime code runs upgrades:
 * this includes the entire store import graph, SQL-bearing modules and updaters,
 * without maintaining a second, inevitably incomplete dependency graph.
 */
export function needsUpgrade(changed, full = false, versionBumps = []) {
  return full || changed === null || changed.some(file => {
    if (versionBumps.includes(file) && VERSIONED.includes(file)) return false;
    if (/^(docs|evidence|design|output)\//.test(file) || /\.md$/.test(file) || file === "LICENSE") return false;
    if (/\.test\.[cm]?[jt]sx?$/.test(file) || /^test\//.test(file)) return false;
    if (/^src\/(browser|design)\//.test(file) || /\.css$/.test(file)) return false;
    // Standalone journeys are not imported by the upgrade runner. Other scripts,
    // including its provider gate and lifecycle helpers, conservatively run it.
    if (/^scripts\/(app-e2e|flows-e2e|e2e-parallel)\.mjs$/.test(file)) return false;
    return true;
  });
}

/** NUL separators preserve filenames; failed history or untracked discovery runs upgrades. No rename pairing: a
 * file moved out of a migration path still lists its old path, so the move can't hide it. */
export function upgradeChanges(base, readGit) {
  if (base === null) return null;
  try {
    return [...new Set([
      ...readGit("diff", "--no-renames", "--name-only", "-z", base).split("\0"),
      ...readGit("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
    ].filter(Boolean))];
  } catch { return null; }
}
