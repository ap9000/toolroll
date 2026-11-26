#!/usr/bin/env node
/**
 * One container lane of the install smoke (scripts/container-smoke.sh sets the lane up, .github/workflows/install-smoke.yml
 * runs it): the packed Toolroll installed the way a person installs it, then `toolroll` started at a terminal (a real
 * pseudo-terminal through util-linux `script`), first and again, the way the everyone review did. It asserts outcomes
 * and state, not words alone:
 *
 *   open    the screen opened password-free: the database has local mode on, the console recorded its address, and the
 *           screen drew; then it is stopped the way a person stops it (`toolroll stop`), and every process the worker's
 *           record names (runner-processes/) is awaited until it has exited. A second "open" must be a new worker (a
 *           different recorded `up` identity) on the same installation (local mode's record unchanged).
 *   refuse  it stopped by itself with exit 3, said each --words pattern, and made no database (nothing to inherit).
 *
 * Never, in any lane: an uncaught error (no xdg-open, no ps, no display). --repair runs the commands the refusal printed
 * under "Fix it with:" before the second start. Runs inside a throwaway container as the lane's user: it reads no
 * secret, calls no model, and needs only the public npm registry.
 *
 *   node container-smoke.mjs --tarball <file.tgz> [--umask <octal>] [--home-prefix] [--node-major <n>] --first open|refuse [--words <regex>]...
 *     [--repair] --again open|refuse
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const tarball = flag("--tarball");
const first = flag("--first");
const again = flag("--again");
const words = args.flatMap((one, at) => one === "--words" ? [new RegExp(args[at + 1])] : []);
const repair = args.includes("--repair");
if (tarball === undefined || !["open", "refuse"].includes(first) || !["open", "refuse"].includes(again)) {
  process.stderr.write("usage: node container-smoke.mjs --tarball <file.tgz> --first open|refuse [--words <regex>]... [--repair] --again open|refuse\n");
  process.exit(2);
}

const home = homedir();
// The lane's person: their umask (a desktop's 0002), and npm's global prefix in their home.
const umask = flag("--umask");
if (umask !== undefined) process.umask(parseInt(umask, 8));
if (args.includes("--home-prefix")) {
  mkdirSync(join(home, ".npm-global"), { recursive: true });
  process.env.NPM_CONFIG_PREFIX = join(home, ".npm-global");
  process.env.PATH = `${join(home, ".npm-global", "bin")}:${process.env.PATH}`;
}
const state = join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "toolroll");
const database = join(state, "orders.db");
let failed = false;
const say = (ok, what, detail = "") => { process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${what}${detail === "" ? "" : ` — ${detail}`}\n`); if (!ok) failed = true; return ok; };
const plain = text => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-Za-z]|\u001b[=>78]/g, "").replace(/\r/g, "");

function run(file, list, options = {}) {
  const done = spawnSync(file, list, { encoding: "utf8", timeout: 600_000, ...options });
  return { code: done.status, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
}

/** Local mode's row as the database holds it, read only (enabled, owner, when it was set up), or null. */
function localModeRow() {
  if (!existsSync(database)) return null;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(database, { readOnly: true });
    try { const row = db.prepare("SELECT enabled, owner, initialized_at FROM local_mode WHERE id = 1").get(); return row === undefined ? null : { ...row }; } finally { db.close(); }
  } catch { return null; }
}

/** The processes the worker's records name (runner-processes/*.json beside the database): pid, role, identity. */
function recordedProcesses() {
  const folder = join(state, "runner-processes");
  let names = [];
  try { names = readdirSync(folder).filter(name => name.endsWith(".json")); } catch { return []; }
  return names.flatMap(name => { try { return JSON.parse(readFileSync(join(folder, name), "utf8")).processes ?? []; } catch { return []; } });
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/** Wait for a fact, polled, up to a ceiling (ms): true once it holds. */
async function until(fact, ceilingMs) {
  const deadline = Date.now() + ceilingMs;
  while (Date.now() < deadline) {
    if (fact()) return true;
    // guard: bound one poll interval of a fact-based wait with a ceiling.
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return fact();
}

/** Local mode as the database holds it, read only: true, false, or null when there is no such row or database. */
function localModeOn() {
  if (!existsSync(database)) return null;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(database, { readOnly: true });
    try { const row = db.prepare("SELECT enabled FROM local_mode WHERE id = 1").get(); return row === undefined ? null : row.enabled === 1; } finally { db.close(); }
  } catch { return null; }
}

const OPENED = /Nothing ne+ds you|What would you like to work on|No tasks yet/;
const CRASH = /Unhandled 'error' event|node:events:\d+|at ChildProcess\._handle\.onexit|Error: spawn \S+ ENOENT/;

/** `toolroll` at a pseudo-terminal in the project; resolves when it exits, or once the screen opened and it was stopped. */
function start(project) {
  return new Promise(resolve => {
    const child = spawn("script", ["-qfec", "toolroll", "/dev/null"], { cwd: project, env: { ...process.env, TERM: "xterm-256color", COLUMNS: "120", LINES: "40" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let opened = false;
    let settled = false;
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { out += chunk; });
    const finish = (code) => { if (settled) return; settled = true; clearInterval(look); clearTimeout(ceiling); resolve({ code, out: plain(out), opened }); };
    child.once("exit", code => finish(code));
    // Facts, not time: the screen drew, local mode is on, the console recorded its address and the worker its `up`;
    // then it is stopped the way a person stops it, and everything the worker recorded must exit.
    const look = setInterval(() => {
      if (opened || !OPENED.test(plain(out)) || localModeOn() !== true || !existsSync(join(state, "up-console.json"))) return;
      const worker = recordedProcesses();
      if (!worker.some(one => one.role === "up" && alive(one.pid))) return;
      opened = { worker, local: localModeRow() };
      const stop = run("toolroll", ["stop"]);
      opened.stop = stop;
      // The screen ends once its worker is gone; if it doesn't, this run's own `script` is ended (by its pid).
      void until(() => child.exitCode !== null || child.signalCode !== null, 60_000).then(done => { if (!done) child.kill("SIGTERM"); });
    }, 250);
    // guard: bound a lane that never opens nor exits fails here instead of at the job's limit.
    const ceiling = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, 240_000);
  });
}

let previous = null;
async function expectRun(name, expected, result) {
  say(!CRASH.test(result.out), `${name}: no uncaught error`, CRASH.exec(result.out)?.[0] ?? "");
  if (expected === "open") {
    const seen = result.opened;
    say(seen !== false, `${name}: the screen opened`, seen !== false ? "" : result.out.trim().split("\n").slice(-8).join(" | "));
    say(localModeOn() === true, `${name}: password-free (local mode on in the database)`);
    if (seen === false) return;
    say(seen.stop.code === 0, `${name}: \`toolroll stop\` stopped it`, seen.stop.out.trim());
    const pids = seen.worker.map(one => one.pid);
    say(await until(() => pids.every(pid => !alive(pid)), 60_000), `${name}: every process the worker recorded has exited`, pids.filter(alive).join(", "));
    const up = seen.worker.find(one => one.role === "up");
    if (previous !== null) {
      const before = previous.worker.find(one => one.role === "up");
      say(up !== undefined && before !== undefined && (up.pid !== before.pid || up.started !== before.started), `${name}: a new worker (not the first one's)`, `${JSON.stringify(before)} → ${JSON.stringify(up)}`);
      say(JSON.stringify(seen.local) === JSON.stringify(previous.local), `${name}: the same installation (local mode's record kept)`, `${JSON.stringify(previous.local)} → ${JSON.stringify(seen.local)}`);
    }
    previous = seen;
  } else {
    say(result.code === 3, `${name}: refused by itself with exit 3`, `exit ${result.code}`);
    for (const pattern of words) say(pattern.test(result.out), `${name}: says ${pattern}`, pattern.test(result.out) ? "" : result.out.trim().split("\n").slice(-12).join(" | "));
    say(!existsSync(database), `${name}: no database was made`);
  }
}

/** The commands under "Fix it with:", as printed (two spaces in), until the first line that isn't one. */
function repairCommands(out) {
  const lines = out.split("\n");
  const commands = [];
  for (let at = lines.findIndex(line => line.trim() === "Fix it with:") + 1; at > 0 && at < lines.length && /^ {2,}\S/.test(lines[at]); at++) commands.push(lines[at].trim());
  return commands;
}

const major = flag("--node-major");
if (major !== undefined) say(process.versions.node.split(".")[0] === major, `Node ${major}`, process.version);
const installed = run("npm", ["install", "-g", tarball, "--no-fund", "--no-audit", "--loglevel=error"]);
say(installed.code === 0, "npm install -g the packed tarball", installed.code === 0 ? "" : installed.out.trim().slice(-600));
const version = run("toolroll", ["--version"]);
say(version.code === 0, "toolroll --version", version.out.trim());
const project = join(home, "proj", "my app");
mkdirSync(project, { recursive: true });
run("git", ["init", "-q"], { cwd: project });
run("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: project });

if (!failed) {
  const one = await start(project);
  process.stdout.write(`---- first start\n${one.out.trim().split("\n").slice(-25).join("\n")}\n----\n`);
  await expectRun("first start", first, one);
  if (repair) {
    const commands = repairCommands(one.out);
    say(commands.length > 0, "the refusal printed its repair", commands.join("; "));
    for (const command of commands) { const fixed = run("/bin/sh", ["-c", command]); say(fixed.code === 0, `ran: ${command}`, fixed.out.trim()); }
    const doctor = run("toolroll", ["doctor"]);
    say(!/can't be trusted/.test(doctor.out), "toolroll doctor after the repair: nothing left to fix", doctor.out.split("\n").filter(line => /Sandbox:|can't be trusted/.test(line)).join(" | "));
  }
  const two = await start(project);
  process.stdout.write(`---- second start\n${two.out.trim().split("\n").slice(-25).join("\n")}\n----\n`);
  await expectRun("second start", again, two);
  if (again === "refuse") say(!existsSync(join(state, ".toolroll-secrets")), "no password was saved");
}
process.exit(failed ? 1 : 0);
