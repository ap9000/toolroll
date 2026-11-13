#!/usr/bin/env node
/**
 * The install smoke (.github/workflows/install-smoke.yml): what a newcomer's first minute does, run on the package a
 * release would publish. It packs this checkout, then, in a throwaway home of its own:
 *
 *   - `npm i -g <tarball>` into a scratch npm prefix;
 *   - `toolroll --version` (must be package.json's version), `standing-orders --version` (the older name), and
 *     `toolroll help`;
 *   - `toolroll demo --port <n> --json`: it starts, its envelope names the loopback URL and a sandbox in this home's
 *     temp folder, `GET /` answers, and a stop (SIGTERM, as Ctrl-C) ends it with code 0, the port closed and the
 *     sandbox removed;
 *   - install.sh as `curl … | sh` runs it (the script on stdin), installing the same tarball (SO_PACKAGE) into a second
 *     scratch prefix with SO_NO_START=1: it must say what it installed and how to start it.
 *
 * Confined: HOME, XDG_*, TMPDIR, npm's prefix, cache and user config all live under one temp folder, the environment is
 * an allowlist (nothing named TOOLROLL_*, SO_* or npm_config_* from the caller leaks in), and PATH holds node and npm
 * alone plus the system folders, so a `toolroll` already installed on this computer can't answer for the packed one.
 * The demo's port is always explicit: --port, else a free one picked here; 4180 (the default service's) is refused. It
 * reads no secret, calls no model and needs only the public npm registry (the package's dependencies).
 *
 *   node scripts/install-smoke.mjs [--port <n>] [--skip-build] [--tarball <file.tgz>] [--work <empty dir>] [--keep]
 *
 * Exit 0 when every check passed, 1 when one failed (each says what it saw), 2 on a usage error.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_PORT = 4180;

function usage(message) {
  process.stderr.write(`${message}\nusage: node scripts/install-smoke.mjs [--port <n>] [--skip-build] [--tarball <file.tgz>] [--work <empty dir>] [--keep]\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { port: null, skipBuild: false, tarball: null, work: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined || next.startsWith("--")) usage(`${arg} needs a value`); return next; };
    if (arg === "--port") {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 1 || port > 65_535) usage("--port must be a number from 1 to 65535");
      if (port === FORBIDDEN_PORT) usage(`--port ${FORBIDDEN_PORT} is the default service's port; pick another`);
      options.port = port;
    } else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--tarball") options.tarball = resolve(value());
    else if (arg === "--work") options.work = resolve(value());
    else if (arg === "--keep") options.keep = true;
    else usage(`unknown argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const results = [];
const started = Date.now();
const seconds = since => `${((Date.now() - since) / 1000).toFixed(1)}s`;

function record(name, ok, detail, since) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${name}${since === undefined ? "" : ` (${seconds(since)})`}${detail ? ` — ${detail}` : ""}\n`);
}

/** A failed check stops the run: each later one depends on it. */
class Failed extends Error {}
function check(name, ok, detail, since) {
  record(name, ok, detail, since);
  if (!ok) throw new Failed(name);
}

/** The last lines of a command's output, for a failure's detail. */
const tail = text => String(text ?? "").trim().split("\n").slice(-12).join("\n      ");

// ---- the throwaway world ----------------------------------------------------------------------------------------

if (options.work !== null) {
  mkdirSync(options.work, { recursive: true });
  if (readdirSync(options.work).length > 0) usage(`--work ${options.work} is not empty`);
}
const work = realpathSync(options.work ?? mkdtempSync(join(tmpdir(), "toolroll-install-smoke-")));
const home = join(work, "home");
const dirs = {
  config: join(home, ".config"), data: join(home, ".local", "share"), state: join(home, ".local", "state"), cache: join(home, ".cache"),
  tmp: join(work, "tmp"), npmCache: join(work, "npm-cache"), pack: join(work, "pack"), tools: join(work, "tools"),
  prefixNpm: join(work, "prefix-npm"), prefixSh: join(work, "prefix-install-sh"),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
/** install.sh's projects folder: SO_NO_START=1 must leave it uncreated. */
const projects = join(home, "Projects");
const userNpmrc = join(work, "npmrc"), globalNpmrc = join(work, "npmrc-global");
writeFileSync(userNpmrc, "");
writeFileSync(globalNpmrc, "");

/** node and npm alone, so nothing else this computer has on PATH (an installed toolroll) can answer. */
function linkTools() {
  const npm = spawnSync("/bin/sh", ["-c", "command -v npm"], { encoding: "utf8" }).stdout.trim();
  if (npm === "") usage("npm is not on PATH");
  symlinkSync(process.execPath, join(dirs.tools, "node"));
  symlinkSync(realpathSync(npm), join(dirs.tools, "npm"));
}
linkTools();

/** The confined environment: an allowlist, never the caller's whole environment. */
function envFor(prefix, extra = {}) {
  const env = {
    HOME: home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache,
    TMPDIR: dirs.tmp, PATH: [join(prefix, "bin"), dirs.tools, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb", NO_COLOR: "1",
    npm_config_prefix: prefix, npm_config_cache: dirs.npmCache, npm_config_userconfig: userNpmrc, npm_config_globalconfig: globalNpmrc,
    npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", npm_config_loglevel: "error",
    TOOLROLL_NO_UPDATE_CHECK: "1",
    ...extra,
  };
  // A registry mirror the caller set on purpose still applies; nothing else of npm's configuration does.
  if (process.env.npm_config_registry) env.npm_config_registry = process.env.npm_config_registry;
  if (process.env.CI) env.CI = process.env.CI;
  return env;
}

function run(command, args, { env, cwd = work, input, timeout = 240_000 } = {}) {
  const out = spawnSync(command, args, { env, cwd, input, timeout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: out.status, signal: out.signal, stdout: out.stdout ?? "", stderr: out.stderr ?? "", error: out.error };
}

/** The `toolroll` a shell with `env` runs, followed to its file. */
function resolved(env) {
  const found = run("/bin/sh", ["-c", "command -v toolroll"], { env, timeout: 10_000 }).stdout.trim();
  return found === "" ? "" : realpathSync(found);
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
/** dist/cli.js as installed under an npm prefix (lib/node_modules on macOS and Linux). */
const installedCli = prefix => { const file = join(prefix, "lib", "node_modules", "toolroll", "dist", "cli.js"); return existsSync(file) ? sha256(readFileSync(file)) : "missing"; };

const inside = (path, root) => path === root || path.startsWith(root + sep);

async function freePort() {
  for (;;) {
    const port = await new Promise((done, failed) => {
      const server = createServer();
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => { const { port: got } = server.address(); server.close(() => done(got)); });
    });
    if (port !== FORBIDDEN_PORT) return port;
  }
}

/** Whether something accepts connections on 127.0.0.1:port. */
const listening = port => new Promise(done => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => done(false));
});

// ---- the checks -------------------------------------------------------------------------------------------------

let demo = null;
const stopDemo = () => { if (demo !== null && demo.exitCode === null && demo.signalCode === null) { try { demo.kill("SIGKILL"); } catch { /* gone */ } } };
process.on("exit", stopDemo);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopDemo(); process.exit(1); });

async function main() {
  process.stdout.write(`install smoke: toolroll ${version}, node ${process.versions.node}, ${process.platform}-${process.arch}\nwork folder: ${work}\n`);

  // 1. The package a release would publish.
  let tarball = options.tarball;
  if (tarball === null) {
    if (!options.skipBuild) {
      const at = Date.now();
      const built = run("npm", ["run", "build"], { env: { ...process.env, npm_config_update_notifier: "false" }, cwd: repo, timeout: 600_000 });
      check("npm run build", built.code === 0, built.code === 0 ? "" : tail(built.stderr || built.stdout), at);
    }
    const at = Date.now();
    const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dirs.pack], { env: envFor(dirs.prefixNpm), cwd: repo });
    let file = null;
    try { file = JSON.parse(packed.stdout)[0].filename; } catch { /* reported below */ }
    check("npm pack", packed.code === 0 && file !== null, file === null ? tail(packed.stderr || packed.stdout) : file, at);
    tarball = join(dirs.pack, file);
  }
  if (!existsSync(tarball)) check("tarball exists", false, tarball);
  const listed = run("tar", ["-tzf", tarball], { env: envFor(dirs.prefixNpm) });
  const entries = listed.stdout.split("\n");
  const needed = ["package/package.json", "package/dist/bin.js", "package/dist/cli.js"];
  const missing = needed.filter(one => !entries.includes(one));
  check("tarball holds the bin", listed.code === 0 && missing.length === 0, missing.length === 0 ? `${entries.filter(Boolean).length} files` : `missing ${missing.join(", ")}`);

  // 2. npm i -g, as the README's npm road.
  const npmEnv = envFor(dirs.prefixNpm);
  let at = Date.now();
  const installed = run("npm", ["install", "--global", tarball, "--no-audit", "--no-fund"], { env: npmEnv, timeout: 300_000 });
  check("npm i -g <tarball>", installed.code === 0, installed.code === 0 ? "" : tail(installed.stderr || installed.stdout), at);
  const bin = join(dirs.prefixNpm, "bin", "toolroll");
  const packedCli = sha256(spawnSync("tar", ["-xzOf", tarball, "package/dist/cli.js"], { maxBuffer: 256 * 1024 * 1024 }).stdout ?? "");
  check("installed files are the tarball's", installedCli(dirs.prefixNpm) === packedCli, `dist/cli.js sha256 ${packedCli.slice(0, 12)}`);
  const onPath = resolved(npmEnv);
  check("the toolroll on PATH is the temp prefix's", existsSync(bin) && onPath !== "" && inside(onPath, realpathSync(dirs.prefixNpm)), onPath || "none on PATH");

  at = Date.now();
  const shown = run(bin, ["--version"], { env: npmEnv, timeout: 30_000 });
  check("toolroll --version", shown.code === 0 && shown.stdout.trim() === version, `printed ${JSON.stringify(shown.stdout.trim())}, package.json says ${version}${shown.code === 0 ? "" : `; exit ${shown.code}: ${tail(shown.stderr)}`}`, at);
  const older = run(join(dirs.prefixNpm, "bin", "standing-orders"), ["--version"], { env: npmEnv, timeout: 30_000 });
  check("standing-orders --version (older name)", older.code === 0 && older.stdout.trim() === version, `printed ${JSON.stringify(older.stdout.trim())}`);

  at = Date.now();
  const help = run(bin, ["help"], { env: npmEnv, timeout: 30_000 });
  const helpLines = help.stdout.trim().split("\n").length;
  check("toolroll help", help.code === 0 && /\btoolroll\b/.test(help.stdout) && help.stderr.trim() === "", help.code === 0 ? `${helpLines} lines${help.stderr.trim() ? `; stderr: ${tail(help.stderr)}` : ""}` : `exit ${help.code}: ${tail(help.stderr)}`, at);

  // 3. toolroll demo: start, answer, stop, clean up.
  const port = options.port ?? await freePort();
  check(`port ${port} is free`, !(await listening(port)), "");
  at = Date.now();
  demo = spawn(bin, ["demo", "--port", String(port), "--json"], { env: npmEnv, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  demo.stdout.on("data", chunk => { stdout += chunk; });
  demo.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(done => demo.once("exit", (code, signal) => done({ code, signal })));
  const envelope = await new Promise(done => {
    const deadline = setTimeout(() => done(null), 90_000);
    const tryParse = () => { try { const value = JSON.parse(stdout); clearTimeout(deadline); done(value); } catch { /* not whole yet */ } };
    demo.stdout.on("data", tryParse);
    exited.then(() => { clearTimeout(deadline); tryParse(); done(null); });
  });
  check("toolroll demo --json starts", envelope !== null && envelope.ok === true, envelope === null ? `no envelope; stdout: ${tail(stdout)}; stderr: ${tail(stderr)}` : "", at);
  const url = `http://127.0.0.1:${port}`;
  check("demo envelope names the loopback URL", envelope.url === url, `url ${JSON.stringify(envelope.url)}`);
  const sandbox = String(envelope.sandbox ?? "");
  check("demo sandbox is in this home's temp folder", sandbox !== "" && existsSync(sandbox) && inside(realpathSync(sandbox), realpathSync(dirs.tmp)), sandbox);
  // The throwaway login exists as a file in the sandbox (never read or printed here) and never rides the envelope.
  check("demo login file, not in the envelope", existsSync(String(envelope.login?.passwordFile ?? "")) && !/password"\s*:/.test(stdout), "");

  at = Date.now();
  let answer = null, failure = "";
  try {
    const response = await fetch(`${url}/`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    answer = { status: response.status, location: response.headers.get("location"), length: (await response.text()).length };
  } catch (error) { failure = String(error?.cause?.message ?? error?.message ?? error); }
  check("GET / answers", answer !== null && answer.status < 400, answer === null ? failure : `${answer.status}${answer.location ? ` → ${answer.location}` : ""}, ${answer.length} bytes`, at);
  if (answer.location) {
    const target = new URL(answer.location, `${url}/`);
    check("its redirect stays on the demo", target.origin === url, target.href);
    const page = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const body = await page.text();
    check(`GET ${target.pathname} answers`, page.status === 200 && /<html/i.test(body), `${page.status}, ${body.length} bytes`);
  }

  at = Date.now();
  demo.kill("SIGTERM");
  const ended = await Promise.race([exited, new Promise(done => setTimeout(() => done(null), 30_000))]);
  check("demo stops on SIGTERM with code 0", ended !== null && ended.code === 0, ended === null ? "still running after 30 s" : `code ${ended.code}, signal ${ended.signal}${stderr.trim() ? `; stderr: ${tail(stderr)}` : ""}`, at);
  check("demo's port is closed", !(await listening(port)), "");
  check("demo sandbox removed", !existsSync(sandbox), sandbox);
  const leftover = readdirSync(dirs.tmp).filter(name => name.startsWith("toolroll-demo-"));
  check("no demo folder left in temp", leftover.length === 0, leftover.join(", "));

  // 4. install.sh, as `curl -fsSL …/install.sh | sh` runs it, installing this tarball.
  const shEnv = envFor(dirs.prefixSh, { SO_PACKAGE: tarball, SO_NO_START: "1", SO_PROJECTS: projects });
  at = Date.now();
  const script = readFileSync(join(repo, "install.sh"), "utf8");
  const viaSh = run("/bin/sh", ["-s"], { env: shEnv, input: script, timeout: 300_000 });
  const said = `${viaSh.stdout}${viaSh.stderr}`;
  check("install.sh (piped to sh, SO_NO_START=1)", viaSh.code === 0, viaSh.code === 0 ? "" : `exit ${viaSh.code}: ${tail(said)}`, at);
  check("install.sh installs the tarball, not the registry's latest", said.includes(`Installing ${tarball} …`) && installedCli(dirs.prefixSh) === packedCli, tail(viaSh.stdout));
  check("install.sh says what it installed", said.includes(`Installed ${version}.`), "");
  check("install.sh says how to start", /Start it with: toolroll --project-root '/.test(said), "");
  const shBin = join(dirs.prefixSh, "bin", "toolroll");
  const shOnPath = resolved(shEnv);
  check("install.sh's toolroll on PATH is its temp prefix's", shOnPath !== "" && inside(shOnPath, realpathSync(dirs.prefixSh)), shOnPath || "none on PATH");
  const shVersion = existsSync(shBin) ? run(shBin, ["--version"], { env: shEnv, timeout: 30_000 }).stdout.trim() : "";
  check("install.sh's toolroll --version", shVersion === version, `printed ${JSON.stringify(shVersion)} from ${shBin}`);
  check("install.sh started nothing (SO_NO_START)", !existsSync(projects), "");
}

let code = 0;
try {
  await main();
} catch (error) {
  code = 1;
  if (!(error instanceof Failed)) record("unexpected error", false, String(error?.stack ?? error));
} finally {
  stopDemo();
}
const passed = results.filter(one => one.ok).length;
process.stdout.write(`\n${code === 0 ? "PASSED" : "FAILED"}: ${passed} of ${results.length} checks in ${seconds(started)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map(one => `| ${one.ok ? "ok" : "**FAIL**"} | ${one.name} | ${String(one.detail ?? "").replace(/\n/g, " ").replace(/\|/g, "\\|").slice(0, 300)} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Install smoke (${process.platform}, node ${process.versions.node})\n\n| | check | detail |\n|---|---|---|\n${rows.join("\n")}\n\n`);
}
if (options.keep) process.stdout.write(`kept: ${work}\n`);
else rmSync(work, { recursive: true, force: true });
process.exit(code);
