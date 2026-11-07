#!/usr/bin/env node
/**
 * Runs a pull request's code on a hosted runner as a user of its own (docs/plans/trusted-release-reports.md, H1).
 * `runner` has passwordless sudo, so anything the candidate loads as `runner` (an install script, a Tailwind `@plugin`
 * in the build, a test) could read the job's token, rewrite reports or overwrite another job's artifact. This script is
 * the trusted side: the workflow takes it from the base revision and runs it as root; the candidate gets a copy of the
 * checkout and nothing else.
 *
 *   ci-candidate.mjs prepare --workspace <dir> --temp <RUNNER_TEMP> [--user <existing>] [--npm-cache <dir>] [--tool-cache <dir>]
 *   ci-candidate.mjs run --state <file> [--env NAME=VALUE]... [--report <trusted file>] -- <command...>
 *   ci-candidate.mjs canary --state <file> --harness <this file>
 *   ci-candidate.mjs join --from <downloads> --to <folder>
 *
 * - `prepare` makes the user (or takes the container's own unprivileged one), and copies the checkout to a folder that
 *   user owns: the runner's checkout stays the runner's, so no `safe.directory` and no ownership change is needed there.
 *   The git lanes' `chown` of the whole workspace went for the same reason; the copy is the one ownership exception.
 * - `run` starts one command as that user: exact uid and gid, an empty supplementary group list (libuv's setgroups),
 *   an allowlisted environment, a scratch HOME, cache and temp folder. A report comes back on fd 3 (a socket pair, so
 *   it needs no shared file and no reopen) and is converted here into the verifier's JSON. Afterwards every process of
 *   the user is killed, and a failed cleanup fails the job.
 * - `canary` runs inside every hardened job: scripts/ci-candidate-probe.cjs tries what a hostile candidate would, from
 *   each road its code loads by (plain, a Tailwind `@plugin`, an npm lifecycle script). A probe that didn't run fails
 *   it as surely as an escape does.
 * - `join` picks each shard's newest attempt from the attempt-named artifacts and lays them out as the verifier reads.
 *
 * R1 still stands (the plan says so): isolation protects how results travel, never what the candidate's own tests say.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, chownSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CANDIDATE_USER = "so-candidate";
/** Fixed on macOS, where nothing assigns one: above the hosted image's own users. */
const MACOS_ID = 5501;
const FOLDER = { linux: "/opt/so-c", darwin: "/private/var/so-c" };
/** The only exit codes this script adds to a command's own. */
export const EXIT = { cleanup: 97, report: 98, usage: 2 };
/** What a report may weigh: the suite's whole JSON is a few MB. */
const REPORT_LIMIT = 512 * 1024 * 1024;

/** The only variables a workflow may hand the candidate: names, never a credential's. */
const ENV_NAME = /^(CI|SO_EXPECT_NATIVE_CONTAINMENT|TOOLROLL_REQUIRE_NATIVE|TOOLROLL_TEST_LANE)$/;

/** `NAME=VALUE` from a workflow, checked. Throws on anything else. */
export function allowedEnv(pairs) {
  const env = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const name = at < 0 ? pair : pair.slice(0, at);
    if (at < 0 || !ENV_NAME.test(name)) throw new Error(`${name} isn't a variable the candidate may get`);
    env[name] = pair.slice(at + 1);
  }
  return env;
}

/** The candidate's whole environment. Nothing of the runner's is inherited: no ACTIONS_*, GITHUB_*, RUNNER_* or token. */
export function candidateEnv(state, extra = {}) {
  return {
    PATH: [...(state.toolchain === null ? [] : [join(state.toolchain, "bin")]), "/usr/local/sbin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":"),
    HOME: state.home, TMPDIR: state.tmp, TMP: state.tmp, TEMP: state.tmp, USER: state.user, LOGNAME: state.user,
    LANG: "C.UTF-8", npm_config_cache: state.cache, npm_config_update_notifier: "false", ...extra,
  };
}

/**
 * Vitest's report as the shards' verifier reads it: the same JSON with each file's path moved from the candidate's copy
 * to the runner's checkout. Throws when it isn't a report, or names a file outside the copy.
 */
export function convertReport(text, { from, to }) {
  const report = JSON.parse(text);
  if (report === null || typeof report !== "object" || !Array.isArray(report.testResults)) throw new Error("not a test report");
  for (const result of report.testResults) {
    if (typeof result?.name !== "string" || !result.name.startsWith(`${from}/`)) throw new Error(`a report names ${String(result?.name)}, outside the candidate's copy`);
    result.name = `${to}${result.name.slice(from.length)}`;
  }
  return JSON.stringify(report);
}

/**
 * Each shard's newest attempt among attempt-named artifacts (`shard-<node>-<i>-a<attempt>`, with `macos-` in front on
 * macOS), as `{ shard-<node>-<i>: its folder }`. A rerun of failed jobs only leaves the others on their older attempt.
 * Any other name throws: nothing unexpected is passed over.
 */
export function newestAttempts(names) {
  const newest = new Map();
  for (const name of names) {
    const match = /^(?:macos-)?(shard-\d+-\d+)-a([1-9]\d*)$/.exec(name);
    if (match === null) throw new Error(`unexpected ${name} among the shards' reports`);
    const attempt = Number(match[2]), was = newest.get(match[1]);
    if (was === undefined || attempt > was.attempt) newest.set(match[1], { attempt, name });
  }
  return Object.fromEntries([...newest].map(([shard, { name }]) => [shard, name]));
}

/** Why a canary failed, or null: every road's probe ran, as this user, refused on every count; and nothing outlived it. */
export function canaryProblems(results, { routes, survivors }) {
  const problems = [];
  for (const route of routes) {
    const result = results[route];
    if (result === undefined || result === null) { problems.push(`${route}: the probe never ran, so it proved nothing`); continue; }
    if (result.route !== route) problems.push(`${route}: the probe answered as ${String(result.route)}`);
    if (!Array.isArray(result.attacks) || result.attacks.length === 0) { problems.push(`${route}: the probe tried nothing`); continue; }
    for (const attack of result.attacks) if (attack?.refused !== true) problems.push(`${route}: ${String(attack?.name)}: ${String(attack?.detail)}`);
  }
  for (const pid of survivors) problems.push(`process ${pid} outlived the candidate's step`);
  return problems;
}

/**
 * One command as the candidate's user. `report`: the file (inside the copy) whose bytes come back on fd 3. Resolves with
 * its exit code and what fd 3 carried, after `settle` (the cleanup) ran, so nothing of the user's holds the pipe open.
 */
export function launch(state, command, { env, report = null, settle = async () => {}, identity = { uid: state.uid, gid: state.gid } }) {
  return new Promise((done, failed) => {
    const script = report === null ? null : `"$@" 3>&-; status=$?; if [ -f "$CANDIDATE_REPORT" ]; then cat "$CANDIDATE_REPORT" >&3; fi; exit "$status"`;
    const [file, ...args] = script === null ? command : ["/bin/sh", "-c", script, "candidate", ...command];
    const child = spawn(file, args, { cwd: state.checkout, env: report === null ? env : { ...env, CANDIDATE_REPORT: report }, ...identity,
      stdio: ["ignore", "inherit", "inherit", ...(report === null ? [] : ["pipe"])] });
    const chunks = [];
    let size = 0;
    child.stdio[3]?.on("data", chunk => { size += chunk.length; if (size <= REPORT_LIMIT) chunks.push(chunk); });
    child.stdio[3]?.on("error", () => {});
    child.once("error", failed);
    child.once("exit", (code, signal) => {
      void settle().then(() => {
        const finish = () => done({ code: code ?? (signal === null ? 1 : 128), report: size > REPORT_LIMIT ? null : Buffer.concat(chunks) });
        if (child.stdio[3] === undefined || child.stdio[3] === null || child.stdio[3].closed || child.stdio[3].destroyed) return finish();
        const wait = setTimeout(() => { child.stdio[3].destroy(); finish(); }, 30_000);
        child.stdio[3].once("close", () => { clearTimeout(wait); finish(); });
      }, failed);
    });
  });
}

/** A helper as the user itself: `kill(-1)` reaches exactly what that uid may signal, which is all of its processes. */
const asUser = (state, code) => spawnSync(state.toolchain === null ? process.execPath : join(state.toolchain, "bin", "node"), ["-e", code], { uid: state.uid, gid: state.gid, env: { PATH: "/usr/bin:/bin" }, cwd: "/", stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 20_000 });

/** The live processes in a `ps` listing (uid, real uid, pid, state) that run as `uid`. A zombie has already ended. */
export function processesOf(listing, uid) {
  const pids = [];
  for (const line of listing.split("\n")) {
    const [effective, real, pid, stat] = line.trim().split(/\s+/);
    if (stat === undefined || stat.startsWith("Z")) continue;
    if (Number(effective) === uid || Number(real) === uid) pids.push(Number(pid));
  }
  return pids;
}

/** What `ps` shows of the user, read as root. Null when it can't be read: that proves nothing. `kill(-1, 0)` can't answer
 * this: Linux counts processes it may not signal as found, and macOS says EPERM where nothing is left. */
function candidateProcesses(state) {
  const listing = spawnSync("ps", ["-A", "-o", "uid=", "-o", "ruid=", "-o", "pid=", "-o", "stat="], { encoding: "utf8", timeout: 20_000 });
  return listing.status === 0 && listing.stdout.trim() !== "" ? processesOf(listing.stdout, state.uid) : null;
}

/** Every process of the user, gone and shown gone (a `ps` that lists none). Only as root, only on that user:
 * it is a whole-user signal, so anything else refuses before it. False when one stays. */
export function killAll(state) {
  if (process.getuid?.() !== 0 || !Number.isSafeInteger(state.uid) || state.uid <= 0) throw new Error("only root ends a candidate's processes");
  for (let round = 0; round < 25; round++) {
    asUser(state, 'try { process.kill(-1, "SIGKILL"); } catch {}');
    if (candidateProcesses(state)?.length === 0) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return false;
}

const flagsOf = args => {
  const flags = new Map(), rest = [];
  for (let at = 0; at < args.length; at++) {
    if (args[at] === "--") { rest.push(...args.slice(at + 1)); break; }
    if (!args[at].startsWith("--")) { rest.push(args[at]); continue; }
    flags.set(args[at].slice(2), [...(flags.get(args[at].slice(2)) ?? []), args[++at]]);
  }
  return { one: name => flags.get(name)?.at(-1), many: name => flags.get(name) ?? [], rest };
};
const must = (value, name) => { if (value === undefined) throw new Error(`--${name} is needed`); return value; };
const sh = (file, args, options = {}) => { const out = spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options }); if (out.status !== 0) throw new Error(`${file} ${args.join(" ")} ended ${out.status}`); return out.stdout.trim(); };

function makeUser(name, home) {
  if (process.platform === "linux") {
    if (spawnSync("id", ["-u", name], { stdio: "ignore" }).status !== 0) sh("useradd", ["--no-create-home", "--home-dir", home, "--user-group", "--shell", "/usr/sbin/nologin", name]);
    for (const deny of ["/etc/cron.deny", "/etc/at.deny"]) writeFileSync(deny, `${name}\n`, { flag: "a" });
    return;
  }
  if (spawnSync("id", ["-u", name], { stdio: "ignore" }).status === 0) return;
  const at = `/Users/${name}`;
  sh("dscl", [".", "-create", at]);
  for (const [key, value] of [["UserShell", "/usr/bin/false"], ["RealName", name], ["UniqueID", String(MACOS_ID)], ["PrimaryGroupID", String(MACOS_ID)], ["NFSHomeDirectory", home]]) sh("dscl", [".", "-create", at, key, value]);
  mkdirSync("/usr/lib/cron", { recursive: true });
  writeFileSync("/usr/lib/cron/cron.deny", `${name}\n`, { flag: "a" });
}

function prepare(flags) {
  if (process.getuid?.() !== 0) throw new Error("prepare runs as root");
  const workspace = resolve(must(flags.one("workspace"), "workspace")), temp = resolve(must(flags.one("temp"), "temp"));
  const given = flags.one("user");
  const user = given ?? CANDIDATE_USER;
  const root = FOLDER[process.platform];
  if (root === undefined) throw new Error(`no candidate user on ${process.platform}`);
  if (given === undefined) makeUser(user, join(root, "home"));
  const uid = Number(sh("id", ["-u", user])), gid = Number(sh("id", ["-g", user]));
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) throw new Error(`${user} isn't an unprivileged user`);
  if (String(uid) === process.env["SUDO_UID"]) throw new Error(`${user} is the runner's own user`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o755 });
  const state = { user, uid, gid, root, workspace, temp, checkout: join(root, "checkout"), home: join(root, "home"), tmp: join(root, "tmp"), cache: join(root, "cache"), toolchain: null };
  // The harness's own copy of the base revision stays behind; the checkout's Git data comes (migration tests read old commits).
  const skip = join(workspace, ".trusted-base");
  cpSync(workspace, state.checkout, { recursive: true, verbatimSymlinks: true, filter: from => from !== skip });
  for (const one of [state.home, state.tmp, state.cache]) mkdirSync(one, { recursive: true, mode: 0o700 });
  const npmCache = flags.one("npm-cache");
  if (npmCache !== undefined && existsSync(npmCache)) cpSync(npmCache, state.cache, { recursive: true, verbatimSymlinks: true });
  // A node from the runner's tool cache lies in folders that aren't the candidate's to read on every image: it gets a copy.
  const tools = flags.one("tool-cache");
  if (tools !== undefined && process.execPath.startsWith(`${resolve(tools)}/`)) {
    state.toolchain = join(root, "toolchain");
    cpSync(dirname(dirname(process.execPath)), state.toolchain, { recursive: true, verbatimSymlinks: true });
  }
  for (const one of [state.checkout, state.home, state.tmp, state.cache]) sh("chown", ["-hR", `${uid}:${gid}`, one]);
  const file = join(temp, "candidate-state.json");
  writeFileSync(file, JSON.stringify(state), { mode: 0o644 });
  // What each later step calls: this file, from where the workflow put it, with the state it just wrote.
  const harness = fileURLToPath(import.meta.url);
  writeFileSync(join(temp, "candidate"), `#!/bin/sh\ncommand="$1"; shift\nexec ${process.env["SUDO_UID"] === undefined ? "" : "sudo -n "}${JSON.stringify(process.execPath)} ${JSON.stringify(harness)} "$command" --state ${JSON.stringify(file)} --harness ${JSON.stringify(harness)} "$@"\n`, { mode: 0o755 });
  console.log(`candidate: ${user} (uid ${uid}, gid ${gid}), checkout ${state.checkout}`);
}

const stateOf = flags => JSON.parse(readFileSync(must(flags.one("state"), "state"), "utf8"));
const settled = state => async () => { if (!killAll(state)) throw new Error(`${state.user}'s processes couldn't be ended`); };

async function runCommand(flags) {
  const state = stateOf(flags);
  const command = flags.rest;
  if (command.length === 0) throw new Error("no command");
  const env = candidateEnv(state, allowedEnv(flags.many("env")));
  const trusted = flags.one("report");
  const inside = join(state.tmp, "report.json");
  const argv = trusted === undefined ? command : [...command, "--reporter=default", "--reporter=json", `--outputFile.json=${inside}`];
  let ended;
  try { ended = await launch(state, argv, { env, report: trusted === undefined ? null : inside, settle: settled(state) }); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); return EXIT.cleanup; }
  if (trusted === undefined) return ended.code;
  try {
    const converted = convertReport(ended.report?.toString("utf8") ?? "", { from: state.checkout, to: state.workspace });
    mkdirSync(dirname(trusted), { recursive: true });
    writeFileSync(trusted, converted, { mode: 0o644 });
    if (process.env["SUDO_UID"] !== undefined) chownSync(trusted, Number(process.env["SUDO_UID"]), Number(process.env["SUDO_GID"] ?? 0));
  } catch (error) {
    console.error(`no usable report came back: ${error instanceof Error ? error.message : String(error)}`);
    return ended.code === 0 ? EXIT.report : ended.code;
  }
  return ended.code;
}

/** The nearest process of the runner's own user above this one (the step's shell): what the probe tries to signal. */
function runnerProcess() {
  const parent = pid => Number(spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
  const owner = pid => spawnSync("ps", ["-o", "uid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  for (let pid = process.ppid, hops = 0; pid > 1 && hops < 8; pid = parent(pid), hops++) if (owner(pid) !== "0" && owner(pid) !== "") return pid;
  return process.ppid;
}

export const CANARY_ROUTES = ["plain", "tailwind-plugin", "npm-lifecycle"];

async function canary(flags) {
  const state = stateOf(flags);
  const harness = resolve(must(flags.one("harness"), "harness"));
  const stage = join(state.root, "canary"), out = join(state.tmp, "canary");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { mode: 0o755 });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chownSync(out, state.uid, state.gid);
  const probe = join(stage, "probe.cjs");
  cpSync(join(dirname(harness), "ci-candidate-probe.cjs"), probe);
  // Tailwind resolves `tailwindcss` from the stylesheet's folder, so its stylesheet sits in the copy, as the build's does.
  const css = join(state.checkout, ".candidate-canary");
  mkdirSync(css, { recursive: true });
  writeFileSync(join(css, "plugin.cjs"), `require(${JSON.stringify(probe)}).probe("tailwind-plugin"); module.exports = function () {};\n`);
  writeFileSync(join(css, "in.css"), '@import "tailwindcss";\n@plugin "./plugin.cjs";\n');
  const npmRoad = join(state.tmp, "canary-npm");
  mkdirSync(npmRoad, { recursive: true });
  writeFileSync(join(npmRoad, "package.json"), JSON.stringify({ name: "candidate-canary", version: "0.0.0", private: true, scripts: { preinstall: `node ${JSON.stringify(probe)} npm-lifecycle` } }));
  for (const one of [css, npmRoad]) sh("chown", ["-hR", `${state.uid}:${state.gid}`, one]);
  const env = candidateEnv(state, { CANDIDATE_CANARY: JSON.stringify({ out, uid: state.uid, gid: state.gid, runner: runnerProcess(), harness, state: flags.one("state"), workspace: state.workspace, temp: state.temp }) });
  const node = join(state.toolchain ?? dirname(dirname(process.execPath)), "bin", "node");
  const roads = [
    [node, probe, "plain"],
    [node, join(state.checkout, "node_modules/@tailwindcss/cli/dist/index.mjs"), "-i", join(css, "in.css"), "-o", join(state.tmp, "canary.css")],
    ["/bin/sh", "-c", `cd ${JSON.stringify(npmRoad)} && npm install --foreground-scripts --no-audit --no-fund`],
  ];
  for (const road of roads) await launch(state, road, { env });
  const settle = killAll(state);
  rmSync(css, { recursive: true, force: true });
  const results = {}, pids = [];
  for (const route of CANARY_ROUTES) {
    try { results[route] = JSON.parse(readFileSync(join(out, `${route}.json`), "utf8")); pids.push(...(results[route].left ?? [])); } catch { results[route] = null; }
  }
  // A pid the system has since given to someone else is not a survivor; an unreadable listing counts every pid as one.
  const remaining = candidateProcesses(state);
  const survivors = pids.filter(pid => Number.isSafeInteger(pid) && pid > 1 && (remaining === null || remaining.includes(pid)));
  const problems = canaryProblems(results, { routes: CANARY_ROUTES, survivors });
  if (!settle) problems.push(`${state.user}'s processes couldn't be ended`);
  for (const route of CANARY_ROUTES) console.log(`canary ${route}: ${results[route]?.attacks?.length ?? 0} attempts`);
  for (const one of problems) console.error(`::error::candidate canary: ${one}`);
  return problems.length === 0 ? 0 : 1;
}

function joinArtifacts(flags) {
  const from = must(flags.one("from"), "from"), to = must(flags.one("to"), "to");
  mkdirSync(to, { recursive: true });
  for (const [shard, name] of Object.entries(newestAttempts(readdirSync(from)))) renameSync(join(from, name), join(to, shard));
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const flags = flagsOf(args);
  try {
    if (command === "prepare") { prepare(flags); process.exit(0); }
    if (command === "run") process.exit(await runCommand(flags));
    if (command === "canary") process.exit(await canary(flags));
    if (command === "join") process.exit(joinArtifacts(flags));
    console.error(`usage: ${basename(process.argv[1])} prepare|run|canary|join`);
    process.exit(EXIT.usage);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
