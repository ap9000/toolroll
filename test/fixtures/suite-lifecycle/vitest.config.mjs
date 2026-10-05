import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root: here,
  test: { include: ["*.fixture.test.mjs"], globalSetup: ["../../temp-root.ts"], pool: "forks", testTimeout: 600_000 },
});
