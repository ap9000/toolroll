# ReUI polish: slice plan

Status: approved direction (2026-10-27), revised after one Codex read-only review. It turns
`docs/plans/reui-assessment.md` into slices.

Alex's answers:
- **Board:** restyled with CSS, not rebuilt with Kanban.
- **`/tasks`:** retires into `/work` as a redirect, with nothing lost.
- **Task and result pages:** get a Timeline (attempts) and a read-only Stepper (the approval road).
- **Credit:** ReUI is credited in `THIRD_PARTY_NOTICES.md` only.
- **"Needs you" is amber:** the existing warning token, drawn as a thin full outline plus a chip with a dot, never a
  fill or an edge stripe.

DESIGN.md already carries that last rule. It was copied byte for byte from agents-view-4 `0bcb0062` (blob
`2912f6e0`), so the two branches merge cleanly.

## Rules every slice keeps

### Source
- Only MIT ReUI files, taken from the pinned commit `keenthemes/reui@067aa0d` (2026-10-16), Radix base
  (`registry-reui/bases/radix/reui/*`).
- Copied by hand and cut to what we use. Never the shadcn CLI, no `components.json`, no `cssVars`.
- Import rewrites:
  - `radix-ui` becomes `@radix-ui/react-slot` (already pinned).
  - `cn` becomes `components/ui/utils.ts`.
- `style-*:` variants and every shadow are deleted.
- Each copied file names its upstream path and commit in a header comment and in `THIRD_PARTY_NOTICES.md` under
  "ReUI — MIT".

### Dependencies
No new npm dependency in any slice. Anything that would need one stops and asks first.

### Two renderers, one spec
- **React views** (`/work`, the Crew sheet in `app.tsx`, the task page, the result page, Projects, the Settings
  landing, Agents) use the React component.
- **Server pages** (Board and its order view, `/settings/knowledge` and the other server settings pages, Flows) get
  a twin class in `src/server/console.css`, read from the same `--so-*` tokens with the same measurements.
- Per AGENTS.md there are no CSS or markup unit tests. The screenshots and the youiyoux diff check keep the two in
  step.

### DESIGN.md
- **Amber:**
  - Amber marks only what waits on a person.
  - Counts stay ink pills, including the sidebar's, the tabs' and the Projects "N waiting on you" peek count.
  - The one verb that answers the wait stays ink.
- **Amber contrast fix:** the existing warning text on its soft wash measures **4.21:1** (`#ab6400` on `#fff4d5`),
  which fails AA for 11.5px text.
  - The amber chip's text is therefore `color-mix(in oklab, var(--so-warning) 85%, var(--so-ink))`. That gives
    5.27:1 in light. In dark, `#ffca16` mixed toward light ink on the 12% wash is above 9:1.
  - The dot and the 1px outline stay pure `--so-warning`. The outline is non-text, needs 3:1, and gets 4.61:1 on
    paper.
  - It is defined once, as a Tailwind `@utility text-needs` in `tailwind.css` and as the server twin's `.chip-needs`.
  - The generated tokens in `src/design/` are not edited.
- **Other rules:**
  - No card shadows.
  - No uppercase labels. No mono labels: mono is for machine facts only, so clocks, ids, models and branches, never
    stage words.
  - No coloured banners in the main column.
  - No KPI box rows.
  - Plain conventional labels.
- **Further DESIGN.md wording** goes in sections agents-view-4 did not touch (Badges, Cards, Do's and Don'ts list
  items it left alone). It must also **resolve** contradictions, never leave two rules standing. Slice 2 replaces
  "A waiting card keeps a neutral border" (Cards) and "Don't colour a card's border … to announce a wait" (Don'ts)
  with the amber outline rule.

### Proof per slice
- **Screenshots:** before and after at 1440×900 and 390×844 from the UI-polish fixture, plus a dark-scheme desktop
  shot of the slice's main screen. They are saved outside the tree as
  `scratchpad/reui/after-<slice>-<screen>-{desktop,phone}.png`, and nothing image-like is committed.
- **States:** each shot set includes the slice's empty, long-content and failure state where the fixture has one.
- **Checks:**
  - `npm run typecheck`, then `npx vitest run` on the test files for what changed.
  - `npm run check:quick` once per slice. That is the repo's own "typecheck plus tests named after changed files".
    AGENTS.md says not to run the whole unit suite, so it runs at most once per slice and only where a slice
    touches shared server code.
  - `youiyoux check --diff origin/main --strict` with 0 findings.
- **Review:** at most two Codex read-only rounds. Residual findings are fixed with a test only where the finding is
  a contract or security rule.
- **Commit:** one commit per slice (or per sub-slice), unpushed.

### Accessibility
- A chip's dot is `aria-hidden`. The word carries the meaning, so colour is never the only signal.
- **Stepper** is an `<ol>` with `aria-current="step"`, never a focusable widget. Each step's state is in its
  accessible name ("Plan approved, done").
- **Timeline** is an `<ol>` with `<time datetime>` only where the data has a time. The earlier-attempt data has no
  timestamp today, and none is invented.
- Anything truncated (paths) gets a keyboard- and touch-reachable reveal (a disclosure or a copy button), not only
  `title`.
- Phone tap targets stay at least 44px. Reduced motion is respected.

## Slices, in ranked order

Budgets are diff lines added plus removed, including tests, at 400 or fewer per commit. Where a slice is likely to
pass that, its split is mandatory and named.

### 1. Badge chip, about 200 lines

**Component** (ReUI `badge.tsx` → `components/ui/badge.tsx`):
- `dot?: boolean` and `size?: "fact" | "chip"`. The chip is youiyoux's spec, already approved on Agents → Live:
  20px tall, 6px corners, a soft fill, 11.5px / 500 Geist text, and a 6px `bg-current` dot. The fact badge stays the
  18px one.
- A `needs` tone: `bg-warning-soft text-needs`.
- The ink `attention` tone stays for count-like attention badges ("Needs your decision" on its ink wash, per
  DESIGN.md's Ink accent section).

**Utility:** `@utility text-needs` in `tailwind.css`.

**Server twin:** in `console.css`:
- `.chip` and `.chip-dot`
- `.chip-needs`, `.chip-live`, `.chip-done`, `.chip-failed` and `.chip-neutral`

**Adoption** (one amber chip per screen, no amber row noise):
- The task page's pinned "Needs you" bar (`PinnedAction`) becomes the amber chip with a dot.
- The task and result status cards keep their 18px headline. Its dot turns amber (`HEADLINE_DOT.attention`) when
  the headline is "Needs you", and the words don't change.
- Crew (`CrewRows` in `app.tsx`) keeps its per-item glyph and label. No chip, because 15 amber chips in a rail is
  "amber everywhere".

**DESIGN.md:** Badges gains the chip size, the dot and the `needs` tone, with the contrast note.

**Tests:** the `task-view`, `task-cta` and `one-page` tests still pass, and any that assert the old dot class are
updated.

### 2. Frame panels, about 250 lines

**Component** (ReUI `frame.tsx` → `components/ui/frame.tsx`):
- `Frame` is a raised well: `bg-raised`, 12px corners, 4px padding.
- `FramePanel` is paper (`bg-card`), with a 1px `--so-line` hairline and 8px corners. Stacked panels join with square
  inner corners.
- `FrameHeader` holds a title, a muted mono count and an optional link.
- Upstream's `shadow-xs`, its `before:` inner shadow and all `style-*` radii are removed.
- A Frame never nests in a Card or another Frame.

**Server twin:** `.frame`, `.frame-panel` and `.frame-head`.

**Adoption:**
- **Settings landing** (React `SettingsView`): only the navigation presentation changes. Each tile group becomes
  one Frame whose panels are today's tiles, with the same links, icons and status dots. Appearance, accent,
  permissions, quality, providers, workers, updates, email, notifications and the Telegram token stay exactly as
  they are, with the same conditional visibility.
- **Waiting card:** the task and result status cards take the 1px amber outline (`border-warning`) when their
  headline is "Needs you". This is the waiting-card rule.

**DESIGN.md:** Cards gains "Frame (well and panels)" and the amber outline rule. The two contradicting lines are
rewritten, as above.

**Tests:** the settings view test and the `task-view` tests.

> **Checkpoint:** report to the coordinator after slices 1 and 2, with screenshots, before continuing.

### 3. Board (server CSS, plus class hooks in `render-pages.ts` `boardPage` and the order view), about 300 lines

**Columns:**
- Each `details.lane` becomes a `.frame` well.
- The summary becomes a `.frame-head` with a sentence-case title ("Needs you", "Queued", "Waiting", "Building",
  "Done recently"), the count in mono and the chevron at the right.

**Cards:**
- Each `.lane-card` becomes a `.frame-panel`.
- The title comes first, in Geist 13.5px / 500.
- The task id moves to the meta line, in mono 12px.
- Worker, model and branch become one muted line. Only model and branch are mono.
- The live line's stage words return to Geist (today `.live-line` sets them in mono). Only the clock stays mono.

**Needs you:**
- The column head carries the amber chip with a dot.
- Each waiting card takes the 1px amber outline, with no fill.
- The building card keeps its info hue.

**Unchanged:**
- Drag to reorder (`/queue/move`) and the `?view=order` columns keep `data-task`, `data-column`,
  `data-queue-revision`, `data-vt` and the grip handle. Only classes are added or swapped.
- Escaping stays in the `html` template.

**Tests:** `src/server/live-board.test.ts`, the board and queue cases in the `serve.*` tests that exist, and the
board proof script if it covers this view.

### 4. Server settings pages and Knowledge (4a Knowledge shipped; 4b Models, Skills and Tools deferred until a page has two sections worth framing), about 380 lines; splits into 4a (Knowledge) and 4b (Models, Skills, Tools) if over budget

**Knowledge** (`src/knowledge-ui.ts` and `src/server/settings.ts`): every section becomes a Frame. The sections
are Project, Search project memory, Proposed from sessions, Instructions, References, Decisions, Change history,
Learned lessons, Relevant code. Each section's existing card wrapper is **replaced** by the panel, never nested.
- A field and its button share one row.
- The fact chips become one muted fact line.
- Empty states follow the shadcn `empty` pattern: one muted sentence and the one action.

**Must keep:**
- Role gating.
- The `repo`, `identity` and `revision` fields.
- The restore controls.
- Rejected-edit drafts.
- CSRF and project-revision fields.
- Every form action and method.

**Tests:** the Knowledge and settings server tests that cover these routes. A rejected-edit draft and a viewer-role
render are exercised in the screenshot journey.

### 5. Task and result pages: Stepper, Timeline and neutral Alerts (React)

**5a. Timeline and Alert, about 300 lines.**
- **Timeline** is ReUI `timeline.tsx` cut to about 110 lines (item, indicator, separator, a `<time>` when present,
  title, content). It replaces the hand-built attempts list in `TaskDetails` (`data-attempt-timeline`,
  task-view.tsx) with the same data: glyph, label, run link, detail. Its timestamps come only from fields the data
  carries, and the earlier-attempts list (`data-earlier-attempts`) keeps its words.
- **Alert** is ReUI `alert.tsx` cut to `neutral` plus `destructive`. It replaces the result warnings in **both**
  branches: the embedded result (`data-result-warnings`) and the standalone result page's notices. A notice inside
  a result that has not failed stays neutral; destructive appears only on a failed result.
- The result page's run-record anchor (`#run-record`) and every disclosure keep their ids.

**5b. Stepper, about 300 lines.**
- ReUI `stepper.tsx`, cut to a read-only `Road`, re-skins the existing `Journey` (`first-run.tsx`, a `JourneyStep[]`
  with done, current, stuck and todo states). This is not a second road.
- To show it on every task and result page, `src/first-run.ts` gains a factual projection beside
  `firstTaskJourney`. It is built only from recorded facts in `src/task-status.ts`, and stages can be optional or
  skipped:
  - A research or scout task has no "Checks" or "Published" step.
  - Unavailable checks show as "Checks not run", never as passed.
  - A stop or failure marks that step "stuck".
  - The road ends at the last stage the task can actually reach, so a task that is never published doesn't end on
    "Published".
- The current step is amber only when it waits on the person, and blue when it is building. Done steps show the
  green glyph and future steps a dashed ring.
- **Tests:** a contract table for the projection (research task, checks unavailable, failed build, stopped,
  published, complete without publishing) in the existing first-run test file.

### 6. Projects (React `projects-view.tsx`), about 150 lines

- The peek chips become fact Badges with dots, all neutral apart from "N waiting on you", which stays the **ink**
  count chip. A count stays ink, per DESIGN.md.
- The rows sit in one Frame.
- The path is mono and muted, truncated in the middle, with a copy button and the full path in a disclosure.

**Tests:** the projects view test.

### 7. Retire `/tasks` into `/work`, in three commits

**Gaps.** `/tasks` today has these capabilities. Each is moved before anything is removed:
1. **State filter.** `?state=queued|running|done|failed|cancelled` is validated, and an unknown state is answered
   with 400.
2. **Template pre-fill.** `?template=<name>` pre-fills the add form.
3. **Inline add form.** It has quality and permission defaults and "Edit details".
4. **Add-form errors.** `/tasks/add` re-renders `tasksPage` with the submitted fields kept, and a status code
   (tasks.ts around 1074 and 1149).
5. **Row cap.** Up to 200 rows on one page.
6. **Task id per row.**

**7a. State filter on `/work`, about 250 lines.**
- `/work?state=` uses `workIndexPage`'s existing `state` option and keeps the 400 for an unknown state.
- Paging links carry `state` and drop `cursor` whenever the filter changes. Cursors already bind state
  (`work-index.ts`).
- A filtered page **never** writes `facts.workCounts` or `facts.workCrew`, so counts and Crew stay unfiltered.
- A small "State" select sits beside the tabs.
- The task id shows on each `/work` row as a mono meta fact. Paging stays at 40 per page; the "Next page" cursor
  already reaches every row.
- **Tests:** a state-filter contract (valid, invalid → 400, paging keeps it, Crew and counts unchanged) in the
  existing work-index and serve-workspace test files.

**7b. Add-form errors move to `/tasks/new`, about 250 lines.**
- Every `/tasks/add` error response renders the new-task page with the submitted fields, the same status codes,
  CSRF, the project-revision guard and the template pre-fill.
- **Tests:** the existing `/tasks/add` refusal tests are pointed at the new page.

**7c. The redirect, about 300 lines; most of it is deleted code.**
- `GET /tasks` answers 302 to `/work`, keeping `state`, or to `/tasks/new?template=` when `template` is given.
- The route row changes to match `/work`'s project resolution, so the project opener no longer intercepts it (it
  intercepts at serve.ts ~999 today).
- The redirect is tested for:
  - a cookie approver;
  - a project-limited account;
  - a bearer caller (bearer callers get the same 302, never a screen).
- Security test setups that use `/tasks` to fetch a CSRF form (`route-policy-http.test.ts`) move to `/tasks/new`.
- These links point at `/work`:
  - the Board's "+N more in the task list";
  - the getting-started copy;
  - the `t` shortcut in `chrome.ts`;
  - the "Task list" menu entry.
- `tasksPage` is deleted last, once nothing renders it.

### 8. Agents → List and Live (last; waits for agents-view-4 to merge)

**What moves.** Once agents-view-4 is on main, two things move onto the shared Badge (`needs`, `dot`, chip size)
and Frame: the local `Chip` and the tile classes in `agents-live-view.tsx`, and the list chip map in
`agents-view.tsx`.

**The one visible change.** The amber chip text takes `text-needs`, because agents-view-4's `text-warning` on its
wash is the same 4.21:1 contrast miss. That is the only pixel change.

**Until then.** This branch does not touch `agents-view.tsx` or `agents-live-view.tsx`.

## Budgets

**Bundle.** `workspace.js` is 1,092,674 bytes today. The whole run adds at most 12 KB minified to it and 6 KB to
`workspace.css`, measured after each slice.

**Security:**
- No `dangerouslySetInnerHTML`, `eval`, `fetch`, `localStorage` or new network access in copied code.
- Copied files are read in full before commit.
- Server twins are CSS only.
- Server markup keeps the `html` template's escaping.
- Route changes (slice 7) keep the route table as the single policy source, with tests for each caller kind.

## Risks

- **Merge with agents-view-4.** DESIGN.md is identical. Later edits avoid the lines `0bcb0062` changed. If
  agents-view-4 edits DESIGN.md again first, rebase and re-apply.
- **Amber creep.** Each slice's screenshot review lists every amber element on the screen. Each must be a
  needs-you element, or setup trouble shown as a soft badge.
- **Server and React drift.** One spec is written in DESIGN.md, and every slice's shots compare server and React
  surfaces side by side.
- **`/tasks` redirect.** Only `state` and `template` carry over, and any other parameter is dropped.
