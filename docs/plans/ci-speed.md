# CI speed: balanced shards, a macOS lane, journeys on pull requests

Status: built on branch `ci-speed` (PR #296), 2026-11-03. Not merged.

The goal: a pull request's CI and the release check take less wall-clock time, and prove no less where it matters.

## Measurements (before)

PR run 41634514443 (ui-waves-bcd), from the jobs API and the shards' uploaded Vitest JSON reports:

- Queue 2–10 s, setup about 40–60 s per job. The test step dominates.
- Linux shards (4, 3 Vitest workers each): 243–470 s. macOS shards (4, 2 workers each): 553–1040 s. Whole run about
  19 minutes, set by macOS shard 2/4.
- Files add up to 3838 s on Linux and 5280 s on macOS. The slowest file, `test/attacks/auto-approve-green.test.ts`
  (244 tests, each a real release fixture and repository), took 423 s on Linux and 884 s on macOS: alone it put one
  macOS shard past 15 minutes, whatever the split. Vitest's `--shard` splits by a hash of paths, so the slow files
  landed unevenly (macOS shard 2/4 had 1786 s of files, shard 4/4 942 s).

## What changed

1. **Timing-balanced shards.** `test/timings.json` holds each file's own time per platform (from a run's shard
   reports: `node scripts/ci-timings.mjs refresh --run <id>`). `test/shard-sequencer.ts` is Vitest's sequencer with
   `shard()` taking the files the plan (`scripts/ci-timings.mjs planShards`: longest first, each to the shard that
   finishes soonest) gives shard i, and `sort()` starting the longest files first. The plan depends only on the file
   list, the timings and the shard count, so every shard job computes the same one; the join still checks every file
   ran exactly once, so a plan that went wrong fails, it never drops a file. Linux: 6 shards (the estimate falls from
   about 420 s to about 225 s per shard; 8 would save little more for two more jobs' setup).
2. **The slowest files.** `auto-approve-green.test.ts` is split in two files (`auto-approve-green-scope.test.ts`
   holds codex r1 #2's change classes, about half its time) over a shared world, `test/auto-approve-world.ts`: the
   same 244 tests and 287 assertions. Its per-test cost is the plane's own verified git reads (about 40 git processes
   per sealed check), product code, not the test. `src/acp-check.slow.test.ts`'s never-starting stop step waited out
   the product's 60 s window; the test now passes a 3 s window (`stopWaitMs`, test-only) — the same proof, 59 s less.
   The other slow files (landed-cleanup, release-carry, unattended, tick.dispatch, planner, up) already run on fake
   clocks; their time is real git, real builds and real processes.
3. **A macOS lane.** On a pull request the macOS shards run only what can behave differently on a Mac
   (`scripts/ci-shards.mjs` LANES.macos): the attack suite's fences, checkouts, pools and git views; files named for
   fences, sandboxes, launchd, the daemon, containment, the keychain, the desktop app, install, links, worktrees, git and
   paths; any file whose text names `darwin`, `process.platform`, Seatbelt, `sandbox-exec`, launchd, TCC, the keychain
   or `/private/var`; and a smoke set. About 155 of 638 files, about 1380 s of macOS time, in 3 shards. Linux runs
   every file. The verifier judges the lane with its own (trusted base) policy, `--lane macos`; the nightly passes
   `macos_lane: all` and still runs every file on macOS. `src/ci-shards.test.ts` pins every Seatbelt and OS-fence
   native attack and the key Mac files into the lane, and fails on a stale listed path.
4. **Scripted journeys on pull requests.** `journeys.yml` runs `app-e2e.mjs` and `flows-e2e.mjs` with
   `--journeys scripted` (no model calls), their groups side by side, each group its own world. Advisory: its checks
   are in `ADVISORY_PR_CHECKS` by name and workflow, so a release neither waits for them nor fails on them; the release
   check still runs every journey.
5. **Superseded runs.** `ci.yml` and `journeys.yml` cancel an ordinary pull request's older run when a newer push
   arrives. A `release-*` branch's runs, main-push, nightly and every call get a group of their own run id, so nothing
   cancels them. No path filters: the unit joins are required checks, and a required check must report success, never a
   skip; the area lanes already skip on a documentation-only pull request.
6. **The release check.** On a busy machine the check runs its parts one after another (`checkBudget` sequential).
   Each part now takes the whole budget while it runs — units `free - 1` workers, then the app and flows journeys'
   lanes, then the upgrade workers — instead of the share it would have had running beside the others. Never more than
   `free` at once. At load 13 on 24 cores (0.9.87's check) that is 4 unit workers instead of 2, and 2 app and 2 flows
   lanes instead of 1 each. The unit part also gets the longest-first order.

## Check names

Required checks are unchanged: `node 24 · ubuntu-latest` and `node 24 · macos-latest` (and Node 22's) are still the
joins. Only the shard jobs' names change (`node N · shard i/6`, `node N · macos shard i/3`); they are not required. New
advisory checks: `journeys · app (scripted)`, `journeys · flows (scripted)`. Branch protection needs no change.
