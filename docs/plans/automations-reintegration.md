# Automations: bringing back what runs on its own

*Research and plan, 2026-11-22. Nothing here is built. Branch read: `feat/native-mac-app-v1`.*

The ask: "how do we figure out the currently-hidden automations / repeated tasks flows that we have in the web UI —
I don't want to bloat too much but could be interesting if we nail an implementation."

## Rules this plan works inside

- **Feature freeze** (AGENTS.md, owner decision 2026-11-14): no new features on flows, AI teammates, starter kits,
  email inboxes or evals until 20 people outside the project use Toolroll. Fixes, security work and removals are fine.
  The same note says to spend effort on speed, the Work screen, first-run and settings.
- **UI simplicity check** (AGENTS.md): say it once, one primary action, detail on demand, no paragraph to explain a
  screen.
- **Chat and UI consistency** (AGENTS.md): chat reuses the same action, state and approvals; every action has a chat
  proposal or a labelled path to its control.

So every item below is marked one of:
**(a) Surface** what already exists (parity, discoverability; allowed now) ·
**(b) New capability** (the owner must lift the freeze for it) ·
**(c) Remove or keep hidden**.

## Short answer

The automations are not broken or half-built. They are whole, they run, and one switch plus one navigation decision
hides them. The web already has the right screen: `/flows` lists every flow as Needs you / Running / Turned on /
Paused, with what starts it, when it next runs and how the last run went. The Mac app has nothing but an unclickable
line for a flow card that waits on you.

The smallest thing worth doing: **one quiet "Runs on its own" list on the Work screen** (Mac widget and web Work),
read from the trigger records the server already keeps, with Pause, Resume and Run now, and a link to the flow page
for everything else. Fix the Mac's dead ask rows first. Leave building, galleries, kits and insights where they are.

## 1. What exists today

### Why you can't see it

| Mechanism | Where | Effect |
|---|---|---|
| The rail is Work · Chat · Settings only | `src/browser-workspace.ts:1034-1046` (comment at 1037-1039: "Flows and Agents are reached from Settings → Advanced and Search") | No Flows entry on the web rail, whatever the switch says. `/flows` lights up Settings. |
| "Show advanced features" switch, per person, **off for new accounts** | `src/advanced.ts:1-15`, `advancedShownFor` at `:24-31`; pages listed in `src/advanced-view.ts:17-31` | Off: Search leaves Flows out too (`src/browser/search.tsx:85-88`). Accounts that existed at v160 were written ON. |
| Older page chrome | `src/server/chrome.ts:714` and `:795` | Shows a Flows rail item and phone tab only when the switch is on. |
| Feature freeze | AGENTS.md | No new flow features; nothing was removed. |

Still reachable with the switch off: Settings → General → Advanced lists every advanced page
(`src/server/settings-sections.ts:340-350`), every route works, the CLI works, chat works.
Nothing is behind a build flag and nothing is half-wired.

### Flows (the engine)

All of this works today and is covered by tests beside each file.

| Piece | What it does | Files |
|---|---|---|
| Flow list | Every flow as one row: group (Needs you / Running / Turned on / Paused), what starts it, "Next in 12 min", "last ran 2 h ago: …", failing chip | `src/flows-ui.ts:83-144` (`flowListRow`), page at `:163-194`; route `flows.page` `src/server/route-table.ts:543` |
| Canvas and cards | Zones, cards, people, live updates | `src/flows.ts`, `src/flow-engine.ts`, `src/flow-live.ts`, `src/browser/views/flow-view.tsx`; routes `route-table.ts:551-554`, `:661-689` |
| Triggers | Nine kinds: button, schedule, github, linear, flow, webhook, email, chat, plane-review | `src/contracts/flow.ts:28`; `src/flow-triggers.ts:4-35`; pass at `:652-670` |
| Trigger state | Each trigger row keeps `state` (active/paused), `nextAt`, `lastAt`, `lastOutcome`, `failures` | `src/store.ts:2826` |
| Trigger controls | pause, resume, remove, check now, press | `route-table.ts:674-678` |
| Schedules and repeating work | Four readable cadences; a "standing order" files the same task each time, one at a time, with a budget | `src/flow-schedule.ts:1-9`, `:49-98`, `:207`, `:327` |
| Runs on its own | Password-signed, 1 to 7 days, lets a flow's own schedule approve its build and research tasks | `src/flow-unattended.ts:1-14`; routes `route-table.ts:664-665` |
| The pass that moves cards | Runs beside builds in the worker, no model | `src/flow-cadence.ts:1-14`, `:45` |
| Gallery, starters, recipes, kits | Templates grouped by purpose; four starter flows; one-time "recipes"; kits | `src/flow-gallery.ts`, `src/flow-starters.ts:17`, `docs/WORKFLOW_RECIPES.md`, routes `route-table.ts:541-545`, `:555-558`, `:593` |
| Export and import | A flow as one JSON file | `src/flow-share.ts`, `docs/flow-file.schema.json` |
| Insights | Counts per zone and script, no model | `src/flow-insights.ts`; route `route-table.ts:551` |
| Decisions in chat apps | Approve / Edit / Send back in Telegram, Slack, Discord, Teams | `src/telegram-flow.ts`, `src/chat-flow.ts` |
| Lead in chat | `propose_flow` with 24 operations, including `pause_trigger`, `resume_trigger`, `starter` | `src/contracts/flow-propose.ts:16` |
| CLI | `toolroll flows list / show / trigger pause / resume / check / unattended …` | `src/flows-cli.ts:42-73` |
| Old routines | Became scheduled flows in v115; old links redirect to `/flows` | `route-table.ts:559-570`; `src/server/tasks.ts:750-757` |

Guides: `docs/guide/flows.md`, `docs/guide/unattended.md`. Design brief: `docs/design/flow-gallery.md`.

### Other work that repeats, outside flows

| Thing | What it does | Where it shows today |
|---|---|---|
| Nightly full check on main | A scheduled flow, approved once | It is a flow, so `/flows` (`src/nightly-check.ts:1-14`) |
| GitHub nightly as release debt | The plane reads GitHub's own nightly runs | Release pages (`src/nightly-github.ts`) |
| Evening digest | One chat message a day, per person | Settings → Notifications (`src/settings-groups-ui.ts:260`, sent from `src/telegram.ts:842-849`) |
| Storage sweep | Daily, only when idle | Settings → Storage (`src/storage-sweep-schedule.ts:1-11`) |
| Memory tidy proposals | Weekly per quiet project; proposes, never changes | Settings → Learning (`src/memory-tidy.ts:155`, called from `src/operate.ts:14612`) |
| Task tidy | A person runs it from a preview | Work → put away (`src/tidy.ts`) |

These four housekeeping jobs each already sit beside their own setting. They are not "automations" a person sets up,
and a combined list would be a second place for the same fact. Leave them.

## 2. What each surface does now

| Surface | Flow cards waiting on you | See what runs on its own | Act on it |
|---|---|---|---|
| Web | Yes, in Work's Needs you (`src/server/home-asks.ts:76-102`, sent in `/work/rows`) | Only at `/flows`, off the rail | Full |
| Chat | Decision notices with buttons | Ask the lead | `propose_flow` |
| TUI | Yes; the row opens the browser (`tui/crates/toolroll-tui/src/app.rs:7285-7300`) | No | No |
| Mac app | **Shown but dead**: the row is plain text, no click (`mac/Sources/ToolrollApp/WorkHomeView.swift:201-213`), and the Swift model drops the `title`, `href`, `project`, `age` and `action` the server sends (`mac/Sources/ToolrollCore/Models.swift:140-156` vs `tui/crates/toolroll-api/src/models.rs:381-395`) | No | No |

The Mac's Work screen is three bundled widgets (`header`, `limits`, `list`) with order and hide kept in UserDefaults
(`WorkHomeView.swift:14-25`). Its plan, `docs/plans/work-screen-widgets.md`, defers "feeds" (connector data for
widgets) and says a scheduled feed refresh "is flow territory" that needs "a feature-freeze decision" (last bullet).

## 3. What a person needs

Four questions, in this order:

1. **Is anything waiting on me?** Already answered by Work's Needs you. Only the Mac row is broken.
2. **What runs without me, and when next?**
3. **Did the last run work?**
4. **Can I stop it, or run it now?**

Everything else (drawing a flow, picking a template, reading insights, signing "runs on its own") is rare, and the
flow page already does it well. A second editor anywhere would be bloat.

## 4. Recommendation

### Recommend

**R1. Make the Mac's waiting rows work.** *(a) Surface · allowed · effort S · bloat none*
A flow card that waits on you should show its title, its flow and its age, and open on click.
- Mac: add `title`, `href`, `project`, `age`, `action` to `NeedRow` (`mac/Sources/ToolrollCore/Models.swift:140`);
  make `askRow` a button that opens `href` the way a task's "open in browser" does
  (`mac/Sources/ToolrollApp/WorkHomeView.swift:201`; `WorkbenchStore.swift:2714`).
- Server, web, TUI: no change. No engine contract change, so no TUI rebuild.
- This is a bug fix: the app shows "Waiting on you" with no way to answer.

**R2. A "Runs on its own" list on Work.** *(a) Surface · allowed, with one small read · effort M · bloat low*
One row per flow that has an active or paused trigger that is not a button:

> **Nightly check** · toolroll · every day 03:00 — Next in 5 h · last ran 19 h ago, passed — *Pause* · *Run now*

- Hidden entirely when there are no such flows. No empty state, no "create one" pitch on Work.
- Row click opens the flow page. A failing row says the failure in the trigger's own words and sorts first.
- A signed "Runs on its own until <date>" shows as one word on the row; signing and revoking stay on the flow page.
- Server: one new read, `GET /engine/automations` (or a field on `/work/rows`; see the cost below), built by lifting
  the row facts out of `flowListRow` (`src/flows-ui.ts:108-144`) into a shared function so the web list and the new
  read can't disagree. Access is the flow list's own rule (`store.listFlows` plus `accountCanAccess`).
  Pause, Resume and Run now are the existing routes (`route-table.ts:674-675`, `:677`), unchanged.
- Web: the same rows as a collapsed group under Work's list; "All flows" links to `/flows`.
- Mac: a fourth bundled widget, `automations`, beside `header`, `limits`, `list` in `WorkHomeView.swift:17-23`,
  hidden by default when empty and hideable from Customize like the others.
- TUI: nothing now. Optional later: one read-only section that opens the browser, like its ask rows.
- Chat: no new action. The lead already has `pause_trigger` and `resume_trigger`; add a chat control that links to
  the list (`src/chat-controls.ts:19`). The gap to name: "run now" has no chat proposal today.
- Cost to know about: a field on `/work/rows` changes the engine digest and needs a TUI rebuild
  (`work-screen-widgets.md`, "No engine contract change in phase 1"). A separate route avoids that.
- Freeze reading: this adds no flow behaviour. It shows saved state and calls existing acts from the Work screen,
  which the freeze note names as where to spend effort. It does add one read route, so the owner should say yes
  (Decision 1).

**R3. Put Flows where a person would look.** *(a) Surface · allowed · effort S · bloat low*
Today it takes a switch most new people never find. Add one row, "Automations", in Settings' own list, that opens
`/flows`, shown when the person has at least one flow or the advanced switch is on. Keep the rail at three items
(`src/browser-workspace.ts:1040-1046`). Mac: the same link from the widget's "All flows".

### Maybe

**M1. One mechanism for feeds and triggers.** *(b) New capability · needs the owner · effort L · bloat medium*
The widget plan wants "feeds": connector data (Linear issues, GitHub PRs) refreshed on a timer and shown in a widget.
A flow trigger already is a timed read of a connector: the worker's pass polls GitHub through `gh` and Linear over
HTTPS, with no model (`src/flow-triggers.ts:30-35`, `:963`, `:992`, `:652-670`), keeps a cursor, records `nextAt`,
`lastAt`, `lastOutcome` and `failures`, treats outside text as untrusted, and has pause, resume and check now.
The only difference is where the result goes: a trigger makes a card; a feed keeps the latest rows.

So build feeds as **a trigger with a different destination**, not a second scheduler:
- Same row (`flow_trigger`), same pass, same cadence words (`src/flow-schedule.ts:49-98`), same controls. A feed is
  a trigger whose sink is "store rows" (`widget_feed`) instead of "add a card".
- One list (R2) then shows both: "Linear: my issues · refreshed 4 min ago · Pause · Refresh now".
- The freshness, staleness and failure wording is written once.
- For GitHub and Linear this needs no agent session at all, which removes the widget plan's hardest part
  (a revocable writer token, replay rejection, an agent holding connectors). Agent-fed feeds for other connectors
  stay a later, separate decision.
- It does contradict the widget plan's line that Toolroll "never calls Linear/GitHub itself". The trigger pass
  already does, with the person's own `gh` sign-in and a Linear key saved behind their password
  (`route-table.ts:662`). Reusing those is the honest design; the plan line should be corrected, not worked around.

This is new capability on the flow engine. Do not start it under the freeze. Design it now so R2's read and row
shape already fit it (a row has: name, source words, next, last, outcome, state, actions).

**M2. "Do this every time…" on the Mac.** *(a) Surface · allowed · effort S · bloat low*
The web task menu already offers the matching starter flow (`src/browser/views/task-view.tsx:1131`,
`src/server/render-tasks.ts:3201-3207`). The Mac's task menu could open the same page. Worth it only after R2, so
the thing you switch on has somewhere to appear.

**M3. A TUI "runs on its own" section.** *(a) Surface · allowed · effort S–M · bloat low*
Read-only, opens the browser. Only if people ask.

### Skip, or keep hidden

| Item | Class | Why |
|---|---|---|
| A flow canvas or editor in the Mac app or TUI | (b) | A second editor for a frozen feature. The web canvas works; link to it. |
| Gallery, new templates, kits, recipes in the Mac app | (b) | Frozen, and it is browsing, not daily use. Keep behind the flow page. |
| Flow insights on Work | (c) keep hidden | R2's "last run" line answers the daily question. Insights stays one click into the flow. |
| A combined "everything scheduled" page with digest, storage sweep and memory tidy | (c) | Each already sits beside its own setting. A second place says the same thing twice. |
| Signing "Runs on its own" from a widget | (c) keep on the flow page | It takes a password and shows every term. The secure review screen is the right place. |
| A Flows rail item | (c) | Three destinations is a decision already made; R3 covers finding it. |
| The `/routines`, `/recipes` and `/teammates` redirects | (c) remove later | Candidates for removal once nothing links to them (`route-table.ts:548`, `:555-570`). The "Recipes" row still in the older chrome (`src/server/chrome.ts:902`) is the first to go. |
| Agent-fed feeds, widget store | (b) | As the widget plan already says: own threat model, own decision. |

### Order

1. R1 (Mac rows open). Small, a real fix, ships alone.
2. R2 server read plus the Mac widget; then the web group.
3. R3 once R2 exists, so the link lands on something people have already seen.
4. M1 only after the freeze lifts, as its own reviewed plan.

### Acceptance (carry the simplicity check)

- A first-time user with no flows sees nothing new on Work.
- With one scheduled flow: its name, when it next runs and how the last run went are readable without opening it.
- Pause on the Mac shows as Paused on `/flows` and in `toolroll flows show`; Resume from chat shows on the Mac.
- A failing schedule is visible on Work without the advanced switch.
- One journey at desktop and one phone width for the web group; empty, long-name and failed-run states included.
- Before/after evidence in `evidence/`, not a score.

## 5. Decisions for the owner

1. **Is a "Runs on its own" list on Work inside the freeze?** It adds one read route and a widget, no new flow
   behaviour. *Recommendation: yes, treat it as Work-screen work, and say so in AGENTS.md's freeze note so the next
   agent doesn't have to guess.* R1 needs no decision.
2. **Should feeds reuse the trigger machinery (M1) instead of an agent-fed feed with its own scheduler?**
   *Recommendation: yes, one mechanism, and correct the widget plan's "never calls Linear/GitHub itself" line.
   Build nothing until the freeze lifts; shape R2's row so it fits.*
3. **Who sees automations by default?** Today a new person sees none unless they find the advanced switch.
   *Recommendation: show R2's list and the Settings row to anyone who has at least one flow, whatever the switch
   says; keep everything else about flows behind the switch.* This matches the switch's own rule that current
   state and off switches of things that act on their own are never hidden (`src/advanced.ts:12-15`).
