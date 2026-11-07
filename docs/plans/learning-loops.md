# Learning loops: lesson notes from failed checks, flaky tests, small current memory — plan

Status: plan, revision 3, 2026-11-05. Branch `learning-loops` (worktree `so-learning`) from main `3da1dcfa` (0.9.91).
Scope: issue #228 (loop 4 of roadmap #231) plus its "keep project memory small and current" comment. Lands **after**
the results-routing arc (`docs/plans/results-routing.md`, schema v148) and builds on it; this arc's schema is **v149**.
Slices 1-5 built (slice 1 in #315). Product copy follows `plain-words.ts`: "build #N", "Clean up", "test result". Codex round 1 (NO-GO, 14 findings), Alex's decisions and Codex round 2 (GO-WITH-CHANGES, 1 partial + 7
items) are folded in; see the review sections at the end.

## What this arc ships

**Observe first, rules later** (Alex, 2026-11-05). This arc records what Toolroll already sees and shows it to people;
it changes no check outcome and adds no automatic rerun.

1. **Flaky tests list**: tests with *mixed outcomes under recorded conditions* (failed and passed with the same tree,
   command and recorded environment), from Toolroll's local checks and from GitHub CI job attempts, with history.
   Advisory only. Rerunning stays the existing explicit `task regate`.
2. **Lesson notes**: when a check failure is followed by a revision whose check passed the same tests with explicit
   evidence, Toolroll proposes a note — "`<test>` failed in run #F; it passed in revision R, which changed `<files>`".
   Not a claim that R caused it. A person edits and accepts it as a project decision through the existing proposal flow.
   Then Toolroll reports how often that test fails afterwards.
3. **"Last included in a run"** on lessons, knowledge references and decisions, and a **tidy-up pass** that proposes
   retiring, merging or settling memory entries, with explicit restore. Nothing changes until a person accepts.

Automatic rerun rules are **later** (see "Later: rerun rules").

## Facts (main 3da1dcfa)

Paths under `src/` unless shown.

**Schema**
- `SCHEMA_VERSION = 147` (store.ts:1169). Results-routing takes v148 (results-routing.md L349-363): `run.exec_class`
  (`model|infrastructure`, missing reads `model`, a failed check is model-class, L93-102), `task_ref.revision_origin`
  (`person|automatic-review|flow|lead|machine`, L104-116). Not implemented yet. This plan uses both and redefines neither.
- Update-safe registration: `UPDATE_SAFE_MIGRATIONS` (store.ts), `HISTORY_RULES` (toolroll-update.ts:400).

**Checks and what they prove**
- `run_check`: one row per run — status, exit_code, `suites_json` (≤ 8 `{name,status,exitCode}`), `release` (strict
  mode, not purpose; store.ts:16789) (store.ts:975-990, :1023-1028). No tree, command or environment. Writer
  `recordRunCheck`, first write wins (store.ts:16777-16794).
- The check runs in `runVerification` (builder.ts:2721-2759); log sealed as `check-log` (builder.ts:2954); receipt
  sealed by `sealVerificationReceipt` (builder.ts:2967; run, head, base, scope digest, command, result, log binding:
  verification-evidence.ts:45-61); `recordRunCheck` (builder.ts:2986). The receipt's result is plane-written.
- **Reports are candidate-written.** The Full check of a prepared candidate (release, nightly; builder.ts:2706) reads
  per-test lines the candidate's harness writes (test/release-reporter.ts:35-55, scripts/release-check.mjs:264-283,
  sealed as "release check report v1", check-report.ts:33). check-failure.ts:15-19: nothing the candidate writes — its
  output, its report — may allow a rerun; the report only chooses among blocking classes. `buildReport` keeps passing
  identities only when watched (release-check.mjs:275; handshake `watch`, contracts/release-check.ts:170).
- Ordinary builds: no per-test record; `failingTestsOf` parses `FAIL` lines from the log, failures only, file level
  (gate-failure.ts:31-46). Absence of `FAIL` proves neither that a test ran nor that it still exists.
- Identities (contracts/release-check.ts:175-185): `unit:<file>::<name>`, `file:<file>`,
  `group:<script>:<kind>:<group>`, `journey:<script>:<kind>:<group>::<journey>`, `upgrade:<version>`, `part:<part>`.
- Environment: `checkContextOf` records node, platform, arch, lockfile, harness digest, grant, access
  (check-report.ts:102-104) — selected fields; the check also inherits `PATH`, `HOME`, `LANG`, `LC_*`, `TZ`, `TERM` and
  others (`SETUP_ENV_ALLOWLIST`, builder.ts:439-442). Trees are read through verified objects (`treeFactsOf`,
  `readVerifiedCommit`, `verifiedTreeEntries`, check-report.ts:83-90).

**Repairs, revisions, reruns**
- `maybeTriggerRepair` returns at once for automatic calls (dispose.ts:642-646: "no automatic follow-up spends"); the
  slow-test regate below it (dispose.ts:715-731) is therefore not reached automatically either. Repairs and revisions
  are explicit actions now. `repair_chain` (store.ts:4931-4945) and `maybeSettleRepairChain` (dispose.ts:498-504)
  remain; `run.role='repair'` is a park-payload mend, not a check repair (store.ts:4122-4127).
- `regateTask` (dispose.ts:536) takes `operator`, `mode` or `release` approval; ordinary regating proposes and seals a
  new candidate scope (dispose.ts:599). `task regate` is the person's rerun (surface.ts:308, operate.ts:4633).
  `builderAttemptsAt` counts finished runs of one task at one exact head (store.ts:13155).
- Release reruns: only plane-confirmed infrastructure failures (check-failure.ts:249), capped
  `INFRA_RERUNS_PER_INCIDENT = 1`, `INFRA_RERUNS_PER_CANDIDATE = 2` (release.ts:139-140); `check.retried` means retries
  *inside* one check (check-failure.ts:94-138); `sealAutoGreen` refuses a retry-assisted pass (release-auto.ts:382-418).
- Journey groups retry once outside releases (scripts/e2e-parallel.mjs:46-61, :164-211); release checks turn scripted
  retries off (release-check.mjs:163-174). No Vitest `retry` (vitest.config.ts).
- Eval rules unchanged: unknown failures block, agent behaviour never rerun-to-pass (eval-harness.md:42-59); nightly
  reruns never clear (evals-nightly.md:209-217); eval-case flaky status (C2) not built (evals-nightly.md:976).
- GitHub CI: Toolroll never reruns. The release reader (release-adapters.ts:1050-1068) returns check ids, names,
  suites and workflows — no workflow-run id or attempt number. The nightly's exact-attempt reader does:
  `readAttemptJobs(get, slug, run, attempt, sha)` (nightly-github.ts:420-445) returns every job of one exact attempt or
  null when any page can't be read whole; `readRun` (:411). Stable lane key: `laneIdOf(workflow, name)` and
  `resolveLane` with person aliases (nightly-github.ts:110-131, table `nightly_lane`). `failedBeforeTests`
  (github-jobs.ts:17-24). `ci_check` has no attempt column (store.ts:1511); `branch_check_run` holds completed push
  runs with their run ids (store.ts:1474).
- Report size: `buildReport` keeps every case of a watched file (release-check.mjs:265-266); a report over 256 KiB is
  dropped whole (`reportLine`, release-check.mjs:314-316); a missing report makes a Full check unavailable
  (`fullCheckProblem`, check-report.ts:320).
- Deletion today: no code deletes `run` rows (no `DELETE FROM run` in `src/`). Removing a project deletes only its
  `project` row; "its tasks, results and settings stay" (`forgetProject`, store.ts:20657-20660). The storage sweep
  prunes only its own history (storage-sweep.ts:254).
- The gallery flow "Flaky test hunter" offers to skip a test (flow-gallery.ts:255). This plan does not link it.

**Project memory**
- Lessons: `project_lesson` (proposed/adopted/disabled, `version`, `reviewer NOT NULL`), `learning_event`,
  `learning_snapshot` with a timestamp, `learning_policy` (off by default) (store-baseline.ts:2054-2085). New proposals
  only from reviewer output, which stopped being asked for (4ed2f887). Delivery needs byte-identical paths
  (`learningFingerprint`, project-learning.ts:184-192). A disabled lesson can't be adopted again (project-learning.ts:407).
  `learningContext` snapshots lesson id and version (:481-484).
- Knowledge: `knowledge_snapshot(run, repo, identity, payload, sha)` — no timestamp (store-baseline.ts:2094);
  written by `knowledgeContext` (project-knowledge.ts:218, :249). With no `project_knowledge` row the selection is
  empty, **decisions included** (project-knowledge.ts:236-239). Decisions are ranked and capped at 8 per run
  (`decisionLines`, project-memory.ts:173-180) and snapshotted as `{id, claim, decidedAt}` — no revision (:177).
- Decisions: `project_decision` (active/superseded/retired, one `supersedes`, `source_kind` conversation/task/result/
  manual/backward-pass), `decision_change` immutable, no delete (store-baseline.ts:2102-2119). `recordDecision`
  supersedes at most one (project-memory.ts:117); `retireDecision` (:153); there is no restore.
- Memory pass: `memory_proposal` kinds `instruction-add|instruction-remove|decision-add` (store-baseline.ts:2136);
  `decideProposal` is the one writer (memory-pass.ts:352); stale when the surface changes — and the surface is
  instructions + decisions only, not references or lessons (`memorySurface`, memory-pass.ts:156-161).
- Surfaces: `memory review`, `memory apply <id> --decision accept|reject` (memory-cli.ts:28-31); `/settings/knowledge`
  (settings.ts:550-576, proposals knowledge-ui.ts:96, POST route-table.ts:569); `/settings/learning` (route-table.ts:432).
- Person proof: `personProof` (person-proof.ts:9-25). The memory lead-token gap (finding 6) is being fixed on branch
  `memory-lead-gate` — slice 0 **shipped separately**; this arc's writers use the proof it carries into the
  transactional writer. Local owner: `LOCAL_OWNER_ACTS` (local-owner.ts:26) and `LOCAL_POSTS` (route-table.ts:144).
- Protection: `eval-hooks.ts` proves a call is present in a function, not that it runs (`if (false)` passes,
  eval-hooks.ts:14-22). Pins resolve only top-level functions and `Class#method` (`pinnedText`, :277-281); a pin the
  base can't resolve is silently skipped (:305). `storeRewriteProblem` (:417) scans for constructs that replace pinned
  Store methods — it is not a SQL-write scan. Release-auto path policy (`autoPathProblem`, release-auto.ts:206-226)
  sends a change to listed paths to a person.
- The check's capture point: `runVerification` is a nested arrow function (builder.ts:2731) inside the top-level
  `settleProof` (builder.ts:2511-3057), which also calls `store.recordRunCheck` (builder.ts:2986).

## Foundation: check facts (recorded, never trusted for authority)

One writer, `src/check-facts.ts`, at disposition, after the receipt is sealed. It never changes the check's outcome.

- **Recorded conditions**: commit; **tree** read through `readVerifiedCommit` (never raw `rev-parse` on the checkout);
  approved command digest; access; harness digest and lockfile from `treeFactsOf`; and the **environment captured at
  execution** — `checkContextOf`'s fields plus the values of every `SETUP_ENV_ALLOWLIST` variable — hashed as
  `conditions_digest`, with a readable class `<platform>-<arch>-node<major>`. Captured by `captureCheckConditions`
  (in `check-facts.ts`), called from `runVerification` (builder.ts:2731) when the command starts, held in memory and
  passed to `recordCheckFacts`, which `settleProof` calls right after `store.recordRunCheck` (builder.ts:2986). Not
  re-read later.
- **Results per identity**, each tagged with its **source**:
  - `receipt` — plane-written whole-check result (passed/failed, exit code). Trusted for "the check passed/failed".
  - `report` — the sealed candidate-written report's case lines. Advisory.
  - `log` — `failingTestsOf` on the sealed log, failures only. Advisory.
  - `learn` — the advisory learning lines (below). Advisory.
  A check that failed for something with no identity (typecheck, build, unexplained) records `part:` or `unexplained`.
  A check with several failures records all of them; the blocking failure is the check's, unchanged.
- **Explicit execution evidence** for a case = a `report` or `learn` line naming that exact identity `passed` or
  `failed`. Nothing else (no `FAIL` absence, no overall pass) counts as "this test ran". An explicit `skipped` line is
  recorded as skipped. No line at all is **"No execution evidence recorded"** — never read as skipped, removed or passed.

### Advisory learning results (separate from gate evidence)

The report's `watch` list and size are gate evidence and stay exactly as they are. Learning never adds to them.

- **Request**: the handshake gets a separate optional field `learn: string[]` — exact case identities only
  (`unit:…::…`, `journey:…::…`), at most 200. Harnesses that don't know it ignore it; nothing else changes.
- **Transport**: the harness prints at most one line `TOOLROLL-LEARN <json>` before the report line, holding only the
  requested identities that ran, each `passed|failed|skipped` (no whole-file expansion), capped at 64 KiB. It is never
  part of the report; `buildReport`, `reportLine` and `fullCheckProblem` don't read it.
- **Reading**: the plane parses it from the sealed log after the check is settled. Missing, malformed, over the cap or
  with the wrong nonce → the learning lines are dropped and the run records `learn: not recorded (<why>)`. That loses
  learning evidence only: the check's report, receipt, verdict and availability can't change because of it.
- A test proves it: a harness that floods `TOOLROLL-LEARN` past the cap still gets the same report, the same
  `fullCheckProblem` answer and the same verdict as without the line.

### Tracked identities (persistent, bounded)

`learning_watch(repo, identity, reason note|observation, since, until NULL)`: identities in an accepted lesson note
(until the note is retired) and identities with a local observation in the last 90 days. At most 200 per repo; past
that, the oldest-observed are left out and counted as a coverage gap. Every Full check with a handshake asks `learn`
for all of them, whether or not the run received any decision. Coverage gaps are reported, not hidden: "reported by 31
of 43 checks; 12 checks had no per-test reporting (ordinary builds, or learning lines not recorded)".

## Flaky tests (advisory)

### Mixed outcomes under recorded conditions

A **local observation** for identity X: X recorded `failed` in one check and `passed` (explicit execution evidence) in
another, or `passed` on a retry inside one check (journey groups outside releases), with **equal tree, command digest,
access, harness digest and conditions digest**. Sources: `task regate` on the same head, two runs that checked the same
tree, in-check retries. A file-level X (`file:`) is observed only as "failed, then the whole check passed" and is labelled
"file-level, not confirmed per test".

A **CI observation** (read-only, `src/flaky-ci.ts`): for a workflow run Toolroll already knows by id — the watched
branch's push runs in `branch_check_run` and the nightly's runs — with `run_attempt > 1`, read attempts n−1 and n with
the exact-attempt reader `readAttemptJobs` (nightly-github.ts:420), each bound to the run id, attempt and head SHA it
returns. Pairing, per lane:
- the **lane key** is `resolveLane(store, repo, workflow, job.name)` (nightly-github.ts:127), else
  `laneIdOf(workflow, job.name)` (:111) — separate from both job ids, which differ per attempt;
- exactly one job per lane key in each attempt; both attempts read whole (the reader returns null otherwise); same run
  id and head SHA; earlier conclusion `failure` and not `failedBeforeTests` (github-jobs.ts:17), later `success`;
- anything else — a duplicate lane name, a missing attempt, a cancelled or skipped job, a SHA mismatch — is
  **rejected** and counted as "not paired", never guessed.
Both jobs' ids, attempts and conclusions are stored. Lane-level only, never mixed with local pairs, no test name (logs
aren't fetched). PR runs aren't read in this arc: Toolroll records no run id for them.

Never observations: `exec_class='infrastructure'`; `unexplained`; typecheck/build/`part:`; real-model journeys and eval
cases; nightly in-run reruns. Selected by the task's purpose (release/nightly purpose on its scope), not by
`run_check.release`.

Words everywhere: **"Mixed outcomes under recorded conditions"** — never "flaky, safe to rerun". The list says what was
recorded and what wasn't (e.g. network, other processes, time of day).

### The list

`/projects/<id>/flaky` (desktop and phone) and `toolroll flaky list|show [--repo] [--json]`:
- one row per identity (or CI lane): observations in 90 days, last seen, conditions classes, hard failures (failed under
  the same conditions with no pass), source labels (report/log/receipt/GitHub), test file last changed;
- history per row: each observation with both runs (or CI run and attempts), commit, conditions class;
- status: `mixed outcomes`, or `no failures since its file changed` (20 distinct runs with explicit evidence of passing
  since); when the needed history is older than what is kept, it says "not enough recorded history", never a zero;
- the only action: "Make a task to fix it", which files an ordinary task with a brief to make the test reliable and says
  never to skip or delete it (a person approves it as usual). Rerun stays `task regate`.

Observations never change a check's outcome, a release verdict or any approval.

## Lesson notes ("passed in revision R")

### When a note is proposed

All must hold, checked by `src/lesson-notes.ts`:
1. **F** is a builder run whose check failed (receipt), `exec_class='model'`, with ≥ 1 failed identity with explicit
   execution evidence (report). File-level-only failures get no note in this arc.
2. **R** is the newest builder run of a revision of F's task (`revision_of`, any `revision_origin`) or of F's explicit
   repair draft (`repair_chain.source_run = F`), or the next Full check of the same release generation; R's head
   descends from F's (verified commit walk).
3. R's check passed (receipt) with the same command digest and access as F.
4. Every failed identity of F has an explicit `passed` line in R's report or learning lines. To make that possible, F's
   failed identities join R's advisory `learn` request (never the gate's `watch`) when R's check has a handshake;
   otherwise there is no note.
5. **No retry-assisted pass**: none of those identities passed on a retry inside R, and `check.retried` is empty.
6. None has a local observation (mixed outcomes) at F's tree.
7. Otherwise no note, and the task page says exactly what was recorded:
   - an explicit `skipped` line → "`<identity>` was skipped in revision R";
   - the test file is absent from R's verified tree → "The test file `<file>` is not in revision R";
   - no line at all → "No execution evidence recorded for `<identity>` in revision R" (never "removed").

### What it says

- Template, facts only: "`<identity>` failed in run #F (`<commit>`, `<class>`). It passed in revision R (run #R).
  R changed: `<files>`." Every test and harness file R changed is listed under "Tests and harness changed" — never
  hidden. The first failure line from the log is quoted (clipped 160 chars, secret-scanned, escaped) as output.
- Stored as a `memory_proposal` `decision-add` plus a `lesson_note` row with the facts. The person must write or edit
  the claim (the draft is pre-filled; the Accept button names who accepts). Accept → `recordDecision`,
  `source_kind='result'`, `source_ref='lesson-note:<id>'`. Reject → remembered by fingerprint (`memory_rejection`).
- One pending note per (repo, identity set).

### Afterwards (no causal claim)

On the accepted decision, over **eligible executions** — distinct `(run, identity)` pairs with explicit execution
evidence, from the note's tracked identities (`learning_watch`, asked in every Full check whether or not the run got
the decision) — show failures / executions, split into **runs that received this decision** (its id in the run's
knowledge snapshot) and runs that didn't, with **mixed-outcome failures** counted separately and **coverage** stated.
Example: "Since Nov 5: failed 1 of 31 runs of this test (0 of 18 that received this note; 1 of 13 that didn't). 2 more
failures had mixed outcomes. 12 checks since had no per-test reporting." No accepted-versus-rejected comparison, no
"helped" wording. The tree/conditions dedupe is only for observations, never for these counts.

**Durable tallies, so retention never rewrites history**: `lesson_note_tally(note, month, executions, failures,
mixed_failures, received_executions, received_failures, unreported_checks)` is incremented by the same writer in the
same transaction that records each check's results, and is never pruned. "Since Nov 5" sums tallies, so it stays true
after the raw rows behind it are pruned. Each tally names its sources (report/learn) in the row. Where a tally can't be
complete (written before v149, or a month with a recording failure) it is marked partial and shown as "partial".

## Project memory: last included, tidy-up

### Last included in a run

- **Decision-only context**: `knowledgeContext` includes decisions when the project has decisions but no knowledge row
  (fixes project-knowledge.ts:236-239).
- **Versioned snapshots**: bump `KNOWLEDGE_SELECTION_VERSION`; new snapshots carry `capturedAt` and each decision's
  `revision`. Old snapshots keep their fields as they are; readers accept both versions.
- `memory_use(run, kind, item, version NULL, phase, included_at NULL)` — one row per lesson, reference and decision in a
  run's snapshot, written in the same transaction as the `learning_snapshot` and `knowledge_snapshot` inserts.
  Backfill from existing sha-verified snapshots: lesson rows take the snapshot's own timestamp and version; knowledge
  rows from old snapshots get `version NULL, included_at NULL` — nothing inferred.
- Shown as **"Last included in a run: #4410, Nov 3 · 41 runs"**; for backfilled rows "run #2210 (time not recorded)";
  "Not included yet". On `/settings/learning`, `/settings/knowledge`, and `memory status`. Lead chat contexts aren't
  snapshotted and aren't counted; the page says "counted in runs".

### Tidy-up pass

Proposes; never changes. Scheduled after a quiet period (no runs for 24 h, at most weekly, ≥ 10 entries) —
deterministic only. On demand ("Tidy up" button, `memory tidy`) it may also ask the memory pass's model analyzer for
contradictions (D4).

| Kind | Found by | Accept does (one transaction) |
|---|---|---|
| Retire unused | not included in 60 days while ≥ 20 runs got context | `retireDecision` / `changeKnowledge` dropping the reference / lesson `disable` |
| Merge duplicates | same normalized text (scheduled); model (on demand) | new `mergeDecisions(ids, claim, why)`: one new decision; every old one `superseded` with a `decision_change` "merged into #N" row; `decision_merge` rows list all of them |
| Contradiction | model, on demand only | nothing by default: the person picks which stays, keeps both, or writes a new one |
| Note keeps failing | an accepted lesson note's test failed in ≥ 3 eligible executions since (from tallies) | flags it to rewrite or retire; no default |

- Every proposal binds **every affected item** by kind, id, revision/version and sha (`items_json`). Accept re-reads
  each; any change → stale ("Changed since proposed; run Tidy up again"). Not the instructions/decisions surface alone.
- **Successor chain** of a decision D: every decision reachable from D through ordinary supersession
  (`project_decision.supersedes`) and not-undone merges (`decision_merge` predecessor → successor), transitively.
  Example: merge A+B→C, then C+D→E: A's chain is C, E.
- **Restore** `restoreDecision(D)` (`memory-tidy.ts`): computes D's chain and its **active tail** (the active
  decisions in it). With no active tail: D → active, one `decision_change` row. With an active tail (E above): refused,
  unless the person reviews the **expanded change** — the screen lists every affected decision (D, each chain member,
  the active tail) with its revision and status, and the person picks what happens to the tail (retire it, or keep both
  active). The accept binds every listed item's id, revision and status; one transaction compare-and-sets each; any
  difference → stale, nothing changes.
- **Unmerge** `unmergeDecisions(M)`: allowed directly only when M's successor S is active, at the revision recorded at
  merge time, and is not itself a predecessor in another merge or superseded. Then: S → retired ("unmerged"), each
  predecessor → active, `decision_merge.undone_at` set, `decision_change` rows for all — one transaction, every item
  bound. If S was edited or merged on (nested), it's refused unless the person reviews the expanded change as for
  restore (which then also names the later merge). **Repeat unmerge** of an undone M is refused "This merge was
  already undone on <date>" and changes nothing; merging the same decisions again creates a new merge id.
- Lessons: a new `readopt` action (disabled → adopted, re-checks support, bound to the lesson's version and sha).
  References: restored by re-adding from history as a new knowledge revision, bound to the current revision.
  Each restore sits next to the item in history.
- Every change goes through `changeKnowledge` / `recordDecision` / `retireDecision` / `changeLearning` / the new
  functions, so it keeps its revision.

## Who does what

| Act | Who | Proof |
|---|---|---|
| Record check facts, observations, usage; propose notes and tidy-ups | Toolroll (`system:learning`) at disposition / snapshot / pass | no CLI, route, lead or MCP writer exists |
| Draft contradiction pairs | the memory pass analyzer, on a person's request | data inside a proposal |
| Accept, reject, edit a note or tidy-up; restore | a person with the approver role | proof from `memory-lead-gate` carried into the writer; lead/remote refused; revoked or stale approver refused |
| Same, by the laptop's local owner | allowed (D3) | added to both `LOCAL_OWNER_ACTS` and `LOCAL_POSTS` |
| "Make a task to fix it" | a person | ordinary task approval |

## CLI and web (same words)

- `toolroll flaky list|show <identity> [--repo] [--json]` — read only.
- `toolroll memory review` lists "Lesson note" and "Tidy-up" proposals; `memory apply <id> --decision accept|reject
  [--claim "…"]`; `memory tidy [--repo]`; `memory restore <decision>`; `memory status` shows "Last included".
- Web: project → **Flaky tests**; `/settings/knowledge` → "Proposed changes" (notes with facts and an editable claim;
  tidy-ups with every affected item), "Last included" column, "Tidy up", "Restore" in history; `/settings/learning` →
  "Last included". Empty, stale and failure states have their own words (see journeys).

## Safety

- **No authority from candidate output.** Reports and logs are advisory; only the plane-written receipt says passed or
  failed. Nothing in this arc allows a rerun, changes a verdict or approves anything.
- **Agents can write tests**: a random test only creates advisory observations; a note needs explicit per-test evidence,
  rejects retry-assisted passes, lists every test/harness change, and a person writes or edits the claim.
- **No self-setup changes**: notes and tidy-ups change nothing until a person accepts; the lead has no tool for them.
- **Protection** — slice 1 deliverables, each with bypass tests:
  1. **Whole-file path protection** in the release-auto path policy (`autoPathProblem`, release-auto.ts:206-226) for
     the policy modules `check-facts.ts`, `flaky.ts`, `flaky-ci.ts`, `lesson-notes.ts`, `memory-use.ts`,
     `memory-tidy.ts`: any change needs a person. Bypass tests: a candidate editing, renaming or deleting each one is
     refused automatic approval.
  2. **Top-level pins** (supported today, `pinnedText` eval-hooks.ts:277): `knowledgeContext`
     (project-knowledge.ts:218), `learningContext` (project-learning.ts:425), `decideProposal` (memory-pass.ts:352),
     `recordDecision` (project-memory.ts:117), `retireDecision` (:153). These are also added to a new **strict** list:
     a strict pin the base can't resolve is a problem, not skipped (today's skip is eval-hooks.ts:305).
  3. **Checker extension for nested functions** (explicit, in `eval-hooks.ts`): a pin form `outer>inner` resolves a
     `const inner = (…) => …` or `function inner` declared once, never reassigned, directly inside the top-level
     `outer`, with the same binding rules as today's pins. Used for `settleProof>runVerification` (builder.ts:2511,
     :2731), strict. Plus an `EVAL_HOOKS` entry: `settleProof` calls `recordCheckFacts` (presence only — the header's
     limit is stated, so this is backed by test 5).
  4. **Off-module write scan** `learningWriteProblem` (new, `eval-hooks.ts`, beside `storeRewriteProblem`): every
     changed JS/TS file other than the owning module (and the v149 migration in `store.ts`) is parsed; a string literal,
     template or `+` concatenation whose static parts contain `INSERT`, `UPDATE`, `DELETE`, `REPLACE` or `DROP` together
     with a protected table name is a new construct (counted by its text's sha256 against the base, as
     `storeRewriteProblem` does) that needs a person. Protected tables and their only writers: the v149 tables →
     their policy module; `decision_merge` and merge/restore writes to `project_decision` / `decision_change` →
     `memory-tidy.ts` and `project-memory.ts`; `learning_watch` → `lesson-notes.ts` and `flaky.ts`. Bypass tests:
     literal, template, concatenation, a table name split across a template expression (flagged as unreadable
     construct), `handle.exec`, a renamed `prepare`. Like the hooks, this raises the bar for review, not proof: a
     person reviewing changes to these files remains the backstop.
  5. **Runtime tests** that the guarantees hold, not just the text: every settled check has a `check_fact` row; a
     flooded `TOOLROLL-LEARN` line can't change a verdict; merge/restore/unmerge write only through `memory-tidy.ts`
     (a test lists every SQL write site to these tables in `src/` and fails on a new one).
- **Fail closed**: unreadable tree, missing conditions or identity → no observation, no note, no usage row.
- **Untrusted text** (test names, failure lines) is escaped, clipped, secret-scanned; it reaches a prompt only inside a
  decision a person accepted and edited.

## Schema v149 (new tables only, update-safe)

```
check_fact(run PK → run, repo, task_ref, head, tree, command_digest, access, harness_digest, lockfile,
           conditions_digest, conditions_class, purpose, learn_state recorded|not-recorded|not-asked, learn_why,
           recorded_at)
check_result(run → check_fact, identity, state failed|passed|skipped|passed-on-retry,
             source receipt|report|log|learn, recorded_at, PK(run, identity, source))
local_observation(id, repo, identity, failed_run → run, passed_run → run, tree, conditions_digest,
                  kind regate|same-tree|in-check-retry, observed_at, UNIQUE(identity, failed_run, passed_run))
ci_flaky_observation(id, repo, provider 'github', repository, workflow, lane_id, lane_name, workflow_run_id, head_sha,
                     failed_attempt, failed_job_id, failed_conclusion, passed_attempt, passed_job_id,
                     passed_conclusion, observed_at,
                     UNIQUE(provider, repository, workflow_run_id, lane_id, failed_attempt, passed_attempt))
ci_pairing_rejected(provider, repository, workflow_run_id, attempt, lane_id NULL, why, at,
                    PK(provider, repository, workflow_run_id, attempt, why))
learning_watch(repo, identity, reason note|observation, source_ref, since, until NULL, PK(repo, identity, reason, source_ref))
lesson_note(proposal PK → memory_proposal, repo, failed_run → run, passing_run → run, repair_chain NULL,
            revision_origin, identities_json, changed_paths_json, test_files_changed_json, facts_digest, created_at)
lesson_note_tally(note → lesson_note, month, executions, failures, mixed_failures, received_executions,
                  received_failures, unreported_checks, sources_json, partial 0|1, PK(note, month))
memory_use(run → run, repo, kind lesson|reference|decision, item, version NULL, phase, included_at NULL,
           PK(run, kind, item))
memory_tidy_proposal(id, repo, kind retire|merge|contradiction|note-failing|restore|unmerge, items_json, after_text,
                     rationale, evidence_json, source usage|duplicate|model|note|person, status
                     pending|accepted|rejected|stale, created_at, decided_by, decided_proof, decided_at)
decision_merge(merge, successor → project_decision, successor_revision, predecessor → project_decision,
               predecessor_revision, at, by, undone_at NULL, undone_by NULL, PK(merge, predecessor))
```

- **Deletion follows today's semantics** (runs are never deleted; removing a project keeps its tasks, results and
  settings, store.ts:20657-20660). New tables are keyed by repo path, with no FK to `project`: removing a project leaves
  them, and re-adding the same path shows them again, as with tasks. FKs to `run` are plain `REFERENCES` with no
  `ON DELETE` action — no cascade is claimed or needed.
- Per table: `check_fact`, `lesson_note`, `lesson_note_tally`, `memory_use`, `memory_tidy_proposal`, `decision_merge`,
  `learning_watch` — kept, never deleted (no-UPDATE triggers except the columns their one writer sets: `until`,
  `undone_at`/`undone_by`, tally counters, proposal status). `check_result`, `local_observation`,
  `ci_flaky_observation`, `ci_pairing_rejected` — pruned after 180 days by a new step in the storage sweep
  (storage-sweep.ts), the only `DELETE` on them; tallies are written before rows can age out. Tested through the actual
  sweep path, including that a pruned month still shows the same "since" numbers and the list says "not enough recorded
  history" where a window reaches past what is kept.
- Dedupe: observations count distinct `(identity, tree, conditions_digest)`; executions count distinct
  `(run, identity)`; CI by the unique key above.
- Registered in `UPDATE_SAFE_MIGRATIONS` and `HISTORY_RULES`; `migration-v149-learning-loops.test.ts`: fresh,
  v148→v149, interrupted and re-run, update rehearsal. All DDL in slice 1.

## Slices

Slice 0 (memory lead-token gap) shipped separately on `memory-lead-gate`. Each slice ships alone with unit, store and
scripted journey tests (fake checks, no model), desktop 1440×900 and phone 390×844 shots including empty, stale and
failure states.

1. **Check facts and protection** — all v149 DDL; `captureCheckConditions` / `recordCheckFacts`; the `learn` request,
   `TOOLROLL-LEARN` line in `scripts/release-check.mjs` and its plane-side reader; `learning_watch` for observations;
   all five protection deliverables above with their bypass tests. Tests: each source; several failures in one check;
   unreadable tree → nothing; conditions differing by one env var → different digest; explicit skip vs no evidence;
   flooded or malformed learning line → same report and verdict, `learn_state=not-recorded`; immutability; migration.
   Attack tests (inside the sandbox): a candidate printing fake `FAIL`, report or learning lines changes only advisory
   rows, never `run_check`, a verdict or an approval.
2. **Flaky tests list** (after 1) — local and CI observations, list and history, CLI, "Make a task to fix it", the
   retention step. Concurrency test: two dispositions racing on the same pair → one row. CI tests: duplicate lane name,
   unreadable attempt, SHA mismatch, cancelled job, failure before tests → rejected with reason. Journey
   `flaky-journey.mjs`: fail then pass on `task regate` at the same tree → listed; a different env var → not; typecheck
   + test failure → test listed, check still failed; GitHub attempt 1 failed / 2 passed → lane row; empty state "No
   mixed outcomes recorded"; a window past retention → "not enough recorded history".
3. **Last included** (after 1, for DDL only) — decision-only context, versioned snapshots, `memory_use`, backfill,
   pages and CLI. Journey: two runs → counts match snapshots; an old snapshot shows "time not recorded".
4. **Lesson notes** (after 2 and 3: needs observations for rule 6 and usage for the split) — detection, `learn`
   requests for R and note watches, proposal, edit-then-accept, tallies and the "afterwards" numbers. Tests: each rule
   1-7 (skip, absent file and no evidence give their own words); retry-assisted pass rejected; changed harness listed;
   rejection remembered; runs without per-test reporting counted as coverage gaps; executions counted once per
   `(run, identity)`; lead/remote/revoked approver refused. Journey: a release check fails a case → a revision passes it
   with learning evidence → note → person edits and accepts → the next run's snapshot carries it → a later failure shows
   in the split, and the numbers survive a retention prune.
5. **Tidy-up** (after 3 and 4) — scheduled deterministic pass, on-demand model contradictions, binding of every item,
   `mergeDecisions` / `unmergeDecisions` / `restoreDecision` / lesson `readopt`, local-owner allowlists. Tests: A+B→C
   then C+D→E, restore A → refused without expanded review, accepted with it (E retired or kept, as chosen); unmerge of
   C+D→E after E was edited → refused without expanded review; repeat unmerge → refused, nothing changes; ordinary
   supersession chain handled the same. Journey: unused decision → retire → restore; two duplicates → merge → unmerge;
   a contradiction with no choice can't be accepted; an item edited after proposing → stale.

## Later: rerun rules (not designed here)

Automatic reruns come back only when all of these exist:
- Toolroll records per-test results itself — a plane-owned reporter outside the candidate tree, results on a channel
  the candidate can't write — so a rule never rests on candidate-written output (check-failure.ts:15-19).
- Exact test cases only (`unit:…::…`, `journey:…::…`), never `file:`; a trusted classification of security tests by
  content, not file name (containment, credentials, release authority, process cleanup; journeys included).
- A dispatch authority for "rerun this exact check" that changes no profile, fence, grant or scope, revalidated in the
  transaction and at dispatch, with atomic idempotent budget reservations keyed to the approved candidate and shared by
  every rerun road.
- Release semantics kept: infra-only release reruns, `check.retried` meaning in-check retries, cross-run provenance
  sealed separately, a person still approving.
- Bindings to the test's dependencies, helpers, reporter, config and command, not only its file.

## Decisions (Alex, 2026-11-05)

- Observe first, rules later (above). Rerun stays `task regate`.
- **D1** lesson notes become project decisions via the proposal flow.
- **D3** the local owner may accept notes and tidy-ups.
- **D4** the model is used in tidy-up only on demand; the scheduled pass is deterministic.
- **D5** GitHub CI job attempts are listed, read-only, never rules.
- D2 (file-level rules) is moot.

No open decisions. Defaults that can change before their slice: 90-day list window, 180-day retention, 20 runs for "no
failures since", 60 days / 20 runs for "unused", 3 eligible failures for "note keeps failing".

## The examples

| Test | What this arc records |
|---|---|
| Phone keyboard journey's fixed 100 ms wait (scripts/workspace-chat-proof.mjs:247) | Nothing automatically: it's a standalone proof script, not part of a Toolroll check. If it is ever run inside a check, its group shows as `group:<script>:<kind>:<group>`. |
| live-terminal.test.ts "a child started during the close is caught too" (src/live-terminal.test.ts:200) | Skipped inside the plane's fence (`skipIf(INSIDE_FENCE)`), so only GitHub CI sees it: a lane row such as `github:ci.yml/node 24 · macos-latest`. |
| acp-gateway.slow "cancel mid-prompt" (src/acp-gateway.slow.test.ts:238) | GitHub CI lane row; locally `unit:src/acp-gateway.slow.test.ts::<full name>` if a release check reports it with mixed outcomes. |
| storage-sweep-process.slow (src/storage-sweep-process.slow.test.ts:53) | Skipped inside the fence; GitHub CI lane row only. |

## Review round 1 (Codex, NO-GO, 14 findings)

| # | Finding | Resolution |
|---|---|---|
| 1 | Sealed output isn't trustworthy; mixed failures | Reports/logs advisory and source-tagged; only the receipt is trusted; all failures in a check recorded; the blocking failure unchanged; no automatic action |
| 2 | File rules / never list can't protect | Out of scope (rules later; exact cases and content-based security classification listed as preconditions) |
| 3 | "No change" overstated; raw rev-parse | "Mixed outcomes under recorded conditions"; conditions captured at execution incl. allowlisted env; verified-object tree reads |
| 4 | Automatic repair/regate hook retired; counter not a budget | Facts corrected (dispose.ts:642-646); automatic journey removed; reservations listed as a precondition for later |
| 5 | No dispatch authority for rule reruns | Out of scope; listed as a precondition |
| 6 | Slice 0 needs shared person proof | Shipped separately on `memory-lead-gate`; this arc's writers use that proof |
| 7 | Release integration incomplete | Out of scope; release semantics preserved; observations excluded by purpose, not `run_check.release` |
| 8 | Manifest can't enforce guarantees | Whole-file protection of policy modules, pinned caller bodies, bypass tests per guarantee |
| 9 | "Fixed" not establishable | "Passed in revision R"; explicit per-case evidence via the watch list; retry-assisted passes rejected; all test/harness changes listed |
| 10 | Recurrence not effectiveness | Eligible executions only; split by received/not; mixed-outcome failures separate; no causal or accepted-vs-rejected claim |
| 11 | Delivery/usage claims | Decision-only context; versioned snapshots with revision and time; backfill infers nothing; "Last included in a run" |
| 12 | Tidy-up relies on missing capabilities | Every affected item bound; explicit atomic merge/unmerge, restore, readopt; contradictions need a person's choice |
| 13 | Schema/slices unfinished | Typed CI provenance table; FKs and retention without delete triggers; dedupe; corrected slice order; attack, concurrency and desktop/phone journeys |
| 14 | Examples, scope | Identity formats from contracts/release-check.ts; standalone and fence-skipped examples corrected; hunter flow not linked; scope reduced |

## Review round 2 (Codex, GO-WITH-CHANGES)

Round 1 items 1, 3, 4, 11, 14 closed; 2, 5, 6, 7 out of scope by Alex's decision; 8, 10, 12, 13 partial through the
items below; 9 partial, closed here.

| Item | Resolution |
|---|---|
| Partial 9 — missing evidence read as "skipped or removed" | Explicit `skipped` line, test file absent from R's verified tree, and "No execution evidence recorded" are three separate outcomes with their own words (lesson rule 7; foundation) |
| 1 — protection not executable | Five slice-1 deliverables: whole-file path protection; top-level pins on supported functions, strict; explicit `outer>inner` checker extension for `settleProof>runVerification`; new `learningWriteProblem` off-module SQL-write scan naming every protected table and its only writers, merge/restore included; runtime tests. Bypass tests for each |
| 2 — watch additions could void a check | Separate `learn` handshake field and `TOOLROLL-LEARN` line, exact cases only, ≤ 200 identities, ≤ 64 KiB; the gate's `watch`, report and `fullCheckProblem` untouched; overflow drops learning evidence only, with a test |
| 3 — watch coverage ends at R | Persistent bounded `learning_watch` (notes + observations, ≤ 200 per repo) asked by every Full check regardless of delivery; coverage gaps shown; executions counted by distinct `(run, identity)` |
| 4 — restore past an active replacement | Successor chain over ordinary and merge supersession; active tail found; refusal unless the person reviews the expanded change; every affected item's revision and status bound and compare-and-set in one transaction; nested unmerge refused without expanded review; repeat unmerge defined |
| 5 — CI provenance not available | Uses `readAttemptJobs` / `readRun` (nightly-github.ts:411-445) on runs with known ids; lane key `resolveLane` / `laneIdOf`, separate from job ids; both jobs and outcomes stored; ambiguous or incomplete pairings rejected and recorded with a reason; read-only; PR runs out of scope |
| 6 — retention changes "since acceptance" | Durable `lesson_note_tally` per note and month, written before rows can be pruned, never pruned, partial months marked; windows past kept history say so, never zero |
| 7 — cascade claim wrong | Today's semantics kept (runs never deleted; project removal keeps results); no FK to `project`, no `ON DELETE` on `run` FKs; per-table keep/prune list; prune only by the storage-sweep step, tested on the real sweep path |
