#!/usr/bin/env node
/**
 * `npm run relay:deploy` — the only way the hosted relay ships:
 *   1. typecheck + the relay tests (reference and worker conformance under Miniflare, Durable Object tests);
 *   2. wrangler deploy --env staging (BUILD_ID = the commit), then the smoke test against staging;
 *   3. wrangler deploy to production (same BUILD_ID), then the smoke test against production.
 * Any failure stops it. `--plan` prints the steps and runs nothing. Needs a clean checkout and wrangler credentials
 * (`wrangler login` or CLOUDFLARE_API_TOKEN); secrets are set separately with `wrangler secret put`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const worker = fileURLToPath(new URL("../", import.meta.url));
const STAGING = "https://relay-staging.toolroll.dev";
const PRODUCTION = "https://relay.toolroll.dev";
const plan = process.argv.includes("--plan");

const git = args => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const dirty = git(["status", "--porcelain"]);
if (dirty !== "" && !plan) {
  console.error("relay:deploy needs a clean checkout (the build id is the commit).");
  process.exit(1);
}
const build = git(["rev-parse", "--short=12", "HEAD"]);

const steps = [
  ["typecheck", "npm", ["run", "relay:typecheck"], repo],
  ["relay tests", "npm", ["run", "relay:test"], repo],
  ["deploy staging", "npx", ["wrangler", "deploy", "--env", "staging", "--var", `BUILD_ID:${build}`], worker],
  ["smoke staging", "npx", ["tsx", "relay/cloudflare/scripts/smoke.ts", STAGING, build], repo],
  ["deploy production", "npx", ["wrangler", "deploy", "--var", `BUILD_ID:${build}`], worker],
  ["smoke production", "npx", ["tsx", "relay/cloudflare/scripts/smoke.ts", PRODUCTION, build], repo],
];

for (const [name, command, args, cwd] of steps) {
  console.log(`\n== ${name}: ${command} ${args.join(" ")}`);
  if (plan) continue;
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`relay:deploy stopped at "${name}" (exit ${result.status ?? result.signal}).`);
    process.exit(1);
  }
}
console.log(plan ? "\n(plan only: nothing ran)" : `\nrelay ${build} is live on staging and production.`);
