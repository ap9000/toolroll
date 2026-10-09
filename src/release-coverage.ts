/** Whether a release check already covers a result whose checks were Off: a
 * passing FULL release check (run_check.release) on the same project whose
 * checked commit contains the result's commit. Read at read time from the
 * existing records and Git; nothing is written back, so no proof, receipt,
 * scope digest or schema changes. Fails closed: a receipt that can't be read,
 * a missing commit or any Git error leaves the result uncovered. */
import { execFileSync } from "node:child_process";
import type { Store } from "./store.js";
import { verificationEvidence } from "./verification-evidence.js";
import { runCheckLevel } from "./check-levels.js";

export type ReleaseCoverage = { run: number; head: string };

/** How many of the newest passing release checks one read considers. */
export const RELEASE_SCAN_LIMIT = 20;
const SHA = /^[a-f0-9]{40}$/;

/** Ancestry between two fixed commits never changes, so a settled answer is kept; errors are not. */
const ancestry = new Map<string, boolean>();
const ANCESTRY_LIMIT = 4096;

export type IsAncestor = (repo: string, ancestor: string, descendant: string) => boolean | null;

/** `git merge-base --is-ancestor`: true, false, or null when Git couldn't say. */
export const gitIsAncestor: IsAncestor = (repo, ancestor, descendant) => {
  if (!SHA.test(ancestor) || !SHA.test(descendant)) return null;
  if (ancestor === descendant) return true;
  const key = `${repo}\0${ancestor}\0${descendant}`;
  const known = ancestry.get(key);
  if (known !== undefined) return known;
  let answer: boolean | null;
  try {
    execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore", timeout: 5_000 });
    answer = true;
  } catch (error) {
    // Exit 1 is Git's "no"; anything else (a missing object, no repository, a timeout) is no answer.
    answer = (error as { status?: unknown }).status === 1 ? false : null;
  }
  if (answer !== null) {
    if (ancestry.size >= ANCESTRY_LIMIT) ancestry.clear();
    ancestry.set(key, answer);
  }
  return answer;
};

/** The newest passing full release checks of one project, each with its sealed, verified commit. Read once per
 * caller-held memo, so a list of results reads the receipts once. */
function passingReleases(store: Store, root: string, repo: string): ReleaseCoverage[] {
  let rows: Record<string, unknown>[];
  try {
    rows = store.handle.prepare(`SELECT rc.run FROM run_check AS rc INDEXED BY run_check_release
      JOIN run ON run.id = rc.run JOIN task_ref AS ref ON ref.id = run.task_ref
      WHERE rc.release = 1 AND rc.status = 'passed' AND rc.exit_code = 0 AND ref.repo = ?
      ORDER BY rc.run DESC LIMIT ${RELEASE_SCAN_LIMIT}`).all(repo);
  } catch { return []; }
  return rows.flatMap(row => {
    const run = Number(row["run"]);
    try {
      // Full only: a quick or Off release check covers nothing.
      const level = runCheckLevel(store, run);
      if (level !== null && level !== "full") return [];
      const gate = verificationEvidence(store, root, run);
      if (!gate.ok || gate.bytes === null) return [];
      const receipt = JSON.parse(gate.bytes) as { run?: unknown; head?: unknown; result?: { ran?: unknown; exitCode?: unknown }; command?: { repo?: unknown } };
      const head = store.getRun(run)?.headRevision ?? null;
      if (receipt.run !== run || receipt.result?.ran !== true || receipt.result.exitCode !== 0) return [];
      if (typeof receipt.command?.repo === "string" && receipt.command.repo.startsWith("quick:")) return [];
      if (typeof receipt.head !== "string" || !SHA.test(receipt.head) || receipt.head !== head) return [];
      return [{ run, head: receipt.head }];
    } catch { return []; }
  });
}

export type ReleaseMemo = Map<string, ReleaseCoverage[]>;

/** The release check covering `head` in `repo`, or null. `memo` keeps one read's receipts. */
export function releaseCoverageOf(store: Store, root: string | undefined, repo: string | null, head: string | null,
  options: { memo?: ReleaseMemo; isAncestor?: IsAncestor } = {}): ReleaseCoverage | null {
  if (root === undefined || repo === null || head === null || !SHA.test(head)) return null;
  const memo = options.memo ?? new Map<string, ReleaseCoverage[]>();
  let releases = memo.get(repo);
  if (releases === undefined) { releases = passingReleases(store, root, repo); memo.set(repo, releases); }
  const isAncestor = options.isAncestor ?? gitIsAncestor;
  return releases.find(one => isAncestor(repo, head, one.head) === true) ?? null;
}
