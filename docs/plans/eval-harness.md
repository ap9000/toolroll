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

### Phase 1 build notes (D, E)
- D, head commit: every ci.yml job checks out `github.event.pull_request.head.sha || github.sha` (job env
  `TESTED_SHA`) and a "Tested commit" step proves `git rev-parse HEAD` equals it before anything builds, writing it to
  the step summary; src/ci-workflow.test.ts holds every job to that.
- D, merge compatibility (integrated): the release gate refuses a candidate whose head does not contain main's head
  (src/release.ts containsMain: main's head and the comparison from GitHub's API — review round 1, finding 4), at the gate before anything is filed and again right before the merge, reason `base-moved`, words
  "The branch is behind main; update it and push." Attack tests in src/release.slow.test.ts (behind at the gate; main
  moved after the gate).
- D, git floor: **git 2.41** (README; src/git-floor.ts). The binding feature is the global `git --attr-source` option,
  used by every page read: checked in Docker, 2.40.4 answers "unknown option: --attr-source" and fails 14 git tests;
  2.41.3 passes all of `npm run test:git`. Others in use are older: `worktree list -z` 2.36, `GIT_CONFIG_COUNT` and
  `--path-format` 2.31; `worktree.useRelativePaths` (2.48) is a setting older git ignores; reftable (2.45) can't be
  made on older git, so its test proves that instead. `git --no-lazy-fetch` arrived in 2.45 (2.44.4 and 2.43.7 refuse
  it): teardown-git.ts asks once per process (`git --no-lazy-fetch version`, plain env) and on older git leaves the flag
  out of every hardened read and instead refuses any repository whose config makes lazy fetching possible
  (`extensions.partialClone`, `remote.<name>.promisor` not plainly false, `remote.<name>.partialCloneFilter`,
  `remote.<name>.vcs`), always from the frozen view's own config listing, the config git then runs with: checkoutGit /
  checkoutGitSync / viewedGitSync. The reads that ran git directly on a repository (project knowledge and learning,
  task base, release coverage, prepared evidence, grant's check-ignore, the revision-base merge-base) go through such a
  view on old git (lazyFetchSafeGit, viewedGitSync), never check-then-run; the builder's base-tree and review-context
  reads already use the builder's hardened view. The view also refuses includes and, by the deny-by-default classifier,
  every `protocol.*` key and `remote.<name>.vcs` on any git version, so a repository's `protocol.ext.allow=always` can't
  outrank `-c protocol.allow=never`. A security scan of the first version (a `--no-includes` check-then-run) led here.
  Words: "this project is a partial clone; protected reads need git 2.45 or newer". `toolroll up`/`serve`/`watch` refuse
  to start below the floor (reason `git-too-old`) and `toolroll doctor` names it; other commands aren't held. Stock
  Ubuntu 24.04 (2.43) is above the floor; Debian 12 (2.39) is below it.
- D, git lanes: ci.yml job `git` (container node:22-trixie, matrix 2.41 built from the pinned kernel.org tarball by
  scripts/ci-git.sh, 2.47 = Debian's), running `npm run test:git` as the unprivileged `node` user, then
  scripts/ci-no-skips.mjs fails the job if any test was skipped, except the "native …" OS-fence attacks (3 in these
  files; a plain container has no bubblewrap/Seatbelt; the linux fence job runs them with TOOLROLL_REQUIRE_NATIVE). The
  floor lane also runs test/attacks/checkout-git-partial-clone.test.ts by name. "git 2.41 · debian trixie" and
  "git 2.47 · debian trixie" are in REQUIRED_PR_CHECKS (src/release.ts).
- D, identity: test/git-identity.ts. Every test file's home starts with `user.useConfigOnly = true` and no identity
  (test/setup-state.ts), so a test that commits without setting one fails on the Mac as it would on Linux CI;
  `withGitIdentity()` gives a home the test identity.
- E: read-executor.test.ts holds one worker read open and proves 24 more lists are answered meanwhile (no event-loop
  delay cap); tick.watch.slow.test.ts stops the watch when t-live is built instead of after a 450 ms window. The
  60 s `--for` and the 90 s test timeout are the hang guards.

### Codex review round 1 fixes
1. CI history: release.ts prChecksVerdict classifies every failed attempt on the commit that no current job stands on
   before supersession (a renamed or dropped job never erases a failure); the Windows repeat job's name is fixed
   ("… · c2 repeat"), and src/ci-workflow.test.ts holds every job name to its workflow and matrix.
2. Obligations: check-report.ts fullObligationsOf decides a Full check's owed parts from verified trees — the candidate
   and the plane's own last release (release-card.ts releaseBaseline), never a tag — sealed in the inventory with the
   release decision (`release`, `ciSubstitute`); the handshake carries `owed` and the script runs at least those.
   fullCheckProblem requires an outcome for every sealed obligation, refuses CI stand-ins and a check not sealed as a
   release's, and requires journey/upgrade inventories (`inventoried`; explicitly empty is an outcome, missing is not).
   Security scan: what the last release's tree could run stays owed when a candidate deletes or symlinks it.
3. Retries: retriedInside(null) is null (unknown); the receipt seals `check.retried`; check-failure.ts retriedOfRun reads
   it; sealAutoGreen refuses unknown retries, needs the run's readable Full report and inventory with no
   fullCheckProblem, and verificationEvidence verifies the report and inventory bytes a v3 receipt names.
4. Main: release.ts containsMain reads main's head and the comparison from GitHub's API (release-adapters.ts
   readMainHead/readContains), reads main again right before the merge, and reads (never sets) GitHub's "require
   branches to be up to date" (readUpToDateRequired: classic `strict` or a ruleset's strict policy). sealAutoGreen
   refuses without it; an automatic release stops at the merge without it (`base-unprotected`); a person's release
   warns once at the gate. The post-merge tree comparison stays.
5. Old git: commit-extract.ts verifiedReader/extractCommit run through the frozen view (viewedGitSync, now with stdin
   and a git path) and `protocol.allow=never`; nothing leans on GIT_NO_LAZY_FETCH (2.41.0 ignores it; 2.41.1, 2.42.2,
   2.43.4 and 2.44.1 backported it). Decision: keep the floor at 2.41 and test its oldest release — the CI floor lane
   builds 2.41.0 exactly (hash cross-checked with kernel.org's sha256sums.asc) — rather than raise it to a patch level,
   because distributions ship patched builds under the unpatched number (Ubuntu 24.04's "2.43.0"). The deployment
   script (scripts/deploy-git.mjs) pins every transport off by name, takes --no-lazy-fetch on 2.45+, refuses lazy-fetch
   config on older git, and reads commits with ls-tree/cat-file and hashes them (no archive, show or status).
6. Setup recovery: builder.ts launchFailedBeforeCheck — a missing executable and no report carrying the run's nonce; a
   rerun after setup is a retry (SETUP_REPLAY_RETRY), and sealAutoGreen refuses `setupReplayed`.
7. Direct reads: project knowledge and learning, task base, release coverage, prepared evidence, grant check-ignore and
   the revision-base merge-base use frozen views on every git version (lazyFetchSafeGit always views), bounded; config
   files open with O_NOFOLLOW|O_NONBLOCK. Attack: test/attacks/checkout-git-direct-reads.test.ts (an include naming a
   FIFO).

### Codex review round 2 fixes
1. Main's protection: release-adapters.ts readMainProtection replaces the `strict`-only read. A layer holds only when it
   requires up-to-date branches, names a non-empty set of required checks covering PROTECTION_MINIMUM_CHECKS, and the
   merging account (the plane's gh) can't bypass it: classic `enforce_admins.enabled`; a ruleset `active`, targeting
   branches, `current_user_can_bypass: "never"` and a readable bypass list naming only deploy keys. Unreadable layers
   never hold. release.ts PROTECTION_REPORT_ONLY_CHECKS (the two git lanes, not yet in main's protection) are printed,
   not refused, until a later release empties it. A person's release prints each missing property. Live settings of
   ap9000/toolroll (read 2026-10-28): classic, strict, the five existing checks, enforce_admins on, no rulesets — holds.
2. Deployment script object reads: scripts/deploy-git.mjs hashes the commit and every tree (a port of
   commit-extract.ts's walk; held equal by test/attacks/checkout-git-deploy-reads.test.ts). Scripts can't load dist:
   none in the release's extraction, and the trusted installed runtime predates this change. Attack: a subtree
   rewritten to name another stored blob, which `git ls-tree -r` believes.
3. Deployment script config: git never reads the repository's config. Each read runs on a Git directory of the
   script's own (config it writes: object format and ref storage only; HEAD copied; objects and refs linked) with
   `protocol.allow=never` and no system/global config — chosen over the frozen view because the scripts can't import it
   (above), and with no repository config at all there is no check to race. Attack: an emulated 2.41.0 whose config
   gains a promisor remote on a custom helper with `protocol.custom.allow=always` just before `cat-file`.
4. Baselines: release-card.ts releaseBaselineRecord tells "none recorded" from "recorded, merge commit unreadable";
   prepareCheckAttempt throws CheckBaselineUnverifiable (nothing sealed) and the builder runs nothing
   (`baseline-unverifiable`); the release card's change list reads "couldn't be read" (`baselineUnreadable`), never the
   pull request's commits. The lossy releaseBaseline wrapper is gone.
5. Setup recovery: builder.ts approvedProgramMissing (the plane's own lookup of the approved command's first word
   before the check starts; undecidable words, builtins and Windows never qualify) and launchFailedBeforeCheck (that
   lookup, exit 127, empty stdout, stderr exactly the shell's "not found" line for that program). The receipt keeps the
   first attempt (`firstAttempt: launch, program, exit`); check-failure.ts setupReplayWords says it in a release.
   Consequence: `npm test` with a missing tool deeper down is no longer replayed; a person decides.
6. Direct reads: agent-fence.ts trustedWorktreeBinding reads the worktree registry and the candidate's pointer as
   regular files (no git; the frozen view refuses links planted in the shared registry, which would let one build deny
   every later dispatch); coding-handoff.ts branchHead goes through viewedGitSync (30 s) and runs before, never inside,
   its transactions; demo.ts fixture git is bounded. Remaining direct sync git, by design: teardown-git/git-floor
   probes (bounded, `config --file` or version only), desktop-access.ts's permission probe (4 s, in a bounded child),
   and scripts that are the candidate's own check code or make their own fixtures (release-check, quick-check,
   upgrade-path, e2e, canaries, postbuild, nul-scan, workspace-proof).
7. teardown-git.ts lazyFetchSupported(gitFile) probes and caches per real executable path.

## Phase 2 (after phase 1 ships)## Phase 2 (after phase 1 ships)
Results ledger across commits; a 20–30 case versioned eval set from real failures and representative successes, run
3× with fixed / regressed / newly flaky / still failing vs a pinned baseline; tool trajectories, tokens, cost per
successful task, latency; reviewer evals (recall and clean-diff specificity per reviewer, pinned model); delta-review
coverage enforced in sealAutoGreen.
