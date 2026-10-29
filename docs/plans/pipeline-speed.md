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
  `fail-fast: false`. Each shard writes a summary of the files it ran and its counts on the tested commit
  (`scripts/ci-shards.mjs summarize`, which refuses a report that didn't pass) and uploads it.
- The required checks keep their exact names. "node 22 · ubuntu-latest" and "node 24 · ubuntu-latest" are now the
  join job `test`. It `needs: test-shard` and runs `if: always()`, because a job skipped after a shard failure would
  read as a pass to a required check. It fails unless:
  - `needs.test-shard.result` is `success`;
  - for its Node version there are exactly the shards 1..4, each once, each with `of = 4`, the tested SHA and no
    failed test;
  - together the shards ran exactly the files `vitest list --filesOnly` lists in the join's own checkout of that
    commit, each once (`scripts/ci-shards.mjs verify`).
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

With the project's "Approve automatically when checks pass" on (read from the plane's own records for the gate
checkout, `settingFor`), the gate still stops at once on a pull request check that already failed. It no longer
*waits* for the checks to finish before filing the release task. The task is filed, the plane seals `auto-check`, and
the release check runs while CI runs. Nothing about what an approval proves changes:

- Before the plane's `auto-green` seal, the release waits until every required check passed on the exact candidate.
  `sealAutoGreen` then makes its own fresh CI observation and proof, unchanged.
- If CI fails there, the automatic road ends (`giveUp`: the task asks a person, as on any refusal) and the release
  stops with `ci-failed`.
- A person's road never gets ahead of CI. If the gate filed while CI ran (`ciAhead` in the journal), the approval step
  waits for every check to pass before asking anyone, and stops if one failed. With the setting off, or on an older
  plane without `settingFor`, the gate waits exactly as before.

The setting is the plane's own record, keyed by project. Nothing the candidate writes reaches it, and it only decides
when to wait, never what has to pass.

**Today this does nothing in production.** Automatic approval needs release terms, and none can be made while the
release checks run unsandboxed (see Measurements).

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
2. **A person's release could also overlap CI.** Today the person is asked only once CI passed (feedback: ask for an
   approval only when fully ready), so CI and the check run in series. Asking while CI runs, with deploy still waiting
   for CI, would save about the CI time per person-approved round. Not built: it changes when the owner is asked.
3. **No branch-protection change is needed** for the shards: the required names are unchanged.
