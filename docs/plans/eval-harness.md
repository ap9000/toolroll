# Eval harness: trustworthy checks, recoverable flakes, reviewed final changes

Status: phase 1 approved for building 2026-10-28. Sources: two posts on evals (Confident AI "Build your eval harness";
"15 eval lessons"), the owner's goal ("minimal blockers by me"), and what went wrong releasing 0.9.76. Claude and Codex
each wrote recommendations independently; this plan merges them.

## What went wrong (evidence)
1. Linux CI: 11 git tests had no git identity; macOS derives one from the hostname, Linux can't.
2. A git < 2.48 product bug (worktree added through a view pointing at a deleted folder) was found by accident in Docker.
3. A TOCTOU in that fix landed after both Codex rounds; only the automated scan caught it.
4. Timing flakes rerun blindly: read-executor.test.ts (<1000 ms), tick.watch.slow.test.ts (450 ms window), up.slow.
5. Release check 3261 failed with a header-only log; the one failure seen locally (upgrade 0.9.73, "exit 1") lost its
   own output when the other parts were stopped. Never seen again in 8 runs.
6. Rerunning that check needed a new commit (`--new`), so a second owner approval.

## Where Claude and Codex agreed
- A missing, malformed or truncated result is an error, never a pass.
- Same-approval rerun of a release check on the same candidate: yes.
- Per-category failure rules replace the single flake cap; attack/containment/assertion failures have zero tolerance.
- Agent behaviour is counted over k runs (pass^k, 3/3), never rerun until it passes.
- Classification comes from protected plane policy and harness/runner records, never from candidate-written output.
- A scoped "delta review" for security code written after the last Codex round; it does not use up the 2 rounds.
- Reviewer evals with past buggy AND clean diffs; pin the reviewer model.
- Timing tests: event-based checks, not bigger thresholds.
- Not building: an eval platform, online evals/shadow deploys, simulated users, judge councils, full OS×Node×Git matrix.

## What Codex added (adopted)
- CI tests GitHub's synthetic merge commit (actions/checkout default on pull_request), not the candidate head that
  auto-approve trusts. Fix: release-qualifying jobs check out the PR head SHA and record it. Merge compatibility: the
  release gate requires the branch to contain main's head, so the merged tree is the tested tree (no extra CI job).
- src/check-report.ts lets a run with no valid report "pass or fail as before". Change: a Full check without a valid
  report, a complete inventory, terminal results for every obligation and a successful exit does not qualify.
- regateTask (src/dispose.ts:536) already preserves candidate, scope and approval: reuse it; fix the stale `--new`
  guidance (src/release.ts:640).
- A focused git 2.47 CI lane (declare the supported git floor); shared git-identity test fixture with
  `user.useConfigOnly=true` so hostname guessing can't hide missing setup.
- Retries inside a passing journey run currently escape the flake count.

## Where they differed, and the decision
| Question | Claude | Codex | Decision |
|---|---|---|---|
| Unexplained failure (generic exit 1, timeout, no result) | retryable as infrastructure | an error; retry only to diagnose unless an independent signal shows a transient cause | **Codex.** Safer. It still costs an approval when a failure is unexplained, so phase 1 makes failures explained (complete logs) |
| Which old git in CI | stock Ubuntu 24.04 (2.43) | 2.47, plus a declared floor | **Both:** declare the floor; test the floor and 2.47 if they differ |
| Delta review scope | the post-review diff | the diff plus the invariant and callers it touches; recorded reviewed SHA | **Codex** scope; recording/enforcement in phase 2 |

## Phase 1 (build now)
A. Complete evidence (scripts/release-check.mjs partRunner, scripts/suite-lifecycle.mjs, scripts/upgrade-path.mjs,
   src/check-report.ts): stream each part's output into evidence as it arrives, tagged by part/version; record start,
   exit, signal, timeout, cancel separately; a failing upgrade version's own log is printed before any abort; a check
   without a valid complete report does not qualify (an error, reported as "no result").
B. Same-candidate recheck under the existing approval: on a failed release check, `toolroll release` offers/performs a
   regate (regateTask) when the failure class permits; every attempt kept in the evidence.
C. Failure classes and limits (replace the flat AUTO_FLAKE_CAP=2 policy in src/release.ts / src/release-auto.ts):
   - deterministic (typecheck, build, attack/containment tests, assertions, migrations): 0 tolerated, no auto-retry;
   - independently confirmed transient infrastructure (runner lost, provider outage observed by the plane, GitHub
     runner failure before tests ran): ≤1 retry per incident, ≤2 per candidate;
   - unknown (exit 1 without a failing test, unexplained timeout/OOM, missing result): error; blocks; a diagnostic rerun
     may run but its pass does not erase the failure;
   - agent behaviour (real-model journeys): counted, never rerun-to-pass.
   Classification only from plane-side records and runner/provider events.
D. CI (.github/workflows/ci.yml): check out the PR head SHA; record it; gate requires branch ⊇ main's head; a git 2.47
   lane running the git attack tests and worktree tests; shared git-identity fixture with user.useConfigOnly.
E. Timing tests: read-executor.test.ts and tick.watch.slow.test.ts rewritten to event-based checks with a generous hang
   guard.
F. Process: delta review of post-review security changes (diff + affected invariant/callers), recorded in the arc's
   notes; not a third round.

## Phase 2 (after phase 1 ships)
Results ledger across commits; a 20–30 case versioned eval set from real failures and representative successes, run
3× with fixed / regressed / newly flaky / still failing vs a pinned baseline; tool trajectories, tokens, cost per
successful task, latency; reviewer evals (recall and clean-diff specificity per reviewer, pinned model); delta-review
coverage enforced in sealAutoGreen.
