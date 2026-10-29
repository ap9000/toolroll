#!/usr/bin/env node
/**
 * CI's unit suite in shards (docs/plans/pipeline-speed.md, part A). Each "node N · shard i/K" job runs
 * `vitest run --shard=i/K` and uploads Vitest's own JSON report, written by that step outside the checkout; the
 * required "node N · ubuntu-latest" job then fails unless every shard of its Node version passed and, together, they
 * ran every test file the include policy below finds in the tested commit: none missing, none run twice, none from
 * elsewhere, every report's counts consistent and tests actually executed.
 *
 *   node <trusted copy>/scripts/ci-shards.mjs verify <shards-folder> --root <candidate checkout> --base <trusted checkout>
 *     --sha <sha> --node <n> --shards <K>
 *
 * Trust (Codex review round 1, finding 1): the join never runs the candidate's code. It runs THIS file as the trusted
 * base revision has it (the pull request's base, or main itself on a push; ci.yml checks it out apart) and only reads
 * the candidate's tree (which files exist) and the shards' reports. The file inventory policy (INCLUDE) and the skip
 * policy live here, on the trusted side; the skip policy reads the base revision's copy of each test file. What stays
 * trusted is the candidate's test code and test configuration, which run in the shard jobs and could rewrite a report
 * before it is uploaded (AGENTS.md: coverage trusts test code; report provenance is not authenticated). A missing,
 * unreadable, malformed or inconsistent report is a failure, never a pass.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
/** The unit suite's test files: vitest.config.ts `include` (src/ci-shards.test.ts holds the two equal). Vitest's own
 * default exclusions (node_modules, .git) apply. */
export const INCLUDE = ["src/**/*.test.ts", "test/attacks/**/*.test.ts"];
/** A construct that can skip a test (or leave one to do): `.skip`, `.skipIf`, `.runIf`, `.todo`, `ctx.skip(…)`, a `skip:` option, and the
 * attack harness's `needs(ctx, probe)`. */
export const SKIP_CONSTRUCT = /\.(skip|skipIf|runIf|todo)\b|\bskip\(|\bskip\s*:|\bneeds\(/;
/** Assertion states that mean a test didn't run. */
const NOT_RUN = new Set(["skipped", "pending", "todo", "disabled"]);

/** Every test file the include policy finds under `root`, relative and sorted. Never follows a symlinked folder. */
export function inventory(root) {
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
  for (const pattern of INCLUDE) walk(pattern.slice(0, pattern.indexOf("/**")));
  return found.sort();
}

/**
 * Whether a file may report tests that didn't run: only when the trusted base revision's copy of it can skip one, or
 * the file is new in the candidate (it takes no coverage the base had). A test the base always ran can't start
 * skipping unseen.
 */
export function skipPermitted(file, base) {
  const at = join(base, file);
  if (!existsSync(at)) return true;
  try { return lstatSync(at).isFile() && SKIP_CONSTRUCT.test(readFileSync(at, "utf8")); } catch { return false; }
}

/**
 * One shard's Vitest JSON report, checked: it passed, its counts agree with its own test results, it executed tests,
 * and every file is under `root`. Returns the files it ran (relative) and its counts, or why it can't stand.
 */
export function readReport(report, { root, base }) {
  const no = problem => ({ ok: false, problem });
  if (report === null || typeof report !== "object" || !Array.isArray(report.testResults)) return no("isn't a Vitest JSON report");
  if (report.success !== true) return no("didn't pass");
  for (const key of ["numFailedTests", "numFailedTestSuites"]) if (report[key] !== 0) return no(`reports ${key} ${String(report[key])}`);
  if (report.numRuntimeErrorTestSuites !== undefined && report.numRuntimeErrorTestSuites !== 0) return no("reports a suite that errored");
  const counts = { total: 0, passed: 0, notRun: 0 };
  const files = [];
  for (const one of report.testResults) {
    const name = typeof one?.name === "string" ? one.name : "";
    const file = relative(root, name).split(sep).join("/");
    if (name === "" || !name.startsWith("/") || file === "" || file.startsWith("../") || file.startsWith("/")) return no(`ran a file outside the checkout (${name.slice(0, 120)})`);
    if (!Array.isArray(one.assertionResults) || one.assertionResults.length === 0) return no(`${file} reports no tests`);
    let passed = 0, notRun = 0;
    for (const test of one.assertionResults) {
      if (test?.status === "passed") passed++;
      else if (NOT_RUN.has(test?.status)) notRun++;
      else return no(`${file} has a test that ${String(test?.status)}`);
    }
    if (!(passed > 0 ? ["passed"] : ["passed", "skipped"]).includes(one.status)) return no(`${file} is ${String(one.status)}`);
    if (notRun > 0 && !skipPermitted(file, base)) return no(`${file} skipped ${notRun} test${notRun === 1 ? "" : "s"}, and the base revision's copy of it never skips one`);
    counts.total += one.assertionResults.length; counts.passed += passed; counts.notRun += notRun;
    files.push(file);
  }
  if (report.numTotalTests !== counts.total) return no(`says ${String(report.numTotalTests)} tests, its results hold ${counts.total}`);
  if (report.numPassedTests !== counts.passed) return no(`says ${String(report.numPassedTests)} passed, its results hold ${counts.passed}`);
  const said = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  if (said !== counts.notRun) return no(`says ${String(said)} skipped, its results hold ${counts.notRun}`);
  if (counts.passed === 0) return no("executed no tests");
  return { ok: true, files: files.sort(), tests: counts };
}

/**
 * Why the shards of one Node version don't add up to a passing suite, or null when they do: exactly the shards 1..K,
 * each one report that stands (readReport), and the files they ran together exactly the inventory, each once.
 * `reports` maps a shard index to its parsed report (null when unreadable).
 */
export function shardsProblem(reports, listed, { shards, root, base }) {
  if (!Number.isSafeInteger(shards) || shards < 1) return "no shard count";
  if (!Array.isArray(listed) || listed.length === 0) return "the include policy finds no test files";
  for (let at = 1; at <= shards; at++) if (!reports.has(at)) return `shard ${at}/${shards} gave no report`;
  for (const at of reports.keys()) if (!Number.isSafeInteger(at) || at < 1 || at > shards) return `a report for shard ${at} of ${shards}`;
  const ran = new Map();
  for (const [at, report] of [...reports.entries()].sort((a, b) => a[0] - b[0])) {
    if (report === null) return `shard ${at}'s report can't be read`;
    const read = readReport(report, { root, base });
    if (!read.ok) return `shard ${at}'s report ${read.problem}`;
    for (const file of read.files) {
      if (ran.has(file)) return `${file} ran in shards ${ran.get(file)} and ${at}`;
      ran.set(file, at);
    }
  }
  const want = new Set(listed);
  const missing = [...want].filter(file => !ran.has(file));
  if (missing.length > 0) return `${missing.length} test file${missing.length === 1 ? "" : "s"} ran in no shard (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})`;
  const extra = [...ran.keys()].filter(file => !want.has(file));
  if (extra.length > 0) return `a shard ran ${extra[0]}, which the include policy doesn't find here`;
  return null;
}

const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at === -1 ? undefined : args[at + 1]; };

/**
 * The shards' reports as download-artifact lays them out: exactly one folder per shard, `shard-<node>-<i>`, each holding
 * exactly one regular file, `shard-report.json`. Anything else in the folder is refused, never skipped.
 */
export function reportsIn(folder, node) {
  const reports = new Map();
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const match = /^shard-(\d+)-(\d+)$/.exec(entry.name);
    if (!entry.isDirectory() || match === null || match[1] !== String(node)) throw new Error(`unexpected ${entry.name} among the shards' reports`);
    const inside = readdirSync(join(folder, entry.name), { withFileTypes: true });
    if (inside.length !== 1 || inside[0].name !== "shard-report.json" || !inside[0].isFile()) throw new Error(`${entry.name} doesn't hold exactly one shard-report.json`);
    let report = null;
    try { report = JSON.parse(readFileSync(join(folder, entry.name, "shard-report.json"), "utf8")); } catch { report = null; }
    reports.set(Number(match[2]), report);
  }
  return reports;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command, folder, ...args] = process.argv.slice(2);
  try {
    if (command !== "verify") { console.error("usage: ci-shards.mjs verify <shards-folder> --root <checkout> --base <trusted checkout> --sha <sha> --node <n> --shards <K>"); process.exit(2); }
    const shards = Number(flag(args, "shards")), sha = flag(args, "sha"), node = flag(args, "node"), root = flag(args, "root"), base = flag(args, "base");
    if (!SHA.test(sha ?? "")) throw new Error("no tested commit");
    if (typeof root !== "string" || typeof base !== "string") throw new Error("--root and --base are required");
    const listed = inventory(root);
    const reports = reportsIn(folder, node);
    const problem = shardsProblem(reports, listed, { shards, root, base });
    if (problem !== null) { console.error(`node ${node}: ${problem}`); process.exit(1); }
    const executed = [...reports.values()].reduce((n, one) => n + one.numPassedTests, 0);
    console.log(`node ${node}: ${shards} shards passed on ${sha}, ${listed.length} test files, ${executed} tests executed`);
  } catch (error) { console.error(String(error?.message ?? error)); process.exit(1); }
}
