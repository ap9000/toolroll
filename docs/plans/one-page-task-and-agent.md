# One page per task, one page per agent — plan

Status: v1 draft (2026-10-20), for Codex review. Builds on branch `task-page-cta` (the one-action status, pinned bar).

## What and why

Alex (2026-10-20): *"I click link after link and get lost when I want everything nicely organized in one place"* and
*"make sure we have a clear simple task and agent page — all functions and CTAs need to be well organized,
recognizable vs all the other tools, and within one page (not so much nesting)."*

Today one task lives on **five surfaces** that link to each other: the task page (`/t/<id>`), the Task details sheet
(facts + 5 folds), the result page (`/review?result=…`, its own status card, 3 tabs, ~45 folds on a big diff),
the run record (`/r/<n>?record=1`), and the chat lens (`/chat?task=…`). The plan lives in three places (the approval,
the Scope fold, *Approved scope* on the result page). Every *See what failed* leaves the page; *Open task* comes back
to the top. The agent page (`/agents?run=<n>`) shows a run's Conversation/Terminal and a folded *Changes*, and its
*Result ↗* leaves for `/r/<n>` — it never shows the task's status or its one action.

## The pattern (recognizable on purpose)

Taken from the tools people already know, not invented:

- **Linear's issue page** — the work in the middle, a **Properties** rail on the right, every secondary act in **one
  "⋯" menu** in the top bar, activity + composer at the bottom.
- **Vercel's / GitHub's run page** — **one header** with status and **one primary button** beside "⋯", a **red
  failure box** quoting the exact error with a link to the log, and **tabs** for Logs / Source / Summary.

Toolroll keeps its own status vocabulary and the one-action rule (amber/attention = waits on you).

## The task page

```
┌ Project › task-id ─────────────────────────── [ Primary action ] [⋯] ┐   top bar (sticky)
│ Title                                                                  │
│ ● Needs you — one sentence                                            │
│ ┌ red failure box (only when failed): the failing line · View log ┐   │
│ [ Activity ] [ Result ] [ Plan ]                         │ Properties │
│                                                          │ Status     │
│  …the tab's content (one level: sections, no folds        │ Project    │
│   inside folds)…                                         │ Agent      │
│                                                          │ Branch/base│
│  Activity ends in the composer                           │ Checks     │
│                                                          │ Filed by…  │
└──────────────────────────────────────────────────────────┴────────────┘
```

- **Header**: breadcrumb, title, status + one sentence, **one** primary button (the need's own action: Approve &
  build again, Retry, Confirm it stopped, Open the failed check → becomes *switch to Result › Checks*), and **⋯**.
  The pinned bar from `task-page-cta` stays for phones.
- **⋯ More actions** — the one home for every secondary act, grouped the same on every page, destructive last:
  - *Work*: Run checks · Build again · Edit plan · Change agents · Hold / Release · Ask for a repair
  - *Share & reuse*: Copy link · Evidence pack · Reuse as recipe · Do this every time…
  - *Danger* (red, separated): Cancel task
  Each item opens **one dialog** containing today's server form (same ids, nonces, password fields), never a fold.
- **Tabs** (URL `?tab=`; deep links keep working):
  - **Activity** — the thread (filed, plan, notes, results, questions, replies, lead messages) and the composer.
    Replaces the chat lens: `/chat?task=<id>` redirects here.
  - **Result** — the latest result (picker for earlier attempts): summary, checks/requirements with the failing one
    first, changes (files collapsed with one *Expand all*), *How it ran* (plan 2). Replaces the result page:
    `/review?result=<id>&run=<n>[&tab=…]` and `/r/<n>` redirect here (`?tab=result&run=<n>&section=…`); the full run
    record stays reachable as a link inside it (it is an audit view, not a place you work).
  - **Plan** — goal, changes, won't touch, done when, agents, checks level, approval history; **Edit plan** and the
    approval live here when not leading (when the approval *is* the action, it sits open under the header as today).
- **Properties rail** (desktop) — today's Details facts as label/value rows, Linear-style; on a phone the rail is a
  compact row of chips under the header plus a **Details** section at the end of the Activity tab (no sheet).
- **Nesting rule**: page → tab → section. No `<details>` inside `<details>`; the only folds left are long *lists*
  (files, earlier attempts) with an *Expand all*. The Task details sheet and its five folds go away.

## The agent page

- Keeps the **list + detail** layout (Slack/Linear inbox — recognizable), phone = one region at a time.
- The detail uses **the same header component** as the task page: task title (links to the task), status + sentence,
  the same primary action, the same **⋯**. Live controls (**Pause · Steer · Stop**) sit together as one toolbar in
  the header while the run is live, Stop last and red.
- Detail tabs: **Conversation · Terminal · Changes · How it ran** — *Changes* becomes a tab, not a fold.
  *Result ↗* becomes **Open task** (→ the task's Result tab for this run).

## Shared pieces (so it reads the same everywhere)

`<WorkHeader>` (breadcrumb, title, status, primary, ⋯, live toolbar), `<MoreActions>` (grouped menu → dialog with
server form), `<Properties>` (rail/chips), `<Tabs>` with URL state. One status chip, one primary-button style, the
same menu order on both pages. Keyboard: `g a / g r / g p` switch tabs, `.` opens ⋯, `Enter` on the primary.

## Phases

1. **Header + ⋯ menu** on the task page; Task details sheet → Properties rail/chips; status card's actions move to
   the header (status sentence and detail rows stay below it). Folded sections (Change agents, Edit the scope, Task
   options, Waits for, Cancel) → menu dialogs.
2. **Tabs**: Activity (thread + composer), Plan; then **Result** (result-view components rendered inside the task
   page from the same server projection) with redirects from `/review` and `/r/<n>`.
3. **Agent page** on the shared header; Changes tab; Open task link.
4. **Chat lens** folds into Activity; redirects; old links in notifications/Slack/Telegram keep working.

Each phase ships on its own with journeys updated; the taste-skill inspector runs before/after at 1440 and 390.

## Tests

- Redirect table: every old URL (`/review?result=…[&tab]`, `/r/<n>`, `/chat?task=…`, `#scope`, `#holds`,
  `#task-actions`, `#approve`) lands on the right tab/section; logged-out still goes to sign-in first.
- Menu: every secondary act reachable in ≤ 2 clicks from the header; each dialog posts the same form as today
  (existing ceremony tests run unchanged against the dialog markup).
- No nested folds: a DOM test fails if any `details details` exists on the task or agent page.
- Agent detail: header shows the task's primary action; Changes is a tab; Open task → Result tab.
- Journeys: every app/flows journey that clicked through the old surfaces follows the new tabs.

## Out of scope

Changing what any action does; the lead chat page itself; Flows pages.
