# Results-driven model routing — plan

Status: plan v1 (2026-11-05), awaiting Codex review (max 2 rounds). Branch `results-routing`, off main 3da1dcfa
(0.9.91). Issue #227 (learning loop 1 of roadmap #231). Nothing in `src/` changes with this document.

## What and why

Alex (from agentrun's promote/demote-by-receipts idea): "make tasks more deterministic with cheaper models".

- Toolroll keeps a **result record** for each finished task: which model built it, the task's size, the project, whether
  checks passed, how many attempts it took, what the review found, whether a person asked for changes, whether a
  person accepted it, cost and time.
- Once a cheaper model has **earned it** in one project and size, Toolroll **suggests** making it the default. The
  approval card shows the evidence in plain words.
- When the cheaper model starts failing, it goes back.

It only changes **proposals**. A person accepts each suggestion, every task is still approved as today, and the route
stays sealed into the approval.

Lesson from run-efficiency v1 (NO-GO: "promised measurements the stored data doesn't hold"): this plan reads only
columns that exist today, says where each one lives, and a fact that isn't recorded makes the record **excluded**, never
good and never 0.

## What is measured, and where it already lives

Nothing below is recorded a second time. The one new store is a small **settled verdict** per task (§Schema), derived
from these rows by one pure function. Paths are under `src/`.

| Fact | Where it lives today | Caveat |
|---|---|---|
| Model that was meant to run, per run, with its phase | `run_route` (store.ts:3394): `phase` plan/build/repair/review, `provider`, `model`, `chosen` (recommended/override/pinned/legacy/fallback). Written once in `startRun` (store.ts:15642) | Immutable, Toolroll-written |
| Model that actually ran | `run.model_reported` (v140, store.ts:1445; `recordRunModelReported` :25589) | NULL = not reported (all rows before v140); several models joined with " + " |
| Cost and billing | `run.cost_usd`, `run.billing_basis`, `run.cost_unknown` (v141, store.ts:758–759); `run_spend` (store-baseline.ts:2573). Classified by `runAmountOf` (reported-usage.ts:98): api / subscription / unknown | `cost_usd` can hold a cap when unknown; only `runAmountOf` is trusted |
| Tokens, cache | `run.tokens_in/out`, `run.usage_json` → `usageOf` (run-efficiency.ts:51) | Provider-reported |
| Time | `run.started_at`, `provider_started_at` (store.ts:16104), `finished_at` | |
| Run outcome | `run.outcome` built/failed/refused/parked/no-change/interrupted, `reason` (`finishRun`, store.ts:15996) | NULL = cut down |
| Check pass/fail | `run_check.status` passed/failed/not-run (store-baseline.ts:2669; `recordRunCheck` store.ts:16777 from builder.ts:2986) | Toolroll ran the command; first write wins |
| Proof verdict | `proof_verdict.verdict` verified/attested/short/refuted (store.ts:4864) | |
| Attempts | builder runs per `task_ref` with `outcome='failed'`; `repair_chain` rows (store.ts:4929) | `task_ref.strikes` resets on success, so it is not used. `role='repair'` mends a park payload; it is not a fix-after-failure loop |
| Review findings | `build_review.findings_json` (review-switch.ts:20; HIGH/MEDIUM/LOW, contracts/review-findings.ts:22), `sent_back_as` | No count column: counted from the JSON |
| Person asked for changes | revision task `task_ref.revision_of`, `filed_via='revision'` (store.ts:3293/3298); notes in `diff_comment.author` (store.ts:4992) | Automatic review's notes have author "automatic review" (build-review.ts:40) and are told apart |
| Accepted, and by whom | `action_ledger` row with action `COMPLETION_ACTION` (result-completion.ts:10); actor `operator:<name>`, `lead:<id>`, `coordinator:<id>` or `system:landed`; `task_act.lead` (store.ts:22750) | The ledger is append-only (store-baseline.ts:2748) |
| Size class | `task_ref.size`, `size_risky`, `size_source` (store.ts:5628); sealed in the route as `size` (phase-routing.ts:637) | The **sealed** size is used |
| Build tier | `task_ref.route_tier` (store.ts:8734): light/routine/strong/override/pinned | |
| Project | `task_ref.repo` (store.ts:3252) | NULL = unplaced task → excluded |
| Excluded work | `task_scope.quality_mode='strict'`, `candidate`, `release_terms_json`; `run_check.release=1`; `approval_policy.protect_project`/`protected_paths` (store.ts:1809, `protectedResultProblem` :9669); `task_ref.deliverable='report'` | |
| List price | `model_seen.input_usd/output_usd` (model-catalog.ts:21) | NULL = "price not listed" |

Prior art reused, not duplicated: `tier-report.ts` (`toolroll spend`, by tier: tasks, results, median minutes, plan runs,
spend, "saved") and `spend-report.ts` `spendRows` (:64). Neither reads checks, review, revisions or acceptance; slice 4
adds those through the result record rather than a second query.

## The result record (per task)

One record per task that reached an end, for its **build** leg. The record's key, its **cell**, is:
project (`repo`) · size (sealed small/medium/large, risky or not) · build tier · provider · exact model.

**Excluded** (it isn't counted for anyone, and says why):
- The model that ran is not the model the route named (`model_reported` NULL, different, or joined).
- Any excluded-work marker above, a risky or strict task, screenshot or manual-review evidence, automerge publication, a
  revision task (it counts against its parent instead), a scout, or a task with no project.
- No check result (`not-run` or NULL): Toolroll can't tell how it went.
- The run ended on something that isn't the model's fault: refused, interrupted, provider exhausted, auth expired, fence
  refusal, chain custody (the reason families already on `run.reason`).
- Cancelled by a person before any result.
- Accepted only by a lead or coordinator (`lead:` / `coordinator:` actor) with no merge after.

**Good**: accepted by a person (`operator:`) or merged (`system:landed`); the final build's checks passed; at most one
failed build attempt before it; no HIGH review finding; proof not refuted; no person-written revision within 14 days.

**Bad**: anything else that ended: the task failed or was abandoned after building, two or more failed attempts, a HIGH
finding, a person asked for changes (or filed a revision within 14 days), a refuted proof.

The record also carries cost (all of the task's runs through `runAmountOf`: API dollars, plan usage or unknown, never
added together), minutes to a result, minutes to accepted, and attempt count. It is **settled** at the end, and
re-settled once if a revision arrives within 14 days. Each record names the policy version that judged it.

## Promotion and demotion

Only **build** slots can be suggested: `build-light` (small tasks) and `build` (routine tasks). Repair already follows
the build (`repair: null` in "Sized by job", model-choices.ts:116). Plan rows are never touched, and model review is
retired (operate.ts:10763). A repair row someone set is left alone.

**Cheaper** means a lower list price for both input and output (`model_seen`). If either model's price is not listed,
nothing is suggested.

**Suggest as the default** (one project, one slot) when the cheaper model has, in that cell:
- at least **10** counted records (good + bad) in the last **90 days**, using the newest 20 at most;
- at least **90%** good;
- none of its last **3** bad;
- and, when the current model has 10+ records in the same cell, a good rate no more than **5 points** below it.

**Decay**: records older than 90 days drop out. A new model id starts with no history; it never inherits from an
older version.

**Goes back** (an accepted suggestion, or a trial) when, over its records since it was accepted:
- 2 bad in the last 5, or
- under 80% good over the last 10, or
- people choose another model for that leg on 3 of the last 10 tasks it was proposed for.

After going back, that model is not suggested again for that cell for 30 days, and only records after the date count.

**Per project only** (decision D3). Settings shows other projects' results as context, never as evidence.

**Never on unknown**: no price listed → no suggestion. Excluded records never count. Savings in dollars are shown only
from API-priced records (see "What the person sees").

## Getting evidence: trials (decision D1)

A cheaper model only earns results if it runs. Today that happens only when a person overrides a leg, which is rare. So
when the **current** model is doing well in a cell (10+ records, 90%+ good), Settings offers "**Try Haiku 5.5 on the
next 10 routine tasks**".

- Turning a trial on is a person's act with the same proof as any Models change.
- While a trial runs, `recommendRoute` gets one more pure input, `trial`. The build leg is proposed on the cheaper
  model, with a reason that is sealed like every reason (so it is in the digest): "trying Haiku 5.5 on routine builds
  here (4 of 10) — turned on in Settings → Models".
- A trial task is **never** approved automatically (mode, grant, auto-check, auto-green): it waits for a person, like
  protected work.
- A trial is never applied to excluded work.
- It ends after 10 tasks, on the going-back rule, or by hand. A trial never changes a configured row.

## What the person sees

**Approval card** (task page approval sheet `agentsDetail`, render-tasks.ts:405; ceremony `agentsCeremonyHtml` :756;
chat aside render-chat.ts:122; text `describeScope` scope.ts:1807). It gets one line beside "Agents", shown only when the
build leg comes from a suggestion or a trial:

> **Why this model:** Haiku 5.5 builds routine tasks here. 14 of the last 15 similar tasks were accepted with checks
> passing. About $0.40 each, vs $1.10 on Sonnet 5.5.

> **Trying a cheaper model:** Haiku 5.5, task 4 of 10. You can pick another model before approving.

Plan usage reads "uses your plan, list price $1 / $5 vs $3 / $15 per 1M tokens". Unknown cost reads "cost unknown". The
line is shown from current records ("so far") and is not part of what is approved; the trial reason above is.

**Settings → Models**: a **Suggested** group next to "Newer models" (models-ui.ts:148), built the same way:

- "Haiku 5.5 for routine tasks in toolroll — 14 of 15 accepted, about $0.70 less each" → **Review change** (previews
  the diff, then saves with step-up through `applyModelChoices`, model-choices.ts:316) · **Not now** (hidden for 30 days).
- "Try Haiku 5.5 on the next 10 routine tasks" → **Start trial** · **Not now**.
- "Went back to Sonnet 5.5 for routine tasks: 2 of the last 5 needed changes." (also in Needs you)
- One switch per project: "Suggest cheaper models" (on by default; off hides everything and stops trials).

**Spend page** (spend-ui.ts): a **Suggestions** block. For each accepted suggestion: tasks run, the good rate, API
dollars per task before and after. "Before" is the old model's median in the same cell. It is labelled **estimate** and
is shown only when each side has 5+ API-priced records. Plan usage and unknown stay apart, as on the rest of the page.

## CLI parity

All under `toolroll models` (models-cli.ts), with `--json` through the usual `succeed`/`fail` envelopes and stable
reason tokens:

```
toolroll models results [--repo <p>] [--json]                # cells: model, records, good/bad/excluded, cost, minutes
toolroll models suggestions [--repo <p>] [--json]            # open suggestions, trials, recent go-backs
toolroll models accept <id> --as <you> --token <t>           # = the Settings change, through applyModelChoices
toolroll models try <id> --as <you> --token <t>              # start a trial
toolroll models dismiss <id> | stop <id> --as <you> --token <t>
toolroll spend [--json]                                      # gains the Suggestions lines (tier-report.ts)
```

`task show` / `task route` print the same evidence line as the card.

## Safety

- **Plan is never lowered.** Only `build-light`/`build` rows are ever suggested, at project scope. A suggestion can't
  name a slot the owner set at project scope since the suggestion was made: accept checks the row is unchanged
  (`stateDigest`, model-choices.ts:65).
- **Sealed approvals never change.** Accepting writes a configuration row. The seal copies the route
  (store.ts:9038–9052) and `sealedRouteOf` re-verifies it (store.ts:14290). Only tasks filed or re-filed later see the
  new default. `refileScope` already refuses approved scopes.
- **Going back** writes only the exact pair the suggestion replaced, and only if the row still holds what was accepted
  (compare-and-set in one transaction). It runs through one narrow door, ledgered as `system:results`. Nothing else can
  write through that door.
- **Excluded work**: protected projects and paths, release candidates and release terms, strict quality, risky, evidence
  demands, automerge: they are never trialled and never counted.
- **Can't be gamed by an agent**:
  - Records are derived only from Toolroll's own rows: `run`, `run_route`, `run_check`, `proof_verdict`,
    `build_review`, `action_ledger`, `diff_comment` authors, `task_ref`, `task_scope`. They are never read from
    worktree files, park payloads, agent reports or lead tool calls.
  - A lead's or coordinator's acceptance does not count.
  - Accepting, trialling and dismissing need a person proof (`PERSON_PROOFS`, model-choices.ts:219); a lead token is
    refused, and there is no lead proposal kind for it.
  - The scoring file (`src/route-results.ts`) joins `EVAL_POLICY` (release-auto.ts:192), so an automatic approval can't
    ship a change to it.
- **Display can't move money**: the evidence line and the Spend block never change admission, budgets or check verdicts.

## Schema (v148, additive)

- `route_record` — one row per settled task:
  - task, build run, cell (repo, size, risky, tier, provider, model), verdict `good|bad|excluded`, reason codes;
  - cost kind and API micro-USD (NULL = unknown), minutes to result and to accepted, attempts;
  - `policy_version`, `settled_at`, `resettled_at`.
- `route_suggestion` — one row per offer:
  - repo, slot, from and to (provider, model), kind `default|trial`;
  - state `offered|accepted|trialling|dismissed|went-back|ended|expired`, evidence JSON (the counts shown);
  - trial count and limit, `by`, timestamps, end reason.
- `task_ref.route_trial` — the suggestion id when the task was filed under a trial; NULL otherwise.
- `project` setting `suggest_models` (default 1).
- Usual pattern: a `V148_ADDED_COLUMNS` map, an `UPDATE_SAFE_MIGRATIONS` entry (store.ts:1307), a migration test. Old
  tasks are settled once, lazily, from the rows they already hold; records before v140 come out excluded (no reported
  model).

## Slices (each ships alone, with tests and an e2e journey)

1. **Result records, read-only.**
   - What ships: `route-results.ts` (pure `recordOf`), `route_record`, a bounded settle pass on the tick,
     `toolroll models results [--json]`, and one "Result record" line in the task's Details.
   - Tests: the verdict matrix (each good, bad and excluded cause from fixture rows); model mismatch; lead-only
     acceptance; a revision within 14 days flips the verdict; infra reasons exclude; migration v147→v148.
   - Journey: a task finishes, then `models results` shows its cell.
2. **Suggest, accept, go back, evidence line.**
   - What ships: the suggestion engine, Settings "Suggested" with Review change / Not now, the project switch, the
     CLI `suggestions|accept|dismiss`, the going-back watcher and its door, the Needs you notice, and the approval
     evidence line on all four surfaces.
   - Tests: threshold edges (9/10 and 10/10, 8/10, a bad among the last 3); decay at 90 days; no listed price means no
     suggestion; plan and repair rows are never offered; excluded work is never counted; accept refused for a lead
     token or a stale state; a go-back compare-and-set loses when the row was changed by hand.
   - Journey: seeded records lead to a suggestion; accepted with step-up; a new task routes to Haiku with the line; an
     already-approved task keeps Sonnet; two bad results lead to the go-back notice.
3. **Trials.**
   - What ships: the `trial` input to `recommendRoute`, its sealed reason, `task_ref.route_trial`, auto-approval
     refusal for trial tasks, and `models try|stop`.
   - Tests: the trial changes the digest; never on excluded work; a mode-approved trial task waits for a person; the
     trial ends at 10 or after 2 bad.
   - Journey: start trial, file, approve, finish, and the trial count moves.
4. **Spend savings.**
   - What ships: the Suggestions block on the Spend page and the `toolroll spend` lines (extending tier-report.ts).
   - Tests: the estimate is hidden under 5 API-priced records; plan usage and unknown are never added.
   - Journey: the Spend page after slice 2's journey.

## Open decisions for Alex

1. **Trials**: let Toolroll offer "try a cheaper model on the next 10 tasks" (each task still approved by a person)?
   **Recommend yes.** Without trials, suggestions only appear when someone overrides a model by hand, which almost
   never happens.
2. **Going back**: automatic, or a suggestion you accept? **Recommend automatic.** It only restores the model you had
   before, only for new tasks, and it is logged and shown in Needs you.
3. **Per project or installation-wide**: **Recommend per project only** for v1. Projects differ (a docs repo vs
   Toolroll itself), and per project is easier to explain on the card.
4. **Large tasks**: also suggest Sonnet for large non-risky tasks that run on Opus today? **Recommend not in v1.** Start
   with small and routine, and revisit after about two months of records.
