import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
// @ts-expect-error plain ESM script without declarations
import { laneFiles, selectedFiles } from "./scripts/ci-shards.mjs";
import TimedSequencer from "./test/shard-sequencer.js";

/** TOOLROLL_TEST_LANE=macos: only the macOS lane's files (scripts/ci-shards.mjs LANES; CI's macOS shards run it, Linux
 * runs everything). Unset or `all`: the whole suite. */
const lane = process.env["TOOLROLL_TEST_LANE"];
/** The whole suite, or the lane's files. */
const suite: string[] = lane === undefined || lane === "" || lane === "all" ? ["src/**/*.test.ts", "test/attacks/**/*.test.ts"] : laneFiles(import.meta.dirname, lane);
/** The test selection's files, only when the trusted harness hands them over (TOOLROLL_TEST_SELECTION, set by ci.yml
 * for a pull request's selected plan; scripts/ci-shards.mjs selectedFiles, docs/plans/test-selection.md). Nothing in the
 * checkout is read for it. Unset or empty: the whole suite (or lane). The shards' joins judge the files run against
 * their own plan. */
const selection: string[] = selectedFiles(process.env);

export default defineConfig({
  test: {
    // Review snapshots under output/ are artifacts, never runnable suites. The attack suite (test/attacks) runs with
    // everything else, and on its own through its config there.
    include: selection.length > 0 ? (lane === undefined || lane === "" || lane === "all" ? selection : suite.filter(one => selection.includes(one))) : suite,
    setupFiles: ["./test/setup-state.ts"],
    // The run's own temp root first (every worker inherits it; the teardown removes it), then the build.
    globalSetup: ["./test/temp-root.ts", "./test/ensure-build.ts"],
    // These files launch real processes (git, the CLI, SQLite writers): leave one core free, with 2–8 workers.
    // VITEST_MAX_WORKERS sets it.
    maxWorkers: Number(process.env["VITEST_MAX_WORKERS"]) || Math.min(8, Math.max(2, availableParallelism() - 1)),
    // Forks with per-file isolation stay: setup-state.ts points each file's
    // process.env at its own database, and modules keep per-process caches
    // (attestations, prepared statements) that must not leak between files.
    pool: "forks",
    isolate: true,
    // The suite exercises real SQLite files, git repositories, and child
    // processes. Shared CI runners, and every core busy when the files run
    // in parallel, can legitimately take more than Vitest's five-second
    // unit-test default without the underlying operation hanging.
    testTimeout: 90_000,
    // Timing-balanced shards and longest files first (test/shard-sequencer.ts, test/timings.json).
    sequence: { sequencer: TimedSequencer },
  },
});
