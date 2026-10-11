#!/usr/bin/env node
// One-action deployment of a verified candidate into the browser installation.
//
//   node scripts/deploy-browser.mjs --run <builder run id> [--yes] [--phase <name>]
//
// Run it from the candidate's own checkout (the builder's worktree). It stages
// the packed runtime beside the installed ones, proves the candidate against
// the plane's own records — the exact approved check passed and the lead or
// user marked that saved result complete — and
// then drains, backs up, rehearses, swaps the launchd service, migrates, and
// re-opens admission, journaling every phase so a crash resumes or restores.
//
// Phases: stage → prepare → rehearse → swap → finish (default: all). A journal
// in the staging directory records progress; rerun with --stage <dir> and
// --phase <name> to resume one. Nothing here weakens an approval: the candidate
// must already be checked and marked complete, or the script stops before touching
// the service.
import { deploymentCandidate } from "./deploy-candidate.mjs";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { deployStateDir, loadNames, stagedRuntimePaths } from "./deploy-paths.mjs";
import { loadCodingDeploymentRuntime } from "./deploy-coding.mjs";
import { recoverOnExit } from "./deploy-recovery.mjs";
import { browserDeployment, openDeploymentDatabase, sha, snapshot } from "./deploy-phases.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const has = name => args.includes(`--${name}`);
const runId = Number(flag("run"));
const phaseWanted = flag("phase", "all");
// New names first; an install made under the older name keeps being found (nothing is moved).
const named = (paths) => paths.find(one => existsSync(one)) ?? paths[0];
const source = resolve(flag("source", dirname(dirname(fileURLToPath(import.meta.url)))));
const names = await loadNames(join(source, "dist"));
// The folder that holds the database wins, exactly as the plane picks it.
const stateDir = flag("state") ?? deployStateDir(names, process.env, homedir());
const database = flag("db", join(stateDir, "orders.db"));
const label = flag("label", basename(named(["com.toolroll.browser", "com.standing-orders.browser"].map(one => join(homedir(), "Library", "LaunchAgents", `${one}.plist`))), ".plist"));
const plist = flag("plist", join(homedir(), "Library", "LaunchAgents", `${label}.plist`));
// The staged runtime installs the candidate under its own package name (toolroll; standing-orders before the rename).
const packageName = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).name;
const uid = userInfo().uid;
const say = (...parts) => console.log(parts.map(p => typeof p === "string" ? p : JSON.stringify(p)).join(" "));
function requireTrue(value, message) { if (!value) throw Error(message); }
if (!Number.isInteger(runId) || runId < 1) requireTrue(false, "Name the verified builder run: --run <id>.");

// Acquire before reading the saved definition, runtime or journal on every entry, including recovery.
const candidateHead = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const short = candidateHead.slice(0, 7);
const stageDir = flag("stage") ?? join(stateDir, "staged-upgrades", `browser-${short}-${randomUUID().slice(0, 6)}`);
const journalFile = join(stageDir, "deployment.json");
mkdirSync(stageDir, { recursive: true, mode: 0o700 });
const { acquireDeploymentLock } = await import(pathToFileURL(join(source, "dist", "deploy-lock.js")).href);
const deploymentLock = acquireDeploymentLock(journalFile);
const cancellation = new AbortController();
const signal = cancellation.signal;
let recover = () => true;
recoverOnExit(() => recover(), process, {
  release: () => deploymentLock.release(),
  onSignal: (code, name) => { process.exitCode = code; cancellation.abort(Error(`Deployment interrupted by ${name}.`)); },
});
const load = async (root, name) => {
  signal.throwIfAborted();
  const module = await import(pathToFileURL(join(root, name)).href);
  signal.throwIfAborted();
  return module;
};

// ---- installed runtime (old) and candidate runtime (new) ---------------------
// Recovery runs after the swap may have written the new definition: it starts the one saved at preparation.
const livePlist = readFileSync(phaseWanted === "recover" && flag("stage") ? join(flag("stage"), "browser.saved.plist") : plist, "utf8");
const priorDist = (livePlist.match(/<string>([^<]*\/dist)\/cli\.js<\/string>/) ?? [])[1];
requireTrue(priorDist && existsSync(priorDist), `The live service definition at ${plist} names no installed runtime.`);
const publicUrl = (livePlist.match(/<string>--public-url<\/string>\s*<string>([^<]+)<\/string>/) ?? [])[1] ?? null;
const servicePort = (livePlist.match(/<string>--port<\/string>\s*<string>(\d+)<\/string>/) ?? [])[1] ?? "4180";
const oldRt = { store: await load(priorDist, "store.js"), gate: await load(priorDist, "desktop-update-gate.js"), evidence: await load(priorDist, "verification-evidence.js"), update: await load(priorDist, "desktop-update.js") };
oldRt.coding = await loadCodingDeploymentRuntime(priorDist);
const candidateAssignment = await load(join(source, "dist"), "assignment.js");
// A stage made before the rename installed the runtime under the older name; resuming it keeps that path.
const stagedRuntime = stagedRuntimePaths(stageDir, packageName, names);
const stagedName = stagedRuntime.name, nextDist = stagedRuntime.dist;
const evidenceRoot = join(dirname(database), "evidence");

// ---- the plane's own records for this candidate -----------------------------
function facts(db) {
  const store = new oldRt.store.Store(db);
  const result = deploymentCandidate(store, { runId, head: candidateHead, evidenceRoot, now: new Date() }, {
    assignmentOf: candidateAssignment.assignmentOf, verificationEvidence: oldRt.evidence.verificationEvidence,
  });
  requireTrue(resolve(result.worktree) === source || execFileSync("git", ["-C", result.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() === candidateHead, "Run this from the builder's worktree for this run.");
  return result;
}
function quiet(db) {
  const work = oldRt.gate.activeUpdateWork(db);
  requireTrue(Object.values(work).every(n => n === 0), `Current work must finish first: ${JSON.stringify(work)}.`);
  const store = new oldRt.store.Store(db);
  for (const row of db.prepare("SELECT DISTINCT run FROM run_process WHERE exited_at IS NULL").all()) {
    const problem = store.stopQuiescenceProblem(row.run);
    requireTrue(!problem, problem);
  }
}
function service(dist) {
  const launch = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
  const pid = Number(launch.stdout.match(/\n\s*pid = (\d+)/)?.[1]);
  if (!(pid > 1) || !launch.stdout.includes("state = running")) return null;
  const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (!command.includes(`${dist}/controller-service.js`)) return null;
  const children = execFileSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean).map(Number);
  const commands = children.map(p => spawnSync("/bin/ps", ["-p", String(p), "-o", "command="], { encoding: "utf8" }).stdout);
  return commands.some(c => c.includes(`${dist}/cli.js up --db ${database}`)) ? { supervisor: pid, children, command, commands } : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function verifyServiceStopped(pids) {
  for (let i = 0; i < 60; i++) { signal.throwIfAborted(); if (pids.every(pid => spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" }).status === 1)) break; await sleep(1000); }
  for (const pid of pids) requireTrue(spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" }).status === 1, `Service process has not exited: ${pid}`);
  requireTrue(spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" }).status !== 0, "The service is still loaded.");
}
const schemaDigest = db => sha(JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()));
const list = (root, prefix = "") => readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(e => e.isDirectory() ? list(root, join(prefix, e.name)) : [join(prefix, e.name)]).sort();

// ---- phases ------------------------------------------------------------------
function stage() {
  requireTrue(!execFileSync("git", ["-C", source, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "The candidate checkout has tracked changes.");
  requireTrue(existsSync(join(source, "dist")), "The candidate has no dist; the native gate builds it.");
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  // Spotlight leaves staged runtimes alone (src/never-index.ts).
  try { writeFileSync(join(dirname(stageDir), ".metadata_never_index"), "", { flag: "a" }); } catch { /* only Spotlight minds */ }
  // The runtime is the packed package plus every production dependency of a
  // clean, lockfile-verified install of the candidate commit — nothing from
  // the worktree's mutable node_modules.
  const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", stageDir], { cwd: source, encoding: "utf8" }).trim().split("\n").pop();
  const runtime = join(stageDir, "runtime");
  const self = join(runtime, "node_modules", packageName);
  mkdirSync(self, { recursive: true });
  execFileSync("tar", ["-xzf", join(stageDir, packed), "--strip-components=1", "-C", self]);
  // npm pack normalises package.json; the runtime carries the checkout's exact bytes.
  copyFileSync(join(source, "package.json"), join(self, "package.json"));
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: `${packageName}-installed`, private: true, candidate: candidateHead, dependencies: { [packageName]: `file:../${packed}` } }, null, 2));
  const built = cleanBuildOf(candidateHead);
  for (const dep of built.dependencies) cpSync(join(built.scratch, dep), join(runtime, dep), { recursive: true, dereference: true, errorOnExist: false });
  const proof = proveStaged();
  return { packed, packageSha256: sha(readFileSync(join(stageDir, packed))), distFiles: proof.distFiles };
}

/** Relative paths of every production dependency the checkout resolved. */
const productionDependencies = root => execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8" }).trim().split("\n")
  .filter(p => p.startsWith(join(root, "node_modules") + "/")).map(p => p.slice(root.length + 1)).sort();

/** The staged runtime is the verified candidate COMMIT, byte for byte — not
 * the worktree, which is mutable after the gate. dist is rebuilt from a clean
 * archive of the commit (tsc output is deterministic) and compared; every
 * other packed file is compared to the commit's blob; every production
 * dependency is checked against the commit's lockfile. Proved when staged and
 * again before every later phase, once per process. */
let cleanBuild = null;
process.on("exit", () => { if (cleanBuild?.scratch) rmSync(cleanBuild.scratch, { recursive: true, force: true }); });
/** A clean checkout of the commit, its dependencies installed from the
 * committed lockfile (npm verifies every package against the lockfile's
 * integrity hash), and dist built there. Nothing from the worktree's
 * mutable node_modules is used; the compiler itself comes from the lockfile. */
function cleanBuildOf(commit) {
  if (cleanBuild?.commit === commit) return cleanBuild;
  const scratch = mkdtempSync(join(tmpdir(), "so-deploy-"));
  execFileSync("sh", ["-c", `git -C "${source}" archive --format=tar ${commit} | tar -x -C "${scratch}"`]);
  const env = { ...process.env, NODE_OPTIONS: "" };
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--silent"], { cwd: scratch, stdio: ["ignore", "ignore", "inherit"], env });
  execFileSync("npm", ["run", "build", "--silent"], { cwd: scratch, stdio: ["ignore", "ignore", "inherit"], env });
  const files = list(join(scratch, "dist"));
  const bytes = new Map(files.map(f => [f, readFileSync(join(scratch, "dist", f))]));
  const dependencies = productionDependencies(scratch);
  cleanBuild = { commit, scratch, files, bytes, dependencies };
  return cleanBuild;
}
/** Package roots under a node_modules directory: scoped or not, and the
 * nested node_modules a package carries — never the package.json files
 * inside a package's own subdirectories. */
function stagedPackages(dir, prefix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    if (entry.name.startsWith("@")) { out.push(...stagedPackages(join(dir, entry.name), `${prefix}/${entry.name}`)); continue; }
    const root = join(dir, entry.name);
    if (!existsSync(join(root, "package.json"))) continue;
    out.push(`${prefix}/${entry.name}`);
    if (existsSync(join(root, "node_modules"))) out.push(...stagedPackages(join(root, "node_modules"), `${prefix}/${entry.name}/node_modules`));
  }
  return out;
}
/** The staged runtime is the verified candidate COMMIT, byte for byte: dist
 * equals a clean build of the commit, every other packed file equals the
 * commit's blob, and every production dependency equals the clean install
 * from the commit's lockfile. Proved when staged and again before every
 * later phase (once per process). */
function proveStaged() {
  requireTrue(existsSync(nextDist), `No staged runtime at ${nextDist}.`);
  const { runtime, self } = stagedRuntime;
  requireTrue(JSON.parse(readFileSync(join(runtime, "package.json"), "utf8")).candidate === candidateHead, "The staged runtime was built for a different candidate.");
  const built = cleanBuildOf(candidateHead);
  requireTrue(JSON.stringify(built.files) === JSON.stringify(list(nextDist)), "Staged dist inventory differs from a clean build of the candidate commit.");
  for (const f of built.files) requireTrue(built.bytes.get(f).equals(readFileSync(join(nextDist, f))), `Staged file differs from a clean build of the candidate commit: ${f}`);
  for (const f of list(self).filter(f => !f.startsWith("dist/"))) {
    const blob = spawnSync("git", ["-C", source, "show", `${candidateHead}:${f}`], { maxBuffer: 64 * 1024 * 1024 });
    requireTrue(blob.status === 0 && blob.stdout.equals(readFileSync(join(self, f))), `Packed file differs from the candidate commit: ${f}`);
  }
  const staged = stagedPackages(join(runtime, "node_modules"), "node_modules").filter(dep => dep !== `node_modules/${stagedName}`).sort();
  requireTrue(JSON.stringify(staged) === JSON.stringify(built.dependencies), `Staged dependency inventory differs from the lockfile install: ${JSON.stringify({ staged: staged.length, lockfile: built.dependencies.length })}`);
  for (const dep of staged) {
    const clean = join(built.scratch, dep), installed = join(runtime, dep), depFiles = list(clean);
    requireTrue(JSON.stringify(depFiles) === JSON.stringify(list(installed)), `Dependency file inventory differs from the lockfile install: ${dep}`);
    for (const f of depFiles) requireTrue(readFileSync(join(clean, f)).equals(readFileSync(join(installed, f))), `Dependency bytes differ from the lockfile install: ${dep}/${f}`);
  }
  return { distFiles: built.files.length, dependencies: staged.length };
}

async function rehearse() {
  const r = loadPhase("backup-verified"), target = join(stageDir, "rehearsal.db");
  requireTrue(!existsSync(target) && sha(readFileSync(r.backup)) === r.backupSha256, "Rehearsal exists or the backup changed.");
  await ensureCodingBackup(oldRt.coding, r);
  copyFileSync(r.backup, target); chmodSync(target, 0o600);
  const next = await load(nextDist, "store.js");
  const history = r.schema === r.nextSchema ? null : await load(nextDist, "toolroll-update.js");
  let db = openDeploymentDatabase(target, { readOnly: true });
  const before = snapshot(db), beforeHistory = history?.historySnapshot(db); db.close();
  next.openStore(target).close(); next.openStore(target).close();
  db = openDeploymentDatabase(target, { readOnly: true });
  let upgraded, upgradedSchema;
  try {
    requireTrue(db.prepare("SELECT version FROM schema_version").get().version === r.nextSchema && oldRt.gate.updateGateOwned(db, r.id), "Rehearsal schema or gate mismatch.");
    // A schema change may reshape history only as the new runtime's own update rules allow; same schema keeps every row.
    if (r.schema === r.nextSchema) assertPreserved(db, before); else assertMigrated(db, history, beforeHistory);
    upgraded = snapshot(db, true); upgradedSchema = schemaDigest(db);
  } finally { db.close(); }
  if (r.schema === r.nextSchema) {
    oldRt.store.openStore(target).close();
    db = openDeploymentDatabase(target, { readOnly: true });
    try { assertPreserved(db, upgraded); requireTrue(schemaDigest(db) === upgradedSchema && oldRt.gate.updateGateOwned(db, r.id), "The previous runtime changed the compatible copy."); } finally { db.close(); }
  }
  r.rehearsal = { from: r.schema, to: r.nextSchema, preservedTables: before.length, preservedRows: before.reduce((n, t) => n + t.count, 0), integrity: "ok", previousRuntimeCompatible: r.schema === r.nextSchema };
  save(r, "rehearsed");
}

/** Keep storage in check: once a deploy is healthy, older staged runtimes go (with the database backups they hold).
 * Kept (src/staged-runtimes.ts, the same rule the plane's daily storage sweep uses): the one it installed and any a
 * launchd service or a `toolroll` (or older `standing-orders`) command runs from, the one before it (the way back),
 * the newest, one whose deploy or update is still under way for a week, and one holding a kept-aside database. */
async function pruneStaged(keep) {
  const { pruneStagedRuntimes, runtimesInUse } = await load(join(source, "dist"), "staged-runtimes.js");
  return pruneStagedRuntimes(stateDir, new Date(), { inUse: () => runtimesInUse(keep.filter(Boolean)) }).removed;
}

// The journaled phases and their recovery, run with the real services, runtimes and records.
const { save, loadPhase, assertPreserved, assertMigrated, ensureCodingBackup, prepare, swap, finish, recoverJournal } = browserDeployment({
  database, stageDir, stateDir, journalFile, plist, livePlist, priorDist, nextDist, uid, label, servicePort, runId, candidateHead, publicUrl, script: fileURLToPath(import.meta.url), oldRt, deploymentLock, signal,
  facts, quiet, service, proveStaged, verifyServiceStopped, load, loadCodingDeploymentRuntime, spawnSync, fetch, sleep, say, requireTrue, pruneStaged,
});
recover = recoverJournal;

// Every entry point — the whole run or one resumed phase — proves the
// candidate against the plane's records first. Nothing is staged, and no
// service is touched, until its approved check passed and its exact result is complete.
const phases = { stage, prepare, rehearse, swap, finish };
try {
  signal.throwIfAborted();
  requireTrue(phaseWanted === "all" || phaseWanted === "recover" || phases[phaseWanted], "Use --phase stage|prepare|rehearse|swap|finish|recover, or omit it for all.");
  // Putting the previous service back needs no approval of the candidate: it resumes this deployment's own recovery.
  if (phaseWanted === "recover") {
    requireTrue(flag("stage") && existsSync(journalFile), "--phase recover resumes a failed deployment: pass --stage <dir> of one.");
    process.exit(recoverJournal() ? 0 : 1);
  }
  const proven = (() => { const db = openDeploymentDatabase(database, { readOnly: true }); try { return facts(db); } finally { db.close(); } })();
  say(`Candidate ${short} — task ${proven.taskId}, run ${runId}, checks passed, marked complete by ${proven.completion.actor}.`);
  say(`Installed runtime: ${priorDist}`);
  say(`Staging directory: ${stageDir}`);
  if (phaseWanted === "all") {
    if (!has("yes")) { say("Add --yes to drain the plane, back up the database, and swap the service."); process.exit(0); }
    const staged = stage(); await prepare(staged); await rehearse(); await swap(); await finish();
  } else {
    if (phaseWanted !== "stage") requireTrue(flag("stage"), `--phase ${phaseWanted} resumes a staging directory: pass --stage <dir>.`);
    if (phaseWanted === "stage") say(stage());
    else if (phaseWanted === "prepare") await prepare({ packageSha256: sha(readFileSync(join(stageDir, readdirSync(stageDir).find(f => f.endsWith(".tgz"))))) });
    else await phases[phaseWanted]();
  }

} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode ||= 1;
}
