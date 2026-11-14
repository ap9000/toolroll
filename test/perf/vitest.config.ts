import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.js";

/**
 * The wire budgets alone (`npm run test:perf:wire`, docs/TESTING.md "Wire budgets"): the same per-file setup as every
 * other test file (its own HOME, config folder and database), the build first (the document load serves the browser
 * bundle, and the bundle has its own row). Never part of the unit suite: vitest.config.ts includes src/ and
 * test/attacks/ only, so these files run here and in their own advisory CI job.
 */
export default defineConfig({
  ...base,
  root: resolve(import.meta.dirname, "../.."),
  test: { ...base.test, include: ["test/perf/**/*.wire.test.ts"], maxWorkers: 1 },
});
