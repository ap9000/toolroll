# Lead message queue — plan

Status: v1 draft (2026-10-20), for Codex review.

## What and why

Alex, after Ramp's Laminar post (2026-10-20), chose this first. Laminar keeps an agent session "always open to new
input": a message sent while a turn runs is queued and steers the next turn, never refused.

Today the console refuses it. `chatSend` (src/server/chat.ts) starts `runLeadTurn` detached; when a turn is already
live, `store.openLeadTurn` returns `concurrent` and the page says *"The lead is still answering your last message.
Wait for that reply, then send this one."* (src/lead.ts). The message is not kept anywhere but the browser draft.
Telegram already re-queues its own copy (`requeue("busy")`, src/telegram-lead.ts), and Slack/Discord/Teams defer the
event 5 s and retry (src/chat-delivery.ts). The console is the odd one out, and it is where most messages are sent.

## Behaviour

- Sending while the lead answers **queues** the message: it appears in the thread at once as the person's message,
  marked *Queued — sends when the lead finishes*, with **Remove** beside it. The composer stays usable.
- When the live turn ends (answered, failed, stopped, or timed out), the queued messages of that person **in that
  thread** go to the lead as **one** next turn, in the order they were sent, joined as the person wrote them. One turn,
  not one per message: the lead sees everything that arrived while it worked, the way a teammate reads a backlog.
- **Stop** keeps working as today; stopping a turn sends the queue next (the person's newer words are the point).
  *Stop and clear* is out of scope; Remove on each queued message covers it.
- A queued message that can't be sent (the session ended, the person's standing changed, a cap or budget refuses the
  next turn) stays in the thread as *Not sent* with the refusal's words, never silently dropped.
- Mid-turn injection (feeding the words into the live model turn) is **not** in v1: only Claude's stream-json input
  supports it, the lead's subscription runner is per-round `claude -p`, and the direct API has no such channel. v1
  delivers at the turn boundary on every provider. (A later step can steer live where the runner supports it.)

## Design

**Table** `lead_queued_message` (additive migration): `id`, `thread` → lead thread, `approver`, `session` (the
lead session it was sent under), `text` (≤ `LEAD_MESSAGE_MAX_CHARS`), `request` (the composer's request id; UNIQUE
with session — a resend of the same request is the same row), `context_json` (the send's own context: focus task,
`result` run, composer `mode`, project — exactly what `chatSend` builds today, validated at send time and
**re-validated at drain**), `state` `queued | sent | removed | refused`, `outcome` (refusal words), `created_at`,
`settled_at`, `turn` (the turn that carried it).

**Send** (`chatSend`, lead branch): before starting a turn, `store.queueOrOpenLeadTurn(...)` decides in **one
transaction**: if this approver has a live lead turn, insert the queued row and return `queued`; otherwise behave as
today. Deciding and inserting together closes the race where the live turn ends between the check and the insert
(that message would then wait for a turn that never comes). The JSON answer gains `{ queued: true, id }`; the native
form redirects back with the thread showing the queued row.

**Drain** — one function, `drainLeadQueue(store, approver, thread, now)`, called:
1. at the end of every console lead turn (where `endLiveTurn` runs today), and
2. by the existing lead follow tick for threads whose approver has queued rows and no live turn (restart recovery: a
   server restart mid-turn leaves rows queued; the tick sends them once the turn is recovered as ended).

It claims every `queued` row of that approver+thread in one transaction (state → `sent`, `turn` set after the turn
opens; a crash between claim and open leaves them `sent` with no turn — the tick resets `sent`-without-turn rows older
than the turn deadline back to `queued`). It re-proves the principal (`leadPrincipal`-equivalent from the store:
approver active, same generation, session active) and re-validates each row's context (task still visible, result run
still in that family, mode valid) — a row whose context no longer holds is `refused` with words, the rest still go.
Then it calls `runLeadTurn` with the joined message and the **union** of context lines (each message keeps its own
"viewing result #N" line in order). Refusals from `runLeadTurn` (`daily-cap`, `over-budget`, …) mark the claimed rows
`refused` with `LEAD_REFUSAL_WORDS`.

**Remove**: `POST /chat/queued/:id/remove` (cookie, own row, `queued` only, CSRF) → `removed`. A row already claimed
answers *"Already sent."*

**Thread rendering**: queued/refused rows render as the person's message with the state line; `sent` rows are the
ordinary operator messages the turn appends (the turn appends one operator message per queued row, so the thread reads
exactly as the person typed it, not as the joined text). `leadChatVersion` includes the queue rows so live refresh
shows them.

**Other channels**: unchanged in v1 (Telegram and chat-delivery keep their own retry). The table is console-only; a
follow-up can move them onto it.

## Safety

- No new authority: a queued message is a lead turn like any other, sent later under the same session; the session's
  ceremony already covered lead turns (no password per message today). Drain re-proves standing and session.
- Spend: each drained turn reserves and is capped exactly like a typed one; a queue never bypasses `dailyTurns`,
  weekly ceiling or monthly budget, and never starts more than one turn per approver at once (the drain is the only
  starter while a row is queued; `openLeadTurn`'s `concurrent` guard still holds).
- Secret scan: the text is scanned at send (as today) and the joined message is scanned again at drain.
- Retention: queue rows follow the chat retention class and are purged with their thread.

## Tests

- Store: queue-or-open is atomic (live turn → queued; none → opens); request id idempotent; claim is single-use;
  `sent`-without-turn recovery; remove only while queued.
- Server: send during a live (scripted) turn → 202 `{queued}` and the row renders; turn end drains one joined turn
  whose thread shows each message; Stop then drains; a refused drain marks rows *Not sent* with words; Remove before
  drain; standing revoked between send and drain → refused, nothing sent; restart recovery via the tick.
- Browser journey (app-e2e, scripted): send two messages while the lead is answering, see both queued, see one reply
  that addresses both.

## Out of scope

Live injection into a running turn; moving Telegram/Slack/Discord/Teams onto the table; queueing for the old
non-lead `/chat` turn path (it already says *one turn at a time*).
