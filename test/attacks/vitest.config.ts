import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.js";

/**
 * The attack suite alone (`npm run test:attacks`): the same setup as every other test file, without the build step,
 * which no attack needs, so the Quick check can run it in well under a minute.
 */
export default defineConfig({
  ...base,
  root: resolve(import.meta.dirname, "../.."),
  test: { ...base.test, include: ["test/attacks/**/*.test.ts"], globalSetup: ["./test/temp-root.ts"] },
});
