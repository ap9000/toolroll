# Lead fan-out — plan

Status: v3, Codex GO at round 3 (2026-10-20). Ready to build after PR #205 (merged).

## What and why

Alex, on Empryo's demo (one lead tab triaged a bug report into 11 parallel repro tabs that each reported back into a
table): *"ideally this is lightweight and the main agent can manage the tasks efficiently."*

So: the lead turns one ask ("work through these 11 bug reports") into a **sweep** — N tasks under one shared brief,
started with **one** yes, run in parallel within the machine's limits, each reporting back a short verdict into **one
live table** in the conversation that started it. The lead manages the sweep with a handful of verbs and is woken
once per meaningful change, not once per task.

What it keeps that Empryo's demo doesn't: every child is an ordinary task, in its own worktree, with its sealed scope,
fences and proof. Nothing shares a working tree, and nothing new can run without approval.

## What already exists (and is reused unchanged)

- **Tasks** — worktree, sealed scope, brief, handoff file, proof, the board. A sweep's children are plain tasks.
- **Lead proposals and confirm doors** (`lead-doors.ts`) — a card the person confirms; the door re-proves and files.
- **Approval** — a signed operating mode approves ordinary work by itself; otherwise the person approves per task.
  Protected work keeps its two-person rule (`approval-policy.ts`) and a mode never decides it.
- **Capacity and the queue** (`claim.ts`) — how many builds run at once, per machine and per provider quota.
- **Assignments and follow** (`assignment*.ts`, `lead-follow.ts`) — the lead owns tasks it filed, records status
  events without a model, and is woken at `ready-to-check`, `needs-decision`, `complete`, `cancelled`.
- **Lead commitments** (`lead-commitments.ts`) — "I'll tell you when X", said once, on the channel it was promised on.

## What is new — three small pieces

### 1. A sweep record (additive table, no schema version bump — like `lead_commitment`)

`lead_sweep { id, thread, repo, title, brief, created_by, created_at, max_parallel }` and
`lead_sweep_task { sweep, root_task, ordinal, label }`. Membership is by **task family root**, so a revision of a child
is still that child. A task belongs to at most one sweep. No lifecycle of its own: a sweep is a grouping and a limit;
its children are plain tasks. The brief is the shared rules every child gets (in the demo: reproduce first, "not
reproducible" is a valid result, one guard per fix, report shape); each child adds only its own item.

### 2. One card, one yes: `kind: "sweep"`

The lead proposes the whole sweep as one card: title, shared brief, the items (title + item text), project, profile,
`max_parallel`. The card shows every child's complete scope (folded), frozen at proposal time.

**Filing** (one transaction): all N tasks are filed with the shared brief + their item, owned by the lead's assignment,
linked to the sweep, with the lead's provenance (`proposedVia: "mate"`) kept. One fails to file → the transaction rolls
back and none are filed.

**Approval** is the person's ceremony, never a mode: lead filings are mate-proposed, and mate-proposed scopes are never
mode-sealed (`store.ts` sealing rule) — a sweep doesn't change that. One password, then **the ordinary approval
primitive is called once per child**, each sealing that child's own scope digest with every existing check
(`scope.ts` approve path). The ceremony's review nonce is bound to the proposal id, the repo, and the ordered list of
(child id, child scope digest) it was rendered with: any change → the nonce is stale → nothing is approved.

A child the ordinary approval refuses — a protected path needing a second person, "not the requester" (the confirmer
is the requester here), anything else — **stays filed and unapproved**, listed on the card and in the table as "waits
for its own approval" (another approver can approve it from the table as any task). The rest start.

No new authority: the ceremony is N ordinary approvals of exactly the N scopes shown.

### 3. The limit, the table, and the lead's wake

**max_parallel** is enforced in `claim.ts` `acquireLocked`, inside its existing write transaction, immediately before
the claim is inserted: count this sweep's **live claims** (latest unreleased leases, across all runners) by family
root; at the limit, the child isn't claimed now. Claimed-but-not-started counts. Default 3, never above the machine's
own capacity. Everything else (quota, budget, backoff) is the queue's own rule.

**Verdict.** The shared brief asks each child to end its handoff with
`verdict: fixed | not-reproducible | blocked | done` + one line. It rides the existing handoff (`conclusion` gains an
optional `verdict`, read strictly; anything else is "no verdict", never guessed).

**The table** is rendered from facts, not a model: each row is the child's `assignmentBrief` (the same state words the
board uses) + its verdict + a link to its result; the footer counts states and cost. It lives in the sweep's own
conversation and updates over the existing live rooms. No second lifecycle, no new transport.

**The lead's wake.** Follow already records status events without a model and hands the lead replay-safe pages of
those raw events, each matching its own task-status ledger row, with receipts and acknowledgements
(`assignment-delivery.ts`). **None of that changes**: pages stay made of the original, unmodified events — no
synthesized aggregate event, no new receipt contract. Sweeps change only two things around it:
- **When a page is issued.** If every pending event belongs to sweep children and that sweep has had a status event
  within the settle window (2 min) without all of its children settling, the follow pass waits (bounded: at most one
  window per page) so a burst lands on one page. Any non-sweep event, or a sweep fully settled, issues at once.
- **How the wake reads.** The wake consumer groups a page's events by sweep when it writes the lead's message: one
  line per sweep ("Bug sweep: 3 more ready — 2 fixed, 1 not reproducible; 8 of 11 settled" + a link to the table)
  built from the same events it already reads (`event.assignment`), not one line per child.
The wake goes where follow already sends it (the enabled follow grant's thread). **Follow off → no wake**: the table
still updates live, and the lead reads status when asked.

**Verbs** — only what a sweep adds:
- `sweep status` — the table as facts.
- `sweep cancel-rest` — cancel every child not yet ready (one confirm).
Steer, cancel, or retry *one* child are the existing per-task actions, offered on each row. Adding items is a new
sweep card (a new yes).

## Not in this slice

Children spawning their own sweeps (one level only), a cross-project sweep, adding items to a running sweep, a sweep
lifecycle (close/reopen), auto-merging fixed children (results stay results; the person or an existing merge grant
decides), mode-approved sweeps, a dedicated sweep page beyond the table, and a per-sweep cost cap beyond the existing
budget rules.

## Steps

1. Store: the two additive tables (membership by family root) and the `max_parallel` count inside `acquireLocked`.
   Tests: two runners racing for the last slot claim exactly one; a revision of a child counts against the sweep;
   claimed-not-started counts.
2. The `sweep` proposal + confirm door: frozen scopes; all-or-nothing filing; the ceremony calls ordinary approval per
   child; nonce bound to proposal/repo/(child, digest) list. Tests: a changed child makes the nonce stale and approves
   none; "not the requester" and a protected child stay filed and unapproved while the rest start; a filing failure
   files none; a mode never approves a sweep child.
3. Verdict (strict parse), the table from `assignmentBrief`, the bounded issue delay for sweep-only pages, and grouped
   wake text. Tests: a burst lands on one page of raw events whose receipts validate and ACK unchanged; a non-sweep
   event issues at once; the delay never exceeds one window; follow off → no wake, table still live.
4. `sweep status` and `sweep cancel-rest` on the lead's tool list and the table; a short "when to sweep" in the lead's
   instructions (several independent items under one rule set; not one task, not dependent steps).
5. One end-to-end: a 4-item sweep, parallel 2, two fixed, one not reproducible, one cancel-rest; the table and the
   lead's two wakes match.

## Review — round 1 (Codex, NO-GO, 5 findings), and what changed

1. **Mode approval would change authority** (lead filings are mate-proposed and never mode-sealed) → removed: every
   sweep is the person's ceremony.
2. **One ceremony needs an exact contract** → frozen scopes, ordinary approval per child with its own digest and
   checks, nonce bound to proposal/repo/(child, digest), refused children stay filed and unapproved, explicit rollback.
3. **Count claims, not building siblings** → live leases across runners inside `acquireLocked`, by family root.
4. **Follow batching** → coalesce before pages are issued; receipts/ACKs unchanged; the follow grant's thread; follow
   off defined.
5. **Too much vocabulary** → only `status` and `cancel-rest`; per-child actions are the existing ones; no add/close;
   the table is `assignmentBrief` rows.

## Review — round 2 (Codex, 4 CLOSED, 1 OPEN)

4. **A synthesized sweep event can't use the receipt contract** (pages must match ledger rows; ACK re-validates) →
   no synthesized event at all: pages stay raw events, unchanged; a sweep only delays issuing (bounded) and groups the
   wake text from the same events.

## Round 3 (Codex, narrow): **GO**

Item 4 CLOSED; no new High. Implementation notes to keep: an already-issued page replays at once (the delay applies
only before issue); the delay's deadline is saved with the first held event so it never resets across passes or a
restart; the pass never sleeps — it defers issuing to its next scheduled run (serve.ts follow scheduling), so shutdown
is not extended.
