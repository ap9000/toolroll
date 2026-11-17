# CI speed 2: measure, select, check, lint, cache

Status: built on branch `ci-speed2`, 2026-11-16. Not merged. Selection advisory on both lanes; oxlint advisory. Follows [ci-speed.md](ci-speed.md) (balanced shards, the
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

**Always run** (192 files today):

- the attack suite, `test/attacks/**` (103 files);
- gate tests (69): `src/ci-*.test.ts`, `src/password-*` and `src/server/password-*`, `src/public-hygiene*`, the route
  and handler inventories (`src/server/route-policy*`, `handler-registry`, `get-quiet*`, `src/serve.routes`,
  `src/serve.retired`), adapters (`src/*adapter*.test.ts`), `src/server/destinations.test.ts`, and every contract test
  (`src/contracts/*.test.ts`); the wire budgets are their own workflow;
- tests whose inputs aren't imports: every test that walks the repository (19 files) — it lists a folder (readdir,
  opendir, glob, or its own listing helper) by a path from its own location (`import.meta`, `__dirname`,
  `process.cwd()`, or a name assigned from one) or by a top-level folder's name (`walk("src")`); listing a temp folder
  doesn't count — and every test anchored on the checkout itself (`new URL("..", import.meta.url)` reaches every file).
  Tests that read a named file (a fixture, a workflow, a schema, README.md) reach it through the literal edges instead;
- `ALWAYS_FILES`, by name, each from a backtest failure the graph can't reach: today only `src/up.slow.test.ts`, which
  lost its reserved port to another process (EADDRINUSE) on #427, a change to `src/acp-gateway.slow.test.ts` alone.

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
across 51 runs, 117 distinct failing (run, file) pairs (123 on Linux shards and 32 on macOS shards, counted per job), read
from the failed jobs' logs (a failing shard uploads no report). One macOS shard's log was gone; nothing else was
unattributed.

- **Misses: 0** on Linux and **0** on the macOS lane (judged against lane ∩ selection). The first version that read folder
  walks precisely missed one: `src/up.slow.test.ts` on #427, the port race above; it is the one `ALWAYS_FILES` entry.
  Without it the macOS saving below would be 597 → 324 s, with that one miss.
- **Mode:** 101 of 134 runs plan the full suite (43 touch `scripts/`, 33 a contract, 7 a workflow, 7 test setup or
  helpers, 4 the notices, 4 are release branches, 2 delete a source file, 1 the lock file). 33 select: 25 of them 94–96%
  of the suite, 8 (workbench-only and documentation-only changes) 23%.
- **Savings, Linux: about 4.5 s per run** on the slowest shard's estimate (median 347 → 346 s), 267 worker-seconds of
  6206 on average. The 8 small selections: 343 → 283 s; the other 25 save about 5 s.
- **Savings, macOS lane** (lane ∩ selection, 3 shards): **12 s per run on average** on the slowest shard (602 → 589 s).
  The 8 small selections run 101 of 232 lane files: **597 → 407 s, about 3 minutes off the macOS critical path** for
  workbench- and documentation-only pull requests (6% of runs). The floor there is `src/up.slow.test.ts` (405 s on a
  Mac). For everything else the lane still runs ~95% or all of its files.
- **Why it can't save more:** the import graph is one component. `src/store.ts` imports 124 modules, and its closure
  (through `nightly-github → release-adapters → release-gate → desktop-update → desktop-host → operate → serve`) is
  832 files; any change under `src/` that touches that component reaches ~641 tests by import alone, plus the 192 that
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
every file, as today. The macOS lane works the same way: its shards plan `--lane macos` (the lane's files the selection
holds, or the whole lane when the selection holds none), and its join plans the same and, under `enforce`, holds the
macOS shards to it; the Linux-skips check (`linuxSkipsProblem`) still applies. The selector only takes effect once it is
on main (the shards and the joins run the base revision's copy).

## 3. The type checker

The repository already runs TypeScript's native checker: `typescript` is pinned at 7.0.2, and TypeScript 7 *is* the Go
port (`node_modules/typescript/bin/tsc` execs the platform binary from `@typescript/typescript-<platform>`); it has been
since #50 (2026-09-23). `@typescript/native-preview` stopped at 7.0.0-dev.20260707 when 7.0 shipped. So there is no
`tsgo` to add beside `tsc`, and no advisory job: the required typecheck is already the fast one.

Measured on the build Mac (24 cores, load ~15 from other work; best of 3), against TypeScript 6.0.3's JavaScript `tsc`
(the repository's `typescript-parser` alias):

| Config | tsc 7.0.2 (native) | tsc 6.0.3 (JS) | Diagnostics |
| --- | --: | --: | --- |
| tsconfig.json (1799 files, 526k lines) | 1.8 s | 13.0 s | 0 and 0 |
| tsconfig.browser.json | 1.8 s | 15.2 s | 0 and 0 |
| tsconfig.tui.json | 0.1 s | 0.7 s | 0 and 0 |

About 7.5× faster, and the same answer: both report nothing on the tree, and the same three errors (TS2322, TS18048,
TS2305, same positions) on an injected probe file. In CI the typecheck step is 10–11 s on Linux and 15–22 s on macOS,
mostly npm and process start-up around three ~2 s checks.

## 4. oxlint

oxlint 1.90.0 (2026-10-27), pinned exactly as a devDependency; `.oxlintrc.json` turns on its correctness and
suspicious categories (126 rules over 2075 files, 0.2 s locally). `lint.yml` runs `oxlint --deny-warnings --format
github` on every pull request; `oxlint · advisory` is in ADVISORY_PR_CHECKS. Until a release with that list is the
deployed one, the deployed release tool treats the job as ordinary: the baseline keeps main clean, so it passes unless a
change adds a finding.

First run, 4758 findings over 31 rules:

| Hits | Files | Rule |
| --: | --: | --- |
| 1818 | 678 | unicorn/consistent-function-scoping |
| 941 | 394 | unicorn/no-array-sort |
| 754 | 261 | no-shadow |
| 510 | 111 | no-unused-vars |
| 175 | 106 | no-control-regex |
| 126 | 45 | no-underscore-dangle |
| 103 | 82 | unicorn/no-array-reverse |
| 76 | 46 | unicorn/no-useless-spread |
| 66 | 44 | unicorn/prefer-string-starts-ends-with |
| 42 | 24 | unicorn/no-useless-fallback-in-spread |
| 28 | 15 | no-useless-escape |
| 26 | 16 | no-unmodified-loop-condition |
| 15 | 11 | preserve-caught-error |
| 13 | 1 | typescript/no-this-alias |
| 11 | 8 | no-useless-concat |
| 9 | 7 | unicorn/no-array-fill-with-reference-type |
| 8 | 4 | no-unsafe-optional-chaining |
| 6 | 5 | unicorn/require-post-message-target-origin |
| 5 each | 3–4 | no-unused-expressions, unicorn/no-new-array, unicorn/prefer-add-event-listener |
| 4 | 4 | no-new |
| 3 | 2 | no-loss-of-precision |
| 2 | 1 | unicorn/no-thenable |
| 1 each | 1 | no-confusing-non-null-assertion, no-extend-native, no-unsafe-finally, no-unneeded-ternary, no-useless-length-check, no-constant-binary-expression, no-useless-constructor |

One real bug, fixed in its own commit: `scripts/app-e2e.mjs`'s running-release-check journey threw its collected
problems from a `finally`, which replaced the journey's own failure (no-unsafe-finally). The rest, read case by case:
loop flags set by signal handlers and async callbacks oxlint can't see (no-unmodified-loop-condition), deliberate test
values (`9007199254740993`, `false && html…`, `Object.prototype` pollution probes, shared `.fill` references compared
with `toEqual`), a `then:` string property, ANSI-stripping control regexes, and style. They are baselined: the
remaining 4757 findings (30 rules, 1882 file and rule pairs) are per-file `overrides` in `.oxlintrc.json`, so a file
keeps only the rules it already broke and a new file gets every rule. To retire a rule's debt, fix its files and delete
its override.

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
- **Measured** on the build Mac (cargo 1.100.0, workspace clippy `-D warnings` then `cargo test`, registry already
  local): cold 53.8 s (clippy 12.8 + tests 41.0); warm with nothing changed 20.1 s (clippy 0.5 + the tests themselves
  19.6); warm after a one-line change in the workbench crate 33.2 s (clippy 2.3 + tests 30.9). So a later push saves
  ~40% of the job (more when only tests or other crates change); the tests' own run (~20 s) is the floor. The cached
  target is 1.5–2.2 GB, ~15–20 s to restore, so on CI's `rust · ubuntu-latest` (23 s clippy + 54 s tests) and the bundle
  job's macOS checks (41 + 77 s cold) the net saving is about 30–45 s per warm run, off the critical path. Measured with
  the machine under load from other work (it varies ±40%); the CI numbers come with the first pull request that runs it.
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
a workbench pull request asks for one macOS runner fewer, and the bundle job takes ~120 s longer cold (~40 s warm),
off the critical path. The macOS unit lane itself is unchanged (still 3 shards, same files).

## At most 5 macOS runners per pull request (owner-approved lever 1)

GitHub-hosted macOS concurrency on this account is 5. What each kind of pull request asks for, across every workflow
(the macOS joins, the native lanes, the upgrade test, the journeys, rust.yml and lint.yml all run on Linux or Windows):

| Pull request | Before this branch | Now: at once (then) |
| --- | --- | --- |
| ordinary (src/, docs, tests) | 3 (macOS lane shards) | 3 |
| workbench (tui/, the engine contract) | 7: 3 shards, rust macOS, bundle smoke, darwin-arm64, darwin-x64 | 4 (then 1): 3 shards, darwin-arm64; the bundle smoke after |
| packaging (package.json, install paths) | 8: as workbench, plus the macOS install smoke | 5 (then 1) |
| release-* (always packaging) | 11: plus Node 22's 3 macOS shards | 9 (then 1): 6 shards, install smoke, darwin-arm64, darwin-x64 |
| nightly (not a pull request) | 6: both Nodes' macOS shards | 6 |

How: `rust · macos-latest` folded into the bundle smoke (above); darwin-x64, the release's Intel build, runs only on
release-* branches, by hand and at the tag (package-build.yml's `intel` input; publish.yml always builds all four, and
an ordinary pull request's assemble verifies and packs the other three); and the bundle smoke waits for the package build
and takes its binary (below), so it never runs beside that Mac. The macOS lane keeps 3 shards and its files.
`src/ci-workflow.test.ts` holds the counts.

The critical path doesn't move for a pull request on its own: it was already the macOS lane (~17 minutes median), and an
ordinary pull request asked for 3. What changes is pressure: a workbench or packaging pull request no longer queues
against itself (it asked for 7–8 of 5), and two pull requests at once now ask for 6–9 rather than 10–15, so fewer macOS
shards wait behind them (the measured p90 queue was ~10 minutes). The workbench bundle's own path grows (package build
~3 minutes, then the smoke with its macOS Rust checks, ~6–7 minutes in all), still well inside the macOS lane's.

## Each workbench binary built once per pull request (lever 2)

The bundle smoke built this platform's binary itself, beside the package build that built the same one (darwin-arm64
on a second Mac, linux-x64 on a second Linux runner). Now it waits for the package build (`needs: binaries`), downloads
`workbench-<platform>`, places it only once its sha256 is its build's report's (`tui-build.mjs --adopt`, nothing run
first), and verifies it as publish would pack it with that report (`--verify --reports`: architecture, signature or
static linking, the self-check with this build's contract digest, the pack list) — the same checks assemble runs.

## Splitting store.ts's imports (lever 3)

**Where the closure came from.** In the runtime import graph (no `import type`), `src/store.ts` imported 114 modules and
reached 773 of 919 product files, serve.ts and operate.ts among them. Removing any one of its own imports took one file
off: the graph is one tight knot. The knot had one thin bridge: `nightly-github → release-adapters → release-gate →
desktop-update → desktop-host → operate → serve`, and the release gate used exactly one function from the desktop
updater, `durableJson`.

**Done (no behaviour change):**

1. `durableJson` moved verbatim to `src/durable-json.ts`; `release-gate.ts` imports it there, `desktop-update.ts`
   re-exports it (desktop-update.ts has no top-level side effects to miss). store.ts's runtime closure: **773 → 448**
   product files; serve.ts and operate.ts are out of it.
2. 124 type-only named imports in 30 files (`import { type A }`, which verbatimModuleSyntax still compiles to
   `import {} from` and so loads the module) are now `import type` (erased). store.ts had two (chat-core, provider).
3. The selector stopped following type-only imports (`import type`, `export type … from`, `import("…").Type`), which
   can't load anything when tests run.

No function in store.ts, operate.ts or server/tasks.ts moved (src/password-freshness.test.ts pins their ordinals).
Typecheck, the build, the CLI's `--version`/`--help`, loading dist's store, serve and operate, and 46 affected test files
(1257 tests: password freshness, public hygiene, the ci-* tests, store, desktop-update, toolroll-update, release-gate and
the tests named after every changed file) pass.

**Measured with the selector's own graph** (imports plus the files tests name), tests one changed `src/` module reaches,
over 920 modules:

| | median | p25 | p75 | modules reaching > 600 tests | store.ts closure |
| --- | --: | --: | --: | --: | --: |
| before | 823 | 823 | 823 | 785 | 893 |
| type-only edges dropped | 711 | 711 | 711 | 778 | 886 |
| + durableJson moved | 356 | 342 | 711 | 341 | 408 |
| + `import type` conversions | 350 | 336 | 707 | 341 | 408 |

**Re-run backtest** (historical trees, so it reflects the selector change only): still **0 misses** on Linux (123
failing pairs) and macOS (32); the 25 large selections fall from 95% to 88% of the suite; mean Linux saving 6.3 s, macOS
13.6 s. The same historical diffs planned on today's tree, before and after the split: 33 selecting runs, 654 → 628 files
on average; two pull requests (#400, #403) drop from ~790 to ~520–560 files and their slowest Linux shard from 342–346 s
to the 283 s floor. Most real pull requests touch several files, and at least one usually sits in the knot that remains.

**What remains, and the plan for it.** store.ts's closure is now a 408-file knot in which 19 modules each reach all
408, because they import store.ts and store.ts imports them. store.ts calls most of them once or twice:

| store.ts imports (uses in store.ts) | |
| --- | --- |
| used once | workspace-revision, project-skills, project-knowledge, project-memory, model-catalog, runner, recipes |
| used twice | verification-evidence, project-learning, review-context, nightly-github, provider-auth, run-efficiency |
| more | code-map-store (7), agentconfig (7), fallback (5), vanished-retry (6), reported-usage (10), route-store (23) |

Next steps, in the order they pay:

1. **nightly-github → release-adapters** (159 of the 408): `refreshNightlyForDeploy` lazily imports the release
   adapters. Move it to its own module beside its callers; store.ts keeps `nightlyDebtHold` from `./nightly-github.js`,
   which src/eval-hooks.ts pins (store's `releaseNightlyProblem` must call it from there), so that pin stays true.
2. **The once-used project-* and catalog modules**: each is one Store method that reads its module's rows. Turn the
   method into a function in that module taking the store (`projectSkills(store, …)`), and have callers call it there.
   This removes functions from store.ts, so src/password-freshness.test.ts's ordinals move: an owner-reviewed change to
   that gate, one module per pull request.
3. **result-follow-ups → builder** (29 files): it takes `approvedCommandShell` and the setup environment lists from
   builder.ts; a small module of their own (security code: its own safety self-review) would cut builder out.
4. **Lazy imports don't help selection**: an `await import()` still runs when a test calls that path, so the selector
   (rightly) follows it. Only moving code out of the knot shrinks what a change reaches.

Expected effect, from this tooling: (1) alone takes the store's closure to about 250 files; (1) and (2) would bring a
typical single-module change to about 200–250 tests and let multi-file pull requests outside the store's core select
roughly half the suite. That is a guess from the graph, not a backtest: the backtest can only judge it once those moves
are in the history it replays.

## The new critical path, and what the owner decides

Today: ~17 minutes median, set by the macOS lane (queue + ~12 minutes of job). Merged as it is (selection advisory), a
pull request on its own still takes that; what drops is macOS demand (at most 5 at once per pull request, 6–9 for two
at once instead of 10–15), so the ~10-minute p90 queue should shrink, and advisory jobs get shorter (Rust cache, one
binary build instead of two, no Intel Mac on ordinary pull requests).
With `TEST_SELECTION: enforce`, the expected macOS critical path: unchanged for ~94% of pull requests (12 s on average),
and about 3 minutes shorter (597 → 407 s of tests) for workbench- and documentation-only ones. Linux never sets the path.

Decisions for the owner:

1. **Enforce the selection?** After a week of advisory runs (the joins' summaries say what each run would have
   selected), `TEST_SELECTION: enforce` is the one-line switch for both lanes. The backtest: 0 misses on both; worth
   ~3 minutes on the 6% of pull requests that touch only the workbench or documentation, seconds elsewhere.
2. **The required typecheck** is already TypeScript 7's native checker; nothing to switch. What remains is that it runs
   in all 9 shard jobs (10–22 s each, 22 s on the macOS critical path): one typecheck job instead would save ~22 s per
   run; `src/ci-workflow.test.ts` currently requires it in every shard.
3. **The three levers** (approved, built above): macOS at most 5 per pull request, each binary built once, and the first
   cut of the store's closure. What's left to decide: the next store.ts moves (lever 3's plan), each of which changes
   src/password-freshness.test.ts's pinned ordinals and wants its own review; and whether two concurrent pull requests'
   3+3 macOS shards (over 5) are worth fewer lane shards once the selection is enforced.

## Checks run on this branch

`src/ci-select.test.ts`, `src/ci-shards.test.ts`, `src/ci-workflow.test.ts`, `src/ci-candidate.test.ts` (one Vitest
process, all passing), each new rule reverted in the working tree to see its test fail (attacks always run, product
literals, the whole tree as nodes, `plannedFiles`, the shards' `rm -f .ci-test-selection`, the cache key's toolchain,
the scripts trigger, the macOS lane's `--lane`, `ALWAYS_FILES`, the walk rule, the empty-lane fallback, the oxlint
advisory name and `--deny-warnings`), `oxlint --deny-warnings` clean on the baseline and failing a new file, and
`node --check` on the edited journey. Not run here: the full suite, the journey itself, any CI run of these workflows
(no pull request was opened).
