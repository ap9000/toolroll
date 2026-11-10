# One door for task state

Status: plan v2. Version 1 was reviewed (NO-GO, 7 findings). The review showed that the writes with no
from-check are load-bearing today, so narrowing them is a design change, not a tidy. This version ships the door
and the table with **no behaviour change**, and lists the narrowing as separate decisions.

## The problem

A task is in one of five states: `queued`, `running`, `done`, `failed`, `cancelled` (`TaskState`, `src/store.ts`).
Nothing says which moves between them are allowed, and the state is written with hand-written SQL in
`src/claim.ts`, `src/store.ts`, `src/fallback.ts` and `src/vanished-retry.ts`. To learn what can move a task, you
have to find and read every statement.

## What this change does

### 1. One table, one function (no behaviour change)

New file `src/task-moves.ts` (imports nothing from `store.ts`; takes the database handle). The table records what
each writer does **today**, exactly:

| Move | To | From today | Writers |
| --- | --- | --- | --- |
| `requeue` | `queued` | `running` | `claim.ts` (3 statements), `vanished-retry.ts`, `fallback.ts` |
| `giveUp` | `failed` | `queued`, `running` | `vanished-retry.ts`, `fallback.ts` |
| `retry` | `queued` | `failed`, `queued`, `done` | a person's Retry (`store.ts`) |
| `reopen` | `queued` | `cancelled`, `failed`, `queued` | tracker reopen (`store.ts`) |
| `complete` | `done` or `failed` | any | `completeFenced` (`claim.ts`) |
| `exhaust` | `failed` | any | strikes used up, build and scouting (`claim.ts`) |
| `set` | any but `cancelled` | any | `Store.setTaskState` (`task state`, `backend.setState`, `claimCommand`, `release`, `sealScout`, `acp-check.ts`, `demo.ts`, `lead-answer-eval.ts`) |

```ts
/** Move one task. One statement: the from-check and the write together. True when the row changed. */
export function moveTask(db, id: string, move: TaskMoveName, now: Date, to?: TaskState): boolean
```

`moveTask` runs `UPDATE task SET state = ?, updated_at = ? WHERE id = ?` plus `AND state IN (…)` when the move has
a from-list. The three "any" moves are marked `from: "any"` in the table with a comment that says why they are
wide today (see "Decisions not taken here").

- `Store.setTaskState` keeps everything else it does in its transaction (the tracker latch check, the lifecycle
  notes, superseding pending steering, the wake); only its one UPDATE becomes `moveTask(…, "set", …, state)`.
- The tracker reopen keeps its read of the state for the `bad-state` answer and also gets the from-list in the
  statement (same transaction, same result).
- `cancelled` keeps its own door, `applyCancellation`. `moveTask` refuses to write `cancelled`.
- Task creation (`INSERT … 'queued'`) is not a move.
- The three old migrations in `store.ts` keep their literal SQL: migrations are frozen history.

A source test walks non-test `src/` and fails if an `UPDATE task SET … state` exists anywhere except
`src/task-moves.ts`, `applyCancellationLocked`, and the three named migration statements.

### 2. Two named answers to "is it running" (no number changes)

The same file exports the SQL for the two questions the code asks, each with a comment saying what it means:

- `claimedNowSql`: a runner holds a live claim on it (not released, not expired, newest generation). This is what
  `coordinator.ts` uses for its total. It is ownership, not proof that a process is alive.
- `markedRunningSql`: the stored state is `running`. Used by the per-project rows, `projectPeek` and the lead's
  summary.

Each existing query uses the named fragment for the meaning it already has. No count changes.

## Decisions not taken here (each changes behaviour and needs its own yes)

From the review of version 1:

1. **Should a claim be refused on a closed task?** `acquire` never looks at the task's state, so a claim can be
   granted on a `failed`, `done` or `cancelled` task, and `claimCommand` then writes `running` over it. Only
   `acquireIfReady` requires `queued`. Narrowing the write without deciding admission would leave a live claim on
   a closed task. Check cleanup (`acp-check.ts`) claims this way on purpose.
2. **Should a late result leave a closed task alone?** `completeFenced` writes `done`/`failed` over anything. A
   from-check alone is not enough: the caller still treats the completion as accepted (records success, may
   authorise a check and a publication). Refusal has to be defined for those effects too.
3. **Strikes used up on a closed task.** Today it marks the task `failed`, opens an incident, adds a hold and
   tells the person to retry, even if the task is already `done` or `cancelled`. Skipping all four together looks
   right, once it is shown this can really happen.
4. **One count for "running".** The total and the per-project rows can disagree for a task marked `running` with
   no live claim. Switching everything to live claims would drop work whose process is still alive after its
   claim expired. This needs a third fact (a live process) before the numbers can be made one.
5. **`release` in `operate.ts`** releases the claim and then requeues in two steps; another runner can claim in
   between.

## Safety review (AGENTS.md)

- Check and write together: every move is one statement; nothing that was one statement becomes two.
- Never widen: every from-list is copied from today's statement. A test pins each list.
- No change to who may cancel, approve, retry or claim; no schema change; no migration.
- Tests use temp stores only.

## Tests (contracts and data integrity only)

- For each move with a from-list: allowed from each listed state; refused (row untouched, `false`) from every
  other state. For the "any" moves: allowed from all five.
- `moveTask` refuses `cancelled` as a target and an unknown move.
- The source test above.
- Existing suites that cover the writers (claim, fallback, vanished retry, external dispatch, task state verb)
  must pass unchanged.
