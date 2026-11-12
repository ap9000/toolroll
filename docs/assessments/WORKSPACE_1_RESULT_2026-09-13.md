# Workspace package 1 — one navigation shell, truthful status — 2026-09-13

Implements [the package 1 brief](WORKSPACE_1_BRIEF_2026-09-13.md) of
[the workspace experience plan](WORKSPACE_EXPERIENCE_PLAN_2026-09-13.md) on
the package 0 base `43c102b0736ab3a06a2db871000dd4f8525245b8` (branch
`standing-orders/workspace-1-navigation-20260913`). The final revision is the
commit the Standing Orders worker seals from this working tree; every change
below was left uncommitted for it. No `main`, live installation, real task,
publication, deployment, or service was touched; no runtime dependency was
added (Playwright is still loaded from the npx cache, never installed).

## What changed

### Navigation shell (`src/serve.ts` `shell()`, `/menu`, `/work`)

- **Three primary destinations on desktop and phone: Chat · Work ·
  Projects.** The rail's primary rows and the phone tab bar are exactly those
  three (chat only where the ceiling ever allowed it, unchanged gating). The
  needs-you count rides Work. Every old page keeps its own active key and
  lights the destination it lives under (`primaryDestinationOf` in
  `src/workspace-ui.ts`): `/`, `/tasks`, `/board`, `/board?view=order`,
  `/runs`, `/done`, `/review`, `/activity`, `/t/<id>`, `/r/<id>`, recipes,
  routines, portfolio and ledger light Work; `/chat` and `/chat?task=` light
  Chat; fleet, requirements, people, operating mode, system and settings light
  nothing primary and open the Settings group.
- **Two accordion groups replace workflows/admin:** *work tools* (inbox,
  board, task list, recipes, routines, portfolio, action ledger) and
  *settings* (settings where the console offers it, fleet, requirements,
  people, operating mode, system). A project-scoped login sees the same
  reduced rows it saw before (no portfolio; people only) — moving a link
  never widened role or project visibility, proven by the 403s in the new
  tests. Settings is no longer a pinned rail row and is never a phone tab: on
  a phone it sits with the tools behind a 44 px header action (`≡` →
  `/menu`), which lists *work tools* then *settings*.
- **Work** (`/work`, new) lists every task in view as one row — title first,
  the stable id secondary, the project label whenever rows span projects —
  with the shared status line, one plain-sentence detail, and one next
  action. Views: **All** (default), **Needs you**, **Running**, **Completed**
  (`?view=`, unknown values fall back to All). They are shortcuts over the
  same rows, never a persisted state; each tab wears the count of its own
  members. Needs you uses the existing diagnosis semantics (waiting on a
  person with a concrete act, plus a failed task's retry), Running the live
  claim or a review in flight, Completed `task.state = done` — with failed,
  missing, mismatched, agent-attested and accepted-exception results kept
  visibly distinguished. Queued, waiting, held, paused, failed and cancelled
  tasks stay findable in All, most urgent first. The page is bounded to the
  newest 200 rows and says so; every view has its own empty state. A *Work
  tools* menu on the page keeps board / order / task list / recipes /
  routines / portfolio / ledger one click away.
- **One project selector**, the retractable desktop rail, the phone project
  pill, keyboard access and the prominent Add project card are unchanged.
  With no project open in scoped mode Work rolls up like the inbox: admission
  binds the query and every row's repo is re-proved.
- **The chrome's needs-you count now equals Work's Needs-you membership**
  (per viewer and project, cached five seconds as before), so the rail badge,
  the phone tab dot, the scope bar's "N needs you" (now linking to
  `/work?view=needs-you`), the project cards and the chat overview cannot
  disagree with the Needs-you tab. Previously the badge counted only
  decisions, unapproved scopes, failed/incident tasks and cancelled blockers.

### The admitted run deep link (`handleGet`)

`/r/<id>` (and `/r/<id>/evidence/<n>`) from All projects used to bounce to
`/projects` until a project was chosen (reproduced on the baseline:
`output/playwright/workspace-1/before/desktop-run-deep-link-all-projects.png`).
The path is now let through the project gate; the run handler's own
`runVisible` check (ceiling plus account) still decides, so a run outside
the ceiling, a run in another account's project, or an unknown id still
answers 404 (tested). Project-bound pages such as `/tasks` still defer to the
opener exactly as before.

### Truthful status (`src/workspace-ui.ts`, `src/dispatch.ts`, `src/serve.ts`)

One pure display projection over recorded facts — task state, the dispatch
diagnosis, the latest finished builder/scout run, the machine's proof verdict
**and its reasons**, an operator's acceptance, the publication row:

| Recorded facts | Main wording (`data-work-status`) |
| --- | --- |
| done, no finished attempt | Marked done without a build record (`no-build-record`) |
| scout result | Report ready (`report-ready`) |
| operator accepted, any verdict | Accepted with an exception (`accepted-exception`) — never "Checks passed" |
| refuted, reason = the approved verification command exited *n* | Changes saved, but checks failed (`checks-failed`), exit code named |
| refuted, any other reason (mismatched changed path, altered statement, contradicting caveat, reviewer contradiction) | Result saved, but its evidence does not match (`evidence-mismatch`) — never a failed-test claim |
| short, or no verdict on a built run | Result saved — verification needed (`verification-needed`) |
| no-change with handoff and sealed diff (verdict null, attested or verified) | No changes were needed (`no-change`); missing records → `record-incomplete` |
| attested | Result saved — checks reported by the agent (`agent-attested`) |
| verified, no publication | Ready to review (`ready-to-review`) |
| verified + observed publication | PR opened / Merge observed / PR closed without merging (`pr-opened` / `merge-observed` / `pr-closed`) |

A refuted or short verdict is never masked by a no-change outcome. A
published-but-unverified result keeps its evidence problem as the headline and
carries the publication in the detail. Deployment is never claimed: the merge
wording says "Deployment is not confirmed by any record here."

The same words render on every touched surface for the same run, each tagged
`data-work-status`: the Work row, the task page's title status and status box
(replacing the raw `done` badge and "Complete — verified / Complete with
evidence / Conflicting evidence / Missing evidence"), the focused chat's
journey headline and receipt, the review cockpit's headline chip, and the run
page's evidence card. `diagnoseTaskDispatch` (CLI, Telegram, chat overview)
takes its done-task summaries from the same projection; its codes and
conditions are unchanged, except that a no-change conclusion with both its
records is now `complete` rather than `needs-verification`.

The completion receipt's unconditional **What shipped** heading is gone. The
heading is what the record supports — *Changes saved*, *No changes were
needed*, *PR opened*, *Merge observed* — followed by the publication fact
("Saved on the build branch — not published, merged, or deployed." / "PR #482
is open on GitHub. Merging stays a person's act; nothing is merged or deployed
yet.") and the shared status line. The criteria count says "cited by the
agent — not verified" whenever the result is not verified.

### Phone task list

The `/tasks` intro leads with the project label and shows the raw repository
path on its own wrapping line (`.path-words { overflow-wrap: anywhere }`).
The phone project pill also stopped inheriting the desktop switcher's
`align-items: center`, which let a long project name widen the document at
320 px. Baseline: 522 px document width at 390 px
(`output/playwright/workspace-1/before/phone-tasks.png`); after: 390/390 and
320/320.

## Files

`src/serve.ts`, `src/dispatch.ts`, `src/workspace-ui.ts` (new, pure),
`src/serve.test.ts`, `src/dispatch.test.ts`, `src/workspace-ui.test.ts`
(new), `src/telegram-status.test.ts`, `scripts/ui-polish-fixture.mjs`
(fourteen synthetic status tasks, an optional second long-path project and an
empty third), `scripts/workspace-proof.mjs` (new), this record. No store
schema, authority, migration, approval, revision, draft or request-idempotency
code changed.

## Verification

Commands, run from this checkout:

| Command | Result |
| --- | --- |
| `npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build` (the unchanged approved verifier) | two serial runs, the second on the final tree: 162 files, 2801 passed, 23 skipped, exit 0 each time |
| `npx vitest run src/workspace-ui.test.ts src/dispatch.test.ts src/telegram-status.test.ts` | 39 passed |
| `npx vitest run src/serve.test.ts` | 269 passed (5 new `workspace package 1` tests; 14 label/navigation assertions updated, none dropped) |
| `npm run build && node scripts/workspace-proof.mjs --out output/playwright/workspace-1/after --strict` | 141/141 checks, 23 screenshots |
| `node scripts/ui-polish-proof.mjs --out output/playwright/workspace-1/ui-polish-regression --strict` | 75/75 checks — the prior package's approval, both revision modes, draft, keyboard, reduced-motion and fresh-composer checks still pass on the extended fixture |

New regression tests: the three-destination shell per page and per role; Work
views, counts, ordering and empty states over queued / waiting / held /
paused / failed / cancelled / running / failed-check / mismatched / missing /
agent-attested / accepted / verified / PR / merged fixtures; same-run status
agreement across Work, task page, focused chat and review cockpit (with the
failed-check vs mismatch distinction, "never Ready to review", "never Checks
passed", "never shipped"); the All-projects `/r/<id>` deep link with
unchanged 404s; the task-list label and path wrap; and 7 pure projection
tests.

## Evidence

Generated under the ignored `output/playwright/workspace-1/` (never added to
the source diff; the committed `evidence/ui-polish-2026-09-13/` stays
historical). All PNGs are exact-viewport at device scale 1 and show synthetic
fixture data.

Before (baseline `43c102b`, same extended fixture, `output/playwright/workspace-1/before/`):
`desktop-inbox.png`, `desktop-tasks.png`, `desktop-task-failed-checks.png`
(raw `done` badge, "What shipped" over a failed check),
`desktop-run-deep-link-all-projects.png` (landed on `/projects`),
`phone-tasks.png` (522 px overflow), `phone-menu.png`, and matching phone
captures.

After (`output/playwright/workspace-1/after/`, captions in `report.json`):
`desktop-work-all.png`, `desktop-work-needs-you.png`,
`desktop-work-completed.png`, `desktop-work-empty.png`,
`desktop-work-all-projects.png`, `desktop-work-tools-open.png`,
`desktop-task-failed-checks.png`, `desktop-chat-failed-checks.png`,
`desktop-review-failed-checks.png`, `desktop-run-deep-link-all-projects.png`,
`phone-work-all.png`, `phone-work-needs-you.png`, `phone-work-completed.png`,
`phone-work-empty.png`, `phone-work-empty-needs-you.png`,
`phone-work-tools-open.png`, `phone-menu.png`, `phone-task-failed-checks.png`,
`phone-tasks-long-path.png`, `narrow-work-320.png`, `narrow-tasks-320.png`,
`chat-fresh-1440x900.png`, `chat-fresh-1280x800.png` (each a NEW empty
conversation, the whole composer and send control inside the first viewport).

Measured: no document horizontal overflow on `/work`, `/work?view=needs-you`,
`/tasks`, `/t/<id>`, `/r/<id>`, `/chat`, `/menu`, `/projects` at 320, 390 and
1440 px; phone view tabs, header controls and tab-bar targets ≥ 40 px;
every 320 px header control inside the viewport.

Payload: `/work` serves 197,805 bytes uncompressed (168,324 inline CSS,
7,144 inline JS). The shared stylesheet grew by about 5.4 KB, so the five
pages the UI-polish report measured grew from 180.8–198.5 KB to 187.3–207.9 KB
uncompressed. Calculated sizes, not transferred sizes.

## Limitations and caveats

- The chrome's needs-you count now runs the dispatch diagnosis over the
  bounded Work page (≤ 200 tasks) per viewer and project, cached five seconds
  like the old count. It is a behaviour change: the app-icon badge and every
  "N needs you" now include held, paused, builder-disconnected and
  unverified-result tasks. The old count's decision/approval semantics survive
  on the inbox page itself.
- ~~A done task whose review is in flight or queued shows the review's words on
  the Work row and the chat headline (from the diagnosis) while the receipt's
  status line shows the stored verdict; no fixture exercises this, so it is
  untested here.~~ Resolved by the review fixes below (finding 4).
- The `/tasks` state filter still wears raw state badges — it is the
  state-filter tool by definition; the task page's own master pane now says
  "finished" instead of "done".
- Screenshots and reports live in the ignored output directory as the brief
  asks; a verifier that reads only committed files will not find them.
- The task journey's five steps still mark "Result" complete for a saved
  result with failed checks; the headline, badge and receipt say otherwise.
  The journey component belongs to package 2/3.
- Reviewed in headless Chromium only; no Safari keyboard behaviour was
  observed. Fixture data is synthetic and labeled so.

## Review fixes — 2026-09-13 (build 1544, independent review findings 1–4)

Follow-up task `workspace-1-review-fixes-20260913`, seeded from the sealed
head `66a81a458e8607105735aa9e478edb2f0a44dae2`, resolving
[the independent review](WORKSPACE_1_INDEPENDENT_REVIEW_2026-09-13.md) of
build 1544 (source annotations 92–95 remain on `/r/1544`; the auto-filer's
`bad-goal` refusal is a filing-path limit recorded there, not touched here).
The package 0 and package 1 design is unchanged; no store schema, migration,
scheduler, authority, permission, global configuration, service, live task,
installation, push, publication or deployment changed; no runtime dependency
was added. Every change was left uncommitted for the worker to seal.

### Finding 1 — Work admitted after its limit (`src/serve.ts`)

Reproduced with the reviewer's `output/playwright/workspace-boundary-review.mjs`
against this checkout before the change: a selected project with 201 tasks
answered 200 rows and no bound notice; 501 newer tasks in a repository outside
the ceiling left the All-projects page with zero rows and the "Nothing is in
progress" claim. After the change the script's four checks (the two above,
the two-project member, and the reviewer's added case of 201 newer unplaced
tasks a project-scoped member cannot see) all pass.

- One bounded read, `workTasksInView`, now feeds both the Work rows and the
  chrome's needs-you count. It reads `WORK_PAGE + 1` rows as an explicit
  overflow probe. With a project open the store's project-bound query is the
  bound. In the roll-up the admission list is enumerated project by project
  (each bounded to the probe) and merged newest first, so tasks in excluded
  repositories can never consume an admitted task's window. The per-row
  `visible` re-proof is unchanged; no store query changed.
- Unplaced rows ride every project-bound store read. A viewer who may see
  them keeps them exactly as before. For a viewer who may not (a
  project-scoped account) the read widens — 201 → 402 → 500, the store's
  own ceiling — until visible rows fill the probe or the read runs dry.
- Honest bounds and counts: when the probe finds more, the strip carries
  `data-work-bound="200"`, the All tab says `200+`, every tab carries a
  page-only title, the notice says "there are more" and that the counts
  cover these 200 only, and an empty shortcut view says "Nothing among the
  newest 200 tasks in view …" instead of "Nothing is building right now".
  When the widened read hits the 500-row ceiling without proving the page,
  the page says so (`data-work-bound="unproven"`) rather than claiming
  emptiness, and the badge reads as saturated.
- Permanent regressions (`src/serve.test.ts`, "Work admits before it
  limits"): 201 tasks in a selected project (200 rows, `200+`, bound notice,
  bounded empty copy); exactly the cap (no bound); 501 newer excluded tasks
  (200 admitted rows, none foreign, no empty claim, both projects merged
  newest first); a project-scoped member of one project and of two
  (opens Work and an admitted run with no selection, sees only its own
  rows); 201 newer unplaced tasks neither shown to nor starving the member;
  and 700 unplaced tasks producing the honest "unproven" notice instead of
  "Nothing is in progress".

### Finding 2 — unsupported negative claims (`src/workspace-ui.ts`, `src/serve.ts`)

Every status word now names what was recorded or last observed and what
stays unconfirmed:

| Before | After |
| --- | --- |
| Accepted: "Its checks were not passed by the machine, and the recorded exception says why." | "An approver accepted this result by hand, and the recorded exception says why. The machine's verdict is unchanged: *it verified the result before the acceptance / the checks on record are the agent's own report / the approved check failed against it (exit n) / its evidence did not match the sealed record / its required evidence was missing*." |
| Task page, accepted: "An approver accepted it by hand; the checks were not passed by the machine." | "…; that acceptance leaves the machine's verdict above unchanged." |
| Mismatch: "…; no check is recorded as failed." | "The proof's claims disagree with the sealed record. Whether the approved check passed is not settled by this verdict." (a structural refutation is adjudicated before the check is weighed) |
| Receipt, no publication: "Saved on the build branch — not published, merged, or deployed." | "Saved on the build branch. No publication, merge, or deployment is recorded here." |
| PR opened: "PR #n is open on GitHub. Merging stays a person's act; nothing is merged or deployed yet." | "PR #n was last seen open on GitHub. No merge or deployment is recorded here." |
| PR closed: "GitHub reports PR #n closed. Nothing was merged or deployed." | "GitHub last reported PR #n closed without a merge. No merge or deployment is recorded here." |
| Branch pushed / failed / requested | "…no pull request is recorded yet." / "The last publication attempt failed; no pull request or merge is recorded here." / "…no pull request or merge is recorded yet." |
| Cockpit publication card: "Merging stays a person's action on GitHub." | "The pull request was last seen open; no merge is recorded here." |

"Merge observed … Deployment is not confirmed by any record here." is
unchanged. The verified, attested, missing, refuted (failed check versus
mismatch), accepted, PR and merge states keep their distinct tokens and
labels. Tests: `src/workspace-ui.test.ts` (every publication and receipt
sentence must not match "nothing is/was merged", "person's act", "not
published, merged, or deployed", and the acceptance detail is asserted per
verdict), `src/dispatch.test.ts`, `src/serve.test.ts` (task, work, review
and chat surfaces of the published result).

### Finding 3 — real visibility proof and narrow-phone fit (`scripts/workspace-proof.mjs`, `src/serve.ts`)

- The old Add project check read `.project-add-card, form[action="/projects/open"] button[type="submit"]`,
  whose first match was the chrome switcher's hidden form button — a
  0 × 0 rectangle at 0,0 that satisfied `top >= 0 && top < 900`. The proof
  now scopes to the card, measures the card and its first real control
  (`.project-add-action`, else the exact-path summary/button) with
  `boxOf`: positive size, computed `display`/`visibility`/`opacity`/
  `checkVisibility`, and full bounds inside the viewport; a negative control
  proves the probe rejects the hidden rail form. **Measured, not
  asserted:** with three enrolled projects at 1440 × 900 the card starts at
  y = 995, below the first viewport (recorded as
  `addProjectFirstViewport` in `report.json`); the proof asserts full
  bounds after scrolling it into view. The earlier "inside the first
  viewport" pass was the zero rectangle, and the card's placement is
  package 0's design, left as it is.
- Filters: at ≤ 760 px the four tabs share the strip equally
  (`flex: 1 1 0`, centred, `white-space: nowrap`, `overflow: visible`, no
  hidden scrollbar); at ≤ 400 px type steps to 12 px; at ≤ 360 px the strip
  becomes a two-by-two grid at 13 px so every filter is wholly visible.
  Rows keep compact phone spacing (`.75rem` vertical padding). Desktop is
  untouched.
- The proof asserts each filter's own bounds at 390 and 320 px: inside the
  viewport and its strip, unclipped (`scrollWidth ≤ clientWidth`), ≥ 40 px
  tall, ≥ 44 px wide, ≥ 12 px type, a non-scrolling strip, and Completed
  wholly visible with its count. Measured at 320 px: All 16–160, Needs you
  160–304 (row 1), Running 16–160, Completed 160–304 (row 2), each 40 px
  tall at 13 px; at 390 px: 16–106 / 106–195 / 195–285 / 285–374, each
  40 px tall at 12 px.

### Finding 4 — one status while a review is pending, running or failed (`src/workspace-ui.ts`, `src/dispatch.ts`, `src/serve.ts`)

- `ReviewFacts` (from `store.reviewRetryStateOf` plus the live reviewer's
  liveness, read **per run**) ride `ResultFacts.review`; `reviewStatusOf`
  gives the v50 words and tokens (`review-pending`, `reviewing`,
  `review-failed`, `review-exhausted`) and `resultStatusOf` lets them lead
  unless the result is accepted or a scout report, appending the earlier
  verdict as history: *"Until the review settles, the earlier verdict —
  "Changes saved, but checks failed" — stays on record as history."*
  `diagnoseTaskDispatch` now takes its review words from the same
  projection; its codes, conditions, actions and `review` view are
  unchanged (all 22 dispatch tests pass as before).
- Every surface reads the same facts for the same run: the Work row, the
  task page's title status and status box (which leads with the review
  sentence in `data-review-lead`, keeps the recorded verdict sentence,
  and reads neutral rather than green/red), the receipt on the task page
  and in chat (status line plus a `receipt-review` line carrying the
  history; the criteria label still reads from the stored verdict), the
  chat journey headline and badge ("in review"), the review cockpit chip,
  and the run page's evidence card. The run page of an older run keeps
  that run's own verdict; an accepted result stays "Accepted with an
  exception" with the review history beneath it; lifecycle, retry
  allowance and reviewer lineage are untouched.
- Fixtures: `scripts/ui-polish-fixture.mjs` seeds three verified results
  whose review is queued, running under a live reviewer (`reviewer-1`,
  covering only the empty project), or failed with a retry left — through
  `requestReview` / `admitReview` / `finishRun`, the store's own doors
  (the fixture diffs now carry `captureStatus: "ok"`, which the request door
  requires). Tests: `src/workspace-ui.test.ts` (every review state, the
  history sentence, acceptance/scout/older precedence, `reviewFactsOf`),
  `src/serve.test.ts` ("a review in flight … leads with one status" across
  eight surface readings for queued → running → failed → accepted, with an
  older run of the same task unmasked).

### Verification

| Command | Result |
| --- | --- |
| `node ~/Documents/standing-orders/output/playwright/workspace-boundary-review.mjs <this checkout>` (the reviewer's script) | before: checks 1 and 2 failed; after: 4/4 pass (201 selected → 200 rows with the bound; 501 foreign → 200 admitted rows, no empty claim; member Work/run 200/200; 201 unplaced → member's assigned task visible, none unplaced) |
| `npx vitest run src/workspace-ui.test.ts src/dispatch.test.ts src/telegram-status.test.ts` | 40 passed |
| `npx vitest run src/serve.test.ts` | 271 passed (2 new tests; 6 wording assertions updated, none dropped) |
| `npx vitest run src/reviewer.test.ts src/board.test.ts src/tick.test.ts src/builder.test.ts src/telegram-status.test.ts src/dispatch.test.ts src/workspace-ui.test.ts src/cli.test.ts src/converse.test.ts` | 386 passed |
| `npm run build && node scripts/workspace-proof.mjs --out output/playwright/workspace-1/after --strict` | 167/167 checks, 25 screenshots (was 141) |
| `node scripts/ui-polish-proof.mjs --out output/playwright/workspace-1/ui-polish-regression --strict` | 75/75 — the prior approval and revision flows unchanged |
| `npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build` (the unchanged approved verifier, ONE run on the final tree) | exit 0: typecheck clean; 162 files, 2804 passed, 23 skipped (322.9 s); build ok |

New screenshots (ignored `output/playwright/workspace-1/after/`):
`narrow-work-320.png` (four filters in two rows), `phone-work-all.png`
(four filters in one row at 390), `desktop-task-review-failed.png`
(review leads, earlier verdict as history), `desktop-chat-reviewing.png`.

### Remaining limits

- ~~The store's task reads all include unplaced rows and cap one read at 500
  rows. For a project-scoped account only, more than about 300 newer
  unplaced tasks in one read window make Work say its read was cut short
  (`data-work-bound="unproven"`) rather than list the older assigned
  tasks; the tasks are not lost and the page never claims emptiness. A
  store-side query that excludes unplaced rows for such viewers is outside
  this package's no-store-change scope.~~ Resolved by the bounded admitted
  query below: the adaptive read, its 500-record ceiling and the
  "unproven" notice are gone.
- The reviewer-liveness fact is read at render time, so "Reviewing" becomes
  "Review interrupted" three minutes after the reviewer's last heartbeat —
  the same rule dispatch already applied.
- The Add project card sits below the first 1440 × 900 viewport once three
  projects are enrolled; this record now says so instead of passing on a
  zero rectangle. Changing its placement is a design decision not taken here.
- The reviewer's boundary script lives in the ignored output directory of
  the primary checkout; its cases are re-stated as permanent tests in
  `src/serve.test.ts` so a checkout without it still proves them.
- Headless Chromium only, synthetic fixture data, ignored output directory —
  as before.

## Bounded admitted query — 2026-09-13 (build 1546 follow-up)

Follow-up task `workspace-1-query-20260913`, seeded from the sealed head
`737b6c7` (build 1546). The reviewer's independent script
(`output/playwright/workspace-boundary-review.mjs` in the primary checkout)
had gained a fifth case — 700 newer unplaced tasks a project-scoped member
cannot see — and build 1546 failed it: the member's assigned-project Work
page showed zero rows behind the "read its 500-record bound" notice
(reproduced on this checkout before the change: `shown: 0`,
`assignedTaskVisible: false`, `limitedScanNotice: true`). The permitted work
was never lost, but a limitation notice is not a listing. Every change was
left uncommitted for the worker to seal. No schema, migration, scheduling,
approval, identity, permission grant, write path, revision filer,
installation, service, publication, deployment or dependency changed; the
legacy `listTasksScoped` is untouched, as is every other 1546 UI correction.

### One read-only Store reader (`src/store.ts`)

`Store.listWorkTasksAdmitted(admitted, includeUnplaced, limit)` returns
`Task & { repo }` rows for Work alone. `admitted` is the already-resolved
permitted repo set — `null` is explicitly unrestricted (every placed row),
`[]` means no placed project is permitted (no placed row at all) — and
`includeUnplaced` says whether NULL-repo rows belong to this viewer. Both
predicates, the admitted repo values and the flags alike, are bound SQL
parameters applied in the `WHERE` clause BEFORE `ORDER BY created_at DESC,
id DESC LIMIT ?`; the limit is clamped in the store (1..500, floored). An
empty admission binds as an empty `IN ()` list, which SQLite evaluates as
false, so no SQL shape changes with the input.

### Work reads it once (`src/serve.ts`)

`workTasksInView` now computes the permitted repo set — the open project,
else `admissionList()` (null when unscoped) — and `includeUnplaced` from
`visible(null)` (false for a project-scoped account), asks the store for
`WORK_PAGE + 1 = 201` rows, keeps the final per-row `visible` check, lists
the first 200 and treats a 201st row as the overflow probe. `needsYouCount`
reuses the same read, so the chrome badge, the tab counts and the `200+`
bound all derive from the same page and its probe. Removed: the adaptive
201 → 402 → 500 retries, `WORK_READ_CEILING`, the per-project enumeration
and newest-first merge, the `unproven` state and its "read its 500-record
bound" copy on the strip, the empty state and the notice. The truncated
bound, its `200+` count, page-only tab titles and bounded empty copy are
unchanged.

### Tests

- `src/workspace-query.test.ts` (new, 6 tests against the store directly):
  700 newer hidden unplaced tasks leave a project-scoped read exactly its
  permitted rows (and the legacy read still returns 500 unplaced rows, the
  reason Work no longer uses it); an unrestricted viewer gets unplaced rows
  newest first, bounded by the probe, with `null` admitting every placed
  project explicitly; 501 newer excluded tasks leave the admitted page full
  and ordered; an empty admission exposes no placed row with unplaced rows
  following the flag alone; the 201st-row probe (200 → 200 rows, 201 → 201),
  id tie-break, and the clamp (0, −7, 2.9, 10 000 → 1, 1, 2, 500); exact
  repo matching and a quote-bearing repo value bound, not concatenated.
- `src/serve.test.ts` "Work admits before it limits": the 700-unplaced tail
  now asserts the member's two beta rows with no bound, no `unproven`, no
  `500-record`, no empty claim, page counts (`2`, Completed 1); clearing the
  selection lands the member on alpha's newest 200 with the honest bound
  and no unplaced row; the unrestricted viewer sees `unplaced-699` first.
  Every earlier assertion in the test (201 selected, exactly the cap, 501
  foreign, member of one and two projects, 201 unplaced) is unchanged.
- `scripts/workspace-proof.mjs`: the `narrow-work-320` caption now says the
  four filters are wholly visible in two rows of two — the layout the
  measured `filters320` report and the screenshot show — instead of "one
  row".

### Verification

| Command | Result |
| --- | --- |
| `node ~/Documents/standing-orders/output/playwright/workspace-boundary-review.mjs <this checkout>` | before: 4/5 (case 5 `shown: 0`, `limitedScanNotice: true`); after: 5/5, exit 0 — case 5 `shown: 17`, `assignedTaskVisible: true`, `limitedScanNotice: false` |
| `npx vitest run src/workspace-query.test.ts` | 6 passed |
| `npx vitest run src/serve.test.ts src/workspace-query.test.ts src/workspace-ui.test.ts src/dispatch.test.ts src/store.test.ts` | 5 files, 400 passed |
| `npm run typecheck` | clean |
| `npm run build && node scripts/workspace-proof.mjs --out output/playwright/workspace-1/after --strict` | 167/167 checks, 25 screenshots, exit 0 |
| `node scripts/ui-polish-proof.mjs --out output/playwright/workspace-1/ui-polish-regression --strict` | 75/75 checks, exit 0 |
| `npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build` (the unchanged approved verifier) | **not run by the builder** — the machine-owned verifier runs after sealing and must pass before acceptance; its result is pending until it finishes |

### Remaining limits

- The full serial suite was deliberately not duplicated here; acceptance
  waits on the machine's own run of the unchanged verifier.
- `admissionList()` for a root ceiling enumerates the stored repos that pass
  it, so the `IN` list is as long as that enumeration — the same shape
  `listCompletedWorkScoped` already binds.
- The reviewer's script still lives in the ignored output directory of the
  primary checkout; its five cases are re-stated as permanent tests in
  `src/serve.test.ts` and `src/workspace-query.test.ts`.
- Headless Chromium only, synthetic fixture data, ignored output directory —
  as before.
