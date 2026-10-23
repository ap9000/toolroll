/** Supervision of one approved app update, independent of the app being swapped.
 * No task scheduling, credentials or provider calls belong in this process. */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bundleHash } from "./desktop-bundle.js";
import { installLaunchdService, launchdPlist, type ServiceDefinition, type SupervisorRunner } from "./daemon.js";
import { run } from "./exec.js";
import { desktopUpdateStatus, durableJson, installationLock, pauseUpdateRecovery, readUpdateJournal, requestUpdateRestore, sqliteLock, updateTerminal, type UpdateJournal } from "./desktop-update.js";
import { sleep } from "./sleep.js";

type Recovery = {
  version: 1; id: string; state: "armed" | "running" | "backoff" | "attention" | "done";
  attempts: number; repairs: number; guardianPid: number | null; workerPid: number | null;
  updatedAt: string; detail: string; manualRetry?: boolean;
};
const recordFile = (j: UpdateJournal) => join(j.workDir, "recovery.json");
const app = (j: UpdateJournal) => join(j.workDir, "Updater.app");
function readRecovery(j: UpdateJournal): Recovery | null {
  const file = recordFile(j);
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw Error("The automatic-recovery record is not a private regular file.");
  const record = JSON.parse(readFileSync(file, "utf8")) as Recovery;
  if (record.version !== 1 || record.id !== j.id || !["armed", "running", "backoff", "attention", "done"].includes(record.state) || ![record.attempts, record.repairs].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error("The automatic-recovery record is invalid; no work was restarted.");
  return record;
}
function writeRecovery(j: UpdateJournal, record: Recovery, state: Recovery["state"], detail: string): void {
  record.state = state; record.detail = detail; record.updatedAt = new Date().toISOString();
  durableJson(recordFile(j), record);
}

export function updateRecoveryDefinition(j: UpdateJournal, home = homedir()): ServiceDefinition {
  const resources = join(app(j), "Contents", "Resources"), bin = join(resources, "runtime", "node"), entry = join(resources, "dist", "desktop-host.js");
  const label = `${j.label}.update`, logPath = join(j.workDir, "update.log");
  return { platform: "darwin", label, bin, entry, logPath, unitPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
    unitContent: launchdPlist({ label, command: [bin, entry, "update-supervise", "--state", j.stateDir, "--update-id", j.id], workingDirectory: j.workDir, logPath,
      pathEnv: [dirname(bin), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"), associatedBundleId: j.next.bundleId,
      // A timer is a fallback even when macOS defers a non-demand KeepAlive
      // restart. It is an updater wakeup, never a task execution time limit.
      keepAlive: false, startInterval: 15 }) };
}

export async function armUpdateRecovery(stateDir: string, retry = false, supervise: SupervisorRunner = run, home = homedir()): Promise<void> {
  if (process.platform !== "darwin") throw Error("Automatic native app recovery currently supports macOS only.");
  const j = readUpdateJournal(stateDir);
  if (!j || updateTerminal(j.phase)) throw Error("No pending update is available.");
  if (j.next.recoveryProtocol !== 1) throw Error("This candidate cannot supervise its own recovery. Use a current build.");
  if (bundleHash(app(j)) !== j.next.hash) throw Error("The staged updater changed. Nothing was launched.");
  const lock = sqliteLock(join(j.workDir, "guardian.sqlite"), 1000);
  if (!lock) return; // An existing guardian owns the job; never restart it.
  try {
    let record = readRecovery(j);
    if (record?.state === "attention" && !retry) throw Error(record.detail);
    record = record && !retry ? record : { version: 1, id: j.id, state: "armed", attempts: 0, repairs: 0, guardianPid: null, workerPid: null, updatedAt: new Date().toISOString(), detail: "", manualRetry: retry };
    writeRecovery(j, record, "armed", "Automatic update recovery is starting. You can close the app window.");
  } finally { lock.close(); }
  try {
    const definition = updateRecoveryDefinition(j, home);
    const result = await installLaunchdService(definition, supervise);
    if (!result.ok) throw Error(result.message);
  } catch (error) {
    const lock = sqliteLock(join(j.workDir, "guardian.sqlite"));
    if (lock) {
      try { const record = readRecovery(j)!; writeRecovery(j, record, "attention", `Automatic recovery could not start: ${error instanceof Error ? error.message : String(error)}. Retry from Update status. No permission was bypassed.`); }
      finally { lock.close(); }
    }
    throw error;
  }
}

export type RecoveryHooks = {
  attempt?: (j: UpdateJournal, signal: AbortSignal, onPid: (pid: number | null) => void) => Promise<void>;
  cleanup?: (j: UpdateJournal) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  staleMs?: number;
  receiptDir?: string;
};
export async function runUpdateAttempt(j: UpdateJournal, signal: AbortSignal, onPid: (pid: number | null) => void, hooks: RecoveryHooks = {}): Promise<void> {
  const resources = join(app(j), "Contents", "Resources");
  const child = spawn(join(resources, "runtime", "node"), [join(resources, "dist", "desktop-host.js"), "update-run", "--state", j.stateDir, "--update-id", j.id], { cwd: j.workDir, stdio: "inherit" });
  let ended = false, fault: string | null = null;
  const startedAt = Date.now();
  // Only this ChildProcess handle may be signalled. A PID in a receipt is
  // diagnostic, never authority to kill something after a restart.
  const stop = () => { if (!ended) child.kill("SIGKILL"); };
  signal.addEventListener("abort", stop, { once: true });
  child.once("spawn", () => { onPid(child.pid ?? null); if (signal.aborted) stop(); });
  child.once("error", () => {});
  const timer = setInterval(() => {
    try {
      const current = readUpdateJournal(j.stateDir);
      if (!current || current.id !== j.id) { fault = "The update record changed; the owned updater was stopped."; stop(); return; }
      if (Date.now() - Math.max(startedAt, Date.parse(current.updatedAt)) > (hooks.staleMs ?? 180_000)) { fault = "The updater stopped reporting progress. Its owned process was restarted safely."; stop(); }
    } catch { fault = "The update record could not be checked; the owned updater was stopped."; stop(); }
  }, hooks.pollMs ?? 1000);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>(done => child.once("close", (code, signal) => { ended = true; done({ code, signal }); }));
    if (fault) throw Error(fault);
    if (result.code !== 0) throw Error(`Updater exited unexpectedly (${result.signal ?? result.code ?? "spawn failed"}).`);
  } finally { clearInterval(timer); signal.removeEventListener("abort", stop); onPid(null); }
}

/** Remove only the immutable job definition for this completed operation.
 * Receipts/backups remain. A crash during cleanup gets another no-op wake. */
async function cleanup(j: UpdateJournal): Promise<void> {
  // Prevent a new update's registration racing this old job's bootout.
  const lock = installationLock(j); if (!lock) return;
  try {
  const definition = updateRecoveryDefinition(j);
  if (existsSync(definition.unitPath)) {
    if (lstatSync(definition.unitPath).isSymbolicLink() || readFileSync(definition.unitPath, "utf8") !== definition.unitContent) throw Error("The updater service definition changed; it was not removed.");
    unlinkSync(definition.unitPath);
  }
  await run("/bin/launchctl", ["bootout", `gui/${process.getuid?.()}/${definition.label}`], { timeoutMs: 5000 });
  } finally { lock.close(); }
}

export async function superviseDesktopUpdate(stateDir: string, id: string, signal: AbortSignal, hooks: RecoveryHooks = {}): Promise<void> {
  let initial: UpdateJournal | null;
  try { initial = readUpdateJournal(stateDir); }
  catch (error) {
    // The OS job's pinned working directory has an independently validated
    // receipt. Use it only to suspend this exact job, never to overwrite a
    // damaged/newer main record or infer permission to continue the update.
    const retained = readUpdateJournal(stateDir, join(hooks.receiptDir ?? process.cwd(), "receipt.json"));
    if (!retained || retained.id !== id) throw error;
    durableJson(join(retained.workDir, "recovery-failure.json"), { id, detail: "The main update record cannot be read. Automatic recovery is suspended; preserve both receipts and open Update status.", error: error instanceof Error ? error.message : String(error) });
    await (hooks.cleanup ?? cleanup)(retained);
    return;
  }
  // A retained old login job cannot act on a newer update in the same state.
  if (!initial || initial.id !== id) return;
  const lock = sqliteLock(join(initial.workDir, "guardian.sqlite"), 1000); if (!lock) return;
  let record: Recovery | null = null, finished = false;
  const pause = (j: UpdateJournal, detail: string) => {
    pauseUpdateRecovery(stateDir, id, detail);
    writeRecovery(j, record!, "attention", detail);
    finished = true;
  };
  try {
    record = readRecovery(initial);
    if (!record) throw Error("Automatic recovery was not armed for this operation.");
    record.guardianPid = process.pid;
    while (!signal.aborted) {
      const j = readUpdateJournal(stateDir);
      if (!j || j.id !== id) return;
      if (updateTerminal(j.phase)) { writeRecovery(j, record, "done", j.detail); finished = true; return; }
      if (record.state === "attention" || (j.phase === "needs-attention" && !j.retryableRecovery && !record.manualRetry)) { pause(j, j.detail); return; }
      if (bundleHash(app(j)) !== j.next.hash) { pause(j, "The staged updater changed. Automatic recovery stopped; keep the app and backups and open Update status."); return; }
      // launchd may be settling the previous process group. Do not consume a
      // retry or spawn over an updater that still owns the database lock.
      if (desktopUpdateStatus(stateDir).running) { await (hooks.sleep ?? sleep)(500); continue; }
      let restoring = j.intended === "restore";
      if (!restoring && record.attempts >= 3) {
        requestUpdateRestore(stateDir); restoring = true;
        writeRecovery(j, record, "backoff", "The update has been interrupted repeatedly. Returning to the previous app automatically.");
      }
      if (restoring && record.repairs >= 3) { pause(j, "Automatic recovery could not finish after three attempts. Your app and current task data were kept. Open Update status to resolve the reported error, then retry safely."); return; }
      if (restoring) record.repairs++; else record.attempts++;
      record.manualRetry = false;
      writeRecovery(j, record, "running", restoring ? "Restoring the previous app automatically. Your current task data will be kept." : record.attempts > 1 ? "Recovering the interrupted update automatically. No action is needed." : "Updating in the background. You can close the app window.");
      try {
        await (hooks.attempt ?? ((j, signal, onPid) => runUpdateAttempt(j, signal, onPid, hooks)))(j, signal, pid => { record!.workerPid = pid; writeRecovery(j, record!, "running", record!.detail); });
      } catch (error) {
        writeRecovery(j, record, "backoff", `${error instanceof Error ? error.message : String(error)} Automatic recovery will retry from the saved state.`);
      }
      if (!signal.aborted) await (hooks.sleep ?? sleep)(Math.min(10_000, 1000 * 2 ** Math.max(0, record.attempts + record.repairs - 1)));
    }
  } catch (error) {
    // If the receipt itself cannot be trusted, do not invent state or launch
    // anything. Preserve it and suspend this OS job instead of looping.
    if (record) writeRecovery(initial, record, "attention", `Automatic recovery stopped: ${error instanceof Error ? error.message : String(error)}. Open Update status; saved work was kept.`);
    finished = true;
  } finally {
    lock.close();
    if (finished) await (hooks.cleanup ?? cleanup)(initial);
  }
}
