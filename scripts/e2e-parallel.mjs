#!/usr/bin/env node
/**
 * Run the groups of an end-to-end script side by side, each in its own world, and
 * fail if any group fails. The script lists its groups with `--groups --json`
 * and runs one with `--group <name>`. At most as many groups run at once as
 * the memory available allows (~400 MB each, at most 6; --at-once <n> sets it),
 * and a group starts only while there is room for it (check-memory.mjs).
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
 * output/e2e/<script>-parallel-<time>/<group>/report.md and is printed at the end.
 *
 * A group with failed journeys runs once more in a fresh world with just those
 * journeys, what they need (each report names every journey's needs) and the
 * browser-error check; a journey that passes then is flaky (a follow-up), not a
 * failed run. With no report to read, or only the browser-error check failed,
 * the whole group runs again.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BROWSER_CHECK, exactly, here, retryCleared, retrySet, stopGroups, stopLeftovers } from "./e2e-kit.mjs";
import { availableMemory, browserSlots, limiter } from "./check-memory.mjs";

const [script, ...given] = process.argv.slice(2);
if (script === undefined) { console.error("Usage: node scripts/e2e-parallel.mjs <script.mjs> [--no-retry] [--at-once <n>] [--output <dir>] [options for every group]"); process.exit(2); }
const retry = !given.includes("--no-retry");
const keep = given.includes("--keep");
const at = given.indexOf("--output");
const onceAt = given.indexOf("--at-once");
const atOnce = onceAt === -1 ? null : Number(given[onceAt + 1]);
if (atOnce !== null && !(Number.isInteger(atOnce) && atOnce >= 1)) { console.error("--at-once takes a whole number, 1 or more."); process.exit(2); }
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
const out = resolve(at === -1 ? join(here, "output/e2e", `${name}-parallel-${new Date().toISOString().replace(/[:.]/g, "-")}`) : given[at + 1]);
const started = Date.now();
const minutes = ms => Math.round(ms / 6000) / 10;
const width = Math.max(...groups.map(one => one.name.length)) + "-retry".length;
const available = availableMemory();
const limit = Math.min(groups.length, atOnce ?? browserSlots(available));
const slot = limiter(limit);
console.log(`Running ${groups.length} groups, at most ${limit} at once (${(available / 1024 ** 3).toFixed(1)} GB available, about 400 MB each): ${groups.map(one => one.name).join(", ")}`);

const runGroup = (group, folder, extra = []) => slot(() => new Promise(done => {
  const at = Date.now();
  // Its own temp folder: what it leaves there (a world kept after a crash, Chrome's profile) goes when it ends.
  const temp = mkdtempSync(join(tmpdir(), "so-e2e-tmp-"));
  // In a process group of its own: when it ends, whatever it left in that group, or listed as still running in its
  // processes.json (a run killed outright never reaches its own finally), is stopped before a retry starts.
  const child = spawn(process.execPath, [script, "--group", group, "--output", join(out, folder), ...extra], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, TMPDIR: temp } });
  running.add(child.pid);
  const tag = `[${folder.padEnd(width)}]`;
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream.on("data", chunk => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop();
      for (const line of lines) console.log(`${tag} ${line}`);
    });
    stream.on("end", () => { if (partial !== "") console.log(`${tag} ${partial}`); });
  }
  child.on("close", async (code, signal) => {
    await stopGroups([child.pid], { graceMs: 5_000 }).catch(() => undefined);
    running.delete(child.pid);
    const left = await stopLeftovers(join(out, folder));
    if (left > 0) console.log(`${tag} stopped ${left} process group${left === 1 ? "" : "s"} it left running`);
    if (!keep) rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
    done({ group, folder, code: code ?? 1, signal, minutes: minutes(Date.now() - at) });
  });
}));
const running = new Set();
// Interrupted, the runner takes every group's run with it (they are not in its process group); each run's own exit
// handler stops what it owns.
process.on("exit", () => { for (const pid of running) { try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ } } });

const report = folder => { try { return JSON.parse(readFileSync(join(out, folder, "report.json"), "utf8")); } catch { return null; } };
// The first run's own --only is replaced by the journeys to retry (they are a subset of it).
const without = (list, flag) => list.filter((one, index) => one !== flag && list[index - 1] !== flag);

// A failed group runs again as soon as its first run ends, not after every group's.
const runs = await Promise.all(groups.map(async ({ name: group }) => {
  const one = await runGroup(group, group, rest);
  if (!retry || one.code === 0) return { one, again: null };
  const journeys = retrySet(report(one.folder)?.results ?? []);
  console.log(`Retrying ${one.group}: ${journeys === null ? "the whole group" : `${journeys.length} journey${journeys.length === 1 ? "" : "s"} — ${journeys.join("; ")}`}`);
  const again = await runGroup(one.group, `${one.group}-retry`, journeys === null ? rest : [...without(rest, "--only"), "--only", exactly(journeys)]);
  return { one, again: { ...again, journeys } };
}));
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
process.exitCode = failed.length === 0 ? 0 : 1;
