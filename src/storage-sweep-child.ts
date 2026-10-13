/** Launched only by storage-sweep-process. All potentially expensive sweep work stays in this process. */
import { Worker } from "node:worker_threads";
import { openStoreNoMigrate, type Store } from "./store.js";
import { WorktreePool } from "./worktree.js";
import { executeSweep } from "./storage-sweep.js";
import { enterSweepBackground, sweepRequest } from "./storage-sweep-process.js";

const parent = process.ppid;
let store: Store | undefined;
let finished = false;
const closeStore = () => { const opened = store; store = undefined; opened?.close(); };
const abandon = () => {
  if (finished) return;
  finished = true;
  try { closeStore(); } finally {
    // This detached child owns the group, including any blocked rm/du descendants.
    try { if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL"); } catch { /* no group */ }
    process.exit(1);
  }
};
process.once("disconnect", abandon);
process.once("SIGTERM", abandon);
// A separate thread also detects parent loss while synchronous filesystem work blocks the child's event loop.
const watchdog = new Worker(`
  const { workerData } = require('node:worker_threads');
  setInterval(() => {
    let lost = process.ppid !== workerData.parent || workerData.parent <= 1;
    try { process.kill(workerData.parent, 0); } catch (error) { if (error.code === 'ESRCH') lost = true; }
    if (!lost) return;
    try { if (process.platform !== 'win32') process.kill(-process.pid, 'SIGKILL'); } catch {}
    process.kill(process.pid, 'SIGKILL');
  }, 1000);
`, { eval: true, workerData: { parent } });
watchdog.unref();
watchdog.once("error", abandon);
const finish = (code: number) => {
  if (finished) return;
  finished = true;
  closeStore();
  void watchdog.terminate();
  process.exitCode = code;
  if (process.connected) process.disconnect?.();
};
if (parent <= 1 || !process.connected) abandon();

process.once("message", async (request: unknown) => {
  if (!sweepRequest(request)) { finish(1); return; }
  // Node and the sweep's code are loaded: from here on, on macOS, the work and everything it starts runs in the background.
  enterSweepBackground();
  try {
    const opened = openStoreNoMigrate(request.databaseFile);
    if (!opened.ok) throw new Error("Sweep database unavailable");
    store = opened.store;
    const started = Date.now();
    const now = () => new Date(Date.parse(request.at) + Date.now() - started);
    const pool = request.poolRoot === null ? null : new WorktreePool(store, { root: request.poolRoot });
    const record = await executeSweep(store, { databaseFile: request.databaseFile, pool, tempRoots: request.tempRoots, actor: request.actor }, now);
    closeStore();
    if (!finished) process.send?.({ version: 1, record }, error => finish(error === null ? 0 : 1));
  } catch { finish(1); }
});
