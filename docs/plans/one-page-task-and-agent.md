# One page per task, one page per agent — plan

Status: **v2** (2026-10-20) after Codex plan review r1 (NO-GO, 4 High / 5 Medium / 1 Low). Builds on branch
`task-page-cta` (96f6d77b: one-action status, pinned bar, approval identity).

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
- `run` must belong to that version's family and be a result the viewer may see; otherwise the same 404/409 the review
  route gives today (`tasks.ts:492`) — **never** silently the latest.
- Query feedback (`noted`, `refused`, `conflict`) survives. Hash fragments (`#scope`, `#holds`, `#approve`,
  `#task-actions`, file anchors, check-log lines) are mapped **in the browser** (servers never see them) by one table.

**2. Ceremony lifecycle — no ceremony ever moves into a dialog.** The approval, confirm-stopped, cancel and every
password/step-up form stay **one mounted instance** in its page location (the approval keyed by
`approvalIdentity` = placement + digest, never the nonce, as on `task-page-cta`). Header, pinned bar and ⋯ items for
a ceremony **switch to its tab, reveal it and focus its first field** — they never submit or clone it. CSRF, nonce,
digest, rebuild/run bindings, server revalidation and the password-page sensitivity marking are unchanged.

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
| Steering notes | **Activity** (already thread items) |
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
changes, runs — **without** its header/status/decision surface (the task header owns those). `result-review.ts`
migrates its URL writes from `tab=summary|changes|checks` to `section=`; return validation accepts the task URL;
native initialisation/cleanup runs on tab mount; feedback receipts, scroll restoration and per-attempt draft keys
(task, run) carry over.

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
task/run and its authorization, shown **apart from** the selected run's own state (a historical run never borrows the
task's current action as if it were its own). Controls are only those the run supports (Pause/Steer/Stop/Resume/
Continue/Reply, unsupported-control explanations, unsent notes, checkout actions) — no universal toolbar. Tabs:
**Conversation · Terminal · Changes · How it ran**. *Result ↗* → **Open task** (Result tab, that run).

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
