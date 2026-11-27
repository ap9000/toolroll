import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** `npm run relay:test`: the relay lane (.github/workflows/relay.yml). The reference relay's conformance and its own
 * tests, plus the Cloudflare worker under Miniflare and its Durable Object tests. No build, no app state: these files
 * start only relays. The root unit suite also runs the src/ files here. */
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["src/companion/relay-conformance*.test.ts", "relay/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
