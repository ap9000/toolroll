#!/usr/bin/env node
// Fails unless a Vitest JSON report (--reporter=json) shows tests that all ran and passed: at least one test, none
// failed, skipped, pending or todo. A CI lane whose point is to run these tests can't pass by skipping them.
//
// One exception, named and printed: an attack test titled "native …" under test/attacks/ needs the OS fence itself
// (bubblewrap with user namespaces, Seatbelt, Codex's sandbox), which a plain container doesn't have. The
// "linux fence · sandbox-runtime" job runs those with TOOLROLL_REQUIRE_NATIVE=linux, where a skip fails.
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const file = process.argv[2];
if (!file) { console.error("usage: ci-no-skips.mjs <vitest-report.json>"); process.exit(2); }
const report = JSON.parse(readFileSync(file, "utf8"));
const results = Array.isArray(report.testResults) ? report.testResults : [];
const nativeAttack = (path, test) => path.startsWith("test/attacks/") && /^native /.test(test.title ?? "");
const allowed = [], notRun = [];
let passed = 0;
for (const one of results) {
  const path = relative(process.cwd(), one.name ?? "");
  for (const test of one.assertionResults ?? []) {
    if (test.status === "passed") { passed++; continue; }
    const line = `${path}: ${test.fullName} (${test.status})`;
    if (test.status === "skipped" && nativeAttack(path, test)) allowed.push(line); else notRun.push(line);
  }
}
console.log(`${results.length} files, ${passed} tests passed, ${allowed.length} native-fence attacks left to the linux fence job`);
for (const line of allowed) console.log(`  native, not run here: ${line}`);
if (report.success !== true || passed === 0 || notRun.length > 0) {
  for (const line of notRun) console.error(`not passed: ${line}`);
  if (passed === 0) console.error("no test passed");
  process.exit(1);
}
