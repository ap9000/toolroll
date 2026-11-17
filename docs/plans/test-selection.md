# Test selection on pull requests

Status: built on branch `test-select` (2026-11-17), enforcing. Ported from the `ci-speed2` branch (its `docs/plans/ci-speed-2.md`,
section 2) without its lane changes: no runner, OS lane, Node version, shard count or macOS change. The owner approved
selection to cut CI time and asked for the impact measured.

## What runs

On an ordinary pull request each unit shard (Linux, and the macOS lane) runs only the test files the diff can reach,
plus the always-run set. `scripts/ci-select.mjs` (the trusted base revision's copy) decides from an import and literal
graph of the head's tree and the diff from the merge base:

- **Always run** (192 files today): the attack suite (103), the gate tests (`src/ci-*`, password, public hygiene, route
  and handler inventories, adapters, destinations, contracts), every test that walks the repository's folders, and
  `ALWAYS_FILES` (`src/up.slow.test.ts`, a port race no graph reaches).
- **Selected:** a test that is changed, or reaches a changed file through imports, `vi.mock`, `new URL(…)` or a string
  literal naming the file; a test that reaches a load the graph can't read (a computed `import()`, a path not in the
  tree) always runs.
- **Every file** (mode `full`) when the run isn't an ordinary pull request (release-* branches, main-push's call, the
  nightly, dispatches); the diff can't be read, is empty or has more than 100 paths; a path has a character outside
  `[A-Za-z0-9._@+/-]`; a source file is deleted, renamed, copied or retyped; the diff touches the package or lock file,
  compiler or Vitest configuration, test setup or shared helpers, workflows, `scripts/`, contracts, generated design
  files, the Rust toolchain or the notices; or a changed file outside `docs/`, root Markdown, `tui/`, `design/` is reached
  by nothing.

## Failing open

Toward more, never fewer:

- No selector on the base, a selector that exits non-zero, or one that throws while planning (it catches, says why, and
  plans everything): the shard runs every file and its join owes every file.
- A shard whose plan fails runs everything while its join's plan selects: the join accepts the extra files (each still
  once, passing, and in the inventory).
- A list holding a name outside the safe characters never reaches the shard's environment.

## Proof

- **The joins** plan again by themselves and pass `--plan` to the trusted verifier only for a selected plan
  (`scripts/ci-shards.mjs plannedFiles`): every selected file plus the verifier's own always-run set (`alwaysRunFiles`)
  must have run exactly once; a shard the selection left nothing reports an empty, passing report
  (`--passWithNoTests`); a plan for another lane, an unreadable plan or a file the inventory doesn't hold is an error.
  Required check names are unchanged.
- **"unit suite · every file ran"** (ci.yml) passes only when both joins passed and neither ran a selection. It is not a
  required check (a selected pull request reports it skipped and still merges). `main-push.yml` and `publish.yml`'s
  release proof require it, so a selected merge is never "proven tested": main runs the full CI for it, and it can never
  be a release's proven tree. A release-* branch never selects, and `toolroll release` refuses any reported check that
  didn't pass.

## Backtest (last 30 merged pull requests, #438–#467)

Each of the 86 distinct `ci.yml` runs planned on its own head commit and its diff from the merge base, with this branch's
selector; failures read from every failed shard job's log (63 failed shard jobs, every one attributed to a file).

- **Misses: 0.** 37 failing (run, file) pairs on Linux and 15 on the macOS lane, every one in that run's selection.
- **Mode:** 71 of 86 runs plan every file (24 a contract, 20 `scripts/`, 13 more than 100 paths, 10 a workflow, 4
  release branches). The 100-path cap costs nothing: each of those 13 runs also hits another full trigger.
- **The 15 selected runs** (7 pull requests: #448, #451, #452, #456, #461, #465, #466) run 797 of 909 Linux files (88%)
  and 218 of 246 macOS lane files: the slowest Linux shard 361 → 344 s, the slowest macOS shard (the critical path)
  622 → 606 s, about 300 Linux worker-seconds saved per run.
- **Over all 86 runs:** 2.2% fewer Linux test files, 1.9% fewer macOS; about 3 s off the critical path per run on average.
- **The cost:** 7 of the 30 pull requests ended on a selected run, so main-push would have run the full CI for each.
  Today 1 of the 30 merges did. Each is roughly one full `ci.yml` (about 17 minutes, three macOS runners), several times
  what the selection saved across all 15 runs.

**Why so little:** a documentation-only change on today's tree still selects 781 of 915 files, because 462 tests reach
`src/browser-shell.ts` (it reads the built browser assets by a computed name) and 94 reach `src/easy-start.ts` (it
imports the built terminal bundle). Those are loads the graph can't read, so whatever reaches them always runs. Naming
those assets as literal paths, and teaching the selector that a path into the build means "runs the build", is the lever
(the `ci-speed2` branch's plan, "next step"). The selector's other limit is the store's import closure (that plan's lever 3).

## Rolling back

`TEST_SELECTION: advisory` at the top of `ci.yml`: every file runs, and the joins write what would have been selected to
their summaries.
