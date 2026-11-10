# The task page: the steps are the page

Status: plan v2, 2026-11-10. Not built. v1 was reviewed read-only by Codex (GO WITH CHANGES, 9 findings); all nine are
folded in below and listed at the end. Supersedes the tab layout in `one-page-task-and-agent.md` (its URL, ceremony
and "one mounted instance" rules stay).

## Why

Alex's words: the UI "looks vibe coded", "some colors and ui elements are too much", task details are "not very
clear", "sometimes it's hard to know where to look". He chose direction B from the mocks and asked for three changes:
no amber, a chat to watch the work, and a plan a person can read and follow.

Mocks (the target): the Design canvas "Task page mocks", top row — plan waiting for approval, building with the work
open, ready for review, phone, phone work view, and the open step in all eight states.

## What a person sees

1. **The steps are the page**: Plan, Approval, Build, Checks, Ready (a report has four: no Checks). No tab strip, no
   separate step line, no separate status card. A finished step is one line (label, one plain sentence, time) and
   opens on press. The step that is happening is open and holds the one action. A step not reached yet is one grey
   line saying what will happen.
2. **No amber.** What waits on the viewer: one 1px ink outline on the open step, a solid ink "Needs you" chip, and
   the one solid ink button. Blue only while something runs, green only for passed, vermilion only for failed.
   Cautions (a detail that is off but blocks nothing) are ink text with a small caution glyph, never a hue.
3. **The plan reads top to bottom**: one lead sentence; numbered Steps; Done when (each with how it is proven);
   Will change / Won't touch; Worth knowing; the agent, its permissions and its limits.
4. **During a build** the plan's steps tick off in the open Build row ("Step 2 of 3 · …"), and "Watch the work" opens
   the agent's work as a chat beside the page (full screen on a phone): the agent's words as text, each action as one
   quiet line, the person's notes as a bubble on the right, a filled rounded message box at the bottom.

## What exists already (so this is mostly re-arranging)

| Need | Exists today |
|---|---|
| The steps, from recorded facts | `taskRoad` (`src/first-run.ts`), drawn by `stepsOf` + `KSteps` (`task-view.tsx`) |
| One status, one sentence, one action | `StatusBox`, `headingOf`, `ApprovalBox`/`KApprove`, Stop/Pause/Resume/Retry forms |
| Everything an approval signs | `approvalSheetParts` → `approve.planHtml`, incl. the "Plan details" fold and runtime terms |
| Approach / milestones / risks / proof | `ExecutionPlanDocument`, `executionPlanHtml` (with a text fallback for old plans), `planCard` |
| Build progress | builder checkpoints → `run_checkpoint` → `progressOf` / `buildProgressOf` → `view.progress` (a sentence and a stuck summary today; per-step states need a typed projection, below) |
| Chat view of the agent's work | `live/<run>.jsonl`, `/r/<n>?fragment=transcript&shape=records`, `useConversation` + `ConversationPane` (Agents page only) |
| Notes to the running agent | `POST /t/:id/steer` (a note) and `POST /t/:id/pause` (pause and send), `steerControlsFor`, `steer-capabilities.ts` |
| Live file changes | `#run-peek` in `attemptPanel` |
| Result with changed files and diff | `reviewCockpitDetailParts` → `SelectedResult` |

No new framework and no new dependency. Nothing is copied from outside libraries.

## Contracts that do not move

### Approval

- The server still proves the person, the nonce, the freshness, the revision brief, the rebuild check and the exact
  scope when the form arrives (`tasks.ts` approve handler). The page only re-arranges.
- **Content parity, enumerated.** The open Approval step shows, unfolded and before the Approve button, everything
  `approvalSheetParts` produces today, including what sits in today's "Plan details" fold: the goal and the full
  repair goal; revision feedback; the amendment warning; changes and exact granted paths; won't touch; done when and
  each evidence requirement; every agent role with its model; permissions (network, reads, writes, check access);
  runtime and repair limits; budget / "if it runs out"; quality level; the paid-fallback warning and chain line; the
  earlier-running-version warning; the candidate's identity (saved commit, plan version). Exact signed grants are
  shown as signed, even when they are paths outside the project; only decorative paths are dropped.
- **How parity is kept:** the new sheet is built by re-ordering and re-labelling the parts `approvalSheetParts`
  already returns, not by a second reading of the plan. A test renders the old sheet and the new sheet for the
  fixture set (plain, repair, amended, fallback chain, multi-agent, report) and asserts every term's text in the old
  one is present, outside any `<details>` or hidden element, in the new one.
- **Pinned together.** The terms shown and the fields submitted come from the one approval payload the page first
  showed (`shownApproval`); a changed digest disables the button; an open plan editor blocks submission. The plan in
  the Approval step is that payload's plan, never the latest adaptive execution plan. One mounted approval instance
  keyed by `approvalIdentity`; bodies are hidden, never unmounted.
- **One outline.** The step row owns the ink outline; `KSlots wait` inside it is drawn without its own border.
- The plan is shown once: while Approval is open the Plan row above is one line ("Written by … · shown below").

### Sensitive pages

Password pages keep today's degraded render (no live room, no polling scripts). The work panel's poller obeys the
same switch: `useConversation` takes a `paused` flag and makes no request while a password input is on the page or a
password popover is open; it resumes when the popover closes. A test proves no transcript request is made in either
state. Ceremonies never render inside the work panel or its phone sheet.

### Transcript

Every guard stays: cookie session, run visible (checked again after the read), this computer's runner, sanitised
records, generation / offset / key-block handling, command text only under the permission captured with the run. The
panel adds no endpoint and no data.

### Notes to the agent

The panel's box is the existing steer composer in new clothes, not a new sender. It keeps both operations (`/steer`
for a note; `/pause` with run, draft key and request id for pause-and-send), cookie + CSRF, role and demo limits,
exact-run validation, idempotency, and "a draft clears only on a confirmed send". It follows `steer-capabilities`:
send now, send to its mailbox ("It reads notes at its next check"), or cannot take notes (the box is replaced by the
capability's own sentence). The receiver is fixed while a draft exists: a note written for an attempt is never sent
to the lead when the attempt ends; it stays as an unsent note with today's explicit "send to the next attempt"
choice. The label always names the receiver. A model never approves; the box cannot approve anything.

### Navigation

One address, as today: `/t/<root>?version&tab&run&section` plus hashes and feedback parameters. `showTask`'s
version-from-run rule and mismatch refusal, `onePageView`'s link rewriting, the `/review` and `/r/<n>` redirects and
their exceptions, the browser's rule not to intercept a different version / run / section, and `revealTarget`'s
focus behaviour all stay. `tab` keeps its four values and maps to what opens: `plan` → the current step,
`result` → the result, `attempts` → Build, `activity` → the panel. `#plan-editor` and `#plan-edit` keep their
separate meanings. Without JavaScript the server render shows every row open, in order.

### Everything keeps a home

| Today | After |
|---|---|
| Header, ⋯ menu (Run checks, Edit plan, Dependencies, Holds, Task options, Archive, Copy link, Cancel) | unchanged |
| Details drawer (`TaskDetails`: scope, agents, diagnostics facts) | unchanged |
| Plan tab: signed rows | the plan sheet in the Plan / Approval row |
| Plan tab: sections scope, waits-for, holds, steering, task-diagnostics, manage, Cancel | under the rows, in the same order, as "More about this task" (flat sections, as today) |
| Step strip + status card | the open row |
| Result tab | the result body (Ready row; see "Result access") |
| Activity tab (thread + lead composer) | the panel |
| Attempts tab | the Build row's body |
| `planCard` Activity entry | the Plan row (the thread keeps a one-line "Plan written" entry) |
| `#run-peek` live file changes | the Build row, under the steps ("Files changing") |

### Kit

Every new piece is built twice (server `src/server/kit.ts`, React `src/browser/kit/`) with the same markup,
registered in KIT.md with a contract, classes in `kit.css` only, standalone behaviour kept, then `youiyoux sync` and
`check --strict`. System changes (tokens, rules, contracts) are proposed with `youiyoux plan`, and the plan goes in
the PR description; the change itself is the one Alex asked for in chat.

## Slices (one PR each, in this order)

### PR 1 — No amber (compatible, small)

- Tokens: `needs` and `needs-soft` point at `signal` and `signal-soft` (ink). `kit.css`'s `--so-needs-ink` becomes
  plain ink. `k-chip.needs` becomes solid ink with on-signal text; the other needs marks (`k-dot.needs`,
  `k-step.now`, `k-slots.wait`, `k-needs`, `k-crow.wait`, `k-nav-flag`, `k-sflag`) follow through the token. Dark
  mode checked for each.
- The `warning` tokens stay defined in this PR (console.css aliases them, `youi.project.json` maps them, and the
  terminal uses them as its ANSI yellow, which is terminal output, not UI). Every UI consumer (~65 lines: console.css
  notes and chips, workspace.css, `TASK_STATUS_CSS`, `ui/badge.tsx`, result-view, flow-view, chat cards, shell, the
  settings kit) moves to the caution style: ink text, neutral soft fill, caution glyph. A guard test then allows
  `--so-warning` / `*-warning` only in the token files, the console alias line and the terminal palette. Deleting the
  token is a later clean-up, not this delivery.
- Rules, contracts, docs: `color.amber-means-waits` → `color.ink-means-waits`; component contracts that name the
  needs tone; DESIGN.md (One Signal Rule, Status Keeps Its Hue Rule, chip and border paragraphs, Do/Don't); the
  generated block in AGENTS.md via sync; KIT.md; `docs/design/task-status.md`.
- Tests: `src/design/kit.test.ts`, `src/server/kit.test.ts`, `src/console-feel.test.ts`, `serve.chrome.test.ts`,
  youiyoux tests. Evidence: Tasks, a task waiting on approval, Home, Agents, Settings at 1440 and 390, light and dark.

### PR 2 — The steps are the page

- **One label set.** `JOURNEY_STEPS` says "Approval"; `stepsOf`'s private LABEL map goes; chat's first-task journey
  and `first-run.tsx` read the same constant. `taskRoad`'s state words ("Checks failed", "Checks not run", "Checks at
  release", "Checks unreadable") become the row's sentence; the label stays "Checks".
- **New kit piece `k-steprows`** (server builder + `KStepRows`): an ordered list; each row has a marker (done = ink
  disc with a check; current = ring with a dot, ink when it waits on the viewer, blue when something runs; stuck =
  vermilion; skipped = dashed ring; todo = grey ring), a label, a sentence, a time and an optional body. Finished
  rows are `<button aria-expanded>` disclosures; the current row is open. `aria-current="step"` on the current row.
  `KSteps` stays for chat's compact journey.
- **Row sentences**: a pure function `stepRowsOf(view)` in `src/workspace-ui.ts` (tested) from facts the view
  already carries. No new store reads in the browser.
- **Typed build progress.** The server adds `progress.steps: { title, state: pending|current|completed|blocked }[]`
  to the view, from the plan's milestones and the latest checkpoint (`parseProgressSnapshot`). No checkpoint yet →
  all pending. Nothing new is asked of the agent.
- **Row bodies** (same components, re-arranged):
  - Plan → the plan sheet; "Edit plan" opens the existing editor here.
  - Approval → when current: the action (`ApprovalBox`/`KApprove`, Request changes, Reject) then the plan sheet in
    the one outlined section. When done: who or which rule approved, when, and the approved terms.
  - Build → when live: the progress sentence, Stop, pause-and-steer, "Watch the work", the steps with their states,
    files changing. When ended: attempts and the problem card.
  - Checks → the existing check detail and "Run checks" when offered.
  - Ready → the result with its one action, plus `MergeReadyBox`, `ShipBox`, `ReleaseBox` where they apply today.
  - Lead cards attach to their row: problem → the stuck row; pull-request → Ready; needs-scope → Approval; the rest
    under the list.
- **Result access does not depend on reaching Ready.** Whenever a result exists (failed or unreadable checks, a
  completed task whose road stopped at Checks, an older version), the Ready row can be opened and holds that result
  with its evidence, diff, feedback and revision controls; its sentence says why it is not ready. The loaded
  result's identity and "a newer result exists" notice behave as today.
- **Other shapes.** A report draws four rows. A cancelled task or one with no road (`journey = null`) keeps today's
  status block and sections, restyled only.
- **Plan sheet** (server, `render-tasks.ts`, `planSheetHtml`, built from `approvalSheetParts`' parts plus the
  `ExecutionPlanDocument`):
  - lead sentence = the approach's first sentence, else the goal; the rest of the approach follows in full; the goal
    is shown when it differs
  - Steps = milestones, numbered; none → omitted
  - Done when = acceptance, each with its evidence kind in plain words (`check` → "Runs automatically",
    `screenshot` → "Shown in a screenshot", `changed-path` → "Seen in the changed files", `manual-review` → "You
    review it"); proof lines not already covered follow
  - Will change (granted paths, exactly) · Won't touch
  - Worth knowing = amendment warning and other warnings first (always shown when present), then risks and
    dependencies; hidden only when all are empty
  - The agent: every role and model, permissions, runtime and repair limits, quality level, budget and what happens
    when it runs out, fallback chain
  - Old plans that do not parse keep `executionPlanHtml`'s text fallback
  - No internal codes (`c1`, `[requires: check]`); times as clock times
- **Phone** (≤ 640px): same rows, 44px targets, full-width action buttons, nothing signed folded.
- **Tests.** Moved, not deleted: `one-page.test.ts`, `task-cta.test.ts`, `task-view.test.ts`, `task-steer.test.ts`,
  `live-task.test.ts`, `first-run.test.ts`, `workspace-ui.test.ts`, `task-status-surfaces.test.ts`, the slow server
  suites that read task HTML, `password-freshness.serve.test.ts`. New: sheet parity; stale approval disables the
  button; wrong-password recovery keeps the shown terms; result stays selected through a live update; hash focus;
  redirect exceptions; no-JavaScript render; server/React markup parity for `k-steprows`. Journeys:
  `scripts/app-e2e.mjs` selectors, `workspace-result-proof.mjs`, `ui-polish-proof.mjs`. Targeted runs locally, the
  full suite in CI. `.youi/screens/screens.json` states re-shot.

### PR 3 — Watch the work

- `useConversation` + `ConversationPane` move into a kit piece `k-work` (`KWork`): header (title, who is working,
  live dot, close), the record list, the message box. Styles move from `agents.css` to `kit.css`; the Agents page
  uses the same piece.
- The task page mounts it as a right-hand panel (≥ 1100px beside the rows; below that a sheet; phone full screen).
  Opened by "Watch the work", by "Activity" in the header, or `?tab=activity`. Open/closed is remembered per viewer
  (guarded localStorage).
- Content: the live or latest run's records (the agent's words; each action as one line with our fixed kind words
  and its target; a result only when the record carries one); the person's notes with their read state; then the
  task's thread. When the transcript is off (another computer's build, or a provider that records nothing): one
  sentence saying so, the activity line and the thread. No invented content.
- The box follows "Notes to the agent" above. With no live attempt it is the task conversation with the lead.
- The `<pre id="live-transcript">` is removed from the task page once the panel shows the same records; `#run-peek`
  stays.
- Tests: the viewer's tests follow the move; `steer-composer.test.ts`, `steer-live.test.ts`, `live-input.test.ts`;
  `agents-live-proof.mjs`; new: the panel's states (live, mailbox, no notes, off, no run), the paused poller, a draft
  outliving its attempt.

### After these: the rest of the UI

The same pass on Tasks, Home, Agents, Projects, Settings and chat, planned separately once the task page ships.

## Order, checks, release

PR 1 → PR 2 → PR 3, each merged on green CI. Safety self-review (AGENTS.md) before every commit in PR 2 and PR 3
(approval surface, transcript, steer). Scripted journeys run locally before a release. Evidence screenshots at 1440
and 390, light and dark, for every state in the mocks' "every state" board.

## Review record

Codex, read-only, on v1: GO WITH CHANGES.

1. High — the plan sheet did not list all consent-bearing content → "Content parity, enumerated" and the parity test.
2. High — pin the approval document and the submitted fields together → "Pinned together".
3. High — the transcript poller ignores the sensitive-page switch → "Sensitive pages".
4. High — steering is two operations and three capabilities → "Notes to the agent".
5. High — a result must be reachable when Ready is not reached → "Result access".
6. Medium — transcript records do not replace live file changes → `#run-peek` stays.
7. Medium — wrong facts (progress shape, evidence kinds, report and cancelled roads, old-plan fallback) → corrected.
8. Medium — missing homes and contract checks → "Everything keeps a home", "Navigation", the new tests.
9. Medium — token removal incomplete; System changes are proposed → PR 1 keeps the warning tokens and uses
   `youiyoux plan`.

Also taken: one outline per waiting step; the full approach after its lead sentence; the plan shown once.
