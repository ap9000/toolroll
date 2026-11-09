# Live wake-ups

Plan v2, 2026-11-09 (one Codex round: GO WITH CHANGES; the ledger is at the end). Read at `d8019ce`. Items marked *(inferred)* were not read in code.

**The "Build set (v2)" section below is what gets built. Where it differs from a slice's own text further down, the build set wins.**

## Goal

A person should not wait on a timer when the thing they wait for has already happened. Each wait below gets the smallest change that ties it to its real event. No safety check moves or loosens.

## Build set (v2)

Measured on the live service on 2026-11-09 (read-only): 12 projects, one builder with capacity 8. While idle the
worker process made about 40,000 system calls a second and used 12-34% of a core. Its wake counter did not move in
20 s, so the loop was not waking itself; the cost is the per-loop, per-lane 50 ms database polls. Slice 3 is
therefore the main idle fix, and slice 1 is a correctness fix only.

Built in this arc, in this order:

1. **Slice 1 as written.** Compare the prior status inside the same transaction; keep the timestamp refresh and
   `clearGapEpisode`; bump only on a change to verified.
2. **Slice 2, plus merge approval.** The bump goes inside the successful seal transaction. The merge approval path
   (`src/store.ts:19256`) also bumps. Fast-start and carried approvals already wake through task creation.
3. **Slice 3 as one shared poller, not a file watcher.** New `src/wake-hub.ts`: one timer per process, running only
   while something waits, reads `wakeSeq()` once every 50 ms and resolves the waiters whose baseline it has passed.
   - A waiter is `{ baseline, deadline, extra? }`; `await hub.changed(...)` resolves with why: `"wake"`, `"deadline"`,
     `"poke"`.
   - Dispatch wakes only on `wakeSeq` movement, a deadline, or a direct poke. Nothing wakes on "any commit".
   - `paused()` is re-read when the wake moves (pause and resume bump it) and at least once a second, not every 50 ms.
   - Direct pokes: the stop signal, lease loss, reconciliation recovery, and a fair-share or lane-count change.
   - Registering a waiter and reading the baseline happen together, so a bump between them is not lost; every waiter
     also re-checks at least once a second even if the counter has not moved.
   - Latency is unchanged (50 ms). Reads drop from 20 a second per loop and lane to 20 a second per process.
   - Claim and spawn fences, the lease heartbeat and lease-loss handling are untouched. The 50 ms loop only ever gave
     promptness, never permission.
   - No `fs.watch`, no `store.onCommit` dependency. A file watcher can come later if 20 reads a second still matters.
4. **Slice 4 for web push and outgoing webhooks only.** They move to their own service-level 5 s beat and run at
   once when the wake moves and rows are pending. **Opening a pull request stays where it is** (see Deferred).
5. **Slice 5 with conditions.** While a long poll is open, a 1 s check asks whether this bot has a due outbox row;
   if so the poll is aborted, at most once per cycle. The abort is told apart from a transport failure
   (`src/telegram.ts:262` turns aborts into ordinary failures today): no problem recorded, no backoff, and the
   empty-cycle padding (`:698`) is skipped for a delivery wake. Same poll owner, same generation, one connection.
   Offsets are safe: the cursor advances only after processing (`:1613`).
6. **Slice 6 without a new reader.** A 30 s service-level beat runs the *existing* `observeChecks` path, unchanged,
   only for opened pull requests whose checks are not settled or whose merge waits; at most 10 pull requests a pass.
   The 5 min pass stays and is still the only one that may set `reconciliationReady`. A failed fast pass is skipped
   and records nothing. No GraphQL batching, no new parser, so no new way to read a check as green.

As built (2026-11-09):

- Slice 1: `Store.markCapability` reads the prior status and writes in one `transact()`; it bumps only on a change to
  verified.
- Slice 2: `sealScopeApproval` bumps inside its successful seal branch (after the release authority step, so a seal
  that throws wakes nothing); `authorizeMergeIntent` bumps inside its transaction on success.
- Slice 3: `src/wake-hub.ts` (`WakeHub`, `WakePoker`, `wakeHubFor(store)`). A waiter's `until` is a cheap in-memory
  condition (stopping, a lost lease, the fair-share turn ending) checked every beat. Lease loss and reconciliation
  recovery poke the loop's poker; the stop signal pokes the whole hub. Lane-count and fair-share changes already bump
  the wake, so they need no poke of their own.
- Slices 4 and 6: `joinServiceBeats` (end of `src/operate.ts`): one delivery beat and one fast CI beat per store,
  joined by every project loop and stopped by the last to leave. The fast pass runs only while every joined loop's
  reconciliation stands, reads `fastCiWaiting` (never read, running, "none" within 30 min of an update, or green with a
  merge waiting), and passes them to `observeChecks` through a new `publications` option; the reader itself is unchanged.
- Slice 5: `followBridge` takes a high-water mark of notification ids before delivering; while the long poll is open a
  1 s check (`telegramOutboxDue`) ends it once for a newer unresolved row addressed to everyone or to a paired person.

Deferred, with the reason:

- **Opening a pull request off the tick path (slice 4).** Today the awaited tick serializes it with the first lane;
  publish pushes from the project checkout through raw `exec.run`, outside the checkout lock hardened Git uses
  (`src/publish.ts:201`, `src/teardown-git.ts:211`). It needs checkout coordination first.
- **Batched GraphQL CI read (slice 6a as first written).** `summarizeChecks` reads a non-empty list with no
  recognized failing or running state as passing (`src/pulls.ts:207`); `contexts(first:100)` could omit a failing
  check. It needs pagination, strict node validation and a head-commit match before it can be trusted.
- **The webhook hint (slice 6b).** Nothing to prove without a public address; it plugs into the beat above later.
- **Slice 7 (fewer probes, fewer `git` spawns).** Housekeeping creates tasks before the ready-set read, so an early
  readiness check can miss new work; flow triggers must still run with no card. Small gain once slice 3 lands.

## How waking works today

Loops doze by polling one integer, `Store.wakeSeq()` (`src/store.ts:22046`), every 50 ms. `bumpWake()` (`:22042`) moves it.

- **Bumps today:** task filed, state change, requeue, cancel, steer note filed or acknowledged, pause, resume, stop, decision answered, incident resolved, run sealed (`src/claim.ts:828`), follow-up check finished (`src/result-follow-ups.ts:207`), batch check finished, pull request owed.
- **Does not bump:** task approved (`sealScopeApproval`, `src/store.ts:9490`, and none of its callers), message queued (`enqueueNotification`, `:15734`), pull request opened (`:19495`), CI state recorded (`:19535`).
- **Bumps when it should not:** `markCapability` (`:13625`) bumps on every passing probe, not only when a gap fills.

Writers in other processes: the console (approvals, answers, steer, stop, web filing), every CLI command, the `up` parent. Only the worker's own writes are in-process.

## The waits

| # | Wait | Today | After | Worst case after |
|---|------|-------|-------|------------------|
| 1 | CI result on an open PR | 5 min pass, one `gh pr view` per PR, per project loop | 20 s pass, one batched call, only while a PR waits | 20 s; about 1 s with a webhook |
| 2 | Web push, outgoing webhooks, opening a PR | 45 s, and stuck behind the first lane's build | Own 5 s beat, run at once on a database change | 1 s typical, 5 s |
| 3 | Approved task starts | Up to 60 s; each pass runs `git symbolic-ref` and every probe through `sh -lc` | Approval wakes the loop; probes only when needed | 1 s |
| 4 | Flow steps | 15 s, one `git` spawn per beat | Same 15 s, no spawn when no card is active | 15 s (unchanged) |
| 5 | Release CI poll | 15 s in the release tool's own process (`src/release.ts:123`) | Unchanged | 15 s |
| 6 | Telegram reply in polling mode | Behind a long poll of up to 25 s | Wake cancels the poll | 1 s |
| 7 | More than one build | `--max` 1, but builds already run in parallel through lanes | Lanes re-checked on wake | 1 s |
| 8 | Idle cost | 20 reads a second per loop and per lane | One watcher, 1 s fallback | 1 s if a file event is lost |

## Slices

### 1. Stop the loop waking itself

`tickCommand` probes every pass (`src/operate.ts:2815`). A passing probe bumps the wake. The loop read its baseline before the pass (`:7259`), sees a move (`:7357`) and runs again at once. Lanes do the same (`:7182`, `:7219`). This is the likely cause of the 18% idle core *(inferred: the mechanism is read, the live service's capabilities are not)*.

- Change: in `markCapability`, bump only when the status changes to verified. Keep `clearGapEpisode`.
- Tests: `src/store.test.ts` (wake assertions near line 1140); `src/tick.watch.slow.test.ts`: an idle loop with a passing probe runs one pass per tick window.
- Risk: a gap that fills must still wake. Test both directions.

### 2. Approval wakes the worker

- Change: `sealScopeApproval` bumps when it really seals. One place covers the console, chat, modes and auto-approve.
- Tests: `src/store.test.ts`; `src/tick.dispatch.slow.test.ts`: approve on a second connection, build claims within a second.
- Risk: none to the approval proof. The bump comes after the seal and the claim re-proves everything.

### 3. One wake hub per process

New `src/wake-hub.ts`, copying `followWorkspace` (`src/live-bus.ts:66-111`): `store.onCommit`, plus `fs.watch` on `<db>-wal`, coalesced to one check per 50 ms, plus a 1 s fallback timer. `bumpWake` and the stop signal poke it directly.

- Change: replace the polls at `src/operate.ts:7224` and `:7379` with `await hub.changed(deadline)`. Read `paused()` on wake, not every 50 ms. Call `ensureLanes()` (`:7228`) on wake.
- Recommended over the others: `PRAGMA data_version` still needs polling; a wake file adds a write at every bump site; a socket is a new surface.
- Tests: new `src/wake-hub.test.ts` beside `src/live-bus.test.ts`; `src/up-split.slow.test.ts`: a console write wakes the worker; a stop still lands within 250 ms.
- Risks: a lost file event (covered by the 1 s fallback); the WAL file being replaced (re-arm the watcher on error and on each fallback).

### 4. Deliveries off the build path

The publish, push and webhook passes (`src/operate.ts:7297-7327`) run only between ticks, and a tick awaits its build inline (`:3721`).

- Change: move each to a `startMaintenance` beat (`src/maintenance.ts`) of 5 s, with `runNow()` on a hub change when rows are pending. Push and webhooks become one service-level beat beside the Telegram supervisor (`:13195`). Publish stays per project and keeps `admissionStopped()`.
- Tests: `src/maintenance.test.ts`, `src/publish.test.ts`, `src/push-lines.test.ts`, `src/webhooks.test.ts`.
- Risk: publish running `git` beside a build in the same checkout. Confirm before building.

### 5. Telegram: cancel the long poll

`followBridge` (`src/telegram.ts:491`) is one serialized loop: send, then `getUpdates` for up to 25 s (`:445`, `drainUpdates` `:1523`). One connection is deliberate. `wakeTelegramBridge` (`:2650`) only ends push-mode idle, in the same process.

- Change: a per-cycle `AbortController`. On a hub change, if the outbox has a due row for this bot, abort the poll. Treat that abort as an empty page: no problem recorded, no backoff. Nothing is lost, since updates are confirmed only by the next offset.
- Tests: `src/telegram.test.ts`, `src/telegram-live.test.ts`.
- Risk: abort storms. Abort at most once per cycle, and only for due rows.

### 6. CI: fast pass while something waits

There is no receiver wired to PR checks. The 5 min pass (`src/operate.ts:7015-7054`) calls `observeChecks` (`src/publish.ts:380`) then `followPullRequests`.

- Change (a): a second beat of 20 s, service-level, active only while an opened publication has checks not yet settled or a merge waits. It makes one `gh api graphql` call with one alias per waiting PR:
  `pr0: repository(owner,name){ pullRequest(number){ state headRefOid mergeCommit{oid} commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{...}}}}}} } }`
  Cost is about 1 point per call, 180 an hour against 5,000 *(inferred from GitHub's published limits)*. Results map into the shape `summarizeChecks` already reads, under the same `reserveObservation` and `settleObservation` generations.
- Change (b): with a public address, `flowHook` (`src/server/remote-hooks.ts:50`) already verifies signed GitHub `workflow_run` deliveries (`src/flow-triggers.ts:1109-1116`). A verified delivery for a repo with a waiting PR calls the same beat's `runNow()` through the hub. The webhook is a hint; the `gh` read stays the truth.
- Tests: `src/publish.test.ts`, `src/pull-request-flow.test.ts`, `src/tick.reconcile.test.ts`, `src/webhook-check-runs.test.ts`.
- Risks: a partial GraphQL error must read as "unread", never green. A failed fast pass is skipped; only the 5 min pass may set `reconciliationReady`.

### 7. Cheaper passes

- Change: in `tickCommand`, run `probeRepo` when something is ready to claim, otherwise at most once per tick window. It still runs before any claim. In the flow-steps beat (`src/operate.ts:7134`), resolve the branch only when the project has an active card.
- `--max` stays 1. A higher value only builds serially inside one pass. Parallel starts come from lanes, bounded by `maySlotTake` (`src/project-concurrency.ts:121`).
- Tests: `src/tick.watch.slow.test.ts`, `src/flow-cadence.test.ts`, `src/project-concurrency.slow.test.ts`.
- Risk: a revoked key shows as a gap up to 60 s later while nothing is ready.

## What must not change

- The watch lease and its heartbeat; a lost lease stays fatal.
- The Telegram poll lease and the single serialized connection.
- Every claim still passes `maySlotTake` (capacity, project limit, fair share), `reserveModeRail`, budget holds, and `acquireIfReady` (`src/operate.ts:3198`: quota, attention budget, capability gate, holds).
- Approval proofs: a wake only says "look"; the claim re-proves the sealed approval.
- CI: observation generations; unread or missing checks are never green; `fullCheckGate` before any merge.
- A failed reconcile pass still pauses admission.
- The stop fence before each claim and before publish.
- The release gate and the release tool's own polling.

## Not in this arc

- Release coordinator poll (item 5): fine as is.
- Slack, Discord and Teams queue: 1 s pass, 5 per pass (`src/chat-follow.ts:14`).
- Raising `--max`.
- A local socket or any new listener.
- Setup screens for a GitHub webhook.
- A second Telegram connection.

## Codex round 1 ledger (v1 → v2)

| # | Severity | Finding | Change |
| --- | --- | --- | --- |
| 1 | High | A batched GraphQL CI read can record a false green | Batching deferred; the fast pass reuses the existing reader unchanged |
| 2 | High | Publish has no serialization off the tick path | Opening a pull request stays on the tick path; only push and webhooks move |
| 3 | Medium | The wake hub needs an explicit contract; "any commit" would recreate self-waking | One shared poller keyed on `wakeSeq`, with direct pokes and a 1 s re-check; no file watcher |
| 4 | Medium | An early readiness check can miss new work; triggers need no card | Slice 7 deferred |
| 5 | Medium | Telegram abort is offset-safe with conditions | Conditions written into the build set |
| 6 | Low | Slices 1-2 sound; merge approval still unwoken | Merge approval bump added |
