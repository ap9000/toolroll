// The browser deployer's journaled phases (scripts/deploy-browser.mjs), apart from its command line so
// tests run the same ordered steps against temporary journals and databases with recorded effects. The
// command line passes the real ones: launchd, the installed and staged runtimes, and the plane's records.
import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { observeCodingDeployment, backupCodingDeployment, verifyCodingDeploymentBackup, assertCodingDeploymentStopped, releaseStaleCodingDeployment, ledgerStaleCodingRelease } from "./deploy-coding.mjs";
import { recoverFailedDeployment, waitUntilHealthy } from "./deploy-recovery.mjs";

export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
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
export function stopProved(r, { alive, loaded }) {
  const pids = [...new Set([r.oldService?.supervisor, ...(r.oldService?.children ?? []), r.stoppingService?.supervisor, ...(r.stoppingService?.children ?? [])])]
    .filter(pid => pid !== undefined && pid !== null);
  return pids.length > 0 && pids.every(pid => Number.isInteger(pid) && pid > 1 && !alive(pid)) && !loaded();
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

/** The journaled phases of one deployment. The paths, runtimes and records are the command line's; the effects are
 * the plane's records (facts, quiet), the services (service, verifyServiceStopped, spawnSync for launchctl, ps,
 * pgrep and curl), the staged runtime (proveStaged, load, loadCodingDeploymentRuntime), fetch, sleep, say,
 * requireTrue (which ends the deployment) and pruneStaged. */
export function browserDeployment({
  database, stageDir, stateDir, journalFile, plist, livePlist, priorDist, nextDist, uid, label, servicePort, runId, candidateHead, publicUrl, script, oldRt,
  facts, quiet, service, proveStaged, verifyServiceStopped, load, loadCodingDeploymentRuntime, spawnSync, fetch, sleep, say, requireTrue, pruneStaged,
}) {
  const short = candidateHead.slice(0, 7);
  const readJournal = () => JSON.parse(readFileSync(journalFile, "utf8"));
  const save = (r, phase) => { r.phase = phase; r.updatedAt = new Date().toISOString(); oldRt.update.durableJson(journalFile, r); say(`• ${phase}`); };
  const loadPhase = phase => {
    // The plane's records are re-read before every phase, not only at entry:
    // a revoked approval or a changed command between phases stops the swap.
    const current = (() => { const db = openDeploymentDatabase(database, { readOnly: true }); try { return facts(db); } finally { db.close(); } })();
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
  // anything (a rehearsal that fails, a backup that doesn't verify) lifts this deployment's own
  // pause. A failure after the old service was proved stopped (a coding check, a migration, a
  // service that will not load) starts the previous service again from its saved definition — on
  // the verified backup when the live database was migrated past what it reads — waits for it to
  // answer, and lifts the pause too. Ctrl-C and a kill take the same path. A restore that cannot
  // finish leaves the service stopped and names the command that resumes it.
  let recoveryAttempted = false;
  function recoverJournal() {
    if (recoveryAttempted || !existsSync(journalFile)) return true;
    recoveryAttempted = true;
    let r;
    try { r = readJournal(); } catch { return false; }
    try {
      const words = recoverFailedDeployment(r.phase, {
        stopProved: () => stopProved(r, { alive, loaded: () => spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" }).status === 0 }),
        restoreBackup: () => restoreDeploymentBackup(r, { database, stageDir }),
        restoreService: () => restorePriorService(r),
        removeGate: () => {
          const db = openDeploymentDatabase(database);
          try { if (oldRt.gate.updateGateOwned(db, r.id)) oldRt.gate.removeUpdateGate(db, r.id); } finally { db.close(); }
        },
        mark: phase => { r.phase = phase; r.updatedAt = new Date().toISOString(); oldRt.update.durableJson(journalFile, r); },
      }, { previousRuntimeCompatible: r.schema === r.nextSchema && r.rehearsal?.previousRuntimeCompatible === true });
      if (words) console.error(words);
      else if (!["preparing", "released", "deployed"].includes(r.phase)) console.error(`The deployment stopped at ${r.phase}, where the old service is not proved stopped or the new one may be running. New work stays paused (update ${r.id}); inspect ${journalFile}.`);
      return words !== null || ["released", "deployed"].includes(r.phase);
    } catch (error) {
      console.error(`✗ The previous service was not started again (update ${r.id}, at ${r.phase}): ${error.message}`);
      console.error(`  The previous service is not confirmed running and new work stays paused. Once the cause is fixed, run: node ${script} --run ${runId} --stage ${stageDir} --phase recover`);
      return false;
    }
  }
  const alive = pid => spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" }).status !== 1;
  /** The previous definition, loaded again once its processes were proved gone, and only on the schema it runs.
   * Restored means it runs from its runtime and answers /healthz. */
  function restorePriorService(r) {
    const check = openDeploymentDatabase(database, { readOnly: true });
    let version;
    try { version = check.prepare("SELECT version FROM schema_version").get().version; } finally { check.close(); }
    if (version !== r.schema) throw Error(`the live database is at schema ${version} and the previous runtime runs schema ${r.schema}; it was not started on it`);
    spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { encoding: "utf8" });
    writeFileSync(plist, livePlist);
    const booted = spawnSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
    if (booted.status !== 0) throw Error(`launchctl bootstrap failed: ${booted.stderr}`);
    const answers = () => {
      try {
        if (service(priorDist) === null) return false;
        const health = spawnSync("/usr/bin/curl", ["-fsS", "-m", "2", `http://127.0.0.1:${servicePort}/healthz`], { encoding: "utf8" });
        return health.status === 0 && JSON.parse(health.stdout).status === "ok";
      } catch { return false; }
    };
    if (!waitUntilHealthy(answers)) throw Error(`the previous service was loaded but did not answer http://127.0.0.1:${servicePort}/healthz within 90 seconds`);
  }

  // Persist newly observed custody before the async SQLite snapshot. Every final
  // boundary verifies the retained bytes again after any intervening await.
  function verifyCodingBackup(runtime, r) {
    try { verifyCodingDeploymentBackup(runtime, database, stageDir, r); }
    finally { save(r, r.phase); }
  }
  async function ensureCodingBackup(runtime, r) {
    try { observeCodingDeployment(runtime, database, r); }
    finally { save(r, r.phase); }
    try { await backupCodingDeployment(runtime, database, stageDir, r); }
    finally { save(r, r.phase); }
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
    // A failure to acquire the admission lock can leave the original preparing
    // journal intact. Reuse its identity; never delete it or mint a second gate.
    const resumed = existsSync(journalFile) ? loadPhase("preparing") : null;
    requireTrue(lstatSync(database).isFile() && !lstatSync(database).isSymbolicLink(), "Unexpected database path.");
    staged = { ...staged, distFiles: proveStaged().distFiles };
    const db = openDeploymentDatabase(database);
    try {
      const schema = db.prepare("SELECT version FROM schema_version").get().version;
      const nextSchema = (await load(nextDist, "store.js")).SCHEMA_VERSION;
      const f = facts(db);
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
      for (const [input, output] of [[plist, "browser.saved.plist"], [join(stateDir, "repos.json"), "repos.saved.json"], [join(stateDir, "up-login.txt"), "up-login.saved.txt"], [join(stateDir, "console-url"), "console-url.saved.txt"]]) {
        const retained = join(stageDir, output);
        if (!existsSync(input)) { requireTrue(!existsSync(retained), `Saved configuration disappeared: ${input}`); continue; }
        requireTrue(lstatSync(input).isFile() && !lstatSync(input).isSymbolicLink(), `Unexpected configuration path: ${input}`);
        if (existsSync(retained)) requireTrue(lstatSync(retained).isFile() && !lstatSync(retained).isSymbolicLink() &&
          readFileSync(retained).equals(readFileSync(input)), `Saved configuration changed: ${input}`);
        else { copyFileSync(input, retained); chmodSync(retained, 0o600); }
      }
      oldRt.gate.installUpdateGate(db, r.id); save(r, "admission-paused");
      requireTrue(oldRt.gate.freezeUpdateGate(db, r.id), "Work raced admission; let it finish and rerun.");
      quiet(db); observeCodingDeployment(oldRt.coding, database, r); save(r, "frozen");
      // Gate installation/freezing above commits its short write transaction.
      // Do not hold a writer reservation while scanning, copying or hashing.
      const original = openDeploymentDatabase(database, { readOnly: true });
      let before;
      try { before = await snapshotBackup(original, r.backup, view => verifyPreparedDatabase(view, r)); } finally { original.close(); }
      chmodSync(r.backup, 0o600);
      const copied = openDeploymentDatabase(r.backup, { readOnly: true });
      try { assertPreserved(copied, before); } finally { copied.close(); }
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
    // Stop the installed service and prove every old process is gone.
    r.stoppingService = service(priorDist);
    requireTrue(r.stoppingService, "The current service identity could not be verified before shutdown. No runtime was replaced.");
    save(r, "stopping");
    spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { encoding: "utf8" });
    const oldPids = [...new Set([r.oldService.supervisor, ...r.oldService.children, r.stoppingService.supervisor, ...r.stoppingService.children])];
    await verifyServiceStopped(oldPids);
    await ensureCodingBackup(oldRt.coding, r);
    // The coding database as the stopped service left it; a failed deployment puts this back with orders.db.
    r.codingBackupBeforeSwap = codingBackupBeforeSwap(r, database);
    save(r, "stopped");
    // An older runtime killed before its close left its coding owner record behind: with every old
    // process proved gone, the candidate's own check releases it (ledgered) instead of failing here.
    // The staged runtime is the proved candidate; its own coding module decides.
    const candidateCoding = await loadCodingDeploymentRuntime(nextDist);
    const released = (() => { const db = openDeploymentDatabase(database); try { return releaseStaleCodingDeployment(candidateCoding, database, db, oldPids, r); } finally { db.close(); } })();
    if (released) { save(r, "stopped"); say(`• released the stopped service's coding record (process ${released.pid})`); }
    // Migrate the live database with the new runtime (a no-op for a same-schema build).
    let db = openDeploymentDatabase(database);
    let before, beforeHistory;
    const history = r.schema === r.nextSchema ? null : await load(nextDist, "toolroll-update.js");
    try { requireTrue(db.prepare("SELECT version FROM schema_version").get().version === r.schema && oldRt.gate.updateGateOwned(db, r.id), "Expected the owned gate on the live database."); quiet(db); assertCodingDeploymentStopped(oldRt.coding, database, db, r); before = snapshot(db); beforeHistory = history?.historySnapshot(db); } finally { db.close(); }
    save(r, "migrating");
    (await load(nextDist, "store.js")).openStore(database).close();
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
    await verifyServiceStopped(oldPids);
    verifyCodingBackup(oldRt.coding, r);
    const beforeReplace = openDeploymentDatabase(database, { readOnly: true });
    try { assertCodingDeploymentStopped(oldRt.coding, database, beforeReplace, r); } finally { beforeReplace.close(); }
    writeFileSync(plist, nextPlist);
    const booted = spawnSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
    requireTrue(booted.status === 0, `launchctl bootstrap failed: ${booted.stderr}`);
    save(r, "starting");
    let live = null;
    for (let i = 0; i < 90 && live === null; i++) { await sleep(1000); live = service(nextDist); }
    if (live === null) {
      // A failed health check does not establish process exit. Capture the
      // service's remaining processes before stopping it, and check native
      // custody with the new runtime before restoring the previous definition.
      const launch = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
      const failedPid = Number(launch.stdout.match(/\n\s*pid = (\d+)/)?.[1]);
      requireTrue(launch.status !== 0 || failedPid > 1, "The failed service's process identity is unknown. The previous runtime was not restored.");
      const failedChildren = failedPid > 1 ? spawnSync("/usr/bin/pgrep", ["-P", String(failedPid)], { encoding: "utf8" }) : null;
      requireTrue(!failedChildren || failedChildren.status === 0 || failedChildren.status === 1, "The failed service's child processes could not be checked. The previous runtime was not restored.");
      const failedPids = failedPid > 1 ? [failedPid, ...failedChildren.stdout.trim().split(/\s+/).filter(Boolean).map(Number)] : [];
      spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { encoding: "utf8" });
      await verifyServiceStopped(failedPids);
      const coding = await loadCodingDeploymentRuntime(nextDist);
      await ensureCodingBackup(coding, r);
      await verifyServiceStopped(failedPids);
      verifyCodingBackup(coding, r);
      const stopped = openDeploymentDatabase(database, { readOnly: true });
      try { assertCodingDeploymentStopped(coding, database, stopped, r); } finally { stopped.close(); }
      // The new runtime may have written the live database: recovery puts the backup back when the previous runtime cannot read it.
      save(r, "start-failed");
      requireTrue(false, "The new service did not come up.");
    }
    r.newService = live;
    save(r, "started");
    await ensureCodingBackup(await loadCodingDeploymentRuntime(nextDist), r);
  }

  async function finish() {
    const phase = readJournal().phase;
    requireTrue(["started", "healthy"].includes(phase), `Unexpected finish phase: ${phase}.`);
    const r = loadPhase(phase);
    const coding = await loadCodingDeploymentRuntime(nextDist);
    await ensureCodingBackup(coding, r);
    const live = service(nextDist);
    requireTrue(live, "The new service is not running from the new runtime.");
    requireTrue(live.commands.some(c => c.includes("--host 127.0.0.1 --port 4180")) || !livePlist.includes("--host 127.0.0.1"), "The backend must remain on its configured loopback address.");
    const local = await fetch(`http://127.0.0.1:4180/t/${encodeURIComponent(r.task)}`, { redirect: "manual" }).catch(() => null);
    requireTrue(local && (local.ok || local.status === 303 || local.status === 302), "The local console does not answer.");
    let remote = "not configured";
    if (r.publicUrl) {
      const response = await fetch(`${r.publicUrl}/t/${encodeURIComponent(r.task)}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
      requireTrue(response && (response.ok || response.status === 303 || response.status === 302), "The configured HTTPS console is unavailable.");
      remote = `${r.publicUrl} answered ${response.status}`;
    }
    const repos = JSON.parse(readFileSync(join(stateDir, "repos.json"), "utf8")).repos ?? [];
    const runner = (livePlist.match(/<string>--runner<\/string>\s*<string>([^<]+)<\/string>/) ?? [])[1];
    const db = openDeploymentDatabase(database, {}, 10000);
    try {
      requireTrue(db.prepare("SELECT version FROM schema_version").get().version === r.nextSchema && oldRt.gate.updateGateOwned(db, r.id), "Unexpected live schema or update owner.");
      let leases = [];
      for (let i = 0; i < 90; i++) {
        leases = repos.map(repo => db.prepare("SELECT repo,heartbeat_at,expires_at FROM watch_lease WHERE runner=? AND repo=?").get(runner, repo));
        if (leases.every(l => l && Date.parse(l.expires_at) > Date.now() && Date.parse(l.heartbeat_at) > Date.now() - 60_000)) break;
        await sleep(1000);
      }
      requireTrue(leases.every(l => l && Date.parse(l.expires_at) > Date.now()), "Project worker leases did not come up fresh.");
      assertPreserved(db, []);
      r.leases = leases; r.remote = remote;
      r.uiCheck = `Machine checks only: local console answered, ${remote}, ${leases.length} project lease(s) fresh. Open the console and inspect a result page yourself.`;
      await ensureCodingBackup(coding, r);
      verifyCodingBackup(coding, r);
      save(r, "healthy"); oldRt.gate.removeUpdateGate(db, r.id); r.deployedAt = new Date().toISOString(); save(r, "deployed");
    } finally { db.close(); }
    const stagedRemoved = await pruneStaged([nextDist, priorDist, r.priorRuntime]);
    say({ deployed: candidateHead, runtime: nextDist, at: r.deployedAt, projects: r.leases.length, remote, stagedRemoved: stagedRemoved.length });
  }

  return { readJournal, save, loadPhase, assertPreserved, assertMigrated, ensureCodingBackup, verifyPreparedDatabase, prepare, swap, finish, recoverJournal };
}
