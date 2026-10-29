# Pipeline speed: faster fix rounds without proving less

Status: built on branch `pipeline-speed` (off `release-0.9.77`, 4a0f21a4), 2026-10-29. Not pushed or released.

The problem: every fix round paid about 25 minutes of GitHub CI and a 15–60 minute release check, one after the
other, and a one-line fix paid all of it again. The goal is less wall-clock time with the same proof: the exact commit
fully covered, and nothing the candidate controls able to shrink what it owes.

## Measurements

### GitHub CI (ci.yml), from the runs API

Runs for PRs #249 (release 0.9.76), main pushes and feature branches, 2026-10-27 to 2026-10-29:

| Job | Wall time | What takes the time |
|---|---|---|
| node 22 · ubuntu-latest | 14.9–21.4 min | `npm run test:all` 856–1234 s; everything before it is about 50 s (checkout 6 s, apt 8–15 s, `npm ci` 7 s, typecheck 10 s, build 7 s) |
| node 24 · ubuntu-latest | 13.9–21.2 min | `npm run test:all` 801–1225 s |
| linux fence · sandbox-runtime | 2.7–4.0 min | `test:attacks` 132–216 s |
| git 2.41 / 2.47 · debian trixie | about 1–2 min | |
| Windows Job Object containment | 1.0–1.4 min | |
| linux native containment | 0.3–0.5 min | |

- The whole run takes as long as its slowest job: 16.5–21.7 minutes. The two Node jobs are the only ones that matter.
- **Reruns double it.** 4 of the last 20 CI runs needed a second attempt (40789214944, 40781736315, 40648159941,
  40589753509). Each time one test failed in one Node job: auto-approve-green.test.ts, read-executor.test.ts, and
  up.slow.test.ts twice. Rerunning that job took another 19–21 minutes, so the run took 39–42 minutes.
- Inside test:all (node 22, run 40817101506): 561 files, 8069 tests. Wall time was 1232 s with 3 workers on the
  runner's 4 vCPUs. Adding up every file's own test time gives 48.8 minutes, and imports add another 634 s. The
  slowest single file is 132 s (test/attacks/release-recheck.test.ts), so splitting the suite isn't limited by one big
  file.

### The release check (scripts/release-check.mjs), from the plane's records and logs

Release-check runs on this machine (24 cores), from `run` and `release_check_attempt` in orders.db:

| Runs | Whole check |
|---|---|
| 3252, 3253, 3256, 3257, 3258, 3262 (passed) | 10.8–14.6 min |
| 3250, 3251 (failed units or a journey) | 21.8–22.6 min |
| 3248, 3249 (ran until the plane's limit) | 60.1 min |

Part times come from logs that still have a `took:` line (3236–3245; logs after that keep only their start and end):
typecheck 3–9 s and build 3–10 s; units 7.2–11.6 min, and 40–52 min on a loaded machine (3238, 3245); flows 1.7–2.5
min; app 2.7–5 min; flows-real 3.5–6.1 min; app-real 2.3–5.4 min; upgrade 2.4–3.3 min.

- **The check's slowest stretch was the units followed by the real-model journeys.** The real-model wave waited for
  both the scripted journeys and the unit suite, so the check took about units plus real-model time (3244: 8.6 + 3.8,
  for 12.4 min in all).
- **CI and the check run one after the other.** `toolroll release` waits for every pull request check to pass before
  it files the release task (release.ts `earlyChecks`). So a round costs CI time plus approval time plus check time.
- **Nothing is carried or targeted today.** In orders.db, `release_authority` and `release_carry` are empty, every
  `release_check_attempt` has `authority` NULL and `mode` full, and every release task's `release_terms_json` is NULL.
  The release projects' checks run unsandboxed (`project_check_access`: unsandboxed for all three), and "Carry release
  approvals when checks aren't sandboxed" was never turned on. So `task scope --release` files without terms. Without
  terms there is no release authority, so no test-only carry, no targeted recheck (release-recheck.ts) and no
  automatic approval: each needs terms.

## What was built

### A. CI unit suite in shards (biggest win, about 12–14 min per round)

- `test-shard` runs `npm run test:all -- --shard=i/4` as four jobs per Node version ("node N · shard i/4"). It uses
  the same runner, setup and environment as the old job, keeps `fetch-depth: 0` for the migration tests, and has
  `fail-fast: false`. Each shard uploads Vitest's own JSON report, written by its step outside the checkout (no
  candidate script summarizes it; Codex review round 1, finding 1).
- The required checks keep their exact names. "node 22 · ubuntu-latest" and "node 24 · ubuntu-latest" are now the
  join job `test`. It `needs: test-shard` and runs `if: always()`, because a job skipped after a shard failure would
  read as a pass to a required check. It fails unless:
  - `needs.test-shard.result` is `success`;
  - for its Node version there are exactly the shards 1..4, each one report that passed, whose counts agree with its
    own results, that executed tests, and that skipped only in files whose base copy can skip (or that are new);
  - together the shards ran exactly the files the include policy finds in the tested commit, each once.
  The join runs none of the candidate's code: it checks out the trusted base revision apart (the pull request's base,
  or main on a push) and runs that copy of `scripts/ci-shards.mjs verify`, whose include policy is held equal to
  vitest.config.ts. Until main has a verifier the change's own is used, and said. The candidate's test code still
  writes the reports it is judged by (report provenance is not authenticated; AGENTS.md trusts test code).
- A required check counts only from `.github/workflows/ci.yml` (GitHub's workflow-run path): a lookalike job of the
  same name in another workflow never stands for one (Codex review round 1).
- `REQUIRED_PR_CHECKS`, `PROTECTION_MINIMUM_CHECKS` and main's branch protection are unchanged. `prChecksVerdict`
  already judges every job group on the commit, so a failed or rerun shard fails a verdict or counts as history,
  exactly as a failed Node job did. `scripts/release-check-ci.mjs` reads the new job names from the workflow.
- **Expected time:** about 61 worker-minutes of tests and imports per Node version, split 4 ways over 3 workers, is
  about 5 minutes per shard. With about 1 minute of setup and about 1 minute for the join, CI should take **7–9
  minutes instead of 17–21**. A flaky shard reruns in about 6 minutes instead of 20. Cost: about 1 extra minute of
  setup per shard. Runner-minutes go up a little; wall-clock time goes down by more than half. This is an estimate
  until the first sharded run on GitHub; confirm it there.
- Not done: building once and sharing `dist` between jobs. The build takes 7 s and `npm ci` 7 s, so an artifact
  round trip wouldn't save time. `test:attacks` isn't on the critical path (about 3.5 min).

### D1. The release check's real-model wave doesn't wait for the units (about 3–4 min per check)

The real-model journeys now start in the browser lanes as soon as the scripted journeys end, without also waiting for
the unit suite. They use the same lanes the scripted wave used, from the same budget (`checkBudget`), so the check's
load never goes past what its first wave already ran under. The sequential mode for a small or busy machine keeps its
old order. What runs and what must pass is unchanged. Expected: whole check ≈ max(units, scripted + real) instead of
units + real, so about **9 instead of 12–14 minutes** on the measured runs.

### D2. An automatic release checks beside CI (up to the whole CI time per automatic round)

With the project's "Approve automatically when checks pass" on (since 2026-10-29, on every release), the gate still stops at once on a pull request check that already failed. It no longer
*waits* for the checks to finish before filing the release task. The task is filed, the plane seals `auto-check`, and
the release check runs while CI runs. Nothing about what an approval proves changes:

- Before the plane's `auto-green` seal, the release waits until every required check passed on the exact candidate.
  `sealAutoGreen` then makes its own fresh CI observation and proof, unchanged.
- If CI fails there, the automatic road ends (`giveUp`: the task asks a person, as on any refusal) and the release
  stops with `ci-failed`.
- A person's road: see "Decision: a person's release asks during CI" below (it replaced "a person's road never gets
  ahead of CI", and with it the CI hold the gate placed and the `settingFor` hint that chose whether to file early).

**Today this does nothing in production.** Automatic approval needs release terms, and none can be made while the
release checks run unsandboxed (see Measurements).

## Decision: a person's release asks during CI

Alex, 2026-10-29: for a release a person approves, `toolroll release` files the release task and asks for approval
right away, while the pull request's checks still run. Built on branch `approve-during-ci` (off b4bf1c46).

- **The gate** stops only on a required check that already failed (as before). Checks still running or not started no
  longer hold it, on either road: the task is filed (`ciAhead` in the journal) and a person is asked at once.
- **What the person sees.** The CLI, the console's approval sheet and the chat release card say "GitHub's checks are
  still running; nothing deploys until they pass." The plane learns it from a ledger row the coordinator records before
  filing (`release asked while CI runs`, release-ci-hold.ts `noteCiRunning`); the row never holds approval and ends only when
  the plane itself reads exact-head CI passing (`liftCiHold`: fresh, whole, GitHub Actions, ci.yml, every required
  check). While asking, the coordinator looks at CI on each poll: a check that failed stops the release before anyone
  approves a red commit.
- **After the approval** the release check runs at once, beside CI.
- **Nothing irreversible before CI is green on the exact head.** Every person-approved release, including one that saw
  green CI at the gate or resumes an older journal without `ciBeforeDeploy`, reads the required checks again right before the deploy
  reservation, and waits for them within the ci step's limit: the person's verdict (`prChecksVerdict`: exact head,
  GitHub Actions only, required names from ci.yml, each job by its latest attempt in the newest run of its workflow).
  A check that failed, including a newer attempt of one that was green when the person approved, stops the release
  before the deploy: nothing deployed, merged, tagged or published. The approval stands for that commit only: a job
  rerun to green on GitHub lets the same command go on; a fix is a new commit that goes through approval again. The
  merge still re-reads CI at the moment of merging and the ci step still runs after the deploy, unchanged; a failure
  after the deploy still needs a person's fresh approval.
- **Direct deployment cannot bypass CI.** The runtime and deployment-script gates, and the store's reservation and
  issuance guards, refuse a release whose CI-running row remains. This includes releases without carry terms.
  The coordinator reconciles that row from a fresh plane observation even if a crash lost its journal flags.
- **The automatic road is unchanged.** Its `auto-green` seal still waits for every check to pass (the check step waits,
  and `sealAutoGreen` reads CI itself), and `autoCiHolds` still reads CI before each irreversible step.
- **The CI hold.** It existed so the automatic road's fallback would not ask a person before CI passed; under this
  decision a person may be asked during CI, so the fallback asks at once too, and the coordinator no longer places the
  hold. It never guarded the automatic seal (the seal primitive exempts `auto-check`/`auto-green`; `sealAutoGreen`
  proves CI itself), so nothing the automatic road proves changes. A hold an older coordinator placed still holds every
  approval but the automatic road's until the plane reads CI passing, exactly as before.

## P0. A release check purpose, apart from carrying (branch `ship-velocity-build`)

Codex's velocity review (P0): 0.9.77's same-candidate recheck after confirmed infrastructure (check-failure.ts
`recheckReleaseTask`) and the strict report rules (check-report.ts `fullCheckProblem`) were keyed on release terms, and
terms are refused while the release projects' checks run unsandboxed. So neither applied to the owner's releases.

- **What a release check purpose is.** `task scope --release` files terms when it can (release-carry.ts
  `releaseTermsFor`); when it can't, it files a release check purpose (`releaseCheckPurposeFor`, contract
  `releaseCheckPurposeSchema`, column `task_scope.release_check_json`, schema v137): the project, version, pull
  request, branch, the approved commit and its verified tree, the live release check grant and the check access, all
  from the plane's own records. It is in the scope digest, so the person's yes covers it; it seals only on a person's
  yes (the ceremony or the release card in chat), never a mode, grant or automatic seal. A scope carries terms or a
  purpose, never both.
- **What it changes.** `releaseCheckScope` (scope.ts) is the one predicate: the builder seals the check's attempt as a
  release's (`release: true`, so CI never stands in for its units), `settleCoverage` holds a Full check to
  `fullCheckProblem`, and `recheckReleaseTask` / `regateTask` (kind `release`) may rerun the check after a failure the
  plane confirmed as infrastructure.
- **What it never authorizes.** The rerun is of the identical approved candidate: inside the rerun's transaction the
  purpose's commit must equal the scope's candidate, its project the task's, the project's live grant the sealed grant
  and the check access the sealed access; `regateTask` still requires the approved digest to equal the scope's and the
  last attempt's, and the approval to stand. The limits are the same (one rerun per incident, two per candidate), and
  any other class stops. It opens no release authority, so nothing carries, and `release-auto.ts` still requires terms.
  test/attacks/release-failure-class.test.ts tries each: another commit, a changed scope, a replaced grant, changed
  check access, a seal that no longer stands, a deterministic failure, a purpose approved for another commit, a mode seal.

## P1. Homebrew after publication (branch `ship-velocity-build`)

- **Published means npm and the GitHub release.** The publish step is unchanged; the homebrew step then makes one
  pass (release.ts `homebrewPass`): propose the formula change when missing (checksum from npm's tarball, unchanged),
  read its checks once, and merge exactly the proposed head when every check passed. Pending or failed, the journal
  keeps `homebrew.state` and the run ends `ok` with "Published …; Homebrew pending/failed … Finish it with
  `toolroll release <branch> --repo <checkout>`". That command resumes at the homebrew step and waits within the
  Homebrew limit (a timeout leaves it pending, never a stop of a published release).
- **Ordering.** The adapter's `state` reports `newer` when the tap's default branch names a later version; the pass
  never proposes or merges over it (`superseded`), and reads the state again right before merging.
- **Saved:** the whole Homebrew wait (up to 45 minutes) from the release's end; npm availability was never behind it.
- **Not built:** the background worker doesn't finish Homebrew by itself; a person (or the lead) reruns the command.
  The worker has none of the release coordinator's adapters (gh, the tap, the journal), and running them unattended
  is a separate decision.

## Item 3. The macOS suite before the merge; publication waits for the publish job only

### Built (a)

- **ci.yml runs the hosted macOS Node 22/24 suite on every pull request and main push**, in four shards per Node
  version (`node N · macos shard i/4`, macos-latest), joined like the Linux shards by `node N · macos-latest` (an
  always-running Linux job: every shard succeeded, and the trusted base revision's `scripts/ci-shards.mjs verify`
  finds every test file of the tested commit run exactly once, counts consistent, skips only where the base can skip).
  The artifacts are named `macos-shard-N-i` and renamed to the verifier's `shard-N-i` folders before it runs.
- `REQUIRED_PR_CHECKS` names both macOS joins, so `toolroll release` waits for them on the exact head (gate, before
  the deploy, at the merge). `PROTECTION_REPORT_ONLY_CHECKS` names them too: main's protection not requiring them yet
  is reported, never refused. **Owner decision:** add `node 22 · macos-latest` and `node 24 · macos-latest` to main's
  required checks once they have run there; then a later release empties them from the report-only list.
- The nightly macos.yml jobs are renamed `nightly macOS · node N` and publish.yml's `tag macOS · node N`: a required
  name from another workflow on a candidate fails the CI verdict (prChecksVerdict), so no other workflow may share it.
- **Publication's verdict** (release.ts `tagChecksVerdict`): only publish.yml's `publish` job (RELEASE_TAG_CHECKS), by
  its newest attempt; it `needs` the macOS legs, so their failure leaves it failed or skipped. Main's own CI push run
  on the merge commit no longer holds publication (it used to wait for every reported check, ~8–20 minutes).
- **Saved now:** main's CI push run on the post-merge tail (the merged tree was proved equal to the tested head).
  macOS failures surface before the deploy and merge instead of after. **Not yet saved:** the tag's own macOS rerun
  (about one macOS suite) — publish.yml still runs it; removing it needs (b).

### Not built: (b) a plane-issued release certificate instead of the tag's macOS rerun

Not built in this round, because it can't be made sound yet: the release projects' checks run unsandboxed as the
owner's user, so no key in the owner's home (state folder or login keychain) is "held only by the plane" — a candidate's
check could read it and sign its own certificate. The design, for when the key's custody is solved (a sandboxed
release check, or a key in a store the check can't reach):

- **Key.** An Ed25519 key the plane generates (`toolroll release --signing-key` prints the public key and the command
  `gh variable set TOOLROLL_RELEASE_PUBLIC_KEY --repo ap9000/toolroll`). The public key is pinned in a repository
  variable, outside every candidate file; a key rotation is a person's act.
- **Certificate** (canonical JSON, version 1): repository, tag, package name and version, pull request number and head,
  the prepared tree, the merge commit and its tree, the release task, its scope digest, approval (by, at, basis) and
  completion, the check run and its sealed receipt digest, the sealed inventory and context digests of that check
  (owed parts, execution context), and each required ci.yml check run (id, name, workflow run id and attempt,
  conclusion) on the head, including both macOS joins; the npm tarball digest once the release check packs the tarball
  it tests. Signed by the coordinator at the tag step and carried in the annotated tag's message.
- **Publish.yml** (job `release proof`, Ubuntu): reads the annotated tag, verifies the signature with
  `vars.TOOLROLL_RELEASE_PUBLIC_KEY`, requires the certificate's tag, merge commit (= `GITHUB_SHA`), tree (= the tag's
  tree), version (= package.json) and repository to match, and reads each named check run back from GitHub's API
  (head, name, ci.yml, success). Missing or mismatched proof fails, and `publish` needs it. With the variable unset
  (the transition: the coordinator that tags the first such release is the previous runtime), the macOS legs run as
  today; with it set, they don't run and a certificate is required. Keep the merged-tree comparison, npm OIDC with
  provenance and the package checks; publish the certified tarball digest when the check produces one.

## Not built, and why

### B. More CI reuse inside the release check

The release check runs on macOS. Its unit suite is the only full macOS run of the units before the deploy. CI runs
the units on Linux, and the nightly and tag macOS runs come after the deploy. The check never reuses CI for units,
and that is a recorded decision (eval-harness review 1, finding 2; release-once.md: "No reuse of GitHub CI results
inside a composed check"). Reusing CI's units would drop the pre-deploy macOS coverage of the very runtime being
deployed. Of the rest, typecheck and build take 3–10 s each. Journeys, real-model journeys and the upgrade path don't
run in CI at all. So nothing CI already proves on the exact SHA is worth reusing.

### C. A targeted recheck after a *source* fix

A test-only fix already has its targeted recheck: release-recheck.ts `planTargetedRecheck`, within a release
authority (inert today, see Measurements). Extending it to fixes that change `src/` would need the plane to prove
which tests a source change can affect. The plane can't prove that from verified trees:

- Many unit tests run the built CLI (`dist/bin.js`) as a child process, so they reach every module without importing
  it.
- Tests read files, spawn git, and use computed `import()`, so a static import graph is a guess. A guess that misses a
  dependency passes a commit that wasn't tested (fail open).
- The journeys and the upgrade path run the whole build. Any production change owes them again, so the check's slowest
  stretch, the unit part, stays owed whatever happens.

The only part-level carry that would be sound, skipping real-model journeys or the upgrade path when the fix doesn't
touch model-facing or upgrade-relevant paths since X, saves almost no wall time after D1. It would also need a new
cross-generation composition proof for receipts and auto-approve. Per the rule "if the composition can't be proven
sound, require Full", source fixes keep a Full check.

## Owner decisions

1. **Release-once and automatic approval are inert while release checks run unsandboxed.** Either sandbox the release
   projects' checks (0.9.71 brought sandboxed checks back), or turn on "Carry release approvals when checks aren't
   sandboxed" (person-proven). Until one is done, test-only carries, targeted rechecks and automatic approval
   (including D2) never apply.
2. **A person's release could also overlap CI.** Decided 2026-10-29: yes, and built (see "Decision: a person's
   release asks during CI").
3. **No branch-protection change is needed** for the shards: the required names are unchanged.
