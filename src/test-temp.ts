/**
 * Test temp folders (`toolroll storage`, `storage clean`, the plane's daily storage sweep): what the unit tests,
 * journeys and scripts make in the system temp folder. The suites delete their own on pass, failure, timeout and
 * interrupt (scripts/suite-lifecycle.mjs, test/temp-root.ts); a run killed outright, a proof that keeps its output and
 * older versions leave folders behind. `toolroll storage` counts them; the daily sweep (storage-sweep.ts) and
 * `storage clean` remove the ones nothing has touched for a day, never one whose owner is still running.
 *
 * Every prefix the tests and scripts give tmpdir() is covered here (test-temp.test.ts reads the sources to keep it
 * so), and Playwright's own browser profiles.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DAY_MS = 86_400_000;
/** In a suite's temp root: who made it (scripts/suite-lifecycle.mjs). */
export const OWNER_FILE = ".toolroll-temp-owner";
export type TempOwner = { pid: number; startedAt: number };

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

/** Who made a temp root, from its owner file; null when it has none (older suites, scripts, Playwright). */
export function tempOwner(path: string): TempOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(join(path, OWNER_FILE), "utf8")) as { pid?: unknown; startedAt?: unknown };
    const startedAt = typeof parsed.startedAt === "string" ? Date.parse(parsed.startedAt) : NaN;
    return Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 1 && Number.isFinite(startedAt) ? { pid: Number(parsed.pid), startedAt } : null;
  } catch { return null; }
}

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

export type RemoveOptions = {
  /** Whether a temp root's owner (by its owner file) is still running: its root stays, however old it looks. */
  ownerAlive?: (owner: TempOwner) => boolean;
  /** At most this many go in one pass (a sweep after weeks can find 100,000); `more` says some were left. */
  max?: number;
};

/**
 * Remove the test temp folders nothing has touched for a day; each is looked at again right before it goes (still a
 * folder of its own, not a link, still directly in its temp folder, still a day untouched, its owner gone).
 */
export function removeStaleTestTemp(roots: readonly string[], now: Date, options: RemoveOptions = {}): { removed: string[]; failed: string[]; more: boolean } {
  const removed: string[] = [];
  const failed: string[] = [];
  const stale = testTempFolders(roots, now).stale;
  const max = options.max ?? Infinity;
  const inside = new Set(roots.map(root => resolve(root)));
  for (const one of stale) {
    if (removed.length + failed.length >= max) return { removed, failed, more: true };
    try {
      const stat = lstatSync(one.path);
      if (stat.isSymbolicLink() || !inside.has(resolve(dirname(one.path)))) continue;
      if (now.getTime() - (stat.isDirectory() ? touchedAt(one.path) : stat.mtimeMs) <= DAY_MS) continue;
      const owner = stat.isDirectory() ? tempOwner(one.path) : null;
      if (owner !== null && (options.ownerAlive ?? (() => false))(owner)) continue;
      removeTree(one.path);
      removed.push(one.path);
    } catch { failed.push(one.path); }
  }
  return { removed, failed, more: false };
}

/** rm -r; a tree a test made read-only (a shared dependency copy, a locked fixture) is made writable first. */
function removeTree(path: string): void {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 3 }); return; } catch { /* read-only inside */ }
  if (process.platform !== "win32") spawnSync("chmod", ["-R", "u+w", path], { timeout: 120_000 });
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}
