# Results-driven model routing — plan

Status: **v3** (2026-11-05). Branch `results-routing`, off main 3da1dcfa (0.9.91). Issue #227, learning loop 1 of
roadmap #231. Nothing in `src/` changes with this document.

Review history:
- Codex round 1: NO-GO, 12 findings.
- Codex round 2, the last round for this arc: NO-GO. 3 closed, 9 partial, 4 new.
- v3 closes every partial and new item. The ledgers are at the end, with the mechanism, hook and test for each.

Alex's decisions (final):
- Trials **yes**; each trial task is still approved by a person.
- Going back is **automatic**.
- Rules are **per project** only.
- **Large tasks are not in v1.**

## What and why

Alex, inspired by agentrun's promote/demote-by-receipts: "make tasks more deterministic with cheaper models".

- Toolroll keeps a **result record** per finished task, built only from its own records.
- When a cheaper model does as well on a project's small or routine tasks, Toolroll **suggests** an **earned rule**.
  A person accepts it with a proof. Every task is still approved, and the route stays sealed.
- When results drop, the rule **switches itself off**, under a bounded authority the person granted at acceptance.

Anything not recorded is shown as **not counted, with the reason**: never counted as good, never as 0 (the lesson
from the run-efficiency v1 NO-GO).

## Facts the design stands on (verified at 3da1dcfa)

Paths are under `src/`.

| Fact | Where | Consequence |
|---|---|---|
| The route stamp per run holds a digest, not the route | `run_route` (store.ts:3394), `writeRunRoute` in `startRun` (:15642) | Size and eligibility must be snapshotted per run |
| Re-filing keeps the old approval, which goes stale | `refileScope` (store.ts:8900) | Exposure is deduplicated per task |
| The reported model is Claude only, and is the session's init model | provider.ts:199, reported-usage.ts:64 | Only Claude cohorts can earn a rule or run a trial |
| Failure reasons are normalized: `timeout`, `git`, `setup`, `provider-init`, `stopped`, `provider-*` all become `retryable-infra` | dispose.ts:372–383 → `finishRun(reason: failureClass)` (claim.ts:1191) | The raw class must be kept before that mapping |
| A failure ends before any check is recorded | builder.ts:1934 vs :2986 | Failures are counted before the "no check" exclusion |
| The effective check can change after the result | `assignmentChecksForRun` (assignment.ts:138) | Records are re-evaluated |
| Completion marks `proof person` or `proof machine`, tied to the result's receipt digest | assignment.ts:500–521; result-completion.ts:90–91 | Acceptance is read from that mark |
| `system:landed` can complete without a merge | youiyoux-intake.ts:715 | It is not acceptance |
| Revisions come from 9 callers. `allowMode` is true for automatic review **and** browser requests | build-review.ts:125, flow-engine.ts:458, flow-pull-request.ts:128, pull-request-flow.ts:331, chat-decide.ts:957, chat-review.ts:82, task-outcome-cli.ts:94, server/tasks.ts:1480 (`allowMode: who.via === "cookie"`), :1591 | Origin must be passed explicitly |
| Changed files are read from the diff-stat artifact | `changedFilesOf` (result-completion.ts:37) returns **null** when unreadable or truncated | "Unknown" means not eligible |
| Build-config writers are store methods | `setPhaseConfig` store.ts:13786, clear :13797, `setPhaseTierConfig` :13837, clear :13846, alternates :13878/:13889. Called from model-choices.ts:368–373, :412–428, :498, control-setup.ts:46, demo.ts:417–425; the only other SQL is the migration at store.ts:7031 | The generation is bumped inside those methods |
| Settings validation | `checkScope` (model-choices.ts:271; repair provider rule at :281; routes via `effectiveRoutes` :144 at :291) | Must include the rule layer |
| Large, risky or strict work falls back to the routine row when no strong row exists | phase-routing.ts:379 | Rules are cohort-scoped |
| Headroom can move a configured leg to another provider | phase-routing.ts:548 | Precedence must be defined |
| The route contract's leg has no provenance field; `chosen` is recommended / override / pinned | contracts/route.ts:48–57 | Route v3 adds `selection` |
| Dispatch executes the sealed profile | builder.ts:740 | |
| The admission transaction | store.ts:15386; run insert :15610; `writeRunRoute` :15642 | Reservations are consumed there |
| Local owner: `withLocalAct` sets the in-flight act | local-owner.ts:140 | |
| Local owner allowlists | `LOCAL_OWNER_ACTS` local-owner.ts:26; `CHAT_ACTION_LOCAL_ACTS` :183; route-table `localAct` (server/route-table.ts:231–239); `Store.transact` checks standing only (store.ts:7852) | |
| `ModelAuthority` excludes local owner | model-choices.ts:219 | |
| Policy paths | `EVAL_POLICY` release-auto.ts:192 | |
| Hook manifest | eval-hooks.ts proves a call is **present, not reached** (:20) | Pinned bodies are needed |
| A current-version store runs no DDL | store.ts:5548 | All schema lands in slice 1 |
| Update rehearsal | toolroll-update.ts:433 | |

## Cohort, families, eligibility (items 5, 7)

**Run snapshot.** `run_cohort` gets one row per run. It is written inside the admission transaction next to
`writeRunRoute` (store.ts:15642) and never updated. It holds:
- repo, sealed size and risky, quality mode;
- the evidence-demands flag, publication authority, the release / candidate flags;
- **pre-dispatch protection**: `protect_project`, or declared `touches` matching `protected_paths`;
- the build leg's sealed `selection` (below), route digest, role, and model named.

**Cohort key**: (repo, small | medium). It requires: not risky, default quality, no evidence demands, not automerge,
not release or candidate, no pre-dispatch protection. Any of these false → **not eligible** before dispatch. Eligibility
is decided conservatively from sealed facts only.

**Post-build classification.** Kept separately, on the record and not on the snapshot: `changedFilesOf(store,
runId, root)` for each code-writing run of the family.
- **clean**: readable, and no path matches `protected_paths`;
- **protected**: a path matches. The record is not counted: "touched protected files";
- **unknown**: null (unreadable or truncated). The record is not counted: "changed files unknown".

Only clean records enter comparisons.

**Family.** The root task plus its revision tasks (`revision_of`). Every **code-writing** run counts: role
`builder` **and** `repair`. Planner, scout and reviewer runs don't write code. A family's record is attributed only
when all of these hold:
1. every code-writing run has a `run_cohort` row with the **same cohort key**. Otherwise it is not counted: "mixed
   cohort" (for example a revision re-sized to large, or one run under strict).
2. every code-writing run's `model_reported` equals its stamped model, and they are all the same model. Otherwise it
   is not counted: "mixed models" or "model not reported".

Provenance is the list of selections across the family. It is shown, not used to split comparisons.

## Result record (items 1, 2, 3)

**Execution class kept before normalization (item 2).** New immutable `run.exec_class` (v148), written by
`recordExecClass` (first write wins) in dispose.ts immediately before the `failureClass` mapping (dispose.ts:372),
from the raw `result.reason`. Two classes matter:
- **model**: timeout, agent, agent-reported, no-op, no-handoff, moved-head, moved-branch, commit-failure, and a failed
  check;
- **infrastructure**: git, setup, provider-init, provider-unattested, provider-protocol, stopped. Also
  `terminal_class` auth-expired or exhausted, and interrupted before `provider_started_at`.

A failed run with no `exec_class` (a missing write) is treated as **model**. That is the conservative choice: it
counts against the cheaper model.

**Revision origin (item 1).** `createResultRevision` (result-actions.ts:82) gets a **required** typed field `origin`:
`person | automatic-review | flow | lead | machine`. The compiler makes every caller pass it, and a hook test lists
all nine callers above with the value each must pass:

| Caller | origin |
|---|---|
| browser (server/tasks.ts:1480, :1591) | `person` when the session's proof is a person proof, else `machine` |
| chat and paired chat (chat-decide.ts:957, chat-review.ts:82) | `person` for the chat's verified person, and for a lead's or coordinator's review card a person confirms (lead-doors.ts); `lead` under the lead's own chain or a remote run (`machineActing()`) |
| CLI (task-outcome-cli.ts:94) | `person` for a verified approver, `lead` for a lead token |
| flows (flow-engine.ts:458, flow-pull-request.ts:128, pull-request-flow.ts:331) | `flow` |
| automatic review (build-review.ts:125) | `automatic-review`, even when the mode signer's name is the actor |

The origin is stored as `task_ref.revision_origin`. `allowMode` is never read for it. Only `person` rejects a record.

**Acceptance.** A completion row with `detail = 'proof person'` whose outcome equals the receipt digest of the
family's result run, or `merge_intent.state = 'merged'`. `system:landed` without a merge is not acceptance.

**Lifecycle** (re-evaluated on every input change: completion, follow-up check, revision, proof, merge, task end):
- **pending**: no result yet, or the result waits. It never triggers anything.
- **provisional**: accepted. The 14-day window starts at acceptance.
- **mature**: 14 days after acceptance with no person revision, the effective check still passed, and the proof not
  refuted.
- **rejected**, checked first:
  1. two or more **model-class** failed code-writing runs;
  2. the task failed, or was cancelled after a result;
  3. a HIGH finding from automatic review;
  4. a person revision;
  5. a refuted proof;
  6. the effective check turned failed.
- **not counted**, with a reason:
  - infrastructure-only failures;
  - no check configured;
  - mixed cohort or mixed models;
  - post-build protected or unknown;
  - a result left 30 days without an answer;
  - not eligible.

"Not reviewed" adds no review signal. Each record keeps API micro-USD, subscription runs and tokens, unknown runs,
and remediation runs separately.

## Earned rules (items 6, 13, 14)

A rule is a separate layer. It never edits the owner's Models rows: "For <project>'s eligible <small|routine> tasks,
build on <cheaper model> instead of the configured <model>." One active winner per project and cohort is enforced by
a partial unique index on `route_rule(repo, cohort_size) WHERE state IN ('active','trialling','paused')`.

**One precedence order (item 13)**, in one pure function `selectBuildLeg` used by `recommendRoute`:

> pin > person override > trial > earned rule > configured row (light / routine / strong by size) > headroom move

- Headroom (phase-routing.ts:548) moves only a configured leg, never a rule or trial leg: the evidence is about one
  exact model.
- When the rule's provider is past the headroom limits, the rule is **skipped** for that filing. Its reason says so,
  and it records no exposure and reserves no trial place. Configured and headroom routing then proceeds.
- The **same function** feeds:
  - the Models previews and `effectiveRoutes` (model-choices.ts:144), which show "routine tasks in X: Haiku 5.5
    (earned rule)";
  - `checkScope` (:271), which validates every active rule's route. That includes **repair compatibility**: the rule's
    provider must equal any configured repair row's provider (:281);
  - acceptance, which runs `checkScope` with the candidate rule added, in the accept transaction;
  - filing (`saveScope`, store.ts:8716).

**Configuration generations (item 6).**
- A new `models_generation(scope, phase, generation)` table. Each config writer method (store.ts:13786, :13797,
  :13837, :13846, :13878, :13889) bumps its (scope, phase) row **inside itself**, so every caller is covered:
  model-choices, control-setup, default routing fill, demo.
- At acceptance a rule records the generations it depends on: installation + project rows for `build` and `repair`.
- In the **same transaction** as the bump, the writer calls `pauseDependentRules`, so a config change pauses the
  affected rules atomically. Needs you then asks "keep or drop".
- An architecture scan (item 8) forbids any other SQL write to the `phase_*` tables.

**Switch-off (item 6).** `switchOffIfTripped(ruleId)` runs as **one** `store.transact`:
1. Read the rule's state and generation.
2. Re-read every dependent generation. If any differs, **pause**; never switch off.
3. Check the grant: not expired, policy version equal to the sealed one, and the granter's account still exists.
   An expired grant ends the rule.
4. Recompute the trigger from records with the **sealed** parameters.
5. If it trips: `UPDATE route_rule SET state='switched-off', generation=generation+1 WHERE id=? AND generation=? AND
   state='active'`, then re-run `checkScope` on the result. If that fails, roll back and pause.

**Sealed identity (item 14).** Route **v3** adds an optional build-leg field `selection`, included in
`canonicalRouteJson` and so in the digest. Its shapes:
- `{kind:'rule', rule, ruleGeneration}`
- `{kind:'trial', rule, reservation}`
- `{kind:'configured'|'override'|'pin'}`

v1 and v2 routes read back exactly, as today (contracts/route.ts versioned schemas). Every check reads the sealed
`selection`, never the current rules or reason text.

When a rule ends, already-approved tasks are handled by `admitRun` (store.ts:15386):
- **trigger switch-off**: approved-but-not-started tasks sealed under that rule are **held**. Admission refuses
  `rule-switched-off` with no strike, and Needs you shows "Results for Haiku dropped after you approved this. Approve
  again or re-file."
- running tasks finish.
- **manual off or expiry**: approved tasks keep their exact sealed model.

A model is never silently substituted.

**Accept.** A person act through the same re-proof as `applyModelChoices` (model-choices.ts:337–344). In one
transaction it re-checks:
- still earned;
- prices equal the snapshot;
- dependent generations equal the offer's;
- `checkScope` with the rule passes;
- the unique winner is free.

A refusal names which one: `stale-suggestion`, `price-changed`, `config-changed`, `invalid`, `taken`.

## Suggest and trigger terms (item 16)

**Ordering**: records are ordered by their family's first code-writing run's `run_cohort` start time, then task id.
Exposures are ordered by first-proposed event id. Only records and exposures **after the grant's exposure cutoff**
(accept time) count toward a trigger. **Decided** records are mature or rejected; pending and provisional records are
never in any denominator.

**Suggest** (from records in the last 90 days, newest 20 decided):
- the cheaper model has ≥ 10 decided records, ≥ 90% mature, and none of its last 3 decided records rejected;
- the configured model, if it has ≥ 10 decided records, is no more than 5 points higher;
- not-counted records are ≤ ⅓ of all records;
- both models have listed prices, and the cheaper one is lower on both. The prices are snapshotted.

**Grant, sealed at acceptance**, as JSON in `route_rule.grant_json`, read only from there:
- `policyVersion`, `cutoff`, `expires` (cutoff + 90 days);
- `reject: {window: 5, max: 1}`: switch off when ≥ 2 of the latest 5 decided records are rejected (rolling);
- `mature: {window: 10, min: 0.8}`: evaluated only once ≥ 10 decided records exist; switch off when fewer than 80% of
  the latest 10 decided records are mature;
- `declined: {window: 10, max: 2}`: switch off when ≥ 3 of the latest 10 **closed** exposures were approved with
  another model.

Ten started tasks with pending results trigger nothing.

## Exposure (item 9), shipped in slice 2

- `route_exposure`: one row per (task, rule), with a unique constraint. Re-filings add events, not rows.
- `route_exposure_event`: append-only. Kinds are `proposed`, `refiled`, `approved-as-proposed`,
  `approved-with-other(model)`, `cancelled`.
- An exposure is **closed** at its first approval or cancel event, and the decline trigger reads only closed
  exposures.
- Events are written in `saveScope`, `sealScopeApproval` and cancel, through the writer module.

## Trials (item 15)

- **Offered** when the configured model in a Claude cohort has ≥ 10 decided records at ≥ 90% mature. Starting one is
  a person act with the same re-proof. One trial per cohort, under the same winner index.
- **Reservation table** `route_trial_reservation`: id, rule, task (unique per rule and task), scope digest, state
  `reserved | consumed | released`, consumed run, timestamps.
- **Reserve**, in `saveScope`'s write transaction (serialized by `beginWriteWithin`):
  - a task that already holds a `reserved` row for this rule reuses it, and its scope digest is updated by CAS on
    `state='reserved'`. Repeated saves never take a second place;
  - otherwise a new row is inserted only if `reserved + consumed < limit`.
- **Consume**, once, in the admission transaction (store.ts:15386) before the run insert:
  - `UPDATE … SET state='consumed', consumed_run=? WHERE id=<sealed selection.reservation> AND state='reserved' AND
    scope_digest=<sealed digest>`; zero changes → admission refuses `trial-reservation`;
  - a retry or repair of the **same task** whose reservation is already consumed by that task is admitted without
    consuming again.
- **Release**: `UPDATE … SET state='released' WHERE id=? AND state='reserved'`. It runs on cancel, and when a re-file
  drops the trial. A consumed reservation is never released.
- **Person approval only.** `sealScopeApproval` refuses a v3 route whose `selection.kind = 'trial'` unless the basis
  is a person proof (`password` or `chat` with a person seal, approval-authority.ts:18–25). It refuses mode, grant,
  schedule, carried, auto-check, auto-green and lead. Admission re-checks from the sealed selection.
- Pins and overrides beat a trial, so no place is reserved for them.

## What the person sees

- **Approval card**: the evidence line beside Agents on the approval sheet (render-tasks.ts:405), the approval step
  (:756), the chat side panel (render-chat.ts:122) and the text card (scope.ts:1807). It appears only for a rule or
  trial selection:

  > **Why this model:** Haiku 5.5 builds routine tasks in this project. 14 of the last 15 decided similar tasks were
  > accepted with checks passing (3 more not counted: no checks configured). Observed median $0.40 a task, $1.10 on
  > Sonnet 5.5.

  > **Trying a cheaper model:** Haiku 5.5, task 4 of 10. This task waits for your approval. You can pick another
  > model before approving.

  The selection is sealed. The counts read "so far".
- **Settings → Models**: a **Suggested** group (models-ui.ts:148):
  - **Review change** previews the evidence and the switch-back terms, then saves with step-up;
  - **Start trial**;
  - **Not now** (30 days);
  - active rules with **Turn off**, paused rules with **Keep / Drop**;
  - the per-project "Suggest cheaper models" switch.
- **Needs you**: switched off, paused, held tasks, about to expire.
- **Spend page**: observed medians over matched 90-day windows, with completeness counts and snapshotted prices. The
  label is "observed, not a promise", and it is hidden below 5 API-priced records a side. (Item 10 is closed.)

## Authority (item 11)

The general Models guard is **not** widened. There are two doors:

| Act | Door | Who |
|---|---|---|
| accept, start trial, keep a paused rule, switch "Suggest cheaper models" **on** | `route-rules.ts` `acceptRule` etc., with a `ModelAuthority` re-proved in the transaction (model-choices.ts:337–344). CLI passes the verified authority (method, generation), not a name (fixes operate.ts:1549) | person with step-up only |
| turn off a rule, stop a trial, drop a paused rule, switch suggestions **off**, Not now | `route-rules.ts` `turnOff`, `dismiss`. They accept a person `ModelAuthority`, **or** a local owner whose in-flight act (`withLocalAct`, local-owner.ts:140) is exactly `routing-turn-off` or `dismiss-suggestion`. The writer checks the act itself; any other act refuses | person or local owner |
| any of the above with a lead token or remote API token | refused in the writer (`lead-refused`) | — |

Inventories wired:
- `LOCAL_OWNER_ACTS` gains the two acts (local-owner.ts:26).
- Route-table POST routes declare `localAct` for off and dismiss and `step-up` for the rest (server/route-table.ts).
- `CHAT_ACTION_LOCAL_ACTS` gets `suggestions` (read) and `not-now` (local-owner.ts:183).
- The CLI command list and help (cli.ts `OPERATE_COMMANDS`, operate.ts help), with flag allowlists.
- `server/adapter-inventory.test.ts` and `local-owner.test.ts` are updated.

```
toolroll models results [--repo <p>] [--json]
toolroll models suggestions [--repo <p>] [--json]
toolroll models accept <id> | try <id> | keep <id> --as <you> --token <t> [--json]
toolroll models off <id> | dismiss <id> [--as <you> --token <t>] [--json]
toolroll spend [--json]
```

## Protection (item 8)

1. **Policy paths** (added to `EVAL_POLICY`): `src/route-results.ts` (evaluator), `src/route-rules.ts` (suggest,
   accept, switch-off, doors), `src/route-store.ts` (**the only writer** of the new tables), and
   `src/contracts/route-results.ts`.
2. **Pinned bodies, not just required calls.** A pinned body can't gain an `if (false)` without changing, which
   needs a person. Pinned:
   - decision: `recommendRoute`, `selectBuildLeg`, `routeFromJson`/`readSealedRoute` and the route v3 schema,
     `canonicalRouteJson`, `sealedRouteOf`, `checkScope`, `effectiveRoutes`;
   - evidence readers: `assignmentChecksForRun`, `changedFilesOf`;
   - inputs: `finishRun`, `recordRunCheck`, `writeRunRoute`, `recordRunModelReported`, `recordExecClass` and its
     dispose.ts caller, the completion `recordAction` in assignment.ts, `createResultRevision`;
   - consumers: `saveScope`'s rule/trial step, `sealScopeApproval`, `admitRun`, the six config writer methods.
3. **Writers enforce their own invariants.** `route-store.ts` functions refuse:
   - a rule write without a re-proved authority object;
   - a reservation consume without the sealed digest;
   - an exposure event out of order.

   A new caller therefore can't skip a guard that lives in its caller.
4. **Architecture scan, run by the installed plane** (`routingHookProblem`, called beside `evalHookProblem`, so a
   candidate can't edit it). Any SQL text that writes `route_record`, `route_rule`, `route_exposure*`,
   `route_trial_reservation`, `run_cohort`, `models_generation`, `run.exec_class`, `task_ref.revision_origin` or
   `phase_*`, outside `route-store.ts`, the six store methods and the migration block, needs a person.
5. **Attack tests** (`test/attacks/results-routing-*.test.ts`). Each candidate leaves the scorer unchanged and must
   need a person:
   - an eligibility change in `selectBuildLeg`;
   - an `if (false)` around the trial check in `sealScopeApproval`;
   - a new file with `INSERT INTO route_rule`;
   - a direct `UPDATE phase_config`;
   - a changed `exec_class` mapping;
   - a caller passing `origin: 'person'` from the flow path. The hook test pins each caller's origin expression.

Records read only Toolroll's rows: never worktree files, park payloads, agent reports or lead tool calls.

## Schema: all in slice 1, v148 (item 12)

- New tables: `run_cohort`, `route_record`, `route_rule` (with `grant_json`, price snapshot, dependency generations,
  `generation`), `route_exposure`, `route_exposure_event`, `route_trial_reservation`, `models_generation`.
- New columns: `run.exec_class`, `task_ref.revision_origin`, `project.suggest_models` (default 1).
- Partial unique index for one winner per cohort.
- `V148_ADDED_COLUMNS`, `HISTORY_RULES` entries (toolroll-update.ts:433), and `UPDATE_SAFE_MIGRATIONS`.

Tests (`migration-v148-results-routing.test.ts`):
- a fresh store;
- v147 → v148;
- interrupted and re-run;
- the update rehearsal.

Pre-v148 runs have no snapshot and are not counted ("started before results were recorded").

## Slices (each ships alone; unit tests + `scripts/results-routing-journey.mjs` steps, desktop and phone)

1. **Records, read-only.**
   - What ships: all schema, `exec_class`, `revision_origin` with every caller, `run_cohort`, the evaluator, route
     v3 parsing (no producer yet), protection items 1–5, `models results`, and a "Result record" line on the task.
   - Tests (`route-results.test.ts`):
     - each state and reason;
     - **two timeouts then success → rejected**; one setup failure then success → counted;
     - a missing `exec_class` counts as model;
     - a repair run on another model → mixed models; a revision re-sized large → mixed cohort;
     - unreadable diff → unknown; protected path → protected;
     - `proof machine`, landed without a merge, and an automatic-review revision under a mode signer are not
       person acts;
     - a follow-up check re-evaluates;
     - the migration set and the attacks.
   - Journeys:
     - the record moves pending → provisional → mature;
     - **feedback → revision**: a person requests changes, a revision is filed with origin person, and the record
       reads rejected; an automatic-review revision leaves it unchanged;
     - empty state, and a long project name on phone.
2. **Earned rules.**
   - What ships: suggest, accept, the `selection` producer, `selectBuildLeg` precedence, the generation bump and
     pause, switch-off, held tasks, exposure with events, the evidence line, Settings, CLI, chat, the local-owner
     doors.
   - Tests (`route-rules.test.ts`):
     - threshold edges;
     - pending never triggers;
     - trigger ordering is deterministic;
     - precedence: pin, override, rule and headroom-skip;
     - repair-row provider mismatch refuses;
     - large, risky and strict tasks are untouched;
     - **a change away and back pauses** (generation);
     - a `control-setup` write pauses dependent rules;
     - a switch-off racing a config write: one wins, and the rule is never switched off on stale evidence;
     - a held task refuses with no strike, and a manual-off task keeps its sealed model;
     - re-filing five times → one exposure;
     - the authority matrix: person, local owner (exact act only), lead token, remote token, revoked generation,
       Passwordless on and off.
   - Journeys:
     - accept, then a new task routes to Haiku with the line;
     - an approved task keeps its model;
     - two rejected → switch-off, the held task and Needs you;
     - a **stale offer** refuses with "out of date";
     - a **price-changed error state**;
     - chat and screen counts match.
3. **Trials.**
   - What ships: reservations, the trial selection, person-only seal and admission.
   - Tests (`route-trials.test.ts`):
     - at 9 of 10, two concurrent filings → one place;
     - admission racing cancel → exactly one of consumed or released;
     - re-file racing admission;
     - repeated saves → one reservation;
     - a retry or repair doesn't consume again;
     - a released place can't be consumed;
     - two concurrent trial starts → one (winner index);
     - every non-person basis is refused at seal and at admission.
   - Journey: start a trial; a filed task waits for a person; the count moves; stop.
4. **Spend.**
   - What ships: the Suggestions block and the `toolroll spend` lines.
   - Tests: completeness counts, hidden below 5, kinds never added, remediation included.

## Open decisions

None. Alex decided D1–D4. The numbers (10 records, 90%, 14 days, the 5/10 windows, 90-day expiry) are recommendations
he can change before slice 2. They are sealed per grant, so a change never alters an existing rule's terms.

## Codex round 2 ledger (item → mechanism → hook → test)

| # | Mechanism | Hook | Test |
|---|---|---|---|
| 1 | Required `origin` on `createResultRevision`, a per-caller table, stored as `task_ref.revision_origin`; `allowMode` never read | result-actions.ts:82; the 9 callers listed | hook test pinning each caller's origin; the feedback → revision journey; the flow-origin attack |
| 2 | `run.exec_class` written from the raw reason before normalization; missing = model | dispose.ts:372 | "two timeouts then success → rejected"; "setup then success → counted" |
| 5 | Builder **and** repair runs; same cohort key and same model across the family, or not counted with a reason | `run_cohort` write at store.ts:15642 | repair on another model; revision re-sized large |
| 6 | `models_generation` bumped inside the six writer methods, which also pause dependent rules; switch-off re-reads generations, grant and evidence in one transaction, with CAS on `generation` | store.ts:13786/13797/13837/13846/13878/13889 | change away and back; control-setup pause; switch-off vs config race |
| 7 | Pre-dispatch eligibility from sealed facts only; post-build `changedFilesOf` gives clean, protected or unknown; only clean is compared | `run_cohort`; result-completion.ts:37 | unreadable diff → unknown; protected path → protected |
| 8 | Policy paths incl. the single writer module; pinned decision, reader, input and consumer bodies; self-guarding writers; an installed-plane SQL scan | release-auto.ts:192; beside `evalHookProblem` | attacks: eligibility change, `if (false)` guard, new writer, direct `phase_config` SQL, `exec_class` remap |
| 9 | One exposure per (task, rule) plus append-only events; decline counts closed exposures; ships in slice 2 | `saveScope`, `sealScopeApproval`, cancel | re-file ×5 → one exposure; decline trigger |
| 11 | Two doors; off and dismiss accept a person or a local owner with the exact in-flight act; toggle classified; inventories wired | local-owner.ts:26/:140/:183; route-table `localAct`; operate.ts:1549 | authority matrix; adapter-inventory test |
| 12 | Feedback → revision, stale-offer, price-changed error, empty and long-name journeys; race cases | scripts/results-routing-journey.mjs | the journeys listed per slice |
| 13 | One precedence order (pin > override > trial > rule > configured > headroom-on-configured), used by preview, `checkScope`, accept and filing; repair provider check; one winner per cohort | phase-routing.ts `recommendRoute`; model-choices.ts:144/:271/:281 | precedence and headroom-skip; repair mismatch; winner index |
| 14 | Route v3 `selection` with rule id and generation, or reservation id, in the digest; held, kept or never substituted at admission | contracts/route.ts:48; store.ts:15386 | held task refuses with no strike; manual off keeps the sealed model |
| 15 | Reservation ids with reserved, consumed and released CAS states; consumed once at admission against the sealed digest; only reserved can be released | `saveScope`; store.ts:15386 before :15610 | concurrent filings; admission vs cancel and re-file; retries; repeated saves |
| 16 | Grant JSON seals the parameters, policy version and cutoff; deterministic ordering; only decided records; maturity evaluated only at ≥ 10 decided | `route_rule.grant_json` | pending never triggers; ordering; edges |
| 3, 4, 10 | Closed in round 2 | — | — |

Round 1's ledger is in git history (6d30d56f).
