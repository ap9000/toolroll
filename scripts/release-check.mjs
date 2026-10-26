#!/usr/bin/env node
/**
 * Release verification: build and typecheck, units (or exact successful CI plus local macOS tests),
 * scripted journeys, a CPU-bounded upgrade sample only for store/schema/migration changes, and
 * real-model journeys only for model-facing changes. --full runs all units, releases and journeys.
 * The first hard failure stops other parts. Every selected part still must pass.
 *
 * node scripts/release-check.mjs [--full] [--real] [--base <ref>] [--plan]
 *
 * Run by the plane (docs/plans/release-once.md), the check reads `{"nonce","mode","plan","watch"}` from its stdin and
 * then: keeps going past a failure (no fail-fast on release runs: cancel, the part timeout, the process-exit checks and
 * "a failed build starts no journeys" stay), reads every result only from the fd-3 pipes of the harness processes it
 * starts (never from a file on disk; their children get no stdin and no fd 3), runs a targeted plan exactly when given
 * one, and prints its report as its LAST stdout line: `TOOLROLL_CHECK_REPORT <json>`, carrying the nonce.
 */
import { execFileSync } from "node:child_process";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gateWords, openGate } from "./provider-gate.mjs";
import { passedCandidateCI, macUnitFiles } from "./release-check-ci.mjs";
import { makeTempRoot, runSuite } from "./suite-lifecycle.mjs";
import { createHash } from "node:crypto";

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

/** Scripted failures are final; real-model runs retain their normal retry policy. `keepGoing` (a release run): a failed
 * group or journey stops nothing else, and a scripted failure is still never retried. */
export function journeyEnv(kind, gate, env = process.env, keepGoing = false) {
  if (keepGoing) return kind === "real" ? {
    TOOLROLL_RELEASE_FAIL_FAST: undefined,
    TOOLROLL_RELEASE_SCRIPTED_TIMEOUT_SECONDS: undefined,
    TOOLROLL_CHECK_KEEP_GOING: "1",
    TOOLROLL_CHECK_GATE: gate.dir,
  } : {
    TOOLROLL_RELEASE_FAIL_FAST: undefined,
    TOOLROLL_RELEASE_NO_RETRY: "1",
    TOOLROLL_CHECK_KEEP_GOING: "1",
    TOOLROLL_RELEASE_SCRIPTED_TIMEOUT_SECONDS: env.TOOLROLL_CHECK_SCRIPTED_TIMEOUT_SECONDS || "90",
  };
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
 * The plane's handshake, read whole from stdin (bounded in size and time): `{"nonce","mode","plan","watch"}`. Null when
 * stdin is a terminal or empty, or what it holds isn't a handshake — a person's own run, which reports nothing.
 */
export async function readHandshake(input = process.stdin, { timeoutMs = 10_000, maxBytes = 1024 * 1024 } = {}) {
  if (input.isTTY) return null;
  const text = await new Promise(resolve => {
    const chunks = [];
    let size = 0, done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { finish(null); try { input.destroy(); } catch { /* gone */ } }, timeoutMs);
    timer.unref?.();
    input.on("data", chunk => { size += chunk.length; if (size > maxBytes) { finish(null); try { input.destroy(); } catch { /* gone */ } } else chunks.push(chunk); });
    input.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    input.on("error", () => finish(null));
  });
  return parseHandshake(text);
}

/** A handshake from its text, checked: a 64-hex nonce, a mode, a plan (an object, targeted only) and a watch list. */
export function parseHandshake(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.nonce !== "string" || !/^[0-9a-f]{64}$/.test(value.nonce)) return null;
  if (value.mode !== "full" && value.mode !== "targeted") return null;
  const plan = value.plan ?? null;
  if (value.mode === "targeted" ? plan === null || typeof plan !== "object" || Array.isArray(plan) : plan !== null) return null;
  const watch = Array.isArray(value.watch) ? value.watch.filter(one => typeof one === "string") : [];
  if (plan !== null) {
    const lists = ["units", "sanity", "versions", "parts", "required"];
    if (lists.some(key => !Array.isArray(plan[key]) || plan[key].some(one => typeof one !== "string"))) return null;
    if (!Array.isArray(plan.groups) || plan.groups.some(one => one === null || typeof one !== "object" || typeof one.script !== "string" || typeof one.kind !== "string" || !Array.isArray(one.groups))) return null;
  }
  // The plane's own limit on the command (its approved timeout), when it says: the check ends itself before it.
  const limitMs = Number.isSafeInteger(value.limitMs) && value.limitMs > 0 ? value.limitMs : null;
  return { nonce: value.nonce, mode: value.mode, plan, watch, limitMs, planDigest: plan === null ? null : createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}

/** A unit file from the identities the plane asks about (`unit:<file>::<name>`, `file:<file>`). */
const fileOfIdentity = identity => /^unit:(.+?)::/.exec(identity)?.[1] ?? /^file:(.+)$/.exec(identity)?.[1] ?? null;

/**
 * The report from what the harness processes said on their pipes: every part, the unit suite (each file, and the
 * identities that failed, were skipped, passed on a retry or were asked about), each journey run and the upgrade path.
 */
export function buildReport({ handshake, exitCode, parts, unitLines, reusedFromCI, journeyRuns, upgradeLines }) {
  const watched = new Set([...(handshake.watch ?? []), ...(handshake.plan?.required ?? [])]);
  const watchedFiles = new Set([...watched].map(fileOfIdentity).filter(one => one !== null));
  const units = unitLines === null ? null : (() => {
    const files = new Map(), identities = new Map();
    let finished = false, runErrors = 0;
    for (const line of unitLines) {
      if (line.kind === "unit-file" && typeof line.file === "string") files.set(line.file, { file: line.file, state: ["passed", "failed", "skipped"].includes(line.state) ? line.state : "failed",
        passed: Number(line.passed) || 0, failed: Number(line.failed) || 0, skipped: Number(line.skipped) || 0, flaky: line.flaky === true });
      else if (line.kind === "unit-case" && typeof line.file === "string" && typeof line.name === "string" && ["passed", "failed", "skipped"].includes(line.state)) {
        const id = `unit:${line.file}::${line.name}`;
        if (line.state !== "passed" || line.flaky === true || watchedFiles.has(line.file) || watched.has(id)) {
          // A name twice in one file (a test.each with the same title) keeps its worst outcome.
          const before = identities.get(id);
          if (before === undefined || before.state === "passed" || (before.state === "skipped" && line.state === "failed")) identities.set(id, { file: line.file, name: line.name, state: line.state, flaky: line.flaky === true });
        }
      } else if (line.kind === "unit-end") { finished = true; runErrors = Number(line.errors) || 0; }
    }
    return { reusedFromCI, finished, runErrors, files: [...files.values()].sort((a, b) => a.file < b.file ? -1 : 1), identities: [...identities.values()] };
  })();
  const journeys = journeyRuns.map(run => {
    const groups = new Map();
    let finished = false;
    for (const line of run.lines) {
      if (line.kind === "journey-inventory" && Array.isArray(line.groups)) {
        for (const group of line.groups) if (typeof group === "string" && !groups.has(group)) groups.set(group, { group, state: "not-run", retried: false, unattributed: false, journeys: [] });
      } else if (line.kind === "journey-group" && typeof line.group === "string") groups.set(line.group, { group: line.group, state: ["passed", "failed", "not-run"].includes(line.state) ? line.state : "failed",
        retried: line.retried === true, unattributed: line.unattributed === true,
        journeys: Array.isArray(line.results) ? line.results.filter(one => typeof one?.name === "string" && ["passed", "failed", "skipped"].includes(one.state)).map(one => ({ name: one.name, state: one.state })) : [] });
      else if (line.kind === "journey-end") finished = true;
    }
    return { script: run.script, kind: run.kind, finished, groups: [...groups.values()] };
  });
  const upgrades = upgradeLines === null ? null : (() => {
    const versions = new Map();
    let finished = false;
    for (const line of upgradeLines) {
      if (line.kind === "upgrade-inventory" && Array.isArray(line.versions)) {
        for (const version of line.versions) if (typeof version === "string" && !versions.has(version)) versions.set(version, { version, state: "not-run" });
      }
      if (line.kind === "upgrade-version" && typeof line.version === "string") versions.set(line.version, { version: line.version, state: ["passed", "failed", "not-run"].includes(line.state) ? line.state : "failed" });
      if (line.kind === "upgrade-end") finished = true;
    }
    return { finished, versions: [...versions.values()] };
  })();
  return { version: 1, nonce: handshake.nonce, mode: handshake.mode, planDigest: handshake.planDigest ?? null, exitCode, parts, units, journeys, upgrades };
}

/** The report's line: the last thing the check prints. Null when it would be over 256 KiB (no report is better than a
 * cut one). */
export function reportLine(report) {
  const line = `TOOLROLL_CHECK_REPORT ${JSON.stringify(report)}`;
  return Buffer.byteLength(line) > 256 * 1024 ? null : line;
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
export function partRunner(dir, { timeoutMs = PART_MS, graceMs = 15_000, failFast = true, say = line => process.stderr.write(`${line}\n`) } = {}) {
  const abort = new AbortController();
  let failure = null, stopped = null;
  const running = new Set();
  // `failFast` false (a release run, docs/plans/release-once.md): the first failure is still said and kept, and every
  // other part runs on; the part timeout and cancel still stop what they own.
  const fail = (label, detail) => {
    if (failure !== null) return;
    failure = `${label}: ${detail}`;
    console.error(`Release check failed: ${failure}${failFast ? "; stopping other parts" : "; the other parts keep running"}`);
    if (failFast) abort.abort();
  };
  // The check's own limit (a release run, checkDeadline): every part still running is stopped, so the check still
  // prints every log and its report before the plane stops the whole command (release check 3249 lost both).
  const stop = why => {
    if (stopped !== null) return;
    stopped = why;
    if (failure === null) failure = why;
    console.error(`Release check stopped: ${why}; stopping ${running.size === 0 ? "nothing (no part is running)" : [...running].join(", ")}`);
    abort.abort();
  };
  const run = (label, command, argv, env = {}, onResult = null) => {
    let partial = "";
    running.add(label);
    return runSuite({ command, args: argv, env: { TOOLROLL_CHECK_GATE: undefined, ...env },
      signal: abort.signal, prefix: `so-check-${label}-`, timeoutMs, graceMs, tempRoot: partTempRoot(label),
      ...(onResult === null ? {} : { onResult }),
      onExit: code => { if (code !== 0) fail(label, `exit ${code}`); },
      onData: chunk => {
        const lines = (partial + chunk).split("\n"); partial = lines.pop();
        for (const line of lines) if (/^(app|flows)(-real)?$|^upgrade$/.test(label) && line.includes("TOOLROLL_CHECK_FAILURE ")) fail(label, line.slice(line.indexOf("TOOLROLL_CHECK_FAILURE ") + 23));
      },
    }).then(one => {
      running.delete(label);
      const log = join(dir, `${label}.log`);
      // Stopped at the check's limit: it timed out, as a part that ran past its own timeout does.
      const limited = stopped !== null && one.cancelled !== true && one.code !== 0;
      const ending = one.timedOut ? `\n${label} timed out and was stopped\n` : limited ? `\n${label} was stopped: ${stopped}\n` : "";
      writeFileSync(log, ending === "" ? one.output : Buffer.concat([one.output, Buffer.from(ending)]));
      // A failed part's log, as it fails: on stderr, which the plane keeps whole when the command is stopped before its
      // end (release check 3249: the flows log was only ever printed at the end, so it was never stored).
      if (one.code !== 0 && one.cancelled !== true) say(failureExcerpt(label, one.code, readFileSync(log, "utf8")));
      return { label, code: one.code, log, ms: one.ms, timedOut: one.timedOut === true || limited, cancelled: one.cancelled === true };
    });
  };
  return { run, stop, signal: abort.signal, failure: () => failure, stopped: () => stopped };
}

/** Lines of a part's log that say what failed: a failed journey and why, a failed test file or test, an error. */
const FAILURE_LINE = /❌|✗|^\s+- (?!skipped:)|\bFAIL\b|\bfailed\b|[Tt]imed out|Error\b|TOOLROLL_CHECK_FAILURE|exit \d+|stopped/;
/**
 * A failed part's log in brief, for stderr: the lines that say what failed (ANSI colours removed), and when none do, the
 * log's last lines; at most `max` bytes, keeping the end.
 */
export function failureExcerpt(label, code, text, max = 8 * 1024) {
  const lines = String(text).replace(/\x1b\[[0-9;]*m/g, "").split("\n").map(line => line.trimEnd()).filter(line => line !== "");
  const failing = lines.filter(line => FAILURE_LINE.test(line));
  let kept = failing.length > 0 ? failing : lines.slice(-40), size = 0, from = kept.length;
  while (from > 0 && size + Buffer.byteLength(kept[from - 1]) + 1 <= max) size += Buffer.byteLength(kept[--from]) + 1;
  kept = kept.slice(from);
  return [`== ${label} failed (exit ${code}); ${failing.length > 0 ? "what its log says failed" : "the end of its log"}${from > 0 ? ` (the last ${kept.length} of ${failing.length > 0 ? failing.length : Math.min(40, lines.length)} lines)` : ""}:`, ...kept].join("\n");
}

/** The plane's limit when its handshake doesn't say (the approved release check's timeout, 60 minutes). */
export const RELEASE_LIMIT_MS = 60 * 60_000;
/**
 * When a release run stops whatever still runs: before the plane's own limit on the command (`limitMs`, from the
 * handshake), with room to stop the parts and print every log and the report — a tenth of the limit, at least three
 * minutes, never more than half of it.
 */
export function checkDeadline(started, limitMs = null) {
  const limit = Number.isSafeInteger(limitMs) && limitMs > 0 ? limitMs : RELEASE_LIMIT_MS;
  return started + limit - Math.min(Math.max(3 * 60_000, Math.round(limit / 10)), Math.round(limit / 2));
}
// Units and browser lanes make their own roots. An outer root adds a redundant level to their Unix socket paths.
export const partTempRoot = label => !/^(unit|app|flows)(-|$)/.test(label);

const took = ms => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 6000) / 10} min`;

/**
 * The launch folder (a plane's check folder, `so-cmd-…`) this check's temp folder lies inside, or null. The plane gives
 * a check its temp folder there; the planes this check starts (its journeys, its fenced test suite) would then make
 * everything inside a folder their own fence reads as another launch's (release check 3240: a journey's tool couldn't
 * load its own script). So the check makes its temp root beside that launch folder instead (enclosingLaunchOf, in main).
 */
export function enclosingLaunchOf(temp = tmpdir()) {
  let path;
  try { path = realpathSync(temp); } catch { return null; }
  for (let at = path; dirname(at) !== at; at = dirname(at)) if (/^so-cmd-/.test(basename(at))) return at;
  return null;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const started = Date.now();
  // Run by a plane, its temp folder inside the check's launch folder: every part takes a temp root beside that folder
  // when it can be made there (an unsandboxed check; a sandboxed one can't write there, and nests no fence anyway).
  const enclosing = enclosingLaunchOf();
  if (enclosing !== null) {
    let root = null;
    try { root = makeTempRoot("so-rc-", { parent: dirname(enclosing) }); } catch { root = null; }
    if (root !== null) for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = root;
  }
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
  // The plane's handshake (docs/plans/release-once.md): a release run keeps going past failures, reports on its pipes and
  // prints its report last. A targeted one runs exactly its plan. A person's own run reads none and behaves as before.
  const handshake = await readHandshake();
  const releaseRun = handshake !== null;
  const targeted = handshake?.mode === "targeted" ? handshake.plan : null;
  if (targeted !== null) {
    console.log(`Targeted check (from run ${targeted.base}): ${targeted.units.length} unit files, ${targeted.sanity.length} sanity files, ` +
      `${targeted.groups.reduce((n, one) => n + one.groups.length, 0)} journey groups, ${targeted.versions.length} upgrade versions${targeted.parts.length > 0 ? `; whole parts: ${targeted.parts.join(", ")}` : ""}.`);
  }

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
  // Each journey run: a script, scripted or real-model, in every group with journeys of that kind. A targeted check runs
  // a whole part again only when its plan says so, and otherwise just the groups it names.
  const plannedGroups = (script, kind) => targeted?.groups.filter(one => one.script === script && one.kind === kind).flatMap(one => one.groups) ?? [];
  const journeyRuns = !scripts ? [] : [
    ["flows", "scripted", plan.checks], ["app", "scripted", plan.checks], ["flows-real", "real", plan.real], ["app-real", "real", plan.real],
  ].map(([label, kind, runs]) => {
    const script = label.replace(/-real$/, "");
    const whole = targeted === null ? runs : targeted.parts.includes(label);
    const groups = targeted === null || whole ? null : plannedGroups(script, kind);
    if (!whole && (groups === null || groups.length === 0)) return null;
    return { label, kind, script, argv: [`scripts/${script}-e2e.mjs`, ...(script === "app" ? ["--skip-build"] : []), "--journeys", kind, "--at-once", String(budget.lanes[script]), ...(groups === null ? [] : ["--run-groups", groups.join(",")])] };
  }).filter(one => one !== null);
  // The logs and the build's outcome; removed when the check ends, however it ends.
  const ci = targeted !== null ? { passed: false, why: "a targeted check runs its own units" } : plan.checks ? passedCandidateCI({ full, git }) : { passed: false, why: "no unit suite selected" };
  let localUnits = [];
  if (ci.passed && process.platform === "darwin") {
    try { localUnits = macUnitFiles(); if (localUnits.length === 0) throw Error("no macOS tests found"); }
    catch { ci.passed = false; ci.why = "macOS test selection unreadable; running all units"; }
  }
  console.log(`Units: ${ci.passed ? "reuse CI; macOS tests still run locally" : "local"} (${ci.why}).`);
  const dir = makeTempRoot("release-check-");
  const parts = partRunner(dir, { failFast: !releaseRun }), run = parts.run;
  // A release run ends itself before the plane's limit: whatever still runs then is stopped, and every log and the report
  // are still printed (release check 3249: a doomed real-model journey ran it into the plane's 60 minutes).
  const deadline = releaseRun ? checkDeadline(started, handshake.limitMs) : null;
  const limiter = deadline === null ? null : setTimeout(() => parts.stop(`the check reached its own limit, ${took(deadline - started)} after it started, before the plane's`), Math.max(0, deadline - Date.now()));
  limiter?.unref?.();
  // One provider gate for both real-model runners (they find it in TOOLROLL_CHECK_GATE); scripted runs take none.
  let gate = null;
  if (journeyRuns.some(each => each.kind === "real")) {
    mkdirSync(join(dir, "gate"));
    try { gate = openGate({ dir: join(dir, "gate"), reserve: true, env: { TOOLROLL_CHECK_PROVIDERS: process.env.TOOLROLL_CHECK_PROVIDERS || "4" } }); } catch (error) { console.error(error.message); process.exit(2); }
  }
  // Results, from each harness process's fd-3 pipe only (never a file): the Vitest main process, each journey runner
  // and the upgrade path.
  const unitLines = [], upgradeLines = [], journeyLines = new Map(journeyRuns.map(one => [one.label, []]));
  // The unit suite through Vitest itself, so its main process can hold the pipe (npm hands a script no fd 3). A checkout
  // without Vitest or the reporter (another project's) runs its own `test:all`, which reports nothing.
  const direct = existsSync(join("node_modules", "vitest", "vitest.mjs")) && existsSync(join("test", "release-reporter.ts"));
  const unitFiles = targeted === null ? localUnits : targeted.parts.includes("unit") ? [] : [...new Set([...targeted.units, ...targeted.sanity])];
  const unitsRun = targeted === null ? plan.checks && (!ci.passed || localUnits.length > 0) : targeted.parts.includes("unit") || unitFiles.length > 0;
  // The unit tests' setup (test/ensure-build.ts) waits for this file: the build's outcome.
  const built = join(dir, "build-outcome");
  const typecheck = run("typecheck", "npm", ["run", "typecheck"]);
  const build = run("build", "npm", ["run", "build"]).then(one => {
    // Whole or not at all: written aside, then renamed into place.
    writeFileSync(`${built}.part`, one.code === 0 ? "ok" : `failed (exit ${one.code})`);
    renameSync(`${built}.part`, built);
    return one;
  });
  const units = !unitsRun ? [] : direct
    ? [run("unit", process.execPath, [join("node_modules", "vitest", "vitest.mjs"), "run", "--reporter=dot", "--reporter=./test/release-reporter.ts", `--maxWorkers=${budget.unitWorkers}`, ...unitFiles], { TOOLROLL_RELEASE_BUILD: built }, line => unitLines.push(line))]
    : [run("unit", "npm", ["run", "test:all", "--", "--run", "--reporter=dot", `--maxWorkers=${budget.unitWorkers}`, ...unitFiles], { TOOLROLL_RELEASE_BUILD: built })];
  // The journeys need the built console; they don't start when the build (or a typecheck already done) failed.
  let typed = null, held = false;
  typecheck.then(one => { typed = one; });
  const journeys = build.then(async one => {
    // Too little room for every part at once: the journeys wait for the typecheck and the units.
    if (budget.sequential) { await typecheck; await Promise.all(units); }
    held = journeyRuns.length > 0 && (parts.signal.aborted || one.code !== 0 || (typed !== null && typed.code !== 0));
    if (held) return [];
    const journey = each => run(each.label, process.execPath, ["scripts/e2e-parallel.mjs", ...each.argv, "--output", join("evidence", `release-${process.pid}`, each.label)],
      journeyEnv(each.kind, gate, process.env, releaseRun), line => journeyLines.get(each.label).push(line));
    // Two waves: the scripted journeys (and the units beside them) first, then the real-model ones, which wait mostly on
    // the provider and need the least of the machine.
    return Promise.all(journeyRuns.filter(each => each.kind === "scripted").map(journey)).then(async scripted => {
      await Promise.all(units);
      if (parts.signal.aborted) return scripted;
      return [...scripted, ...await Promise.all(journeyRuns.filter(each => each.kind === "real").map(journey))];
    });
  });
  // The upgrade path packs the built candidate: it starts once the build passed. A targeted check runs only the
  // versions its plan names, or the whole part again.
  // A whole-upgrade obligation runs every published version (--full): never a smaller selection than the full check owed.
  const upgradeArgs = targeted === null ? (full ? ["--full"] : []) : targeted.parts.includes("upgrade") ? ["--full"] : ["--versions", targeted.versions.join(",")];
  const upgradeSelected = existsSync(join("scripts", "upgrade-path.mjs")) && (targeted === null ? upgrade : targeted.parts.includes("upgrade") || targeted.versions.length > 0);
  let upgradeHeld = false;
  const upgraded = build.then(async one => {
    // …and the upgrade path waits for the journeys.
    if (budget.sequential) await journeys;
    upgradeHeld = upgradeSelected && (parts.signal.aborted || one.code !== 0);
    return upgradeSelected && !upgradeHeld ? [run("upgrade", process.execPath, ["scripts/upgrade-path.mjs", ...upgradeArgs],
      { TOOLROLL_UPGRADE_WORKERS: String(budget.upgradeWorkers), ...(releaseRun ? { TOOLROLL_CHECK_KEEP_GOING: "1" } : {}) }, line => upgradeLines.push(line))] : [];
  }).then(list => Promise.all(list));
  const first = await Promise.all([typecheck, build]);
  const results = [...await Promise.all(units), ...await journeys, ...await upgraded];
  for (const one of [...first, ...results]) { console.log(`== ${one.label}`); console.log(readFileSync(one.log, "utf8")); }
  console.log("== summary");
  console.log(`plan: ${targeted === null ? plan.why : `targeted from run ${targeted.base}`}`);
  if (parts.failure()) console.log(`failed: ${parts.failure()}`);
  if (ci.passed) console.log(`unit suite reused: ${ci.why}; ${localUnits.length} macOS files run locally`);
  if (!upgradeSelected) console.log(targeted === null ? "upgrade path not run: no store, migration or schema changes" : "upgrade path not run: the targeted plan names none");
  for (const one of first.filter(each => each.code !== 0)) console.log(`${one.label}: exit ${one.code}`);
  for (const one of results) {
    console.log(`${one.label}: exit ${one.code}`);
    const lines = readFileSync(one.log, "utf8").split("\n").filter(line => /FAIL|Test Files|passed, |^[✓✗] |^upgrade path:|^Model calls:|^No .*journeys to run/.test(line));
    for (const line of lines.slice(-5)) console.log(line);
  }
  if (held) console.log(`browser journeys not run: ${parts.stopped() !== null ? `the check stopped first (${parts.stopped()})` : "the typecheck or build failed"}`);
  if (upgradeHeld) console.log("upgrade path not run: the build failed");
  if (results.length === 0 && first.every(one => one.code === 0)) console.log("typecheck and build passed; nothing else to run");
  // The load it ran under, so a failure on a busy machine can be judged — never used to excuse one.
  clearInterval(sampler);
  if (limiter !== null) clearTimeout(limiter);
  console.log(loadWords(samples, cores, budget));
  console.log(`took: ${[...first, ...results].map(one => `${one.label} ${took(one.ms)}`).join(", ")}; whole check ${took(Date.now() - started)}`);
  if (gate !== null) { console.log(gateWords(gate.facts())); gate.close(); }
  const exitCode = parts.failure() !== null || [...first, ...results].some(one => one.code !== 0) ? 1 : 0;
  process.exitCode = exitCode;
  if (handshake !== null) {
    // Every part, selected or not, with what it did; then the report as the very last line.
    const byLabel = new Map([...first, ...results].map(one => [one.label, one]));
    const selected = new Set(["typecheck", "build", ...(unitsRun ? ["unit"] : []), ...journeyRuns.map(one => one.label), ...(upgradeSelected ? ["upgrade"] : [])]);
    const reportParts = ["typecheck", "build", "unit", "flows", "app", "flows-real", "app-real", "upgrade"].map(part => {
      const one = byLabel.get(part);
      return { part, selected: selected.has(part), ran: one !== undefined && !one.cancelled, code: one === undefined || one.cancelled ? null : Math.min(255, Math.max(0, one.code)), timedOut: one?.timedOut === true };
    });
    const ranJourneys = journeyRuns.filter(one => byLabel.has(one.label) && !byLabel.get(one.label).cancelled);
    const report = buildReport({ handshake, exitCode, parts: reportParts,
      unitLines: byLabel.has("unit") && direct ? unitLines : null, reusedFromCI: ci.passed,
      journeyRuns: ranJourneys.map(one => ({ script: one.script, kind: one.kind, lines: journeyLines.get(one.label) })),
      upgradeLines: byLabel.has("upgrade") ? upgradeLines : null });
    const line = reportLine(report);
    if (line === null) console.log("The check's report is over 256 KiB, so none is given.");
    else process.stdout.write(`${line}\n`);
  }
}
