#!/usr/bin/env node
/**
 * The terminal workbench end to end (solo-workbench plan T1), on a throwaway computer: bare `toolroll` in a git
 * repository starts this checkout's console on its own (`up --laptop`, local mode), the launcher hands the Rust
 * workbench its one-time sign-in on descriptor 3, and the person — this script, typing into a real pseudo-terminal —
 * files a task with `n`, watches the scripted provider build it, opens its changes, accepts it with `a`, and quits.
 *
 *   node scripts/tui-e2e.mjs --port <n> --out <empty folder> [--binary <toolroll-tui>] [--keep] [--no-model] [--browser]
 *
 * Only the model is scripted (scripts/fixtures/scripted-provider.mjs). A throwaway HOME under --out, the database in a
 * short folder of this checkout (a socket path must fit), an explicit port (never 4180), stand-ins for the browser
 * opener and the service supervisors on PATH, and an environment built from nothing (no ambient agent variables). It
 * writes screens.txt (each step's screen) and report.json to --out, and stops everything it started.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Screen } from "./first-result-kit.mjs";
import { scriptedProvider } from "./fixtures/scripted-provider.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at === -1 ? fallback : args[at + 1]; };
const port = Number(option("--port", "4801"));
if (!Number.isInteger(port) || port === 4180 || port < 1024) throw new Error("--port: a free port of your own, never 4180");
const out = resolve(option("--out", ""));
if (option("--out", "") === "" || (existsSync(out) && readdirSync(out).length > 0)) throw new Error("--out: an empty folder");
const binary = resolve(option("--binary", join(here, "tui", "target", "release", "toolroll-tui")));
if (!existsSync(binary)) throw new Error(`no terminal workbench build at ${binary} (cd tui && cargo build --release)`);

// SAFETY (found by this script's first run, 2026-11-14): a build started on this checkout's console does not stay inside
// the throwaway HOME — the build ran this computer's own Claude Code (~/.local/bin/claude) under the person's own login
// (a session appeared in the real ~/.claude/projects) instead of the scripted stand-in. Until the agent fence keeps a
// build inside the HOME it was given, this script files and builds nothing when this computer has an agent CLI of its
// own: it opens the workbench, types a task and cancels it, opens the browser through the launcher, and quits.
const realHome = userInfo().homedir;
const ownAgents = ["claude", "codex"].flatMap(name => [join(realHome, ".local", "bin", name), join(realHome, ".claude", "local", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]).filter(one => existsSync(one));
const modelFree = ownAgents.length > 0 || args.includes("--no-model");
const home = join(out, "home"), bin = join(out, "bin"), tmp = join(out, "tmp"), shop = join(home, "shop");
for (const one of [home, bin, tmp, join(shop, "src"), join(shop, "test")]) mkdirSync(one, { recursive: true });
// The database where its socket path fits (the scratch folder's path is too long for a socket).
const dbDir = join(here, `.t1-e2e-${process.pid}`);
mkdirSync(dbDir);
const db = join(dbDir, "orders.db");
const screens = join(out, "screens.txt");
const report = { port, binary, steps: [], model_free: modelFree, ...(ownAgents.length > 0 ? { why_model_free: `this computer's own agent CLIs (${ownAgents.join(", ")}) could run under the person's login` } : {}) };

const TASK = "Add a subtract(a, b) function next to add in src/math.js, with a test.";
const files = {
  "package.json": JSON.stringify({ name: "shop", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "src/math.js": "export const add = (a, b) => a + b;\n",
  "test/math.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('adds', () => assert.equal(add(2, 3), 5));\n",
  "README.md": "# Shop\n",
};
for (const [file, text] of Object.entries(files)) writeFileSync(join(shop, file), text);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Sam", GIT_AUTHOR_EMAIL: "sam@example.invalid", GIT_COMMITTER_NAME: "Sam", GIT_COMMITTER_EMAIL: "sam@example.invalid" };
execFileSync("git", ["-C", shop, "init", "-q", "-b", "main"], { env: gitEnv });
execFileSync("git", ["-C", shop, "add", "."], { env: gitEnv });
execFileSync("git", ["-C", shop, "commit", "-qm", "First version"], { env: gitEnv });

// The model, scripted: the build of TASK writes subtract and its test.
const provider = scriptedProvider(join(out, "provider"));
provider.add("tui", { role: "builder", when: [/subtract\(a, b\)/], answer: {
  files: { "src/math.js": "export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\n",
    "test/math.test.js": files["test/math.test.js"].replace("import { add }", "import { add, subtract }") + "test('subtracts', () => assert.equal(subtract(5, 2), 3));\n" },
  conclusion: "Added subtract(a, b) next to add, with a test." } });

const exe = (file, text) => { writeFileSync(join(bin, file), text); chmodSync(join(bin, file), 0o755); };
symlinkSync(process.execPath, join(bin, "node"));
exe("claude", `#!/bin/sh\nexec '${provider.shims.claude}' "$@"\n`);
// The browser opener: records that a page was handed over (a sign-in page's path), opens nothing.
for (const opener of ["open", "xdg-open"]) exe(opener, `#!/bin/sh\nprintf '%s\\n' "${opener} was handed a page" >> '${join(out, "opened.txt")}'\n`);
exe("open-browser", `#!/bin/sh\nprintf '%s\\n' "$1" >> '${join(out, "plain-opened.txt")}'\n`);
exe("tailscale", `#!/bin/sh\necho '{"BackendState":"Stopped"}'\n`);
for (const supervisor of ["launchctl", "systemctl"]) exe(supervisor, `#!/bin/sh\necho "${supervisor} is refused in this test" >&2\nexit 1\n`);

const env = {
  PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, USER: "sam", LANG: "en_US.UTF-8", TERM: "xterm-256color", TMPDIR: tmp,
  TOOLROLL_DB: db, TOOLROLL_TUI_BINARY: binary, TOOLROLL_BROWSER_COMMAND: join(bin, "open-browser"), TOOLROLL_SECRET_STORE: "files",
  TOOLROLL_STORAGE_SWEEP: "off", TOOLROLL_NO_PLAN_PROBE: "1", ...gitEnv, GIT_CONFIG_GLOBAL: "/dev/null",
};
delete env.CLAUDECODE;
for (const name of Object.keys(env)) if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI)/.test(name)) delete env[name];

// The terminal: scripts/fixtures/pty-host.py, started detached so it (and `toolroll` under it) has no coding agent among
// its ancestors (prompt.ts underAgent), as a person's own terminal hasn't. Keys go in through a FIFO; what it draws is
// appended to a log this script reads.
const cols = 140, rows = 40;
const screen = new Screen(rows, cols), decoder = new StringDecoder("utf8");
const termDir = join(out, "terminal");
mkdirSync(termDir);
const fifo = join(termDir, "keys"), log = join(termDir, "screen.log"), pidFile = join(termDir, "pid");
execFileSync("mkfifo", [fifo]);
const keys = openSync(fifo, fsConstants.O_RDWR);
const word = text => `'${String(text).replace(/'/g, "'\\''")}'`;
const python = ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"].find(one => existsSync(one)) ?? "python3";
const host = [python, join(here, "scripts", "fixtures", "pty-host.py"), rows, cols, fifo, log, pidFile, process.execPath, join(here, "dist", "bin.js"), "--port", port].map(word).join(" ");
spawn("/bin/sh", ["-c", `cd ${word(shop)} && exec ${host} > ${word(join(termDir, "host.log"))} 2>&1 < /dev/null &`], { stdio: "ignore", env, detached: true }).unref();
let raw = "", offset = 0, answered = 0;
const pump = () => {
  if (!existsSync(log)) return;
  const bytes = readFileSync(log);
  if (bytes.length > offset) {
    const more = decoder.write(bytes.subarray(offset));
    offset = bytes.length;
    raw += more;
    screen.write(more);
    // A terminal answers its device-attributes query (crossterm asks once, for the kitty keyboard).
    const asked = raw.split("\u001b[c").length - 1;
    for (; answered < asked; answered += 1) writeSync(keys, "\u001b[?62c");
  }
};
const hostPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null);
const alive = () => { const pid = hostPid(); if (pid === null) return true; try { process.kill(pid, 0); return true; } catch { return false; } };
let exited = null;
const term = { write: text => writeSync(keys, text) };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const text = () => { pump(); if (exited === null && !alive()) exited = { gone: true }; return screen.text(); };
const started = Date.now();
const step = (name, extra = {}) => {
  const shown = text();
  appendFileSync(screens, `\n===== ${name} (${((Date.now() - started) / 1000).toFixed(1)} s) =====\n${shown}\n`);
  report.steps.push({ name, at_s: (Date.now() - started) / 1000, ...extra });
};
async function waitFor(pattern, what, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pattern.test(text())) return text();
    if (exited !== null) break;
    await sleep(100);
  }
  step(`FAILED waiting for ${what}`);
  throw new Error(`the screen never showed ${what}${exited === null ? "" : ` (toolroll exited ${JSON.stringify(exited)})`}`);
}
const type = async words => { for (const c of words) { term.write(c); await sleep(15); } };
const sqlite = query => JSON.parse(execFileSync("sqlite3", ["-json", "-readonly", "-cmd", ".timeout 5000", db, query], { encoding: "utf8" }).trim() || "[]");

let failure = null;
try {
  // 1. Bare `toolroll`: the console starts, the workbench opens signed in.
  await waitFor(/Toolroll/, "the workbench", 120_000);
  await waitFor(/Nothing yet|Needs you|Working/, "the work list", 60_000);
  report.workbench = !/Opening the classic screen/.test(raw) && /\u001b\[\?2026h/.test(raw);
  step("the workbench, empty", { classic: /Opening the classic screen/.test(raw) });
  if (modelFree) {
    // Nothing filed: n, a few words, Esc; w (the launcher opens the browser signed in: the opener stand-in records a
    // page); ? and back.
    term.write("n");
    await waitFor(/New task: /, "the new-task box");
    await type("Add a subtract function");
    step("typing a new task (cancelled next)");
    term.write("\u001b");
    await sleep(300);
    // w only with --browser: on 2026-11-14 the launcher reported "Opened in your browser." without this script's
    // opener stand-in being run, so a real browser may have opened (see the T1 report). Off by default until explained.
    if (args.includes("--browser")) term.write("w");
    const opened = Date.now() + (args.includes("--browser") ? 20_000 : 0);
    while (!existsSync(join(out, "opened.txt")) && Date.now() < opened) await sleep(200);
    report.browser_opened = existsSync(join(out, "opened.txt"));
    step("w: the browser");
    term.write("?");
    await waitFor(/Press any key to close/, "help");
    step("?: help");
    term.write("x");
    await sleep(300);
    report.filed = sqlite("SELECT count(*) AS n FROM task")[0]?.n ?? null;
  } else {
  // 2. n: a new task, filed through POST /tasks/add.
  term.write("n");
  await waitFor(/New task: /, "the new-task box");
  await type(TASK);
  step("typing a new task");
  term.write("\r");
  // A small task: its exact terms, and Enter is Build (the page's own fast start, as data).
  await waitFor(/Build approves exactly this|Filed\. A plan comes first\.|Refused: /, "the filing's answer");
  step("New task's answer");
  if (/Refused: /.test(text())) throw new Error(`filing was refused: ${/Refused: (.*?)\s*│/.exec(text())?.[1]}`);
  report.road = /Build approves exactly this/.test(text()) ? "build" : "plan";
  if (report.road === "build") {
    term.write("\r");
    await waitFor(/Building it\.|Refused: /, "Build's answer");
    step("Enter: Build");
    if (/Refused: /.test(text())) throw new Error(`Build was refused: ${/Refused: (.*?)\s*│/.exec(text())?.[1]}`);
  }
  const task = await (async () => { for (let i = 0; i < 100; i += 1) { const row = sqlite("SELECT id, state FROM task ORDER BY rowid DESC LIMIT 1")[0]; if (row) return row; await sleep(200); } return null; })();
  report.task = task;
  // 3. Watch it: the row appears and moves through the steps, the scripted build runs, and it waits on the person.
  await waitFor(/subtract/, "the task's row", 30_000);
  step("the task listed");
  const ready = Date.now() + 240_000;
  let seenLive = false;
  while (Date.now() < ready) {
    const now = text();
    if (/Build ◐|Building now|build #\d+/.test(now)) seenLive = true;
    if (/Needs you \d/.test(now) && /Result|Ready/.test(now)) break;
    if (/Plan|Approval/.test(now) && /Needs you \d/.test(now) && /Approve|approve/.test(now)) break;
    await sleep(250);
  }
  report.saw_live_build = seenLive;
  step("waiting on the person");
  const scope = sqlite(`SELECT approved_at FROM task_scope WHERE task_id = '${task?.id ?? ""}'`)[0] ?? null;
  report.approved = scope?.approved_at ?? null;
  // 4. Its changes, then accept it with a.
  term.write("\r");
  await sleep(1500);
  step("Enter: the result's changes");
  report.diff_shown = /src\/math\.js/.test(text());
  term.write("a");
  await waitFor(/Accept, with a note|Refused: |isn't ready/, "the accept box or why not", 10_000);
  step("a: accept");
  if (/Accept, with a note/.test(text())) {
    term.write("\r");
    await waitFor(/Accepted\.|Refused: /, "the accept's answer", 30_000);
    step("accepted");
    report.accepted = /Accepted\./.test(text());
  } else report.accepted = false;
  report.final_state = sqlite(`SELECT state FROM task WHERE id = '${task?.id ?? ""}'`)[0]?.state ?? null;
  }
  // 5. q: owned, so it asks; s stops the agents and quits.
  term.write("q");
  await waitFor(/Quit Toolroll\?/, "the quit question", 10_000);
  step("q: quit");
  term.write("s");
  const until = Date.now() + 60_000;
  while (alive() && Date.now() < until) await sleep(200);
  pump();
  report.exit = alive() ? "still running" : "ended";
  report.after_quit = raw.slice(-400).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  step("after quitting");
} catch (error) {
  failure = error.message;
  report.failure = failure;
} finally {
  // Anything still running in the terminal's own process group: stopped (only what this script started).
  const pid = hostPid();
  if (pid !== null && alive()) { try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ } await sleep(3000); try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
  report.provider_turns = provider.journal().map(one => one.role);
  report.opened = existsSync(join(out, "opened.txt"));
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, "raw-bytes.txt"), String(raw.length));
  if (!args.includes("--keep")) rmSync(dbDir, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
  process.exit(failure === null ? 0 : 1);
}
