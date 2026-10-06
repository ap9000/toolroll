#!/usr/bin/env node
/**
 * The release check, sized to the change. Typecheck and build always run;
 * after that only what the change can break:
 *
 *   - unit tests related to the changed files (`vitest related <files>`);
 *     the whole suite when test setup, config or dependencies changed
 *   - the scripted browser journeys (scripts/flows-e2e.mjs and app-e2e.mjs,
 *     with the model scripted: scripts/fixtures/scripted-provider.mjs) only
 *     when the change touches something a page shows: the console, the server
 *     that renders it, the e2e scripts, or dependencies. A page with clear
 *     journeys (the flow pages, the teammate and kit pages, first run, one
 *     e2e script) runs just those groups; anything else runs every group
 *   - the real-model journeys (the lead's real turns, the planner and builder
 *     protocols, the classifier), and the journeys they need, only when
 *     model-facing code changed (the lead, chat, mate tools, the planner, the
 *     builder, teammates, the provider adapters) or --real is given. The
 *     nightly journeys flow (scripts/flows/real-model-journeys.mjs) runs every
 *     journey with real models
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
 * the build is done: flows-e2e and app-e2e, scripted and real-model, each in
 * parallel groups (scripts/e2e-parallel.mjs), together at most 6 browser groups at once.
 * Every start checks memory, macOS kernel pressure (Linux swap) and a provider slot (one cap on real
 * Claude/Codex turns for every suite, default at most 4) through one gate the runners share
 * (check-memory.mjs), so a busy machine makes the check slower, never wrong.
 * The summary says what admission did, records the peak memory and the model calls the journeys made
 * (scripted, and real turns).
 *
 * The base is origin/main, fetched fresh; files are compared, not ancestry.
 * No difference from main (or no main) means everything runs. `--full` (or TOOLROLL_FULL_CHECK=1) runs
 * everything: every unit test, every scripted and every real-model journey. `--real` adds the real-model journeys
 * to whatever the change runs. Ends with the same `== summary` block, and how long each part took.
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
import { admissionWords, appLanes, DEMAND, laneWords, MAX_GROUPS, memoryWords, openGate, readSample, watchMemory } from "./check-memory.mjs";
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

/** Changes that need every unit test, not just the related ones. */
const WHOLE_UNIT = [/^vitest\.config\./, /^test\//, /^tsconfig/, /^package(-lock)?\.json$/, /^src\/fixtures\//];
/** Changes a page can show, so every browser journey runs. */
const BROWSER = [
  /^src\/browser\//, /^src\/browser-[^/]+\.ts$/, /^src\/workspace[^/]*\.ts$/, /^src\/serve\.ts$/, /^src\/[^/]+-ui\.ts$/,
  /^src\/(mobile-viewport|guarded-html|ledger-view|guides|work-index|lead-status)\.ts$/, /\.css$/, /tailwind/,
  /^scripts\/(app-e2e|flows-e2e|e2e-kit|e2e-parallel|browser-build|postbuild)\.mjs$/, /^scripts\/fixtures\/scripted-provider\.mjs$/, /^package(-lock)?\.json$/,
];
/**
 * Pages whose journeys are clear: a change to one runs just these groups' scripted journeys ("all": every group of
 * that script). A change to any other page runs every scripted group.
 */
export const AREAS = [
  { what: "the flow pages", paths: [/^src\/(flows|flow-[a-z-]+)-ui\.ts$/, /^src\/browser\/views\/flow-view\.tsx$/], flows: ["steps", "triggers"], app: ["flows", "mail", "maya", "rosa", "memory"] },
  { what: "the teammate and kit pages", paths: [/^src\/(teammates|kits)-ui\.ts$/], flows: [], app: ["maya", "rosa", "memory", "flows"] },
  { what: "the first-run page", paths: [/^src\/browser\/first-run\.tsx$/], flows: [], app: ["onboarding"] },
  { what: "the flows journeys", paths: [/^scripts\/flows-e2e\.mjs$/], flows: "all", app: [] },
  { what: "the app journeys", paths: [/^scripts\/app-e2e\.mjs$/], flows: [], app: "all" },
];
/** Model-facing code: a change here runs the real-model journeys (the lead, chat, mate tools, the planner, the builder,
 * teammates, task sizing and sorting, the provider adapters and how a turn is run and read). */
const MODEL = [
  /^src\/(mate|mate-[a-z-]+|converse|subscription-chat|chat-[a-z-]+|lead-[a-z-]+|memory-pass)\.ts$/,
  /^src\/(planner|planner-[a-z-]+|plan|builder|build-review|reviewer|scout|scout-[a-z-]+|decision|evidence|held)\.ts$/,
  /^src\/(teammates|teammate-work|task-sizing|flow-sort|flow-draft)\.ts$/,
  /^src\/(provider|provider-[a-z-]+|invoke|exec|attest|coding-provider|assignment-adapters|subscription-[a-z-]+)\.ts$/,
  /^src\/supervisor\.mjs$/,
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

/** The groups of both journey scripts, as `--groups --json` lists them. */
export function journeyGroups() {
  const list = script => JSON.parse(execFileSync(process.execPath, [script, "--groups", "--json"], { encoding: "utf8" }));
  return { flows: list("scripts/flows-e2e.mjs"), app: list("scripts/app-e2e.mjs") };
}
const groupNames = (list, has) => list.filter(has).map(one => one.name);
const ownScripted = one => (one.ownScripted ?? one.scripted ?? 0) > 0;
const hasReal = one => (one.real ?? 0) > 0;
/** "flows steps, triggers; app flows, mail" */
export const groupWords = picked => [["flows", picked.flows], ["app", picked.app]].filter(([, names]) => names.length > 0).map(([script, names]) => `${script} ${names.join(", ")}`).join("; ");

/**
 * Which browser groups run, and why. Scripted: the groups of the areas the changed pages belong to, or every scripted
 * group when a changed page has no clear area. Real-model: every group with real-model journeys, when model-facing
 * code changed or --real (or a full check) asks for them.
 */
export function journeysFor(code, groups, { all = false, real = false } = {}) {
  const everyScripted = { flows: groupNames(groups.flows, ownScripted), app: groupNames(groups.app, ownScripted) };
  const everyReal = { flows: groupNames(groups.flows, hasReal), app: groupNames(groups.app, hasReal) };
  const pages = all ? [] : code.filter(file => BROWSER.some(re => re.test(file)));
  const model = all ? undefined : code.find(file => !/\.test\.[cm]?[jt]s$/.test(file) && MODEL.some(re => re.test(file)));
  let scripted = { flows: [], app: [] }, scriptedWhy = null;
  const unowned = pages.find(file => !AREAS.some(area => area.paths.some(re => re.test(file))));
  if (all || unowned !== undefined) {
    scripted = everyScripted;
    scriptedWhy = all ? "a full check" : `${unowned} changed, and no one group's journeys own it`;
  } else if (pages.length > 0) {
    const reasons = [];
    for (const area of AREAS) {
      const file = pages.find(one => area.paths.some(re => re.test(one)));
      if (file === undefined) continue;
      reasons.push(`${file} changed: ${area.what}`);
      for (const script of ["flows", "app"]) scripted[script] = [...new Set([...scripted[script], ...(area[script] === "all" ? everyScripted[script] : area[script])])];
    }
    // In the scripts' own order, and only groups that have scripted journeys of their own.
    for (const script of ["flows", "app"]) scripted[script] = everyScripted[script].filter(one => scripted[script].includes(one));
    scriptedWhy = reasons.join("; ");
  }
  const realWhy = all ? "a full check" : real ? "--real" : model === undefined ? null : `${model} changed: model-facing`;
  return { scripted, scriptedWhy, real: realWhy === null ? { flows: [], app: [] } : everyReal, realWhy };
}

export function planFor(changed, { full: all = false, real = false, versionBumps = [], schemaFiles = [], groups = null } = {}) {
  const words = journeys => journeys.scriptedWhy === null && journeys.realWhy === null ? "no browser journeys (nothing a page shows changed, and no model-facing code; --real runs the real-model ones)" : [
    journeys.scriptedWhy === null ? "no scripted browser journeys (nothing a page shows changed)" : `scripted browser journeys in ${groupWords(journeys.scripted)} (${journeys.scriptedWhy})`,
    journeys.realWhy === null ? "no real-model journeys (no model-facing code changed; --real runs them)" : `real-model journeys in ${groupWords(journeys.real)}, and what they need (${journeys.realWhy})`,
  ].join("; ");
  const none = { scripted: { flows: [], app: [] }, scriptedWhy: null, real: { flows: [], app: [] }, realWhy: null };
  const browserOf = journeys => journeys.scriptedWhy !== null || journeys.realWhy !== null;
  if (all) {
    const journeys = groups === null ? none : journeysFor([], groups, { all: true });
    return { unit: "all", browser: true, journeys, upgrade: true, upgradeWhy: "a full check", why: `a full check was asked for${groups === null ? "" : `: every unit test; ${words(journeys)}`}` };
  }
  const bumped = changed.filter(file => versionBumps.includes(file));
  const bump = bumped.length === 0 ? "" : `; only the version changed in ${bumped.join(" and ")}`;
  const code = changed.filter(file => !NOTHING.some(re => re.test(file)) && !bumped.includes(file));
  if (code.length === 0 && !real) return { unit: "none", browser: false, journeys: none, upgrade: false, why: bumped.length === 0 ? "only docs, evidence or design notes changed" : `nothing a test reads changed${bump}` };
  const wholeUnit = code.find(file => WHOLE_UNIT.some(re => re.test(file)));
  const page = code.find(file => BROWSER.some(re => re.test(file)));
  const upgrade = code.find(file => !/\.test\.[cm]?[jt]s$/.test(file) && (UPGRADE.some(re => re.test(file)) || schemaFiles.includes(file)));
  const journeys = groups === null ? none : journeysFor(code, groups, { real });
  const browser = groups === null ? page !== undefined : browserOf(journeys);
  return {
    unit: code.length === 0 ? "none" : wholeUnit !== undefined ? "all" : "related",
    browser,
    journeys,
    upgrade: upgrade !== undefined,
    ...(upgrade !== undefined ? { upgradeWhy: `${upgrade} changed` } : {}),
    why: [
      code.length === 0 ? "no unit tests (nothing a test reads changed)" : wholeUnit !== undefined ? `every unit test (${wholeUnit} changed)` : "unit tests related to the change",
      groups !== null ? words(journeys) : page !== undefined ? `browser journeys (${page} changed)` : "no browser journeys (nothing a page shows changed)",
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
  const [flows, app] = shareSlots(slots, 2);
  return { flows: flows ?? 1, app: app ?? 1, together: slots > 1 };
}
/** The same for any number of journey runs: each run's share, at least one each; with fewer slots than runs, each run
 * gets them all and they run one after the other (together is false). */
export function shareSlots(slots, runs) {
  if (runs === 0) return [];
  if (slots < runs) return Array.from({ length: runs }, () => Math.max(1, slots));
  return Array.from({ length: runs }, (_, at) => Math.floor(slots / runs) + (at >= runs - (slots % runs) ? 1 : 0));
}

/** Give the longest scripted suite more of the same browser budget, leaving a slot for every other selected run.
 * Selection/scoping and real-provider admission are unchanged. On small runners preserve the old allocation. */
export function releaseLaneShares(labels, sample, options = {}) {
  const shares = shareSlots(MAX_GROUPS, labels.length);
  const at = labels.indexOf("app");
  if (at === -1) return { shares, app: null };
  const app = appLanes(sample, { ...options, baseline: shares[at], max: MAX_GROUPS - labels.length + 1 });
  if (app.count <= shares[at]) { shares[at] = app.count; return { shares, app }; }
  const rest = shareSlots(MAX_GROUPS - app.count, labels.length - 1);
  return { shares: labels.map((_, index) => index === at ? app.count : rest.shift()), app };
}

const took = ms => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 6000) / 10} min`;

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const started = Date.now();
  const base = baseOf();
  const changed = base === null ? [] : git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean);
  const versionBumps = base === null ? [] : VERSIONED.filter(file => changed.includes(file) && versionOnly(file, tryGit("show", `${base}:${file}`), tryGit("show", `HEAD:${file}`)));
  // No main to compare with, or nothing differs from it (a release of main itself): check everything.
  const schemaFiles = changed.filter(file => /\.[cm]?[jt]s$/.test(file) && existsSync(file) && definesSchema(readFileSync(file, "utf8")));
  // The journey groups, from the scripts themselves (another project's release check has none).
  const groups = existsSync(join("scripts", "flows-e2e.mjs")) && existsSync(join("scripts", "app-e2e.mjs")) ? journeyGroups() : null;
  const plan = planFor(changed, { full: full || changed.length === 0, real, versionBumps, schemaFiles, groups });
  // Toolroll's own checkout carries the upgrade path; another project's release check has none.
  const upgrade = plan.upgrade && existsSync(join("scripts", "upgrade-path.mjs"));
  console.log(`Release check against ${base === null ? "nothing (origin/main unknown)" : `origin/main ${base.slice(0, 12)}`} (${changed.length} changed files): ${plan.why}${upgrade ? `; the upgrade path from the last 3 releases and 0.9.11 (${plan.upgradeWhy})` : ""}.`);
  if (planOnly) process.exit(0);

  const memory = watchMemory();
  // The logs and the build's outcome; removed when the check ends, however it ends.
  const dir = makeTempRoot("release-check-");
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
  // Each journey run: a script, scripted or real-model, in just the groups the plan picked.
  const journeyRuns = groups === null ? (plan.browser ? [
    { label: "flows", argv: ["scripts/flows-e2e.mjs"] }, { label: "app", argv: ["scripts/app-e2e.mjs", "--skip-build"] },
  ] : []) : [
    ["flows", "scripted", plan.journeys.scripted.flows, ["scripts/flows-e2e.mjs"]], ["app", "scripted", plan.journeys.scripted.app, ["scripts/app-e2e.mjs", "--skip-build"]],
    ["flows-real", "real", plan.journeys.real.flows, ["scripts/flows-e2e.mjs"]], ["app-real", "real", plan.journeys.real.app, ["scripts/app-e2e.mjs", "--skip-build"]],
  ].filter(([, , picked]) => picked.length > 0).map(([label, kind, picked, argv]) => ({ label, argv: [...argv, "--journeys", kind, "--run-groups", picked.join(",")] }));
  const journeys = build.then(one => {
    held = journeyRuns.length > 0 && (one.code !== 0 || (typed !== null && typed.code !== 0));
    if (journeyRuns.length === 0 || held) return [];
    // The most browser groups at once, shared out; each group still starts only when the gate has room for it.
    const slots = MAX_GROUPS;
    const { shares, app } = releaseLaneShares(journeyRuns.map(each => each.label), readSample(gate.sample));
    if (app !== null) console.log(`app: ${laneWords(app)}`);
    const env = { TOOLROLL_CHECK_GATE: gate.dir };
    const start = (each, at) => run(each.label, process.execPath, ["scripts/e2e-parallel.mjs", ...each.argv, "--at-once", String(shares[at]), "--output", join("evidence", `release-${process.pid}`, each.label)], dir, env);
    // Room for a group each: all at once. Less: one after the other, each with all the room.
    if (journeyRuns.length <= slots) return Promise.all(journeyRuns.map(start));
    return journeyRuns.reduce((done, each, at) => done.then(async list => [...list, await start(each, at)]), Promise.resolve([]));
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
    const lines = readFileSync(one.log, "utf8").split("\n").filter(line => /FAIL|Test Files|passed, |^[✓✗] |^upgrade path:|^Model calls:|^No .*journeys to run/.test(line));
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
