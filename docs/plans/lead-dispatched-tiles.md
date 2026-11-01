# Lead-dispatched tiles: the work a lead filed, nested under it on Agents → Live

Status: v2 (2026-10-27), with Codex read-only round 1 folded in (§8). Alex chose this over "lead subagents". A lead turn
can't start subagents: the subscription lead runs `claude -p --tools ""` and Codex runs with `multi_agent=false`, while
the direct lead has only Toolroll's own function tools. A lead's helpers are the tasks it filed.

## What

On Agents → Live, a build run (of any role) whose task the viewer's own lead filed nests under that lead. It gets the
same indent and hairline connector that subagents and repairs use, the same tile, the same chip, and amber only for
Needs you. Nothing else about the run's tile changes: it stays as long as the build-run rules keep it (while it runs, and
up to 10 minutes after it ends) and reads its windows the same way.

## 1. Which records link a run to the lead that filed it

A run → its task (`run.task_ref` → `task_ref`, `backend = 'built-in'`) → the task's **family root**, proved by
`taskFamilyOf` (every revision in the root's project and bound by its brief to its parent's own run; a broken lineage has
no root) **[C1]**. A revision of a filed task belongs, as in sweeps. Attribution is to the chat that filed the family's
*original* task: a revision asked for in a chat (`review` / revise) stays with its family's original filer, and a family
first filed elsewhere is not grouped even if a chat later revised it **[C4]**. The root links to a lead thread through
exactly one of the following:

| Record | Link | Written by |
|---|---|---|
| `lead_proposal` `kind='task'`, `state='confirmed'` | `outcome_json.taskId` = root, `outcome_json.ok = true`, `outcome_json.kind = 'task'`; the thread is `lead_proposal.thread` | the confirm door (`lead-doors.ts`), after the person confirmed the card with their password. The model writes only `payload_json`, never the outcome |
| `lead_sweep_task` → `lead_sweep` | `root_task` = root; the thread is `lead_sweep.thread`, and the sweep's own card (`lead_sweep.proposal`) is still kept, confirmed by V, in that same thread | `fileSweep` (`chat-actions.ts`), inside the confirm of a sweep card |

Considered and left out:
- **`task_ref.filed_by` / `filed_via = 'mate'`.** This names the person and the channel, not the thread. It is used as a
  corroborating check (below), never as the link itself.
- **Assignments.** `team_task_owner` names a *team* lead, and team threads are not lead tiles (slice 8). An
  `assignment claimed` row names a coordinator credential. Neither one is the viewer's personal lead chat.
- **`lead_proposal` kinds other than `task`.** Their outcome may carry a `taskId` they *acted on* (answer, steer,
  cancel…), but they did not file it.

## 2. Proving the link from trusted store state only

Everything is read from the store at request time, never from a live file, a transcript, a cursor or the browser. For
the viewer `V` (cookie session, approver role), a run `R` is "filed by thread `T`" when all of these hold:

1. `R` is already on V's Live response (the same `canSee` proof: console ceiling and the account's own access, proved
   per run). The link only *groups* tiles V already gets, and never adds one.
2. `R`'s task is built-in, and `taskFamilyOf` proves its family with no problem and `R`'s task in it.
3. The root's `task_ref`: `filed_via = 'mate'`, `filed_by_kind = 'person'`, `filed_by = V`.
4. Exactly one link record from §1 names the root:
   - **proposal:** `resolved_by = V`, `payload_json.repo` equals the root's repo, and its thread's `approver = V`;
   - **sweep:** `owner = V`, `repo` equals the root's repo, `thread` is not null, its thread's `approver = V`, and its
     card is kept: `state = 'confirmed'`, `resolved_by = V`, in that thread.

   Two or more records, or ones that disagree, give no link.
5. The thread is not a team conversation (`team_conversation.thread`).

Anything that fails leaves `R` an ordinary top-level tile, so a forged or stale link degrades to today's view and never
widens it. Any other viewer, including one who can see `R`, gets no link. That keeps the grouping owner-only, like lead
tiles. A token caller is refused at the door, as it is today (403).

The answer carries only `filedBy: { thread, chat: "lead" | "project" | "task" } | null` per tile: the thread id and the
kind of chat it is. It never carries the thread's title, scope key, proposal text or sweep brief.

**Retention [C2, I2].** A link lives exactly as long as the card that made it, under one rule for task cards and
sweeps. Ending a chat (`--end`) or revocation erases the open chat's cards (`closeLeadThreadsFor`), and with them every
link that chat made: its runs become ordinary top-level tiles. Replacing a chat (a new thread for the same scope, or a
new ceiling) closes the old thread but keeps its cards as history. So its runs stay grouped, including after a later
end, which erases only the then-open thread. The view mirrors what the store keeps. It never erases more than the
store does, and it never shows what the store has erased. Changing what an end erases is a store retention decision,
outside this view.

## 3. Lifecycle and placement

- A dispatched run's tile follows the build-run rules: it appears when the run starts, stays while it runs, and stays
  up to `LIVE_ENDED_KEEP_MS` (10 min) after it ends. Its repairs and subagents stay nested under it.
- **While V's lead tile for `T` is shown** (the live turn and its 60 s after), the run nests under that lead tile.
- **When the lead tile is not shown** (the turn ended, or the run started later, which is the usual case because a
  filed task starts after its approval), the run nests under a **quiet group header**:
  "Filed by lead chat · shop-web" (`project chat`/`task chat` by kind; the project is the children's own, already shown
  on their tiles). The header has no chip, no lines and no amber. It is muted text, and it exists only while at least one
  child is shown.

**Why a header and not a fallback to top-level:** a dispatched run usually outlives the lead turn that filed it by many
minutes (the turn's tile leaves 60 s after it ends). With a top-level fallback, every such run would jump from nested to
top-level a minute into its life. That breaks the grid's stable-layout rule ("nothing moves while…") and loses the
grouping exactly when it is most useful (several filed builds at once). With a header, the run stays nested for its whole
life on the grid. When the lead tile comes and goes, only its parent (lead tile ↔ header) changes.

**Placement [C3].** A lead with no filed run on the grid keeps its place at the top. A lead group (its tile, or its
header once the tile has gone) stands where its first run stands in the grid's stable order, so the turn ending moves
nothing. It is one keyed component either way: only the heading swaps, and the runs under it are not rebuilt, so their
scroll and follow state stay. A run is rendered once. A tile with `filedBy` is never also top-level. A repair whose
build is shown renders only under its build, and a filed repair whose build has left nests in the group itself.

**Full screen.** The lead's full-screen dialog lists the runs it filed that are on the grid (title, chip, Open task).
A run's own full screen is unchanged.

## 4. Rules (unchanged from Live)

The view is read-only. It works with a cookie session only: tokens are refused. It is owner-only, it adds no write, and
nothing reachable from it acts. It uses no new colour or token.

## 5. Bounds and cost

Per `/agents/live` request, and per room poll (the room's fingerprint includes the links, so a link made or erased
reaches the page **[I1]**), the cost is:
- one read of V's personal threads;
- one family proof per task, memoised across that task's attempts;
- **one** read of V's confirmed task cards for all the shown roots together (through `lead_thread` by approver and
  `lead_proposal` by thread and state);
- one sweep read **[I3]**.

Nothing is cached across viewers.

## 6. Tests

- **Unit:** each link kind; revision of a filed task; each failing condition in §2 (not filed by V, not via mate, resolved
  by another, repo mismatch, a team thread, a pending or refused proposal, an outcome without ok, duplicates, a broken
  ancestry, an outside tracker's task).
- **Attack:** another viewer's lead (robin sees the run, gets no `filedBy`); a forged proposal outcome naming a task V
  didn't file; a stale link (a proposal for a task since filed again elsewhere / a thread whose approver differs); a
  token caller (403).
- **Browser:** nesting under the lead tile; the header fallback; never twice; Done-then-leave unaffected; full screen
  lists the filed runs.
- **Proof script:** a lead that filed two tasks, at desktop and phone width.

## 7. Limits

- A lead tile at the top that gains its first filed run moves to that run's place. A filed run usually starts after
  the turn has ended, so this is rare.
- The link is display grouping only. It grants nothing and decides nothing.

## 8. Codex round 1

Five findings (`.reviews/design-r1.txt`), all folded in before the build:

1. **C1 (Medium), weak ancestry.** `revisionAncestryStatus` doesn't check project or brief binding. Fixed: the root
   now comes from `taskFamilyOf`, with cross-project and borrowed-brief cases in the rule table.
2. **C2 (Medium), retention differs between the two sources.** Ending a chat deleted task cards but not sweeps.
   Fixed: a sweep links only while its own card is kept, which gives one rule (Retention above). Tested through
   `closeLeadThreadsFor`.
3. **C3 (Medium), the header swap remounted the runs.** Fixed: one keyed `LeadGroup`, placed at its first run. The
   browser test checks that the nested element is the same before and after the lead leaves, and covers a filed repair
   whose build has left.
4. **C4 (Low), "other kinds didn't file it" was imprecise.** Revise creates a revision. Fixed: attribution is
   documented as the original family's filer.
5. **C5 (Medium), the HTTP boundary.** Fixed: the attack suite (`test/attacks/lead-filed-tiles.test.ts`) drives the
   real console as owner, as another viewer of the same run, and as token callers. It checks that the delivered run set
   is the same with and without links, and covers two attempts of one task.

## 9. Codex implementation round 1 (NO-GO, five findings, all closed)

1. **I1 (Medium), a link change didn't refresh Live.** Fixed: the room's fingerprint includes each run's link, and a
   room test makes and erases a link with the run and its files unchanged (it fails without the fix).
2. **I2 (Medium), a replaced thread's link survived an explicit end.** The store keeps a replaced thread's cards
   (history), and the view mirrors the store. Documented under Retention, with a test of the replace → end sequence.
   Changing what an end erases is left to the store's retention rules.
3. **I3 (Medium), card history was scanned once per family.** Fixed: one read per request for all shown roots, and
   family proofs memoised per task. A test with 2,000 old cards asserts a single `lead_proposal` read.
4. **I4 (Medium), full screen left out a filed repair.** Fixed: the dialog lists every shown run the lead filed,
   repairs included.
5. **I5 (Medium), full screen's list went with the lead's turn.** Fixed: the list renders independently of the turn,
   with a test that keeps the dialog open while the turn leaves.

## 10. Codex implementation round 2 (all five of round 1 confirmed closed, one new finding, closed)

- **R2-1 (Medium), the lead dialog hid a lost connection once the turn had left** (the filed-run list stayed, without
  the warning). Fixed: "Reconnecting…" shows whenever the dialog shows anything (the turn or its filed runs). The
  regression drops and restores the stream after the turn leaves, and it fails without the fix. This was the second
  and last review round (the review budget); the fix ships with its test.
