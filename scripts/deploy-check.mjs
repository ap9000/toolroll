#!/usr/bin/env node
/**
 * The deploy check's rehearsal (docs/plans/release-from-main.md, part C), a part of `release-check.mjs` in deploy
 * mode, run after a person approved the release and after `npm run build` passed:
 *
 *   node scripts/deploy-check.mjs --copy <the plane's copy of its database>
 *
 * The plane copied its own database with SQLite's online backup into a folder of its own and named only that copy on
 * the check's handshake: this never sees the live database. In that folder it builds a throwaway computer
 * (isolated-env.mjs: its own HOME, XDG folders, temp folder and PATH of approved tools, no credentials, stand-ins for
 * gh, launchctl and browsers), checked right before every spawn. Then, with every candidate process inside a macOS
 * Seatbelt fence written here (network only to and from this computer's loopback address, writes only inside the
 * throwaway folder, the person's secret folders unreadable):
 *
 *   1. the candidate's own store opens the copy twice; history must be kept (the same schema keeps every row; a new
 *      schema changes history only as the candidate's own update rules allow) and the copy must pass SQLite's checks;
 *   2. the candidate's console starts against the copy with `serve --rehearsal` (127.0.0.1, an ephemeral port: no loop,
 *      queue, bridge, backup, sign-in probe, update check or background check starts);
 *   3. it must answer /healthz, and the candidate's `task list` must read the copy's tasks (0.9.105 broke there);
 *   4. every process it started is stopped, its whole process group proven gone, and the throwaway folder and the copy
 *      are deleted, however it ended.
 *
 * Exit 0 only when all of that held; anything else names the step. It never touches the live service or database.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { assertIsolated, isolatedEnvironment } from "./isolated-env.mjs";
import { openDeploymentDatabase, snapshot } from "./deploy-phases.mjs";

/** The person's folders that stay unreadable even where a wider read is allowed (Toolroll's state, every secret). */
export const SECRET_FOLDERS = [".toolroll", ".standing-orders", ".config", ".ssh", ".gnupg", ".aws", ".claude", ".codex", ".gemini", ".docker", ".kube", ".netrc", ".npmrc",
  "Library/Keychains", "Library/Application Support/toolroll", "Library/Application Support/Toolroll", "Library/LaunchAgents"];

/** What the operating system itself needs readable to run node and a shell: never a person's file. */
export const SYSTEM_READS = ["/System", "/usr/lib", "/usr/share", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/private/var/select", "/private/var/db/timezone",
  "/private/var/db/dyld", "/Library/Apple", "/private/etc", "/dev", "/opt/homebrew", "/usr/local"];

const sbString = value => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const realOr = path => { try { return realpathSync(path); } catch { return null; } };

/**
 * The Seatbelt profile every candidate process of the deploy check runs under (Codex review, finding 4): reads denied
 * by default — only the throwaway folder `root`, the release commit's checkout (its build output and dependencies, by
 * their real paths), node's own install and the operating system's are readable, and the person's secret folders never;
 * writes only inside `root` (a build also into the checkout, never its .git); no network, or (`port`) only the
 * rehearsal's own loopback port. Accident-proofing for a person-approved candidate, never a sandbox against hostile
 * code (AGENTS.md).
 */
export function fenceProfile({ root, checkout = null, home = homedir(), port = null, build = false, node = process.execPath }) {
  const realRoot = realpathSync(root);
  const reads = [realRoot, ...SYSTEM_READS];
  if (checkout !== null) {
    const out = realpathSync(checkout);
    reads.push(out);
    // Dependencies a shared cache links in: readable where they really are.
    const deps = realOr(join(out, "node_modules"));
    if (deps !== null && deps !== join(out, "node_modules")) reads.push(deps);
  }
  const nodeHome = dirname(dirname(realpathSync(node)));
  reads.push(nodeHome);
  const writes = [realRoot, ...(build && checkout !== null ? [realpathSync(checkout)] : [])];
  return [
    "(version 1)",
    "(allow default)",
    // No signal to any process but its own (Codex confirmation): ChildProcess.kill and /bin/kill bypass process.kill.
    "(deny signal (target others))",
    // Reads: nothing but what is named here (metadata only elsewhere, so paths can be resolved).
    "(deny file-read-data)",
    `(allow file-read-data ${[...new Set(reads)].map(one => `(subpath ${sbString(one)})`).join(" ")} (literal "/"))`,
    `(deny file-read* ${SECRET_FOLDERS.map(one => `(subpath ${sbString(join(home, one))})`).join(" ")})`,
    // Writes: the throwaway folder (and, building, the checkout but never its Git directory).
    "(deny file-write*)",
    `(allow file-write* ${writes.map(one => `(subpath ${sbString(one)})`).join(" ")} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/") (literal "/dev/dtracehelper"))`,
    ...(build && checkout !== null ? [`(deny file-write* (subpath ${sbString(join(realpathSync(checkout), ".git"))}))`] : []),
    // Network: none, but the rehearsal's own port on loopback, and Unix sockets inside the throwaway folder.
    "(deny network*)",
    ...(port === null ? [] : [
      `(allow network-bind (local ip "localhost:${port}"))`,
      `(allow network-inbound (local ip "localhost:${port}"))`,
      `(allow network-outbound (remote ip "localhost:${port}"))`,
    ]),
    `(allow network* (local unix-socket (subpath ${sbString(realRoot)})) (remote unix-socket (subpath ${sbString(realRoot)})))`,
    "",
  ].join("\n");
}

/** argv inside the fence: sandbox-exec on macOS. Null elsewhere (the deploy check is a Mac's own check). */
export function fenced(platform, profileFile, argv) {
  return platform === "darwin" ? ["/usr/bin/sandbox-exec", "-f", profileFile, ...argv] : null;
}

/** A free loopback port for the rehearsal's console, chosen before its fence is written (the fence names it). */
export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
  });
}

/** The child script the candidate's own store runs in, inside the fence: open the copy twice and report what changed. */
export const MIGRATE_SCRIPT = `
const [dist, file] = process.argv.slice(-2);
const { pathToFileURL } = await import("node:url");
const { join } = await import("node:path");
const { DatabaseSync } = await import("node:sqlite");
const store = await import(pathToFileURL(join(dist, "store.js")).href);
const update = await import(pathToFileURL(join(dist, "toolroll-update.js")).href);
const read = () => { const db = new DatabaseSync(file, { readOnly: true }); try { return { db, version: Number(db.prepare("SELECT version FROM schema_version").get()?.version) }; } catch (error) { db.close(); throw error; } };
let { db, version: from } = read();
const before = update.historySnapshot(db); db.close();
store.openStore(file).close(); store.openStore(file).close();
({ db } = read());
try {
  const to = Number(db.prepare("SELECT version FROM schema_version").get()?.version);
  const changed = update.changedHistory(db, before);
  const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  const foreign = db.prepare("PRAGMA foreign_key_check").all().length;
  process.stdout.write(JSON.stringify({ from, to, wanted: store.SCHEMA_VERSION, changed, integrity, foreign }) + "\\n");
} finally { db.close(); }
`;

/** Why the migrated copy isn't kept as it should be, or null: history unchanged but by the update rules, at the
 * candidate's schema, SQLite's checks clean, and with the same schema every table's rows exactly as before. */
export function migrationProblem(result, { before, after }) {
  if (result === null || typeof result !== "object") return "the candidate's store didn't report on the copy";
  if (result.to !== result.wanted) return `the copy is at schema ${result.to}, not the candidate's ${result.wanted}`;
  if (result.integrity !== "ok" || result.foreign !== 0) return "the upgraded copy failed SQLite's integrity or foreign-key check";
  if (!Array.isArray(result.changed) || result.changed.length > 0) return `history changed: ${Array.isArray(result.changed) ? result.changed.join(", ") : "unreadable"}`;
  if (result.from === result.to) {
    const was = new Map(before.map(one => [one.name, one]));
    for (const table of after) {
      const old = was.get(table.name);
      if (old === undefined || old.count !== table.count || old.hash !== table.hash) return `the same schema changed rows of ${table.name}`;
    }
  }
  return null;
}

/** Stop a process group: TERM, a bounded wait for it to end, then KILL; proven gone (every member) or why not. */
export async function stopGroup(pid, { kill = process.kill.bind(process), waitMs = 10_000, sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) { // guard: bound the wait for a stopped group to exit, a ceiling
  const alive = () => { try { kill(-pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; } };
  if (!alive()) return null;
  try { kill(-pid, "SIGTERM"); } catch { /* gone meanwhile */ }
  for (let waited = 0; waited < waitMs && alive(); waited += 100) await sleep(100);
  if (alive()) { try { kill(-pid, "SIGKILL"); } catch { /* gone meanwhile */ } }
  for (let waited = 0; waited < 2_000 && alive(); waited += 100) await sleep(100);
  return alive() ? `process group ${pid} is still running after SIGKILL` : null;
}

/** Read lines from a child's stdout until one is the JSON envelope `serve` prints, or the bound runs out. */
function firstEnvelope(child, timeoutMs) {
  return new Promise(done => {
    let text = "";
    const timer = setTimeout(() => done(null), timeoutMs); // guard: bound the wait for the console's first line, a ceiling
    child.stdout.on("data", chunk => {
      text += String(chunk);
      // The envelope is the first thing it prints, one JSON object (pretty-printed): read it once it is whole.
      const start = text.indexOf("{");
      for (let end = text.indexOf("\n}", start); start !== -1 && end !== -1; end = text.indexOf("\n}", end + 2)) {
        try { const value = JSON.parse(text.slice(start, end + 2)); clearTimeout(timer); done(value); return; } catch { /* not whole yet */ }
      }
    });
    child.on("exit", () => { clearTimeout(timer); done(null); });
  });
}

/** A throwaway computer in `world` (inside `root`), built from nothing, and the check that refuses a spawn when anything
 * of the person's would reach it (assertIsolated throws, naming every problem). */
function throwaway({ root, world, home, set = {} }) {
  mkdirSync(world, { recursive: true, mode: 0o700 });
  // Its approved tools come from node's own folder and the system's, never from the caller's PATH.
  const outer = { ...process.env, PATH: [dirname(realpathSync(process.execPath)), "/usr/bin", "/bin"].join(":") };
  const made = isolatedEnvironment({ root: world, owner: root, outer, set: { TOOLROLL_NO_PLAN_PROBE: "1", TOOLROLL_NO_TASK_CLASSIFIER: "1", ...set } });
  return () => { assertIsolated(made.env, { root, homes: [realpathSync(home)] }); return made.env; };
}

/** Write a fence profile into `root` and wrap argv in it; outside macOS, refuse. */
function fenceFor(platform, root, name, options) {
  const profile = join(root, `${name}.sb`);
  writeFileSync(profile, fenceProfile({ root, ...options }), { mode: 0o600 });
  return argv => {
    const wrapped = fenced(platform, profile, argv);
    if (wrapped === null) throw new Error(`the deploy check's fence needs macOS (sandbox-exec); this is ${platform}`);
    return wrapped;
  };
}

/** Remove what a step left in `root` (its throwaway computer, its fence profiles, and with `copy` the copy too):
 * every problem said, never swallowed (Codex review, finding 5). */
function removeLeft(root, paths) {
  const problems = [];
  for (const path of paths) {
    try { rmSync(path, { recursive: true, force: true }); } catch (error) { problems.push(`${path} couldn't be deleted (${error?.code ?? error?.message ?? error})`); continue; }
    if (existsSync(path)) problems.push(`${path} is still there`);
  }
  return problems;
}

/**
 * The release commit's build, inside a throwaway computer and the fence (no network, reads only of the checkout, node
 * and the system, writes only into the checkout and the throwaway folder): `npm run build`, its scripts and every
 * dependency they load included. `{ ok, why }`.
 */
export function buildInFence({ checkout, copy }, io = {}) {
  const platform = io.platform ?? process.platform, run = io.spawnSync ?? spawnSync, home = io.home ?? homedir();
  const root = realpathSync(dirname(copy)), world = join(root, "build-world");
  try {
    const checked = throwaway({ root, world, home });
    const inFence = fenceFor(platform, root, "build-fence", { checkout, home, build: true });
    // Its own process group (outside the fence, so this process can still stop it): anything the build leaves running
    // is found and stopped, and fails the build (Codex confirmation: background children were never proven gone).
    const [cmd, ...args] = ["/usr/bin/perl", "-e", "setpgrp(0,0); exec @ARGV or die", ...inFence(["npm", "run", "build"])];
    const built = run(cmd, args, { cwd: realpathSync(checkout), env: checked(), encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "inherit", "inherit"] });
    const signal = io.kill ?? ((pid, sig) => process.kill(pid, sig));
    let left = false;
    if (typeof built.pid === "number" && built.pid > 0) {
      try { signal(-built.pid, 0); left = true; } catch { left = false; }
      if (left) { try { signal(-built.pid, "SIGKILL"); } catch { /* gone meanwhile */ } }
    }
    if (built.error !== undefined) return { ok: false, why: `the build couldn't start: ${built.error.message}` };
    if (left) return { ok: false, why: "the build left processes running; they were stopped" };
    if (built.status !== 0) return { ok: false, why: `the build exited ${built.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error) };
  } finally {
    const left = removeLeft(root, [world, join(root, "build-fence.sb")]);
    if (left.length > 0) return { ok: false, why: `the build's throwaway folder wasn't removed: ${left.join("; ")}` }; // eslint-disable-line no-unsafe-finally
  }
}

/**
 * The rehearsal. `io` (tests): `platform`, `spawnSync`, `spawn`, `fetch`, `home`, `kill`, `sleep`. Returns `{ ok: true, facts }`
 * or `{ ok: false, step, why }`. Cleanup fails closed (Codex review, finding 5): a process of the rehearsal still
 * running, or the throwaway folder or the copy still there, is a failure, whatever came before.
 */
export async function rehearse({ checkout, copy }, io = {}) {
  const platform = io.platform ?? process.platform, run = io.spawnSync ?? spawnSync, start = io.spawn ?? spawn, get = io.fetch ?? fetch;
  const home = io.home ?? homedir();
  const say = io.say ?? (line => console.log(line));
  const dist = join(resolve(checkout), "dist");
  const fail = (step, why) => ({ ok: false, step, why });
  if (!existsSync(copy)) return fail("copy", "the plane named no copy of its database");
  const root = realpathSync(dirname(copy));
  const world = join(root, "world");
  let group = null;
  let outcome;
  try {
    const checked = throwaway({ root, world, home, set: { TOOLROLL_DB: copy } });
    // Every step but the console's has no network at all; the console only its own loopback port.
    const quiet = fenceFor(platform, root, "fence", { checkout, home });
    // 1. The candidate's store on the copy.
    let before, from;
    { const db = openDeploymentDatabase(copy, { readOnly: true }); try { before = snapshot(db); from = db.prepare("SELECT version FROM schema_version").get()?.version; } finally { db.close(); } }
    const [cmd, ...args] = quiet([process.execPath, "--input-type=module", "-e", MIGRATE_SCRIPT, "--", dist, copy]);
    const migrated = run(cmd, args, { cwd: world, env: checked(), encoding: "utf8", timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    let result = null;
    try { result = JSON.parse(String(migrated.stdout).trim().split("\n").at(-1)); } catch { result = null; }
    let after = [];
    if (migrated.status === 0) { const db = openDeploymentDatabase(copy, { readOnly: true }); try { after = snapshot(db); } finally { db.close(); } }
    const problem = migrated.status !== 0 ? `the candidate couldn't open the copy (exit ${migrated.status}): ${String(migrated.stderr ?? "").trim().split("\n").slice(-3).join(" ")}` : migrationProblem(result, { before, after });
    if (problem !== null) outcome = fail("upgrade", problem);
    else {
      say(`deploy check: the candidate upgraded a copy of this computer's database from schema ${from} to ${result.to}, history kept (${before.length} tables).`);
      // 2. The candidate's console on the copy, nothing else started, reachable only on its own port.
      const port = await freePort();
      const served = fenceFor(platform, root, "serve-fence", { checkout, home, port });
      const [serveCmd, ...serveArgs] = served([process.execPath, join(dist, "bin.js"), "serve", "--rehearsal", "--port", String(port), "--json"]);
      const child = start(serveCmd, serveArgs, { cwd: world, env: checked(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
      group = child.pid ?? null;
      let errors = "";
      child.stderr?.on("data", chunk => { errors = (errors + String(chunk)).slice(-4000); });
      const envelope = await firstEnvelope(child, 60_000);
      if (envelope?.ok !== true || envelope.port !== port) outcome = fail("start", `the candidate's console didn't start on the copy: ${(errors.trim().split("\n").slice(-3).join(" ")) || "no answer within a minute"}`);
      else {
        // 3. It answers (never by a redirect), and reads tasks.
        const health = await get(`http://127.0.0.1:${port}/healthz`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
        if (health.status !== 200) outcome = fail("health", `/healthz answered ${health.status}`);
        else {
          const [listCmd, ...listArgs] = quiet([process.execPath, join(dist, "bin.js"), "task", "list", "--json"]);
          const listed = run(listCmd, listArgs, { cwd: world, env: checked(), encoding: "utf8", timeout: 2 * 60_000, maxBuffer: 64 * 1024 * 1024 });
          let tasks = null;
          try { tasks = JSON.parse(String(listed.stdout)); } catch { tasks = null; }
          if (listed.status !== 0 || tasks?.ok !== true) outcome = fail("tasks", `the candidate couldn't list the copy's tasks (exit ${listed.status}): ${String(listed.stderr ?? "").trim().split("\n").slice(-2).join(" ")}`);
          else {
            say(`deploy check: the candidate's console answered /healthz on 127.0.0.1:${port} and listed the copy's tasks.`);
            outcome = { ok: true, facts: { from, to: result.to, tables: before.length } };
          }
        }
      }
    }
  } catch (error) {
    outcome = fail("rehearsal", String(error?.message ?? error));
  }
  // 4. Every process stopped and proven gone; the throwaway folder, the fences and the copy deleted. Anything left fails.
  const left = [];
  if (group !== null) {
    const running = await stopGroup(group, { ...(io.kill === undefined ? {} : { kill: io.kill }), ...(io.sleep === undefined ? {} : { sleep: io.sleep }) });
    if (running !== null) left.push(running);
  }
  left.push(...removeLeft(root, [world, join(root, "fence.sb"), join(root, "serve-fence.sb"), ...["", "-wal", "-shm", "-journal"].map(suffix => `${copy}${suffix}`)]));
  if (left.length > 0) return fail("cleanup", `${outcome.ok ? "" : `${outcome.step} failed (${outcome.why}), and `}what the rehearsal started or made isn't all gone: ${left.join("; ")}`);
  return outcome;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const copy = args.includes("--copy") ? args[args.indexOf("--copy") + 1] : undefined;
  if (typeof copy !== "string" || !copy.startsWith("/")) { console.error("usage: deploy-check.mjs [--build] --copy <the plane's copy of its database>"); process.exit(2); }
  chmodSync(dirname(copy), 0o700);
  if (args.includes("--build")) {
    const built = buildInFence({ checkout: process.cwd(), copy });
    if (!built.ok) { console.error(`Deploy check: the build failed: ${built.why}`); process.exit(1); }
    console.log("Deploy check: the release commit built inside the fence.");
  } else {
    const outcome = await rehearse({ checkout: process.cwd(), copy });
    if (!outcome.ok) { console.error(`Deploy check failed at ${outcome.step}: ${outcome.why}`); process.exit(1); }
    console.log(`Deploy check passed: schema ${outcome.facts.from} → ${outcome.facts.to}, ${outcome.facts.tables} tables kept, the console answered and read the tasks.`);
  }
}
