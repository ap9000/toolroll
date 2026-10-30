# Evals and nightly: GitHub's nightly as release debt, and eval harness phase 2

Status: plan, for the owner's decisions (marked **Decision**) and a Codex round. Branch `evals-phase2`, off main
360762cb (0.9.81). Owner's ask: "We need to do these Evals and nightly stuff." Sources: docs/plans/test-matrix.md
("Nightly", "Not built yet"), docs/plans/eval-harness.md (phase 1 shipped 0.9.77–0.9.81; "Phase 2"), and the code cited
below. Nothing here touches Tart or VM isolation.

## In one screen

| Part | What it adds | Release wall clock | API spend |
|---|---|---|---|
| A. GitHub nightly → release debt | The plane reads GitHub's Nightly runs itself. A failed lane on main becomes debt. Deploy, merge and publish wait until that lane passes again, on a later nightly or freshly on the candidate. Shown in Needs you and on the release card | 0 when the last read is under 2 h old; otherwise one GitHub read (about 5 s) at each of deploy, merge and publish | $0 |
| B. Run ledger | Cost per finished task, tool-call counts, and "this took 3× the turns of similar work" flags, from the plane's own run records | 0 | $0 |
| C. Journey ledger | Each release check's real-model journeys: pass/fail, cost, turns, tokens, tool calls, wall time, kept per release | under 1 s per journey | $0 extra |
| D. Eval set | 25 versioned cases, run 3 times each by the installed plane after a release ships. Compared with the last good release: fixed / regressed / newly flaky / still failing. Only "always passed, now always fails" holds anything: the next automatic approval | 0 (runs after deploy, in the background) | about $30 a run |
| E. Reviewer evals | Labelled past diffs, real bugs and clean ones. Recall and false-alarm rate per pinned reviewer model | 0 | about $30 a run |
| Later | Delta-review coverage in sealAutoGreen | — | — |

Estimated monthly API spend with the recommended schedule: **about $170** (range $130–$330). See "Budget".

## Facts the design stands on (with citations)

**The plane's own nightly (03:00).** src/nightly-check.ts:1-16. A scheduled flow files a check-only task at main's
head. That head is read by the plane from the recorded remote (`trustedMainOf`, :83), never from a shared ref. Failures
become `main_check_failure` rows (src/store.ts:1234-1245). They are opened in `settleReleaseChecks` (:247-266) and
cleared only by a full pass that covers the exact item (`coversItem`, :219; clearing loop :270-311). Debt is consulted
in three places:
- `mainDebtProblem` (src/scope.ts:1990-1999) blocks deploy and merge, but only when the newest check was **targeted**
  (`liveReleaseOf`, :1979-1982).
- `planTargetedRecheck` forces a full check (src/release-recheck.ts:237-253).
- The console card shows a count only (src/server/render-tasks.ts:3036; src/server/task-views.ts `releaseViewOf`).

There is no Needs-you item for it.

**GitHub's nightly.** .github/workflows/nightly.yml runs on cron `17 6 * * *` and calls ci.yml (jobs named
`nightly / <job>`) and release-candidate.yml (jobs `nightly floor / <job>`). The lanes are exactly `REQUIRED_PR_CHECKS`
(src/release.ts:46-62), and each lane's workflow is in `REQUIRED_PR_CHECKS_WORKFLOW` (:66-76). Nothing reads its runs
today. The header of nightly.yml says so.

**Readers to reuse.** In src/release-adapters.ts:
- `readCheckRuns` (:965-1024) binds runs to workflow path and event and refuses retargeted PRs.
- `readJobBeforeTests`/`failedBeforeTests` (:1036-1060) tell a runner failure from a test failure, using GitHub's own
  step records.
- `ciEnv()` (:955) sets gh's environment; `retryingExec` (src/release-net.ts:173) retries reads only.

scripts/release-proof.mjs:186-223 has the pattern for reading the newest run's exact attempt's jobs, then re-reading the
run so a change mid-read refuses.

**Periodic hook.** The watch loop's `followUpChecks` runs every 5 s (src/operate.ts:6777). It calls
`refreshTrustedMains` and then `settleReleaseChecks` (:6789-6792). Each does its own throttling.

**Release steps.** Coordinator steps are at src/release.ts:100: deploy :1079, merge :1168, tag :1222, publish :1232.
`deploymentGate` is at src/deploy-gate.ts:17-41. `sealAutoGreen` is at src/release-auto.ts:338-434.

**Run evidence.** The `run` table (src/store.ts:3666-3741) holds:
- `provider`, `model` (alias, e.g. `opus`), `started_at`, `finished_at`
- `tokens_in`, `tokens_out`, `cost_usd`, `usage_json`
- `agent_turns` (v129, :1113)

It is written by `recordUsage` (:15806), from Claude's stream-json `result` event (src/provider.ts:480-540;
src/invoke.ts:856-863). There is no tool-call column. `run_efficiency` (:1303-1311, src/run-efficiency.ts:24-110) holds
step counts by kind. It is derived on first view from step records that are kept only 24 hours. Its payload is display
only.

**Real-model journeys.** These are defined with `journey(group, REAL_MODEL, …)` in scripts/flows-e2e.mjs and
scripts/app-e2e.mjs. There are 12 today: 6 in flows (build, lead, steps/OpenRouter, triggers) and 6 in app (builds, lead,
maya, rosa). They use `claude --model sonnet` (scripts/e2e-kit.mjs:373) and the lead on `claude-subscription`/sonnet.
- The release check runs them when a path in `MODEL` changes (scripts/release-check.mjs:73-78, `planFor` :115-120;
  the plane's copy is `MODEL_PATHS`, src/check-report.ts:112-117) or on a full check.
- Their sealed report holds `{name, state}` per journey (src/contracts/release-check.ts:77-92).
- report.json has `seconds` and `modelCalls` (turn counts from the shim journal, scripts/fixtures/scripted-provider.mjs:191),
  but no cost or tokens.
- A failed real group is classified `agent-behaviour` (src/check-failure.ts:83-86).

**Reviewer.** The automatic build review is in src/build-review.ts:
- queued at :66
- run by `buildReviewPass` (:220)
- model from the task's route review leg or the project's review agent (:252-259)

Findings go to `build_review.findings_json` (src/review-switch.ts:20-33). The reviewer's run row records provider and
model alias (`admitReview`, src/store.ts:11559-11567). No model is pinned. The exact model id Claude reports in its
`system/init` event (src/provider.ts:595) is not stored.

**Schema.** `SCHEMA_VERSION = 138` (src/store.ts:861). Migrations are inline in `initializeStore` (last steps
:5393-5404) and listed in `UPDATE_SAFE_MIGRATIONS` (:999). Tests are named `src/migration-v1NN-*.test.ts`. This plan
needs **v139–v142**, one per slice that adds tables. If another branch lands first, take the next free numbers.

**Placement rule.** src/password-freshness.test.ts pins function ordinals in src/operate.ts (12,838 lines),
src/store.ts and src/server/tasks.ts. New functions go at the end of each file. In tasks.ts that means after the last
inner function of `createTasksHandlers`. New logic otherwise goes in new modules.

**Real costs (owner's plane, runs since 2026-09-15, read-only query):**

| Run | Count | Average cost |
|---|---|---|
| Opus builder | 315 | $7.10 |
| Opus planner | 119 | $0.90 (8.6 turns) |
| Opus reviewer | 131 | $0.32 |
| Sonnet builder | 10 | $0.27 |

---

## Part A. GitHub's nightly as release debt

### What is read, and how it is trusted

The plane reads GitHub with its own gh (`ciEnv`, system-folder gh). It never reads a file, artifact, log or summary the
tests wrote. Only GitHub's run and job records count: status, conclusion, name, run id, attempt, head SHA, step
outcomes.

A run counts as **the nightly** only when all of these hold:
- its `path` is exactly `.github/workflows/nightly.yml` (no `@ref` suffix)
- its repository and head repository are the project's own (no fork)
- `head_branch` is `main`
- its event is `schedule`, or `workflow_dispatch` on main
- its `head_sha` is on main's first-parent history as the plane read it (`trustedMainOf` +
  `verifiedFirstParentWalk`, as nightly-check.ts does)

A run started by hand on a branch shows `nightly / …` names too. It never counts.

The jobs come from the newest completed run's **exact latest attempt**. The run is re-read after paging its jobs; if
the run or its attempt changed, the read is refused (as in release-proof.mjs:214-219).

Each lane is matched by exact name: `nightly / X` where X is a `REQUIRED_PR_CHECKS` name mapped to ci.yml, or
`nightly floor / X` mapped to release-candidate.yml. Shard jobs are kept as detail. Their aggregate lane fails with them
("Every shard passed").

What the candidate could forge, and why it doesn't matter here:
- Test code on main decides its own pass. That is true of all CI, and nightly only ever adds holds. A forged pass can't
  remove a hold this plan adds, except by being a real later pass on the same lane.
- A workflow edit (renaming or dropping a lane, changing the cron) is a CI change. `autoPathProblem` already sends those
  to a person (src/release-auto.ts:195-215).
- A lane missing from a completed nightly is shown as "didn't run" (below). It is never read as passing.

### Lane outcomes

| GitHub says | Plane records | Holds releases? |
|---|---|---|
| `success` | passed | no; may clear debt |
| `failure`, `timed_out`, and not "failed before tests" | **failed → debt** | yes |
| failed before any of the workflow's own steps ran (`failedBeforeTests`) | runner failure | no; shown as a warning |
| `cancelled`, `skipped`, missing from the run, or still running at the next read | didn't run | no; shown as a warning |

A runner failure or a cancellation is not a test result. Making it debt would hold releases on GitHub's outages.
Showing it keeps it visible. This is phase 1's rule: unknown is never a pass, and only an observed failure opens debt.

### Clearing

A failed lane (repo, lane, failed run, failed SHA) clears only when a **later nightly run** shows the **same lane**
concluded `success`, and all of these hold:
- the run was created after the failed run completed
- its head contains the failed SHA
- it was read by the same rules

Nothing else clears it. A person can't wave it away. A passing run of a different lane never counts.

**The candidate's exemption.** A release passes the hold for one specific failed lane when the release's own pull-request
run of that same required check (already read by `readCheckRuns` / `prChecksVerdict`) passes all of these:
- it concluded `success` on the candidate head
- it came from that lane's own workflow
- the job started after the failed nightly job completed
- the candidate head contains the failed SHA (containsMain already requires main's head)

This exempts that candidate only. The row stays open until a nightly on main passes. A branch that fixes the lane but
never merges must not clear main's debt.

So when a nightly fails, a release can still go out the same day by re-running its CI. "Started after the failure" is
what stops an older green run from answering a newer red one (for example, a runner image change overnight). A full
workflow re-run is needed, because publish's release proof refuses partial re-runs (test-matrix.md).

### Freshness

**Throttle.** The read runs in `followUpChecks` (src/operate.ts:6789), next to `refreshTrustedMains`. At most one read
every 30 minutes per project. A project is read only once it has opted in (below). Each read writes a ledger row (ok or
why not), as trusted-main reads do.

**Before deploy, merge and publish**, the coordinator calls `nightlyLaneHold(...)` with a fresh-enough read:
- If the last good read is over **2 hours** old, it reads now (about 5 s, 3–6 API calls).
- If it can't read now, it uses the stale state (below).

**Stale or unreadable.** **Decision 1** (recommended: a **warning, not a block**):
- **Never read / unreadable**: gh missing or signed out, or GitHub not answering. Shown as "GitHub's nightly couldn't be
  read: <why>".
- **Stale**: the newest counted nightly was created more than **36 hours** ago. This covers a disabled schedule (GitHub
  turns schedules off after 60 days with no repository activity) and a deleted workflow. Shown as "GitHub's nightly
  hasn't run since <date>".
- Both are visible states on the release card and in Needs you. Neither holds a release, whether a person's or an
  automatic one.
- Why not block: the release candidate's own pull request runs every lane on the exact head (test-matrix.md). The nightly
  is a supplement that "can't stop a regression shipping the same day" (test-matrix.md, Nightly). Blocking on
  GitHub's availability would add owner blockers ("minimal blockers by me") for no added coverage.
- Alternative: block only automatic approvals when stale. That is one line in sealAutoGreen, if the owner wants it.

### What it holds

**Decision 2** (recommended): an open lane failure without the candidate's exemption holds **deploy, merge and
publish** of every release, person-approved or automatic. Reason `nightly-debt`. Words:

> GitHub's nightly failed "node 24 · macos-latest" on main at abc1234 (Oct 30, 06:17). This release can't deploy until
> that lane passes again: re-run this release's CI, or wait for tonight's nightly.

This differs on purpose from `mainDebtProblem`, which holds only targeted releases. That debt is cleared by the release's
own full check. This one is cleared by the release's own fresh lane run. Every candidate can produce that, so it's
cheap to satisfy and never a dead end.

**Where it is enforced:**

| Step | Where |
|---|---|
| deploy | `liveReleaseOf` for `deploy`/`merge` (src/scope.ts:1979), which reaches `deploymentGate`, `reserveRelease`, `runReleaseOperation` and the coordinator's `identity()` |
| publish | the coordinator's tag/publish step (src/release.ts:1222/1232), next to `publishHold` |
| auto-approval | `sealAutoGreen` refuses while the hold stands (src/release-auto.ts:418, beside `ciVerdict`) |

`liveReleaseOf` is synchronous and store-only. It reads the stored lane rows and the stored exemption. The coordinator
does the network read just before it, so the store is fresh. The installed `scripts/deploy-candidate.mjs:35` path picks
it up through `liveReleaseOf` with no change.

### Console words

**Needs you** (board lane, src/server/render-pages.ts:609): one project-level item per open lane failure.

> GitHub's nightly failed: node 24 · macos-latest on main at abc1234. Releases wait until it passes again. — [Open the
> run on GitHub]

**Release card** (src/server/render-tasks.ts:3024 and chat card src/release-card.ts:266): one line per lane state that
matters:

> GitHub nightly: failed node 24 · macos-latest (Oct 30) — this release re-ran it and passed.

> GitHub nightly: failed node 22 · ubuntu-latest (Oct 30) — re-run this release's CI.

> GitHub nightly: couldn't be read (gh isn't signed in). Not holding the release.

> GitHub nightly: hasn't run since Oct 27. Not holding the release.

**Notification**: kind `github-nightly-failed`, push class `attention`, deduplicated per run.

### Opting in

`toolroll release nightly --github` sets this up for a project. The person must prove themselves, as
`createNightlyCheckFlow` does (src/nightly-check.ts:122). It records the repository on GitHub, read from the recorded
remote (`trustedRemoteIdentity`), and the workflow path (fixed). Without it nothing is read and nothing holds.
ap9000/toolroll is set up once by the owner.

---

## Part B. Run ledger: cost per finished task and bloat flags (no API spend)

The plane already records cost, tokens, turns and wall time for every run, from the provider's own `result` event (not
from anything the agent writes). This part adds what is missing and two views.

1. **Tool calls.** At disposition, write `run.tool_calls`: the total of `stepsOf(...)` counts (src/run-efficiency.ts:75)
   from the run's own step records, read once while they still exist (they expire after 24 h). Null when steps were
   truncated or absent. Never guessed. v140 column.
2. **Exact model.** `run.model_reported`: the `model` field of Claude's `system/init` event (src/provider.ts:595), next
   to the alias in `run.model`. v140 column. Part E needs this, and every run gains it.
3. **Cost per finished task** (per project, per week and per release):
   - total spend of every run of tasks that reached done, divided by the number of those tasks
   - plus "spent on tasks that didn't finish", shown separately

   Shown on the usage page. Read-only SQL over `run` + `run_spend` (src/spend.ts:111).
4. **Bloat flags.** A finished run is compared with the last 20 finished runs that share project, role, provider + model
   alias, and task size class (src/task-sizing.ts `heuristicSizing`). It is flagged only if **both** hold:
   - it is over **2.5× their median** in turns, cost or tool calls
   - it is over an **absolute floor**: 30 turns, $3, or 80 tool calls

   With fewer than 8 similar runs, there is no flag. Words on the task page's "How it ran": "This build took 3.1× the
   turns of similar builds (41 vs a typical 13)." Display only. It holds nothing.

---

## Part C. Journey ledger (per release, from the release check)

This keeps, for each real-model journey in each release check, these fields:
- pass/fail
- wall time
- turns
- cost
- tokens in/out
- tool calls

Source and trust: pass/fail comes from the **sealed** report the plane already uses (`sealCheckOutcome`,
src/check-report.ts:281). The numbers are new optional fields on the journey result line:
`usage: {costUsd, turns, tokensIn, tokensOut, toolCalls, seconds}`. e2e-kit.mjs fills them at journey end by summing the
throwaway world's own `run` rows over the journey's time window.

That world is started by the candidate's scripts. So these numbers are **reported by the checked code**, and the ledger
stores them with `trust = 'reported'`. They are used only for trends on the release card ("real-model journeys: 12
passed · $3.10 · 214 turns (last release $2.40 · 180)") and for flags. They never pass, clear or hold anything. A
candidate could under-report its cost. The plane-measured eval set (Part D) is the trusted number.

The journey's pass^k stays as phase 1 set it: a pass only on retry is not a pass for auto-approval
(`releaseCheckStanding`). The ledger records each attempt, so a journey that "passed on the second try" is counted flaky.
scripts/flows/real-model-journeys.mjs:98-146 retries a failed suite once. Its ledger rows keep both attempts. It is not
changed to stop retrying, because its retry is for diagnosis, and the ledger and gate never count a retry as a pass.

---

## Part D. The eval set

### Where it runs, and why there

Each case runs in a **throwaway Toolroll world started by the installed plane, from its own installed runtime**. That
runtime is the release that was gated, deployed and is now running. It does not run from a candidate's checkout. The
runner is `toolroll evals run`. It reuses e2e-kit's world-making approach, ported into src/evals.ts so that it runs from
dist.

What it reads, and who wrote it:

| Number | Written by | Trusted because |
|---|---|---|
| pass/fail | the plane's own hidden check, run after the agent finishes | the check comes from the installed release's `evals/cases/<id>/check`, copied in after the build, so the agent can't edit it. It runs in the plane's fence with no network. Output is an exit code only |
| cost, tokens, turns | the world's `run` rows, written by installed code from the provider's `result` event | same code path as every real run |
| tool calls, wall time | the world's step records and run timestamps | same |
| model | `model_reported` from the init event | provider's own word |

What could be forged:
- **The agent** can write anything into its workspace: claims, test files, edited tests. None of it is read. The hidden
  check replaces any test file it names before running.
- **A release** can edit `evals/` itself. That would weaken its own cases. So:
  - `evals/` joins the paths that need a person (`autoPathProblem`, src/release-auto.ts:198).
  - Each case has a **version = sha256 of its folder**. A changed case starts a new history. It is never compared with
    its old baseline, and it never clears old debt.
- **A deployed release** writes its own eval rows. It is the plane by then, approved through the gate. Rows are
  append-only, and a later release can't rewrite earlier rows. Each row carries the Toolroll version that wrote it.
  Evals are a quality signal, not a security boundary. Phase 1's boundary (sealed checks, CI) is unchanged.

Why after the deploy and not on the candidate: running candidate code pre-release would make its numbers
candidate-written (Part C's problem). The cost is that a regression is seen one release late. Hence the gate below holds
the **next** automatic approval, not the release that caused it.

### The cases (25, versioned, `evals/cases/<id>/`)

Each case folder holds:
- `case.json`: id, kind, goal, out-of-scope, acceptance, model, per-run budget cap, timeout
- `repo.bundle`: a tiny fixture repository at a commit
- `check`: the hidden check
- `source.md`: where it came from: a run id, an issue, a release note

Mix (owner can edit the list):

| Kind | Count | Example source | Oracle (no LLM judge) |
|---|---|---|---|
| Small build | 8 | builds that failed a check then got fixed; representative clean builds | hidden tests pass |
| Build that should stop and ask | 3 | app-e2e builds group "stops to ask" (:680) | a decision row exists, no commit past it |
| Repair after a failing check | 3 | 0.9.1 "lead no longer sends a failing check back" | second run's hidden tests pass |
| Planner | 3 | plans sent back for missing steps | plan's steps include named required items |
| Lead files a task / draws a flow from plain words | 5 | flows-e2e lead and build groups | plane state: card/flow with the required fields |
| Lead answers from project files | 3 | app-e2e lead :776 | answer contains the fixture's exact fact strings |

Real failures come from the plane's history: `run.outcome` failed, `build_review.sent_back_as` not null, check-failed
then fixed. Each candidate case is reviewed by a person before it joins. The set is a release-reviewed folder, never
filled automatically.

### Model and runs

- Every case pins its model. **Decision 3** (recommended: **Sonnet** for all eval builds, at about $0.30–0.45 a case run).
  Opus builders average $7.10 on real work, which is 15–20× more. The set measures Toolroll's prompts and harness, and a
  cheaper model shows harness regressions more readily. A separate tiny Opus subset (3 cases) can be added later if the
  owner wants model-change coverage.
- **k = 3** attempts per case, each in a fresh world.
- Per-run budget cap $1.50, using the existing `budgetPerRunMicrousd`. A case over its cap is a **fail**, not an error.
- **Concurrency**: 3 worlds at once, through scripts/provider-gate.mjs's cap. Expect 75 runs × about 3 minutes ÷ 3 ≈
  **75 minutes**, in the background.

### Statuses per case (k = 3)

| Attempts | Status |
|---|---|
| 3 pass | always-pass |
| 0 pass, 3 fail | always-fail |
| mixed pass/fail | flaky |
| any attempt that errored | error |

An **error** is infrastructure: the world couldn't start, the provider refused or was out (a plane-observed event), or
the hidden check couldn't run. It is never agent behaviour.

Nothing is ever re-run to pass. The one exception is an error confirmed by an independent signal (phase 1's rule): one
replacement attempt per errored attempt, at most 3 per eval run. The replaced attempt stays in the ledger.

### Report vs the pinned baseline

The **baseline** is chosen automatically by the plane: the newest released version whose eval run finished with no
"regressed" cases and errors on at most 3 cases. **Decision 6**: the owner can pin a version instead with
`toolroll evals baseline <version>`, a person's proof (it changes what holds releases). Each case is compared with its
**own** baseline result, at the same case version.

| Baseline | Now | Reported as | Holds? |
|---|---|---|---|
| always-fail or flaky | always-pass | **fixed** | no |
| always-pass | always-fail | **regressed** | **yes** (below) |
| always-pass | flaky | **newly flaky** | no |
| flaky | always-fail | worse | no |
| always-fail | always-fail | **still failing** | no |
| none / other version | any | new | no |
| any | error | couldn't tell | no |

Small numbers are noise:
- Cost, turns and tool calls are compared per case, median of 3 vs the baseline's median of 3.
- They are flagged only over **2×** and over a floor ($0.50 or 15 turns).
- Totals are shown, never judged.

### The gate

A **regressed** case opens one `eval_debt` row: case, version, eval run, baseline version. **Decision 5**
(recommended): while a row is open, **`sealAutoGreen` refuses**. It is next to `ciVerdict` (src/release-auto.ts:418):

> An eval case that always passed now always fails (lead-files-task-4, since 0.9.83). A person approves this release.

It does **not** hold deploy, merge or publish. The fix for a regression must itself ship, be deployed and then be
evaluated. Holding deploys would block the fix.

A row clears only by one of two things:
- a later eval run, on a newer installed version, where the same case at the same version is not always-fail
- a person's waiver with their password, which records who and why

Changing the case never clears a row.

Needs you: "An eval case regressed: lead-files-task-4 passed 3/3 on 0.9.82, fails 3/3 on 0.9.83. Automatic releases
wait for a person." The eval report page lists the full table.

### When it runs

**Decision 4** (recommended): three triggers, plus a cap.

- **Weekly**, Sunday 04:00, as a scheduled flow with the nightly's shape (approved once with a password).
- **After a release deploys whose diff touched `MODEL` paths** (scripts/release-check.mjs:73). At most one a day; later
  releases that day roll into the next.
- **On demand**: `toolroll evals run`.
- **Monthly spend cap**, default **$200**, a setting. At the cap no new eval run starts, and Needs you says so. A run
  in progress finishes.

### Budget

| Item | Per run | Runs a month (recommended) | Monthly |
|---|---|---|---|
| Eval set, 25 × 3 Sonnet | about $30 (75 × $0.30–0.45) | 4–5 weekly + about 3 release-triggered (most releases don't touch model paths; deduped per day) | about $130–$240 |
| Reviewer evals, 30 diffs × 3 (Part E) | about $30 (90 × $0.32, the owner's measured Opus review average) | when the reviewer brief or pinned model changes, else monthly: about 1 | about $30 |
| Nightly reading, run ledger, journey ledger | $0 | — | $0 |
| **Total** | | | **about $170 typical; $130 weekly-only; $330 worst case under the cap's default** |

If the evals use the owner's Claude subscription login (the e2e worlds do today), these are plan-limit usage rather than
dollars. The cap counts the provider's reported `total_cost_usd` either way.

---

## Part E. Reviewer evals and a pinned reviewer model

1. **Pin.** A project setting, `review model`: an exact model id such as `claude-opus-…`, not an alias. It requires a
   person's proof to change. `buildReviewPass` passes it to the review invocation (src/build-review.ts:252-259) over the
   route and agent defaults. Each review records `reviewer_model` (the init event's exact id, from Part B) on
   `build_review`.
   - If the provider reports a different model than the pin, the review still counts, the mismatch is shown, and its
     evals don't compare.
   - **Decision 7** (recommended: pin, change by person).
2. **Labelled diffs** (`evals/reviewer/<id>/`): `diff.patch`, the pre-change files the reviewer needs, and `labels.json`.
   About 30 of them:
   - **15 with real bugs**, from Codex-round findings that led to fix commits (the arcs' review notes name them), and
     from `build_review` HIGH findings that were sent back and fixed. Each label gives file, line range and a one-line
     description.
   - **15 clean**: merged changes with no later fix touching those lines for 30 days, and no HIGH finding by anyone.
3. **Run**: `toolroll evals reviewer`. It uses the installed plane's own reviewer brief and invocation (phase `review`,
   permission `plan`), 3 times per diff with the pinned model, in a throwaway world.
4. **Scoring is deterministic, with no judge.** A HIGH finding "hits" a labelled bug when it names the same file and its
   line is within ±8 lines of the labelled range.
   - **Recall** = labelled bugs hit in at least 2 of 3 attempts ÷ labelled bugs.
   - **False-alarm rate** = clean diffs with a HIGH finding in at least 2 of 3 attempts ÷ clean diffs.
   - Each is reported per model id, against that model's previous result. A change of 2 diffs or fewer (out of 15) is
     reported as "no clear change".
5. It holds nothing. It informs the choice of pin.

---

## Later (not in this arc)

**Delta-review coverage in sealAutoGreen.** This would record a reviewed SHA per security-sensitive change after the
last Codex round, and refuse auto-approval when the candidate's security paths changed after it. It is not small:
- Codex rounds happen outside the plane, so it needs a way to record a review.
- It needs a definition of "security-sensitive paths".
- It needs a person-proved record.

Phase 1's process note (eval-harness.md F) stands meanwhile. It becomes a small slice once Part E's `reviewer_model` and
a `review_record` exist.

**Not building**: an eval platform, online evals or shadow deploys, simulated users, judge councils, LLM-graded
outcomes, VM isolation.

---

## Schema

| Version | Slice | Tables / columns |
|---|---|---|
| v139 | A1 | `github_nightly_read` (id, repo, at, ok, why, run_id, attempt, head_sha, created_at, conclusion); `nightly_lane_failure` (id, repo, lane, workflow, gh_run, attempt, job_id, sha, conclusion, html_url, failed_at, opened_at, cleared_at, cleared_by_gh_run, cleared_by_job; unique (repo, lane, gh_run, attempt)); `nightly_lane_note` (repo, lane, gh_run, state runner-failure/didnt-run, at). Kept apart from `main_check_failure`, whose `run` is a Toolroll run id, NOT NULL (src/store.ts:1234) |
| v140 | B1, C1 | `run.tool_calls INTEGER`, `run.model_reported TEXT`; `journey_result` (id, repo, task_ref, run, release_version, script, kind, group, name, attempt, state, seconds, cost_usd, turns, tokens_in, tokens_out, tool_calls, trust CHECK IN ('reported')) |
| v141 | D1, D2 | `eval_run` (id, toolroll_version, set_digest, trigger, started_at, finished_at, state, spend_microusd); `eval_result` (id, eval_run, case_id, case_version, attempt, outcome pass/fail/error, error_why, replaced_by, cost_usd, turns, tokens_in, tokens_out, tool_calls, wall_ms, model_reported); `eval_baseline_pin` (repo-free, version, by, proof, at); `eval_debt` (id, case_id, case_version, opened_by_eval_run, baseline_version, opened_at, cleared_at, cleared_by_eval_run, waived_by, waived_proof, waived_why) |
| v142 | E1 | `build_review.reviewer_model TEXT`; `reviewer_eval_result` (id, eval_run, diff_id, diff_version, attempt, model_reported, hits_json, high_count, cost_usd) |

Each version gets a `src/migration-v1NN-*.test.ts` and an entry in `UPDATE_SAFE_MIGRATIONS` (src/store.ts:999). All
changes are additive.

---

## Slices (ordered; each ships alone)

Targeted runs only, per fix round (feedback: the full suite is GitHub CI plus the release check).

### A1. Read GitHub's nightly (v139)
- **New module** src/nightly-github.ts:
  - `readGithubNightly(run, gh, repo)`: the binding rules above
  - `laneOutcomesOf(jobs)`
  - `settleGithubNightly(store, repo, read, now)`: opens failures, notes, and clears from later passes
- **Hooks**:
  - `refreshGithubNightlies(store, now)` at the end of src/operate.ts, called from `followUpChecks` (:6789), 30-minute
    throttle
  - store accessors at the end of src/store.ts
  - `toolroll release nightly --github` setup (src/release-cli.ts)
- **Tests** (src/nightly-github.test.ts, fake gh):
  - a failed lane opens one row
  - the same lane passing on a later run clears it
  - another lane passing doesn't clear it
  - before-tests, cancelled and missing lanes give notes, not rows
- **Attacks** (test/attacks/nightly-github-binding.test.ts):
  - a `workflow_dispatch` run from a branch
  - a fork's run
  - `nightly.yml@evil.yml`
  - a lookalike `nightly / node 24 · ubuntu-latest ` (trailing space) from another workflow
  - the attempt changing mid-read
  - head not on main's history
  - a truncated page
- Migration test v139.
- **Targeted**: `npx vitest run src/nightly-github.test.ts test/attacks/nightly-github-binding.test.ts src/migration-v139-*.test.ts src/password-freshness.test.ts`

### A2. Hold deploy, merge, publish and auto-approval
- **New functions**:
  - `nightlyLaneHold(store, repo, taskId, ciRuns)` in src/nightly-github.ts
  - `githubNightlyProblem(...)` at the end of src/scope.ts, called in `liveReleaseOf`'s deploy/merge arm (:1979) next to
    `mainDebtProblem`
- **Call sites**:
  - publish: in src/release.ts tag/publish (:1222/1232)
  - auto-approval: `sealAutoGreen` (src/release-auto.ts:418)
  - the coordinator: a fresh read before deploy, merge and publish when the last read is over 2 h old. The exemption is
    stored from the `readCheckRuns` result it already has.
- **Tests**:
  - src/release.slow.test.ts cases: debt holds deploy; the candidate's re-run after the failure exempts it; an older
    green run does not; unreadable reads warn only; stale warns only
  - sealAutoGreen refusal in src/release-auto.test.ts
- **Targeted**: those two files + src/scope*.test.ts + password-freshness

### A3. Say it in the console
- **Surfaces**:
  - Needs-you board item (src/server/render-pages.ts:609 `boardBody`)
  - release card lines (src/server/render-tasks.ts:3024, src/server/task-views.ts `releaseViewOf`, src/release-card.ts:266)
  - notification `github-nightly-failed`
  - also show the plane's own `main_check_failure` debt in Needs you, which has no item today
- **Tests**: render tests for each state (failed, exempted, unreadable, stale); words reviewed against plain-label rules.
- **Targeted**: src/server/render-*.test.ts for the touched renders

### B1. Run ledger: tool calls, exact model, cost per finished task, bloat flags (v140 part)
- **Writes**: `run.tool_calls` at disposition (src/dispose.ts, from `stepsOf`); `run.model_reported` from the init event
  (src/provider.ts:595 → src/invoke.ts:856 `recordUsage`).
- **New module** src/run-ledger.ts: `costPerFinishedTask`, `bloatOf`.
- **Pages**: usage page and the task page's How it ran (new handler code at the end of src/server/tasks.ts).
- **Tests**:
  - bloat needs 8 similar runs, and both the ratio and the floor
  - cost excludes unfinished tasks and shows them apart
- Migration test v140.
- **Targeted**: src/run-ledger.test.ts, src/run-efficiency.test.ts, src/migration-v140-*.test.ts, password-freshness

### C1. Journey ledger (v140 part)
- **Report data**:
  - optional `usage` on journey lines (src/contracts/release-check.ts:190-200)
  - e2e-kit.mjs sums the world's run rows per journey window
  - release-check.mjs `buildReport` carries them (:284-297)
- **Plane side**: copies them into `journey_result` with `trust='reported'` when it settles a release check
  (`settleReleaseChecks`, src/nightly-check.ts:270). The release card shows totals vs the last release.
- **Tests**: contract accepts with and without `usage`; malformed `usage` is dropped, not trusted; a retry's attempts are
  both kept.
- **Targeted**: src/contracts/release-check.test.ts, src/check-report.test.ts, scripts/release-check tests

### D1. Eval runner and cases (v141 part)
- **Cases**: `evals/cases/` with the first 10 cases, so the runner proves itself on a small set first.
- **Runner**:
  - `toolroll evals run [--case id] [--k 3]` (at the end of src/operate.ts)
  - src/evals.ts: world from the installed runtime, hidden-check copy-in, k attempts, rows, error-only replacement,
    spend cap
- **Path rule**: `evals/` added to `autoPathProblem`.
- **Tests**:
  - the runner on a scripted provider (no spend): pass, fail, error, and over-cap = fail
  - the hidden check replaces agent-edited tests
  - a changed case gets a new version
- **Targeted**: src/evals.test.ts, src/release-auto.test.ts (path rule), password-freshness

### D2. Baseline, report, gate, schedule (v141 part)
- **Logic**: statuses and comparison (`evalReport`), automatic baseline and pin, `eval_debt` + `sealAutoGreen` refusal
  + waiver.
- **Triggers**: weekly flow; post-deploy trigger for MODEL paths (deduped per day).
- **Surfaces**: Needs-you item; eval report page.
- **Remaining cases**: 15, to reach 25.
- **Tests**:
  - every row of the comparison table
  - debt opens only on always-pass → always-fail
  - a case edit doesn't clear
  - the waiver needs a person
- **Targeted**: src/evals-report.test.ts, src/release-auto.test.ts, render tests

### E1. Reviewer evals and the pin (v142)
- **Pin**: setting + `buildReviewPass` override; `build_review.reviewer_model`.
- **Data and runner**: `evals/reviewer/` with 30 labelled diffs; `toolroll evals reviewer`; deterministic hit scoring.
- **Tests**: scoring (hit window, 2-of-3, clean false alarm); the pin overrides the route; a mismatch is recorded.
- **Targeted**: src/build-review.test.ts, src/reviewer-evals.test.ts, src/migration-v142-*.test.ts

Order rationale:
- **A1–A3** close the test-matrix follow-up and cost nothing to run.
- **B1 and C1** give the numbers D needs, again at no spend.
- **D1 before D2**, so the runner's honesty is reviewed before anything can hold a release.
- **E1** is last. It is the most independent.

Codex review: one round on this plan, then one round per pair (A1–A3, B1–C1, D1–D2, E1), within the two-round limit.

---

## Open decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| 1 | Stale (36 h) or unreadable GitHub nightly: warning or block? | **Warning**, everywhere. Optional: block only automatic approvals |
| 2 | What open nightly lane debt holds | **Deploy, merge, publish and auto-approval of every release**, unless the release re-ran that lane after the failure and it passed |
| 3 | Eval model | **Sonnet**, pinned per case (about $30 a run). Opus would be about $400+ a run |
| 4 | When evals run | **Weekly + after a release that touched model-facing code (max one a day) + on demand; $200 monthly cap** |
| 5 | What an eval regression holds | **Automatic approval only**; never deploy (the fix must ship) |
| 6 | Baseline | **Automatic "last good release"**; owner may pin a version with a password |
| 7 | Reviewer model | **Pin an exact model id**; changing it needs a person; every review records the exact model |
| 8 | Delta-review coverage | **Later**, after E1 (not small) |
| 9 | Cancelled or runner-failed nightly lanes | **Shown, not debt** |
