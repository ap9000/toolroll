// The browser deployer's journaled phases (scripts/deploy-browser.mjs), apart from its command line so
// tests run the same ordered steps against temporary journals and databases with recorded effects. The
// command line passes the real ones: launchd, the installed and staged runtimes, and the plane's records.
import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { observeCodingDeployment, backupCodingDeployment, verifyCodingDeploymentBackup, assertCodingDeploymentStopped, releaseStaleCodingDeployment, ledgerStaleCodingRelease } from "./deploy-coding.mjs";
import { FORWARD_ONLY, NEEDS_NO_RECOVERY, assertDeployPhase, stoppedWhereNothingChanged } from "./deploy-phase-table.mjs";
import { HEALTH_WAIT_MS, RUNNER_LIVENESS_MS, recoverFailedDeployment, waitUntilHealthy } from "./deploy-recovery.mjs";
import { commandKind, listProcesses, recordedStillRunning, serviceProcesses, spellings } from "./deploy-stop.mjs";
import { ABSENCE_MS, BOOTOUT_MS, CALL_MS, boundedRunner, mergeRecorded, ownStateFolder, parseLaunchdPrint, programArguments, recordedLeft, treeOf, uncertain } from "./deploy-launchd.mjs";

export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
/** How long, in all, finish asks the started console's own port before giving up (each ask and pause fits inside it). */
const LOCAL_ANSWER_MS = 30_000;
const quote = s => '"' + s.replaceAll('"', '""') + '"';

// Every direct connection waits at the same bounded lock boundary as Store.
// This queues a brief competing writer; no transaction body is replayed.
export function openDeploymentDatabase(file, options = {}, waitMs = 5000) {
  const db = new DatabaseSync(file, options);
  try { db.exec(`PRAGMA busy_timeout=${waitMs}`); return db; }
  catch (error) { db.close(); throw error; }
}

/** effects: the table snapshot and the SQLite copy, real unless a test supplies them. */
export async function snapshotBackup(original, target, validate = () => {}, effects = {}) {
  original.exec("BEGIN");
  try {
    validate(original);
    const before = (effects.snapshot ?? snapshot)(original, true);
    // Keep one read view through the copy. Larger steps avoid repeated small
    // backup batches while a live service continues unrelated heartbeats.
    await (effects.backup ?? backup)(original, target, { rate: 100000 });
    return before;
  } finally { original.exec("ROLLBACK"); }
}

function digest(db, name, columns) {
  const rows = db.prepare("SELECT " + columns.map(quote).join(",") + " FROM " + quote(name)).all().map(r => JSON.stringify(r)).sort();
  return { count: rows.length, hash: sha(rows.join("\n")) };
}
export function snapshot(db, includeVersion = false) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").all()
    .filter(t => includeVersion || t.name !== "schema_version")
    .map(({ name }) => { const columns = db.prepare("PRAGMA table_info(" + quote(name) + ")").all().map(r => r.name); return { name, columns, ...digest(db, name, columns) }; });
}

/** Interrupted while the old service was stopping: every process recorded for it is gone and launchd no longer has it.
 * A journal may hold only one of the two service records; the absent one adds no pid.
 * alive(pid) says whether a process runs; loaded() whether launchd still has the service. */
export function stopProved(r, { alive, loaded, remaining }) {
  const pids = recordedServicePids(r);
  const left = remaining?.();
  return Array.isArray(left) && left.length === 0 && pids.length > 0
    && pids.every(pid => Number.isInteger(pid) && pid > 1 && !alive(pid)) && !loaded();
}
/**
 * Every process a journal recorded for the service it stops: the supervisor, its `up`, and `up`'s console and worker
 * (Codex review round 1, finding 3: `up`'s exit doesn't prove its roles drained). A record holding a role that isn't a
 * process id keeps that value, so the stop proof refuses it.
 */
export function recordedServicePids(r) {
  const of = one => one === undefined || one === null ? [] : [one.supervisor, ...(one.children ?? []), ...(one.roles ?? []).map(role => role?.pid ?? "unrecorded")];
  return [...new Set([...of(r.oldService), ...of(r.stoppingService)])].filter(pid => pid !== undefined && pid !== null);
}
/** The verified backups, taken before the swap, in place of a live database the candidate migrated and its coding
 * database. Both backups are checked before either is touched. The live files are copied aside first (nothing is running
 * to write them), so nothing written since is lost. Returns the copy of orders.db; the coding copy sits beside it. */
export function restoreDeploymentBackup(r, { database, stageDir }) {
  if (!existsSync(r.backup) || sha(readFileSync(r.backup)) !== r.backupSha256) throw Error(`the verified backup ${r.backup} is missing or changed; the migrated database was left as it is`);
  // The coding database as the stopped service left it: its verified backup, or none at all (null). A journal
  // written before this was recorded uses whatever coding backup it holds, and without one leaves the coding files alone.
  const coding = `${database}.coding.sqlite`;
  const codingHash = r.codingBackupBeforeSwap !== undefined ? r.codingBackupBeforeSwap : r.codingBackupHash;
  if (typeof codingHash === "string") {
    const stat = r.codingBackupPath === join(stageDir, "coding.backup.sqlite") && existsSync(r.codingBackupPath) ? lstatSync(r.codingBackupPath) : null;
    if (!stat?.isFile() || stat.isSymbolicLink() || sha(readFileSync(r.codingBackupPath)) !== codingHash) throw Error(`the verified coding backup ${r.codingBackupPath} is missing or changed; the migrated databases were left as they are`);
  }
  const id = randomUUID().slice(0, 8), kept = join(stageDir, `orders.kept.${id}.db`), keptCoding = join(stageDir, `orders.kept.${id}.db.coding.sqlite`);
  for (const [live, aside] of [[database, kept], ...(codingHash === undefined ? [] : [[coding, keptCoding]])]) {
    for (const suffix of ["", "-wal"]) if (existsSync(live + suffix)) { copyFileSync(live + suffix, aside + suffix); chmodSync(aside + suffix, 0o600); fsyncFile(aside + suffix); }
  }
  const put = (backupFile, live) => {
    const temp = `${live}.${randomUUID()}.restore`;
    try {
      copyFileSync(backupFile, temp); chmodSync(temp, 0o600); fsyncFile(temp);
      for (const suffix of ["-wal", "-shm"]) rmSync(live + suffix, { force: true });
      renameSync(temp, live); fsyncFile(dirname(live));
    } finally { rmSync(temp, { force: true }); }
  };
  put(r.backup, database);
  // A coding database the stopped service never had was the candidate's; it is kept aside, not left for the previous runtime.
  if (typeof codingHash === "string") put(r.codingBackupPath, coding);
  else if (codingHash === null) { for (const suffix of ["", "-wal", "-shm"]) rmSync(coding + suffix, { force: true }); fsyncFile(dirname(coding)); }
  // The backup predates a stale coding owner this deployment released; the ledger keeps saying so, dated when it happened.
  if (r.codingOwnerReleased) { const db = openDeploymentDatabase(database); try { ledgerStaleCodingRelease(db, r.codingOwnerReleased, r.codingOwnerReleasedAt); } finally { db.close(); } }
  return kept;
}
function fsyncFile(path) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
/** What restore puts back for the coding database the stopped service left: its verified backup, null when there was no
 * coding database to back up, or undefined when one exists without a backup, which restore then leaves alone. */
export function codingBackupBeforeSwap(r, database) {
  if (r.codingBackupHash !== undefined) return r.codingBackupHash;
  return existsSync(`${database}.coding.sqlite`) ? undefined : null;
}

/** What is still running that a deployment must wait for, in words a person can act on (desktop-update-gate.ts
 * activeUpdateWork's counts). */
export function activeWorkWords(work) {
  const words = {
    runs: n => `${n} task run${n === 1 ? "" : "s"} still running`,
    claims: n => `${n} claimed task${n === 1 ? "" : "s"}`,
    conversations: n => `${n} chat or helper conversation${n === 1 ? "" : "s"} still answering`,
    stopping: n => `${n} task stop${n === 1 ? "" : "s"} still settling`,
    coding: n => `${n} coding session${n === 1 ? "" : "s"} open`,
    codingDeliveries: n => `${n} coding submission${n === 1 ? "" : "s"} being delivered`,
    terminals: n => `${n} live terminal${n === 1 ? "" : "s"} open`,
  };
  return Object.entries(work).filter(([, n]) => n > 0).map(([key, n]) => words[key]?.(n) ?? `${key} ${n}`).join(", ");
}
/** The refusal when work is still running: what it is, that the deployment doesn't wait, and what to do. */
export function activeWorkRefusal(work) {
  return `Current work must finish first: ${activeWorkWords(work)}. The deployment checks once and doesn't wait: let it finish, or stop or close it in the console, then run the deployment again (\`toolroll release\` waits for running work within its quiet limit).`;
}

/** The journaled phases of one deployment. The paths, runtimes and records are the command line's; the effects are
 * the plane's records (facts, quiet; reserve, the put-away reservation each proving phase refreshes), the services (service, verifyServiceStopped, spawnSync for launchctl, ps,
 * pgrep and curl), the staged runtime (proveStaged, load, loadCodingDeploymentRuntime), fetch, sleep, say,
 * requireTrue (which ends the deployment) and pruneStaged. processes() lists every process (deploy-stop.mjs
 * listProcesses). Recovery observes exit but never signals processes from historical journal data. */
export function browserDeployment({
  database, stageDir, stateDir, journalFile, plist, livePlist, priorDist, nextDist, uid, label, servicePort, runId, candidateHead, publicUrl, script, oldRt, deploymentLock, signal,
  facts, reserve, quiet, service, proveStaged, verifyServiceStopped, leftFrom, load, loadCodingDeploymentRuntime, spawnSync, fetch, sleep, say, requireTrue, pruneStaged,
  processes, now = Date.now, home = homedir(),
}) {
  const short = candidateHead.slice(0, 7);
  const assertLocked = () => deploymentLock.assertHeld(journalFile);
  const checkpoint = () => { assertLocked(); signal?.throwIfAborted(); };
  // Await settlement, never race an open SQLite backup against cancellation.
  const settle = async promise => { const result = await promise; checkpoint(); return result; };
  const readJournal = () => { assertLocked(); return JSON.parse(readFileSync(journalFile, "utf8")); };
  // A journal is only ever written with a word of the phase table (deploy-phase-table.mjs): every reader decides from it.
  const save = (r, phase) => { assertLocked(); assertDeployPhase(phase); r.phase = phase; r.updatedAt = new Date().toISOString(); noteMilestone(r, phase); oldRt.update.durableJson(journalFile, r); say(`• ${phase}`); };
  // Every phase that proves the candidate refreshes its reservation against being put away (v145,
  // docs/plans/task-tidy.md), never inside another handle's transaction. A deployment that can't reserve doesn't go on.
  const refreshReservation = proven => {
    requireTrue(typeof reserve === "function", "The deployment can't reserve its task against being put away.");
    reserve(proven);
  };
  const answered = response => response && (response.ok || response.status === 303 || response.status === 302);
  // finish needs the configured HTTPS console. One already down stops the deployment before it pauses work or stops
  // the old service, never only after the new service started, where finishing forward is all that is left.
  const requireRemoteConsole = async (task, unchanged) => {
    if (!publicUrl) return;
    const response = await fetch(`${publicUrl}/t/${encodeURIComponent(task)}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
    checkpoint();
    requireTrue(answered(response), `The configured HTTPS console (${publicUrl}) does not answer, so ${unchanged}. Bring it back (for example \`tailscale up\`) and continue the release.`);
  };
  const loadPhase = phase => {
    checkpoint();
    // The plane's records are re-read before every phase, not only at entry:
    // a revoked approval or a changed command between phases stops the swap.
    const current = (() => { const db = openDeploymentDatabase(database, { readOnly: true }); try { return facts(db); } finally { db.close(); } })();
    // Proven on a read-only handle; the reservation against being put away is refreshed on its own writable one (v145).
    refreshReservation(current);
    const r = readJournal();
    requireTrue(current.completion.digest === r.completion?.digest && current.gateDigest === r.gateDigest, "The completed result or its passing check changed since staging.");
    requireTrue(r.phase === phase && r.candidate === candidateHead && r.database === database, `Journal is at ${r.phase} for ${r.candidate?.slice(0, 7)}, expected ${phase} for ${short}.`);
    requireTrue(r.builder === runId && r.nextRuntime === nextDist, "The journal belongs to a different run or staging directory.");
    const packed = readdirSync(stageDir).find(f => f.endsWith(".tgz"));
    requireTrue(packed && sha(readFileSync(join(stageDir, packed))) === r.packageSha256, "The staged package changed since it was proved.");
    proveStaged();
    return r;
  };
  function assertPreserved(db, before) {
    for (const table of before) { const after = digest(db, table.name, table.columns); requireTrue(after.count === table.count && after.hash === table.hash, `Historical rows changed: ${table.name}`); }
    requireTrue(db.prepare("PRAGMA integrity_check").get().integrity_check === "ok" && db.prepare("PRAGMA foreign_key_check").all().length === 0, "Database integrity or foreign-key failure.");
  }
  /** After a schema change: history differs only as the new runtime's update rules allow (the same check `toolroll update` makes). */
  function assertMigrated(db, history, before) {
    const changed = history.changedHistory(db, before);
    requireTrue(changed.length === 0, `Historical rows changed: ${changed.join(", ")}`);
    requireTrue(db.prepare("PRAGMA integrity_check").get().integrity_check === "ok" && db.prepare("PRAGMA foreign_key_check").all().length === 0, "Database integrity or foreign-key failure.");
  }

  // A failed deployment must not leave the plane paused or down. A refusal before the swap stopped
  // anything (a rehearsal that fails, a backup that doesn't verify, a failure while the pause was
  // being installed) lifts this deployment's own pause. A failure after the old service was proved stopped (a coding check, a migration, a
  // service that will not load) starts the previous service again from its saved definition — on
  // the verified backup when the live database was migrated past what it reads — waits for it to
  // answer, and lifts the pause too. Ctrl-C and a kill take the same path. A restore that cannot
  // finish leaves the service stopped and names the command that resumes it.
  let recoveryAttempted = false;
  function recoverJournal() {
    assertLocked();
    if (recoveryAttempted || !existsSync(journalFile)) return true;
    recoveryAttempted = true;
    let r;
    try { r = readJournal(); } catch { return false; }
    try {
      // Re-prove at every destructive recovery use, even if a historical journal already says "stopped".
      const stopped = () => serviceGone(r);
      // The previous service is the one this run's definition names. A run that reads the definition the swap
      // installed (any phase but recover) has the new runtime there, and would start that on the restored database.
      const requireStopped = () => {
        if (priorDist !== r.priorRuntime) throw Error(`This run reads the service definition the deployment installed, not the one it replaced; nothing was put back. Use --phase recover with --stage ${stageDir}.`);
        if (!stopped()) throw Error("The service is not proved stopped; its database and definition were left in place.");
      };
      const words = recoverFailedDeployment(r.phase, {
        stopProved: stopped,
        // A stale journal cannot authorize stopping a newly healthy service, even at the same runtime path.
        // Recovery observes exit only; normal shutdown belongs to the current service owner.
        // The previous definition goes back before the database does (Codex build review, finding 1). Until now the
        // installed definition named the new runtime, which would start on the restored database and migrate it
        // again if anything loaded the label (a login, a person) before the definition was replaced. From here a
        // load starts the previous runtime, which refuses a newer database. Absence is proved on both sides of the
        // write, and restorePriorService refuses a label it finds loaded.
        restoreBackup: () => {
          requireStopped();
          writeFileSync(plist, livePlist);
          if (!stopped()) throw Error("The service was loaded while its previous definition was put back; the database was left as it is.");
          return restoreDeploymentBackup(r, { database, stageDir });
        },
        restoreService: () => { requireStopped(); restorePriorService(r); },
        removeGate: () => {
          const db = openDeploymentDatabase(database);
          try {
            if (!oldRt.gate.updateGateOwned(db, r.id)) return false;
            const fresh = readJournal();
            if (JSON.stringify(fresh) !== JSON.stringify(r)) throw Error("The deployment journal changed during recovery; the pause was left in place.");
            oldRt.gate.removeUpdateGate(db, r.id);
            return true;
          } finally { db.close(); }
        },
        mark: phase => { assertDeployPhase(phase); r.phase = phase; r.updatedAt = new Date().toISOString(); noteMilestone(r, phase); oldRt.update.durableJson(journalFile, r); },
      }, { previousRuntimeCompatible: r.schema === r.nextSchema && r.rehearsal?.previousRuntimeCompatible === true });
      keepDeployTimeline(database, r);
      if (words) console.error(words);
      else if (r.phase === "preparing") console.error(`The deployment stopped while preparing, before it paused new work (update ${r.id}); nothing was paused. Rerun --phase prepare with --stage ${stageDir} to resume it.`);
      else if (r.phase === "starting") console.error(`The deployment stopped while the new service was starting, before anything recorded whether it came up. Nothing was stopped and new work stays paused (update ${r.id}). Run the release again: it finishes the deployment when the new service is running, and puts the previous service back when the new one is proved gone.`);
      else if (!NEEDS_NO_RECOVERY.includes(r.phase)) console.error(`The deployment stopped at ${r.phase}, where the old service is not proved stopped or the new one may be running. New work stays paused (update ${r.id}); inspect ${journalFile}. \`toolroll release --recover-deploy\` shows what recovery can still do.`);
      const done = words !== null || stoppedWhereNothingChanged(r.phase);
      // Only a finished recovery latches: a refused one (old processes still running) may be retried in this process.
      if (!done) recoveryAttempted = false;
      return done;
    } catch (error) {
      console.error(`✗ The previous service was not started again (update ${r.id}, at ${r.phase}): ${error.message}`);
      console.error(`  The previous service is not confirmed running and new work stays paused. Once the cause is fixed, run \`toolroll release --recover-deploy --yes\` (or: node ${script} --run ${runId} --stage ${stageDir} --phase recover).`);
      return false;
    }
  }
  // A journal has no process birth identity. A present PID is ambiguous, regardless of mutable argv.
  const aliveAsService = (pid, dists) => {
    const rows = typeof processes === "function" ? processes() : null;
    if (rows === null || rows === undefined) return spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" }).status !== 1;
    return recordedStillRunning(rows, pid, { dists, database });
  };
  /** Every process the journal recorded for the service it stopped is gone, nothing of the previous or the new
   * runtime runs on this database, and launchd has no service under the label. Observed, never caused. */
  const serviceGone = r => {
    const dists = [...new Set([priorDist, r.priorRuntime, r.nextRuntime].filter(one => typeof one === "string" && one !== ""))];
    return stopProved(r, { alive: pid => aliveAsService(pid, dists),
      remaining: () => dists.flatMap(dist => leftFrom?.(dist) ?? ["unreadable runtime processes"]),
      loaded: () => spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" }).status !== 113 }) && newServiceStopGone(r);
  };
  /** Once a journal records a stop of the new service, every process it recorded must have exited too, whatever state
   * the record is in (plan §8): the recorded set is only ever a list of processes that must be gone. */
  const newServiceStopGone = r => r.newServiceStop === undefined || recordedLeft(listed(), r.newServiceStop?.pids).length === 0;
  /** Today's message when the new service is not proved gone (docs/plans/deploy-phase-table.md), word for word. */
  const stillLoaded = `The new service is still loaded or still has processes, so the previous one was not put back. Nothing was stopped and the journal stays at starting. If it is running, run the release again to finish the deployment. If it never answers, stop it (launchctl bootout gui/${uid}/${label}), then run the release again.`;
  /**
   * `--phase recover` at "starting", before the recovery above: the deployment was killed while it waited for the new
   * service, so nothing recorded whether that service came up, and a journal alone never rolls a started service back.
   * A new service still loaded is stopped only by stopNewService below: one `launchctl bootout` of this label, after it
   * proved the installed definition is the one this deployment wrote and the loaded process is this deployment's new
   * runtime on this database, and that it never started completely while this run watched. Only when the new service
   * is proved gone (not loaded, no process of either runtime on this database, nothing it recorded still running) and
   * the pause is still this deployment's does it make the checks a failed start makes inside swap() (the coding backup,
   * and the new runtime's own proof that no coding agent of it is left) and journal "start-failed", which the recovery
   * then undoes like any failed start. Anything it cannot prove leaves the journal at "starting" and says why. Returns
   * whether it journaled.
   */
  async function proveStartFailed() {
    checkpoint();
    const r = readJournal();
    if (r.phase !== "starting") return false;
    const kept = "Nothing was stopped and the journal stays at starting.";
    // Only from the deployment's own saved definition and staging directory, on its own database.
    requireTrue(priorDist === r.priorRuntime && nextDist === r.nextRuntime && database === r.database && candidateHead === r.candidate, `This recovery does not match the deployment's recorded runtimes, database or commit. ${kept}`);
    const stillOurs = db => oldRt.gate.updateGateOwned(db, r.id);
    const proveGone = () => requireTrue(serviceGone(r), stillLoaded);
    // Loaded and never started completely: recovery stops it itself only once it has proved the facts of plan §4, and
    // otherwise says why it did not, after today's message (stopNewService below).
    if (!serviceGone(r)) await stopNewService(r);
    proveGone();
    // The new runtime's own code answers for its coding agents below: prove it is the recorded commit before loading it.
    proveStaged();
    const coding = await settle(loadCodingDeploymentRuntime(nextDist));
    await ensureCodingBackup(coding, r);
    verifyCodingBackup(coding, r);
    const db = openDeploymentDatabase(database, { readOnly: true });
    try {
      assertCodingDeploymentStopped(coding, database, db, r);
      // Proved again with nothing awaited between the proof and the write.
      requireTrue(stillOurs(db), `New work is no longer paused by this deployment (update ${r.id}). ${kept}`);
      proveGone();
      save(r, "start-failed");
    } finally { db.close(); }
    return true;
  }
  // ---- The stop of a new service that never started completely (docs/plans/recovery-stops-silent-service.md) ----
  // The only act is one `launchctl bootout gui/<uid>/<label>` of this run's own label in its own GUI domain. No pid is
  // ever signalled here: the recorded `{ pid, start }` set is only a list of processes that must be proved gone.
  /** Every subprocess the stop runs is bounded (plan §8): a timeout per call, a fixed PATH and locale. */
  const bounded = boundedRunner(spawnSync);
  /** One whole process listing through a bounded `ps` (deploy-stop.mjs listProcesses), or null. */
  const listed = () => listProcesses((command, args, options) => { try { return spawnSync(command, args, { ...options, timeout: CALL_MS }); } catch (error) { return { status: null, error }; } });
  /** A refusal of the stop, before its act: nothing was stopped. `reason` is the fixed reason the journal keeps. */
  class Kept extends Error { constructor(message, reason) { super(message); this.reason = reason; } }
  /** A call whose outcome is not known: a timeout, a signal, a spawn error or an exit status it can't read. */
  class Unsure extends Error {}
  const WHY = Object.freeze({
    record: "the deployment journal does not name this service",
    earlier: "its record of an earlier stop cannot be read",
    placement: "the deployment folder is not in Toolroll's own folder",
    link: "a deployment file is a link or not a plain file",
    definition: "the installed service definition is not the one this deployment installed",
    job: "launchd's loaded job is not this deployment's definition",
    noProcess: "launchd shows no running process for the service",
    notLoaded: "launchd does not have the service loaded, but some of its processes have not exited",
    notOurs: "the running process is not the new runtime's service on this database",
    tree: "the service's processes could not all be listed",
    runtime: "a runtime folder could not be read",
    sameRuntime: "the new and previous runtimes are the same folder",
    outside: "the new runtime is not in the deployment folder",
    prior: "a process of the previous version is still running",
    pause: "new work is no longer paused by this deployment",
    changed: "the service changed while recovery was checking it",
    journal: "the deployment journal changed while recovery was checking it",
    answered: `its console answered http://127.0.0.1:${servicePort}/healthz`,
    unsure: "a check of the service did not finish or could not run",
    late: "the checks took longer than recovery allows",
    unwritten: "its record of the stop could not be written",
  });
  const keep = why => new Kept(`${stillLoaded} Recovery did not stop it itself because ${why}.`, why);
  const completed = () => new Kept("The new service started all its processes while recovery was waiting. Nothing was stopped and the journal stays at starting. Run the release again to finish the deployment.", "the service started all its processes");
  const refusal = error => error instanceof Kept || signal?.aborted ? error : keep(WHY.unsure);
  const notProved = detail => `The new service was asked to stop, but it is not proved stopped (${detail}). Nothing was put back and the journal stays at starting. Run the release again once it has stopped.`;
  const bootoutError = status => `launchctl bootout returned an error (exit ${status}), so it is not known whether the new service stopped. Recovery did nothing more and the journal stays at starting. Run the release again: it checks again before doing anything.`;
  const unrecorded = "The new service stopped, but recovery could not record that. Nothing was put back and the journal stays at starting. Run the release again.";
  const target = `gui/${uid}/${label}`;
  /** A bounded call with a numeric exit status, or Unsure. */
  const call = (command, args, ms = CALL_MS) => { const out = bounded(command, args, ms); if (uncertain(out)) throw new Unsure(command); return out; };
  const lstatOrNull = path => { try { return lstatSync(path); } catch { return null; } };
  const plainFile = path => { try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; } };
  const write = r => { assertLocked(); oldRt.update.durableJson(journalFile, r); };
  /** Settles the record after its request was written. Best effort: a record left at "requested" is read as uncertain. */
  const settleRecord = (r, fields) => { r.newServiceStop = { ...r.newServiceStop, ...fields, settledAt: new Date().toISOString() }; try { write(r); } catch { /* left at requested */ } };
  /** F1 (placement): the real stage is a direct child of the real <state>/staged-upgrades, the state folder holds the
   * database and is Toolroll's own by the fence's test, and the journal and both definitions are plain files. */
  const placement = () => {
    let state, staged, stage, db, own;
    try {
      if (journalFile !== join(stageDir, "deployment.json")) return WHY.placement;
      if (lstatSync(stageDir).isSymbolicLink()) return WHY.link;
      state = realpathSync(stateDir); staged = realpathSync(join(stateDir, "staged-upgrades")); stage = realpathSync(stageDir); db = realpathSync(database);
      own = ownStateFolder(state, (() => { try { return realpathSync(home); } catch { return home; } })());
    } catch { return WHY.placement; }
    if (staged !== join(state, "staged-upgrades") || dirname(stage) !== staged || dirname(db) !== state || !own || existsSync(join(staged, ".git"))) return WHY.placement;
    for (const file of [journalFile, join(stageDir, "browser.next.plist"), join(stageDir, "browser.saved.plist")]) {
      if (plainFile(file)) continue;
      if (existsSync(file) || lstatOrNull(file) !== null) return WHY.link;
      // Missing: the definition this deployment wrote is F3's to refuse; anything else is not this deployment's folder.
      return file === join(stageDir, "browser.next.plist") ? WHY.definition : WHY.placement;
    }
    return { stage };
  };
  /** F3: the installed definition is, byte for byte, the one this deployment wrote and recorded; null otherwise. */
  const definition = named => {
    try {
      const next = join(stageDir, "browser.next.plist");
      if (!plainFile(next)) return null;
      const ours = readFileSync(next), installed = readFileSync(plist);
      if (!ours.equals(installed) || sha(ours) !== named.nextPlistSha256) return null;
      const text = ours.toString("utf8");
      const args = text.includes(`${nextDist}/cli.js`) ? programArguments(text) : null;
      return args === null ? null : { text, args };
    } catch { return null; }
  };
  /** F6: the runtimes by real path, readable, distinct, and the new one inside the real stage; a reason otherwise. */
  const runtimes = (r, stage) => {
    let next, prior, recorded;
    try { next = realpathSync(nextDist); prior = realpathSync(priorDist); recorded = realpathSync(r.priorRuntime); } catch { return WHY.runtime; }
    if (next === prior || next === recorded) return WHY.sameRuntime;
    return next.startsWith(stage + sep) ? null : WHY.outside;
  };
  /** F6: a process of the previous runtime on this database, as leftFrom tells it (deploy-stop.mjs serviceProcesses),
   * except a row it counts only because its command has `up --db <database>` without naming the previous runtime:
   * that is the new service itself. */
  const priorRunning = (rows, r) => {
    const dists = [...new Set([priorDist, r.priorRuntime])];
    const folders = spellings(dists).map(dist => `${dist}/`);
    const found = serviceProcesses(rows, { dists, database });
    return found.targets.length > 0 || found.unproven.some(row => folders.some(folder => row.command.includes(folder)));
  };
  const pausedByUs = r => {
    try { const db = openDeploymentDatabase(database, { readOnly: true }); try { return oldRt.gate.updateGateOwned(db, r.id) === true; } finally { db.close(); } }
    catch { return false; }
  };
  /** F4: launchd's job under the label, read strictly: { loaded: false } on 113, else what it shows (null if unreadable). */
  const job = () => {
    const out = call("/bin/launchctl", ["print", target]);
    if (out.status === 113) return { loaded: false };
    if (out.status !== 0) throw new Unsure("launchctl print");
    return { loaded: true, seen: parseLaunchdPrint(String(out.stdout ?? ""), target) };
  };
  const sameJob = (seen, def) => seen.path === plist && JSON.stringify(seen.arguments) === JSON.stringify(def.args);
  /** F4: loaded, running one process, from exactly this definition's path and arguments. */
  const loadedAsDefined = def => {
    const current = job();
    if (!current.loaded) throw keep(WHY.notLoaded);
    if (current.seen === null) throw keep(WHY.job);
    if (current.seen.state !== "running" || current.seen.pid === null) throw keep(WHY.noProcess);
    if (!sameJob(current.seen, def)) throw keep(WHY.job);
    return current.seen;
  };
  /** The same job as first seen: still loaded and running, the same pid, path and arguments. */
  const stillSame = (first, def) => {
    const current = job();
    if (!current.loaded || current.seen === null || current.seen.state !== "running" || current.seen.pid !== first.pid || !sameJob(current.seen, def)) throw keep(WHY.changed);
  };
  /** F5 and F6 over one listing: the pid is this runtime's supervisor on this database with parent 1, its tree is
   * whole, and nothing of the previous runtime runs. */
  const observe = (pid, r) => {
    const rows = listed();
    if (rows === null) throw keep(WHY.tree);
    const top = rows.find(row => row.pid === pid);
    if (top === undefined || top.ppid !== 1 || commandKind(top.command, { dist: nextDist, database }) !== "supervisor") throw keep(WHY.notOurs);
    const tree = treeOf(rows, pid);
    if (tree === null) throw keep(WHY.tree);
    if (priorRunning(rows, r)) throw keep(WHY.prior);
    return { rows, top, tree };
  };
  const healthy = () => {
    const out = call("/usr/bin/curl", ["-fsS", "-m", "2", `http://127.0.0.1:${servicePort}/healthz`]);
    if (out.status !== 0) return false;
    try { return JSON.parse(String(out.stdout)).status === "ok"; } catch { return false; }
  };
  /** For service(): each call bounded, and a definite answer or a throw (deploy-browser.mjs). */
  const serviceCall = (command, args) => call(command, args);
  /** What is still there after the act, in words (empty: proved gone). */
  const stillThere = (r, def) => {
    const left = [];
    const out = bounded("/bin/launchctl", ["print", target]);
    if (uncertain(out) || (out.status !== 0 && out.status !== 113)) left.push("launchd's answer could not be read");
    else if (out.status === 0) left.push("launchd still has it loaded");
    const rows = listed();
    left.push(...recordedLeft(rows, r.newServiceStop.pids));
    if (rows !== null) {
      for (const dist of [nextDist, priorDist, r.priorRuntime]) {
        const found = serviceProcesses(rows, { dists: [dist], database });
        for (const row of [...found.targets, ...found.unproven]) left.push(`process ${row.pid}`);
      }
      for (const pid of recordedServicePids(r)) if (!(Number.isInteger(pid) && pid > 1) || rows.some(row => row.pid === pid)) left.push(`process ${pid}`);
    }
    const installed = definition(r.launchd);
    if (installed === null || installed.text !== def.text) left.push("the installed service definition changed");
    return [...new Set(left)];
  };
  const leftWords = left => left.map(one => /^process \S+$/.test(one) ? `${one} is still running` : one).join("; ");

  /**
   * `--phase recover` at "starting" when the new service is not proved gone: stop it, once, only when every fact of
   * plan §4 holds. A: the facts and the full wait, then the observed { pid, start } set (a listing that can't be read
   * whole refuses before anything is written). B: the intent, written durably. C: the last checks, ending with the
   * structure read and then `launchctl print`. D: the bootout. E–H: its exit status and the observed proof of absence.
   * Returns once absence is proved and recorded; otherwise throws the words to say, with nothing restored.
   */
  async function stopNewService(r) {
    const deadline = now() + HEALTH_WAIT_MS + ABSENCE_MS + 60_000;
    const late = () => now() > deadline;
    let def, first, observed, stage;
    // A: the facts, and the wait.
    try {
      const placed = placement();
      if (typeof placed === "string") throw keep(placed);
      stage = placed.stage;
      const named = r.launchd;
      if (named === null || typeof named !== "object" || named.uid !== uid || named.label !== label || named.plist !== plist ||
        typeof named.nextPlistSha256 !== "string" || !/^[0-9a-f]{64}$/.test(named.nextPlistSha256)) throw keep(WHY.record);
      if (r.newServiceStop !== undefined && (r.newServiceStop === null || typeof r.newServiceStop !== "object" || !Array.isArray(r.newServiceStop.pids))) throw keep(WHY.earlier);
      def = definition(named);
      if (def === null) throw keep(WHY.definition);
      if (!pausedByUs(r)) throw keep(WHY.pause);
      const runtime = runtimes(r, stage);
      if (runtime !== null) throw keep(runtime);
      first = loadedAsDefined(def);
      const start = observe(first.pid, r).top.start;
      // F7: watched by this run for as long as the swap would have waited, once a second.
      for (let i = 0; i < HEALTH_WAIT_MS / 1000; i++) {
        if (late()) throw keep(WHY.late);
        if (service(nextDist, serviceCall) !== null) throw completed();
        stillSame(first, def);
        if (healthy()) throw keep(WHY.answered);
        await settle(sleep(1000));
      }
      if (late()) throw keep(WHY.late);
      observed = observe(first.pid, r);
      if (observed.top.start !== start) throw keep(WHY.changed);
    } catch (error) { throw refusal(error); }

    // B: the intent, with every recorded process, written before the act.
    try {
      if (JSON.stringify(readJournal()) !== JSON.stringify(r)) throw keep(WHY.journal);
      const earlier = r.newServiceStop;
      r.newServiceStop = { state: "requested", at: new Date().toISOString(), label, pids: mergeRecorded(earlier?.pids, observed.tree),
        attempts: (Number.isSafeInteger(earlier?.attempts) && earlier.attempts > 0 ? earlier.attempts : 0) + 1 };
      noteMilestone(r, "stopping the new service");
      write(r);
    } catch (error) { throw error instanceof Kept ? error : keep(WHY.unwritten); }

    // C: the last checks, in order; the structure read and then launchd's own answer are the last reads before the act.
    try {
      if (late()) throw keep(WHY.late);
      const again = definition(r.launchd);
      if (again === null || again.text !== def.text) throw keep(WHY.definition);
      if (!pausedByUs(r)) throw keep(WHY.pause);
      const runtime = runtimes(r, stage);
      if (runtime !== null) throw keep(runtime);
      const rows = listed();
      if (rows === null) throw keep(WHY.tree);
      if (priorRunning(rows, r)) throw keep(WHY.prior);
      const top = rows.find(row => row.pid === first.pid);
      if (top === undefined || top.start !== observed.top.start || top.ppid !== 1 || commandKind(top.command, { dist: nextDist, database }) !== "supervisor") throw keep(WHY.changed);
      const tree = treeOf(rows, first.pid);
      if (tree === null) throw keep(WHY.tree);
      // A process not in the recorded set may be the service completing its structure.
      if (tree.some(one => !r.newServiceStop.pids.some(kept => kept?.pid === one.pid && kept?.start === one.start))) throw keep(WHY.changed);
      if (healthy()) throw keep(WHY.answered);
      if (service(nextDist, serviceCall) !== null) throw completed();
      stillSame(first, def);
    } catch (error) {
      const kept = refusal(error);
      settleRecord(r, { state: "failed", acted: false, reason: kept instanceof Kept ? kept.reason : "recovery was interrupted" });
      throw kept;
    }

    // D: the one act.
    say(`Stopping the new service: it is loaded but has not started all its processes for ${HEALTH_WAIT_MS / 1000} seconds (process ${first.pid}).`);
    const out = bounded("/bin/launchctl", ["bootout", target], BOOTOUT_MS);
    // E: its outcome. A non-zero status may have had a partial effect: nothing more this run (Q4).
    if (uncertain(out)) {
      settleRecord(r, { state: "uncertain", acted: true, reason: "launchctl bootout did not finish" });
      throw Error(notProved("launchctl bootout did not finish"));
    }
    if (out.status !== 0) {
      settleRecord(r, { state: "failed", acted: true, exitStatus: out.status, reason: "launchctl bootout returned an error" });
      throw Error(bootoutError(out.status));
    }
    // F: absence, observed, within the deadline.
    const until = Math.min(deadline, now() + ABSENCE_MS);
    let left;
    try {
      for (;;) {
        left = stillThere(r, def);
        if (left.length === 0 || now() >= until) break;
        await settle(sleep(1000));
      }
    } catch { left = [...(left ?? []), "recovery stopped before it finished checking"]; }
    // H: not proved.
    if (left.length > 0) {
      settleRecord(r, { state: "uncertain", acted: true, reason: "absence not proved", left: left.slice(0, 20) });
      throw Error(notProved(leftWords(left)));
    }
    // G: proved; the failed start is journaled as before (proveStartFailed).
    r.newServiceStop = { ...r.newServiceStop, state: "stopped", settledAt: new Date().toISOString() };
    noteMilestone(r, "stopped the new service");
    try { write(r); } catch { throw Error(unrecorded); }
    say("Stopped the new service. Putting the previous version back.");
  }

  /** The previous definition, loaded again once its processes were proved gone, and only on the schema it runs.
   * Restored means it runs from its runtime and answers /healthz. */
  function restorePriorService(r) {
    const check = openDeploymentDatabase(database, { readOnly: true });
    let version;
    try { version = check.prepare("SELECT version FROM schema_version").get().version; } finally { check.close(); }
    if (version !== r.schema) throw Error(`the live database is at schema ${version} and the previous runtime runs schema ${r.schema}; it was not started on it`);
    // bootstrap refuses an existing label atomically; never boot out a replacement found during recovery.
    if (spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" }).status !== 113) throw Error("The service label is loaded or unreadable; recovery did not replace it.");
    writeFileSync(plist, livePlist);
    const booted = spawnSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
    if (booted.status !== 0) throw Error(`launchctl bootstrap failed: ${booted.stderr}`);
    let why = "it has not started yet";
    const answers = () => {
      try {
        if (service(priorDist) === null) { why = "its processes are not all running yet"; return false; }
        const health = spawnSync("/usr/bin/curl", ["-fsS", "-m", "2", `http://127.0.0.1:${servicePort}/healthz`], { encoding: "utf8" });
        if (health.status === 0 && JSON.parse(health.stdout).status === "ok") return true;
        why = "its console is not answering yet";
        return false;
      } catch { why = "its console is not answering yet"; return false; }
    };
    const seconds = Math.round(HEALTH_WAIT_MS / 1000);
    if (!waitUntilHealthy(answers, { onWait: (waited, attempts) => { noteMilestone(r, "waiting for the previous service", why); console.error(`  waiting for the previous service (${waited} s of up to ${attempts} s): ${why}${heldWorkers()}`); } })) {
      throw Error(`the previous service was loaded but did not answer http://127.0.0.1:${servicePort}/healthz within ${seconds} seconds (${why}${heldWorkers()})`);
    }
  }

  /** Why a restarted service may not be up yet, from the plane's records: a worker whose last heartbeat still holds its
   * name refuses a fresh start until it lapses (src/runner.ts DEFAULT_LIVENESS_MS), unless its processes were recorded
   * and proved gone. Empty when none is held or the records can't be read. */
  function heldWorkers() {
    try {
      const db = openDeploymentDatabase(database, { readOnly: true });
      try {
        const since = new Date(Date.now() - RUNNER_LIVENESS_MS).toISOString();
        const held = db.prepare("SELECT name, heartbeat_at FROM runner WHERE retired_at IS NULL AND heartbeat_at > ? ORDER BY name").all(since);
        return held.map(one => `; worker ${one.name} is held by its last heartbeat until ${new Date(Date.parse(String(one.heartbeat_at)) + RUNNER_LIVENESS_MS).toISOString()}, then a fresh start takes it over`).join("");
      } finally { db.close(); }
    } catch { return ""; }
  }

  // Persist newly observed custody before the async SQLite snapshot. Every final
  // boundary verifies the retained bytes again after any intervening await.
  function verifyCodingBackup(runtime, r) {
    try { verifyCodingDeploymentBackup(runtime, database, stageDir, r); }
    finally { save(r, r.phase); }
  }
  async function ensureCodingBackup(runtime, r) {
    checkpoint();
    try { observeCodingDeployment(runtime, database, r); }
    finally { save(r, r.phase); }
    try { await backupCodingDeployment(runtime, database, stageDir, r); }
    finally { save(r, r.phase); }
    checkpoint();
    verifyCodingBackup(runtime, r);
  }

  // Validate authority against the same read view as the saved rows, and again
  // against live state after asynchronous copying. Admission remains enforced by
  // the frozen SQL triggers; heartbeats do not need to stop to copy history.
  function verifyPreparedDatabase(db, r) {
    requireTrue(db.prepare("SELECT version FROM schema_version").get().version === r.schema &&
      oldRt.gate.updateGateOwned(db, r.id), "The preparation schema or admission owner changed.");
    quiet(db);
    const current = facts(db);
    requireTrue(current.completion.digest === r.completion.digest && current.gateDigest === r.gateDigest &&
      current.taskId === r.task && current.repo === r.repo && current.scopeDigest === r.scopeDigest,
      "The completed result or its passing check changed during backup.");
  }

  async function prepare(staged) {
    checkpoint();
    // A failure to acquire the admission lock can leave the original preparing
    // journal intact. Reuse its identity; never delete it or mint a second gate.
    const resumed = existsSync(journalFile) ? loadPhase("preparing") : null;
    requireTrue(lstatSync(database).isFile() && !lstatSync(database).isSymbolicLink(), "Unexpected database path.");
    staged = { ...staged, distFiles: proveStaged().distFiles };
    const db = openDeploymentDatabase(database);
    try {
      const schema = db.prepare("SELECT version FROM schema_version").get().version;
      const nextSchema = (await settle(load(nextDist, "store.js"))).SCHEMA_VERSION;
      const f = facts(db);
      // A fresh preparation proves here, not through loadPhase: refresh the reservation before anything is written
      // (this handle holds no transaction; the backup's own proofs below run inside one and only read).
      refreshReservation(f);
      await requireRemoteConsole(f.taskId, "nothing was paused");
      if (!resumed) writeFileSync(join(stageDir, "release.json"), JSON.stringify({ ...f, run: runId, head: candidateHead, at: new Date().toISOString(), ...staged }, null, 1));
      const r = resumed ?? { id: randomUUID(), candidate: candidateHead, database, phase: "preparing", schema, nextSchema, createdAt: new Date().toISOString(), backup: join(stageDir, "orders.backup.db"), priorRuntime: priorDist, nextRuntime: nextDist, builder: runId, completion: f.completion, gateDigest: f.gateDigest, task: f.taskId, repo: f.repo, scopeDigest: f.scopeDigest, ...staged, proofVerdict: f.proofVerdict, manualAcceptance: f.acceptance, publicUrl };
      requireTrue(r.schema === schema && r.nextSchema === nextSchema && r.priorRuntime === priorDist &&
        r.backup === join(stageDir, "orders.backup.db") && !r.backupSha256 && !r.snapshotSha256 && !existsSync(r.backup) &&
        r.task === f.taskId && r.repo === f.repo && r.scopeDigest === f.scopeDigest && r.publicUrl === publicUrl,
        "The preparing deployment's schema, runtime, backup or task identity changed. Preserve the journal and inspect it.");
      observeCodingDeployment(oldRt.coding, database, r);
      quiet(db);
      const currentService = service(priorDist);
      requireTrue(currentService, "The installed service is not running from the runtime its definition names.");
      requireTrue(!resumed || (r.oldService?.supervisor === currentService.supervisor &&
        JSON.stringify(r.oldService.children) === JSON.stringify(currentService.children)),
        "The installed service identity changed since preparation. Preserve the journal and inspect it.");
      if (!resumed) r.oldService = currentService;
      save(r, "preparing");
      for (const [input, output] of [[plist, "browser.saved.plist"], [join(stateDir, "repos.json"), "repos.saved.json"], [join(stateDir, "up-login.txt"), "up-login.saved.txt"], [join(stateDir, ".toolroll-secrets", "up-login.txt"), "up-login.secrets.saved.txt"], [join(stateDir, "console-url"), "console-url.saved.txt"]]) {
        const retained = join(stageDir, output);
        if (!existsSync(input)) { requireTrue(!existsSync(retained), `Saved configuration disappeared: ${input}`); continue; }
        requireTrue(lstatSync(input).isFile() && !lstatSync(input).isSymbolicLink(), `Unexpected configuration path: ${input}`);
        if (existsSync(retained)) requireTrue(lstatSync(retained).isFile() && !lstatSync(retained).isSymbolicLink() &&
          readFileSync(retained).equals(readFileSync(input)), `Saved configuration changed: ${input}`);
        else { copyFileSync(input, retained); chmodSync(retained, 0o600); }
      }
      // The journal above names this pause's owner before it exists: a failure from here on lifts it (recoverJournal),
      // and a hard kill leaves it for `toolroll release --release-gate <id>`, which proves the swap never began.
      oldRt.gate.installUpdateGate(db, r.id); save(r, "admission-paused");
      requireTrue(oldRt.gate.freezeUpdateGate(db, r.id), "Work raced admission; let it finish and rerun.");
      quiet(db); observeCodingDeployment(oldRt.coding, database, r); save(r, "frozen");
      // Gate installation/freezing above commits its short write transaction.
      // Do not hold a writer reservation while scanning, copying or hashing.
      // The worker's latest verified continuous copy (src/live-backup.ts) stands in for a new one only when it is fresh,
      // its schema matches and its content proves equal to this frozen database, liveness rows aside; else as before.
      let before = liveCopyBackup(database, r, view => verifyPreparedDatabase(view, r));
      if (before !== null) say(`• using the continuous copy made ${r.liveCopy.madeAt}: it matches the paused database`);
      else {
        const original = openDeploymentDatabase(database, { readOnly: true });
        try { before = await settle(snapshotBackup(original, r.backup, view => verifyPreparedDatabase(view, r))); } finally { original.close(); }
        chmodSync(r.backup, 0o600);
        const copied = openDeploymentDatabase(r.backup, { readOnly: true });
        try { assertPreserved(copied, before); } finally { copied.close(); }
      }
      await ensureCodingBackup(oldRt.coding, r);
      const fd = openSync(r.backup, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
      r.backupSha256 = sha(readFileSync(r.backup)); r.snapshotSha256 = sha(JSON.stringify(before));
      db.exec("BEGIN");
      try { verifyPreparedDatabase(db, r); } finally { db.exec("ROLLBACK"); }
      save(r, "backup-verified");
    } finally { db.close(); }
  }

  async function swap() {
    const r = loadPhase("rehearsed");
    requireTrue(sha(readFileSync(r.backup)) === r.backupSha256 && r.rehearsal.integrity === "ok", "The verified backup or rehearsal changed.");
    await ensureCodingBackup(oldRt.coding, r);
    await requireRemoteConsole(r.task, "the running service was not stopped");
    // Stop the installed service and prove every old process is gone.
    r.stoppingService = service(priorDist);
    requireTrue(r.stoppingService, "The current service identity could not be verified before shutdown. No runtime was replaced.");
    save(r, "stopping");
    spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { encoding: "utf8" });
    // The supervisor, `up`, and `up`'s console and worker roles: each must have exited before the runtime or the
    // database is touched, and the console's pid may then release its stale coding owner record (round 1, finding 3).
    const oldPids = recordedServicePids(r);
    await settle(verifyServiceStopped(oldPids, priorDist));
    await ensureCodingBackup(oldRt.coding, r);
    // The coding database as the stopped service left it; a failed deployment puts this back with orders.db.
    r.codingBackupBeforeSwap = codingBackupBeforeSwap(r, database);
    save(r, "stopped");
    // An older runtime killed before its close left its coding owner record behind: with every old
    // process proved gone, the candidate's own check releases it (ledgered) instead of failing here.
    // The staged runtime is the proved candidate; its own coding module decides.
    const candidateCoding = await settle(loadCodingDeploymentRuntime(nextDist));
    const released = (() => { const db = openDeploymentDatabase(database); try { return releaseStaleCodingDeployment(candidateCoding, database, db, oldPids, r); } finally { db.close(); } })();
    if (released) { save(r, "stopped"); say(`• released the stopped service's coding record (process ${released.pid})`); }
    // Migrate the live database with the new runtime (a no-op for a same-schema build).
    let before, beforeHistory;
    const history = r.schema === r.nextSchema ? null : await settle(load(nextDist, "toolroll-update.js"));
    let db = openDeploymentDatabase(database);
    try { requireTrue(db.prepare("SELECT version FROM schema_version").get().version === r.schema && oldRt.gate.updateGateOwned(db, r.id), "Expected the owned gate on the live database."); quiet(db); assertCodingDeploymentStopped(oldRt.coding, database, db, r); before = snapshot(db); beforeHistory = history?.historySnapshot(db); } finally { db.close(); }
    save(r, "migrating");
    (await settle(load(nextDist, "store.js"))).openStore(database).close();
    db = openDeploymentDatabase(database, { readOnly: true });
    try { requireTrue(db.prepare("SELECT version FROM schema_version").get().version === r.nextSchema && oldRt.gate.updateGateOwned(db, r.id), "Migration or gate mismatch."); if (r.schema === r.nextSchema) assertPreserved(db, before); else assertMigrated(db, history, beforeHistory); } finally { db.close(); }
    r.migration = { from: r.schema, to: r.nextSchema, preservedTables: before.length, preservedRows: before.reduce((n, t) => n + t.count, 0) };
    save(r, "migrated");
    // Install the new service definition: same arguments, new runtime and log home.
    const nextPlist = livePlist.replaceAll(priorDist, nextDist).replace(/<key>WorkingDirectory<\/key>\s*<string>[^<]*<\/string>/, `<key>WorkingDirectory</key>\n\t<string>${stageDir}</string>`)
      .replace(/(<key>Standard(?:Out|Error)Path<\/key>\s*<string>)[^<]*(<\/string>)/g, `$1${join(stageDir, "service.log")}$2`);
    requireTrue(nextPlist.includes(`${nextDist}/cli.js`) && !nextPlist.includes(priorDist), "The new service definition does not name the new runtime.");
    writeFileSync(join(stageDir, "browser.next.plist"), nextPlist, { mode: 0o600 });
    writeFileSync(join(stageDir, "service.log"), "", { mode: 0o600, flag: "a" });
    // Migration loads asynchronously; backup, service and native custody must still hold.
    await ensureCodingBackup(oldRt.coding, r);
    await settle(verifyServiceStopped(oldPids, priorDist));
    verifyCodingBackup(oldRt.coding, r);
    const beforeReplace = openDeploymentDatabase(database, { readOnly: true });
    try { assertCodingDeploymentStopped(oldRt.coding, database, beforeReplace, r); } finally { beforeReplace.close(); }
    // The launchd job this deployment installs, durable with "starting" below: what recovery's stop of a new service
    // that never started completely must find (docs/plans/recovery-stops-silent-service.md, F2 and F3).
    r.launchd = { uid, label, plist, nextPlistSha256: sha(nextPlist) };
    writeFileSync(plist, nextPlist);
    const booted = spawnSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
    requireTrue(booted.status === 0, `launchctl bootstrap failed: ${booted.stderr}`);
    save(r, "starting");
    let live = null;
    // As long as the restore would wait: a start refused while a stale worker heartbeat lapses is restarted by its
    // supervisor within the window (deploy-recovery.mjs HEALTH_WAIT_MS).
    for (let i = 0; i < HEALTH_WAIT_MS / 1000 && live === null; i++) {
      if (i === 5) noteMilestone(r, "waiting for the new service to start", heldWorkers().replace(/^; /, "") || "its processes are not all running yet");
      await settle(sleep(1000)); live = service(nextDist);
    }
    if (live === null) {
      // A failed health check does not establish process exit. Capture the
      // service's remaining processes before stopping it, and check native
      // custody with the new runtime before restoring the previous definition.
      const launch = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
      const failedPid = Number(launch.stdout.match(/\n\s*pid = (\d+)/)?.[1]);
      requireTrue(launch.status !== 0 || failedPid > 1, "The failed service's process identity is unknown. The previous runtime was not restored.");
      // Its whole tree: the supervisor, its `up`, and `up`'s roles (round 1, finding 3).
      const failedTree = failedPid > 1 ? processTree(failedPid, spawnSync) : [];
      requireTrue(failedTree !== null, "The failed service's child processes could not be checked. The previous runtime was not restored.");
      const failedPids = failedTree;
      spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { encoding: "utf8" });
      await settle(verifyServiceStopped(failedPids, nextDist));
      const coding = await settle(loadCodingDeploymentRuntime(nextDist));
      await ensureCodingBackup(coding, r);
      await settle(verifyServiceStopped(failedPids, nextDist));
      verifyCodingBackup(coding, r);
      const stopped = openDeploymentDatabase(database, { readOnly: true });
      try { assertCodingDeploymentStopped(coding, database, stopped, r); } finally { stopped.close(); }
      // The new runtime may have written the live database: recovery puts the backup back when the previous runtime cannot read it.
      save(r, "start-failed");
      requireTrue(false, "The new service did not come up.");
    }
    r.newService = live;
    save(r, "started");
    await ensureCodingBackup(await settle(loadCodingDeploymentRuntime(nextDist)), r);
  }

  /**
   * finish at "starting": the deployment was killed while it waited for the new service, so nothing recorded whether
   * it came up. This only looks, for as long as swap() would have waited: when the new service runs from the new
   * runtime, on the migrated database, still under this deployment's pause, the journal moves to "started" and finish
   * goes on as after any swap. It starts nothing and stops nothing; a service that is not there leaves the journal at
   * "starting" (the release then asks recovery, proveStartFailed above).
   */
  async function observeStart(r) {
    const loaded = () => spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" }).status !== 113;
    const installedIsOurs = () => {
      try { const ours = readFileSync(join(stageDir, "browser.next.plist"), "utf8"); return ours.includes(`${nextDist}/cli.js`) && readFileSync(plist, "utf8") === ours; } catch { return false; }
    };
    let live = service(nextDist);
    // Nothing starts a service launchd does not have: no waiting for one.
    for (let i = 0; i < HEALTH_WAIT_MS / 1000 && live === null && loaded(); i++) { await settle(sleep(1000)); live = service(nextDist); }
    // Proved together, with nothing awaited before the write.
    const db = openDeploymentDatabase(database, { readOnly: true });
    let migratedAndPaused;
    try { migratedAndPaused = db.prepare("SELECT version FROM schema_version").get().version === r.nextSchema && oldRt.gate.updateGateOwned(db, r.id); } finally { db.close(); }
    live = live === null ? null : service(nextDist);
    requireTrue(live !== null, "The new service is not running from the new runtime. Nothing was stopped and the journal stays at starting.");
    // The service under the label is the one this deployment installed: the definition on disk is still, byte for
    // byte, the one swap() wrote. A definition someone replaced since is theirs, and is not called this deployment's start.
    requireTrue(installedIsOurs(), "The installed service definition is not the one this deployment installed. Nothing was stopped and the journal stays at starting.");
    requireTrue(migratedAndPaused, "The live database is not the migrated one under this deployment's pause. Nothing was stopped and the journal stays at starting.");
    r.newService = live;
    save(r, "started");
  }

  async function finish() {
    checkpoint();
    const phase = readJournal().phase;
    requireTrue(FORWARD_ONLY.includes(phase), `Unexpected finish phase: ${phase}.`);
    const r = loadPhase(phase);
    if (phase === "starting") await observeStart(r);
    const coding = await settle(loadCodingDeploymentRuntime(nextDist));
    await ensureCodingBackup(coding, r);
    const live = service(nextDist);
    requireTrue(live, "The new service is not running from the new runtime.");
    requireTrue(live.commands.some(c => c.includes("--host 127.0.0.1 --port 4180")) || !livePlist.includes("--host 127.0.0.1"), "The backend must remain on its configured loopback address.");
    // The console answers as soon as it listens (project folders are resolved after, src/operate.ts startConsole); a
    // started service is still given a short while to open its port, and each ask has its own bound.
    const until = now() + LOCAL_ANSWER_MS;
    let local = null;
    for (let first = true; ; first = false) {
      const left = until - now();
      if (!first && left <= 0) break;
      local = await fetch(`http://127.0.0.1:4180/t/${encodeURIComponent(r.task)}`, { redirect: "manual", signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, left))) }).catch(() => null);
      if (answered(local)) break;
      const rest = until - now();
      if (rest <= 0) break;
      await settle(sleep(Math.min(1_000, rest)));
    }
    requireTrue(answered(local), `The local console does not answer (asked for ${LOCAL_ANSWER_MS / 1000} s).`);
    let remote = "not configured";
    if (r.publicUrl) {
      const response = await fetch(`${r.publicUrl}/t/${encodeURIComponent(r.task)}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
      requireTrue(answered(response), "The configured HTTPS console is unavailable.");
      remote = `${r.publicUrl} answered ${response.status}`;
    }
    checkpoint();
    const repos = JSON.parse(readFileSync(join(stateDir, "repos.json"), "utf8")).repos ?? [];
    const runner = (livePlist.match(/<string>--runner<\/string>\s*<string>([^<]+)<\/string>/) ?? [])[1];
    const db = openDeploymentDatabase(database, {}, 10000);
    try {
      requireTrue(db.prepare("SELECT version FROM schema_version").get().version === r.nextSchema && oldRt.gate.updateGateOwned(db, r.id), "Unexpected live schema or update owner.");
      let leases = [];
      for (let i = 0; i < HEALTH_WAIT_MS / 1000; i++) {
        leases = repos.map(repo => db.prepare("SELECT repo,heartbeat_at,expires_at FROM watch_lease WHERE runner=? AND repo=?").get(runner, repo));
        if (leases.every(l => l && Date.parse(l.expires_at) > Date.now() && Date.parse(l.heartbeat_at) > Date.now() - 60_000)) break;
        // Said every 30 s: what the new worker is waiting for (a lapsing heartbeat or lease of the stopped one).
        if (i % 30 === 15) { noteMilestone(r, "waiting for the new worker's project leases", heldWorkers().replace(/^; /, "") || "not all fresh yet"); say(`  waiting for the new worker's project leases (${i} s of up to ${HEALTH_WAIT_MS / 1000} s)${heldWorkers()}`); }
        await settle(sleep(1000));
      }
      requireTrue(leases.every(l => l && Date.parse(l.expires_at) > Date.now()), "Project worker leases did not come up fresh.");
      assertPreserved(db, []);
      r.leases = leases; r.remote = remote;
      r.uiCheck = `Machine checks only: local console answered, ${remote}, ${leases.length} project lease(s) fresh. Open the console and inspect a result page yourself.`;
      await ensureCodingBackup(coding, r);
      verifyCodingBackup(coding, r);
      save(r, "healthy"); oldRt.gate.removeUpdateGate(db, r.id); r.deployedAt = new Date().toISOString(); save(r, "deployed");
    } finally { db.close(); }
    keepDeployTimeline(database, r);
    const stagedRemoved = await pruneStaged([nextDist, priorDist, r.priorRuntime]);
    say({ deployed: candidateHead, runtime: nextDist, at: r.deployedAt, projects: r.leases.length, remote, stagedRemoved: stagedRemoved.length });
  }

  return { readJournal, save, loadPhase, assertPreserved, assertMigrated, ensureCodingBackup, verifyPreparedDatabase, prepare, swap, finish, recoverJournal, proveStartFailed };
}

/** A process and every descendant (pgrep -P, level by level, at most four deep: supervisor, `up`, its roles and
 * theirs), or null when a level can't be read. */
export function processTree(root, spawnSync) {
  const all = [root];
  let level = [root];
  for (let depth = 0; depth < 4 && level.length > 0; depth++) {
    const next = [];
    for (const pid of level) {
      const found = spawnSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" });
      if (found.status !== 0 && found.status !== 1) return null;
      for (const child of String(found.stdout ?? "").trim().split(/\s+/).filter(Boolean).map(Number)) if (!all.includes(child)) { all.push(child); next.push(child); }
    }
    level = next;
  }
  return level.length === 0 ? all : null;
}

/** A deployment's milestones (its latency timeline, docs/plans/actors-lessons.md): each phase the first time it is
 * reached and each health wait with its reason, kept in the journal as wall-clock times (phases run in separate
 * processes). Bounded: at most 40, a repeated wait reason is noted once. Phase names and reasons only, never a secret. */
export function noteMilestone(r, name, detail) {
  const marks = Array.isArray(r.timeline) ? r.timeline : (r.timeline = []);
  const last = marks[marks.length - 1];
  if (detail === undefined ? last?.name === name : marks.some(one => one.name === name && one.detail === String(detail).slice(0, 160))) return;
  if (marks.length >= 40) return;
  marks.push({ name, at: new Date().toISOString(), ...(detail === undefined ? {} : { detail: String(detail).slice(0, 160) }) });
}

/** The journal's milestones into the plane's latency_timeline (kind deploy, by task), when its schema has one: the task
 * page's "Where the time went". Best effort: a deployment never fails over its own timeline. */
export function keepDeployTimeline(database, r) {
  try {
    const marks = Array.isArray(r.timeline) ? r.timeline : [];
    const start = Date.parse(r.createdAt);
    if (marks.length === 0 || !Number.isFinite(start) || typeof r.task !== "string") return;
    const milestones = marks.map(one => ({ name: String(one.name).slice(0, 80), ms: Math.max(0, Date.parse(one.at) - start), ...(one.detail === undefined ? {} : { detail: String(one.detail).slice(0, 160) }) }))
      .filter(one => Number.isFinite(one.ms));
    const db = openDeploymentDatabase(database);
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='latency_timeline'").get()) return;
      const total = Math.max(0, ...milestones.map(one => one.ms));
      db.prepare("DELETE FROM latency_timeline WHERE kind = 'deploy' AND subject = ? AND task_id = ? AND started_at = ?").run(String(r.candidate).slice(0, 7), r.task, new Date(start).toISOString());
      db.prepare("INSERT INTO latency_timeline (kind, subject, task_id, run_id, started_at, total_ms, milestones_json) VALUES ('deploy', ?, ?, NULL, ?, ?, ?)")
        .run(String(r.candidate).slice(0, 7), r.task, new Date(start).toISOString(), Math.round(total), JSON.stringify(milestones));
      db.prepare("DELETE FROM latency_timeline WHERE kind = 'deploy' AND id <= (SELECT id FROM latency_timeline WHERE kind = 'deploy' ORDER BY id DESC LIMIT 1 OFFSET 200)").run();
    } finally { db.close(); }
  } catch { /* display only */ }
}

/** Rows a running service rewrites by the second (liveness and display records): their listed columns (null: the
 * whole table) may differ between the continuous copy and the paused database. Every other table and column must be
 * equal, row for row, or the copy isn't used. Restoring such a copy only puts back older heartbeats and sign-in times. */
export const LIVENESS_ROWS = Object.freeze({ runner: ["heartbeat_at"], watch_lease: ["heartbeat_at", "expires_at"], backup_lease: ["holder", "held_until"],
  web_session: ["last_seen"], service_lifecycle: null, latency_timeline: null, live_backup: null });
/** Rows of a table that are a cache's counter, not state: the console's workspace revision (src/workspace-revision.ts). */
const LIVENESS_KEYS = Object.freeze({ service_cursor: ["workspace-content:v1"] });

/** Each table's digest with its liveness columns left out (sqlite_sequence without the liveness tables' counters). */
function comparable(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").all().flatMap(({ name }) => {
    const skip = Object.hasOwn(LIVENESS_ROWS, name) ? LIVENESS_ROWS[name] : [];
    if (skip === null) return [];
    if (name === "sqlite_sequence") {
      const rows = db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all().filter(row => !(Object.hasOwn(LIVENESS_ROWS, row.name) && LIVENESS_ROWS[row.name] === null));
      return [{ name, rows: sha(JSON.stringify(rows)) }];
    }
    const columns = db.prepare("PRAGMA table_info(" + quote(name) + ")").all().map(r => r.name).filter(column => !skip.includes(column));
    if (Object.hasOwn(LIVENESS_KEYS, name)) {
      const keys = new Set(LIVENESS_KEYS[name]);
      const rows = db.prepare("SELECT " + columns.map(quote).join(",") + " FROM " + quote(name)).all().filter(row => !keys.has(row.key)).map(r => JSON.stringify(r)).sort();
      return [{ name, columns, count: rows.length, hash: sha(rows.join("\n")) }];
    }
    return [{ name, columns, ...digest(db, name, columns) }];
  });
}

/**
 * The deployment's backup from the worker's latest verified continuous copy, instead of a new one: only when the plane
 * records one (live_backup), made within its own schedule (≤ every_minutes old), on this schema, a plain file whose
 * bytes still hash to what was verified, and — read in one view with the paused database, after `verify` — equal to it
 * table by table (LIVENESS_ROWS aside) once the database's own triggers (the update pause) are added. Returns the
 * copy's snapshot, or null (nothing left behind) so the caller copies as it always did.
 */
export function liveCopyBackup(database, r, verify, now = Date.now()) {
  let placed = false;
  try {
    let latest;
    const live = openDeploymentDatabase(database, { readOnly: true });
    try {
      if (!live.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_backup'").get()) return null;
      latest = live.prepare("SELECT enabled, every_minutes, latest_file, latest_sha256, latest_at, latest_schema FROM live_backup WHERE id = 1").get();
    } finally { live.close(); }
    if (!latest || Number(latest.enabled) !== 1 || typeof latest.latest_file !== "string" || !/^[a-f0-9]{64}$/.test(String(latest.latest_sha256))) return null;
    const age = now - Date.parse(String(latest.latest_at));
    if (!(age >= 0 && age <= Number(latest.every_minutes) * 60_000) || Number(latest.latest_schema) !== r.schema) return null;
    if (!lstatSync(latest.latest_file).isFile()) return null;
    copyFileSync(latest.latest_file, r.backup, constants.COPYFILE_EXCL);
    placed = true;
    chmodSync(r.backup, 0o600);
    if (sha(readFileSync(r.backup)) !== latest.latest_sha256) throw Error("the copy changed since it was verified");
    const copy = openDeploymentDatabase(r.backup), original = openDeploymentDatabase(database, { readOnly: true });
    let before;
    try {
      original.exec("BEGIN");
      try {
        verify(original);
        for (const trigger of original.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name").all()) {
          if (!copy.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger.name)) copy.exec(trigger.sql);
        }
        const shape = db => JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all());
        if (shape(original) !== shape(copy)) throw Error("its schema differs");
        const mine = comparable(copy), theirs = comparable(original);
        if (JSON.stringify(theirs) !== JSON.stringify(mine)) throw Error(`its rows differ (${theirs.filter((one, at) => JSON.stringify(one) !== JSON.stringify(mine[at])).map(one => one.name).slice(0, 5).join(", ")})`);
      } finally { original.exec("ROLLBACK"); }
      before = snapshot(copy, true);
    } finally { original.close(); copy.close(); }
    const fd = openSync(r.backup, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    r.liveCopy = { file: latest.latest_file, sha256: latest.latest_sha256, madeAt: String(latest.latest_at) };
    return before;
  } catch {
    if (placed) for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(r.backup + suffix, { force: true });
    delete r.liveCopy;
    return null;
  }
}
