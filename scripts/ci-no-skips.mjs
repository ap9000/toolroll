#!/usr/bin/env node
// Fails unless a Vitest JSON report (--reporter=json) shows tests that all ran and passed: none skipped, pending or
// todo, at least one test, and every file present. A CI lane whose point is to run these tests can't pass by skipping.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: ci-no-skips.mjs <vitest-report.json>"); process.exit(2); }
const report = JSON.parse(readFileSync(file, "utf8"));
const results = Array.isArray(report.testResults) ? report.testResults : [];
const notRun = results.flatMap(one => (one.assertionResults ?? []).filter(test => test.status !== "passed").map(test => `${one.name}: ${test.fullName} (${test.status})`));
const total = Number(report.numTotalTests ?? 0);
console.log(`${results.length} files, ${total} tests, ${report.numPassedTests ?? 0} passed`);
if (report.success !== true || total === 0 || results.length === 0 || notRun.length > 0) {
  for (const line of notRun) console.error(`not passed: ${line}`);
  if (total === 0) console.error("no tests ran");
  process.exit(1);
}
