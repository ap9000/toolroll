import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
// @ts-expect-error plain ESM script without declarations
import { laneFiles } from "./scripts/ci-shards.mjs";
import TimedSequencer from "./test/shard-sequencer.js";

/** TOOLROLL_TEST_LANE=macos: only the macOS lane's files (scripts/ci-shards.mjs LANES; CI's macOS shards run it, Linux
 * runs everything). Unset or `all`: the whole suite. */
const lane = process.env["TOOLROLL_TEST_LANE"];
/** The whole suite, or the lane's files. */
const suite: string[] = lane === undefined || lane === "" || lane === "all" ? ["src/**/*.test.ts", "test/attacks/**/*.test.ts"] : laneFiles(import.meta.dirname, lane);
/** CI only, and only when ci.yml's TEST_SELECTION is `enforce`: the shard job writes the test selection's files, one per
 * line, to .ci-test-selection before the candidate's copy is made (scripts/ci-select.mjs, docs/plans/ci-speed-2.md).
 * No file, or an empty one: the whole suite. The shards' join judges the files run against its own copy of the plan, so
 * a list that leaves a file out fails the join, never the coverage. */
const selection = process.env["CI"] === "true" && existsSync(join(import.meta.dirname, ".ci-test-selection"))
  ? readFileSync(join(import.meta.dirname, ".ci-test-selection"), "utf8").split("\n").map(one => one.trim()).filter(one => one !== "")
  : [];

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
