# The mate — spec v2 (2026-09-02, after Codex round 1: fifteen findings)

One conversation, in the console and in the CLI, with an agent that can see
every project the operator may see and manage the fleet **by proposal**:
it files, prioritizes, reserves, holds, suggests answers, and reports; the
operator confirms with a tap, or a password where the digest demands it.
The plane never acts on the model's word. This is firstmate's "talk to one
agent, ship with a crew" on our authority model (docs/firstmate-assessment.md
§4).

## Round-1 rulings (folded below; the findings are the design)

1. **No model-driven write, ever.** `propose_task` no longer files; every
   propose-* tool writes a `mate_proposal` row and nothing else. Filing
   happens when the operator confirms — as the operator's own filing
   through `fileTaskProposal` (`filed_via: mate`), exactly like quick
   capture. The proposal row is the idempotency; `idempotency_key` is gone.
2. **A mate-written scope never auto-seals.** `task_scope` gains
   `proposed_via` (set-once per write, `mate` when a confirmed
   `propose_scope` wrote it); `sealScopeApproval(..., {kind: "mode"})`
   refuses `proposed_via = 'mate'` in the primitive — the same wall the
   coordinator quarantine uses. Only the password ceremony approves it.
3. **A branded principal.** `VerifiedApprover` (module-private maker in
   `src/principal.ts`, minted only by `authenticateApprover` or by the
   session layer after csrf + role + generation re-proof) is the only
   principal the mate's tools and confirmers accept; the shared tool module
   takes `VerifiedCoordinator | VerifiedApprover`, never a structural
   object. Confirmers run through `src/mate-doors.ts`, a service layer that
   re-authenticates transactionally and calls the store primitives with the
   same validations the HTTP handlers apply (ceiling, csrf at the edge,
   revision CAS, claimed/contest rechecks).
4. **Shared queries, distinct views.** The coordinator's DTOs keep their
   paths (its allowlist is its authority). The mate's tool results pass
   through `mateView()`: repos as opaque `rN` (v13's mapping), `touches`
   dropped, digests dropped, approver identities dropped, chain words
   dropped, consequences and recommendations dropped. A canary test greps
   every serialized tool result for a path, a digest, or a name.
5. **Durable accounting.** `mate_turn` (approver, session, thread, state
   `queued|running|answered|failed`, generation, reserved, settled, steps
   summary) with one `chat_turn` row per provider request as its steps
   (`kind = 'mate-step'`, `mate_turn` FK): the existing dispatch CAS,
   terminal CAS, and crash latch apply per request; the turn's reservation
   commits against the session AND the weekly ledger in one transaction
   before the first dispatch; one live mate_turn per approver serializes
   the console and the CLI; a crash mid-loop settles the steps that
   finished and latches the one in flight.
6. **A true worst case.** With S = `MATE_MAX_STEPS` (8), M =
   `MATE_MAX_CALLS_PER_STEP` (4), R = per-result cap (16 KiB), C = per-call
   cap (2 KiB), B = base prompt bytes, O = `MAX_OUTPUT_TOKENS`: reserve
   `Σ_{s=1..S} tokens(B + (s−1)·M·(R + C) + s·O) × price_in + S × O ×
   price_out`. `worstCaseForPrice` gains this triangular form; the loop
   refuses a response carrying more than M calls as `malformed-reply`.
7. **Atomic confirmation.** One transaction: re-prove the approver (brand,
   not revoked, generation equal); the proposal belongs to this approver's
   thread; its turn is `answered`; the session's ceiling digest equals the
   surface's; `pending → confirming` CAS; the door primitive; the outcome;
   `confirming → confirmed|refused`. A proposal is inert (`drafting`) until
   its turn finalizes. Concurrent confirms: one wins the CAS, the other
   sees the typed outcome.
8. **Every proposal carries its CAS material.** `propose_scope` carries
   `sawDigest`; `propose_next` and `propose_reserve` carry `queueRevision`
   and the position the mate saw; `propose_hold` carries nothing (a second
   operator hold is a no-op by primitive); `propose_unhold` carries the
   hold id; the doors refuse on mismatch with the typed reason.
9. **Ceiling-bound.** `mate_session`, `mate_thread`, and `mate_proposal`
   store the admitted-repo ceiling digest; a surface whose digest differs
   cannot continue the thread or confirm its proposals (it starts a new
   thread and says why).
10. **Delegated spend, done the mode way.** `mate_session` stores the
    approver generation and a terms digest (ceiling $, ceiling digest);
    the session stays live until explicitly ended, while every turn and
    confirm re-authenticates against the current
    approver row; `revokeApprover` closes the approver's mate sessions in
    its transaction; a running CLI REPL learns on its next turn and exits.
11. **Transcripts, ruled explicitly** (rule change #2): the thread stores
    operator text and assistant text only — never tool results, never
    provider payloads — until explicit closure; only the bounded recent
    window is sent back to the model. Secrets are scanned out before
    storage; `--end` and revocation delete the thread. The first
    durable model text now precedes a filing; the password that minted the
    session is what backs it.
12. **The ceremonies as they are.** Irreversible answers take the existing
    `confirm=yes` second field; cancel is the existing arm-then-POST. The
    spec claims no password ceremony for either; propose_cancel renders the
    arm control, never a one-tap.
13. **No suggested answers in v1.** `propose_answer` is deferred: the mate
    sees no consequences or recommendations by rule, so it cannot choose
    safely, and the v13 prompt's no-recommendation rule stands. The mate
    points at open decisions (recap, `list_decisions`) and the operator
    answers on the decision page.
14. **Usage is integers.** The wrapper parser accepts token counts only as
    non-negative safe integers ≤ 10⁹; anything else is `malformed-reply`.
15. **Real-HTTP contracts** for every confirm door: ownership, csrf, role,
    ceiling re-proof, double-submit, ceremony redirects.

## Round-2 rulings (slice-1 review, 2026-09-02: fourteen findings, all closed)

Codex read commit 749d328 against this spec and found 3 critical, 8 high,
3 medium. Each is now a rule, folded into the sections below and into
`src/mate.test.ts`:

1. **Unknown cost charges the whole reservation.** A step that times
   out, drops, or answers malformed leaves the turn's cost unprovable;
   `finalizeMateTurn` and the crash sweep then charge the turn's FULL
   reservation to the session and the week. Acknowledging the latched
   step re-enables the credential and refunds nothing. (finding 1)
2. **Admission binds everything.** `openMateTurn` re-reads the session
   and the thread and refuses unless both are this approver's, the thread
   is open, the session's credential is the one derived from the key in
   hand, and both sit under one ceiling. The engine takes the chat config
   and the key; the credential identity and the price are DERIVED, never
   supplied. (finding 2)
3. **The brand is runtime.** A principal is frozen at mint and remembered
   in a module-private set; `isVerifiedApprover` and `reproveApprover`
   refuse structural copies, mutated repos, and a ceiling digest that no
   longer matches the repos. `verifyApproverStanding` takes the generation
   the session holds. (finding 3)
4. **Proposal text is scanned before it is drafted**, and a failed turn's
   drafts are DELETED, not expired; `--end` and revocation delete the
   thread's proposals with its messages. (finding 4) One exception: a
   turn stopped at its deadline (or swept past it) keeps the proposals
   its completed, validated tool calls drafted. They go pending in the
   same write that saves "The reply took too long" in the thread, so a
   slow final reply never hides a proposal already made. Revocation,
   stop, secret refusal, supersession and unreadable provider output
   still delete every draft.
5. **Revocation ends a loop in flight.** `revokeAccount` fails the
   approver's live turns first (charged whole, generation moved), then
   ends sessions and threads; the engine re-reads its own row and
   re-proves standing after every network wait, before any tool runs.
   (finding 5)
6. **`proposed_via` flows.** `ScopeInput`, `proposeGuarded`,
   `createConsoleTask`, and `fileTaskProposal` carry `proposedVia:
   "mate"`; `saveScope` writes the scope and the mark in one transaction.
   (finding 6)
7. **The reservation is an upper bound.** Calls are bounded whole (id ≤
   64 bytes, the serialized call ≤ 2 KiB), results are measured as
   embedded, one step's text is ≤ 8 KiB, and the triangular formula
   budgets every call and result at TWICE its cap for the one further
   JSON escaping the wire can add. (finding 7)
8. **Usage is typed integers, output within the allowance, input within
   the bytes sent**; a present cost is a finite non-negative number;
   anything else is malformed with unknown cost. (finding 8)
9. **`mateView` is a choke point over every string**: exact repo paths and
   their basenames, path-shaped text, hex digests of 32+ digits, and
   account names are replaced in titles, questions, labels, reasons, and
   the data document alike. (finding 9)
   Display-label update (2026-09-16): `list_repos` also provides the bounded
   name of each admitted project so phone users do not have to interpret
   `r1` codes. This is a deliberate metadata-only exception: unsafe,
   credential-shaped, account-identifying or overlong names use `Project N`.
   Paths and basenames in arbitrary tool text remain scrubbed.
10. **CAS material is complete**: `propose_next` and `propose_reserve` read
    revision and position in one transaction and carry both; `propose_hold`
    carries the operator's existing hold id (`sawHold`) so a stale card
    never overwrites a hand-placed hold. (finding 10)
11. **The latch is re-checked before every step**; mate turns count once
    in the daily cap; fleet chat and the mate are one live turn per
    approver, both ways. (finding 11)
12. **Terminal persistence is one write**: settle, debit, promote, append
    the assistant text; promotion requires an answered turn. (finding 12)
13. **The read tools keep their contracts**: `recap` takes `since` and
    reports approvals awaiting, finished, and failed; `list_decisions`
    carries task, option ids, reversibility, and age; `get_task` counts
    the task's own decisions; `queue` places tasks within their column.
    (finding 13)
14. **The tests cover the dangerous cases** named above, including the
    OpenRouter loop and a revocation during the model's answer. (finding 14)

## Round-3 rulings (slices 2–4 review, 2026-09-02: twelve findings, all closed)

1. **A card dies with its conversation.** `confirmMateProposal` requires a
   LIVE mate session minted by the principal's generation under the card's
   ceiling; an explicitly ended session's cards refuse `session-ended`
   although the cookie still stands. A credential rotation runs the same cascade as a
   revocation (`revokeDerivedAuthority`): live turns fail charged whole,
   sessions end, threads and proposals are deleted. (finding 1)
2. **Standing is re-proved INSIDE the confirm transaction.** (finding 2)
3. **The ceiling digest is ordered.** `rN` is an index; the same repos in
   another order are another ceiling. (finding 3)
4. **REPL ordinals are assigned once per run and never reused**; an acted
   card answers in words by its number. (finding 4)
5. **The CLI's default ceiling is the enrolled registry** (`repos.json`
   beside the database), never the opened-project history; an unreadable
   registry refuses. (finding 5)
6. **The place is part of the CAS**: `next` and `reserve` confirm only when
   the task's position and column are those the mate saw, in addition to
   the revision. (finding 6)
7. **Minting fences the previous session's in-flight turn** (charged
   whole); a ceiling change is stated on GET and acted on only by the
   POST that mints a new session. (finding 7)
8. **`since` is defined**: decisions, incidents, and attempts newer than
   it, inclusive to the hour; queued work and scopes awaiting approval are
   standing and always count. (finding 8)
9. **A live session under another provider key refuses `key-mismatch`**
   in words. (finding 9)
10. **The password belongs at the hidden prompt**; `--token` is documented
    for scripts only. (finding 10)
11. **The console's last-said note is keyed by browser session, bound to
    the turn's session, read once, bounded.** (finding 11)
12. **Coordinators never see the installation-wide queue revision.**
    (finding 12)

## Round-4 rulings (v3 review, 2026-09-02: ten findings, all closed)

1. **The executor is private and re-proves the brand itself**; `via` is
   named by every caller, never defaulted. (finding 1)
2. **The hourly window is shared in both directions**: filing counts
   proposals, proposals count filings. (finding 2)
3. **Seven days is enforced at the door**, sweep or no sweep; the task
   page and the confirm route sweep as well. (finding 3)
4. **A terminal shows the answer's context before any confirm**: the
   question, every option with its consequence, the builder's
   recommendation, the proposed pick — in the REPL's list and in
   `proposals list`/`confirm`. (finding 4)
5. **The same choice landing first elsewhere is `already-answered`**, not
   this card's success. (finding 5)
6. **Reading is proved**: `propose_answer` needs `get_decision` on the
   same decision in an EARLIER step (the mate) or earlier on the same
   connection (the gateway); the card says "read every consequence" only
   when the row records it. (finding 6)
7. **"Open" is derived**: a decision past its deadline is expired for the
   proposal contract whether or not the sweep ran; the door refuses it as
   stale. (finding 7)
8. **The gateway's argument parser understands unions and arrays**, so
   `worker: 7` or a malformed `touches` is `-32602`. (finding 8)
9. **The v33 rebuild is an exact recognizer** (`rebuildMateProposalForV33`):
   v32 or v33 byte-for-byte, anything else refuses; tested against a
   populated v32 table and an unknown shape. (finding 9)
10. **`safeReturn` refuses backslashes.** (finding 10)

## 0. Hard boundaries

- **No new authority.** Every proposal executes through an existing door:
  `fileTaskProposal` (quarantined, scope unapproved), `POST /t/:id/next`,
  `/queue/move`, `/t/:id/hold|unhold`, `POST /d/:id/answer`, and the
  password ceremonies for scope approval, irreversible answers, and cancel.
  The mate has no tool that mutates state; it has tools that *propose*.
- **Fleet chat v13's transport stays.** Direct provider call over fetch, no
  CLI spawn, no filesystem, capped bodies, the strict wrapper parser, worst-
  case reservation against the weekly ceiling, the latch on unknown spend.
  The mate adds a bounded tool loop *inside* that contract (§3).
- **The v13 snapshot rules stay**: explicit repo list = the ceiling's
  admitted repos; admission inside every query before its LIMIT; repo paths
  never leave the process (opaque `r1..rN`); decision recaps, consequences,
  and recommendations excluded from anything sent to a provider; secrets
  scanned out of every outbound body.
- **One thread per approver**, project-agnostic, shared by the console and
  the CLI — that is what "unified" means. Threads are metadata plus text
  the approver typed and the model returned; tool results are stored as the
  typed JSON the plane produced, never as provider payloads.
- **Copy**: the mate "suggests", "proposes", "asks"; it never "did".

## 1. Principals

The mate runs **as the approver**, under the approver's session (console)
or credential (CLI) — not under a coordinator credential. Its reads are the
approver's reads (the ceiling), its proposals are the approver's proposals
in waiting. `filed_via` for anything it files is `mate` (display provenance,
inside the existing grammar); nothing carries `coordinator_cid`.

**The mate session:** chat used to take the password with every message. A
conversation cannot. A mate session is a password ceremony once — restating
the admitted projects and, for direct API use, "this conversation may spend
up to $X" — that mints a signed row (`mate_session`: approver,
credential_key, ceiling_microusd, spent_microusd, ended_at). Every turn
debits it transactionally. The conversation remains live until the operator
ends it, their standing is revoked, the provider credential changes, or the
admitted project ceiling changes. The weekly chat ceiling still binds above it.

## 2. The tools (shared with MCP)

`src/coordinator-tools.ts` becomes the one module both `src/mcp.ts` and the
mate call: the existing `statusFor`, `listTasksFor`, `taskDetailFor`,
`list_repos`, `fileCoordinatorProposal` move there unchanged in behavior,
parameterized by a **principal** (`{ kind: "coordinator", cid, repos }` or
`{ kind: "approver", name, repos }`). New tools, all read or propose:

| tool | reads / proposes | executes through |
|---|---|---|
| `recap` | since-stamp: what waits (decisions, approvals, requeues), what runs, what finished; counts and ids, no recaps/consequences | read |
| `list_decisions` | open decisions: id, task, question, option ids and labels (no consequences), reversible flags, age | read |
| `queue` | a repo's columns and order (ids, titles, reservations) | read |
| `propose_task` | `{repo, title, goal, not, touches, acceptance, planning:auto|required|skip}` → row | confirm → the operator's own `fileTaskProposal` (`filed_via: mate`); unapproved; broad/risky work may start the existing planner before approval |
| `propose_next` | `{task, queueRevision, position}` → row | confirm → `moveTaskNext` with the revision CAS |
| `propose_reserve` | `{task, worker|null, queueRevision}` → row | confirm → `moveTask` with the revision CAS |
| `propose_hold` / `propose_unhold` | `{task, reason}` / `{task, holdId}` → row | confirm → the hold primitives |
| `propose_scope` | `{task, goal, not, touches, sawDigest}` → row | confirm → `proposeGuarded` with `proposed_via: mate`; mode coverage refuses it; the password ceremony approves it |
| `propose_cancel` | `{task, reason}` → row | renders the existing arm-then-POST control on the card; never a one-tap |
| `propose_answer` | — | deferred (ruling 13) |

`mate_proposal`: id, thread, turn, kind, payload_json (exact-key DTO, no
spread, CAS material included), ceiling_digest, state
(`drafting|pending|confirming|confirmed|refused|dismissed|expired`),
created_at, resolved_at, resolved_by, outcome_json. `drafting` until the
turn finalizes; it lives with the thread until acted on or explicitly closed. Confirmation is one
transaction (ruling 7); a stale proposal is the door's typed refusal,
rendered in place. At most 5 proposals per turn.

The MCP gateway gains the same read tools (`recap`, `list_decisions`,
`queue`) for coordinators; the propose-* tools stay approver-only in v1
(coordinators file; steering by a foreign credential is a later ruling).

**As landed (slice 4, 2026-09-02).** The shared queries live in
`src/mate-tools.ts` as `recapOver`, `decisionsOver`, and `queueOver`,
naming repos by index; `labelRepos` gives each view its label — `rN`
through `mateView` for the mate, the path for a coordinator in
`src/mcp.ts`, whose `recap`, `list_decisions`, and `queue` tools are the
same functions behind the coordinator's allowlist. The coordinator's older
`status`/`list_tasks`/`get_task` DTOs are unchanged. Neither view ever reads
a consequence or a recommendation.

## 3. The turn

`runMateTurn(thread, message)`:

1. Reserve the triangular worst case (ruling 6) for the whole turn in one
   transaction against the mate session and the weekly ledger, opening the
   `mate_turn`; `TURN_WALL_CLOCK_MS` bounds the whole loop. Refuse before
   any dispatch when either ceiling cannot cover it.
2. Compose: system contract (§4), the thread's last N messages (capped by
   bytes), the data document (v13's `buildDataDocument`), the user message,
   and the tool schemas. Provider: Anthropic Messages `tools` /
   `tool_use`; OpenRouter's OpenAI-compatible `tools` / `tool_calls`. The
   wrapper parser gains a **tool-call branch** under the same caps and
   duplicate-key lexer; a call to an unknown tool, a malformed argument
   object, or a result over the cap ends the turn as `malformed-reply`.
3. Loop: each provider request is its own `chat_turn` step row (dispatch
   CAS, terminal CAS, crash latch); execute at most M tool calls per step
   in-process under the branded principal, pass results through
   `mateView()`, append, call again; stop on a text-only reply or at S
   steps (then the reply is the last text plus "stopped after 8 steps").
4. Settle: tokens in/out summed across steps; `settled = max(pinned,
   reported)`; debit the mate session and the weekly ledger; latch on
   unknown spend exactly as v13.
5. Persist: `mate_message` rows for the operator text and the assistant
   text only (ruling 11); tool activity is summarized in the assistant row
   as counts ("read 2 projects · 5 tasks"), never stored as results;
   `mate_proposal` rows move `drafting → pending` here. The console and the
   CLI render from these rows — one source.

## 4. The contract the model reads

Plain words, versioned, in `src/mate-contract.ts`: what the plane is, the
five statuses, that every act is a proposal the operator confirms, the
honesty rules (measured/unmeasured, never a percent), the copy rules
(suggest/propose/ask), when to ask instead of propose (any irreversible
choice, any cancel, anything outside the admitted repos), and the shape of
a good recap (what waits first, then what runs, then what finished, counts
before names). The model never sees paths, decision consequences, or
recommendations — the data document already hides them.

**Contract v6 (2026-09-10): conversational intake.** One plain-language
outcome is sufficient to propose work. The mate infers routine form fields
and asks only when a project/outcome is ambiguous or a consequential tradeoff
can materially change the result. It groups at most three questions with safe
defaults, honors “use your judgment” for reversible choices, and marks whether
repository planning is required, automatic, or explicitly skipped. The
confirmation door validates that choice again and starts the same planner used
by every other filing surface; chat gains no private intake state.

## 5. The console

**As landed (slice 2, 2026-09-02).** `/chat` is the thread while a mate
session is live and fleet chat v13 otherwise, with the mint card on top:
`POST /chat/mate/mint` (ceiling dollars, hours, the password once) mints
the session and opens the thread; `POST /chat` with a live session runs a
mate turn without a password; `POST /chat/proposal/:id/confirm|dismiss`
run `src/mate-doors.ts` under the session-layer principal; `POST
/chat/mate/end` fails any live turn, ends the session, and deletes the
thread's text and proposals. The turn runs detached and the page refreshes
every 3 s while it runs, with proposal cards inert until it ends; a refusal
or a failed turn is said once at the top of the thread; a turn stopped at
its deadline says so in the thread itself, above any proposal it kept. Cancel cards carry
no confirm — they link to the task's own arm-then-POST control.

`/chat` becomes the thread: messages in order; tool activity as quiet mono
lines ("looked at 2 projects · 5 tasks"); proposals as cards inside the
assistant's message, each a form with one button (`confirm`) posting to
`POST /chat/proposal/:id/confirm` with csrf — the handler executes the
door and renders the door's answer on the card (`filed t-42`, `moved to
the front`, or the typed refusal); irreversible answers and cancel link to
their ceremonies. `dismiss` is a second small form. The composer is one
field; the page keeps the v13 problems, the latch acknowledgement, the key
facts, and the spend line ("this conversation: $0.42 of $5 · this week $3.10 of
$20"). The thread polls its own fragment while a turn runs (regionScript,
form-free fragment: proposals render inert until the turn ends).

## 6. The CLI

**As landed (slice 3, 2026-09-02).** `toolroll chat --as <you>
--token <t> [--repo <path>…] [--say "…"] [--end] [--ceiling-usd <n>]
[--json]` in `src/mate-cli.ts`, dispatched from `src/operate.ts`. The password
mints a persistent session (the direct-API spend ceiling defaults to $5 and
the terms are printed); the project ceiling is the `--repo` list, or the enrolled
projects when none are named; a live session under other projects is
ended and re-minted, and says so. The REPL reads lines: text is a turn;
`proposals`, `confirm N`, `dismiss N`, `open N` act on the pending cards
numbered in thread order (re-numbered after every act); `end` forgets the
thread; `quit` leaves the session live. Confirming runs
`src/mate-doors.ts` under the password-minted principal; scope and cancel
cards print their CLI ceremony. `--json` emits one envelope per turn or
act. Tests: `src/mate-cli.test.ts` through `runOperate` with injected
fetch, key environment, and stdin lines.

`toolroll chat [--as <you> --token <t>] [--end]`: a REPL over the
same thread. First run mints the mate session (the same restated terms,
the password typed once); turns print the assistant's text, tool activity
dimmed, and proposals numbered — `confirm 2`, `dismiss 2`, `open 2` (prints
the task). Confirming executes the same doors with the approver credential;
password-class proposals print the CLI ceremony command instead. `--json`
emits one envelope per turn for scripts. Non-interactive: `standing-orders
chat --say "…"` runs one turn and exits with the proposals listed.

## 7. Sequencing

1. `src/principal.ts` (the brand) + `src/mate-tools.ts` (shared queries,
   `mateView`, the read tools, `propose_task` as a row) + schema
   (`mate_session`, `mate_thread`, `mate_message`, `mate_proposal`,
   `mate_turn`, `chat_turn.kind/mate_turn`, `task_scope.proposed_via`) +
   the triangular reservation + `runMateTurn` with per-step ledgering +
   tests (fake provider: loop, caps, latch per step, crash mid-loop,
   canary on views, ceiling digest). **Codex review.**
2. The remaining propose-* tools + the confirm doors + the console thread
   page. Tests per door (a stale proposal is the typed refusal).
3. The CLI REPL, driving the same engine and doors under a
   `VerifiedApprover` minted by password; its tests use the fake provider,
   and every confirm door also has a real-HTTP contract (ruling 15).
4. MCP gains the read tools. **Codex review**, then the ledger entry.

## 8. Deferred

Project-level standing notes, voice. (Scout tasks and Telegram digests
landed in v4, §10; proposals over the gateway in v3, §9.)

## 9. v3 (2026-09-02): suggested answers, and proposals over the gateway

Both were deferred in v1; the operator asked for them. Two rule changes,
stated:

**Rule change #3 — the mate may read a decision's consequences.** v13
excluded recaps, consequences, and recommendations from anything sent to
a provider. A suggested answer that has not read the consequences is a
guess, so `get_decision` returns the question and each option's id,
label, reversibility, and consequence — through `mateView`, so a path or
a name typed into a consequence is scrubbed — and never the recap or the
builder's own recommendation (the mate's judgment stays independent; the
card shows both side by side). The v13 fleet chat keeps its exclusion.

**`propose_answer {decision, option, rationale}`** writes an `answer`
proposal carrying the decision id, the task, the option id and label, its
reversibility, and the rationale (≤ 400 plain characters). The card shows
the question, every option WITH its consequence, the builder's
recommendation, and the mate's pick and rationale, and says the mate read
consequences but not the recap. Confirming answers the decision as the
operator through `answerDecision` (via `web` or `cli`); an irreversible
option confirms only with the existing `confirm=yes` field (a checkbox on
the card; `confirm N yes` in the REPL) — ruling 12 unchanged. A decision
answered meanwhile refuses `already-answered`.

**Proposals over the MCP gateway.** Coordinators gain `get_decision` and
`propose_next / propose_reserve / propose_hold / propose_unhold /
propose_scope / propose_cancel / propose_answer`, each writing a row in
`coordinator_proposal` (cid, the coordinator's name at filing, repo, kind,
payload with the same CAS material the mate's carry, state
`pending|confirming|confirmed|refused|dismissed|expired`). Each tool
re-authenticates the token inside its transaction, refuses a task or
decision outside the allowlist as not-found, counts against the
credential's per-hour limit together with filings, and holds at most 20
pending rows per credential. Rows expire after 7 days; revoking the
credential expires its pending rows.

**Who confirms.** Any approver whose ceiling admits the row's repo, from
the console — cards under "proposed by coordinators" on `/chat` (both
modes) and on the task's own page, `POST /proposals/:id/confirm|dismiss`
with csrf — or the CLI (`toolroll proposals`, `proposals confirm
<id> [--yes]`, `proposals dismiss <id>`). The door is
`confirmCoordinatorProposal`: one transaction, standing re-proved inside,
the repo re-checked against the confirmer's ceiling, `pending →
confirming` CAS, the shared executor, `confirming → confirmed|refused`.
A scope a coordinator wrote stamps `proposed_via = 'coordinator'`, and
the mode seal refuses it exactly as it refuses the mate's.

**Shared executor.** `executeProposal` in `src/mate-doors.ts` runs every
kind for either door under `{ name, repos }` taken from a
`VerifiedApprover` — never a structural caller object.


## 10. v4 (2026-09-02): scout tasks, and Telegram digests

Both were deferred in §8; the operator asked for them. No rule changes:
a scout reads and never writes, exactly like the planner, and a digest
is the outbox's cadence, never its content.

### Scout tasks

**A task's deliverable is `branch` or `report`.** `task_ref.deliverable`
(v34, default `branch`) is set at filing — `task add --report`, the
console's "scout" checkbox on the new-task form, `propose_task
{report: true}` from the mate, `file_proposal {deliverable: "report"}`
over the gateway — and never changes afterwards: a filing is a promise
about what comes back, and rewriting it after somebody approved the scope
would approve something else. A scout task is otherwise an ordinary task:
its scope is written and approved through the same ceremony (the yes is
the spend authorization, and the approval binds routing exactly as it
does for a build), it queues, holds, reserves, and chains the same way,
and modes cover it under the same rail.

**The scout run** (`run.role = 'scout'`, its own word in every cost
report — recording a scout as a planner or a builder would make the
three indistinguishable afterwards) rides the planner's road: a
disposable worktree on `standing-orders-scout/<id>`, plan-mode
permissions, the clean-tree proof BEFORE any payload is read (branch
unmoved, HEAD unmoved, nothing foreign in the tree), one park mailbox for
a question the operator answers like any decision, and a terminal
protocol file `STANDING-ORDERS-REPORT-<nonce>.json`:

```
{ "title": "≤200", "summary": "≤1000, one paragraph",
  "report": "markdown, ≤64 KiB",
  "followUps": [{ "title": "≤200", "goal": "≤2000" }] (≤5) }
```

parsed with the 422 rule (fail closed, every problem at once, caps and
control characters refused). The whole payload is ONE evidence artifact
(`kind = 'report'`, `report.json`, sha256-verified before a byte renders);
the run finishes `built / report-delivered`; the task is `done`; the
outbox carries `report-ready` with the summary — routine, no push class.
No branch is kept, nothing publishes, nothing merges: a scout's branch
namespace is its own, so a later build starts from base with nothing a
scouting session could have left as an ancestor.

**Failure is the builder's discipline, not the planner's.** A scout task
has no builder attempts, so its strikes ARE the task's strikes: a failed
scouting run takes a strike and a doubling backoff; three consecutive
stall the task (`attempts-exhausted`, the task `failed`, a page); a
malformed report is a straight incident (`malformed-report`, v34) with a
hold, no strike — the protocol failed, not the weather. `task requeue`
clears all of it, as for a build.

**Where the report shows.** The task page renders the title, the summary,
the document (inert, like the plan), and each follow-up as a card with
"file this follow-up": `POST /t/:id/follow-up {index}` files a task in the
same repository through the one filing door with `filed_via = 'console'`
and `proposed_via = 'scout'` — the scope text is an LLM's, so **mode
coverage never seals it** (the same rule as the mate's and a
coordinator's; the seal's refusal list grows by one word). The portfolio
ledger row for a scout run says `report` and links the task. `task show`
prints the title and summary. `get_task` (mate and gateway) gains
`report: {title, summary, followUps} | null` — through `mateView` for the
mate, so a path typed into a summary is scrubbed like everything else.
The board says "scouting" where it would say "planning".

### Telegram digests

**Away mode is a cadence on the bridge.** `telegram_digest` (v34, one
row) holds `every_ms` (null = off, today's behavior), who set it, when,
and `last_sent_at`. Set from the CLI — `bridge telegram digest --every
30m|2h|24h` / `--off` — or the console's settings card; `bridge telegram
status` and the card both say the cadence, how many routine facts are
held, and the earliest next digest.

**What still pages singly.** A decision (`dedupe_key = decision:<id>`,
buttons and all) and every `attention`-class fact (incidents, stalls,
commit failures, gaps that block work, malformed payloads) go out the
moment the bridge sees them, digest or no digest — those are the wedge
alarms. Everything else is routine (merges, publications, `plan-ready`,
`report-ready`, a retry's backoff note, the answered-decision echo) and is
HELD in the outbox — unclaimed, `delivered_at IS NULL` — until the cadence
elapses. `claimDeliveries` takes an `only` argument (`all` | `urgent`);
the bridge asks for `urgent` while a digest window is open and `all` once
it has elapsed.

**The digest itself** is one plain message (split at Telegram's ceiling
like every long text): a header with the count and the window, then one
line per fact — subject, then its body's first line, indented — in id
order. Every batched row is finalized with the same receipt in the same
pass; a transport failure finalizes them all failed and leaves
`last_sent_at` alone, so the next pass tries again. A row resolved while
held (a decision answered, a gap filled) never enters a digest —
`resolved_at` already excludes it from claiming. The webhook mirrors
(Slack, Discord) and `outbox deliver --cmd` are untouched: the cadence is
Telegram's.

**At most one digest per window, and nothing on an empty window.** The
window is measured from `last_sent_at`; a routine fact arriving after a
long quiet goes out at the next pass, not after another full interval.
Turning the digest off flushes nothing by itself — the next pass claims
everything, as today.

### Round-5 rulings (the v4 Codex review, 2026-09-02): twelve findings

1. **A report that is not captured is a failed attempt.** `writeEvidenceFile`
   failing returns `capture-failed` from the scout; the finalizer requires
   the artifact; the task stays queued with a strike. A task whose sole
   deliverable does not exist is not done.
2. **The deliverable rides the filing's transaction.** `createTask` stamps
   it; `setDeliverable` is gone — there is no API to change a deliverable
   after filing. `task add --report` on a tracker backend refuses up front.
3. **Scout checkouts are disposable, and now actually disposed.** One
   branch per attempt (`standing-orders-scout/<id>/<nonce>`), leased from
   base, and `WorktreePool.discard` removes the checkout and the branch
   after the run; a checkout that could not be discarded is said on the
   tick outcome. A parked scout resumes against today's base.
4. **The clean-tree proof sees ignored writes and staged protocol files.**
   `src/tree-proof.ts`, shared by the scout and the planner: ignored paths
   are snapshotted before the agent and any new one is foreign; a protocol
   file is admitted only as plain untracked. Stated residual: git collapses
   ignored directories, so a write INTO a directory ignored before the
   agent ran (a dependency tree the setup command produced) is not seen.
5. **The digest's boundary is the bridge lease plus one transaction.** Two
   bridges never deliver concurrently for one bot — the poll lease already
   serializes them, exactly as for single pages. Every batched row and the
   anchor are now finalized in ONE transaction; a claim that lapsed during
   a slow send is reported ("may be sent again"), never swallowed. A crash
   between send and finalize re-sends, as it does for singles — duplicate
   over loss, unchanged.
6. **Gaps that block work and failed publications are attention-class.**
   Both stamp `pushClass: "attention"` at enqueue, so they page singly
   under any cadence.
7. **Substrings are not recognizers, here either.** `rebuildArtifactForV34`
   and `rebuildIncidentForV34` are exact copy-renames over the known v17
   and v7 shapes; a lookalike refuses. (The older `rebuildForV4` calls
   remain what they were for their own eras.)
8. **Credential shapes never leave the repository boundary.** Every report
   field is scanned with the diff capture's detector and redacted line by
   line before the artifact is written; the artifact says `redacted`; the
   outbox row carries the redacted summary.
9. **The ceremony says what the yes buys.** Both approval cards — the task
   page and `/next` — say a scout task authorizes a read-only session and
   a report, no branch.
10. **"File this follow-up" is idempotent by construction.** The filing's
    id derives from the source task, the report's run, and the follow-up's
    place; a retried tap lands on the task the first one filed.
11. **Caps are bytes; a summary is one paragraph.** `REPORT_LIMITS` are
    UTF-8 bytes; a blank line inside the summary refuses.
12. **A malformed park mailbox is a `malformed-decision`.** The scout AND
    the planner finalizers take which payload broke; the incident and the
    page name it. The planner's own taxonomy was wrong the same way.
