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
import { pathToFileURL } from "node:url";
import { assertIsolated, isolatedEnvironment } from "./isolated-env.mjs";
import { openDeploymentDatabase, snapshot } from "./deploy-phases.mjs";

/** The person's folders a rehearsal must never read: Toolroll's own state and every agent's and tool's secrets. */
export const SECRET_FOLDERS = [".toolroll", ".standing-orders", ".config", ".ssh", ".gnupg", ".aws", ".claude", ".codex", ".gemini", ".docker", ".kube", ".netrc", ".npmrc",
  "Library/Keychains", "Library/Application Support/toolroll", "Library/Application Support/Toolroll", "Library/LaunchAgents"];

const sbString = value => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The Seatbelt profile every candidate process of the rehearsal runs under: no network but this computer's loopback,
 * no write outside `root` (and the null and terminal devices), and none of the person's secret folders readable.
 * Accident-proofing for a person-approved candidate, never a sandbox against hostile code (AGENTS.md).
 */
export function fenceProfile({ root, home = homedir() }) {
  const realRoot = realpathSync(root);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(allow network-bind (local ip \"localhost:*\"))",
    "(allow network-inbound (local ip \"localhost:*\"))",
    "(allow network-outbound (remote ip \"localhost:*\"))",
    // A Unix socket a process makes for itself inside the throwaway folder (Node's own IPC).
    `(allow network* (local unix-socket (subpath ${sbString(realRoot)})) (remote unix-socket (subpath ${sbString(realRoot)})))`,
    "(deny file-write*)",
    `(allow file-write* (subpath ${sbString(realRoot)}) (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/") (literal "/dev/dtracehelper"))`,
    `(deny file-read* ${SECRET_FOLDERS.map(one => `(subpath ${sbString(join(home, one))})`).join(" ")})`,
    "",
  ].join("\n");
}

/** argv inside the fence: sandbox-exec on macOS. Null elsewhere (the deploy check is a Mac's own check). */
export function fenced(platform, profileFile, argv) {
  return platform === "darwin" ? ["/usr/bin/sandbox-exec", "-f", profileFile, ...argv] : null;
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

/**
 * The rehearsal. `io` (tests): `platform`, `spawnSync`, `spawn`, `fetch`, `home`. Returns `{ ok: true, facts }` or
 * `{ ok: false, step, why }`; the throwaway folder and the copy are gone either way.
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
  try {
    mkdirSync(world, { recursive: true, mode: 0o700 });
    // A throwaway computer built from nothing, checked before every spawn: nothing of the person's reaches it.
    const made = isolatedEnvironment({ root: world, owner: root, set: { TOOLROLL_DB: copy, TOOLROLL_NO_PLAN_PROBE: "1", TOOLROLL_NO_TASK_CLASSIFIER: "1" } });
    const env = made.env;
    // Throws, naming every problem, when anything of the person's would reach the child (assertIsolated).
    const checked = () => { assertIsolated(env, { root, homes: [realpathSync(home)] }); return env; };
    const profile = join(root, "fence.sb");
    writeFileSync(profile, fenceProfile({ root, home }), { mode: 0o600 });
    const inFence = argv => {
      const wrapped = fenced(platform, profile, argv);
      if (wrapped === null) throw new Error(`the deploy check's fence needs macOS (sandbox-exec); this is ${platform}`);
      return wrapped;
    };
    // 1. The candidate's store on the copy.
    let before, from;
    { const db = openDeploymentDatabase(copy, { readOnly: true }); try { before = snapshot(db); from = db.prepare("SELECT version FROM schema_version").get()?.version; } finally { db.close(); } }
    const [cmd, ...args] = inFence([process.execPath, "--input-type=module", "-e", MIGRATE_SCRIPT, "--", dist, copy]);
    const migrated = run(cmd, args, { cwd: world, env: checked(), encoding: "utf8", timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    if (migrated.status !== 0) return fail("upgrade", `the candidate couldn't open the copy (exit ${migrated.status}): ${String(migrated.stderr ?? "").trim().split("\n").slice(-3).join(" ")}`);
    let result = null;
    try { result = JSON.parse(String(migrated.stdout).trim().split("\n").at(-1)); } catch { result = null; }
    let after;
    { const db = openDeploymentDatabase(copy, { readOnly: true }); try { after = snapshot(db); } finally { db.close(); } }
    const problem = migrationProblem(result, { before, after });
    if (problem !== null) return fail("upgrade", problem);
    say(`deploy check: the candidate upgraded a copy of this computer's database from schema ${from} to ${result.to}, history kept (${before.length} tables).`);
    // 2. The candidate's console on the copy, nothing else started.
    const [serveCmd, ...serveArgs] = inFence([process.execPath, join(dist, "bin.js"), "serve", "--rehearsal", "--port", "0", "--json"]);
    const child = start(serveCmd, serveArgs, { cwd: world, env: checked(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    group = child.pid ?? null;
    let errors = "";
    child.stderr?.on("data", chunk => { errors = (errors + String(chunk)).slice(-4000); });
    const envelope = await firstEnvelope(child, 60_000);
    if (envelope?.ok !== true || !Number.isInteger(envelope.port)) return fail("start", `the candidate's console didn't start on the copy: ${(errors.trim().split("\n").slice(-3).join(" ")) || "no answer within a minute"}`);
    // 3. It answers, and reads tasks.
    const health = await get(`http://127.0.0.1:${envelope.port}/healthz`, { signal: AbortSignal.timeout(15_000) });
    if (health.status !== 200) return fail("health", `/healthz answered ${health.status}`);
    const [listCmd, ...listArgs] = inFence([process.execPath, join(dist, "bin.js"), "task", "list", "--json"]);
    const listed = run(listCmd, listArgs, { cwd: world, env: checked(), encoding: "utf8", timeout: 2 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    let tasks = null;
    try { tasks = JSON.parse(String(listed.stdout)); } catch { tasks = null; }
    if (listed.status !== 0 || tasks?.ok !== true) return fail("tasks", `the candidate couldn't list the copy's tasks (exit ${listed.status}): ${String(listed.stderr ?? "").trim().split("\n").slice(-2).join(" ")}`);
    say(`deploy check: the candidate's console answered /healthz on 127.0.0.1:${envelope.port} and listed the copy's tasks.`);
    return { ok: true, facts: { from, to: result.to, tables: before.length } };
  } catch (error) {
    return fail("rehearsal", String(error?.message ?? error));
  } finally {
    // 4. Every process stopped and proven gone; the throwaway folder and the copy deleted.
    if (group !== null) {
      const left = await stopGroup(group, io.kill === undefined ? {} : { kill: io.kill });
      if (left !== null) say(`deploy check: ${left}`);
    }
    rmSync(world, { recursive: true, force: true });
    rmSync(join(root, "fence.sb"), { force: true });
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${copy}${suffix}`, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const copy = args.includes("--copy") ? args[args.indexOf("--copy") + 1] : undefined;
  if (typeof copy !== "string" || !copy.startsWith("/")) { console.error("usage: deploy-check.mjs --copy <the plane's copy of its database>"); process.exit(2); }
  chmodSync(dirname(copy), 0o700);
  const outcome = await rehearse({ checkout: process.cwd(), copy });
  if (!outcome.ok) { console.error(`Deploy check failed at ${outcome.step}: ${outcome.why}`); process.exit(1); }
  console.log(`Deploy check passed: schema ${outcome.facts.from} → ${outcome.facts.to}, ${outcome.facts.tables} tables kept, the console answered and read the tasks.`);
}
