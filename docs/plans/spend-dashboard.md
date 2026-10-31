# Spend dashboard — plan

Status: plan, revised after Codex review round 1 (NO-GO, 2026-10-31). Revised to the smaller v1 that review proposed.
Branch `spend-dashboard` (off `main` at 529ddeba, after Release 0.9.82). Nothing in `src/` is changed by this
document.

## What Alex asked for

> "Cost should be a dashboard or something with some settings to manage spend and set model logic. Make it accessible
> from settings too."

Each release should matter to a tech-forward early adopter and use current models. Where Toolroll picks a model, the
default is the newest Claude: Opus 5.5 (`claude-opus-5-5`), Sonnet 5.5 (`claude-sonnet-5-5`), Haiku 5.5
(`claude-haiku-5-5`).

## In one screen

v1 is three slices. Each ships on its own.

1. **An honest Spend page.**
   - API dollars, plan usage and unknown cost are kept apart and never added together.
   - Billing nobody proved shows as unknown, not as covered by a plan.
   - Breakdowns by project, model and role, plus a CSV export.
   - A Settings → Spend entry.
2. **Monthly limits that say exactly what they do.** The wording is: "Pause new API work when recorded charges reach
   this amount. Running work may exceed it."
   - Fresh state is read at admission and again right before launch.
   - Every paid provider entry point is inventoried. Gates are added where missing, and anything left out is disclosed
     on the page.
   - Unknown cost follows one matrix (§2.3).
3. **One Models editor (Settings → Models).**
   - Operator only, with step-up and the CSRF guard.
   - Every write is one transaction, ledgered before → after, clears included.
   - A preset shows its exact diff before it applies. Model ids are exact.
   - Sealed profiles are never touched.

Deferred: daily limits, configurable alert marks, project-approver permissions, adding Claude 5.5 to the direct-API
price table, historical match verdicts, headroom promises, cost per task, cache analytics. See "Later".

## Facts the design stands on (verified)

| Fact | Where |
|---|---|
| Per-run accounting: provider, chosen `model`, `modelReported`, turns, cache-aware usage, amount `api` / `subscription` / `unknown` | src/store.ts:25266 `runAccounting` |
| Per chat request: the same, plus `providerTurns`, `reportedCostUsd`, `billingReported` | src/store.ts:25293 `chatTurnAccounting` |
| The reported model is already recorded per run (`recordRunModelReported`) and per chat request. It isn't yet shown next to the chosen model on these screens | src/store.ts:25253; src/reported-usage.ts:21 |
| How an amount is decided: a guessed billing (`basis: default`) or a cost the provider never reported reads `unknown`, **before** billing is considered. So `unknown` does not by itself mean API spending | src/reported-usage.ts:98 `runAmountOf`, :115 `chatTurnAmountOf` |
| A lead step is a `chat_turn` row with `kind = 'mate-step'` and `mate_turn` set (fleet chat is `kind = 'chat'`) | src/store.ts:1905, :20080 |
| Today's aggregation counts runs by start time, and a lead turn once at its parent `mate_turn.created_at` | src/spend.ts:239–306 `spendItems` |
| Subagent turns and flow drafts stamp `claudeMachineBilling`, which falls back to subscription **without evidence** | src/store.ts:19227, :19234; src/spend.ts:52 |
| Subscription chat and subagent work is counted as `$0` on today's page and in budget sums | src/spend.ts:289; src/spend-ui.ts:75 |
| `budgetStates` adds `null` amounts as 0 | src/spend.ts:338 |
| The gate refuses only when the **next** provider can't be priced. Claude always reads as priceable | src/store.ts:16386; src/spend.ts:58 |
| The gate reads a month total cached for 5 s, so concurrent workers can see the same headroom | src/store.ts:16354, :16367 |
| Flow steps build one gate per pass and reuse it after earlier steps spend | src/flow-steps.ts:101–102, :144 |
| `invokeAgent`'s budget check at src/invoke.ts:341 is inside the **ACP-only** branch (from :320) | src/invoke.ts:320–342 |
| Build reviews call `invokeAgent` with no budget check and no dollar cap | src/build-review.ts:189 |
| Planner and scout runs call `invokeAgent` (src/planner.ts:920, :1081; src/scout.ts:455, :653). The plan path is behind the build-admission gate at src/operate.ts:3002; scout needs confirming | src/operate.ts:3172 |
| Task sizing can ask OpenRouter (`jevSizer`). Its cost is not recorded | src/task-sizing.ts:125 |
| A monthly remainder becomes a dollar cap **only** for providers that can hold one. Codex runs past the threshold uncapped unless an explicit per-run cap applies | src/operate.ts:3526–3530 |
| Budget writes check the password in the handler (`authenticateApprover`) behind a `step-up` route (browser only) | src/server/settings.ts:803; src/server/route-table.ts:61, :364 |
| The route policy checks caller and capability only. Password and fresh proof are the handler's job | src/server/route-policy.ts:12 |
| The Models POST handler does no step-up | src/server/settings.ts:1446 |
| Models routes inherit `limited: "deny"` | src/server/route-table.ts:113, :287 |
| `setPhaseConfig` records policy apart from its update. `setPhaseTierConfig` and the clear methods record nothing | src/store.ts:13483, :13535, :13497 |
| Project builders inherit installation light and strong tiers. Repair can come from the installation | src/agentconfig.ts:284–340 |
| A route is sealed at filing. Runs are stamped from the sealed route | src/store.ts:8490–8530, :15510–15524 |
| A legacy build review with no sealed route resolves the **current** review agent | src/build-review.ts:259 |
| A subagent with no model of its own inherits the lead's model when the lead runs on the Claude subscription | src/subagent-work.ts:49–51 |
| Aliases (`opus`) resolve against the **current** catalogue | src/model-catalog.ts:188 |
| Headroom routing happens at filing, and keeps the original provider when no alternate has room | src/phase-routing.ts:548 `withHeadroom` |
| Eval attempts gather several invocations. `usage_unknown` can mean "subscription usage not reported" next to known API charges. Eval worlds use their own database, so nothing lands twice in the installed store | src/store.ts:650–718; src/evals.ts:394; src/eval-world.ts:1–6 |
| Eval spend is recorded, never capped (owner, 2026-10-30) | src/store.ts:653 |
| Alerts run once a minute at 50/80/100% per monthly budget. A person's budget alerts that person | src/budget-alerts.ts:12–40 |
| Task links are `/t/<id>` (`taskHref`); runs are `/r/<id>` | src/server/http.ts:240 |
| Protected files: `reported-usage.ts`, `run-efficiency.ts` (EVAL_POLICY), and the pinned Store bodies | src/release-auto.ts:192; src/eval-hooks.ts:65–86 |
| Schema is v141 (src/store.ts:1088). v142 is reserved by evals D1 | docs/plans/evals-nightly.md:604 |

**No slice edits a protected file or a pinned body.** New code imports the pure functions `runAmountOf`,
`chatTurnAmountOf` and `usageOf`. `invoke.ts` gains a call, not a change to a hooked call.

## Words (UI copy)

- **API dollars**: recorded charges for work billed to an API key.
- **Plan usage**: work whose own records prove it was billed to a subscription. Shown as the provider's reported usage
  (`$4.10 of usage at API prices`) or "usage not reported". Never `$0`, and never added to dollars.
- **Unknown**: billing not proved, or a cost that wasn't recorded. Shown as a count. Where a saved charge exists, it is
  shown as "counted as $X (estimated)". There is no "at least".
- **Monthly limit**, with **When reached**: `Alert only` / `Pause new API work`. The help line under it says "Pause new
  API work when recorded charges reach this amount. Running work may exceed it."
- **Chosen** / **Ran on**.

Amber is used only for "waits on you": a limit that is holding work. Approaching a limit uses the neutral or
`--so-warning` tone.

---

## Slice 1. The honest Spend page (read-only, no schema)

**User value:** one page that answers "what did my agents cost this month, on what, and for which project". API
dollars, plan usage and unknown cost are kept apart, and the page works on a phone.

### 1.1 Reader: `src/spend-report.ts` (new, not protected)

`spendRows(db, from, to)` returns one row per piece of work:

```
{ at, source, role, project, person, subagent, taskId, runId, provider, modelChosen, modelReported,
  billing, amount, charge }
```

- `source` is one of run, chat, lead, subagent, draft, sort, eval.
- `billing` records the evidence: confirmed subscription, API key, or not proved.
- `amount` is a `ReportedAmount`.
- `charge` is the amount the limit counts: `{ microusd, basis: reported | settled | estimated } | null`.

Attribution is defined **once**, as `spendItems` does it today: runs by start time, a lead turn at its parent's
creation time, and the rest by their own time. The page, the CSV, `budgetStates` and the alert pass all read this one
function. `spendItems` becomes a thin adapter over it, so the gate and the page never disagree.

- **Runs.**
  - Columns are the ones `runAccounting` selects (src/store.ts:25270), joined to `task_ref` for project and filer.
  - `amount` comes from `runAmountOf`; `role` is `run.role`.
  - `billing` comes from `run_spend.billing` plus `run.billing_basis`. `default` reads as not proved.
  - `charge`: the settled `run_spend.microusd` with its `source` (reported or estimated, frozen at settlement by
    `settleRunSpend`); otherwise the run's saved conservative `cost_usd`, labelled estimated. It is never re-priced at
    today's catalogue.
- **Chat and lead.**
  - `chat_turn` columns as `chatTurnAccounting` selects them (src/store.ts:25297), with the amount from
    `chatTurnAmountOf`.
  - `kind = 'chat'` is fleet chat. `kind = 'mate-step'` rows are grouped under their `mate_turn` and attributed at the
    parent's `created_at`, counted once.
  - `charge` is `settled_microusd`.
- **Subagent turns and drafts.** Billing reads **not proved**, because the stamp is a machine default. If a cost is
  reported, `charge` is that cost labelled "estimated (billing not confirmed)"; otherwise there is none.
- **Sort steps** are OpenRouter API work: the reported cost, or unknown.
- **Evals.**
  - The `eval_invocation` rows are summed per attempt, and each amount kind is kept: API micro-dollars, subscription
    micro-dollars, and the unknown count.
  - A campaign with `spending_unknown = 1` adds one unknown.
  - Role is `evals`. Evals are never counted toward limits.

`spendReport(rows)` is pure. It returns:

- the three totals;
- breakdowns by project, model, role and person;
- the 10 runs with the largest API dollars, each linking to `/t/<id>` and `/r/<run>`.

The model breakdown is keyed on the reported model, falling back to the chosen one, labelled "not reported". Where
the chosen model was an alias, the label reads "floating choice `opus` → `claude-opus-5-5`". There is no match
verdict, because no historical alias target was saved.

### 1.2 Page: rewrite `spendHtml` (src/spend-ui.ts)

The page reuses the existing `.spend` article, the `.spend-grid` tables, the `.budget` limit rows, the plan-window
tiles from src/limits-ui.ts, and the Operations Ledger tokens. Sections:

1. **Header:** month ← →, then CSV. Labelled "UTC month".
2. **Three figures, never summed:** API dollars · Plan usage · Unknown. Each carries
   `data-amount-kind="api|subscription|unknown"`.
3. **Limits:** read-only rows, with "Change" → Settings → Spend.
4. **Breakdowns:** project, model, role (builder, repair, planner, reviewer, scout, lead chat, chat, subagents, flows,
   evals), person.
5. **Most expensive runs.**
6. **Not counted here.** The disclosure list from §2.2, for anything that isn't recorded.

On a phone, the figures stack, the tables become two-column rows, and there is a 16px gutter. The CSV gains `role`,
`model_reported`, `billing`, `amount_kind` and `charge_basis` columns. The `?month=` links keep working.

### 1.3 Access

`/spend` stays instance-operator only.

**Settings → Spend** is a tile in the Agents group, next to Models (src/server/render-settings.ts:600). It opens
`/settings/spend`, a GET route with the same roles. That page shows the limits editor (slice 2; before slice 2 it is
the existing editor, moved) and a Models summary card that links to Settings → Models.

### 1.4 Tests

- **Contract.** For fixture rows of every source, `amount` deep-equals `runAccounting` / `chatTurnAccounting` for runs
  and chat requests. The fixtures cover:
  - API reported
  - API with unknown cost
  - `basis: default`
  - subscription with and without usage
  - `billingReported: api-key`
  - a `MODELS_JOIN` model
  - a lead turn with two mate-steps
  - a subagent turn and a draft that carry the machine-default stamp: these must read **not proved**, never
    subscription
  - an eval attempt that mixes API, subscription-unreported and unknown invocations
- **Accounting.** Plan usage and unknown are never added to API dollars. A lead turn counts once, at its parent's
  time. `spendItems` and `spendRows` agree on attribution.
- **What must never show.** An unknown or subscription amount never renders as `$0`, checked through
  `data-amount-kind`.

---

## Slice 2. Monthly limits with accurate words and real coverage (schema v143)

**User value:** "pause new API work on this project once it has spent $300 this month". Every paid start checks
fresh numbers, and the page says plainly what isn't covered.

### 2.1 What a limit promises

The existing monthly budgets stay as they are: installation, project, person or subagent; `hard_stop` means pause,
otherwise alert only. They change in four ways:

- **Wording.** Everywhere a limit shows: "Pause new API work when recorded charges reach this amount. Running work may
  exceed it." A run already started keeps whatever per-run cap its provider supports. A provider with no native cap
  (Codex) is not capped by the monthly remainder (src/operate.ts:3526–3530), and the page says so on the limit.
- **Fresh at admission.** The admission paths (src/operate.ts:2708/:3002, the builder repair paths, chat, subagents)
  read the month without the 5-second cache. `budgetGate(now, { fresh: true })` skips `monthSpendCached`.
- **Fresh right before launch.** `invokeAgent` gains one launch check for **every** provider, not only ACP: a fresh
  gate for the run's budget subject, billed as `readAuthModeStrict` says. It refuses with reason `budget` before any
  process starts. That covers builds, repairs, planner, scout and build reviews in one place.
- **Flow steps re-gate per step**, instead of reusing one gate for the whole pass.

A real maximum would need atomic reservations across workers, outstanding-work accounting and provider capability
handling. That is deferred, and the wording above doesn't claim it.

### 2.2 Paid entry points: inventory

| Entry point | Records spend? | Gate today | v1 |
|---|---|---|---|
| Builds and repairs (`operate.ts`, `builder.ts` → `invokeAgent`) | yes (run) | admission | + fresh admission, + launch check |
| Planner (`planner.ts` → `invokeAgent`) | yes (run) | admission (operate.ts:3002 path) | + launch check |
| Scout (`scout.ts` → `invokeAgent`) | yes (run) | confirm at build | + launch check |
| Build review (`build-review.ts:189` → `invokeAgent`) | yes (run) | **none** | + launch check (refusal: "not reviewed: a monthly limit holds API work") |
| ACP agents (`invoke.ts:341`) | yes (run) | launch (ACP only) | unchanged, now part of the general check |
| Fleet chat and lead (`converse.ts`, `subscription-chat.ts`) | yes (chat_turn) | admission (store.ts:14355, :20005) | + fresh |
| Subagent turns (`subagents.ts`) | yes (subagent_turn) | admission (subagent-work.ts:61) | + fresh |
| Flow drafts (`flow-draft.ts`) | yes (side_spend) | **none** | + gate before the draft |
| Flow Sort (`flow-sort.ts`) | yes (decision cost) | one gate per pass | re-gate per step |
| Task sizing on Claude (`claudeSizer`) | confirm at build | none | gate. If its cost isn't recorded, disclose it |
| Task sizing on OpenRouter (`jevSizer`, task-sizing.ts:125) | **no** | none | gate (skip sizing while a covering pausing limit holds; the size reads unknown and routes routine). **Disclosed** as "not counted" |
| Memory pass (`memory-pass.ts:179`, uses the chat model) | confirm at build | none | gate. Disclose if it isn't recorded |
| Evals | yes (eval tables) | never capped (owner) | listed as "not limited" |

The page's "Not counted here" list names every row marked **no**, or still unconfirmed when the slice ships. The slice
isn't done until each "confirm at build" row is settled in this table.

### 2.3 Unknown cost: the matrix

| Billing evidence | Saved charge | Counts toward a limit | Holds new API starts under a pausing limit? |
|---|---|---|---|
| API key | reported or settled | the charge | when the total reaches the limit |
| API key | estimated (settled estimate or saved conservative `cost_usd`) | the charge, labelled estimated | when the total reaches the limit |
| API key or **not proved** | **none** | nothing can be counted | **yes**: covered API starts hold until the operator marks it reviewed (below) |
| Not proved (machine-default subagent or draft) | reported cost | the cost, labelled "estimated (billing not confirmed)" | when the total reaches the limit |
| Subscription, **confirmed** by the work's own records (`billing_basis = evidence`, or `billingReported = subscription`) | — | nothing (it's plan usage) | never |

- The gate's existing refusal for a provider it can't price at all stays.
- **Mark as reviewed.**
  - v143 adds `budget.uncounted_reviewed_at`.
  - Work with no usable charge from before that time stops holding.
  - The action is a step-up operator act on Settings → Spend, ledgered with the count it cleared.
  - It doesn't make that work free: it stays in the Unknown figure.

### 2.4 Who may change limits

Unchanged: an instance operator, with step-up in the handler (`authenticateApprover`; the session counts as proof
when Passwordless is on). Browser only, so API tokens, the lead token, MCP and chat bridges are refused. Every change is
ledgered before → after (src/store.ts:16248). Person, subagent and project limits are all operator-owned.

### 2.5 Alerts (the existing monthly pass, reworded)

- The pass stays once a minute at 50/80/100%. The page never says "at once".
- The 100% notice for a pausing limit reads "`<limit>`: API work is paused" (exhausted). When work is held for
  uncounted cost instead, the notice reads "Some costs could not be counted". Both links read **Review limit**, to
  `/settings/spend`.
- Holds come from current state. Raising one limit says "still held by `<other limit>`" when another limit still
  holds.
- Actionable notices go to instance operators. A person's own budget also gives that person an information copy with
  no action.
- **Needs you.** One amber Inbox row per holding limit (operator only), with the action **Review limit**. It goes away
  when the hold clears.
- **Telegram and other chat bridges** carry the message and link only. Changing a limit needs a step-up browser act.

### 2.6 Schema

v143: `budget.uncounted_reviewed_at TEXT` (nullable). Added to `UPDATE_SAFE_MIGRATIONS` with
`src/migration-v143-spend-limits.test.ts`. If evals D1 hasn't taken v142 when this merges, take the next free number
and say so in the PR.

### 2.7 Tests

- **Migration.** Existing budgets read back unchanged, with `uncounted_reviewed_at` null.
- **Gate security:**
  - At 100% with pause, new API work is held at admission **and** at launch: builds, repair, planner, build review,
    flow draft, sort step, chat, subagent.
  - Confirmed subscription work passes.
  - Not-proved work with no charge holds until it is marked reviewed.
  - Estimated work counts at its saved charge.
- **Race.** Admission passes, then a concurrent settlement crosses the limit: the launch check refuses, and no process
  starts.
- **Flow.** Within one pass, a second Sort step is refused after the first one crosses the limit.
- **Attack.** A bearer token, the lead token and a Telegram callback cannot set a limit or mark one reviewed. A valid
  Passwordless session can.
- **Alerts.** The actionable notice goes to operators. The uncounted-cost wording appears only for that cause.

---

## Slice 3. One Models editor (no schema)

**User value:** "use the newest Claude models", set in one place and applied in one step. You see exactly what will
change first, and approved work is never touched.

### 3.1 The editor (Settings → Models, the only editor)

The page keeps today's per-role pickers (src/models-ui.ts). It adds:

- **Scope.** Installation, or one project.
- **Inherited values in words.** For example, "inherits the installation's light builder". This covers both tier
  inheritance and repair inheritance (src/agentconfig.ts:284–340).
- **Tiers behind a disclosure.** Builder light and strong, and planner strong. Alternates and fallback chains stay
  CLI-only and are described in words.
- **Presets** (D5). Choosing one shows the **exact diff** first: each row before → after, and every clear. Applying it
  is a second, step-up submit that carries the diff's digest.
- **Switch when the watch sees a newer model.** The existing notice (src/model-catalog.ts:366) leads to the same
  diff-then-apply flow.
- **Model ids are exact.** Aliases stay selectable, labelled "floating: moves to the newest version". Presets never
  write aliases.

The Spend page and Settings → Spend show a read-only summary card linking here.

### 3.2 One mutation boundary

`store.applyModelChoices(change, actor, now)` is the single write path for the console. The CLI's `config set` and
`config clear` move onto it too. In one transaction it:

1. **Authenticates.** The handler has already run `authenticateApprover` (step-up; the session counts when
   Passwordless is on). The route is `scope: "step-up"`, so it is browser only, and the CSRF guard
   (src/server/guards.ts:114) applies unchanged.
2. **Rechecks authority now.** The actor must be an instance operator for installation and project rows alike in v1.
   A project target must be a known project.
3. **Rejects stale input.** The submitted digest of the current rows for that scope must match what is stored, so two
   tabs can't overwrite each other.
4. **Validates the resulting configuration**, inheritance included:
   - exact ids;
   - no Gemini reviewer;
   - repair on the effective builder's provider at that scope;
   - every phase resolves exactly at installation scope, and at every project the change affects.
5. **Writes every row**, sets and clears.
6. **Ledgers before → after per row**, clears included. `setPhaseTierConfig` and the clear methods get policy entries
   through this boundary.

When a change moves a role to a different provider, the diff shows what that changes: billing (plan or key), whether
a dollar cap can be held, and network hosts.

**Also changed by lead defaults.** A subagent with no model of its own follows the lead's model on the Claude
subscription (src/subagent-work.ts:49–51). The diff lists the affected subagents when the lead model changes.

### 3.3 Sealed work stays sealed

- Model choices apply to **new filings**. No write here touches `scope`, its `approvedProfile` or digest, the repair
  model it sealed, `run_route`, an approval, a mode's terms, or a routine's or standing order's pin.
- **Exception, stated on the page:** a legacy build review with no sealed route uses the current review agent
  (src/build-review.ts:259).
- The page lists plans that were filed but are waiting for approval under the previous choice, with links. It never
  re-routes them.

### 3.4 Defaults where Toolroll picks a model

- The setup picker offers exact ids (src/setup-guide.ts:20, plus the setup inputs `control-setup.ts` receives) and
  preselects per D5.
- Task sizing (`SIZING_CLAUDE_MODEL`, src/task-sizing.ts:36) becomes `claude-haiku-5-5`.
- **Deferred:** the direct-API lead price table (src/converse.ts:48). Its integer-micro-dollar-per-token settlement
  and fixed cache ratios can't represent Haiku 5.5's tiers or Sonnet 5.5's cache-read price faithfully. The
  subscription lead isn't affected.

### 3.5 Routing in words (read-only)

The page describes routing with the existing projection (src/phase-routing.ts:786, :841). Headroom is described as a
preference at filing time. For example: "when a task is filed and Claude has used over 80% of its 5-hour window, an
alternate with more room is preferred; with no alternate, Claude is kept". It is never described as a limit or a live
fallback.

### 3.6 Tests

- **Sealed profiles (security).** After a filed and approved scope, a preset, a switch and a project override each
  leave its `approvedProfile`, `approvedDigest`, sealed repair model, route digest, the next run's stamp, and a
  routine's or standing order's pin byte-identical. A newly filed scope gets the new choice.
- **Mutation boundary (security):**
  - Refused: missing or duplicate CSRF; a foreign origin; a revoked session; a bearer or lead token; an approver who
    isn't an operator; an unknown project.
  - Refused: a stale digest, with nothing written.
  - A Passwordless session passes without a password. An SSO session passes through its own step-up.
- **Atomicity.** A preset that fails validation on its last row writes nothing. Every applied row and clear has a
  before → after ledger entry.
- **Contract.** A preset writes exactly its table as exact ids. `config show --json` reads them back.

---

## Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| D1 | Where model choices live | **One editor, Settings → Models**, with summary cards on Spend and Settings → Spend. Tiers sit behind a disclosure. |
| D2 | What happens at a limit | **Alert only or pause new API work**, called a recorded-spend threshold. A true cap (reservations) and "require approval" come later. |
| D3 | Unknown cost | **The §2.3 matrix.** Saved estimates count. Potentially billed work with no charge holds covered API starts until reviewed. Confirmed subscription work is exempt. |
| D4 | Who changes limits and models | **Instance operator only in v1, with step-up.** Project approvers come later, with target-scoped authorization. |
| D5 | Default models | **The owner's call. Two options below.** |
| D6 | Exact ids or aliases | **Exact ids.** Upgrades are explicit, through diff-then-apply. |
| D7 | Limits on subscription usage | **Defer.** Plan windows are shown as observations. Headroom is not enforcement. |
| D8 | Cheaper models near a limit | **Defer.** No automatic substitution. |

### D5: the two default sets

Token prices: Opus 5.5 is $4 in / $20 out per million tokens; Sonnet 5.5 is $2 / $10. That's 2× per token. A task's
real cost ratio varies, because Opus may need fewer turns.

- **(a) Opus first.** Opus 5.5 plans, builds and reviews by default. Repair follows the builder. An explicit
  **Economy** preset switches to Sonnet 5.5 for routine builds and Haiku 5.5 for small ones. Best results by default
  for early adopters. API-key users pay the higher token price on every build. Subscription users use up plan windows
  faster.
- **(b) Sized.** Sonnet 5.5 builds routine tasks, Opus 5.5 builds large or risky ones, Haiku 5.5 builds small ones.
  Opus 5.5 plans and reviews. Lower API dollars on routine work, using the sizing that already exists. Routine builds
  don't get the strongest model.

Both are offered as presets either way. D5 only picks which one setup preselects. Codex leaned toward (a).

## Schema

| Version | Slice | Change |
|---|---|---|
| v143 | 2 | `budget.uncounted_reviewed_at TEXT` (nullable) |

Slices 1 and 3 add no schema.

## Slices (each ships alone)

| Slice | Ships | User value |
|---|---|---|
| 1 | Honest Spend page, Settings → Spend entry | See API dollars, plan usage and unknown cost apart, by project, model and role, with a CSV, on desktop and phone |
| 2 | Monthly limits: accurate words, fresh checks at admission and launch, entry-point gates, unknown matrix, reworded alerts and a Needs-you row (v143) | A limit you can trust to pause new API work, and a clear list of what isn't covered |
| 3 | One Models editor: presets with diff, exact ids, single-transaction ledgered writes | Newest models in one step, without touching approved work |

Order: 1 → 3 → 2. Slices 1 and 3 can ship in the same release. Each slice runs only its affected tests while being
fixed; the full suite runs on GitHub CI and in the release check. Before it is accepted, each slice gets the desktop
and phone journey with its failure states.

## Later (not in v1)

- Daily limits (one attribution rule; period in every lookup, cache key and CLI mutation; midnight and rollover tests)
- Configurable alert marks
- Project-approver permissions
- A real spending cap with atomic reservations
- "Require approval" per task
- Direct-API 5.5 prices with exact tier and cache settlement
- Historical match verdicts (needs the alias target saved at run time)
- Cost per finished task
- Cache analytics (needs cache prices)
- Pausing at a share of a plan window
- Spend-aware routing
- Recording the cost of OpenRouter sizing

## Review round 1 (Codex, NO-GO): what changed

| # | Finding | Verdict | Where closed |
|---|---|---|---|
| 1 | Pause doesn't cover every paid entry point (the invoke gate is ACP-only; build review and sizing are ungated) | Accepted, verified (invoke.ts:320–342, build-review.ts:189, task-sizing.ts:125) | §2.1 general launch check in `invokeAgent`; §2.2 inventory with gates and disclosures |
| 2 | Threshold, not a race-proof cap; 5 s cache; flow gate per pass; no-cap providers | Accepted, verified (store.ts:16354, flow-steps.ts:101, operate.ts:3526) | §2.1 wording, fresh at admission and launch, per-step re-gate; a real cap goes to Later |
| 3 | Unknown spend counts as nothing; `unknown` ≠ API | Accepted, verified (spend.ts:338, reported-usage.ts:98) | §1.1 billing kept apart from amount and charge; §2.3 matrix, plus "mark reviewed" (v143) |
| 4 | Subagent and draft billing is a machine default, not evidence | Accepted, verified (store.ts:19227/:19234, spend.ts:52) | §1.1 reads "not proved"; §1.4 contract fixtures for these sources |
| 5 | A step-up route doesn't authenticate; Models is `limited: deny` | Accepted, verified (route-policy.ts:12, settings.ts:1446) | §3.2 handler step-up plus one mutation boundary; operator-only (D4), so no project-limited routes; §3.6 tests incl. Passwordless passes |
| 6 | Presets aren't atomic or fully ledgered; inheritance; sealed-profile coverage; legacy review | Accepted, verified (store.ts:13483/:13535, build-review.ts:259) | §3.2 one transaction, stale digest, ledger incl. clears, diff first; §3.3 legacy-review exception; §3.6 profile/digest/repair/pin test |
| 7 | One amount per eval attempt loses information; duplication question | Accepted, verified (evals.ts:394, eval-world.ts:1–6) | §1.1 per-invocation aggregation keeps kinds apart; separate DB stated |
| 8 | 5.5 rows in the lead price table can't settle honestly | Accepted | §3.4 deferred |
| 9 | Daily attribution and CLI removal | Accepted by deferral | Daily limits moved to Later with the stated requirements |
| 10 | Estimates re-priced at today's prices; "at least"; cost per task; cache | Accepted | §1.1 saved charges with their basis, never re-priced; "at least", cost per task and cache cut |
| 11 | Historical alias verdicts; headroom overpromised | Accepted, verified (model-catalog.ts:188, phase-routing.ts:548) | §1.1 "floating choice → reported"; §3.5 filing-time preference wording |
| 12 | Daily alerts can't ship apart; misleading notices; recipients | Accepted | Daily deferred; §2.5 holds from current state, "Review limit", "Some costs could not be counted", notices to operators, minute pass stated |
| T1 | The reported model is already recorded | Accepted | Facts table: "not yet shown together" |
| T2 | Lead discriminator is `mate-step` | Accepted, verified (store.ts:1905) | §1.1 |
| T3 | Links are `/t/` and `/r/` | Accepted, verified (http.ts:240) | §1.1 |
| T4 | `control-setup.ts` doesn't define defaults | Accepted | §3.4 setup picker plus inputs |
| T5 | Subagents inherit the lead model | Accepted, verified (subagent-work.ts:49–51) | §3.2 the diff lists affected subagents |
| T6 | 2×, not 5×, token price | Accepted | D5 options |
| D1–D8 | Codex's views | D1, D2, D6, D7, D8 agreed; D3 changed to the matrix; D4 simplified to operator-only; D5 given to the owner with both options | Owner decisions table |

No findings were rejected.
