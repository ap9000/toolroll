#!/usr/bin/env node
/**
 * Run the groups of an end-to-end script side by side, each in its own world, and
 * fail if any group fails. The script lists its groups with `--groups --json`
 * and runs one with `--group <name>`. At most 4 groups run at once (--at-once <n>
 * sets it; the release check runs flows 2 and app 4 at once). A real-model run
 * (--journeys real or all) also takes a slot under the cap on real provider turns
 * for each group, its retry too (default at most 4; provider-gate.mjs), shared with
 * the release check's other runners through its gate (TOOLROLL_CHECK_GATE). A wait
 * for a slot comes before a group starts, so it never eats into a journey's own
 * time. A scripted run never touches the gate.
 *
 *   npm run e2e:app:parallel      (or: node scripts/e2e-parallel.mjs scripts/app-e2e.mjs [--no-retry] [--at-once <n>] [--run-groups <a,b>] [--journeys scripted|real|all] [--output <dir>] [--keep] [--only <pattern>] …)
 *
 * --run-groups runs just those groups. --journeys (passed to every group, see
 * e2e-kit.mjs) runs only the groups that have journeys of that kind: scripted
 * ones, real-model ones, or all. The summary counts the model calls the groups
 * made: scripted, and real turns.
 *
 * Each group's run gets a temp folder of its own (TMPDIR: its world, Chrome's
 * profile, anything else it makes there), removed when the run ends unless --keep.
 *
 * Each group's output is prefixed with its name; its report goes to
 * evidence/<script>-parallel-<time>/<group>/report.md and is printed at the end. lanes.json records the lanes, wall
 * time, each group's time and what the provider gate did.
 *
 * A group with failed journeys runs once more in a fresh world with just those
 * journeys, what they need (each report names every journey's needs) and the
 * browser-error check; a journey that passes then is flaky (a follow-up), not a
 * failed run. With no report to read, or only the browser-error check failed,
 * the whole group runs again.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { exactly, here, retryCleared, retrySet, stopLeftovers } from "./e2e-kit.mjs";
import { gateWords, limiter, openGate } from "./provider-gate.mjs";
import { runSuite } from "./suite-lifecycle.mjs";

/** Groups at once when --at-once doesn't say. */
export const LANES = 4;

/**
 * Every group through `run(group, folder, first)`, at most `limit` at once, in the order given. A failed group (with
 * `retry`) runs again as `<group>-retry` as soon as its first run ends, `first` its first result; the retry takes a
 * lane like any start. Each result gets `ms` and `minutes`, timed by `now`.
 */
export async function runGroups({ groups, limit, run, retry = true, now = () => Date.now() }) {
  const slot = limiter(limit);
  const timed = (group, folder, first) => slot(async () => {
    const at = now();
    const one = await run(group, folder, first);
    const ms = now() - at;
    return { ...one, group, folder, ms, minutes: Math.round(ms / 6000) / 10 };
  });
  return Promise.all(groups.map(async group => {
    const one = await timed(group, group, null);
    if (!retry || one.code === 0) return { one, again: null };
    return { one, again: await timed(group, `${group}-retry`, one) };
  }));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [script, ...given] = process.argv.slice(2);
  if (script === undefined) { console.error("Usage: node scripts/e2e-parallel.mjs <script.mjs> [--no-retry] [--at-once <n>] [--output <dir>] [options for every group]"); process.exit(2); }
  const retry = !given.includes("--no-retry");
  const keep = given.includes("--keep");
  const at = given.indexOf("--output");
  const onceAt = given.indexOf("--at-once");
  const atOnce = onceAt === -1 ? LANES : Number(given[onceAt + 1]);
  if (!(Number.isInteger(atOnce) && atOnce >= 1)) { console.error("--at-once takes a whole number, 1 or more."); process.exit(2); }
  const pickAt = given.indexOf("--run-groups");
  const picked = pickAt === -1 ? null : (given[pickAt + 1] ?? "").split(",").filter(Boolean);
  const journeys = given.includes("--journeys") ? given[given.indexOf("--journeys") + 1] : "all";
  const own = new Set([at, onceAt, pickAt].filter(one => one !== -1).flatMap(one => [one, one + 1]));
  const rest = given.filter((one, index) => one !== "--no-retry" && !own.has(index));
  const listed = JSON.parse(execFileSync(process.execPath, [script, "--groups", "--json"], { encoding: "utf8" }));
  const unknown = (picked ?? []).filter(one => !listed.some(each => each.name === one));
  if (unknown.length > 0) { console.error(`No group ${unknown.join(", ")}. The groups: ${listed.map(one => one.name).join(", ")}`); process.exit(2); }
  // A group with nothing of the kind asked for doesn't start a world at all.
  const hasKind = one => journeys === "scripted" ? (one.ownScripted ?? one.scripted ?? 1) > 0 : journeys === "real" ? (one.real ?? 1) > 0 : true;
  const groups = listed.filter(one => (picked === null || picked.includes(one.name)) && hasKind(one));
  const name = basename(script, ".mjs").replace(/-e2e$/, "");
  if (groups.length === 0) { console.log(`No ${journeys === "all" ? "" : `${journeys} `}journeys to run in ${picked === null ? "any group" : picked.join(", ")}.`); process.exit(0); }
  const out = resolve(at === -1 ? join(here, "evidence", `${name}-parallel-${new Date().toISOString().replace(/[:.]/g, "-")}`) : given[at + 1]);
  const started = Date.now();
  const minutes = ms => Math.round(ms / 6000) / 10;
  const width = Math.max(...groups.map(one => one.name.length)) + "-retry".length;
  // A scripted run answers from the stand-in provider: it takes no provider turn and leaves the gate alone.
  let gate = null;
  if (journeys !== "scripted") try { gate = openGate({ log: line => console.log(line) }); } catch (error) { console.error(error.message); process.exit(2); }
  const limit = Math.min(groups.length, atOnce);
  console.log(`Running ${groups.length} groups, at most ${limit} at once (${onceAt === -1 ? "the default" : "--at-once"} ${atOnce}${gate === null ? "" : `; real turns capped at ${gate.cap}`}): ${groups.map(one => one.name).join(", ")}`);

  const report = folder => { try { return JSON.parse(readFileSync(join(out, folder, "report.json"), "utf8")); } catch { return null; } };
  // The first run's own --only is replaced by the journeys to retry (they are a subset of it).
  const without = (list, flag) => list.filter((one, index) => one !== flag && list[index - 1] !== flag);

  const run = async (group, folder, first) => {
    let extra = rest, journeys = null;
    if (first !== null) {
      journeys = retrySet(report(first.folder)?.results ?? []);
      console.log(`Retrying ${group}: ${journeys === null ? "the whole group" : `${journeys.length} journey${journeys.length === 1 ? "" : "s"} — ${journeys.join("; ")}`}`);
      if (journeys !== null) extra = [...without(rest, "--only"), "--only", exactly(journeys)];
    }
    const start = async () => {
      const tag = `[${folder.padEnd(width)}]`;
      let partial = "";
      const print = chunk => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop();
        for (const line of lines) console.log(`${tag} ${line}`);
      };
      // In a process group and temp folder of its own (TMPDIR: its world, Chrome's profile, anything else it makes there):
      // when it ends, or the runner is interrupted, whatever it left in that group, or listed as still running in its
      // processes.json (a run killed outright never reaches its own finally), is stopped, then the folder goes, before a
      // retry starts (scripts/suite-lifecycle.mjs).
      const one = await runSuite({
        command: process.execPath, args: [script, "--group", group, "--output", join(out, folder), ...extra], prefix: "so-e", keep, onData: print,
        beforeRemove: async () => {
          const left = await stopLeftovers(join(out, folder));
          if (left > 0) console.log(`${tag} stopped ${left} process group${left === 1 ? "" : "s"} it left running`);
        },
      });
      if (partial !== "") console.log(`${tag} ${partial}`);
      return { code: one.code, signal: one.signal, journeys };
    };
    return gate === null ? start() : gate.hold(`${name} ${folder}`, start);
  };

  const runs = await runGroups({ groups: groups.map(one => one.name), limit, run, retry });
  const first = runs.map(each => each.one);
  const again = runs.flatMap(each => each.again === null ? [] : [each.again]);
  /** A retry passes only on its report: every journey that failed the first time, and the browser-error check,
   * PASSED on the retry. A clean exit alone is not enough: a journey skipped (or not run) the second time proved
   * nothing. With no first report to read (the group crashed), the whole group ran again and its exit decides. */
  function retryPassed(one) {
    if (one.code !== 0) return false;
    const before = report(one.group)?.results, after = report(one.folder)?.results;
    if (!before) return true;
    return retryCleared(before, after);
  }
  const judged = again.map(one => ({ ...one, code: retryPassed(one) ? 0 : one.code || 1 }));
  const finished = first.map(one => judged.find(next => next.group === one.group) ?? one);
  console.log("");
  for (const one of [...first, ...again]) {
    const path = join(out, one.folder, "report.md");
    console.log(existsSync(path) ? readFileSync(path, "utf8") : `# ${one.folder} — no report (exited ${one.signal ?? one.code})\n`);
  }
  // Flaky: failed on the first try and passed on the second.
  const flaky = judged.filter(one => one.code === 0).flatMap(one => {
    if (one.journeys === null) return [`${one.group}: the whole group`];
    const passed = new Set((report(one.folder)?.results ?? []).filter(each => each.state === "passed").map(each => each.name));
    return (report(one.group)?.results ?? []).filter(each => each.state === "failed" && passed.has(each.name)).map(each => `${one.group}: ${each.name}`);
  });
  const failed = finished.filter(one => one.code !== 0);
  // The model calls every run made (the retries' too): scripted answers, and turns real models took.
  const calls = [...first, ...again].map(one => report(one.folder)?.modelCalls).filter(Boolean);
  if (calls.length > 0) console.log(`\nModel calls: ${calls.reduce((sum, one) => sum + one.scripted, 0)} scripted, ${calls.reduce((sum, one) => sum + one.real, 0)} real turns`);
  console.log(finished.map(one => `${one.code === 0 ? "✅" : "❌"} ${one.group.padEnd(width)}  ${one.minutes} min`).join("\n"));
  if (flaky.length > 0) console.log(`\nFlaky, passed on the second try:\n${flaky.map(one => `- ${one}`).join("\n")}`);
  console.log(`\n${groups.length - failed.length} of ${groups.length} groups passed${flaky.length > 0 ? ` (${flaky.length} flaky journey${flaky.length === 1 ? "" : "s"})` : ""} in ${minutes(Date.now() - started)} min — ${out}`);
  // This runner's own starts: "provider gate: up to 3 real turns at once, 0 other sessions (cap 4, default); …".
  const facts = gate?.facts(process.pid) ?? null;
  if (facts !== null) console.log(gateWords(facts));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "lanes.json"), `${JSON.stringify({ lanes: limit, wallMs: Date.now() - started, gate: facts, groups: [...first, ...again] }, null, 2)}\n`);
  gate?.close();
  process.exitCode = failed.length === 0 ? 0 : 1;
}
