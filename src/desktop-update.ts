import { createHash, randomUUID } from "node:crypto";
import { closeSync, chmodSync, copyFileSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { backup, DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { bundleHash, readDesktopBundle, verifyDesktopUpdateBundles, type DesktopBundle } from "./desktop-bundle.js";
import { readDesktopConfig, desktopServiceCommand, desktopServiceDefinition, verifyDesktopLiveness, type DesktopConfig } from "./desktop-host.js";
import { daemonStatus } from "./daemon.js";
import { run } from "./exec.js";
import { readSchemaVersion, SCHEMA_VERSION, Store } from "./store.js";
import { activeUpdateWork, freezeUpdateGate, installUpdateGate, removeUpdateGate, updateAdmissionPaused } from "./desktop-update-gate.js";
import { currentDesktopAccess } from "./desktop-access.js";
import { assertCodingUpdateStopped, backupCodingCatalog, codingCatalogExists, releaseStaleCodingOwner, type ReleasedCodingOwner } from "./coding-update.js";
import { processMayBeAlive } from "./process-liveness.js";
import { readDesktopRecoveryView, readDesktopUpdateJournal, supervisorPidsOf, updateRequestIs, type DesktopRecoveryView, type DesktopUpdateJournal, type DesktopUpdatePhase } from "./contracts/update-journal.js";
import type { ContractIssue } from "./contracts/contract.js";

/** Loaded on first use (as backup.ts and store.ts do), so modules that only import this one (the console,
 * and tests that load it in a browser-like environment) never need `node:sqlite` itself. */
function sqlite(): typeof import("node:sqlite") {
  return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
}


type Phase = DesktopUpdatePhase;
/** The update's journal (`desktop-update.json`, and `receipt.json` in its folder): src/contracts/update-journal.ts. */
export type UpdateJournal = DesktopUpdateJournal;
type ServiceState = { state: string; stale?: boolean };
export type UpdateHooks = {
  verify?: (old: DesktopBundle, next: DesktopBundle) => Promise<void>;
  serviceStatus?: (bundle: DesktopBundle, journal: Pick<UpdateJournal, "stateDir" | "label">) => Promise<ServiceState>;
  service?: (action: "start" | "stop", bundle: DesktopBundle, journal: UpdateJournal) => Promise<void>;
  healthy?: (bundle: DesktopBundle, journal: UpdateJournal, since: string) => Promise<boolean>;
  swap?: (journal: UpdateJournal) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** The clock the drain's two-minute limit reads (tests). */
  now?: () => Date;
  healthTimeoutMs?: number;
  /** Fault injection for state-machine tests, never selectable by a CLI flag. */
  checkpoint?: (phase: Phase) => void;
  otherControllers?: (bundle: DesktopBundle, stateDir: string) => Promise<boolean>;
  /** Whether a recorded service process still runs (tests). */
  processAlive?: (pid: number) => boolean;
};
export const updateTerminal = (phase: string) => ["complete", "restored", "cancelled"].includes(phase);
const terminal = updateTerminal;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = (config: DesktopConfig) => digest(config);
const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const journalPath = (state: string) => join(state, "desktop-update.json");
const payload = (j: UpdateJournal) => join(j.workDir, "Updater.app");
const standby = (j: UpdateJournal) => join(j.workDir, "Standby.app");
const atInstalled = (bundle: DesktopBundle, j: UpdateJournal) => ({ ...bundle, path: j.old.path });

/** Durable receipts are private and independent of the app being replaced. */
export function durableJson(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, file);
  if (process.platform !== "win32") {
    const directory = openSync(dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
function save(j: UpdateJournal, phase: Phase, detail: string): void {
  j.phase = phase; j.detail = detail; j.updatedAt = new Date().toISOString();
  durableJson(join(j.workDir, "receipt.json"), j); durableJson(journalPath(j.stateDir), j);
}
function privateFile(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw Error("The update record must be an owner-only regular file.");
}
/** The refusal the hand-written reader gave for the field a saved journal first gets wrong, so callers and people read
 * the same words; fields it never checked read as an invalid record. */
function journalRefusal(issue: ContractIssue): string {
  const [field, inner] = issue.path.split(/[.[]/);
  switch (field) {
    case "old":
      if (inner === undefined || inner === "path") return "The saved update record is invalid. Preserve it and the app backups; nothing was changed.";
      return "The saved update paths or build identities are invalid. Nothing was changed.";
    case "next": case "databaseFile": case "configHash": case "wasRunning": case "backupPath": case "backupHash":
      return "The saved update paths or build identities are invalid. Nothing was changed.";
    case "replacementOccurred": return "The recorded replacement state is invalid. Nothing was changed.";
    case "codingCatalogExpected": return "The recorded coding catalog presence is invalid. Nothing was changed.";
    case "stoppedPids": return "The recorded service processes are invalid. Nothing was changed.";
    case "codingBackupPath": case "codingBackupHash": return "The retained coding backup paths or identity are invalid. Nothing was changed.";
    default: return "The saved update record is invalid. Preserve it and the app backups; nothing was changed.";
  }
}
export function readUpdateJournal(stateDir: string, retainedReceipt?: string): UpdateJournal | null {
  const file = retainedReceipt ?? journalPath(stateDir);
  if (!existsSync(file)) return null;
  privateFile(file);
  const read = readDesktopUpdateJournal(JSON.parse(readFileSync(file, "utf8")));
  if (!read.ok) throw Error(`${journalRefusal(read.issues[0]!)} (${read.issues.map(issue => issue.line).join("; ")})`);
  const j = read.value;
  if (!/^[a-f0-9-]{36}$/.test(j.id) || j.stateDir !== resolve(stateDir) || !isAbsolute(j.old?.path ?? "") || j.workDir !== join(dirname(j.old.path), ".standing-orders-updates", j.id) || !/^[a-zA-Z0-9.-]+$/.test(j.label) || !["install", "restore"].includes(j.intended) || !["prepared", "draining", "backing-up", "stopping", "installing", "verifying", "rolling-back", "releasing", "complete", "restored", "cancelled", "needs-attention"].includes(j.phase)) throw Error("The saved update record is invalid. Preserve it and the app backups; nothing was changed.");
  if (retainedReceipt && retainedReceipt !== join(j.workDir, "receipt.json")) throw Error("The retained recovery receipt is at the wrong path.");
  const validBundle = (b: DesktopBundle) => b && isAbsolute(b.path) && b.path.endsWith(".app") && /^[a-f0-9]{64}$/.test(b.hash) && /^[a-f0-9-]{36}$/.test(b.buildId) && /^\d+\.\d+\.\d+$/.test(b.version) && b.schemaVersion === SCHEMA_VERSION && b.bundleId === (b.development === true ? "com.standing-orders.desktop.development" : "com.standing-orders.desktop") && typeof b.providerBin === "string";
  if (!validBundle(j.old) || !validBundle(j.next) || j.old.bundleId !== j.next.bundleId || !isAbsolute(j.databaseFile) || !/^[a-f0-9]{64}$/.test(j.configHash) || typeof j.wasRunning !== "boolean" || (j.backupPath && (dirname(j.backupPath) !== j.workDir || !/^orders\.backup(?:\.[a-f0-9-]{36})?\.db$/.test(basename(j.backupPath)))) || (j.backupHash && !/^[a-f0-9]{64}$/.test(j.backupHash))) throw Error("The saved update paths or build identities are invalid. Nothing was changed.");
  if (j.replacementOccurred !== undefined && typeof j.replacementOccurred !== "boolean") throw Error("The recorded replacement state is invalid. Nothing was changed.");
  if (j.codingCatalogExpected !== undefined && typeof j.codingCatalogExpected !== "boolean") throw Error("The recorded coding catalog presence is invalid. Nothing was changed.");
  if (j.stoppedPids !== undefined && (!Array.isArray(j.stoppedPids) || !j.stoppedPids.every(pid => Number.isSafeInteger(pid) && pid > 1))) throw Error("The recorded service processes are invalid. Nothing was changed.");
  if ((j.codingBackupPath === undefined) !== (j.codingBackupHash === undefined) || (j.codingBackupPath && (dirname(j.codingBackupPath) !== j.workDir || !/^coding\.backup(?:\.[a-f0-9-]{36})?\.sqlite$/.test(basename(j.codingBackupPath)))) || (j.codingBackupHash && !/^[a-f0-9]{64}$/.test(j.codingBackupHash))) throw Error("The retained coding backup paths or identity are invalid. Nothing was changed.");
  for (const directory of [dirname(j.workDir), j.workDir]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw Error("The update folder must be a private, owner-controlled directory.");
  }
  return j;
}
/** Which settled schema versions a caller works on: the desktop update, which never migrates, only this build's own. */
export type SchemaAccepted = (version: number | null) => boolean;
const currentSchemaOnly: SchemaAccepted = version => version === SCHEMA_VERSION;
function connect(file: string, readOnly = false, accepts: SchemaAccepted = currentSchemaOnly): DatabaseSync {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) throw Error("The task database is missing or linked. It was not recreated.");
  const db = new (sqlite().DatabaseSync)(file, { readOnly }); db.exec("PRAGMA busy_timeout=1000");
  const schema = readSchemaVersion(db);
  if (!schema.ok || !accepts(schema.version)) { db.close(); throw Error("This update needs the current database schema. Use the separate verified migration procedure; the installed app is unchanged."); }
  return db;
}
const resources = (app: DesktopBundle) => join(app.path, "Contents", "Resources");
const serviceArgs = (app: DesktopBundle, j: Pick<UpdateJournal, "label"> & { id?: string }) => ["--node", join(resources(app), "runtime", "node"), "--helper", join(resources(app), "dist", "desktop-host.js"), "--label", j.label, "--bundle-id", app.bundleId, "--provider-bin", app.providerBin, "--build-id", app.buildId, ...(j.id ? ["--update-id", j.id] : [])];
async function serviceState(bundle: DesktopBundle, j: Pick<UpdateJournal, "stateDir" | "label">): Promise<ServiceState> {
  return await desktopServiceCommand("service-status", j.stateDir, readDesktopConfig(j.stateDir), serviceArgs(bundle, j)) as unknown as ServiceState;
}
async function service(action: "start" | "stop", bundle: DesktopBundle, j: UpdateJournal): Promise<void> {
  await desktopServiceCommand(`service-${action}`, j.stateDir, readDesktopConfig(j.stateDir), serviceArgs(bundle, j));
}
async function healthy(bundle: DesktopBundle, j: UpdateJournal, since: string): Promise<boolean> {
  const config = readDesktopConfig(j.stateDir);
  const definition = desktopServiceDefinition(j.stateDir, { node: join(resources(bundle), "runtime", "node"), helper: join(resources(bundle), "dist", "desktop-host.js"), label: j.label, bundleId: bundle.bundleId, buildId: bundle.buildId, providerBin: bundle.providerBin, ...(config.containment ? { containment: config.containment } : {}) });
  const status = await daemonStatus(definition, run);
  if (status.state !== "running" || status.stale || !(await verifyDesktopLiveness(config)).alive) return false;
  try {
    const supervisor = JSON.parse(readFileSync(join(j.stateDir, "controller-supervisor.json"), "utf8"));
    const access = JSON.parse(readFileSync(join(j.stateDir, "project-access.json"), "utf8"));
    if (supervisor.buildId !== bundle.buildId || supervisor.updatedAt < since || access.checkedAt < since || !currentDesktopAccess(access, supervisor, config.repos, readFileSync(join(j.stateDir, "project-access-request"), "utf8")).verified) return false;
    const db = connect(j.databaseFile, true);
    try { return config.repos.length > 0 && config.repos.every(repo => db.prepare("SELECT 1 FROM watch_lease WHERE runner=? AND repo=? AND expires_at>?").get(config.runnerName ?? "", repo, new Date().toISOString())); }
    finally { db.close(); }
  } catch { return false; }
}
async function swap(j: UpdateJournal): Promise<void> {
  const result = await run(join(payload(j), "Contents", "Resources", "runtime", "bundle-swap"), [j.old.path, standby(j)], { timeoutMs: 10_000, maxBuffer: 8192 });
  if (result.code !== 0) throw Error((result.stderr || "The volume refused an atomic app swap. Neither bundle was deleted.").slice(0, 1000));
}
async function otherControllers(app: DesktopBundle, stateDir: string): Promise<boolean> {
  const result = await run("/bin/ps", ["-axo", "command="], { timeoutMs: 5000, maxBuffer: 4_194_304 });
  if (result.code !== 0) throw Error("Other app controllers could not be checked. No app swap was attempted.");
  const command = `${join(resources(app), "runtime", "node")} ${join(resources(app), "dist", "desktop-host.js")} serve --state `;
  return result.stdout.split("\n").some(line => line.trim().startsWith(command) && line.trim() !== command + resolve(stateDir));
}
/** A finished run whose end Toolroll cannot show yet: in plain words, with the one command that clears it when a
 * person can. */
export type LingeringRun = { run: number; on: string; action: string | null };
/** How long an update waits on a finished run it cannot show has ended before it stops waiting and says why. */
export const LINGERING_LIMIT_MS = 120_000;

export function lingeringRun(db: DatabaseSync): LingeringRun | null {
  const store = new Store(db);
  for (const row of db.prepare("SELECT DISTINCT run FROM run_process WHERE exited_at IS NULL").all()) {
    const problem = store.stopQuiescenceProblem(Number(row.run));
    if (problem) return plainLingering(Number(row.run), problem);
  }
  return null;
}
export function lingeringWork(db: DatabaseSync): string | null {
  const lingering = lingeringRun(db);
  return lingering && lingeringWords(lingering);
}
export const lingeringWords = (l: LingeringRun) => l.action ? `${l.on}. If nothing of it is running, run: ${l.action}` : `${l.on}.`;
/** What an update says when it stops waiting on `l`: what is in the way, the command, and that new work resumed. */
export const stoppedWaitingWords = (l: LingeringRun) => `Stopped waiting after 2 minutes. ${l.on}. ${clearWords(l)} New work resumed; nothing was changed.`;
/** The next step once an update has stopped on `l`. */
export const clearWords = (l: LingeringRun) => l.action ? `If nothing of it is running, run ${l.action}, then update again.` : "Update again once it has stopped.";

/** An update that is waiting or stopped, what on, and the one action that clears it: for `toolroll status` and the
 * console. `app`: the desktop app's update rather than `toolroll update`. */
export type UpdateWaiting = { app: boolean; version: string; stopped: boolean; run: number | null; on: string; action: string | null; words: string; short: string };
export function updateWaitingWords(o: { app: boolean; version: string; stopped: boolean; lingering: LingeringRun | null }): UpdateWaiting {
  const { app, version, stopped, lingering: l } = o;
  const update = `${app ? "App update" : "Update"} to ${version}`;
  if (!l) {
    const on = "running work to finish";
    const words = `${update} is waiting for ${on}. New work is paused.`;
    return { app, version, stopped: false, run: null, on, action: null, words, short: words };
  }
  const next = l.action ? ` If nothing of it is running, run ${l.action}${stopped ? ", then update again" : ""}.` : stopped ? " Update again once it has stopped." : "";
  return { app, version, stopped, run: l.run, on: l.on, action: l.action,
    words: `${update} ${stopped ? "stopped waiting" : "is waiting"}: ${l.on}.${next}`,
    short: `${update} ${stopped ? `stopped: run #${l.run} is in the way` : `is waiting on run #${l.run}`}.${next}` };
}
/** An app updater that ended while letting work finish, with no automatic recovery coming to resume it, leaves new
 * work paused with nobody left to lift the pause. Nothing was stopped or swapped yet, so the pause is lifted here and
 * the update says it stopped. Returns what it said, or null. */
export function releaseStalledDesktopUpdate(stateDir: string): string | null {
  let j: UpdateJournal | null;
  try { j = readUpdateJournal(stateDir); } catch { return null; }
  if (!j || j.phase !== "draining" || j.serviceInterrupted || j.replacementOccurred) return null;
  const status = desktopUpdateStatus(stateDir);
  if (status.running || status.automaticRecovery) return null;
  const lock = workerLock(j);
  if (!lock) return null;
  try {
    const held = readUpdateJournal(stateDir);
    if (!held || held.id !== j.id || held.phase !== "draining" || held.serviceInterrupted || held.replacementOccurred || bundleHash(held.old.path) !== held.old.hash) return null;
    const db = connect(held.databaseFile);
    try { removeUpdateGate(db, held.id); } finally { db.close(); }
    const words = `The app update to ${held.next.version} stopped: its updater ended before running work finished. Nothing was changed; new work resumed. Update again from the app.`;
    held.error = "The updater ended while letting work finish.";
    save(held, "cancelled", words);
    return words;
  } finally { lock.close(); }
}
/** The desktop app's update, when it is waiting on work in `databaseFile`'s installation, or stopped on a run still in
 * the way. An app updater that ended mid-drain is released first, as `toolroll update`'s is. */
export function desktopUpdateWaitingOf(databaseFile: string, inTheWay: (run: number) => boolean, stateDirs: readonly string[] = [dirname(databaseFile), join(homedir(), "Library", "Application Support", "Standing Orders")]): UpdateWaiting | null {
  for (const stateDir of new Set(stateDirs.map(dir => resolve(dir)))) {
    let j: UpdateJournal | null;
    try { j = readUpdateJournal(stateDir); } catch { continue; }
    if (!j || resolve(j.databaseFile) !== resolve(databaseFile)) continue;
    try { if (releaseStalledDesktopUpdate(stateDir)) j = readUpdateJournal(stateDir)!; } catch { /* shown as last saved */ }
    const version = j.next.version;
    if (j.phase === "draining") return updateWaitingWords({ app: true, version, stopped: false, lingering: j.waiting ?? null });
    if (j.phase === "cancelled" && j.waiting && inTheWay(j.waiting.run)) return updateWaitingWords({ app: true, version, stopped: true, lingering: j.waiting });
  }
  return null;
}

/** The same settling reconcile the background worker runs: a finished run's leftover record of a process that never
 * started settles once the run's process groups are proven gone. A record nothing can prove either way stays. */
export function settleLeftoverRecords(db: DatabaseSync, now: Date): number {
  return new Store(db).settleUnspawnedWitnesses(now);
}

/** Store.stopQuiescenceProblem's reasons, said for a person: no internal terms, and `toolroll run settle` only where it
 * can clear the record (it refuses while anything of the run is alive). */
export function plainLingering(fallbackRun: number, problem: string): LingeringRun {
  const run = Number(/run #(\d+)/.exec(problem)?.[1] ?? fallbackRun);
  const settle = `toolroll run settle ${run} --why "it is not running"`;
  const pid = /process (\d+)/.exec(problem)?.[1];
  if (/incomplete spawn witness|before its process witness was recorded/.test(problem)) return { run, on: `Run #${run} finished, but Toolroll has no process ID for one of its processes, so it can't confirm that process ended`, action: settle };
  if (/belongs to another host|another host/.test(problem)) return { run, on: `Run #${run} finished on another computer, and Toolroll can only confirm its processes ended there`, action: `${settle} (on that computer)` };
  if (/incomplete native containment custody|cannot be proven empty/.test(problem)) return { run, on: `Run #${run} finished, but Toolroll can't confirm its sandbox is empty`, action: settle };
  if (/still has members/.test(problem)) return { run, on: `Run #${run} finished, but processes are still running in its sandbox`, action: null };
  if (/workspace is still held/.test(problem)) return { run, on: `Run #${run} finished, but process ${pid ?? "?"} is still using its folder`, action: null };
  if (/workspace occupancy/.test(problem)) return { run, on: `Run #${run} finished, but Toolroll can't check whether its folder is still in use`, action: null };
  if (/may still be running|owned subprocess/.test(problem)) return { run, on: `Run #${run} finished, but ${pid ? `its process ${pid}` : "one of its processes"} is still running`, action: null };
  if (/held supervisor/.test(problem)) return { run, on: `Run #${run} is still shutting down`, action: null };
  if (/still open/.test(problem)) return { run, on: `Run #${run} is still running`, action: null };
  return { run, on: `Run #${run} hasn't finished shutting down`, action: null };
}

export async function previewDesktopUpdate(stateDir: string, installed: string, candidate: string, label: string, hooks: UpdateHooks = {}) {
  const config = readDesktopConfig(stateDir), old = readDesktopBundle(resolve(installed)), next = readDesktopBundle(resolve(candidate));
  if (!/^[a-zA-Z0-9.-]+$/.test(label)) throw Error("Invalid service label.");
  const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
  if (inside(old.path, next.path) || inside(next.path, old.path) || [old.path, next.path].some(app => inside(app, resolve(stateDir)) || inside(app, resolve(config.databaseFile)))) throw Error("The installed app, candidate and saved state must be separate paths.");
  if (old.buildId === next.buildId || old.hash === next.hash) throw Error("This build is already installed.");
  if (old.bundleId !== next.bundleId) throw Error("A development preview cannot replace a release identity.");
  if (old.schemaVersion !== SCHEMA_VERSION || next.schemaVersion !== SCHEMA_VERSION) throw Error("This release needs a database migration. Use the separate verified migration procedure; the installed app is unchanged.");
  if (next.recoveryProtocol !== 1) throw Error("This candidate predates automatic update recovery. Choose a current build; the installed app is unchanged.");
  const codingCatalogExpected = codingCatalogExists(`${config.databaseFile}.coding.sqlite`);
  const db = connect(config.databaseFile, true); let active;
  try { if (updateAdmissionPaused(db)) throw Error("An update still owns the admission pause. Open Update status to recover it before starting another update."); active = activeUpdateWork(db); } finally { db.close(); }
  const existing = readUpdateJournal(stateDir);
  if (existing && !terminal(existing.phase)) throw Error("An update is already recorded. Open Update status to continue or cancel it.");
  await (hooks.verify ?? verifyDesktopUpdateBundles)(old, next);
  if (await (hooks.otherControllers ?? otherControllers)(old, stateDir)) throw Error("Another installation is using this app. Stop its background service before updating this shared app.");
  const status = await (hooks.serviceStatus ?? serviceState)(old, { stateDir, label });
  if (status.stale && ["running", "loaded"].includes(status.state)) throw Error("The service does not match the installed app. Reconnect it with Start background service before updating.");
  const plan = { old, next, configHash: fingerprint(config), label, stateDir: resolve(stateDir), databaseFile: config.databaseFile, codingCatalogExpected, wasRunning: ["running", "loaded"].includes(status.state) };
  return { ...plan, digest: digest(plan), active, message: "New work will wait while current work finishes. A verified private backup and the previous app will be kept. The database will not be migrated or restored automatically." };
}

export async function prepareDesktopUpdate(stateDir: string, installed: string, candidate: string, label: string, expected: string, hooks: UpdateHooks = {}): Promise<UpdateJournal> {
  const plan = await previewDesktopUpdate(stateDir, installed, candidate, label, hooks);
  if (plan.digest !== expected) throw Error("The app, configuration or update changed since preview. Review the update again.");
  const id = randomUUID(), workDir = join(dirname(plan.old.path), ".standing-orders-updates", id);
  mkdirSync(workDir, { recursive: true, mode: 0o700 }); chmodSync(dirname(workDir), 0o700); chmodSync(workDir, 0o700);
  // The staged updater stays put while Standby and the installation exchange.
  cpSync(plan.next.path, join(workDir, "Updater.app"), { recursive: true, errorOnExist: true, force: false });
  cpSync(plan.next.path, join(workDir, "Standby.app"), { recursive: true, errorOnExist: true, force: false });
  if (bundleHash(join(workDir, "Updater.app")) !== plan.next.hash || bundleHash(join(workDir, "Standby.app")) !== plan.next.hash) throw Error("The staged update changed during copying. The installed app is unchanged.");
  const journal: UpdateJournal = { version: 1, id, workDir, ...plan, phase: "prepared", intended: "install", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), detail: "Update prepared; waiting to pause new work." };
  // Two starts may finish copying together. Reserve the installation's one
  // active journal atomically; never replace another pending update.
  const reservation = installationLock(journal);
  if (!reservation) throw Error("This app is already being updated. Open Update status in its controlling installation.");
  try {
    reservation.exec("CREATE TABLE IF NOT EXISTS owner (slot INTEGER PRIMARY KEY CHECK(slot=1), state TEXT NOT NULL)");
    const owner = reservation.prepare("SELECT state FROM owner WHERE slot=1").get();
    const pending = owner ? readUpdateJournal(String(owner.state)) : null;
    if (pending && !terminal(pending.phase)) throw Error("Another installation already has an update prepared for this app. Continue or cancel it there first.");
    const existing = readUpdateJournal(stateDir);
    if (existing && !terminal(existing.phase)) throw Error("Another update was started. Its record was not replaced.");
    reservation.prepare("INSERT INTO owner(slot,state) VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET state=excluded.state").run(resolve(stateDir));
    save(journal, "prepared", journal.detail);
    reservation.exec("COMMIT");
  } finally { reservation.close(); }
  return journal;
}

export function sqliteLock(file: string, busyTimeoutMs = 0): DatabaseSync | null {
  if (existsSync(file)) privateFile(file);
  const db = new (sqlite().DatabaseSync)(file); chmodSync(file, 0o600);
  try { db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; BEGIN EXCLUSIVE`); return db; }
  catch (error) { db.close(); if (String(error).includes("locked") || [5, 6].includes((error as { errcode?: number }).errcode ?? 0)) return null; throw error; }
}
const workerLock = (j: UpdateJournal, busyTimeoutMs = 0) => sqliteLock(join(j.workDir, "worker.sqlite"), busyTimeoutMs);
export const installationLock = (j: UpdateJournal) => sqliteLock(join(dirname(j.workDir), `installation-${digest(j.old.path).slice(0, 24)}.sqlite`));
export function desktopUpdateStatus(stateDir: string) {
  const j = readUpdateJournal(stateDir);
  if (!j) return { active: false, phase: "none", detail: "No update is in progress.", running: false, canResume: false, canCancel: false };
  const lock = workerLock(j), running = lock === null; lock?.close();
  let recovery: DesktopRecoveryView | null = null;
  try { privateFile(join(j.workDir, "recovery.json")); recovery = readDesktopRecoveryView(JSON.parse(readFileSync(join(j.workDir, "recovery.json"), "utf8"))); } catch { /* A legacy/manual update has no guardian. */ }
  const wantsAutomatic = recovery?.id === j.id && ["armed", "running", "backoff"].includes(recovery.state ?? "") && !terminal(j.phase);
  const guardianLock = wantsAutomatic ? sqliteLock(join(j.workDir, "guardian.sqlite")) : undefined;
  const automatic = wantsAutomatic && (guardianLock === null || Date.now() - Date.parse(recovery?.updatedAt ?? "") < 45_000); guardianLock?.close();
  const detail = wantsAutomatic && !automatic ? "Automatic recovery has not restarted. Work remains paused; use Retry safely in Update status." : recovery?.state === "attention" || (automatic && (!running || j.phase === "needs-attention")) ? recovery?.detail ?? j.detail : j.detail;
  return { active: !terminal(j.phase), phase: j.phase, detail, error: j.error ?? null, running, automaticRecovery: automatic, recoveryAttempts: recovery?.attempts ?? 0, recoveryRepairs: recovery?.repairs ?? 0, canResume: !running && !automatic && !terminal(j.phase), canCancel: !terminal(j.phase), wasRunning: j.wasRunning && !updateStopRequested(j), backupPath: j.backupPath ?? null, updateId: j.id, version: j.next.version, buildId: j.next.buildId, workDir: j.workDir };
}
export function updateStopRequested(j: UpdateJournal): boolean {
  const file = join(j.workDir, "stop-request.json");
  if (!existsSync(file)) return false;
  privateFile(file);
  if (!updateRequestIs(JSON.parse(readFileSync(file, "utf8")), j.id, "stop")) throw Error("The saved stop request is invalid. Automatic starts are refused.");
  return true;
}
export function requestUpdateStop(stateDir: string): void {
  const j = readUpdateJournal(stateDir);
  if (!j || terminal(j.phase)) return;
  durableJson(join(j.workDir, "stop-request.json"), { id: j.id, action: "stop" });
  requestUpdateRestore(stateDir);
}
export function requestUpdateRestore(stateDir: string): void {
  const j = readUpdateJournal(stateDir);
  if (!j || terminal(j.phase)) throw Error("There is no pending update to cancel.");
  durableJson(join(j.workDir, "request.json"), { id: j.id, action: "restore" });
}
function restoreRequested(j: UpdateJournal): boolean {
  try {
    const request: unknown = JSON.parse(readFileSync(join(j.workDir, "request.json"), "utf8"));
    if (request === null) throw Error("The saved restore request is invalid.");
    return updateRequestIs(request, j.id, "restore");
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function launchDesktopUpdate(stateDir: string, retry = false): Promise<void> {
  const { armUpdateRecovery } = await import("./desktop-update-recovery.js");
  await armUpdateRecovery(stateDir, retry);
}

export function pauseUpdateRecovery(stateDir: string, id: string, detail: string): void {
  const j = readUpdateJournal(stateDir);
  if (!j || j.id !== id || terminal(j.phase)) return;
  const lock = workerLock(j, 1000); if (!lock) throw Error("An updater still owns this operation; its state was not replaced.");
  try { j.retryableRecovery = false; save(j, "needs-attention", detail); } finally { lock.close(); }
}
class RetryableUpdateError extends Error {}

function assertConfig(j: UpdateJournal): void {
  const config = readDesktopConfig(j.stateDir);
  if (config.databaseFile !== j.databaseFile || fingerprint(config) !== j.configHash) throw Error("Project or installation settings changed during the update. Keep the current app and review a fresh update.");
}
function snapshot(db: DatabaseSync): string {
  const result: Record<string, unknown> = {};
  for (const table of ["task", "task_scope", "approver", "run", "artifact", "mate_message", "project"]) {
    const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    result[table] = rows;
  }
  return digest(result);
}
async function verifiedBackup(j: UpdateJournal): Promise<void> {
  assertCodingCatalogPresent(j);
  const file = join(j.workDir, "orders.backup.db");
  if (j.backupHash) {
    if (!j.backupPath || fileHash(j.backupPath) !== j.backupHash) throw Error("The retained backup changed. It was not overwritten.");
    await verifiedCodingBackup(j);
    save(j, "backing-up", "Private database backups verified; saved tasks and coding sessions are retained.");
    return;
  }
  // A crashed partial attempt gets a fresh filename; no backup is overwritten.
  const backupPath = existsSync(file) ? join(j.workDir, `orders.backup.${randomUUID()}.db`) : file;
  const backupHash = await verifiedDatabaseBackup(j.databaseFile, backupPath, j.id, async () => {
    await verifiedCodingBackup(j);
  }, () => {
    for (const [source, name] of [[join(j.stateDir, "desktop.json"), "desktop.json"], [join(dirname(j.databaseFile), "repos.json"), "repos.json"], [join(dirname(j.databaseFile), "up-login.txt"), "up-login.txt"]]) {
      if (source && name && existsSync(source)) {
        if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw Error("A saved configuration file is linked or not a regular file. Nothing was replaced.");
        if (name === "up-login.txt") privateFile(source);
        copyFileSync(source, join(j.workDir, name)); chmodSync(join(j.workDir, name), 0o600);
      }
    }
  });
  j.backupPath = backupPath; j.backupHash = backupHash;
  save(j, "backing-up", "Private database backups verified; saved tasks, evidence and coding sessions match.");
}

/** A private, verified copy of the task database, made under a write
 * reservation so no writer slips in between the snapshot and the copy. The
 * copy drops the update's own admission pause. `inside` runs before the
 * reservation is released, `after` once it is; returns the copy's hash. */
export async function verifiedDatabaseBackup(databaseFile: string, backupPath: string, gateId: string, inside: () => Promise<void> = async () => {}, after: () => void = () => {}, accepts: SchemaAccepted = currentSchemaOnly): Promise<string> {
  const db = connect(databaseFile, false, accepts);
  try {
    db.exec("BEGIN IMMEDIATE");
    // The write reservation prevents a concurrent writer; a separate read
    // connection is required because SQLite cannot back up a write transaction.
    const source = connect(databaseFile, true, accepts);
    let before: string;
    try { before = snapshot(source); await sqlite().backup(source, backupPath); } finally { source.close(); }
    chmodSync(backupPath, 0o600);
    const copied = connect(backupPath, false, accepts);
    try {
      if (copied.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || copied.prepare("PRAGMA foreign_key_check").all().length !== 0 || snapshot(copied) !== before) throw Error("Backup verification failed. The installed app is unchanged.");
      removeUpdateGate(copied, gateId);
    } finally { copied.close(); }
    await inside();
    db.exec("COMMIT");
    after();
    const fd = openSync(backupPath, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    return fileHash(backupPath);
  } finally { db.close(); }
}

function assertCodingCatalogPresent(j: UpdateJournal): void {
  const present = codingCatalogExists(`${j.databaseFile}.coding.sqlite`);
  if ((j.codingCatalogExpected || j.codingBackupPath || j.codingBackupHash) && !present) throw Error("The live coding catalog disappeared during this update. Keep the app stopped and restore the catalog before continuing.");
  if (present && !j.codingCatalogExpected) { j.codingCatalogExpected = true; save(j, j.phase, j.detail); }
}

function assertDesktopCodingStopped(j: UpdateJournal, db: DatabaseSync): void {
  assertCodingCatalogPresent(j);
  assertCodingUpdateStopped(db);
}

/** The service's own processes, from its supervisor's status file: read before the stop, never after. */
function servicePids(stateDir: string): number[] {
  try {
    return supervisorPidsOf(JSON.parse(readFileSync(join(stateDir, "controller-supervisor.json"), "utf8")));
  } catch { return []; }
}

/** An older app killed before its close leaves the coding owner record behind. Once the stopped service's processes
 * are proved gone, it is released here (and recorded in the ledger); anything unproven keeps the ordinary refusal. */
function releaseDesktopCodingOwner(j: UpdateJournal, db: DatabaseSync, alive: (pid: number) => boolean): void {
  assertCodingCatalogPresent(j);
  const released = releaseStaleCodingOwner(db, j.stoppedPids ?? [], (pid, group) => alive(pid) || processMayBeAlive(pid, group));
  if (released === null) return;
  j.codingOwnerReleased = released;
  save(j, j.phase, j.detail);
  const ledger = connect(j.databaseFile);
  try {
    ledger.prepare("INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source,detail) VALUES (?,'desktop update',NULL,NULL,NULL,'coding owner released','released','policy',?)")
      .run(new Date().toISOString(), `${j.old.version} stopped without releasing the coding workspace; process ${released.pid}${released.nativePid === null ? "" : ` and agent ${released.nativePid}`} proved gone`);
  } finally { ledger.close(); }
}

function assertCodingBackup(j: UpdateJournal): void {
  assertCodingCatalogPresent(j);
  if (j.codingBackupPath || j.codingBackupHash) {
    const stat = j.codingBackupPath && existsSync(j.codingBackupPath) ? lstatSync(j.codingBackupPath) : null;
    if (!stat?.isFile() || stat.isSymbolicLink() || !j.codingBackupPath || fileHash(j.codingBackupPath) !== j.codingBackupHash) throw Error("The retained coding backup is missing, linked or changed. It was not overwritten; the update remains paused.");
  } else if (j.codingCatalogExpected) throw Error("The coding catalog has no verified update backup. The update remains paused.");
}

async function verifiedCodingBackup(j: UpdateJournal): Promise<void> {
  assertCodingCatalogPresent(j);
  if (j.codingBackupPath || j.codingBackupHash) { assertCodingBackup(j); return; }
  const source = `${j.databaseFile}.coding.sqlite`;
  if (!codingCatalogExists(source)) return;
  const normal = join(j.workDir, 'coding.backup.sqlite');
  const target = existsSync(normal) ? join(j.workDir, `coding.backup.${randomUUID()}.sqlite`) : normal;
  await backupCodingCatalog(source, target, j.id);
  assertCodingCatalogPresent(j);
  j.codingBackupPath = target; j.codingBackupHash = fileHash(target);
  assertCodingBackup(j);
  save(j, j.phase, j.detail);
}

/** A SQLite OS lock releases on updater death. Each irreversible step has a
 * preceding durable intent; recovery determines the actual side by hashes. */
export async function runDesktopUpdate(stateDir: string, hooks: UpdateHooks = {}): Promise<void> {
  let j = readUpdateJournal(stateDir);
  if (!j || terminal(j.phase)) return;
  // A status probe briefly tries this same lock. Give it time to finish;
  // treating its millisecond lock as a live updater stranded resume/start.
  const lock = workerLock(j, 1000); if (!lock) return;
  const latest = readUpdateJournal(stateDir);
  if (!latest || latest.id !== j.id || terminal(latest.phase)) { lock.close(); return; }
  j = latest;
  let installation: DatabaseSync | null;
  try { installation = installationLock(j); } catch (error) { lock.close(); throw error; }
  if (!installation) { lock.close(); throw Error("Another updater is working on this app. Its operation was not interrupted."); }
  const sleep = hooks.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const control = async (action: "start" | "stop", bundle: DesktopBundle, journal: UpdateJournal) => {
    if (action === "start" && updateStopRequested(journal)) throw Error("You stopped the background service. Automatic restart is disabled for this update.");
    try { await (hooks.service ?? service)(action, bundle, journal); }
    catch (error) { throw new RetryableUpdateError(error instanceof Error ? error.message : String(error)); }
  };
  const status = hooks.serviceStatus ?? serviceState;
  const checkpoint = (phase: Phase, text: string) => { save(j, phase, text); hooks.checkpoint?.(phase); };
  const waitHealthy = async (bundle: DesktopBundle) => {
    const since = new Date().toISOString();
    writeFileSync(join(j.stateDir, "project-access-request"), randomUUID(), { mode: 0o600 });
    assertCodingCatalogPresent(j);
    await control("start", bundle, j);
    assertCodingCatalogPresent(j);
    const deadline = Date.now() + (hooks.healthTimeoutMs ?? 60_000);
    do {
      if (updateStopRequested(j) || (j.intended === "install" && restoreRequested(j))) throw Error("The operator requested the previous app or stopped the service.");
      assertCodingCatalogPresent(j);
      const ready = await (hooks.healthy ?? healthy)(bundle, j, since);
      assertCodingCatalogPresent(j);
      if (ready) { j.checkedAt = new Date().toISOString(); return; }
      await sleep(500);
    } while (Date.now() < deadline);
    throw new RetryableUpdateError("The worker did not confirm its build, project access and console connection. The update cannot be marked complete.");
  };
  const recordReplacement = () => {
    if (!j.replacementOccurred && bundleHash(j.old.path) === j.next.hash) {
      j.replacementOccurred = true; save(j, j.phase, j.detail);
    }
  };
  const release = async (phase: "complete" | "restored" | "cancelled", message: string) => {
    checkpoint("releasing", message);
    const needsBackup = phase === "complete" || j.replacementOccurred;
    if (needsBackup) await verifiedCodingBackup(j);
    if ((needsBackup || j.serviceInterrupted) && (!j.wasRunning || updateStopRequested(j))) checkSwapQuiescence();
    const db = connect(j.databaseFile);
    try {
      if (needsBackup) assertCodingBackup(j); else assertCodingCatalogPresent(j);
      removeUpdateGate(db, j.id);
    } finally { db.close(); }
    checkpoint(phase, message);
  };
  const checkSwapQuiescence = () => {
    const db = connect(j.databaseFile, true);
    try {
      if (Object.values(activeUpdateWork(db)).some(n => n !== 0) || db.prepare("SELECT 1 FROM watch_lease WHERE expires_at>? LIMIT 1").get(new Date().toISOString())) throw Error("A worker or active operation still uses this database. The update remains paused.");
      const problem = lingeringWork(db); if (problem) throw Error(problem);
      assertDesktopCodingStopped(j, db);
    } finally { db.close(); }
  };
  const finishStopped = async (bundle: DesktopBundle) => {
    await control("stop", bundle, j);
    if (["running", "loaded"].includes((await status(bundle, j)).state)) throw Error("The background service did not stop. Work remains paused.");
    checkSwapQuiescence();
  };
  const restore = async () => {
    recordReplacement();
    j.intended = "restore";
    checkpoint("rolling-back", "Restoring the previous app. The current task database will be kept.");
    assertConfig(j);
    assertCodingCatalogPresent(j);
    if (await (hooks.otherControllers ?? otherControllers)(j.old, j.stateDir)) throw Error("Another installation is using this app. Stop that service before resuming recovery.");
    assertCodingCatalogPresent(j);
    const db = connect(j.databaseFile);
    try { installUpdateGate(db, j.id); if (!freezeUpdateGate(db, j.id)) throw Error("Work is still active. The app will not be swapped until it finishes."); } finally { db.close(); }
    const actual = bundleHash(j.old.path);
    if (actual === j.next.hash) {
      await control("stop", atInstalled(j.next, j), j);
      if (["running", "loaded"].includes((await status(atInstalled(j.next, j), j)).state)) throw Error("The candidate service is still running. The previous app was not swapped in.");
      const checking = connect(j.databaseFile, true);
      try { const problem = lingeringWork(checking); if (problem) throw Error(problem); assertDesktopCodingStopped(j, checking); } finally { checking.close(); }
      if (bundleHash(standby(j)) !== j.old.hash) throw Error("The previous app backup changed. Nothing was replaced.");
      await verifiedCodingBackup(j);
      checkSwapQuiescence();
      assertCodingBackup(j);
      await (hooks.swap ?? swap)(j);
    } else if (actual !== j.old.hash) throw Error("The installed app no longer matches either recorded build. Nothing was replaced.");
    if (j.wasRunning && !updateStopRequested(j)) await waitHealthy(j.old); else await finishStopped(j.old);
    await release("restored", "Previous app restored. Your current tasks and evidence were preserved." + (j.error ? ` Update stopped because: ${j.error}` : ""));
  };
  const cancel = async () => {
    // A resumed operation may already have swapped or stopped the service,
    // even though its new drain pass is now showing "draining".
    if (bundleHash(j.old.path) === j.old.hash && !j.serviceInterrupted) await release("cancelled", "Update cancelled. The installed app and current work are unchanged; any verified backup was kept.");
    else await restore();
  };
  try {
    recordReplacement();
    const owner = installation.prepare("SELECT state FROM owner WHERE slot=1").get();
    if (owner?.state !== j.stateDir) throw Error("Another installation owns this app update. Its work was not interrupted.");
    assertConfig(j);
    if (bundleHash(payload(j)) !== j.next.hash) throw Error("The staged updater changed. Preserve the update folder and recover with a verified release.");
    const db = connect(j.databaseFile);
    try { installUpdateGate(db, j.id); } finally { db.close(); }
    assertCodingCatalogPresent(j);
    if (j.intended === "restore" || restoreRequested(j) || updateStopRequested(j)) {
      if (j.intended !== "restore") { await cancel(); return; }
      await restore(); return;
    }
    checkpoint("draining", "Waiting for current work to finish. New work is paused; no task will be killed for this update.");
    const now = hooks.now ?? (() => new Date());
    for (;;) {
      if (restoreRequested(j) || updateStopRequested(j)) { await cancel(); return; }
      assertConfig(j);
      assertCodingCatalogPresent(j);
      const checking = connect(j.databaseFile);
      let stuck: LingeringRun | null = null;
      try {
        const active = activeUpdateWork(checking);
        const idle = Object.values(active).every(n => n === 0);
        // A finished run's leftover record settles here first, as the background worker would settle it.
        if (idle) settleLeftoverRecords(checking, now());
        const lingering = idle ? lingeringRun(checking) : null;
        if (!lingering && idle && freezeUpdateGate(checking, j.id)) { delete j.waiting; break; }
        // Saved, so a resumed updater keeps counting from when it began, and status can say what it waits on.
        if (!lingering) delete j.waiting;
        else if (j.waiting?.run !== lingering.run || j.waiting.on !== lingering.on) j.waiting = { ...lingering, since: now().toISOString() };
        if (j.waiting && now().getTime() - Date.parse(j.waiting.since) >= LINGERING_LIMIT_MS) stuck = lingering;
        else save(j, "draining", lingering ? `New work is paused. Waiting for run #${lingering.run}: ${lingeringWords(lingering)} No process is being killed.` : `Waiting for current work: ${active.runs} runs, ${active.claims} leases, ${active.conversations} chat requests, ${active.sessions} sessions, ${active.stopping} shutdowns, ${active.coding} coding sessions, ${active.codingDeliveries} unconfirmed messages. Nothing is being cancelled.`);
      } finally { checking.close(); }
      // Waiting longer proves nothing more: new work resumes, and the one thing in the way is named.
      if (stuck) { await release("cancelled", stoppedWaitingWords(stuck)); return; }
      assertCodingCatalogPresent(j);
      await sleep(1000);
    }
    checkpoint("backing-up", "Creating and verifying a private backup of tasks, approvals and evidence.");
    await verifiedBackup(j);
    if (restoreRequested(j)) { await cancel(); return; }
    assertConfig(j);
    if (await (hooks.otherControllers ?? otherControllers)(j.old, j.stateDir)) throw Error("Another installation is using this app. Stop its background service before continuing.");
    if (restoreRequested(j)) { await cancel(); return; }
    const actual = bundleHash(j.old.path);
    if (actual !== j.old.hash && actual !== j.next.hash) throw Error("The installed app changed after preview. Nothing was replaced.");
    const current = actual === j.old.hash ? j.old : atInstalled(j.next, j);
    j.serviceInterrupted = true;
    // Recorded once, before the first stop: a resumed update keeps the processes it first saw.
    if (j.stoppedPids === undefined) j.stoppedPids = servicePids(j.stateDir);
    checkpoint("stopping", "Current work is finished. Stopping the background service for the update.");
    await control("stop", current, j);
    const stopped = await status(current, j);
    if (["running", "loaded"].includes(stopped.state)) throw Error("The background service did not stop. No app swap was attempted.");
    const alive = hooks.processAlive ?? (pid => processMayBeAlive(pid, false));
    for (let waited = 0; j.stoppedPids.some(alive); waited += 250) {
      if (waited >= 60_000) throw Error(`The background service is still running (process ${j.stoppedPids.filter(alive).join(", ")}) after it was stopped. No app swap was attempted.`);
      await sleep(250);
    }
    const afterStop = connect(j.databaseFile, true);
    try {
      if (Object.values(activeUpdateWork(afterStop)).some(n => n !== 0) || afterStop.prepare("SELECT 1 FROM watch_lease WHERE expires_at>? LIMIT 1").get(new Date().toISOString())) throw Error("A worker or active operation still uses this database. Stop the other controller before continuing the update.");
      releaseDesktopCodingOwner(j, afterStop, alive);
      assertDesktopCodingStopped(j, afterStop);
    } finally { afterStop.close(); }
    assertConfig(j);
    if (await (hooks.otherControllers ?? otherControllers)(j.old, j.stateDir)) throw Error("Another installation is using this app. Stop its background service before continuing.");
    if (restoreRequested(j)) { await restore(); return; }
    checkpoint("installing", "Installing the verified app with an atomic swap. The previous app will be retained.");
    if (actual === j.old.hash) {
      const next = readDesktopBundle(standby(j));
      if (next.hash !== j.next.hash) throw Error("The staged app changed. The installed app was not replaced.");
      await (hooks.verify ?? verifyDesktopUpdateBundles)(j.old, next);
      await verifiedCodingBackup(j);
      checkSwapQuiescence();
      assertCodingBackup(j);
      await (hooks.swap ?? swap)(j);
    } else if (bundleHash(standby(j)) !== j.old.hash) throw Error("The retained previous app no longer matches the update record.");
    if (bundleHash(j.old.path) !== j.next.hash) throw Error("The installed app did not match the approved update.");
    recordReplacement();
    checkpoint("verifying", "Checking the new worker, project access and console connection. New work remains paused.");
    await waitHealthy(atInstalled(j.next, j));
    if (!j.wasRunning) await finishStopped(atInstalled(j.next, j));
    await release("complete", j.wasRunning ? "Update complete. The new worker is verified and queued work can resume." : "Update complete and verified. The service remains stopped, as it was before the update.");
  } catch (error) {
    if ((error as { simulatedCrash?: boolean }).simulatedCrash) throw error;
    j.error = (error instanceof Error ? error.message : String(error)).slice(0, 1500);
    const sqliteCode = Number((error as { errcode?: number }).errcode) & 255;
    if ([5, 6].includes(sqliteCode)) {
      j.retryableRecovery = true;
      save(j, "needs-attention", "The task database is temporarily busy. Automatic recovery will retry the saved operation; no app or database was overwritten.");
      return;
    }
    try {
      if (j.phase === "releasing") throw Error("Finishing the update record was interrupted. Resume to verify the installed app; no database rollback was attempted.");
      if (j.serviceInterrupted || bundleHash(j.old.path) === j.next.hash || ["stopping", "installing", "verifying", "rolling-back"].includes(j.phase)) await restore();
      else {
        const db = connect(j.databaseFile); try { assertCodingCatalogPresent(j); removeUpdateGate(db, j.id); } finally { db.close(); }
        checkpoint("cancelled", "The update stopped before installation. The previous app and task database are unchanged. " + j.error);
      }
    } catch (recoveryError) {
      if ((recoveryError as { simulatedCrash?: boolean }).simulatedCrash) throw recoveryError;
      j.retryableRecovery = recoveryError instanceof RetryableUpdateError;
      save(j, "needs-attention", `${j.error} Recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)} Open Update status to retry recovery. The database and app backups were kept.`);
    }
  } finally { installation.close(); lock.close(); }
}
