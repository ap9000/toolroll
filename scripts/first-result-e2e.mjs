#!/usr/bin/env node
/**
 * The first-result clock (docs/plans/public-release.md, B1 and slice 1; measure only): a newcomer's first run, from the
 * install command to an accepted first result, recorded as a trace — each step with its time, its kind (a decision the
 * person must make, an interaction, a wait) and what was on screen — with split timings, written to
 * evidence/first-result/<time>-<mode>/first-result.json and first-result.md.
 *
 * The newcomer's first run is in the terminal (bare `toolroll`), so the timed path drives the terminal UI at a real
 * pseudo-terminal (scripts/fixtures/pty-host.py: macOS's `script` refuses a FIFO on its stdin), its keys typed through
 * a FIFO, its screen read back by a small terminal emulator (scripts/first-result-kit.mjs). The browser path is measured too, for comparison. Where the terminal can't
 * do a step today, the trace says so ("not possible in the terminal today") with what the person does instead, and the
 * journey does that.
 *
 *   node scripts/first-result-e2e.mjs [--journeys scripted] [--only <pattern>] [--keep]
 *       Scripted (the default): this checkout's build (npm run build first), the models answering at once from
 *       scripts. Proves the driver, the step counts and the failure paths: no agent installed, an agent signed out,
 *       not in a git repository, a model error mid-build, and a restart (the console killed mid-build); and the plan
 *       road a real model's sizing can choose. No model call, no download. The journeys pass when the driver
 *       could measure; each B1 criterion is recorded as met or not in the report (slice 1 measures, it fixes nothing).
 *
 *   node scripts/first-result-e2e.mjs --journeys real --package toolroll@<version> --confirm-real-run
 *       [--install npx|npm|brew] [--allow-brew] [--network "<line about this connection>"]
 *       Real: real models (this computer's own Claude Code sign-in), the package from the registry (or a packed
 *       tarball, whose download then isn't measured), an empty npm cache, a throwaway home. npx is the default; npm
 *       installs into a throwaway prefix; brew installs into this computer's own Homebrew and needs --allow-brew.
 *       Refuses to start without --package and --confirm-real-run.
 *
 * Every Toolroll a journey starts has a throwaway home, its tool secrets kept as files (never the login keychain), a
 * stand-in `tailscale` (so its console is a protected loopback install, as on a laptop with no tailnet), and a
 * `launchctl` and `systemctl` that refuse (it never installs a login item); the journey never answers yes to the
 * background question. A new laptop install picks the first free port from 4180 on, as a newcomer's does.
 */
import { execFileSync, execFile } from "node:child_process";
import { chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { cpus, homedir, release, totalmem, type as osType, arch } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

// The kit reads its options when it loads: a run that names no --journeys is scripted here (the kit's own default is
// real models).
if (!process.argv.includes("--journeys")) process.argv.push("--journeys", "scripted");
const kit = await import("./e2e-kit.mjs");
const { world, flag, option, until, sleep, spawnOwned, own, stopGroups, groupAlive, waitFor, here, SCRIPTED, REAL_MODEL, Skip, GiveUp, SKIPPED_FADE, REAL_TURN_MS } = kit;
const { makeTempRoot } = await import("./suite-lifecycle.mjs");
const fr = await import("./first-result-kit.mjs");
const { Screen, plainText, looksLikeStackTrace, createTrace, countsOf, splitsOf, totalOf, launchPlan, packageSource, realRunRefusal, PERSON_SECONDS } = fr;

const journeysMode = option("--journeys", "scripted");
const listing = flag("--list");
const scriptedRun = journeysMode === "scripted";
const install = option("--install", scriptedRun ? "local" : "npx");
const pkg = option("--package", null);
if (!listing) {
  if (scriptedRun && install !== "local") { console.error("A scripted run uses this checkout's build (--install local); --install npx|npm|brew is for --journeys real."); process.exit(2); }
  const refusal = realRunRefusal({ journeys: journeysMode, pkg, confirmed: flag("--confirm-real-run"), install, allowBrew: flag("--allow-brew") });
  if (refusal !== null) { console.error(`Not started: ${refusal}`); process.exit(2); }
}

/** The task every timed run types, word for word (v2: a frozen task). */
const TASK = "Add a subtract(a, b) function next to add in src/math.js, with a test.";
/** The repository every timed run starts in (v2: frozen): the same files and the same commit, so the same commit id. */
const SHOP_FILES = {
  "package.json": JSON.stringify({ name: "shop", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "src/math.js": "// TODO: add a subtract(a, b) function next to add\nexport const add = (a, b) => a + b;\n",
  "test/math.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('adds', () => assert.equal(add(2, 3), 5));\n",
  "README.md": "# Shop\n\nA tiny shop library.\n",
};
const SHOP_COMMIT_ENV = { GIT_AUTHOR_NAME: "Sam Rivera", GIT_AUTHOR_EMAIL: "sam@example.invalid", GIT_COMMITTER_NAME: "Sam Rivera", GIT_COMMITTER_EMAIL: "sam@example.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
/** The tasks the scripted variants type: each its own words, so each journey's scripted answers match only its own task
 * (a world keeps every journey's rules, tried in order). */
const PLAN_TASK = "Add a subtract(a, b) function next to add in src/math.js, with a test, and explain it in the README.";
const ERROR_TASK = "Add a multiply(a, b) function next to add in src/math.js, with a test.";
const RESTART_TASK = "Add a negate(a) function next to add in src/math.js, with a test.";
/** The shop's math module and test with one more function (a scripted build's answer). */
const mathWith = (name, source, check) => ({
  "src/math.js": `export const add = (a, b) => a + b;\nexport const ${name} = ${source};\n`,
  "test/math.test.js": `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, ${name} } from '../src/math.js';\n\ntest('adds', () => assert.equal(add(2, 3), 5));\ntest('${name}', () => ${check});\n`,
});
/** A pattern for exactly these words (a scripted answer for this task alone: a brief also carries the project's files). */
const wordsOf = text => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
/** The builder's scripted answer to TASK. */
const mathFiles = () => ({
  "src/math.js": "export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\n",
  "test/math.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, subtract } from '../src/math.js';\n\ntest('adds', () => assert.equal(add(2, 3), 5));\ntest('subtracts', () => assert.equal(subtract(5, 2), 3));\n",
});
/** The sample project's files after its "whole cents" starter. */
const roundedPriceFiles = () => ({
  "src/price.js": "/** The price after a percentage discount, in whole cents. */\nexport function priceWithDiscount(price, percent) {\n  return Math.round((price - (price * percent) / 100) * 100) / 100;\n}\n",
  "test/price.test.js": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { priceWithDiscount } from \"../src/price.js\";\n\ntest(\"takes the discount off the price\", () => {\n  assert.equal(priceWithDiscount(80, 25), 60);\n});\ntest(\"rounds to whole cents\", () => {\n  assert.equal(priceWithDiscount(9.99, 33), 6.69);\n});\n",
});

const w = await world("first-result", {});
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidence = option("--evidence", join(here, "evidence", "first-result", `${stamp}-${scriptedRun ? "scripted" : "real"}`));
const real = !scriptedRun;
/** How long a wait may take: a scripted model answers at once; a real one takes real turns. */
const WAIT = real ? { start: 10 * 60_000, sizing: 120_000, plan: 2 * REAL_TURN_MS, build: 3 * REAL_TURN_MS, ready: 5 * 60_000 } : { start: 120_000, sizing: 60_000, plan: 120_000, build: 180_000, ready: 120_000 };

const shellWord = text => `'${String(text).replace(/'/g, "'\\''")}'`;
/** The first words Toolroll itself prints at a terminal: the end of npx's download. */
const TOOLROLL_FIRST_LINE = /Starting Toolroll|Toolroll is on|Get to your first result|Nothing needs you|needs you|local mode is on|Toolroll didn't start|can't open/;
/** The terminal host and the python3 that runs it (the system's own, as a newcomer's computer has it). */
const PTY_HOST = join(here, "scripts", "fixtures", "pty-host.py");
const PYTHON = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"].find(one => existsSync(one)) ?? "python3";

// ------------------------------------------------------------------ the run's report

const machine = {
  os: `${osType()} ${release()} (${process.platform} ${arch()})`, cpu: `${cpus()[0]?.model ?? "unknown CPU"} × ${cpus().length}`,
  memoryGb: Math.round(totalmem() / 2 ** 30), node: process.versions.node, network: option("--network", null),
};
const localVersion = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;
const localHead = (() => { try { return execFileSync("git", ["-C", here, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
const plan0 = launchPlan({ install, pkg, root: "/", localBin: w.bin });
const report = {
  mode: scriptedRun ? "scripted" : "real", startedAt: new Date().toISOString(), install,
  package: install === "local" ? { spec: `this checkout (${localHead})`, version: localVersion, integrity: null } : { spec: pkg, kind: packageSource(pkg)?.kind ?? null, version: packageSource(pkg)?.version ?? null, integrity: null },
  notes: [...plan0.notes, "a throwaway home; tool secrets as files, not the login keychain; a stand-in tailscale; launchctl and systemctl refuse"],
  task: TASK, repo: null, machine, personSeconds: PERSON_SECONDS, journeys: [],
};
function writeReport() {
  if (w.listing) return;
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "first-result.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(evidence, "first-result.md"), fr.reportMarkdown(report) + "\n");
}

/**
 * One journey of the clock: its trace, criteria and notes go into the report whatever happens (a failed journey keeps
 * the steps it took). The body gets the trace and a `criterion(id, text, met, seen)` to record a B1 criterion.
 */
function clockJourney(name, mode, about, body) {
  return w.check(name, [], async () => {
    const trace = createTrace(name);
    const criteria = [];
    const notes = [];
    const criterion = (id, text, met, seen) => { criteria.push({ id, text, met, seen }); };
    let error = null, skipped = false;
    try { return await body({ trace, criterion, note: line => notes.push(line) }); } catch (problem) { skipped = problem instanceof Skip; error = problem instanceof Error ? problem.message : String(problem); throw problem; } finally {
      if (!skipped) {
        report.journeys.push({ name, mode, about, ok: error === null, ...(error === null ? {} : { error }), counts: countsOf(trace.entries), marks: { ...trace.marks }, splits: splitsOf(trace.marks), total: totalOf(trace.marks), criteria, notes, trace: trace.entries });
        writeReport();
      }
    }
  }, { mode });
}

// ------------------------------------------------------------------ a newcomer's computer

const installs = [];
/**
 * A newcomer's computer: a throwaway home (short, under /tmp, so the console's socket path fits), a PATH with node,
 * npm and git and only the agent CLIs this journey gives it, the frozen shop repository in the home folder.
 * `agent`: "signed-in", "signed-out" or "none". `where`: "repo" (the shop), "home", or "folder" (not a git repository).
 */
function newcomer(name, { agent = "signed-in", where = "repo" } = {}) {
  const root = realpathSync(makeTempRoot("tr-fr-", { keep: flag("--keep"), parent: "/tmp" }));
  const home = join(root, "home"), bin = join(root, "bin"), tmp = join(root, "tmp"), shop = join(home, "shop"), folder = join(home, "notes"), opened = join(root, "opened.txt");
  for (const one of [home, bin, tmp]) mkdirSync(one, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  for (const tool of ["npm", "npx"]) { const found = join(dirname(process.execPath), tool); if (existsSync(found)) symlinkSync(realpathSync(found), join(bin, tool)); }
  const exe = (file, text) => { writeFileSync(join(bin, file), text); chmodSync(join(bin, file), 0o755); };
  // This checkout's build as `toolroll` (a scripted run; a real run's comes from the package).
  if (install === "local") exe("toolroll", `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(w.bin)} "$@"\n`);
  exe("tailscale", `#!/bin/sh\necho '{"BackendState":"Stopped"}'\n`);
  for (const supervisor of ["launchctl", "systemctl"]) exe(supervisor, `#!/bin/sh\necho "${supervisor} is refused in a first-result journey" >&2\nexit 1\n`);
  exe("open-browser", `#!/bin/sh\nprintf '%s' "$1" > ${shellWord(opened)}\n`);
  // The agent: in a scripted run the world's scripted stand-in; in a real run this computer's Claude Code with its own
  // home (its sign-in lives in the person's keychain), through the world's counting shim.
  const stand = w.provider.shims?.claude ?? null;
  const user = JSON.stringify(process.env.USER ?? "");
  const claudeLine = stand === null ? null : scriptedRun ? `exec ${shellWord(stand)} "$@"` : `HOME=${JSON.stringify(homedir())} USER=${user} LOGNAME=${user} exec ${shellWord(stand)} "$@"`;
  const signIn = () => { if (claudeLine === null) throw new Skip("needs Claude Code installed and signed in on this computer"); exe("claude", `#!/bin/sh\n${claudeLine}\n`); };
  const signOut = () => exe("claude", `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":false}'; exit 1; fi\necho "Not signed in. Run claude auth login." >&2\nexit 1\n`);
  if (agent === "signed-in") signIn();
  else if (agent === "signed-out") signOut();
  // The frozen shop.
  mkdirSync(join(shop, "src"), { recursive: true }); mkdirSync(join(shop, "test"), { recursive: true });
  for (const [file, text] of Object.entries(SHOP_FILES)) writeFileSync(join(shop, file), text);
  const git = (...args) => execFileSync("git", ["-C", shop, ...args], { encoding: "utf8", env: { ...process.env, ...SHOP_COMMIT_ENV } }).trim();
  git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "First version");
  const shopCommit = git("rev-parse", "HEAD");
  report.repo ??= `shop (${Object.keys(SHOP_FILES).length} files, one passing test), commit ${shopCommit.slice(0, 12)}`;
  if (where === "folder") { mkdirSync(folder); writeFileSync(join(folder, "todo.txt"), "Ideas for the shop.\n"); }
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, USER: "sam", LANG: "en_US.UTF-8", TERM: "xterm-256color", TMPDIR: tmp,
    TOOLROLL_BROWSER_COMMAND: join(bin, "open-browser"), TOOLROLL_SECRET_STORE: "files", TOOLROLL_STORAGE_SWEEP: "off",
    // A scripted run asks no plan-limit probe of the stand-in; a real run does what a newcomer's does.
    ...(scriptedRun ? { TOOLROLL_NO_PLAN_PROBE: "1" } : {}),
    GIT_AUTHOR_NAME: "Sam Rivera", GIT_AUTHOR_EMAIL: "sam@example.invalid", GIT_COMMITTER_NAME: "Sam Rivera", GIT_COMMITTER_EMAIL: "sam@example.invalid",
  };
  const inst = { name, root, home, bin, shop, folder, opened, env, signIn, signOut, groups: [], db: null, base: null, cwd: where === "repo" ? shop : where === "home" ? home : folder, pages: [] };
  inst.stop = async () => {
    for (const page of inst.pages.splice(0)) await page.context().close().catch(() => undefined);
    await stopGroups(inst.groups.splice(0)).catch(error => w.say(`${name}: ${error.message}`));
    // A process this home's Toolroll left in a group of its own (an agent, say): found by this run's own folder.
    for (const pid of leftoversUnder(root)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  };
  installs.push(inst);
  return inst;
}
/** The processes still running whose command line names this journey's own temporary folder (unique to it). */
function leftoversUnder(root) {
  let listed = "";
  try { listed = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }); } catch { return []; }
  return listed.split("\n").map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean).filter(match => match[2].includes(root) && Number(match[1]) !== process.pid).map(match => Number(match[1]));
}
/** This home's database, once `up` has made it. */
async function databaseOf(inst) {
  if (inst.db !== null) return inst.db;
  const candidates = [join(inst.home, ".config", "toolroll"), join(inst.home, ".toolroll"), join(inst.home, ".config", "standing-orders")].map(one => join(one, "orders.db"));
  inst.db = await until(`${inst.name}: its database`, async () => candidates.find(one => existsSync(one)) ?? null, { timeoutMs: WAIT.start, everyMs: 250 });
  return inst.db;
}
const dbRows = (inst, query) => {
  if (inst.db === null || !existsSync(inst.db)) return [];
  return JSON.parse(execFileSync("sqlite3", ["-json", "-readonly", "-cmd", ".timeout 15000", inst.db, query], { encoding: "utf8" }).trim() || "[]");
};
const quoted = text => `'${String(text).replace(/'/g, "''")}'`;
const latestTask = inst => dbRows(inst, "SELECT id, title, state FROM task ORDER BY rowid DESC LIMIT 1")[0] ?? null;
const builds = (inst, id) => dbRows(inst, `SELECT r.id, r.outcome, r.reason, r.provider_started_at, r.finished_at FROM run r JOIN task_ref t ON t.id = r.task_ref WHERE t.external_id = ${quoted(id)} AND r.role = 'builder' ORDER BY r.id`);
const scopeOf = (inst, id) => dbRows(inst, `SELECT digest, approved_digest, approved_by, approved_at FROM task_scope WHERE task_id = ${quoted(id)}`)[0] ?? null;
const planState = (inst, id) => dbRows(inst, `SELECT plan FROM task_ref WHERE external_id = ${quoted(id)}`)[0]?.plan ?? null;
const accepted = (inst, id) => dbRows(inst, `SELECT 1 AS hit FROM action_ledger WHERE task_id = ${quoted(id)} AND action = 'assignment handoff checked' LIMIT 1`).length > 0;

/**
 * Watch this home's database and mark the clock as it passes each fact: the task filed, its plan drafted, approved,
 * the build started and ended, Ready, accepted. It also keeps the most builds unfinished at once (a duplicate build).
 */
function observe(inst, trace) {
  const facts = { task: null, maxActive: 0, buildsSeen: 0 };
  const tick = () => {
    try {
      if (facts.task === null) { const task = latestTask(inst); if (task === null) return; facts.task = task.id; trace.mark("filed"); }
      const id = facts.task;
      if (planState(inst, id) === "drafted") trace.mark("terms-shown");
      if (scopeOf(inst, id)?.approved_at) trace.mark("approved");
      const runs = builds(inst, id);
      facts.buildsSeen = runs.length;
      facts.maxActive = Math.max(facts.maxActive, runs.filter(one => one.finished_at === null).length);
      if (runs.some(one => one.provider_started_at)) trace.mark("build-start");
      if (runs.some(one => one.finished_at)) trace.mark("build-end");
      if (latestTask(inst)?.state === "done") trace.mark("ready");
      if (accepted(inst, id)) trace.mark("accepted");
    } catch { /* the database is being made or migrated: next tick */ }
  };
  const timer = setInterval(tick, 250);
  return { facts, tick, stop: () => clearInterval(timer) };
}

// ------------------------------------------------------------------ the terminal

/**
 * A terminal in this home: `command` typed at a real pseudo-terminal of `rows` × `cols` (scripts/fixtures/pty-host.py;
 * macOS's `script` refuses a FIFO on its stdin), started from `cwd`. The shell that starts the host exits at once, so
 * nothing of this run is above it (Toolroll looks for a coding agent among the programs above it). Keys go through a
 * FIFO; the screen is read back from what it drew.
 */
async function openTerminal(inst, label, command, { cwd = inst.cwd, rows = 40, cols = 120 } = {}) {
  const dir = join(inst.root, `terminal-${label}`);
  mkdirSync(dir, { recursive: true });
  const fifo = join(dir, "keys"), log = join(dir, "screen.log"), pidFile = join(dir, "pid"), go = join(dir, "go");
  execFileSync("mkfifo", [fifo]);
  // Read and write, so opening never waits for the other end.
  const keys = openSync(fifo, fsConstants.O_RDWR);
  const inner = `while [ ! -e ${shellWord(go)} ]; do sleep 0.05; done; exec ${command}`;
  const host = [PYTHON, PTY_HOST, String(rows), String(cols), fifo, log, pidFile, "/bin/sh", "-c", inner].map(shellWord).join(" ");
  const shell = spawnOwned(`terminal ${label} (${inst.name})`, "/bin/sh", ["-c", `cd ${shellWord(cwd)} && exec ${host} > ${shellWord(join(dir, "host.log"))} 2>&1 < /dev/null &`], { stdio: "ignore", env: inst.env });
  inst.groups.push(shell.pid);
  await new Promise(done => { if (shell.exitCode !== null) done(); else shell.once("exit", done); });
  await until(`${inst.name}: the terminal to start`, async () => existsSync(pidFile) ? true : null, { timeoutMs: 30_000, everyMs: 50, seen: () => (existsSync(join(dir, "host.log")) ? readFileSync(join(dir, "host.log"), "utf8") : "") });
  const pid = Number(readFileSync(pidFile, "utf8"));
  inst.groups.push(own(pid, `${command} (${inst.name})`));
  const screen = new Screen(rows, cols), decoder = new StringDecoder("utf8");
  let offset = 0, closed = false;
  const term = {
    label, pid, log,
    /** Start the command (the moment a person presses Return on it). */
    go: () => writeFileSync(go, ""),
    pump() {
      if (!existsSync(log)) return;
      const bytes = readFileSync(log);
      if (bytes.length > offset) { screen.write(decoder.write(bytes.subarray(offset))); offset = bytes.length; }
    },
    text() { term.pump(); return screen.text(); },
    /** Every word it has printed (escape sequences out), for a stack trace anywhere in it. */
    printed: () => (existsSync(log) ? plainText(readFileSync(log, "utf8")) : ""),
    alive: () => groupAlive(pid),
    /** One key (or a pasted text). Never a yes to the background question and never "keep running": a journey installs no login item. */
    press(key) {
      if (closed) throw new Error("the terminal is closed");
      const now = term.text();
      if (/Keep Toolroll running in the background/.test(now) && key !== "n") throw new Error("a journey only ever answers n to the background question");
      if (/Quit Toolroll\?/.test(now) && key === "b") throw new Error("a journey never keeps Toolroll running in the background");
      writeSync(keys, key);
    },
    async waitFor(test, what, { timeoutMs = 60_000, everyMs = 150 } = {}) {
      const check = typeof test === "function" ? test : text => test.test(text);
      return until(`${inst.name}: ${what}`, async () => { const text = term.text(); if (check(text)) return text; if (!term.alive()) throw new GiveUp(`the terminal ended: ${text.slice(-600)}`); return null; },
        { timeoutMs, everyMs, seen: () => term.text().slice(-1500) });
    },
    close() { if (!closed) { closed = true; try { closeSync(keys); } catch { /* closed */ } } },
  };
  return term;
}
/** The terminal UI's message line: the line above its key hints. */
const footerOf = text => { const lines = text.split("\n").filter(line => line.trim() !== ""); return lines.length < 2 ? "" : lines[lines.length - 2].trim(); };
/** The screen's lines that match, without the boxes' borders, joined (for what a criterion saw). */
const boxLines = (text, pattern) => text.split("\n").map(line => line.replace(/[│┌┐└┘─╭╮╰╯]/g, " ").replace(/\s+/g, " ").trim()).filter(line => line !== "" && pattern.test(line)).slice(0, 3).join(" | ");
/** Quit the terminal UI and stop the Toolroll it started (never a step: quitting isn't part of the first run). */
async function quit(term) {
  if (!term.alive()) { term.close(); return; }
  try {
    term.press("\u001b"); await sleep(400);
    term.press("q");
    const asked = await until("the quit question", async () => /Quit Toolroll\?/.test(term.text()) || !term.alive(), { timeoutMs: 5_000, everyMs: 100 }).catch(() => false);
    if (asked && term.alive()) term.press("s");
    await until("Toolroll to stop", async () => !term.alive(), { timeoutMs: 60_000, everyMs: 250 }).catch(() => undefined);
  } catch { /* stopped below */ }
  term.close();
}
/** The child of the terminal UI that is its `up` (the console it started). */
function upOf(term) {
  let listed = "";
  try { listed = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }); } catch { return null; }
  const rows = listed.split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean);
  const child = rows.find(one => Number(one[2]) === term.pid && /\bup\b/.test(one[3]) && /--laptop/.test(one[3]));
  return child === undefined ? null : Number(child[1]);
}

/** Start bare `toolroll` (or the plan's command) in this home and wait for its first screen. Marks installed/started. */
async function startToolroll(inst, trace, { command = null, label = "first" } = {}) {
  const plan = launchPlan({ install, pkg, root: inst.root, localBin: w.bin, brewPrefix: inst.brewPrefix ?? null });
  Object.assign(inst.env, plan.env);
  if (plan.path.length > 0) inst.env.PATH = `${plan.path.join(":")}:${inst.env.PATH}`;
  const typed = command ?? plan.start;
  const term = await openTerminal(inst, label, typed);
  trace.interaction(`Type \`${typed}\` and press Return`, { surface: "terminal", keys: typed });
  if (plan.install === null && label === "first") trace.startClock();
  term.go();
  const starting = trace.beginWait("Toolroll starts");
  // Toolroll's own first line (npx may print its own warnings first, while it still downloads).
  await term.waitFor(TOOLROLL_FIRST_LINE, "Toolroll's first line", { timeoutMs: WAIT.start });
  trace.mark("installed");
  const text = await term.waitFor(/Get to your first result|^│ (?:Waiting on you|Working|Done|Other)\s|Toolroll didn't start|can't open/m, "the terminal UI's first screen", { timeoutMs: WAIT.start });
  starting({ screen: text });
  if (/Toolroll didn't start|can't open/.test(text)) throw new Error(`Toolroll didn't start: ${text}`);
  trace.mark("started");
  await databaseOf(inst);
  return term;
}

/** Run a real install command (npm or brew) on the clock, before the terminal starts. */
async function runInstallStep(inst, trace) {
  const plan = launchPlan({ install, pkg, root: inst.root, localBin: w.bin });
  if (plan.install === null) return;
  const { command, args, env, realHome } = plan.install;
  if (install === "brew") inst.brewPrefix = execFileSync("brew", ["--prefix"], { encoding: "utf8" }).trim();
  trace.decision("Choose an install command from the README (curl, npm or brew)", { surface: "shell", note: `this run: ${command} ${args.join(" ")}` });
  trace.startClock();
  trace.interaction(`Type \`${command} ${args.join(" ")}\` and press Return`, { surface: "shell", keys: `${command} ${args.join(" ")}` });
  const waiting = trace.beginWait(`${command} installs Toolroll`, { surface: "shell" });
  const runEnv = realHome ? { ...process.env, ...env } : { ...inst.env, ...env };
  const output = await new Promise((done, fail) => execFile(command, args, { env: runEnv, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? fail(new Error(`${command} ${args.join(" ")}: ${(stdout + stderr).slice(-1500)}`)) : done(stdout + stderr)));
  waiting({ screen: output.trim().split("\n").slice(-12).join("\n") });
  trace.mark("installed");
}

/** The package that actually ran, after it started: its version and, where npm recorded it, its integrity. */
function packageFacts(inst) {
  const found = { version: null, integrity: null };
  try {
    if (install === "npx") {
      const npx = join(inst.root, "npm-cache", "_npx");
      for (const one of readdirSync(npx)) {
        const lock = join(npx, one, "node_modules", ".package-lock.json");
        const meta = join(npx, one, "node_modules", "toolroll", "package.json");
        if (existsSync(meta)) found.version = JSON.parse(readFileSync(meta, "utf8")).version;
        if (existsSync(lock)) found.integrity = JSON.parse(readFileSync(lock, "utf8")).packages?.["node_modules/toolroll"]?.integrity ?? null;
      }
    } else if (install === "npm") {
      found.version = JSON.parse(readFileSync(join(inst.root, "npm-prefix", "lib", "node_modules", "toolroll", "package.json"), "utf8")).version;
    } else if (install === "brew") {
      found.version = execFileSync(join(inst.brewPrefix, "bin", "toolroll"), ["--version"], { encoding: "utf8", env: inst.env }).trim();
    }
  } catch { /* unread: the report says so */ }
  return found;
}

// ------------------------------------------------------------------ the steps of a first run

const pageText = async on => (await on.locator("body").innerText().catch(() => "")).replace(/\n{2,}/g, "\n").trim();
/** A page's refusal in its own words (the lines after "Request refused"), else its first words. */
const refusalIn = text => { const lines = text.split("\n").map(line => line.trim()).filter(Boolean); const at = lines.findIndex(line => /refused/i.test(line)); return (at === -1 ? lines.slice(0, 3) : lines.slice(at, at + 2)).join(" · ").slice(0, 300); };
/** A browser page for this home, its errors kept for the run's browser check. */
async function browserFor(inst) {
  const context = await w.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const on = await context.newPage();
  on.on("pageerror", error => { if (!SKIPPED_FADE.test(String(error))) w.problems.push(`${inst.name} on ${on.url()}: ${String(error)}`); });
  inst.pages.push(on);
  return on;
}
/** The one-time sign-in address the terminal's `w` (or `toolroll --web`) handed the browser. */
async function openedLink(inst, after = 0) {
  const link = await until(`${inst.name}: the browser to be opened`, async () => { if (!existsSync(inst.opened)) return null; const text = readFileSync(inst.opened, "utf8"); return text.startsWith("http") ? text : null; }, { timeoutMs: 60_000, everyMs: 200 });
  inst.base = new URL(link).origin;
  return link;
}
/** Press `w` in the terminal and open what it hands the browser. */
async function toBrowser(inst, term, trace, why) {
  rmSync(inst.opened, { force: true });
  term.press("w");
  trace.interaction(`Press w (open in the browser) to ${why}`, { keys: "w" });
  const link = await openedLink(inst);
  const on = await browserFor(inst);
  await on.goto(link);
  return on;
}

/** Write the first task in the terminal and approve it: the fast road (its exact terms, Enter is Build) or the plan road. */
async function firstTaskInTerminal(inst, term, trace, text, { pickedIdea = false } = {}) {
  if (!pickedIdea) trace.decision("Decide what the first task is", { screen: term.text(), note: "the ideas on the screen are plain text; the person writes their own words" });
  term.press("n");
  trace.interaction("Press n (new task)", { keys: "n" });
  await term.waitFor(/New task/, "the New task box");
  await sleep(100);
  term.press(text);
  trace.interaction("Type the task", { keys: `${text.length} characters`, note: "typed at once here; the person's typing is in the allowance" });
  await term.waitFor(screen => screen.replace(/\s+/g, " ").includes(text.slice(-20)), "the words in the box");
  term.press("\r");
  trace.interaction("Press Enter to send", { keys: "Enter" });
  trace.mark("task-sent");
  const reading = trace.beginWait("Toolroll reads the task (sizing)");
  const after = await term.waitFor(screen => /Build approves exactly this:/.test(screen) || /Keep Toolroll running in the background/.test(screen) || /Filed\./.test(screen) || (!/Reading it/.test(screen) && !/New task/.test(screen) && /\S/.test(screen) && /refused|can't|couldn't|isn't|needs/i.test(screen.split("\n").slice(-3).join(" "))),
    "the task's terms, or the task filed", { timeoutMs: WAIT.sizing });
  reading({ screen: after });
  if (/Build approves exactly this:/.test(after)) {
    trace.mark("terms-shown");
    trace.decision("Approve exactly these terms (Enter, Build) or plan it first (p)", { screen: after, note: "reading the terms is in the allowance" });
    term.press("\r");
    trace.interaction("Press Enter (Build)", { keys: "Enter" });
    await term.waitFor(screen => !/Build approves exactly this:/.test(screen), "Build to be taken");
    return { road: "fast", blocked: null };
  }
  if (!/Keep Toolroll running in the background|Filed\./.test(after)) throw new Error(`the task wasn't filed: ${after.split("\n").slice(-4).join(" | ")}`);
  // The plan road: the background question comes after filing.
  if (/Keep Toolroll running in the background/.test(after)) {
    trace.decision("Keep Toolroll running in the background? (asked after filing)", { screen: after });
    term.press("n");
    trace.interaction("Press n (not now)", { keys: "n" });
  }
  await until("the task to be filed", async () => latestTask(inst), { timeoutMs: 30_000, everyMs: 250 });
  const id = latestTask(inst).id;
  // Filed with `task add`, the terminal asks for its plan at once (local-owner slice 2: "Filed. Planning: …"), with no
  // password. Should it not, `p` asks; only if that fails too does the person go to the browser.
  let stuck = await until("the planner to start, or the task to wait for a plan", async () => {
    if (planState(inst, id) !== null) return "planning";
    return /Say what the task should do so it can be planned|Needs a plan/.test(term.text()) ? "needs-scope" : null;
  }, { timeoutMs: 20_000, everyMs: 250 }).catch(() => "unknown");
  if (stuck !== "planning") {
    trace.decision("Ask for the plan (p)", { screen: term.text() });
    term.press("p");
    trace.interaction("Press p (plan it)", { keys: "p" });
    stuck = await until("the plan to be asked for", async () => planState(inst, id) !== null ? "planning" : null, { timeoutMs: 10_000, everyMs: 250 }).catch(() => stuck);
  }
  if (stuck === "needs-scope") {
    const said = term.text();
    trace.notPossible("Get a plan in the terminal: neither filing nor p asked the planner",
      "press w and ask the planner on the task's page in the browser", { screen: said });
    const on = await toBrowser(inst, term, trace, "ask the planner for a plan");
    await on.goto(`${inst.base}/t/${encodeURIComponent(id)}`);
    const ask = on.locator('form[action$="/plan"] button').first();
    if (!(await ask.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false))) throw new Error(`the task's page has no way to ask for a plan: ${refusalIn(await pageText(on))}`);
    trace.decision("Ask the planner to draft the plan", { surface: "browser", screen: await pageText(on) });
    await Promise.all([on.waitForNavigation({ timeout: 30_000 }).catch(() => undefined), ask.click()]);
    trace.interaction("Click the plan button", { surface: "browser" });
    const asked = await until(`${id}'s plan to be asked for`, async () => planState(inst, id) !== null ? "asked" : /refused/i.test(await pageText(on)) ? "refused" : null, { timeoutMs: 30_000, everyMs: 250, seen: async () => refusalIn(await pageText(on)) });
    if (asked === "refused") {
      const refusal = refusalIn(await pageText(on));
      trace.notPossible(`Ask the planner in the browser: “${refusal}”`, "set a password first (`toolroll password set`), then ask for the plan again", { surface: "browser", screen: await pageText(on) });
      trace.endFallback();
      return { road: "plan", blocked: refusal };
    }
    trace.interaction("Go back to the terminal");
    trace.endFallback();
  }
  const planning = trace.beginWait("The planner writes the plan");
  await until(`${id}'s plan`, async () => planState(inst, id) === "drafted" && scopeOf(inst, id) !== null, { timeoutMs: WAIT.plan, everyMs: 500, seen: () => JSON.stringify({ plan: planState(inst, id), task: latestTask(inst) }) });
  const shown = await term.waitFor(/Waiting on you/, "the plan waiting on you", { timeoutMs: 30_000 });
  planning({ screen: shown });
  trace.mark("terms-shown");
  term.press("a");
  trace.interaction("Press a (approve: shows the whole plan first)", { keys: "a" });
  const plan = await term.waitFor(/Approve this plan\?/, "the plan in full");
  trace.decision("Approve the plan as shown", { screen: plan, note: "reading the plan is in the allowance" });
  term.press("y");
  trace.interaction("Press y (approve)", { keys: "y" });
  await until(`${id} to be approved`, async () => scopeOf(inst, id)?.approved_at != null, { timeoutMs: 30_000, everyMs: 250, seen: () => term.text().slice(-600) });
  return { road: "plan", blocked: null };
}

/** Wait for the build to end and the result to read Ready (or the build to fail: returns the failed run). */
async function buildToReady(inst, term, trace, id, { surface = "terminal", screen = () => term.text() } = {}) {
  const building = trace.beginWait("The build runs", { surface });
  const ended = await until(`${id}'s build to end`, async () => builds(inst, id).find(one => one.finished_at) ?? null, { timeoutMs: WAIT.build, everyMs: 500, seen: () => JSON.stringify(builds(inst, id)) });
  building({ screen: await screen(), note: `build ${ended.outcome}${ended.reason ? ` (${ended.reason})` : ""}` });
  if (ended.outcome !== "built") return ended;
  const checking = trace.beginWait("Checks, until the result reads Ready", { surface });
  await until(`${id} to be Ready`, async () => latestTask(inst)?.state === "done", { timeoutMs: WAIT.ready, everyMs: 500, seen: () => JSON.stringify(latestTask(inst)) });
  checking({ screen: await screen() });
  trace.mark("ready");
  return null;
}

/** Review the result and accept it in the browser: Looks right on each requirement, a reason when one is owed, Accept. */
async function acceptInBrowser(inst, on, trace, id) {
  await on.goto(`${inst.base}/t/${encodeURIComponent(id)}`);
  const accept = on.locator(`[data-result-decision] form[action="/t/${id}/complete"] button[data-accept-result]`);
  await waitFor(accept, "Accept on the result", { timeoutMs: 30_000, seen: () => pageText(on) });
  trace.decision("Review the result (the change, its checks, its requirements)", { surface: "browser", screen: await pageText(on), note: "reading is in the allowance" });
  for (const looks of await on.locator("[data-check-item] button[data-looks-right]").all()) {
    trace.decision("Does this requirement look right?", { surface: "browser" });
    await looks.click();
    trace.interaction("Click Looks right", { surface: "browser" });
  }
  const reason = on.locator('[data-result-decision] form[action$="/complete"] input[name="note"]');
  if (await reason.count() > 0) {
    trace.decision("Say why it can be accepted (a reason is owed)", { surface: "browser" });
    await reason.fill("I read the change and its test passes.");
    trace.interaction("Type the reason", { surface: "browser" });
  }
  await Promise.all([on.waitForNavigation({ timeout: 30_000 }).catch(() => undefined), accept.click()]);
  trace.interaction("Click Accept", { surface: "browser" });
  await until(`${id} to be accepted`, async () => accepted(inst, id), { timeoutMs: 30_000, everyMs: 250, seen: () => pageText(on) });
  trace.mark("accepted");
}

/** Review the result and accept it in the terminal; where the terminal can't (a check or a reason it has no field for),
 * the trace says so and the person does it in the browser. */
async function acceptInTerminal(inst, term, trace, id) {
  trace.decision("Review the result", { screen: term.text(), note: "reading is in the allowance" });
  term.press("\r");
  trace.interaction("Press Enter (open the task to read the result)", { keys: "Enter" });
  const opened = await term.waitFor(screen => /a approve\/accept · b send back/.test(screen) && /Esc back/.test(screen), "the task screen");
  trace.note("The task screen, with the result's lines", { screen: opened });
  const footerBefore = footerOf(term.text());
  term.press("c");
  trace.interaction("Press c (accept)", { keys: "c" });
  // Accept this result? (local-owner slice 1): the result read once and pinned, then the one question it owes.
  const review = await term.waitFor(screen => /Accept this result\?/.test(screen) || footerOf(screen) !== footerBefore, "the Accept screen", { timeoutMs: 20_000 }).catch(() => term.text());
  if (/Accept this result\?/.test(review)) {
    trace.note("Accept this result?", { screen: review });
    if (/Did you check it yourself\?/.test(review)) {
      trace.decision("Did you check it yourself? (the result owes the person's own check)", { screen: review });
      term.press("y");
      trace.interaction("Press y (yes, it looks right)", { keys: "y" });
    } else if (/Say why you accept it anyway/.test(review)) {
      trace.decision("Say why it can be accepted (a reason is owed)", { screen: review });
      const why = "I read the change and its test passes.";
      term.press(why);
      trace.interaction("Type the reason", { keys: `${why.length} characters` });
      term.press("\r");
      trace.interaction("Press Enter (accept)", { keys: "Enter" });
    } else if (/\(y\/n\)/.test(review)) {
      term.press("y");
      trace.interaction("Press y (accept)", { keys: "y" });
    }
  }
  // Its answer is the line above the key hints: "Accepted. The task is done.", or the refusal's own words.
  const answer = await until("the accept's answer", async () => {
    if (accepted(inst, id)) return "accepted";
    const footer = footerOf(term.text());
    return footer !== footerBefore && footer !== "Working…" && footer !== "" ? footer : null;
  }, { timeoutMs: 20_000, everyMs: 200, seen: () => term.text().slice(-600) }).catch(() => null);
  if (accepted(inst, id) || answer === "accepted" || /^Accepted\./.test(answer ?? "")) {
    await until(`${id} to be accepted`, async () => accepted(inst, id), { timeoutMs: 10_000, everyMs: 250 });
    trace.mark("accepted");
    trace.note("Accepted in the terminal", { screen: term.text() });
    return { inTerminal: true, said: "Accepted." };
  }
  const said = term.text();
  trace.notPossible(`Accept in the terminal: c answered “${answer ?? "nothing"}”${/check this requirement yourself/i.test(said) ? "; the result owes a person's check, which the terminal has no question for" : ""}`,
    "press w to open the result in the browser, tick Looks right on each requirement, give a reason if one is owed, and Accept", { screen: said });
  const on = await toBrowser(inst, term, trace, "accept the result there");
  await acceptInBrowser(inst, on, trace, id);
  trace.endFallback();
  return { inTerminal: false, said: answer ?? "nothing" };
}

/** The B1 criteria every timed journey records. */
function timedCriteria(trace, criterion, { budget = 300 } = {}) {
  const total = totalOf(trace.marks);
  criterion("B1.3", `measured time plus the ${PERSON_SECONDS} s allowance ≤ ${budget} s (one run; the gate is the median of three)`, real ? total.totalSeconds !== null && total.totalSeconds <= budget : null,
    real ? `${total.totalSeconds ?? "not accepted"} s` : `scripted: ${total.machineSeconds ?? "—"} s of machine time, not a newcomer's time`);
}
/** One plain sentence and one next step, never a stack trace (B1.6). */
function failureCriteria(criterion, term, shown, { sentence, step }) {
  criterion("B1.6", "never a stack trace", !looksLikeStackTrace(term.printed()), looksLikeStackTrace(term.printed()) ? term.printed().split("\n").filter(line => looksLikeStackTrace(line)).slice(0, 3).join(" | ") : "none in anything it printed");
  criterion("B1.6", "says what is wrong in plain words", sentence.test(shown), boxLines(shown, sentence) || "no such line");
  criterion("B1.6", "gives the next step", step.test(shown), boxLines(shown, step) || "no next step shown");
}

// ------------------------------------------------------------------ the timed journeys

const builderAnswer = (when, files, conclusion, extra = {}) => ({ role: "builder", when: [when], answer: { files, conclusion, ...extra } });

async function terminalInRepo({ trace, criterion, note }, { planRoad = false } = {}) {
  const inst = newcomer(planRoad ? "terminal-plan" : "terminal-repo", { agent: "signed-in", where: "repo" });
  const watch = observe(inst, trace);
  let term = null;
  try {
    // The plan road, scripted: the sizing calls the task bigger than a small change, so it is filed and planned first.
    if (planRoad) w.script({ role: "sizing", when: [/explain it in the README/], answer: { size: "medium", risky: false, reason: "Code and the README." } });
    const task = planRoad ? PLAN_TASK : TASK;
    w.script(builderAnswer(wordsOf(task), mathFiles(), "Added subtract(a, b) next to add, with a test."));
    if (install === "local") trace.decision("Choose an install command from the README (curl, npm or brew)", { surface: "shell", note: "scripted: this checkout's build, nothing is installed or downloaded" });
    await runInstallStep(inst, trace);
    if (install === "npx") trace.decision("Choose an install command (npx is the one the plan leads with)", { surface: "shell", note: `this run: npx -y ${pkg}` });
    term = await startToolroll(inst, trace);
    trace.note("The first screen", { screen: term.text() });
    const { road, blocked } = await firstTaskInTerminal(inst, term, trace, task);
    note(`the task took the ${road === "fast" ? "fast road (its exact terms, Enter is Build)" : "plan road (a plan to approve first)"}`);
    if (blocked !== null) {
      criterion("B1.2", "a first task on the plan road reaches a plan without a password", false, blocked);
      note(`stopped: no plan without a password (${blocked})`);
      return { road, blocked };
    }
    if (road === "plan") criterion("B1.2", "a first task on the plan road reaches a plan without a password", true, "planned and approved in the terminal");
    watch.tick();
    const id = watch.facts.task ?? latestTask(inst)?.id;
    if (!id) throw new Error("no task was filed");
    const failed = await buildToReady(inst, term, trace, id);
    if (failed !== null) throw new Error(`the build ended ${failed.outcome}: ${failed.reason}`);
    const how = await acceptInTerminal(inst, term, trace, id);
    criterion("B1.2", "the accept is recorded in the terminal", how.inTerminal, how.inTerminal ? "Accepted" : `not in the terminal: ${how.said}`);
    timedCriteria(trace, criterion);
    if (real) Object.assign(report.package, packageFacts(inst));
    return { task: id, road, ...totalOf(trace.marks) };
  } finally {
    watch.stop();
    if (term !== null) await quit(term);
    await inst.stop();
  }
}

async function terminalFromHome({ trace, criterion, note }) {
  const inst = newcomer("terminal-home", { agent: "signed-in", where: "home" });
  const watch = observe(inst, trace);
  let term = null;
  try {
    w.script(builderAnswer(/whole cents/, roundedPriceFiles(), "priceWithDiscount now rounds to whole cents, with a test."));
    await runInstallStep(inst, trace);
    term = await startToolroll(inst, trace);
    const first = await term.waitFor(/Project/, "the project step");
    trace.note("The first screen: no project", { screen: first });
    criterion("B1.4", "the terminal offers the sample project", /sample/i.test(first), boxLines(first, /Project ·|repos add|open --web|sample/i));
    trace.notPossible("Try the sample project in the terminal: its project step names `toolroll repos add <folder>` or the browser",
      "press w and choose Try a sample project in the browser's welcome");
    const on = await toBrowser(inst, term, trace, "add the sample project");
    if (new URL(on.url()).pathname !== "/welcome") { await on.goto(`${inst.base}/welcome`); trace.interaction("Open the welcome", { surface: "browser" }); }
    const sample = on.locator('form[action="/welcome/sample"] button');
    await waitFor(sample, "Try a sample project", { timeoutMs: 30_000, seen: () => pageText(on) });
    trace.decision("Try the sample project", { surface: "browser", screen: await pageText(on) });
    await Promise.all([on.waitForNavigation({ timeout: 30_000 }).catch(() => undefined), sample.click()]);
    trace.interaction("Click Try a sample project", { surface: "browser" });
    const adding = trace.beginWait("The sample project is added and takes work", { surface: "browser" });
    await until("the project step done", async () => { if (await on.locator('[data-step="project"][data-done="1"]').count() > 0) return true; await on.reload(); return false; }, { timeoutMs: 90_000, everyMs: 1000, seen: () => pageText(on) });
    adding({ screen: await pageText(on) });
    trace.interaction("Go back to the terminal", { surface: "terminal" });
    trace.endFallback();
    const noticing = trace.beginWait("The terminal notices the project");
    const ideas = await term.waitFor(/Idea: .*cents/, "the sample's ideas in the terminal", { timeoutMs: 90_000 });
    noticing({ screen: ideas });
    const idea = /Idea: (.*cents[^│]*)/.exec(ideas)?.[1]?.trim();
    if (!idea) throw new Error(`no whole-cents idea: ${ideas}`);
    trace.notPossible("Pick one of the ideas: they are plain text", "type the idea's words into New task");
    trace.decision("Choose an idea to try", { screen: ideas });
    const { road, blocked } = await firstTaskInTerminal(inst, term, trace, idea, { pickedIdea: true });
    trace.endFallback();
    if (blocked !== null) { criterion("B1.2", "a first task on the plan road reaches a plan without a password", false, blocked); return { road, blocked }; }
    note(`the task took the ${road} road`);
    watch.tick();
    const id = watch.facts.task ?? latestTask(inst)?.id;
    const failed = await buildToReady(inst, term, trace, id);
    if (failed !== null) throw new Error(`the build ended ${failed.outcome}: ${failed.reason}`);
    await acceptInTerminal(inst, term, trace, id);
    timedCriteria(trace, criterion);
    return { task: id, road, ...totalOf(trace.marks) };
  } finally {
    watch.stop();
    if (term !== null) await quit(term);
    await inst.stop();
  }
}

async function browserInRepo({ trace, criterion, note }) {
  const inst = newcomer("browser-repo", { agent: "signed-in", where: "repo" });
  const watch = observe(inst, trace);
  let term = null;
  try {
    w.script(builderAnswer(wordsOf(TASK), mathFiles(), "Added subtract(a, b) next to add, with a test."));
    await runInstallStep(inst, trace);
    const plan = launchPlan({ install, pkg, root: inst.root, localBin: w.bin, brewPrefix: inst.brewPrefix ?? null });
    Object.assign(inst.env, plan.env);
    if (plan.path.length > 0) inst.env.PATH = `${plan.path.join(":")}:${inst.env.PATH}`;
    const typed = `${plan.start} --web`;
    term = await openTerminal(inst, "web", typed);
    trace.interaction(`Type \`${typed}\` and press Return`, { surface: "terminal", keys: typed });
    if (plan.install === null) trace.startClock();
    term.go();
    const starting = trace.beginWait("Toolroll starts and opens the browser");
    // Toolroll's own first line, or (it may print none) the browser it opens.
    const firstLine = setInterval(() => { if (TOOLROLL_FIRST_LINE.test(term.text())) trace.mark("installed"); }, 150);
    const link = await openedLink(inst).finally(() => clearInterval(firstLine));
    trace.mark("installed");
    const on = await browserFor(inst);
    await on.goto(link);
    await databaseOf(inst);
    starting({ surface: "browser", screen: await pageText(on) });
    trace.mark("started");
    trace.decision("Decide what the first task is", { surface: "browser", screen: await pageText(on) });
    await on.goto(`${inst.base}/tasks/new`);
    trace.interaction("Open New task", { surface: "browser" });
    const words = on.locator('form[action="/tasks/add"] textarea[name="title"]');
    await waitFor(words, "New task", { timeoutMs: 30_000, seen: () => pageText(on) });
    await words.fill(TASK);
    trace.interaction("Type the task", { surface: "browser", keys: `${TASK.length} characters` });
    await Promise.all([on.waitForNavigation({ timeout: WAIT.sizing }), on.click('form[action="/tasks/add"] button.k-send')]);
    trace.interaction("Click Send", { surface: "browser" });
    trace.mark("task-sent");
    const buildForm = on.locator("form#fast-build");
    if (await buildForm.count() > 0) {
      trace.mark("terms-shown");
      trace.decision("Approve exactly these terms (Build) or plan it first", { surface: "browser", screen: await pageText(on) });
      await Promise.all([on.waitForNavigation({ timeout: 30_000 }), buildForm.locator("button").first().click()]);
      trace.interaction("Click Build", { surface: "browser" });
      note("the task took the fast road");
    } else {
      note("the task took the plan road");
      const id = await until("the task to be filed", async () => latestTask(inst)?.id ?? null, { timeoutMs: 30_000, everyMs: 250 });
      const planning = trace.beginWait("The planner writes the plan", { surface: "browser" });
      await until(`${id}'s plan`, async () => planState(inst, id) === "drafted", { timeoutMs: WAIT.plan, everyMs: 500 });
      await on.goto(`${inst.base}/t/${encodeURIComponent(id)}`);
      const form = on.locator("form[data-task-approval]");
      await waitFor(form, "the plan's approval", { timeoutMs: 30_000, seen: () => pageText(on) });
      planning({ screen: await pageText(on) });
      trace.decision("Approve the plan as shown", { surface: "browser", screen: (await form.innerText()).trim() });
      await form.locator(".k-slots button.k-btn-primary:visible, button.k-btn-primary:visible").first().click();
      trace.interaction("Click Approve", { surface: "browser" });
    }
    watch.tick();
    const id = await until("the task", async () => latestTask(inst)?.id ?? null, { timeoutMs: 30_000, everyMs: 250 });
    await until(`${id} to be approved`, async () => scopeOf(inst, id)?.approved_at != null, { timeoutMs: 30_000, everyMs: 250, seen: () => pageText(on) });
    const failed = await buildToReady(inst, term, trace, id, { surface: "browser", screen: async () => { await on.reload().catch(() => undefined); return pageText(on); } });
    if (failed !== null) throw new Error(`the build ended ${failed.outcome}: ${failed.reason}`);
    await acceptInBrowser(inst, on, trace, id);
    timedCriteria(trace, criterion);
    return { task: id, ...totalOf(trace.marks) };
  } finally {
    watch.stop();
    if (term !== null) { term.close(); }
    await inst.stop();
  }
}

// ------------------------------------------------------------------ the failure paths (scripted)

/** An agent missing or signed out: what the screen says, then how long until signing in is noticed. */
async function agentMissing({ trace, criterion, note }, agent) {
  const inst = newcomer(`agent-${agent}`, { agent, where: "repo" });
  let term = null;
  try {
    term = await startToolroll(inst, trace);
    const shown = await term.waitFor(/Agent · /, "the agent step");
    // The sign-in checks take a moment: the screen settles on the agent's state.
    const settled = await term.waitFor(agent === "none" ? /not installed/ : /not signed in|signed out/, `the agent step to say ${agent === "none" ? "not installed" : "not signed in"}`, { timeoutMs: 60_000 }).catch(() => term.text());
    trace.note(`What the screen says with ${agent === "none" ? "no agent installed" : "Claude Code signed out"}`, { screen: settled });
    failureCriteria(criterion, term, settled, { sentence: agent === "none" ? /not installed/ : /not signed in|signed out/, step: /run:|claude auth login|npm i(?:nstall)? -g/ });
    void shown;
    // The person signs in in another window; nobody touches this screen.
    inst.signIn();
    const signedAt = Date.now();
    trace.interaction(agent === "none" ? "In another window: install Claude Code and sign in" : "In another window: claude auth login", { surface: "shell" });
    const noticing = trace.beginWait("The terminal notices the sign-in");
    const done = await term.waitFor(/Agent · Done|Claude Code: signed in/, "the agent step to turn Done by itself", { timeoutMs: 120_000 });
    const seconds = Math.round((Date.now() - signedAt) / 100) / 10;
    noticing({ screen: done });
    criterion("B1.6", "signing in elsewhere is noticed within 10 s", seconds <= 10, `${seconds} s`);
    note(`signing in was noticed after ${seconds} s`);
    return { noticedAfter: seconds };
  } finally {
    if (term !== null) await quit(term);
    await inst.stop();
  }
}

async function notARepository({ trace, criterion, note }) {
  const inst = newcomer("folder", { agent: "signed-in", where: "folder" });
  let term = null;
  try {
    term = await startToolroll(inst, trace);
    const shown = await term.waitFor(/Project · /, "the project step");
    trace.note("What the screen says started in a folder that isn't a git repository", { screen: shown });
    failureCriteria(criterion, term, shown, { sentence: /git repository|no project|Add a/i, step: /repos add|open --web|sample/ });
    criterion("B1.6", "offers the sample project", /sample/i.test(shown), boxLines(shown, /Project ·|repos add|sample/i));
    const projects = readdirSync(inst.home).filter(one => one === "Projects");
    note(`up --laptop made ${projects.length > 0 ? "~/Projects" : "no projects folder"}; the folder it was started in was not added`);
    return {};
  } finally {
    if (term !== null) await quit(term);
    await inst.stop();
  }
}

/** Use up a scripted rule's answers (a rule with `times`): the stand-in claims each answer as a file, so the rules after it answer from now on. */
function useUp(ids, times) {
  for (const id of ids) for (let n = 0; n < times; n += 1) { try { writeFileSync(join(w.provider.dir, "used", `${id}-${n}`), "", { flag: "wx" }); } catch { /* claimed */ } }
}
/** Wait up to `ms` for a build after `afterId` to start by itself; null when none did. */
const startedBy = (inst, id, afterId, ms) => until("a build to start by itself", async () => builds(inst, id).find(one => one.id > afterId && one.provider_started_at) ?? null, { timeoutMs: ms, everyMs: 250 }).catch(() => null);

/**
 * Retry a stopped or failed build as the person would: r in the terminal; where the terminal can't (it asks for a
 * password the local owner doesn't have), the trace says so and the person presses Retry on the task's page in the
 * browser. Returns the build that started again, or null (with the reason in the trace).
 */
async function retryByHand(inst, term, trace, criterion, id, afterId, rule = "B1.6") {
  trace.decision("Retry", { screen: term.text() });
  const before = footerOf(term.text());
  term.press("r");
  trace.interaction("Press r (retry)", { keys: "r" });
  const said = await until("r's answer", async () => {
    const text = term.text();
    if (/This needs your password/.test(text)) return boxLines(text, /password/i);
    if (builds(inst, id).some(one => one.id > afterId)) return "a build started";
    const footer = footerOf(text);
    return footer !== before && footer !== "Working…" ? footer : null;
  }, { timeoutMs: 15_000, everyMs: 200 }).catch(() => "nothing within 15 s");
  const inTerminal = await startedBy(inst, id, afterId, 5_000);
  criterion(rule, "Retry works in the terminal", inTerminal !== null, inTerminal !== null ? `build #${inTerminal.id} started` : `r answered: ${said}`);
  if (inTerminal !== null) return inTerminal;
  trace.notPossible(`Retry in the terminal: r answered “${said}”`, "press Esc, then w, and press Retry on the task's page in the browser", { screen: term.text() });
  term.press("\u001b");
  trace.interaction("Press Esc", { keys: "Esc" });
  // A key right after Esc would read as Alt and that key.
  await sleep(400);
  const on = await toBrowser(inst, term, trace, "retry the build there");
  await on.goto(`${inst.base}/t/${encodeURIComponent(id)}`);
  const retry = on.locator('form[action$="/requeue"] button').first();
  const found = await retry.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
  if (!found) { trace.note("The task's page has no Retry", { surface: "browser", screen: await pageText(on) }); trace.endFallback(); criterion(rule, "Retry in the browser", false, "no Retry on the task's page"); return null; }
  trace.decision("Retry", { surface: "browser", screen: await pageText(on) });
  await retry.click();
  trace.interaction("Click Retry", { surface: "browser" });
  const asked = await on.locator('.k-pop[role="dialog"] input[type="password"], [role="dialog"] input[type="password"]').first().waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false);
  const started = asked ? null : await startedBy(inst, id, afterId, 60_000);
  criterion(rule, "Retry in the browser starts the build again", started !== null, asked ? "the browser asks for a password too" : started === null ? `no build: ${refusalIn(await pageText(on))}` : `build #${started.id} started`);
  trace.endFallback();
  return started;
}

async function modelError({ trace, criterion, note }) {
  const inst = newcomer("model-error", { agent: "signed-in", where: "repo" });
  const watch = observe(inst, trace);
  let term = null;
  try {
    // Every build turn fails the way the CLI does (529 Overloaded), until the journey uses the failures up; the build
    // after that answers. (A failed turn is tried again inside the same build, so one failure alone is never seen.)
    const FAILS = 40;
    const [failing] = w.script({ role: "builder", when: [/multiply/], times: FAILS, answer: { fail: "API Error: 529 Overloaded" } });
    w.script(builderAnswer(/multiply/, mathWith("multiply", "(a, b) => a * b", "assert.equal(multiply(3, 4), 12)"), "Added multiply(a, b) next to add, with a test."));
    term = await startToolroll(inst, trace);
    await firstTaskInTerminal(inst, term, trace, ERROR_TASK);
    watch.tick();
    const id = watch.facts.task ?? latestTask(inst).id;
    const failed = await buildToReady(inst, term, trace, id);
    if (failed === null) throw new Error("the build reached Ready although every model turn failed");
    if (failing !== undefined) useUp([failing], FAILS);
    note(`the failed build: #${failed.id} ${failed.outcome} (${failed.reason})`);
    const shown = await term.waitFor(/(?:Waiting|Failed|Needs you) · /, "what the list says after the model error", { timeoutMs: 30_000 });
    trace.note("The list after the model error", { screen: shown });
    term.press("\r");
    trace.interaction("Press Enter (open the task)", { keys: "Enter" });
    const opened = await term.waitFor(/Esc back/, "the task screen");
    trace.note("The task after the model error", { screen: opened });
    failureCriteria(criterion, term, opened, { sentence: /fail|stopped|error|Overloaded|couldn't|didn't/i, step: /retr(?:y|ies)/i });
    criterion("B1.6", "names what failed (the model's error)", /529|Overloaded|API Error/i.test(opened), boxLines(opened, /529|Overloaded|error|fail|retr/i) || "the model's error isn't named");
    term.press("\u001b");
    trace.interaction("Press Esc (back to the list)", { keys: "Esc" });
    await sleep(400);
    // Toolroll may try it again by itself (a model error is retried after a short wait).
    const waitingAgain = trace.beginWait("Toolroll tries the build again by itself");
    const itself = await startedBy(inst, id, failed.id, 90_000);
    waitingAgain({ screen: term.text(), note: itself === null ? "it didn't within 90 s" : `build #${itself.id}` });
    const again = itself ?? await retryByHand(inst, term, trace, criterion, id, failed.id);
    criterion("B1.6", "the build runs again after the model error", again !== null, again === null ? "it didn't" : `build #${again.id} ${itself !== null ? "started by itself" : "after Retry"}`);
    if (again === null) return { retried: false };
    const waiting = trace.beginWait("The retried build, until Ready");
    await until(`${id} to be Ready after the retry`, async () => latestTask(inst)?.state === "done", { timeoutMs: WAIT.build, everyMs: 500, seen: () => JSON.stringify(builds(inst, id)) });
    waiting({ screen: term.text() });
    criterion("B1.6", "after Retry the result reaches Ready", true, `${builds(inst, id).length} builds: ${builds(inst, id).map(one => `#${one.id} ${one.outcome ?? "running"}`).join(", ")}`);
    return { retried: true, failed: failed.reason };
  } finally {
    watch.stop();
    if (term !== null) await quit(term);
    await inst.stop();
  }
}

async function restartRecovery({ trace, criterion, note }) {
  const inst = newcomer("restart", { agent: "signed-in", where: "repo" });
  const watch = observe(inst, trace);
  let term = null, again = null;
  try {
    // A slow first build (killed partway), then one that answers at once.
    const negate = mathWith("negate", "a => -a", "assert.equal(negate(2), -2)");
    w.script({ role: "builder", when: [/negate/], times: 1, answer: { delayMs: 20_000, files: negate, conclusion: "Added negate (the slow, killed attempt)." } },
      builderAnswer(/negate/, negate, "Added negate(a) next to add, with a test."));
    term = await startToolroll(inst, trace);
    await firstTaskInTerminal(inst, term, trace, RESTART_TASK);
    watch.tick();
    const id = watch.facts.task ?? latestTask(inst).id;
    const running = await until("the build to be running", async () => builds(inst, id).find(one => one.provider_started_at && !one.finished_at) ?? null, { timeoutMs: WAIT.build, everyMs: 250, seen: () => JSON.stringify(builds(inst, id)) });
    const scopeBefore = scopeOf(inst, id);
    // The console process killed mid-build, then the terminal closed (the person's window went with it).
    const up = upOf(term);
    if (up === null) throw new Error("couldn't find the console the terminal UI started");
    process.kill(up, "SIGKILL");
    trace.note(`The console (up) killed mid-build, build #${running.id} running`, { screen: term.text() });
    await sleep(500);
    try { process.kill(-term.pid, "SIGKILL"); } catch { /* gone */ }
    term.close();
    trace.note("The terminal closed");
    const killedAt = Date.now();
    // The person runs it again.
    again = await startToolroll(inst, trace, { label: "again" });
    const screenAt = Date.now();
    trace.note("The new screen", { screen: again.text() });
    // Does the build start again by itself (B1.5: no other act)?
    const itself = await startedBy(inst, id, running.id, 30_000);
    criterion("B1.5", "the retried build starts by itself within 30 s of the new screen", itself !== null,
      itself !== null ? `${Math.round((Date.parse(itself.provider_started_at) - screenAt) / 100) / 10} s` : `no build in 30 s; the screen says: ${boxLines(again.text(), /Failed|Retry|stopped|Building|Waiting/) || footerOf(again.text())}`);
    const retried = itself ?? await retryByHand(inst, again, trace, criterion, id, running.id, "B1.5");
    if (retried === null) {
      // Recovery isn't possible without a password today: what can still be proved is that nothing ran twice.
      const scope = scopeOf(inst, id);
      criterion("B1.5", "the same scope after the restart (its digest and approval unchanged)", scope?.digest === scopeBefore?.digest && scope?.approved_digest === scopeBefore?.approved_digest, `${scopeBefore?.digest?.slice(0, 12)} → ${scope?.digest?.slice(0, 12)}`);
      criterion("B1.5", "no duplicate active build", watch.facts.maxActive <= 1, `at most ${watch.facts.maxActive} unfinished at once`);
      criterion("B1.5", "the task reaches Ready", false, "not without a password");
      if (watch.facts.maxActive > 1) throw new Error(`${watch.facts.maxActive} builds were unfinished at once`);
      return { killed: running.id, recovered: false };
    }
    const waited = trace.beginWait(itself === null ? "The retried build, until Ready" : "The task reaches Ready with no act");
    await until(`${id} to be Ready after the restart`, async () => latestTask(inst)?.state === "done", { timeoutMs: WAIT.build, everyMs: 500, seen: () => JSON.stringify({ task: latestTask(inst), builds: builds(inst, id) }) });
    waited({ screen: again.text() });
    const scopeAfter = scopeOf(inst, id);
    const sameScope = scopeAfter?.digest === scopeBefore?.digest && scopeAfter?.approved_digest === scopeBefore?.approved_digest;
    const killed = builds(inst, id).find(one => one.id === running.id);
    criterion("B1.5", "the same scope after the restart (its digest and approval unchanged)", sameScope, `${scopeBefore?.digest?.slice(0, 12)} → ${scopeAfter?.digest?.slice(0, 12)}, approved ${scopeAfter?.approved_digest === scopeBefore?.approved_digest ? "unchanged" : "changed"}`);
    criterion("B1.5", "no duplicate active build", watch.facts.maxActive <= 1, `at most ${watch.facts.maxActive} unfinished at once; builds: ${builds(inst, id).map(one => `#${one.id} ${one.outcome ?? "running"}${one.reason ? ` (${one.reason})` : ""}`).join(", ")}`);
    criterion("B1.5", "the task reaches Ready with no other act", itself !== null, itself !== null ? "Ready, no key pressed" : "Ready only after the person retried by hand");
    note(`the killed build #${running.id} ended ${killed?.outcome ?? "unfinished"} (${killed?.reason ?? ""}); ${Math.round((screenAt - killedAt) / 100) / 10} s from the kill to the new screen`);
    if (!sameScope) throw new Error("the scope changed across the restart");
    if (watch.facts.maxActive > 1) throw new Error(`${watch.facts.maxActive} builds were unfinished at once`);
    return { killed: running.id, retried: retried.id, byItself: itself !== null };
  } finally {
    watch.stop();
    if (again !== null) await quit(again);
    if (term !== null) term.close();
    await inst.stop();
  }
}

// ------------------------------------------------------------------ the journeys

const ABOUT = {
  repo: "Bare `toolroll` in a small git repository with a test (the newcomer's best case): the terminal UI, the first task written, its terms approved, the build, Ready, accepted.",
  home: "Bare `toolroll` from the home folder, with the sample project (B1.4).",
  browser: "`toolroll --web` in the same repository, everything done in the browser: for comparison with the terminal path.",
};
await clockJourney("Terminal: a first result in a git repository", SCRIPTED, ABOUT.repo, terminalInRepo);
await clockJourney("Terminal: a first result from the home folder with the sample project", SCRIPTED, ABOUT.home, terminalFromHome);
await clockJourney("Terminal: a first result on the plan road", SCRIPTED, "The same, when the sizing calls the task bigger than a small change: filed, the background question, a plan to approve (a real model can take this road).", context => terminalInRepo(context, { planRoad: true }));
await clockJourney("Browser: a first result in a git repository (for comparison)", SCRIPTED, ABOUT.browser, browserInRepo);
await clockJourney("Failure: no agent installed", SCRIPTED, "Bare `toolroll` with no coding agent on the PATH: what the screen says, then how long until installing and signing in is noticed (B1.6).", trace => agentMissing(trace, "none"));
await clockJourney("Failure: the agent is signed out", SCRIPTED, "Bare `toolroll` with Claude Code installed but signed out: what the screen says, then how long until signing in is noticed (B1.6).", trace => agentMissing(trace, "signed-out"));
await clockJourney("Failure: not in a git repository", SCRIPTED, "Bare `toolroll` started in a plain folder (B1.6: offers the sample project).", notARepository);
await clockJourney("Failure: a model error mid-build", SCRIPTED, "The build's model turn fails (529 Overloaded): what the screen says, and Retry (B1.6).", modelError);
await clockJourney("Restart: the console killed mid-build", SCRIPTED, "The console process killed mid-build and the terminal closed; bare `toolroll` again: the same scope, no duplicate active build, Ready with no other act (B1.5).", restartRecovery);
await clockJourney("Terminal: a first result in a git repository (real model)", REAL_MODEL, ABOUT.repo, terminalInRepo);
await clockJourney("Terminal: a first result from the home folder with the sample project (real model)", REAL_MODEL, ABOUT.home, terminalFromHome);
await clockJourney("Browser: a first result in a git repository (real model, for comparison)", REAL_MODEL, ABOUT.browser, browserInRepo);

if (!w.listing) {
  for (const one of installs) await one.stop();
  writeReport();
  w.say(`first-result report: ${join(evidence, "first-result.md")}`);
}
await w.finish("First result");
