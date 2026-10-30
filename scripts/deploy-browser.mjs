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
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { deployStateDir, loadNames, stagedRuntimePaths } from "./deploy-paths.mjs";
import { blobAt, extractTree, headOf, trackedChanges } from "./deploy-git.mjs";
import { loadCodingDeploymentRuntime } from "./deploy-coding.mjs";
import { recoverOnExit } from "./deploy-recovery.mjs";
import { activeWorkRefusal, browserDeployment, openDeploymentDatabase, sha, snapshot } from "./deploy-phases.mjs";
import { serviceStopper } from "./deploy-stop.mjs";

const args = process.argv.slice(2);
// git on the candidate's repository (AGENTS.md trust boundary) runs only through deploy-git.mjs: a Git directory of the
// script's own over the repository's objects and refs, with a config it writes itself (the repository's never applies),
// no user global or system config, hooks, fsmonitor, replacement objects, transport or lazy fetch, and every object
// hashed against its id, so the bytes read under a SHA are that SHA's own (eval-harness review 2, findings 2 and 3).
const SAFE_GIT_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
const flag = (name, fallback = undefined) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const has = name => args.includes(`--${name}`);
const runId = Number(flag("run"));
const phaseWanted = flag("phase", "all");
// New names first; an install made under the older name keeps being found (nothing is moved).
const named = (paths) => paths.find(one => existsSync(one)) ?? paths[0];
const source = resolve(flag("source", dirname(dirname(fileURLToPath(import.meta.url)))));
// Under `toolroll release` (it passes --git-dir) this script runs from the release's own extraction of the approved
// commit, and everything it takes from the commit comes from there; run by hand, from the checkout it lives in.
const releaseMode = flag("git-dir") !== undefined;
const approvedRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = releaseMode ? approvedRoot : source;
// npm reads no user or global config of the person's or the checkout's. Two different empty files: npm 11 refuses to
// load one file as both (release 0.9.72's first deploy: "double-loading config /dev/null as global").
const npmEmptyConfig = join(mkdtempSync(join(tmpdir(), "so-npmrc-")), "global-npmrc");
writeFileSync(npmEmptyConfig, "", { mode: 0o600 });
const NPM_ENV = { ...process.env, NODE_OPTIONS: "", npm_config_userconfig: "/dev/null", npm_config_globalconfig: npmEmptyConfig };
// The staged runtime installs the candidate under its own package name (toolroll; standing-orders before the rename):
// one optional scope, then a plain name, never a path.
const packageName = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name;
if (typeof packageName !== "string" || !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName) || packageName.includes("..")) {
  throw Error("The candidate's package name isn't a plain package name.");
}
const label = flag("label", basename(named(["com.toolroll.browser", "com.standing-orders.browser"].map(one => join(homedir(), "Library", "LaunchAgents", `${one}.plist`))), ".plist"));
const plist = flag("plist", join(homedir(), "Library", "LaunchAgents", `${label}.plist`));
const uid = userInfo().uid;
const say = (...parts) => console.log(parts.map(p => typeof p === "string" ? p : JSON.stringify(p)).join(" "));
function requireTrue(value, message) { if (!value) throw Error(message); }
if (!Number.isInteger(runId) || runId < 1) requireTrue(false, "Name the verified builder run: --run <id>.");

// ---- installed runtime (old): trusted, and the only code run before the candidate is proven ----------------------
// Approval policy §1.7: whether a person approved the candidate and its exact result is complete is decided by the
// INSTALLED runtime and the plane's records, before any of the candidate's own modules are imported. (Run this script
// from a trusted checkout with --source <candidate> to keep the candidate's code out of the check entirely.)
// Recovery runs after the swap may have written the new definition: it starts the one saved at preparation.
const livePlist = readFileSync(phaseWanted === "recover" && flag("stage") ? join(flag("stage"), "browser.saved.plist") : plist, "utf8");
const priorDist = (livePlist.match(/<string>([^<]*\/dist)\/cli\.js<\/string>/) ?? [])[1];
requireTrue(priorDist && existsSync(priorDist), `The live service definition at ${plist} names no installed runtime.`);
const publicUrl = (livePlist.match(/<string>--public-url<\/string>\s*<string>([^<]+)<\/string>/) ?? [])[1] ?? null;
const servicePort = (livePlist.match(/<string>--port<\/string>\s*<string>(\d+)<\/string>/) ?? [])[1] ?? "4180";
const names = await loadNames(priorDist);
// The folder that holds the database wins, exactly as the plane picks it.
const stateDir = flag("state") ?? deployStateDir(names, process.env, homedir());
const database = flag("db", join(stateDir, "orders.db"));
const evidenceRoot = join(dirname(database), "evidence");

// Acquire before reading the saved definition, runtime or journal on every entry, including recovery.
// `toolroll release` names the approved commit and the project's own Git directory (never the worktree's .git pointer),
// and runs this script from its own extraction of that commit; run by hand, the checkout answers both.
const gitDirGiven = flag("git-dir");
const REPO_GIT = gitDirGiven === undefined ? ["-C", source] : ["--git-dir", gitDirGiven];
const headGiven = flag("head");
if (headGiven !== undefined) requireTrue(/^[0-9a-f]{40}$/.test(headGiven), "--head takes the full approved commit SHA.");
const candidateHead = headGiven ?? headOf(REPO_GIT, SAFE_GIT_ENV);
const short = candidateHead.slice(0, 7);
const stageDir = flag("stage") ?? join(stateDir, "staged-upgrades", `browser-${short}-${randomUUID().slice(0, 6)}`);
const journalFile = join(stageDir, "deployment.json");
mkdirSync(stageDir, { recursive: true, mode: 0o700 });
const { acquireDeploymentLock } = await import(pathToFileURL(join(priorDist, "deploy-lock.js")).href);
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
const oldRt = { scope: await load(priorDist, "scope.js"), assignment: await load(priorDist, "assignment.js"), store: await load(priorDist, "store.js"), gate: await load(priorDist, "desktop-update-gate.js"), evidence: await load(priorDist, "verification-evidence.js"), update: await load(priorDist, "desktop-update.js") };
oldRt.coding = await loadCodingDeploymentRuntime(priorDist);
// GitHub's nightly lane debt (evals-nightly.md, A2): the installed runtime's own reader, when it has one.
oldRt.nightly = existsSync(join(priorDist, "nightly-github.js")) ? await load(priorDist, "nightly-github.js") : null;
// The candidate is proven here, on every entry but recovery, before anything of its own runs.
// GitHub's nightly lane debt (evals-nightly.md, A2): this deploy's own bounded read, through the installed runtime,
// before the stored check — a deploy started here re-reads its exemptions and sees a new failure (Codex round 1, 3).
// Without that re-read (an installed runtime that can't, or a refresh that threw) no exemption counts for this deploy.
let nightlyRefreshed = false;
if (phaseWanted !== "recover" && typeof oldRt.nightly?.refreshNightlyForDeploy === "function") {
  const db = openDeploymentDatabase(database);
  try { await oldRt.nightly.refreshNightlyForDeploy(new oldRt.store.Store(db), { runId, now: () => new Date() }); nightlyRefreshed = true; }
  catch { /* the stored check below decides, exemptions not counted */ }
  finally { db.close(); }
}
const early = phaseWanted === "recover" ? null : (() => { const db = openDeploymentDatabase(database, { readOnly: true }); try { return facts(db); } finally { db.close(); } })();
// A stage made before the rename installed the runtime under the older name; resuming it keeps that path.
const stagedRuntime = stagedRuntimePaths(stageDir, packageName, names);
const stagedName = stagedRuntime.name, nextDist = stagedRuntime.dist;

// ---- the plane's own records for this candidate -----------------------------
function facts(db) {
  const store = new oldRt.store.Store(db);
  // `--operation` names the coordinator's reserved deploy (adopted, with its secret, before anything is staged): only
  // then may a release's own automatic approval stand.
  const result = deploymentCandidate(store, { runId, head: candidateHead, evidenceRoot, now: new Date(), releaseFlow: flag("operation") !== undefined, nightlyRefreshed }, {
    assignmentOf: oldRt.assignment.assignmentOf, verificationEvidence: oldRt.evidence.verificationEvidence, installedScope: oldRt.scope,
    installedNightly: oldRt.nightly,
  });
  requireTrue(resolve(result.worktree) === source || headOf(["-C", result.worktree], SAFE_GIT_ENV) === candidateHead, "Run this from the builder's worktree for this run.");
  return result;
}
function quiet(db) {
  const work = oldRt.gate.activeUpdateWork(db);
  requireTrue(Object.values(work).every(n => n === 0), activeWorkRefusal(work));
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
  const up = children.filter((_, at) => commands[at].includes(`${dist}/cli.js up --db ${database}`));
  if (up.length !== 1) return null;
  // `up`'s console and worker (isolated-checks stage 1), each verified by its command: this runtime's role entry and
  // its one role argument. Deployment proves their exit too (round 1, finding 3). A role from another runtime is not
  // this service. An `up` from before the split has none.
  const roles = [];
  const below = spawnSync("/usr/bin/pgrep", ["-P", String(up[0])], { encoding: "utf8" });
  if (below.status !== 0 && below.status !== 1) return null;
  for (const child of below.stdout.trim().split(/\s+/).filter(Boolean).map(Number)) {
    const roleCommand = spawnSync("/bin/ps", ["-p", String(child), "-o", "command="], { encoding: "utf8" }).stdout.trim();
    if (!roleCommand.includes("up-role-child.js")) continue;
    const role = / (console|worker)$/.exec(roleCommand)?.[1];
    if (!roleCommand.includes(`${dist}/up-role-child.js `) || role === undefined) return null;
    roles.push({ role, pid: child });
  }
  return { supervisor: pid, children, command, commands, roles };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Proving the old service's processes gone, and stopping what it left once each is proved its own (deploy-stop.mjs).
const { verifyServiceStopped, leftFrom, processes, stopProcesses } = serviceStopper({
  database, spawnSync, kill: (pid, name) => process.kill(pid, name), sleep, signal, say,
  loaded: () => spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" }).status === 0,
});
const schemaDigest = db => sha(JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()));
const list = (root, prefix = "") => readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(e => e.isDirectory() ? list(root, join(prefix, e.name)) : [join(prefix, e.name)]).sort();

// ---- phases ------------------------------------------------------------------
function stage() {
  // Run by hand, the checkout must be clean; under the release every packed byte is proven against the commit itself.
  // Tracked files hashed here with no filter (deploy-git.mjs trackedChanges), never `git status`, which runs the clean
  // filters the repository's attributes name.
  if (gitDirGiven === undefined) requireTrue(trackedChanges(source, candidateHead, SAFE_GIT_ENV).length === 0, "The candidate checkout has tracked changes.");
  if (!releaseMode) requireTrue(existsSync(join(source, "dist")), "The candidate has no dist; the native gate builds it.");
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  // Spotlight leaves staged runtimes alone (src/never-index.ts).
  try { writeFileSync(join(dirname(stageDir), ".metadata_never_index"), "", { flag: "a" }); } catch { /* only Spotlight minds */ }
  // The runtime is the packed package plus every production dependency of a
  // clean, lockfile-verified install of the candidate commit — nothing from
  // the worktree's mutable node_modules.
  // No lifecycle scripts: packing must not run anything from the checkout.
  // Under the release: packed from the clean build of the extracted commit, never from the checkout.
  const packFrom = releaseMode ? cleanBuildOf(candidateHead).scratch : source;
  const packed = execFileSync("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", stageDir], { cwd: packFrom, encoding: "utf8", env: NPM_ENV }).trim().split("\n").pop();
  const runtime = join(stageDir, "runtime");
  const self = join(runtime, "node_modules", packageName);
  mkdirSync(self, { recursive: true });
  execFileSync("tar", ["-xzf", join(stageDir, packed), "--strip-components=1", "-C", self]);
  // npm pack normalises package.json; the runtime carries the checkout's exact bytes.
  copyFileSync(join(packageRoot, "package.json"), join(self, "package.json"));
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: `${packageName}-installed`, private: true, candidate: candidateHead, dependencies: { [packageName]: `file:../${packed}` } }, null, 2));
  const built = cleanBuildOf(candidateHead);
  for (const dep of built.dependencies) cpSync(join(built.scratch, dep), join(runtime, dep), { recursive: true, dereference: true, errorOnExist: false });
  const proof = proveStaged();
  return { packed, packageSha256: sha(readFileSync(join(stageDir, packed))), distFiles: proof.distFiles };
}

/** Relative paths of every production dependency the checkout resolved. */
const productionDependencies = root => execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8", env: NPM_ENV }).trim().split("\n")
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
  // npm ls prints real paths; macOS's temp folder is behind a symlink (/var → /private/var), and a scratch path in the
  // symlinked form matched no dependency, staging none and proving "none" equal to "none".
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "so-deploy-")));
  requireTrue(/^[0-9a-f]{40}$/.test(commit), "The candidate commit isn't a full SHA.");
  if (releaseMode) {
    // The release already wrote the commit's files, byte for byte, with no filter or attribute applied.
    requireTrue(commit === candidateHead, "The extraction is of the approved commit only.");
    cpSync(approvedRoot, scratch, { recursive: true, verbatimSymlinks: true });
  } else {
    // The commit's stored bytes, each object hashed against its id; never `git archive`, which applies attributes.
    extractTree(REPO_GIT, commit, scratch, SAFE_GIT_ENV);
  }
  const env = NPM_ENV;
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--silent"], { cwd: scratch, stdio: ["ignore", "ignore", "inherit"], env });
  execFileSync("npm", ["run", "build", "--silent"], { cwd: scratch, stdio: ["ignore", "ignore", "inherit"], env });
  const files = list(join(scratch, "dist"));
  const bytes = new Map(files.map(f => [f, readFileSync(join(scratch, "dist", f))]));
  const dependencies = productionDependencies(scratch);
  const declared = Object.keys(JSON.parse(readFileSync(join(scratch, "package.json"), "utf8")).dependencies ?? {});
  requireTrue(declared.every(name => dependencies.includes(`node_modules/${name}`)), `The clean install resolved none of some declared dependencies: ${declared.filter(name => !dependencies.includes(`node_modules/${name}`)).join(", ")}`);
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
    const expected = releaseMode
      ? (existsSync(join(approvedRoot, f)) ? readFileSync(join(approvedRoot, f)) : null)
      : blobAt(REPO_GIT, candidateHead, f, SAFE_GIT_ENV);
    requireTrue(expected !== null && expected.equals(readFileSync(join(self, f))), `Packed file differs from the candidate commit: ${f}`);
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
  const { pruneStagedRuntimes, runtimesInUse } = await load(releaseMode ? nextDist : join(source, "dist"), "staged-runtimes.js");
  return pruneStagedRuntimes(stateDir, new Date(), { inUse: () => runtimesInUse(keep.filter(Boolean)) }).removed;
}

// The journaled phases and their recovery, run with the real services, runtimes and records.
const { save, loadPhase, assertPreserved, assertMigrated, ensureCodingBackup, prepare, swap, finish, recoverJournal } = browserDeployment({
  database, stageDir, stateDir, journalFile, plist, livePlist, priorDist, nextDist, uid, label, servicePort, runId, candidateHead, publicUrl, script: fileURLToPath(import.meta.url), oldRt, deploymentLock, signal,
  facts, quiet, service, proveStaged, verifyServiceStopped, leftFrom, load, loadCodingDeploymentRuntime, spawnSync, fetch, sleep, say, requireTrue, pruneStaged,
  processes, stopProcesses,
});
recover = recoverJournal;

/**
 * The release deploy this run is part of (the installed runtime's store, release-once.md), or null for a task that
 * belongs to no release. Under `toolroll release` the coordinator reserved and started the operation and names it with
 * --operation; run by a person, this run reserves its own (a resumed phase reserves only when nothing is unsettled).
 */
let releaseOperation = null;
function reserveReleaseDeploy(taskId) {
  const mod = oldRt.store;
  if (typeof mod.releaseAuthorityOfTask !== "function") return null;
  const db = openDeploymentDatabase(database);
  try {
    const store = new mod.Store(db);
    const found = mod.releaseAuthorityOfTask(store, taskId);
    if (found === null) return null;
    const scope = store.getScope(taskId);
    const candidate = scope?.candidate ?? null;
    requireTrue(candidate !== null, "The release task names no candidate.");
    const named = flag("operation");
    if (named !== undefined) {
      // Adopting the coordinator's operation: it is this release's running deploy, reserved at the epoch that still holds
      // a live lease, and this run proves the secret the coordinator handed it on stdin (never in argv).
      requireTrue(typeof mod.adoptReleaseOperation === "function", "The installed Toolroll can't check a release's deploy; update it first.");
      let secret = "";
      try { secret = readFileSync(0, "utf8").trim(); } catch { secret = ""; }
      const adopted = mod.adoptReleaseOperation(store, { id: named, authority: found.authority.id, candidate, secret, now: new Date() });
      requireTrue(adopted.ok, adopted.ok ? "" : adopted.why);
      return { id: named, own: false };
    }
    const id = randomUUID();
    // This process is the operation's issuer, and its staging folder is where recovery reads the deployment's journal.
    const reserved = mod.reserveRelease(store, { authority: found.authority.id, kind: "deploy", taskId, candidate, epoch: null, operationId: id, now: new Date(), stage: stageDir });
    requireTrue(reserved.ok, `The release can't deploy now: ${reserved.ok ? "" : reserved.why}`);
    requireTrue(mod.runReleaseOperation(store, id, reserved.operation.epoch, new Date()), "The release's deploy couldn't start: its lease moved.");
    say(`Release ${found.authority.version}: deploy operation ${id} (resume a phase with --operation ${id}).`);
    return { id, own: true };
  } finally { db.close(); }
}
/** Settle a deploy operation this run reserved itself (the coordinator settles its own). */
function settleReleaseDeploy(outcome, detail) {
  if (releaseOperation === null || !releaseOperation.own || typeof oldRt.store.finishReleaseOperation !== "function") return;
  const db = openDeploymentDatabase(database);
  try {
    const store = new oldRt.store.Store(db);
    // Settled at the epoch it was reserved at: if a coordinator took the release over since, it reconciles instead.
    const op = oldRt.store.releaseOperation(store, releaseOperation.id);
    if (op !== null) oldRt.store.finishReleaseOperation(store, releaseOperation.id, outcome, { detail }, new Date(), op.epoch);
  }
  finally { db.close(); }
}

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
  const proven = early ?? (() => { const db = openDeploymentDatabase(database, { readOnly: true }); try { return facts(db); } finally { db.close(); } })();
  say(`Candidate ${short} — task ${proven.taskId}, run ${runId}, checks passed, marked complete by ${proven.completion.actor}.`);
  // One approval per release (docs/plans/release-once.md): a release's deploy freezes its candidate in the store before
  // anything is staged — `open` → `deploying`, atomically — so a direct run can't skip the freeze.
  releaseOperation = reserveReleaseDeploy(proven.taskId);
  say(`Installed runtime: ${priorDist}`);
  say(`Staging directory: ${stageDir}`);
  if (phaseWanted === "all") {
    if (!has("yes")) { say("Add --yes to drain the plane, back up the database, and swap the service."); process.exit(0); }
    const staged = stage(); await prepare(staged); await rehearse(); await swap(); await finish();
    settleReleaseDeploy("succeeded", null);
  } else {
    if (phaseWanted !== "stage") requireTrue(flag("stage"), `--phase ${phaseWanted} resumes a staging directory: pass --stage <dir>.`);
    if (phaseWanted === "stage") say(stage());
    else if (phaseWanted === "prepare") await prepare({ packageSha256: sha(readFileSync(join(stageDir, readdirSync(stageDir).find(f => f.endsWith(".tgz"))))) });
    else await phases[phaseWanted]();
    if (phaseWanted === "finish") settleReleaseDeploy("succeeded", null);
  }

} catch (error) {
  console.error(`✗ ${error.message}`);
  try { settleReleaseDeploy("failed", String(error.message).slice(0, 500)); } catch { /* the coordinator reconciles it */ }
  process.exitCode ||= 1;
}
