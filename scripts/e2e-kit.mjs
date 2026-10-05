/**
 * The shared world for end-to-end runs: a throwaway Toolroll — the
 * real CLI, the real console (`serve`) and the real worker loop (`watch`) —
 * against a real git repository, driven through a real browser. Nothing is
 * stubbed but, in a scripted run, the model; the database is read only as the
 * oracle.
 *
 * A run makes a world, runs named checks (each may need earlier ones), and
 * writes a report: `output/e2e/<name>-<time>/report.md`, with a screenshot of
 * every open page when a check fails. Its workspace is removed when it ends,
 * whatever the outcome, unless --keep.
 *
 * Options every run takes: --only <pattern> (just the checks whose names
 * match), --keep, --playwright <index.mjs>, --output <dir>, and:
 *
 *   --journeys scripted   the journeys that test Toolroll's own behaviour, with the
 *                         model scripted (scripts/fixtures/scripted-provider.mjs)
 *   --journeys real       the journeys that test the model integration, and what
 *                         they need, with real models
 *   --journeys all        every journey, with real models (the default; nightly)
 *   --list --json         the journeys, each with its mode, needs and groups; no world
 *
 * Every model call a run makes is in <output>/model-calls.jsonl, and the report
 * counts them: scripted, and real turns.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { countingProvider, scriptedProvider, turnsOf } from "./fixtures/scripted-provider.mjs";

export const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
export const flag = name => args.includes(name);
export const option = (name, fallback) => { const at = args.indexOf(name); return at === -1 ? fallback : args[at + 1]; };
export const sleep = ms => new Promise(done => setTimeout(done, ms));
export const freePort = () => new Promise(done => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => done(port)); }); });

/**
 * The processes a run owns, by process group: every `serve`, `watch`, `up` and `demo` a journey starts runs in a group
 * of its own, and the whole group stops when the journey is done with it — passed, failed or timed out. The groups
 * still running are listed in <output>/processes.json, so a runner whose run was killed outright (no `finally` runs
 * then) stops them before it retries (e2e-parallel.mjs); whatever is left when this process exits is killed with it.
 */
export const PROCESSES_FILE = "processes.json";
const owned = new Map();
let ownedFile = option("--output", null) === null ? null : join(resolve(option("--output", "")), PROCESSES_FILE);
function saveOwned() {
  if (ownedFile === null) return;
  try { mkdirSync(dirname(ownedFile), { recursive: true }); writeFileSync(ownedFile, JSON.stringify([...owned].map(([group, label]) => ({ group, label })), null, 2) + "\n"); } catch { /* the exit handler still stops them */ }
}
export function processesIn(out) { ownedFile = join(out, PROCESSES_FILE); saveOwned(); }
/** Own a process group (a child spawned detached leads its own). */
export function own(group, label) { owned.set(group, label); saveOwned(); return group; }
/** spawn(), in a process group of its own that this run owns. */
export function spawnOwned(label, command, argv, options = {}) {
  const child = spawn(command, argv, { ...options, detached: true });
  if (child.pid !== undefined) own(child.pid, label);
  return child;
}
export const groupAlive = group => { try { process.kill(-group, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const signalGroup = (group, signal) => { try { process.kill(-group, signal); } catch { /* already gone */ } };
/** Stop process groups: SIGTERM, then SIGKILL whatever is still there after `graceMs`; resolves once every group is gone. */
export async function stopGroups(groups, { graceMs = 10_000 } = {}) {
  for (const group of groups) signalGroup(group, "SIGTERM");
  for (const [signal, ms] of [["SIGKILL", graceMs], [null, 5_000]]) {
    const deadline = Date.now() + ms;
    while (groups.some(groupAlive) && Date.now() < deadline) await sleep(100);
    if (signal !== null) for (const group of groups.filter(groupAlive)) signalGroup(group, signal);
  }
  for (const group of groups) owned.delete(group);
  saveOwned();
  const left = groups.filter(groupAlive);
  if (left.length > 0) throw new Error(`process group${left.length === 1 ? "" : "s"} ${left.join(", ")} would not stop`);
}
/** Stop every group this run still owns. */
export const stopOwned = options => stopGroups([...owned.keys()], options);
process.on("exit", () => { for (const group of owned.keys()) signalGroup(group, "SIGKILL"); });
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(signal, () => process.exit(code));
/** For a runner: stop the groups a run left behind in <folder>/processes.json (it was killed, or crashed). Returns how many. */
export async function stopLeftovers(folder) {
  let listed = [];
  try { listed = JSON.parse(readFileSync(join(folder, PROCESSES_FILE), "utf8")).map(one => one.group).filter(one => Number.isInteger(one) && one > 1); } catch { return 0; }
  // A group id can be taken again once its group is gone: only a group still running this checkout's Toolroll is stopped.
  const ours = group => { try { execFileSync("pgrep", ["-g", String(group), "-f", join(here, "dist/bin.js")], { stdio: "ignore" }); return true; } catch (error) { return error.status !== 1; } };
  const alive = listed.filter(groupAlive).filter(ours);
  await stopGroups(alive, { graceMs: 5_000 }).catch(() => undefined);
  try { writeFileSync(join(folder, PROCESSES_FILE), "[]\n"); } catch { /* a report folder that is gone */ }
  return alive.length;
}

/** Playwright is not a dependency: --playwright <index.mjs>, else a copy `npx playwright` left in the npm cache whose browser is downloaded, else an installed one. */
export async function loadPlaywright() {
  const given = option("--playwright", null);
  const cache = join(homedir(), ".npm/_npx");
  const cached = existsSync(cache) ? readdirSync(cache).map(one => join(cache, one, "node_modules/playwright/index.mjs")).filter(one => existsSync(one)) : [];
  for (const candidate of given === null ? [...cached, "playwright"] : [given]) {
    const loaded = await import(candidate).catch(() => null);
    if (loaded?.chromium !== undefined && existsSync(loaded.chromium.executablePath())) return loaded;
  }
  throw new Error("Needs Playwright and its browser: npx playwright install chromium, or pass --playwright <path to playwright/index.mjs>");
}

/** A check that can't run here (no Docker, say): skipped with the reason, never passed. */
export class Skip extends Error {}

/** Thrown from inside a wait when what it waits for can no longer happen (the planner gave up, say): it ends the wait at once. */
export class GiveUp extends Error {}

/** How long a wait on a real Claude turn may take: a slow turn, plus the worker's own retry of a failed one. */
export const REAL_TURN_MS = 300_000;

/**
 * Wait until `test` answers something truthy, trying every `everyMs`. A wait that runs out names what it waited for and
 * for how long, with the last error and, when `seen` is given, what it saw at the end (`seen` is read only then).
 */
export async function until(what, test, { timeoutMs = 120_000, everyMs = 1500, seen } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await test(); if (last) return last; } catch (error) { if (error instanceof GiveUp) throw new Error(`Gave up waiting for ${what}: ${error.message}`); last = error; }
    await sleep(everyMs);
  }
  const saw = seen === undefined ? "" : await Promise.resolve().then(seen).then(one => ` — saw: ${one}`, error => ` — couldn't read what it saw: ${error.message}`);
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ""}${saw}`);
}

/** A Playwright locator's wait, named: when it runs out, the failure says what it waited for and for how long, not only the selector. */
export async function waitFor(locator, what, { timeoutMs = 30_000, state = "visible", seen } = {}) {
  try {
    return await locator.waitFor({ timeout: timeoutMs, state });
  } catch (error) {
    if (error?.name !== "TimeoutError" && !/Timeout \d+ms exceeded/.test(String(error?.message))) throw error;
    const saw = seen === undefined ? "" : await Promise.resolve().then(seen).then(one => ` — saw: ${one}`, failed => ` — couldn't read what it saw: ${failed.message}`);
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${saw}`);
  }
}

/**
 * Make the world: a repository with a passing test, two approvers (alex and
 * sam), a registered runner, Claude as every phase, `npm test` as the
 * project's check; the console and the worker started; alex signed in.
 */
/** A cross-page fade the browser skipped mid-navigation (it reports the skip as an InvalidStateError). It is cosmetic:
 * the page itself loaded, and the shell settles these where it can (browser-shell.ts, app.tsx; serve.ts explains why a
 * page can't always). Every other browser error still fails "No browser errors on any page". */
export const SKIPPED_FADE = /Transition was aborted because of invalid state/;
/** The check every run ends with. */
export const BROWSER_CHECK = "No browser errors on any page";
/** The check a scripted run also ends with: every model call it made had a scripted answer. */
export const PROVIDER_CHECK = "Every model call was scripted";

/**
 * Every journey says what it tests. SCRIPTED: Toolroll's own behaviour (approvals, results, flows moving cards, chat
 * buttons, storage), with the model scripted (scripts/fixtures/scripted-provider.mjs). REAL_MODEL: the model
 * integration itself (the lead's real turns, the planner and builder protocols, the classifier), with real models.
 */
export const SCRIPTED = "scripted", REAL_MODEL = "real-model";
export const MODES = [SCRIPTED, REAL_MODEL];
/**
 * Which journeys a run takes (--journeys): "scripted" runs the scripted ones against the scripted provider; "real"
 * runs the real-model ones, and the journeys they need, with real models; "all" (the default) runs every journey
 * with real models, as the nightly journeys do.
 */
export const JOURNEYS = ["scripted", "real", "all"];

/** A group's line in `--groups --json`: how many journeys it has, how many of them are real-model, and how many scripted
 * ones are its own (not shared with another group, as a first-run setup is): a scripted run of a group with none of
 * its own would only repeat what other groups run. */
export const groupList = groups => Object.entries(groups).map(([name, one]) => ({ name, journeys: one.journeys, scripted: one.journeys - (one.real ?? 0), ownScripted: one.journeys - (one.real ?? 0) - (one.shared ?? 0), real: one.real ?? 0, about: one.about }));

/**
 * What is wrong with a script's journeys, as declared in order (each { name, needs, mode, groups }) against its
 * GROUPS: an untagged journey, a need that isn't declared before it or isn't in each of its groups, a scripted journey
 * that needs a real-model one (a scripted run couldn't run it), a group no journey is in, or counts GROUPS gets wrong.
 */
export function catalogueProblems(catalogue, groups) {
  const problems = [], seen = new Map();
  for (const one of catalogue) {
    if (!MODES.includes(one.mode)) problems.push(`"${one.name}" doesn't say whether it is ${MODES.join(" or ")}`);
    if (seen.has(one.name)) problems.push(`"${one.name}" is declared twice`);
    for (const group of one.groups) if (!(group in groups)) problems.push(`"${one.name}" is in group ${group}, which GROUPS doesn't list`);
    for (const need of one.needs) {
      const earlier = seen.get(need);
      if (earlier === undefined) problems.push(`"${one.name}" needs "${need}", which isn't a journey declared before it`);
      else if (!one.groups.every(group => earlier.groups.includes(group))) problems.push(`"${one.name}" needs "${need}" from another group`);
      else if (one.mode === SCRIPTED && earlier.mode === REAL_MODEL) problems.push(`"${one.name}" is scripted but needs the real-model "${need}"`);
    }
    seen.set(one.name, one);
  }
  for (const [name, group] of Object.entries(groups)) {
    const mine = catalogue.filter(one => one.groups.includes(name));
    if (mine.length === 0) problems.push(`group ${name} has no journeys`);
    else if (mine.length !== group.journeys || mine.filter(one => one.mode === REAL_MODEL).length !== (group.real ?? 0)) problems.push(`group ${name} has ${mine.length} journeys (${mine.filter(one => one.mode === REAL_MODEL).length} real-model), not the ${group.journeys} (${group.real ?? 0} real-model) GROUPS lists`);
    else if (mine.filter(one => one.mode === SCRIPTED && one.groups.length > 1).length !== (group.shared ?? 0)) problems.push(`group ${name} shares ${mine.filter(one => one.mode === SCRIPTED && one.groups.length > 1).length} scripted journeys with other groups, not the ${group.shared ?? 0} GROUPS lists`);
  }
  return problems;
}

/**
 * The journeys a run takes from `catalogue` (in a group's order): every one matching --only for "all"; the scripted
 * ones matching it for "scripted"; for "real", the real-model ones matching it and everything they need.
 */
export function selectJourneys(catalogue, { journeys = "all", only = null } = {}) {
  const matched = one => only === null || only.test(one.name);
  if (journeys === "all") return new Set(catalogue.filter(matched).map(one => one.name));
  if (journeys === "scripted") return new Set(catalogue.filter(one => one.mode === SCRIPTED && matched(one)).map(one => one.name));
  const chosen = new Set(catalogue.filter(one => one.mode === REAL_MODEL && matched(one)).map(one => one.name));
  for (const one of [...catalogue].reverse()) if (chosen.has(one.name)) for (const need of one.needs) chosen.add(need);
  return chosen;
}

/** The journeys a script declares, without a world (--list --json): each one's name, needs, mode and groups. Ends
 * the run with the list on stdout, or the catalogue's problems on stderr and exit 1. */
function listOnly(groups) {
  const catalogue = [];
  const declare = (title, needs, body, { mode, groups: in_ = [] } = {}) => { catalogue.push({ name: title, needs, mode, groups: in_ }); return true; };
  const finish = () => {
    const problems = catalogueProblems(catalogue, groups);
    if (problems.length > 0) { console.error(problems.join("\n")); process.exitCode = 1; return; }
    const wanted = option("--group", null);
    console.log(JSON.stringify(wanted === null ? catalogue : catalogue.filter(one => one.groups.includes(wanted))));
  };
  const nothing = () => { throw new Error("a journey's body ran while listing"); };
  return { listing: true, check: declare, finish, script: () => [], say: () => undefined, page: null, cli: nothing, rows: nothing, sql: nothing };
}

/** The journeys a real-model run takes: from this script's own list (--list), the real-model ones and what they need. */
function realSelection(only) {
  const argv = [process.argv[1], "--list", "--json", ...(option("--group", null) === null ? [] : ["--group", option("--group", null)])];
  const catalogue = JSON.parse(execFileSync(process.execPath, argv, { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "inherit"] }));
  return selectJourneys(catalogue, { journeys: "real", only });
}

export async function world(name, { seed, env = {}, groups = null } = {}) {
  const journeys = option("--journeys", "all");
  if (!JOURNEYS.includes(journeys)) throw new Error(`--journeys is ${JOURNEYS.join(", ")}, not ${journeys}`);
  if (flag("--list")) return listOnly(groups ?? {});
  const BIN = join(here, "dist/bin.js");
  if (!existsSync(BIN)) throw new Error("Build first: npm run build");
  const { chromium } = await loadPlaywright();
  const only = option("--only", null) === null ? null : new RegExp(option("--only", ""), "i");
  const group = option("--group", null);
  const realChosen = journeys === "real" ? realSelection(only) : null;
  const root = realpathSync(mkdtempSync(join(tmpdir(), `so-${name}-e2e-`)));
  const out = resolve(option("--output", join(here, "output/e2e", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`)));
  mkdirSync(out, { recursive: true });
  const repo = join(root, "shop"), state = join(root, "state"), db = join(state, "orders.db");
  mkdirSync(repo); mkdirSync(state);
  const started = Date.now();
  const say = line => { const stamp = `${Math.round((Date.now() - started) / 1000)}s`.padStart(6); console.log(`[${name}] ${stamp}  ${line}`); };
  // The models: a scripted run answers from the journeys' scripts; any other run uses the real CLIs, each call counted.
  // First on the PATH of everything this run starts: the CLI, the console, the worker, a demo, a fresh install.
  const provider = journeys === "scripted" ? scriptedProvider(join(root, "provider")) : countingProvider(join(root, "provider"));
  process.env.PATH = `${provider.bin}${delimiter}${process.env.PATH ?? ""}`;

  const cli = (argv, { ok = [0], json = true, env = {} } = {}) => {
    try {
      const stdout = execFileSync(process.execPath, [BIN, ...argv, "--db", db, ...(json ? ["--json"] : [])], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", ...env }, stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
      return json ? JSON.parse(stdout) : stdout;
    } catch (error) {
      if (ok.includes(error.status)) return json ? JSON.parse(error.stdout) : error.stdout;
      throw new Error(`standing-orders ${argv.join(" ")}: ${(error.stdout ?? "") + (error.stderr ?? "")}`.slice(0, 2000));
    }
  };
  const sql = query => execFileSync("sqlite3", ["-json", db, query], { encoding: "utf8" }).trim() || "[]";
  const rows = query => JSON.parse(sql(query));

  const results = [];
  const failed = new Set();
  const openPages = [];
  const catalogue = [];
  let current = null;
  /** The model calls made while `body` ran: model turns, and how many of them were real. */
  const calls = async body => {
    const before = provider.journal().length;
    try { return await body(); } finally { calls.last = turnsOf(provider.journal().slice(before)); }
  };
  // Every result names what it needs, so a runner can retry just the failed journeys and what they need (e2e-parallel.mjs).
  // A journey says its mode and groups (scripts with groups): it runs when this run takes its group and its mode.
  async function check(title, needs, body, { always = false, mode = null, groups: in_ = null } = {}) {
    const at = Date.now();
    if (!always) catalogue.push({ name: title, needs, mode, groups: in_ ?? [] });
    if (!always && in_ !== null && group !== null && !in_.includes(group)) return null;
    if (!always && !MODES.includes(mode)) throw new Error(`"${title}" doesn't say whether it is ${MODES.join(" or ")}`);
    const chosen = always || (journeys === "all" ? only === null || only.test(title) : journeys === "scripted" ? mode === SCRIPTED && (only === null || only.test(title)) : realChosen.has(title));
    const tag = always ? {} : { mode };
    if (!chosen) { results.push({ name: title, needs, ...tag, state: "not selected" }); return null; }
    const missing = needs.filter(one => failed.has(one));
    if (missing.length > 0) { results.push({ name: title, needs, ...tag, state: "skipped", because: missing }); say(`SKIP  ${title} (needs ${missing.join(", ")})`); failed.add(title); return null; }
    say(`...   ${title}${always ? "" : ` [${mode}]`}`);
    current = title;
    try {
      const detail = await calls(body);
      results.push({ name: title, needs, ...tag, state: "passed", seconds: Math.round((Date.now() - at) / 100) / 10, modelCalls: calls.last, ...(detail === undefined ? {} : { detail }) });
      say(`PASS  ${title} (${Math.round((Date.now() - at) / 1000)} s)`);
      return detail ?? true;
    } catch (error) {
      failed.add(title);
      if (error instanceof Skip) { results.push({ name: title, needs, ...tag, state: "skipped", because: [error.message] }); say(`SKIP  ${title} (${error.message})`); return null; }
      const file = join(out, `${results.length + 1}-failed.png`);
      for (const one of openPages) await one.screenshot({ path: file.replace(".png", `-${openPages.indexOf(one)}.png`) }).catch(() => undefined);
      results.push({ name: title, needs, ...tag, state: "failed", seconds: Math.round((Date.now() - at) / 100) / 10, modelCalls: calls.last, error: error instanceof Error ? error.message : String(error) });
      say(`FAIL  ${title}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
      return null;
    } finally {
      current = null;
    }
  }
  /** Script the model's answers for the journey that's running (a scripted run only; a real run asks real models). */
  const script = (...rules) => provider.add(current ?? "world", ...rules);

  say(`workspace ${root}`);
  const git = (...rest) => execFileSync("git", ["-C", repo, ...rest], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "shop", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  mkdirSync(join(repo, "src")); mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "src/math.js"), "export const add = (a, b) => a + b;\n");
  writeFileSync(join(repo, "test/math.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
  seed?.(repo);
  git("add", "."); git("-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "seed");

  const passwords = { alex: `alex-${randomBytes(8).toString("hex")}`, sam: `sam-${randomBytes(8).toString("hex")}` };
  const auth = ["--as", "alex", "--token", passwords.alex];
  cli(["approver", "add", "alex", "--password", passwords.alex]);
  cli(["approver", "add", "sam", "--password", passwords.sam, ...auth]);
  const runner = cli(["runner", "register", "worker", "--repo", repo, ...auth]);
  writeFileSync(join(state, "runner-token"), runner.token, { mode: 0o600 });
  for (const phase of ["plan", "build", "repair", "review"]) cli(["config", "set", phase, "--provider", "claude", "--model", "sonnet", ...auth]);
  cli(["verify", "set", "--repo", repo, "--command", "npm test", "--timeout-seconds", "120", "--yes", ...auth]);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logs = { serve: createWriteStream(join(out, "serve.log")), watch: createWriteStream(join(out, "watch.log")) };
  processesIn(out);
  const start = (label, argv) => {
    const child = spawnOwned(label, process.execPath, [BIN, ...argv, "--db", db], { env: { ...process.env, NODE_OPTIONS: "", TOOLROLL_MATE_TRACE: "1", STANDING_ORDERS_MATE_TRACE: "1", TOOLROLL_NO_PLAN_PROBE: "1", STANDING_ORDERS_NO_PLAN_PROBE: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(logs[label]); child.stderr.pipe(logs[label]);
    return child;
  };
  start("serve", ["serve", "--repo", repo, "--port", String(port)]);
  start("watch", ["watch", "--runner", "worker", "--token-file", join(state, "runner-token"), "--repo", repo, "--pool", join(root, "worktrees"),
    "--for", String(120 * 60_000), "--tick-every", "2000", "--reconcile-every", "5000", "--bridge-every", "3600000"]);
  await until("the console to answer", async () => (await fetch(`${base}/login`)).ok, { timeoutMs: 30_000, everyMs: 500 });
  say(`console ${base}, worker running`);

  const browser = await chromium.launch();
  const problems = [];
  /** A person at a browser, signed in; everything that goes wrong in their pages is kept. */
  async function signIn(who, viewport = { width: 1440, height: 900 }, colorScheme = "light") {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme });
    const page = await context.newPage();
    const where = () => { try { return new URL(page.url()).pathname; } catch { return page.url(); } };
    page.on("pageerror", error => { if (!SKIPPED_FADE.test(String(error))) problems.push(`${who} on ${where()}: ${String(error)}`); });
    page.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text()) && !SKIPPED_FADE.test(message.text())) problems.push(`${who} on ${where()}: ${message.text()}`); });
    await page.goto(`${base}/login`);
    await page.fill('input[name="name"]', who);
    await page.fill('input[name="token"]', passwords[who]);
    await Promise.all([page.waitForNavigation(), page.press('input[name="token"]', "Enter")]);
    openPages.push(page);
    return page;
  }
  const page = await signIn("alex");
  const json = async path => { const response = await page.request.get(`${base}${path}`, { headers: { accept: "application/json" } }); if (!response.ok()) throw new Error(`${path} answered ${response.status()}`); return response.json(); };
  /** A screenshot once the page has settled: any page change and other finite animations finished (never mid-fade). */
  const settle = on => on.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().iterations !== Infinity).map(one => one.finished.catch(() => undefined))),
    new Promise(done => setTimeout(done, 2000)),
  ])).catch(() => undefined);
  const shot = async name => { await settle(page); return page.screenshot({ path: join(out, `${name}.png`) }); };

  /** The lead's tool calls the console has traced (TOOLROLL_MATE_TRACE) since `from` bytes into its log: what each asked and got back. */
  const leadCalls = (from = 0) => {
    const log = join(out, "serve.log");
    if (!existsSync(log)) return [];
    return readFileSync(log).subarray(from).toString("utf8").split("\n").filter(line => line.startsWith("mate-trace ")).flatMap(line => { try { return [JSON.parse(line.slice("mate-trace ".length))]; } catch { return []; } });
  };
  const logSize = () => { try { return statSync(join(out, "serve.log")).size; } catch { return 0; } };

  /**
   * Send the lead a message and wait for its reply (a real Claude turn); returns the reply element, its text, and the
   * tools the lead called for it with what each returned. `project` asks in that project's chat.
   */
  async function askLead(message, on = page, { project = null } = {}) {
    const where = project === null ? "/chat" : `/chat?project=${encodeURIComponent(project)}`;
    if (!on.url().endsWith(where)) await on.goto(`${base}${where}`);
    await on.waitForSelector("[data-workspace-composer] textarea");
    const before = await on.locator("[data-workspace-chat] [data-message-id]").count();
    const from = logSize();
    await on.fill("[data-workspace-composer] textarea", message);
    await on.click('[data-workspace-composer] button[type="submit"]');
    await until(`the lead's reply to “${message.slice(0, 60)}”`, async () => (await on.locator("[data-workspace-chat] [data-message-id]").count()) >= before + 2,
      { timeoutMs: REAL_TURN_MS, everyMs: 2000, seen: async () => `${(await on.locator("[data-workspace-chat] [data-message-id]").count()) - before} new messages; ${JSON.stringify(leadCalls(from).map(one => one.tool))} called` });
    await sleep(1000);
    const reply = on.locator("[data-workspace-chat] [data-message-id]").last();
    return { reply, text: (await reply.innerText()).replace(/\s+/g, " "), calls: leadCalls(from) };
  }
  /** Wait for a pending card in the lead's reply; a reply without one fails naming the wait and quoting the reply. */
  async function pendingCard(reply, what, { label = null, timeoutMs = 30_000 } = {}) {
    let card = reply.locator('[data-view="chat-card"][data-card-state="pending"]');
    if (label !== null) card = card.filter({ hasText: label });
    await waitFor(card.first(), what, { timeoutMs, seen: async () => `the reply “${(await reply.innerText()).replace(/\s+/g, " ").slice(0, 300)}”` });
    return card.first();
  }
  async function confirmCard(reply, label) {
    const card = await pendingCard(reply, `the “${label}” card in the lead's reply`, { label, timeoutMs: 10_000 });
    await card.locator("[data-card-confirm]").click();
    await until(`the “${label}” card to be confirmed`, async () => (await reply.locator('[data-view="chat-card"][data-card-state="confirmed"]').filter({ hasText: label }).count()) > 0, { timeoutMs: 30_000 });
    return reply.locator('[data-view="chat-card"][data-card-state="confirmed"]').filter({ hasText: label }).first();
  }

  async function finish(title) {
    // Whatever --only picked, the pages it opened are checked.
    await check(BROWSER_CHECK, [], async () => { if (problems.length > 0) throw new Error(problems.slice(0, 5).join(" | ")); }, { always: true });
    await browser.close();
    // The console, the worker and anything a journey started and still owns: every group gone before the report.
    const unstopped = await stopOwned().then(() => null, error => error.message);
    // A scripted run proves no model call went unanswered, the ones made in the background included.
    if (provider.mode === "scripted") await check(PROVIDER_CHECK, [], async () => {
      const wrong = provider.journal().filter(one => one.turn && !one.ok && !one.intended);
      if (wrong.length > 0) throw new Error(wrong.slice(0, 3).map(one => `${one.provider} ${one.role}: ${one.error}`).join(" | "));
    }, { always: true });
    const journal = provider.journal();
    writeFileSync(join(out, "model-calls.jsonl"), journal.map(one => JSON.stringify(one)).join("\n") + (journal.length > 0 ? "\n" : ""));
    results.splice(0, results.length, ...results.filter(one => one.state !== "not selected"));
    const passed = results.filter(one => one.state === "passed").length, bad = results.filter(one => one.state === "failed").length, skipped = results.filter(one => one.state === "skipped").length;
    const modelCalls = turnsOf(journal);
    const catalogued = groups === null ? [] : catalogueProblems(catalogue, groups);
    const report = { startedAt: new Date(started).toISOString(), minutes: Math.round((Date.now() - started) / 6000) / 10, workspace: root, journeys, models: provider.mode, modelCalls, passed, failed: bad, skipped, results, ...(unstopped === null ? {} : { unstopped }), ...(catalogued.length === 0 ? {} : { catalogue: catalogued }) };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(out, "report.md"), [`# ${title} — ${passed} passed, ${bad} failed, ${skipped} skipped (${report.minutes} min)`, "",
      `Models: ${provider.mode === "scripted" ? `scripted (${modelCalls.scripted} scripted model calls)` : "real"}; real model turns: ${modelCalls.real}`, "",
      ...results.map(one => `- ${one.state === "passed" ? "✅" : one.state === "failed" ? "❌" : "⏭️"} ${one.name}${one.mode === undefined ? "" : ` [${one.mode}]`}${one.seconds === undefined ? "" : ` — ${one.seconds} s`}${one.error ? `\n  - ${one.error.split("\n")[0]}` : ""}${one.state === "skipped" ? `\n  - skipped: ${one.because.join(", ")}` : ""}`),
      ...catalogued.map(one => `- ❌ ${one}`),
      "", `Workspace: ${root}${flag("--keep") ? "" : " (removed; --keep keeps it)"}`, `Logs and screenshots: ${out}`, ""].join("\n"));
    say(`${passed} passed, ${bad} failed, ${skipped} skipped; model calls: ${modelCalls.scripted} scripted, ${modelCalls.real} real — ${join(out, "report.md")}`);
    for (const one of catalogued) say(`journeys: ${one}`);
    if (unstopped !== null) say(`left running: ${unstopped}`);
    // The world goes whatever the outcome (the report, logs and screenshots stay in the output folder); --keep keeps it.
    if (!flag("--keep")) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    process.exitCode = bad === 0 && unstopped === null && catalogued.length === 0 ? 0 : 1;
  }

  return { root, repo, state, db, out, base, port, passwords, auth, cli, sql, rows, until, check, say, git, browser, signIn, page, json, shot, askLead, leadCalls, pendingCard, confirmCard, problems, openPages, start, finish, bin: BIN,
    journeys, scripted: provider.mode === "scripted", provider, script, listing: false };
}

/** The journeys to run again from a failed group's report: the failed ones, the ones skipped because of them, and everything
 * those need. Null when the whole group has to run again. */
export function retrySet(results) {
  // A console error can come from any journey, passed ones included: that failure retries the whole group.
  if (results.some(one => one.name === BROWSER_CHECK && one.state === "failed")) return null;
  const failed = results.filter(one => one.state === "failed").map(one => one.name);
  if (failed.length === 0 || results.some(one => !Array.isArray(one.needs))) return null;
  const again = new Set(failed);
  for (let grew = true; grew;) {
    grew = false;
    for (const one of results) {
      const wanted = again.has(one.name) ? one.needs : one.state === "skipped" && one.needs.some(need => again.has(need)) ? [one.name] : [];
      for (const each of wanted) if (!again.has(each)) { again.add(each); grew = true; }
    }
  }
  return results.map(one => one.name).filter(one => again.has(one));
}
export const exactly = names => `^(?:${names.map(one => one.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
/** A retry that cleared a failed run, from both reports: every journey that failed the first time, and the browser-error
 * check, PASSED the second time. A journey skipped (or not run) the second time proved nothing. */
export function retryCleared(before, after) {
  if (!after) return false;
  const state = new Map(after.map(each => [each.name, each.state]));
  const mustPass = new Set(before.filter(each => each.state === "failed").map(each => each.name));
  if (after.some(each => each.name === BROWSER_CHECK)) mustPass.add(BROWSER_CHECK);
  return [...mustPass].every(name => state.get(name) === "passed");
}

/** A mail server that keeps what it's sent (SMTP, no TLS, no sign-in): the oracle for emails. */
export function mailSink() {
  const received = [];
  const server = createServer(socket => {
    let buffer = "", reading = false, current = { to: [], data: "" };
    socket.write("220 e2e ESMTP\r\n");
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (reading) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          current.data = buffer.slice(0, end); buffer = buffer.slice(end + 5); reading = false;
          received.push(current); current = { to: [], data: "" }; socket.write("250 queued\r\n"); continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 2);
        if (/^EHLO/i.test(line)) socket.write("250-e2e\r\n250 SIZE 10000000\r\n");
        else if (/^RCPT TO:/i.test(line)) { current.to.push(line.slice(8)); socket.write("250 ok\r\n"); }
        else if (/^DATA/i.test(line)) { reading = true; socket.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 ok\r\n");
      }
    });
  });
  return new Promise(done => server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port, received })));
}
