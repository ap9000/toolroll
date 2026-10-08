#!/usr/bin/env node
/**
 * The release check. Docs, evidence and design notes alone run nothing; any other change runs it all:
 *
 *   - typecheck and build
 *   - every unit test (`npm test`), started beside the build: its setup waits for this build's outcome
 *     (TOOLROLL_RELEASE_BUILD) rather than building again
 *   - every scripted browser journey (scripts/flows-e2e.mjs and app-e2e.mjs, the model scripted by
 *     scripts/fixtures/scripted-provider.mjs), each script's groups through scripts/e2e-parallel.mjs: flows 2 at once,
 *     app 4 at once
 *   - the upgrade path (scripts/upgrade-path.mjs): each of the last 3 published releases, with a realistic database,
 *     moves to this candidate through the deploy's facts check, `toolroll update` and `npm i -g` with no manual step
 *     (needs the npm registry; each release is installed once and cached)
 *   - the real-model journeys only when model-facing code changed (the lead, chat, mate tools, the planner, the
 *     builder, teammates, the provider adapters) or --real is given: every group with real-model journeys, and the
 *     journeys they need, each real turn under one cap shared by both runners (scripts/provider-gate.mjs, default at
 *     most 4; TOOLROLL_CHECK_PROVIDERS). The nightly journeys flow (scripts/flows/real-model-journeys.mjs) runs every
 *     journey with real models
 *
 * A package.json or package-lock.json whose only change is the project's own "version" (a release's bump) counts as
 * nothing; any other change to them is a change. The journeys and the upgrade path start once the build passed (the
 * journeys not when the typecheck already failed).
 *
 * The base is origin/main, fetched fresh; files are compared, not ancestry. No difference from main (or no main)
 * means everything runs. `--full` (or TOOLROLL_FULL_CHECK=1) runs everything, the real-model journeys too. `--real`
 * adds the real-model journeys to whatever the change runs. `--plan` prints the plan and stops. Ends with the same
 * `== summary` block, and how long each part took.
 *
 * Nothing stays behind (scripts/suite-lifecycle.mjs): each part runs in a process group and temp folder of its own,
 * stopped and removed when it ends, when it runs past TOOLROLL_CHECK_PART_MINUTES (default 120) or when the check is
 * interrupted; the check's own folder of logs goes once the summary is printed.
 *
 *   node scripts/release-check.mjs [--full] [--real] [--base <ref>] [--plan]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateWords, openGate } from "./provider-gate.mjs";
import { makeTempRoot, runSuite } from "./suite-lifecycle.mjs";

const args = process.argv.slice(2);
const full = args.includes("--full") || process.env.TOOLROLL_FULL_CHECK === "1";
const planOnly = args.includes("--plan");
const real = args.includes("--real");
const baseFlag = args.includes("--base") ? args[args.indexOf("--base") + 1] : undefined;

const git = (...argv) => execFileSync("git", argv, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
const tryGit = (...argv) => { try { return git(...argv); } catch { return null; } };

/**
 * What to compare against: main as GitHub has it now. The gate checks out a
 * commit of its own (the candidate's files on the checkout's local main), so
 * ancestry says nothing — compare the files. A candidate behind main counts
 * main's newer changes too, which only ever runs more.
 */
function baseOf() {
  if (baseFlag !== undefined) return baseFlag;
  tryGit("fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main");
  return tryGit("rev-parse", "--verify", "-q", "origin/main");
}

/** Model-facing code: a change here runs the real-model journeys (the lead, chat, mate tools, the planner, the builder,
 * teammates, task sizing and sorting, the provider adapters and how a turn is run and read). */
const MODEL = [
  /^src\/(mate|mate-[a-z-]+|converse|subscription-chat|chat-[a-z-]+|lead-[a-z-]+|memory-pass)\.ts$/,
  /^src\/(planner|planner-[a-z-]+|plan|builder|build-review|reviewer|scout|scout-[a-z-]+|decision|evidence)\.ts$/,
  /^src\/(teammates|teammate-work|task-sizing|flow-sort|flow-draft)\.ts$/,
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
 * What runs: `checks` (every unit test, every scripted journey, the upgrade path) for any change beyond docs and a
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

/** A part runs past this, and it is stopped (with everything it started) and fails. */
const PART_MS = (Number(process.env.TOOLROLL_CHECK_PART_MINUTES) || 120) * 60_000;
// An outer check's gate is not this one's: a part only gets the gate this check hands it (env).
const run = (label, command, argv, dir, env = {}) => runSuite({ command, args: argv, env: { TOOLROLL_CHECK_GATE: undefined, ...env }, prefix: `so-check-${label}-`, timeoutMs: PART_MS, graceMs: 15_000, tempRoot: partTempRoot(label) }).then(one => {
  const log = join(dir, `${label}.log`);
  writeFileSync(log, one.timedOut ? Buffer.concat([one.output, Buffer.from(`\n${label} ran past ${Math.round(PART_MS / 60_000)} min and was stopped\n`)]) : one.output);
  return { label, code: one.code, log, ms: one.ms };
});
// Units and browser lanes make their own roots. An outer root adds a redundant level to their Unix socket paths.
export const partTempRoot = label => !/^(unit|app|flows)(-|$)/.test(label);

const took = ms => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 6000) / 10} min`;

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const started = Date.now();
  const base = baseOf();
  const changed = base === null ? [] : git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean);
  const versionBumps = base === null ? [] : VERSIONED.filter(file => changed.includes(file) && versionOnly(file, tryGit("show", `${base}:${file}`), tryGit("show", `HEAD:${file}`)));
  // Toolroll's own checkout carries the journey scripts and the upgrade path; another project's release check has none.
  const scripts = existsSync(join("scripts", "flows-e2e.mjs")) && existsSync(join("scripts", "app-e2e.mjs"));
  // No main to compare with, or nothing differs from it (a release of main itself): check everything.
  const plan = planFor(changed, { full: full || changed.length === 0, real, versionBumps, journeys: scripts });
  const upgrade = plan.checks && existsSync(join("scripts", "upgrade-path.mjs"));
  console.log(`Release check against ${base === null ? "nothing (origin/main unknown)" : `origin/main ${base.slice(0, 12)}`} (${changed.length} changed files): ${plan.why}${upgrade ? "; the upgrade path from the last 3 releases and 0.9.11" : ""}.`);
  if (planOnly) process.exit(0);

  // Each journey run: a script, scripted or real-model, in every group with journeys of that kind.
  const journeyRuns = !scripts ? [] : [
    ["flows", "scripted", plan.checks], ["app", "scripted", plan.checks], ["flows-real", "real", plan.real], ["app-real", "real", plan.real],
  ].filter(([, , runs]) => runs).map(([label, kind]) => {
    const script = label.replace(/-real$/, "");
    return { label, kind, argv: [`scripts/${script}-e2e.mjs`, ...(script === "app" ? ["--skip-build"] : []), "--journeys", kind, "--at-once", String(LANES[script])] };
  });
  // The logs and the build's outcome; removed when the check ends, however it ends.
  const dir = makeTempRoot("release-check-");
  // One provider gate for both real-model runners (they find it in TOOLROLL_CHECK_GATE); scripted runs take none.
  let gate = null;
  if (journeyRuns.some(each => each.kind === "real")) {
    mkdirSync(join(dir, "gate"));
    try { gate = openGate({ dir: join(dir, "gate") }); } catch (error) { console.error(error.message); process.exit(2); }
  }
  // The unit tests' setup (test/ensure-build.ts) waits for this file: the build's outcome.
  const built = join(dir, "build-outcome");
  const typecheck = run("typecheck", "npm", ["run", "typecheck"], dir);
  const build = run("build", "npm", ["run", "build"], dir).then(one => {
    // Whole or not at all: written aside, then renamed into place.
    writeFileSync(`${built}.part`, one.code === 0 ? "ok" : `failed (exit ${one.code})`);
    renameSync(`${built}.part`, built);
    return one;
  });
  const units = plan.checks ? [run("unit", "npm", ["test", "--", "--run", "--reporter=dot"], dir, { TOOLROLL_RELEASE_BUILD: built })] : [];
  // The journeys need the built console; they don't start when the build (or a typecheck already done) failed.
  let typed = null, held = false;
  typecheck.then(one => { typed = one; });
  const journeys = build.then(one => {
    held = journeyRuns.length > 0 && (one.code !== 0 || (typed !== null && typed.code !== 0));
    if (held) return [];
    return Promise.all(journeyRuns.map(each => run(each.label, process.execPath, ["scripts/e2e-parallel.mjs", ...each.argv, "--output", join("evidence", `release-${process.pid}`, each.label)], dir, each.kind === "real" ? { TOOLROLL_CHECK_GATE: gate.dir } : {})));
  });
  // The upgrade path packs the built candidate: it starts once the build passed.
  let upgradeHeld = false;
  const upgraded = build.then(one => {
    upgradeHeld = upgrade && one.code !== 0;
    return upgrade && !upgradeHeld ? [run("upgrade", process.execPath, ["scripts/upgrade-path.mjs"], dir)] : [];
  }).then(list => Promise.all(list));
  const first = await Promise.all([typecheck, build]);
  const results = [...await Promise.all(units), ...await journeys, ...await upgraded];
  for (const one of [...first, ...results]) { console.log(`== ${one.label}`); console.log(readFileSync(one.log, "utf8")); }
  console.log("== summary");
  console.log(`plan: ${plan.why}`);
  for (const one of first.filter(each => each.code !== 0)) console.log(`${one.label}: exit ${one.code}`);
  for (const one of results) {
    console.log(`${one.label}: exit ${one.code}`);
    const lines = readFileSync(one.log, "utf8").split("\n").filter(line => /FAIL|Test Files|passed, |^[✓✗] |^upgrade path:|^Model calls:|^No .*journeys to run/.test(line));
    for (const line of lines.slice(-5)) console.log(line);
  }
  if (held) console.log("browser journeys not run: the typecheck or build failed");
  if (upgradeHeld) console.log("upgrade path not run: the build failed");
  if (results.length === 0 && first.every(one => one.code === 0)) console.log("typecheck and build passed; nothing else to run");
  console.log(`took: ${[...first, ...results].map(one => `${one.label} ${took(one.ms)}`).join(", ")}; whole check ${took(Date.now() - started)}`);
  if (gate !== null) { console.log(gateWords(gate.facts())); gate.close(); }
  process.exitCode = [...first, ...results].some(one => one.code !== 0) ? 1 : 0;
}
