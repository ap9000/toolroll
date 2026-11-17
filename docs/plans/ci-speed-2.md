# CI speed 2: measure, select, check, lint, cache

Status: built on branch `ci-speed2`, 2026-11-16. Not merged. Follows [ci-speed.md](ci-speed.md) (balanced shards, the
macOS lane, journeys on pull requests, superseded-run cancellation).

The goal: a pull request's CI takes less wall-clock time without proving less. The plan had five parts: measure, run
only the tests the diff can reach (backtested first), a faster type checker, oxlint, and setup caching.

## 1. Where the minutes go

From the jobs API (`per_page=100`, `filter=all`) of the last 24 completed pull request runs of `ci.yml` with every other
workflow on the same head commit (Native lanes, Journeys, Rust, Workbench bundle, Upgrade path, Wire budgets, youiyoux,
Install smoke), and the last 5 nightly runs of main. Successful jobs, latest attempt, medians (p90 where it matters), in
seconds. "Setup" is checkout, setup-node, the Linux tools, the candidate's user and its copy; queue is created → started.

| Job (pull request) | n | Queue med / p90 | Setup | npm ci | Typecheck | Build | Test step | Total med / p90 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| node 24 · macos shard i/3 | 62 | 3 / 524 | 37 | 23 | 22 | 11 | 606 | 716 / 822 |
| linux fence · sandbox-runtime (waits on native · linux fence) | 25 | 24 / 106 | 12 | | | | 479 (wait) | 516 / 660 |
| native · linux fence (`npm run test:attacks`) | 25 | 50 / 121 | 21 | 4 | | 6 | 416 | 459 / 737 |
| journeys · app (scripted) | 23 | 2 / 29 | 15 | 5 | | 6 | 334 | 402 / 438 |
| node 24 · shard i/6 | 135 | 2 / 223 | 26 | 5 | 10 | 6 | 345 | 399 / 562 |
| workbench bundle / binary · darwin-x64 | 15 | 4 / 151 | 11 | | | | 224 (cargo) | 254 / 344 |
| workbench bundle · macos-latest | 12 | 154 / 432 | 15 | 8 | | 10 | 100 + 32 | 182 / 207 |
| journeys · flows (scripted) | 25 | 2 / 3 | 17 | 5 | | 6 | 112 | 176 / 196 |
| rust · macos-latest | 15 | 3 / 303 | 7 | | | | 41 clippy + 77 tests | 141 / 171 |
| workbench bundle · ubuntu-24.04 | 15 | 2 / 3 | 36 | 4 | | 5 | 53 + 17 | 136 / 154 |
| workbench bundle / binary · darwin-arm64 | 16 | 12 / 395 | 8 | | | | 110 (cargo) | 133 / 150 |
| git 2.41 · debian trixie | 25 | 23 / 264 | 26 + 52 (git build) | 5 | | | 27 | 122 / 148 |
| upgrade path | 24 | 18 / 97 | 20 | 4 | | 6 | 78 | 116 / 167 |
| wire budgets | 16 | 2 / 18 | 13 | 4 | | | | 105 / 117 |
| rust · ubuntu-latest | 20 | 2 / 2 | 4 | | | | 23 clippy + 54 tests | 96 / 120 |
| git 2.47 · debian trixie | 25 | 32 / 108 | 27 | 6 | | | 34 | 79 / 84 |
| native · windows job object | 25 | 8 / 118 | 23 | 16 | | 9 | 23 | 77 / 83 |
| node 26 · SQLite | 25 | 2 / 193 | 19 | 4 | | | 18 | 48 / 52 |
| the joins (ubuntu-latest, macos-latest), scopes, waiters | 15–25 | 2 / 3 | 13–18 | | | | | 18–22 |

Nightly (main, every file on macOS too): macOS shards 1544–1700 s each (test step 1450–1584 s); Linux shards 376–486 s;
Node 22's floor shards alike.

**The critical path is the macOS lane.** In 16 of 17 pull request runs that finished, the last job to end was
`node 24 · macos-latest`, the join of the macOS shards (once, the Linux fence). Median wall clock, run created → last job
ended: **1036 s (17 min)**, max 2147 s. The macOS shard path is queue + ~37 s setup + 23 s npm ci + 22 s typecheck +
11 s build + ~600 s of tests.

**macOS runners are short.** Of 159 macOS jobs that started on a pull request, 42% waited over 60 s for a runner, 26%
over 5 minutes; p90 599 s, worst 2083 s. 15 macOS jobs were cancelled before any runner took them (7 of them in runs a
newer push superseded). Linux: median 2 s, p90 118 s. A pull request that touches the workbench asks for up to 8 macOS
jobs at once (3 macOS shards, `rust · macos-latest`, `workbench bundle · macos-latest`, the darwin-arm64 and darwin-x64
binaries, the macOS install smoke); two such pull requests at once exceed the account's macOS concurrency.

**Setup is not where the time goes.** npm's cache already hits (setup-node `cache: npm`, keyed on the lock file: 63 MB
restored in about 1 s, `npm ci` 5 s on Linux, 23 s on macOS). The type check is 10–11 s on Linux and 15–22 s on macOS,
in each of the 9 shard jobs. The Rust jobs have no cache at all: their minutes are cargo compiling.

## 2. Diff-reachable tests on pull requests

`scripts/ci-select.mjs` decides which unit-suite files a pull request's diff can reach. It is deterministic (same tree,
same diff, same plan) and tested (`src/ci-select.test.ts`).

**The graph.** Every file of the checkout is a node; the code under `src/`, `test/` and `scripts/` is parsed for edges:
every relative import, re-export, dynamic import, `require`, `vi.mock` and `new URL(…, import.meta.url)`, and every
string literal that names a file (`"scripts/ci-scope.mjs"`, `join(root, "test", "fixtures")`, `"console.css"`). Product
code's literals and folder URLs reach only its own data under `src/` (found in this repository's history: a report that
lists `test/ensure-build.ts`, `new URL(".", import.meta.url)` and a module that names the project's `AGENTS.md` had
linked the whole suite to everything). A test or script that names `dist` reaches the whole build. A test is selected
when it reaches a changed path, is one, or always runs.

**Always run** (200 files today):

- the attack suite, `test/attacks/**` (103 files);
- gate tests (69): `src/ci-*.test.ts`, `src/password-*` and `src/server/password-*`, `src/public-hygiene*`, the route
  and handler inventories (`src/server/route-policy*`, `handler-registry`, `get-quiet*`, `src/serve.routes`,
  `src/serve.retired`), adapters (`src/*adapter*.test.ts`), `src/server/destinations.test.ts`, and every contract test
  (`src/contracts/*.test.ts`); the wire budgets are their own workflow;
- tests whose inputs aren't imports: every test that lists a folder of the repository (an anchored path plus
  `readdirSync`/`readdir`/`opendir`/`glob`/`walk`; 28 files, from `src/up.slow.test.ts` to
  `src/server/adapter-inventory.test.ts`), and every test anchored on the checkout itself (`new URL("..", import.meta.url)`
  reaches every file). Tests that read a named file (a fixture, a workflow, a schema, README.md) reach it through the
  literal edges instead.

**Full run** (every file) when:

- the run isn't an ordinary pull request: release-* branches, main, the nightly, calls and dispatches always run
  everything;
- the diff can't be read whole or is empty, or deletes, renames, copies or retypes a source file;
- the diff touches `package.json` or the lock file, `tsconfig*`, any `vitest.config.*`, anything under `test/` but the
  attack suite's test files (setup, shared helpers, fixtures, timings), `.github/**`, `scripts/**`, `src/contracts/**`,
  the generated `src/design/**`, `Cargo.lock` or `rust-toolchain.toml`, or `THIRD_PARTY_NOTICES.md`;
- a changed file outside the inert set (`docs/`, root `*.md`, `tui/`, `design/`, `.gitignore`, `LICENSE`) is reached by
  nothing in the graph: a file read only through a computed path can't be matched to its readers, so it runs everything.

**Backtest.** The last 50 merged pull requests (#394–#446): 134 distinct `ci.yml` runs, each planned on its own head
commit and its diff from the merge base. Failures from that pull request's own runs, every attempt: 121 failed shard jobs
across 51 runs, 117 failing (run, file) pairs, read from the failed jobs' logs (a failing shard uploads no report). One
macOS shard's log was gone; nothing else was unattributed.

- **Misses: 0.** No test that failed on any run would have been skipped.
- **Mode:** 101 of 134 runs plan the full suite (43 touch `scripts/`, 33 a contract, 7 a workflow, 7 test setup or
  helpers, 4 the notices, 4 are release branches, 2 delete a source file, 1 the lock file). 33 select: 25 of them 94–96%
  of the suite, 8 (workbench-only and documentation-only changes) 23%.
- **Savings: about 4 s per run** on the slowest Linux shard (median 347 → 346 s), 257 worker-seconds of 6206 on average.
  The 8 small selections take the slowest Linux shard from 343 to 283 s, and would take the macOS lane from 597 to 407 s
  if the lane used the selection too; the other 25 selections save about 5 s.
- **Why it can't save more:** the import graph is one component. `src/store.ts` imports 124 modules, and its closure
  (through `nightly-github → release-adapters → release-gate → desktop-update → desktop-host → operate → serve`) is
  832 files; any change under `src/` that touches that component reaches ~641 tests by import alone, plus the 200 that
  always run. Coupling is also why the cheap alternative is unsafe: the same backtest with "the changed tests, the tests
  named after changed files, and the always-run set" misses **55 of the 117** failing (run, file) pairs — failures in
  this repository really do come from far away (`src/password-freshness.test.ts`, `src/up.slow.test.ts`,
  `src/evals.slow.test.ts` failing on unrelated changes). And the attack suite, always run, sets a floor of ~283 s on
  the slowest Linux shard (`test/attacks/auto-approve-green.test.ts` alone is 209 s).

**Wired, advisory.** `ci.yml` has one switch, `env: TEST_SELECTION: advisory`. Each Linux shard runs the trusted base
revision's selector before the candidate's copy is made and logs its plan; the join plans again by itself, from the
same base and diff, and writes the plan to its job summary. Under `enforce` the shard writes the files to
`.ci-test-selection` (read by `vitest.config.ts` only when `CI=true`; any copy the candidate committed is deleted first),
and the join passes `--plan` to the verifier, so "every planned file ran exactly once" still holds: the shards must run
exactly the join's own plan, no file missing and none extra (`scripts/ci-shards.mjs` `plannedFiles`). A full plan owes
every file, as today. The macOS lane is not affected. The selector only takes effect once it is on main (the shards and
the join run the base revision's copy).

## 3. The type checker

The repository already runs TypeScript's native checker: `typescript` is pinned at 7.0.2, and TypeScript 7 *is* the Go
port (`node_modules/typescript/bin/tsc` execs the platform binary from `@typescript/typescript-<platform>`); it has been
since #50 (2026-09-23). `@typescript/native-preview` stopped at 7.0.0-dev.20260707 when 7.0 shipped. So there is no
`tsgo` to add beside `tsc`: the required typecheck is already the fast one. Measured locally on the three configs:
see "Measurements after the release" below.

## 4. oxlint

Planned: oxlint 1.90.0 (2026-10-27), exact, its correctness and suspicious categories, an advisory `oxlint · advisory`
job (lint.yml), existing findings baselined per file. Not on this branch yet; see "Measurements after the release".

## 5. Setup caching

- **npm:** already cached on every Node job by `actions/setup-node` (`cache: npm`, keyed on `package-lock.json`); the
  candidate's harness copies it into the candidate's own cache (`--npm-cache`). Hit on the sampled runs; `npm ci` 5 s
  on Linux. Nothing to gain.
- **Rust:** `rust.yml` now caches `~/.cargo/registry/{index,cache}`, `~/.cargo/git/db` and `tui/target`, keyed on OS,
  architecture, `tui/rust-toolchain.toml` and `tui/Cargo.lock`, restoring only within the same toolchain. The workflow
  runs on pull requests only, and GitHub scopes a pull request's caches to its merge ref: a later push to that pull
  request starts warm, and nothing it saves can reach main, a release or another pull request. Nothing that builds or
  proves a release (`publish.yml`, `package-build.yml`, `release-candidate.yml`) restores a build cache; the only cache
  there is setup-node's npm download cache, which `npm ci` checks against the lock file's hashes.
  `src/ci-workflow.test.ts` holds both. In the backtest window 8 pull requests ran Rust 23 times: 65% of runs are a later
  push and would start warm.
- **The workbench bundle's macOS job** caches the same way for the clippy and tests it now runs (below), in their own
  target folder (`tui/target-checks`); the package's binary in that job still builds from nothing in `tui/target`.
- **The toolchain install** is 8–16 s (`rustup toolchain install`, minimal profile); caching `~/.rustup` would move
  hundreds of MB to save a few seconds. Not done.
- **Not cached on purpose:** the package build (`package-build.yml`), which publish.yml calls: a release's binaries are
  built from nothing.

## Fewer macOS jobs on workbench pull requests

The measurements show macOS starvation (section 1), so the smallest macOS job is merged into one that always runs beside
it: `rust · macos-latest` is gone, and its `cargo clippy --locked --workspace --all-targets -- -D warnings` and
`cargo test --locked --workspace` run as a step of `workbench bundle · macos-latest` (tui-bundle.yml), which starts on
every path that starts rust.yml (`tui/**`, the engine API fixtures and contract). `rust · ubuntu-latest` keeps fmt,
clippy and the tests on Linux, now a written-out job without a single-value matrix. Same coverage on both platforms;
a workbench pull request asks for 7 macOS runners instead of 8, and the bundle job takes ~120 s longer cold (~40 s warm),
off the critical path. The macOS unit lane itself is unchanged (still 3 shards, same files).

## The new critical path, and what the owner decides

Today: ~17 minutes median, set by the macOS lane (queue + ~12 minutes of job). This branch, as merged, changes none of
that by itself: the selection is advisory, and even enforced it would save ~4 s per run on Linux, whose shards already
finish minutes before the macOS lane. The Rust cache trims advisory, off-critical-path jobs.

Decisions for the owner:

1. **Enforce the selection?** After a week of advisory runs, `TEST_SELECTION: enforce` is the one-line switch. The
   backtest says it is safe (0 misses) and nearly worthless (4 s) for Linux. It only matters if the macOS lane uses it
   too (lane ∩ selection, 597 → 407 s for workbench- and documentation-only pull requests); that is a follow-up, not on
   this branch.
2. **The required typecheck** is already TypeScript 7's native checker; nothing to switch. What remains is that it runs
   in all 9 shard jobs (10–22 s each, 22 s on the macOS critical path): one typecheck job instead would save ~22 s per
   run; `src/ci-workflow.test.ts` currently requires it in every shard.
3. **Where the real minutes are:** (a) macOS runner queueing (p90 ~10 min) and up to 8 macOS jobs per workbench pull
   request — `workbench bundle · macos-latest` and `workbench bundle / binary · darwin-arm64` build the same darwin-arm64
   binary twice, and `rust · macos-latest` compiles it a third time; folding them touches the release's package build;
   (b) the store's import closure, which makes any selection reach the whole suite — splitting `store.ts`'s imports
   (124 modules, reaching `serve.ts`) is what would make diff selection pay.

## Measurements after the release

Pending: the local runs (the tests of this branch, tsc 6.0.3 against 7.0.2 on the three configs, oxlint 1.90.0's first run and baseline, cargo cold against warm) wait for the release check on the build machine to finish.
