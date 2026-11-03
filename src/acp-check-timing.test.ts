/**
 * The ACP check's stop step waits a minute for the agent's command in every product path (ci-speed review): the
 * shorter window exists for tests only, through runAcpChecksForTests, which no product file may import, and the check's
 * job carries no wait a CLI flag, environment variable or setting could fill.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { STOP_WAIT_MS } from "./acp-check.js";

const SRC = import.meta.dirname;
const productFiles = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
  const path = join(folder, entry.name);
  if (entry.isDirectory()) return productFiles(path);
  return /\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
});

test("the product's stop window is a minute, and runAcpChecks always uses it", () => {
  expect(STOP_WAIT_MS).toBe(60_000);
  const source = readFileSync(join(SRC, "acp-check.ts"), "utf8");
  expect(source).toMatch(/export async function runAcpChecks\(job: AcpCheckJob\): Promise<void> \{\n {2}return runChecks\(job, STOP_WAIT_MS\);\n\}/);
  // The job type has no wait of its own: nothing that builds a job (operate.ts's watch) can carry one.
  const job = /export type AcpCheckJob = \{[\s\S]*?\n\};/.exec(source)![0];
  expect(job).not.toMatch(/wait|Ms\b|timeout/i);
});

test("no product file imports the test-only window", () => {
  const users = productFiles(SRC).filter(file => !file.endsWith(join("src", "acp-check.ts")) && readFileSync(file, "utf8").includes("runAcpChecksForTests"));
  expect(users).toEqual([]);
});
