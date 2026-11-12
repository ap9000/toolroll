# Workspace concise-content pass — result — 2026-09-13

Implements the focused clean-and-concise direction (the brief of the same
date) on the package 1 query correction `a626e87b945b6c3f0d5520a21618dadc8c88b222`
(branch `standing-orders/workspace-concise-ui-20260913`). A content-density
pass over the existing shell only: no store schema, scheduler, authority,
permission, provider, billing, global setting, installation, publication,
deployment, dependency, transport, or continuity change; package 2 and
packages 3–5 are untouched. Every change was left uncommitted for the worker
to seal; the unchanged full repository verifier runs through that
machine-owned gate and is **pending** at the time of writing.

## What changed

### Work (`src/serve.ts` `workPage`, CSS)

- **Head:** the title and the *Work tools* control share one line; the
  hint paragraph ("Every task in view, most urgent first.") is gone from the
  page and rides each view tab's `title` instead. On a phone the head no
  longer stacks into two rows.
- **Rows:** title first, the stable id and age beneath it, then ONE
  wrapping line: the shared status line, the existing next action, and a
  native `<details class="work-details"><summary>Details</summary>` holding
  the diagnosis sentence that every row used to print in full. The
  disclosure works without script and by keyboard (Tab to the summary,
  Enter opens and closes; proved in the browser), its summary is 36 px tall
  on a desk and 40 px on a phone, and an opened body wraps onto its own
  full-width line by itself. The diagnosis words are unchanged and still in
  the HTML (`.work-detail`), only folded.
- Nothing critical folds: the status label itself names the failed check
  ("Changes saved, but checks failed"), the needed approval, the retry, the
  exception ("Accepted with an exception"), the failed review, and the
  missing or mismatched evidence — asserted per row in the browser proof.
  No type size shrank (title 15 px, status 14 px, unchanged); row padding
  went from 14 px to 12 px (10 px on a phone).
- The filter strip, the tools menu, the bound notice, every empty state,
  the `data-work-*` tokens, ordering, counts, and the admitted-before-limit
  query are untouched.

### Chat (`src/serve.ts` `matePage`, `taskChatHeading`, `matePromptStarters`; `src/chat-continuity.ts`)

- The live conversation's heading intro ("Ask about any project. Changes
  come back as cards you confirm.") is gone; `chatHeading` skips an empty
  sentence. The pre-conversation start page is unchanged.
- The empty thread keeps ONE contextual sentence: "Describe the outcome you
  want; changes come back as cards you confirm." (a focused task: "I read
  the task first — ask anything, or start below.").
- The second hint under the composer ("One message is enough. I'll infer
  the title, scope, and proof; …") is removed.
- The composer's status line (`#chat-connection`, still `role="status"
  aria-live="polite"`) renders empty while idle and hides itself
  (`.composer-hint:empty { display: none }`); it still says "Reply in
  progress…" while a reply runs. The continuity script's idle words are now
  "Connected." instead of "Connected · changes appear as cards for you to
  confirm."; every other state ("Sending…", "Connection lost…",
  "Reconnecting…", "Message not confirmed…", "Finish editing…", "Sign in
  again…", storage denial) is unchanged, as are drafts, the request
  binding, the reload rules and the double-send latch.
- Starters: three each. General — *brief me*, *decisions*, *new task*
  (dropped *building now*, *prioritize queues*). Focused — *what's
  happening*, *check the proof*, *revise scope* (dropped *steer next
  attempt*). Their messages are unchanged.
- The focused chat's title line drops "Ask, steer, or revise this task in
  the same unified conversation."; the title, the Overview/Ask switch, the
  journey card and its headline, the exact-run control, the approval
  ceremony, decisions, and the receipt are exactly as before.

### Task and result (`src/serve.ts` `completionReceiptCard`, `completionReceiptView`)

- The receipt's review-history paragraph (review in flight: "… Until the
  review settles, the earlier verdict — "Ready to review" — stays on record
  as history.") sits behind `<details class="receipt-history"><summary>Review
  history</summary>` on the task page and in chat alike — the same
  `data-receipt-review` paragraph, the same words. The status box above it
  still leads with the review and carries the same history sentence in the
  open (`[data-review-lead]`), and the v50 review panel with its retry
  control is untouched.
- The receipt's *Independent review* coverage block folds behind a
  disclosure ONLY when nothing is owed: review optional under default
  quality and not settled, or satisfied, with no context gap
  (`coverageSecondary`, computed from the same `semanticCoverage` facts the
  CLI prints). A strict-quality shortfall, a strict review still pending,
  or a named context gap stays in the open exactly as before
  (`data-semantic-coverage=""` div; tested).
- Everything else on the task page is unchanged: the title status line, the
  one status box with its exit code, the *Review the failed check* action,
  the *Accept with exception* control, the requirements disclosure, the
  receipt heading, narrative, publication fact and facts tiles, screenshots,
  caveats ("Before you move on" never folds), the scope card with its signed
  terms, agents, attempts, and both revision paths.

## Files

`src/serve.ts`, `src/chat-continuity.ts` (idle words only),
`src/serve.test.ts`, `src/chat-continuity.test.ts` (idle words only),
`scripts/workspace-proof.mjs`, `scripts/ui-polish-proof.mjs`, this record.
`package.json`, the verifier, the store, the scheduler and every authority
door are unchanged (`git diff --stat` names only these files).

## Verification

Commands, run from this checkout on the final tree:

| Command | Result |
| --- | --- |
| `npx vitest run src/serve.test.ts src/chat-continuity.test.ts src/workspace-ui.test.ts src/dispatch.test.ts` | 4 files, 295 passed (1 new test, assertions added or updated as listed below), exit 0 |
| `npm run build && node scripts/workspace-proof.mjs --out output/playwright/concise-ui/after/workspace --strict` | 197/197 checks, 29 screenshots, exit 0 (167/167 on the base before the change) |
| `node scripts/ui-polish-proof.mjs --out output/playwright/concise-ui/after/ui-polish --strict` | 76/76 checks, 21 screenshots, exit 0 (75/75 on the base) |
| `node ~/Documents/standing-orders/output/playwright/workspace-boundary-review.mjs "$PWD"` (the reviewer's independent five-case boundary script, outside the source tree) | all five cases `ok: true`, exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build` (the unchanged approved verifier) | **pending** — runs once through the machine-owned sealing gate after this handoff; not duplicated here |

Test changes (`src/serve.test.ts`): one new test — a Work row is title,
status, next act, and a native Details disclosure over the diagnosis; the
head is one line; the receipt folds only what is not owed (default-quality
matrix with no settled review folds; the failed check keeps its exit code,
action, and exception control). Assertions added to existing tests: the
fresh conversation's one sentence, empty idle status, three starters, no
heading intro or second hint; the focused fresh thread's one sentence and
three starters, and the populated thread keeping its real messages; a strict
shortfall with a context gap stays an open `<div>`. Assertions updated for
intentional behaviour without dropping their meaning: the receipt-history
paragraph is now matched inside its disclosure (same words, same
`data-receipt-review`); the All tab is matched with its new `title`
attribute; "One message is enough." is asserted absent instead of present.
`src/chat-continuity.test.ts`: the idle status is "Connected.".

Browser proofs: `scripts/workspace-proof.mjs` gains a `c6` section (per
viewport: head layout; every row's status/action shown and diagnosis
folded; 36/40 px targets; critical labels in the open; type sizes; the
keyboard open/close of one row's Details with the exact words and no
overflow; the fresh and focused-fresh threads; a populated focused thread
with the real messages, journey, receipt and three starters; the failed-check
and pending-review task pages with the status box leading and the receipt's
history folded and openable) and records `density` in `report.json`.
`scripts/ui-polish-proof.mjs` gains one check on the ready thread; its
approval, both revision modes, draft, keyboard and reduced-motion checks run
unchanged.

## Evidence — before/after, exact viewports, same synthetic fixture

Generated under the ignored `output/playwright/concise-ui/` (never in the
source diff). *Before* is the sealed base `a626e87` (extracted with
`git archive` into `output/playwright/concise-ui/baseline-tree/`, built there,
measured by the SAME `visibleDensity` function — see `report.json` for the
after numbers and `before/density/density.json` for the before numbers).
All PNGs are device-scale-1 exact viewports of synthetic data.

Before: `before/workspace/phone-work-all.png`, `narrow-work-320.png`,
`desktop-work-all.png`, `chat-fresh-1440x900.png`, `chat-fresh-1280x800.png`,
`desktop-task-failed-checks.png`, `phone-task-failed-checks.png`,
`desktop-chat-failed-checks.png`, `desktop-task-review-failed.png`;
`before/density/phone-chat-focused-populated.png`,
`desktop-chat-focused-populated.png`.

After: `after/workspace/phone-work-all.png`, `narrow-work-320.png`,
`desktop-work-all.png`, `phone-work-details-open.png` (a row's Details
opened by keyboard), `chat-fresh-1440x900.png`, `chat-fresh-1280x800.png`,
`phone-chat-focused-populated.png`, `desktop-chat-focused-populated.png`,
`desktop-task-failed-checks.png`, `phone-task-failed-checks.png`,
`phone-task-pending-review.png`, `desktop-task-review-failed.png`.

### Visible density, measured — not DOM text

`visibleDensity` counts only rendered text whose client rectangles
intersect the first viewport, from elements that are computed visible (a
closed disclosure's body, `display:none`, and `aria-hidden` never count),
plus Work rows whose whole box sits inside the viewport, and the document
height. Before → after:

| Surface | Doc height | Visible chars | Text lines | Whole rows | Mean row px |
| --- | --- | --- | --- | --- | --- |
| `work-narrow` (320×740) | 3411 → 2599 | 575 → 477 | 27 → 25 | 2 → 3 | 178 → 135 |
| `work-phone` (390×844) | 3060 → 2342 | 800 → 634 | 30 → 25 | 3 → 5 | 160 → 122 |
| `work-desktop` (1440×900) | 2261 → 1638 | 1266 → 997 | 38 → 37 | 5 → 8 | 115 → 79 |
| `chat-fresh-phone` (390×844) | 1016 → 849 | 590 → 270 | 19 → 13 | — | — |
| `chat-fresh-1440x900` | 900 → 900 | 626 → 306 | 19 → 16 | — | — |
| `chat-fresh-1280x800` | 800 → 800 | 626 → 306 | 19 → 16 | — | — |
| `chat-focused-populated-phone` (390×844) | 2309 → 2178 | 500 → 437 | 15 → 15 | — | — |
| `chat-focused-populated-desktop` (1440×900) | 1812 → 1738 | 960 → 785 | 29 → 28 | — | — |
| `task-failed-checks-phone` (390×844) | 3213 → 3129 | 737 → 737 | 25 → 25 | — | — |
| `task-failed-checks-desktop` (1440×900) | 2157 → 2111 | 1852 → 1798 | 51 → 49 | — | — |

What that means honestly:

- **Work** is the real win: at 390×844 the first row starts 68 px higher
  (267 → 199) and rows average 122 px instead of 160, so five whole rows fit
  where three did; at 320×740 three where two did; on a desk eight where
  five did. Visible text in the first phone viewport fell from 800 to 634
  characters because the diagnosis sentences are folded, not because
  anything shrank. Page height at 390 px fell from 3060 to 2342 px.
- **Fresh chat** loses about half its visible words on a desk (626 → 306
  characters, 19 → 16 text lines) and on a phone (590 → 270, 19 → 13): two
  intro sentences, the second hint, and two starters are gone; the composer
  and send control stay inside the first viewport (checked).
- **Populated focused chat** changes less (phone 500 → 437 characters, desk
  960 → 785): the real messages, the journey and the receipt dominate the
  viewport by design; what went is the title's intro sentence and one
  starter.
- **Task page with a failed check:** the first phone viewport is
  effectively unchanged (737 → 737 characters) — the title, the one status
  box with its exit code, the review action, the exception control, the
  requirements disclosure and the receipt head were already the content
  there and stay. The savings are below the fold (the optional coverage
  block folds; page height 3213 → 3129 px at 390). No
  percentage claim is made beyond these measured numbers.

## Limitations and caveats

- The v50 review panel ("Review queued … Retry queued") above the status
  box still restates the review that the status box also leads with. It
  carries the retry control and attempt list and belongs to the review
  authority surface, so it was left as it is.
- The task page's title status line, status box, and receipt chip still
  each carry the same short status for the same run — that agreement is a
  package 1 contract every surface test asserts; only the repeated
  paragraphs were folded.
- Keyboard and disclosure behaviour were observed in headless Chromium
  only.
- The full repository verifier is pending on the machine-owned gate.

---

## Revision — the independent review of build 1548 (2026-09-13)

Branch `standing-orders/revise-workspace-concise-ui-20260913-from-4-annotations-`,
built on the sealed head `2ebfbd659e1d9620fec2f10abbc38d8083350505` (run
1548, the "source"). The four annotations and the review record
(`WORKSPACE_CONCISE_UI_REVIEW_2026-09-13.md`, kept in the primary checkout)
are applied here; the source run, its evidence, and its signed terms are
not altered. Nothing below touches the store, the scheduler, authority,
permissions, settings, providers, billing, installation, publication,
deployment, dependencies, or transport.

### The opened Work tools menu (annotation 96)

The compact head moved the tools control to the right edge, but a phone
rule (`.work-tools-menu { right: auto; left: 0 }` under 760 px) kept the
menu anchored at the control's LEFT edge. Opened at 390×844 the source's
menu measured **265.5–441.5 px** and widened the document to **442 px**
(at 320×740: 195.5–371.5, 372 px). Reproduced by the revised proof against
the source tree with the same fixture
(`source/workspace/report.json` → `density["work-phone-tools-open"]`).

Fix: the phone override is removed, so the menu keeps its right-aligned
anchor on every width, and it can never exceed `100vw − 2rem`. The
compact head, every destination, keyboard operation, and visible focus
are unchanged. Opened now: 320 px → 128–304, 390 px → 198–374,
1440 px → 880–1056; document width equals the viewport in every case.

Explicit open-menu regression check (`scripts/workspace-proof.mjs`, section
`c7`, at 320 / 390 / 1440): the menu is opened by keyboard (focus the
summary, Enter); its own box has positive size and sits wholly inside the
viewport; all eight destinations are computed visible, positive-size, and
inside the viewport; `scrollWidth ≤ clientWidth` while open; Tab walks
every destination in order with `:focus-visible` on each; Enter on the
summary closes it; a tap opens it inside the viewport too. `src/serve.test.ts`
asserts the CSS has no `left:` anchor for the menu and the eight links are
present. Screenshots: `*-work-tools-open-keyboard.png` at each width.

### The concise hierarchy (annotation 97)

- **Work rows:** the stable id is no longer a visible meta line under
  every title. It rides inside the row's existing native `Details`
  (`<p class="work-meta work-id">Task <span class="mono">id</span></p>`
  after the diagnosis), still in the HTML and still the row's `data-task`.
  The meta line keeps the age (and the project label when rows span
  projects). Keyboard-opening a row's Details shows the diagnosis and the
  id together (browser-proved).
- **Task page:** a finished result's status is no longer repeated in the
  `<h1>` when the status box directly beneath leads with the same words.
  The title is the bare title; the box and the receipt carry the shared
  projection (`statusBoxLeads` in `taskPage`). A task with no result keeps
  its state chip (the box beneath answers a different question), and a
  result whose box is displaced by an approval ceremony or a planner
  request keeps the status line, so the words never leave the page.
  Preserved and re-asserted: the failed check's exit code, *Review the
  failed check*, *Accept with exception*, the requirements disclosure, the
  receipt's own status line, the review-in-flight lead and history, the
  retry control, the older run's own verdict on its run page, the exact
  signed goal, and both revision paths (`ui-polish-proof` 76/76).

### Density, corrected (annotation 98)

The source measured whole rows against `innerHeight`. At 390×844 the
fixed tab bar covers y = 787–844 and the sticky header y = 0–91, so the
source's "5 whole rows" was an overcount: the fifth row ended below 787.
`visibleDensity` now measures the **unobscured band** between any
fixed/sticky chrome pinned at the top or bottom edge (taken from the live
boxes, recorded as `occluders`), counts whole rows inside that band, and
labels its text figures `visibleCharsEstimate` / `visibleTextLinesEstimate`
with a `method` sentence — characters prorated by the share of a text
node's rects inside the band, lines bucketed at 6 px: sampling, not a glyph
count. Whole rows, the band, and the document height are exact.

All three trees were measured by the SAME function, fixture (`scripts/
ui-polish-fixture.mjs { secondProject: true }`), flows, and exact viewports:
*before* = `a626e87` (pre-concise base), *source* = `2ebfbd6` (build 1548),
*after* = this tree. The historic trees are re-measured durably by
`node scripts/workspace-proof.mjs --density-only --rev <rev> --out <dir>`,
which extracts the revision read-only with `git archive`, builds it under
`<dir>/tree`, and runs only the density pass against its fixture (the
`report.json` records the resolved sha). The after numbers come from the
strict run's own density pass. Outputs under the ignored
`output/playwright/concise-ui-revision/{before,source,after}/workspace/`.
This table supersedes the one above.

| Surface | Band | Doc height b→s→a | Chars (est.) b→s→a | Lines (est.) b→s→a | Whole rows b→s→a | Mean row px b→s→a |
| --- | --- | --- | --- | --- | --- | --- |
| work-narrow (320×740) | 91–683 | 3411 → 2599 → 2574 | 466 → 370 → 332 | 21 → 19 → 18 | 1 → 3 → 3 | 178 → 135 → 133 |
| work-phone (390×844) | 91–787 | 3060 → 2342 → 2316 | 641 → 535 → 471 | 23 → 20 → 21 | **3 → 4 → 4** | 160 → 122 → 120 |
| work-desktop (1440×900) | 91–900 | 2261 → 1638 → 1624 | 1208 → 939 → 873 | 36 → 35 → 37 | 5 → 8 → 8 | 115 → 79 → 79 |
| chat-fresh-phone (390×844) | 91–787 | 1016 → 849 → 849 | 523 → 233 → 233 | 16 → 11 → 11 | — | — |
| chat-fresh-1440×900 | 91–900 | 900 → 900 → 900 | 599 → 279 → 279 | 17 → 14 → 14 | — | — |
| chat-fresh-1280×800 | 91–800 | 800 → 800 → 800 | 599 → 279 → 279 | 17 → 14 → 14 | — | — |
| chat-focused-populated-phone (390×844, scrolled to the message) | 91–787 | 2309 → 2178 → 2178 | 410 → 347 → 347 | 11 → 11 → 11 | — | — |
| chat-focused-populated-desktop (1440×900, scrolled) | 91–900 | 1812 → 1738 → 1738 | 733 → 670 → 670 | 25 → 25 → 25 | — | — |
| task-failed-checks-phone (390×844) | 91–787 | 3213 → 3129 → 3106 | 606 → 606 → 604 | 19 → 19 → 19 | — | — |
| task-failed-checks-desktop (1440×900) | 91–900 | 2157 → 2111 → 2111 | 1794 → 1740 → 1708 | 49 → 47 → 47 | — | — |
| task-pending-review-phone (390×844) | 91–787 | 3467 → 3335 → 3312 | 603 → 603 → 622 | 20 → 20 → 20 | — | — |

Honest reading: at 390×844 the concise Work page fits **four** whole rows
in the unobscured band where the base fit three (the last whole row ends
at y = 664, the tab bar starts at 787; a fifth row is partly covered);
at 320×740 three where the base fit one; on a desk eight where five. The
first row starts 68 px higher on a phone (267 → 199). Tucking the ids
trims the phone Work viewport by another ~64 estimated characters and 26
px of page height. The failed-check task page's first phone viewport is
essentially unchanged in text (606 → 604 estimated characters): the
title lost its repeated status line, and the same amount of receipt text
rose into view. The pending-review phone viewport's estimate rises
(603 → 622) for the same reason — more of the receipt is now inside the
band. No percentage claim is made beyond these numbers.

### `src/chat-continuity.ts` (annotation 99)

Build 1548 shortened the idle status to "Connected." without naming the
shared file in its declared touched paths. This revision's scope permits
that display-only copy explicitly. The file's header now says so; the
string is retained; nothing else in the script changed. A new test
("the idle words are display-only …") pins the transport around it: the
same `/chat/mate/status` request with `cache: 'no-store'`, the same 5 s
cadence, `?request=` binding on a submitted draft, and the unchanged
"Reply in progress…" and "Message not confirmed…" sentences. Every prior
continuity test passes unchanged.

### Verification (this tree)

| Command | Result |
| --- | --- |
| `npx vitest run src/serve.test.ts src/chat-continuity.test.ts src/workspace-ui.test.ts src/dispatch.test.ts` | 4 files, 297 passed (2 new tests), exit 0 |
| `npm run build && node scripts/workspace-proof.mjs --out output/playwright/concise-ui-revision/after/workspace --strict` | 227/227 checks, 46 screenshots, exit 0 |
| `node scripts/workspace-proof.mjs --density-only --rev a626e87 --out output/playwright/concise-ui-revision/before/workspace` and the same with `--rev 2ebfbd6 … /source/workspace` | 14 screenshots each, exit 0 (the before / source columns above) |
| `node scripts/ui-polish-proof.mjs --out output/playwright/concise-ui-revision/after/ui-polish --strict` | 76/76 checks, 21 screenshots, exit 0 |
| `node ~/Documents/standing-orders/output/playwright/workspace-boundary-review.mjs "$PWD"` (the reviewer's five-case boundary script) | all five `ok: true`, exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build` (the unchanged approved verifier) | **pending** — runs once through the machine-owned sealing gate; not duplicated here |

Files: `src/serve.ts`, `src/serve.test.ts`, `src/chat-continuity.ts`,
`src/chat-continuity.test.ts`, `scripts/workspace-proof.mjs`, this record.
`scripts/ui-polish-proof.mjs` needed no change (its 76 checks pass as
they are). The verifier, `package.json`, the store, the scheduler, and
every authority door are unchanged.
