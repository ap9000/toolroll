#!/usr/bin/env node
// Fails unless a Vitest JSON report (--reporter=json) shows tests that all ran and passed: at least one test, none
// failed, skipped, pending or todo. A CI lane whose point is to run these tests can't pass by skipping them.
//
// One exception, named and printed: an attack test titled "native …" under test/attacks/ needs the OS fence itself
// (bubblewrap with user namespaces, Seatbelt, Codex's sandbox), which a plain container doesn't have. The
// "linux fence · sandbox-runtime" job runs those with TOOLROLL_REQUIRE_NATIVE=linux, where a skip fails.
//
//   node <trusted copy>/ci-no-skips.mjs <vitest-report.json> [--expect git|partial-clone|sqlite --root <checkout>]
//
// --expect (docs/plans/ci-speed-2.md, Codex review): the lane's own file list, this trusted copy's, over the checkout's
// test files. The report must hold exactly those files, each passing whole: a lane can't pass on a subset (a narrowed
// Vitest config, a filter, a file left out). A checkout that holds a .ci-test-selection fails: no lane reads one, and a
// committed one is refused rather than left to look as if it were trusted.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The lanes' files: `filters` as Vitest reads its command-line filters (a test file whose path holds one), or exact
 * `files`. `git` is package.json's test:git (src/ci-workflow.test.ts holds the two equal). */
export const EXPECTED = {
  git: { filters: ["test/attacks/checkout-git-", "test/attacks/fence-git-views", "test/attacks/repository-context-git", "test/attacks/discover-dirty", "src/teardown-git.test.ts", "src/worktree.slow.test.ts"] },
  "partial-clone": { files: ["test/attacks/checkout-git-partial-clone.test.ts"] },
  sqlite: { files: ["src/sqlite-compat.test.ts", "src/store.test.ts", "src/sqlite-telemetry.test.ts"] },
};

/** The unit suite's test files under `root` (scripts/ci-shards.mjs INCLUDE: src/**, test/attacks/**), relative, sorted;
 * never into node_modules, .git or a symlinked folder. */
export function testFiles(root) {
  const found = [];
  const walk = folder => {
    let entries;
    try { entries = readdirSync(join(root, folder), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== ".git") walk(path); }
      else if (entry.name.endsWith(".test.ts")) found.push(path);
    }
  };
  walk("src"); walk("test/attacks");
  return found.sort();
}

/** The files a lane owes in `root`. Throws for a lane it doesn't know, or one that would owe nothing. */
export function expectedFiles(lane, root) {
  const policy = Object.hasOwn(EXPECTED, lane) ? EXPECTED[lane] : null;
  if (policy === null) throw new Error(`no lane ${String(lane)}`);
  const all = testFiles(root);
  const owed = policy.files ?? all.filter(file => policy.filters.some(filter => file.includes(filter)));
  if (owed.length === 0) throw new Error(`the ${lane} lane finds no test files here`);
  return [...owed].sort();
}

/** Why the files a report ran aren't exactly `owed`, or null. */
export function laneProblem(ran, owed) {
  const missing = owed.filter(file => !ran.includes(file)), extra = ran.filter(file => !owed.includes(file));
  if (missing.length > 0) return `${missing.length} of the lane's files didn't run (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})`;
  if (extra.length > 0) return `it ran ${extra[0]}, which isn't the lane's`;
  return null;
}

const flag = name => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? undefined : process.argv[at + 1]; };

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) { console.error("usage: ci-no-skips.mjs <vitest-report.json> [--expect git|partial-clone|sqlite --root <checkout>]"); process.exit(2); }
  const lane = flag("expect"), root = flag("root") ?? process.cwd();
  const report = JSON.parse(readFileSync(file, "utf8"));
  const results = Array.isArray(report.testResults) ? report.testResults : [];
  const nativeAttack = (path, test) => path.startsWith("test/attacks/") && /^native /.test(test.title ?? "");
  const allowed = [], notRun = [];
  let passed = 0;
  for (const one of results) {
    const path = relative(root, one.name ?? "").split(sep).join("/");
    for (const test of one.assertionResults ?? []) {
      if (test.status === "passed") { passed++; continue; }
      const line = `${path}: ${test.fullName} (${test.status})`;
      if (test.status === "skipped" && nativeAttack(path, test)) allowed.push(line); else notRun.push(line);
    }
  }
  console.log(`${results.length} files, ${passed} tests passed, ${allowed.length} native-fence attacks left to the linux fence job`);
  for (const line of allowed) console.log(`  native, not run here: ${line}`);
  const problems = [];
  if (report.success !== true || passed === 0 || notRun.length > 0) {
    problems.push(...notRun.map(line => `not passed: ${line}`));
    if (passed === 0) problems.push("no test passed");
    if (report.success !== true && notRun.length === 0 && passed > 0) problems.push("the report didn't pass");
  }
  if (lane !== undefined) {
    if (existsSync(join(root, ".ci-test-selection"))) problems.push("the checkout holds a .ci-test-selection: no lane reads one, and a change may not add one");
    try {
      const ran = [...new Set(results.map(one => relative(root, one.name ?? "").split(sep).join("/")))].sort();
      const problem = laneProblem(ran, expectedFiles(lane, root));
      if (problem !== null) problems.push(`the ${lane} lane: ${problem}`);
      else console.log(`the ${lane} lane: all ${ran.length} of its files ran`);
    } catch (error) { problems.push(String(error?.message ?? error)); }
  }
  if (problems.length > 0) { for (const line of problems) console.error(line); process.exit(1); }
}
