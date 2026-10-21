# Lead message queue — plan

Status: **v2** (2026-10-20) after Codex plan review r1 (NO-GO, 3 High / 4 Medium). For re-review.

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
  in the thread as yours with *Queued* and **Remove** (and **Edit** while still queued). The composer is free again.
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

**Send** (`chatSend`, personal branch) — in one store transaction:
1. If `(session, request)` has an engine receipt (`leadRequestReceipt`), answer as today (same digest → the existing
   turn; changed → `request-changed`). If it has a `lead_queue` row: same hash → that row (idempotent, never a second
   send, never resurrecting a removed one); changed → refused. A missing request id gets a server-minted one (the
   React composer, native form and continuity script already send one; the native form path is covered by test).
2. Else, if no personal turn of this approver is live and nothing of theirs is queued → behave exactly as today
   (immediate `runLeadTurn`); else insert `lead_message` (turn NULL) + `lead_queue` (`queued`) and answer
   `{ ok:true, queued:true, request, message }`.
The secret scan runs on the text at send (as today).

**Runner** — the team runtime's loop gains a second source (`PersonalQueue`, same method shapes as `TeamLeads`:
`claimNext`, `current`, `bindTurn`, `finish`, `defer`, `cancel`, `reconcileFinished`). For each claim it rebuilds the
principal **from the row**: approver active with the **same generation**, the row's **session** still active and
unended (never moved to a newer session), `ceiling_digest` unchanged, and the admitted project set recomputed through
the same runtime admission callback the console uses (`managedRepos`/`leadPrincipal` path), checked against the
row's task/project; the provider/config and update-admission pause are read at claim time. It then calls
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

**Retention / end / revoke**: the queued text lives in `lead_message`; chat retention deletes `lead_message` rows,
so `lead_queue` rows are deleted with them (explicit delete in the retention sweep, not only FK). Ending a session or
revoking chat cancels its `queued` rows (`cancelled`, error words) and follows the existing forgetting rules for
text. Terminal rows keep no text of their own.

## Safety

No new authority: a queued message runs the same engine admission as a typed one, under the session it was sent in,
re-proved at claim and before every step. Caps, weekly/monthly budgets and the latch are the engine's own checks in
`openLeadTurn` (one admitted lead turn counts once in `chatTurnsToday`). At most one personal turn runs per approver.

## Tests

Store: send-path decision is atomic; idempotency (immediate→retry while running stays the same turn; queued→retry
same row; changed text/context refused; removed never resurrected); one running row per approver; claim/bind/finish;
deferral on each admission refusal and resume on change; uncertain after bound-turn crash; retention + end/revoke.
Runtime: session replaced → Not sent; generation/access/project-order change → Not sent; task no longer visible →
Not sent; follow disabled → queue still drains; Stop then next; cross-thread order (oldest first per approver).
Server/clients: React send during a turn → queued + draft cleared; native form; continuity polling; Remove/Edit
conflicts with a starting claim. Journeys (scripted, desktop + phone): send two messages while the lead answers →
both queued → two replies in order; Remove one; lost acknowledgement retry; long message.

## Out of scope

Live injection into a running turn; moving Telegram/Slack/Discord/Teams onto `lead_queue` (they keep their own
retries); the old non-lead `/chat` turn path.
