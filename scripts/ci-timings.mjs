#!/usr/bin/env node
/**
 * Timing-balanced shards for the unit suite (docs/plans/ci-speed.md). Vitest's own `--shard=i/K` splits the files by a
 * hash of their paths, so one shard could get every slow file (run 41634514443: macOS shards took 553–1037 s, Linux
 * 242–469 s). Here each file weighs what it took in CI, from test/timings.json, and the files go to the shards
 * longest first, each to the shard that would finish soonest. The plan depends only on the file list, the timings file
 * and the shard count, so every shard job of a run computes the same plan; the shards' join still checks that together
 * they ran every file once (scripts/ci-shards.mjs), so a plan that went wrong fails, it never drops a file.
 *
 *   node scripts/ci-timings.mjs refresh [--run <ci.yml run id>] [--from <downloaded artifacts folder>] [--repo <owner/name>]
 *   node scripts/ci-timings.mjs plan [--platform linux|darwin] [--shards <K>] [--lane all|macos]
 *
 * `refresh` reads the shard reports a CI run uploaded (Vitest's JSON, one per shard, Linux and macOS) and writes
 * test/timings.json: each file's own time in seconds, per platform. Run it on a recent green run of main or a pull
 * request when the shards drift apart (`plan` prints what each shard would take).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TIMINGS_FILE = join(ROOT, "test", "timings.json");
/** Workers a shard runs at once when planning (Vitest gets 3 on a hosted Linux runner, 2 on a hosted Mac): fixed, so every shard job of a run
 * plans the same split whatever its machine says. */
export const PLAN_WORKERS = { linux: 3, darwin: 2 };
/** What a file nobody has timed yet weighs: a typical file, never zero (a new file still costs its shard something). */
const UNKNOWN_SECONDS = 2;

/** test/timings.json, or empty timings when it is missing or unreadable (the plan then weighs every file alike). */
export function readTimings(file = TIMINGS_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const clean = table => Object.fromEntries(Object.entries(table ?? {}).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0));
    return { linux: clean(parsed.linux), darwin: clean(parsed.darwin) };
  } catch { return { linux: {}, darwin: {} }; }
}

/** What `file` is expected to take on `platform`: its own time there, else on the other platform, else a typical file. */
export function weightOf(file, timings, platform) {
  const own = timings[platform === "darwin" ? "darwin" : "linux"] ?? {}, other = timings[platform === "darwin" ? "linux" : "darwin"] ?? {};
  return own[file] ?? other[file] ?? UNKNOWN_SECONDS;
}

/**
 * The shard (0-based) each file goes to: longest first, each to the shard whose estimated finish — its longest file,
 * or its total over `workers` — stays lowest (ties: the lower total, then the lower index). Files of equal weight are
 * ordered by path, so the plan is the same for the same inputs everywhere.
 */
export function planShards(files, timings, count, { platform = "linux", workers = PLAN_WORKERS[platform === "darwin" ? "darwin" : "linux"] } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("no shard count");
  const shards = Array.from({ length: count }, () => ({ total: 0, longest: 0 }));
  const finish = (one, extra) => Math.max(one.longest, extra, (one.total + extra) / workers);
  const order = [...new Set(files)].map(file => ({ file, weight: weightOf(file, timings, platform) }))
    .sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const plan = new Map();
  for (const { file, weight } of order) {
    let best = 0;
    for (let at = 1; at < count; at++) {
      const here = finish(shards[at], weight), there = finish(shards[best], weight);
      if (here < there || (here === there && shards[at].total < shards[best].total)) best = at;
    }
    shards[best].total += weight;
    shards[best].longest = Math.max(shards[best].longest, weight);
    plan.set(file, best);
  }
  return { plan, shards: shards.map(one => ({ ...one, estimate: Math.max(one.longest, one.total / workers) })) };
}

/** Each file's own time in seconds, from Vitest JSON reports (a file's end minus its start), by checkout-relative path. */
export function timesFromReports(reports) {
  const times = {};
  for (const report of reports) {
    for (const one of report?.testResults ?? []) {
      const name = String(one?.name ?? "");
      const at = name.search(/\/(src|test)\//);
      if (at === -1 || typeof one.startTime !== "number" || typeof one.endTime !== "number") continue;
      times[name.slice(at + 1)] = Math.round((one.endTime - one.startTime) / 100) / 10;
    }
  }
  return times;
}

/** The shard reports in a folder laid out as `gh run download` leaves it: `<artifact>/shard-report.json`. */
function reportsIn(folder) {
  const found = { linux: [], darwin: [] };
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(macos-)?shard-\d+-\d+$/.test(entry.name)) continue;
    const file = join(folder, entry.name, "shard-report.json");
    if (!existsSync(file)) continue;
    found[entry.name.startsWith("macos-") ? "darwin" : "linux"].push(JSON.parse(readFileSync(file, "utf8")));
  }
  return found;
}

const sorted = table => Object.fromEntries(Object.entries(table).sort(([a], [b]) => (a < b ? -1 : 1)));
const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at === -1 ? undefined : args[at + 1]; };

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "refresh") {
    const run = flag(args, "run"), given = flag(args, "from"), repo = flag(args, "repo") ?? "ap9000/toolroll";
    if (run === undefined && given === undefined) { console.error("refresh needs --run <id> or --from <folder>"); process.exit(2); }
    const folder = given ?? mkdtempSync(join(tmpdir(), "ci-timings-"));
    try {
      if (given === undefined) execFileSync("gh", ["run", "download", String(run), "-R", repo, "-D", folder], { stdio: "inherit" });
      const reports = reportsIn(folder);
      const previous = readTimings();
      // A lane that ran only some files (macOS runs its platform lane) keeps the earlier times of the rest.
      const linux = { ...previous.linux, ...timesFromReports(reports.linux) }, darwin = { ...previous.darwin, ...timesFromReports(reports.darwin) };
      if (Object.keys(linux).length === 0) throw new Error("no Linux shard reports found");
      writeFileSync(TIMINGS_FILE, JSON.stringify({ source: run === undefined ? "local reports" : `ci.yml run ${run}`, linux: sorted(linux), darwin: sorted(darwin) }, null, 1) + "\n");
      console.log(`test/timings.json: ${Object.keys(linux).length} Linux and ${Object.keys(darwin).length} macOS files`);
    } finally { if (given === undefined) rmSync(folder, { recursive: true, force: true }); }
  } else if (command === "plan") {
    const platform = flag(args, "platform") ?? "linux", count = Number(flag(args, "shards") ?? 4), lane = flag(args, "lane") ?? "all";
    const { inventory, laneFiles } = await import("./ci-shards.mjs");
    const files = lane === "all" ? inventory(ROOT) : laneFiles(ROOT, lane);
    const { shards } = planShards(files, readTimings(), count, { platform });
    shards.forEach((one, at) => console.log(`shard ${at + 1}/${count}: ${one.total.toFixed(0)} s of files, about ${one.estimate.toFixed(0)} s on ${PLAN_WORKERS[platform]} workers (longest file ${one.longest.toFixed(0)} s)`));
  } else { console.error("usage: ci-timings.mjs refresh --run <id> | plan [--platform linux|darwin] [--shards <K>] [--lane all|macos]"); process.exit(2); }
}
