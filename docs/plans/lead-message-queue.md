# Lead message queue — plan

Status: **v3** (2026-10-20). r1 NO-GO (3 High / 4 Medium); r2 closed r1's 1, 2, 3, 6 and found 2 new High + 2 new
Medium (history leak of unadmitted rows, stalled deferral stamp, monthly-budget terminal, edit vs request identity)
plus open 4, 5, 7. v3 amendments are marked **(v3)**.

## What and why

Alex chose this first after Ramp's Laminar post: an agent session stays "always open to new input" — a message sent
while a turn runs waits its turn instead of being refused.

**Today** (verified): personal lead threads — the default `/chat`, the task lens (`/chat?task=`, the task page's
composer) and project chats — go through `chatSend` → `runLeadTurn`, whose admission refuses with `concurrent`
(`LEAD_REFUSAL_COPY.concurrent`, src/lead.ts:148) and saves nothing. The React composer blocks sends earlier still,
while `pendingTurnId` is set (src/browser/app.tsx:201). Telegram requeues its own copy (ten-minute age limit) and
Slack/Discord/Teams defer five seconds.

**Shared team conversations already queue properly** (src/team-leads.ts, src/team-runtime.ts): every message is saved
as a `lead_message` + `team_message` row (`queued → running → answered | failed | cancelled | uncertain`), one running
writer per conversation (unique index), request identity `(conversation, author, request_id)` + payload hash, cancel
and edit-while-queued, and a runtime that claims the next message and runs it through `runLeadTurn` with
`queuedMessageId` + `onAdmitted`, which **binds the queued row to the turn inside the engine's own admission
transaction** (src/lead.ts:357-369). Admission refusals (caps, budget, latch, `concurrent`) **defer** the row with a
stamp instead of failing it; an exception after admission marks it `uncertain` and is never resent.

**v2 decision: personal threads use that same machinery.** No new admission path, no batching.

## Behaviour

- Sending while the lead answers (or while any personal lead turn of yours runs) saves the message at once; it shows
  in the thread as yours with *Queued* and **Remove**. The composer is free again. **(v3)** No Edit in this version:
  Remove + send again covers it, and keeps one immutable identity per request.
- **(v3) Bounds**: at most 10 queued messages and 20,000 characters queued per person; beyond that the send is refused
  with *"10 messages are already waiting — remove one or wait for a reply"*, the draft kept. Queued messages expire
  after 7 days (*Not sent — it waited too long*).
- Queued messages run **one per turn, in order** — exactly like team conversations. Each turn sees the earlier ones
  in history. (v1's "join into one turn" is dropped: it broke the 2,000-character message limit, mixed per-message
  context such as "viewing result #N" and composer modes, and needed one receipt per joined request.)
- A queued message whose turn can't start yet (daily cap, budget, unknown-cost latch, another of your turns running)
  **stays queued** with the waiting words (as team conversations do); one that can't ever run (session ended, standing
  or access changed, task no longer visible) ends **Not sent** with the words. Nothing is silently dropped or resent.
- **Stop** stops the running turn; the queue continues with the next message. Remove covers "don't send that".

## Design

**Table `lead_queue`** (versioned additive migration, indexes + constraints, upgrade-path coverage): `message`
(PK → `lead_message.id`, the operator row appended at send time with `turn NULL`, as team does), `thread`, `approver`,
`approver_generation`, `session` (the lead session it was sent under), `ceiling_digest`, `request_id` NOT NULL
(UNIQUE `(session, request_id)`), `payload_hash` (sha256 of `[thread, text, context]` — **the same digest the engine's
`mate-send` receipt stores**), `context_json` (the send's own context: task/execution, viewed result run, composer
mode, project — resolved and validated at send time), `status` (`queued | running | answered | failed | cancelled |
uncertain`), `revision`, `generation`, `runner`, `claimed_at`, `turn_id`, `error`. A unique partial index allows one
`running` row per approver (personal concurrency is per approver, not per thread — `openLeadTurn` already enforces
that; the index makes the queue agree).

**(v3) History never includes unadmitted messages — on every path.** Today `historyFor` skips operator rows with
`turn IS NULL` only when the caller passes `queuedMessageId` (src/lead.ts:236), and `listLeadMessages` takes the
latest 40 **before** that filter (src/store.ts:19120). v3 makes both unconditional: history is selected **in SQL** as
admitted rows only (operator rows with a turn, and assistant rows), then limited to 40. Queued, removed, expired and
refused messages therefore never reach the model through an immediate send, a follow turn or a channel turn. Removing
or expiring a queued message also **deletes its text** (`lead_message.text` blanked, `context_json` deleted) and keeps
only a tombstone (request id, payload hash, status). A test fixes the reproduction Codex gave (queue B while A runs,
remove B, send C → C's history has no B; a follow turn while B waits → no B).

**Send** (`chatSend`, personal branch) — in one store transaction:
1. If `(session, request)` has an engine receipt (`leadRequestReceipt`), answer as today (same digest → the existing
   turn; changed → `request-changed`). If it has a `lead_queue` row: same hash → that row (idempotent, never a second
   send, never resurrecting a removed one); changed → refused. A missing request id gets a server-minted one (the
   React composer, native form and continuity script already send one; the native form path is covered by test).
2. Else, if no personal turn of this approver is live and nothing of theirs is queued → behave exactly as today
   (immediate `runLeadTurn`); else insert `lead_message` (turn NULL) + `lead_queue` (`queued`) and answer
   `{ ok:true, queued:true, request, message }`.
The secret scan runs on the text at send (as today).

**(v3) Priority across entry points.** While an approver has queued personal rows, `openLeadTurn` (inside its existing
admission transaction) refuses any personal-turn admission for that approver **except the oldest queued row's own**
(`concurrent`). So follow passes, immediate sends (which queue instead) and channel turns (which already retry on
`concurrent`) all wait behind the backlog; the drainer is the only starter until the queue is empty. Atomic, because it
is the same transaction that already enforces one live personal turn.

**(v3) Waiting, and what wakes it.** Transient admission refusals keep the row `queued` with the words shown; each has
a named wake-up: `concurrent` (a live personal turn ends), `daily-cap` (local midnight), `over-budget` (weekly window
rolls or the ceiling is raised), `monthly-budget` (month rolls or the budget is raised — the team runtime's list omits
this one; the personal list includes it), `session-exhausted` (a new session is started — the row then becomes *Not
sent*, because it is bound to its original session), `latched` (the unknown cost is acknowledged). The personal
eligibility **stamp** covers everything `openLeadTurn` checks for this approver: live `mate_turn`/`chat_turn` ids and
states, today's admitted count, session/weekly/monthly spend, latch, and update-admission pause — so a competing
subscription turn finishing (no spend change) changes the stamp and the row is retried without another send. A 60 s
stamp expiry is the belt.

**Runner** — the team runtime's loop gains a second source (`PersonalQueue`, same method shapes as `TeamLeads`:
`claimNext`, `current`, `bindTurn`, `finish`, `defer`, `cancel`, `reconcileFinished`). For each claim it rebuilds the
principal **from the row**: approver active with the **same generation**, the row's **session** still active and
unended (never moved to a newer session), `ceiling_digest` unchanged, and the admitted project set recomputed through
the same runtime admission callback the console uses (`managedRepos`/`leadPrincipal` path), checked against the
row's task/project; the provider/config and update-admission pause are read at claim time. **(v3)** The project
resolver is explicitly **actor-scoped** (`admittedReposFor(account)`), never `managedRepos`/`visible`, which read the
request context (src/serve.ts:442, src/server/guards.ts:76) and are meaningless on a timer. `onAdmitted` re-checks the
claim's runner, generation and revision transactionally (as `current`/`bindTurn` do, src/team-leads.ts:305), not only
owner and thread. It then calls
`runLeadTurn({ …, requestId: row.request_id, queuedMessageId: row.message, onAdmitted, context, revalidate })` —
`onAdmitted` binds the row inside admission (the engine's guard on `queuedMessageId` is widened from "shared thread"
to "a queued row of this approver in this thread"). `revalidate` re-checks the row, session, generation, access and
update pause before every model step, as team turns do. Outcomes map exactly as in `team-runtime.ts` (answered;
admission refusals → `defer` with a stamp; post-admission exception → `uncertain`; else `failed` with words). Before a
claim, a saved engine receipt for the row's request wins (no second call).

**Recovery**: the loop runs on its own timer (not tied to lead-follow opt-in). `reconcileFinished` settles `running`
rows whose turn ended; a `running` row with no bound turn after the turn deadline is set `uncertain` (never re-queued
by elapsed time alone — the binding is the proof). Unknown-spend latches keep rows deferred.

**Progress fencing**: `beginLiveTurn`/`endLiveTurn` progress objects are keyed by **turn id**, not thread, so an old
turn's late completion (after Stop) can't end the next turn's display.

**Clients** (all named, all tested): React composer — no longer blocks on `pendingTurnId`; a `{queued}` answer clears
the draft for the next send and shows the queued row; the transport understands `queued`. Native form — redirects
back with the row visible. Legacy continuity script and `/chat` status polling — recognise queued/answered rows by
request id. Workspace snapshot — carries queue rows; `leadChatVersion` includes them.

**(v3) Retention / end / revoke**: `queued`, `running` and `uncertain` rows are **protected** from chat retention (as
`retentionPlan` already exempts active team queue rows, src/retention.ts:185) until they finish or expire (7 days).
Terminal rows: text and `context_json` deleted at removal/expiry/refusal; the tombstone (request id, payload hash,
status) lives as long as its session and is purged with the session/thread, so a removed request can't be recreated
during the session that sent it. Ending a session or revoking chat cancels its `queued` rows (*Not sent*), deleting
text by the existing forgetting rules. Versioned migration with upgrade-path coverage.

## Safety

No new authority: a queued message runs the same engine admission as a typed one, under the session it was sent in,
re-proved at claim and before every step. Caps, weekly/monthly budgets and the latch are the engine's own checks in
`openLeadTurn` (one admitted lead turn counts once in `chatTurnsToday`). At most one personal turn runs per approver.

## Tests

Store: send-path decision is atomic; idempotency (immediate→retry while running stays the same turn; queued→retry
same row; changed text/context refused; removed never resurrected); **(v3)** history excludes unadmitted rows on
every path (Codex's reproduction); backlog priority over follow/channel/immediate starters; every transient refusal
waits and wakes (incl. monthly-budget; a competing subscription turn ending); bounds and 7-day expiry; retention
protects pending rows and deletes terminal text; one running row per approver; claim/bind/finish;
deferral on each admission refusal and resume on change; uncertain after bound-turn crash; retention + end/revoke.
Runtime: session replaced → Not sent; generation/access/project-order change → Not sent; task no longer visible →
Not sent; follow disabled → queue still drains; Stop then next; cross-thread order (oldest first per approver).
Server/clients: React send during a turn → queued + draft cleared; native form; continuity polling; Remove/Edit
conflicts with a starting claim. Journeys (scripted, desktop + phone): send two messages while the lead answers →
both queued → two replies in order; Remove one; lost acknowledgement retry; long message.

## Out of scope

Live injection into a running turn; moving Telegram/Slack/Discord/Teams onto `lead_queue` (they keep their own
retries); the old non-lead `/chat` turn path.
