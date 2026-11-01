#!/usr/bin/env node
/**
 * Console page latency, idle and under a synthetic write load (docs/plans/isolated-checks.md, "Console responsiveness").
 *
 *   node scripts/console-responsiveness.mjs --bin <dist/bin.js> --db-copy <orders.db> [--label before|after]
 *        [--task <id>] [--idle-seconds 20] [--load-seconds 20] [--writes-per-second 40]
 *
 * A throwaway console (`toolroll serve`, unscoped: every project in the copy is visible, no worker, so nothing is built or
 * dispatched against the real repositories the copy names) on a COPY of the given database (sqlite3 .backup, read-only on the source), settled first (open
 * claims, runs, worktrees, runners and leases closed), under a temporary HOME. /board, /agents, /chat and one task page
 * are read in turn and each answer timed (with /healthz probed beside them every 25 ms: how long the request thread was
 * held): first idle, then while a separate process writes to the database as fast as a
 * busy worker would (small transactions: ledger rows and task touches, each moving the workspace revision as Toolroll's
 * own writes do), so every read sees a fresh database change.
 *
 * Everything runs inside sandbox-exec: no writes under the person's home, no network but localhost, no signals outside
 * this run. Never point it at a live database; it only ever opens the copy it made.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at === -1 ? fallback : args[at + 1]; };
const bin = resolve(option("--bin", join(here, "dist/bin.js")));
const label = option("--label", "run");
const dbCopy = option("--db-copy", null);
const idleSeconds = Number(option("--idle-seconds", "20"));
const loadSeconds = Number(option("--load-seconds", "20"));
const writesPerSecond = Number(option("--writes-per-second", "40"));
if (dbCopy === null) throw new Error("--db-copy <orders.db> is required");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const freePort = () => new Promise(done => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => done(port)); }); });

const root = realpathSync(mkdtempSync("/tmp/so-responsive-"));
const home = join(root, "home"), state = join(root, "state"), tmp = join(root, "tmp");
for (const dir of [home, state, tmp]) mkdirSync(dir, { recursive: true });
const db = join(state, "orders.db");
const owner = homedir();
const profile = `(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(owner)}))(deny network-outbound)` +
  `(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))(deny signal)(allow signal (target same-sandbox))`;
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TMPDIR: tmp, LANG: "en_US.UTF-8", NO_COLOR: "1",
  TOOLROLL_SECRET_STORE: "files", TOOLROLL_STORAGE_SWEEP: "off", TOOLROLL_NO_TASK_CLASSIFIER: "1", TOOLROLL_NO_PLAN_PROBE: "1", GIT_CONFIG_GLOBAL: "/dev/null",
};
const fenced = argv => ["/usr/bin/sandbox-exec", ["-p", profile, ...argv], { env }];

let up = null, writer = null;
try {
  execFileSync("sqlite3", [resolve(dbCopy), `.backup ${db}`]);
  const { hashToken } = await import(pathToFileURL(join(dirname(bin), "scope.js")).href);
  const password = `bench-${Math.random().toString(36).slice(2)}`;
  const copy = new DatabaseSync(db);
  const now = new Date().toISOString();
  copy.exec("BEGIN");
  copy.prepare("UPDATE claim SET released_at = ?, released_by = 'recovered' WHERE released_at IS NULL").run(now);
  copy.prepare("UPDATE run SET outcome = 'failed', reason = 'interrupted', finished_at = ? WHERE outcome IS NULL").run(now);
  copy.prepare("UPDATE worktree SET released_at = ? WHERE released_at IS NULL").run(now);
  copy.prepare("UPDATE runner SET retired_at = ? WHERE retired_at IS NULL").run(now);
  copy.prepare("UPDATE task SET state = 'queued' WHERE state = 'running'").run();
  for (const table of ["watch_lease", "console_instance", "backup_lease", "push_subscription"]) copy.exec(`DELETE FROM ${table}`);
  const account = String(copy.prepare("SELECT name FROM approver WHERE revoked_at IS NULL AND role = 'approver' ORDER BY added_at LIMIT 1").get().name);
  copy.prepare("UPDATE approver SET credential_hash = ? WHERE name = ?").run(hashToken(password), account);
  const task = option("--task", null) ?? String(copy.prepare(`SELECT t.id FROM task t JOIN task_ref r ON r.external_id = t.id JOIN run ON run.task_ref = r.id
    GROUP BY t.id ORDER BY COUNT(*) DESC LIMIT 1`).get().id);
  copy.exec("COMMIT");
  copy.close();

  const port = await freePort();
  const [file, rest, options] = fenced([process.execPath, bin, "serve", "--db", db, "--port", String(port), "--json"]);
  up = spawn(file, rest, { ...options, cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stdout = "", stderr = "";
  up.stdout.on("data", chunk => { stdout += chunk; });
  up.stderr.on("data", chunk => { stderr += chunk; });
  for (let i = 0; i < 600 && !stdout.includes("\"command\": \"serve\""); i++) { if (up.exitCode !== null) throw new Error(`up exited: ${stderr}`); await sleep(100); }
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: account, token: password }), redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (cookie === "") throw new Error(`sign-in failed (${login.status})`);

  const routes = { "/board": "/board", "/agents": "/agents", "task page": `/t/${encodeURIComponent(task)}`, "/chat": "/chat" };
  // Beside the page reads, /healthz every 25 ms: how long the console's request thread was held (it answers at once
  // unless something blocks the event loop).
  const sample = async until => {
    const times = Object.fromEntries([...Object.keys(routes), "/healthz (beside)"].map(name => [name, []]));
    let probing = true;
    const probe = (async () => {
      while (probing) {
        const started = performance.now();
        const answer = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(30_000) });
        await answer.arrayBuffer();
        times["/healthz (beside)"].push(performance.now() - started);
        await sleep(25);
      }
    })();
    while (!until()) {
      for (const [name, path] of Object.entries(routes)) {
        const started = performance.now();
        const answer = await fetch(base + path, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
        await answer.arrayBuffer();
        if (!answer.ok) throw new Error(`${name} answered ${answer.status}`);
        times[name].push(performance.now() - started);
      }
      await sleep(50);
    }
    probing = false;
    await probe;
    return times;
  };
  const summary = times => Object.fromEntries(Object.entries(times).map(([name, list]) => {
    const sorted = [...list].sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return [name, { n: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted.at(-1) ?? 0) }];
  }));

  // Let the worker's first reconcile settle, then read idle.
  await sleep(4000);
  const idleEnd = Date.now() + idleSeconds * 1000;
  const idle = summary(await sample(() => Date.now() > idleEnd));

  // The write load: a separate process, small transactions, as a busy worker writes.
  const writerScript = join(root, "writer.mjs");
  writeFileSync(writerScript, `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(db)}); db.exec("PRAGMA busy_timeout=5000");
const ids = db.prepare("SELECT id FROM task ORDER BY rowid DESC LIMIT 50").all().map(row => row.id);
const ledger = db.prepare("INSERT INTO action_ledger (at, actor, repo, task_id, run_id, action, outcome, source, detail) VALUES (?, 'bench', NULL, ?, NULL, 'bench write', 'ok', 'work', NULL)");
const touch = db.prepare("UPDATE task SET updated_at = ? WHERE id = ?");
// Toolroll's own connections move the workspace revision on every meaningful commit (workspace-revision.ts); so does this.
const bump = db.prepare("UPDATE service_cursor SET value = value + 1, updated_at = ? WHERE key = 'workspace-content:v1'");
let n = 0; const every = 1000 / ${writesPerSecond};
setInterval(() => { const at = new Date().toISOString(), id = ids[n++ % ids.length];
  db.exec("BEGIN IMMEDIATE"); ledger.run(at, id); touch.run(at, id); bump.run(at); db.exec("COMMIT"); }, every);
`);
  const [wfile, wrest, woptions] = fenced([process.execPath, writerScript]);
  writer = spawn(wfile, wrest, { ...woptions, stdio: ["ignore", "ignore", "pipe"], detached: true });
  await sleep(500);
  const loadEnd = Date.now() + loadSeconds * 1000;
  const load = summary(await sample(() => Date.now() > loadEnd || writer.exitCode !== null));
  if (writer.exitCode !== null) throw new Error("the writer stopped early");
  console.log(JSON.stringify({ label, bin, task, writesPerSecond, idle, load }, null, 2));
} finally {
  for (const child of [writer, up]) {
    if (child === null || child.exitCode !== null) continue;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; i < 400 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
