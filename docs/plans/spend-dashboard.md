# Spend dashboard — plan

Status: plan, 2026-10-31. Branch `spend-dashboard` (off `main` at 529ddeba, after Release 0.9.82). Nothing in `src/` is
changed by this document.

## What Alex asked for

> "Cost should be a dashboard or something with some settings to manage spend and set model logic. Make it accessible
> from settings too."

Each release should matter to a tech-forward early adopter and use current models. Where Toolroll picks a model, the
default is the newest Claude: Opus 5.5 (`claude-opus-5-5`), Sonnet 5.5 (`claude-sonnet-5-5`), Haiku 5.5
(`claude-haiku-5-5`).

## In one screen

Most of this already exists. It just isn't joined up, and in one place it isn't honest:

- A **Spend page** (`/spend`) already shows the month's total, budgets, and breakdowns by project, person, subagent and
  model, plus a CSV export (src/spend-ui.ts:50, :79). It counts subscription work as **$0** (src/spend-ui.ts:75,
  src/spend.ts:289). That breaks the rule 0.9.82 set: API dollars, subscription usage and unknown are three separate
  amounts, and none of them reads as $0 (src/reported-usage.ts:88–125).
- **Monthly budgets** already exist for the installation, a project, a person or a subagent. Each is "alerts only" or
  "stops new API work at 100%". Alerts fire at 50/80/100% (src/spend.ts:123, src/budget-alerts.ts:12). The limit is
  enforced at admission and again when work starts (src/store.ts:16367 `budgetGate`, src/operate.ts:3002,
  src/invoke.ts:341, src/builder.ts:3163/:3389, src/subagent-work.ts:61, src/flow-steps.ts:144, chat
  src/store.ts:14355/:20005).
- **Model choices** already exist: Settings → Models sets the installation's default agent for each role
  (src/models-ui.ts:78, src/server/settings.ts:1446). Routing by size and headroom picks between configured tiers
  (src/phase-routing.ts:355). A route is sealed at filing (src/store.ts:8490–8530), and a run is stamped from the
  sealed route (src/store.ts:15510–15524). Nothing records or shows the **reported** model next to the **chosen** one.

v1 is four slices:

1. Rebuild the Spend page on the 0.9.82 accounting, with day/week/month views, roles, top runs, cost per finished task
   and cache use.
2. Spend settings: daily limits beside monthly ones, a plain "what happens at the limit" choice, and honest handling of
   unknown cost.
3. Model choices: the newest-model defaults, per-project overrides, the automatic routing shown in words, and the
   reported model beside the chosen one.
4. Limit notifications: Needs you plus the usual places (Telegram etc.).

No new provider calls anywhere. Every number comes from records Toolroll already keeps.

## Facts the design stands on

| Fact | Where |
|---|---|
| Per-run accounting: provider, chosen `model`, `modelReported`, turns, cache-aware usage, and an amount of `api` / `subscription` / `unknown` | src/store.ts:25266 `runAccounting` |
| Per chat request: the same, plus `providerTurns`, `reportedCostUsd` and `billingReported` | src/store.ts:25293 `chatTurnAccounting` |
| How an amount is decided. A guessed billing (`basis: default`) or a cost the provider never reported is unknown. Subscription work's reported cost is **usage**, not dollars | src/reported-usage.ts:98 `runAmountOf`, :115 `chatTurnAmountOf` |
| Cache split per provider. Claude reports cache reads and writes; Codex reports cache reads only | src/run-efficiency.ts:51 `usageOf` |
| `run.role` ∈ builder, repair, planner, reviewer, scout | src/store-baseline.ts:897 |
| `run_spend`, `budget` (monthly only, unique live row per scope), `provider_limit` (plan windows), `side_spend` (flow drafts) | src/spend.ts:110–162 |
| The current aggregation for the page and budgets (runs, subagent turns, chat and lead turns, drafts, Sort steps) | src/spend.ts:239 `spendItems` |
| Eval spend is kept per attempt as `api_microusd` / `subscription_microusd` / `usage_unknown`. Owner, 2026-10-30: eval spend is recorded, never capped | src/store.ts:650–718 (V141_SCHEMA) |
| Budget changes go through a step-up (browser only, so API and lead tokens are refused) and are ledgered before → after | src/server/route-table.ts:364, :61; src/store.ts:16248 |
| The Spend page is instance-operator only, and scoped logins don't see it | src/server/route-table.ts:217, src/server/chrome.ts:889–891 |
| A model choice is an approver act from a browser, with no step-up | src/server/route-table.ts:410–413 |
| Precedence: project row, then installation row. Review inherits plan. With nothing set, the provider is Claude and the model is null, which isn't exact, so the scope files unresolved | src/agentconfig.ts:60–124, :284 |
| Light / strong tiers and alternates per provider are set from the CLI only (`config set <phase> --tier …`) | src/store.ts:13535, src/operate.ts:5490–5530 |
| Headroom routing: past 80% of the 5-hour window or 90% of the weekly window, a provider gives way | src/phase-routing.ts:215–270 |
| The Models page already says: "New tasks use these. Approved tasks keep the agents they were approved with." | src/models-ui.ts:78 |
| Claude aliases (`opus`, `sonnet`, `haiku`) are valid "exact" ids, but they move when Anthropic ships a new model | src/model-catalog.ts:187–210, src/setup-guide.ts:20 |
| The lead's direct-API price table has no 5.5 ids, so a priced chat config can't choose them today | src/converse.ts:48–56 |
| Task sizing asks `haiku` | src/task-sizing.ts:36 |
| The model watch sends "model-available" when a new model lands | src/model-catalog.ts:366 |
| Protected files: `reported-usage.ts` and `run-efficiency.ts` (EVAL_POLICY), plus the pinned Store bodies `runAccounting`, `chatTurnAccounting`, `recordUsage`, `settleRunSpend`, `fixRunBilling`, `finalizeChatTurn`. A change to any of them needs a person | src/release-auto.ts:192, src/eval-hooks.ts:65–86 |
| Schema is v141 (src/store.ts:1088). v142 is reserved by evals D1 (docs/plans/evals-nightly.md:604) | — |
| Settings tiles live in `SETTINGS_GROUPS` | src/server/render-settings.ts:600 |
| Notifications go through the outbox (`enqueueNotification`, closed `pushClass`, machine-minted link). Delivery to Telegram, Slack, Discord, Teams and phone push is the existing routing | src/store.ts:14805 |

**This plan touches no protected file.** The new reader imports the pure functions `runAmountOf`, `chatTurnAmountOf`
and `usageOf`. A contract test holds the reader to `runAccounting` / `chatTurnAccounting` row for row. Nothing pinned
changes, so every slice can still be auto-approved.

## Words (UI copy)

Plain labels, no metaphors:

- **API dollars**: work billed to an API key.
- **Covered by your plan**: subscription work. Shown as usage (`$4.10 of usage at API prices`) or "usage not
  reported". Never "$0", never added to dollars.
- **Unknown cost**: shown as a count (`3 runs, cost unknown`), plus `at least $X estimated` when the catalogue can
  price them. Never $0.
- **Limit**, **Alert at**, **When the limit is reached**: `Alert only` / `Pause new paid work`. "Paid work" means work
  billed to an API key.
- **Chosen model** / **Ran on**.

Amber is used only for "waits on you": a limit that has paused work. Approaching a limit (80%) uses the neutral or
`--so-warning` tone, never amber.

---

## Slice 1. The Spend page on 0.9.82 accounting (read-only, no schema)

**User value:** one honest page that answers "what did my agents cost this week, on what, and was it worth it". API
dollars, plan usage and unknowns stay apart, and the page works on a phone.

### Data: `src/spend-report.ts` (new, not protected)

- `spendRows(db, from, to)` makes one batch read per source and returns `SpendRow`s:
  `{ at, source: run|chat|lead|subagent|draft|sort|eval, role, project, person, subagent, taskId, runId, provider,
  modelChosen, modelReported, usage {in,out,cacheRead,cacheWrite}, amount: ReportedAmount, estimateMicrousd }`.
  - **Runs.** The same columns `runAccounting` selects (src/store.ts:25270), joined to `task_ref` for project and filer,
    as `spendItems` does today. `amount` comes from `runAmountOf`, `usage` from `usageOf`. `role` = `run.role`.
    `estimateMicrousd` = today's `priceWork` figure (src/spend.ts:100), kept only for API work with unknown cost.
  - **Chat and lead requests.** The `chat_turn` columns `chatTurnAccounting` selects (src/store.ts:25297), with the
    amount from `chatTurnAmountOf`. Each lead step is a `chat_turn` row with `mate_turn` set. The row is counted once,
    under its lead thread's project, so the double-count rule at src/spend.ts:278 carries over. Roles: `lead chat`
    (kind lead) and `chat` (fleet chat).
  - **Subagent turns, drafts, Sort steps.** As `spendItems` reads them today. A subscription turn becomes
    `{kind:"subscription", reportedUsd}` instead of 0. An API turn with no reported cost becomes unknown with an
    estimate.
  - **Evals.** One row per finished `eval_attempt`, role `evals`, with the amount from its own three columns
    (`usage_unknown = 1` reads as unknown). The build must confirm eval worlds write no `run` rows into the installed
    store. If they do, those rows are excluded by campaign so nothing counts twice.
- `spendReport(rows, period)` is pure. It returns totals as three amounts (`apiMicrousd`, `subscriptionReportedUsd` +
  `subscriptionUnreported` count, `unknownCount` + `unknownEstimateMicrousd`), and breaks them down by day, project,
  model (the **reported** model, falling back to chosen and labelled "not reported"), role, and provider. It also
  returns:
  - **top runs** by API dollars (10), and separately the top runs by plan usage, each linking to `/tasks/<id>#run-<n>`.
  - **cost per finished task**: tasks that reached done in the period, summing every run of the task across all
    time. It gives the median and the mean of API dollars. Tasks with any unknown part are left out of both, and the
    page says how many.
  - **cache use**: the share of input read from cache, by provider and in total, as tokens and a percentage.
- **Dollar cache savings are left out of v1.** The catalogue has no cache-read prices (src/model-catalog.ts:55 lists
  input and output only), and a made-up saving would break the honesty rule. "Later" covers adding them.
- **Periods** are UTC: `?range=day|week|month` with `&at=YYYY-MM-DD`. The old `?month=YYYY-MM` keeps working, and so
  does the CSV export, which gains `role`, `model_reported`, `amount_kind`, `cache_read`, `cache_write` columns. Reads
  are bounded to one month plus the previous month (for week-over-week comparison) and cached for 5 s, as
  `monthSpendCached` is (src/store.ts:16354).

### Page: rewrite `spendHtml` (src/spend-ui.ts)

The page is built from existing pieces: the `.spend` article, the `.spend-grid` tables, the `.budget` bar for limits,
the limits tiles from src/limits-ui.ts for plan windows, and Operations Ledger tokens. No chart library.

1. **Header:** Today · 7 days · Month segmented control, ← → navigation, CSV.
2. **Three figures, never summed:** API dollars · Covered by your plan · Unknown cost. Each carries
   `data-amount-kind="api|subscription|unknown"` so a script or journey can read which amount it is.
3. **By day:** one CSS bar per day for API dollars, with plan usage as an outline bar beside it. A bar is never drawn
   for unknown. Its count shows as a figure.
4. **Limits:** today's `.budget` rows, read-only here, with "Change" → Settings → Spend (slice 2).
5. **Breakdowns:** by project, model (with the chosen model shown beside it when they differ), role (builder, repair,
   planner, reviewer, scout, lead chat, chat, subagents, flows, evals), and person.
6. **Most expensive runs** and **cost per finished task**.
7. **Cache use** and **plan windows** (the existing `provider_limit` tiles).

On a phone, the figures stack, tables become two-column rows (name / amount), and the day bars scroll inside their
card, never the page. 16px gutter.

### Access

`/spend` stays instance-operator only, as today. **Settings → Spend** is a new tile in the Agents group, beside
Models (src/server/render-settings.ts:600). It opens `/settings/spend` (slice 2). Until slice 2 ships, the tile links
to `/spend`.

### Tests (focused)

- `spend-report.test.ts` **contract**: for fixture runs and chat requests covering API reported, API estimated with
  cost unknown, `basis: default`, subscription with and without reported usage, `billingReported` api-key, and a mixed
  `MODELS_JOIN` model, each `SpendRow.amount` deep-equals `runAccounting(...).amount` / `chatTurnAccounting(...).amount`.
- **Accounting:** totals never add subscription usage or unknown into API dollars. A lead step mirrored by a
  `chat_turn` counts once. Eval attempts count once.
- **What must never show:** an unknown amount and a subscription amount never render as `$0`. This is checked
  through the `data-amount-kind` hooks, not copy strings.
- **Route:** `/settings/spend` keeps the same roles as `/spend`.

---

## Slice 2. Spend settings: limits and alerts (schema v143)

**User value:** "don't let agents spend more than $20 a day or $300 a month on this project". Paid work pauses at the
limit and the owner is told at once. Unknown cost is never treated as free.

### What changes

- **Period.** `budget.period TEXT NOT NULL DEFAULT 'month' CHECK (period IN ('month','day'))`. The live unique index
  becomes `(scope_kind, scope_key, period)`, so a project can have a daily limit and a monthly limit. The migration
  keeps every existing budget as `month`. No week period: month plus day covers both "runaway" and "plan".
- **When the limit is reached.** The existing `hard_stop` keeps its meaning, now said in plain words: `Pause new paid
  work` (1) or `Alert only` (0).
  - Owner decision D2 covers a third choice, "require approval".
  - A paused limit holds **new** paid work only. A run already started finishes; it already carries its own
    `--max-budget-usd` cap where the provider supports one (src/provider.ts:412) and refuses where it can't
    (`budget-unenforceable`, src/needs-you.ts:205).
- **Alert marks.** Today they are fixed at 50/80/100. v1 makes them a per-limit choice of `80/100` (default) or
  `50/80/100`, stored as `alert_marks TEXT NOT NULL DEFAULT '50,80,100'`. Existing rows keep their marks.
- **What counts toward a limit (honest).**
  - **API dollars**, reported or settled.
  - **Unknown API work at its catalogue estimate.** This is what budgets already do (src/spend.ts:88 "never free").
    Unknown work with no estimate counts as a figure (`+2 runs, cost unknown`). The gate also keeps refusing new
    paid work on a provider it can't price at all (src/store.ts:16386, the `why: "unpriced"` hold).
  - **Subscription usage does not count toward a dollar limit.** Plans are bound by their own windows, which headroom
    routing already respects. The settings page says so in one line and shows the windows. (Later: a pause at X% of a
    plan window.)
  - **Evals are never capped** (owner, 2026-10-30). The page lists them, labelled "not limited".
- **Gate.** `budgetGate` reads each live limit for its own period: a day limit reads from today's UTC midnight. Every
  call site keeps calling the same gate, so no admission path changes shape. The hold words name the period:
  `The shop project's daily limit is reached for 2026-10-31`.
- **Who may change limits.**
  - The existing POST `/spend/budget` gains `period` and `marks`. It stays `scope: "step-up"`: browser only, so API
    tokens, the lead's token, the MCP gateway and chat bridges are refused (src/server/route-table.ts:61, :364).
  - It takes a password unless Passwordless is on, in which case the live session is the proof (docs/plans/passwordless.md).
  - It stays instance-operator only. Owner decision D4 covers project approvers.
  - Every change is ledgered before → after by the existing `setBudget` (src/store.ts:16248).

### Page: `/settings/spend` (new GET, operator)

Sections:

1. **Limits.** Each row shows scope, period, used/limit bar, what happens at the limit, and alert marks, with "Change"
   in a `<details>` (the existing `.budget` and `.budget-form`).
2. **Add a limit.** For: Everything / a project / a person / a subagent. Period: Daily / Monthly. Amount in US
   dollars. When the limit is reached. Alert at. Password field via `reauth()`.
3. **Plan windows** (read-only).
4. **Models** summary card (slice 3), linking to Settings → Models.

### Tests

- `migration-v143-spend-limits.test.ts`: existing budgets read back as `month` with the same marks. Two live rows (day
  and month) can exist for one scope, but not two of the same period.
- **Spend gate, security:**
  - A daily limit at 100% with pause holds new API work at admission (`operate.ts`), at spawn (`invoke.ts`), for
    repairs (`builder.ts`) and for chat (`store.ts`). Subscription work passes. A provider that can't be priced still
    holds. Unknown work with an estimate counts at the estimate.
  - Tomorrow (UTC) the day limit is clear and the month limit still counts.
  - Attack: a bearer token, the lead token and a cookie without step-up each get the refusal, and nothing is written.
- **Data integrity:** setting and removing a limit is one transaction with its ledger row.

---

## Slice 3. Model choices: newest defaults, per-project, reported vs chosen (no schema)

**User value:** "use the newest Claude models, cheaper ones for small jobs, and show me if anything ran on something
else". Choices can be made per project and are never applied behind an approval's back.

### Defaults: the newest models, as exact ids

Today, a fresh installation with no `phase_config` files every scope unresolved until someone picks a model
(src/agentconfig.ts:114–123). Setup offers floating aliases (src/setup-guide.ts:20).

- **Use recommended models.** A one-click button on Settings → Models writes the recommended set at installation
  scope through the existing `setPhaseConfig` / `setPhaseTierConfig` (each ledgered):

  | Role | Model |
  |---|---|
  | Planner | `claude-opus-5-5` |
  | Reviewer | `claude-opus-5-5` |
  | Builder (routine) | `claude-sonnet-5-5` |
  | Builder (strong: large or risky tasks) | `claude-opus-5-5` |
  | Builder (light: small tasks) | `claude-haiku-5-5` |
  | Repair | follows the builder |

  Setup (src/control-setup.ts:28) and the setup guide preselect the same ids. Owner decision D5 covers whether the
  builder defaults to Opus.
- **Exact ids, not aliases.** A sealed route binds the string it was given. `opus` sealed today runs whatever the CLI
  maps `opus` to next month, so the approval no longer names what runs. Exact ids keep approvals and runs equal. The
  existing model watch (src/model-catalog.ts:366) already says when 5.6 lands. Slice 3 adds a "Switch to it for new
  tasks" button on that notice's page. It is the same `setPhaseConfig` write and affects new filings only. Aliases
  stay selectable and are labelled "moves to the newest version".
- **Other places Toolroll picks a model:**
  - Task sizing (`SIZING_CLAUDE_MODEL = "haiku"`) becomes `claude-haiku-5-5`.
  - The subagent default stays on the Claude CLI's own default (src/subagent-admin.ts:13), which is the person's
    choice.
  - The lead chat price table gains `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` at Anthropic's
    published list prices, checked at build time and never guessed (src/converse.ts:48). The lead's default model
    becomes `claude-sonnet-5-5`.

### Per-project overrides

- Settings → Models gains a **Project** picker (installation, or one project). With a project chosen, each role shows
  either "uses the installation's choice" or a project row, and the form writes `phase_config(repo, …)` / tiers. These
  are the same store writes the CLI uses (src/operate.ts:5529) and the same validation as src/server/settings.ts:1446
  (exact id, review not on Gemini, repair on the builder's provider).
- Strong and light tiers become editable on the page for Builder (light, strong) and Planner (strong). Today they are
  CLI only. Alternates and fallback chains stay CLI only and are shown in words.

### Automatic routing, said in words (read-only)

One paragraph per project, built from the existing pure projection (src/phase-routing.ts:786 `agentsSummary`,
:841 `routeWords`). For example:

> Small tasks build on Haiku 5.5 with no plan; large or risky ones plan and build on Opus 5.5. When Claude has used
> more than 80% of its 5-hour window, an alternate on another provider takes the phase.

Fallback chains: "Off until a real out-of-plan case is recorded" (the inert recognizer registry, docs/fallback-fixtures.md).

### Chosen vs ran on

For each role over the last 30 days, the page shows **Chosen** (the run's stamped `run_route.model`, or `run.model`)
next to **Ran on** (`run.model_reported`). A new pure function, `modelMatch(chosen, reported, aliasTarget)`, returns:

- `same`
- `alias` — `opus` ran as `claude-opus-5-5`, counted as the same
- `different` — the reported model, with the runs listed and linked
- `several` — a `MODELS_JOIN` value
- `not reported` — Codex reports no model (src/reported-usage.ts:79)

`different` gets a counted line ("3 runs ran on claude-sonnet-5-5"). It is not amber: nothing waits on the person. The
same pair also shows on each run in the task page's attempts list (render-tasks.ts already formats model names at
:161).

### Sealing stays fail-closed

- A model choice changes **new filings only**. A route is computed and sealed when a scope is filed
  (src/store.ts:8490–8530). An approval binds that route's digest, and every run is stamped from the sealed route
  (src/store.ts:15510–15524).
- No slice-3 write touches `scope`, `run_route`, an approval, a mode's terms, a routine's pin or a fallback chain.
- Plans already filed but not yet approved keep the route they were filed with. The page lists how many there are
  ("4 plans waiting for approval use the previous choice; re-file to switch") and links to them. It never re-routes
  them. A mode's auto-approval already refuses a changed route (src/modes.ts:238).
- **Who may change model choices.**
  - Today, POST `/settings/models/agent` is an approver browser act with no step-up.
  - Slice 3 makes every model-choice write (agent, tier, project, "use recommended", "switch") `scope: "step-up"`,
    like budgets: password unless Passwordless; API tokens and the lead token refused.
  - A model choice decides what new work spends, so it needs the same proof as a limit.
  - Project rows need an approver with access to that project. Installation rows need an instance operator (D4).

### Tests

- **Sealed routes (security):** after a filed and approved scope, changing the installation and project choices
  leaves its route digest, its approval and the next run's stamp unchanged. A newly filed scope gets the new choice.
- **Attack:** bearer token, lead token and cookie without step-up are each refused on every model-choice POST, with no
  `phase_config` change and no ledger row. A project approver without access to that project is refused.
- `modelMatch` unit cases: alias resolution, joined models, null reported.
- **Contract:** "Use recommended" writes exactly the table above as exact ids, and the CLI's `config show --json`
  reads them back.

---

## Slice 4. Limit notifications (no schema)

**User value:** the owner hears about a limit before and when it bites, on their phone or Telegram, and gets one tap
to the page where it can be raised.

- **Alerts.** `budgetAlertPass` (src/budget-alerts.ts:14) learns the period: the dedupe key becomes
  `budget:<id>:<limit>:<period-key>:<mark>`, where the period key is the day or the month, and only each limit's
  chosen marks are used. Delivery is unchanged: the outbox, with the person's usual places (Telegram, Slack, Discord,
  Teams, phone push), `pushClass: "attention"`, link `/settings/spend`.
- **Needs you.** While a pausing limit holds paid work, one row shows in the operator's Inbox (Needs you, amber):
  `The shop project's daily limit is reached. 2 tasks are waiting.` with a single action, **Raise the limit**, linking
  to `/settings/spend#limit-<id>`. There is one row per limit, never per task. It disappears when the limit is raised
  or the period turns. A held task's own page keeps its "Budget" fact (src/server/render-tasks.ts:2293).
- **Never from chat.** Telegram and other chat bridges carry the message and the link only. Raising a limit is a
  step-up browser act, so a chat can't do it. This holds even with chat approval on.
- **Unknown cost.** At most one notice a month per limit: "3 runs on the shop project have unknown cost; they count at
  their estimate." It is sent only when an unknown with no estimate exists under a pausing limit.

### Tests

- Each limit sends at most once per mark per period. A day limit alerts again the next day. Raising a limit re-arms
  its marks (the key includes the limit).
- The Needs-you row exists only while a pausing limit holds work, and is gone after a raise.
- **Attack:** a Telegram reply or callback can't change a limit.

---

## Owner decisions (with recommendations)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Where model choices live | **Keep them on Settings → Models**, add per-project and tiers there, and show a Models summary card on Settings → Spend and on `/spend`. One editor, two ways in. |
| D2 | What happens at a limit: warn / pause new work / require approval | **Warn and pause in v1.** A pause shows as one Needs-you row with "Raise the limit". "Require approval" (per-task "run anyway") adds a one-shot spend grant that must be sealed, ledgered and race-proof, for little gain over raising the limit. Later if asked. |
| D3 | Unknown cost under a limit | **Count it at the catalogue estimate (as budgets do today), show unknowns with no estimate as a count, keep refusing providers that can't be priced at all.** Pausing on every unknown would stop all Codex API work, since Codex reports no cost. |
| D4 | Who may change limits and model choices | **Instance operator for installation-wide rows. An approver with project access for that project's model choice. Every write is step-up, so API and lead tokens are refused.** Project-scoped approvers seeing their own project's spend can come later. |
| D5 | Builder default model | **Sonnet 5.5 routine, Opus 5.5 for large or risky tasks, Haiku 5.5 for small ones. Opus 5.5 plans and reviews.** Newest everywhere, and sized routing keeps the bill sensible. Alternative: Opus 5.5 for every build (simpler, roughly 5× the API dollars on routine work). |
| D6 | Exact ids or aliases by default | **Exact ids**, with a "Switch to it" button when the watch sees a newer model. An alias under a sealed approval quietly changes what runs. |
| D7 | Subscription usage limits | **Not in v1.** Plans are bound by their own windows, and headroom routing already respects them. Later: "pause new work at X% of the weekly window". |
| D8 | Spend-aware routing (route cheaper near a limit) | **Not in v1.** It would need to be a sealed routing input, like headroom. Revisit after v1 data. |

## Schema

| Version | Slice | Change |
|---|---|---|
| v143 | 2 | `budget.period` (`'month'`/`'day'`, default `'month'`), `budget.alert_marks` (default `'50,80,100'`). Rebuild `budget_live` as `(scope_kind, scope_key, period) WHERE removed_at IS NULL`. Add to `UPDATE_SAFE_MIGRATIONS`, with `src/migration-v143-spend-limits.test.ts`. |

v142 is reserved by evals D1. If D1 hasn't landed when slice 2 merges, take the next free number and say so in the PR.
Slices 1, 3 and 4 add no schema.

## Slices (each ships alone)

| Slice | Ships | Depends on | User value |
|---|---|---|---|
| 1 | Spend page on 0.9.82 accounting, Settings → Spend tile | — | An honest dashboard: by day, week, month, project, model, role; top runs; cost per finished task; cache use; phone-friendly |
| 2 | Daily and monthly limits, plain "at the limit" choice, Settings → Spend page (v143) | 1 (page only) | Cap a project or everything per day or month; paid work pauses; unknown is never free |
| 3 | Newest-model defaults, per-project and tier choices, routing in words, chosen vs ran on, step-up on model writes | — | Current models by default; overrides per project; mismatches are visible; approvals untouched |
| 4 | Period-aware alerts, a Needs-you row for a paused limit, Telegram etc. | 2 | Hear about a limit before and when it bites; one tap to raise it |

Order: 1 → 3 → 2 → 4. Slice 3 is independent and the most visible "newest models" change, so it can ship in the same
release as slice 1.

Each slice runs only its affected tests while it is being fixed. The full suite runs on GitHub CI and in the release
check.

## Later (not in v1)

- Dollar cache savings, once the catalogue keeps cache-read and cache-write prices.
- Pausing at a share of a plan window.
- Per-task "run anyway" grants.
- Spend-aware routing.
- Project approvers seeing their own project's spend.
- Week-period limits.
- A lead tool that reads the spend summary (read-only).
