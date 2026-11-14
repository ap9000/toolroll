# Local owner acts: plan, retry and accept without a password

Status: plan, 2026-11-12. Not built. Branch `local-owner-acts-plan`, from main `eda62aad`.

## The decision

Alex (2026-11-12): on this computer only, the laptop's passwordless **local owner** may also, with no password:

1. **Ask for a plan** for a task that is bigger than a small change.
2. **Retry their own approved build** after it stopped (a console restart, a model error).
3. **Accept a result**, including one that owes the person's own check, from the terminal.

Merging, releasing, hands-off modes and settings keep their password. API tokens, the lead, chat bots, builders and every
other machine caller gain nothing. A model never approves anything.

Evidence: the first-result report for 0.9.103 (`B1.2` fails twice: accept in the terminal, plan without a password) and
the journeys on `origin/first-result-timing:scripts/first-result-e2e.mjs` (lines 454-475 plan, 795-829 retry, 555 accept).

## Today

### Who the local owner is

- **Terminal.** Bare `toolroll` opens the terminal UI. Every write is a CLI command run in-process inside
  `runAsLocalOwner` (`src/tui-source.ts:66-70`, `src/local-owner.ts:166`). `runOperate` binds the principal from the
  `local_mode` row as it reads at that moment (`src/operate.ts:1152-1162`, `localOwnerCommand` at `:13806`). It refuses
  any command without a `LOCAL_ALLOW` row, and any command naming `--as`, `--token`, `--token-file` or `--token-env`
  (`:13817`). The principal carries the account, the local-mode and account generations, transport `terminal` and
  the row's act (`src/local-owner.ts:121-135`).
- **Browser.** `toolroll open` mints a one-time link (`src/serve.ts:2440`). It is redeemed only from this computer: a
  loopback peer, a loopback Host, no proxy headers (`src/server/people-tokens.ts:273`, `fromThisComputer` at
  `src/serve.ts:409`). The saved session has authority `local-owner`, bound to both generations (`people-tokens.ts:287-296`).
  Each request is refused before any handler unless its route row is marked `allow` (`src/serve.ts:983`). The principal
  gets the row's act and is re-checked now (`localPrincipalOf`, `src/serve.ts:2413`). Individual requests are not
  re-checked for "this computer" after the session exists.
- **At the write.** `Store.transact` re-checks that the owner still stands inside every write (`src/store.ts:8385`).
  `proveAccountNow` answers `local-owner` for **any** non-read act in flight (`src/scope.ts:1356-1360`). Only `approve()`
  then insists on the exact act `approve-plan` and on `localApprovalEligible` (`src/scope.ts:1558-1564`, `:2168`).

### What is allowed

`LOCAL_ALLOW` (`src/surface.ts:596-628`) and `LOCAL_POSTS` (`src/server/route-table.ts:149-205`) list filing, build-now,
lead messages, approve-plan, answering, stop, pause, resume, **complete**, send back, archive, add-project, a few
lowering settings and memory review. Absent: `task plan`, `task requeue`, `task.act.plan`, `task.act.requeue`. Chat
task cards `retry` and `plan` map to no act (`src/local-owner.ts:234-235`).

### Why each act is refused

1. **Plan.** The terminal has no key for it. `n` files with `task add` and says "Its plan will be ready for you to
   approve" (`src/tui-source.ts:140`), but nothing asks the planner. `task plan` has no `LOCAL_ALLOW` row, so
   `localOwnerCommand` refuses: "Set a password to do this." (`src/operate.ts:13810`). The browser's plan button posts
   `/t/:id/plan` (`task.act.plan`, `route-table.ts:663`). It has no `LOCAL_POSTS` entry, so `serve.ts:983` refuses it.
2. **Retry.** `r` sends `task retry` (`src/tui-source.ts:147`). That is not a command (`TASK_ACTIONS`,
   `src/operate.ts:894`); it is refused even earlier, at `:13810`, because no row matches. The real command,
   `task requeue` (`:4690`), has no row either. The browser's Retry posts `/t/:id/requeue` (`route-table.ts:659`), which
   has no `LOCAL_POSTS` entry.
3. **Accept.** `c`, and `a` on a result (`src/tui/app.tsx:152,179,183`), send `task complete <id> --digest <receipt>`
   (`src/tui-source.ts:148-153`). The row is allowed (`surface.ts:616`). Then `runTaskOutcomeCommand` asks for an
   operator (`src/task-outcome-cli.ts:38`). `askCredentials` hands back the owner with an empty password
   (`operate.ts:11271`). `verifyApproverByPassword` (`src/principal.ts:61`) calls `authenticateAccount`
   (`src/scope.ts:1201`), which has no local-owner branch, unlike `proveAccountNow`. The empty password fails against
   the owner's random hash. The operator is null, so the answer is "Sign in with up, or supply --as and --token…"
   (`task-outcome-cli.ts:39`). That failure also appears to count as a wrong password toward the lockout
   (`scope.ts:1238`). Even past it, the CLI completes with `checkAssignmentAsOperator` (`task-outcome-cli.ts:77`), which
   never records the person's own check. Only `acceptAndCompleteAsOperator` does (`src/assignment.ts:602`). The browser's
   Accept works: `task.act.complete` is allowed and its `accept=1` path uses that function (`src/server/tasks.ts:2374-2397`).
4. **Send back** (found later, fixed in the eight plan's F-lite). `b` sent `task revise <id> --feedback` down the same
   password road as item 3, so it failed the same way and counted a wrong password against the owner. It now takes its
   own road, as Accept does: `runLocalRevision` / `reviseAsLocalOwner` (`src/task-outcome-cli.ts`), chosen in
   `taskAction` only inside the local owner's chain, with the existing `request-revision` act (no new row). It pins the
   build the screen read (`--run`, required), refuses a newer current version, reads completion's work rule (release,
   protected, coordinator), never checks a password, and files the revision as the person's.

### The trap: rows alone grant too much

Because `proveAccountNow` says yes to any local act, `task plan` and `task requeue` would pass their only check
(`authenticateApprover`, `operate.ts:4699`, `:4764`) the moment they got a row. The local owner would then also get:
plan pins that choose the model (`:4770-4781`); pre-authorizing the plan under a signed mode (`:4786`, and the browser
does it for every cookie, `tasks.ts:1951`); and retrying a release, protected work or someone else's approval, with
strikes cleared and incidents resolved (`store.ts:13791`). So every writer below checks its exact act and the work
itself, inside its own transaction.

## Design

### Shared pieces

- **Two new acts** in `LOCAL_OWNER_ACTS`: `request-plan` and `retry-build`. Accept keeps `complete-task`.
- **`localActNow(store, act)`**: the current local owner, still in flight, standing now, with exactly this act and
  transport `terminal` or `browser`. Read inside the write's transaction. A lead or remote chain is never a local owner
  (`scope.ts:1356`). Every new writer calls it; none relies on `proveAccountNow` alone.
- **`localWorkEligible(store, owner, taskId)`**: the facts `localApprovalEligible` already reads, split out so approve,
  plan, retry and accept share one rule. Refused: local mode off or another person; release or deploy work; protected
  or two-person work; escalated permissions; work a coordinator filed or an imported issue; a project stored as
  unsandboxed. Approve keeps its extra "plan waiting" check.
- **This-computer belt.** For the three browser acts, admission also requires `fromThisComputer(request)`. A forwarded
  or tailnet request with a local-owner cookie gets the ordinary local-owner refusal.
- **Ledger.** Each act records the owner, the transport, the act and the ids it was bound to.

### 1. Ask for a plan

- **Surfaces.** `toolroll task plan <id> --digest <scope digest|none>`, row `"task plan": "request-plan"`. Route
  `task.act.plan` gets `request-plan`; its form gains a hidden `digest`. Terminal: see Terminal UX.
- **At the write, one transaction:** `localActNow("request-plan")`; the owner reaches the task's project; the task-level
  part of `localWorkEligible` (no coordinator, no imported issue, no release or deploy task, project not unsandboxed);
  the scope digest still equals `--digest` (or there is still no scope for `none`); then `store.requestPlan`, which
  re-reads queued, not already planned, not approved, no live claim (`store.ts:14068`).
- **Bound:** task id and scope digest (or `none`). A task reworded, cancelled, put away or approved since the screen was
  read is refused: "This task changed. Look at it again."
- **May not:** set plan pins (`--provider` and `--model` are refused for the local owner); pre-authorize the plan under
  a mode (`authorizePlanUnderMode` is skipped for a local owner, terminal and browser); approve anything. The drafted
  plan waits for `approve-plan` and its own terms screen.
- **Idempotent:** a plan already asked for or drafted, with the binding unchanged, answers "Already asked" and writes
  nothing.
- **Limits:** one plan at a time per task (`requestPlan`). Planner strikes as today. Hard-stop budgets still apply
  (`store.ts:17286`). A planner is a read-only role with a clean-tree proof (`src/tree-proof.ts`). Asking for a plan
  spends less than the build approval the local owner already gives.

### 2. Retry their own approved build

**Which builds.** Only a task whose current approval is this owner's own person yes: `approved_by` is the owner, the
basis is a person seal (`password` or `chat`, any person proof, the local one included), the approval still stands for
dispatch (`scopeApprovedForDispatch`, `src/dispatch.ts:195`), and `localWorkEligible` passes now. Not a mode, grant,
schedule, auto or carried seal. Not another person's approval. Why: the passwordless model is "approving work you start
here needs no password". A retry spends again under an existing yes. If that yes is the owner's own and the owner could
give it again now without a password, the retry adds no authority. A yes from someone else, from a mode or from a
release ceremony is not the local owner's to spend again.

- **Surfaces.** `toolroll task requeue <id> --run <n> --digest <scope digest>`, row `"task requeue": "retry-build"`.
  Route `task.act.requeue` gets `retry-build`; the Retry forms gain hidden `run` and `digest`. The terminal's `r` calls
  this command (the `task retry` name is dropped).
- **Before the transaction:** prove the task's earlier builds stopped, as completion does (`proveTaskBuildsStopped`,
  `src/task-outcome-cli.ts:160`). A build not yet proven stopped refuses: "The last build is still stopping. Try again in
  a moment."
- **At the write, one transaction:** `localActNow("retry-build")`; the approval rule above; scope `digest` equals
  `approved_digest` equals `--digest`; the latest finished builder run is `--run`; `requeueEligibility` (failed,
  stalled or rejected; no claim; not accepted or published; not put away; `store.ts:27097`); the local retry count for
  this approved digest is under the limit; then `requeueTask` with an `expect` that covers a failed task as well as a
  rejected done one.
- **May not:** change the scope, route, model, chain, budget, permissions or check access; seal or carry an approval.
  The browser's optional note stays a steering note, as today.
- **Idempotent:** if the task is already queued or running and the ledger holds this owner's retry of `--run`, answer
  "Already retrying" and write nothing.
- **Limits:** three local retries per approved digest, counted from the ledger in the same transaction. The fourth says
  "You've retried this 3 times. Send it back with a note, or sign in with your password to retry again." A new approval
  (after a send back) starts a new count. Toolroll's own automatic model-error retry is unchanged.

### 3. Accept a result (public-release v2 item 4, slice 3b)

- **Surface.** `toolroll task complete <id> --run <n> --digest <receipt> [--checked] [--reason "<why>"]`. For the local
  owner `--run` and `--digest` are required (never defaulted to the current receipt) and `--pull-request` is refused.
- **Authority.** The local owner's operator road no longer calls `authenticateAccount`. It mints a `VerifiedApprover`
  from the principal (account, account generation, the projects the owner reaches). `reproveApprover` and
  `localActNow("complete-task")` run inside the transaction. No failed-password count, ever.
- **At the write:** `acceptAndCompleteAsOperator` (authority re-proof, project access, exact receipt and run, roll back
  the acceptance if completion fails). Plus `localWorkEligible`. Protected-work rules and failed-check blockers stay in
  `acknowledgeCurrent`, unchanged.
- **What is owed.** A person's check needs `--checked`, or it refuses "Check it yourself first." An exception needs
  `--reason`; it is trimmed and must be nonempty at the command boundary, then `validateNote`. Nothing owed: a plain
  completion.
- **Idempotent:** the same pins after success answer "Already accepted" and write nothing. Different pins: "This result
  changed. Look at the new one."
- **May not:** merge, open a pull request, deploy, or change any check result.

## Callers

| Caller | Ask for a plan | Retry | Accept |
|---|---|---|---|
| Local owner, terminal UI | **new**, no password | **new**, own eligible approvals, 3 per approval | **new**, exact result, eligible work |
| Local owner, browser on this computer | **new**, same rules | **new**, same rules | as today, plus eligibility (see open question 3) |
| Local-owner cookie from another device, a proxy or a tailnet name | refused | refused | refused (belt) |
| Signed-in person with a password (any device) | unchanged | unchanged | unchanged |
| API token, act scope (`REMOTE_YES`) | unchanged | unchanged | unchanged |
| API token, read scope | refused, unchanged | refused, unchanged | refused, unchanged |
| The lead (lead token, lead chain) | unchanged, never local owner | unchanged | unchanged; never a person's check |
| Chat channels (Telegram, Slack, Teams, Discord) | unchanged | unchanged | unchanged |
| Builders, subagents, MCP, flows, schedules | nothing | nothing | nothing; never a person's check |

Only the first two rows gain anything. `REMOTE_POLICY`, route `callers` and `scope` for these rows do not change.

## Tests

New file `test/attacks/local-owner-acts.test.ts`, table-driven, on `test/local-owner-world.ts`. Starred cases fail on
today's code and must pass after.

**Plan**
- \* Terminal `task plan --digest none` as the local owner: plan requested, ledger says terminal.
- \* Browser POST `/t/:id/plan` with the matching digest: requested.
- With an active mode signed by the owner: still no `plan_authorization` row (fails on a rows-only build).
- `--provider`/`--model`: refused. Stale digest, approved scope, cancelled, put away: refused, nothing written.
- Coordinator-filed task, imported issue, release task, unsandboxed project: refused.
- Second ask: "Already asked", one ledger row.

**Retry**
- \* After a killed console (interrupted run, task failed): `task requeue --run --digest` queues it. Scope `digest`,
  `approved_digest`, approved route, profile, chain and budget are byte-identical before and after.
- \* Terminal `r` runs a real command (today it sends `task retry`, which doesn't exist).
- Wrong run, changed scope: refused "changed". Another person's approval, a mode seal, a release, protected, escalated,
  coordinator or unsandboxed work: refused.
- Earlier build not proven stopped: refused. Accepted or published result: refused as today.
- Fourth local retry of one approval: refused; a password retry still works; a new approval resets the count.
- Duplicate submit: one requeue, one ledger row.

**Accept** (slice 3b list)
- \* Terminal accept of a `manual-review` result with `--checked`: acceptance and completion, one transaction.
- \* Pressing `c` five times on a refused accept does not move the owner's password lockout.
- Result replaced while answering (a new run lands after the pin): stale, no acceptance row.
- Authority revoked mid-answer (local mode off, generation moved, account revoked): refused, nothing written.
- Cancel: nothing written. Duplicate submit: one acceptance, one ledger act.
- Failed completion rolls back the acceptance.
- Exception with no reason, or only spaces: refused at the command boundary.
- Person's check owed and no `--checked`: refused. `--pull-request` as the local owner: refused.
- A machine caller cannot make a person's check: coordinator token, lead token, remote API token and a chat bridge each
  leave no `proof_acceptance` row on a `manual-review` result.

**Nobody else gained anything**
- `test/attacks/local-owner-cli.test.ts`: the allowed set is asserted exactly (today it only checks that denied rows
  refuse); add `task plan` and `task requeue`; the credential-flags case covers them.
- `test/attacks/local-owner-routes.slow.test.ts` walks every row already; it picks up the two new `allow` rows. Add a
  pass with a forwarded header and a tailnet Host: the three new acts refuse.
- `src/server/adapter-inventory.test.ts`: the exact `LOCAL_POLICY` allow set, `REMOTE_POLICY` unchanged for the three
  rows, and the chat task-action table.
- `test/attacks/local-owner-approval.test.ts`: the prover table gains rows. `request-plan` and `retry-build` never
  approve; a lead or remote chain holding a local principal proves nothing.
- `src/tui/app.test.ts`: `p`, `r`, `a`, `c` send the pinned ids; Esc sends nothing.

## Terminal UX

Keys stay as `src/keymap.ts` has them: `a` approve or accept, `c` accept, `b` send back, `r` retry. One new key: `p`.

| Key | Where | Words on screen |
|---|---|---|
| Enter on New task | a task too big to build straight away | "Filed. Asking for a plan." then "Planning. You'll approve the plan before anything is built." |
| `p` | Build screen, or a task waiting for a plan | "p plan it" · after: "Asked for a plan." |
| `r` | a failed or stopped build | "Retry build #N? Same plan, same agent. y retry · Esc cancel" · after: "Retrying. A builder starts it next." |
| `a` / `c` | a finished result | opens **Accept this result?** |

**Accept this result?** shows, read once and pinned: the result's own summary, changed files (names, first ten, then
"and N more"), each requirement with how it is shown, and the actual check status (the "Can I merge?" lines). Then:

- a person's check owed: "Did you check it yourself? y yes, it looks right · w open in the browser · Esc cancel";
- an exception owed: "Say why you accept it anyway:" and a text line; Enter accepts;
- nothing owed: "y accept · Esc cancel".

After: "Accepted. The task is done." A refusal shows its own words; only a password refusal opens the password screen.

Browser: the existing plan button, Retry and Accept controls, now admitted for the local owner. The web keymap gains
`p` pressing the plan form's button, so both surfaces share it.

## Slices (one PR each, in build order)

### Slice 1: accept in the terminal (3b), and the shared pieces

`localActNow`, `localWorkEligible` (approve refactored onto it, no behavior change), the browser belt helper, the
local-owner operator road in `task complete`, the review screen, `a`/`c` through it, the accept tests. Fixes `B1.2`
(accept).

Safety self-review:
- *Check and write together:* the pin check, `reproveApprover`, `localActNow`, eligibility, acceptance and completion
  are one transaction; failure rolls back the acceptance.
- *Never widen implicitly:* no new act; `complete-task` already exists. Eligibility only narrows. `--pull-request` closed.
- *Grant files, not folders:* no grants touched.
- *Input doesn't choose what's trusted:* the owner comes from `local_mode`; run and receipt are compared to the store's.
- *Approvals mean this exact thing:* a person's check needs the explicit `--checked` on the exact pinned receipt.
- *Credentials:* none sent; the empty-password road no longer reaches the password checker.
- *Tests isolated:* `local-owner-world` homes only.
- *Real thing:* the accept journey in `first-result-e2e.mjs` must pass B1.2 in the terminal.

### Slice 2: ask for a plan

Act `request-plan`, the CLI row, the route entry, the writer checks, no pins and no mode pre-authorization for the local
owner, the TUI auto-plan on filing and `p`, the web `p`. Fixes `B1.2` (plan).

Safety self-review:
- *Check and write together:* act, eligibility, digest and `requestPlan`'s own guards in one transaction.
- *Never widen implicitly:* one new act on two named surfaces; pins and pre-authorization are explicitly refused.
- *Grant files, not folders:* the planner keeps its read-only role and clean-tree proof; nothing new.
- *Input doesn't choose what's trusted:* the digest is only compared, never adopted.
- *Approvals mean this exact thing:* a plan request seals nothing; the plan's yes is still `approve-plan`.
- *Credentials:* none.
- *Tests isolated:* yes.
- *Real thing:* the sample-project journey must reach a drafted plan with no password.

### Slice 3: retry

Act `retry-build`, the CLI row, the route entry, the approval rule, the stop proof, the limit, the TUI `r` fix. Fixes
the restart (`B1.5`) and model-error (`B1.6`) retries.

Safety self-review:
- *Check and write together:* approval rule, pins, eligibility, count and requeue in one transaction; the stop proof is
  read first and `requeueEligibility` re-reads the claim inside.
- *Never widen implicitly:* the approval is reused untouched; scope bytes are asserted unchanged in tests.
- *Grant files, not folders:* no grants touched.
- *Input doesn't choose what's trusted:* run and digest are compared with the store's; `approved_by` and basis come from
  the store.
- *Approvals mean this exact thing:* only the owner's own person yes, on work it could approve again now.
- *Credentials:* none.
- *Tests isolated:* yes.
- *Real thing:* the restart and model-error journeys must retry from `r`.

### Slice 4 (optional): chat cards and docs

In the browser's lead chat, the person's own Confirm on a lead's `retry` or `plan` task card maps to `retry-build` or
`request-plan` (`CHAT_TASK_ACTION_LOCAL_ACTS`), through the same writers. Chat bridges stay refused. Update the guide
and `docs/plans/passwordless.md`'s laptop notes.

Safety self-review: the confirm route already re-proves the person and narrows to the card's act (`withLocalAct`);
the writers are slice 2 and 3's, unchanged; the adapter-inventory table pins the two new mappings.

## Open questions for the owner

1. **Retry scope.** Only builds of your own person approval that you could approve again now, or any approved build on
   this computer? *Recommend: your own, eligible now.*
2. **Retry limit.** Three local retries per approval, then a note or a password? *Recommend three.*
3. **Browser accept.** Today the browser lets the local owner complete release, protected or coordinator results and
   open a pull request with no password. Narrow the browser to the same rule as the terminal? *Recommend yes; it only
   narrows.*
4. **"This computer only" for every local act.** The belt here covers the three new acts. Apply it to all local-owner
   rows? *Recommend yes, as its own small PR after slice 3.*
5. **Plan on filing.** Should Enter on a bigger task ask for the plan straight away, or wait for `p`? *Recommend straight
   away: the screen already promises a plan.*
6. **Chat cards (slice 4).** Build it now, or after launch? *Recommend after the first three slices ship.*

## v2 changes (Codex plan review round 1: GO WITH CHANGES)

Everything above stands except where this section says otherwise.

**Existing problems confirmed (fixed first, in slice 0):**
- (b) **High.** The browser's local-owner cookie can complete release, protected and coordinator results and open
  pull requests without a password (`route-table.ts:174`, `tasks.ts:2374/2401`, `assignment.ts:512`,
  `pull-request-flow.ts:176`). Existing release authority, distinct-person and publication-grant rules still apply,
  but no password is asked. Open question 3 becomes a requirement.
- (c) **High when the console is reachable from elsewhere.** "This computer" is checked when the local session is
  minted, not per request (`people-tokens.ts:273`, `serve.ts:983/2413`). Host, CSRF and mutation-key checks remain.
- (a) Low: an empty local password reaches `authenticateAccount`'s failure counter, but guards are per Store and each
  terminal command opens a fresh one, so presses don't accumulate. Fixed by giving local completion its own road.
- (d) Latent: local owners can't reach the plan handler today; a rows-only build would have exposed mode
  pre-authorization. Refuse local-owner pre-authorization at the shared authority boundary.
- Correction: `task retry` is an alias of `task requeue` (`task-aliases.ts:3`); today's refusal is policy, not an
  unknown command.

**Design changes:**
1. **Slice 0 (new, first): central locality and shared completion limits.** `fromThisComputer` applied centrally to
   every local-owner request (peer, Host, forwarding headers), not three route ids. Local act and eligibility checks
   in the shared completion boundaries (plain completion, `publish=1`, `acceptAndCompleteAsOperator`, and chat's
   `result_accept` → `complete-task`), and an explicit local-owner refusal in pull-request creation. Tests: every
   acceptance branch refuses a local owner on release/protected/coordinator results; refused acts leave acceptance,
   publication, approval and retry state unchanged (valid-result fixtures, not just admission).
2. **Retry:** inside the transaction, `approverStanding(store, owner, repo)` (current project access) and
   `personApprovalOf` proving the owner's exact personal seal (not `approved_by` + basis). Its own stop proof in the
   transaction (no unfinished run, durable stop facts, latest-run identity, allowed task state); expired claims alone
   prove nothing. Final results refuse in every task state, not only `done`. The limit counts per task + exact seal
   identity (a fresh approval of identical bytes is a new seal; three per seal).
3. **Plan:** bind a complete planning-source digest (`plannerContractOf` / `plannerSourceDigest`), including the
   no-scope case; reject archived tasks in the transaction. "No pins" means saved pins are not used either for a local
   request (or the request refuses while pins are saved — decide in build, test both). Any applicable existing
   `plan_authorization` is refused or disarmed in the same transaction with an audit record.
4. **Accept:** the new road is selected only for proven local-owner authority; `acceptAndCompleteAsOperator`
   independently refuses machine-origin person checks; an expired local context refuses, never falls through to full
   authority. Exact replay is recognised from the saved request binding and resulting receipt, with authority
   rechecked before returning success.
5. **Eligibility:** excluding imported issues is a behaviour change (named as such). Acceptance considers actual
   protected changes, not only declared ones.
6. **Tests added:** revoked project access, expired claim with live processes, failed-but-final results, inherited plan
   authorization, every acceptance branch, same-digest reapproval, concurrent duplicate submissions, lockout counters
   on one Store, and the real terminal path.

### Order (v2)
0. Locality + shared completion limits + local PR refusal (closes the two existing High findings).
1. Accept in the terminal (exact result, person check).
2. Ask for a plan.
3. Retry.
4. Optional: chat Confirm for a lead's retry/plan card.
