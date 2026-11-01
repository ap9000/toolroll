/**
 * What a release task's page shows (docs/plans/release-once.md, "What people see"): for the approved task, the release
 * it's approved for, every later commit carried under it, the open check obligations and the last nightly result for
 * main; for a carried task, whose release approval it was carried from. Read-only, from the store.
 */
import { liveReleaseOf } from "./scope.js";
import { nightlyReleaseLines } from "./nightly-github.js";
import { releaseAuthorityOfTask, releaseCarries, type Store } from "./store.js";

export type LandedView = { sha: string; task: string; files: { path: string; added: number; deleted: number }[] };
export type ReleaseView = {
  kind: "anchor" | "carried";
  authority: number;
  version: string;
  pr: number;
  state: string;
  /** Whether the release still carries later commits, and why not. */
  carrying: boolean;
  why: string | null;
  approver: string | null;
  anchorTask: string;
  tipTask: string;
  expiresAt: string;
  landed: LandedView[];
  /** Identities a later check of this release must run again and pass (release-recheck.ts). */
  obligations: string[];
  nightly: { at: string; sha: string; outcome: string | null } | null;
  openMainFailures: number;
  /** GitHub's nightly (nightly-github.ts): each open lane failure, held or exempted for this release's tip, and a
   * warning when it couldn't be read or hasn't run lately. */
  githubNightly: string[];
};

export function releaseViewOf(store: Store, taskId: string, now: Date, obligations: (authority: number) => string[] = () => []): ReleaseView | null {
  const found = releaseAuthorityOfTask(store, taskId);
  if (found === null) return null;
  const a = found.authority;
  const live = liveReleaseOf(store, a.tipTask, "dispatch", now);
  const anchor = store.getScope(a.anchorTask);
  const nightly = store.handle.prepare("SELECT sha, outcome, at FROM nightly_check WHERE repo = ? ORDER BY id DESC LIMIT 1").get(a.repo);
  const open = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM main_check_failure WHERE repo = ? AND cleared_at IS NULL").get(a.repo)?.["n"] ?? 0);
  return {
    kind: found.carry === null ? "anchor" : "carried",
    authority: a.id, version: a.version, pr: a.pr, state: a.state,
    carrying: a.state === "open" && live.applies && live.ok, why: live.applies && !live.ok ? live.why : null,
    approver: anchor?.approvedBy ?? null, anchorTask: a.anchorTask, tipTask: a.tipTask, expiresAt: a.expiresAt,
    landed: releaseCarries(store, a.id).flatMap(carry => carry.commits.map(commit => ({ sha: commit.sha, task: carry.taskId, files: commit.files }))),
    obligations: obligations(a.id),
    nightly: nightly === undefined ? null : { at: String(nightly["at"]), sha: String(nightly["sha"]), outcome: nightly["outcome"] == null ? null : String(nightly["outcome"]) },
    openMainFailures: open,
    githubNightly: nightlyReleaseLines(store, { repo: a.repo, taskId: a.tipTask, candidate: a.tipSha, now }),
  };
}
