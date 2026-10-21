#!/usr/bin/env node
/**
 * Release verification: build and typecheck, units (or exact successful CI plus local macOS tests),
 * scripted journeys, a CPU-bounded upgrade sample only for store/schema/migration changes, and
 * real-model journeys only for model-facing changes. --full runs all units, releases and journeys.
 * The first hard failure stops other parts. Every selected part still must pass.
 *
 * node scripts/release-check.mjs [--full] [--real] [--base <ref>] [--plan]
 */
import { execFileSync } from "node:child_process";
import { availableParallelism, loadavg } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateWords, openGate } from "./provider-gate.mjs";
import { passedCandidateCI, macUnitFiles } from "./release-check-ci.mjs";
import { makeTempRoot, runSuite } from "./suite-lifecycle.mjs";

const args = process.argv.slice(2);
const full = args.includes("--full") || process.env.TOOLROLL_FULL_CHECK === "1";
const planOnly = args.includes("--plan");
const real = args.includes("--real");
const baseFlag = args.includes("--base") ? args[args.indexOf("--base") + 1] : undefined;

const git = (...argv) => execFileSync("git", argv, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (...argv) => { try { return git(...argv); } catch { return null; } };

/** A release tag's version as numbers, or null for anything else (v0.9.61 → [0, 9, 61]). */
const versionOf = tag => { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? ""); return m === null ? null : m.slice(1).map(Number); };
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether this checkout's newest reachable release tag is the release before `version` as origin has it. A checkout
 * missing newer tags would silently compare with an old release (and test less), so it is refused in words, as is one
 * whose origin tags can't be read. `remoteTags` null: origin couldn't be read.
 */
export function releaseTagProblem(version, reachable, remoteTags) {
  const wanted = versionOf(version);
  if (wanted === null) return null;
  if (remoteTags === null) return "Couldn't read origin's release tags, so the release before this one is unknown. Check the network and `git ls-remote --tags origin`, then try again (or set TOOLROLL_RELEASE_LOCAL_TAGS=1 to compare with this checkout's tags).";
  const previous = remoteTags.map(tag => ({ tag, at: versionOf(tag) })).filter(one => one.at !== null && compare(one.at, wanted) < 0).sort((a, b) => compare(b.at, a.at))[0];
  if (previous === undefined) return null;
  const have = versionOf(reachable);
  if (have !== null && compare(have, previous.at) >= 0) return null;
  return `This checkout's newest release tag is ${reachable ?? "none"}, but origin has ${previous.tag}: the check would compare with an older release. Run \`git fetch --tags origin\`, then try again.`;
}

/** Origin's release tags, after fetching them (best effort); null when origin can't be read. */
function originTags() {
  tryGit("fetch", "--tags", "--quiet", "origin");
  const listed = tryGit("ls-remote", "--tags", "--refs", "origin", "v*");
  return listed === null ? null : listed.split("\n").map(line => line.split("\t")[1]?.replace(/^refs\/tags\//, "")).filter(Boolean);
}

/**
 * Compare the candidate with its most recent reachable release, including
 * lightweight tags. A version-only release commit still checks code merged
 * since that release. Missing tags conservatively select the full suite.
 */
function baseOf() {
  if (baseFlag !== undefined) return baseFlag;
  return tryGit("describe", "--tags", "--match", "v*", "--abbrev=0", "HEAD");
}

/** Model-facing code: a change here runs the real-model journeys (the lead and its tools, chat, the planner, the builder,
 * subagents, task sizing and sorting, the provider adapters and how a turn is run and read). */
const MODEL = [
  /^src\/(lead|converse|subscription-chat|chat-[a-z-]+|lead-[a-z-]+|memory-pass)\.ts$/,
  /^src\/(planner|planner-[a-z-]+|plan|builder|build-review|reviewer|scout|scout-[a-z-]+|decision|evidence)\.ts$/,
  /^src\/(subagents|subagent-work|task-sizing|flow-sort|flow-draft)\.ts$/,
  /^src\/(provider|provider-[a-z-]+|invoke|exec|attest|coding-provider|assignment-adapters|subscription-[a-z-]+)\.ts$/,
];
/** Changes no test reads. */
const NOTHING = [/\.md$/, /^docs\//, /^evidence\//, /^design\//, /^output\//, /^LICENSE$/, /\.png$/];
/** Where a release bumps the project's own version. */
const VERSIONED = ["package.json", "package-lock.json"];
/** Browser groups at once, for each journey script. */
export const LANES = { flows: 2, app: 4 };

/**
 * Whether `file` changed from `before` to `after` only in the project's own version: the top-level "version" (and, in
 * the lockfile, the root package's). Anything else — a dependency, a script, a reordering, a file added or removed —
 * is a real change.
 */
export function versionOnly(file, before, after) {
  if (!VERSIONED.includes(file) || typeof before !== "string" || typeof after !== "string") return false;
  const rest = text => {
    const json = JSON.parse(text);
    if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("not an object");
    delete json.version;
    if (file === "package-lock.json" && json.packages?.[""] !== undefined) delete json.packages[""].version;
    return JSON.stringify(json);
  };
  try { return rest(before) === rest(after); } catch { return false; }
}

/**
 * What runs: `checks` (the unit suite and every scripted journey) for any change beyond docs and a
 * version bump; `real`, the real-model journeys, for model-facing code, --real or a full check. `journeys` is false in
 * a checkout without journey scripts.
 */
export function planFor(changed, { full: all = false, real = false, versionBumps = [], journeys = true } = {}) {
  const bumped = all ? [] : changed.filter(file => versionBumps.includes(file));
  const code = changed.filter(file => !NOTHING.some(re => re.test(file)) && !bumped.includes(file));
  const checks = all || code.length > 0;
  const model = code.find(file => !/\.test\.[cm]?[jt]s$/.test(file) && MODEL.some(re => re.test(file)));
  const realWhy = all ? "a full check" : real ? "--real" : model === undefined ? null : `${model} changed: model-facing`;
  const bump = bumped.length === 0 ? "" : `; only the version changed in ${bumped.join(" and ")}`;
  const units = journeys ? "every unit test and every scripted browser journey" : "every unit test";
  if (all) return { checks, real: true, why: `a full check: every unit test${journeys ? ", every scripted and real-model browser journey" : ""}` };
  if (!checks && realWhy === null) return { checks, real: false, why: bumped.length === 0 ? "only docs, evidence or design notes changed" : `nothing a test reads changed${bump}` };
  return {
    checks, real: realWhy !== null,
    why: [
      checks ? units : "no unit tests or scripted journeys (nothing a test reads changed)",
      ...!journeys ? [] : [realWhy === null ? "no real-model journeys (no model-facing code changed; --real runs them)" : `the real-model journeys and what they need (${realWhy})`],
    ].join("; ") + bump,
  };
}

/** Skip only paths known not to affect upgrades. Unknown runtime code runs upgrades:
 * this includes the entire store import graph, SQL-bearing modules and updaters,
 * without maintaining a second, inevitably incomplete dependency graph.
 */
export function needsUpgrade(changed, full = false, versionBumps = []) {
  return full || changed === null || changed.some(file => {
    if (versionBumps.includes(file) && VERSIONED.includes(file)) return false;
    if (/^(docs|evidence|design|output)\//.test(file) || /\.md$/.test(file) || file === "LICENSE") return false;
    if (/\.test\.[cm]?[jt]sx?$/.test(file) || /^test\//.test(file)) return false;
    if (/^src\/(browser|design)\//.test(file) || /\.css$/.test(file)) return false;
    // Standalone journeys are not imported by the upgrade runner. Other scripts,
    // including its provider gate and lifecycle helpers, conservatively run it.
    if (/^scripts\/(app-e2e|flows-e2e|e2e-parallel)\.mjs$/.test(file)) return false;
    return true;
  });
}

/** NUL separators preserve filenames; failed history or untracked discovery runs upgrades. No rename pairing: a
 * file moved out of a migration path still lists its old path, so the move can't hide it. */
export function upgradeChanges(base, readGit) {
  if (base === null) return null;
  try {
    return [...new Set([
      ...readGit("diff", "--no-renames", "--name-only", "-z", base).split("\0"),
      ...readGit("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
    ].filter(Boolean))];
  } catch { return null; }
}

/** Scripted failures are final; real-model runs retain their normal retry policy. */
export function journeyEnv(kind, gate, env = process.env) {
  return kind === "real" ? {
    TOOLROLL_RELEASE_FAIL_FAST: undefined,
    TOOLROLL_RELEASE_SCRIPTED_TIMEOUT_SECONDS: undefined,
    TOOLROLL_CHECK_GATE: gate.dir,
  } : {
    TOOLROLL_RELEASE_FAIL_FAST: "1",
    TOOLROLL_RELEASE_SCRIPTED_TIMEOUT_SECONDS: env.TOOLROLL_CHECK_SCRIPTED_TIMEOUT_SECONDS || "90",
  };
}

/**
 * One concurrency budget for the whole check (docs/plans/heavy-jobs.md v2): the machine's cores, less what is already
 * running on it, shared out — half to the unit suite's workers, the rest to browser lanes and upgrade workers — so the
 * check never makes its own load (the 2026-10-20 release failed twice on a machine at load 21/24). It changes how fast
 * the check runs, never what passes: every part still must pass, nothing is retried to hide a failure. `load` NaN
 * (not measured: Windows reports 0 and is treated as unmeasured) budgets from the cores alone.
 */
export function checkBudget(cores, load = Number.NaN, upgradeLimit = Number.POSITIVE_INFINITY) {
  const busy = Number.isFinite(load) && load > 0 ? Math.floor(load) : 0;
  const free = Math.max(2, Math.floor(cores * 0.75) - busy);
  // Shared out of one remaining total, so the shares never add up to more than the budget: one for the typecheck
  // (it may still run beside everything else), half the rest to the units, then half of what is left to the app's
  // browser lanes, then the flows' lanes, the rest to upgrade workers (never more than an explicitly stricter
  // TOOLROLL_UPGRADE_WORKERS).
  const shared = free - 1;
  const unitWorkers = Math.max(1, Math.floor(shared / 2));
  let left = shared - unitWorkers;
  const app = Math.max(1, Math.min(LANES.app, Math.floor(left / 2))); left -= app;
  const flows = Math.max(1, Math.min(LANES.flows, Math.floor(left / 2))); left -= flows;
  const upgradeWorkers = Math.max(1, Math.min(4, upgradeLimit, left));
  // Each part needs at least one: when even that doesn't fit, the parts run one after another instead of together.
  const sequential = 1 + unitWorkers + app + flows + upgradeWorkers > free;
  return { free, unitWorkers, lanes: { app, flows }, upgradeWorkers, sequential };
}

/** The machine's one-minute load, or NaN where it isn't measured (Windows always reports 0). */
export const machineLoad = (platform = process.platform, read = loadavg) => platform === "win32" ? Number.NaN : read()[0];

/** Busy: the load is past 85% of the cores. Unmeasured is never busy. */
export const machineBusy = (load, cores) => Number.isFinite(load) && load / cores > 0.85;

/** The load the check ran under, in one line: what it started at, its peak and mean, and the budget it chose. */
export function loadWords(samples, cores, budget) {
  const measured = samples.filter(Number.isFinite);
  const shares = `budget ${budget.free} of ${cores} cores: ${budget.unitWorkers} unit workers, ${budget.lanes.app} app and ${budget.lanes.flows} flows browser lanes, ${budget.upgradeWorkers} upgrade workers${budget.sequential ? ", one part after another" : ""}`;
  if (measured.length === 0) return `load: not measured on this platform; ${shares}`;
  const peak = Math.max(...measured), mean = measured.reduce((a, b) => a + b, 0) / measured.length;
  return `load: ${measured[0].toFixed(1)} at start, peak ${peak.toFixed(1)}, mean ${mean.toFixed(1)} on ${cores} cores; ${shares}`;
}

/** A part runs past this, and it is stopped (with everything it started) and fails. */
const PART_MS = (Number(process.env.TOOLROLL_CHECK_PART_MINUTES) || 120) * 60_000;
export function partRunner(dir, { timeoutMs = PART_MS, graceMs = 15_000 } = {}) {
  const abort = new AbortController();
  let failure = null;
  const fail = (label, detail) => {
    if (failure !== null) return;
    failure = `${label}: ${detail}`;
    console.error(`Release check failed: ${failure}; stopping other parts`);
    abort.abort();
  };
  const run = (label, command, argv, env = {}) => {
    let partial = "";
    return runSuite({ command, args: argv, env: { TOOLROLL_CHECK_GATE: undefined, ...env },
      signal: abort.signal, prefix: `so-check-${label}-`, timeoutMs, graceMs, tempRoot: partTempRoot(label),
      onExit: code => { if (code !== 0) fail(label, `exit ${code}`); },
      onData: chunk => {
        const lines = (partial + chunk).split("\n"); partial = lines.pop();
        for (const line of lines) if (/^(app|flows)(-real)?$|^upgrade$/.test(label) && line.includes("TOOLROLL_CHECK_FAILURE ")) fail(label, line.slice(line.indexOf("TOOLROLL_CHECK_FAILURE ") + 23));
      },
    }).then(one => {
      const log = join(dir, `${label}.log`);
      writeFileSync(log, one.timedOut ? Buffer.concat([one.output, Buffer.from(`\n${label} timed out and was stopped\n`)]) : one.output);
      return { label, code: one.code, log, ms: one.ms };
    });
  };
  return { run, signal: abort.signal, failure: () => failure };
}
// Units and browser lanes make their own roots. An outer root adds a redundant level to their Unix socket paths.
export const partTempRoot = label => !/^(unit|app|flows)(-|$)/.test(label);

const took = ms => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 6000) / 10} min`;

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const started = Date.now();
  // Newer release tags first: a checkout without them would quietly compare with an old release.
  if (process.env.TOOLROLL_RELEASE_LOCAL_TAGS !== "1") {
    let version = null;
    try { version = JSON.parse(readFileSync("package.json", "utf8")).version ?? null; } catch { version = null; }
    // Fetched before the newest reachable tag is read.
    const remote = version === null ? [] : originTags();
    const problem = releaseTagProblem(version, tryGit("describe", "--tags", "--match", "v*", "--abbrev=0", "HEAD"), remote);
    if (problem !== null) { console.error(problem); process.exit(1); }
  }
  const base = baseOf();
  const diff = base === null ? null : tryGit("diff", "--name-only", base);
  const changed = diff === null ? [] : diff.split("\n").filter(Boolean);
  const versionBumps = base === null ? [] : VERSIONED.filter(file => changed.includes(file) && versionOnly(file, tryGit("show", `${base}:${file}`), (() => { try { return readFileSync(file, "utf8"); } catch { return null; } })()));
  // Toolroll's own checkout carries the journey scripts and the upgrade path; another project's release check has none.
  const scripts = existsSync(join("scripts", "flows-e2e.mjs")) && existsSync(join("scripts", "app-e2e.mjs"));
  // No release comparison, or no difference: retain the full unit/journey selection.
  // Upgrades independently use the last release tag and --full below.
  const plan = planFor(changed, { full: full || changed.length === 0, real, versionBumps, journeys: scripts });
  // --base can narrow the ordinary comparison, never the migration safety comparison.
  const releaseBase = tryGit("describe", "--tags", "--match", "v*", "--abbrev=0", "HEAD");
  const upgradeDiff = upgradeChanges(releaseBase, git);
  const upgradeBumps = releaseBase === null ? [] : VERSIONED.filter(file => versionOnly(file, tryGit("show", `${releaseBase}:${file}`), (() => { try { return readFileSync(file, "utf8"); } catch { return null; } })()));
  const upgrade = needsUpgrade(upgradeDiff, full, upgradeBumps)
    && existsSync(join("scripts", "upgrade-path.mjs"));
  console.log(`Release check against ${base === null ? "nothing (no reachable v* release tag)" : base} (${changed.length} changed files): ${plan.why}${upgrade ? full ? "; the upgrade path from every release since 0.5.0" : "; upgrade path: last five release tags, baseline and 0.5.0" : ""}.`);
  if (planOnly) process.exit(0);

  // A busy machine first gets up to five minutes to quieten (said, never silently): the check's own load comes on top.
  // TOOLROLL_CHECK_CORES / TOOLROLL_CHECK_LOAD stand in for the machine (tests make the budget exact with them).
  const cores = Number(process.env.TOOLROLL_CHECK_CORES) > 0 ? Number(process.env.TOOLROLL_CHECK_CORES) : availableParallelism();
  const loadNow = () => process.env.TOOLROLL_CHECK_LOAD !== undefined && process.env.TOOLROLL_CHECK_LOAD !== "" ? Number(process.env.TOOLROLL_CHECK_LOAD) : machineLoad();
  for (const waitStarted = Date.now(); machineBusy(loadNow(), cores) && Date.now() - waitStarted < 5 * 60_000;) {
    console.log(`The machine is busy (load ${loadNow().toFixed(1)} on ${cores} cores); waiting for it to quieten before starting (up to 5 min).`);
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
  const explicitUpgrade = Number(process.env.TOOLROLL_UPGRADE_WORKERS);
  const budget = checkBudget(cores, loadNow(), Number.isInteger(explicitUpgrade) && explicitUpgrade > 0 ? explicitUpgrade : Number.POSITIVE_INFINITY);
  const samples = [loadNow()];
  const sampler = setInterval(() => samples.push(loadNow()), 15_000);
  sampler.unref();
  console.log(loadWords(samples, cores, budget));
  // Each journey run: a script, scripted or real-model, in every group with journeys of that kind.
  const journeyRuns = !scripts ? [] : [
    ["flows", "scripted", plan.checks], ["app", "scripted", plan.checks], ["flows-real", "real", plan.real], ["app-real", "real", plan.real],
  ].filter(([, , runs]) => runs).map(([label, kind]) => {
    const script = label.replace(/-real$/, "");
    return { label, kind, argv: [`scripts/${script}-e2e.mjs`, ...(script === "app" ? ["--skip-build"] : []), "--journeys", kind, "--at-once", String(budget.lanes[script])] };
  });
  // The logs and the build's outcome; removed when the check ends, however it ends.
  const ci = plan.checks ? passedCandidateCI({ full, git }) : { passed: false, why: "no unit suite selected" };
  let localUnits = [];
  if (ci.passed && process.platform === "darwin") {
    try { localUnits = macUnitFiles(); if (localUnits.length === 0) throw Error("no macOS tests found"); }
    catch { ci.passed = false; ci.why = "macOS test selection unreadable; running all units"; }
  }
  console.log(`Units: ${ci.passed ? "reuse CI; macOS tests still run locally" : "local"} (${ci.why}).`);
  const dir = makeTempRoot("release-check-");
  const parts = partRunner(dir), run = parts.run;
  // One provider gate for both real-model runners (they find it in TOOLROLL_CHECK_GATE); scripted runs take none.
  let gate = null;
  if (journeyRuns.some(each => each.kind === "real")) {
    mkdirSync(join(dir, "gate"));
    try { gate = openGate({ dir: join(dir, "gate"), reserve: true, env: { TOOLROLL_CHECK_PROVIDERS: process.env.TOOLROLL_CHECK_PROVIDERS || "4" } }); } catch (error) { console.error(error.message); process.exit(2); }
  }
  // The unit tests' setup (test/ensure-build.ts) waits for this file: the build's outcome.
  const built = join(dir, "build-outcome");
  const typecheck = run("typecheck", "npm", ["run", "typecheck"]);
  const build = run("build", "npm", ["run", "build"]).then(one => {
    // Whole or not at all: written aside, then renamed into place.
    writeFileSync(`${built}.part`, one.code === 0 ? "ok" : `failed (exit ${one.code})`);
    renameSync(`${built}.part`, built);
    return one;
  });
  const units = plan.checks && (!ci.passed || localUnits.length > 0)
    ? [run("unit", "npm", ["run", "test:all", "--", "--run", "--reporter=dot", `--maxWorkers=${budget.unitWorkers}`, ...localUnits], { TOOLROLL_RELEASE_BUILD: built })] : [];
  // The journeys need the built console; they don't start when the build (or a typecheck already done) failed.
  let typed = null, held = false;
  typecheck.then(one => { typed = one; });
  const journeys = build.then(async one => {
    // Too little room for every part at once: the journeys wait for the typecheck and the units.
    if (budget.sequential) { await typecheck; await Promise.all(units); }
    held = journeyRuns.length > 0 && (parts.signal.aborted || one.code !== 0 || (typed !== null && typed.code !== 0));
    if (held) return [];
    const journey = each => run(each.label, process.execPath, ["scripts/e2e-parallel.mjs", ...each.argv, "--output", join("evidence", `release-${process.pid}`, each.label)], journeyEnv(each.kind, gate));
    // Two waves: the scripted journeys (and the units beside them) first, then the real-model ones, which wait mostly on
    // the provider and need the least of the machine.
    return Promise.all(journeyRuns.filter(each => each.kind === "scripted").map(journey)).then(async scripted => {
      await Promise.all(units);
      if (parts.signal.aborted) return scripted;
      return [...scripted, ...await Promise.all(journeyRuns.filter(each => each.kind === "real").map(journey))];
    });
  });
  // The upgrade path packs the built candidate: it starts once the build passed.
  let upgradeHeld = false;
  const upgraded = build.then(async one => {
    // …and the upgrade path waits for the journeys.
    if (budget.sequential) await journeys;
    upgradeHeld = upgrade && (parts.signal.aborted || one.code !== 0);
    return upgrade && !upgradeHeld ? [run("upgrade", process.execPath, ["scripts/upgrade-path.mjs", ...(full ? ["--full"] : [])], { TOOLROLL_UPGRADE_WORKERS: String(budget.upgradeWorkers) })] : [];
  }).then(list => Promise.all(list));
  const first = await Promise.all([typecheck, build]);
  const results = [...await Promise.all(units), ...await journeys, ...await upgraded];
  for (const one of [...first, ...results]) { console.log(`== ${one.label}`); console.log(readFileSync(one.log, "utf8")); }
  console.log("== summary");
  console.log(`plan: ${plan.why}`);
  if (parts.failure()) console.log(`failed: ${parts.failure()}`);
  if (ci.passed) console.log(`unit suite reused: ${ci.why}; ${localUnits.length} macOS files run locally`);
  if (!upgrade) console.log("upgrade path not run: no store, migration or schema changes");
  for (const one of first.filter(each => each.code !== 0)) console.log(`${one.label}: exit ${one.code}`);
  for (const one of results) {
    console.log(`${one.label}: exit ${one.code}`);
    const lines = readFileSync(one.log, "utf8").split("\n").filter(line => /FAIL|Test Files|passed, |^[✓✗] |^upgrade path:|^Model calls:|^No .*journeys to run/.test(line));
    for (const line of lines.slice(-5)) console.log(line);
  }
  if (held) console.log("browser journeys not run: the typecheck or build failed");
  if (upgradeHeld) console.log("upgrade path not run: the build failed");
  if (results.length === 0 && first.every(one => one.code === 0)) console.log("typecheck and build passed; nothing else to run");
  // The load it ran under, so a failure on a busy machine can be judged — never used to excuse one.
  clearInterval(sampler);
  console.log(loadWords(samples, cores, budget));
  console.log(`took: ${[...first, ...results].map(one => `${one.label} ${took(one.ms)}`).join(", ")}; whole check ${took(Date.now() - started)}`);
  if (gate !== null) { console.log(gateWords(gate.facts())); gate.close(); }
  process.exitCode = parts.failure() !== null || [...first, ...results].some(one => one.code !== 0) ? 1 : 0;
}
