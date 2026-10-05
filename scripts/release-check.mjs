#!/usr/bin/env node
/**
 * The release check, sized to the change. Typecheck and build always run;
 * after that only what the change can break:
 *
 *   - unit tests related to the changed files (`vitest related <files>`);
 *     the whole suite when test setup, config or dependencies changed
 *   - the browser journeys (every flows-e2e and app-e2e group) only when the
 *     change touches something a page shows: the console, the server that
 *     renders it, the e2e scripts, or dependencies
 *   - the upgrade path (scripts/upgrade-path.mjs) only when the change can break
 *     an update from an installed release: the store, a file that defines a
 *     table (*_SCHEMA), what a newly switched worker or the deploy's facts
 *     check reads first (assignment, dispatch, work-summary, review-switch),
 *     the updaters, or the deploy scripts. Each of the last 3 published
 *     releases, with a realistic database, moves to this candidate through the
 *     deploy's facts check, `toolroll update` and `npm i -g` with no manual
 *     step (needs the npm registry; each release is installed once and cached)
 *   - nothing more for docs, evidence and design notes
 *
 * A package.json or package-lock.json whose only change is the project's own
 * "version" (a release's bump) is not a dependency change; any other change
 * to them is.
 *
 * Everything starts at once when the machine has room: typecheck, build and
 * the unit tests (whose setup waits for this build rather than building
 * again; they ask for room once the build has it); the journeys start when
 * the build is done, flows-e2e and app-e2e each in parallel groups
 * (scripts/e2e-parallel.mjs), together at most 6 browser groups at once.
 * Every start checks memory, macOS kernel pressure (Linux swap) and a provider slot (one cap on real
 * Claude/Codex turns for every suite, default at most 4) through one gate the runners share
 * (check-memory.mjs), so a busy machine makes the check slower, never wrong.
 * The summary says what admission did and records the peak memory.
 *
 * The base is origin/main, fetched fresh; files are compared, not ancestry.
 * No difference from main (or no main) means everything runs. `--full` (or TOOLROLL_FULL_CHECK=1) runs
 * everything, as the check did before. Ends with the same `== summary` block, and how long each part took.
 *
 *   node scripts/release-check.mjs [--full] [--base <ref>] [--plan]
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admissionWords, DEMAND, MAX_GROUPS, memoryWords, openGate, watchMemory } from "./check-memory.mjs";

const args = process.argv.slice(2);
const full = args.includes("--full") || process.env.TOOLROLL_FULL_CHECK === "1";
const planOnly = args.includes("--plan");
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

/** Changes that need every unit test, not just the related ones. */
const WHOLE_UNIT = [/^vitest\.config\./, /^test\//, /^tsconfig/, /^package(-lock)?\.json$/, /^src\/fixtures\//];
/** Changes a page can show, so every browser journey runs. */
const BROWSER = [
  /^src\/browser\//, /^src\/browser-[^/]+\.ts$/, /^src\/workspace[^/]*\.ts$/, /^src\/serve\.ts$/, /^src\/[^/]+-ui\.ts$/,
  /^src\/(mobile-viewport|guarded-html|ledger-view|guides|work-index|lead-status)\.ts$/, /\.css$/, /tailwind/,
  /^scripts\/(app-e2e|flows-e2e|e2e-kit|e2e-parallel|browser-build|postbuild)\.mjs$/, /^package(-lock)?\.json$/,
];
/** Changes an installed release's update to this candidate can trip on (besides any file defining a *_SCHEMA). */
const UPGRADE = [
  /^src\/store\.ts$/, /^src\/(assignment|dispatch|work-summary|review-switch)[^/]*\.ts$/,
  /^src\/(toolroll|desktop|coding)-update[^/]*\.ts$/, /^scripts\/(deploy-[^/]+|upgrade-path)\.mjs$/,
];
/** Whether `text` (a source file) defines a table: a `*_SCHEMA` constant. */
export const definesSchema = text => /^(?:export\s+)?const\s+[A-Z0-9_]+_SCHEMA\b/m.test(text);
/** Changes no test reads. */
const NOTHING = [/\.md$/, /^docs\//, /^evidence\//, /^design\//, /^output\//, /^LICENSE$/, /\.png$/];
/** Where a release bumps the project's own version. */
const VERSIONED = ["package.json", "package-lock.json"];

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

export function planFor(changed, { full: all = false, versionBumps = [], schemaFiles = [] } = {}) {
  if (all) return { unit: "all", browser: true, upgrade: true, upgradeWhy: "a full check", why: "a full check was asked for" };
  const bumped = changed.filter(file => versionBumps.includes(file));
  const bump = bumped.length === 0 ? "" : `; only the version changed in ${bumped.join(" and ")}`;
  const code = changed.filter(file => !NOTHING.some(re => re.test(file)) && !bumped.includes(file));
  if (code.length === 0) return { unit: "none", browser: false, upgrade: false, why: bumped.length === 0 ? "only docs, evidence or design notes changed" : `nothing a test reads changed${bump}` };
  const wholeUnit = code.find(file => WHOLE_UNIT.some(re => re.test(file)));
  const page = code.find(file => BROWSER.some(re => re.test(file)));
  const upgrade = code.find(file => !/\.test\.[cm]?[jt]s$/.test(file) && (UPGRADE.some(re => re.test(file)) || schemaFiles.includes(file)));
  return {
    unit: wholeUnit !== undefined ? "all" : "related",
    browser: page !== undefined,
    upgrade: upgrade !== undefined,
    ...(upgrade !== undefined ? { upgradeWhy: `${upgrade} changed` } : {}),
    why: [
      wholeUnit !== undefined ? `every unit test (${wholeUnit} changed)` : "unit tests related to the change",
      page !== undefined ? `browser journeys (${page} changed)` : "no browser journeys (nothing a page shows changed)",
    ].join("; ") + bump,
  };
}

const run = (label, command, argv, dir, env = {}) => new Promise(done => {
  const log = join(dir, `${label}.log`);
  const at = Date.now();
  const { TOOLROLL_CHECK_GATE: _outer, ...inherited } = process.env;
  const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"], env: { ...inherited, ...env } });
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => chunks.push(chunk));
  child.on("close", code => { writeFileSync(log, Buffer.concat(chunks)); done({ label, code: code ?? 1, log, ms: Date.now() - at }); });
});
/**
 * run(), once the gate has room for `demand`; `admitted` (when given) hears when it has. Its time counts from its start.
 * The gate isn't passed on: what these run (the unit tests' own runners among them) is not part of this check's starts.
 */
const gated = (gate, demand, label, command, argv, dir, env = {}, admitted = () => {}) =>
  gate.hold(label, demand, () => { admitted(); return run(label, command, argv, dir, env); });
/**
 * The browser groups the two journey runs may hold at once, shared out: each gets at least one, and with room for
 * only one in all they run one after the other.
 */
export function journeyShares(slots) {
  if (slots <= 1) return { flows: 1, app: 1, together: false };
  const flows = Math.floor(slots / 2);
  return { flows, app: slots - flows, together: true };
}

const took = ms => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 6000) / 10} min`;

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const started = Date.now();
  const base = baseOf();
  const changed = base === null ? [] : git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean);
  const versionBumps = base === null ? [] : VERSIONED.filter(file => changed.includes(file) && versionOnly(file, tryGit("show", `${base}:${file}`), tryGit("show", `HEAD:${file}`)));
  // No main to compare with, or nothing differs from it (a release of main itself): check everything.
  const schemaFiles = changed.filter(file => /\.[cm]?[jt]s$/.test(file) && existsSync(file) && definesSchema(readFileSync(file, "utf8")));
  const plan = planFor(changed, { full: full || changed.length === 0, versionBumps, schemaFiles });
  // Toolroll's own checkout carries the upgrade path; another project's release check has none.
  const upgrade = plan.upgrade && existsSync(join("scripts", "upgrade-path.mjs"));
  console.log(`Release check against ${base === null ? "nothing (origin/main unknown)" : `origin/main ${base.slice(0, 12)}`} (${changed.length} changed files): ${plan.why}${upgrade ? `; the upgrade path from the last 3 releases and 0.9.11 (${plan.upgradeWhy})` : ""}.`);
  if (planOnly) process.exit(0);

  const memory = watchMemory();
  const dir = mkdtempSync(join(tmpdir(), "release-check-"));
  // One gate for every start of this check, the journey runners' groups included (they find it in TOOLROLL_CHECK_GATE).
  mkdirSync(join(dir, "gate"));
  const gate = openGate({ dir: join(dir, "gate"), log: line => console.log(line) });
  // The unit tests' setup (test/ensure-build.ts) waits for this file: the build's outcome.
  const built = join(dir, "build-outcome");
  const typecheck = gated(gate, DEMAND.typecheck, "typecheck", "npm", ["run", "typecheck"], dir);
  // The unit tests wait for the build, so they ask for room only once the build holds its own: never ahead of it.
  let buildAdmitted;
  const buildStarted = new Promise(done => { buildAdmitted = done; });
  const build = gated(gate, DEMAND.build, "build", "npm", ["run", "build"], dir, {}, () => buildAdmitted()).then(one => {
    // Whole or not at all: written aside, then renamed into place.
    writeFileSync(`${built}.part`, one.code === 0 ? "ok" : `failed (exit ${one.code})`);
    renameSync(`${built}.part`, built);
    return one;
  });
  const unitEnv = { TOOLROLL_RELEASE_BUILD: built };
  const units = [];
  const unit = (...argv) => buildStarted.then(() => gated(gate, DEMAND.unit, "unit", ...argv, dir, unitEnv));
  if (plan.unit === "all") units.push(unit("npm", ["test", "--", "--run", "--reporter=dot"]));
  // The changed files themselves, not `--changed <ref>`: vitest reads that as
  // ancestry (ref...HEAD), which the gate's own commit makes meaningless.
  const sources = changed.filter(file => /\.(?:[cm]?[jt]sx?)$/.test(file) && existsSync(file));
  if (plan.unit === "related" && sources.length > 0) units.push(unit("npx", ["vitest", "related", "--run", "--reporter=dot", "--passWithNoTests", ...sources]));
  // The journeys need the built console; they don't start when the build (or a typecheck already done) failed.
  let typed = null, held = false;
  typecheck.then(one => { typed = one; });
  const journeys = build.then(one => {
    held = plan.browser && (one.code !== 0 || (typed !== null && typed.code !== 0));
    if (!plan.browser || held) return [];
    // The most browser groups at once, shared out; each group still starts only when the gate has room for it.
    const shares = journeyShares(MAX_GROUPS);
    const env = { TOOLROLL_CHECK_GATE: gate.dir };
    const flows = () => run("flows", process.execPath, ["scripts/e2e-parallel.mjs", "scripts/flows-e2e.mjs", "--at-once", String(shares.flows)], dir, env);
    const app = () => run("app", process.execPath, ["scripts/e2e-parallel.mjs", "scripts/app-e2e.mjs", "--skip-build", "--at-once", String(shares.app)], dir, env);
    return shares.together ? Promise.all([flows(), app()]) : flows().then(async one => [one, await app()]);
  });
  // The upgrade path packs the built candidate: it starts once the build passed.
  let upgradeHeld = false;
  const upgraded = build.then(one => {
    upgradeHeld = upgrade && one.code !== 0;
    return upgrade && !upgradeHeld ? [gated(gate, DEMAND.upgrade, "upgrade", process.execPath, ["scripts/upgrade-path.mjs"], dir)] : [];
  }).then(list => Promise.all(list));
  const first = await Promise.all([typecheck, build]);
  const results = [...await Promise.all(units), ...await journeys, ...await upgraded];
  for (const one of [...first, ...results]) { console.log(`== ${one.label}`); console.log(readFileSync(one.log, "utf8")); }
  console.log("== summary");
  console.log(`plan: ${plan.why}`);
  for (const one of first.filter(each => each.code !== 0)) console.log(`${one.label}: exit ${one.code}`);
  for (const one of results) {
    console.log(`${one.label}: exit ${one.code}`);
    const lines = readFileSync(one.log, "utf8").split("\n").filter(line => /FAIL|Test Files|passed, |^[✓✗] |^upgrade path:/.test(line));
    for (const line of lines.slice(-5)) console.log(line);
  }
  if (held) console.log("browser journeys not run: the typecheck or build failed");
  if (upgradeHeld) console.log("upgrade path not run: the build failed");
  if (results.length === 0 && first.every(one => one.code === 0)) console.log("typecheck and build passed; nothing else to run");
  console.log(`took: ${[...first, ...results].map(one => `${one.label} ${took(one.ms)}`).join(", ")}; whole check ${took(Date.now() - started)}`);
  console.log(admissionWords(gate.facts()));
  gate.close();
  console.log(memoryWords(memory.stop()));
  process.exitCode = [...first, ...results].some(one => one.code !== 0) ? 1 : 0;
}
