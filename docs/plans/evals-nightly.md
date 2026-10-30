# Evals and nightly: GitHub's nightly as release debt, and eval harness phase 2

Status: approved for building (Codex round 2 GO-with-changes folded). Revision 3. Round 1 (NO-GO, 16 findings) and
round 2 (11 closed, 5 partial plus one new high, all folded in) are in "Review round 1" and "Review round 2" below. Branch `evals-phase2`, off main 360762cb (0.9.81). Owner's ask: "We need to do these
Evals and nightly stuff." Sources: docs/plans/test-matrix.md ("Nightly", "Not built yet"), docs/plans/eval-harness.md
(phase 1 shipped 0.9.77–0.9.81; "Phase 2"), and the code cited below. Nothing here uses Tart or a VM.

## In one screen

This is a deliberately small first version. It has four parts:

| Part | What it adds | Release wall clock | API spend |
|---|---|---|---|
| A. GitHub nightly → release debt | The plane reads every Nightly run and attempt on main itself. A failing lane becomes debt. Deploy, merge and the last pre-tag check wait until that lane passes on a later nightly, or freshly on the candidate. Shown in Needs you and on the release card | at most 20 s per boundary (one bounded GitHub read at deploy, merge and pre-tag); usually 0 | $0 |
| B. Eval accounting | Every model call in an eval attempt is tied to that attempt, including lead chat turns. API dollars are kept apart from subscription usage, and unknown is kept as unknown | 0 | $0 |
| C. Eval set | 25 versioned cases, run 3 times each, in canonical campaigns started by hand. Run by the installed plane in separate world processes, graded by a trusted oracle outside the fence. Compared with an owner-pinned baseline campaign | 0 (on demand, never in a release) | about $23–34 a campaign; at most about $130 reserved |
| D. Reviewer evals | Person-validated buggy and clean diffs. Recall and false alarms under a pinned provider and exact model | 0 | about $29 a run |

**Deferred** (see "Later"):
- bloat flags on production runs
- the per-release journey ledger and its trend UI
- automatic baseline promotion
- weekly and release-triggered eval runs (they wait for measured cost)
- delta-review coverage in sealAutoGreen

Estimated API spend: **about $85 in the first month** (two campaigns and one reviewer run, all started by hand). If
weekly runs are switched on after measurement, **about $150 a month**. See "Budget".

**What the eval gate does today: nothing automatic.** Production automatic approval is already refused, because CI
reports are not protected from candidate writes (`reportsProtected: false`, src/release-adapters.ts:381-383; refusal
words at :875-876). The eval debt that would hold automatic approval is therefore dormant. It becomes live only when
that refusal is lifted. Until then, eval debt is a Needs-you item and a release-card line that a person reads.

## Facts the design stands on (with citations)

**The plane's own nightly (03:00).** src/nightly-check.ts:1-16.
- A scheduled flow files a check-only task at main's head, as read from the recorded remote (`trustedMainOf`, :83).
- Failures become `main_check_failure` rows (src/store.ts:1234-1245). They are opened in `settleReleaseChecks`
  (:247-266) and cleared only by a full pass that covers the exact item (`coversItem` :219; clearing :270-311).
- `mainDebtProblem` (src/scope.ts:1990-1999) holds deploy and merge only when the newest check was targeted. It is
  reached through `liveReleaseOf` (:1979-1982).
- `refreshTrustedMains` reads main only for repos with local nightly approvals or local debt (src/nightly-check.ts:99-103).
- There is no Needs-you item for this debt.

**GitHub's nightly.** .github/workflows/nightly.yml, cron `17 6 * * *`.
- It calls ci.yml (jobs `nightly / <job>`) and release-candidate.yml (`nightly floor / <job>`).
- Its lanes are the `REQUIRED_PR_CHECKS` names (src/release.ts:46-62), each tied to a workflow
  (`REQUIRED_PR_CHECKS_WORKFLOW`, :66-76).
- The aggregate lanes fail through an "Every shard passed" step (.github/workflows/ci.yml:111).
- Nothing in the plane reads these runs today.

**Readers.**
- `readCheckRuns` (src/release-adapters.ts:965-1024) binds runs to workflow path and event, and refuses retargeted PRs.
  Its `CheckRun` has no run-attempt identity and no start or completion times (src/release.ts:106-118).
- `failedBeforeTests` / `readJobBeforeTests` (src/release-adapters.ts:1036-1060) read GitHub's step records.
- `retryingExec` retries reads for up to 180 s (src/release-net.ts:17, :173). That is too long for an optional
  pre-boundary read.
- scripts/release-proof.mjs:186-223 reads the newest run's exact attempt's jobs, then re-reads the run so that a change
  mid-read refuses. :91 refuses jobs that finished after the merge.

**Entry points that deploy, merge or tag.**
- `deploymentGate` (src/deploy-gate.ts:17-48) serves the person-approved road too. It calls `liveReleaseOf`, which
  returns `applies: false` for a task with no release authority (src/scope.ts:1940-1942).
- The installed runtime's scripts/deploy-candidate.mjs:34-37 proves the same predicate.
- The merge goes through `reserveRelease` / `runReleaseOperation` (src/store.ts:24456, :24493).
- The tag is created at src/release.ts:1227. The tag push starts publish.yml (.github/workflows/publish.yml:16), and the
  coordinator's later "publish" step (:1232) only waits for it.

**Watch loop.** `followUpChecks` runs every 5 s (src/operate.ts:6777). It calls `refreshTrustedMains` and
`settleReleaseChecks` (:6789-6792). Each throttles itself.

**Accounting.**
- **`run` rows** (src/store.ts:3666-3741) hold provider, model alias, times, tokens, `cost_usd`, `usage_json` and
  `agent_turns`. They are written by `recordUsage` (:15806) from Claude's `result` event (src/provider.ts:480-540;
  src/invoke.ts:856-863).
- **Lead chat** settles into `chat_turn` (src/store.ts:3084; `finalizeLeadTurn`, src/lead.ts:700). It does not use `run`.
- **Subscription chat** reads the init event's exact model into `seen.model` (src/subscription-chat.ts:276) and never
  uses or stores it. It keeps no reported cost.
- **`run_spend`** prices subscription work at $0 (src/spend.ts:100-101).
- **Tokens** need provider-aware, cache-aware normalization (`usageOf`, src/run-efficiency.ts:51).
- **Dollar cap.** `invokeAgent` takes `maxBudgetUsd` (src/invoke.ts:851) and refuses capped work on a provider that
  can't hold a cap (:327). The build review passes no cap (src/build-review.ts:189).

**Real-model journeys.** There are **13**: 7 in scripts/flows-e2e.mjs (:91, :100, :120, :141, :238, :337, :525) and 6
in scripts/app-e2e.mjs (:680, :776, :792, :805, :1516, :1661).
- The release check runs them through scripts/e2e-parallel.mjs (scripts/release-check.mjs:622).
- e2e-parallel merges a retry's outcomes over the first run's and keeps only a group `retried` flag
  (scripts/e2e-parallel.mjs:187-207).
- The shim's `modelCalls` counts CLI invocations, not agent turns (scripts/fixtures/scripted-provider.mjs:190-193).
- `world()` mutates process-wide environment (scripts/e2e-kit.mjs:260-286, e.g. `PATH`, `XDG_CONFIG_HOME`).

**Packaging.** package.json `files` (:107-) ships dist and a few scripts. It ships neither an `evals/` folder nor
scripts/provider-gate.mjs. The provider gate defaults to 4 concurrent turns and is shared per gate directory
(scripts/provider-gate.mjs:30-34).

**Reviewer.**
- The build review is queued at src/build-review.ts:66, run by `buildReviewPass` (:220), briefed at :137, and invoked at
  :189.
- Its model comes from the route review leg or the project's review agent (:252-259). It is not pinned.
- Findings follow src/contracts/review-findings.ts:21-: severity, file, line, and a one-sentence failure scenario.
- The reviewer `run` row holds the model alias (src/store.ts:11559-11567).

**Policy paths.** `autoPathProblem` (src/release-auto.ts:195-215) lets `src/` product files ship without a person
unless they are test helpers.

**Schema.** `SCHEMA_VERSION = 138` (src/store.ts:861). Migrations are inline (:5393-5404) and listed in
`UPDATE_SAFE_MIGRATIONS` (:999). This plan needs **v139–v142**. Take the next free numbers if another branch lands
first.

**Placement rule.** src/password-freshness.test.ts pins function ordinals in src/operate.ts, src/store.ts and
src/server/tasks.ts. New functions go at the end of those files. In tasks.ts that means after the last inner function of
`createTasksHandlers`. All new logic otherwise lives in new modules.

**Owner's measured costs** (runs since 2026-09-15, read-only query of the plane database): Opus builder $7.10 (315
runs), Opus planner $0.90, Opus reviewer $0.32 (131), Sonnet builder $0.27 (10 runs: a thin sample).

## Trust, stated plainly

| Evidence | What it is | What it is not |
|---|---|---|
| A GitHub lane conclusion | **Recorded**: GitHub authenticates that this job of this workflow concluded `success` or `failure` | **Not independent**: the tests that decided it are the repository's code, and a candidate's tests could report green. A recorded pass can clear a nightly hold or exempt a candidate. That is the same trust the existing required-checks gate already places in the same records (src/release.ts `prChecksVerdict`). Nightly debt adds holds and never trusts more than that gate does |
| A sealed release-check report | **Recorded** bytes the candidate's check wrote (src/check-report.ts:281) | Not independent assertions |
| Eval pass/fail | **Plane-graded**: a trusted oracle process from the installed release, outside the fence, decides from bounded output it requested | Not proof against a later privileged runtime: the installed plane writes the rows, so a future release with database authority could rewrite them. "Append-only" is an application invariant enforced by the eval module and by person-approved policy paths, not a cryptographic guarantee |
| Eval usage numbers | **Plane-recorded** from provider `result`/init events by installed code | API dollars and subscription usage are different things, and unknown stays unknown |

Automatic approval stays refused (src/release-adapters.ts:381-383). Nothing in this plan turns it on.

---

## Part A. GitHub's nightly as release debt

### Opting in

`toolroll release nightly --github`, proved as a person, as `createNightlyCheckFlow` does (src/nightly-check.ts:122).
It records the GitHub repository from the recorded remote (`trustedRemoteIdentity`). The workflow path is fixed at
`.github/workflows/nightly.yml`. Opted-in repos join `refreshTrustedMains`'s repo set (src/nightly-check.ts:99-103), so
main's head stays fresh for the ancestry checks. Without opting in, nothing is read and nothing holds.

### Lanes have stable identities

A table `nightly_lane` seeds one stable id per required check: workflow file plus the lane's REQUIRED_PR_CHECKS name at
seeding, for example `ci.yml:node 24 · macos-latest`. Display names map to ids.

| Change | What it takes |
|---|---|
| A **rename** or equivalent replacement | A person-approved alias: `toolroll release nightly --lane-alias <old-id> <new name>`, with a password. Open debt moves to the new name. A lane is never matched by a guess |
| **Retiring** a lane | Only when its name is no longer in the installed plane's `REQUIRED_PR_CHECKS`, and only by a person with a password. Its open debt closes as "retired by <person>", recorded |

Without one of these, an unknown job name is ignored. A missing known lane shows as "didn't run".

### Reading every run and attempt

`readGithubNightly` keeps two things per repo:
- a **paging cursor**: how far listing has got through runs not yet seen
- a **watch list** of every counted run id created in the last **30 days**, which is GitHub's re-run horizon. Each
  entry carries the highest attempt read so far. Runs that haven't finished stay on the list until they finish and are
  read, whatever their age.

Each read does the following:

1. **List runs.** It lists `actions/workflows/nightly.yml/runs?branch=main` from the paging cursor. It reads at most
   10 pages per read, then saves where it stopped and resumes there on the next read. A large backlog is worked through
   across reads; it is never refused as a whole. A truncated or changing page refuses only that page, and the cursor
   stays before it.

   Each read also **revisits the watch list**: every run on it is re-read by id (`actions/runs/{id}`), within the same
   per-read budget, oldest-checked first. If a run's `run_attempt` has grown since the last read, the new attempts are
   read (step 3). This is how a re-run of a 3-week-old nightly is seen. A run leaves the list after 30 days, provided it
   is finished and fully read. Exact-attempt rereading follows scripts/release-proof.mjs:208.
2. **Keep only real nightly runs.** A run counts only when all of these hold:
   - `path` is exactly `.github/workflows/nightly.yml`, with no `@` suffix
   - the repository and head repository are the project's own
   - `head_branch` is `main`
   - the event is `schedule` or `workflow_dispatch`
   - `head_sha` is on main's first-parent history as the plane read it (`trustedMainOf` + `verifiedFirstParentWalk`)

   A hand-started run on a branch never counts.
3. **Read every attempt's jobs.** For each counted run, it reads every attempt from 1 to `run_attempt`
   (`actions/runs/{id}/attempts/{n}/jobs`, all pages). It records each **completed** job, idempotently, with:
   - lane id, run, attempt and job id
   - sha
   - `started_at` and `completed_at`
   - conclusion
   - cause (below)

   It does not wait for the whole workflow to finish: a failed lane in a still-running nightly is ingested on the next
   read. It then re-reads the run. If the run's attempt or status changed mid-read, that run is re-read next time; the
   jobs already recorded stay.
4. **Move the cursor.** The paging cursor moves past a page once every run on it has been recorded on the watch list.
   Runs that haven't finished stay on the watch list until they finish and are read.

Nothing read later ever removes a recorded failure: not a cancellation, a skipped or missing job, an unreadable page,
or a newer attempt.

### Cause of a failure

| Lane job | Recorded cause | Opens debt? |
|---|---|---|
| `success` | passed | no; may clear |
| `failure` / `timed_out`, own steps ran, not an aggregate | test failure | **yes** |
| Aggregate lane failed at "Every shard ran the whole suite" (the coverage verifier, ci.yml:128, scripts/ci-shards.mjs:125-145) | test failure, **always**. That step can fail with every shard green, for example when a test file ran in no shard | **yes** |
| Aggregate lane failed only at "Every shard passed" (ci.yml:111) | runner failure only when a **positively established, non-empty** chain shows it: at least one shard in the **same attempt** failed, every failed shard is readable, and every failed shard `failedBeforeTests`. Zero failed shards, any shard that ran its steps and failed, or any unreadable shard: test failure | chain established: no; otherwise **yes** |
| Failed before its own steps (`failedBeforeTests` on the lane job) | runner failure | no |
| `cancelled`, `skipped`, or missing | didn't run | no |
| Cause can't be read | test failure (fail closed) | **yes** |

Runner failures and "didn't run" show as warnings. They never erase a failure already recorded.

### Clearing

An open lane failure (lane id, run, attempt, job, sha, `completed_at`) clears only when a **different, later counted
nightly run** shows the same lane id `success`, and all of these hold:
- that job's `started_at` is after the failed job's `completed_at`
- its sha contains the failed sha

A re-run attempt inside the same nightly run does not clear: that would be rerun-to-pass. A person dispatching Nightly
on main makes a new run. That is allowed and recorded.

### The candidate's exemption

A release may pass one specific open failure when its own pull-request CI ran that lane after the failure and passed.

`readLaneJobs(repo, pr, head)` is a new reader, modelled on release-proof.mjs:186-223. For each lane's workflow it takes
the newest run on the PR head from that PR's `pull_request` event, then that run's latest attempt's jobs, with their
`started_at` and `completed_at`. It then re-reads the run.

An exemption is stored per **(task, candidate sha, failure id)** with the exact PR, run, attempt, job, timestamps and
read time. It holds only if all of these do:
- the job concluded `success` on the candidate head, from the lane's own workflow
- the job's `started_at` is after the failed job's `completed_at`
- the candidate contains the failed sha (containsMain already requires main's head)

It is re-checked at every boundary by reading the newest run and attempt again. If the newest run or attempt differs,
is pending, or holds a failure for that lane, the exemption is void. An unreadable re-read never counts as an exemption.

The exemption covers that candidate only. The row stays open until a main nightly passes.

### Where the hold applies

All in the new module src/nightly-github.ts; the call sites only call into it.

| Boundary | Call site | Notes |
|---|---|---|
| **Every deploy** of an opted-in project's task | `deploymentGate` (src/deploy-gate.ts) and scripts/deploy-candidate.mjs (installed runtime) | Independent of release authority, so the person-approved road is covered (`liveReleaseOf` returns `applies: false` there) |
| **Merge** | inside `reserveRelease`'s / `runReleaseOperation`'s transaction (src/store.ts:24456, :24493), via a new store function at the end of src/store.ts | Reads the stored debt and exemptions |
| **Pre-tag authorization** | the coordinator just before `createTag` (src/release.ts:1227) | This is the final point the plane can stop publication |
| Automatic approval | `sealAutoGreen` (src/release-auto.ts:418) | Dormant today (auto-approval is already refused) |

**Freshness.**
- **Background reads** run every 30 minutes in `followUpChecks`, with a 60 s overall deadline.
- **At each boundary**, the coordinator, `deploymentGate`'s caller and the pre-tag step first do one **bounded read**:
  plain exec (not `retryingExec`), at most 20 s overall. Then the stored debt and exemptions are checked inside the
  reservation or start transaction.
- **If the bounded read fails**, the boundary uses the stored state.

**Stated limitation.** A failure GitHub records after the plane's last good read can be missed. Normally that gap is
seconds, because of the boundary read. When GitHub can't be read, the gap is up to the age of the last good read, which
the release card shows. After the tag is pushed, publish.yml runs on GitHub with no plane check. A nightly failure
recorded after pre-tag authorization can't stop that npm publication. Holding the npm step itself would need a trusted
authorization inside publish.yml. That is out of scope.

**Recovery after merge.** If new debt appears between merge and tag, the release waits at the tag step. Re-running the
pull request's CI won't help: the release proof refuses jobs finished after the merge (scripts/release-proof.mjs:91).
The way out is a main nightly passing the lane: tonight's, or a person dispatching Nightly on main. The other way out is
abandoning the release for a new one. An exemption obtained before the merge still stands at the tag.

**Stale or unreadable: Decision 1** (recommended: **warning, not a block**). "Couldn't be read: <why>" and "hasn't run
since <date>" (more than 36 h) are visible states. Existing recorded debt stays enforced from the store. Reasons:
- the release's own PR runs every lane on the exact head (test-matrix.md)
- the nightly "can't stop a regression shipping the same day"
- blocking on GitHub's availability adds owner blockers for no coverage

**What it holds: Decision 2** (recommended): deploy, merge and pre-tag authorization of every opted-in project's
release, whether person-approved or automatic, unless exempted. Reason `nightly-debt`. Words:

> GitHub's nightly failed "node 24 · macos-latest" on main at abc1234 (Oct 30, 06:17). This release can't deploy until
> that lane passes again: re-run this release's CI, or wait for tonight's nightly.

After the merge, the words drop "re-run this release's CI".

### Console words

**Needs you.** One project-level item per open failure, in the board lane (src/server/render-pages.ts:609):

> GitHub's nightly failed: node 24 · macos-latest on main at abc1234. Releases wait until it passes again. [Open the run
> on GitHub]

The plane's own `main_check_failure` debt gets the same treatment; today it has no Needs-you item.

**Release card** (src/server/render-tasks.ts:3024; src/release-card.ts:266). One line per state that matters:

> GitHub nightly: failed node 24 · macos-latest (Oct 30). This release re-ran it after the failure and passed.

> GitHub nightly: couldn't be read (gh isn't signed in), last read 3 h ago. Not holding the release.

**Notification.** `github-nightly-failed`, attention class, one per failure.

---

## Part B. Eval accounting

The eval ledger is the trusted one, so its numbers must cover every model call an attempt makes. They come from the
plane's own records:

1. **One world per attempt.** Each eval attempt runs in its own world process (Part C), with its own database. Every
   `run` row and every `chat_turn` row in that database belongs to that attempt, so the identity needs no new tagging
   inside the product.

   The runner collects, by role: builder, planner, repair and reviewer runs from `run`, and lead turns from
   `chat_turn`. Each invocation becomes an `eval_invocation` row tied to its case, attempt and kind.
2. **Close the gaps (small product changes):**
   - `run.model_reported`: the exact model from the init event (src/provider.ts:595)
   - **Chat metadata, for streamed and buffered calls.** Subscription chat reads the model at :276 and drops it, and
     `claudeOutput` (src/subscription-chat.ts:184) returns only text and plain tokens. `LeadProviderAnswer`
     (src/converse.ts:436) has no model or turn fields. Both gain the following, each null when the provider didn't
     report it (never 0):
     - `modelReported`
     - `providerTurns` (`num_turns`)
     - `reportedCostUsd`
     - `cacheReadTokens` and `cacheWriteTokens` from the subscription result's `usage`

     They are persisted on `chat_turn` as `model_reported`, `provider_turns`, `reported_cost_usd`, `cache_read_tokens`
     and `cache_write_tokens`. These are summed over every provider request of the turn; a single unknown makes the
     sum unknown.
3. **Keep three amounts apart:**
   - **API dollars**: billing `api` with a reported or priced cost
   - **Subscription usage**: the provider's reported `total_cost_usd` on subscription work, shown as "subscription
     usage, not billed"
   - **Unknown**

   `run_spend`'s $0 for subscriptions (src/spend.ts:100) stays as it is for spend limits. The eval report never sums the
   three into one number.
4. **Tokens** use `usageOf`'s cache-aware split (src/run-efficiency.ts:51): input, cache read, cache write, output.
   **Turns** are the provider's `num_turns`. **Tool calls** are `stepsOf` counts read while the step records exist,
   otherwise unknown.
5. **Cost per successful task** for a campaign: API dollars over all attempts ÷ passing attempts, with subscription
   usage shown the same way beside it.

No production-run views (bloat flags, cost per finished task across projects) in v1.

---

## Part C. The eval set

### Where it runs

`toolroll evals run`, from the **installed** plane:
- The installed release is the one that was gated and deployed. The campaign records its build digest (version plus a
  digest of the installed dist).
- Each attempt runs as a **separate child process**, `toolroll evals attempt <campaign> <case> <n>`, from that same
  installed binary. So `world()`-style environment changes stay inside one process (finding 16).
- If the installed build changes mid-campaign (a deploy), the campaign stops as **incomplete**. An incomplete campaign is
  never canonical.
- **Admission pauses** while a release operation is reserved or a deploy is draining. Only one campaign runs at a time.
  It has its own concurrency limit: 2 attempts at once.

**Packaging.**
- An `evals/` folder joins package.json `files`: a manifest, small fixture bundles, and oracles. Budget: under 2 MB.
- The provider-gate logic needed at runtime is ported into src, so it ships in dist. scripts/provider-gate.mjs is not
  shipped.

### Grading: a trusted oracle outside the fence

The case's code (the fixture repository as the agent left it) is never run in the grader's process.

1. **When the agent's run ends**, the runner proves the run's process group is gone, using the fence's existing
   process-group accounting.
2. **The oracle** is a separate process from the installed release (`evals/cases/<id>/oracle.mjs`, zero dependencies,
   the installed node binary). It owns the grading. It:
   - copies in the case's hidden test inputs, reading paths with lstat/O_NOFOLLOW and refusing links
   - starts the exercised program **inside the existing native fence**: the same sandbox the release check uses
     (Seatbelt / bubblewrap via the agent fence), no network, no access to the oracle's or the plane's state, a time
     limit
3. **The exercised program** is run with a fixed argv and the installed node. Fixtures have no dependencies, and the
   oracle ignores package.json scripts.
4. **The oracle sends a fresh nonce and inputs**, and reads at most 64 KiB of output. It passes the attempt only if the
   output holds the values it computed itself for those inputs. An exit code alone never passes.

   That defeats `process.exit(0)`, edited launchers and tampered imports: an early exit produces no answer.
5. **Lead and planner cases** are graded from plane state: rows that the world's installed code wrote (the filed card's
   fields, the plan's steps, a decision row). The agent's text is never parsed as a verdict.
6. **Outcomes:**

   | Outcome | When |
   |---|---|
   | pass | the oracle got the right answer |
   | fail | wrong answer, or the exercised code crashed, timed out or hit its budget cap |
   | error | the evaluator or provider failed independently of the agent (below) |
   | unevaluated | the reported exact model differs from the case's pin |

   An **error** counts only when the plane recorded it: the world failed before the agent started, the provider refused
   or was down (a plane-side provider event), or the oracle process itself failed. Exercised-code crashes and timeouts
   are **fails**.

No VM. The fence is the same one every build already runs in.

### The cases (25, versioned)

- **Folder.** Each case lives in `evals/cases/<id>/`: `case.json` (id, kind, words, pinned provider + exact model,
  per-invocation cap, max invocations, timeout), `repo.bundle`, `oracle.mjs`, `source.md`.
- **Version.** A case's version is the sha256 of its folder. A changed case starts a new history.
- **Who decides.** Cases are added by a person in a reviewed release, never filled automatically.

Mix:

| Kind | Count | From |
|---|---|---|
| Small build | 8 | builds that failed a check and were fixed; clean representative builds |
| Build that must stop and ask | 3 | app-e2e "stops to ask" (:680) |
| Repair after a failing check | 3 | the 0.9.1 "lead no longer sends a failing check back" class |
| Planner | 3 | plans sent back for missing steps |
| Lead files a task / draws a flow | 5 | flows-e2e and app-e2e lead journeys |
| Lead answers from project files | 3 | app-e2e :776 |

**Model: Decision 3** (recommended: Sonnet, pinned as provider + exact model id). Opus builders cost about 15–20× as
much on real work.

### Campaigns

- **Canonical:** `toolroll evals run`, with no flags. At admission it seals:
  - the manifest digest, and every case id and version
  - the pinned models
  - k = 3
  - the baseline campaign id
  - the build digest

  Each attempt has a unique identity: (campaign, case, attempt number, replaces).
- **Diagnostic:** `--case`, `--k`, or anything else. It is a report only. It never settles debt and never becomes a
  baseline.
- **Complete** means every sealed attempt reached pass, fail, error or unevaluated. An errored attempt gets one
  replacement only when a plane-side signal confirms the error; there are at most 3 replacements per campaign, and the
  replaced attempt stays recorded.
- **Settlement happens once, atomically, when a canonical campaign completes.** A campaign settles only if no
  later-admitted canonical campaign has already settled. An older campaign that finishes late reports and settles
  nothing.

### Statuses per case

| Status | Meaning |
|---|---|
| always-pass | 3 passes |
| always-fail | 3 fails |
| flaky | mixed passes and fails, no error |
| error | any error left after replacement |
| unevaluated | any attempt unevaluated |

Nothing is re-run to pass.

### Baseline: owner-pinned and immutable

`toolroll evals baseline <campaign-id>`, with a password (**Decision 6**). The campaign must be complete and canonical.
Each campaign freezes its baseline id at admission.

There is no automatic promotion in v1. So 3/3 → 1/3 → 0/3 reports **regressed** at the third step, because every
campaign is compared with the same pinned campaign.

When re-pinning, the command lists every case whose result in the new pin is worse than in the old pin, and those whose
known-good result would be lost. It requires `--accept-worse` to go ahead.

### Report and debt

Each case is compared with **its own result in the baseline**, at the same case version:

| Baseline | Now | Reported as | Opens debt |
|---|---|---|---|
| always-fail or flaky | always-pass | fixed | no |
| always-pass | always-fail | **regressed** | **yes** |
| always-pass | flaky | newly flaky | no |
| always-fail | always-fail | still failing | no |
| any | error / unevaluated | couldn't tell | no |
| missing or other version | any | new | no |

Small numbers are noise. Per case, median cost and turns are shown beside the baseline's. They are flagged only over 2×
and over a floor ($0.50 API or 15 turns), and nothing is held on them.

**Debt** is one `eval_debt` row per regressed case (case, version, campaign, baseline campaign). It clears only when a
later, complete canonical campaign has that case at the same version with **at least 2 passes, no error and nothing
unevaluated**. Error, unevaluated, an incomplete campaign or a diagnostic run never clear it, and neither does editing
the case. A person can waive a row with a password, recording why.

**What debt holds: Decision 5.** `sealAutoGreen` refuses, which is dormant today (see the top of this plan). It never
holds deploy, merge or tag, because a person-approved fix must be able to ship. Needs you shows:

> An eval case regressed: lead-files-task-4 passed 3/3 in the baseline and fails 3/3 on 0.9.83.

The release card repeats it for a person approving a release.

### Policy code needs a person (finding 10)

`autoPathProblem` (src/release-auto.ts:195; today :212 lets these through) gains these paths:
- `evals/`
- `src/evals*.ts`, `src/eval-*.ts`
- `src/reviewer-evals.ts`
- `src/nightly-github.ts`
- the contracts they use (`src/contracts/evals*.ts`)

That covers the evaluator, oracles, reviewer scoring, baseline, debt, budget and nightly ingestion.

**Enforcement call sites are protected too.** The hooks live in src/deploy-gate.ts, scripts/deploy-candidate.mjs, the
merge reservation in src/store.ts, the pre-tag step in src/release.ts, `sealAutoGreen` in src/release-auto.ts, and the
lead and review dispatch paths that reserve eval spend. A change that removes or bypasses any of them must need a person.

Rather than protecting those whole large files by path, a manifest in `src/eval-*.ts` lists each required hook call.
src/release-auto.ts and scripts/deploy-candidate.mjs are already person-only as release and CI policy. A check that
`autoPathProblem` runs over the candidate's tree proves every listed call is still present, at its named function. If
any is missing or moved, or the manifest itself changed, the change needs a person. Result-writing authority stays in the installed plane's eval module. World processes get no handle
on the plane's database.

### Budget: reservations, not a start-only cap

**Decision 4** (recommended): **on demand only** at first. After two measured campaigns the owner decides whether to
turn on weekly runs.

The monthly ceiling defaults to **$200 of API dollars plus reserved worst case**. Subscription usage is shown but not
capped in dollars: plan limits govern it.

**How a reservation works.**
- **Before admitting a campaign** (eval or reviewer), the runner reserves the campaign's worst case in
  `eval_spend_month`: the per-dispatch cap × max dispatches × 3, plus 3 replacements. Eval and reviewer campaigns share
  this ledger.
- **Every provider dispatch** in an attempt is capped and **carved out of that campaign reservation**. It is never
  reserved a second time against the month. This covers:
  - every `invokeAgent` call (builder, planner, repair, reviewer), capped by `maxBudgetUsd` (src/invoke.ts:851)
  - **every lead request**: lead requests bypass `invokeAgent` (src/lead.ts:543, direct and subscription), and one
    reply can make several requests

  For lead requests, the world's lead turn is given the attempt's remaining per-dispatch cap through the lead's own
  existing reservation (`reserved_microusd` on `chat_turn`). Each request counts as one dispatch in the case's
  max-dispatch limit.
- **If a dispatch can't be capped, or the case's dispatch limit is reached**, the attempt stops. Not capped is an
  error; over the limit is a fail. A provider that can't hold a cap refuses (:327).
- **After each dispatch**, the reported cost is settled back into the campaign reservation. Unknown cost settles at
  that dispatch's full cap. When the campaign ends, what is left of its reservation is released.

**Worst case per campaign:**

| Case kind | Max dispatches, at a $0.75 cap each |
|---|---|
| builds and stop-and-ask | plan + build = 2 |
| repair | 3 |
| planner | 1 |
| lead answers | 2 lead requests |
| lead flows | 3 lead requests |

Over 25 cases × 3 that is about 165 dispatches ≈ **$124**, plus replacements ≈ **$130 reserved**. A $200 ceiling
therefore admits one campaign at a time, never two.

**Expected per campaign:** 75 attempts × $0.30–0.45 = **$22.50–$33.75**.

**Wall time:** about 75 attempts × about 3–4 minutes ÷ 2 at once ≈ **2–2.5 hours**, in the background, never inside a
release.

---

## Part D. Reviewer evals

1. **The pin.** A project setting `review model` = **provider + exact model id** (**Decision 7**). It requires a person's
   proof to change. `buildReviewPass` uses it over the route and agent defaults (src/build-review.ts:252-259).
   `build_review.reviewer_model` records the init event's exact id. If the reported model differs from the pin, that
   review is **not evaluated under the pin** and is never compared.
2. **Labels.** `evals/reviewer/<id>/`: `diff.patch`, the files the review needs, and `labels.json`.
   - About 15 buggy diffs come from Codex-round findings with fix commits, and from `build_review` HIGH findings that
     were sent back and fixed. Their fixed counterparts serve as clean diffs where possible. The other clean diffs are
     ones a person checked.
   - **Every label is validated by a person** (`validatedBy` in labels.json; the folder needs a person under finding 10).
   - Labels never enter the reviewer's workspace: only the patch and files are copied in.
3. **Same context as production.** Build-review's brief and patch preparation (:137, `REVIEW_PATCH_NAME`) are extracted
   into one exported `reviewContextOf(...)` that both production and the eval call. Each invocation is capped (about
   $0.60 via `maxBudgetUsd`). Production review stays uncapped as it is today.
4. **Scoring.** 3 attempts per diff.
   - A HIGH finding at the labelled file and within ±8 lines is a **proxy hit**.
   - Every finding (with its scenario sentence) is kept for a person to adjudicate on the report page. An adjudication
     replaces the proxy.
   - The report shows per-attempt recall and false-alarm rate, which is production's one-shot behaviour, and beside it
     majority-of-3 repeatability.
   - A change of 2 diffs or fewer out of 15 reads "no clear change".
5. It holds nothing. It informs the pin.

Cost: 30 diffs × 3 × about $0.32 (measured Opus review) ≈ **$29**, at most $54 reserved.

---

## Budget

| Item | Per run (expected) | Reserved worst case | v1 month (on demand) | If weekly is turned on later |
|---|---|---|---|---|
| Eval campaign, 25 × 3 Sonnet | $22.50–$33.75 | about $130 | 2 runs: about $56 | 4.3 runs: about $120 |
| Reviewer evals, 30 × 3 | about $29 | about $54 | 1 run: about $29 | about $29 (when the pin or brief changes) |
| Nightly reads, accounting | $0 | — | $0 | $0 |
| **Total** | | | **about $85** | **about $150** |

If attempts run under a Claude subscription login, they use plan limits rather than API dollars. The report shows that
as subscription usage, separately.

---

## Later (not in v1)

- **Production bloat flags** and cost per finished task across projects.
- **Journey ledger and trend UI.** This needs the release-check contract to carry each attempt, which
  scripts/e2e-parallel.mjs:187-207 discards today. It also needs `modelCalls` treated as CLI invocations. All of it
  would be recorded data, never trusted.
- **Automatic baseline promotion.** It must keep each case's known-good reference, and flaky or error results never
  replace it.
- **Weekly and release-triggered runs**, after measured cost.
- **A small Opus subset** for model-change coverage.
- **Delta-review coverage in sealAutoGreen.** Codex rounds are out-of-band, so it needs a person-proved review record.
  Phase 1 F's process note stands meanwhile.
- **Trusted authorization inside publish.yml**, to hold the npm step itself.

Not building: an eval platform, online evals or shadow deploys, simulated users, judge councils, LLM-graded outcomes,
VM isolation.

## Schema

| Version | Slice | Tables / columns |
|---|---|---|
| v139 | A1 | `nightly_lane` (lane_id, repo, workflow, display_name, retired_at, retired_by, retired_proof); `nightly_lane_alias` (repo, lane_id, name, by, proof, at); `github_nightly_cursor` (repo, page_cursor, last_ok_at, last_why); `github_nightly_watch` (repo, gh_run, created_at, attempts_read, finished, last_checked_at); `nightly_lane_job` (repo, lane_id, gh_run, attempt, job_id, sha, started_at, completed_at, conclusion, cause; unique (repo, gh_run, attempt, job_id)); `nightly_lane_failure` (id, repo, lane_id, job ref, sha, opened_at, cleared_at, cleared_by_job, closed_why); `nightly_exemption` (task, candidate, failure_id, pr, gh_run, attempt, job_id, started_at, completed_at, read_at; unique (task, candidate, failure_id)). Kept apart from `main_check_failure`, whose `run` is a Toolroll run id, NOT NULL |
| v140 | B1 | `run.model_reported`; `chat_turn.model_reported`, `provider_turns`, `reported_cost_usd` (all nullable: null = not reported; `chat_turn.cache_read_tokens` and `cache_write_tokens` already exist from v129, see Build notes) |
| v141 | C1, C2 | `eval_campaign` (id, canonical, manifest_digest, build_digest, version, baseline_campaign, k, admitted_at, finished_at, state, settled_at); `eval_attempt` (id, campaign, case_id, case_version, n, replaces, outcome, error_why, model_pinned, model_reported, api_microusd, subscription_microusd, usage_unknown, turns, tokens_in, cache_read, cache_write, tokens_out, tool_calls, wall_ms; unique (campaign, case_id, n, replaces)); `eval_invocation` (attempt, kind, world_ref, reserved_microusd, settled_microusd, unknown); `eval_spend_month` (month, ceiling_microusd, reserved_microusd, settled_microusd); `eval_baseline_pin` (campaign, by, proof, at, accepted_worse_json); `eval_debt` (id, case_id, case_version, campaign, baseline_campaign, opened_at, cleared_at, cleared_by_campaign, waived_by, waived_proof, waived_why) |
| v142 | D1 | `build_review.reviewer_model`; `reviewer_eval_attempt` (id, campaign, diff_id, diff_version, n, provider, model_pinned, model_reported, findings_json, proxy_hits_json, adjudication_json, api_microusd, subscription_microusd) |

Each version is additive, with a `src/migration-v1NN-*.test.ts` and an `UPDATE_SAFE_MIGRATIONS` entry.

## Slices (ordered; each ships alone)

Tests are kept to the kinds docs/testing.md:228- allows: security and attack tests, accounting, migrations and
contracts. There are no copy or markup matrices. Fix rounds run only the affected files.

### A1. Ingest GitHub's nightly (v139)
- **New module** src/nightly-github.ts:
  - reader: cursor, every attempt, bounded deadline
  - binding, cause classification (aggregate from shards), stable lanes and aliases
  - settlement: open and clear
- **Hooks**:
  - `refreshGithubNightlies` at the end of src/operate.ts, called from `followUpChecks`
  - opted-in repos added to `refreshTrustedMains`
  - store functions at the end of src/store.ts
  - `--github`, `--lane-alias`, `--lane-retire` in src/release-cli.ts
- **Tests** (src/nightly-github.test.ts, fake gh):
  - a failure followed by a cancelled run is still open
  - a failed earlier attempt with a passing later attempt is still open
  - a completed failed job in a running workflow is ingested
  - a same-run re-run doesn't clear; the next run clears
  - "Every shard ran the whole suite" failing with every shard green opens debt (the coverage-verifier regression case)
  - "Every shard passed" failing with zero failed shards opens debt; with every failed shard before-tests it doesn't
  - a re-run of a 20-day-old nightly that fails is ingested; one past 30 days isn't
  - a running nightly stays watched past 30 days until it finishes
  - a backlog over 10 pages is worked through across reads, never refused whole
  - an unreadable cause is a failure
  - the paging cursor stays before a truncated page
- **Attacks** (test/attacks/nightly-github-binding.test.ts): a branch dispatch, a fork, `nightly.yml@x.yml`, a lookalike
  name, a head not on main, the attempt changing mid-read.
- **Targeted:** those two files, `src/migration-v139-*.test.ts`, src/password-freshness.test.ts.

### A2. Hold every boundary
- **Calls into the module from:**
  - `deploymentGate`
  - scripts/deploy-candidate.mjs (through the installed runtime's exported function, as it does `liveReleaseOf`)
  - the merge reservation transaction
  - the pre-tag check before `createTag`
  - `sealAutoGreen`
- **Adds** `readLaneJobs` (the exemption reader), stored exemptions, and the 20 s bounded boundary read.
- **Tests** (src/nightly-github.test.ts and src/release.slow.test.ts):
  - a person-approved deploy is held
  - an exemption needs a job started after the failure
  - a re-run that is pending or failed voids the exemption
  - an unreadable re-read isn't permission
  - merge is held inside the transaction
  - pre-merge exemption stands at the tag; new post-merge debt waits at the tag
  - an unreadable read warns and keeps recorded debt
- **Targeted:** those files, src/deploy-gate.test.ts, password-freshness.

### A3. Words
- **Changes:** Needs-you items (GitHub debt and the existing `main_check_failure` debt), release-card lines, notification.
- **Tests:** one data-level test that open debt yields one Needs-you item and that an exemption shows on the card's
  view model. No markup tests.
- **Targeted:** that file.

### B1. Accounting gaps (v140)
- **Changes:** `run.model_reported` and `chat_turn.model_reported` / `reported_cost_usd`, recorded from the init and
  result events.
- **Tests:** streamed and buffered subscription chat and the direct lead path keep model, turns, cost and cache tokens, with null for unreported; API vs subscription vs unknown are kept apart; `usageOf` normalization for
  the eval collector; migration.
- **Targeted:** src/subscription-chat.test.ts, src/provider*.test.ts, `src/migration-v140-*.test.ts`.

### C1. Runner, oracle, packaging, budget, first 10 cases (v141)
- **New code:** src/evals.ts (campaign, attempt child process, collector, reservations) and src/eval-oracle.ts (oracle
  harness).
- **Files:** `evals/` (manifest + 10 cases) added to package.json `files`; the provider gate ported into src; policy
  paths added to `autoPathProblem`.
- **CLI:** `toolroll evals run|attempt` at the end of src/operate.ts.
- **Tests:**
  - the oracle refuses an early exit
  - an edited launcher or import can't pass
  - a symlinked input path is refused
  - the oracle runs only after the process group is gone
  - a crash or timeout is a fail and a world-start failure is an error
  - reservations refuse admission over the ceiling and settle unknown cost at the full cap
  - every lead request is capped and counted against the case's dispatch limit
  - dispatch reservations are carved from the campaign's, never added to the month twice
  - reviewer campaigns use the same ledger
  - a build change mid-campaign leaves it incomplete
  - policy paths, including src/reviewer-evals.ts, need a person
  - a candidate that removes or moves a listed enforcement hook call, or edits the manifest, needs a person
  - a package-contents test: `evals/` is in the tarball

  All of these run on a scripted provider: no spend.
- **Targeted:** src/evals.test.ts, src/eval-oracle.test.ts, src/release-auto.test.ts, password-freshness.

### C2. Campaigns, baseline pin, report, debt, last 15 cases (v141)
- **Changes:** canonical vs diagnostic campaigns, atomic settlement order, statuses, comparison, the
  `toolroll evals baseline` pin, `eval_debt` + waiver, Needs-you item, report page.
- **Tests:**
  - only complete canonical campaigns settle
  - a late older campaign settles nothing
  - 3/3 → 1/3 → 0/3 against the pin is regressed
  - error and unevaluated never clear
  - clearing needs 2 passes
  - a case edit doesn't clear
  - the pin needs a person and `--accept-worse`
- **Targeted:** src/evals-report.test.ts.

### D1. Reviewer evals and the pin (v142)
- **Changes:** `reviewContextOf` extracted from build-review, the provider + exact model pin, `reviewer_model`, the
  reviewer eval runner (capped), scoring with adjudication, 30 person-validated diffs.
- **Tests:**
  - production and eval use the same context function
  - a model mismatch is unevaluated
  - labels never reach the workspace
  - per-attempt and majority scoring
- **Targeted:** src/build-review.test.ts, src/reviewer-evals.test.ts, `src/migration-v142-*.test.ts`.

Codex: one round per pair (A1–A3, B1–C1, C2–D1), at most two each.

## Open decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| 1 | Stale (36 h) or unreadable GitHub nightly | **Warning**; recorded debt stays enforced; the observation gap is shown |
| 2 | What open nightly lane debt holds | **Every deploy, the merge and pre-tag authorization** of opted-in projects, unless the candidate re-ran that lane after the failure and passed. Post-tag publication is not covered (disclosed) |
| 3 | Eval model | **Sonnet**, pinned as provider + exact model |
| 4 | When evals run | **On demand** first; weekly only after two measured campaigns; release-triggered runs later |
| 5 | What eval debt holds | **Automatic approval only**, dormant while auto-approval stays refused; never deploy, merge or tag |
| 6 | Baseline | **An owner-pinned campaign id**, with a password; no automatic promotion in v1 |
| 7 | Reviewer model | **Pin provider + exact model**; a mismatch is not evaluated |
| 8 | Monthly ceiling | **$200** of API dollars, reservation-backed (admits one campaign at a time) |
| 9 | Delta-review coverage | **Later** |

## Review round 1 (Codex, NO-GO): what changed

Each claim was checked against the code. All 16 findings are accepted. One part of finding 12 is narrowed.

| # | Finding | Verdict | Where closed |
|---|---|---|---|
| 1 | GitHub success isn't independent; auto-approval already refused | **Accepted.** Verified src/release-adapters.ts:381-383, :875-876 | "Trust, stated plainly"; eval gate called dormant |
| 2 | Copied hidden tests don't protect the grader | **Accepted** | Part C "Grading": oracle outside the fence, nonce answers, O_NOFOLLOW, process group proven gone |
| 3 | Newest-run-only reading loses debt | **Accepted** | Part A cursor, every attempt, completed failed jobs ingested early, nothing erases |
| 4 | 2 h freshness; person-approved deploys and trusted-main refresh uncovered | **Accepted.** Verified src/scope.ts:1942 `applies: false`, src/deploy-gate.ts:41, src/nightly-check.ts:99-103 | Hold in `deploymentGate`/deploy-candidate independent of authority; checked in the transaction; 20 s boundary read; limitation stated; opted-in repos refreshed |
| 5 | `CheckRun` lacks attempt and times; no stored exemption | **Accepted.** Verified src/release.ts:106-118 | `readLaneJobs`, `nightly_exemption` per task + candidate + failure, re-read at each boundary |
| 6 | Publish step is after the tag; post-merge rerun trap | **Accepted.** Verified src/release.ts:1227, publish.yml:16, release-proof.mjs:91 | Pre-tag authorization; post-tag race and post-merge recovery stated |
| 7 | An error cleared debt | **Accepted** | Clearing needs a complete canonical campaign, ≥2 passes, no error or unevaluated; crashes and timeouts are fails |
| 8 | Automatic baseline normalizes a regression | **Accepted** | Owner-pinned campaign id, frozen per campaign, no promotion in v1 |
| 9 | Partial or concurrent runs | **Accepted** | Canonical vs diagnostic, sealed at admission, unique attempts, atomic ordered settlement |
| 10 | Policy in `src/` stays auto-shippable | **Accepted.** Verified src/release-auto.ts:198-213 | Policy paths added to `autoPathProblem`; append-only called an application invariant |
| 11 | Aggregate-lane cause; renamed lanes | **Accepted.** Verified ci.yml:111 | Aggregate cause from shards in the same attempt; stable lane ids; person-approved alias or retire |
| 12 | Chat turns, subscription cost and model, token normalization | **Accepted, narrowed:** subscription chat does read the exact model (src/subscription-chat.ts:276) but never stores or returns it, so the fix is to persist, not to read | Part B: world per attempt, `chat_turn` columns, three amounts kept apart, `usageOf` |
| 13 | 13 journeys, wrong runner citation, retry merging | **Accepted.** Counted 7 + 6; verified release-check.mjs:622, e2e-parallel.mjs:187-207, scripted-provider.mjs:190 | Facts corrected; journey ledger moved to Later with the contract requirement |
| 14 | Cap and arithmetic | **Accepted.** 75 × $0.30–0.45 = $22.50–33.75 (revision 1 said "about $30") | Reservation-backed ceiling, per-invocation caps, worst case $117 (now $130, see round 2), one campaign at a time, admission paused during deploys, 20 s / 60 s read deadlines |
| 15 | Reviewer scoring and labels | **Accepted** | Person-validated labels, fixed counterparts, labels kept out, proxy hits + adjudication, per-attempt rates, provider + exact model pin, shared `reviewContextOf` |
| 16 | Packaging; concurrent `world()`; v1 too big | **Accepted.** Verified package.json `files`, e2e-kit.mjs:260-286 | `evals/` packaged, gate ported to src, a child process per attempt; v1 cut to A + B + C + D; tests limited per docs/testing.md |

## Review round 2 (Codex, GO-with-changes): what changed

11 findings closed. 5 partial findings and one new high issue are folded in here.

| # | Round 2 finding | Change |
|---|---|---|
| 3 | A creation-time cursor with a 48 h overlap misses re-runs of older runs; a big backlog was refused | A 30-day watch list of run ids (GitHub's re-run horizon) is re-read for new attempts. Unfinished runs stay watched past 30 days. Paging resumes across reads instead of refusing. Tests added to A1 |
| 10 | `src/reviewer-evals.ts` and the enforcement call sites were still auto-shippable | `src/reviewer-evals.ts` is added. A hook manifest proves every enforcement call is still present, so removing or moving one (or editing the manifest) needs a person. Test added to C1 |
| 11 + new high | "Every shard ran the whole suite" can fail with every shard green, and "every failed shard before tests" is vacuously true with zero failed shards | Coverage-verifier failures always open debt. "Every shard passed" is suppressed only on a positively established, non-empty chain of readable before-tests shard failures. The exact regression case is added to A1 |
| 12 | Subscription cache usage, provider turns and model were dropped (src/subscription-chat.ts:184; `LeadProviderAnswer` at src/converse.ts:436) | Both streamed and buffered chat and the direct lead path carry model, turns, reported cost and cache tokens, with null when not reported. They are persisted on `chat_turn` (v140) |
| 14 | Lead requests bypass `invokeAgent` (src/lead.ts:543); reservations could double-count | Every provider dispatch, lead requests included, is capped, counted in the case's dispatch limit, and carved from the campaign reservation. Reviewer campaigns use the same ledger. Worst case per campaign is now about $130 |


## Build notes

Where the build took the safer or more concrete reading of this plan, recorded as it was built.

**A1 (v139).**
- The opt-in is a person's row in the plane's own action ledger (`github nightly debt on`: the recorded remote's URL,
  its record, the owner/name, the person and their proof), like the nightly check's approval; the schema above has no
  table for it. A changed recorded remote stops reading ("turn it on again"); recorded debt still holds.
- Schema detail beyond the table above: `github_nightly_cursor.last_tried_at` (the background read's claim, so two
  processes never read the same project at once, at most every 30 minutes), `nightly_lane.seeded_at`,
  `nightly_lane_job.read_at`, and the failure's job reference spelled out as `gh_run`, `attempt`, `job_id` and its
  `completed_at`. A failing job GitHub gives no completion time is recorded as completed when read (only a later pass
  clears it).
- The paging cursor resumes with GitHub's `created<=` filter on the oldest run of the last whole page (GitHub answers
  at most 1000 runs to one filtered listing, so page numbers alone can't resume a backlog). Listing stops at runs older
  than 40 days, which can no longer be unfinished.
- A run whose commit the plane can't yet place on main (main not read lately, the commit not fetched yet, or a read of
  main older than the run) stays on the watch list unread until it can, whatever its age. A run is dropped as "not on
  main" only when it is finished and a read of main made after the run was created doesn't contain it (security scan
  of A1: a stale read of main must never drop a run whose commit landed later).
- `failedBeforeTests` moved to src/github-jobs.ts (re-exported from src/release-adapters.ts) so the nightly reader
  shares it without loading the release adapters.
- Lanes: a job resolves through a person's alias first (newest for that name), then the lane seeded under that name.
  An alias is refused for any name another live lane answers to, or a required check's name another lane owns,
  whatever its debt (security scan of A1). So when a required check is renamed in REQUIRED_PR_CHECKS, the new name is
  seeded as its own lane on the next read, and the old lane's open debt ends only by a later pass or by a person
  retiring the old lane (allowed once no required check names it). A retired lane whose name becomes required again
  is opened again.

**A2.**
- Every stored check is `nightlyDebtHold` (src/nightly-github.ts): the deployment gate (src/deploy-gate.ts), the
  installed runtime's deploy check (scripts/deploy-candidate.mjs, through the installed `nightly-github.js`; a runtime
  too old to have it refuses while any lane failure is open), the deploy and merge reservations and their start
  (`releaseNightlyProblem` at the end of src/store.ts, called inside `reserveRelease` and `runReleaseOperation`), and
  `sealAutoGreen` (dormant). The coordinator's deploy, merge and pre-tag steps call `nightlyBoundary` through the
  store adapter: one bounded read (about two thirds of 20 s for the nightly, the rest for the candidate's own CI),
  plain exec, then the stored debt.
- An exemption counts in a stored check only while its boundary re-read is under 10 minutes old (`EXEMPTION_FRESH_MS`),
  so a deploy run by hand with no coordinator read in front of it is held by any open failure. A boundary whose
  re-read can't be read holds that failure at that boundary whatever is stored; a re-read that shows a different or
  pending newest run or attempt, or a failure, deletes the exemption.
- Exemptions are made only at the deploy and merge boundaries; at the tag one made before the merge is re-read, never
  made (the release proof refuses jobs finished after the merge).
- "Candidate contains the failed commit" is GitHub's own comparison (`compare`), read by the plane's gh.
- Words name the time of the failure in UTC ("Oct 30, 06:17 UTC"); a task no release covers says "This candidate" and
  its way out is tonight's nightly or a dispatch of Nightly on main.
- An exemption also needs the lane's workflow file and the CI scripts the workflows call (`LANE_PINNED_FILES`:
  scripts/ci-shards.mjs, ci-scope.mjs, ci-git.sh, ci-no-skips.mjs) to be the same Git blob on the candidate as at the
  failed commit, by GitHub's contents API (security scan of A2: the candidate controls its own workflow, so a job
  merely named like the lane proves nothing if it rewrote what the job runs). A changed or unreadable file is no
  exemption, and the words say the release's own CI can't stand in. There is no waiver path in v1; the hold lasts
  until a main nightly passes the lane. The tests themselves and package.json stay the candidate's, as for every
  required check.

**A3.**
- Needs you uses the plain words "Nightly checks failed: <lane>" with "On main at abc1234. Releases wait until it passes
  again." and links to the failed job on GitHub (the repository the plane recorded at opt-in). The plane's own nightly
  check of main gets one item per failed check (its open items summed up, linking to its task) rather than one per
  failed test, so a red nightly with many failing tests is one item.
- The release card's GitHub lines are status, not signed terms: they are shown on the console card and the chat card
  but are not part of the card digest.
- The notice `github-nightly-failed` (attention) is sent when a failure is first recorded, once per failure.

**Codex round 1 on A1–A3 (NO-GO, 8 findings, all fixed).**
1. "Not on main" is now proven only: `verifiedFirstParentAncestry` (src/commit-extract.ts) says "no" only after reading
   and verifying every commit back to the root without meeting the run's (itself readable) commit; a missing or
   unreadable object, the walk's limit or the deadline is "unknown", the run stays watched and the read says so.
2. Lane jobs and failures keep their run's creation time (`run_created_at`, in the unreleased v139 tables); a failure
   clears only by a pass in a run created after the failed run, started after the failure completed, on a commit
   that contains it. A rerun of an older run never clears newer debt.
3. A failed re-read now takes the stored exemption away (its read time is set to one no stored check accepts; the row
   stays so a later whole re-read, the tag's included, can restore it). A deploy started by hand reads again first:
   scripts/deploy-browser.mjs calls the installed runtime's `refreshNightlyForDeploy` (the same bounded read as the
   coordinator's) before the stored check.
4. The watch list rotates strictly by the oldest check (never-checked first), so unfinished runs can't starve a
   finished run whose rerun is waiting.
5. A read that leaves anything unresolved (a run not yet placed on main, a backlog still to list, settlement left for
   later) records why and keeps the last whole read's time: the warning stays until a whole read.
6. Local history work is bounded by the read's deadline on the wall clock: every git call of the ancestry walk is
   limited by what is left (at most 10 s each; `GitRunner.timeoutMs`), and settlement stops at the deadline and
   resumes on the next read.
7. Opt-in, alias and retire re-check the person's standing and account generation inside their own transaction;
   opt-in reads the recorded remote there too.
8. The failure notice names its project (`source: { project }`) and links to the board, so a project's chats may
   deliver it.

**Codex round 2 on A1–A3 (1, 2, 4, 8 closed; residuals of 3, 5, 6, 7 fixed).**
- 3: `deploymentCandidate` counts an exemption only when this deployment re-read it (`nightlyRefreshed`, set by
  scripts/deploy-browser.mjs only after the installed `refreshNightlyForDeploy` ran without throwing). An installed
  runtime without it, a refresh that threw, or any other caller: debt only, every open failure holds.
- 5: settlement keeps ancestry three-state (`MainHistory.mainContains` answers yes/no/unknown); an unreadable or
  timed-out ancestry, or the deadline passing between candidates, leaves the read incomplete with its reason, so the
  last whole read's time stays and the warning shows.
- 6: the deadline is absolute and goes down to every git subprocess: `GitRunner.deadline` → teardown-git.ts
  `viewedGitSync({ deadline })`, which works out each subprocess's limit (setup calls of the git view included) from
  what is left as it starts, refuses to start one past it, and fails a read that ended past it;
  `verifiedFirstParentAncestry` never answers yes or no past the deadline. The once-per-process `--no-lazy-fetch`
  probe (5 s, cached) is left as it is.
- 7: opt-in, alias and retire now check the password inside their own transaction (`provePerson` runs under the lock
  with the write), so neither a revocation nor a credential rotation can land between the proof and the change.

**B1 (v140).**
- `chat_turn.cache_read_tokens` and `cache_write_tokens` already exist (v129), so v140 adds only `run.model_reported`
  and `chat_turn.model_reported`, `provider_turns` and `reported_cost_usd` (all nullable, saved rows NULL). The
  subscription chat now fills the v129 cache columns too (it reported none before).
- `chat_turn` is one row per provider request (a lead turn's steps are its rows), so each row keeps its own request's
  report and nothing is summed there; a sum over a turn or an attempt is the collector's (C1), unknown if any part is.
- The readings live in the new src/reported-usage.ts: a model id is printable ASCII without spaces, at most 200
  characters, or unknown (never trimmed into another id). Claude: the session's own `system`/`init` model (a subagent's
  never counts); inits that disagree leave it unknown, never chosen; with no init naming one (the buffered
  `--output-format json` chat, legacy fixtures) the result's `modelUsage` counts only when it names exactly one model.
  Turns are the result's `num_turns`, cost its `total_cost_usd`, tokens `usageOf`'s cache-aware split (input = input +
  cache read + cache write when all three are reported, else the plain count as before). Codex `exec --json` reports no
  model, turns or cost (unknown); its cache reads are `cached_input_tokens`, its cache writes unknown. The direct API
  path reads the response body's `model`; OpenRouter's `usage.cost` is its reported cost (a null cost stays unknown,
  where `Number(null)` would have read 0); Anthropic reports none. Fleet chat's `chat_turn` rows get the same.
- A subscription's reported cost goes only to `reportedCostUsd` / `reported_cost_usd`, never `reportedCostMicrousd`,
  which stays API money (lead settlement reads it).
- A resumed turn that adds to its run's usage (a review resume) adds its model too: unknown if either turn's is, the
  model when they agree, otherwise every model named, sorted and joined by " + " (never equal to one model, so a pinned
  comparison reads it as a mismatch).
- `runAccounting` and `chatTurnAccounting` (end of src/store.ts) are the collector's reads: the reported fields, the
  normalized tokens, and the amount kept as API dollars (billing `api-key` with a reported or priced spend; an API chat's
  settled charge), subscription usage (the provider's reported cost of subscription work; null when unreported), or
  unknown (no billing, unpriced, or a chat request with unknown spend). They are never added together.
- Not covered, and unknown: a failed chat request keeps no report (the harness's answer is never parsed when the
  request fails); Codex, Gemini and ACP runs report no exact model, so a run on them is never evaluated under a pin.
