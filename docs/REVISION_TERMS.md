# Revision terms: what a child task inherits, and what it never does

Task 2 of [the contract handoff plan](CONTRACT_HANDOFF_PLAN.md). Every
revision of a reviewed build — an annotation revision from the run page, a
CI repair draft from a red pull request, a criterion repair draft from the
bounded repair loop — is filed through one boundary, `Store.sealRevision`,
under one field-by-field policy. The three roads compose only their own
words (a title, the explicitly described repair, the brief they wrote to
disk); the terms come from the source rows the seal itself proves.

## The source binding

Inside the seal's transaction, against live rows, before anything is created:

| Proven | Refusal |
| --- | --- |
| The source task exists. | `source-task` |
| The source run is that task's own attempt. | `source-run` |
| The source scope's digest matches both the caller and the actual source run (legacy empty run stamps normalize to no scope). | `stale-source` |
| The stored terms read back exactly (the raw terms verdict is clean). | `source-terms` |
| The brief file re-reads and re-hashes under the evidence root, within its cap, and names this exact source task, run, scope digest, head, and full annotation batch. | `brief-custody` |
| The comment batch is still whole (annotation road). | `comments-taken` |
| The deterministic child id, or the repair chain's `source_run`, is unclaimed. | `duplicate` |

A refusal writes nothing: the seal runs under its own savepoint, so an
enclosing transaction (the annotation road wraps the seal with its mode
coverage) can never commit half a child. A brief file whose seal refused is
an orphan on disk, not authority — no artifact row points at it. Two
concurrent seals of the same source have exactly one winner; the loser
refuses in words with zero rows (including named SQLite contention).

## The policy, field by field

**Inherited verbatim** — declared requirements and constraints; the
installation's defaults of the day never apply to them:

| Term | From | Rule |
| --- | --- | --- |
| goal | source scope | the child appends ` — <the described repair>` |
| exclusions (`not this`) | source scope | verbatim |
| touches | source scope | verbatim |
| acceptance rubric | source scope | the exact criteria, ids, statements and evidence needs |
| quality mode | source scope and task | `strict` stays `strict` |
| permission posture | source task, else its sealed profile | the source's durable choice, else the posture its sealed profile ran under — never wider; a widened installation default does not reach the child |
| per-attempt budget | source scope | never lifted or removed; a live mode's filing default may only tighten it (`min`) |
| per-phase route overrides | source task | the approver's overrides are carried, so the route is recommended over them |
| build / plan agent pins | source task | carried |

**Re-resolved at filing, then approved afresh** — execution choices; the
child's digest binds what they resolved to, and a yes on the source never
covers them:

- the phase route and its execution profile, recommended over the inherited
  quality, evidence needs, overrides and pins under today's configuration and
  today's publication authority;
- the auth mode, read strictly at filing exactly as on every other road.

**Never inherited** — grants and machine state:

- the approval stamp and its basis (a mode-approved source hands nothing
  down; the child leaves the seal with `approved_at = NULL`);
- attended-session authorizations;
- publication and merge grants (per repository, proven at publication time,
  never stamped on a task);
- the plan document and its revision ledger (a revision may be planned afresh;
  the brief plus the source scope are its contract — see below);
- strikes, holds, and the source's runs.

**Fresh from a live mode, only when the caller re-proved coverage inside the
same transaction**: the budget default may tighten the inherited ceiling.
A scoped source whose sealed profile or durable task posture is `auto` stays
`auto`; a mode cannot widen it. Coverage is never carried across transactions
or from the parent.

A source with no scope (a legacy filing) has nothing to inherit: the child
files the placeholder rubric and today's defaults, and every projection says
the source had no scope.

A new revision build starts from the exact source head recorded in its
verified brief. An explicit base or existing revision branch must contain that
head. Missing or stale source identity refuses before a lease or provider spend.

## Planning a send-back

A revision a person sends back with notes (the result page, chat, or a flow's
"send it back") is filed with planning requested. The planner works on the
revised build's head and reads the copied terms and the notes. A note that
fits the copied terms leaves them as they are. A note that asks for more
than they allow ("also add multiply", when the copy rules other functions
out) becomes an amendment: the other terms and criteria stay, a criterion
for the new work is added, and the change and its reason are shown at
approval. Nothing builds until a person approves the updated terms.

The widening happens only here, before approval. At build time the brief is
still quoted data, and a note that seems to widen the approved scope still
parks the build. Repair drafts (CI and criterion repairs) are not planned
this way: their brief cannot widen the contract.

Under a live mode that covers the sender, a send-back is approved at filing,
as before, and is not planned: revisions never inherit a mode's planner
authority (docs/AUTO_APPROVAL.md).

## Approval semantics

Revision creation grants nothing. The child approves only through the
normal roads — the password ceremony on the task page or chat, or a live
mode's filing coverage sealed by the caller inside its own transaction
through `sealScopeApproval`'s ordinary checks (the coordinator and mate
quarantines, the strict stored-scope projection, a runnable route). A
scope whose profile could not resolve stays honestly unapproved on both
roads.

## Repair lineage and remaining bounds

The bounded repair loop finds the chain a task continues through its
revision ancestry (`Store.repairLineageOf`): the nearest task in the
ancestry — itself included — that is a repair draft names the chain;
failing that, the nearest ancestor that roots one. An annotation revision
or CI repair between two repair attempts is therefore a detour, not a new
chain: the root stays the root, the next attempt is one past the chain's
highest, and a signed mode's `repairMaxAttempts` counts every attempt
already spent. A stop settles the row the task continues when it is still
open, and records its own settled row otherwise. Nothing is stored beyond
`task_ref.revision_of` and the existing `repair_chain` rows, so a restart
reads the same lineage. Cycles, missing ancestors, and ancestry beyond the
64-task bound refuse visibly. Repair draft creation proves the canonical root
and next ordinal again inside its transaction, including the signed cap.

## Projections

The task page's revision card, the approval card, and the task chat card
all read `Store.revisionLineageOf`: which source and build the task revises,
the ancestry to its root, the terms the child actually carries (read from
its own scope and ref, never restated from the brief), what re-resolves for
this approval, what never inherits, and — when the task continues a repair
chain — the attempts used against the signed cap and the remaining
automatic bound.

## Coverage

`src/revision-terms.test.ts` drives all three roads against a file-backed
store: changed installation defaults, stale/mismatched sources, tampered and
misnamed briefs, corrupt stored terms, the comment race inside an enclosing
transaction, the budget and permission rules, re-resolved routes and
chains, the no-grant invariant, an annotation and a CI detour across a
restart, and concurrent duplicates through a second connection.
`src/serve.test.ts` proves the console: task page, approval card, chat, and
the CI draft show the actual inherited terms and lineage.
