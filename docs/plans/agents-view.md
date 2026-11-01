# Agents view — plan

Status: v3 (2026-10-26). v2 answered Codex's NO-GO on v1 (13 findings, **[Fn]**); v3 folds in round 2 (partials on
F1, F4–F7, F9, F10, F12, F13 and new findings **[N1–N5]**). Alex chose (option A): no further plan rounds; build slice
by slice, Codex reviews each slice's code. Branch `agents-view-plan`. v3.1 (2026-10-27) folds in Alex's answers to the
three owner questions (§1, §4, slices 6–7).

## What and why

Alex: *"Can we have the terminal view to see what all the agents and subagents are doing at least."*

One page that shows every running agent at once, live: a grid of terminal-style tiles, one per agent, with the
subagents each one started nested under it. It is a window, never a control. Nothing on it types into an agent,
steers one, starts anything, marks anything seen, or changes who gets notified.

Next phase (not this plan): the inline handoffs box under the lead-chat message that started the work (live status,
elapsed time, done/failed mark, result chips such as "round 2 of 2 · NO-GO · 4 open", commits, diff, test counts, a
queued-message chip). It builds on this plan's projection and child streams.

## What exists today, corrected [F1, F9]

- **The Agents board** (`/agents`; `agents-board.ts`, `agent-board.ts`, `browser/views/agents-view.tsx`). It shows
  the newest **builder** attempt of built-in, project-linked tasks. It skips superseded revision parents, reads at
  most 80 candidates, and keeps unread Done and Needs-you rows for up to three days. Planners, scouts, reviewers and
  repairs are not tiles of their own; a repair shows as its build's activity. Stuck is `STUCK_AFTER_MS` (4 min) with
  no transcript change, or `TOOL_STUCK_AFTER_MS` (15 min) while a tool call is open. The minute pulse
  (`agent-pulse.ts`) measures the whole live file's size: any growth moves `transcript_at` and clears Stuck.
- **Opening a row changes state.** `/agents?run=` marks a finished run seen (`markAgentSeen`, `server/pages.ts`), and
  joining `room=agent:<run>` takes a watch lease that suppresses chat pings (`server/live.ts`). Both happen on GET.
- **The live file** (`live.ts`, `live-records.ts`). Each run writes `live/<run>.jsonl`: Claude `stream-json`, Codex
  `--json` items, and ACP `{acp: update}`. Strings are redacted, then control-stripped, then cut, at write time.
  `parseLiveRecord` re-checks shape and caps on read. A single `KeyState` hides key blocks: it is shared by the
  whole recorder at write time, and one `inkey`/`ktail` cursor carries it on read.
- **The window endpoint** is `GET /r/<id>?fragment=transcript&shape=records&from=` (`server/tasks.ts`), not `/runs/`.
  It is this machine's runner only (another runner answers `error: "off"`), reads through the file's own descriptor
  with an exact-id name and a generation. It always reads forward from `from`; its `allowTail` flag only lets a
  *finished* file return an unterminated last line [N1].
- **"Show commands"** (`live-detail.ts`) is captured when the writer opens a run's file and enforced **by the writer
  only**. The reader accepts command targets and output from any record, and the browser renders them. A forged
  file can therefore show commands the project never allowed.
- **Subagent events: the readers disagree.** `live-records.ts` drops every Claude event with a non-null
  `parent_tool_use_id`. `liveActivityKind` (`live.ts`) checks it only for `assistant` events, so a child's
  `system/init` counts as activity. `exec.ts` keeps child assistant events out of the receipt, but picks the
  primary result by `origin` only (`primaryResultOrigin`). A child's successful `result` with no `origin` can become
  the run's result and fire the receipt. `live-input.ts` has the same result gap and can close the parent's input.
  `agent-turns.ts` (`turnSignalOf`) ignores the field entirely, so a child's `result` marks the parent idle and
  clears its open tools. These are existing gaps; slice 1 fixes them first.
- **Codex and ACP**: today's adapters surface no child-agent events, so their tiles have no children. That describes
  our adapter support, not what the providers can do.
- **Lead progress** (`lead-progress.ts`, `server/chat.ts`) is in memory. `LeadProgress.text` goes straight into the
  live turn, without the live-file redaction, and the turn is dropped 60 s after it ends. Chat admission checks the
  approver role, owner and scope, the current thread, and the ceiling digest.
- **Live terminals** (`live-terminal.ts`, #222): person-driven ptys with no redaction. Not shown here.
- **Spend** is recorded after the provider process returns (`invoke.ts`), so a running attempt's spend is unknown.

## 1. The page

`/agents?view=live`: a second view of the Agents page behind a **List | Live** control. Its data comes from its own
observational endpoints (§3), never from the List view's selected-agent path.

**Who appears [F9].** Every run that is running now on any role (builder, planner, scout, reviewer, repair),
in projects the viewer may see, plus runs that ended in the last 10 minutes. A repair nests under its build. Runs on
another computer appear with header facts and "Output is on another computer". There is no last-day or 80-row limit:
the projection reads running runs directly, by index. Above 24 tiles, the newest 24 stream and the rest show header
facts only. The header says "24 of 31 shown live", and each extra tile has a "Show live" control, which swaps out the
oldest unfocused tile.

**Tile.**
- Header: title, project, role, agent and model in mono, elapsed time, and one state chip. The chip names the
  outcome when it ends: Done, Failed, Stopped, Parked or Unknown. There is no second footer mark [simplicity].
- Line two: what the agent is doing now. That is the open step in plain words ("Running tests", "Editing
  src/cart.ts") or the last `say` line.
- Body: the last 12 lines, auto-scrolling. Scrolling up pauses it and shows "Jump to latest".
- States: Loading, "Output unavailable" (missing or unreadable), "Output stopped at its size limit" (capped), "Output
  restarted" (new generation), and "Reconnecting…" (stream lost).

**Subagents get their own tiles (Alex, 2026-10-27).** A subagent's tile appears when it starts and leaves shortly
after it finishes: it holds a brief "Done" (or "Ended with an error") state for 30 s so nothing blinks away mid-glance,
then goes. Its tile is nested under its parent agent's tile: grouped with it, indented, and joined by a thin `--border`
connector line (a grandchild one level further). Same parts as any tile (title is the delegated description, current
step, last lines, elapsed time), at a smaller size. Lines that couldn't be shown are counted, not inlined: "5 lines
couldn't be shown". Child outcomes are observations from the transcript, never facts, and subagents are not counted on
the board. Desktop and phone both, in the first version: on a phone the nested tiles follow their parent in the single
column, indented by one step with the connector.

**Needs you (Alex, 2026-10-27).** A quiet tile reads "Needs you". When the parent is Stuck by the existing rule,
applied to its own activity (§2.2), or an agent has an open question, the tile takes the Operations Ledger's
waits-on-you treatment: the attention token as a full tinted outline, and the plain words "Needs you" in its one state
chip, with the reason as line two ("Quiet for 6 min", "A tool has run 16 min", or the question) and a link to the task
page. Amber means only this. A subagent can be quiet in its own tile; that is display only and never marks the parent.
Budget warnings are deferred [F11].

**Stable layout [simplicity].** Tiles keep their start order. A new tile appends; an ended tile stays in place until
it expires. Nothing moves while a tile has focus or the pointer, or while the person scrolls. Changes queue until
they leave, and the header shows "2 new".

**Phone** (it ships with the grid): one column. A tile shows its header, line two and 3 lines. The header strip is
sticky ("Live · 4 running"). No horizontal scroll, and tap targets are 44 px.

**Full screen.** Tap, or press Enter, on a tile to open `?view=live&run=<id>`, so back and reload work. It shows the
whole retained tail, every subagent expanded, and an "Open task" link. Escape returns focus to the same tile. On a
phone it is a sheet.

**Motion.** Tiles enter and leave with #223's transitions only. Nothing animates under reduced motion.

## 2. The data

### 2.1 One top-level predicate [F1]

New `src/stream-scope.ts`, two pure functions with no imports:

- `topLevelEvent(event)`: `parent_tool_use_id` is absent or null. Any other value (a string, `""`, a number) is a
  child: unknown shapes fail toward "not the parent".
- `primaryResultEvent(event)`: a `result` that is top-level and whose `origin` is absent, null, or `{kind:"human"}`
  (today's `primaryResultOrigin` / `claudePrimaryOrigin` / `live-input` rule, one copy).

Every consumer that drives parent lifecycle, identity or accounting uses them:

| Consumer | Today | After |
|---|---|---|
| `exec.ts` stream reader | child init enters the identity witness, conflict line and `onSessionId`; result picked by origin only | init witness, conflict, `onSessionId`, receipt and primary result require top-level |
| `provider.ts` `claudeParse` | child init sets/conflicts the session; result by origin only | same predicate for init and primary result |
| `invoke.ts` billing observer | child init sets key source and model; any success result sets `answered` | top-level only |
| `subscription-chat.ts` (lead) | child init sets billing; any result counts; last `result` line is the reply | top-level only; last primary result is the reply |
| `live-input.ts` | assistant filtered; result by origin only | `primaryResultEvent` for closes |
| `agent-turns.ts` `turnSignalOf` | ignores the field: a child result marks the parent idle | non-top-level returns null |
| `live.ts` `liveActivityKind` | filters assistant only | non-top-level returns null for every type |
| `live-records.ts` | drops all child events | unchanged (uses the shared predicate) |

Unchanged on purpose: oversized or unparseable lines keep today's fail-closed path (an oversized init still latches
the overflow witness; an oversized result still counts as the main result at the cap), because their parent field
cannot be read. `rate_limit_event` stays account-wide. Codex `--json`, Gemini and ACP events carry no
`parent_tool_use_id` and are unaffected.

Regressions (existing rule tables): child `system/init`, child `result` with and without `origin`, child
`assistant`. None fires a receipt, picks or replaces the primary result, tallies usage, closes or settles live input,
marks the parent idle or clears its tools, sets or conflicts the saved session, calls `onSessionId`, changes the
model or key-source observation or billing, or counts as activity.

### 2.2 Child activity is not parent progress [F2]

Decision: a parent is busy only by its own top-level events. A subagent running for 20 min while its parent waits
reads as the parent's open `Task` tool call, so the existing 15-minute tool threshold applies, as it does to any long
tool. To keep the pulse honest, children are written to a **separate file**, `live/<run>.sub.jsonl`. The parent file,
its size, the pulse, `transcript_at`, the peek, run-efficiency and today's renderer stay exactly as they are. This also
keeps slice 2 safe for existing consumers [F13]. Tests cover:
- both thresholds;
- child-only traffic, where the parent still goes Stuck;
- a child finishing, where the parent is not marked idle and its tools are not cleared;
- an actually quiet parent.

### 2.3 Child streams [F3, F4, F5, N2]

**Parent output is untouched [N2].** The parent recorder, its `s1, s2…` step ids, sequence, its own 64-step cap and
`once` behaviour are not changed. Children live in a second recorder instance writing `live/<run>.sub.jsonl`, with
their own caps. A test feeds the same stream (with child traffic and cap exhaustion) to the old and new recorder and
compares the parent file byte for byte.

**Routing is separate from open steps [F4].** The child recorder keeps a bounded *delegation map*: provider
`tool_use` id → child stream, created when the parent (or a child, for nesting) issues a `Task`/`Agent` call.
Entries survive the call's `tool_result`, so background children and late first events still route. The map holds at
most 32 entries; a child stream ends at its own top-level result, the parent's primary result, or process end, and
then its entry is kept (ended) so late events are counted, not re-opened. Depth is capped at 2.
- **Ids.** Child step ids are `c<s>s<n>` (a format the parent never uses). Provider ids are keyed by
  `(stream, providerId)`; a close names its own stream or is dropped and counted. A provider id already mapped is a
  collision: the second open is ignored and counted.
- **Results.** A child's `result` is classified child-relative (it ends that child only) and never reaches the
  parent's accounting (2.1).
- **Caps.** 16 streams, 32 open child steps in total, record caps unchanged; the 17th child writes one
  `{k:"over"}`. The reader enforces every cap again.
- **Redaction.** One `KeyState` and say-chunker per stream, at write and read. A child's init resets only that
  child. Redaction runs before cutting.

**Reading across windows [F5].** A continuation cursor carries: offset, generation, open streams with parent and
`via` links, each stream's open-step ids, ended streams, per-stream key state, and counters. Bounds: 17 streams,
32 open steps, capped tails; the encoded cursor is size-checked (≤ 4 KiB) before decoding. It is sealed with an HMAC
under a per-console key kept in the plane's state folder, never in a run's workspace. A valid cursor is state, never
authorization: every read re-proves access (§3). Order is append order. A record naming an unknown stream or step,
past a cap, or malformed is quarantined (counted, never shown, never promoted).

**Bootstrap [N1].** A first read or a rejected cursor needs the state the tail depends on. The writer appends a
**checkpoint** record every 32 KiB of child output and at each stream open: the open streams, their open steps and
per-stream key state, as the writer knows it. The reader seeks to the newest checkpoint within the last 256 KiB,
verifies it parses within caps, and continues from there. When none is found in that range, or it fails to parse,
the tile shows "Earlier output isn't available" and shows nothing from that file until the next checkpoint: it fails
closed rather than guess. A checkpoint is build-writable like the rest; at worst it misgroups or hides display text,
and redaction still runs on every line. The parent file cannot gain checkpoints (N2), so its
first read starts at `tail − 256 KiB` in an *unknown* key state: every line is hidden until an END marker is seen or
64 KiB pass without one (longer than any real key block), then shown from there. `allowTail` is not used, and an
incomplete last line stays pending until it ends. Tests: first load and cursor restart with openers and key markers far before the tail.

**Trust.** Display state only; no state, outcome, count or decision comes from either file.

### 2.4 Show commands, enforced on read [F7]

The ceremony and its run-start meaning stay. `run_live_detail(run PRIMARY KEY, commands INTEGER, captured_at)` is
written **once, before** either writer opens, from the project setting at that moment; `liveLogContext` gains the
run id and writes the row in the same step. Missing, unreadable, legacy (pre-migration) and failed-capture rows all
mean commands **off**; permission is never recovered from the transcript or the current setting. Every reader
(records and text projections, the existing `/r/<id>` endpoint, the peek, the new endpoints) drops `out` and blanks
command targets when the snapshot says off. Children inherit the parent's row. Tests: migration with old runs,
capture failure, setting changed mid-run, forged `open`/command/output records on both files. Prose redaction stays
best effort and does not stop deliberate encoding.

### 2.5 The projection and who is supported [F9]

`src/agents-live.ts` reads running runs of every role through `/r/<id>`'s visibility (`runVisible`,
`accountCanAccess`, `liveCeiling`), plus runs ended within 10 min; repairs nest under their build. A new partial
index `run_live_open ON run (started_at, id) WHERE outcome IS NULL` (and `run_live_recent` on `finished_at`) covers
every role; a query-plan test asserts both are used.

What each role produces today, and what the tile says:

| Role | Live file | Turns / pulse | Tile |
|---|---|---|---|
| builder | yes | yes | full |
| planner | yes | partial | full; Stuck only where the pulse runs |
| scout | yes | yes | full |
| reviewer (`build-review.ts`) | no | no | header facts, "Output isn't recorded for reviews" |
| repair (`builder.ts` repair invoke) | no | no | a row inside its build's tile |

Wiring the reviewer and repair into the recorder is a follow-up slice, not assumed.

## 3. Transport and security

**Observational endpoints [F8, F6].** `agentsPage` branches into Live **before** selected-agent construction, so a
reload of `?view=live&run=…` never reaches the mark-seen path. Live reads only from:
- `GET /agents/live` (the projection, JSON);
- `GET /agents/live/<run>?file=main|sub&cursor=` (the parent window through the existing reader, the child window
  through 2.3);
- `room=agents-live` on `/live`.

Each file read requires, in order: cookie session; current actor scope; exact run visibility; this machine's runner;
the trusted open below; then a re-proof of all of these after the read and before bytes are returned (today's
`server/tasks.ts` discipline). None of these calls `markAgentSeen`, takes a watch lease, builds a composer, or offers a reply, steer or stop
control. They are new route rows with the Agents page's role and scope, and GET only. Tests prove there are no
effects through opening, expanding, full screen, reconnecting and closing:
- the seen rows are unchanged;
- no watch lease is taken;
- a chat ping still fires while Live is open;
- no steer note, run or process is created.

**Room boundary [F6].**
- **Keying.** Rooms are keyed by `[account, scope]`, like `summaryRooms`, so one viewer's projection is never cached
  for another.
- **Re-proving.** Access is checked again before each file-observation tick that viewer's delivery depends on, before
  every send (including queued sends and keep-alives), and on every bus signal. A failure sends `gone` and drops the
  viewer.
- **What a nudge carries.** Only the ids of the viewer's own visible runs that changed. Never sizes, generations or
  text.
- **File observation.** One shared loop, every 2 s, over the union of streaming runs (at most 24 per viewer, deduped).
  Local runner only. Names come from the store's run ids, never from the checkout.
- **Trusted open [N4].** Reading and observing share one opener. The live directory is opened once as a directory
  descriptor and verified (real directory, not a link, owned by the plane, inside the data root resolved with
  `realpath`); files are opened relative to it (`openat`-style via `/dev/fd/<dirfd>/<name>` with `O_NOFOLLOW |
  O_NONBLOCK`), then `fstat` must show a regular file with `nlink === 1` and the device of the directory. A swapped
  ancestor, swapped directory, hard link, symlink or FIFO reads as unavailable. Ownership of a project is never
  inferred from the UID. Tests: ancestor substitution, directory swap mid-read, hard link to another run's file, run
  against the real `sandbox-exec` build fence as AGENTS.md requires.
- **Lifecycle [F12].** The loop notices growth, shrink, replacement (new generation), disappearance, finalization
  without growth (the run row ends), and expiry at 10 min after the end by the room's own clock, with no database
  write. It stops when the last viewer leaves.

**Server scan budget [N5].** The new endpoints read at most 64 KiB per request and scan at most 256 KiB for a line
end (not the reader's 64 MiB `SKIP_SCAN`); past that the answer is "skipped a line too long to show", distinct from
the writer's own size cap. At most 4 file reads run at once per console and 2 per viewer; beyond that the endpoint
answers 429 with `retry-after`, and the scheduler waits.

**Browser scheduler [F12, N5].**
- **Concurrency.** One scheduler per page: at most 4 reads in flight and one per run.
- **Priority.** Full screen first, then visible tiles (IntersectionObserver), then the rest.
- **Triggers.** A nudge sets a per-run *pending* flag; a nudge during an outstanding read only sets it again. After
  each read, the run is re-queued while the reply says more is available or the flag is set, until caught up. Main
  and sub files alternate so neither starves. No per-tile 2-second polling; Live does not reuse `useConversation`.
- **Deadlines.** Each read has a 10 s deadline; a timed-out read is aborted and backs off, freeing its slot.
- **Reconnect.** On SSE reconnect every visible tile is marked pending and catches up from its cursor.
- **First read.** From the bootstrap (2.3); never a drain from offset 0.
- **Retention.** A tile keeps 200 lines; full screen keeps 2,000.
- **Rendering.** Renders coalesce to one per animation frame.
- **Errors and cleanup.** Errors back off at 1, 2, 4… up to 30 s. Unmounting cancels outstanding reads.
- **Server side.** The read endpoint keeps the reader's scan cap and stops at it with "Output stopped at its size
  limit" rather than scanning on.

**Read-only, stated plainly.** The view starts no process and attaches to no pty. Person-driven terminals are not
shown; only a count of the viewer's own (from the console's terminal list, its owner check) links to Live terminals.
No `git` or tool runs in a checkout.

## 4. Design

Operations Ledger tokens from `src/server/console.css` and `DESIGN.md`; no new colours.

- **Tiles.** `--card` on `--background`, a `--border` hairline, `--radius`. The body is `--font-mono` 12.5 px on
  `--muted`; the header is `--font-sans`.
- **Hues.** Each status keeps its hue: Working uses a `--running` dot, Done `--success`, Failed `--danger`, and
  Stopped, Parked and Unknown are neutral.
- **Needs you.** The attention token (`--brand` / `--brand-soft`, the Ledger's waits-on-you) as a full tinted outline
  plus the existing attention badge with the words "Needs you"; never an edge stripe, never a new colour. It is the
  only amber on the page. Everything else stays on muted tokens with the one status vocabulary.
- **Nesting.** Subagent tiles indented one step under their parent with a 1 px `--border` connector; no new tokens.
- **Terminals line (Alex, 2026-10-27).** Terminals a person is driving stay off the grid. One quiet `--muted` line at
  the bottom, "2 terminals you're driving", links to Live terminals; it shows only the viewer's own count and never
  their contents. No line when there are none.
- **Labels.** Plain and conventional: **Live**, **List**, **Running**, **Done**, **Failed**, **Stopped**, **Needs
  you**, **Quiet for 6 min**, **Subagents (3)**, **Open task**, **Show live**, **Jump to latest**, **Close**.
- **Simplicity pass** (AGENTS.md) before sign-off:
  - one state indicator per tile;
  - no explanatory subtitles;
  - empty state "No agents running";
  - before and after screenshots in `evidence/`.

## 5. Slices [F13]

Order per Codex round 2. Each slice stays under 400 changed lines and 20 files, ships its tests, and gets a Codex code
review before the next.

1. **Parent-event filtering (fix first).** `stream-scope.ts` and every consumer in the 2.1 table, with its
   regressions. Nothing visible changes.
2. **Consent snapshot and file lifecycle.** `run_live_detail` migration and capture before writers open; enforcement
   in every existing reader. The sweep (`listLiveFiles`, `removeLiveFile`) recognises `<id>.sub.jsonl` as the run's
   file (active-run exemption, age and 500-file accounting per run, a 16 MiB child-file cap), with a test of an
   active child file under age and count pressure [N3]. Lands before any child file exists.
3. **Compatible child writer.** The second recorder, delegation map, caps, per-stream redaction and checkpoints;
   the byte-for-byte parent comparison.
4. **Child reader, cursor and bootstrap.** Sealed cursor, checkpoint bootstrap, quarantine, read-side caps, the
   trusted opener with its attack tests, the scan budget.
5. **Observational endpoints and room.** `agents-live.ts`, the indexes, the GET routes, the per-viewer room and file
   loop, the Live branch before mark-seen; the no-effect state tests.
6. **Grid, desktop and phone.** Tiles, subagent tiles nested under their parents (indent and connector, the 30 s done
   state), the Needs you treatment, the terminals line, overflow, scheduler, tile states, stable layout; one journey
   at desktop and one at 390 px.
7. **Full screen.** `?run=`, keyboard in and out, the phone sheet, "Open task" into result, feedback and revision.
8. **Lead tiles [F10].** Owner-scoped chat turns only, through the existing owner admission (`liveLeadThreadFor`
   picks the owner's thread and excludes team conversations; team threads wait for their own admission and progress
   source). Text goes through a per-turn stateful redactor (one `KeyState` carried across steps and over each
   cumulative text snapshot, then control stripping, then a cap); `sanitizeTranscriptLine` alone is not enough. Turn
   id, start and step times; leaves with the 60 s live turn; task links filtered by the viewer's own access.

Later: reviewer and repair recording; budget warnings once dispatch terms and current comparable spend exist (unknown
stays unknown) [F11]; then the handoffs box.

## 6. Acceptance tables

| Area | Cases |
|---|---|
| Stream integrity | forged or colliding ids; a sibling or parent close from a child; late and out-of-order events; nested and background children; depth past 2; cap exhaustion one child after another (16, 17th, open steps); unknown endings; process kill with open children |
| Read contract | first load and cursor restart with the opener and key markers before the last 256 KiB; no checkpoint (fails closed); parent opening in an earlier window; malformed records; generation replacement; reconnect with a stale or forged cursor; retained parent row evicted in the browser; legacy text files; interleaved BEGIN/END markers, split markers, escapes, command output and child descriptions across streams |
| Security | commands off and on, with forged `open`, command and output records; two viewers with different project scopes in the same room; revocation during polling and during a queued send; lead owner or role change mid-turn; symlink, FIFO and directory at the file path; no seen, watch, steer or process effects |
| Transport [N5] | several windows behind one nudge; a nudge during an outstanding read; four stalled requests (deadline frees slots); reconnect catch-up; 429 under the per-console read budget; a line longer than the scan budget |
| Lifecycle and performance | more than 24 agents (overflow count, Show live); a stalled read (others continue); capped and missing files; finalization without growth; expiry with no database write; watcher stops when the last viewer leaves; first load reads tails only |
| Journey (desktop + 390 px) | long content; one failed and one stopped run; a run with 3 subagents (tiles appear, nest, hold Done for 30 s, leave); a quiet run reading Needs you; the terminals line with none, one and two; loading, unavailable, capped and disconnected states; keyboard focus into full screen and back; reduced motion; Open task → result → feedback → revision |

## 7. Owner answers (Alex, 2026-10-27)

1. **Quiet tiles read "Needs you"** with the Ledger's waits-on-you treatment (full tinted outline, plain words); amber
   means only that; muted tokens and one status vocabulary otherwise (§1, §4).
2. **Subagents get their own tiles** in the first version, nested under their parent, with a brief done state, on
   desktop and phone (§1, slice 6). A subscription lead's own subagents come with lead tiles (slice 8), not before.
3. **Terminals a person drives stay off the grid**; one quiet line counts the viewer's own and links to Live
   terminals; never their contents (§3, §4).
