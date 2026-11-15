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
 * short folder of this checkout (a socket path must fit), an explicit port (never 4180), stand-ins for every agent CLI,
 * the browser openers and the service supervisors on PATH, and an environment built from nothing: an allowlist, never a
 * copy of this process's environment (a copy once overwrote the throwaway HOME and PATH, and a build ran this
 * computer's own Claude Code under the person's own login). A pre-flight ABORTS the run, before anything starts, when
 * inside that environment an agent CLI resolves outside the stand-in folder or HOME is the real one. It writes
 * screens.txt (each step's screen) and report.json to --out, stops everything it started, and exits non-zero whenever
 * a required outcome is false (report.required).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Screen } from "./first-result-kit.mjs";
import { scriptedProvider } from "./fixtures/scripted-provider.mjs";

/** Every name the child environment may carry: nothing else, and nothing copied from this process. */
export const ENV_ALLOWED = /^(PATH|HOME|USER|LOGNAME|LANG|TERM|TMPDIR|BROWSER|XDG_(CONFIG|CACHE|DATA|STATE)_HOME|TOOLROLL_[A-Z_]+|GIT_[A-Z_]+)$/;
/** The agent CLIs that must resolve to their stand-ins (or nowhere) inside the child environment. */
export const AGENT_CLIS = ["claude", "codex", "gemini", "opencode", "cursor-agent"];

/** The child environment, built from nothing: the stand-ins first on PATH, then only the system folders. */
export function childEnv({ bin, home, tmp, db, xdg, git }) {
  return {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, USER: "sam", LOGNAME: "sam", LANG: "en_US.UTF-8", TERM: "xterm-256color",
    TMPDIR: tmp, ...xdg, BROWSER: join(bin, "browser"),
    TOOLROLL_DB: db, TOOLROLL_BROWSER_COMMAND: join(bin, "open-browser"), TOOLROLL_SECRET_STORE: "files",
    TOOLROLL_STORAGE_SWEEP: "off", TOOLROLL_NO_PLAN_PROBE: "1", ...git,
  };
}

/** The shells asked: a plain one, and login shells (which run the system's profile, e.g. macOS path_helper adding
 * /etc/paths and /etc/paths.d folders). Only the ones this computer has. */
export const LOOKUP_SHELLS = [["/bin/sh", "-c"], ["/bin/zsh", "-lc"], ["/bin/bash", "-lc"]].filter(([shell]) => existsSync(shell));

/** Where `name` resolves inside `env` in each lookup shell started with exactly that environment ("" = nowhere); the
 * first answer that isn't in `bin` wins, so any shell finding a real CLI is reported. */
export function whereIn(env, name, bin = null) {
  let found = "";
  for (const [shell, flag] of LOOKUP_SHELLS) {
    const ran = spawnSync(shell, [flag, 'command -v "$0" || true', name], { env, encoding: "utf8", timeout: 10_000 });
    if (ran.status !== 0) throw new Error(`couldn't ask ${shell} where ${name} is`);
    const said = (ran.stdout ?? "").trim().split("\n").pop() ?? "";
    if (said !== "" && (bin === null || !said.startsWith(`${bin}/`))) return said;
    if (said !== "") found = said;
  }
  return found;
}

/**
 * The pre-flight: inside `env`, every agent CLI resolves to its stand-in in `bin` (or nowhere), HOME isn't the real
 * home, and no name outside the allowlist is set. `ok: false` with the problems ABORTS the run before anything starts.
 */
export function preflightOf(env, { bin, realHome, where = whereIn }) {
  const problems = [];
  const real = one => { try { return realpathSync(one); } catch { return one; } };
  const homeIsThrowaway = typeof env.HOME === "string" && env.HOME !== "" && env.HOME !== realHome && real(env.HOME) !== real(realHome);
  if (!homeIsThrowaway) problems.push("HOME is the real home");
  const agents = {};
  for (const name of AGENT_CLIS) {
    let found;
    try { found = where(env, name, bin); } catch (error) { problems.push(error.message); continue; }
    agents[name] = found === "" ? null : found.startsWith(`${bin}/`) ? "stand-in" : found;
    if (found !== "" && !found.startsWith(`${bin}/`)) problems.push(`${name} resolves outside the stand-in folder (${found})`);
  }
  const extra = Object.keys(env).filter(name => !ENV_ALLOWED.test(name));
  if (extra.length > 0) problems.push(`names outside the allowlist: ${extra.join(", ")}`);
  return { ok: problems.length === 0, home_is_throwaway: homeIsThrowaway, agents, ...(problems.length === 0 ? {} : { problems }) };
}

/** Every outcome the run needs; any false one fails the run (exit 1). */
export function requiredOf(report, { modelFree, browser, raw, failure }) {
  return {
    preflight: report.preflight?.ok === true, workbench: report.workbench === true,
    signed_in_by_flag: /Using your own terminal workbench build/.test(raw), quit: report.exit === "ended", no_failure: failure === null,
    ...(modelFree ? { nothing_filed: report.filed === 0, ...(browser ? { browser_stand_in: report.browser_opened === true } : {}) }
      : { diff_shown: report.diff_shown === true, accept_dialog_shown: report.accept_dialog === true, accepted: report.accepted === true,
        task_done: report.final_state === "done", scripted_turns_only: (report.provider_turns ?? []).length > 0 }),
  };
}

// Run only when started as a script (its test imports the functions above and runs nothing).
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

async function main() {
  const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const at = args.indexOf(name); return at === -1 ? fallback : args[at + 1]; };
  const port = Number(option("--port", "4801"));
  if (!Number.isInteger(port) || port === 4180 || port < 1024) throw new Error("--port: a free port of your own, never 4180");
  const out = resolve(option("--out", ""));
  if (option("--out", "") === "" || (existsSync(out) && readdirSync(out).length > 0)) throw new Error("--out: an empty folder");
  // Handed to `toolroll` as --tui-binary (an explicit, absolute choice the launcher checks), never through the environment.
  const binary = resolve(option("--binary", join(here, "tui", "target", "release", "toolroll-tui")));
  if (!existsSync(binary)) throw new Error(`no terminal workbench build at ${binary} (cd tui && cargo build --release)`);

  // SAFETY (found by this script's first run, 2026-11-14): a build started on this checkout's console ran this computer's
  // own Claude Code (~/.local/bin/claude) under the person's own login (a session appeared in the real ~/.claude/projects)
  // instead of the scripted stand-in. The cause: the child environment was a copy of this process's, spread last, so the
  // real HOME and PATH replaced the throwaway ones. It is now built from an allowlist, and the pre-flight below (a plain
  // shell and login shells, inside exactly that environment) aborts the run unless every agent CLI is its stand-in. The
  // console resolves a provider through its own PATH (attest.ts resolveExecutable), which is that environment's. A run
  // also fails unless the scripted provider answered (report.required.scripted_turns_only). --no-model files nothing.
  const realHome = userInfo().homedir;
  const modelFree = args.includes("--no-model");
  const home = join(out, "home"), bin = join(out, "bin"), tmp = join(out, "tmp"), shop = join(home, "shop");
  const xdg = { XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state") };
  for (const one of [home, bin, tmp, join(shop, "src"), join(shop, "test"), ...Object.values(xdg)]) mkdirSync(one, { recursive: true });
  // The database where its socket path fits (the scratch folder's path is too long for a socket).
  const dbDir = join(here, `.t1-e2e-${process.pid}`);
  mkdirSync(dbDir);
  const db = join(dbDir, "orders.db");
  const screens = join(out, "screens.txt");
  const report = { port, binary, steps: [], model_free: modelFree };

  const TASK = "Add a subtract(a, b) function next to add in src/math.js, with a test.";
  const files = {
    "package.json": JSON.stringify({ name: "shop", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
    "src/math.js": "export const add = (a, b) => a + b;\n",
    "test/math.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('adds', () => assert.equal(add(2, 3), 5));\n",
    "README.md": "# Shop\n",
  };
  for (const [file, text] of Object.entries(files)) writeFileSync(join(shop, file), text);
  // Git's environment, from nothing too (no copy of this process's).
  const gitNames = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Sam", GIT_AUTHOR_EMAIL: "sam@example.invalid", GIT_COMMITTER_NAME: "Sam", GIT_COMMITTER_EMAIL: "sam@example.invalid" };
  const gitEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: tmp, LANG: "en_US.UTF-8", ...gitNames };
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
  exe("codex", `#!/bin/sh\nexec '${provider.shims.codex}' "$@"\n`);
  // Every other agent CLI: a stand-in that runs nothing and says so.
  for (const agent of ["gemini", "opencode", "cursor-agent"]) exe(agent, `#!/bin/sh\necho "${agent} is a stand-in in this test" >&2\nexit 1\n`);
  // The browser openers and launchers: each records that a page was handed over (a sign-in page's path), opens nothing.
  const BROWSERS = ["open", "xdg-open", "browser", "sensible-browser", "x-www-browser", "www-browser", "firefox", "google-chrome", "chromium", "chromium-browser"];
  for (const opener of BROWSERS) exe(opener, `#!/bin/sh\nprintf '%s\\n' "${opener} was handed a page" >> '${join(out, "opened.txt")}'\n`);
  exe("open-browser", `#!/bin/sh\nprintf '%s\\n' "$1" >> '${join(out, "plain-opened.txt")}'\n`);
  exe("tailscale", `#!/bin/sh\necho '{"BackendState":"Stopped"}'\n`);
  for (const supervisor of ["launchctl", "systemctl"]) exe(supervisor, `#!/bin/sh\necho "${supervisor} is refused in this test" >&2\nexit 1\n`);

  // The child environment: exactly these names, nothing copied from this process (childEnv); then the pre-flight.
  const env = childEnv({ bin, home, tmp, db, xdg, git: gitNames });
  const preflight = preflightOf(env, { bin, realHome });
  console.log(`pre-flight: ${JSON.stringify(preflight)}`);
  report.preflight = preflight;
  if (!preflight.ok) {
    writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    rmSync(dbDir, { recursive: true, force: true });
    console.error(`ABORTED before anything started: ${preflight.problems.join("; ")}`);
    process.exit(2);
  }

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
  const host = [python, join(here, "scripts", "fixtures", "pty-host.py"), rows, cols, fifo, log, pidFile, process.execPath, join(here, "dist", "bin.js"), "--port", port, "--tui-binary", binary].map(word).join(" ");
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
    // 4. Its changes (Enter opens the Diff tab), then accept it with a: the dialog names the build it accepts
    // (view.rs "Accept the result of build #N"); a with no diff of that build on screen shows the changes first.
    term.write("\r");
    await waitFor(/src\/math\.js/, "the result's changes", 20_000);
    step("Enter: the result's changes");
    report.diff_shown = true;
    const DIALOG = /Accept the result of build #\d+/;
    const NOT_NOW = /Refused: |isn't ready to accept|No result is waiting|aren't the result waiting/;
    term.write("a");
    await waitFor(new RegExp(`${DIALOG.source}|Here are its changes|${NOT_NOW.source}`), "the accept dialog or why not", 10_000);
    if (/Here are its changes/.test(text()) && !DIALOG.test(text())) {
      await sleep(1500);
      term.write("a");
      await waitFor(new RegExp(`${DIALOG.source}|${NOT_NOW.source}`), "the accept dialog or why not", 10_000);
    }
    step("a: accept");
    report.accept_dialog = DIALOG.test(text());
    if (report.accept_dialog) {
      term.write("\r");
      // The console's own words when it keeps the act ("Marked complete."), else the workbench's ("Accepted. …").
      await waitFor(/Marked complete\.|Accepted\.|Refused: |aren't the result waiting|This result changed/, "the accept's answer", 30_000);
      step("accepted");
      report.accepted = /Marked complete\.|Accepted\./.test(text());
    } else report.accepted = false;
    // The acceptance happened in the database too, not just on screen.
    for (let i = 0; i < 50 && sqlite(`SELECT state FROM task WHERE id = '${task?.id ?? ""}'`)[0]?.state !== "done"; i += 1) await sleep(200);
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
    // Every outcome the run needs, true or the run fails (exit 1).
    report.required = requiredOf(report, { modelFree, browser: args.includes("--browser"), raw, failure });
    const missing = Object.entries(report.required).filter(([, ok]) => !ok).map(([name]) => name);
    report.ok = missing.length === 0;
    writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(out, "raw-bytes.txt"), String(raw.length));
    if (!args.includes("--keep")) rmSync(dbDir, { recursive: true, force: true });
    console.log(JSON.stringify(report, null, 2));
    if (missing.length > 0) console.error(`FAILED: ${missing.join(", ")}`);
    process.exit(missing.length === 0 ? 0 : 1);
  }
}
