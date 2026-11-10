# One table for deployment phases

Status: plan v1, 2026-11-09. Branch `deploy-phase-table`. First of the state-machine fixes Alex chose on 2026-11-09
(order: deployment phase, how a run ended, incoming chat message, outgoing chat part, task state).

## Goal

A deployment journal's `phase` is one of 17 words. Today seven files each keep their own list of some of those
words, and the lists disagree at `starting`. After this change one table names every phase and the one action a
stopped deployment at that phase calls for; every file reads the table; a test fails when a phase has no action or
a script writes a word the table does not know.

Nothing about what a deployment does in a normal, uninterrupted run changes.

## Today

| Where | List | Words |
| --- | --- | --- |
| `src/release-gate.ts:29` | `BEFORE_SWAP` | preparing, admission-paused, frozen, backup-verified, rehearsed |
| `scripts/deploy-recovery.mjs:14` | `PAUSED_BEFORE_SWAP` | admission-paused, frozen, backup-verified, rehearsed |
| `scripts/deploy-recovery.mjs:16` | `MIGRATION_STARTED` | migrating, migrated, start-failed |
| `scripts/deploy-recovery.mjs:17` | `RESTARTABLE` | stopped, backup-restored, + MIGRATION_STARTED |
| `src/deploy-rescue.ts:24` | `FORWARD_ONLY` | starting, started, healthy |
| `src/deploy-rescue.ts:25` | `FINISHED` | released, deployed |
| `src/deploy-rescue.ts:55,56` | inline | stopping, stopped, migrating, migrated, start-failed, backup-restored |
| `src/release-adapters.ts:75` | `FINISHES_FORWARD` | started, healthy |
| `scripts/deploy-phases.mjs:470` | inline (finish) | started, healthy |
| `scripts/deploy-phases.mjs:227,228` | inline | preparing, released, deployed |
| `src/release-next.ts:68` | `deployActionOf` | built from BEFORE_SWAP, FORWARD_ONLY, two literals; any other string is "roll-back" |
| `src/staged-runtimes.ts:66` | inline | deployed |

### The gap at `starting`

`swap()` journals `starting` right after `launchctl bootstrap` and then waits up to `HEALTH_WAIT_MS` for the new
service; it journals `started` or `start-failed` after. A deployment killed inside that wait leaves `starting`:

- `deployActionOf("starting")` is "forward": `settleDeployment` says "Finishing the deployment that was under way."
- `recoverDeploy` (`src/release-adapters.ts:527`) finishes forward only at `started`/`healthy`, so at `starting` it
  runs `--phase recover` instead.
- `recoverFailedDeployment("starting", …)` matches no list and returns null; `recoverJournal` prints "stopped at
  starting … New work stays paused" and reports not done.
- `rescueDeployment` at `starting` refuses with "Continue it forward with `toolroll release <branch>`", which is the
  command that just did the above.
- `finish()` itself refuses: "Unexpected finish phase: starting."

So every tool points at another one and new work stays paused until someone edits the journal by hand. (Read from
the code; not reproduced on a live service.)

A second, smaller hole: `deployActionOf` answers "roll-back" for any string it does not know.

## The table

One row per phase, in journal order. `action` is what a stopped deployment at that phase calls for.

| Phase | Action | Detail |
| --- | --- | --- |
| preparing | lift-pause | pause may not be in place yet; resumable under the same id |
| admission-paused | lift-pause | |
| frozen | lift-pause | |
| backup-verified | lift-pause | |
| rehearsed | lift-pause | |
| stopping | roll-back | only once the old processes are proved gone |
| stopped | roll-back | start the previous service |
| migrating | roll-back | backup first unless the previous runtime reads the result |
| migrated | roll-back | same |
| starting | forward | **new:** wait for the new service again; see below |
| started | forward | |
| healthy | forward | |
| start-failed | roll-back | backup first unless compatible |
| backup-restored | roll-back | start the previous service |
| restored | lift-pause | previous service already runs; only the pause is left |
| released | none | |
| deployed | none | |

Each row also carries the flags today's lists encode, so no list is kept by hand:
`beforeSwap` (BEFORE_SWAP), `pausedBeforeSwap`, `migrationStarted`, `restartable`, `finishesForward`, `finished`.

`deployActionOf(word)` becomes a lookup: a non-string or a word that is not in the table is "refuse".

Note on `restored`: today `deployActionOf("restored")` is "roll-back", and the roll-back road (rescue → recover
script) is what lifts the pause there. The table keeps that road for `restored` (action stays "roll-back" in code if
changing it would alter which function runs); the row above describes the effect. The builder keeps today's road
and records the choice in the table's comment. No behaviour change at `restored`.

## Where the table lives

The deploy scripts run from the candidate's checkout as plain `.mjs`; `src/` compiles to `dist/` and cannot import
from `scripts/` (`tsconfig` includes only `src/**`, and the scripts are not shipped in `dist`). So:

- `scripts/deploy-phase-table.mjs`: the table and its helpers, imported by `deploy-recovery.mjs` and
  `deploy-phases.mjs`.
- `src/deploy-phase.ts`: the same table, typed (`DeployPhase`, `DeployAction`), imported by `release-gate.ts`,
  `deploy-rescue.ts`, `release-next.ts`, `release-adapters.ts`, `staged-runtimes.ts`.
- `src/deploy-phase.test.ts` imports both and fails unless they are equal row for row. It also:
  - fails if any phase has no action;
  - scans `scripts/deploy-*.mjs` for `save(r, "<word>")` and `mark("<word>")` and fails on a word not in the table,
    and on a table phase that no script writes;
  - checks each old exported list name still equals what the table derives (`BEFORE_SWAP`, `FORWARD_ONLY`,
    `PAUSED_BEFORE_SWAP`, `MIGRATION_STARTED` stay exported, derived, so nothing else needs to change).

Two copies kept equal by a test is weaker than one file. It is the price of scripts that must run without a build.
Alternative considered: the scripts load the table from the staged runtime's `dist` (as they already load
`store.js`). Rejected: recovery runs "the recorded commit's own script" and must work when the staged runtime is
missing or damaged.

## Closing the gap at `starting`

In `scripts/deploy-phases.mjs`:

1. Move the wait-and-decide block of `swap()` (after `save(r, "starting")`: wait up to `HEALTH_WAIT_MS` for
   `service(nextDist)`, then either the failed-start teardown ending in `save(r, "start-failed")` and the refusal,
   or `r.newService = live; save(r, "started")` and the coding backup) into one function `awaitStart(r)`.
   `swap()` calls it. No statement in it changes.
2. `finish()` accepts `starting` as well: at `starting` it calls `awaitStart(loadPhase("starting"))` first. If the
   new service is up, the journal moves to `started` and finish goes on as today. If it is not, `awaitStart` does
   the same teardown a fresh swap does and journals `start-failed`; the existing recovery then rolls back (backup
   first when needed) exactly as it does for a start that failed inside `swap()`.
3. `src/release-adapters.ts` `recoverDeploy` finishes forward at every phase whose table action is "forward"
   (so `starting` too) instead of its own two-word list.

`awaitStart` after a kill is safe to run again because every step in it either observes (`service`, `launchctl
print`, process tree) or is the same teardown the first attempt would have run; nothing in it assumes it is the
process that ran `bootstrap`. The failed-start branch's `requireTrue(launch.status !== 0 || failedPid > 1, …)`
still refuses when the service's identity can't be read, leaving the journal at `starting` with a message that now
names the real next step.

Messages: `rescueDeployment`'s refusal at a forward phase keeps its words (they become true). `recoverJournal`'s
"stopped at <phase>" line is unchanged.

## What must not change

- The order of journal writes in an uninterrupted deployment and every proof before each write.
- What recovery does at every phase other than `starting`.
- A historical journal never authorizes stopping a current service (`stopProved` asked only at `stopping`).
- The pause is lifted only by its owner (`updateGateOwned`).
- No new way to move a journal backwards.

## Safety self-review (AGENTS.md), to be re-run on the build

- Check and write together: `awaitStart` re-observes the service before each journal write; `finish()` re-reads the
  journal under the deployment lock (`checkpoint()`), as today.
- Never widen implicitly: an unknown phase word now refuses instead of rolling back.
- Don't let input choose what's trusted: the journal's phase picks a row of a fixed table; it cannot add an action.
- Approvals: finishing forward at `starting` proves the candidate first (`proveCandidate`), as at `started`.
- Tests never touch the person's real setup: the new tests use the existing fake worlds (no launchctl, no real
  service label, no real state folder).
- Prove it against the real thing: a real deploy killed at `starting` is not something the suite can do; the
  release check's own deployment is the only live proof, and it does not stop at `starting`. Say so in the PR.

## Tests

- `src/deploy-phase.test.ts` (new): the table checks above.
- `src/deploy-recovery.test.ts`, `src/release-next.test.ts`, `src/deploy-rescue.test.ts`,
  `src/release-adapters.test.ts`, `src/release-gate.test.ts`: existing cases must pass unchanged; add
  `deployActionOf("no-such-phase") === "refuse"`, and `recoverDeploy` at `starting` runs `--phase finish`.
- A `finish()` at `starting` case beside the existing swap/finish tests (find the file that drives
  `deploy-phases.mjs` with fakes): service up → journal reaches `started` then finishes; service never up →
  journal reaches `start-failed`, recovery restores the previous service and lifts the pause.
- Guard tests and typecheck. Full suite in GitHub CI.

## Not in this arc

- Changing recovery at any other phase, or any wording.
- The Mac app updater's journal (`src/toolroll-update.ts` `RuntimePhase`), a different machine with its own list.
- The other four state machines.

## Size

About 150 lines changed across 7 files plus two new small files and tests. Ships alone, in its own release.
