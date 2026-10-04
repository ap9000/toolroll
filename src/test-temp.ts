/**
 * Test temp folders (`toolroll storage`, `storage clean`): what the unit tests, journeys and scripts make in the
 * system temp folder. The tests delete their own (each run gets one temp root that its global teardown removes:
 * test/temp-root.ts); a run that was killed, and older versions, leave folders behind. `toolroll storage` counts them
 * and `storage clean` removes the ones nothing has touched for a day.
 *
 * Every prefix the tests and scripts give tmpdir() is covered here (test-temp.test.ts reads the sources to keep it
 * so), and Playwright's own browser profiles.
 */
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAY_MS = 86_400_000;

/** Name prefixes of what tests, journeys and scripts leave in the temp folder. */
export const TEST_TEMP_PREFIXES: readonly string[] = [
  "so-", "standing-orders-", "toolroll-", "no-wt", "epoch", "cancel-floor",
  "attest-", "budgets-", "chat-v66-", "check-levels-", "coding-context-", "console-url-", "console-v2-", "e2-attest-",
  "flow-goal-", "flow-scratch", "flows-chat-", "invoke-attest-", "knowledge-test-", "learning-", "peek-", "phone-origin-",
  "proposal-repo-", "race-", "refresh-migration-", "refresh-refusal-", "release-check-", "shared-chat-", "skills-test-",
  "task-status-surfaces-", "template-repo-", "template-test-", "v14-migrate-", "v17-migrate-", "watch-anchor-",
  "needs-you-", "deps-lock-", "deps-state-", "upgrade-fresh-", "upgrade-path-", "deploy-restore-", "result-review-", "one-result-page-", "deploy-before-swap-", "one-vocabulary-", "accept-finishes-", "lead-promises-", "lead-people-", "sizing-repo-",
  // Playwright's browser profiles and artifacts.
  "playwright_chromiumdev_profile-", "playwright_firefoxdev_profile-", "playwright-artifacts-",
];

export function isTestTemp(name: string): boolean {
  return TEST_TEMP_PREFIXES.some(prefix => name.startsWith(prefix));
}

/** Where they collect: the temp folder (and /tmp, where some scripts write). */
export function tempRoots(): string[] {
  const roots = [tmpdir()];
  if (process.platform !== "win32" && !roots.includes("/tmp")) roots.push("/tmp");
  return roots;
}

export type TempLeftover = { path: string; touchedAt: number };

/** When anything last happened in a folder: it, or what is directly in it, last changed. */
function touchedAt(path: string): number {
  let newest = lstatSync(path).mtimeMs;
  let names: string[] = [];
  try { names = readdirSync(path); } catch { return newest; }
  for (const name of names) { try { newest = Math.max(newest, lstatSync(join(path, name)).mtimeMs); } catch { /* gone */ } }
  return newest;
}

/** Every test temp folder in `roots`, and which of them nothing has touched for a day. */
export function testTempFolders(roots: readonly string[], now: Date): { all: TempLeftover[]; stale: TempLeftover[] } {
  const all: TempLeftover[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!isTestTemp(name)) continue;
      const path = join(root, name);
      try {
        const stat = lstatSync(path);
        const key = `${stat.dev}:${stat.ino}`;
        if (seen.has(key) || stat.isSymbolicLink()) continue;
        seen.add(key);
        all.push({ path, touchedAt: stat.isDirectory() ? touchedAt(path) : stat.mtimeMs });
      } catch { /* gone */ }
    }
  }
  return { all, stale: all.filter(one => now.getTime() - one.touchedAt > DAY_MS) };
}

/** Remove the test temp folders nothing has touched for a day; each is looked at again right before it goes. */
export function removeStaleTestTemp(roots: readonly string[], now: Date): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const one of testTempFolders(roots, now).stale) {
    try {
      if (now.getTime() - (lstatSync(one.path).isDirectory() ? touchedAt(one.path) : lstatSync(one.path).mtimeMs) <= DAY_MS) continue;
      rmSync(one.path, { recursive: true, force: true, maxRetries: 3 });
      removed.push(one.path);
    } catch { failed.push(one.path); }
  }
  return { removed, failed };
}
