# Results-driven model routing — plan

Status: **v2** (2026-11-05). Branch `results-routing`, off main 3da1dcfa (0.9.91). Issue #227, learning loop 1 of
roadmap #231. Nothing in `src/` changes with this document.

- v1 was NO-GO in Codex round 1 (12 findings; the ledger is at the end). The main errors:
  - actor names were treated as proof of who accepted a result;
  - a missing check excluded a run, which can hide failures;
  - results were settled once, too early;
  - the rule's effect was wider than its evidence;
  - automatic going-back had no authority;
  - only the scorer was protected.
- Alex's decisions (final): trials **yes**, each trial task still approved by a person; going back **automatic**;
  **per project** only; **large tasks not in v1**.

## What and why

Alex, inspired by agentrun's promote/demote-by-receipts: "make tasks more deterministic with cheaper models".

- Toolroll keeps a **result record** for each finished task, built only from its own records.
- When a cheaper model has done as well on a project's small or routine tasks, Toolroll **suggests** it. A person
  accepts with a proof. Every task is still approved as today, and the route is sealed into the approval.
- When results drop, the suggestion **switches itself off**, under authority the person granted when accepting.

Lesson kept from run-efficiency v1: every fact here names the column it comes from. Anything that is not recorded is
shown as **not counted, with the reason**. It is never counted as good, and never as 0.

## Facts the design stands on (verified at 3da1dcfa)

Paths are under `src/`.

| Fact | Where | What it does NOT prove |
|---|---|---|
| Model the route named, per run, and its phase | `run_route` (store.ts:3394), written once in `startRun` (:15642); holds `route_digest`, not the route | The run's size or eligibility. The scope can be re-filed later (`refileScope`, store.ts:8900, keeps the old approval, which goes stale) |
| Model the provider reported | `run.model_reported` (v140, store.ts:1445; `recordRunModelReported` :25589) | **Claude only.** Other providers leave it null (provider.ts:199). For Claude it is the session's init model (reported-usage.ts:64), not every model that contributed |
| Cost | `runAmountOf` (reported-usage.ts:98): API, subscription or unknown per run; `run_spend` | One task can mix all three kinds |
| How a run ended | `run.outcome`/`reason` (`finishRun`, store.ts:15996); the tick stores **normalized** failure classes (dispose.ts:372); `run.terminal_class` is a structural stamp (store.ts:16354, e.g. auth-expired, claim.ts:1191) | A timeout or agent failure ends **before** any check is recorded (builder.ts:1934 vs :2986) |
| Check result | `run_check.status` (`recordRunCheck`, store.ts:16777); later follow-up checks change the **effective** result without rewriting it (`assignmentChecksForRun`, assignment.ts:138) | |
| Who accepted the result | completion `action_ledger` row (`COMPLETION_ACTION`, result-completion.ts:10). `detail` is `proof person` or `proof machine` (:90–91), bound to the receipt digest of the exact result run (assignment.ts:500–521) | `operator:` can carry `proof machine`. `system:landed` also completes **without merging** (youiyoux-intake.ts:715) |
| Merge | `merge_intent.state='merged'` with `authority_basis`; `publication.remote_state` (store.ts:4392, :4736) | |
| Who asked for changes | revision task (`task_ref.revision_of`); notes in `diff_comment.author` | Automatic review files revisions under a hands-off **mode signer's** name (build-review.ts:124) |
| Automatic build review | still runs (operate.ts:3746). `build_review.state` is reviewed / not-reviewed / pending; HIGH findings are in `findings_json` | `not-reviewed` is not "no findings". Only the separate per-task reviewer route was removed (`task route --phase review` refuses, operate.ts:10763) |
| Results wait for a person | a ready result waits for a separate completion (assignment.ts:325) | Waiting is not failing |
| Routine builder fallback | large, risky or strict work builds on the **routine** row when no strong row exists (phase-routing.ts:379); small work does the same when no light row exists | A routine-row change can reach excluded work |
| Protected work | `protectedResultProblem` (store.ts:9669) reads actual changed files, but returns null when approval is sufficient | Null does not mean "unprotected" |
| Settings writes | `applyModelChoices` (model-choices.ts:316) re-proves a live operator inside the transaction (:337–344) and validates the result (`checkScope`, :271) | There is no settings generation; `stateDigest` is value-only |
| CLI `models` | dispatch passes only an actor **name** (operate.ts:1549) | Proof method and generation are lost |
| Local owner | `LOCAL_OWNER_ACTS` (local-owner.ts:26) is an allowlist; Models changes are not on it | |
| Policy protection | `EVAL_POLICY` paths (release-auto.ts:192); `eval-hooks.ts` pins callers and store bodies | Product `src/` ships automatically otherwise (release-auto.ts:206) |
| Migrations | a current-version file runs no DDL (store.ts:5548); update rehearsal follows `HISTORY_RULES` added columns (toolroll-update.ts:433) | |

Reused, not duplicated: `tier-report.ts` (`toolroll spend` by tier), `spend-report.ts` `spendRows`, `runAmountOf`.

## Cohort and provenance (F5)

Each run's **cohort** is snapshotted when the run starts, in the same transaction as `writeRunRoute`, into
`run_cohort`. It is never changed after. It holds:

- project, sealed size and risky, quality mode;
- an "evidence demands" flag, the publication authority, release / candidate / protected-project flags;
- the build leg's **selection**: configured default, earned rule, trial, person override, or pin;
- the route digest.

A comparison runs **within one cohort**: (project, small or medium, not risky, default quality, no evidence demands,
not automerge, not release, not protected). Models are compared inside it whatever selected them. Selection is shown
as provenance, and pins and overrides count as evidence for the model that ran.

A record belongs to one model only if every builder run of the task family ran on that model, with
`model_reported` equal to the route's model. Otherwise it is "not counted: mixed models" or "not counted: model not
reported". A family is the root task plus its revision tasks, and the record is per root.

## Result record lifecycle (F1–F3)

States: **pending → provisional → mature**, or **rejected**, or **not counted** (with a reason). A record is
re-evaluated whenever its inputs change: a completion row, a follow-up check, a revision, a proof verdict, a merge,
or the task ending. Every evaluation names the policy version.

- **pending**: there is no result yet, or the result waits for review or completion. It never counts as a failure.
- **provisional**: a **person-proof** completion (`detail = proof person`, receipt digest = the result run's), or a
  merge whose `merge_intent` reached `merged` under a person, grant or mode authority. `system:landed` without a merge
  is not acceptance. The **14-day window starts at that acceptance**.
- **mature**: provisional, 14 days passed, no person revision in the family, the effective check result still passed,
  and the proof is not refuted.
- **rejected**, checked in this order, before any not-counted rule:
  1. **execution failures**: two or more failed builder attempts (timeout, no-handoff, agent-reported, no-op,
     commit-failure, check failed);
  2. the task failed or was cancelled after a result;
  3. a HIGH finding from automatic review;
  4. a person revision within the window;
  5. a refuted proof;
  6. the effective check turned failed.
- **not counted** (published with reasons; only after the rejected checks pass):
  - infrastructure, **only on structural evidence**: `terminal_class` auth-expired or exhausted, operator stop or
    interrupt, refused before `provider_started_at`;
  - no check configured;
  - model not reported, or mixed models;
  - a ready result left 30 days without an answer;
  - the cohort is ineligible.

**Person feedback is recorded, not inferred** (F1). The revision write path stamps `task_ref.revision_by` as person,
automatic-review, lead or machine, from trusted context: `currentActor`, `machineActing`, and the `allowMode` path.
It does not use the author name. Only a person revision rejects.

Review signal (F4): "reviewed, no HIGH", "HIGH found" or "not reviewed". "Not reviewed" adds no signal. The cell shows
"reviewed 9 of 15".

Each record keeps separately: API micro-USD (from runs with a known amount), the subscription run count and tokens,
the unknown run count, and the **remediation runs** (revision-family runs included) (F10).

## Earned rules: suggest, accept, switch off (F6, F7)

An accepted suggestion is **not** a change to the owner's Models rows. It is an **earned rule**:

> For this project's **small** (or **routine**) tasks that are not risky, strict, release, protected, automerge, or
> evidence-demanding: build on Haiku 5.5 instead of the configured Sonnet 5.5.

- `recommendRoute` gets one more pure input, `earned`, applied only when the task's cohort matches. Large, risky and
  strict work therefore keeps its configured route even when it falls back to the routine row (F7).
- The leg's reason names the rule, so it is sealed into the digest.
- Pins and person overrides beat the rule.
- Plan and repair rows are never touched; repair follows the build as today.
- Only Claude cells can earn (F4).

**Suggest** when, in the cohort, with records from the last 90 days (newest 20 at most):
- the cheaper model has at least 10 **mature or rejected** records, at least 90% mature, and none of its last 3
  rejected;
- the configured model, when it has 10+ such records, is no more than 5 points better;
- not-counted records are no more than a third of all records (else: "too many results Toolroll couldn't judge");
- both models have a listed price, and the cheaper one is lower on input and on output. Both prices are
  **snapshotted** into the suggestion.

**Accept** is a person-proved Models act through the `applyModelChoices` transaction: the same operator re-proof, the
CSRF guard and step-up, and a ledger entry. It also re-checks eligibility on the spot: still earned, prices unchanged
from the snapshot, configured rows unchanged. If anything changed, it refuses with "this suggestion is out of date,
review it again". The person sees and grants:

> Switch back to the configured model automatically if 2 of the next 5 results are rejected, or fewer than 80% of 10
> mature, or people choose another model on 3 of 10 tasks it was proposed for. This lasts until <accept + 90 days>,
> then asks again.

**Switching off** is a bounded authority, sealed into the rule row at acceptance:
- **who** granted it, with their proof and credential generation;
- **what** it may do, which is one thing: set this rule's state to `switched-off`;
- **when** it lapses: the expiry date.

Because the owner's rows were never changed, "the prior state" is exactly what the configured rows say, row absence
included, and nothing needs restoring.

- **Revision-aware compare-and-set**. A new `models_generation` counter goes up on every `applyModelChoices` write,
  and the rule keeps its own `generation`. Switch-off updates `WHERE id = ? AND generation = ? AND state = 'active'`.
- **Configured rows changed since acceptance** (`models_generation` differs on the rule's slot): the rule
  **pauses** instead of acting, and Needs you asks "You changed models for routine tasks in X since accepting the
  Haiku rule. Keep it or drop it?"
- **Validation re-runs**: `checkScope` must still resolve after switch-off. If it doesn't, the rule pauses and raises
  Needs you; it never leaves routes unresolved.
- **Expiry**: the rule ends and the suggestion is offered again if still earned.

After a switch-off, that model is not suggested for the cohort for 30 days, and only later records count.

## Trials (D1: yes) (F9)

Trials exist because a cheaper model earns records only by running. Sized-by-job already runs Haiku on small tasks,
so small-task evidence exists. Haiku on routine work does not.

- **Offered** when the configured model in a Claude cohort has 10+ records at 90%+ mature: "**Try Haiku 5.5 on the
  next 10 routine tasks**". Starting one is the same person-proved act as accepting.
- **Reservations are atomic.** In the `saveScope` transaction a filing takes a trial position if
  `reserved + consumed < 10`, and writes a `route_exposure` row. A position is **consumed** when an approved trial
  task's builder starts, and **released** when the task is cancelled before building or re-filed off the trial.
- **Never approved automatically, on every path.** `sealScopeApproval` refuses a trial route unless the approval
  basis is a person proof (`password`/`chat` with a person seal, approval-authority.ts:18–25). It refuses mode,
  grant, schedule, carried, auto-check, auto-green and lead. Build admission re-checks the same at dispatch.
- Never on excluded cohorts. Pins and overrides beat it.
- It ends at 10, on the switch-off rule, by hand, or at expiry.

**Exposure is immutable** (F9). Every filing or re-filing where an earned rule or a trial proposed a leg appends one
`route_exposure` row: task, rule, scope digest, proposed model, and its end (approved as proposed, overridden to X,
cancelled, re-filed). The "3 of 10 chose another model" rule reads these rows.

## What the person sees

- **Approval card**: one line beside Agents when the leg came from a rule or a trial. Its surfaces are the approval
  sheet `agentsDetail` (render-tasks.ts:405), the approval step `agentsCeremonyHtml` (:756), the chat side panel
  (render-chat.ts:122) and the text card `describeScope` (scope.ts:1807).

  > **Why this model:** Haiku 5.5 builds routine tasks in this project. 14 of the last 15 similar tasks were
  > accepted with checks passing (3 more not counted: no checks configured). Observed median $0.40 a task, $1.10 on
  > Sonnet 5.5.

  > **Trying a cheaper model:** Haiku 5.5, task 4 of 10. This task waits for your approval. You can pick another
  > model before approving.

  The rule or trial **reason** is sealed. The counts are shown "so far" and are not part of what is approved.
- **Settings → Models**: a **Suggested** group next to "Newer models" (models-ui.ts:148):
  - **Review change** opens a preview with the evidence and the switch-back terms, then saves with step-up.
  - **Start trial**.
  - **Not now** hides it for 30 days.
  - Active rules are listed with **Turn off**; paused rules with **Keep / Drop**.
  - A per-project "Suggest cheaper models" switch.
  - States: empty ("Not enough finished tasks yet: 4 of 10"), stale offer, refused, and long project names.
- **Needs you**: a rule switched off, paused, or about to expire.
- **Chat** (F11): the lead can list suggestions ("suggestions" in chat shows the same counts and an **Open in
  Settings** link) and offer **Not now**. Accept and Start trial happen only in Settings or the CLI.
- **Spend page**, Suggestions block (F10): for each rule, tasks run, mature or rejected counts, and **observed
  median** API dollars per task before and after over matched 90-day windows, with completeness ("API-priced 8 of
  15") and the snapshotted prices. The label is "observed, not a promise". It is hidden below 5 API-priced records a
  side. Plan usage and unknown stay separate, and remediation runs are included.

## Authority for each act (F11)

The CLI carries the same verified authority as `config set` (a `ModelAuthority` with generation, method and live
check), not a name.

| Act | Person (operator, step-up) | Local owner | Lead token / remote API token |
|---|---|---|---|
| accept a rule, start a trial | yes | no (not a settings change it may make) | refused |
| keep a paused rule | yes | no | refused |
| turn off a rule, stop a trial, drop a paused rule | yes | yes (new act `routing-turn-off`: it only returns to configured rows) | refused |
| Not now (dismiss) | yes | yes (new act `dismiss-suggestion`) | refused (chat Not now runs as the chat's person) |
| read results and suggestions | yes | yes | yes, read-only |

```
toolroll models results [--repo <p>] [--json]
toolroll models suggestions [--repo <p>] [--json]
toolroll models accept <id> | try <id> | keep <id> --as <you> --token <t> [--json]
toolroll models off <id> | dismiss <id> --as <you> --token <t> [--json]
toolroll spend [--json]          # gains the Suggestions lines
```

Refusals use stable reason tokens (`stale-suggestion`, `price-changed`, `not-permitted`, `lead-refused`).
`task show` / `task route` print the same evidence line.

## Protecting the measurement and the mutation boundary (F8)

- **Person-only by path** (added to `EVAL_POLICY`, release-auto.ts:192):
  - `src/route-results.ts` (record and cohort rules);
  - `src/route-rules.ts` (suggest, accept checks, switch-off, trial reservations);
  - `src/contracts/route-results.ts`.
- **Pinned bodies and required calls** (a `ROUTING_HOOKS` / `ROUTING_PINNED` manifest checked by the same parser
  as `eval-hooks.ts`):
  - the inputs: `finishRun`, `recordRunCheck`, `writeRunRoute`, the `run_cohort` write in `startRun`,
    `recordRunModelReported`, `recordUsage`, the completion `recordAction` in assignment.ts, the revision stamp in
    `createResultRevision`, and the merge-intent settle;
  - the consumers: the `earned`/trial input in `saveScope`, the trial check in `sealScopeApproval` and admission,
    the settle pass call on the tick, `applyModelChoices`'s generation bump;
  - every store method that writes `route_record`, `route_rule` or `route_exposure`.
- **Attack tests**: a candidate that leaves the scorer untouched but does one of these must need a person:
  - changes `finishRun`'s reason mapping;
  - drops the settle call;
  - renames the trial check's import;
  - writes `route_rule` from a new caller;
  - marks completions `proof person` from a machine path.
- Records read only Toolroll's rows, never worktree files, park payloads, agent reports or lead tool calls.

## Schema: all in slice 1, v148 (F12)

- `run_cohort`: one row per run, immutable.
- `route_record`: one row per root task: cohort, model, state, reasons, the separate cost parts, attempts,
  minutes, policy version, `accepted_at`, `evaluated_at`.
- `route_rule`: offers, rules and trials.
  - repo, cohort, from/to model, kind;
  - state: offered / active / paused / switched-off / dismissed / expired / ended;
  - evidence JSON, price snapshot;
  - the switch-off grant (by, proof, generation, expires);
  - `generation`, `models_generation_at_accept`, trial counts.
- `route_exposure`: append-only.
- `task_ref.revision_by`, `models_state.models_generation`, `project.suggest_models` (default 1).
- `V148_ADDED_COLUMNS` and `HISTORY_RULES` entries; an `UPDATE_SAFE_MIGRATIONS` entry.

Tests cover fresh, upgraded from v147, interrupted and re-run, and update rehearsal (toolroll-update.ts:433). Runs
before v148 have no cohort row and stay not counted ("started before results were recorded").

## Slices (each ships alone, with tests and e2e journeys)

1. **Records, read-only.**
   - What ships: all v148 schema, `run_cohort`, the revision stamp, the lifecycle evaluator, the protection
     manifest, `models results [--json]`, and a "Result record" line in the task's Details.
   - Tests: each state and reason from fixture rows; execution failures are counted before missing-check
     exclusions; `proof machine`, `system:landed` without a merge, and a mode-signer revision are not person acts;
     follow-up checks re-evaluate; mixed models; non-Claude; migration set; the protection attacks.
   - Journeys (desktop and phone): a finished task's record moves pending → provisional → mature; empty state.
2. **Suggestions and earned rules.**
   - What ships: the suggest engine, Settings Suggested, accept with switch-back terms, the `earned` route input,
     switch-off and pause, Needs you, the evidence line on all four surfaces, the CLI, chat list and Not now, and the
     local-owner acts.
   - Tests:
     - threshold edges and the not-counted share;
     - a stale offer, changed prices, changed rows;
     - a large/risky/strict task under a routine rule keeps its configured model;
     - switch-off compare-and-set races (a change away and back again is detected by the generation);
     - pause on a settings change, validation re-run, expiry;
     - authority matrix: lead token, remote token, local owner, revoked generation, Passwordless on and off.
   - Journeys: accept a rule; a new routine task routes to Haiku with the line; an approved task keeps Sonnet; two
     rejected results switch it off, with Needs you; chat and screen show the same counts.
3. **Trials.**
   - What ships: reservations, exposure, the trial reason, the person-only seal and dispatch checks, and
     `models try`.
   - Tests: concurrent filings never exceed 10; cancel and re-file release a position; every approval basis
     other than a person is refused at seal and at dispatch; pins beat trials.
   - Journey: start a trial, a filed task waits for a person, the count moves.
4. **Spend.**
   - What ships: the Suggestions block and `toolroll spend` lines.
   - Tests: completeness counts, hidden below 5, kinds never added, remediation included.

## Open decisions

None left. Alex decided D1–D4 above. The thresholds (10 records, 90%, 14-day window, 90-day expiry) are recommendations
he can change before slice 2.

## Codex round 1 ledger

| # | Finding | Verified | Fixed how |
|---|---|---|---|
| 1 | Actor names don't prove acceptance or feedback | Yes (assignment.ts:510–511, build-review.ts:124, youiyoux-intake.ts:715) | Acceptance = `proof person` row bound to the result's receipt digest, or a verified merge; `system:landed` without a merge doesn't count; `task_ref.revision_by` stamped from trusted context |
| 2 | Exclusions hide model failures | Yes (builder.ts:1934 before :2986; dispose.ts:372) | Execution failures counted first; infrastructure only on structural `terminal_class`/stop; not-counted published with reasons and capped at a third |
| 3 | Settled once ≠ lifecycle | Yes (assignment.ts:138, :325) | pending / provisional / mature / rejected / not counted; window starts at acceptance; re-evaluated on every input change |
| 4 | Telemetry overstated | Yes (provider.ts:199, reported-usage.ts:64, operate.ts:3746) | Claude-only coverage stated; record proves the session model; not-reviewed ≠ no findings; review claim corrected; trials only on Claude cohorts |
| 5 | Cell mixes cohort and provenance | Yes (store.ts:8734, :8900, :14254; my refileScope claim was wrong) | Immutable `run_cohort` at run start; cohort excludes the model; selection is provenance; mixed-model families not counted |
| 6 | Automatic rollback lacks authority | Yes (model-choices.ts:337, :271) | Kept automatic (Alex): bounded switch-off authority granted and sealed at acceptance; rule is a separate layer so the prior state, row absence included, is untouched; generation compare-and-set; pause and Needs you on any change; validation re-run |
| 7 | Default change reaches excluded work | Yes (phase-routing.ts:379; store.ts:9669 null semantics) | Cohort-scoped earned rule instead of a Models row change; protected flags come from the cohort snapshot and changed files, not from a null |
| 8 | Protecting the scorer isn't enough | Yes (release-auto.ts:206; eval-hooks.ts) | Policy paths plus a ROUTING manifest of pinned inputs, consumers and store writers; dependency-attack tests |
| 9 | Exposure and trial accounting missing | Yes (approval-authority.ts:18–25) | Append-only `route_exposure`; atomic reservations in `saveScope`; person-only check at seal and dispatch on every basis; pins kept; eligibility re-checked at accept |
| 10 | Savings basis incomplete | Yes (reported-usage.ts:98, model-catalog.ts:113/150) | Separate amounts and completeness counts; remediation included; price snapshot re-checked at accept; "observed median", not savings |
| 11 | CLI and local-owner authority | Yes (operate.ts:1549, local-owner.ts:26) | Verified `ModelAuthority` through the CLI; per-act matrix; two new local-owner acts for turn-off and dismiss only; chat list and Not now; authority tests |
| 12 | Migration with independent slices | Yes (store.ts:5548, toolroll-update.ts:433) | All schema in slice 1 (v148); fresh, upgrade, interrupted and rehearsal tests; phone and desktop journeys with states |

Codex's closing alternative (read-only results plus person-approved reversion, no automatic rollback) is not
adopted, because Alex chose automatic switch-off. Its concern is met by the bounded grant above. Codex's point that
sized-by-job already gives small-task evidence is adopted: trials matter mainly for routine work.
