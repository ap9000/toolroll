/** Assignment sweeps re-project every owned root on each pass. A pass is
 * skipped when nothing has moved since the last full cycle began: the store's
 * wake sequence is unchanged and that cycle started under a minute ago. The
 * minute covers changes that don't bump wake (time-based lease expiry, some
 * ledger-only writes). A cycle in progress (its cursor past 0) always goes on,
 * and a restarted process sweeps at once. */
import type { Store } from "./store.js";

export const SWEEP_FALLBACK_MS = 60_000;
const cycles = new WeakMap<Store, Map<string, { seq: number; at: number }>>();

/** Runs `sweep` unless the cycle under `cursorKey` would see what its last start saw. Returns whether it ran. */
export function sweepIfMoved(store: Store, cursorKey: string, now: Date, sweep: () => void): boolean {
  const seq = store.wakeSeq();
  const startsCycle = store.serviceCursor(cursorKey) === 0;
  const seen = cycles.get(store) ?? new Map<string, { seq: number; at: number }>();
  cycles.set(store, seen);
  const last = seen.get(cursorKey);
  const elapsed = last === undefined ? Infinity : now.getTime() - last.at;
  if (startsCycle && last?.seq === seq && elapsed >= 0 && elapsed < SWEEP_FALLBACK_MS) return false;
  sweep();
  // Recorded only once the pass returns: a pass that threw is retried next time.
  if (startsCycle) seen.set(cursorKey, { seq, at: now.getTime() });
  return true;
}
