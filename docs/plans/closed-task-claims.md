# Closed tasks: claims, used-up strikes, and the CLI release

Status: plan v2, built on branch `closed-task-claims`. v1 was reviewed (NO-GO, 8 findings); the ledger at the end
says what v2 does with each. Builds on `docs/plans/task-state-moves.md` (`src/task-moves.ts`, `TASK_MOVES`,
`moveTask`). The owner decided that plan's "Decisions not taken here" numbers 1, 3 and 5:

- **A.** A claim is refused on a closed task, checked in the same transaction as the grant. Check cleanup gets a
  named exception only it can use.
- **B.** When strikes are used up on a task that is already closed, skip all four effects together (state write,
  incident, hold, notification).
- **C.** The CLI `worker release` releases the claim and requeues the task in one transaction.

"Closed" means `done`, `failed` or `cancelled` (`ClosedState`, end of `src/store.ts`).

## 1. Every road that grants or renews a claim

One statement grants a claim: the `INSERT OR IGNORE INTO claim` in `acquireLocked` (`src/claim.ts`). It is reached
only through four wrappers, each inside `inTransaction` (`store.transact`, `BEGIN IMMEDIATE`, re-entrant):
`acquire`, `acquireForCheck`, `acquireIfReady` and the new `acquireForCheckCleanup`. A source test pins that list.

Production callers:

| Road | Call | Task states it can meet | After this change |
| --- | --- | --- | --- |
| CLI `claim <id>` | `acquire` | any; a built-in id with no task row is refused before (`unknown-task`) | closed refused (`closed` + state) |
| Unattended pass (builder, planner, scout, fallback turn, sweeps, mirrors) | `acquireIfReady` | only `queued` with a built-in row (`taskReadinessBlocker` answers `unknown-task`/`not-ready` first) | unchanged |
| ACP check, first claim | `acquireForCheck` | `queued`, created just before | unchanged in practice |
| ACP check cleanup | `acquireForCheckCleanup` (was `acquire`) | any, on purpose | the named exception (§3.3) |
| Demo, building card | `acquire` | `queued`, created just before | unchanged |
| Demo, approved plan's first stage | `acquire` | `queued`; a visitor could cancel in between | stops cleanly on `closed`/`no-task` (§3.5) |

Renewal is a second road: `heartbeat` extends any unreleased, unsuperseded claim **without checking `expires_at`**, so
it can bring an expired claim back to life (finding 1). §3.2 closes it for closed tasks.

Not grants: the reviewer (a made-up `review:` lease, no claim row); repair and correction turns (prove the parent's
live claim); standalone `build` (uses the current claim or none); parked resume and fallback moves (the next claim is
the pass's); lead sweeps and mirrors (gates inside `acquireLocked`); assignment `claim` (another table); reap and
runner recovery (release only). Among these, the reviewer works on `done` tasks without a claim; it is the only
caller besides check cleanup that touches closed tasks, and it needs no claim, so no **other** caller needs a claim
on a closed task.

## 2. What the database knows about a task

Inside the grant transaction, `taskStateForClaim(store, taskRef)` (end of `src/store.ts`) answers one of:

- **built-in, row present, open** (`queued`, `running`): grant as before.
- **built-in, row present, closed**: refuse `{ ok: false, reason: "closed", state }`.
- **built-in, row missing**: refuse `{ ok: false, reason: "no-task" }`. Inventory: no production road reaches this
  today (the CLI checks the row first, the pass needs the row, the check and the demo create the task first), and no
  existing test claims a bare built-in reference: every test file that calls `acquire` or `acquireForCheck` passed
  unchanged (0 setup sites to fix).
- **another backend**: unchanged. That task's state lives in its own tracker, not in this database, so this change
  cannot check it in the same transaction as the grant, and adds no remote read. **This is a limit of this change**,
  not a claim that such a task is never closed (see "Decisions for the owner"). Tracker mirrors are built-in tasks
  and are covered; their own `external` gate still answers first.

## 3. Decision A

### 3.1 The rule in `acquireLocked`

After the live-claim check and before the generation is computed: for a built-in reference, read
`taskStateForClaim`; `missing` → `no-task`; closed and `closed === "refuse"` → `closed` with the state. Every older
refusal (unauthenticated, draining, unplaced, unauthorized-repo, watch-custody, coordinator-filed, archived,
reserved, external, mode-ended, sweep-limit, held) answers exactly as before; the new answers only replace what would
have been a grant. The read and the insert are in one `BEGIN IMMEDIATE` transaction, so no other connection can change
the state between them (proved by a two-connection test). A refusal is not recorded for replay; a replay of an earlier
grant still returns that grant and writes nothing new (open question 6, kept).

`AcquireResult` gains `{ reason: "closed"; state }` and `{ reason: "no-task" }`.

### 3.2 Heartbeat (finding 1)

`heartbeat` now returns `HeartbeatResult = FenceResult | { ok: false; reason: "closed"; state }`. In its own
transaction, before the renewal, it reads the claim: if it is unreleased, the newest for its task, **already expired**
(`expires_at <= now`), and its built-in task is closed, it is not renewed and the answer is `closed` with the state.
A live claim, and an expired claim on an open task (or a missing row, or another backend), renew exactly as before.

Callers: `builder.ts` (8 sites), `scout.ts` (4), `planner.ts` (3) and `acp-check.ts` (1) only test `.ok` and treat
any refusal as "the lease did not survive" (fenced): the new reason stops the work, it is never read as success. The
one caller that reads the reason, CLI `heartbeat` (`leaseCommand`), gets its own `closed` branch (exit 3, `state` in
the JSON). There is no exhaustive switch over these reasons.

Check cleanup never needs an expired renewal: its `ours()` checks `currentLiveLease(ref) === claim` before every
`heartbeat`, so an expired cleanup claim fails that check first and the next pass re-acquires through the cleanup
door (§3.3). (If a claim expired in the milliseconds between the two calls, the heartbeat refuses and cleanup retries
next pass: fail closed.)

### 3.3 The cleanup exception

`acquireLocked` takes a fifth parameter, `closed: "refuse" | "check-cleanup"`. It is not an `AcquireOptions` field, so
no options object (CLI flag, HTTP body, chat, MCP argument, environment, file) can carry it. Three wrappers pass the
literal `"refuse"`.

`acquireForCheckCleanup(store, checkId, attempt, runner, options)` (end of `src/claim.ts`), in one transaction, proves
with `checkCleanupTaskOf` (end of `src/store.ts`) that `acp_check_request` row `checkId` has `runner = ?`, `state IN
('passed','failed')`, `settled_at IS NULL`, `settle_by = attempt`, `settle_until > now`, and that its `task_ref` is the
built-in task named `'agent-check-' || id` from the row's own id. Only then it calls `acquireLocked(…,
"check-cleanup")`; all other gates still apply. When the proof fails it answers as an ordinary claim on the row's
bound task would (`"refuse"`), or `no-task` when nothing is bound: never wider. `task_ref` is written once by
`bindAcpCheck`; the attempt id is random bytes made in code. `src/acp-check.ts` calls it instead of `acquire` and no
longer imports `acquire`. A source test pins that only `src/acp-check.ts` imports it, that the literal appears only in
`acquireLocked` and `acquireForCheckCleanup`, and that `AcquireOptions` has no such field.

### 3.4 CLI `claim`

Grant and `running` are one transaction (`claimAndMarkRunning`, end of `src/operate.ts`): on a fresh grant of a
built-in task, the new move `claim` (`to: "running"`, `from: ["queued","running"]`) then `bumpWake` (everything
`setTaskState(…, "running")` did). If the move misses, it throws and the grant rolls back with it. A replay keeps the
old narrow repair inside the same transaction. Another backend's id is never written in the built-in table (open
question 3, built as recommended).

Refusal words (exit 3, JSON `reason: "closed"`, `state`), each command checked:

- **failed**: ``<id> is failed, so it can't be claimed. To run it again: `toolroll task requeue <id>` `` (requeue
  accepts a failed task).
- **done**: the requeue line only when `requeueEligibility` (the store's own check, now shared with `requeueTask`)
  says it would be accepted (a rejected last result, or an open incident). Otherwise:
  ``… See its result: `toolroll task show <id>` ``.
- **cancelled**: ``… To run it again, reopen it: `toolroll task state <id> queued` `` (the `set` move reopens a
  cancelled task; `task requeue` refuses it). A cancelled tracker mirror never reaches this: `external` answers
  first and says to reopen it in the tracker.
- `no-task`: `` no task `<id>` `` (not reachable from the CLI, which refuses `unknown-task` first).

`claim` gains `closed` in its notable reasons, and `heartbeat` too.

### 3.5 Demo (finding 8)

In `src/demo.ts`, an approved plan's first stage that gets `closed` or `no-task` starts no run, writes no state, and
stops advancing that exchange (`enterStage` returns false). Other refusals keep the made-up lease as before.

## 4. Decision B

`exhaust` narrows to `from: ["queued","running"]`. In `sealFailure` and `sealScoutFailure`, at the stall (strikes =
3), the state is written **first**, by `exhaustUnlessClosed` (end of `src/claim.ts`), inside `finalize`'s one
transaction:

1. The task is the run's own: `refForId(run.taskRef)`. A supplied `taskId` that is not that reference's id throws,
   as `openAttempt` throws on a caller defect, and the whole seal rolls back.
2. Another backend: no built-in write (today's code wrote any built-in row sharing the id); the stall goes on.
3. `moveTask(…, "exhaust")` true: the incident, hold and notification follow as before; disposition `stalled`.
4. False: read the state in the same transaction. Closed → skip all three and return
   `{ ok: true, disposition: "closed", strikes, state }`. Row missing → today's behaviour (incident, hold, page).

In every case the run's outcome (`failed`, with its class), the claim's release and the strike are still recorded.
`FailureDisposition` and `ScoutFailureDisposition` gain the `closed` arm. `Disposal`'s `failed` case in
`src/dispose.ts` carries `closedState` (typed, null unless `closed`), so the pass's line in `src/operate.ts` prints
the sealed state: `… — the task was already <state>, so it stays <state>`.

Reachable because `task state`, `task add --replaces` and `backend.setState` close a task with no live-claim check
(question 5, not built).

## 5. Decision C

`releaseToQueue` (end of `src/operate.ts`), one `store.transact`: `release` (joins); on a refusal or a duplicate,
return it and write nothing; for a built-in task that is `running`, `setTaskState(…, "queued")` (keeps the "Back in
the queue" note). The release's compare-and-swap won only if this lease is the newest generation, so in the same
transaction no other runner holds the task. `release` does not require an unexpired lease (`releaseAs` has no expiry
predicate): an expired but unreaped, unsuperseded lease still releases and requeues; a reaped or taken-over one is
fenced.

A duplicate release changes nothing (open question 4, built as recommended). The old two-step partial case
(released, the process died before the requeue, the task left `running` with no claim) is no longer repaired by a
retried `worker release`. Nothing repairs it on its own: `reap` releases only unreleased expired claims
(`src/claim.ts` `reap`), and runner recovery (`releaseClaimsOf`, `recoverIncarnation` in `src/store.ts`) acts only on
unreleased claims. A person recovers it with `toolroll task state <id> queued`, or any runner can claim it again
(`running` is open) and release it. Tested.

## 6. Changes to `TASK_MOVES`

| Move | From before | From after |
| --- | --- | --- |
| `exhaust` | any | `queued`, `running` (two callers, both §4) |
| `claim` (new) | — | `queued`, `running` (used only by CLI `claim`) |
| `set`, `complete` | any | any (unchanged) |

No schema change, no migration.

## 7. Safety review (AGENTS.md), applied to the diff

- **Check and write together.** A: the state read and the claim insert are one `BEGIN IMMEDIATE` transaction, and the
  CLI's `running` write joins it through a guarded move. Heartbeat: the expiry/state read and the renewal are one
  transaction. B: the from-check is in the `exhaust` statement; the incident, hold and page follow its yes in the same
  transaction. C: release, read and requeue are one transaction.
- **Never widen implicitly.** `exhaust` narrows; `claim` is narrower than the `set` it replaces for that caller. The
  only road that may claim a closed task is named, takes a fixed literal no options object carries, and is proved
  against code-written rows; a failed proof answers as an ordinary claim.
- **Grant files, not folders.** No file or folder access changes.
- **Don't let input choose what's trusted.** The cleanup task comes from `acp_check_request.task_ref` and the name
  derived from the row's own id; the attempt id is made in code. No CLI flag, HTTP field, chat message, MCP argument,
  environment variable or file reaches it.
- **An approval means a person's yes to exactly this.** No approval is created, consumed or reinterpreted. Path 2
  never reaches the new check, so a refusal never spends a mode rail.
- **Credentials go only where they belong.** The runner credential is still proved first; an unauthenticated caller
  learns nothing about task state (tested).
- **Tests never touch the person's real setup.** Temp stores and temp directories only; no HOME config, no port.
- **Prove it against the real thing.** Real SQLite files, the real `acquire`, `heartbeat`, `finalize` and
  `runOperate`, and second real connections for the lock proofs. Nothing in the rule is mocked.

## 8. Tests

New `src/closed-task-claims.test.ts` (32 cases): refusal per closed state with nothing written (claim, task row,
mutation); open states and takeover unchanged; older refusals win; `no-task` and another backend; the claim lock proof
(second connection gets SQLITE_BUSY from inside the grant); heartbeat revival per closed state with the close made
from a second connection, and live/open renewal unchanged; the cleanup door per closed state, its refusals (wrong
attempt, runner, lapsed hold, settled, task not named from the id), and the source pins; build and scout stall per
closed state (state and `updated_at` unchanged, no new incident/hold/notification, run failed, claim released, 3
strikes), an open stall unchanged, a mismatched task id rolling everything back; CLI refusal words per state, claim
grant + running rollback seam, heartbeat `closed`, the release/requeue single commit with a second connection
(uncommitted release unseen, write lock held), duplicate release no-op after another runner claimed, the old partial
case, and a queued task's release.

Updated: `src/task-moves.test.ts` (from-lists; the "exhaust from every state" tests removed, the guarded loop now
covers `exhaust` and `claim`), `src/store.test.ts` (claim before the failed write), `src/contracts/cli.test.ts`
(a closed refusal with its state validates), `test/fixtures/cli/envelopes.txt` (the two notable-reason lists; edited
to match and proved byte for byte by the snapshot test, since no regeneration command is documented),
`src/password-freshness.test.ts` (tripwire pins: the cleanup call's new name, and operate.ts indices shifted by the
removed one-line `refExternalId` helper).

## 9. Not in this change

Whether a late result should leave a closed task alone (`completeFenced`); one count for "running".

## Decisions for the owner

1. **Strike, backoff and "retry n/3" page below the limit on a closed task** (v1 question 1). Today a failure with 0–1
   strikes on a closed task still adds a strike, a backoff hold and a "retry" page. Recommendation from v1: skip the
   hold and page (the strike can stay as history). Not built.
2. **Closing roads under a live claim** (v1 question 5). `task state`, `task add --replaces` and `backend.setState`
   close a task while it is being built; `cancelTask` refuses. Make them refuse too? Not built. Decision B makes the
   stall correct either way; late completion stays out of scope.
3. **Tasks of another backend.** Their state is in their tracker, so this change cannot refuse a claim on a closed
   one in the same transaction. Options: restrict CLI claims to built-in tasks and mirrors, or keep a local
   authoritative state for them. Not built.

## Ledger: v1 review findings

| # | Finding | v2 |
| --- | --- | --- |
| 1 | HIGH: heartbeat revives an expired claim | Built: an expired claim on a closed built-in task is not renewed (`closed` + state), in the heartbeat's transaction; callers checked; cleanup never renews an expired claim (§3.2). |
| 2 | HIGH: missing and outside state fail open | Built: four cases (§2); missing row refused `no-task` (0 production roads, 0 test sites); another backend unchanged and stated as a limit + owner decision. Corrected the "vanished row" and "no other caller" claims. |
| 3 | MEDIUM: refused `exhaust` ≠ closed | Built: identity from `run.taskRef`, mismatch throws and rolls back; closed → typed `closed` disposition with state; missing row → today's stall (§4). |
| 4 | MEDIUM: wrong recovery command | Built: failed → requeue; done → requeue only when the store's eligibility check accepts, else `task show`; cancelled → `task state <id> queued` (§3.4). |
| 5 | MEDIUM: state not carried to the message | Built: `Disposal.failed.closedState`, printed from the sealed value (§4). |
| 6 | MEDIUM: verification changes incomplete | Built: the named test, fixture and contract updates (§8). |
| 7 | LOW: duplicate release loses old recovery | Kept duplicate no-op; partial case documented with its recovery and tested; expiry statement corrected (§5). |
| 8 | LOW: demo fallback hides the refusal | Built: the stage stops cleanly on `closed`/`no-task` (§3.5). |
