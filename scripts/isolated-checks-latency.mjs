#!/usr/bin/env node
/**
 * Console latency while the worker runs a heavy check (docs/plans/isolated-checks.md, stage 1 build notes).
 *
 *   node scripts/isolated-checks-latency.mjs --bin <dist/bin.js> [--label before|after] [--single-process]
 *        [--db-copy <orders.db>] [--check-seconds 30] [--idle-seconds 8]
 *
 * A throwaway Toolroll: a temporary HOME and state folder, the given database COPIED (sqlite3 .backup, read-only on
 * the source) or a fresh one, a scripted provider (scripts/fixtures/crash-process.mjs: no model call), and one task
 * whose approved check prints a test runner's output as fast as it can for --check-seconds. While it runs, /healthz,
 * /board and the task's page are read in turn and each answer timed; the same is done idle first.
 *
 * Everything runs inside sandbox-exec: no writes under the person's home, no network but localhost, and no signal to
 * any process outside this run — a database copy names real repositories, worktrees and processes, and none of them
 * may be touched. The copy is also settled first (open claims, runs, worktrees, runners and leases closed).
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const checkSeconds = Number(option("--check-seconds", "30"));
const idleSeconds = Number(option("--idle-seconds", "8"));
const single = args.includes("--single-process");
const keep = args.includes("--keep");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const freePort = () => new Promise(done => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => done(port)); }); });

const root = realpathSync(mkdtempSync("/tmp/so-latency-"));
const home = join(root, "home"), state = join(root, "state"), tools = join(root, "bin"), control = join(root, "control"), repo = join(root, "shop"), tmp = join(root, "tmp");
for (const dir of [home, state, tools, control, repo, tmp]) mkdirSync(dir, { recursive: true });
const db = join(state, "orders.db");
const owner = homedir();
// The fence every process of this run lives in (see the header).
const profile = `(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(owner)}))(deny network-outbound)` +
  `(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))(deny signal)(allow signal (target same-sandbox))`;
const gitBinary = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const env = {
  PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TMPDIR: tmp, LANG: "en_US.UTF-8", NO_COLOR: "1",
  SO_CRASH_CONTROL: control, TOOLROLL_SECRET_STORE: "files", TOOLROLL_STORAGE_SWEEP: "off", TOOLROLL_NO_TASK_CLASSIFIER: "1", TOOLROLL_NO_PLAN_PROBE: "1",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Bench", GIT_AUTHOR_EMAIL: "bench@example.invalid", GIT_COMMITTER_NAME: "Bench", GIT_COMMITTER_EMAIL: "bench@example.invalid",
};
const fenced = (argv, options = {}) => ["/usr/bin/sandbox-exec", ["-p", profile, ...argv], { env, ...options }];
const cli = (argv, ok = [0]) => {
  const [file, rest, options] = fenced([process.execPath, bin, ...argv, "--db", db, "--json"]);
  try { return JSON.parse(execFileSync(file, rest, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 })); }
  catch (error) { if (ok.includes(error.status)) return JSON.parse(error.stdout); throw new Error(`${argv.slice(0, 3).join(" ")}: ${error.stdout ?? ""}${error.stderr ?? ""}`.slice(0, 1500)); }
};

let up = null;
try {
  // The project and its heavy check: thousands of journey lines a second for checkSeconds, then a summary.
  writeFileSync(join(repo, "README.md"), "Latency bench.\n");
  writeFileSync(join(repo, "heavy-check.mjs"), `const end = Date.now() + ${checkSeconds * 1000}; let n = 0;
const burst = () => { let out = ""; for (let i = 0; i < 200; i++) { n++; out += "[flows]   1s  PASS  journey " + n + "\\n" + " ✓ src/part-" + n + ".test.ts (3 tests) 4ms\\n"; } process.stdout.write(out); };
const tick = () => { if (Date.now() < end) { burst(); setTimeout(tick, 2); } else { process.stdout.write("[flows] " + n + " passed, 0 failed, 0 skipped\\n"); } };
tick();\n`);
  const check = join(tools, "check");
  writeFileSync(check, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} heavy-check.mjs\n`); chmodSync(check, 0o755);
  const fixture = join(here, "scripts/fixtures/crash-process.mjs");
  const claude = join(tools, "claude");
  // The scripted provider: crash-process.mjs's builder (no model call). A build's live input (stream-json) carries the
  // brief as its first stdin frame; it is handed over as the prompt argument the fixture reads.
  writeFileSync(claude, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--input-format")) {
  const { createInterface } = await import("node:readline");
  const lines = createInterface({ input: process.stdin });
  const frame = await new Promise(done => lines.on("line", line => { if (line.trim() !== "") done(JSON.parse(line)); }));
  lines.close(); process.stdin.destroy();
  const content = frame.message?.content;
  const prompt = Array.isArray(content) ? content.map(one => one.text ?? "").join("\\n") : String(content ?? "");
  process.argv = [process.argv[0], process.argv[1], "-p", prompt];
}
process.env.SO_CRASH_KIND = "claude";
await import(${JSON.stringify(pathToFileURL(fixture).href)});
`); chmodSync(claude, 0o755);
  const acceptance = [{ id: "c1", statement: "The result file says recovered.", evidence: ["changed-path"] }, { id: "c2", statement: "The approved check passes.", evidence: ["check"] }];
  writeFileSync(join(control, "config.json"), JSON.stringify({ stage: "none", check, git: gitBinary, acceptance }));
  execFileSync(gitBinary, ["init", "-q", "-b", "main"], { cwd: repo, env });
  execFileSync(gitBinary, ["add", "."], { cwd: repo, env });
  execFileSync(gitBinary, ["commit", "-qm", "seed"], { cwd: repo, env });

  // The database: a settled copy (nothing in it still running, held or leased), or a fresh one.
  const password = `bench-${Math.random().toString(36).slice(2)}`;
  let account = "bench";
  if (dbCopy !== null) {
    execFileSync("sqlite3", [resolve(dbCopy), `.backup ${db}`]);
    const { hashToken } = await import(pathToFileURL(join(dirname(bin), "scope.js")).href);
    const copy = new DatabaseSync(db);
    const now = new Date().toISOString();
    copy.exec("BEGIN");
    copy.prepare("UPDATE claim SET released_at = ?, released_by = 'recovered' WHERE released_at IS NULL").run(now);
    copy.prepare("UPDATE run SET outcome = 'failed', reason = 'interrupted', finished_at = ? WHERE outcome IS NULL").run(now);
    copy.prepare("UPDATE worktree SET released_at = ? WHERE released_at IS NULL").run(now);
    copy.prepare("UPDATE runner SET retired_at = ? WHERE retired_at IS NULL").run(now);
    copy.prepare("UPDATE task SET state = 'queued' WHERE state = 'running'").run();
    for (const table of ["watch_lease", "console_instance", "backup_lease", "push_subscription"]) copy.exec(`DELETE FROM ${table}`);
    account = String(copy.prepare("SELECT name FROM approver WHERE revoked_at IS NULL AND role = 'approver' ORDER BY added_at LIMIT 1").get().name);
    copy.prepare("UPDATE approver SET credential_hash = ? WHERE name = ?").run(hashToken(password), account);
    copy.exec("COMMIT");
    copy.close();
  } else cli(["approver", "add", account, "--password", password]);
  const auth = ["--as", account, "--token", password];
  writeFileSync(join(state, "up-login.txt"), `${account} ${password}\n`, { mode: 0o600 });
  // Inside this run's fence no OS sandbox can be made for agents: this throwaway plane lets its scripted agent run in it.
  cli(["config", "unconfined-agents", "allow", ...auth]);
  for (const phase of ["plan", "build", "repair"]) cli(["config", "set", phase, "--provider", "claude", "--model", "fixture", ...auth]);
  cli(["verify", "set", "--repo", repo, "--command", check, "--timeout-seconds", "600", "--yes", ...auth]);
  cli(["task", "add", "Write result.txt containing recovered.", "--id", "latency-bench", "--repo", repo]);
  cli(["task", "scope", "latency-bench", "--goal", "Write the result and run the check.", "--acceptance", acceptance.map(c => `${c.statement}|${c.evidence.join(",")}`).join(";")]);

  const port = await freePort();
  const [file, rest, options] = fenced([process.execPath, bin, "up", "--db", db, "--repo", repo, "--runner", "latency-bench", "--port", String(port), "--json", "--no-open", "--as", account, ...(single ? ["--single-process"] : [])]);
  up = spawn(file, rest, { ...options, cwd: repo, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stdout = "", stderr = "";
  up.stdout.on("data", chunk => { stdout += chunk; });
  up.stderr.on("data", chunk => { stderr += chunk; });
  for (let i = 0; i < 600 && !stdout.includes("\"command\": \"up\""); i++) { if (up.exitCode !== null) throw new Error(`up exited: ${stderr}`); await sleep(100); }
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: account, token: password }), redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (cookie === "") throw new Error(`sign-in failed (${login.status})`);

  const routes = { "/healthz": `${base}/healthz`, "/board": `${base}/board`, "/t/latency-bench": `${base}/t/latency-bench` };
  const sample = async (until) => {
    const times = Object.fromEntries(Object.keys(routes).map(name => [name, []]));
    while (!until()) {
      for (const [name, url] of Object.entries(routes)) {
        const started = performance.now();
        const answer = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
        await answer.arrayBuffer();
        if (!answer.ok) throw new Error(`${name} answered ${answer.status}`);
        times[name].push(performance.now() - started);
      }
      await sleep(50);
    }
    return times;
  };
  const summary = times => Object.fromEntries(Object.entries(times).map(([name, list]) => {
    const sorted = [...list].sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return [name, { n: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted.at(-1) ?? 0) }];
  }));

  const idleEnd = Date.now() + idleSeconds * 1000;
  const idle = summary(await sample(() => Date.now() > idleEnd));

  const shown = cli(["task", "show", "latency-bench"]);
  cli(["task", "approve", "latency-bench", "--yes", "--digest", shown.scope.digest, ...auth]);
  const reader = new DatabaseSync(db, { readOnly: true });
  const progress = () => reader.prepare(`SELECT run_check.final AS final, run_check.line AS line FROM run_check JOIN run ON run.id = run_check.run JOIN task_ref ON task_ref.id = run.task_ref
    WHERE task_ref.external_id = 'latency-bench' AND run_check.snapshot IS NOT NULL ORDER BY run_check.run DESC LIMIT 1`).get();
  // Busy: from the approval until the attempt has finished (its build, its check and the check's last line).
  const finished = () => reader.prepare(`SELECT run.outcome AS outcome FROM run JOIN task_ref ON task_ref.id = run.task_ref
    WHERE task_ref.external_id = 'latency-bench' AND run.outcome IS NOT NULL LIMIT 1`).get() !== undefined;
  const approvedAt = Date.now();
  const busy = summary(await sample(() => finished() || up.exitCode !== null || Date.now() - approvedAt > (checkSeconds + 180) * 1000));
  if (!finished()) throw new Error(`the attempt never finished:\n${stderr.slice(-3000)}`);
  const busySeconds = Math.round((Date.now() - approvedAt) / 100) / 10;
  const final = progress();
  reader.close();
  const result = { label, mode: single ? "single-process" : "default", bin, database: dbCopy === null ? "fresh" : "copy", checkSeconds, busySeconds, idle, busy, finalLine: final?.line ?? null };
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (up !== null && up.exitCode === null) {
    try { process.kill(-up.pid, "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; i < 400 && up.exitCode === null; i++) await sleep(100);
    if (up.exitCode === null) { try { process.kill(-up.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
