/**
 * When the automatic storage sweep (storage-sweep.ts) starts, and what `toolroll storage` and Settings → Storage say
 * about it. A sweep is due a day after the last one (an hour after one that failed somewhere). Once due, the
 * long-lived Toolroll service looks at most every 15 minutes and starts it only while nothing is running or waiting:
 * no open run, no live claim and no task a worker could claim now. Work held by an approval, a hold or a provider limit
 * is not waiting to start, so it never defers the sweep. 48 hours after the last automatic sweep it runs anyway: its
 * scans run in a low-priority child, and every removal asks again whether live work uses the folder.
 *
 * Only the service claims a sweep (it passes its owner): a one-shot `toolroll reconcile` exits before a child would
 * finish, and a claim it made would be lost until the next day. The idle gates are asked again inside the transaction
 * that claims the sweep, so work that started since the first look still defers it.
 */
import { diagnoseTaskDispatch, diagnosisIsDispatchable } from "./dispatch.js";
import { lastSweep, RETRY_MS, saveSweep, storageSweepOff, sweepFailure, SWEEP_CURSOR, SWEEP_EVERY_MS, type SweepDeps, type SweepRecord } from "./storage-sweep.js";
import { storageSweepSupervisor, SWEEP_KILL_GRACE_MS, SWEEP_TIMEOUT_MS, type SweepSupervisor } from "./storage-sweep-process.js";
import { openStoreNoMigrate, type Store } from "./store.js";

/** How often the service looks again at a due sweep. */
export const SWEEP_CHECK_MS = 15 * 60_000;
/** After this long without an automatic sweep, it runs even while work is running or waiting. */
export const SWEEP_FORCE_MS = 48 * 3_600_000;

export type SweepBusy = "run" | "claim" | "ready";

/** What keeps a due sweep waiting now, or null when nothing is running or waiting. */
export function sweepBusy(store: Store, now: Date): SweepBusy | null {
  const db = store.handle;
  if (db.prepare("SELECT 1 FROM run WHERE finished_at IS NULL LIMIT 1").get() !== undefined) return "run";
  if (db.prepare("SELECT 1 FROM claim WHERE released_at IS NULL AND expires_at > ? LIMIT 1").get(now.toISOString()) !== undefined) return "claim";
  // Ready means a worker could claim it now: the same answer the task page gives, not merely queued.
  if (store.listReady(now).some(ref => diagnosisIsDispatchable(diagnoseTaskDispatch(store, ref.externalId, now)))) return "ready";
  return null;
}

/** Whether a long-lived Toolroll service holds a current lease. Rows from earlier services don't count. */
export function sweepServiceRunning(store: Store, now: Date): boolean {
  return store.handle.prepare("SELECT 1 FROM watch_lease WHERE owner GLOB 'toolroll-service:*' AND expires_at > ? LIMIT 1").get(now.toISOString()) !== undefined;
}

export type SweepState = "off" | "sweeping" | "no-service" | "recent" | "retry" | "busy" | "forced" | "due";
export type SweepSchedule = {
  state: SweepState;
  /** The latest automatic sweep's recorded time, or null when there has been none. */
  lastAt: string | null;
  /** When the next sweep is due, or null when it is off or due now. */
  nextAt: string | null;
  busy: SweepBusy | null;
};

const dueAt = (store: Store): number => store.serviceCursor(SWEEP_CURSOR) + SWEEP_EVERY_MS;

/** Count from the last result, or the durable installation time before the first result. */
function forcedFrom(store: Store, last: SweepRecord | null): number | null {
  if (last !== null) return Date.parse(last.at);
  const installed = store.installationFact("installed-at");
  return installed === null ? null : Date.parse(installed);
}

/** The sweep's schedule from what is recorded now; reads only. */
export function sweepSchedule(store: Store, now: Date, env: NodeJS.ProcessEnv = process.env): SweepSchedule {
  const last = lastSweep(store, "automatic");
  const lastAt = last?.at ?? null;
  if (storageSweepOff(env)) return { state: "off", lastAt, nextAt: null, busy: null };
  const cursor = store.serviceCursor(SWEEP_CURSOR);
  // Results record completion time, which may be later than the claim. An older result cannot finish a new claim.
  if (cursor !== 0 && now.getTime() - cursor < SWEEP_TIMEOUT_MS + SWEEP_KILL_GRACE_MS && now.getTime() >= cursor && (lastAt === null || Date.parse(lastAt) < cursor)) {
    return { state: "sweeping", lastAt, nextAt: null, busy: null };
  }
  const due = dueAt(store);
  const nextAt = cursor === 0 || due <= now.getTime() ? null : new Date(due).toISOString();
  if (!sweepServiceRunning(store, now)) return { state: "no-service", lastAt, nextAt, busy: null };
  if (nextAt !== null) {
    // Completion can follow the claim: elapsed sweep time alone does not mean a retry.
    const retry = last !== null && Date.parse(last.at) >= cursor && last.parts.some(one => one.failed > 0 || one.more === true || one.problem !== undefined);
    return { state: retry ? "retry" : "recent", lastAt, nextAt, busy: null };
  }
  const from = forcedFrom(store, last);
  if (from !== null && now.getTime() - from >= SWEEP_FORCE_MS) return { state: "forced", lastAt, nextAt: null, busy: null };
  const busy = sweepBusy(store, now);
  return { state: busy === null ? "due" : "busy", lastAt, nextAt: null, busy };
}

const BUSY_WORDS: Record<SweepBusy, string> = { run: "work is running", claim: "a worker is starting a task", ready: "a task is ready to start" };

/** Why the sweep is waiting or when it is next due, after "Automatic sweep: ". `when` formats a time for the reader. */
export function sweepScheduleWords(schedule: SweepSchedule, when: (at: string) => string): string {
  switch (schedule.state) {
    case "off": return "off.";
    case "sweeping": return "sweeping now.";
    case "no-service": return "waiting: no Toolroll service running.";
    case "recent": return `swept recently, next due ${when(schedule.nextAt!)}.`;
    case "retry": return `retry due ${when(schedule.nextAt!)}.`;
    case "busy": return `due, waiting: ${BUSY_WORDS[schedule.busy!]}.`;
    case "forced": return "over 48 hours since the last sweep; it runs at the next check even if work is running.";
    case "due": return "due; it starts within 15 minutes while nothing is running.";
  }
}

// The last look per flight, so a due sweep is looked at no more than every 15 minutes.
const looked = new WeakMap<SweepSupervisor, number>();

/**
 * The service's claim and launch. A one-shot caller has no `owner` and never claims. A hung child never holds
 * reconciliation or the caller's store open; the result is saved by the flight's own connection.
 */
export function idleStorageSweep(store: Store, deps: SweepDeps, now: () => Date, supervisor: SweepSupervisor = storageSweepSupervisor(deps.databaseFile)): SweepRecord | null {
  if (deps.owner === undefined || storageSweepOff() || supervisor.running) return null;
  const at = now();
  // Older installations have no creation fact. Anchor once on their first service pass; never backdate a claim.
  if (store.installationFact("installed-at") === null) store.recordInstallationFact("installed-at", at.toISOString(), at);
  if (at.getTime() < dueAt(store)) return null;
  const seen = looked.get(supervisor);
  if (seen !== undefined && at.getTime() - seen < SWEEP_CHECK_MS && at.getTime() >= seen) return null;
  looked.set(supervisor, at.getTime());
  const ready = () => {
    if (at.getTime() < dueAt(store)) return false;
    const from = forcedFrom(store, lastSweep(store, "automatic"));
    return (from !== null && at.getTime() - from >= SWEEP_FORCE_MS) || sweepBusy(store, at) === null;
  };
  if (!ready()) return null;
  // This handle belongs to the flight, not to the pass that has already returned by the time it finishes.
  const connection = openStoreNoMigrate(deps.databaseFile);
  if (!connection.ok) throw new Error("Sweep result store unavailable");
  const results = connection.store;
  let completed: SweepRecord | null = null;
  let owned = false;
  try {
    // Asked again where the cursor moves: work that started since the first look still defers the sweep.
    const mine = store.transact(() => {
      if (!ready()) return false;
      store.setServiceCursor(SWEEP_CURSOR, at.getTime(), at);
      return true;
    });
    if (!mine) return null;
    const request = { version: 1 as const, databaseFile: deps.databaseFile, poolRoot: deps.pool?.root ?? null, tempRoots: [...deps.tempRoots], actor: deps.actor ?? "worker", at: at.toISOString() };
    owned = supervisor.start(request, result => {
      const record = result.ok ? result.record : sweepFailure(request.at, request.actor, deps.pool !== null, result.reason);
      try {
        results.transact(() => {
          if (!results.schemaCurrent()) throw new Error("Sweep result store changed");
          saveSweep(results, record);
          // Only this claim can reschedule itself. A later claim must never be overwritten by a late callback.
          if (record.parts.some(one => one.failed > 0 || one.more === true || one.problem !== undefined) && results.serviceCursor(SWEEP_CURSOR) === at.getTime()) {
            results.setServiceCursor(SWEEP_CURSOR, Math.max(1, now().getTime() - SWEEP_EVERY_MS + RETRY_MS), now());
          }
        });
        completed = record;
      } catch {
        // No exception/path from a process or database is safe to copy into a log.
        console.error("Could not save the storage sweep result.");
      } finally { results.close(); }
    }, deps.owner);
    if (!owned) {
      store.transact(() => {
        if (store.serviceCursor(SWEEP_CURSOR) === at.getTime()) store.setServiceCursor(SWEEP_CURSOR, Math.max(1, at.getTime() - SWEEP_EVERY_MS + RETRY_MS), now());
      });
    }
    return completed;
  } finally { if (!owned) results.close(); }
}
