# The task page: the steps are the page

Status: plan v1, 2026-11-10. Not built. Supersedes the tab layout in `one-page-task-and-agent.md` (its URL, ceremony
and "one mounted instance" rules stay).

## Why

Alex's words: the UI "looks vibe coded", "some colors and ui elements are too much", task details are "not very
clear", "sometimes it's hard to know where to look". He chose direction B from the mocks and asked for three changes:
no amber, a chat to watch the work, and a plan a person can read and follow.

Mocks (the target): the Design canvas "Task page mocks", top row — plan waiting for approval, building with the work
open, ready for review, phone, phone work view, and the open step in all eight states.

## What a person sees

1. **Five rows are the page**: Plan, Approval, Build, Checks, Ready. No tab strip, no separate step line, no separate
   status card. A finished step is one line (label, one plain sentence, time) and opens on press. The step that is
   happening is open and holds the one action. A step not reached yet is one grey line saying what will happen.
2. **No amber.** What waits on the viewer: a 1px ink outline on the open step, a solid ink "Needs you" chip, and the
   one solid ink button. Blue only while something runs, green only for passed, vermilion only for failed. Cautions
   (a detail that is off but blocks nothing) are ink text with a small caution glyph, never a hue.
3. **The plan reads top to bottom**: one lead sentence; numbered Steps; Done when (each with how it is proven);
   Will change / Won't touch; Worth knowing (hidden when empty); one line on the agent and its limits.
4. **During a build** the plan's steps tick off in the open Build row ("Step 2 of 3 · …"), and "Watch the work" opens
   the agent's work as a chat beside the page (full screen on a phone): the agent's words as text, each action as one
   quiet line, the person's notes as a bubble on the right, a filled rounded message box at the bottom.

## What exists already (so this is mostly re-arranging)

| Need | Exists today |
|---|---|
| Five steps from recorded facts | `taskRoad` (`src/first-run.ts`), drawn by `stepsOf` + `KSteps` (`task-view.tsx`) |
| One status, one sentence, one action | `StatusBox`, `headingOf`, `ApprovalBox`/`KApprove`, Stop/Pause/Resume/Retry forms (`task-view.tsx`) |
| Signed plan rows | `approvalSheetParts` → `approve.planHtml` (`render-tasks.ts`) |
| Approach / milestones / risks / proof | `ExecutionPlanDocument`, `executionPlanHtml`, `planCard` (today an Activity entry) |
| Step-by-step build progress | builder checkpoints → `run_checkpoint` → `progressOf` / `buildProgressOf` → `view.progress` |
| Chat view of the agent's work | `live/<run>.jsonl` records, `/r/<n>?fragment=transcript&shape=records`, `useConversation` + `ConversationPane` (Agents page only, CSS scoped to `#agents-view`) |
| A note to the running agent | `POST /t/:id/steer`, `steerControlsFor`, `SteerNote` / `PauseSteerForm`, `runNotes` read state |
| Result with changed files and diff | `reviewCockpitDetailParts` → `SelectedResult` (`taskResult`) |

No new framework and no new dependency. The chat viewer is ours already; it moves into the kit and is restyled to the
mock. Nothing is copied from outside libraries in this plan (if a later piece is, MIT only, recorded in the PR).

## Rules that do not move

- **Approval.** The server still proves the person, the freshness and the exact scope when the form arrives. The page
  only re-arranges. Every signed term (goal, changes and paths, won't touch, done when, budget / "if it runs out", the
  agent and its limits, a fallback chain line when there is one) is visible in the open Approval step at every width
  before the Approve button can be pressed — nothing signed sits behind a fold, on desktop or phone. The phone mock's
  "Show the full plan" link is therefore dropped: the phone shows the same terms, stacked. One mounted approval
  instance keyed by `approvalIdentity`, as today. Terms and submitted value come from one snapshot (KIT.md).
- **Password pages** keep today's behaviour (no live updates while a password input is on the page).
- **The transcript** keeps every guard it has: cookie session, run visible, this computer's runner, sanitised records,
  text sinks only, no tool names, command text only under the project's "Show commands" answer. The panel adds no new
  endpoint and no new data.
- **Messages.** A note typed in the work panel while a build is live goes to the agent through the existing steer
  route and its controls; nothing new can be sent. When no build is live the panel's box is the existing task
  conversation with the lead. The box's label always names who receives it ("Message Claude Sonnet" / "Ask the
  lead"). A model never approves; the box cannot approve anything.
- **One status source** (`task-status.ts`) and one road (`taskRoad`). No new state names.
- **Kit**: every new piece is built twice (server `src/server/kit.ts`, React `src/browser/kit/`), registered in
  KIT.md with a contract, classes in `kit.css` only, then `youiyoux sync` and `check --strict`.

## Slices (one PR each, in this order)

### PR 1 — No amber (app-wide, small)

- Tokens (`src/design/system/tokens/toolroll*.tokens.json`): `--so-needs` → ink (`--so-signal`), `--so-needs-soft` →
  the ink wash; drop `--so-needs-ink`. Regenerate `tokens.css`, `theme.css`, `SYSTEM.md` with `youiyoux sync`.
- `kit.css`: `k-chip.needs` becomes solid ink with on-signal text (no dot); `.ask` stays neutral; `k-dot.needs`,
  `k-step.now`, `k-slots.wait`, `k-needs`, `k-crow.wait`, `k-nav-flag`, `k-sflag` read ink through the token. Check
  each in dark mode (ink is `#ededed` there; chip text is `#0a0a0a`).
- Cautions: the ~30 uses of `--so-warning` / Tailwind `*-warning` (console.css, workspace.css, `TASK_STATUS_CSS`,
  `ui/badge.tsx`, result-view, flow-view, sign-in banner) become ink text on the neutral soft fill with a caution
  glyph. Then the warning token is removed from the token source so it cannot come back.
- Rules and docs: replace `color.amber-means-waits.rule.yaml` with `color.ink-means-waits` (same statement, ink);
  rewrite DESIGN.md's One Signal Rule, Status Keeps Its Hue Rule, the chip and border paragraphs, the Do/Don't lines;
  KIT.md rows 35, 81–97, 171, 265; `docs/design/task-status.md` (the amber note on a row becomes a caution note).
- Tests: `src/design/kit.test.ts`, `src/server/kit.test.ts`, `src/console-feel.test.ts`, `serve.chrome.test.ts`
  ("one accent in two places"), any test asserting `warning`/`needs` class names. Evidence: Tasks, a task waiting
  on approval, Home, Agents, Settings at 1440 and 390, light and dark.
- Risk: with ink as both "waits on you" and "the act", a waiting card and its button share a colour. That is the
  design (outline + chip + button read as one thing). Guard: at most one `k-slots wait` outline per page region.

### PR 2 — The steps are the page (task page core)

- **One label set.** `JOURNEY_STEPS` says "Approval" (not "You approve"); `stepsOf`'s private LABEL map goes; chat's
  first-task journey and `first-run.tsx` read the same constant. Dynamic labels ("Checks running", "Checks failed",
  "Checks not run", "Checks at release") move out of the label into the row's sentence; the label stays "Checks".
- **New kit piece `k-steprows`** (server builder + `KStepRows`): an ordered list; each row has a marker (done = ink
  disc with a check, current = ring with a dot — ink when it waits on the viewer, blue when something runs, vermilion
  when it failed —, skipped = dashed ring, todo = grey ring), a label, a sentence, a time, and an optional body. Done
  rows are real `<button aria-expanded>` disclosures; the current row is open and not collapsible. `aria-current="step"`
  on the current row. Replaces `KSteps` on the task page (KSteps stays for chat's compact journey).
- **Row sentences** come from a new pure function `stepRowsOf(view)` in `src/workspace-ui.ts` (tested), from facts
  the view already has: who wrote the plan and when; who or which rule approved; which agent built, attempt count,
  `buildProgressOf` words; the check's state; the result's size (files, +/−). No new store reads on the page.
- **Row bodies** (React `TaskView`, re-arranged, same components):
  - Plan → the plan (PR 2 layout below). "Edit plan" from ⋯ opens the existing `#plan-edit` editor here.
  - Approval → when current: `ApprovalBox`/`KApprove` as the action header, then the plan (the signed terms) inside
    the same outlined section. When done: who approved, when, "See what was approved" (existing terms).
  - Build → when current: `StatusBox` content for a live build (progress sentence, Stop, Pause and steer, "Watch the
    work"), then the plan's steps with their checkpoint state. When done or failed: attempts (`AttemptsPanel`) and
    the problem card if any.
  - Checks → the existing detail rows (project checks, requirements, evidence) and "Run checks" when offered.
  - Ready → `ResultSlot` (summary, changed files, diff) with the result's one action (Open pull request / Inspect),
    plus `MergeReadyBox`, `ShipBox`, `ReleaseBox` where they apply today.
  - Lead cards (`view.lead`: history, control, problem, pull-request, needs-scope, mirror) attach to the row they
    belong to: problem → the stuck row; pull-request → Ready; needs-scope → Approval; the rest → under the list.
  - Tasks with no road (`journey = null`: releases, machine checks) keep `statusHtml` + sections as today.
- **Where "Activity" and "Attempts" go.** Attempts are the Build row's body. The Activity thread (history entries and
  the task conversation) becomes the side panel of PR 3; until PR 3 lands it stays reachable as the panel in its
  simplest form (the thread as it is today, opened from an "Activity" button in the header). No content is lost
  between PRs.
- **URL contract kept.** `?tab=result` opens Ready, `?tab=attempts` opens Build, `?tab=activity` opens the panel,
  `?tab=plan` (or none) opens the current step. `showTask`, `onePageView` link rewriting, the `/review` and `/r/<n>`
  redirects, `MoreMenu` go-to items and `revealTarget` keep working through one mapping function
  (`pageTabOf` → `openStepOf`). Hidden bodies are hidden, never unmounted (ceremony rule).
- **Plan layout** (server, `render-tasks.ts`, new builder `planSheetHtml` fed by the same `approvalSheetParts` data
  and `ExecutionPlanDocument`, replacing the rows in `approve.planHtml` and the `planCard` Activity entry):
  - lead sentence = `approach`'s first sentence, else `goal`; the goal is shown under it when the two differ
  - Steps = `milestones` (numbered); absent → the section is omitted
  - Done when = `acceptance`, each with its kind in plain words (check → "Runs automatically", test evidence →
    "Proven by a test", screenshot → "Shown in a screenshot", changed-path → "Seen in the changed files",
    manual-review → "You review it"); `proof` lines that are not already acceptance follow
  - Will change = `touches` ("Any file in the project" when open) · Won't touch = `outOfScope` ("Nothing is ruled
    out" when empty)
  - Worth knowing = `risks` then `dependencies`; hidden when both are empty
  - If it runs out (budget) and the agent line ("<model> builds this. …" from the sealed profile words), then the
    fallback chain line when present
  - No internal codes (`c1`, `[requires: check]`), no folder paths outside the project, times as clock times.
  The plan contract panel (`planContractHtml`) and amendment stay, under "Worth knowing".
- **Build progress.** The open Build row lists the plan's milestones with `MilestoneState` (completed = check,
  current = blue ring, blocked = vermilion, pending = grey) from the latest checkpoint; with no checkpoint yet it
  shows the steps all pending and the plain activity line. Nothing new is asked of the agent.
- **Phone** (≤ 640px): same rows, 44px targets, the action header's buttons full width, no fold of signed terms.
- Tests to move, not delete: `one-page.test.ts` (tabs → open step mapping), `task-cta.test.ts`, `task-view.test.ts`,
  `task-steer.test.ts`, `live-task.test.ts`, `first-run.test.ts`, `workspace-ui.test.ts` (+ `stepRowsOf`),
  `task-status-surfaces.test.ts`; slow server suites that assert task HTML (`serve.tasks`, `serve.console`,
  `serve.results`, `serve.workspace`, `needs-you`, `task-control-console`, `password-freshness.serve`) — targeted runs
  locally, the full suite in CI; journeys `scripts/app-e2e.mjs` selectors (`[data-task-panel]`, `.k-steps`),
  `workspace-result-proof.mjs`, `ui-polish-proof.mjs`. `.youi/screens/screens.json` states re-shot.

### PR 3 — Watch the work

- Move `useConversation` + `ConversationPane` out of `agents-view` into a kit piece `k-work` (`KWork`): header (title,
  who is working, live dot, close), the record list, the message box (`KComposer`). Styles move from `agents.css`
  (scoped to `#agents-view`) to `kit.css`; the Agents page uses the same piece, so there is one viewer.
- The task page mounts it as a right-hand panel (≥ 1100px: beside the rows; below that: a `KOverlay` sheet; phone:
  full screen). Opened by "Watch the work" in the Build row, by "Activity" in the header, or `?tab=activity`.
  Open/closed is a per-viewer convenience (localStorage, guarded).
- Content: for the live or latest run, the transcript records (say → text; step → one line with a glyph, our fixed
  kind words "Read / Edited / Ran a command / Searched …" and the target; done → "12 passed"-style result only when
  the record carries it); the person's notes from `runNotes` as right-hand bubbles with read state. Below the live
  part, or alone when there is no transcript: the task's thread entries as today.
- When the transcript is off (the build runs on another computer, or the provider records nothing): the panel says
  so in one sentence ("The agent's work is shown only for builds on this computer.") and shows the activity line
  and the thread. No fake content.
- The box: live build → the steer route with today's controls (`steerControlsFor`: send now, or pause and steer),
  drafts kept per attempt as today; otherwise the task conversation. The old `<pre id="live-transcript">` and
  `#run-peek` in `attemptPanel` are removed from the task page once the panel shows the same records.
- Tests: `agent-conversation` tests follow the move; `steer-composer.test.ts`, `steer-live.test.ts`,
  `live-input.test.ts`; `agents-live-proof.mjs`; a new browser test for the panel's three states (live, off, no run).

### After these: the rest of the UI

Same pass on Tasks, Home, Agents, Projects, Settings and chat: one action per screen, hairlines not nested boxes, one
⋯ menu, no machine text, colour only for live / passed / failed. Planned separately once the task page ships.

## Order, checks, release

PR 1 → PR 2 → PR 3, each merged on green CI. Safety self-review (AGENTS.md) before every commit in PR 2 and PR 3
(approval surface, transcript, steer). Scripted journeys run locally before a release. Evidence screenshots at 1440
and 390, light and dark, for every state in the mocks' "every state" board.

## Open questions for review

1. Is anything signed today shown only inside a fold or a tab that this layout would hide or reorder in a way that
   breaks "an approval covers exactly what was shown"?
2. Is mapping `?tab=` onto open steps enough to keep every inbound link, redirect and go-to working, or is a
   contract missed?
3. One message box with two receivers (agent while live, lead otherwise): clear enough, or should the panel show two
   labelled boxes?
4. Ink for both "waits on you" and "the act": does any screen end up with two competing ink outlines?
5. Removing the warning token entirely versus keeping it for cautions: which is safer for existing server pages?
