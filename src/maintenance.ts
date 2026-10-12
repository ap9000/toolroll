/** Serialized background maintenance. It schedules no agent work: callers
 * retain dispatch, ownership and recovery policy. Slow passes never overlap. */
export function startMaintenance(args: {
  intervalMs: number;
  run: () => Promise<void>;
  shouldStop: () => boolean;
  onError: (error: unknown) => void;
  /** Synchronously cancel owned background work before waiting for the current pass. */
  onStop?: () => void;
}): { runNow: () => Promise<void>; stop: () => Promise<void> } {
  if (!Number.isSafeInteger(args.intervalMs) || args.intervalMs < 1 || args.intervalMs > 2_147_483_647) {
    throw new Error("maintenance interval must be an integer from 1 to 2147483647 milliseconds");
  }
  let stopped = false;
  let pending: Promise<void> | null = null;
  const runNow = (): Promise<void> => {
    if (stopped || args.shouldStop()) return Promise.resolve();
    if (pending !== null) return pending;
    pending = Promise.resolve().then(async () => {
      if (!stopped && !args.shouldStop()) await args.run();
    }).catch(error => {
      try { args.onError(error); } catch { /* Reporting cannot create an unhandled timer rejection. */ }
    }).finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(() => { void runNow(); }, args.intervalMs);
  timer.unref?.();
  return {
    runNow,
    stop: async () => {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        args.onStop?.();
      }
      await pending;
    },
  };
}
