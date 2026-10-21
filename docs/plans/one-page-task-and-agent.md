# One page per task, one page per agent — plan

Status: **v3** (2026-10-20). r1 NO-GO (10); r2 closed 1, 2, 5, 6, 9, 10, left 3, 4, 7, 8 open and found 2 new High +
2 new Medium. v3 amendments are marked **(v3)**. Builds on branch `task-page-cta` (96f6d77b), which is merged into
this work's branch first (it is not an ancestor of the plan commit).

## What and why

Alex (2026-10-20): *"I click link after link and get lost when I want everything nicely organized in one place"*;
*"a clear simple task and agent page — all functions and CTAs well organized, recognizable vs all the other tools,
and within one page (not so much nesting)."*

The navigation problem, stated without counts: one task's work is reached through separate addresses — the task page
(with its Details panel on desktop / sheet on a phone), the result page `/review?result=…&run=…` (its own header,
status and decision surface, three sections), the run record `/r/<n>?record=1`, and the task chat lens
`/chat?task=…` — that link to each other. The plan's terms appear in the approval, the Scope section, and the
result's *Approved scope*. Several links that answer "what failed / what changed" leave the page. The agent detail
(`/agents?run=<n>`) shows the run's Conversation/Terminal and folded Changes, with *Result ↗* leaving for `/r/<n>`,
but not the task's status or its one action.

## The pattern (recognizable on purpose)

Linear's issue page (work in the middle, a Properties rail, every secondary act in one **⋯** menu, activity + composer)
and Vercel/GitHub run pages (one header, status, **one** primary button beside ⋯, a red failure box quoting the error,
tabs). Toolroll keeps its status vocabulary and the one-action rule.

## Contracts first (phase 0 — no visible change)

**1. One URL contract**, validated together on the server:
`/t/<family-root>?version=<task-id>&tab=activity|result|plan&run=<n>&section=<id>`.
- `version` keeps today's canonicalisation (child tasks → root + `version`), now also keeping `tab`, `run`, `section`.
- **(v3)** `run` must belong to **the selected version's own task** (the exact `ref.id`, as attempt selection does
  today, src/server/tasks.ts:2687) and be a result the viewer may see; otherwise the same 404/409 the review route
  gives today — **never** silently the latest, never another version's result under this version's scope. A link that
  names only a run derives `version` from that run.
- Query feedback (`noted`, `refused`, `conflict`) survives. Hash fragments (`#scope`, `#holds`, `#approve`,
  `#task-actions`, file anchors, check-log lines) are mapped **in the browser** (servers never see them) by one table.

**2. Ceremony lifecycle — no ceremony ever moves into a dialog.** The approval, confirm-stopped, cancel and every
password/step-up form stay **one mounted instance** in its page location (the approval keyed by
`approvalIdentity` = placement + digest, never the nonce, as on `task-page-cta`). Header, pinned bar and ⋯ items for
a ceremony **switch to its tab, reveal it and focus its first field** — they never submit or clone it. CSRF, nonce,
digest, rebuild/run bindings, server revalidation and the password-page sensitivity marking are unchanged.

**(v3) Go-to targets are exact.** Each ⋯/header/pinned destination is data: `{ tab, target id (the form or field, not
its section), disclosures to open (by id), focus target, available when (role, state) }`. The browser resolves and
focuses **after** the destination mounts (opening the named disclosures, not only ancestors); the server also opens
them when the URL carries `section=` so a full document navigation lands on a visible, focused control (no-JS
fallback).

**3. A destination table** — every section/action today, its new home, and its role/state conditions. Old containers
stay until their replacement has shipped and a parity test passes.

| Today | New home |
|---|---|
| Status card + sentence + detail rows | Header (status, sentence, one primary) + rows under it |
| Approval sheet (leading) | Under the header, as today |
| Approval (folded *Updated approval terms*) | **Plan** tab, top |
| Thread (filed, plan, progress, plan changes, questions/answers, notes, results) + composer | **Activity** tab |
| Previous result section | **Result** tab (attempt picker) |
| Report, incidents | **Result** tab (report) / **Activity** (incidents as thread items with their acts) |
| Build activity / attempts, usage | **Result** tab › Runs; usage in Properties |
| Steering notes (history) | **Activity** (already thread items) |
| **(v3)** Steering write form (*Save for the next attempt*), Pause-and-steer note | Status rows under the header, as today (approver, while a build can take notes) |
| **(v3)** Acts bar: queue next, undo order, requeue, plan, run checks, hold | ⋯ › Work (approver; each item only in the states its form accepts today) |
| **(v3)** Lead blocks (task controls, PR actions, reopen external work) | Under the header, above the tabs, as today (approver; when present) |
| Scope: goal/changes/won't touch/done when, Edit the scope, Why these agents, Change agents, recipe link | **Plan** tab |
| Waits for (dependency forms), Holds (release form), coordinator proposals | **Plan** tab › Dependencies & holds |
| Task options: identity, dispatch diagnostics, acts bar (hold, requeue, plan, run checks…) | ⋯ menu items (non-ceremony one-click POSTs stay POSTs) + **Plan** › Diagnostics |
| Cancel (armed behind one tap) | ⋯ › Danger → Plan › Cancel (stays armed, one deliberate tap) |
| Details facts (Work / Links / Review / About) | **Properties** rail (desktop) / chips + Details block (phone); status **not** repeated |
| Do this every time…, Evidence pack, Reuse as recipe | ⋯ › Share & reuse |

**4. Redirect exceptions** (redirects come last, phase 4): only **browser document GETs** after authorization are
redirected. Never: workspace reads (`format=workspace` — the workspace client treats any redirect as signed-out,
`workspace-client.ts:171`), bearer/API callers, `/r/<n>?fragment=check|facts|peek|transcript`, `/r/<n>?record=1`
(audit view stays), evidence downloads, live or non-result runs, the bare `/review` collection. `/review` has no
CSV/JSON export today; nothing claims otherwise.

## The task page

Header: breadcrumb · title · status + sentence · **one primary** · **⋯**. A red failure box (failed check only)
quotes the failing line with *View log* → Result › Checks at that line. Tabs: **Activity · Result · Plan**.
Properties rail on desktop. The pinned bar stays.

**⋯ More actions**, the same order on task and agent pages, destructive last: *Work* (Run checks · Build again · Edit
plan · Change agents · Hold/Release · Ask for a repair) · *Share & reuse* (Copy link · Evidence pack · Reuse as recipe
· Do this every time…) · *Danger* (Cancel task). Each item is either a one-click non-ceremony POST (as today) or
**go-to** its single mounted form.

**Result tab**: a new `ResultBody` extracted from `result-view.tsx` — summary, checks/requirements (failing first),
changes, runs, **and the Decision surface** — **without** only its duplicate header/status (the task header owns
those). **(v3)** The decision state (the person's check answers, readiness, revision controls, required reasons,
exact run/receipt fields) is **lifted** out of the disposable tab body into a `ResultDecision` controller at
`TaskView` level keyed by `(run, receipt digest)`, so switching tabs or attempts never loses an unfinished decision
and the header never diverges from the checks shown. Before Result has loaded, the header offers the status's own
primary (e.g. *Review result* → Result › Decision), never a decision it can't see. `ResultBody` takes a **host**
(`review` | `task`): on the task host the result script writes `section=` and the feedback POST return is built as
the task URL (`render-results.ts:2284`, `tasks.ts:1373` migrate together, no conflicting `tab` params); on the
`/review` host everything stays exactly as today. Native initialisation/cleanup runs on tab mount; feedback receipts,
scroll restoration and per-attempt draft keys (task, run) carry over.

**(v3) Refresh and selection contract.** The selected `tab`/`run`/`section` are part of the canonical URL **and** of
`workspace.refreshUrl`, which the server sets to that URL; switching tab or attempt is an in-app navigation that
updates both. Every workspace read carries a monotonic sequence; a response for an older sequence (or another
selection) is discarded. The conversation identity is the task (`sameConversation` ignores tab/run); a changed
selected result is an **intentional context transition** for the composer (draft kept, context line updated). Server
fragments inside the Result tab are keyed by `(run, receipt digest, fragment)`, so checks completing on the same run
remount just those fragments, while React-owned drafts persist. Tested: switching tab during a refresh, switching
attempt with a pending message, checks completing while Result is open.

**Performance boundary**: the result projection (`resultDetailOf`, patch parsing, diff HTML) is computed **only when
the Result tab is the one requested**; Activity/Plan refreshes stay as light as today. Switching to Result fetches it
through the existing workspace read. Parsing is reused within one request. Measured: response bytes, server time and
DOM size with a large diff under repeated live updates, before/after.

**Chat lens**: `/chat?task=X` → Activity; `&result=N` keeps that result as the composer's context (the task's docked
conversation gains the selected-result context the review page passes today); `revision`, `conversation` membership
and pending-message/draft recovery are preserved; channel fallback links (`chat-controls.ts`, `chat-decide.ts`) get
explicit mappings, tested in both directions.

## The agent page

List + detail stays (phone: one region at a time). The detail header is the **same header component** fed by a new
**server projection** on `BrowserAgentDetail`: the task's current status and primary action with an explicit target
task/run, **(v3)** authorised **per action for the actual caller** — role (viewer/approver), project access, demo
restrictions and the target's state — the way `runChecksHere` is computed today (src/server/task-views.ts:742), not
from `workAccess()`'s `principal: "operator"` (src/server/guards.ts:269); POST guards stay authoritative, shown **apart from** the selected run's own state (a historical run never borrows the
task's current action as if it were its own). Controls are only those the run supports (Pause/Steer/Stop/Resume/
Continue/Reply, unsupported-control explanations, unsent notes, checkout actions) — no universal toolbar. Tabs:
**Conversation · Terminal · Changes · How it ran**. **(v3)** Links are role/outcome-aware: a builder/repair **result** → the task's Result tab at that run; a planner
run → the task's Plan tab; a reviewer or scout run, or any run that isn't a result → its record (`/r/<n>?record=1`),
as today. Contract cases include a finished planner and a historical reviewer.

## Nesting

Target: page → tab → section. No new nesting is added; existing disclosures inside server fragments (scope editor,
agents why, result feedback) are audited and flattened where they aren't ceremonies; long lists keep one fold with
*Expand all*. Checked by **browser inspection** of the key states (counting nested `details` in the rendered page),
not a markup-only unit test.

## Phases

0. Contracts: URL schema + validation, browser fragment map, destination table encoded as data, ceremony rules — tests.
1. Additive: header + ⋯ + tabs (Activity, Plan) as new homes; Properties rail; old Details still present.
2. Result tab with `ResultBody`, lazy; `/review` page still works unchanged.
3. Agent detail on the shared header with the new projection.
4. Redirects for browser documents only; chat lens mappings.
5. Remove old containers once parity tests pass.

## Tests

Server ceremony assertions unchanged; security/contract suites gain: stale/replayed approval from the new location,
changed run, duplicate revision, wrong-password recovery, every redirect exception (bearer, fragments, record,
workspace reads, logged-out return, viewer/project-limited). URL contract: foreign/invalid runs 404/409; feedback
params survive; fragment map. Browser: one complete result → changes → feedback → revision journey at desktop and
phone (empty, long, failed states); dialog-free ceremonies reachable from ⋯ and pinned bar with focus; Escape/return
focus for the ⋯ menu; keyboard shortcuts never fire inside fields; sticky overlap; no-JavaScript fallback. Journeys
updated where they click disclosures/result-tab attributes; the Flows journey that approves via CLI gains a browser
approval case.

## Out of scope

Changing what any action does; the lead chat page itself; Flows pages.
