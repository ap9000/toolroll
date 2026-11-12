# Better coding sessions with FirstMate patterns

Recommendation: add a current session brief, durable handoff notes, and reviewed
project memory to Standing Orders' native coding workspace. Keep one owner for
session execution, delivery receipts, permissions, and shipping. FirstMate is
useful source material for these features; adopting its entire supervisor would
introduce a second owner for work Standing Orders already manages.

This is an implementation plan, not an installed integration. The working scope
is Standing Orders coding sessions. A Codex App option is recorded below.

The follow-up [interface consolidation plan](INTERFACE_CONSOLIDATION_PLAN_2026-09-19.md)
comes first: preserve project/result context, share next-action queries, and
expose native session operations consistently to the UI, CLI, and authorized
agents. Build the continuity features on that shared surface.

## Branch and deployment checked

Inspected on September 19, 2026, around 22:16 America/Los_Angeles:

| Surface | Current state |
| --- | --- |
| Canonical checkout | `~/Developer/standing-orders`, clean `main`, fetched `origin/main` at `9de2053` |
| Running UI and worker | Verified candidate `f1f35d4d5cfa9f6db12cb7251c2d6301e95df597`; both processes use the same staged runtime |
| Source equivalence | Main and the deployed candidate have the identical Git tree `633877cca26bb2d73fbce87ef2f70b804fb0188a` |
| Latest committed development | `codex/standalone-workspace-20260919` at `b431d625946b0e651f2ccc4ebc7424c1865bb35a`, native coding foundation on main |
| Planning checkout | `~/Developer/standing-orders-firstmate`, branch `codex/firstmate-session-plan-20260919`, based on that foundation |
| Preserved work | Original Documents checkout and standalone checkout contain unfinished edits; neither was reset, stashed, or switched |

The deployment is already current with main. No replacement or restart was
needed. Its deployment receipt is
`~/.config/standing-orders/staged-upgrades/browser-f1f35d4-pr28-20260919/deployment.json`.
Read-only checks confirmed:

- Builder 1846 still has its approved scope and a `verified` verdict. Independent
  review 1847 upheld all three criteria on this exact candidate and scope.
- The retained native gate receipt names that candidate and the approved command
  `npm run typecheck && npm test -- --run --reporter=dot && npm run build`, exit 0.
  That full suite was not repeated for this documentation task.
- The package hash matches the deployment receipt. All 326 installed dist files
  match the packed artifact byte for byte, with identical file inventories.
- Database schema is 69. Active runs, claims, conversations, sessions, and
  stopping work were all zero at the inspection. Current worker leases were fresh.
- The recorded supervisor and worker PIDs were still running from the recorded
  runtime. Local HTTP and configured HTTPS returned 303 sign-in redirects.
  Authenticated remote access and browser/device behavior were not tested here.

The newer foundation is not a verified deployment. Its committed report records
typecheck and 153 focused tests across seven files, using fake native responses
and real Git/SQLite/process fixtures. It explicitly makes no final-gate, browser,
or deployment claim. No newer builder run existed for the canonical project in
the production ledger. Its uncommitted web workspace and shipping work must be
finished and verified before deployment; this plan does not absorb those edits.

## What FirstMate contributes

Research is pinned to FirstMate commit
[`90cd351ac8b828d7074fe4a432acda246355bec7`](https://github.com/kunchenguid/firstmate/tree/90cd351ac8b828d7074fe4a432acda246355bec7).
The repository was read in a temporary reference checkout; none of its hooks,
watchers, installation scripts, or agent instructions were activated.

FirstMate is an agent distribution built from instructions, skills, scripts,
and persistent state. It is not an embeddable session SDK or MCP server. Its
terminal backends coordinate separate workers and worktrees. Standing Orders
already has those responsibilities.
[Upstream overview](https://github.com/kunchenguid/firstmate/blob/90cd351ac8b828d7074fe4a432acda246355bec7/README.md)

| Useful pattern | Standing Orders implementation | User benefit |
| --- | --- | --- |
| Bearings: build a fresh brief from structured state | A read-only projection of sessions, requests, delivery uncertainty, saved changes, and linked shipping tasks | Return after a break and see the next action immediately |
| Stow: preserve findings and unfinished work | Versioned session handoff plus explicit proposals to Project knowledge | Less repeated explanation between sessions |
| Bounded startup memory and recoverable archival | Reuse knowledge selection limits; retrieve detail on demand and retain history | Context stays relevant without an ever-growing prompt |
| Durable, acknowledged actionable wakes | Persist attention events from native lifecycle changes, with cursors and deduplication | Fewer repeated notifications; failures survive reconnects |
| Reconcile before continuing | Extend the existing saved-thread and process-custody checks | A new browser connection cannot duplicate a turn or invent success |

Bearings derives its brief from one current snapshot rather than an earlier
report. Adopt that principle, while deriving our snapshot from the existing
catalog and task ledger.
[Bearings source](https://github.com/kunchenguid/firstmate/blob/90cd351ac8b828d7074fe4a432acda246355bec7/.agents/skills/bearings/SKILL.md)

The standalone Stow skill captures preferences, facts, decisions, and unfinished
steps, favors existing authoritative sources, and archives stale notes. Our
adaptation should preserve these ideas without automatically rewriting AGENTS.md
or moving private session content into shared project instructions.
[Public Stow source](https://github.com/kunchenguid/firstmate/blob/90cd351ac8b828d7074fe4a432acda246355bec7/skills/stow/SKILL.md)

FirstMate's watcher separates process liveness, declared waits, progress, and
unhandled events. Adopt those distinctions using native events and durable
receipts, rather than scraping terminal panes. A quiet agent is not by itself
evidence of failure. Attention checks must not add agent execution time limits
or automatically interrupt, restart, or replay work.
[Supervision architecture](https://github.com/kunchenguid/firstmate/blob/90cd351ac8b828d7074fe4a432acda246355bec7/docs/architecture.md)

## Existing implementation to extend

These references describe the committed foundation at `b431d62`:

- `src/coding-workspace.ts`: a separate SQLite catalog for sessions, items,
  approval requests, and submission receipts; native thread identity; reconnect,
  stop, recovery, and same-session follow-up. `snapshot`, `event`, `load`,
  `recover`, and `sendMessage` are the relevant boundaries.
- `src/coding-provider.ts`: the owned native Codex app-server process, framed
  protocol, pending requests, process custody, and verified shutdown. Keep this
  as the provider boundary; FirstMate scripts should not control these processes.
- `src/coding-context.ts`: knowledge and skills captured once, hashed, and
  reused on resume. New memory must not silently mutate this frozen capture.
- `src/project-knowledge.ts`: editable project knowledge with immutable change
  history, source hashes, relevance selection, and a 24,000-byte selected-context
  limit. Reuse its owner and access checks for adopted project facts.
- `src/project-learning.ts`: lessons tied to reviewed builder evidence. Session
  notes do not satisfy that contract and must not manufacture review-backed lessons.
- `src/chat-controls.ts` and existing shared action proposals: expose the same
  actions to chat and the UI, with the same saved state and approval requirements.

The separate standalone checkout also contains uncommitted `coding-ui.ts`,
`coding-handoff.ts`, shipping controls, and console changes. They are a dependency
to coordinate with, not stable interfaces or completed acceptance evidence.

## Delivery sequence

### 0. Finish and release the native workspace

Complete the already-started desktop/phone journey and native editing/revision
proof. Preserve its frozen base, receipts, and shipping approvals. Run its final
machine gate and independent review, then deploy UI and worker together through
the existing drain, backup, compatibility, process-exit, and health checks.
Start the session-improvement task from that verified release. Do not silently
change the original base of an already dispatched task.

### 1. Ship a current session brief and durable handoff

This is the recommended first increment. It delivers useful continuity without
requiring another supervisor, background model calls, or a memory migration in
the orders database.

Add a `coding-brief.ts` projection with a bounded, permission-checked contract:

```text
session identity + catalog revision + native thread/turn
current state + pending approvals/questions + delivery uncertainty
latest completed response + known check results and their sources
observed HEAD and dirty-state digest + observation time
linked shipping task identity and current status
one suggested next action + freshness/omission disclosures
```

Read structured state first. Treat agent assertions such as "tests passed" as
reported claims unless tied to retained command evidence. Keep live status apart
from historical summaries. Read-only catch-up must never send a provider turn,
answer an approval, clear an error, or create a shipping task.

Git observations can race with a working agent. Bind them to an observation time
and revision, report changes during capture, and do not call a live dirty tree a
frozen candidate. Existing commit-bound shipping checks remain authoritative.

Persist handoffs in the coding catalog with session ID, native thread ID,
source revision/item IDs, observed HEAD, content digest, author/source, and time.
Keep historical versions. A handoff captures goal, decisions, remaining work,
and evidence pointers; it is advisory context, never an execution receipt.

Initially build the brief deterministically from saved state and the latest
completed response. Let the user edit a short handoff through **Save handoff**.
A later model-assisted draft can be explicit and budgeted; do not add a hidden
model call to every turn. A missing handoff must never prevent Stop or drain.

Normal resume continues the same native thread and frozen context. Show a newer
handoff to the user without replaying it as another user instruction. If a new
session is explicitly requested, allow selection of a saved handoff as reference
material and record exactly which version was supplied. Never fall back to a new
thread silently after a failed resume.

### 2. Add “Remember this” through Project knowledge

Allow selected decisions or findings to become a proposed knowledge change.
Show the exact text and destination before applying the existing knowledge
action. Check the expected knowledge revision and reject stale proposals.
Preserve session-private notes until the user chooses to share them.

Use evidence pointers and source versions to avoid duplicate facts. Preserve
explicit user preferences, revalidate source-dependent facts, and archive
superseded notes with provenance. Do not apply automatic aging to AGENTS.md,
approval terms, or existing user instructions. Keep session checkpoints and
review-verified lessons as distinct records with truthful labels.

Stay within current context and spend ceilings. Return explicit omissions if
the selected context is too large; retrieve longer detail on demand. A long
history should not become an ever-growing developer instruction. Updating
Project knowledge affects later captures; any mid-session supplement must be a
visible, versioned action that preserves the original capture.

### 3. Add quiet, durable attention handling

Persist events for approval needed, question asked, turn failed, uncertain
delivery, connection lost, and result ready. Bind each to session, native
thread/turn, event kind, and source identity. Use a stable unique key and a saved
consumer cursor so reconnects and restarts do not duplicate notifications.

Keep an approval pending until its native request resolves; viewing a card only
acknowledges the notification. Separate "waiting for you", "waiting for an
external result", "working", and "connection lost" from existing structured
state. Never infer a failed turn from silence alone. Reuse existing notification
delivery where it fits; do not install FirstMate's shell watch loop alongside it.

Defer crew/secondmate routing until a real workload demonstrates that the
existing queue and native sessions cannot handle it. No new orchestration is
needed for the first two increments.

## Product behavior and acceptance

Use ordinary controls: **Continue**, **Review changes**, **Save handoff**, and
**Remember this** where each is relevant. On return, show a short state such as
"Ready to continue" with the last outcome and one primary action. Keep evidence,
older notes, and memory settings in disclosures. Preserve full approval terms,
uncertain delivery, and failure recovery before any consequential action.

Acceptance for the first increment:

1. Return to a session and see its current state, last outcome, and next action
   without reading a paragraph. Empty sessions and missing handoffs remain usable.
2. Save and retrieve the same handoff after browser disconnect and service
   restart. Stale saves are rejected and history is retained.
3. A brief request produces no provider mutation. A saved summary never claims
   an uncertain message was delivered or an unverified check passed.
4. Revoked or wrong-generation accounts cannot read another session's brief,
   notes, transcript, or linked result. Untrusted source text cannot grant authority.
5. Native resume keeps the same thread and does not duplicate a user message.
   Missing native history leaves saved work accessible and recovery explicit.
6. Chat and UI use the same saved handoff and owning actions. A navigation link
   is labeled as navigation, never reported as a completed mutation.
7. Inspect one real desktop journey and one phone journey: open the result,
   inspect changes, give feedback, create a revision, reconnect, and continue.
   Cover affected empty, long-content, error, approval, and uncertain states.
   Check keyboard access, contrast, tap targets, overflow, and fixed controls.

Extend existing coding workspace/context tests for revisions, persistence,
access, and recovery. Add focused projection tests and the small regressions for
any reproduced defects. Run typecheck and affected tests during implementation.
If chat schemas/model contracts change, include CLI and browser entry-point
tests at their existing default spend ceilings.

Before dispatch, commit the complete candidate and evidence; count changed paths
against the original task base; verify cited artifacts and hashes from the Git
tree; run `.codex/check-prepared-evidence.mjs` with the original base, candidate,
current checks manifest, and verified runtime. The helper is currently local to
the original Documents checkout. It does not replace the native gate or review.
Run the unchanged full verification command once at the final machine gate for
that candidate, then use normal reviewed deployment. Recheck only when a failure,
candidate change, or concrete uncovered risk requires it.

## How to judge improvement

Use matched session scenarios and record the evidence, rather than promise an
unmeasured productivity gain:

- Can a returning user identify the next action from the brief?
- How often must they repeat an already recorded decision?
- Does restart preserve the same native thread, draft, handoff, and approvals?
- Does history growth keep selected startup context within the existing bound?
- Does an actionable event notify once while an unresolved approval stays visible?
- Does the simplest version require fewer fields and steps than today's flow?

This research did not run a FirstMate workload or benchmark model cost, response
quality, or session speed. The benefits above are implementation hypotheses to
validate with those journeys.

## If “our sessions” means the Codex App

FirstMate explicitly says Codex App is not a selectable backend: its shell
scripts lack a supported transport for controlling the same visible Desktop
thread over its full lifecycle. An app-server-created thread is not proof of
Desktop ownership. Do not build a private control-socket bridge or claim that
desktop host tools are callable from arbitrary FirstMate subprocesses.
[Upstream backend boundary](https://github.com/kunchenguid/firstmate/blob/90cd351ac8b828d7074fe4a432acda246355bec7/docs/codex-app-backend.md)

For immediate Codex App use, the standalone public `skills/stow` is the smallest
candidate to evaluate as an explicitly invoked save-session workflow. It does
not require the FirstMate supervisor. Its internal `.agents/skills` assume a
live FirstMate home and should not be installed indiscriminately. No FirstMate skill has been installed and no global memory has been changed.
The initial implementation adopts a deterministic saved-context brief; see
`INTERFACE_IMPLEMENTATION_2026-09-19.md` for delivery status.

A separate full FirstMate pilot would run in its own home with a supported
terminal backend and one sample repository. It would not supervise the same
worktrees as Standing Orders. That is useful only if the desired product is a
terminal fleet manager. For our web coding workspace, implement the native
session brief first.
