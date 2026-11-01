/**
 * Webhook floods (docs/plans/webhook-tasks.md §4): how many deliveries a trigger's address may fail in a minute. Held
 * in memory per store (a restart forgets it, which is harmless: it protects the process and the database's write rate,
 * not anything durable). It counts only what doesn't prove itself — a bad, missing or stale signature, an address that
 * isn't set up, an unknown address, and every delivery to an unsigned webhook (nothing proves those) — so a stranger
 * holding a leaked address can't crowd out the deliveries that are signed.
 */
import type { Store } from "./store.js";

/** At most this many unproven deliveries per address a minute; over it, further ones are answered 429 and do nothing. */
export const UNPROVEN_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
/** Addresses that match no trigger share one count. */
export const UNKNOWN_ADDRESS = "unknown";

type Counter = Map<string, number[]>;
const counters = new WeakMap<Store, Counter>();

/** Count one unproven delivery to `address` at `now`. Whether it is over the minute's limit, and when to try again. */
export function countUnproven(store: Store, address: string, now: Date): { over: false } | { over: true; retryAfterSeconds: number } {
  let counter = counters.get(store);
  if (counter === undefined) { counter = new Map(); counters.set(store, counter); }
  const at = now.getTime();
  const recent = (counter.get(address) ?? []).filter(one => one > at - WINDOW_MS);
  recent.push(at);
  // Keep at most one over the limit: the count only needs to know it is over, and memory stays bounded per address.
  counter.set(address, recent.slice(-(UNPROVEN_PER_MINUTE + 1)));
  // Bounded across addresses too: the oldest addresses are forgotten first.
  if (counter.size > 10_000) counter.delete(counter.keys().next().value!);
  if (recent.length <= UNPROVEN_PER_MINUTE) return { over: false };
  const oldest = recent[recent.length - UNPROVEN_PER_MINUTE - 1]!;
  return { over: true, retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - at) / 1000)) };
}

/** At most this many cards a trigger makes in a rolling hour (counted when each card is made). */
export const CARDS_PER_HOUR = 30;
/** At most this many signed deliveries a trigger holds while it waits for room; beyond it, deliveries are turned away. */
export const HELD_AT_MOST = 200;
