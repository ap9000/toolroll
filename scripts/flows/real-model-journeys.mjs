#!/usr/bin/env node
/**
 * Every journey with real models, for a flow to run every night: a Run a
 * script zone runs this file in a copy of main after the project's setup
 * (runIn copy). The release check runs the scripted journeys against a
 * scripted provider, and the real-model ones only when model-facing code
 * changed; this is where every journey, scripted ones included, meets the real
 * models. It is what would have caught 0.9.1's lead no longer sending a failing
 * check back to the build.
 *
 *   node scripts/flows/real-model-journeys.mjs [--no-build] [--minutes 120] [--output <dir>] [--only <pattern>] [--suite "<name>=<script.mjs> [args]" …] [--suites]
 *
 * It builds, then runs every group of scripts/flows-e2e.mjs and of
 * scripts/app-e2e.mjs with --journeys all (real models), each group a suite in
 * a world of its own, 4 at once. --suites prints the suites and exits. A suite with a
 * failed journey runs once more, in a fresh world, with just the failed
 * journeys and what they need (their setup journeys); a journey that passes
 * then was a flaky model. Everything stops at the time cap.
 *
 * Each suite and each retry starts only with a slot under the cap on real provider
 * turns (default at most 4; scripts/provider-gate.mjs; TOOLROLL_CHECK_PROVIDERS
 * overrides it). Time spent waiting for a slot moves that suite's cap on by as
 * much, so a busy machine makes the run slower, never a timeout.
 *
 * Its progress goes to stderr (the step's log). What it prints on stdout is
 * the step's result: a short summary — each journey that failed twice, its
 * error and what it saw, the real model turns the journeys took — and a last
 * line "goto: pass" or "goto: fail".
 * Exit 0 when every journey passed, even on the second try; 1 otherwise.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BROWSER_CHECK, exactly, here, retryCleared, retrySet } from "../e2e-kit.mjs";
import { gateWords, limiter, openGate } from "../provider-gate.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at === -1 ? fallback : args[at + 1]; };
/** Every group of both journey scripts, each with every journey and real models: "app-lead=scripts/app-e2e.mjs --group lead --journeys all". */
function everySuite(list = script => JSON.parse(execFileSync(process.execPath, [join(here, script), "--groups", "--json"], { encoding: "utf8" }))) {
  return ["scripts/flows-e2e.mjs", "scripts/app-e2e.mjs"].flatMap(script => list(script).map(group => `${/flows/.test(script) ? "flows" : "app"}-${group.name}=${script} --group ${group.name} --journeys all`));
}
/** Each suite: a name, and its script with its own arguments. */
const SUITES = (args.includes("--suite") ? args.filter((one, at) => args[at - 1] === "--suite") : everySuite())
  .map(one => ({ name: one.slice(0, one.indexOf("=")), argv: one.slice(one.indexOf("=") + 1).split(/\s+/) }));
if (args.includes("--suites")) { console.log(JSON.stringify(SUITES)); process.exit(0); }
/** --only <pattern>, passed to every suite: like theirs, it must match each chosen journey's setup journeys too. */
const only = option("--only", null);
const cap = Number(option("--minutes", "120")) * 60_000;
// Outside the copy, which goes when the step ends: the reports, screenshots and a failed run's workspace stay.
const out = resolve(option("--output", join(tmpdir(), "toolroll-real-model-journeys", new Date().toISOString().replace(/[:.]/g, "-"))));
const started = Date.now(), deadline = started + cap;
const minutes = () => Math.round((Date.now() - started) / 6000) / 10;
const log = line => process.stderr.write(`${line}\n`);
const running = new Set();
// Stopped from outside (the zone's own time limit): take every suite's console, worker and browser along.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { for (const pid of running) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } } process.exit(1); });

let gate;
try { gate = openGate({ log }); } catch (error) { log(error.message); process.exit(2); }
// What a suite runs isn't one of these starts: it doesn't take the gate along.
const { TOOLROLL_CHECK_GATE: _gate, ...inherited } = process.env;

/**
 * Run one command in its own process group, its output to the log, once the gate has a provider slot for it; at the cap
 * the whole group (console, worker, browser) stops. `late` ({ ms }) is how long this suite has waited for a slot so
 * far: its cap moves on by that much.
 */
function run(label, file, argv, late) {
  return gate.hold(label, ({ waitedMs }) => { late.ms += waitedMs; return start(label, file, argv, late); });
}
function start(label, file, argv, late = { ms: 0 }) {
  return new Promise(done => {
    const child = spawn(file, argv, { cwd: here, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...inherited, NODE_OPTIONS: "" } });
    running.add(child.pid);
    let tail = "", timedOut = false;
    for (const stream of [child.stdout, child.stderr]) {
      let partial = "";
      stream.on("data", chunk => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop();
        for (const line of lines) { log(`[${label}] ${line}`); tail = `${tail}\n${line}`.slice(-2000); }
      });
    }
    const stop = signal => { try { process.kill(-child.pid, signal); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; stop("SIGTERM"); setTimeout(() => stop("SIGKILL"), 5_000).unref(); }, Math.max(0, deadline + late.ms - Date.now()));
    child.on("error", error => { clearTimeout(timer); done({ code: 127, timedOut, tail: error.message }); });
    child.on("close", code => { clearTimeout(timer); stop("SIGKILL"); running.delete(child.pid); done({ code: code ?? 1, timedOut, tail }); });
  });
}
const reportOf = folder => { try { return JSON.parse(readFileSync(join(out, folder, "report.json"), "utf8")); } catch { return null; } };
const report = folder => reportOf(folder)?.results ?? null;
// 4 suites at once: each holds a console, a worker and a browser, its retry too.
const slot = limiter(4);

/** One suite: its run, and when a journey failed, one more with just those journeys and what they need. */
async function suite({ name, argv }) {
  const late = { ms: 0 };
  const first = await run(name, process.execPath, [...argv, ...(only === null ? [] : ["--only", only]), "--output", join(out, name)], late);
  const before = report(name);
  const failedBefore = (before ?? []).filter(one => one.state === "failed");
  if (first.code === 0 && failedBefore.length === 0) return { name, ok: true, final: before ?? [], flaky: [] };
  if (first.timedOut) return { name, ok: false, failures: failedBefore.length > 0 ? failedBefore : [{ name: "the whole run", error: `ran out of time at the ${cap / 60_000}-minute cap` }] };
  const journeys = before === null ? null : retrySet(before);
  log(`[${name}] Running again: ${journeys === null ? "the whole suite" : journeys.join("; ")}`);
  // The browser-error check is part of every retry: a journey's console errors count the second time too.
  // The retry's own --only replaces the first run's, and a suite's own (its journeys are a subset of them).
  const again = journeys === null ? only === null ? [] : ["--only", only] : ["--only", exactly([...new Set([...journeys, BROWSER_CHECK])])];
  const own = journeys === null ? argv : argv.filter((one, at) => one !== "--only" && argv[at - 1] !== "--only");
  const second = await run(`${name}-retry`, process.execPath, [...own, ...again, "--output", join(out, `${name}-retry`)], late);
  const after = report(`${name}-retry`);
  const cleared = second.code === 0 && (before === null || retryCleared(before, after));
  // What each journey came to: the second try's result for those it ran again.
  if (cleared) return { name, ok: true, final: (before ?? after ?? []).map(one => after?.find(each => each.name === one.name) ?? one), flaky: failedBefore.map(one => one.name) };
  if (second.timedOut && after === null) return { name, ok: false, failures: [{ name: failedBefore[0]?.name ?? "the whole run", error: `ran out of time at the ${cap / 60_000}-minute cap on the second try` }] };
  if (after === null) return { name, ok: false, failures: [{ name: "the whole run", error: `crashed twice (exit ${second.code}): ${second.tail.trim().split("\n").slice(-3).join(" | ")}` }] };
  const state = new Map(after.map(one => [one.name, one]));
  const failures = after.filter(one => one.state === "failed");
  // A journey that failed first and then didn't run at all proved nothing.
  for (const one of failedBefore) if (state.get(one.name)?.state !== "passed" && !failures.some(each => each.name === one.name)) failures.push({ ...one, error: `${one.error} (the second try ${state.get(one.name)?.state === "skipped" ? `skipped it: ${state.get(one.name).because.join(", ")}` : "didn't run it"})` });
  return { name, ok: false, failures };
}

/** An error's own words and what it saw: the kit's "— saw: …", or the zones (JSON) a check ends its message with. */
function sawOf(error) {
  const text = String(error ?? "").replace(/\s+/g, " ").trim();
  const saw = / — saw: (.*)$/.exec(text) ?? /: ([[{].*[\]}])$/.exec(text);
  return saw === null ? { error: text, saw: null } : { error: text.slice(0, saw.index), saw: saw[1] };
}
const clip = (text, most) => text.length <= most ? text : `${text.slice(0, most - 1)}…`;

mkdirSync(out, { recursive: true });
log(`Real-model journeys: ${SUITES.map(one => one.name).join(", ")}, up to ${cap / 60_000} minutes — ${out}`);
const summary = [];
let ok = true;
const built = args.includes("--no-build") ? { code: 0 } : await start("build", "npm", ["run", "build"]);
if (built.code !== 0) {
  ok = false;
  summary.push(`Toolroll didn't build${built.timedOut ? " in time" : ` (exit ${built.code})`}: ${clip(built.tail.trim().split("\n").slice(-3).join(" | "), 400)}`);
} else {
  const results = await Promise.all(SUITES.map(one => slot(() => suite(one))));
  const turns = SUITES.flatMap(one => [one.name, `${one.name}-retry`]).reduce((sum, folder) => sum + (reportOf(folder)?.modelCalls?.real ?? 0), 0);
  ok = results.every(one => one.ok);
  const failed = results.filter(one => !one.ok).flatMap(one => one.failures.map(each => ({ suite: one.name, ...each })));
  const flaky = results.flatMap(one => one.ok ? one.flaky.map(each => `${one.name}: ${each}`) : []);
  const skipped = results.flatMap(one => one.ok ? one.final.filter(each => each.state === "skipped").map(each => `${one.name}: ${each.name} (${each.because.join(", ")})`) : []);
  const passed = one => one.final.filter(each => each.state === "passed").length;
  if (ok) summary.push(`Every real-model journey passed (${results.map(one => `${one.name} ${passed(one)}`).join(", ")}) in ${minutes()} min.`);
  else summary.push(`${failed.length} journey${failed.length === 1 ? "" : "s"} failed twice (${minutes()} min):`);
  for (const one of failed.slice(0, 5)) {
    const { error, saw } = sawOf(one.error);
    summary.push(`- ${one.suite}: ${clip(one.name, 200)}`, `  error: ${clip(error, 400)}`, ...(saw === null ? [] : [`  saw: ${clip(saw, 600)}`]));
  }
  if (failed.length > 5) summary.push(`- and ${failed.length - 5} more (see the log)`);
  if (flaky.length > 0) summary.push(`Flaky, passed on the second try: ${clip(flaky.join("; "), 400)}`);
  if (skipped.length > 0) summary.push(`Skipped: ${clip(skipped.join("; "), 400)}`);
  summary.push(`Real model turns: ${turns}`);
}
log(gateWords(gate.facts(process.pid)));
gate.close();
summary.push(`Reports: ${out}`, `goto: ${ok ? "pass" : "fail"}`);
process.stdout.write(`${summary.join("\n")}\n`);
process.exitCode = ok ? 0 : 1;
