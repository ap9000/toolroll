#!/usr/bin/env node
/**
 * CI's unit suite in shards (docs/plans/pipeline-speed.md, part A). Each "node N · shard i/K" job runs
 * `vitest run --shard=i/K` and records what it ran; the required "node N · ubuntu-latest" job then fails unless every
 * shard of its Node version passed on the tested commit and, together, they ran every test file Vitest's own include
 * globs list in the aggregate's checkout of that commit: none missing, none run twice, none from elsewhere.
 *
 *   node scripts/ci-shards.mjs summarize <vitest-report.json> <summary.json> --sha <sha> --node <n> --shard <i>/<K>
 *   node scripts/ci-shards.mjs verify <folder> <listed-files.json> --sha <sha> --node <n> --shards <K>
 *
 * `listed-files.json` is `vitest list --filesOnly --json=<file>` run by the aggregate itself. A missing, unreadable or
 * malformed summary is a failure, never a pass.
 */
import { readFileSync, readdirSync, writeFileSync, lstatSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
const cwd = process.cwd();
const rel = file => (isAbsolute(file) ? relative(cwd, file) : file).split("\\").join("/");

/** A shard's summary from Vitest's JSON report: the files it ran and its counts. Throws when the report didn't pass. */
export function summarize(report, { sha, node, shard, of }) {
  if (!SHA.test(sha ?? "")) throw new Error("no tested commit");
  if (!Number.isSafeInteger(shard) || !Number.isSafeInteger(of) || shard < 1 || shard > of) throw new Error("no shard index");
  if (report === null || typeof report !== "object" || !Array.isArray(report.testResults)) throw new Error("not a Vitest JSON report");
  const failed = Number(report.numFailedTests), total = Number(report.numTotalTests);
  if (report.success !== true || failed !== 0 || Number(report.numFailedTestSuites) !== 0) throw new Error("the shard's report didn't pass");
  const files = report.testResults.map(one => rel(String(one?.name ?? ""))).filter(Boolean).sort();
  if (files.length === 0 || !Number.isSafeInteger(total) || total <= 0) throw new Error("the shard ran nothing");
  if (report.testResults.some(one => one?.status !== "passed" && one?.status !== "skipped")) throw new Error("a file in the shard didn't pass");
  return { version: 1, sha, node: String(node), shard, of, files, tests: { total, passed: Number(report.numPassedTests) || 0, failed, skipped: (Number(report.numPendingTests) || 0) + (Number(report.numTodoTests) || 0) } };
}

/**
 * Why the shards of one Node version don't add up to a passing suite on `sha`, or null when they do: exactly the shards
 * 1..K, each once, each of K, each on `sha` and this Node version with nothing failed, and the files they ran together
 * exactly the listed files, each once.
 */
export function shardsProblem(summaries, listed, { sha, node, shards }) {
  if (!SHA.test(sha ?? "")) return "no tested commit";
  if (!Number.isSafeInteger(shards) || shards < 1) return "no shard count";
  if (!Array.isArray(listed) || listed.length === 0) return "Vitest listed no test files";
  const mine = summaries.filter(one => one !== null && typeof one === "object");
  if (mine.length !== summaries.length) return "a shard's summary can't be read";
  for (const one of mine) {
    if (one.version !== 1) return "a shard's summary has an unknown version";
    if (one.sha !== sha) return `shard ${one.shard} tested ${String(one.sha).slice(0, 7)}, not ${sha.slice(0, 7)}`;
    if (String(one.node) !== String(node)) return `a summary for node ${one.node} is among node ${node}'s shards`;
    if (one.of !== shards) return `shard ${one.shard} was one of ${one.of}, not ${shards}`;
    if (!Array.isArray(one.files) || one.tests?.failed !== 0) return `shard ${one.shard} didn't pass`;
  }
  const seen = new Set(mine.map(one => one.shard));
  if (seen.size !== mine.length) return "a shard reported twice";
  for (let at = 1; at <= shards; at++) if (!seen.has(at)) return `shard ${at}/${shards} gave no summary`;
  if (mine.length !== shards) return `${mine.length} summaries for ${shards} shards`;
  const ran = new Map();
  for (const one of mine) for (const file of one.files) {
    if (ran.has(file)) return `${file} ran in shards ${ran.get(file)} and ${one.shard}`;
    ran.set(file, one.shard);
  }
  const want = new Set(listed);
  const missing = [...want].filter(file => !ran.has(file));
  if (missing.length > 0) return `${missing.length} test file${missing.length === 1 ? "" : "s"} ran in no shard (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})`;
  const extra = [...ran.keys()].filter(file => !want.has(file));
  if (extra.length > 0) return `a shard ran ${extra[0]}, which Vitest doesn't list here`;
  return null;
}

const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at === -1 ? undefined : args[at + 1]; };

/** Every regular `*.json` file in `folder` and its direct subfolders (download-artifact puts each artifact in its own). */
function summariesIn(folder) {
  const out = [];
  const visit = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth === 0) visit(path, 1);
      else if (entry.isFile() && entry.name.endsWith(".json") && lstatSync(path).isFile()) {
        try { out.push(JSON.parse(readFileSync(path, "utf8"))); } catch { out.push(null); }
      }
    }
  };
  visit(folder, 0);
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command, first, second, ...rest] = process.argv.slice(2);
  const args = [first, second, ...rest];
  try {
    if (command === "summarize") {
      const [shard, of] = String(flag(args, "shard") ?? "").split("/").map(Number);
      const summary = summarize(JSON.parse(readFileSync(first, "utf8")), { sha: flag(args, "sha"), node: flag(args, "node"), shard, of });
      writeFileSync(second, JSON.stringify(summary));
      console.log(`shard ${shard}/${of} on ${summary.sha.slice(0, 7)}: ${summary.files.length} files, ${summary.tests.passed} tests passed`);
    } else if (command === "verify") {
      const shards = Number(flag(args, "shards")), sha = flag(args, "sha"), node = flag(args, "node");
      const listed = JSON.parse(readFileSync(second, "utf8")).map(one => rel(String(one?.file ?? ""))).filter(Boolean);
      const summaries = summariesIn(first).filter(one => one === null || String(one.node) === String(node));
      const problem = shardsProblem(summaries, listed, { sha, node, shards });
      if (problem !== null) { console.error(`node ${node}: ${problem}`); process.exit(1); }
      const total = summaries.reduce((n, one) => n + one.tests.passed, 0);
      console.log(`node ${node}: ${shards} shards passed on ${sha}, ${listed.length} test files, ${total} tests passed`);
    } else { console.error("usage: ci-shards.mjs summarize|verify …"); process.exit(2); }
  } catch (error) { console.error(String(error?.message ?? error)); process.exit(1); }
}
