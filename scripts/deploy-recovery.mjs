// What a browser deployment that ends in failure puts back. A refusal before
// the swap stopped anything only lifts this deployment's own pause. Once the
// old service is proved stopped, it is started again from its saved definition,
// it must answer /healthz, and only then is the pause lifted, so a failure
// never leaves the plane down (Oct 2: two deploys over 0.9.11 stopped and
// stayed down until restored by hand). Once the candidate's store has opened
// the live database, the previous runtime never starts on it unless the
// rehearsal proved it reads the result: the verified backup goes back first.
// A stop that was not proved (old processes may still run) or a new service
// that may be running is left as it is, for a person to inspect. A deployment
// journals "preparing" before it installs its pause, so a failure between the
// two still knows the pause's owner: one held by this deployment is lifted,
// and without one the journal stays resumable under the same id.
export const PAUSED_BEFORE_SWAP = Object.freeze(["admission-paused", "frozen", "backup-verified", "rehearsed"]);
/** The candidate's store opened the live database, or the new service ran on it. */
export const MIGRATION_STARTED = Object.freeze(["migrating", "migrated", "start-failed"]);
const RESTARTABLE = Object.freeze(["stopped", "backup-restored", ...MIGRATION_STARTED]);

/** effects: stopProved() says whether every old process is gone (asked only at "stopping");
 * restoreBackup() puts the verified backup in place of the live database and returns where the
 * live one was kept, restoreService() starts the previous definition and waits until it answers,
 * removeGate() lifts this deployment's own pause and says whether it held one, mark(phase) journals the outcome.
 * previousRuntimeCompatible: the rehearsal proved the previous runtime reads the migrated database.
 * Returns the words to show, or null when nothing was this function's to undo. */
export function recoverFailedDeployment(phase, effects, { previousRuntimeCompatible = false } = {}) {
  if (phase === "preparing") {
    // Stopped between journaling and the next marker: the pause may or may not be in place.
    if (!effects.removeGate()) return null;
    effects.mark("released");
    return "New work resumed: the deployment stopped while pausing new work, before the swap, and lifted its pause.";
  }
  if (PAUSED_BEFORE_SWAP.includes(phase)) {
    effects.removeGate();
    effects.mark("released");
    return "New work resumed: the deployment stopped before the swap and lifted its pause.";
  }
  // A historical journal cannot authorize stopping a current service, even at the same runtime path.
  if (phase === "stopping" && effects.stopProved()) phase = "stopped";
  let kept = null;
  if (MIGRATION_STARTED.includes(phase) && !previousRuntimeCompatible) {
    kept = effects.restoreBackup();
    effects.mark("backup-restored");
    phase = "backup-restored";
  }
  if (RESTARTABLE.includes(phase)) {
    effects.restoreService();
    effects.mark("restored");
    phase = "restored";
  }
  if (phase !== "restored") return null;
  effects.removeGate();
  effects.mark("released");
  return "The deployment failed after stopping the service: the previous service is running again and new work resumed." +
    (kept ? ` Its database was put back from the backup taken before the update; what the live database held is kept at ${kept}.` : "");
}

/** How long a runner's heartbeat keeps its name held after its process died (src/runner.ts DEFAULT_LIVENESS_MS): a
 * service restarted within this window may refuse to start ("runner-alive") until it lapses. A worker that signed
 * off cleanly, or whose credential holders are proved gone, can be replaced sooner. */
export const RUNNER_LIVENESS_MS = 60_000;
/** How long a deployment waits for a service to answer: past the liveness window with a margin for launchd's restart
 * backoff (controller-service restarts within 30 s), and never under the 90 s it always waited. */
export const HEALTH_WAIT_MS = Math.max(RUNNER_LIVENESS_MS + 60_000, 90_000);

/** Asks probe() until it says yes, pausing a second between tries, for HEALTH_WAIT_MS by default. Synchronous, so a
 * deployment that is exiting can still wait for the service it started. onWait(tries, attempts) is called every 30
 * tries (first after 10) so the deployment says why it is still waiting. */
export function waitUntilHealthy(probe, { attempts = HEALTH_WAIT_MS / 1000, pause = () => sleepSync(1000), onWait = () => {} } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (probe()) return true;
    if (i % 30 === 10) onWait(i, attempts);
    if (i < attempts - 1) pause();
  }
  return false;
}
export function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** A running deployment supplies onSignal to request cancellation and unwind its awaited
 * work before exit. In particular SQLite's backup must settle and close its writer first.
 * Repeated signals cannot force exit through that cleanup. */
export function exitOnSignals(proc = process, onSignal = code => proc.exit(code)) {
  let stopping = false;
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    proc.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.error(`Stopping: ${signal} received.`);
      onSignal(code, signal);
    });
  }
}

/** A deployment that ends in failure, by an error, a refusal or a signal, recovers on its way out. */
export function recoverOnExit(recover, proc = process, { onSignal, release = () => {} } = {}) {
  proc.on("exit", code => { try { if (code !== 0) recover(); } finally { release(); } });
  exitOnSignals(proc, onSignal);
}
