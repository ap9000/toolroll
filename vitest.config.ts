import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Review snapshots under output/ are artifacts, never runnable suites.
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup-state.ts"],
    // The run's own temp root first (every worker inherits it; the teardown removes it), then the build.
    globalSetup: ["./test/temp-root.ts", "./test/ensure-build.ts"],
    // These files launch real processes (git, the CLI, SQLite writers): 8 at once, fewer on a machine with fewer cores.
    // VITEST_MAX_WORKERS sets it.
    maxWorkers: Number(process.env["VITEST_MAX_WORKERS"]) || Math.min(8, availableParallelism()),
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
  },
});
