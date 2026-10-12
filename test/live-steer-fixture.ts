/** A task with one running build that reads its steering folder and, when asked, takes live input (live steering):
 * shared by the store, dispatcher, CLI and server suites. */
import { acquire } from "../src/claim.js";
import { register } from "../src/runner.js";
import { BUILT_IN, type Store } from "../src/store.js";
import { presented } from "./route-fixture.js";

export const LIVE_REPO = "/code/thing";

/** Leases t-1 (created if missing) to builder-1 and opens one agent-running builder run for it. */
export function liveBuild(store: Store, now: Date, options: { taskId?: string; liveInput?: boolean; worktree?: string } = {}): { taskRef: number; runId: number; leaseId: string } {
  const taskId = options.taskId ?? "t-1";
  if (store.getTask(taskId) === null) store.createTask({ id: taskId, title: "Add a guard on the payout path" }, now);
  const taskRef = store.refFor(BUILT_IN, taskId).id;
  // The runner's token is assembled at run time, never a key-shaped literal.
  const token = ["live", "runner", taskId].join("-");
  if (store.handle.prepare("SELECT 1 FROM runner WHERE name = 'builder-1'").get() === undefined) {
    register(store, { name: "builder-1", host: "h", capacity: 9, repos: [LIVE_REPO], now, newToken: () => token });
  }
  store.placeTask(taskRef, LIVE_REPO);
  const leaseId = `lease-${taskId}`;
  const leased = acquire(store, taskRef, "builder-1", { token, now, ttlMs: 24 * 60 * 60_000, newLeaseId: () => leaseId });
  if (!leased.ok) throw new Error(`the fixture could not lease ${taskId}`);
  const runId = store.startRun({ taskRef, leaseId, runner: "builder-1", branch: "feat/a", worktree: options.worktree ?? "/tmp/wt", now, ...presented(store, taskRef, "builder") });
  store.setRunPhase(runId, "agent-running");
  store.markSteerFolderOpened(runId, now);
  if (options.liveInput !== false) store.markLiveInputOpened(runId, now);
  return { taskRef, runId, leaseId };
}
