#!/usr/bin/env node
/**
 * The upgrade path, a release-check step. For each of the last three published
 * releases: install it from npm into a temporary home, give it a realistic
 * database made by that release's own code (completed tasks, a finished run
 * that left a process record with no pid, and a completed release candidate),
 * then move it to this candidate three ways:
 *
 *   - the deploy's facts check: the candidate's assignment code over the
 *     installed release's store and database, before any migration, exactly
 *     as scripts/deploy-browser.mjs proves a candidate;
 *   - `toolroll update`: the candidate's own updater resumes an update staged
 *     with the packed candidate (the registry's provenance check is the one
 *     step it cannot run: the candidate is not published), then the switched
 *     `toolroll` command opens the database;
 *   - `npm i -g`: the packed candidate installed over the release, then its
 *     `toolroll status` opens the database.
 *
 * A release with a coding workspace first opens its own coding catalog in a
 * process that is then killed, as launchd kills a service that outlasts its
 * exit window: the candidate's deploy check must release that stale owner
 * record before `toolroll update` (deploys over 0.9.11, Oct 2). 0.9.11 stays
 * on the path whatever the newest three are.
 *
 * Each must succeed with no manual step. Afterwards every completed task is
 * still complete with the same digest, every table a fresh candidate database
 * has exists, and (after `toolroll update`) the leftover record is settled.
 *
 * The rollback leg (releases from ROLLBACK_FROM on): the candidate writes text
 * only its raised limits allow (an 8,000-character goal and a 4,000-character
 * steering note), then the release's own code opens the database and reads it
 * back whole, and the release's `toolroll status` opens it: reading never
 * re-validates a text's length, so going back a version still works.
 *
 *   node scripts/upgrade-path.mjs [--candidate <checkout with dist>] [--versions 0.9.9,0.9.10,0.9.11] [--keep]
 *
 * Needs npm and the registry (reads only). A published release never changes, so
 * each is installed from npm once into a cache (TOOLROLL_UPGRADE_CACHE, or
 * ~/.cache/toolroll-upgrade-path) and copied into every home after. Exits 1
 * when any version fails.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const load = (dist, name) => import(pathToFileURL(join(dist, name)).href);
/** How long one `toolroll update` may take before it counts as stuck. */
const UPDATE_LIMIT_MS = 6 * 60_000;
const NOW = () => new Date();

/** The newest `count` published versions, oldest first. */
export function lastPublished(versions, count = 3) {
  const release = versions.filter(v => /^\d+\.\d+\.\d+$/.test(v));
  const key = v => v.split(".").map(Number);
  release.sort((a, b) => { const [x, y] = [key(a), key(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
  return release.slice(-count);
}

/** The oldest release the rollback leg runs on: the ones a person may go back to from raised text limits (Oct 4). */
export const ROLLBACK_FROM = "0.9.23";
/** Whether `version` is at or after `from`. */
export function atLeast(version, from) {
  const [a, b] = [version, from].map(v => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
/** The texts the candidate writes for the rollback leg: as long as its limits allow. */
export const LONG_TEXT = Object.freeze({ goal: 8_000, note: 4_000 });

/** Releases always on the path. 0.9.11's service could be killed before it released the coding workspace (Oct 2). */
export const PINNED_RELEASES = Object.freeze(["0.9.11"]);

/** The newest `count` published versions and every pinned one, oldest first. */
export function upgradeVersions(published, count = 3) {
  return lastPublished([...new Set([...lastPublished(published, count), ...PINNED_RELEASES])], Infinity);
}

/** Tables a fresh database has that `actual` lacks. */
export function missingTables(fresh, actual) {
  const have = new Set(actual);
  return fresh.filter(name => !have.has(name));
}

/** What the completed tasks must still say after the update: each still complete, under the same digest. */
export function completionProblems(expected, after) {
  const problems = [];
  for (const one of expected) {
    const now = after[one.task];
    if (!now) problems.push(`${one.task} is gone`);
    else if (now.state !== "complete") problems.push(`${one.task} is ${now.state}, not complete${now.error ? ` (${now.error})` : ""}`);
    else if (now.digest !== one.digest) problems.push(`${one.task}'s completed result changed digest (${String(one.digest).slice(0, 12)} → ${String(now.digest).slice(0, 12)})`);
  }
  return problems;
}

const sh = (command, argv, options = {}) => spawnSync(command, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
const tail = text => String(text ?? "").trim().split("\n").slice(-12).join("\n");
function must(result, what) {
  if (result.error || result.status !== 0) throw Error(`${what} failed (${result.error?.message ?? `exit ${result.status}${result.signal ? `, ${result.signal}` : ""}`}):\n${tail(result.stderr)}\n${tail(result.stdout)}`);
  return result.stdout;
}
/** A child of this script in one mode, under a home, returning its one JSON line. */
function child(mode, payload, env, what, timeout = 600_000) {
  const out = must(sh(process.execPath, ["--no-warnings", SELF, `--${mode}`, JSON.stringify(payload)], { env, timeout }), what);
  const line = out.trim().split("\n").filter(Boolean).at(-1);
  return JSON.parse(line ?? "null");
}

// ---- children: each runs one release's code, never two in one process -----

/** The installed release's own code makes the database a person would have. */
async function seed({ dist, stateDir, repo }) {
  const [{ openStore }, { register }, { addApprover, approve, propose }, { storeEvidence }, { sealVerificationReceipt }, { assignmentOf, checkAssignmentAsOperator }, { verifyApproverByPassword }] =
    await Promise.all(["store.js", "runner.js", "scope.js", "evidence.js", "verification-evidence.js", "assignment.js", "principal.js"].map(name => load(dist, name)));
  const git = (...argv) => execFileSync("git", argv, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "app.txt"), "v1\n");
  git("add", "."); git("commit", "-q", "-m", "first");
  const head = git("rev-parse", "HEAD");
  const databaseFile = join(stateDir, "orders.db"), root = join(stateDir, "evidence");
  const store = openStore(databaseFile);
  const at = minutes => new Date(Date.now() - minutes * 60_000);
  try {
    register(store, { name: "builder-1", host: hostname(), capacity: 2, repos: [repo], now: at(600), newToken: () => "tok-builder-1" });
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "upgrade path", at(600));
    const sam = addApprover(store, "sam", at(600));
    if (!sam.ok) throw Error("approver");
    store.setVerifyCommand({ repo, command: "test -f app.txt", timeoutMs: 60_000, approvedBy: "sam" }, at(600));
    const who = verifyApproverByPassword(store, "sam", sam.token, [repo]);
    if (!who.ok) throw Error("approver password");
    const built = (id, title, minutes, worktree) => {
      const when = at(minutes);
      store.createTask({ id, title }, when);
      const ref = store.refFor("built-in", id).id;
      store.placeTask(ref, repo, {}, when);
      const proposed = propose(store, { taskId: id, goal: title, touches: ["src/"], acceptance: [{ id: "c1", statement: title, how: null, evidence: ["manual-review"] }], now: when });
      const ok = approve(store, id, "sam", when, proposed.digest, sam.token);
      if (!ok.ok) throw Error(ok.reason);
      const authority = store.routeAuthorityFor(ref, "builder");
      if (!authority?.ok) throw Error("route");
      const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree, route: authority.stamp, now: when });
      store.stampRun(run, { scopeDigest: store.getScope(id).digest, baseRevision: head });
      store.recordOutcomeFacts(run, { headRevision: head, handoff: `${title}.` });
      store.finishRun(run, { outcome: "built", committed: true, now: when });
      store.setTaskState(id, "done", when);
      store.saveProofVerdict(run, "attested", [], when, [{ id: "c1", statement: title, requiredEvidence: ["manual-review"], state: "manual-review", detail: [], answered: [], review: null }], "attested");
      storeEvidence(store, root, run, "terminal-diff", "diff.patch", Buffer.from(`diff --git a/src/${id}.ts b/src/${id}.ts\n--- a/src/${id}.ts\n+++ b/src/${id}.ts\n@@ -1 +1 @@\n-a\n+b\n`), "git diff (exit 0)", when, { captureStatus: "ok" });
      storeEvidence(store, root, run, "diff-stat", "diff-stat.json", Buffer.from(JSON.stringify({ schema: 1, head, base: head, filesTruncated: false, fileCount: 1, files: [{ path: `src/${id}.ts` }] })), "git diff --numstat", when, { captureStatus: "ok" });
      const command = store.liveVerifyCommand(repo);
      storeEvidence(store, root, run, "check-log", "checks.txt", Buffer.from("41 passed\n"), command.command, when, { captureStatus: "ok" });
      sealVerificationReceipt(store, root, run, head, command, { configured: true, ran: true, exitCode: 0 }, when);
      store.recordRunCheck(run, { status: "passed", exitCode: 0, suites: [] }, when);
      return run;
    };
    const complete = id => {
      const before = assignmentOf(store, id, NOW(), { principal: "operator", repos: null, includeUnplaced: true }, root);
      if (before?.receipt == null) throw Error(`${id} has no result to complete (${before?.state})`);
      const done = checkAssignmentAsOperator(store, id, before.receipt.digest, who.who, NOW(), root);
      if (!done.ok) throw Error(`${id} could not be completed: ${JSON.stringify(done)}`);
      const after = assignmentOf(store, id, NOW(), { principal: "operator", repos: null, includeUnplaced: true }, root);
      if (after?.state !== "complete") throw Error(`${id} is ${after?.state} after completion`);
      return { task: id, digest: after.completion.digest };
    };
    const completed = [];
    built("ship-login", "Ship the login page", 300, join(repo, "..", "pool", "ship-login"));
    completed.push(complete("ship-login"));
    built("fix-totals", "Fix the cart totals", 240, join(repo, "..", "pool", "fix-totals"));
    completed.push(complete("fix-totals"));
    // The release candidate: built in the project checkout itself, checked, and marked complete.
    const candidateRun = built("release-candidate", "Release the next version", 120, repo);
    completed.push(complete("release-candidate"));
    // A finished release check whose agent ran and exited, then whose check spawn was refused (out of memory): a
    // process record with no pid. Raw rows, as that release's spawn left them.
    const checkRun = built("release-check", "Run the release check", 60, join(repo, "..", "pool", "release-check"));
    const exited = spawnSync("true").pid;
    const iso = at(59).toISOString();
    store.handle.prepare("INSERT INTO run_process (run,pid,host,process_group,observed_at,exited_at) VALUES (?,?,?,1,?,?)").run(checkRun, exited, hostname(), iso, at(58).toISOString());
    store.handle.prepare("INSERT INTO run_process (run,pid,host,process_group,observed_at) VALUES (?,NULL,?,1,?)").run(checkRun, hostname(), iso);
    return { databaseFile, evidenceRoot: root, repo, head, candidateRun, leftoverRun: checkRun, completed };
  } finally { store.close(); }
}

/** scripts/deploy-browser.mjs's facts(): the candidate's code over the installed release's store, before migration. */
async function facts({ installed, candidate, databaseFile, evidenceRoot, runId, head }) {
  const { DatabaseSync } = await import("node:sqlite");
  const oldStore = await load(installed, "store.js"), oldEvidence = await load(installed, "verification-evidence.js");
  const candidateAssignment = await load(join(candidate, "dist"), "assignment.js");
  const { deploymentCandidate } = await import(pathToFileURL(join(candidate, "scripts", "deploy-candidate.mjs")).href);
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const result = deploymentCandidate(new oldStore.Store(db), { runId, head, evidenceRoot, now: NOW() }, {
      assignmentOf: candidateAssignment.assignmentOf, verificationEvidence: oldEvidence.verificationEvidence,
    });
    return { ok: true, completion: result.completion.digest };
  } finally { db.close(); }
}

/** Record an update to the candidate as `toolroll update` would, with the packed candidate staged as its runtime. */
async function stage({ candidateDist, stateDir, databaseFile, from, version, tarball }) {
  const update = await load(candidateDist, "toolroll-update.js");
  const { durableJson } = await load(candidateDist, "desktop-update.js");
  // A candidate not yet bumped past the newest release still replaces that release's bytes: the same version is allowed.
  const j = update.prepareRuntimeUpdate({ stateDir, databaseFile, current: from, actor: "upgrade-path", version, when: "when-idle", at: null, allowDowngrade: from.version === version }, NOW());
  if ("refused" in j) throw Error(j.refused);
  const runtime = join(j.stageDir, "runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "toolroll-runtime", private: true, dependencies: { toolroll: `file:${tarball}` } }));
  must(sh("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-color"], { cwd: runtime }), "npm install of the packed candidate");
  j.to.dist = join(runtime, "node_modules", "toolroll", "dist");
  // Verified, as far as a candidate that is not on the registry can be: the next step is the updater's own.
  const at = NOW().toISOString();
  j.steps.push({ phase: "verifying", at });
  j.phase = "verifying"; j.detail = "The packed candidate is staged.";
  j.steps.push({ phase: "draining", at });
  j.phase = "draining"; j.updatedAt = at;
  durableJson(join(j.stageDir, "update.json"), j);
  durableJson(join(stateDir, "toolroll-update.json"), j);
  return { id: j.id, to: j.to.dist };
}

/** The installed release opens its own coding catalog and holds it until this process is killed. */
async function hold({ dist, databaseFile }) {
  const { CodingWorkspace } = await load(dist, "coding-workspace.js");
  new CodingWorkspace({ database: `${databaseFile}.coding.sqlite`, worktreeRoot: join(dirname(databaseFile), "coding-worktrees") });
  process.stdout.write(`\n${JSON.stringify({ held: process.pid })}\n`);
  setInterval(() => {}, 1 << 30);
  return new Promise(() => {});
}

/** The candidate's deploy check over the killed release's catalog: refused as it stands, released once the killed
 * process is proved gone, then the ordinary shutdown check passes. */
async function release({ candidate, candidateDist, databaseFile, pid }) {
  const { DatabaseSync } = await import("node:sqlite");
  const coding = await load(candidateDist, "coding-update.js");
  const { releaseStaleCodingDeployment } = await import(pathToFileURL(join(candidate, "scripts", "deploy-coding.mjs")).href);
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    let refused = false;
    try { coding.assertCodingUpdateStopped(db); } catch { refused = true; }
    if (!refused) throw Error("the killed release left no owner record behind, so there was nothing stale to release");
    const released = releaseStaleCodingDeployment(coding, databaseFile, db, [pid], {});
    if (released?.pid !== pid) throw Error(`the stale owner record was not released (${JSON.stringify(released)})`);
    coding.assertCodingUpdateStopped(db);
    return { released };
  } finally { db.close(); }
}

/** Start `hold` under the release, then kill it the way launchd does past its exit window, and wait for the exit. */
async function killedCodingOwner(payload, env) {
  const held = spawn(process.execPath, ["--no-warnings", SELF, "--hold", JSON.stringify(payload)], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(done => held.once("exit", done));
  let out = "", err = "";
  held.stderr.on("data", chunk => { err += chunk; });
  const pid = await new Promise((ready, failed) => {
    const timer = setTimeout(() => failed(Error("the release's coding workspace did not open within a minute")), 60_000);
    held.stdout.on("data", chunk => { out += chunk; const found = /\{"held":(\d+)\}/.exec(out); if (found) { clearTimeout(timer); ready(Number(found[1])); } });
    held.once("exit", code => { clearTimeout(timer); failed(Error(`the release's coding workspace did not open (exit ${code}):\n${tail(err)}`)); });
  }).catch(async error => { held.kill("SIGKILL"); await exited; throw error; });
  held.kill("SIGKILL");
  await exited;
  return pid;
}

/** Read the database the way the candidate shows it: completed tasks, tables, and the leftover record. */
async function inspect({ candidateDist, databaseFile, evidenceRoot, completed, leftoverRun }) {
  const { DatabaseSync } = await import("node:sqlite");
  const { openStore, openStoreReadOnly } = await load(candidateDist, "store.js");
  const { assignmentOf } = await load(candidateDist, "assignment.js");
  const fresh = join(mkdtempSync(join(tmpdir(), "upgrade-fresh-")), "fresh.db");
  openStore(fresh).close();
  const tables = file => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name)); } finally { db.close(); } };
  const missing = missingTables(tables(fresh), tables(databaseFile));
  rmSync(dirname(fresh), { recursive: true, force: true });
  const store = openStoreReadOnly(databaseFile);
  try {
    const after = {};
    for (const one of completed) {
      try {
        const a = assignmentOf(store, one.task, NOW(), { principal: "operator", repos: null, includeUnplaced: true }, evidenceRoot);
        after[one.task] = { state: a?.state ?? "missing", digest: a?.completion?.digest ?? null };
      } catch (error) { after[one.task] = { state: "unreadable", digest: null, error: String(error?.message ?? error).slice(0, 200) }; }
    }
    const open = Number(store.handle.prepare("SELECT count(*) n FROM run_process WHERE run = ? AND exited_at IS NULL").get(leftoverRun).n);
    return { missing, after, leftoverOpen: open };
  } finally { store.close(); }
}

/** The candidate writes a task whose goal and steering note only its raised limits allow. */
async function longText({ candidateDist, databaseFile, repo }) {
  const [{ openStore }, { propose }, { validateTaskText }] = await Promise.all(["store.js", "scope.js", "task-text.js"].map(name => load(candidateDist, name)));
  const goal = `Keep every detail of this goal. ${"The checkout keeps each line item's rounding. ".repeat(400)}`.slice(0, LONG_TEXT.goal);
  const note = `Steer: ${"try the parser fix first, then the totals. ".repeat(200)}`.slice(0, LONG_TEXT.note).trim();
  const refused = validateTaskText({ title: "Long goal", goal });
  if (refused !== null) throw Error(`the candidate refused an ${LONG_TEXT.goal}-character goal: ${refused.message}`);
  const store = openStore(databaseFile);
  try {
    const id = "long-goal", now = NOW();
    store.createTask({ id, title: "Long goal" }, now);
    store.placeTask(store.refFor("built-in", id).id, repo, {}, now);
    propose(store, { taskId: id, goal, touches: [], acceptance: [{ id: "c1", statement: "Every detail is kept", how: null, evidence: ["manual-review"] }], now });
    const filed = store.fileSteerNote(id, "sam", note, now);
    if (!filed.ok) throw Error(`the candidate refused a ${note.length}-character steering note: ${filed.problem ?? filed.reason}`);
    return { task: id, goal: goal.length, note: note.length };
  } finally { store.close(); }
}

/** The release's own code reads what the candidate wrote, whole. */
async function rollback({ dist, databaseFile, task }) {
  const { openStore } = await load(dist, "store.js");
  const store = openStore(databaseFile);
  try {
    const goal = store.getScope(task)?.goal ?? "";
    const ref = store.lookupRef(task);
    const notes = ref === null ? [] : store.listSteerNotes(ref.id);
    return { goal: goal.length, note: Math.max(0, ...notes.map(one => String(one.note ?? "").length)) };
  } finally { store.close(); }
}

// ---- the parent: one temporary home per published release ------------------

/** Pack the candidate checkout's built package once. */
function pack(candidate, into) {
  const out = must(sh("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", into], { cwd: candidate }), "npm pack of the candidate");
  return join(into, JSON.parse(out)[0].filename);
}

/** node and npm alone, so the updater switches only the commands this home installed (node's own folder may hold a
 * `toolroll` of this machine's). */
function toolsDir(work) {
  const tools = join(work, "tools");
  if (existsSync(tools)) return tools;
  mkdirSync(tools);
  const npm = sh("/bin/sh", ["-c", "command -v npm"]).stdout.trim();
  if (!npm) throw Error("npm is not on PATH.");
  symlinkSync(process.execPath, join(tools, "node"));
  symlinkSync(realpathSync(npm), join(tools, "npm"));
  return tools;
}
function envFor(home, prefix) {
  return { ...process.env, HOME: home, PATH: [join(prefix, "bin"), toolsDir(dirname(home)), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TOOLROLL_NO_UPDATE_CHECK: "1", npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
}

/** Where each published release is installed once: `<cache>/<version>` is a whole npm global prefix. */
const CACHE = process.env.TOOLROLL_UPGRADE_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "toolroll-upgrade-path");
/** `toolroll@version` installed globally under `prefix`: from the cache, or from npm into the cache first. Says which. */
export function installPublished(version, prefix, env, { cache = CACHE, install = (into) => must(sh("npm", ["install", "--global", "--prefix", into, `toolroll@${version}`, "--no-audit", "--no-fund", "--no-color"], { env }), `npm install -g toolroll@${version}`) } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error(`${version} is not a release version.`);
  const kept = join(cache, version), whole = join(kept, ".complete");
  const cached = existsSync(whole);
  if (!cached) {
    mkdirSync(cache, { recursive: true });
    // Whole or not at all: installed aside, then renamed into place. An interrupted one is installed again.
    if (existsSync(kept) && !existsSync(whole)) rmSync(kept, { recursive: true, force: true });
    const part = mkdtempSync(join(cache, `${version}.part-`));
    try {
      install(part);
      writeFileSync(join(part, ".complete"), version);
      try { renameSync(part, kept); } catch (error) { if (!existsSync(whole)) throw error; }
    } finally { rmSync(part, { recursive: true, force: true }); }
  }
  // npm links global commands relatively, so the copy runs from where it lands. On APFS a clone is the quick copy.
  if (existsSync(prefix)) throw Error(`${prefix} already exists.`);
  const cloned = process.platform === "darwin" && sh("cp", ["-cR", kept, prefix]).status === 0;
  if (!cloned) { rmSync(prefix, { recursive: true, force: true }); cpSync(kept, prefix, { recursive: true, verbatimSymlinks: true }); }
  rmSync(join(prefix, ".complete"), { force: true });
  return cached ? "cached" : "installed";
}

async function onePath(version, { candidate, candidateDist, candidateVersion, tarball, work }) {
  const home = join(work, `home-${version}`);
  const prefix = join(home, "global"), stateDir = join(home, ".toolroll");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const env = envFor(home, prefix);
  const steps = [];
  const step = (name, fn) => { const at = Date.now(); try { const value = fn(); steps.push(`${name} (${Math.round((Date.now() - at) / 1000)} s)`); return value; } catch (error) { throw Object.assign(error, { step: name }); } };
  step("npm i -g", () => installPublished(version, prefix, env));
  const installed = realpathSync(join(prefix, "lib", "node_modules", "toolroll", "dist"));
  const seeded = step("database", () => child("seed", { dist: installed, stateDir, repo: join(home, "projects", "shop") }, env, `${version}'s database`));
  if (existsSync(join(installed, "coding-workspace.js"))) {
    const at = Date.now();
    try {
      const pid = await killedCodingOwner({ dist: installed, databaseFile: seeded.databaseFile }, env);
      child("release", { candidate, candidateDist, databaseFile: seeded.databaseFile, pid }, env, "releasing the killed release's coding owner record");
    } catch (error) { throw Object.assign(error, { step: "stale coding owner" }); }
    steps.push(`stale coding owner released (${Math.round((Date.now() - at) / 1000)} s)`);
  }
  // The same database and installation, kept apart for the npm route.
  const npmHome = join(work, `home-${version}-npm`), npmPrefix = join(npmHome, "global"), npmState = join(npmHome, ".toolroll");
  cpSync(home, npmHome, { recursive: true, verbatimSymlinks: true });
  step("facts check", () => child("facts", { installed, candidate, databaseFile: seeded.databaseFile, evidenceRoot: seeded.evidenceRoot, runId: seeded.candidateRun, head: seeded.head }, env, "the deploy's facts check (the candidate's code over the installed store)"));

  // toolroll update, by the candidate's own updater, then the switched command opens the database.
  const staged = step("stage", () => child("stage", { candidateDist, stateDir, databaseFile: seeded.databaseFile, from: { version, dist: installed }, version: candidateVersion, tarball }, env, "staging the update"));
  step("toolroll update", () => {
    const result = sh(process.execPath, [join(candidateDist, "bin.js"), "update", "--resume", "--db", seeded.databaseFile], { env, timeout: UPDATE_LIMIT_MS });
    if (result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT") throw Error(`toolroll update was still waiting after ${UPDATE_LIMIT_MS / 60_000} minutes:\n${tail(result.stdout)}\n${tail(readJournalDetail(stateDir))}`);
    must(result, "toolroll update");
    const j = JSON.parse(readFileSync(join(stateDir, "toolroll-update.json"), "utf8"));
    if (j.id !== staged.id || j.phase !== "complete") throw Error(`toolroll update ended ${j.phase}: ${j.detail}`);
  });
  step("toolroll status (updated)", () => {
    const linked = realpathSync(join(prefix, "bin", "toolroll"));
    if (linked !== realpathSync(join(staged.to, "bin.js"))) throw Error(`toolroll still runs ${linked}`);
    must(sh(join(prefix, "bin", "toolroll"), ["status", "--db", seeded.databaseFile], { env, timeout: 120_000 }), "toolroll status after the update");
  });
  const updated = step("inspect (updated)", () => child("inspect", { candidateDist: staged.to, databaseFile: seeded.databaseFile, evidenceRoot: seeded.evidenceRoot, completed: seeded.completed, leftoverRun: seeded.leftoverRun }, env, "reading the updated database"));
  const problems = [...completionProblems(seeded.completed, updated.after), ...updated.missing.map(name => `table ${name} was not created`)];
  if (updated.leftoverOpen !== 0) problems.push(`run #${seeded.leftoverRun}'s leftover record was not settled`);
  if (problems.length > 0) throw Object.assign(Error(`after toolroll update: ${problems.join("; ")}`), { step: "inspect (updated)" });

  // Back a version: the candidate writes text only its raised limits allow, then the release reads it whole.
  if (atLeast(version, ROLLBACK_FROM)) {
    const wrote = step("long text (candidate)", () => child("longText", { candidateDist: staged.to, databaseFile: seeded.databaseFile, repo: seeded.repo }, env, "the candidate writing long text"));
    const read = step("rollback read", () => child("rollback", { dist: installed, databaseFile: seeded.databaseFile, task: wrote.task }, env, `${version} reading the candidate's long text`));
    if (read.goal !== wrote.goal || read.note !== wrote.note) throw Object.assign(Error(`${version} read a ${read.goal}-character goal and a ${read.note}-character note; the candidate wrote ${wrote.goal} and ${wrote.note}`), { step: "rollback read" });
    step("toolroll status (rollback)", () => must(sh(process.execPath, [join(installed, "bin.js"), "status", "--db", seeded.databaseFile], { env, timeout: 120_000 }), `${version}'s toolroll status over the candidate's database`));
  }

  // npm i -g over the same release and database, then its toolroll status opens the database.
  const npmDatabase = join(npmState, "orders.db");
  const npmEnv = envFor(npmHome, npmPrefix);
  step("npm i -g candidate", () => must(sh("npm", ["install", "--global", "--prefix", npmPrefix, tarball, "--no-audit", "--no-fund", "--no-color"], { env: npmEnv }), "npm install -g of the candidate"));
  step("toolroll status (npm)", () => must(sh(join(npmPrefix, "bin", "toolroll"), ["status", "--db", npmDatabase], { env: npmEnv, timeout: 120_000 }), "toolroll status after npm i -g"));
  const npmDist = realpathSync(join(npmPrefix, "lib", "node_modules", "toolroll", "dist"));
  const viaNpm = step("inspect (npm)", () => child("inspect", { candidateDist: npmDist, databaseFile: npmDatabase, evidenceRoot: join(npmState, "evidence"), completed: seeded.completed, leftoverRun: seeded.leftoverRun }, npmEnv, "reading the database after npm i -g"));
  const npmProblems = [...completionProblems(seeded.completed, viaNpm.after), ...viaNpm.missing.map(name => `table ${name} was not created`)];
  if (npmProblems.length > 0) throw Object.assign(Error(`after npm i -g: ${npmProblems.join("; ")}`), { step: "inspect (npm)" });
  return steps;
}

function readJournalDetail(stateDir) {
  try { const j = JSON.parse(readFileSync(join(stateDir, "toolroll-update.json"), "utf8")); return `${j.phase}: ${j.detail}`; } catch { return ""; }
}

async function main() {
  const candidate = resolve(flag("candidate") ?? dirname(dirname(SELF)));
  const candidateDist = join(candidate, "dist");
  if (!existsSync(join(candidateDist, "bin.js"))) throw Error(`${candidate} has no built dist; build it first.`);
  const candidateVersion = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")).version;
  const versions = flag("versions")?.split(",").filter(Boolean)
    ?? upgradeVersions(JSON.parse(must(sh("npm", ["view", "toolroll", "versions", "--json"]), "npm view toolroll versions")));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "upgrade-path-")));
  console.log(`Upgrade path: ${versions.join(", ")} → ${candidateVersion} (${candidate})`);
  let failed = 0;
  try {
    const tarball = pack(candidate, work);
    for (const version of versions) {
      const at = Date.now();
      try {
        const steps = await onePath(version, { candidate, candidateDist, candidateVersion, tarball, work });
        console.log(`✓ ${version} → ${candidateVersion}: ${steps.join(", ")}; ${Math.round((Date.now() - at) / 1000)} s`);
      } catch (error) {
        failed++;
        console.log(`✗ ${version} → ${candidateVersion} at ${error.step ?? "setup"}: ${error.message}`);
      }
    }
  } finally {
    if (args.includes("--keep")) console.log(`kept: ${work}`); else rmSync(work, { recursive: true, force: true });
  }
  console.log(failed === 0 ? `upgrade path: ${versions.length} of ${versions.length} versions updated with no manual step` : `upgrade path: ${failed} of ${versions.length} versions failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const modes = { seed, facts, stage, inspect, hold, release, longText, rollback };
  const mode = Object.keys(modes).find(name => args[0] === `--${name}`);
  if (mode) {
    modes[mode](JSON.parse(args[1])).then(value => { process.stdout.write(`\n${JSON.stringify(value)}\n`); }, error => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
  } else {
    main().catch(error => { console.error(error?.stack ?? error); process.exitCode = 1; });
  }
}
