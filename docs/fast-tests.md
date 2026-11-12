# Fast, deterministic unit tests (2026-10-01)

Measured on the desktop Mac that also runs the release check. Other
builds were running on the machine throughout (load average 9–28), so each
before/after pair below was run back to back at the same load. Treat small
differences as noise.

## Before and after

| | Before (`987dabe`) | After |
| --- | --- | --- |
| Unit suite wall time, `npx vitest run` | 552 s (load ≈16); 424 s (load ≈9) | 185 s (load ≈16); 152 s (load ≈11) |
| Summed file time (load ≈16) | 1,902 s | 1,217 s |
| Per-task check for a console change (`src/serve.ts`: typecheck + build + `vitest related`, 1,574 tests) | 447 s (load ≈15); 279 s (load ≈10) | 153 s (load ≈15) |
| Test names (`vitest list`) | 3,839 | 3,839, the same set |

Slowest files, same-load pair:

| Before | | After | |
| --- | --- | --- | --- |
| serve.test.ts | 240 s | desktop-update.recovery.test.ts | 61 s |
| desktop-update.test.ts | 128 s | review-context.test.ts | 53 s |
| tick.test.ts | 123 s | exec.held.test.ts | 51 s |
| toolroll-update.test.ts | 101 s | planner.test.ts | 42 s |
| project-learning.test.ts | 66 s | toolroll-update.recovery.test.ts | 41 s |
| planner.test.ts | 58 s | up.test.ts | 41 s |
| review-context.test.ts | 55 s | tick.dispatch.test.ts | 40 s |
| exec.held.test.ts | 53 s | desktop-update.test.ts | 37 s |

## What changed

- **Split by area.** This is the `fast-loop` change (`efde057b8`) redone on `987dabe`, including tests added in 0.9.7 and 0.9.8. `serve.test.ts` is now `serve.{auth,console,chat,tasks,chrome,results,workspace}.test.ts` and `tick.test.ts` is now `tick.{dispatch,reconcile,night,watch}.test.ts`. `desktop-update` and `toolroll-update` are each split in two (`*.recovery.test.ts`). Shared fixtures live in `test/serve-kit.ts`, `test/tick-kit.ts`, `test/route-fixture.ts`, `test/desktop-update-kit.ts` and `test/toolroll-update-kit.ts`. Every test is kept: `vitest list` gives the same 3,839 names before and after.
- **Fresh databases are copied, not migrated** (`test/fresh-store.ts`). Each test file builds one fresh store with the real `openStore`, and later fresh opens start from a copy of it.
- **Byte comparisons use `Buffer.equals`** in the migration tests, not `toEqual` on multi-megabyte buffers.
- **Workers: a third of the cores, at least 4.** That is 8 here.
- **Learning reads the repository once per pass.** `learningContext` and `recoverLearning` ran the same `git` commands once per lesson (identity, tree, status). Now each distinct command runs once per pass. The results are the same, and its slowest test runs in 2 s instead of 5 s.

## Fixed waits replaced

From the 30 slowest tests, and from running the suite beside the journeys:

| Test | Was | Now |
| --- | --- | --- |
| `tick.watch` dependency chain, episode and recovery watches | fixed `--for` window (12 s one flaked) | stops when its tasks are done (`shouldStop`) |
| `tick.night` `bridge telegram --follow` | 1.5 s window | stops when the answer is recorded |
| `project-concurrency`, four builder watches | 6–20 s `--for` windows plus an 8 s hold | stops when its tasks are done; the overlap hold ends 2 s after the last build started |
| `telegram-mate` watch's embedded follower | two 1.5 s windows | stops when the conversation is done and its link is sent |
| `onboarding` lead re-check | two real 4.1 s sleeps | the clock moves 4.1 s (`vi.setSystemTime`) |
| `cli-busy` lock bound | 15 s wall clock | injected `performance.now()` |
| `integrations`, `exec`, `desktop-update` lock | fixed bounds and sleeps | wait for the event |

The 30 slowest tests before the change (s, one run each; the after column is the same-load run):

| # | Test | Before | After |
| --- | --- | --- | --- |
| 1 | cli-busy: names the database when the lock is held past the bound | 15.9 | 5.1 |
| 2 | migration-v54: v53 upgrades … reopening is byte-identical | 15.8 | 1.5 |
| 3 | migration-v55: v54 keeps scopes, access grants and mode bytes | 15.7 | 1.3 |
| 4 | project-concurrency: worker capacity caps the total | 15.3 | 5.6 |
| 5 | unattended: queue twelve, sleep, wake to PRs | 14.0 | 14.8 |
| 6 | project-concurrency: a project set to one builds one at a time | 13.4 | 4.3 |
| 7 | tick: one watch drains a dependency chain | 13.2 | 3.1 |
| 8 | toolroll-update f1: a busy live database is never moved aside | 10.5 | 9.3 |
| 9–10 | task-control-adversarial: recovery retains a detached descendant (×2) | 10.2 | 10.1 |
| 11–12 | migration-v50: schema ±110 refuses and preserves bytes | 9.6 | 0.0 |
| 13 | project-learning: recovery behind 50 newer reviews | 8.7 | 8.4 |
| 14–15 | migration-v72: missing subscriptions / pairing identity refuse | 8.2 | 0.0 |
| 16 | project-concurrency: two tasks build at once | 7.0 | 5.8 |
| 17 | flow-once: three processes advance one project's flows | 7.0 | 4.1 |
| 18–20, 23–24, 26–27, 30 | exec.held: supervisor drain and fence cases (8 tests) | 5.1–6.3 | 5.1–6.3 |
| 21 | project-learning: bounded relevant context for each phase | 6.2 | 4.5 |
| 22 | project-concurrency: stopping the service mid-run | 5.9 | 2.0 |
| 25 | up: without a terminal it prints the handoff | 5.4 | 5.5 |
| 28 | supervisor.lifecycle: drain deadline | 5.2 | 5.1 |
| 29 | onboarding: no agent signed in, asks again on its own | 5.1 | 0.7 |

Tests still at the top do real work, not waits. `unattended` makes 12 builds against real git. `toolroll-update` f1 waits out SQLite's real 5 s busy timeout, which is the behavior it tests. `exec.held`, `supervisor` and `task-control` wait for the supervisor's own grace and drain deadlines.

## Beside the browser journeys

The unit suite ran three times while `flows-e2e` and every `app-e2e` group ran at once (load average 16–28). The first run was before the fixes above; the last two were on the final code.

| Run | Unit wall | New unit failures | Highest share of a test's own limit |
| --- | --- | --- | --- |
| 1 (before fixes) | 391 s | 1 (`unattended` changed-evidence: sandbox `ps`, see Limits) | project-learning bounded context 60.0 s of 60 s; unattended twelve tasks 102 s of 120 s |
| 2 | 363 s | none | 45% (exec.held escaped tool, supervisor drain) |
| 3 | 392 s | none | 61% (unattended twelve tasks, 73 s of 120 s) |

The known flakes: the tick watch window is fixed here. The export token split was fixed in 0.9.3, and the flow-steps dates in 0.9.8; neither failed in any run.

## Limits

- This host's sandbox blocks `ps` (exit 126) and setuid file modes, so 31 tests fail here the same way before and after: `coding-provider` (23), `exec.held` (4), `task-control-adversarial` (2), `mcp-cli` (1) and `unattended` "missing observation" (1). That `unattended` case passes on its own. Under load, its check outlives the first periodic process snapshot, and here that `ps` fails with EPERM and leaves an unknown process witness. The other `unattended` check cases can fail the same way. The release machine's check covers these tests.
- `unattended` "queue twelve" used 61–85% of its 120 s limit beside the journeys. It does real work and has no waits to remove.
- In every journey run, one `app-e2e` flows journey ("One-click connections") timed out on `page.waitForURL`. In one run, a "Stop a build" journey also ended failed. Both are journeys, not unit tests, and are not addressed here.
